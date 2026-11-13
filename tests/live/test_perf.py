"""Live test of qa_perf on fixture pages that are slow or leak on purpose.

Run: python3 tests/live/test_perf.py [--display]

/slow: a render-blocking script (700 ms), a big late image (3 s, the LCP), a banner that pushes
the page down at 600 ms (CLS), a 250 ms long task, and a button that blocks for 300 ms (INP).
/leak: each click on Leak keeps 200 detached elements and adds a listener; Clean leaks nothing.
"""

import json
from pathlib import Path

from common import EXE, Client, ok, refused, test_mode
import fixture

B = "http://127.0.0.1:%d" % fixture.PORT

with test_mode():
    server = fixture.start()
    try:
        with Client(EXE) as c:
            c.initialize()
            t = c.result("qa_tabs", action="new", url=B + "/slow", snapshot=False)["tabId"]
            m = c.result("qa_perf", tabId=t)
            print(json.dumps(m), flush=True)
            ok("load_times", m["load"]["type"] == "navigate" and m["load"]["fcpMs"] >= 700 and m["load"]["loadMs"] >= 3000)
            ok("lcp_is_the_late_image", m["lcp"]["element"] == "img#hero" and m["lcp"]["ms"] >= 3000 and m["lcp"]["rating"] == "needs improvement")
            ok("cls_from_the_banner", m["cls"]["value"] >= 0.1 and m["cls"]["rating"] != "good")
            ok("long_task", m["longTasks"]["count"] >= 1 and m["longTasks"]["totalMs"] >= 250)
            slow = m["slowestResources"]
            ok("slowest_resources", slow[0]["url"].endswith("/delay.png?ms=3000") and slow[0]["ms"] >= 3000
               and any(r.get("renderBlocking") and "delay.js" in r["url"] for r in slow))
            ok("no_inp_before_input", m["inp"]["ms"] is None and "104 ms" in m["inp"]["note"])
            c.result("qa_click", tabId=t, selector="#work", snapshot=False)
            inp = c.result("qa_perf", tabId=t)["inp"]
            ok("inp_from_the_slow_click", inp["ms"] >= 300 and inp["slowest"]["target"] == "button#work" and inp["rating"] != "good")

            # Throttling: network latency shows in the time to first byte, CPU in a fixed piece of work.
            work = c.result("qa_eval", tabId=t, expression="workMs")
            r = c.result("qa_perf", tabId=t, action="throttle", cpu=4, network="slow-4g")
            ok("throttle_set", r["throttle"] == {"cpu": 4, "network": "slow-4g"})
            c.result("qa_navigate", tabId=t, action="reload", snapshot=False)
            m = c.result("qa_perf", tabId=t)
            slow_work = c.result("qa_eval", tabId=t, expression="workMs")
            print("work ms", round(work), "with cpu 4:", round(slow_work), "ttfb", m["load"]["ttfbMs"], flush=True)
            ok("network_throttled", m["throttle"]["network"] == "slow-4g" and m["load"]["ttfbMs"] >= 500)
            ok("cpu_throttled", slow_work >= 2.5 * work)
            c.result("qa_perf", tabId=t, action="throttle")
            c.result("qa_navigate", tabId=t, action="reload", snapshot=False)
            ok("throttle_off", c.result("qa_perf", tabId=t)["load"]["ttfbMs"] < 300)

            # A trace of a reload, for the DevTools Performance panel.
            r = c.result("qa_perf", tabId=t, action="trace", file="slow-trace")
            trace = json.loads(Path(r["saved"]["path"]).read_text())
            names = {e.get("name") for e in trace["traceEvents"]}
            ok("trace_file", r["saved"]["path"].endswith(".json") and r["events"] > 500 and {"Layout", "EventDispatch"} & names)
            ok("trace_needs_file", "needs file" in refused(lambda: c.result("qa_perf", tabId=t, action="trace")))

            # Memory and the leak check.
            c.result("qa_navigate", tabId=t, url=B + "/leak", snapshot=False)
            mem = c.result("qa_perf", tabId=t, action="memory")
            ok("memory_after_gc", mem["gc"] and mem["heapUsedBytes"] > 0 and mem["nodes"] > 0 and mem["listeners"] >= 0)
            # The garbage collection comes from the Chrome keeper; pages get no gc() function.
            ok("no_gc_function_in_pages", c.result("qa_eval", tabId=t, expression="typeof gc") == "undefined")
            leak = c.result("qa_perf", tabId=t, action="leak", repeat=5, steps=[{"tool": "qa_click", "args": {"selector": "#leak"}}])
            print("leak:", json.dumps({k: leak[k] for k in ("perRepeat", "growing", "nodes", "heapKB")}), flush=True)
            ok("leak_found", leak["likelyLeak"] and leak["perRepeat"]["nodes"] >= 400 and leak["perRepeat"]["listeners"] == 1)
            clean = c.result("qa_perf", tabId=t, action="leak", repeat=5, steps=[{"tool": "qa_click", "args": {"selector": "#clean"}}])
            print("clean:", json.dumps({k: clean[k] for k in ("perRepeat", "growing", "nodes", "heapKB")}), flush=True)
            ok("no_leak_found", not clean["likelyLeak"] and clean["perRepeat"]["nodes"] == 0)
            ok("leak_step_errors_say_which", "Step 1 (qa_click)" in refused(lambda: c.result(
                "qa_perf", tabId=t, action="leak", steps=[{"tool": "qa_click", "args": {"selector": "#missing"}}])))
            ok("leak_steps_checked_by_the_server", "Step 1 (qa_click)" in refused(lambda: c.result(
                "qa_perf", tabId=t, action="leak", steps=[{"tool": "qa_click", "args": {"nope": 1}}])))
            c.result("qa_tabs", action="cleanup")
        print("ALL PASS", flush=True)
    finally:
        server.shutdown()
