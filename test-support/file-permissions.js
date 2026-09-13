// Permission probes operate only on disposable fixtures below the OS temp dir.
// Windows mode bits do not model NTFS ACLs; never treat chmod(0) as a denial.
import assert from 'node:assert/strict';
import { chmodSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, relative } from 'node:path';
import { execFileSync } from 'node:child_process';

function assertTemporary(path) {
  const rel = relative(realpathSync(tmpdir()), realpathSync(path));
  assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel), 'permissions may only change on a temporary fixture');
}

function windowsAcl(path, script, extra = {}) {
  assertTemporary(path);
  // The host may be PowerShell 7 while this executable is Windows PowerShell
  // 5. Its inherited PSModulePath must not load PS7 Security assemblies.
  // Restrict only this disposable child to its own inbox modules.
  const code = `$ErrorActionPreference = 'Stop'
$env:PSModulePath = [System.IO.Path]::Combine($PSHOME, 'Modules')
Import-Module ([System.IO.Path]::Combine($PSHOME, 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1')) -ErrorAction Stop
${script}`;
  return execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', Buffer.from(code, 'utf16le').toString('base64'),
  ], {
    env: { ...process.env, VIBE_TEST_PERMISSION_PATH: path, ...extra },
    encoding: 'utf8', windowsHide: true, timeout: 30_000,
  }).trim();
}

export async function withUnreadableFile(path, run) {
  assertTemporary(path);
  const mode = statSync(path).mode & 0o777;
  const original = process.platform === 'win32' ? windowsAcl(path, `
    $acl = Get-Acl -LiteralPath $env:VIBE_TEST_PERMISSION_PATH
    $acl.Sddl
  `) : null;
  try {
    if (process.platform === 'win32') {
      windowsAcl(path, `
        $acl = Get-Acl -LiteralPath $env:VIBE_TEST_PERMISSION_PATH
        $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
        $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'ReadData', 'Deny')
        $acl.AddAccessRule($rule)
        Set-Acl -LiteralPath $env:VIBE_TEST_PERMISSION_PATH -AclObject $acl
      `);
    } else {
      chmodSync(path, 0);
    }
    // Fail if the fixture did not actually deny reads; do not get a green
    // parser test from a permission operation that the current token bypasses.
    assert.throws(() => readFileSync(path), error => ['EACCES', 'EPERM'].includes(error.code));
    return await run();
  } finally {
    if (process.platform === 'win32') {
      windowsAcl(path, `
        $acl = Get-Acl -LiteralPath $env:VIBE_TEST_PERMISSION_PATH
        $acl.SetSecurityDescriptorSddlForm($env:VIBE_TEST_ORIGINAL_DACL, [System.Security.AccessControl.AccessControlSections]::Access)
        Set-Acl -LiteralPath $env:VIBE_TEST_PERMISSION_PATH -AclObject $acl
      `, { VIBE_TEST_ORIGINAL_DACL: original });
    } else {
      chmodSync(path, mode);
    }
  }
}

// This establishes a known private *test* parent. It does not rewrite any
// real Kimi credentials or change the product's Windows inheritance policy.
export function makePrivateWindowsFixtureDirectory(path) {
  if (process.platform !== 'win32') return;
  windowsAcl(path, `
    $acl = [System.Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
    $system = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
    foreach ($identity in @($sid, $system)) {
      $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($identity, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')
      $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $env:VIBE_TEST_PERMISSION_PATH -AclObject $acl
  `);
}

export function assertPrivateCredentialFile(path) {
  if (process.platform !== 'win32') {
    assert.equal(statSync(path).mode & 0o777, 0o600);
    return;
  }
  const result = JSON.parse(windowsAcl(path, `
    $acl = Get-Acl -LiteralPath $env:VIBE_TEST_PERMISSION_PATH
    $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object {
      @{ sid = $_.IdentityReference.Value; allow = ($_.AccessControlType -eq 'Allow'); rights = [long]$_.FileSystemRights; inherited = $_.IsInherited }
    })
    @{ currentUser = $sid; rules = $rules } | ConvertTo-Json -Depth 4 -Compress
  `));
  const allowed = result.rules.filter(rule => rule.allow);
  assert.ok(allowed.some(rule => rule.sid === result.currentUser && (rule.rights & 1)), 'current user retains read access');
  assert.ok(allowed.every(rule => [result.currentUser, 'S-1-5-18'].includes(rule.sid)), 'rotation must not grant other users access');
  assert.ok(allowed.every(rule => rule.inherited), 'rotated file inherits the private fixture parent ACL');
}
