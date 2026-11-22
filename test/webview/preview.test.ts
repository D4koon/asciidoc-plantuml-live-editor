// The preview webview, clicked and typed into as a user would, in Chromium.
// The extension's side is the real renderer and the real edit planning; only
// VS Code itself (applying edits, moving the editor) is left out. Screenshots
// land in test-results/webview.

import * as path from 'path';
import * as vscode from 'vscode';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { locateLine, planDelete, planRename } from '../../src/diagramEdits';
import { diffLines } from '../../src/diffs';
import type { UpdateMessage } from '../../src/protocol';
import { render } from '../../src/renderer';
import { editBlock, editDiagram } from '../../src/sourceEdits';
import { Version } from '../../src/versions';
import { applied } from '../applied';
import { disk, git, MemoryWorkspace, origin as at } from '../memoryWorkspace';
import { Harness, Webview } from './browser';

const MAIN = disk('/project/main.puml');
const ACTORS = disk('/project/actors.iuml');
const DOC = disk('/project/guide.adoc');

let harness: Harness;
let view: Webview | undefined;

beforeAll(async () => {
  harness = await Harness.start();
}, 60_000);
afterAll(async () => harness?.stop());
afterEach(async () => {
  // Every test also checks that the page reported nothing wrong (scripts, CSP).
  const errors = view?.errors ?? [];
  await view?.close();
  view = undefined;
  expect(errors).toEqual([]);
});

/** Files in a workspace, and a Version of it, as the extension would read them. */
function workspace(files: Map<vscode.Uri, string>) {
  const memory = new MemoryWorkspace();
  files.forEach((text, uri) => memory.file(uri, text));
  return { files, version: () => new Version(memory) };
}

/** Renders `document` and sends the update, as Preview does, then waits for `diagrams` SVGs. */
async function show(target: Webview, document: vscode.Uri, version: Version, diagrams: number): Promise<UpdateMessage> {
  const { update } = await render({ document }, version, { safeMode: 'safe', inlineIncludes: true });
  const message: UpdateMessage = {
    type: 'update',
    uri: document.toString(),
    theme: 'light',
    nav: { root: document.toString(), shown: document.toString(), rendered: document.toString(), dirty: [] },
    ...update,
  };
  await target.send(message);
  await target.rendered(diagrams);
  return message;
}

const plantuml = () =>
  workspace(
    new Map([
      [MAIN, ['@startuml', '!include actors.iuml', 'Alice -> Bob : hello', 'Bob -> Alice : bye', '@enduml'].join('\n')],
      [ACTORS, ['participant Alice', 'participant Bob'].join('\n')],
    ])
  );

describe('The preview of a PlantUML file', () => {
  it('sends a clicked element, which leads to the line it was written at, also in an included file', async () => {
    const { version } = plantuml();
    view = await harness.open();
    await show(view, MAIN, version(), 1);
    await view.screenshot('plantuml');

    await view.page.locator('g.participant-head[data-qualified-name="Bob"] text').click();
    const participant = await view.next('select');
    await view.page.getByText('hello', { exact: true }).click();
    const message = await view.next('select');

    // What Preview does with a select: find the line, then its Origin.
    const originOf = ({ ref, diagram }: typeof participant) => diagram.origins[locateLine(diagram.lines, ref)!];
    expect(originOf(participant)).toEqual(at(ACTORS, 1));
    expect(originOf(message)).toEqual(at(MAIN, 2));
  });

  it('renames a participant typed over in the preview, in every file it is written in', async () => {
    const { files, version } = plantuml();
    view = await harness.open();
    await show(view, MAIN, version(), 1);

    await view.page.locator('g.participant-head[data-qualified-name="Alice"] text').dblclick();
    await view.page.locator('input.pv-inline-edit').fill('Alicia');
    await view.page.keyboard.press('Enter');
    const { request, diagram } = await view.next('rename');

    const outcome = await editDiagram(diagram, planRename(diagram.lines, request), version());
    expect(applied(files, outcome)).toEqual(
      new Map([
        [MAIN.toString(), ['@startuml', '!include actors.iuml', 'Alicia -> Bob : hello', 'Bob -> Alicia : bye', '@enduml'].join('\n')],
        [ACTORS.toString(), ['participant Alicia', 'participant Bob'].join('\n')],
      ])
    );
  });

  it('deletes a selected message with the Delete key', async () => {
    const { files, version } = plantuml();
    view = await harness.open();
    await show(view, MAIN, version(), 1);

    await view.page.getByText('bye', { exact: true }).click();
    await view.next('select');
    await view.page.keyboard.press('Delete');
    const { ref, diagram } = await view.next('delete');

    const outcome = await editDiagram(diagram, planDelete(diagram.lines, ref), version());
    expect(applied(files, outcome).get(MAIN.toString())).toBe(['@startuml', '!include actors.iuml', 'Alice -> Bob : hello', '@enduml'].join('\n'));
  });

  it('offers no editing in a version that can’t be edited, but still sends clicks', async () => {
    const { version } = plantuml();
    view = await harness.open({ readOnly: true });
    await show(view, MAIN, version(), 1);

    await view.page.getByText('bye', { exact: true }).click();
    await view.next('select');
    await view.page.keyboard.press('Delete');
    await view.page.locator('g.participant-head[data-qualified-name="Alice"] text').dblclick();

    const { page } = view;
    await expect.poll(() => page.locator('input.pv-inline-edit').count()).toBe(0);
    expect((await view.posted()).map((m) => m.type)).not.toContain('delete');
  });

  it('hands over the SVG of each diagram for export', async () => {
    const { version } = plantuml();
    view = await harness.open();
    await show(view, MAIN, version(), 1);

    await view.send({ type: 'requestSvg', requestId: 7 });
    const { requestId, svgs } = await view.next('svg');

    expect(requestId).toBe(7);
    expect(svgs).toEqual([expect.stringMatching(/^<svg[^]*hello[^]*<\/svg>$/)]);
  });
});

