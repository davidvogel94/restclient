# REST Client

A REST client for VS Code that works directly on Postman collections and environments.

Open a repo that has `*.postman_collection.json` files in it and they show up in the
sidebar, ready to send. Requests, environments and `pm.*` scripts run locally — no
account, no sign-in, no cloud.

It embeds Postman's own open-source engine (`postman-runtime`, `postman-sandbox`,
`postman-collection`) rather than reimplementing it, so `pm.test`, `pm.expect`,
`pm.environment.set`, `pm.sendRequest`, the bundled script libraries (chai, lodash,
moment, cheerio, ajv, crypto-js…) and all 13 auth types behave the way they do in
Postman.

## Features

- **Send requests** from the tree or from a full request editor: method, URL, query and
  path params, headers, all auth types, every body mode (raw, GraphQL, url-encoded,
  form-data, binary), pre-request and test scripts, and per-request
  `protocolProfileBehavior` settings.
- **Responses** with body, headers, cookies, test results, script console output and the
  request as actually sent. The body can be viewed pretty-printed, raw, as a JSON tree,
  or previewed (images, audio, video, HTML). Responses are held in memory only.
- **Run All** on a collection or folder, in order, through postman-runtime — so scripts,
  variable chaining and the cookie jar behave exactly as they do for a single send.
- **Environments** view with inline variables: activate one, add/edit/disable variables,
  or move a secret into the OS keychain so the JSON is safe to commit.
- **Collection and folder overviews** for the auth, variables, scripts and description
  that everything underneath inherits.
- **Cookie jar** that persists between runs, with an editor for values, paths, expiry and
  flags.
- **Postman Console** in the bottom panel, recording every HTTP call a run makes,
  including nested `pm.sendRequest` calls.
- `{{variable}}` highlighting, hover values, and in-place editing.
- Client certificates and proxies via `restclient.certificates` / `restclient.proxies`
  (falling back to VS Code's own `http.proxy`).

Scripts run in a separate process from the extension host, and are stripped entirely in
an untrusted workspace.

## It works on your Postman JSON, in place

There is no import step and no separate database. The extension reads and writes the
actual Postman export files in your workspace:

- The workspace is scanned for `*.postman_collection.json`,
  `*.postman_environment.json` and `*.postman_globals.json`.
- Edits are written back into those files as surgical, format-preserving changes — the
  untouched parts stay byte for byte identical, indentation included — so a diff shows
  only what you changed.
- The files remain valid Postman exports. Postman, Newman and anything else that reads
  them keep working, and exporting a collection is a byte-for-byte copy.
- If the file is open in an editor, edits go through a `WorkspaceEdit`, so Ctrl/Cmd+Z
  undoes them like any other change.

Collections in the older v1 or v2.0 format need converting to v2.1 before they can be
edited; the extension offers to do it and tells you first. Broken JSON is reported with
line and column rather than the file silently vanishing from the tree.

Relevant settings (all optional):

```jsonc
// .vscode/settings.json
{
  "restclient.autoDiscover": true,
  "restclient.discoverPatterns": ["**/*.postman_collection.json"],
  "restclient.discoverExclude": ["api/legacy.postman_collection.json"],
  "restclient.collections": ["api/orders.postman_collection.json"],
  "restclient.environments": ["api/local.postman_environment.json"]
}
```

Collections that live outside the repo work too — add their folder to the workspace
(*File → Add Folder to Workspace*). Every folder is scanned against its own settings.

## Not supported

- WebSocket, Socket.IO, gRPC and MQTT requests — these do not survive a Postman export.
- Mock servers, Monitors, Flows and cloud workspace sync — server-side products.
- `pm.mock` and `pm.state` — not in the open-source sandbox.
- Visualizer templates that fetch a library from a CDN (self-contained HTML works).
- Request retries — not implemented by `postman-runtime`.

## Building

Requirements:

- Node.js 18 or newer (developed on 20)
- npm
- VS Code 1.96 or newer

```bash
npm install
npm run build      # esbuild: extension, forked runner, webviews
npm run package    # produces restclient-0.0.1.vsix
```

Other useful scripts:

```bash
npm run watch      # rebuild on change
npm run check      # tsc --noEmit
npm test           # unit tests (headless) + integration tests (real VS Code)
```

The Postman packages are deliberately **not** bundled — `postman-sandbox` compiles
script bootcode at runtime and ships a prebuilt blob that must stay intact — so they are
production dependencies and are shipped as-is inside the `.vsix`. The extension bundle
must be built with esbuild `platform: 'node'`; a browser/webworker build silently swaps
in `Blob` and Web Workers and fails at runtime.

## Installing

From the built `.vsix`:

```bash
code --install-extension restclient-0.0.1.vsix
```

Or in VS Code: **Extensions** → `…` menu → **Install from VSIX…** and pick the file.

Then reload the window. The REST Client icon appears in the activity bar.

## License

MIT
