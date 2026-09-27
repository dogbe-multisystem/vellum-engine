/**
 * Généré depuis vellum-pdf/src/lib/pdfa.ts — ne pas éditer ici.
 * Source de vérité : le dépôt privé vellum-pdf, via scripts/sync-engine.mjs.
 */

/**
 * Conversion PDF/A-2B, en deux modes (voir aussi validate-pdfa.mjs dans le
 * dépôt privé, qui vérifie les deux avec veraPDF). Seul le mode « fidèle »
 * (convertToPdfA) est exposé par la commande `pdfa` du CLI : le mode
 * « conforme » ci-dessous reste documenté pour le contexte, non utilisé ici.
 *
 * 1. « Conforme » (`buildConformePdfA`) : reconstruit le document à partir
 *    de pages rastérisées (images), sans aucune police ni contenu
 *    dynamique. C'est le seul mode dont la conformité ISO 19005-2 (PDF/A-2B)
 *    est prouvée — validé par veraPDF (voir le harnais de test) sur un
 *    corpus varié ET sur un fichier réellement produit par le navigateur.
 *    Le texte n'est plus sélectionnable ; c'est le compromis qui rend la
 *    conformité vérifiable plutôt qu'espérée.
 *
 * 2. « Fidèle » (`convertToPdfA`) : conversion au mieux, via pdf-lib
 *    uniquement — pas de Ghostscript. Un moteur Ghostscript-wasm existe bien
 *    sur npm (@jspawn/ghostscript-wasm), mais testé en conditions réelles il
 *    ne produit PAS de PDF conforme — le dictionnaire /OutputIntents,
 *    obligatoire pour qu'un fichier soit reconnu PDF/A par n'importe quel
 *    valideur, restait absent quel que soit le profil ICC pointé, y compris
 *    construit à la main dans le système de fichiers virtuel. Ce mode
 *    préserve le texte et sa sélectionnabilité, mais la conformité dépend du
 *    document d'origine (polices déjà embarquées ou non, transparence,
 *    espaces colorimétriques) : rien n'est garanti, seulement amélioré.
 *    Ce que fait ce mode, honnêtement documenté comme « au mieux » :
 *      a. Rejette les documents chiffrés (comme le reste de la suite).
 *      b. Retire les mécanismes d'automatisation interdits par PDF/A
 *         (JavaScript, actions à l'ouverture) — même logique que l'outil
 *         « nettoyer ».
 *      c. Vérifie que les polices utilisées sont embarquées, et signale par
 *         leur nom celles qui ne le sont pas (PDF/A l'exige ; pdf-lib ne
 *         peut pas embarquer après coup une police qu'il n'a pas).
 *      d. Ajoute un Output Intent sRGB, un identifiant de fichier (trailer
 *         /ID) et des métadonnées XMP cohérentes avec le dictionnaire /Info
 *         (voir les fonctions partagées ci-dessous).
 *    Ce que ce mode NE FAIT PAS, contrairement au mode conforme : conversion
 *    des espaces couleur CMJN/Lab vers un espace indépendant du périphérique,
 *    aplatissement de la transparence, embarquement rétroactif des polices
 *    manquantes.
 */
import type { PDFDict, PDFDocument } from 'pdf-lib'
// Extensions .ts explicites : ce module doit rester importable directement
// par Node (scripts/validate-pdfa.mjs), qui — contrairement à Vite — ne
// résout pas les spécificateurs relatifs sans extension.
import { chargerPdfLib } from './bibliotheques.ts'
import { loadPdf, savePdf } from './pdf.ts'
import { generateSrgbIccProfile } from './srgbIcc.ts'

/**
 * pdf-lib n'est chargé qu'au premier appel de `convertToPdfA` ou
 * `buildConformePdfA` (voir bibliotheques.ts) : les classes (PDFName,
 * PDFDict…) sont donc reçues en paramètre par les fonctions ci-dessous
 * plutôt qu'importées statiquement en tête de module.
 */
type PdfLib = Awaited<ReturnType<typeof chargerPdfLib>>

/** Noms PDF utilisés par ce module, calculés une fois pdf-lib chargé. */
function names(pdf: PdfLib) {
  return {
    OPEN_ACTION: pdf.PDFName.of('OpenAction'),
    AA: pdf.PDFName.of('AA'),
    A: pdf.PDFName.of('A'),
    NAMES: pdf.PDFName.of('Names'),
    JAVASCRIPT: pdf.PDFName.of('JavaScript'),
    S: pdf.PDFName.of('S'),
    FONT: pdf.PDFName.of('Font'),
    SUBTYPE: pdf.PDFName.of('Subtype'),
    BASEFONT: pdf.PDFName.of('BaseFont'),
    FONT_DESCRIPTOR: pdf.PDFName.of('FontDescriptor'),
    DESCENDANT_FONTS: pdf.PDFName.of('DescendantFonts'),
    FONT_FILE: pdf.PDFName.of('FontFile'),
    FONT_FILE2: pdf.PDFName.of('FontFile2'),
    FONT_FILE3: pdf.PDFName.of('FontFile3'),
  }
}
type Names = ReturnType<typeof names>
const JS_ACTION = '/JavaScript'