describe('The preview of an AsciiDoc document', () => {
  const document = () =>
    workspace(
      new Map([
        [
          DOC,
          [
            '= Guide', //                 0
            '',
            'The first paragraph.', //    2
            '',
            '[plantuml]',
            '----',
            'Alice -> Bob : hi', //       6
            '----',
            '',
            'The last paragraph.', //     9
          ].join('\n'),
        ],
      ])
    );

  it('shows the document with its diagram, and a clicked block or element leads to its line', async () => {
    const { version } = document();
    view = await harness.open({ format: 'asciidoc' });
    await show(view, DOC, version(), 1);
    await view.screenshot('asciidoc');

    const { page } = view;
    await expect.poll(() => page.locator('.adoc h1').textContent()).toBe('Guide');
    await view.page.getByText('The last paragraph.').click();
    expect(await view.next('revealLine')).toEqual({ type: 'revealLine', line: 9 });

    await view.page.getByText('hi', { exact: true }).click();
    const { ref, diagram } = await view.next('select');
    expect(diagram.origins[locateLine(diagram.lines, ref)!]).toEqual(at(DOC, 6));
  });

  it('shows a warning in place of an include:: that went wrong and in the list above, both leading to the directive', async () => {
    const chapter = disk('/project/chapter.adoc');
    const { version } = workspace(
      new Map([
        [DOC, ['= Guide', '', 'include::chapter.adoc[tags=intro;setup]'].join('\n')],
        [chapter, ['// tag::intro[]', 'Intro.', '// end::intro[]'].join('\n')],
      ])
    );
    view = await harness.open({ format: 'asciidoc' });
    await show(view, DOC, version(), 0);

    const { page } = view;
    const box = page.locator('.adoc .pv-warning');
    await expect.poll(() => box.textContent()).toBe(`⚠ tag 'setup' not found in include file: ${chapter.fsPath.split(path.sep).join('/')} — guide.adoc:3`);
    await expect.poll(() => page.locator('.adoc p').allTextContents()).toEqual(['Intro.']);
    const list = page.locator('details.pv-warnings');
    expect(await list.locator('summary').textContent()).toBe('⚠ 1 warning');
    expect(await list.getAttribute('open')).toBeNull();
    await view.screenshot('asciidoc-warning');

    await box.click();
    expect(await view.next('revealLine')).toEqual({ type: 'revealLine', line: 2, uri: DOC.toString() });
    await list.locator('summary').click();
    await list.locator('.pv-warning-item').click();
    expect(await view.next('revealLine')).toEqual({ type: 'revealLine', line: 2, uri: DOC.toString() });
  });

  it('replaces a block edited in the preview', async () => {
    const { files, version } = document();
    view = await harness.open({ format: 'asciidoc' });
    await show(view, DOC, version(), 1);

    await view.page.getByText('The first paragraph.').dblclick();
    await view.page.locator('textarea.pv-block-edit').fill('The first paragraph,\nnow on two lines.');
    await view.page.keyboard.press('Control+Enter');
    const { type: _, uri, ...block } = await view.next('editBlock');

    const outcome = await editBlock(uri ?? DOC.toString(), block, version());
    expect(applied(files, outcome).get(DOC.toString())?.split('\n').slice(0, 5)).toEqual([
      '= Guide',
      '',
      'The first paragraph,',
      'now on two lines.',
      '',
    ]);
  });
});

