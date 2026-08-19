<script lang="ts">
  import type { ConsoleEntry, FromConsole, ToConsole } from '../../src/panels/consoleView';

  declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
  const vscode = acquireVsCodeApi();
  const post = (msg: FromConsole) => vscode.postMessage(msg);

  let entries = $state<ConsoleEntry[]>([]);
  let filter = $state('');
  let expanded = $state<Set<number>>(new Set());
  let follow = $state(true);

  const shown = $derived.by(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) { return entries; }
    return entries.filter(
      (e) =>
        e.title.toLowerCase().includes(needle) ||
        (e.item ?? '').toLowerCase().includes(needle) ||
        e.collection.toLowerCase().includes(needle)
    );
  });

  function toggle(id: number) {
    const next = new Set(expanded);
    if (next.has(id)) { next.delete(id); } else { next.add(id); }
    expanded = next;
  }

  function codeClass(status?: number): string {
    if (!status) { return ''; }
    if (status < 300) { return 'code-2xx'; }
    if (status < 400) { return 'code-3xx'; }
    if (status < 500) { return 'code-4xx'; }
    return 'code-5xx';
  }

  function size(bytes?: number): string {
    if (bytes === undefined) { return ''; }
    if (bytes < 1024) { return `${bytes} B`; }
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  let list = $state<HTMLDivElement | undefined>(undefined);

  $effect(() => {
    // Touch `entries` so this reruns on append, then stick to the bottom.
    entries.length;
    if (follow && list) { list.scrollTop = list.scrollHeight; }
  });

  window.addEventListener('message', (event: MessageEvent<ToConsole>) => {
    const msg = event.data;
    if (msg.type === 'entries') { entries = msg.entries; }
    if (msg.type === 'append') { entries = [...entries, ...msg.entries]; }
    if (msg.type === 'cleared') { entries = []; expanded = new Set(); }
  });

  post({ type: 'ready' });
</script>

<div class="layout">
  <div class="console-toolbar">
    <input class="filter" placeholder="Filter" bind:value={filter} />
    <label class="inline muted"><input type="checkbox" bind:checked={follow} /> follow</label>
    <button class="secondary" onclick={() => post({ type: 'clear' })}>Clear</button>
  </div>

  <div class="entries" bind:this={list}>
    {#if !shown.length}
      <div class="empty">
        {entries.length ? 'Nothing matches that filter.' : 'No traffic yet. Send a request to see it here.'}
      </div>
    {:else}
      {#each shown as entry (entry.id)}
        <div class="entry {entry.kind}">
          <div
            class="entry-head"
            role="button"
            tabindex="0"
            onclick={() => toggle(entry.id)}
            onkeydown={(e) => e.key === 'Enter' && toggle(entry.id)}
          >
            <span class="time">{entry.time}</span>
            {#if entry.level}<span class="muted">{entry.level}</span>{/if}
            <span class="title">{entry.title}</span>
            <span class="meta">
              {#if entry.status}
                <span class={codeClass(entry.status)}>{entry.status}</span>
              {/if}
              {#if entry.durationMs !== undefined}{entry.durationMs} ms{/if}
              {size(entry.sizeBytes)}
              {#if entry.item}· {entry.item}{/if}
            </span>
          </div>

          {#if expanded.has(entry.id) && entry.detail}
            <div class="entry-detail">
              {#if entry.detail.requestHeaders?.length}
                <div class="label">Request headers</div>
                <pre class="wrap">{entry.detail.requestHeaders.map((h) => `${h.key}: ${h.value}`).join('\n')}</pre>
              {/if}
              {#if entry.detail.requestBody}
                <div class="label">Request body</div>
                <pre class="wrap">{entry.detail.requestBody}</pre>
              {/if}
              {#if entry.detail.responseHeaders?.length}
                <div class="label">Response headers</div>
                <pre class="wrap">{entry.detail.responseHeaders.map((h) => `${h.key}: ${h.value}`).join('\n')}</pre>
              {/if}
              {#if entry.detail.responseBody}
                <div class="label">Response body</div>
                <pre class="wrap">{entry.detail.responseBody}</pre>
              {/if}
            </div>
          {/if}
        </div>
      {/each}
    {/if}
  </div>
</div>
