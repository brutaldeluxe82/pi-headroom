# Pi Package: Headroom

Context compression for LLM agents — integrates [Headroom AI](https://github.com/chopratejas/headroom) with Pi.

## One-Command Install

```bash
pi install git:github.com/brutaldeluxe82/pi-headroom
/reload
```

Headroom auto-installs on first session start. No manual setup needed (requires `uv` and Python 3.12+ on PATH).

## What It Does

- **Auto-compresses** large structured tool results (logs, grep/search output, JSON arrays) without replacing them with CCR retrieval markers
- **`headroom_compress` tool** — LLM can compress any text on demand
- **`headroom_stats` tool** — view cumulative compression statistics
- **`/headroom` command** — toggle, check, setup, clean, or show stats
- **Status bar** — shows tokens saved in footer

## Commands

| Command | Description |
|---------|-------------|
| `/headroom` | Show quick stats |
| `/headroom toggle` | Toggle auto-compression on/off |
| `/headroom check` | Verify installation status |
| `/headroom setup` | Re-run installation |
| `/headroom clean` | Remove the headroom venv |

## How It Works

```
User prompt → Pi agent → Tool call (bash, read, grep...)
                              │
                              ▼
                        tool_result event
                              │
                   ┌──────────┴──────────┐
                   │  Is result >1500     │
                   │  chars & not error?  │
                   └──────────┬──────────┘
                              │ Yes
                              ▼
              Python bridge → headroom.compress()
                              │
                              ▼
                  SmartCrusher (Rust) ─ JSON/array → compact CSV
                  ContentRouter        ─ detect type, route
                  CacheAligner         ─ stabilize prefix
                  Kompress-base        ─ ML text compression
                              │
                              ▼
                  Compressed result → back to LLM context
                              │
                              ▼
              Status bar: "↓ 3.8K tok saved (44%)"
```

## Requirements

- **Python 3.12** (required by PyO3 — Python 3.14 is not yet supported)
- **uv** (for venv creation and pip install)
- **Bundled wheel** for Linux x86_64 (macOS wheels: build from source or contribute!)

On Linux x86_64, the pre-built Rust SmartCrusher wheel is bundled — no Rust toolchain needed.
On other platforms, Headroom runs without the Rust extension (limited to non-SmartCrusher compression).

## Adding Platform Wheels

To add a wheel for macOS ARM64:

```bash
# On a macOS ARM64 machine with Python 3.12 + maturin:
git clone https://github.com/chopratejas/headroom.git
cd headroom
maturin build -m crates/headroom-py/Cargo.toml --release --interpreter python3.12

# Copy the wheel to the package:
cp target/wheels/headroom_core_py-*.whl pi-headroom/wheels/

# Commit and push
```

## Architecture

```
pi-headroom/
├── package.json          # Pi package manifest
├── extensions/
│   └── index.ts          # Pi extension (hooks, tools, commands)
├── python/
│   └── headroom_bridge.py # JSON stdin/stdout bridge to Python
└── wheels/
    └── headroom_core_py-0.1.0-cp312-cp312-manylinux_2_38_x86_64.whl
```

The extension communicates with Python via a JSON bridge (stdin/stdout). It auto-detects the bundled wheel for the current platform and installs it into a dedicated Python 3.12 venv at `~/.local/share/headroom-venv`.

For Pi specifically, the bridge only auto-compresses formats that can be shrunk inline. Reference docs, markdown help text, and other content that would otherwise collapse into retrieval markers or lossy truncation are passed through unchanged.

## License

Apache 2.0 — Headroom is Apache 2.0, this package follows suit.
