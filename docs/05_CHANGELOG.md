# 变更日志

## 2026-10-26
- 确立项目方向：RAGFlow + LightRAG + Logto，保留资产与四阶段工作流
- 创建文档体系（00~05）
- 采纳 ADR-001 ~ ADR-004
- **新增 ADR-005**：以 RAGFlow 为统一内容存储底座，资产与工作流作为业务层；不再以本地 Markdown 为内容唯一真相源
- 更新 00_SCOPE.md 以反映存储策略变更

## 2026-10-26
- 根据 ADR-005 重写 01_ARCHITECTURE.md
- 明确：RAGFlow 为统一内容底座；资产与工作流为业务层；内容与状态分离

## 2026-10-26
- 根据 ADR-005 重写 01_ARCHITECTURE.md 与 02_PHASES.md
- 明确当前处于 Phase 0，下一步为完成文档体系并启动 Logto / RAGFlow Docker

## 2026-10-26
- 完整重写 03_DECISIONS.md，固化 ADR-001 ~ ADR-005
- 明确 ADR-005 为统一内容存储的核心决策

## 2026-10-27
- 验证多 Agent 工具能力 - 只读检查通过，Docker 暂不可用，端口 3000/3001/9380 空闲

## 2026-10-27
- CrewAI 工具增强与写操作验证通过；Phase 0 文档治理能力就绪，等待 Docker 环境

## 2026-11-01
- 确认仓库全部内容仅为 docs/ + agents/（无 Next.js 业务代码）
- 新增并采纳 **ADR-006**：代码库为 greenfield，业务应用从零新建
- 更新 00_SCOPE（仓库现状）、02_PHASES、01_ARCHITECTURE 说明、AI_CONTINUE_DEV_GUIDE

## 2026-11-01
- 按 ADR-006 从零创建 Next.js App Router + TypeScript 骨架，加入 Mock 登录态 UI、`.env.example` 业务占位、`/api/health` 与健康检查测试；未连接任何外部服务
- 新增 Asset / Work 元数据、`content_ref` 映射、四阶段状态机与 Logto 接入 DRAFT；将 `04_INTEGRATION.md` 整理为待实测模板，并修复 `01_ARCHITECTURE.md` 的 Markdown 断裂
- 验证 lint、TypeScript、1 项单元测试、生产构建及首页 / health HTTP 200；生产依赖审计为 0，ESLint 9 开发依赖链仍有 16 个中等级别 minimatch 审计项，未执行强制修复
- 同步 00_SCOPE / 01_ARCHITECTURE / 02_PHASES / AI_CONTINUE_DEV_GUIDE 的当前实现状态，保留 ADR-006 的 greenfield 起点记录

## 2026-11-11
- 仓库纳入 Git 版本控制，基线提交 `ebe32e6`（此前无版本控制）
- 环境实测：Docker 29.9.2 运行中、Docker Compose v5.6.1、WSL 内有 Ubuntu 发行版；当前无容器运行，端口 3000 / 3001 / 9380 均空闲；本机内存 31.5 GB、D 盘可用 494 GB，满足 RAGFlow 资源要求
- 同步 `docs/02_PHASES.md` 与 `AI_CONTINUE_DEV_GUIDE.md`：Docker / WSL 阻塞标记为解除，Phase 0 剩余项收敛为「拉起并验证 Logto 与 RAGFlow」；Logto 与 RAGFlow **仍未部署、未验证**
- 清理 `docs/05_CHANGELOG.md` 中 2026-10-26 的重复条目（保留含 ADR-005 的完整一条）

## 2026-11-11（补充）
- 新增 **ADR-007**（内容映射契约与 Dataset 粒度）、**ADR-008**（内库 / 外库定义与字段拆分）、**ADR-009**（业务元数据存储选型与分层结构），决策索引表同步
- `docs/02_PHASES.md`：Phase 1 完成标准扩展为「身份 + 最小持久化 CRUD」，依据 DATA-01 / DATA-05 / DATA-08，原「Phase 1 只做骨架」口径作废
- 清理 `agents/README.md` 重复内容：目录树重复的 `config/`、重复的「如何运行」小节

## 2026-11-11（提交 `e95d154`：业务数据层 + Logto 自托管）

- **落地业务数据层**（ADR-007 / 008 / 009）：建立 `domain` → `server.ports` → `server.repositories` → `server.db`、`server.http` 的分层；`server.adapters.ragflow` 与 `server.services` 本轮仅为占位目录
- 存储定为 SQLite + better-sqlite3 + Drizzle；迁移 `drizzle/0000_military_wasp.sql`，打开连接时执行，可重复应用；数据库文件默认 `data/app.db`（`DATABASE_PATH` 可覆盖），连接开启 WAL、外键与 `busy_timeout`
- **四张表**：`objects`（资产 / 作品同表，`type` 区分，作品才有 `format` / `status` / `source_note`，`revision` 乐观锁，软删除）、`content_refs`（对象 ↔ RAGFlow 文档映射，`content_key` 为幂等键、`document_id` 为可变指针，每对象至多一个有效主引用）、`library_events`（跨库迁移审计，`reason` 必填，与库别更新同事务）、`sync_jobs`（内容同步 outbox，只落队不投递）
- **两条 CHECK 约束**钉死领域规则：`objects_status_only_for_work`（资产无 `status`）与 `objects_external_not_practiced`（外库作品不得 `practiced`），与 `src/domain/objects.ts` 的类型约束、`src/domain/workflow.ts` 的状态机重复实现；约束失败翻译为 `CONSTRAINT_VIOLATION`（422），唯一约束冲突翻译为 `CONFLICT`（409）
- **Logto 以 Docker 自托管启动并完成连通性实测**：版本 1.46.0，服务端口 3001、控制台端口 3002，`/api/status` 返回 204，OIDC discovery 返回正常 JSON；实测值已写入 `docs/04_INTEGRATION.md`。**管理员账号尚未创建**，控制台仍停留在 Create account 页面，应用类型 / 应用 ID / 回调地址均未配置
- **RAGFlow 仍未部署**：仓库中无 RAGFlow 编排文件，复核时本机无 RAGFlow 容器运行；其端口、地址与接口契约一律保持待实测
- 新增 `docs/01_ARCHITECTURE.md` 第 5 节「业务数据层实现」，说明分层职责、四张表分工与两条 CHECK 约束，并链接 ADR-007 / 008 / 009；同步更新该文件开头的实现状态与「待细化」中已定案的存储选型
- 测试：6 个测试文件、40 项用例通过（2026-11-11 实测）

## 2026-11-11（Logto 真实登录 + 工作台首屏）

- **控制台侧配置完成**：创建传统 Web 应用「个人资产与知识平台」，登记回调地址 `/api/logto/sign-in-callback` 与登出后回跳 `/`；应用 ID 与密钥只写 `.env.local`（已 gitignore）
- **应用侧接入 `@logto/next` 4.2.11**：新增 `LogtoSessionAdapter` 实现既有 `SessionPort`，页面与接口仍只依赖端口；新增 `/api/logto/sign-in`、`/api/logto/sign-in-callback`、`/api/logto/sign-out` 三条路由
- `AUTH_MODE=logto` 时首页显示「登录」入口、工作台侧栏显示「退出」；`AUTH_MODE=mock` 与 `disabled` 行为不变
- **工作台首屏重排**（前端设计）：导航收敛为三个锚点、四阶段横向进度、内容构成面板，新增「新建」弹窗（唯一客户端组件，POST `/api/objects` 后刷新）
- 验证：typecheck、lint、7 个测试文件 48 项用例、生产构建全部通过；`GET /api/logto/sign-in` 返回 307 且 `redirect_uri` 与控制台一致，该 authorize 请求被 Logto 接受（303 → `/unknown-session`）；浏览器内完整登录待人工完成一次后补记

## 2026-11-11（约束补强 + 状态迁移写路径）

- **取值域钉进数据库**（提交 `bd005d1`）：`objects` 新增 `objects_status_check`、`objects_format_check`、`objects_asset_has_no_work_fields`、`objects_work_requires_format` 四条 CHECK，迁移 `drizzle/0001_objects_value_domains.sql` 重建表并原样搬移既有行；绕过服务层直写脏值时由数据库拒绝
- **新建作品只能从 draft 开始**：`CreateObjectInput` 移除 `status` 字段，仓储插入时固定写 `draft`，请求体携带任何 `status` 一律 400；此前仓储可被直接插入 `practiced`
- **补齐作品状态写路径**：新增 `ObjectRepository.changeStatus` 与 `POST /api/objects/{id}/status`（请求体 `{ "to": "<状态>", "expectedRevision": <可选正整数> }`）。迁移先过 `src/domain/workflow.ts` 的显式迁移表：跳级返回 `INVALID_TRANSITION`（409），外库试图 `practiced` 返回 `EXTERNAL_LIBRARY_PRACTICED`（409），资产返回 400；写入带 revision 条件，过期版本返回 `CONFLICT`；按 `ownerSub` 过滤，他人对象按 404 处理
- 验证：typecheck、lint、7 个测试文件 55 项用例、生产构建通过；mock 身份实测 `draft → finished` 200、跳级 409、过期 revision 409、资产 400、未知 id 404

## 2026-11-11（outbox 生命周期补齐）

- `sync_jobs` 增加活跃任务分区唯一索引 `sync_jobs_active_uq`（`owner_type + owner_id + coalesce(content_ref_id,'') + action`，仅覆盖 `pending` / `running`），迁移 `drizzle/0002_sync_jobs_active_dedupe.sql`
- `enqueueJob` 去重：同一对象同一动作已有活跃任务时直接返回已有任务；并发入队撞唯一索引也返回已有任务而不是报冲突
- 新增 `claimJobs`：单条 `UPDATE ... WHERE id IN (SELECT ...)` 原子认领，置 `running`、`attempts + 1`；可选 `staleAfterMs` 回收租约过期的 `running` 任务
- 新增 `markJobDone` 与 `markJobFailed`：失败未达上限回到 `pending` 并按指数退避（1 分钟起翻倍，上限 30 分钟）安排下次执行，达到 `maxAttempts`（默认 5）置 `failed`
- 验证：typecheck、lint、7 个测试文件 61 项用例通过

## 2026-11-11（P1：迁移前置校验、归档、引用完整性）

- `changeLibrary` 支持 `expectedRevision` 乐观锁；已 `practiced` 的作品迁回外库改为在领域层抛 `EXTERNAL_LIBRARY_PRACTICED`（409），不再落到数据库 CHECK 的 422
- 新增 `archive` / `unarchive`：只改 `archivedAt` 元数据，幂等（重复调用不涨 revision），默认列表过滤归档对象
- `contentRefs.upsert` 改为单条 `INSERT ... ON CONFLICT DO UPDATE`，消除「先查再写」的竞态；字段改为「缺席保持原值、显式 null 才清空」，修掉 `??` 永远无法清空 `parseError` 等问题
- 迁移 `drizzle/0003_content_refs_integrity.sql`：`library_events.object_id → objects.id`、`sync_jobs.content_ref_id → content_refs.id` 两条外键，`dataset_id` / `document_id` / `content_key` 非空长度约束
- 验证：typecheck、lint、8 个测试文件 80 项用例通过

## 2026-11-11（对象 CRUD 接口补齐）

- 新增 `PATCH /api/objects/{id}`（编辑，`expectedRevision` 必填，`type` / `library` / `status` 不可改）、`DELETE /api/objects/{id}`（软删除，204）
- 新增 `POST /api/objects/{id}/library`（跨库迁移，`reason` 必填）与 `POST /api/objects/{id}/archive`（`{ "archived": true | false }`）
- 服务层统一按 `ownerSub` 校验归属，非本人对象一律 404；请求体解析集中在 `object-service`，可空字段区分「缺席」与「显式 null」
- 验证：typecheck、lint、8 个测试文件 84 项用例、生产构建通过；mock 身份实测编辑 200 / 改库别 400 / 过期 revision 409 / 迁移 200 / 缺理由 400 / 归档 200 / 取消归档 200 / 删除 204

## 2026-11-11（RAGFlow 部署与适配器）

- **RAGFlow v0.20.5 以 Docker 部署并实测连通**：`infra/ragflow/docker-compose.yml` 精简为 elasticsearch 单一文档引擎；`ragflow-server` 9380 API / 18080 Web、MySQL 5455、ES 1200、MinIO 19000/19001、Redis 16379，全部避开 Logto 端口
- 实测链路：取 API key → `GET /datasets`（空）→ 建 dataset（`BAAI/bge-large-zh-v1.5@BAAI`）→ multipart 上传 document → 列表核对 → 删 document → 删 dataset → 列表恢复空；契约纠正：v0.20.5 上传是单次 multipart POST（字段 `file`），文档列表在 `data.docs`
- 新增 `src/server/adapters/ragflow/{client,index}.ts`：`listDatasets` / `createDocument` / `deleteDocument`，错误映射到领域错误，配置缺失即拒绝启动；15 个 mock fetch 单测
- 已知限制：解析流水线未实测（缺 chat model API key）；MinIO 使用社区重建镜像 `pgsty/minio`
- 验证：typecheck、lint、8 个测试文件 84 项用例通过（构建此前已通过）

## 2026-11-11（outbox 与写库同事务）

- 对象的编辑、归档 / 取消归档、跨库迁移改为在同一个数据库事务里写 `objects`（迁移时连同 `library_events`）并入队 `sync_jobs`，不再出现「元数据已改但没有同步任务」
- 软删除在同一事务中写 `objects.deleted_at` 与一条 `delete` 任务，避免 RAGFlow 侧留下孤儿文档
- 同一对象同一动作只保留一条活跃任务（`sync_jobs_active_uq` + `ON CONFLICT DO NOTHING`）：编辑后紧接着归档或迁移，不会堆出多条重复 upsert
- revision 过期导致更新失败时整个事务回滚，不会留下无对应改动的任务
- 验证：typecheck、lint、8 个测试文件 88 项用例通过（新增 4 项 outbox 断言：去重、删除任务并存、完成后可再次入队、冲突不留任务）

## 2026-11-11（对象详情与迁移审计读取）

- 新增 `GET /api/objects/{id}`：按身份返回单个对象，他人对象与不存在的对象统一 404
- 新增 `GET /api/objects/{id}/library`：返回该对象的跨库迁移记录（时间正序），迁移审计从「只写不可读」变为可查询
- 验证：typecheck、lint、8 个测试文件 89 项用例通过；mock 身份实测详情 200、迁移 200、审计 200、未知 id 404（首次冒烟误命中 3100 端口上残留的旧生产服务，停止后重测）

## 2026-11-11（数据层加固：迁移目录与审计约束）

- 迁移目录改为运行时解析，并支持 `MIGRATIONS_FOLDER` 覆盖：以 `next start` 从其他工作目录启动时不再依赖「cwd 恰好是仓库根」；目录里缺 `meta/_journal.json` 时直接给出可读错误，而不是让 drizzle 抛出晦涩异常
- 迁移 `drizzle/0004_library_events_cross_check.sql`：`library_events` 增加 `from_library <> to_library` CHECK，同库迁移记录在数据库层被拒绝（服务层此前已拒绝）
- 验证：typecheck、lint、8 个测试文件 90 项用例通过（新增迁移目录缺失、同库审计记录两项断言）

## 2026-11-11（列表检索与分页）

- `GET /api/objects` 支持 `q`（标题/描述关键字，`%` 与 `_` 按字面量匹配）、`category`、`tag`（按数组元素精确匹配）、`status`、`sort`（`updated` / `created` / `title`）、`limit`（1~200）、`offset`
- 非法筛选值一律 400，不做静默忽略；`limit` / `offset` 越界同样拒绝
- 验证：typecheck、lint、8 个测试文件 95 项用例通过（新增关键字含通配符、分类/标签精确匹配、标题排序与分页断言）

## 2026-11-11（Phase 2：内容上传与 RAGFlow 映射）

- 新增 `POST /api/objects/{id}/content`（multipart：`file` 必填，`role` = primary | attachment，`documentName` 可选），单次上限 25 MB；按会话身份校验归属，他人对象 404 且不触达 RAGFlow
- 单一 Dataset（ADR-007）：`RAGFLOW_DATASET_ID` 优先，否则按 `RAGFLOW_DATASET_NAME`（默认 `pakp-content`）查找，缺失时自动创建
- `content_key` 作幂等键：主内容 `obj:{objectId}:primary`，附件带 ULID；上传成功后写 `content_refs` 并入队 `sync_jobs(upsert)`
- 主内容替换改为「先以临时名上传新文档 → 写 meta → 落库并入队 → 删旧文档 → 改回原名」：新上传失败时旧内容与旧引用保持不变，不再有先删后传的丢内容窗口
- `meta_fields` 只镜像 `content_key` / `owner_type` / `owner_id` / `library` / `archived` / `format` / `source`；实测上传接口不接受 meta，需要上传后 `PUT` 整体替换
- 适配器新增 `createDataset`、`renameDocument`、`updateDocumentMetaFields`；RAGFlow 同名重传行为不确定（列表出现 `(1)` 后缀），替换流程据此改用临时名 + 改名（改名接口实测可用）
- 验证：typecheck、lint、9 个测试文件 117 项用例通过；mock 身份 + 真实 RAGFlow 端到端上传 201，落 1 条 `content_ref` 与 1 条 pending upsert；冒烟文档与测试残留已删除，内容库恢复 0 文档

## 2026-11-11（文档：API 参考与工程手册）

