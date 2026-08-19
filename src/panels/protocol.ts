import type { SerializedAssertion, SerializedRequest, SerializedResponse } from '../runner/protocol';
import type { RequestUpdate } from '../collections/edits';

export interface KeyValue {
  key: string;
  value: string;
  disabled?: boolean;
  description?: string;
}

/** Everything the request editor needs to render one item, already flattened. */
export interface RequestView {
  collectionName: string;
  itemId: string;
  name: string;
  path: string[];
  method: string;
  url: string;
  query: KeyValue[];
  pathVariables: KeyValue[];
  headers: KeyValue[];
  auth: { type: string; params: KeyValue[]; inheritedFrom?: string };
  body: { mode: string; text?: string; language?: string; entries?: KeyValue[] };
  scripts: { prerequest?: string; test?: string };
  /** Scripts defined on parent folders/collection that also run for this item. */
  inheritedScripts: Array<{ from: string; listen: string; source: string }>;
}

export interface EnvironmentSummary {
  id: string;
  name: string;
  active: boolean;
  variables: Array<{
    key: string;
    value: string;
    type: string;
    enabled: boolean;
    secret: boolean;
    /** Whether the OS keychain holds a value for this secret. */
    hasStoredSecret: boolean;
    /** A `secret` still sitting in the file as plaintext, offered for moving. */
    plaintextInFile: boolean;
  }>;
}

export interface ConsoleLine {
  level: string;
  message: string;
}

/** Extension host -> webview. */
export type ToWebview =
  | {
      type: 'init';
      request: RequestView;
      environments: EnvironmentSummary[];
      /** Collection-level `variable[]`, so `{{collectionVar}}` resolves too. */
      collectionVariables: KeyValue[];
      scriptsAllowed: boolean;
      authTypes: readonly string[];
      authFields: Record<string, string[]>;
    }
  | { type: 'saved' }
  | { type: 'saveFailed'; message: string }
  | { type: 'environments'; environments: EnvironmentSummary[] }
  | { type: 'runStarted' }
  | { type: 'sent'; request: SerializedRequest }
  | { type: 'response'; request: SerializedRequest; response: SerializedResponse }
  | { type: 'assertions'; assertions: SerializedAssertion[] }
  | { type: 'console'; lines: ConsoleLine[] }
  | { type: 'visualizer'; html: string }
  | { type: 'runFailed'; message: string }
  | { type: 'runFinished' };

/** Webview -> extension host. */
export type FromWebview =
  | { type: 'ready' }
  | { type: 'send' }
  | { type: 'cancel' }
  /** `''` clears the selection; `undefined` is not sent, it would reopen the picker. */
  | { type: 'selectEnvironment'; environmentId: string }
  | { type: 'update'; update: RequestUpdate }
  | { type: 'setVariable'; scope: 'environment' | 'collection'; key: string; value: string }
  | { type: 'moveSecretToKeychain'; key: string }
  | { type: 'editEnvironment' }
  | { type: 'manageCookies' }
  | { type: 'revealInFile' };
