import fs from 'node:fs/promises';
import path from 'node:path';
import { parse as babelParse } from '@babel/parser';
import * as t from '@babel/types';

export const SLIDE_ID_RE = /^[a-z0-9_-]+$/i;

export const MAX_TAG_LENGTH = 200;

export function validateTag(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  if (v.length === 0) return null;
  if (v.trim().length === 0) return null;
  if (v.length > MAX_TAG_LENGTH) return null;
  return v;
}

type MetaTitleRead =
  | { kind: 'found'; title: string }
  | { kind: 'missing' }
  | { kind: 'unsupported' };

export function validateSlideName(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  if (trimmed.length < 1 || trimmed.length > 80) return null;
  return trimmed;
}

function parseOrNull(source: string): t.File | null {
  try {
    return babelParse(source, {
      sourceType: 'module',
      plugins: ['typescript', 'jsx'],
      errorRecovery: true,
    }) as t.File;
  } catch {
    return null;
  }
}

type MetaObjectInfo = {
  objectNode: t.ObjectExpression;
  objectStart: number;
  objectEnd: number;
};

type MetaFindResult =
  | { kind: 'found'; info: MetaObjectInfo }
  | { kind: 'missing' }
  | { kind: 'unsupported' };

function findMetaObject(source: string): MetaFindResult {
  const ast = parseOrNull(source);
  if (!ast) return { kind: 'missing' };
  const body = ast.program.body;
  for (const stmt of body) {
    if (!t.isExportNamedDeclaration(stmt)) continue;
    const decl = stmt.declaration;
    if (!decl || !t.isVariableDeclaration(decl)) continue;
    for (const d of decl.declarations) {
      if (!t.isIdentifier(d.id) || d.id.name !== 'meta') continue;
      const init = unwrapExpression(d.init as t.Expression | undefined);
      if (!init || !t.isObjectExpression(init)) return { kind: 'unsupported' };
      return {
        kind: 'found',
        info: {
          objectNode: init,
          objectStart: init.start as number,
          objectEnd: init.end as number,
        },
      };
    }
  }
  return { kind: 'missing' };
}

type MetaPropertyInfo = {
  property: t.ObjectProperty;
  keyStart: number;
  keyEnd: number;
  valueStart: number;
  valueEnd: number;
  rawValueStart: number;
  rawValueEnd: number;
};

function findMetaProperty(
  metaInfo: MetaObjectInfo,
  propertyName: string,
): MetaPropertyInfo | null {
  const { objectNode } = metaInfo;
  for (const prop of objectNode.properties) {
    if (!t.isObjectProperty(prop) || prop.computed) continue;
    const key = prop.key;
    let keyName: string | undefined;
    if (t.isIdentifier(key)) {
      keyName = key.name;
    } else if (t.isStringLiteral(key)) {
      keyName = key.value;
    }
    if (keyName !== propertyName) continue;
    const rawValue = unwrapExpression(prop.value as t.Expression);
    return {
      property: prop,
      keyStart: key.start as number,
      keyEnd: key.end as number,
      valueStart: prop.value.start as number,
      valueEnd: prop.value.end as number,
      rawValueStart: rawValue ? (rawValue.start as number) : (prop.value.start as number),
      rawValueEnd: rawValue ? (rawValue.end as number) : (prop.value.end as number),
    };
  }
  return null;
}

function readStringLiteralValue(valueNode: t.Expression): string | null {
  const unwrapped = unwrapExpression(valueNode);
  if (!unwrapped) return null;
  if (t.isStringLiteral(unwrapped)) return unwrapped.value;
  if (t.isTemplateLiteral(unwrapped) && unwrapped.expressions.length === 0) {
    const first = unwrapped.quasis[0];
    return first.value.cooked ?? first.value.raw ?? null;
  }
  return null;
}

function readStringArrayValue(valueNode: t.Expression): string[] | null {
  const unwrapped = unwrapExpression(valueNode);
  if (!unwrapped || !t.isArrayExpression(unwrapped)) return null;
  const result: string[] = [];
  for (const el of unwrapped.elements) {
    if (el === null) return null;
    if (t.isSpreadElement(el)) return null;
    const s = readStringLiteralValue(el as t.Expression);
    if (s === null) return null;
    result.push(s);
  }
  return result;
}

function unwrapExpression(node: t.Expression | undefined): t.Expression | undefined {
  let current = node;
  while (current && (t.isTSAsExpression(current) || t.isTSSatisfiesExpression(current))) {
    current = current.expression as t.Expression;
  }
  return current;
}

