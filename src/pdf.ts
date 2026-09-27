/**
 * Généré depuis vellum-pdf/src/lib/pdf.ts — ne pas éditer ici.
 * Source de vérité : le dépôt privé vellum-pdf, via scripts/sync-engine.mjs.
 */

import type { PDFDocument } from 'pdf-lib'
import { createCanvas, type Canvas as NodeCanvas, type SKRSContext2D } from '@napi-rs/canvas'
import { fileURLToPath } from 'node:url'
// Extensions .ts explicites : Node (résolution NodeNext) les exige pour les
// imports relatifs ; tsc les réécrit en .js à la compilation
// (rewriteRelativeImportExtensions, voir tsconfig.json).
import type { Lang } from './shims/i18n.ts'
import { looksEncrypted } from './qpdf.ts'
// Chargement différé de pdf-lib : voir bibliotheques.ts.
import { chargerPdfLib } from './bibliotheques.ts'

export type { PDFDocument }

/**
 * Charge un PDF avec pdf-lib.
 *
 * Les documents chiffrés sont refusés d'emblée : pdf-lib ne déchiffre
 * jamais les flux de contenu, si bien qu'avec `ignoreEncryption` un PDF
 * protégé — même simplement restreint, ouverture libre — serait relu puis
 * sauvegardé avec des pages vides, sans la moindre erreur. Le message
 * contient « encrypted » : c'est le motif que testent les outils pour
 * proposer le déverrouillage. Le second filet est pdf-lib lui-même, dont
 * l'erreur native contient aussi ce mot si l'heuristique passe à côté.
 */
export async function loadPdf(bytes: Uint8Array): Promise<PDFDocument> {
  if (looksEncrypted(bytes)) {
    throw new Error('PDF_ENCRYPTED: document chiffré (encrypted)')
  }
  const { PDFDocument } = await chargerPdfLib()
  return PDFDocument.load(bytes)
}

/** Sauvegarde un PDFDocument pdf-lib en octets. */
export async function savePdf(doc: PDFDocument): Promise<Uint8Array> {
  return doc.save({ useObjectStreams: true })
}

/** Nom de fichier sans extension. */
export function baseName(filename: string): string {
  return filename.replace(/\.[^.]+$/, '')
}

/** Unités de taille par langue : « o / Ko / Mo » n'existe qu'en français. */
const UNITES_TAILLE: Record<Lang, [string, string, string]> = {
  fr: ['o', 'Ko', 'Mo'],
  de: ['B', 'KB', 'MB'],
  it: ['B', 'KB', 'MB'],
  en: ['B', 'KB', 'MB'],
  es: ['B', 'KB', 'MB'],
  pt: ['B', 'KB', 'MB'],
}

/**
 * Taille lisible, dans la langue de l'URL courante.
 *
 * La langue est déduite du chemin plutôt que passée en paramètre : cette
 * fonction est appelée depuis une cinquantaine d'endroits, et une page qui
 * oublierait de la transmettre réafficherait des octets français au milieu
 * d'une interface anglaise — exactement le défaut que ceci corrige.
 */
