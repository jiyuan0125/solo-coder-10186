import fs from 'node:fs/promises';
import type { ViteDevServer } from 'vite';
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
  resolveSlideEntry,
  rmSlideDir,
  SLIDE_ID_RE,
  updateMetaTitleInSource,
  validateSlideName,
  validateTag,
} from '../../editing/slide-ops.ts';
import { readManifest, writeManifest } from '../../files/folders.ts';
import { validateMutationRequest } from '../../http/request-guard.ts';
import { type ApiContext, json, readBody } from './context.ts';

const SLIDES_VMOD = 'virtual:open-slide/slides';

function resolved(id: string): string {
  return `\0${id}`;
}

let slideChangeTimer: ReturnType<typeof setTimeout> | null = null;
const pendingSlideChanges = new Set<string>();

function notifySlideChanged(server: ViteDevServer, id: string): void {
  pendingSlideChanges.add(id);
  if (slideChangeTimer) clearTimeout(slideChangeTimer);
  slideChangeTimer = setTimeout(() => {
    slideChangeTimer = null;
    const mod = server.moduleGraph.getModuleById(resolved(SLIDES_VMOD));
    if (mod) server.moduleGraph.invalidateModule(mod);
    const slideIds = Array.from(pendingSlideChanges);
    pendingSlideChanges.clear();
    server.ws.send({
      type: 'custom',
      event: 'open-slide:slide-changed',
      data: { slideIds },
    });
    server.ws.send({ type: 'full-reload' });
  }, 100);
}

// PUT    /__slides/:id/reorder            reorder pages { order: number[] }
// DELETE /__slides/:id/pages/:i           remove page
// POST   /__slides/:id/pages/:i/duplicate duplicate page
// POST   /__slides/:id/duplicate          duplicate slide directory { newId? }
// PUT    /__slides/:id/tags               replace tags { tags: string[] }
// POST   /__slides/:id/tags               add tags { tags: string[] }
// DELETE /__slides/:id/tags               remove tags { tags: string[] }
// PATCH  /__slides/:id                    rename slide (writes meta.title)
// DELETE /__slides/:id                    delete slide directory + folder assignment

type DuplicateSlideBody = { newId?: unknown };
type SlidePatchBody = { name?: unknown };
type TagsBody = { tags?: unknown };

