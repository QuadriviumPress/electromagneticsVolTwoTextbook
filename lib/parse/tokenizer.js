// parse/tokenizer.js — one module .tex → structured block list.
//
// Order is load-bearing:
//   1. %ORB metadata comes from the header comments (read before stripping).
//   2. Comments are stripped line-by-line (safe before math protection: the
//      corpus has no literal % inside \url/\href arguments at brace depth 0).
//   3. Math is protected FIRST: every math span is replaced by a private-use
//      placeholder and stored verbatim, so math backslashes, &, _, \\ are
//      invisible to every later stage (block segmentation, tabular cell
//      splitting, inline rendering).
//   4. Block segmentation walks the placeholder-bearing text with an
//      environment stack; unknown structure warns loudly and recovers.
import { stripLineComment, extractBraceGroup } from './tex-utils.js';

export const PH_OPEN = '\uE000';
export const PH_CLOSE = '\uE001';
const PH_RE = /\uE000(\d+)\uE001/g;

const MATH_ENV_RE = /^\\begin\{(equation|flalign|align|multline)(\*?)\}/;

// Text-level environments handled as blocks. Everything else inside a module
// is either math (already protected) or inline content.
const TEXT_ENVS = new Set([
  'mdframed',
  'figure',
  'figure*',
  'table',
  'table*',
  'center',
  'itemize',
  'enumerate',
  'example',
  'tabular',
]);

export function tokenize(source, { name = 'module' } = {}) {
  const warnings = [];
  const notices = []; // source quirks worth reporting but not failing CI (e.g. missing alt text)
  const meta = extractOrbMeta(source);
  const stripped = stripComments(source);
  const { text, mathSpans } = protectMath(stripped, warnings, name);
  const ctx = { warnings, notices, name, mathSpans };
  const blocks = parseBlocks(text, ctx);
  const label = findModuleLabel(text, name);
  return { meta, label, blocks, mathSpans, warnings, notices };
}

function extractOrbMeta(source) {
  const meta = {};
  for (const line of source.split('\n')) {
    const m = line.match(/^%ORB (TITLE|AUTHOR|DATE|ABSTRACT)\s*(.*)$/);
    if (!m) continue;
    // AUTHOR/DATE carry trailing "# comment" annotations.
    const value = m[2].split('#')[0].trim();
    meta[m[1].toLowerCase()] = value;
  }
  return meta;
}

function stripComments(source) {
  const out = [];
  for (const line of source.split('\n')) {
    if (line.trimStart().startsWith('%')) continue; // pure comment: no blank line left behind
    out.push(stripLineComment(line));
  }
  return out.join('\n');
}

export function protectMath(text, warnings, name) {
  const mathSpans = [];
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\') {
      const m = MATH_ENV_RE.exec(text.slice(i, i + 30));
      if (m) {
        const env = m[1] + m[2];
        const close = `\\end{${env}}`;
        const end = text.indexOf(close, i);
        if (end === -1) {
          warnings.push(`${name}: unterminated \\begin{${env}}`);
          out += ch;
          i++;
          continue;
        }
        const spanEnd = end + close.length;
        mathSpans.push({ kind: 'env', env, tex: text.slice(i, spanEnd) });
        out += PH_OPEN + (mathSpans.length - 1) + PH_CLOSE;
        i = spanEnd;
        continue;
      }
      out += text.slice(i, i + 2); // escaped char (incl. \$) stays verbatim
      i += 2;
      continue;
    }
    if (ch === '$') {
      const isDisplay = text[i + 1] === '$';
      const delimLen = isDisplay ? 2 : 1;
      let j = i + delimLen;
      let found = -1;
      while (j < text.length) {
        if (text[j] === '\\') {
          j += 2;
          continue;
        }
        if (text[j] === '$' && (!isDisplay || text[j + 1] === '$')) {
          found = j;
          break;
        }
        j++;
      }
      if (found === -1) {
        warnings.push(`${name}: unterminated ${isDisplay ? '$$' : '$'} math`);
        out += ch;
        i++;
        continue;
      }
      mathSpans.push({
        kind: isDisplay ? 'display' : 'inline',
        tex: text.slice(i + delimLen, found),
      });
      out += PH_OPEN + (mathSpans.length - 1) + PH_CLOSE;
      i = found + delimLen;
      continue;
    }
    out += ch;
    i++;
  }
  return { text: out, mathSpans };
}

function findModuleLabel(text, name) {
  const m = text.match(/\\label\{(m\d{4}_[^}]+)\}/);
  return m && name.startsWith(m[1].slice(0, 5)) ? m[1] : null;
}

