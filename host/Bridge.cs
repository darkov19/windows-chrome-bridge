using System;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Web.Script.Serialization;
using System.Collections.Generic;
using System.Diagnostics;
using System.Threading;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text.RegularExpressions;
using Microsoft.Win32.SafeHandles;

class Bridge {
    const int Limit = 16 * 1024 * 1024;
    static readonly object outLock = new object(), pendingLock = new object();
    static readonly Dictionary<string, Waiter> pending = new Dictionary<string, Waiter>();
    static Stream nativeOut;
    static int clientCount;

    // A random id for a session or a request.
    static string NewId() {
        return Guid.NewGuid().ToString("N");
    }

    static Dictionary<string, object> Obj(params object[] kv) {
        var d = new Dictionary<string, object>();
        for (int i = 0; i < kv.Length; i += 2) d[(string)kv[i]] = kv[i + 1];
        return d;
    }

    static string Json(object o) {
        return new JavaScriptSerializer() { MaxJsonLength = Limit, RecursionLimit = 64 }.Serialize(o);
    }

    static Dictionary<string, object> Parse(string s) {
        return new JavaScriptSerializer() { MaxJsonLength = Limit, RecursionLimit = 64 }
            .Deserialize<Dictionary<string, object>>(s);
    }

    static string Str(Dictionary<string, object> d, string k) {
        object v;
        return d.TryGetValue(k, out v) ? v as string : null;
    }

    static byte[] ReadExact(Stream s, int n) {
        var b = new byte[n];
        int p = 0;
        while (p < n) {
            int r = s.Read(b, p, n - p);
            if (r == 0) throw new EndOfStreamException();
            p += r;
        }
        return b;
    }

    internal static string ReadFrame(Stream s) {
        uint n = BitConverter.ToUInt32(ReadExact(s, 4), 0);
        if (n == 0 || n > Limit) throw new IOException("Frame size denied");
        return Encoding.UTF8.GetString(ReadExact(s, (int)n));
    }

    internal static void Frame(Stream s, string text) {
        byte[] b = Encoding.UTF8.GetBytes(text);
        if (b.Length > Limit) throw new IOException("Frame too large");
        s.Write(BitConverter.GetBytes(b.Length), 0, 4);
        s.Write(b, 0, b.Length);
        s.Flush();
    }

    static string PipeName() {
        string sid = WindowsIdentity.GetCurrent().User.Value;
        return Config.NamePrefix + "-v1-" + sid;
    }

    // The keeper's pipe: one command, a garbage collection of one page (see Lifecycle.GcService).
    internal static string KeeperPipeName() {
        return Config.NamePrefix + "-keeper-v1-" + WindowsIdentity.GetCurrent().User.Value;
    }

    class Waiter {
        public ManualResetEvent done = new ManualResetEvent(false);
        public Dictionary<string, object> result;
    }

    // Window settings from bridge-config.json, sent with every request. The extension places windows.
    static Dictionary<string, object> Display() {
        return Obj("mode", Config.WindowMode, "screen", Config.Screen, "state", Config.WindowState);
    }

    static Dictionary<string, object> Limits() {
        return Obj("tabs", Config.MaxTabsPerSession, "sessions", Config.MaxSessions);
    }

    // policy is the parsed policy.json (or null). Only the native host sets it; agents cannot.
    static Dictionary<string, object> Forward(string method, Dictionary<string, object> a, string session,
        object policy) {
        var w = new Waiter();
        string id = NewId();
        lock (pendingLock) pending[id] = w;
        try {
            lock (outLock)
                Frame(nativeOut, Json(Obj("id", id, "method", method, "args", a, "session", session, "policy", policy,
                    "display", Display(), "limits", Limits())));
            if (!w.done.WaitOne(45000)) throw new IOException("Chrome operation timed out");
            return w.result;
        } finally {
            lock (pendingLock) pending.Remove(id);
            w.done.Dispose();
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    struct SA {
        public int length;
        public IntPtr descriptor;
        public int inherit;
    }

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string s, uint v, out IntPtr p, out uint z);

    [DllImport("kernel32.dll")]
    static extern IntPtr LocalFree(IntPtr p);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern SafePipeHandle CreateNamedPipe(string name, uint open, uint mode, uint count, uint output,
        uint input, uint timeout, ref SA sa);

    internal static NamedPipeServerStream Server(string name, bool first) {
        IntPtr p;
        uint z;
        string sid = WindowsIdentity.GetCurrent().User.Value;
        // Protected ACL for this Windows user only. Reject remote clients at the OS boundary.
        if (!ConvertStringSecurityDescriptorToSecurityDescriptor("D:P(A;;GA;;;" + sid + ")", 1, out p, out z))
            throw new IOException("Pipe ACL failed");
        try {
            var sa = new SA() { length = Marshal.SizeOf(typeof(SA)), descriptor = p, inherit = 0 };
            // 255: no limit on instances (PIPE_UNLIMITED_INSTANCES). maxSessions is checked after the connect.
            var h = CreateNamedPipe(@"\\.\pipe\" + name, 0x00000003 | (first ? 0x00080000u : 0u), 0x00000008,
                255, 65536, 65536, 0, ref sa);
            if (h.IsInvalid)
                throw new IOException("QA pipe unavailable; another QA profile may already be connected. Win32=" +
                    Marshal.GetLastWin32Error());
            return new NamedPipeServerStream(PipeDirection.InOut, false, false, h);
        } finally {
            LocalFree(p);
        }
    }

