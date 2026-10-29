/**
 * Généré depuis vellum-pdf/src/lib/verifsig.ts — ne pas éditer ici.
 * Source de vérité : le dépôt privé vellum-pdf, via scripts/sync-engine.mjs.
 */

/**
 * Vérification des signatures cryptographiques d'un PDF — en lecture seule.
 *
 * Rien n'est modifié ni réenregistré : le document est lu tel quel, et chaque
 * signature est recalculée à partir des octets réellement scellés (son
 * /ByteRange), exactement comme le signataire les a calculés.
 *
 * Trois limites sont assumées, et dites telles quelles dans l'interface :
 *
 *  1. Un navigateur n'a pas de magasin d'autorités de confiance. On peut donc
 *     établir que la signature est mathématiquement correcte et que le
 *     document n'a pas bougé, jamais que l'autorité émettrice est reconnue.
 *     Le rapport dit « chaîne non vérifiable », jamais « certificat invalide ».
 *  2. Des octets après la dernière plage signée signifient une mise à jour
 *     incrémentale (deuxième signature, champ rempli, annotation ajoutée) —
 *     pas une falsification.
 *  3. La révocation (CRL, OCSP) n'est pas interrogée : cela supposerait
 *     d'appeler des serveurs tiers depuis la page.
 *
 * Deux règles de prudence s'y ajoutent. Le certificat du signataire est
 * retrouvé par l'identifiant que la signature désigne (émetteur + numéro de
 * série, ou identifiant de clé) : s'il n'est pas dans le fichier, on le dit,
 * on ne le remplace jamais par un autre. Et un jeton d'horodatage n'est
 * présenté (date, autorité) que si sa propre signature se vérifie : un jeton
 * fabriqué à la main porterait n'importe quel nom et n'importe quelle date.
 *
 * Module lourd (pkijs, asn1js) : chargé à la demande par la page de l'outil.
 */
import * as asn1js from 'asn1js'
import * as pkijs from 'pkijs'
import type { PDFRef } from 'pdf-lib'
import { chargerPdfLib } from './bibliotheques.ts'
import { looksEncrypted } from './qpdf.ts'
import {
  lireChaine,
  lireNom,
  octetsApres,
  octetsSignes,
  parserDatePdf,
  trouverSignatures,
} from './pdfsig.ts'

const OID_ATTR_MESSAGE_DIGEST = '1.2.840.113549.1.9.4'
const OID_ATTR_SIGNING_TIME = '1.2.840.113549.1.9.5'
const OID_ATTR_SIGNATURE_TIMESTAMP = '1.2.840.113549.1.9.16.2.14'
const OID_ATTR_SIGNING_CERTIFICATE_V2 = '1.2.840.113549.1.9.16.2.47'
const OID_ATTR_SIGNING_CERTIFICATE = '1.2.840.113549.1.9.16.2.12'

const OID_EXT_SUBJECT_KEY_IDENTIFIER = '2.5.29.14'
/** Algorithmes de signature fondés sur SHA-1 (RSA et ECDSA). */
const OID_SIGNATURE_SHA1 = new Set(['1.2.840.113549.1.1.5', '1.2.840.10045.4.1'])

const NOMS_EMPREINTE: Record<string, string> = {
  '1.3.14.3.2.26': 'SHA-1',
  '2.16.840.1.101.3.4.2.1': 'SHA-256',
  '2.16.840.1.101.3.4.2.2': 'SHA-384',
  '2.16.840.1.101.3.4.2.3': 'SHA-512',
  '2.16.840.1.101.3.4.2.4': 'SHA-224',
}

/** Ce que WebCrypto sait calculer : SHA-224 et SHA-3 n'en font pas partie. */
const EMPREINTES_PRISES_EN_CHARGE = new Set(['SHA-1', 'SHA-256', 'SHA-384', 'SHA-512'])

