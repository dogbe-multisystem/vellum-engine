// Scénarios de vérification de signature, construits à la volée : un faux PDF
// « signé » de bout en bout (CMS détaché fabriqué avec pkijs), passé au CLI
// comme le ferait un utilisateur. Chaque cas correspond à une fausse preuve
// ou à un faux verdict relevé lors de l'audit du 29.10.2026 :
//   S1 référence valide            S2 signature corrompue
//   S3 empreinte SHA-1             S4 certificat expiré à la date de signature
//   S5 identifiant de clé + sac de certificats d'un tiers
//   S6 jeton d'horodatage fabriqué (S7 : jetons authentiques, S8 : absent)
//   S9 algorithme non pris en charge, S10 CMS sans attributs signés,
//   S11 /ByteRange atypique
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as pkijs from 'pkijs'
import * as asn1js from 'asn1js'
import { dossierTemp, vellumPdf } from './helpers.mjs'

pkijs.setEngine('test', new pkijs.CryptoEngine({ name: 'test', crypto: webcrypto, subtle: webcrypto.subtle }))
const subtle = webcrypto.subtle

const OID_DATA = '1.2.840.113549.1.7.1'
const OID_TSTINFO = '1.2.840.113549.1.9.16.1.4'
const OID_SHA256 = '2.16.840.1.101.3.4.2.1'
const OID_SHA224 = '2.16.840.1.101.3.4.2.4'
const OID_SHA3_256 = '2.16.840.1.101.3.4.2.8'
const JOUR = 86400e3

/** Certificat auto-signé RSA-2048 avec sa paire de clés. */
async function fabriquerCertificat(cn, { debut = new Date(Date.now() - JOUR), fin = new Date(Date.now() + 365 * JOUR), serie = 1 } = {}) {
  const cles = await subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )
  const cert = new pkijs.Certificate()
  cert.version = 2
  cert.serialNumber = new asn1js.Integer({ value: serie })
  for (const nom of [cert.issuer, cert.subject]) {
    nom.typesAndValues.push(new pkijs.AttributeTypeAndValue({ type: '2.5.4.3', value: new asn1js.Utf8String({ value: cn }) }))
  }
  cert.notBefore.value = debut
  cert.notAfter.value = fin
  await cert.subjectPublicKeyInfo.importKey(cles.publicKey)
  await cert.sign(cles.privateKey, 'SHA-256')
  return { cert, cles }
}

const sha = async (algo, octets) => new Uint8Array(await subtle.digest(algo, octets))
const hex = (u8) => Buffer.from(u8).toString('hex')
const zeros = (n, largeur) => String(n).padStart(largeur, '0')
const enBuffer = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength)

/**
 * Jeton d'horodatage (RFC 3161) pour la valeur de signature donnée.
 * `signe: false` : aucun signataire, jeton posé à la main.
 * `imprintDe` : octets dont l'empreinte est scellée (par défaut, la signature).
 * `altererApresSignature` : le TSTInfo est remplacé après coup par une autre date.
 * `construit` : eContent redécoupé en deux sous-chaînes BER (par défaut pkijs n'en écrit qu'une).
 */
