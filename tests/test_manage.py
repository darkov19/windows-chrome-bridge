"""Unit tests for the parts of manage.py that edit agent config files and switch versions.

They need no Windows, no Chrome and no install. They never touch real agent configs.
"""

import json
import os
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import manage as m  # noqa: E402

EXE = "/mnt/c/Users/me/AppData/Local/windows-chrome-bridge/versions/0.5.0/qa-bridge.exe"
CLAUDE = {
    "numStartups": 12,
    "mcpServers": {"other": {"type": "stdio", "command": "/usr/bin/other", "args": []}},
    "projects": {"/home/me/x": {"allowedTools": [], "note": "é ü"}},
}


def claude(data):
    return json.dumps(data, indent=2, ensure_ascii=False)


class ClaudeConfig(unittest.TestCase):
    def test_adds_the_entry_and_keeps_every_other_byte(self):
        new = m.claude_text(claude(CLAUDE), EXE)
        expected = json.loads(claude(CLAUDE))
        expected["mcpServers"]["isolated_windows_qa"] = {"type": "stdio", "command": EXE, "args": ["--mcp"], "env": {}}
        self.assertEqual(new, claude(expected))

    def test_remove_takes_out_only_the_entry(self):
        added = m.claude_text(claude(CLAUDE), EXE)
        self.assertEqual(m.claude_text(added, None), claude(CLAUDE))
        self.assertEqual(m.claude_text(claude(CLAUDE), None), claude(CLAUDE))

    def test_refuses_a_file_it_cannot_edit_without_other_changes(self):
        with self.assertRaises(m.Problem):
            m.claude_text(json.dumps(CLAUDE), EXE)


TOML = '''model = "o3"

[mcp_servers.other]
command = "other"
'''


class CodexConfig(unittest.TestCase):
    def test_adds_a_block_and_replaces_it_on_upgrade(self):
        first = m.codex_text(TOML, EXE)
        self.assertTrue(first.startswith(TOML + "\n" + m.BEGIN))
        self.assertIn('command = "' + EXE + '"\nargs = ["--mcp"]\ndefault_tools_approval_mode = "prompt"\n', first)
        # An upgrade points to the new exe and keeps an approval mode the user chose.
        chosen = first.replace('mode = "prompt"', 'mode = "approve"')
        newer = EXE.replace("0.5.0", "0.6.0")
        self.assertEqual(m.codex_text(chosen, newer), chosen.replace(EXE, newer))

    def test_remove_gives_back_the_original(self):
        self.assertEqual(m.codex_text(m.codex_text(TOML, EXE), None), TOML)
        self.assertEqual(m.codex_text(m.codex_text("", EXE), None), "")

    def test_finds_a_block_with_older_marker_text(self):
        old = m.codex_text(TOML, EXE).replace(m.BEGIN, "# BEGIN windows-chrome-bridge (older text)\n")
        self.assertEqual(m.codex_text(old, None), TOML)

    def test_refuses_an_entry_it_did_not_write(self):
        with self.assertRaises(m.Problem):
            m.codex_text(TOML + '\n[mcp_servers.isolated_windows_qa]\ncommand = "x"\n', EXE)


class WslSide(unittest.TestCase):
    """qa-bridge.exe cannot see the agent's WSL: the agent configs pass the distro and the mount root."""

    def test_mount_root_from_the_c_drive(self):
        for c_drive, root in [("/mnt/c/", "/mnt/"), ("/c/", "/"), ("/c", "/"), ("/win/drives/c/", "/win/drives/")]:
            self.assertEqual(m.mount_root(c_drive), root, c_drive)

    def test_agent_configs_get_the_arguments(self):
        args = ["--mcp", "--wsl-distro", "Ubuntu Dev", "--wsl-root", "/win/"]
        entry = json.loads(m.claude_text(claude(CLAUDE), EXE, args))["mcpServers"]["isolated_windows_qa"]
        self.assertEqual(entry["args"], args)
        server = m.tomllib.loads(m.codex_text(TOML, EXE, args))["mcp_servers"]["isolated_windows_qa"]
        self.assertEqual(server["args"], args)
        with mock.patch.dict(os.environ, {"WSL_DISTRO_NAME": "Ubuntu Dev"}), mock.patch.object(m, "MOUNT", "/win/"):
            self.assertEqual(m.mcp_args(), args)


