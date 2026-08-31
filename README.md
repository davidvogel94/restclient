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

**Found, not configured.** Open a repo that already has Postman files in it and they are simply there. The workspace is scanned for `*.postman_collection.json`, `*.postman_environment.json` and `*.postman_globals.json`, and whatever it finds is worked on **in place** — nothing is copied, and nothing is written to your settings for it. `files.exclude` and `search.exclude` are honoured, so `node_modules` and `dist` are not walked.

Three settings steer it, and one turns it off:

```jsonc
// .vscode/settings.json
{
  "restclient.autoDiscover": true,                                  // false to use only the lists below
  "restclient.discoverPatterns": ["**/*.postman_collection.json"],   // if your repo names them its own way
  "restclient.discoverExclude": ["api/legacy.postman_collection.json"]
}
```

**The folder you keep collections in is scanned whole.** Once `restclient.importLocation` is set — by the first import, or by *REST Client: Set Import Location* — every `.json` file under it is scanned whatever it is called, on top of the patterns above. Choosing that folder is the statement that its JSON is this extension's, so a collection saved out of Postman as `orders.json` needs no pattern of its own. JSON in there that is not a Postman export is ignored; one that will not parse is shown as a broken collection rather than quietly disappearing.

*Stop Working on This Collection* on a file the scan found adds its path to `restclient.discoverExclude` — a file nobody listed cannot be removed from a list, so refusing one has to be recorded somewhere. `REST Client: Excluded from Workspace Scan` lists what is excluded and puts any of it back.

**The explicit lists still exist.** For a file outside the workspace, a file whose name follows no convention, or anything you want recorded and committed:

```jsonc
// .vscode/settings.json
{
  "restclient.collections": ["api/orders.postman_collection.json"],
  "restclient.environments": ["api/local.postman_environment.json", "~/Postman/shared.postman_environment.json"]
}
```

Paths are workspace-relative where possible; absolute and `~/`-prefixed paths work too. Discovery is additive, and an explicit entry outranks an exclusion. *Stop Working on This Collection* on a listed file removes the entry — the file itself is never moved or deleted.

An entry that names a file which is not on disk gets a row saying so rather than being skipped in silence: a stale path is something only whoever wrote it can fix, and an empty pane tells them nothing. Clicking the row opens the list; *Stop Working on This Collection* drops the entry.

**Import copies in.** `$(desktop-download)` **Import** on a file from outside the workspace copies it into `restclient.importLocation` — asked once, then remembered, and changed later with `REST Client: Set Import Location` — and it is the **copy** this workspace works on. Your original is never listed, never moved and never rewritten, including by a v1→v2.1 conversion. A name clash keeps both files rather than overwriting one. A file already inside the workspace is worked on where it is; a second copy of something already committed here would serve nobody.

That the copy has to land inside the workspace is not tidiness: requests can only read files from a workspace folder, so a collection kept outside every one of them could not reach its own form-data attachments.

**Collections that live outside the repo you opened.** Add their folder to the workspace — *File → Add Folder to Workspace*, or the button in the empty Collections pane. Every folder in a multi-root workspace is scanned, each against its own settings, and every folder is a place requests may read files from. So a sibling directory of Postman exports becomes a first-class part of the workspace rather than something tracked at arm's length, which is the only arrangement in which its collections can actually run.

Each folder answers for itself: `restclient.autoDiscover`, `restclient.discoverPatterns` and the two explicit lists are read per folder, and a relative entry is relative to the folder whose settings spell it. A repo that turns the scan off does not turn it off for a folder you added purely to hold collections.

The other thing that copies is **Export**, which is the point of it: it writes a Postman export somewhere you choose and does *not* start working on the copy, so it stays where you put it while you carry on editing the original.

### Secrets

Postman marks sensitive variables `"type": "secret"` but still exports them in plaintext. Adding a file changes nothing about its contents: the plaintext value is read and used as-is, and flagged in the UI. Choosing **move to keychain** — from the Environments view, the environment editor or the inline variable popover — puts the value in VS Code's `SecretStorage` (your OS keychain) and blanks it in the JSON, so the file becomes safe to commit. Values you type into a secret field always go to the keychain, never to the file.

### Responses

Responses are held **in memory only**, for as long as the window is open. Closing and reopening a request editor keeps the last response; nothing is written to disk, workspace state or global storage unless you ask for it — the `$(ellipsis)` menu in the response's top-right corner saves one to a file you pick, and that is the only path that puts a response on disk. `REST Client: Clear Cached Responses` drops them immediately.

