/**
 * Généré depuis vellum-pdf/src/lib/accessibilite.ts — ne pas éditer ici.
 * Source de vérité : le dépôt privé vellum-pdf, via scripts/sync-engine.mjs.
 */

/**
 * Contrôle d'accessibilité d'un PDF : un rapport, jamais une correction.
 *
 * Ce module LIT un document et rend une liste de constats. Il n'écrit rien,
 * et surtout il ne prétend pas remplacer un validateur PDF/UA complet :
 * aucune bibliothèque JavaScript libre ne valide le PDF/UA en local
 * (veraPDF est en Java, Apryse est un produit commercial fermé), si bien que tout
 * ce qui suit est construit à la main sur pdf-lib et pdf.js. Le rapport dit
 * donc aussi ce qu'il ne vérifie pas — c'est la partie la plus importante.
 *
 * Références réellement consultées le 17.09.2026 :
 *  - Règles de validation PDF/UA-1 de veraPDF (profil officiel, chaque règle
 *    porte sa clause ISO 14289-1) :
 *    https://raw.githubusercontent.com/veraPDF/veraPDF-validation-profiles/integration/PDF_UA/PDFUA-1.xml
 *    → 6.2 « MarkInfo … Marked … true », 7.1 « StructTreeRoot »,
 *      7.1 « ViewerPreferences … DisplayDocTitle … true », 7.1 « dc:title »,
 *      7.2 « Lang … Language-Tag », 7.3 « Figure … alternative representation ».
 *  - WCAG 2.1, critère 1.4.3 « Contrast (Minimum) », niveau AA : 4,5:1 pour
 *    le texte courant, 3:1 pour le grand texte ; définition du rapport de
 *    contraste (L1 + 0,05) / (L2 + 0,05) :
 *    https://www.w3.org/TR/WCAG21/#contrast-minimum
 *  - Indicateur de permission « extraction pour l'accessibilité » = 0x200
 *    (bit 10 de /P), d'après la table 22, section 7.6.3.2 de la spécification
 *    PDF, telle que reprise par pdf.js :
 *    https://raw.githubusercontent.com/mozilla/pdf.js/master/src/shared/util.js
 */
import type { PDFDict, PDFDocument, PDFObject } from 'pdf-lib'
// Extensions .ts explicites, comme dans pdf.ts : ce module est chargé
// directement par Node dans le harnais de test (l'ESM natif ne résout pas les
// spécificateurs relatifs sans extension, contrairement à Vite).
// Chargement différé de pdf-lib, au premier usage réel (voir bibliotheques.ts).
import { chargerPdfLib } from './bibliotheques.ts'
import { closePdfJsDoc, loadPdf, openPdfJsDoc, renderPageToCanvas } from './pdf.ts'
import { looksEncrypted } from './qpdf.ts'

/** Le module pdf-lib une fois chargé (voir `chargerPdfLib`). */
type PdfLib = Awaited<ReturnType<typeof chargerPdfLib>>

/* ------------------------------------------------------------------ */
/* Types du rapport                                                     */
/* ------------------------------------------------------------------ */

/**
 * `bloquant` est réservé à ce qui prive réellement un lecteur d'écran du
 * contenu (page image sans texte, document non balisé, extraction interdite).
 * Tout le reste qui ne va pas est `a-ameliorer` : le document se lit, mal.
 */
export type EtatPoint = 'conforme' | 'a-ameliorer' | 'bloquant' | 'non-verifie'

export type PointId =
  | 'titre'
  | 'langue'
  | 'texte'
  | 'balisage'
  | 'alternatives'
  | 'titres'
  | 'signets'
  | 'formulaire'
  | 'contraste'
  | 'pdfua'
  | 'permissions'

interface Base<I extends PointId, D> {
  id: I
  etat: EtatPoint
  /** Slug de l'outil VellumPDF qui corrige ce point, quand il en existe un. */
  outil?: string
  donnees: D
}

