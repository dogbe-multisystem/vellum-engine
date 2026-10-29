/**
 * Généré depuis vellum-pdf/src/lib/inspect.ts — ne pas éditer ici.
 * Source de vérité : le dépôt privé vellum-pdf, via scripts/sync-engine.mjs.
 */

/**
 * Rapport de confidentialité : inventaire en lecture seule de tout ce qu'un
 * PDF peut révéler ou déclencher avant d'être partagé — métadonnées,
 * automatisations, liens, pièces jointes, annotations, formulaire, texte
 * caché, calques optionnels, polices, chiffrement. Aucune écriture : ce
 * module ne fait que lire et compter, jamais modifier.
 *
 * Un document réellement protégé par mot de passe ne peut pas être analysé
 * plus loin que la seule détection du chiffrement (pdf-lib ne déchiffre
 * jamais les chaînes ni les flux) : `limitedByEncryption` le signale, le
 * reste du rapport reste alors à ses valeurs vides.
 */
import type { PDFDict, PDFDocument, PDFField, PDFPage, PDFRef } from 'pdf-lib'
// Chargement différé de pdf-lib, au premier usage réel (voir bibliotheques.ts).
// Les fonctions internes ci-dessous reçoivent le module chargé (`lib`) en
// paramètre plutôt que de le recharger chacune, `inspecterPdf` le chargeant
// une seule fois pour toute l'analyse.
import { chargerPdfLib } from './bibliotheques.ts'
import { looksEncrypted } from './qpdf.ts'
import { listAttachments } from './attachments.ts'
import type { AttachmentInfo } from './attachments.ts'

/** Le module pdf-lib une fois chargé (voir `chargerPdfLib`). */
type PdfLib = Awaited<ReturnType<typeof chargerPdfLib>>

export interface InspectionMeta {
  title: string
  author: string
  subject: string
  keywords: string
  creator: string
  producer: string
  creationDate: Date | null
  modificationDate: Date | null
}

export interface InspectionReport {
  encrypted: boolean
  /** Vrai quand le chiffrement empêche toute analyse au-delà de ce simple constat. */
  limitedByEncryption: boolean
  pageCount: number
  pageSizes: { width: number; height: number }[]
  metadata: InspectionMeta
  hasXmp: boolean
  javascriptBlocks: number
  autoActions: number
  externalLinks: string[]
  attachments: AttachmentInfo[]
  annotations: { total: number; byType: Record<string, number>; authors: string[] }
  formFields: { total: number; byType: Record<string, number> }
  hiddenText: { invisibleTextRuns: number; outsideCropBoxItems: number }
  ocgLayers: string[]
  fonts: { name: string; embedded: boolean }[]
}

const RAPPORT_VIDE: InspectionReport = {
  encrypted: true,
  limitedByEncryption: true,
  pageCount: 0,
  pageSizes: [],
  metadata: {
    title: '',
    author: '',
    subject: '',
    keywords: '',
    creator: '',
    producer: '',
    creationDate: null,
    modificationDate: null,
  },
  hasXmp: false,
  javascriptBlocks: 0,
  autoActions: 0,
  externalLinks: [],
  attachments: [],
  annotations: { total: 0, byType: {}, authors: [] },
  formFields: { total: 0, byType: {} },
  hiddenText: { invisibleTextRuns: 0, outsideCropBoxItems: 0 },
  ocgLayers: [],
  fonts: [],
}

function lireMetadonnees(doc: PDFDocument): InspectionMeta {
  return {
    title: doc.getTitle() ?? '',
    author: doc.getAuthor() ?? '',
    subject: doc.getSubject() ?? '',
    keywords: doc.getKeywords() ?? '',
    creator: doc.getCreator() ?? '',
    producer: doc.getProducer() ?? '',
    creationDate: doc.getCreationDate() ?? null,
    modificationDate: doc.getModificationDate() ?? null,
  }
}

/* ------------------------------------------------------------------ */
/* Automatisations : JavaScript et actions automatiques                 */
/* ------------------------------------------------------------------ */

