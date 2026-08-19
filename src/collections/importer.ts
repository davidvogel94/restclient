import Ajv, { type ValidateFunction } from 'ajv';
import collectionSchema from '../../resources/schema/collection-v2.1.0.json';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const transformer = require('postman-collection-transformer');

export type PostmanJson = Record<string, any>;

export type DetectedKind =
  | { kind: 'collection'; version: '1.0.0' | '2.0.0' | '2.1.0' }
  | { kind: 'environment'; scope: 'environment' | 'globals' }
  | { kind: 'unknown'; reason: string };

/**
 * Work out what a dropped JSON file actually is.
 *
 * Postman exports are only loosely self-describing: environments carry
 * `_postman_variable_scope`, v2.x collections carry `info.schema`, and v1
 * collections carry neither — they are recognised by their `order`/`requests`
 * shape.
 */
export function detect(json: PostmanJson): DetectedKind {
  if (!json || typeof json !== 'object') { return { kind: 'unknown', reason: 'Not a JSON object.' }; }

  const scope = json._postman_variable_scope;
  if (scope === 'environment' || scope === 'globals') { return { kind: 'environment', scope }; }

  const schema = String(json.info?.schema ?? '');
  if (schema.includes('/v2.1.0/')) { return { kind: 'collection', version: '2.1.0' }; }
  if (schema.includes('/v2.0.0/')) { return { kind: 'collection', version: '2.0.0' }; }

  // v1: flat `requests` array plus an `order` list of request ids.
  if (Array.isArray(json.requests) && (Array.isArray(json.order) || Array.isArray(json.folders))) {
    return { kind: 'collection', version: '1.0.0' };
  }

  // An environment export with the scope marker stripped still has values but
  // never has items.
  if (Array.isArray(json.values) && !json.item) { return { kind: 'environment', scope: 'environment' }; }

  if (Array.isArray(json.item)) {
    // Has items but an unrecognised schema string — assume the current format
    // rather than refusing the import.
    return { kind: 'collection', version: '2.1.0' };
  }

  return { kind: 'unknown', reason: 'Not a recognisable Postman collection or environment.' };
}

/** Convert a v1 or v2.0 collection up to v2.1.0. v2.1.0 input is returned untouched. */
export function normalizeCollection(json: PostmanJson, from: '1.0.0' | '2.0.0' | '2.1.0'): Promise<PostmanJson> {
  if (from === '2.1.0') { return Promise.resolve(json); }
  return new Promise((resolve, reject) => {
    transformer.convert(
      json,
      { inputVersion: from, outputVersion: '2.1.0', retainIds: true },
      (err: Error | null, converted: PostmanJson) => (err ? reject(err) : resolve(converted))
    );
  });
}

let validator: ValidateFunction | undefined;

/**
 * Validate against the vendored v2.1.0 schema.
 *
 * Advisory only — real-world exports routinely carry extra keys, and refusing
 * them would defeat the entire point of importing without modification.
 */
export function validateCollection(json: PostmanJson): string[] {
  if (!validator) {
    const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: false });
    validator = ajv.compile(collectionSchema as object);
  }
  if (validator(json)) { return []; }
  return (validator.errors ?? [])
    .slice(0, 25)
    .map((e) => `${e.instancePath || '/'} ${e.message ?? 'is invalid'}`);
}

/**
 * Names of `secret`-typed variables whose value sits in the file as plaintext.
 *
 * Postman marks sensitive values with `"type": "secret"` but still exports them
 * in the clear. The file belongs to the user, so this only reports them — the
 * offer to move one into the OS keychain is made in the UI.
 */
export function plaintextSecretKeys(environment: PostmanJson): string[] {
  const values = Array.isArray(environment.values) ? environment.values : [];
  return values
    .filter((v: any) => v?.type === 'secret' && typeof v.value === 'string' && v.value !== '')
    .map((v: any) => String(v.key));
}

/** Filesystem-safe file name derived from a display name. */
export function slugify(name: string): string {
  const slug = String(name ?? '')
    .trim()
    .replace(/[^\w.\- ]+/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .toLowerCase();
  return slug || 'untitled';
}
