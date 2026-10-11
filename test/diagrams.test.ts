import { describe, expect, it } from 'vitest';
import { plantumlDiagrams } from '../src/diagrams';
import { Version } from '../src/versions';
import { disk, MemoryWorkspace, origin as at } from './memoryWorkspace';

const MAIN = disk('/project/main.puml');

describe('Diagrams of a PlantUML file', () => {
  it('cuts out each diagram with the document line of every line', async () => {
    const text = ['title page', '@startuml', 'A -> B', '@enduml', '', '@startmindmap', '* root', '@endmindmap'].join('\n');

    const { diagrams } = await plantumlDiagrams(text, MAIN, new Version(new MemoryWorkspace()));

    expect(diagrams).toEqual([
      {
        lines: ['@startuml', 'A -> B', '@enduml'],
        origins: [at(MAIN, 1), at(MAIN, 2), at(MAIN, 3)],
        block: { start: 1, end: 3 },
      },
      {
        lines: ['@startmindmap', '* root', '@endmindmap'],
        origins: [at(MAIN, 5), at(MAIN, 6), at(MAIN, 7)],
        block: { start: 5, end: 7 },
      },
    ]);
  });

  it('gives lines from nested includes the file and line they were written at', async () => {
    const shared = disk('/project/shared/actors.iuml');
    const colors = disk('/project/shared/colors.iuml');
    const workspace = new MemoryWorkspace()
      .file(shared, ['actor Alice', '!include colors.iuml', 'actor Bob'].join('\n'))
      .file(colors, ['skinparam backgroundColor #EEE'].join('\n'));
    const text = ['@startuml', '!include shared/actors.iuml', 'Alice -> Bob', '@enduml'].join('\n');
    const version = new Version(workspace);

    const { diagrams } = await plantumlDiagrams(text, MAIN, version);

    expect(diagrams).toEqual([
      {
        lines: ['@startuml', 'actor Alice', 'skinparam backgroundColor #EEE', 'actor Bob', 'Alice -> Bob', '@enduml'],
        origins: [at(MAIN, 0), at(shared, 0), at(colors, 0), at(shared, 2), at(MAIN, 2), at(MAIN, 3)],
        block: { start: 0, end: 3 },
      },
    ]);
    expect(version.hasRead(colors)).toBe(true);
  });

  it('wraps text without markers in lines the engine is given, without an Origin', async () => {
    const { diagrams } = await plantumlDiagrams('A -> B\nB -> C', MAIN, new Version(new MemoryWorkspace()));

    expect(diagrams).toEqual([
      {
        lines: ['@startuml', 'A -> B', 'B -> C', '@enduml'],
        origins: [null, at(MAIN, 0), at(MAIN, 1), null],
        block: { start: -1, end: 2 },
      },
    ]);
  });

  it('closes an unterminated diagram with a line without an Origin', async () => {
    const text = ['@startuml', 'A -> B', '', ''].join('\n');

    const { diagrams } = await plantumlDiagrams(text, MAIN, new Version(new MemoryWorkspace()));

    expect(diagrams).toEqual([
      {
        lines: ['@startuml', 'A -> B', '', '', '@enduml'],
        origins: [at(MAIN, 0), at(MAIN, 1), at(MAIN, 2), at(MAIN, 3), null],
        block: { start: 0, end: 4 },
      },
    ]);
  });

  it('gives each copy of a file included many times the same Origins', async () => {
    const part = disk('/project/part.iuml');
    const workspace = new MemoryWorkspace().file(part, 'A -> B');
    const text = ['@startuml', '!include_many part.iuml', '!include_many part.iuml', '@enduml'].join('\n');

    const { diagrams } = await plantumlDiagrams(text, MAIN, new Version(workspace));

    expect(diagrams[0].lines).toEqual(['@startuml', 'A -> B', 'A -> B', '@enduml']);
    expect(diagrams[0].origins).toEqual([at(MAIN, 0), at(part, 0), at(part, 0), at(MAIN, 3)]);
  });

  it('keeps include directives as written when includes are not inlined', async () => {
    const workspace = new MemoryWorkspace().file(disk('/project/part.iuml'), 'A -> B');
    const text = ['@startuml', '!include part.iuml', '@enduml'].join('\n');

    const { diagrams, includes } = await plantumlDiagrams(text, MAIN, new Version(workspace), false);

    expect(diagrams[0].lines).toEqual(['@startuml', '!include part.iuml', '@enduml']);
    expect(diagrams[0].origins).toEqual([at(MAIN, 0), at(MAIN, 1), at(MAIN, 2)]);
    expect(includes.map((i) => i.status)).toEqual(['ok']);
  });
});
