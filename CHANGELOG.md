# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [Semantic Versioning](https://semver.org/).
Before 1.0.0, a minor version (0.x.0) may change tools or settings in ways that are not backward compatible.

Versions 0.1.0 to 0.4.2 were private builds for one machine.

## 0.6.2 - 2026-11-14

### Changed

- After an upgrade or a rollback, an agent session that is still open says "This agent session runs Windows Chrome
  Bridge 0.6.2, but 0.6.3 is installed now. Restart this agent session to use the browser". Before, its next tool
  call started QA Chrome with the extension of its own release. The handshake then failed, and that QA Chrome was in
  the way of the sessions of the installed release. Sessions of 0.6.1 and older still do this after an upgrade.

## 0.6.1 - 2026-11-14

### Changed

- `manage.py rollback` to a version before 0.6.0 (0.5.0) first clears the service worker cache of QA Chrome
  (`profile\Default\Service Worker`), so that version runs its own extension script. Logins and cookies stay.
  Websites in QA Chrome register their service workers again; their offline caches are gone.
- A `fullPage` screenshot in the result is never scaled below half size. A page too tall for that shows its top part,
  and the result gives `pageHeight` and a note. Before, a tall page became a strip a few pixels wide.
  `maxSize` still fits the whole page, and `file` still saves it at full size.
- On a page with more than 200 form fields, a page read asks Chrome for the element of each empty field only once
  until the page changes. Reads after actions on such pages are faster. A field with a value is still checked at
  every read, so a password value is never shown.

### Fixed

- An agent whose first call came just when the native host stopped an idle QA Chrome lost its connection.
  `manage.py stop` (and install, rollback and uninstall) during an agent's start could kill that start.
  Both stops now take the start lock and count the sessions again just before they stop Chrome.
- `qa_console`: a message with line breaks could look like other messages, stack lines or page lines.
  Every line after the first now starts with `    | `.
