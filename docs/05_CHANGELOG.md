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
