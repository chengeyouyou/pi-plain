# pi-plain 设计与开发文档

本文档记录 `/plain` 扩展的设计决策、关键 bug 的根因分析、测试策略与已知限制，
供维护者理解"为什么代码长这样"。

## 1. 功能目标

在 pi（`@earendil-works/pi-coding-agent`）交互界面中输入 `/plain`：

- 把当前会话分支（`sessionManager.getBranch()`）渲染为无格式纯文本（无 ANSI、无 Markdown 渲染）；
- 全屏展示，支持滚轮 / 键盘 / 鼠标滚动；
- **鼠标拖拽选中文字、松手即复制到系统剪贴板**——这是核心诉求：
  pi 全屏 TUI 的滚动区平时难以选择复制，纯文本视图让"选中即复制"成为主路径。

同类功能参考：Claude Code 的 transcript 模式（`Ctrl+O`）、Codex CLI 的 `/copy`/`/export`。

## 2. 代码结构

```
index.ts                     扩展本体（约 470 行，无外部依赖，仅用 pi 官方导出）
  ├─ buildPlainLines()       会话条目 → 纯文本行（user/assistant/toolCall/toolResult/compaction）
  ├─ buildPlainHeader()      视图头部（标题、会话 id、目录、操作提示）
  ├─ writeTempFile()         纯文本 → 系统临时目录 pi-plain-*/plain.txt
  └─ PlainTextDialog         对话框组件（VStack: [ScrollView|Text, 状态行]）
       ├─ takeoverLayout()   全屏模式：保存原布局根并把 dialog 设为布局根
       ├─ restoreLayout()    恢复原布局根（幂等，q/Esc/ dispose 均可触发）
       └─ syncScrollSize()   终端 resize 时重算滚动区高度
test/run-tests.mjs           95 项断言（17 单元 + 78 集成），无测试框架
```

## 3. 核心设计决策（按调查顺序）

### 3.1 为什么是"编辑器槽位对话框"而不是 overlay

pi 的 `ctx.ui.custom(factory, {overlay:true})` 走 `compositeOverlays`：
overlay 组件只用 `render(width)` 直接合成到屏幕，**不经过布局帧**
（`renderLayoutFrame`）。后果：dialog 里的 `ScrollView` 永远拿不到
viewport（`viewportHeight=0`），滚轮/翻页/内容级选择全部失效。
（当时用 `test/verify-overlay.mjs` 实测证明：overlay 下滚轮 ✗、PgDn ✗。）

因此对话框走 pi 的非 overlay 路径：`showTopExtensionDialog` 会把它挂进
`editorContainer`（编辑器槽位）并 `setFocus`。这条路有内置的鼠标选择
（`copyOnSelect`）与复制通道，是 pi 自身扩展对话框的标准行为。

注意：pi 的 `tui-alt-screen.js` 在 `hasOverlay()===true` 时会**禁用**
ScrollView 内容级选择（退化为屏幕级选择，复制的是渲染后可能被截断的行），
这也是选择非 overlay 路径的原因之一。

### 3.2 冻屏 bug 的根因与修复（本项目最关键的一次修复）

**现象**：真实全屏 pi 中打开 `/plain` 后，滚轮 / PgDn / g / G / 鼠标选择全部失效，
界面"无法动弹"。

**根因**（用复现脚本 `test/repro-nested.mjs` 证明，后并入集成测试）：
pi 把对话框挂进 `editorContainer`——它是普通 `Container`（`interactive-mode.js:422`），
在 pi 的布局帧（`layout.js`）中是**叶子节点**：子组件不进入布局帧。
于是 dialog 的 `ScrollView` 不是布局节点：

- `viewportHeight` 恒为 0 → 键盘 `scrollBy` 全部无效；
- 滚轮在 `dispatchMouseToLayout` 找不到 scroll 框 → 落到背后的 transcript 上；
- 鼠标选择退化为屏幕级粗选择（复制内容与源文本错位）。

