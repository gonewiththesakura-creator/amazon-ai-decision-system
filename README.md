# Amazon AI Decision System

本地优先、可运行的 Amazon 经营研究与决策系统。V2 的核心不是页面数量，而是一条可重复、可恢复、可追溯的工作流：

```text
Research Job -> Data -> Normalize -> Snapshot -> Rule -> AI Explanation
             -> Evidence -> Review Gap -> Reverse Review -> Approval -> Decision
```

系统优先服务于记忆棉枕头市场和自有 SKU 的诊断，同时支持相邻产品与全新赛道的开发决策。V2.1 建立图表优先的经营驾驶舱；V2.2 正在接入真实 SellerSprite MCP、动态产品主数据和审核式历史导入。真实自有 ASIN 与细分市场节点仍需业务核实，不能把公开竞品验证视为自有 SKU 的 Live 验收。

## 本地运行

要求 Node.js 22 或更高版本。

```powershell
npm install
Copy-Item .env.example .env
npm run dev
```

- 前端：`http://127.0.0.1:5173`
- API：`http://127.0.0.1:8787`
- 健康检查：`http://127.0.0.1:8787/api/health`

生产构建：

```powershell
npm run build
$env:NODE_ENV = 'production'
npm start
```

生产服务从 `dist/` 提供前端，默认地址为 `http://127.0.0.1:8787`。

## V2.2 真实数据操作

按 [V2.2 真实数据接入操作手册](docs/V2_2_REAL_DATA_RUNBOOK.md) 配置服务端 MCP 凭据、验证连接与能力、审核导入产品主数据、同步关键批次、审核竞品候选，并在备份及 Dry Run 后清理 Demo、验证覆盖、切换 Live。密钥只放本机/服务器的 `.env`，不要提交或放进 `VITE_*`；公开仓库也不应包含真实业务报表。

自有产品主数据模板：[owned-product-master-template.csv](examples/owned-product-master-template.csv)。增加 SKU 无需修改代码；父子 ASIN 使用 Variation Family 区分。默认数据库在 `data/opportunity-intelligence.db`，备份默认在 `data/backups/`。当前本地 Admin/Viewer 是权限预览，不等于生产身份认证。

## 已实现

- AI 经营驾驶舱：市场 30D、跑赢市场 SKU、需关注 SKU、高增长竞品四项经营 KPI，以及市场/自有 SKU 指数趋势、市场结构、SKU 相对表现、竞品增长、开发机会、研究状态和数据新鲜度。
- 驾驶舱支持 `7D`、`30D`、`90D`、`180D`、`1Y` 范围；每条有效趋势以范围内首个正数观测统一为 `100`，用于比较相对走势，不伪装成绝对体量。
- SKU Focus：从相对表现图下钻单个 SKU，对比所属市场和直接竞品平均，集中查看经营指标、直接竞品 TOP5、正式 AI 判断与仍缺失的数据。
- MarketPage 改为图表优先：先展示销量/销售额/平均价格趋势、价格带、集中度和细分市场机会，再提供完整市场树、TOP100 商品表、AI 判断和事实账本。
- 顶栏“问 AI”只引用当前 Marketplace、当前版本的正式 ResearchJob/Rule/Evidence；证据抽屉展示指标、计算方法、来源时间及 data/rule/prompt 版本，并可回到对应研究任务。证据不足时明确拒绝形成正式结论。
- 桌面侧栏与移动端底部导航自适应；抽屉/移动导航支持键盘焦点约束、`Escape` 关闭与焦点恢复，驾驶舱关键图表提供语义化数据表或文本明细，并适配减少动画偏好。
- ResearchJob、ResearchStep 和集中式 Workflow Orchestrator；状态只能按状态机合法转换。
- 现有市场、自有 SKU、相邻产品、全新机会四类研究任务。
- 原始输入标准化、完整性校验、Missing Data Queue、可补数重试和 retry count。
- 产品与市场 Snapshot 追加写入；数据库触发器拒绝修改历史 Snapshot。
- 21–45 天合法基线的确定性增长计算、自有 SKU 相对市场表现、直接竞品和 TOP100 对照。
- 缺少 Snapshot、历史基线或竞品 cohort 时返回 `null`/缺失记录，界面显示“—”，不会补成 `0`。
- 不可变 RuleProfile 快照、不可降级的 Hard Gate safety floor、五类配置化评分和 RuleExecution。
- Hard Gate 严格校验 IP 枚举、布尔值、数值与范围；未知/非法值进入 `needs_data`，关键 IP、认证、利润、MOQ、重量/尺寸和禁做品类约束不能被自定义 RuleProfile 移除。
- 结构化解释、Review Gap、独立 Evidence、12 项 Reverse Review、Approval Gate 和人工 Decision。
- Evidence 绑定 ResearchJob、当前数据版本、规则版本、Prompt 版本和原始记录 ID。
- 首页、市场、自有 SKU、待开发产品和问答只展示当前 Marketplace 与当前版本匹配的正式工作流结论；旧 Demo Insight 不冒充正式结论。机会晋升生成的开发项目固定引用当次批准的不可变血缘，后续源机会研究不会改写该结论。
- Research Job 列表/详情、步骤时间线、缺失数据补录、证据、反向审查与审批界面。
- SellerSprite/Amazon CSV、XLSX 文件导入，Demo/Mock 明确标识，Marketplace 隔离。
- Opportunity Lab 在空/live 模式只保存待采集研究计划并创建 pending DataTask；没有真实数据时不写零值 MarketNode，也不生成 Opportunity。
- 空/live 模式创建待开发项目时，市场规模、30D 增长、竞争分、机会分和评分拆解保持 `null` 并创建 pending DataTask；真实快照就绪后才确定性回填。
- 旧待开发/机会接口在关联 V2 Job 后不能绕过 Approval Gate。
- V2 Decision 必须携带完整且当前一致的 Job、Insight、Reverse Review、Approval、数据/规则/Prompt 版本链；数据库触发器拒绝残缺、过期、错实体或错动作的写入。
- 版本化规则位于 `rules/`，Prompt 位于 `prompts/`，固定分析方法位于 `skills/`。

