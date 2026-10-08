# 领域文档

本仓库采用 single-context 布局，领域术语与架构决策集中在根目录下维护。

## 探索代码前

- 阅读根目录的 `GLOSSARY.md`。
- 阅读 `docs/adr/` 中与当前工作相关的 ADR。
- 如果未来存在根目录 `GLOSSARY-MAP.md`，按其索引读取相关上下文的
  `GLOSSARY.md`，并检查 `src/<context>/docs/adr/` 中的局部决策。

这些文件或目录不存在时，静默继续，不报告缺失，也不预先建议创建。
`/domain-modeling` 会在术语或决策真正明确时按需创建它们；
`/grill-with-docs` 和 `/improve-codebase-architecture` 也可引导至该技能。

## 文件布局

以下为约定位置，不要求在初始化时创建：

```text
/
├── GLOSSARY.md
├── docs/
│   └── adr/
│       ├── 0001-<decision>.md
│       └── 0002-<decision>.md
└── src/
```

## 使用统一术语

在 issue 标题、重构建议、诊断假设、测试名称等输出中，
使用 `GLOSSARY.md` 定义的领域术语，避免改用术语表明确排除的同义词。

需要的概念尚未收录时，先判断是否引入了项目并不使用的概念；
若确属术语缺口，记录下来供 `/domain-modeling` 处理。

## 显式指出 ADR 冲突

输出与已有 ADR 冲突时，明确引用该 ADR 并说明重新讨论的理由，
而不是静默覆盖原有决策。例如：

> 与 ADR-0007 冲突，但值得重新讨论，因为……
