#!/usr/bin/env python3
"""Install and manage Windows Chrome Bridge from WSL.

  python3 manage.py install [--claude [PATH]] [--codex [PATH]]
  python3 manage.py doctor
  python3 manage.py stop
  python3 manage.py rollback
  python3 manage.py uninstall [--keep-profile]

install builds the bridge (from a clone) or uses the prebuilt files (from a release zip), copies them
to %LOCALAPPDATA%\\windows-chrome-bridge, registers the Chrome native host and runs a self-check.
It adds the MCP server to Claude Code or Codex only when you say yes (a flag or the prompt).
Run install again from a newer version to upgrade. The version before stays for rollback.
It needs Python 3.12 or newer.
"""

import sys

# Keep this check first, and keep this file readable by old Pythons up to here, so an old Python
# gets this message and not a strange error.
if sys.version_info < (3, 12):
    sys.exit("ERROR: Windows Chrome Bridge needs Python 3.12 or newer. This is Python %d.%d. "
             "Ubuntu 24.04 has Python 3.12; run manage.py with a newer python3." % sys.version_info[:2])

import argparse
import json
import os
import queue
import re
import shlex
import shutil
import subprocess
import tempfile
import threading
import time
import tomllib
from pathlib import Path

SERVER = "isolated_windows_qa"
HOST = "io.github.darkov19.windows_chrome_bridge"
REG = "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\" + HOST


def mount_root(c_drive):
    """The WSL folder that holds the Windows drives, from the WSL path of C:\\ (wslpath -u).

    It is /mnt/ unless /etc/wsl.conf sets another automount root, for example / or /win/.
    """
    folder = c_drive.rstrip("/")
    return folder[: -len("c")] if folder.lower().endswith("/c") else "/mnt/"


def _c_drive():
    try:
        return subprocess.run(["wslpath", "-u", "C:\\"], capture_output=True, text=True).stdout.strip()
    except OSError:  # Not WSL, for example the unit tests on Windows.
        return ""


MOUNT = mount_root(_c_drive())
C = MOUNT + "c/"
CMD = C + "Windows/System32/cmd.exe"
REG_EXE = C + "Windows/System32/reg.exe"
HERE = Path(__file__).resolve().parent
DEFAULT_CONFIG = {"windowMode": "display", "screen": "secondary", "windowState": "maximized"}
BEGIN = "# BEGIN windows-chrome-bridge\n"
NOTE = "# Written by manage.py. On upgrade it keeps only default_tools_approval_mode.\n"
END = "# END windows-chrome-bridge\n"
BACKUP = ".windows-chrome-bridge-backup"


class Problem(Exception):
    """An error with a message for the user."""


def need(condition, message):
    if not condition:
        raise Problem(message)


# ---------------------------------------------------------------------------
# Windows from WSL


def in_wsl():
    return Path(CMD).exists() and shutil.which("wslpath") is not None


def windows_folder(variable):
    """A Windows folder from an environment variable, as a WSL path."""
    # cmd /u writes UTF-16, so a user name such as Jürgen or 张伟 comes through. Without /u, cmd writes
    # the old console code page, which cannot hold every letter.
    out = subprocess.check_output([CMD, "/u", "/c", "echo %" + variable + "%"], cwd=C).decode("utf-16-le").strip()
    need(out and "%" not in out, "Windows variable " + variable + " is not set")
    return Path(subprocess.check_output(["wslpath", "-u", out], text=True, encoding="utf-8").strip())


def win(path):
    return subprocess.check_output(["wslpath", "-w", str(path)], text=True, encoding="utf-8").strip()


def root():
    """The install root. An installed copy of manage.py sits in it, next to versions/."""
    if (HERE / "versions").is_dir():
        return HERE
    return windows_folder("LOCALAPPDATA") / "windows-chrome-bridge"


def reg_value(key=REG):
    """The default value of a registry key, or None.

    reg query writes the old console code page, which cannot hold every letter of a path such as
    C:\\Users\\Jürgen. reg export writes a UTF-16 file, so the value comes through exactly.
    """
    fd, tmp = tempfile.mkstemp(dir=windows_folder("TEMP"), prefix="windows-chrome-bridge-", suffix=".reg")
    os.close(fd)
    try:
        r = subprocess.run([REG_EXE, "export", key, win(tmp), "/y"], capture_output=True)
        if r.returncode:
            return None
        return reg_default(Path(tmp).read_bytes().decode("utf-16"))
    finally:
        os.unlink(tmp)


