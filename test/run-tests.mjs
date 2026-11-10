/**
 * /plain 扩展测试 — 不依赖任何测试框架，纯 node 断言
 *
 * 用法: node test/run-tests.mjs
 *
 * 测试三层：
 *  1. buildPlainLines: 会话条目 → 纯文本行（无 ANSI、结构正确）
 *  2. writeTempFile / buildPlainHeader
 *  3. 集成测试: 真实 TuiAltScreen + 假终端 + 生产忠实布局
 *     复刻 chat-viewport.js 的真实树 (root → dock → editorContainer)，
 *     像 pi 一样 editorContainer.addChild(dialog) 挂载，验证 index.ts 里
 *     的 layoutRoot swap 修复后：
 *     - dialog.sv.viewportHeight > 0（布局帧里存在 scroll 框）
 *     - 屏幕可见 plain-line、不可见 transcript-line（dialog 占满全屏）
 *     - 滚轮/键盘 g/G/PgUp/b 滚动 dialog 的 ScrollView（且 transcript 不动）
 *     - 鼠标拖拽选择 → 松手自动复制（内容级锚点，字符级切片正确）
 *     - q/Esc 关闭后 layoutRoot 恢复、focus 回到 editor
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

// ---------------------------------------------------------------------------
// 2. 集成测试：真实 TuiAltScreen + 假终端 + 生产忠实布局
// ---------------------------------------------------------------------------
console.log("\n[2] 集成测试: TuiAltScreen + 生产嵌套布局 (滚轮 / 鼠标选择复制 / 键盘 / 关闭恢复)");

const { TuiAltScreen } = jiti(join(PI_ROOT, "pi-tui/dist/tui-alt-screen.js"));
const { VStack, ScrollView, Text, Container, isViewportTUI } = jiti(join(PI_ROOT, "pi-tui/dist/index.js"));
const { getScrollViewBox } = jiti(join(PI_ROOT, "pi-tui/dist/layout.js"));

const ROWS = 30;
const COLS = 100;

class FakeTerminal {
	columns = COLS;
	rows = ROWS;
	kittyProtocolActive = false;
	onInput = null;
	onResize = null;
	start(onInput, onResize) {
		this.onInput = onInput;
		this.onResize = onResize;
	}
	stop() {}
	drainInput() {
		return Promise.resolve();
	}
	write(data) {}
	moveBy() {}
	hideCursor() {}
	showCursor() {}
	clearLine() {}
	clearFromCursor() {}
	clearScreen() {}
	setTitle() {}
	setProgress() {}
	setProgramStatus() {}
	// 把输入喂给 TUI
	feed(data) {
		this.onInput(data);
	}
}

const terminal = new FakeTerminal();
const copyCalls = [];
const tui = new TuiAltScreen(terminal, true, undefined, {
	copyOnSelect: true,
	copySelection: async (text) => {
		copyCalls.push(text);
		return true;
	},
});

// --- 复刻 chat-viewport.js 的真实结构 ---
const transcriptDoc = new Text(Array.from({ length: 50 }, (_, i) => `transcript-line-${i}`).join("\n"), 0, 0);
const transcript = new ScrollView(transcriptDoc, { follow: "end", primary: true, overscroll: "chain", scrollbar: "auto" });
const pending = new Container();
const statusBar = new Container();
const widgetsAbove = new Container();
const widgetsBelow = new Container();
const footer = new Container();
const editor = new Text("editor placeholder", 1, 0);
const editorContainer = new Container(); // ← pi: interactive-mode.js:422 new Container()（布局叶子）
editorContainer.addChild(editor);
const dock = new VStack([
	{ component: pending, shrink: 1, minSize: 0 },
	{ component: statusBar, shrink: 1, minSize: 0 },
	{ component: widgetsAbove, shrink: 1, minSize: 0 },
	{ component: editorContainer, shrink: 1, minSize: 3 }, // ← editor 槽位
	{ component: widgetsBelow, shrink: 1, minSize: 0 },
	{ component: footer, shrink: 1, minSize: 0 },
]);
const root = new VStack([
	{ component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
	{ component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
]);

// 基线: 无 dialog 时 transcript 正常布局（对应 pi mountInteractiveTui 已 setLayoutRoot）
tui.setLayoutRoot(root);
tui.setFocus(editor);
tui.start();
tui.renderNow(true);
const previousRoot = tui.layoutRoot; // 生产中 = fullscreenLayoutRoot（即 root）
assert(previousRoot === root, "基线: layoutRoot 已设为生产布局根");
assert(!!getScrollViewBox(tui.currentLayout, transcript), "基线: transcript 在布局帧里有 scroll 框");

// 长会话：单个助手消息含 200 行，保证可滚动
const longEntries = [
	{ type: "message", timestamp: now, message: { role: "user", content: "hi" } },
	{ type: "message", timestamp: now, message: { role: "assistant", content: [{ type: "text", text: Array.from({ length: 200 }, (_, i) => `plain-line-${String(i).padStart(3, "0")}`).join("\n") }] } },
];

let doneCalled = 0;
let dialog;
let factoryLast; // 最近一次 fakeUi.custom 里 factory 返回的组件
const themeLike = {
	fg: (_token, text) => text,
	bg: (_token, text) => text,
	bold: (t) => t,
	underline: (t) => t,
	inverse: (t) => t,
};

// --- 模拟 pi 的 showExtensionCustom/showTopExtensionDialog 的真实挂载 ---
const fakeUi = {
	custom: async (factory) => {
		// 像 pi 一样: 先调用 factory 拿到组件，再 pushExtensionDialog 挂进 editorContainer
		const close = () => {
			if (doneCalled > 0) return;
			doneCalled++;
			// 生产时序: factory 里 dialog 的 done 回调先恢复 layoutRoot，
			// 随后 pi 的 done() → restoreEditor(): 恢复 editor + setFocus(editor)
			const comp = factory.__lastComponent;
			if (comp) {
				editorContainer.clear();
				editorContainer.addChild(editor);
				tui.setFocus(editor);
			}
		};
		const component = factory(tui, themeLike, { matches: () => false }, close);
		factory.__lastComponent = component;
		factoryLast = component;
		editorContainer.clear();
		editorContainer.addChild(component);
		tui.setFocus(component);
		return undefined;
	},
	notify: (msg) => {
		notifications.push(msg);
	},
};
const notifications = [];
const fakeCtx = {
	mode: "tui",
	ui: fakeUi,
	sessionManager: {
		getBranch: () => longEntries,
		getHeader: () => ({ id: "test-session", cwd: "/tmp/demo" }),
	},
	hasUI: true,
};

let registeredDef;
await mod.default({
	registerCommand: (name, def) => {
		assert(name === "plain", "注册了 /plain 命令");
		registeredDef = def;
	},
});
assert(!!registeredDef, "命令 handler 已注册");

// 运行命令 handler（工厂回调内执行 layoutRoot swap）
await registeredDef.handler("", fakeCtx);
// 从挂载树取 dialog（editorContainer 的当前子，模拟 showTopExtensionDialog 挂载结果）
dialog = editorContainer.children[0];
assert(!!dialog && dialog !== editor, "editorContainer 里挂载了对话框组件（而非 editor）");

// 模拟 pi 挂载后的一次渲染帧
tui.renderNow(true);

// --- 断言 1: swap 生效 —— dialog 成为布局根，ScrollView 有真实 viewport ---
assert(tui.layoutRoot === dialog, "layoutRoot 已 swap 为 dialog");
const frame = tui.currentLayout;
const svBox = getScrollViewBox(frame, dialog.children[0]);
assert(!!svBox, "布局帧里 getScrollViewBox(frame, dialog.sv) 存在");
assert(dialog.children[0].viewportHeight > 0, `dialog.sv.viewportHeight > 0 (实际 ${dialog.children[0].viewportHeight})`);

// --- 断言 2: 屏幕可见 plain-line、不可见 transcript-line（dialog 占满全屏） ---
const screenText = tui.getScreenLines().join("\n");
assert(screenText.includes("plain-line-"), "屏幕上可见 plain-line（dialog 全屏）");
assert(!screenText.includes("transcript-line-"), "屏幕上不可见 transcript-line（transcript 被替换）");

// 取对话框里的 ScrollView（VStack.children[0]）
const scroll = dialog.children[0];
assert(scroll.constructor.name === "ScrollView", "对话框第一个子组件是 ScrollView");

// 初始 follow:"end" → 滚动到底部
const expectedMax = Math.max(0, 200 - scroll.viewportHeight);
assert(scroll.scrollTop >= expectedMax - 1, `初始滚动到底部 (scrollTop=${scroll.scrollTop}, max=${expectedMax})`);

// --- 滚轮测试（滚轮必须落在 dialog 的 ScrollView 上，而不是背后的 transcript） ---
const beforeDown = scroll.scrollTop;
const transcriptBeforeDown = transcript.scrollTop;
terminal.feed("\x1b[<64;50;15M"); // 滚轮向上
tui.renderNow(true);
assert(scroll.scrollTop < beforeDown, `滚轮向上: ${beforeDown} → ${scroll.scrollTop}`);
assert(transcript.scrollTop === transcriptBeforeDown, `滚轮没有落到背后 transcript (scrollTop 保持 ${transcript.scrollTop})`);

const beforeUp = scroll.scrollTop;
for (let i = 0; i < 5; i++) terminal.feed("\x1b[<65;50;15M");
tui.renderNow(true);
assert(scroll.scrollTop > beforeUp, `滚轮向下: ${beforeUp} → ${scroll.scrollTop}`);
assert(transcript.scrollTop === transcriptBeforeDown, "滚轮向下后 transcript 仍未被滚动");

// --- 键盘 g/G/PgUp/PgDn/b ---
terminal.feed("g");
tui.renderNow(true);
assert(scroll.scrollTop === 0, `g 回到顶部 (scrollTop=${scroll.scrollTop})`);

const beforePgDn = scroll.scrollTop;
terminal.feed("\x1b[6~"); // PgDn
tui.renderNow(true);
assert(scroll.scrollTop > beforePgDn, `PgDn 向下: ${beforePgDn} → ${scroll.scrollTop}`);

terminal.feed("G"); // shift+g
tui.renderNow(true);
assert(scroll.scrollTop >= expectedMax - 1, `G 到底部 (scrollTop=${scroll.scrollTop})`);

// b = 半页向上（从底部验证）
const beforeHalfB = scroll.scrollTop;
terminal.feed("b");
tui.renderNow(true);
assert(scroll.scrollTop < beforeHalfB, `b 半页向上: ${beforeHalfB} → ${scroll.scrollTop}`);

// --- 鼠标拖拽选择: 内容级锚点 + 松手复制字符级切片 ---
terminal.feed("g");
tui.renderNow(true);
assert(scroll.scrollTop === 0, "重置到顶部");
// 源文本布局: 0=标题 1=会话 2=提示 3=空 4=用户hdr 5=hi 6=空 7=助手hdr 8..=plain-line-000..
// scrollTop=0 → 屏幕行 y = 内容行 y；在 (col 5, row 10) 按下 = 内容行 10 = plain-line-002，拖到 row 12
terminal.feed("\x1b[<0;6;11M"); // press at col 5 (6-1), row 10 (11-1)
terminal.feed("\x1b[<32;11;13M"); // drag to col 10, row 12
terminal.feed("\x1b[<0;11;13m"); // release
tui.renderNow(true);

assert(!!tui.selectionAnchor, "拖拽后存在选择锚点");
assert(tui.selectionAnchor?.scrollView === scroll, "选择锚点 scrollView === dialog 的 ScrollView（内容级选择）");
assert(copyCalls.length === 1, `松手触发一次复制 (实际 ${copyCalls.length})`);
if (copyCalls.length > 0) {
	const copied = copyCalls[0];
	const copiedLines = copied.split("\n");
	assert(!copied.includes("\x1b"), "复制内容无 ANSI");
	assert(copiedLines.length === 3, `选中 3 行 (实际 ${copiedLines.length})`);
	// 中间行为完整行（Text 有 paddingX=1 前缀空格）
	assert(copiedLines[1]?.trim() === "plain-line-003", `中间行是完整源行 plain-line-003 (got: ${JSON.stringify(copiedLines)})`);
	// 首行从 col 5 开始 → 缺 "pla" 前缀；末行到 col 10 → 数字被截断（字符级切片正确）
	assert(copiedLines[0]?.trim() === "n-line-002", `首行列切片正确 (got: ${JSON.stringify(copiedLines)})`);
	assert(copiedLines[2]?.trim() === "plain-line", `末行列切片正确 (got: ${JSON.stringify(copiedLines)})`);
}

// 单点点击（无拖拽）不应复制
copyCalls.length = 0;
terminal.feed("\x1b[<0;6;15M");
terminal.feed("\x1b[<0;6;15m");
tui.renderNow(true);
assert(copyCalls.length === 0, "单点点击不触发复制");

// --- c = 复制全部 ---
terminal.feed("c");
// copyToClipboard 在真实环境走系统剪贴板；此处用原生 API 验证（Windows 走 wsl powershell）
await new Promise((r) => setTimeout(r, 1500));
tui.renderNow(true);
const statusLine = dialog.children[1].text ?? "";
console.log(`  状态行: ${JSON.stringify(statusLine)}`);
assert(/剪贴板|失败/.test(statusLine), "c 后状态行显示复制结果");

// --- w = 存文件 ---
terminal.feed("w");
tui.renderNow(true);
const statusAfterW = dialog.children[1].text ?? "";
assert(statusAfterW.includes("plain.txt"), `w 后状态行显示临时文件路径: ${JSON.stringify(statusAfterW)}`);

// --- q = 关闭: layoutRoot 恢复为原 root，focus 回到 editor ---
terminal.feed("q");
assert(doneCalled === 1, "q 关闭对话框 (done 被调用)");
assert(tui.layoutRoot === previousRoot, "layoutRoot 恢复为原 root");
tui.renderNow(true);
assert(!!getScrollViewBox(tui.currentLayout, transcript), "关闭后 currentLayout 里能找到 transcript 的 scroll 框");
assert(tui.getFocusedComponent() === editor, "关闭后 focus 回到 editor");

// --- T1: dispose 路径（pi resetExtensionUI 不走 done()）必须恢复 layoutRoot ---
doneCalled = 0;
dialog = undefined;
await registeredDef.handler("", fakeCtx);
dialog = editorContainer.children[0];
assert(tui.layoutRoot === dialog, "T1: 新 dialog 已 swap 为 layoutRoot");
const t1Prev = dialog.previousRoot;
assert(t1Prev === previousRoot, "T1: dialog.previousRoot 记录了原布局根");
dialog.dispose(); // 模拟 resetExtensionUI：无 done 直接 dispose
assert(tui.layoutRoot === t1Prev, "T1: dispose 后 layoutRoot 恢复为原 root");
tui.renderNow(true);
assert(!!getScrollViewBox(tui.currentLayout, transcript), "T1: dispose 后 currentLayout 里能找到 transcript 的 scroll 框");
const t1AfterFirstDispose = tui.layoutRoot;
dialog.dispose(); // 第二次 dispose 必须幂等
assert(tui.layoutRoot === t1AfterFirstDispose, "T1: 重复 dispose 幂等（layoutRoot 不变）");

// --- T2: done 之后再 dispose（pi 正常时序）必须 no-op ---
doneCalled = 0;
dialog = undefined;
await registeredDef.handler("", fakeCtx);
dialog = editorContainer.children[0];
assert(tui.layoutRoot === dialog, "T2: 新 dialog 已 swap 为 layoutRoot");
const t2Prev = dialog.previousRoot;
assert(t2Prev === previousRoot, "T2: dialog.previousRoot 记录了原布局根");
terminal.feed("q");
assert(doneCalled === 1, "T2: q 关闭对话框 (done 被调用)");
assert(tui.layoutRoot === t2Prev, "T2: done 已恢复 layoutRoot");
tui.renderNow(true);
dialog.dispose(); // pi 在 done 之后还会调 component.dispose()
assert(tui.layoutRoot === t2Prev, "T2: done 后再 dispose 幂等 no-op（layoutRoot 不变）");

// --- T4: 终端 resize 时 scroll 框自适应（F3） ---
doneCalled = 0;
dialog = undefined;
await registeredDef.handler("", fakeCtx);
dialog = editorContainer.children[0];
assert(tui.layoutRoot === dialog, "T4: 新 dialog 已 swap 为 layoutRoot");
tui.renderNow(true);
const t4Scroll = dialog.children[0];
const t4vhBefore = t4Scroll.viewportHeight;
const t4posBefore = Math.min(t4Scroll.scrollTop + t4Scroll.viewportHeight, 200);
assert(t4vhBefore > 0, `T4: resize 前 viewportHeight > 0 (实际 ${t4vhBefore})`);
terminal.rows = 45; // 30 → 45
tui.requestRender(); // pi 的 resize 监听器走 tui.requestRender
tui.renderNow(true);
const t4vhAfter = t4Scroll.viewportHeight;
assert(t4vhAfter > t4vhBefore, `T4: resize 后 viewportHeight 增大 (${t4vhBefore} → ${t4vhAfter})`);
await new Promise((r) => setTimeout(r, 80)); // 等状态行延迟一拍刷新
tui.renderNow(true);
const t4status = dialog.children[1].text ?? "";
// follow:"end" 下 resize 后 pos 仍应是新末行（208），而不是旧的 174（173+1，resize 前 27 高的末行）
assert(
	t4status.includes("行 208/") && !t4status.includes(`行 ${t4posBefore}/`),
	`T4: 状态行反映新 viewport (旧值 行 ${t4posBefore}/ 已不存在; 实际: ${JSON.stringify(t4status)})`
);
terminal.rows = ROWS;
tui.requestRender();
tui.renderNow(true);
terminal.feed("q"); // 关 T4 dialog，避免 focus/布局根残留影响后续测试
assert(doneCalled === 1, "T4: q 关闭 dialog");
assert(tui.layoutRoot === previousRoot, "T4: 关闭后 layoutRoot 恢复");

// --- Esc 关闭（新实例） ---
doneCalled = 0;
dialog = undefined;
await registeredDef.handler("", fakeCtx);
dialog = editorContainer.children[0];
assert(tui.layoutRoot === dialog, "新 dialog 再次 swap 为 layoutRoot");
assert(doneCalled === 0, "新 dialog 初始未关闭");
tui.renderNow(true);
tui.setFocus(dialog);
terminal.feed("\x1b");
assert(doneCalled === 1, "Esc 关闭对话框");
assert(tui.layoutRoot === previousRoot, "Esc 关闭后 layoutRoot 再次恢复");
tui.renderNow(true);
assert(!!getScrollViewBox(tui.currentLayout, transcript), "Esc 关闭后 transcript scroll 框重新可见");
assert(tui.getFocusedComponent() === editor, "Esc 关闭后 focus 回到 editor");

// --- T3: 堆叠对话框（dialog1 未关时再开 dialog2） ---
// 说明: 每次 fakeUi.custom 都会 clear() 重挂 editorContainer，且 close 闭包共享 doneCalled 计数器；
// 因此每次 handler 前把 doneCalled 归零（该次 close 只会被调一次），
// 再手工把 dialog1 挂回 dialog2 之下模拟 pi 的堆叠布局（测试重点是 layoutRoot 捕获/恢复链）
doneCalled = 0;
await registeredDef.handler("", fakeCtx);
const dialog1 = factoryLast;
assert(tui.layoutRoot === dialog1, "T3: dialog1 swap 为 layoutRoot");
doneCalled = 0;
await registeredDef.handler("", fakeCtx);
const dialog2 = factoryLast;
assert(dialog2 !== dialog1, "T3: dialog2 是新实例");
assert(tui.layoutRoot === dialog2, "T3: dialog2 swap 后 layoutRoot === dialog2");
assert(dialog2.previousRoot === dialog1, "T3: dialog2.previousRoot 捕获为 dialog1（堆叠）");
// 手工恢复堆叠布局：dialog1 在 editorContainer 下、dialog2 在上、dialog2 获焦
editorContainer.clear();
editorContainer.addChild(dialog1);
editorContainer.addChild(dialog2);
tui.setFocus(dialog2);
tui.requestRender();
tui.renderNow(true);
terminal.feed("q"); // 关 dialog2
assert(doneCalled === 1, "T3: dialog2 的 done 被调用");
assert(tui.layoutRoot === dialog1, "T3: 关 dialog2 后 layoutRoot 恢复为 dialog1");
tui.renderNow(true);
// close 闭包把 focus 还给 editor，重新聚焦 dialog1 以便第二次 q 生效
doneCalled = 0;
tui.setFocus(dialog1);
tui.renderNow(true);
terminal.feed("q"); // 关 dialog1
assert(doneCalled === 1, "T3: dialog1 的 done 被调用");
assert(tui.layoutRoot === previousRoot, "T3: 关 dialog1 后 layoutRoot 恢复为原 root");
tui.renderNow(true);
assert(!!getScrollViewBox(tui.currentLayout, transcript), "T3: transcript scroll 框重新可见");
assert(tui.getFocusedComponent() === editor, "T3: focus 回到 editor");

// --- T5: regular 模式（非 ViewportTUI）降级为完整纯文本 ---
const regularUi = {
	custom: async (factory) => {
		const close = () => {
			if (t5Done > 0) return;
			t5Done++;
		};
		const component = factory(fakeTui, themeLike, { matches: () => false }, close);
		regularUi.__last = component;
		return component;
	},
	notify: (msg) => notifications.push(msg),
};
let t5Done = 0;
const fakeTui = {
	terminal: { rows: 30, columns: COLS },
	requestRender: () => {},
	setLayoutRoot: () => {
		t5SetLayoutRootCalled = true;
	},
};
let t5SetLayoutRootCalled = false;
assert(isViewportTUI(fakeTui) === false, "T5: 导出的 isViewportTUI 守卫对无 symbol 的假 tui 返回 false");
const t5RootBefore = tui.layoutRoot;
await registeredDef.handler("", { mode: "tui", ui: regularUi, sessionManager: fakeCtx.sessionManager, hasUI: true });
const t5Dialog = regularUi.__last;
assert(!!t5Dialog, "T5: regular 分支返回了 dialog 组件");
assert(t5SetLayoutRootCalled === false, "T5: regular 模式不调用 setLayoutRoot");
assert(tui.layoutRoot === t5RootBefore, "T5: 原 layoutRoot 未被触碰");
const t5Lines = t5Dialog.render(COLS);
assert(t5Lines.join("\n").includes("plain-line-"), "T5: regular dialog 渲染出纯会话内容（无滚动裁剪）");
assert(t5Dialog.scrollView === undefined, "T5: regular 分支不创建 ScrollView");
assert((t5Dialog.children[1].text ?? "").includes("完整纯文本"), "T5: 状态行是 '完整纯文本' 而非 '行 pos/total'");
t5Dialog.handleInput("c");
await new Promise((r) => setTimeout(r, 1500));
assert(/剪贴板|失败/.test(t5Dialog.children[1].text ?? ""), "T5: c 复制全部纯文本仍可用");
t5Dialog.handleInput("q");
assert(t5Done === 1, "T5: q 关闭对话框 (done 被调用)");

tui.stop();

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
