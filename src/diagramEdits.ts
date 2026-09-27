// Maps interactions on the rendered diagram back to source edits.
//
// The engine tags most SVG elements with `data-source-line`, but the value is
// only a hint: elements created by library macros (C4, …) report lines inside
// the library, and some diagram types carry no line at all. Every operation
// therefore verifies the line against the clicked text and falls back to
// searching the diagram's source.
//
// No vscode imports, so this can be unit-tested directly.

/** The lines of one `@start…`/`@end…` block, as zero-based document lines (inclusive). */
export interface Block {
  start: number;
  end: number;
}

/** What was clicked: an entity's name, a link/message label, a class member, or any other text. */
export type TextKind = 'name' | 'label' | 'member' | 'text';

export interface ElementRef {
  block: Block;
  /** Document line suggested by the SVG's data-source-line, if any. */
  hint?: number;
  /** PlantUML's identifier for an entity (data-qualified-name). */
  qualifiedName?: string;
  /** Visible texts of the element, used to verify and search. */
  texts: string[];
}

export interface RenameRequest extends ElementRef {
  kind: TextKind;
  oldText: string;
  newText: string;
}

/** A replacement of whole lines; `text: undefined` deletes the line. */
export interface LineEdit {
  line: number;
  text: string | undefined;
}

const ARROW_RE = /<?[-.=~]+(?:\[[^\]]*\])?(?:up|down|left|right|u|d|l|r)?[-.=~]*>|<[-.=~]+|[-.=~]{2,}|\*--|--\*|o--|--o/;
const IDENTIFIER_RE = /^[A-Za-z_][\w.]*$/;

/** Finds the source line of an element, or undefined if it cannot be located. */
export function locateLine(lines: string[], ref: ElementRef): number | undefined {
  const { block, hint, texts, qualifiedName } = ref;
  const inBlock = (n: number) => n > block.start && n < block.end && n < lines.length;
  const candidates = texts.filter((t) => t.trim().length > 0);
  const matches = (line: string) =>
    candidates.some((t) => line.includes(t)) || (!!qualifiedName && wordRegex(qualifiedName).test(line));

  if (hint !== undefined && inBlock(hint) && matches(lines[hint])) {
    return hint;
  }
  const searchOrder: ((line: string) => boolean)[] = [
    ...candidates.map((t) => (line: string) => line.includes(`"${t}"`)),
    ...candidates.map((t) => (line: string) => line.includes(t)),
  ];
  if (qualifiedName) {
    searchOrder.push((line) => wordRegex(qualifiedName).test(stripQuoted(line)));
  }
  for (const test of searchOrder) {
    for (let n = block.start + 1; n < block.end && n < lines.length; n++) {
      if (test(lines[n])) return n;
    }
  }
  return undefined;
}

/** Computes the edits that rename `oldText` to `newText`, or undefined if it cannot be mapped. */
export function planRename(lines: string[], req: RenameRequest): LineEdit[] | undefined {
  const { oldText, newText, kind, qualifiedName, block } = req;
  if (!oldText || newText === oldText) return [];

  if (kind === 'name' && qualifiedName && qualifiedName === oldText) {
    // The visible name is the identifier: rename it everywhere in the diagram.
    return renameIdentifier(lines, block, oldText, newText);
  }

  if (kind === 'member') {
    // Members live on their own lines inside the class body, after the declaration.
    const from = req.hint !== undefined && req.hint > block.start ? req.hint : block.start + 1;
    for (let n = from; n < block.end && n < lines.length; n++) {
      if (lines[n].includes(oldText)) {
        return [{ line: n, text: lines[n].replace(oldText, () => newText) }];
      }
      if (n > from && /^\s*}/.test(lines[n])) break;
    }
    return undefined;
  }

  const line = locateLine(lines, { ...req, texts: [oldText] });
  if (line === undefined) return undefined;
  const replaced = replaceOnLine(lines[line], oldText, newText, kind === 'label');
  return replaced === undefined ? undefined : [{ line, text: replaced }];
}

/** Computes the edit deleting a link or message line, or undefined if the line is not one. */
export function planDelete(lines: string[], ref: ElementRef): LineEdit[] | undefined {
  const line = ref.texts.some((t) => t.trim())
    ? locateLine(lines, ref)
    : ref.hint !== undefined && ref.hint > ref.block.start && ref.hint < ref.block.end
      ? ref.hint
      : undefined;
  if (line === undefined || !ARROW_RE.test(stripQuoted(lines[line]))) return undefined;
  return [{ line, text: undefined }];
}

/**
 * Replaces one occurrence of `oldText` on a line: a quoted occurrence first;
 * then, for labels, the first one after the `:` separator; then any.
 */
function replaceOnLine(line: string, oldText: string, newText: string, preferAfterColon: boolean): string | undefined {
  const quoted = line.indexOf(`"${oldText}"`);
  if (quoted >= 0) {
    return line.slice(0, quoted + 1) + newText + line.slice(quoted + 1 + oldText.length);
  }
  if (preferAfterColon) {
    const colon = separatorIndex(line);
    if (colon >= 0) {
      const at = line.indexOf(oldText, colon + 1);
      if (at >= 0) return line.slice(0, at) + newText + line.slice(at + oldText.length);
    }
  }
  const at = line.indexOf(oldText);
  return at >= 0 ? line.slice(0, at) + newText + line.slice(at + oldText.length) : undefined;
}

/**
 * Renames an identifier in every line of the block. Only the part of a line
 * before its `:` label separator is touched, outside of strings, so labels
 * and member types that merely contain the word are left alone; quoted
 * references (`"My Class"`) are renamed too.
 */
function renameIdentifier(lines: string[], block: Block, oldName: string, newName: string): LineEdit[] {
  const bare = IDENTIFIER_RE.test(newName) ? newName : `"${newName.replace(/"/g, "'")}"`;
  const word = wordRegex(oldName, 'g');
  const edits: LineEdit[] = [];
  for (let n = block.start + 1; n < block.end && n < lines.length; n++) {
    const original = lines[n];
    if (/^\s*'/.test(original)) continue; // comment
    const colon = separatorIndex(original);
    const head = colon >= 0 ? original.slice(0, colon) : original;
    const tail = colon >= 0 ? original.slice(colon) : '';
    let result = '';
    let i = 0;
    while (i < head.length) {
      if (head[i] === '"') {
        const close = head.indexOf('"', i + 1);
        const end = close < 0 ? head.length : close + 1;
        const literal = head.slice(i, end);
        result += literal === `"${oldName}"` ? `"${newName}"` : literal;
        i = end;
      } else {
        const next = head.indexOf('"', i);
        const end = next < 0 ? head.length : next;
        result += head.slice(i, end).replace(word, () => bare);
        i = end;
      }
    }
    if (result + tail !== original) edits.push({ line: n, text: result + tail });
  }
  return edits;
}

/** Index of the first `:` outside of quotes and `[...]` link styles, or -1. */
function separatorIndex(line: string): number {
  let inQuote = false;
  let depth = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuote = !inQuote;
    else if (!inQuote && c === '[') depth++;
    else if (!inQuote && c === ']') depth = Math.max(0, depth - 1);
    else if (!inQuote && depth === 0 && c === ':') return i;
  }
  return -1;
}

function stripQuoted(line: string): string {
  return line.replace(/"[^"]*"/g, '""');
}

function wordRegex(word: string, flags = ''): RegExp {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\w.])${escaped}(?![\\w])`, flags);
}
