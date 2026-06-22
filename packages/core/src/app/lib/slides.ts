import {
  slideCreatedAt,
  slideIds,
  loadSlide,
  slideTags,
  slideThemes,
} from 'virtual:open-slide/slides';
import type { SlideModule } from './sdk';

export { slideIds, slideThemes, slideCreatedAt, slideTags, loadSlide };

export type { SlideModule };

export function slidesByTheme(themeId: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of slideIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (slideThemes[id] === themeId) {
      result.push(id);
    }
  }
  return result;
}

export function slidesByTag(tag: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of slideIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const slideTagList = slideTags[id];
    if (slideTagList?.includes(tag)) {
      result.push(id);
    }
  }
  return result;
}

export function getAllTags(): string[] {
  const tagSet = new Set<string>();
  const seenSlides = new Set<string>();
  for (const id of slideIds) {
    if (seenSlides.has(id)) continue;
    seenSlides.add(id);
    const tagList = slideTags[id];
    if (tagList) {
      for (const tag of tagList) {
        tagSet.add(tag);
      }
    }
  }
  return Array.from(tagSet).sort();
}

export function slideHasTag(id: string, tag: string): boolean {
  const tagList = slideTags[id];
  return tagList?.includes(tag) ?? false;
}

export function slideChangeIncludes(data: unknown, slideId: string): boolean {
  if (!data || typeof data !== 'object') return false;
  const payload = data as { slideId?: unknown; slideIds?: unknown };
  if (payload.slideId === slideId) return true;
  return Array.isArray(payload.slideIds) && payload.slideIds.includes(slideId);
}
