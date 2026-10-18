# Synergy connector tests on LuneOS

Host-side harness that drives a LuneOS phone over adb and checks every
connector in this repo (7 IM, 12 cloud) plus the 9 music providers of
`org.webosports.app.music`. Python 3 standard library only. The TouchPad
harness next door (`tests/test-connectors.sh`, novacom) is unrelated.

```sh
tests/luneos/run.py --list                                   # connectors and tests
tests/luneos/run.py --serial MST0000022                      # L0+L1, everything
tests/luneos/run.py --serial MST0000022 --family im --level 0,1,2
tests/luneos/run.py --serial MST0000022 --only dropbox,mega --level 2
python3 -m unittest discover -s tests/luneos/selftest        # the harness's own tests
```

Reports land in `build-output/luneos/<stamp>/` (`report.txt`, `results.json`,
`junit.xml`). Exit status is non-zero on any FAIL, ERROR or XPASS.

## Levels

| Level | Changes device state | Needs | What it checks |
|---|---|---|---|
| 0 install | no | nothing | template installed, identical to source, registered, icons; validator app and its ACG grant; every `palm://` target in the template answers; IM plugin and its libraries; cloud sources/frameworks resolve, `node --check`, ACLs name LuneOS apps, TLS to the provider; music daemon, GStreamer elements |
| 1 provision | yes, cleaned up | network | IM account create -> loginstate -> failed login -> delete -> no leftover rows; cloud consent URL served by the provider, bogus tokens rejected cleanly, ACL refuses strangers; music anonymous search, auth status, bogus login |
| 2 live | yes | `creds.local.json` | IM login, text round-trip (echo peer), image send; cloud list, upload/download byte-exact twice, photos; music playback with position, pause, PulseAudio stream |
| 3 ui | — | — | planned: Add Account and validator cards render (WAM CDP on :9998) |

Every test runs in a journal window: a process that dies with a signal while
it runs fails the test. systemd-coredump does not work on halium kernels, so
crashes are taken from the kernel's `audit: ANOM_ABEND ... sig=N` lines.

## Files

- `connectors.json` — the few facts templates do not carry (plugin `.so`, auth
  kind, music provider id, LuneOS package). Everything else is read from the
  templates; a template without an entry here is an error, not a silent skip.
- `creds.example.json` — copy to `creds.local.json` (gitignored). Networks that
  sign in by QR, 2FA or OAuth use `"account": "existing"`: sign in once on the
  device, the harness reuses that account and never deletes it.
- `known-issues.json` — tracked defects. Listed failures report XFAIL; a listed
  test that passes reports XPASS so the entry is removed.

## Device facts the harness relies on

- `adb shell` exits 0 whatever the command did; commands carry an exit marker.
- `luna-send -a <appId>` sets the caller id that the Accounts service and
  cloudcore's `acl.js` check, so calls go out as the app a real user would use.
- If adb drops (USB resets while other devices flash), the test is retried once
  after the device comes back and its queued cleanups are replayed first.