- 新增 `docs/06_API.md`：按 `src/app/api/**/route.ts` 与对应 service / repository 逐条核对后写成，覆盖当前 15 条路由（12 条业务 / 系统接口 + 3 条 Logto 跳转），含请求字段、查询参数、错误码映射与可复制的 curl 示例；未实现能力集中列在第 8 节，不当作契约
- 记录本轮新增能力：`GET /api/objects/{id}`（对象详情，他人对象与不存在统一 404）、`GET /api/objects/{id}/library`（迁移审计，按 `createdAt` 正序）、`POST /api/objects/{id}/content`（multipart 上传，25 MB 上限、`role` / `documentName` 规则、单一 Dataset、`content_key` 与 `meta_fields` 镜像、替换顺序与各失败点的处理）、列表的 `q` / `category` / `tag` / `status` / `sort` / `limit` / `offset`、`POST /api/sync/run`（手动触发一轮 outbox 投递，含后台 worker 的启动条件与间隔）
- 更正：列表 `limit` 的数据层默认值是 **100**（`sqlite-object-repository.ts` 的 `query.limit ?? 100`），上限 200；此前口头按 50 讨论，以代码为准
- 新增 `docs/07_PLAYBOOK.md`：目标与阶段口径、分层与业务约定、按 `git log` 的 20 个提交与提交时测试项数、问题—根因—解决—预防 14 条、验证流程、协作分工、阻塞与待验证清单、提交索引
- 明确标注未验证项：RAGFlow 解析 / 检索未接线、outbox 投递只在假网关单测下验证、生产构建在 `5b19bfe` 之后未复跑、Logto 浏览器内完整登录仍待人工
- 文档侧未改动 `src/`、`drizzle/`、`infra/` 与 `04_INTEGRATION.md`；`docs/01_ARCHITECTURE.md` 的既有未提交改动保持原样（其「内容上传与同步投递尚未实现」一句已过时，待随该文件提交时修正）
- 验证：`npm test` 10 个测试文件 127 项通过（文档仅核对代码与测试，未改实现）

## 2026-11-11（工作台操作、outbox 消费端与归档视图）

- `82d8d54` 工作台对象行内操作：状态推进按 `allowedTransitions` 计算（外库作品的 practiced 自动消失）、跨库迁移理由必填、编辑/归档/删除集中进展开面板，并抽出 `api-error` / `object-labels` 共用
- `1ea0b86` outbox 消费端：`sync-service.runSyncOnce` 原子认领任务，`upsert` 重写 RAGFlow `meta_fields`、`delete` 删文档并软删引用；文档已不存在视为达到目标状态，其它失败走指数退避；新增 `POST /api/sync/run` 与进程内定时 worker（`SYNC_WORKER_ENABLED` / `SYNC_WORKER_INTERVAL_MS`）
- `a7aa5f3` 列表新增 `archived=only`（只返回已归档），并校验 `true` / `false` / `only`，非法值 400；供归档视图与「取消归档」使用
- 真实 RAGFlow v0.20.5 端到端验证投递：上传 → 迁移到外库 → `POST /api/sync/run`（claimed 2 / done 2）→ 文档 meta 回读 `library=external`、`archived=false`、无 `status` → 删除对象 → `POST /api/sync/run`（claimed 1 / done 1）→ 数据集文档数回到 0
- 文档同步到当前 HEAD：`docs/06_API.md`、`docs/07_PLAYBOOK.md` 覆盖 15 条路由与 20 个提交；`docs/01_ARCHITECTURE.md` 修正「内容上传与同步投递尚未实现」等过时表述，新增 5.6 内容上传与 outbox 投递小节。上文「文档：API 参考与工程手册」条目中「outbox 投递只在假网关单测下验证」「01 待修」两点以本节实测结果为准
- 验证：typecheck、lint、`npm run build` 通过；10 个测试文件 127 项用例通过（新增 outbox 投递 8 项、归档视图 2 项）

## 2026-11-11（内容链路：解析轮询、下载、检索）

- `b1bde9d` 解析触发与状态轮询：上传后立即调用 RAGFlow `POST /api/v1/datasets/{id}/chunks` 并把引用置为 `running`，触发失败不影响上传、引用停在 `pending`；`parse-service.pollParsingOnce` 每轮取最多 50 条 `pending` / `running` 引用，按 `UNSTART / RUNNING / SCHEDULE / DONE / FAIL / CANCEL` 回写状态（`parseError` 取 `progress_msg` 最后一行），配套 `POST /api/parse/run` 与 `GET /api/objects/{id}/content` 引用列表。实测（RAGFlow v0.20.5）：上传即 `running`，约 9–12 秒后 `succeeded`，`chunk_count = 1`
- `44c3b8d` 内容下载接口：`GET /api/objects/{id}/content/{refId}` 先校验对象与引用归属，再透传 RAGFlow 文件流（`Content-Type` 实测 `application/octet-stream`，`Content-Disposition` 用 `filename*=UTF-8''` 编码文件名，有长度时带 `Content-Length`）；实测下载内容与上传文件逐字节一致。顺带确认 `GET /documents/{id}` 是文件流而非 JSON 详情接口
- `1258e15` 内容检索接口：`GET /api/search` 以 `q`（1–200 字符）必填，`limit` 默认 10（1–50）、`threshold` 默认 0.2（0–1）、`library` 可选；命中先按 `document_id` 认回 `content_refs` 再校验对象归属，已归档对象不返回、指定库别时只返回该库，`total` 为过滤后条数。实测同一文档检索相似度约 0.38–0.48，归档后同一检索返回 0 条
- `b860530` 仓储 SQLite 错误翻译统一：抽出 `sqlite-errors.ts`，`CHECK` 与 `NOT NULL` 约束失败统一翻成 `CONSTRAINT_VIOLATION`（422），`UNIQUE` 与 `FOREIGN KEY` 失败统一翻成 `CONFLICT`（409），`details.constraint` 带出约束名（外键冲突除外）；调用方不再依赖 SQLite 英文报错文本
- 文档同步到 `b860530`：`docs/06_API.md` 从 15 条路由扩到 19 条（新增 4.11 引用列表、4.12 原文下载、5.1 内容检索、6.3 解析轮询），上传章节改为「上传即触发解析」，未实现清单收敛为问答会话、LightRAG、内容删除/附件解绑、列表总数等；`docs/01_ARCHITECTURE.md` 更新实现状态、分层职责表、`sync_jobs` 说明与 5.6 小节

## 2026-11-11（工作台筛选与归档守卫）

- `3b8ddb4` 工作台列表筛选与归档视图：搜索、类型、库别、状态、排序与「在用 / 已归档」全部写进 URL（`q / type / library / status / sort / archived`），列表由服务端按条件查询；概览、阶段与构成统计固定取在用全量，不随筛选跳动。非法参数在页面层按默认值兜底（接口仍返回 400）。已归档对象在详情侧提供「取消归档」。新增 `src/lib/workspace-filters.ts` 与 15 项单测
- `4e86ddf` 已归档作品不能再推进状态：仓储在状态机校验前检查 `archivedAt`，命中返回 `409 CONFLICT` 并带 `archivedAt`；取消归档后可按原状态机继续。浏览器实测：已归档作品点「推进」被拒，归档视图内「取消归档」后回到在用列表
- `26fcbe5` 文档同步到 `b860530`（解析轮询、下载、检索）；随后补记归档状态迁移的 409 规则
- 验证：typecheck、lint、`next build` 通过；14 个测试文件 169 项用例通过（新增筛选 15 项、已归档状态守卫 1 项）。筛选页在本地 mock 身份 + 临时数据库下用真实浏览器走通：类型/库别/关键字/归档切换/取消归档，及 8 组服务端渲染断言（含非法参数兜底）

## 2026-11-11（检索页与对象详情页）

- 新增 `/search` 检索页：检索词 / 库别 / 相似度阈值全部写进 URL，服务端读 `searchParams` 查询；结果卡展示类型、库别、状态、形态与相似度条，空结果给出「放宽到 0.1」「去掉库别」「清空检索」三条下一步
- 新增 `/workspace/[id]` 对象详情页：元数据网格、四阶段操作、内容文件区（上传主内容 / 附件、解析状态轮询、下载）；对象不存在时由 `not-found.tsx` 展示「找不到这条内容」
- 新增共用组件与工具：`app-sidebar`（侧栏统一入口，仅知识图谱保留「即将开放」）、`api-client`（统一响应信封与错误消息）、`content-format`、`object-labels` 扩充、`search-params`（参数校验与 URL 构造）
- 检索摘要安全渲染：`search-highlight` 先剥离脚本 / 样式 / 事件属性，再按强调标签与检索词切成片段，页面只用 React 文本 + `<mark>`，不使用 `dangerouslySetInnerHTML`；新增 15 项单测覆盖实体解码、正则转义、截断与未闭合标签
- 修复检索页布局：`.filter-search` 的 `flex: 1 1 220px` 在纵向字段里被当成高度，导致输入框被拉到 220px；在 `.search-query .filter-search` 内改为 `flex: 0 0 auto; width: 100%`
- 修复下载文件名：RAGFlow 回传的文件名被过滤成只剩 `.txt`，下载路由改为优先使用本地 `ref.documentName`，并同时输出 ASCII 兜底名与 `filename*=UTF-8''`；实测响应头恢复中文原名
- 修复同步测试的时间依赖：`sync-service` 用例入队用系统时钟、认领用固定 `NOW`，真实时间越过 `NOW` 后 8 项用例失败；改为 `vi.useFakeTimers()` + `setSystemTime(NOW)`，用例后恢复真实计时器
- 验证（2026-11-11，`AUTH_MODE=mock` + 本机 RAGFlow v0.20.5 + 临时数据库）：浏览器提交检索「内容复盘」得到 1 条结果（相似度 70%）并正确高亮；详情页显示「已解析」，通过页面文件选择上传附件成功（toast + 解析中 + 2 个文件），下载 650 B 与上传一致，404 页面正常展示
- 四项检查：typecheck、lint、`next build` 通过；`npm test` 17 个测试文件 / 205 项通过
- 未验证：前端页面尚未在 `AUTH_MODE=logto` 的真实身份下冒烟；不存在的对象页面因 `workspace/loading.tsx` 先流出 shell，HTTP 状态为 200（页面内容正确），记为已知行为

## 2026-11-11（Phase 3：LightRAG 知识图谱）

- **ADR-010**：LightRAG 以本机 Python 进程运行（`lightrag-hku[api]==1.5.7`，`:9621`）；LLM 用 Ollama `deepseek-r1:7b`；Embedding 复用 RAGFlow 的 `bge-large-zh-v1.5`，由本地 OpenAI 兼容服务暴露（`:9381`，1024 维、归一化）；图与向量存储独立放在 `infra/lightrag/data/`。`docs/03_DECISIONS.md` 增加 ADR-010 与决策索引
- **基础设施**：新增 `infra/lightrag/`（`embedding_server.py`、`.env.example`、`start.ps1`）；`.env.example` 增加 `LIGHTRAG_BASE_URL` / `LIGHTRAG_API_KEY`，真实值只写 `.env.local`；`.gitignore` 排除 venv、模型、数据与本地 env
- **适配器**：`src/server/adapters/lightrag/` 封装文本入库、文档分页、删除、标签、子图与 `mix` 问答；统一 `X-API-Key`，普通请求 30 秒、问答 180 秒超时，错误收敛为 `DomainError("INTERNAL")`
- **服务层**：`src/server/services/graph-service.ts` 负责「对象 → RAGFlow 分块原文 → 带标题 / 类型 / 库别 / 分类 / 标签的图谱文本」；`file_source=pakp:obj:{id}:{sha256 前 12 位}` 作幂等键，同哈希跳过、旧版本先删后写；问答引用按 `pakp:obj:` 与归属过滤并映射回对象。单轮最多 50 个对象
- **接口**：`GET /api/graph/labels`、`GET /api/graph?label&depth`、`POST /api/graph/sync`、`GET /api/graph/status`、`POST /api/graph/query`（body `{ q }`）；全部要求登录，错误走统一信封
- **前端**：新增 `/graph` 知识图谱页与 `GraphExplorer`：实体筛选列表、两层邻域同心圆 SVG（点击圆点切换中心）、实体描述、图问答与来源对象、同步按钮与 15 秒抽取进度轮询；侧栏新增「知识图谱」，移除「即将开放」占位。纯函数 `graph-layout` / `graph-labels` 附单测；新增 22 项图谱样式与响应式规则
- **实测（本机 CPU，2026-11-11）**：118 字测试文本约 226 秒完成抽取，得到 9 个实体 / 3 条关系；`/graph` 页面 SSR 返回实体与初始邻域，浏览器点击实体后标题与子图切换；`POST /api/graph/query` 约 93.8 秒返回中文答案（测试文档未带 `pakp:` 前缀，因此来源列表为空，符合过滤规则）；`/api/graph/sync` 在本机空库返回 `candidates: 0`
- **限制**：LightRAG 图 / 问答路由绑定单实例默认 workspace，`LIGHTRAG-WORKSPACE` 未覆盖这些路由，当前只适合单用户本机部署；7B 模型会把 `#` 等噪声当实体；子图沿有向边展开，只有入边的实体显示为空
- **工程**：`eslint.config.mjs` 增加 `**/.venv/**` 忽略（嵌套 venv 里打包的 WebUI 静态资源不再产生 573 条误报）。验证：typecheck、lint、`next build` 通过；19 个测试文件 / 216 项用例通过

## 2026-11-11（真实登录联调、图谱归属隔离与开机自启）

- **修 Logto 回调 500**：`@logto/next` 的 `handleSignIn` 在传入 `URLSearchParams` 时会自行按 `${baseUrl}/callback` 拼回调地址，与登记的 `/api/logto/sign-in-callback` 不一致，报 `callback_uri_verification.redirect_uri_mismatched`。改为传完整 `new URL(request.url)`（`src/app/api/logto/sign-in-callback/route.ts`），假 code 复测错误变为预期的 `sign_in_session.not_found`，真实登录 307 → `/workspace 200`
- **修注册 500**：Logto 默认调用 `api.pwnedpasswords.com` 做弱密码检查，本机无外网 DNS（`EAI_AGAIN`）导致 `POST /api/experience/profile` 500；`infra/logto/docker-compose.yml` 增加 `ENABLE_PWNED_PASSWORD_API: "false"` 并重建容器
- **真实登录冒烟（无头 Chromium + CDP）**：发起登录 → Logto 登录页 → 回调换码 → `/workspace`；`/search`、`/graph`、`/workspace/[id]` 渲染正常；创建资产 201、非法请求体 400、匿名 `/api/objects` 401。测试账号 `pakp_test`（`sub` `7vjekboa76zu`），本人账号 `JCzero001`（`sub` `gdv8t04dw4ca`）
- **ADR-011 图谱按账号归属过滤**：LightRAG 1.5.7 的 workspace 是进程级、无法按请求切换，采用读侧过滤——`LightragNode/Edge` 带出 `file_path`，标签列表、实体邻域、构图进度、问答引用只保留映射到本账号对象的节点 / 边 / 文档；问答引用为空时返回空答复；标签结果按账号缓存 60 秒。实测第二个账号 0 条内容时 `/graph` 从「9 个实体」变为「0 个实体」
- **服务自启**：新增 `scripts/autostart.ps1`（幂等拉起 Logto / RAGFlow / LightRAG / embedding，`-Check` 只检查、`-App` 连带起应用）与 `scripts/install-autostart.ps1`（在用户「启动」文件夹放快捷方式，免提权；`-Remove` 撤销）
- **验证**：typecheck、lint、`next build` 通过；19 个测试文件 / 216 项用例通过；`next start`（3100）实测 health 200、首页 200、未登录 `/graph` 307、sign-in 307 到 Logto
- **文档沉淀**：新增 `docs/08_RUN_LOG.md`，按时间顺序记录真实登录联调与验收的操作过程（回调 500 的定位与修复、pwned password 导致的注册 500、无头浏览器 9 项冒烟与断言表、图谱跨账号泄漏的复现与修复前后对比、生产模式检查、服务自启验证、遗留清单）；`07_PLAYBOOK` 补问题 34~36（PowerShell 无 BOM、`schtasks` 提权失败、冒烟断言字段写错）并更新阶段表；`06_API` 更正「登录未人工验证」的过时表述；README 文档索引加入 08，路由数更正为 24


## 2026-11-11（新手使用手册）

- 新增 `docs/09_USER_GUIDE.md`：面向使用者的 5 分钟上手、日常用法、界面地图、常见问题与术语表；所有步骤按界面真实文案编写（工作台 / 内容检索 / 知识图谱、四阶段、内库外库、主内容与附件）
- README 修正过时状态：Logto 真实登录已验证、路由数 24、测试基线 19 文件 216 项、LightRAG 已接入；文档索引加入 08 与 09，并在开头指向新手手册
- `02_PHASES` 工程与文档清单补 09

## 2026-11-11（反馈修复、正文编辑与管理员后台）

