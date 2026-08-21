import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ItemResultCollector } from '../../src/runner/itemResults';
import type { CachedResponse } from '../../src/panels/responseCache';
import type { RunnerMessage } from '../../src/runner/protocol';

const RUN = 'run-1';

function collect() {
  const started: string[] = [];
  const finished: Array<{ itemId: string; result: CachedResponse }> = [];
  const collector = new ItemResultCollector({
    onStarted: (itemId) => started.push(itemId),
    onFinished: (itemId, result) => finished.push({ itemId, result })
  });
  const feed = (...messages: Array<Partial<RunnerMessage> & { type: RunnerMessage['type'] }>) => {
    for (const m of messages) { collector.handle({ runId: RUN, cursor: {}, ...m } as RunnerMessage); }
  };
  return { collector, started, finished, feed };
}

const request = { method: 'GET', url: 'https://a', headers: [] };
const response = (code: number) => ({
  code,
  status: 'OK',
  responseTime: 12,
  responseSize: 3,
  headers: [],
  bodyBase64: '',
  bodyTruncated: false,
  cookies: []
});

test('everything between beforeItem and itemDone belongs to that item', () => {
  const { started, finished, feed } = collect();

  feed(
    { type: 'beforeItem', itemId: 'one', itemName: 'One' },
    { type: 'beforeRequest', request },
    { type: 'response', request, response: response(200) },
    { type: 'assertion', assertions: [{ name: 'status is 200', passed: true, skipped: false }] },
    { type: 'console', level: 'log', messages: ['hello', 'world'] },
    { type: 'itemDone', itemId: 'one' }
  );

  assert.deepEqual(started, ['one']);
  assert.equal(finished.length, 1);
  assert.equal(finished[0].itemId, 'one');
  assert.equal(finished[0].result.response?.code, 200);
  assert.equal(finished[0].result.assertions.length, 1);
  assert.deepEqual(finished[0].result.console, [{ level: 'log', message: 'hello world' }]);
});

test('each item in a run gets its own result', () => {
  const { started, finished, feed } = collect();

  feed(
    { type: 'beforeItem', itemId: 'one' },
    { type: 'response', request, response: response(200) },
    { type: 'itemDone', itemId: 'one' },
    { type: 'beforeItem', itemId: 'two' },
    { type: 'requestError', message: 'connect ECONNREFUSED' },
    { type: 'itemDone', itemId: 'two' }
  );

  assert.deepEqual(started, ['one', 'two']);
  assert.deepEqual(finished.map((f) => f.itemId), ['one', 'two']);
  assert.equal(finished[0].result.response?.code, 200);
  assert.equal(finished[1].result.response, undefined);
  assert.equal(finished[1].result.failure, 'connect ECONNREFUSED');
  assert.notEqual(finished[0].result, finished[1].result, 'results are not shared between items');
});

test('messages arriving before any item are dropped rather than misfiled', () => {
  const { finished, feed } = collect();
  // postman-runtime narrates run-level events too; they belong to no request.
  feed(
    { type: 'runStarted' },
    { type: 'console', level: 'warn', messages: ['collection-level'] },
    { type: 'beforeItem', itemId: 'one' },
    { type: 'itemDone', itemId: 'one' }
  );
  assert.deepEqual(finished[0].result.console, [], 'the stray line did not land on item one');
});

test('an item left open by the next beforeItem is still reported', () => {
  const { started, finished, feed } = collect();
  // A missing itemDone would otherwise have item two's messages land on item one.
  feed(
    { type: 'beforeItem', itemId: 'one' },
    { type: 'response', request, response: response(500) },
    { type: 'beforeItem', itemId: 'two' },
    { type: 'response', request, response: response(200) },
    { type: 'itemDone', itemId: 'two' }
  );

  assert.deepEqual(started, ['one', 'two']);
  assert.deepEqual(finished.map((f) => f.itemId), ['one', 'two']);
  assert.equal(finished[0].result.response?.code, 500);
  assert.equal(finished[1].result.response?.code, 200);
});

test('an aborted run reports the item it was in the middle of', () => {
  const { collector, finished, feed } = collect();
  feed({ type: 'beforeItem', itemId: 'one' }, { type: 'beforeRequest', request });
  collector.finish('Runner process exited unexpectedly.');

  assert.equal(finished.length, 1, 'a request left running forever is worse than one reported failed');
  assert.equal(finished[0].result.failure, 'Runner process exited unexpectedly.');
});

test('a failure already reported by the run is not overwritten', () => {
  const { collector, finished, feed } = collect();
  feed({ type: 'beforeItem', itemId: 'one' }, { type: 'requestError', message: 'ETIMEDOUT' });
  collector.finish('aborted');
  assert.equal(finished[0].result.failure, 'ETIMEDOUT');
});

test('finishing twice reports nothing the second time', () => {
  const { collector, finished, feed } = collect();
  feed({ type: 'beforeItem', itemId: 'one' }, { type: 'itemDone', itemId: 'one' });
  collector.finish();
  assert.equal(finished.length, 1);
});

test('a visualizer template is recorded rather than shown', () => {
  const { finished, feed } = collect();
  feed(
    { type: 'beforeItem', itemId: 'one' },
    { type: 'visualizer', html: '<h1>chart</h1>' },
    { type: 'exception', message: 'TypeError: nope' },
    { type: 'itemDone', itemId: 'one' }
  );
  assert.equal(finished[0].result.visualizerHtml, '<h1>chart</h1>');
  assert.deepEqual(finished[0].result.console, [{ level: 'error', message: 'TypeError: nope' }]);
});

test('an item the runner could not identify is skipped', () => {
  const { started, finished, feed } = collect();
  feed({ type: 'beforeItem' }, { type: 'response', request, response: response(200) }, { type: 'itemDone' });
  assert.deepEqual(started, [], 'there is nothing to file the result under');
  assert.deepEqual(finished, []);
});
