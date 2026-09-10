/**
 * pi-session-manager.ts
 *
 * Zero-bloat, 100% native extension for Pi Coding Agent.
 * Uses ONLY native Pi TUI primitives with zero event-loop blocking.
 * Rich dialog preview (first message + last message, folded middle), bounded height, async Git.
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { Buffer } from "node:buffer";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as process from "node:process";

// ── Types ───────────────────────────────────────────────────

interface SessionMeta {
	id?: string;
	name?: string;
	projectName: string;
	projectCwd: string;
	savedAt: string;
	sourceFile: string;
	platform: string;
}

interface SessionDialoguePreview {
	firstPrompt: string;
	firstReply: string;
	lastPrompt: string;
	lastReply: string;
	msgCount: number;
}

interface CloudSessionItem {
	file: string;
	fullPath: string;
	mtime: Date;
	size: number;
	meta: Partial<SessionMeta>;
	dialogue: SessionDialoguePreview;
}

interface ConfigManifestItem {
	type: "symlink" | "direct";
	linkRelAgent: string;
	targetRelHome?: string;
}

// ── Helpers ─────────────────────────────────────────────────

function expandTilde(filepath: string): string {
	if (filepath.startsWith("~/") || filepath === "~") {
		return path.join(os.homedir(), filepath.slice(1));
	}
	return path.resolve(filepath);
}

function detectDefaultStorageDir(): string {
	if (process.env.PI_STORAGE_DIR) {
		return expandTilde(process.env.PI_STORAGE_DIR);
	}
	if (fs.existsSync(path.join(os.homedir(), "OneDrive"))) {
		return path.join(os.homedir(), "OneDrive", "PiSync");
	}
	const cloudStorage = path.join(os.homedir(), "Library", "CloudStorage");
	if (fs.existsSync(cloudStorage)) {
		try {
			const od = fs
				.readdirSync(cloudStorage)
				.find((e: string) => e.startsWith("OneDrive"));
			if (od) return path.join(cloudStorage, od, "PiSync");
		} catch {
			/* ignore */
		}
	}
	return path.join(os.homedir(), ".pi-sync");
}

function getDirectories() {
	const base = detectDefaultStorageDir();
	const saveDir = process.env.PI_SAVE_SESSION
		? expandTilde(process.env.PI_SAVE_SESSION)
		: path.join(base, "sessions");

	let loadDir = path.join(base, "sessions");
	if (process.env.PI_LOAD_SESSION) {
		loadDir = expandTilde(process.env.PI_LOAD_SESSION);
	} else if (process.env.PI_SAVE_SESSION) {
		loadDir = expandTilde(process.env.PI_SAVE_SESSION);
	}

	const configDir = process.env.PI_STORAGE_DIR
		? path.join(expandTilde(process.env.PI_STORAGE_DIR), "config")
		: path.join(base, "config");

	return { saveDir, loadDir, configDir };
}

function getAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR
		? expandTilde(process.env.PI_CODING_AGENT_DIR)
		: path.join(os.homedir(), ".pi", "agent");
}

