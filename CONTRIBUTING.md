# Contributing

English is the source language; Turkish is a translation. Issues and PRs are welcome in
either language.

---

## Licence and contribution rights

The project is **Apache-2.0**. You do not need to sign a separate agreement to contribute:
clause 5 of the licence already says that, unless you state otherwise, what you submit is
under the terms of that licence. That clause does not exist in MIT and is one of the reasons
Apache was chosen here.

On top of it, a **DCO** (Developer Certificate of Origin) is asked for, not a CLA. The
difference matters: a CLA is a legal document asking a contributor to assign copyright or
grant a broad licence, and getting one signed is a barrier. A DCO is a one-line declaration
added to a commit — it says "I have the right to submit this code".

```
git commit -s -m "codex: stop reading mcp tool calls"
```

`-s` adds this line:

```
Signed-off-by: Your Name <you@example.com>
```

The full text: <https://developercertificate.org/>

> **A limit accepted deliberately.** With a DCO, contributors do not pool their copyright
> with the maintainer. That means the project **cannot be relicensed** later and cannot be
> dual licensed (open core plus a commercial edition) — that would need each contributor's
> individual permission. This is the price of not asking for a CLA, and it is paid
> knowingly: for an observer tool, the barrier to contribution is more expensive than future
> commercialisation flexibility.

---

## Getting set up

```bash
pnpm install          # one dependency tree; no runtime dependencies
pnpm typecheck
pnpm test
node packages/cli/src/index.ts demo    # works even on a machine with no agent installed
```

Node **22.20+** is required: the TypeScript sources are run directly (there is no build
step) and `node:sqlite` is used without a flag.

Because there is no build step, the code has to be **"erasable syntax only"**: no `enum`, no
`namespace`, no parameter properties, no decorators. `tsconfig` enforces it with
`erasableSyntaxOnly`, so if you forget, typecheck breaks.

---

## What is code and what is data

That distinction is the backbone of the project. Putting something on the wrong side is the
one structural mistake that will not be accepted.

| Directory | Contents | Why it is data |
|---|---|---|
| `packages/core/dialects/` | The agents' file formats | The format is not ours. When an agent release renames a field, that should be a JSON patch, not a code release. |
| `packages/core/lexicons/` | Status words, document role hints, question markers | Parsing has to be language-agnostic. Supporting a new language must not require changing code. |
| `packages/core/locales/` | Interface translations | A translation fix should not have to wait for a release. |

**Adding a new language** means `lexicons/<code>.json` + `locales/<code>.json`, without
touching TypeScript.

---

## Adding a new agent

An adapter under `packages/engine/src/agents/`. The contract is in `types.ts` and it has one
job: turn whatever the agent writes to disk into **`TranscriptFacts`**.

The adapter does not decide the state. `deriveState` does — once, for all of them. That is
the only reason six agents can share one dashboard: if every adapter decided its own states,
"waiting" would start meaning six different things.

**What an adapter may not do:**

- **Write anything.** Not into the agent state directory, not into a project. Files are
  opened read-only and SQLite with `readOnly: true` — no lock is ever taken from a running
  agent, and a corrupted page can never be our fault.
- **Copy free text.** Titles and prompts go through `redactSnippet` at the single point they
  enter the process. Message bodies, tool inputs and tool outputs are never read at all —
  queries name the columns they read and the text columns are not among them.
- **Claim what it cannot see.** `capabilities` is an honest answer and `vt doctor` prints it.
  An adapter that cannot tell a live session from a finished one says so; the dashboard then
  draws that row with low confidence and writes the reason.
- **Read a command line.** They carry API keys. The process probe deliberately never selects
  `CommandLine`, and that is not negotiable.

What has to come with an adapter: `packages/core/dialects/<agent>.json` (with the observed
version written in `appliesTo`), and tests in `packages/engine/test/agents.test.ts` using
fixtures built from real shapes.

Read the format from **real files**, not from a single session. One conversation only shows
the tools that happened to be used at the time; a dialect derived from it breaks on the
second file.

---

## Adding a progress provider

`ProgressProvider` (plan §F.2). Personal conventions do not get embedded in the code, they
become providers.

There is one rule here: **classify the document's role before counting anything.** Two traps
have been measured in real repositories and both stand as golden-file tests:

1. A "what did we do today" log with 100 ticked and 0 unticked. A naive counter says "100%
   done".
2. The ✅ in a competitor comparison table. Those mark a competitor's feature, not your
   progress.

If you cannot produce a number, **do not produce one.** "—, this is a changelog" is a useful
answer; an invented 45% is not.

---

## Test discipline

Do not open a PR until `pnpm test` is green. Four gates matter particularly:

- **i18n coverage.** The source text itself is the translation key. A new English string
  breaks the build until it lands in `locales/tr.json` — both `.ts` and `.html` are scanned.
- **Source hygiene.** No invisible control characters, no BOM, and `.ps1` files must be pure
  ASCII (PowerShell 5.1 reads a script with no BOM using the system code page and mangles
  anything outside it).
- **Golden-file parser tests.** The two traps above.
- **Locale tests** run under `tr-TR` — the dotted/dotless I trap.

To write tests on a machine with no agent installed there is the synthetic environment
generator in `packages/fixtures`; the whole of CI runs on it.

---

## What will not be accepted

These are the definition of the product, not preferences:

- **Driving the agent.** VibeTracker observes. Approving permissions remotely, sending
  commands, starting sessions — all out of scope, permanently. Taking write authority breaks
  the trust model and turns prompt injection into a catastrophe.
- **Scanning the disk.** Project discovery happens only from the `cwd` records the agents
  already write and from directories you point at by hand.
- **An invented number.** An unknown percentage is drawn as `—`, with its reason.
- **Failing silently.** If a capability does not work, the dashboard says so **and why**:
  "you did not install the hooks" and "a platform limit" are different problems.

---

## Commits and PRs

- Let the commit message say what you did, not which file you touched.
- Sign off with `-s` (DCO).
- Every PR that changes behaviour brings a test.
- If you measured something, write the number. Most comments in this repository record a
  measurement ("the tail of a 778 MB file in 1–5 ms"), because the next person can only
  reconsider that decision with the number in front of them.

---

## Security vulnerabilities

Do not open an issue. Use the channel in `SECURITY.md`.