## 第一次使用与自有 SKU 初始化

数据库首次创建时为空，不会自动写入 Demo 数据。

1. 打开“设置 -> 自有产品”。
2. 使用“批量初始化自有 SKU”或 V2.2 产品主数据模板导入实际 SKU；Demo 的 4 行只是示例。
3. 核对每个真实 ASIN、内部 SKU、名称、品牌、产品类型和 MarketNode；批量模板按其列名填写父子体信息。
4. 提交后进入“数据任务 -> 审核文件导入”，预览并确认至少两期产品和市场快照。
5. 在自有 SKU 页面维护直接竞品、TOP100、增长竞品或价格竞品关系。
6. 打开“研究任务”，创建 `owned_product` 任务并运行。

批量向导逐行保存，失败行会保留并显示原因；不会把缺失字段补成 `0`。

## 导入 SellerSprite 数据

SellerSprite MCP 已接入服务端；历史文件仍可通过 CSV/XLSX 回填。所有文件导入均先在“数据任务 -> 审核文件导入”检查类型、字段映射、样例行、拒绝原因和新增/更新/重复计数，再确认写入。旧 `/api/import/csv|xlsx` 直传接口返回 `410`，不能绕过预览确认。详见 [操作手册](docs/V2_2_REAL_DATA_RUNBOOK.md)。导入步骤：

1. 打开“数据任务 -> 审核文件导入”。
2. 选择文件来源并核对当前 Amazon 站点；Amazon Business Report 还需填写报表起止日期。
3. 选择产品、市场或评论文件，审核预览内容；未知类型需要人工选择，部分拒绝需明确确认只导入有效行。
4. 评论文件需绑定一个尚未完成的同站点 Research Job；也可在创建产品研究任务时直接粘贴 JSON 数组或逐行 `ProductId | ReviewText`。
5. 在“数据任务”查看成功数、失败数和逐行错误。

示例模板：

- `examples/product-snapshots.csv`
- `examples/market-snapshots.csv`
- `examples/reviews.csv`

产品和市场快照要求完整的时间、核心指标、来源、估算标记与置信度。`estimatedRevenue`/市场销售额可由合法字段推导；其他缺失值不会被伪造。有效新观察追加 Snapshot，不覆盖历史；同来源/实体/业务日期/周期重复导入应按稳定去重身份识别。评论至少需要 `ReviewId`、`ProductId`、`ReviewText`；`Rating` 与 `Date` 缺失时保持 `null`。

市场文件还可提供 `PriceBands` 与 `Concentration` 两个可选 JSON 列。CSV 中 JSON 需按标准 CSV 规则用双引号包裹并把内部双引号写成两个双引号；XLSX 单元格可直接放 JSON 字符串。`PriceBands` 必须是对象数组，每项包含 `label`、`productCount`、`monthlySales`、`revenue`、`avgReviews`、`newProducts`、`growth`；`Concentration` 每项包含 `tier`、`share`、`avgPrice`、`avgSales`。结构有效才会保存；整列缺失时保存空数组，格式错误则该行失败并出现在数据任务错误日志中。工作流只有在当前和 21-45 天基线 Snapshot 都有有效结构时才输出价格带/集中度变化，否则登记为非阻断缺失，不补 `0`。

Review Gap 只把评论中的问题频率作为已知事实。供应链可解性和成本影响必须由任务输入中的 `review_gap_support.<issue>` 提供逐问题、可追溯且已验证的 supplier/cost 证据；缺失时保持 `null` 与 `insufficient_evidence`，不会从任务描述或评论文本猜测。

SellerSprite MCP 通过服务端环境变量接入，先发现真实工具 schema，再映射第一批市场、集中度、ASIN 趋势和竞品发现能力。确认候选竞品后，可在竞品行手动同步其历史快照。浏览器读取已落库的 Snapshot，不会因刷新页面直接调用 MCP；失败不会在 Live 下回退 Mock。

