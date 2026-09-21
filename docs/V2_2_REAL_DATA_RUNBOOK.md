# V2.2 真实数据接入操作手册

本手册用于在同一 SQLite 数据库中验证真实 SellerSprite 数据、导入真实自有产品并审核后切换 Live。**连接成功不等于业务验收完成**：还需核对市场节点、自有 ASIN、Snapshot、竞品候选、数据覆盖和 Evidence。不要用 Demo 或空值补齐真实数据。

## 运行与凭据

要求 Node.js 22+。首次运行：

```powershell
npm install
npm run dev
```

在本机或服务器的 `.env` 中填写 `SELLERSPRITE_MCP_URL`（不含用户名、密码或任何密钥查询参数的 MCP 地址）和 `SELLERSPRITE_MCP_SECRET`。端点解析器会拒绝 URL 内嵌凭据；带 Secret 的远程地址必须使用 HTTPS，本机回环地址才允许 HTTP。两者只能供服务端读取。不要放入 `VITE_*`、命令行历史、截图、工单、日志或公开 Git 仓库。`.env`、本地数据库、备份和原始业务文件已被 Git 忽略。公开仓库不应包含真实 SKU 报表或凭据；向外部署前还需另行配置正式身份认证，当前 Admin/Viewer 只是本地权限预览。

默认前端为 `http://127.0.0.1:5173`，API 为 `http://127.0.0.1:8787`。首次打开数据库会执行向前迁移。不要对有业务数据的数据库运行 `npm run db:reset`，该命令会删除本地内容。

真实链验收必须先启动专用 API 进程，将 `DATABASE_PATH` 指向独立验收数据库，并在该隔离库核对市场节点和产品主数据；不得把验收 runner 指向默认业务库。`acceptance:real` 限制调用路由，但不创建或校验数据库隔离。核对完成后，用专用进程的 loopback 地址执行：

```powershell
npm run --silent acceptance:real -- --base-url http://127.0.0.1:<isolated-port> --month 202609
```

该命令按固定顺序执行预检、连接、关键同步与本次 fresh `listTools` schema 指纹检查、候选发现和直接竞品 secondary coverage 校验、该运行捕获的真实子 SKU roster 对应的数据库驾驶舱读取及同 `runId` 指标读路径证明、市场/产品 Research Job、同 `runId` Evidence 及 Go Live 清理前证明。读路径证明允许其他 Demo 行保留，但本次主市场和每个真实子 SKU 当前选中的指标必须链接到本次运行；证明失败时不会创建验收 Job。默认连接本机 `127.0.0.1:8787`，单次请求最长等待两小时；可用 `--base-url http://127.0.0.1:<port>` 和 `--timeout-ms <milliseconds>` 指定其他本机 API 与 1 秒到 4 小时的边界。只连接可信的本机 API，不跟随 HTTP 重定向；当前 Admin/Viewer 不是真实部署身份认证。输出只有布尔状态、计数、服务端 `runId` 和安全规范化后的 schema 合同 SHA-256，不输出端点、原始 schema、ASIN、标题、文件路径、远端错误或 Secret。`dashboardOwnedProducts` 是页面实际行数，`verifiedDashboardOwnedProducts` 是本次运行 roster 中通过读路径证明的真实 SKU 数；保留 Demo 时两者可以不同。`acceptanceScope=critical_market_and_owned_skus` 限定 `ok` 的含义，`manualCompetitorReview=confirmed` 仅在数据库中有已人工确认的真实直接竞品时出现，缺少时为 `missing`；`competitorCandidates=0` 或 `directCompetitors=0` 时不能宣称首条含竞品的真实验收链完成。失败返回非零退出码。该命令不会预览/备份/清理 Demo、切换 Live、确认或拒绝竞品候选，也不会替代产品身份和市场节点的人工核实。

## 先验证真实链路

