"""Local test page for validate and the live tests. Serve it from WSL on 0.0.0.0; Windows Chrome
reaches it at http://localhost:18475. Only dummy data."""
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlsplit, parse_qs
import json, random, struct, subprocess, threading, time, zlib

CURL = "/mnt/c/Windows/System32/curl.exe"

PORT = 18475
TITLE = "Native authenticated QA fixture"
HTML = """<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>Native authenticated QA fixture</title>
<h1>Native authenticated QA fixture</h1><form id="login"><input id="user" autocomplete="username"><input id="password" type="password"><input id="hidden" type="hidden"><button id="signin">Sign in</button></form><p id="status">Signed out</p>
<input id="upload" type="file"><p id="fileStatus"></p><input id="typing"><select id="choice"><option value="a">A</option><option value="b">B</option></select>
<button id="popup" onclick="window.open('http://localhost:18475/child','_blank')">Popup</button><button id="tabLater" onclick="setTimeout(()=>window.open('http://localhost:18475/child','_blank'),3000)">Tab later</button><button id="windowLater" onclick="setTimeout(()=>window.open('http://localhost:18475/child','_blank','popup,width=500,height=400'),3000)">Window later</button><a id="download" href="/download">Download fixture</a><button id="dialog" onclick="window.answer=prompt('Fixture prompt','default')">Prompt</button>
<button id="mouse">Mouse target</button><div id="drag" style="width:100px;height:50px;background:skyblue">Drag</div><p id="events"></p>
<iframe id="frame" src="http://localhost:18475/frame"></iframe><div style="height:2000px">Scroll area</div>
<script>
window.counts={};for(const type of ['click','dblclick','contextmenu','mouseenter','mousedown','mouseup','keydown'])document.querySelector('#mouse').addEventListener(type,e=>{if(type==='contextmenu')e.preventDefault();counts[type]=(counts[type]||0)+1;document.querySelector('#events').textContent=JSON.stringify(counts)});
login.onsubmit=async e=>{e.preventDefault();const r=await fetch('/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({user:user.value,password:password.value,hidden:hidden.value})});document.querySelector('#status').textContent=r.ok?'Signed in':'Failed'};
upload.onchange=async()=>{const f=upload.files[0];if(!f)return;const r=await fetch('/upload',{method:'POST',body:f});fileStatus.textContent=r.ok?'Uploaded '+f.name:'Failed'};
</script>"""

# A small app page: a labelled form that posts JSON with an Authorization header, console messages,
# a page error, and a table. The live tests and the size measurements use it.
APP = """<!doctype html><title>Fixture app</title>
<header><nav><a href="/app">Home</a> <a href="/child">Help</a> <a href="/many">Many</a></nav></header>
<main><h1>Contact</h1>
<form id="contact"><label>Name <input id="name" name="name"></label>
<label>Email <input id="email" name="email" type="email"></label>
<label>Password <input id="pw" type="password" value="Dummy-Prefilled-Secret"></label>
<label><input id="agree" type="checkbox"> I agree</label>
<select id="topic" aria-label="Topic"><option value="q">Question</option><option value="b">Bug</option></select>
<button id="send">Send</button></form>
<p id="result" role="status">Not sent</p>
<button id="boom" onclick="setTimeout(()=>{null.boom()},0)">Throw</button>
<button id="later" onclick="setTimeout(()=>{result.textContent='Done later'},800)">Later</button>
<table><tr><th>Item</th><th>Price</th></tr><tr><td>Tea</td><td>3</td></tr><tr><td>Cake</td><td>5</td></tr></table></main>
<script>
console.log('app ready', 42);
console.warn('fixture warning');
contact.onsubmit=async e=>{e.preventDefault();
const r=await fetch('/api/send',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer dummy-secret-token'},body:JSON.stringify({name:contact.elements.name.value,email:contact.elements.email.value,password:'Dummy-Body-Secret'})});
const j=await r.json();result.textContent=j.message;};
</script>"""


