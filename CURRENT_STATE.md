# Current State

记录时间：2026-09-11。本文描述 V2 完成后的仓库状态。

## 技术栈

- React 19、TypeScript、Vite、React Router、Recharts、Lucide。
- Express 5 REST API。
- Node.js 22 内置 `node:sqlite`，使用事务化增量 migration。
- Vitest、Supertest、Testing Library、ESLint。

## 产品能力

- 今日简报、记忆棉市场、自有 SKU、待开发产品、新赛道实验室、机会池、研究任务、监控中心、数据任务和设置。
- 空数据库引导、明确标记的 Demo 模式、Admin/Viewer 本地权限预览、桌面和移动端布局。
- 四类 ResearchJob：`existing_market`、`owned_product`、`adjacent_product`、`new_opportunity`。
- 可查看步骤状态、数据版本、规则版本、Prompt 版本、缺失数据、Evidence、Review Gap、Reverse Review、Approval 和最终 Decision。
- 首页、市场、自有 SKU、待开发产品与问答入口只展示当前版本正式 Research Job 结论；没有正式结论时明确要求运行工作流。机会晋升项目保留当次批准血缘，项目自身的新任务则优先于继承血缘。

## 工作流与数据

- `WorkflowOrchestrator` 是 ResearchJob 运转和人工决定的入口；Repository 在每次 transition 时校验状态机。
- 第三方数据通过 `server/adapters/` 进入，标准化和校验后追加 Product/Market Snapshot。
- 数据不足时进入 `needs_data`；Missing Data Queue 只允许补录已登记字段，补数后更新 dataVersion 并重跑相关步骤。
- Snapshot ID、规范化字段和计算上下文进入 dataVersion；当前版本的 Insight、Evidence、RuleExecution、Score 和 ReviewInsight 不与旧轮次混用。
- 新产品先跑 fatal Hard Gate，再评分；分数不能抵消 Gate。不可降级的 safety floor 始终检查关键 IP、认证、利润、MOQ、重量/尺寸和禁做品类，不能被 API 创建的弱 RuleProfile 移除。
- IP 枚举、认证/供应链布尔值、产品与 Task Book 数值、百分比、尺寸和价格范围均严格校验；未知或非法值进入 `needs_data`，不会继续评分。
- 人工 Decision 单独留档，关联 Approval、ResearchJob、Insight、规则版本、Prompt 版本、数据版本和 Evidence IDs。
- V15 数据库触发器进一步要求 Decision 的 Job、Insight、Reverse Review、Approval、版本、实体和动作完整一致；残缺、过期或错配 lineage 无法写入。
- Reverse Review 固定检查 12 类失败模式；Reverse Review 与 Approval 均绑定不可变版本链，Approval 还绑定具体审查记录。
- Opportunity Lab 在空/live 模式只保留待采集研究计划和 pending DataTask；无真实数据时不落零值 MarketNode，也不创建 Opportunity。
- V16-V19 后，空/live 模式的待开发项目将市场规模、30D 增长、竞争分、机会分和评分拆解保存为 `null`；空市场节点的评分同样为 `null`。对应 DataTask 保持 pending，只有存在合法 Snapshot 基线时才重算。

## 确定性分析

- 增长率使用约 30 天前的最近合法基线 Snapshot 计算，不信任导入文件自带的增长百分比替代历史计算。
- 自有 SKU 诊断输出市场增长、SKU 增长、Relative delta、直接竞品和 TOP100 对照。
- 新产品规则包含需求质量、竞争进入性、利润与现金效率、供应链匹配和风险控制五类配置化得分。
- 评论缺口使用固定 taxonomy 形成可复现结果；供应链可解性与成本影响没有逐问题验证证据时保持未知。
- 结构化解释由 `rule-engine-v1` 生成，不冒充外部模型，也不重新计算代码已确定的指标。

## 主要 API

- `/api/research-jobs` 及 `/:id/run|retry|approve|reject|steps|evidence|missing-data`
- `/api/rules/profiles`
- `/api/markets`、`/api/owned-products`、`/api/development-projects`、`/api/opportunities`
- `/api/data-tasks` 及 `/:id/retry`
- `/api/import/csv`、`/api/import/xlsx`
- `/api/ai/insights`

所有工作流读取和写入均受当前 Marketplace 约束。已有 V1 API 保留兼容性，但关联 ResearchJob 后不能通过旧开发/机会动作绕过 V2 Gate。

## 版本化资产

- `rules/`：现有市场、自有 SKU、新产品 RuleProfile JSON；Job 创建时锁定不可变快照。
- `prompts/`：市场诊断、自有 SKU、产品研究、Review Gap、Reverse Review 的版本化 Prompt。
- `skills/`：五套固定分析方法，每个 Skill 均通过结构校验。
- `examples/`：产品/市场导入模板和两个 V2 验收任务输入。

## 当前边界

- SellerSprite MCP 没有真实账号/schema，只有显式 unavailable 的 Adapter stub；文件导入可用。
- 外部 LLM 尚未接入，当前解释完全可重复；确定性指标始终由代码计算。
- 常驻 scheduler/worker 尚未启用，监控和 DataTask 当前由人工触发。
- Admin/Viewer 不是身份认证；真实部署前需要账户、授权、审计与密钥管理。
- 真实广告、退货、库存、成本、供应商、合规和 IP 数据仍需接入；系统不会自动采购、付款、判专利安全或修改 Listing。

## 验收状态

- 两次 Snapshot 追加与不可覆盖约束：已覆盖。
- 空数据和 Demo 标识：已覆盖。
- `needs_data`、补数重试和不以 `0` 代替缺失：已覆盖。
- Hard Gate 拒绝、不可降级 safety floor、严格输入域与 Evidence 当前版本引用：已覆盖。
- Review Gap、Reverse Review、Approval、Decision：已覆盖。
- 灰色 SKU 与 U 型枕两个 V2 端到端任务：已覆盖。
- lint、typecheck、全量测试和生产 build：已通过；最终文件数和测试数以交付时命令输出为准。