1. 保留现有 Demo。打开“设置 -> 数据源”，执行“连接测试”。检查认证、工具数量、必需能力及延迟；能力列表来自实际 `listTools`。诊断不应显示密钥。
2. 确认当前 Marketplace 和“默认市场节点”属于目标站点。在“设置 -> 数据源”输入并核对 SellerSprite 数字节点路径，勾选站点/类目范围确认后保存为 `market_nodes.sellersprite_confirmed_node_path`；未映射的市场会拒绝同步，不退用本地节点 ID。不能因为名称包含 pillow 就把宽泛 Bed Pillows 类目当成已验证的 Memory Foam Pillow 细分市场。
3. 打开“数据任务 -> 审核文件导入”，选取 `examples/owned-product-master-template.csv` 结构的真实产品主数据文件。预览识别类型、新增/更新/重复/错误计数、字段映射、样例行和拒绝原因；未知类型先人工选择，再用新预览确认。模板列为 `marketplace,asin,sku,internalName,brand,title,productType,parentAsin,variationFamilyKey,parentLookupStatus,variationTheme,marketNode,monitoringEnabled,status`。未确认的父体保留空值；已知同族但父体未知时可用稳定的内部 `variationFamilyKey` 与 `pending` 标记，真实父体经核验后才填 `parentAsin` 与 `verified`。独立单品用 `standalone`。不能推断兄弟关系或编造 Variation Theme，也不要把父体销量与子 SKU 销量相加。Product Master 批次是全有或全无：有任何无效行就禁止确认，修正后必须重新预览。
4. 在“设置 -> 数据源”选观察月份后执行“同步关键数据”。服务端先创建唯一 `runId` 和运行中的 `critical_sync` DataTask；本次 `listTools`/能力快照、主市场及每个当前真实自有 SKU 所在 distinct 子市场的当前月与上月统计/集中度、当前站点全部 active 且非 Mock 的自有 ASIN 趋势、候选发现、已确认直接竞品刷新、Snapshot、metric fact、coverage 和后续 Evidence 都用该 `runId` 关联。所有市场节点的两个月份须由本次运行分别请求、校验和链接，不能拼接两次历史运行；关键市场工具必须在本次发现的 schema 中声明 `month` 参数，统计和集中度响应也必须回显与请求一致的月份，否则本次运行按契约失败处理，不能把无月份响应认证为对应历史月份。普通只读调用携带月份参数，也不能因为请求月份存在就被当作历史观察月份证据。主市场、所需子市场双月与全部真实自有 SKU 是原子关键批次：任一关键调用失败时不写本批业务观察，只留下脱敏失败任务和不完整 coverage，并继续展示上一次合法真实 Snapshot，不回退 Mock。相同周期只有在标准化结果完全一致时才可通过 run-to-observation 链接复用；Snapshot 和 fact 的首次来源不被改写，Evidence 继承最近一次完整复核运行，值发生修订则拒绝认证。
5. 关键批次成功后，候选发现和已确认 `direct` 竞品作为非阻断 secondary 阶段继续运行并分别记录 coverage；单个竞品失败会形成 `partial`，不会推翻关键批次。候选只写入待审核池，不会自动成为直接竞品。到自有产品详情的“竞品”页按价格、形态、功能、人群及相似度人工核对，填写纳入理由并确认或拒绝；也可从该页再次发现候选或单独刷新已确认竞品。关系被撤销或远端 ASIN/站点不一致时拒绝落库。`observationDate` 采用业务月份或趋势点日期，`collectedAt` 是抓取时间。
6. 查看“数据任务”的真实数据覆盖，以及市场、自有产品和驾驶舱上的来源、日期与缺失值。页面读取数据库 Snapshot，刷新页面不会触发 MCP。历史不足时继续通过已验证的 MCP 趋势和文件补数；为主市场及每个当前 active 自有 SKU 分别运行非 Demo Research Job，检查 Rule/Evidence 是否指向本次 `runId` 的真实来源记录，并确认工作流进入 monitoring、最终 Insight 引用了 Evidence、分析和报告步骤均完成。SKU 与市场相对增长只比较同一组基线月和当前月；两者都是 MCP 时还必须属于同一个完整 `runId`，否则进入 `needs_data`。直接竞品和 TOP100 的错位月份或跨运行 MCP 数据不进入均值，不得拼接成相对结论。Amazon 实际值与 MCP 市场值可形成明确标记为混合来源的人工派生结论，但不冒充同运行 MCP Evidence。Go Live 面板中的“运行 Evidence”必须达到“主市场 + 当前全部自有 SKU”的覆盖数。竞品关系仍需人工审核。

