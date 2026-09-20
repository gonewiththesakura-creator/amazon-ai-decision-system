# Current State

记录时间：2026-09-21。本文描述 V2.2 代码交付后的仓库状态，并把模拟契约验证与尚未完成的真实业务验收明确分开。

## 技术栈

- React 19、TypeScript、Vite、React Router、Recharts、Lucide。
- Express 5 REST API。
- Node.js 22 内置 `node:sqlite`，使用事务化增量 migration。
- Vitest、Supertest、Testing Library、ESLint。

## 产品能力

- 首页为 AI 经营驾驶舱，按当前 Marketplace 动态聚合市场、全部 active 自有 SKU、关联竞品、待开发项目、ResearchJob 和 DataTask；支持 `7D`、`30D`、`90D`、`180D`、`1Y` 时间范围。
- 驾驶舱包括四项经营 KPI、市场与最多 5 个重点 SKU 的指数趋势、市场集中度/价格带、完整 SKU 相对表现、竞品增长 TOP10、正式 AI 今日判断、开发机会评分、产品研究状态和数据新鲜度。
- 点击 SKU 相对表现进入 SKU Focus；该视图提供 SKU/市场/直接竞品平均趋势、九项当前经营指标、直接竞品 TOP5、正式结论和待补数据提示，并保留时间范围与 URL 状态。
- MarketPage 使用图表优先的信息层级：趋势和市场结构先于明细表，并提供章节导航、空快照引导、来源/采集时间/可信度、细分机会排名、市场树、TOP100 与事实账本。
- 顶栏“问 AI”支持建议问题和自由提问，但只把当前正式 ResearchJob 的 Insight/Evidence 作为正式回答；证据不足、问题歧义或竞品个体排名无证据时明确提示，不拿无关旧结论代答。
- Dashboard Evidence 抽屉展示指标、计算方法、来源、采集时间、dataVersion、RuleProfile 及 Prompt 版本并链接到 ResearchJob；AI 问答证据视图同时展示 provenance、模型、dataVersion 和生成时间。
- 桌面、平板和移动端均有响应式布局；移动端使用导航对话框与底部快捷导航。对话框支持焦点约束、`Escape`、焦点恢复和背景滚动锁定，驾驶舱关键图表提供可访问数据表或等价文本明细，并尊重 `prefers-reduced-motion`。
- 除驾驶舱外，还包括记忆棉市场、自有 SKU、待开发产品、新赛道实验室、机会池、研究任务、监控中心、数据任务和设置。
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
- V2.2 增加 Product Master 生命周期、Variation Family、Marketplace 级身份解析、`observationDate`/`collectedAt` 分离、稳定去重键和多来源 Metric Authority；相同事实不会因重复导入而翻倍，也不会让 SellerSprite 估算覆盖 Amazon actual。
- SellerSprite MCP 使用服务端 Streamable HTTP Client；运行时 `listTools` 建立 Capability Registry，远端响应经 schema、Marketplace、节点、ASIN 和月份校验后才能标准化并写 Snapshot。调用账本、缓存、限流、超时、重试和错误脱敏均位于服务端。
- `critical_sync` 为每次运行创建唯一 `runId`。fresh `listTools`、能力快照、当前月与上月市场数据、全部 active 真实自有 SKU、候选/直接竞品 coverage、Snapshot、Fact 和后续 Evidence 都关联该运行；Go Live 不允许跨运行拼证据。
- Live 读取拒绝 Mock 及 failed/running MCP 观察；失败批次保留上一份合法真实 Snapshot 并显示“部分未更新”。主市场与全部自有 SKU 是原子批次，直接竞品为可部分失败的 secondary batch。
- Variation Family 的父体保留在产品主档、单品详情和历史记录中，但不会进入 SKU/市场商品聚合、工作流竞品 cohort、批量刷新、关键同步或 Go Live Evidence 分母；active Mock 父体仍会阻断 Live。

## 确定性分析

