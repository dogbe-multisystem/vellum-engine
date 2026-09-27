/**
 * Généré depuis vellum-pdf/src/lib/batch.ts — ne pas éditer ici.
 * Source de vérité : le dépôt privé vellum-pdf, via scripts/sync-engine.mjs.
 */

import type { PDFPage } from 'pdf-lib'
// Chargement différé de pdf-lib, au premier usage réel (voir bibliotheques.ts).
// Extensions .ts explicites : ce module est aussi importé directement par
// Node (harnais de test de la « chaîne de traitement », voir chaine.ts), qui
// — contrairement à Vite — ne résout pas les spécificateurs relatifs sans
// extension.
import { chargerPdfLib } from './bibliotheques.ts'
import { loadPdf, savePdf, openPdfJsDoc, renderPageToCanvas } from './pdf.ts'
import { encryptPdf } from './qpdf.ts'

/**
 * Opérations applicables à une pile de fichiers d'un seul geste.
 * Chaque opération prend les octets d'un PDF et rend les octets du résultat ;
 * l'outil se charge de la boucle, du ZIP et de la progression.
 */

export type BatchOpId =
  | 'compresser'
  | 'filigrane'
  | 'numeroter'
  | 'pivoter'
  | 'proteger'
  | 'aplatir'

export interface BatchOpDef {
  id: BatchOpId
  label: string
  /** Décrit l'effet en une phrase, pour l'interface. */
  description: string
  /** Préfixe ajouté aux fichiers produits. */
  prefixe: string
}

export const batchOps: BatchOpDef[] = [
  {
    id: 'compresser',
    label: 'Compresser',
    description: 'Réduit le poids de chaque document en rastérisant les pages.',
    prefixe: 'compresse',
  },
  {
    id: 'filigrane',
    label: 'Filigrane',
    description: 'Appose le même filigrane texte sur toutes les pages de chaque document.',
    prefixe: 'filigrane',
  },
  {
    id: 'numeroter',
    label: 'Numéroter',
    description: 'Ajoute une pagination en bas de page à chaque document.',
    prefixe: 'numerote',
  },
  {
    id: 'pivoter',
    label: 'Pivoter',
    description: 'Fait pivoter toutes les pages de chaque document.',
    prefixe: 'pivote',
  },
  {
    id: 'proteger',
    label: 'Protéger',
    description: 'Chiffre chaque document avec le même mot de passe, en AES-256.',
    prefixe: 'protege',
  },
  {
    id: 'aplatir',
    label: 'Aplatir',
    description: 'Fige les champs de formulaire de chaque document.',
    prefixe: 'aplati',
  },
]

export interface BatchOptions {
  /** Filigrane : texte apposé. */
  texte?: string
  /** Filigrane : opacité 0–1. */
  opacite?: number
  /** Pivoter : 90, 180 ou 270. */
  angle?: number
  /** Protéger : mot de passe. */
  motDePasse?: string
  /** Compresser : qualité JPEG 0–1. */
  qualite?: number
}

/**
 * Repère visuel d'une page : zone réellement affichée (CropBox) et rotation
 * normalisée. `getSize()` renvoie la MediaBox et `drawText` travaille en
 * espace non tourné : sur un scan portant /Rotate 90, un texte posé « en
 * bas » sortirait sur le côté. Ce repère convertit des coordonnées
 * visuelles — ce que voit le lecteur, origine en bas à gauche de la vue —
 * en coordonnées de dessin de la page.
 */
function reperePage(page: PDFPage): {
  /** Largeur et hauteur telles que le lecteur les voit. */
  largeurVue: number
  hauteurVue: number
  /** Rotation de la page, ramenée à 0, 90, 180 ou 270. */
  rotation: number
  versDessin: (vx: number, vy: number) => { x: number; y: number }
} {
  const boite = page.getCropBox()
  const rotation = ((page.getRotation().angle % 360) + 360) % 360
  const pivote = rotation === 90 || rotation === 270
  const largeurVue = pivote ? boite.height : boite.width
  const hauteurVue = pivote ? boite.width : boite.height
  const versDessin = (vx: number, vy: number) => {
    switch (rotation) {
      case 90:
        return { x: boite.x + boite.width - vy, y: boite.y + vx }
      case 180:
        return { x: boite.x + boite.width - vx, y: boite.y + boite.height - vy }
      case 270:
        return { x: boite.x + vy, y: boite.y + boite.height - vx }
      default:
        return { x: boite.x + vx, y: boite.y + vy }
    }
  }
  return { largeurVue, hauteurVue, rotation, versDessin }
}