export interface PdfaReport {
  /** Actions automatiques / scripts retirés (voir sanitizePdf). */
  actionsRemoved: number
  /** Noms des polices utilisées mais non embarquées (peut être vide). */
  nonEmbeddedFonts: string[]
}

function isJavaScriptAction(pdf: PdfLib, N: Names, action: PDFDict): boolean {
  const subtype = action.lookupMaybe(N.S, pdf.PDFName)
  return subtype?.asString() === JS_ACTION
}

function sanitizeAnnotation(pdf: PdfLib, N: Names, annot: PDFDict): number {
  let removed = 0
  const action = annot.lookupMaybe(N.A, pdf.PDFDict)
  if (action && isJavaScriptAction(pdf, N, action)) {
    annot.delete(N.A)
    removed++
  }
  const aa = annot.lookupMaybe(N.AA, pdf.PDFDict)
  if (aa) {
    let touched = false
    for (const key of aa.keys()) {
      const trigger = aa.lookupMaybe(key, pdf.PDFDict)
      if (trigger && isJavaScriptAction(pdf, N, trigger)) {
        aa.delete(key)
        touched = true
        removed++
      }
    }
    if (touched && aa.keys().length === 0) annot.delete(N.AA)
  }
  return removed
}

function fontDescriptorOf(pdf: PdfLib, N: Names, fontDict: PDFDict): PDFDict | undefined {
  const subtype = fontDict.lookupMaybe(N.SUBTYPE, pdf.PDFName)?.asString()
  if (subtype === '/Type0') {
    const descendants = fontDict.lookupMaybe(N.DESCENDANT_FONTS, pdf.PDFArray)
    const first = descendants && descendants.size() > 0 ? descendants.lookupMaybe(0, pdf.PDFDict) : undefined
    return first?.lookupMaybe(N.FONT_DESCRIPTOR, pdf.PDFDict)
  }
  return fontDict.lookupMaybe(N.FONT_DESCRIPTOR, pdf.PDFDict)
}

function isEmbedded(N: Names, descriptor: PDFDict | undefined): boolean {
  if (!descriptor) return false
  return (
    descriptor.has(N.FONT_FILE) || descriptor.has(N.FONT_FILE2) || descriptor.has(N.FONT_FILE3)
  )
}

// ---------------------------------------------------------------------------
// Fonctions partagées par les deux modes — uniquement pdf-lib, aucune
// dépendance DOM ou pdfjs : ce module reste importable côté Node
// (voir scripts/validate-pdfa.mjs, qui l'importe directement).
// ---------------------------------------------------------------------------

/**
 * Identifiant de fichier aléatoire (trailer /ID), exigé par PDF/A (ISO
 * 19005-2, 6.1.3, qui renvoie à ISO 32000-1, 14.4). pdf-lib n'en génère pas
 * pour un document fraîchement créé — sans lui, veraPDF rejette
 * systématiquement le fichier, y compris un document par ailleurs
 * irréprochable (vérifié : voir le rapport de la tâche).
 */
function addTrailerId(pdf: PdfLib, doc: PDFDocument): void {
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  const id = pdf.PDFHexString.of(hex)
  doc.context.trailerInfo.ID = doc.context.obj([id, id])
}

/** Ajoute l'Output Intent sRGB (profil ICC généré localement, voir srgbIcc.ts). */
function addOutputIntentSrgb(pdf: PdfLib, doc: PDFDocument): void {
  const context = doc.context
  const iccBytes = generateSrgbIccProfile()
  const iccStreamRef = context.register(context.stream(iccBytes, { N: 3 }))
  const outputIntent = context.obj({
    Type: 'OutputIntent',
    S: 'GTS_PDFA1',
    OutputConditionIdentifier: pdf.PDFString.of('sRGB IEC61966-2.1'),
    RegistryName: pdf.PDFString.of('http://www.color.org'),
    Info: pdf.PDFString.of('sRGB IEC61966-2.1'),
    DestOutputProfile: iccStreamRef,
  })
  doc.catalog.set(pdf.PDFName.of('OutputIntents'), context.obj([outputIntent]))
}

