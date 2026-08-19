# REST Client

A Postman-compatible REST client for VS Code. It works directly on your Postman collections and environments **in place, without modification** and runs them locally — including `pm.*` pre-request and test scripts.

It does this by embedding Postman's own open-source engine (`postman-runtime`, `postman-sandbox`, `postman-collection`) rather than translating scripts into a different dialect. `pm.test`, `pm.expect`, `pm.environment.set`, `pm.sendRequest`, `pm.collectionVariables`, the bundled script library (chai, lodash, moment, cheerio, ajv, xml2js, crypto-js…) and all 13 auth types behave exactly as they do in Postman.

No account. No login. No cloud.

## How it differs from the alternatives

| | Postman scripts | Offline | Free |
|---|---|---|---|
| **This extension** | real `pm.*` | yes | yes |
| Postman for VS Code | real `pm.*` | **no — requires sign-in** | yes |
| Thunder Client | own `tc.*` dialect | yes | **scripting is paid** |
| Bruno | regex-translated `pm.*` (lossy) | yes | yes |
| REST Client / httpYac | none | yes | yes |

## Where things live

**Nothing is copied.** Collections and environments are edited where you already keep them — anywhere in the workspace, or outside it. The list of files this workspace works on lives in your settings, so it commits with the repo and your teammates get the same set:

```jsonc
// .vscode/settings.json
{
  "restclient.collections": ["api/orders.postman_collection.json"],
  "restclient.environments": ["api/local.postman_environment.json", "~/Postman/shared.postman_environment.json"]
}
```

Paths are workspace-relative where possible; absolute and `~/`-prefixed paths work too. Adding a file through the UI appends to these lists, and *Stop Working on This Collection* removes it — the file itself is never moved or deleted.

### Secrets

Postman marks sensitive variables `"type": "secret"` but still exports them in plaintext. Because your file is yours, adding it changes nothing: the plaintext value is read and used as-is, and flagged in the UI. Choosing **move to keychain** — from the Environments view, the environment editor or the inline variable popover — puts the value in VS Code's `SecretStorage` (your OS keychain) and blanks it in the JSON, so the file becomes safe to commit. Values you type into a secret field always go to the keychain, never to the file.

### Responses

Responses are held **in memory only**, for as long as the window is open. Closing and reopening a request editor keeps the last response; nothing is written to disk, workspace state or global storage. `REST Client: Clear Cached Responses` drops them immediately.

## Usage

1. **Add a collection** — the `$(add)` button in the Collections view, the command palette (`REST Client: Add Postman Collection or Environment`), the Explorer context menu on a `*.postman_collection.json`, or drag the file onto the Collections view. Collection formats v1 and v2.0 need converting to v2.1 before they can be edited; you are asked first, since that rewrites your file.
2. **Manage environments** — the **Environments** view in the REST Client sidebar lists every environment with its variables inline. Click one to make it active (click it again to run with no environment). Expand it to see each variable's value, whether it is disabled, and whether a secret is in the keychain or still sitting in the file. From there you can add, edit, enable/disable, delete and promote a variable to a secret without opening anything. `New Environment` creates one from scratch; the globe in the status bar still switches between them.
3. **Send** — click a request in the tree, then press Send.
4. **Edit** — the request editor is live: method, URL, query and path params, headers, all 13 auth types, every body mode (raw, GraphQL, url-encoded, form-data, binary) and both scripts. Changes are written back into the collection JSON as surgical, format-preserving edits, so a diff shows only what you actually changed.
5. **Organise** — right-click the tree to add, rename, duplicate or delete requests and folders, or drag to reorder. For a full-page editor over an environment's variables, use `REST Client: Edit Environment` or the pencil on an environment row.

Responses show body, headers, cookies, test results, script console output and the exact request as sent. The body has three views:

- **Pretty** — re-indented and broken across lines (JSON and XML), then syntax highlighted.
- **Raw** — exactly the bytes that came back, unformatted.
- **Tree** — a collapsible tree of the parsed JSON, for finding one field in a large payload.

### Variables

