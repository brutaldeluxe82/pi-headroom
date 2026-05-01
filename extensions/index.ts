/**
 * Pi Package: Headroom — Context Compression for LLM Agents
 *
 * Integrates Headroom AI compression with Pi using the message-level
 * compression API, which is the same approach used by `headroom wrap`
 * and the Headroom proxy.
 *
 * Architecture:
 *   Uses Pi's `context` event hook to compress the full message list
 *   before each LLM call. This gives us Headroom's full safety pipeline:
 *   - DEFAULT_EXCLUDE_TOOLS (Read/Write/Edit are never compressed)
 *   - ReadLifecycle (stale/superseded Reads are safely compressed)
 *   - protect_recent_code (recent code messages are protected)
 *   - protect_analysis_context (code in analysis context is protected)
 *   - ContentRouter (AST-aware code compression when appropriate)
 *   - CCR (Compress-Cache-Retrieve for lossless retrieval)
 *
 * Previous versions used tool_result-level compression which bypassed
 * all these safety mechanisms, causing code compression that broke edits.
 *
 * Features:
 *   - Auto-installs on first session (no manual setup needed)
 *   - Message-level compression before each LLM call (the proper way)
 *   - `headroom_compress` tool — compress any text on demand
 *   - `headroom_retrieve` tool — retrieve original CCR content
 *   - `headroom_stats` tool — view cumulative compression statistics
 *   - `/headroom` command — toggle compression, view stats, setup, check
 *   - Status bar — shows tokens saved this session
 *
 * Install:
 *   pi install git:github.com/brutaldeluxe82/pi-headroom
 *   /reload
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import readline from "node:readline";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const EXT_DIR = dirname(fileURLToPath(import.meta.url));
const PKG_DIR = resolve(EXT_DIR, "..");
const BRIDGE_PATH = resolve(PKG_DIR, "python", "headroom_bridge.py");
const WHEELS_DIR = resolve(PKG_DIR, "wheels");

const HEADROOM_VENV = resolve(homedir(), ".local/share/headroom-venv");
const HEADROOM_PYTHON = resolve(HEADROOM_VENV, "bin/python");

// ---------------------------------------------------------------------------
// Platform detection
// ---------------------------------------------------------------------------

function platformTag(): string {
	const arch = process.arch;
	const platform = process.platform;

	if (platform === "linux" && arch === "x64") return "linux-x86_64";
	if (platform === "darwin" && arch === "arm64") return "macos-arm64";
	if (platform === "darwin" && arch === "x64") return "macos-x86_64";
	return "unknown";
}

function findBundledWheel(): string | null {
	const tag = platformTag();
	if (tag === "unknown") return null;

	try {
		const files = readdirSync(WHEELS_DIR);
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

function findPython(): string {
	if (existsSync(HEADROOM_PYTHON)) return HEADROOM_PYTHON;
	return "python3";
}

// ---------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------

async function installHeadroom(
	ui: { notify: (msg: string, type: string) => void },
	signal?: AbortSignal,
): Promise<boolean> {
	const notify = ui.notify.bind(ui);

	if (!existsSync(HEADROOM_PYTHON)) {
		notify("Headroom: creating Python 3.12 venv...", "info");
		try {
			await execFileAsync("uv", ["venv", "--python", "3.12", HEADROOM_VENV], {
				timeout: 30_000,
				signal,
			});
		} catch {
			try {
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

	const wheel = findBundledWheel();
	if (wheel) {
		notify("Headroom: installing Rust SmartCrusher extension...", "info");
		try {
			await execFileAsync("uv", ["pip", "install", "--python", python, wheel], {
				timeout: 30_000,
				signal,
			});
		} catch (e) {
			notify(
				`Headroom: wheel install failed (${e instanceof Error ? e.message : String(e)}), continuing without Rust extension`,
				"warning",
			);
		}
	}

	notify("Headroom: installing headroom-ai from PyPI...", "info");
	try {
		await execFileAsync("uv", ["pip", "install", "--python", python, "headroom-ai[proxy]"], {
			timeout: 120_000,
			signal,
		});
	} catch {
		try {
			await execFileAsync("uv", ["pip", "install", "--python", python, "headroom-ai"], {
				timeout: 120_000,
				signal,
			});
		} catch (e) {
			notify(`Headroom setup failed: ${e instanceof Error ? e.message : String(e)}`, "error");
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

interface CompressMessagesResult {
	messages: Record<string, unknown>[];
	tokens_before: number;
	tokens_after: number;
	tokens_saved: number;
	compression_ratio: number;
	transforms_applied: string[];
	error?: string;
}

// ---------------------------------------------------------------------------
// Python Bridge (JSONL server mode for CCR state persistence)
// ---------------------------------------------------------------------------

let bridgeProc: ChildProcessWithoutNullStreams | undefined;
let bridgeSeq = 0;
const bridgePending = new Map<
	number,
	{
		resolve: (value: Record<string, unknown>) => void;
		reject: (error: Error) => void;
		timer: NodeJS.Timeout;
	}
>();

function stopBridgeProcess(): void {
	if (!bridgeProc) return;
	bridgeProc.kill();
	bridgeProc = undefined;
}

function ensureBridgeProcess(): ChildProcessWithoutNullStreams {
	if (bridgeProc && !bridgeProc.killed) return bridgeProc;

	const python = findPython();
	const proc = spawn(python, [BRIDGE_PATH, "--server"], {
		env: {
			...process.env,
			PYTHONWARNINGS: "ignore",
			TRANSFORMERS_VERBOSITY: "error",
		},
	});

	const stdout = readline.createInterface({ input: proc.stdout });
	stdout.on("line", (line) => {
		try {
			const message = JSON.parse(line) as {
				id?: number;
				result?: Record<string, unknown>;
				error?: string;
			};
			if (typeof message.id !== "number") return;
			const pending = bridgePending.get(message.id);
			if (!pending) return;
			clearTimeout(pending.timer);
			bridgePending.delete(message.id);
			if (message.error) {
				pending.reject(new Error(message.error));
				return;
			}
			pending.resolve(message.result ?? {});
		} catch {
			// Ignore malformed bridge lines
		}
	});

	proc.on("close", (code) => {
		for (const [id, pending] of bridgePending.entries()) {
			clearTimeout(pending.timer);
			pending.reject(new Error(`Headroom bridge exited with code ${code ?? "unknown"}`));
			bridgePending.delete(id);
		}
		if (bridgeProc === proc) {
			bridgeProc = undefined;
		}
	});

	proc.on("error", (err) => {
		for (const [id, pending] of bridgePending.entries()) {
			clearTimeout(pending.timer);
			pending.reject(new Error(`Headroom bridge spawn error: ${err.message}`));
			bridgePending.delete(id);
		}
		if (bridgeProc === proc) {
			bridgeProc = undefined;
		}
	});

	bridgeProc = proc;
	return proc;
}

async function callBridge(
	payload: Record<string, unknown>,
	timeoutMs = 30_000,
	signal?: AbortSignal,
): Promise<Record<string, unknown>> {
	const proc = ensureBridgeProcess();
	const id = ++bridgeSeq;

	return new Promise<Record<string, unknown>>((resolve, reject) => {
		const timer = setTimeout(() => {
			bridgePending.delete(id);
			reject(new Error(`Headroom bridge timed out after ${timeoutMs}ms`));
		}, timeoutMs);

		bridgePending.set(id, { resolve, reject, timer });

		if (signal) {
			signal.addEventListener(
				"abort",
				() => {
					const pending = bridgePending.get(id);
					if (!pending) return;
					clearTimeout(pending.timer);
					bridgePending.delete(id);
					reject(new Error("Headroom bridge request aborted"));
				},
				{ once: true },
			);
		}

		proc.stdin.write(`${JSON.stringify({ id, payload })}\n`);
	});
}

// ---------------------------------------------------------------------------
// Pi AgentMessage → Headroom format conversion
// ---------------------------------------------------------------------------

/**
 * Convert Pi's AgentMessage[] to the Anthropic-format message list that
 * Headroom's compress() expects.
 *
 * Pi uses: UserMessage, AssistantMessage, ToolResultMessage
 *   - AssistantMessage.content = (TextContent | ThinkingContent | ToolCall)[]
 *   - ToolResultMessage has toolCallId, toolName, content
 *
 * Headroom expects Anthropic format:
 *   - user → { role: "user", content: string }
 *   - assistant → { role: "assistant", content: [{type:"text",...}, {type:"tool_use",...}] }
 *   - toolResult → { role: "tool", tool_call_id, content, name }
 *
 * CRITICAL: We must preserve tool_use blocks in assistant messages so that
 * Headroom's _build_tool_name_map can resolve tool_call_id → tool_name.
 * This is how DEFAULT_EXCLUDE_TOOLS works — without it, Headroom can't
 * identify which tool results to skip (Read, Write, Edit, etc.).
 */
