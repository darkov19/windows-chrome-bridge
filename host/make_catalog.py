"""The source of host/catalog.json: every tool, its group, description and argument rules.

Usage: python3 host/make_catalog.py          (writes host/catalog.json)
       python3 host/make_catalog.py --check  (fails if host/catalog.json is out of date)

Agents read these descriptions in every session, so keep them short.
The longer guidance is in skill/SKILL.md.
"""

import json
import sys
from pathlib import Path

S = lambda n=4096: {"type": "string", "maxLength": n}
I = lambda lo=0, hi=2147483647: {"type": "integer", "minimum": lo, "maximum": hi}
N = lambda lo=-100000, hi=100000: {"type": "number", "minimum": lo, "maximum": hi}
B = {"type": "boolean"}
O = {"type": "object", "additionalProperties": True}
A = lambda items, n=32: {"type": "array", "items": items, "maxItems": n}
E = lambda values: {"type": "string", "enum": values}


def Obj(props, required=()):
    return {"type": "object", "properties": props, "required": list(required), "additionalProperties": False}


tab = {"tabId": I(1)}
frame = {"frameId": S(200)}
target = {"ref": S(40), "selector": S(2000)}
snap = {"snapshot": B}
file = {"file": S(120)}
timeout = {"timeoutMs": I(0, 30000)}
page = {"offset": I(0, 100000), "limit": I(1, 1000)}

# Groups. "core" is always on. bridge-config.json "toolGroups" turns the others on or off.
GROUPS = {
    "core": "read and use pages",
    "debug": "console, network and JavaScript",
    "files": "uploads, downloads and video recordings",
    "device": "emulation and window size",
    "data": "storage and cookies",
    "cdp": "raw Chrome DevTools Protocol",
}
DEFAULT_GROUPS = ["core", "debug", "files"]
tools = []


def tool(group, name, desc, props={}, required=()):
    assert group in GROUPS
    tools.append({"group": group, "name": name, "description": desc, "inputSchema": Obj(props, required)})


ACT = " Returns the page changes after the page settles (snapshot=false: none)."
REF = " Target: ref from qa_snapshot, or selector (CSS, exactly one match)."

