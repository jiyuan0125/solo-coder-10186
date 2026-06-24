import {
  listAllTags as listAll,
  loadSlide as load,
  slideCreatedAt as createdAt,
  slideHasTag as hasTag,
  slideIds as ids,
  slidesByTag as byTag,
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
  return byTag(tag);
}

export function listAllTags(): string[] {
  return listAll();
}

export function slideHasTag(slideId: string, tag: string): boolean {
  return hasTag(slideId, tag);
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
