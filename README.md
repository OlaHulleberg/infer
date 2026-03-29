# infer

A tiny, no‑TUI CLI for asking a quick agentic question from your terminal.

> Not a replacement for large agentic CLIs. Use those for workflows, long sessions, and heavy automation. Use `infer` for fast, focused answers with light tool use.

---

## Install

```bash
bun add -g infer-cli @mariozechner/pi-coding-agent
```

To get the latest pi without reinstalling infer:

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
infer -c "Continue from last session"
infer --provider openai --model gpt-4o "Explain this error"
infer config
infer config --source models.dev
echo "What files changed?" | infer
```

## Why use it

- Minimal surface area and zero TUI overhead
- Shows tool actions, then prints the final answer
- Ideal for short, agentic questions in a shell

## How it behaves

**Sessions**
- Default: starts fresh and clears previous sessions
- Continue: `-c` or `-r`
- Storage: `~/.infer/agent/sessions/last.jsonl`

**Bash approval**
Every `bash` tool call asks for approval:
- **Accept**: run once
- **Reject**: block
- **Dangerous Accept All**: run all future bash commands in this process

**Config & auth**
- Config dir: `~/.infer/agent` (override with `INFER_AGENT_DIR`)
- API keys: env vars (e.g. `OPENAI_API_KEY`) or `~/.infer/agent/auth.json`
- Setup: `infer config`

## Flags

| Flag | Description |
| --- | --- |
| `-c`, `--continue`, `-r`, `--resume` | Continue last session |
| `-p`, `--provider <name>` | Model provider |
| `-m`, `--model <id>` | Model id |
| `--thinking <level>` | off \| minimal \| low \| medium \| high \| xhigh |
| `--source <local\|models.dev>` | Model source for `infer config` |
| `-h`, `--help` | Show help |
