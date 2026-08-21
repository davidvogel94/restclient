<script lang="ts">
  import Self from './JsonTree.svelte';
  import { renderTokens } from '../../src/shared/highlight';
  import { jsonLeafText, jsonMatches, matchTokens, type Matcher } from '../../src/shared/search';

  /**
   * Collapsible tree for a parsed response body.
   *
   * Recursive rather than flattened: response shapes are arbitrary and a
   * flattened model would have to reimplement expansion state anyway. Large
   * containers start collapsed so a 10k-element array does not build 10k rows
   * before the user asks for them.
   *
   * Given a `matcher`, the tree also prunes: only branches containing a hit
   * survive, so an ancestor path to every match stays visible and everything
   * else gets out of the way.
   */

  let {
    value,
    name = undefined,
    depth = 0,
    open = undefined,
    matcher = undefined,
    /**
     * Whether to hide non-matching children. Cleared for the subtree under a
     * key that matched: naming a key is how you ask for what is inside it, and
     * pruning that subtree would answer with nothing.
     */
    prune = true
  }: {
    value: unknown;
    name?: string | undefined;
    depth?: number;
    open?: boolean | undefined;
    matcher?: Matcher | undefined;
    prune?: boolean;
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

  const filtering = $derived(matcher !== undefined && prune);

  const visible = $derived(
    filtering
      ? children.filter(([key, child]) => jsonMatches(matcher!, child, isArray ? undefined : key))
      : children
  );

  // Top levels and small containers expand on sight; anything big waits.
  // Deliberately a one-time default: after mount, expansion is the user's.
  // svelte-ignore state_referenced_locally
  let expanded = $state(open ?? (depth < 2 && children.length <= AUTO_OPEN_LIMIT));

  /**
   * Expansion while a search is running is kept apart from the user's own, so
   * a filtered branch can open on sight without destroying the shape they had
   * arranged — clearing the box puts it straight back.
   */
  let expandedWhileFiltering = $state<boolean | undefined>(undefined);

  $effect(() => {
    // A new query is a new question: start from everything matching open.
    void matcher;
    expandedWhileFiltering = undefined;
  });

  const showChildren = $derived(filtering ? (expandedWhileFiltering ?? true) : expanded);

  function toggle() {
    if (filtering) { expandedWhileFiltering = !showChildren; }
    else { expanded = !expanded; }
  }

  const summary = $derived.by(() => {
    const total = children.length;
    const noun = isArray
      ? `item${total === 1 ? '' : 's'}`
      : `key${total === 1 ? '' : 's'}`;
    const shape = isArray ? '[]' : '{}';
    // While filtering, say what is on screen as well as what is in the data.
    return filtering && visible.length !== total
      ? `${shape} ${visible.length} of ${total} ${noun}`
      : `${shape} ${total} ${noun}`;
  });

  function leafClass(v: unknown): string {
    if (typeof v === 'string') { return 'tok-str'; }
    if (typeof v === 'number') { return 'tok-num'; }
    if (typeof v === 'boolean' || v === null) { return 'tok-lit'; }
    return '';
  }

  /** Escaped either way; with a search running, its hits are marked. */
  const shown = (text: string) => renderTokens(text, matchTokens(text, matcher));
</script>

<div class="jt-row" style="--jt-depth: {depth}">
  {#if branch}
    <button class="jt-twisty" aria-expanded={showChildren} onclick={toggle}>
      <span class="codicon codicon-chevron-{showChildren ? 'down' : 'right'}"></span>
      {#if name !== undefined}<span class="jt-key">{@html shown(name)}</span>{/if}
      <span class="jt-summary">{summary}</span>
    </button>
  {:else}
    <div class="jt-leaf">
      {#if name !== undefined}<span class="jt-key">{@html shown(name)}</span>{/if}
      <span class={leafClass(value)}>{@html shown(jsonLeafText(value))}</span>
    </div>
  {/if}
</div>

{#if branch && showChildren}
  {#each visible as [childName, childValue] (childName)}
    <Self
      value={childValue}
      name={childName}
      depth={depth + 1}
      {matcher}
      prune={prune && !(!isArray && matcher !== undefined && matcher.test(childName))}
    />
  {/each}
{/if}
