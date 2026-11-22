// The part of a file an include:: selects with `lines=`, `tags=` or `tag=`,
// following Asciidoctor's rules exactly (its own filtering can't be given
// text, only read a file): the preview selects from a Version's text instead,
// so unsaved changes and git versions are honoured.

/** What an include:: takes from a file. */
export interface Selected {
  /** The selected lines, each with its line ending, as Asciidoctor pushes them. */
  lines: string[];
  /** For each selected line, its line in the file (zero-based). */
  fileLines: number[];
  /** Problems found while selecting, in Asciidoctor's words. */
  warnings: string[];
  /** Whether Asciidoctor marks the include as partial (`partial-option`). */
  partial: boolean;
}

/**
 * What the include:: with `attrs` selects from `text`, or undefined when it
 * selects nothing in particular (the whole file). `file` names the file in warnings.
 */
export function selectFrom(text: string, attrs: Record<string, unknown>, file: string): Selected | undefined {
  const fileLines = text.split('\n');
  const lines = typeof attrs.lines === 'string' && attrs.lines !== '' ? linenosOf(attrs.lines) : undefined;
  if (lines !== undefined) {
    return lines ? { ...byLinenos(fileLines, lines), warnings: [], partial: true } : undefined;
  }
  const tags = tagsOf(attrs);
  return tags ? byTags(fileLines, tags, file) : undefined;
}

/** Asciidoctor separates values by commas, or by semicolons if there are none. */
function split(value: string): string[] {
  return value.includes(',') ? value.split(',') : value.split(';');
}

/** The sorted line numbers of `lines=` (one-based; Infinity: to the end), or null for none. */
function linenosOf(value: string): number[] | null {
  const linenos: number[] = [];
  for (const part of split(value)) {
    const sep = part.indexOf('..');
    if (sep >= 0) {
      const from = parseInt(part.slice(0, sep), 10);
      const to = part.slice(sep + 2);
      if (to === '' || parseInt(to, 10) < 0) {
        linenos.push(from, Infinity);
      } else {
        for (let i = from; i <= parseInt(to, 10); i++) linenos.push(i);
      }
    } else {
      linenos.push(parseInt(part, 10));
    }
  }
  return linenos.length > 0 ? [...new Set(linenos)].sort((a, b) => a - b) : null;
}

/** The tags of `tag=` or `tags=`: true to select, false to exclude; undefined for none. */
function tagsOf(attrs: Record<string, unknown>): Record<string, boolean> | undefined {
  if ('tag' in attrs) {
    const tag = String(attrs.tag ?? '');
    if (!tag || tag === '!') return undefined;
    return tag.startsWith('!') ? { [tag.slice(1)]: false } : { [tag]: true };
  }
  if ('tags' in attrs) {
    const tags: Record<string, boolean> = Object.create(null);
    for (const tag of split(String(attrs.tags ?? ''))) {
      if (tag && tag !== '!') tags[tag.startsWith('!') ? tag.slice(1) : tag] = !tag.startsWith('!');
    }
    return Object.keys(tags).length > 0 ? tags : undefined;
  }
  return undefined;
}

function withEnding(fileLines: string[], index: number): string {
  return fileLines[index] + (index < fileLines.length - 1 ? '\n' : '');
}

function byLinenos(fileLines: string[], linenos: number[]): Pick<Selected, 'lines' | 'fileLines'> {
  const remaining = [...linenos];
  const selected: Pick<Selected, 'lines' | 'fileLines'> = { lines: [], fileLines: [] };
  let toEnd = false;
  for (let index = 0; index < fileLines.length; index++) {
    if (toEnd || (remaining[0] === Infinity && (toEnd = true))) {
      selected.lines.push(withEnding(fileLines, index));
      selected.fileLines.push(index);
    } else if (remaining[0] === index + 1) {
      selected.lines.push(withEnding(fileLines, index));
      selected.fileLines.push(index);
      remaining.shift();
      if (remaining.length === 0) break;
    }
  }
  return selected;
}

const TAG_DIRECTIVE = /\b(?:tag|(e)nd)::(\S+?)\[\](?=$|[ \r])/m;

function byTags(fileLines: string[], wanted: Record<string, boolean>, file: string): Selected {
  const tags = { ...wanted };
  let select: boolean;
  let baseSelect: boolean;
  let wildcard: boolean | undefined;
  if ('**' in tags) {
    select = baseSelect = tags['**'];
    delete tags['**'];
    if ('*' in tags) {
      wildcard = tags['*'];
      delete tags['*'];
    } else if (!select && Object.values(tags)[0] === false) {
      wildcard = true;
    }
  } else if ('*' in tags) {
    if (Object.keys(tags)[0] === '*') {
      select = baseSelect = !(wildcard = tags['*']);
    } else {
      select = baseSelect = false;
      wildcard = tags['*'];
    }
    delete tags['*'];
  } else {
    select = baseSelect = !Object.values(tags).includes(true);
  }

  const selected: Selected = { lines: [], fileLines: [], warnings: [], partial: false };
  /** The open tags: name, whether its lines are selected, and its (one-based) line. */
  const stack: [string, boolean, number][] = [];
  const found = new Set<string>();
  let active: string | null = null;

  for (let index = 0; index < fileLines.length; index++) {
    const lineno = index + 1;
    const line = withEnding(fileLines, index);
    const directive = line.includes('::') && line.includes('[]') ? TAG_DIRECTIVE.exec(line) : null;
    if (directive) {
      const [, isEnd, tag] = directive;
      if (isEnd) {
        if (tag === active) {
          stack.pop();
          [active, select] = stack.length === 0 ? [null, baseSelect] : stack[stack.length - 1];
        } else if (Object.hasOwn(tags, tag)) {
          const at = stack.map(([name]) => name).lastIndexOf(tag);
          if (at >= 0) {
            stack.splice(at, 1);
            selected.warnings.push(`mismatched end tag (expected '${active}' but found '${tag}') at line ${lineno} of include file: ${file}`);
          } else {
            selected.warnings.push(`unexpected end tag '${tag}' at line ${lineno} of include file: ${file}`);
          }
        }
      } else if (Object.hasOwn(tags, tag)) {
        if ((select = tags[tag])) found.add(tag);
        stack.push([(active = tag), select, lineno]);
      } else if (wildcard !== undefined) {
        select = active && !select ? false : wildcard;
        stack.push([(active = tag), select, lineno]);
      }
      continue;
    }
    if (select) {
      selected.lines.push(line);
      selected.fileLines.push(index);
    }
  }

  for (const [tag, , lineno] of stack) {
    selected.warnings.push(`detected unclosed tag '${tag}' starting at line ${lineno} of include file: ${file}`);
  }
  const missing = Object.entries(tags)
    .filter(([tag, wanted]) => wanted && !found.has(tag))
    .map(([tag]) => tag);
  if (missing.length > 0) {
    selected.warnings.push(`tag${missing.length > 1 ? 's' : ''} '${missing.join(', ')}' not found in include file: ${file}`);
  }
  selected.partial = !baseSelect || wildcard === false || Object.keys(tags).length > 0;
  return selected;
}
