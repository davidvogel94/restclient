<script lang="ts">
  import type { KeyValue } from '../../src/panels/protocol';
  import { renderTokens, variableTokens } from '../../src/shared/highlight';
  import HighlightedField from '../shared/HighlightedField.svelte';
  import type { Resolver, VarHover } from '../shared/vars';

  let {
    rows = [],
    empty = 'Nothing here.',
    editable = false,
    /** Adds a text/file toggle per row, for form-data bodies. */
    fileToggle = false,
    /** Supplied so `{{variables}}` in keys and values colour by resolution. */
    resolver = undefined,
    onchange = (_rows: KeyValue[]) => {},
    onfocuschange = (_focused: boolean) => {},
    onvar = (_hit: VarHover | undefined) => {}
  }: {
    rows: KeyValue[];
    empty?: string;
    editable?: boolean;
    fileToggle?: boolean;
    resolver?: Resolver | undefined;
    onchange?: (rows: KeyValue[]) => void;
    onfocuschange?: (focused: boolean) => void;
    onvar?: (hit: VarHover | undefined) => void;
  } = $props();

  /** Read-only cells still show variables, they just cannot be typed in. */
  const shown = (text: string) => renderTokens(text, variableTokens(text, resolver?.classify));

  // Local working copy plus one trailing blank row to type into.
  let draft = $state<KeyValue[]>([]);
  let lastSerialized = $state('');

  $effect(() => {
    const incoming = JSON.stringify(rows);
    // Only reset the draft when the upstream data genuinely changed, otherwise
    // every re-render would wipe a half-typed row.
    if (incoming !== lastSerialized) {
      lastSerialized = incoming;
      draft = [...rows.map((r) => ({ ...r }))];
    }
  });

  const display = $derived(editable ? [...draft, { key: '', value: '' } as KeyValue] : draft);

  function commit() {
    const cleaned = draft.filter((r) => r.key.trim() || r.value.trim());
    lastSerialized = JSON.stringify(cleaned);
    onchange(cleaned);
  }

  function edit(index: number, patch: Partial<KeyValue>) {
    if (index === draft.length) {
      // Typing in the trailing blank row materialises it.
      draft = [...draft, { key: '', value: '', ...patch }];
      return;
    }
    draft = draft.map((r, i) => (i === index ? { ...r, ...patch } : r));
  }

  function remove(index: number) {
    draft = draft.filter((_, i) => i !== index);
    commit();
  }
</script>

{#if display.length && (editable || rows.length)}
  <table>
    <thead>
      <tr>
        {#if editable}<th class="tick"></th>{/if}
        <th>Key</th>
        <th>Value</th>
        {#if fileToggle}<th class="tick">File</th>{/if}
        {#if editable}<th class="tick"></th>{/if}
      </tr>
    </thead>
    <tbody>
      {#each display as row, i (i)}
        <tr class:off={row.disabled}>
          {#if editable}
            <td class="tick">
              {#if i < draft.length}
                <input
                  type="checkbox"
                  checked={!row.disabled}
                  title={row.disabled ? 'Disabled' : 'Enabled'}
                  onchange={(e) => {
                    edit(i, { disabled: !(e.currentTarget as HTMLInputElement).checked });
                    commit();
                  }}
                />
              {/if}
            </td>
          {/if}

          <td class="k">
            {#if editable}
              <HighlightedField
                fieldClass="cell"
                value={row.key}
                {resolver}
                {onvar}
                placeholder={i === draft.length ? 'new key' : ''}
                oninput={(v) => edit(i, { key: v })}
                onfocuschange={(focused) => { onfocuschange(focused); if (!focused) { commit(); } }}
              />
            {:else}
              {@html shown(row.key)}
            {/if}
          </td>

          <td>
            {#if editable}
              <HighlightedField
                fieldClass="cell"
                value={row.value}
                {resolver}
                {onvar}
                oninput={(v) => edit(i, { value: v })}
                onfocuschange={(focused) => { onfocuschange(focused); if (!focused) { commit(); } }}
              />
            {:else}
              {@html shown(row.value)}
              {#if row.description}<div class="muted">{row.description}</div>{/if}
            {/if}
          </td>

          {#if fileToggle}
            <td class="tick">
              {#if i < draft.length}
                <input
                  type="checkbox"
                  checked={row.description === 'file'}
                  title="Send this field as a file path"
                  onchange={(e) => {
                    edit(i, { description: (e.currentTarget as HTMLInputElement).checked ? 'file' : undefined });
                    commit();
                  }}
                />
              {/if}
            </td>
          {/if}

          {#if editable}
            <td class="tick">
              {#if i < draft.length}
                <button class="icon" title="Remove row" onclick={() => remove(i)}>
                  <span class="codicon codicon-trash"></span>
                </button>
              {/if}
            </td>
          {/if}
        </tr>
      {/each}
    </tbody>
  </table>
{:else}
  <div class="empty">{empty}</div>
{/if}
