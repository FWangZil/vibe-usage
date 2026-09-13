# Windows acceptance fixes

Update after native retest (2026-09-13): CLI `5387113efc20` and the actual
vendored snapshot achieved **377 total / 367 pass / 0 fail / 10 explained
skips** on Windows Node 22.23.1. All eight original failures ran and passed,
including the OpenCode/Kimi ACL tests. The original FAIL below remains history.
Initial ACL attempts failed when a PowerShell 7 host injected its module path
into Windows PowerShell 5; restoring the standard path made the suite pass.
The new `0.10.32-windows-acceptance.2` test helper now selects `$PSHOME/Modules`
and imports the inbox Security module explicitly inside the child process.
No caller/global environment, product runtime policy or assertions are changed.
Re-run the suite under the original polluted host without manually fixing
PSModulePath; that environmental robustness change still needs native retest.

Baseline: CLI `4ab7b98e3e6c6a6e5efcd4ac9315ff03f5adbd1d`, version
`0.10.32`; Windows Node 22 reported **377 total / 359 pass / 8 fail / 10 skip**.
That remains a failed native baseline. macOS results do not replace it.
This branch uses the unpublished `0.10.32-windows-acceptance.2` identity.

## Eight failing cases

| Original case | Resolution and required validation |
|---|---|
| #50 Claude invalid root | This fixture uses an ordinary file as a root, **not chmod**. Windows can return ENOENT for `file/projects`, which looked like an empty successful scan. Validate root type before scanning, mark invalid roots incomplete and preserve the existing state-protection contract. Missing optional default stores remain harmless. The original assertion stays. |
| #93 Codex roots | Construct absolute temporary roots and expected child paths with native path operations. Both live and archive stores must remain present. |
| #178 npx launcher | Select the path implementation from the function's explicit target OS, not its test host. Assert complete Windows and POSIX launchers on every platform, including missing-npx fallback. No service/update policy changes. |
| #263 mcode / #269 mimocode | Use native absolute fixture paths; retain database-name, override and XDG precedence assertions. |
| #280 OpenCode unreadable database | Preserve chmod denial on POSIX; Windows applies a temporary current-user NTFS deny-read ACE to the disposable database. Assert the file actually cannot be read before testing the parser; restore its original DACL in finally. ACL failure is a test failure, not an automatic skip. |
| #312 Kimi rotation | Keep POSIX 0600 assertion. On Windows give the disposable fixture parent an explicit private DACL and check that the rotated credential file inherits it, remains readable by the current user and grants no additional principals. Rotation/token/cleanup assertions remain. No real credentials or production ACL policy are changed. |
| #283 OMP XDG | Preserve the existing product boundary: automatic XDG migration is Linux/macOS-only. On Windows assert those XDG paths are absent and the explicit agent/session override still works. Run the test on every OS; do not skip it. |

The Windows Kimi test verifies inheritance from a known private test parent.
It does not establish that every user's real credential directory has a private
DACL. Windows ACL protection and POSIX mode bits are distinct; 0666 from Node
on Windows alone proves neither public access nor privacy. The native Windows
tests must run before claiming the new behavior is validated there.

## Original ten skipped cases

These are retained coverage gaps with named reasons in TAP, not passes. All
remain runnable on POSIX (some require an unprivileged user). Windows Node 22
and 24 CI now runs the complete suite, including the new OpenCode/Kimi ACL
paths above. Those two paths do not replace these per-parser cases.

| Original case | Windows boundary / remaining coverage |
|---|---|
| #119 Codex configured unreadable subtree | Fixture denies a directory using POSIX chmod; Windows ACL directory-denial equivalent remains untested. |
| #141 Codex unreadable continuation | Fixture denies a rollout using chmod; Windows ACL continuation-read case remains untested. |
| #153 Cola unreadable scope | chmod of a scope directory; Windows ACL scope case remains untested. Root on POSIX also bypasses this denial. |
| #204 DSH nested project read failure | chmod directory fixture; Windows ACL traversal failure remains untested. |
| #242 Hermes unreadable home | chmod home discovery fixture; Windows ACL equivalent remains untested. |
| #243 Hermes unreadable profiles | chmod profile-container fixture; Windows ACL equivalent remains untested. |
| #244 Hermes unreadable profile | chmod individual profile fixture; Windows ACL equivalent remains untested. |
| #245 Hermes native-root failure / no legacy fallback | Simulates Windows discovery on a POSIX chmod fixture; native Windows ACL equivalent remains untested. |
| #293 Pi unreadable sibling store | chmod directory/file fixture; Windows ACL sibling-store case remains untested. |
| #335 config file owner-only mode | Asserts POSIX mode 0600. Windows config-file ACL privacy remains untested by this case. |

Node 20 has separate sqlite/zstd capability skips and is not the Windows
acceptance runtime. Use Node 22.23.x or Node 24. Current case numbers may shift
when tests are added: compare names and stated reasons, not just totals.

No active-time arithmetic, deduplication, account purchase, npm publication,
or production credentials are part of this change.