/** Applique une opération à un document. */
export async function applyBatchOp(
  op: BatchOpId,
  bytes: Uint8Array,
  opts: BatchOptions = {},
): Promise<Uint8Array> {
  switch (op) {
    case 'aplatir': {
      const doc = await loadPdf(bytes)
      // Un document sans champ n'a rien à aplatir : succès normal. Toute
      // vraie erreur de flatten() — champ sans appearance stream, formulaire
      // malformé — doit en revanche remonter dans la liste des échecs,
      // plutôt que de ranger un fichier inchangé parmi les succès du ZIP.
      const form = doc.getForm()
      if (form.getFields().length > 0) form.flatten()
      return savePdf(doc)
    }

    case 'pivoter': {
      const { degrees } = await chargerPdfLib()
      const doc = await loadPdf(bytes)
      const delta = opts.angle ?? 90
      doc.getPages().forEach((p) => {
        // Double modulo : un /Rotate négatif (légal en PDF) donnerait sinon
        // un résultat négatif au lieu d'un angle ramené à 0–270.
        p.setRotation(degrees((((p.getRotation().angle + delta) % 360) + 360) % 360))
      })
      return savePdf(doc)
    }

    case 'filigrane': {
      const { StandardFonts, degrees, rgb } = await chargerPdfLib()
      const doc = await loadPdf(bytes)
      const texte = opts.texte?.trim() || 'CONFIDENTIEL'
      const opacity = opts.opacite ?? 0.18
      const niveauGris = rgb(0.45, 0.43, 0.4)
      // Moteur public : Helvetica seule (texte WinAnsi), voir sync-engine.mjs.
      const font = await doc.embedFont(StandardFonts.Helvetica)

      doc.getPages().forEach((page) => {
        const { largeurVue, hauteurVue, rotation, versDessin } = reperePage(page)
        const size = Math.min(56, (largeurVue * 0.9) / (texte.length * 0.5))
        const largeur = font.widthOfTextAtSize(texte, size)
        // Ancre au centre de la vue, et angle du filigrane composé avec la
        // rotation de la page : le texte reste à −45° à l'écran, même sur
        // un scan porteur d'un /Rotate.
        const { x, y } = versDessin(largeurVue / 2 - largeur / 2, hauteurVue / 2)
        page.drawText(texte, {
          x,
          y,
          size,
          font,
          color: niveauGris,
          opacity,
          rotate: degrees(rotation - 45),
        })
      })
      return savePdf(doc)
    }

    case 'numeroter': {
      const { StandardFonts, degrees, rgb } = await chargerPdfLib()
      const doc = await loadPdf(bytes)
      const font = await doc.embedFont(StandardFonts.Helvetica)
      const pages = doc.getPages()
      pages.forEach((page, i) => {
        const { largeurVue, rotation, versDessin } = reperePage(page)
        const label = `${i + 1} / ${pages.length}`
        const size = 11
        const largeur = font.widthOfTextAtSize(label, size)
        // « En bas de page » au sens du lecteur : coordonnées visuelles
        // converties dans le repère de dessin, texte redressé au besoin.
        const { x, y } = versDessin(largeurVue / 2 - largeur / 2, 28)
        page.drawText(label, {
          x,
          y,
          size,
          font,
          color: rgb(0.25, 0.23, 0.2),
          rotate: degrees(rotation),
        })
      })
      return savePdf(doc)
    }

    case 'proteger': {
      const mdp = opts.motDePasse ?? ''
      // Codes stables en préfixe : le texte français reste car l'interface
      // du traitement par lot reconnaît ces messages par motif
      // (/mot de passe/i, /chiffrement/i) pour les traduire.
      if (!mdp) throw new Error('BATCH_PASSPHRASE_REQUIRED: Mot de passe requis')
      const res = await encryptPdf(bytes, mdp)
      if (!res.ok || !res.output) throw new Error('BATCH_ENCRYPT_FAILED: Chiffrement impossible')
      return res.output
    }

    case 'compresser': {
      const { PDFDocument } = await chargerPdfLib()
      const qualite = opts.qualite ?? 0.72
      const src = await openPdfJsDoc(bytes)
      const out = await PDFDocument.create()
      for (let i = 0; i < src.numPages; i++) {
        const { canvas } = await renderPageToCanvas(src, i, 1.5)
        // @napi-rs/canvas rend un Buffer directement (toBuffer, synchrone) :
        // pas besoin de l'aller-retour par Blob que fait le navigateur.
        const jpegBytes = canvas.toBuffer('image/jpeg', qualite)
        const jpg = await out.embedJpg(new Uint8Array(jpegBytes))
        const page = await src.getPage(i + 1)
        const vp = page.getViewport({ scale: 1 })
        const newPage = out.addPage([vp.width, vp.height])
        newPage.drawImage(jpg, { x: 0, y: 0, width: vp.width, height: vp.height })
      }
      // destroy() et non cleanup() : seul destroy() termine le Web Worker.
      await src.loadingTask.destroy()
      return savePdf(out)
    }
  }
}

/** Nom du fichier produit pour une opération donnée. */
export function batchFilename(op: BatchOpId, original: string): string {
  const def = batchOps.find((o) => o.id === op)!
  const base = original.replace(/\.[^.]+$/, '')
  return `${def.prefixe}-${base}.pdf`
}
