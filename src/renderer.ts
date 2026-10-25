import * as vscode from 'vscode';
import { AsciiDocResult, isAsciiDoc, listAsciiDocIncludes, renderAsciiDoc } from './asciidoc';
import { plantumlDiagrams } from './diagrams';
import { IncludeNode, resolveIncludes } from './includes';
import { Rendered } from './protocol';
import { fileKey, Version } from './versions';

/** The settings rendering depends on; the caller reads them from the configuration. */
export interface RenderSettings {
  /** Whether diagrams' `!include`s are inlined before they reach the engine. */
  inlineIncludes: boolean;
  /** Asciidoctor's safe mode. */
  safeMode: 'unsafe' | 'safe' | 'server' | 'secure';
  /** The folder to resolve AsciiDoc paths against when the document has none (e.g. untitled). */
  defaultDir?: string;
}

/** What to render. */
export interface RenderTarget {
  /** The file to render; AsciiDoc or PlantUML by its name. */
  document: vscode.Uri;
  /** The file whose includes the overview lists (the tab's file); by default `document`. */
  root?: vscode.Uri;
}

export interface Render {
  update: Rendered;
  /** Every file the render read through its Version: a change to any of them calls for a new render. */
  dependencies: vscode.Uri[];
  /** Whether `uri` is one of the dependencies (the same file, in the same Version). */
  dependsOn(uri: vscode.Uri): boolean;
}

/** Renders `document` as it is in `version`: its Diagrams, and for AsciiDoc the converted document. */
export async function render({ document, root = document }: RenderTarget, version: Version, settings: RenderSettings): Promise<Render> {
  const text = await version.text(document);
  const rendered = isAsciiDoc(document) ? await asciidoc(text, document, version, settings) : await plantuml(text, document, version, settings);
  const includes = fileKey(root) === fileKey(document) ? rendered.includes : await includesOf(root, version, settings);
  return { update: { ...rendered, includes }, dependencies: version.files(), dependsOn: (uri) => version.hasRead(uri) };
}

async function asciidoc(text: string, document: vscode.Uri, version: Version, settings: RenderSettings): Promise<Rendered> {
  let result: AsciiDocResult;
  try {
    result = await renderAsciiDoc(text, document, version, settings);
  } catch (e) {
    result = {
      html: `<div class="pv-adoc-error">AsciiDoc conversion failed: ${escapeHtml(String(e))}</div>`,
      diagrams: [],
      blocks: [],
      includes: [],
    };
  }
  const { html, diagrams, blocks, titleBlock, includes } = result;
  return { format: 'asciidoc', diagrams, asciidoc: { html, blocks, titleBlock }, includes };
}

async function plantuml(text: string, document: vscode.Uri, version: Version, settings: RenderSettings): Promise<Rendered> {
  const { diagrams, includes } = await plantumlDiagrams(text, document, version, settings.inlineIncludes);
  return { format: 'plantuml', diagrams, includes };
}

/**
 * Whether `uri` renders on its own: an AsciiDoc file, or PlantUML with
 * `@start…`. A fragment (e.g. a file of skinparams) doesn't.
 */
export async function rendersAlone(uri: vscode.Uri, version: Version): Promise<boolean> {
  if (isAsciiDoc(uri)) return true;
  try {
    return /^\s*@start\w+/m.test(await version.text(uri));
  } catch {
    return false;
  }
}

/** The include tree of `uri`, without rendering it. */
async function includesOf(uri: vscode.Uri, version: Version, settings: RenderSettings): Promise<IncludeNode[]> {
  const text = await version.text(uri);
  return isAsciiDoc(uri)
    ? listAsciiDocIncludes(text, uri, version, settings)
    : (await resolveIncludes(text, uri, version)).includes;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c);
}