## 启用 Demo

在空数据引导页点击“加载 Demo”，或在“设置 -> 基础设置”打开 Demo 开关。Demo 模式有全局警示条，相关实体、快照和 Evidence 均标记为 `mock`/`DEMO`。

Demo 内置记忆棉市场、4 个虚构自有 SKU、竞品、待开发项目和新赛道样本。正式迁移不应只靠关闭 Demo 开关：先验证真实 MCP/自有 ASIN 链路，再走 Go Live 的备份、Dry Run、范围清理、覆盖校验和 Live 激活。Demo 不代表真实 Amazon 经营数据。

## 两个 V2 验收任务

一条命令可在隔离的内存数据库中运行两个主任务以及所有工作流边界用例：

```powershell
npm run test:v2
```

任务 A 使用 `examples/research-job-gray-sku.json`：先追加 30 天前与当前的 SKU/市场快照，再证明 SKU `-5%`、市场 `+15%`、Relative `-20pp`，结论为产品自身明显跑输；导入文件里故意提供的增长字段不会替代 Snapshot 计算。

任务 B 使用 `examples/research-job-u-shaped.json`：完整经过 Task Book、校验、Hard Gate、配置化评分、评论缺口、Reverse Review 和 Approval Gate；规则建议只授权下一阶段测试，人工批准后才写 Decision，不授权采购、付款、上线或专利安全判断。

测试同时覆盖：空值进入 `needs_data`、补数重试、致命 IP Hard Gate 拒绝、过期 Evidence 拒绝、Marketplace 隔离、旧接口不可绕过审批、正式洞察读取守卫，以及 migration/append-only 约束。

## 数据与架构

```text
React UI
  -> Express API
  -> Workflow Orchestrator
  -> deterministic calculations / Rule Engine
  -> structured explanation / Evidence / Reverse Review / Approval
  -> Repository -> SQLite

DataSourceAdapter
  |- MockAdapter
  |- ManualInputAdapter
  |- SellerSpriteImportAdapter
  |- AmazonImportAdapter
  `- SellerSpriteMCPAdapter (Streamable HTTP, server-only credential)
```

V2.1 驾驶舱聚合接口：

```http
GET /api/dashboard/executive?marketplace=US&range=30D
GET /api/dashboard/executive?marketplace=US&range=30D&skuId=<owned-product-id>
```

`range` 只接受 `7D|30D|90D|180D|1Y`；`marketplace` 必须与当前工作区一致，`skuId` 必须是当前站点的自有 SKU。响应包含 KPI、指数趋势、结构分布、竞品增长、正式结论、开发/研究状态、数据状态和可选 SKU Focus。

SQLite 默认位于 `data/opportunity-intelligence.db`，已被 `.gitignore` 排除。Migration 版本只向前推进并保留可验证的既有业务数据；V14-V15 补齐审批版本链，V16-V19 统一未知指标的 nullable 语义，V2.2 后续迁移补充身份/Variation、观察日期、去重及真实数据登记。迁移详情以代码和测试为准。

如需清空本地业务数据并重建 schema：

```powershell
npm run db:reset
```

该命令会删除本地数据库内容，只应在不需要保留本地数据时执行。

## 未实现

- TOP100 商品缺少可信的上架日期或首次观测日期，因此“新品”排序在界面中禁用；系统不会根据 Review、销量或其他代理字段推断商品是否为新品。
- 真实自有 ASIN、经核实的记忆棉细分市场节点及完整 Live 验收仍依赖业务数据；公开类目或公开竞品验证不能代替。
- 外部大模型调用：当前 `AI` 步骤使用可复现的 `rule-engine-v1` 生成结构化解释；`OPENAI_API_KEY` 仅为服务端预留。
- 常驻 worker/scheduler：频率和任务记录已建模，当前由用户手动运行/重试。
- 企业级身份认证和多租户授权：Admin/Viewer 只是本地权限预览。
- 广告、退货、库存、供应商报价、真实利润和专业 IP/合规数据源。
- 自动采购、付款、专利安全判定、线上 Listing 修改；这些行为被明确排除。

## 质量检查

交付前执行以下四项检查，并以当次命令输出为准；不要沿用旧版本的测试数量或构建结果。

```powershell
npm run lint
npm run typecheck
npm test
npm run build
```

## V2.1 截图

- [AI 经营驾驶舱](artifacts/screenshots/v2.1-executive-dashboard.png)
- [SKU Focus](artifacts/screenshots/v2.1-sku-focus.png)
- [移动端驾驶舱](artifacts/screenshots/v2.1-mobile-dashboard.png)

更多实现状态见 `CURRENT_STATE.md`，V2.1 交付说明见 `V2_1_IMPLEMENTATION_SUMMARY.md`，迁移记录与后续边界见 `V2_IMPLEMENTATION_PLAN.md`。
