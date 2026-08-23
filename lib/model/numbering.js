// model/numbering.js — assign chapter/section numbers and URLs, and lay out the
// site's page list in reading order.
//
// Page kinds:
//   chapter    — landing page: chapter-preface module content (if any) + section list
//   section    — one \section == one page; continuation modules (m0085) render
//                on their host section's page
//   end-matter — the Ch_End_Matter module (image credits etc.)
//
// Numbering matches the print edition: main chapters 1..N, appendices A..C,
// sections <chapter>.<k>. Preface sections are unnumbered (starred).
import { slugify } from './slugs.js';
import { texToPlain } from '../render/inline.js';

export function buildModel(structure) {
  const chapters = [];
  const pages = [];
  let mainCount = 0;
  let appendixCount = 0;

  for (const src of structure.chapters) {
    let number = null;
    if (src.mode === 'main') number = String(++mainCount);
    if (src.mode === 'appendix') {
      number = String.fromCharCode('A'.charCodeAt(0) + appendixCount++);
    }

    const plainTitle = texToPlain(src.title);
    const slug = slugify(plainTitle);
    const urlBase = number === null ? `/${slug}/` : `/${number.toLowerCase()}-${slug}/`;

    const chapter = {
      mode: src.mode,
      number,
      title: src.title,
      plainTitle,
      displayTitle: number === null ? plainTitle : `${number} ${plainTitle}`,
      url: urlBase,
      prefaceModule: src.prefaceModule,
      endMatterModule: src.endMatterModule,
      sections: [],
    };

    let sectionCount = 0;
    for (const s of src.sections) {
      const sNumber =
        number !== null && !s.starred ? `${number}.${++sectionCount}` : null;
      const sPlain = texToPlain(s.title);
      const sSlug = slugify(sPlain);
      const sUrl =
        sNumber !== null
          ? `/${number.toLowerCase()}-${sectionCount}-${sSlug}/`
          : `/${slug}-${sSlug}/`;
      chapter.sections.push({
        title: s.title,
        plainTitle: sPlain,
        number: sNumber,
        displayTitle: sNumber === null ? sPlain : `${sNumber} ${sPlain}`,
        url: sUrl,
        modules: s.modules,
      });
    }
    chapters.push(chapter);

    // Pages in reading order: landing, sections, end matter.
    pages.push({
      kind: 'chapter',
      permalink: `${chapter.url}index.html`,
      url: chapter.url,
      displayTitle: chapter.displayTitle,
      title: chapter.title,
      number,
      chapter,
      modules: chapter.prefaceModule ? [chapter.prefaceModule] : [],
    });
    for (const s of chapter.sections) {
      pages.push({
        kind: 'section',
        permalink: `${s.url}index.html`,
        url: s.url,
        displayTitle: s.displayTitle,
        title: s.title,
        number: s.number,
        chapter,
        section: s,
        modules: s.modules,
      });
    }
    if (chapter.endMatterModule) {
      const url =
        number === null ? `/${slug}-end-matter/` : `/${number.toLowerCase()}-end-matter/`;
      pages.push({
        kind: 'end-matter',
        permalink: `${url}index.html`,
        url,
        displayTitle:
          number === null ? `${plainTitle}: End Matter` : `${number} ${plainTitle}: End Matter`,
        title: 'End Matter',
        number: null,
        chapter,
        modules: [chapter.endMatterModule],
      });
      chapter.endMatterUrl = url;
    }
  }

  return { chapters, pages };
}
