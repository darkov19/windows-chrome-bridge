"""Shared helpers for the live tests. They need Windows, Google Chrome and an installed bridge.

Each live test runs against the installed version (python3 manage.py install) and uses only the
local fixture page. It runs QA Chrome headless unless you pass --display: for the run it sets
windowMode in bridge-config.json and puts the file back afterwards.
"""

import contextlib
import json
import re
import subprocess
import sys
import threading
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO))
import manage  # noqa: E402

ROOT = manage.root()
STATE = manage.read_state(ROOT)
VERSION = STATE["current"]
EXE = manage.exe_of(ROOT, VERSION) if VERSION else None
DISPLAY = "--display" in sys.argv[1:]


class Foreground(threading.Thread):
    """Display mode: the Windows foreground window before and after every tool call, and a sampler
    that reads it all the time in between. A QA Chrome window must never come to the front."""

    def __init__(self):
        super().__init__(daemon=True)
        self.calls, self.samples, self.changes, self.hits, self.stop = 0, 0, [], [], threading.Event()
        # The tool call that runs now (or ran last), so a hit says when it happened.
        self.current = None

    @staticmethod
    def now():
        return json.loads(subprocess.run([str(EXE), "--foreground"], capture_output=True, encoding="utf-8").stdout)

    @staticmethod
    def is_qa(f):
        return f["process"] == "chrome" and f["pid"] in {x["pid"] for x in lifecycle("snapshot")}

    def run(self):
        while not self.stop.is_set():
            f = self.now()
            self.samples += 1
            if self.is_qa(f):
                self.hits.append({"during": self.current, **f})

    def call(self, tool, before):
        after = self.now()
        self.calls += 1
        if after["window"] != before["window"]:
            self.changes.append({"tool": tool, "from": before["process"], "to": after["process"], "qa": self.is_qa(after)})

    def check(self):
        self.stop.set()
        self.join()
        print("Foreground: %d tool calls, %d samples, %d changes %s, QA Chrome in front in %d samples %s"
              % (self.calls, self.samples, len(self.changes), self.changes, len(self.hits), self.hits), flush=True)
        ok("qa_chrome_never_in_front", not self.hits and not any(c["qa"] for c in self.changes) and self.samples > 10)


FOREGROUND = Foreground() if DISPLAY else None


class Client(manage.Client):
    def request(self, method, params=None, timeout=90):
        if FOREGROUND is None or method != "tools/call":
            return super().request(method, params, timeout)
        before = FOREGROUND.now()
        FOREGROUND.current = "%d %s %s" % (FOREGROUND.calls + 1, params["name"], json.dumps(params.get("arguments"))[:120])
        try:
            return super().request(method, params, timeout)
        finally:
            FOREGROUND.call(params["name"], before)


def lifecycle(action, *args):
    return manage.lifecycle(EXE, action, *args)


def chrome_closed():
    return not lifecycle("snapshot")


POWERSHELL = manage.C + "Windows/System32/WindowsPowerShell/v1.0/powershell.exe"


def bridge_processes():
    """The keeper, native host and MCP server processes of this install (qa-bridge.exe under ROOT)."""
    script = ("[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-CimInstance Win32_Process -Filter \"Name='qa-bridge.exe'\""
              " | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress")
    out = subprocess.run([POWERSHELL, "-NoProfile", "-Command", script], capture_output=True, encoding="utf-8",
                         errors="replace").stdout.strip()
    rows = json.loads(out) if out else []
    rows = [rows] if isinstance(rows, dict) else rows
    mine = manage.win(ROOT).lower() + "\\"
    return [r for r in rows if (r["ExecutablePath"] or "").lower().startswith(mine)
            and any(x in (r["CommandLine"] or "") for x in ("--mcp", "--chrome-keeper", "chrome-extension://"))]


def closed_down():
    """QA Chrome, the keeper and the native host are gone."""
    return chrome_closed() and not bridge_processes()


@contextlib.contextmanager
def test_mode(**overrides):
    """Check the install, set the window mode and the given settings for the run (by default all tool
    groups), and restore bridge-config.json after it."""
    if not VERSION or not EXE.exists():
        sys.exit("No installed bridge. Run: python3 manage.py install")
    source = json.loads((REPO / "extension" / "manifest.json").read_text())["version"]
    if source != VERSION:
        sys.exit("The installed version is " + VERSION + " but the repo is " + source + ". Run: python3 manage.py install")
    # The last session of the test before stops QA Chrome about 10 s after it left.
    end = time.monotonic() + 30
    while not chrome_closed() and time.monotonic() < end:
        time.sleep(1)
    if not chrome_closed():
        sys.exit("QA Chrome is running. The live tests need it closed")
    config = ROOT / "bridge-config.json"
    original = config.read_text() if config.exists() else None
    settings = json.loads(original) if original else {}
    settings["windowMode"] = "display" if DISPLAY else "headless"
    settings["toolGroups"] = ["all"]
    settings.update(overrides)
    settings = {k: v for k, v in settings.items() if v is not None}
    config.write_text(json.dumps(settings, indent=2) + "\n")
    print("Testing " + VERSION + " (" + settings["windowMode"] + ")", flush=True)
    if FOREGROUND:
        FOREGROUND.start()
    try:
        yield
        if FOREGROUND:
            FOREGROUND.check()
    finally:
        if original is None:
            config.unlink()
        else:
            config.write_text(original)


def ok(name, value=True):
    assert value, name
    print("PASS", name, flush=True)


def refused(fn):
    """Run fn, expect a tool error, return its text."""
    try:
        fn()
    except RuntimeError as e:
        return str(e)
    raise AssertionError("Expected the call to be refused")


def set_config(**overrides):
    """Change bridge-config.json inside test_mode. It applies to MCP clients started after it."""
    config = ROOT / "bridge-config.json"
    settings = json.loads(config.read_text())
    settings.update(overrides)
    config.write_text(json.dumps({k: v for k, v in settings.items() if v is not None}, indent=2) + "\n")


def page(c, tool, **args):
    """Call a tool that returns the page. Returns (fields, page text)."""
    r = c.call(tool, **args)["content"]
    fields = json.loads(r[0]["text"]) if r[0]["text"].startswith("{") else {}
    return fields, r[-1]["text"] if len(r) > 1 or not fields else ""


def ref(text, start):
    """The ref of the first line of a page read that contains start, for example 'button "Send"'."""
    for line in text.splitlines():
        if start in line:
            m = re.search(r"\[((?:f\d+)?e\d+)\]", line)
            if m:
                return m.group(1)
    raise AssertionError("No line with " + start + " in:\n" + text)


def eventually(fn, pred=bool, seconds=20):
    end = time.monotonic() + seconds
    last = None
    while time.monotonic() < end:
        try:
            last = fn()
            if pred(last):
                return last
        except RuntimeError as e:
            last = str(e)
        time.sleep(0.2)
    raise AssertionError(last)
