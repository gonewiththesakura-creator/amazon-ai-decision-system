# Amazon AI Decision System

## Project Goal

第一阶段只验证一件事：系统能否通过可重复、可追溯的工作流，把当前 4 个记忆棉枕头 SKU 与所属市场看明白。页面服务于工作流，不替代工作流。

## Architecture

- 第三方数据只能通过 `server/adapters/` 进入。
- 原始输入先标准化、校验，再写不可覆盖的 Snapshot。
- 确定性计算和 Rule Engine 先于 AI 解释。
- 重要结论必须关联 Evidence、数据版本、规则版本和 Prompt 版本。
- 新产品在建议开发前必须通过 Hard Gate、Reverse Review 和人工 Approval Gate。
- ResearchJob 的状态只能通过 orchestrator 的合法 transition 改变。

## Data Directories

- `data/raw/`：本地原始采集文件，不提交敏感业务数据。
- `data/normalized/`：可重建的标准化中间产物。
- `data/imports/`：导入批次工作区。
- `data/reports/`：可交付报告。
- SQLite 默认文件为 `data/opportunity-intelligence.db`，已由 `.gitignore` 排除。

## Invariants

- 不覆盖历史 Snapshot。
- 不把 Mock/Demo 描述为真实数据。
- 不把缺失字段补成 `0`；使用 null/缺失记录并说明是否阻断决策。
- 不让 AI 重新计算可由代码确定的指标。
- 不输出没有 Evidence 的强结论。
- 不让评分抵消 Hard Gate。
- 不让 AI、worker 或 scheduler 自动采购、付款、判定专利安全或修改线上 Listing。
- 不在前端或日志中暴露 API Key、账号凭据或原始敏感文件。

## Rules And Prompts

- 规则配置位于 `rules/`，数据库中的 RuleProfile 必须保存不可变版本快照。
- Prompt 位于 `prompts/`；修改行为时创建新版本，不原地改变历史 Prompt 语义。
- 固定分析方法位于 `skills/`；执行相关工作流前读取对应 `SKILL.md`。

## Completion Checks

在交付前执行：

```text
npm run lint
npm run typecheck
npm test
npm run build
```

同时验证 migration、空数据、Demo 标识、两次 Snapshot 追加、`needs_data`、Hard Gate 拒绝、Evidence 引用、Reverse Review、Approval 和两个 V2 端到端任务。