function piMessagesToHeadroom(messages: Record<string, unknown>[]): Record<string, unknown>[] {
	return messages
		.filter((msg) => {
			const role = msg.role as string;
			return role === "user" || role === "assistant" || role === "toolResult";
		})
		.map((msg) => {
			const role = msg.role as string;

			if (role === "toolResult") {
				// Pi ToolResultMessage → Anthropic tool result
				const content = msg.content as Array<{ type: string; text?: string }>;
				const textContent = content
					?.filter((b) => b.type === "text" && typeof b.text === "string")
					.map((b) => b.text!)
					.join("\n") ?? "";

				return {
					role: "tool",
					tool_call_id: msg.toolCallId ?? msg.tool_call_id ?? "",
					content: textContent,
					name: msg.toolName ?? msg.tool_name ?? "",
				};
			}

			if (role === "assistant") {
				// Pi AssistantMessage → Anthropic assistant with tool_use blocks preserved
				//
				// Pi content blocks: {type:"text", text:...} | {type:"thinking",...} | {type:"toolCall", id, name, arguments}
				// Anthropic content blocks: {type:"text", text:...} | {type:"tool_use", id, name, input:{...}}
				const content = msg.content as Array<Record<string, unknown>>;
				if (!Array.isArray(content)) {
					return { role: "assistant", content: String(content ?? "") };
				}

				const anthropicBlocks: Record<string, unknown>[] = [];
				for (const block of content) {
					if (block.type === "text" && typeof block.text === "string") {
						anthropicBlocks.push({ type: "text", text: block.text });
					} else if (block.type === "toolCall") {
						// Convert Pi's {type:"toolCall", id, name, arguments} →
						// Anthropic's {type:"tool_use", id, name, input:{...}}
						anthropicBlocks.push({
							type: "tool_use",
							id: block.id ?? "",
							name: block.name ?? "",
							input: block.arguments ?? block.input ?? {},
						});
					}
					// Skip thinking blocks — Headroom doesn't need them
				}

				// Anthropic requires at least one content block
				if (anthropicBlocks.length === 0) {
					anthropicBlocks.push({ type: "text", text: "" });
				}

				return {
					role: "assistant",
					content: anthropicBlocks,
				};
			}

			// user
			const content = msg.content;
			if (typeof content === "string") {
				return { role: "user", content };
			}
			if (Array.isArray(content)) {
				const textContent = content
					.filter((b: any) => b.type === "text" && typeof b.text === "string")
					.map((b: any) => b.text!)
					.join("\n");
				return { role: "user", content: textContent };
			}
			return { role: "user", content: String(content ?? "") };
		});
}