- 增长率使用约 30 天前的最近合法基线 Snapshot 计算，不信任导入文件自带的增长百分比替代历史计算。
- 自有 SKU 诊断输出市场增长、SKU 增长、Relative delta、直接竞品和 TOP100 对照。
- 新产品规则包含需求质量、竞争进入性、利润与现金效率、供应链匹配和风险控制五类配置化得分。
- 评论缺口使用固定 taxonomy 形成可复现结果；供应链可解性与成本影响没有逐问题验证证据时保持未知。
- 结构化解释由 `rule-engine-v1` 生成，不冒充外部模型，也不重新计算代码已确定的指标。

## 主要 API

- `/api/dashboard/executive?marketplace=<current>&range=7D|30D|90D|180D|1Y[&skuId=<owned-product-id>]`
- `/api/research-jobs` 及 `/:id/run|retry|approve|reject|steps|evidence|missing-data`
- `/api/rules/profiles`
- `/api/markets`、`/api/owned-products`、`/api/development-projects`、`/api/opportunities`
- `/api/data-tasks` 及 `/:id/retry`、`/api/data-coverage`
- `/api/import/preview`、`/api/import/confirm`；旧 `/api/import/csv|xlsx` 已关闭，不能绕过预览确认
- `/api/integrations/sellersprite/test|capabilities|sync/*`、竞品候选审核接口
- `/api/go-live/preview|backup|cleanup|verify|activate`
- `/api/ai/insights`

所有工作流读取和写入均受当前 Marketplace 约束。已有 V1 API 保留兼容性，但关联 ResearchJob 后不能通过旧开发/机会动作绕过 V2 Gate。

## 版本化资产

- `rules/`：现有市场、自有 SKU、新产品 RuleProfile JSON；Job 创建时锁定不可变快照。
- `prompts/`：市场诊断、自有 SKU、产品研究、Review Gap、Reverse Review 的版本化 Prompt。
- `skills/`：五套固定分析方法，每个 Skill 均通过结构校验。
- `examples/`：产品/市场导入模板和两个 V2 验收任务输入。

## 当前边界

- TOP100 商品数据尚无可信的上架/首见日期；“新品”排序已禁用，不根据销量、Review 或标签推断新品身份。
- SellerSprite MCP 真实 Transport、Capability Registry、同步与 Go Live 证明链已实现，不再是 Stub；但本机尚未配置 `.env`，也没有经核实的真实市场节点和真实自有 ASIN，因此真实 provider schema、Market/Product Snapshot、Dashboard 与 Evidence 链仍未完成现场验收。
- 当前本地数据库仍为 Demo：真实链成功前不会清除 Mock，不会切换 Live。Dry Run 会单独列出两项需人工确认的 Demo/manual 历史；清理与激活继续受备份、覆盖和明确确认文本保护。
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
- 动态 SKU `0/1/4/5/12/50`、父子体、历史导入幂等、MCP 模拟契约、运行级追溯、Live no-Mock 与 Demo 清理门禁：已由自动化测试覆盖。
- 2026-09-21 的最新交付验证为 lint、typecheck、51 个测试文件共 533 项和 production build 全部通过；额外在 `TZ=America/Los_Angeles` 下验证 XLSX 业务日期；公开 PR 当前提交的 push/pull-request 两个 CI `verify` 均成功。
- 真实验收仍未完成：Connection/Auth/listTools、真实 Tool Schema、真实市场/ASIN/竞品候选、真实历史回填、同运行 Dashboard/Evidence、Demo Cleanup 与 Live 激活均等待本机凭据和业务主数据，不能以模拟测试替代。

## V2.1 视觉验收

- `artifacts/screenshots/v2.1-executive-dashboard.png`：桌面经营驾驶舱。
- `artifacts/screenshots/v2.1-sku-focus.png`：单 SKU 聚焦视图。
- `artifacts/screenshots/v2.1-mobile-dashboard.png`：移动端经营驾驶舱。
