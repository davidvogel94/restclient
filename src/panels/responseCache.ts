import type { SerializedAssertion, SerializedRequest, SerializedResponse } from '../runner/protocol';
import type { ConsoleLine } from './protocol';

/**
 * The last result of each request, held in memory only.
 *
 * Responses routinely carry tokens, personal data and whole database rows, so
 * none of this is ever written anywhere — not to workspace state, not to global
 * storage, not to disk. It lives for as long as the extension host does and
 * goes away with the window. Its only job is that closing a request editor and
 * reopening it does not lose what came back.
 */

export interface CachedResponse {
  request?: SerializedRequest;
  response?: SerializedResponse;
  assertions: SerializedAssertion[];
  console: ConsoleLine[];
  visualizerHtml?: string;
  failure?: string;
}

/** Roughly 32 MB of base64 bodies, after which the oldest entries are dropped. */
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_ENTRIES = 50;

export class ResponseCache {
  // Insertion order is the eviction order; re-setting a key moves it to newest.
  private readonly entries = new Map<string, CachedResponse>();

  get(key: string): CachedResponse | undefined {
    return this.entries.get(key);
  }

  set(key: string, value: CachedResponse): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    this.evict();
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  /** Approximate retained bytes, dominated by the base64 bodies. */
  private bytes(): number {
    let total = 0;
    for (const entry of this.entries.values()) {
      total += entry.response?.bodyBase64.length ?? 0;
      total += entry.visualizerHtml?.length ?? 0;
    }
    return total;
  }

  private evict(): void {
    while (this.entries.size > MAX_ENTRIES || (this.entries.size > 1 && this.bytes() > MAX_BYTES)) {
      const oldest = this.entries.keys().next();
      if (oldest.done) { return; }
      this.entries.delete(oldest.value);
    }
  }
}
