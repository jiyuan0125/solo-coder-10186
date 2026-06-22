import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  addTagsToMetaInSource,
  duplicatePageInDefaultExportInSource,
  duplicateSlideDir,
  MAX_TAG_LENGTH,
  removePageFromDefaultExportInSource,
  removeTagsFromMetaInSource,
  reorderDefaultExportPagesInSource,
  reorderNotesArrayInSource,
  replaceMetaTagsInSource,
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

async function writeSlideWithTags(
  root: string,
  id: string,
  title: string,
  tags: string[],
): Promise<void> {
  await fs.mkdir(path.join(root, id, 'assets'), { recursive: true });
  const tagsSrc = tags.length === 0 ? '[]' : `['${tags.join("', '")}']`;
  await fs.writeFile(
    path.join(root, id, 'index.tsx'),
    `export const meta = { title: '${title}', tags: ${tagsSrc} };\nexport default [];\n`,
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

  it('preserves tags on the copied slide', async () => {
    await withSlidesRoot(async (root) => {
      await writeSlideWithTags(root, 'intro', 'Introduction', ['overview', 'beginner']);

      const result = await duplicateSlideDir(root, 'intro');

      expect(result).toEqual({ ok: true, slideId: 'intro-copy' });
      const copied = await fs.readFile(
        path.join(root, 'intro-copy', 'index.tsx'),
        'utf8',
      );
      expect(copied).toContain("title: 'Introduction (copy)'");
      expect(copied).toContain("'overview'");
      expect(copied).toContain("'beginner'");
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

describe('replaceMetaTagsInSource', () => {
  it('replaces an existing tags array', () => {
    const source = `export const meta = { tags: ['old'] };\nexport default [];\n`;
    const out = replaceMetaTagsInSource(source, ['new', 'shiny']);
    expect(out).toContain("tags: ['new', 'shiny']");
    expect(out).not.toContain("'old'");
  });

  it('injects tags into a meta object that lacks them', () => {
    const source = `export const meta = {\n  title: 'x',\n};\nexport default [];\n`;
    const out = replaceMetaTagsInSource(source, ['intro']);
    expect(out).toMatch(/tags:\s*\['intro'\]/);
    expect(out).toContain("title: 'x'");
  });

  it('injects a fresh meta export when none exists', () => {
    const source = `export default [];\n`;
    const out = replaceMetaTagsInSource(source, ['a', 'b']);
    expect(out).toContain('export const meta: SlideMeta = { tags: ');
    expect(out).toContain("['a', 'b']");
    expect(out).toContain('export default []');
  });

  it('returns null if there is no meta and no default export', () => {
    expect(replaceMetaTagsInSource('// nothing', ['x'])).toBeNull();
  });

  it('handles empty tag list', () => {
    const source = `export const meta = { tags: ['a', 'b'] };\nexport default [];\n`;
    const out = replaceMetaTagsInSource(source, []);
    expect(out).toContain('tags: []');
    expect(out).not.toContain("'a'");
    expect(out).not.toContain("'b'");
  });

  it('escapes special characters in tag values', () => {
    const source = `export const meta = { tags: ['old'] };\nexport default [];\n`;
    const out = replaceMetaTagsInSource(source, ["it's", 'a\\b', "qu'ote"]);
    expect(out).toContain("'it\\'s'");
    expect(out).toContain("'a\\\\b'");
    expect(out).toContain("'qu\\'ote'");
  });

  it('works with braces inside string values in meta', () => {
    const source = `export const meta = { title: '{ tricky }', tags: ['old'] };\nexport default [];\n`;
    const out = replaceMetaTagsInSource(source, ['new']);
    expect(out).toContain("tags: ['new']");
    expect(out).toContain("title: '{ tricky }'");
  });

  it('works with template literals in meta', () => {
    const source = 'export const meta = { title: `{ templated }`, tags: ["old"] };\nexport default [];\n';
    const out = replaceMetaTagsInSource(source, ['new']);
    expect(out).toContain("tags: ['new']");
    expect(out).toContain('`{ templated }`');
  });

  it('works with comments containing braces', () => {
    const source = `export const meta = {
  // comment with { braces }
  title: 'x',
  tags: ['old'],
};\nexport default [];\n`;
    const out = replaceMetaTagsInSource(source, ['new']);
    expect(out).toContain("tags: ['new']");
    expect(out).toContain('// comment with { braces }');
  });
});

describe('addTagsToMetaInSource', () => {
  it('adds tags to an existing tags array', () => {
    const source = `export const meta = { tags: ['a'] };\nexport default [];\n`;
    const out = addTagsToMetaInSource(source, ['b', 'c']);
    expect(out).toContain("'a'");
    expect(out).toContain("'b'");
    expect(out).toContain("'c'");
  });

  it('skips duplicate tags', () => {
    const source = `export const meta = { tags: ['a', 'b'] };\nexport default [];\n`;
    const out = addTagsToMetaInSource(source, ['b', 'c']);
    const match = out?.match(/tags:\s*\[(.*?)\]/);
    expect(match).not.toBeNull();
    const tagList = match![1];
    expect((tagList.match(/'b'/g) || []).length).toBe(1);
    expect(tagList).toContain("'c'");
  });

  it('creates tags array when none exists', () => {
    const source = `export const meta = { title: 'x' };\nexport default [];\n`;
    const out = addTagsToMetaInSource(source, ['new']);
    expect(out).toMatch(/tags:\s*\['new'\]/);
  });

  it('creates meta export when none exists', () => {
    const source = `export default [];\n`;
    const out = addTagsToMetaInSource(source, ['first']);
    expect(out).toContain('tags: ');
    expect(out).toContain("'first'");
  });

  it('returns null on unsupported meta shape', () => {
    const source = `export const meta = () => {};\nexport default [];\n`;
    expect(addTagsToMetaInSource(source, ['x'])).toBeNull();
  });

  it('works with braces in string values', () => {
    const source = `export const meta = { title: '{ tricky }', tags: ['a'] };\nexport default [];\n`;
    const out = addTagsToMetaInSource(source, ['b']);
    expect(out).toContain("'a'");
    expect(out).toContain("'b'");
    expect(out).toContain("title: '{ tricky }'");
  });
});

describe('removeTagsFromMetaInSource', () => {
  it('removes specified tags from an existing array', () => {
    const source = `export const meta = { tags: ['a', 'b', 'c'] };\nexport default [];\n`;
    const out = removeTagsFromMetaInSource(source, ['b']);
    expect(out).toContain("'a'");
    expect(out).not.toContain("'b'");
    expect(out).toContain("'c'");
  });

  it('silently skips tags that are not present', () => {
    const source = `export const meta = { tags: ['a'] };\nexport default [];\n`;
    const out = removeTagsFromMetaInSource(source, ['not-there']);
    expect(out).toBe(source);
  });

  it('returns source unchanged when tags property is missing', () => {
    const source = `export const meta = { title: 'x' };\nexport default [];\n`;
    expect(removeTagsFromMetaInSource(source, ['a'])).toBe(source);
  });

  it('leaves empty array when all tags are removed', () => {
    const source = `export const meta = { tags: ['only'] };\nexport default [];\n`;
    const out = removeTagsFromMetaInSource(source, ['only']);
    expect(out).toContain('tags: []');
    expect(out).not.toContain("'only'");
  });

  it('returns null on unsupported meta shape', () => {
    const source = `export const meta = 'oops';\nexport default [];\n`;
    expect(removeTagsFromMetaInSource(source, ['x'])).toBeNull();
  });

  it('works with braces in string values', () => {
    const source = `export const meta = { title: '{ tricky }', tags: ['a', 'b'] };\nexport default [];\n`;
    const out = removeTagsFromMetaInSource(source, ['a']);
    expect(out).not.toContain("'a'");
    expect(out).toContain("'b'");
    expect(out).toContain("title: '{ tricky }'");
  });
});

describe('updateMetaTitleInSource — edge cases with braces in strings/comments', () => {
  it('handles braces inside title string value', () => {
    const source = `export const meta = { title: '{ old }' };\nexport default [];\n`;
    const out = updateMetaTitleInSource(source, 'new');
    expect(out).toContain("title: 'new'");
    expect(out).not.toContain('{ old }');
  });

  it('handles template literals with braces', () => {
    const source = 'export const meta = { title: `{braced}` };\nexport default [];\n';
    const out = updateMetaTitleInSource(source, 'new');
    expect(out).toContain("title: 'new'");
  });

  it('handles comments with braces', () => {
    const source = `export const meta = {
  // { commented }
  title: 'old',
};\nexport default [];\n`;
    const out = updateMetaTitleInSource(source, 'new');
    expect(out).toContain("title: 'new'");
    expect(out).toContain('// { commented }');
  });

  it('handles string values with nested braces', () => {
    const source = `export const meta = { theme: 'light { cool }', title: 'old' };\nexport default [];\n`;
    const out = updateMetaTitleInSource(source, 'new');
    expect(out).toContain("title: 'new'");
    expect(out).toContain("theme: 'light { cool }'");
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
  it('accepts valid tags', () => {
    expect(validateTag('hello')).toBe('hello');
    expect(validateTag('a')).toBe('a');
    expect(validateTag('tag with spaces')).toBe('tag with spaces');
    expect(validateTag('中文标签')).toBe('中文标签');
    expect(validateTag('x'.repeat(MAX_TAG_LENGTH))).toBe('x'.repeat(MAX_TAG_LENGTH));
  });

  it('rejects empty strings', () => {
    expect(validateTag('')).toBeNull();
  });

  it('rejects whitespace-only strings', () => {
    expect(validateTag('   ')).toBeNull();
    expect(validateTag('\t')).toBeNull();
    expect(validateTag('\n')).toBeNull();
  });

  it('rejects strings exceeding max length', () => {
    expect(validateTag('x'.repeat(MAX_TAG_LENGTH + 1))).toBeNull();
  });

  it('rejects non-string values', () => {
    expect(validateTag(null)).toBeNull();
    expect(validateTag(undefined)).toBeNull();
    expect(validateTag(123)).toBeNull();
    expect(validateTag({})).toBeNull();
    expect(validateTag([])).toBeNull();
  });
});

describe('type assertions (as const / satisfies) handling', () => {
  it('reads title wrapped with as const', () => {
    const source = `export const meta = { title: 'old' as const };\nexport default [];\n`;
    const out = updateMetaTitleInSource(source, 'new');
    expect(out).toContain("title: 'new' as const");
    expect(out).not.toContain("'old'");
  });

  it('reads tags array wrapped with as const', () => {
    const source = `export const meta = { tags: ['a'] as const };\nexport default [];\n`;
    const out = replaceMetaTagsInSource(source, ['b', 'c']);
    expect(out).toContain("tags: ['b', 'c'] as const");
    expect(out).not.toContain("'a'");
  });

  it('reads entire meta object wrapped with as const', () => {
    const source = `export const meta = { title: 'old', tags: ['a'] } as const;\nexport default [];\n`;
    const titleOut = updateMetaTitleInSource(source, 'new');
    expect(titleOut).toContain("title: 'new'");
    expect(titleOut).toContain("tags: ['a']");
    expect(titleOut).toContain('} as const;');

    const tagsOut = replaceMetaTagsInSource(source, ['b']);
    expect(tagsOut).toContain("tags: ['b']");
    expect(tagsOut).toContain("title: 'old'");
    expect(tagsOut).toContain('} as const;');
  });

  it('reads entire meta object wrapped with satisfies', () => {
    const source = `export const meta = { title: 'old', tags: ['a'] } satisfies SlideMeta;\nexport default [];\n`;
    const out = replaceMetaTagsInSource(source, ['b']);
    expect(out).toContain("tags: ['b']");
    expect(out).toContain('} satisfies SlideMeta;');
  });

  it('reads tags with individual elements wrapped in as const', () => {
    const source = `export const meta = { tags: ['a' as const, 'b' as const] };\nexport default [];\n`;
    const out = addTagsToMetaInSource(source, ['c']);
    expect(out).toContain("'a'");
    expect(out).toContain("'b'");
    expect(out).toContain("'c'");
  });

  it('adds tags to meta object wrapped with as const', () => {
    const source = `export const meta = { title: 'x' } as const;\nexport default [];\n`;
    const out = addTagsToMetaInSource(source, ['new']);
    expect(out).toContain("tags: ['new']");
    expect(out).toContain('} as const;');
  });
});

describe('compact / inline object layout preservation', () => {
  it('keeps single-line meta object single-line when replacing tags', () => {
    const source = `export const meta = { title: 'x', tags: ['old'] };\nexport default [];\n`;
    const out = replaceMetaTagsInSource(source, ['new']);
    expect(out).toContain("export const meta = { title: 'x', tags: ['new'] };");
    expect(out).not.toMatch(/tags:[\s\S]*\n[\s\S]*}/);
  });

  it('keeps single-line meta object single-line when replacing title', () => {
    const source = `export const meta = { title: 'old', tags: ['a'] };\nexport default [];\n`;
    const out = updateMetaTitleInSource(source, 'new');
    expect(out).toContain("export const meta = { title: 'new', tags: ['a'] };");
  });

  it('keeps single-line meta object single-line when adding new property', () => {
    const source = `export const meta = { title: 'x' };\nexport default [];\n`;
    const out = addTagsToMetaInSource(source, ['a']);
    expect(out).toContain("export const meta = { tags: ['a'], title: 'x' };");
  });

  it('preserves multi-line indentation when modifying existing property', () => {
    const source = `export const meta = {
  title: 'old',
  tags: ['a'],
};\nexport default [];\n`;
    const out = replaceMetaTagsInSource(source, ['b']);
    expect(out).toContain(`export const meta = {
  title: 'old',
  tags: ['b'],
};`);
  });

  it('preserves multi-line indentation when adding property', () => {
    const source = `export const meta = {
  title: 'x',
};\nexport default [];\n`;
    const out = addTagsToMetaInSource(source, ['a']);
    expect(out).toMatch(/export const meta = \{\n  tags: \['a'\],\n  title: 'x',\n\};/);
  });

  it('preserves tabs as indentation', () => {
    const source = "export const meta = {\n\ttitle: 'old',\n\ttags: ['a'],\n};\nexport default [];\n";
    const out = replaceMetaTagsInSource(source, ['b']);
    expect(out).toContain("\ttitle: 'old'");
    expect(out).toContain("\ttags: ['b']");
  });
});

describe('special characters in tag values', () => {
  it('round-trips tags with newlines', () => {
    const tag = 'line1\nline2';
    const source = `export const meta = { tags: [] };\nexport default [];\n`;
    const out = addTagsToMetaInSource(source, [tag]);
    expect(out).toContain("'line1\\nline2'");
  });

  it('round-trips tags with tabs', () => {
    const tag = 'a\tb';
    const source = `export const meta = { tags: [] };\nexport default [];\n`;
    const out = addTagsToMetaInSource(source, [tag]);
    expect(out).toContain("'a\\tb'");
  });

  it('round-trips tags with backslashes', () => {
    const source = `export const meta = { tags: ['a\\\\b'] };\nexport default [];\n`;
    const out = addTagsToMetaInSource(source, ['c']);
    expect(out).toContain("'a\\\\b'");
    expect(out).toContain("'c'");
  });

  it('round-trips tags with Unicode high characters', () => {
    const tag = '🎉日本語𝄞';
    const source = `export const meta = { tags: [] };\nexport default [];\n`;
    const out = addTagsToMetaInSource(source, [tag]);
    expect(out).toContain(tag);
  });

  it('handles tags with single quotes inside', () => {
    const source = `export const meta = { tags: [] };\nexport default [];\n`;
    const out = addTagsToMetaInSource(source, ["it's working"]);
    expect(out).toContain("'it\\'s working'");
  });

  it('deduplicates tags when replacing', () => {
    const source = `export const meta = { tags: [] };\nexport default [];\n`;
    const out = replaceMetaTagsInSource(source, ['a', 'b', 'a', 'c', 'b']);
    const match = out?.match(/tags:\s*\[(.*?)\]/);
    expect(match).not.toBeNull();
    const tagList = match![1];
    expect((tagList.match(/'a'/g) || []).length).toBe(1);
    expect((tagList.match(/'b'/g) || []).length).toBe(1);
    expect((tagList.match(/'c'/g) || []).length).toBe(1);
  });

  it('deduplicates tags when adding', () => {
    const source = `export const meta = { tags: ['a', 'b'] };\nexport default [];\n`;
    const out = addTagsToMetaInSource(source, ['b', 'c', 'a']);
    const match = out?.match(/tags:\s*\[(.*?)\]/);
    expect(match).not.toBeNull();
    const tagList = match![1];
    expect((tagList.match(/'a'/g) || []).length).toBe(1);
    expect((tagList.match(/'b'/g) || []).length).toBe(1);
    expect((tagList.match(/'c'/g) || []).length).toBe(1);
  });
});

describe('duplicateSlideDir with tags edge cases', () => {
  it('does not add tags field to copy when original has none', async () => {
    await withSlidesRoot(async (root) => {
      await writeSlide(root, 'notags', 'No Tags');

      const result = await duplicateSlideDir(root, 'notags');
      expect(result).toEqual({ ok: true, slideId: 'notags-copy' });

      const copied = await fs.readFile(
        path.join(root, 'notags-copy', 'index.tsx'),
        'utf8',
      );
      expect(copied).not.toContain('tags:');
      expect(copied).toContain("title: 'No Tags (copy)'");
    });
  });

  it('preserves empty tags array on copy', async () => {
    await withSlidesRoot(async (root) => {
      await writeSlideWithTags(root, 'empty', 'Empty', []);

      const result = await duplicateSlideDir(root, 'empty');
      expect(result).toEqual({ ok: true, slideId: 'empty-copy' });

      const copied = await fs.readFile(
        path.join(root, 'empty-copy', 'index.tsx'),
        'utf8',
      );
      expect(copied).toContain('tags: []');
      expect(copied).toContain("title: 'Empty (copy)'");
    });
  });

  it('preserves all tags exactly on copy', async () => {
    await withSlidesRoot(async (root) => {
      await writeSlideWithTags(root, 'multi', 'Multi', ['alpha', 'beta', 'gamma']);

      const result = await duplicateSlideDir(root, 'multi');
      expect(result).toEqual({ ok: true, slideId: 'multi-copy' });

      const copied = await fs.readFile(
        path.join(root, 'multi-copy', 'index.tsx'),
        'utf8',
      );
      expect(copied).toContain("'alpha'");
      expect(copied).toContain("'beta'");
      expect(copied).toContain("'gamma'");
      expect(copied).toContain("title: 'Multi (copy)'");
    });
  });
});