const NOMS_SIGNATURE: Record<string, string> = {
  '1.2.840.113549.1.1.1': 'RSA',
  '1.2.840.113549.1.1.5': 'RSA SHA-1',
  '1.2.840.113549.1.1.10': 'RSASSA-PSS',
  '1.2.840.113549.1.1.11': 'RSA SHA-256',
  '1.2.840.113549.1.1.12': 'RSA SHA-384',
  '1.2.840.113549.1.1.13': 'RSA SHA-512',
  '1.2.840.10045.4.3.2': 'ECDSA SHA-256',
  '1.2.840.10045.4.3.3': 'ECDSA SHA-384',
  '1.2.840.10045.4.3.4': 'ECDSA SHA-512',
}

const ATTRIBUTS_NOM: Record<string, string> = {
  '2.5.4.3': 'CN',
  '2.5.4.6': 'C',
  '2.5.4.7': 'L',
  '2.5.4.8': 'ST',
  '2.5.4.10': 'O',
  '2.5.4.11': 'OU',
  '1.2.840.113549.1.9.1': 'E',
}

export interface InfoCertificat {
  nomCommun: string
  organisation: string
  unite: string
  pays: string
  courriel: string
  emetteur: string
  emetteurOrganisation: string
  valideDu: Date | null
  valideAu: Date | null
  numeroSerie: string
  autoSigne: boolean
}

export interface InfoHorodatage {
  /**
   * La signature du jeton par son autorité d'horodatage se vérifie-t-elle, et
   * le jeton porte-t-il bien sur CETTE signature ? Tant que ce n'est pas
   * établi, ni la date ni l'autorité ne sont renseignées : un jeton fabriqué
   * à la main peut porter n'importe quel nom et n'importe quelle date.
   */
  verifie: boolean
  /** Pourquoi le jeton n'a pas pu être authentifié ; vide quand `verifie`. */
  raison: string
  /** Date du jeton — renseignée seulement quand il est authentifié. */
  date: Date | null
  /** Nom de l'autorité d'horodatage, tel que porté par son certificat — idem. */
  autorite: string
  algorithme: string
  /** Le jeton scelle-t-il bien CETTE signature ? null si indéterminable. */
  lieALaSignature: boolean | null
}

/**
 * Points d'attention qui n'invalident pas la signature : le verdict reste
 * « intacte », l'interface les affiche à part.
 *  - `sha1` : empreinte ou signature SHA-1, algorithme dépassé ;
 *  - `certificat_expire` : le certificat du signataire n'était pas valable à
 *    la date de signature (expiré, ou pas encore actif) ;
 *  - `signataire_absent` : aucun certificat du fichier ne correspond à celui
 *    que la signature désigne.
 */
export type Avertissement = 'sha1' | 'certificat_expire' | 'signataire_absent'

/** Verdict d'ensemble d'une signature, sans jamais crier au faux sans preuve. */
export type Verdict = 'intacte' | 'modifie-apres' | 'inconnu' | 'echec'

export interface SignatureVerifiee {
  /** Numéro d'affichage, dans l'ordre du fichier. */
  numero: number
  /** Nom du champ de formulaire, quand il a pu être relu. */
  nomChamp: string
  /** Nom déclaré dans le dictionnaire de signature (/Name). */
  nomDeclare: string
  motif: string
  lieu: string
  contact: string
  dateDeclaree: Date | null
  /** Heure de signature scellée dans les attributs signés (signing-time). */
  dateAttribut: Date | null
  subFilter: string
  profil: 'pades' | 'pkcs7' | 'inconnu'
  algorithmeEmpreinte: string
  algorithmeSignature: string
  certificat: InfoCertificat | null
  chaine: InfoCertificat[]
  /** Le certificat du signataire est-il scellé dans les attributs signés (ESS) ? */
  certificatScelle: boolean
  /** L'empreinte scellée correspond-elle au contenu signé ? */
  documentIntact: boolean
  /** La signature se vérifie-t-elle avec la clé publique du certificat ? */
  signatureValide: boolean
  /** Octets ajoutés après la dernière plage signée : mise à jour incrémentale. */
  octetsApres: number
  /** L'émetteur du certificat figure-t-il dans le fichier ? (jamais une preuve de confiance) */
  emetteurPresent: boolean
  horodatage: InfoHorodatage | null
  avertissements: Avertissement[]
  erreur: string
  verdict: Verdict
}

