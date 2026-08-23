// render/transform.js — block-level dispatch: tokenized module → HTML.
//
// Numbers (figure/table/example/equation) and the anchors map are assigned by
// the model pass (lib/model/numbering.js annotateContent) before rendering.
import { renderInline, mathSpanHtml, escapeHtml, texToPlain } from './inline.js';
import { renderTabular } from './tabular.js';

export function renderModule(mod, ctx) {
  ctx.mathSpans = mod.mathSpans;
  ctx.name = mod.name;
  return renderBlocks(mod.blocks, ctx);
}

export function renderBlocks(blocks, ctx) {
  return blocks.map(b => renderBlock(b, ctx)).join('\n');
}

function renderBlock(b, ctx) {
  switch (b.type) {
    case 'p':
      return `<p>${renderInline(b.text, ctx)}</p>`;
    case 'displayMath':
      return renderDisplayMath(ctx.mathSpans[b.span], ctx);
    case 'highlight':
      return `<div class="highlight-box" role="note">\n${renderBlocks(b.children, ctx)}\n</div>`;
    case 'center':
      return `<div class="center">\n${renderBlocks(b.children, ctx)}\n</div>`;
    case 'figure':
      return renderFigure(b, ctx);
    case 'tableFloat':
      return renderTableFloat(b, ctx);
    case 'tabular':
      return renderTabular(b, ctx);
    case 'list': {
      const tag = b.ordered ? 'ol' : 'ul';
      const items = b.items
        .map(item => {
          const label = item.label
            ? `<span class="item-label">${renderInline(item.label, ctx)}</span> `
            : '';
          return `<li>${label}${renderBlocks(item.children, ctx)}</li>`;
        })
        .join('\n');
      return `<${tag}>\n${items}\n</${tag}>`;
    }
    case 'example': {
      const id = b.htmlId ? ` id="${escapeHtml(b.htmlId)}"` : '';
      const title = b.number ? `Example ${b.number}` : 'Example';
      return (
        `<div class="example"${id}>\n<p class="example-title">${escapeHtml(title)}</p>\n` +
        `${renderBlocks(b.children, ctx)}\n</div>`
      );
    }
    case 'subheading':
      return `<h2>${renderInline(b.title, ctx)}</h2>`;
    case 'centerline':
      return `<div class="centerline">${renderInline(b.text, ctx)}</div>`;
    default:
      ctx.warnings.push(`${ctx.name}: unrendered block type ${b.type}`);
      return '';
  }
}

function renderDisplayMath(span, ctx) {
  if (span.kind === 'display' || span.kind === 'inline') {
    return `<div class="equation-block">${mathSpanHtml({ ...span, kind: 'display' })}</div>`;
  }
  // env span: id anchors for every labeled row; first label names the block.
  const labels = (span.rows ?? []).flatMap(r => r.labels ?? []);
  const id = labels.length ? ` id="${escapeHtml(labels[0])}"` : '';
  const stubs = labels
    .slice(1)
    .map(l => `<span id="${escapeHtml(l)}" class="label-anchor"></span>`)
    .join('');
  return `<div class="equation-block"${id}>${stubs}${mathSpanHtml(span)}</div>`;
}

function renderFigure(b, ctx) {
  const id = b.label ? ` id="${escapeHtml(b.label)}"` : '';
  const images = b.items
    .map(item => {
      if (item.text !== undefined) {
        // Panel sub-captions like "(a) Potential." between images.
        return `<div class="figure-text">${renderInline(item.text, ctx)}</div>`;
      }
      const img = item.img;
      const src = `/figures/${ctx.figureFile(img.file)}`;
      const alt = escapeHtml(texToPlain(img.alt || '', ctx.mathSpans));
      const style = img.widthIn ? ` style="max-width: ${Math.round(img.widthIn * 96)}px"` : '';
      return `<img src="${escapeHtml(src)}" alt="${alt}" loading="lazy"${style} />`;
    })
    .join('\n');
  const number = b.number ? `<span class="figure-number">Figure ${escapeHtml(b.number)}.</span> ` : '';
  const caption = b.caption ? renderInline(b.caption, ctx) : '';
  const credit = b.credit
    ? ` <span class="figure-credit">${renderInline(b.credit, ctx)}</span>`
    : '';
  return (
    `<figure${id}>\n${images}\n` +
    `<figcaption>${number}${caption}${credit}</figcaption>\n</figure>`
  );
}

function renderTableFloat(b, ctx) {
  const id = b.label ? ` id="${escapeHtml(b.label)}"` : '';
  const number = b.number ? `<span class="table-number">Table ${escapeHtml(b.number)}.</span> ` : '';
  const caption =
    b.caption || b.number
      ? `<figcaption>${number}${b.caption ? renderInline(b.caption, ctx) : ''}</figcaption>\n`
      : '';
  return `<figure class="table-float"${id}>\n${caption}${renderBlocks(b.children, ctx)}\n</figure>`;
}
