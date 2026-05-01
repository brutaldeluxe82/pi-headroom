# pi-headroom

[Headroom AI](https://github.com/chopratejas/headroom) context compression for Pi — automatically compresses messages to save 40–90% of tokens without losing accuracy.

## How it works

Uses Pi's `context` event hook to compress the **full message list** before each LLM call — the same architecture as `headroom wrap` and the Headroom proxy. This gives you Headroom's complete safety pipeline:

- **DEFAULT_EXCLUDE_TOOLS** — Read, Write, Edit, Grep are never compressed (exact text needed for edits)
- **ReadLifecycle** — Stale/superseded reads are safely compressed; fresh reads are untouched
- **protect_recent_code** — Recent code messages are protected from compression
- **protect_analysis_context** — Code in analysis/review context is never compressed
- **CCR (Compress-Cache-Rettrieve)** — Compression is reversible; original content can always be retrieved

Bash/tool outputs (logs, search results, etc.) are compressed automatically. Code from `read` passes through untouched so the `edit` tool always works with exact text.

## Install

```bash
pi install git:github.com/brutaldeluxe82/pi-headroom
/reload
```

Headroom auto-installs on first session start. Requires `uv` and Python 3.12 on PATH.

## Tools provided

| Tool | Description |
|------|-------------|
| `headroom_compress` | Compress any text on demand (for manually reducing large outputs) |
| `headroom_retrieve` | Retrieve original uncompressed content from CCR compression markers |
| `headroom_stats` | View cumulative compression statistics for the session |

## Commands

| Command | Description |
|---------|-------------|
| `/headroom` | Show stats |
| `/headroom toggle` | Toggle auto-compression on/off |
| `/headroom check` | Check Headroom installation status |
| `/headroom setup` | Manually install/set up Headroom |
| `/headroom reload` | Reload config from disk |
| `/headroom clean` | Remove Headroom venv |

## Configuration

Place a `.headroom/pi-extension.json` in any of these locations (checked in order):

1. `HEADROOM_WORKSPACE_DIR/.headroom/pi-extension.json` — explicit override
2. `{cwd}/.headroom/pi-extension.json` — project-level
3. Pi agent config dir (e.g. `~/.config/pi/.headroom/pi-extension.json`) — global fallback

```json
{
  "autoCompress": true,
  "autoInstall": true,
  "minTokensToCompress": 4000
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `autoCompress` | `true` | Enable message-level compression |
| `autoInstall` | `true` | Auto-install headroom-ai on first session |
| `minTokensToCompress` | `4000` | Minimum estimated tokens before compression fires. Raise this in short sessions to avoid pointless cache misses; lower it if you hit context limits early. |

### Environment variables

| Variable | Description |
|----------|-------------|
| `HEADROOM_OPTIMIZE` / `HEADROOM_PI_AUTO_COMPRESS` | Master on/off switch |
| `HEADROOM_PI_AUTO_INSTALL` | Allow or block automatic venv setup |
| `HEADROOM_PI_MIN_TOKENS` / `HEADROOM_MIN_TOKENS` | Minimum tokens before compression |
| `HEADROOM_WORKSPACE_DIR` | Override config file search path |
| `HEADROOM_MODE=audit` | Disables auto-compression (observe only) |

## Architecture

```
Pi AgentSession
  │ context event (before each LLM call)
  │ AgentMessage[] — Pi's internal format
  ▼
pi-headroom extension
  │ piMessagesToHeadroom() — convert to Anthropic format
  │ callBridge("compress_messages") — full Headroom pipeline
  │   ├── DEFAULT_EXCLUDE_TOOLS (Read/Write/Edit → skip)
  │   ├── ReadLifecycle (stale/superseded → safe compress)
  │   ├── protect_recent_code (recent code → skip)
  │   ├── ContentRouter (AST-aware routing)
  │   ├── SmartCrusher (JSON/array compression)
  │   ├── Kompress-base (ML text compression)
  │   └── CCR (cache originals for retrieval)
  │ applyCompressedMessages() — patch back to Pi format
  ▼
Compressed AgentMessage[] → Pi → LLM
```

The extension communicates with Python via a JSONL bridge (`headroom_bridge.py`) running as a long-lived child process. CCR state survives across calls within the session.

## Requirements

- **Python 3.12** (required by PyO3 — Python 3.14 is not yet supported)
- **uv** (for venv creation and pip install)

On Linux x86_64, a pre-built Rust SmartCrusher wheel is bundled — no Rust toolchain needed. On other platforms, Headroom runs without the Rust extension (still works, just without the fast SmartCrusher).

## Building Rust wheels for other platforms

```bash
# On a macOS ARM64 machine with Python 3.12 + maturin:
git clone https://github.com/chopratejas/headroom.git
cd headroom
maturin build -m crates/headroom-py/Cargo.toml --release --interpreter python3.12
cp target/wheels/headroom_core_py-*.whl pi-headroom/wheels/
```

## License

Apache 2.0
