/**
 * Généré depuis vellum-pdf/src/lib/srgbIcc.ts — ne pas éditer ici.
 * Source de vérité : le dépôt privé vellum-pdf, via scripts/sync-engine.mjs.
 */

/**
 * Génère, à la volée, un profil ICC v2 minimal représentant l'espace sRGB —
 * pour servir d'« Output Intent » à la conversion PDF/A (voir pdfa.ts).
 *
 * Pourquoi le générer plutôt que d'embarquer un fichier .icc existant : les
 * profils sRGB largement diffusés (celui de macOS, celui distribué par
 * certains outils) portent des conditions de redistribution qui ne sont pas
 * toutes limpides pour un bundle web public. Les valeurs colorimétriques
 * utilisées ici (primaires et point blanc du sRGB, adaptées à l'illuminant
 * D50 de l'espace de connexion ICC) sont des constantes publiées par les
 * spécifications IEC 61966-2-1 et ICC.1:2001-04 elles-mêmes — pas une
 * expression protégée — et l'encodage binaire ci-dessous est écrit
 * directement d'après le format ICC. Le résultat n'est pas bit-à-bit
 * identique aux profils sRGB de référence (courbe de gamma simplifiée en
 * 2.2 plutôt que la courbe sRGB par morceaux), mais suffit à qualifier
 * correctement l'espace couleur de sortie pour un lecteur PDF/A.
 */

const TAG_TABLE_ENTRY_SIZE = 12
const HEADER_SIZE = 128

function pad4(n: number): number {
  return (4 - (n % 4)) % 4
}

function writeU32(view: DataView, offset: number, value: number) {
  view.setUint32(offset, value >>> 0, false)
}

function writeU16(view: DataView, offset: number, value: number) {
  view.setUint16(offset, value & 0xffff, false)
}

function writeTag(view: DataView, offset: number, tag: string) {
  for (let i = 0; i < 4; i++) view.setUint8(offset + i, tag.charCodeAt(i))
}

/** Encode un nombre décimal en s15Fixed16Number (entier signé 32 bits, 16 bits fractionnaires). */
function writeS15Fixed16(view: DataView, offset: number, value: number) {
  writeU32(view, offset, Math.round(value * 65536))
}

/** Bloc de données pour les tags wtpt/rXYZ/gXYZ/bXYZ : type 'XYZ ' + une triplette XYZ. */
function xyzTag(x: number, y: number, z: number): Uint8Array {
  const buf = new ArrayBuffer(20)
  const view = new DataView(buf)
  writeTag(view, 0, 'XYZ ')
  writeU32(view, 4, 0)
  writeS15Fixed16(view, 8, x)
  writeS15Fixed16(view, 12, y)
  writeS15Fixed16(view, 16, z)
  return new Uint8Array(buf)
}

/** Bloc de données pour rTRC/gTRC/bTRC : courbe à un seul point = gamma simple. */
function curveGammaTag(gamma: number): Uint8Array {
  const buf = new ArrayBuffer(14)
  const view = new DataView(buf)
  writeTag(view, 0, 'curv')
  writeU32(view, 4, 0)
  writeU32(view, 8, 1) // count = 1 -> valeur unique interprétée comme gamma
  writeU16(view, 12, Math.round(gamma * 256)) // u8Fixed8Number
  return new Uint8Array(buf)
}

/** Bloc de données textDescriptionType (ICC v2) pour le tag 'desc'. */
function descTag(ascii: string): Uint8Array {
  const asciiBytes = new TextEncoder().encode(ascii)
  const asciiLen = asciiBytes.length + 1 // + terminateur nul
  const size = 4 + 4 + 4 + asciiLen + 4 + 4 + 2 + 1 + 67
  const buf = new ArrayBuffer(size)
  const view = new DataView(buf)
  const bytes = new Uint8Array(buf)
  let o = 0
  writeTag(view, o, 'desc')
  o += 4
  writeU32(view, o, 0) // reserved
  o += 4
  writeU32(view, o, asciiLen)
  o += 4
  bytes.set(asciiBytes, o)
  o += asciiLen // le dernier octet (nul) reste à 0 par défaut
  writeU32(view, o, 0) // unicode language code
  o += 4
  writeU32(view, o, 0) // unicode description length
  o += 4
  writeU16(view, o, 0) // ScriptCode code
  o += 2
  bytes[o] = 0 // Macintosh description length
  o += 1
  // 67 octets réservés au nom Macintosh, laissés à zéro
  return bytes
}

