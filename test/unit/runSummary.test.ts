import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { CachedResponse } from '../../src/panels/responseCache';
import { runDetail, runHint, summarize, testTally } from '../../src/shared/runSummary';

function cached(over: Partial<CachedResponse> = {}): CachedResponse {
  return { assertions: [], console: [], ...over };
}

function response(code: number, status = 'OK'): any {
  return { code, status, responseTime: 124, responseSize: 2048, headers: [], bodyBase64: '', cookies: [] };
}

function assertion(name: string, passed: boolean, skipped = false): any {
  return { name, passed, skipped };
}

test('summarize reads the status and tallies the tests', () => {
  const summary = summarize(
    cached({
      response: response(200),
      assertions: [
        assertion('status is 200', true),
        assertion('token issued', false),
        assertion('later', false, true)
      ]
    })
  );

  assert.equal(summary.code, 200);
  assert.equal(summary.status, 'OK');
  assert.equal(summary.responseTime, 124);
  assert.deepEqual({ ...summary, code: 200 }.failed, 1);
  assert.equal(summary.passed, 1);
  // A pending test is neither: counting it as a pass would overstate the run.
  assert.equal(summary.skipped, 1);
});

test('a request with no response reports its failure instead', () => {
  const summary = summarize(cached({ failure: 'connect ECONNREFUSED' }));
  assert.equal(summary.code, undefined);
  assert.equal(summary.failure, 'connect ECONNREFUSED');
});

test('the tally names the failures, or counts the passes', () => {
  assert.equal(testTally({ passed: 3, failed: 0, skipped: 0 }), '✓ 3');
  assert.equal(testTally({ passed: 2, failed: 1, skipped: 0 }), '✗ 1/3');
  assert.equal(testTally({ passed: 0, failed: 0, skipped: 0 }), '', 'a request with no tests says nothing');
});

test('the row hint is the status, then the tests', () => {
  assert.equal(runHint(undefined, false), '', 'a request never run has nothing to report');
  assert.equal(runHint(undefined, true), 'running…');
  assert.equal(
    runHint({ code: 200, passed: 3, failed: 0, skipped: 0 }, true),
    'running…',
    'a run in flight must not leave the previous result standing'
  );
  assert.equal(runHint({ code: 200, passed: 0, failed: 0, skipped: 0 }, false), '200');
  assert.equal(runHint({ code: 200, passed: 3, failed: 0, skipped: 0 }, false), '200 · ✓ 3');
  assert.equal(runHint({ code: 500, passed: 2, failed: 1, skipped: 0 }, false), '500 · ✗ 1/3');
  assert.equal(
    runHint({ passed: 0, failed: 0, skipped: 0, failure: 'socket hang up' }, false),
    'failed',
    'no status code came back, so there is none to show'
  );
});

test('the detail lines carry what the row has no room for', () => {
  const lines = runDetail(
    {
      code: 201,
      status: 'Created',
      responseTime: 124,
      responseSize: 2048,
      passed: 2,
      failed: 1,
      skipped: 0
    },
    ['token issued']
  );

  assert.deepEqual(lines, ['201 Created · 124 ms · 2.0 KB', '2 passed, 1 failed', '✗ token issued']);
});

test('a request with no tests gets no test line', () => {
  const lines = runDetail({ code: 204, status: 'No Content', passed: 0, failed: 0, skipped: 0 });
  assert.deepEqual(lines, ['204 No Content']);
});
