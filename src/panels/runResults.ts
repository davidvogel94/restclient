import * as vscode from 'vscode';
import { ResponseCache, resultKey, type CachedResponse } from './responseCache';
import { summarize, type RunSummary } from '../shared/runSummary';

/**
 * The one record of what each request last did.
 *
 * Three things need it and none of them owns it: the request editor, which
 * produces most of it; the Collections tree, which shows a hint per row; and
 * the collection/folder overview, which shows a whole list of them and produces
 * its own via Run All. Holding it here is what lets a folder run light up the
 * tree and repopulate an editor that was already open, without either view
 * having to know the other exists.
 *
 * Nothing is persisted — see ResponseCache for why.
 */

/** What became of a request's last run, for anything showing it out of band. */
export interface LastRun {
  /** A run in flight, whose result is not in yet. */
  running: boolean;
  summary?: RunSummary;
  /** The names of the assertions that failed. */
  failures: string[];
}

export class RunResults implements vscode.Disposable {
  private readonly responses = new ResponseCache();
  /** Keys with a run in flight, which no cached response can tell you about. */
  private readonly inFlight = new Set<string>();

  private readonly _onDidChange = new vscode.EventEmitter<void>();
  /** Fires whenever a run starts, finishes, or is cleared. */
  readonly onDidChangeResults = this._onDidChange.event;

  /** The key one request's result is filed under. */
  key(collectionUri: vscode.Uri, itemId: string): string {
    return resultKey(collectionUri.toString(), itemId);
  }

  get(key: string): CachedResponse | undefined {
    return this.responses.get(key);
  }

  isRunning(key: string): boolean {
    return this.inFlight.has(key);
  }

  setRunning(key: string, running: boolean): void {
    if (running) { this.inFlight.add(key); }
    else { this.inFlight.delete(key); }
    this._onDidChange.fire();
  }

  /**
   * File what a run came back with.
   *
   * The event fires after the write, so a listener that reads the store back
   * sees this run rather than the one before it.
   */
  record(key: string, result: CachedResponse): void {
    this.responses.set(key, result);
    this._onDidChange.fire();
  }

  /** What happened last time this request ran, in the few facts a row can carry. */
  lastRun(collectionUri: vscode.Uri, itemId: string): LastRun | undefined {
    const key = this.key(collectionUri, itemId);
    const running = this.isRunning(key);
    const cached = this.get(key);
    if (!running && !cached) { return undefined; }
    return {
      running,
      summary: cached ? summarize(cached) : undefined,
      failures: (cached?.assertions ?? [])
        .filter((a) => !a.passed && !a.skipped)
        .map((a) => a.name)
    };
  }

  /**
   * Forget every response. A run still in flight is left alone — it is going to
   * report its result whatever this says, and dropping it from the in-flight set
   * would leave the views claiming it had finished.
   */
  clear(): void {
    this.responses.clear();
    this._onDidChange.fire();
  }

  dispose(): void {
    this.responses.clear();
    this.inFlight.clear();
    this._onDidChange.dispose();
  }
}
