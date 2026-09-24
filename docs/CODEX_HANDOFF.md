# 换机交接：下一台电脑的 Codex 从这里开始

交接日期：2026-09-23。此文档可提交公开仓库，不含密钥和真实产品清单。真实主档、数据库与验收报告应通过私人迁移包传递。

## 1. 当前结论与授权边界

- 项目：Amazon AI Decision System，本地优先的 Amazon 市场、自有 SKU、竞品与开发决策工作流。React/Vite 前端，TypeScript/Express 后端，SQLite 数据库。
- 仓库：https://github.com/gonewiththesakura-creator/amazon-ai-decision-system
- 工作分支：`codex/v2.2-real-data`；本次交接前功能提交：`9e2ffe3e3e241ecbe5ffa0307f3735abd5eb3072`。后续交接文档提交应保留在同一分支。
- PR #1：https://github.com/gonewiththesakura-creator/amazon-ai-decision-system/pull/1 。交接时 OPEN，不能 merge。
- 用户明确要求：保留 Demo，不执行 Demo Cleanup，不切 Live。完整真实验收通过、主档及市场节点确认后，才提供 Cleanup Dry Run，等待用户明确批准清理与切换。
- 本次目标未完成；旧会话目标因同一外部阻塞连续出现而标记 blocked。不是验收通过，也不是取消项目。新会话不能靠旧会话的工具句柄或目标状态恢复进程。
- Secret 只读本机 `.env` 的 `SELLERSPRITE_MCP_URL` 与 `SELLERSPRITE_MCP_SECRET`。不从聊天历史取回凭据，不提交、不回显、不写前端。旧聊天曾出现凭据，迁移时应在服务商处换新并只填本机。
- 用户允许多 agent 协作和推送公开 GitHub；按互不冲突文件范围分工，不自动合并 PR。

## 2. 进度：已实现不等于真实业务验收完成

已有 V1/V2 工作流、V2.1 驾驶舱、V2.1.1 正确性修复，以及 V2.2 的真实 MCP Transport、schema 校验、运行追溯、动态 SKU、预览确认式 CSV/XLSX 导入、Go Live 验证与迁移门禁。

关键约束已实现：不可覆盖 Snapshot；缺数据为 null/needs_data；Rule/Hard Gate 在 AI 解释之前；结论有 Evidence/数据/规则/Prompt 版本；Reverse Review 与人工 Approval；真实失败不回退 Mock；ResearchJob 状态由 orchestrator 转换。

最近一批修复：

1. 每次 critical sync 的 fresh listTools、市场双月研究/统计/集中度、当前 active 真实自有 SKU、Snapshot、coverage、后续 Evidence 关联同一个 runId。Go Live 不拼接不同运行。
2. 市场原子关键批次覆盖主市场及当前 SKU 所属 distinct 市场；直接竞品是 secondary，允许部分失败但保留 coverage。
3. SellerSprite `totalProducts` 才是类目商品数；TOP100/统计样本不能冒充全市场销量、营收等。评论 reviews 不等于评分 ratings；覆盖不足不生成全市场值。
4. 主档预览持久化完整 roster 声明，缺标题也能记住预期数量。迁移 30/31 增加声明与不可变事件历史。pending 声明阻断 critical sync/Go Live；确认后的 active 集合必须与完整文件一致。范围替换需显式 `supersedesRosterDigest` CAS，不可静默缩成一个 SKU。
5. 外部成功响应通过契约校验才记成功；缓存写失败不产生矛盾的成功/失败账本或重复调用。产品详情请求不携带 previousSnapshot。

验证基线：功能提交 9e2ffe3 本地 lint、typecheck、build 通过，56 个测试文件/836 项测试通过。GitHub push CI 35807269961 与 PR CI 35807271643 均成功。仅证明实现检查通过，不能替代真实 Acceptance。

## 3. 真实链路发生过什么

2026-09-22 隔离运行曾获得 49 个真实工具、必需能力 5/5。runId `73fe4135-0732-4d66-ac38-6efb9a94270a`，使用 202607/202608 两个月份，产生 2 个市场 Snapshot、一个自有 SKU 的 5 个趋势点、17 个待审核竞品候选；Dashboard 同运行读路径证明通过。它是局部验证，不是五 SKU 全量验收。

