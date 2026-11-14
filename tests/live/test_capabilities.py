"""Live test of every tool on the local fixture pages.

Run: python3 tests/live/test_capabilities.py [--display]

In display mode the session is not visible, so no call may bring a QA Chrome window to the front
(common.Foreground checks it for every live test).
"""

import base64
import json
import re
import struct
import tempfile
import time
import zlib
from pathlib import Path

from common import DISPLAY, EXE, VERSION, Client, eventually, lifecycle, ok, ref, refused, test_mode  # noqa: F401
import fixture
import manage

def jpeg_size(data):
    """(width, height) from the SOF marker of a JPEG."""
    at = 2
    while at < len(data):
        marker, size = data[at + 1], struct.unpack(">H", data[at + 2 : at + 4])[0]
        if marker in (0xC0, 0xC1, 0xC2):
            h, w = struct.unpack(">HH", data[at + 5 : at + 9])
            return w, h
        at += 2 + size
    raise AssertionError("no JPEG frame header")


def png_pixel(data, x, y):
    """RGB of one pixel of an 8-bit RGB or RGBA PNG, with the standard library only."""
    w, h, depth, kind = struct.unpack(">IIBB", data[16:26])
    assert depth == 8 and kind in (2, 6), (depth, kind)
    n = 3 if kind == 2 else 4
    raw, pos = b"", 8
    while pos < len(data):
        size, tag = struct.unpack(">I4s", data[pos : pos + 8])
        if tag == b"IDAT":
            raw += data[pos + 8 : pos + 8 + size]
        pos += 12 + size
    raw = zlib.decompress(raw)
    stride = w * n
    prev = bytearray(stride)
    for row in range(y + 1):
        f = raw[row * (stride + 1)]
        line = bytearray(raw[row * (stride + 1) + 1 : (row + 1) * (stride + 1)])
        for i in range(stride):
            a = line[i - n] if i >= n else 0
            b = prev[i]
            c = prev[i - n] if i >= n else 0
            if f == 1:
                line[i] = (line[i] + a) & 255
            elif f == 2:
                line[i] = (line[i] + b) & 255
            elif f == 3:
                line[i] = (line[i] + (a + b) // 2) & 255
            elif f == 4:
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                line[i] = (line[i] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        prev = line
    return tuple(prev[x * n : x * n + 3])




def call(c, n, **a):
    return c.result(n, **a)


def text(c, n, **a):
    return c.text(n, **a)


def both(c, n, **a):
    """(fields, page text) of a tool that returns the page."""
    r = c.call(n, **a)["content"]
    fields = json.loads(r[0]["text"]) if r[0]["text"].startswith("{") else {}
    return fields, r[-1]["text"] if len(r) > 1 or not fields else ""


def shot(c, **a):
    return c.call("qa_screenshot", **a)


def ev(expr, **a):
    return call(c, "qa_eval", tabId=t, expression=expr, **a)


def wsl_file(r):
    """A saved file: check the path is a WSL path, return its bytes."""
    assert r["path"].startswith(manage.MOUNT) and r["windowsPath"][1] == ":", r
    data = Path(r["path"]).read_bytes()
    assert len(data) == r["bytes"], r
    return data


file = Path(tempfile.mkdtemp()) / "dummy-upload.txt"
file.write_text("Native QA dummy upload\n")
APP = "http://127.0.0.1:18475/app"
ROOT_PAGE = "http://127.0.0.1:18475/"
clients = []
with test_mode():
    server = fixture.start()
    try:
        c = Client(EXE)
        c.initialize()
        clients.append(c)
        c2 = Client(EXE)
        c2.initialize()
        clients.append(c2)
        h = call(c, "qa_session", name="main")
        h2 = call(c2, "qa_session", name="second")
        ok("session_version_name_no_policy", h["version"] == VERSION and h["name"] == "main" and not h["policy"]["active"])
        ok("session_sees_other_names", "second" in call(c, "qa_session")["sessions"])
        ok("names_are_unique", "already named" in refused(lambda: call(c2, "qa_session", name="main")))
        headless = h["display"]["mode"] == "headless"
        ok("window_mode_as_configured", headless != DISPLAY)
        if headless:
            ok("visible_refused_when_headless", "headless" in refused(lambda: call(c, "qa_session", visible=True)))
        call(c, "qa_session", visible=False)
        # Tool errors are tool results with isError, so the agent sees the reason.
        bad = c.request("tools/call", {"name": "qa_navigate", "arguments": {"tabId": 1, "url": "file:///C:/"}})
        ok("argument_error_is_a_tool_error", bad.get("isError") and "HTTP(S)" in bad["content"][0]["text"])
        ok("unknown_tool_is_a_protocol_error", "Unknown tool" in refused(lambda: c.request("tools/call", {"name": "qa_nope"})))
        ok("file_name_not_a_path", "not a path" in refused(lambda: call(c, "qa_snapshot", tabId=1, file="../x.txt")))

        # Open a page: one call opens, waits and reads it.
        opened, tree = both(c, "qa_tabs", action="new", url=ROOT_PAGE)
        t = opened["tabId"]
        ok("new_tab_returns_the_page", opened["loaded"] and 'button "Sign in"' in tree and "[frame f1]" in tree)
        # The login fields have no name: the read shows their id, and marks the empty password field.
        ok("nameless_and_password_fields_marked", re.search(r'textbox \[e\d+\] \[id="user"\]', tree)
           and re.search(r'textbox \[e\d+\] \[password\] \[id="password"\]', tree))
        filled = call(c, "qa_window", tabId=t, state="maximized", focus=False)
        ok("maximized_by_size_without_focus", filled["filledBy"] == "size")
        call(c, "qa_window", tabId=t, state="normal", focus=False)
        ok("focus_needs_visible", "visible=true" in refused(lambda: call(c, "qa_window", tabId=t, state="normal", focus=True)))

        # Login: several fields in one call, then a click that returns what changed.
        r, changes = both(c, "qa_fill", tabId=t, fields=[
            {"selector": "#user", "value": "qa-user"},
            {"selector": "#password", "value": "Dummy-Only-Password-42"},
            {"selector": "#hidden", "value": "dummy-token"},
        ])
        ok("fill_several_fields", r["filled"] == 3 and "qa-user" in changes)
        ok("password_value_never_shown", "Dummy-Only-Password-42" not in changes
           and "Dummy-Only-Password-42" not in text(c, "qa_snapshot", tabId=t, full=True))
        r, changes = both(c, "qa_click", tabId=t, ref=ref(tree, 'button "Sign in"'))
        ok("click_returns_the_change", r["clicked"] and "Signed in" in changes and "Changes since the last read" in changes)
        ok("unchanged_page_reads_short", "No changes since the last read" in text(c, "qa_snapshot", tabId=t))

        call(c, "qa_upload", tabId=t, selector="#upload", paths=[str(file)], snapshot=False)
        eventually(lambda: ev('document.querySelector("#fileStatus").textContent'), lambda x: x == "Uploaded dummy-upload.txt")
        ok("wsl_local_file_upload")
        # A network path would make Windows connect to that server with the user's login.
        started = time.monotonic()
        for unc in ["\\\\192.0.2.1\\share\\x.txt", "\\\\?\\UNC\\192.0.2.1\\share\\x.txt", "\\/192.0.2.1/share/x.txt",
                    "\\??\\UNC\\192.0.2.1\\share\\x.txt", "\\\\wsl.localhost\\..\\192.0.2.1\\share\\x.txt"]:
            msg = refused(lambda: call(c, "qa_upload", tabId=t, selector="#upload", paths=[unc], snapshot=False))
            assert "Network paths" in msg, (unc, msg)
        ok("network_upload_path_refused", time.monotonic() - started < 5)
        # The agent's WSL, as manage.py passes it: another mount root (/etc/wsl.conf) and distro.
        with Client(EXE, ["--mcp", "--wsl-distro", "NoSuchDistro", "--wsl-root", "/win/"]) as other:
            other.initialize()
            ok("output_folder_uses_mount_root", call(other, "qa_session")["outputFolder"].startswith("/win/c/"))
            ot = call(other, "qa_tabs", action="new", url=ROOT_PAGE, snapshot=False)["tabId"]
            saved = call(other, "qa_snapshot", tabId=ot, file="mount-root.txt")["saved"]
            ok("saved_file_uses_mount_root", saved["path"].startswith("/win/c/"))
            call(other, "qa_upload", tabId=ot, selector="#upload", paths=[saved["path"]], snapshot=False)
            ok("upload_from_mount_root", call(other, "qa_eval", tabId=ot, expression='document.querySelector("#upload").files[0].name') == "mount-root.txt")
            msg = refused(lambda: call(other, "qa_upload", tabId=ot, selector="#upload", paths=[str(file)], snapshot=False))
            ok("upload_uses_agent_distro", "\\\\wsl.localhost\\NoSuchDistro\\" in msg)
        d = call(c, "qa_downloads", action="start", tabId=t, url="http://127.0.0.1:18475/download", filename="dummy-download.txt")
        d = call(c, "qa_downloads", action="wait", downloadId=d["downloadId"])
        ok("authenticated_download", d["state"] == "complete" and d["totalBytes"] == 39)
        call(c, "qa_click", tabId=t, selector="#download", snapshot=False)
        rows = eventually(lambda: call(c, "qa_downloads")["downloads"], lambda x: any(r["owner"] == "unclaimed" for r in x))
        normal = next(r for r in rows if r["owner"] == "unclaimed")
        call(c, "qa_downloads", action="adopt", downloadId=normal["id"])
        ok("page_download_adopt_wait", call(c, "qa_downloads", action="wait", downloadId=normal["id"])["state"] == "complete")
        d = call(c, "qa_downloads", action="start", tabId=t, url="http://127.0.0.1:18475/download", filename="harmless-never-run.exe")
        d = call(c, "qa_downloads", action="wait", downloadId=d["downloadId"])
        # Nothing can open it: Chrome lets an extension open a download only with the "downloads.open"
        # permission, which the installed extension does not have, and no bridge code asks to.
        installed = EXE.parent / "extension"
        permissions = json.loads((installed / "manifest.json").read_text())["permissions"]
        code = "".join(f.read_text(encoding="utf-8") for f in installed.glob("*.js"))
        ok("executable_download_never_opened", d["state"] in ("complete", "interrupted") and "downloads.open" not in permissions
           and not re.search(r"downloads\.(open|show)\b", code))

        # Tokens in URLs: hidden in page reads and network lists, shown only when asked.
        _, read_ = both(c, "qa_navigate", tabId=t, url=ROOT_PAGE + "?token=Dummy-Url-Token&lang=en")
        net = text(c, "qa_network", tabId=t, filter="lang=en")
        ok("url_tokens_hidden", "Dummy-Url-Token" not in read_ + net and "token=(hidden)&lang=en" in read_ and "token=(hidden)" in net)
        ok("url_tokens_shown_when_asked", "Dummy-Url-Token" in text(c, "qa_network", tabId=t, filter="lang=en", showSecrets=True))
        ok("arbitrary_async_eval", ev("Promise.resolve({answer:6*7})") == {"answer": 42})
        r = call(c, "qa_cdp", tabId=t, method="Runtime.evaluate", params={"expression": "21*2", "returnByValue": True})
        ok("raw_cdp", r["result"]["value"] == 42)
        ok("eval_output_bounded", ev("'x'.repeat(5000)", maxOutputBytes=256)["truncated"])
        ok("eval_schema_bounded", bool(refused(lambda: ev("1", timeoutMs=30001))))
        saved = call(c, "qa_eval", tabId=t, expression="({big: 'y'.repeat(300000)})", file="eval.json")["saved"]
        ok("eval_to_file", json.loads(wsl_file(saved))["big"] == "y" * 300000)
        # Page values are data: an eval result that looks like a file request stays a plain value.
        fake = {"$file": {"name": "fake.txt", "text": "x"}, "saved": {"$file": {"name": "fake2.txt", "text": "x"}}}
        ok("page_value_cannot_write_files", call(c, "qa_eval", tabId=t, expression="(" + json.dumps(fake) + ")") == fake
           and not any((Path(h["outputFolder"]) / x).exists() for x in ("fake.txt", "fake2.txt")))
        for n, a in [("qa_eval", {"expression": "1"}), ("qa_cdp", {"method": "Runtime.evaluate", "params": {"expression": "1"}})]:
            refused(lambda n=n, a=a: call(c2, n, tabId=t, **a))
        refused(lambda: call(c2, "qa_tabs", action="adopt", tabId=t))
        ok("claim_conflicts_and_eval_cdp_isolation")
        ok("raw_target_management_contained", "blocks" in refused(lambda: call(c, "qa_cdp", tabId=t, method="Target.getTargets", params={})))

        # Popups, adopt, transfer by name, release, keep.
        call(c, "qa_click", tabId=t, selector="#popup", snapshot=False)
        listing = eventually(lambda: call(c, "qa_tabs"), lambda x: any(tb.get("openedBy") == t for w in x["windows"] for tb in w["tabs"]))
        tabs = [tb for w in listing["windows"] for tb in w["tabs"]]
        popup = next(x for x in tabs if x.get("openedBy") == t)
        ok("popup_listed_unclaimed", popup["owner"] == "unclaimed" and next(x for x in tabs if x["id"] == t)["owner"] == "you")
        p = popup["id"]
        call(c, "qa_tabs", action="adopt", tabId=p)
        ok("transfer_by_name", call(c, "qa_tabs", action="transfer", tabId=p, toSession="second")["to"] == "second")
        refused(lambda: call(c, "qa_eval", tabId=p, expression="1"))
        mine = [x for w in call(c, "qa_tabs")["windows"] for x in w["tabs"] if x["id"] == p][0]
        ok("owner_name_in_list", mine["owner"] == "second" and p in [x["id"] for x in call(c2, "qa_session")["tabs"]])
        call(c2, "qa_tabs", action="release", tabId=p)
        call(c, "qa_tabs", action="adopt", tabId=p)
        ok("release_readopt")
        call(c, "qa_tabs", action="close", tabId=p)
        if DISPLAY:
            # 3 s after a click, with no tool call running, the page opens a tab, then a popup window (one click
            # each: Chrome allows one window.open per click). Chrome may bring them to the front; the foreground
            # check fails if QA Chrome stays there.
            u = call(c, "qa_tabs", action="new", url=ROOT_PAGE + "later", snapshot=False)["tabId"]
            for button in ("#tabLater", "#windowLater"):
                call(c, "qa_click", tabId=u, selector=button, snapshot=False)
                time.sleep(6)
            later = [x for w in call(c, "qa_tabs")["windows"] for x in w["tabs"] if x.get("openedBy") == u]
            for x in later:
                call(c, "qa_tabs", action="adopt", tabId=x["id"])
                call(c, "qa_tabs", action="close", tabId=x["id"])
            call(c, "qa_tabs", action="close", tabId=u)
            ok("page_opens_later", len(later) == 2)

        call(c, "qa_storage", tabId=t, area="local", action="set", key="qa", value="storage")
        ok("storage", call(c, "qa_storage", tabId=t, area="local", action="get", key="qa")["value"] == "storage")
        ok("storage_all_items", call(c, "qa_storage", tabId=t, area="local", action="get")["items"] == {"qa": "storage"})
        call(c, "qa_storage", tabId=t, area="local", action="delete", key="qa")
        call(c, "qa_storage", tabId=t, area="cookies", action="set", cookie={"name": "qa-test", "value": "cookie"})
        ok("cookies", any(x["name"] == "qa-test" for x in call(c, "qa_storage", tabId=t, area="cookies", action="get")["cookies"]))
        call(c, "qa_storage", tabId=t, area="cookies", action="delete", key="qa-test")
        ok("cookie_deleted", not call(c, "qa_storage", tabId=t, area="cookies", action="get", key="qa-test")["cookies"])

        # Select by label, typing and key chords.
        call(c, "qa_fill", tabId=t, fields=[{"selector": "#choice", "value": "B"}], snapshot=False)
        ok("select_by_label", ev('document.querySelector("#choice").value') == "b")
        call(c, "qa_type", tabId=t, selector="#typing", text="typed", key="Shift+a", snapshot=False)
        ok("type_text_then_key", ev('document.querySelector("#typing").value') == "typedA")
        call(c, "qa_type", tabId=t, key="Control+A", snapshot=False)
        call(c, "qa_type", tabId=t, key="Backspace", snapshot=False)
        call(c, "qa_type", tabId=t, text="B", snapshot=False)
        ok("key_chords", ev('document.querySelector("#typing").value') == "B")
        ok("fill_strict", "exactly one" in refused(lambda: call(c, "qa_fill", tabId=t, fields=[{"selector": "input", "value": "x"}])))
        ok("fill_reports_the_field", "Field 2 (#nope)" in refused(lambda: call(
            c, "qa_fill", tabId=t, fields=[{"selector": "#user", "value": "x"}, {"selector": "#nope", "value": "x"}])))

        # Page reads on the app page: refs, views, changes, files.
        _, tree = both(c, "qa_navigate", tabId=t, url=APP)
        ok("navigate_returns_full_page", tree.startswith('Page "Fixture app"') and 'textbox "Name"' in tree
           and "Changes since" not in tree)
        ok("prefilled_password_hidden", "Dummy-Prefilled-Secret" not in tree and 'textbox "Password"' in tree and "(hidden)" in tree)
        name = ref(tree, 'textbox "Name"')
        ok("ref_stable", name == ref(text(c, "qa_snapshot", tabId=t, full=True), 'textbox "Name"'))
        inter = text(c, "qa_snapshot", tabId=t, interactive=True)
        ok("interactive_view", 'button "Send"' in inter and "columnheader" not in inter and "heading" not in inter)
        found = text(c, "qa_snapshot", tabId=t, search="cake")
        ok("search_view", '1 matches for "cake"' in found and 'cell "Cake"' in found and "row" in found)
        ok("depth_view", "inside)" in text(c, "qa_snapshot", tabId=t, depth=1))
        form = ref(tree, "form [")
        sub = text(c, "qa_snapshot", tabId=t, ref=form)
        ok("subtree_view", 'button "Send"' in sub and "table" not in sub)
        ok("max_chars", "[Cut at 1000 characters" in text(c, "qa_snapshot", tabId=t, full=True, maxChars=1000) or len(tree) < 1000)
        saved = call(c, "qa_snapshot", tabId=t, full=True, file="page.txt")["saved"]
        ok("page_read_to_file", b'textbox "Name"' in wsl_file(saved))
        r, changes = both(c, "qa_fill", tabId=t, fields=[
            {"ref": name, "value": "qa-user"},
            {"ref": ref(tree, 'textbox "Email"'), "value": "qa@example.com"},
            {"ref": ref(tree, 'checkbox "I agree"'), "value": "true"},
            {"ref": ref(tree, 'combobox "Topic"'), "value": "b"},
        ])
        ok("fill_by_ref_returns_changes", "~ - textbox \"Name\"" in changes and "[checked]" in changes and ": Bug" in changes)
        r, changes = both(c, "qa_click", tabId=t, text="Send")
        ok("click_by_text_waits_for_the_request", r["clicked"] and "Thanks, qa-user" in changes)
        ok("full_read_on_request", "Changes since" not in text(c, "qa_snapshot", tabId=t, full=True))

        # Waiting for text, text gone and URL.
        call(c, "qa_click", tabId=t, selector="#later", snapshot=False)
        _, changes = both(c, "qa_wait", tabId=t, text="Done later", timeoutMs=5000)
        ok("wait_for_text", "Done later" in changes)
        _, changes = both(c, "qa_wait", tabId=t, textGone="Thanks, qa-user", timeoutMs=5000)
        ok("wait_for_text_gone", "Done later" in changes or "No changes" in changes)
        ok("wait_timeout_says_what", "text \"never there\"" in refused(lambda: call(c, "qa_wait", tabId=t, text="never there", timeoutMs=500)))
        ok("wait_for_url", call(c, "qa_wait", tabId=t, url="/app", snapshot=False)["waited"])

        # Console and network of the app page.
        call(c, "qa_click", tabId=t, selector="#boom", snapshot=False)
        log = eventually(lambda: text(c, "qa_console", tabId=t), lambda x: "Cannot read properties of null" in x)
        ok("console_messages", "[info] app ready 42" in log and "[warning] fixture warning" in log)
        errors = text(c, "qa_console", tabId=t, level="error")
        ok("console_error_with_source_and_stack", "Uncaught TypeError" in errors and "(/app:" in errors and "    at " in errors
           and "app ready" not in errors)
        ok("console_filter", "fixture warning" in text(c, "qa_console", tabId=t, filter="WARNING"))
        none = text(c, "qa_console", tabId=t, filter="no-such-message")
        ok("console_no_match_says_levels", none.startswith("0 messages match") and re.search(r"By level: .*\d+ error", none))
        ok("console_to_file", b"app ready" in wsl_file(call(c, "qa_console", tabId=t, file="console.txt")["saved"]))
        net = text(c, "qa_network", tabId=t)
        ok("network_list", "POST 200 fetch" in net and "/api/send" in net and "GET 200 document" in net)
        rid = re.search(r"^(r\d+) POST 200 fetch .*/api/send$", net, re.M).group(1)
        detail = text(c, "qa_network", tabId=t, request=rid)
        ok("network_secrets_hidden", "Bearer dummy-secret-token" not in detail and "Dummy-Body-Secret" not in detail
           and "dummy-response-token" not in detail and "dummy-cookie-secret" not in detail
           and "qa@example.com" in detail and "Thanks, qa-user" in detail)
        shown = text(c, "qa_network", tabId=t, request=rid, showSecrets=True)
        ok("network_secrets_on_request", "Bearer dummy-secret-token" in shown and "Dummy-Body-Secret" in shown)
        body = call(c, "qa_network", tabId=t, request=rid, file="body.json")["saved"]
        ok("network_body_to_file", json.loads(wsl_file(body))["message"] == "Thanks, qa-user")
        ok("network_filter", "/api/send" not in text(c, "qa_network", tabId=t, type="document"))

        call(c, "qa_navigate", tabId=t, url="http://127.0.0.1:18475/child", snapshot=False)
        both_pages = text(c, "qa_network", tabId=t)
        ok("network_kept_across_pages", "-- page" in both_pages and "/api/send" in both_pages and "/child" in both_pages)
        ok("console_kept_across_pages", "app ready" in text(c, "qa_console", tabId=t))
        ok("history_back", call(c, "qa_navigate", tabId=t, action="back", snapshot=False)["loaded"]
           and ev("location.pathname") == "/app")
        call(c, "qa_navigate", tabId=t, action="reload", snapshot=False)

        # A cross-site frame (localhost inside 127.0.0.1): its requests from its first moment, and a click in it.
        _, tree = both(c, "qa_navigate", tabId=t, url="http://127.0.0.1:18475/xframe")
        r = call(c, "qa_click", tabId=t, ref=ref(tree, 'button "Frame send"'), snapshot=False)
        net = eventually(lambda: text(c, "qa_network", tabId=t, filter="xframe"), lambda x: "from=click" in x, seconds=5)
        ok("cross_site_frame_click", r["clicked"])
        ok("cross_site_frame_requests", "POST 200 fetch" in net and "from=load" in net and "from=click" in net)
        rid = re.search(r"^(r\d+) POST .*from=load", net, re.M).group(1)
        ok("cross_site_frame_request_body", '{"frame":"inner"}' in text(c, "qa_network", tabId=t, request=rid))
        frame_doc = [x for x in text(c, "qa_network", tabId=t, type="document").splitlines() if x.endswith("/xchild")]
        ok("cross_site_frame_document_size", frame_doc and " - - " not in frame_doc[0])

        # A page that never goes quiet (a poll every 150 ms and an open stream): actions still return at once.
        call(c, "qa_navigate", tabId=t, url="http://127.0.0.1:18475/busy", snapshot=False)
        eventually(lambda: ev("+document.querySelector('#polls').textContent"), lambda n: n >= 3, seconds=5)
        start = time.monotonic()
        _, changes = both(c, "qa_click", tabId=t, selector="#go")
        seconds = round(time.monotonic() - start, 2)
        ok("busy_page_click_returns_" + str(seconds) + "s", "Clicked" in changes and seconds < 1.5)
        call(c, "qa_navigate", tabId=t, url=APP, snapshot=False)

        # Batch: several steps, one page read at the end; stop at the first failure.
        _, tree = both(c, "qa_snapshot", tabId=t, full=True)
        r, changes = both(c, "qa_batch", tabId=t, steps=[
            {"tool": "qa_fill", "args": {"fields": [{"ref": ref(tree, 'textbox "Name"'), "value": "batch-user"}]}},
            {"tool": "qa_click", "args": {"ref": ref(tree, 'button "Send"')}},
            {"tool": "qa_wait", "args": {"text": "Thanks, batch-user"}},
            {"tool": "qa_screenshot", "args": {"file": "batch-shot"}},
        ])
        ok("batch_runs_steps", r["done"] == 4 and all(x["ok"] for x in r["steps"]) and "Thanks, batch-user" in changes)
        ok("batch_screenshot_file", wsl_file(r["steps"][3]["saved"])[:2] == b"\xff\xd8")
        r = call(c, "qa_batch", tabId=t, snapshot=False, steps=[
            {"tool": "qa_eval", "args": {"expression": "window.batchStep = 1"}},
            {"tool": "qa_click", "args": {"selector": "#missing"}},
            {"tool": "qa_eval", "args": {"expression": "window.batchStep = 3"}},
        ])
        ok("batch_stops_at_first_failure", r["done"] == 1 and not r["steps"][1]["ok"] and len(r["steps"]) == 2
           and ev("window.batchStep") == 1)
        ok("batch_checks_each_step", "Step 1 (qa_screenshot)" in refused(lambda: call(
            c, "qa_batch", tabId=t, steps=[{"tool": "qa_screenshot", "args": {"file": "a/b"}}])))
        ok("batch_no_tab_tools", "cannot be a qa_batch step" in refused(lambda: call(
            c, "qa_batch", tabId=t, steps=[{"tool": "qa_tabs", "args": {}}])))
        # A batch that runs out of time stops there: no later step runs, and the tab stays busy until
        # the step that was running ends.
        slow = {"tool": "qa_eval", "args": {"expression": "new Promise(r => setTimeout(r, 14000))", "timeoutMs": 20000}}
        start = time.monotonic()
        try:
            outcome = call(c, "qa_batch", tabId=t, snapshot=False, steps=[slow, slow, slow, {
                "tool": "qa_eval", "args": {"expression": "window.lateStep = 4"}}])
        except RuntimeError as e:
            outcome = str(e)
        print("batch out of time after %.1f s: %s" % (time.monotonic() - start, outcome), flush=True)
        busy = refused(lambda: ev("1"))
        time.sleep(max(0, 47 - (time.monotonic() - start)))
        late = ev("window.lateStep")
        ok("batch_out_of_time_stops", isinstance(outcome, dict) and outcome["done"] == 2 and len(outcome["steps"]) == 3
           and "timed out" in outcome["steps"][2]["error"])
        ok("tab_busy_until_the_step_ends", "in progress" in busy)
        ok("no_step_after_the_batch_returned", late is None)

        # Screenshots: JPEG by default, a pixel cap, files.
        img = shot(c, tabId=t)["content"][0]
        ok("screenshot_jpeg_default", img["mimeType"] == "image/jpeg" and base64.b64decode(img["data"])[:2] == b"\xff\xd8")
        small = call(c, "qa_screenshot", tabId=t, maxSize=200, file="small")
        ok("screenshot_max_size_to_file", small["width"] <= 200 and small["height"] <= 200
           and small["saved"]["path"].endswith("small.jpg") and wsl_file(small["saved"])[:2] == b"\xff\xd8")
        el = shot(c, tabId=t, ref=ref(tree, 'button "Send"'), format="png")["content"][0]
        ok("element_png_screenshot", el["mimeType"] == "image/png")
        dpr = ev("devicePixelRatio")
        el_w, el_h = struct.unpack(">II", base64.b64decode(el["data"])[16:24])
        box = ev("(() => { const r = document.querySelector('#send').getBoundingClientRect(); return [r.width, r.height]; })()")
        ok("element_screenshot_at_device_pixels", abs(el_w - box[0] * dpr) <= 2 and abs(el_h - box[1] * dpr) <= 2)
        full = shot(c, tabId=t, fullPage=True)
        dpr, page_w, page_h = ev("[devicePixelRatio, document.documentElement.scrollWidth, document.documentElement.scrollHeight]")
        size = jpeg_size(base64.b64decode(full["content"][0]["data"]))
        print("devicePixelRatio", dpr, "full page", page_w, "x", page_h, "image", size, flush=True)
        ok("full_page_screenshot_at_device_pixels", abs(size[0] - round(page_w * dpr)) <= 2 and abs(size[1] - round(page_h * dpr)) <= 2)
        small = call(c, "qa_screenshot", tabId=t, fullPage=True, maxSize=300, file="full-small")
        ok("full_page_max_size", max(jpeg_size(wsl_file(small["saved"]))) <= 300)
        ev('document.querySelector("#name").remove(); true')
        ok("stale_ref", "stale" in refused(lambda: call(c, "qa_fill", tabId=t, fields=[{"ref": ref(tree, "textbox \"Name\""), "value": "x"}])))
        ok("unknown_ref", "Unknown ref" in refused(lambda: call(c, "qa_click", tabId=t, ref="e999999")))

        # qa_cdp keeps to the claimed tab; its event reader.
        ok("cdp_all_cookies_blocked", "blocks" in refused(lambda: call(c, "qa_cdp", tabId=t, method="Network.getAllCookies", params={})))
        ok("cdp_storage_blocked", "blocks" in refused(lambda: call(c, "qa_cdp", tabId=t, method="Storage.getCookies", params={})))
        ok("cdp_tab_cookies", "cookies" in call(c, "qa_cdp", tabId=t, method="Network.getCookies", params={}))
        call(c, "qa_cdp", tabId=t, method="Runtime.enable", params={})
        ev("console.info('reader event'); true")
        got = eventually(lambda: call(c, "qa_cdp", tabId=t, events=True)["events"], lambda x: any(e["method"] == "Runtime.consoleAPICalled" for e in x), seconds=5)
        ok("cdp_event_reader", "Runtime" in call(c, "qa_cdp", tabId=t, events=True)["domains"] and got)

        # Background click from another session's window does not take OS focus.
        t2 = call(c2, "qa_tabs", action="new", url=ROOT_PAGE, newWindow=True, snapshot=False)["tabId"]
        background = call(c2, "qa_click", tabId=t2, selector="#mouse", snapshot=False)
        ok("background_click_without_focus", background["clicked"] and (headless or not call(c2, "qa_session")["window"]["focused"]))
        call(c2, "qa_tabs", action="close", tabId=t2)

        # A tab that is not the active tab of its window: reads, eval and screenshots still work.
        front = call(c, "qa_tabs", action="new", url=ROOT_PAGE, snapshot=False)["tabId"]
        rows = {x["id"]: x for w in call(c, "qa_tabs")["windows"] for x in w["tabs"]}
        ok("other_tab_is_active", rows[front].get("active") and not rows[t].get("active"))
        ok("background_tab_read", 'button "Send"' in text(c, "qa_snapshot", tabId=t, full=True) and ev("document.title") == "Fixture app")
        bg = call(c, "qa_screenshot", tabId=t, file="background-tab")
        w, h = jpeg_size(wsl_file(bg["saved"]))
        ok("background_tab_screenshot", (w, h) == (bg["width"], bg["height"]) and w > 300 and h > 300)
        rows = {x["id"]: x for w in call(c, "qa_tabs")["windows"] for x in w["tabs"]}
        ok("background_tab_stays_in_background", rows[front].get("active") and not rows[t].get("active"))
        call(c, "qa_tabs", action="close", tabId=front)

        # Mouse: hover, double and right click, drag, scroll.
        call(c, "qa_navigate", tabId=t, url=ROOT_PAGE, snapshot=False)
        call(c, "qa_hover", tabId=t, selector="#mouse", snapshot=False)
        call(c, "qa_click", tabId=t, selector="#mouse", clickCount=2, snapshot=False)
        call(c, "qa_click", tabId=t, selector="#mouse", button="right", snapshot=False)
        counts = ev("counts")
        ok("hover_double_right_click", counts.get("mouseenter", 0) > 0 and counts.get("dblclick", 0) > 0 and counts.get("contextmenu", 0) > 0)
        call(c, "qa_drag", tabId=t, fromX=25, fromY=100, toX=130, toY=150, steps=5, snapshot=False)
        call(c, "qa_scroll", tabId=t, deltaX=0, deltaY=500, snapshot=False)
        eventually(lambda: ev("scrollY"))
        call(c, "qa_scroll", tabId=t, selector="#signin", snapshot=False)
        ok("drag_scroll", ev("scrollY") < 500)

        # Frames: refs and frame names from the page read.
        tree = text(c, "qa_snapshot", tabId=t, full=True)
        fref = ref(tree, "f1e")
        call(c, "qa_fill", tabId=t, fields=[{"selector": "#childInput", "value": "frame text"}], frameId="f1", snapshot=False)
        ok("frame_name_for_frameId", call(c, "qa_eval", tabId=t, frameId="f1", expression='document.querySelector("#childInput").value') == "frame text")
        call(c, "qa_fill", tabId=t, fields=[{"ref": ref(tree, "textbox [f1e"), "value": "frame ref"}], snapshot=False)
        ok("frame_ref_fill", fref.startswith("f1") and call(c, "qa_eval", tabId=t, frameId="f1", expression='document.querySelector("#childInput").value') == "frame ref")
        ok("frame_view", 'button "Child click"' in text(c, "qa_snapshot", tabId=t, frameId="f1"))

        # Emulation, in one tool.
        call(c, "qa_emulate", tabId=t, userAgent="NativeQA-test", geolocation={"latitude": 12.9, "longitude": 77.6}, touch=True)
        ok("emulation_ua", ev("navigator.userAgent") == "NativeQA-test")
        call(c, "qa_emulate", tabId=t, viewport={"width": 390, "height": 844, "mobile": True})
        ok("emulation_mobile", ev("screen.width") == 390)
        call(c, "qa_emulate", tabId=t, reset=True)
        ok("emulation_reset", ev("screen.width") != 390 and ev("navigator.userAgent") != "NativeQA-test")

        # A dialog opened by a click: the click says so; the dialog answer returns the page.
        r = call(c, "qa_click", tabId=t, selector="#dialog")
        ok("click_reports_dialog", r["dialog"]["type"] == "prompt" and "qa_dialog" in r["note"])
        call(c, "qa_dialog", tabId=t, action="accept", promptText="fixture answer", snapshot=False)
        ok("dialog", ev("window.answer") == "fixture answer")

        # Pixel check of an element on a scrolled page, and a very tall page.
        call(c, "qa_navigate", tabId=t, url="http://127.0.0.1:18475/shot", snapshot=False)
        ev("scrollTo(0, 1000); scrollY")
        red = base64.b64decode(shot(c, tabId=t, selector="#red", format="png")["content"][0]["data"])
        ok("element_screenshot_scrolled", png_pixel(red, 60, 30) == (255, 0, 0))
        # A file keeps the full size: this page is 4560 CSS px high, more than the 2000 px limit of an image in the result.
        dpr = ev("devicePixelRatio")
        tall_file = call(c, "qa_screenshot", tabId=t, fullPage=True, file="shot-full.jpg")
        ok("full_page_file_not_scaled", "scaledFrom" not in tall_file and abs(jpeg_size(wsl_file(tall_file["saved"]))[1] - round(4560 * dpr)) <= 2)
        # An image in the result is at most 2000 px. A page this tall would be a thin strip, so it shows the top at half size.
        call(c, "qa_navigate", tabId=t, url="http://127.0.0.1:18475/tall", snapshot=False)
        content = shot(c, tabId=t, fullPage=True, format="png")["content"]
        w, h = struct.unpack(">II", base64.b64decode(content[0]["data"])[16:24])
        fields = json.loads(content[1]["text"])
        part_w, part_h = map(int, fields["scaledFrom"].split("x"))
        print("tall page", fields, flush=True)
        ok("tall_full_page_shows_the_top", (w, h) == (fields["width"], fields["height"]) and 1990 <= h <= 2000
           and abs(part_h - 4000) <= 2 and abs(w - part_w / 2) <= 1 and fields["pageHeight"] >= 40000 * dpr and "file" in fields["note"])
        whole = json.loads(shot(c, tabId=t, fullPage=True, maxSize=2000)["content"][1]["text"])
        ok("tall_full_page_max_size_fits_all", whole["height"] <= 2000 and "pageHeight" not in whole
           and int(whole["scaledFrom"].split("x")[1]) >= 40000 * dpr)

        # Page read speed and size with 1500 buttons.
        call(c, "qa_navigate", tabId=t, url="http://127.0.0.1:18475/many", snapshot=False)
        start = time.monotonic()
        big = text(c, "qa_snapshot", tabId=t, full=True, maxChars=1000000)
        seconds = round(time.monotonic() - start, 2)
        ok("read_1500_buttons_" + str(seconds) + "s", big.count("- button") == 1500 and seconds < 10)
        ok("read_cut_by_default", "[Cut at 30000 characters" in text(c, "qa_snapshot", tabId=t, full=True))

        # Keep open: cleanup leaves a kept tab.
        kept = call(c, "qa_tabs", action="new", url=ROOT_PAGE, keepOpen=True, snapshot=False)["tabId"]
        r = call(c, "qa_tabs", action="cleanup")
        ok("cleanup_leaves_kept_tab", kept in r["kept"] and t in r["closed"])
        ok("kept_tab_still_claimed", [x["id"] for x in call(c, "qa_session")["tabs"]] == [kept])
        call(c, "qa_tabs", action="keep", tabId=kept, keepOpen=False)
        call(c, "qa_tabs", action="cleanup")
        ok("owned_cleanup", not call(c, "qa_session")["tabs"])
        print("ALL PASS", flush=True)
    finally:
        for c in clients:
            c.close()
        server.shutdown()
    eventually(lambda: lifecycle("snapshot"), lambda x: x == [], seconds=15)
    ok("qa_chrome_stopped_after_last_client")