/**
 * Apply compressed messages back onto the original Pi AgentMessage[].
 *
 * We only modify toolResult messages (that's where compression happens).
 * User and assistant messages are passed through unchanged.
 */
function applyCompressedMessages(
	original: Record<string, unknown>[],
	compressed: Record<string, unknown>[],
): Record<string, unknown>[] {
	// Build a map of compressed tool results by tool_call_id
	const compressedToolResults = new Map<string, string>();
	for (const msg of compressed) {
		if (msg.role === "tool" && msg.tool_call_id) {
			compressedToolResults.set(msg.tool_call_id as string, msg.content as string);
		}
	}

	// Apply compressed content back to original Pi messages
	return original.map((msg) => {
		if (msg.role !== "toolResult") return msg;

		const toolCallId = (msg.toolCallId ?? msg.tool_call_id) as string;
		const compressedText = compressedToolResults.get(toolCallId);
		if (compressedText === undefined) return msg;

		// Replace text content blocks with compressed text
		return {
			...msg,
			content: [{ type: "text", text: compressedText }],
		};
	});
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseBool(value: string | undefined, fallback: boolean): boolean {
	if (value == null || value === "") return fallback;
	const normalized = value.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(normalized)) return true;
	if (["0", "false", "no", "off"].includes(normalized)) return false;
	return fallback;
}