const JS_ACTION = '/JavaScript'

function estActionJavaScript(lib: PdfLib, action: PDFDict): boolean {
  const subtype = action.lookupMaybe(lib.PDFName.of('S'), lib.PDFName)
  return subtype?.asString() === JS_ACTION
}

function compterAutomatisations(
  lib: PdfLib,
  doc: PDFDocument,
): { javascriptBlocks: number; autoActions: number } {
  const { PDFArray, PDFDict, PDFName } = lib
  const catalog = doc.catalog
  let autoActions = 0

  if (catalog.has(PDFName.of('OpenAction'))) autoActions++
  const aaCatalogue = catalog.lookupMaybe(PDFName.of('AA'), PDFDict)
  if (aaCatalogue) autoActions += aaCatalogue.keys().length

  let javascriptBlocks = 0
  const noms = catalog.lookupMaybe(PDFName.of('Names'), PDFDict)
  const arbreJs = noms?.lookupMaybe(PDFName.of('JavaScript'), PDFDict)
  const nomsJs = arbreJs?.lookupMaybe(PDFName.of('Names'), PDFArray)
  if (nomsJs) javascriptBlocks += Math.floor(nomsJs.size() / 2)

  for (const page of doc.getPages()) {
    const node = page.node
    const aaPage = node.lookupMaybe(PDFName.of('AA'), PDFDict)
    if (aaPage) autoActions += aaPage.keys().length

    const annots = node.Annots()
    if (!annots) continue
    for (let i = 0; i < annots.size(); i++) {
      const annot = annots.lookupMaybe(i, PDFDict)
      if (!annot) continue
      const action = annot.lookupMaybe(PDFName.of('A'), PDFDict)
      if (action && estActionJavaScript(lib, action)) autoActions++
      const aa = annot.lookupMaybe(PDFName.of('AA'), PDFDict)
      if (aa) {
        for (const cle of aa.keys()) {
          const declencheur = aa.lookupMaybe(cle, PDFDict)
          if (declencheur && estActionJavaScript(lib, declencheur)) autoActions++
        }
      }
    }
  }

  return { javascriptBlocks, autoActions }
}

/* ------------------------------------------------------------------ */
/* Liens, annotations, formulaire                                       */
/* ------------------------------------------------------------------ */

const TYPES_HORS_COMPTE = new Set(['/Widget', '/Link', '/Popup'])

function texteDe(lib: PdfLib, obj: unknown): string {
  const { PDFHexString, PDFString } = lib
  if (obj instanceof PDFString || obj instanceof PDFHexString) return obj.decodeText()
  return ''
}

function listerLiensExternes(lib: PdfLib, doc: PDFDocument): string[] {
  const { PDFDict, PDFName } = lib
  const liens: string[] = []
  for (const page of doc.getPages()) {
    const annots = page.node.Annots()
    if (!annots) continue
    for (let i = 0; i < annots.size(); i++) {
      const annot = annots.lookupMaybe(i, PDFDict)
      const subtype = annot?.lookupMaybe(PDFName.of('Subtype'), PDFName)
      if (subtype?.asString() !== '/Link') continue
      const action = annot?.lookupMaybe(PDFName.of('A'), PDFDict)
      const s = action?.lookupMaybe(PDFName.of('S'), PDFName)
      if (s?.asString() !== '/URI') continue
      const uri = texteDe(lib, action?.get(PDFName.of('URI')))
      if (uri) liens.push(uri)
    }
  }
  return liens
}

