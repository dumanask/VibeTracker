/**
 * The Linux and macOS probes, parsed from recorded output.
 *
 * These two files are the platform layer's whole answer to "is this process
 * alive, and is it doing anything", and until now neither had a single test —
 * they were written on a Windows machine, have never run on the platform they
 * are for, and would first be exercised by the user they shipped to.
 *
 * A test cannot supply a real `/proc` or a real `ps`, but it can supply what
 * those produce, and that is where every bug in a reader like this lives. Both
 * formats have the same trap: a variable-width field in the middle of a
 * fixed-position line. `/proc/<pid>/stat` puts the executable name in
 * parentheses and allows spaces and parentheses inside it; `ps -o lstart`
 * prints five words of date between the pid and the CPU time. Read either from
 * the wrong end and the fields shift silently — CPU becomes zero, or the
 * start-time string stops matching anything and the reuse guard marks every
 * live session as a recycled pid.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStat, parseStatTree, statFields } from '../src/probe/linux.ts';
import { parsePsSnapshot, parsePsTree } from '../src/probe/darwin.ts';

// A real line, from a Linux box, trimmed to the fields we read. Fields:
// 1 pid, 2 comm, 3 state, 4 ppid, ... 14 utime, 15 stime, ... 22 starttime,
// ... 24 rss (in pages).
const STAT =
  '4242 (node) S 4100 4242 4100 0 -1 4194304 91234 0 0 0 ' + // 1..13
  '318 47 0 0 20 0 11 0 ' + // 14 utime, 15 stime, 16..21
  '9876543 ' + // 22 starttime
  '1234567890 ' + // 23 vsize
  '13029 ' + // 24 rss, pages
  '18446744073709551615 1 1 0 0 0 0 0 0 0 0 0 0 0 17 3 0 0 0 0 0';

test('the Linux fields are counted from after the executable name', () => {
  const s = parseStat(4242, STAT);
  assert.ok(s);
  assert.equal(s.pid, 4242);
  // Equality only, never arithmetic: jiffies since boot are meaningless
  // without a boot time and are used as an identity, not a date.
  assert.equal(s.startTime, '9876543');
  assert.equal(s.startTimeKind, 'jiffies');
  // (318 + 47) ticks at 100 Hz = 3.65 s.
  assert.equal(s.cpuNs, 3_650_000_000);
  assert.equal(s.rss, 13029 * 4096);
});

test('a process name with spaces and brackets in it does not shift the fields', () => {
  // Legal, and the reason the split point is the LAST ')' rather than a
  // whitespace split from the left. A name like this is what a wrapper script
  // or an Electron helper actually produces.
  const nasty = STAT.replace('(node)', '(my app (helper) 2)');
  const s = parseStat(4242, nasty);
  assert.ok(s);
  assert.equal(s.startTime, '9876543', 'the fields shifted because the name contains a space');
  assert.equal(s.cpuNs, 3_650_000_000);

  // And the same line read for the tree: field 4 is the parent.
  const t = parseStatTree(4242, nasty, 1_700_000_000_000);
  assert.ok(t);
  assert.equal(t.ppid, 4100);
  // starttime / USER_HZ seconds after boot.
  assert.equal(t.startMs, 1_700_000_000_000 + 98765.43 * 1000);
});

test('an unparseable stat line is absence, not a wrong answer', () => {
  assert.equal(statFields('no parenthesis here'), null);
  assert.equal(parseStat(1, ''), null);
  assert.equal(parseStat(1, '1 (x) S'), null, 'no starttime, no answer');
  // No boot time is a real state on a container with a masked /proc/stat: the
  // entry still exists, it just cannot say when it started.
  const t = parseStatTree(4242, STAT, null);
  assert.equal(t?.startMs, null);
  assert.equal(t?.ppid, 4100);
});

// `ps -axo pid=,lstart=,time=,rss=` under LC_ALL=C. The date is five words
// wide and sits between two numeric fields, which is the whole difficulty.
const PS = [
  '    1 Sun Aug 17 22:04:33 2026 12:03.45 152340',
  '  501 Mon Aug 18 09:12:00 2026 0:00.42   8192',
  ' 9999 Tue Aug 19 01:00:07 2026 2-03:04:05  4096',
  '',
].join('\n');

test('the macOS line is read from both ends, because the date is in the middle', () => {
  const all = parsePsSnapshot(PS);
  assert.equal(all.size, 3);

  const first = all.get(1);
  assert.ok(first);
  assert.equal(first.startTime, 'Sun Aug 17 22:04:33 2026');
  assert.equal(first.startTimeKind, 'lstart');
  // 12:03.45 = 723.45 s
  assert.equal(first.cpuNs, 723_450_000_000);
  assert.equal(first.rss, 152340 * 1024);

  // The day-prefixed shape `DD-HH:MM:SS`, which a long-running daemon reaches
  // and a short test never would.
  assert.equal(all.get(9999)?.cpuNs, (2 * 86400 + 3 * 3600 + 4 * 60 + 5) * 1_000_000_000);

  // And the filter, which is how the caller asks about its own pids only.
  const some = parsePsSnapshot(PS, new Set([501]));
  assert.deepEqual([...some.keys()], [501]);
});

test('the process tree survives a start time it cannot read', () => {
  const tree = parsePsTree(
    [
      '  1     0 Sun Aug 17 22:04:33 2026',
      ' 42     1 Paz Ağu 17 22:04:33 2026', // a locale we did not ask for
      '',
    ].join('\n'),
  );
  assert.equal(tree.get(1)?.ppid, 0);
  assert.ok((tree.get(1)?.startMs ?? 0) > 0);

  // The reason `ps` is now run with LC_ALL=C. If a localised date does slip
  // through, the entry still has its parent — losing a timestamp is a degraded
  // reading, losing the row would be a hole in the tree.
  assert.equal(tree.get(42)?.ppid, 1);
  assert.equal(tree.get(42)?.startMs, null);
});
