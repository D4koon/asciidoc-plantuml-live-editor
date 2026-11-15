import { describe, expect, it } from 'vitest';
import { diffLines } from '../src/diffs';

describe('Diffing two versions of a file', () => {
  it('gives the changed words of a changed line, on each side', () => {
    const [old, current] = diffLines(
      ['= Title', '', 'Renaming a message changes this file.', 'Unchanged.'],
      ['= Title', '', 'Renaming a message changers this very file.', 'Unchanged.']
    );

    expect(old.changed).toEqual([2]);
    expect(old.words).toEqual({ 2: [[19, 26]] });
    expect(current.words).toEqual({ 2: [[19, 27], [33, 37]] });
  });

  it('pairs the changed lines of a hunk in order', () => {
    const [old, current] = diffLines(['a b c', 'd e f', 'end'], ['a x c', 'd e y', 'end']);

    expect(old.words).toEqual({ 0: [[2, 3]], 1: [[4, 5]] });
    expect(current.words).toEqual({ 0: [[2, 3]], 1: [[4, 5]] });
  });

  it('gives no words for lines rewritten as a whole, or without a counterpart', () => {
    const [old, current] = diffLines(['keep', 'one two three'], ['keep', 'four five six', 'added line']);

    expect(old.changed).toEqual([1]);
    expect(current.changed).toEqual([1, 2]);
    expect(old.words).toEqual({});
    expect(current.words).toEqual({});
  });
});
