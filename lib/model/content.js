// model/content.js — pass over loaded modules in reading order: assign
// chapter-scoped numbers (figures, tables, examples, equations) and build the
// global anchors map used to resolve \ref/\hyperref.
//
// Equation numbering is server-authoritative: MathJax runs with tags:'none'
// and every number is injected as \tag{...} here, so displayed tags, \ref
// link text, and the print edition agree. flalign/align number per row (the
// book labels individual rows); \nonumber suppresses a row's number.
//
// Loaded module data is cached across dev-server rebuilds, so this pass only
// SETS values (idempotent) — it never increments values stored on blocks.

export function annotateContent(model, loadedModules, warnings) {
  const anchors = new Map();

  for (const page of model.pages) {
    const chapter = page.chapter;
    if (!chapter.counters) {
      chapter.counters = { figure: 0, table: 0, equation: 0, example: 0 };
    }
    for (const name of page.modules) {
      const mod = loadedModules.get(name);
      if (!mod) continue;
      if (mod.label) {
        anchors.set(mod.label, {
          url: page.url,
          id: '',
          number: page.number ?? page.displayTitle,
          kind: 'section',
        });
      }
      walkBlocks(mod.blocks, {
        page,
        chapter,
        anchors,
        mod,
        warnings,
        contextNumber: page.number,
      });
    }
  }
  return anchors;
}

function numberPrefix(chapter) {
  return chapter.number; // '1'..'9' or 'A'..'C'; null for the preface
}

function nextNumber(chapter, counter, page, warnings) {
  const prefix = numberPrefix(chapter);
  if (prefix === null) {
    // Front-matter content is unnumbered in print too (e.g. the example in
    // the Preface); render without a number, silently.
    return null;
  }
  chapter.counters[counter]++;
  return `${prefix}.${chapter.counters[counter]}`;
}

function walkBlocks(blocks, ctx) {
  for (const b of blocks) {
    switch (b.type) {
      case 'figure': {
        b.number = nextNumber(ctx.chapter, 'figure', ctx.page, ctx.warnings);
        if (b.label) {
          ctx.anchors.set(b.label, {
            url: ctx.page.url,
            id: b.label,
            number: b.number,
            kind: 'figure',
          });
        }
        if (b.caption) registerTextLabels(b.caption, { ...ctx, contextNumber: b.number });
        if (b.credit) registerTextLabels(b.credit, { ...ctx, contextNumber: b.number });
        break;
      }
      case 'tableFloat': {
        b.number = nextNumber(ctx.chapter, 'table', ctx.page, ctx.warnings);
        if (b.label) {
          ctx.anchors.set(b.label, {
            url: ctx.page.url,
            id: b.label,
            number: b.number,
            kind: 'table',
          });
        }
        walkBlocks(b.children, { ...ctx, contextNumber: b.number });
        break;
      }
      case 'example': {
        b.number = nextNumber(ctx.chapter, 'example', ctx.page, ctx.warnings);
        b.htmlId = `example-${(b.number ?? '').replace('.', '-') || 'x'}`;
        walkBlocks(b.children, { ...ctx, contextNumber: b.number });
        break;
      }
      case 'highlight':
      case 'center':
        walkBlocks(b.children, ctx);
        break;
      case 'list':
        for (const item of b.items) walkBlocks(item.children, ctx);
        break;
      case 'displayMath':
        annotateMathSpan(ctx.mod.mathSpans[b.span], ctx);
        break;
      case 'p':
        registerTextLabels(b.text, ctx);
        break;
      case 'centerline':
        registerTextLabels(b.text, ctx);
        break;
      case 'subheading':
        registerTextLabels(b.title, ctx);
        break;
      default:
        break;
    }
  }
}

/** Any \label{X} in flowing text anchors to this page (e.g. _Credit targets). */
function registerTextLabels(text, ctx) {
  for (const m of text.matchAll(/\\label\{([^}]+)\}/g)) {
    ctx.anchors.set(m[1], {
      url: ctx.page.url,
      id: m[1],
      number: ctx.contextNumber ?? ctx.page.number,
      kind: 'text',
    });
  }
}

function annotateMathSpan(span, ctx) {
  if (span.kind !== 'env') return; // $$..$$ displays are unnumbered in this book

  const open = `\\begin{${span.env}}`;
  const close = `\\end{${span.env}}`;
  const body = span.tex.slice(open.length, span.tex.length - close.length);

  const perRow = span.env === 'flalign' || span.env === 'align';
  const rowTexts = perRow ? splitRows(body) : [body];

  span.rows = [];
  const renderedRows = [];
  for (const rowText of rowTexts) {
    if (rowText.trim() === '') continue;
    const labels = [...rowText.matchAll(/\\label\{([^}]+)\}/g)].map(m => m[1]);
    const suppressed = /\\nonumber\b/.test(rowText);
    const number = suppressed
      ? null
      : nextNumber(ctx.chapter, 'equation', ctx.page, ctx.warnings);
    for (const label of labels) {
      ctx.anchors.set(label, {
        url: ctx.page.url,
        id: labels[0], // all row labels resolve to the block/first-label anchor
        number: number ?? '?',
        kind: 'equation',
      });
      if (number === null) {
        ctx.warnings.push(`${ctx.mod.name ?? ctx.page.url}: \\label{${label}} on unnumbered row`);
      }
    }
    let cleaned = rowText
      .replace(/\\label\{[^}]+\}/g, '')
      .replace(/\\nonumber\b/g, '')
      .replace(/[ \t]+$/gm, '');
    if (number !== null) cleaned = `${cleaned.trimEnd()} \\tag{${number}}`;
    span.rows.push({ labels, number });
    renderedRows.push(cleaned);
  }

  span.rendered = open + renderedRows.join(' \\\\\n') + close;
}

/** Split an align/flalign body on \\ at zero brace/environment depth. */
function splitRows(body) {
  const rows = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < body.length) {
    const ch = body[i];
    if (ch === '\\') {
      if (body[i + 1] === '\\' && depth === 0) {
        rows.push(body.slice(start, i));
        start = i + 2;
        i += 2;
        continue;
      }
      if (/^\\begin\{/.test(body.slice(i, i + 8))) depth++;
      if (/^\\end\{/.test(body.slice(i, i + 6))) depth--;
      i += 2;
      continue;
    }
    if (ch === '{') depth++;
    if (ch === '}') depth--;
    i++;
  }
  rows.push(body.slice(start));
  return rows;
}
