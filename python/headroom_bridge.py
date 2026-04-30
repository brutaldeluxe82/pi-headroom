#!/usr/bin/env python3
"""Bridge between the Pi headroom extension and the Headroom Python library.

Communicates via JSON on stdin/stdout so the TypeScript extension can call
Headroom's compression without needing a Python-native FFI layer.

Actions:
  check              — Verify headroom is installed and return version info.
  compress_text      — Compress a single text string (tool output, etc.).
  compress_messages  — Compress a list of provider-format messages.

Usage:
  echo '{"action":"check"}' | python headroom_bridge.py
  echo '{"action":"compress_text","text":"...","model":"gpt-4o"}' | python headroom_bridge.py
  echo '{"action":"compress_messages","messages":[...],"model":"gpt-4o"}' | python headroom_bridge.py
"""

from __future__ import annotations

import json
import sys
import warnings

# Suppress noisy warnings from optional ML dependencies (transformers, HF Hub)
warnings.filterwarnings("ignore", message="PyTorch was not found")
warnings.filterwarnings("ignore", message="unauthenticated requests")

try:
    import transformers
    transformers.logging.set_verbosity_error()
except ImportError:
    pass


def _try_import_headroom() -> tuple[str | None, str | None]:
    """Return (version_string, error_message)."""
    try:
        from headroom._version import __version__
        return __version__, None
    except ImportError as exc:
        return None, str(exc)


def _check_rust_extension() -> bool:
    """Check if the Rust SmartCrusher extension is available."""
    try:
        from headroom._core import SmartCrusher  # noqa: F401
        return True
    except ImportError:
        return False


def handle_check() -> dict:
    version, error = _try_import_headroom()
    rust_ext = _check_rust_extension() if error is None else False
    return {
        "installed": error is None,
        "version": version,
        "rust_extension": rust_ext,
        "error": error,
    }


def handle_compress_text(payload: dict) -> dict:
    """Compress a single text block using Headroom's full compression pipeline.

    The text is wrapped into a user message and run through SmartCrusher,
    ContentRouter, and the other transforms. Returns compressed text and
    token metrics.
    """
    from headroom import compress

    text = payload.get("text", "")
    model = payload.get("model", "gpt-4o")
    target_ratio = payload.get("target_ratio")
    protect_recent = payload.get("protect_recent", 0)  # Compress everything

    if not text or len(text.strip()) < 100:
        # Too short to benefit from compression
        return {
            "compressed_text": text,
            "tokens_before": 0,
            "tokens_after": 0,
            "tokens_saved": 0,
            "compression_ratio": 0.0,
            "transforms_applied": [],
        }

    # Wrap text into a message list so compress() can process it.
    # compress_user_messages=True ensures the wrapper doesn't get skipped.
    messages = [{"role": "user", "content": text}]

    kwargs: dict = {}
    if target_ratio is not None:
        kwargs["target_ratio"] = target_ratio
    kwargs["protect_recent"] = protect_recent
    kwargs["compress_user_messages"] = True

    try:
        result = compress(messages, model=model, **kwargs)

        # Extract compressed text from the returned messages.
        # Content may be a plain string or Anthropic-style content blocks.
        compressed_text = text
        if result.messages:
            last_msg = result.messages[-1]
            content = last_msg.get("content", text)
            if isinstance(content, str):
                compressed_text = content
            elif isinstance(content, list):
                parts: list[str] = []
                for block in content:
                    if isinstance(block, dict) and block.get("type") == "text":
                        parts.append(block.get("text", ""))
                    elif isinstance(block, str):
                        parts.append(block)
                compressed_text = "\n".join(parts) if parts else text

        return {
            "compressed_text": compressed_text,
            "tokens_before": result.tokens_before,
            "tokens_after": result.tokens_after,
            "tokens_saved": result.tokens_saved,
            "compression_ratio": result.compression_ratio,
            "transforms_applied": result.transforms_applied,
        }
    except Exception as exc:
        return {
            "compressed_text": text,
            "tokens_before": 0,
            "tokens_after": 0,
            "tokens_saved": 0,
            "compression_ratio": 0.0,
            "transforms_applied": [],
            "error": str(exc),
        }


def handle_compress_messages(payload: dict) -> dict:
    """Compress a list of messages in OpenAI or Anthropic format.

    This is the main entry point for full-context compression.
    """
    from headroom import compress

    messages = payload.get("messages", [])
    model = payload.get("model", "gpt-4o")
    target_ratio = payload.get("target_ratio")
    protect_recent = payload.get("protect_recent", 4)
    compress_user_messages = payload.get("compress_user_messages", False)

    if not messages:
        return {
            "messages": [],
            "tokens_before": 0,
            "tokens_after": 0,
            "tokens_saved": 0,
            "compression_ratio": 0.0,
            "transforms_applied": [],
        }

    kwargs: dict = {}
    if target_ratio is not None:
        kwargs["target_ratio"] = target_ratio
    kwargs["protect_recent"] = protect_recent
    kwargs["compress_user_messages"] = compress_user_messages

    try:
        result = compress(messages, model=model, **kwargs)
        return {
            "messages": result.messages,
            "tokens_before": result.tokens_before,
            "tokens_after": result.tokens_after,
            "tokens_saved": result.tokens_saved,
            "compression_ratio": result.compression_ratio,
            "transforms_applied": result.transforms_applied,
        }
    except Exception as exc:
        return {
            "messages": messages,
            "tokens_before": 0,
            "tokens_after": 0,
            "tokens_saved": 0,
            "compression_ratio": 0.0,
            "transforms_applied": [],
            "error": str(exc),
        }


def main() -> None:
    # Read JSON payload from stdin
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError as exc:
        print(json.dumps({"error": f"Invalid JSON input: {exc}"}))
        sys.exit(1)

    action = payload.get("action", "check")

    handlers = {
        "check": handle_check,
        "compress_text": lambda: handle_compress_text(payload),
        "compress_messages": lambda: handle_compress_messages(payload),
    }

    handler = handlers.get(action)
    if handler is None:
        print(json.dumps({"error": f"Unknown action: {action}"}))
        sys.exit(1)

    result = handler()
    print(json.dumps(result))


if __name__ == "__main__":
    main()