/** Date au format XMP (ISO 8601 avec fuseau), à partir d'un objet Date JS. */
function toXmpDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  const tzOffset = -d.getTimezoneOffset()
  const sign = tzOffset >= 0 ? '+' : '-'
  const abs = Math.abs(tzOffset)
  const tz = `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${tz}`
  )
}

/**
 * Construit le paquet XMP déclarant la conformité PDF/A-2B.
 *
 * Les dates et le Producer DOIVENT correspondre exactement à ceux écrits
 * dans le dictionnaire /Info (voir ISO 19005-2, 6.7.3) : un validateur
 * strict comme veraPDF signale toute incohérence entre les deux jeux de
 * métadonnées. C'est pour cette raison que ces valeurs sont toujours
 * calculées une seule fois par l'appelant, puis passées ici ET écrites dans
 * /Info via l'API pdf-lib (setProducer/setCreationDate/setModificationDate).
 */
function buildXmpPacket(opts: {
  title?: string
  producer: string
  createDate: string
  modifyDate: string
}): Uint8Array {
  const escape = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const titleBlock = opts.title
    ? `<dc:title><rdf:Alt><rdf:li xml:lang="x-default">${escape(opts.title)}</rdf:li></rdf:Alt></dc:title>`
    : ''
  const xml = `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/">
   <pdfaid:part>2</pdfaid:part>
   <pdfaid:conformance>B</pdfaid:conformance>
  </rdf:Description>
  <rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">
   <dc:format>application/pdf</dc:format>
   ${titleBlock}
  </rdf:Description>
  <rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/">
   <xmp:CreateDate>${opts.createDate}</xmp:CreateDate>
   <xmp:ModifyDate>${opts.modifyDate}</xmp:ModifyDate>
   <xmp:MetadataDate>${opts.modifyDate}</xmp:MetadataDate>
  </rdf:Description>
  <rdf:Description rdf:about="" xmlns:pdf="http://ns.adobe.com/pdf/1.3/">
   <pdf:Producer>${escape(opts.producer)}</pdf:Producer>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`
  return new TextEncoder().encode(xml)
}

function addXmpMetadata(
  pdf: PdfLib,
  doc: PDFDocument,
  opts: { title?: string; producer: string; createDate: Date; modifyDate: Date },
): void {
  const xmpBytes = buildXmpPacket({
    title: opts.title,
    producer: opts.producer,
    createDate: toXmpDate(opts.createDate),
    modifyDate: toXmpDate(opts.modifyDate),
  })
  const metadataRef = doc.context.register(
    doc.context.stream(xmpBytes, { Type: 'Metadata', Subtype: 'XML' }),
  )
  doc.catalog.set(pdf.PDFName.of('Metadata'), metadataRef)
}

// ---------------------------------------------------------------------------
// Mode « fidèle » (au mieux, sans garantie).
// ---------------------------------------------------------------------------

const PRODUCER_FIDELE = 'VellumPDF — conversion PDF/A-2B au mieux (pdf-lib, sans Ghostscript)'

