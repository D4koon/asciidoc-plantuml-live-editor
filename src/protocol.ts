// The messages between the extension and its webviews (the preview, which
// is also each side of a diff), in both directions. Types only: the webview
// scripts import them through JSDoc, so both sides check against them.

import type { AsciiDocBlock } from './asciidoc';
import type { ElementRef, RenameRequest } from './diagramEdits';
import type { Diagram } from './diagrams';
import type { IncludeNode } from './includes';
import type { BlockEdit } from './sourceEdits';

// ------------------------------------------------- extension → webview ---

/** Where the preview is in the include tree, for the overview's breadcrumbs. */
export interface Navigation {
  /** The tab's file. */
  root: string;
  /** The file in the split view's editor. */
  shown: string;
  /** The file the preview renders. */
  rendered: string;
  /** Files with unsaved changes. */
  dirty: string[];
}

/** The rendered content: the Diagrams of a PlantUML file, or an AsciiDoc document. */
export interface UpdateMessage {
  type: 'update';
  /** The tab's file. */
  uri: string;
  format: 'plantuml' | 'asciidoc';
  theme: 'auto' | 'light' | 'dark';
  /** For AsciiDoc, in the order of the document's placeholders (`data-diagram`). */
  diagrams: Diagram[];
  /** AsciiDoc: the converted document. */
  html?: string;
  /** AsciiDoc: its editable blocks, by their `pv-src-<index>` role. */
  blocks?: AsciiDocBlock[];
  /** AsciiDoc: index into `blocks` of the document title, if editable. */
  titleBlock?: number;
  /** The root's include tree, for the overview. */
  includes: IncludeNode[];
  nav: Navigation;
}

/** The text of the file in the split view's editor. */
export interface SourceMessage {
  type: 'source';
  uri: string;
  name: string;
  language: 'plantuml' | 'asciidoc';
  text: string;
  eol: string;
  /** The last of the webview's edits applied; it drops this if it has made later ones. */
  ackVersion: number;
}

/** The changes of one file on one side of a diff, by line (zero-based). */
export interface FileChanges {
  /** Lines of this side that the other side doesn't have (changed, added or removed). */
  changed: number[];
  /** For each changed line, the last line of its paragraph (the run of non-blank lines it is in). */
  ends: number[];
  /** Positions where the other side has lines this side lacks: before that line (or at the end). */
  gaps: number[];
  /**
   * Lines in the same paragraph as such lines of the other side (e.g. the
   * paragraph lost its last line): the paragraph changed, though they didn't.
   */
  touched: number[];
}

/** What a preview needs to show the changes of its side. */
export interface DiffMessage {
  type: 'diff';
  /** `old`: the left side (removed text); `new`: the right side (added text). */
  side: 'old' | 'new';
  /** By file URI as this side's preview knows it (the root and its includes). */
  files: Record<string, FileChanges>;
}

/** The preview is no longer a side of a diff. */
export interface NoDiffMessage {
  type: 'diff';
  side?: undefined;
}

/**
 * A scroll position by content: the top of the view is `fraction` of the way
 * into what line `line` of `uri` renders as (a block or diagram), or `gap`
 * pixels above it. `edge` is set at the very top or bottom. Sent both ways:
 * a side reports it, the other side follows it.
 */
export interface DiffScroll {
  type: 'diffScroll';
  uri?: string;
  line?: number;
  fraction?: number;
  gap?: number;
  edge?: 'top' | 'bottom';
}

export type ToWebview =
  | UpdateMessage
  | SourceMessage
  /** Select a line in the split view's editor. */
  | { type: 'reveal'; line: number }
  /** Asks for the SVG of every rendered diagram (answered with `svg`). */
  | { type: 'requestSvg'; requestId: number }
  | DiffMessage
  | NoDiffMessage
  | DiffScroll;

// ------------------------------------------------- webview → extension ---

/** A change made in the split view's embedded editor, relative to the text before the edit. */
export interface SourceChange {
  offset: number;
  length: number;
  text: string;
}

export type FromWebview =
  | { type: 'ready' }
  | { type: 'svg'; requestId: number; svgs: string[] }
  | { type: 'openSource' }
  | { type: 'edit'; uri: string; version: number; changes: SourceChange[]; text: string }
  | { type: 'split'; split: boolean }
  /** Clicked an element: reveal its source. */
  | { type: 'select'; ref: ElementRef; diagram: Diagram }
  | { type: 'rename'; request: RenameRequest; diagram: Diagram }
  | { type: 'delete'; ref: ElementRef; diagram: Diagram }
  | { type: 'revealLine'; line: number; uri?: string }
  /** A block edited in the AsciiDoc preview; `uri` names an included file. */
  | ({ type: 'editBlock'; uri?: string } & BlockEdit)
  | { type: 'openLink'; href: string }
  /** Show another file of the include tree in this tab. */
  | { type: 'show'; uri: string; line?: number }
  | DiffScroll;