- **退出登录**：侧栏底部改成明确的账号区（头像 + 姓名 + 邮箱）与整行「退出登录」按钮；之前只是 11px 灰色小字，且 `AUTH_MODE=mock` 时不渲染任何退出入口，现在 mock 下明确写「本地身份，无需登录」
- **检索框图标压字**：`.text-input` 的 padding 简写覆盖了 `.filter-input` 给放大镜留的 34px 左边距，补 `.text-input.filter-input` 高优先级规则，并隐藏 `type=search` 的原生清除按钮
- **侧栏「最近内容 / 作品进程」点不动**：这两项是 `/workspace#recent`、`/workspace#track`，Next 的 `<Link>` 在同一路径只换 hash 时不滚动；改用原生 `<a>` 并给两块面板加 `scroll-margin-top`
- **正文编辑器**：详情页内容区新增「编写正文 / 编辑正文」——原生 textarea + 行号列、行数/字数统计、Tab 缩进、Ctrl/Cmd+S 保存、未保存确认；保存复用 `POST /api/objects/{id}/content`（role=primary），仍走 RAGFlow 解析与检索，不新增依赖（`content-editor.tsx` + CSS Module）
- **管理员后台（ADR-012）**：新增 `ADMIN_SUBS` 白名单与 `Session.isAdmin`；`/admin` 展示依赖服务、存储与队列、按账号归属统计，提供「立即同步队列 / 推进解析状态」两个动作；非管理员渲染 403 说明页；`/api/sync/run`、`/api/parse/run` 收紧为仅管理员
- **旧项目前端审计**：新增 `docs/11_LEGACY_UI_AUDIT.md`（245 行），逐文件梳理 V1 的页面、组件、设计变量与交互，并给出「沿用 / 改造后沿用 / 不适用」对照表与三条优先建议
- **待办清单**：新增 `docs/10_BACKLOG.md`，记录本轮 6 个问题、处理方式与验收口径
- **验证**：typecheck、lint 通过；20 个测试文件 / 223 项用例通过；临时生产实例（mock 身份）实测 `/admin` 200 并渲染「系统管理 / 依赖服务 / 存储与队列 / 用户与归属」，详情页出现「编写正文」

## 2026-11-11（三栏应用框架与 Markdown 正文）

- **ADR-013 三栏应用框架**：抽出统一网格 `.app-frame`（76px 图标导航栏 + 模块目录 + 列表 / 详情），用 `:has(> .directory)` 决定三列、`.has-list` 变四列。`/workspace` 改为「导航栏 + 工作台目录（浏览 / 归属 / 作品进程）+ 列表 + 详情」；`/search`、`/graph`、`/admin` 改为「导航栏 + 模块目录 + 内容区」；`/admin` 非管理员 403 页同样套上导航栏。目录项指向同页锚点（`#graph-qa`、`#admin-storage` 等）时用原生 `<a>`，其余仍用 `<Link>`
- **列表与详情同屏**：工作台左侧列表保留当前筛选与排序，点条目只在右侧详情区切换，地址仍带完整查询串；活动行高亮；≤900px 用 `data-selected` 让列表与详情互斥，≤1100px 隐藏目录，≤560px 导航只留图标
- **ADR-014 正文类型**：详情页「编写正文 / 编辑正文」顶栏加「类型」分段控件（纯文本 | Markdown）。Markdown 模式左写右预览，保存为 `text/markdown` / `.md`；打开已有正文时按 MIME 与扩展名自动选中类型。预览由零依赖 `src/lib/markdown.ts` + `MarkdownPreview` 渲染 React 元素，不使用 `dangerouslySetInnerHTML`，正文仍以源码存入 RAGFlow
- **样式修复**：Markdown 预览的 `h1` / `h2` 引用了不存在的 `--fs-22` / `--fs-18`（按浏览器默认字号渲染、层级扁塌），改为 `--fs-26` / `--fs-20`；详情区变窄后作品进度条出现横向滚动与多余空白，`.detail-workspace` 内把概览网格重设为 `minmax(0,1fr) / 300px`、进度面板顶部对齐、`.track` 最小宽度 560px
- **清理死代码**：删除无人引用的 `src/components/app-sidebar.tsx`、`src/components/workspace-shell.tsx`，以及 `.app-shell` / `.sidebar*` / `.nav-item` / `.main-nav` / `--sidebar` 等旧样式（约 3.9 KB）
- **文档**：新增 ADR-013 / ADR-014 与决策索引；`09_USER_GUIDE` 补三栏界面地图与 Markdown 写法；`10_BACKLOG` 两项需求标记完成；`07_PLAYBOOK` 补问题 41~44；`02_PHASES` 记录本轮
- **验证**：typecheck、lint 通过；21 个测试文件 / 228 项用例通过。真实 Logto 账号（`pakp_test`）无头 Chromium 复测 1680×1000 与 860×1000：工作台列宽 76 / 224 / 340 / 1040，检索与图谱 76 / 224 / 1380，后台 76 / 1604，页面无横向溢出、无控制台报错与水合告警；列表 → 详情活动行正确；编辑器类型切换与 Markdown 预览（一级标题 / 粗体 / 行内代码 / 2 条列表）正常；≤860px 列表与详情互斥

## 2026-11-12（内外库文案、目录层级与批量操作）

- **归属文案**：界面不再给内库 / 外库加验证标记——工作台目录、检索目录、内容构成的「内库 · 已验证 / 外库 · 待验证」统一为「内库 / 外库」，说明文字改为「长期复用 / 收集的输入」，新建对话框的副标题与迁移理由示例同步改写；领域层语义（内库可复用、外库待整理）保持不变
- **目录层级**：分组标题（浏览 / 归属 / 作品进程）由 11px 灰色改为 13px 半粗、深一档；「作品进程」四个阶段相对分组标题缩进 16px，并用一条竖线标出从属关系，活动项竖线变绿
- **ADR-015 批量操作**：第三列新增批量条——全选、已选计数、`批量归档 / 批量导出 / 批量删除`；列表行常驻复选框，未选中或执行中按钮禁用。批量条位置定在**筛选框下方、列表上方**，与「标题 → 筛选 → 批量 → 列表」的阅读顺序一致（初版放在筛选框上方，同日按反馈互换）
  - 归档、删除复用单条接口逐项执行（`Promise.allSettled`），部分失败提示「已处理 N 项，M 项失败」；删除保留二次确认弹窗；成功后清空选择并刷新
  - 导出在浏览器拼一份 Markdown：每项含类型 / 归属 / 阶段 / 分类 / 标签 / 时间 / 描述，纯文本主内容带出正文，二进制只列附件名；文件名 `资产与作品-YYYYMMDD.md`
- **水合告警**：浏览器扩展会在 React 加载前往 `<html>` / `<body>` 注入私有属性（如 `data-atm-ext-installed`），开发浮层报 hydration mismatch。根布局对这两个元素加 `suppressHydrationWarning`，只屏蔽根元素自身的属性差异，子树真实水合问题仍照常报告；无头测试在应用脚本前注入同名属性复测，控制台零告警
- **组件与测试**：新增 `src/components/record-list.tsx`（客户端列表 + 批量条）与 `src/lib/export-markdown.ts`；工作台列表行从服务端组件迁入该客户端组件；新增 `tests/lib/export-markdown.test.ts`
- **验证**：typecheck、lint 通过；22 个测试文件 / 231 项用例通过。真实 Logto 账号无头 Chromium 实测：列内顺序为「标题 0–71px → 筛选 71–231px → 批量条 231–308px → 列表 316px 起」，1680px 与 1100px 宽均无横向溢出；勾选后计数「已选 1 项」、三个按钮启用；批量删除与批量归档实跑成功（「已删除 1 项」「已归档 1 项」，列表同步刷新）；删除弹窗文案正确且可取消；导出 toast「已导出 1 项」，捕获的 Blob 为 `text/markdown`、内容含标题 / 归属：内库 / 正文占位；控制台无报错
- **文档**：新增 ADR-015 与决策索引；`07_PLAYBOOK` 补问题 45~46 并更新快照；`02_PHASES` 增加 Phase 5.6；`09_USER_GUIDE` 补批量操作与目录说明；`10_BACKLOG` 记第 4 轮

## 2026-11-12（长内容滚动：工作台列表与正文编辑器）

- **工作台列表**：`.app-frame` 只有列轨道，隐式行高是 `auto`，内容多时整行被撑高再由 `overflow: hidden` 裁掉，条目区拿不到有界高度。显式补 `grid-template-rows: minmax(0, 1fr)` 后，`.record-scroll` 内部滚动，标题、筛选框、批量条固定不动
- **正文编辑器**：`.markdownPane` 同一个毛病——240 行正文把它撑到 14900px，左右两栏都被裁掉、滚不了。补同样的行轨道约束，并给 `.writePane` / `.previewPane` / `.input` / `.previewScroll` 加 `min-height: 0`（flex 子项的自动最小高度等于内容高度，不归零就撑破面板）；纯文本 textarea 与 Markdown 书写 / 预览各自独立滚动，底部统计与按钮始终可见
- **滚动条可见性**：Windows 11 的 Chromium 默认覆盖式滚动条在静止时不绘制滑块，长列表看起来像「没有滚动条」。列表与编辑器滚动区改用 `::-webkit-scrollbar` 的 10px 常驻细条，列表加 `scrollbar-gutter: stable` 避免条数变化时列宽跳动；不写 `scrollbar-width` / `scrollbar-color`，否则 Chromium 会忽略 WebKit 规则又退回覆盖式
- **改动范围**：只动 `src/app/globals.css` 与 `src/components/content-editor.module.css` 两个样式文件，无组件逻辑、无新依赖、未改 `globals.css` 的既有设计变量
- **验证**：typecheck、lint 通过；22 个测试文件 / 231 项用例通过。真实 Logto 账号无头 Chromium、45 条临时数据实测：1680×900 / 1280×800 / 860×1000 下滚轮可滚、可拖到底（scrollHeight 2835 vs clientHeight 592），末条完整可见，标题与批量条 top 值不变，`offsetWidth - clientWidth` = 10px；编辑器贴 240 行（5908px）后纯文本与 Markdown 两栏均滚到底（textarea 5400/5400、预览 14392/14392），600×800 下底部按钮仍完整可见；临时数据实测后全部删除
- **文档**：`07_PLAYBOOK` 补问题 48；`02_PHASES` 增加 Phase 5.7

## 2026-11-12（自定义形态与标签、多主题、银河首页：先出决策）

- **ADR-016 作品形态与标签的词表化**：形态改 `work_formats` 表 + `objects.format` 外键（code 作主键，现有 4 条 `article` 无需改写）；标签改 `tags` + `object_tags` 多对多，删除 `objects.tags` JSON 列；对外仍返回 `format: string` / `tags: string[]`，由仓储水合，UI 与导出契约不变；新增 `/api/vocabulary` 作唯一读取入口，7 处 `workFormats` 硬编码清除
- **ADR-017 多主题**：CSS 变量 + `[data-theme]`，主题只覆盖语义 token 层；现有 `:root` 已具备语义层（`--text-*` / `--surface` / `--line` / 状态色对），缺的是切换机制与残留耦合——实测 `var()` 925 处、品牌色阶直引 107 处、硬编码颜色 79 处（TSX 内 0 处），据此定 3 批迁移路线与两条 `grep` 审计
- **ADR-018 银河首页**：`/` 升级为银河首页，`/workspace` 不动；星图用 Canvas 2D 手写（不引 three.js），四级降级（reduced-motion / 低配 / 隐藏暂停 / 无 canvas 兜底）；logo 由「三条竖杠」换银河图标并改回首页；首页抽屉与导航栏共用 `nav-items` 单一来源
- **风险清单 R1~R12**：其中 R1 已实测确认——Drizzle 把迁移包在单事务里，`PRAGMA foreign_keys = OFF` 在事务内无效，`DROP TABLE objects` 会被 `library_events` 外键直接挡下（`FOREIGN KEY constraint failed`），故 ADR-016 要求把外键开关移到 `migrate()` 外层并加 `foreign_key_check` 断言
- **未纳入本批**：使用者提出的「管理页面细化（用户 / 角色 / 权限）」，与 ADR-003（不做多用户隔离与 RBAC）、ADR-012（无本地用户表）冲突，登记为待定 ADR-019

## 2026-11-12（形态与标签词表化第一阶段：数据层与接口，ADR-016）

大改造拆两阶段，本轮只做数据层与服务端接口；新建对话框、目录管理页、后台与首页留到第二阶段。

- **形态词表**：新增 `work_formats` 表（`code` 主键、`label`、`sort_order`、`state`、`is_system`），`objects.format` 由六值 CHECK 改为外键引用。种子 7 条内置形态（文章 / 音视频脚本 / 课程 / 直播 / 咨询 / 外部笔记 / 未分类，`sort_order` 10…999），现有 4 条 `article` 对象无需改写
- **标签词表**：新增 `tags`（`normalized` 唯一）与 `object_tags`（联合主键 + 级联删除），删除 `objects.tags` JSON 列。存量标签由迁移按 `json_each` 灌入并按 `lower(trim())` 归并，同一标签的全角 / 大小写 / 空白写法不产生重复行
- **迁移 `0005_vocabulary.sql`**：手工重排 drizzle-kit 生成的顺序——词表与种子在前，`objects` 重建在后。外键开关移到 `migrate()` 外层（Drizzle 把整批迁移包在单事务里，事务内 `PRAGMA foreign_keys=OFF` 是空操作），迁移后执行 `PRAGMA foreign_key_check`，非空即抛错拒绝启动；迁移前用 `VACUUM INTO` 备份为 `<db>.bak-<ISO>`
- **对外契约不变**：仓储层仍返回 `format: string` / `tags: string[]`，由 `object_tags` 水合；`objects` 的 API、导出 Markdown、检索命中卡签名不变，只多传一个「code → 中文名」的映射。标签筛选改走 `EXISTS (... normalized = ?)`，与标签展示写法解耦
- **`/api/vocabulary`**：`GET` 返回形态 + 标签及引用计数（**软删对象不计入**）；`POST /formats`、`PATCH/DELETE /formats/[code]`、`POST /tags`、`PATCH/DELETE /tags/[id]`、`POST /tags/[id]/merge`，写操作全部走 `adminGuard`
- **删除保护**：被引用的形态 / 标签返回 409，带 `usage` 与引用样例；形态可 `?migrateTo=<code>` 批量迁移后删除（`revision+1` 并入队同步），标签可 `removeFromObjects` 强制移除；内置形态、最后一个启用形态不可删；启用形态上限 30 个
- **归一化单一实现**（`src/domain/vocabulary.ts`）：分隔符（半 / 全角逗号、顿号、分号、换行）→ trim → 内部空白折叠 → NFKC → 小写键 → 按键去重 → **每对象 ≤10 个标签、单标签 ≤20 字**；标签总数超过 500 时给合并建议（软上限）
- **硬编码清零**：删除 7 处形态常量引用，`WorkFormat` 改为 `string`，合法性由词表 + 外键兜底；新增 ESLint `no-restricted-imports` 守卫，禁止业务代码再 `import { SYSTEM_FORMAT_SEEDS }`
- **迁移演练**：`scripts/rehearse-vocabulary-migration.mjs` 在副本上跑完整迁移并输出前后计数；`tests/server/vocabulary-migration.test.ts` 是同一演练的自动化版本（旧结构造数据 → 升级 → 旧数据可读、`foreign_key_check` 为空）
- **验证**：真实库 `data/app.db` 迁移前后对象 9 / 作品 4 / `article:4` 完全一致，7 条内置形态、1 个标签（`smoke`）、3 条关联，外键自检为空；真库迁移耗时 20 ms（副本演练 4 ms）；typecheck、lint 通过；25 个测试文件 / 256 项用例通过（基线 22 / 231）；未提交、未推送

## 2026-11-12（管理后台用户 / 角色 / 权限模型：ADR-019）

- **ADR-019 与前两条 ADR 的关系**：ADR-003 第 3 条拆开——「不做多用户数据隔离」继续有效，「不做 RBAC」废止；ADR-012 第 2 条「角色来源 = `ADMIN_SUBS` 白名单」由本 ADR 取代，其余条款（不单独登录、`/admin` 仅管理员可见、维护接口收紧、适配器不参与授权判断）全部保留。两份原文各追加一行「状态变更」指向 ADR-019，不删原文
- **分层结论**：Logto 只做身份（证明 `sub`），本地 SQLite 五表（`users` / `roles` / `permissions` / `role_permissions` / `user_roles`）做授权。理由：判定点与资源同库同事务、Logto 停机不连带授权失效、改角色即时生效；不采用 Management API + M2M（ADR-012 已判定为最重方案）
- **权限模型**：13 项权限 × 4 个系统角色（owner / admin / editor / viewer）。两条刻意设计——批量删除不单设权限（复用 `object:delete`，避免「单条能删、批量不能删」）；editor 能加标签但不能加形态（形态是全局结构，标签是内容属性），这一条同时是 ADR-016「内联新增」的权限落点
- **执行点**：`src/server/authz.ts` 的 `requirePermission` 是唯一强制层，所有 `/api/**` 方法必须调用；现有 `adminGuard` 收敛为它的薄封装；服务层写方法签名加 `actor`，让无 actor 的写无法通过类型检查；UI 显隐只当体验，不算安全边界。**明确否决用 Next middleware 鉴权**（拿不到 SQLite，且按路径匹配做不到「同路径 GET 放行、POST 拦截」）
- **不可绕过的保证是一条测试**：`route-guard.test.ts` 扫描 `src/app/api/**/route.ts` 的每个导出方法，必须调用判定或显式登记进 `PUBLIC_ROUTES`；同时扫 `"use server"`，为将来 Server Action 预留同一把锁
- **首个 owner 引导**：`users` 无 active owner 时 `ADMIN_SUBS` 生效并写入本地表；一旦有 owner，环境变量**不再参与授权**。保留逃生舱（owner 全失联时重新生效）与 `npm run admin:grant` 离线恢复脚本。换管理员由此从「改 `.env` 并重启」变为界面操作
- **审计**：新表 `audit_events`，`actor_user_id` **故意不加外键**（用 `actor_sub` 快照），保证删用户后审计仍可读；审计与业务写**同一事务**，失败则业务回滚（与 ADR-012「先记应用日志」的差异）；`library_events` 保留为领域记录，同时写一条审计
- **单机阶段边界**：权限判定、显隐、审计真正生效；`/admin/roles`、`/admin/permissions` v1 只读（4 角色不可自定义，52 格可穷举测试；自定义角色无法穷举，列为升级路径）；多用户数据隔离仍不做
- **ADR-016 两处文案修正**：① 标签上限由「每对象 ≤ 20」改为 **≤ 10**，与需求文档和已实现代码（`MAX_TAGS_PER_OBJECT = 10`）一致，并在验收要点补一条上限用例；② 词表管理入口由「导航栏新增词表项」改为**第二列目录「管理」分组**（管理形态 / 管理标签 → `/admin/vocabulary`），按用户原话「最左侧目录加一个管理区域」落位，路由不变
- **风险**：ADR-019 自带 A1~A7（升级后无人可进后台 / 最后一个 owner 被移除 / `sub` 变更失联 / 审计失败回滚 / Server Action 漏判 / mock 被当生产 / 权限表与代码常量漂移）；原风险清单 R12 标记为已由 ADR-019 决策