export interface RapportSignatures {
  signatures: SignatureVerifiee[]
  /** Champs de signature présents dans le formulaire mais jamais remplis. */
  champsVides: number
  chiffre: boolean
  tailleFichier: number
}

/* ------------------------------------------------------------------ */
/* Lecture des noms X.501                                               */
/* ------------------------------------------------------------------ */

function valeursDuNom(nom: pkijs.RelativeDistinguishedNames): Record<string, string> {
  const out: Record<string, string> = {}
  for (const paire of nom.typesAndValues) {
    const cle = ATTRIBUTS_NOM[paire.type]
    if (!cle) continue
    const valeur = paire.value.valueBlock.value
    if (typeof valeur === 'string' && !out[cle]) out[cle] = valeur
  }
  return out
}

function hexadecimal(vue: Uint8Array): string {
  let out = ''
  for (const octet of vue) out += octet.toString(16).padStart(2, '0')
  return out.replace(/^0+(?=..)/, '').toUpperCase()
}

function decrireCertificat(cert: pkijs.Certificate): InfoCertificat {
  const sujet = valeursDuNom(cert.subject)
  const emetteur = valeursDuNom(cert.issuer)
  return {
    nomCommun: sujet.CN ?? '',
    organisation: sujet.O ?? '',
    unite: sujet.OU ?? '',
    pays: sujet.C ?? '',
    courriel: sujet.E ?? '',
    emetteur: emetteur.CN ?? emetteur.O ?? '',
    emetteurOrganisation: emetteur.O ?? '',
    valideDu: cert.notBefore.value ?? null,
    valideAu: cert.notAfter.value ?? null,
    numeroSerie: hexadecimal(cert.serialNumber.valueBlock.valueHexView),
    autoSigne: cert.issuer.isEqual(cert.subject),
  }
}

/* ------------------------------------------------------------------ */
/* Utilitaires                                                          */
/* ------------------------------------------------------------------ */

/** Copie exacte en ArrayBuffer : asn1js et WebCrypto veulent un tampon dédié. */
function enArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copie = new ArrayBuffer(bytes.length)
  new Uint8Array(copie).set(bytes)
  return copie
}

function memesOctets(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let difference = 0
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i]
  return difference === 0
}

/**
 * Octets d'une OCTET STRING, qu'elle soit primitive ou construite en BER
 * (suite de sous-chaînes, éventuellement imbriquées) : certains producteurs
 * d'horodatages découpent ainsi le TSTInfo.
 */
function octetsDe(bloc: asn1js.BaseBlock): Uint8Array {
  const contenu = bloc.valueBlock as { valueHexView?: Uint8Array; value?: asn1js.BaseBlock[] }
  if (!bloc.idBlock.isConstructed) return new Uint8Array(contenu.valueHexView ?? [])
  const enfants = (contenu.value ?? []).map(octetsDe)
  const out = new Uint8Array(enfants.reduce((total, e) => total + e.length, 0))
  let decalage = 0
  for (const e of enfants) {
    out.set(e, decalage)
    decalage += e.length
  }
  return out
}

/** Empreinte SHA-1 de la clé publique d'un certificat (identifiant de clé par défaut). */
async function empreinteCle(cert: pkijs.Certificate): Promise<Uint8Array> {
  const cle = cert.subjectPublicKeyInfo.subjectPublicKey.valueBlock.valueHexView
  return new Uint8Array(await globalThis.crypto.subtle.digest('SHA-1', enArrayBuffer(new Uint8Array(cle))))
}

