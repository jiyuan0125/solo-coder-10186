import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  slideIds: [] as string[],
  slideTags: {} as Record<string, string[]>,
}));

vi.mock('virtual:open-slide/slides', () => ({
  get slideIds() {
    return state.slideIds;
  },
  get slideTags() {
    return state.slideTags;
  },
  get slideThemes() {
    return {};
  },
  get slideCreatedAt() {
    return {};
  },
  loadSlide: async (id: string) => {
    throw new Error('Slide not found: ' + id);
  },
}));

import { slidesByTag, getAllTags, slideHasTag } from './slides.ts';

describe('slidesByTag', () => {
  beforeEach(() => {
    state.slideIds = [];
    state.slideTags = {};
  });

  it('returns empty array when tagsMap is empty', () => {
    expect(slidesByTag('anything')).toEqual([]);
  });

  it('returns slide ids that have the specified tag', () => {
    state.slideIds = ['a', 'b', 'c'];
    state.slideTags = {
      a: ['intro', 'beginner'],
      b: ['intro', 'advanced'],
      c: ['advanced'],
    };
    expect(slidesByTag('intro')).toEqual(['a', 'b']);
    expect(slidesByTag('beginner')).toEqual(['a']);
    expect(slidesByTag('advanced')).toEqual(['b', 'c']);
  });

  it('returns empty array for a non-existent tag', () => {
    state.slideIds = ['a', 'b'];
    state.slideTags = {
      a: ['intro'],
      b: ['advanced'],
    };
    expect(slidesByTag('missing')).toEqual([]);
  });

  it('counts each slide id only once even if slideIds has duplicates', () => {
    state.slideIds = ['a', 'a', 'b'];
    state.slideTags = {
      a: ['intro'],
      b: ['intro'],
    };
    const result = slidesByTag('intro');
    expect(result).toEqual(['a', 'b']);
  });

  it('returns empty array for slides without tags field', () => {
    state.slideIds = ['a', 'b'];
    state.slideTags = {
      a: ['intro'],
    };
    expect(slidesByTag('intro')).toEqual(['a']);
    expect(slidesByTag('other')).toEqual([]);
  });
});

describe('getAllTags', () => {
  beforeEach(() => {
    state.slideIds = [];
    state.slideTags = {};
  });

  it('returns empty array when tagsMap is empty', () => {
    expect(getAllTags()).toEqual([]);
  });

  it('returns all unique tags sorted alphabetically', () => {
    state.slideIds = ['a', 'b', 'c'];
    state.slideTags = {
      a: ['zebra', 'apple'],
      b: ['banana', 'apple'],
      c: ['cherry'],
    };
    expect(getAllTags()).toEqual(['apple', 'banana', 'cherry', 'zebra']);
  });

  it('handles a single slide with multiple tags', () => {
    state.slideIds = ['a'];
    state.slideTags = {
      a: ['topic-c', 'topic-a', 'topic-b'],
    };
    expect(getAllTags()).toEqual(['topic-a', 'topic-b', 'topic-c']);
  });

  it('ignores duplicate tags across slides', () => {
    state.slideIds = ['a', 'b', 'c'];
    state.slideTags = {
      a: ['shared', 'a-only'],
      b: ['shared'],
      c: ['shared', 'c-only'],
    };
    const result = getAllTags();
    expect(result.filter((t) => t === 'shared').length).toBe(1);
    expect(result).toContain('a-only');
    expect(result).toContain('c-only');
  });
});

describe('slideHasTag', () => {
  beforeEach(() => {
    state.slideIds = [];
    state.slideTags = {};
  });

  it('returns false when tagsMap is empty', () => {
    expect(slideHasTag('any', 'tag')).toBe(false);
  });

  it('returns true when the slide has the specified tag', () => {
    state.slideIds = ['a', 'b'];
    state.slideTags = {
      a: ['intro', 'beginner'],
      b: ['advanced'],
    };
    expect(slideHasTag('a', 'intro')).toBe(true);
    expect(slideHasTag('a', 'beginner')).toBe(true);
    expect(slideHasTag('b', 'advanced')).toBe(true);
  });

  it('returns false when the slide does not have the specified tag', () => {
    state.slideIds = ['a', 'b'];
    state.slideTags = {
      a: ['intro'],
      b: ['advanced'],
    };
    expect(slideHasTag('a', 'advanced')).toBe(false);
    expect(slideHasTag('b', 'intro')).toBe(false);
  });

  it('returns false for a non-existent slide id', () => {
    state.slideIds = ['a'];
    state.slideTags = {
      a: ['intro'],
    };
    expect(slideHasTag('missing', 'intro')).toBe(false);
  });

  it('returns false for a slide without tags field', () => {
    state.slideIds = ['a', 'b'];
    state.slideTags = {
      a: ['intro'],
    };
    expect(slideHasTag('b', 'any')).toBe(false);
  });
});
