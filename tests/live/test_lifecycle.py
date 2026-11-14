"""Live test of how QA Chrome starts and stops, the session and tab limits, tool groups, and kept tabs.

Run: python3 tests/live/test_lifecycle.py [--display]
"""

import json
import os
import signal
import threading
import time

from common import EXE, ROOT, VERSION, Client, chrome_closed, closed_down, eventually, lifecycle, ok, refused, set_config, test_mode
import fixture



def old_folder(name, days):
    """An output folder with one file, last changed days ago."""
    folder = ROOT / "output" / name
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "page.txt").write_text("old output")
    when = time.time() - days * 86400
    os.utime(folder / "page.txt", (when, when))
    os.utime(folder, (when, when))
    return folder


with test_mode(maxSessions=3, maxTabsPerSession=2, keepOutputDays=3):
    server = fixture.start()
    page = "http://localhost:%d/" % fixture.PORT
    clients = []
    try:
        # At start, QA Chrome removes session output folders older than keepOutputDays (3 here), and nothing else.
        old = old_folder("a" * 32, 4)
        recent = old_folder("b" * 32, 2)
        other = old_folder("keep-me", 30)
        # MCP version negotiation: the client's version when the server has it, else the server's newest.
        with Client(EXE) as c:
            answers = [c.request("initialize", {"protocolVersion": v, "capabilities": {}, "clientInfo": {"name": "t", "version": "1"}})
                       ["protocolVersion"] for v in ("2025-06-18", "2024-11-05", "2099-01-01", "2025-11-25")]
            ok("protocol_version_negotiated", answers == ["2025-06-18", "2024-11-05", "2025-11-25", "2025-11-25"])
            # An old client gets exactly what it got before 2026-07-28 support: no resultType, no cache fields.
            tools = c.request("tools/list")
            ok("legacy_results_unchanged", set(tools) == {"tools"} and c.request("ping") == {})
        # Cold start: the first tool call starts QA Chrome. When the client leaves, Chrome stops.
        with Client(EXE) as c:
            c.initialize()
            tab = c.result("qa_tabs", action="new", url=page, snapshot=False)["tabId"]
            ok("cold_start", c.result("qa_wait", tabId=tab, selector="#signin", snapshot=False)["waited"])
            ok("old_output_removed", eventually(lambda: not old.exists(), seconds=10)
               and (recent / "page.txt").exists() and (other / "page.txt").exists())
        for folder in (recent, other):
            (folder / "page.txt").unlink()
            folder.rmdir()
        ok("cold_chrome_stopped", eventually(closed_down, seconds=40))

        # MCP 2026-07-28: no initialize. Each request names its version and client capabilities in _meta.
        modern = {"io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {},
                  "io.modelcontextprotocol/clientInfo": {"name": "t", "version": "1"}}
        catalog = [x["name"] for x in json.loads((EXE.parent / "catalog.json").read_text(encoding="utf-8"))["tools"]]
        with Client(EXE, meta=modern) as c:
            d = c.request("server/discover")
            ok("modern_discover", d["resultType"] == "complete" and d["supportedVersions"][:2] == ["2026-07-28", "2025-11-25"]
               and d["capabilities"] == {"tools": {}} and d["ttlMs"] > 0 and d["cacheScope"] == "private" and d["instructions"]
               and d["_meta"]["io.modelcontextprotocol/serverInfo"] == {"name": "windows-chrome-bridge", "version": VERSION})
            first, again = c.request("tools/list"), c.request("tools/list")
            ok("modern_tools_list", first["resultType"] == "complete" and first["ttlMs"] > 0 and first["cacheScope"] == "private"
               and [x["name"] for x in first["tools"]] == catalog and first == again)
            r = c.call("qa_session")
            ok("modern_tool_call", r["resultType"] == "complete" and json.loads(r["content"][0]["text"])["version"] == VERSION
               and r["_meta"]["io.modelcontextprotocol/serverInfo"]["version"] == VERSION)
            refused(lambda: c.request("tools/list", {"_meta": dict(modern, **{"io.modelcontextprotocol/protocolVersion": "2099-01-01"})}))
            ok("modern_unsupported_version", c.error["code"] == -32022
               and c.error["data"] == {"supported": d["supportedVersions"], "requested": "2099-01-01"})
            refused(lambda: c.request("tools/list", {"_meta": {"io.modelcontextprotocol/protocolVersion": "2026-07-28"}}))
            ok("modern_needs_capabilities", c.error["code"] == -32602)
            refused(lambda: c.request("ping"))
            ok("modern_has_no_ping", c.error["code"] == -32601)
        ok("modern_chrome_stopped", eventually(closed_down, seconds=40))

        # manage.py stop while an agent starts QA Chrome: the stop waits for the start, counts the session and keeps Chrome.
        with Client(EXE) as c:
            c.initialize()
            answers = []
            th = threading.Thread(target=lambda: answers.append(c.result("qa_session")["version"]))
            th.start()
            time.sleep(0.5)
            r = lifecycle("stop-idle")
            th.join(timeout=120)
            print("stop during a start:", r, answers, flush=True)
            ok("stop_waits_for_a_start", answers == [VERSION] and r["running"] and r["sessions"] == 1)
        ok("started_chrome_stopped", eventually(closed_down, seconds=40))

        # Two agents start at the same moment while QA Chrome is closed: one Chrome starts, both work.
        pair = [Client(EXE), Client(EXE)]
        clients.extend(pair)
        for c in pair:
            c.initialize()
        gate, answers = threading.Barrier(2), []

        def first_call(c):
            gate.wait()
            try:
                answers.append(c.result("qa_session")["version"])
            except RuntimeError as e:
                answers.append(str(e))

        threads = [threading.Thread(target=first_call, args=(c,)) for c in pair]
        for th in threads:
            th.start()
        for th in threads:
            th.join(timeout=120)
        print("two cold starts:", answers, flush=True)
        ok("two_cold_starts_at_once", answers == [VERSION, VERSION])
        for c in pair:
            c.close()
            clients.remove(c)

        # A real agent ends its MCP server with a kill, not a clean close. QA Chrome, the keeper and
        # the native host still stop soon after.
        c = Client(EXE)
        clients.append(c)
        c.initialize()
        c.result("qa_tabs", action="new", url=page, snapshot=False)
        c.p.send_signal(signal.SIGTERM)
        c.p.wait(timeout=10)
        c.close()
        clients.remove(c)
        ok("killed_client_chrome_stopped", eventually(closed_down, seconds=40))

        # Warm start: a QA Chrome that another process started is used and kept.
        lease = lifecycle("start")
        with Client(EXE) as c:
            c.initialize()
            c.result("qa_session")
        # The native host waits about 10 s before it stops an idle Chrome. This one it must keep.
        time.sleep(15)
        ok("warm_chrome_kept", not chrome_closed())

        # maxSessions=3 from bridge-config.json: a fourth client is refused.
        for _ in range(3):
            c = Client(EXE)
            c.initialize()
            c.result("qa_session")
            clients.append(c)
        t1 = clients[0].result("qa_tabs", action="new", url=page, snapshot=False)["tabId"]
        t2 = clients[1].result("qa_tabs", action="new", url=page, snapshot=False)["tabId"]
        ok("other_session_tab_refused", "not claimed" in refused(lambda: clients[0].result("qa_snapshot", tabId=t2)))
        with Client(EXE) as extra:
            extra.initialize()
            ok("fourth_client_refused", "Too many QA sessions: 3" in refused(lambda: extra.result("qa_session")))
        # maxTabsPerSession=2: a third tab is refused.
        clients[1].result("qa_tabs", action="new", url=page, snapshot=False)
        ok("tab_limit_from_config", "tab limit reached (2" in refused(
            lambda: clients[1].result("qa_tabs", action="new", url=page, snapshot=False)))
        clients[0].close()
        ok("a_closed_client_leaves_other_sessions", t2 in [x["id"] for x in clients[1].result("qa_session")["tabs"]])
        for c in clients[1:]:
            c.close()
        clients = []

        # A kept tab stays open when its session ends, and another session can adopt it.
        with Client(EXE) as c:
            c.initialize()
            kept = c.result("qa_tabs", action="new", url=page, keepOpen=True, snapshot=False)["tabId"]
            gone = c.result("qa_tabs", action="new", url=page, snapshot=False)["tabId"]
        with Client(EXE) as c:
            c.initialize()
            rows = {x["id"]: x for w in c.result("qa_tabs")["windows"] for x in w["tabs"]}
            ok("kept_tab_survives_disconnect", rows[kept]["owner"] == "unclaimed" and gone not in rows)
            c.result("qa_tabs", action="adopt", tabId=kept)
            c.result("qa_tabs", action="close", tabId=kept)

        # Default tool groups: core, debug and files. A default tool works; other tools are not listed and are refused.
        set_config(toolGroups=None)
        catalog = json.loads((EXE.parent / "catalog.json").read_text(encoding="utf-8"))
        default = {x["name"] for x in catalog["tools"] if x["group"] in ["core"] + catalog["defaultGroups"]}
        with Client(EXE) as c:
            c.initialize()
            names = {x["name"] for x in c.request("tools/list")["tools"]}
            ok("default_groups", names == default and len(names) == 21 and "qa_cdp" not in names and "qa_storage" not in names)
            tab = c.result("qa_tabs", action="new", url=page, snapshot=False)["tabId"]
            ok("default_tools_work", 'button "Sign in"' in c.text("qa_snapshot", tabId=tab, full=True)
               and "requests" in c.text("qa_network", tabId=tab))
            msg = refused(lambda: c.result("qa_cdp", tabId=tab, method="Page.reload"))
            ok("off_tool_refused", 'qa_cdp is in the tool group "cdp", which is off' in msg and "toolGroups" in msg)
            msg = refused(lambda: c.result("qa_batch", tabId=tab, steps=[{"tool": "qa_storage", "args": {"area": "local", "action": "get"}}]))
            ok("off_tool_refused_in_batch", "which is off" in msg)
        set_config(toolGroups=["nope"])
        with Client(EXE) as c:
            c.initialize()
            ok("unknown_group_explained", "toolGroups has \"nope\"" in refused(lambda: c.result("qa_session")))
        set_config(toolGroups=["all"])

        # Crash: QA Chrome dies while a tab is open. The call says so, and the next call starts Chrome again.
        with Client(EXE) as c:
            c.initialize()
            c.result("qa_tabs", action="new", url=page, snapshot=False)
            ok("chrome_killed", lifecycle("stop", json.dumps(lease))["stopped"])
            ok("crash_reported", "Lost the connection" in refused(lambda: c.result("qa_session")))
            ok("crash_recovered", c.result("qa_session")["version"] == VERSION)
        ok("recovered_chrome_stopped", eventually(closed_down, seconds=40))

        # An upgrade: at the next start the extension has another version and another script. QA Chrome must
        # run the new script. Chrome keeps the cached script of the version before unless the extension is reloaded.
        extension = EXE.parent / "extension"
        before = {f: (extension / f).read_bytes() for f in ("manifest.json", "background.js")}
        script = before["background.js"].replace(b"    version: VERSION,\n    ...(INSTANCE", b"    version: VERSION,\n    upgraded: true,\n    ...(INSTANCE")
        try:
            (extension / "manifest.json").write_bytes(before["manifest.json"].replace(b'"' + VERSION.encode() + b'"', b'"' + VERSION.encode() + b'.1"'))
            (extension / "background.js").write_bytes(script)
            with Client(EXE) as c:
                c.initialize()
                info = c.result("qa_session")
                ok("upgrade_runs_new_script", script != before["background.js"] and info["version"] == VERSION + ".1" and info.get("upgraded") is True)
            ok("upgraded_chrome_stopped", eventually(closed_down, seconds=40))
        finally:
            for f, data in before.items():
                (extension / f).write_bytes(data)
        with Client(EXE) as c:
            c.initialize()
            info = c.result("qa_session")
            ok("downgrade_runs_old_script", info["version"] == VERSION and "upgraded" not in info)
        ok("downgraded_chrome_stopped", eventually(closed_down, seconds=40))
        print("ALL PASS", flush=True)
    finally:
        for c in clients:
            c.close()
        server.shutdown()
