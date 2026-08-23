// model/book-index.js — \index entries → alphabetical book index.
//
// Handled syntax (all that occurs in the corpus):
//   term                    plain entry
//   term!sub                sub-entry
//   alias|see{target}       cross-reference, no page ref
//   term|( ... term|)       page range: collapses to the opening location
//                           (references are page-granular on the web)
import { texToPlain } from '../render/inline.js';

export function buildBookIndex(indexEntries, warnings) {
  const terms = new Map(); // sortKey -> { display, refs, see, subs: Map }

  const getTerm = raw => {
    const display = texToPlain(raw);
    const key = display.toLowerCase();
    if (!terms.has(key)) {
      terms.set(key, { display, refs: new Map(), see: [], subs: new Map() });
    }
    return terms.get(key);
  };

  for (const entry of indexEntries) {
    let body = entry.raw;
    let modifier = null;
    const pipeIdx = body.indexOf('|');
    if (pipeIdx !== -1) {
      modifier = body.slice(pipeIdx + 1);
      body = body.slice(0, pipeIdx);
    }
    const [termRaw, subRaw] = body.split('!');
    const term = getTerm(termRaw);

    let target = term;
    if (subRaw !== undefined) {
      const subDisplay = texToPlain(subRaw);
      const subKey = subDisplay.toLowerCase();
      if (!term.subs.has(subKey)) {
        term.subs.set(subKey, { display: subDisplay, refs: new Map(), see: [] });
      }
      target = term.subs.get(subKey);
    }

    if (modifier !== null) {
      if (modifier.startsWith('see{')) {
        const seeTarget = texToPlain(modifier.slice(4, -1));
        if (!target.see.includes(seeTarget)) target.see.push(seeTarget);
        continue;
      }
      if (modifier === ')') continue; // range close: opening location already recorded
      if (modifier !== '(') {
        warnings.push(`book index: unrecognized modifier "|${modifier}" in \\index{${entry.raw}}`);
        continue;
      }
      // modifier '(' falls through: record the opening location
    }

    // One ref per page; keep the first anchor on that page.
    if (!target.refs.has(entry.page.url)) {
      target.refs.set(entry.page.url, {
        url: entry.page.url,
        id: entry.id,
        label: entry.page.number ?? entry.page.displayTitle,
      });
    }
  }

  // Alphabetical, grouped by first letter.
  const sorted = [...terms.values()].sort((a, b) =>
    a.display.localeCompare(b.display, 'en', { sensitivity: 'base' })
  );
  const letters = new Map();
  for (const term of sorted) {
    const first = term.display[0]?.toUpperCase() ?? '#';
    const letter = /[A-Z]/.test(first) ? first : '#';
    if (!letters.has(letter)) letters.set(letter, []);
    letters.get(letter).push({
      display: term.display,
      refs: [...term.refs.values()],
      see: term.see,
      subs: [...term.subs.values()]
        .sort((a, b) => a.display.localeCompare(b.display, 'en', { sensitivity: 'base' }))
        .map(sub => ({ display: sub.display, refs: [...sub.refs.values()], see: sub.see })),
    });
  }
  return [...letters.entries()].map(([letter, entries]) => ({ letter, entries }));
}