## 2026-11-12（与需求 / 设计文档对表：7 条待拍板项裁决）

- **裁决落点**：`12_REQUIREMENTS_V3.md` 的「待对齐项」表 7 条全部结案，写进 `03_DECISIONS` 的附录表，并回填到对应 ADR。词表路由定 `/admin/vocabulary/*`（不采纳 `/admin/vocab/*`，与 `/api/vocabulary` 同词）；首页星图维持 Canvas 2D；未登录首页改为「禁用态搜索框 + 提示」（覆盖 ADR-018 初稿的「不渲染」，已同步改第 2 条与验收第 1 条）；首页内联结果留到 v1.5；标签上限定为 10 个；主题只做 `localStorage` 不做 cookie；「未分类」不作为筛选项
- **权限矩阵按产品口径修正**：初稿给编辑角色开了删除与标签词表写入，与需求文档矩阵（删除 ❌、管理标签词表 ❌）和设计稿 §2.3（非管理员隐藏新增与「管理」）都不符。已改为：编辑有 `object:write`（含归档），无 `object:delete` / `object:export` / 两个词表写权限；批量条按「所含动作权限的交集」显隐
- **审计补 `result` 字段**（ok / error / denied）：沿用需求文档字段表；`denied` 记录 403，由 guard 独立写入，不能因审计写失败而放行
- **信息架构对齐需求文档**：`/admin` 改总览，现有运维三块迁入 `/admin/system`，页面清单为 `objects` / `vocabulary/{formats,tags}` / `users` / `roles` / `system` / `audit` 共 7 个子页；不单开 `/admin/permissions`（权限清单随角色矩阵渲染）
- **CASL 问题结案**：不引入。13 权限 × 4 角色是二维常量表，`includes` 足够；条件式判定（只能删自己的）出现时再评估
- **需求文档回改 2 处**：标签上限的「待确认」注记与待对齐表第 5 条改为「已定 10 个」，消除「建议以 ADR 的 20 为准」这条会让人改回去的指引
- **登记但未改他人正文的 3 处**：词表路由写法、管理员由表决定（`ADMIN_SUBS` 降级为引导）、需求文档「编辑=增删改」与矩阵「删除 ❌」自相矛盾——均在 ADR-019「对齐与差异」里写明结论，正文归 Product / Designer 改

## 2026-11-12（形态与标签词表化第二阶段：界面落地，ADR-016 / ADR-019）

- **新建弹窗**（`create-object-dialog.tsx`）：形态不再读常量，改由 `/api/vocabulary` 的启用项按 `sort_order` 渲染；新增「标签」区（已有标签按使用次数排序、输入即时新建、可点选），资产与作品都可打标签；每对象 ≤10 个、单标签 ≤20 字，超限禁用提交并给行内提示；归一化仍只调用 `src/domain/vocabulary.ts`，前端不重写规则。形态区右上角加「管理」入口（仅管理员，新标签页打开 `/admin/vocabulary/formats`）
- **编辑弹窗**：复用同一套标签控件，读得出已有标签、改得动，保存走 `PATCH /api/objects/[id]` 的 `tags`
- **第二列目录**：新增「管理」分组（仅管理员）——管理形态 / 管理标签，样式与对象 / 分类条目一致，分别指向 `/admin/vocabulary/formats`、`/admin/vocabulary/tags`（ADR-019 定案，不用 `?tab`）；工作台、检索、图谱、管理后台四个目录底部都带这一组
- **管理页**：`vocabulary-page.tsx` 作服务端壳（session、非管理员 403 兜底、词表读取、`AdminDirectory`），两个路由页各自只传 `tab`；`vocabulary-manager.tsx` 负责列表（名称 / 排序 / 使用次数 / 状态）、新增、行内重命名、上移下移、停用启用、删除保护（内置形态与最后一个启用形态不可删，按钮置灰并给原因）与二次确认；删除被引用项收到 409 时弹窗显示引用数量并提供「迁移到…（形态）/ 合并到…（标签）」，标签另有「仅从对象移除」危险路径；空 / 加载 / 错误状态齐备；`vocabulary-manager.module.css` 用设计令牌，≤900px 降为两列
- **列表筛选**：`workspace-filters` 新增 `tag` 参数（`parse` / `buildHref` / `toListObjectsQuery` / 已选 chips），第三列工具条加「标签」下拉（v1 单选 + 全部标签，只列 `usage > 0` 的项并保留当前选中），走服务端 `tag` 参数（按归一化键匹配）
- **全局同步**：5 条 `/api/vocabulary/*` 写路由成功后调用 `revalidateVocabulary()`（首页 / 工作台 / 检索 / 图谱 / 管理后台 / 两个词表页）；弹窗、筛选、详情、列表与导出标签全部读词表；复查后没有页面再用硬编码形态常量，`domain/objects.ts` 仅保留 `SYSTEM_FORMAT_SEEDS` 供迁移种子与测试，并有 ESLint `no-restricted-imports` 守护（问题 53）
- **修掉一个真实缺陷**：管理页上移 / 下移原本按「相邻行 ∓10」算新值，`sort_order` 间隔不足或相等时列表原地不动（问题 54）。改为交换相邻两行，值相等时整表按 10、20、30… 重排后再交换
- **测试**：`tests/lib/workspace-filters.test.ts` 为 `tag` 补 `parse` / `buildHref` / `toListObjectsQuery` 三组用例与 chips 断言，基线上调为 **25 个文件 259 项**，typecheck / lint / test 全绿
- **真实登录实测**（`pakp_test` + 无头 Chromium，1280×800 / 860×1000）：目录管理组与两个入口、新增 → 改名 → 弹窗同步、整表顺序、作品与资产各打一个标签、标签下拉恰好筛出两条、改名后筛选 / 详情同步、合并保留关联、删除被引用形态的 409 → 迁移、两档尺寸无横向溢出、弹窗可滚；控制台仅两处预期 409（问题 57）
- **数据与配置复原**：实测后对象 9（可见 7）/ 形态 7 / 标签 1 / `object_tags` 3，`foreign_key_check` 为空，「未分类」`sort_order` 恢复 999；后台实测需要管理员，曾临时把测试账号 `sub` 加入 `ADMIN_SUBS`，测后已从备份还原并重启
- **未提交、未推送**；未改主题、首页与既有 `/admin` 总览页

## 2026-11-12（后台权限重构：数据层 · 授权层 · 页面，ADR-019 Phase 3）

- **数据层**：新增迁移 `drizzle/0006_admin_rbac.sql` 与六张表 `users` / `roles` / `permissions` / `role_permissions` / `user_roles` / `audit_events`；`audit_events.actor_user_id` 不加外键，只留 `actor_sub` 快照，用户删除后审计仍可读。灌入 4 个系统角色、13 项权限与 27 条角色权限关联，与 ADR-019 表格逐格一致
- **引导语义**：`ADMIN_SUBS` 从「谁是管理员」降级为「没有 active owner 时的首次引导」；`mock` 模式固定 owner；owner 一旦落库，环境变量不再参与授权；全部 owner 丢失时允许重新引导。新增离线恢复通道 `npm run admin:grant -- <sub> [role]`（`scripts/admin-grant.mjs`），语义与 `grantRoleBySub` 一致并写 `user.bootstrap` 审计
- **授权入口**：新增 `src/server/authz.ts`，`requirePermission` 是唯一强制层；`adminGuard` 退化为薄包装；`Session` 增加 `userId` 与 `permissions`（`isAdmin` 仅用于导航显隐）。全部 `/api/**` 路由按权限点重挂：内容读写 / 删除 / 词表写 / 同步 / 解析 / 后台读。新增 `route-guard.test.ts` 扫描每个 `route.ts` 的每个导出方法，缺守卫直接失败；白名单只有 `/api/health` 与 `/api/logto/*`
- **审计**：新增 `audit-service.ts`（`writeAudit` / `recordDeniedAudit` / 游标分页查询）；对象删除、归档、取消归档、跨库迁移与 7 个词表写操作在同一事务里写审计，审计失败整体回滚；403 的 `denied` 记录由守卫独立写入，写失败只记服务端日志、绝不放行；`sync/run` 与 `parse/run` 两个维护动作也补上审计
- **写服务签名**：对象与词表写服务改为 `(db, actor, ...)`，没有 actor 的写入在编译期就无法通过；仓储层保留可选 actor 以兼容只读调用
- **页面**：`/admin` 改为总览（统计、最近失败、服务摘要、常用入口）；原运维三块迁到 `/admin/system`（保留 `#admin-services` / `#admin-storage` / `#admin-owners` 落点）；新增 `/admin/users`（按状态与关键字筛选、改角色、停用/启用、二次确认、`LAST_OWNER` 行内报错）、`/admin/roles`（4 × 13 只读矩阵）、`/admin/audit`（GET 表单筛选 + 游标翻页）、`/admin/objects`（跨账号只读定位，本人内容可跳工作台）。第二列目录改为按权限展开「词表 / 账号 / 运维」三组，四个模块一致；导航栏一级入口改名「系统」
- **状态与降级**：新增 `src/app/admin/loading.tsx`（骨架）与 `error.tsx`（重试）；≤900px 用户表降级为卡片，其余宽表横向滚动；空 / 加载 / 错误状态齐全
- **测试**：新增 `authz.test.ts`（52 格矩阵逐格、401/403、拒绝审计、审计失败不放行）、`audit.test.ts`（同事务回滚、denied、游标分页与筛选）、`user-service.test.ts`（引导、清空 `ADMIN_SUBS`、最后一个 owner、离线授权、目录一致性）、`route-guard.test.ts`（全路由扫描）；基线上调到 **29 个文件 351 项**，lint（0 error）/ typecheck / test 全绿
- **迁移演练与真实执行**：先在 `data/app.db` 副本上跑 0006，确认对象数不变、角色/权限/关联为 4/13/27、`foreign_key_check` 为空；再在真实库执行，`VACUUM INTO` 备份为 `data/app.db.bak-2026-11-12T04-51-44-303Z`，迁移后对象 9 / 作品 4 完全一致。真实账号 `gdv8t04dw4ca` 首次引导成为 `owner`（`user.bootstrap` 审计一条），再次以空 `ADMIN_SUBS` 登录仍是 owner，`system:read` / `user:write` / `audit:read` 守卫均放行
- **未提交、未推送**；未改主题、首页；`03_DECISIONS.md` 未改

## 2026-11-12（银河首页落地：`/` + 导航银河图标，ADR-018 / 设计稿 §4）

- **单画布星图**：新增 `src/components/galaxy-scene.tsx`，一个全屏 `<canvas>` 画完星点 / 星系 / 流星——1600 粒子（移动端 900，低配同窄屏档）、260 星点，粒子初始化预计算进 `Float32Array`，每帧只算一次全局 `cos/sin`，三张预渲染 sprite（白 / 青 / 紫）走 `drawImage` + `globalCompositeOperation = "lighter"`；`requestIdleCallback`（兜底 120ms）后才启动，首屏不等画布
- **盘面与核心**：`resize()` 时预建 disk / core 两个 `CanvasGradient`，绘制顺序为盘面椭圆 → 核心椭圆 → 粒子 → 流星；核心另有 220px CSS 呼吸辉光。首版只画粒子，实测出来是两道细弧线、不像星系，补上这两层后才达到设计稿的「盘面有实体感」（问题 67）
- **纯逻辑抽到 `src/lib/galaxy.ts`**：`resolveGalaxyQuality`（桌面 / 窄屏 / 低配 / reduced-motion 四档）、`isLowPerformanceDevice`、`effectivePixelRatio`、`buildGalaxyParticles`、`buildStarField`、`createMeteor`、`nextMeteorDelay`、`galaxyRotation`，以及首页搜索的 `buildHomeSearchHref` / `resolveHomeSearchSubmit`，全部可在 node 环境单测
- **搜索 v1**：回车走 `router.push('/search?q=' + encodeURIComponent(q))`；空白、纯空格、输入法组合中一律不跳转；`maxLength=200` 与检索页一致；不做内联结果面板。输入框故意非受控，星图初始化前输入不丢字
- **未登录**：搜索框渲染但 `disabled`，占位「登录后可检索内容」，禁用控件上叠一层透明 `button` 指向登录（禁用输入框不派发点击，问题 62）；`navItems` 传空数组，抽屉与把手不渲染，服务端会话判定，页面零 `/api/**` 请求
- **抽屉与把手**：`src/lib/nav-items.ts` 作为唯一数据源（ADR-018 第 4 条），`NavRail` 与首页抽屉都从 `navItemsFor(session.isAdmin)` 读，管理员多「系统」一项；把手是透明触控区 + `::before` 画的半透明三角，移动端触控区 44×56、视觉 22×56；焦点环用不带 `clip-path` 的 `::after` 描边，避免扩大触控区后露出 44px 方框（问题 68）
- **导航 logo**：`Icon` 增加 `galaxy` 图标与 `strokeWidth` 参数，新增 `src/components/galaxy-mark.tsx`（24px 单色描边 / 更大尺寸走渐变）；第一列最上方「三条竖杠」换成银河图标（36px 容器、hover 6°），点击回 `/`；其余导航项与 active 判断未动
- **四级降级**：① `prefers-reduced-motion` → 画一帧静态图后彻底停 rAF；② 低配（≤2 核 / ≤2GB）与窄屏 → 粒子 900、DPR 1.5、30fps、流星 1 颗；③ Canvas 2D 不可用 → CSS 星点 + 静态 SVG 旋臂星系；④ 无 `backdrop-filter` → 不透明玻璃色。每级都保证搜索与抽屉可用；`document.hidden` 停帧、回前台续帧
- **实测**（真实 Logto 会话 + 无头 Chromium，1440×900 / 390×844）：两档 `scrollWidth` 分别为 1440 / 390，无横向滚动；`__galaxyStats` 桌面 `{particles:1600, stars:260, avgFrameMs:1.41, firstFrameMs:2.3}`、移动 `{particles:900, fpsCap:30, avgFrameMs:0.97, firstFrameMs:1.3}`；搜索框回车落到 `/search?q=%E5%86%85%E5%AE%B9%20%E5%A4%8D%E7%9B%98` 并渲染结果页；抽屉开合、焦点进第一项与关闭后归还把手均正常；reduced-motion 档 `mode:"static"`、`meteorsSpawned:0`、辉光动画 `none`；canvas 降级档 `mode:"fallback"` 且星点 / SVG / 抽屉都在；匿名态 `disabled:true`、无把手、`/api/` 请求为 0；控制台零报错。截图见 `docs/screenshots/phase4-home-1440x900.png`、`phase4-home-390x844.png`（另有 reduced-motion / canvas-fallback / anonymous 三张）
- **测试**：新增 `tests/lib/galaxy.test.ts` 23 项（按 q 构造地址与编码、空值 / 组合输入 / 未登录不产生地址、四档画质与像素比夹取、旋转周期、粒子 / 星点 / 流星范围）与 `tests/lib/nav-items.test.ts` 3 项（普通账号 3 项、管理员 4 项、同一只读源）；基线上调为 **31 个文件 374 项**，lint（0 error）/ typecheck / test 全绿
- **未提交、未推送**；`/workspace` 一行未改，未动主题与 `[data-theme]`，`03_DECISIONS.md` 未改；`welcome-page.tsx` 已无引用，随首页上线删除
- **差异待拍板**：设计稿 §4.7 与需求 R5 的抽屉条目写「工作台 / 资产 / 作品 / 图谱 / 检索」，ADR-018 第 4 条要求「抽屉是导航栏镜像」。本期按 ADR 执行，没有另造第二套条目

## 2026-11-12（深空视觉主题 + Three.js 星系首页，ADR-020）