def reg_default(text):
    """The default value (@="...") of the first key in a .reg file, or None."""
    lines = text.splitlines()
    header = next((i for i, line in enumerate(lines) if line.startswith("[")), len(lines))
    for line in lines[header + 1 :]:
        if line.startswith("["):
            break
        if line.startswith('@="') and line.endswith('"'):
            return re.sub(r'\\(.)', r"\1", line[3:-1])
    return None


def load(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def save(path, data):
    write(Path(path), json.dumps(data, indent=2) + "\n")


def write(path, text, mode=None):
    """Write a file atomically: a reader sees the old or the new content, never half."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix="." + path.name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
        if mode is not None:
            os.chmod(tmp, mode)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def chrome_path(settings):
    """chrome.exe as a WSL path, or None. Same search as host/Config.cs."""
    if settings.get("chrome"):
        p = Path(subprocess.check_output(["wslpath", "-u", settings["chrome"]], text=True).strip())
        return p if p.exists() else None
    for folder in [C + "Program Files", C + "Program Files (x86)", str(windows_folder("LOCALAPPDATA"))]:
        p = Path(folder) / "Google/Chrome/Application/chrome.exe"
        if p.exists():
            return p
    return None


def settings_of(base):
    path = base / "bridge-config.json"
    if not path.exists():
        return {}
    data = load(path)
    need(isinstance(data, dict), str(path) + " must be a JSON object")
    return data


# ---------------------------------------------------------------------------
# A small MCP client for qa-bridge.exe --mcp. The self-check and the live tests use it.


def mcp_args():
    """The arguments of qa-bridge.exe --mcp. A Windows program cannot see the WSL side, so they say
    which distro the agent runs in (for /home/... paths) and where WSL mounts the Windows drives."""
    distro = os.environ.get("WSL_DISTRO_NAME")
    return ["--mcp"] + (["--wsl-distro", distro] if distro else []) + ["--wsl-root", MOUNT]


class Client:
    def __init__(self, exe, args=None):
        self.p = subprocess.Popen(
            [str(exe)] + (mcp_args() if args is None else args),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            cwd=str(Path(exe).parent),
            text=True,
            encoding="utf-8",
        )
        self.lines = queue.Queue()
        self.seq = 0
        self.thread = threading.Thread(target=self._read, daemon=True)
        self.thread.start()

    def _read(self):
        for line in self.p.stdout:
            self.lines.put(json.loads(line))
        self.lines.put(None)

    def request(self, method, params=None, timeout=90):
        self.seq += 1
        self.p.stdin.write(json.dumps({"jsonrpc": "2.0", "id": self.seq, "method": method, "params": params or {}}) + "\n")
        self.p.stdin.flush()
        try:
            reply = self.lines.get(timeout=timeout)
        except queue.Empty:
            raise RuntimeError("No MCP reply to " + method + " within " + str(timeout) + " s")
        if reply is None:
            raise RuntimeError("qa-bridge.exe --mcp ended")
        need(reply.get("id") == self.seq, "MCP reply id mismatch")
        if "error" in reply:
            raise RuntimeError(reply["error"]["message"])
        return reply["result"]

    def initialize(self):
        info = self.request(
            "initialize",
            {"protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": {"name": "manage.py", "version": "1"}},
        )
        self.p.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n')
        self.p.stdin.flush()
        return info

    def call(self, _tool, **args):
        """Call a tool. Returns the raw MCP result; raises RuntimeError with the text on isError."""
        result = self.request("tools/call", {"name": _tool, "arguments": args})
        if result.get("isError"):
            raise RuntimeError(text_of(result))
        return result

    def result(self, _tool, **args):
        """Call a tool and return the parsed JSON of its first text item."""
        return json.loads(self.call(_tool, **args)["content"][0]["text"])

    def text(self, _tool, **args):
        """Call a tool and return its last text item: the page read or list, when it has one."""
        return self.call(_tool, **args)["content"][-1]["text"]

    def close(self):
        if self.p.poll() is None:
            self.p.stdin.close()
            try:
                self.p.wait(timeout=20)
            except subprocess.TimeoutExpired:
                self.p.kill()
                self.p.wait(timeout=10)
        self.thread.join(timeout=2)
        self.p.stdout.close()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


def text_of(result):
    return "\n".join(c.get("text", "") for c in result.get("content", []) if c.get("type") == "text")


def lifecycle(exe, action, *args):
    """qa-bridge.exe --lifecycle-<action>: snapshot, start, or stop <lease>."""
    r = subprocess.run([str(exe), "--lifecycle-" + action, *args], capture_output=True, encoding="utf-8",
                       errors="replace", timeout=60)
    need(r.returncode == 0, (r.stderr or "qa-bridge.exe --lifecycle-" + action + " failed").strip())
    return json.loads(r.stdout)


def self_check(exe):
    """Start the MCP server, let it start QA Chrome, and ask qa_session. Returns its result."""
    started = time.monotonic()
    with Client(exe) as c:
        c.initialize()
        health = c.result("qa_session")
    health["seconds"] = round(time.monotonic() - started, 1)
    return health


# ---------------------------------------------------------------------------
# Agent configs. Pure text functions, so they can be unit tested.


def claude_text(text, command, args=("--mcp",)):
    """Claude Code config text with mcpServers.isolated_windows_qa running command, or without it (None).

    Nothing else changes: the file must be in the format json.dumps(indent=2) writes, which is the
    format Claude Code uses, so a round trip keeps every other byte.
    """
    data = json.loads(text)
    need(isinstance(data, dict), "The Claude Code config is not a JSON object")

    def dump(d):
        out = json.dumps(d, indent=2, ensure_ascii=False)
        return out + "\n" if text.endswith("\n") else out

    need(dump(data) == text, "The Claude Code config is not in the usual format, so manage.py does not edit it")
    servers = data.get("mcpServers")
    if command is None:
        if isinstance(servers, dict) and SERVER in servers:
            del servers[SERVER]
            return dump(data)
        return text
    if servers is None:
        servers = data["mcpServers"] = {}
    need(isinstance(servers, dict), "mcpServers in the Claude Code config is not an object")
    servers[SERVER] = {"type": "stdio", "command": command, "args": list(args), "env": {}}
    return dump(data)


def codex_text(text, command, args=("--mcp",)):
    """Codex config.toml text with a managed [mcp_servers.isolated_windows_qa] block, or without it (None)."""
    # Find the block by its first words, so a later change to the marker line still finds it.
    begins = [x.start() for x in re.finditer(r"^# BEGIN windows-chrome-bridge\b.*\n", text, re.M)]
    need(len(begins) == text.count(END) <= 1, "The Codex config has a broken windows-chrome-bridge block")
    approval = "prompt"  # Codex asks before each bridge tool call.
    if begins:
        a = begins[0]
        b = text.index(END, a) + len(END)
        before, after = text[:a], text[b:]
        # Keep an approval mode the user chose.
        chosen = re.search(r'^default_tools_approval_mode = "([a-z_-]+)"$', text[a:b], re.M)
        approval = chosen.group(1) if chosen else approval
    else:
        before, after = text, ""
        need(
            not re.search(r'^\s*\[\s*mcp_servers\s*\.\s*"?' + SERVER + r'"?\s*[\].]', text, re.M),
            "The Codex config already has an mcp_servers." + SERVER + " entry that manage.py did not write. "
            "Remove it, then run install again",
        )
    if command is None:
        return before.rstrip("\n") + ("\n" if before.strip() else "") + after
    block = (
        BEGIN + NOTE + "[mcp_servers." + SERVER + "]\ncommand = " + json.dumps(command) + "\nargs = " + json.dumps(list(args)) + "\n"
        + 'default_tools_approval_mode = "' + approval + '"\n' + END
    )
    if before and not before.endswith("\n\n"):
        before = before.rstrip("\n") + "\n\n"
    new = before + block + after
    tomllib.loads(new)
    return new


AGENTS = {
    "claude": {"name": "Claude Code", "edit": claude_text, "mode": 0o600},
    "codex": {"name": "Codex", "edit": codex_text, "mode": None},
}


def default_agent_file(agent):
    if agent == "claude":
        return Path.home() / ".claude.json"
    return Path(os.environ.get("CODEX_HOME") or Path.home() / ".codex") / "config.toml"


def agent_found(agent, path):
    # Claude Code creates ~/.claude.json at its first start. Codex may have a folder without config.toml.
    return path.exists() if agent == "claude" else path.parent.is_dir()


def update_agent(agent, path, command):
    """Point the agent's config at command, or remove the entry (None). Keeps one backup next to the file."""
    path = Path(path)
    if agent == "claude":
        need(path.exists(), str(path) + " not found")
    # The agent may write its config while it runs (Claude Code does, often). Write only if the file
    # did not change since it was read, so neither side loses an update.
    for _ in range(5):
        old = path.read_text(encoding="utf-8") if path.exists() else ""
        new = AGENTS[agent]["edit"](old, command, mcp_args())
        if new == old:
            return False
        mode = path.stat().st_mode & 0o777 if path.exists() else None
        if mode is not None:
            # The config can hold secrets, so the backup is readable only by you.
            write(path.with_name(path.name + BACKUP), old, mode=0o600)
        if (path.read_text(encoding="utf-8") if path.exists() else "") == old:
            write(path, new, mode=mode)
            return True
        time.sleep(0.5)
    raise Problem(str(path) + " kept changing. Try again when the agent is idle")


def manual_hint(agent, command):
    line = " -- " + shlex.join([command] + mcp_args())
    if agent == "claude":
        return "claude mcp add --scope user " + SERVER + line
    return "codex mcp add " + SERVER + line


# ---------------------------------------------------------------------------
# State: which version is current, which came before, which agent files were edited.


def read_state(base):
    path = base / "state.json"
    state = load(path) if path.exists() else {}
    return {
        "current": state.get("current"),
        "previous": state.get("previous"),
        "agents": state.get("agents") or {},
    }


def state_after_install(state, version):
    new = dict(state)
    if state["current"] and state["current"] != version:
        new["previous"] = state["current"]
    new["current"] = version
    return new


def state_after_rollback(state):
    need(state["previous"], "There is no earlier version to go back to")
    return dict(state, current=state["previous"], previous=state["current"])


# ---------------------------------------------------------------------------
# Steps shared by the commands


def exe_of(base, version):
    return base / "versions" / version / "qa-bridge.exe"


def stop_idle(exe, even_with_windows=False):
    """Stop QA Chrome if no agent session is connected. Returns the result, or raises Problem if it stays."""
    r = lifecycle(exe, "stop-idle", *(["--even-with-windows"] if even_with_windows else []))
    if r["running"] and r["sessions"]:
        count = "Agent sessions" if r["sessions"] < 0 else str(r["sessions"]) + " agent session(s)"
        raise Problem("QA Chrome is running and " + count + " use it. Close those agent sessions, then run this again")
    need(not r["running"] or not r["windows"],
         "QA Chrome has open windows (for example tabs an agent kept). Close them, or run: python3 manage.py stop")
    need(not r["running"], "QA Chrome did not stop. Close it in the Windows Task Manager, then run this again")
    if r["stopped"]:
        print("Stopped QA Chrome: no agent session was using it.")
    return r


def need_chrome_closed(base, state):
    """install, rollback and uninstall need QA Chrome closed. An idle QA Chrome is stopped here."""
    exe = exe_of(base, state["current"]) if state["current"] else None
    if not exe or not exe.exists():
        return
    stop_idle(exe)


def register(base, version):
    """Write native-host.json for this version and point the registry at it."""
    manifest = base / "native-host.json"
    old = reg_value()
    if old and old != win(manifest):
        other = Path(subprocess.check_output(["wslpath", "-u", old], text=True).strip())
        need(
            not other.exists(),
            "The native host " + HOST + " is registered for another install (" + old + "). "
            "Run uninstall from that install first",
        )
    folder = base / "versions" / version
    save(
        manifest,
        {
            "name": HOST,
            "description": "Windows Chrome Bridge native host",
            "path": win(folder / "qa-bridge.exe"),
            "type": "stdio",
            "allowed_origins": ["chrome-extension://" + extension_id_of(folder) + "/"],
        },
    )
    subprocess.run([REG_EXE, "add", REG, "/ve", "/t", "REG_SZ", "/d", win(manifest), "/f"], check=True, capture_output=True)


def extension_id_of(folder):
    """Chrome's id for the extension: from the public key in manifest.json (same as host/Config.cs)."""
    import base64
    import hashlib

    key = load(folder / "extension" / "manifest.json")["key"]
    digest = hashlib.sha256(base64.b64decode(key)).hexdigest()[:32]
    return "".join(chr(ord("a") + int(c, 16)) for c in digest)


def report_health(health):
    print(
        "Self-check passed in " + str(health["seconds"]) + " s: QA Chrome started, the extension "
        + health["version"] + " answered, window mode is " + health["display"]["mode"] + "."
    )


def choose_agents(args, state):
    """Which agent files to edit: recorded ones, flags, or a yes at the prompt."""
    chosen = dict(state["agents"])
    for agent, info in AGENTS.items():
        flag = getattr(args, agent)
        if flag:
            chosen[agent] = str(Path(flag).expanduser()) if flag != "found" else str(default_agent_file(agent))
            continue
        if agent in chosen:
            continue
        path = default_agent_file(agent)
        if not agent_found(agent, path):
            continue
        if sys.stdin.isatty():
            answer = input("Add the bridge to " + info["name"] + " (" + str(path) + ")? [y/N] ").strip().lower()
            if answer in ("y", "yes"):
                chosen[agent] = str(path)
        else:
            print(info["name"] + " found at " + str(path) + ". Not changed. Add --" + agent + " to add the bridge there.")
    return chosen


def point_agents(state, command):
    """Point every recorded agent at command. An agent that fails stays recorded, so doctor and
    uninstall still look at it."""
    for agent, path in state["agents"].items():
        name = AGENTS[agent]["name"]
        try:
            changed = update_agent(agent, path, command)
            print(name + ": " + SERVER + (" set to this version" if changed else " already set") + " in " + path)
        except (Problem, OSError, ValueError) as e:
            print(name + ": not changed (" + str(e) + "). To add it by hand, run:\n  " + manual_hint(agent, command))


# ---------------------------------------------------------------------------
# Commands


def source_folder():
    """The release folder to install: built from the clone, or the folder of a release zip."""
    if (HERE / "host").is_dir():
        need(subprocess.run([sys.executable, str(HERE / "build.py")]).returncode == 0, "The build failed")
        return HERE / "build" / load(HERE / "extension" / "manifest.json")["version"]
    need((HERE / "qa-bridge.exe").exists(), "Run install from the repository or from the unzipped release folder")
    return HERE


def install(args):
    base = root()
    state = read_state(base)
    if base == HERE:
        raise Problem("This is the installed copy of manage.py. Run install from the repository or the release folder")
    need_chrome_closed(base, state)
    folder = source_folder()
    version = load(folder / "extension" / "manifest.json")["version"]

    versions = base / "versions"
    target = versions / version
    staging, retired = versions / ("." + version + ".new"), versions / ("." + version + ".old")
    for leftover in (staging, retired):
        shutil.rmtree(leftover, ignore_errors=True)
    # The release files only: qa-bridge.exe, catalog.json, extension/.
    staging.mkdir(parents=True)
    shutil.copy2(folder / "qa-bridge.exe", staging / "qa-bridge.exe")
    shutil.copy2(folder / "catalog.json", staging / "catalog.json")
    shutil.copytree(folder / "extension", staging / "extension")
    if target.exists():
        try:
            # A rename either works or fails as a whole, so a version folder is never half replaced.
            target.rename(retired)
        except OSError:
            shutil.rmtree(staging, ignore_errors=True)
            raise Problem(str(target) + " is in use. Close the agent sessions that use the bridge, then run install again")
    staging.rename(target)
    shutil.rmtree(retired, ignore_errors=True)
    shutil.copy2(HERE / "manage.py", base / "manage.py")
    if not (base / "bridge-config.json").exists():
        save(base / "bridge-config.json", DEFAULT_CONFIG)
    register(base, version)
    new_state = state_after_install(state, version)
    # Keep only the current and the previous version.
    for old in versions.iterdir():
        if old.is_dir() and old.name not in (new_state["current"], new_state["previous"]):
            shutil.rmtree(old, ignore_errors=True)
    save(base / "state.json", new_state)
    print("Installed " + version + " in " + win(base))
    if not chrome_path(settings_of(base)):
        print("Google Chrome was not found. Install it, or set \"chrome\" in " + win(base / "bridge-config.json"))

    exe = exe_of(base, version)
    try:
        report_health(self_check(exe))
    except Exception as e:
        raise Problem("Self-check failed: " + str(e) + "\nRun: python3 manage.py doctor")

    new_state["agents"] = choose_agents(args, new_state)
    for agent, path in state["agents"].items():
        if new_state["agents"].get(agent) != path:
            # The agent now uses another config file. Take the entry out of the old one.
            try:
                update_agent(agent, path, None)
            except (Problem, OSError, ValueError) as e:
                print(AGENTS[agent]["name"] + ": could not edit " + path + " (" + str(e) + "). Remove " + SERVER + " there by hand")
    point_agents(new_state, str(exe))
    save(base / "state.json", new_state)
    if not new_state["agents"]:
        print("No agent was changed. For any MCP client, the command is: " + shlex.join([str(exe)] + mcp_args()))
    print("Done. Restart your agent sessions so they load the tools.")


def rollback(args):
    base = root()
    state = read_state(base)
    need(state["current"], "Windows Chrome Bridge is not installed")
    new_state = state_after_rollback(state)
    exe = exe_of(base, new_state["current"])
    need(exe.exists(), "Version " + new_state["current"] + " is no longer in " + win(base / "versions"))
    need_chrome_closed(base, state)
    register(base, new_state["current"])
    save(base / "state.json", new_state)
    point_agents(new_state, str(exe))
    report_health(self_check(exe))
    print("Rolled back to " + new_state["current"] + ". Restart your agent sessions.")


def profile_plan(base, profile, keep):
    """What uninstall does with the QA Chrome profile (WSL paths): (lower-case top-level names in base to keep,
    "outside" | "kept" | "removed"). The profile setting can point anywhere, and the folder holds
    logins, so uninstall never deletes a profile outside the install folder."""
    # Windows paths ignore letter case: C:\Users\Me\...\Profile and c:\users\me\...\profile are one folder.
    base, profile = Path(str(base).casefold()), Path(str(profile).casefold())
    need(profile != base and profile not in base.parents,
         "The profile setting in bridge-config.json is the install folder or a folder above it. "
         "Change it, then run uninstall again")
    if base not in profile.parents:
        return set(), "outside"
    if keep:
        return {profile.relative_to(base).parts[0]}, "kept"
    return set(), "removed"


def uninstall(args):
    base = root()
    state = read_state(base)
    need_chrome_closed(base, state)
    settings = settings_of(base) if base.exists() else {}
    profile = (Path(subprocess.check_output(["wslpath", "-u", settings["profile"]], text=True).strip())
               if settings.get("profile") else base / "profile")
    keep, what = profile_plan(base, profile, args.keep_profile)
    existed = base.exists()
    for agent, path in state["agents"].items():
        try:
            update_agent(agent, path, None)
            print(AGENTS[agent]["name"] + ": removed " + SERVER + " from " + path)
        except (Problem, OSError, ValueError) as e:
            print(AGENTS[agent]["name"] + ": could not edit " + path + " (" + str(e) + "). Remove " + SERVER + " by hand")
        Path(path + BACKUP).unlink(missing_ok=True)
    value = reg_value()
    if value and base.exists() and value == win(base / "native-host.json"):
        subprocess.run([REG_EXE, "delete", REG, "/f"], check=True, capture_output=True)
        print("Removed the native host registration " + HOST)
    elif value:
        print("The native host registration points to another install (" + value + "). Left it")
    if base.exists():
        for item in base.iterdir():
            if item.name.casefold() in keep:
                continue
            shutil.rmtree(item) if item.is_dir() else item.unlink()
        if not keep:
            base.rmdir()
        print("Removed " + win(base) + ": the bridge, its settings and output files" + (", except the profile." if keep else "."))
    if what == "outside" and profile.exists():
        print("Kept the QA Chrome profile " + win(profile) + ": the profile setting puts it outside the install folder, "
              "so uninstall does not delete it. It holds the logins and cookies of QA Chrome; delete it yourself "
              "if you do not need them.")
    elif what == "kept" and profile.exists():
        print("Kept the QA Chrome profile " + win(profile) + " (--keep-profile). It holds the logins and cookies of QA Chrome.")
    elif what == "removed" and existed:
        print("Removed the QA Chrome profile (its logins and cookies) with it.")
    print("Windows Chrome Bridge is uninstalled. Files that QA Chrome downloaded stay in your Downloads folder "
          "(qa_downloads start used Downloads\\ChromeBridge).")


def stop(args):
    base = root()
    state = read_state(base)
    need(state["current"], "Windows Chrome Bridge is not installed")
    if not stop_idle(exe_of(base, state["current"]), even_with_windows=True)["stopped"]:
        print("QA Chrome is not running.")


def doctor(args):
    problems = 0

    def report(ok, text, fix=None):
        nonlocal problems
        print(("ok       " if ok else "PROBLEM  ") + text)
        if not ok:
            problems += 1
            if fix:
                print("         Fix: " + fix)
        return ok

    if not report(in_wsl(), "Running in WSL with Windows interop", "Run manage.py from WSL 2 on Windows"):
        return 1
    base = root()
    state = read_state(base)
    settings = {}
    try:
        settings = settings_of(base)
        report(True, "bridge-config.json: " + json.dumps(settings or "defaults"))
    except Exception as e:
        report(False, "bridge-config.json cannot be read: " + str(e), "Fix the JSON in " + win(base / "bridge-config.json"))
    chrome = chrome_path(settings)
    report(bool(chrome), "Google Chrome " + ("at " + win(chrome) if chrome else "not found"),
           "Install Google Chrome, or set \"chrome\" in bridge-config.json")
    if not report(bool(state["current"]), "Installed version: " + str(state["current"]) + " in " + win(base),
                  "Run: python3 manage.py install"):
        return 1
    exe = exe_of(base, state["current"])
    if not report(exe.exists(), "qa-bridge.exe at " + win(exe), "Run: python3 manage.py install"):
        return 1
    manifest = base / "native-host.json"
    value = reg_value()
    report(value == win(manifest), "Native host registered: " + str(value), "Run: python3 manage.py install")
    if manifest.exists():
        host = load(manifest)
        report(host.get("path") == win(exe), "native-host.json points to " + str(host.get("path")),
               "Run: python3 manage.py install")
    for agent, path in state["agents"].items():
        name = AGENTS[agent]["name"]
        try:
            text = Path(path).read_text(encoding="utf-8")
            ok = AGENTS[agent]["edit"](text, str(exe), mcp_args()) == text
        except Exception:
            ok = False
        report(ok, name + " uses this install (" + path + ")", "Run: python3 manage.py install --" + agent + " " + path)
    for agent, info in AGENTS.items():
        path = default_agent_file(agent)
        if agent not in state["agents"] and agent_found(agent, path):
            print("note     " + info["name"] + " found at " + str(path) + " but not set up. "
                  "To add it: python3 manage.py install --" + agent)
    machine = Path(C + "ProgramData/windows-chrome-bridge/policy.json")
    policy_file = machine if machine.exists() else base / "policy.json"
    if not policy_file.exists():
        print("note     No policy.json: every tool works on every site")
    running = lifecycle(exe, "snapshot")
    print("note     QA Chrome is " + ("running (" + str(len(running)) + " processes)" if running else "not running"))
    try:
        health = self_check(exe)
        report(True, "Self-check: qa_session answered in " + str(health["seconds"]) + " s, extension "
               + health["version"] + ", window mode " + health["display"]["mode"])
        p = health["policy"]
        if p["active"]:
            print("note     Policy active: " + win(policy_file) + ". allow: " + (", ".join(p["allow"]) or "-")
                  + "; block: " + (", ".join(p["block"]) or "-") + "; strict: " + ("on" if p["strict"] else "off"))
    except Exception as e:
        report(False, "Self-check failed: " + str(e),
               "Read the message above. Close QA Chrome and try again; if it stays, run install again")
    print("No problems found." if not problems else str(problems) + " problem(s) found.")
    return 1 if problems else 0


def main():
    p = argparse.ArgumentParser(description="Install and manage Windows Chrome Bridge from WSL.")
    sub = p.add_subparsers(dest="command", required=True)
    i = sub.add_parser("install", help="install or upgrade, then run a self-check")
    for agent, info in AGENTS.items():
        i.add_argument(
            "--" + agent, nargs="?", const="found", metavar="PATH",
            help="add the MCP server to " + info["name"] + " (default " + str(default_agent_file(agent)).replace(str(Path.home()), "~") + ")",
        )
    sub.add_parser("doctor", help="check the install and explain what is wrong")
    sub.add_parser("stop", help="stop QA Chrome, if no agent session uses it")
    sub.add_parser("rollback", help="go back to the version installed before")
    u = sub.add_parser("uninstall", help="remove everything install added")
    u.add_argument("--keep-profile", action="store_true", help="keep the QA Chrome profile (its logins)")
    args = p.parse_args()
    if not in_wsl():
        sys.exit("ERROR: run manage.py from WSL 2 on Windows.")
    try:
        code = {"install": install, "doctor": doctor, "stop": stop, "rollback": rollback, "uninstall": uninstall}[args.command](args)
        sys.exit(code or 0)
    except Problem as e:
        sys.exit("ERROR: " + str(e))


if __name__ == "__main__":
    main()
