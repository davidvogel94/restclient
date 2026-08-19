import { appendTo, removeAt, reorder, type JsonEdit, type JsonPath } from './jsonEdit';
import type { ItemNode } from './model';
import type { PostmanJson } from './importer';

/** A newly created request, in the shape Postman writes. */
export function newRequestItem(name: string): Record<string, unknown> {
  return {
    name,
    request: {
      method: 'GET',
      header: [],
      url: { raw: '', host: [] }
    },
    response: []
  };
}

export function newFolderItem(name: string): Record<string, unknown> {
  return { name, item: [] };
}

/** The array a node lives in, and its index within it. */
export function locate(node: ItemNode): { arrayPath: JsonPath; index: number } {
  const arrayPath = node.jsonPath.slice(0, -1);
  const index = node.jsonPath[node.jsonPath.length - 1] as number;
  return { arrayPath, index };
}

/** Where children of a container go: a folder's `item`, or the collection root. */
export function childArrayPath(node: ItemNode | undefined): JsonPath {
  return node ? [...node.jsonPath, 'item'] : ['item'];
}

/** Read the array at a JSON path out of a parsed collection. */
function readArray(json: PostmanJson, path: JsonPath): any[] {
  let cursor: any = json;
  for (const segment of path) { cursor = cursor?.[segment as any]; }
  return Array.isArray(cursor) ? cursor : [];
}

/**
 * Resolve an array for insertion, creating it when the container has none.
 * A folder exported with no children may legitimately lack its `item` key.
 */
function resolveArrayForInsert(json: PostmanJson, path: JsonPath): any[] | undefined {
  let cursor: any = json;
  for (let i = 0; i < path.length - 1; i++) { cursor = cursor?.[path[i] as any]; }
  if (!cursor || typeof cursor !== 'object') { return undefined; }

  const key = path[path.length - 1] as any;
  if (!Array.isArray(cursor[key])) { cursor[key] = []; }
  return cursor[key];
}

export function addItem(parent: ItemNode | undefined, item: unknown): JsonEdit[] {
  return [appendTo(childArrayPath(parent), item)];
}

export function renameItem(node: ItemNode, name: string): JsonEdit[] {
  return [{ path: [...node.jsonPath, 'name'], value: name }];
}

export function deleteItem(node: ItemNode): JsonEdit[] {
  return [removeAt(node.jsonPath)];
}

/**
 * Duplicate an item directly after the original.
 *
 * Ids are dropped from the copy so `materialize` regenerates them; two items
 * sharing an id would make `entrypoint` ambiguous for the runner.
 */
export function duplicateItem(json: PostmanJson, node: ItemNode): JsonEdit[] {
  const { arrayPath, index } = locate(node);
  const siblings = readArray(json, arrayPath);
  const original = siblings[index];
  if (!original) { return []; }

  const copy = stripIds(JSON.parse(JSON.stringify(original)));
  copy.name = `${original.name ?? 'Untitled'} copy`;

  const next = [...siblings];
  next.splice(index + 1, 0, copy);
  return [{ path: arrayPath, value: next }];
}

function stripIds(value: any): any {
  if (Array.isArray(value)) { return value.map(stripIds); }
  if (value && typeof value === 'object') {
    const { id, _postman_id, ...rest } = value;
    for (const key of Object.keys(rest)) { rest[key] = stripIds(rest[key]); }
    return rest;
  }
  return value;
}

/**
 * Move an item to a new position, possibly under a different parent.
 *
 * A same-parent move rewrites only that array. A cross-parent move has to
 * remove from one array and insert into another; doing that as two edits would
 * invalidate the second path's indices when the arrays are nested, so the whole
 * `item` tree is rewritten in one edit instead. Formatting outside `item` is
 * still untouched, and minimalReplacement keeps the applied diff tight.
 */
export function moveItem(
  json: PostmanJson,
  source: ItemNode,
  targetArrayPath: JsonPath,
  targetIndex: number
): JsonEdit[] {
  const { arrayPath: sourceArrayPath, index: sourceIndex } = locate(source);
  const samePath = JSON.stringify(sourceArrayPath) === JSON.stringify(targetArrayPath);

  if (samePath) {
    const siblings = readArray(json, sourceArrayPath);
    if (sourceIndex === targetIndex || sourceIndex + 1 === targetIndex) { return []; }
    return [{ path: sourceArrayPath, value: reorder(siblings, sourceIndex, targetIndex) }];
  }

  // Refuse to drop a folder inside itself, which would detach the subtree.
  const targetPrefix = JSON.stringify(source.jsonPath);
  if (JSON.stringify(targetArrayPath).startsWith(targetPrefix.slice(0, -1))) {
    const inside = targetArrayPath.length > source.jsonPath.length &&
      source.jsonPath.every((segment, i) => targetArrayPath[i] === segment);
    if (inside) { return []; }
  }

  const clone: PostmanJson = JSON.parse(JSON.stringify(json));

  // Both arrays must be resolved BEFORE either is mutated: removing the source
  // shifts sibling indices, so a path resolved afterwards can land on the wrong
  // node entirely. Object references stay valid across the splice; paths do not.
  const sourceArray = readArray(clone, sourceArrayPath);
  const targetArray = resolveArrayForInsert(clone, targetArrayPath);
  if (!targetArray) { return []; }

  const [moved] = sourceArray.splice(sourceIndex, 1);
  if (!moved) { return []; }

  targetArray.splice(Math.min(targetIndex, targetArray.length), 0, moved);

  return [{ path: ['item'], value: clone.item ?? [] }];
}