/** Identifiant de clé porté par l'extension SubjectKeyIdentifier, quand elle existe. */
function identifiantCleExtension(cert: pkijs.Certificate): Uint8Array | null {
  const extension = cert.extensions?.find((e) => e.extnID === OID_EXT_SUBJECT_KEY_IDENTIFIER)
  const valeur = extension?.parsedValue as asn1js.OctetString | undefined
  const octets = valeur?.valueBlock?.valueHexView
  return octets?.length ? new Uint8Array(octets) : null
}

/**
 * Le certificat que la signature désigne, retrouvé comme le fait pkijs :
 * par émetteur + numéro de série, ou par identifiant de clé (SHA-1 de la clé
 * publique, ou extension SubjectKeyIdentifier). Aucun repli sur « le premier
 * certificat du sac » : il peut appartenir à un tiers, et le nom affiché
 * deviendrait celui d'un autre que le signataire.
 */
async function trouverSignataire(
  signerInfo: pkijs.SignerInfo,
  certificats: pkijs.Certificate[],
): Promise<pkijs.Certificate | undefined> {
  const sid = signerInfo.sid
  if (sid instanceof pkijs.IssuerAndSerialNumber) {
    return certificats.find(
      (c) => c.issuer.isEqual(sid.issuer) && c.serialNumber.isEqual(sid.serialNumber),
    )
  }
  const identifiant = octetsDe(sid as asn1js.BaseBlock)
  if (!identifiant.length) return undefined
  for (const cert of certificats) {
    if (memesOctets(await empreinteCle(cert), identifiant)) return cert
  }
  return certificats.find((c) => {
    const ext = identifiantCleExtension(c)
    return ext !== null && memesOctets(ext, identifiant)
  })
}

/** Le certificat était-il hors de sa période de validité à cette date ? */
function horsValidite(cert: pkijs.Certificate, date: Date): boolean {
  const du = cert.notBefore.value
  const au = cert.notAfter.value
  return (!!du && date < du) || (!!au && date > au)
}

function preparerMoteur(): void {
  const sousJacent = globalThis.crypto
  if (!sousJacent?.subtle) throw new Error('WebCrypto indisponible dans cet environnement.')
  // Même cast que dans pades.ts : divergence de typage lib.dom / ICryptoEngine.
  const moteur = new pkijs.CryptoEngine({
    name: 'vellum',
    crypto: sousJacent,
    subtle: sousJacent.subtle,
  }) as unknown as pkijs.ICryptoEngine
  pkijs.setEngine('vellum', moteur)
}

function attribut(
  attributs: pkijs.SignedAndUnsignedAttributes | undefined,
  type: string,
): pkijs.Attribute | undefined {
  return attributs?.attributes.find((a) => a.type === type)
}

/**
 * Noms des champs de signature, indexés par le numéro d'objet du
 * dictionnaire /V qu'ils désignent. Le rapprochement se fait par référence,
 * jamais par ordre d'apparition, qui n'est pas garanti. Compte au passage
 * les champs de signature restés vides.
 */
async function lireChampsFormulaire(
  bytes: Uint8Array,
): Promise<{ noms: Map<number, string>; vides: number }> {
  const noms = new Map<number, string>()
  let vides = 0
  try {
    const { PDFDocument, PDFName, PDFSignature } = await chargerPdfLib()
    const doc = await PDFDocument.load(bytes.slice(), {
      ignoreEncryption: true,
      throwOnInvalidObject: false,
      updateMetadata: false,
    })
    for (const champ of doc.getForm().getFields()) {
      if (!(champ instanceof PDFSignature)) continue
      const valeur = champ.acroField.dict.get(PDFName.of('V')) as PDFRef | undefined
      const numero = (valeur as { objectNumber?: number } | undefined)?.objectNumber
      if (typeof numero === 'number') noms.set(numero, champ.getName())
      else vides++
    }
  } catch {
    /* Formulaire illisible : on se rabat sur une numérotation simple. */
  }
  return { noms, vides }
}

/* ------------------------------------------------------------------ */
/* Horodatage                                                           */
/* ------------------------------------------------------------------ */

function horodatageNonAuthentifie(raison: string, algorithme = ''): InfoHorodatage {
  return { verifie: false, raison, date: null, autorite: '', algorithme, lieALaSignature: null }
}