export type PointAccessibilite =
  | Base<'titre', { titreInfo: string; titreXmp: string; afficherLeTitre: boolean }>
  | Base<'langue', { code: string; valide: boolean }>
  | Base<'texte', { pages: number; pagesSansTexte: number[]; pagesImageSeule: number[] }>
  | Base<'balisage', { marked: boolean; structTreeRoot: boolean }>
  | Base<'alternatives', { figures: number; avecAlt: number; sansAlt: number }>
  | Base<'titres', { total: number; parNiveau: Record<string, number> }>
  | Base<'signets', { pages: number; signets: number; attendu: boolean }>
  | Base<'formulaire', { champs: number; avecInfobulle: number }>
  | Base<'contraste', { pagesAnalysees: number; pagesSousLeSeuil: number[]; ratioMinimal: number | null; raison: RaisonContraste }>
  | Base<'pdfua', { part: string }>
  | Base<'permissions', { chiffre: boolean; extractionAccessibilite: boolean | null }>

/** Pourquoi l'estimation de contraste n'a pas pu aboutir, quand c'est le cas. */
export type RaisonContraste = 'ok' | 'sans-rendu' | 'sans-fond-dominant' | 'echec'

export interface RapportAccessibilite {
  pages: number
  /** Vrai quand le chiffrement empêche de lire la structure du document. */
  limiteParChiffrement: boolean
  points: PointAccessibilite[]
  resume: Record<EtatPoint, number>
}

/**
 * Rendu d'une page en pixels. Injectable : le harnais Node de test remplace
 * le canvas du navigateur par un canvas serveur, comme le fait déjà
 * scripts/validate-pdfa.mjs pour la rastérisation PDF/A.
 */
export type RendrePixels = (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pdfjsDoc: any,
  pageIndex: number,
  echelle: number,
) => Promise<{ data: Uint8ClampedArray; width: number; height: number }>

