/**
 * Généré depuis vellum-pdf/src/lib/qpdf.ts — ne pas éditer ici.
 * Source de vérité : le dépôt privé vellum-pdf, via scripts/sync-engine.mjs.
 */

/**
 * Enveloppe Node du CLI qpdf compilé en WebAssembly (la version navigateur
 * est src/lib/qpdf.ts dans le dépôt privé vellum-pdf). Une instance fraîche
 * par opération : le runtime Emscripten n'est pas réutilisable après
 * callMain.
 *
 * Les binaires (qpdf.js, qpdf.mjs, qpdf.wasm) sont vendus dans
 * assets/qpdf/, sous Apache-2.0 (voir assets/qpdf/NOTICE.txt), avec un
 * package.json {"type":"commonjs"} à côté : sans lui, le require() interne
 * du chargeur Emscripten hériterait du "type":"module" de ce paquet et
 * Node chargerait qpdf.js comme un module ES au lieu d'un script CommonJS
 * (require(...) renverrait alors l'espace de noms du module, pas la
 * fonction attendue).
 *
 * Le chargeur Emscripten tente d'abord fetch() pour lire le .wasm ; la
 * fetch() globale de Node ne sait pas lire les URL file://. On la masque le
 * temps de l'initialisation (voir initModuleSansFetch) pour forcer le repli
 * déjà prévu par le build Emscripten sur fs.readFileSync.
 */
import { fileURLToPath } from 'node:url'

type QpdfInit = (opts: {
  noInitialRun?: boolean
  locateFile?: (file: string) => string
  print?: (line: string) => void
  printErr?: (line: string) => void
}) => Promise<{
  callMain(args: string[]): number | undefined
  FS: {
    writeFile(path: string, data: Uint8Array): void
    readFile(path: string): Uint8Array
  }
}>

const QPDF_ASSETS = new URL('../assets/qpdf/', import.meta.url)

let initPromise: Promise<QpdfInit> | null = null

function loadQpdfInit(): Promise<QpdfInit> {
  if (!initPromise) {
    initPromise = import(new URL('qpdf.mjs', QPDF_ASSETS).href).then((m) => m.default as QpdfInit)
  }
  return initPromise
}

/** Exécute initQpdf() avec fetch() masqué (voir le commentaire de tête). */
async function initModuleSansFetch(
  initQpdf: QpdfInit,
  opts: Parameters<QpdfInit>[0],
): ReturnType<QpdfInit> {
  const fetchOriginal = globalThis.fetch
  // @ts-expect-error — masquage volontaire et temporaire, voir plus haut.
  delete globalThis.fetch
  try {
    return await initQpdf(opts)
  } finally {
    globalThis.fetch = fetchOriginal
  }
}
export interface QpdfResult {
  ok: boolean
  code: number
  stderr: string
  output?: Uint8Array
}

async function runQpdf(
  args: string[],
  input: Uint8Array,
  withOutput = true,
): Promise<QpdfResult> {
  const stderrLines: string[] = []
  const initQpdf = await loadQpdfInit()
  const mod = await initModuleSansFetch(initQpdf, {
    noInitialRun: true,
    locateFile: (file: string) => fileURLToPath(new URL(file, QPDF_ASSETS)),
    print: () => {},
    printErr: (line: string) => stderrLines.push(line),
  })
  mod.FS.writeFile('/in.pdf', input)
  const files = withOutput ? ['/in.pdf', '/out.pdf'] : ['/in.pdf']
  let code = 0
  try {
    code = mod.callMain([...args, ...files]) ?? 0
  } catch (e) {
    code = (e as { status?: number })?.status ?? 1
  }
  let output: Uint8Array | undefined
  try {
    output = mod.FS.readFile('/out.pdf')
  } catch {
    output = undefined
  }
  // Code 3 = succès avec avertissements chez qpdf.
  const ok = withOutput
    ? (code === 0 || code === 3) && !!output && output.length > 0
    : code === 0 || code === 3
  return { ok, code, stderr: stderrLines.join('\n'), output }
}

