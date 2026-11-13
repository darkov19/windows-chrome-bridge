# Security

Windows Chrome Bridge gives an AI agent full control of one Chrome profile.
This page says what the bridge protects, what it does not protect, and how to report a problem.

## What the agent can do

Inside QA Chrome, the agent can do what you can do:

- open any http or https site, read every page, take screenshots, and record videos of its tabs
- type into any field, including passwords and hidden fields
- run any JavaScript in a page (`qa_eval`) and send CDP commands to a tab it claimed (`qa_cdp`)
- read the network requests and console messages of its tabs, including request and response bodies
- upload any file on this computer or in WSL that your Windows user can read, and download files

So: log in to QA Chrome only with accounts that you want the agent to use.
Your agent's own rules for confirmation and safety still apply. The bridge does not ask for approval itself.
`install` sets Codex to ask before each bridge tool call (`default_tools_approval_mode = "prompt"`).
Claude Code asks before MCP tool calls unless you allowed them.

## What the bridge protects

- **A dedicated profile.** QA Chrome uses its own profile folder (`%LOCALAPPDATA%\windows-chrome-bridge\profile`).
  The bridge never opens or lists your personal Chrome profile.
- **No TCP port.** The MCP server talks on stdin and stdout. The native host and the MCP server use a Windows named pipe.
  Chrome gets its DevTools connection as a pipe (`--remote-debugging-pipe`), not as a port.
- **The pipe is for your Windows user only.** Its access list allows only your user, and remote clients are refused.
- **Parent-process check.** The native host runs only when its parent is Chrome with exactly the QA profile.
  Chrome itself allows only this extension id to start the native host.
- **Session claims.** One agent session acts only on tabs it opened or claimed. When it disconnects, those tabs close
  (a tab marked "keep open" stays open and becomes unclaimed).
  Sessions share cookies and logins, because they share the profile. A session name is only a label, not a login.
- **`qa_cdp` limits.** It blocks the CDP domains and commands that reach beyond the claimed tab:
  `Target`, `Browser`, `SystemInfo`, `Tethering`, `Storage`, `DOMStorage`, `IndexedDB`, `CacheStorage`, `Database`,
  `ServiceWorker`, `Tracing`, and `Network.getAllCookies`, `Network.clearBrowserCookies`, `Network.clearBrowserCache`,
  `Network.setCookies`, `Network.loadNetworkResource`, `Page.setDownloadBehavior`.
  Cookie commands work only for the claimed tab's URL. The rules are in `extension/rules.js`.
- **No network paths for files.** `qa_upload`, and `qa_cdp` with `DOM.setFileInputFiles` or `Input.dispatchDragEvent`,
  take only a drive path (`C:\...`), a WSL path, or a WSL share (`\\wsl.localhost\...`, `\\wsl$\...`).
  They refuse a network path such as `\\server\share\file` and device paths such as `\\?\UNC\...`:
  Windows would connect to that server with your login, and a page could ask the agent for such a path.
  A drive letter that you mapped to a network share still works: you chose that server.
- **Limits.** Argument size, result size, timeouts, sessions (`maxSessions`, default 8) and tabs per session
  (`maxTabsPerSession`, default 32).
- **Secrets in output.** Page reads never show password field values. Network details hide the values of
  Authorization, Cookie, Set-Cookie and token-like headers, and of password and token fields in JSON and form bodies,
  unless the agent asks with `showSecrets: true`. URLs in page reads, tab lists, network lists and console sources
  show secret parameters (such as `token`, `key`, `code`, `access_token`, `sig`) and a password in the URL as `(hidden)`;
  only `qa_network` with `showSecrets: true` shows them.
