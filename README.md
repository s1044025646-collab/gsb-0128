# 专利权利要求展开与现有技术对照后端

本地运行的 TypeScript + Node.js + SQLite 后端，输入是**结构化技术特征和明确关系**。
它只做两件事：

1. 展开独立/从属权利要求的继承特征（`any` 任选、`all` 同时依赖保留不同分支），检测循环引用、
   不存在的引用和互斥特征；
2. 按优先权日筛选现有技术（同日公开不算），对**每个展开分支逐篇文献单独**检查全部必需特征是否
   被披露，给出逐项证据和缺失项。

明确不做：网页 UI、自然语言/语义模型、连接任何真实专利库。所有数据均为完全虚构的夹具。
自动结果仅称为 **structured coverage check（结构化覆盖检查）**，不是法律意见，也绝不允许把
多篇文献拼接后宣称单篇完整覆盖。

## 依赖

- Node.js >= 23.4（使用内置 `node:sqlite` 与 TypeScript 类型剥离，无需编译步骤）
- 无运行时第三方依赖；仅开发期需要 `typescript` / `@types/node`

```powershell
npm install
```

所有数据库与临时文件都在项目内的 `data/`（可用环境变量 `PATENT_DB_PATH` 覆盖，测试用系统临时目录）。

## 测试

```powershell
npm test          # node --test 自动化测试（29 个）
npm run typecheck # 严格类型检查
```

覆盖：多层从属/任选分支/同时依赖分支完整性、互斥、循环与缺失引用、组合上限、
日期边界（同日/晚于优先权日）、逐文献证据、禁止跨文献拼接、版本化等价、未知关系待复核、
分析版本复现与旧依据保留、API 参数校验/错误码/分页/幂等、事务回滚、重启后持久化、CLI 端到端。

## 一键演示（可重复）

```powershell
npm run demo
```

演示每次重建 `data/demo.sqlite` 并写报告到 `data/demo-report.md`，内容包括：
多层从属、任选与同时依赖分支、互斥约束（D 类夹具中 `F5_lever` × `F9_manual_knob`）、
同日公开文献 D3、晚公开文献 D4、必须跨 D5+D6 拼接才完整的反例。

## 启动 API（仅本机，自动端口）

```powershell
npm start
```

输出形如 `listening on http://127.0.0.1:59409 (loopback only)`。只绑定 `127.0.0.1`，
端口由系统自动分配（也可用 `PATENT_PORT=固定端口 npm start`）。

停止：终端内 `Ctrl+C`（SIGINT/SIGTERM 均会关闭 HTTP 服务和数据库）。
若用后台方式启动，请只停止自己启动的该项目进程，例如：

```powershell
$p = Start-Process node -ArgumentList '--no-warnings=ExperimentalWarning','src/api/server.ts' -PassThru
Stop-Process -Id $p.Id
```

### API 摘要

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/dictionaries` | 导入版本化特征等价词典 |
| POST | `/api/applications` | 导入申请（权项/优先权/互斥） |
| GET | `/api/applications?limit=&offset=` | 分页查询 |
| GET | `/api/applications/:id/citations` | 循环/缺失引用检查 |
| GET | `/api/applications/:id/expand` | 展开分支（分页） |
| POST | `/api/documents` | 导入文献及逐项披露证据 |
| POST | `/api/applications/:id/analyses` | 建分析（body 可带 `scopeDocIds`） |
| GET | `/api/analyses/:aid/coverage` | 逐项证据/缺失（可按 `branch_no` 过滤） |
| GET | `/api/analyses/:aid/matrix` | 分支×文献覆盖矩阵 |
| GET | `/api/analyses/:aid/flags` | 待人工复核项（分页） |
| POST | `/api/flags/:fid/review` | 人工复核结论 |

- 写请求可带 `Idempotency-Key` 头，重复提交返回缓存结果并标记 `"idempotent": true`。
- 错误统一为 `{"error":{"code":...,"message":...}}`，状态码：400 参数校验、404 不存在、
  409 冲突/旧分析、422 循环引用/互斥/分支超限/词典缺失。

## CLI

```powershell
npm run cli -- import-dict fixtures/dict-v1.json
npm run cli -- import-app  fixtures/app-main.json
npm run cli -- import-doc  fixtures/documents.json
npm run cli -- check-citations app-demo-0001
npm run cli -- check-citations --file fixtures/app-bad-citations.json
npm run cli -- expand app-demo-0001
npm run cli -- set-scope app-demo-0001 --docs doc-d1,doc-d2
npm run cli -- analyze app-demo-0001
npm run cli -- matrix  <analysisId>
npm run cli -- coverage <analysisId> --branch 4
npm run cli -- flags    <analysisId>
npm run cli -- review   <flagId> --conclusion confirmed --reviewer alice --note "ok"
npm run cli -- export   <analysisId> --out data/report.md
npm run cli -- serve
```

关键导入/分析命令会打印操作前后的数量状态，例如
`application app-... imported  [applications: 0 -> 1, claims: 0 -> 11]`。

## 规则说明

- **分支语义**：`depType:"any"` = 任选，每个被引权项产生独立备选分支；`depType:"all"` =
  同时依赖，对各被引权项的分支做笛卡尔积，共有的祖先特征只计一次。默认组合上限 256，
  超限报 `BRANCH_LIMIT`（`expand` 可用 `--limit` 调整）。
- **现有技术日期**：仅 `pubDate < priorityDate` 的文献为现有技术；优先权日**同日**公开排除，
  晚于优先权日也排除。
- **特征等价**：只能来自该申请锁定的词典版本；直接披露记 `disclosed`，经词典等价记
  `equivalent` 并保留文献中的实际特征名与证据；其余为 `missing`。无词典关系且从未被直接披露的
  特征生成 `UNKNOWN_FEATURE` 待人工复核，系统不猜测技术含义。
- **分析不可变**：分析 ID 由申请内容（权项、优先权日、词典版本）、范围与文献内容指纹派生；
  修改任一项会产生新分析，旧分析及其依据完整保留。重复运行幂等且可复现。
- **迁移**：基于 `PRAGMA user_version`，可重复执行；全部多表写入在单个事务内提交。

## 清理

```powershell
Remove-Item -Recurse -Force data   # 仅删除本项目的数据库与报告
```
