# 开发说明

本文件面向仓库开发者：环境准备、本地加载、实现约定、测试与冒烟流程。用户安装与使用见根目录 [`README.md`](../README.md)；产品行为与验收矩阵见 [`docs/specs/history-extension.md`](specs/history-extension.md)，测试与冒烟记录见 [`docs/testing/history-smoke.md`](testing/history-smoke.md)。

## 环境与兼容基线

- pi **1.1.0**：兼容与行为基线，覆盖普通 TUI 与 fullscreen；RPC、JSON、print 等非 TUI 模式不启动自定义终端界面。
- Node.js **22.19.0 或更新版本**、npm。
- 文档及代码注释使用中文，界面提示使用英文。
- 宿主包 `@earendil-works/pi-coding-agent` 与 `@earendil-works/pi-tui` 位于 `peerDependencies`，由 pi 提供；开发依赖与 lockfile 将验收基线固定为 1.1.0。

```bash
npm ci
pi --version
```

## 本地加载

```bash
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

## 已交付切片

已交付 [Issue #2](https://github.com/someok/pi-session-history/issues/2) 的选择与恢复闭环、[Issue #3](https://github.com/someok/pi-session-history/issues/3) 的原生查询浏览、[Issue #4](https://github.com/someok/pi-session-history/issues/4) 的第二行增强信息（消息数与最后回复模型）、[Issue #6](https://github.com/someok/pi-session-history/issues/6) 的原地消息预览、[Issue #7](https://github.com/someok/pi-session-history/issues/7) 的 `Ctrl+O` 只读全文视图、[Issue #9](https://github.com/someok/pi-session-history/issues/9) 的原地预览 `PageUp`/`PageDown` 翻页、[Issue #10](https://github.com/someok/pi-session-history/issues/10) 的全文视图 `←`/`→` 翻页，以及 [Issue #8](https://github.com/someok/pi-session-history/issues/8) 的可见项优先读取与异步状态一致性：搜索、当前目录/全部范围、排序、仅已命名筛选、路径显示、`→`/`←` 展开收起最后用户消息、预览窗口内翻页与全文滚动阅读。

## 实现说明

### 会话范围与活动时间

- 会话范围由 pi 当前工作目录或全部存储决定：位置来自只读会话上下文的 `getSessionDir()`，并在运行时探测 `SessionManager.usesDefaultSessionDir()`（只读类型未暴露该方法，取不到时按自定义目录处理）以确定全部范围是扫描 sessions 根目录还是给定目录。
- 活动时间来自 `SessionManager.list()`，与原生 user/assistant 活动时间及会话头回退规则一致，不另改为文件 mtime。

### 增强信息调度

增强信息按可见性调度：当前视口内的会话优先读取（展开项与 `Ctrl+O` 全文目标在可见时同样优先），其他会话在后台逐条补齐；滚动、查询、筛选或范围切换后重新排序，已经离开视口的慢读取会为新的可见项让出并发槽位，并稍后补读。列表本身先可用，可立即搜索、选择和恢复，无需等待全部增强信息。

### 异步与生命周期

- 原生读取提供渐进结果时，可先选择已加载会话；后续结果不会移走用户选择；切换范围时迟到的旧范围结果不会替换当前列表。
- 通过 `ctx.switchSession()` 恢复，尊重宿主取消结果；成功后不继续访问旧上下文。
- 关闭、取消或 `session_shutdown` 会中止本次列表与增强信息读取并释放交互，迟到结果不再更新旧界面；重新打开会重新读取保存内容并恢复紧凑的收起状态，不保留永久陈旧的缓存。
- 全文内容绑定打开时的会话身份与标题；读取完成后或返回列表后，属于其它会话的迟到结果不会替换当前内容，也不会重新打开旧视图。
- 单条增强信息读取失败只标记该条，其他会话仍可选择和恢复。

### 只读承诺

本扩展不注册模型工具、不发起模型调用、不上传会话内容、不修改 session schema，也不持久化预览、全文或其他会话副本。列表内不提供重命名与删除（原切片 [Issue #5](https://github.com/someok/pi-session-history/issues/5) 已废弃）；需要原生完整选择与管理功能时，继续使用 `/resume`。

### fullscreen 下的 PageUp/PageDown

fullscreen 模式下 pi 1.1.0 的 alt-screen 会在内联自定义组件之前消费 `PageUp`/`PageDown`（用于原生会话视口滚动），内联的 /history 收不到这两个键：原地预览在 fullscreen 下无法翻页（可先按 `Ctrl+O` 进入全文），全文视图改用 `←`/`→` 翻页，`↑`/`↓` 逐行滚动；普通 TUI 模式下分页按键也正常可用。这是宿主行为，未修改 pi 安装。

## 测试

```bash
npm ci
npm run check       # 类型检查 + 行为测试
npm test            # 仅行为测试
npm run typecheck   # 仅类型检查
```

主要测试 seam 已按父规格确认：从**真实扩展工厂注册的 `/history`** 进入，使用临时目录中的真实 session JSONL 和真实 pi `SessionManager`，由受控宿主提供按键、终端尺寸、主题、可见输出以及会话切换结果。

可复用的宿主 adapter 在 `test/host.ts`，行为测试在 `test/history.test.ts`、`test/history-search.test.ts`、`test/history-details.test.ts`、`test/history-preview.test.ts`、`test/history-full-message.test.ts` 与 `test/history-async.test.ts`。它们覆盖基础恢复、上下选择与分页、空列表、标题与活动时间语义、当前会话及选中样式、自定义快捷键、宿主取消恢复、非 TUI 防护、加载期间退出与迟到结果、缩放/主题/中文/emoji、重新打开、浏览不写入数据，模糊/短语/正则查询、默认与自定义 session 目录的范围切换、三种排序与线程层级、仅已命名筛选、路径显示、重绑定快捷键与范围切换时的迟到结果，第二行消息数与最后回复模型的口径（混合角色、分支、compaction、虚拟模型、错误/中止、字段缺失）、加载态、单条失败隔离、关闭后中止读取与重新打开重新校验，原地预览的左右键、替代光标按键、按记录顺序选取最后 user、技能简化与疑似技能块保留、图片数量提示、6 行窗口与范围提示、预览内 `PageUp`/`PageDown` 翻页与到边界后回退到列表分页、附件提示固定保留、排序/筛选/缩放后偏移夹紧与身份保持、多项展开与身份保持、变高列表滚动、预览加载态与失败隔离、关闭后迟到结果及重新打开重置，以及全文视图的直接打开与正确选中会话、与预览一致的内容口径（技能、图片、无 user、空正文、读取失败）、逐行滚动、`←`/`→` 与 PageUp/PageDown 翻页及边界夹紧、缩放后重新排版、`Esc` 返回逐行保留列表状态并继续恢复、只读按键隔离、加载中打开与返回后的迟到结果、中文/emoji/窄宽度/小高度/主题变化下不越界，以及可见项优先的增强信息调度、滚动抢占与组合回归（见下段）。

时序测试只在公开宿主 SDK 读取 interface 上推迟**真实读取结果**的发布，或替换只负责逐行读取文件的 adapter 以控制增强信息的时序与单条故障；消息数、最后回复模型与最后用户消息的提取仍走真实实现，不替换整条会话处理流程。`test/history-async.test.ts` 在这条 seam 上覆盖：大量会话下滚动后新可见项抢占不可见项已占用的读取槽位（释放后让位的读取按后台优先级补读）、加载期间 `Ctrl+O` 目标的全文优先补齐、增强信息全部未就绪时仍可搜索选择并恢复、读取未完成时切换查询或筛选后迟到结果不让不再匹配的条目回来、读取未完成时切换范围不让当前范围外的条目回来、加载中更换全文目标时迟到结果不覆盖另一会话正文、关闭后立即重开时上一轮迟到结果不进入新一轮，以及查询、范围、三种排序、命名筛选、路径与快捷键和双行信息、原地预览、全文协同的组合回归。测试仅断言可见输出、恢复目标和取消结果；不访问扩展私有状态、不核对内部调用次数。成功切换后访问旧上下文会被测试宿主直接拒绝。

测试与冒烟记录详见 [`docs/testing/history-smoke.md`](testing/history-smoke.md)。

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

1. 普通/fullscreen 模式正常加载扩展，打开 `/history`，切换范围、输入正则查询并清空，上下选择，按 `→` 展开长正文的截断预览并按 `←` 收起，取消，再次打开并实际恢复；另有 6 条额外的隔离会话，验证把选中项移到远端会话后其增强信息在真实终端中同样补齐。
2. 用原生 `/session` 确认恢复前后的会话 ID。
3. 两种模式下原生 `/resume` 仍显示搜索/排序等原生界面，且仍可恢复。
4. 两种模式下 `pi --resume` 仍使用原生启动选择器，且实际恢复正确会话。
5. 非 TUI 工作流：`pi --print --mode json` 执行 `/history` 不启动终端界面，标准输出不含终端控制序列且仍是合法 JSON 行。
6. CLI 入口与本地 SDK 原生选择器文件的哈希不变；结束时清理临时数据及 tmux server。

已在本机 pi 1.1.0 的 npm CLI 与已有安装上分别执行通过；详见 [`docs/testing/history-smoke.md`](testing/history-smoke.md)。

## 项目结构

```text
src/index.ts                   扩展工厂与选择/恢复/查询浏览/第二行信息流程（唯一对外入口）
src/details-scheduler.ts       增强信息的可见项优先调度、后台补齐与抢占
src/search.ts                  原生模糊、短语、正则查询与排序语义
src/session-tree.ts            原生线程树层级与路径规范化
src/session-details.ts         消息数、最后回复模型与最后用户消息读取（含文件流 adapter）
src/message-preview.ts         技能简化、图片计数、按宽度换行与 6 行截断
test/host.ts                   可复用受控宿主与真实 JSONL fixture
test/history.test.ts           基础闭环行为测试
test/history-search.test.ts    查询、范围、排序、筛选与路径行为测试
test/history-details.test.ts   第二行消息数、最后回复模型与加载/失败行为测试
test/history-preview.test.ts   原地消息预览的按键、内容口径、布局与状态行为测试
test/history-full-message.test.ts  Ctrl+O 只读全文视图行为测试
test/history-async.test.ts     可见项优先、异步竞态与组合回归测试
scripts/smoke.py               隔离数据下的真实 pi CLI 冒烟
docs/development.md            开发说明（本文件）
docs/specs/history-extension.md 父规格与验收矩阵（现有切片均已交付）
docs/testing/history-smoke.md  测试与冒烟记录
```

## 相关文档

- [`README.md`](../README.md) —— 功能介绍与使用说明
- [`docs/specs/history-extension.md`](specs/history-extension.md) —— 父规格与验收矩阵
- [`docs/testing/history-smoke.md`](testing/history-smoke.md) —— 测试与冒烟记录
- [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md) —— 原生行为参考及第三方许可说明
