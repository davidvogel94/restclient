<script lang="ts">
  import type { KeyValue } from '../../src/panels/protocol';
  import { mergeTokens, renderTokens, variableTokens } from '../../src/shared/highlight';
  import { matchTokens, type Matcher } from '../../src/shared/search';
  import HighlightedField from '../shared/HighlightedField.svelte';
  import type { Resolver, VarHover } from '../shared/vars';

  let {
    rows = [],
    empty = 'Nothing here.',
    editable = false,
    /** Adds a text/file toggle per row, for form-data bodies. */
    fileToggle = false,
    /** Opens the host's file dialog, for rows marked as files. */
    pickFile = undefined,
    /** Supplied so `{{variables}}` in keys and values colour by resolution. */
    resolver = undefined,
    /** A search: read-only rows are narrowed to matches, and the hits marked. */
    matcher = undefined,
    onchange = (_rows: KeyValue[]) => {},
    onfocuschange = (_focused: boolean) => {},
    onvar = (_hit: VarHover | undefined) => {}
  }: {
    rows: KeyValue[];
    empty?: string;
    editable?: boolean;
    fileToggle?: boolean;
    pickFile?: (() => Promise<string | undefined>) | undefined;
    resolver?: Resolver | undefined;
    matcher?: Matcher | undefined;
    onchange?: (rows: KeyValue[]) => void;
    onfocuschange?: (focused: boolean) => void;
    onvar?: (hit: VarHover | undefined) => void;
  } = $props();

  /** Read-only cells still show variables, they just cannot be typed in. */
  const shown = (text: string) =>
    renderTokens(
      text,
      mergeTokens(variableTokens(text, resolver?.classify), matchTokens(text, matcher))
    );

  // Local working copy plus one trailing blank row to type into.
  let draft = $state<KeyValue[]>([]);
  // Which upstream value the draft was taken from. Deliberately not reactive:
  // `commit` writes it, and if the effect below read it as state that write
  // would re-run the effect against the not-yet-updated `rows` prop and reset
  // the draft — undoing the edit that was just committed.
  let lastSerialized = '';

  $effect(() => {
    const incoming = JSON.stringify(rows);
    // Only reset the draft when the upstream data genuinely changed, otherwise
    // every re-render would wipe a half-typed row.
    if (incoming !== lastSerialized) {
      lastSerialized = incoming;
      draft = [...rows.map((r) => ({ ...r }))];
    }
  });

  /**
   * An editable table is never filtered: hiding a row someone is about to edit
   * — or the blank one they type new rows into — would be a trap. Search only
   * narrows the read-only tables, which is where a response lands.
   */
  const display = $derived.by(() => {
    if (editable) { return [...draft, { key: '', value: '' } as KeyValue]; }
    const search = matcher;
    return search ? draft.filter((r) => search.test(r.key, r.value, r.description)) : draft;
  });

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

  /** Fill a file row's value from the host's file dialog. */
  async function browse(index: number) {
    const picked = await pickFile?.();
    if (picked === undefined) { return; }
    edit(index, { value: picked });
    commit();
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
              <div class="valuecell">
                <HighlightedField
                  fieldClass="cell"
                  value={row.value}
                  {resolver}
                  {onvar}
                  placeholder={fileToggle && row.description === 'file' ? 'path relative to the workspace' : ''}
                  oninput={(v) => edit(i, { value: v })}
                  onfocuschange={(focused) => { onfocuschange(focused); if (!focused) { commit(); } }}
                />
                {#if pickFile && fileToggle && row.description === 'file' && i < draft.length}
                  <button class="icon" title="Browse for a file" onclick={() => browse(i)}>
                    <span class="codicon codicon-folder-opened"></span>
                  </button>
                {/if}
              </div>
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
  <div class="empty">
    {matcher && rows.length ? `Nothing here matches “${matcher.text}”.` : empty}
  </div>
{/if}