describe('A diff of two versions', () => {
  it('marks the words that changed within a changed paragraph', async () => {
    const before = disk('/project/old.adoc');
    const text = (word: string) =>
      ['= Checkout', '', 'Renaming a participant in the preview changes `actors.iuml`;', `renaming a message ${word} this file.`].join('\n');
    const memory = new MemoryWorkspace().file(before, text('changes')).file(DOC, text('changers'));
    const lines = async (uri: vscode.Uri) => (await new Version(memory).text(uri)).split('\n');
    const [oldChanges, newChanges] = diffLines(await lines(before), await lines(DOC));

    const oldView = await harness.open({ format: 'asciidoc', readOnly: true });
    const newView = (view = await harness.open({ format: 'asciidoc' }));
    try {
      await show(oldView, before, new Version(memory), 0);
      await show(view, DOC, new Version(memory), 0);
      await oldView.send({ type: 'diff', side: 'old', files: { [before.toString()]: oldChanges } });
      await view.send({ type: 'diff', side: 'new', files: { [DOC.toString()]: newChanges } });

      // The second "changes" of the paragraph is the one that changed.
      const marked = (side: Webview) =>
        side.page.evaluate(() =>
          [...document.querySelectorAll('.pv-diff-block mark.pv-diff-word')].map((m) => `${m.textContent}|${m.nextSibling?.textContent}`)
        );
      await expect.poll(() => marked(oldView)).toEqual(['changes| this file.']);
      await expect.poll(() => marked(newView)).toEqual(['changers| this file.']);
      await oldView.screenshot('diff-words-old');
      await view.screenshot('diff-words-new');
      expect(oldView.errors).toEqual([]);
    } finally {
      await oldView.close();
    }
  });

  it('marks what changed on each side, also in an included file', async () => {
    const old = { main: git('/project/main.puml', 'HEAD'), actors: git('/project/actors.iuml', 'HEAD') };
    const memory = new MemoryWorkspace()
      .file(old.main, ['@startuml', '!include actors.iuml', 'Alice -> Bob : hello', 'Bob -> Alice : bye', '@enduml'].join('\n'))
      .file(old.actors, ['participant Alice', 'participant Bob'].join('\n'))
      .file(MAIN, ['@startuml', '!include actors.iuml', 'Alice -> Bob : hello again', 'Bob -> Alice : bye', '@enduml'].join('\n'))
      .file(ACTORS, ['participant Alice', 'actor Bob'].join('\n'));
    const lines = async (uri: vscode.Uri) => (await new Version(memory).text(uri)).split('\n');
    const [mainOld, mainNew] = diffLines(await lines(old.main), await lines(MAIN));
    const [actorsOld, actorsNew] = diffLines(await lines(old.actors), await lines(ACTORS));

    const oldView = await harness.open({ readOnly: true });
    view = await harness.open();
    try {
      await show(oldView, old.main, new Version(memory), 1);
      await show(view, MAIN, new Version(memory), 1);
      await oldView.send({ type: 'diff', side: 'old', files: { [old.main.toString()]: mainOld, [old.actors.toString()]: actorsOld } });
      await view.send({ type: 'diff', side: 'new', files: { [MAIN.toString()]: mainNew, [ACTORS.toString()]: actorsNew } });

      for (const [side, label] of [[oldView, 'hello'], [view, 'hello again']] as const) {
        // The engine draws a message as two groups (arrow and label), both marked.
        await expect.poll(() => side.page.locator('g.message.pv-diff text').allTextContents()).toEqual([label]);
        await expect.poll(() => side.page.locator('g.message:not(.pv-diff) text').allTextContents()).toEqual(['bye']);
        await expect.poll(() => side.page.locator('g.participant-head.pv-diff[data-qualified-name="Bob"]').count()).toBe(1);
        await expect.poll(() => side.page.locator('g.participant-head.pv-diff[data-qualified-name="Alice"]').count()).toBe(0);
        await expect.poll(() => side.page.locator('#diff-nav').isVisible()).toBe(true);
      }
      // A line separates the two sides: the new (right) side draws it.
      const borderOf = (side: Webview) => side.page.evaluate(() => getComputedStyle(document.body).borderLeftWidth);
      expect(await borderOf(oldView)).toBe('0px');
      expect(await borderOf(view)).toBe('1px');
      await oldView.screenshot('diff-old');
      await view.screenshot('diff-new');
      expect(oldView.errors).toEqual([]);
    } finally {
      await oldView.close();
    }
  });
});
