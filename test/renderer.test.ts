import { describe, expect, it } from 'vitest';
import type { Uri } from 'vscode';
import { render, rendersAlone, RenderSettings } from '../src/renderer';
import { Version } from '../src/versions';
import { disk, git, MemoryWorkspace, origin as at } from './memoryWorkspace';

const MAIN = disk('/project/main.puml');
const DOC = disk('/project/main.adoc');
const SETTINGS: RenderSettings = { safeMode: 'safe', inlineIncludes: true };

/** Renders `document`, written to `workspace` with `text`. */
function renderText(document: Uri, text: string, workspace = new MemoryWorkspace(), settings = SETTINGS) {
  return render({ document }, new Version(workspace.file(document, text)), settings);
}

describe('Rendering a PlantUML file', () => {
  it('cuts out each diagram with the document line of every line', async () => {
    const text = ['title page', '@startuml', 'A -> B', '@enduml', '', '@startmindmap', '* root', '@endmindmap'].join('\n');

    const { update, dependencies } = await renderText(MAIN, text);

    expect(update).toEqual({
      format: 'plantuml',
      diagrams: [
        {
          lines: ['@startuml', 'A -> B', '@enduml'],
          origins: [at(MAIN, 1), at(MAIN, 2), at(MAIN, 3)],
        },
        {
          lines: ['@startmindmap', '* root', '@endmindmap'],
          origins: [at(MAIN, 5), at(MAIN, 6), at(MAIN, 7)],
        },
      ],
      includes: [],
    });
    expect(dependencies.map(String)).toEqual([MAIN.toString()]);
  });

  it('gives lines from nested includes the file and line they were written at, and depends on every file', async () => {
    const shared = disk('/project/shared/actors.iuml');
    const colors = disk('/project/shared/colors.iuml');
    const workspace = new MemoryWorkspace()
      .file(shared, ['actor Alice', '!include colors.iuml', 'actor Bob'].join('\n'))
      .file(colors, ['skinparam backgroundColor #EEE'].join('\n'));
    const text = ['@startuml', '!include shared/actors.iuml', 'Alice -> Bob', '@enduml'].join('\n');

    const { update, dependencies } = await renderText(MAIN, text, workspace);

    expect(update.diagrams).toEqual([
      {
        lines: ['@startuml', 'actor Alice', 'skinparam backgroundColor #EEE', 'actor Bob', 'Alice -> Bob', '@enduml'],
        origins: [at(MAIN, 0), at(shared, 0), at(colors, 0), at(shared, 2), at(MAIN, 2), at(MAIN, 3)],
      },
    ]);
    expect(update.includes).toMatchObject([
      { directive: '!include', target: 'shared/actors.iuml', uri: shared.toString(), status: 'ok', children: [{ target: 'colors.iuml', status: 'ok' }] },
    ]);
    expect(dependencies.map(String)).toEqual([MAIN, shared, colors].map(String));
  });

  it('wraps text without markers in lines the engine is given, without an Origin', async () => {
    const { update } = await renderText(MAIN, 'A -> B\nB -> C');

    expect(update.diagrams).toEqual([
      {
        lines: ['@startuml', 'A -> B', 'B -> C', '@enduml'],
        origins: [null, at(MAIN, 0), at(MAIN, 1), null],
      },
    ]);
  });

  it('closes an unterminated diagram with a line without an Origin', async () => {
    const { update } = await renderText(MAIN, ['@startuml', 'A -> B', '', ''].join('\n'));

    expect(update.diagrams).toEqual([
      {
        lines: ['@startuml', 'A -> B', '', '', '@enduml'],
        origins: [at(MAIN, 0), at(MAIN, 1), at(MAIN, 2), at(MAIN, 3), null],
      },
    ]);
  });

  it('gives each copy of a file included many times the same Origins', async () => {
    const part = disk('/project/part.iuml');
    const text = ['@startuml', '!include_many part.iuml', '!include_many part.iuml', '@enduml'].join('\n');

    const { update } = await renderText(MAIN, text, new MemoryWorkspace().file(part, 'A -> B'));

    expect(update.diagrams[0].lines).toEqual(['@startuml', 'A -> B', 'A -> B', '@enduml']);
    expect(update.diagrams[0].origins).toEqual([at(MAIN, 0), at(part, 0), at(part, 0), at(MAIN, 3)]);
  });

  it('keeps include directives as written when includes are not inlined, still listing them', async () => {
    const workspace = new MemoryWorkspace().file(disk('/project/part.iuml'), 'A -> B');
    const text = ['@startuml', '!include part.iuml', '@enduml'].join('\n');

    const { update } = await renderText(MAIN, text, workspace, { ...SETTINGS, inlineIncludes: false });

    expect(update.diagrams).toEqual([
      { lines: ['@startuml', '!include part.iuml', '@enduml'], origins: [at(MAIN, 0), at(MAIN, 1), at(MAIN, 2)] },
    ]);
    expect(update.includes.map((i) => i.status)).toEqual(['ok']);
  });
});

