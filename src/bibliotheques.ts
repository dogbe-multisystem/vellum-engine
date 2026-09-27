/**
 * Généré depuis vellum-pdf/src/lib/bibliotheques.ts — ne pas éditer ici.
 * Source de vérité : le dépôt privé vellum-pdf, via scripts/sync-engine.mjs.
 */

/**
 * Chargement différé des bibliothèques lourdes de traitement.
 *
 * pdf-lib (avec ses polices standard, pako et UPNG : ~420 Ko, 172 Ko
 * compressés) et JSZip étaient importés en tête des modules de traitement,
 * donc téléchargés et analysés dès l'arrivée sur une page d'outil, avant tout
 * dépôt de fichier — pour rien si le visiteur repart, et en concurrence avec
 * l'hydratation de la page. Ils ne sont désormais chargés qu'au premier
 * usage, comme pdf.js, Tesseract et Three.js le sont déjà.
 *
 * Usage, dans une fonction asynchrone :
 *   const { PDFDocument, rgb } = await chargerPdfLib()
 *   const JSZip = await chargerJszip()
 *
 * Les types restent importés statiquement (`import type { PDFDocument } from
 * 'pdf-lib'`) : ils ne pèsent rien à l'exécution.
 *
 * ToolShell lance `prechargerTraitement()` au premier geste ou après 3,5 s : la
 * bibliothèque est en général déjà là quand le premier fichier arrive, sans
 * avoir gêné le premier affichage.
 */
import * as pdfLibNS from 'pdf-lib'
import JSZipDefault from 'jszip'

// Chargement statique : sous Node, rien ne justifie le chargement différé
// (pas de première peinture à protéger). Mêmes points d'entrée que la
// version navigateur pour que les modules copiés restent inchangés.
export const chargerPdfLib = async () => pdfLibNS

export const chargerJszip = async () => JSZipDefault