    static void Native(string origin) {
        if (origin != "chrome-extension://" + Config.ExtensionId + "/")
            throw new Exception("Unexpected extension origin");
        Lifecycle.AssertNativeProfile();
        nativeOut = Console.OpenStandardOutput();
        var reader = new Thread(() => {
            try {
                var input = Console.OpenStandardInput();
                while (true) {
                    var msg = Parse(ReadFrame(input));
                    if (Str(msg, "keeper") != null) {
                        AskKeeper(msg);
                        continue;
                    }
                    string id = Str(msg, "id");
                    lock (pendingLock) {
                        Waiter w;
                        if (id != null && pending.TryGetValue(id, out w)) {
                            w.result = msg;
                            w.done.Set();
                        }
                    }
                }
            } catch {
                Environment.Exit(0);
            }
        });
        reader.IsBackground = true;
        reader.Start();
        var clean = new Thread(CleanOutput);
        clean.IsBackground = true;
        clean.Start();
        // An MCP server that was killed while it started Chrome never connects. Check once after a minute.
        IdleCheck(60000);
        // Keep one acceptor alive continuously. Each connection receives an independent session.
        // The first handle claims the name; all following handles retain the same current-user ACL.
        NamedPipeServerStream listener = Server(PipeName(), true);
        while (true) {
            // One bad connect must never end the native host: every session would lose its tabs.
            try {
                listener.WaitForConnection();
            } catch {
                var broken = listener;
                listener = NextListener();
                broken.Dispose();
                continue;
            }
            var connected = listener;
            listener = NextListener();
            int max = 8;
            try {
                max = Config.MaxSessions;
            } catch { }
            if (Interlocked.Increment(ref clientCount) > max) {
                Interlocked.Decrement(ref clientCount);
                Refuse(connected, "Too many QA sessions: " + max + " MCP clients are already connected " +
                    "(maxSessions in bridge-config.json)");
                continue;
            }
            var worker = new Thread(() => {
                string session = NewId();
                using (var pipe = connected) {
                    try {
                        Serve(pipe, session);
                    } catch (Exception) {
                        // The pipe broke. There is no one left to report to.
                    } finally {
                        // The session ended: a clean close or a killed MCP server look the same here.
                        SaveRecordings(session);
                        try {
                            Forward("__release", Obj(), session, null);
                        } catch { }
                        if (Interlocked.Decrement(ref clientCount) == 0) IdleCheck(IdleStopMs);
                    }
                }
            });
            worker.IsBackground = true;
            worker.Start();
        }

    }

    static NamedPipeServerStream NextListener() {
        while (true) {
            try {
                return Server(PipeName(), false);
            } catch {
                Thread.Sleep(500);
            }
        }
    }

    // The recordings of a session that ended are saved one by one: each reply holds one file, so the
    // size of one recording never makes another one fail.
    static void SaveRecordings(string session) {
        for (int i = 0; i < 16; i++) {
            try {
                var reply = Forward("__recording", Obj(), session, null);
                var result = reply.ContainsKey("result") ? reply["result"] as Dictionary<string, object> : null;
                if (result != null && result.ContainsKey("none")) return;
                SaveFiles(reply, session, "/mnt/");
            } catch { }
        }
    }

    // When the last session leaves, wait this long for a new one. Then stop a QA Chrome that an MCP
    // server started for sessions, if no window is left. Real agents end their MCP server with a kill,
    // so this must happen here, in the native host, and not in the MCP server.
    const int IdleStopMs = 10000;
    static int idleTicket;

    static void IdleCheck(int delay) {
        int ticket = Interlocked.Increment(ref idleTicket);
        var t = new Thread(() => {
            Thread.Sleep(delay);
            if (ticket != Thread.VolatileRead(ref idleTicket) || Thread.VolatileRead(ref clientCount) != 0) return;
            try {
                // A release for a new, empty session closes nothing and says whether the profile is safe to stop.
                var reply = Forward("__release", Obj(), NewId(), null);
                var data = reply.ContainsKey("result") ? reply["result"] as Dictionary<string, object> : null;
                if (data == null || !data.ContainsKey("safeToStopProfile") || !(bool)data["safeToStopProfile"]) return;
                if (Thread.VolatileRead(ref clientCount) != 0) return;
                var root = Lifecycle.Snapshot().Find(e => e.root);
                if (root == null || !Lifecycle.StartedForSessions(root)) return;
                Lifecycle.Stop(new Lifecycle.Lease { launched = true, root = root }, true);
            } catch { }
        });
        t.IsBackground = true;
        t.Start();
    }

    // The extension asks for a garbage collection of one page ({keeper: "gc", targetId, callId}).
    // Chrome does not give extensions HeapProfiler.collectGarbage, so the keeper, which holds the
    // browser's CDP pipe, does it. The answer goes back to the extension as {callId, result | error}.
    static void AskKeeper(Dictionary<string, object> msg) {
        var t = new Thread(() => {
            object answer;
            try {
                using (var k = new NamedPipeClientStream(".", KeeperPipeName(), PipeDirection.InOut, PipeOptions.None,
                    TokenImpersonationLevel.Identification)) {
                    k.Connect(3000);
                    Frame(k, Json(Obj("method", Str(msg, "keeper"), "targetId", Str(msg, "targetId"))));
                    answer = Parse(ReadFrame(k));
                }
            } catch (Exception e) {
                answer = Obj("error", "The Chrome keeper did not answer: " + e.Message);
            }
            var reply = answer as Dictionary<string, object> ?? Obj("error", "No answer");
            reply["callId"] = msg.ContainsKey("callId") ? msg["callId"] : null;
            try {
                lock (outLock) Frame(nativeOut, Json(reply));
            } catch { }
        });
        t.IsBackground = true;
        t.Start();
    }

