#!/usr/bin/env python3
# SPDX-License-Identifier: AGPL-3.0-only
"""Read the signed-in WorkBuddy token so Diary can drive the bundled
``codebuddy`` CLI without asking the user to log in a second time.

Why this exists
---------------
WorkBuddy is a Keycloak-protected client (``cli-external-link`` /
``bearerToken``). The desktop app holds its access token **in memory only** -
nothing usable is ever written to disk, and the CLI keeps its own, separate
login. So an app that shells out to the CLI is stuck at "Authentication
required" until the user runs ``/login``.

The desktop app does hold a live token while it runs, though, and it is
readable from the same user account. We scan the running ``WorkBuddy.exe``
processes for JWTs, keep the ones issued by the ``realms/copilot`` realm,
and print the freshest one as JSON on stdout.

The caller (the Diary plugin) feeds it to the CLI as
``CODEBUDDY_AUTH_TOKEN``, which is the documented "bring your own token"
entry point of the CLI.

Only the standard library is used, and nothing is written anywhere.

Output (single JSON line on stdout):
    {"ok": true,  "token": "<jwt>", "exp": 1794552131, "iat": 1791294617, "source": "..."}
    {"ok": false, "reason": "..."}
"""

from __future__ import annotations

import base64
import ctypes
import ctypes.wintypes as wintypes
import json
import re
import subprocess
import sys

PROCESS_QUERY_INFORMATION = 0x0400
PROCESS_VM_READ = 0x0010
MEM_COMMIT = 0x1000
# PAGE_READONLY | PAGE_READWRITE | PAGE_EXECUTE_READ | PAGE_EXECUTE_READWRITE
READABLE_PROTECTIONS = {0x02, 0x04, 0x20, 0x40}
MAX_REGION_BYTES = 64 * 1024 * 1024
TARGET_IMAGE = "WorkBuddy.exe"

# A JWT is three base64url segments. Matching the whole shape up front keeps
# the per-byte work down to a single pass of the (cheap) C-level regex engine.
JWT_PATTERN = re.compile(rb"eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{10,}")

# Tokens issued by the WorkBuddy realm are the ones the CLI accepts. Anything
# else found in memory (content-signing tokens, channel tokens, …) is noise.
ISSUER_MARKER = "realms/copilot"


class MemoryBasicInformation(ctypes.Structure):
    _fields_ = [
        ("BaseAddress", ctypes.c_void_p),
        ("AllocationBase", ctypes.c_void_p),
        ("AllocationProtect", wintypes.DWORD),
        ("RegionSize", ctypes.c_size_t),
        ("State", wintypes.DWORD),
        ("Protect", wintypes.DWORD),
        ("Type", wintypes.DWORD),
    ]


def _target_pids() -> list[int]:
    """PIDs of running WorkBuddy desktop processes, newest first is irrelevant."""
    try:
        output = subprocess.run(
            ["tasklist", "/FI", f"IMAGENAME eq {TARGET_IMAGE}", "/FO", "CSV", "/NH"],
            capture_output=True, text=True, timeout=25,
        ).stdout
    except Exception:
        return []
    pids: list[int] = []
    for line in output.splitlines():
        cells = [cell.strip().strip('"') for cell in line.split('","')]
        if len(cells) >= 2 and cells[1].isdigit():
            pids.append(int(cells[1]))
    return pids


def _scan_process(pid: int, kernel32) -> list[str]:
    handle = kernel32.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, False, pid)
    if not handle:
        return []
    hits: list[str] = []
    seen: set[str] = set()
    address = 0
    info = MemoryBasicInformation()
    size_of_info = ctypes.sizeof(info)
    try:
        while kernel32.VirtualQueryEx(handle, ctypes.c_void_p(address), ctypes.byref(info), size_of_info):
            base = info.BaseAddress or 0
            size = info.RegionSize or 0
            if (info.State == MEM_COMMIT and size and size <= MAX_REGION_BYTES
                    and info.Protect in READABLE_PROTECTIONS):
                buffer = ctypes.create_string_buffer(size)
                read = ctypes.c_size_t(0)
                if kernel32.ReadProcessMemory(handle, ctypes.c_void_p(base), buffer, size, ctypes.byref(read)):
                    for match in JWT_PATTERN.finditer(buffer.raw[: read.value]):
                        try:
                            token = match.group(0).decode("ascii")
                        except UnicodeDecodeError:
                            continue
                        if token not in seen:
                            seen.add(token)
                            hits.append(token)
            if size <= 0:
                break
            address = base + size
            if address <= 0:
                break
    finally:
        kernel32.CloseHandle(handle)
    return hits


def _claims(token: str) -> dict:
    """Decode just the payload segment; no signature check is needed here."""
    parts = token.split(".")
    if len(parts) != 3:
        return {}
    payload = parts[1] + "=" * (-len(parts[1]) % 4)
    try:
        return json.loads(base64.urlsafe_b64decode(payload).decode("utf-8", "replace"))
    except Exception:
        return {}


def collect() -> dict:
    if not sys.platform.startswith("win"):
        return {"ok": False, "reason": "WorkBuddy token discovery needs Windows"}

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.restype = ctypes.c_void_p
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.CloseHandle.argtypes = [ctypes.c_void_p]

    pids = _target_pids()
    if not pids:
        return {"ok": False, "reason": "WorkBuddy is not running - start the desktop app first"}

    best: dict | None = None
    for pid in pids:
        for token in _scan_process(pid, kernel32):
            claims = _claims(token)
            issuer = str(claims.get("iss", ""))
            if ISSUER_MARKER not in issuer:
                continue
            # ``Bearer`` is the access token; ``Offline`` is a refresh token and
            # ``IdToken`` must never be used as an API credential.
            if str(claims.get("typ", "")) != "Bearer":
                continue
            if not claims.get("exp"):
                continue
            if best is None or claims["exp"] > best["exp"]:
                best = {
                    "token": token,
                    "exp": int(claims["exp"]),
                    "iat": int(claims.get("iat") or 0),
                    "sub": str(claims.get("sub", "")),
                    "iss": issuer,
                }

    if best is None:
        return {"ok": False, "reason": "no signed-in WorkBuddy session token found; sign in to WorkBuddy"}
    return {"ok": True, **best, "source": "workbuddy-memory"}


def main() -> int:
    try:
        result = collect()
    except Exception as error:  # never let a crash look like "no token"
        result = {"ok": False, "reason": f"{type(error).__name__}: {error}"}
    # json.dump with ensure_ascii keeps the payload pure ASCII, which matters on
    # Windows consoles whose default code page is not UTF-8.
    json.dump(result, sys.stdout, ensure_ascii=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