/** Le PDF exige-t-il un mot de passe ou porte-t-il des restrictions ? */
export async function decryptPdf(
  bytes: Uint8Array,
  password: string,
): Promise<QpdfResult> {
  const args = ['--decrypt']
  if (password) args.push(`--password=${password}`)
  return runQpdf(args, bytes)
}

/**
 * Répare un PDF en le réécrivant intégralement.
 *
 * qpdf reconstruit la table des références croisées et réassemble les objets :
 * c'est ce qui rattrape les fichiers tronqués, mal fermés par une imprimante ou
 * abîmés par un transfert. `--decrypt` est ajouté car un document simplement
 * restreint (impression interdite) refuserait autrement la réécriture ; il ne
 * retire aucun mot de passe d'ouverture, qui reste demandé par qpdf.
 * `--object-streams=generate` compacte le résultat au passage.
 */
export async function repairPdf(bytes: Uint8Array): Promise<QpdfResult> {
  return runQpdf(['--decrypt', '--object-streams=generate'], bytes)
}

/**
 * Droits accordés lors du chiffrement, au-delà du simple mot de passe
 * d'ouverture — ce qu'iLovePDF et PDF24 proposent sous « permissions ».
 * Correspondance exacte avec les options qpdf pour l'AES-256 (confirmée
 * dans le texte d'aide embarqué du binaire wasm : `strings qpdf.wasm`) :
 *  - impression   → --print=full|low|none
 *  - copie        → --extract=y|n (texte et images)
 *  - modification → --modify-other=y|n (contenu, hors les trois ci-dessous)
 *  - commentaires → --annotate=y|n
 *  - formulaires  → --form=y|n
 *  - assemblage   → --assemble=y|n (insérer, supprimer, tourner des pages)
 * L'accessibilité (--accessibility) n'est pas exposée ici : elle est
 * toujours mise à « y », voir construireArgsChiffrement.
 */
export interface DroitsPdf {
  impression: 'full' | 'low' | 'none'
  copie: boolean
  modification: boolean
  commentaires: boolean
  formulaires: boolean
  assemblage: boolean
}

/** Longueur en octets du mot de passe propriétaire généré quand le champ est vide. */
const LONGUEUR_MDP_GENERE = 24

/**
 * Mot de passe propriétaire aléatoire, en hexadécimal — jamais de « - » en
 * tête, donc jamais pris pour une option par la syntaxe positionnelle de
 * qpdf 11.0.0 (voir encryptPdf). Il n'est ni affiché ni conservé : son seul
 * rôle est d'empêcher que la simple connaissance du mot de passe d'ouverture
 * (ou l'absence de mot de passe) permette aussi de retirer les droits.
 */
function genererMotDePasseProprietaire(): string {
  const octets = new Uint8Array(LONGUEUR_MDP_GENERE)
  crypto.getRandomValues(octets)
  return Array.from(octets, (o) => o.toString(16).padStart(2, '0')).join('')
}

/**
 * Construit les arguments positionnels de `--encrypt … --`. Fonction pure,
 * exportée pour être vérifiée sans le runtime wasm (voir le script de test
 * du lot « permissions » dans le brouillon de l'agent) : c'est la partie de
 * cet outil qui se teste sans navigateur ni Node compatible Emscripten.
 */
export function construireArgsChiffrement(
  userPassword: string,
  proprietaire: string,
  droits?: DroitsPdf,
): string[] {
  const args = ['--encrypt', userPassword, proprietaire, '256']
  if (droits) {
    args.push(
      `--print=${droits.impression}`,
      `--extract=${droits.copie ? 'y' : 'n'}`,
      `--modify-other=${droits.modification ? 'y' : 'n'}`,
      `--annotate=${droits.commentaires ? 'y' : 'n'}`,
      `--form=${droits.formulaires ? 'y' : 'n'}`,
      `--assemble=${droits.assemblage ? 'y' : 'n'}`,
      // Toujours autorisée : ce n'est pas un réglage qu'on retire aux
      // lecteurs d'écran.
      '--accessibility=y',
    )
  }
  args.push('--')
  return args
}

