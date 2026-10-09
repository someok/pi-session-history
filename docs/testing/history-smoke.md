# /history 测试与冒烟记录

对应工作项：[Issue #2](https://github.com/someok/pi-session-history/issues/2)（选择与恢复闭环）、[Issue #3](https://github.com/someok/pi-session-history/issues/3)（原生查询浏览）、[Issue #4](https://github.com/someok/pi-session-history/issues/4)（第二行消息数与最后回复模型）、[Issue #6](https://github.com/someok/pi-session-history/issues/6)（原地展开最后用户消息）、[Issue #7](https://github.com/someok/pi-session-history/issues/7)（`Ctrl+O` 只读全文视图）、[Issue #9](https://github.com/someok/pi-session-history/issues/9)（原地预览 `PageUp`/`PageDown` 翻页）与 [Issue #10](https://github.com/someok/pi-session-history/issues/10)（全文视图 `←`/`→` 翻页）。本记录只证明这七个切片，不代表父规格中尚未实施的后续切片已经实现。

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

`npm run check` 的结果为类型检查通过、**62 项测试通过，无失败或跳过**；其中包括非 TUI 模式、交互结束方式、第二行信息读写、原地预览与 `Ctrl+O` 全文视图的子测试。

`npm pack --dry-run` 只检查本地包清单，不发布 npm 包。宿主包放在 `peerDependencies` 中，由 pi 提供；开发依赖和 lockfile 将验收基线固定为 1.1.0。

## 主要测试 seam

`test/host.ts` 的 `HistoryHost` 从真实扩展工厂注册并调用 `/history`。它提供公开的命令上下文、`ctx.ui.custom()`、主题、快捷键、终端尺寸、完成回调和会话切换 interface：

- JSONL 数据存放在测试专用临时目录，发现和解析使用真实 `SessionManager.list()`。
- 成功恢复时使用真实 `SessionManager.open()` 载入目标，并使原上下文失效；若扩展继续读取旧上下文，测试失败。
- 宿主取消恢复时保留原会话，测试确认英文取消反馈，而非成功反馈。
- 时序场景在公开 SDK 读取 interface 上控制真实读取结果的发布时机，不 mock 整个会话处理流程。
- 第二行增强信息与最后用户消息的时序与单条故障仅在文件逐行读取 adapter（`SessionFileReader.lines`）上控制；消息数、最后回复模型与最后用户消息的提取仍使用真实实现，不暴露也不断言解析器、缓存或列表状态的内部结构。
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
| 模糊、精确短语与正则查询，含 id、名称、正文与工作目录范围，不将 model/provider 当作搜索字段 | 通过 |
| 默认存储与自定义 session 目录下的当前目录/全部范围候选集 | 通过 |
| 线程、最近与相关性排序，线程模式父子层级与子树活动时间顺序 | 通过 |
| 仅已命名筛选，含空结果提示与切回后恢复 | 通过 |
| 路径显示开关、全部范围工作目录及标题/时间/当前会话标识不错位 | 通过 |
| 范围、排序、筛选、路径开关的原生动作与重绑定快捷键 | 通过 |
| 范围切换时迟到的旧范围结果不替换当前列表 | 通过 |
| 输入查询后到达的完整结果按会话身份保留选中项 | 通过 |
| 查询后恢复正确目标；只注册 `/history`，不注册或替换 `/resume` | 通过 |
| 中文/emoji 查询后的缩放、主题变化与选中项可见 | 通过 |
| 每条会话默认两行；第一行不再重复显示消息数；第二行展示 `msgs` 与 `provider/model` | 通过 |
| 消息数只计全历史 user + assistant，含分支、compaction 前记录与仅含工具调用的 assistant；工具结果、system、bash、自定义消息及嵌套调用不计入 | 通过 |
| 最后回复模型按记录顺序取最后一条 assistant；选择模型 B 未发消息、虚拟模型、错误/中止均使用该条记录；无 assistant 与字段缺失分别提示 | 通过 |
| 第二行加载态与真实 `0 msgs`、`unknown`、`No assistant message` 分开 | 通过 |
| 单条增强信息读取失败只标记该条，其他会话仍可选择和恢复 | 通过 |
| 关闭选择器中止未完成读取，迟到结果不更新旧界面；重新打开重新校验会话内容 | 通过 |
| 双行基础条目按终端高度滚动，选中项两行完整可见且不越界 | 通过 |
| `→` 展开最后用户消息、`←` 收起；重复操作幂等，不打开其它视图，Enter 仍恢复 | 通过 |
| 查询为空或非空时左右键都优先操作预览；`Ctrl+B` / `Ctrl+F` 仍可编辑查询 | 通过 |
| 按记录顺序取最后 user（不限分支、不按时间戳重排、不转换其它角色）；仅图片的最后一条仍被选中 | 通过 |
| 已识别技能注入简化为 `[skill] name`，技能加正文 / 只有技能 / 技能加附件正确；疑似技能块保留原文 | 通过 |
| 图片显示 `[1 image]` / `[N images]` 数量提示，不渲染图片数据；无 user 显示 `No user message` | 通过 |
| 正文与换行保留并按宽度换行，消息体左侧以 `│` 竖线标记，最多 6 个显示行，超出时提示 `… 1-6/N · Ctrl+O full message` | 通过 |
| 选中项预览溢出时 `PageUp`/`PageDown` 在窗口内翻页，到顶/到底后继续分页列表；滚动不改动选中项、`↑`/`↓` 与 `Enter` 语义不变 | 通过 |
| 预览翻页时附件提示固定保留，正文窗口按剩余行数计算；收起后重新展开回到窗口顶部 | 通过 |
| 排序、筛选与缩放后滚动偏移仍关联同一会话，并按新宽度夹紧；输出不越界 | 通过 |
| 多项同时展开；移动、搜索、排序、范围切换后按会话身份保持，关闭后重置 | 通过 |
| 展开后的变高列表按高度滚动，选中项完整可见，上下与分页可用 | 通过 |
| 预览加载态、单条失败隔离、关闭后迟到结果无效且不修改或另存会话 | 通过 |
| 展开预览在中文、emoji、窄宽度、小高度、缩放与主题变化后不越界 | 通过 |
| 列表 `Ctrl+O` 直接打开选中会话全文，与是否已展开无关；切换选中项后操作对象正确 | 通过 |
| 全文与预览使用同一最后 user、技能简化、图片提示口径；无 user、空正文与读取失败有一致的可退出反馈 | 通过 |
| 正文不受 6 行上限；上下键逐行、`PageUp`/`PageDown` 分页，缩放后重新排版且可遍历到末尾 | 通过 |
| 全文视图 `←`/`→` 上一页/下一页，步长与 PageUp/PageDown 一致，到顶/到底后夹紧；提示行显示 `←/→ page` | 通过 |
| `Esc` 返回后搜索、范围、排序、筛选、选中、展开、焦点与可见位置逐行一致，之后 `Enter` 仍恢复该会话 | 通过 |
| 全文只读：`Enter`、字符、删除与列表动作不改变界面、不恢复会话、不修改或另存正文 | 通过 |
| 加载未完成也能打开全文并在原地补齐；返回后迟到结果不重开旧视图，切换选中项后重开显示新会话 | 通过 |
| 全文在中文、emoji、窄宽度、小高度、缩放与主题变化后不越界，仍可滚动到末尾 | 通过 |

## 真实宿主冒烟

`scripts/smoke.py` 使用专用 tmux socket 启动真实 pi CLI，普通模式以扩展文件加载，fullscreen 模式以本地包 manifest 加载。两个 pi 入口分别得到以下结果：

```text
PASS regular: /history 打开、第二行增强信息、原地预览展开收起与翻页、Ctrl+O 全文打开与滚动返回、选择、取消、真实恢复；原生 /resume 选择器及恢复未替换
PASS regular: pi --resume 原生启动选择器及实际恢复未替换
PASS fullscreen: /history 打开、第二行增强信息、原地预览展开收起与翻页、Ctrl+O 全文打开与滚动返回、选择、取消、真实恢复；原生 /resume 选择器及恢复未替换
PASS fullscreen: pi --resume 原生启动选择器及实际恢复未替换
PASS pi 1.1.0: CLI/原生选择器文件哈希未变；全部配置和会话均使用已清理的临时数据
```

恢复前后通过原生 `/session` 观察会话 ID，分别为 `smoke-source` 和 `smoke-target`；不是仅观察一次切换函数调用。原生选择器另外断言其 `Resume Session (Current Folder)` 标题、`Threaded` 排序和原生正则搜索提示，并实际选择恢复。

本切片新增的查询路径也在两种模式下实测：按 `Tab` 切到全部范围（标题变为 `History (All)`），输入正则 `re:^smoke-source` 后只剩匹配会话，按 `Ctrl+U` 清空查询恢复列表，再按 `Tab` 切回当前目录范围。

第二行增强信息同样在两种模式下实测：打开与再次打开 `/history` 后都等待出现 `2 msgs · openai/gpt-4.1-mini`（fixture 为一条 user + 一条 assistant），确认全历史 user + assistant 计数与 assistant 记录的 provider/model 在真实终端中渲染，且加载态已消失。

本切片新增的原地预览也在两种模式下实测：fixture 的最后一条 user 消息包含 60 行 `SMOKE PREVIEW LINE`，打开 `/history` 后按 `→` 等待出现 `│ Isolated smoke request`、`1-6/61`、`Ctrl+O full message` 与 `→/← preview` 提示（长正文只显示 6 行正文加窗口范围与全文入口提示，消息体左侧带竖线），按 `←` 后提示消失，证明真实终端中的按键、竖线与截断渲染生效。普通模式还按 `PageDown`/`PageUp` 验证预览内翻页：`PageDown` 后提示变为 `7-12/61` 且选中项 `› History smoke target` 不变，`PageUp` 后回到 `1-6/61`；fullscreen 下分页按键被 alt-screen 接管（见下），因此只验证展开与提示。

本切片新增的 `Ctrl+O` 全文视图同样在两种模式下实测：按 `Ctrl+O` 后等待出现 `Full message`、`Isolated smoke request`、`SMOKE PREVIEW LINE 20` 与 `(1/61)`，且第 60 行尚不可见（证明正文不再受 6 行上限并显示了位置提示）；普通模式按 `PageDown` 后第 60 行进入可见区（`(26/61)`），再按 `PageUp` 回到首屏（`(1/61)`），`→`/`←` 也各自验证了一次；fullscreen 模式只用 `→` 翻到第 60 行、不再验证被 alt-screen 接管的 PageUp/PageDown。在全文视图按 `Enter` 不会恢复会话，按 `Esc` 回到列表；后续步骤继续用原生 `/session` 验证恢复链路，确认只读视图未改变列表状态与恢复目标。

每次打开 `/history` 时还断言会话内容仍可见，且选择器从分隔横线、标题、提示、搜索框到列表直接延伸到状态栏、其间不混入会话正文。分隔横线与原生选择器同色（dark 主题下 accent `#a798d7`），已用带颜色的终端捕获比对；控件不替换编辑器区域（例如改回 `overlay`）时，会话正文会出现在选择器与状态栏之间，该断言失败。

冒烟中发现一项宿主行为：fullscreen 模式下 pi 1.1.0 的 alt-screen 会在内联自定义组件之前消费 `PageUp`/`PageDown`（它们被绑定为原生会话视口滚动），因此内联的 /history 在 fullscreen 下收不到这两个键——原地预览无法翻页，全文视图改用 `←`/`→` 翻页（`↑`/`↓` 仍逐行滚动）；普通 TUI 模式两个按键都可用。这与 `tui-alt-screen.js` 中 `tui.altScreen.pageUp` / `pageDown`「有意遮蔽未修改的编辑器绑定」一致；扩展没有修改 pi 安装，也无法在内联组件中阻止该键被视口消费，已在 README 注明该差异。

### 隔离与清理

- HOME、pi agent 配置、项目目录和会话数据均为临时数据；fixtures 使用规范路径，避免 macOS `/var` 与 `/private/var` 导致当前目录匹配偏差。
- 不继承用户的 provider 凭据或当前会话环境变量；只加载待测扩展，禁用其他扩展、MCP、技能、提示词模板和项目上下文发现。
- 设置 `PI_OFFLINE=1`、`PI_SKIP_VERSION_CHECK=1`、`PI_TELEMETRY=0`、`cacheWarming: "off"`，不发送模型请求。
- 每次执行校验选定 CLI 入口及本地 SDK 原生选择器文件的 SHA-256；不修改 pi 安装或 session schema。
- 成功和异常退出都结束专用 tmux server，临时目录随后删除；不访问用户真实历史。
