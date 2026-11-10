/**
 * /plain 扩展测试 — 不依赖任何测试框架，纯 node 断言
 *
 * 用法: node test/run-tests.mjs
 *
 * 单元测试：buildPlainLines / buildPlainHeader / writeTempFile
 *   （会话条目 → 纯文本行：无 ANSI、角色分隔、工具调用/结果、错误标记、系统消息跳过）
 */
import { readFileSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), ".."); // 仓库根目录

const require = createRequire(import.meta.url);
// pi 安装位置：默认 ~/.pi/agent/install/releases/<最高版本>/node_modules/@earendil-works，
// 可用环境变量 PI_ROOT 覆盖（指向含 pi-coding-agent/ 与 pi-tui/ 的 node_modules/@earendil-works 目录）。
function resolvePiRoot() {
	if (process.env.PI_ROOT) return process.env.PI_ROOT.replace(/\\/g, "/");
	const home = process.env.HOME || process.env.USERPROFILE || "";
	const releases = join(home, ".pi", "agent", "install", "releases");
	try {
		for (const version of require("node:fs").readdirSync(releases).sort().reverse()) {
			const candidate = join(releases, version, "node_modules", "@earendil-works");
			if (require("node:fs").existsSync(join(candidate, "pi-tui", "dist", "index.js"))) return candidate;
		}
	} catch {
		/* 目录不存在时走下方报错 */
	}
	throw new Error(
		"找不到 pi 安装目录，请设置 PI_ROOT 环境变量指向 node_modules/@earendil-works 目录（含 pi-tui/dist/index.js）"
	);
}
const PI_ROOT = resolvePiRoot();
const NODE_MODULES = join(PI_ROOT, ".."); // .../node_modules
const jitiLib = require(join(NODE_MODULES, "jiti"));
const jiti = jitiLib.createJiti(import.meta.url, {
	alias: {
		"@earendil-works/pi-coding-agent": join(PI_ROOT, "pi-coding-agent/dist/index.js"),
		"@earendil-works/pi-tui": join(PI_ROOT, "pi-tui/dist/index.js"),
	},
});

let passed = 0;
let failed = 0;
function assert(cond, name, detail = "") {
	if (cond) {
		passed++;
		console.log(`  ✓ ${name}`);
	} else {
		failed++;
		console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

// ---------------------------------------------------------------------------
// 1. 纯文本构建（单元测试）
// ---------------------------------------------------------------------------
console.log("\n[1] buildPlainLines / buildPlainHeader / writeTempFile");

const mod = jiti(join(REPO_ROOT, "index.ts"));
const { buildPlainLines, buildPlainHeader, writeTempFile } = mod;
assert(typeof mod.default === "function", "默认导出是扩展工厂函数");

const now = new Date().toISOString();
const entries = [
	{ type: "message", timestamp: now, message: { role: "user", content: "帮我看看这个 bug" } },
	{
		type: "message",
		timestamp: now,
		message: {
			role: "assistant",
			content: [
				{ type: "text", text: "好的，我先读取文件。\n\n```js\nconsole.log('x')\n```" },
				{ type: "toolCall", name: "read", arguments: { path: "src/a.ts" } },
			],
		},
	},
	{
		type: "message",
		timestamp: now,
		message: {
			role: "toolResult",
			toolName: "read",
			toolCallId: "t1",
			isError: false,
			content: [{ type: "text", text: "export const x = 1;" }],
		},
	},
	{
		type: "message",
		timestamp: now,
		message: {
			role: "toolResult",
			toolName: "bash",
			toolCallId: "t2",
			isError: true,
			content: [{ type: "text", text: "error: not found" }],
		},
	},
	{ type: "message", timestamp: now, message: { role: "system", content: "SYSTEM PROMPT SECRET" } },
	{ type: "compaction", timestamp: now, summary: "之前讨论了 A 和 B" },
];

const lines = buildPlainLines(entries);
const text = lines.join("\n");
assert(!text.includes("\x1b"), "输出不含 ANSI 转义序列", JSON.stringify(text.slice(0, 80)));
assert(text.includes("── 用户"), "包含用户分隔行");
assert(text.includes("── 助手"), "包含助手分隔行");
assert(text.includes("帮我看看这个 bug"), "包含用户消息原文");
assert(text.includes("```js"), "代码块保持原样（无 Markdown 渲染）");
assert(text.includes("[工具调用 read]"), "工具调用被标注");
assert(text.includes('"path": "src/a.ts"') || text.includes("src/a.ts"), "工具参数被记录");
assert(text.includes("export const x = 1;"), "工具结果文本被保留");
assert(!text.includes("SYSTEM PROMPT SECRET"), "系统消息被跳过");
assert(text.includes("══ 会话压缩摘要"), "压缩摘要被包含");
const errIdx = text.indexOf("error: not found");
assert(errIdx > -1 && text.slice(Math.max(0, errIdx - 120), errIdx).includes("[错误]"), "错误工具结果带 [错误] 标记");

const header = buildPlainHeader(() => ({ id: "sess-123", cwd: "/tmp/work" }));
assert(header[0].includes("会话纯文本视图"), "头部标题正确");
assert(header[1].includes("sess-123") && header[1].includes("/tmp/work"), "头部包含会话 id 和目录");

const tmpFile = writeTempFile("hello\nworld");
assert(existsSync(tmpFile) && readFileSync(tmpFile, "utf8") === "hello\nworld", "writeTempFile 内容正确");
assert(tmpFile.includes("plain"), "临时文件位于 pi-plain 目录");
rmSync(join(tmpFile, ".."), { recursive: true, force: true });

// 空会话
assert(buildPlainLines([]).join("") === "", "空会话 → 空输出");

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
