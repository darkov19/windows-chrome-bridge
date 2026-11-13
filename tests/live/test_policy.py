"""Live test of the optional policy.json: allow list, block list and strict mode.

Run: python3 tests/live/test_policy.py [--display]

It writes policy.json in the install folder for the run and removes it at the end.
It stops if C:\\ProgramData\\windows-chrome-bridge\\policy.json exists, because that file would win.
"""

import json
import re
import sys
import time
from pathlib import Path

from common import EXE, ROOT, Client, ok, page, refused, test_mode
import fixture
import manage

LISTED = "http://127.0.0.1:%d" % fixture.PORT
OTHER = "http://localhost:%d" % fixture.PORT
policy = ROOT / "policy.json"
if Path(manage.C + "ProgramData/windows-chrome-bridge/policy.json").exists():
    sys.exit("A machine policy exists in C:\\ProgramData\\windows-chrome-bridge. This test cannot run")
if policy.exists():
    sys.exit(str(policy) + " already exists. Move it away first")


def client(rules):
    policy.write_text(json.dumps({"version": 2, **rules}))
    c = Client(EXE)
    c.initialize()
    return c


with test_mode():
    server = fixture.start()
    try:
        # Allow list: the sensitive tools work only on allowed sites.
        with client({"allow": [LISTED]}) as c:
            p = c.result("qa_session")["policy"]
            ok("session_shows_policy", p["active"] and p["allow"] == [LISTED] and not p["strict"])
            # The allowed page holds an iframe from the other origin.
            t = c.result("qa_tabs", action="new", url=LISTED + "/", snapshot=False)["tabId"]
            ok("eval_allowed", c.result("qa_eval", tabId=t, expression="1+1") == 2)
            e = refused(lambda: c.result("qa_eval", tabId=t, frameId="f1", expression="1"))
            ok("frame_names_need_a_read_first", "Unknown frame f1" in e)
            page(c, "qa_snapshot", tabId=t)
            e = refused(lambda: c.result("qa_eval", tabId=t, frameId="f1", expression="1"))
            ok("eval_in_unlisted_frame_refused", "not listed" in e and OTHER in e)
            e = refused(lambda: c.result("qa_cdp", tabId=t, method="Runtime.evaluate", params={"expression": "1"}))
            ok("cdp_refused_with_unlisted_frame", "not listed" in e)
            e = refused(lambda: c.result("qa_downloads", action="start", tabId=t, url=OTHER + "/download", filename="x.txt"))
            ok("download_from_unlisted_refused", "download URL" in e)
            ok("click_still_works", c.result("qa_click", tabId=t, selector="#mouse", snapshot=False)["clicked"])
            # A page without frames: qa_cdp works, but not a script for every new document.
            c.result("qa_navigate", tabId=t, url=LISTED + "/many", snapshot=False)
            r = c.result("qa_cdp", tabId=t, method="Runtime.evaluate", params={"expression": "21*2", "returnByValue": True})
            ok("cdp_allowed_without_frames", r["result"]["value"] == 42)
            e = refused(lambda: c.result("qa_cdp", tabId=t, method="Page.addScriptToEvaluateOnNewDocument", params={"source": "1"}))
            ok("cdp_new_document_script_refused", "policy" in e)
            # Each qa_batch step is checked on the page it acts on: here the page changes inside the batch.
            r = c.result("qa_batch", tabId=t, snapshot=False, steps=[
                {"tool": "qa_eval", "args": {"expression": "1"}},
                {"tool": "qa_navigate", "args": {"url": OTHER + "/app"}},
                {"tool": "qa_eval", "args": {"expression": "2"}},
            ])
            ok("batch_checks_each_step", r["done"] == 2 and "not listed" in r["steps"][2]["error"])
            # On the other site: reading and clicking work, but not files, network bodies or storage.
            ok("read_unlisted", "Contact" in page(c, "qa_snapshot", tabId=t)[1])
            # A file is as sensitive as the tool: a page read file works here, an eval file does not.
            ok("read_to_file_on_unlisted", c.result("qa_snapshot", tabId=t, file="x.txt")["saved"]["bytes"] > 0)
            ok("screenshot_to_file_on_unlisted", c.result("qa_screenshot", tabId=t, file="x.jpg")["saved"]["bytes"] > 0)
            ok("eval_to_file_refused", "not listed" in refused(lambda: c.result("qa_eval", tabId=t, expression="1", file="x.json")))
            net = c.text("qa_network", tabId=t)
            ok("network_list_allowed", "/app" in net)
            rid = net.splitlines()[-1].split()[0]
            ok("network_request_refused", "not listed" in refused(lambda: c.result("qa_network", tabId=t, request=rid)))
            ok("storage_refused", "not listed" in refused(lambda: c.result("qa_storage", tabId=t, area="local", action="get")))
            c.result("qa_tabs", action="cleanup")

        # Block list: no tool works on a blocked site, and no tool goes there.
        with client({"allow": [LISTED], "block": ["*.localhost"]}) as c:
            e = refused(lambda: c.result("qa_tabs", action="new", url=OTHER + "/"))
            ok("new_tab_to_blocked_refused", "blocks http://localhost" in e)
            t = c.result("qa_tabs", action="new", url=LISTED + "/", snapshot=False)["tabId"]
            _, tree = page(c, "qa_snapshot", tabId=t)
            ok("blocked_frame_not_read", "policy.json blocks this site" in tree and "Child click" not in tree)
            ok("navigate_to_blocked_refused", "blocks" in refused(lambda: c.result("qa_navigate", tabId=t, url=OTHER + "/")))
            # A redirect can still reach a blocked site. The page read after it is refused, and every
            # tool but navigation refuses the tab.
            r, tree = page(c, "qa_navigate", tabId=t, url=LISTED + "/redirect")
            ok("no_read_after_redirect_to_blocked", "blocks" in r["note"] and "Child click" not in json.dumps(r) + tree)
            ok("blocked_tab_read_refused", "blocks" in refused(lambda: c.result("qa_snapshot", tabId=t)))
            ok("blocked_tab_click_refused", "blocks" in refused(lambda: c.result("qa_click", tabId=t, selector="#childButton")))
            ok("leave_blocked_tab", c.result("qa_navigate", tabId=t, url=LISTED + "/child", snapshot=False)["loaded"])
            # qa_cdp cannot read a blocked site's request or go to a blocked site.
            c.result("qa_navigate", tabId=t, url=LISTED + "/many", snapshot=False)
            c.result("qa_cdp", tabId=t, method="Network.enable")
            c.result("qa_cdp", tabId=t, events=True)
            c.result("qa_eval", tabId=t, expression="(async () => { await fetch('%s/child', {mode: 'no-cors'}); "
                     "return (await fetch('/child')).text() })()" % OTHER)
            ids = {}
            for e in c.result("qa_cdp", tabId=t, events=True)["events"]:
                if e["method"] == "Network.requestWillBeSent":
                    raw = e["params"].get("preview") or json.dumps(e["params"])
                    ids[re.search(r'"url":\s*"([^"]+)"', raw).group(1)] = re.search(r'"requestId":\s*"([^"]+)"', raw).group(1)
            blocked_id, listed_id = ids[OTHER + "/child"], ids[LISTED + "/child"]
            ok("cdp_body_of_allowed_request", "Child" in c.result(
                "qa_cdp", tabId=t, method="Network.getResponseBody", params={"requestId": listed_id})["body"])
            for method, params in [("Network.getResponseBody", {"requestId": blocked_id}),
                                   ("Network.getRequestPostData", {"requestId": blocked_id}),
                                   ("Network.streamResourceContent", {"requestId": blocked_id}),
                                   ("Page.navigate", {"url": OTHER + "/"})]:
                ok("cdp_" + method + "_blocked_refused", "blocks http://localhost" in refused(
                    lambda: c.result("qa_cdp", tabId=t, method=method, params=params)))
            frame = c.result("qa_cdp", tabId=t, method="Page.getFrameTree")["frameTree"]["frame"]["id"]
            ok("cdp_resource_of_blocked_site_refused", "blocks http://localhost" in refused(lambda: c.result(
                "qa_cdp", tabId=t, method="Page.getResourceContent", params={"frameId": frame, "url": OTHER + "/child"})))
            ok("cdp_stream_read_refused", "policy.json is active" in refused(
                lambda: c.result("qa_cdp", tabId=t, method="IO.read", params={"handle": "1"})))
            ok("cdp_script_source_refused", "policy.json is active" in refused(
                lambda: c.result("qa_cdp", tabId=t, method="Debugger.getScriptSource", params={"scriptId": "1"})))
            ok("cdp_navigate_did_not_leave", c.result("qa_eval", tabId=t, expression="location.href") == LISTED + "/many")
            # A recording leaves out the time the tab is on a blocked site, and shows a grey note instead.
            c.result("qa_navigate", tabId=t, url=LISTED + "/redirect", snapshot=False)
            ok("record_blocked_tab_refused", "blocks" in refused(lambda: c.result("qa_record", action="start", tabId=t)))
            c.result("qa_navigate", tabId=t, url=LISTED + "/child", snapshot=False)
            c.result("qa_record", action="start", tabId=t, file="policy.mp4")
            c.result("qa_navigate", tabId=t, url=LISTED + "/redirect", snapshot=False)
            time.sleep(1.5)
            c.result("qa_navigate", tabId=t, url=LISTED + "/child", snapshot=False)
            time.sleep(1)
            r = c.result("qa_record", action="stop", tabId=t)
            print("recording with a blocked site:", r, flush=True)
            ok("recording_leaves_out_blocked_site", r["framesNotRecorded"] >= 1 and "policy.json" in r["note"] and r["saved"]["bytes"] > 0)
            c.result("qa_tabs", action="cleanup")

        # Strict: every tool and every navigation only on allowed sites.
        with client({"allow": [LISTED], "strict": True}) as c:
            ok("strict_new_tab_refused", "strict" in refused(lambda: c.result("qa_tabs", action="new", url=OTHER + "/")))
            t = c.result("qa_tabs", action="new", url=LISTED + "/app", snapshot=False)["tabId"]
            ok("strict_allowed_works", c.result("qa_click", tabId=t, selector="#send", snapshot=False)["clicked"])
            # A frame of a site that is not allowed is left out of page reads, as a blocked one is.
            _, tree = page(c, "qa_navigate", tabId=t, url=LISTED + "/")
            ok("strict_unlisted_frame_not_read", "strict mode allows only listed sites" in tree and "Child click" not in tree)
            ok("strict_navigate_refused", "strict" in refused(lambda: c.result("qa_navigate", tabId=t, url=OTHER + "/")))
            c.result("qa_navigate", tabId=t, url=LISTED + "/redirect", snapshot=False)
            ok("strict_other_site_refused", "strict" in refused(lambda: c.result("qa_snapshot", tabId=t)))
            c.result("qa_navigate", tabId=t, url=LISTED + "/child", snapshot=False)
            ok("strict_back_to_other_site_refused", "navigation target is on " + OTHER in refused(
                lambda: c.result("qa_navigate", tabId=t, action="back")))
            c.result("qa_tabs", action="cleanup")

        # manage.py stop, install, rollback and uninstall ask the native host who is connected. A session
        # that connected before policy.json became invalid still works, so QA Chrome must stay.
        policy.unlink(missing_ok=True)
        with Client(EXE) as c:
            c.initialize()
            c.result("qa_session")
            policy.write_text("{not json")
            r = manage.lifecycle(EXE, "stop-idle")
            ok("invalid_policy_stop_keeps_connected_session", r["running"] and not r["stopped"] and r["sessions"] == 1)
            ok("connected_session_still_works", isinstance(c.result("qa_session"), dict))

        # An invalid policy fails every call with the reason. It never fails open.
        policy.write_text("{not json")
        with Client(EXE) as c:
            c.initialize()
            ok("invalid_policy_fails_closed", "policy.json is not valid JSON" in refused(lambda: c.result("qa_session")))
        policy.write_text(json.dumps({"version": 1, "sensitiveOrigins": [LISTED]}))
        with Client(EXE) as c:
            c.initialize()
            ok("old_policy_format_explained", "version 2" in refused(lambda: c.result("qa_session")))
        print("ALL PASS", flush=True)
    finally:
        policy.unlink(missing_ok=True)
        server.shutdown()
