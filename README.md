# infer

A tiny, no‑TUI CLI for asking a quick agentic question from your terminal.

> Not a replacement for large agentic CLIs. Use those for workflows, long sessions, and heavy automation. Use `infer` for fast, focused answers with light tool use.

---

## Install

```bash
bun add -g @olahulleberg/infer @mariozechner/pi-coding-agent
```

To update pi independently (new models, fixes) without touching infer:

```bash
bun add -g @mariozechner/pi-coding-agent
```

**Local dev:**

```bash
bun install
bun link
```

## Quick start

```bash
infer "Summarize this repo"
infer -c "What did we just change?"
infer --provider openai --model gpt-4o "Explain this error"
echo "What files changed?" | infer
```

## Auth

**API key** — set an environment variable or store it via `infer config`:

```bash
export ANTHROPIC_API_KEY=sk-...
export OPENAI_API_KEY=sk-...
```

**OAuth** — for providers that use browser login (Claude Pro/Max, ChatGPT Plus/Pro, GitHub Copilot, Gemini):

```bash
infer login              # pick a provider interactively
infer login openai-codex
infer login github-copilot
infer login google-gemini-cli
```

## Config

```bash
infer config
```

Interactive setup: pick a provider and model, set a default thinking level, optionally store an API key, and optionally configure a **classifier model**.

## Bash approval

Every `bash` tool call requires approval before it runs:

```
! grep -r "TODO" src/
> Accept
  Reject
  Dangerous Accept All
```

- **Accept** — run once
- **Reject** — block this command
- **Dangerous Accept All** — skip approval for all remaining commands in this session

## Classifier

When a classifier model is configured (via `infer config`), read-only commands are auto-approved silently. Only commands with side effects prompt for approval.

```
✓ Search TODO in src/
```

vs.

```
! Delete build artifacts
> Accept  Reject  Dangerous Accept All
```

The classifier uses the model you configure — no separate API key needed. If it fails for any reason, it falls back to the standard approval prompt.

To set it up: run `infer config` and answer yes to the classifier prompt at the end.

## Sandbox

When a classifier is configured, auto-approved commands run inside a sandbox that makes the filesystem read-only. The command can read anything but cannot write, delete, or modify files.

**Linux:** requires [`bwrap`](https://github.com/containers/bubblewrap) (`sudo apt install bubblewrap` / `sudo pacman -S bubblewrap`)

**macOS:** uses `sandbox-exec`, which is built-in.

If the classifier is configured but no sandbox is detected, infer warns at startup and falls back to running auto-approved commands without isolation.

## Sessions

- Default: fresh session, clears previous
- Continue: `-c`, `-r`, `--continue`, `--resume`
- Storage: `~/.infer/agent/sessions/last.jsonl`

## Flags

| Flag | Description |
| --- | --- |
| `-c`, `--continue`, `-r`, `--resume` | Continue last session |
| `-p`, `--provider <name>` | Model provider |
| `-m`, `--model <id>` | Model id |
| `--thinking <level>` | off \| minimal \| low \| medium \| high \| xhigh |
| `-h`, `--help` | Show help |
| `-v`, `--version` | Show version |

## Config dir

`~/.infer/agent` — override with `INFER_AGENT_DIR`.

Contains `settings.json`, `auth.json`, `classifier.json`, and `sessions/`.
