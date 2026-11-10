/**
 * /plain — 把当前会话渲染成无格式纯文本，方便鼠标选择复制
 *
 * 行为（TUI 模式，全屏默认）：
 *   - 打开一个全屏纯文本视图：会话按时间顺序展开（用户/助手/工具调用/工具结果），
 *     无任何 ANSI 样式与 Markdown 渲染
 *   - 鼠标滚轮滚动；鼠标拖拽选中文字，松开后自动复制到系统剪贴板
 *     （复用 pi 内置的选中复制通道，本地/WSL/SSH 均支持）
 *   - 键盘：g=顶部 G=底部 PgUp/PgDn/空格/b 滚动，c=复制全部，w=写入临时文件，q/Esc=关闭
 *
 * print 模式将纯文本写入 stderr + 临时文件；其他非 TUI 模式仅写临时文件并提示路径。
 *
 * 安装：
 *   - 全局自动发现：~/.pi/agent/extensions/plain/index.ts
 *   - 项目级：.pi/extensions/plain/index.ts
 *   - 临时加载：pi --extension /path/to/index.ts
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyToClipboard, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import {
	isKeyRelease,
	isViewportTUI,
	matchesKey,
	ScrollView,
	stripTerminalSequences,
	Text,
	VStack,
	type Component,
	type TUI,
} from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// 会话 → 纯文本
// ---------------------------------------------------------------------------

type ContentBlock = { type: string; text?: string; name?: string; arguments?: unknown };

interface SessionMessageLike {
	role: string;
	content?: string | ContentBlock[];
	toolName?: string;
	isError?: boolean;
}

interface SessionEntryLike {
	type: string;
	timestamp?: string;
	message?: SessionMessageLike | null;
	summary?: string;
	note?: string;
	customType?: string;
	content?: string | ContentBlock[];
}

function collapseWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function clip(text: string, max: number): string {
	const plain = collapseWhitespace(text);
	return plain.length > max ? `${plain.slice(0, max)}…` : plain;
}

function textBlocksOf(content: string | ContentBlock[] | undefined): string[] {
	const lines: string[] = [];
	if (typeof content === "string") {
		if (content.length > 0) lines.push(content);
		return lines;
	}
	if (Array.isArray(content)) {
		for (const block of content) {
			if (block.type === "text" && block.text) lines.push(block.text);
		}
	}
	return lines;
}

function timestampOf(entry: SessionEntryLike): string {
	if (!entry.timestamp) return "";
	const date = new Date(entry.timestamp);
	if (Number.isNaN(date.getTime())) return "";
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 把会话当前分支的条目展开成无格式纯文本行。 */
export function buildPlainLines(entries: readonly SessionEntryLike[]): string[] {
	const lines: string[] = [];
	for (const entry of entries) {
		const ts = timestampOf(entry);
		switch (entry.type) {
			case "message": {
				const message = entry.message;
				if (!message) break;
				const role = message.role;
				if (role === "user") {
					lines.push("", `── 用户 ${ts} ──`.trimEnd());
					lines.push(...textBlocksOf(message.content));
				} else if (role === "assistant") {
					lines.push("", `── 助手 ${ts} ──`.trimEnd());
					if (typeof message.content === "string") {
						lines.push(message.content);
					} else if (Array.isArray(message.content)) {
						for (const block of message.content) {
							switch (block.type) {
								case "text":
									if (block.text) lines.push(block.text);
									break;
								case "thinking":
									if (block.text) lines.push(`[思考] ${clip(block.text, 200)}`);
									break;
								case "toolCall": {
									let args = "";
									try {
										args =
											block.arguments === undefined
												? ""
												: clip(JSON.stringify(block.arguments), 400);
									} catch {
										args = clip(String(block.arguments), 400);
									}
									lines.push(`[工具调用 ${block.name ?? "unknown"}]${args ? ` ${args}` : ""}`);
									break;
								}
								default:
									break;
							}
						}
					}
				} else if (role === "toolResult") {
					const header = `── 工具结果 ${message.toolName ?? ""}${message.isError ? " [错误]" : ""} ${ts} ──`
						.replace(/\s+/g, " ")
						.trimEnd();
					lines.push("", header);
					lines.push(...textBlocksOf(message.content));
				} else if (role === "system") {
					// 系统提示词对用户复制无意义，跳过
					break;
				} else {
					lines.push("", `[${role}] ${clip(textBlocksOf(message.content).join(" "), 400)}`);
				}
				break;
			}
			case "compaction": {
				lines.push("", `══ 会话压缩摘要 ${ts} ══`.trimEnd());
				if (entry.summary) lines.push(entry.summary);
				break;
			}
			case "custom_message": {
				lines.push("", `[${entry.customType ?? "custom"}] ${clip(textBlocksOf(entry.content).join(" "), 400)}`);
				break;
			}
			case "usage": {
				if (entry.note) lines.push("", `[用量] ${entry.note}`);
				break;
			}
			default:
				break;
		}
	}
	return lines;
}

