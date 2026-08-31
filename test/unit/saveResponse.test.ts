import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { responseFileExtension, responseFileName, responseHead } from '../../src/panels/saveResponse';
import type { SerializedResponse } from '../../src/runner/protocol';

function response(over: Partial<SerializedResponse> = {}): SerializedResponse {
  return {
    code: 200,
    status: 'OK',
    responseTime: 12,
    responseSize: 2,
    headers: [{ key: 'Content-Type', value: 'application/json' }],
    bodyBase64: '',
    bodyTruncated: false,
    cookies: [],
    ...over
  };
}

test('a body is named for the type the server said it was', () => {
  assert.equal(responseFileExtension('application/json; charset=utf-8'), '.json');
  assert.equal(responseFileExtension('TEXT/HTML'), '.html');
  assert.equal(responseFileExtension('image/png'), '.png');
});

test('a structured suffix names the syntax a vendor type is written in', () => {
  assert.equal(responseFileExtension('application/vnd.api+json'), '.json');
  assert.equal(responseFileExtension('application/problem+json'), '.json');
  assert.equal(responseFileExtension('application/atom+xml'), '.xml');
});

test('an exact type beats its structured suffix', () => {
  assert.equal(responseFileExtension('image/svg+xml'), '.svg');
});

test('an unknown text type is still text; an unknown other type is not', () => {
  assert.equal(responseFileExtension('text/vnd.made-up'), '.txt');
  assert.equal(responseFileExtension('application/vnd.made-up'), '.bin');
});

test('a response with no content-type is saved as text', () => {
  assert.equal(responseFileExtension(''), '.txt');
});

test('the file is named after the request', () => {
  assert.equal(responseFileName('List Orders', 'application/json', 'body'), 'list-orders.json');
  assert.equal(responseFileName('Get Logo', 'image/png', 'body'), 'get-logo.png');
});

test('a whole message is a .http file whatever its body is', () => {
  assert.equal(responseFileName('Get Logo', 'image/png', 'full'), 'get-logo.http');
});

test('the head is an HTTP message: status line, headers, blank line', () => {
  const head = responseHead(
    response({
      code: 404,
      status: 'Not Found',
      headers: [
        { key: 'Content-Type', value: 'application/json' },
        { key: 'X-Request-Id', value: 'abc' }
      ]
    })
  );
  assert.equal(
    head,
    'HTTP 404 Not Found\r\nContent-Type: application/json\r\nX-Request-Id: abc\r\n\r\n'
  );
});

test('a status with no reason phrase leaves no trailing space', () => {
  assert.equal(responseHead(response({ code: 204, status: '', headers: [] })), 'HTTP 204\r\n\r\n');
});
