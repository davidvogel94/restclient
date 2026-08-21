import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  compileSearch,
  jsonLeafText,
  jsonMatches,
  matchTokens,
  MATCH_LIMIT,
  type Matcher
} from '../../src/shared/search';
import { mergeTokens, renderTokens, variableTokens } from '../../src/shared/highlight';

/** The compiled matcher, asserting the query was one. */
function matcherFor(text: string, options?: { regex?: boolean; caseSensitive?: boolean }): Matcher {
  const search = compileSearch(text, options);
  assert.equal(search.kind, 'ready', `expected "${text}" to compile`);
  return (search as { kind: 'ready'; matcher: Matcher }).matcher;
}

const hits = (text: string, query: string, options?: { regex?: boolean; caseSensitive?: boolean }) =>
  matcherFor(query, options).ranges(text).map((r) => text.slice(r.start, r.end));

test('an empty query is not a search', () => {
  assert.equal(compileSearch('').kind, 'empty');
  assert.equal(compileSearch(undefined).kind, 'empty');
});

test('a literal query is taken literally', () => {
  // Regex metacharacters are text until regex mode says otherwise.
  assert.deepEqual(hits('a.b axb', 'a.b'), ['a.b']);
  assert.deepEqual(hits('cost: $5 (each)', '$5 (each)'), ['$5 (each)']);
  assert.deepEqual(hits('nothing here', 'a.b'), []);
});

test('case is ignored until asked for', () => {
  assert.deepEqual(hits('Text and TEXT', 'text'), ['Text', 'TEXT']);
  assert.deepEqual(hits('Text and TEXT', 'text', { caseSensitive: true }), []);
  assert.deepEqual(hits('Text and TEXT', 'TEXT', { caseSensitive: true }), ['TEXT']);
});

test('regex mode compiles the query as a pattern', () => {
  assert.deepEqual(hits('id=42, id=7', '\\d+', { regex: true }), ['42', '7']);
  assert.deepEqual(hits('a1 b2', '[ab]\\d', { regex: true }), ['a1', 'b2']);
});

test('a half-typed pattern reports itself rather than matching nothing', () => {
  const search = compileSearch('[a-', { regex: true });
  assert.equal(search.kind, 'invalid');
  assert.ok(search.kind === 'invalid' && search.message.length > 0);
  // The same text is fine as a literal.
  assert.deepEqual(hits('x[a-b', '[a-'), ['[a-']);
});

test('a pattern that can match nothing still terminates', () => {
  // `a*` matches the empty string everywhere; the scan must advance regardless.
  assert.deepEqual(hits('baaa', 'a*', { regex: true }), ['aaa']);
  assert.deepEqual(hits('abc', '^', { regex: true }), []);
});

test('ranges stop at the limit rather than build a span per character', () => {
  const matcher = matcherFor('.', { regex: true });
  assert.equal(matcher.ranges('x'.repeat(MATCH_LIMIT * 2)).length, MATCH_LIMIT);
});

test('test looks across every field it is given', () => {
  const matcher = matcherFor('json');
  assert.equal(matcher.test('content-type', 'application/json'), true);
  assert.equal(matcher.test('json', undefined), true);
  assert.equal(matcher.test('accept', 'text/html'), false);
  assert.equal(matcher.test(undefined, ''), false);
});

test('test and ranges do not disturb each other', () => {
  // One RegExp with /g/ backs both; a leftover lastIndex would drop matches.
  const matcher = matcherFor('a');
  assert.equal(matcher.test('banana'), true);
  assert.equal(matcher.ranges('banana').length, 3);
  assert.equal(matcher.test('banana'), true);
  assert.equal(matcher.ranges('banana').length, 3);
});

test('matchTokens number their hits so adjacent ones stay apart', () => {
  const text = 'abab';
  const tokens = matchTokens(text, matcherFor('ab'));
  assert.deepEqual(tokens.map((t) => t.index), [0, 1]);
  // Coalescing inside renderTokens would otherwise merge the two touching spans.
  const html = renderTokens(text, tokens);
  assert.equal(html.match(/data-match=/g)?.length, 2);
});

test('matchTokens overlay the colouring rather than lose it', () => {
  const text = 'https://{{host}}/users';
  const merged = mergeTokens(variableTokens(text), matchTokens(text, matcherFor('host')));
  const html = renderTokens(text, merged);
  // The hit wins where they overlap, and the variable survives around it.
  assert.ok(html.includes('<span class="tok-match" data-match="0">host</span>'));
  assert.ok(html.includes('data-var="host"'));
  for (let i = 1; i < merged.length; i++) {
    assert.ok(merged[i].start >= merged[i - 1].end, 'tokens must not overlap');
  }
});

test('matchTokens without a search mark nothing', () => {
  assert.deepEqual(matchTokens('anything', undefined), []);
});

test('jsonLeafText is what the tree shows', () => {
  assert.equal(jsonLeafText('hi'), '"hi"');
  assert.equal(jsonLeafText(42), '42');
  assert.equal(jsonLeafText(null), 'null');
  assert.equal(jsonLeafText(true), 'true');
  // Quoting is what separates the string "42" from the number.
  assert.equal(jsonMatches(matcherFor('"42"'), { a: '42', b: 42 }), true);
  assert.equal(jsonMatches(matcherFor('"42"'), { b: 42 }), false);
});

const BODY = {
  meta: { requestId: 'abc-123' },
  users: [
    { name: 'Ada', email: 'ada@example.com' },
    { name: 'Grace', email: 'grace@example.test' }
  ],
  count: 2
};

test('jsonMatches finds hits at any depth', () => {
  assert.equal(jsonMatches(matcherFor('grace@'), BODY), true);
  assert.equal(jsonMatches(matcherFor('requestId'), BODY), true, 'keys count');
  assert.equal(jsonMatches(matcherFor('nobody'), BODY), false);
});

test('jsonMatches ignores array indices', () => {
  // Otherwise "1" would match the second element of every array in the payload.
  assert.equal(jsonMatches(matcherFor('1'), ['a', 'b']), false);
  assert.equal(jsonMatches(matcherFor('1'), ['a', '1']), true);
  assert.equal(jsonMatches(matcherFor('0'), { '0': 'x' }), true, 'object keys still count');
});

test('jsonMatches sees numbers and null as the tree shows them', () => {
  assert.equal(jsonMatches(matcherFor('2'), { count: 2 }), true);
  assert.equal(jsonMatches(matcherFor('null'), { next: null }), true);
});