**修复**：全屏模式下 dialog 自己接管布局根。pi 的 `TuiAltScreen` 实现了
pi-tui 导出的 `ViewportTUI` 接口（守卫 `isViewportTUI`），其
`setLayoutRoot(component)` 是公开 API，但 `layoutRoot` 字段本身是私有的、无 getter——
扩展用 `as unknown as` 读一次保存旧值，写入走公开 setter：

```
takeoverLayout(tui):
  previousRoot = tui.layoutRoot          // 读私有字段一次（仅保存）
  tui.requestRender = hook(原函数)        // F3：resize 检测（见 3.4）
  tui.setLayoutRoot(dialog)              // dialog 成为布局帧根
  swapped = true

restoreLayout():                         // done 与 dispose 都会调，幂等
  if (tui.requestRender === 本实例的hook) tui.requestRender = 原函数
  tui.setLayoutRoot(previousRoot)
  restored = true
```

dialog 成为布局根后，其 `ScrollView` 是真正的滚动节点：viewport 正常、
滚轮/翻页生效、鼠标选择是内容级（`selectionAnchor.scrollView === sv`）。

**为什么 dialog 自己持有 previousRoot / swapped / restored（而不是闭包变量）**：
pi 的 `resetExtensionUI`（`/reload`、切换会话触发，`interactive-mode.js:2015-2023`）
会**直接 `dispose()` 对话框而不调 `done()`**。如果恢复逻辑只放在 done 闭包里，
这条路径会让 layoutRoot 永远停在已卸载的 dialog 上 → 界面永久冻结。
所以恢复必须挂在 dialog 实例上，`dispose()` 也调用它；`swapped/restored`
双标志保证 done→dispose、dispose→done、重复 dispose 各种顺序都幂等。

### 3.3 regular（非全屏）模式

`TuiMainScreen`（regular 模式）不实现 `ViewportTUI`，没有 `setLayoutRoot`，
且普通 `Container` 对子组件不裁剪——ScrollView 在里面会无界渲染整个会话、
滚动键对零高度 viewport 无效。所以 regular 模式**不做布局根切换**，
对话框降级为整段纯文本（无滚动条、不裁剪），`c`（复制全部）/ `w`（存临时文件）/
`q`（关闭）仍可用。

### 3.4 终端 resize 自适应（F3）

dialog 打开时，其 ScrollView 的 stack entry 用数字 `basis/maxSize`
（构造时的 `rows-3`）参与布局。终端 resize 后若不同步，viewport 会停在旧高度。

pi 的 resize 监听器只做一件事：`tui.requestRender()`（`tui.js:596`）。
而布局根经 `[LAYOUT_NODE]` 结构测量，dialog 自己的 `render(width)` 每帧不被调用，
所以扩展 hook 了 `tui.requestRender`：每次调用先 `syncScrollSize()`
（行数变化时重算 entry 的 `basis/maxSize`，状态行延迟一拍刷新），再调原函数。

**为什么 hook 必须每实例保存、按身份还原**：堆叠对话框场景
（d1 未关时再开 d2）下，若用共享槽 + 无条件清除，d2 关闭会把
`requestRender` 直接还原为原始函数，d1 的 resize hook 随之失效。
现在的实现是每个 dialog 保存自己的 `prevRequestRender`（注意必须
`.bind(this.tui)`——`requestRender` 是原型方法且内部用 `this`），
还原时先判断 `tui.requestRender === 自己装的hook`，保证
hook 链 d2→d1→原始 逐级还原、互不破坏（T3 测试专门锁定这一点）。

调查记录：首选方案 `basis:"100%"` 不可用——`stack.js` 的
`allocateStackSizes` 只对数字 basis 生效，字符串会退化为内容高度测量，
让 scroll 框按全部 200+ 行内容撑爆 30 行的帧。

### 3.5 print / 非交互模式

`pi -p "/plain"`：pi 的 print 模式接管了 `process.stdout`（预留给正式输出），
扩展只能写 `stderr`。纯文本随 stderr 进入终端 scrollback，
用户可直接用终端原生选择复制——这正是 print 模式下最方便的复制方式。
同时另存一份临时文件并在 stderr 提示路径。