真实市场返回类目 3290 个商品、TOP100 样本。系统正确保留缺失的全市场指标；市场与自有 SKU ResearchJob 均为 needs_data，正式同运行 Evidence 为 0/2；没有已确认直接竞品。不能为了过门禁用样本总和冒充全市场数据。后续需获得合法口径的数据，或另行设计清晰标注的样本分析路径；不得暗改规则绕过缺失。

2026-09-23 fresh listTools 仅返回 `secret_no_remaining`（零输入属性），业务能力 0/5；09:45 北京时间复测相同。它是服务端无剩余次数提示。此前“authenticated=true”只是当前连接检测实现的返回值，不能理解为业务工具可用。不能凭此断定总额度、重置时间或用量全部由本项目造成。

当前隔离库：预期 5 个 SKU，已落库 active 真实 SKU 1 个，roster pending_validation，matches=false。主档预览 3 新增、1 重复、1 错误（缺真实标题）。另外两个腰枕未取到趋势。父体未知保持空值，不能借用兄弟 ASIN 趋势替代。

## 4. 新电脑准备与数据恢复

先读取根目录 `AGENTS.md`、本文件、`docs/V2_2_REAL_DATA_RUNBOOK.md`、`V2_2_REAL_DATA_PLAN.md` 与相关 `skills/*/SKILL.md`。附带历史设计文件是需求参考，最新用户限制优先。

需要 Git、Node.js 22+、npm；GitHub CLI 可选，推送需在新电脑重新登录自己的账号。安装依赖与基线验证：

```powershell
git clone --branch codex/v2.2-real-data https://github.com/gonewiththesakura-creator/amazon-ai-decision-system.git
cd amazon-ai-decision-system
npm ci
npm run lint
npm run typecheck
npm test
npm run build
```

私人迁移包与本文件配套。先解压到仓库外，核对 SHA256 清单与每个备份库 integrity_check。停止新电脑上的 API，再把包中 `data/` 的内容复制到新 clone 的 `data/`。不要覆盖已有业务数据库；若不是全新 clone，先备份并选择新路径。包里的 `.db` 是在线备份后的独立一致性副本，不要从旧目录另加旧 `-wal`/`-shm` 到副本旁。

迁移包不含 `.env`、node_modules、dist、Git 凭据或旧进程；重新建立本机 `.env`（远程 URL 必须 HTTPS，不能把 secret-key 放 URL 查询参数），只配置服务端变量。不要复制聊天中的旧密钥。恢复额度后再进行真实 MCP 调用。

默认业务库：`data/opportunity-intelligence.db`。当前首选验收库：`data/real-chain-market-research-20260922.db`。其他 `real-chain-*`/`real-market-probe-*` 是历史证据，不要混为同一次 Acceptance，也不要覆盖当前库。

专用隔离 API 启动（一个终端）：

```powershell
$env:HOST = '127.0.0.1'
$env:PORT = '8798'
$env:DATABASE_PATH = './data/real-chain-market-research-20260922.db'
npm start
```

生产构建后该 API 可从 dist 提供界面：`http://127.0.0.1:8798`，健康检查 `/api/health`。不建议直接启动默认 npm run dev 做隔离验收：其前端代理默认指向 8787，可能操作错库。不要继承旧机器的进程 ID、会话 ID 或端口可用假设。

严禁执行 `npm run db:reset`。首次打开库会向前迁移，打开前保留原始迁移包。不把当前 Admin/Viewer 预览角色当成公网身份认证，不开放公网监听。

## 5. 下一步执行顺序