    // One pipe connection is one session. The extension is checked once per connection:
    // if the extension goes away, Chrome closes our stdin and the reader thread ends this process.
    static void Serve(NamedPipeServerStream pipe, string session) {
        string refused = null;
        object policy = null;
        try {
            policy = ReadPolicy();
            Handshake(session, policy);
        } catch (Exception e) {
            refused = e.Message;
        }
        while (true) {
            var q = Parse(ReadFrame(pipe));
            if (refused != null) {
                // Report the reason, then close. The next call reconnects and checks again.
                // "clients" is for manage.py stop: sessions that connected before can still be working.
                Frame(pipe, Json(Obj("error", refused, "closed", true, "clients", Thread.VolatileRead(ref clientCount))));
                return;
            }
            string text;
            try {
                var a = q.ContainsKey("args") ? q["args"] as Dictionary<string, object> : Obj();
                string method = Str(q, "method");
                Validate(method, a);
                var reply = Forward(method, a, session, policy);
                // The MCP server says where its WSL mounts Windows drives, for the WSL paths of saved files.
                SaveFiles(reply, session, CheckRoot(Str(q, "wslRoot")));
                // The MCP server shows the output folder of the session.
                reply["session"] = session;
                // manage.py stop asks with a release: how many MCP clients are connected, this one included.
                if (method == "__release") reply["clients"] = Thread.VolatileRead(ref clientCount);
                text = Json(reply);
                int bytes = Encoding.UTF8.GetByteCount(text);
                if (bytes > Limit)
                    throw new Exception("Result is " + (bytes / 1048576) + " MB; the limit is 16 MB. Ask for less output");
            } catch (Exception e) {
                text = Json(Obj("error", e.Message));
            }
            Frame(pipe, text);
        }
    }

    // Optional policy.json. It is read for each new connection, so a change applies to the next
    // MCP session. The extension checks its format (see README).
    // %ProgramData%\windows-chrome-bridge\policy.json (windows-chrome-bridge-<instance> for an instance)
    // wins when it exists: an administrator can make it read-only for the user, so an agent with shell
    // access cannot change it. Otherwise the install root copy is used; the user (and so an agent shell)
    // can edit that one.
    static object ReadPolicy() {
        string path = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
            Config.FolderName, "policy.json");
        if (!File.Exists(path)) path = Config.RootFile("policy.json");
        if (!File.Exists(path)) return null;
        try {
            return Parse(File.ReadAllText(path));
        } catch (Exception e) {
            throw new Exception(path + " is not valid JSON: " + e.Message);
        }
    }

    static void Handshake(string session, object policy) {
        var reply = Forward("__hello", Obj(), session, policy);
        if (reply.ContainsKey("error")) throw new Exception("Extension handshake failed: " + reply["error"]);
        var h = reply.ContainsKey("result") ? reply["result"] as Dictionary<string, object> : null;
        string id = h == null ? null : Str(h, "extensionId");
        string version = h == null ? null : Str(h, "version");
        string instance = h == null ? null : Str(h, "instance");
        if (id != Config.ExtensionId)
            throw new Exception("Extension handshake failed: extension id is " + id + ", expected " +
                Config.ExtensionId);
        if (version != Config.Version)
            throw new Exception("Extension handshake failed: the extension is version " + version +
                " but qa-bridge.exe is " + Config.Version +
                ". QA Chrome was started by another release. Close QA Chrome; the next start loads the " +
                "extension of this release");
        // After the version: an extension from before 0.6.0 has no instance, and the version says so.
        if (instance != Config.Instance)
            throw new Exception("Extension handshake failed: the extension belongs to instance \"" + instance +
                "\" but qa-bridge.exe to \"" + Config.Instance + "\"");
    }

    // Answer the first request with the reason, then close.
    static void Refuse(NamedPipeServerStream pipe, string reason) {
        var t = new Thread(() => {
            using (pipe) {
                try {
                    ReadFrame(pipe);
                    Frame(pipe, Json(Obj("error", reason, "closed", true)));
                } catch { }
            }
        });
        t.IsBackground = true;
        t.Start();
    }

    // catalog.json: {groups, defaultGroups, tools}. Each tool has a group; "core" is always on.
    static readonly Dictionary<string, Dictionary<string, object>> Catalog = new Dictionary<string, Dictionary<string, object>>();
    static readonly List<string> ToolOrder = new List<string>();
    static readonly HashSet<string> Enabled = LoadCatalog();

    static HashSet<string> LoadCatalog() {
        var c = new JavaScriptSerializer() { MaxJsonLength = Limit }.Deserialize<Dictionary<string, object>>(
            File.ReadAllText(Path.Combine(Config.Dir, "catalog.json")));
        foreach (Dictionary<string, object> x in (System.Collections.IList)c["tools"]) {
            Catalog[(string)x["name"]] = x;
            ToolOrder.Add((string)x["name"]);
        }
        var known = new List<string>();
        foreach (string g in ((Dictionary<string, object>)c["groups"]).Keys) known.Add(g);
        var groups = new HashSet<string>();
        groups.Add("core");
        List<string> chosen = null;
        try {
            chosen = Config.ToolGroups;
        } catch (Exception e) {
            groupError = e.Message;
        }
        if (chosen == null) {
            chosen = new List<string>();
            foreach (object g in (System.Collections.IList)c["defaultGroups"]) chosen.Add((string)g);
        }
        foreach (string g in chosen) {
            if (g == "all") groups.UnionWith(known);
            else if (known.Contains(g)) groups.Add(g);
            else groupError = "bridge-config.json: toolGroups has \"" + g + "\". Use all, or some of: " +
                String.Join(", ", known.ToArray());
        }
        var on = new HashSet<string>();
        foreach (var x in Catalog.Values)
            if (groups.Contains((string)x["group"])) on.Add((string)x["name"]);
        return on;
    }

    static string groupError;
    // Tool groups decide what the agent sees, so only the MCP server checks them. The native host lives
    // as long as QA Chrome and would keep an old toolGroups list.
    static bool mcpServer;

    static void CheckEnabled(string name) {
        if (!mcpServer) return;
        if (groupError != null) throw new Exception(groupError);
        if (!Enabled.Contains(name))
            throw new Exception(name + " is in the tool group \"" + Catalog[name]["group"] + "\", which is off. " +
                "Add the group to toolGroups in bridge-config.json, then start a new agent session");
    }