/** Bloc de données textType pour le tag 'cprt'. */
function textTag(ascii: string): Uint8Array {
  const asciiBytes = new TextEncoder().encode(ascii + '\0')
  const buf = new ArrayBuffer(8 + asciiBytes.length)
  const view = new DataView(buf)
  const bytes = new Uint8Array(buf)
  writeTag(view, 0, 'text')
  writeU32(view, 4, 0)
  bytes.set(asciiBytes, 8)
  return bytes
}

interface Tag {
  sig: string
  data: Uint8Array
}

/**
 * Construit un profil ICC v2 « display » (mntr), espace RGB, matrice +
 * courbes de gamma — la forme la plus simple de profil colorimétrique
 * valide, celle qu'utilisent la plupart des générateurs sRGB minimalistes.
 */
export function generateSrgbIccProfile(): Uint8Array {
  // Primaires sRGB et point blanc D65, adaptés (Bradford) vers l'illuminant
  // D50 de l'espace de connexion ICC — valeurs standard, publiées par la
  // spécification ICC elle-même en exemple d'implémentation du sRGB.
  const rXYZ = xyzTag(0.4360747, 0.2225045, 0.0139322)
  const gXYZ = xyzTag(0.3850649, 0.7168786, 0.0971045)
  const bXYZ = xyzTag(0.1430804, 0.0606169, 0.7141733)
  const wtpt = xyzTag(0.9642, 1.0, 0.8249)
  const trc = curveGammaTag(2.2)
  const desc = descTag('sRGB (genere par VellumPDF)')
  const cprt = textTag('Profil colorimetrique genere par VellumPDF, sans revendication de droits')

  const tags: Tag[] = [
    { sig: 'desc', data: desc },
    { sig: 'cprt', data: cprt },
    { sig: 'wtpt', data: wtpt },
    { sig: 'rXYZ', data: rXYZ },
    { sig: 'gXYZ', data: gXYZ },
    { sig: 'bXYZ', data: bXYZ },
    { sig: 'rTRC', data: trc },
    { sig: 'gTRC', data: trc },
    { sig: 'bTRC', data: trc },
  ]

  const tagTableSize = 4 + tags.length * TAG_TABLE_ENTRY_SIZE
  let dataOffset = HEADER_SIZE + tagTableSize
  const layout = tags.map((tag) => {
    const offset = dataOffset
    const size = tag.data.length
    dataOffset += size + pad4(size)
    return { ...tag, offset, size }
  })
  const totalSize = dataOffset

  const buf = new ArrayBuffer(totalSize)
  const view = new DataView(buf)
  const bytes = new Uint8Array(buf)

  // --- En-tête (128 octets) ---
  writeU32(view, 0, totalSize)
  writeTag(view, 4, 'none') // CMM (aucun enregistré)
  writeU32(view, 8, 0x02100000) // version 2.1.0
  writeTag(view, 12, 'mntr') // classe : moniteur (display)
  writeTag(view, 16, 'RGB ') // espace couleur des données
  writeTag(view, 20, 'XYZ ') // espace de connexion (PCS)
  // Date de création : fixe, pour un résultat déterministe (pas d'octet qui
  // change d'une génération à l'autre pour un même appel).
  writeU16(view, 24, 2026)
  writeU16(view, 26, 1)
  writeU16(view, 28, 1)
  writeU16(view, 30, 0)
  writeU16(view, 32, 0)
  writeU16(view, 34, 0)
  writeTag(view, 36, 'acsp') // signature de fichier profil, obligatoire
  writeU32(view, 40, 0) // plateforme primaire : inconnue
  writeU32(view, 44, 0) // drapeaux
  writeU32(view, 48, 0) // fabricant
  writeU32(view, 52, 0) // modèle
  writeU32(view, 56, 0) // attributs (8 octets)
  writeU32(view, 60, 0)
  writeU32(view, 64, 0) // intent de rendu : perceptuel
  // Illuminant PCS (D50), valeurs fixes imposées par la spec ICC.
  writeS15Fixed16(view, 68, 0.9642)
  writeS15Fixed16(view, 72, 1.0)
  writeS15Fixed16(view, 76, 0.8249)
  writeTag(view, 80, 'none') // créateur du profil
  // Profile ID (MD5, 16 octets) laissé à zéro : indique explicitement « non calculé ».

  // --- Table des tags ---
  writeU32(view, HEADER_SIZE, tags.length)
  layout.forEach((tag, i) => {
    const entryOffset = HEADER_SIZE + 4 + i * TAG_TABLE_ENTRY_SIZE
    writeTag(view, entryOffset, tag.sig)
    writeU32(view, entryOffset + 4, tag.offset)
    writeU32(view, entryOffset + 8, tag.size)
  })

  // --- Données des tags ---
  for (const tag of layout) {
    bytes.set(tag.data, tag.offset)
  }

  return bytes
}