export function registerSlideRoutes(server: ViteDevServer, ctx: ApiContext): void {
  server.middlewares.use('/__slides', async (req, res, next) => {
    const url = new URL(req.url ?? '/', 'http://local');
    const method = req.method ?? 'GET';

    try {
      const reorderMatch = url.pathname.match(/^\/([^/]+)\/reorder$/);
      if (reorderMatch && method === 'PUT') {
        const requestCheck = validateMutationRequest(req, { requireJsonBody: true });
        if (!requestCheck.ok) {
          return json(res, requestCheck.status, { error: requestCheck.error });
        }
        const slideId = reorderMatch[1];
        if (!SLIDE_ID_RE.test(slideId)) return json(res, 400, { error: 'invalid slideId' });

        const body = (await readBody(req)) as { order?: unknown };
        if (!Array.isArray(body.order)) return json(res, 400, { error: 'invalid order' });
        const order: number[] = [];
        for (const v of body.order) {
          if (!Number.isInteger(v)) return json(res, 400, { error: 'invalid order' });
          order.push(v as number);
        }

        const entry = resolveSlideEntry(ctx.slidesRoot, slideId);
        if (!entry) return json(res, 400, { error: 'invalid slideId' });

        let source: string;
        try {
          source = await fs.readFile(entry, 'utf8');
        } catch {
          return json(res, 404, { error: 'slide not found' });
        }

        const reordered = reorderDefaultExportPagesInSource(source, order);
        if (reordered === null) {
          return json(res, 422, {
            error: 'could not reorder pages — order must be a permutation of the existing array',
          });
        }
        const withNotes = reorderNotesArrayInSource(reordered, order);
        if (withNotes === null) {
          return json(res, 422, {
            error: 'could not reorder pages — `notes` export has an unexpected shape',
          });
        }
        if (withNotes !== source) {
          await fs.writeFile(entry, withNotes, 'utf8');
        }
        return json(res, 200, { ok: true, slideId, order });
      }

      const pageOpMatch = url.pathname.match(/^\/([^/]+)\/pages\/(\d+)(?:\/([a-z]+))?$/);
      if (pageOpMatch) {
        const slideId = pageOpMatch[1];
        const pageIndex = Number.parseInt(pageOpMatch[2], 10);
        const op = pageOpMatch[3];
        if (!SLIDE_ID_RE.test(slideId)) return json(res, 400, { error: 'invalid slideId' });
        if (!Number.isInteger(pageIndex) || pageIndex < 0)
          return json(res, 400, { error: 'invalid page index' });

        const isDelete = method === 'DELETE' && !op;
        const isDuplicate = method === 'POST' && op === 'duplicate';
        if (!isDelete && !isDuplicate) return next();
        const requestCheck = validateMutationRequest(req);
        if (!requestCheck.ok) {
          return json(res, requestCheck.status, { error: requestCheck.error });
        }

        const entry = resolveSlideEntry(ctx.slidesRoot, slideId);
        if (!entry) return json(res, 400, { error: 'invalid slideId' });

        let source: string;
        try {
          source = await fs.readFile(entry, 'utf8');
        } catch {
          return json(res, 404, { error: 'slide not found' });
        }

        const updated = isDelete
          ? removePageFromDefaultExportInSource(source, pageIndex)
          : duplicatePageInDefaultExportInSource(source, pageIndex);
        if (updated === null) {
          return json(res, 422, {
            error: isDelete
              ? 'could not delete page — index out of range or default export is not an array'
              : 'could not duplicate page — index out of range or default export is not an array',
          });
        }
        if (updated !== source) {
          await fs.writeFile(entry, updated, 'utf8');
        }
        return json(res, 200, { ok: true, slideId, index: pageIndex });
      }

      const duplicateMatch = url.pathname.match(/^\/([^/]+)\/duplicate$/);
      if (duplicateMatch && method === 'POST') {
        const requestCheck = validateMutationRequest(req);
        if (!requestCheck.ok) {
          return json(res, requestCheck.status, { error: requestCheck.error });
        }
        const slideId = duplicateMatch[1];
        if (!SLIDE_ID_RE.test(slideId)) return json(res, 400, { error: 'invalid slideId' });

        const body = (await readBody(req)) as DuplicateSlideBody;
        if (body.newId !== undefined && typeof body.newId !== 'string') {
          return json(res, 400, { error: 'invalid newId' });
        }

        const duplicated = await duplicateSlideDir(ctx.slidesRoot, slideId, body.newId);
        if (!duplicated.ok) return json(res, duplicated.status, { error: duplicated.error });

        const manifest = await readManifest(ctx.manifestPath);
        const folderId = manifest.assignments[slideId];
        if (folderId) {
          manifest.assignments[duplicated.slideId] = folderId;
          await writeManifest(ctx.manifestPath, manifest);
        }
        return json(res, 200, { ok: true, slideId: duplicated.slideId });
      }

      const tagsMatch = url.pathname.match(/^\/([^/]+)\/tags$/);
      if (tagsMatch) {
        const slideId = tagsMatch[1];
        if (!SLIDE_ID_RE.test(slideId)) return json(res, 400, { error: 'invalid slideId' });
        const requestCheck = validateMutationRequest(req, { requireJsonBody: true });
        if (!requestCheck.ok) {
          return json(res, requestCheck.status, { error: requestCheck.error });
        }

        const body = (await readBody(req)) as TagsBody;
        if (!Array.isArray(body.tags)) {
          return json(res, 400, { error: 'invalid tags — expected string array' });
        }
        const tags: string[] = [];
        const seen = new Set<string>();
        for (const t of body.tags) {
          if (typeof t !== 'string') {
            return json(res, 400, { error: 'invalid tags — expected string array' });
          }
          const validated = validateTag(t);
          if (validated === null) {
            return json(res, 400, {
              error: `invalid tag — must be non-empty, non-whitespace, and ≤ ${MAX_TAG_LENGTH} characters`,
            });
          }
          if (!seen.has(validated)) {
            seen.add(validated);
            tags.push(validated);
          }
        }

        const entry = resolveSlideEntry(ctx.slidesRoot, slideId);
        if (!entry) return json(res, 400, { error: 'invalid slideId' });

        let source: string;
        try {
          source = await fs.readFile(entry, 'utf8');
        } catch {
          return json(res, 404, { error: 'slide not found' });
        }

        let updated: string | null = null;
        if (method === 'PUT') {
          updated = replaceMetaTagsInSource(source, tags);
        } else if (method === 'POST') {
          updated = addTagsToMetaInSource(source, tags);
        } else if (method === 'DELETE') {
          updated = removeTagsFromMetaInSource(source, tags);
        } else {
          return next();
        }

        if (updated === null) {
          return json(res, 422, {
            error: 'could not update tags in index.tsx',
          });
        }
        if (updated !== source) {
          await fs.writeFile(entry, updated, 'utf8');
        }
        notifySlideChanged(server, slideId);
        return json(res, 200, { ok: true, slideId, tags });
      }

      const idMatch = url.pathname.match(/^\/([^/]+)$/);
      if (!idMatch) return next();
      const slideId = idMatch[1];
      if (!SLIDE_ID_RE.test(slideId)) return json(res, 400, { error: 'invalid slideId' });

      if (method === 'PATCH') {
        const requestCheck = validateMutationRequest(req, { requireJsonBody: true });
        if (!requestCheck.ok) {
          return json(res, requestCheck.status, { error: requestCheck.error });
        }
        const body = (await readBody(req)) as SlidePatchBody;
        const name = validateSlideName(body.name);
        if (!name) return json(res, 400, { error: 'invalid name' });

        const entry = resolveSlideEntry(ctx.slidesRoot, slideId);
        if (!entry) return json(res, 400, { error: 'invalid slideId' });

        let source: string;
        try {
          source = await fs.readFile(entry, 'utf8');
        } catch {
          return json(res, 404, { error: 'slide not found' });
        }

        const updated = updateMetaTitleInSource(source, name);
        if (updated === null) {
          return json(res, 422, {
            error: 'could not locate a safe place to write meta.title in index.tsx',
          });
        }
        if (updated !== source) {
          await fs.writeFile(entry, updated, 'utf8');
        }
        notifySlideChanged(server, slideId);
        return json(res, 200, { ok: true, slideId, name });
      }

      if (method === 'DELETE') {
        const requestCheck = validateMutationRequest(req);
        if (!requestCheck.ok) {
          return json(res, requestCheck.status, { error: requestCheck.error });
        }
        const removed = await rmSlideDir(ctx.slidesRoot, slideId);
        if (!removed) return json(res, 404, { error: 'slide not found' });

        const manifest = await readManifest(ctx.manifestPath);
        delete manifest.assignments[slideId];
        await writeManifest(ctx.manifestPath, manifest);
        return json(res, 200, { ok: true });
      }

      return next();
    } catch (err) {
      json(res, 500, { error: String((err as Error).message ?? err) });
    }
  });
}