### 3.6 Ctrl+C 的设计决定

对话框打开时 `Ctrl+C` 被对话框拦截用于关闭（与 `q`/`Esc` 同效），
**不会**中断背后的 agent。这是有意为之：全屏 plain 视图打开时用户意图是
查看/复制，误按 `Ctrl+C` 不应中断正在运行的任务。代价是要中断 agent 需先
`q` 关闭再按一次。此行为在 README 与测试（T5 不覆盖此项，属交互约定）中声明。

## 4. 测试策略

`test/run-tests.mjs`：纯 node 断言，无测试框架。jiti 加载 `index.ts`，
别名指向本机真实 pi 安装（`~/.pi/agent/install/releases/<最高版本>/`，
可用 `PI_ROOT` 环境变量覆盖）。

**关键教训**：第一版测试直接 `tui.setLayoutRoot(dialog)`（dialog 当布局根），
40 项断言全绿——但生产环境是冻死的。原因是测试挂载方式与 pi 不同：
pi 会把 dialog 挂进 `editorContainer`（布局叶子）。测试重写为**忠实生产挂载**：

- 完整复刻 `chat-viewport.js` 的树：`root VStack[transcript ScrollView
  {basis:0,grow:1,shrink:1,minSize:1}, dock VStack basis:"auto"
  {pending/status/widgetsAbove/editorContainer(普通 Container)
  {shrink:1,minSize:3}/widgetsBelow/footer}]`；
- 像 pi 一样 `editorContainer.clear(); addChild(dialog); setFocus(dialog);
  setLayoutRoot(root)`；布局根 swap 由扩展自己的工厂回调完成（与生产一致）。

在此挂载下，"冻屏"的症状（`viewportHeight===0`、滚轮落到 transcript、
选择锚点非内容级）会直接让断言失败——旧测试的失败模式在结构上不可能复现。

断言分组（95 项）：

| 组 | 内容 |
|---|---|
| 单元（17） | `buildPlainLines`/`buildPlainHeader`/`writeTempFile`：无 ANSI、角色分隔、工具调用/结果、`[错误]` 标记、系统消息跳过、压缩摘要、空会话 |
| 集成基础（42） | swap 生效（`getScrollViewBox` 存在、`viewportHeight=27>0`）、屏幕可见 plain 不可见 transcript、滚轮上/下（transcript 不动）、g/G/PgDn/b、拖拽内容级选择锚点 + 复制字符级切片正确、单击不复制、c/w 状态行、q/Esc 关闭后 layoutRoot 恢复 + focus 回 editor |
| T1–T5（35） | dispose 无 done 也恢复且幂等 / done 后 dispose no-op / 堆叠对话框 previousRoot 链 / resize 自适应（27→44）+ 状态行刷新 / regular 降级（不调 setLayoutRoot、整段渲染、c/q 可用） |
| round-2（1） | 堆叠下关 d2 后 resize 仍触发 d1 的 syncScrollSize（27→39） |

## 5. 已知限制

- 物理鼠标在真实终端中的拖拽体验未手测（代码路径用真实 SGR 序列 +
  `copySelection` spy 验证到字符级）；
- regular 模式为降级形态（无滚动），未做像素级验证；
- 超大会话（>10k 行）未做性能基准（`Text` 按宽度缓存，理论线性）;
- CJK 混排下的选区列对齐依赖 pi 自身的列计算（`sliceByColumn`）。

## 6. 环境备忘（开发过程踩坑）

- Git Bash 下 `pi -p "/plain"` 会被 MSYS2 路径转换改写为
  `C:/Program Files/Git/plain`，需 `MSYS_NO_PATHCONV=1` 前缀（真实终端不受影响）；
- `--no-extensions` 会同时禁用全局扩展自动发现（`resource-loader.js:424/520`），
  E2E 必须配 `-e index.ts`，否则 `/plain` 未注册会被 LLM 当普通提示词处理。
