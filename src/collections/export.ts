import type { RegistryKind } from './registry';
import { FILE_SUFFIX, slugify, type PostmanJson } from './importer';

/**
 * Turning what this workspace works on back into files someone else can open.
 *
 * Export is deliberately close to a copy: a collection on disk already *is* a
 * Postman export, so the only real work here is naming files for a bulk export
 * and putting keychain-held secrets back into an environment on request. Kept
 * free of runtime `vscode` imports so it can be unit tested without the editor.
 */

/** The file name Postman would give an export of `name`. */
export function exportFileName(name: string, kind: RegistryKind): string {
  return `${slugify(name)}${FILE_SUFFIX[kind]}`;
}

/**
 * File names for a whole set of exports, disambiguated.
 *
 * Two collections may share a display name — or differ only in punctuation
 * `slugify` strips — and a bulk export must not have the second silently
 * overwrite the first. The suffix goes before the `.postman_*.json` part, so
 * these still look like Postman exports rather than `…collection-2.json`.
 */
export function exportFileNames(names: string[], kind: RegistryKind): string[] {
  const used = new Set<string>();
  return names.map((name) => {
    const base = slugify(name);
    let slug = base;
    for (let n = 2; used.has(slug); n++) { slug = `${base}-${n}`; }
    used.add(slug);
    return `${slug}${FILE_SUFFIX[kind]}`;
  });
}

/**
 * An environment as Postman itself would have exported it.
 *
 * The file this workspace edits keeps `secret` values empty — they live in the
 * OS keychain — which makes it safe to commit but useless to hand over. Only
 * called when the user has explicitly asked for the values to be included;
 * anything the keychain does not hold is left as the file has it, so a secret
 * that was never set exports blank rather than as `undefined`.
 */
export function environmentExportJson(
  json: PostmanJson,
  resolved: Record<string, string>,
  exportedAt: string
): PostmanJson {
  const values = Array.isArray(json.values) ? json.values : [];
  return {
    ...json,
    values: values.map((v: any) => {
      const key = String(v?.key ?? '');
      return v?.type === 'secret' && key in resolved ? { ...v, value: resolved[key] } : v;
    }),
    _postman_exported_at: exportedAt
  };
}