1. 核对分支、HEAD、PR 状态和工作区；恢复私人数据，校验库完整性，确认没有清 Demo/Live 变化。
2. 用户在新电脑恢复 SellerSprite 调用额度并配置 `.env` 后，先 Connection Test + fresh listTools。若仍 `secret_no_remaining`，停止业务调用并报告，不循环耗费调用、不用缓存的 49 工具冒充当前能力。
3. 工具恢复后校验真实 schema，核实两个市场组的数字节点/路径。前三项 contour，后两项 lumbar；不能把五项合并同一个 MarketNode。本地名称不是数字节点证据。
4. 读取私人主档说明和 pending.csv，补足缺失真实标题、核实父体与类目；灰/蓝仅确认同族，不知道 Parent ASIN；腰枕兄弟关系未知。保留真实调用证据。不能直接确认当前有错误的预览。
5. 在隔离库重新预览完整五项主档，检查范围声明和错误；确认主档是实质写操作，不把 staging 当成已导入。身份/节点尚未核实不得强行导入。范围修正流程见 runbook。
6. 执行同一个完整 critical sync，覆盖全部当前真实自有 SKU 和所需市场；ASIN Trend、候选、标准化、Snapshot、Dashboard、ResearchJob、Evidence 全部按当前 runId 验证。关键批次任一失败不能用旧片段补成功。
7. 需要合法全市场/历史数据与 Amazon 实际值时走 CSV/XLSX 预览确认链；至少 90 天市场历史、全部 SKU 的合法历史及人工确认的真实直接竞品。候选发现不等于人工确认。不要编造缺失历史。
8. 前置条件准备好才运行 `npm run --silent acceptance:real -- --base-url http://127.0.0.1:8798 --month <已核验月份>`。runner 不会替你建立隔离库；它会写验收任务和采集数据。不要盲选 202609，既往只有 202607/202608 合同校验通过。
9. 完整真实链与身份确认后，向用户提供 Demo Cleanup Dry Run，单列两项旧 Demo/manual 记录及引用影响。等待用户批准再备份、清理与激活；当前授权不包含执行这些动作。
10. 修改代码后执行 AGENTS.md 全套验证、审查并安全推送分支；PR #1 继续 open，真实 Acceptance 全部通过前不要 merge。

## 6. 代码导航与易踩坑

- `server/adapters/sellersprite-mcp-{client,adapter,store}.ts`：MCP 传输、规范化、脱敏账本/缓存。
- `server/adapters/sellersprite-tool-registry.ts`：fresh 工具/schema、能力映射、安全持久化；日志工具名被脱敏不代表服务端真的叫 REDACTED。
- `server/services/sellersprite-sync-service.ts`：原子 critical batch、secondary、runId、coverage。
- `server/services/owned-roster-declaration.ts` / `import-service.ts`：主档范围、CAS、导入事务。
- `server/services/go-live-migration-service.ts`：清理前证据、Demo/manual 处理、备份和 Live 门禁。
- `server/database/migrations.ts`：追加迁移，禁止重写历史；`server/scripts/real-acceptance.ts`：真实链验收 runner。
- `src/components/RealDataControls.tsx`：数据源、主档声明、同步、Go Live UI。
- `server/market-research-sample-boundary.integration.test.ts`：真实合同形状的样本/全市场边界；仍是模拟测试，不是真实验收。
- 文档命令使用相对路径以便换机；旧报告中的 C:/Users/JT 绝对路径要替换为新 clone 路径。

交接时原工作区另有用户未提交状态：`.env.example` 删除，`docs/superpowers/` 两份未追踪计划。本次没有擅自恢复或提交它们；计划副本在私人包中。新 clone 会带回已追踪 `.env.example`，与旧电脑删除状态的差异不是数据丢失。公开 Git 不包含 data 库、真实主档、报告或 `.env`，只 clone 代码不足以无缝恢复业务状态。

## 7. 给下一位 Codex 的启动指令

“请先完整阅读 AGENTS.md、docs/CODEX_HANDOFF.md、docs/V2_2_REAL_DATA_RUNBOOK.md，以及私人迁移包中的 PRIVATE_HANDOFF.md 和 data/reports/。核实当前分支、数据库和 PR #1 状态，按交接恢复 V2.2。禁止合并 PR #1、清 Demo、切 Live；不要索取或打印 Secret。先确认 SellerSprite 额度与 fresh 工具能力，再继续五个真实 SKU、两个市场组的完整运行级验收。保留所有缺失与失败证据，不以局部成功替代全量 Acceptance。允许多 agent 按独立范围协作。”