There is one record of them, whoever produced it: a single Send, `$(play)` on a tree row, a quick-run from a collection overview and a **Run All** all file the same per-request result — which is why the tree row, the overview list and an already-open request editor agree about what happened without any of them re-running anything.

### Finding things

Both panes filter. `$(filter)` in the title bar — or **Ctrl/Cmd+F** with the pane focused — opens a box that narrows the tree on every keystroke, and `$(clear-all)` puts it back. Collections match on request, folder and collection name, method and URL, so `post users` finds the POST under Users and `example.com/orders` finds everything pointed at it. Environments match on environment name, variable name and value — "which one points at staging?" is a question the filter answers — with one exception: a secret's value is never matched, because the tree will not show it either.

Whole subtrees are searched, not just the rows that happen to be open, and what survives comes up expanded — a match four folders down is not something to go clicking for. Naming a container asks for the container: filter on a folder or environment name and you get all of its contents, not only the parts that repeat the name. The line above the tree says how much is being hidden, and anything you then create is shown to you even if the filter would have hidden it — the filter gives way rather than swallow a new request.

### When a file will not parse

A tracked file that is broken — a bad merge, a hand edit, a truncated download — stays in its pane rather than disappearing. The row shows the file name and `invalid JSON`, with one child per problem giving the message and `Ln 5, Col 12`; clicking a problem opens the file with the offending token selected. Every problem is listed, not just the first, so one pass through fixes the file. Until it parses, the collection is not run, edited or exported — only **Open** and **Stop Working on This Collection** are offered on it.

A tracked path that simply does not exist is not an error: the list in settings outlives the files it names, and a path on a branch you are not on is a normal state.

A collection in the **v1 or v2.0** format is a third case, and reads as a warning rather than an error: nothing is wrong with the file, it just cannot be edited until it is converted. The row says `Postman v1.0.0 — needs converting` and clicking it offers to do exactly that, after telling you it rewrites the file. Until then the collection is not loaded, because a v1 collection read as a v2.1 one comes out as nonsense.

## Usage

1. **Start a collection** — `$(new-file)` **New Collection** writes a new, empty v2.1.0 collection: you pick the folder and file name in a save dialog first, then name the collection itself (prefilled from the file name). `$(desktop-download)` **Import Collection** adopts one you already have, from the button, the command palette, the Explorer context menu on a `*.postman_collection.json`, or by dragging the file onto the Collections view. A file from outside the workspace is copied into your import folder first and the copy is what you then work on. Collection formats v1 and v2.0 need converting to v2.1 before they can be edited; you are asked first — and when the file came from outside, it is the copy that gets converted, so your original is untouched.

   Files already in the workspace mostly need no importing at all: the scan has them. Importing one anyway records it in `restclient.collections`, which is worth doing for a file you want tracked even with the scan turned off.

   Both views keep the same split: `$(new-file)` **New …** creates a file, `$(desktop-download)` **Import …** adopts one, and `$(add)` adds something *inside* a file you already have — a request, a folder, a variable. The pane title bars carry only what applies to the pane; anything that needs a parent — a request, a folder — lives on the row that would be its parent.

   Anything you add is then selected in its pane, with the tree expanded down to it and scrolled into view — a request created inside a collapsed folder three levels down is not something you should have to go looking for. A new request also opens in the editor, so creating one leaves you in it.
