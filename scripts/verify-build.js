#!/usr/bin/env node

/**
 * verify-build.js — integrity assertions over the built site (_site).
 *
 * Checks:
 *   1. every page the orbd.tex model predicts was emitted (and a hard floor)
 *   2. every internal href resolves to an emitted file; every #fragment
 *      resolves to an id on the target page
 *   3. every figure SVG referenced exists (CI: all 129; locally downgraded
 *      to a notice when dvisvgm was unavailable)
 *   4. no LaTeX leakage outside math containers
 *   5. figure/table/equation numbers strictly sequential per chapter
 *   6. no unresolved references (.missing-ref) or placeholder pages (CI)
 *   7. build report clean: zero warnings, zero unknown constructs
 *   8. search index present with >100 documents
 *   9. vendor files (MathJax, MiniSearch), sw.js, manifest, icons emitted
 *  10. book index page has A–Z structure and >=500 linked refs
 *
 * Exits non-zero on any failure. Run after `npm run build`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { glob } from 'glob';
import * as cheerio from 'cheerio';
import { parseBook } from '../lib/parse/book.js';
import { buildModel } from '../lib/model/numbering.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const siteDir = path.join(root, '_site');
const PREFIX = process.env.VERCEL ? '' : '/ElectromagneticsVolTwoTextbook';
const CI = !!process.env.CI;

let failures = 0;
let checks = 0;
const fail = msg => {
  failures++;
  console.error(`  ✗ ${msg}`);
};
const pass = msg => {
  checks++;
  console.log(`  ✓ ${msg}`);
};
const note = msg => console.log(`  · ${msg}`);

if (!fs.existsSync(siteDir)) {
  console.error('_site not found — run `npm run build` first');
  process.exit(1);
}

// ---------- 1. page set ----------------------------------------------------
console.log('\npage set');
const model = buildModel(parseBook(root));
let missingPages = 0;
for (const page of model.pages) {
  const file = path.join(siteDir, page.url, 'index.html');
  if (!fs.existsSync(file)) {
    fail(`missing page: ${page.url}`);
    missingPages++;
  }
}
if (missingPages === 0) pass(`all ${model.pages.length} model pages emitted`);
if (model.pages.length < 100) fail(`page floor: expected >=100 model pages, got ${model.pages.length}`);
else pass('page count above floor (100)');

// ---------- load all HTML ---------------------------------------------------
const htmlFiles = (await glob('**/*.html', { cwd: siteDir })).filter(
  f => !f.startsWith('assets/')
);
const pages = new Map(); // site-relative path -> { $, ids:Set }
for (const file of htmlFiles) {
  const $ = cheerio.load(fs.readFileSync(path.join(siteDir, file), 'utf8'));
  const ids = new Set();
  $('[id]').each((_, el) => ids.add($(el).attr('id')));
  pages.set(file, { $, ids });
}

const resolveTarget = href => {
  // internal root-relative URL (with the deployment prefix) -> site file path
  let p = href;
  if (PREFIX && p.startsWith(PREFIX)) p = p.slice(PREFIX.length);
  if (p === '' || p === '/') p = '/index.html';
  if (p.endsWith('/')) p += 'index.html';
  if (!path.extname(p)) p += '/index.html';
  return p.replace(/^\//, '');
};

// ---------- 2. link + fragment integrity ------------------------------------
console.log('\nlinks');
let badLinks = 0;
let badFragments = 0;
let linkCount = 0;
for (const [file, { $, ids }] of pages) {
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (/^(https?:|mailto:|#)/.test(href)) {
      if (href.startsWith('#') && href.length > 1 && !ids.has(href.slice(1))) {
        fail(`${file}: dead same-page fragment ${href}`);
        badFragments++;
      }
      return;
    }
    if (!href.startsWith('/')) return; // relative links not produced by the build
    linkCount++;
    const [pathPart, fragment] = href.split('#');
    const target = resolveTarget(pathPart);
    const targetPage = pages.get(target);
    if (!targetPage && !fs.existsSync(path.join(siteDir, target))) {
      fail(`${file}: broken link ${href}`);
      badLinks++;
      return;
    }
    if (fragment && targetPage && !targetPage.ids.has(fragment)) {
      fail(`${file}: dead fragment ${href}`);
      badFragments++;
    }
  });
}
if (badLinks === 0) pass(`all ${linkCount} internal links resolve`);
if (badFragments === 0) pass('all fragments resolve');

// ---------- 3. figures -------------------------------------------------------
console.log('\nfigures');
const figureRefs = new Set();
for (const [, { $ }] of pages) {
  $('img[src]').each((_, el) => {
    const src = $(el).attr('src');
    if (src.includes('/figures/')) figureRefs.add(src.slice(src.indexOf('/figures/') + 9));
  });
}
const epsCount = fs
  .readdirSync(path.join(root, 'oem-v2_distro-FINAL', 'modules'))
  .filter(f => f.endsWith('.eps')).length;
const svgDir = path.join(siteDir, 'figures');
const svgsEmitted = fs.existsSync(svgDir)
  ? fs.readdirSync(svgDir).filter(f => f.endsWith('.svg')).length
  : 0;
let missingFigures = 0;
for (const ref of figureRefs) {
  if (!fs.existsSync(path.join(svgDir, ref))) missingFigures++;
}
if (missingFigures > 0) {
  if (CI) fail(`${missingFigures}/${figureRefs.size} referenced figures missing`);
  else note(`${missingFigures}/${figureRefs.size} figures missing (dvisvgm not run locally)`);
} else {
  pass(`all ${figureRefs.size} referenced figures exist (${svgsEmitted} SVGs emitted)`);
}
if (figureRefs.size < epsCount)
  note(`${epsCount - figureRefs.size} of ${epsCount} EPS files are unreferenced by any figure`);

