import { describe, expect, it } from 'vitest';
import { Version } from '../src/versions';
import { disk, git, MemoryWorkspace } from './memoryWorkspace';

describe('Version', () => {
  it('reads files on disk synchronously too, editor first', () => {
    const open = disk('/project/open.adoc');
    const closed = disk('/project/closed.adoc');
    const workspace = new MemoryWorkspace().file(open, 'saved').editor(open, 'unsaved').file(closed, 'on disk');
    const version = new Version(workspace);

    expect(version.textSync(open)).toBe('unsaved');
    expect(version.textSync(closed)).toBe('on disk');
    expect(version.textSync(disk('/project/missing.adoc'))).toBeUndefined();
  });

  it('reads a git version synchronously only once the file was read', async () => {
    const chapter = git('/project/chapter.adoc', 'HEAD');
    const version = new Version(new MemoryWorkspace().file(chapter, 'at HEAD'));

    expect(version.textSync(chapter)).toBeUndefined();
    await version.text(chapter);
    expect(version.textSync(chapter)).toBe('at HEAD');
  });

  it('records each file it read, once', async () => {
    const a = disk('/project/a.iuml');
    const b = disk('/project/b.iuml');
    const version = new Version(new MemoryWorkspace().file(a, 'A').file(b, 'B'));

    await version.text(a);
    version.textSync(b);
    await version.text(a);
    await expect(version.text(disk('/project/missing.iuml'))).rejects.toThrow();

    expect(version.files().map(String)).toEqual([a, b].map(String));
    expect(version.hasRead(b)).toBe(true);
    expect(version.hasRead(disk('/project/missing.iuml'))).toBe(false);
  });

  it('tells a file of another version apart', async () => {
    const file = disk('/project/a.iuml');
    const version = new Version(new MemoryWorkspace().file(file, 'A'));

    await version.text(file);

    expect(version.hasRead(git('/project/a.iuml', 'HEAD'))).toBe(false);
  });

  it.runIf(process.platform !== 'win32')('elsewhere, takes paths differing in letter case for different files', async () => {
    const version = new Version(new MemoryWorkspace().file(disk('/project/Shared.iuml'), 'S'));

    await version.text(disk('/project/Shared.iuml'));

    expect(version.hasRead(disk('/project/shared.iuml'))).toBe(false);
  });
});