# A page built to be slow: a render-blocking script, a late big image (LCP), a banner that pushes the
# page down (CLS), a long task at load, and a button whose click handler blocks for 300 ms (INP).
SLOW = """<!doctype html><title>Slow page</title><script src="/delay.js?ms=700"></script>
<style>body{margin:0;font:16px sans-serif} #hero{display:block;width:900px;height:450px}</style>
<p id="intro">A slow page for qa_perf.</p><img id="hero" src="/delay.png?ms=3000">
<button id="work">Work</button><p id="done">Idle</p>
<script>
const t0=performance.now();while(performance.now()-t0<250){}
let x=0;const w0=performance.now();for(let i=0;i<3e7;i++)x+=i%7;window.workMs=performance.now()-w0;
setTimeout(()=>{const b=document.createElement('div');b.style.height='300px';b.textContent='Late banner';document.body.prepend(b)},600);
work.onclick=()=>{const t=performance.now();while(performance.now()-t<300){}done.textContent='Worked'};
</script>"""

# A page that leaks on purpose: each click on Leak keeps 200 detached elements and adds a listener.
LEAK = """<!doctype html><title>Leak page</title><button id="leak">Leak</button><button id="clean">Clean</button><p id="n">0</p>
<script>
window.kept=[];
leak.onclick=()=>{const box=document.createElement('div');for(let i=0;i<200;i++){const d=document.createElement('span');d.textContent='x'+i;box.appendChild(d)}
kept.push(box);window.addEventListener('resize',()=>box.title='r');n.textContent=kept.length};
clean.onclick=()=>{const box=document.createElement('div');for(let i=0;i<200;i++)box.appendChild(document.createElement('span'));n.textContent='clean'};
</script>"""

# A page that never goes quiet: a poll every 150 ms that takes 100 ms, and a stream that stays open.
BUSY = """<!doctype html><title>Busy page</title><button id="go" onclick="out.textContent='Clicked'">Go</button><p id="out">Waiting</p><p id="polls">0</p>
<script>
let n=0;setInterval(()=>fetch('/poll').then(()=>polls.textContent=++n),150);
new EventSource('/stream');
</script>"""

# A page with a cross-site frame (localhost inside 127.0.0.1) that sends a request when it loads and on a click.
XFRAME = """<!doctype html><title>Cross-site frame</title><h1>Outer</h1><iframe id="x" src="http://localhost:18475/xchild" width="400" height="150"></iframe>"""
XCHILD = """<!doctype html><title>Inner</title><button id="send" onclick="fetch('/api/xframe?from=click',{method:'POST',body:'q=1'})">Frame send</button>
<script>fetch('/api/xframe?from=load',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({frame:'inner'})});</script>"""

# A page that changes all the time, for recordings: a moving box and a counter.
ANIM = """<!doctype html><title>Moving page</title><style>@keyframes m{from{left:0}to{left:600px}}
#box{position:absolute;top:120px;width:100px;height:100px;background:#e33;animation:m 2s linear infinite alternate}</style>
<h1 id="count">0</h1><div id="box"></div><button id="mark" style="margin-top:260px" onclick="document.body.style.background='#9cf'">Mark</button>
<script>let c=0;setInterval(()=>count.textContent=++c,100)</script>"""

# Random pixels in every frame: a video of it is big. Used to fill recordings quickly.
STATIC = """<!doctype html><title>Static</title><style>body{margin:0}</style><canvas id="c"></canvas>
<script>const c=document.getElementById('c'),g=c.getContext('2d');c.width=innerWidth;c.height=innerHeight;
const img=g.createImageData(c.width,c.height),d=new Uint32Array(img.data.buffer);
(function f(){for(let i=0;i<d.length;i++)d[i]=(Math.random()*0xffffffff)|0xff000000;g.putImageData(img,0,0);requestAnimationFrame(f)})()</script>"""


def png(width, height, pixels):
    """An RGB PNG, with the standard library only."""
    rows = b"".join(b"\x00" + pixels[y * width * 3 : (y + 1) * width * 3] for y in range(height))
    chunk = lambda tag, data: struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))


