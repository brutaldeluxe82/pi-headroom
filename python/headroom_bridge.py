#!/usr/bin/env python3
"""Bridge between the Pi headroom extension and the Headroom Python library.

Supports two modes:
- one-shot JSON on stdin/stdout (default)
- long-lived JSONL server mode (`--server`) so CCR state survives across calls

Actions:
  check              — Verify headroom is installed and return version info.
  compress_text      — Compress a single text block using native ContentRouter.
  compress_messages  — Compress a list of provider-format messages.
  retrieve           — Retrieve CCR content by hash.
"""

from __future__ import annotations

import json
import os
import re
import sys
import warnings
from typing import Any

# Suppress noisy warnings from optional ML dependencies (transformers, HF Hub).
# transformers uses its own logger.warning_advice() for the PyTorch message,
# which ignores Python's warnings module — controlled via env var instead.
os.environ.setdefault("TRANSFORMERS_NO_ADVISORY_WARNINGS", "1")

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


def _estimate_tokens(text: str) -> int:
    return len(text) // 4 if text else 0


def _passthrough_result(text: str, *transforms: str) -> dict[str, Any]:
    tokens = _estimate_tokens(text)
    return {
        "compressed_text": text,
        "tokens_before": tokens,
        "tokens_after": tokens,
        "tokens_saved": 0,
        "compression_ratio": 0.0,
        "transforms_applied": list(transforms),
    }


def _resolve_profile(tool_name: str, level_override: str | None):
    from headroom.config import DEFAULT_TOOL_PROFILES, PROFILE_PRESETS

    if level_override:
        level = level_override.strip().lower()
        if level == "off":
            return None, "off"
        if level in PROFILE_PRESETS:
            return PROFILE_PRESETS[level], level

    if tool_name in DEFAULT_TOOL_PROFILES:
        return DEFAULT_TOOL_PROFILES[tool_name], "default"
    lowered = tool_name.lower()
    if lowered in DEFAULT_TOOL_PROFILES:
        return DEFAULT_TOOL_PROFILES[lowered], "default"

    return PROFILE_PRESETS["moderate"], "moderate"


def handle_check() -> dict[str, Any]:
    version, error = _try_import_headroom()
    rust_ext = _check_rust_extension() if error is None else False
    return {
        "installed": error is None,
        "version": version,
        "rust_extension": rust_ext,
        "error": error,
    }


def handle_check_environment() -> dict[str, Any]:
    """Check the runtime environment and return actionable warnings.

    Called by the extension on session_start to surface configuration
    issues to the user rather than silently masking them.
    """
    warnings: list[dict[str, str]] = []

    # Check 1: HF_TOKEN not set
    hf_token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")
    if not hf_token:
        hf_cache = os.environ.get(
            "HF_HOME", os.path.join(os.path.expanduser("~"), ".cache", "huggingface")
        )
        kompress_cached = os.path.isdir(
            os.path.join(hf_cache, "hub", "models--chopratejas--kompress-base")
        )
        if kompress_cached:
            warnings.append({
                "id": "hf_token_missing_cached",
                "level": "info",
                "message": (
                    "HF_TOKEN not set. Kompress model is cached, but Hugging Face Hub "
                    "is contacted each session to check for updates (without auth, "
                    "you get lower rate limits). Set HF_TOKEN or export "
                    "HF_HUB_OFFLINE=1 to skip API calls entirely."
                ),
            })
        else:
            warnings.append({
                "id": "hf_token_missing_uncached",
                "level": "warning",
                "message": (
                    "HF_TOKEN not set. Kompress model must be downloaded on first use "
                    "— without auth, downloads may be rate-limited. Set HF_TOKEN "
                    "for reliable access."
                ),
            })

    # Check 2: PyTorch not available (kompress uses ONNX Runtime instead)
    try:
        import torch  # noqa: F401
    except ImportError:
        try:
            import onnxruntime  # noqa: F401
        except ImportError:
            warnings.append({
                "id": "no_ml_backend",
                "level": "warning",
                "message": (
                    "Neither PyTorch nor ONNX Runtime found. Kompress ML compression "
                    "is unavailable. Install headroom-ai[proxy] for ONNX Runtime, "
                    "or set HF_HUB_OFFLINE=1 to suppress API calls."
                ),
            })

    return {"warnings": warnings}


def _strip_ccr_marker(text: str) -> str:
    return re.sub(r"\s*\[[^\]]*compressed to[^\]]*hash=[a-f0-9]{24}\]", "", text).strip()


