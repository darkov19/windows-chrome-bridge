using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.Diagnostics;
using System.Threading;
using System.Management;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;

static class Lifecycle {
    // Finds, starts and stops the QA Chrome: the chrome.exe processes that use the QA profile.
    // Paths come from Config (bridge-config.json or detected defaults).
    static string Profile {
        get { return Config.Profile; }
    }

    static string Chrome {
        get { return Config.Chrome; }
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO {
        public int cb;
        public string lpReserved, lpDesktop, lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION {
        public IntPtr hProcess, hThread;
        public uint processId, threadId;
    }

    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);

    [StructLayout(LayoutKind.Sequential)]
    struct STARTUPINFOEX {
        public STARTUPINFO StartupInfo;
        public IntPtr lpAttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct SECURITY_ATTRIBUTES {
        public int length;
        public IntPtr descriptor;
        public int inherit;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "CreateProcessW")]
    static extern bool CreateProcessEx(string app, StringBuilder command, IntPtr processAttributes,
        IntPtr threadAttributes, bool inherit, uint flags, IntPtr environment, string directory,
        ref STARTUPINFOEX startup, out PROCESS_INFORMATION info);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SECURITY_ATTRIBUTES sa, int size);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value,
        IntPtr size, IntPtr previous, IntPtr returnSize);

    [DllImport("kernel32.dll")]
    static extern void DeleteProcThreadAttributeList(IntPtr list);

    public class Entry {
        public int pid;
        public int parent;
        public string started;
        public bool root;
        public string commandLine;
    }

    // A QA Chrome that a caller found (launched=false) or started (launched=true).
    public class Lease {
        public bool launched;
        public Entry root;
    }

    [DllImport("user32.dll")]
    static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);

    // qa-bridge.exe --foreground: the Windows foreground window and its process. Used by live tests
    // to prove that tool calls do not change it.
    public static object ForegroundInfo() {
        IntPtr window = GetForegroundWindow();
        uint pid;
        GetWindowThreadProcessId(window, out pid);
        string name = null;
        try {
            name = Process.GetProcessById((int)pid).ProcessName;
        } catch { }
        return new { window = window.ToInt64(), pid = pid, process = name };
    }

    static bool ProfileMatch(string command) {
        var m = Regex.Match(command ?? "", @"(?:^|\s)--user-data-dir(?:=|\s)(?:""([^""]+)""|(\S+))",
            RegexOptions.IgnoreCase);
        if (!m.Success) return false;
        string p = m.Groups[1].Success ? m.Groups[1].Value : m.Groups[2].Value;
        return String.Equals(p.TrimEnd('\\'), Profile, StringComparison.OrdinalIgnoreCase);
    }

    public static List<Entry> Snapshot() {
        var list = new List<Entry>();
        var selected = new HashSet<int>();
        using (var query = new ManagementObjectSearcher(
            "SELECT ProcessId,ParentProcessId,CreationDate,ExecutablePath,CommandLine FROM Win32_Process WHERE Name='chrome.exe'")) {
            foreach (ManagementObject p in query.Get()) {
                string exe = p["ExecutablePath"] as string;
                if (!String.Equals(exe, Chrome, StringComparison.OrdinalIgnoreCase)) continue;
                bool root = ProfileMatch(p["CommandLine"] as string) &&
                    !(p["CommandLine"] as string ?? "").Contains("--type=");
                var e = new Entry {
                    pid = Convert.ToInt32(p["ProcessId"]),
                    parent = Convert.ToInt32(p["ParentProcessId"]),
                    started = p["CreationDate"] as string,
                    root = root,
                    commandLine = p["CommandLine"] as string
                };
                list.Add(e);
                if (root) selected.Add(e.pid);
            }
        }
        bool changed;
        do {
            changed = false;
            foreach (var e in list)
                if (selected.Contains(e.parent) && selected.Add(e.pid)) changed = true;
        } while (changed);
        return list.FindAll(e => selected.Contains(e.pid));
    }

    public static void AssertNativeProfile() {
        int pid = Process.GetCurrentProcess().Id;
        string exe = null, command = null;
        for (int depth = 0; depth < 4; depth++) {
            using (var q = new ManagementObjectSearcher(
                "SELECT ParentProcessId FROM Win32_Process WHERE ProcessId=" + pid)) {
                foreach (ManagementObject p in q.Get()) pid = Convert.ToInt32(p["ParentProcessId"]);
            }
            using (var q = new ManagementObjectSearcher(
                "SELECT ExecutablePath,CommandLine FROM Win32_Process WHERE ProcessId=" + pid)) {
                foreach (ManagementObject p in q.Get()) {
                    exe = p["ExecutablePath"] as string;
                    command = p["CommandLine"] as string;
                }
            }
            if (String.Equals(exe, Chrome, StringComparison.OrdinalIgnoreCase)) {
                if (!ProfileMatch(command)) throw new Exception("Native host parent is not the dedicated QA profile");
                return;
            }
        }
        throw new Exception("Native host must be launched by dedicated QA Chrome");
    }

    // forSessions: an MCP server starts Chrome for its agent session. It writes a marker into the
    // profile, so whichever MCP server leaves last can stop that Chrome (see StartedForSessions).
    // A QA Chrome started any other way (--lifecycle-start, by hand) is never stopped by a session.
    // Two agents that start at the same moment must not both launch Chrome on one profile: the second
    // Chrome hands over to the first and closes its CDP pipe. So the check and the launch run under a
    // mutex that all processes of this Windows user share.
    public static Lease Ensure(bool forSessions) {
        using (var start = new Mutex(false, @"Local\" + Config.NamePrefix + "-start-" +
            System.Security.Principal.WindowsIdentity.GetCurrent().User.Value)) {
            try {
                if (!start.WaitOne(90000)) throw new Exception("Another process is still starting QA Chrome after 90 s");
            } catch (AbandonedMutexException) {
                // The process that held it ended; the mutex is now ours.
            }
            try {
                var existing = Snapshot().Find(e => e.root);
                if (existing != null) return new Lease { launched = false, root = existing };
                var root = Launch();
                try {
                    if (forSessions) File.WriteAllText(MarkerPath, root.pid + " " + root.started);
                    else File.Delete(MarkerPath);
                } catch { }
                return new Lease { launched = true, root = root };
            } finally {
                start.ReleaseMutex();
            }
        }
    }

    static string MarkerPath {
        get { return Path.Combine(Profile, "windows-chrome-bridge-sessions.txt"); }
    }

    // True when root is a QA Chrome that an MCP server started for agent sessions.
    public static bool StartedForSessions(Entry root) {
        try {
            return root != null && File.ReadAllText(MarkerPath) == root.pid + " " + root.started;
        } catch {
            return false;
        }
    }

    // Starts QA Chrome and loads the extension into it, with no clicks.
    // Branded Chrome ignores --load-extension (Chrome 137+). Instead Chrome starts with a CDP pipe
    // (two inherited handles, no TCP port) and Extensions.loadUnpacked loads the unpacked extension.
    // That load lasts for this Chrome run only, and Chrome exits when the pipe closes. So a small
    // keeper process (qa-bridge.exe --chrome-keeper) starts Chrome and holds the pipe until Chrome exits.
    // The keeper reports one JSON line on its stdout, then this process stops listening.
    static Entry Launch() {
        if (!File.Exists(Chrome)) throw new Exception("Chrome not found at " + Chrome + ". Set chrome in bridge-config.json");
        var sa = new SECURITY_ATTRIBUTES { length = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)), inherit = 1 };
        IntPtr statusRead, statusWrite;
        if (!CreatePipe(out statusRead, out statusWrite, ref sa, 0))
            throw new Exception("CreatePipe failed: " + Marshal.GetLastWin32Error());
        SetHandleInformation(statusRead, 1, 0);
        string self = System.Reflection.Assembly.GetExecutingAssembly().Location;
        PROCESS_INFORMATION pi;
        try {
            // CREATE_NO_WINDOW: the keeper has no console window.
            StartWithHandles(self, "\"" + self + "\" --chrome-keeper", new[] { statusWrite }, statusWrite, 0x08000000,
                Config.Dir, out pi);
        } catch {
            CloseHandle(statusRead);
            throw;
        } finally {
            CloseHandle(statusWrite);
        }
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
        string line;
        using (var status = new StreamReader(new FileStream(
            new Microsoft.Win32.SafeHandles.SafeFileHandle(statusRead, true), FileAccess.Read), Encoding.UTF8))
            line = status.ReadLine();
        if (line == null) throw new Exception("The Chrome keeper process ended without a report");
        var report = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(line);
        if (report.ContainsKey("error")) throw new Exception((string)report["error"]);
        int pid = Convert.ToInt32(report["pid"]);
        var deadline = DateTime.UtcNow.AddSeconds(15);
        while (DateTime.UtcNow < deadline) {
            var root = Snapshot().Find(e => e.root && e.pid == pid);
            if (root != null) return root;
            Thread.Sleep(300);
        }
        throw new Exception("Dedicated QA Chrome launch failed: no matching profile process appeared within 15s");
    }

    static string ModeFlags() {
        if (Config.WindowMode == "headless") {
            // Headless Chrome says "HeadlessChrome" in its user agent. Use the normal one.
            int major = FileVersionInfo.GetVersionInfo(Chrome).FileMajorPart;
            return " --headless --screen-info=\"{0,0 1920x1080}\" --user-agent=\"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" +
                " (KHTML, like Gecko) Chrome/" + major + ".0.0.0 Safari/537.36\"";
        }
        return " --disable-backgrounding-occluded-windows";
    }

    // qa-bridge.exe --chrome-keeper. See Launch.
    public static void Keeper() {
        var stdout = Console.OpenStandardOutput();
        Action<object> report = o => {
            byte[] b = Encoding.UTF8.GetBytes(Json(o) + "\n");
            stdout.Write(b, 0, b.Length);
            stdout.Flush();
            stdout.Close();
        };
        IntPtr toChromeWrite = IntPtr.Zero, fromChromeRead = IntPtr.Zero;
        int pid;
        try {
            string folder = Config.ExtensionFolder;
            if (!File.Exists(Path.Combine(folder, "manifest.json")))
                throw new Exception("No extension at " + folder + " (manifest.json is missing)");
            Directory.CreateDirectory(Profile);
            var sa = new SECURITY_ATTRIBUTES { length = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)), inherit = 1 };
            IntPtr toChromeRead, fromChromeWrite;
            if (!CreatePipe(out toChromeRead, out toChromeWrite, ref sa, 0) ||
                !CreatePipe(out fromChromeRead, out fromChromeWrite, ref sa, 0))
                throw new Exception("CreatePipe failed: " + Marshal.GetLastWin32Error());
            // Only Chrome's two ends may be inherited.
            SetHandleInformation(toChromeWrite, 1, 0);
            SetHandleInformation(fromChromeRead, 1, 0);
            // Display mode adds --disable-backgrounding-occluded-windows: a QA window behind other windows
            // still counts as visible, so clicks work without taking OS focus (see background.js).
            string command = "\"" + Chrome + "\" --user-data-dir=\"" + Profile +
                "\" --profile-directory=Default --no-first-run --no-default-browser-check --no-startup-window --keep-alive-for-test" +
                ModeFlags() +
                " --enable-unsafe-extension-debugging --remote-debugging-pipe --remote-debugging-io-pipes=" +
                toChromeRead.ToInt64() + "," + fromChromeWrite.ToInt64();
            PROCESS_INFORMATION pi;
            try {
                StartWithHandles(Chrome, command, new[] { toChromeRead, fromChromeWrite }, IntPtr.Zero, 0,
                    Path.GetDirectoryName(Chrome), out pi);
            } finally {
                CloseHandle(toChromeRead);
                CloseHandle(fromChromeWrite);
            }
            CloseHandle(pi.hThread);
            CloseHandle(pi.hProcess);
            pid = (int)pi.processId;
            var output = new FileStream(new Microsoft.Win32.SafeHandles.SafeFileHandle(toChromeWrite, true), FileAccess.Write);
            var input = new FileStream(new Microsoft.Win32.SafeHandles.SafeFileHandle(fromChromeRead, true), FileAccess.Read);
            string error = null;
            try {
                var reply = PipeCall(output, input, 1, "Extensions.loadUnpacked",
                    new Dictionary<string, object> { { "path", folder } });
                // Chrome can keep the cached service worker of the extension it loaded at the last start,
                // also after an upgrade to another version. Then a second load (a reload) is needed.
                // Do it only when the extension changed: on a new profile, a reload while the first
                // service worker connects leaves an orphan native host that holds the pipe name.
                if (!reply.ContainsKey("error") && NeedsReload(folder))
                    reply = PipeCall(output, input, 2, "Extensions.loadUnpacked",
                        new Dictionary<string, object> { { "path", folder } });
                if (reply.ContainsKey("error")) error = "Extensions.loadUnpacked failed: " + Json(reply["error"]);
            } catch (Exception e) {
                error = "Could not load the extension into QA Chrome: " + e.Message;
            }
            if (error != null) {
                try {
                    Process.GetProcessById(pid).Kill();
                } catch { }
                throw new Exception(error);
            }
            report(new Dictionary<string, object> { { "pid", pid } });
            // Hold the pipe until Chrome exits, and serve garbage collections meanwhile.
            GcService(output, input);
        } catch (Exception e) {
            try {
                report(new Dictionary<string, object> { { "error", e.Message } });
            } catch { }
        }
    }

    // After the extension is loaded, the keeper reads the CDP pipe until Chrome exits. Meanwhile it
    // serves one command on a named pipe that only this Windows user can open: a full garbage
    // collection of one page (HeapProfiler.collectGarbage), for qa_perf. Chrome does not give
    // extensions that command. Nothing else can be sent to Chrome through it.
    static readonly Dictionary<int, Dictionary<string, object>> cdpReplies = new Dictionary<int, Dictionary<string, object>>();
    static int cdpId = 100;
    static readonly Regex TargetId = new Regex("^[0-9A-F]{32}$");

    static void GcService(Stream output, Stream input) {
        var reader = new Thread(() => {
            var serializer = new JavaScriptSerializer { MaxJsonLength = 16 * 1024 * 1024 };
            var buffer = new MemoryStream();
            try {
                int b;
                while ((b = input.ReadByte()) >= 0) {
                    if (b != 0) {
                        buffer.WriteByte((byte)b);
                        continue;
                    }
                    var message = serializer.Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(buffer.ToArray()));
                    buffer.SetLength(0);
                    object id;
                    if (message != null && message.TryGetValue("id", out id))
                        lock (cdpReplies) {
                            cdpReplies[Convert.ToInt32(id)] = message;
                            Monitor.PulseAll(cdpReplies);
                        }
                }
            } catch { }
            // Chrome exited.
            Environment.Exit(0);
        });
        reader.IsBackground = true;
        reader.Start();
        bool first = true;
        while (true) {
            var pipe = Bridge.Server(Bridge.KeeperPipeName(), first);
            first = false;
            pipe.WaitForConnection();
            var worker = new Thread(() => {
                using (pipe) {
                    try {
                        var q = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(Bridge.ReadFrame(pipe));
                        string answer;
                        try {
                            answer = Json(CollectGarbage(output, q));
                        } catch (Exception e) {
                            answer = Json(new Dictionary<string, object> { { "error", e.Message } });
                        }
                        Bridge.Frame(pipe, answer);
                    } catch { }
                }
            });
            worker.IsBackground = true;
            worker.Start();
        }
    }

    static object CollectGarbage(Stream output, Dictionary<string, object> q) {
        object method, target;
        q.TryGetValue("method", out method);
        q.TryGetValue("targetId", out target);
        if ((method as string) != "gc" || !TargetId.IsMatch(target as string ?? ""))
            throw new Exception("The keeper only runs gc for a page target id");
        var info = Cdp(output, "Target.getTargetInfo", new Dictionary<string, object> { { "targetId", target } }, null);
        var targetInfo = info["targetInfo"] as Dictionary<string, object>;
        string type = targetInfo == null ? null : targetInfo["type"] as string;
        if (type != "page" && type != "iframe") throw new Exception("Not a page: " + type);
        var attached = Cdp(output, "Target.attachToTarget",
            new Dictionary<string, object> { { "targetId", target }, { "flatten", true } }, null);
        string session = (string)attached["sessionId"];
        try {
            Cdp(output, "HeapProfiler.collectGarbage", new Dictionary<string, object>(), session);
        } finally {
            Cdp(output, "Target.detachFromTarget", new Dictionary<string, object> { { "sessionId", session } }, null);
        }
        return new Dictionary<string, object> { { "result", new Dictionary<string, object> { { "collected", true } } } };
    }

    // One CDP command over the keeper's pipe. Returns its result, or throws its error.
    static Dictionary<string, object> Cdp(Stream output, string method, Dictionary<string, object> parameters,
        string session) {
        int id = Interlocked.Increment(ref cdpId);
        var message = new Dictionary<string, object> { { "id", id }, { "method", method }, { "params", parameters } };
        if (session != null) message["sessionId"] = session;
        byte[] bytes = Encoding.UTF8.GetBytes(Json(message) + "\0");
        lock (output) {
            output.Write(bytes, 0, bytes.Length);
            output.Flush();
        }
        var deadline = DateTime.UtcNow.AddSeconds(15);
        lock (cdpReplies) {
            while (!cdpReplies.ContainsKey(id)) {
                var left = deadline - DateTime.UtcNow;
                if (left <= TimeSpan.Zero) throw new Exception("No answer from Chrome to " + method);
                Monitor.Wait(cdpReplies, left);
            }
            var reply = cdpReplies[id];
            cdpReplies.Remove(id);
            if (reply.ContainsKey("error")) throw new Exception(method + ": " + Json(reply["error"]));
            return reply.ContainsKey("result") ? reply["result"] as Dictionary<string, object> ?? new Dictionary<string, object>() : new Dictionary<string, object>();
        }
    }

    // The extension version and a hash of its files, as loaded at the last start, are kept in
    // <profile>\windows-chrome-bridge-extension.txt. A reload is needed when this profile loaded
    // another version or other files before. A new profile has no record and needs none.
    static bool NeedsReload(string folder) {
        string version = Config.Version;
        var all = new StringBuilder();
        var files = Directory.GetFiles(folder, "*", SearchOption.AllDirectories);
        Array.Sort(files, StringComparer.Ordinal);
        string hash;
        using (var sha = System.Security.Cryptography.SHA256.Create()) {
            foreach (string f in files)
                all.Append(f.Substring(folder.Length)).Append('\n')
                    .Append(Convert.ToBase64String(sha.ComputeHash(File.ReadAllBytes(f)))).Append('\n');
            hash = Convert.ToBase64String(sha.ComputeHash(Encoding.UTF8.GetBytes(all.ToString())));
        }
        string record = Path.Combine(Profile, "windows-chrome-bridge-extension.txt");
        string now = version + " " + hash;
        string before = File.Exists(record) ? File.ReadAllText(record).Trim() : null;
        File.WriteAllText(record, now);
        return before != null && before != now;
    }

    // One CDP call over the pipe: JSON messages end with a NUL byte. Events are skipped.
    static Dictionary<string, object> PipeCall(Stream output, Stream input, int id, string method,
        Dictionary<string, object> parameters) {
        var serializer = new JavaScriptSerializer { MaxJsonLength = 16 * 1024 * 1024 };
        byte[] request = Encoding.UTF8.GetBytes(serializer.Serialize(new Dictionary<string, object> {
            { "id", id }, { "method", method }, { "params", parameters } }) + "\0");
        output.Write(request, 0, request.Length);
        output.Flush();
        var deadline = DateTime.UtcNow.AddSeconds(30);
        var buffer = new MemoryStream();
        while (DateTime.UtcNow < deadline) {
            int b = input.ReadByte();
            if (b < 0) throw new Exception("Chrome closed the CDP pipe");
            if (b != 0) {
                buffer.WriteByte((byte)b);
                continue;
            }
            var message = serializer.Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(buffer.ToArray()));
            buffer.SetLength(0);
            object got;
            if (message.TryGetValue("id", out got) && Convert.ToInt32(got) == id) return message;
        }
        throw new Exception("No CDP reply to " + method + " within 30s");
    }

    // CreateProcess that lets the child inherit only the given handles. stdout may be IntPtr.Zero.
    static void StartWithHandles(string app, string command, IntPtr[] handles, IntPtr stdout, uint flags,
        string directory, out PROCESS_INFORMATION pi) {
        IntPtr size = IntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
        IntPtr list = Marshal.AllocHGlobal(size);
        IntPtr values = Marshal.AllocHGlobal(IntPtr.Size * handles.Length);
        bool initialized = false;
        try {
            if (!InitializeProcThreadAttributeList(list, 1, 0, ref size))
                throw new Exception("InitializeProcThreadAttributeList failed: " + Marshal.GetLastWin32Error());
            initialized = true;
            for (int i = 0; i < handles.Length; i++) Marshal.WriteIntPtr(values, i * IntPtr.Size, handles[i]);
            // PROC_THREAD_ATTRIBUTE_HANDLE_LIST
            if (!UpdateProcThreadAttribute(list, 0, (IntPtr)0x00020002, values,
                (IntPtr)(IntPtr.Size * handles.Length), IntPtr.Zero, IntPtr.Zero))
                throw new Exception("UpdateProcThreadAttribute failed: " + Marshal.GetLastWin32Error());
            var si = new STARTUPINFOEX();
            si.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
            si.lpAttributeList = list;
            if (stdout != IntPtr.Zero) {
                si.StartupInfo.dwFlags = 0x00000100; // STARTF_USESTDHANDLES
                si.StartupInfo.hStdOutput = stdout;
            }
            // EXTENDED_STARTUPINFO_PRESENT
            if (!CreateProcessEx(app, new StringBuilder(command), IntPtr.Zero, IntPtr.Zero, true, 0x00080000 | flags,
                IntPtr.Zero, directory, ref si, out pi))
                throw new Exception("CreateProcess failed for " + app + ": " + Marshal.GetLastWin32Error());
        } finally {
            if (initialized) DeleteProcThreadAttributeList(list);
            Marshal.FreeHGlobal(list);
            Marshal.FreeHGlobal(values);
        }
    }

    // Stops the QA Chrome of the lease, only when the caller started it and safe is true (no QA window is
    // left). The root process must still be the one in the lease (same pid and start time).
    public static object Stop(Lease lease, bool safe) {
        if (lease == null || !lease.launched) return new { stopped = false, reason = "not started by this process" };
        if (!safe) return new { stopped = false, reason = "QA windows are still open" };
        var current = Snapshot();
        var root = current.Find(e => e.root && e.pid == lease.root.pid && e.started == lease.root.started);
        if (root == null)
            return new { stopped = false, reason = "already gone", remaining = current.Count };
        // --keep-alive-for-test keeps an empty browser alive, so it does not exit by itself.
        Process.GetProcessById(root.pid).Kill();
        var deadline = DateTime.UtcNow.AddSeconds(10);
        while (DateTime.UtcNow < deadline) {
            bool alive = false;
            foreach (var e in current) {
                try {
                    var p = Process.GetProcessById(e.pid);
                    if (!p.HasExited) alive = true;
                } catch { }
            }
            if (!alive) break;
            Thread.Sleep(200);
        }
        var remaining = Snapshot();
        var survivors = new List<int>();
        foreach (var e in current) {
            try {
                if (!Process.GetProcessById(e.pid).HasExited) survivors.Add(e.pid);
            } catch { }
        }
        return new {
            stopped = remaining.Count == 0 && survivors.Count == 0,
            reason = "terminated",
            remaining = remaining.Count,
            trackedSurvivors = survivors
        };
    }

    public static string Json(object o) {
        return new JavaScriptSerializer().Serialize(o);
    }
}
