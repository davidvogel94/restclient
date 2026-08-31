/**
 * Deciding what a response body can be shown as, rather than only read as.
 *
 * A body the browser engine can render — a picture, a sound, a page — is worth
 * far more on screen than the same bytes spelled out as mojibake in a `<pre>`.
 * This module answers only "what kind of thing is this", from the header the
 * server sent and, when that header says nothing useful, from the bytes
 * themselves. It renders nothing and imports nothing, so both the webview and
 * the tests can use it.
 */

/** How the response body can be presented, beyond its text. */
export type PreviewKind = 'image' | 'audio' | 'video' | 'html' | 'none';

/** `text/html; charset=utf-8` -> `text/html`. */
export function mediaType(contentType: string): string {
  return contentType.split(';')[0].trim().toLowerCase();
}

/**
 * Types that carry no information about the body — a server that has not so
 * much as guessed. Sniffing is confined to these: a server that named a type
 * is taken at its word, because second-guessing it would hide the mislabelling
 * rather than show it.
 */
const UNINFORMATIVE = new Set(['', 'application/octet-stream', 'binary/octet-stream']);

/** Leading bytes that identify a format, longest-first so `RIFF` never wins over WebP. */
const SIGNATURES: Array<{ type: string; offset: number; magic: number[]; also?: [number, number[]] }> = [
  { type: 'image/png', offset: 0, magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { type: 'image/gif', offset: 0, magic: [0x47, 0x49, 0x46, 0x38] },
  { type: 'image/jpeg', offset: 0, magic: [0xff, 0xd8, 0xff] },
  { type: 'image/bmp', offset: 0, magic: [0x42, 0x4d] },
  // RIFF containers name their payload four bytes further in.
  { type: 'image/webp', offset: 0, magic: [0x52, 0x49, 0x46, 0x46], also: [8, [0x57, 0x45, 0x42, 0x50]] },
  { type: 'audio/wav', offset: 0, magic: [0x52, 0x49, 0x46, 0x46], also: [8, [0x57, 0x41, 0x56, 0x45]] },
  { type: 'audio/ogg', offset: 0, magic: [0x4f, 0x67, 0x67, 0x53] },
  { type: 'audio/flac', offset: 0, magic: [0x66, 0x4c, 0x61, 0x43] },
  { type: 'audio/mpeg', offset: 0, magic: [0x49, 0x44, 0x33] },
  { type: 'video/webm', offset: 0, magic: [0x1a, 0x45, 0xdf, 0xa3] },
  // ISO base media: `....ftyp`, the brand deciding whether it is video or audio.
  { type: 'video/mp4', offset: 4, magic: [0x66, 0x74, 0x79, 0x70] }
];

function matches(bytes: Uint8Array, offset: number, magic: number[]): boolean {
  if (bytes.length < offset + magic.length) { return false; }
  return magic.every((b, i) => bytes[offset + i] === b);
}

/**
 * The type of a body whose server would not say, read from its first bytes.
 *
 * Returns `''` when nothing recognises it, which leaves the body as text —
 * the safer guess, since a text body that is shown as text still reads.
 */
export function sniffMediaType(bytes: Uint8Array): string {
  for (const sig of SIGNATURES) {
    if (!matches(bytes, sig.offset, sig.magic)) { continue; }
    if (sig.also && !matches(bytes, sig.also[0], sig.also[1])) { continue; }
    // An `ftyp` box whose brand is an audio one is an audio file in a video
    // container's clothing; `.m4a` is exactly that.
    if (sig.type === 'video/mp4' && String.fromCharCode(...bytes.slice(8, 11)) === 'M4A') {
      return 'audio/mp4';
    }
    return sig.type;
  }
  return '';
}

/**
 * What the server said the body is, or what it looks like when the server did
 * not say. This is the type the preview is built with, so it is what a `Blob`
 * should be labelled with too.
 */
export function effectiveMediaType(contentType: string, bytes?: Uint8Array): string {
  const declared = mediaType(contentType);
  if (!UNINFORMATIVE.has(declared) || !bytes?.length) { return declared; }
  return sniffMediaType(bytes) || declared;
}

/**
 * How a body of this type can be shown.
 *
 * By top-level type rather than by an allow-list of codecs: which of them this
 * particular Electron can actually decode is not knowable from here, and a
 * player that fails to load says so on screen. `image/svg+xml` counts as an
 * image because an `<img>` never runs the scripts an SVG may carry.
 */
export function previewKind(contentType: string, bytes?: Uint8Array): PreviewKind {
  const type = effectiveMediaType(contentType, bytes);
  if (type === 'text/html' || type === 'application/xhtml+xml') { return 'html'; }
  if (type.startsWith('image/')) { return 'image'; }
  if (type.startsWith('audio/')) { return 'audio'; }
  if (type.startsWith('video/')) { return 'video'; }
  return 'none';
}

/**
 * Whether a body of this kind has no useful reading as text.
 *
 * These open in the preview without being asked to: a PNG shown as characters
 * is not a lesser view of the response, it is no view of it at all. HTML is
 * excluded — its source is what a REST client is usually there to look at.
 */
export function isOpaqueMedia(kind: PreviewKind): boolean {
  return kind === 'image' || kind === 'audio' || kind === 'video';
}