市场统计返回的 `products`/价格等指标可能只覆盖工具返回的商品 cohort；集中度列表或 TOP100 的销量不能自动当成整个类目总销量。接口未给出可信全类目总量时保留 `null`，界面显示“—/数据不足”，不填 `0`。SellerSprite 的自有 ASIN 销量是估算，不能替代 Amazon 真实销量；导入/接口的原始事实分别保留，展示时按来源权威规则选择。

## CSV/XLSX 历史回填

走“数据任务 -> 审核文件导入”：选择文件 -> 审核类型、字段映射、样例行和拒绝原因 -> 未知类型人工选择并重新预览 -> 确认导入 -> 查看任务记录。样例最多展示 20 行，未展开行仍会随整个文件处理；对重要批次还应检查原文件或在隔离库验证，不能仅凭样例批准。产品、市场和评论模板分别见 `examples/product-snapshots.csv`、`examples/market-snapshots.csv`、`examples/reviews.csv`。快照文件需要业务日期及模板要求的指标；缺字段的行报错，不会用零填补。预览令牌短期有效，过期需重新预览；同来源/日期/周期的重复记录不会因重复上传而翻倍。旧直传 API 已关闭。

优先核对市场 12 个月（至少 90 天）、自有 SKU 90–180 天、核心竞品约 90 天。完整真实验收还要求主市场达到 90 天有效历史、人工确认至少一个真实直接竞品；Live 门禁不会把候选发现当成人工确认。Amazon Business Report 支持已验证的 `(Child) ASIN`、`SKU`、`Units Ordered`、`Ordered Product Sales` 等字段组合，必须明确报表日期范围；其他未知布局仍会拒绝，不能把任意报表当成已兼容结构。导入后检查 `observationDate` 与 `collectedAt` 是否分离、站点/ASIN/Variation 身份是否正确，并查看是否有部分失败。原始文件只留在受控的本地/服务器数据目录，不提交公开仓库。

## Demo 清理与 Live 激活

只有真实链路和产品身份已核对后，才在“设置 -> 数据源 -> Go Live 迁移”操作。不要先清 Demo 再尝试证明真实链路：

