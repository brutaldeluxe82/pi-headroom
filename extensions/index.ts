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

type CompressionLevel = "off" | "conservative" | "moderate" | "aggressive";

interface ToolProfile {
	level: CompressionLevel;
	enabled: boolean;
}

interface ExtensionConfig {
	autoCompress: boolean;
	autoInstall: boolean;
	minTokensToCompress: number;
	minTokensSaved: number;
	toolProfiles: Record<string, ToolProfile>;
	configPath: string;
	sourceSummary: string[];
}

interface RawConfigFile {
	autoCompress?: boolean;
	autoInstall?: boolean;
	minTokensToCompress?: number;
	minTokensSaved?: number;
	toolProfiles?: Record<string, CompressionLevel | { level?: CompressionLevel; enabled?: boolean }>;
}

// ---------------------------------------------------------------------------
// Python Bridge
// ---------------------------------------------------------------------------

let bridgeProc: ChildProcessWithoutNullStreams | undefined;
let bridgeSeq = 0;
const bridgePending = new Map<number, {
	resolve: (value: Record<string, unknown>) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}>();

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
			// Ignore malformed bridge lines. stderr is still available for debugging.
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
	timeoutMs = 15_000,
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
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_TOOL_LEVELS: Record<string, CompressionLevel> = {
	bash: "moderate",
	read: "moderate",
	grep: "moderate",
	find: "moderate",
	ls: "moderate",
	mcp_exa_exa_search: "moderate",
	"mcp_context7_resolve-library-id": "moderate",
	"mcp_context7_query-docs": "moderate",
	synthetic_web_search: "moderate",
	headroom_compress: "moderate",
};

const PROFILE_PRESETS: Record<CompressionLevel, Omit<ToolProfile, "level">> = {
	off: { enabled: false },
	conservative: { enabled: true },
	moderate: { enabled: true },
	aggressive: { enabled: true },
};

function normalizeToolName(name: string): string {
	return name.trim().toLowerCase();
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
	if (value == null || value === "") return fallback;
	const normalized = value.trim().toLowerCase();
	if (["1", "true", "yes", "on"].includes(normalized)) return true;
	if (["0", "false", "no", "off"].includes(normalized)) return false;
	return fallback;
}