2. **Manage environments** — the **Environments** view in the REST Client sidebar lists every environment with its variables inline, and is where the active one is chosen: click a row (or its `$(pass)` button) to activate it, and `$(circle-slash)` on the active row to run with no environment at all. Expand an environment to see each variable's value, whether it is disabled, and whether a secret is in the keychain or still sitting in the file. From there you can add, edit, enable/disable, delete and promote a variable to a secret without opening anything. `$(new-file)` **New Environment** creates one from scratch — same save-dialog-then-name flow as a collection — `$(desktop-download)` **Import Environment** adopts an existing export — copied in from outside the workspace, exactly as a collection is — and the globe in the status bar still switches between them from anywhere.
3. **Send** — click a request in the tree, then press Send. Or use `$(play)` **Run** on the row itself: the editor opens and the request goes straight out, so a quick re-run is one click from the tree. To send everything in a collection or folder, `$(run-all)` **Run All Requests** on its row — see [Collection and folder overviews](#collection-and-folder-overviews).

   Every one of those buttons is also how you stop: while a run is in flight, Send becomes a red **Stop**, and in the sidebar the row's `$(play)` or `$(run-all)` is replaced by a red stop square — on the request being sent, and on the collection and folders above it. Stopping ends the run the row belongs to, which for a request in the middle of a Run All is that Run All.

   A request that has been run keeps the outcome on its row — `POST · 200 · ✓ 3`, or `500 · ✗ 1/3` when tests failed, and `running…` while it is in flight. The tooltip has the rest: the status in full, the time, the size, and the name of every test that failed. Nothing is stored — the hints come from the same in-memory responses the editor replays, so `REST Client: Clear Cached Responses` blanks them as well.
4. **Edit** — the request editor is live: method, URL, query and path params, headers, all 13 auth types, every body mode (raw, GraphQL, url-encoded, form-data, binary), both scripts and the **Settings** tab (see below). Changes are written back into the collection JSON as surgical, format-preserving edits, so a diff shows only what you actually changed.
5. **Organise** — right-click the tree to add, rename, duplicate or delete requests and folders, or drag to reorder. For a full-page editor over an environment's variables, use `REST Client: Edit Environment` or the `$(settings-gear)` on an environment row.
6. **Export** — `$(save-as)` **Export Collection** and **Export Environment**, on the right-click menu of a collection or environment row, write a Postman export wherever you point the save dialog. **Export All Collections** and **Export All Environments**, in each pane's `…` menu, write the lot into one folder, named after the collections rather than the files they came from. A collection on disk already *is* a Postman export, so this is a byte-for-byte copy — same formatting, same ids, nothing re-serialised.

   Environments are the exception. Their secrets live in your keychain and the file holds empty strings, so an export leaves them empty too unless you say otherwise: where there is something in the keychain to include, you are asked once, and Cancel means leave them out. Exporting over a file this workspace is working on is refused rather than confirmed.

Responses show body, headers, cookies, test results, script console output and the exact request as sent. The body has four views:

- **Pretty** — re-indented and broken across lines (JSON and XML), then syntax highlighted.
- **Raw** — exactly the bytes that came back, unformatted.
- **Preview** — the body as the thing it is: a picture, a player, or a rendered page. Offered whenever the response is an image, audio, video or HTML, and nothing else.
- **Tree** — a collapsible tree of the parsed JSON, for finding one field in a large payload.

A picture, a sound or a film opens in **Preview** by itself, because there is no useful reading of those bytes as text — click any other view and it stays where you put it until the next response. HTML does not: a REST client is usually there for the source, so it opens in **Pretty** and the render is one click away. Under the preview is what you are looking at: an image's real dimensions, which no header carries, the size of what came back, and a note when a body was truncated on the way in and the preview is therefore of a fragment.

An HTML preview renders in a frame that is sealed shut: no scripts, no forms, no navigation, and no network — which means remote images, web fonts and stylesheets do not load, so what you see is the page's own markup and its own `<style>`, and previewing someone's error page cannot fetch their tracking pixel. Sound and video are played by the editor itself, so which formats work is whatever the VS Code build can decode; one it cannot says so rather than showing an empty player.

A server that sends `application/octet-stream` — or no `Content-Type` at all — has its first bytes read to see whether it is a PNG, a JPEG, a WAV, an MP4 and so on, and the preview says where the type came from (`no content-type — looks like image/png`). A server that *did* name a type is taken at its word: a PNG labelled `text/plain` keeps showing as text, because that mislabelling is the bug you need to see.

Whichever tab and body view you leave a response on is where the next one opens — on the next Send, on a different request, and after closing and reopening the editor. Someone who lives in **Raw**, or who checks **Tests** first, says so once.

The `$(ellipsis)` menu in the top-right corner of the response saves what came back: **Save body…** writes the body alone, named for the type the server said it was — `.json`, `.png`, `.pdf`, and `.bin` for a type nothing here recognises — and **Save with headers…** writes the whole message, status line and headers first, as a `.http` file. A body that was truncated on the way in (`restclient.maxResponseSizeMb`) saves short, and says so.

One search box, above the response, covers all of it — `Ctrl`/`Cmd+F` puts the cursor in it. What it does depends on what is in front of you: rows narrow to the ones that match (headers, cookies, tests, console lines, the request as sent), the JSON tree prunes to the branches containing a hit and keeps the path to each, and body text marks every hit so `Enter` and `Shift+Enter` step through them. The tab labels turn into `matched/total`, so you can see which tab the thing you are looking for is on without opening it. `Aa` matches case, `.*` treats the query as a regular expression — a pattern that will not compile says so instead of quietly matching nothing.

### Collection and folder overviews

A collection or a folder is not just somewhere requests live: it carries the auth,
variables and scripts everything under it inherits. Click either row in the tree and
it opens as its own tab — and the row itself opens with it, so what the tab is
describing and what the tree is showing are the same thing. Shutting the row again is
the one thing that takes a second click: a click on the row that is already the
selected one puts it away, one level, the way the twistie beside it does. So clicking
your way down into a folder never closes the one you came from, and a row clicked to
select it stays open. `$(expand-all)` **Expand All** and `$(collapse-all)` **Collapse
All** on the row open and shut it and every folder under it, all the way down,
without opening a tab.

It works the other way round too: whichever tab comes to the front — a request
editor, a folder or a collection overview — its row becomes the selection in the
tree, expanded to and scrolled into view. So a request opened from an overview's
**Contents** list, a tab restored from last session, or the next tab along all
leave the pane pointing at where you actually are, rather than at whatever was
clicked last. A filter you have typed stays: the pane will not throw your matches
away to follow a tab. Nor will it open itself — with the sidebar showing
something else, the pane catches up the next time you look at it.

The **Contents** tab is the container's tree, not a flat list: folders stay folders,
expandable and collapsible, in collection order. Each request line carries its method
and name, with the URL as written on its own indented line beneath — long URLs wrap
there rather than pushing the page sideways. Alongside sits what the last run made of
it: the status code, the test tally, and `$(play)` to run just that request.

Anywhere on a request's row opens its editor — the name, the URL, the status, the empty
space between them — since all of it is about that one request; only `$(play)` does
something else. A click that leaves a selection behind is a drag across a URL to copy
it, not a click, and is left alone.

Folder rows roll up what is inside them — how many of their requests ran, how many had
problems, and the combined test tally — so a folder you have collapsed cannot hide a
failure. `$(play)` on a folder row runs just that folder. `$(collapse-all)` shuts them
all, and everything starts open.

**Run All**, top right, runs the lot in order through postman-runtime, so scripts,
ordering, variable chaining and the cookie jar all behave exactly as a single send
does; the button turns into a red **Stop** while it is going, and rows read `queued`
until the run reaches them. The `$(play)` on whichever row is in flight turns red the
same way, so a run can be stopped from the row you are watching rather than the top of
the page. Stopping is per run, not per request — postman-runtime is executing one
ordered sequence, and there is no way to drop a single request out of it — so Stop on a
row in the middle of a Run All ends that Run All.

The page is laid out to a fixed width rather than filling the window: the whole point of
the list is reading a request and what its last run did as one glance, and on a wide
monitor an unbounded table pushes the status and test columns too far from the request
they describe to be read together. The columns are stated outright for the same reason —
collapsing a folder takes its long URLs with it, and a table sized to its contents would
shrink out from under you mid-glance. Narrower than the layout needs, it gives way and
the request column wraps harder; the page never scrolls sideways.

Results are the same record the tree rows and the request editor read, so one Run All
lights up all three — a request editor left open on one of those requests shows what
came back, without being re-run. Like every other response, they are held in memory
only.

The remaining tabs are the container's own settings, written straight back into the
collection JSON:

- **Auth** — the default for every request under it. A folder can also inherit from
  its parent, which means no `auth` block at all; the tab says which ancestor it is
  currently getting its auth from.
- **Variables** — a collection's `variable[]`, resolved after the environment, so an
  environment variable of the same name still wins. A folder can hold variables too
  and the file keeps them, but Postman resolves variables at collection scope only —
  the tab says so rather than letting you believe otherwise.
- **Pre-request** / **Tests** — scripts that run for every request under this
  container, alongside whatever its ancestors declare. Those are listed underneath,
  read-only, with the container they come from.
- **Description** — what Postman and generated documentation show.

The name is edited in place at the top of the tab. **Run All Requests** is also on the
right-click menu of any collection or folder row, and inline on the row itself.

### Request settings

The editor's **Settings** tab carries every per-request behaviour Postman's own Settings tab does, stored the same way — `protocolProfileBehavior` on the item, so the file stays a Postman export and Postman reads back what you set here:

| | |
|---|---|
| Encode URL automatically | `disableUrlEncoding` |
| Send the body on methods that normally have none | `disableBodyPruning` |
| Enable strict HTTP parser | `insecureHTTPParser` |
| Send and store cookies | `disableCookies` |
| Protocol version — auto, HTTP/1.x, HTTP/2 | `protocolVersion` |
| Automatically follow redirects | `followRedirects` |
| Maximum number of redirects | `maxRedirects` |
| Follow original HTTP method | `followOriginalHttpMethod` |
| Follow authorization header | `followAuthorizationHeader` |
| Remove referer header on redirect | `removeRefererHeaderOnRedirect` |
| System headers to omit | `disabledSystemHeaders` |
| Enable SSL certificate verification | `strictSSL` |
| Use server cipher suite during handshake | `tlsPreferServerCiphers` |
| Disabled TLS protocols | `tlsDisabledProtocols` |
| TLS cipher suites | `tlsCipherSelection` |

That is the whole list, not a selection: it is every behaviour `postman-runtime` acts on, taken from the engine rather than transcribed from a screenshot, so there is nothing Postman's GUI can set that this tab cannot.

**Only what you change is written.** A setting you have not touched is absent from the file, and the tab says where its value is actually coming from — `from Orders` for a folder that sets it, `default` for your `restclient.*` settings or the engine's own. Changing one marks the row `set here`; `$(discard)` puts it back and removes the key, taking the whole `protocolProfileBehavior` block with it when it was the last one, so a request you have reset is byte-identical to one you never touched.

Postman resolves these key by key up the tree — the request first, then each folder, then the collection — so a request that sets only `followRedirects` still takes its folder's `strictSSL`. Because the engine doing the resolving is Postman's own, that is not an approximation of the rule; it is the rule.

One caveat: `disableUrlEncoding` only reaches the wire through postman-runtime's newer WHATWG URL parser, which differs from the legacy one on enough edge cases that switching every collection over would change requests nobody asked about. So it is turned on for a run exactly when the collection uses that setting.

### Variables

`{{variables}}` are highlighted wherever they appear — the URL, headers, query and path params, auth fields, bodies and scripts — coloured by how they resolve: green for the active environment or a collection variable, purple for a secret, orange for a Postman dynamic variable like `{{$guid}}`, and red-underlined when nothing defines them. Hover one to see its value and scope, and edit it in place without leaving the request.

### Postman Console

A **Postman Console** sits in the bottom panel, next to Terminal and Problems. It records every HTTP call a run makes — including nested `pm.sendRequest` calls that never appear in the response pane — plus `console.log` output and uncaught script errors. Expand any entry for the full request and response headers and bodies.

### Cookies, certificates and proxies

- **Cookies** persist between runs and between sessions, so logging in with one request authorises the next. They are stored in the extension's global storage, never in your workspace.

  The **Cookies** view sits under Environments in the sidebar and shows the jar itself: a row per domain, with each cookie's value underneath, its path when it is not `/`, and a warning on one that has expired and will no longer be sent. Click a cookie to change its value, `$(trash)` it off a row, or drop a whole domain; the title bar has `$(clear-all)` **Clear Cookies** for the lot. Edits apply to the same jar requests use, so a cookie changed by hand is sent on the next request.

  `REST Client: Manage Cookies` — the `$(edit)` button on that pane, and the response pane's Cookies tab — opens the full cookie editor, where a cookie's path, expiry and `HttpOnly`/`Secure`/`SameSite` flags can be set and new ones added.

  The response pane's **Cookies** tab shows the cookies that apply to that request's URL after the response — which is what `Set-Cookie` just stored.
- **Client certificates** are configured with `restclient.certificates`, matched per URL pattern.
- **Proxies** come from `restclient.proxies`, or fall back to VS Code's own `http.proxy` and `http.noProxy` so the extension obeys the same proxy as the rest of the editor.
- **`pm.vault`** is backed by the OS keychain. Access is granted only in a trusted workspace — the same consent that lets scripts run at all.

### Editing and your editor

If a collection file is open in an editor, edits go through a `WorkspaceEdit` — so **Ctrl/Cmd+Z undoes them** like any other change. If it is not open, the file is written directly. Either way the untouched parts of the file are preserved byte for byte, including tab-vs-space indentation.

## Security

Pre-request and test scripts are arbitrary JavaScript from whoever wrote the collection, so:

- Scripts run in a **separate process**, not in the extension host, and are killed outright if a run is cancelled.
- Requests may only read files from inside a workspace folder — any of them in a multi-root workspace, and nowhere else. Relative paths resolve against the folder holding the collection that named them.
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