class Uninstall(unittest.TestCase):
    """The profile can hold logins. uninstall deletes it only inside the install folder."""

    def test_profile_plan(self):
        base = Path("/mnt/c/Users/me/AppData/Local/windows-chrome-bridge")
        self.assertEqual(m.profile_plan(base, base / "profile", False), (set(), "removed"))
        self.assertEqual(m.profile_plan(base, base / "profile", True), ({"profile"}, "kept"))
        self.assertEqual(m.profile_plan(base, base / "profiles" / "qa", True), ({"profiles"}, "kept"))
        # Windows ignores letter case, so the same folder typed with other case is still the profile.
        self.assertEqual(m.profile_plan(base, Path(str(base).lower()) / "Profile", True), ({"profile"}, "kept"))
        self.assertEqual(m.profile_plan(base, Path("/mnt/d/qa-profile"), False), (set(), "outside"))
        for unsafe in (base, base.parent):
            with self.assertRaises(m.Problem):
                m.profile_plan(base, unsafe, False)


    def test_links_are_removed_not_followed(self):
        # In WSL a Windows junction is a symbolic link, so a real link is the same case.
        with tempfile.TemporaryDirectory() as tmp:
            base, outside = Path(tmp) / "install", Path(tmp) / "elsewhere"
            (base / "versions" / "0.6.0").mkdir(parents=True)
            (base / "profile").mkdir()
            outside.mkdir()
            (outside / "keep.txt").write_text("not part of the install")
            (base / "state.json").write_text("{}")
            (base / "linked").symlink_to(outside, target_is_directory=True)
            (base / "versions" / "inner").symlink_to(outside, target_is_directory=True)
            with mock.patch.object(m, "win", str):
                m.remove_contents(base, {"profile"})
            self.assertEqual([x.name for x in base.iterdir()], ["profile"])
            self.assertEqual((outside / "keep.txt").read_text(), "not part of the install")

class Versions(unittest.TestCase):
    def test_upgrade_keeps_the_version_before(self):
        state = {"current": "0.5.0", "previous": "0.4.2", "agents": {}}
        self.assertEqual(m.state_after_install(state, "0.6.0")["previous"], "0.5.0")
        self.assertEqual(m.state_after_install(state, "0.5.0")["previous"], "0.4.2")

    def test_rollback_swaps_and_needs_a_version_before(self):
        state = {"current": "0.6.0", "previous": "0.5.0", "agents": {"claude": "/x"}}
        self.assertEqual(
            m.state_after_rollback(state), {"current": "0.5.0", "previous": "0.6.0", "agents": {"claude": "/x"}}
        )
        with self.assertRaises(m.Problem):
            m.state_after_rollback({"current": "0.5.0", "previous": None, "agents": {}})


class Instance(unittest.TestCase):
    """A separate instance must never fall back to the names of the normal install."""

    def test_from_the_variable_or_the_installed_folder(self):
        with tempfile.TemporaryDirectory() as tmp:
            clone = Path(tmp)
            self.assertEqual(m.instance_of(None, clone), "")
            self.assertEqual(m.instance_of("test", clone), "test")
            for bad in ("Test", "te-st", "1test", "a" * 17):
                with self.assertRaises(m.Problem):
                    m.instance_of(bad, clone)
            # The installed copy of manage.py belongs to the instance of its folder.
            normal, test = clone / "windows-chrome-bridge", clone / "windows-chrome-bridge-test"
            (normal / "versions").mkdir(parents=True)
            (test / "versions").mkdir(parents=True)
            self.assertEqual(m.instance_of(None, test), "test")
            self.assertEqual(m.instance_of(None, normal), "")
            with self.assertRaises(m.Problem):
                m.instance_of("test", normal)
            with self.assertRaises(m.Problem):
                m.instance_of("", test)


NAME = "C:\\Users\\Jürgen 张伟 Иван\\AppData\\Local"


@unittest.skipUnless(m.in_wsl(), "needs WSL with Windows interop")
class WindowsText(unittest.TestCase):
    """Text from cmd.exe and reg.exe keeps every letter of a Windows user name."""

    def test_folder_from_a_variable(self):
        wslenv = os.environ.get("WSLENV", "") + ":WCB_TEST_FOLDER"
        with mock.patch.dict(os.environ, {"WCB_TEST_FOLDER": NAME, "WSLENV": wslenv}):
            self.assertEqual(m.windows_folder("WCB_TEST_FOLDER"), Path("/mnt/c/Users/Jürgen 张伟 Иван/AppData/Local"))

    def test_registry_value(self):
        key = "HKCU\\Software\\windows-chrome-bridge-test"
        value = NAME + '\\windows-chrome-bridge\\native-host "x".json'
        subprocess.run([m.REG_EXE, "add", key, "/ve", "/t", "REG_SZ", "/d", value, "/f"], check=True, capture_output=True)
        try:
            self.assertEqual(m.reg_value(key), value)
        finally:
            subprocess.run([m.REG_EXE, "delete", key, "/f"], capture_output=True)
        self.assertIsNone(m.reg_value(key))


if __name__ == "__main__":
    unittest.main()
