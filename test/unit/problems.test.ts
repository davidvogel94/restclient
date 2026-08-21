import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { jsonProblems, positionAt } from '../../src/collections/problems';

test('positionAt counts lines and columns the way an editor does', () => {
  const text = 'abc\ndefg\nhi';
  assert.deepEqual(positionAt(text, 0), { line: 1, column: 1 });
  assert.deepEqual(positionAt(text, 2), { line: 1, column: 3 });
  assert.deepEqual(positionAt(text, 4), { line: 2, column: 1 });
  assert.deepEqual(positionAt(text, 9), { line: 3, column: 1 });
});

test('positionAt puts a CRLF break on the next line, not the end of this one', () => {
  const text = 'a\r\nb';
  assert.deepEqual(positionAt(text, 3), { line: 2, column: 1 });
});

test('positionAt clamps rather than running off either end', () => {
  assert.deepEqual(positionAt('ab', 99), { line: 1, column: 3 });
  assert.deepEqual(positionAt('ab', -5), { line: 1, column: 1 });
});

test('valid JSON has no problems', () => {
  assert.deepEqual(jsonProblems('{ "info": { "name": "Smoke" }, "item": [] }'), []);
  assert.deepEqual(jsonProblems('{\n\t"a": [1, 2, {"b": null}]\n}\n'), []);
});

test('a missing comma is reported where the next value starts', () => {
  const text = '{\n\t"a": 1\n\t"b": 2\n}\n';
  const [first] = jsonProblems(text);

  assert.equal(first.message, "Expected ','");
  assert.equal(first.line, 3, 'the line the parser could not continue past');
  assert.equal(first.column, 2, 'just after the leading tab');
  assert.equal(text.slice(first.offset, first.offset! + first.length!), '"b"');
});

test('an unterminated string is reported at the string', () => {
  const [first] = jsonProblems('{ "name": "Smoke }\n');
  assert.equal(first.message, 'Unterminated string');
  assert.equal(first.line, 1);
  assert.equal(first.column, 11);
});

test('every problem is reported, not just the first', () => {
  // Recovering matters: fixing one error at a time is a round trip each.
  const problems = jsonProblems('{ "a": , "b": , }');
  assert.ok(problems.length >= 2, `expected several problems, got ${problems.length}`);
  assert.ok(problems.every((p) => p.line === 1));
  // In file order, so the tree reads top to bottom.
  const offsets = problems.map((p) => p.offset!);
  assert.deepEqual(offsets, [...offsets].sort((a, b) => a - b));
});

test('JSON is held to JSON rules, not JSONC', () => {
  // The file is read back by JSON.parse and by Postman; neither forgives these.
  assert.equal(jsonProblems('{ "a": 1, }')[0].message, "Expected a property name");
  assert.equal(jsonProblems('{ // hi\n"a": 1 }')[0].message, 'JSON does not allow comments');
});

test('an empty file is a problem, not an empty collection', () => {
  const [first] = jsonProblems('');
  assert.equal(first.message, 'Expected a value');
  assert.deepEqual({ line: first.line, column: first.column }, { line: 1, column: 1 });
});

test('problem messages are readable, not parser enum names', () => {
  for (const text of ['{', '[', '{ "a" 1 }', '{ "a": 0x1 }']) {
    for (const problem of jsonProblems(text)) {
      assert.ok(
        !/^[A-Z][a-z]+[A-Z]/.test(problem.message),
        `"${problem.message}" reads like an enum name`
      );
    }
  }
});
