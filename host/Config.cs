using System;
using System.Collections.Generic;
using System.IO;
using System.Web.Script.Serialization;
using Microsoft.Win32;

// Machine settings. Every setting is optional.
// They are read from bridge-config.json in the install root.
// A release lives in <root>\versions\<version>\qa-bridge.exe.
// Any other folder (for example a build folder) is its own root.
static class Config {
    public static readonly string Dir =
        Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location);

    static Dictionary<string, object> values, manifest;
    static string root, profile, chrome, extensionId, instance;

    // The instance: "" for a normal install, or a short name such as "test" for a second install
    // that shares nothing with the first (see CONTRIBUTING.md). manage.py writes it in
    // extension\instance.json of each release, so the exe and the extension read the same value.
    public static string Instance {
        get {
            if (instance == null) {
                string path = Path.Combine(ExtensionFolder, "instance.json");
                if (!File.Exists(path)) throw new Exception("extension\\instance.json is missing next to qa-bridge.exe");
                Dictionary<string, object> data;
                try {
                    data = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(path));
                } catch (Exception e) {
                    throw new Exception("extension\\instance.json is not valid JSON: " + e.Message);
                }
                object v = null;
                if (data != null) data.TryGetValue("instance", out v);
                var name = v as string;
                if (name == null || !System.Text.RegularExpressions.Regex.IsMatch(name, "^([a-z][a-z0-9]{0,15})?$"))
                    throw new Exception("extension\\instance.json: instance must be \"\" or a-z and 0-9, up to 16 letters");
                instance = name;
            }
            return instance;
        }
    }

    // The start of every Windows name of this instance: pipes and the start mutex.
    // A normal install keeps the names of earlier versions.
    public static string NamePrefix {
        get { return Instance.Length == 0 ? "WindowsChromeBridge" : "WindowsChromeBridge-" + Instance; }
    }

    // The folder name of this instance: in %LOCALAPPDATA% (the install root) and in %ProgramData% (policy.json).
    public static string FolderName {
        get { return Instance.Length == 0 ? "windows-chrome-bridge" : "windows-chrome-bridge-" + Instance; }
    }

    public static string Root {
        get {
            if (root == null) {
                var parent = Directory.GetParent(Dir);
                if (parent != null && parent.Parent != null &&
                    String.Equals(parent.Name, "versions", StringComparison.OrdinalIgnoreCase)) {
                    // A release of one instance never runs in the folder of another: it would use that
                    // profile with its own pipe names.
                    if (!String.Equals(parent.Parent.Name, FolderName, StringComparison.OrdinalIgnoreCase))
                        throw new Exception("This release belongs in a folder named " + FolderName + ", not " +
                            parent.Parent.Name + ". Install it with manage.py");
                    root = parent.Parent.FullName;
                } else
                    root = Dir;
            }
            return root;
        }
    }

    // True for a release in <root>\versions\<version>. A build or release folder that was not installed
    // has the names of the normal install (pipes, native host), so it must not start or reach QA Chrome.
    public static bool Installed {
        get {
            var parent = Directory.GetParent(Dir);
            return parent != null && parent.Parent != null &&
                String.Equals(parent.Name, "versions", StringComparison.OrdinalIgnoreCase) && Root != Dir;
        }
    }

    public static string RootFile(string name) {
        return Path.Combine(Root, name);
    }

    static object Raw(string key) {
        if (values == null) {
            string path = RootFile("bridge-config.json");
            var loaded = new Dictionary<string, object>();
            if (File.Exists(path)) {
                try {
                    loaded = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(
                        File.ReadAllText(path));
                } catch (Exception e) {
                    throw new Exception("bridge-config.json is not valid JSON: " + e.Message);
                }
                if (loaded == null) throw new Exception("bridge-config.json must be a JSON object");
            }
            values = loaded;
        }
        object v;
        return values.TryGetValue(key, out v) ? v : null;
    }

    static string Setting(string key) {
        object v = Raw(key);
        if (v == null) return null;
        var s = v as string;
        if (s == null || s.Length == 0) throw new Exception("bridge-config.json: " + key + " must be a non-empty string");
        return s;
    }

    static string AbsoluteWindowsPath(string key, string value) {
        if (!Path.IsPathRooted(value) || value.StartsWith("/"))
            throw new Exception("bridge-config.json: " + key + " must be an absolute Windows path");
        return Path.GetFullPath(value).TrimEnd('\\');
    }

    // The dedicated QA Chrome profile. The native host accepts only a Chrome parent that uses
    // exactly this --user-data-dir. Default: <root>\profile.
    public static string Profile {
        get {
            if (profile == null) {
                string configured = Setting("profile");
                profile = configured != null
                    ? AbsoluteWindowsPath("profile", configured)
                    : Path.GetFullPath(Path.Combine(Root, "profile")).TrimEnd('\\');
            }
            return profile;
        }
    }

    // The unpacked extension that QA Chrome loads at start: the extension folder next to
    // qa-bridge.exe, so Chrome always runs the extension of this release.
    public static string ExtensionFolder {
        get { return Path.Combine(Dir, "extension"); }
    }

    // Where QA Chrome windows go. See README "Window modes".
    //   windowMode:  "display" (default): real windows on one screen, opened in the background.
    //                "headless": no windows at all.
    //   screen:      "primary", "secondary" (default; the primary screen when there is only one),
    //                or a 1-based number in Chrome's screen order.
    //   windowState: "maximized" (default), "fullscreen" or "normal" (1280x1000 on that screen).
    public static string WindowMode {
        get { return Choice("windowMode", "display", "display", "headless"); }
    }

    public static string Screen {
        get {
            string s = Setting("screen");
            return s ?? "secondary";
        }
    }

    public static string WindowState {
        get { return Choice("windowState", "maximized", "maximized", "fullscreen", "normal"); }
    }

    // Limits for several agents on one QA Chrome. maxSessions: MCP clients at once (default 8).
    // maxTabsPerSession: claimed tabs per session (default 32).
    public static int MaxSessions {
        get { return Number("maxSessions", 8, 1, 32); }
    }

    public static int MaxTabsPerSession {
        get { return Number("maxTabsPerSession", 32, 1, 200); }
    }

    // keepOutputDays: session output folders that did not change for this many days are removed
    // when QA Chrome starts (default 7).
    public static int KeepOutputDays {
        get { return Number("keepOutputDays", 7, 1, 3650); }
    }

    static int Number(string key, int fallback, int min, int max) {
        object v = Raw(key);
        if (v == null) return fallback;
        if (!(v is int) || (int)v < min || (int)v > max)
            throw new Exception("bridge-config.json: " + key + " must be a whole number from " + min + " to " + max);
        return (int)v;
    }

    // toolGroups: the tool groups the agent sees, besides "core". null: the default groups of catalog.json.
    public static List<string> ToolGroups {
        get {
            object v = Raw("toolGroups");
            if (v == null) return null;
            var list = v as System.Collections.IList;
            if (list == null) throw new Exception("bridge-config.json: toolGroups must be a list of group names");
            var names = new List<string>();
            foreach (object x in list) {
                if (!(x is string)) throw new Exception("bridge-config.json: toolGroups must be a list of group names");
                names.Add((string)x);
            }
            return names;
        }
    }

    static string Choice(string key, string fallback, params string[] allowed) {
        string value = Setting(key) ?? fallback;
        if (Array.IndexOf(allowed, value) < 0)
            throw new Exception("bridge-config.json: " + key + " must be one of " + String.Join(", ", allowed));
        return value;
    }

    // chrome.exe. Default: the first standard install location that exists.
    public static string Chrome {
        get {
            if (chrome == null) {
                string configured = Setting("chrome");
                if (configured != null) {
                    chrome = AbsoluteWindowsPath("chrome", configured);
                } else {
                    foreach (string variable in new[] { "ProgramW6432", "ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA" }) {
                        string folder = Environment.GetEnvironmentVariable(variable);
                        if (String.IsNullOrEmpty(folder)) continue;
                        string candidate = Path.Combine(folder, @"Google\Chrome\Application\chrome.exe");
                        if (File.Exists(candidate)) {
                            chrome = candidate;
                            break;
                        }
                    }
                    if (chrome == null) chrome = @"C:\Program Files\Google\Chrome\Application\chrome.exe";
                }
            }
            return chrome;
        }
    }

    // The WSL distro used for /home/... upload paths (\\wsl.localhost\<distro>\home\...) when the MCP
    // server was started without --wsl-distro (manage.py always passes it).
    // Order: wslDistro setting, WSL_DISTRO_NAME (only if shared through WSLENV), default WSL distro.
    public static string WslDistro() {
        string name = Setting("wslDistro");
        if (name == null) name = Environment.GetEnvironmentVariable("WSL_DISTRO_NAME");
        if (String.IsNullOrEmpty(name)) name = DefaultWslDistro();
        if (String.IsNullOrEmpty(name))
            throw new Exception("Cannot find the WSL distro for this path. Set wslDistro in bridge-config.json");
        return CheckDistro(name);
    }

    public static string CheckDistro(string name) {
        if (name.Trim('.').Length == 0 || name.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0)
            throw new Exception("Invalid WSL distro name");
        return name;
    }

    static string DefaultWslDistro() {
        using (var lxss = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Lxss")) {
            if (lxss == null) return null;
            var id = lxss.GetValue("DefaultDistribution") as string;
            if (id == null) return null;
            using (var distro = lxss.OpenSubKey(id)) {
                return distro == null ? null : distro.GetValue("DistributionName") as string;
            }
        }
    }

    // extension/manifest.json next to qa-bridge.exe is the one source of the version and of the
    // extension id. Chrome derives the id from the manifest "key" (the extension's public key).
    public static string Version {
        get { return ManifestString("version"); }
    }

    public static string ExtensionId {
        get {
            if (extensionId == null) {
                byte[] hash;
                using (var sha = System.Security.Cryptography.SHA256.Create())
                    hash = sha.ComputeHash(Convert.FromBase64String(ManifestString("key")));
                var id = new System.Text.StringBuilder();
                for (int i = 0; i < 16; i++) {
                    id.Append((char)('a' + (hash[i] >> 4)));
                    id.Append((char)('a' + (hash[i] & 15)));
                }
                extensionId = id.ToString();
            }
            return extensionId;
        }
    }

    static string ManifestString(string key) {
        if (manifest == null) {
            string path = Path.Combine(ExtensionFolder, "manifest.json");
            if (!File.Exists(path))
                throw new Exception("extension\\manifest.json is missing next to qa-bridge.exe");
            manifest = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(path));
        }
        object v;
        if (manifest == null || !manifest.TryGetValue(key, out v) || !(v is string))
            throw new Exception("extension\\manifest.json has no " + key);
        return (string)v;
    }
}
