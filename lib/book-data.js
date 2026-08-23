// buildBook(): parse → model → render orchestration.
//
//   parse/book.js       orbd.tex → chapters/sections/module map
//   model/numbering.js  page URLs + print-style chapter/section numbers
//   parse/module.js     each module .tex → tokenized blocks (mtime-cached)
//   model/content.js    figure/table/example/equation numbers + anchors map
//   render/transform.js blocks → HTML
//
// A build report (coverage, warnings, unknown LaTeX constructs) is written to
// generated/build-report.json; verify-build.js fails CI on regressions.
import fs from 'node:fs';
import path from 'node:path';
import { parseBook } from './parse/book.js';
import { protectMath } from './parse/tokenizer.js';
import { loadModule } from './parse/module.js';
import { buildModel } from './model/numbering.js';
import { annotateContent } from './model/content.js';
import { renderModule } from './render/transform.js';
import { renderInline, escapeHtml } from './render/inline.js';
import { buildBookIndex } from './model/book-index.js';
import { generatedFiguresDir } from './paths.js';

function placeholderHtml(moduleName) {
  return (
    `<div class="placeholder-note" role="note">` +
    `<p>This section (<code>${escapeHtml(moduleName)}</code>) is not yet available in the web edition.</p>` +
    `</div>`
  );
}

function sectionListHtml(chapter) {
  if (chapter.sections.length === 0) return '';
  const items = chapter.sections
    .map(s => `<li><a href="${s.url}">${escapeHtml(s.displayTitle)}</a></li>`)
    .join('\n');
  return `<nav class="chapter-sections" aria-label="Sections">\n<ul>\n${items}\n</ul>\n</nav>`;
}

/** /print/<slug>/ page name and downloadable PDF name for a chapter. */
function printNames(chapter) {
  const slug =
    chapter.number === null
      ? 'preface'
      : chapter.mode === 'appendix'
        ? `appendix-${chapter.number.toLowerCase()}`
        : `chapter-${chapter.number}`;
  return { printSlug: slug, pdfName: `em2-${slug}.pdf` };
}

/** Render a raw orbd.tex title (may contain math) for use in <h1>. */
function renderTitle(tex, baseCtx) {
  const { text, mathSpans } = protectMath(tex, baseCtx.warnings, 'title');
  return renderInline(text, { ...baseCtx, mathSpans, name: 'title' });
}