- **首页背景换代**：Canvas 2D 星图 → **three.js 0.187.0**（`@types/three` 0.187.0，唯一新增运行时依赖）。`src/lib/galaxy-three.ts` 用自定义 `ShaderMaterial` 画点精灵（additive、按距离衰减、每粒子随机相位闪烁），五层粒子——旋臂 / 核球 / 盘面雾光 / 暗尘带（正常混合，压在旋臂上刻出尘带）/ 背景星场——外加两层 billboard 辉光与一张盘面椭圆柔光；场景层级固定 `pivot → root → tilt → spin`，视差与呼吸、构图、盘面倾斜、自转各归一层
- **参数中心 `src/lib/galaxy-config.ts`**：配色取样（深空黑 #050408、核球暖白 #FFF7E6、金 #E9C08A、尘埃棕 #8A6E5A、灰紫 #7E718C、暗紫 #4A3F57）、相机（fov 34°、tilt 64°）、桌面 / 移动两套构图、亮度 1.78、视差 1.4° / 520ms、呼吸 26s ±0.32°、闪烁、尘埃透明度 0.24、两档预算（high 46300 / balanced 17560）、DPR 上限 2 / 1.5、帧率上限 60 / 30、静态图路径与尺寸。组件、着色器、CSS 不写裸数值
- **运动**：自转 90 秒 / 周（配置项，需求区间 60–120）；鼠标视差带阻尼，触屏忽略；`prefers-reduced-motion` 关闭全部动画
- **三段降级**：`webgl` → `poster` → `fallback`。WebGL 探针失败、上下文创建抛错、`?still=1`、`prefers-reduced-motion` 全部不建场景、零 rAF；静态图加载失败由 CSS 星点 + 暖金星云兜底
- **静态图自己出**：新增 `/galaxy/poster` 渲染舞台与 `scripts/phase5-capture.mjs poster`，无头 Chrome 以 1920×1080 / 1170×2532 渲染同一套场景后截帧转 JPG——`public/galaxy/galaxy-1920x1080.jpg`（177KB）、`galaxy-1170x2532.jpg`（125KB），均 ≤400KB、无文字水印。**未使用参考图**（`docs/reference/galaxy-reference.png` 右下有第三方水印）
- **全局主题重写 `:root`**：三档文字、五级表面（`--void-deep` → `--surface-3`）、描边 / hover、间距补档 `--sp-14/16/20`、深色阴影、`--focus` 暖金；`html { color-scheme: dark }`；`body` 改为固定渐变——一层星点 + 一层极淡暖金 / 灰紫光晕，作为全站统一底。品牌绿整套换暖金，`--green-*` 保留为金阶别名（映射表见 ADR-020），避免 107 处引用一次性全改
- **`[data-surface="cosmic"]` 重建**：青紫霓虹 → 暖金 / 尘埃棕 / 灰紫；删除旧的星云光斑与核心辉光两层 DOM（体积光改由 WebGL 承担），只留 `poster / canvas / fallback-stars` 三层
- **子页面统一深空**：导航栏、目录、记录列表、详情、编辑器、检索、图谱、后台、登录全部改深色；逐处修掉硬编码浅色——品牌徽标、主按钮文字、危险按钮、骨架屏、滚动条、遮罩、提示条、标签描边、作品进程圆点等；焦点环统一暖金，hover 只改描边 / 底色 / 阴影
- **可访问性**：正文级文字 ≥4.5:1、大字号与图标 ≥3:1；新增 `scripts/check-contrast.mjs`（`npm run check:contrast`）直接从 `:root` 取值计算 28 组配对，全部通过。据此把危险按钮 hover 从 `#bd533d` 调深到 `#b54a35`（白字 4.32:1 → 4.83:1），并把 `:root` 注释里过期的对比度数字改成实测值
- **截图中发现并修掉的两处布局问题**：① 工作台「作品进程」轨道原为 4 列 `min-width: 680px`，在 ~430px 卡片里被横向裁切 → 改 2×2 网格并重画连接线；② 移动端星系核心被搜索框压住 → `centerY` 0.38 → 0.44，并重出两张静态图
- **首页搜索提示不可读**：提示文案压在星系核心上几乎看不见 → 给搜索组加暗色径向暗角、提示文字改用主文字色 + 深色文字阴影（只动视觉，搜索 / 抽屉 / 登录逻辑未改）
- **实测读数**（`node scripts/phase5-capture.mjs probe`，无头 Chrome + SwiftShader）：桌面 1440×900 首帧 29.9ms / 平均 1.36ms/帧 / 46300 粒子 / DPR 1；移动 390×844 首帧 18.9ms / 平均 0.99ms/帧 / 17560 粒子 / DPR 1.5；两档 `scrollWidth == innerWidth`，无横向滚动、无滚动条；`prefers-reduced-motion` 下 `mode=poster`、`rafCalls=0`；切走标签页 700ms 内帧数 51 → 51、`rafActive=false`、`paused=true`；禁用 WebGL 时 `mode=fallback`、1920×1080 静态图可见、canvas 透明度 0
- **截图**：`docs/screenshots/phase5-*` 共 15 张——首页（桌面 / 移动）、首页静态降级、禁用 WebGL、抽屉、登录、工作台（桌面 / 移动）、详情、编辑器、检索（桌面 / 移动）、图谱（桌面 / 移动）、后台；全部页面零 console 错误，移动端无横向溢出
- **测试**：`tests/lib/galaxy.test.ts` 随 3D 实现重写（23 → 38 项），修正三处仍按旧粒子预算与旧移动构图写的断言；全量 **31 个文件 392 项全绿**；`npm run lint` 0 error（16 条既有未使用变量警告）、`npm run typecheck` 通过。`eslint.config.mjs` 增加 `.next-mock/**` 忽略，避免验收实例的构建产物被当成源码扫描
- **未提交、未推送**；未改业务逻辑、未改数据库、未碰真实库数据；开发服务器 3000 保持可用。验收用的第二个实例（`AUTH_MODE=mock`，3101，`NEXT_DIST_DIR=.next-mock`，DB 为副本）用完即停

## 2026-11-12（Phase 5b 返工：四套主题、首页构图下移偏左、星系翻面）

- **用户问题**：首页星系「太高」、搜索框偏下；主题切换入口消失、之前的浅色主题被删。本轮要恢复主题系统并把星系下移、偏左，最后按用户看截图后的追加要求翻到背面观看。
- **四套主题**：`galaxy`（深空银河，默认）/ `pine`（Phase 5 前浅色，颜色逐项取 `git show HEAD:src/app/globals.css` 原值）/ `sand`（暖沙，设计稿 §3.2）/ `midnight`（午夜蓝，设计稿 §3.2）。`<html data-theme>` + `:root` 兜底 galaxy；三个覆盖块只改语义层与旧别名，各自带 `color-scheme`
- **切换与持久化**：新增 `src/lib/theme.ts`、`src/components/theme-switcher.tsx`；`layout.tsx` 的 `<head>` 内联脚本在首帧前读 `localStorage["pakp.theme"]`，无脚本 / 非法值回落 galaxy。入口为侧栏底部头像与首页右上角头像；面板 2×2 网格（4 个 8px 色点 + 名称 + 勾选），移动端底部纵向抽屉。键盘 Tab 循环 / 方向键即时切换 / Enter / Esc 关闭归还焦点 / 点击外部关闭
- **逐页去写死深色**：约 30 处裸色值改为 token；新增 `text-on-dark*`、`rail-active-fg`、`accent-hover`、`accent-contrast` 等语义令牌。`scripts/check-contrast.mjs` 改为逐主题解析，23 组配对在四主题下均通过
- **首页构图**：桌面 `centerX 0.39`、`centerY 0.62`；移动 `centerX 0.42`、`centerY 0.60`；`fill / rollDeg` 未动。搜索组 `top: 32vh`（移动 `32dvh`），搜索框中心实测 43.8% / 43.4%，在星系上缘之上
- **翻面观看**：新增 `GALAXY_CONFIG.facingDeg = 180`，层级改为 `pivot → root → facing → tilt → spin`；旋臂、核球、薄雾、尘带一起左右镜像、缠绕方向反转、盘面倾角镜像，`spinSign` 让自转看起来仍是同一转向；poster 与 WebGL 共用
- **更密的六臂**：2 主臂 + 4 次臂（每 60°），主臂占 57% 粒子；`SPIRAL_TURNS 0.62 → 0.58`，补 52% 贴臂薄雾与更亮盘光。预算 high 合计 **58600**（34000 / 9000 / 6000 / 8500 / 1100），balanced 合计 **23660**（14000 / 3600 / 2400 / 3200 / 460）；`window.__galaxyStats` 口径未变
- **poster 重出**：`public/galaxy/galaxy-1920x1080.jpg` 201KB、`galaxy-1170x2532.jpg` 154KB
- **实测**：11 项主题回归全过；桌面核球质心 `webgl 38.9/62.1`、`reduced-motion 37.6/62.0`、`no-webgl 37.6/62.0`；移动 `42.0/59.9`、`41.9/59.9`、`41.9/59.9`；无横向溢出、顶栏不重叠、提示在视口内、控制台零报错。主题切换 10 项全过，含不刷新、滚动 115 保持、刷新保持、强刷 10 次首帧均为 pine、首页不随工作台主题变色
- **截图**：`docs/screenshots/phase5b-*` 共 30 张——首页新构图（桌面 / 移动）、首页静态降级、抽屉、登录；工作台 / 详情 / 检索 / 图谱 / 后台的 galaxy 与 pine，编辑器补 galaxy 一张；sand、midnight 工作台；主题菜单侧栏 / 首页 / 移动抽屉
- **测试与质量门**：新增 `tests/lib/theme.test.ts` 10 项，`galaxy.test.ts` 补观察面断言并修正旧 centerY 方向断言；**392 → 403 项**、32 个文件全绿；lint 0 error（16 条既有 warning）、typecheck 通过、四主题对比度全过
- **未提交、未推送**；未动业务逻辑与数据库，`03_DECISIONS.md` 未改（留给 Architect 补 ADR）；开发服务 3000 保持可用；截图用的 `AUTH_MODE=mock` 验收实例为 3101，数据库为副本

## 2026-11-12（ADR-021 契约对表：token 三层 129 名 · check-theme 规范）

- **起因**：Phase 5b 落地后，`globals.css` 的四个主题块与 ADR-021 第 5 条正面冲突——ADR 写「契约冻结 85 名、不再引入 `--bg` / `--accent*`、ADR-017 语义层作废」，实现里 `--bg` 与 `--accent*` 共 11 个名字已定义且被引用 89 处
- **裁定：选「承认语义层属于主题契约」**（不是回退改名）。四条依据：① 四主题里 `--accent*` 与 `--gold-*` 并非同色异名——sand 的 `--accent-text` 比 `--accent` 深一档，midnight 的填充 / 文字 / hover 三档分离（#2563eb / #7cb6ff / #1d4ed8），合并会抹掉三组对比度关系；② 依赖方向与旧结论相反，实现里 `--green-600: var(--accent-text)`，`--accent*` 才是值源；③ 回退要动 4 块 × 11 声明 + 89 处引用，收益为零；④ `13_DESIGN_V3.md` §3.3 本来就把这批名字列为「语义层（新增）」，分叉的是旧 ADR 文本
- **契约数字更正**：实测 `:root` 基础层 31（几何）+ 四主题块各 98（集合完全相等）= **129 名**。旧文本的「85 = 54 主题 + 31 几何」「35 共有 + 19 新增」是人工统计漏计（`--ok-bg: …; --ok-fg: …` 一行两声明只算一个，且漏计把规则区字面量提成 token 的那批）；`--sidebar` 也未删，保留为别名
- **新增统一口径**：L1 几何只在 `:root`、L2 主题语义四块全量、L3 兼容别名只 `var()` 回指；`--green-*`（152 处引用）/ `--gold-*`（9 处）冻结不再新增；**唯一真相源规则**——四主题下取值恒等的两个名字只允许出现在登记表（当前仅 `--surface-1 ≡ --white`、`--on-gold ≡ --accent-contrast` 两组）
- **`scripts/check-theme.mjs` 规范**：8 条硬失败（缺块 / 集合不等 / 空值 / 层位错误 / 别名悬空 / 重复表达 / 字面量基线 / TS 侧零色值）、退出码 0-1-2 分级、`npm run check:theme` 命名、接入 `07_PLAYBOOK` §5.1 提交前清单。**脚本本身仍未创建**
- **顺带纠正的文档漂移**：`--page-backdrop` → 实际的 `--app-bg-color/image/repeat/size` 四 token；`check:contrast` 实为 4 × 23 = 92 组（原文 4 × 28）；`theme-menu.tsx` / `themes.ts` → 实际的 `theme-switcher.tsx` / `theme.ts`；ADR-022 与图谱小节里对「85 名契约」的引用同步改为 129 名
- **登记未完成项（不在本轮改代码）**：① `check-theme.mjs` 未创建；② `THEME_BOOTSTRAP` 未做旧键 `theme` → `pakp.theme` 迁移；③ `THEME_META.swatch` 在 TS 里硬编码 16 个色值，违反第 9 条「色点只来自 CSS」（规范 E8 会把它断言为零，需移到 `.theme-swatch[data-theme-id]`）
- 只改 `docs/03_DECISIONS.md` 与 `docs/05_CHANGELOG.md`；未动代码、未提交

## 2026-11-12（Phase 5c 构图微调：星系放大、上移、向水平中心收 20%，边缘柔化）

- **起因**：使用者回看首页截图，反馈星河「又偏下了」，要求再放大、并往水平居中位置调 20%。只动构图参数与产物，不动几何、粒子预算与朝向
- **构图（`src/lib/galaxy-config.ts`）**：桌面 `centerX 0.39 → 0.412`（0.39 + 0.2 × 0.11）、`centerY 0.62 → 0.55`、`fill 0.42 → 0.50`；移动 `centerX 0.42 → 0.436`、`centerY 0.60 → 0.55`、`fill 0.50 → 0.56`。`rollDeg -14 / -22`、`facingDeg 180`、六条臂与两档粒子预算全部未动
- **边缘柔化**：直径 100%（桌面）/ 112%（移动）视口宽后，旋臂外缘必然越界。`globals.css` 的 `.galaxy-scene` 三层（静态图 / canvas / CSS 星点）统一加 `clamp(36px, 6vw, 88px)` 四边遮罩，让旋臂在贴边处淡出；三层同一份遮罩，任何降级路径边缘一致
- **静态图重出**：`galaxy-1920x1080.jpg` **214KB**、`galaxy-1170x2532.jpg` **178KB**（均 ≤400KB）
- **三路径位置一致（实测 `measure`）**：桌面 1440×900 核球亮度质心 `webgl 41.1%, 57.6%` / `reduced-motion 39.9%, 57.6%` / `no-webgl 39.9%, 57.7%`，最大偏差 **1.2 个百分点**（x）、0.1（y）；移动 390×844 `43.9%, 56.2%` / `43.6%, 55.8%` / `43.6%, 55.8%`，最大偏差 0.4。两档均无横向溢出、搜索组不与顶栏重叠、控制台零报错
- **亮核与搜索框的间距（像素实测）**：搜索框底边 426px / 900（47.3%）、394px / 844（46.7%）；亮核（92% 峰值阈值）上沿 496px（55.1%）/ 463px（54.9%），**净空 70px / 69px**。75% 阈值下的亮斑外沿 52.9% / 53.5%，也仍在搜索框下沿之下
- **边缘实测**：桌面左缘逐列均值 5.7 → 13.8（40px 内单调上升）、下缘 6.5 → 16.2、上缘 6.4 → 16.5，均为柔化带内的衰减，没有亮度台阶
- **测试**：`tests/lib/galaxy.test.ts` 更新三处位置断言（0.412 / 0.436 / 0.55），改「竖屏 centerY 更靠上」为「两档一致」，新增 2 项——星盘直径与 fill 的关系、亮核上沿与搜索框下沿的间距；基线 **403 → 405 项**，32 个文件全绿
- **工具**：`scripts/phase5-capture.mjs` 新增 `home` 命令，只拍首页桌面 / 移动 / 禁用 WebGL 三张（前缀 `SHOT_PREFIX`，默认 `phase5c`）
- **截图**：`docs/screenshots/phase5c-home-galaxy-desktop.png`、`phase5c-home-galaxy-mobile.png`、`phase5c-home-static-galaxy-desktop.png`
- 未提交、未推送；`03_DECISIONS.md` 未动（ADR-021 由 Architect 维护）

## 2026-11-12（ADR-023 / ADR-024：分类词表统一与检索模糊查询）

- **起因**：使用者第 5 轮反馈四条——编辑时分类 / 标签应为「左侧选已有 + 右侧自定义」、系统页「管理形态」与编辑「分类」必须同名、新建弹窗缺分类区、首页搜索至少要支持模糊查询并参考旧项目顶栏搜索
- **ADR-023**：废止「作品形态 / 自由文本分类」双轨，`work_formats` 升级为 `categories`（新增 `normalized` 唯一键），`objects.format` → `objects.category_code`，自由文本值折叠进同一词表（主值入分类、其余转标签，保证不丢数据）；分类单选（作品必填、资产可空）、标签多选；给出迁移 SQL 骨架、验证查询、留档表与回滚路径；命名矩阵覆盖 33 处代码 / 路由 / 权限 / API / 文档；内联创建向 `object:write` 开放，并收紧「保存时静默建标签」
- **ADR-024**：词法层用 SQLite `instr` 子串匹配（标题 / 描述 / 分类 / 标签），新增 `title_norm` / `description_norm` 影子列，支持字段前缀 / 引号短语 / `-` 排除，明确不支持 `OR` / 括号 / `~`；对象级六级权重排序与去重；与 RAGFlow 语义并行混合、3s 超时降级、`threshold` 只作用于语义；`/api/search` 增量扩展 `mode` / `lexical` / `semantic` 状态；首页 200ms 防抖预览 8 条、IME 与键盘完整
- **实测基线**：`npm test` 32 文件 / 405 项全绿；`data/app.db` 3 个对象（2 作品 `article`、1 资产）、自由分类仅 1 值「学习」、标签 0
- 只改 `docs/03_DECISIONS.md` 与 `docs/05_CHANGELOG.md`；未动 `src/`、未提交

## 2026-11-13（Phase 6A：ADR-023 分类统一落地）

