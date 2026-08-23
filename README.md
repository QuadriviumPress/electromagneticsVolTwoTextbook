# Electromagnetics Vol. 2 — Web Edition

Eleventy build of **Electromagnetics, Volume 2** by Steven W. Ellingson
(VT Publishing, 2020), rendering the original LaTeX source to a searchable,
offline-capable web textbook.

- **Live site:** https://quadriviumpress.github.io/ElectromagneticsVolTwoTextbook/
- **Print edition of record:** https://doi.org/10.21061/electromagnetics-vol-2
- **License:** [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/)

## How it works

The verbatim VT Publishing source distribution lives in
[`oem-v2_distro-FINAL/`](oem-v2_distro-FINAL/) — **it is ground truth and is
never modified**. Everything else is build tooling:

```
oem-v2_distro-FINAL/     LaTeX source (orbd.tex + 96 modules + 115 EPS figures)
lib/parse/               orbd.tex & module tokenizer (math protected first,
                         then comment-stripping, environment-stack blocks)
lib/model/               chapter/section/figure/equation numbering (matches
                         print via build-time \tag{} injection), anchors map,
                         book index model
lib/render/              blocks -> HTML; math passes through raw to MathJax
_data/book.js            exposes the rendered book to Eleventy
pages.njk                paginates every section to its own page
scripts/                 figure conversion (dvisvgm), search index (MiniSearch),
                         verify-build integrity checks, chapter PDF generation
assets/                  viewer JS (sidebar TOC, prev/next, dark mode), CSS,
                         self-hosted MathJax v4 + MiniSearch (git-ignored,
                         populated by `npm run update:vendor`)
```

Unknown LaTeX constructs are never silently dropped: they land in
`generated/build-report.json` and fail CI.

## Developing

Requires Node ≥ 22. For figure conversion also install
`ghostscript` + `dvisvgm` + `mupdf-tools`
(`sudo apt-get install ghostscript dvisvgm mupdf-tools texlive-binaries`);
without them the site builds with figures missing.

```sh
npm ci
npm run update:vendor   # populate self-hosted MathJax + MiniSearch (once)
npm run build           # figures -> Eleventy -> search index
npm run verify          # integrity checks over _site
npm run serve           # dev server at http://localhost:4000/ElectromagneticsVolTwoTextbook/
```

## Deployment

Pushes to `main` trigger `.github/workflows/deploy.yml`: build → verify →
per-chapter PDFs (Playwright printing the `/print/<chapter>/` pages) → rebuild
with the PDF download links → deploy to GitHub Pages. Pull requests run the
same build + verify via `ci.yml`.

## Attribution

Content © 2020 Steven W. Ellingson, licensed under the Creative Commons
Attribution-ShareAlike 4.0 International license. This repository redistributes
the book source and derived HTML under the same license. Figure credits appear
in each chapter's End Matter, as in the print edition.
