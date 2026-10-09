# pi-session-history

独立的 pi 扩展命令 `/history`：浏览当前工作目录已保存的会话，选择并恢复，或取消返回原编辑器。以 **pi 1.1.0** 为兼容和行为基线，不替换原生 `/resume` 或启动时的 `pi --resume`。

已交付 [Issue #2](https://github.com/someok/pi-session-history/issues/2) 的选择与恢复闭环、[Issue #3](https://github.com/someok/pi-session-history/issues/3) 的原生查询浏览、[Issue #4](https://github.com/someok/pi-session-history/issues/4) 的第二行增强信息（消息数与最后回复模型）、[Issue #6](https://github.com/someok/pi-session-history/issues/6) 的原地消息预览、[Issue #7](https://github.com/someok/pi-session-history/issues/7) 的 `Ctrl+O` 只读全文视图，以及 [Issue #9](https://github.com/someok/pi-session-history/issues/9) 的原地预览 `PageUp`/`PageDown` 翻页与 [Issue #10](https://github.com/someok/pi-session-history/issues/10) 的全文视图 `←`/`→` 翻页：搜索、当前目录/全部范围、排序、仅已命名筛选、路径显示、`→`/`←` 展开收起最后用户消息、预览窗口内翻页与全文滚动阅读。界面使用英文，说明及代码注释使用中文。

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
| `PageUp` / `PageDown` | 选中项的展开预览溢出时在预览窗口内翻页；窗口到边界后按当前可见的会话条数分页列表 | `tui.select.pageUp` / `tui.select.pageDown` |
| `Enter` | 恢复选中的会话 | `tui.select.confirm` |
| `Esc` / `Ctrl+C` | 取消，返回原编辑器 | `tui.select.cancel` |
| `Tab` | 切换当前目录/全部会话 | `tui.input.tab` |
| `Ctrl+S` | 循环线程/最近/相关性排序 | `app.session.toggleSort` |
| `Ctrl+N` | 切换仅已命名筛选 | `app.session.toggleNamedFilter` |
| `Ctrl+P` | 切换路径显示 | `app.session.togglePath` |
| `→` / `←` | 列表存在选中项时原地展开 / 收起最后用户消息预览；在 `Ctrl+O` 全文视图中为下一页 / 上一页 | 固定按键，优先于搜索光标 |
| `Ctrl+O` | 直接打开选中会话的只读消息全文视图（与是否已展开无关） | 固定按键，优先于搜索输入 |

这些动作及界面提示使用宿主传入的快捷键配置；重新绑定会替换默认键，空绑定列表可停用对应动作。

- 有名称时显示名称；否则使用 pi 原生的首条可读用户消息回退，包括无消息时的 `(no messages)`。
- 每条会话默认两行：第一行沿用原生标题、活动时间及路径/工作目录，不再显示原生消息数；第二行显示消息数（`msgs`）与最后回复模型的 `provider/model`。
- 消息数只统计整个持久化历史的 user + assistant 消息，包括其它历史分支与 compaction 前记录；工具结果、system、直接 bash 执行、扩展自定义消息及其他角色不计入，工具内部嵌套调用也不额外增加。
- 最后回复模型取整个历史按记录顺序最后一条 assistant 消息记录的 model/provider，不读取 `model_change` 等状态记录、不按时间戳重排，也不限于准备恢复的分支；虚拟模型显示实际处理该回复的 model/provider。错误或中止的最后一条 assistant 仍按该条显示，不回退到更早的成功回复；没有 assistant 显示 `No assistant message`，`provider/model` 中缺失的字段显示 `unknown`。
- `→` 原地展开选中会话的消息预览，`←` 收起；允许同时展开多项，移动选中项、切换排序、筛选或范围后展开状态按会话身份保留，关闭选择器后重置。重复展开或收起幂等，不会隐式打开其它视图；无论搜索框是否为空，列表中的左右键都优先用于预览，`Ctrl+B` / `Ctrl+F` 等替代按键仍可编辑查询。
- 消息预览取整个历史按记录顺序最后一条 user 消息，不限准备恢复的分支，也不按时间戳重排；仅含图片的最后一条仍被选中，不会回退到更早的文本。没有 user 消息时显示 `No user message`。
- 预览保留正文与换行，按终端可用宽度换行；正文左侧以 `│ ` 竖线标记展开的消息体，加载态、失败与无 user 提示同样带标记，选中行竖线与内容一同使用选中背景。预览窗口最多显示 6 个终端显示行；正文超出时追加 `… 1-6/40 · Ctrl+O full message`，同时给出当前窗口范围与可直接打开的全文入口。附件数量提示占一行且不参与滚动，正文窗口按剩余行数计算。
- 选中项已展开且正文超出预览窗口时，`PageUp`/`PageDown`（本机 `tui.select.pageUp` / `tui.select.pageDown` 绑定）在窗口内向上/向下翻一页，提示中的范围随之变化（如 `… 7-12/40 · Ctrl+O full message`）；窗口到达顶部或底部后，同一个键继续按原语义分页列表。只滚动选中项的预览，`↑`/`↓` 仍只移动选中项，`Enter` 仍恢复会话；滚动偏移按会话身份保留，收起后重新展开回到窗口顶部，关闭选择器后重置。
- `Ctrl+O` 打开选中会话的只读消息全文视图：与是否已展开无关，也不要求增强信息已读取完成（此时先显示 `Loading message preview...`，读取完成后就地补齐）。全文与预览使用同一可读口径（最后用户消息、技能名称简化、`[1 image]` / `[N images]` 提示），只是不再限制显示行数；标题行右侧标明正在阅读的会话，正文按可用宽度换行。
- 全文视图用 `↑`/`↓` 逐行滚动，`←`/`→`（固定按键）或 `PageUp`/`PageDown`（本机 `tui.select.pageUp` / `tui.select.pageDown` 绑定）翻页，超出时在底部显示 `(n/total)` 位置提示；按 `Esc`（或本机 `tui.select.cancel` 绑定）返回列表，搜索、范围、排序、筛选、选中项、展开状态、输入焦点与可见位置原样保留，之后 `Enter` 仍恢复该会话。全文为只读：`Enter`、字符及其它列表动作在视图中不生效，不会修改正文、删除会话或触发恢复。
- fullscreen 模式下 pi 1.1.0 的 alt-screen 会在内联自定义组件之前消费 `PageUp`/`PageDown`（用于原生会话视口滚动），内联的 /history 收不到这两个键：原地预览在 fullscreen 下无法翻页（可先按 `Ctrl+O` 进入全文），全文视图改用 `←`/`→` 翻页，`↑`/`↓` 逐行滚动；普通 TUI 模式下分页按键也正常可用。这是宿主行为，未修改 pi 安装。
- 全文内容绑定打开时的会话身份与标题；读取完成后或返回列表后，属于其它会话的迟到结果不会替换当前内容，也不会重新打开旧视图。只有技能、只有图片或空正文时分别显示技能名称、附件数量或 `(empty message)`；没有 user 消息显示 `No user message`，读取失败显示 `Could not load message preview.`，与预览口径一致且都可按 `Esc` 退出。
- 符合 pi 技能命令展开格式的注入内容简化为 `[skill] <name>` 并保留用户请求；疑似但无法识别的技能块整段保留原文，避免误删正文。只有技能时显示技能名称，技能加附件时同时显示技能名称与附件提示。
- 图片以 `[1 image]` / `[N images]` 数量提示呈现，不渲染图片或图片数据；图片数据在读取时即被丢弃，预览正文不另行持久化或上传。
- 活动时间来自 `SessionManager.list()`，与原生 user/assistant 活动时间及会话头回退规则一致，不另改为文件 mtime。相对时间沿用 `now`、`m`、`h`、`d`、`w`、`mo`、`y`。
- `Tab` 在当前目录与全部范围之间切换。默认存储下全部范围扫描 pi 的 sessions 根目录；自定义 session 目录下只扫描该目录，与原生范围含义一致。
- 线程排序（默认）无搜索时按 `parentSession` 展示父子层级，并按子树最新活动时间排序；搜索后线程与相关性排序按匹配分数升序，分数相同按活动时间降序；最近模式只过滤，保持活动时间顺序。
- 列表右侧按原生顺序附加信息：会话文件路径（`Ctrl+P` 开启）、全部范围下的工作目录、相对时间；附加信息先于标题被截断，避免窄终端挤掉标题与时间。
- 仅已命名筛选可切换，空结果时给出切回提示；清空查询或切回范围后列表恢复。
- 界面沿用原生选择器布局：上方与下方各一条 accent 色分隔横线（与原生 `/resume` 同色），标题行右侧显示范围/`Name`/`Sort` 状态，其下两行提示（`tab scope · re:<pattern> regex · "phrase" exact` 与动作快捷键），搜索框上下各留一个空行，内容与下方横线之间也留一个空行；加载中状态区显示原生风格的读取进度。终端高度不足时这些装饰行按需省略，优先保留搜索框与列表。
- `›`、加粗和 `selectedBg` 表示选中项；当前活动会话的标题使用主题 `accent`，其他命名会话使用 `warning`，与原生识别样式一致。
- 使用当前主题和终端显示列宽裁剪；中文、emoji 与窄宽度不越界。
- 选择器替换编辑器区域，显示在会话内容下方；上方会话内容保持可见，不会被浮层遮住。
- 列表按终端可用高度滚动（按双行基础行加展开预览的变高条目计算行数），为提示行、搜索框和上方会话内容留出空间；内容超出时在底部显示原生风格的 `(n/total)` 位置提示，分页步长为当前可见的会话条数，缩放后保持选中项完整可见，不固定照搬原生 10 条。
- 显示加载态和空列表反馈。原生读取提供渐进结果时，可先选择已加载会话；后续结果不会移走用户选择；切换范围时迟到的旧范围结果不会替换当前列表。增强信息未就绪时显示 `Loading details...`，展开的预览显示 `Loading message preview...`，不伪造 `0 msgs`、`unknown` 或 `No assistant message`；单条读取失败只把该条标记为 `Could not load session details.` / `Could not load message preview.`，其他会话仍可选择和恢复。
- 通过 `ctx.switchSession()` 恢复，尊重宿主取消结果；成功后不继续访问旧上下文。
- 关闭、取消或 `session_shutdown` 会中止本次列表与增强信息读取并释放交互，迟到结果不再更新旧界面；重新打开会重新读取保存内容并恢复紧凑的收起状态，不保留永久陈旧的缓存。
- RPC、JSON、print 模式不启动自定义终端界面。RPC 可收到英文提示；无 UI 模式不向协议输出混入终端内容。

### 后续切片

重命名与删除（[#5](https://github.com/someok/pi-session-history/issues/5)），以及可见项优先的增强读取与失败隔离（[#8](https://github.com/someok/pi-session-history/issues/8)）属于后续切片。需要原生完整选择与管理功能时，继续使用 `/resume`。

本扩展不注册模型工具、不发起模型调用、不上传会话内容、不修改 session schema，也不持久化预览、全文或其他会话副本。

## 测试

```bash
npm ci
npm run check       # 类型检查 + 行为测试
npm test            # 仅行为测试
npm run typecheck   # 仅类型检查
```

主要测试 seam 已按父规格确认：从**真实扩展工厂注册的 `/history`** 进入，使用临时目录中的真实 session JSONL 和真实 pi `SessionManager`，由受控宿主提供按键、终端尺寸、主题、可见输出以及会话切换结果。

可复用的宿主 adapter 在 `test/host.ts`，行为测试在 `test/history.test.ts`、`test/history-search.test.ts`、`test/history-details.test.ts`、`test/history-preview.test.ts` 与 `test/history-full-message.test.ts`。它们覆盖基础恢复、上下选择与分页、空列表、标题与活动时间语义、当前会话及选中样式、自定义快捷键、宿主取消恢复、非 TUI 防护、加载期间退出与迟到结果、缩放/主题/中文/emoji、重新打开、浏览不写入数据，模糊/短语/正则查询、默认与自定义 session 目录的范围切换、三种排序与线程层级、仅已命名筛选、路径显示、重绑定快捷键与范围切换时的迟到结果，第二行消息数与最后回复模型的口径（混合角色、分支、compaction、虚拟模型、错误/中止、字段缺失）、加载态、单条失败隔离、关闭后中止读取与重新打开重新校验，原地预览的左右键、替代光标按键、按记录顺序选取最后 user、技能简化与疑似技能块保留、图片数量提示、6 行窗口与范围提示、预览内 `PageUp`/`PageDown` 翻页与到边界后回退到列表分页、附件提示固定保留、排序/筛选/缩放后偏移夹紧与身份保持、多项展开与身份保持、变高列表滚动、预览加载态与失败隔离、关闭后迟到结果及重新打开重置，以及全文视图的直接打开与正确选中会话、与预览一致的内容口径（技能、图片、无 user、空正文、读取失败）、逐行滚动、`←`/`→` 与 PageUp/PageDown 翻页及边界夹紧、缩放后重新排版、`Esc` 返回逐行保留列表状态并继续恢复、只读按键隔离、加载中打开与返回后的迟到结果、中文/emoji/窄宽度/小高度/主题变化下不越界。

时序测试只在公开宿主 SDK 读取 interface 上推迟**真实读取结果**的发布，或替换只负责逐行读取文件的 adapter 以控制增强信息的时序与单条故障；消息数、最后回复模型与最后用户消息的提取仍走真实实现，不替换整条会话处理流程。测试仅断言可见输出、恢复目标和取消结果；不访问扩展私有状态、不核对内部调用次数。成功切换后访问旧上下文会被测试宿主直接拒绝。

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

1. 普通/fullscreen 模式正常加载扩展，打开 `/history`，切换范围、输入正则查询并清空，上下选择，按 `→` 展开长正文的截断预览并按 `←` 收起，取消，再次打开并实际恢复。
2. 用原生 `/session` 确认恢复前后的会话 ID。
3. 两种模式下原生 `/resume` 仍显示搜索/排序等原生界面，且仍可恢复。
4. 两种模式下 `pi --resume` 仍使用原生启动选择器，且实际恢复正确会话。
5. CLI 入口与本地 SDK 原生选择器文件的哈希不变；结束时清理临时数据及 tmux server。

已在本机 pi 1.1.0 的 npm CLI 与已有安装上分别执行通过；详见 [`docs/testing/history-smoke.md`](docs/testing/history-smoke.md)。

## 项目结构

```text
src/index.ts                   扩展工厂与选择/恢复/查询浏览/第二行信息流程（唯一对外入口）
src/search.ts                  原生模糊、短语、正则查询与排序语义
src/session-tree.ts            原生线程树层级与路径规范化
src/session-details.ts         消息数、最后回复模型与最后用户消息读取（含文件流 adapter）
src/message-preview.ts         技能简化、图片计数、按宽度换行与 6 行截断
test/host.ts                   可复用受控宿主与真实 JSONL fixture
test/history.test.ts           基础闭环行为测试
test/history-search.test.ts    查询、范围、排序、筛选与路径行为测试
test/history-details.test.ts   第二行消息数、最后回复模型与加载/失败行为测试
test/history-preview.test.ts   原地消息预览的按键、内容口径、布局与状态行为测试
scripts/smoke.py               隔离数据下的真实 pi CLI 冒烟
docs/specs/history-extension.md 父规格，包含尚未实施的后续切片
```

原生行为参考及许可说明见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。
