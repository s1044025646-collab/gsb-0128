# 专利权利要求展开与现有技术对照后端（本地、虚构数据）

一个只在本机运行的后端服务：输入**结构化技术特征与明确关系**，展开从属权利要求的继承特征，按有效日期筛选现有技术，逐篇对比文献做**结构化覆盖检查**，并保留人工复核结论。

明确**不包含**：

- 不提供网页/前端界面（仅 HTTP API 与 CLI）；
- 不做自然语言语义模型或语义近似推断；
- 不连接任何真实专利库或外部数据源；
- 所有夹具条目均为完全虚构的演示数据。

## 技术栈与依赖

- TypeScript + Node.js（要求 Node `>= 22.5`，开发环境为 Node 25）
- SQLite 使用 Node 内置模块 `node:sqlite`（**零运行时第三方依赖**，无需编译原生模块）
- 自动化测试使用 Node 内置测试运行器 `node:test`
- 开发依赖仅为 `typescript` 与 `@types/node`（`npm install` 安装）

安装依赖：

```powershell
npm install
```

## 快速开始

可重复的端到端演示（使用项目内全新临时目录，自动导入虚构夹具、展开、覆盖检查、复核、导出、版本复现、重启持久化校验）：

```powershell
npm run demo
```

运行全部自动化测试：

```powershell
npm test
```

类型检查：

```powershell
npm run typecheck
```

## 启动与停止 API 服务

```powershell
npm start
```

- 服务**只绑定本机** `127.0.0.1`，端口由系统自动分配（`--port 0`）；
- 实际端口与主机写入 `data/server.port`、`data/server.host`，PID 写入 `data/server.pid`；
- 日志写入 `.tmp/server.log`；
- 停止服务（只停止 PID 文件中、经命令行校验属于本项目的进程，绝不触碰其它进程）：

```powershell
npm run stop
```

健康检查（端口以启动输出为准）：

```powershell
Invoke-RestMethod http://127.0.0.1:<port>/health
```

## CLI 命令

```powershell
node src/cli.ts migrate
node src/cli.ts import dict examples/dictionary-v1.json
node src/cli.ts import app examples/application-jia.json
node src/cli.ts import app examples/application-bing.json
node src/cli.ts import ref examples/references.json
node src/cli.ts list apps|refs|dicts|analyses
node src/cli.ts check citations app-app-bing
node src/cli.ts expand app-app-jia --dict dict-dict-v1
node src/cli.ts analyze app-app-jia --dict dict-dict-v1
node src/cli.ts analyze app-app-jia --dict dict-dict-v1 --refs ref-d1,ref-d2 --effective 2025-06-01
node src/cli.ts coverage <analysisId>
node src/cli.ts review <analysisId> --reviewer liu --conclusion confirmed_missing --branch 1 --ref ref-ref-d1 --feature F4 --note "人工结论"
node src/cli.ts reviews <analysisId>
node src/cli.ts reproduce <analysisId>
node src/cli.ts export <analysisId> --out .tmp/report.json
node src/cli.ts serve --host 127.0.0.1 --port 0
```

`import` 支持单对象或对象数组（如 `references.json`），重复导入以 `external_id` 幂等。导入命令会展示操作前后数量；`analyze` 展示依据哈希与完全覆盖分支；`coverage` 展示覆盖矩阵。

## HTTP API

请求/响应均为 JSON。错误响应形如：

```json
{ "error": { "code": "VALIDATION_FAILED", "message": "...", "details": { } } }
```

端点：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康检查 |
| GET | `/applications?page=1&page_size=20` | 分页列出申请 |
| POST | `/applications` | 导入申请（含权项，幂等） |
| GET | `/applications/:id` | 申请详情（含权项） |
| PATCH | `/applications/:id` | 修改标题/申请日/优先权日 |
| PUT | `/applications/:id/claims` | 替换权项集合（事务） |
| GET | `/applications/:id/expansion?dictionary_id=` | 展开权项分支 |
| GET | `/applications/:id/citations` | 引用关系检查结论 |
| GET | `/references` / `POST /references` / `GET /references/:id` | 对比文献 |
| GET | `/dictionaries` / `POST /dictionaries` / `GET /dictionaries/:id` | 版本化特征词典 |
| POST | `/applications/:id/analyses` | 创建结构化覆盖检查（新分析） |
| GET | `/analyses?page=1&page_size=20` | 分页列出分析 |
| GET | `/analyses/:id` | 分析详情 |
| GET | `/analyses/:id/coverage` | 分支 × 文献覆盖矩阵与逐项证据 |
| GET | `/analyses/:id/reviews` / `POST` | 人工复核结论（按复核人幂等 upsert） |
| GET | `/analyses/:id/export` | 导出 JSON 报告 |
| POST | `/analyses/:id/reproduce` | 依据快照重算并比对 |

