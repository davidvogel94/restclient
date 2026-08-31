import type { SerializedAssertion, SerializedRequest, SerializedResponse } from '../runner/protocol';
import type { SaveResponseKind } from './saveResponse';
import type { RequestUpdate } from '../collections/edits';
import type { SettingValue } from '../collections/settings';

export interface KeyValue {
  key: string;
  value: string;
  disabled?: boolean;
  description?: string;
}

/**
 * `protocolProfileBehavior`, split by where each key came from.
 *
 * Postman resolves these up the tree key by key, so a request can be silent on
 * a setting and still be governed by one — which the editor has to show without
 * pretending the request set it.
 */
export interface SettingsView {
  /** Set on this item itself. */
  own: Record<string, SettingValue>;
  /** In force from a folder or the collection, this item being silent. */
  inherited: Record<string, SettingValue>;
  /** Which container each inherited key came from. */
  inheritedFrom: Record<string, string>;
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
  settings: SettingsView;
}

/**
 * Which part of a response the editor was last left showing.
 *
 * Remembered across sends and across reopening an editor, because it describes
 * how this user likes to read a response rather than anything about one
 * request — someone who works in the raw body, or who always checks Tests
 * first, should not have to say so again on every send.
 */
export interface ResponseViewState {
  /** Response tab: `body`, `headers`, `cookies`, `tests`, `console` or `sent`. */
  tab: string;
  /** How the body is rendered: `pretty`, `raw`, `preview` or `tree`. */
  view: string;
  /** Whether long lines are wrapped. */
  wrap: boolean;
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
      /**
       * What each request setting falls back to when nothing in the collection
       * sets it — a `restclient.*` setting for some, the engine's own default
       * for the rest. The editor shows this as the value in force so an
       * untouched toggle is never blank or misleadingly off.
       */
      settingDefaults: Record<string, SettingValue>;
      /** The response tab and body view this editor should open on. */
      responseView: ResponseViewState;
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
  | { type: 'runFinished' }
  /** Answer to `pickFile`; `path` is absent when the dialog was cancelled. */
  | { type: 'filePicked'; token: string; path?: string };

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
  /** Open the host's file dialog for a file body or form-data file field. */
  | { type: 'pickFile'; token: string }
  | { type: 'editEnvironment' }
  /** Write the response on screen out to a file the host asks the user for. */
  | { type: 'saveResponse'; kind: SaveResponseKind }
  /** Remember the response tab and body view now on screen, for next time. */
  | { type: 'responseView'; state: ResponseViewState }
  | { type: 'manageCookies' }
  | { type: 'revealInFile' };