export interface OptionsControle {
  onProgress?: (fait: number, total: number) => void
  /** Voir `RendrePixels` : hors navigateur, le contraste reste « non vérifié ». */
  rendrePixels?: RendrePixels
  /** Ouverture pdf.js de remplacement, pour le même harnais Node. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ouvrirPdfJs?: (bytes: Uint8Array) => Promise<any>
}

/* ------------------------------------------------------------------ */
/* Constantes de mesure                                                 */
/* ------------------------------------------------------------------ */

/** Seuil WCAG 2.1 pour le texte courant (critère 1.4.3, niveau AA). */
export const SEUIL_CONTRASTE = 4.5
/** Au-delà, un document se parcourt mal sans signets. Seuil de confort, pas une norme. */
const PAGES_SANS_SIGNETS = 20
/** Le contraste est estimé sur les premières pages seulement : c'est l'étape coûteuse. */
const PAGES_CONTRASTE_MAX = 10
/**
 * Côté le plus long du rendu servant à l'estimation de contraste, en pixels.
 *
 * Mesuré plutôt que deviné : à 420 px (≈ 36 dpi sur une A4), le cœur des
 * glyphes disparaît sous le lissage et l'estimation devient faussement
 * alarmiste — du texte noir de 8 points ressortait à 4,3:1 et un gris foncé
 * réel de 7:1 à 3,5:1. À 1200 px (≈ 103 dpi), les mêmes pages donnent 20,3:1
 * et 6,9:1. Le coût reste raisonnable : dix pages au plus (PAGES_CONTRASTE_MAX).
 */
const COTE_CONTRASTE = 1200
/** Nombre de caractères en deçà duquel une page est considérée sans texte réel. */
const MIN_CARACTERES_PAGE = 12
/** Garde-fou contre un arbre de structure cyclique ou démesuré. */
const NOEUDS_MAX = 20000

/* ------------------------------------------------------------------ */
/* Lectures pdf-lib : catalogue, XMP, structure                         */
/* ------------------------------------------------------------------ */

function texteDe(lib: PdfLib, obj: unknown): string {
  const { PDFHexString, PDFString } = lib
  if (obj instanceof PDFString || obj instanceof PDFHexString) return obj.decodeText()
  return ''
}

/** Contenu du paquet XMP du catalogue, décompressé, ou chaîne vide. */
function lireXmp(lib: PdfLib, doc: PDFDocument): string {
  const { PDFName, PDFRawStream, decodePDFRawStream } = lib
  const flux = doc.catalog.lookup(PDFName.of('Metadata'))
  if (!(flux instanceof PDFRawStream)) return ''
  try {
    return new TextDecoder('utf-8').decode(decodePDFRawStream(flux).decode())
  } catch {
    // Filtre exotique ou paquet tronqué : le XMP est simplement absent du rapport.
    return ''
  }
}

/** `dc:title`, que le XMP l'écrive en `rdf:Alt` (le cas courant) ou en clair. */
function titreXmp(xmp: string): string {
  const alt = xmp.match(/<dc:title>[\s\S]*?<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>/)
  if (alt) return alt[1].trim()
  const direct = xmp.match(/<dc:title>([^<]*)<\/dc:title>/)
  return direct ? direct[1].trim() : ''
}

/** `pdfuaid:part`, en attribut comme en élément — les deux formes existent. */
function partPdfUa(xmp: string): string {
  const attribut = xmp.match(/pdfuaid:part\s*=\s*"(\d+)"/)
  if (attribut) return attribut[1]
  const element = xmp.match(/<pdfuaid:part>\s*(\d+)\s*<\/pdfuaid:part>/)
  return element ? element[1] : ''
}

/**
 * Un identifiant de langue au sens de la clause 7.2 de PDF/UA-1 : une
 * étiquette de langue (BCP 47 ; ISO 32000-1 renvoie encore à la RFC 3066).
 * La vérification reste syntaxique — « zz-ZZ » passe, aucun registre n'est
 * embarqué dans le navigateur pour le contredire.
 */
function langueValide(code: string): boolean {
  return /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/.test(code)
}

interface Structure {
  figures: number
  figuresAvecAlt: number
  titresParNiveau: Record<string, number>
}

/**
 * Parcourt l'arbre de structure logique et compte ce qui s'y lit sans
 * ambiguïté : les éléments /Figure et leur /Alt, les titres /H1…/H6.
 *
 * Limites assumées de pdf-lib ici : un /K numérique est un identifiant de
 * contenu marqué (MCID) et non un enfant, un /K dictionnaire peut être un
 * simple renvoi (/MCR, /OBJR) sans type de structure — les deux sont sautés.
 * L'arbre des parents (/ParentTree) n'est pas suivi : il relie le contenu de
 * page à sa structure, pas l'inverse, et ne sert donc pas à ce comptage.
 */
function lireStructure(lib: PdfLib, racine: PDFDict): Structure {
  const { PDFArray, PDFDict, PDFName } = lib
  const roleMap = racine.lookupMaybe(PDFName.of('RoleMap'), PDFDict)
  const resoudreRole = (type: string): string => {
    let courant = type
    // Un RoleMap peut chaîner (MonTitre → Heading → H1) ; trois sauts suffisent.
    for (let i = 0; i < 3 && roleMap; i++) {
      const cible = roleMap.lookupMaybe(PDFName.of(courant), PDFName)
      if (!cible) break
      courant = cible.decodeText()
    }
    return courant
  }

  const out: Structure = { figures: 0, figuresAvecAlt: 0, titresParNiveau: {} }
  const vus = new Set<PDFDict>()
  const pile: (PDFObject | undefined)[] = [racine.get(PDFName.of('K'))]
  let visites = 0

  while (pile.length > 0 && visites < NOEUDS_MAX) {
    const brut = pile.pop()
    if (brut === undefined) continue
    const noeud = racine.context.lookup(brut)
    visites++

    if (noeud instanceof PDFArray) {
      for (let i = noeud.size() - 1; i >= 0; i--) pile.push(noeud.get(i))
      continue
    }
    if (!(noeud instanceof PDFDict) || vus.has(noeud)) continue
    vus.add(noeud)

    const s = noeud.lookupMaybe(PDFName.of('S'), PDFName)
    if (s) {
      const type = resoudreRole(s.decodeText())
      if (type === 'Figure') {
        out.figures++
        const alt = texteDe(lib, noeud.lookup(PDFName.of('Alt')))
        const actuel = texteDe(lib, noeud.lookup(PDFName.of('ActualText')))
        if (alt.trim() || actuel.trim()) out.figuresAvecAlt++
      } else if (/^H[1-6]$/.test(type)) {
        out.titresParNiveau[type] = (out.titresParNiveau[type] ?? 0) + 1
      } else if (type === 'H') {
        out.titresParNiveau.H = (out.titresParNiveau.H ?? 0) + 1
      }
    }
    if (noeud.has(PDFName.of('K'))) pile.push(noeud.get(PDFName.of('K')))
  }

  return out
}

/** Nombre total d'entrées de signets, arbre parcouru en largeur avec garde-fou. */
function compterSignets(lib: PdfLib, doc: PDFDocument): number {
  const { PDFDict, PDFName } = lib
  const racine = doc.catalog.lookupMaybe(PDFName.of('Outlines'), PDFDict)
  if (!racine) return 0
  let total = 0
  const vus = new Set<PDFDict>()
  const pile: (PDFObject | undefined)[] = [racine.get(PDFName.of('First'))]
  while (pile.length > 0 && total < NOEUDS_MAX) {
    const entree = doc.context.lookup(pile.pop())
    if (!(entree instanceof PDFDict) || vus.has(entree)) continue
    vus.add(entree)
    total++
    pile.push(entree.get(PDFName.of('Next')))
    pile.push(entree.get(PDFName.of('First')))
  }
  return total
}

/** Champs terminaux du formulaire et nombre d'entre eux portant une info-bulle (/TU). */
function lireChamps(lib: PdfLib, doc: PDFDocument): { champs: number; avecInfobulle: number } {
  const { PDFArray, PDFDict, PDFName } = lib
  const acro = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict)
  const racine = acro?.lookupMaybe(PDFName.of('Fields'), PDFArray)
  if (!racine) return { champs: 0, avecInfobulle: 0 }

