# Contributing

Thank you for helping. This page says how to build, test and send a change.

## What you need

- Windows 10 or 11 with Google Chrome, and WSL 2 with Python 3.12 or newer
- Node.js 18 or newer, only for the extension unit tests (`tests/*.test.js`)

The exe is built with the C# compiler that is part of Windows
(`C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe`). No SDK is needed.

## Build

```bash
python3 build.py          # build/<version>/: qa-bridge.exe, catalog.json, extension/
python3 build.py --zip    # also dist/windows-chrome-bridge-<version>.zip and .sha256
```

`build.py` runs from WSL and from native Windows Python. It stops if `host/catalog.json` is out of date.

After you change a tool name, group, description or argument, run `python3 host/make_catalog.py`.
Do not edit `host/catalog.json` by hand. Keep tool descriptions short: agents read them in every session.
Put longer guidance in `skill/SKILL.md`.

## Test

```bash
python3 tests/run.py              # unit tests: Python and Node, no Chrome
python3 manage.py install         # install what you built
python3 tests/run.py --live       # live tests against the installed bridge
```

- The live tests need real Windows Chrome. They use only local test pages (`tests/live/fixture.py`, port 18475).
- `test_capabilities.py` covers the page tools, `test_record.py` videos, `test_perf.py` speed and memory on pages
  that are slow or leak on purpose, `test_policy.py` the site policy, `test_lifecycle.py` start, stop, limits,
  tool groups and old output folders, and `test_sessions.py` four sessions working at the same time.
- They run QA Chrome headless, so no window opens. Add `--display` to test with real windows in the background.
  In display mode every test also reads the Windows foreground window before and after each tool call, and all the
  time in between, and fails if a QA Chrome window comes to the front.
- Close your agent sessions that use the bridge first: the live tests need QA Chrome closed at the start.
- Add a test only for a behaviour you changed or a bug you fixed.

## Style

- C# 5 only, because the Windows compiler is C# 5: no `$"..."`, no `?.`, no `nameof`, no `out var`.
- The extension is a plain Manifest V3 service worker. No bundler and no npm packages.
  Put logic without browser calls in `extension/rules.js`, `tree.js`, `logs.js`, `perf.js` or `mp4.js`, so it can be unit tested.
- Python: the standard library only. It must work on Python 3.12, the oldest version users need
  (Ubuntu 24.04), and on the newest stable Python (3.15). The `ci` workflow tests both.
  `manage.py` and `build.py` check the version first, so keep the lines before that check plain.
- 4 spaces in C# and Python, 2 spaces in JavaScript and JSON. See `.editorconfig`.
- Write comments and messages in plain English with short sentences. An error message says what to do next.
- Keep the tool names `qa_*`, the exe name `qa-bridge.exe` and the MCP name `isolated_windows_qa`.

## Send a change

1. Fork the repository and make a branch.
2. Make the change. Run the unit tests. Run the live tests if you changed the host or the extension.
3. Add a line to `CHANGELOG.md` under "Unreleased".
4. Open a pull request. Say what you changed, why, and which tests you ran.

## Versions and releases

The project uses [Semantic Versioning](https://semver.org/). The one source of the version is
`"version"` in `extension/manifest.json`. `qa-bridge.exe`, `manage.py` and the release zip read it from there.

To release version X.Y.Z:

1. Set `"version": "X.Y.Z"` in `extension/manifest.json`.
2. In `CHANGELOG.md`, rename "Unreleased" to `X.Y.Z - <date>`.
3. Run the unit tests and the live tests.
4. Commit: `git commit -am "Release X.Y.Z"`.
5. Tag and push: `git tag -a vX.Y.Z -m "X.Y.Z"` and `git push origin main vX.Y.Z`.

The `release` workflow then builds on Windows, checks that the tag matches the manifest,
and attaches `windows-chrome-bridge-X.Y.Z.zip` and its `.sha256` file to a GitHub release.
