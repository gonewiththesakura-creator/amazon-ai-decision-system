# V2.1 老板驾驶舱 UI 重构计划

## 页面修改

- `DashboardPage`：改为“AI 经营驾驶舱”，按四项 KPI、市场与 4 SKU 指数趋势、市场集中度、SKU 相对表现、竞品增长、今日判断、开发机会与研究状态组织两屏内容。
- `DashboardPage / SKU Focus Mode`：在驾驶舱内聚焦单个 SKU，展示 SKU、所属市场、直接竞品平均趋势，以及经营指标、TOP5 竞品、正式诊断和友好缺失提示。
- `MarketPage`：保留现有二级详情能力，并从驾驶舱图表提供入口；图表顺序继续以趋势、结构、排行和结论为主。
- `OwnedProductsPage`：保留完整 SKU 战情室作为二级详情，驾驶舱聚焦模式不复制技术配置和编辑功能。
- `AppShell`：导航改为驾驶舱、现有业务、增长机会、研究与数据、设置；研究与数据及设置默认折叠，首页提供轻量“问 AI”抽屉入口。

## 组件复用

- 复用 `EvidenceDrawer` 展示正式 Insight 的数据依据和技术血缘。
- 复用 `Badge`、`StateViews`、`Onboarding`、`useApi`、`AppContext` 和现有格式化工具。
- 复用 Recharts，并统一新增 `ChartCard`、`ChartEmptyState`、图例和 Tooltip 外观。
- 复用 Owned SKU 页已有的产品、竞品和趋势表达，但首页只保留老板日常决策所需字段。

## 新增 ViewModel / API

- 新增 `ExecutiveDashboardViewModel`，包含市场、四项 KPI、指数趋势、SKU 相对表现、集中度/价格带、增长竞品、今日判断、开发机会、研究状态和数据状态。
- 新增只读接口 `GET /api/dashboard/executive`，由服务端完成 Marketplace 隔离、范围筛选、指数化、排行、正式 Insight 筛选和数据状态聚合。
- 时间范围支持 `7D | 30D | 90D | 180D | 1Y`；基准值为范围内首个有效且大于零的数据点，无合法基准时不生成该 Series。
- SKU Focus 数据作为同一 ViewModel 的聚焦读取参数返回，不让 React 重新计算业务结论。

## 明确不修改的后端逻辑

- 不修改 ResearchJob 状态机和 Workflow Orchestrator transition。
- 不修改 Snapshot 追加写与不可变约束。
- 不修改 Hard Gate、Rule Engine、Relative Performance 或评分业务含义。
- 不修改 Evidence、Review Gap、Reverse Review、Approval Gate 和 Decision lineage。
- 不新增 UI 到 SellerSprite MCP 的直接调用，不改变 Adapter 数据入口。
- 不自动采购、付款、判断专利安全或修改线上 Listing。