    static void Rule(object value, Dictionary<string, object> r, string label, int depth) {
        if (depth > 32) throw new Exception("Arguments too deeply nested");
        string type = Str(r, "type");
        if (type == "string") {
            if (!(value is string) ||
                (r.ContainsKey("maxLength") && ((string)value).Length > Convert.ToInt32(r["maxLength"])))
                throw new Exception("Invalid string: " + label);
        } else if (type == "boolean") {
            if (!(value is bool)) throw new Exception("Invalid boolean: " + label);
        } else if (type == "integer" || type == "number") {
            if (!(value is int) && !(type == "number" && (value is decimal || value is double || value is long)))
                throw new Exception("Invalid number: " + label);
            double n = Convert.ToDouble(value);
            if (Double.IsNaN(n) || Double.IsInfinity(n) ||
                (r.ContainsKey("minimum") && n < Convert.ToDouble(r["minimum"])) ||
                (r.ContainsKey("maximum") && n > Convert.ToDouble(r["maximum"])))
                throw new Exception("Out of range: " + label);
        } else if (type == "array") {
            var a = value as System.Collections.IList;
            if (a == null || a.Count > Convert.ToInt32(r["maxItems"])) throw new Exception("Invalid array: " + label);
            foreach (var v in a) Rule(v, (Dictionary<string, object>)r["items"], label, depth + 1);
        } else if (type == "object") {
            var a = value as Dictionary<string, object>;
            if (a == null) throw new Exception("Invalid object: " + label);
            if (r.ContainsKey("properties")) {
                var props = (Dictionary<string, object>)r["properties"];
                foreach (string key in (System.Collections.IList)r["required"])
                    if (!a.ContainsKey(key)) throw new Exception("Missing argument: " + key);
                foreach (var kv in a) {
                    if (!props.ContainsKey(kv.Key)) throw new Exception("Unexpected argument: " + kv.Key);
                    Rule(kv.Value, (Dictionary<string, object>)props[kv.Key], kv.Key, depth + 1);
                }
            }
        }
        if (r.ContainsKey("enum")) {
            bool found = false;
            foreach (object x in (System.Collections.IList)r["enum"])
                if (Object.Equals(x, value)) found = true;
            if (!found) throw new Exception("Invalid enum: " + label);
        }
    }

    // Tools that can be a qa_batch step: the tab tools, without tab management.
    static bool BatchStep(string name) {
        if (name == "qa_batch" || name == "qa_tabs" || name == "qa_session" || name == "qa_downloads" ||
            name == "qa_record" || name == "qa_perf") return false;
        var props = (Dictionary<string, object>)((Dictionary<string, object>)Catalog[name]["inputSchema"])["properties"];
        return props.ContainsKey("tabId");
    }

    static void Validate(string name, Dictionary<string, object> a) {
        if (name == "__release" && a != null && a.Count == 0) return;
        if (name == null || !Catalog.ContainsKey(name)) throw new Exception("Unknown tool: " + name);
        if (a == null) throw new Exception("arguments must be an object");
        Rule(a, (Dictionary<string, object>)Catalog[name]["inputSchema"], name, 0);
        if (Encoding.UTF8.GetByteCount(Json(a)) > 262144) throw new Exception("Argument byte limit exceeded");
        if (a.ContainsKey("url") && (name == "qa_navigate" || name == "qa_tabs" || name == "qa_downloads")) {
            Uri u;
            if (!Uri.TryCreate((string)a["url"], UriKind.Absolute, out u) || (u.Scheme != "http" && u.Scheme != "https"))
                throw new Exception("Valid HTTP(S) URL required");
        }
        if (a.ContainsKey("file")) CheckFileName((string)a["file"]);
        if (name == "qa_batch" || (name == "qa_perf" && a.ContainsKey("steps"))) {
            // Each step gets the checks of its own tool: schema, URL, file name, upload paths.
            int n = 0;
            foreach (Dictionary<string, object> step in (System.Collections.IList)a["steps"]) {
                n++;
                string tool = Str(step, "tool");
                string at = "Step " + n + " (" + tool + "): ";
                if (!Catalog.ContainsKey(tool)) throw new Exception(at + "unknown tool");
                if (!BatchStep(tool)) throw new Exception(at + "this tool cannot be a qa_batch step");
                try {
                    CheckEnabled(tool);
                    var args = step.ContainsKey("args") ? step["args"] as Dictionary<string, object> : Obj();
                    if (args == null) throw new Exception("args must be an object");
                    if (args.ContainsKey("tabId")) throw new Exception("leave tabId out; the batch gives it");
                    args["tabId"] = a["tabId"];
                    Validate(tool, args);
                    args.Remove("tabId");
                    step["args"] = args;
                } catch (Exception e) {
                    throw new Exception(at + e.Message);
                }
            }
        }
        if (name == "qa_upload") {
            var paths = (System.Collections.IList)a["paths"];
            for (int i = 0; i < paths.Count; i++) {
                string file = LocalFile((string)paths[i]);
                if (!File.Exists(file)) throw new Exception("Upload path does not exist: " + file);
                paths[i] = file;
            }
        }
    }

    // An output file name from the agent: a name, not a path.
    static readonly Regex FileName = new Regex(@"^[A-Za-z0-9][A-Za-z0-9._ -]{0,119}$");
    static readonly Regex Reserved = new Regex(@"^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$", RegexOptions.IgnoreCase);

    static void CheckFileName(string name) {
        if (name == null || !FileName.IsMatch(name) || name.Contains("..") || name.EndsWith(".") || name.EndsWith(" ") ||
            Reserved.IsMatch(name))
            throw new Exception("file must be a file name, not a path: letters, digits, dot, dash, underscore or " +
                "space, up to 120 characters, for example page.txt");
    }

    // The WSL side of the agent: the folder where Windows drives are mounted (automount root in
    // /etc/wsl.conf, default /mnt/) and the distro. manage.py passes them to the MCP server
    // (--wsl-root, --wsl-distro), because a Windows program cannot see them.
    static string wslRoot = "/mnt/", wslDistro;
    static readonly Regex MountRoot = new Regex(@"^/([^/\\\x00-\x1f]+/)*$");

    static string CheckRoot(string root) {
        if (root == null) return "/mnt/";
        if (!MountRoot.IsMatch(root)) throw new Exception("--wsl-root must be a WSL folder that ends with /, for example /mnt/");
        return root;
    }