async function fabriquerJeton({ signature, tsa, date, signe = true, imprintDe = signature, altererApresSignature = false, construit = false }) {
  const imprint = await sha('SHA-256', imprintDe)
  const tstInfo = (genTime) =>
    new pkijs.TSTInfo({
      version: 1,
      policy: '1.2.3.4',
      messageImprint: new pkijs.MessageImprint({
        hashAlgorithm: new pkijs.AlgorithmIdentifier({ algorithmId: OID_SHA256 }),
        hashedMessage: new asn1js.OctetString({ valueHex: enBuffer(imprint) }),
      }),
      serialNumber: new asn1js.Integer({ value: 42 }),
      genTime,
    })
  const tstBER = tstInfo(date).toSchema().toBER(false)
  const signerInfos = []
  if (signe) {
    const empreinteTst = await sha('SHA-256', new Uint8Array(tstBER))
    signerInfos.push(
      new pkijs.SignerInfo({
        version: 1,
        sid: new pkijs.IssuerAndSerialNumber({ issuer: tsa.cert.issuer, serialNumber: tsa.cert.serialNumber }),
        signedAttrs: new pkijs.SignedAndUnsignedAttributes({
          type: 0,
          attributes: [
            new pkijs.Attribute({ type: '1.2.840.113549.1.9.3', values: [new asn1js.ObjectIdentifier({ value: OID_TSTINFO })] }),
            new pkijs.Attribute({ type: '1.2.840.113549.1.9.4', values: [new asn1js.OctetString({ valueHex: enBuffer(empreinteTst) })] }),
          ],
        }),
      }),
    )
  }
  const donnees = new pkijs.SignedData({
    version: 3,
    encapContentInfo: new pkijs.EncapsulatedContentInfo({
      eContentType: OID_TSTINFO,
      eContent: new asn1js.OctetString({ valueHex: tstBER }),
    }),
    signerInfos,
    certificates: [tsa.cert],
  })
  if (signe) await donnees.sign(tsa.cles.privateKey, 0, 'SHA-256')
  // pkijs range toujours l'eContent en BER construit (une seule sous-chaîne) ;
  // les octets du TSTInfo sont donc gardés à part pour le redécouper à la main.
  let octets = new Uint8Array(tstBER)
  if (altererApresSignature) {
    octets = new Uint8Array(tstInfo(new Date('2001-01-01T00:00:00Z')).toSchema().toBER(false))
    donnees.encapContentInfo.eContent = new asn1js.OctetString({ valueHex: enBuffer(octets) })
  }
  if (construit) {
    const coupe = Math.floor(octets.length / 2)
    donnees.encapContentInfo.eContent = new asn1js.OctetString({
      value: [
        new asn1js.OctetString({ valueHex: enBuffer(octets.subarray(0, coupe)) }),
        new asn1js.OctetString({ valueHex: enBuffer(octets.subarray(coupe)) }),
      ],
    })
  }
  const enveloppe = new pkijs.ContentInfo({ contentType: '1.2.840.113549.1.7.2', content: donnees.toSchema(true) })
  return enveloppe.toSchema()
}

