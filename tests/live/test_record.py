"""Live test of qa_record: MP4 recordings of a claimed tab.

Run: python3 tests/live/test_record.py [--display]

Each recording is checked three ways: the MP4 boxes (moov before mdat, the duration), the result
fields, and playback in QA Chrome itself (a <video> element plays it and shows a picture).
"""

import struct
import time
import urllib.parse
from pathlib import Path

from common import EXE, Client, eventually, ok, refused, test_mode
import fixture

B = "http://127.0.0.1:%d" % fixture.PORT


def boxes(data):
    """The top-level MP4 boxes and the movie duration in seconds."""
    names, at, duration = [], 0, None
    while at < len(data):
        size, kind = struct.unpack(">I4s", data[at : at + 8])
        names.append(kind.decode())
        if kind == b"moov":
            mvhd = data.index(b"mvhd", at)
            scale, length = struct.unpack(">II", data[mvhd + 16 : mvhd + 24])
            duration = length / scale
        at += size
    return names, duration


def durations(data):
    """The frame durations in ms, from the stts box."""
    at = data.index(b"stts") + 8
    out = []
    for i in range(struct.unpack(">I", data[at : at + 4])[0]):
        count, ms = struct.unpack(">II", data[at + 4 + 8 * i : at + 12 + 8 * i])
        out += [ms] * count
    return out


def check_file(r, seconds):
    data = Path(r["saved"]["path"]).read_bytes()
    names, duration = boxes(data)
    assert len(data) == r["saved"]["bytes"] and r["saved"]["path"].endswith(".mp4"), r
    assert names == ["ftyp", "moov", "mdat"], names
    assert abs(duration - r["seconds"]) < 0.2 and abs(duration - seconds) < 1.5, (duration, r)
    # Frames come at most fps a second; only the frame flushed at stop may come sooner.
    assert len(durations(data)) == r["frames"] and min(durations(data)[:-2]) >= 15, durations(data)[:10]
    return data


def plays(c, tab, r):
    """Play the file in QA Chrome. Returns (duration, width, height, a non-black picture)."""
    url = B + "/video?path=" + urllib.parse.quote(r["saved"]["path"])
    c.result("qa_navigate", tabId=tab, url=url, snapshot=False)
    return c.result("qa_eval", tabId=tab, timeoutMs=15000, expression="""(async () => {
      const v = document.querySelector('video');
      v.muted = true;
      if (v.readyState < 1) await new Promise(r => v.onloadedmetadata = r);
      v.currentTime = v.duration / 2;
      await new Promise(r => v.onseeked = r);
      const c = document.createElement('canvas');
      c.width = v.videoWidth; c.height = v.videoHeight;
      const g = c.getContext('2d');
      g.drawImage(v, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let lit = 0;
      for (let i = 0; i < d.length; i += 4 * 97) if (d[i] + d[i + 1] + d[i + 2] > 60) lit++;
      return [Math.round(v.duration * 100) / 100, v.videoWidth, v.videoHeight, lit > 10];
    })()""")


