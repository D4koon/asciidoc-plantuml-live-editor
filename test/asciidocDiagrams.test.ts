import { describe, expect, it } from 'vitest';
import { AsciiDocSettings, renderAsciiDoc } from '../src/asciidoc';
import { Version } from '../src/versions';
import { disk, MemoryWorkspace, origin as at } from './memoryWorkspace';

const DOC = disk('/project/main.adoc');
const SETTINGS: AsciiDocSettings = { safeMode: 'safe', inlineIncludes: true };

describe('Diagrams of an AsciiDoc document', () => {
  it('cuts out listing blocks and plantuml:: macros, with each line Origin', async () => {
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
    const version = new Version(workspace);

    const { diagrams } = await renderAsciiDoc(text, DOC, version, SETTINGS);

    expect(diagrams).toEqual([
      {
        lines: ['@startuml', 'A -> B', '@enduml'],
        origins: [null, at(DOC, 4), null],
        block: { start: 3, end: 5 },
      },
      {
        lines: ['@startuml', 'X -> Y', '@enduml'],
        origins: [at(flow, 0), at(flow, 1), at(flow, 2)],
      },
      {
        lines: ['@startuml', 'C -> D', '@enduml'],
        origins: [at(DOC, 11), at(part, 0), at(DOC, 13)],
        block: { start: 10, end: 14 },
      },
    ]);
    expect(version.hasRead(flow)).toBe(true);
    expect(version.hasRead(part)).toBe(true);
  });

  it('closes a block without @end… with a line without an Origin', async () => {
    const text = ['[plantuml]', '----', '@startuml', 'A -> B', '----'].join('\n');

    const { diagrams } = await renderAsciiDoc(text, DOC, new Version(new MemoryWorkspace()), SETTINGS);

    expect(diagrams).toEqual([
      {
        lines: ['@startuml', 'A -> B', '@enduml'],
        origins: [at(DOC, 2), at(DOC, 3), null],
        block: { start: 1, end: 4 },
      },
    ]);
  });

  it('keeps a diagram that could not be loaded, with its error', async () => {
    const { diagrams } = await renderAsciiDoc('plantuml::missing.puml[]', DOC, new Version(new MemoryWorkspace()), SETTINGS);

    expect(diagrams).toEqual([{ lines: [], origins: [], error: expect.stringContaining('missing.puml') }]);
  });
});