export function buildBook({ root }) {
  const structure = parseBook(root);
  const warnings = [...structure.warnings];
  const model = buildModel(structure);

  // Load every module referenced by any page (missing → placeholder).
  const loaded = new Map();
  const notices = [];
  let present = 0;
  let referenced = 0;
  for (const page of model.pages) {
    for (const name of page.modules) {
      if (loaded.has(name)) continue;
      referenced++;
      const mod = loadModule(root, name);
      if (mod) {
        present++;
        loaded.set(name, { ...mod, name });
        warnings.push(...mod.warnings);
        notices.push(...(mod.notices ?? []));
      } else {
        loaded.set(name, null);
        warnings.push(`missing module source: ${name}.tex`);
      }
    }
  }

  const anchors = annotateContent(model, loaded, warnings);

  const unknownConstructs = new Map(); // command -> Set of module names
  const indexEntries = [];

  // Figures are SVG (line art) or PNG (photos dvisvgm cannot vectorize) —
  // convert-figures.js decides per file; pick whichever exists. Defaults to
  // .svg when the converter has not run (dev machines without dvisvgm).
  const figuresDir = generatedFiguresDir(root);
  const figureFile = epsName => {
    const base = epsName.replace(/\.eps$/, '');
    const png = `${base}.png`;
    if (fs.existsSync(path.join(figuresDir, png))) return png;
    return `${base}.svg`;
  };

  for (const page of model.pages) {
    let idxCount = 0;
    const ctx = {
      page,
      anchors,
      warnings,
      footnotes: [],
      indexEntries,
      nextIndexId: () => ++idxCount,
      unknown: cmd => {
        if (!unknownConstructs.has(cmd)) unknownConstructs.set(cmd, new Set());
        unknownConstructs.get(cmd).add(ctx.name ?? page.url);
      },
      mathSpans: [],
      name: page.url,
      figureFile,
    };

    const parts = [];
    let placeholder = false;
    page.modules.forEach((name, idx) => {
      const mod = loaded.get(name);
      if (!mod) {
        parts.push(placeholderHtml(name));
        placeholder = true;
        return;
      }
      if (idx > 0) {
        // Continuation module (m0085): flows on its host section's page under
        // its own heading, matching the print layout.
        parts.push(
          `<h3 class="module-continuation">${escapeHtml(mod.meta.title ?? name)}</h3>`
        );
      }
      parts.push(renderModule(mod, ctx));
    });

    if (page.kind === 'chapter') {
      parts.push(sectionListHtml(page.chapter));
      // The chapter PDF link is emitted only when the PDF exists on disk: the
      // deploy workflow generates PDFs after a first build, copies them into
      // assets/pdf/, and rebuilds — so links never 404.
      const { pdfName } = printNames(page.chapter);
      if (fs.existsSync(path.join(root, 'assets', 'pdf', pdfName))) {
        parts.push(
          `<p class="chapter-pdf"><a href="/assets/pdf/${pdfName}" download>Download this chapter as PDF</a></p>`
        );
      }
    }

    if (ctx.footnotes.length > 0) {
      const items = ctx.footnotes
        .map(
          (fn, n) =>
            `<li id="fn-${n + 1}">${fn} <a href="#fnref-${n + 1}" class="footnote-back" aria-label="Back to reference">↩</a></li>`
        )
        .join('\n');
      parts.push(`<div class="footnotes"><hr />\n<ol>\n${items}\n</ol>\n</div>`);
    }

    page.placeholder = placeholder;
    page.htmlTitle =
      (page.number && page.kind !== 'end-matter' ? `${page.number} ` : '') +
      renderTitle(page.title, ctx);
    page.html = `<article${placeholder ? ' data-placeholder="true"' : ''}>\n${parts.join('\n')}\n</article>`;
  }

  // ---- build report -------------------------------------------------------
  const unknownReport = [...unknownConstructs.entries()].map(([cmd, modules]) => ({
    command: cmd,
    modules: [...modules].sort(),
  }));
  const report = {
    coverage: { present, referenced },
    pages: model.pages.length,
    warnings,
    notices,
    unknownConstructs: unknownReport,
  };
  fs.mkdirSync(path.join(root, 'generated'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'generated', 'build-report.json'),
    JSON.stringify(report, null, 2)
  );

  console.log(`[book] coverage: ${present}/${referenced} modules on disk`);
  if (notices.length > 0) console.log(`[book] ${notices.length} notices (see generated/build-report.json)`);
  for (const w of warnings.slice(0, 30)) console.warn(`[book] WARNING: ${w}`);
  if (warnings.length > 30) console.warn(`[book] ...and ${warnings.length - 30} more warnings`);
  for (const u of unknownReport) {
    console.warn(`[book] UNKNOWN CONSTRUCT ${u.command} in ${u.modules.join(', ')}`);
  }

  const summaryJson = JSON.stringify(
    {
      title: 'Electromagnetics Vol. 2',
      chapters: model.chapters.map(ch => ({
        number: ch.number,
        title: ch.plainTitle,
        url: ch.url,
        sections: ch.sections.map(s => ({ number: s.number, title: s.plainTitle, url: s.url })),
        endMatterUrl: ch.endMatterUrl || null,
      })),
    },
    null,
    2
  );

  const bookIndex = buildBookIndex(indexEntries, warnings);

  // Per-chapter concatenated print pages (/print/<slug>/) for PDF generation.
  const printManifest = [];
  for (const chapter of model.chapters) {
    const { printSlug, pdfName } = printNames(chapter);
    chapter.printSlug = printSlug;
    const chapterPages = model.pages.filter(p => p.chapter === chapter);
    chapter.printHtml = chapterPages
      .map(p => `<section class="print-section">\n<h2>${p.htmlTitle}</h2>\n${p.html}\n</section>`)
      .join('\n');
    printManifest.push({
      printUrl: `/print/${printSlug}/`,
      pdfName,
      title: chapter.displayTitle,
    });
  }
  fs.writeFileSync(
    path.join(root, 'generated', 'print-manifest.json'),
    JSON.stringify(printManifest, null, 2)
  );

  return {
    pages: model.pages,
    chapters: model.chapters,
    bookIndex,
    summaryJson,
    warningCount: warnings.length,
  };
}