def handle_compress_text(payload: dict[str, Any]) -> dict[str, Any]:
    """Compress a single text block using native Headroom content routing.

    This keeps the wrapper thin: we hand content to Headroom's ContentRouter,
    use Headroom's native per-tool profile levels for bias, and optionally leave
    CCR enabled so Pi can retrieve the original later.
    """
    from headroom.transforms.content_router import ContentRouter, ContentRouterConfig

    text = payload.get("text", "")
    tool_name = str(payload.get("tool_name", ""))
    context = payload.get("context", "") if isinstance(payload.get("context"), str) else ""
    ccr_enabled = bool(payload.get("ccr_enabled", True))
    tool_profile_level = payload.get("tool_profile_level")

    if not text or len(text.strip()) < 100:
        return _passthrough_result(text, "skipped:short")

    profile, profile_source = _resolve_profile(tool_name, tool_profile_level)
    if profile is None:
        return _passthrough_result(text, "skipped:profile_off")

    try:
        router = ContentRouter(
            ContentRouterConfig(
                ccr_enabled=ccr_enabled,
                ccr_inject_marker=ccr_enabled,
            )
        )
        result = router.compress(text, context=context, bias=profile.bias)
        compressed_text = result.compressed if ccr_enabled else _strip_ccr_marker(result.compressed)
        tokens_after = result.total_compressed_tokens if ccr_enabled else _estimate_tokens(compressed_text)
        transforms = [
            f"content_router:{result.strategy_used.value}",
            f"profile:{profile_source}",
        ]
        if not ccr_enabled:
            transforms.append("ccr:disabled")
        return {
            "compressed_text": compressed_text,
            "tokens_before": result.total_original_tokens,
            "tokens_after": tokens_after,
            "tokens_saved": max(0, result.total_original_tokens - tokens_after),
            "compression_ratio": ((result.total_original_tokens - tokens_after) / result.total_original_tokens) if result.total_original_tokens else 0.0,
            "transforms_applied": transforms,
        }
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