/**
 * Chiffre avec mot de passe utilisateur (ouverture) en AES-256, et
 * facultativement des droits restreints (mot de passe propriétaire distinct,
 * permissions). Sans `droits`, le comportement est inchangé : mot de passe
 * unique, ouverture = propriétaire, aucune restriction — c'est le chemin que
 * suivent encore l'outil Protéger sans la section « Restreindre les droits »
 * et l'outil « lot » (batch.ts).
 *
 * Avec `droits`, un mot de passe propriétaire est nécessaire pour que qpdf
 * applique les restrictions ; s'il n'est pas fourni (`ownerPassword` vide),
 * un mot de passe aléatoire est généré (voir genererMotDePasseProprietaire)
 * et renvoyé dans `ownerPasswordGenere` — uniquement pour information
 * interne, jamais affiché à l'utilisateur.
 *
 * Le qpdf embarqué (11.0.0) n'accepte que la forme positionnelle
 * « --encrypt utilisateur propriétaire bits -- » : un mot de passe
 * commençant par un tiret y serait pris pour une option et ferait échouer
 * la commande (« unrecognized argument », vérifié sur le wasm). La forme
 * nommée --user-password=… n'existe qu'à partir de qpdf 11.7.0. En
 * attendant une mise à jour du wasm, ces mots de passe sont refusés
 * proprement plutôt que de laisser qpdf échouer de façon obscure.
 */
export async function encryptPdf(
  bytes: Uint8Array,
  userPassword: string,
  ownerPassword?: string,
  droits?: DroitsPdf,
): Promise<QpdfResult & { ownerPasswordGenere?: string }> {
  let proprietaire = ownerPassword || ''
  let ownerPasswordGenere: string | undefined
  if (droits) {
    if (!proprietaire) {
      proprietaire = genererMotDePasseProprietaire()
      ownerPasswordGenere = proprietaire
    }
  } else {
    // Chemin inchangé : sans droits à restreindre, le propriétaire retombe
    // sur le mot de passe d'ouverture comme avant cette fonctionnalité.
    proprietaire = ownerPassword || userPassword
  }
  if (userPassword.startsWith('-') || proprietaire.startsWith('-')) {
    return {
      ok: false,
      code: 2,
      stderr:
        'mot de passe commençant par « - » refusé : la forme positionnelle de qpdf 11.0.0 le prendrait pour une option',
    }
  }
  const res = await runQpdf(construireArgsChiffrement(userPassword, proprietaire, droits), bytes)
  return { ...res, ownerPasswordGenere }
}

/**
 * Heuristique locale : le PDF déclare-t-il un dictionnaire /Encrypt ?
 * Sert uniquement à adapter l'interface — la vérité vient du code de
 * sortie de decryptPdf (2 = mot de passe manquant ou incorrect).
 */
export function looksEncrypted(bytes: Uint8Array): boolean {
  const needle = new TextEncoder().encode('/Encrypt')
  // On balaie les 2048 derniers Ko max, le trailer est en fin de fichier.
  const start = Math.max(0, bytes.length - 2048 * 1024)
  outer: for (let i = start; i <= bytes.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (bytes[i + j] !== needle[j]) continue outer
    }
    return true
  }
  return false
}

/**
 * Linéarise (« Fast Web View ») : le document est réordonné pour que la
 * première page s'affiche avant la fin du téléchargement, quand le PDF est
 * ouvert depuis un site. `--object-streams=generate` compacte au passage,
 * sans perte. Contenu, texte et signets restent identiques.
 */
export async function linearizePdf(bytes: Uint8Array): Promise<QpdfResult> {
  return runQpdf(['--linearize', '--object-streams=generate'], bytes)
}

/**
 * Vrai si le fichier se déclare linéarisé : le dictionnaire /Linearized
 * doit être le premier objet, donc dans les premiers octets.
 */
export function estLinearise(bytes: Uint8Array): boolean {
  const debut = new TextDecoder('latin1').decode(bytes.subarray(0, 1024))
  return /\/Linearized\s/.test(debut)
}
