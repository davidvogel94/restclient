import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  effectiveMediaType,
  isOpaqueMedia,
  mediaType,
  previewKind,
  sniffMediaType
} from '../../src/shared/media';

const bytes = (...values: number[]) => Uint8Array.from(values);
const ascii = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0));

test('the parameters after a media type are not part of it', () => {
  assert.equal(mediaType('text/html; charset=utf-8'), 'text/html');
  assert.equal(mediaType('  IMAGE/PNG  '), 'image/png');
});

test('a body shows as whatever its top-level type can be played or drawn', () => {
  assert.equal(previewKind('image/png'), 'image');
  assert.equal(previewKind('image/avif'), 'image');
  assert.equal(previewKind('audio/mpeg'), 'audio');
  assert.equal(previewKind('video/mp4'), 'video');
  assert.equal(previewKind('text/html; charset=utf-8'), 'html');
  assert.equal(previewKind('application/xhtml+xml'), 'html');
});

test('an SVG previews as an image, where its scripts cannot run', () => {
  assert.equal(previewKind('image/svg+xml'), 'image');
});

test('a body with no renderable form has no preview', () => {
  assert.equal(previewKind('application/json'), 'none');
  assert.equal(previewKind('text/plain'), 'none');
  assert.equal(previewKind(''), 'none');
});

test('signatures name the formats a preview can offer', () => {
  assert.equal(sniffMediaType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0)), 'image/png');
  assert.equal(sniffMediaType(bytes(0xff, 0xd8, 0xff, 0xe0)), 'image/jpeg');
  assert.equal(sniffMediaType(ascii('GIF89a...')), 'image/gif');
  assert.equal(sniffMediaType(ascii('OggS....')), 'audio/ogg');
  assert.equal(sniffMediaType(bytes(0x1a, 0x45, 0xdf, 0xa3, 0, 0)), 'video/webm');
});

test('a RIFF container is read by its payload, not its wrapper', () => {
  assert.equal(sniffMediaType(ascii('RIFF????WEBPVP8 ')), 'image/webp');
  assert.equal(sniffMediaType(ascii('RIFF????WAVEfmt ')), 'audio/wav');
});

test('an ISO container holding audio is not announced as video', () => {
  assert.equal(sniffMediaType(ascii('....ftypM4A ')), 'audio/mp4');
  assert.equal(sniffMediaType(ascii('....ftypisom')), 'video/mp4');
});

test('bytes too short to hold a signature match nothing', () => {
  assert.equal(sniffMediaType(bytes(0x89, 0x50)), '');
  assert.equal(sniffMediaType(new Uint8Array()), '');
});

test('text is left as text when nothing recognises it', () => {
  assert.equal(sniffMediaType(ascii('{"ok":true}')), '');
  assert.equal(previewKind('application/octet-stream', ascii('{"ok":true}')), 'none');
});

test('a server that named a type is taken at its word', () => {
  // A PNG mislabelled `text/plain` stays mislabelled on screen, which is the
  // bug the user needs to see.
  assert.equal(effectiveMediaType('text/plain', bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)), 'text/plain');
});

test('a server that said nothing useful has its body sniffed', () => {
  const png = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  assert.equal(effectiveMediaType('application/octet-stream', png), 'image/png');
  assert.equal(effectiveMediaType('', png), 'image/png');
  assert.equal(previewKind('application/octet-stream', png), 'image');
});

test('media with no reading as text opens in the preview; HTML does not', () => {
  assert.ok(isOpaqueMedia('image'));
  assert.ok(isOpaqueMedia('audio'));
  assert.ok(isOpaqueMedia('video'));
  assert.ok(!isOpaqueMedia('html'));
  assert.ok(!isOpaqueMedia('none'));
});
