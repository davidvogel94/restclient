import type { CachedResponse } from '../panels/responseCache';

/**
 * What the last run of a request amounted to, in the few facts a tree row can
 * carry: did it come back, with what status, and did its tests pass.
 *
 * Derived rather than stored — the cached response already holds all of it —
 * and kept free of `vscode` so both the shape and its wording can be tested
 * without booting the editor.
 */

export interface RunSummary {
  /** Absent when nothing came back: a transport failure, or still in flight. */
  code?: number;
  status?: string;
  responseTime?: number;
  responseSize?: number;
  passed: number;
  failed: number;
  skipped: number;
  /** A transport error or an aborted run, which is not a status code. */
  failure?: string;
}

export function summarize(cached: CachedResponse): RunSummary {
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  for (const assertion of cached.assertions) {
    // A pending test is neither a pass nor a failure, and counting it as either
    // would misreport the run.
    if (assertion.skipped) { skipped++; }
    else if (assertion.passed) { passed++; }
    else { failed++; }
  }

  return {
    code: cached.response?.code,
    status: cached.response?.status,
    responseTime: cached.response?.responseTime,
    responseSize: cached.response?.responseSize,
    passed,
    failed,
    skipped,
    failure: cached.failure
  };
}

/** `✓ 3`, or `✗ 1/3` when some failed. Empty when the request has no tests. */
export function testTally(summary: RunSummary): string {
  const total = summary.passed + summary.failed + summary.skipped;
  if (!total) { return ''; }
  return summary.failed ? `✗ ${summary.failed}/${total}` : `✓ ${summary.passed}`;
}

/**
 * The hint a request row shows after its method: `200 · ✓ 3`.
 *
 * A run in flight says so instead of showing the previous result, which would
 * otherwise sit there looking like the answer to the run just started.
 */
export function runHint(summary: RunSummary | undefined, running: boolean): string {
  if (running) { return 'running…'; }
  if (!summary) { return ''; }

  const status = summary.code === undefined ? (summary.failure ? 'failed' : '') : String(summary.code);
  return [status, testTally(summary)].filter(Boolean).join(' · ');
}

function size(bytes: number): string {
  if (bytes < 1024) { return `${bytes} B`; }
  if (bytes < 1024 * 1024) { return `${(bytes / 1024).toFixed(1)} KB`; }
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * The detail behind the hint, for the row's tooltip: the status in full, what
 * it cost, and which tests failed — the last being the whole reason to look.
 */
export function runDetail(
  summary: RunSummary,
  failures: string[] = []
): string[] {
  const lines: string[] = [];

  if (summary.code !== undefined) {
    lines.push(
      [
        `${summary.code} ${summary.status ?? ''}`.trim(),
        summary.responseTime === undefined ? '' : `${summary.responseTime} ms`,
        summary.responseSize === undefined ? '' : size(summary.responseSize)
      ]
        .filter(Boolean)
        .join(' · ')
    );
  }

  if (summary.failure) { lines.push(summary.failure); }

  const total = summary.passed + summary.failed + summary.skipped;
  if (total) {
    lines.push(
      [
        `${summary.passed} passed`,
        summary.failed ? `${summary.failed} failed` : '',
        summary.skipped ? `${summary.skipped} skipped` : ''
      ]
        .filter(Boolean)
        .join(', ')
    );
    lines.push(...failures.map((name) => `✗ ${name}`));
  }

  return lines;
}
