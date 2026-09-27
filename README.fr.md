# vellum-pdf-engine

Un moteur PDF local et un outil en ligne de commande : fusionner, découper,
filigraner, protéger, inspecter, contrôler l'accessibilité, convertir en
PDF/A, vérifier des signatures, et plus — **entièrement sur votre machine**.
Aucun fichier ne part jamais vers un serveur, aucune commande de ce paquet ne
fait de requête réseau.

C'est le même code de traitement que celui qui tourne dans le navigateur sur
[vellumpdf.ch](https://vellumpdf.ch) — des outils PDF gratuits, eux aussi
locaux, eux aussi sans compte. Le dépôt privé qui héberge l'application web
traite celui-ci comme un miroir généré : les modules sous `src/` sont copiés
et adaptés pour Node depuis cette source privée, jamais édités à la main
(voir « Contribuer » plus bas).

*(Reading in English? See [README.md](./README.md).)*

## Installation

```bash
npm i -g vellum-pdf-engine
```

Node 20 ou plus récent suffit. Rien d'autre : les pièces WebAssembly (le
chiffrement PDF via qpdf) et le profil colorimétrique PDF/A sont fournis dans
le paquet, si bien que rien n'est téléchargé à l'exécution.

Pour travailler depuis les sources :

```bash
git clone https://github.com/dogbe-multisystem/vellum-engine.git
cd vellum-engine
npm install
npm run build
npm link          # met `vellum-pdf` dans votre PATH
```

## Commandes

Chaque commande accepte `--help`. Les commandes qui produisent un PDF
prennent `-o/--output` et quittent avec un code non nul et un message clair
en cas d'échec.

| Commande | Ce qu'elle fait |
|---|---|
| `merge` | Fusionne plusieurs PDF en un seul, dans l'ordre donné. |
| `split` | Découpe un PDF en plusieurs fichiers, par plages ou une page par fichier. |
| `extract-pages` | Extrait un ensemble de pages dans un nouveau PDF. |
| `remove-pages` | Retire un ensemble de pages d'un PDF. |
| `rotate` | Fait pivoter toutes les pages d'un PDF. |
| `page-numbers` | Ajoute « n / total » en bas de chaque page. |
| `watermark` | Appose un filigrane texte sur chaque page. |
| `metadata` | Lit ou écrit le titre, l'auteur, le sujet, les mots-clés, la langue. |
| `flatten` | Fige les champs de formulaire dans le contenu de la page. |
| `inspect` | Rapport d'inspection structurelle (pages, polices, formulaire, pièces jointes...). |
| `accessibility` | Rapport d'accessibilité partiel — voir la mise en garde ci-dessous. |
| `pdfa` | Conversion vers PDF/A-2B, mode au mieux — voir la mise en garde ci-dessous. |
| `sanitize` | Retire les mécanismes d'automatisation (OpenAction, JavaScript, actions). |
| `bookmarks` | Lit ou écrit les signets (table des matières) d'un PDF. |
| `attachments` | Liste, extrait ou ajoute des pièces jointes. |
| `protect` | Chiffre un PDF avec un mot de passe (AES-256, via qpdf). |
| `unlock` | Déchiffre un PDF protégé par mot de passe. |
| `compress` | Réduit le poids d'un PDF en rastérisant ses pages en JPEG. |
| `verify-signature` | Vérifie les signatures numériques d'un PDF. |

### Exemples