/**
 * Lit le jeton d'horodatage de la signature et l'authentifie : la signature
 * du jeton est vérifiée avec le certificat de l'autorité qu'il embarque, et
 * l'empreinte qu'il scelle est recalculée sur la valeur de la signature. Sans
 * cela, n'importe qui peut coller un TSTInfo « DigiCert, 2020 » dans les
 * attributs non signés : date et autorité ne sont donc affichées qu'une fois
 * le jeton authentifié.
 *
 * Authentifié ne veut pas dire reconnu : la chaîne de l'autorité n'est pas
 * validée (limite 1 de l'en-tête).
 */
async function lireHorodatage(
  signerInfo: pkijs.SignerInfo,
): Promise<InfoHorodatage | null> {
  const jeton = attribut(signerInfo.unsignedAttrs, OID_ATTR_SIGNATURE_TIMESTAMP)
  if (!jeton?.values.length) return null
  try {
    const enveloppe = new pkijs.ContentInfo({ schema: jeton.values[0] })
    const contenu = new pkijs.SignedData({ schema: enveloppe.content })
    const eContent = contenu.encapContentInfo.eContent
    if (!eContent) return horodatageNonAuthentifie('jeton sans contenu horodaté')

    /* eContent en BER construit : on le ramène à une chaîne primitive, que
       pkijs (TSTInfo, empreinte du contenu signé) sait relire. Les octets
       sont les mêmes, donc l'empreinte et la signature aussi. */
    if (eContent.idBlock.isConstructed) {
      contenu.encapContentInfo.eContent = new asn1js.OctetString({
        valueHex: enArrayBuffer(octetsDe(eContent)),
      })
    }
    const tstInfo = pkijs.TSTInfo.fromBER(
      enArrayBuffer(octetsDe(contenu.encapContentInfo.eContent as asn1js.BaseBlock)),
    )
    const algorithme =
      NOMS_EMPREINTE[tstInfo.messageImprint.hashAlgorithm.algorithmId] ??
      tstInfo.messageImprint.hashAlgorithm.algorithmId

    if (!contenu.signerInfos.length) {
      return horodatageNonAuthentifie('jeton signé par personne (aucun signataire)', algorithme)
    }

    /* Le jeton scelle-t-il CETTE signature ? (calcul propre, pour pouvoir le
       dire distinctement d'une signature de jeton invalide.) */
    const nomAlgorithme = NOMS_EMPREINTE[tstInfo.messageImprint.hashAlgorithm.algorithmId]
    let lieALaSignature: boolean | null = null
    if (nomAlgorithme && EMPREINTES_PRISES_EN_CHARGE.has(nomAlgorithme)) {
      const attendu = new Uint8Array(
        await globalThis.crypto.subtle.digest(
          nomAlgorithme,
          enArrayBuffer(new Uint8Array(signerInfo.signature.valueBlock.valueHexView)),
        ),
      )
      lieALaSignature = memesOctets(
        attendu,
        tstInfo.messageImprint.hashedMessage.valueBlock.valueHexView,
      )
      if (!lieALaSignature) {
        return horodatageNonAuthentifie('le jeton ne porte pas sur cette signature', algorithme)
      }
    }

    /* La signature du jeton lui-même, avec le certificat de l'autorité. pkijs
       relit aussi l'empreinte du TSTInfo contre la valeur de la signature. */
    const resultat = await contenu.verify({
      signer: 0,
      data: enArrayBuffer(new Uint8Array(signerInfo.signature.valueBlock.valueHexView)),
      extendedMode: true,
    })
    if (resultat.signatureVerified !== true) {
      return horodatageNonAuthentifie('la signature du jeton est invalide', algorithme)
    }

    const nomsTsa = resultat.signerCertificate ? valeursDuNom(resultat.signerCertificate.subject) : {}
    return {
      verifie: true,
      raison: '',
      date: tstInfo.genTime ?? null,
      autorite: nomsTsa.CN ?? nomsTsa.O ?? '',
      algorithme,
      lieALaSignature,
    }
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    return horodatageNonAuthentifie(`jeton illisible ou non vérifiable : ${detail}`)
  }
}

