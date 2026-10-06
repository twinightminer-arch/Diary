# SPDX-License-Identifier: AGPL-3.0-only
<#
Fallback twin of workbuddy-token.py, for machines without a Python interpreter.

WorkBuddy keeps its Keycloak access token in memory only, so the plugin needs
to read it straight out of the running desktop app. The Python helper is tried
first (it is faster and ships with WorkBuddy); this script exists so the bridge
still works when no Python is available.

Emits one JSON line on stdout, same shape as the Python helper:
    {"ok":true,"token":"<jwt>","exp":1794552131,"iat":...,"sub":"...","iss":"..."}
    {"ok":false,"reason":"..."}
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

function Write-Result($value) {
  [Console]::Out.WriteLine(($value | ConvertTo-Json -Compress -Depth 4))
}

function Get-Claims([string]$token) {
  $parts = $token.Split('.')
  if ($parts.Count -ne 3) { return $null }
  $payload = $parts[1].Replace('-', '+').Replace('_', '/')
  switch ($payload.Length % 4) {
    2 { $payload += '==' }
    3 { $payload += '=' }
  }
  try {
    $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payload))
    return $json | ConvertFrom-Json
  } catch { return $null }
}

try {
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public static class WbTokenScan
{
    const int PROCESS_QUERY_INFORMATION = 0x0400;
    const int PROCESS_VM_READ = 0x0010;
    const int MEM_COMMIT = 0x1000;
    const long MAX_REGION = 64L * 1024 * 1024;

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(int access, bool inherit, int pid);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buffer, int size, out IntPtr read);

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern int VirtualQueryEx(IntPtr h, IntPtr addr, out MEMORY_BASIC_INFORMATION info, int length);

    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr h);

    [StructLayout(LayoutKind.Sequential)]
    struct MEMORY_BASIC_INFORMATION
    {
        public IntPtr BaseAddress;
        public IntPtr AllocationBase;
        public uint AllocationProtect;
        public IntPtr RegionSize;
        public uint State;
        public uint Protect;
        public uint Type;
    }

    static bool IsBase64Url(byte b)
    {
        return (b >= (byte)'A' && b <= (byte)'Z')
            || (b >= (byte)'a' && b <= (byte)'z')
            || (b >= (byte)'0' && b <= (byte)'9')
            || b == (byte)'-' || b == (byte)'_' || b == (byte)'=';
    }

    public static List<string> Scan(int pid)
    {
        var found = new List<string>();
        IntPtr handle = OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, false, pid);
        if (handle == IntPtr.Zero) return found;
        try
        {
            long address = 0;
            var info = new MEMORY_BASIC_INFORMATION();
            int infoSize = Marshal.SizeOf(typeof(MEMORY_BASIC_INFORMATION));
            while (VirtualQueryEx(handle, new IntPtr(address), out info, infoSize) != 0)
            {
                long baseAddress = info.BaseAddress.ToInt64();
                long regionSize = info.RegionSize.ToInt64();
                bool readable = info.Protect == 0x02 || info.Protect == 0x04
                    || info.Protect == 0x20 || info.Protect == 0x40;
                if (info.State == MEM_COMMIT && readable && regionSize > 0 && regionSize <= MAX_REGION)
                {
                    var buffer = new byte[regionSize];
                    IntPtr read;
                    if (ReadProcessMemory(handle, new IntPtr(baseAddress), buffer, (int)regionSize, out read))
                    {
                        int limit = (int)read.ToInt64();
                        for (int i = 0; i + 3 < limit; i++)
                        {
                            if (buffer[i] != (byte)'e' || buffer[i + 1] != (byte)'y' || buffer[i + 2] != (byte)'J') continue;
                            int start = i;
                            int j = i;
                            while (j < limit && (IsBase64Url(buffer[j]) || buffer[j] == (byte)'.')) j++;
                            int length = j - start;
                            if (length >= 200) found.Add(Encoding.ASCII.GetString(buffer, start, length));
                            i = j;
                        }
                    }
                }
                if (regionSize <= 0) break;
                address = baseAddress + regionSize;
                if (address <= 0) break;
            }
        }
        finally { CloseHandle(handle); }
        return found;
    }

    public static List<string> ScanAll()
    {
        var all = new List<string>();
        foreach (var process in Process.GetProcessesByName("WorkBuddy"))
        {
            try { all.AddRange(Scan(process.Id)); }
            catch { }
            finally { process.Dispose(); }
        }
        return all;
    }
}
'@

  if (-not (Get-Process -Name WorkBuddy -ErrorAction SilentlyContinue)) {
    Write-Result @{ ok = $false; reason = 'WorkBuddy is not running - start the desktop app first' }
    return
  }

  $best = $null
  foreach ($token in [WbTokenScan]::ScanAll()) {
    $claims = Get-Claims $token
    if (-not $claims) { continue }
    if ([string]$claims.iss -notlike '*realms/copilot*') { continue }
    # Only the access token authenticates API calls; Offline is a refresh token
    # and IdToken must never be used as a credential.
    if ([string]$claims.typ -ne 'Bearer') { continue }
    if (-not $claims.exp) { continue }
    if (-not $best -or [int]$claims.exp -gt [int]$best.exp) {
      $best = [pscustomobject]@{
        token = $token
        exp   = [int]$claims.exp
        iat   = [int]$claims.iat
        sub   = [string]$claims.sub
        iss   = [string]$claims.iss
      }
    }
  }

  if (-not $best) {
    Write-Result @{ ok = $false; reason = 'no signed-in WorkBuddy session token found; sign in to WorkBuddy' }
    return
  }

  Write-Result @{
    ok     = $true
    token  = $best.token
    exp    = $best.exp
    iat    = $best.iat
    sub    = $best.sub
    iss    = $best.iss
    source = 'workbuddy-memory'
  }
} catch {
  Write-Result @{ ok = $false; reason = ("{0}: {1}" -f $_.Exception.GetType().Name, $_.Exception.Message) }
}
