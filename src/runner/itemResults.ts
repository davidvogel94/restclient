import type { CachedResponse } from '../panels/responseCache';
import type { RunnerMessage } from './protocol';

/**
 * Splitting one collection or folder run into a result per request.
 *
 * A single-request send has nothing to attribute: every message belongs to the
 * one item. A Run All does — and postman-runtime does not hand out a tidy
 * per-item summary, it narrates the run as it happens. What it does guarantee is
 * order: `beforeItem` opens an item and `itemDone` closes it, and everything in
 * between belongs to whatever is open. That bracketing is the whole of the logic
 * here, which is why it is kept free of `vscode` and tested directly.
 *
 * The results are the same shape a single send produces, so the tree, the
 * request editor and the overview all read a folder run exactly as they read a
 * send.
 */

export interface ItemResultHandlers {
  /** The item has started; nothing is known about it yet. */
  onStarted(itemId: string): void;
  /** The item is finished, with everything the run said about it. */
  onFinished(itemId: string, result: CachedResponse): void;
}

export class ItemResultCollector {
  private open: { itemId: string; result: CachedResponse } | undefined;

  constructor(private readonly handlers: ItemResultHandlers) {}

  handle(msg: RunnerMessage): void {
    switch (msg.type) {
      case 'beforeItem':
        // Defensive: an item that never got its `itemDone` would otherwise
        // swallow the next item's messages.
        this.flush();
        if (!msg.itemId) { return; }
        this.open = { itemId: msg.itemId, result: { assertions: [], console: [] } };
        this.handlers.onStarted(msg.itemId);
        return;

      case 'beforeRequest':
        if (this.open) { this.open.result.request = msg.request; }
        return;

      case 'response':
        if (this.open) {
          this.open.result.request = msg.request;
          this.open.result.response = msg.response;
        }
        return;

      case 'requestError':
        if (this.open) { this.open.result.failure = msg.message; }
        return;

      case 'assertion':
        if (this.open) { this.open.result.assertions.push(...msg.assertions); }
        return;

      case 'console':
        this.log(msg.level, msg.messages.join(' '));
        return;

      case 'exception':
        this.log('error', msg.message);
        return;

      case 'visualizer':
        // Recorded rather than shown: a folder of twenty requests must not open
        // twenty visualizer panels. Opening the request finds it waiting.
        if (this.open) { this.open.result.visualizerHtml = msg.html; }
        return;

      case 'itemDone':
        this.flush();
        return;

      default:
        return;
    }
  }

  private log(level: string, message: string): void {
    if (!this.open) { return; }
    this.open.result.console = [...this.open.result.console, { level, message }];
  }

  /**
   * Close whatever was mid-flight when the run stopped.
   *
   * An aborted run and a runner that died both leave an item open, and a request
   * left reading "running…" forever is worse than one reported as failed.
   */
  finish(failure?: string): void {
    if (this.open && failure && !this.open.result.failure) {
      this.open.result.failure = failure;
    }
    this.flush();
  }

  private flush(): void {
    const open = this.open;
    if (!open) { return; }
    this.open = undefined;
    this.handlers.onFinished(open.itemId, open.result);
  }
}
