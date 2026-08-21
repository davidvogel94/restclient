<script lang="ts">
  import {
    REQUEST_SETTINGS,
    SETTING_GROUPS,
    isEmptySetting,
    type RequestSettingSpec,
    type SettingValue
  } from '../../src/collections/settings';
  import type { SettingsView } from '../../src/panels/protocol';

  interface Props {
    settings: SettingsView;
    /** What each key falls back to when nothing in the collection sets it. */
    defaults: Record<string, SettingValue>;
    /** Name of the collection, for wording the "in force from" note. */
    collectionName: string;
    onfocuschange: (focused: boolean) => void;
    /** `undefined` unsets the key, handing the request back to its inheritance. */
    onset: (key: string, value: SettingValue | undefined) => void;
  }

  const { settings, defaults, collectionName, onfocuschange, onset }: Props = $props();

  /**
   * The value that will actually be used: this request's, else the nearest
   * container's, else the workspace setting or the engine's own default.
   */
  function effective(spec: RequestSettingSpec): SettingValue {
    if (spec.key in settings.own) { return settings.own[spec.key]; }
    if (spec.key in settings.inherited) { return settings.inherited[spec.key]; }
    return defaults[spec.key] ?? spec.builtin;
  }

  /** Where that value came from — the one thing a plain toggle cannot show. */
  function origin(spec: RequestSettingSpec): { kind: 'own' | 'inherited' | 'default'; from?: string } {
    if (spec.key in settings.own) { return { kind: 'own' }; }
    if (spec.key in settings.inherited) {
      return { kind: 'inherited', from: settings.inheritedFrom[spec.key] };
    }
    return { kind: 'default' };
  }

  const bool = (spec: RequestSettingSpec) => effective(spec) === true;
  /** What the label claims, once Postman's positive wording is accounted for. */
  const shown = (spec: RequestSettingSpec) => (spec.inverted ? !bool(spec) : bool(spec));
  const num = (spec: RequestSettingSpec) => {
    const value = effective(spec);
    return typeof value === 'number' ? value : 0;
  };
  const list = (spec: RequestSettingSpec) => {
    const value = effective(spec);
    return Array.isArray(value) ? value : [];
  };
  const headers = (spec: RequestSettingSpec) => {
    const value = effective(spec);
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, boolean>)
      : {};
  };

  function setBool(spec: RequestSettingSpec, checked: boolean) {
    onset(spec.key, spec.inverted ? !checked : checked);
  }

  /**
   * Write a list- or set-shaped value, deciding what an emptied control means.
   *
   * Normally nothing left means "back to default", so the key is dropped and
   * the file keeps no inert `[]`. But if a folder or the collection disables
   * something, dropping the key hands the request straight back to it — so
   * there the empty value is written, as the override it is.
   */
  function commit(spec: RequestSettingSpec, next: SettingValue) {
    const shadowing = spec.key in settings.inherited;
    onset(spec.key, isEmptySetting(next) && !shadowing ? undefined : next);
  }

  /** Tick means "send it", so the stored set is the untickeds. */
  function toggleHeader(spec: RequestSettingSpec, name: string, send: boolean) {
    const next = { ...headers(spec) };
    if (send) { delete next[name]; } else { next[name] = true; }
    commit(spec, next);
  }

  function toggleProtocol(spec: RequestSettingSpec, name: string, disabled: boolean) {
    const current = list(spec);
    const next = disabled ? [...current, name] : current.filter((p) => p !== name);
    // Keep the catalogue's order rather than click order, so the file is stable.
    commit(spec, (spec.options ?? []).filter((o) => next.includes(o)));
  }

  const ownCount = $derived(Object.keys(settings.own).length);
  const inheritedCount = $derived(Object.keys(settings.inherited).length);
</script>

