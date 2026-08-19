import { createHash } from 'node:crypto';
import type { PostmanJson } from './importer';

export interface ItemNode {
  /** Stable id, derived from the item's path when the export has none. */
  id: string;
  name: string;
  /** Folder names from the collection root down to (and including) this item. */
  path: string[];
  /**
   * Index-based path into the raw collection JSON, e.g.
   * `['item', 0, 'item', 2]`. This is what jsonc-parser needs to make a
   * surgical, format-preserving edit to the file on disk.
   */
  jsonPath: Array<string | number>;
  isFolder: boolean;
  method?: string;
  children: ItemNode[];
}

export interface MaterializedCollection {
  /** The collection JSON with an `id` filled in on every item. */
  json: PostmanJson;
  tree: ItemNode[];
  index: Map<string, ItemNode>;
}

function stableId(collectionId: string, path: string[]): string {
  // Derived from the path rather than random, so ids survive a reload and
  // webview panels stay attached to the request they were opened for.
  return createHash('sha1').update(collectionId + ' ' + path.join(' ')).digest('hex').slice(0, 32);
}

/**
 * Fill in missing item ids and build a navigable tree.
 *
 * Postman only guarantees `id` on items it has round-tripped through its own
 * app; plenty of real exports omit it. postman-runtime needs an id to target a
 * single request via `entrypoint`, so we synthesise deterministic ones here and
 * hand the same JSON to the runner. The file on disk is never modified.
 */
export function materialize(json: PostmanJson): MaterializedCollection {
  const collectionId = String(json?.info?._postman_id ?? json?.info?.name ?? 'collection');
  const index = new Map<string, ItemNode>();

  const walk = (items: any[], parents: string[], jsonParents: Array<string | number>): ItemNode[] => {
    if (!Array.isArray(items)) { return []; }
    const seen = new Map<string, number>();

    return items.map((raw, position) => {
      const rawName = String(raw?.name ?? 'Untitled');
      // Sibling names are not unique in Postman, so disambiguate for the id path.
      const dupe = seen.get(rawName) ?? 0;
      seen.set(rawName, dupe + 1);
      const pathSegment = dupe === 0 ? rawName : rawName + '~' + dupe;
      const path = [...parents, pathSegment];
      const jsonPath = [...jsonParents, position];

      const isFolder = Array.isArray(raw?.item);
      const id = typeof raw?.id === 'string' && raw.id ? raw.id : stableId(collectionId, path);
      raw.id = id;

      const node: ItemNode = {
        id,
        name: rawName,
        path,
        jsonPath,
        isFolder,
        method: isFolder ? undefined : String(raw?.request?.method ?? 'GET').toUpperCase(),
        children: isFolder ? walk(raw.item, path, [...jsonPath, 'item']) : []
      };
      index.set(id, node);
      return node;
    });
  };

  // Deep clone so the id injection never leaks back into the on-disk text.
  const cloned: PostmanJson = JSON.parse(JSON.stringify(json ?? {}));
  const tree = walk(cloned.item ?? [], [], ['item']);
  return { json: cloned, tree, index };
}

/** Locate the raw item object for an id inside a materialized collection. */
export function findRawItem(json: PostmanJson, itemId: string): any | undefined {
  const search = (items: any[]): any | undefined => {
    for (const raw of items ?? []) {
      if (raw?.id === itemId) { return raw; }
      if (Array.isArray(raw?.item)) {
        const hit = search(raw.item);
        if (hit) { return hit; }
      }
    }
    return undefined;
  };
  return search(json?.item ?? []);
}