function analyserAnnotations(
  lib: PdfLib,
  doc: PDFDocument,
): { total: number; byType: Record<string, number>; authors: string[] } {
  const { PDFDict, PDFName } = lib
  const byType: Record<string, number> = {}
  const auteurs = new Set<string>()
  let total = 0

  for (const page of doc.getPages()) {
    const annots = page.node.Annots()
    if (!annots) continue
    for (let i = 0; i < annots.size(); i++) {
      const annot = annots.lookupMaybe(i, PDFDict)
      if (!annot) continue
      const subtype = annot.lookupMaybe(PDFName.of('Subtype'), PDFName)
      const nomType = subtype?.asString() ?? '/Inconnu'
      if (TYPES_HORS_COMPTE.has(nomType)) continue
      const type = nomType.replace(/^\//, '')
      byType[type] = (byType[type] ?? 0) + 1
      total++
      const auteur = texteDe(lib, annot.get(PDFName.of('T')))
      if (auteur) auteurs.add(auteur)
    }
  }

  return { total, byType, authors: [...auteurs] }
}

/**
 * Type d'un champ de formulaire, par `instanceof` plutôt que
 * `constructor.name` : ce dernier survit rarement à la minification du build
 * de production, qui renomme les classes de la dépendance groupée.
 */
function typeDeChamp(lib: PdfLib, champ: PDFField): string {
  const { PDFTextField, PDFCheckBox, PDFRadioGroup, PDFDropdown, PDFOptionList, PDFButton, PDFSignature } =
    lib
  if (champ instanceof PDFTextField) return 'TextField'
  if (champ instanceof PDFCheckBox) return 'CheckBox'
  if (champ instanceof PDFRadioGroup) return 'RadioGroup'
  if (champ instanceof PDFDropdown) return 'Dropdown'
  if (champ instanceof PDFOptionList) return 'OptionList'
  if (champ instanceof PDFButton) return 'Button'
  if (champ instanceof PDFSignature) return 'Signature'
  return 'Autre'
}

function analyserFormulaire(
  lib: PdfLib,
  doc: PDFDocument,
): { total: number; byType: Record<string, number> } {
  try {
    const champs = doc.getForm().getFields()
    const byType: Record<string, number> = {}
    for (const champ of champs) {
      const type = typeDeChamp(lib, champ)
      byType[type] = (byType[type] ?? 0) + 1
    }
    return { total: champs.length, byType }
  } catch {
    // AcroForm malformé : pas de formulaire exploitable, pas une erreur fatale.
    return { total: 0, byType: {} }
  }
}

/* ------------------------------------------------------------------ */
/* Calques optionnels (OCG) et polices                                  */
/* ------------------------------------------------------------------ */

function listerCouchesOptionnelles(lib: PdfLib, doc: PDFDocument): string[] {
  const { PDFArray, PDFDict, PDFName } = lib
  const oc = doc.catalog.lookupMaybe(PDFName.of('OCProperties'), PDFDict)
  const ocgs = oc?.lookupMaybe(PDFName.of('OCGs'), PDFArray)
  if (!ocgs) return []
  const noms: string[] = []
  for (let i = 0; i < ocgs.size(); i++) {
    const groupe = ocgs.lookupMaybe(i, PDFDict)
    const nom = texteDe(lib, groupe?.get(PDFName.of('Name')))
    if (nom) noms.push(nom)
  }
  return noms
}

function ressourcesDeLaPage(lib: PdfLib, page: PDFPage): PDFDict | undefined {
  const { PDFDict, PDFName } = lib
  const direct = page.node.Resources()
  if (direct) return direct
  const herite = page.node.getInheritableAttribute(PDFName.of('Resources'))
  return herite instanceof PDFDict ? herite : undefined
}

function listerPolices(lib: PdfLib, doc: PDFDocument): { name: string; embedded: boolean }[] {
  const { PDFArray, PDFDict, PDFName } = lib
  const vues = new Set<string>()
  const sortie: { name: string; embedded: boolean }[] = []

  for (const page of doc.getPages()) {
    const fonts = ressourcesDeLaPage(lib, page)?.lookupMaybe(PDFName.of('Font'), PDFDict)
    if (!fonts) continue
    for (const cle of fonts.keys()) {
      const fontDict = fonts.lookupMaybe(cle, PDFDict)
      if (!fontDict) continue
      const baseFont = fontDict.lookupMaybe(PDFName.of('BaseFont'), PDFName)
      const nom = baseFont ? baseFont.decodeText() : cle.decodeText()
      if (vues.has(nom)) continue
      vues.add(nom)

      let descripteur = fontDict.lookupMaybe(PDFName.of('FontDescriptor'), PDFDict)
      if (!descripteur) {
        const descendants = fontDict.lookupMaybe(PDFName.of('DescendantFonts'), PDFArray)
        const premier = descendants?.lookupMaybe(0, PDFDict)
        descripteur = premier?.lookupMaybe(PDFName.of('FontDescriptor'), PDFDict)
      }
      const embedded =
        !!descripteur &&
        (descripteur.has(PDFName.of('FontFile')) ||
          descripteur.has(PDFName.of('FontFile2')) ||
          descripteur.has(PDFName.of('FontFile3')))
      sortie.push({ name: nom, embedded })
    }
  }

  return sortie
}

/* ------------------------------------------------------------------ */
/* Texte caché : rendu invisible et contenu hors CropBox                */
/* ------------------------------------------------------------------ */
//
// pdf.js a été essayé en premier ici (via `getTextContent`, comme ailleurs
// dans ce projet) et écarté après vérification : son extracteur de texte
// ignore silencieusement tout glyphe dont la position calculée tombe hors du
// rectangle de page (`compareWithLastPosition` dans son évaluateur,
// confirmé par test — un texte pointé loin hors page n'apparaît tout
// simplement jamais dans `items`). C'est exactement le contenu qu'un
// caviardage maladroit laisse traîner hors CropBox : l'outil qui doit le
// repérer ne peut donc pas s'appuyer sur pdf.js pour cette vérification
// précise. Cette section relit donc directement le flux de contenu et en
// interprète l'essentiel — matrices graphiques et texte, chaînes et
// tableaux ignorés pour leur contenu — pour calculer la position réelle de
// chaque opérateur de dessin de texte.

type Matrice = [number, number, number, number, number, number]
const IDENTITE: Matrice = [1, 0, 0, 1, 0, 0]

/** Compose deux matrices PDF (convention vecteur-ligne : v' = v·m1·m2). */
function composer(m1: Matrice, m2: Matrice): Matrice {
  return [
    m1[0] * m2[0] + m1[1] * m2[2],
    m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2],
    m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
    m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
  ]
}