/** Convertit un PDF en PDF/A-2B « au mieux ». Rejette les documents chiffrés. */
export async function convertToPdfA(bytes: Uint8Array): Promise<{
  bytes: Uint8Array
  report: PdfaReport
}> {
  const pdf = await chargerPdfLib()
  const N = names(pdf)
  const doc = await loadPdf(bytes)
  const catalog = doc.catalog
  const report: PdfaReport = { actionsRemoved: 0, nonEmbeddedFonts: [] }

  // 1) Retrait des mécanismes d'automatisation interdits par PDF/A.
  if (catalog.has(N.OPEN_ACTION)) {
    catalog.delete(N.OPEN_ACTION)
    report.actionsRemoved++
  }
  if (catalog.has(N.AA)) {
    catalog.delete(N.AA)
    report.actionsRemoved++
  }
  const namesDict = catalog.lookupMaybe(N.NAMES, pdf.PDFDict)
  if (namesDict?.has(N.JAVASCRIPT)) {
    namesDict.delete(N.JAVASCRIPT)
    report.actionsRemoved++
  }
  for (const page of doc.getPages()) {
    const node = page.node
    if (node.has(N.AA)) {
      node.delete(N.AA)
      report.actionsRemoved++
    }
    const annots = node.Annots()
    if (!annots) continue
    for (let i = 0; i < annots.size(); i++) {
      const annot = annots.lookupMaybe(i, pdf.PDFDict)
      if (annot) report.actionsRemoved += sanitizeAnnotation(pdf, N, annot)
    }
  }

  // 2) Vérification de l'embarquement des polices (signalé, pas corrigé :
  // pdf-lib ne peut pas embarquer après coup une police qu'il n'a jamais eue).
  const seen = new Set<string>()
  for (const page of doc.getPages()) {
    const resources = page.node.Resources()
    const fontDict = resources?.lookupMaybe(N.FONT, pdf.PDFDict)
    if (!fontDict) continue
    for (const key of fontDict.keys()) {
      const font = fontDict.lookupMaybe(key, pdf.PDFDict)
      if (!font) continue
      const baseFont = font.lookupMaybe(N.BASEFONT, pdf.PDFName)?.decodeText() ?? key.decodeText()
      if (seen.has(baseFont)) continue
      seen.add(baseFont)
      if (!isEmbedded(N, fontDescriptorOf(pdf, N, font))) {
        report.nonEmbeddedFonts.push(baseFont)
      }
    }
  }

  // 3) Output Intent, identifiant de fichier et métadonnées XMP — communs
  // aux deux modes (voir plus haut). Le Producer et les dates sont d'abord
  // écrits dans /Info via l'API pdf-lib, puis relus pour rester
  // parfaitement cohérents avec le XMP (voir buildXmpPacket).
  doc.setProducer(PRODUCER_FIDELE)
  const modifyDate = new Date()
  doc.setModificationDate(modifyDate)
  if (!doc.getCreationDate()) doc.setCreationDate(modifyDate)
  const createDate = doc.getCreationDate() ?? modifyDate

  addOutputIntentSrgb(pdf, doc)
  addTrailerId(pdf, doc)
  addXmpMetadata(pdf, doc, {
    title: doc.getTitle() || undefined,
    producer: PRODUCER_FIDELE,
    createDate,
    modifyDate,
  })

  return { bytes: await savePdf(doc), report }
}

// ---------------------------------------------------------------------------
// Mode « conforme » — reconstruction en pages-images, seul mode dont la
// conformité ISO 19005-2 est vérifiée (voir scripts/validate-pdfa.mjs).
// ---------------------------------------------------------------------------

/**
 * Une page déjà rastérisée en image opaque (sans canal alpha), prête à être
 * embarquée dans le PDF/A reconstruit. Produite soit par le navigateur
 * (`rasterisePdfForPdfA` dans pdf.ts, via pdfjs-dist + canvas DOM), soit par
 * le harnais Node (`scripts/validate-pdfa.mjs`, via pdfjs-dist + un canvas
 * serveur) — les deux chemins alimentent `buildConformePdfA` à l'identique,
 * ce qui garantit que le fichier réellement produit dans le navigateur suit
 * la même logique de construction que celui vérifié par le harnais.
 */
export interface RasterisedPageForPdfA {
  /** Image encodée, sans transparence. */
  bytes: Uint8Array
  format: 'png' | 'jpg'
  /** Dimensions de la page d'origine, en points PDF (1/72 pouce). */
  widthPt: number
  heightPt: number
}

export interface ConformePdfaReport {
  pageCount: number
}

const PRODUCER_CONFORME = 'VellumPDF — conversion PDF/A-2B conforme (pages rastérisées, validé veraPDF)'

/**
 * Reconstruit un PDF/A-2B conforme à partir de pages déjà rastérisées.
 * Fonction pure (aucune dépendance DOM ni pdfjs) : c'est elle que
 * `scripts/validate-pdfa.mjs` exerce directement côté Node, et celle que la
 * page outil appelle côté navigateur après rastérisation.
 */
export async function buildConformePdfA(
  pages: RasterisedPageForPdfA[],
  opts: { title?: string } = {},
): Promise<{ bytes: Uint8Array; report: ConformePdfaReport }> {
  if (pages.length === 0) {
    throw new Error('PDF_EMPTY: aucune page à convertir')
  }

  const pdf = await chargerPdfLib()
  const doc = await pdf.PDFDocument.create()
  const now = new Date()
  if (opts.title) doc.setTitle(opts.title)
  doc.setProducer(PRODUCER_CONFORME)
  doc.setCreationDate(now)
  doc.setModificationDate(now)

  for (const p of pages) {
    const image = p.format === 'png' ? await doc.embedPng(p.bytes) : await doc.embedJpg(p.bytes)
    const page = doc.addPage([p.widthPt, p.heightPt])
    page.drawImage(image, { x: 0, y: 0, width: p.widthPt, height: p.heightPt })
  }

  addOutputIntentSrgb(pdf, doc)
  addTrailerId(pdf, doc)
  addXmpMetadata(pdf, doc, {
    title: opts.title,
    producer: PRODUCER_CONFORME,
    createDate: now,
    modifyDate: now,
  })

  return { bytes: await savePdf(doc), report: { pageCount: pages.length } }
}