  let champs = 0
  let avecInfobulle = 0
  const vus = new Set<PDFDict>()
  const pile: (PDFObject | undefined)[] = []
  for (let i = 0; i < racine.size(); i++) pile.push(racine.get(i))

  while (pile.length > 0 && vus.size < NOEUDS_MAX) {
    const noeud = doc.context.lookup(pile.pop())
    if (!(noeud instanceof PDFDict) || vus.has(noeud)) continue
    vus.add(noeud)

    const kids = noeud.lookupMaybe(PDFName.of('Kids'), PDFArray)
    // Un nœud avec des enfants nommés est un regroupement, pas un champ ;
    // un nœud avec /FT et sans /Kids est le champ que l'utilisateur remplit.
    if (kids && kids.size() > 0) {
      for (let i = 0; i < kids.size(); i++) pile.push(kids.get(i))
      continue
    }
    if (!noeud.has(PDFName.of('FT'))) continue
    champs++
    if (texteDe(lib, noeud.lookup(PDFName.of('TU'))).trim()) avecInfobulle++
  }

  return { champs, avecInfobulle }
}

/**
 * Pages portant au moins une image en ressource (indice de page scannée).
 *
 * Piège pdf-lib payé une fois : un XObject d'image est un `PDFRawStream`, pas
 * un `PDFDict` — `lookupMaybe(clé, PDFDict)` lève alors une exception au lieu
 * de rendre `undefined`. Le type de l'objet se lit donc dans le dictionnaire
 * porté par le flux.
 */
function pagesAvecImage(lib: PdfLib, doc: PDFDocument): Set<number> {
  const { PDFDict, PDFName, PDFStream } = lib
  const out = new Set<number>()
  doc.getPages().forEach((page, index) => {
    try {
      const ressources =
        page.node.Resources() ??
        (page.node.getInheritableAttribute(PDFName.of('Resources')) as PDFDict | undefined)
      const xobjets =
        ressources instanceof PDFDict ? ressources.lookupMaybe(PDFName.of('XObject'), PDFDict) : undefined
      if (!xobjets) return
      for (const cle of xobjets.keys()) {
        const objet = xobjets.lookup(cle)
        const dict =
          objet instanceof PDFStream ? objet.dict : objet instanceof PDFDict ? objet : undefined
        if (dict?.lookupMaybe(PDFName.of('Subtype'), PDFName)?.decodeText() === 'Image') {
          out.add(index)
          return
        }
      }
    } catch {
      // Ressources malformées : l'absence d'image constatée reste sans effet
      // sur les autres pages, et la page est simplement dite sans image.
    }
  })
  return out
}

/* ------------------------------------------------------------------ */
/* Contraste : estimation, et rien de plus                              */
/* ------------------------------------------------------------------ */