    // A Windows path as WSL sees it: C:\x\y -> /mnt/c/x/y (with the mount root of the agent's WSL).
    static string WslPath(string path, string root) {
        if (path.Length > 2 && path[1] == ':' && Char.IsLetter(path[0]))
            return root + Char.ToLowerInvariant(path[0]) + path.Substring(2).Replace('\\', '/');
        return path;
    }

    static string WslPath(string path) {
        return WslPath(path, wslRoot);
    }

    // A WSL path as Windows sees it: /mnt/c/x -> C:\x; any other path -> \\wsl.localhost\<distro>\...
    static string WindowsPath(string linux) {
        // In Linux, //x and /x are the same folder.
        string p = "/" + linux.TrimStart('/');
        if (p.StartsWith(wslRoot, StringComparison.Ordinal)) {
            string rest = p.Substring(wslRoot.Length);
            if (rest.Length > 0 && rest[0] < 128 && Char.IsLetter(rest[0]) && (rest.Length == 1 || rest[1] == '/'))
                return Char.ToUpperInvariant(rest[0]) + ":\\" + (rest.Length > 2 ? rest.Substring(2).Replace('/', '\\') : "");
        }
        string distro = wslDistro ?? Config.WslDistro();
        return @"\\wsl.localhost\" + distro + p.Replace('/', '\\');
    }

    // A network path makes Windows open an SMB connection with the user's login, before any check
    // could stop it, and a page can ask an agent for such a path. So only two kinds of path pass, checked
    // before Windows sees them and again after normalizing: a drive path (C:\...) and a WSL share.
    static string LocalFile(string raw) {
        string path;
        if (raw.StartsWith("/")) path = WindowsPath(raw);
        else if (DrivePath.IsMatch(raw) || WslShare.IsMatch(raw)) path = raw;
        else if (raw.StartsWith(@"\\") || raw.StartsWith(@"\?") || raw.StartsWith(@"\/") || raw.StartsWith(@"\."))
            throw new Exception(NetworkPathRefused);
        else throw new Exception("Absolute upload path required: C:\\..., /mnt/c/... or /home/...");
        path = Path.GetFullPath(path);
        if (!DrivePath.IsMatch(path) && !WslShare.IsMatch(path)) throw new Exception(NetworkPathRefused);
        return path;
    }

    const string NetworkPathRefused = "Network paths (\\\\server\\share) and device paths are refused: Windows would " +
        "connect to the server with your login. Use a path on this computer or in WSL";
    static readonly Regex DrivePath = new Regex(@"^[A-Za-z]:[\\/]");
    // \\wsl.localhost\<distro>\ or \\wsl$\<distro>\, where the distro is a name, not . or ..
    static readonly Regex WslShare = new Regex(@"^[\\/]{2}(wsl\.localhost|wsl\$)[\\/](?!\.{1,2}[\\/])[^\\/?*:]+[\\/]",
        RegexOptions.IgnoreCase);

    const string Instructions =
        "Native Windows Chrome for WSL, in a dedicated QA profile. Open a page with qa_tabs action=new; it " +
        "returns the page as an accessibility tree with refs like [e12]. Act with the refs (qa_click, qa_fill, qa_type); " +
        "each action returns only what changed. Put several steps in one qa_batch. Use file to save big output. " +
        "qa_record makes an MP4 video of a tab; qa_perf measures speed and memory. " +
        "A session controls only the tabs it claims; cleanup or disconnect closes them unless kept. " +
        "If policy.json is active, some tools work only on allowed sites (qa_session shows the policy). " +
        "The agent's own confirmation and safety rules still apply. Do not silently fall back to another browser.";

    static object Tools() {
        var list = new List<Dictionary<string, object>>();
        foreach (string name in ToolOrder) {
            if (!Enabled.Contains(name)) continue;
            var t = Catalog[name];
            list.Add(Obj("name", name, "description", t["description"], "inputSchema", Advertised(t["inputSchema"])));
        }
        return list;
    }

    // The schema the agent sees. Size limits and ranges stay in catalog.json, and Validate still
    // checks them, but they only cost the agent context.
    static readonly string[] ServerOnly = { "maxLength", "maxItems", "minimum", "maximum", "additionalProperties" };

    static object Advertised(object v) {
        var d = v as Dictionary<string, object>;
        if (d != null) {
            var copy = new Dictionary<string, object>();
            foreach (var kv in d) {
                if (Array.IndexOf(ServerOnly, kv.Key) >= 0) continue;
                if (kv.Key == "required" && ((System.Collections.IList)kv.Value).Count == 0) continue;
                copy[kv.Key] = kv.Key == "properties" || kv.Key == "items" ? AdvertisedProps(kv.Key, kv.Value) : kv.Value;
            }
            return copy;
        }
        return v;
    }

    static object AdvertisedProps(string key, object v) {
        if (key == "items") return Advertised(v);
        var copy = new Dictionary<string, object>();
        foreach (var kv in (Dictionary<string, object>)v) copy[kv.Key] = Advertised(kv.Value);
        return copy;
    }

    // A JSON-RPC error with its code. Other exceptions in a request are internal errors.
    class RpcError : Exception {
        public readonly int Code;
        public readonly object Data;

        public RpcError(int code, string message) : base(message) {
            Code = code;
        }

        public RpcError(int code, string message, object data) : base(message) {
            Code = code;
            Data = data;
        }
    }

    // MCP server state. One process serves one agent connection.
    static NamedPipeClientStream pipe;
    static Lifecycle.Lease lease;
    // The session id the native host gave this connection. Output files go to output\<session>.
    static string sessionId;
    // served: the native host answered at least one call. refusal: why it last closed the connection.
    static bool served;
    static string refusal;

