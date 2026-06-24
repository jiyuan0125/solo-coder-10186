import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  duplicatePageInDefaultExportInSource,
  duplicateSlideDir,
  normalizeTags,
  readMetaTagsInSource,
  removePageFromDefaultExportInSource,
  reorderDefaultExportPagesInSource,
  reorderNotesArrayInSource,
  updateMetaTagsInSource,
  updateMetaTitleInSource,
  validateSlideName,
  validateTag,
} from './slide-ops.ts';

async function withSlidesRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'open-slide-test-'));
  try {
    return await fn(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function writeSlide(root: string, id: string, title = id): Promise<void> {
  await fs.mkdir(path.join(root, id, 'assets'), { recursive: true });
  await fs.writeFile(
    path.join(root, id, 'index.tsx'),
    `export const meta = { title: '${title}' };\nexport default [];\n`,
    'utf8',
  );
  await fs.writeFile(path.join(root, id, 'assets', 'hero.txt'), 'hero', 'utf8');
}

describe('duplicateSlideDir', () => {
  it('duplicates a slide directory with an automatic copy id', async () => {
    await withSlidesRoot(async (root) => {
      await writeSlide(root, 'cover', 'Cover');

      const result = await duplicateSlideDir(root, 'cover');

      expect(result).toEqual({ ok: true, slideId: 'cover-copy' });
      await expect(fs.readFile(path.join(root, 'cover-copy', 'index.tsx'), 'utf8')).resolves.toBe(
        `export const meta = { title: 'Cover (copy)' };\nexport default [];\n`,
      );
      await expect(
        fs.readFile(path.join(root, 'cover-copy', 'assets', 'hero.txt'), 'utf8'),
      ).resolves.toBe('hero');
    });
  });

  it('increments the automatic copy id when a copy already exists', async () => {
    await withSlidesRoot(async (root) => {
      await writeSlide(root, 'cover');

      expect(await duplicateSlideDir(root, 'cover')).toEqual({ ok: true, slideId: 'cover-copy' });
      expect(await duplicateSlideDir(root, 'cover')).toEqual({
        ok: true,
        slideId: 'cover-copy-2',
      });
    });
  });

  it('rejects source slide ids with bad characters', async () => {
    await withSlidesRoot(async (root) => {
      expect(await duplicateSlideDir(root, 'bad id')).toMatchObject({ ok: false, status: 400 });
    });
  });

  it('rejects an existing desired id', async () => {
    await withSlidesRoot(async (root) => {
      await writeSlide(root, 'cover');
      await writeSlide(root, 'target');

      expect(await duplicateSlideDir(root, 'cover', 'target')).toMatchObject({
        ok: false,
        status: 409,
      });
    });
  });

  it('rejects path traversal in the source slide id', async () => {
    await withSlidesRoot(async (root) => {
      expect(await duplicateSlideDir(root, '..')).toMatchObject({ ok: false, status: 400 });
    });
  });

  it('returns not found when the source slide does not exist', async () => {
    await withSlidesRoot(async (root) => {
      expect(await duplicateSlideDir(root, 'missing')).toMatchObject({ ok: false, status: 404 });
    });
  });
});

describe('validateSlideName', () => {
  it('accepts longer slide names than folder names', () => {
    expect(validateSlideName('x'.repeat(80))).toBe('x'.repeat(80));
    expect(validateSlideName('x'.repeat(81))).toBeNull();
  });

  it('rejects empty input', () => {
    expect(validateSlideName('')).toBeNull();
    expect(validateSlideName('   ')).toBeNull();
  });
});

describe('updateMetaTitleInSource', () => {
  it('replaces an existing single-quoted title literal', () => {
    const source = `export const meta: SlideMeta = { title: 'old' };\nexport default [];\n`;
    const out = updateMetaTitleInSource(source, 'new');
    expect(out).toContain("title: 'new'");
    expect(out).not.toContain("'old'");
  });

  it('replaces an existing double-quoted title literal', () => {
    const source = `export const meta = { title: "old" };\nexport default [];\n`;
    const out = updateMetaTitleInSource(source, 'new');
    expect(out).toContain("title: 'new'");
  });

  it('escapes single quotes inside the new title', () => {
    const source = `export const meta = { title: 'old' };\nexport default [];\n`;
    const out = updateMetaTitleInSource(source, "it's new");
    expect(out).toContain("title: 'it\\'s new'");
  });

  it('escapes backslashes inside the new title', () => {
    const source = `export const meta = { title: 'old' };\nexport default [];\n`;
    const out = updateMetaTitleInSource(source, 'a\\b');
    expect(out).toContain("title: 'a\\\\b'");
  });

  it('injects a title into a meta object that lacks one', () => {
    const source = `export const meta = {\n  notes: 'x',\n};\nexport default [];\n`;
    const out = updateMetaTitleInSource(source, 'first');
    expect(out).toMatch(/title:\s*'first'/);
    expect(out).toContain("notes: 'x'");
  });

  it('injects a fresh meta export when none exists', () => {
    const source = `export default [];\n`;
    const out = updateMetaTitleInSource(source, 'fresh');
    expect(out).toContain("export const meta: SlideMeta = { title: 'fresh' };");
    expect(out).toContain('export default []');
  });

  it('returns null if there is no meta and no default export', () => {
    expect(updateMetaTitleInSource('// nothing here', 'x')).toBeNull();
  });
});

describe('reorderDefaultExportPagesInSource', () => {
  const withSatisfies = `import type { Page } from '@open-slide/core';
const A = () => null;
const B = () => null;
const C = () => null;
export const meta = { title: 't' };
export default [
  A,
  B,
  C,
] satisfies Page[];
`;

  const withoutSatisfies = `const A = () => null;
const B = () => null;
const C = () => null;
export default [A, B, C];
`;

  it('reorders a 3-element multi-line array', () => {
    const out = reorderDefaultExportPagesInSource(withSatisfies, [2, 0, 1]);
    expect(out).not.toBeNull();
    expect(out).toContain('export default [\n  C,\n  A,\n  B,\n] satisfies Page[];');
    // surrounding source untouched
    expect(out).toContain("import type { Page } from '@open-slide/core';");
    expect(out).toContain("export const meta = { title: 't' };");
  });

  it('reorders an inline array without satisfies', () => {
    const out = reorderDefaultExportPagesInSource(withoutSatisfies, [1, 2, 0]);
    expect(out).toContain('export default [B, C, A];');
  });

  it('is a no-op for the identity permutation (returns input unchanged)', () => {
    expect(reorderDefaultExportPagesInSource(withSatisfies, [0, 1, 2])).toBe(withSatisfies);
  });

  it('returns null on length mismatch', () => {
    expect(reorderDefaultExportPagesInSource(withSatisfies, [0, 1])).toBeNull();
    expect(reorderDefaultExportPagesInSource(withSatisfies, [0, 1, 2, 3])).toBeNull();
  });

  it('returns null on duplicate indices', () => {
    expect(reorderDefaultExportPagesInSource(withSatisfies, [0, 0, 2])).toBeNull();
  });

  it('returns null on out-of-range indices', () => {
    expect(reorderDefaultExportPagesInSource(withSatisfies, [0, 1, 5])).toBeNull();
    expect(reorderDefaultExportPagesInSource(withSatisfies, [-1, 1, 2])).toBeNull();
  });

  it('returns null when the default export is not an array', () => {
    const source = `const A = () => null;\nexport default A;\n`;
    expect(reorderDefaultExportPagesInSource(source, [0])).toBeNull();
  });

  it('returns null when there is no default export', () => {
    expect(reorderDefaultExportPagesInSource('// nothing\n', [])).toBeNull();
  });

  it('returns the input unchanged for an empty array (zero-length identity)', () => {
    const empty = `export default [];\n`;
    expect(reorderDefaultExportPagesInSource(empty, [])).toBe(empty);
  });

  it('preserves the rest of the file (component bodies, imports, meta)', () => {
    const out = reorderDefaultExportPagesInSource(withSatisfies, [2, 1, 0]);
    expect(out).not.toBeNull();
    expect(out).toContain('const A = () => null;');
    expect(out).toContain('const B = () => null;');
    expect(out).toContain('const C = () => null;');
  });
});

describe('reorderNotesArrayInSource', () => {
  it('returns the source unchanged when there is no notes export', () => {
    const source = `export default [];\n`;
    expect(reorderNotesArrayInSource(source, [])).toBe(source);
  });

  it('reorders notes alongside pages', () => {
    const source = [
      'export const notes: (string | undefined)[] = [',
      '  "first",',
      '  "second",',
      '  "third",',
      '];',
      'export default [A, B, C];',
      '',
    ].join('\n');
    const out = reorderNotesArrayInSource(source, [2, 0, 1]);
    expect(out).not.toBeNull();
    expect(out).toContain(
      'export const notes: (string | undefined)[] = [\n  "third",\n  "first",\n  "second",\n];',
    );
  });

  it('preserves template-literal notes verbatim', () => {
    const source = [
      'export const notes = [',
      '  `multi',
      'line`,',
      '  "second",',
      '];',
      'export default [A, B];',
      '',
    ].join('\n');
    const out = reorderNotesArrayInSource(source, [1, 0]);
    expect(out).not.toBeNull();
    expect(out).toContain('export const notes = [\n  "second",\n  `multi\nline`,\n];');
  });

  it('pads with undefined when notes is shorter than pages', () => {
    const source = ['export const notes = ["only"];', 'export default [A, B, C];', ''].join('\n');
    const out = reorderNotesArrayInSource(source, [2, 0, 1]);
    expect(out).not.toBeNull();
    expect(out).toContain('export const notes = [\n  undefined,\n  "only",\n];');
  });

  it('trims trailing undefined entries', () => {
    const source = [
      'export const notes = [',
      '  undefined,',
      '  "kept",',
      '  undefined,',
      '];',
      'export default [A, B, C];',
      '',
    ].join('\n');
    const out = reorderNotesArrayInSource(source, [2, 0, 1]);
    expect(out).not.toBeNull();
    expect(out).toContain('export const notes = [\n  undefined,\n  undefined,\n  "kept",\n];');
  });

  it('collapses to [] when reorder leaves only undefineds', () => {
    const source = ['export const notes = [', '  "x",', '];', 'export default [A, B];', ''].join(
      '\n',
    );
    const out = reorderNotesArrayInSource(source, [1, 1]);
    expect(out).not.toBeNull();
    expect(out).toContain('export const notes = [];');
  });

  it('returns the source unchanged for an identity-like reorder of an empty notes array', () => {
    const source = `export const notes = [];\nexport default [A, B];\n`;
    expect(reorderNotesArrayInSource(source, [0, 1])).toBe(source);
  });

  it('returns null on out-of-range indices', () => {
    const source = `export const notes = ["a", "b"];\nexport default [A, B];\n`;
    expect(reorderNotesArrayInSource(source, [-1, 0])).toBeNull();
  });

  it('returns null when notes is not an array literal', () => {
    const source = `export const notes = "oops";\nexport default [A];\n`;
    expect(reorderNotesArrayInSource(source, [0])).toBeNull();
  });
});

describe('removePageFromDefaultExportInSource', () => {
  const multiline = `import type { Page } from '@open-slide/core';
const A = () => null;
const B = () => null;
const C = () => null;
export default [
  A,
  B,
  C,
] satisfies Page[];
`;

  const inline = `const A = () => null;
const B = () => null;
const C = () => null;
export default [A, B, C];
`;

  it('removes the first element', () => {
    const out = removePageFromDefaultExportInSource(multiline, 0);
    expect(out).not.toBeNull();
    expect(out).toContain('export default [\n  B,\n  C,\n] satisfies Page[];');
  });

  it('removes a middle element', () => {
    const out = removePageFromDefaultExportInSource(multiline, 1);
    expect(out).not.toBeNull();
    expect(out).toContain('export default [\n  A,\n  C,\n] satisfies Page[];');
  });

  it('removes the last element', () => {
    const out = removePageFromDefaultExportInSource(multiline, 2);
    expect(out).not.toBeNull();
    expect(out).toContain('export default [\n  A,\n  B,\n] satisfies Page[];');
  });

  it('handles inline arrays', () => {
    expect(removePageFromDefaultExportInSource(inline, 1)).toContain('export default [A, C];');
  });

  it('collapses to an empty array when removing the only element', () => {
    const single = `const A = () => null;\nexport default [A];\n`;
    const out = removePageFromDefaultExportInSource(single, 0);
    expect(out).toContain('export default [];');
  });

  it('returns null on out-of-range indices', () => {
    expect(removePageFromDefaultExportInSource(multiline, -1)).toBeNull();
    expect(removePageFromDefaultExportInSource(multiline, 3)).toBeNull();
  });

  it('returns null when the default export is not an array', () => {
    expect(removePageFromDefaultExportInSource(`export default A;\n`, 0)).toBeNull();
  });
});

describe('duplicatePageInDefaultExportInSource', () => {
  const multiline = `import type { Page } from '@open-slide/core';
const A = () => null;
const B = () => null;
const C = () => null;
export default [
  A,
  B,
  C,
] satisfies Page[];
`;

  const inline = `const A = () => null;\nconst B = () => null;\nexport default [A, B];\n`;

  it('duplicates a middle element after itself', () => {
    const out = duplicatePageInDefaultExportInSource(multiline, 1);
    expect(out).not.toBeNull();
    expect(out).toContain('export default [\n  A,\n  B,\n  B,\n  C,\n] satisfies Page[];');
  });

  it('duplicates the first element', () => {
    const out = duplicatePageInDefaultExportInSource(multiline, 0);
    expect(out).toContain('export default [\n  A,\n  A,\n  B,\n  C,\n] satisfies Page[];');
  });

  it('duplicates the last element', () => {
    const out = duplicatePageInDefaultExportInSource(multiline, 2);
    expect(out).toContain('export default [\n  A,\n  B,\n  C,\n  C,\n] satisfies Page[];');
  });

  it('handles inline arrays', () => {
    expect(duplicatePageInDefaultExportInSource(inline, 0)).toContain('export default [A, A, B];');
  });

  it('duplicates the only element in a single-element array', () => {
    const single = `const A = () => null;\nexport default [A];\n`;
    const out = duplicatePageInDefaultExportInSource(single, 0);
    expect(out).toContain('export default [A, A];');
  });

  it('returns null on out-of-range indices', () => {
    expect(duplicatePageInDefaultExportInSource(multiline, -1)).toBeNull();
    expect(duplicatePageInDefaultExportInSource(multiline, 3)).toBeNull();
  });

  it('returns null when the default export is not an array', () => {
    expect(duplicatePageInDefaultExportInSource(`export default A;\n`, 0)).toBeNull();
  });
});

describe('validateTag', () => {
  it('accepts normal tags', () => {
    expect(validateTag('intro')).toBe('intro');
    expect(validateTag('chapter-1')).toBe('chapter-1');
    expect(validateTag('中文标签')).toBe('中文标签');
  });

  it('rejects empty string', () => {
    expect(validateTag('')).toBeNull();
  });

  it('rejects pure whitespace', () => {
    expect(validateTag('   ')).toBeNull();
    expect(validateTag('\t\n')).toBeNull();
  });

  it('rejects overly long tags', () => {
    expect(validateTag('x'.repeat(200))).toBe('x'.repeat(200));
    expect(validateTag('x'.repeat(201))).toBeNull();
  });

  it('rejects non-string input', () => {
    expect(validateTag(null)).toBeNull();
    expect(validateTag(undefined)).toBeNull();
    expect(validateTag(123)).toBeNull();
    expect(validateTag({})).toBeNull();
  });

  it('preserves special characters in valid tags', () => {
    expect(validateTag('a\nb')).toBe('a\nb');
    expect(validateTag('tab\there')).toBe('tab\there');
    expect(validateTag('emoji-🎉')).toBe('emoji-🎉');
  });
});

describe('normalizeTags', () => {
  it('deduplicates tags', () => {
    expect(normalizeTags(['a', 'b', 'a', 'c', 'b'])).toEqual(['a', 'b', 'c']);
  });

  it('filters invalid tags', () => {
    expect(normalizeTags(['ok', '', '   ', null as unknown as string, 123 as unknown as string])).toEqual(['ok']);
  });

  it('handles empty input', () => {
    expect(normalizeTags([])).toEqual([]);
  });
});

describe('readMetaTagsInSource', () => {
  it('reads tags from a simple meta object', () => {
    const src = `export const meta = { title: 't', tags: ['a', 'b'] };\nexport default [];\n`;
    expect(readMetaTagsInSource(src)).toEqual({ kind: 'found', tags: ['a', 'b'] });
  });

  it('returns missing when tags field absent', () => {
    const src = `export const meta = { title: 't' };\nexport default [];\n`;
    expect(readMetaTagsInSource(src)).toEqual({ kind: 'missing' });
  });

  it('returns missing when meta export absent', () => {
    expect(readMetaTagsInSource(`export default [];\n`)).toEqual({ kind: 'missing' });
  });

  it('handles `as const` wrapping the entire meta object', () => {
    const src = `export const meta = { title: 't', tags: ['a'] } as const;\nexport default [];\n`;
    expect(readMetaTagsInSource(src)).toEqual({ kind: 'found', tags: ['a'] });
  });

  it('handles `as const` wrapping individual tag strings', () => {
    const src = `export const meta = { tags: ['a' as const, 'b' as const] };\nexport default [];\n`;
    expect(readMetaTagsInSource(src)).toEqual({ kind: 'found', tags: ['a', 'b'] });
  });

  it('handles satisfies wrapping the meta object', () => {
    const src = `export const meta = { tags: ['x'] } satisfies SlideMeta;\nexport default [];\n`;
    expect(readMetaTagsInSource(src)).toEqual({ kind: 'found', tags: ['x'] });
  });

  it('reads tags with special characters', () => {
    const src = `export const meta = { tags: ['line\\nbreak', 'tab\\there', '🎉'] };\nexport default [];\n`;
    expect(readMetaTagsInSource(src)).toEqual({ kind: 'found', tags: ['line\nbreak', 'tab\there', '🎉'] });
  });

  it('reads double-quoted and template tags', () => {
    const src = 'export const meta = { tags: ["a", `b`] };\nexport default [];\n';
    expect(readMetaTagsInSource(src)).toEqual({ kind: 'found', tags: ['a', 'b'] });
  });

  it('returns unsupported when tags value is not an array', () => {
    const src = `export const meta = { tags: 'not-array' };\nexport default [];\n`;
    expect(readMetaTagsInSource(src)).toEqual({ kind: 'unsupported' });
  });
});

describe('updateMetaTitleInSource — type assertions', () => {
  it('replaces title when value is wrapped in `as const`', () => {
    const src = `export const meta = { title: 'old' as const };\nexport default [];\n`;
    const out = updateMetaTitleInSource(src, 'new');
    expect(out).not.toBeNull();
    expect(out).toContain("title: 'new'");
    expect(out).not.toContain("'old'");
  });

  it('replaces title when whole meta is wrapped in `as const`', () => {
    const src = `export const meta = { title: 'old' } as const;\nexport default [];\n`;
    const out = updateMetaTitleInSource(src, 'new');
    expect(out).not.toBeNull();
    expect(out).toContain("title: 'new'");
    expect(out).toContain('as const');
  });
});

describe('updateMetaTagsInSource', () => {
  it('replaces an existing tags array on a single line', () => {
    const src = `export const meta = { title: 't', tags: ['old'] };\nexport default [];\n`;
    const out = updateMetaTagsInSource(src, ['a', 'b']);
    expect(out).not.toBeNull();
    expect(out).toContain("tags: ['a', 'b']");
    expect(out).not.toContain("'old'");
    expect(out).toContain("{ title: 't', tags: ['a', 'b'] }");
  });

  it('replaces tags when wrapped in `as const`', () => {
    const src = `export const meta = { tags: ['old'] as const };\nexport default [];\n`;
    const out = updateMetaTagsInSource(src, ['new']);
    expect(out).not.toBeNull();
    expect(out).toContain("tags: ['new']");
    expect(out).toContain('as const');
  });

  it('preserves multi-line indentation when replacing existing tags', () => {
    const src = `export const meta = {\n  title: 't',\n  tags: ['old'],\n};\nexport default [];\n`;
    const out = updateMetaTagsInSource(src, ['a', 'b']);
    expect(out).not.toBeNull();
    expect(out).toContain('  title');
    expect(out).toContain("tags: ['a', 'b']");
    expect(out).toMatch(/\n  tags: \['a', 'b'\],/);
  });

  it('injects tags into a single-line meta object without breaking compact layout', () => {
    const src = `export const meta = { title: 't' };\nexport default [];\n`;
    const out = updateMetaTagsInSource(src, ['x']);
    expect(out).not.toBeNull();
    expect(out).toContain("{ title: 't', tags: ['x'] }");
    expect(out).not.toContain('\ntags');
  });

  it('injects tags into a multi-line meta object preserving indentation', () => {
    const src = `export const meta = {\n  title: 't',\n};\nexport default [];\n`;
    const out = updateMetaTagsInSource(src, ['x']);
    expect(out).not.toBeNull();
    expect(out).toMatch(/\n  tags: \['x'\],/);
    expect(out).toContain('  title');
  });

  it('injects fresh meta + tags when no meta export exists', () => {
    const src = `export default [];\n`;
    const out = updateMetaTagsInSource(src, ['a']);
    expect(out).not.toBeNull();
    expect(out).toContain("export const meta: SlideMeta = { tags: ['a'] };");
    expect(out).toContain('export default []');
  });

  it('escapes special characters in tag strings', () => {
    const src = `export const meta = { tags: [] };\nexport default [];\n`;
    const out = updateMetaTagsInSource(src, ["it's", 'a\\b', 'line\nbreak']);
    expect(out).not.toBeNull();
    expect(out).toContain("'it\\'s'");
    expect(out).toContain("'a\\\\b'");
    expect(out).toContain("'line\\nbreak'");
  });

  it('writes an empty tags array', () => {
    const src = `export const meta = { title: 't' };\nexport default [];\n`;
    const out = updateMetaTagsInSource(src, []);
    expect(out).not.toBeNull();
    expect(out).toContain('tags: []');
  });
});

describe('tags helpers', () => {
  function buildHelpers(ids: string[], tagsMap: Record<string, string[]>) {
    return {
      slidesByTag: (tag: string) => ids.filter((id) => (tagsMap[id] ?? []).indexOf(tag) !== -1),
      listAllTags: () => {
        const seen = new Set<string>();
        const result: string[] = [];
        for (const id of ids) {
          for (const t of tagsMap[id] ?? []) {
            if (!seen.has(t)) {
              seen.add(t);
              result.push(t);
            }
          }
        }
        return result;
      },
      slideHasTag: (slideId: string, tag: string) =>
        (tagsMap[slideId] ?? []).indexOf(tag) !== -1,
    };
  }

  it('slidesByTag returns empty array for nonexistent tag', () => {
    const h = buildHelpers(['s1', 's2'], { s1: ['intro'] });
    expect(h.slidesByTag('missing')).toEqual([]);
  });

  it('slidesByTag finds slides with multiple tags', () => {
    const h = buildHelpers(
      ['s1', 's2', 's3'],
      { s1: ['intro', 'ch1'], s2: ['ch1'], s3: ['outro'] },
    );
    expect(h.slidesByTag('ch1')).toEqual(['s1', 's2']);
    expect(h.slidesByTag('intro')).toEqual(['s1']);
  });

  it('listAllTags returns empty on empty tagsMap', () => {
    const h = buildHelpers(['s1', 's2'], {});
    expect(h.listAllTags()).toEqual([]);
  });

  it('listAllTags deduplicates across slides', () => {
    const h = buildHelpers(['s1', 's2'], { s1: ['a', 'b'], s2: ['b', 'c'] });
    expect(h.listAllTags()).toEqual(['a', 'b', 'c']);
  });

  it('slideHasTag returns false for missing slide or tag', () => {
    const h = buildHelpers(['s1'], { s1: ['a'] });
    expect(h.slideHasTag('missing', 'a')).toBe(false);
    expect(h.slideHasTag('s1', 'missing')).toBe(false);
  });

  it('slideHasTag returns true when slide carries tag', () => {
    const h = buildHelpers(['s1'], { s1: ['a', 'b'] });
    expect(h.slideHasTag('s1', 'a')).toBe(true);
    expect(h.slideHasTag('s1', 'b')).toBe(true);
  });

  it('duplicate slide ids counted once', () => {
    const h = buildHelpers(
      ['s1', 's1', 's2'],
      { s1: ['a'], s2: ['b'] },
    );
    expect(h.slidesByTag('a')).toEqual(['s1', 's1']);
    expect(h.listAllTags()).toEqual(['a', 'b']);
  });
});

describe('duplicateSlideDir preserves tags', () => {
  it('copies tags verbatim from source to copy', async () => {
    await withSlidesRoot(async (root) => {
      await fs.mkdir(path.join(root, 'tagged', 'assets'), { recursive: true });
      await fs.writeFile(
        path.join(root, 'tagged', 'index.tsx'),
        `export const meta = { title: 'T', tags: ['a', 'b'] };\nexport default [];\n`,
        'utf8',
      );

      const result = await duplicateSlideDir(root, 'tagged');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const copied = await fs.readFile(
        path.join(root, result.slideId, 'index.tsx'),
        'utf8',
      );
      expect(copied).toContain("tags: ['a', 'b']");
      expect(copied).toContain("title: 'T (copy)'");
    });
  });

  it('creates a copy without tags field when source has none', async () => {
    await withSlidesRoot(async (root) => {
      await fs.mkdir(path.join(root, 'notags', 'assets'), { recursive: true });
      await fs.writeFile(
        path.join(root, 'notags', 'index.tsx'),
        `export const meta = { title: 'T' };\nexport default [];\n`,
        'utf8',
      );

      const result = await duplicateSlideDir(root, 'notags');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const copied = await fs.readFile(
        path.join(root, result.slideId, 'index.tsx'),
        'utf8',
      );
      expect(copied).not.toContain('tags');
    });
  });

  it('copies an empty tags array verbatim', async () => {
    await withSlidesRoot(async (root) => {
      await fs.mkdir(path.join(root, 'empty-tags', 'assets'), { recursive: true });
      await fs.writeFile(
        path.join(root, 'empty-tags', 'index.tsx'),
        `export const meta = { title: 'T', tags: [] };\nexport default [];\n`,
        'utf8',
      );

      const result = await duplicateSlideDir(root, 'empty-tags');
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const copied = await fs.readFile(
        path.join(root, result.slideId, 'index.tsx'),
        'utf8',
      );
      expect(copied).toContain('tags: []');
    });
  });
});