export function formatBytes(n: number, lang?: Lang): string {
  // Sous Node il n'y a pas d'URL de page courante : sans langue explicite,
  // le français (comportement déjà observé côté navigateur hors page connue).
  const langue = lang ?? 'fr'
  const [octet, kilo, mega] = UNITES_TAILLE[langue]
  if (n < 1024) return `${n} ${octet}`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} ${kilo}`
  // « 2 Mo », pas « 2.0 Mo » ; décimale à la virgule en français et en italien,
  // au point en allemand de Suisse et en anglais.
  const mo = Math.round((n / (1024 * 1024)) * 10) / 10
  const texte = Number.isInteger(mo) ? String(mo) : mo.toFixed(1)
  const separateur = langue === 'fr' || langue === 'it' ? ',' : '.'
  return `${texte.replace('.', separateur)} ${mega}`
}

type PdfJsModule = typeof import('pdfjs-dist')

let pdfjsPromise: Promise<PdfJsModule> | null = null

/**
 * Charge pdf.js — build "legacy" Node, sans worker : sans Worker natif dans
 * l'environnement, pdfjs-dist bascule seul sur un faux worker in-process.
 */
export function getPdfJs(): Promise<PdfJsModule> {
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs') as unknown as Promise<PdfJsModule>
  }
  return pdfjsPromise
}

let baseRessourcesPdfjs: URL | null = null

/**
 * pdfjs-dist n'a pas de champ "exports" dans son package.json : ses
 * sous-dossiers (cmaps/, standard_fonts/, wasm/) restent résolvables tels
 * quels — inutile de les reconditionner dans ce paquet.
 */
function ressourcesPdfjs(): URL {
  if (!baseRessourcesPdfjs) {
    baseRessourcesPdfjs = new URL('.', import.meta.resolve('pdfjs-dist/package.json'))
  }
  return baseRessourcesPdfjs
}

/**
 * Ouvre un PDF avec pdf.js en fournissant les ressources qu'il attend
 * (polices standard, tables de caractères, décodeurs WASM) — toutes servies
 * depuis /pdfjs/, donc sans appel à un CDN tiers.
 *
 * Sans `standardFontDataUrl`, le rendu d'un document utilisant une police
 * standard (Helvetica, Times…) reste bloqué indéfiniment.
 *
 * `password` sert aux documents chiffrés : sans lui, pdf.js rejette la
 * promesse avec un `PasswordException` (voir `estErreurMotDePasse`).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function openPdfJsDoc(bytes: Uint8Array, password?: string): Promise<any> {
  const pdfjs = await getPdfJs()
  const base = ressourcesPdfjs()
  // pdf.js détache le buffer qu'on lui passe : toujours une copie.
  return pdfjs.getDocument({
    data: bytes.slice(),
    standardFontDataUrl: fileURLToPath(new URL('standard_fonts/', base)),
    cMapUrl: fileURLToPath(new URL('cmaps/', base)),
    cMapPacked: true,
    wasmUrl: fileURLToPath(new URL('wasm/', base)),
    ...(password ? { password } : {}),
  }).promise
}

/**
 * Referme un document pdf.js ET termine son worker.
 *
 * ⚠️ Piège coûteux, à ne pas réapprendre : dans pdfjs-dist v6, un
 * `PDFDocumentProxy` n'expose **pas** de `destroy()` — l'appeler lève une
 * TypeError qui, dans un gestionnaire d'événement, avale silencieusement la
 * suite du traitement. Seul `loadingTask.destroy()` libère le worker ;
 * `doc.cleanup()` ne relâche que la mémoire du document et laisse le worker
 * vivant (un worker par page feuilletée, jusqu'à saturer l'onglet).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function closePdfJsDoc(doc: any): Promise<void> {
  await doc?.loadingTask?.destroy()
}

/**
 * Reconnaît le rejet que pdf.js émet quand un document est chiffré : soit
 * aucun mot de passe n'a été fourni, soit celui fourni est faux. Les deux cas
 * se distinguent par `code` (1 = attendu, 2 = incorrect).
 */
export function estErreurMotDePasse(e: unknown): 'requis' | 'incorrect' | null {
  if (!e || typeof e !== 'object') return null
  const err = e as { name?: string; code?: number; message?: string }
  const estMotDePasse =
    err.name === 'PasswordException' || /password/i.test(err.message ?? '')
  if (!estMotDePasse) return null
  return err.code === 2 ? 'incorrect' : 'requis'
}

export interface RenderedPage {
  canvas: NodeCanvas
  width: number
  height: number
}

/**
 * Rend une page (index 0-based) d'un document pdf.js sur un canvas.
 * `scale` multiplie la taille native ; utiliser ~0.3 pour des vignettes.
 *
 * `preRender` s'exécute juste après la création du contexte 2D, avant
 * `page.render()` — utilisé par `rasterisePage({ opaque: true })` pour
 * peindre un fond blanc opaque avant le rendu (voir plus bas pourquoi).
 *
 * `intent: 'print'` (plutôt que le défaut `'display'`) est déterminant, pas
 * cosmétique : en interne, pdf.js avance sa liste d'opérateurs page par page
 * via `window.requestAnimationFrame` quand l'intent est `'display'`
 * (`InternalRenderTask._scheduleNext`, pdfjs-dist/build/pdf.mjs) — un choix
 * pensé pour ne pas geler l'UI d'un visualiseur interactif. Mais un onglet
 * caché ou passé en arrière-plan voit son rAF throttlé puis suspendu par le
 * navigateur, donc toute conversion qui rastérise plusieurs pages (Compresser,
 * PDF/A, vignettes…) semble figée tant que l'onglet redevient visible. Avec
 * `intent: 'print'`, pdf.js bascule sur `Promise.resolve().then(...)` — une
 * chaîne de microtâches qu'aucun navigateur ne suspend selon la visibilité de
 * l'onglet. C'est l'option officielle de l'API pdf.js pour ce cas (rendu
 * hors-écran/impression), pas un contournement : le rendu produit un pixel
 * identique, seul l'ordonnancement change. `renderPageToCanvas` sert
 * exclusivement à rastériser vers une image (jamais à afficher un visualiseur
 * interactif dans la page), donc ce choix s'applique à tous ses appelants
 * sans changer leur comportement visible.
 */
export async function renderPageToCanvas(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pdfjsDoc: any,
  pageIndex: number,
  scale: number,
  opts: { preRender?: (canvas: NodeCanvas, ctx: SKRSContext2D) => void } = {},
): Promise<RenderedPage> {
  const page = await pdfjsDoc.getPage(pageIndex + 1)
  const viewport = page.getViewport({ scale })
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
  const ctx = canvas.getContext('2d')
  opts.preRender?.(canvas, ctx)
  await page.render({ canvas, canvasContext: ctx, viewport, intent: 'print' }).promise
  return { canvas, width: canvas.width, height: canvas.height }
}

/** Résolution des pages rastérisées, en points par pouce. */
export const DPI_RASTER = 300
/** Parse une plage de pages « 1-3, 5, 8-10 » en indices 0-based, bornés à pageCount. */
export function parsePageRanges(input: string, pageCount: number): number[] {
  const indices = new Set<number>()
  for (const part of input.split(',')) {
    const seg = part.trim()
    if (!seg) continue
    const m = seg.match(/^(\d+)\s*-\s*(\d+)$/)
    if (m) {
      const a = parseInt(m[1], 10)
      const b = parseInt(m[2], 10)
      for (let p = Math.min(a, b); p <= Math.max(a, b); p++) {
        if (p >= 1 && p <= pageCount) indices.add(p - 1)
      }
    } else if (/^\d+$/.test(seg)) {
      const p = parseInt(seg, 10)
      if (p >= 1 && p <= pageCount) indices.add(p - 1)
    }
  }
  return [...indices].sort((x, y) => x - y)
}