def handle_compress_messages(payload: dict[str, Any]) -> dict[str, Any]:
    """Compress a list of messages in Anthropic format using ContentRouter.

    Uses ContentRouter.apply() directly so we can override exclude_tools
    with a Pi-specific list. The upstream DEFAULT_EXCLUDE_TOOLS includes
    bash/grep/glob (designed for Claude Code), but for Pi those are
    great compression targets — only read/write/edit must be excluded
    to preserve exact text for the edit tool.
    """
    from headroom.transforms.content_router import ContentRouter, ContentRouterConfig
    from headroom.config import ReadLifecycleConfig
    from headroom.tokenizer import Tokenizer, TokenCounter

    messages = payload.get("messages", [])
    model = payload.get("model", "gpt-4o")
    protect_recent = payload.get("protect_recent", 4)
    compress_user_messages = payload.get("compress_user_messages", False)
    ccr_enabled = bool(payload.get("ccr_enabled", True))

    if not messages:
        return {
            "messages": [],
            "tokens_before": 0,
            "tokens_after": 0,
            "tokens_saved": 0,
            "compression_ratio": 0.0,
            "transforms_applied": [],
        }

    # Pi-specific exclude list:
    #   - read/write/edit: MUST be excluded (exact text needed for edits)
    #   - bash/grep/glob/find/ls: NOT excluded (great compression targets)
    #   This differs from upstream DEFAULT_EXCLUDE_TOOLS which includes all of them,
    #   but that default is designed for Claude Code where Bash runs commands
    #   that produce code-adjacent output. Pi's bash is more like a shell.
    pi_exclude_tools: set[str] = {
        "read", "Read",
        "write", "Write",
        "edit", "Edit",
    }

    # Allow callers to override the exclude list
    custom_excludes = payload.get("exclude_tools")
    if custom_excludes is not None:
        pi_exclude_tools = set(custom_excludes) if isinstance(custom_excludes, (list, set)) else pi_exclude_tools

    try:
        config = ContentRouterConfig(
            exclude_tools=pi_exclude_tools,
            ccr_enabled=ccr_enabled,
            ccr_inject_marker=ccr_enabled,
            protect_recent_code=0,  # DISABLED for Pi: our exclude_tools already
                                    # protects read/write/edit content. The upstream
                                    # default (4) protects bash log output detected
                                    # as "source_code", preventing compression of the
                                    # very content we most want to compress.
            protect_analysis_context=False,  # DISABLED for Pi: detects "analysis intent"
                                            # (e.g. "fix the code") and shields all
                                            # source-code-detected content including bash
                                            # logs from compression. Our exclude_tools
                                            # already protects read/write/edit, and
                                            # compress_stale=False keeps reads alive.
            read_lifecycle=ReadLifecycleConfig(
                enabled=True,
                compress_stale=False,    # DISABLED: Pi agents do read → edit → edit patterns
                                        # where the read content is still needed for
                                        # subsequent edits even after the first edit.
                                        # The upstream default (compress_stale=True) is
                                        # designed for Claude Code which re-reads between
                                        # edits, but Pi agents don't always do that.
                compress_superseded=True, # Safe: file was re-read (older read is redundant)
                min_size_bytes=512,
            ),
        )
        router = ContentRouter(config)

        # Create a simple tokenizer for token counting
        class _SimpleCounter:
            def count_text(self, text: str) -> int:
                return len(text) // 4
            def count_message(self, msg: dict[str, Any]) -> int:
                return self.count_text(str(msg.get("content", "")))
            def count_messages(self, msgs: list[dict[str, Any]]) -> int:
                return sum(self.count_message(m) for m in msgs)

        tokenizer = Tokenizer(_SimpleCounter(), model=model)

        # Derive model_limit from the model's known context window
        model_limit = payload.get("model_limit", 200_000)

        result = router.apply(
            messages,
            tokenizer,
            model=model,
            model_limit=model_limit,
            compress_user_messages=compress_user_messages,
        )

        tokens_before = result.tokens_before
        tokens_after = result.tokens_after
        tokens_saved = tokens_before - tokens_after

        return {
            "messages": result.messages,
            "tokens_before": tokens_before,
            "tokens_after": tokens_after,
            "tokens_saved": tokens_saved,
            "compression_ratio": tokens_saved / tokens_before if tokens_before > 0 else 0.0,
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


def handle_retrieve(payload: dict[str, Any]) -> dict[str, Any]:
    """Retrieve CCR content by hash, optionally filtering via search query."""
    from headroom.cache.compression_store import get_compression_store

    hash_key = str(payload.get("hash", "")).strip()
    query = payload.get("query")
    if not hash_key:
        return {"error": "Missing hash"}

    store = get_compression_store()
    try:
        if isinstance(query, str) and query.strip():
            results = store.search(hash_key, query)
            content = json.dumps(
                {
                    "hash": hash_key,
                    "query": query,
                    "results": results,
                    "count": len(results),
                },
                indent=2,
            )
            return {
                "content": content,
                "found": True,
                "was_search": True,
                "count": len(results),
            }

        entry = store.retrieve(hash_key)
        if entry is None:
            return {
                "content": json.dumps(
                    {
                        "error": "Entry not found or expired (TTL: 5 minutes)",
                        "hash": hash_key,
                    },
                    indent=2,
                ),
                "found": False,
                "was_search": False,
                "count": 0,
            }

        return {
            "content": entry.original_content,
            "found": True,
            "was_search": False,
            "count": entry.original_item_count,
        }
    except Exception as exc:
        return {
            "content": json.dumps({"error": str(exc), "hash": hash_key}, indent=2),
            "found": False,
            "was_search": False,
            "count": 0,
            "error": str(exc),
        }


def handle_payload(payload: dict[str, Any]) -> dict[str, Any]:
    action = payload.get("action", "check")
    handlers = {
        "check": handle_check,
        "check_environment": lambda: handle_check_environment(),
        "compress_text": lambda: handle_compress_text(payload),
        "compress_messages": lambda: handle_compress_messages(payload),
        "retrieve": lambda: handle_retrieve(payload),
    }
    handler = handlers.get(action)
    if handler is None:
        return {"error": f"Unknown action: {action}"}
    return handler()


def _read_json_input() -> dict[str, Any]:
    raw = sys.stdin.read()
    try:
        return json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError as exc:
        print(json.dumps({"error": f"Invalid JSON input: {exc}"}))
        raise SystemExit(1) from exc


def _server_main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
            req_id = message.get("id")
            payload = message.get("payload", {})
            result = handle_payload(payload)
            print(json.dumps({"id": req_id, "result": result}), flush=True)
        except Exception as exc:  # pragma: no cover - defensive bridge boundary
            print(json.dumps({"id": None, "error": str(exc)}), flush=True)


def main() -> None:
    if "--server" in sys.argv:
        _server_main()
        return

    payload = _read_json_input()
    result = handle_payload(payload)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