`{{variables}}` are highlighted wherever they appear — the URL, headers, query and path params, auth fields, bodies and scripts — coloured by how they resolve: green for the active environment or a collection variable, purple for a secret, orange for a Postman dynamic variable like `{{$guid}}`, and red-underlined when nothing defines them. Hover one to see its value and scope, and edit it in place without leaving the request.

### Postman Console

A **Postman Console** sits in the bottom panel, next to Terminal and Problems. It records every HTTP call a run makes — including nested `pm.sendRequest` calls that never appear in the response pane — plus `console.log` output and uncaught script errors. Expand any entry for the full request and response headers and bodies.

### Cookies, certificates and proxies

- **Cookies** persist between runs and between sessions, so logging in with one request authorises the next. They are stored in the extension's global storage, never in your workspace.

  `REST Client: Manage Cookies` (also reachable from the response pane's Cookies tab) opens a cookie manager: cookies grouped by domain, with their path, expiry and `HttpOnly`/`Secure`/`SameSite` flags. Add, edit or delete individual cookies, drop a whole domain, or clear the jar. Edits apply to the same jar requests use, so a cookie added by hand is sent on the next request.

  The response pane's **Cookies** tab shows the cookies that apply to that request's URL after the response — which is what `Set-Cookie` just stored.
- **Client certificates** are configured with `restclient.certificates`, matched per URL pattern.
- **Proxies** come from `restclient.proxies`, or fall back to VS Code's own `http.proxy` and `http.noProxy` so the extension obeys the same proxy as the rest of the editor.
- **`pm.vault`** is backed by the OS keychain. Access is granted only in a trusted workspace — the same consent that lets scripts run at all.

### Editing and your editor

If a collection file is open in an editor, edits go through a `WorkspaceEdit` — so **Ctrl/Cmd+Z undoes them** like any other change. If it is not open, the file is written directly. Either way the untouched parts of the file are preserved byte for byte, including tab-vs-space indentation.

## Security

Pre-request and test scripts are arbitrary JavaScript from whoever wrote the collection, so:

- Scripts run in a **separate process**, not in the extension host, and are killed outright if a run is cancelled.
- Requests may only read files from inside the workspace folder.
- In an **untrusted workspace** scripts are stripped entirely; requests still send.

## Not supported

These are absent from Postman's open-source engine, or from the collection format itself:

- **WebSocket, Socket.IO, gRPC and MQTT** — these do not survive a Postman export at all ([postman-app-support#11252](https://github.com/postmanlabs/postman-app-support/issues/11252)).
- **Mock servers, Monitors, Flows, cloud workspace sync** — server-side products.
- **`pm.mock`, `pm.state`** — documented by Postman but not in the open-source sandbox.
- **Visualizer templates that load a library from a CDN** — `pm.visualizer.set` output renders in its own isolated tab, but its network access is blocked, so a template that fetches e.g. Chart.js from a CDN will not draw. Templates that are self-contained HTML work.
- **Request retries** — not implemented by `postman-runtime` (Newman does not have them either).

## Development

```bash
npm install
npm run build             # esbuild: extension, forked runner, webviews
npm run watch
npm test                  # unit (headless) + integration (real VS Code)
npm run package           # .vsix
```

`npm run spike` runs the runtime de-risk checks against your installed VS Code:

```bash
ELECTRON_RUN_AS_NODE=1 "/Applications/Visual Studio Code.app/Contents/MacOS/Code" scripts/spike.cjs
```

### Architecture

```
extension host          store (verbatim JSON) · tree · webview panels · SecretStorage
      │ child_process.fork
forked runner           postman-runtime → postman-sandbox → uvm → worker_threads
```

The Postman packages are deliberately **not bundled**: `postman-sandbox` falls back to a live `browserify`+`terser` compile via static requires that bundlers follow, and its prebuilt 2.3 MB bootcode blob must ship intact. They are declared as production dependencies and shipped as-is in the `.vsix`.

The extension bundle must be built with esbuild `platform: 'node'` — `postman-sandbox` and `uvm` declare `browser` field remaps and a browser/webworker build silently swaps in `Blob` + Web Workers and fails at runtime.