    static void Connect() {
        // Keep the lease of a Chrome this process started, so it is stopped at exit even after a reconnect.
        var next = Lifecycle.Ensure(true);
        if (lease == null || next.launched) lease = next;
        var deadline = DateTime.UtcNow.AddSeconds(45);
        int delay = 250;
        string last = "";
        while (DateTime.UtcNow < deadline) {
            pipe = new NamedPipeClientStream(".", PipeName(), PipeDirection.InOut, PipeOptions.None,
                TokenImpersonationLevel.Identification);
            try {
                pipe.Connect(500);
                return;
            } catch (Exception e) {
                last = e.Message;
                pipe.Dispose();
                pipe = null;
                Thread.Sleep(delay);
                delay = Math.Min(delay * 2, 2000);
            }
        }
        throw new Exception("QA Chrome did not connect within 45 s (" + Lifecycle.Snapshot().Count +
            " Chrome processes use the QA profile). Run: python3 manage.py doctor. Last pipe error: " + last);
    }

    // One tool call. Returns the MCP tool result; a failure is a result with isError=true.
    static Dictionary<string, object> CallTool(string name, Dictionary<string, object> a) {
        Dictionary<string, object> r;
        try {
            CheckEnabled(name);
            Validate(name, a);
            if (pipe == null) Connect();
            try {
                Frame(pipe, Json(Obj("method", name, "args", a, "wslRoot", wslRoot)));
                r = Parse(ReadFrame(pipe));
            } catch (Exception e) {
                pipe.Dispose();
                pipe = null;
                throw new Exception("Lost the connection to QA Chrome during " + name + ": " + e.Message.TrimEnd('.') +
                    ". The next call reconnects. The action may or may not have happened");
            }
        } catch (Exception e) {
            return ToolError(e.Message);
        }
        if (r.ContainsKey("closed")) {
            // The native host refused this connection and closed it. The next call connects again.
            pipe.Dispose();
            pipe = null;
            refusal = r["error"] as string ?? "";
        } else
            served = true;
        if (r.ContainsKey("error")) return ToolError(r["error"] as string ?? "Unknown error");
        if (Str(r, "session") != null) sessionId = Str(r, "session");
        // The extension's reply: result, and beside it (never inside it, so page values cannot make
        // them) plain text or an image. The native host already saved the files (SaveFiles).
        object result = r.ContainsKey("result") ? r["result"] : null;
        var img = r.ContainsKey("image") ? r["image"] as Dictionary<string, object> : null;
        var content = new List<object>();
        var d = result as Dictionary<string, object>;
        if (img != null) {
            // The image, then its fields (size, and whether it was scaled down).
            content.Add(Obj("type", "image", "mimeType", img["mimeType"], "data", img["data"]));
            if (d != null && d.Count > 0) content.Add(Obj("type", "text", "text", Json(result)));
            return Obj("content", content);
        }
        if (d != null && name == "qa_session") d["outputFolder"] = WslPath(OutputFolder());
        string text = Str(r, "text");
        if (d == null || d.Count > 0 || text == null) content.Add(Obj("type", "text", "text", Json(result)));
        if (text != null) content.Add(Obj("type", "text", "text", text));
        return Obj("content", content);
    }

    static string OutputFolder() {
        return OutputFolder(sessionId ?? "no-session");
    }

    static string OutputFolder(string session) {
        return Path.Combine(Config.RootFile("output"), session);
    }

    // The native host saves the files that the extension's reply asks for: {files: [{at, name,
    // text | base64, ext}]} beside the result. Only extension code makes these entries, never a page
    // value. Each saved file's {path, windowsPath, bytes} goes into the result at "at".
    static void SaveFiles(Dictionary<string, object> reply, string session, string root) {
        var files = reply.ContainsKey("files") ? reply["files"] as System.Collections.IList : null;
        if (files == null) return;
        reply.Remove("files");
        object result = reply.ContainsKey("result") ? reply["result"] : null;
        try {
            foreach (Dictionary<string, object> f in files)
                result = Place(result, (System.Collections.IList)f["at"], 0, SaveFile(f, session, root));
        } catch (Exception e) {
            throw new Exception("Could not save the file: " + e.Message);
        }
        reply["result"] = result;
    }

    // At each native host start (each QA Chrome start), remove session output folders that did not
    // change for keepOutputDays days. Only folders named like a session id, directly in
    // <root>\output, that hold only files. No link is followed.
    static readonly Regex SessionFolder = new Regex("^[a-f0-9]{32}$");

    static void CleanOutput() {
        try {
            var output = new DirectoryInfo(Config.RootFile("output"));
            if (!output.Exists || (output.Attributes & FileAttributes.ReparsePoint) != 0) return;
            DateTime limit = DateTime.UtcNow.AddDays(-Config.KeepOutputDays);
            foreach (var dir in output.GetDirectories()) {
                try {
                    if (!SessionFolder.IsMatch(dir.Name) || (dir.Attributes & FileAttributes.ReparsePoint) != 0 ||
                        dir.GetDirectories().Length > 0)
                        continue;
                    var files = dir.GetFiles();
                    DateTime newest = dir.LastWriteTimeUtc;
                    foreach (var f in files)
                        if (f.LastWriteTimeUtc > newest) newest = f.LastWriteTimeUtc;
                    if (newest > limit) continue;
                    // Deleting a file link deletes the link, not its target.
                    foreach (var f in files) f.Delete();
                    dir.Delete(false);
                } catch { }
            }
        } catch { }
    }

    // Put value at path (keys and list indexes) in v. Returns v, or value for an empty path.
    static object Place(object v, System.Collections.IList path, int i, object value) {
        if (i == path.Count) return value;
        var d = v as Dictionary<string, object>;
        if (d != null && path[i] is string) {
            string key = (string)path[i];
            d[key] = Place(d.ContainsKey(key) ? d[key] : null, path, i + 1, value);
            return v;
        }
        var list = v as System.Collections.IList;
        if (list != null && path[i] is int && (int)path[i] < list.Count) {
            list[(int)path[i]] = Place(list[(int)path[i]], path, i + 1, value);
            return v;
        }
        throw new Exception("the extension gave a file place that is not in the result");
    }