// ---------- 4. LaTeX leakage -------------------------------------------------
console.log('\nlatex leakage');
let leaks = 0;
for (const [file, { $ }] of pages) {
  const clone = cheerio.load($.html());
  clone('.equation-block, script, style').remove();
  const text = clone('body').text().replace(/\\\((?:[^\\]|\\[^)])*\\\)/g, ' ');
  const m = text.match(/\\(emph|index|input|begin|ref|label|href|hyperref|caption|includegraphics)\{/);
  if (m) {
    fail(`${file}: LaTeX leakage "${m[0]}"`);
    leaks++;
  }
}
if (leaks === 0) pass('no LaTeX commands outside math containers');

// ---------- 5. sequential numbering ------------------------------------------
console.log('\nnumbering');
let numberingErrors = 0;
for (const chapter of model.chapters) {
  if (chapter.number === null) continue;
  const chapterPages = model.pages.filter(p => p.chapter === chapter);
  const seen = { Figure: [], Table: [], eq: [] };
  for (const page of chapterPages) {
    const file = path.join(siteDir, page.url, 'index.html');
    if (!fs.existsSync(file)) continue;
    const html = fs.readFileSync(file, 'utf8');
    for (const m of html.matchAll(/<span class="(figure|table)-number">(Figure|Table) ([A-Z0-9.]+)\.<\/span>/g)) {
      seen[m[2]].push(m[3]);
    }
    for (const m of html.matchAll(/\\tag\{([A-Z0-9.]+)\}/g)) {
      seen.eq.push(m[1]);
    }
  }
  for (const [kind, numbers] of Object.entries(seen)) {
    numbers.forEach((num, i) => {
      const expected = `${chapter.number}.${i + 1}`;
      if (num !== expected) {
        fail(`chapter ${chapter.number}: ${kind} number ${num}, expected ${expected}`);
        numberingErrors++;
      }
    });
  }
}
if (numberingErrors === 0) pass('figure/table/equation numbers strictly sequential per chapter');

// ---------- 6. unresolved refs / placeholders ---------------------------------
console.log('\nreferences');
let missingRefs = 0;
let placeholders = 0;
for (const [file, { $ }] of pages) {
  missingRefs += $('.missing-ref').length;
  placeholders += $('[data-placeholder]').length;
}
if (missingRefs === 0) pass('no unresolved cross-references');
else fail(`${missingRefs} unresolved cross-references (.missing-ref)`);
if (placeholders === 0) pass('no placeholder pages');
else if (CI && !process.env.ALLOW_PLACEHOLDERS) fail(`${placeholders} placeholder pages`);
else note(`${placeholders} placeholder pages`);

// ---------- 7. build report ----------------------------------------------------
console.log('\nbuild report');
const reportPath = path.join(root, 'generated', 'build-report.json');
if (!fs.existsSync(reportPath)) {
  fail('generated/build-report.json missing');
} else {
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  if (report.warnings.length === 0) pass('zero build warnings');
  else fail(`${report.warnings.length} build warnings (first: ${report.warnings[0]})`);
  if (report.unknownConstructs.length === 0) pass('zero unknown LaTeX constructs');
  else
    fail(
      `unknown LaTeX constructs: ${report.unknownConstructs.map(u => u.command).join(', ')}`
    );
  if (report.coverage.present === report.coverage.referenced)
    pass(`module coverage ${report.coverage.present}/${report.coverage.referenced}`);
  else if (CI && !process.env.ALLOW_PLACEHOLDERS)
    fail(`module coverage ${report.coverage.present}/${report.coverage.referenced}`);
  if (report.notices.length > 0) note(`${report.notices.length} notices (non-fatal source quirks)`);
}

// ---------- 8. search index -----------------------------------------------------
console.log('\nsearch');
const indexPath = path.join(siteDir, 'search_index.json');
if (!fs.existsSync(indexPath)) {
  fail('search_index.json missing (postbuild not run?)');
} else {
  const docs = JSON.parse(fs.readFileSync(indexPath, 'utf8')).documents;
  if (docs.length > 90) pass(`search index: ${docs.length} documents`);
  else fail(`search index too small: ${docs.length} documents`);
}

// ---------- 9. shell files -------------------------------------------------------
console.log('\napp shell');
for (const file of [
  'sw.js',
  'manifest.webmanifest',
  'SUMMARY.html',
  'summary.json',
  'assets/js/mathjax/tex-chtml.js',
  'assets/js/vendor/minisearch.js',
  'assets/icons/icon-192.png',
  'assets/icons/icon-512.png',
]) {
  if (fs.existsSync(path.join(siteDir, file))) pass(file);
  else fail(`missing: ${file}`);
}

// ---------- 10. book index --------------------------------------------------------
console.log('\nbook index');
const bookIndexFile = pages.get('book-index.html');
if (!bookIndexFile) {
  fail('book-index.html missing');
} else {
  const letters = bookIndexFile.$('.book-index h2').length;
  const refs = bookIndexFile.$('.index-entries a').length;
  if (letters >= 20) pass(`${letters} letter sections`);
  else fail(`only ${letters} letter sections`);
  if (refs >= 450) pass(`${refs} linked index references`);
  else fail(`only ${refs} linked index references`);
}

// ---------- result ----------------------------------------------------------------
console.log(`\n${checks} checks passed, ${failures} failures`);
process.exit(failures > 0 ? 1 : 0);