describe('Rendering an AsciiDoc document', () => {
  it('converts the document and cuts out listing blocks and plantuml:: macros, with each line Origin', async () => {
    const flow = disk('/project/diagrams/flow.puml');
    const part = disk('/project/part.iuml');
    const workspace = new MemoryWorkspace()
      .file(flow, ['@startuml', 'X -> Y', '@enduml'].join('\n'))
      .file(part, 'C -> D');
    const text = [
      '= Title', //                         0
      '',
      '[plantuml]',
      '----', //                            3
      'A -> B',
      '----', //                            5
      '',
      'plantuml::diagrams/flow.puml[]', //  7
      '',
      '[plantuml]',
      '....', //                            10
      '@startuml',
      '!include part.iuml',
      '@enduml',
      '....', //                            14
    ].join('\n');

    const { update, dependencies } = await renderText(DOC, text, workspace);

    expect(update).toEqual({
      format: 'asciidoc',
      diagrams: [
        {
          lines: ['@startuml', 'A -> B', '@enduml'],
          origins: [null, at(DOC, 4), null],
        },
        {
          lines: ['@startuml', 'X -> Y', '@enduml'],
          origins: [at(flow, 0), at(flow, 1), at(flow, 2)],
        },
        {
          lines: ['@startuml', 'C -> D', '@enduml'],
          origins: [at(DOC, 11), at(part, 0), at(DOC, 13)],
        },
      ],
      asciidoc: {
        html: expect.stringMatching(/<h1>Title<\/h1>[^]*data-diagram="0"[^]*data-diagram="1"[^]*data-diagram="2"/),
        blocks: [{ start: 0, end: 0, text: '= Title', kind: 'line', uri: undefined }],
        titleBlock: 0,
      },
      includes: [
        expect.objectContaining({ directive: 'plantuml::', target: 'diagrams/flow.puml', line: 7, status: 'ok' }),
        expect.objectContaining({ directive: '!include', target: 'part.iuml', line: 12, status: 'ok' }),
      ],
    });
    expect(dependencies.map(String).sort()).toEqual([DOC, flow, part].map(String).sort());
  });

  it('closes a block without @end… with a line without an Origin', async () => {
    const { update } = await renderText(DOC, ['[plantuml]', '----', '@startuml', 'A -> B', '----'].join('\n'));

    expect(update.diagrams).toEqual([
      {
        lines: ['@startuml', 'A -> B', '@enduml'],
        origins: [at(DOC, 2), at(DOC, 3), null],
      },
    ]);
  });

  it('keeps a diagram that could not be loaded, with its error', async () => {
    const { update } = await renderText(DOC, 'plantuml::missing.puml[]');

    expect(update.diagrams).toEqual([{ lines: [], origins: [], error: expect.stringContaining('missing.puml') }]);
  });

  it('gives lines of a block in an include:: file that file’s lines', async () => {
    const chapter = disk('/project/chapter.adoc');
    const workspace = new MemoryWorkspace().editor(chapter, ['== Chapter', '', '[plantuml]', '----', 'A -> B', '----'].join('\n'));

    const { update, dependencies } = await renderText(DOC, ['= Book', '', 'include::chapter.adoc[]'].join('\n'), workspace);

    expect(update.diagrams).toEqual([{ lines: ['@startuml', 'A -> B', '@enduml'], origins: [null, at(chapter, 4), null] }]);
    expect(dependencies.map(String)).toContain(chapter.toString());
  });
});

