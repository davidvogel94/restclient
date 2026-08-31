import { slugify } from '../collections/importer';
import type { SerializedResponse } from '../runner/protocol';

/**
 * Putting one response on disk, on request.
 *
 * Responses are otherwise memory-only (see ResponseCache), so this is the one
 * path that writes one out — which makes the naming worth getting right: a
 * saved body should open in the editor, image viewer or archiver the body
 * actually is, rather than as an untyped blob. Kept free of `vscode` imports so
 * it can be unit tested.
 */

/** What a save writes: the body alone, or the whole message. */
export type SaveResponseKind = 'body' | 'full';

/** `application/problem+json; charset=utf-8` -> `application/problem+json`. */
function mediaType(contentType: string): string {
  return contentType.split(';')[0].trim().toLowerCase();
}

const BY_TYPE: Record<string, string> = {
  'application/json': '.json',
  'text/json': '.json',
  'application/xml': '.xml',
  'text/xml': '.xml',
  'text/html': '.html',
  'application/xhtml+xml': '.html',
  'image/svg+xml': '.svg',
  'text/css': '.css',
  'text/csv': '.csv',
  'text/plain': '.txt',
  'text/markdown': '.md',
  'application/javascript': '.js',
  'text/javascript': '.js',
  'application/pdf': '.pdf',
  'application/zip': '.zip',
  'application/gzip': '.gz',
  'application/x-www-form-urlencoded': '.txt',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'audio/mpeg': '.mp3',
  'video/mp4': '.mp4'
};

/** The file extension a body of `contentType` should be saved with. */
export function responseFileExtension(contentType: string): string {
  const type = mediaType(contentType);
  // Exact types first: `image/svg+xml` is an SVG before it is XML.
  const known = BY_TYPE[type];
  if (known) { return known; }
  // A structured suffix names the syntax the body is written in, whatever the
  // vendor type in front of it says — `application/vnd.api+json` is JSON.
  if (type.endsWith('+json')) { return '.json'; }
  if (type.endsWith('+xml')) { return '.xml'; }
  if (type.startsWith('text/')) { return '.txt'; }
  // A server that said nothing is usually serving text; one that named a type
  // nothing here knows may well not be, so that gets `.bin`.
  return type ? '.bin' : '.txt';
}

/** What to call the file, before the user renames it in the dialog. */
export function responseFileName(
  requestName: string,
  contentType: string,
  kind: SaveResponseKind
): string {
  // A whole message is a `.http` file whatever its body is: the extension has
  // to describe the outer format, which is the status line and headers.
  const suffix = kind === 'full' ? '.http' : responseFileExtension(contentType);
  return `${slugify(requestName)}${suffix}`;
}

/**
 * The status line and headers, ready for the body to be appended.
 *
 * CRLF and a blank line, as an HTTP message is framed, so the file reads back
 * as one. No `HTTP/1.1`: the runner does not report which version answered, and
 * a version stated here would be a guess presented as fact.
 */
export function responseHead(response: SerializedResponse): string {
  const status = `HTTP ${response.code} ${response.status}`.trimEnd();
  const headers = response.headers.map((h) => `${h.key}: ${h.value}`);
  return `${[status, ...headers].join('\r\n')}\r\n\r\n`;
}
