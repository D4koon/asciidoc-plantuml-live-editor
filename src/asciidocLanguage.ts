import * as vscode from 'vscode';

const HEADING = /^(={1,6}|#{1,6})\s+\S/;
/** Delimiters of blocks whose content is not AsciiDoc (no headings or nested blocks inside). */
const RAW_DELIMITER = /^(-{4,}|\.{4,}|\+{4,}|\/{4,})\s*$/;
const DELIMITER = /^(={4,}|\*{4,}|_{4,}|--|[|,:!]===)\s*$/;

/**
 * Folding for AsciiDoc in the text editor: sections (up to the next heading
 * of the same or a higher level) and delimited blocks. Delimiters open and
 * close a block with the same line, so markers in the language configuration
 * can't express this.
 */
export function asciiDocFoldingRanges(lines: string[]): vscode.FoldingRange[] {
  const ranges: vscode.FoldingRange[] = [];
  const sections: { level: number; line: number }[] = [];
  const blocks: { delimiter: string; line: number }[] = [];
  const endBefore = (line: number) => {
    let end = line - 1;
    while (end >= 0 && lines[end].trim() === '') end--;
    return end;
  };
  const closeSections = (level: number, line: number) => {
    while (sections.length && sections[sections.length - 1].level >= level) {
      const section = sections.pop()!;
      const end = endBefore(line);
      if (end > section.line) ranges.push(new vscode.FoldingRange(section.line, end, vscode.FoldingRangeKind.Region));
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trimEnd();
    const open = blocks[blocks.length - 1];
    if (open && RAW_DELIMITER.test(open.delimiter)) {
      if (line === open.delimiter) {
        blocks.pop();
        const kind = open.delimiter.startsWith('/') ? vscode.FoldingRangeKind.Comment : undefined;
        if (i > open.line) ranges.push(new vscode.FoldingRange(open.line, i, kind));
      }
      continue;
    }
    if (RAW_DELIMITER.test(line) || DELIMITER.test(line)) {
      if (open && line === open.delimiter) {
        blocks.pop();
        if (i > open.line) ranges.push(new vscode.FoldingRange(open.line, i));
      } else {
        blocks.push({ delimiter: line, line: i });
      }
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading && blocks.length === 0) {
      const level = heading[1].length;
      closeSections(level, i);
      sections.push({ level, line: i });
    }
  }
  closeSections(0, lines.length);
  return ranges;
}

export function registerAsciiDocLanguage(): vscode.Disposable {
  return vscode.languages.registerFoldingRangeProvider(
    { language: 'asciidoc' },
    { provideFoldingRanges: (document) => asciiDocFoldingRanges(document.getText().split(/\r\n|\r|\n/)) }
  );
}
