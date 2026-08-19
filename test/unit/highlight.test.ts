import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  bodyLanguage,
  contentTypeLanguage,
  highlight,
  languageTokens,
  mergeTokens,
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