/** Luminance relative sRGB, telle que définie par WCAG 2.1. */
function luminance(r: number, g: number, b: number): number {
  const lineaire = (c: number) => {
    const cs = c / 255
    return cs <= 0.03928 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * lineaire(r) + 0.7152 * lineaire(g) + 0.0722 * lineaire(b)
}

/** Rapport de contraste WCAG : (L1 + 0,05) / (L2 + 0,05), le plus clair en haut. */
export function rapportDeContraste(a: [number, number, number], b: [number, number, number]): number {
  const la = luminance(a[0], a[1], a[2])
  const lb = luminance(b[0], b[1], b[2])
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** Distance d'un point au segment [a, b] dans l'espace RVB, en unités 0-255. */
function distanceAuSegment(
  p: [number, number, number],
  a: [number, number, number],
  b: [number, number, number],
): number {
  const ab: [number, number, number] = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
  const ap: [number, number, number] = [p[0] - a[0], p[1] - a[1], p[2] - a[2]]
  const carre = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2]
  const t = carre === 0 ? 0 : Math.min(1, Math.max(0, (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / carre))
  const d: [number, number, number] = [ap[0] - t * ab[0], ap[1] - t * ab[1], ap[2] - t * ab[2]]
  return Math.sqrt(d[0] * d[0] + d[1] * d[1] + d[2] * d[2])
}

/** Part minimale des pixels qu'une couleur doit occuper pour être prise au sérieux. */
const PART_MINIMALE = 0.0005
/** Part des pixels qu'une couleur doit atteindre pour passer pour le fond de page. */
const PART_FOND = 0.3
/** Écart RVB en deçà duquel une couleur est tenue pour du lissage de bord. */
const ECART_LISSAGE = 34
/**
 * Un halo de lissage ne peut pas peupler beaucoup plus de pixels que l'encre
 * qu'il borde. Mesuré à 1200 px sur des pages de test : le halo d'un texte
 * noir de 12 points plafonne à 0,31 fois le cœur des glyphes, et le halo le
 * plus chargé d'un texte gris à 1,06 fois. Le facteur 2 sépare donc les deux
 * cas sans ambiguïté — et c'est lui qui empêche un corps de texte gris clair
 * d'être pris pour le lissage d'un titre noir présent sur la même page.
 */
const FACTEUR_LISSAGE = 2

export interface EstimationContraste {
  ratioMinimal: number | null
  raison: RaisonContraste
}

/**
 * Estime le contraste d'une page rastérisée, et seulement cela.
 *
 * Méthode, volontairement simple et vérifiable : les couleurs sont
 * regroupées par paliers de 16 niveaux par canal ; la couleur la plus
 * fréquente sert de fond (encore faut-il qu'elle couvre une bonne part de la
 * page) ; chaque autre couleur suffisamment présente est une couleur d'encre
 * candidate, et le rapport WCAG est calculé entre elle et le fond. Les
 * couleurs situées sur le trajet entre le fond et une encre plus contrastée,
 * ET nettement moins peuplées qu'elle, sont écartées : ce sont les pixels de
 * lissage des bords de lettres, qui feraient sinon échouer toutes les pages.
 *
 * Ce que cette estimation ne voit pas : la taille des caractères (WCAG
 * autorise 3:1 au-delà de 18 points), un texte posé sur une photographie,
 * un texte blanc sur aplat coloré occupant plus de place que le fond réel,
 * et une ligne isolée de gris clair noyée dans un long texte noir de la même
 * teinte — trop peu peuplée pour se distinguer d'un halo.
 */
export function estimerContrastePage(
  data: Uint8ClampedArray,
  largeur: number,
  hauteur: number,
): EstimationContraste {
  const total = largeur * hauteur
  if (total === 0) return { ratioMinimal: null, raison: 'echec' }

  const compte = new Map<number, { n: number; r: number; g: number; b: number }>()
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i]
    const g = data[i + 1]
    const b = data[i + 2]
    const cle = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4)
    const entree = compte.get(cle)
    if (entree) {
      entree.n++
      entree.r += r
      entree.g += g
      entree.b += b
    } else {
      compte.set(cle, { n: 1, r, g, b })
    }
  }

  const couleurs = [...compte.values()]
    .map((e) => ({ n: e.n, rgb: [e.r / e.n, e.g / e.n, e.b / e.n] as [number, number, number] }))
    .sort((x, y) => y.n - x.n)

  const fond = couleurs[0]
  if (!fond || fond.n / total < PART_FOND) return { ratioMinimal: null, raison: 'sans-fond-dominant' }

  const seuilPixels = Math.max(20, Math.round(total * PART_MINIMALE))
  const encres = couleurs
    .slice(1)
    .filter((c) => c.n >= seuilPixels)
    .map((c) => ({ rgb: c.rgb, n: c.n, ratio: rapportDeContraste(c.rgb, fond.rgb) }))
    .sort((x, y) => y.ratio - x.ratio)

  const retenues = encres.filter(
    (candidate, i) =>
      // Une encre plus contrastée située « derrière » la candidate sur le
      // trajet depuis le fond explique la candidate par le lissage — à
      // condition que la candidate ne soit pas bien plus peuplée qu'elle,
      // auquel cas c'est une vraie couleur de texte (voir FACTEUR_LISSAGE).
      !encres.some(
        (autre, j) =>
          j < i &&
          candidate.n < autre.n * FACTEUR_LISSAGE &&
          distanceAuSegment(candidate.rgb, fond.rgb, autre.rgb) < ECART_LISSAGE,
      ),
  )

  if (retenues.length === 0) return { ratioMinimal: null, raison: 'echec' }
  return { ratioMinimal: Math.min(...retenues.map((c) => c.ratio)), raison: 'ok' }
}