describe('Rendering in a Version', () => {
  it('uses the unsaved text of open files alike for !include, include:: and plantuml::', async () => {
    const part = disk('/project/part.iuml');
    const flow = disk('/project/flow.puml');
    const chapter = disk('/project/chapter.adoc');
    const workspace = new MemoryWorkspace()
      .file(part, 'saved part')
      .editor(part, 'A -> B')
      .file(flow, 'saved flow')
      .editor(flow, '@startuml\nX -> Y\n@enduml')
      .file(chapter, 'saved chapter')
      .editor(chapter, 'Unsaved chapter.');
    const text = ['[plantuml]', '----', '!include part.iuml', '----', '', 'plantuml::flow.puml[]', '', 'include::chapter.adoc[]'].join('\n');

    const { update } = await renderText(DOC, text, workspace);

    expect(update.diagrams.map((d) => d.lines)).toEqual([
      ['@startuml', 'A -> B', '@enduml'],
      ['@startuml', 'X -> Y', '@enduml'],
    ]);
    expect(update).toMatchObject({ asciidoc: { html: expect.stringContaining('Unsaved chapter.') } });
  });

  it('reads the includes of a git version from the same ref, not from disk or editors', async () => {
    const main = git('/project/main.puml', 'HEAD~1');
    const shared = git('/project/shared.iuml', 'HEAD~1');
    const workspace = new MemoryWorkspace()
      .file(main, ['@startuml', '!include shared.iuml', '@enduml'].join('\n'))
      .file(disk('/project/shared.iuml'), 'on disk')
      .editor(disk('/project/shared.iuml'), 'in the editor')
      .file(shared, 'at HEAD~1');

    const { update, dependencies } = await render({ document: main }, new Version(workspace), SETTINGS);

    expect(update.diagrams).toEqual([{ lines: ['@startuml', 'at HEAD~1', '@enduml'], origins: [at(main, 0), at(shared, 0), at(main, 2)] }]);
    expect(dependencies.map(String)).toEqual([main, shared].map(String));
  });

  it('lists the includes of the root when rendering another file of its include tree', async () => {
    const page = disk('/project/page.puml');
    const workspace = new MemoryWorkspace()
      .file(MAIN, ['@startuml', '!include page.puml', '@enduml'].join('\n'))
      .file(page, '@startuml\nA -> B\n@enduml');

    const { update, dependencies } = await render({ document: page, root: MAIN }, new Version(workspace), SETTINGS);

    expect(update.diagrams.map((d) => d.lines)).toEqual([['@startuml', 'A -> B', '@enduml']]);
    expect(update.includes).toMatchObject([{ target: 'page.puml', uri: page.toString() }]);
    expect(dependencies.map(String)).toEqual([page, MAIN].map(String));
  });

  it.runIf(process.platform === 'win32')('on Windows, depends on an included file whatever the letter case of its path', async () => {
    const shared = disk('C:/project/Shared.iuml');
    const workspace = new MemoryWorkspace().file(shared, 'A -> B');
    const main = disk('C:/project/main.puml');

    const { dependsOn } = await renderText(main, '@startuml\n!include shared.IUML\n@enduml', workspace);

    expect(dependsOn(shared)).toBe(true);
    expect(dependsOn(main)).toBe(true);
    expect(dependsOn(disk('C:/project/other.iuml'))).toBe(false);
  });
});

describe('Whether a file renders on its own', () => {
  it('takes AsciiDoc files and PlantUML files with @start…, not fragments or missing files', async () => {
    const fragment = disk('/project/colors.iuml');
    const version = new Version(new MemoryWorkspace().file(MAIN, '@startuml\nA -> B\n@enduml').file(fragment, 'skinparam x y'));

    expect(await rendersAlone(MAIN, version)).toBe(true);
    expect(await rendersAlone(fragment, version)).toBe(false);
    expect(await rendersAlone(disk('/project/missing.puml'), version)).toBe(false);
    expect(await rendersAlone(DOC, version)).toBe(true);
  });
});
