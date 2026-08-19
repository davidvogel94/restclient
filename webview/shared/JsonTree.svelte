<script lang="ts">
  import Self from './JsonTree.svelte';

  /**
   * Collapsible tree for a parsed response body.
   *
   * Recursive rather than flattened: response shapes are arbitrary and a
   * flattened model would have to reimplement expansion state anyway. Large
   * containers start collapsed so a 10k-element array does not build 10k rows
   * before the user asks for them.
   */

  let {
    value,
    name = undefined,
    depth = 0,
    open = undefined
  }: {
    value: unknown;
    name?: string | undefined;
    depth?: number;
    open?: boolean | undefined;
  } = $props();

  const AUTO_OPEN_LIMIT = 100;

  const isArray = $derived(Array.isArray(value));
  const isObject = $derived(value !== null && typeof value === 'object' && !isArray);
  const branch = $derived(isArray || isObject);

  const children = $derived<Array<[string, unknown]>>(
    isArray
      ? (value as unknown[]).map((v, i) => [String(i), v])
      : isObject
        ? Object.entries(value as Record<string, unknown>)
        : []
  );

  // Top levels and small containers expand on sight; anything big waits.
  // Deliberately a one-time default: after mount, expansion is the user's.
  // svelte-ignore state_referenced_locally
  let expanded = $state(open ?? (depth < 2 && children.length <= AUTO_OPEN_LIMIT));

  const summary = $derived(
    isArray
      ? `[] ${children.length} item${children.length === 1 ? '' : 's'}`
      : `{} ${children.length} key${children.length === 1 ? '' : 's'}`
  );

  function leafClass(v: unknown): string {
    if (typeof v === 'string') { return 'tok-str'; }
    if (typeof v === 'number') { return 'tok-num'; }
    if (typeof v === 'boolean' || v === null) { return 'tok-lit'; }
    return '';
  }

  function leafText(v: unknown): string {
    if (typeof v === 'string') { return `"${v}"`; }
    if (v === null) { return 'null'; }
    if (v === undefined) { return 'undefined'; }
    return String(v);
  }
</script>

<div class="jt-row" style="--jt-depth: {depth}">
  {#if branch}
    <button
      class="jt-twisty"
      aria-expanded={expanded}
      onclick={() => (expanded = !expanded)}
    >
      <span class="codicon codicon-chevron-{expanded ? 'down' : 'right'}"></span>
      {#if name !== undefined}<span class="jt-key">{name}</span>{/if}
      <span class="jt-summary">{summary}</span>
    </button>
  {:else}
    <div class="jt-leaf">
      {#if name !== undefined}<span class="jt-key">{name}</span>{/if}
      <span class={leafClass(value)}>{leafText(value)}</span>
    </div>
  {/if}
</div>

{#if branch && expanded}
  {#each children as [childName, childValue] (childName)}
    <Self value={childValue} name={childName} depth={depth + 1} />
  {/each}
{/if}