- **数据层**：`drizzle/0007_categories.sql` 用重整表迁移把 `work_formats` 升级为 `categories`、`objects.format` → `category_code` 外键；自由文本分类折叠进同一词表（主值入分类、其余转标签），旧值留档在 `objects_category_legacy_backup`；权限键改名 `vocabulary:category:write`，owner / admin 授权保留。`PRAGMA foreign_keys = OFF` 放在事务外（事务内是空操作，否则重建 `objects` 直接失败）
- **迁移演练**：新增 `scripts/rehearse-categories-migration.mjs`，`VACUUM INTO` 备份 → 临时副本 → `migrate()` 连跑两遍 → 核对对象数 / 作品无空分类 / 无失联 code / `normalized` 唯一 / 自由值有归宿 / 旧 format 全在词表 / 留档行数 / 外键自检 / 权限键与授权。`app.db`、`dev.db` 均 `ok: true`
- **真实库**：先停开发服务再迁移。`app.db`：对象 5（2 作品 `article`、3 资产空分类）不变，分类 7，标签 1 → 2（「学习」转标签），外键自检为空；`dev.db`：对象 3（2 作品 `course`、1 资产）不变，分类 7。备份 `data/backups/2026-11-12T16-01-11/{app.db,dev.db}` 与同名 `.report.json`
- **界面**：分类改单选选择器（过滤 + 固定「＋ 自定义」），标签多选；自定义小弹窗复用词表接口，分类同名启用项复用、停用项 409 `CATEGORY_ARCHIVED` 不复活；新建弹窗补上分类区，与编辑弹窗同为「类型 → 标题 → 分类 → 标签 → 放在哪里 → 说明」。分类选择规则抽到 `src/components/vocabulary-selection.ts` 并单测
- **修掉的 bug**：自定义小弹窗原先渲染成 `<form>` 嵌在新建弹窗的 `<form>` 里，React 报 hydration 错误、回车会误提交外层表单；改为 `div[role=group]` + 手动回车提交
- **命名**：界面 / API / 权限 / 路由统一为「分类」；`/api/vocabulary/formats*`、`/admin/vocabulary/formats` 只做 308 跳转；管理页标题改「管理分类」；`作品形态 / 管理形态 / 新增形态 / 形态列表` 在仓库内清零（ADR 与历史日志除外）
- **测试**：新增 `tests/components/vocabulary-selection.test.ts`、`tests/server/category-consistency.test.ts`；重写迁移与服务层用例；`npm test` **34 文件 / 420 项全绿**，`typecheck` 通过，`lint` 0 error（既有 warning 保留）
- **截图**：`docs/screenshots/phase6a-*` 7 张（新建桌面 / 移动、分类与标签自定义、编辑、分类管理页、详情），零 console 错误、移动端无横向溢出；脚本 `scripts/phase6a-capture.mjs`
- **未做 / 未验证**：首页搜索模糊查询（ADR-024）留到下一轮；真实 Logto 账号下的新建 / 编辑全流程未复测（截图为 mock 身份实例）；未提交、未推送

## 2026-11-13（Phase 6B：ADR-024 检索模糊查询与语义混合）

- **起因**：使用者第 4 条反馈——首页搜索至少要支持模糊查询，参考旧项目顶栏搜索再优化。ADR-024 已定稿，本轮按原文全部实施；`03_DECISIONS.md` 未改
- **影子列与归一化**：`drizzle/0008_search_norm.sql` 给 `objects` 加 `title_norm` / `description_norm` 与 `objects_owner_scope_idx`；NFKC → 空白折叠 → trim → 小写只由一个 `normalizeSearchText` 负责，写路径、`backfillSearchNorm`、SQL 参数、内存打分完全同源，SQLite 侧不做 NFKC。原因：CJK 没有空格分词，FTS5 的 trigram 分词器又要求 ≥3 字，两字中文查不到，所以用 `instr()` 子串匹配 + 影子列
- **迁移**：`scripts/rehearse-search-migration.mjs` 先 `VACUUM INTO` 备份再在副本上演练 0008 + 回填，核对对象数、两列、索引、空值、`description` 一致性、外键、抽样归一化；两份真实库（`app.db`、`dev.db`）演练通过后才执行，各自留 `.bak-<时间戳>` 备份，迁移后 `missing = 0`、外键自检为空
- **语法与排序**：空格 AND / `AND`、`"短语"`、`title:` `desc:` `category:` `tag:` 与中文同义前缀、`-` 与 `NOT` 排除；`OR` / 括号 → 400 `QUERY_SYNTAX` + `details.position`；`~` 按字面量并提示一次；未知 `x:` 当普通文本；未闭合引号报位置；不足 2 字回空结果 + 提示。六级权重（100 / 80(+10 前缀) / 70 / 65 / 50 / 20），对象级去重，最多 500 条并给 `truncated`
- **`/api/search`**：新增 `mode=lexical|semantic|hybrid`；hybrid 词法与 RAGFlow 并行，语义 3 秒硬截止，超时只回词法并标 `semantic.status=timeout`（页面中性提示，不报错）；`threshold` 只影响语义；`total` 改为去重后的对象数；响应增量加 `source` / `score` / `matchedFields` / `chunkCount` / `highlightTerms`，旧键保留可空读，`mode=semantic` 的旧输出顺序不变
- **首页内联预览**：新增 `src/lib/search-preview.ts`（纯函数：可否请求、防抖器、请求令牌、键盘下标、响应清洗）与 `src/hooks/use-search-preview.ts`；≥2 字、200ms 防抖、`AbortController` + 序号丢弃、IME 合成期不请求、只打 `mode=lexical&limit=8`；下拉显示高亮 / 分类 / 标签 / 来源与「共 N 条 · ↑↓ 选择 · 回车查看全部」，`aria-combobox` 语义完整，点击外部关闭，登出禁用，移动端整宽且不盖输入框
- **`/search` 页**：对象级单一列表 + 来源徽标；语法错误在输入框下方显示原文、金色位置箭头与「第 N 个字符附近」，服务端前置解析因此不发请求；阈值标签写明「仅影响语义结果」；语义不可用给中性提示；截断时提示收窄范围。修掉一处布局问题：错误块原先挤在 flex 查询字段里被压窄，改为 `flex: 1 0 100%` 整行
- **压测（`PERF=1`，1 万对象）**：写入 2236ms；词法 p95 11.51 / 6.74 / 12.12 / 7.17 / 8.26 ms（≤60），预览 8 条 p95 4.71 / 3.83 / 6.14 / 4.04 / 3.63 ms（≤30）；候选查询走 `objects_owner_scope_idx`；语义挂起实测 3020ms 降级、词法 10 条按时返回
- **测试**：新增 `tests/lib/search-query.test.ts`、`tests/lib/search-preview.test.ts`、`tests/server/lexical-search.test.ts`、`tests/perf/search-bench.test.ts`，重写 `tests/server/search-service.test.ts`，扩展 `tests/lib/search-params.test.ts`；`npm test` **37 文件 484 项全绿**（另有 3 项基准默认跳过），`typecheck` 通过，`lint` 0 error（15 条既有 warning）
- **截图**：`docs/screenshots/phase6b-*` 5 张（首页下拉桌面 / 390×844、无结果、语法错误、`/search` 结果），零 console / page 错误、无横向溢出；脚本 `scripts/phase6b-capture.mjs`
- **未验证 / 遗留**：截图在 mock 身份实例上完成；移动端只验证渲染，未实测触摸与软键盘；RAGFlow 侧只用假网关与挂起网关验证；`instr` 全表扫描在 10 万级前要重新评估。未提交、未推送，开发服务 3000 已恢复为 `AUTH_MODE=logto` 指向 `data/app.db`

## 2026-11-13（Phase 6C：ADR-021 三处尾巴清零）

- **起因**：ADR-021 收尾时登记了三件未完成项——`check-theme.mjs` 未创建、色板 16 个 hex 硬编码在 `theme.ts`、`THEME_BOOTSTRAP` 未做旧键迁移。本轮全部落地；ADR 原文的 E1–E8 编号与含义为准，规则未增删，`03_DECISIONS.md` 未改，未提交、未推送
- **`scripts/check-theme.mjs`**：按 E1–E8 实现缺块 / 集合不等 / 空值 / 层位错误 / 别名悬空 / 重复表达 / 字面量基线 / TS 零色值八条硬失败，外加自写的块解析（`@media` 等嵌套规则按选择器展开、一行多声明可切）。失败信息带主题、token 与 E 编号，退出码 0 成功 / 1 违规 / 2 用法或读文件错误；被 import 时不自动执行。`package.json` 增 `check:theme`，`verify` 改为 `check:theme → check:contrast → typecheck`。真实 `globals.css` 输出：四块各 `98 tokens PASS`，汇总 `129 名（31 几何 + 98 主题）· 4 块集合一致 · 0 失败 · 字面量 26`
- **基线口径差异（已核实，不改 ADR）**：ADR 写 `BASELINE = 20`，实测迁移前 28。多出的 8 个是 Phase 5c 边缘柔化给 `.galaxy-scene*` 三层遮罩加的 `#000`（ADR 写于柔化之前）；本轮又清掉 2 个，脚本常量取 `26 = 20 + 8 − 2`，算式写进常量注释。是否回写 ADR 由 Architect 决定
- **色板去 hex**：删掉 `THEME_META.swatch`（4 主题 × 4 色点的 16 个 hex），`ThemeMeta` 只剩 `id / name / hint`；`theme-switcher.tsx` 的色点容器加 `data-theme={item.id}`，四个圆点读 `var(--bg)` / `var(--surface)` / `var(--accent)` / `var(--text-1)`。跨主题预览靠 `[data-theme]` 作用域而非第二套常量。顺带两处：圆点边框改 `color-mix(in srgb, var(--text-3) 45%, transparent)`，窄屏弹层遮罩改 `color-mix(in srgb, var(--dialog-backdrop) 42%, transparent)`
- **视觉零变化的证据**：`scripts/phase6c-capture.mjs`（CDP，不引 puppeteer）逐主题打开头像菜单，读 16 个圆点的计算色与迁移前 hex 逐一比对，全部相等；截图 `docs/screenshots/theme-swatches-{galaxy,pine,sand,midnight}.png` 及 `-panel.png` 四张菜单特写，零 console / page 错误
- **旧主题键迁移（事实先行）**：`git rev-list --all` 共 39 个提交，`git grep localStorage <每个提交> -- 'src/*'` 全空，`theme.ts` 与首帧脚本都是本轮新增文件——即旧键 `theme` 在这份代码库里**从未被写入过**，没有真实数据要迁移。仍按 ADR-021 第 10 条实现防御式兼容：`pakp.theme` → 旧键 `theme` → 默认 `galaxy`；旧键仅在「新键缺席且值合法」时采用，采用后立刻回写新键并删除旧键；两键并存时新键优先（新键非法也不回退旧键），旧键一律删除。`resolveStoredTheme` 与内联脚本同一口径，切换器仍只写新键
- **测试**：新增 `tests/scripts/check-theme.test.ts` 15 项（内联 CSS 夹具覆盖 E1–E8 与解析边界，不读真实文件）与 `tests/lib/theme.test.ts` 的 8 项（旧键四组合 + 两个非法分支 + 口径一致性 + 脚本常量）；`npm test` **38 文件 507 项通过**（3 项基准默认跳过），`typecheck` 通过，`lint` 0 error（15 条既有 warning），`check:contrast` 23/23
- **未做 / 未验证**：`src/**` 里剩余的 hex 全在 `galaxy-config.ts` / `galaxy-three.ts` / `galaxy-mark.tsx` 的宇宙与 WebGL 兜底色，属 E8 范围外，按「本轮不动图谱」的约定保留；截图为 mock 身份实例，真实 Logto 会话下未复测；旧键迁移按「无需迁移 + 防御兼容」记录，不写成「已完成数据迁移」

## 2026-11-13（ADR-021 字面量基线回写 + ADR-022 附录 v1.2）

- **起因**：Phase 6C 收尾时留了两件待裁决的事——ADR-021 写 `BASELINE = 20`，脚本实测 26；ADR-022 开工前审查指出三处冻结接口缺口（性能读数没有回路、世界半径没有归属、边压暗没有单一来源）。本轮只改文档，未动代码、未提交
- **ADR-021 · E7 基线 20 → 26**：核对 `scripts/check-theme.mjs` 常量与 `globals.css` 实测，`26 = 18 处真实颜色 + 8 处遮罩停靠点`。8 处是 Phase 5c 给 `.galaxy-scene > .galaxy-poster / .galaxy-canvas / .galaxy-fallback-stars` 加的四周羽化遮罩（`globals.css:5330-5337`，`mask-image` 与 `-webkit-mask-image` 各 4 个 `#000`），**只取 alpha 通道、不是配色**，因此明文禁止改成主题令牌；另 2 处由 Phase 6C 的 `color-mix` 清掉（`.theme-option-dots i` 描边、`.theme-switch-layer` 窄屏遮罩）。旁证：迁移前实测 28 = 20 + 8，与 ADR 初版互相印证。同步改了 §4 关系表、验收 10 与风险 B11
- **ADR-021 · 已落地项回写**：状态行、第 9 条（`THEME_META.swatch` 去色值）、第 10 条（旧键兼容）、E8（`theme.ts` 零 `#hex`）由「未实现」改为「已实现」，并注明旧键在 39 个提交里从未被写入、属防御式兼容而非数据迁移；B11 关闭
- **ADR-022 · 附录 A 升 v1.2**：A7 加 `onStats`（每 30 帧发布，B 测量、A 决定档位，`tier` 仍只读传入）；A3.1 冻结 `SIZE_WORLD_RADIUS`（`s/m/l/xl → 1.9/2.5/3.3/4.4`，布局算、渲染读，2D 的 `clamp(5 + 3.1 × √degree)` 不合并）；A4 的 `GraphHighlight` 加必填 `dimmedEdges`；A6 补该用例并把计数改为「冻结当天现测」
- **ADR-022 · 正文三处回写**：§4 节点/边字段按 A2 对齐（无 `radius`、`colorToken` 而非 `colorVar`、边无 `relation`）；§6 边 draw call 由「1–2」改为 3 组（合计正好 8，零余量）；§14 改为新增 6 个测试文件，基线以冻结当天 `npm test` 为准（2026-11-13 现测 38 文件 / 507 项）
- **未做 / 未验证**：未改任何代码；`npm run check:theme` 只读 `globals.css` 与 `theme.ts`，结果不受本轮影响；ADR-022 两线仍未开工，`onStats` 与 `dimmedEdges` 尚无实现可对接

## 2026-11-13（Phase 6D-1：图谱冻结件与 maxNodes 契约）

- **起因**：ADR-022 附录 A 升到 v1.2 后，A 线按分线表先落三个冻结件，`npm test` 绿后接口冻结，再开 2D / 3D 两条线。本轮只做冻结件与数据契约：`globals.css`、`graph-explorer.tsx`、`/graph` 的视觉与交互未动；未提交、未推送，`03_DECISIONS.md` 未改
- **`src/lib/graph-model.ts`**：`buildGraphViewModel` 把 LightRAG 子图 → 无坐标的 `GraphViewModel`。类型映射（六类 + 未知落 other，NFKC + 小写关键词）、关系名派生（`<SEP>` 段首词 → 首行 12 字 → 「相关」）、度数（去重后的边两端计数）、BFS hop（中心 0、不可达 3）、`size` 四档、`shortLabel` 中心 12 / 其余 10 按码点截断、同 id 去重、自环 / 悬空边只计数、平行边合并成 `weight`、边 id 用 U+0001 连接、固定排序
- **`src/lib/graph-quality.ts`**：`selectGraphMode`（webgl × reduced-motion × 移动 × 节点数 × URL → 3d / 2d / list）与三档预算（150/300/12/1 · 300/600/24/1.5 · 600/1200/40/2），只降不升；`resolveGraphDpr` 夹 DPR；`decimate` 保留中心 / keepIds / 全部 1 跳，余额按度数补齐 2 跳
- **`src/lib/graph-selectors.ts`**：`selectGraphHighlight` 只算一次邻域与补集，`GraphHighlight` 带必填 `dimmedEdges`；`findShortestPath` 走 BFS；选中不进模型
- **`maxNodes` 契约**：`GET /api/graph` 新增可选 `maxNodes`（50–600、默认 150），校验只在 `resolveGraphMaxNodes()` 一处，路由传原始串；`/graph` SSR 预取显式带默认值，避免首屏与客户端两个规模。截断按 `received >= requestMaxNodes` 单向推断
- **与 ADR 附录的三处对齐差异**：`GraphNode.hop` 单列 `GraphNodeHop`（0–3，BFS 中心为 0）；`GraphBuildInput` 增可选 `statusFailed`（`status: null` 无法区分「失败」与「未请求」）；`selectGraphMode` 的 `tier` 由函数内部算，不接 §10 的 `tier` 入参
- **测试**：新增 `tests/lib/graph-model.test.ts`（31）、`graph-contract.test.ts`（12）、`graph-quality.test.ts`（23）、`graph-selectors.test.ts`（14）；`npm test` **42 文件 587 项通过**（另 3 项基准跳过），`typecheck` 通过，`lint` 0 error（14 条 warning）
- **未做 / 未验证**：2D / 3D 渲染器、`layoutGalaxy3d`、graph token 块、`error.tsx`、fiber 依赖、`__graphStats` 均未开始；新契约只经单测，未在真实 LightRAG 上验证 `?maxNodes=`；本轮不改界面，未做浏览器复看

## 2026-11-13（Phase 6D-2：图谱 2D 聚焦阅读 + 3D 布局 + 验收截图）