- Page reads: a link or button named like `x [e99]` made a change say `(in e99)`, and a backslash in a name
  was not escaped, so a name ending in `\` looked like it went on.
- `manage.py uninstall` stopped with a Python traceback when the install folder held a junction or a link, after the
  agent configs and the native host registration were already removed. It now removes the link itself, never what it
  points to, and a file it cannot remove gives a clean error.
- `manage.py rollback` showed a Python traceback when the self-check after the rollback failed. It now gives a clean error.

## 0.6.0 - 2026-11-14

### Added

- MCP 2026-07-28: a client can use the bridge without the `initialize` handshake. Each request names its
  protocol version and client capabilities in `_meta`. `server/discover` returns the supported versions,
  the capabilities and the instructions. Every result has `resultType` and the server name in `_meta`;
  `tools/list` and `server/discover` have `ttlMs` and `cacheScope`. An unknown version gets error `-32022`
  with the supported versions. Clients that use the handshake (MCP 2024-11-05 to 2025-11-25) work as before.
- Instances for development and tests: with `WINDOWS_CHROME_BRIDGE_INSTANCE=test`, `manage.py` installs and
  manages a second install that shares nothing with the normal one: its own folder, QA Chrome profile,
  native host, pipes and policy path. It never changes agent configs. The live tests always use it
  (`tests/run.py --live` installs it first) and refuse to run on the normal install. See CONTRIBUTING.md.
- `skill/SKILL.md`: how to get a page read, a screenshot, console errors and failed requests in one `qa_batch` call.

### Changed

- The focus goes back to your program also when a page opens a tab or a popup window between tool calls.
  Before, this worked only during a tool call and 1.5 s after it, so a popup that a page opened later stayed in front.
  `window.open` is not changed. A visible session, and a person who works in QA Chrome, keep the focus.
- A `qa-bridge.exe` that was not installed (in `build/` or an unzipped release) refuses to start or reach QA Chrome,
  because it would use the names of the normal install. `--version` still works.

### Fixed

- The display-mode live test `qa_chrome_never_in_front` failed now and then at the moment a test page opened a popup.
  It now fails only if QA Chrome is still in front 1 s later, and it prints the short moments.
- After an upgrade, QA Chrome kept running the extension script of the version before, from Chrome's
  service worker cache. The extension reported the new version, so nothing showed it. An upgrade from 0.5.0
  failed its self-check for this reason. QA Chrome now reloads the extension at the first start after an
  upgrade or a rollback. A rollback from 0.6.0 to 0.5.0 still has the problem, because 0.5.0 does not reload.

## 0.5.0 - 2026-11-14

The first public version.

### Added

- `manage.py`: one command to install from WSL (`install`), plus `doctor`, `stop`, `rollback` and `uninstall`.
  It builds the exe or uses a release zip, registers the native host, writes a default `bridge-config.json`,
  runs a self-check, and adds the MCP server to Claude Code or Codex only when you say yes.
- Release zip with a prebuilt `qa-bridge.exe`, and GitHub Actions for build, unit tests and releases.
- The extension is loaded at every QA Chrome start with no clicks (a keeper process and `Extensions.loadUnpacked`).
- Window modes: `display` (background windows on a chosen screen) or `headless`. No tool call takes the
  Windows focus unless the session called `qa_session(visible: true)`.
- Page reads as an accessibility tree: one short line per element (role, name, state, value) with a ref like `e12`.
  Views: controls only, one subtree, a depth, one frame, a text search. Frames are read inline (`f1e6`).
  Password fields are marked `[password]` and their values are never shown. A field with no name shows its id,
  name or placeholder attribute (`[id="user"]`).
- Only the changes: after the first read of a page, `qa_snapshot` returns what was added, removed or changed since
  your last read. `full: true` gives the whole tree. A new page always gives the whole tree.
- The page after an action: click, fill, type, hover, scroll, drag, upload, wait, dialog, navigate and new tab wait
  until the page settles and return the changes. `snapshot: false` leaves them out.
- `qa_batch`: up to 50 tool calls on one tab in one call. It stops at the first failure and checks every step
  like a single call, including the site policy.
- `qa_fill` sets many fields in one call: text, password, select (by value or label), checkbox and radio.
- `file` on `qa_snapshot`, `qa_screenshot`, `qa_eval`, `qa_console` and `qa_network`: the output is saved in
  `<install folder>\output\<session>\` and the result gives a path that WSL can open.
- `qa_screenshot`: `maxSize` limits the pixel size. An image in the result is at most 2000 px by default, and the
  result says when it was scaled down (`scaledFrom`). A screenshot saved with `file` keeps the full size.
- `qa_network`: requests of the last 3 pages with filters and paging; one request with headers and bodies.
  Secret headers and body fields are hidden unless `showSecrets: true`.
- `qa_console`: console messages and page errors of the last 3 pages, with level and text filters, paging,
  source and stack. A filter that matches nothing gives the count of each level (`qa_network`: of each type).
- `qa_wait` waits for a text, for a text to go away, or for a URL.
- `qa_cdp(events: true)`: the events of the domains you enabled with `qa_cdp`.
- Tool groups: `toolGroups` in `bridge-config.json`. Default: core, debug and files (21 of the 25 tools).
- Several agents: `qa_session(name)`; tab lists show the owner's name; `qa_tabs(action: "keep")` keeps a tab open
  at cleanup and disconnect; `maxSessions` and `maxTabsPerSession` in `bridge-config.json`.
- `policy.json` version 2: `allow` and `block` lists with exact origins or `*.site`, and `strict` mode, where
  navigation is limited too. `manage.py doctor` shows the active policy.
- `qa_record`: an MP4 (H.264) video of a claimed tab, from `start` to `stop`, saved in the output folder.
  It works headless, in display mode and for a background tab, with no focus change and no click.
  It stops by itself at `maxSeconds`, at 9.5 MB, or when the tab closes, and the file is saved at stop or session end.
- `qa_perf`: load times, Core Web Vitals (LCP, CLS, INP), long tasks and the slowest resources (`metrics`);
  CPU and network throttling (`throttle`); memory after a garbage collection (`memory`); a leak check that repeats
  steps and reports the growth (`leak`); a DevTools trace file (`trace`). It replaces the old `qa_diagnostics` metrics.
- `keepOutputDays` in `bridge-config.json` (default 7): old session output folders are removed when QA Chrome starts.
- MIT license, README, SECURITY, CONTRIBUTING.

### Changed

These tool changes are not backward compatible with 0.4.x. 42 tools became 25.

| Before | Now |
|---|---|
| `qa_health` | `qa_session` with no arguments. It also takes `name`. |
| `qa_tabs`, `qa_windows` | `qa_tabs` (`action: "list"`): windows with their tabs and owners |
| `qa_tab_new` | `qa_tabs` `action: "new"`. It now waits for the load and returns the page read |
| `qa_adopt`, `qa_release`, `qa_close`, `qa_cleanup` | `qa_tabs` `action: "adopt"`, `"release"`, `"close"`, `"cleanup"` |
| `qa_transfer` (`targetSessionId`) | `qa_tabs` `action: "transfer"`, `toSession` (a session name or id) |
| `qa_window_close` | removed. Close the window's tabs with `qa_tabs` `close` |
| `qa_snapshot` (DOM summary: text and controls, `maxElements`, `maxTextChars`) | `qa_snapshot`: the accessibility tree as text, `maxChars` |
| `qa_accessibility` | removed. Use `qa_snapshot`, or `qa_cdp` `Accessibility.getFullAXTree` |
| `qa_frames` | removed. Frames have names (`f1`) in the page read, and `frameId` takes them |
| `qa_click_text` | `qa_click` with `text` |
| `qa_click` result `clicked, status: "delivered", trusted, terminalEvent, events` | `{clicked: true}`, and the page changes |
| `qa_fill` (`selector` or `ref`, `text`) | `qa_fill` with `fields: [{ref or selector, value}]` |
| `qa_select` (`values`) | `qa_fill`; a select field takes `value` or `values` |
| `qa_key`, `qa_type` | `qa_type` with `text` and/or `key`. The raw key fields (`code`, `text`, `modifiers`, `virtualKeyCode`) are removed; use `qa_cdp` `Input.dispatchKeyEvent` |
| `qa_navigate` result `url, title, frameId, loaderId` | `loaded`, and the new page read (its first line has the title and URL) |
| `qa_history` `back`, `forward` | `qa_navigate` `action: "back"` or `"forward"`; also `"reload"` |
| `qa_history` `tab`, `search` | removed, with the extension's `history` permission. Profile history showed other sessions' pages |
| `qa_wait` needed `selector` | `selector`, `text`, `textGone` and `url` are all optional |
| `qa_screenshot` PNG by default | JPEG by default (quality 80); `format: "png"` for PNG |
| `qa_download`, `qa_downloads`, `qa_download_adopt`, `qa_download_wait` | `qa_downloads` `action: "start"`, `"list"`, `"adopt"`, `"wait"`; `claim` became `owner` |
| `qa_mobile`, `qa_desktop`, `qa_emulate` (`settings`) | `qa_emulate` with `viewport` (`mobile`), `userAgent`, `geolocation`, `touch`, `reset`. `locale` and `timezone` are removed: Chrome refuses them for extensions |
| `qa_cookies` | `qa_storage` `area: "cookies"` |
| `qa_storage` `action: "remove"` | `action: "delete"` |
| `qa_diagnostics` (`captureDetails`, performance metrics) | `qa_console` and `qa_network`. Console text is recorded by default. Performance metrics: `qa_perf` |
| `policy.json` version 1, `sensitiveOrigins` | version 2, `allow`, `block`, `strict`. Version 1 is refused with a message |
| Every tool always listed | `qa_emulate`, `qa_window`, `qa_storage` and `qa_cdp` are off by default (tool groups) |

Other changes:

- New names, so it can be installed next to the private 0.4.x builds: extension "Windows Chrome Bridge",
  native host `io.github.darkov19.windows_chrome_bridge`, pipe `WindowsChromeBridge-v1-<SID>`,
  install folder `%LOCALAPPDATA%\windows-chrome-bridge`, `qa_downloads` start saves to `Downloads\ChromeBridge\`.
- Readable source; `extension/manifest.json` is the one source of the version and the extension id.
- Tool failures are tool results with `isError: true`, so the agent sees the reason.
- A tool result with a page read has two text items: the result fields as JSON, then the page text.
  A screenshot result has the image, then its fields (`width`, `height`, `scaledFrom`) as JSON.
- `tools/list` leaves out size limits and ranges to save context. The server still checks them.
- `catalog.json` is now `{groups, defaultGroups, tools}`.
- A selector must match exactly one element.
- `qa_storage` `get` without a key returns `{items}`.
- The native host checks the extension once per connection, not per call, and reports real errors.
- `qa_cdp` cannot read every cookie, other sites' storage, or the whole profile.
- The native host stops a QA Chrome that a session started, about 10 s after the last session left, if no window
  is left. It works also when an agent kills its MCP server at exit, as Claude Code does.
  `install`, `rollback` and `uninstall` stop a QA Chrome that no session uses, instead of refusing.
- The native host saves output files (before: the MCP server), so a file is saved also when the agent session ends.
- With `policy.json`, saving to a file is as sensitive as the tool itself, no more. A page read or screenshot file
  works on any site that is not blocked.
- The wait after an action leaves out polling (a request the page sent twice in the 3 s before) and page loads that
  started before the action. On a page that polls all the time, a click returned after 2.5 s; now at once.
- The extension has the `offscreen` permission (for the video encoder) and no longer the `history` permission.
- `manage.py` and `build.py` need Python 3.12 or newer. On an older Python they stop at once and say so.
- `install` starts the MCP server with `--wsl-distro` and `--wsl-root`, so the bridge knows the agent's WSL distro
  and where that WSL mounts the Windows drives.

### Fixed

- In strict policy mode, page reads still showed frames of sites that are not allowed. They are left out now.
- MCP `initialize` always answered protocol version 2025-11-25. It now follows the MCP rule: the client's version when
  the server supports it (2024-11-05, 2025-03-26, 2025-06-18, 2025-11-25), otherwise 2025-11-25.
- After 6 failed tries (about 30 s) the extension stopped connecting to the native host, so QA Chrome stayed
  unusable. It now keeps trying every 15 s.
- `uninstall` said it removed everything, but a profile that the `profile` setting put elsewhere stayed.
  It still stays (it holds logins), and `uninstall` now says where it is. Each line says what was removed and what was kept.
- Tokens in URLs (`?token=`, `?key=`, `#access_token=` and others) were shown in network lists, page reads and tab lists.
  They are now `(hidden)`, like secret headers; `qa_network` with `showSecrets: true` shows them.
