# V2.2 真实数据接入操作手册

本手册用于在同一 SQLite 数据库中验证真实 SellerSprite 数据、导入真实自有产品并审核后切换 Live。**连接成功不等于业务验收完成**：还需核对市场节点、自有 ASIN、Snapshot、竞品候选、数据覆盖和 Evidence。不要用 Demo 或空值补齐真实数据。

## 运行与凭据

要求 Node.js 22+。首次运行：

```powershell
npm install
Copy-Item .env.example .env
npm run dev
```

在本机或服务器的 `.env` 中填写 `SELLERSPRITE_MCP_URL`（不含密钥查询参数的 MCP 地址）和 `SELLERSPRITE_MCP_SECRET`。两者只能供服务端读取；不要放入 `VITE_*`、命令行历史、截图、工单、日志或公开 Git 仓库。`.env`、本地数据库、备份和原始业务文件已被 Git 忽略。公开仓库不应包含真实 SKU 报表或凭据；向外部署前还需另行配置正式身份认证，当前 Admin/Viewer 只是本地权限预览。

默认前端为 `http://127.0.0.1:5173`，API 为 `http://127.0.0.1:8787`。首次打开数据库会执行向前迁移。不要对有业务数据的数据库运行 `npm run db:reset`，该命令会删除本地内容。

## 先验证真实链路

1. 保留现有 Demo。打开“设置 -> 数据源”，执行“连接测试”。检查认证、工具数量、必需能力及延迟；能力列表来自实际 `listTools`。诊断不应显示密钥。
2. 确认当前 Marketplace 和“默认市场节点”属于目标站点。在“设置 -> 数据源”输入并核对 SellerSprite 数字节点路径，勾选站点/类目范围确认后保存为 `market_nodes.category_id`；未映射的市场会拒绝同步，不退用本地节点 ID。不能因为名称包含 pillow 就把宽泛 Bed Pillows 类目当成已验证的 Memory Foam Pillow 细分市场。
3. 打开“数据任务 -> 审核文件导入”，选取 `examples/owned-product-master-template.csv` 结构的真实产品主数据文件。预览识别类型、新增/更新/重复/错误计数、字段映射、样例行和拒绝原因；未知类型先人工选择，再用新预览确认。模板列为 `marketplace,asin,sku,internalName,brand,title,productType,parentAsin,variationTheme,marketNode,monitoringEnabled,status`。按真实父子 ASIN 填写 `parentAsin`/`variationTheme`，不要把父体销量与子 SKU 销量相加；被拒绝的行需明确确认只导入有效行。
4. 在“设置 -> 数据源”选观察月份后执行“同步关键数据”。该批次抓主市场统计/集中度和当前站点全部 active 自有 ASIN 趋势；远端调用全部成功后，市场与自有产品 Snapshot 才原子落库。任一关键调用失败时保留已有合法快照，按接口错误和 MCP 调用账本排查，不会回退 Mock；当前关键同步不保证单独生成 DataTask。`observationDate` 采用业务月份或趋势点日期，`collectedAt` 是抓取时间；重复的同来源、实体、业务日期和周期观察不会叠加为销量。
5. 到自有产品详情的“竞品”页执行“发现候选”。按价格、形态、功能、人群及相似度人工核对，填写纳入理由并选择关联类型后确认，或拒绝。MCP 发现的候选不会自动成为直接竞品。确认后从该竞品行点击同步图标，才会单独抓取并写入其历史快照；关系被撤销或远端 ASIN/站点不一致时会拒绝落库。
6. 查看“数据任务”的真实数据覆盖，以及市场、自有产品和驾驶舱上的来源、日期与缺失值。页面读取数据库 Snapshot，刷新页面不会触发 MCP。历史不足时继续通过已验证的 MCP 趋势和文件补数；至少核对一个真实市场、一个**自有** ASIN 与一组已审核竞品，再检查 Rule/Evidence 是否指向真实数据版本。

市场统计返回的 `products`/价格等指标可能只覆盖工具返回的商品 cohort；集中度列表或 TOP100 的销量不能自动当成整个类目总销量。接口未给出可信全类目总量时保留 `null`，界面显示“—/数据不足”，不填 `0`。SellerSprite 的自有 ASIN 销量是估算，不能替代 Amazon 真实销量；导入/接口的原始事实分别保留，展示时按来源权威规则选择。

## CSV/XLSX 历史回填