const rendrePixelsDom: RendrePixels = async (pdfjsDoc, pageIndex, echelle) => {
  const { canvas } = await renderPageToCanvas(pdfjsDoc, pageIndex, echelle, {
    // Fond blanc opaque : sans lui, tout ce que la page ne peint pas reste
    // transparent, et la couleur de fond dominante serait noire.
    preRender: (c, ctx) => {
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, c.width, c.height)
    },
  })
  const ctx = canvas.getContext('2d')!
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height)
  return { data: image.data, width: canvas.width, height: canvas.height }
}

/* ------------------------------------------------------------------ */
/* Assemblage du rapport                                                */
/* ------------------------------------------------------------------ */

/** Table 22, section 7.6.3.2 de la spécification PDF : extraction pour l'accessibilité. */
const PERMISSION_EXTRACTION_ACCESSIBILITE = 0x200

function etatDepuis(conforme: boolean): EtatPoint {
  return conforme ? 'conforme' : 'a-ameliorer'
}

export async function controlerAccessibilite(
  bytes: Uint8Array,
  options: OptionsControle = {},
): Promise<RapportAccessibilite> {
  const { onProgress, rendrePixels, ouvrirPdfJs } = options
  const chiffre = looksEncrypted(bytes)

  // pdf-lib ne déchiffre rien : sur un document protégé, toute la structure
  // reste hors de portée et les points correspondants sont dits « non
  // vérifiés » plutôt que déclarés conformes par défaut.
  let lib: PdfLib | null = null
  let doc: PDFDocument | null = null
  if (!chiffre) {
    lib = await chargerPdfLib()
    doc = await loadPdf(bytes)
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let pdfjsDoc: any = null
  try {
    pdfjsDoc = await (ouvrirPdfJs ?? openPdfJsDoc)(bytes)
  } catch {
    // Mot de passe d'ouverture requis, ou fichier illisible par pdf.js :
    // le texte, le contraste et les permissions resteront non vérifiés.
    pdfjsDoc = null
  }

  const pages = doc?.getPageCount() ?? pdfjsDoc?.numPages ?? 0
  const points: PointAccessibilite[] = []

  try {
    const xmp = lib && doc ? lireXmp(lib, doc) : ''

    /* 1. Titre du document et affichage du titre --------------------- */
    if (lib && doc) {
      const { PDFBool, PDFDict, PDFName } = lib
      const vp = doc.catalog.lookupMaybe(PDFName.of('ViewerPreferences'), PDFDict)
      const ddt = vp?.lookupMaybe(PDFName.of('DisplayDocTitle'), PDFBool)
      // La valeur par défaut de DisplayDocTitle est « false » : son absence
      // équivaut à une barre de titre qui affiche le nom de fichier.
      const afficherLeTitre = ddt?.asBoolean() ?? false
      const titreInfo = (doc.getTitle() ?? '').trim()
      const xmpTitre = titreXmp(xmp)
      const titreConforme = Boolean(titreInfo || xmpTitre) && afficherLeTitre
      points.push({
        id: 'titre',
        etat: etatDepuis(titreConforme),
        // L'outil Métadonnées écrit le titre /Info et /DisplayDocTitle :
        // il corrige les deux moitiés de ce point.
        outil: titreConforme ? undefined : 'metadonnees',
        donnees: { titreInfo, titreXmp: xmpTitre, afficherLeTitre },
      })
    } else {
      points.push({
        id: 'titre',
        etat: 'non-verifie',
        donnees: { titreInfo: '', titreXmp: '', afficherLeTitre: false },
      })
    }

    /* 2. Langue déclarée --------------------------------------------- */
    if (lib && doc) {
      const code = texteDe(lib, doc.catalog.lookup(lib.PDFName.of('Lang'))).trim()
      const langueConforme = Boolean(code) && langueValide(code)
      points.push({
        id: 'langue',
        etat: etatDepuis(langueConforme),
        // Depuis le 18.09.2026, l'outil Métadonnées écrit /Lang.
        outil: langueConforme ? undefined : 'metadonnees',
        donnees: { code, valide: langueValide(code) },
      })
    } else {
      points.push({ id: 'langue', etat: 'non-verifie', donnees: { code: '', valide: false } })
    }

    /* 3. Texte réel ou image scannée ---------------------------------- */
    const pagesSansTexte: number[] = []
    if (pdfjsDoc) {
      for (let i = 0; i < pdfjsDoc.numPages; i++) {
        onProgress?.(i + 1, pdfjsDoc.numPages)
        const page = await pdfjsDoc.getPage(i + 1)
        const contenu = await page.getTextContent()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const texte = contenu.items.map((it: any) => (typeof it.str === 'string' ? it.str : '')).join('')
        if (texte.replace(/\s/g, '').length < MIN_CARACTERES_PAGE) pagesSansTexte.push(i)
      }
    }
    const avecImage = lib && doc ? pagesAvecImage(lib, doc) : null
    // Une page sans texte ET sans image est une page blanche : elle ne prive
    // personne de rien, elle ne compte donc pas comme un scan.
    const pagesImageSeule = avecImage
      ? pagesSansTexte.filter((i) => avecImage.has(i))
      : pagesSansTexte
    points.push({
      id: 'texte',
      etat: pdfjsDoc ? (pagesImageSeule.length > 0 ? 'bloquant' : 'conforme') : 'non-verifie',
      outil: pagesImageSeule.length > 0 ? 'ocr' : undefined,
      donnees: {
        pages,
        pagesSansTexte: pagesSansTexte.map((i) => i + 1),
        pagesImageSeule: pagesImageSeule.map((i) => i + 1),
      },
    })

    /* 4. Document balisé ---------------------------------------------- */
    let structTreeRoot: PDFDict | undefined
    if (lib && doc) {
      const { PDFBool, PDFDict, PDFName } = lib
      const markInfo = doc.catalog.lookupMaybe(PDFName.of('MarkInfo'), PDFDict)
      const marked = markInfo?.lookupMaybe(PDFName.of('Marked'), PDFBool)?.asBoolean() ?? false
      structTreeRoot = doc.catalog.lookupMaybe(PDFName.of('StructTreeRoot'), PDFDict)
      points.push({
        id: 'balisage',
        etat: marked && structTreeRoot ? 'conforme' : 'bloquant',
        donnees: { marked, structTreeRoot: Boolean(structTreeRoot) },
      })
    } else {
      points.push({ id: 'balisage', etat: 'non-verifie', donnees: { marked: false, structTreeRoot: false } })
    }

    /* 5 et 6. Images avec texte de remplacement, titres hiérarchisés --- */
    const structure = lib && structTreeRoot ? lireStructure(lib, structTreeRoot) : null
    points.push(
      structure
        ? {
            id: 'alternatives',
            etat: structure.figures === 0 ? 'conforme' : etatDepuis(structure.figuresAvecAlt === structure.figures),
            donnees: {
              figures: structure.figures,
              avecAlt: structure.figuresAvecAlt,
              sansAlt: structure.figures - structure.figuresAvecAlt,
            },
          }
        : { id: 'alternatives', etat: 'non-verifie', donnees: { figures: 0, avecAlt: 0, sansAlt: 0 } },
    )

    const totalTitres = structure
      ? Object.values(structure.titresParNiveau).reduce((n, v) => n + v, 0)
      : 0
    points.push(
      structure
        ? {
            id: 'titres',
            etat: etatDepuis(totalTitres > 0),
            donnees: { total: totalTitres, parNiveau: structure.titresParNiveau },
          }
        : { id: 'titres', etat: 'non-verifie', donnees: { total: 0, parNiveau: {} } },
    )

    const signets = lib && doc ? compterSignets(lib, doc) : 0
    const attenduSignets = pages > PAGES_SANS_SIGNETS
    points.push({
      id: 'signets',
      etat: lib && doc ? etatDepuis(!attenduSignets || signets > 0) : 'non-verifie',
      outil: lib && doc && attenduSignets && signets === 0 ? 'signets' : undefined,
      donnees: { pages, signets, attendu: attenduSignets },
    })

    /* 7. Champs de formulaire avec info-bulle -------------------------- */
    const champs = lib && doc ? lireChamps(lib, doc) : null
    points.push(
      champs
        ? {
            id: 'formulaire',
            etat: champs.champs === 0 ? 'conforme' : etatDepuis(champs.avecInfobulle === champs.champs),
            donnees: champs,
          }
        : { id: 'formulaire', etat: 'non-verifie', donnees: { champs: 0, avecInfobulle: 0 } },
    )

    /* 8. Contraste ----------------------------------------------------- */
    points.push(await controlerContraste(pdfjsDoc, rendrePixels))

    /* 9. Identifiant PDF/UA -------------------------------------------- */
    const part = partPdfUa(xmp)
    points.push({
      id: 'pdfua',
      etat: part ? 'conforme' : 'non-verifie',
      donnees: { part },
    })

    /* 10. Chiffrement et permissions ------------------------------------ */
    let extraction: boolean | null = null
    if (pdfjsDoc) {
      try {
        const permissions: number[] | null = await pdfjsDoc.getPermissions()
        extraction = permissions === null ? true : permissions.includes(PERMISSION_EXTRACTION_ACCESSIBILITE)
      } catch {
        extraction = null
      }
    }
    points.push({
      id: 'permissions',
      etat: extraction === null ? 'non-verifie' : extraction ? 'conforme' : 'bloquant',
      outil: extraction === false ? 'deverrouiller' : undefined,
      donnees: { chiffre, extractionAccessibilite: extraction },
    })
  } finally {
    if (pdfjsDoc) await closePdfJsDoc(pdfjsDoc).catch(() => undefined)
  }

  const resume: Record<EtatPoint, number> = {
    conforme: 0,
    'a-ameliorer': 0,
    bloquant: 0,
    'non-verifie': 0,
  }
  for (const point of points) resume[point.etat]++

  return { pages, limiteParChiffrement: chiffre, points, resume }
}

async function controlerContraste(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pdfjsDoc: any,
  rendrePixels?: RendrePixels,
): Promise<PointAccessibilite> {
  const rendre = rendrePixels ?? rendrePixelsDom
  if (!pdfjsDoc || !rendre) {
    return {
      id: 'contraste',
      etat: 'non-verifie',
      donnees: { pagesAnalysees: 0, pagesSousLeSeuil: [], ratioMinimal: null, raison: 'sans-rendu' },
    }
  }

  const aAnalyser = Math.min(pdfjsDoc.numPages, PAGES_CONTRASTE_MAX)
  const pagesSousLeSeuil: number[] = []
  let ratioMinimal: number | null = null
  let pagesAnalysees = 0
  let derniereRaison: RaisonContraste = 'echec'

  for (let i = 0; i < aAnalyser; i++) {
    try {
      const page = await pdfjsDoc.getPage(i + 1)
      const base = page.getViewport({ scale: 1 })
      const echelle = COTE_CONTRASTE / Math.max(base.width, base.height)
      const { data, width, height } = await rendre(pdfjsDoc, i, echelle)
      const estimation = estimerContrastePage(data, width, height)
      derniereRaison = estimation.raison
      if (estimation.ratioMinimal === null) continue
      pagesAnalysees++
      ratioMinimal = ratioMinimal === null ? estimation.ratioMinimal : Math.min(ratioMinimal, estimation.ratioMinimal)
      if (estimation.ratioMinimal < SEUIL_CONTRASTE) pagesSousLeSeuil.push(i + 1)
    } catch {
      // Une page qui refuse de se rendre ne condamne pas l'estimation des autres.
      derniereRaison = 'echec'
    }
  }

  return {
    id: 'contraste',
    etat: pagesAnalysees === 0 ? 'non-verifie' : etatDepuis(pagesSousLeSeuil.length === 0),
    donnees: {
      pagesAnalysees,
      pagesSousLeSeuil,
      ratioMinimal,
      raison: pagesAnalysees === 0 ? derniereRaison : 'ok',
    },
  }
}
