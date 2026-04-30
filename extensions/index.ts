/**
 * Pi Package: Headroom — Context Compression for LLM Agents
 *
 * Self-installing extension that integrates Headroom AI compression with Pi.
 * On first run, it automatically creates a Python 3.12 venv, installs headroom-ai
 * from PyPI, and links the pre-built Rust SmartCrusher extension from the bundled wheel.
 *
 * Features:
 *   - Auto-installs on first session (no manual setup needed)
 *   - Automatic compression of large tool results (bash, read, grep, find, ls)
 *   - `headroom_compress` tool — compress any text on demand
 *   - `headroom_stats` tool — view cumulative compression statistics
 *   - `/headroom` command — toggle auto-compression, view stats, setup, check
 *   - Status bar — shows tokens saved this session
 *
 * Install:
 *   pi install git:github.com/brutaldeluxe82/pi-headroom
 *   /reload
 *
 * The pre-built Rust wheel is bundled for Linux x86_64.
 * For other platforms, the extension falls back to a Rust-from-source build
 * or operates without the SmartCrusher (limited compression).
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { execFile } from "node:child_process";
import { existsSync, readdirSync, mkdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

// import.meta.url points to extensions/index.ts, so dirname gives extensions/.
// The bridge and wheels live at the package root (one level up).
const EXT_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_DIR = resolve(EXT_DIR, "..");
const BRIDGE_PATH = resolve(PKG_DIR, "python", "headroom_bridge.py");
const WHEELS_DIR = resolve(PKG_DIR, "wheels");

/**
 * The headroom venv lives at ~/.local/share/headroom-venv.
 * Created automatically by the extension if missing.
 */
const HEADROOM_VENV = resolve(homedir(), ".local/share/headroom-venv");
const HEADROOM_PYTHON = resolve(HEADROOM_VENV, "bin/python");

// ---------------------------------------------------------------------------
// Platform detection
// ---------------------------------------------------------------------------

function platformTag(): string {
	const arch = process.arch; // x64, arm64, etc.
	const platform = process.platform; // linux, darwin, win32

	if (platform === "linux" && arch === "x64") return "linux-x86_64";
	if (platform === "darwin" && arch === "arm64") return "macos-arm64";
	if (platform === "darwin" && arch === "x64") return "macos-x86_64";
	return "unknown";
}

/** Find a bundled wheel matching the current platform. */
function findBundledWheel(): string | null {
	const tag = platformTag();
	if (tag === "unknown") return null;

	try {
		const files = readdirSync(WHEELS_DIR);
		// Match wheels containing the platform tag (e.g. manylinux, macosx)
		const wheel = files.find(
			(f) =>
				f.endsWith(".whl") &&
				(tag === "linux-x86_64"
					? f.includes("manylinux") && f.includes("x86_64")
					: tag === "macos-arm64"
						? f.includes("macosx") && f.includes("arm64")
						: tag === "macos-x86_64"
							? f.includes("macosx") && f.includes("x86_64")
							: false),
		);
		return wheel ? resolve(WHEELS_DIR, wheel) : null;
	} catch {
		return null;
	}
}

/** Find the Python interpreter that has headroom-ai installed. */
function findPython(): string {
	if (existsSync(HEADROOM_PYTHON)) return HEADROOM_PYTHON;
	return "python3";
}

// ---------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------

/**
 * Set up the headroom venv: create it, install packages, link the Rust wheel.
 * Returns true on success.
 */