interface Jeton {
  type: 'nombre' | 'operateur'
  valeur: string
}

/**
 * Tokenise un flux de contenu PDF a minima : les nombres et les noms
 * d'opérateurs sont conservés, chaînes / tableaux / noms de ressource / dictionnaires
 * inline sont simplement sautés (leur contenu ne sert pas à cette analyse).
 * Les images inline (`BI…ID`⟨octets bruts⟩`EI`) sont sautées en bloc : leurs
 * données binaires contiendraient sinon des octets pris à tort pour des
 * jetons.
 */
function tokeniser(contenu: string): Jeton[] {
  const jetons: Jeton[] = []
  let i = 0
  const n = contenu.length
  while (i < n) {
    const c = contenu[i]
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n' || c === '\f' || c === '\0') {
      i++
    } else if (c === '%') {
      while (i < n && contenu[i] !== '\n' && contenu[i] !== '\r') i++
    } else if (c === '(') {
      let profondeur = 1
      i++
      while (i < n && profondeur > 0) {
        if (contenu[i] === '\\') i += 2
        else {
          if (contenu[i] === '(') profondeur++
          else if (contenu[i] === ')') profondeur--
          i++
        }
      }
    } else if (c === '<' && contenu[i + 1] === '<') {
      let profondeur = 1
      i += 2
      while (i < n && profondeur > 0) {
        if (contenu[i] === '<' && contenu[i + 1] === '<') {
          profondeur++
          i += 2
        } else if (contenu[i] === '>' && contenu[i + 1] === '>') {
          profondeur--
          i += 2
        } else i++
      }
    } else if (c === '<') {
      i++
      while (i < n && contenu[i] !== '>') i++
      i++
    } else if (c === '[') {
      let profondeur = 1
      i++
      while (i < n && profondeur > 0) {
        if (contenu[i] === '[') profondeur++
        else if (contenu[i] === ']') profondeur--
        i++
      }
    } else if (c === '/') {
      i++
      while (i < n && !/[\s()<>[\]/%]/.test(contenu[i])) i++
    } else if (/[0-9+\-.]/.test(c)) {
      let debut = i
      i++
      while (i < n && /[0-9.eE+-]/.test(contenu[i])) i++
      jetons.push({ type: 'nombre', valeur: contenu.slice(debut, i) })
    } else if (/[A-Za-z'"*]/.test(c)) {
      let debut = i
      i++
      while (i < n && /[A-Za-z0-9'"*]/.test(contenu[i])) i++
      const mot = contenu.slice(debut, i)
      if (mot === 'BI') {
        // Image inline : ses données binaires suivent `ID` jusqu'à `EI`
        // (précédé d'un blanc), hors de toute syntaxe d'opérateur.
        const idAt = contenu.indexOf('ID', i)
        const finRecherche = idAt === -1 ? i : idAt + 2
        const eiAt = contenu.indexOf('EI', finRecherche)
        i = eiAt === -1 ? n : eiAt + 2
      } else {
        jetons.push({ type: 'operateur', valeur: mot })
      }
    } else {
      i++
    }
  }
  return jetons
}

interface AnalyseFlux {
  invisibleTextRuns: number
  outsideCropBoxItems: number
}

/**
 * Interprète le flux de contenu d'une page : suit les matrices graphique
 * (`cm`/`q`/`Q`) et texte (`Tm`/`Td`/`TD`/`T*`), le mode de rendu (`Tr`), et
 * compte les opérateurs de dessin de texte (`Tj`/`TJ`/`'`/`"`) dont le point
 * d'origine tombe en mode invisible ou hors de la CropBox de la page.
 */
function analyserFluxDeContenu(jetons: Jeton[], crop: { x: number; y: number; width: number; height: number }): AnalyseFlux {
  let invisibleTextRuns = 0
  let outsideCropBoxItems = 0

  const pile: Matrice[] = []
  let ctm: Matrice = IDENTITE
  let tm: Matrice = IDENTITE
  let modeRendu = 0
  const operandes: number[] = []

  const nombre = (indexDepuisLaFin: number): number => operandes[operandes.length - indexDepuisLaFin] ?? 0

  for (const jeton of jetons) {
    if (jeton.type === 'nombre') {
      operandes.push(Number(jeton.valeur))
      continue
    }

    switch (jeton.valeur) {
      case 'q':
        pile.push(ctm)
        break
      case 'Q':
        ctm = pile.pop() ?? IDENTITE
        break
      case 'cm':
        ctm = composer(
          [nombre(6), nombre(5), nombre(4), nombre(3), nombre(2), nombre(1)],
          ctm,
        )
        break
      case 'BT':
        tm = IDENTITE
        break
      case 'Tm':
        tm = [nombre(6), nombre(5), nombre(4), nombre(3), nombre(2), nombre(1)]
        break
      case 'Td':
      case 'TD':
        tm = composer([1, 0, 0, 1, nombre(2), nombre(1)], tm)
        break
      case 'T*':
        // Interligne (TL) non suivi : approximation à 0, sans effet sur la
        // détection (seule l'abscisse compte le plus souvent hors CropBox,
        // et une ligne qui en suit une autre hors cadre y reste aussi).
        break
      case 'Tr':
        modeRendu = Math.trunc(nombre(1))
        break
      case 'Tj':
      case "'":
      case '"':
      case 'TJ': {
        const [x, y] = [tm[4] * ctm[0] + tm[5] * ctm[2] + ctm[4], tm[4] * ctm[1] + tm[5] * ctm[3] + ctm[5]]
        if (modeRendu === 3 || modeRendu === 7) invisibleTextRuns++
        if (x < crop.x || x > crop.x + crop.width || y < crop.y || y > crop.y + crop.height) {
          outsideCropBoxItems++
        }
        break
      }
      default:
        break
    }
    operandes.length = 0
  }

  return { invisibleTextRuns, outsideCropBoxItems }
}

function decoderContenuPage(lib: PdfLib, doc: PDFDocument, page: PDFPage): string {
  const { PDFArray, PDFRawStream, PDFStream, decodePDFRawStream } = lib
  const contents = page.node.Contents()
  const morceaux: Uint8Array[] = []

  const ajouter = (obj: unknown) => {
    const stream =
      obj instanceof PDFStream ? obj : doc.context.lookupMaybe(obj as PDFRef, PDFStream)
    if (stream instanceof PDFRawStream) {
      try {
        morceaux.push(decodePDFRawStream(stream).decode())
      } catch {
        // Flux illisible (filtre non supporté, image mal formée) : ignoré.
      }
    }
  }

  if (contents instanceof PDFArray) {
    for (let i = 0; i < contents.size(); i++) ajouter(contents.get(i))
  } else if (contents) {
    ajouter(contents)
  }

  if (morceaux.length === 0) return ''
  const total = morceaux.reduce((n, m) => n + m.length + 1, 0)
  const fusion = new Uint8Array(total)
  let offset = 0
  for (const m of morceaux) {
    fusion.set(m, offset)
    offset += m.length
    fusion[offset] = 0x20
    offset++
  }
  // latin1 (iso-8859-1) : chaque octet devient un caractère, sans risque
  // d'exception sur des données binaires — on ne cherche qu'un motif ASCII
  // dans ce texte, la fidélité de décodage du reste importe peu.
  return new TextDecoder('iso-8859-1').decode(fusion)
}

function analyserTexteCache(lib: PdfLib, doc: PDFDocument): AnalyseFlux {
  let invisibleTextRuns = 0
  let outsideCropBoxItems = 0
  for (const page of doc.getPages()) {
    const contenu = decoderContenuPage(lib, doc, page)
    if (!contenu) continue
    const resultat = analyserFluxDeContenu(tokeniser(contenu), page.getCropBox())
    invisibleTextRuns += resultat.invisibleTextRuns
    outsideCropBoxItems += resultat.outsideCropBoxItems
  }
  return { invisibleTextRuns, outsideCropBoxItems }
}

/* ------------------------------------------------------------------ */
/* Assemblage du rapport                                                */
/* ------------------------------------------------------------------ */

export async function inspecterPdf(bytes: Uint8Array): Promise<InspectionReport> {
  if (looksEncrypted(bytes)) {
    return { ...RAPPORT_VIDE, metadata: { ...RAPPORT_VIDE.metadata } }
  }

  const lib = await chargerPdfLib()
  // `updateMetadata: false` : par défaut, pdf-lib inscrit à l'ouverture son
  // propre nom comme producteur et l'heure courante comme date de
  // modification — le rapport aurait affiché « pdf-lib » au lieu du vrai
  // logiciel, et l'heure du contrôle au lieu de celle du document.
  const doc = await lib.PDFDocument.load(bytes, { updateMetadata: false })
  const attachments = await listAttachments(bytes).catch(() => [])
  const hiddenText = analyserTexteCache(lib, doc)
  const { javascriptBlocks, autoActions } = compterAutomatisations(lib, doc)

  return {
    encrypted: false,
    limitedByEncryption: false,
    pageCount: doc.getPageCount(),
    pageSizes: doc.getPages().map((p) => p.getSize()),
    metadata: lireMetadonnees(doc),
    hasXmp: doc.catalog.has(lib.PDFName.of('Metadata')),
    javascriptBlocks,
    autoActions,
    externalLinks: listerLiensExternes(lib, doc),
    attachments,
    annotations: analyserAnnotations(lib, doc),
    formFields: analyserFormulaire(lib, doc),
    hiddenText,
    ocgLayers: listerCouchesOptionnelles(lib, doc),
    fonts: listerPolices(lib, doc),
  }
}