function parseBlocks(text, ctx) {
  const blocks = [];
  let buf = '';
  const flush = () => {
    if (buf) blocks.push(...paragraphBlocks(buf, ctx));
    buf = '';
  };

  let i = 0;
  while (i < text.length) {
    if (text[i] === '\\') {
      const begin = /^\\begin\{([a-zA-Z]+\*?)\}/.exec(text.slice(i, i + 24));
      if (begin && TEXT_ENVS.has(begin[1])) {
        flush();
        const env = begin[1];
        const { inner, end } = extractEnv(text, i, env, ctx);
        blocks.push(envBlock(env, inner, ctx));
        i = end;
        continue;
      }
      if (text.startsWith('\\section*{', i) || text.startsWith('\\section{', i)) {
        flush();
        const braceAt = text.indexOf('{', i);
        const group = extractBraceGroup(text, braceAt);
        if (!group) {
          ctx.warnings.push(`${ctx.name}: unbalanced \\section title`);
          i = braceAt + 1;
          continue;
        }
        blocks.push({ type: 'subheading', title: group.value.trim() });
        i = group.end;
        continue;
      }
      if (text.startsWith('\\centerline{', i)) {
        flush();
        const group = extractBraceGroup(text, i + '\\centerline'.length);
        if (!group) {
          ctx.warnings.push(`${ctx.name}: unbalanced \\centerline`);
          i += '\\centerline'.length;
          continue;
        }
        blocks.push({ type: 'centerline', text: group.value });
        i = group.end;
        continue;
      }
      // A stray \end{...} here means the environment stack is out of balance:
      // warn and skip the token rather than crashing or looping.
      const strayEnd = /^\\end\{([a-zA-Z]+\*?)\}/.exec(text.slice(i, i + 24));
      if (strayEnd && TEXT_ENVS.has(strayEnd[1])) {
        ctx.warnings.push(`${ctx.name}: unbalanced \\end{${strayEnd[1]}}`);
        i += strayEnd[0].length;
        continue;
      }
      buf += text.slice(i, i + 2);
      i += 2;
      continue;
    }
    buf += text[i];
    i++;
  }
  flush();
  return blocks;
}

function extractEnv(text, start, env, ctx) {
  const open = `\\begin{${env}}`;
  const close = `\\end{${env}}`;
  let depth = 0;
  let i = start;
  while (i < text.length) {
    if (text.startsWith(open, i)) {
      depth++;
      i += open.length;
      continue;
    }
    if (text.startsWith(close, i)) {
      depth--;
      if (depth === 0) {
        return { inner: text.slice(start + open.length, i), end: i + close.length };
      }
      i += close.length;
      continue;
    }
    i++;
  }
  ctx.warnings.push(`${ctx.name}: unbalanced \\begin{${env}} (recovered at end of module)`);
  return { inner: text.slice(start + open.length), end: text.length };
}

/** Drop a leading [ ... ] optional-argument group (e.g. mdframed options, figure placement). */
function skipOptionalArg(inner) {
  const trimmed = inner.replace(/^\s+/, '');
  if (!trimmed.startsWith('[')) return inner;
  const end = trimmed.indexOf(']');
  if (end === -1) return inner;
  return trimmed.slice(end + 1);
}

function envBlock(env, inner, ctx) {
  switch (env) {
    case 'mdframed':
      return { type: 'highlight', children: parseBlocks(skipOptionalArg(inner), ctx) };
    case 'figure':
    case 'figure*':
      return parseFigure(skipOptionalArg(inner), ctx);
    case 'table':
    case 'table*':
      return parseTableFloat(skipOptionalArg(inner), ctx);
    case 'center':
      return { type: 'center', children: parseBlocks(inner, ctx) };
    case 'example':
      return { type: 'example', children: parseBlocks(inner, ctx) };
    case 'itemize':
    case 'enumerate':
      return {
        type: 'list',
        ordered: env === 'enumerate',
        items: parseListItems(inner, ctx),
      };
    case 'tabular':
      return parseTabular(inner, ctx);
    default:
      ctx.warnings.push(`${ctx.name}: unhandled environment ${env}`);
      return { type: 'p', text: inner };
  }
}