- Upload paths on a network share (`\\server\share\...`) made Windows connect to that server with your login.
  `qa_upload` and the file commands of `qa_cdp` now refuse them. WSL paths still work.
- `/home/...` upload paths used the default WSL distro, not the distro the agent runs in.
- A WSL with another automount root in `/etc/wsl.conf` (not `/mnt/`) got wrong paths for uploads and output files,
  and `manage.py` did not find Windows.
- The first QA Chrome start with a new profile timed out: a second extension load left an orphan
  native host that held the pipe.
- A QA Chrome that no session can use is stopped.
- A QA Chrome stayed running when the session that started it left before the others.
- A click or key that opened an alert, confirm or prompt waited until the call timed out. It now returns the dialog.
- `qa_navigate` back to a page from the back/forward cache reported `loaded: false`.
- Requests that a cross-site frame sent while it loaded were missing from `qa_network`, and the frame's own page
  load had no size or time. A new cross-site frame now waits until the bridge listens to it.
- A click on an element inside a cross-site frame never arrived: it used the frame's coordinates and the frame's focus.
- A screenshot of a tab that is not the active tab of its window could wait until the call timed out, in display mode.
  After 5 s the bridge now shows the tab in its window for the capture, then shows the tab that was there before.

### Removed

- The old install scripts, pin files, acceptance files and recorder experiments.