async function installHeadroom(
	ui: ExtensionAPI extends (pi: infer P) => void ? never : ExtensionAPI extends (p: infer P) => void ? never : { notify: (msg: string, type: string) => void },
	signal?: AbortSignal,
): Promise<boolean> {
	const notify = ui.notify.bind(ui);

	// Step 1: Create venv with Python 3.12
	if (!existsSync(HEADROOM_PYTHON)) {
		notify("Headroom: creating Python 3.12 venv...", "info");
		try {
			await execFileAsync("uv", ["venv", "--python", "3.12", HEADROOM_VENV], {
				timeout: 30_000,
				signal,
			});
		} catch {
			try {
				// Fallback: try python3.12 directly
				await execFileAsync("python3.12", ["-m", "venv", HEADROOM_VENV], {
					timeout: 30_000,
					signal,
				});
			} catch {
				notify(
					"Headroom setup failed: Python 3.12 not found. Install with: mise use python@3.12",
					"error",
				);
				return false;
			}
		}
	}

	const python = HEADROOM_PYTHON;

	// Step 2: Install the Rust wheel FIRST (if available for this platform)
	// This must go before the PyPI package because the wheel includes a blank
	// headroom/__init__.py that would clobber the PyPI package's __init__.py.
	const wheel = findBundledWheel();
	if (wheel) {
		notify("Headroom: installing Rust SmartCrusher extension...", "info");
		try {
			await execFileAsync(
				"uv",
				["pip", "install", "--python", python, wheel],
				{ timeout: 30_000, signal },
			);
		} catch (e) {
			notify(
				`Headroom: wheel install failed (${e instanceof Error ? e.message : String(e)}), continuing without Rust extension`,
				"warning",
			);
		}
	}

	// Step 3: Install headroom-ai from PyPI (overwrites __init__.py correctly)
	notify("Headroom: installing headroom-ai from PyPI...", "info");
	try {
		await execFileAsync(
			"uv",
			["pip", "install", "--python", python, "headroom-ai[proxy]"],
			{ timeout: 120_000, signal },
		);
	} catch {
		// Fallback: try without [proxy] extras (fewer features but core works)
		try {
			await execFileAsync(
				"uv",
				["pip", "install", "--python", python, "headroom-ai"],
				{ timeout: 120_000, signal },
			);
		} catch (e) {
			notify(
				`Headroom setup failed: ${e instanceof Error ? e.message : String(e)}`,
				"error",
			);
			return false;
		}
	}

	return true;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SessionStats {
	requests: number;
	tokensBefore: number;
	tokensAfter: number;
	tokensSaved: number;
	errors: number;
	transformsUsed: Record<string, number>;
}

interface CheckResult {
	installed: boolean;
	version?: string;
	rust_extension?: boolean;
	error?: string;
}

interface CompressTextResult {
	compressed_text: string;
	tokens_before: number;
	tokens_after: number;
	tokens_saved: number;
	compression_ratio: number;
	transforms_applied: string[];
	error?: string;
}

// ---------------------------------------------------------------------------
// Python Bridge
// ---------------------------------------------------------------------------

async function callBridge(
	payload: Record<string, unknown>,
	timeoutMs = 15_000,
	signal?: AbortSignal,
): Promise<Record<string, unknown>> {
	const python = findPython();
	const payloadJson = JSON.stringify(payload);

	return new Promise<Record<string, unknown>>((resolve, reject) => {
		const { spawn } = require("node:child_process");
		const proc = spawn(python, [BRIDGE_PATH], {
			env: {
				...process.env,
				PYTHONWARNINGS: "ignore",
				TRANSFORMERS_VERBOSITY: "error",
			},
			signal,
		});

		let stdout = "";
		let stderr = "";
		proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
		proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

		const timer = setTimeout(() => {
			proc.kill();
			reject(new Error(`Headroom bridge timed out after ${timeoutMs}ms`));
		}, timeoutMs);

		proc.on("close", (code: number | null) => {
			clearTimeout(timer);
			if (code !== 0) {
				reject(new Error(
					`Headroom bridge exited with code ${code}${stderr ? ` | stderr: ${stderr.slice(0, 200)}` : ""}`,
				));
				return;
			}
			try {
				resolve(JSON.parse(stdout.trim()));
			} catch {
				reject(new Error(
					`Headroom bridge returned invalid JSON: ${stdout.slice(0, 200)}${stderr ? ` | stderr: ${stderr.slice(0, 200)}` : ""}`,
				));
			}
		});

		proc.on("error", (err: Error) => {
			clearTimeout(timer);
			reject(new Error(`Headroom bridge spawn error: ${err.message}`));
		});

		// Write payload to stdin and close it so Python's sys.stdin.read() returns
		proc.stdin.write(payloadJson);
		proc.stdin.end();
	});
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MIN_COMPRESS_LENGTH = 1500;
const COMPRESSIBLE_TOOLS = new Set([
	// Built-in tools with potentially large text output
	"bash", "read", "grep", "find", "ls",
	// MCP tools that return large web/docs results
	"mcp_exa_exa_search",
	"mcp_context7_resolve-library-id",
	"mcp_context7_query-docs",
	// Self-reference (manual compression)
	"headroom_compress",
]);

function extractTextFromContent(
	content: Array<{ type: string; text?: string }>,
): string {
	return content
		.filter((b) => b.type === "text" && typeof b.text === "string")
		.map((b) => b.text!)
		.join("\n");
}

function rebuildContent(
	original: Array<{ type: string; text?: string }>,
	compressedText: string,
): Array<{ type: string; text?: string }> {
	const nonText = original.filter((b) => b.type !== "text");
	return [{ type: "text", text: compressedText }, ...nonText];
}

function fmtTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return String(n);
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	let headroomAvailable = false;
	let headroomVersion: string | undefined;
	let hasRustExtension = false;
	let autoCompress = true;
	let installedThisSession = false;
	const stats: SessionStats = {
		requests: 0,
		tokensBefore: 0,
		tokensAfter: 0,
		tokensSaved: 0,
		errors: 0,
		transformsUsed: {},
	};

	function recordCompression(
		tokensBefore: number,
		tokensAfter: number,
		transforms: string[],
	): void {
		stats.requests++;
		stats.tokensBefore += tokensBefore;
		stats.tokensAfter += tokensAfter;
		stats.tokensSaved += Math.max(0, tokensBefore - tokensAfter);
		for (const t of transforms) {
			stats.transformsUsed[t] = (stats.transformsUsed[t] || 0) + 1;
		}
	}

	function refreshStatus(ctx: {
		ui: {
			setStatus: (id: string, text: string | undefined) => void;
			theme: { fg: (slot: string, text: string) => string };
		};
	}): void {
		if (!headroomAvailable) {
			ctx.ui.setStatus("headroom", undefined);
			return;
		}
		const theme = ctx.ui.theme;
		if (stats.tokensSaved > 0) {
			const pct =
				stats.tokensBefore > 0
					? ((stats.tokensSaved / stats.tokensBefore) * 100).toFixed(0)
					: "0";
			const icon = theme.fg("success", "↓");
			const text = theme.fg(
				"dim",
				` ${fmtTokens(stats.tokensSaved)} tok saved (${pct}%)`,
			);
			ctx.ui.setStatus("headroom", icon + text);
		} else {
			ctx.ui.setStatus(
				"headroom",
				theme.fg("dim", "⌇ headroom"),
			);
		}
	}

	// ---- Session lifecycle ----

	pi.on("session_start", async (_event, ctx) => {
		// Quick check: is headroom already installed?
		try {
			ctx.ui.notify(`Headroom: checking bridge...`, "info");
			const result = (await callBridge(
				{ action: "check" },
				15_000,
			)) as unknown as CheckResult;

			if (result.installed) {
				headroomAvailable = true;
				headroomVersion = result.version;
				hasRustExtension = result.rust_extension ?? false;
				const rustNote = hasRustExtension ? "" : " (no Rust ext — limited)";
				ctx.ui.notify(
					`Headroom v${headroomVersion} loaded${rustNote}`,
					"info",
				);
			} else if (!installedThisSession) {
				// Auto-install on first use
				installedThisSession = true;
				ctx.ui.notify("Headroom: first run — installing automatically...", "info");

				const ok = await installHeadroom(ctx.ui, ctx.signal);
				if (ok) {
					// Re-check after installation
					try {
						const recheck = (await callBridge(
							{ action: "check" },
							5_000,
						)) as unknown as CheckResult;
						headroomAvailable = recheck.installed;
						headroomVersion = recheck.version;
						hasRustExtension = recheck.rust_extension ?? false;
						if (headroomAvailable) {
							ctx.ui.notify(
								`Headroom v${headroomVersion} installed ✓`,
								"success",
							);
						}
					} catch {
						ctx.ui.notify("Headroom installed but verification failed", "warning");
					}
				}
			}
		} catch (err) {
			// Bridge failed — might need auto-install
			if (!installedThisSession && !existsSync(HEADROOM_VENV)) {
				installedThisSession = true;
				ctx.ui.notify("Headroom: not found — setting up...", "info");
				const ok = await installHeadroom(ctx.ui, ctx.signal);
				if (ok) {
					try {
						const recheck = (await callBridge(
							{ action: "check" },
							5_000,
						)) as unknown as CheckResult;
						headroomAvailable = recheck.installed;
						headroomVersion = recheck.version;
						hasRustExtension = recheck.rust_extension ?? false;
						if (headroomAvailable) {
							ctx.ui.notify(
								`Headroom v${headroomVersion} installed ✓`,
								"success",
							);
						}
					} catch {
						ctx.ui.notify("Headroom installed but verification failed", "warning");
					}
				}
			} else {
				ctx.ui.notify(
					"Headroom: Python not available. Install Python 3.12+ and uv.",
					"warning",
				);
			}
		}

		// Reset session stats
		stats.requests = 0;
		stats.tokensBefore = 0;
		stats.tokensAfter = 0;
		stats.tokensSaved = 0;
		stats.errors = 0;
		stats.transformsUsed = {};
		autoCompress = true;

		refreshStatus(ctx);
	});

	// ---- Tool result compression ----

	pi.on("tool_result", async (event, ctx) => {
		if (!headroomAvailable || !autoCompress) return undefined;
		if (event.isError) return undefined;
		if (!COMPRESSIBLE_TOOLS.has(event.toolName)) return undefined;

		const text = extractTextFromContent(event.content);
		if (text.length < MIN_COMPRESS_LENGTH) return undefined;

		try {
			const model = ctx.model?.id ?? "gpt-4o";
			const result = (await callBridge(
				{ action: "compress_text", text, model },
				15_000,
				ctx.signal,
			)) as unknown as CompressTextResult;

			if (result.error) {
				stats.errors++;
				return undefined;
			}

			if (result.tokens_saved < 50) return undefined;

			recordCompression(
				result.tokens_before,
				result.tokens_after,
				result.transforms_applied,
			);

			refreshStatus(ctx);

			return {
				content: rebuildContent(event.content, result.compressed_text),
			};
		} catch {
			stats.errors++;
			return undefined;
		}
	});

	// ---- Tools ----

	pi.registerTool({
		name: "headroom_compress",
		label: "Headroom Compress",
		description:
			"Compress text using Headroom AI to reduce token count while preserving meaning. " +
			"Use for large outputs (logs, search results, file contents) that need compression " +
			"before including in context. Returns compressed text and token savings.",
		promptSnippet: "Compress large text outputs to save tokens while preserving meaning",
		promptGuidelines: [
			"Use headroom_compress when you need to reduce a large text block before reasoning about it — especially long logs, search results, or file listings.",
		],
		parameters: Type.Object({
			text: Type.String({
				description: "Text to compress (should be at least a few hundred characters).",
			}),
			target_ratio: Type.Optional(
				Type.Number({
					description:
						"Target keep-ratio. 0.2 = aggressive (20% kept). 0.5 = moderate. Omit for default (~15%).",
					minimum: 0.05,
					maximum: 1.0,
				}),
			),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (!headroomAvailable) {
				throw new Error("Headroom is not installed. Run: /headroom setup");
			}

			const result = (await callBridge(
				{
					action: "compress_text",
					text: params.text,
					model: ctx.model?.id ?? "gpt-4o",
					target_ratio: params.target_ratio,
				},
				30_000,
				signal,
			)) as unknown as CompressTextResult;

			if (result.error) {
				throw new Error(`Compression failed: ${result.error}`);
			}

			recordCompression(
				result.tokens_before,
				result.tokens_after,
				result.transforms_applied,
			);

			refreshStatus(ctx);

			const pct = result.compression_ratio * 100;
			return {
				content: [
					{
						type: "text",
						text:
							`Compressed: ${fmtTokens(result.tokens_before)} → ${fmtTokens(result.tokens_after)} tokens ` +
							`(${pct.toFixed(0)}% saved)\n\n${result.compressed_text}`,
					},
				],
				details: {
					tokensBefore: result.tokens_before,
					tokensAfter: result.tokens_after,
					tokensSaved: result.tokens_saved,
					ratio: result.compression_ratio,
					transforms: result.transforms_applied,
				},
			};
		},
	});

	pi.registerTool({
		name: "headroom_stats",
		label: "Headroom Stats",
		description:
			"View cumulative compression statistics for the current session.",
		promptSnippet: "Show Headroom compression stats for this session",
		parameters: Type.Object({}),
		async execute() {
			const pct =
				stats.tokensBefore > 0
					? ((stats.tokensSaved / stats.tokensBefore) * 100).toFixed(1)
					: "0.0";

			const transforms = Object.entries(stats.transformsUsed)
				.sort(([, a], [, b]) => b - a)
				.map(([name, count]) => `  ${name}: ${count}x`)
				.join("\n");

			return {
				content: [
					{
						type: "text",
						text:
							`Headroom Session Stats\n` +
							`  Compression requests: ${stats.requests}\n` +
							`  Tokens before: ${fmtTokens(stats.tokensBefore)}\n` +
							`  Tokens after:  ${fmtTokens(stats.tokensAfter)}\n` +
							`  Tokens saved:  ${fmtTokens(stats.tokensSaved)} (${pct}%)\n` +
							`  Errors: ${stats.errors}\n` +
							`  Auto-compress: ${autoCompress ? "on" : "off"}\n` +
							`  Rust extension: ${hasRustExtension ? "yes" : "no"}\n` +
							`  Version: ${headroomVersion ?? "unknown"}\n` +
							`  Platform wheel: ${findBundledWheel() ? "bundled" : "none"}\n` +
							(transforms ? `\nTransforms used:\n${transforms}` : ""),
					},
				],
				details: { ...stats, autoCompress, version: headroomVersion },
			};
		},
	});

	// ---- Commands ----

	pi.registerCommand("headroom", {
		description:
			"Headroom compression: toggle, check, setup, or show stats",
		handler: async (args, ctx) => {
			const sub = (args ?? "").trim().toLowerCase();

			if (sub === "toggle") {
				autoCompress = !autoCompress;
				ctx.ui.notify(
					`Headroom auto-compression: ${autoCompress ? "ON" : "OFF"}`,
					"info",
				);
				refreshStatus(ctx);
				return;
			}

			if (sub === "check") {
				try {
					const result = (await callBridge(
						{ action: "check" },
						5_000,
					)) as unknown as CheckResult;
					if (result.installed) {
						const rust = result.rust_extension ? " (Rust ext ✓)" : " (no Rust ext)";
						const wheel = findBundledWheel() ? " (bundled wheel available)" : "";
						ctx.ui.notify(
							`Headroom v${result.version}${rust}${wheel}`,
							"info",
						);
					} else {
						ctx.ui.notify(
							`Headroom not installed. ${result.error ?? ""}`,
							"warning",
						);
					}
				} catch (err) {
					ctx.ui.notify(
						`Headroom check failed: ${err instanceof Error ? err.message : String(err)}`,
						"error",
					);
				}
				return;
			}

			if (sub === "setup") {
				const ok = await installHeadroom(ctx.ui, ctx.signal);
				if (ok) {
					try {
						const recheck = (await callBridge(
							{ action: "check" },
							5_000,
						)) as unknown as CheckResult;
						headroomAvailable = recheck.installed;
						headroomVersion = recheck.version;
						hasRustExtension = recheck.rust_extension ?? false;
						ctx.ui.notify(
							`Headroom v${headroomVersion} installed ✓`,
							"success",
						);
						refreshStatus(ctx);
					} catch {
						ctx.ui.notify("Headroom installed but verification failed", "warning");
					}
				}
				return;
			}

			if (sub === "clean") {
				const { rm } = await import("node:fs/promises");
				await rm(HEADROOM_VENV, { recursive: true, force: true });
				headroomAvailable = false;
				ctx.ui.notify("Headroom venv removed", "info");
				refreshStatus(ctx);
				return;
			}

			// Default: show stats
			const pct =
				stats.tokensBefore > 0
					? ((stats.tokensSaved / stats.tokensBefore) * 100).toFixed(1)
					: "0.0";
			ctx.ui.notify(
				`Headroom: ${fmtTokens(stats.tokensSaved)} tokens saved (${pct}%) | ` +
				`${stats.requests} compressions | auto: ${autoCompress ? "on" : "off"}`,
				"info",
			);
		},
	});
}
