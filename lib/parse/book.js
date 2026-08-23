// parse/book.js — orbd.tex → book structure.
//
// orbd.tex is rigidly structured: \chapter{...} headings followed by repeated
// \section{...} + \input{modules/...} pairs. A line-oriented scan is
// sufficient; titles are extracted with brace counting because they can nest
// groups (e.g. "(${\bf E}$)").
//
// \input classification (in order):
//   - a pending \section owns the next \input (one primary module per section)
//   - filename contains Ch_End_Matter        -> chapter end-matter module
//   - first content after \chapter           -> chapter preface module
//     (m0116, m0117, m0141)
//   - otherwise                              -> continuation of the previous
//     section (m0085 flows inside §3.12, matching the print edition)
import fs from 'node:fs';
import { bookFile } from '../paths.js';
import { stripLineComment, extractBraceGroup } from './tex-utils.js';

export function parseBook(root) {
  const tex = fs.readFileSync(bookFile(root), 'utf8');
  const body = tex.slice(
    tex.indexOf('\\begin{document}'),
    tex.indexOf('\\end{document}')
  );

  const warnings = [];
  const chapters = [];
  let mode = 'front'; // 'front' | 'main' | 'appendix'
  let chapter = null;
  let pendingSection = null;

  for (const raw of body.split('\n')) {
    const line = stripLineComment(raw);

    if (line.includes('\\frontmatter')) mode = 'front';
    if (line.includes('\\mainmatter')) mode = 'main';
    if (/^\s*\\appendix\b/.test(line)) mode = 'appendix';

    const chapterIdx = line.indexOf('\\chapter{');
    if (chapterIdx !== -1) {
      const group = extractBraceGroup(line, chapterIdx + '\\chapter'.length);
      if (!group) {
        warnings.push(`orbd.tex: unbalanced \\chapter title in: ${line.trim()}`);
        continue;
      }
      chapter = {
        mode,
        title: group.value.trim(),
        prefaceModule: null,
        sections: [],
        endMatterModule: null,
      };
      chapters.push(chapter);
      pendingSection = null;
      continue;
    }

    const sectionMatch = line.match(/\\section(\*?)\{/);
    if (sectionMatch) {
      const group = extractBraceGroup(
        line,
        line.indexOf(sectionMatch[0]) + sectionMatch[0].length - 1
      );
      if (!group) {
        warnings.push(`orbd.tex: unbalanced \\section title in: ${line.trim()}`);
        continue;
      }
      if (!chapter) {
        warnings.push(`orbd.tex: \\section before any \\chapter: ${line.trim()}`);
        continue;
      }
      pendingSection = { title: group.value.trim(), starred: sectionMatch[1] === '*' };
      continue;
    }

    const inputMatch = line.match(/\\input\{modules\/([^}]+)\}/);
    if (inputMatch) {
      const moduleName = inputMatch[1];
      if (!chapter) {
        warnings.push(`orbd.tex: \\input before any \\chapter: ${line.trim()}`);
        continue;
      }
      // The {\color{blue}\tiny[mXXXX]} tag on the same line is redundant with the
      // filename; parse it purely as a cross-check.
      const tagMatch = line.match(/\[(m\d{4})\]/);
      if (tagMatch && !moduleName.startsWith(tagMatch[1])) {
        warnings.push(
          `orbd.tex: module tag ${tagMatch[1]} does not match \\input ${moduleName}`
        );
      }
      if (pendingSection) {
        chapter.sections.push({ ...pendingSection, modules: [moduleName] });
        pendingSection = null;
      } else if (moduleName.includes('Ch_End_Matter')) {
        if (chapter.endMatterModule) {
          warnings.push(`orbd.tex: multiple end-matter modules in "${chapter.title}"`);
        }
        chapter.endMatterModule = moduleName;
      } else if (chapter.sections.length === 0) {
        if (chapter.prefaceModule) {
          warnings.push(`orbd.tex: multiple preface modules in "${chapter.title}"`);
        }
        chapter.prefaceModule = moduleName;
      } else {
        chapter.sections[chapter.sections.length - 1].modules.push(moduleName);
      }
      continue;
    }
  }

  return { chapters, warnings };
}