/** Faux PDF signé : un seul dictionnaire /Sig, /ByteRange exact, CMS détaché. */
async function fabriquerPdfSigne({
  signataire,
  sac = [signataire],
  hash = 'SHA-256',
  sid = 'emetteur',
  corrompre = false,
  dateSignature = new Date(),
  attributsSignes = true,
  oidEmpreinteAffiche = null,
  jeton = null,
  debutPlage = 0,
}) {
  const LONGUEUR_HEX = 30000
  const avant = `%PDF-1.7\n1 0 obj\n<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /adbe.pkcs7.detached /Name (Signataire) /ByteRange [0 ${zeros(0, 8)} ${zeros(0, 8)} ${zeros(0, 8)}] /Contents `
  const apres = '>>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n'
  const b = avant.length
  const c = b + LONGUEUR_HEX + 2
  const total = c + apres.length
  const avantOk = avant.replace(/\[0 0{8} 0{8} 0{8}\]/, `[${debutPlage} ${zeros(b, 8)} ${zeros(c, 8)} ${zeros(total - c, 8)}]`)
  const signe = Buffer.concat([Buffer.from(avantOk, 'latin1'), Buffer.from(apres, 'latin1')])
  const empreinte = await sha(hash, signe)

  let signerInfo
  const identifiant =
    sid === 'emetteur'
      ? new pkijs.IssuerAndSerialNumber({ issuer: signataire.cert.issuer, serialNumber: signataire.cert.serialNumber })
      : new asn1js.Primitive({
          idBlock: { tagClass: 3, tagNumber: 0 },
          valueHex: enBuffer(await sha('SHA-1', signataire.cert.subjectPublicKeyInfo.subjectPublicKey.valueBlock.valueHexView)),
        })
  if (attributsSignes) {
    signerInfo = new pkijs.SignerInfo({
      version: sid === 'emetteur' ? 1 : 3,
      sid: identifiant,
      signedAttrs: new pkijs.SignedAndUnsignedAttributes({
        type: 0,
        attributes: [
          new pkijs.Attribute({ type: '1.2.840.113549.1.9.3', values: [new asn1js.ObjectIdentifier({ value: OID_DATA })] }),
          new pkijs.Attribute({ type: '1.2.840.113549.1.9.5', values: [new asn1js.UTCTime({ valueDate: dateSignature })] }),
          new pkijs.Attribute({ type: '1.2.840.113549.1.9.4', values: [new asn1js.OctetString({ valueHex: enBuffer(empreinte) })] }),
        ],
      }),
    })
  } else {
    signerInfo = new pkijs.SignerInfo({ version: sid === 'emetteur' ? 1 : 3, sid: identifiant })
  }
  const donnees = new pkijs.SignedData({
    version: sid === 'emetteur' ? 1 : 3,
    encapContentInfo: new pkijs.EncapsulatedContentInfo({ eContentType: OID_DATA }),
    signerInfos: [signerInfo],
    certificates: sac.map((x) => x.cert),
  })
  await donnees.sign(signataire.cles.privateKey, 0, hash, enBuffer(new Uint8Array(signe)))
  const valeur = donnees.signerInfos[0].signature.valueBlock.valueHexView
  if (corrompre) valeur[valeur.length - 1] ^= 0xff
  if (oidEmpreinteAffiche) {
    donnees.signerInfos[0].digestAlgorithm = new pkijs.AlgorithmIdentifier({ algorithmId: oidEmpreinteAffiche })
  }
  if (jeton) {
    donnees.signerInfos[0].unsignedAttrs = new pkijs.SignedAndUnsignedAttributes({
      type: 1,
      attributes: [
        new pkijs.Attribute({
          type: '1.2.840.113549.1.9.16.2.14',
          values: [await jeton(new Uint8Array(donnees.signerInfos[0].signature.valueBlock.valueHexView))],
        }),
      ],
    })
  }
  const cms = new pkijs.ContentInfo({ contentType: '1.2.840.113549.1.7.2', content: donnees.toSchema(true) })
  const der = Buffer.from(cms.toSchema().toBER(false))
  assert.ok(der.length * 2 <= LONGUEUR_HEX, 'CMS trop gros pour la réserve de signature')
  const contenu = (hex(der) + '0'.repeat(LONGUEUR_HEX)).slice(0, LONGUEUR_HEX)
  return Buffer.concat([Buffer.from(avantOk, 'latin1'), Buffer.from(`<${contenu}>`, 'latin1'), Buffer.from(apres, 'latin1')])
}

const dossier = dossierTemp()
let numero = 0

/** Passe le PDF au CLI et renvoie la première signature du rapport. */
function verifier(pdf) {
  const chemin = join(dossier, `signe-${++numero}.pdf`)
  writeFileSync(chemin, pdf)
  const res = vellumPdf(['verify-signature', chemin, '--json'])
  assert.equal(res.code, 0, res.stderr)
  const rapport = JSON.parse(res.stdout)
  assert.equal(rapport.signatures.length, 1, 'une seule signature attendue')
  return rapport.signatures[0]
}

let alice, expire, victime, attaquant, tsa

before(async () => {
  ;[alice, expire, victime, attaquant, tsa] = await Promise.all([
    fabriquerCertificat('Alice Vendeur SA'),
    fabriquerCertificat('Bob Expiré SA', { debut: new Date('2015-01-01'), fin: new Date('2016-01-01') }),
    fabriquerCertificat('Banque Légitime SA', { serie: 7 }),
    fabriquerCertificat('Attaquant', { serie: 8 }),
    fabriquerCertificat('Autorité Horodatage Test', { serie: 9 }),
  ])
})

