import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parse as babelParse } from '@babel/parser';
import * as t from '@babel/types';
import fg from 'fast-glob';
import { loadConfigFromFile, normalizePath, type Plugin, type ViteDevServer } from 'vite';
import type { OpenSlideConfig } from '../config.ts';

export type { OpenSlideConfig };

export type OpenSlidePluginOptions = {
  userCwd: string;
  config: OpenSlideConfig;
  coreVersion: string;
};

const CONFIG_FILE = 'open-slide.config.ts';

const SLIDES_VMOD = 'virtual:open-slide/slides';
const CONFIG_VMOD = 'virtual:open-slide/config';
const FOLDERS_VMOD = 'virtual:open-slide/folders';

type FoldersManifest = {
  folders: unknown[];
  assignments: Record<string, string>;
};

async function readFoldersManifest(file: string): Promise<FoldersManifest> {
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw) as Partial<FoldersManifest>;
    return {
      folders: Array.isArray(parsed.folders) ? parsed.folders : [],
      assignments:
        parsed.assignments && typeof parsed.assignments === 'object'
          ? (parsed.assignments as Record<string, string>)
          : {},
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { folders: [], assignments: {} };
    }
    throw err;
  }
}

function resolved(id: string): string {
  return `\0${id}`;
}

async function findSlides(userCwd: string, slidesDir: string): Promise<string[]> {
  const abs = path.resolve(userCwd, slidesDir);
  if (!existsSync(abs)) return [];
  const hits = await fg('*/index.{tsx,jsx,ts,js}', {
    cwd: abs,
    absolute: true,
    onlyFiles: true,
  });
  return hits.sort();
}

function toId(absFile: string, slidesRoot: string): string {
  const rel = path.relative(slidesRoot, absFile);
  return rel.split(path.sep)[0];
}

type ExtractedMeta = { theme: string | null; createdAt: string | null; tags: string[] | null };

function unwrapMetaExpression(node: t.Expression | undefined): t.Expression | undefined {
  let current = node;
  while (current && (t.isTSAsExpression(current) || t.isTSSatisfiesExpression(current))) {
    current = current.expression as t.Expression;
  }
  return current;
}

function readStringLiteralValue(valueNode: t.Expression): string | null {
  const unwrapped = unwrapMetaExpression(valueNode);
  if (!unwrapped) return null;
  if (t.isStringLiteral(unwrapped)) return unwrapped.value;
  if (t.isTemplateLiteral(unwrapped) && unwrapped.expressions.length === 0) {
    const first = unwrapped.quasis[0];
    return first.value.cooked ?? first.value.raw ?? null;
  }
  return null;
}

