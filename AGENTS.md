# Windows Chrome Bridge
An MCP server that lets WSL agents drive native Windows Chrome.

## Never
- Never run live tests, or manage.py install, stop, rollback or uninstall, on the normal install. It may be in daily use.
- Never start or stop the normal install's QA Chrome.

## Commands
- `python3 tests/run.py`: unit tests.
- `python3 tests/run.py --live`: live tests on the test instance (installs it first).
- `WINDOWS_CHROME_BRIDGE_INSTANCE=test python3 manage.py uninstall`: remove the test instance.

## Before you change code
- Read `CONTRIBUTING.md` first.

## Testing
- Test install or startup changes from a new profile and with an upgrade on an existing profile.
- An upgrade test must change `extension/background.js`, not only the version.

## Git and publishing
- Ask the owner before each push, tag or release.
