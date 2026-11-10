# /plain — pi 会话纯文本视图

把当前 pi 会话窗口渲染成**无格式纯文本**，方便鼠标选择复制。
参考了 Claude Code 的 transcript 模式（`Ctrl+o`）与 Codex CLI 的 `/copy`/`/export` 的思路，
并复用 pi 自带的选中复制通道（本地 / WSL / SSH 均可用）。

## 功能

在 pi 交互界面中输入 `/plain`：

- 打开一个**全屏纯文本视图**，会话按时间顺序展开：
  - 用户消息、助手回复（保留代码块原文，不做 Markdown 渲染）
  - 工具调用（`[工具调用 read] {参数}`）与工具结果（错误带 `[错误]` 标记）
  - 压缩摘要、用量备注；系统提示词等对复制无意义的内容会被跳过
- 输出不含任何 ANSI 转义序列
- **鼠标拖拽选中文字，松开即自动复制到系统剪贴板**（pi 全屏模式的内置能力）
- 滚轮滚动

键盘：

| 键 | 作用 |
|---|---|
| `滚轮` | 滚动 |
| 鼠标拖拽 | 选中 → 松手复制到剪贴板 |
| `g` / `G` | 到顶部 / 到底部 |
| `PgUp` / `PgDn` / `空格` / `b` | 翻页滚动 |
| `c` | 复制**全部**纯文本到剪贴板 |
| `w` | 写入临时文件并在底部显示路径 |
| `q` / `Esc` / `Ctrl+C` | 关闭视图 |

非交互模式（`pi -p`）下 `/plain` 会把纯文本写到终端（stderr，进入终端 scrollback，
可直接用终端原生选择复制）并另存一个临时文件。

## 工作原理 / 已知限制

**全屏模式（默认）**：pi 全屏模式的 tui（`TuiAltScreen`）实现了 pi-tui 的
`ViewportTUI` 接口。`/plain` 打开时，扩展会临时把对话框设为布局根
（`tui.setLayoutRoot(dialog)`）——对话框的 ScrollView 因此成为布局帧里的真正
滚动节点，获得正常 viewport，滚轮、键盘翻页（g/G/PgUp/PgDn/空格/b）、鼠标拖拽
的内容级选择与松手复制全部生效；关闭（q/Esc/Ctrl+C）时立即恢复原布局根，
transcript/编辑器/焦点随之复原。若不做这一步，对话框会被 pi 挂进普通
`Container`（布局叶子节点）里，ScrollView 拿不到 viewport，界面会"无法动弹"
（滚轮落到背后 transcript、翻页无效、选择退化）。

**regular（非全屏）模式**：tui 不实现 `ViewportTUI`，扩展不做布局根切换，
对话框降级为整段纯文本渲染（无滚动条、不裁剪，显示完整会话），滚动/内容级
选择不可用；`c`（复制全部）、`w`（存临时文件）、`q`（关闭）仍可用，作为优雅降级。

**print/非交互模式**：不经过 TUI，纯文本写 stderr + 临时文件，无上述限制。

## 安装

已安装到全局自动发现目录，重启 pi（或 `/reload`）后生效：

```
~/.pi/agent/extensions/plain/index.ts
```

其他安装方式：

```bash
# 项目级（信任项目后生效）
mkdir -p .pi/extensions/plain
cp index.ts .pi/extensions/plain/index.ts

# 或临时加载单个 pi 进程
pi --extension /path/to/index.ts
```

## 测试

```bash
node test/run-tests.mjs
```

94 项断言，覆盖：
1. 纯文本构建（无 ANSI、角色分隔、工具调用/结果、错误标记、系统消息跳过）
2. 集成测试（真实 `TuiAltScreen` + 假终端 + 忠实生产布局）：复刻
   chat-viewport.js 的真实树（root → dock → editorContainer 叶子节点），
   像 pi 一样挂载对话框，验证 layoutRoot 切换修复：布局帧里 dialog 的
   ScrollView 有真实 viewport、屏幕可见 plain 内容而不可见 transcript、
   滚轮/PgDn/g/G/b 滚动（且 transcript 不被连带滚动）、鼠标拖拽选择锚点
   落在 dialog 的 ScrollView 上（内容级）、复制内容与源行字符级切片一致、
   单击不复制、c 复制全部、w 存文件、q/Esc 关闭后布局根恢复且焦点回 editor
3. round-1 评审修复回归（T1–T5，35 项）：dispose 无 done 也恢复布局根且幂等、
   done 后再 dispose 为 no-op、堆叠对话框 previousRoot 链、终端 resize 后
   viewportHeight 自适应（27→44）且状态行刷新、regular（非 ViewportTUI）
   模式降级为完整纯文本（不切布局根、c/q 仍可用）
