# Issue tracker: GitHub

本仓库的工作项与规格记录为 GitHub issue，统一使用 `gh` CLI 操作。
在仓库内运行命令时，`gh` 会根据 Git remote 推断目标仓库；
在仓库外运行时，通过 `--repo someok/pi-session-history` 指定目标。

## 常用操作

- 创建：`gh issue create --title "..." --body-file <文件路径>`。
  多行正文可使用 heredoc：

  ```bash
  gh issue create --title "..." --body-file - <<'EOF'
  正文
  EOF
  ```

- 读取正文、标签和评论：
  `gh issue view <number> --json number,title,body,labels,comments`。
- 列表：
  `gh issue list --state open --json number,title,body,labels,comments`。
  按需添加 `--label`、调整 `--state`，并使用 `--jq` 筛选结果。
- 评论：`gh issue comment <number> --body "..."`。
- 添加或移除标签：
  `gh issue edit <number> --add-label "..."` /
  `gh issue edit <number> --remove-label "..."`。
- 关闭：`gh issue close <number> --comment "..."`。

技能要求“发布到 issue tracker”时，创建 GitHub issue。
技能要求“获取相关 ticket”时，读取对应 issue 及其评论、标签。

## PR 请求入口

**PRs as a request surface: no.**

改为 `yes` 后，外部 PR 才纳入分诊队列，使用与 issue 相同的标签和状态规则，
并通过 `gh pr view`、`gh pr diff`、`gh pr list`、`gh pr comment`、
`gh pr edit` 和 `gh pr close` 操作。

GitHub 的 issue 与 PR 共用编号空间。编号类型不明确时，
先用 `gh pr view <number>` 检查；若不是 PR，再用 `gh issue view <number>` 读取。

## Wayfinder 操作

供 `/wayfinder` 使用：一个 map issue 组织多个子 ticket。

- **Map**：使用 `wayfinder:map` 标签，正文维护 Notes、Decisions-so-far 和 Fog。
- **子 ticket**：通过 GitHub sub-issue API 关联到 map。
  若不可用，在 map 正文用任务列表关联，并在子 issue 开头写 `Part of #<map>`。
  类型标签为 `wayfinder:<type>`，其中 type 为
  `research`、`prototype`、`grilling` 或 `task`。
- **阻塞关系**：优先使用 GitHub 原生 issue dependencies：
  `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`。
  其中数据库 ID 通过
  `gh api repos/<owner>/<repo>/issues/<number> --jq .id` 获取，
  不是 issue 编号或 `node_id`。
  若不支持原生依赖，在子 issue 开头写 `Blocked by: #<n>, #<n>`。
  所有阻塞项关闭后，该 ticket 才解除阻塞。
- **可领取任务**：按 map 顺序检查未关闭的子 ticket，排除已有负责人或仍有未关闭阻塞项的任务。
  原生依赖的 `issue_dependencies_summary.blocked_by > 0` 表示仍被阻塞；
  使用文本依赖时，逐一读取阻塞项状态。
- **领取**：会话中的首次写操作为
  `gh issue edit <number> --add-assignee @me`。
- **完成**：先评论记录结果，再关闭 ticket，最后向 map 的
  Decisions-so-far 添加简要结论与链接。
