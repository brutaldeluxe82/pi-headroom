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
import re
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


def _estimate_tokens(text: str) -> int:
    return len(text) // 4 if text else 0


def _passthrough_result(text: str, *transforms: str) -> dict:
    tokens = _estimate_tokens(text)
    return {
        "compressed_text": text,
        "tokens_before": tokens,
        "tokens_after": tokens,
        "tokens_saved": 0,
        "compression_ratio": 0.0,
        "transforms_applied": list(transforms),
    }


def _looks_like_reference_doc(text: str) -> bool:
    sample = text[:4000]
    markdown_score = 0
    if sample.lstrip().startswith("---\n"):
        markdown_score += 2
    if len(re.findall(r"(?m)^#{1,6}\s", sample)) >= 2:
        markdown_score += 2
    if len(re.findall(r"(?m)^```", sample)) >= 1:
        markdown_score += 2
    if len(re.findall(r"(?m)^\s*[-*]\s", sample)) >= 6:
        markdown_score += 1
    if re.search(r"(?mi)^usage:\s|^commands:\s|^options:\s|^arguments:\s", sample):
        markdown_score += 2
    if len(re.findall(r"(?m)^\s{2,}--?[\w-]+", sample)) >= 5:
        markdown_score += 2
    return markdown_score >= 3


def _parse_json_tool_output(text: str):
    stripped = text.strip()
    if not stripped or stripped[0] not in "[{":
        return None
    try:
        return json.loads(stripped)
    except Exception:
        return None


def _looks_like_search_results(text: str) -> bool:
    matches = re.findall(r"(?m)^[^\s:][^\n]*?:\d+(?::\d+)?:", text)
    return len(matches) >= 5


def _looks_like_logs(text: str) -> bool:
    timestamped = re.findall(
        r"(?m)^\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}.*\b(?:ERROR|WARN|INFO|DEBUG|TRACE|FATAL)\b",
        text,
    )
    bracketed = re.findall(r"(?m)^.*\[(?:ERROR|WARN|INFO|DEBUG|TRACE|FATAL)\].*$", text)
    return len(timestamped) >= 5 or len(bracketed) >= 5


def _compress_json(text: str) -> dict:
    from headroom.config import CCRConfig
    from headroom.transforms.smart_crusher import smart_crush_tool_output

    compressed, _, info = smart_crush_tool_output(
        text,
        ccr_config=CCRConfig(enabled=False, inject_retrieval_marker=False),
    )
    before = _estimate_tokens(text)
    after = _estimate_tokens(compressed)
    return {
        "compressed_text": compressed,
        "tokens_before": before,
        "tokens_after": after,
        "tokens_saved": max(0, before - after),
        "compression_ratio": ((before - after) / before) if before else 0.0,
        "transforms_applied": ["smart_crusher:inline", info],
    }


def _compress_search_results(text: str, context: str = "") -> dict:
    from headroom.transforms.search_compressor import SearchCompressor, SearchCompressorConfig

    result = SearchCompressor(SearchCompressorConfig(enable_ccr=False)).compress(text, context=context)
    before = _estimate_tokens(text)
    after = _estimate_tokens(result.compressed)
    return {
        "compressed_text": result.compressed,
        "tokens_before": before,
        "tokens_after": after,
        "tokens_saved": max(0, before - after),
        "compression_ratio": ((before - after) / before) if before else 0.0,
        "transforms_applied": ["search_compressor:inline"],
    }


def _compress_logs(text: str) -> dict:
    from headroom.transforms.log_compressor import LogCompressor, LogCompressorConfig

    result = LogCompressor(LogCompressorConfig(enable_ccr=False)).compress(text)
    before = _estimate_tokens(text)
    after = _estimate_tokens(result.compressed)
    return {
        "compressed_text": result.compressed,
        "tokens_before": before,
        "tokens_after": after,
        "tokens_saved": max(0, before - after),
        "compression_ratio": ((before - after) / before) if before else 0.0,
        "transforms_applied": ["log_compressor:inline"],
    }


def handle_compress_text(payload: dict) -> dict:
    """Compress a single text block for Pi tool output.

    Pi replaces the visible tool result with whatever this bridge returns, so a
    standalone text compression path must stay inline. We only compress formats
    that Headroom can safely shrink without relying on CCR retrieval markers.
    Everything else is passed through unchanged.
    """
    text = payload.get("text", "")

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

    # Pi does not wire up Headroom's CCR retrieval tool, so auto-compression
    # must stay inline. If we cannot compress a format safely without retrieval,
    # keep the original text instead of returning a lossy truncation marker.
    if _looks_like_reference_doc(text):
        return _passthrough_result(text, "skipped:reference_doc")

    parsed_json = _parse_json_tool_output(text)

    try:
        if isinstance(parsed_json, (list, dict)):
            return _compress_json(text)
        if _looks_like_search_results(text):
            context = payload.get("context", "") if isinstance(payload.get("context"), str) else ""
            return _compress_search_results(text, context=context)
        if _looks_like_logs(text):
            return _compress_logs(text)

        return _passthrough_result(text, "skipped:inline_unsafe")
    except Exception as exc:
        return {
            "compressed_text": text,
            "tokens_before": _estimate_tokens(text),
            "tokens_after": _estimate_tokens(text),
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