function readMetaTitleInSource(source: string): MetaTitleRead {
  const metaResult = findMetaObject(source);
  if (metaResult.kind === 'unsupported') return { kind: 'unsupported' };
  if (metaResult.kind === 'missing') return { kind: 'missing' };
  const propInfo = findMetaProperty(metaResult.info, 'title');
  if (!propInfo) return { kind: 'missing' };
  const value = readStringLiteralValue(propInfo.property.value as t.Expression);
  if (value === null) return { kind: 'unsupported' };
  return { kind: 'found', title: value };
}

type MetaTagsRead =
  | { kind: 'found'; tags: string[] }
  | { kind: 'missing' }
  | { kind: 'unsupported' };

function readMetaTagsInSource(source: string): MetaTagsRead {
  const metaResult = findMetaObject(source);
  if (metaResult.kind === 'unsupported') return { kind: 'unsupported' };
  if (metaResult.kind === 'missing') return { kind: 'missing' };
  const propInfo = findMetaProperty(metaResult.info, 'tags');
  if (!propInfo) return { kind: 'missing' };
  const value = readStringArrayValue(propInfo.property.value as t.Expression);
  if (value === null) return { kind: 'unsupported' };
  return { kind: 'found', tags: value };
}

export async function rmSlideDir(slidesRoot: string, slideId: string): Promise<boolean> {
  if (!SLIDE_ID_RE.test(slideId)) return false;
  const dir = path.resolve(slidesRoot, slideId);
  if (!dir.startsWith(slidesRoot + path.sep)) return false;
  try {
    await fs.rm(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

export async function duplicateSlideDir(
  slidesRoot: string,
  slideId: string,
  desiredId?: string,
): Promise<{ ok: true; slideId: string } | { ok: false; status: number; error: string }> {
  if (!SLIDE_ID_RE.test(slideId)) return { ok: false, status: 400, error: 'invalid slideId' };

  const root = path.resolve(slidesRoot);
  const srcDir = path.resolve(root, slideId);
  if (!srcDir.startsWith(root + path.sep)) {
    return { ok: false, status: 400, error: 'invalid slideId' };
  }

  try {
    await fs.access(path.join(srcDir, 'index.tsx'));
  } catch {
    return { ok: false, status: 404, error: 'slide not found' };
  }

  let newId: string;
  if (desiredId !== undefined) {
    if (!SLIDE_ID_RE.test(desiredId)) return { ok: false, status: 400, error: 'invalid newId' };
    newId = desiredId;
    const dstDir = path.resolve(root, newId);
    if (!dstDir.startsWith(root + path.sep)) {
      return { ok: false, status: 400, error: 'invalid newId' };
    }
    try {
      await fs.access(dstDir);
      return { ok: false, status: 409, error: 'slide already exists' };
    } catch {}
  } else {
    let suffix = 1;
    while (true) {
      newId = suffix === 1 ? `${slideId}-copy` : `${slideId}-copy-${suffix}`;
      try {
        await fs.access(path.resolve(root, newId));
        suffix++;
      } catch {
        break;
      }
    }
  }

  const dstDir = path.resolve(root, newId);
  if (!dstDir.startsWith(root + path.sep)) {
    return { ok: false, status: 400, error: 'invalid newId' };
  }

  const srcEntry = path.join(srcDir, 'index.tsx');
  let copiedEntrySource: string;
  try {
    const source = await fs.readFile(srcEntry, 'utf8');
    const metaTitle = readMetaTitleInSource(source);
    if (metaTitle.kind === 'unsupported') {
      return { ok: false, status: 422, error: 'could not update copied slide title' };
    }
    const title = metaTitle.kind === 'found' ? metaTitle.title : slideId;
    const updated = updateMetaTitleInSource(source, `${title} (copy)`);
    if (updated === null) {
      return { ok: false, status: 422, error: 'could not update copied slide title' };
    }
    copiedEntrySource = updated;
  } catch {
    return { ok: false, status: 404, error: 'slide not found' };
  }

  try {
    await fs.cp(srcDir, dstDir, { recursive: true, errorOnExist: true, force: false });
    await fs.writeFile(path.join(dstDir, 'index.tsx'), copiedEntrySource, 'utf8');
    return { ok: true, slideId: newId };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      return { ok: false, status: 409, error: 'slide already exists' };
    }
    return { ok: false, status: 500, error: String((err as Error).message ?? err) };
  }
}

export function resolveSlideEntry(slidesRoot: string, slideId: string): string | null {
  if (!SLIDE_ID_RE.test(slideId)) return null;
  const dir = path.resolve(slidesRoot, slideId);
  if (!dir.startsWith(slidesRoot + path.sep)) return null;
  // The SlideMeta contract says every slide has slides/<id>/index.tsx; we only
  // edit that file to keep the write surface tiny and predictable.
  return path.join(dir, 'index.tsx');
}

function escapeSingleQuoted(s: string): string {
  let result = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    switch (c) {
      case 0x5c:
        result += '\\\\';
        break;
      case 0x27:
        result += "\\'";
        break;
      case 0x0a:
        result += '\\n';
        break;
      case 0x0d:
        result += '\\r';
        break;
      case 0x09:
        result += '\\t';
        break;
      case 0x0b:
        result += '\\v';
        break;
      case 0x0c:
        result += '\\f';
        break;
      default:
        result += s[i];
    }
  }
  return result;
}

function isSingleLineObject(metaInfo: MetaObjectInfo, source: string): boolean {
  const { objectStart, objectEnd } = metaInfo;
  const objectSlice = source.slice(objectStart, objectEnd);
  return !objectSlice.includes('\n');
}

function getMetaFirstPropertyIndent(metaInfo: MetaObjectInfo, source: string): string {
  const { objectNode, objectStart } = metaInfo;
  if (objectNode.properties.length === 0) return '  ';
  const firstProp = objectNode.properties[0];
  const propStart = firstProp.start as number;
  const beforeProp = source.slice(objectStart + 1, propStart);
  const indentMatch = beforeProp.match(/\n([ \t]*)$/);
  return indentMatch ? indentMatch[1] : '  ';
}

function insertMetaProperty(
  source: string,
  metaInfo: MetaObjectInfo,
  propertyText: string,
): string {
  const { objectStart, objectNode } = metaInfo;
  const singleLine = isSingleLineObject(metaInfo, source);
  const hasProperties = objectNode.properties.length > 0;

  if (singleLine) {
    const insertion = hasProperties ? ` ${propertyText},` : ` ${propertyText} `;
    return source.slice(0, objectStart + 1) + insertion + source.slice(objectStart + 1);
  }

  const indent = getMetaFirstPropertyIndent(metaInfo, source);
  const insertion = `\n${indent}${propertyText}${hasProperties ? ',' : ''}`;
  return source.slice(0, objectStart + 1) + insertion + source.slice(objectStart + 1);
}

/**
 * Rewrite (or insert) the `title` field in the slide module's `export const meta`.
 *
 * Strategy (AST-based, safe against strings/comments containing braces):
 *   1. Parse the source and find `export const meta` via AST.
 *   2. If the object already has a `title` property, replace just its value.
 *   3. If the object exists but has no title, inject a new `title: '...'` entry
 *      as the first property (preserving the author's surrounding indentation).
 *   4. If there is no `meta` export at all, insert a fresh one right before
 *      `export default`.
 *
 * Returns the rewritten source, or `null` if the file shape was too surprising
 * to touch safely (e.g. `export default` missing when we'd need to inject meta).
 */
export function updateMetaTitleInSource(source: string, title: string): string | null {
  const newValueText = `'${escapeSingleQuoted(title)}'`;

  const metaResult = findMetaObject(source);
  if (metaResult.kind === 'unsupported') return null;
  if (metaResult.kind === 'found') {
    const metaInfo = metaResult.info;
    const propInfo = findMetaProperty(metaInfo, 'title');
    if (propInfo) {
      return (
        source.slice(0, propInfo.rawValueStart) +
        newValueText +
        source.slice(propInfo.rawValueEnd)
      );
    }

    const propertyText = `title: ${newValueText}`;
    return insertMetaProperty(source, metaInfo, propertyText);
  }

  const exportDefaultIdx = source.search(/export\s+default\b/);
  if (exportDefaultIdx === -1) return null;
  const insertion = `export const meta: SlideMeta = { title: ${newValueText} };\n\n`;
  return source.slice(0, exportDefaultIdx) + insertion + source.slice(exportDefaultIdx);
}

function serializeStringArray(items: string[]): string {
  if (items.length === 0) return '[]';
  const deduped = Array.from(new Set(items));
  const parts = deduped.map((s) => `'${escapeSingleQuoted(s)}'`);
  return `[${parts.join(', ')}]`;
}

/**
 * Replace the entire `tags` array in the slide module's `export const meta`.
 *
 * Uses AST-based positioning so strings/comments containing braces do not
 * break the extraction. Returns the rewritten source, or `null` if the file
 * shape was too surprising to touch safely.
 */
export function replaceMetaTagsInSource(source: string, tags: string[]): string | null {
  const dedupedTags = Array.from(new Set(tags));
  const newValueText = serializeStringArray(dedupedTags);

  const metaResult = findMetaObject(source);
  if (metaResult.kind === 'unsupported') return null;
  if (metaResult.kind === 'found') {
    const metaInfo = metaResult.info;
    const propInfo = findMetaProperty(metaInfo, 'tags');
    if (propInfo) {
      return (
        source.slice(0, propInfo.rawValueStart) +
        newValueText +
        source.slice(propInfo.rawValueEnd)
      );
    }

    const propertyText = `tags: ${newValueText}`;
    return insertMetaProperty(source, metaInfo, propertyText);
  }

  const exportDefaultIdx = source.search(/export\s+default\b/);
  if (exportDefaultIdx === -1) return null;
  const insertion = `export const meta: SlideMeta = { tags: ${newValueText} };\n\n`;
  return source.slice(0, exportDefaultIdx) + insertion + source.slice(exportDefaultIdx);
}

/**
 * Add one or more tags to the `tags` array in `export const meta`.
 *
 * Duplicates are silently skipped (the resulting array contains each tag at
 * most once). If the `tags` property does not exist, it is created. If the
 * `meta` export does not exist, it is created before `export default`.
 *
 * Uses AST-based positioning. Returns the rewritten source, or `null` if the
 * file shape was too surprising.
 */
export function addTagsToMetaInSource(source: string, tagsToAdd: string[]): string | null {
  const current = readMetaTagsInSource(source);
  if (current.kind === 'unsupported') return null;

  const existing = current.kind === 'found' ? current.tags : [];
  const set = new Set(existing);
  for (const tag of tagsToAdd) {
    set.add(tag);
  }
  const merged = Array.from(set);
  return replaceMetaTagsInSource(source, merged);
}

/**
 * Remove one or more tags from the `tags` array in `export const meta`.
 *
 * Tags that are not present are silently skipped. If removing all tags, the
 * `tags` property is left in place with an empty array (so author intent is
 * preserved).
 *
 * Uses AST-based positioning. Returns the rewritten source, or `null` if the
 * file shape was too surprising.
 */
export function removeTagsFromMetaInSource(
  source: string,
  tagsToRemove: string[],
): string | null {
  const current = readMetaTagsInSource(source);
  if (current.kind === 'unsupported') return null;
  if (current.kind === 'missing') return source;

  const toRemove = new Set(tagsToRemove);
  const remaining = current.tags.filter((t) => !toRemove.has(t));
  return replaceMetaTagsInSource(source, remaining);
}

type ArrayElementRange = { start: number; end: number };

function findDefaultExportArray(
  source: string,
): { elements: ArrayElementRange[]; arrayStart: number; arrayEnd: number } | null {
  let ast: unknown;
  try {
    ast = babelParse(source, {
      sourceType: 'module',
      plugins: ['typescript', 'jsx'],
      errorRecovery: true,
    });
  } catch {
    return null;
  }
  const body = (ast as { program?: { body?: Array<Record<string, unknown>> } }).program?.body ?? [];
  for (const node of body) {
    if (node.type !== 'ExportDefaultDeclaration') continue;
    let inner = node.declaration as Record<string, unknown> | undefined;
    while (inner && (inner.type === 'TSAsExpression' || inner.type === 'TSSatisfiesExpression')) {
      inner = inner.expression as Record<string, unknown> | undefined;
    }
    if (!inner || inner.type !== 'ArrayExpression') return null;
    const arrayStart = inner.start as number;
    const arrayEnd = inner.end as number;
    const rawElements = (inner.elements as Array<Record<string, unknown> | null>) ?? [];
    const elements: ArrayElementRange[] = [];
    for (const el of rawElements) {
      if (!el || typeof el.start !== 'number' || typeof el.end !== 'number') return null;
      elements.push({ start: el.start as number, end: el.end as number });
    }
    return { elements, arrayStart, arrayEnd };
  }
  return null;
}

/**
 * Rewrite `export default [...]` so its elements appear in the requested order.
 *
 * `order[i]` is the original index that should land at new position `i`. The
 * function preserves each element's exact source slice (including any inline
 * comments that hug an identifier) and keeps the inter-element separator slots
 * in their original positions, so a 3-page array `[A, B, C]` reordered to
 * `[2, 0, 1]` becomes `[C, A, B]` with the same indentation and trailing
 * commas the author wrote.
 *
 * Returns `null` when the file's default export isn't an array literal, or the
 * order is not a valid permutation of `[0, n-1]`.
 */
export function reorderDefaultExportPagesInSource(source: string, order: number[]): string | null {
  const found = findDefaultExportArray(source);
  if (!found) return null;
  const { elements, arrayStart, arrayEnd } = found;
  const n = elements.length;
  if (order.length !== n) return null;
  const seen = new Set<number>();
  for (const idx of order) {
    if (!Number.isInteger(idx) || idx < 0 || idx >= n) return null;
    if (seen.has(idx)) return null;
    seen.add(idx);
  }
  if (n === 0) return source;

  let identity = true;
  for (let i = 0; i < n; i++) {
    if (order[i] !== i) {
      identity = false;
      break;
    }
  }
  if (identity) return source;

  const prefix = source.slice(arrayStart, elements[0].start);
  const suffix = source.slice(elements[n - 1].end, arrayEnd);
  const separators: string[] = [];
  for (let i = 0; i < n - 1; i++) {
    separators.push(source.slice(elements[i].end, elements[i + 1].start));
  }
  const elementText = elements.map((el) => source.slice(el.start, el.end));

  let rebuilt = prefix + elementText[order[0]];
  for (let i = 1; i < n; i++) {
    rebuilt += separators[i - 1] + elementText[order[i]];
  }
  rebuilt += suffix;

  return source.slice(0, arrayStart) + rebuilt + source.slice(arrayEnd);
}

type NotesArrayInfo = {
  arrayStart: number;
  arrayEnd: number;
  elementTexts: string[];
};

function findNotesArray(source: string): NotesArrayInfo | null | 'invalid' {
  let ast: unknown;
  try {
    ast = babelParse(source, {
      sourceType: 'module',
      plugins: ['typescript', 'jsx'],
      errorRecovery: true,
    });
  } catch {
    return 'invalid';
  }
  const body = (ast as { program?: { body?: Array<Record<string, unknown>> } }).program?.body ?? [];
  for (const stmt of body) {
    if (stmt.type !== 'ExportNamedDeclaration') continue;
    const decl = stmt.declaration as Record<string, unknown> | undefined;
    if (!decl || decl.type !== 'VariableDeclaration') continue;
    const declarations = (decl.declarations as Array<Record<string, unknown>> | undefined) ?? [];
    for (const d of declarations) {
      const id = d.id as Record<string, unknown> | undefined;
      if (!id || id.type !== 'Identifier' || id.name !== 'notes') continue;
      const init = d.init as Record<string, unknown> | undefined;
      if (!init || init.type !== 'ArrayExpression') return 'invalid';
      const arrayStart = init.start as number | undefined;
      const arrayEnd = init.end as number | undefined;
      if (typeof arrayStart !== 'number' || typeof arrayEnd !== 'number') return 'invalid';
      const rawElements = (init.elements as Array<Record<string, unknown> | null>) ?? [];
      const elementTexts: string[] = [];
      for (const el of rawElements) {
        if (el === null) {
          elementTexts.push('undefined');
          continue;
        }
        if (el.type === 'SpreadElement') return 'invalid';
        const start = el.start as number | undefined;
        const end = el.end as number | undefined;
        if (typeof start !== 'number' || typeof end !== 'number') return 'invalid';
        elementTexts.push(source.slice(start, end));
      }
      return { arrayStart, arrayEnd, elementTexts };
    }
  }
  return null;
}

/**
 * Reorder `export const notes = [...]` to follow the page-array reorder.
 *
 * `order[i]` is the original page index that should land at new position `i`.
 * The notes array is index-aligned with the pages array but may be shorter
 * (trailing `undefined` slots are routinely trimmed). Missing elements are
 * treated as `undefined`, and trailing `undefined` is trimmed again after
 * reordering to keep the file tidy.
 *
 * Returns the rewritten source, the original source if no `notes` export
 * exists or the reorder is a no-op, or `null` if the `notes` export's shape
 * is too surprising to touch safely.
 */
export function reorderNotesArrayInSource(source: string, order: number[]): string | null {
  for (const idx of order) {
    if (!Number.isInteger(idx) || idx < 0) return null;
  }
  const found = findNotesArray(source);
  if (found === 'invalid') return null;
  if (found === null) return source;

  const { arrayStart, arrayEnd, elementTexts } = found;
  const pick = (i: number): string =>
    i >= 0 && i < elementTexts.length ? elementTexts[i] : 'undefined';
  const reordered = order.map(pick);
  while (reordered.length > 0 && reordered[reordered.length - 1] === 'undefined') {
    reordered.pop();
  }

  const replacement =
    reordered.length === 0 ? '[]' : `[\n${reordered.map((s) => `  ${s},`).join('\n')}\n]`;
  if (replacement === source.slice(arrayStart, arrayEnd)) return source;

  return source.slice(0, arrayStart) + replacement + source.slice(arrayEnd);
}

/**
 * Remove the element at `index` from `export default [...]`.
 *
 * Preserves the source slice of every other element, dropping the separator
 * immediately following the removed element (or the preceding one when the
 * removed element is the last). Returns `null` when the default export isn't
 * an array literal or `index` is out of range.
 */
export function removePageFromDefaultExportInSource(source: string, index: number): string | null {
  const found = findDefaultExportArray(source);
  if (!found) return null;
  const { elements, arrayStart, arrayEnd } = found;
  const n = elements.length;
  if (!Number.isInteger(index) || index < 0 || index >= n) return null;

  if (n === 1) {
    return `${source.slice(0, arrayStart)}[]${source.slice(arrayEnd)}`;
  }

  const prefix = source.slice(arrayStart, elements[0].start);
  const suffix = source.slice(elements[n - 1].end, arrayEnd);
  const separators: string[] = [];
  for (let i = 0; i < n - 1; i++) {
    separators.push(source.slice(elements[i].end, elements[i + 1].start));
  }
  const elementText = elements.map((el) => source.slice(el.start, el.end));

  const keptElements: string[] = [];
  const keptSeparators: string[] = [];
  for (let i = 0; i < n; i++) {
    if (i === index) continue;
    keptElements.push(elementText[i]);
  }
  for (let i = 0; i < n - 1; i++) {
    // Drop the separator that follows the removed element. When the removed
    // element is the last one, the separator preceding it (i = index-1) is
    // the trailing separator and gets dropped instead.
    if (index === n - 1 ? i === n - 2 : i === index) continue;
    keptSeparators.push(separators[i]);
  }

  let rebuilt = prefix + keptElements[0];
  for (let i = 1; i < keptElements.length; i++) {
    rebuilt += keptSeparators[i - 1] + keptElements[i];
  }
  rebuilt += suffix;

  return source.slice(0, arrayStart) + rebuilt + source.slice(arrayEnd);
}

function chooseInsertSeparator(prefix: string, existingSeparators: string[]): string {
  const sample = existingSeparators.find((s) => s.includes(','));
  if (sample) return sample;
  if (prefix.includes('\n')) {
    const m = prefix.match(/\n([ \t]*)$/);
    const indent = m ? m[1] : '  ';
    return `,\n${indent}`;
  }
  return ', ';
}

/**
 * Duplicate the element at `index` in `export default [...]`, inserting the
 * copy immediately after the original. Reuses an existing inter-element
 * separator when one is available so the cloned entry matches the surrounding
 * indentation. Returns `null` when the default export isn't an array literal
 * or `index` is out of range.
 */
export function duplicatePageInDefaultExportInSource(source: string, index: number): string | null {
  const found = findDefaultExportArray(source);
  if (!found) return null;
  const { elements, arrayStart, arrayEnd } = found;
  const n = elements.length;
  if (!Number.isInteger(index) || index < 0 || index >= n) return null;

  const prefix = source.slice(arrayStart, elements[0].start);
  const suffix = source.slice(elements[n - 1].end, arrayEnd);
  const separators: string[] = [];
  for (let i = 0; i < n - 1; i++) {
    separators.push(source.slice(elements[i].end, elements[i + 1].start));
  }
  const elementText = elements.map((el) => source.slice(el.start, el.end));

  const insertSep = chooseInsertSeparator(prefix, separators);

  const newElements: string[] = [];
  const newSeparators: string[] = [];
  for (let i = 0; i < n; i++) {
    newElements.push(elementText[i]);
    if (i === index) {
      newElements.push(elementText[i]);
      newSeparators.push(insertSep);
    }
    if (i < n - 1) newSeparators.push(separators[i]);
  }

  let rebuilt = prefix + newElements[0];
  for (let i = 1; i < newElements.length; i++) {
    rebuilt += newSeparators[i - 1] + newElements[i];
  }
  rebuilt += suffix;

  return source.slice(0, arrayStart) + rebuilt + source.slice(arrayEnd);
}