function parseListItems(inner, ctx) {
  const items = [];
  let current = null;
  let depth = 0;
  let i = 0;
  let segStart = 0;
  const pushCurrent = end => {
    if (current === null) return;
    const body = inner.slice(current.bodyStart, end);
    items.push({ label: current.label, children: parseBlocks(body, ctx) });
  };
  while (i < inner.length) {
    if (inner[i] === '\\') {
      if (depth === 0 && inner.startsWith('\\item', i) && !/[a-zA-Z]/.test(inner[i + 5] ?? '')) {
        pushCurrent(i);
        let bodyStart = i + '\\item'.length;
        let label = null;
        const rest = inner.slice(bodyStart);
        const optMatch = rest.match(/^\s*\[/);
        if (optMatch) {
          const open = bodyStart + optMatch[0].length - 1;
          const closeIdx = inner.indexOf(']', open);
          if (closeIdx !== -1) {
            label = inner.slice(open + 1, closeIdx);
            bodyStart = closeIdx + 1;
          }
        }
        current = { label, bodyStart };
        i = bodyStart;
        continue;
      }
      if (/^\\begin\{/.test(inner.slice(i, i + 8))) depth++;
      if (/^\\end\{/.test(inner.slice(i, i + 6))) depth--;
      i += 2;
      continue;
    }
    i++;
  }
  pushCurrent(inner.length);
  if (items.length === 0) {
    ctx.warnings.push(`${ctx.name}: list environment without \\item`);
  }
  return items;
}

/**
 * Figures in this corpus follow a rigid pattern:
 *   \begin{center} \pdftooltip{{\includegraphics[width=..]{modules/X.eps}}}{ALT} \end{center}
 *   \centerline{\scriptsize \copyright~... credit ...}
 *   \caption{\label{ID} caption text}
 * The \pdftooltip second argument is authored alt text — preserved for <img alt>.
 */
function parseFigure(inner, ctx) {
  const items = []; // ordered: {img: {file, widthIn, alt}} | {text} (panel sub-captions)
  let credit = null;
  let caption = null;
  let label = null;

  let buf = '';
  const flushText = () => {
    const text = buf
      .replace(/\\begin\{center\}|\\end\{center\}/g, '')
      .replace(/(\\\\|~|\s)+$|^(\\\\|~|\s)+/g, '');
    if (text !== '') items.push({ text });
    buf = '';
  };

  let i = 0;
  while (i < inner.length) {
    if (inner.startsWith('\\pdftooltip', i)) {
      flushText();
      const g1 = extractBraceGroup(inner, inner.indexOf('{', i));
      if (!g1) {
        ctx.warnings.push(`${ctx.name}: unbalanced \\pdftooltip`);
        break;
      }
      const g2 = extractBraceGroup(inner, skipWs(inner, g1.end));
      const img = parseIncludegraphics(g1.value, ctx);
      if (img) items.push({ img: { ...img, alt: g2 ? g2.value : '' } });
      i = g2 ? g2.end : g1.end;
      continue;
    }
    if (inner.startsWith('\\includegraphics', i)) {
      // Bare image outside \pdftooltip: no authored alt text in the source.
      flushText();
      const m = parseIncludegraphics(inner.slice(i), ctx);
      if (m) {
        ctx.notices.push(`${ctx.name}: figure image without \\pdftooltip alt text: ${m.file}`);
        items.push({ img: { ...m, alt: '' } });
        i += inner.slice(i).match(/\\includegraphics(?:\[[^\]]*\])?\{[^}]+\}/)[0].length;
        continue;
      }
      i += '\\includegraphics'.length;
      continue;
    }
    if (inner.startsWith('\\centerline{', i)) {
      flushText();
      const group = extractBraceGroup(inner, i + '\\centerline'.length);
      if (group) {
        credit = group.value;
        i = group.end;
        continue;
      }
    }
    if (inner.startsWith('\\caption{', i)) {
      flushText();
      const group = extractBraceGroup(inner, i + '\\caption'.length);
      if (group) {
        let text = group.value;
        const labelMatch = text.match(/\\label\{([^}]+)\}/);
        if (labelMatch) {
          label = labelMatch[1];
          text = text.replace(labelMatch[0], '');
        }
        caption = text.trim();
        i = group.end;
        continue;
      }
    }
    if (inner.startsWith('\\label{', i)) {
      // Standalone label directly in the figure body (m0129 places it after \caption).
      const group = extractBraceGroup(inner, i + '\\label'.length);
      if (group) {
        if (!label) label = group.value;
        i = group.end;
        continue;
      }
    }
    buf += inner[i];
    i++;
  }
  flushText();

  const images = items.filter(it => it.img).map(it => it.img);
  if (images.length === 0) ctx.warnings.push(`${ctx.name}: figure without \\includegraphics`);
  if (!label) ctx.warnings.push(`${ctx.name}: figure without a \\label`);
  return { type: 'figure', items, images, credit, caption, label };
}

