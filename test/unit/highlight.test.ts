import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  bodyLanguage,
  contentTypeLanguage,
  highlight,
  languageTokens,
  mergeTokens,
  pathVariableTokens,
  renderTokens,
  variableTokens,
  type Token
} from '../../src/shared/highlight';

/** Reading a token back out of the source proves the offsets line up. */
function slice(text: string, tokens: Token[]): string[] {
  return tokens.map((t) => text.slice(t.start, t.end));
}

test('variableTokens finds Postman-style markers', () => {
  const text = 'https://{{baseUrl}}/users/{{id}}';
  const tokens = variableTokens(text);
  assert.deepEqual(slice(text, tokens), ['{{baseUrl}}', '{{id}}']);
  assert.deepEqual(tokens.map((t) => t.name), ['baseUrl', 'id']);
});

test('variableTokens matches Postman on nesting and empties', () => {
  // postman-collection's regex is /{{([^{}]*?)}}/g — nested braces are not a variable.
  assert.deepEqual(variableTokens('{{a{{b}}}}').map((t) => t.name), ['b']);
  assert.deepEqual(variableTokens('{{}}').map((t) => t.name), ['']);
  assert.deepEqual(variableTokens('{ {notavar} }'), []);
});

test('variableTokens classifies per name', () => {
  const text = '{{known}} {{missing}} {{$guid}}';
  const tokens = variableTokens(text, (n) =>
    n.startsWith('$') ? 'var-dynamic' : n === 'known' ? 'var-ok' : 'var-missing'
  );
  assert.deepEqual(tokens.map((t) => t.cls), ['var-ok', 'var-missing', 'var-dynamic']);
});

test('languageTokens returns offsets that map back to the source', () => {
  const text = '{"a": 1, "b": [true, null]}';
  const tokens = languageTokens(text, 'json');
  assert.ok(tokens.length > 0);
  for (const t of tokens) {
    assert.ok(t.start < t.end && t.end <= text.length, 'token within bounds');
  }
  // hljs nests literal > keyword; the innermost recognised class must win.
  const t = tokens.find((x) => text.slice(x.start, x.end) === 'true');
  assert.equal(t?.cls, 'kw');
  assert.equal(tokens.find((x) => text.slice(x.start, x.end) === '"a"')?.cls, 'prop');
  assert.equal(tokens.find((x) => text.slice(x.start, x.end) === '1')?.cls, 'num');
});

test('languageTokens survives text hljs has to escape', () => {
  const text = '<a href="x">1 & 2 < 3</a>';
  const tokens = languageTokens(text, 'xml');
  for (const t of tokens) {
    assert.ok(t.end <= text.length, `token ${t.start}-${t.end} beyond ${text.length}`);
  }
  assert.ok(tokens.some((t) => text.slice(t.start, t.end).includes('href')));
});

test('languageTokens declines rather than misaligns', () => {
  assert.deepEqual(languageTokens('anything', 'not-a-language'), []);
  assert.deepEqual(languageTokens('anything', 'plaintext'), []);
  assert.deepEqual(languageTokens('anything', undefined), []);
  assert.deepEqual(languageTokens('x'.repeat(200_000), 'json'), []);
});

test('pathVariableTokens finds `:name` path segments', () => {
  const text = 'https://api.test/users/:userId/posts/:postId';
  const tokens = pathVariableTokens(text);
  assert.deepEqual(slice(text, tokens), [':userId', ':postId']);
});

test('pathVariableTokens matches Postman on what is not a path variable', () => {
  // The scheme's colon, and a port, are not path segments.
  assert.deepEqual(pathVariableTokens('https://localhost:3000/things'), []);
  // A name stops at the first `.`, so the extension stays plain — url.js:41.
  assert.deepEqual(slice('/orders/:id.json', pathVariableTokens('/orders/:id.json')), [':id']);
  // Past `?` a colon is an ordinary character.
  assert.deepEqual(pathVariableTokens('/search?at=12:30'), []);
  // A bare `:` binds nothing.
  assert.deepEqual(pathVariableTokens('/a/:/b'), []);
});

test('pathVariableTokens classifies per name', () => {
  const text = '{{baseUrl}}/users/:set/:unset';
  const tokens = pathVariableTokens(text, (n) => (n === 'set' ? 'path-ok' : 'path-missing'));
  assert.deepEqual(tokens.map((t) => t.cls), ['path-ok', 'path-missing']);
  // Unnamed, so the {{variable}} hover popover ignores them.
  assert.deepEqual(tokens.map((t) => t.name), [undefined, undefined]);
});

test('a URL colours path and environment variables side by side', () => {
  const text = 'https://{{baseUrl}}/users/:id';
  const merged = mergeTokens(pathVariableTokens(text), variableTokens(text));
  assert.deepEqual(slice(text, merged), ['{{baseUrl}}', ':id']);
  assert.deepEqual(merged.map((t) => t.cls), ['var-ok', 'path-ok']);
});

test('mergeTokens splits a language token around a variable', () => {
  const text = '{"url": "http://{{host}}/x"}';
  const merged = mergeTokens(languageTokens(text, 'json'), variableTokens(text));
  // No overlaps, ordered, and the variable survives whole.
  for (let i = 1; i < merged.length; i++) {
    assert.ok(merged[i].start >= merged[i - 1].end, 'tokens must not overlap');
  }
  assert.ok(merged.some((t) => t.name === 'host' && text.slice(t.start, t.end) === '{{host}}'));
});

test('mergeTokens keeps a variable that spans a whole language token', () => {
  const text = '"{{whole}}"';
  const merged = mergeTokens([{ start: 0, end: text.length, cls: 'str' }], variableTokens(text));
  assert.deepEqual(slice(text, merged), ['"', '{{whole}}', '"']);
});

test('renderTokens escapes and round-trips the source text', () => {
  const text = 'a & b <c> {{v}}';
  const html = renderTokens(text, variableTokens(text));
  assert.ok(html.includes('&amp;') && html.includes('&lt;c&gt;'));
  assert.ok(html.includes('<span class="tok-var-ok" data-var="v">{{v}}</span>'));
  // Strip our own spans and unescape: what remains must be the original text.
  const plain = html
    .replace(/<\/?span[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
  assert.equal(plain, text);
});

test('renderTokens keeps a trailing newline visible in a <pre>', () => {
  assert.ok(renderTokens('a\n', []).endsWith('\n\n'));
  assert.ok(!renderTokens('a', []).endsWith('\n'));
});

test('highlight composes language and variable passes', () => {
  const html = highlight('{"host": "{{baseUrl}}"}', 'json', () => 'var-missing');
  assert.ok(html.includes('tok-var-missing'));
  assert.ok(html.includes('tok-prop'));
});

test('language hints map to registered languages', () => {
  assert.equal(bodyLanguage('json'), 'json');
  assert.equal(bodyLanguage('html'), 'xml');
  assert.equal(bodyLanguage('text'), 'plaintext');
  assert.equal(bodyLanguage(undefined), 'plaintext');
  assert.equal(contentTypeLanguage('application/json; charset=utf-8'), 'json');
  assert.equal(contentTypeLanguage('text/html'), 'xml');
  assert.equal(contentTypeLanguage('application/javascript'), 'javascript');
  assert.equal(contentTypeLanguage('text/plain'), 'plaintext');
});