    // f: {name, text | base64, ext}. Returns {path, windowsPath, bytes}.
    static Dictionary<string, object> SaveFile(Dictionary<string, object> f, string session, string root) {
        string name = Str(f, "name");
        CheckFileName(name);
        string ext = Str(f, "ext");
        if (ext != null && Path.GetExtension(name) == "") name += "." + ext;
        byte[] bytes = f.ContainsKey("base64") ? Convert.FromBase64String((string)f["base64"])
            : Encoding.UTF8.GetBytes(Str(f, "text") ?? "");
        string folder = OutputFolder(session);
        Directory.CreateDirectory(folder);
        string path = Path.Combine(folder, name);
        File.WriteAllBytes(path, bytes);
        return Obj("path", WslPath(path, root), "windowsPath", path, "bytes", bytes.Length);
    }

    static Dictionary<string, object> ToolError(string message) {
        return Obj("isError", true, "content", new[] { Obj("type", "text", "text", message) });
    }

    // MCP versions this server speaks, newest first. The legacy ones use the initialize handshake, and
    // the server uses no feature that one of them lacks.
    static readonly string[] Protocols = { "2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05" };
    // The modern version: no handshake. Each request names its version in _meta (MCP 2026-07-28,
    // "Versioning and Compatibility"). A request without it is served as before, after initialize.
    const string Modern = "2026-07-28";
    const string MetaVersion = "io.modelcontextprotocol/protocolVersion";

    // MCP lifecycle, version negotiation: "If the server supports the requested protocol version, it
    // MUST respond with the same version. Otherwise, the server MUST respond with another protocol
    // version it supports. This SHOULD be the latest version supported by the server."
    static string ProtocolVersion(Dictionary<string, object> request) {
        var p = request.ContainsKey("params") ? request["params"] as Dictionary<string, object> : null;
        string asked = p == null ? null : Str(p, "protocolVersion");
        return Array.IndexOf(Protocols, asked) >= 0 ? asked : Protocols[0];
    }

    // A tool list never changes while this process runs (toolGroups is read at start). Clients may keep
    // tools/list and server/discover results this long. "private": they depend on this machine's settings.
    const int CacheMs = 300000;

    static Dictionary<string, object> ServerInfo() {
        return Obj("name", "windows-chrome-bridge", "version", Config.Version);
    }

    // One request of a modern client (MCP 2026-07-28): no session, the version and the client
    // capabilities come with each request. Every result has resultType and names the server.
    static Dictionary<string, object> ModernRequest(string method, Dictionary<string, object> p,
        Dictionary<string, object> meta) {
        string version = meta == null ? null : Str(meta, MetaVersion);
        var supported = new List<string> { Modern };
        supported.AddRange(Protocols);
        if (version == null) throw new RpcError(-32602, "Invalid params: _meta needs " + MetaVersion + " (a string)");
        if (version != Modern)
            throw new RpcError(-32022, "Unsupported protocol version", Obj("supported", supported, "requested", version));
        object capabilities;
        if (!meta.TryGetValue("io.modelcontextprotocol/clientCapabilities", out capabilities) ||
            !(capabilities is Dictionary<string, object>))
            throw new RpcError(-32602, "Invalid params: _meta needs io.modelcontextprotocol/clientCapabilities (an object)");
        Dictionary<string, object> result;
        if (method == "server/discover")
            result = Obj("supportedVersions", supported, "capabilities", Obj("tools", Obj()), "instructions", Instructions,
                "ttlMs", CacheMs, "cacheScope", "private");
        else if (method == "tools/list")
            result = Obj("tools", Tools(), "ttlMs", CacheMs, "cacheScope", "private");
        else if (method == "tools/call")
            result = ToolCall(p);
        else
            throw new RpcError(-32601, "Unknown MCP method: " + method);
        result["resultType"] = "complete";
        result["_meta"] = Obj("io.modelcontextprotocol/serverInfo", ServerInfo());
        return result;
    }

    static Dictionary<string, object> ToolCall(Dictionary<string, object> p) {
        string name = p == null ? null : Str(p, "name");
        if (name == null || !Catalog.ContainsKey(name)) throw new RpcError(-32602, "Unknown tool: " + name);
        var a = p.ContainsKey("arguments") ? p["arguments"] as Dictionary<string, object> : Obj();
        return CallTool(name, a);
    }

    static void Mcp() {
        mcpServer = true;
        Console.InputEncoding = new UTF8Encoding(false, true);
        Console.OutputEncoding = new UTF8Encoding(false, true);
        try {
            string line;
            while ((line = Console.ReadLine()) != null) {
                object id = null;
                bool reply = false;
                try {
                    if (line.Length > 1024 * 1024) throw new RpcError(-32600, "Request too large");
                    var q = Parse(line);
                    // A message without an id is a notification: no reply.
                    if (!q.TryGetValue("id", out id)) continue;
                    reply = true;
                    string method = Str(q, "method");
                    var p = q.ContainsKey("params") ? q["params"] as Dictionary<string, object> : null;
                    var meta = p != null && p.ContainsKey("_meta") ? p["_meta"] as Dictionary<string, object> : null;
                    object result;
                    // A dual-era server: _meta with a protocol version (or server/discover, which only
                    // modern clients send) is a modern request. Anything else is served as in 2025-11-25.
                    if (method == "server/discover" || (meta != null && meta.ContainsKey(MetaVersion)))
                        result = ModernRequest(method, p, meta);
                    else if (method == "initialize")
                        result = Obj(
                            "protocolVersion", ProtocolVersion(q),
                            "capabilities", Obj("tools", Obj()),
                            "serverInfo", ServerInfo(),
                            "instructions", Instructions);
                    else if (method == "ping")
                        result = Obj();
                    else if (method == "tools/list")
                        result = Obj("tools", Tools());
                    else if (method == "tools/call")
                        result = ToolCall(p);
                    else
                        throw new RpcError(-32601, "Unknown MCP method: " + method);
                    Console.WriteLine(Json(Obj("jsonrpc", "2.0", "id", id, "result", result)));
                } catch (Exception e) {
                    if (reply) {
                        var error = Obj("code", e is RpcError ? ((RpcError)e).Code : -32603, "message", e.Message);
                        if (e is RpcError && ((RpcError)e).Data != null) error["data"] = ((RpcError)e).Data;
                        Console.WriteLine(Json(Obj("jsonrpc", "2.0", "id", id, "error", error)));
                    }
                }
            }
        } finally {
            // The native host ends the session when the pipe closes, and the last session out stops
            // Chrome (see IdleCheck). Real agents kill this process, so nothing else may depend on this.
            if (pipe != null) pipe.Dispose();
            // If this process started Chrome and no call was ever served, the native host may never have
            // come up, and then nothing else stops that Chrome. "Too many QA sessions" means other
            // clients use it: keep it.
            if (lease != null && lease.launched && !served &&
                (refusal == null || !refusal.StartsWith("Too many QA sessions")))
                Console.Error.WriteLine(Lifecycle.Json(Lifecycle.Stop(lease, true)));
        }
    }

