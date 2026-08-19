<script lang="ts">
  import type {
    EnvVariableView,
    FromEnvWebview,
    ToEnvWebview
  } from '../../src/panels/environmentPanel';
  import HighlightedField from '../shared/HighlightedField.svelte';
  import { buildResolver } from '../shared/vars';

  declare function acquireVsCodeApi(): { postMessage(msg: unknown): void };
  const vscode = acquireVsCodeApi();
  const post = (msg: FromEnvWebview) => vscode.postMessage(msg);

  interface Row extends EnvVariableView {
    /** Undefined means "secret unchanged"; the stored value is kept. */
    pendingSecret?: string;
  }

  let name = $state('');
  let file = $state('');
  let rows = $state<Row[]>([]);
  let saveError = $state<string | undefined>(undefined);
  let dirty = $state(false);

  /**
   * A value may reference another variable in the same environment, so colour
   * `{{name}}` against this environment's own rows.
   */
  const resolver = $derived(
    buildResolver(
      [{
        id: '',
        name,
        active: true,
        variables: rows.map((r) => ({
          key: r.key,
          value: r.value,
          type: r.type,
          enabled: r.enabled,
          secret: r.type === 'secret',
          hasStoredSecret: r.hasStoredSecret
        }))
      }],
      []
    )
  );

  const display = $derived([
    ...rows,
    { key: '', value: '', type: 'default', enabled: true, hasStoredSecret: false, plaintextInFile: false } as Row
  ]);

  function edit(index: number, patch: Partial<Row>) {
    dirty = true;
    if (index === rows.length) {
      rows = [...rows, { key: '', value: '', type: 'default', enabled: true, hasStoredSecret: false, plaintextInFile: false, ...patch }];
      return;
    }
    rows = rows.map((r, i) => (i === index ? { ...r, ...patch } : r));
  }

  function remove(index: number) {
    rows = rows.filter((_, i) => i !== index);
    dirty = true;
    save();
  }

  function save() {
    post({
      type: 'save',
      variables: rows
        .filter((r) => r.key.trim())
        .map((r) => ({
          key: r.key.trim(),
          // A secret only carries a value when the user typed a new one.
          value: r.type === 'secret' ? r.pendingSecret : r.value,
          type: r.type,
          enabled: r.enabled
        }))
    });
    dirty = false;
  }

  window.addEventListener('message', (event: MessageEvent<ToEnvWebview>) => {
    const msg = event.data;
    switch (msg.type) {
      case 'init':
        name = msg.name;
        file = msg.file;
        // Never clobber unsaved edits with a reload echo.
        if (!dirty) { rows = msg.variables.map((v) => ({ ...v })); }
        break;
      case 'saved':
        saveError = undefined;
        break;
      case 'saveFailed':
        saveError = msg.message;
        break;
    }
  });

  post({ type: 'ready' });
</script>

<div class="layout">
  <div class="crumbs">
    <span>{name}</span>
    <span class="sep">›</span>
    <span class="muted">{file}</span>
    <button class="icon" title="Open the environment JSON" onclick={() => post({ type: 'revealInFile' })}>
      <span class="codicon codicon-json"></span>
    </button>
  </div>

  {#if saveError}
    <div class="banner error">Could not save: {saveError}</div>
  {/if}

  <div class="banner">
    This file is edited in place. Values marked <strong>secret</strong> can be moved into your OS
    keychain so they are not committed — the file keeps the key and an empty value.
  </div>

  <div class="pane">
    <table>
      <thead>
        <tr>
          <th class="tick"></th>
          <th>Variable</th>
          <th>Value</th>
          <th class="tick">Secret</th>
          <th class="tick"></th>
        </tr>
      </thead>
      <tbody>
        {#each display as row, i (i)}
          <tr class:off={!row.enabled}>
            <td class="tick">
              {#if i < rows.length}
                <input
                  type="checkbox"
                  checked={row.enabled}
                  title={row.enabled ? 'Enabled' : 'Disabled'}
                  onchange={(e) => {
                    edit(i, { enabled: (e.currentTarget as HTMLInputElement).checked });
                    save();
                  }}
                />
              {/if}
            </td>

            <td class="k">
              <input
                class="cell"
                value={row.key}
                placeholder={i === rows.length ? 'new variable' : ''}
                oninput={(e) => edit(i, { key: (e.currentTarget as HTMLInputElement).value })}
                onblur={() => dirty && save()}
              />
            </td>

            <td>
              {#if row.type === 'secret'}
                <input
                  class="cell"
                  type="password"
                  placeholder={row.hasStoredSecret
                    ? '•••••••• (in keychain — type to replace)'
                    : row.plaintextInFile
                      ? '•••••••• (plaintext in this file)'
                      : 'enter a secret value'}
                  oninput={(e) => edit(i, { pendingSecret: (e.currentTarget as HTMLInputElement).value })}
                  onblur={() => dirty && save()}
                />
                {#if row.plaintextInFile}
                  <button
                    class="link warn"
                    title="Move this value into the OS keychain and blank it in the file"
                    onclick={() => post({ type: 'moveSecret', key: row.key })}
                  >⚠ plaintext in this file — move to keychain</button>
                {/if}
              {:else}
                <HighlightedField
                  fieldClass="cell"
                  value={row.value}
                  {resolver}
                  oninput={(v) => edit(i, { value: v })}
                  onfocuschange={(focused) => { if (!focused && dirty) { save(); } }}
                />
              {/if}
            </td>

            <td class="tick">
              {#if i < rows.length}
                <input
                  type="checkbox"
                  checked={row.type === 'secret'}
                  title="Store this value in the OS keychain"
                  onchange={(e) => {
                    const secret = (e.currentTarget as HTMLInputElement).checked;
                    edit(i, secret
                      ? { type: 'secret', pendingSecret: row.value, value: '' }
                      : { type: 'default', pendingSecret: undefined });
                    save();
                  }}
                />
              {/if}
            </td>

            <td class="tick">
              {#if i < rows.length}
                <button class="icon" title="Remove variable" onclick={() => remove(i)}>
                  <span class="codicon codicon-trash"></span>
                </button>
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
</div>