1. 查看 Dry Run 的预计删除、归档、保留和引用阻断项；先处理真实工作流对 Demo 记录的引用。清理只针对明确登记或可识别的 Demo 观察及相关演示实体，不是数据库重置；产品主数据、规则和真实历史应保留，未知或混合来源的 Mock 记录会阻断清理。
2. **备份和清理之前**，先验证 `/api/go-live/verify` 返回非空 `sellerSpriteCriticalRunId`。验证器只接受同一个完整 `critical_sync` 运行中的 fresh `listTools`、能力快照、双月市场统计/集中度、当前真实自有 ASIN 趋势调用、候选/竞品 coverage、对应 run-to-Snapshot 链接，以及主市场和每个当前自有 SKU 的同运行非 Demo 已完成工作流 Evidence；不会把不同时间或不同运行的成功片段拼接。运行后新增 SKU、站点/数字节点路径变化、范围外 SKU、失败调用、缺少链接或不完整 roster 都会让 `readyForDemoCleanup` 保持 `false`。公开竞品 ASIN 或 Demo Snapshot 不可替代自有 ASIN。该状态只是清理前证明，**不代表**已满足 Live 切换条件。
3. 点击“备份数据库”，确认备份创建。备份目录默认为 `data/backups/`，位于本机且不进 Git；另行按业务要求保护和保留备份。备份后若数据库又发生写入（包括重新同步或导入），原备份会过期，清理前必须重新备份。
4. 输入精确确认文本 `CLEAR DEMO DATA`，再清除演示数据。缺少清理前证明、备份或有引用阻断项时按钮不可用，服务端也会拒绝清理。Dry Run 会单独列出规则生成的 Demo 分数 Evidence 和旧 Demo 人工拒绝记录的脱敏引用，供人工确认；它们不会因为出现于清单而自动删除。没有真实快照/引用的种子产品只在后续明确批准的清理动作中归档，已有真实引用的记录不会被盲目处理。
5. 在“数据任务”查看主市场、active 自有产品、核心竞品、90 天历史及 Amazon 实际值的覆盖。Go Live 校验还要求 Mock 观察为零、没有 active Mock 自有主档、当前真实自有产品均有真实快照、必需 MCP 能力、近 24 小时内连接验证，以及上述单次完整关键运行证明。secondary 竞品 coverage 可以部分成功，但不能替代或修复失败的关键运行。覆盖不足时保持非 Live，不绕过校验。
6. 只有 `/api/go-live/verify` 的 `hasMinimumRealCoverage` 为 `true`，才输入 `ACTIVATE LIVE` 切换。切换后刷新驾驶舱，核对真实来源、趋势、缺失提示及 Evidence。Live 同步失败应保留上一版真实快照并显示未更新，不得使用 Mock 兜底。

服务端对应的诊断和操作接口为 `/api/integrations/sellersprite/test`、`/api/integrations/sellersprite/capabilities`、`/api/integrations/sellersprite/sync/critical`、`/api/integrations/sellersprite/sync/competitor`、候选审核接口、`/api/data-coverage` 与 `/api/go-live/{preview,backup,cleanup,verify,activate}`。写操作仅用于当前本地 Admin 角色；备份后同一服务进程内才允许清理。MCP 调用账本记录 `runId`、工具、范围实体、结果数量、参数哈希、状态、耗时和缓存命中，不记录 Secret；`runId` 只由服务端创建，不作为 provider 参数发送。

## 当前验收边界与检查

2026-09-21 本机隔离库已完成真实 MCP 初始化、认证、fresh `listTools`、必需 schema 指纹和真实 `product_node` 路径核验，并确认颈椎/Contour 与 Lumbar/Body Positioner 使用不同末级节点。五项业务 Product Master 仍只在本地忽略文件中预览：三项有可用趋势，一项只有身份/类目而无趋势，一项被 provider 标为无效且缺少身份/类目/趋势。隔离库另确认一项已核验颈椎 SKU，执行真实关键运行后，市场统计和集中度响应的月份为 `null`，因此按契约拒绝写入，Market/Product Snapshot、候选和 Evidence 均未生成。全量关键批次必须覆盖当前全部 SKU，不能把部分连接/身份探测或失败运行宣称为完整 Critical Sync，也不能用兄弟变体、Mock 或人工猜测补齐。当前不提供 Demo Cleanup Dry Run 清单，不清理 Demo、不切 Live、不合并未完成验收的 PR。完成五项身份修正/补数及隔离库真实 Snapshot、Dashboard、ResearchJob/Evidence 检查前，不宣称 V2.2 的真实验收链通过。Amazon SP-API 和 Ads API 不在本版正式接入范围。

代码交付前运行，并以当次输出为准：

```powershell
npm run lint
npm run typecheck
npm test
npm run build
```

另核对 migration、Demo 标识、两次追加 Snapshot、`needs_data`、Hard Gate 拒绝、Evidence 引用、Reverse Review、Approval 和两个 V2 端到端任务。测试用例或模拟 MCP 只证明契约与故障处理，不代替真实拥有的 ASIN 验收。