    // qa-bridge.exe --lifecycle-stop-idle [--even-with-windows], for manage.py stop, install, rollback
    // and uninstall: stop QA Chrome when no agent session is connected. Without the flag, open QA
    // windows (for example kept tabs) also keep it running.
    static object StopIdle(bool evenWithWindows) {
        var root = Lifecycle.Snapshot().Find(e => e.root);
        if (root == null) return Obj("running", false, "stopped", false);
        int others = 0;
        bool windows = false;
        using (var p = new NamedPipeClientStream(".", PipeName(), PipeDirection.InOut, PipeOptions.None,
            TokenImpersonationLevel.Identification)) {
            bool connected = false;
            try {
                p.Connect(3000);
                connected = true;
            } catch {
                // No native host: no agent session can be connected.
            }
            if (connected) {
                try {
                    Frame(p, Json(Obj("method", "__release", "args", Obj())));
                    var r = Parse(ReadFrame(p));
                    if (r.ContainsKey("error")) {
                        // A refused connection: the session limit is full, or the native host refuses new
                        // sessions (a bad handshake or policy.json). Sessions that connected before can still
                        // be working, so count them. Without a count, do not stop.
                        others = r.ContainsKey("clients") ? Convert.ToInt32(r["clients"]) - 1 : -1;
                    } else {
                        others = r.ContainsKey("clients") ? Convert.ToInt32(r["clients"]) - 1 : -1;
                        var data = r.ContainsKey("result") ? r["result"] as Dictionary<string, object> : null;
                        windows = data != null && data.ContainsKey("preservedWindow") && (bool)data["preservedWindow"];
                    }
                } catch {
                    others = -1;
                }
            }
        }
        if (others != 0 || (windows && !evenWithWindows))
            return Obj("running", true, "stopped", false, "sessions", others, "windows", windows);
        Lifecycle.Stop(new Lifecycle.Lease { launched = true, root = root }, true);
        bool gone = Lifecycle.Snapshot().Count == 0;
        return Obj("running", !gone, "stopped", gone, "sessions", 0, "windows", windows);
    }

    // --mcp [--wsl-distro NAME] [--wsl-root /mnt/]. manage.py writes them into the agent's config.
    static void McpOptions(string[] args) {
        for (int i = 1; i < args.Length; i += 2) {
            if (i + 1 >= args.Length) throw new Exception(args[i] + " needs a value");
            if (args[i] == "--wsl-root") wslRoot = CheckRoot(args[i + 1]);
            else if (args[i] == "--wsl-distro") wslDistro = Config.CheckDistro(args[i + 1]);
            else throw new Exception("Unknown option " + args[i] + ". Use: qa-bridge.exe --mcp [--wsl-distro NAME] [--wsl-root /mnt/]");
        }
    }

    static int Main(string[] args) {
        try {
            // Paths in the output can hold any letters (a user name such as Jürgen). WSL reads UTF-8.
            // The native host writes bytes to Chrome itself, so it keeps the console as it is.
            if (args.Length >= 1 && args[0].StartsWith("--") && args[0] != "--chrome-keeper" && args[0] != "--mcp") {
                Console.SetOut(new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true });
                Console.SetError(new StreamWriter(Console.OpenStandardError(), new UTF8Encoding(false)) { AutoFlush = true });
            }
            if (args.Length >= 1 && args[0] != "--version" && args[0] != "--foreground" && !Config.Installed)
                throw new Exception("This qa-bridge.exe is not installed. Run: python3 manage.py install, then use the " +
                    "exe in the install folder");
            if (args.Length >= 1 && args[0] == "--mcp") {
                McpOptions(args);
                Mcp();
            }
            else if (args.Length >= 1 && args[0].StartsWith("chrome-extension://"))
                Native(args[0]);
            else if (args.Length == 1 && args[0] == "--chrome-keeper")
                Lifecycle.Keeper();
            else if (args.Length == 1 && args[0] == "--version")
                Console.WriteLine("windows-chrome-bridge " + Config.Version);
            // Used by manage.py and the live tests.
            else if (args.Length == 1 && args[0] == "--lifecycle-snapshot")
                Console.WriteLine(Lifecycle.Json(Lifecycle.Snapshot()));
            else if (args.Length == 1 && args[0] == "--lifecycle-start")
                Console.WriteLine(Lifecycle.Json(Lifecycle.Ensure(false)));
            else if (args.Length == 2 && args[0] == "--lifecycle-stop") {
                var stop = new JavaScriptSerializer().Deserialize<Lifecycle.Lease>(args[1]);
                Console.WriteLine(Lifecycle.Json(Lifecycle.Stop(stop, true)));
            } else if (args.Length >= 1 && args.Length <= 2 && args[0] == "--lifecycle-stop-idle" &&
                (args.Length == 1 || args[1] == "--even-with-windows"))
                Console.WriteLine(Json(StopIdle(args.Length == 2)));
            else if (args.Length == 1 && args[0] == "--foreground")
                Console.WriteLine(Lifecycle.Json(Lifecycle.ForegroundInfo()));
            else
                throw new Exception("Usage: qa-bridge.exe --mcp [--wsl-distro NAME] [--wsl-root /mnt/] | --version. " +
                    "Chrome starts the native host itself");
            return 0;
        } catch (Exception e) {
            Console.Error.WriteLine(e.Message);
            return 1;
        }
    }
}