tool(
    "core",
    "qa_session",
    "This session and the bridge: version, your tabs, window mode, policy, output folder. "
    "name: a short name that other sessions see. visible=true brings windows to the front; use it only "
    "when the user wants to watch.",
    {"name": S(40), "visible": B},
)
tool(
    "core",
    "qa_tabs",
    "Tabs of the QA profile. action: list (default; every window and tab with its owner), "
    "new (open url in a new claimed tab, wait for load, return the page read), adopt (claim an "
    "unclaimed tab, for example a popup), release (give a tab up, leave it open), close, "
    "keep (keepOpen: cleanup and disconnect leave the tab open), transfer (to the session toSession), "
    "cleanup (close your tabs that are not kept).",
    {
        "action": E(["list", "new", "adopt", "release", "close", "keep", "transfer", "cleanup"]),
        "url": S(),
        "newWindow": B,
        "keepOpen": B,
        "toSession": S(40),
    }
    | tab
    | snap,
)
tool(
    "core",
    "qa_navigate",
    "Go to url, or action back, forward or reload, in a claimed tab. Waits for load "
    "(waitUntil load, domcontentloaded or none). Returns the new page read.",
    tab | {"url": S(), "action": E(["back", "forward", "reload"]), "waitUntil": E(["load", "domcontentloaded", "none"])}
    | timeout
    | snap,
    ["tabId"],
)
tool(
    "core",
    "qa_snapshot",
    "Read the page as an accessibility tree: one line per element (role, name, state, value) with a "
    "ref like [e12] for other tools. After the first read it returns only the changes since your last "
    "read; full=true gives the whole tree. Views: interactive (controls only), ref (one subtree), depth, "
    "frameId, search (matching lines). Password values are never shown.",
    tab
    | frame
    | {
        "full": B,
        "interactive": B,
        "ref": S(40),
        "depth": I(1, 100),
        "search": S(200),
        "maxChars": I(1000, 1000000),
    }
    | file,
    ["tabId"],
)
tool(
    "core",
    "qa_click",
    "Click an element." + REF + " Or text: the one visible button, link or menu item with that text. "
    "clicked=false means the click was not seen to arrive; check the page before you retry." + ACT,
    tab | frame | target | {"text": S(1000), "button": E(["left", "right", "middle"]), "clickCount": I(1, 2)} | snap,
    ["tabId"],
)
field = Obj({"ref": S(40), "selector": S(2000), "value": S(65536), "values": A(S(4096), 100)})
tool(
    "core",
    "qa_fill",
    "Set form fields: fields=[{ref or selector, value}]. Text and password fields get the text, a "
    "select the option with that value or label (values for several), a checkbox or radio \"true\" or "
    "\"false\". Fires input and change events. Values are not echoed." + ACT,
    tab | frame | {"fields": A(field, 50)} | snap,
    ["tabId", "fields"],
)
tool(
    "core",
    "qa_type",
    "Type text into the focused element, or into ref or selector after focusing it. Then press key, "
    "if given: a name or chord such as Enter, Tab, Escape, ArrowDown, Control+A." + ACT,
    tab | frame | target | {"text": S(65536), "key": S(100)} | snap,
    ["tabId"],
)
tool(
    "core",
    "qa_wait",
    "Wait until the page is loaded and, if given, selector matches, text is on the page, textGone is "
    "not, and the tab URL contains url. timeoutMs default 30000." + ACT,
    tab | frame | {"selector": S(2000), "text": S(1000), "textGone": S(1000), "url": S(2000)} | timeout | snap,
    ["tabId"],
)
tool(
    "core",
    "qa_screenshot",
    "Capture the viewport, the whole page (fullPage), or one element (ref or selector). JPEG by default "
    "(quality 80), or png. maxSize limits width and height in pixels (default 2000 for an image in the "
    "result; a file keeps the full size).",
    tab
    | frame
    | target
    | {"fullPage": B, "format": E(["jpeg", "png"]), "quality": I(0, 100), "maxSize": I(16, 10000)}
    | file,
    ["tabId"],
)
step = Obj({"tool": S(40), "args": O}, ["tool"])
tool(
    "core",
    "qa_batch",
    "Run up to 50 tool calls on one tab, in order, in one call: steps=[{tool, args}], args without "
    "tabId. Stops at the first failure. Returns a short result per step and one page read at the end. "
    "Every check of each tool still applies.",
    tab | {"steps": A(step, 50)} | snap,
    ["tabId", "steps"],
)
tool(
    "core",
    "qa_dialog",
    "Inspect, accept or dismiss a JavaScript alert, confirm or prompt.",
    tab | {"action": E(["inspect", "accept", "dismiss"]), "promptText": S(10000)} | snap,
    ["tabId", "action"],
)
tool("core", "qa_hover", "Move the mouse over an element." + REF + ACT, tab | frame | target | snap, ["tabId"])
tool(
    "core",
    "qa_scroll",
    "Scroll an element into view (ref or selector), or scroll by deltaX and deltaY pixels at the "
    "viewport point x, y (default 100, 100)." + ACT,
    tab | frame | target | {"deltaX": N(), "deltaY": N(), "x": N(0), "y": N(0)} | snap,
    ["tabId"],
)
tool(
    "core",
    "qa_drag",
    "Drag with the mouse from ref (or fromX, fromY) to toRef (or toX, toY), in steps (default 10)." + ACT,
    tab
    | {"ref": S(40), "toRef": S(40), "fromX": N(0), "fromY": N(0), "toX": N(0), "toY": N(0), "steps": I(1, 100)}
    | snap,
    ["tabId"],
)
tool(
    "debug",
    "qa_console",
    "Console messages and page errors of a tab, from its last 3 pages, with source and stack. "
    "level: error, warning, info or debug (that level and worse). filter: text to find. "
    "offset and limit (default 50) page through the list.",
    tab | {"level": E(["error", "warning", "info", "debug"]), "filter": S(500)} | page | file,
    ["tabId"],
)
tool(
    "debug",
    "qa_network",
    "Network requests of a tab, from its last 3 pages: id, method, status, type, size, time, URL. "
    "filter: text in the URL; type: document, fetch, xhr, script...; failed=true: errors and status 400+. "
    "request: one request with headers and bodies (big bodies: use file). Cookies, tokens (also in "
    "URLs) and authorization values are hidden unless showSecrets=true.",
    tab | {"request": S(20), "filter": S(500), "type": S(40), "failed": B, "showSecrets": B} | page | file,
    ["tabId"],
)
tool(
    "debug",
    "qa_eval",
    "Run JavaScript in the page (main world) or a frame. Promises are awaited. Time and output are limited.",
    tab | frame | {"expression": S(131072), "timeoutMs": I(1, 30000), "maxOutputBytes": I(256, 10485760)} | file,
    ["tabId", "expression"],
)
tool(
    "debug",
    "qa_perf",
    "Speed and memory of a tab. action: metrics (default; load times, LCP, CLS, INP, long tasks, the "
    "limit slowest resources), throttle (cpu: slow-down factor, network: slow-3g, slow-4g, fast-4g, "
    "offline or none; then reload to measure), memory (JS heap after garbage collection, DOM nodes, "
    "listeners), leak (run steps once, then repeat times; report growth), trace (a DevTools trace of "
    "steps, or of a reload, saved to file).",
    tab
    | {
        "action": E(["metrics", "throttle", "memory", "leak", "trace"]),
        "limit": I(1, 50),
        "cpu": N(1, 20),
        "network": E(["slow-3g", "slow-4g", "fast-4g", "offline", "none"]),
        "steps": A(step, 50),
        "repeat": I(1, 50),
    }
    | file,
    ["tabId"],
)
tool(
    "files",
    "qa_record",
    "Record a claimed tab as an MP4 video (H.264), for example as proof for a pull request. "
    "action: start (file, maxSeconds default 60, fps default 10, maxSize default 1280 px), stop (saves "
    "the file and returns its path), status. A recording also stops at maxSeconds, at 9.5 MB, or when "
    "the tab closes; the file is saved at stop or when the session ends.",
    {
        "action": E(["start", "stop", "status"]),
        "maxSeconds": I(1, 600),
        "fps": I(1, 30),
        "maxSize": I(320, 1920),
    }
    | tab
    | file,
)
tool(
    "files",
    "qa_upload",
    "Set files on a file input." + REF + " paths: Windows paths or WSL paths (/mnt/c/..., /home/...).",
    tab | frame | target | {"paths": A(S(4096), 32)} | snap,
    ["tabId", "paths"],
)
tool(
    "files",
    "qa_downloads",
    "Downloads of the QA profile. action: list (default), start (tabId, url and filename: download with "
    "the tab's cookies into Downloads\\ChromeBridge\\<session>\\), adopt (claim a download a page started), "
    "wait (until your download ends). Files are never opened.",
    {"action": E(["list", "start", "adopt", "wait"]), "url": S(), "filename": S(300), "downloadId": I(0)}
    | tab
    | timeout,
)
tool(
    "device",
    "qa_emulate",
    "Emulate a device on a tab: viewport {width, height, deviceScaleFactor, mobile}, userAgent, "
    "geolocation {latitude, longitude, accuracy}, touch. reset=true clears them first.",
    tab
    | {
        "viewport": Obj({"width": I(1, 8192), "height": I(1, 8192), "deviceScaleFactor": N(0.5, 5), "mobile": B}),
        "userAgent": S(1000),
        "geolocation": Obj({"latitude": N(-90, 90), "longitude": N(-180, 180), "accuracy": N(0, 100000)}),
        "touch": B,
        "reset": B,
    },
    ["tabId"],
)
tool(
    "device",
    "qa_window",
    "Set the window of a claimed tab to normal, maximized, minimized or fullscreen. Without visible "
    "mode, maximized and fullscreen only resize the window, and focus=true is refused.",
    tab | {"state": E(["normal", "maximized", "minimized", "fullscreen"]), "focus": B},
    ["tabId", "state"],
)
tool(
    "data",
    "qa_storage",
    "Read or change localStorage, sessionStorage or cookies of the tab's site. area: local, session or "
    "cookies. action: get (key or all), set (key and value; for cookies: cookie {name, value, ...}), "
    "delete (key), clear.",
    tab
    | frame
    | {
        "area": E(["local", "session", "cookies"]),
        "action": E(["get", "set", "delete", "clear"]),
        "key": S(4096),
        "value": S(65536),
        "cookie": O,
    },
    ["tabId", "area", "action"],
)
tool(
    "cdp",
    "qa_cdp",
    "Run one raw Chrome DevTools Protocol command on a claimed tab or frame. Commands that reach the "
    "whole profile (Target, Browser, Storage, all cookies...) are blocked. events=true returns the "
    "events of the domains you enabled with qa_cdp since the last call.",
    tab | frame | {"method": S(120), "params": O, "events": B, "timeoutMs": I(1, 30000), "maxOutputBytes": I(256, 1048576)},
    ["tabId"],
)

for t in tools:
    assert t["inputSchema"]["required"] == [k for k in t["inputSchema"]["required"] if k in t["inputSchema"]["properties"]]
catalog = {"groups": GROUPS, "defaultGroups": DEFAULT_GROUPS, "tools": tools}
target_file = Path(__file__).resolve().parent / "catalog.json"
text = json.dumps(catalog, indent=2) + "\n"
if "--check" in sys.argv:
    sys.exit(0 if target_file.read_text(encoding="utf-8") == text else "host/catalog.json is out of date")
target_file.write_bytes(text.encode())
print(len(tools))
