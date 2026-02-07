# infer

Minimal, no-TUI CLI that runs a Pi agent prompt and prints tool actions then the final answer.

## Install

```bash
bun install
```

Link the command locally:

```bash
bun link
```

## Usage

```bash
infer "Summarize this repo"
infer -c "Continue from last session"
infer --provider openai --model gpt-4o "Explain this error"
infer config
infer config --source models.dev
echo "What files changed?" | infer
```

Output example:

```
Read README.md
Ran ls -la

<assistant response>
```

## Sessions

- Default: always starts a new session and deletes the previous one.
- Continue: use `-c` or `-r` to reuse the last session.
- Storage: `~/.infer/agent/sessions/last.jsonl`

## Config & Auth

- Config dir: `~/.infer/agent`
- Override: set `INFER_AGENT_DIR`
- API keys: use environment variables (e.g. `OPENAI_API_KEY`) or `~/.infer/agent/auth.json`
- Interactive setup: run `infer config`

## Flags

- `-c`, `--continue`, `-r`, `--resume`: continue last session
- `-p`, `--provider <name>`: model provider
- `-m`, `--model <id>`: model id
- `--thinking <level>`: off|minimal|low|medium|high|xhigh
- `--source <local|models.dev>`: model source for `infer config`
- `-h`, `--help`: show help