/* ------------------------------------------------------------------ */
/* Vérification                                                         */
/* ------------------------------------------------------------------ */

function profilDe(subFilter: string): 'pades' | 'pkcs7' | 'inconnu' {
  if (subFilter.startsWith('ETSI.')) return 'pades'
  if (subFilter.startsWith('adbe.')) return 'pkcs7'
  return 'inconnu'
}

export async function verifierSignatures(bytes: Uint8Array): Promise<RapportSignatures> {
  preparerMoteur()
  const brutes = trouverSignatures(bytes)
  const { noms, vides } = await lireChampsFormulaire(bytes)
  const signatures: SignatureVerifiee[] = []

  for (let index = 0; index < brutes.length; index++) {
    const brute = brutes[index]
    const subFilter = lireNom(brute.objet, 'SubFilter')
    const base: SignatureVerifiee = {
      numero: index + 1,
      nomChamp: noms.get(brute.numeroObjet) ?? '',
      nomDeclare: lireChaine(brute.objet, 'Name'),
      motif: lireChaine(brute.objet, 'Reason'),
      lieu: lireChaine(brute.objet, 'Location'),
      contact: lireChaine(brute.objet, 'ContactInfo'),
      dateDeclaree: parserDatePdf(lireChaine(brute.objet, 'M')),
      dateAttribut: null,
      subFilter,
      profil: profilDe(subFilter),
      algorithmeEmpreinte: '',
      algorithmeSignature: '',
      certificat: null,
      chaine: [],
      certificatScelle: false,
      documentIntact: false,
      signatureValide: false,
      octetsApres: octetsApres(bytes, brute.byteRange),
      emetteurPresent: false,
      horodatage: null,
      avertissements: [],
      erreur: '',
      verdict: 'inconnu',
    }

    try {
      /* /ByteRange : la première plage commence au début du fichier et les
         deux plages encadrent exactement /Contents. Sinon, des octets sont
         hors de toute portée de la signature ou la structure est atypique :
         on ne conclut pas, on le dit. */
      const [debutPlage, longueurPlage, debutSuite] = brute.byteRange
      if (debutPlage !== 0) {
        throw new Error('/ByteRange atypique : la première plage signée ne commence pas au début du fichier.')
      }
      if (debutPlage + longueurPlage !== brute.debutContenu || debutSuite !== brute.finContenu) {
        throw new Error('/ByteRange atypique : les plages signées n’encadrent pas exactement /Contents.')
      }

      const enveloppe = pkijs.ContentInfo.fromBER(enArrayBuffer(brute.cms))
      const signedData = new pkijs.SignedData({ schema: enveloppe.content })
      const signerInfo = signedData.signerInfos[0]
      if (!signerInfo) throw new Error('CMS sans signataire.')

      const oidEmpreinte = signerInfo.digestAlgorithm.algorithmId
      const oidSignature = signerInfo.signatureAlgorithm.algorithmId
      base.algorithmeEmpreinte = NOMS_EMPREINTE[oidEmpreinte] ?? oidEmpreinte
      base.algorithmeSignature = NOMS_SIGNATURE[oidSignature] ?? oidSignature

      const certificats = (signedData.certificates ?? []).filter(
        (c): c is pkijs.Certificate => c instanceof pkijs.Certificate,
      )
      base.chaine = certificats.map(decrireCertificat)

      let signataire = await trouverSignataire(signerInfo, certificats)
      if (signataire) {
        base.certificat = decrireCertificat(signataire)
        base.emetteurPresent = certificats.some(
          (c) => c !== signataire && c.subject.isEqual(signataire!.issuer),
        )
      } else {
        base.avertissements.push('signataire_absent')
      }

      base.certificatScelle =
        !!attribut(signerInfo.signedAttrs, OID_ATTR_SIGNING_CERTIFICATE_V2) ||
        !!attribut(signerInfo.signedAttrs, OID_ATTR_SIGNING_CERTIFICATE)

      const heure = attribut(signerInfo.signedAttrs, OID_ATTR_SIGNING_TIME)
      const valeurHeure = heure?.values[0] as { toDate?: () => Date } | undefined
      if (valeurHeure?.toDate) base.dateAttribut = valeurHeure.toDate()

      /* Intégrité : l'empreinte scellée contre le contenu réellement signé.
         Ce que le navigateur ne sait pas calculer (SHA-224, SHA-3) ou ne sait
         pas lire (CMS sans attributs signés) donne « non déterminé » — jamais
         « le contenu signé a changé », qui serait une affirmation sans preuve. */
      const nomAlgorithme = NOMS_EMPREINTE[oidEmpreinte]
      if (!nomAlgorithme || !EMPREINTES_PRISES_EN_CHARGE.has(nomAlgorithme)) {
        throw new Error(
          `Algorithme d’empreinte non pris en charge (${nomAlgorithme ?? oidEmpreinte}) : la signature ne peut pas être vérifiée ici.`,
        )
      }
      if (!signerInfo.signedAttrs) {
        throw new Error('Signature CMS sans attributs signés : forme non prise en charge, la signature ne peut pas être vérifiée ici.')
      }
      const attributEmpreinte = attribut(signerInfo.signedAttrs, OID_ATTR_MESSAGE_DIGEST)
      if (!attributEmpreinte?.values.length) {
        throw new Error('Attribut « message-digest » absent des attributs signés : signature malformée.')
      }
      const signe = octetsSignes(bytes, brute.byteRange)
      const scellee = (attributEmpreinte.values[0] as asn1js.OctetString).valueBlock.valueHexView
      const calculee = new Uint8Array(
        await globalThis.crypto.subtle.digest(nomAlgorithme, enArrayBuffer(signe)),
      )
      base.documentIntact = memesOctets(scellee, calculee)

      base.horodatage = await lireHorodatage(signerInfo)

      /* Points d'attention : le verdict ne change pas, l'interface les montre. */
      if (nomAlgorithme === 'SHA-1' || OID_SIGNATURE_SHA1.has(oidSignature)) {
        base.avertissements.push('sha1')
      }
      const dateReference =
        (base.horodatage?.verifie ? base.horodatage.date : null) ?? base.dateAttribut
      if (signataire && dateReference && horsValidite(signataire, dateReference)) {
        base.avertissements.push('certificat_expire')
      }

      /* Signature : seulement quand l'empreinte concorde, sinon pkijs refuse
         d'aller plus loin — et le verdict est de toute façon acquis. */
      if (base.documentIntact) {
        if (!signataire) {
          throw new Error('Certificat du signataire absent du fichier : la signature ne peut pas être vérifiée.')
        }
        const resultat = await signedData.verify({
          signer: 0,
          data: enArrayBuffer(signe),
          extendedMode: true,
        })
        base.signatureValide = resultat.signatureVerified === true
        /* Le certificat qui a réellement servi à vérifier la signature fait foi. */
        const verificateur = resultat.signerCertificate
        if (verificateur && verificateur !== signataire) {
          signataire = verificateur
          base.certificat = decrireCertificat(verificateur)
          base.emetteurPresent = certificats.some(
            (c) => c !== verificateur && c.subject.isEqual(verificateur.issuer),
          )
        }
      }
    } catch (e) {
      base.erreur = e instanceof Error ? e.message : String(e)
    }

    if (base.erreur) base.verdict = 'inconnu'
    else if (!base.documentIntact || !base.signatureValide) base.verdict = 'echec'
    else if (base.octetsApres > 0) base.verdict = 'modifie-apres'
    else base.verdict = 'intacte'

    signatures.push(base)
  }

  return {
    signatures,
    champsVides: vides,
    chiffre: looksEncrypted(bytes),
    tailleFichier: bytes.length,
  }
}