function sanitizeName(name: string): string {
	return name.trim().replace(/[/\\?%*:|"<> ]/g, "-");
}

function formatDate(d: Date): string {
	const p = (n: number) => n.toString().padStart(2, "0");
	return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function formatShortDate(d: Date): string {
	return `${d.getDate()}/${d.getMonth() + 1} ${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
}

function getSanitizedProjectDir(cwd: string): string {
	const resolved = path.resolve(cwd);
	const clean = resolved.replace(/^[/\\]+/, "").replace(/[/\\]+$/, "");
	return `--${clean.replace(/[/\\:]/g, "-")}--`;
}

// ── Git (fully async fire-and-forget, zero TUI freeze) ───────

function findGitRoot(startDir: string): string | null {
	let cur = startDir;
	while (cur && cur !== path.dirname(cur)) {
		if (fs.existsSync(path.join(cur, ".git"))) return cur;
		cur = path.dirname(cur);
	}
	return null;
}

function gitPullAsync(dir: string): void {
	const root = findGitRoot(dir);
	if (!root) return;
	execFile(
		"git",
		["pull", "--quiet", "--rebase"],
		{ cwd: root, timeout: 5000 },
		() => {},
	);
}

function gitPushAsync(dir: string, msg: string, files: string[]): void {
	const root = findGitRoot(dir);
	if (!root) return;
	const relPaths = files.map((f) => path.relative(root, f));
	execFile(
		"git",
		["add", "--", ...relPaths],
		{ cwd: root, timeout: 4000 },
		(err: Error | null) => {
			if (err) return;
			execFile(
				"git",
				["commit", "-m", msg, "--quiet"],
				{ cwd: root, timeout: 4000 },
				() => {
					execFile(
						"git",
						["push", "--quiet"],
						{ cwd: root, timeout: 8000 },
						() => {},
					);
				},
			);
		},
	);
}

// ── Fast Head + Tail Session Parsing (bounded I/O, max 128KB) ─

function extractText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (
			typeof block === "object" &&
			block !== null &&
			"type" in block &&
			block.type === "text" &&
			"text" in block &&
			typeof block.text === "string"
		) {
			parts.push(block.text);
		}
	}
	return parts.join(" ");
}

function parseCloudPreview(filePath: string): SessionDialoguePreview {
	let firstPrompt = "";
	let firstReply = "";
	let lastPrompt = "";
	let lastReply = "";
	let msgCount = 0;
	let fd: number | undefined;

	try {
		fd = fs.openSync(filePath, "r");
		const stat = fs.fstatSync(fd);
		const fileSize = stat.size;

		// 1. Read head chunk (first 64KB)
		const headSize = Math.min(fileSize, 64 * 1024);
		const headBuf = Buffer.alloc(headSize);
		fs.readSync(fd, headBuf, 0, headSize, 0);

		const headLines = headBuf.toString("utf8").split("\n");
		for (const raw of headLines) {
			const line = raw.trim();
			if (!line) continue;
			try {
				const entry = JSON.parse(line) as {
					type?: string;
					message?: { role?: string; content?: unknown };
				};
				if (entry.type === "message" && entry.message) {
					msgCount++;
					const text = extractText(entry.message.content)
						.replace(/[\r\n]+/g, " ")
						.trim();
					if (entry.message.role === "user") {
						if (!firstPrompt) firstPrompt = text;
						lastPrompt = text;
					} else if (entry.message.role === "assistant") {
						if (!firstReply) firstReply = text;
						lastReply = text;
					}
				}
			} catch {
				/* skip malformed line */
			}
		}

		// 2. If file > 64KB, read tail chunk (last 64KB) for actual end of conversation
		if (fileSize > 64 * 1024) {
			const tailOffset = fileSize - 64 * 1024;
			const tailBuf = Buffer.alloc(64 * 1024);
			fs.readSync(fd, tailBuf, 0, 64 * 1024, tailOffset);

			const tailLines = tailBuf.toString("utf8").split("\n");
			// Skip first partial line
			for (let i = 1; i < tailLines.length; i++) {
				const line = tailLines[i].trim();
				if (!line) continue;
				try {
					const entry = JSON.parse(line) as {
						type?: string;
						message?: { role?: string; content?: unknown };
					};
					if (entry.type === "message" && entry.message) {
						const text = extractText(entry.message.content)
							.replace(/[\r\n]+/g, " ")
							.trim();
						if (entry.message.role === "user" && text) {
							lastPrompt = text;
						} else if (entry.message.role === "assistant" && text) {
							lastReply = text;
						}
					}
				} catch {
					/* skip malformed line */
				}
			}
		}

		fs.closeSync(fd);
		fd = undefined;
	} catch {
		/* ignore */
	} finally {
		if (fd !== undefined) {
			try {
				fs.closeSync(fd);
			} catch {
				/* ignore */
			}
		}
	}

	return { firstPrompt, firstReply, lastPrompt, lastReply, msgCount };
}

function readHeaderId(filePath: string): string | undefined {
	let fd: number | undefined;
	try {
		fd = fs.openSync(filePath, "r");
		const buf = Buffer.alloc(8192);
		const n = fs.readSync(fd, buf, 0, buf.length, 0);
		fs.closeSync(fd);
		fd = undefined;
		const firstLine = buf.toString("utf8", 0, n).split("\n")[0];
		if (firstLine) {
			return (JSON.parse(firstLine.trim()) as { id?: string }).id;
		}
	} catch {
		/* ignore */
	} finally {
		if (fd !== undefined) {
			try {
				fs.closeSync(fd);
			} catch {
				/* ignore */
			}
		}
	}
	return undefined;
}

/** Formats a compact preview showing initial and final messages with intermediate truncation. */
function formatSessionPreview(
	title: string,
	proj: string,
	tag: string,
	mtimeStr: string,
	dialogue: SessionDialoguePreview,
	question: string,
): string {
	const p1 = dialogue.firstPrompt
		? `"${dialogue.firstPrompt.slice(0, 50)}${dialogue.firstPrompt.length > 50 ? "…" : ""}"`
		: "(nessun prompt)";
	const pLast =
		dialogue.lastPrompt && dialogue.lastPrompt !== dialogue.firstPrompt
			? `"${dialogue.lastPrompt.slice(0, 50)}${dialogue.lastPrompt.length > 50 ? "…" : ""}"`
			: "";
	const rLast = dialogue.lastReply
		? `"${dialogue.lastReply.slice(0, 50)}${dialogue.lastReply.length > 50 ? "…" : ""}"`
		: "";

	const lines: string[] = [
		`${title}`,
		`📁 ${proj}  🏷️ ${tag}  💬 ${dialogue.msgCount}m (${mtimeStr})`,
		`──────────────────────────────────────────────`,
		`🟢 INIZIO: 👤 ${p1}`,
	];

	if (pLast || (rLast && dialogue.msgCount > 2)) {
		lines.push(`   ⋯ [conversazione intermedia] ⋯`);
		if (pLast) lines.push(`🔴 FINE:   👤 ${pLast}`);
		if (rLast) lines.push(`          🤖 ${rLast}`);
	} else if (dialogue.firstReply) {
		const r1 = `"${dialogue.firstReply.slice(0, 50)}${dialogue.firstReply.length > 50 ? "…" : ""}"`;
		lines.push(`          🤖 ${r1}`);
	}

	lines.push(`──────────────────────────────────────────────`);
	lines.push(`${question}`);

	return lines.join("\n");
}

// ── Cloud Session Listing ───────────────────────────────────

function listCloudSessions(loadDir: string): CloudSessionItem[] {
	if (!fs.existsSync(loadDir)) return [];
	return fs
		.readdirSync(loadDir)
		.flatMap((f: string) => {
			if (!f.endsWith(".jsonl")) return [];
			const fullPath = path.join(loadDir, f);
			let stat: fs.Stats;
			try {
				stat = fs.statSync(fullPath);
			} catch {
				return [];
			}
			const metaPath = path.join(loadDir, f.replace(/\.jsonl$/, ".meta.json"));
			let meta: Partial<SessionMeta> = {};
			if (fs.existsSync(metaPath)) {
				try {
					meta = JSON.parse(
						fs.readFileSync(metaPath, "utf8"),
					) as Partial<SessionMeta>;
				} catch {
					/* ignore */
				}
			}
			const dialogue = parseCloudPreview(fullPath);
			return [
				{
					file: f,
					fullPath,
					mtime: stat.mtime,
					size: stat.size,
					meta,
					dialogue,
				},
			];
		})
		.sort(
			(a: CloudSessionItem, b: CloudSessionItem) =>
				b.mtime.getTime() - a.mtime.getTime(),
		);
}

function cloudSessionLabel(item: CloudSessionItem, idx: number): string {
	let proj = item.meta.projectName;
	let tag = item.meta.name;
	if (!proj || !tag) {
		const parts = item.file.replace(/\.jsonl$/, "").split("--");
		if (!proj && parts.length > 1) proj = parts[0];
		if (!tag) tag = parts.length > 1 ? parts[1] : item.file.slice(0, 16);
	}

	const projPrefix = proj ? `[${proj.slice(0, 10)}] ` : "";
	const tagText = tag ? tag.slice(0, 16) : "session";
	const snippet = item.dialogue.firstPrompt
		? ` "${item.dialogue.firstPrompt.slice(0, 20)}…"`
		: "";
	const badge =
		item.dialogue.msgCount > 0 ? ` (${item.dialogue.msgCount}m)` : "";
	const dateStr = formatShortDate(item.mtime);

	return `${idx + 1}. ${projPrefix}${tagText}${snippet}${badge} · ${dateStr}`;
}

// ── Re-home Logic ───────────────────────────────────────────

function rehomeSession(sourcePath: string, targetCwd: string): string {
	const sessionDirName = getSanitizedProjectDir(targetCwd);
	const targetDir = path.join(getAgentDir(), "sessions", sessionDirName);
	fs.mkdirSync(targetDir, { recursive: true });

	const rawContent = fs.readFileSync(sourcePath, "utf8").replace(/\r\n/g, "\n");
	const lines = rawContent.split("\n");
	if (lines.length === 0 || !lines[0].trim()) {
		throw new Error("File di sessione vuoto o non valido");
	}

	let header: Record<string, unknown>;
	try {
		header = JSON.parse(lines[0]) as Record<string, unknown>;
	} catch (e) {
		throw new Error(
			`Header non valido: ${e instanceof Error ? e.message : String(e)}`,
		);
	}

	const oldCwd = typeof header.cwd === "string" ? header.cwd : "";
	header.cwd = targetCwd;

	// Single-pass replacement on lines 1..end only
	let rest = lines.slice(1).join("\n");
	if (oldCwd && oldCwd !== targetCwd) {
		rest = rest.replaceAll(oldCwd, targetCwd);
	}
	const newContent = JSON.stringify(header) + "\n" + rest;

	const targetId = typeof header.id === "string" ? header.id : "";
	const destFilename = (() => {
		if (targetId && fs.existsSync(targetDir)) {
			for (const f of fs.readdirSync(targetDir)) {
				if (!f.endsWith(".jsonl")) continue;
				const existingId = readHeaderId(path.join(targetDir, f));
				if (existingId === targetId) return f;
			}
		}
		const metaPath = sourcePath.replace(/\.jsonl$/, ".meta.json");
		if (fs.existsSync(metaPath)) {
			try {
				const meta = JSON.parse(
					fs.readFileSync(metaPath, "utf8"),
				) as Partial<SessionMeta>;
				if (meta.sourceFile) return meta.sourceFile;
			} catch {
				/* ignore */
			}
		}
		return path.basename(sourcePath);
	})();

	let destFile = path.join(targetDir, destFilename);
	if (fs.existsSync(destFile)) {
		const existingId = readHeaderId(destFile);
		if (existingId && targetId && existingId !== targetId) {
			const ts = new Date().toISOString().replace(/[:.]/g, "-");
			destFile = path.join(targetDir, `${ts}_${destFilename}`);
		}
	}

	fs.writeFileSync(destFile, newContent, "utf8");
	return destFile;
}

// ── Clean Copy Helper ───────────────────────────────────────

function cleanCopy(
	src: string,
	dst: string,
	opts?: { recursive?: boolean; dereference?: boolean },
): void {
	try {
		fs.rmSync(dst, { force: true, recursive: true });
	} catch {
		/* ignore */
	}
	fs.cpSync(src, dst, {
		recursive: opts?.recursive ?? false,
		dereference: opts?.dereference ?? false,
		filter: (source: string) => {
			const base = path.basename(source);
			if (base === ".git" || base === "node_modules" || base.endsWith(".bak")) {
				return false;
			}
			return true;
		},
	});
}

// ── Extension Entry Point ───────────────────────────────────

export default function (pi: ExtensionAPI): void {
	// ─── 1. SESSION PUSH (/session-push [tag]) ───────────────
	const handleSessionPush = async (
		args: string,
		ctx: ExtensionCommandContext,
	): Promise<void> => {
		const activeFile = ctx.sessionManager.getSessionFile();
		if (!activeFile || !fs.existsSync(activeFile)) {
			ctx.ui.notify(
				"Nessun file di sessione attivo. Avvia prima una conversazione.",
				"warning",
			);
			return;
		}

		const { saveDir } = getDirectories();
		fs.mkdirSync(saveDir, { recursive: true });
		gitPullAsync(saveDir);

		const projectName = path.basename(ctx.cwd);
		const tag = args.trim() || formatDate(new Date());
		const cleanTag = sanitizeName(tag);
		const targetFilename = `${projectName}--${cleanTag}.jsonl`;
		const targetPath = path.join(saveDir, targetFilename);

		const dialogue = parseCloudPreview(activeFile);
		const skipConfirm = args.includes("--yes") || args.includes("-y");

		if (fs.existsSync(targetPath) && ctx.hasUI) {
			const ok = await ctx.ui.confirm(
				"Sovrascrivere sessione?",
				`Esiste già "${cleanTag}" in Cloud.\nVuoi sovrascriverla?`,
			);
			if (!ok) {
				ctx.ui.notify("Salvataggio annullato", "info");
				return;
			}
		} else if (!skipConfirm && ctx.hasUI) {
			const ok = await ctx.ui.confirm(
				"Salvare sessione nel Cloud?",
				formatSessionPreview(
					"Salvare sessione attiva nel Cloud?",
					projectName,
					cleanTag,
					"ora",
					dialogue,
					"Confermi il salvataggio su OneDrive/Cloud?",
				),
			);
			if (!ok) {
				ctx.ui.notify("Salvataggio annullato", "info");
				return;
			}
		}

		fs.copyFileSync(activeFile, targetPath);

		const meta: SessionMeta = {
			id: ctx.sessionManager.getSessionId(),
			name: cleanTag,
			projectName,
			projectCwd: ctx.cwd,
			savedAt: new Date().toISOString(),
			sourceFile: path.basename(activeFile),
			platform: process.platform,
		};
		const metaPath = path.join(saveDir, `${projectName}--${cleanTag}.meta.json`);
		fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

		gitPushAsync(saveDir, `session: ${targetFilename}`, [targetPath, metaPath]);
		ctx.ui.notify(`✅ Sessione salvata nel Cloud: "${cleanTag}"`, "info");
	};

	pi.registerCommand("session-push", {
		description: "Salva la sessione attiva su OneDrive/Cloud con anteprima",
		handler: handleSessionPush,
	});

	// ─── 2. SESSION PULL (/session-pull) ────────────────────
	const handleSessionPull = async (
		_args: string,
		ctx: ExtensionCommandContext,
	): Promise<void> => {
		if (!ctx.hasUI) {
			ctx.ui.notify("/session-pull richiede interfaccia TUI", "warning");
			return;
		}

		const { loadDir } = getDirectories();
		gitPullAsync(loadDir);

		const files = listCloudSessions(loadDir);
		if (files.length === 0) {
			ctx.ui.notify(`Nessuna sessione trovata in Cloud (${loadDir})`, "info");
			return;
		}

		const options = files.map(cloudSessionLabel);
		const choice = await ctx.ui.select(
			"Scegli sessione Cloud da riprendere:",
			options,
		);
		if (!choice) return;

		const idx = options.indexOf(choice);
		if (idx === -1) return;
		const selected = files[idx];

		const tag = selected.meta.name || selected.file;
		const proj = selected.meta.projectName || path.basename(ctx.cwd);
		const ok = await ctx.ui.confirm(
			"Riprendere sessione?",
			formatSessionPreview(
				"Riprendere sessione dal Cloud?",
				proj,
				tag,
				formatShortDate(selected.mtime),
				selected.dialogue,
				"Confermi il ripristino (Re-home) nel progetto attuale?",
			),
		);
		if (!ok) return;

		try {
			const dest = rehomeSession(selected.fullPath, ctx.cwd);
			await ctx.switchSession(dest, {
				withSession: async (newCtx: ExtensionCommandContext) => {
					newCtx.ui.notify(`✅ Sessione ripresa: ${path.basename(dest)}`, "info");
				},
			});
		} catch (err) {
			ctx.ui.notify(
				`Errore resume: ${err instanceof Error ? err.message : String(err)}`,
				"error",
			);
		}
	};

	pi.registerCommand("session-pull", {
		description:
			"Scegli e riprendi una sessione dal Cloud con anteprima (Re-home)",
		handler: handleSessionPull,
	});

	// ─── 3. SESSION LIST (/session-list) ────────────────────
	const handleSessionList = async (
		_args: string,
		ctx: ExtensionCommandContext,
	): Promise<void> => {
		const { loadDir } = getDirectories();
		gitPullAsync(loadDir);

		const files = listCloudSessions(loadDir);
		if (files.length === 0) {
			ctx.ui.notify(`Nessuna sessione trovata in Cloud (${loadDir})`, "info");
			return;
		}

		const options = files.map(cloudSessionLabel);
		const choice = await ctx.ui.select("Sessioni Cloud:", options);
		if (!choice) return;

		const idx = options.indexOf(choice);
		if (idx === -1) return;
		const selected = files[idx];

		const tag = selected.meta.name || selected.file;
		const proj = selected.meta.projectName || path.basename(ctx.cwd);
		const action = await ctx.ui.select(`Sessione: ${tag}`, [
			"1. 👁️ Anteprima & Riprendi",
			"2. 🗑️ Elimina dal Cloud",
			"3. ✖️ Annulla",
		]);
		if (!action || action.startsWith("3")) return;

		if (action.startsWith("1")) {
			const ok = await ctx.ui.confirm(
				"Riprendere sessione?",
				formatSessionPreview(
					"Riprendere sessione dal Cloud?",
					proj,
					tag,
					formatShortDate(selected.mtime),
					selected.dialogue,
					"Riprendere questa sessione adesso?",
				),
			);
			if (!ok) return;

			try {
				const dest = rehomeSession(selected.fullPath, ctx.cwd);
				await ctx.switchSession(dest, {
					withSession: async (newCtx) => {
						newCtx.ui.notify(`✅ Sessione ripresa: ${path.basename(dest)}`, "info");
					},
				});
			} catch (err) {
				ctx.ui.notify(
					`Errore: ${err instanceof Error ? err.message : String(err)}`,
					"error",
				);
			}
		} else if (action.startsWith("2")) {
			const ok = await ctx.ui.confirm(
				"Eliminare sessione?",
				formatSessionPreview(
					"Eliminare sessione dal Cloud?",
					proj,
					tag,
					formatShortDate(selected.mtime),
					selected.dialogue,
					"Eliminare definitivamente dal Cloud?",
				),
			);
			if (!ok) return;

			try {
				const metaPath = selected.fullPath.replace(/\.jsonl$/, ".meta.json");
				if (fs.existsSync(selected.fullPath)) fs.unlinkSync(selected.fullPath);
				if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
				gitPushAsync(loadDir, `session: delete ${selected.file}`, [
					selected.fullPath,
					metaPath,
				]);
				ctx.ui.notify(`🗑️ Sessione eliminata: ${tag}`, "info");
			} catch (err) {
				ctx.ui.notify(
					`Errore eliminazione: ${err instanceof Error ? err.message : String(err)}`,
					"error",
				);
			}
		}
	};

	pi.registerCommand("session-list", {
		description:
			"Visualizza sessioni Cloud con anteprima, ripristino ed eliminazione",
		handler: handleSessionList,
	});

	// ─── 4. SESSION DELETE (/session-delete) ────────────────
	const handleSessionDelete = async (
		_args: string,
		ctx: ExtensionCommandContext,
	): Promise<void> => {
		const { loadDir } = getDirectories();
		gitPullAsync(loadDir);

		const files = listCloudSessions(loadDir);
		if (files.length === 0) {
			ctx.ui.notify(`Nessuna sessione trovata in Cloud (${loadDir})`, "info");
			return;
		}

		const options = files.map(cloudSessionLabel);
		const choice = await ctx.ui.select(
			"Scegli sessione Cloud da eliminare:",
			options,
		);
		if (!choice) return;

		const idx = options.indexOf(choice);
		if (idx === -1) return;
		const selected = files[idx];

		const tag = selected.meta.name || selected.file;
		const proj = selected.meta.projectName || path.basename(ctx.cwd);
		const ok = await ctx.ui.confirm(
			"Eliminare sessione?",
			formatSessionPreview(
				"Eliminare sessione dal Cloud?",
				proj,
				tag,
				formatShortDate(selected.mtime),
				selected.dialogue,
				"Eliminare definitivamente dal Cloud?",
			),
		);
		if (!ok) return;

		try {
			const metaPath = selected.fullPath.replace(/\.jsonl$/, ".meta.json");
			if (fs.existsSync(selected.fullPath)) fs.unlinkSync(selected.fullPath);
			if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
			gitPushAsync(loadDir, `session: delete ${selected.file}`, [
				selected.fullPath,
				metaPath,
			]);
			ctx.ui.notify(`🗑️ Sessione eliminata: ${tag}`, "info");
		} catch (err) {
			ctx.ui.notify(
				`Errore eliminazione: ${err instanceof Error ? err.message : String(err)}`,
				"error",
			);
		}
	};

	pi.registerCommand("session-delete", {
		description: "Elimina una sessione dal Cloud con anteprima",
		handler: handleSessionDelete,
	});

	// ─── 5. CONFIG PUSH (/config-push) ──────────────────────
	const handleConfigPush = (
		_args: string,
		ctx: ExtensionCommandContext,
	): void => {
		const { configDir } = getDirectories();
		const agentDir = getAgentDir();
		gitPullAsync(configDir);
		fs.mkdirSync(configDir, { recursive: true });

		let symlinkCount = 0;
		let directCount = 0;
		const manifest: ConfigManifestItem[] = [];
		const touchedFiles: string[] = [];

		// 1. Root configuration files
		const rootConfigFiles = [
			"settings.json",
			"AGENTS.md",
			"APPEND_SYSTEM.md",
			"SYSTEM.md",
			"models.json",
			"keybindings.json",
		];
		for (const fname of rootConfigFiles) {
			const src = path.join(agentDir, fname);
			const dst = path.join(configDir, fname);
			if (fs.existsSync(src)) {
				fs.copyFileSync(src, dst);
				touchedFiles.push(dst);
			}
		}

		// 2. Prompts and Themes directories
		for (const folder of ["prompts", "themes"]) {
			const src = path.join(agentDir, folder);
			const dst = path.join(configDir, folder);
			if (fs.existsSync(src)) {
				cleanCopy(src, dst, { recursive: true });
				touchedFiles.push(dst);
			}
		}

		// 3. skills/ & extensions/
		for (const folder of ["skills", "extensions"]) {
			const srcFolder = path.join(agentDir, folder);
			if (!fs.existsSync(srcFolder)) continue;

			for (const entry of fs.readdirSync(srcFolder)) {
				if (
					entry === "node_modules" ||
					entry === ".git" ||
					entry.endsWith(".bak") ||
					entry.endsWith(".preimport.bak")
				)
					continue;

				const entryPath = path.join(srcFolder, entry);
				const relAgent = `${folder}/${entry}`;
				let lstat: fs.Stats;
				try {
					lstat = fs.lstatSync(entryPath);
				} catch {
					continue;
				}

				if (lstat.isSymbolicLink()) {
					try {
						const resolved = fs.realpathSync(entryPath);
						if (!fs.existsSync(resolved)) continue;

						if (resolved.startsWith(os.homedir())) {
							const relHome = path.relative(os.homedir(), resolved);
							const dst = path.join(configDir, "home_targets", relHome);
							fs.mkdirSync(path.dirname(dst), { recursive: true });
							cleanCopy(resolved, dst, { recursive: true, dereference: true });
							manifest.push({
								type: "symlink",
								linkRelAgent: relAgent,
								targetRelHome: relHome,
							});
							touchedFiles.push(dst);
							symlinkCount++;
						} else {
							const dst = path.join(configDir, folder, entry);
							fs.mkdirSync(path.dirname(dst), { recursive: true });
							cleanCopy(resolved, dst, { recursive: true, dereference: true });
							manifest.push({ type: "direct", linkRelAgent: relAgent });
							touchedFiles.push(dst);
							directCount++;
						}
					} catch {
						/* broken symlink */
					}
				} else {
					const dst = path.join(configDir, folder, entry);
					fs.mkdirSync(path.dirname(dst), { recursive: true });
					cleanCopy(entryPath, dst, { recursive: true });
					manifest.push({ type: "direct", linkRelAgent: relAgent });
					touchedFiles.push(dst);
					directCount++;
				}
			}
		}

		const manifestPath = path.join(configDir, "manifest.json");
		fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
		touchedFiles.push(manifestPath);

		gitPushAsync(
			configDir,
			"config: update settings, skills & symlink targets",
			touchedFiles,
		);

		ctx.ui.notify(
			`✅ Config salvata in Cloud (${symlinkCount} symlink, ${directCount} diretti)`,
			"info",
		);
	};

	pi.registerCommand("config-push", {
		description: "Salva settings, prompts e skills su Cloud (Strategia 4)",
		handler: handleConfigPush,
	});

	// ─── 6. CONFIG PULL (/config-pull) ──────────────────────
	const handleConfigPull = async (
		_args: string,
		ctx: ExtensionCommandContext,
	) => {
		const { configDir } = getDirectories();
		const agentDir = getAgentDir();
		gitPullAsync(configDir);

		if (!fs.existsSync(configDir)) {
			ctx.ui.notify(`Cartella backup non trovata: ${configDir}`, "warning");
			return;
		}

		if (ctx.hasUI) {
			const ok = await ctx.ui.confirm(
				"Ripristinare configurazione?",
				"Verranno aggiornati settings.json, prompts, skills ed extensions su disco.\nLa sessione attiva non sarà modificata.\n\nProcedere?",
			);
			if (!ok) return;
		}

		// 1. Root configuration files with backup
		const rootConfigFiles = [
			"settings.json",
			"AGENTS.md",
			"APPEND_SYSTEM.md",
			"SYSTEM.md",
			"models.json",
			"keybindings.json",
		];
		for (const fname of rootConfigFiles) {
			const src = path.join(configDir, fname);
			const dst = path.join(agentDir, fname);
			if (fs.existsSync(src)) {
				if (fs.existsSync(dst)) {
					fs.copyFileSync(dst, `${dst}.preimport.bak`);
				}
				fs.copyFileSync(src, dst);
			}
		}

		// 2. Prompts and Themes directories
		for (const folder of ["prompts", "themes"]) {
			const src = path.join(configDir, folder);
			const dst = path.join(agentDir, folder);
			if (fs.existsSync(src)) {
				cleanCopy(src, dst, { recursive: true });
			}
		}

		// 3. manifest
		const manifestFile = path.join(configDir, "manifest.json");
		if (fs.existsSync(manifestFile)) {
			try {
				const manifest = JSON.parse(
					fs.readFileSync(manifestFile, "utf8"),
				) as ConfigManifestItem[];

				for (const item of manifest) {
					if (item.type === "symlink" && item.targetRelHome) {
						const physTarget = path.join(os.homedir(), item.targetRelHome);
						const storageSrc = path.join(
							configDir,
							"home_targets",
							item.targetRelHome,
						);
						if (fs.existsSync(storageSrc)) {
							fs.mkdirSync(path.dirname(physTarget), { recursive: true });
							cleanCopy(storageSrc, physTarget, { recursive: true });
						}
						const linkPath = path.join(agentDir, item.linkRelAgent);
						fs.mkdirSync(path.dirname(linkPath), { recursive: true });
						try {
							fs.rmSync(linkPath, { force: true, recursive: true });
						} catch {
							/* ignore */
						}
						const isDir =
							fs.existsSync(physTarget) && fs.statSync(physTarget).isDirectory();
						fs.symlinkSync(
							path.relative(path.dirname(linkPath), physTarget),
							linkPath,
							isDir ? "dir" : "file",
						);
					} else if (item.type === "direct") {
						const src = path.join(configDir, item.linkRelAgent);
						const dst = path.join(agentDir, item.linkRelAgent);
						if (fs.existsSync(src)) {
							fs.mkdirSync(path.dirname(dst), { recursive: true });
							cleanCopy(src, dst, { recursive: true });
						}
					}
				}
			} catch (err) {
				ctx.ui.notify(
					`Errore manifest: ${err instanceof Error ? err.message : String(err)}`,
					"warning",
				);
			}
		}

		ctx.ui.notify(
			"✅ Config ripristinata su disco. Esegui /reload per applicarla.",
			"info",
		);
	};

	pi.registerCommand("config-pull", {
		description: "Ripristina settings e skills dal Cloud su disco a freddo",
		handler: handleConfigPull,
	});
}
