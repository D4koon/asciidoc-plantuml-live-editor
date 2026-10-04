import { describe, expect, it } from 'vitest';
import { resolveIncludes } from '../src/includes';
import { Version } from '../src/versions';
import { disk, MemoryWorkspace } from './memoryWorkspace';

describe('PlantUML includes', () => {
  it.runIf(process.platform === 'win32')('on Windows, includes a file once with !include_once whatever its letter case', async () => {
    const main = disk('C:/project/main.puml');
    const workspace = new MemoryWorkspace().file(disk('C:/project/shared.iuml'), 'Alice -> Bob');
    const text = ['@startuml', '!include_once shared.iuml', '!include_once Shared.IUML', '@enduml'].join('\n');

    const resolved = await resolveIncludes(text, main, new Version(workspace));

    expect(resolved.text.split('\n')).toEqual(['@startuml', 'Alice -> Bob', '@enduml']);
  });
});
