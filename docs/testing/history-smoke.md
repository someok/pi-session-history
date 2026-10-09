# /history 最小闭环：测试与冒烟记录

对应工作项：[Issue #2](https://github.com/someok/pi-session-history/issues/2)。本记录只证明这一切片，不代表父规格中第二行信息、查询或消息预览等后续行为已经实现。

## 环境

- 执行日期：2026-10-09。
- 系统：macOS。
- Node.js：24.20.0；npm：11.19.0。
- pi：1.1.0，分别检查本项目 npm 开发依赖中的真实 CLI 与已有的 pi 安装。
- TypeScript：5.9.3；测试运行器：Node.js `node:test`，由 tsx 4.23.15 加载 TypeScript。
- Python：3.14.8；tmux：3.7c。

## 重现命令

在仓库根目录执行：

```bash
npm ci
npm run check
npm run test:smoke
PI_BIN="$(command -v pi)" npm run test:smoke
npm pack --dry-run
```

`npm run check` 的结果为类型检查通过、**22 项测试通过，无失败或跳过**；其中包括非 TUI 模式及交互结束方式的子测试。

`npm pack --dry-run` 只检查本地包清单，不发布 npm 包。宿主包放在 `peerDependencies` 中，由 pi 提供；开发依赖和 lockfile 将验收基线固定为 1.1.0。

## 主要测试 seam

`test/host.ts` 的 `HistoryHost` 从真实扩展工厂注册并调用 `/history`。它提供公开的命令上下文、`ctx.ui.custom()`、主题、快捷键、终端尺寸、完成回调和会话切换 interface：

- JSONL 数据存放在测试专用临时目录，发现和解析使用真实 `SessionManager.list()`。
- 成功恢复时使用真实 `SessionManager.open()` 载入目标，并使原上下文失效；若扩展继续读取旧上下文，测试失败。
- 宿主取消恢复时保留原会话，测试确认英文取消反馈，而非成功反馈。
- 时序场景在公开 SDK 读取 interface 上控制真实读取结果的发布时机，不 mock 整个会话处理流程。
- 关闭后任何旧界面渲染请求都会被 adapter 标记；测试确认迟到结果既不重开界面，也不更新已恢复的原编辑器。
- 断言对象是可见文本、ANSI 语义样式、显示宽高、恢复目标及外部文件是否改变，不读取扩展私有字段或内部调用次数。
- 宿主记录 `ctx.ui.custom()` 的呈现方式：`inline` 替换编辑器区域，会遮住会话内容的 `overlay` 会让回归测试失败。

后续 tickets 可继续复用此宿主，增加按键、数据和可见行为断言，而不暴露解析器、缓存或列表状态的内部 interface。

## 行为测试覆盖

| 验收内容 | 结果 |
| --- | --- |
| 只注册独立 `/history`；真实会话恢复到正确目标 | 通过 |
| 原生名称、名称清空、首条用户文本及无消息回退 | 通过 |
| 活动时间忽略命名、工具结果及人为更新的 mtime；相对时间全部时间桶 | 通过 |
| 选中项、当前会话样式及当前文件符号链接 | 通过 |
| 上下选择、分页、缩放后选中项可见及正确确认 | 通过 |
| 空列表及取消返回原编辑器 | 通过 |
| 自定义六类快捷键、替换后不再响应默认按键 | 通过 |
| 宿主取消恢复，原会话与旧上下文保持有效 | 通过 |
| 成功切换后不再读取旧上下文 | 通过 |
| RPC、JSON、print 及无 UI 的 TUI 上下文不启动终端界面 | 通过 |
| 渐进结果保留用户选择，加载期间可取消 | 通过 |
| Esc、宿主关闭及 `session_shutdown` 中止读取，迟到结果无可见更新 | 通过 |
| 读取失败不冒充正常空列表 | 通过 |
| 选择器替换编辑器区域、会话内容不被遮挡 | 通过 |
| 中文、emoji、组合字符、控制字符、窄宽度、小高度及主题变化 | 通过 |
| 浏览和取消不写文件，重新打开读取外部更新 | 通过 |

## 真实宿主冒烟

`scripts/smoke.py` 使用专用 tmux socket 启动真实 pi CLI，普通模式以扩展文件加载，fullscreen 模式以本地包 manifest 加载。两个 pi 入口分别得到以下结果：

```text
PASS regular: /history 打开、选择、取消、真实恢复；原生 /resume 选择器及恢复未替换
PASS regular: pi --resume 原生启动选择器及实际恢复未替换
PASS fullscreen: /history 打开、选择、取消、真实恢复；原生 /resume 选择器及恢复未替换
PASS fullscreen: pi --resume 原生启动选择器及实际恢复未替换
PASS pi 1.1.0: CLI/原生选择器文件哈希未变；全部配置和会话均使用已清理的临时数据
```

恢复前后通过原生 `/session` 观察会话 ID，分别为 `smoke-source` 和 `smoke-target`；不是仅观察一次切换函数调用。原生选择器另外断言其 `Resume Session (Current Folder)` 标题、`Threaded` 排序和原生正则搜索提示，并实际选择恢复。

每次打开 `/history` 时还断言会话内容仍可见，且选择器确实替换了编辑器区域（按键提示行下方紧邻状态栏）。把 `ctx.ui.custom()` 改回 `overlay` 会让这两条断言失败，已实测。

### 隔离与清理

- HOME、pi agent 配置、项目目录和会话数据均为临时数据；fixtures 使用规范路径，避免 macOS `/var` 与 `/private/var` 导致当前目录匹配偏差。
- 不继承用户的 provider 凭据或当前会话环境变量；只加载待测扩展，禁用其他扩展、MCP、技能、提示词模板和项目上下文发现。
- 设置 `PI_OFFLINE=1`、`PI_SKIP_VERSION_CHECK=1`、`PI_TELEMETRY=0`、`cacheWarming: "off"`，不发送模型请求。
- 每次执行校验选定 CLI 入口及本地 SDK 原生选择器文件的 SHA-256；不修改 pi 安装或 session schema。
- 成功和异常退出都结束专用 tmux server，临时目录随后删除；不访问用户真实历史或废纸篓。