- **起因**：6D-1 冻结了 `GraphViewModel` / `GraphHighlight` / `selectGraphMode` 三个契约后，本轮把它们接成可用界面：2D SVG 舞台、3D 星系布局（渲染仍为桩）、容器与 URL 契约、无障碍、验收截图脚本。收尾时按 Architect 审查意见做了一轮最小修复（六条阻断项 + 风险项），没有顺手重构；`03_DECISIONS.md` 未改，未提交、未推送
- **2D 布局 `src/lib/graph-layout-2d.ts`**：力导布局（中心固定圆心、1/2 跳按环种点、锚点 pinned 后夹进 padding）、`placeLabels` 标签避让；`layoutTicksForNodeCount` 按规模给 tick 预算（300 / 180 / 120 / 60），600 节点实测约 350ms；`anchorsForSize` 在画布尺寸变化时丢弃旧锚点
- **2D 舞台 `src/components/graph/graph-stage-2d.tsx`**：纯 SVG，只消费 view + highlight；单击选中 / 双击聚焦 / 拖拽平移 / 滚轮与双指缩放 / Shift+单击选路径；键盘 Tab 进入、方向键空间移动、Enter 选中、F·Space 聚焦、Esc 取消、+ − 0 缩放与适配；首帧尺寸用 `null` 表示，等第一个 ResizeObserver 再排；相机按 `focusId` 键控，换中心自动回默认取景
- **3D 线 `src/lib/graph-layout-3d.ts` + `graph-scene-3d.tsx`**：星系布局（盘面半径、旋臂、不可达环、`SIZE_WORLD_RADIUS`、可暂停的 `layoutGalaxy3dControlled`）与 33 项单测；渲染仍是桩，不 import three / fiber，B 线整体替换
- **容器 `src/components/graph-explorer.tsx`**：URL 契约 `mode` / `focus` / `depth`；模式与档位只问 `selectGraphMode`；新增 `loadedCenter`（标题 / 舞台 / 模型一律用「已画出来的那张图」的中心）；`graphLoading && subgraph` 时舞台上浮「正在载入 X 的邻域…」；换中心失败只出横幅保留旧图；列表模式、检查器、路径条；空态三分（状态读不到 / 图谱为空 / 未抽取到实体）；截断文案「可能只显示了最近 N 个」；`src/app/graph/error.tsx` 路由级错误页
- **六条阻断项修法**：① 删除 `FALLBACK_SIZE`，首帧不出图等 ResizeObserver，尺寸换档清锚点重排（760→390 回归：旧锚点 >50% 贴边，重排后 0 个）；② 换中心用 `loadedCenter` 渲染并加加载浮层，失败不把新中心配旧图（验收断言 URL 已切、标题与节点数不变、无残留浮层）；③ `urlMode` 传原值，no-webgl / reduced-motion / mobile / 超大图分支恢复可达，只在 `3d && !THREE_D_READY && reason !== "url-3d"` 回落一次；④ 自动旋转默认 `false`，工具条开关带 `aria-pressed`，reduced-motion 下不渲染；⑤ `three` / `@types/three` 锁 `0.187.0`、`react` / `react-dom` 锁 `19.3.1`、装 `@react-three/fiber@9.8.2`（peer `react >=19 <19.4`），fiber 只装不用；⑥ 2D 路径边只消费 `highlight.edges`、`graph-selectors` 注释与 hover 压暗行为对齐、`status === null` 单独出「状态读不到」、相机随中心重置、aria 改「按 3」、reduced-motion 关路径动画、2D 边对比度按 3:1 单列校验（3D 背景细边标为装饰纹理）
- **样式**：`[data-mode="2d"]` 覆盖组（画布 `#06050a`、普通边 42%、强边 62%）、`.graph-stage-loading` 浮层、`prefers-reduced-motion` 关 `.g2-edge.is-path` 动画
- **验收脚本 `scripts/phase6d-capture.mjs`**：临时库 + mock LightRAG（empty / full / graph-error / status-error / center-error）+ `AUTH_MODE=mock` dev（3123）+ 无头 Chrome（CDP）；`PHASE6D_STEPS=` 可只跑指定步骤；断言覆盖渲染规模、选择 / 路径 / 键盘、自动旋转、reduced-motion、换中心失败、列表、760→390 换档、3D 桩、孤立点、加载失败、状态读不到以及溢出与三类控制台 / 网络错误。截图 `phase6d-2d-{desktop,empty,list,mobile,error,center-error,status-unknown}.png`；失败态截图前隐藏 Next dev 的「1 Issue」浮标（仅样式层，不影响页面）
- **测试与门禁**：新增 `graph-layout-2d.test.ts`（18）、`graph-layout-3d.test.ts`（33），共 51 项；`vitest run --maxWorkers=2` **44 文件 638 项通过**（另 1 文件 / 3 项基准跳过，共 45 文件 641 项；6D-1 结束时 42 文件 587 项）；`tsc --noEmit` 退出 0；`eslint .` 0 error（14 条既有 warning）；`check:theme` 129 名 · 0 失败 · 字面量 26；`check:contrast` 四主题各 37/37
- **未做 / 未验证**：2D 只在 mock 实例上验过，真实 LightRAG 与真实 Logto 会话未复测；3D 仍是桩；hover 压暗保留产品行为、未做延迟优化；本机 `vitest` 默认 worker 池会 OOM，须加 `--maxWorkers=2`；验收脚本端口（3123 / CDP 9338）被残留进程占用时会直接报错，跑前先清理

## 2026-11-13（Phase 6D-3：A 线默认 3D 接入 · 自适应降档与抽稀）

- **起因**：B 线真实 three / fiber 渲染器已验收，容器里还留着 `THREE_D_READY = false`，桌面永远进不了 3D；ADR-022 第 8 条的自适应降档与 `decimate` 抽稀也还没接
- **默认 3D**：删除 `THREE_D_READY` 与「3D 桩」文案，模式完全交给 `selectGraphMode`；桌面默认 `reason=auto-3d`，`?mode=3d` 走 `url-3d`；无 WebGL / reduced-motion / 移动端仍回落 2D，移动端不渲染「星系」按钮
- **生产环境停止统计重渲染**：`handleReady` / `handleStats` 继续写 ref，`setDebugVersion` 仅在非生产环境调用；`__graphStats` 保持开发态专用
- **自适应降档**：容器 `tierCeiling` + `perfGuardRef`；只认 3D 且 `rafActive`、帧数前进的窗口，连续两个 stats 窗口（≈60 帧）>20ms 才降，任一窗口 ≤20ms 清零，`TIER_ORDER` 下一档、最多 2 次、间隔 ≥3s、降后清零；经 `previousTier` 交给 `selectGraphMode`，不持久化，播报一次「已自动降低画质以保持流畅」
- **抽稀只作用于 3D**：3D 且 `overBudget` 时用 `decimate(view, { budget, keepIds })` 生成 `renderView`（keepIds：中心 / 选中 / hover / 路径端点，重建 `nodeIndex`），提示条追加「另有 N 个实体未显示」；2D / 列表 / 检查器 / highlight 仍用完整 `view`
- **诊断参数 `?maxNodes=`**：`/graph` 解析 URL，只收 50–600 整数，否则回落 150；SSR 预取与客户端同值；页面上没有控件
- **验收**：`phase6d-capture.mjs` 新增 3d / downgrade / maxnodes / overbudget 四步与 373 实体宽夹具；默认入口 drawCalls 6 / labels 24 / tier high，移动端回落 2D，低档 dpr 1 / labels 7；8× CPU 降速下真实触发 high → balanced（21.14ms）且不回升；`?maxNodes=600` 返回 373、低档渲染 133 / 隐藏 240，2D 仍是 373
- **门禁**：`tsc --noEmit` 0；`vitest run --maxWorkers=2` 45 文件 672 通过 / 3 跳过（共 46 / 675）；`check:theme` 129 名 · 0 失败 · 字面量 26；`check:contrast` 37/37；`graph-perf.mjs` 未改动并通过
- **未做 / 发现**：宽夹具是 mock 诊断数据，真实 LightRAG 未跑到 373 实体；B 线 `graph-scene-3d.tsx:258` 的 Worker 相对路径少一层（`../workers` 应为 `../../workers`），>300 节点会回落主线程，按分工只报告未代改


## 2026-11-13（Phase 6D-3 小修：降档窗口跨空闲累积 + 生产构建验证）

- **起因**：审查指出 `handleStats` 的降档窗口只在「有新帧」时才推进，空闲时段既不累计也不清零——慢两秒、停手十秒、再慢一次，会被当成「连续两个慢窗口」立刻降档
- **修复 `src/components/graph-explorer.tsx`**：四条早退路径全部对齐 ADR-022 §8「空闲打断连续性」——帧计数回绕（换布局归零）、非 3D / `rafActive=false`（2D 或后台标签页）都写回 `frames` 并清零 `slowWindows` 再返回；`frames` 没涨的重复发布只清零不累计；只有真正有新帧且 3D / `rafActive` 时才累计或清零窗口。窗口大小（≈60 帧 / 连续两个）、阈值 20ms、最多 2 次、间隔 ≥3s、只降不升均未改
- **验收脚本 `scripts/phase6d-capture.mjs`**：`downgrade` 步骤的降速倍率与观察窗改成可调，默认由 8× / 16s 改为 24× / 30s。原因是本机 8× 只压到 8–14ms，16 秒内跨不过 20ms，导致该步骤长期「跑绿但不触发」；新增 `PHASE6D_DROP_RATE`、`PHASE6D_DROP_WAIT`、`PHASE6D_DROP_PROBE`（每 500ms 打样本）
- **复测**：`PHASE6D_STEPS=downgrade` 下真实触发 `high → balanced`（两个连续慢窗口 30.52ms / 75.82ms），播报「已自动降低画质以保持流畅」，撤掉降速 2.5s 后仍为 `balanced`；全套 `node scripts/phase6d-capture.mjs` 通过（含重拍 7 张截图）
- **生产构建**：`NEXT_DIST_DIR=.next-build npm run build` 退出 0（编译 4.0s、TS 5.7s、4 个静态页）；B 线 6D-4 修掉 Worker 路径后只剩 3 条 `admin-service.ts` 既有的动态路径追踪告警。用真实库副本 + `AUTH_MODE=mock` 起 `next start`，`/api/health`、`/api/graph/status`、`/graph` 均 200（26,207 字节 SSR），服务端无报错；真实库未打开
- **门禁**：`tsc --noEmit` 0；`eslint .` 0 error（14 条既有 warning）；`vitest run --maxWorkers=2` 45 文件 672 通过 / 3 跳过（共 46 / 675）；`check:theme` 129 名；`check:contrast` 37/37
- **未做**：没有做「慢 → 空闲 → 慢」的专项运行时注入（该分支为代码核对），生产运行时的 3D 行为未在 `next start` 下实测；`03_DECISIONS.md`、B 线文件均未改

## 2026-11-13（Phase 6D-4：Worker 相对路径 · 相机下限 · 真 Worker 端到端）

- **起因**：6D-3 收尾时发现 >300 节点建 Worker 失败、回落主线程并出 `chunk-failed` 横幅，当时按分工只报告未代改；本轮修掉这两个缺陷，并把「Worker 真的跑起来」补成端到端验收
- **Worker 相对路径**：`src/components/graph/graph-scene-3d.tsx` 的 `new URL("../workers/graph-layout.worker.ts", import.meta.url)` 按 `src/components/graph/` 解析成 `src/components/workers/...`，`next dev` 报 `Module not found`；修为 `../../workers/graph-layout.worker.ts`，并留一行注释说明层级
- **相机最近距离**：`starfield.tsx` 的 `controls.minDistance` 由 `120` 改为 `260`，与 ADR-022 A3.1 / A8 一致；`maxDistance = 1100` 未动
- **宽夹具**：`scripts/graph-perf.mjs` 新增 `GRAPH_PERF_NODES=50–600`，>300 时换成 373 实体宽夹具（两个互不相连的枢纽，各 1 + 12 + 120 + 240，深度 3 全可达）并带 `?maxNodes=600`——373 > 300 真走 Worker，373 < 600 故 `truncated=false`
- **实测读数**（B 线报告 + 12:03 复跑）：Worker 内 `layoutMs 56.2–59.6ms` / 150 ticks；Worker 回包约 85ms（预算 400ms 未触发截断）；端到端约 795ms（< 1200ms）；drawCalls 6、labels 21、dpr 1、rendered 373 / hidden 0。150 基线 `layoutMs 7.1 / 80 ticks`、drawCalls 6、labels 28、标签重叠 0
- **证据链**：页面注入 `new Worker` 探针，实参解码后含 `src_workers_graph-layout_worker_ts`；CDP 有 1 个 `type: "worker"` 目标；Worker 实际回 `done`（`resultNodes=373`）。全程无 `Module not found` / `chunk-failed` / 网络 4xx / `g3-stub` 横幅。截图 `docs/screenshots/phase6d-3d-worker-600.png`（1440×900，真实 WebGL，无水印）
- **换中心**：复现到旧中心「甲」的 `done` 在新 layout 之后返回并被丢弃，最终采纳新中心「乙」；`cancelled` 回执 0 次（旧请求已经开始，按 A3 v1.3 只有未开始的排队请求才会被 cancel），协议层的 `cancelled` 仍由单测覆盖，本轮端到端未收到过
- **门禁**：`tsc --noEmit` 0；`vitest run --maxWorkers=2` 46 文件 675 项（672 通过 / 3 跳过）；`node scripts/graph-perf.mjs` 与 `GRAPH_PERF_NODES=600 node scripts/graph-perf.mjs` 均 `[ok]`
- **未验证**：无头 Chrome 的 `targetInfo.url` 为空串，Worker 脚本 URL 靠页面探针间接证明；真实 LightRAG 未跑到 373 实体；生产运行时（`next start`）的 3D 未实测
- **说明**：上面 6D-3 两条条目里「>300 节点 Worker 回落」与「`graph-perf.mjs` 未改动」是当时的记录，保留原样；后续已在本条目修复并扩展，150 基线仍通过

## 2026-11-13（Phase 6D 收尾：生产运行时四项复验）

- **起因**：6D-3 / 6D-4 的「默认 3D 入口 / 真 Worker / 抽稀 / 自适应降档」此前只在 `next dev` 与「能构建」层面验过，生产构建里 `__graphStats` / `__graphLabelBoxes` 都被 `NODE_ENV !== "production"` 关掉，等于没有证据
- **隔离方式**：`data/app.db` 用 better-sqlite3 只读备份到 `%TEMP%`，在副本上播夹具对象（mock LightRAG 的 `filePath` 必须命中副本里的对象 id，才能通过 ADR-011 归属过滤）；`NEXT_DIST_DIR=.next-build` 构建、`next start -p 3134`、`AUTH_MODE=mock`；验证后临时库、构建目录与 Chrome 用户目录全部删除，真实库未被打开写入
- **断言口径**：生产态只读可见 DOM —— `data-mode`、`[data-mode="3d"] canvas`、工具条 `aria-pressed`、提示条、`.meta-chip` 档位、`.g3-stub`、`.graph-note-error`、`.sr-only` 播报；另用截图像素统计（尺寸 / 平均亮度 / 亮像素占比 / 颜色桶）防止「画布在但没画东西」
- **四项实测**：① 桌面默认入口（URL 不带 `mode`）→ `data-mode=3d`、`.g3-stub` 为 0、「星系」`aria-pressed=true`、提示条「40 个实体 · 49 条关系」、`__graphStats` 为 `undefined`；② `?maxNodes=600` + 373 实体宽夹具 → CDP `Target` 域 1 个 `worker` 目标，提示条「373 个实体 · 372 条关系」，换中心到「宽图枢纽二」后仍 373 且 worker 目标仍在；③ 低档抽稀（390 宽 + `?mode=3d`）→ 档位「星系 · low」、提示条「373 个实体 · 372 条关系 · 另有 240 个实体未显示」、画布 `aria-label`「133 个实体、132 条关系」（= 373 − 240，且 ≤ low 档预算 150）；④ 自适应降档 → 自动旋转 + 24× CPU 降速，12.2s 后 high → balanced，播报出现，撤速 3s 后仍 balanced
- **夹具补强**：宽夹具新增第二个互不相连的枢纽「宽图枢纽二」（1 + 12 + 120 + 240 = 373）。原来从「宽图主题 01」展开 3 层只有 153 个实体（<300），换中心后掉到 Worker 阈值以下，验不出「换中心仍走 Worker」
- **脚本与配置**：`scripts/phase6d-capture.mjs` 新增 `PHASE6D_PROD=1`（构建 + `next start`）、四个 prod 步骤、DOM-only 断言与像素校验；`.gitignore` 加 `/.next-build`，`eslint.config.mjs` 的 `globalIgnores` 同步加 `.next-build/**`（否则 `eslint .` 会扫描构建产物报出大量假错误）
- **截图**：`phase6d-3d-default-entry-prod.png`、`phase6d-3d-worker-600-prod.png`、`phase6d-3d-worker-600-prod-switch.png`、`phase6d-3d-decimate-prod.png`、`phase6d-3d-downgrade-prod.png`
- **门禁**：`tsc --noEmit` 0；`vitest run --maxWorkers=2` 46 文件 675 项（672 通过 / 3 跳过）；`eslint .` 0 error（14 条既有 warning）；`check:theme` 129 名 · 0 失败；`check:contrast` 37/37
- **未验证**：生产运行时仍跑在 mock LightRAG 夹具 + 无头 SwiftShader 上；真实 LightRAG 与真实 Logto 会话未在 `next start` 下复测；Worker 由 CDP 目标证明存在，页面内消息流量未在生产构建下埋点

## 2026-11-13（真实 RAGFlow 失败链路实测）