function skipWs(text, i) {
  while (i < text.length && /\s/.test(text[i])) i++;
  return i;
}

function parseIncludegraphics(text, ctx) {
  const m = text.match(/\\includegraphics(?:\[([^\]]*)\])?\{([^}]+)\}/);
  if (!m) return null;
  const opts = m[1] || '';
  const widthMatch = opts.match(/width\s*=\s*([\d.]+)\s*in/);
  return {
    file: m[2].replace(/^modules\//, ''),
    widthIn: widthMatch ? parseFloat(widthMatch[1]) : null,
  };
}

function parseTableFloat(inner, ctx) {
  let caption = null;
  let label = null;
  const capIdx = inner.indexOf('\\caption{');
  let rest = inner;
  if (capIdx !== -1) {
    const group = extractBraceGroup(inner, capIdx + '\\caption'.length);
    if (group) {
      let text = group.value;
      const labelMatch = text.match(/\\label\{([^}]+)\}/);
      if (labelMatch) {
        label = labelMatch[1];
        text = text.replace(labelMatch[0], '');
      }
      caption = text.trim();
      rest = inner.slice(0, capIdx) + inner.slice(group.end);
    }
  }
  return { type: 'tableFloat', caption, label, children: parseBlocks(rest, ctx) };
}

function parseTabular(inner, ctx) {
  const specGroup = extractBraceGroup(inner, skipWs(inner, 0));
  if (!specGroup) {
    ctx.warnings.push(`${ctx.name}: tabular without column spec`);
    return { type: 'p', text: inner };
  }
  const columns = [];
  for (const ch of specGroup.value) {
    if (ch === 'l') columns.push('left');
    else if (ch === 'c') columns.push('center');
    else if (ch === 'r') columns.push('right');
    // | borders and spacing are handled by site CSS, not per-column rules.
  }

  const body = inner.slice(specGroup.end);
  // Split rows on \\ at zero brace/env depth (math cells are placeholders, so
  // no math \\ can interfere).
  const rows = [];
  let depth = 0;
  let start = 0;
  let hlineForNext = 0;
  const pushRow = end => {
    let text = body.slice(start, end);
    let hlines = hlineForNext;
    hlineForNext = 0;
    let m;
    while ((m = text.match(/^\s*\\hline/))) {
      hlines++;
      text = text.slice(m[0].length);
    }
    const trailing = text.match(/(\\hline\s*)+$/);
    if (trailing) {
      hlineForNext = (trailing[0].match(/\\hline/g) || []).length;
      text = text.slice(0, trailing.index);
    }
    if (text.trim() === '') {
      // A "row" of pure \hline (e.g. after the final \\) is the table's bottom
      // rule: carry it so `bottomline` survives.
      hlineForNext = hlines;
      return;
    }
    const cells = splitTopLevel(text, '&').map(c => c.trim());
    rows.push({ cells, topline: hlines > 0 });
  };
  let i = 0;
  while (i < body.length) {
    if (body[i] === '\\') {
      if (body[i + 1] === '\\' && depth === 0) {
        pushRow(i);
        start = i + 2;
        i += 2;
        continue;
      }
      if (/^\\begin\{/.test(body.slice(i, i + 8))) depth++;
      if (/^\\end\{/.test(body.slice(i, i + 6))) depth--;
      i += 2;
      continue;
    }
    if (body[i] === '{') depth++;
    if (body[i] === '}') depth--;
    i++;
  }
  pushRow(body.length);
  return { type: 'tabular', columns, rows, bottomline: hlineForNext > 0 };
}

function splitTopLevel(text, sep) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    else if (ch === sep && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

function paragraphBlocks(buf, ctx) {
  const blocks = [];
  for (const para of buf.split(/\n\s*\n/)) {
    // Split the paragraph around display-math placeholders: HTML <p> cannot
    // contain block-level math containers.
    let last = 0;
    const pieces = [];
    PH_RE.lastIndex = 0;
    let m;
    while ((m = PH_RE.exec(para))) {
      const span = ctx.mathSpans[Number(m[1])];
      if (span.kind === 'inline') continue;
      pieces.push({ text: para.slice(last, m.index) });
      pieces.push({ math: Number(m[1]) });
      last = m.index + m[0].length;
    }
    pieces.push({ text: para.slice(last) });
    for (const piece of pieces) {
      if (piece.math !== undefined) {
        blocks.push({ type: 'displayMath', span: piece.math });
      } else if (piece.text && piece.text.trim() !== '') {
        blocks.push({ type: 'p', text: piece.text.trim() });
      }
    }
  }
  return blocks;
}