- **Output files.** `file` takes a file name, not a path. Files go only to `<install folder>\output\<session>\`.
  The native host writes them. Only the extension's own code can ask for a file; a value from a page cannot.
  When QA Chrome starts, session folders that did not change for `keepOutputDays` days (default 7) are removed.
  Only folders named like a session id, directly in the output folder, and only when they hold only files.
- **Extension permissions.** `debugger` (CDP on claimed tabs), `nativeMessaging` (the native host), `tabs`,
  `downloads`, `system.display` (window placement), and `offscreen`: recordings are encoded to MP4 in a hidden
  extension page, because the video encoder (WebCodecs) is not available in the service worker.
  That page gets only frames from the service worker; it cannot reach a tab or the disk.

## Optional site policy: `policy.json`

With no policy file, every tool works on every http and https site.
A policy file limits sites in three ways:

```json
{
  "version": 2,
  "allow": ["https://app.example.com", "http://localhost:5173", "*.example.org"],
  "block": ["https://bank.example.org"],
  "strict": false
}
```

- **Patterns.** An exact origin (scheme, host and port, as a browser prints it, no path, no slash at the end),
  or `*.example.org`: the site and all its subdomains, http or https, any port.
- **block**: no tool works on a blocked site, and no tool navigates to one. A block wins over an allow.
  Page reads leave out frames from blocked sites.
- **allow**: the sensitive tools work only on allowed sites. Reading pages, clicking and typing still work everywhere.
  The sensitive tools are `qa_eval`, `qa_cdp`, `qa_upload`, `qa_storage`,
  `qa_network` with `request` (headers and bodies), and `qa_downloads` with `action: "start"`.
  Saving output with `file` is as sensitive as the same call without it: a page read or a screenshot can be saved
  on any site that is not blocked, an eval result only on an allowed site.
- **strict: true**: every tool works only on allowed sites, and navigation (`qa_navigate`, `qa_tabs` new,
  back, forward, reload) goes only to allowed sites. Page reads leave out frames of sites that are not allowed.
  Strict needs at least one allowed site.

Details:

- A tool is refused when the tab, the page it is loading, or the frame it acts in is not allowed or is blocked.
  For `qa_downloads` the download URL counts too, and for `qa_network` the request URL. For `qa_cdp` every frame in the tab counts.
- `qa_batch` checks each step on the page as it is at that step. A navigation inside a batch does not skip a check.
- A page can still move to another site by itself, for example with a redirect or a link the agent clicks.
  The page read after that action is refused, and every tool except navigation refuses the tab until it is back on an allowed site.
  A screenshot of an allowed page can still show a frame of a blocked site.
- `qa_record` is like a screenshot. It cannot start on a blocked site (or, in strict mode, a site that is not allowed).
  While the recorded tab is on such a site, no frame of it is recorded; the video shows a grey
  "Not recorded" frame for that time, and the result says how many frames were left out.
- With a policy, `qa_cdp` gets the same checks as the other tools. A command that reads a request
  (`Network.getResponseBody`, `Network.getRequestPostData`, `Fetch.getResponseBody` and others) is checked on the request's site,
  like `qa_network` with `request`. `Page.getResourceContent` is checked on the resource's site.
  `Page.navigate` and `Page.navigateToHistoryEntry` are checked like `qa_navigate`.
- With a policy, `qa_cdp` refuses commands it cannot check: `IO.read` (a stream can come from any site),
  the stream and interception commands, Debugger and CSS commands with a `scriptId` or `styleSheetId`, such as
  `Debugger.getScriptSource` (a page can load a script or style sheet from another site), and `Page.addScriptToEvaluateOnNewDocument`.
  It also refuses changes to paused page loads of sites that are not allowed.
- The native host reads the file for each new agent session and sends it with every call, so the agent cannot skip it.
  An invalid file makes every call fail with the reason.
- `qa_session` shows the policy, and `python3 manage.py doctor` says whether one is active.
- The file is read from `C:\ProgramData\windows-chrome-bridge\policy.json` first, then from the install folder.

The copy in the install folder can be changed by any program that runs as your Windows user, and that includes your agent.
For a policy the agent cannot change, an administrator creates `C:\ProgramData\windows-chrome-bridge\policy.json`
and gives normal users read access only.

The `toolGroups` setting is not a security limit: it only keeps tools out of the agent's context, and the agent can edit
`bridge-config.json`.

## What the bridge does not protect

- **Programs that run as your Windows user.** Any such program, including your agent's shell in WSL,
  can start `qa-bridge.exe --mcp` and control QA Chrome. It can also read or change the QA profile folder.
  The bridge is not a wall between programs of the same user.
- **Pages.** A page you open can try to trick the agent (prompt injection). Treat page content as data.
- **Your transcript.** Page reads, console messages, `qa_eval` results and network bodies can contain secrets from the page,
  for example a token that a page prints to the console. They go into your agent's transcript.
- **Downloads and output files** stay on disk until you delete them: downloads in your Downloads folder
  (`qa_downloads` start uses `Downloads\ChromeBridge\`), output files in `<install folder>\output\`.

## The extension-loading trade-off

Branded Chrome no longer accepts `--load-extension`. To load the extension with no clicks, the bridge starts QA Chrome with
`--enable-unsafe-extension-debugging` and `--remote-debugging-pipe`, and a small keeper process holds that pipe.
The keeper uses it only to load the extension (`Extensions.loadUnpacked`), then only waits until Chrome exits.

What this means:

- The DevTools pipe is not a port. Only the keeper process holds it, and nothing else can connect to it.
- `--enable-unsafe-extension-debugging` lets that DevTools connection load and debug extensions.
  It applies only to QA Chrome, not to your personal Chrome.
- The extension is loaded fresh at every start. It is not installed in the profile for good.
- The keeper also serves one command for `qa_perf`: a full garbage collection of one page
  (`HeapProfiler.collectGarbage`), because Chrome does not give that command to extensions.
  It listens on a named pipe that only your Windows user can open, and accepts only a page's target id.
  The bridge does not start Chrome with `--js-flags=--expose-gc`, so pages get no `gc()` function.

## Report a problem

Please report security problems privately. Open a
[private security advisory](https://github.com/darkov19/windows-chrome-bridge/security/advisories/new) on GitHub.
Do not open a public issue for a security problem.

Say what you did, what happened, and the version (`qa-bridge.exe --version` or `python3 manage.py doctor`).
This is a personal project. Reports are read, but there is no fixed response time.
