import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configDir, dataDir } from '@vibetracker/platform';
import {
  desktopEntry,
  plist,
  quotePath,
  unit,
  LAUNCH_LABEL,
  SYSTEMD_UNIT,
} from '../src/autostart-unix.ts';

/**
 * These generators run on any platform, which is the only reason macOS and
 * Linux autostart can be tested at all from a Windows machine. What cannot be
 * tested here is whether `launchctl bootstrap` and `systemctl --user enable`
 * accept them — that happens in CI, on the real runners.
 *
 * So the assertions are about the decisions encoded in the files, not about
 * syntax. Each one is a line that would be wrong in a way nothing else would
 * catch.
 */

const NODE = '/usr/local/bin/node';
const ENTRY = '/home/ali/vt/src/index.ts';

test('launchd restarts a crash and does not fight a deliberate stop', () => {
  const p = plist(NODE, ENTRY);
  // `KeepAlive: true` would restart the daemon after *any* exit, including the
  // clean one from `vt daemon stop` — which would make stopping it impossible
  // without also unloading the agent. The dictionary form restarts only after
  // a failure, which is what the watchdog's exit(1) produces.
  assert.match(p, /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key><false\/>/);
  assert.ok(!/<key>KeepAlive<\/key>\s*<true\/>/.test(p), 'KeepAlive must not be a bare true');

  assert.match(p, new RegExp(`<key>Label</key><string>${LAUNCH_LABEL}</string>`));
  assert.match(p, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(p, /<key>ProcessType<\/key><string>Background<\/string>/);
  assert.match(p, /<key>ThrottleInterval<\/key><integer>30<\/integer>/);
  // The arguments have to arrive as three separate strings; one joined string
  // would be looked up as a single executable name and never start.
  assert.match(p, /<string>daemon<\/string>/);
});

test('a path with an ampersand survives the plist', () => {
  const p = plist(NODE, '/home/ali/R&D/vt/src/index.ts');
  assert.match(p, /R&amp;D/);
  assert.ok(!/R&D/.test(p), 'a raw & makes the plist unparseable');
});

test('the systemd unit makes the write promise enforceable', () => {
  const u = unit(NODE, ENTRY);
  // This is the whole point of the Linux unit: "never writes to your projects,
  // never writes to an agent's state directory" stops being a README claim and
  // becomes something the kernel refuses. A fork that removed the check in code
  // would still be unable to write.
  assert.match(u, /^ProtectHome=read-only$/m);
  // Quoted, so compared in the quoted form -- the unit is written for a shell
  // that splits on whitespace and macOS puts our data under "Application
  // Support".
  const rw = /^ReadWritePaths=(.*)$/m.exec(u)?.[1] ?? '';
  assert.ok(rw.includes(quotePath(dataDir())), 'the daemon must be able to write its own database');
  assert.ok(rw.includes(quotePath(configDir())), 'and its own config');
  assert.ok(!rw.includes('.claude'), 'the agent state directory must stay read-only');

  assert.match(u, /^Restart=on-failure$/m);
  assert.match(u, /^RestartSec=30$/m);
  assert.match(u, /^WantedBy=default\.target$/m);
  assert.match(u, /^NoNewPrivileges=yes$/m);
});

test('the unit does not carry the flag that silently breaks V8', () => {
  // `MemoryDenyWriteExecute=yes` is the first line people add when hardening a
  // systemd unit, and it disables the JIT. The daemon would start, behave
  // strangely, and nothing would say why. Pinned as a test because the next
  // person to harden this file will reach for it.
  const u = unit(NODE, ENTRY);
  assert.ok(!/^MemoryDenyWriteExecute=/m.test(u), 'must not be set as a directive');
  // It *is* named in a comment inside the generated file, on purpose: the
  // person who opens the unit to harden it further should find out there
  // rather than after a week of strange behaviour.
  assert.match(u, /^# MemoryDenyWriteExecute is NOT set/m);
});

test('the XDG fallback starts the same command', () => {
  const d = desktopEntry(NODE, ENTRY);
  assert.match(d, /^\[Desktop Entry\]$/m);
  assert.match(d, new RegExp(`^Exec="${NODE}" "${ENTRY}" daemon$`, 'm'));
  assert.match(d, /^Terminal=false$/m);
});

test('unit and label names are stable', () => {
  // These are what `systemctl --user disable` and `launchctl bootout` are given
  // at uninstall time. Renaming one without the other leaves an autostart entry
  // nothing can remove, on a machine we do not own.
  assert.equal(SYSTEMD_UNIT, 'vibetracker');
  assert.equal(LAUNCH_LABEL, 'dev.vibetracker.daemon');
});

test('a path with a space in it still starts the daemon', () => {
  // nvm puts node under a versioned directory, a checkout can live under
  // "My Projects", and macOS hands out "Library/Application Support". systemd
  // and the XDG spec both split ExecStart on whitespace, so an unquoted path
  // with a space in it becomes four arguments and an executable that does not
  // exist -- installed, reported enabled, never starts.
  const node = '/home/a b/.nvm/versions/node/v22.20.0/bin/node';
  const entry = '/home/a b/My Projects/vt/packages/cli/src/index.ts';

  const u = unit(node, entry);
  assert.match(u, new RegExp(`^ExecStart="${node}" "${entry}" daemon$`, 'm'));
  // The write promise is made of paths too, and dataDir() on macOS contains
  // "Application Support". An unquoted ReadWritePaths there does not fail
  // loudly -- it silently grants write access to a path that is not ours.
  const rw = /^ReadWritePaths=(.*)$/m.exec(u)?.[1] ?? '';
  assert.equal(rw.split('" "').length, 2, `not quoted: ${rw}`);
  assert.ok(rw.startsWith('"') && rw.endsWith('"'));

  const d = desktopEntry(node, entry);
  assert.match(d, new RegExp(`^Exec="${node}" "${entry}" daemon$`, 'm'));

  // And the staleness check still recognises its own installation, which reads
  // the raw path out of the quoted file.
  assert.ok(u.includes(entry));
  assert.ok(d.includes(entry));
});