<div class="settings">
  <p class="lead">
    Postman's per-request settings, stored as <code>protocolProfileBehavior</code> on the item.
    A setting left alone falls through to the folder, then to {collectionName}, then to your
    workspace settings — so only what you change here is written to the file.
  </p>

  {#if ownCount || inheritedCount}
    <p class="lead muted">
      {ownCount} set on this request{inheritedCount ? `, ${inheritedCount} inherited` : ''}.
    </p>
  {/if}

  {#each SETTING_GROUPS as group}
    <div class="section-title">{group.title}</div>

    {#each REQUEST_SETTINGS.filter((s) => s.group === group.id) as spec (spec.key)}
      {@const source = origin(spec)}
      <div class="setting" class:own={source.kind === 'own'}>
        <div class="setting-head">
          {#if spec.kind === 'boolean'}
            <label class="inline">
              <input
                type="checkbox"
                checked={shown(spec)}
                onchange={(e) => setBool(spec, (e.currentTarget as HTMLInputElement).checked)}
              />
              <span>{spec.label}</span>
            </label>
          {:else}
            <span class="setting-label">{spec.label}</span>
          {/if}

          <span class="spacer"></span>

          {#if source.kind === 'own'}
            <span class="badge">set here</span>
            <button
              class="icon"
              title="Clear this setting and go back to what the folder, the collection or your workspace settings say"
              onclick={() => onset(spec.key, undefined)}
            >
              <span class="codicon codicon-discard"></span>
            </button>
          {:else if source.kind === 'inherited'}
            <span class="badge inherited">from {source.from}</span>
          {:else}
            <span class="badge muted">default</span>
          {/if}
        </div>

        {#if spec.kind === 'number'}
          <input
            class="cell narrow"
            type="number"
            min="0"
            value={num(spec)}
            onfocus={() => onfocuschange(true)}
            onblur={() => onfocuschange(false)}
            onchange={(e) => {
              // A cleared field means "back to default" — writing 0 would
              // silently forbid redirects entirely.
              const raw = (e.currentTarget as HTMLInputElement).value.trim();
              onset(spec.key, raw === '' ? undefined : Math.max(0, Math.floor(Number(raw))));
            }}
          />
        {:else if spec.kind === 'enum'}
          <select
            value={String(effective(spec))}
            onchange={(e) => onset(spec.key, (e.currentTarget as HTMLSelectElement).value)}
          >
            {#each spec.options ?? [] as option}<option value={option}>{option}</option>{/each}
          </select>
        {:else if spec.kind === 'headers'}
          {@const disabled = headers(spec)}
          <div class="grid">
            {#each spec.options ?? [] as name}
              <label class="inline">
                <input
                  type="checkbox"
                  checked={!disabled[name]}
                  onchange={(e) =>
                    toggleHeader(spec, name, (e.currentTarget as HTMLInputElement).checked)}
                />
                <code>{name}</code>
              </label>
            {/each}
          </div>
        {:else if spec.kind === 'protocols'}
          {@const off = list(spec)}
          <div class="grid">
            {#each spec.options ?? [] as name}
              <label class="inline">
                <input
                  type="checkbox"
                  checked={off.includes(name)}
                  onchange={(e) =>
                    toggleProtocol(spec, name, (e.currentTarget as HTMLInputElement).checked)}
                />
                <code>{name.replace(/_/g, '.')}</code>
              </label>
            {/each}
          </div>
        {:else if spec.kind === 'ciphers'}
          <textarea
            class="code short"
            spellcheck="false"
            placeholder="ECDHE-RSA-AES128-GCM-SHA256"
            value={list(spec).join('\n')}
            onfocus={() => onfocuschange(true)}
            onblur={(e) => {
              onfocuschange(false);
              commit(
                spec,
                (e.currentTarget as HTMLTextAreaElement).value
                  .split('\n')
                  .map((line) => line.trim())
                  .filter(Boolean)
              );
            }}
          ></textarea>
        {/if}

        <div class="help">{spec.help}</div>
      </div>
    {/each}
  {/each}
</div>