## 0.4.2 - 2026-09-08

### Fixed

- Focus emulation is turned off after every click, also when the click fails.

## 0.4.1 - 2026-09-01

### Changed

- `qa_click` and `qa_click_text` report `clicked: true` only when a trusted click event reached the element.
  Otherwise they return `status: "indeterminate"`.

## 0.4.0 - 2026-09-01

### Added

- 42 tools, described in `catalog.json`: uploads, downloads, `qa_eval`, `qa_cdp`, frames, storage, cookies,
  history, dialogs, emulation, and tab claims (`qa_adopt`, `qa_release`, `qa_transfer`).
- Up to 8 MCP clients at once.

### Removed

- The site allowlist. Any http(s) site works.

## 0.3.0 - 2026-09-01

### Added

- `qa_click_text`, `qa_wait` and `qa_window`.
- A site allowlist file.

## 0.2.0 - 2026-08-31

### Added

- The bridge starts the dedicated QA Chrome by itself, and stops it when it is no longer used.
- `qa_session` for visible mode.

## 0.1.1 - 2026-08-31

### Fixed

- UTF-8 for MCP input and output.

## 0.1.0 - 2026-08-31

### Added

- First bridge: an MCP server, a Chrome native host on a named pipe, and an extension, with 13 tools.
  Only a few test sites were allowed.
