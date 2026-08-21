/**
 * Deciding what the workspace scan looks for, and what it skips.
 *
 * Deliberately free of any `vscode` import: this is the glob and settings
 * bookkeeping — merging four sources of exclusions, reading a `files.exclude`
 * map, keeping a brace expression legible — and it should be testable without
 * booting an editor. `scanner.ts` is the part that actually talks to VS Code.
 */

/** The conventional names Postman gives its exports. */
export const DEFAULT_DISCOVER_PATTERNS: readonly string[] = [
  '**/*.postman_collection.json',
  '**/*.postman_environment.json',
  '**/*.postman_globals.json'
];

/**
 * Skipped whatever the user's excludes say.
 *
 * A scan through `node_modules` is the one real performance trap here, and a
 * user who has emptied `search.exclude` for their own reasons has not asked
 * for it.
 */
export const ALWAYS_EXCLUDED: readonly string[] = ['**/node_modules/**', '**/.git/**'];

/** Usable glob patterns from a configured array, in order, without duplicates. */
export function normalizePatterns(configured: unknown): string[] {
  if (!Array.isArray(configured)) { return []; }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of configured) {
    if (typeof entry !== 'string') { continue; }
    const pattern = entry.trim();
    if (!pattern || seen.has(pattern)) { continue; }
    seen.add(pattern);
    out.push(pattern);
  }
  return out;
}

/**
 * Several patterns as one, since a watcher takes exactly one.
 *
 * A single pattern is returned bare: `{**\/*.json}` is legal but reads badly in
 * a log line, and this string ends up in one. Nothing to look for is
 * `undefined` rather than an empty brace expression, which would match nothing
 * in a way that looks like a bug.
 */
export function combinePatterns(patterns: string[]): string | undefined {
  if (!patterns.length) { return undefined; }
  if (patterns.length === 1) { return patterns[0]; }
  return `{${patterns.join(',')}}`;
}

/**
 * The switched-on keys of a `files.exclude`-shaped setting.
 *
 * VS Code lets a value be `true`, `false`, or a `{ "when": … }` sibling
 * condition. The condition form is still an exclusion — only an explicit
 * `false`, which is how a user turns off an inherited default, is not.
 */
export function enabledKeys(setting: unknown): string[] {
  if (!setting || typeof setting !== 'object' || Array.isArray(setting)) { return []; }
  return Object.entries(setting as Record<string, unknown>)
    .filter(([key, value]) => key.trim() && value !== false)
    .map(([key]) => key.trim());
}

/**
 * One exclude glob from every source that gets a say.
 *
 * Passing an explicit exclude to `findFiles` *replaces* its own `files.exclude`
 * handling, so everything that should apply has to be merged here by hand.
 */
export function combineExcludes(groups: Array<string[] | undefined>): string {
  const seen = new Set<string>();
  for (const group of groups) {
    for (const pattern of group ?? []) {
      const trimmed = pattern.trim();
      if (trimmed) { seen.add(trimmed); }
    }
  }
  for (const pattern of ALWAYS_EXCLUDED) { seen.add(pattern); }
  return `{${[...seen].join(',')}}`;
}

/**
 * Does this file name follow Postman's own export convention?
 *
 * The scan's patterns are the user's to widen, so a match says nothing about
 * what a file is. This narrower question is what decides whether an unparseable
 * match is worth reporting: a broken `orders.postman_collection.json` is
 * something to fix, a broken `tsconfig.json` caught by a wide glob is noise.
 */
export function looksLikePostmanFileName(fsPathOrName: string): boolean {
  const name = String(fsPathOrName ?? '').split(/[\\/]/).pop() ?? '';
  return /\.postman_(collection|environment|globals)\.json$/i.test(name);
}

/**
 * Which pane a conventionally-named file belongs in, from its name alone.
 *
 * Only asked of a file that will not parse: a loadable file is classified by
 * `detect`, which reads what it actually contains. A broken one cannot be
 * asked, and still has to appear somewhere.
 */
export function kindFromFileName(fsPathOrName: string): 'collection' | 'environment' | undefined {
  const name = String(fsPathOrName ?? '').split(/[\\/]/).pop() ?? '';
  const match = /\.postman_(collection|environment|globals)\.json$/i.exec(name);
  if (!match) { return undefined; }
  return match[1].toLowerCase() === 'collection' ? 'collection' : 'environment';
}

/**
 * The scan pattern for the folder collections are kept in.
 *
 * Choosing that folder says more than where an import should land: it says the
 * JSON in there is this extension's. So everything under it is scanned whatever
 * it is called — a collection saved out of Postman as `orders.json`, or one
 * renamed by hand, is still picked up, without the user having to widen
 * `discoverPatterns` to reach it. Nowhere else in the workspace widens, where
 * Postman's own naming remains the only signal.
 *
 * Non-Postman JSON in the folder costs nothing: the scan classifies a file by
 * reading it, and what is not an export is skipped without a word to the user.
 *
 * The path in is workspace-relative. `undefined` — no folder chosen, or one
 * that resolved outside the workspace — means there is nothing to add, since a
 * workspace-relative glob could not reach it anyway.
 */
export function importFolderPattern(relativePath: string | undefined | null): string | undefined {
  if (relativePath === undefined || relativePath === null) { return undefined; }
  const segments = String(relativePath).split(/[\\/]+/).filter((s) => s && s !== '.');
  if (segments.some((s) => s === '..')) { return undefined; }
  // No segments means the folder *is* the workspace root, which is a legitimate
  // answer to "where do collections live" in a repo that is one.
  return segments.length ? `${segments.join('/')}/**/*.json` : '**/*.json';
}
