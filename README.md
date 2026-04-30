# pi-headroom

[Headroom AI](https://github.com/chopratejas/headroom) context compression for Pi — automatically compresses tool outputs to save 40–90% of tokens without losing accuracy.

## Install

```bash
pi install git:github.com/brutaldeluxe82/pi-headroom
/reload
```

Headroom auto-installs on first session start (requires `uv` and Python 3.12 on PATH). No manual setup needed.

## What it does

**Auto-compresses** tool results before they reach the LLM context window. Every tool output from `bash`, `read`, `grep`, `mcp_exa_exa_search`, `mcp_context7_*`, and others passes through Headroom's compression pipeline:

- **SmartCrusher** (Rust) — JSON/array → compact CSV
- **ContentRouter** — detect type, route to the right compressor
- **CacheAligner** — stabilize prefix for better provider cache hits
- **Kompress-base** — ML text compression for unstructured content

**Reversible via CCR** — compression is not deletion. The LLM can call `headroom_retrieve` to pull original bytes from any compression marker.

## Registered tools

| Tool | Purpose |
|------|---------|
| `headroom_compress` | Compress text to reduce token count while preserving meaning |
| `headroom_retrieve` | Retrieve original uncompressed content from a CCR hash |
| `headroom_stats` | View cumulative compression statistics for the current session |

## Registered command

`/headroom` — subcommands: `toggle`, `check`, `setup`, `reload`, `clean`, or show stats.

## Configuration

Config file: `.headroom/pi-extension.json` in the workspace directory.

```json
{
  "autoCompress": true,
  "autoInstall": true,
  "minTokensToCompress": 500,
  "minTokensSaved": 50,
  "toolProfiles": {
    "bash": "moderate",
    "read": "conservative",
    "mcp_exa_exa_search": "aggressive"
  }
}
```

### Environment variables

| Variable | Purpose |
|----------|---------|
| `HEADROOM_OPTIMIZE` / `HEADROOM_PI_AUTO_COMPRESS` | Master on/off switch |
| `HEADROOM_PI_AUTO_INSTALL` | Allow or block automatic venv setup |
| `HEADROOM_PI_MIN_TOKENS` / `HEADROOM_MIN_TOKENS` | Global minimum size before auto-compress runs |
| `HEADROOM_PI_MIN_TOKENS_SAVED` | Minimum savings required before replacing tool output |
| `HEADROOM_TOOL_PROFILES` | Per-tool profiles, e.g. `bash:moderate,read:conservative` |
| `HEADROOM_MODE=audit` | Disables auto-compression |

### Tool profile levels

| Level | Behaviour |
|-------|-----------|
| `off` | Never auto-compress that tool |
| `conservative` | Keep more context |
| `moderate` | Default balance |
| `aggressive` | Compress more aggressively |

## Architecture

```
pi-headroom/
├── package.json
├── extensions/
│   └── index.ts          # Pi extension — tool hooks, auto-compress, status bar
├── python/
│   └── headroom_bridge.py  # Long-lived Python process (stdin/stdout JSON bridge)
└── wheels/
    └── headroom_core_py-*.whl  # Bundled Rust SmartCrusher wheel (Linux x86_64)
```

The extension communicates with Python via a JSON bridge over stdin/stdout. It runs as a long-lived helper process so Headroom's in-memory CCR store survives across compression and retrieval calls within the session.

On startup, the extension auto-detects a bundled wheel for the current platform and installs it into a dedicated Python 3.12 venv at `~/.local/share/headroom-venv`.

## Requirements

- **Python 3.12** (required by PyO3 — Python 3.14 is not yet supported)
- **uv** (for venv creation and pip install)

On Linux x86_64, the pre-built Rust SmartCrusher wheel is bundled — no Rust toolchain needed. Headroom runs without the Rust extension (limited to non-SmartCrusher compression).

## Adding platform wheels

To add a wheel for macOS ARM64:

```bash
# On a macOS ARM64 machine with Python 3.12 + maturin:
git clone https://github.com/chopratejas/headroom.git
cd headroom
maturin build -m crates/headroom-py/Cargo.toml --release --interpreter python3.12

# Copy wheel into the package:
cp target/wheels/headroom_core_py-*.whl pi-headroom/wheels/
```

## License

Apache 2.0