/** 会话头部信息。 */
export function buildPlainHeader(getHeader?: () => { id?: string; cwd?: string } | null): string[] {
	const header = getHeader?.() ?? null;
	return [
		"══ 会话纯文本视图 ══",
		`会话: ${header?.id ?? "未知"}  目录: ${header?.cwd ?? "未知"}`,
		"提示: 滚轮=滚动, 鼠标拖拽选中后松开=复制到剪贴板, c=复制全部, w=存文件, q=关闭",
	];
}

/** 写入临时文件，返回文件路径。 */
export function writeTempFile(text: string): string {
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const dir = mkdtempSync(join(tmpdir(), `pi-plain-${stamp}-`));
	const file = join(dir, "plain.txt");
	writeFileSync(file, text, { encoding: "utf8" });
	return file;
}

// ---------------------------------------------------------------------------
// 纯文本对话框组件
// ---------------------------------------------------------------------------

type DoneFn = () => void;

class PlainTextDialog extends VStack {
	/** 焦点组件捕获视图口按键（PgUp/PgDn 等），避免滚到后面的转录上 */
	capturesViewportInput = true;

	private text: string;
	private tui: TUI;
	private theme: Theme;
	private done: DoneFn;
	private closed = false;
	private contentText: Text;
	private scrollView: ScrollView;
	private statusText: Text;
	private statusMsg = "";

	constructor(text: string, tui: TUI, theme: Theme, done: DoneFn) {
		super([]);
		this.text = text;
		this.tui = tui;
		this.theme = theme;
		this.done = done;
		this.contentText = new Text(stripTerminalSequences(text), 1, 0);
		this.scrollView = new ScrollView(this.contentText, {
			follow: "end",
			scrollbar: "always",
		});
		this.addChild(this.scrollView, {
			// 数字 basis：dialog 是布局根，帧高 = 终端行数；
			// grow:1 让 ScrollView 填满编辑区，状态行占 1 行。
			basis: Math.max(1, this.rows() - 3),
			grow: 1,
			shrink: 1,
			minSize: 1,
			maxSize: Math.max(1, this.rows() - 3),
		});
		this.statusText = new Text("", 0, 0);
		this.addChild(this.statusText);
		this.updateStatus();
	}

	private rows(): number {
		try {
			return this.tui.terminal?.rows ?? 24;
		} catch {
			return 24;
		}
	}

	private totalLines(): number {
		const width = (this.tui.terminal?.columns ?? 80) - 1;
		try {
			return this.contentText.render(Math.max(1, width)).length;
		} catch {
			return 1;
		}
	}

	private updateStatus(): void {
		const msg = this.statusMsg ? `  ${this.statusMsg}` : "";
		const viewport = this.scrollView.viewportHeight;
		const total = this.totalLines();
		const pos = Math.min(this.scrollView.scrollTop + viewport, total);
		const line = ` 行 ${pos}/${total} · c=复制全部 w=存文件 g/G=首/尾 q=关闭${msg}`;
		this.statusText.setText(this.theme.fg("dim", line));
		this.statusMsg = "";
	}

