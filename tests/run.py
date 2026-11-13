#!/usr/bin/env python3
"""Run the tests.

  python3 tests/run.py                    unit tests: no Windows, no Chrome (needs Node.js 18+)
  python3 tests/run.py --live             live tests: the installed bridge, headless QA Chrome
  python3 tests/run.py --live --display   live tests with real (background) windows
"""

import subprocess
import sys
from pathlib import Path

TESTS = Path(__file__).resolve().parent
LIVE = ["test_capabilities.py", "test_record.py", "test_perf.py", "test_lifecycle.py", "test_policy.py", "test_sessions.py"]


def run(command, cwd=TESTS):
    print("$ " + " ".join(command), flush=True)
    return subprocess.run(command, cwd=str(cwd)).returncode == 0


def main():
    args = sys.argv[1:]
    if "--live" in args:
        extra = ["--display"] if "--display" in args else []
        results = [run([sys.executable, name] + extra, cwd=TESTS / "live") for name in LIVE]
    else:
        results = [
            run([sys.executable, str(TESTS / "test_manage.py"), "-v"]),
            run(["node", "--test"] + [str(TESTS / n) for n in ("rules.test.js", "tree.test.js", "logs.test.js", "mp4.test.js", "perf.test.js")]),
        ]
    print("PASSED" if all(results) else "FAILED", flush=True)
    sys.exit(0 if all(results) else 1)


if __name__ == "__main__":
    main()
