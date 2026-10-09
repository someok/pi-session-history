# pi-session-history

独立的 pi 扩展命令 `/history`：浏览当前工作目录已保存的会话，选择并恢复，或取消返回原编辑器。以 **pi 1.1.0** 为兼容和行为基线，不替换原生 `/resume` 或启动时的 `pi --resume`。

本次交付 [Issue #2](https://github.com/someok/pi-session-history/issues/2) 的最小闭环。界面使用英文，说明及代码注释使用中文。

## 本地加载

需要 Node.js **22.19.0 或更新版本**、npm，以及 pi **1.1.0**。

```bash
npm ci
pi --version

# 普通终端模式：直接加载 TypeScript 扩展，无需构建。
pi --extension ./src/index.ts --tui-mode regular

# fullscreen 模式：通过 package.json 中的 pi.extensions 加载本地包。
pi --extension . --tui-mode fullscreen
```

进入 pi 后运行 `/history`。会话范围取决于 pi 当前工作目录，而非扩展所在目录。要在另一个项目中使用，可传入扩展的绝对路径：

```bash
pi --extension /absolute/path/to/pi-session-history/src/index.ts
```

也可按 pi 的正常本地包流程安装：

```bash
pi install /absolute/path/to/pi-session-history
```

该安装命令会登记 pi 包配置；直接使用 `--extension` 则只对本次运行生效。本项目无需也不会修改 pi 安装文件。

## 使用

默认按原生活动时间倒序排列当前目录会话。宿主配置的 `--session-dir` 等存储位置由公开会话上下文提供，扩展不另行猜测目录。

| 默认按键 | 动作 | 宿主 action |
| --- | --- | --- |
| `↑` / `↓` | 移动选中项 | `tui.select.up` / `tui.select.down` |
| `PageUp` / `PageDown` | 按当前可用终端高度分页 | `tui.select.pageUp` / `tui.select.pageDown` |
| `Enter` | 恢复选中的会话 | `tui.select.confirm` |
| `Esc` / `Ctrl+C` | 取消，返回原编辑器 | `tui.select.cancel` |

这些动作及界面提示使用宿主传入的快捷键配置；重新绑定会替换默认键，空绑定列表可停用对应动作。

- 有名称时显示名称；否则使用 pi 原生的首条可读用户消息回退，包括无消息时的 `(no messages)`。
- 活动时间来自 `SessionManager.list()`，与原生 user/assistant 活动时间及会话头回退规则一致，不另改为文件 mtime。相对时间沿用 `now`、`m`、`h`、`d`、`w`、`mo`、`y`。
- `›`、加粗和 `selectedBg` 表示选中项；当前活动会话的标题使用主题 `accent`，其他命名会话使用 `warning`，与原生识别样式一致。
- 使用当前主题和终端显示列宽裁剪；中文、emoji 与窄宽度不越界。
- 选择器替换编辑器区域，显示在会话内容下方；上方会话内容保持可见，不会被浮层遮住。
- 列表最多占终端高度的一半（与 pi 的树选择器同口径），为会话内容保留可见空间；条目仍按显示行滚动，缩放后保持选中项可见，不固定照搬原生 10 条。
- 显示加载态和空列表反馈。原生读取提供渐进结果时，可先选择已加载会话；后续结果不会移走用户选择。
- 通过 `ctx.switchSession()` 恢复，尊重宿主取消结果；成功后不继续访问旧上下文。
- 关闭、取消或 `session_shutdown` 会中止本次读取并释放交互，迟到结果不再更新旧界面；重新打开会重新读取保存内容。
- RPC、JSON、print 模式不启动自定义终端界面。RPC 可收到英文提示；无 UI 模式不向协议输出混入终端内容。

### 本次未实现的功能

第二行消息数和最后回复模型、消息预览与全文视图、搜索、当前目录/全部范围切换、线程排序、筛选、路径显示、重命名和删除属于后续切片。需要原生完整选择与管理功能时，继续使用 `/resume`。

本扩展不注册模型工具、不发起模型调用、不上传会话内容、不修改 session schema，也不持久化预览或其他会话副本。

## 测试

```bash
npm ci
npm run check       # 类型检查 + 行为测试
npm test            # 仅行为测试
npm run typecheck   # 仅类型检查
```

主要测试 seam 已按父规格确认：从**真实扩展工厂注册的 `/history`** 进入，使用临时目录中的真实 session JSONL 和真实 pi `SessionManager`，由受控宿主提供按键、终端尺寸、主题、可见输出以及会话切换结果。

可复用的宿主 adapter 在 `test/host.ts`，行为测试在 `test/history.test.ts`。它们覆盖基础恢复、上下选择与分页、空列表、标题与活动时间语义、当前会话及选中样式、自定义快捷键、宿主取消恢复、非 TUI 防护、加载期间退出与迟到结果、缩放/主题/中文/emoji、重新打开，以及浏览不写入数据。

时序测试只在公开宿主 SDK 读取 interface 上推迟**真实读取结果**的发布，不替换整条会话处理流程。测试仅断言可见输出、恢复目标和取消结果；不访问扩展私有状态、不核对内部调用次数。成功切换后访问旧上下文会被测试宿主直接拒绝。

### 真实 pi 1.1.0 冒烟

需要 POSIX 环境、Python 3 和 `tmux`。使用 npm 安装的真实 pi 1.1.0 CLI：

```bash
npm run test:smoke
```

也可检查已有安装，`PI_BIN` 必须是可执行文件的绝对路径：

```bash
PI_BIN="$(command -v pi)" npm run test:smoke
```

`./scripts/smoke.py` 会创建专用 tmux socket 和临时 HOME、pi 配置、项目及 session 数据，不继承模型凭据，禁用自动网络活动和 cache warming，不发送模型请求。检查内容：

1. 普通/fullscreen 模式正常加载扩展，打开 `/history`，上下选择、取消，再次打开并实际恢复。
2. 用原生 `/session` 确认恢复前后的会话 ID。
3. 两种模式下原生 `/resume` 仍显示搜索/排序等原生界面，且仍可恢复。
4. 两种模式下 `pi --resume` 仍使用原生启动选择器，且实际恢复正确会话。
5. CLI 入口与本地 SDK 原生选择器文件的哈希不变；结束时清理临时数据及 tmux server。

已在本机 pi 1.1.0 的 npm CLI 与已有安装上分别执行通过；详见 [`docs/testing/history-smoke.md`](docs/testing/history-smoke.md)。

## 项目结构

```text
src/index.ts                   扩展工厂与选择/恢复流程（唯一对外入口）
test/host.ts                   可复用受控宿主与真实 JSONL fixture
test/history.test.ts          公开入口行为测试
scripts/smoke.py               隔离数据下的真实 pi CLI 冒烟
docs/specs/history-extension.md 父规格，包含尚未实施的后续切片
```

原生行为参考及许可说明见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。