	handleInput(data: string): void {
		if (isKeyRelease(data)) return;

		// 关闭：q / Esc / Ctrl+C
		if (matchesKey(data, "q") || matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.close();
			return;
		}

		const viewport = this.scrollView.viewportHeight;
		if (matchesKey(data, "pageUp")) {
			this.scrollView.scrollBy(-Math.max(1, viewport - 1));
		} else if (matchesKey(data, "pageDown")) {
			this.scrollView.scrollBy(Math.max(1, viewport - 1));
		} else if (matchesKey(data, "space")) {
			this.scrollView.scrollBy(Math.max(1, viewport - 1));
		} else if (matchesKey(data, "b")) {
			this.scrollView.scrollBy(-Math.max(1, Math.floor(viewport / 2)));
		} else if (matchesKey(data, "g")) {
			this.scrollView.scrollToStart();
		} else if (matchesKey(data, "shift+g")) {
			this.scrollView.scrollToEnd();
		} else if (matchesKey(data, "c")) {
			void (async () => {
				try {
					await copyToClipboard(this.text);
					this.statusMsg = "已复制全部纯文本到剪贴板";
				} catch (error) {
					this.statusMsg = `复制失败: ${error instanceof Error ? error.message : String(error)}`;
				}
				this.updateStatus();
				this.requestRender();
			})();
			return;
		} else if (matchesKey(data, "w")) {
			try {
				const file = writeTempFile(this.text);
				this.statusMsg = `已写入临时文件: ${file}`;
			} catch (error) {
				this.statusMsg = `写入文件失败: ${error instanceof Error ? error.message : String(error)}`;
			}
			this.updateStatus();
			this.requestRender();
			return;
		} else {
			return; // 其余按键忽略
		}
		this.updateStatus();
		this.requestRender();
	}

	private requestRender(): void {
		try {
			this.tui.requestRender();
		} catch {
			/* ignore */
		}
	}

	invalidate(): void {
		this.contentText.invalidate();
		this.statusText.invalidate();
	}

	private close(): void {
		if (this.closed) return;
		this.closed = true;
		this.done();
	}
}

// ---------------------------------------------------------------------------
// 命令注册
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.registerCommand("plain", {
		description: "以无格式纯文本显示当前会话，鼠标拖拽选中即可复制（c=复制全部，w=存文件，q=关闭）",
		handler: async (_args, ctx) => {
			const entries = ctx.sessionManager.getBranch() as SessionEntryLike[];
			const lines: string[] = [];
			lines.push(...buildPlainHeader(() => ctx.sessionManager.getHeader()));
			lines.push(...buildPlainLines(entries));
			const text = lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
			if (text.length === 0) {
				ctx.ui.notify("会话为空，没有可显示的内容", "warning");
				return;
			}

			if (ctx.mode !== "tui") {
				// 非交互模式：写入临时文件
				const file = writeTempFile(text);
				if (ctx.mode === "print") {
					// pi 的 print 模式接管了 process.stdout（预留给正式输出），
					// 扩展只能写 stderr；纯文本随 stderr 进入终端 scrollback，
					// 用户可直接用终端原生选择复制（这正是 print 模式下最方便的方式）
					process.stderr.write(text + "\n");
					process.stderr.write(`纯文本已写入: ${file}\n`);
				} else {
					ctx.ui.notify(`纯文本已写入: ${file}`);
				}
				return;
			}

			try {
				await ctx.ui.custom((tui, theme, _keybindings, done) => {
					// 全屏模式的 tui 实现了 ViewportTUI：把 dialog 设为布局根，
					// 其 ScrollView 才能成为布局帧里的真正滚动节点（否则挂在普通
					// Container 里，viewport 恒为 0，滚轮/翻页/选择全部失效）。
					const viewport = isViewportTUI(tui);
					// layoutRoot 是 TuiAltScreen 私有字段，公开 API 无 getter，读一次保存
					const previousRoot = viewport
						? (tui as unknown as { layoutRoot?: Component }).layoutRoot
						: undefined;
					const dialog = new PlainTextDialog(text, tui, theme, () => {
						if (viewport) tui.setLayoutRoot(previousRoot);
						done();
					});
					if (viewport) tui.setLayoutRoot(dialog);
					return dialog;
				});
			} catch (error) {
				ctx.ui.notify(`打开纯文本视图失败: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}
