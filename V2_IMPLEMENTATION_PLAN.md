# V2 Implementation Record

## 迁移方案

1. 保留 V1 API 与既有业务数据，使用只向前推进的 SQLite 增量 migration；需要调整约束时以事务化表重建迁移完成。
2. 为工作流对象增加独立表和 nullable 兼容关联，不覆盖历史 Snapshot 或 Decision。
3. 新结果写入独立 Evidence，并绑定当前 dataVersion；旧 Insight 保持可读。
4. RuleProfile 从版本化 JSON seed，ResearchJob 创建时保存不可变配置快照。
5. 同步 Workflow Orchestrator 先保证事务、状态和可重试边界；常驻 worker/scheduler 留到真实数据源阶段。

## 已完成的数据库变更

- V1-V4：基础业务、Marketplace 与监控/任务兼容结构。
- V5：ResearchJob/Step、RuleProfile/Execution、ScoreResult、Evidence、Missing Data、Review/ReviewInsight、Reverse Review、Approval，以及 Decision/Insight/DataTask 的工作流关联。
- V6：竞品关系加入 `price_peer`。
- V7-V8：补偿缺失表和 Missing Data 唯一约束。
- V9-V12：Evidence 来源元数据/dataVersion，Insight 结构字段，ReviewInsight 与 RuleExecution 的 dataVersion 和索引。
- V13：为升级数据库中的既有工作流产物回填父 Job dataVersion，并用触发器强制 Product/Market/Keyword Snapshot 不可修改。
- V14：为 Reverse Review 与 Approval 增加 data/rule/prompt 版本链，并让 Approval 绑定具体 Reverse Review。
- V15：增加 Decision lineage 触发器；带工作流来源的 Decision 必须完整匹配 ResearchJob、AI Insight、Reverse Review、Approval、data/rule/prompt 版本、目标实体和获批动作，已进入 V2 的实体不能再写无 lineage 的 Decision。
- V16：重建 `development_projects`，将市场规模、30D 增长、竞争分和机会分改为 nullable；迁移保留既有数据与外键，并在表交换后重建 V15 Decision lineage 触发器。
- V17：把无 Evidence 的历史开发零值哨兵改为 `null`，并精确清理旧 Opportunity Lab 生成、未被工作流/Decision 使用的无数据占位机会，同时修复 ResearchResult 与监控引用。
- V18：保留 MarketNode 旧兼容列，新增 nullable 业务评分列；只有具备最新 Snapshot 与 21-45 天正基线的历史节点才迁移旧评分。
- V19：让已应用早期 V16/V18 的本地数据库收敛到最终 null/基线语义。

所有 migration 在 `BEGIN IMMEDIATE` 事务中执行，并以 `schema_migrations` 记录版本。

## 已完成模块

- ResearchJob 状态机、Repository 与集中式 Workflow Orchestrator。
- Adapter -> Normalize -> Validate -> immutable Snapshot -> deterministic calculation。
- Missing Data Queue、字段级补数、重试计数和数据版本更新。
- 版本化 Rule Engine、不可降级的 fatal Hard Gate safety floor、严格输入域校验、五类评分与 RuleExecution。
- 独立 Evidence、当前数据版本隔离和原始记录引用。
- Review Gap 的逐问题供应链/成本证据门、12 项 Reverse Review、Approval Gate 和人工 Decision。
- 首页、市场、自有 SKU、待开发产品、通用 Insight 与问答入口的正式工作流读取守卫；读取严格锚定对象最新任务，机会晋升项目则锚定当次批准的推进 Decision。
- Snapshot、历史基线和 cohort 缺失时严格使用 `null`，不以零值伪装可用数据。
- Opportunity Lab 在空/live 模式只创建 pending 研究计划/DataTask，不写零值 MarketNode 或 Opportunity。
- 空/live 模式创建待开发项目时，未知市场指标和评分拆解保持 `null`，对应 DataTask 为 pending；真实 Snapshot 与合法基线就绪后才确定性回填。
- 现有市场、自有 SKU、相邻产品和全新机会工作流。
- Research Job 工作台、步骤时间线、Task Book、Evidence、缺失数据和审批面板。
- Marketplace 隔离及关联 V2 Job 后的旧 API 防绕过守卫。
- 两个 V2 端到端验收任务和 migration/append-only 回归测试。

## 推迟到后续阶段

- SellerSprite MCP 正式鉴权/schema 与实时采集。
- 外部 LLM Provider、异步队列、常驻 worker/scheduler。
- 企业身份认证、多租户权限、生产审计与密钥服务。
- 广告、退货、库存、供应链成本和专业 IP/合规数据连接。
- 全 Amazon 泛选品扩展；当前仍优先验证现有 4 个记忆棉 SKU。

## 保留风险与控制

- 数据不完整：用 `needs_data` 阻断，绝不补零或以 Demo 替代。
- 规则漂移：Job 锁定 RuleProfile 版本和配置快照。
- 结果串版：Insight/Evidence/RuleExecution/ReviewInsight 按 Job 当前 dataVersion 读取。
- AI 不可用：确定性计算仍可完成，结构化解释不重新计算指标。
- 审批越权：Hard Gate、Reverse Review、当前 Evidence 和人工 Approval 缺一不可；V15 触发器拒绝残缺或错配的 Decision lineage。
- 规则降级：critical IP、必需认证不可用、利润/MOQ/物流上限及禁做品类属于不可移除安全底线；非法枚举、布尔、数值和范围进入 `needs_data`。
- 外部动作：系统只记录研究决定，不自动采购、付款、上线或做专利安全结论。

## 验收入口

```powershell
npm run test:v2
npm run lint
npm run typecheck
npm test
npm run build
```

验收数据位于 `examples/research-job-gray-sku.json` 和 `examples/research-job-u-shaped.json`；完整运行说明见 `README.md`。