test('S1 : signature valide → intacte, sans avertissement ni horodatage', async () => {
  const s = verifier(await fabriquerPdfSigne({ signataire: alice }))
  assert.equal(s.verdict, 'intacte')
  assert.equal(s.documentIntact, true)
  assert.equal(s.signatureValide, true)
  assert.equal(s.certificat.nomCommun, 'Alice Vendeur SA')
  assert.deepEqual(s.avertissements, [])
  assert.equal(s.horodatage, null)
  assert.equal(s.erreur, '')
})

test('S2 : valeur de signature corrompue → echec', async () => {
  const s = verifier(await fabriquerPdfSigne({ signataire: alice, corrompre: true }))
  assert.equal(s.verdict, 'echec')
  assert.equal(s.documentIntact, true)
  assert.equal(s.signatureValide, false)
})

test('S3 : empreinte SHA-1 → intacte, avec l’avertissement sha1', async () => {
  const s = verifier(await fabriquerPdfSigne({ signataire: alice, hash: 'SHA-1' }))
  assert.equal(s.verdict, 'intacte')
  assert.equal(s.algorithmeEmpreinte, 'SHA-1')
  assert.deepEqual(s.avertissements, ['sha1'])
})

test('S4 : certificat expiré à la date de signature → intacte, avec l’avertissement certificat_expire', async () => {
  const s = verifier(await fabriquerPdfSigne({ signataire: expire }))
  assert.equal(s.verdict, 'intacte')
  assert.deepEqual(s.avertissements, ['certificat_expire'])
})

test('S4 bis : certificat expiré aujourd’hui mais valable à la date de signature → aucun avertissement', async () => {
  const s = verifier(await fabriquerPdfSigne({ signataire: expire, dateSignature: new Date('2015-06-01T12:00:00Z') }))
  assert.equal(s.verdict, 'intacte')
  assert.deepEqual(s.avertissements, [])
})

test('S5 : identifiant de clé, sac [victime, attaquant] → le signataire affiché est « Attaquant »', async () => {
  const s = verifier(await fabriquerPdfSigne({ signataire: attaquant, sac: [victime, attaquant], sid: 'cle' }))
  assert.equal(s.verdict, 'intacte')
  assert.equal(s.certificat.nomCommun, 'Attaquant')
  assert.notEqual(s.certificat.nomCommun, 'Banque Légitime SA')
})

test('S5 bis : certificat du signataire absent du sac → pas de repli sur un tiers, verdict inconnu', async () => {
  for (const sid of ['emetteur', 'cle']) {
    const s = verifier(await fabriquerPdfSigne({ signataire: attaquant, sac: [victime], sid }))
    assert.equal(s.certificat, null, `sid ${sid} : aucun certificat affiché`)
    assert.ok(s.avertissements.includes('signataire_absent'), `sid ${sid}`)
    assert.equal(s.verdict, 'inconnu', `sid ${sid}`)
    assert.match(s.erreur, /absent/i)
  }
})

test('S6 : jeton d’horodatage fabriqué (aucune signature de TSA) → non authentifié, ni date ni autorité', async () => {
  const jeton = (signature) => fabriquerJeton({ signature, tsa, date: new Date('2020-01-01T00:00:00Z'), signe: false })
  const s = verifier(await fabriquerPdfSigne({ signataire: alice, jeton }))
  assert.equal(s.verdict, 'intacte')
  assert.equal(s.horodatage.verifie, false)
  assert.ok(s.horodatage.raison.length > 0)
  assert.equal(s.horodatage.date, null)
  assert.equal(s.horodatage.autorite, '')
})

