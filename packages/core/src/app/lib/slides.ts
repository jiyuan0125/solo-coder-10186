import {
  slideCreatedAt as createdAt,
  slideIds as ids,
  loadSlide as load,
  slideTags as tags,
  slideThemes as themes,
} from 'virtual:open-slide/slides';
import type { SlideModule } from './sdk';

export const slideIds: string[] = ids;
export const slideThemes: Record<string, string> = themes;
export const slideCreatedAt: Record<string, number> = createdAt;
export const slideTags: Record<string, string[]> = tags;

export function slidesByTheme(themeId: string): string[] {
  return slideIds.filter((id) => slideThemes[id] === themeId);
}

export function slidesByTag(tag: string): string[] {
  return slideIds.filter((id) => {
    const slideTagList = slideTags[id];
    return slideTagList?.includes(tag);
  });
}

export function getAllTags(): string[] {
  const tagSet = new Set<string>();
  for (const id of slideIds) {
    const tagList = slideTags[id];
    if (tagList) {
      for (const tag of tagList) {
        tagSet.add(tag);
      }
    }
  }
  return Array.from(tagSet).sort();
}

export function slideHasTag(slideId: string, tag: string): boolean {
  const tagList = slideTags[slideId];
  return tagList?.includes(tag) ?? false;
}

export async function loadSlide(id: string): Promise<SlideModule> {
  return load(id);
}

export function slideChangeIncludes(data: unknown, slideId: string): boolean {
  if (!data || typeof data !== 'object') return false;
  const payload = data as { slideId?: unknown; slideIds?: unknown };
  if (payload.slideId === slideId) return true;
  return Array.isArray(payload.slideIds) && payload.slideIds.includes(slideId);
}
