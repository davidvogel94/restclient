import type { EnvironmentSummary, KeyValue } from '../../src/panels/protocol';
import type { TokenClass } from '../../src/shared/highlight';

/**
 * Resolving `{{name}}` the way the runner will.
 *
 * Only the two scopes the webview knows about are modelled. postman-runtime's
 * full order (postman-runtime/lib/runner/util.js:139-149) is
 * local -> iteration data -> environment -> collection -> globals -> vault;
 * locals and iteration data only exist during a run, and globals are never
 * populated by this extension, so environment-then-collection is the whole of
 * what can be shown before sending.
 */

export type VarScope = 'environment' | 'collection' | 'dynamic' | 'unresolved';

/** A `{{variable}}` token the pointer is over, and where it sits on screen. */
export interface VarHover {
  name: string;
  rect: DOMRect;
}

export interface VarInfo {
  name: string;
  scope: VarScope;
  /** Empty for secrets — their value only exists in the OS keychain. */
  value: string;
  secret: boolean;
  hasStoredSecret: boolean;
  /** A secret still sitting in the environment file as plaintext. */
  plaintextInFile: boolean;
  /** Name of the environment it resolved in, for the popover heading. */
  environmentName?: string;
  /** False when the variable exists but is unticked, so it will not resolve. */
  enabled: boolean;
}

export interface Resolver {
  lookup(name: string): VarInfo;
  classify(name: string): TokenClass;
  /** The environment an edit would be written to, if any. */
  activeEnvironment?: EnvironmentSummary;
}

const CLASS_FOR: Record<VarScope, TokenClass> = {
  environment: 'var-ok',
  collection: 'var-ok',
  dynamic: 'var-dynamic',
  unresolved: 'var-missing'
};

export function buildResolver(
  environments: EnvironmentSummary[],
  collectionVariables: KeyValue[]
): Resolver {
  const active = environments.find((e) => e.active);
  const envVars = new Map((active?.variables ?? []).map((v) => [v.key, v]));
  const collectionVars = new Map(
    collectionVariables.filter((v) => !v.disabled).map((v) => [v.key, v])
  );

  const lookup = (name: string): VarInfo => {
    const base = {
      name,
      value: '',
      secret: false,
      hasStoredSecret: false,
      plaintextInFile: false,
      enabled: true
    };

    // Postman generates these per request; they are never "missing".
    if (name.startsWith('$')) { return { ...base, scope: 'dynamic' }; }

    const fromEnv = envVars.get(name);
    if (fromEnv) {
      return {
        ...base,
        scope: 'environment',
        value: fromEnv.value,
        secret: fromEnv.secret,
        hasStoredSecret: fromEnv.hasStoredSecret,
        plaintextInFile: fromEnv.plaintextInFile,
        environmentName: active?.name,
        enabled: fromEnv.enabled
      };
    }

    const fromCollection = collectionVars.get(name);
    if (fromCollection) {
      return { ...base, scope: 'collection', value: fromCollection.value };
    }

    return { ...base, scope: 'unresolved' };
  };

  return {
    lookup,
    classify: (name) => {
      const info = lookup(name);
      // A disabled variable does not resolve at send time, so flag it like a
      // missing one rather than pretending it is set.
      if (!info.enabled) { return 'var-missing'; }
      if (info.scope === 'environment' && info.secret) { return 'var-secret'; }
      return CLASS_FOR[info.scope];
    },
    activeEnvironment: active
  };
}
