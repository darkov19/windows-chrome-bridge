#!/usr/bin/env python3
"""Build qa-bridge.exe and the release folder build/<version>/.

Usage: python3 build.py          build build/<version>/
       python3 build.py --zip    also write dist/windows-chrome-bridge-<version>.zip and its .sha256

Runs from WSL or from native Windows Python. It uses the C# compiler that ships with Windows
(.NET Framework 4, C# 5). It never installs anything; manage.py install does that.
It needs Python 3.12 or newer.
"""

import sys

# First, so an old Python gets this message and not a strange error later.
if sys.version_info < (3, 12):
    sys.exit("ERROR: building Windows Chrome Bridge needs Python 3.12 or newer. This is Python %d.%d." % sys.version_info[:2])

import hashlib
import json
import os
import shutil
import subprocess
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parent
WINDOWS = os.name == "nt"
if WINDOWS:
    CSC = Path(os.environ.get("WINDIR", r"C:\Windows")) / r"Microsoft.NET\Framework64\v4.0.30319\csc.exe"
else:
    # wslpath knows where this WSL mounts drive C: (/mnt/c unless /etc/wsl.conf says otherwise).
    C = subprocess.run(["wslpath", "-u", "C:\\"], capture_output=True, text=True).stdout.strip() or "/mnt/c/"
    CSC = Path(C) / "Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe"
SOURCES = ["Bridge.cs", "Config.cs", "Lifecycle.cs"]
# Files next to manage.py in the release zip, besides the release folder itself.
ZIP_EXTRAS = ["manage.py", "README.md", "LICENSE", "CHANGELOG.md", "SECURITY.md", "skill/SKILL.md"]


def version():
    return json.loads((REPO / "extension" / "manifest.json").read_text(encoding="utf-8"))["version"]


def native(path):
    """A path csc.exe understands."""
    if WINDOWS:
        return str(path)
    return subprocess.check_output(["wslpath", "-w", str(path)], text=True, encoding="utf-8").strip()


def build():
    """Build build/<version>/ (qa-bridge.exe, catalog.json, extension/) and return its path."""
    v = version()
    check = subprocess.run([sys.executable, str(REPO / "host" / "make_catalog.py"), "--check"])
    if check.returncode:
        sys.exit("host/catalog.json is out of date. Run: python3 host/make_catalog.py")
    if not CSC.exists():
        sys.exit("The C# compiler is missing: " + str(CSC) + ". It is part of .NET Framework 4 on Windows 10 and 11")

    out = REPO / "build" / v
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    shutil.copy2(REPO / "host" / "catalog.json", out / "catalog.json")
    shutil.copytree(REPO / "extension", out / "extension")

    exe = out / "qa-bridge.exe"
    command = [
        str(CSC),
        "/nologo",
        "/target:exe",
        "/optimize+",
        "/utf8output",
        "/out:" + native(exe),
        "/reference:System.Web.Extensions.dll",
        "/reference:System.Management.dll",
    ] + [native(REPO / "host" / name) for name in SOURCES]
    r = subprocess.run(command, capture_output=True, encoding="utf-8", errors="replace")
    if r.returncode:
        sys.exit("Compile failed:\n" + r.stdout + r.stderr)
    if not WINDOWS:
        exe.chmod(0o755)
    reported = subprocess.run([str(exe), "--version"], capture_output=True, encoding="utf-8").stdout.strip()
    if reported != "windows-chrome-bridge " + v:
        sys.exit("Built exe reports " + repr(reported) + ", expected " + v)
    print("Built " + v + " in " + str(out))
    return out


def make_zip(folder):
    """Write dist/windows-chrome-bridge-<version>.zip with one top folder, and a .sha256 file."""
    v = version()
    top = "windows-chrome-bridge-" + v
    dist = REPO / "dist"
    dist.mkdir(exist_ok=True)
    target = dist / (top + ".zip")
    files = [(p, p.relative_to(folder).as_posix()) for p in sorted(folder.rglob("*")) if p.is_file()]
    files += [(REPO / name, name) for name in ZIP_EXTRAS]
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as z:
        for path, name in files:
            z.write(path, top + "/" + name)
    digest = hashlib.sha256(target.read_bytes()).hexdigest()
    target.with_name(target.name + ".sha256").write_bytes((digest + "  " + target.name + "\n").encode())
    print("Wrote " + str(target) + " (sha256 " + digest + ")")


if __name__ == "__main__":
    built = build()
    if "--zip" in sys.argv[1:]:
        make_zip(built)
