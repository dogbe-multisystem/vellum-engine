# vellum-pdf-engine

A local PDF engine and command-line tool: merge, split, watermark, protect,
inspect, check accessibility, convert to PDF/A, verify signatures, and more —
**entirely on your machine**. No file is ever uploaded anywhere, no command in
this package makes a network request.

This is the same processing code that runs in the browser at
[vellumpdf.ch](https://vellumpdf.ch) — free PDF tools, also local, also
without an account. The private repository that hosts the web app treats this
one as a generated mirror: the modules under `src/` here are copied and
adapted for Node from that private source, never edited by hand (see
`CONTRIBUTING` below).

*(Lisez-vous plutôt le français ? Voir [README.fr.md](./README.fr.md).)*

## Install

```bash
npm i -g vellum-pdf-engine
```

Node 20 or later. Nothing else — the WebAssembly pieces (PDF encryption via
qpdf) and the PDF/A colour profile ship inside the package, so nothing is
downloaded at run time.

To work from the source instead:

```bash
git clone https://github.com/dogbe-multisystem/vellum-engine.git
cd vellum-engine
npm install
npm run build
npm link          # puts `vellum-pdf` on your PATH
```

## Commands

Every command supports `--help`. Commands that produce a PDF take `-o/--output`
and exit with a non-zero code and a clear message on failure.

| Command | What it does |
|---|---|
| `merge` | Merge several PDFs into one, in the order given. |
| `split` | Split a PDF into several files, by page ranges or one page per file. |
| `extract-pages` | Extract a set of pages into a new PDF. |
| `remove-pages` | Remove a set of pages from a PDF. |
| `rotate` | Rotate every page of a PDF. |
| `page-numbers` | Add "n / total" at the bottom of every page. |
| `watermark` | Stamp a text watermark on every page. |
| `metadata` | Read or write title, author, subject, keywords, language. |
| `flatten` | Flatten form fields into the page content. |
| `inspect` | Structural inspection report (pages, fonts, form, attachments...). |
| `accessibility` | Partial accessibility report — see caveat below. |
| `pdfa` | Convert to PDF/A-2B, best-effort mode — see caveat below. |
| `sanitize` | Remove automation mechanisms (OpenAction, JavaScript, actions). |
| `bookmarks` | Read or write a PDF's outline (table of contents). |
| `attachments` | List, extract, or add embedded files. |
| `protect` | Encrypt a PDF with a password (AES-256, via qpdf). |
| `unlock` | Decrypt a password-protected PDF. |
| `compress` | Shrink a PDF by rasterizing its pages to JPEG. |
| `verify-signature` | Verify a PDF's digital signatures. |

### Examples

```bash
vellum-pdf merge a.pdf b.pdf c.pdf -o combined.pdf

vellum-pdf split report.pdf -o out/ --ranges "1-3;4-8;9"
vellum-pdf split report.pdf -o out/ --one-page-per-file

vellum-pdf extract-pages report.pdf -o excerpt.pdf --ranges "2,5-7"
vellum-pdf remove-pages report.pdf -o clean.pdf --ranges "1"

vellum-pdf rotate scan.pdf -o scan-rotated.pdf --angle 90
vellum-pdf page-numbers report.pdf -o report-numbered.pdf
vellum-pdf watermark draft.pdf -o draft-marked.pdf --text "DRAFT — DO NOT DISTRIBUTE"

vellum-pdf metadata report.pdf --json
vellum-pdf metadata report.pdf -o report.pdf \
  --set-title "Q3 report" --set-author "Finance" --set-language en

vellum-pdf flatten form.pdf -o form-flat.pdf
vellum-pdf inspect report.pdf --json
vellum-pdf accessibility report.pdf --json
vellum-pdf pdfa report.pdf -o report-a.pdf --json
vellum-pdf sanitize suspicious.pdf -o clean.pdf --json

vellum-pdf bookmarks report.pdf --json
vellum-pdf bookmarks report.pdf --set toc.json -o report-with-toc.pdf

vellum-pdf attachments list report.pdf --json
vellum-pdf attachments extract report.pdf -o attachments/
vellum-pdf attachments add report.pdf --file invoice.xml -o report-with-invoice.pdf

vellum-pdf protect report.pdf -o report-protected.pdf --password "correct horse battery staple"
vellum-pdf unlock report-protected.pdf -o report.pdf --password "correct horse battery staple"

vellum-pdf compress scan.pdf -o scan-small.pdf --quality 0.6
vellum-pdf verify-signature contract.pdf --json
```

### `accessibility` — what it does and does not check

This is **not** a full PDF/UA validator: no free JavaScript library validates
PDF/UA locally (the closest ones are either Java-only or commercial). The
report lists what could and could not be checked — a point marked
`non-verifie` means exactly that, never an assumption of conformance.

### `pdfa` — which mode this exposes

`pdfa.ts` (the shared module) has two modes. This CLI exposes only the
**best-effort** mode (`convertToPdfA`): it keeps selectable text, with no
guarantee of ISO 19005-2 conformance. The private repository also has a
**rasterized, verified** mode (every page rebuilt as an image, conformance
checked against veraPDF on a real corpus) — it isn't exposed here because it
depends on a browser-side rendering pipeline the sync script does not carry
over; see that repository's `scripts/sync-engine.mjs` for the reasoning.

## What's not here, and why

- **No OCR.** The web app's OCR tool loads a multi-hundred-megabyte model
  that a browser caches once; that trade-off doesn't fit a CLI install.
- **No interface.** This package is headless by design — the reference UI is
  [vellumpdf.ch](https://vellumpdf.ch).
- **No AI assistant, no WebGPU tools.** Browser-only features that need a
  downloaded local model.
- **No licensing, invoicing, or account system.** Those are specific to the
  paid offer on the web app and never touch the processing code shipped here.

## Contributing

Issues and pull requests are welcome. Note the mirror setup above: a PR
touching `src/` here is reviewed and re-applied by hand to the private
source, since this repository's `src/` is regenerated, not edited directly.
A PR to `bin/`, `test/`, or the documentation is regular.

## License

MIT — see [LICENSE](./LICENSE). Copyright Edem Dogbe — DOGBE MULTISYSTEM,
Carouge.

The embedded qpdf WebAssembly build (`assets/qpdf/`) is a separate project
under Apache License 2.0 — see `assets/qpdf/NOTICE.txt`.

---

Built from the same code as [vellumpdf.ch](https://vellumpdf.ch).