错误码：`VALIDATION_FAILED`、`NOT_FOUND`、`APPLICATION_NOT_FOUND`、`REFERENCE_NOT_FOUND`、`DICTIONARY_NOT_FOUND`、`ANALYSIS_NOT_FOUND`、`ANALYSIS_BLOCKED`（存在循环/缺失引用）、`CLAIM_CYCLE`、`MISSING_CITATION`、`MUTEX_CONFLICT`、`UNKNOWN_CLAIM_FEATURE`、`UNKNOWN_DICTIONARY_FEATURE`、`INVALID_DATE`、`INVALID_SCOPE`、`INTERNAL`。

分页参数：`page`（从 1 开始）、`page_size`（默认 20，最大 100）。响应：`{ items, page, page_size, total, total_pages }`。

## 业务规则

### 权利要求展开

- 独立权项：单个分支，含自身特征；
- 单一引用：继承父权项全部特征，再追加自身特征（保留逐项来源 `introduced_by`）；
- **多项任选引用**（`multiple_alternative`，如“根据权利要求 1 或 2”）：每个父权项的每个分支各自保留为独立分支；
- **多项同时引用**（`multiple_simultaneous`，如“根据权利要求 1 和 2”）：合并所有父权项特征为一个分支；
- 多层从属逐层传播分支，不做去分支合并；
- 检测并报告：循环引用、引用不存在的权项、同一分支内互斥特征；存在循环或缺失引用时阻止创建覆盖分析（`ANALYSIS_BLOCKED`）。

### 有效日期规则

- 有效日期默认为**优先权日**（可用 `effective_date` 覆盖）；
- 文献公开日**严格早于**有效日期才属于现有技术；
- 与优先权日**同日公开**的文献不属于现有技术（同日公开规则）；
- 晚于有效日期公开的文献标记为晚公开并排除。

### 结构化覆盖检查

- 对每个展开分支、**逐篇**文献检查全部必需特征；
- 披露判定仅两种来源：文献直接披露同一特征码，或版本化词典中明确登记的 `equivalent` 等价关系；
- 词典中非等价关系（如 `related`）不视为披露，记为 `needs_review`；
- 文献披露了词典未收录的特征码时，未直接披露的特征记为 `needs_review`，系统不猜测技术含义；
- **绝不把多篇文献拼接后宣称单篇完整覆盖**：组合上限为 1 篇，跨文献拼接只作为反例展示；
- 自动结果始终标注为“结构化覆盖检查”（`structured_coverage_check`），不等同新颖性/创造性法律结论。

### 版本化与依据保留

- 每次分析冻结完整依据快照（申请、权项、优先权日、词典特征/等价/互斥、文献披露、范围与有效日期），并计算 SHA-256 `basis_hash`；
- 修改权项、优先权或词典后创建的是**新分析**；旧分析的快照、矩阵与复核结论保持不变；
- `reproduce` 从快照重算，验证哈希一致、分支与逐项结果一致（版本可复现）。

## 虚构夹具

- `dict-v1`：F1–F8、F2B 等特征；`F2 ≡ F2B` 等价；`F5` 与 `F6` 互斥；
- `dict-v2`：把 `F2B` 关系改为 `related`、新增 `F2C ≡ F2`，用于版本复现对照；
- `app-jia`：独立/单一/多项任选/多项同时/多层从属（权项 1–5）；
- `app-bing`：缺失引用（父权项 99）、循环引用（3↔4）、互斥特征（F5+F6）；
- 文献：D1/D2 单篇完整或部分覆盖、D3 同日公开、D4 晚公开、D5+D6 必须跨文献拼接的反例、D7 通过词典等价覆盖、D8 含词典未收录特征。

## 数据与临时文件

- 默认数据库：`data/patent.db`（SQLite WAL）；
- 临时目录：`.tmp/`（演示、测试与服务日志）；
- 所有运行数据均留在本项目目录内；
- 可用环境变量 `PATENT_DATA_DIR` 指定其它（仍建议位于项目内）目录；
- 时间可注入：代码使用 `src/clock.ts` 的时钟，测试/演示可冻结时间；运行 ID 也取自注入时钟，不使用随机数。

## 迁移

迁移在服务启动和 `migrate` 命令时自动执行；迁移记录在 `schema_migrations` 表中，重复执行只补齐未应用项，可安全反复运行。