```bash
vellum-pdf merge a.pdf b.pdf c.pdf -o fusion.pdf

vellum-pdf split rapport.pdf -o sortie/ --ranges "1-3;4-8;9"
vellum-pdf split rapport.pdf -o sortie/ --one-page-per-file

vellum-pdf extract-pages rapport.pdf -o extrait.pdf --ranges "2,5-7"
vellum-pdf remove-pages rapport.pdf -o propre.pdf --ranges "1"

vellum-pdf rotate scan.pdf -o scan-pivote.pdf --angle 90
vellum-pdf page-numbers rapport.pdf -o rapport-numerote.pdf
vellum-pdf watermark brouillon.pdf -o brouillon-marque.pdf --text "BROUILLON — NE PAS DIFFUSER"

vellum-pdf metadata rapport.pdf --json
vellum-pdf metadata rapport.pdf -o rapport.pdf \
  --set-title "Rapport T3" --set-author "Finance" --set-language fr

vellum-pdf flatten formulaire.pdf -o formulaire-fige.pdf
vellum-pdf inspect rapport.pdf --json
vellum-pdf accessibility rapport.pdf --json
vellum-pdf pdfa rapport.pdf -o rapport-a.pdf --json
vellum-pdf sanitize suspect.pdf -o propre.pdf --json

vellum-pdf bookmarks rapport.pdf --json
vellum-pdf bookmarks rapport.pdf --set sommaire.json -o rapport-avec-sommaire.pdf

vellum-pdf attachments list rapport.pdf --json
vellum-pdf attachments extract rapport.pdf -o pieces-jointes/
vellum-pdf attachments add rapport.pdf --file facture.xml -o rapport-avec-facture.pdf

vellum-pdf protect rapport.pdf -o rapport-protege.pdf --password "un mot de passe long et unique"
vellum-pdf unlock rapport-protege.pdf -o rapport.pdf --password "un mot de passe long et unique"

vellum-pdf compress scan.pdf -o scan-leger.pdf --quality 0.6
vellum-pdf verify-signature contrat.pdf --json
```

### `accessibility` — ce qui est vérifié, et ce qui ne l'est pas

Ce n'est **pas** un validateur PDF/UA complet : aucune bibliothèque
JavaScript libre ne valide le PDF/UA en local (les plus proches sont soit en
Java, soit payantes). Le rapport dit ce qu'il a pu vérifier et ce qu'il n'a
pas pu vérifier — un point marqué `non-verifie` veut dire exactement cela,
jamais une conformité supposée.

### `pdfa` — quel mode ce CLI expose

`pdfa.ts` (le module partagé) a deux modes. Ce CLI n'expose que le mode
**au mieux** (`convertToPdfA`) : le texte reste sélectionnable, sans garantie
de conformité ISO 19005-2. Le dépôt privé possède aussi un mode
**rastérisé et vérifié** (chaque page reconstruite en image, conformité
contrôlée par veraPDF sur un corpus réel) — non exposé ici car il dépend
d'une chaîne de rendu côté navigateur que le script de synchronisation ne
reprend pas ; voir le raisonnement dans `scripts/sync-engine.mjs` de ce
dépôt.

## Ce qui n'y est pas, et pourquoi

- **Pas d'OCR.** L'outil OCR de l'application web charge un modèle de
  plusieurs centaines de mégaoctets qu'un navigateur met en cache une seule
  fois ; ce compromis ne convient pas à une installation en ligne de
  commande.
- **Pas d'interface.** Ce paquet est volontairement sans interface — la
  référence visuelle est [vellumpdf.ch](https://vellumpdf.ch).
- **Pas d'assistant IA, pas d'outils WebGPU.** Fonctionnalités propres au
  navigateur, qui nécessitent un modèle téléchargé localement.
- **Pas de système de licence, de facturation ou de compte.** Ces éléments
  sont propres à l'offre payante de l'application web et ne touchent jamais
  au code de traitement livré ici.

## Contribuer

Les issues et les pull requests sont bienvenues. Attention au fonctionnement
en miroir décrit plus haut : une pull request qui touche `src/` ici est
relue puis reportée à la main dans la source privée, puisque le `src/` de ce
dépôt est régénéré et non édité directement. Une pull request sur `bin/`,
`test/` ou la documentation suit le circuit habituel.

## Licence

MIT — voir [LICENSE](./LICENSE). Copyright Edem Dogbe — DOGBE MULTISYSTEM,
Carouge.

Le binaire qpdf embarqué (WebAssembly, `assets/qpdf/`) est un projet distinct
sous licence Apache 2.0 — voir `assets/qpdf/NOTICE.txt`.

---

Construit à partir du même code que [vellumpdf.ch](https://vellumpdf.ch).
