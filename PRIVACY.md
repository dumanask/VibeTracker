# Privacy

One page, plain language. The rule: **VibeTracker observes, it does not drive.**

## What it reads

| What | From | Why |
|---|---|---|
| Session records | `<agentDir>/sessions/*.json` | Which agent is really running |
| The **tail** of a transcript | the last 256 KB of `<agentDir>/projects/<slug>/<sid>.jsonl` | Last activity, open tool, title |
| IDE locks | `<agentDir>/ide/*.lock` | Which window belongs to which project |
| The process table | the operating system | pid, ppid, start time, CPU |
| git facts | `git --no-optional-locks …` | branch, dirty count, root commit |
| Plan documents | `docs/`, `plans/`, `*.md` in your project | phase and progress |

`<agentDir>` = `$CLAUDE_CONFIG_DIR`, or `~/.claude` if that is unset.

## What it **never** reads

- `.credentials.json` — that file is never opened.
- Your source code. No project file other than plan documents is read.
- The **command lines** of processes. Command lines carry API keys; pid, ppid and start
  time already answer the question being asked.

## What it **never** writes

- Nothing into your projects' folders. Not one file.
- Nothing into the agent's state directory. Nothing in there is deleted or modified.
- The one exception: the hook entries in `<agentDir>/settings.json`, **with your
  approval**. A diff is shown first, then you are asked, a backup is taken, and every
  entry carries `"_vt": true` so that removing them cannot damage yours.

## What it stores

In its own database (`%LOCALAPPDATA%\VibeTracker` / `~/.local/share/vibetracker`):

- Session and project metadata, state history, counters.
- For transcript text, **pointers only**: file path, offset, length. The text itself is
  never copied — it is read from the file when needed.
- Excerpts of at most 280 characters and event payloads of at most 4 KB; **they go through
  redaction before being written**.

Not stored: transcript text, tool outputs, file contents, prompts.

## Redaction

Every piece of text written to the database or leaving the process goes through a table of
detectors: provider keys (`sk-ant-`, `sk-proj-`, `ghp_`, `AKIA…`, `AIza…`, `xoxb-`), JWTs,
private key blocks, connection strings, `.env` lines, `Bearer`/`Basic` headers and
high-entropy strings of 32 characters or more. The output is a **type-labelled** placeholder
like `«redacted:anthropic_key»`.

**An honest limit:** redaction produces false negatives. It will not catch an in-house token
format. That is why it is not the only defence — the real defence is that nothing is sent
anywhere. You can add your own shapes with `[privacy].custom_patterns`.

## Network

In a default installation VibeTracker **never goes to the network**. The dashboard listens
on `127.0.0.1`; the `Host`/`Origin` allowlist and a token are mandatory, and no CORS header
is ever sent.

Two things can change that, both off by default and both turned on by an explicit decision
of yours:

- Moving `[server].bind` off loopback opens the dashboard to your local network.
- Moving `[digest].provider` off `off` sends a **summary** of your plan documents to the
  provider you chose. The full payload is shown to you before it is sent; the raw plan files
  are never sent.

### The LLM summary — which model, and on whose account

The default is `off`. While it is off, every number on the dashboard is computed by the
local engine and nothing leaves the machine.

If you turn it on, you choose the provider — it is not tied to one vendor:

| `provider` | What it means | Does data leave the machine |
|---|---|---|
| `off` | off (the default) | no |
| `ollama` | the Ollama on your machine | **no** |
| `openai` | the OpenAI *shape*: with `base_url`, OpenAI, OpenRouter, Groq, DeepSeek, Mistral, xAI, Together, LM Studio, vLLM, llama.cpp, Gemini's compatibility endpoint | depends on the address — no if it is loopback |
| `anthropic` | the Anthropic API | yes |
| an agent CLI | `claude-cli`, `codex-cli`, `opencode-cli`, `gemini-cli`, `qwen-cli`, `crush-cli`, `droid-cli`, `goose-cli`, `copilot-cli`, `continue-cli`, `amp-cli`, `aider-cli`, `llm-cli` — that program on your machine, on its own account | yes |
| `cli` | any command you write yourself (your own script, a CLI not on the list) | **unknown** — whatever that command does |

You do not have to guess where it goes: `vt digest providers` and `vt doctor` say so
plainly, and `vt digest` shows a "this text will / will not leave this machine" line before
sending anything.

For `cli` that line says **"unknown"**, and it stays that way. VibeTracker does not look
inside the command you chose; whether it goes to loopback or to the internet is something
only you know. We do not write "does not leave" about something we are not sure of — every
surface treats "unknown" as "it leaves".

**Nothing is ever written on a command line.** The text is handed to the command on
**stdin**, because a command line is readable in the process table by everything on the
machine — including this product's own process probe. If a command does not accept stdin you
can put `{prompt_file}` in its arguments: a temporary file with 0600 permissions is written
and deleted as soon as the run ends. There is deliberately no `{prompt}` placeholder.

**The key is not written into the config file.** `[digest].api_key_env` carries the **name of
the environment variable** that holds the key, not the key itself — because this file gets
backed up, screenshotted and read by `vt doctor --bundle`. If an environment variable is
impractical, `vt digest key <key>` writes one into a 0600 file; that file never enters the
diagnostics bundle.

**The daemon never calls an LLM.** The only thing that does is `vt digest`, which you run by
hand. The result is written to the database and drawn visually apart from a *counted* number
on the dashboard: a hatched bar, a `~` prefix, and which model said it.

## Telemetry

There is none. `[privacy].telemetry` defaults to `false`, and even turned on all it would
collect is the version, the operating system, an adapter count, an error class and an
anonymous installation id. Never: a path, a project name, a prompt, code, a file name.

## The diagnostics bundle

`vt doctor --bundle` produces a file you can attach to a GitHub issue. It collects **by
allowlist** — it never walks a directory. Paths become aliases like `<proj-1>`; only their
*shape* is kept (depth, whether there are non-ASCII characters, whether it is in a cloud
folder). The contents are listed on screen and your approval asked **before** the file is
written.

## Uninstalling

`vt uninstall` checks every place that might have been touched, one at a time, and writes a
manifest of what it did. The agent state directory is not touched.