function readStringArrayValue(valueNode: t.Expression): string[] | null {
  const unwrapped = unwrapMetaExpression(valueNode);
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

function extractMeta(src: string): ExtractedMeta {
  const empty: ExtractedMeta = { theme: null, createdAt: null, tags: null };
  let ast: t.File | null = null;
  try {
    ast = babelParse(src, {
      sourceType: 'module',
      plugins: ['typescript', 'jsx'],
      errorRecovery: true,
    }) as t.File;
  } catch {
    return empty;
  }

  const body = ast.program.body;
  for (const stmt of body) {
    if (!t.isExportNamedDeclaration(stmt)) continue;
    const decl = stmt.declaration;
    if (!decl || !t.isVariableDeclaration(decl)) continue;
    for (const d of decl.declarations) {
      if (!t.isIdentifier(d.id) || d.id.name !== 'meta') continue;
      const init = unwrapMetaExpression(d.init as t.Expression | undefined);
      if (!init || !t.isObjectExpression(init)) return empty;

      let theme: string | null = null;
      let createdAt: string | null = null;
      let tags: string[] | null = null;

      for (const prop of init.properties) {
        if (!t.isObjectProperty(prop) || prop.computed) continue;
        const key = prop.key;
        let keyName: string | undefined;
        if (t.isIdentifier(key)) {
          keyName = key.name;
        } else if (t.isStringLiteral(key)) {
          keyName = key.value;
        }
        if (!keyName) continue;

        const value = prop.value as t.Expression;
        if (keyName === 'theme') {
          theme = readStringLiteralValue(value);
        } else if (keyName === 'createdAt') {
          createdAt = readStringLiteralValue(value);
        } else if (keyName === 'tags') {
          tags = readStringArrayValue(value);
        }
      }

      return { theme, createdAt, tags };
    }
  }

  return empty;
}

async function readSlideMeta(abs: string): Promise<ExtractedMeta> {
  try {
    const src = await fs.readFile(abs, 'utf8');
    return extractMeta(src);
  } catch {
    return { theme: null, createdAt: null, tags: null };
  }
}

function parseCreatedAtMs(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

async function generateSlidesModule(
  files: string[],
  slidesRoot: string,
  isDev: boolean,
): Promise<string> {
  const entries = await Promise.all(
    files.map(async (abs) => {
      const id = toId(abs, slidesRoot);
      const importPath = isDev ? `@fs/${normalizePath(abs).replace(/^\/+/, '')}` : abs;
      const meta = await readSlideMeta(abs);
      return {
        id,
        importPath,
        theme: meta.theme,
        createdAt: parseCreatedAtMs(meta.createdAt),
        tags: meta.tags,
      };
    }),
  );

  const ids = JSON.stringify(entries.map((e) => e.id).sort());
  const themesMap: Record<string, string> = {};
  const createdAtMap: Record<string, number> = {};
  const tagsMap: Record<string, string[]> = {};
  for (const e of entries) {
    if (e.theme) themesMap[e.id] = e.theme;
    if (e.createdAt !== null) createdAtMap[e.id] = e.createdAt;
    if (e.tags) tagsMap[e.id] = e.tags;
  }
  const themesJson = JSON.stringify(themesMap);
  const createdAtJson = JSON.stringify(createdAtMap);
  const tagsJson = JSON.stringify(tagsMap);
  const importTokens = JSON.stringify(Object.fromEntries(entries.map((e) => [e.id, 0])));
  const devRuntime = isDev
    ? `
const slideImportTokens = ${importTokens};
if (import.meta.hot) {
  import.meta.hot.on('open-slide:slide-changed', (data) => {
    const ids = Array.isArray(data?.slideIds) ? data.slideIds : data?.slideId ? [data.slideId] : [];
    const token = Date.now();
    for (const id of ids) {
      if (Object.prototype.hasOwnProperty.call(slideImportTokens, id)) slideImportTokens[id] = token;
    }
  });
}
`
    : '';
  const cases = entries
    .map((e) => {
      const importExpr = isDev
        ? `import(/* @vite-ignore */ import.meta.env.BASE_URL + ${JSON.stringify(`${e.importPath}?t=`)} + slideImportTokens[${JSON.stringify(e.id)}])`
        : `import(${JSON.stringify(e.importPath)})`;
      return `    case ${JSON.stringify(e.id)}: return ${importExpr};`;
    })
    .join('\n');

  return `// virtual:open-slide/slides — generated
export const slideIds = ${ids};
export const slideThemes = ${themesJson};
export const slideCreatedAt = ${createdAtJson};
export const slideTags = ${tagsJson};
${devRuntime}

export async function loadSlide(id) {
  switch (id) {
${cases}
    default: throw new Error('Slide not found: ' + id);
  }
}
`;
}

export function openSlidePlugin(opts: OpenSlidePluginOptions): Plugin {
  const { userCwd, config, coreVersion } = opts;
  const slidesDir = config.slidesDir ?? 'slides';
  const slidesRoot = path.resolve(userCwd, slidesDir);
  const foldersManifestPath = path.join(slidesRoot, '.folders.json');

  let isDev = false;
  const slideIdForEntry = (p: string): string | null => {
    const rel = path.relative(slidesRoot, p);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
    const parts = rel.split(path.sep);
    if (parts.length !== 2) return null;
    if (!/^index\.(tsx|jsx|ts|js)$/.test(parts[1])) return null;
    return parts[0];
  };
  let slideChangeTimer: ReturnType<typeof setTimeout> | null = null;
  const pendingSlideChanges = new Set<string>();
  const queueSlideChanged = (server: ViteDevServer, id: string) => {
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
    }, 100);
  };

  return {
    name: 'open-slide',
    config(_c, env) {
      isDev = env.command === 'serve';
      return {
        server: { fs: { allow: [userCwd] } },
      };
    },
    resolveId(id) {
      if (id === SLIDES_VMOD) return resolved(SLIDES_VMOD);
      if (id === CONFIG_VMOD) return resolved(CONFIG_VMOD);
      if (id === FOLDERS_VMOD) return resolved(FOLDERS_VMOD);
      return null;
    },
    async load(id) {
      if (id === resolved(SLIDES_VMOD)) {
        const files = await findSlides(userCwd, slidesDir);
        return await generateSlidesModule(files, slidesRoot, isDev);
      }
      if (id === resolved(CONFIG_VMOD)) {
        const userBuild = config.build ?? {};
        const buildResolved = isDev
          ? { showSlideBrowser: true, showSlideUi: true, allowHtmlDownload: true }
          : {
              showSlideBrowser: userBuild.showSlideBrowser ?? true,
              showSlideUi: userBuild.showSlideUi ?? true,
              allowHtmlDownload: userBuild.allowHtmlDownload ?? true,
            };
        const resolvedConfig = { ...config, build: buildResolved, version: coreVersion };
        return `export default ${JSON.stringify(resolvedConfig)};\n`;
      }
      if (id === resolved(FOLDERS_VMOD)) {
        const manifest = await readFoldersManifest(foldersManifestPath);
        return `export default ${JSON.stringify(manifest)};\n`;
      }
      return null;
    },
    handleHotUpdate(ctx) {
      const slideId = slideIdForEntry(ctx.file);
      if (!slideId) return;
      queueSlideChanged(ctx.server, slideId);
      return [];
    },
    configureServer(server) {
      const isSlideEntry = (p: string) => slideIdForEntry(p) !== null;

      let reloadTimer: ReturnType<typeof setTimeout> | null = null;
      const reload = () => {
        if (reloadTimer) clearTimeout(reloadTimer);
        reloadTimer = setTimeout(() => {
          reloadTimer = null;
          const mod = server.moduleGraph.getModuleById(resolved(SLIDES_VMOD));
          if (mod) server.moduleGraph.invalidateModule(mod);
          server.ws.send({ type: 'full-reload' });
        }, 150);
      };
      // Vite's `root` is the core app dir, so chokidar doesn't watch the
      // user's slides folder by default. Add it explicitly — and pass the
      // directory itself, since Vite sets `disableGlobbing: true` and would
      // otherwise treat a glob pattern as a literal path.
      if (existsSync(slidesRoot)) server.watcher.add(slidesRoot);
      server.watcher.on('add', (p) => {
        if (isSlideEntry(p)) reload();
      });
      server.watcher.on('unlink', (p) => {
        if (isSlideEntry(p)) reload();
      });

      let foldersTimer: ReturnType<typeof setTimeout> | null = null;
      const invalidateFolders = () => {
        if (foldersTimer) clearTimeout(foldersTimer);
        foldersTimer = setTimeout(() => {
          foldersTimer = null;
          const mod = server.moduleGraph.getModuleById(resolved(FOLDERS_VMOD));
          if (mod) server.moduleGraph.invalidateModule(mod);
        }, 100);
      };
      server.watcher.add(foldersManifestPath);
      server.watcher.on('change', (p) => {
        if (p === foldersManifestPath) invalidateFolders();
      });
      server.watcher.on('add', (p) => {
        if (p === foldersManifestPath) invalidateFolders();
      });
      server.watcher.on('unlink', (p) => {
        if (p === foldersManifestPath) invalidateFolders();
      });
    },
  };
}

export async function loadUserConfig(userCwd: string): Promise<OpenSlideConfig> {
  const file = path.join(userCwd, CONFIG_FILE);
  if (!existsSync(file)) return {};
  const loaded = await loadConfigFromFile(
    { command: 'serve', mode: 'development' },
    file,
    userCwd,
    'silent',
  );
  return (loaded?.config ?? {}) as OpenSlideConfig;
}
