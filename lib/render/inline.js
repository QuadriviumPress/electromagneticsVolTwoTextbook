// render/inline.js — inline-level LaTeX → HTML.
//
// A tiny recursive-descent renderer over text runs, {groups}, \commands, and
// math placeholders. HTML escaping applies ONLY to text runs and math source,
// never to generated markup, so there are no escape-ordering bugs. Unknown
// commands render their argument text and are recorded via ctx.unknown() —
// the build fails CI if that report is non-empty (loud, never silent).
import { extractBraceGroup } from '../parse/tex-utils.js';

const PH_OPEN = '\uE000';
const PH_CLOSE = '\uE001';

export function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;'); // safe in text nodes, required in attribute values
}

/** LaTeX ligatures/typography on an (already HTML-escaped) text run. */
function typography(s) {
  return s
    .replace(/---/g, '—')
    .replace(/--/g, '–')
    .replace(/``/g, '“')
    .replace(/''/g, '”')
    .replace(/`/g, '‘')
    .replace(/'/g, '’')
    .replace(/~/g, ' ');
}

/**
 * Plain-text projection (slugs, <title>, sidebar labels, img alt, search).
 * Math spans are restored to their TeX text, then commands are dropped.
 */
export function texToPlain(tex, mathSpans) {
  let s = tex;
  if (mathSpans) {
    s = s.replace(new RegExp(`${PH_OPEN}(\\d+)${PH_CLOSE}`, 'g'), (_, n) => mathSpans[n].tex);
  }
  return s
    .replace(/\$\$?([^$]*)\$\$?/g, '$1') // unwrap math, keep its text
    .replace(/\\(bf|it|em|tt|rm|sc|scriptsize|footnotesize|tiny|small)\b\s*/g, '')
    .replace(/\\([%&_#$])/g, '$1')
    .replace(/~/g, ' ')
    .replace(/``|''/g, '"')
    .replace(/\\[a-zA-Z]+\s*/g, '') // any remaining command
    .replace(/[{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Restore math placeholders to their original TeX (for metadata like \index args). */
export function resolvePlaceholders(text, mathSpans) {
  if (!mathSpans) return text;
  return text.replace(
    new RegExp(`${PH_OPEN}(\\d+)${PH_CLOSE}`, 'g'),
    (_, n) => `$${mathSpans[n].tex}$`
  );
}

/** Render one protected math span as MathJax-ready text. */
export function mathSpanHtml(span) {
  if (span.kind === 'inline') return `\\(${escapeHtml(span.tex)}\\)`;
  if (span.kind === 'display') return `\\[${escapeHtml(span.tex)}\\]`;
  return escapeHtml(span.rendered ?? span.tex); // env: \tag-rewritten at model pass
}

// Style switches valid at the start of a {group}: {\bf E} -> <strong>E</strong>.
const GROUP_STYLES = {
  bf: ['<strong>', '</strong>'],
  it: ['<em>', '</em>'],
  em: ['<em>', '</em>'],
  tt: ['<code>', '</code>'],
  sc: ['<span class="smallcaps">', '</span>'],
  rm: ['', ''],
  scriptsize: ['<small>', '</small>'],
  footnotesize: ['<small>', '</small>'],
  tiny: ['<small>', '</small>'],
  small: ['<small>', '</small>'],
  normalsize: ['', ''],
};

// Zero-argument commands that render as fixed text.
const SYMBOLS = {
  copyright: '©',
  ldots: '…',
  dots: '…',
  S: '§',
  textbackslash: '\\',
  textasciitilde: '~',
  quad: ' ',
  qquad: '  ',
};

// Commands dropped entirely (layout-only; no arguments consumed).
const DROP = new Set([
  'vfill',
  'hfill',
  'break',
  'newpage',
  'clearpage',
  'noindent',
  'indent',
  'raggedright',
  'bigskip',
  'medskip',
  'smallskip',
  'onecolumn',
  'twocolumn',
  'centering',
  'relax',
  'protect',
  'scriptsize', // bare size switch outside a group: style scope not tracked
  'footnotesize',
  'tiny',
  'small',
  'normalsize',
]);

// Commands whose argument groups are consumed and dropped.
const DROP_WITH_ARGS = {
  vspace: 1,
  hspace: 1,
  thispagestyle: 1,
  pagestyle: 1,
  fancyhf: 1,
  fancyfoot: 1,
  fancyhead: 1,
  setlength: 2,
  setcounter: 2,
  addcontentsline: 3,
  markboth: 2,
  phantomsection: 0,
};

export function renderInline(text, ctx) {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === PH_OPEN) {
      const end = text.indexOf(PH_CLOSE, i);
      const n = Number(text.slice(i + 1, end));
      out += mathSpanHtml(ctx.mathSpans[n]);
      i = end + 1;
      continue;
    }
    if (ch === '\\') {
      const res = renderCommand(text, i, ctx);
      out += res.html;
      i = res.end;
      continue;
    }
    if (ch === '{') {
      const group = extractBraceGroup(text, i);
      if (!group) {
        ctx.warnings.push(`${ctx.name}: unbalanced { in text`);
        i++;
        continue;
      }
      out += renderGroup(group.value, ctx);
      i = group.end;
      continue;
    }
    if (ch === '}') {
      ctx.warnings.push(`${ctx.name}: stray } in text`);
      i++;
      continue;
    }
    let j = i;
    while (j < text.length && !`\\{}${PH_OPEN}${PH_CLOSE}`.includes(text[j])) j++;
    out += typography(escapeHtml(text.slice(i, j)));
    i = j;
  }
  return out;
}

function renderGroup(inner, ctx) {
  const styleMatch = inner.match(/^\s*\\([a-zA-Z]+)\s*/);
  if (styleMatch && GROUP_STYLES[styleMatch[1]]) {
    const [open, close] = GROUP_STYLES[styleMatch[1]];
    return open + renderInline(inner.slice(styleMatch[0].length), ctx) + close;
  }
  // {\color{blue}...}: color switch scoped to the group.
  const colorMatch = inner.match(/^\s*\\color\{([a-zA-Z]+)\}\s*/);
  if (colorMatch) {
    return (
      `<span class="tex-color-${escapeHtml(colorMatch[1])}">` +
      renderInline(inner.slice(colorMatch[0].length), ctx) +
      '</span>'
    );
  }
  return renderInline(inner, ctx);
}

function getGroup(text, pos, ctx, cmd) {
  let i = pos;
  while (i < text.length && /\s/.test(text[i])) i++;
  if (text[i] !== '{') return null;
  const group = extractBraceGroup(text, i);
  if (!group) {
    ctx.warnings.push(`${ctx.name}: unbalanced argument of \\${cmd}`);
    return null;
  }
  return group;
}

function getOptional(text, pos) {
  let i = pos;
  while (i < text.length && /\s/.test(text[i])) i++;
  if (text[i] !== '[') return null;
  const close = text.indexOf(']', i);
  if (close === -1) return null;
  return { value: text.slice(i + 1, close), end: close + 1 };
}

function renderCommand(text, i, ctx) {
  const m = /^\\([a-zA-Z]+)(\*?)/.exec(text.slice(i));
  if (!m) {
    // Escaped single character: \% \& \_ \# \$ \{ \} \\ \, \; "\ "
    const c = text[i + 1];
    switch (c) {
      case '\\':
        return { html: '<br />', end: i + 2 };
      case '&':
        return { html: '&amp;', end: i + 2 };
      case '%':
      case '_':
      case '#':
      case '$':
      case '{':
      case '}':
        return { html: c, end: i + 2 };
      case ',':
      case ';':
        return { html: ' ', end: i + 2 };
      case ' ':
      case '\n':
        return { html: ' ', end: i + 2 };
      case "'":
      case '`':
      case '^':
      case '"': {
        // Accent commands: \'e or \'{e} — apply a combining accent to the base.
        const combining = { "'": '́', '`': '̀', '^': '̂', '"': '̈' }[c];
        let base = text[i + 2] ?? '';
        let end = i + 3;
        if (base === '{') {
          const group = extractBraceGroup(text, i + 2);
          if (group) {
            base = group.value;
            end = group.end;
          }
        }
        return { html: escapeHtml((base + combining).normalize('NFC')), end };
      }
      default:
        ctx.unknown(`\\${c ?? '<eof>'}`);
        return { html: '', end: i + 2 };
    }
  }

  const cmd = m[1];
  let pos = i + m[0].length;

  if (SYMBOLS[cmd] !== undefined) return { html: SYMBOLS[cmd], end: pos };
  if (DROP.has(cmd)) return { html: '', end: pos };
  if (DROP_WITH_ARGS[cmd] !== undefined) {
    const opt = getOptional(text, pos);
    if (opt) pos = opt.end;
    for (let k = 0; k < DROP_WITH_ARGS[cmd]; k++) {
      const g = getGroup(text, pos, ctx, cmd);
      if (!g) break;
      pos = g.end;
    }
    return { html: '', end: pos };
  }

  switch (cmd) {
    case 'emph':
    case 'textit': {
      const g = getGroup(text, pos, ctx, cmd);
      if (!g) return { html: '', end: pos };
      return { html: `<em>${renderInline(g.value, ctx)}</em>`, end: g.end };
    }
    case 'textbf': {
      const g = getGroup(text, pos, ctx, cmd);
      if (!g) return { html: '', end: pos };
      return { html: `<strong>${renderInline(g.value, ctx)}</strong>`, end: g.end };
    }
    case 'texttt': {
      const g = getGroup(text, pos, ctx, cmd);
      if (!g) return { html: '', end: pos };
      return { html: `<code>${renderInline(g.value, ctx)}</code>`, end: g.end };
    }
    case 'underline': {
      const g = getGroup(text, pos, ctx, cmd);
      if (!g) return { html: '', end: pos };
      return { html: `<u>${renderInline(g.value, ctx)}</u>`, end: g.end };
    }
    case 'mbox':
    case 'textrm':
    case 'textnormal': {
      const g = getGroup(text, pos, ctx, cmd);
      if (!g) return { html: '', end: pos };
      return { html: renderInline(g.value, ctx), end: g.end };
    }
    case 'centerline': {
      const g = getGroup(text, pos, ctx, cmd);
      if (!g) return { html: '', end: pos };
      return {
        html: `<div class="centerline">${renderInline(g.value, ctx)}</div>`,
        end: g.end,
      };
    }
    case 'href': {
      const gUrl = getGroup(text, pos, ctx, cmd);
      const gText = gUrl && getGroup(text, gUrl.end, ctx, cmd);
      if (!gUrl || !gText) return { html: '', end: pos };
      const url = gUrl.value.replace(/\\([%#&_])/g, '$1');
      return {
        html: `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${renderInline(gText.value, ctx)}</a>`,
        end: gText.end,
      };
    }
    case 'url': {
      const g = getGroup(text, pos, ctx, cmd);
      if (!g) return { html: '', end: pos };
      const url = g.value.replace(/\\([%#&_])/g, '$1');
      return { html: `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(url)}</a>`, end: g.end };
    }
    case 'hyperref': {
      const opt = getOptional(text, pos);
      const g = opt && getGroup(text, opt.end, ctx, cmd);
      if (!opt || !g) {
        ctx.unknown('\\hyperref (malformed)');
        return { html: '', end: pos };
      }
      const target = ctx.anchors && ctx.anchors.get(opt.value);
      const inner = renderInline(g.value, ctx);
      if (!target) {
        ctx.warnings.push(`${ctx.name}: unresolved \\hyperref[${opt.value}]`);
        return { html: `<span class="missing-ref" title="unresolved reference">${inner}</span>`, end: g.end };
      }
      return { html: `<a href="${anchorHref(target, ctx)}">${inner}</a>`, end: g.end };
    }
    case 'ref': {
      const g = getGroup(text, pos, ctx, cmd);
      if (!g) return { html: '', end: pos };
      const target = ctx.anchors && ctx.anchors.get(g.value);
      if (!target) {
        ctx.warnings.push(`${ctx.name}: unresolved \\ref{${g.value}}`);
        return { html: '<span class="missing-ref" title="unresolved reference">?</span>', end: g.end };
      }
      return {
        html: `<a href="${anchorHref(target, ctx)}">${escapeHtml(String(target.number ?? '?'))}</a>`,
        end: g.end,
      };
    }
    case 'label': {
      const g = getGroup(text, pos, ctx, cmd);
      if (!g) return { html: '', end: pos };
      return { html: `<span id="${escapeHtml(g.value)}" class="label-anchor"></span>`, end: g.end };
    }
    case 'index': {
      const g = getGroup(text, pos, ctx, cmd);
      if (!g) return { html: '', end: pos };
      const id = `idx-${ctx.nextIndexId()}`;
      ctx.indexEntries.push({
        raw: resolvePlaceholders(g.value, ctx.mathSpans),
        id,
        page: ctx.page,
      });
      return { html: `<span id="${id}" class="index-anchor"></span>`, end: g.end };
    }
    case 'footnote': {
      const g = getGroup(text, pos, ctx, cmd);
      if (!g) return { html: '', end: pos };
      const n = ctx.footnotes.length + 1;
      ctx.footnotes.push(renderInline(g.value, ctx));
      return {
        html: `<sup class="footnote-ref" id="fnref-${n}"><a href="#fn-${n}">[${n}]</a></sup>`,
        end: g.end,
      };
    }
    case 'pdftooltip': {
      // Outside figures (rare): render the content, use the tooltip as title.
      const g1 = getGroup(text, pos, ctx, cmd);
      const g2 = g1 && getGroup(text, g1.end, ctx, cmd);
      if (!g1 || !g2) return { html: '', end: pos };
      return { html: renderInline(g1.value, ctx), end: g2.end };
    }
    case 'color': {
      // Bare color switch outside a group: scope not tracked; drop the switch.
      const g = getGroup(text, pos, ctx, cmd);
      return { html: '', end: g ? g.end : pos };
    }
    case 'rule': {
      const opt = getOptional(text, pos);
      let p = opt ? opt.end : pos;
      for (let k = 0; k < 2; k++) {
        const g = getGroup(text, p, ctx, cmd);
        if (!g) break;
        p = g.end;
      }
      return { html: '<hr class="rule" />', end: p };
    }
    default: {
      ctx.unknown(`\\${cmd}`);
      // Best effort: render a single argument group's content if present.
      const g = getGroup(text, pos, ctx, cmd);
      if (g) return { html: renderInline(g.value, ctx), end: g.end };
      return { html: '', end: pos };
    }
  }
}

function anchorHref(target, ctx) {
  const samePage = ctx.page && target.url === ctx.page.url;
  const fragment = target.id ? `#${target.id}` : '';
  return samePage && fragment ? fragment : `${target.url}${fragment}`;
}