- **起因**：`02_PHASES` 的「失败路径实测（待做）」——解析失败回写、outbox 重试退避、RAGFlow 不可用时的 500 语义，此前只有 12 项单测覆盖，没有真实故障实测
- **隔离方式**：`data/app.db` 复制到 `%TEMP%`，`AUTH_MODE=mock` + `DATABASE_PATH` 指向副本 + `NEXT_DIST_DIR=.next-failtest` 另起实例（3135），RAGFlow 用真实容器（9380）。副本里 `mock-local-user` 名下没有任何对象，真实账号的数据与真实 RAGFlow 文档都不受影响；验证用的临时对象与文档最后经 `DELETE /api/objects/{id}` 连同 RAGFlow 侧文档一并删除，临时库、构建目录与日志已清理
- **RAGFlow 不可用**：`docker stop ragflow-server` 后，上传内容返回 `500 INTERNAL`、`message` 为「RAGFlow 请求失败：GET /api/v1/datasets…」、`details.cause` 为 `fetch failed`；语义检索 `status` 从 `ok` 变 `unavailable`，`/search` 页渲染「语义检索暂不可用，当前只显示关键词匹配结果。」，关键词结果照常返回（`counts.lexical=1`）；`/api/graph/status` 与 `/api/objects` 仍 200；`/graph` 正常（图谱走 LightRAG，与 RAGFlow 无耦合）
- **outbox 退避与恢复**：停机时 PATCH 对象入队 `upsert`，后台 worker 第 1 次失败 `attempts=1` / `available_at` 推后 60s，第 2 次 `attempts=2` / 推后 120s，`last_error` 记下失败端点；`docker start ragflow-server` 恢复后第 3 次投递成功（`state=done`、`attempts=3`、`last_error=null`），`content_refs.sync_state` 回到 `synced`
- **解析失败回写**：上传结构损坏的 PDF（RAGFlow 接受上传、解析阶段报错），轮询后 `parseStatus=failed`、`parseError` 写入 RAGFlow 原始日志「14:32:18 [ERROR][Exception]: cannot convert float NaN to integer」；`POST /api/parse/run` 返回 `failed:1` 并在 `errors[]` 带 `refId` / `documentId`
- **两个新发现**（详见 `07_PLAYBOOK` 问题 107、108）：① 语义检索的 3 秒超时在 RAGFlow 刚重启 / 冷启动时会误报 `timeout`，界面提示与真正不可用混在一起；② RAGFlow 拒绝不支持的扩展名时（`broken.bin`）被包成 `500 INTERNAL`，这其实是客户端可纠正的输入问题，更适合 400
- **环境状态**：实测结束后 `scripts/autostart.ps1 -App` 重新拉起全部依赖与应用（3000，`AUTH_MODE=logto`），health 200、首页 200、`/search` `/graph` 匿名 307 回首页

## 2026-11-13（Phase 6E：大模型配置 · 内容预览 · 图谱失败自愈）

- **起因**：图谱页长期「什么都看不到」，排查后发现不是渲染问题，而是本机模型抽取全部超时失败、一个实体都没产出；同时换模型只能手改 `infra/lightrag/.env` 并重启服务。三条线一起做：把大模型配置搬进界面（ADR-025）、给作品 / 资产加统一内容预览（ADR-026）、让图谱失败可见且可重抽
- **ADR**：新采纳 **ADR-025**（大模型供应商配置与凭据存储，修订 ADR-010 的 LLM 固定条款）与 **ADR-026**（知识内容预览），索引表与 ADR-010 状态行同步更新；需求与设计稿见 `18_REQUIREMENTS_LLM_PREVIEW.md`、`19_DESIGN_LLM_PREVIEW.md`
- **凭据存储**：新变量 `SETTINGS_ENC_KEY`（独立于 Logto 的 Cookie 密钥，轮换登录密钥不会让已存 API Key 解不开）；`src/server/security/secret-box.ts` 用 AES-256-GCM + HKDF-SHA256 派生密钥，密文格式 `v1.<iv>.<tag>.<ct>`（b64url），非密钥字段与 API Key 一起整段加密，避免「漏加密一列」；密钥缺失时接口直接报错，绝不降级为明文落库
- **数据层**：`drizzle/0009_settings.sql` 新增 `settings` 表（`key` / `value_encrypted` / `updated_at` / `updated_by`，`updated_by` 存 sub 快照、不建外键）；迁移只建表不写默认行，没有行时接口按 `infra/lightrag/.env` 推导当前生效值。权限目录新增 `settings:read` / `settings:write`（仅 owner / admin），总数 **13 → 15**，`assertAuthzCatalog()` 启动时核对代码常量与数据库两边
- **接口**：`GET /api/settings/llm`（密钥只回掩码与 `hasKey`）、`PUT /api/settings/llm`（未提交 `apiKey` 时沿用已存值）、`POST /api/settings/llm/test`（向供应商发 `max_tokens: 8` 的最小请求，失败仍以 200 返回业务结果）、`POST /api/settings/llm/apply`（备份 `.env` → 只重启 `lightrag-server` → 60 秒轮询 `/health` → 失败自动回滚 `.env` 并重启回原配置）；`POST /api/graph/retry`（`objectIds` 1–20 个，权限 `content:sync`，逐条回 `resubmitted` / `skipped` / `failed`）
- **设置页**：新路由 `/admin/llm`，目录「系统」下加入口（`settings:read` 可见，无权限走与其它 admin 页一致的拒绝页）；四张卡——当前生效 / 模型服务（预设 OpenAI、DeepSeek、通义千问、自定义 OpenAI 兼容、本机 Ollama）/ 连接测试 / 应用并重启；保存与应用分开，应用前确认弹窗写明重启 10–30 秒、在途任务会中断、失败自动回滚
- **内容预览**：`ContentPreviewDialog`（原生 `<dialog>`）+ `PreviewProvider` 单一宿主；打开状态写进 URL `?preview=<objectId>`，可后退关闭，关闭后焦点回到触发元素；PDF 同源 iframe、Markdown 复用零依赖渲染器、纯文本、图片内联，其它类型给下载；显示解析状态与失败原因（超时 / 连接 / 不支持格式 / 空内容四类），附件可切换，移动端全屏。本轮接入工作台列表标题点击与详情页「预览」，检索与图谱入口留到下一轮
- **交互取舍**：列表行普通单击改为就地预览，⌘ / Ctrl / Shift 单击仍是原来的详情页链接；弹窗内「打开详情」保留当前筛选
- **下载接口**：`GET /api/objects/{id}/content/{refId}` 新增 `?inline=1`，`Content-Disposition` 在 `inline` 与 `attachment` 之间切换；`Content-Type` 优先用本地 `content_refs.mime`，因为 RAGFlow 对 PDF 常回 `application/octet-stream`，照搬会让浏览器把内联打开变成下载
- **图谱失败归因**：`describeGraphFailure` 把 LightRAG 原始错误归一为六类——「抽取超时：本地模型过慢」「抽取服务连接失败…」「抽取失败：模型接口的密钥或权限被拒绝」「抽取失败：模型接口限流或额度不足」「抽取失败（未返回原因）」「抽取失败：<首行>」（超过 120 字截断）；原始错误串始终一并返回。`GET /api/graph/status` 只上报当前账号拥有的对象，失败项可直接在页面上展开原因并重抽
- **空图根因（实测）**：本机 Ollama `deepseek-r1:7b` 纯 CPU 约 7 tok/s，单请求上限 300 秒，两篇长文双双 `ReadTimeout`，图谱不是「还没抽完」而是**一个实体都没有**；换成外部模型或调小分块后需重新抽取
- **验收**：真实数据下 `/graph` 页显示 1 个失败项、可读原因与「重新抽取」入口；`/admin/llm` 与预览弹窗在明暗主题下用浏览器实际打开核对
- **质量门（本轮实跑）**：`tsc --noEmit` 退出 0；`eslint .` 0 error / 14 warning（既有）；`vitest run --maxWorkers=2` **50 文件 737 项（734 通过 / 3 跳过）**；`check:theme` 129 名 · 0 失败 · 字面量 26（未新增）；`check:contrast` 37/37
- **未做 / 未验证**：`apply` 未在验收实例触发（会重启 LightRAG，需单独安排窗口）；真实供应商 API Key 的连接测试未跑；多轮问答仍缺对话模型 key；PDF 内嵌在 Chrome / Edge 的实机渲染、浏览器后退关闭弹窗、移动端 `100dvh` 全屏未逐项实测；检索与图谱的预览入口未接入

## 2026-11-13（Phase 6F：列表点击语义 · 模型应用真重启 · 图谱恢复）

- **起因**：用户实测两条反馈——预览弹窗右上角「打开详情」点了没反应；作品目录点标题周围整片区域都会弹预览，与「全部内容」区「点名称才跳详情」的习惯不一致。同时图谱页三个对象全部抽取失败，界面只写「未返回原因」。
- **「打开详情」修复**：原生 `<dialog>` 在自身点击处理器里被卸载，`<Link>` 的默认导航随 DOM 一起取消；`dismiss()` 里的 `window.history.replaceState` 又抹掉 `?preview=`，与 App Router 状态失同步（表现为「跳一下又停回列表」）。改为 `preventDefault()` → `onDismiss()` → `router.push(detailHref)`；移除 `replaceState`；新增 `suppressCloseRef` 区分程序化关闭与用户关闭
- **列表点击语义统一**：`record-list.tsx` 改成 stretched link——铺满整行、`z-index:0` 的 `<Link>` 负责详情，标题是 `z-index:1` 的 `<button>` 只负责预览；⌘ / Ctrl / Shift 单击仍走详情；无预览上下文时标题退化为纯文本。工作台「全部内容」与「作品目录」共用同一结构；样式落在 `globals.css` 的 `.record-row-*`
- **`apply` 假成功的三层根因**：① `findLightragProcesses` 的 PowerShell 脚本用空格拼接语句，`if (...)` 被当成 `Select-Object` 的参数，exit 1、stdout 为空；② 代码不检查退出码与空结果；③ 旧 `lightrag-server` 没被杀掉，新实例抢不到 9621，`/health` 由旧进程回答。修法：脚本分号分隔；`defaultRunPowerShell` / `killProcessTree` 非 0 退出抛 `DomainError`；`restartLightrag` 查不到进程时抛错并回滚 `.env`；`spawn` 带 `PYTHONUTF8=1` / `PYTHONIOENCODING=utf-8`（stdout 重定向到文件时 GBK 编码遇 emoji 会 `UnicodeEncodeError`）
- **真实生效并恢复图谱**：重启后启动日志为 `openai/deepseek-chat @ https://api.deepseek.com/v1`；三篇文档（江苏篇 29 块、OpenMausBot 指南 4 块、浙江篇 29 块）全部重抽为 `processed`，图存储累计 **1256 节点 / 1521 条关系**
- **失败可诊断**：新增 `src/server/services/model-endpoint-probe.ts`（只读）：按当前生效配置直连 `GET {base}/models`（Ollama 原生走 `/api/tags`），3 秒超时、30 秒内存缓存、密钥只进请求头、永不抛错；`GET /api/graph/status` 在存在失败对象时附带 `diagnosis`（`checkedAt` / `ok` / `latencyMs` / `message`），图谱页在失败面板与进度区用 `DiagnosisNote` 展示；接口契约同步写入 `06_API.md` §9.4
- **测试与门禁**：新增 `tests/server/model-endpoint-probe.test.ts`；`llm-apply.test.ts` 补「查不到进程必须失败并回滚」与「脚本必须含分号」两项；`tsc --noEmit` 退出 0；`eslint .` 0 error / 14 warning（既有）；`vitest run --maxWorkers=2` **51 文件 757 通过 / 3 跳过**；`check:theme` 129 名 · 0 失败 · 字面量 26；`check:contrast` 37/37
- **未做 / 未验证**：浏览器后退关闭弹窗、移动端预览全屏未复测；`diagnosis` 的文案只在注入场景下验过，未在真实断网下复现；抽取耗时未重新统计

## 2026-11-13（ADR-027：/graph 全屏星图画布 + 液态玻璃浮层）

- **起因**：用户实测 `/graph` 页面「布局别扭、星图太小」，希望整页背景都是星图，头部控制区与右侧实体详情改成不挡星图的透明液态玻璃板
- **ADR**：新增 **ADR-027**（决策索引表已加行）；只写决策与边界。同时按代码事实校正 ADR-025——应用密钥是专用 `SETTINGS_ENC_KEY`（**不存在** `AUTH_SECRET` 回退链），HKDF salt 为 `pakp.settings.salt.v1`、info 为 `pakp.settings.aes-256-gcm`，**没有 AAD**，解密失败给固定文案且不得自动清空该行
- **布局边界**：作用域是图谱模块内容区（含页头），左侧导航不动；`.graph-page` 去掉 `max-width: 1180px`，画布 `position: absolute; inset: 0` 铺满作背景层；控制条并为顶部玻璃条，详情改为右侧玻璃浮层，**画布不再为其让位**（显式覆盖 `16_GRAPH_DESIGN.md` §3.2 的避让规则，需设计稿回改）
- **玻璃令牌**：新增 3 个令牌写在既有 `[data-surface="graph"]` 块内——底色 `color-mix(in srgb, var(--graph-canvas) 72%, transparent)`、边框 22% accent、1px 内高光 6% 白；`backdrop-filter: blur(14px) saturate(130%)`，模糊上限 18px。因此 `check:theme` 名字总数与字面量基线 26 均不变
- **可读性硬约束**：玻璃内的文字与图标只能用 graph 面令牌，禁止用主题 `--text-*` / `--surface-*`（pine / sand 是浅色主题，混用会出现深底深字）；`check-contrast.mjs` 增加 `graph.glass` 分组（文字 4.5:1、图标与边框 3:1）
- **降级链**：不支持 `backdrop-filter` → 92% 实色；`prefers-reduced-transparency` → 同上；`low` 档 → 同上；无 WebGL → 沿用现有 2D 规则。2D 聚焦模式同样铺满 + 玻璃，列表模式保持文档流且不挂 WebGL
- **交互与可访问性**：浮层容器 `pointer-events: none`、每块浮层 `auto`，禁止整屏透明遮罩吞掉画布交互；焦点顺序 控制 → 画布 → 详情；浮层可折叠但不整体消失；`prefers-reduced-motion` 契约不变
- **性能口径**：画布变大意味着像素更多，但 ADR-022 的 150 / 300 / 600 节点预算、2 / 1.5 / 1 的 DPR、8 个 draw call、Worker 抽取与 `__graphStats` 全部不变，不得用缩小预算换帧率
- **未做（当轮）**：只改 `docs/`，未跑 `check:theme` / `check:contrast`，未实测任何帧率或节点读数——实现与实测见同日下一条

## 2026-11-13（ADR-027 v1.1 实施：左上控制卡 + 右上详情卡 + 液态玻璃三层）

- **起因**：用户看过第一版实机效果后提出——顶部绿色框选的整条控制区往左收缩到左上角、按键区随之调整；红色框选的实体详情上移到右上角，与收缩后的控制区保持水平；所有浮在星图上的方框都做成参考代码那种「会动的高光 + 边缘不均匀」的液态玻璃
- **版式**：控制区改为 `position:absolute; top/left:16px; width:max-content; max-width:min(880px, 100% − 356px − 48px)` 的紧凑玻璃卡，控件允许两行；实体详情改 `top/right:16px`、宽 356（≤1000px 为 300）、最高 60%、内部滚动；两卡顶边同线、中间留 16px；问图谱仍贴右下；画布层保持 `inset:0`，选中实体不再改变画布尺寸
- **液态玻璃**：`[data-surface="graph"]` 新增 6 个令牌（指针高光 core 30% / mid 12%，斜向反光四段 18/3/8/14% 白），`.graph-glass` 增加 `::before` 径向高光（`--mx/--my`）、`::after` 160° 反光（`mix-blend-mode: screen` + `isolation: isolate`）与 `perspective(1200px)` 下 ≤3° 倾斜；坐标用 ref + `style.setProperty` 写入、`requestAnimationFrame` 合并，`pointermove` 挂在每张卡自身；`prefers-reduced-motion` / 触屏只保留静态层；`low` 档与不支持模糊时回 92% 实色
- **取景**：新增 `src/lib/graph-camera.ts`（45° FOV、仰角约 14.5°、94% 填充率、24 步求方位角），`starfield.tsx` 按视口宽高比重新取景并同步 `controls.maxDistance`；配套 `tests/lib/graph-camera.test.ts` 18 例
- **列表点击语义**：`record-list.tsx` 标题补 ⌘/Ctrl 分支（跳过预览直接进详情），与行内其余位置一致
- **实测读数**：1440 控制卡 736×249 @ (316,16)、详情卡 356×183 @ (1068,16)、顶边差 0、间距 16、画布 1140×900；1920 控制卡 880×201、间距 352、画布 1620×1080；390 控制条 298×63、抽屉 436px（55dvh）、选中实体下沿 304 < 抽屉顶 400；指针移入 `--mx` 82%、移出后变量移除、倾斜回正
- **质量门**：`tsc` 0；`eslint` 0 error / 14 warning（既有）；`vitest` **51 文件 774 通过 / 3 跳过**；`check:theme` 129 名 · 0 失败 · 字面量 26；`check:contrast` **41/41**
- **独立验收**：临时库 + 假 LightRAG + 无头 Chromium，对 **生产构建（`next start`）** 跑 34 项断言全过——含两卡顶边差 0、间距 16、画布 1140×900 全幅、指针高光/倾斜、每卡各自监听 `pointermove`（工作区与 window 无监听）、四主题文字色、1920 与 390 断点、列表模式不套玻璃；截图见 `docs/screenshots/graph-glass-*.png`
- **未验证**：真实 Logto 身份下的三栏截图未重拍；低端集显帧率与触屏真机手势未实测