with test_mode():
    server = fixture.start()
    clients = []
    try:
        c = Client(EXE)
        c.initialize()
        clients.append(c)
        out = Path(c.result("qa_session")["outputFolder"])
        t = c.result("qa_tabs", action="new", url=B + "/anim", snapshot=False)["tabId"]
        player = c.result("qa_tabs", action="new", url=B + "/child", snapshot=False)["tabId"]
        # player is now the active tab of the window: the recorded tab is in the background.
        rows = {x["id"]: x for w in c.result("qa_tabs")["windows"] for x in w["tabs"]}
        ok("recorded_tab_in_background", rows[player].get("active") and not rows[t].get("active"))

        # A background tab, a moving page.
        start = c.result("qa_record", action="start", tabId=t, file="background.mp4", fps=10)
        ok("start", start["recording"] and start["file"] == "background.mp4")
        ok("one_recording_per_tab", "already being recorded" in refused(lambda: c.result("qa_record", action="start", tabId=t)))
        ok("release_refused_while_recording", "being recorded" in refused(lambda: c.result("qa_tabs", action="release", tabId=t)))
        time.sleep(3)
        r = c.result("qa_record", action="stop", tabId=t)
        print("background tab:", r, flush=True)
        check_file(r, 3)
        ok("background_tab_recorded", r["stoppedBy"] == "stop" and r["frames"] >= 8 and r["width"] <= 1280)
        duration, w, h, picture = plays(c, player, r)
        ok("background_recording_plays", abs(duration - r["seconds"]) < 0.2 and (w, h) == (r["width"], r["height"]) and picture)

        # The active tab, with actions while it records, a small size and the default name.
        c.result("qa_tabs", action="close", tabId=player)
        c.result("qa_navigate", tabId=t, url=B + "/anim", snapshot=False)
        start = c.result("qa_record", action="start", tabId=t, fps=15, maxSize=640)
        c.result("qa_click", tabId=t, selector="#mark", snapshot=False)
        time.sleep(2)
        status = c.result("qa_record")["recordings"][0]
        ok("status_while_recording", status["state"] == "recording" and status["seconds"] >= 2)
        r = c.result("qa_record", action="stop")
        print("active tab:", r, flush=True)
        check_file(r, 2)
        ok("active_tab_recorded", r["frames"] >= 15 and max(r["width"], r["height"]) <= 640 and r["saved"]["path"].endswith(start["file"]))
        player = c.result("qa_tabs", action="new", url=B + "/child", snapshot=False)["tabId"]
        duration, w, h, picture = plays(c, player, r)
        ok("active_recording_plays", abs(duration - r["seconds"]) < 0.2 and picture)
        c.result("qa_tabs", action="close", tabId=player)

        # It stops by itself at maxSeconds, and when the tab closes. The file is still saved.
        c.result("qa_record", action="start", tabId=t, file="max.mp4", maxSeconds=2)
        time.sleep(3)
        ok("stops_at_max_seconds", c.result("qa_record")["recordings"][0]["state"].startswith("stopped: maxSeconds"))
        r = c.result("qa_record", action="stop", tabId=t)
        check_file(r, 2)
        ok("max_seconds_file", r["stoppedBy"].startswith("maxSeconds") and 1.8 <= r["seconds"] <= 2.3)
        c.result("qa_record", action="start", tabId=t, file="closed.mp4")
        time.sleep(1.5)
        c.result("qa_tabs", action="close", tabId=t)
        eventually(lambda: c.result("qa_record")["recordings"][0]["state"], lambda x: x == "stopped: tab closed", seconds=5)
        r = c.result("qa_record", action="stop", tabId=t)
        check_file(r, 1.5)
        ok("tab_closed_file", r["stoppedBy"] == "tab closed")
        ok("not_an_mp4_name", "ends with .mp4" in refused(lambda: c.result(
            "qa_record", action="start", tabId=c.result("qa_tabs", action="new", url=B + "/anim", snapshot=False)["tabId"], file="x.webm")))

        # The session ends while it records: the native host saves the file.
        t = c.result("qa_tabs", action="new", url=B + "/anim", snapshot=False)["tabId"]
        c.result("qa_record", action="start", tabId=t, file="session-end.mp4")
        time.sleep(1.5)
        c.close()
        clients.remove(c)
        path = out / "session-end.mp4"
        eventually(lambda: path.exists() and path.stat().st_size, seconds=10)
        names, duration = boxes(path.read_bytes())
        ok("session_end_saves_the_file", names == ["ftyp", "moov", "mdat"] and 1 <= duration <= 4)

        # Two big recordings at session end: each file is saved, even when both together are over the
        # 15 MB reply limit.
        c = Client(EXE)
        c.initialize()
        clients.append(c)
        folder = Path(c.result("qa_session")["outputFolder"])
        big = []
        for name in ("big-1.mp4", "big-2.mp4"):
            tab = c.result("qa_tabs", action="new", url=B + "/static", newWindow=True, snapshot=False)["tabId"]
            c.result("qa_record", action="start", tabId=tab, file=name, fps=30, maxSeconds=120)
            big.append(folder / name)
        sizes = eventually(lambda: [r["bytes"] for r in c.result("qa_record")["recordings"]],
                           lambda b: len(b) == 2 and min(b) >= 6000000, seconds=120)
        print("big recordings before the session ends:", sizes, flush=True)
        c.close()
        clients.remove(c)
        saved = eventually(lambda: [p.stat().st_size if p.exists() else 0 for p in big], lambda b: min(b) >= 6000000, seconds=30)
        print("saved after the session ended:", saved, flush=True)
        ok("each_recording_saved_at_session_end", all(boxes(p.read_bytes())[0] == ["ftyp", "moov", "mdat"] for p in big))
        print("ALL PASS", flush=True)
    finally:
        for c in clients:
            c.close()
        server.shutdown()