走“数据任务 -> 审核文件导入”：选择文件 -> 审核类型、字段映射、样例行和拒绝原因 -> 未知类型人工选择并重新预览 -> 确认导入 -> 查看任务记录。样例最多展示 20 行，未展开行仍会随整个文件处理；对重要批次还应检查原文件或在隔离库验证，不能仅凭样例批准。产品、市场和评论模板分别见 `examples/product-snapshots.csv`、`examples/market-snapshots.csv`、`examples/reviews.csv`。快照文件需要业务日期及模板要求的指标；缺字段的行报错，不会用零填补。预览令牌短期有效，过期需重新预览；同来源/日期/周期的重复记录不会因重复上传而翻倍。旧直传 API 已关闭。

优先核对市场 12 个月（最低约 90 天）、自有 SKU 90–180 天、核心竞品约 90 天。Amazon Business Report 支持已验证的 `(Child) ASIN`、`SKU`、`Units Ordered`、`Ordered Product Sales` 等字段组合，必须明确报表日期范围；其他未知布局仍会拒绝，不能把任意报表当成已兼容结构。导入后检查 `observationDate` 与 `collectedAt` 是否分离、站点/ASIN/Variation 身份是否正确，并查看是否有部分失败。原始文件只留在受控的本地/服务器数据目录，不提交公开仓库。

## Demo 清理与 Live 激活

只有真实链路和产品身份已核对后，才在“设置 -> 数据源 -> Go Live 迁移”操作：

1. 查看 Dry Run 的预计删除、归档、保留和引用阻断项；先处理真实工作流对 Demo 记录的引用。清理只针对明确登记或可识别的 Demo 观察及相关演示实体，不是数据库重置；产品主数据、规则和真实历史应保留，未知或混合来源的 Mock 记录会阻断清理。
2. 点击“备份数据库”，确认备份创建。备份目录默认为 `data/backups/`，位于本机且不进 Git；另行按业务要求保护和保留备份。
3. 输入精确确认文本 `CLEAR DEMO DATA`，再清除演示数据。没有真实快照/引用的 4 个种子自有 SKU 和 8 个种子竞品会归档为 inactive，主档仍保留；已有真实引用的种子产品不会被盲目归档。清理后重新检查预览和数据覆盖。
4. 在“数据任务”查看主市场、active 自有产品、核心竞品、90 天历史及 Amazon 实际值的覆盖。Go Live 校验还要求 Mock 观察为零、当前主市场有有意义的真实与 MCP 快照、自有产品均有真实快照、至少一个自有 ASIN 有 MCP 快照、必需 MCP 能力、近 24 小时内已连接验证/同步以及匹配当前节点/自有 ASIN 的成功调用账本。覆盖不足时保持非 Live，不绕过校验。
5. 只有 `/api/go-live/verify` 的 `hasMinimumRealCoverage` 为 `true`，才输入 `ACTIVATE LIVE` 切换。切换后刷新驾驶舱，核对真实来源、趋势、缺失提示及 Evidence。Live 同步失败应保留上一版真实快照并显示未更新，不得使用 Mock 兜底。

服务端对应的诊断和操作接口为 `/api/integrations/sellersprite/test`、`/api/integrations/sellersprite/capabilities`、`/api/integrations/sellersprite/sync/critical`、`/api/integrations/sellersprite/sync/competitor`、`/api/data-coverage` 与 `/api/go-live/{preview,backup,cleanup,verify,activate}`。写操作仅用于当前本地 Admin 角色；备份后同一服务进程内才允许清理。MCP 调用账本记录工具、范围实体、结果数量、参数哈希、状态、耗时和缓存命中，不记录 Secret。

## 当前验收边界与检查

已用真实 MCP 对公开类目/公开 ASIN 做过只读能力验证；公开竞品 ASIN **不是自有 ASIN**，宽泛 Bed Pillows 节点**不是已确认的记忆棉细分市场**。在拿到并授权验证真实自有 ASIN、核实正确市场节点以及完成隔离数据库的真实写入/驾驶舱/Evidence 检查前，不宣称 V2.2 的两条真实验收链或 Live 切换已完成。Amazon SP-API 和 Ads API 不在本版正式接入范围。

代码交付前运行，并以当次输出为准：

```powershell
npm run lint
npm run typecheck
npm test
npm run build
```

另核对 migration、Demo 标识、两次追加 Snapshot、`needs_data`、Hard Gate 拒绝、Evidence 引用、Reverse Review、Approval 和两个 V2 端到端任务。测试用例或模拟 MCP 只证明契约与故障处理，不代替真实拥有的 ASIN 验收。