function parseFloatEnv(value: string | undefined, fallback: number): number {
	if (value == null || value === "") return fallback;
	const parsed = Number.parseFloat(value);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseIntEnv(value: string | undefined, fallback: number): number {
	if (value == null || value === "") return fallback;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function estimateTokens(text: string): number {
	return Math.floor(text.length / 4);
}

function fmtTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
	if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
	return String(n);
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface ExtensionConfig {
	autoCompress: boolean;
	autoInstall: boolean;
	minTokensPct: number;
	configPath: string;
	sourceSummary: string[];
}

interface RawConfigFile {
	autoCompress?: boolean;
	autoInstall?: boolean;
	minTokensPct?: number;
}

function configFilePath(): string {
	// 1. Explicit workspace override (highest priority)
	const workspace = process.env.HEADROOM_WORKSPACE_DIR;
	if (workspace) return resolve(workspace, ".headroom", "pi-extension.json");

	// 2. Project-level config (CWD)
	const cwdPath = resolve(process.cwd(), ".headroom", "pi-extension.json");
	if (existsSync(cwdPath)) return cwdPath;

	// 3. Pi agent config directory (uses Pi's own getAgentDir())
	try {
		const piAgentDir = getAgentDir();
		const piPath = resolve(piAgentDir, ".headroom", "pi-extension.json");
		if (existsSync(piPath)) return piPath;
	} catch {
		// getAgentDir may not be available in all contexts
	}

	// 4. Default: CWD (even if it doesn't exist yet — will use defaults)
	return cwdPath;
}

function loadConfigFile(path: string): RawConfigFile | null {
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf8")) as RawConfigFile;
	} catch {
		return null;
	}
}

function loadExtensionConfig(): ExtensionConfig {
	const path = configFilePath();
	const fileConfig = loadConfigFile(path);
	const sources: string[] = [];

	const envAutoCompress = process.env.HEADROOM_PI_AUTO_COMPRESS ?? process.env.HEADROOM_OPTIMIZE;
	const envAutoInstall = process.env.HEADROOM_PI_AUTO_INSTALL;
	const envMinTokens = process.env.HEADROOM_PI_MIN_TOKENS ?? process.env.HEADROOM_MIN_TOKENS;
	const envMinTokensPct = process.env.HEADROOM_PI_MIN_PCT ?? process.env.HEADROOM_MIN_PCT;

	const mode = (process.env.HEADROOM_MODE || "").trim().toLowerCase();
	const modeForcesDisable = mode === "audit";

	if (fileConfig) sources.push(`file:${path}`);
	if (envAutoCompress)
		sources.push(
			process.env.HEADROOM_PI_AUTO_COMPRESS ? "env:HEADROOM_PI_AUTO_COMPRESS" : "env:HEADROOM_OPTIMIZE",
		);
	if (envAutoInstall) sources.push("env:HEADROOM_PI_AUTO_INSTALL");
	if (envMinTokens)
		sources.push(process.env.HEADROOM_PI_MIN_TOKENS ? "env:HEADROOM_PI_MIN_TOKENS" : "env:HEADROOM_MIN_TOKENS");
	if (envMinTokensPct)
		sources.push(process.env.HEADROOM_PI_MIN_PCT ? "env:HEADROOM_PI_MIN_PCT" : "env:HEADROOM_MIN_PCT");

	return {
		autoCompress: modeForcesDisable
			? false
			: parseBool(envAutoCompress, fileConfig?.autoCompress ?? true),
		autoInstall: parseBool(envAutoInstall, fileConfig?.autoInstall ?? true),
		minTokensPct: parseFloatEnv(
			envMinTokensPct,
			fileConfig?.minTokensPct ??
				(fileConfig?.minTokensToCompress != null
					? // Legacy: convert absolute token setting to percentage
						Math.min((fileConfig.minTokensToCompress / 200_000) * 100, 90)
					: 30),
		),
		configPath: path,
		sourceSummary: sources,
	};
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	let headroomAvailable = false;
	let headroomVersion: string | undefined;
	let hasRustExtension = false;
	let installedThisSession = false;
	let config: ExtensionConfig;
	let autoCompress = true;

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

	function refreshStatus(ctx: { ui: any }): void {
		if (!headroomAvailable) {
			ctx.ui.setStatus("headroom", undefined);
			return;
		}
		const theme = ctx.ui.theme;
		if (stats.tokensSaved > 0) {
			const pct =
				stats.tokensBefore > 0 ? ((stats.tokensSaved / stats.tokensBefore) * 100).toFixed(0) : "0";
			const icon = theme.fg("success", "↓");
			const text = theme.fg("dim", ` ${fmtTokens(stats.tokensSaved)} tok saved (${pct}%)`);
			ctx.ui.setStatus("headroom", icon + text);
		} else {
			ctx.ui.setStatus("headroom", theme.fg("dim", "⌇ headroom"));
		}
	}

	// -----------------------------------------------------------------------
	// Session startup — check/install headroom
	// -----------------------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		config = loadExtensionConfig();
		autoCompress = config.autoCompress;

		// Is headroom already installed?
		try {
			const result = (await callBridge({ action: "check" }, 15_000)) as unknown as CheckResult;
			if (result.installed) {
				headroomAvailable = true;
				headroomVersion = result.version;
				hasRustExtension = result.rust_extension ?? false;
				const rustNote = hasRustExtension ? "" : " (no Rust ext — limited)";
				if (config.sourceSummary.length > 0) {
					ctx.ui.notify(`Headroom v${headroomVersion} loaded${rustNote}`, "info");
				} else {
					ctx.ui.notify(`Headroom v${headroomVersion} loaded`, "info");
				}

				// Surface environment warnings (missing HF_TOKEN, etc.)
				try {
					const envResult = (await callBridge({ action: "check_environment" }, 5_000)) as any;
					for (const w of envResult.warnings ?? []) {
						ctx.ui.notify(w.message, w.level === "warning" ? "warning" : "info");
					}
				} catch {
					// Non-critical — don't block startup
				}
			} else if (!installedThisSession && config.autoInstall) {
				installedThisSession = true;
				const ok = await installHeadroom(ctx.ui, ctx.signal);
				if (ok) {
					const recheck = (await callBridge({ action: "check" }, 5_000)) as unknown as CheckResult;
					headroomAvailable = recheck.installed;
					headroomVersion = recheck.version;
					hasRustExtension = recheck.rust_extension ?? false;
					if (headroomAvailable) {
						ctx.ui.notify(`Headroom v${headroomVersion} installed ✓`, "success");
					} else {
						ctx.ui.notify("Headroom installed but verification failed", "warning");
					}
				}
			} else if (!config.autoInstall) {
				ctx.ui.notify("Headroom auto-install disabled by config", "warning");
			}
		} catch {
			if (!installedThisSession && !existsSync(HEADROOM_VENV) && config.autoInstall) {
				installedThisSession = true;
				ctx.ui.notify("Headroom: not found — setting up...", "info");
				const ok = await installHeadroom(ctx.ui, ctx.signal);
				if (ok) {
					let recheck: CheckResult;
					try {
						recheck = (await callBridge({ action: "check" }, 5_000)) as unknown as CheckResult;
					} catch {
						recheck = { installed: false };
					}
					headroomAvailable = recheck.installed;
					headroomVersion = recheck.version;
					hasRustExtension = recheck.rust_extension ?? false;
					if (headroomAvailable) {
						ctx.ui.notify(`Headroom v${headroomVersion} installed ✓`, "success");
					} else {
						ctx.ui.notify("Headroom installed but verification failed", "warning");
					}
				}
			} else if (!config.autoInstall) {
				ctx.ui.notify(
					config.autoInstall
						? "Headroom: Python not available. Install Python 3.12+ and uv."
						: "Headroom: bridge unavailable and auto-install is disabled.",
					"warning",
				);
			}
		}

		refreshStatus(ctx);
	});

	// -----------------------------------------------------------------------
	// Session shutdown — clean up bridge process
	// -----------------------------------------------------------------------

	pi.on("session_shutdown", () => {
		stopBridgeProcess();
	});

	// -----------------------------------------------------------------------
	// Context event — message-level compression before each LLM call
	// -----------------------------------------------------------------------

	pi.on("context", async (event, ctx) => {
		if (!headroomAvailable || !autoCompress) return;

		const messages = event.messages;
		if (!messages || messages.length === 0) return;

		// Convert Pi messages to Headroom's expected format
		const headroomMessages = piMessagesToHeadroom(messages as Record<string, unknown>[]);
		if (headroomMessages.length === 0) return;

		// Only compress when estimated tokens exceed a percentage of the model's
		// context window. Default 30% means ~38K tokens for Claude 3.5 Sonnet
		// (128K) and ~60K for Claude 4 (200K). This avoids cache invalidation
		// in short sessions where prompt caching saves more than compression.
		const totalText = headroomMessages
			.map((m) => (typeof m.content === "string" ? m.content : ""))
			.join("");
		const minTokens = Math.floor(
			(ctx.model?.contextWindow ?? 200_000) * (config.minTokensPct / 100),
		);
		if (estimateTokens(totalText) < minTokens) return;

		const model = ctx.model?.id ?? "gpt-4o";
		const modelLimit = ctx.model?.contextWindow ?? 200_000;

		try {
			const result = (await callBridge(
				{
					action: "compress_messages",
					messages: headroomMessages,
					model,
					model_limit: modelLimit,
					// Pi-specific exclude list (bridge overrides DEFAULT_EXCLUDE_TOOLS):
					// - Excluded: read, write, edit (exact text needed for edits)
					// - NOT excluded: bash, grep, find, ls (compression targets)
					// - ReadLifecycle: stale/supeded reads safely compressed
					// - protect_recent_code=4: recent code messages protected
					// - protect_analysis_context=True: analysis code protected
					protect_recent: 4,
					compress_user_messages: false,
					ccr_enabled: true,
				},
				30_000,
				ctx.signal,
			)) as unknown as CompressMessagesResult;

			if (result.error) {
				stats.errors++;
				return;
			}

			const tokensSaved = result.tokens_saved ?? 0;
			if (tokensSaved <= 0) return;

			recordCompression(result.tokens_before, result.tokens_after, result.transforms_applied ?? []);
			refreshStatus(ctx);

			// Apply compressed messages back to Pi format
			const compressedMessages = result.messages as Record<string, unknown>[];
			const patchedMessages = applyCompressedMessages(
				messages as Record<string, unknown>[],
				compressedMessages,
			);

			return { messages: patchedMessages };
		} catch (err) {
			stats.errors++;
			// Silent failure — don't block the LLM call
		}
	});

	// -----------------------------------------------------------------------
	// Tools
	// -----------------------------------------------------------------------

	pi.registerTool({
		name: "headroom_compress",
		label: "Headroom Compress",
		description:
			"Compress text using Headroom AI to reduce token count while preserving meaning. " +
			"Use for large outputs (logs, search results, file contents) that need compression " +
			"before including in context. Returns compressed text and token savings.",
		parameters: Type.Object({
			text: Type.String({ description: "The text to compress" }),
			target_ratio: Type.Optional(
				Type.Number({
					description: "Target keep-ratio. 0.2 = aggressive (20% kept). 0.5 = moderate. Omit for default (~15%).",
					minimum: 0.05,
					maximum: 1,
				}),
			),
		}),
		async execute(_toolCallId, params, _ctx, signal) {
			if (!headroomAvailable) {
				throw new Error("Headroom is not available. Run /headroom setup to install.");
			}

			const result = (await callBridge(
				{
					action: "compress_text",
					text: params.text,
					model: "gpt-4o",
					tool_name: "headroom_compress",
					tool_profile_level: "aggressive",
					ccr_enabled: true,
					target_ratio: params.target_ratio,
				},
				30_000,
				signal,
			)) as unknown as CompressTextResult;

			if (result.error) throw new Error(`Compression failed: ${result.error}`);

			recordCompression(result.tokens_before, result.tokens_after, result.transforms_applied);

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
		name: "headroom_retrieve",
		label: "Headroom Retrieve",
		description: "Retrieve original uncompressed content from Headroom CCR using the hash shown in compression markers.",
		promptSnippet: "Retrieve original content from a Headroom compression marker",
		promptGuidelines:
			"Use headroom_retrieve when compressed output includes a marker like 'Retrieve more: hash=...'.",
		parameters: Type.Object({
			hash: Type.String({ description: "Hash from the compression marker." }),
			query: Type.Optional(Type.String({ description: "Optional search query to filter the retrieved content." })),
		}),
		async execute(_toolCallId, params, signal) {
			const result = await callBridge(
				{ action: "retrieve", hash: params.hash, query: params.query },
				15_000,
				signal,
			);

			const content =
				typeof result.content === "string"
					? result.content
					: JSON.stringify(result, null, 2);

			return {
				content: [{ type: "text", text: content }],
				details: result,
			};
		},
	});

	pi.registerTool({
		name: "headroom_stats",
		label: "Headroom Stats",
		description: "View cumulative compression statistics for the current session.",
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
							`  Auto-install: ${config.autoInstall ? "on" : "off"}\n` +
							`  Compression threshold: ${config.minTokensPct}% of ${ctx.model?.contextWindow ?? 200_000} token window (~${Math.floor(((ctx.model?.contextWindow ?? 200_000) * config.minTokensPct) / 100)} tokens)
` +
							`  Rust extension: ${hasRustExtension ? "yes" : "no"}\n` +
							`  Version: ${headroomVersion ?? "unknown"}\n` +
							`  Platform wheel: ${findBundledWheel() ? "bundled" : "none"}\n` +
							`  Config file: ${config.configPath}\n` +
							(transforms ? `\nTransforms used:\n${transforms}` : ""),
					},
				],
				details: {
					autoCompress,
					version: headroomVersion,
					config,
				},
			};
		},
	});

	// -----------------------------------------------------------------------
	// Commands
	// -----------------------------------------------------------------------

	pi.registerCommand("headroom", {
		description: "Headroom compression: toggle, check, setup, reload config, or show stats",
		handler: async (args, ctx) => {
			const sub = (args ?? "").trim().toLowerCase();

			if (sub === "toggle") {
				autoCompress = !autoCompress;
				ctx.ui.notify(`Headroom auto-compression: ${autoCompress ? "ON" : "OFF"}`, "info");
				refreshStatus(ctx);
				return;
			}

			if (sub === "reload" || sub === "config") {
				config = loadExtensionConfig();
				autoCompress = config.autoCompress;
				ctx.ui.notify(
					`Headroom config reloaded | auto=${autoCompress ? "on" : "off"} | threshold=${config.minTokensPct}%`,
					"info",
				);
				refreshStatus(ctx);
				return;
			}

			if (sub === "check") {
				try {
					const result = (await callBridge({ action: "check" }, 5_000)) as unknown as CheckResult;
					if (result.installed) {
						const rust = result.rust_extension ? " (Rust ext ✓)" : " (no Rust ext)";
						const wheel = findBundledWheel() ? " (bundled wheel available)" : "";
						ctx.ui.notify(`Headroom v${result.version}${rust}${wheel}`, "info");
					} else {
						ctx.ui.notify(`Headroom not installed. ${result.error ?? ""}`, "warning");
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
					let recheck: CheckResult;
					try {
						recheck = (await callBridge({ action: "check" }, 5_000)) as unknown as CheckResult;
					} catch {
						recheck = { installed: false };
					}
					headroomAvailable = recheck.installed;
					headroomVersion = recheck.version;
					hasRustExtension = recheck.rust_extension ?? false;
					if (headroomAvailable) {
						ctx.ui.notify(`Headroom v${headroomVersion} installed ✓`, "success");
					} else {
						ctx.ui.notify("Headroom installed but verification failed", "warning");
					}
				}
				refreshStatus(ctx);
				return;
			}

			if (sub === "clean") {
				const { rm } = await import("node:fs/promises");
				stopBridgeProcess();
				await rm(HEADROOM_VENV, { recursive: true, force: true });
				headroomAvailable = false;
				ctx.ui.notify("Headroom venv removed", "info");
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