function parseIntEnv(value: string | undefined, fallback: number): number {
	if (value == null || value === "") return fallback;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function estimateTokens(text: string): number {
	return Math.floor(text.length / 4);
}

function configFilePath(): string {
	// 1. Explicit workspace override (highest priority)
	const workspace = process.env.HEADROOM_WORKSPACE_DIR;
	if (workspace) return resolve(workspace, ".headroom", "pi-extension.json");

	// 2. Project-level config (CWD)
	const cwdPath = resolve(process.cwd(), ".headroom", "pi-extension.json");
	if (existsSync(cwdPath)) return cwdPath;

	// 3. Pi agent config directory fallback (e.g. ~/.config/pi/.headroom/)
	const piAgentDir = process.env.PI_CODING_AGENT_DIR;
	if (piAgentDir) {
		const expanded = piAgentDir.startsWith("~/")
			? resolve(homedir(), piAgentDir.slice(2))
			: piAgentDir.startsWith("~")
				? resolve(homedir(), piAgentDir.slice(1))
				: piAgentDir;
		const piPath = resolve(expanded, ".headroom", "pi-extension.json");
		if (existsSync(piPath)) return piPath;
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

function buildToolProfile(
	level: CompressionLevel,
	overrides?: Partial<Omit<ToolProfile, "level">>,
): ToolProfile {
	return {
		level,
		...PROFILE_PRESETS[level],
		...overrides,
		enabled: overrides?.enabled ?? PROFILE_PRESETS[level].enabled,
	};
}

function parseToolProfiles(
	base: Record<string, ToolProfile>,
	raw?: RawConfigFile["toolProfiles"],
): Record<string, ToolProfile> {
	const next = { ...base };
	if (!raw) return next;
	for (const [toolName, value] of Object.entries(raw)) {
		const key = normalizeToolName(toolName);
		if (typeof value === "string") {
			next[key] = buildToolProfile(value);
			continue;
		}
		const level = value.level ?? "moderate";
		next[key] = buildToolProfile(level, {
			enabled: value.enabled,
		});
	}
	return next;
}

function parseToolProfilesEnv(
	base: Record<string, ToolProfile>,
	envValue: string | undefined,
): Record<string, ToolProfile> {
	const next = { ...base };
	if (!envValue) return next;
	for (const entry of envValue.split(",").map((e) => e.trim()).filter(Boolean)) {
		const [toolName, levelRaw] = entry.split(":", 2);
		const level = (levelRaw?.trim().toLowerCase() || "") as CompressionLevel;
		if (!toolName || !(level in PROFILE_PRESETS)) continue;
		next[normalizeToolName(toolName)] = buildToolProfile(level);
	}
	return next;
}

function loadExtensionConfig(): ExtensionConfig {
	const path = configFilePath();
	const fileConfig = loadConfigFile(path);
	const sources: string[] = [];

	const envAutoCompress = process.env.HEADROOM_PI_AUTO_COMPRESS ?? process.env.HEADROOM_OPTIMIZE;
	const envAutoInstall = process.env.HEADROOM_PI_AUTO_INSTALL;
	const envMinTokens = process.env.HEADROOM_PI_MIN_TOKENS ?? process.env.HEADROOM_MIN_TOKENS;
	const envMinSaved = process.env.HEADROOM_PI_MIN_TOKENS_SAVED;

	const mode = (process.env.HEADROOM_MODE || "").trim().toLowerCase();
	const modeForcesDisable = mode === "audit";

	let toolProfiles: Record<string, ToolProfile> = {};
	for (const [toolName, level] of Object.entries(DEFAULT_TOOL_LEVELS)) {
		toolProfiles[normalizeToolName(toolName)] = buildToolProfile(level);
	}
	toolProfiles = parseToolProfiles(toolProfiles, fileConfig?.toolProfiles);
	toolProfiles = parseToolProfilesEnv(toolProfiles, process.env.HEADROOM_TOOL_PROFILES);

	if (fileConfig) sources.push(`file:${path}`);
	if (process.env.HEADROOM_TOOL_PROFILES) sources.push("env:HEADROOM_TOOL_PROFILES");
	if (envAutoCompress) sources.push(process.env.HEADROOM_PI_AUTO_COMPRESS ? "env:HEADROOM_PI_AUTO_COMPRESS" : "env:HEADROOM_OPTIMIZE");
	if (envAutoInstall) sources.push("env:HEADROOM_PI_AUTO_INSTALL");
	if (envMinTokens) sources.push(process.env.HEADROOM_PI_MIN_TOKENS ? "env:HEADROOM_PI_MIN_TOKENS" : "env:HEADROOM_MIN_TOKENS");
	if (envMinSaved) sources.push("env:HEADROOM_PI_MIN_TOKENS_SAVED");
	if (modeForcesDisable) sources.push("env:HEADROOM_MODE=audit");

	return {
		autoCompress: modeForcesDisable
			? false
			: parseBool(envAutoCompress, fileConfig?.autoCompress ?? true),
		autoInstall: parseBool(envAutoInstall, fileConfig?.autoInstall ?? true),
		minTokensToCompress: parseIntEnv(envMinTokens, fileConfig?.minTokensToCompress ?? 500),
		minTokensSaved: parseIntEnv(envMinSaved, fileConfig?.minTokensSaved ?? 50),
		toolProfiles,
		configPath: path,
		sourceSummary: sources,
	};
}

function profileForTool(config: ExtensionConfig, toolName: string): ToolProfile | undefined {
	return config.toolProfiles[normalizeToolName(toolName)];
}

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
	process.once("exit", () => stopBridgeProcess());
	let headroomAvailable = false;
	let headroomVersion: string | undefined;
	let hasRustExtension = false;
	let config = loadExtensionConfig();
	let autoCompress = config.autoCompress;
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
		config = loadExtensionConfig();
		autoCompress = config.autoCompress;

		// Quick check: is headroom already installed?
		try {
			ctx.ui.notify(`Headroom: checking bridge...`, "info");
			if (config.sourceSummary.length > 0) {
				ctx.ui.notify(`Headroom config loaded from ${config.sourceSummary.join(", ")}`, "info");
			}
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
			} else if (!installedThisSession && config.autoInstall) {
				installedThisSession = true;
				ctx.ui.notify("Headroom: first run — installing automatically...", "info");

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
							ctx.ui.notify(`Headroom v${headroomVersion} installed ✓`, "success");
						}
					} catch {
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
					try {
						const recheck = (await callBridge(
							{ action: "check" },
							5_000,
						)) as unknown as CheckResult;
						headroomAvailable = recheck.installed;
						headroomVersion = recheck.version;
						hasRustExtension = recheck.rust_extension ?? false;
						if (headroomAvailable) {
							ctx.ui.notify(`Headroom v${headroomVersion} installed ✓`, "success");
						}
					} catch {
						ctx.ui.notify("Headroom installed but verification failed", "warning");
					}
				}
			} else {
				ctx.ui.notify(
					config.autoInstall
						? "Headroom: Python not available. Install Python 3.12+ and uv."
						: "Headroom: bridge unavailable and auto-install is disabled.",
					"warning",
				);
			}
		}

		stats.requests = 0;
		stats.tokensBefore = 0;
		stats.tokensAfter = 0;
		stats.tokensSaved = 0;
		stats.errors = 0;
		stats.transformsUsed = {};

		refreshStatus(ctx);
	});

	// ---- Tool result compression ----

	pi.on("tool_result", async (event, ctx) => {
		if (!headroomAvailable || !autoCompress) return undefined;
		if (event.isError) return undefined;
		const profile = profileForTool(config, event.toolName);
		if (!profile?.enabled) return undefined;

		const text = extractTextFromContent(event.content);
		const estimatedTokens = estimateTokens(text);
		if (estimatedTokens < config.minTokensToCompress) return undefined;

		try {
			const model = ctx.model?.id ?? "gpt-4o";
			const result = (await callBridge(
				{
					action: "compress_text",
					text,
					model,
					tool_name: event.toolName,
					tool_profile_level: profile.level,
					ccr_enabled: true,
				},
				15_000,
				ctx.signal,
			)) as unknown as CompressTextResult;

			if (result.error) {
				stats.errors++;
				return undefined;
			}

			if (result.tokens_saved < config.minTokensSaved) return undefined;

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
					tool_name: "headroom_compress",
					tool_profile_level: "aggressive",
					ccr_enabled: true,
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
		name: "headroom_retrieve",
		label: "Headroom Retrieve",
		description:
			"Retrieve original uncompressed content from Headroom CCR using the hash shown in compression markers.",
		promptSnippet: "Retrieve original content from a Headroom compression marker",
		promptGuidelines: [
			"Use headroom_retrieve when compressed output includes a marker like 'Retrieve more: hash=...'.",
		],
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
			const content = typeof result.content === "string"
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

			const configuredTools = Object.entries(config.toolProfiles)
				.filter(([, profile]) => profile.enabled)
				.map(([name, profile]) => `${name}:${profile.level}`)
				.sort()
				.join(", ");

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
							`  Min tokens to compress: ${config.minTokensToCompress}\n` +
							`  Min tokens saved: ${config.minTokensSaved}\n` +
							`  Rust extension: ${hasRustExtension ? "yes" : "no"}\n` +
							`  Version: ${headroomVersion ?? "unknown"}\n` +
							`  Platform wheel: ${findBundledWheel() ? "bundled" : "none"}\n` +
							`  Config file: ${config.configPath}\n` +
							`  Tool profiles: ${configuredTools || "none"}\n` +
							(transforms ? `\nTransforms used:\n${transforms}` : ""),
					},
				],
				details: { ...stats, autoCompress, version: headroomVersion, config },
			};
		},
	});

	// ---- Commands ----

	pi.registerCommand("headroom", {
		description:
			"Headroom compression: toggle, check, setup, reload config, or show stats",
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

			if (sub === "reload" || sub === "config") {
				config = loadExtensionConfig();
				autoCompress = config.autoCompress;
				const configuredTools = Object.entries(config.toolProfiles)
					.filter(([, profile]) => profile.enabled)
					.map(([name, profile]) => `${name}:${profile.level}`)
					.sort()
					.join(", ");
				ctx.ui.notify(
					`Headroom config reloaded | auto=${autoCompress ? "on" : "off"} | minTokens=${config.minTokensToCompress} | tools=${configuredTools || "none"}`,
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
				stopBridgeProcess();
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