# Chrome leaves images with almost no detail out of LCP, so the slow image is noise.
NOISE = png(300, 150, random.Random(1).randbytes(300 * 150 * 3))


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def send(self, data, kind):
        self.send_response(200)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        url = urlsplit(self.path)
        path = url.path
        query = parse_qs(url.query)
        if path in ("/delay.js", "/delay.png"):
            time.sleep(int(query.get("ms", ["500"])[0]) / 1000)
            if path == "/delay.js":
                return self.send(b"window.delayed = true;", "text/javascript")
            return self.send(NOISE, "image/png")
        if path == "/poll":
            time.sleep(0.1)
            return self.send(b"{}", "application/json")
        if path == "/stream":
            # Server-sent events that never end, until the page goes away.
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            try:
                while True:
                    self.wfile.write(b"data: tick\n\n")
                    self.wfile.flush()
                    time.sleep(0.5)
            except OSError:
                return
        if path == "/video":
            # A saved recording, so the live test can play it in QA Chrome. Only MP4 files in the
            # bridge output folder: this server listens on every address while a test runs.
            from common import ROOT
            from pathlib import Path
            file = Path(query["path"][0]).resolve()
            if file.suffix != ".mp4" or (ROOT / "output").resolve() not in file.parents or not file.is_file():
                self.send_response(404)
                self.end_headers()
                return
            return self.send(file.read_bytes(), "video/mp4")
        if path == "/redirect":
            self.send_response(302)
            self.send_header("Location", "http://localhost:18475/child")
            self.end_headers()
            return
        if path.startswith("/download"):
            if "qa_auth=fixture" not in self.headers.get("Cookie", ""):
                self.send_response(403)
                self.end_headers()
                return
            data = b"Harmless fixture data. Not executable.\n"
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Disposition", 'attachment; filename="fixture.txt"')
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        if path == "/many":
            content = "<!doctype html><title>Many</title>" + "".join(
                '<button id="b%d">Button %d</button>' % (i, i) for i in range(1500)
            )
        elif path == "/shot":
            # A red box far down a tall page, for element screenshots on a scrolled page.
            content = (
                '<!doctype html><title>Shot</title><body style="margin:0;background:#fff">'
                '<div style="height:1500px"></div>'
                '<div id="red" style="width:120px;height:60px;background:#f00;margin-left:300px"></div>'
                '<div style="height:3000px"></div>'
            )
        elif path == "/tall":
            content = '<!doctype html><title>Tall</title><div style="height:40000px;background:linear-gradient(red,blue)"></div>'
        elif path in ("/slow", "/leak", "/busy", "/xframe", "/xchild", "/anim", "/static"):
            content = {"/slow": SLOW, "/leak": LEAK, "/busy": BUSY, "/xframe": XFRAME, "/xchild": XCHILD, "/anim": ANIM,
                       "/static": STATIC}[path]
        elif path == "/":
            content = HTML
        elif path == "/app":
            content = APP
        else:
            content = (
                '<!doctype html><title>Fixture child</title><h1>Fixture child</h1><input id="childInput">'
                '<button id="childButton" onclick="document.title=\'Child clicked\'">Child click</button>'
            )
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.end_headers()
        self.wfile.write(content.encode())

    def do_POST(self):
        data = self.rfile.read(min(int(self.headers.get("Content-Length", "0")), 1000000))
        ok = True
        if self.path == "/login":
            ok = json.loads(data) == {
                "user": "qa-user",
                "password": "Dummy-Only-Password-42",
                "hidden": "dummy-token",
            }
        if self.path.startswith("/api/xframe"):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"frame":"ok"}')
            return
        if self.path == "/upload":
            ok = data == b"Native QA dummy upload\n"
        if self.path == "/api/send":
            body = json.dumps({"ok": True, "token": "dummy-response-token", "message": "Thanks, " + json.loads(data).get("name", "")})
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Set-Cookie", "qa_session=dummy-cookie-secret; Path=/")
            self.end_headers()
            self.wfile.write(body.encode())
            return
        self.send_response(200 if ok else 401)
        if self.path == "/login" and ok:
            self.send_header("Set-Cookie", "qa_auth=fixture; Path=/; SameSite=Lax")
        self.end_headers()
        self.wfile.write(b"OK" if ok else b"FAIL")


class Server(ThreadingHTTPServer):
    def shutdown(self):
        super().shutdown()
        self.server_close()


def start():
    """Serve the page and wait until Windows reaches it. WSL needs about a second to forward a new port."""
    server = Server(("0.0.0.0", PORT), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        r = subprocess.run(
            [CURL, "-s", "-o", "NUL", "-w", "%{http_code}", "--max-time", "2", "http://localhost:%d/" % PORT],
            capture_output=True,
            text=True,
            cwd="/mnt/c",
        )
        if r.stdout == "200":
            return server
        time.sleep(0.3)
    server.shutdown()
    raise RuntimeError("Windows cannot reach the fixture at http://localhost:%d after 15 s" % PORT)


if __name__ == "__main__":
    print("Fixture listening on port", PORT, flush=True)
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
