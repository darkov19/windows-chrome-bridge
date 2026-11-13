"""Live test of several agents on one QA Chrome at the same time.

Run: python3 tests/live/test_sessions.py [--display]

Four named sessions work in parallel, each on its own tab: page reads, fills, typing, clicks,
waits, screenshots (inline and to a file) and evaluation. Each checks that it sees only its own
results, and that the tab list shows the owners' names.
"""

import base64
import threading
import time
from pathlib import Path

from common import EXE, Client, chrome_closed, closed_down, eventually, ok, page, ref, refused, test_mode
import fixture

NAMES = ["anna", "ben", "chen", "dana"]
ROUNDS = 5
APP = "http://127.0.0.1:%d/app" % fixture.PORT


def agent(c, name, errors, timings):
    try:
        opened, tree = page(c, "qa_tabs", action="new", url=APP)
        t = opened["tabId"]
        for n in range(ROUNDS):
            me = "%s-%d" % (name, n)
            start = time.monotonic()
            _, tree = page(c, "qa_snapshot", tabId=t, full=True)
            _, changes = page(c, "qa_fill", tabId=t, fields=[
                {"ref": ref(tree, 'textbox "Name"'), "value": me},
                {"ref": ref(tree, 'textbox "Email"'), "value": ""},
            ])
            assert me in changes, (me, changes)
            page(c, "qa_type", tabId=t, ref=ref(tree, 'textbox "Email"'), text=me + "@example.com")
            _, changes = page(c, "qa_click", tabId=t, ref=ref(tree, 'button "Send"'))
            if "Thanks, " + me not in changes:
                page(c, "qa_wait", tabId=t, text="Thanks, " + me, timeoutMs=5000)
            got = c.result("qa_eval", tabId=t, expression="[document.querySelector('#result').textContent, document.querySelector('#email').value]")
            assert got == ["Thanks, " + me, me + "@example.com"], (me, got)
            img = c.call("qa_screenshot", tabId=t, maxSize=400)["content"][0]
            assert base64.b64decode(img["data"])[:2] == b"\xff\xd8"
            saved = c.result("qa_screenshot", tabId=t, file="%s.jpg" % me)["saved"]
            assert Path(saved["path"]).read_bytes()[:2] == b"\xff\xd8" and "/output/" in saved["path"], saved
            timings.append(time.monotonic() - start)
        owners = {x["id"]: x["owner"] for w in c.result("qa_tabs")["windows"] for x in w["tabs"]}
        assert owners[t] == "you", owners
        others = sorted(o for i, o in owners.items() if i != t and o in NAMES)
        assert others == sorted(x for x in NAMES if x != name), (name, owners)
    except Exception as e:
        errors.append("%s: %r" % (name, e))


with test_mode(maxSessions=20):
    server = fixture.start()
    clients = []
    try:
        for name in NAMES:
            c = Client(EXE)
            c.initialize()
            c.result("qa_session", name=name)
            clients.append(c)
        errors, timings = [], []
        barrier_start = time.monotonic()
        threads = [threading.Thread(target=agent, args=(c, name, errors, timings)) for c, name in zip(clients, NAMES)]
        for th in threads:
            th.start()
        # The owners check runs at the end of each agent; keep all tabs open until every agent is done.
        for th in threads:
            th.join(timeout=300)
        total = round(time.monotonic() - barrier_start, 1)
        for e in errors:
            print("ERROR", e, flush=True)
        ok("parallel_sessions_no_errors", not errors)
        ok("all_rounds_done_%d_in_%ss" % (len(timings), total), len(timings) == len(NAMES) * ROUNDS)
        ok("session_list", sorted(clients[0].result("qa_session")["sessions"]) == sorted(["you"] + NAMES[1:]))
        print("Round time: median %.2f s, max %.2f s" % (sorted(timings)[len(timings) // 2], max(timings)), flush=True)
        # maxSessions=20: more than 16 clients at once (the old pipe limit) all work, and the 21st is refused.
        while len(clients) < 20:
            c = Client(EXE)
            clients.append(c)
            c.initialize()
            c.result("qa_session")
        with Client(EXE) as extra:
            extra.initialize()
            ok("client_over_max_sessions_refused", "Too many QA sessions: 20" in refused(lambda: extra.result("qa_session")))
        ok("twenty_sessions_work", all(c.result("qa_session")["version"] for c in clients))
        for c in clients[len(NAMES):]:
            c.close()
        del clients[len(NAMES):]
        # The client that started QA Chrome leaves first. Chrome stays for the others, and the last
        # one to leave stops it.
        clients[0].close()
        ok("chrome_stays_for_other_sessions", not chrome_closed() and clients[1].result("qa_session")["tabs"])
        for c in clients[1:]:
            c.close()
        ok("last_session_stops_chrome", eventually(closed_down, seconds=40))
        print("ALL PASS", flush=True)
    finally:
        for c in clients:
            c.close()
        server.shutdown()