test('S6 bis : jeton signé par une TSA mais TSTInfo remplacé après coup → non authentifié', async () => {
  const jeton = (signature) =>
    fabriquerJeton({ signature, tsa, date: new Date('2024-05-06T07:08:09Z'), altererApresSignature: true })
  const s = verifier(await fabriquerPdfSigne({ signataire: alice, jeton }))
  assert.equal(s.horodatage.verifie, false)
  assert.equal(s.horodatage.date, null)
})

test('S6 ter : jeton authentique mais scellant une autre signature → non authentifié', async () => {
  const jeton = (signature) =>
    fabriquerJeton({ signature, tsa, date: new Date('2024-05-06T07:08:09Z'), imprintDe: new Uint8Array([1, 2, 3]) })
  const s = verifier(await fabriquerPdfSigne({ signataire: alice, jeton }))
  assert.equal(s.horodatage.verifie, false)
  assert.match(s.horodatage.raison, /pas sur cette signature/)
})

test('S7 : jeton d’horodatage authentique → date et autorité affichées', async () => {
  const jeton = (signature) => fabriquerJeton({ signature, tsa, date: new Date('2024-05-06T07:08:09Z') })
  const s = verifier(await fabriquerPdfSigne({ signataire: alice, jeton }))
  assert.equal(s.verdict, 'intacte')
  assert.equal(s.horodatage.verifie, true, s.horodatage.raison)
  assert.equal(s.horodatage.autorite, 'Autorité Horodatage Test')
  assert.equal(new Date(s.horodatage.date).toISOString(), '2024-05-06T07:08:09.000Z')
  assert.equal(s.horodatage.lieALaSignature, true)
})

test('S7 bis : jeton authentique dont l’eContent est en BER construit → toujours authentifié', async () => {
  const jeton = (signature) => fabriquerJeton({ signature, tsa, date: new Date('2024-05-06T07:08:09Z'), construit: true })
  const s = verifier(await fabriquerPdfSigne({ signataire: alice, jeton }))
  assert.equal(s.horodatage.verifie, true, s.horodatage.raison)
  assert.equal(new Date(s.horodatage.date).toISOString(), '2024-05-06T07:08:09.000Z')
})

test('S7 ter : l’horodatage authentique date la signature (certificat expiré à l’époque du jeton → avertissement)', async () => {
  // Signature « aujourd’hui » avec un certificat expiré en 2016, jeton daté de 2025 : expiré à la date du jeton.
  const jeton = (signature) => fabriquerJeton({ signature, tsa, date: new Date('2025-01-01T00:00:00Z') })
  const s = verifier(await fabriquerPdfSigne({ signataire: expire, jeton }))
  assert.equal(s.horodatage.verifie, true, s.horodatage.raison)
  assert.deepEqual(s.avertissements, ['certificat_expire'])
})

test('S9 : SHA-224 ou SHA-3 → inconnu avec une erreur explicite, jamais echec', async () => {
  for (const oid of [OID_SHA224, OID_SHA3_256]) {
    const s = verifier(await fabriquerPdfSigne({ signataire: alice, oidEmpreinteAffiche: oid }))
    assert.equal(s.verdict, 'inconnu', oid)
    assert.match(s.erreur, /non pris en charge/, oid)
  }
})

test('S10 : CMS sans attributs signés → inconnu avec une erreur explicite, jamais echec', async () => {
  const s = verifier(await fabriquerPdfSigne({ signataire: alice, attributsSignes: false }))
  assert.equal(s.verdict, 'inconnu')
  assert.match(s.erreur, /attributs signés/)
})

test('S11 : /ByteRange qui ne commence pas à 0 → inconnu avec une erreur explicite', async () => {
  const s = verifier(await fabriquerPdfSigne({ signataire: alice, debutPlage: 1 }))
  assert.equal(s.verdict, 'inconnu')
  assert.match(s.erreur, /ByteRange/)
})
