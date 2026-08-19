import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { formatBody, formatJson, formatXml } from '../../src/shared/format';

test('formatJson indents a minified payload', () => {
  assert.equal(formatJson('{"a":1,"b":[2,3]}'), '{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}');
});

test('formatJson leaves invalid JSON untouched', () => {
  assert.equal(formatJson('not json'), 'not json');
  assert.equal(formatJson('{"a":'), '{"a":');
});

test('formatXml breaks nesting across lines', () => {
  assert.equal(
    formatXml('<a><b><c/></b></a>'),
    '<a>\n  <b>\n    <c/>\n  </b>\n</a>'
  );
});

test('formatXml keeps a leaf value on its own line', () => {
  assert.equal(
    formatXml('<root><name>Ada</name><age>36</age></root>'),
    '<root>\n  <name>Ada</name>\n  <age>36</age>\n</root>'
  );
});

test('formatXml keeps the declaration at the top level', () => {
  const out = formatXml('<?xml version="1.0"?><root><a>1</a></root>');
  assert.equal(out.split('\n')[0], '<?xml version="1.0"?>');
  assert.equal(out.split('\n')[1], '<root>');
});

test('formatXml does not corrupt comments or CDATA containing >', () => {
  const out = formatXml('<r><!-- a > b --><d><![CDATA[x > y]]></d></r>');
  assert.ok(out.includes('<!-- a > b -->'), out);
  assert.ok(out.includes('<![CDATA[x > y]]>'), out);
});

test('formatXml leaves plain text alone', () => {
  assert.equal(formatXml('just some text'), 'just some text');
});

test('formatXml survives an unclosed tag', () => {
  // Malformed markup must not throw or lose content.
  const out = formatXml('<a><b></a>');
  assert.ok(out.includes('<b>') && out.includes('</a>'), out);
});

test('formatBody dispatches on language', () => {
  assert.equal(formatBody('{"a":1}', 'json'), '{\n  "a": 1\n}');
  assert.equal(formatBody('<a><b/></a>', 'xml'), '<a>\n  <b/>\n</a>');
  assert.equal(formatBody('plain text', 'plaintext'), 'plain text');
});

test('formatBody still lays out JSON served with a vague content-type', () => {
  assert.equal(formatBody('{"a":1}', 'plaintext'), '{\n  "a": 1\n}');
});

test('formatBody leaves an empty body alone', () => {
  assert.equal(formatBody('', 'json'), '');
  assert.equal(formatBody('   ', 'json'), '   ');
});
