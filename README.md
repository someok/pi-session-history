# pi-session-history

独立的 pi 扩展命令 `/history`：浏览当前工作目录已保存的会话，选择并恢复，或取消返回原编辑器。以 **pi 1.1.0** 为兼容和行为基线，不替换原生 `/resume` 或启动时的 `pi --resume`。

已交付 [Issue #2](https://github.com/someok/pi-session-history/issues/2) 的选择与恢复闭环，以及 [Issue #3](https://github.com/someok/pi-session-history/issues/3) 的原生查询浏览：搜索、当前目录/全部范围、排序、仅已命名筛选与路径显示。界面使用英文，说明及代码注释使用中文。

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

搜索框沿用原生匹配范围（会话 id、名称、全部 user/assistant 正文与工作目录）：空格分词为模糊匹配，`"短语"` 为精确短语，`re:<pattern>` 为正则，大小写不敏感；不新增 model/provider 搜索字段。会话范围由 pi 当前工作目录或全部存储决定：位置来自只读会话上下文的 `getSessionDir()`，并在运行时探测 `SessionManager.usesDefaultSessionDir()`（只读类型未暴露该方法，取不到时按自定义目录处理）以确定全部范围是扫描 sessions 根目录还是给定目录。

| 默认按键 | 动作 | 宿主 action |
| --- | --- | --- |
| `↑` / `↓` | 移动选中项 | `tui.select.up` / `tui.select.down` |
| `PageUp` / `PageDown` | 按当前列表页长分页 | `tui.select.pageUp` / `tui.select.pageDown` |
| `Enter` | 恢复选中的会话 | `tui.select.confirm` |
| `Esc` / `Ctrl+C` | 取消，返回原编辑器 | `tui.select.cancel` |
| `Tab` | 切换当前目录/全部会话 | `tui.input.tab` |
| `Ctrl+S` | 循环线程/最近/相关性排序 | `app.session.toggleSort` |
| `Ctrl+N` | 切换仅已命名筛选 | `app.session.toggleNamedFilter` |
| `Ctrl+P` | 切换路径显示 | `app.session.togglePath` |

这些动作及界面提示使用宿主传入的快捷键配置；重新绑定会替换默认键，空绑定列表可停用对应动作。

- 有名称时显示名称；否则使用 pi 原生的首条可读用户消息回退，包括无消息时的 `(no messages)`。
- 活动时间来自 `SessionManager.list()`，与原生 user/assistant 活动时间及会话头回退规则一致，不另改为文件 mtime。相对时间沿用 `now`、`m`、`h`、`d`、`w`、`mo`、`y`。
- `Tab` 在当前目录与全部范围之间切换。默认存储下全部范围扫描 pi 的 sessions 根目录；自定义 session 目录下只扫描该目录，与原生范围含义一致。
- 线程排序（默认）无搜索时按 `parentSession` 展示父子层级，并按子树最新活动时间排序；搜索后线程与相关性排序按匹配分数升序，分数相同按活动时间降序；最近模式只过滤，保持活动时间顺序。
- 列表右侧按原生顺序附加信息：会话文件路径（`Ctrl+P` 开启）、全部范围下的工作目录、相对时间；附加信息先于标题被截断，避免窄终端挤掉标题与时间。
- 仅已命名筛选可切换，空结果时给出切回提示；清空查询或切回范围后列表恢复。
- `›`、加粗和 `selectedBg` 表示选中项；当前活动会话的标题使用主题 `accent`，其他命名会话使用 `warning`，与原生识别样式一致。
- 使用当前主题和终端显示列宽裁剪；中文、emoji 与窄宽度不越界。
- 选择器替换编辑器区域，显示在会话内容下方；上方会话内容保持可见，不会被浮层遮住。
- 列表按终端可用高度滚动，为搜索框、状态行和上方会话内容留出空间；缩放后保持选中项可见，不固定照搬原生 10 条。
- 显示加载态和空列表反馈。原生读取提供渐进结果时，可先选择已加载会话；后续结果不会移走用户选择；切换范围时迟到的旧范围结果不会替换当前列表。
- 通过 `ctx.switchSession()` 恢复，尊重宿主取消结果；成功后不继续访问旧上下文。
- 关闭、取消或 `session_shutdown` 会中止本次读取并释放交互，迟到结果不再更新旧界面；重新打开会重新读取保存内容。
- RPC、JSON、print 模式不启动自定义终端界面。RPC 可收到英文提示；无 UI 模式不向协议输出混入终端内容。

### 后续切片

第二行消息数和最后回复模型（[#4](https://github.com/someok/pi-session-history/issues/4)）、原地消息预览与 `Ctrl+O` 全文视图（[#6](https://github.com/someok/pi-session-history/issues/6)、[#7](https://github.com/someok/pi-session-history/issues/7)）、重命名与删除（[#5](https://github.com/someok/pi-session-history/issues/5)），以及可见项优先的增强读取与失败隔离（[#8](https://github.com/someok/pi-session-history/issues/8)）属于后续切片。需要原生完整选择与管理功能时，继续使用 `/resume`。

本扩展不注册模型工具、不发起模型调用、不上传会话内容、不修改 session schema，也不持久化预览或其他会话副本。

## 测试

```bash
npm ci
npm run check       # 类型检查 + 行为测试
npm test            # 仅行为测试
npm run typecheck   # 仅类型检查
```

主要测试 seam 已按父规格确认：从**真实扩展工厂注册的 `/history`** 进入，使用临时目录中的真实 session JSONL 和真实 pi `SessionManager`，由受控宿主提供按键、终端尺寸、主题、可见输出以及会话切换结果。

可复用的宿主 adapter 在 `test/host.ts`，行为测试在 `test/history.test.ts` 与 `test/history-search.test.ts`。它们覆盖基础恢复、上下选择与分页、空列表、标题与活动时间语义、当前会话及选中样式、自定义快捷键、宿主取消恢复、非 TUI 防护、加载期间退出与迟到结果、缩放/主题/中文/emoji、重新打开、浏览不写入数据，以及模糊/短语/正则查询、默认与自定义 session 目录的范围切换、三种排序与线程层级、仅已命名筛选、路径显示、重绑定快捷键与范围切换时的迟到结果。

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

1. 普通/fullscreen 模式正常加载扩展，打开 `/history`，切换范围、输入正则查询并清空，上下选择、取消，再次打开并实际恢复。
2. 用原生 `/session` 确认恢复前后的会话 ID。
3. 两种模式下原生 `/resume` 仍显示搜索/排序等原生界面，且仍可恢复。
4. 两种模式下 `pi --resume` 仍使用原生启动选择器，且实际恢复正确会话。
5. CLI 入口与本地 SDK 原生选择器文件的哈希不变；结束时清理临时数据及 tmux server。

已在本机 pi 1.1.0 的 npm CLI 与已有安装上分别执行通过；详见 [`docs/testing/history-smoke.md`](docs/testing/history-smoke.md)。

## 项目结构

```text
src/index.ts                   扩展工厂与选择/恢复/查询浏览流程（唯一对外入口）
src/search.ts                  原生模糊、短语、正则查询与排序语义
src/session-tree.ts            原生线程树层级与路径规范化
test/host.ts                   可复用受控宿主与真实 JSONL fixture
test/history.test.ts           基础闭环行为测试
test/history-search.test.ts    查询、范围、排序、筛选与路径行为测试
scripts/smoke.py               隔离数据下的真实 pi CLI 冒烟
docs/specs/history-extension.md 父规格，包含尚未实施的后续切片
```

原生行为参考及许可说明见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。
