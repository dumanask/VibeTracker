# VibeTracker

A control room for multi-agent, multi-project vibe coding.

When you are working on many projects at once — different IDE windows, different agent
CLIs — it shows you on one screen which agent is running, which one is waiting on you, and
where each project stands.

**It never writes a file into your projects. It never talks to an agent. It never goes to
the network.**

Apache-2.0 · Windows, macOS, Linux · an npm package or a desktop app

## Install

**Desktop app** — download the package for your platform from
[Releases](https://github.com/dumanask/VibeTracker/releases). Node is not required: the
package carries its own runtime. The builds are not code signed, so Windows SmartScreen
shows a warning ("More info" → "Run anyway") and macOS needs
**System Settings → Privacy & Security → Open Anyway** after the first refusal. That gap is
[stated rather than hidden](#unsigned-and-it-says-so).

**If you already have Node 22.20+:**

```bash
npm i -g vibetracker
vt init
```

---

## Status: open source · six agents · three platforms

The daemon, the live dashboard, the single-instance lock, the watchdog, the retention
policy, autostart, `vt doctor`, the redaction pipeline, **hook-based exact state
detection** and the **phase/progress engine** all work — which means both halves of the
original question get answered: *what is the agent doing* and *what stage is the project
at*.

M4 made all of it **installable on somebody else's computer**: setup through `vt init`,
TOML configuration, an allowlisted diagnostics bundle, uninstall with a manifest, and an
npm package with zero dependencies. The tarball was verified by installing and running it
in a clean directory.

Everything left over after that has since closed too: the **interface is fully bilingual**
(coverage is measured by a test), the **D4–D6 drift detectors**, the **phase board** (a
timeline recovered from commit history), the **`dialects/` registry**, and a **synthetic
environment generator** plus a CI matrix that runs the whole thing on a machine with no
agent installed at all.

Three more things came out of using it: **you can choose which projects to follow**, the
screen came down to **one line per project**, and the dashboard can sit in the corner of
your screen as **a small window that stays on top**.

And the dashboard no longer looks only at Claude Code. **Codex, opencode, Kilo and Cline**
are there with their real sessions, and **Gemini plus six editor forks** (VS Code/Copilot,
Cursor, Antigravity, Trae, Windsurf, VSCodium) with their folder lists. Every adapter
produces the same `TranscriptFacts` structure and a single state machine decides the
state — that is the only reason six agents are comparable at all. What each adapter can
read and where it stops is written out line by line in `vt doctor`; it never claims the
places it cannot read.

The dashboard never draws the two levels of confidence the same way: `◆` means the state
was **measured** from hook events, `◇` means it was **inferred** from the transcript and
the process tree. The difference matters most when the screen says `WAITING_PERMISSION`.

There are three ways to run it.

**Watch continuously — `vt daemon`:** runs in the background, scans every 3 seconds,
writes state to SQLite and serves a live dashboard at `http://127.0.0.1:47823` (over SSE,
so it updates instantly and you never refresh). Because waiting times persist, it can
answer *"it has been waiting for permission for 41 minutes"* — which a one-shot scan can
never know.

```bash
pnpm vt -- daemon --open
```

**One-shot — `vt status`:** no daemon, no database, no installation. Produces a table or a
self-contained HTML snapshot.

```bash
pnpm vt              # or: node packages/cli/src/index.ts status
```

**Diagnostics — `vt doctor`:** tells you separately what works on this machine, what is
broken, and what is *not written yet*. Confusing those three sends people hunting for a
bug that does not exist, so every line carries its reason.

```bash
pnpm vt -- doctor            # --json for machine-readable
pnpm vt -- hooks install     # exact permission/turn detection (shows a diff, asks first)
pnpm vt -- autostart install # daemon at log on (three platforms, no admin rights)
```

**Setup — `vt init`:** four steps, three questions, **zero disk scanning**. Projects are
read from the session records the agent already writes; the filesystem is never walked.

```bash
vt init                 # --yes to skip the questions with safe defaults
vt config check         # which setting is in effect, which fell back to a default
vt doctor --bundle      # a shareable diagnostics bundle (lists the contents before writing)
vt uninstall            # undo everything and write a manifest of what was done
```

**History — `vt board`:** works out what happened before VibeTracker was installed from
commit subjects. Zero tokens, zero network, one process.

```
  VRTwin 22 commits
    phase 0    ▒▒▒··········································· 4 commits · open
    slice 3    ··················▐▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒▒ 5 commits · 3 commits after it was called done
```

That last line is where the inference earns its keep: **slice 3 was declared complete, and
then three more commits arrived.** The whole board is drawn hatched — the past is coarse
and must not look like today.

**Try it — `vt demo`:** fills the dashboard even with no agent installed at all. The
synthetic environment is built by the same generator CI uses, so it cannot drift into a
prettier version of reality.

```bash
vt demo                 # set up in a temp directory, removed on exit
vt demo --all           # generate the sparse 600 MB transcript too
```

```
VibeTracker · 2026-08-18 00:06 · win32-x64 · windows-powershell (exact)
  50 records → 5 live · 42 dead · 3 PID reuse
  3 projects · 3 sessions waiting on you · 3 IDE windows

WAITING ON YOU
  ⚠ Prime       prime-05·5472       STALLED           8m 41s
  ⏸ AgentWorld  agentworld-43·55408 WAITING_INPUT      9h 8m
```

### Options

| Option | Effect |
|---|---|
| `--html <file>` | Self-contained HTML snapshot (makes no external request) |
| `--json` | Machine-readable report |
| `--all` | Show dead and orphaned sessions too |
| `--temp` | Show temp/scratch working directories too |
| `--quick` | Skip CPU sampling (faster, but "thinking or stalled" gets weaker) |
| `--tail <kb>` | Transcript tail window (256 KB by default) |
| `--signal-waiting` | Exit code 10 when a session is waiting (for a statusline or prompt) |
| `--lang <en\|tr>` | Language for this run (overrides `VT_LANG` and the config) |
| `--bundle [file]` | With `vt doctor`: a shareable diagnostics bundle |

Exit codes: `0` success · `1` at least one doctor check failed · `2` usage error ·
`3` the daemon is already running / is not running · `4` the port belongs to someone else ·
`10` something is waiting (only with `--signal-waiting`) · `70` unexpected error.

---

## The three measurements that shaped the design

**1. A naive liveness count lies.** Checking the PIDs of the 50 entries in the session
registry says "16 live"; the truth was 13. Three entries pointed at PIDs that now belong to
other processes. VibeTracker also compares the process start time the agent recorded, and
reports that case as its own `reused` verdict.

That comparison is made **in a batch**, not one at a time: the start-time format was
observed to change between patch releases of the agent. If *none* of the comparable records
match, that does not mean "every process was recycled", it means "our format assumption is
wrong" — and in that case the sessions count as live and the guard reports itself as
disabled. Otherwise we would show zero while 13 agents were running, which is far worse
than the bug we set out to fix.

**2. Transcripts are never read whole — and if nothing changed, not read at all.** On the
reference machine the largest single file is 518 MB and the total is 1.73 GB. Only a
bounded window at the end is read.

It is worth being honest about the cost of opening one. On that machine, reading a 256 KB
tail from a 518 MB file measured 319 ms cold and 307 ms warm on one occasion (no
difference — that is not a page-cache miss, that is the antivirus scanning on
`CreateFile`), and 2 ms for the same work at another time. It depends on the state of the
scanner's own cache, which means **you cannot know in advance when it will be expensive.**
A persistent handle removes the question entirely.

The real win is somewhere else anyway: the reader is incremental. If `fstat` says the file
has not grown, not one byte is read. In real use the measured rate was **zero I/O on 102 of
134 polls**. When it has grown, only the appended bytes are read and the 256 KB window is
not reparsed from the start — which also makes tool matching *more* accurate: a `tool_use`
seen 40 polls ago is still remembered even after it has fallen out of the window.

**3. Whose turn it is gets answered by the transcript, not by the CPU.** The CPU tells you
*whether work is happening*. If the assistant finished its message and nothing followed,
the ball is with the human — even if the process is burning idle timers. A CPU measurement
only means something *while a turn is in flight*: the agent writes the transcript when a
message completes, so a long thinking turn writes nothing for minutes while burning CPU.
Silence **plus** absence of CPU is a stall.

That has a measurable consequence. Sampling the CPU means **waiting** between two
snapshots, and on an idle poll all of that cost is wasted. Transcripts are now read first
and the sampling only happens when a turn really is in flight. The measured difference:
**an idle scan is 39 ms**, one with a turn in flight is 780–1050 ms (700 ms of which is
deliberate waiting).

---

## Architecture

```
packages/
  shared/    The shared vocabulary: state machine, liveness, tool classes, report types
  core/      Pure logic: state derivation, thresholds, project flags, attention score,
             redaction, JSON editor
             toml.ts   — a hand-written TOML 1.0 reader (no dependency)
             config.ts — schema, defaults, validation; never throws
             i18n.ts   — translation with the source text as the key; a missing
                         translation falls back to a real sentence, not a key id
             i18n-scan.ts — scans the source statically for the keys it asks for
                         (so coverage is measurable)
             phrase.ts — sentences the engine builds but does not write: {key, args}
             dialect.ts — the shapes of files that are not ours (by version range)
             progress/ — the phase engine: language-agnostic folding, role
                         classification, extractors, phase ladder, percentage gates
             summary.ts — one line per project: what is waiting, what is running
                         (computed once in the engine; three interfaces draw the same)
             tracking.ts + tomledit.ts — which projects to follow; config comments survive
             lexicons/ — status/role/phase vocabulary (data, not code)
             locales/  — interface translations (data, not code)
             dialects/ — agent file formats (data, not code)
  platform/  The platform-independent layer
             dirs.ts   — $CLAUDE_CONFIG_DIR / XDG / %APPDATA% discovery (no embedded paths)
             config-file.ts — reading/writing config.toml + the commented starter template
             paths.ts  — NFC normalisation, one folding function, storage classification
             probe/    — the process probe: Windows (persistent PowerShell) · Linux (/proc) ·
                         macOS (ps) · degraded (kill 0); process tree + PID-reuse verdict
             git.ts    — project identity from the root commit
             note.ts + note.ps1 — a frameless always-on-top sticky note
                         (pure ASCII script; every word it shows comes from outside)
             pin.ts    — the browser fallback: an --app window + SetWindowPos
  engine/    tail.ts   — the incremental transcript reader with persistent handles
                         (reading one whole is forbidden at the code level)
             scan.ts   — the four-phase scan; context.ts — the context that keeps the
                         probe, the handles and the caches alive between scans
             progress/ — reading project documents and reconciling them with git, drift
                         backfill.ts — a dated phase timeline from commit subjects
  daemon/    store.ts (node:sqlite + retention policy) · server.ts (node:http + SSE) ·
             security.ts · log.ts · main.ts (single instance, watchdog) ·
             board.ts (inferred history + observed readings, with the seam showing) ·
             public/index.html (the live dashboard)
  fixtures/  A synthetic agent environment: PID reuse, a broken line, an unknown type,
             an NFD path, a sparse 600 MB transcript. Part of the product, not a test helper
  cli/       the vt command: init · status · daemon · open · mini · doctor · config · hooks ·
             autostart · uninstall · board · projects · demo · lang
scripts/
  pack.mjs   The publishable tarball: turns workspace names into relative paths, copies by
             allowlist, fails if an unresolved package name is left behind
```

**The published package is not a build.** There is no build step in development — Node
strips the types and runs the sources directly. npm has no workspace links, so
`scripts/pack.mjs` only rewrites `@vibetracker/x` imports to relative paths and flattens
the directory. The published files are still readable TypeScript: open
`node_modules/vibetracker/src/core/derive.ts` and you are looking at the file from this
repository, comments and all.

**Zero runtime dependencies.** The database is `node:sqlite`, the server is `node:http` —
both inside Node. No native modules, no prebuild matrix, no `node-gyp`. That is not a
convenience, it is a distribution decision: a tool other people will install should not ask
for a compiler.

**No build step.** Node 22 runs TypeScript natively. The code follows the "erasable syntax
only" rule — no `enum`, no `namespace`, no parameter properties, no decorators; `tsconfig`
enforces it with `erasableSyntaxOnly`.

### Dashboard security

Localhost is not a security boundary. If an attacker's page resolves its own domain to
`127.0.0.1`, the browser connects to our port and the socket really does come from
loopback — which is why checking `remoteAddress` alone proves nothing (DNS rebinding). The
layers: loopback socket → `Host` allowlist → `Origin` allowlist → constant-time token. No
CORS header is ever sent. All six scenarios are tested.

### The phase engine — refusing to produce a number is a feature too

The project card now has a line like `Stage 5 · phase 0/4 █████······ 33%`, and under it
**where that came from**: `6/20 items · docs/33_stage5_uygulama_plani.md · yesterday`. The
three visual states never blend into each other — a solid bar is a counted ratio, a hatched
bar plus `~` is an estimate *inferred* from a position in a ladder, and a dashed empty
channel plus `—` is the case where **we refuse to produce a number**, with the reason
beside it.

That refusal is the most important part of the engine. If you see a number on the
dashboard you take it for a measurement; a `100%` derived from a changelog makes you decide
wrongly. `—, because this is a record of work done` is information.

**182 real plan documents shaped the design, not the plan.** Measurement disproved one of
the plan's assumptions: GFM checkboxes (`- [x]`) are almost absent from that corpus — 9 of
182 files, 81 items in total. The actual vocabulary is **symbols**: 1424 ✅, 588 ⚠️, 424 ❌,
356 🔴, 231 🟡. A parser built on checkboxes would have read that corpus as "no progress
information at all".

**Three traps, all three measured:**

1. **A competitor table is not progress.** Of the 992 ✅ in tables, **800 are outside a
   status column** — competitor comparisons, file inventories, audit findings. One file,
   `pazar-ve-firsatlar.md`, carries 272 of them on its own. **No cell counts** unless its
   column header folds to `durum|status|state`; that single condition is the difference
   between reading a market analysis as "an almost finished project" and not.
2. **A fully ticked document is not a finished project.** 10+ items and nothing unfinished
   means this is a "what did we do today" log — it leaves the denominator.
3. **Turkish suffixes invent phases.** Of the 248 phase tokens in headings, 15 are inflected
   *references* like `Faz 0'a`, `Aşama 1'in`, `Stage 2'nin` — "the boundaries of Stage 1"
   does not announce a phase, it talks about one. Those add ghost rungs at the **start** of
   the ladder, which is where they do the most damage.

The same suffix problem was in role classification and cost two real misclassifications:
`envanteri ≠ envanter`, `arşivi ≠ arşiv`. Role words are now matched by stem — anchored at
the start of the word, loose at the end, so `planlama` matches and `explanation` does not.

**The words are data, not code.** Status marks, completion verbs, role hints and phase
names live in `packages/core/lexicons/*.json`. A new language is a PR against a JSON file,
not against the parser.

**How selective is it?** 6 of the 182 documents report a percentage. The rest are
suppressed, with the reason given. That is not too few — it is the right number.

### A ladder belongs to one document; a percentage is the sum of them

The three rules above were right *within* a document, but two things were wrong at project
level, and both were visible on screen.

**Ladders were being merged across documents.** Collect every `Faz N` in a repository into
one array and unrelated feature plans start looking like a single ladder: in a real project
of 72 documents, that produced `Faz 0 / 7` out of a water-module plan with all seven phases
finished and a monitoring plan with none of its seven started — a sentence that was true
neither of a feature nor of the project. Two documents both saying "Faz 1" do not describe
the same rung unless they are the same plan.

A ladder now comes from **one document**, and that document has three requirements: at
least three rungs, at least one finished, at least one unfinished. A ladder with nothing
ticked is a table of contents; one with everything ticked is finished work — in either case
the project's position is somewhere else. A cancelled rung is not progress (that one made
an i18n plan report the whole repository as "one-seventh done"). If two documents define
separate ladders, **no phase is stated** and the reason is written out: taking a side means
deciding a disagreement the reader cannot see.

**The percentage came from a single file** — "the most recently touched countable plan
wins". That tied a 72-document project's percentage to one tick in a sub-feature's
12-item list, and opening any other file changed the number. It is now the **sum of all
countable plans**: it moves when work moves and stays put when you are only reading. Small
lists that fall under the single-document floor are included in the sum — that floor exists
to stop a four-item list speaking for the project **on its own**, not to stop twenty of
them being added up.

And numerator and denominator now come from the same arithmetic. Partial work counted as a
half while the provenance line printed the *count* of finished items: the screen said
`1/12 items · 25%`. Nobody believes arithmetic they cannot check.

### Hooks — the difference between measuring and guessing

The passive layer **infers**: "a tool has been open too long and there is no new child
process". The `PermissionRequest` hook **says so** directly. `vt hooks install` wires up 13
events; `PreToolUse`/`PostToolUse` are **off** by default (they fire on every tool call and
`PostToolUse` carries the entire tool output — `--high-fidelity` turns them on), and
`MessageDisplay` is never wired at all (it fires continuously during streaming).

**The contract was read from the source, not guessed.** Event names and payload fields were
extracted from the installed Claude Code binary (v2.1.206), and the list of valid events
was confirmed against `claude doctor` — an event name you invented is silently ignored,
which means the dashboard looks installed and sees nothing. Three things learned that way:

- The `PermissionRequest` payload has **no `tool_use_id`** (the other tool events do), so
  matching has to be done by tool name.
- The `"_vt": true` marker we add to an entry **is accepted** — unknown *event names* are
  rejected but unknown *fields* are not.
- `settings.json` **does not accept comments**: on seeing a `//` the agent rejects the
  entire file ("Invalid or malformed JSON"). If your file has a comment then none of your
  settings are in effect — `vt hooks` warns about that separately, because otherwise the
  install would look successful.

**How much do we hold the agent up?** An HTTP hook blocks (`async` only exists on command
hooks), so this endpoint's latency lands directly on the user's work. Measured over 200
requests: **p50 0.67 ms · p95 1.33 ms · p99 2.46 ms**. Nothing on the path parses,
touches the database, touches a file or `await`s: validate the token, push to a bounded
ring, return 204. If the buffer fills, **the oldest event is dropped and counted** —
dropping an event breaks the dashboard, holding up the agent breaks the work.

Bodies over 512 KB are discarded but the connection is **not** torn down: the first attempt
used `req.destroy()`, and in measurement that surfaced on the agent's side as "fetch
failed". A hook that errors is worse than a hook that silently drops an event — the user is
trying to work, and our diagnostics are not their problem.

**The rules for touching your settings.** The edit is not `JSON.parse`/`stringify`, it is
text insertion at recorded byte offsets; your indentation, your blank lines and your own
hooks stay exactly as they were. A diff is shown and confirmation asked before writing
(without a TTY, `--yes` is required), a backup is taken, and the write is atomic
(`.vttmp` → rename) — a half-written `settings.json` is not a broken dashboard, it is a
broken agent.

### Autostart (Windows)

`vt autostart install` registers a Scheduled Task. Three things were measured rather than
assumed:

- Of the three logon types, **only `InteractiveToken` can be registered without admin
  rights.** `S4U`, the classic route for a windowless task, is refused with "Access is
  denied".
- So the task runs in the user's own session, and a plain `node.exe` action **opens a
  console window at every log on** (measured: window count 0 → 1). The chain
  `powershell -WindowStyle Hidden` → `Start-Process -WindowStyle Hidden` starts the same
  daemon **with no window at all** (0 → 0). VBScript is not used — you do not tie a product
  feature to a technology Windows is removing.
- Because that launcher spawns the daemon and exits, the task does not stay in a "running"
  state and `RestartOnFailure` would never have fired. So **the trigger itself is the
  supervisor**: it repeats every 5 minutes, and if the daemon is already up the
  single-instance lock takes over and the run ends immediately. That covers not only the
  failures a scheduler notices but *everything* that kills the daemon — including its own
  watchdog.

❌ A Windows Service is not used: services run in session 0 under a service account,
`%USERPROFILE%` resolves to the wrong place, and the tool cannot find the very directory it
needs to read. It would look installed, start cleanly, and observe nothing.

### Redaction

Free text coming from an agent (error messages, notification bodies) goes through redaction
before it reaches the database, the log or the dashboard: provider keys, JWTs, private key
blocks, connection strings, `KEY=value` lines and high-entropy strings become a
`«redacted:type»` placeholder.

This protection was scheduled for M4; it was pulled forward **because a test caught an API
key hidden in an error message** — that key was headed for the report, the dashboard, and
the `--json` output a user pastes into an issue.

Two honest limits: it produces false negatives (it does not know an in-house token format —
which is why it is not the only defence), and it produces false positives (a high-entropy
string can be innocent). Git SHAs and UUIDs are known exceptions, because redacting them
would make every evidence line unreadable.

### Retention

A daemon that runs around the clock needs a disk ceiling, not a hope that "the data stays
small". Transitions go after 90 days, sessions not seen for 90 days are deleted; if the
database exceeds the **hard 500 MB ceiling**, the aggressive window runs immediately
regardless of schedule. Maintenance runs hourly and at startup (at startup, because the
interesting case is a daemon that has been off for a month).

### Platform status

| Platform | Process probe | PID-reuse guard |
|---|---|---|
| Windows | A persistent PowerShell host, one `Get-Process` call | **exact** (FILETIME) |
| Linux | `/proc/<pid>/stat` — no process spawned, the cheapest | **exact** (jiffies) |
| macOS | One `ps -axo` call | **second** — a PID recycled within the same second can slip |
| Other | `kill(pid, 0)` | none |

**Windows** is verified against real data.

**Linux** was run end to end in a container: 323 tests pass, the probe reports itself as
`linux-proc / exact`, `vt demo` splits 10 records in the synthetic environment into 3 live /
5 dead / **2 PID reuse**, the daemon starts, the dashboard returns `200`, `Host: evil.com`
gets `403`, the user's own hook stays in place through an install/uninstall round, and
`vt uninstall` counts the XDG paths correctly. The one thing not verified is whether the
agent writes a process start time on Linux — the code detects that and says the guard is
weakened when it is absent.

**macOS** has still never been run. The code that parses `ps` output and the LaunchAgent
plist are tested against recorded samples, but not one line has run on a Mac. There is also
no signed package: without a Developer ID and notarization, Gatekeeper will not open the
app.

### Autostart: three mechanisms, one rule

| Platform | Mechanism | A crashed daemon |
|---|---|---|
| Windows | Scheduled Task · `InteractiveToken` | a liveness check on a 5-minute trigger |
| macOS | `~/Library/LaunchAgents/dev.vibetracker.daemon.plist` | `KeepAlive`, 30 s |
| Linux | `~/.config/systemd/user/vibetracker.service` | `Restart=on-failure`, 30 s |
| No systemd | `~/.config/autostart/vibetracker.desktop` | does not bring it back, and says so |

What all three have in common is **asking for no administrator rights**. A per-user
observer that wants root has misunderstood what it is; that is why it is a LaunchAgent
rather than a LaunchDaemon, and a `--user` unit rather than a system one. And it is also
why Linux can make a promise the other two cannot.

**`KeepAlive` is not plain `true`.** If it were, the daemon would come back after *every*
exit — including the clean exit of `vt daemon stop`. Stopping it would then be impossible
without also removing the agent. `SuccessfulExit: false` means "only if it exits with an
error", which is exactly what the watchdog's `exit(1)` is, and a deliberate stop is not.

**The systemd unit makes the kernel keep the promise.**

```ini
ProtectHome=read-only
ReadWritePaths=/home/ali/.local/share/vibetracker /home/ali/.config/vibetracker
```

This is the one platform where "it never writes a file into your projects, never writes to
the agent state directory" stops being a claim in a README and becomes **something the
kernel refuses**. The daemon can read all of `$HOME` and write to exactly two directories,
both its own. A bug cannot violate that; neither can a fork that quietly removes the check
from the code. The paths are computed at install time from the same functions the daemon
uses, so an unusual `XDG_DATA_HOME` cannot leave it unable to write its own database.

**`MemoryDenyWriteExecute` is deliberately absent.** It is the first line people add when
hardening a systemd unit, and it quietly breaks V8's JIT: the daemon starts, behaves
strangely, and nothing says why. It is pinned by a test, because the next person to come
and harden this file will reach for it.

**Linger is not enabled, it is reported.** Without it a `--user` unit stops when the last
session ends. Enabling it usually needs a polkit authentication, and a tool that opens an
authentication dialog during an install the user specifically wanted unprivileged is a tool
that gets uninstalled. The installer states the situation and prints the command.

---

## Privacy: not a rule, a single gate

A privacy promise only holds if it goes through one place. "Do not log that" is a
convention, and conventions are kept by whoever remembers them; the person adding the next
line does not. Three places in this round were left to convention and all three leaked.

**The agent's free text is now redacted inside the engine.** `ai-title` is the name the
agent gave the turn, and `last-prompt` is quite literally the prompt you typed. Neither was
redacted anywhere, and the dashboard printed `leadTitle` raw. Redaction now happens in
`tail.ts`, at the single point where the text enters the process — because three surfaces
draw this string, a fourth one will, and the surface that forgets is the one that puts a
key in the window on top of a screen share. The length limit drops to 140 characters there
too: the same string goes to both a 400-pixel line and a database column.

**The log now enforces its own rule.** The comment at the top of `log.ts` said "prompts,
transcript text and file contents are never logged", and the file was written without
redaction. It was already broken in two places, both the same mistake: `String(err)` on a
filesystem error, and agent error text arriving from a hook. Neither is a prompt, and both
can carry one. Redaction now happens inside `log()`, at the single point every line passes
through. The cost is one regex on a few lines per run; the alternative is a guarantee that
holds until the next `log` call.

For the same reason a scan error is redacted before being stored: the `#lastError` string
is served by `/health`, printed by `vt doctor`, and pasted into issues by people.

**And the token does not sit in the address bar.** The only way to hand a browser a
credential is a link, so `vt daemon` prints `?t=<token>`; that part is unavoidable. What is
avoidable is it *staying* there: a query string becomes the window title, a history entry,
a "recently closed" item — and that is how it got noticed, because it is in frame when a
screenshot is taken or a screen is shared. The page already receives the token embedded
from the server, so the query has done its job by the first request; it is removed with
`history.replaceState`. Not `pushState` — the back button taking you to a URL carrying a
token would defeat the whole point.

## What is read, and what is not

Everything read, all of it read-only:

- Under `$CLAUDE_CONFIG_DIR` (or `~/.claude`): `sessions/*.json`, `ide/*.lock`,
  `projects/*/*.jsonl` (bounded windows only)
- `git` commands in project directories — all with `--no-optional-locks`, none of them
  writing
- `package.json` / `Cargo.toml` / `pyproject.toml` (for the project name only)

What is written: the database and `daemon.log` in our own data directory (prompts, code and
transcript text are **never** logged), plus any file you explicitly ask for with
`--html`/`--json`.

**Nothing in the agent state directory is ever deleted or modified.** The transcripts in
there are irreplaceable.

---

## Tests

```bash
pnpm test        # node --test, no external dependency
pnpm typecheck
```

356 tests across eight headings. Five have already paid for themselves:

**Offset continuity.** A growing transcript is read at random chunk boundaries — boundaries
deliberately placed in the middle of UTF-8 sequences and of JSON lines — and the result has
to be **byte-for-byte identical** to reading the finished file in one pass. Alongside it: a
half line is never parsed, a file that shrank through compaction counts as a rewrite, and a
gap over 8 MB is skipped and **reported** rather than read.

**Your file does not get corrupted.** The JSON editor tests preserve comments, blank lines,
tab indentation, escape sequences and trailing commas; a broken file is **rejected, never
overwritten**. After an install/uninstall round the file means exactly what it meant at the
start.

**No secret leaks.** A test caught a fake key in a hook payload leaking into the state we
store — which is why the redaction pipeline was written at that stage. The test now checks
both the stored state and the evidence lines that reach the dashboard.

**It is proven without an agent.** The synthetic environment generator produces real bytes
in CI: it really spawns processes for PID reuse (registry files are named `<pid>.json`, so
one PID means one record — two fake live sessions are impossible), and writes the **real**
start times of those processes into the live entries. With made-up values every comparison
missed and the batch heuristic — correctly — said "the format changed" and switched the
guard off; a fixture that trips its own safety net never tests what it was built for.

The sparse 600 MB transcript takes a few KB on disk (without `fsutil sparse setflag` on
NTFS it really did take 600 MB). It proves the reader seeks rather than scans — a scan
would make the test take minutes.

**The traps do not come back.** The phase engine's golden-file tests are sanitised
reconstructions of real documents: the all-ticked worklog, the competitor matrix, and a
real plan that contains both (that one should be counted, but only from its own status
column). Alongside them: inflected phase references, two phases in one heading, a document
that defines its own legend, and `İPTAL`/`IPTAL`/`ıptal` folding to the same thing.

**Configuration cannot lock you out.** The TOML parser's tests prove two things: a syntax
error does not stop the daemon (it falls back to defaults and names the line), and writing
the `[server]` section twice does **not** merge silently — it errors. The second is the
class of bug where a person spends hours on "I changed the setting and nothing happened".
An unknown key under `[privacy]` is fatal, and a warning everywhere else: a `redcation`
typo must not leave anyone alone with a protection they believe is off.

**The template goes through its own parser.** The example config `vt init` writes is
validated before it is written — a starter file its own parser rejects would look like a
broken install to every new user.

## Translation: the source text is the key

The `t('doctor.node.label')` + catalog design was rejected. An untranslated line shows up
as `doctor.node.label` and becomes unreadable; here the key is the English sentence itself,
so **a missing translation falls back to a real sentence**. Editing the sentence
structurally invalidates the translation — the identity cannot drift away from the text.

Coverage is not a claim, it is a **test**: the source is scanned statically and every key
it asks for must exist in the catalog. A new string that has not been translated breaks the
build and prints the text to translate verbatim.

```bash
VT_I18N_REPORT=missing.json vt --lang tr status   # what the command you ran is missing
```

Sentences the engine produces travel as `{key, args}` (`phrase.ts`). If
`6/20 items · docs/33_plan.md · yesterday` travelled as a finished sentence, every project
would generate its own catalog key and no translator could ever finish the list. The same
structure survives into the HTTP API: a client can format the pieces separately, or turn
the file name into a link.

Two real traps turned up along the way. **Translating the flags broke the risk score** —
`attentionScore` matches on `f.startsWith('dirty-flood')`, so flags are both text and a
logic key; they now travel as identifiers and are translated only where they are displayed.
And moving help text into a table and calling `tr(variable)` made it **invisible to the
static scanner**: the coverage test passed and every line printed in the source language
under `--lang tr`. Nobody notices that a lookup they cannot see is broken.

## Invisible characters are not a style question

Inside `backfill.ts`, one of two map keys had a **raw NUL** where a space should have been.
On screen the two lines were identical, every lookup on the second pass missed, and the
counter it fed stayed silently at zero. Nothing was visible in a diff, in review, or in a
terminal.

There is now a test: no source file may contain a control character or a BOM; where one is
genuinely needed it is written as an escape (`'\u0000'`). The same test caught three raw
ESC bytes in ANSI colour codes on its first run.

## At a glance: one line per project

The detailed card answers *"exactly what is happening"*. That is not the question anybody
asks twenty times a day: **is something waiting for me?** Answering that should not take
four lines per project.

```
  VibeTracker · 6 waiting · 8 live agents · 4 projects

  ⏸ Saspera      4 waiting  —          ███·······   34%   1h 48m
  ⏸ AgentWorld   1 waiting  —          ██████····   55%    8m 10s
  ⏸ VRTwin       1 waiting  —          ███████···   68%    6d 21h
  ▶ VibeTracker  —          1 running  ··········     —

  detail: vt status --full
```

The ordering is a rule, not a preference: **waiting outranks running.** Waiting is the state
that is spending the user's time. Clicking the row on the dashboard opens the whole of the
old card.

**Waiting and running are two separate columns, and both are always written.** It used to
print one dominant state name with `live/total` beside it; that pair read as
`running/total` on screen — which is what people wanted it to say — while it actually meant
"alive/seen". A project with three sessions waiting on the user and one still working said
`3 waiting  5/5` and left the reader to work out where the other two had gone. Waiting and
running are two facts that can be true at once, not alternatives. A zero is not left blank,
it is drawn as `—`: an empty column and a broken render look the same on screen.

The summary logic lives in one place inside `core`, and a test runs the dashboard's
JavaScript inside Node and compares the two sides on the same data. The terminal and the
dashboard showing different numbers for the same project is worse than one of them being
wrong: it destroys trust in both.

### A PID that will not speak has said enough

The guard was missing one case, and the case it missed was the one where recycling is most
likely.

PID 8084 belonged to a Claude Code session in `c:\dev\VRTwin`. Six days later that number
had been taken by `fontdrvhost.exe` — a process running as another user, which **does not
tell us** its start time. The probe returned an empty string, the guard read that as
"nothing to compare" and said `live`. A project that had been closed for six days showed
`1 waiting` on the dashboard.

An unreadable start time is not missing evidence. The agent runs as the user, so its own
process always answers; the silence tells you that PID now belongs to somebody else. The
same batch rule applies here too: silence only counts as evidence when the probe managed to
read **some** start times, so a probe that has lost the ability entirely falls back to
`live` rather than declaring every session dead.

The measured result: 59 records → 51 processes gone, 7 matched, **1 unreadable**. One line
changed, and it was the wrong one.

## Choosing which projects to follow

Following everything is the right default and the wrong permanent state. On a machine that
has been running agents for a month, trial clones, one-afternoon ideas and scratch
directories pile up; a dashboard that shows all of them is a dashboard nobody reads.

```bash
vt projects                 # what exists, what is followed
vt projects add VRTwin      # start following
vt projects rm Prime        # stop following
vt projects all             # back to everything
```

The dashboard has a **choose what to track** button too — both write the same config file,
preserving the same comments, because having to go to a terminal to hide a project while
you are looking at the sticky note defeats the reason that window exists.

One mode, one list. `all` shows everything; `selected` shows only what is on the list.
Removing a project while in `all` mode means **"select the rest"** — the same decision
expressed in one vocabulary. With a second `hidden` list, the moment a name landed in both
they would contradict each other. And the mode change is printed: suppressing the sentence
"only what you picked will be shown from now on" and leaving the user wondering where the
other projects went would be a trap.

The selection filters the **alerts** as well as the list. A waiting agent in a project you
do not follow does not raise the "waiting on you" count — if it did, the selection would
work in the list and not in the notification, and the notification is the part that
actually interrupts you.

An unfollowed project is not deleted from the report: it stays there so `vt projects` has
something to offer, but its plan documents are not read. That is the most expensive work in
the scan; a project you do not follow comes almost free.

## The sticky note: a window in the corner of your screen

A monitor you have to switch windows to read is a monitor you stop reading.

```bash
vt mini                     # a small always-on-top window
vt mini shade               # a single-line strip
vt mini badge               # an 84x84 badge: just the number
vt mini unpin               # close it
```

The `+` on the strip picks which projects to follow; `vt projects add` does the same in the
terminal and "choose what to track" does it on the dashboard, and all three write the same
configuration file. The `♪` on the strip announces transitions into waiting out loud — off
by default, see below.

```bash
vt projects                 # what exists, what is followed
vt projects add VRTwin      # by name
vt projects add c:/dev/Foo  # a directory the agent has never opened
vt projects rm Prime
vt projects all             # drop the selection, back to everything
```

Three sizes, in Winamp's vocabulary: **list**, **strip** (windowshade) and **badge**. Right
click cycles through them anywhere, the space bar does the same, and **clicking the badge
brings the list back**. The whole window is draggable — having to hunt for "the one place
you can grab it" when there is no frame is a design mistake. The three notches in the
bottom right corner set the width; the height follows the number of projects, because empty
space under the last row means "there is more".

**Leaving the badge was a one-way door.** The way out was a double click and it never
worked: the press for dragging is handed to the window manager with `WM_NCLBUTTONDOWN`,
which opens a modal loop inside `DefWindowProc` and swallows the *second* click of the
double click. That left only a right click, which is written nowhere — so the badge was a
state you could enter with the mouse and not leave with it. The badge is now dragged by
hand: the press is recorded, the window moves if there is movement, and if there is not the
release is a click and the list comes back. The two small brackets in the badge's corners
say the same thing — "this is not a picture, it is a folded window".

**Rows are drawn on one measured grid.** Each cell used to be placed relative to the width
of the one before it, row by row; that is not a grid. `3 waiting` and `running` are
different widths, so every row put its numbers somewhere slightly different and the eye had
to find the column again on each line. Now the widest cell in each column is measured at
the start of every paint and all rows are drawn at the same coordinates — every paint,
because the words change with the number and with the language. Vertical alignment works
the same way: three different fonts only sit on one line if each is centred on its own
measured height.

The scale is a grammar too: **solid blocks are a counted number, hollow blocks are an
estimate, and a dashed empty channel is "nobody measured"** — which is a different sentence
from "nothing is finished yet". Drawing all three the same way is how a dashboard lies at a
glance while every number on it is true.

### The row itself: the accent bar, the trail, and the pulse

The row now says four things and three of them are wordless.

**The accent bar on the left edge** carries the row's colour — it is the only thing visible
from the other end of a desk, and most of the value of pinning the window on top is there.
On a waiting project it **breathes**; on one stopped at a permission gate, deeper and red.
"Waiting" is understood without reading a word.

**The trail between the name and the numbers** is the last twenty-four minutes: one dot per
minute, showing the most sessions busy in this project during that minute. The numbers say
what is happening *now*; they cannot tell you whether a project had a busy day or has just
been sitting there, and that is most of what you want to know about the projects that are
not shouting.

The trail's one real claim is about gaps. When the daemon restarts, history resets; drawing
those minutes as zero would invent a floor the project never sat on — a lie the eye reads
instantly and cannot check. So **unobserved minutes are not drawn**, and the dashed channel
the scales use goes there instead. The axis is always twenty-four minutes: a time axis that
shortens to the history you happen to have would make two rows incomparable. A single
observed minute is a line of zero length and is never drawn — so a notch goes there
instead, because "we looked once" and "we never looked" are different sentences.

The series lives in the daemon, not in the window; `vt status` is a one-shot reader, has no
history, and simply **does not have** that field — it is not filled with zeros. In memory,
not on disk: making something half an hour long durable means a schema, a retention rule
and a migration.

**The travelling shimmer on the scale** is the one piece of decoration, and it only travels
across blocks that are *already lit*: it can make a bar look alive, it cannot make it look
long.

The pulse is not free, so it has a condition: **if nothing is waiting and nothing is
running, the window is not painted at all.** A window that burns a core to look alive on top
of your editor is worse than a window that sits still.

### The strip at the top: system load, not an overall percentage

The bar on the strip says **how much of the live sessions are busy** — running in green,
waiting in amber, as two lengths in the same bar. "All running" and "all blocked" are the
same load and opposite situations; one number cannot tell them apart, so the bar has to.

It is deliberately **not** the average of the projects' percentages. Plans are written by
growing, so that average goes *down* while work is being done — the exact error that was
pulled out of per-project percentages over the course of a milestone. With no live session
the bar is dashed and empty and the number is `—`: drawing a gap we did not measure as zero
would be the same lie again.

The arithmetic is in the engine next to the numbers it counts (`summarizeBoard`). The
terminal, the dashboard and the window all print it as it comes.

### Opening a row: what the agent is doing

The `>` on the left opens the row: underneath it says **what the highest-priority session in
that project is doing**. It is the one piece of information with no width in the row, and it
is exactly what a person wants the moment a project turns amber.

That text is the agent's free writing — `ai-title` is the name the agent gave the turn,
`last-prompt` is quite literally what you typed. **Redaction now happens inside the engine,
at the single point the text enters the process**: three surfaces draw this text and a
fourth one will, and the surface that forgets is the one that puts an API key in the window
on top of a screen share. The length is bounded there too (140 characters), because the
same string goes to both a 400-pixel line and a database column.

**Project selection is inside the window.** The `+` button on the strip turns the list into
a picking mode: one row per project, ticked if followed, toggled by clicking, and **saved
at that moment** — there is no room for a dialog box in this window, and no intention of
holding unsaved state. When you are done, the ✓ that replaced `+` returns you to the list.

The candidate list comes from the daemon, not from the dashboard, and that is not a detail:
the dashboard only carries *running* projects, whereas the project you want to add is
usually the one you just closed.

**Where the list comes from.** The session registry is not enough — this machine had 59
records pointing at only 6 projects. The real inventory is in the transcript directory: 30
folders under `projects/`, 23 of them still declaring a path, 11 real projects once
temp/copies are filtered out. The folder name cannot be used — every non-alphanumeric
character of the absolute path has been replaced, it is truncated with a hash appended past
200 characters, and even the letter case is not stable (`c--dev-VibeTracker` sits next to
`C--dev-probros`). So the path is read from the transcript's own `cwd` field: the first
32 KB of one file per folder, stopping at the first line that carries a `cwd`. The newest
transcript is 518 MB; the entire point of this function is to spend a few kilobytes per
project. Measured: 23 projects in 12 ms, and 11 projects in 914 ms including identity
resolution — once per daemon start.

Projects never seen live fall to the bottom with `last_seen_at = 0`; seeding does not touch
the timestamps of existing rows, or every daemon restart would move a project that has been
closed for months to the top of the list.

**A project the agent has never opened.** A repository with no transcript cannot get onto
that list — the path cannot be recovered from the folder name, and trying produces a wrong
path. So the only way is to say so explicitly.

The **`+ choose folder`** row at the top of the picker does that: it opens the system's own
folder dialog and hands the directory you chose to the daemon with
`POST /api/v1/projects/path`. The same thing in the terminal is `vt projects add c:/dev/Foo`.

**The dialog is not `FolderBrowserDialog`.** That .NET Framework class opens the Windows
2000 tree: no address bar, no search, no recent items, and **nowhere to paste the path you
already have** — which is precisely what people actually do. So it is not a style
complaint; the dialog cannot do the job. The window every other application shows is
`IFileOpenDialog` + `FOS_PICKFOLDERS`; it has existed since Vista, .NET Framework never
exposed it, and .NET Core's `AutoUpgradeEnabled` arrived far too late for the runtime that
is already sitting on every Windows machine. So the interface is declared by hand: eighty
lines of interop, **zero dependencies** — the shell is already there.

There is exactly one silent way to get a hand-written COM interface wrong: an interface is
an array of function pointers, and skipping a method you do not call does not remove it, it
**shifts every method after it into the wrong slot**. Since nothing type-checks this file,
the vtable is pinned by a test: `Show` is slot zero, `GetResult` is seventeen, twenty-six in
total.

`FOS_FORCEFILESYSTEM` is deliberate too: without it the shell also returns libraries and
cloud locations, neither of which is a directory a scan can visit.

**The window does not resolve the path, the daemon does.** Identity is a `git rev-list` and
a package-file read; repeating that in the client would be a second implementation of a
rule that must never have two. The window only says which folder you picked, gets back the
project id and name, and writes "added" on the strip. The endpoint is separate from
`tracking` because the error shapes are separate: "no such directory" is 404, "could not
write the configuration" is 500 — conflating them erases the difference between the user
fixing a typo and the user filing a bug.

The path is written as `[projects."<id>"] path` and the scan visits it every time; the
project shows as `off` on the dashboard but its phase and percentage are read. The write
order is deliberate too: path first, then the follow list — the other way round would mean
following a project under an id nothing on this machine can turn into a directory.

**And the window stops staying on top while the dialog is open.** Ownership is not enough:
a dialog owned by this window sits above it in the ordinary z order, but `TopMost` means
`WS_EX_TOPMOST` and that overrides ownership. The picker was opening **behind the note**,
and the note went on swallowing the clicks aimed at it — two projects came silently
unfollowed exactly that way while this was being tested. It is restored in a `finally`; a
note that ends up under your editor is a note that has stopped doing its one job.

**The disk is not scanned** — the plan forbids it explicitly; only the directory you point
at gets in here. The one known rough edge: unfollowing a project does not remove the `path`
line under `[projects]`. It is harmless — the project leaves the dashboard, and git is not
re-probed because the identity is cached — but the configuration is TOML for a human hand
to edit anyway; anyone who wants it tidy deletes a line.

The `tracked` flag comes from the daemon too, rather than being computed by the client: the
answer depends on the follow *mode*, and a client that only sees the dashboard cannot tell
"followed because I picked it" from "followed because everything is". A picker that guesses
that wrong corrupts your selection the moment you touch it.

**And the window sends the change, not the list.** `POST /api/v1/tracking` takes two
shapes: `{mode, selected}` declaring the whole list, and `{add, remove}` declaring one
change. A client with a partial view — a window listing as much as fits in 340 pixels, a
picker cut off at sixty rows — has to use the second: sending the set it can see as the
whole truth silently unfollows every project it did not show. The daemon applies the delta
on top of the current state in the configuration, re-reading the file as it does:
`#tracking` is a copy refreshed on a timer, and two clicks in the same second would both
start from the same stale set and the second would undo the first.

And **a project you picked by hand stays on the list even with no agent running** — showing
`off`. Once picking is an action, the list should be yours rather than the process table's;
a project you added disappearing quietly makes you wonder whether the selection worked at
all. There is no such thing in `all` mode, because there is no selection to honour there:
in that mode the dashboard is "whatever is running" and must stay that way, or every
directory ever opened accumulates forever.

**Why not a browser window.** The first version was Chromium's `--app` mode kept on top,
but it had the browser's own title bar above it. That bar cannot be removed: Chromium draws
it inside the client area itself. Stripping `WS_CAPTION` changed nothing, and reparenting
the window into a frameless form gave a black screen. Both were tried, both were measured.
A 32-pixel browser title above an 84-pixel badge would have been absurd anyway — so the
"shrink to icon size" requirement rules out the browser on its own.

That leaves our own window. WinForms is on every Windows machine already, so having one
**adds no dependency**. Electron and Tauri would give a real window but both would cost the
zero-dependency property; Tauri is its own milestone anyway.

**There is no logic inside the window.** It draws `/api/v1/overview` and nothing else.
Every number on screen — what a project's agents are doing, how far it has got, whether it
is followed — is computed in the engine and printed as it comes. When a rule changes it
changes in one place and the window complies without being edited. A test protects that: if
a state name like `WAITING_PERMISSION` appears in `note.ps1` the test breaks, because at
that moment the window has started making its own decisions.

**Every word it shows comes from outside.** PowerShell 5.1 reads a `.ps1` without a BOM
using the system code page, so a "running" written inside the script comes out mangled on
screen — which is exactly what happened on the first run. Adding a BOM would break the
invisible-character rule, so the rule was inverted: **the script is pure ASCII** and the
words are handed to it at runtime as JSON. A test measures that too.

The second form of the same trap: `ToUpperInvariant()` turned the Turkish "bekliyor" into
"BEKLIYOR" with a dotless I. The heading is no longer upper-cased at all.

**Starting it was not straightforward either.** A PowerShell opened with
`spawn(..., { detached: true })` died before running its first line the moment `vt mini`
finished — because it shared our console. `detached` and `windowsHide` want contradictory
things on Windows. The answer is PowerShell's own `Start-Process -PassThru`: a real
detachment, and the pid that comes back lets the window be closed later.

### Speaking it aloud: a transition, not a state

The window is already "the surface you can look at without switching"; sound is the same
idea for the seconds when you are not looking at the screen at all. The `♪` on the strip
turns it on and the choice lives in `note-window.json`.

The sentence comes from the catalog rather than being assembled in the window: the project
name is followed by `is now waiting for you` — in Turkish, `beklemeye geçti`. The name lands
in the same place in both languages, and a language where it would not can translate around
it. It picks the installed voice that matches the language's culture; failing that it reads
with the system default — which voices are installed is the user's business, not ours.

Three rules keep it from becoming noise, and each addresses a different way of being
annoying:

- **It says the transition, not the state.** A project blocked for an hour is silent; it
  only speaks when the waiting count *goes up*.
- **It says nothing on the first poll.** With nothing to compare against, everything is a
  transition; without this rule the window would read the whole board out on every launch.
- **More than two collapses to a number.** Listening to five project names in a row is
  nobody's idea of a good time.

It is off by default, because a window that starts talking on first run is a window that
gets removed. No speech engine, no voice, a locked device — all three mean the same thing
here: the window goes on being a window and the button switches itself off.

### Making it speak Turkish: pick the right engine, then fall back honestly

The first version used `System.Speech` (SAPI5) — part of .NET Framework, zero dependencies.
The problem is that **what a user does to install Turkish produces a voice that engine
cannot see.** Voices installed through *Settings → Time and language → Speech* are written
under `HKLM\...\Speech_OneCore\Voices\Tokens`; SAPI5 only reads `...\Speech\Voices\Tokens`.
Measured on this machine: **SAPI5 sees two voices, WinRT sees three** — the same two plus
one. That one voice is the proof the difference is not cosmetic.

So the engine changed. `Windows.Media.SpeechSynthesis` is tried first now and SAPI5 remains
the fallback — both for machines where the WinRT projection is missing, and for third-party
voices that only write to the old registry. WinRT is reached through PowerShell's own type
projection (`[Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media,
ContentType = WindowsRuntime]`) rather than from a C# block: that route would need Windows
metadata registered with `Add-Type`, and there is nothing here to compile.

Measured cost: 229 ms to set the engine up (once, lazily), **25 ms** to synthesise a
sentence, 103 ms to start playing. The synthesis is awaited rather than done with
`ContinueWith` — for 25 ms, a continuation block running in its own runspace would cost more
than it saves.

**Which voice?** Windows' default first, if it already speaks the right language: whoever
set that default had a reason, and a language can have more than one voice. Failing that,
the first voice that speaks the language.

**If none of them speak it, the sentence changes language, not the voice.** That is the real
decision of this round. A voice that does not know Turkish does not refuse to read Turkish —
it reads it with English phonetics, and the result is worse than an English sentence read in
the accent it was written for. So the window is given both languages (`speakWaiting` and
`speakWaitingAlt`) and says whichever one the installed voice can pronounce. The interface
stays in its language; only the spoken line moves, and only because there is no voice to
carry it.

The window makes that call, not the CLI: only that side can see the list of installed
voices.

When you turn the `♪` button on, the strip says which voice answered — something like
`Microsoft David - language did not match`. Turning the sound on and hearing the wrong
accent is the one moment a user asks this question. `vt doctor` reports the same thing
permanently, with the counts from both registries:

```
! Spoken alerts  no tr voice — the sentence is read in en by Microsoft David
                 · winrt · WinRT 3 / SAPI5 2 voices
                 → Add a tr voice via Settings → Time and language → Speech.
```

That `WinRT 3 / SAPI5 2` is there on purpose: it is the one number that tells you the voice
you installed is visible to the engine we use and invisible to the one .NET brings.

**We do not download voices.** Which voices are installed is a decision made in Windows; a
monitoring tool downloading a speech package is exactly what it should not do. What we do is
make sure the failure is not silent — because Turkish read by an English voice is
intelligible enough that a user may never notice a matching voice was available.

This is the window's only "decision of its own", and deliberately so. The daemon knows about
the transition too (`store.apply` already produces state changes), but putting the event on
a live payload would mean two clients saying the same thing twice or neither saying it. Sound
is the job of the surface that stays open, and that surface is this window.

Off Windows, `vt mini` falls back to a browser window and says so line by line.

## Other agents: one reader, six agents, one state machine

Codex, opencode, Kilo, Cline, Gemini and the editor forks (VS Code/Copilot, Cursor,
Antigravity, Trae, Windsurf, VSCodium) have joined Claude Code. All of them switch on and
off through `[agents] enabled`; the default is `all`, meaning every agent with a state
directory — somebody who installed Codex and VibeTracker on the same machine did not do it
in order to configure something.

**An adapter's only job is to produce `TranscriptFacts`.** `deriveState` decides the state,
once, for all of them. That is the only reason six agents can share one dashboard: if every
adapter decided its own states, "waiting" would start meaning six different things, the
system-load strip would add up numbers that cannot be compared, and every rule the state
machine has learned (turn ownership beats the CPU; a tool's timeout depends on which tool it
is; believing a transition takes 20 seconds) would be relearned, badly, for each agent.

Identity, workspace grouping, the follow filter, system load and the phase engine all run on
the merged list. "This project has two agents" is not a special case anywhere — it shows up
on the dashboard as `codex + claude-code` and the badge on the row says which is which.

### What could be read, and where it stopped

| Agent | Sessions | Liveness | Turn state | Open tool |
|---|---|---|---|---|
| Claude Code | registry | **pid + start time** | ✅ | ✅ |
| **Codex** | 231 rollout JSONL | last write (no pid) | ✅ | ✅ |
| **opencode / Kilo** | SQLite (66 sessions) | last write (no pid) | ✅ | ✅ |
| **Cline** | session table + log | **pid** | ❌ | ❌ |
| Gemini | — | — | ❌ | ❌ |
| Editors | — | — | ❌ | ❌ |

**Codex has no pid anywhere.** Not in `session_meta`, not anywhere in the file — 400 lines
of the newest rollout were searched. The tempting solution — find a running `codex` process
and read its command line — was rejected: command lines carry API keys, the process probe
deliberately never selects `CommandLine`, and buying liveness with a credential would be a
bad trade in a tool whose only claim is "I do not keep your secrets".

So for those two agents "live" is a **declared window**: it wrote something in the last 90
seconds. A session you closed a minute ago goes on looking live until the end of the window.
That is why confidence is capped at 0.55 — under the dashboard's "not sure" threshold, so it
comes out hatched on screen without needing a second rule — and the evidence line says why:
`liveness:based on last write (no pid, window 1m 30s)`. The width of the window is
`[thresholds] agent_recency_sec`, because it is a confession rather than a fact.

What *can* be read is **turn ownership**, and it is read exactly. In Codex, `task_started`
opens a turn and `task_complete` closes it; `turn_aborted` closes it too, because whether
the work finished or stopped the result is the same: nothing will happen until you do
something. Unfinished `function_call` / `custom_tool_call` records give the open tool via
`call_id`.

### The same discipline, shared rather than copied

Codex's largest rollout file is **778 MB**. The offset discipline applied to Claude Code's
transcripts (a persistent handle per file, `fstat` before reading, an 8 MB catch-up limit, a
carried partial line, never decoding past a line ending) was not written a second time:
`TailReader` was parameterised on its line interpreter. What is shared is not the parsing —
every agent's records are different — but the discipline itself. A second implementation
would be a second set of the same bugs.

Measured: the tail of a 778 MB file in **1–5 ms**, with no growth in RSS.

### Three traps found in real data

**opencode's `session.time_updated` lies.** All 66 sessions carry the same value
(`1787041061504`) — a migration that touched all of them at once. A dashboard built on that
would show the entire history as "active right now". Activity is taken from
`max(message.time_created)` instead, from the thing that actually moves.

**`session.permission` is a policy, not a request.** It is a JSON array like
`[{"permission":"task","action":"deny"}]`. Reading it as "waiting for approval" would have
lit 54 of the 66 sessions red. There is a separate `permission` table and it is empty; when
it fills up, that is the place to look.

**Codex writes `c:\GDEV\x` and `C:\GDEV\x`, and Gemini lower-cases its paths.** Same
repository, different spelling. The git root commit already solved that, but the `path:`
identity did not: `realpath` does not fix letter case on Windows — it returns whatever you
gave it — and hashing its output gave one directory two identities. It showed up on the
dashboard as two rows, `projeadi` and `ProjeAdi`. The folded key is hashed now; `pathKey`
already refuses to fold on Linux, because there two spellings really are two directories.

### Editors give folders, not sessions — and that is deliberate

`workspaceStorage/<hash>/workspace.json` holds a `file://` URI for every window ever opened.
On this machine: Code 59, Antigravity 30, Trae 15, Cursor 10 — **117 folders** in total.
Turning those into dashboard rows would bury the five projects you actually work on under a
hundred you opened once, and every one of those rows would be a session that does not exist.

So they go into the picker instead: "you have worked around here, do you want to follow it".
A folder open in an editor is a real and useful fact. A session is a different claim and none
of these can carry it.

The conversations really are in `state.vscdb` — Cursor keeps `composer.composerData`,
`aiService.generations`, `workbench.panel.composerChatViewPane.<uuid>`. They are readable and
deliberately not read: the keys are undocumented, differ per fork, change without notice, and
are all conversation-text blobs — which is the very thing this tool does not copy. Turn state
obtained that way would be the most fragile and least private data on the dashboard.

The picker's scope depends on that: `vt projects` now also lists a project you only ever
worked on in Codex. Because it is a command you run by hand it can afford the cost — about
200 ms for Codex's 231 rollouts, and 117 `workspace.json` reads for the editors. The poll
loop never does this.

### The gaps, stated honestly

**Cline's session table is empty on this machine.** The schema was read — `pid`,
`started_at`, `ended_at`, `status`, `cwd`, `workspace_root`, `parent_session_id` — and the
reader was written against it, but **it has never been exercised against live rows**. The
capability matrix says `sessions`; if the columns are populated differently in practice, this
is the first place not to trust. What is verified is its fallback: `data/logs/cline.log`
holds one JSON object per line and the pid inside it is handed to the process probe — a run
whose process is gone is reported as gone.

**Kilo is installed but never used.** Its schema is identical to opencode's and the same
reader looks at it too. The distinction mattered here: counting messages cannot tell "never
used" from "the schema changed", and putting a frightening warning in front of somebody who
has simply not run the tool yet is worse than saying nothing. The distinction is now the
session count: sessions but no messages is drift, neither is just unused.

**opencode's `todo` table is not read.** It is the best progress source any agent offers —
machine-verified, `completed/in_progress/pending`. It is *not claimed* as a capability,
because the place that would consume it is the phase engine's provider registry, and
reporting it before that is wired would be a promise rather than a fact.

**If a state directory is found with no agent adapter, `vt doctor` lists it by name.** The
list of agents is open-ended, and silently ignoring one is how a tool starts lying about its
own scope.

---

## The desktop app

A tray icon, a native notification and a daemon supervisor — three things a browser tab
cannot give you. Every number it shows is computed by the engine and the window it opens is
the daemon's own dashboard; the sticky note's rule holds here too: **the engine decides, the
surface draws.** A shell wrapped around a URL would have no reason to exist.

The shell is Tauri 2, and the compiled binary is **4.4 MB**. The Windows installer is
23.5 MB.

### Node ships inside the package — but not compiled into one file

The desktop version exists for the person who does not have Node and should not have to. So
the runtime has to ship with it. The standard way to do that is a single-file executable with
`node:sea`, and that route was abandoned after being looked at.

SEA wants a single CommonJS file, which means a bundler. This repository has no build step
and no bundler, and adding one to produce the desktop output would have meant **what the user
runs being assembled by a toolchain the tests never see** — a second way for the product to
behave differently from what was tested. Since Node runs TypeScript directly anyway, carrying
the sources is both simpler and closer to what is tested.

The size was not going to change either way: `node.exe` is 85.6 MB and the sources are
960 KB. The runtime dominates. NSIS compresses it down to 23.5 MB.

Under Apache-2.0, the sources sitting readable inside the app is a feature rather than a
leak: anyone curious about what the package does can look under `resources/runtime/`.

**There is exactly one transformation, and here is why:** Node does not strip types in any
file under `node_modules` — `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`, and that is a
deliberate policy, not a bug. So the packages cannot be placed where `@vibetracker/core`
would resolve, and that name has to become a relative path. That is the entire difference
between what is tested and what is shipped, and its bounds are known: all 99 cross-package
imports are plain `@vibetracker/<name>` with no subpath, and every dynamic `import()` in the
tree is either `node:` or relative. The staging script verifies it — one unresolved name and
the build stops, because that error would only ever appear on the user's machine, at the
moment they opened the app.

### The icon is drawn in code

`scripts/make-icon.mjs` is a PNG encoder (forty lines using `node:zlib`), an ICO container
and an ICNS one. That is cheaper than adding an image library to a repository that claims to
have no dependencies, and it makes the icon **diffable**: changing the mark is a code review
rather than a binary nobody can see inside.

What it draws is the dashboard itself: three rows, one of them waiting. The question the tool
answers is "is anything waiting for me", and the answer is one row lit while the others are
dim.

### Unsigned, and it says so

The packages are not code signed. Windows SmartScreen will show a warning and macOS
Gatekeeper will refuse to open it outright. It needs a certificate, and a certificate needs an
identity and a paid programme — both the maintainer's decision. It is in the release notes;
it is not something to hide, it is something that is missing.

### Building on three platforms

Tauri does not cross-compile reliably: the package format, the icon container, the webview
binding and the signing story are all per-platform. `.github/workflows/release.yml` builds
each one on its own runner — Windows, macOS (Apple Silicon and Intel), Linux.

That is not a convenience: **it is the only way the macOS and Linux outputs exist and get
exercised at all**, because the machine these lines were written on runs Windows.

---

## What is next

Against the plan document in `~/.claude/plans/`: ~~M1 passive daemon + live dashboard~~,
~~M2 hooks and real "waiting for permission" detection~~, ~~M3 the phase/progress engine~~,
~~M4 productisation~~, **M5 the LLM summary** (the adapter part is done), M6 macOS/Linux,
M7 the desktop shell.

M5's adapter half is closed: Codex, opencode/Kilo and Cline with real reads; Gemini and six
editor forks with folder lists. What remains of M5 is the LLM summary engine, attention
ranking and `vt open` window focusing.

Everything carried over from M3 and M4 is closed:

- **i18n is done.** The whole interface is bilingual; 850+ translations. Coverage is measured
  by a test, and a new string that has not been translated breaks the build. This round the
  gate was extended **to the dashboard too**: `.html` was not being scanned, which made
  "untranslated text breaks the build" true of three surfaces out of four — exactly the kind
  of half-claim this test exists to prevent. Adapter notes also moved from free text into
  code: `tr(detect.note)` is invisible to the static extractor, so a user would get text in
  the wrong language and nothing would break.
- **D1–D6 work.** D4 (the phase says done but the tree is dirty), D5 (the number has been
  flat for weeks while work continues) and D6 (the branch names a rung no plan has) were
  added. D5 needs history so it only fires in the daemon; a one-shot `vt status` stays quiet
  rather than guessing.
- **Backfill and the phase board** are ready: `vt board`, plus a per-card expandable section
  on the dashboard and `/api/v1/board`.
- **The `dialects/` registry** was moved out into a data file; there is version-range
  matching and a drift report with a 5% unknown-line threshold.
- **The synthetic environment generator + the CI matrix** are written: three OSes × two Node
  versions, `alpine` (musl), `tr_TR.UTF-8`, `inotify` starvation, tarball auditing, i18n
  coverage.
- **Project selection, the compact list and the sticky note** were added; `vt daemon stop`
  means the daemon can now be stopped with the tool that installed it.
- **A native window** (`vt mini`): a frameless, always-on-top reading panel in three sizes.
  Zero dependencies — WinForms is already installed.

**The licence is chosen: Apache-2.0.** Two of its clauses that MIT lacks are worth having
here. Clause 5 brings a submitted contribution under the same licence without a separate
agreement. And the explicit patent grant is real protection for a tool that reads other
people's file formats.

For contributions it is **DCO, not a CLA** — a one-line declaration added to a commit with
`-s`. That has a price and `CONTRIBUTING.md` states it plainly: because copyright is not
pooled with the maintainer, the project cannot be relicensed later and cannot be dual
licensed. For an observer tool, the barrier to contribution was judged more expensive than
future commercialisation flexibility.

`NOTICE` goes into the package, because Apache-2.0 §4(d) requires it of anyone
redistributing — and they cannot carry a file we never shipped. It contains the "unofficial
tool" statement and the list of things the product does *not* do; those are guarantees rather
than features, and a fork that removes them should have to do so knowingly.

The `npm publish` block is gone. The CI step was inverted with it: it no longer asks "was
publishing blocked", it asks "does what we ship actually carry the licence it claims". A
package whose metadata says Apache-2.0 with no LICENSE in the tarball is worse than one with
no licence at all.

The one unverified link left from M2: the hooks have not been run **against a real Claude
Code session on my own machine**. The agent itself accepts the settings we write
(`claude doctor` is clean) and the ingest path was tested end to end with real payload
shapes — but the "does the agent actually POST" step requires installing the hooks into your
global settings, and that is your decision.

---

Not affiliated with Anthropic, OpenAI, Google, Microsoft or Cursor.
