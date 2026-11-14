# 工程手册：开发计划、执行过程与问题复盘

> **读者**：接手本项目的开发者 / AI、需要评估进度的协作者。
> **写法**：只记录仓库里能核实的事实（提交、文件、测试、实测端口）。无法核实的标「未验证」，不写规划口吻的完成状态。
> **快照时间**：2026-11-14 12:50（Asia/Shanghai），规格 v2.1（Phase 6J / ADR-030）与六项界面体验修复已落地。测试基线 **66 个文件 916 项通过 / 3 项跳过**；typecheck / lint / check:theme / check:contrast / build 全绿，生产实例（3000）已迁移至 `0011` 并重启。真实登录、前端冒烟与图谱归属隔离的操作过程见 [08_RUN_LOG.md](08_RUN_LOG.md)。
> **与其他文档的关系**：阶段定义以 [02_PHASES.md](02_PHASES.md) 为准，决策以 [03_DECISIONS.md](03_DECISIONS.md) 为准，接口以 [06_API.md](06_API.md) 为准。本文件不重复契约，只讲「怎么做的、踩过什么、怎么验证」。

---

## 1. 项目目标与阶段路线

### 1.1 目标

以 RAGFlow 为统一内容存储与检索底座，在其上实现资产管理（内库 / 外库）与四阶段作品工作流（draft → finished → published → practiced），后续接入 LightRAG 知识图谱，用 Logto 提供登录。第一期单用户，不做权限体系与多用户隔离（ADR-002 / ADR-003）。

### 1.2 Phase 1 的口径

Phase 1 = **身份 + 最小持久化 CRUD**。这是 2026-11-11 扩展后的口径：原「Phase 1 只做骨架」作废，依据是产品侧 DATA-01 / DATA-05 / DATA-08，存储选型见 ADR-009。完成标准：

- 新建的 Next.js 应用可运行；
- 登录可用、能拿到用户身份（`AUTH_MODE=logto`）；
- `POST /api/objects` 落库，重启后数据仍在。

### 1.3 阶段总览

| 阶段 | 目标 | 状态（截至本快照） |
|------|------|--------------------|
| Phase 0 | 文档体系 + 基础环境 | Logto、RAGFlow 均已部署并连通实测；环境部分可视为完成 |
| Phase 1 | 身份 + 最小持久化 CRUD | 已完成；真实登录用测试账号端到端验证（2026-11-11） |
| Phase 2 | RAGFlow 内容底座 | 上传 / 替换 / meta 已打通；outbox 投递、解析轮询、检索、下载均已实现并端到端实测 |
| Phase 3 | LightRAG 知识图谱 | 主路径完成：本机部署、适配器、`graph-service`、5 条接口与 `/graph` 页；单 workspace 限制待解决 |
| Phase 4 | 核心业务（资产 + 工作流） | 元数据、工作流、内容上传、同步投递与检索前端均已实现 |
| Phase 5 | 联调与打磨 | 主路径完成；剩失败路径实测与打磨 |

> **文档同步现状**：`02_PHASES.md` 已按本轮实测更新（2026-11-11），与 `04_INTEGRATION.md` 一致；`01_ARCHITECTURE.md` 的 Phase 3 实现状态待同步。

---

## 2. 架构分层与关键约定

### 2.1 分层与调用方向

```text
route handler  →  services  →  ports  ←  repositories  →  db
                     │
                     └── domain（纯类型与规则，被所有层引用）
```

| 层 | 目录 | 只做什么 | 不做什么 |
|----|------|----------|----------|
| domain | `src/domain/` | 类型、取值集合、状态机、错误码 | 不碰 IO、数据库、框架 |
| ports | `src/server/ports/` | 仓储与会话接口 | 不做权限、不发外部请求 |
| repositories | `src/server/repositories/` | SQLite 实现；把驱动错误翻译成领域错误 | 不调 RAGFlow |
| db | `src/server/db/` | 连接单例、表结构、迁移、ULID | 不写业务判断 |
| services | `src/server/services/` | 用例编排：`object-service.ts` 负责请求体 / 查询参数解析、字段校验、`ownerSub` 归属校验；`content-service.ts` 编排内容上传（解析 multipart → 调 RAGFlow → 落 refs + 入队）；`search-service.ts` 负责检索过滤；`graph-service.ts` 负责图谱文本构造、`pakp:obj:` 来源标识、判重与引用回映射 | 不直接拼 SQL；不绕开 adapters 发外部请求 |
| http | `src/server/http/` | 统一响应信封、错误码 → HTTP 状态 | 不写业务逻辑 |
| adapters | `src/server/adapters/` | RAGFlow、LightRAG 与 Logto 的**唯一**外部入口 | 不被 domain 依赖 |

硬约束（ADR-009）：route handler **不超过 15 行**；所有 RAGFlow 调用只经 `server/adapters/ragflow`，所有 LightRAG 调用只经 `server/adapters/lightrag`。

### 2.2 六条业务约定

1. **状态机显式化**：`src/domain/workflow.ts` 用「来源 → 允许目标」表，不用顺序数组判断。只允许逐级前进，不允许跳级、回退、自环。
2. **乐观锁 `revision`**：编辑、状态迁移、跨库迁移都要带 `expectedRevision`；不一致抛 `CONFLICT`（409），避免读-改-写覆盖。
3. **outbox（`sync_jobs`）**：元数据变更与入队**同一事务**；任务状态 `pending → running → done / failed`，带 `attempts`、`last_error`、`available_at`。消费端在 `1ea0b86` 落地：进程内定时 worker（默认 30 s）认领到期任务，`upsert` 重写 RAGFlow `meta_fields`、`delete` 删文档并软删本地引用；`POST /api/sync/run` 可手动催一轮。失败按指数退避回到 `pending`，达上限置 `failed`。迁移与删除已在真实 RAGFlow 上端到端验证；失败重试只在假网关单测里验证过。
4. **软删除**：`objects.deleted_at`，不物理删行；列表默认过滤。删除同时入队 `delete` 任务，RAGFlow 侧文档**不会**立即删除。
5. **外库限制**：`library = external` 的作品不得 `practiced`，必须先迁到内库（ADR-008）。资产没有 `status`。
6. **内容身份用 `content_key`，不用 `document_id`**：替换正文等于「删旧文档 + 传新文档」，`document_id` 必变；`content_key` 才是跨重传稳定的幂等键（ADR-007）。

### 2.3 规则写两遍：应用层 + 数据库

同一条规则在领域层和数据库 CHECK 各实现一次：应用层给可读错误码，数据库是绕过服务层直写时的最后防线。

| 约束 | 位置 | 对应领域规则 |
|------|------|--------------|
| `objects_status_only_for_work` | `schema.ts` / `0000` | 资产无 status |
| `objects_external_not_practiced` | 同上 | 外库不得 practiced |
| `objects_status_check` / `objects_format_check` | `schema.ts` / `0001` | 四个状态、六种形态的取值域 |
| `objects_asset_has_no_work_fields` / `objects_work_requires_format` | `schema.ts` / `0001` | 资产无 format/source_note；作品必须有 format |
| `library_events_cross_check` | `schema.ts` / `0004` | 迁移记录必须跨库（`from_library <> to_library`），同库记录写不进去 |

驱动报错在仓储层被翻译：`CHECK constraint failed` → `CONSTRAINT_VIOLATION`（422）；`UNIQUE constraint failed` → `CONFLICT`（409）。

### 2.4 表分工

| 表 | 职责 | 关键设计 |
|----|------|----------|
| `objects` | 资产 / 作品同表，`type` 区分 | `revision` 乐观锁、`deleted_at` 软删除、`archived_at` 归档 |
| `content_refs` | 对象 ↔ RAGFlow 文档 | `content_key` 是幂等键（`dataset_id + content_key` 唯一），`document_id` 是可变指针（`dataset_id + document_id` 唯一）；每对象至多一个有效主引用 |
| `library_events` | 跨库迁移审计 | `reason` 必填；与库别更新同事务 |
| `sync_jobs` | 内容同步 outbox | 活跃任务唯一索引去重；认领 / 重试见第 4 节 |

### 2.5 内容映射契约（ADR-007）

- RAGFlow 只用一个 Dataset；库别与归档**不切分内容**，只写业务元数据。Dataset 解析顺序：`RAGFLOW_DATASET_ID` → `RAGFLOW_DATASET_NAME`（默认 `pakp-content`）查名 → 都没有就创建。
- `meta_fields` 单向镜像 `content_key`、`owner_type`、`owner_id`、`library`、`archived`、`format`、`source`；**不镜像 `status`**。
- `content_key` 是幂等键：主内容 `obj:{objectId}:primary`，附件 `obj:{objectId}:attachment:{ULID}`。
- 正文更新是「删除 + 重传」，`document_id` 必变，因此不能用它当身份。
- **替换顺序（`49e26de` 之后）**：临时名上传新文档 → `PUT` 写 meta → 落 `content_refs` + 入队 → 删旧文档 → 改回原名。上传或写 meta 失败时删掉新文档、旧内容保持不变，不存在「先删后传」的丢内容窗口。
- RAGFlow 的上传接口**不接受** `meta_fields`，要上传后单独 `PUT`；该 `PUT` 是整体替换，必须每次传完整字段集。

### 2.6 图谱契约（ADR-010）

- LightRAG 1.5.7 跑在本机 Python 进程（`127.0.0.1:9621`），LLM 用 Ollama `deepseek-r1:7b`，Embedding 复用 RAGFlow 的 `BAAI/bge-large-zh-v1.5`（本地 OpenAI 兼容服务 `127.0.0.1:9381`）；图与向量存储独立于 RAGFlow。
- 图谱文本 = 元数据头（标题、类型、库别、状态、描述、分类、标签）+ RAGFlow 分块原文；只取 `role=primary`、`parseStatus=succeeded`、未删除的引用。
- 来源标识 `file_source = pakp:obj:{objectId}:{sha256(text).slice(0,12)}`：哈希判重、内容变更时先删旧版本再写新版本；问答引用只认 `pakp:` 前缀并回查归属。
- 同步是**手动**的（`POST /api/graph/sync`，单轮最多 50 个对象）；入库后抽取在 LightRAG 后台异步进行，前端轮询 `/api/graph/status`。
- 已知限制：LightRAG 图 / 问答路由绑定默认 workspace，`LIGHTRAG-WORKSPACE` 头只覆盖部分接口（如 `/health`），因此当前是**单租户**；子图沿**有向边**展开，只有入边的实体返回空图。

---

## 3. 实际开发顺序（按 `git log`）

> 任务简报假设的顺序是「骨架 → 持久化 → CRUD → P0 → P1」。实际顺序有三处不同：
> ① **骨架与 mock 身份没有独立提交**，它们在 2026-11-01 写好，2026-11-11 13:00 纳入版本控制时一起进了基线 `ebe32e6`；
> ② P1 之后还多了一次 outbox 事务补强（`40561f7`）；
> ③ P1 之后又追加了六轮：「读取接口 / 数据层加固 / 列表检索 / 内容上传」四个提交（`07652b7` ~ `49e26de`），「前端行内操作 + outbox 消费端」（`82d8d54`、`1ea0b86`），以及 `archived=only` 的归档视图（`a7aa5f3`）。

| # | 提交 | 时间 | 内容 | 提交时测试 |
|---|------|------|------|------------|
| 1 | `ebe32e6` | 13:00 | 纳入版本控制，保存重构前基线（含 11-01 写的 Next.js 骨架、Mock 身份 UI、`/api/health`） | 1 项（按 `05_CHANGELOG.md` 11-01 记录） |
| 2 | `91a68b5` | 13:04 | 同步 Docker 就绪后的进度，加入旧项目功能盘点 | — |
| 3 | `acc4ee5` | 13:18 | 固化 ADR-007 / 008 / 009，落地界面设计规范 | — |
| 4 | `e95d154` | 13:20 | 业务数据层：SQLite + Drizzle、四张表、两条 CHECK、Logto 自托管 | 6 文件 40 项 |
| 5 | `b96b9d0` | 13:23 | 身份端口 + mock 身份 + 最小持久化 CRUD（`/api/objects`） | —（changelog 未单列用例数） |
| 6 | `b6e719b` | 14:45 | Logto 真实登录（`@logto/next` 4.2.11）+ 工作台首屏 | 7 文件 48 项 |
| 7 | `bd005d1` | 14:47 | P0：取值域 CHECK 钉进数据库（`0001` 重建表） | — |
| 8 | `feb670e` | 14:49 | P0：状态迁移写路径；新建作品固定 draft | 7 文件 55 项 |
| 9 | `8c53880` | 14:50 | P0：outbox 认领 / 去重 / 重试 / 完成标记（`0002`） | 7 文件 61 项 |
| 10 | `ca7396f` | 14:52 | P0：外键与引用完整性（`0003`）；修掉 upsert 无法清空字段 | 8 文件 80 项 |
| 11 | `5cbbcad` | 14:53 | P1：编辑、删除、跨库迁移、归档接口 | 8 文件 84 项 |
| 12 | `5b19bfe` | 14:54 | RAGFlow v0.20.5 部署 + 最小内容适配器 | 8 文件 84 项 |
| 13 | `40561f7` | 14:56 | outbox 入队并入对象写事务 | 8 文件 88 项 |
| 14 | `07652b7` | 14:58 | 对象详情（`GET /api/objects/{id}`）与迁移审计读取（`GET /api/objects/{id}/library`） | 8 文件 89 项 |
| 15 | `13d2940` | 14:59 | 迁移目录运行时解析（`MIGRATIONS_FOLDER`）；`library_events` 跨库 CHECK（`0004`） | 8 文件 90 项 |
| 16 | `0e4d798` | 15:00 | 列表关键字 / 分类 / 标签 / 状态 / 排序分页（`q` `category` `tag` `status` `sort` `limit` `offset`） | 8 文件 95 项 |
| 17 | `49e26de` | 15:06 | 内容上传打通 RAGFlow 与 `content_refs`：`POST /api/objects/{id}/content`、单一 Dataset、临时名替换、meta 镜像 | 9 文件 117 项 |
| 18 | `82d8d54` | 15:08 | 工作台对象行内操作：状态推进、跨库迁移、编辑、归档、删除；抽出 `src/lib/api-error.ts` / `object-labels.ts` | 9 文件 117 项（纯前端，用例数不变） |
| 19 | `1ea0b86` | 15:10 | outbox 消费端：`sync-service` 投递、`POST /api/sync/run`、`instrumentation` 挂进程内 worker | 10 文件 125 项 |
| 20 | `a7aa5f3` | 15:11 | 列表支持只看已归档（`archived=only`），非法取值改为 400 | 10 文件 127 项 |
| 21 | `decfabc` | 15:16 | 补齐 API 参考与工程手册，并同步架构文档到当前实现 | — |
| 22 | `b1bde9d` | 15:27 | 接入 RAGFlow 解析触发与状态轮询 | — |
| 23 | `44c3b8d` | 15:29 | 新增对象内容下载接口 | — |
| 24 | `1258e15` | 15:33 | 新增内容检索接口 | — |
| 25 | `b860530` | 15:34 | 统一仓储层 SQLite 约束错误翻译 | — |
| 26 | `3b8ddb4` | 15:42 | 工作台列表筛选与归档视图 | — |
| 27 | `4e86ddf` | 15:42 | 拒绝推进已归档作品的状态 | — |
| 28 | `26fcbe5` | 15:42 | 文档同步：解析轮询、下载与检索 | — |
| 29 | `cd2dc50` | 15:42 | 文档：归档状态守卫与工作台筛选 | — |
| 30 | `3a51888` | 18:17 | 内容检索页、对象详情页与内容文件界面 | —（提交时未单独记录；本轮基线 19 文件 216 项） |
| 31 | `2e7f70a` | 18:18 | 文档：检索与详情前端落地，补实测与问题沉淀 | 同上 |

**本快照的实测结果（2026-11-11 18:58，工作区）**：`npm run typecheck`、`npm run lint`、`npm test`（19 个文件 216 项）与 `npm run build` 全部通过；Phase 3 的 UI 与接口另用生产构建 + mock 身份做了 HTTP / 浏览器冒烟。

### 3.1 Phase 3 提交切分

Phase 3 按「依赖方向」拆成四个提交，工作区此后为干净状态：

| 提交 | 内容 |
|------|------|
| `c9ea9a0` | LightRAG 基础设施（`infra/lightrag/`）、适配器、RAGFlow 分块读取、ADR-010、忽略规则 |
| `8432585` | `graph-service` 与 5 条 `/api/graph/*` 接口 |
| `ec6a48f` | `/graph` 页、`GraphExplorer`、侧栏入口、样式、布局与标签纯函数及单测 |
| `d945a83` | 01/02/04/05/06/07 文档与实测数据 |

本地运行生成、未纳入版本控制的仍是 `infra/lightrag/.venv`、`models`、`data`、`.env` 与根目录 `data/` 下的 SQLite 文件。

---

## 4. 问题—根因—解决—预防

| # | 现象 | 根因 | 解决 | 如何避免 |
|---|------|------|------|----------|
| 1 | Windows Git Bash 下 `npx tsc` 在含空格的项目路径里报 `'Knowledge' 不是内部或外部命令` | npx 调起的命令未对含空格的项目路径加引号，`Personal Asset & Knowledge PlatformV2` 在空格处被拆成命令与参数 | 改用 `node node_modules/typescript/bin/tsc --noEmit`；`package.json` 的 dev / build / start / lint / typecheck / test 全部改为 `node <bin>` 直调 | 路径含空格的项目不用 `npx`；脚本统一 `node node_modules/...`，不依赖 shell 引号规则 |
| 2 | drizzle-kit 为带表达式的部分唯一索引生成非法 SQL（`coalesce(content_ref_id, '')` 的参数被拆到多行），`CREATE UNIQUE INDEX` 执行失败 | 生成器对表达式列的分行输出不可执行；快照里保存的表达式本身是正确的 | 手写 `drizzle/0002_sync_jobs_active_dedupe.sql`，保留单行 `coalesce`；`drizzle/meta/0002_snapshot.json` 中该索引定义正确，后续生成不受影响 | 生成迁移后**逐条读 SQL**，尤其表达式索引、表重建；用内存库跑一遍迁移再提交 |
| 3 | better-sqlite3 的事务回调里 `await` 报错 / 行为不可预期 | better-sqlite3 是同步驱动，`db.transaction()` 回调必须同步执行 | 事务内改用 `.get()` / `.run()`，仓储方法在事务外 `return`；类型上用 `Parameters<...>` 推出 `Tx` 句柄 | 事务回调里只放同步语句；异步工作（外部调用、日志投递）放事务外 |
| 4 | 同一对象的编辑、归档、迁移接连发生时，`sync_jobs` 堆出多条重复 upsert | 入队只看「有没有插入」，没有「已有活跃任务就不插」的判据 | 部分唯一索引 `sync_jobs_active_uq`（`owner_type + owner_id + coalesce(content_ref_id,'') + action`，仅覆盖 `pending` / `running`）+ `ON CONFLICT DO NOTHING`；并发撞索引时返回已有任务 | 用数据库唯一约束表达「幂等」，而不是先查再插；入队与写库同事务 |
| 5 | 从 `CreateObjectInput` 移除 `status` 后，原有「新建即指定状态」的测试全部失效 | 测试断言的是被删除的能力，直接改断言会变成「测试迁就实现」 | 删除旧用例，改为两条新断言：服务层拒绝作品带 `status`；绕过应用校验直写 asset.status 时数据库 CHECK 拒绝 | 删能力时先问「这条测试保护的是规则还是实现细节」；规则类测试下移到数据库层 |
| 6 | 跨库迁移时若乐观锁冲突，可能出现「库别已改但没有审计记录」，或反之 | 对象更新与 `library_events` 写入分属两次写操作 | `changeLibrary` 把两件事放进同一事务：先按 `expectedRevision` 更新 `objects`，成功后再写审计，任一失败整体回滚 | 任何「改状态 + 留痕」都放进同一事务；不做跨服务补偿 |
| 7 | `contentRefs.upsert` 用 `??` 合并字段，`parseError` 永远清不掉 | `??` 把 `undefined` 和 `null` 都当作「保持原值」，无法表达「显式清空」 | 改成「字段缺席 → 保持原值；显式 `null` → 清空」，并用单条 `INSERT ... ON CONFLICT DO UPDATE` 消除「先查再写」的竞态 | 可空字段的更新约定写进类型注释与测试；用「缺席 / null」区分而不是 `??` |
| 8 | `library_events.object_id`、`sync_jobs.content_ref_id` 可以指向不存在的行 | 初版表结构只建了普通列，没有外键 | 迁移 `0003` 重建两表并加外键；`dataset_id` / `document_id` / `content_key` 加非空长度 CHECK | 建表时先画引用关系；外键与 CHECK 和首版迁移一起进，不留给「以后补」 |
| 9 | 按旧契约（先建记录再 PUT、列表当数组）实现，与 v0.20.5 对不上 | 实际是**单次 multipart POST**（字段名 `file`），不是「先建记录再 PUT」；文档列表返回 `data.docs`，不是数组 | 实测后改适配器：`createDocument` 单次 multipart；`listDocuments` 读 `data.docs`；契约写进 `04_INTEGRATION.md` | 外部接口先实测再写代码与文档；把实测请求 / 响应记进 `04_INTEGRATION.md` |
| 10 | Logto 容器只 `EXPOSE 3001`，按 3001 找控制台找不到 | 进程同时监听 `ADMIN_PORT`（默认 3002），控制台挂在 `ADMIN_ENDPOINT` 的 `/console` 下；镜像声明不完整 | compose 暴露 3001/3002 两个端口，文档记录控制台地址 `http://localhost:3002/console`；入口覆盖为 `npm run cli db seed -- --swe && npm start` 以满足启动前的 seed / RLS 校验 | 「镜像 EXPOSE」不等于「进程实际监听」；以 `docker compose ps` + 实际 HTTP 探测为准 |
| 11 | 同一文件名重复上传，RAGFlow 返回了新 `document_id`，但文档列表里出现 `(1)` 后缀的重名项，无法确定哪条是当前内容 | RAGFlow v0.20.5 对同名重传的行为不确定（既不是幂等覆盖，也不是稳定新建），不能拿文件名当身份 | 替换主内容时先用 `临时名.{ULID}.{扩展名}` 上传，落库后再调 `PUT /documents/{id}` 把 `name` 改回原名；改名接口实测可用 | 外部系统的「同名」语义必须实测确认；业务身份一律用自建 `content_key`，文件名只作展示 |
| 12 | 替换主内容时存在丢内容窗口：先删旧文档，再传新文档，上传失败就两头空 | 原实现按「删除 + 重传」字面顺序写，把不可逆操作放在了前面 | 改为「临时名上传 → 写 meta → 落 refs + 入队 → 删旧文档 → 改名」；并补三条失败路径测试：新文档上传失败、meta 写入失败、旧文档已不存在 | 涉及外部系统的多步写，先做可回滚的那一半；为每个失败点写一条断言，而不是只测成功路径 |
| 13 | HTTP 冒烟一直返回 405，看起来像路由没实现 | 3100 端口上残留着一个旧的 `next start` 子进程，请求根本没打到 dev server | `netstat -ano \| findstr :3100` 找到监听 PID，再 `taskkill //PID <pid> //T //F` 整棵进程树杀掉（Windows 下普通 `kill` 停不掉 Next dev 派生的子进程） | 冒烟前先确认端口归属；405 / 404 先查「请求打到哪」，再查代码 |
| 14 | 冒烟脚本读不到临时文件，数据库也打不开 | Windows 上 `curl` 不认 MSYS 的 `/tmp` 路径；better-sqlite3 打不开跨盘符映射的路径 | 冒烟用的临时文件放仓库根目录，用相对路径；结果一律以 HTTP 响应体核对，不靠本地文件回读 | 冒烟资产放项目内、用相对路径；断言只看 HTTP 层返回 |
| 15 | 检索表单的 `useEffect(() => setQ(initialQ), [initialQ])` 被 ESLint 判为 `react-hooks/set-state-in-effect`，页面无法过 lint | 用 effect 把 props 回写进本地 state，React 19 的 hooks 规则不允许 | 去掉三个同步 effect；服务端页面用 `key={currentHref}` 在地址变化时重新挂载表单，初始值直接来自 URL | 表单状态以 URL 为唯一来源时，用 key 重挂载而不是 effect 同步 |
| 16 | 检索页输入框被拉成 220px 高，标签与输入框之间出现巨大空白 | 共用的 `.filter-search` 是横向工具条里的 flex 项（`flex: 1 1 220px`），放进纵向字段后 flex-basis 被当作高度 | 在 `.search-query .filter-search` 覆盖为 `flex: 0 0 auto; width: 100%` | 复用横向工具条样式前先确认父容器方向；截图验收时看真实渲染，不只看 DOM |
| 17 | 下载接口响应头是 `filename*=UTF-8''.txt`，中文文件名整段丢失 | RAGFlow 回传的文件名已被它过滤掉非 ASCII 字符，只剩扩展名；路由优先用了 `file.filename` | 下载名优先取本地 `ref.documentName`，同时输出 `filename="download.txt"` 兜底与 `filename*=UTF-8''<原名>`；服务端实测响应头已还原中文名 | 外部系统回传的展示字段不可信；下载名以本地记录为准，并给不支持 `filename*` 的客户端留 ASCII 兜底 |
| 18 | `sync-service` 的 8 项用例在真实时间越过固定 `NOW` 后全部失败（`claimed: 0`） | 入队写的是系统时钟，认领用的是测试里的固定 `NOW`；真实时间超过 `NOW` 后任务被视为「尚未到期」 | 每个用例前 `vi.useFakeTimers()` + `vi.setSystemTime(NOW)`，用例后恢复真实计时器 | 涉及「到期时间」的测试必须同时固定系统时钟与业务时间基准，避免随时间失效 |
| 19 | 访问不存在的对象，页面正确显示「找不到这条内容」，但 HTTP 状态是 200 | `src/app/workspace/loading.tsx` 让页面先流出 shell，响应头已发出后 `notFound()` 无法再改状态码 | 未改结构：页面在浏览器里展示正确；仅记录为已知行为（带 streaming 的 App Router 路由普遍如此） | 需要严格 404 状态码的公开页面，不要在该路由段放 `loading.tsx`，或在更早的边界判定存在性 |
| 20 | `npm run lint` 一次报出 573 个错误，全部指向 `infra/lightrag/.venv/.../webui/assets/*.js` | `globalIgnores` 只写了根目录 `.venv/**`，没有匹配嵌套的 `infra/lightrag/.venv` | 在 `eslint.config.mjs` 的 `globalIgnores` 加入 `**/.venv/**` | 引入带 venv 的本地服务时，先确认 lint / tsc 的忽略规则覆盖嵌套目录，再跑全量检查 |
| 21 | `/graph` 页在 `useEffect` 里调用 `loadGraph(selected)` 触发 `react-hooks/set-state-in-effect`，lint 失败 | 挂载时同步 setState；而且首屏数据本来可以在服务端拿到 | 删除挂载 effect：首屏邻域由服务端组件查询后作为 `initialSubgraph` 传入，切换实体只在点击事件里加载 | 初始数据优先服务端取；客户端 effect 只用于订阅、轮询等真正的副作用 |
| 22 | `visibleEdges` 返回类型丢失了 `description`，TS 报 `TS2339` | 函数参数与返回值被写成不含业务字段的最小形状 | 改成泛型 `<T extends { source: string; target: string }>`，原样返回入参元素 | 纯函数只约束它真正读取的字段，其余字段用泛型透传 |
| 23 | `POST /documents/paginated` 用小 `page_size` 时返回参数错误 | LightRAG 要求 `page_size ≥ 10` | 适配器统一用 50 / 100 / 200 的分页大小 | 外部 API 的边界值写进适配器常量与集成文档，不散落在调用点 |
| 24 | 在 Windows 终端用 `curl -d '{"q":"中文问题"}'` 提交，服务端收到乱码或 JSON 解析失败 | Git Bash / cmd 的编码与引号转义叠加，中文内联 JSON 不可靠 | 把请求体写进文件，用 `curl --data-binary @question.json` | 含非 ASCII 的请求体一律走文件，不内联到命令行 |
| 25 | 运行 LightRAG / 脚本时 Python 抛 `UnicodeEncodeError: 'gbk' codec can't encode ...` | Windows 控制台默认 GBK，日志里的中文 / 符号无法编码 | 设置 `PYTHONUTF8=1` 与 `PYTHONIOENCODING=utf-8` 后再启动 | 本机 Python 服务统一 UTF-8 环境变量；启动脚本里写死 |
| 26 | 直接执行 `python` 打开的是 Windows 应用商店的占位程序，或装错解释器 | Windows 的 `python` 可能是 Microsoft Store 别名，不是真实解释器 | 使用 `infra/lightrag/.venv/Scripts/python.exe` 绝对路径，或 `py -3` | 本地服务脚本显式指向 venv 解释器，不依赖 PATH 里的 `python` |
| 27 | 关键实体（如「品牌蓝」）在 `/graph` 里点开是空图，但 LightRAG 数据里明明有 `#2B6CB0 → 品牌蓝` | `/graphs` 只沿**出边**遍历；该实体只有入边 | 不修改 LightRAG；在集成文档标注「有向子图」，前端提示可从来源实体进入 | 对外部图接口的遍历方向做最小实测（取一条已知边，从两端分别查），再设计交互 |
| 28 | 图谱问答返回了答案，但 `references` 为空 | 测试文档的 `file_path` 是不带 `pakp:obj:` 前缀的 `smoke-design-tokens.txt`，被归属过滤器丢弃 | 不改过滤规则：只有本系统写入的文档才映射回业务对象；用真实对象同步的数据复测 | 来源标识在写入时就带上，读取侧只认自己的前缀；测试数据也要走同一入口 |
| 29 | 生产模式 `next start` 打开页面返回 307，看起来像路由坏了 | `.env.local` 是 `AUTH_MODE=logto`，未登录访问受保护页会跳转登录 | 冒烟时用进程环境变量覆盖 `AUTH_MODE=mock` 启动；不要改 `.env.local` 以免影响登录联调 | 区分「配置导致的预期跳转」与「路由错误」；先看响应头 `Location` |
| 30 | 调 `/api/graph/sync` 返回 `candidates: 0`，以为同步逻辑失效 | 生产模式启动时 `DATABASE_PATH` 未设置，用的是空的 `data/app.db`；开发数据在 `data/dev.db` | 确认服务连的库与预期一致后再判断；这不是代码缺陷 | 冒烟前核对 `DATABASE_PATH`；把「候选为 0」与「同步失败」分开表述 |
| 31 | Logto 登录回调 500：`callback_uri_verification.redirect_uri_mismatched`，"The callback URI mismatches the redirect URI." | `@logto/next` 的 `handleSignIn(config, searchParams)` 拿到 `URLSearchParams` 时会按 `${baseUrl}/callback` **自行拼**回调地址，和登记 / 实际路由 `/api/logto/sign-in-callback` 不一致 | 回调路由改为传完整 URL：`handleSignIn(createLogtoConfig(), new URL(request.url))`；实测换码 307 → `/workspace 200` | SDK 的「助手函数」要读源码确认它替你拼了什么；回调地址以控制台登记值为准，并用假 code 复测错误是否变成预期的 `sign_in_session.not_found` |
| 32 | Logto 注册 / 改密提交时 `POST /api/experience/profile` 500，容器日志 `getaddrinfo EAI_AGAIN api.pwnedpasswords.com` | Logto 默认做弱密码泄露检查，本机无外网 DNS 时直接失败 | compose 的 logto 服务加 `ENABLE_PWNED_PASSWORD_API: "false"` 并 `docker compose up -d` 重建容器 | 自托管服务默认会回调外网；无外网环境先查容器日志的 DNS 错误，再决定关哪个能力 |
| 33 | 用后台 UI 自动化在 ego/Chrome 里点导航，地址栏与标题都变了，页面内容却是上一页、刷新后空白 | Chromium 对**被遮挡的后台窗口**冻结渲染；渲染器没提交新导航、可访问性树为空 | 改用无头 Chromium（`chrome-headless-shell` + CDP）跑完整登录与页面断言；前台窗口完全不受影响 | 后台自动化只用于「能用 UIA 语义操作」的控件；要断言渲染结果，用无头浏览器或真实前台，不要靠后台截图判断页面状态 |
| 34 | 新增的 `scripts\*.ps1` 一运行就报「字符串缺少终止符」等解析错误 | Windows PowerShell 5.1 把无 BOM 的 UTF-8 当 ANSI 读，中文字符串被截断 | 用 Node 在文件头写入 `U+FEFF` 后另存为带 BOM 的 UTF-8；`-Check` 复测正常 | 含中文的 `.ps1` 显式存为带 BOM 的 UTF-8，或改用 `pwsh`；编码问题先看字节头，不先怀疑语法 |
| 35 | `schtasks /create` 注册开机自启返回「拒绝访问」 | 注册计划任务需要管理员权限 | 改为在当前用户「启动」文件夹放快捷方式（`scripts/install-autostart.ps1`），免提权，`-Remove` 可撤销 | 非提权场景优先用启动文件夹；确需系统级任务时再提权 |
| 36 | 冒烟脚本报告「创建资产失败」，但数据库里对象已建成 | 断言读 `body.data.id`，接口实际返回顶层 `id` | 改为 `body.id ?? body.data.id`，复跑 9 项全过 | 冒烟失败先打印并核对响应体结构，再怀疑业务逻辑 |
| 37 | 内容检索的输入框占位文字被一个圆圈 / 放大镜叠在第一个字上 | `.text-input` 与 `.filter-input` 都设了 `padding`，后者的 `padding-left: 34px` 被前者的 `padding` 简写整体覆盖（同优先级、后者声明更早） | CSS 选择器提到 `.text-input.filter-input`（更高优先级）显式给出 34 / 32 px；同时隐藏 `::-webkit-search-cancel-button` / `::-webkit-search-decoration` 原生清除图标 | 复用的基类若用 `padding` 简写，修饰类不要只写单边 `padding-left`；组件级覆盖用「基类 + 修饰类」组合选择器钉死 |
| 38 | 侧栏点「最近内容」「作品进程」没反应，地址栏 hash 变了但页面不滚动 | Next 的 `<Link>` 在同一路径、仅 hash 变化时不会触发滚动（App Router 把它当作同一路由的软导航） | 页内锚点改成原生 `<a href="/workspace#recent">`；目标区块加 `scroll-margin-top`，避开吸顶工具条 | 页内锚点一律用原生 `<a>`；跨页数据导航才用 `<Link>` |
| 39 | `npx` / `npm run` 在项目路径 `D:\projects\Personal Asset & Knowledge PlatformV2` 下报 `'Knowledge' 不是内部或外部命令`，或 `Cannot find module 'D:\projects\next\dist\bin\next'` | 路径含空格**和** `&`：`.cmd` 中间层把 `&` 当命令分隔符，npx 又按空格拆路径 | 脚本与临时命令都走 `node node_modules/next/dist/bin/next …`、`node node_modules/vitest/vitest.mjs …`，不再经过任何 `.cmd` shim | 含 `&` 的目录里不使用 npx / 全局 bin；用 `node <绝对 bin 路径>` 直调 |
| 40 | 想另起一个实例验证生产构建：第二个 `next dev` 被拒绝；复制项目目录后 Turbopack 构建报 `Could not find the Next.js package … Files outside of the workspace root are not compiled` | Next 16 同一目录只允许一个 dev（`Another next dev server is already running… PID`）；临时目录里的 `node_modules` 是指向原仓库的 junction，Turbopack 拒绝解析工作区外的包 | 不碰在跑的 dev 服务：复制到临时目录后用 `next build --webpack`（webpack 不限制包在工作区外），再 `next start -p 3211` 改端口验证；验证完清理临时目录 | 需要第二实例时复制目录 + `--webpack` + 换端口；先 `netstat` 看端口占用，不 kill 用户的 dev 进程 |
| 41 | 三栏框架上线后，导航栏被撑到 346px 高、目录横跨 1604px，第三列掉到下一行 | `.app-frame` 只声明了两列 `76px minmax(0,1fr)`，出现第三个子元素时 grid 自动换行，目录被塞进剩余宽度 | 用 `.app-frame:has(> .directory)` 显式声明三列 `76px 224px minmax(0,1fr)`，含列表时 `.has-list` 再声明四列 `76px 224px 340px minmax(0,1fr)`；≤1100px 的媒体查询同步改成两列 | 结构性布局用「根容器 + 子元素存在性」表达列数；改列数时同时改断点里的声明，并用无头浏览器读 `getBoundingClientRect` 核对实际列宽 |
| 42 | 工作台服务端 HTML 是 `class="filters"`，客户端水合后变成 `class="filters is-compact"`，Next 开发浮层出现「1 Issue」并报 hydration mismatch | Turbopack 内存模块图里仍是旧编译的 `ObjectFilters`（chunk 里签名还是 `function ObjectFilters({ filters })`），清 `.next` 缓存文件与 touch 源文件都无效 | 重启 dev server（结束 `npm run dev` 的进程树后重新拉起），水合告警消失 | 改了组件 props / 条件类名却只有服务端渲染对、客户端不对时，先排除构建缓存，再怀疑逻辑；重启 dev 比反复改代码快 |
| 43 | 删除 `workspace/[id]/page.tsx`、`workspace/page.tsx` 后 `tsc --noEmit` 报 `.next/types/validator.ts` 找不到模块，即使源码已无引用 | `.next/types/validator.ts`、`routes.d.ts`、`root-params.d.ts` 是上一次构建生成的路由类型，仍指向已删除的路由文件 | 删除这三个生成文件后重跑 typecheck（或清 `.next` 重新生成） | 删路由后先清生成类型再跑类型检查；`.next/types` 只是产物，不要改它来「修」错误 |
| 44 | Markdown 预览里标题和正文一样大，「一级标题」看不出层级 | `.previewPane` 的标题字号引用了 `--fs-22` / `--fs-18`，但 `globals.css` 只定义到 `--fs-20` 与 `--fs-26`；未定义变量让整条 `font-size` 声明失效 | 改为已定义的 `--fs-26` / `--fs-20`；同时检查模块样式里其它 `--fs-*` 引用 | 新写 `var(--token)` 前先 grep 定义；设计令牌的失效是静默的，靠截图验收而不是只读代码 |
| 45 | 批量列表用 `useEffect` 把选中集合与最新 `objects` 求交集，ESLint 报 `react-hooks/set-state-in-effect`，提示级联渲染 | 在 effect 里同步 `setState` 属于反模式；这里本可以直接由 props 推导 | 改成渲染期派生：`selectedIds = pickedIds.filter(id => objects.some(...))`，动作与计数都用派生值，不再回写状态 | 能从 props / state 推导的值不要放进 effect；只有同步外部系统（DOM、订阅）才用 effect |
| 46 | 无头 Chromium 里点「批量导出」出现成功 toast，但下载目录里没有文件 | `chrome-headless-shell` 不落盘普通下载（即使 `Browser.setDownloadBehavior` + `userGesture`）；断言方式错了，不是功能坏了 | 在页面里替换 `URL.createObjectURL` 捕获 Blob，读取 `blob.text()` 验证内容与类型（`text/markdown`）；真实浏览器里仍是标准 `<a download>` 行为 | 无头环境断言「生成了什么」而不是「文件落在哪」；下载类功能要么捕获 Blob，要么在真实浏览器里点一次 |
| 47 | 浏览器里打开工作台，Next 开发浮层报 hydration mismatch，diff 只有 `<body>` 上的 `data-atm-ext-installed="1.30.02"` | 浏览器扩展在 React 加载前往 `<body>` / `<html>` 挂私有属性，服务端 HTML 里没有，属于外部注入而不是应用渲染差异 | `src/app/layout.tsx` 给 `<html>` 与 `<body>` 加 `suppressHydrationWarning`，只屏蔽这两个元素自身的属性 / 文本比对；子树水合问题照常报告。用「在应用脚本前注入同名属性」的无头测试复测：属性存在、控制台零告警、列表与顺序正常 | 水合 diff 只涉及 `<html>` / `<body>` 自身属性时先怀疑扩展（`data-*-ext-*`、`cz-shortcut-listen` 等）；`suppressHydrationWarning` 只加在根元素，不要扩大范围 |
| 48 | 正文编辑器贴长文后完全不能上下滚，工作台列表也看不到垂直滚动条 | ① `.markdownPane` 只声明了列轨道，隐式行高是 `auto`，被 240 行正文撑到 14900px，再由 `overflow: hidden` 裁掉，左右两栏都拿不到有界高度；② `.writePane` / `.previewPane` / `.input` / `.previewScroll` 缺 `min-height: 0`，flex 子项的自动最小高度等于内容高度；③ Windows 11 的 Chromium 默认是覆盖式滚动条，静止时不绘制滑块，长列表看起来就像「没有滚动条」 | `.app-frame` 与 `.markdownPane` 显式 `grid-template-rows: minmax(0, 1fr)`；书写区、预览区、textarea 补 `min-height: 0`；列表与编辑器滚动区用 `::-webkit-scrollbar` 换成 10px 常驻细条，`.record-scroll` 加 `scrollbar-gutter: stable`。实测 240 行正文两栏独立滚动，45 条数据在 1680 / 1280 / 860 宽均能滚到底 | 由 flex / grid 容器负责滚动的区域，容器必须有确定高度（`minmax(0,1fr)`）+ 子项 `min-height: 0`；判断滚动条是否存在看 `offsetWidth - clientWidth`，不要只看截图——无头 Chromium 截图不绘制滚动条滑块；也不要同时写 `scrollbar-width` / `scrollbar-color`，Chromium 会因此忽略 `::-webkit-scrollbar` |

| 49 | `0005` 迁移里 `DROP TABLE objects` 直接失败：`FOREIGN KEY constraint failed`，即使 SQL 里先写了 `PRAGMA foreign_keys = OFF` | Drizzle 的 migrator 把**整批迁移包在一个事务**里执行；SQLite 的 `PRAGMA foreign_keys` 在事务内是空操作，改不动当前连接的外键状态，`library_events.object_id → objects.id` 仍然生效 | 外键开关移到 `migrate()` 外层：`sqlite.pragma("foreign_keys = OFF")` → `migrate(...)` → `finally` 里恢复 `ON`；迁移后跑 `PRAGMA foreign_key_check`，非空即抛错拒绝启动 | 任何需要重建 SQLite 表的迁移都不能依赖迁移文件内的 PRAGMA；开关放在调用方，并用 `foreign_key_check` 做收尾断言，别假设「脚本写了就生效」 |
| 50 | 迁移在真实库上跑坏了才发现问题，回滚无从下手 | 初版只想着「迁移写对」，没有迁移前备份 | `openDatabase` 在有未应用迁移时先用 `VACUUM INTO` 备份为 `<db>.bak-<ISO>`（WAL 下也是完整快照），再执行迁移；演练脚本 `scripts/rehearse-vocabulary-migration.mjs` 在副本上先跑一遍 | 破坏性迁移固定三段式：**备份 → 副本演练 → 真库执行**；演练脚本与自动化测试各留一份 |
| 51 | 标签在不同入口写进去变成多条记录（`工具类` / `工具类 ` / `ＴＯＯＬ` / `tool`） | 归一化逻辑散落在表单、服务、迁移三处，规则各写各的 | 抽 `src/domain/vocabulary.ts` 为唯一实现：分隔符 → trim → 空白折叠 → NFKC → 小写键 → 按键去重 → 长度；`tags.normalized` 建唯一索引，写入用 `ON CONFLICT DO NOTHING` 后回查 | 「同一概念只有一份规则实现」优先于「各处就地校验」；唯一索引是并发下的最终兜底，测试要同时覆盖纯函数与直写数据库 |
| 52 | 词表使用次数把已软删的对象也算进去，删除保护误报「仍被引用」 | 计数只按 `objects.format` / `object_tags` 聚合，漏掉了 `deleted_at` 条件 | 计数统一 `join objects ... and objects.deleted_at is null`；单测固定一条「软删后计数归零、标签可删」的用例 | 软删是全局语义，任何统计、导出、校验都要显式带 `deleted_at is null`；把这条写进领域文档，而不是每个查询自己记 |
| 54 | 词表管理页的「↑ / ↓」点了没反应，序号与列表顺序都不变 | 新排序值按「相邻行 ∓10」算（`neighbour.sortOrder - direction * 10`），上移时方向为 -1，结果等于 `prev.sortOrder + 10`，正好是当前行的下一个位置，PATCH 后列表原地不动；`sort_order` 手动改过、间隔不足或相等的两行也是同样结果 | 改成交换相邻两行的 `sort_order`；两行值相等时先按当前顺序把整表重排为 10、20、30…，再交换。真实登录实测 up/up/down 三次位置均正确 | 做「交换两条记录的顺序」时不要用相对偏移推算新值，除非能保证取值互不相同且间隔足够；行序操作的测试要断言**整表顺序**，只断言「接口返回 200」会漏掉这类静默失败 |
| 55 | 管理页删除被引用项时拿不到引用数量，弹不出「迁移到… / 合并到…」 | `src/lib/api-error.ts` 的 `apiRequest` 只把 `{error:{code,message}}` 拼成一句人话，`details`（含 `usage`）在解析时被丢掉，客户端无从判断是 409 还是普通失败 | 词表管理页不再走 `apiRequest`，自写 `request<T>()` 保留 `code` 与 `details`，`isConflict()` 按 `code === "CONFLICT"` 判定后再读 `usage` | 统一错误信封的价值在于 `details` 能被消费端读到；凡是需要按错误码分支的页面，先确认手里的客户端没把结构化信息压平成字符串 |
| 56 | 词表管理页的验收必须用管理员，但 `ADMIN_SUBS` 里只有用户本人的 `sub`，且其账号从未在应用内登录过 | 管理员判定读环境变量；测试账号 `pakp_test` 不在名单里，进 `/admin/vocabulary/*` 只能看到 403 兜底 | 备份 `.env.local`，临时把测试账号 `sub` 加入 `ADMIN_SUBS` 并重启开发服务，用无头 Chromium 跑完整实测；结束后从备份还原、再重启一次并访问 `/workspace` 确认 200 | 后台功能的自动化验收需要一个可登录的管理员身份，这件事要提前规划；临时提权必须「备份 → 改 → 重启 → 验 → 还原 → 再重启」，并在报告里写明，不能让它变成永久配置 |
| 57 | 实测脚本判定「控制台无报错」，实际控制台里有两条 409 | 删除被引用项的 409 是**预期业务冲突**，浏览器会把失败的 fetch 记成 `console error` | 断言时把这些 URL / 状态码排除，只对剩余条目判定为 0；报告里单独说明「两条预期 409」 | 「无报错」这类断言要写清口径：网络层的 4xx 与真正的 JS 异常不是一回事，先分类再计数 |
| 58 | 代码已改、测试也过，用户打开 3000 端口仍说「还是修复之前的样子」 | 3000 上跑的是几小时前的生产构建，开发服务器改的代码没有进生产包 | 汇报前执行 `npm run build` 并重启 3000；验收也在生产包上做 | 交付口径固定为「用户只看生产包」：预览与验收前先确认端口上的构建时间，不拿 dev 的临时效果当已交付 |
| 59 | 液态玻璃的跟随高光做出来了，但 `pointermove` 挂在整块内容区上，每个指针移动都进一次 handler 再 `closest` 过滤 | 按「一个容器统一处理」的惯性写，违背参考实现「mousemove 别顺手往整个页面绑」 | 把 `pointermove` / `pointerleave` 分别挂到每张 `.graph-glass` 卡自身，回调直接用 `currentTarget`；仍用 rAF 合并、直接写 CSS 变量 | 交互事件按「受影响的最小元素」绑定；验收时用 `DOMDebugger.getEventListeners` 检查监听到底挂在谁身上，而不是只看效果 |
| 60 | ADR-027 里写的令牌名、断点与实现对不上（`--graph-glass-spot` vs `--graph-glass-pointer-core`、`≤1279px` vs `≤1000px`） | 决策先于实现写，实现时改了命名与断点，文档没有回改 | 实施落地后按 CSS / TSX 逐项核对 ADR，把令牌表、梯度参数、变量名、断点改成代码事实 | ADR 定稿前必须对照实现；令牌名、断点、间距这类可计算的数字以实现为准，不凭记忆 |
| 61 | 用 `NEXT_DIST_DIR` 起隔离实例后，`tsconfig.json` / `next-env.d.ts` 被 Next 改写 | Next 16 会按 distDir 重写生成的类型路径 | 验完 `git checkout -- tsconfig.json next-env.d.ts`，再跑一次 typecheck | 隔离构建前记录这两个文件的原始状态，收尾一并还原；提交前 `git status` 不得出现它们 |

| 58 | 升级到「本地六表授权」后，所有人第一次登录都只拿到只读，后台没有人能进 | 原实现把 `ADMIN_SUBS` 当管理员名单（环境变量即授权）；改成表驱动后，老账号在 `users` 里还不存在，若引导只在「已有 owner」时补角色，第一登录者会落到默认 `viewer` | `resolveSessionAccess` 在 `countActiveOwners() === 0` 且 `sub` 在 `ADMIN_SUBS` 里时授予 `owner` 并写 `user.bootstrap`；owner 落库后环境变量退出授权；另留 `npm run admin:grant -- <sub> [role]` 离线恢复。实测：真实库迁移后本人成为 owner，清空 `ADMIN_SUBS` 再登录仍是 owner | 换授权模型时必须设计「空库 / 老库第一次登录」路径，并单独验证「清空环境变量后老 owner 仍能进」；演练在真实库副本上跑一次引导，不只看测试库 |
| 59 | 迁移演练时用户建出来了，却没有 `user.bootstrap` 审计；后台显示「无审计记录」 | 新建分支写成「插入用户与角色后 `return`」，drizzle 的同步事务回调提前结束，末尾统一写审计的代码被跳过 | 去掉分支里的 `return`：新建时只插入目标角色，已有用户走 `onConflictDoNothing` 追加，审计固定放在事务末尾 | 事务回调保持单出口；分支里不要 `return`，否则后续语句（审计、关联、计数）会被静默跳过，而且业务写已经成功，很难从结果反推 |
| 60 | `admin:grant` 新建的 owner 同时带 `owner` 与 `viewer` 两个角色 | 脚本照搬「新用户先给默认 viewer，再追加目标角色」，把默认角色当成了必填 | 新建时只写目标角色；只有已存在用户才追加。用例断言完整角色集合 `["owner"]`，不是「包含 owner」 | 「默认角色」只适用于普通首次登录；管理入口创建账号时角色由参数决定。角色断言写全量集合，避免并集掩盖多余角色 |
| 61 | 路由里加了守卫后，TS 仍报 `session` 可能为 null，只能用 `session!.sub` | `requirePermission` 返回「响应或 null」，编译器无法据此收窄传入的另一个变量 | 路由固定顺序「先取会话 → 守卫 → 通过后使用 `session!`」；页面侧改用 `hasPermission(session, key)` 分支渲染 `AdminForbidden` | 类型收窄不跨函数；非空断言只放在守卫已通过的分支，不要用它掩盖真正的空会话路径 |
| 62 | 未登录态搜索框是 `disabled`，点上去什么也不发生，用户不知道要去登录 | 禁用控件不派发 click / 不接收指针事件，`onClick` 挂在输入框上等于没有 | 在输入框上叠一层绝对定位的透明 `button`（`.galaxy-search-login-layer`）指向登录地址，`aria-label` 写「登录后可检索内容」 | 任何「点这里去登录 / 去某处」都要挂在覆盖层或包裹元素上，不能挂在被禁用的控件上；禁用态同时保留 `aria-disabled` |
| 63 | 验收脚本读 `__galaxyStats` 一直是 `frameSamples: 0` / `avgFrameMs: 0`，看起来像画布没跑 | 统计只在第 180 帧发布一次，而脚本在 60 帧左右就读了 | 改为每 30 帧发布一次、第 180 帧定格（`frameSamples === 180 \|\| frameSamples % 30 === 0`） | 运行期读数要留「早期快照」；看到空数据先分清「没运行」和「没上报」 |
| 64 | CDP 里 `form.requestSubmit()` 和 `Input.dispatchKeyEvent` 都没触发跳转，同一页面在 agent 浏览器里按回车却正常 | 无头 target 未获得焦点时输入事件会被丢弃；脚本合成 submit 与真实按键路径也不等价 | 先 `Page.bringToFront`，再用 `Input.insertText` + keyDown/keyUp，并 `waitFor('location.pathname === "/search"')` 再断言地址 | 键盘类断言必须走真实按键路径，成功条件用「地址 / DOM 真的变了」而不是固定 `sleep` 后读 URL |
| 65 | 抽屉打开后焦点落在关闭按钮上，第一次 Tab 跳过头两项 | effect 取的是「DOM 顺序第一个可聚焦元素」，而 head 里的关闭按钮在 nav 之前 | 明确聚焦第一个 `.galaxy-drawer-item`，并在实测里断言 `document.activeElement` 的文本 | 焦点管理按「语义第一项」而不是「DOM 第一项」；抽屉 / 弹层的实测要连焦点一起断言 |
| 66 | 移动端量到搜索框 `top=258`，设计稿是 264 | 眉标 `line-height` 与搜索框 `margin-top` 叠加后整体少 6px，靠「看起来差不多」调不出来 | 眉标显式 16px 行高、移动端搜索框 `margin-top: 16px` 后重测到 264 | 按设计稿逐元素量 `top / height / width`，差 2px 以上就找来源，不用肉眼验收 |
| 67 | 星系画出来只有两道细弧线，没有「银河」的实体感 | 只实现了粒子层，漏掉设计稿与样稿里的盘面径向渐变与核心辉光两层 | `resize()` 时预建 disk / core 两个 `CanvasGradient`，`draw()` 先填盘面椭圆与核心椭圆再画粒子，不逐帧新建渐变 | 与设计稿对照要按「图层」逐层核，不能只看「星星有没有出现」；渐变缓存跟着尺寸重建 |
| 68 | 移动端把触控区从 22px 撑到 44px 后，键盘聚焦时露出一个 44×56 的青色方框 | 焦点环画在按钮本体上，而可见三角只有 22px 宽，两者不再是同一个形状 | 触控区与视觉分离：`::before` 画三角（`clip-path`），焦点环改用不带 `clip-path` 的 `::after` 描边 26px | 放大触控区时要同步调整焦点指示的载体，否则无障碍焦点看起来像渲染缺陷 |
| 69 | 主题切换组件在 `useEffect` 里同步 `setState`，React 19 的 `react-hooks/set-state-in-effect` 直接报 error | 想把首帧脚本写进 `<html>` 的主题同步到组件状态，但 effect 内同步写状态会触发级联渲染 | 改用 `useSyncExternalStore` 订阅 `<html data-theme>` 的 `MutationObserver`，组件不另存一份状态；`applyTheme` 写属性后自动重渲染 | 外部系统（DOM / localStorage）已有真相时用 `useSyncExternalStore`，不要在 effect 里镜像成 state |
| 70 | 对比度校验在浅色主题下大面积误报：正文色拿来和深色导航底配对、金色用在白底上 | 配对表是按深色单主题写的，Phase 5b 加主题后同一语义令牌在不同主题的用途不同 | 校验脚本逐主题解析 token 块，新增 `text-on-dark*` / `rail-active-fg` / `accent-contrast` 等语义令牌，按实际用途重写 23 组配对 | 对比度校验必须按「令牌在页面上的真实用途」配对，而不是按颜色名猜；新增主题先跑校验再截图 |
| 71 | 主题持久化与强刷防闪测试假失败：刷新后总是回到 galaxy | 截图脚本用 `Page.addScriptToEvaluateOnNewDocument` 预置 `localStorage`，这段脚本每次导航都执行，把用户新选的主题覆盖回初始值 | 预置脚本只在首屏用，加载后立刻 `Page.removeScriptToEvaluateOnNewDocument`；强刷前再单独写入用户选择 | 会随每次导航执行的注入脚本只用于「首屏初始状态」，测持久化前必须移除 |
| 72 | 午夜蓝主题的 `--danger-bg` 写成 `rgba(...)`，对比度脚本无法解析 | 校验只接受十六进制色值 | 改成可解析的深色实色 `#2a171b`，并把 `--green-300` 调到 `#4b79b4` 以满足深底 3:1 | 参与自动校验的令牌统一用十六进制；半透明只用于遮罩 / 阴影，不用于需要算对比度的底色 |
| 73 | 改完 `centerY` 后动画态位置正确，但 reduced-motion / 无 WebGL 的静态图仍停在旧位置 | poster 是预生成 JPG，构图参数改了但没有重出 | 把「构图 / 粒子 / 朝向变更 → 必须重出 poster」写进流程；新增 `measure` 命令比较三条路径的核球亮度质心 | 任何影响场景几何的改动都要重出 poster，并用像素实测而不是只看配置值验收 |
| 74 | 星系翻到背面后自转看起来「倒着转」 | 绕 Y 轴 180° 会把局部 +Z 映射到世界 -Z，原来的正 Z 自转在屏幕上变成反向 | `resolveGalaxyComposition` 返回 `spinSign`，翻面时自转角度乘 -1；poster 定格角也走同一系数 | 任何整体镜像 / 翻面都要检查旋转方向，把方向修正放在配置换算层而不是靠手调参数 |
| 75 | 构图放大后星盘越过视口，左右边缘像被切了一刀；同时 centerY 上移 7% 后亮核逼近搜索框 | 星盘直径被调到 100–112% 视口宽，旋臂粒子贴着浏览器边被打断；亮核纵向位置就等于 centerY，上移后净空只剩观感上的「差不多」 | `.galaxy-scene` 三层（静态图 / canvas / CSS 星点）统一加 `clamp(36px, 6vw, 88px)` 四边遮罩让外缘淡出；用 92% 峰值阈值量亮核上沿、和搜索框底边做差，桌面 70px / 移动 69px | 先量基线间距再动 centerY，别凭观感；越界放大必须配边缘柔化，否则浏览器边就是一条直线切口 |

| 76 | 0007 分类统一迁移在演练副本上重建 `objects` 时失败：`FOREIGN KEY constraint failed` / 触发器找不到旧表 | `PRAGMA foreign_keys = OFF` 写在 `migrate()` 的事务里。SQLite 的该 pragma 在事务内是空操作，重建表时旧外键仍然生效 | 迁移脚本在 `migrate()` 之前、事务之外执行 `foreign_keys = OFF`，迁移结束后再 `ON`；`openDatabase()` 启动时仍默认开启外键 | 任何「重命名 / 重建表」迁移都先确认外键开关在事务外；演练脚本与自动化用例都要覆盖「旧结构 → 新结构」整条路径 |
| 77 | 迁移后作品出现空分类，或列表里出现查不到的分类码 | 旧 `work_formats` 的兜底值、`objects.categories` 自由值、`format` 三套来源没有逐一兜底 | 迁移 SQL 先保证每个作品 `category_code` 非空（空则落 `uncategorized`），自由值主值建分类、其余转标签；配 ADR 验证查询：作品空分类 = 0、失联 code = 0、自由值全部能在分类或标签找到 | 迁移脚本把「不变量」写成显式断言，失败即退出码 2；真实库执行前必须先在副本上 `ok: true` |
| 78 | 演练通过、真实库却漏了 WAL 里刚写入的数据 | 直接复制 `.db` 文件会丢掉未 checkpoint 的 `-wal` | 备份统一用 `VACUUM INTO`（一致快照、不带旁文件），再复制备份到临时目录演练；迁移前先停开发服务 | 备份脚本只用 `VACUUM INTO`，不从运行中的库 `cp`；迁移前后各记一次对象 / 分类 / 标签计数 |
| 79 | 自定义新建分类的小弹窗一打开，控制台就报 `<form> cannot be a descendant of <form>`，并在输入框回车时把外层「新建内容」表单提交掉 | 小弹窗渲染在新建弹窗的 `<form className="dialog-form">` 内部，HTML 不允许表单嵌套 | 小弹窗改为 `div[role=group]`，保存按钮 `type="button"`，输入框 `Enter` 手动调用提交函数并 `preventDefault()` | 组件复用在弹窗里时先确认宿主是不是 `<form>`；用浏览器控制台 / CDP 抓 hydration 告警，别只看截图 |

| 80 | 想用 SQLite FTS5 做「不少于 1 个字」的子串模糊查询，两字中文词却一条都查不到 | FTS5 默认分词器按空白 / 标点切 token，CJK 整句是一个 token；trigram 分词器又要求查询 ≥3 字符，「复盘」这类两字词直接无解 | 放弃 FTS5，用 `instr(coalesce(title_norm,''), ?)` 做子串匹配，配 `objects_owner_scope_idx` 收窄候选；1 万对象下词法 p95 ≈7–12ms | 中文子串检索先确认「最短查询长度」；两字词的方案不能依赖 trigram 或空格分词 |
| 81 | `title_norm` 归一化在 JS 与 SQL 两边各写一遍，全角 / 大小写只在一侧生效，查「ＡＢＣ」找不到「abc」 | 写路径、回填、查询三处都各自调用 `toLowerCase()`，且 SQLite 没有 NFKC | 归一化收敛成一个 `normalizeSearchText`（NFKC → `\s+` 折叠 → trim → 小写），写路径、`backfillSearchNorm`、查询参数、内存打分全部调用它；SQL 里不做任何字符串变换 | 影子列方案的第一条规则：归一化只能有一个实现，SQL 侧只比较不计算 |
| 82 | 搜索预览 hook 让全文件 20 条 `react-hooks/refs` 报错，另有一条 `set-state-in-effect` | hook 把 `rootRef` 塞进返回的状态对象里，编译器判定整个 `preview.*` 被 ref 污染；同时用 effect 同步打开下拉、重置状态 | `rootRef` 改由调用方传入；下拉开合 / 状态改成从 `requestable` / `settled` / `dismissedKey` 派生，不在 effect 里 `setState` | hook 返回对象里绝不带 ref；能用派生状态表达的就不要写 effect 同步 |
| 83 | 截图里输入框有值，下拉却始终不出现；同一脚本在另一台机器偶尔正常 | 脚本在 hydration 完成前写入 `value`，React 首次渲染把受控输入重置回空串，之后的 `input` 事件也没了 | 等 `.galaxy-search-input` 出现后再等 900ms，然后 `typeStable()`：写值 → 300ms → 读回 `input.value`，不一致就重试（最多 6 次） | 受控输入的无头输入必须「写后读回」，一次写成功不代表 React 收到了 |
| 84 | 语法错误块被压成窄条、末尾的 `^` 几乎看不见 | 错误块原来放在 `.search-query` 这个 `align-items: flex-end` 的 flex 行里，宽度被挤压；`^` 与正文同色，在两字中文之间对不齐也不显眼 | 错误块移到 `<form>` 末尾并给 `flex: 1 0 100%`；`^` 那一行单独加 `.search-syntax-caret`，用 `--warn-fg` 加粗，旁边补「第 N 个字符附近」 | flex 表单里的整行提示必须显式 `flex-basis: 100%`；位置指示类符号要单独给颜色，别指望正文色 |
| 85 | mock 截图实例接上页面后，头像菜单永远点不开：`aria-expanded` 始终 `false`、`document.readyState` 在 `complete` / `interactive` 之间抖动、dev 日志每 300ms 一条 `✓ Compiled in 0ms` | `DATABASE_PATH` 放在项目目录内（`data/capture-6c.db`），SQLite 的 `-wal` 每次写入都改 mtime，Turbopack 判定「文件变了」→ 重编译 → HMR 整页 reload → 页面又发请求又写库 → 无限循环，菜单还没水合就被下一次导航清掉 | 把数据库移到项目目录外（`%TEMP%/pakp-capture-6c/`），重启 dev 后循环消失；截图脚本改为等触发按钮有非零尺寸、再等 1.5s 水合才点击 | dev server 监听的目录里不要放运行时会写的文件（SQLite / 日志 / 缓存）；「点击没反应」先看服务端日志有没有在刷重编译 |
| 86 | 同一套主题色点，在弹层里显示成当前主题的颜色，换主题预览全部同色 | 色点改成读 `var(--bg)` 这类主题 token 后，token 的作用域是 `[data-theme]` 选择器；只在 `<html>` 上有当前主题，色点自然全部拿当前主题的值 | 每个主题选项的色点容器加 `data-theme={item.id}`，四个圆点分别读对应 token；截图脚本逐点比对 `getComputedStyle().backgroundColor`，16 个值全部等于迁移前的 hex | 变量作用域靠属性选择器时，跨作用域预览必须自己造一个带该属性的包裹元素，而不是在 JS 里换颜色 |
| 87 | `check-theme` 按 ADR 写的基线 20 报违规，实际字面量 28 | ADR-021 定基线时还没做 Phase 5c 边缘柔化，后来 `.galaxy-scene*` 三层遮罩新增了 8 个 `#000`；静态基线不会跟着 CSS 演进 | 脚本基线取 **26 = 20（ADR）+ 8（柔化新增）− 2（本轮用 `color-mix` 清掉）**，算式写进常量注释；`03_DECISIONS.md` 不改 | 「基线型」规则要在脚本里写明每段差额的来历；数字对不上先查规则制定之后有没有新增同类写法，不要直接调大基线 |

| 88 | 照抄 ADR-022 附录 A2 的 `GraphNode.hop: GraphHop`（1–3），单测里中心节点的 hop 实际是 0，类型靠 `as` 硬转，布局会按 1 跳把星核放进 85 半径的环 | 同一条规则里的 BFS 定义「从 center 出发」天然让中心距离为 0；类型区间是按「请求深度」写的，被复用到节点距离上 | 冻结件里单列 `GraphNodeHop = 0|1|2|3`（`GraphHop` 仍只用于 depth 与边所在环）；边的 hop 取两端更远的那个并夹在 1–2 | 冻结契约前先用最小例子跑一遍规则（单节点、中心 + 1 跳、碎图），类型对不上就地记录偏离，不要用 `as` 糊过去 |
| 89 | 状态条分不清「构图进度接口请求失败」和「还没请求」：两种情况下 `status` 都是 null，`sources.status` 永远是 skipped | 契约把「没拿到」统一写成 null，但 A5.2 又要求 graph ok + status 失败时显示「构图进度暂不可用」 | `GraphBuildInput` 增可选 `statusFailed`，null + false → skipped、null + true → error；状态与数据仍分开传 | 接口的「null」一旦同时承担两种含义，就要在契约里补一个显式位，而不是让调用方猜 |
| 90 | 窄屏（<760px）首帧所有节点挤在画布四条边上，之后怎么缩放都不恢复 | 首帧先用 `FALLBACK_SIZE`（760 宽）排一次，Layout 再按真实宽高把锚点 `clamp` 进 `padding` 并标 `pinned`；锚点一旦 pinned，后续 tick 不再松手，等于把「错误的位置」永久固化 | 首帧尺寸用 `null` 表示、不出图，等第一个 ResizeObserver 回调再排；`anchorsForSize` 在宽高变化时丢弃全部锚点、整图重排。回归测试与截图脚本都按 760 → 390 复现：旧锚点 >50% 贴边，重排后 0 个 | 任何「沿用上一帧位置」的缓存都要带尺寸版本；「首帧先估一个尺寸」看似稳，实际会把估算误差写进布局状态 |
| 91 | 换中心失败时，标题和舞台把新中心配在旧的子图上 | 渲染用的中心直接取 URL 的 `focus`，而数据是上一次成功加载的子图；失败分支又没有区分「有没有旧图」 | 新增 `loadedCenter`（只在 fetch 成功时更新），标题 / 舞台 `focusId` / view-model 一律用它；加载中在舞台上浮「正在载入 X 的邻域…」；失败只出横幅并保留旧图。验收时发现 `__boom__` 根本不在「中心」下拉里——ADR-011 会过滤掉没有本账号内容参与的实体，于是改用真实标签 + mock 只打挂 2 层展开（1 层探测照常成功，标签才会留在列表里） | 「请求中的参数」与「已生效的参数」必须分开存；失败态验收要用真数据，专门造的假标签会被上游过滤掉 |
| 92 | 显式 `?mode=2d` 时，无 WebGL / reduced-motion / 移动端 / 超大图四条降级分支与文案全都走不到 | 判定函数入参 `urlMode` 被塞成当前模式 `"2d"`，`selectGraphMode` 第一分支就返回 `url-2d`，后面的分支永远不执行 | `urlMode` 传 URL 原值；只在 `decision.mode === "3d" && !THREE_D_READY && decision.reason !== "url-3d"` 时回落 2D 一次，`reason` 保留判定函数的结论。保留 `url-3d` 分支是因为 3D 桩与「星系」按钮需要一个可达入口 | 判定类函数不要给它「当前结果」当输入——会把判定变成回声；回落逻辑写在调用方一次，并显式列出不回落的情形 |
| 93 | 3D 星系默认就在自转，用户找不到关掉的开关 | 容器的 `autoRotate` 初值写成 `true`，且没有对外入口；ADR-022 A8 要求默认关闭 | 容器持有 `autoRotate` state，默认 `false`；工具条加「自动旋转」按钮（`aria-pressed`），reduced-motion 下整颗按钮不渲染；场景只收到 `autoRotate && !reducedMotion`。截图脚本断言 `aria-pressed="false"`，模拟 reduced-motion 后按钮消失 | 「默认值」也是需求，按 ADR 抄；动效开关要和 reduced-motion 用同一个条件 |
| 94 | `three` / `react` 用 `^` 浮版本，`@react-three/fiber` 的 peer 范围与新 React 撞车 | 依赖写的是 caret 范围，装的时候 `react` 升到 19.3.1、`three` 到 0.187.0；fiber 9.x 的 peer 是 `react >=19 <19.4` | `package.json` 全部改成精确版本：`three` / `@types/three` `0.187.0`、`react` / `react-dom` `19.3.1`、`@react-three/fiber` `9.8.2`；`npm install` 后 `tsc --noEmit` 复跑。fiber 只安装、不 import，3D 由 B 线接 | 渲染 / 框架依赖一律锁精确版本并核 peer 范围；装完先跑 typecheck，再谈功能 |
| 95 | 2D 阅读时边几乎看不见；浅色主题下更糟 | 2D 覆盖组沿用了 3D 背景细边的半透明色，alpha 合成到深色画布后对比度不足 1.5:1；而 3D 的细边本来就只是空间装饰 | 2D 覆盖组把普通边提到 42%（3.63:1）、强边 62%（6.91:1）；`check-contrast.mjs` 单独解析 `[data-surface="graph"][data-mode="2d"]` 块并按 3:1 校验；3D 背景细边明确标为「装饰纹理，非信息载体」，只要求可见 | 带 alpha 的颜色必须先合成到真实底色再算对比度；「同名令牌」在不同渲染面可能承担不同职责，验收要按渲染面分组 |
| 96 | 验收脚本偶发「Runtime.evaluate 超时」或整轮跑十几分钟不结束，重启后又一切正常 | 上一轮被中断留下的 `next start-server` 与 headless Chrome 仍占着 3123 / 9338，新脚本的健康检查打到旧实例、CDP 连到旧浏览器，`Runtime.evaluate` 就挂住；另外失败态场景自己的 500 与服务端日志被当成错误计入 | 脚本加端口占用前置检查并直接报错、`Runtime.evaluate` 加 25 秒上限、失败态按 URL / 文本白名单放行、`PHASE6D_STEPS=` 支持只跑指定步骤；跑前清理残留进程（问题 91 的排查过程也依赖这一步） | 截图脚本的端口与浏览器进程要当成「独占资源」：跑前检查、跑后回收；卡住时先看有没有旧进程，再怀疑被测代码 |
| 97 | 截图里的页面永远是「半张」：`window.__graphStats` 不存在、DOM 在工具栏中间截断、点击 / 下拉 / `?mode=3d` 全部无效，但 SSR HTML 与接口都是 200 | 脚本用 `http://127.0.0.1:3123` 访问，而 Next dev 的 origin 白名单按 `localhost` 记；`/_next/hmr` 等 dev 资源被判跨源后拦掉，RSC 载荷没有执行，React 从未水合，只剩静态 SSR | 验收实例统一用 `http://localhost:<port>`（脚本里的 `BASE`）；确认水合以 `window.__graphStats` 出现为准，并在失败时打印 readyState / script 列表 / 资源诊断 | dev 模式（尤其 HMR 资源）必须与 `next dev` 输出里的 host 完全一致；「页面能打开、接口 200」不等于前端在跑，先验证一个只有客户端才会写入的标记 |
| 98 | 开发环境一切正常，生产构建里图谱每 30 帧把整棵 `GraphExplorer` 重渲染一次 | `handleStats` 写 ref 之后还顺手 `setDebugVersion(v+1)`，只为让 `__graphStats` 效果重跑；这个 setState 没和环境绑定 | `setDebugVersion` 只在 `process.env.NODE_ENV !== "production"` 时调用，ref 照写；`__graphStats` 效果本身早就是开发态专用 | 「为了调试而 setState」必须显式关在生产环境之外；判定写在调用点，别指望消费端挡 |
| 99 | 自适应降档要么永不触发，要么降得太猛来回抖 | 只看单帧或单次窗口的 `avgFrameMs`，还把「没出帧」的窗口算进去——静止 demand 渲染 frames 不增长、avgFrameMs 为 0，窗口永远不过阈值 | 只认 `mode === "3d" && stats.rafActive` 且帧数前进的窗口；连续两个 stats 窗口（≈60 帧）平均帧时 >20ms 才降一档，任一窗口回到 20ms 内就清零；按 `TIER_ORDER` 取下一档、最多 2 次、间隔 ≥3s、降后清零；档位上限经 `previousTier` 交给 `selectGraphMode`，不持久化 | 帧时类降级必须定义「窗口、迟滞、冷却、上限」四件事，并排除不出帧的时段；触发验证用 CDP `Emulation.setCPUThrottlingRate` 真实压出来，别只写单测 |
| 100 | 抽稀后 3D 点不中、标签错位，2D 也跟着少点 | 把 `decimate` 的结果直接写回 `view`；场景与标签层都靠 `view.nodeIndex` 反查节点，抽稀后没有重建索引 | 3D 分支单独生成 `renderView`（`decimate` + 重建 `nodeIndex`），2D / 列表 / 检查器 / highlight 继续用完整 `view`；提示条补「另有 N 个实体未显示」；`keepIds` 必须含中心 / 选中 / hover / 路径端点 | 同一个模型给两个渲染面用时，「只读视图」在容器里分叉；派生数据（索引）跟着派生结果一起重建 |
| 101 | mock 切到宽图后，下拉里还是上一份数据的实体，宽图断言全对不上 | 服务端标签列表有 60 秒缓存，`mock.setMode("wide")` 只影响 `/graphs`，首屏 `/graph/label/list` 命中旧缓存 | 宽夹具步骤独占一个 dev 进程：`stopApp` → `setMode("wide")` → 重新 `startApp`；`?maxNodes=` 的透传用「切 2D 后换中心」发出的客户端请求验证（首屏是 SSR 预取，浏览器里没有请求记录） | 验收脚本里「切数据源」不只是切 mock，任何服务端缓存都要算进去；SSR 预取的页面要靠后续交互请求做传递性断言 |
| 102 | `>300` 节点时 Worker 创建失败，出 `chunk-failed` 横幅、退回主线程 | `graph-scene-3d.tsx` 的 `new URL("../workers/graph-layout.worker.ts", import.meta.url)` 按 `src/components/graph/` 解析，正确相对路径是 `../../workers/...`；`next dev` 日志已报 `Module not found` | 2026-11-13 已修：URL 改为 `../../workers/...`；`GRAPH_PERF_NODES=600` 真 Worker 验收通过（373 节点、Worker 内 56.2–59.6ms/150 ticks、端到端 795ms），见 08 第 16 节 | 相对 `import.meta.url` 的路径按文件所在目录算，`src/components/*` 与 `src/components/<x>/*` 差一层；`next dev` 的 Module not found 不能当噪音忽略 |
| 103 | 用户卡两秒 → 停手十几秒 → 再卡一次，画质立刻从 high 掉到 balanced，看起来像「两次连续慢窗口」 | `handleStats` 只在「有新帧且 3D / rafActive」时才写 `slowWindows`；2D、后台标签页、同一窗口重复发布、帧计数回绕统统直接 `return`，既不清零也不推进，上一次的慢窗口计数跨空闲保留了下来 | 四条早退路径都改成先 `guard.frames = next.frames` 再 `guard.slowWindows = 0`（回绕 / 非 3D / 帧数没涨）；只有真有新帧才累计或清零。窗口大小、20ms 阈值、2 次上限、3s 冷却、只降不升未动 | 「迟滞窗口」这类状态机，早退分支必须明确「保持」还是「重置」，默认应该是重置；空闲、切模式、换数据源都是不连续的边界。验证时用 `PHASE6D_DROP_PROBE=1` 看每个采样点的 `frames` / `avg`，先确认是「帧没涨」还是「窗口没跨阈值」，再怀疑逻辑 |

| 104 | 生产构建里什么都验不了：`window.__graphStats` 是 `undefined`，标签框调试钩子也消失，脚本一律超时 | `__graphStats` / `__graphLabelBoxes` 都按 `NODE_ENV !== "production"` 早退，这正是「生产不写调试全局」的本意，但验收脚本仍按 dev 口径断言 | 生产态只断言可见 DOM：`data-mode`、`[data-mode="3d"] canvas`、工具条 `aria-pressed`、提示条、`.meta-chip` 档位、`.g3-stub`、`.graph-note-error`、`.sr-only` 播报；再用截图像素统计（尺寸 / 平均亮度 / 亮像素占比 / 颜色桶）防「画布在但没画东西」。`PHASE6D_PROD=1` 走独立的构建 + `next start` 流程 | 调试钩子被生产守卫关掉不是缺陷，是契约；「生产可验证」要在设计断言时就用 DOM 说话，别依赖任何 window 上的读数 |
| 105 | 生产验收的图谱永远是空的，或标签全是「未连通」 | mock LightRAG 的夹具对象用自造 `filePath`，而 ADR-011 的读侧过滤按「本账号内容是否参与」判归属，不认识这些 id | 真实库只读备份到 `%TEMP%`，在**副本**上播夹具对象，让 `filePath` / 对象 id 对上；源库全程不打开写入，验证后删副本 | 图谱验收的夹具必须和归属过滤对齐；「接口 200 但图是空」先查归属过滤，别查渲染 |
| 106 | `.next-build` 存在时跑 `eslint .` 报出近千条错误，删掉目录就恢复 | 自定义构建产物目录不在 ESLint 的默认忽略里，被当成源码扫描 | `.gitignore` 加 `/.next-build`，`eslint.config.mjs` 的 `globalIgnores` 同步加 `.next-build/**`；门禁一律在干净树上跑 | 任何自定义构建 / 导出目录都要同时进 git 忽略与 lint 忽略，否则「本地全绿」和「门禁全绿」不是同一件事 |
| 107 | RAGFlow 刚重启时语义检索显示「超时」，但服务其实是好的；过一会儿自己恢复 | `SEMANTIC_TIMEOUT_MS = 3000` 对冷启动不够：容器刚起来时首个 `/api/v1/retrieval` 要几秒（模型 / 索引预热），`Promise.race` 直接判 `timeout`；同一分钟内连打三次，第 2、3 次才 `ok` | 暂未改代码（3s 是产品口径的取舍）。排查时先连打两三次区分「冷启动」与「真不可用」；界面文案上 `timeout` 与 `unavailable` 本就是两条不同的提示 | 外部检索的超时阈值要按「冷启动 + 稳态」两段分别验证；故障演练结束时的第一次请求不代表稳态 |
| 108 | 上传 `.bin` 这类 RAGFlow 不支持的扩展名，接口回 `500 INTERNAL`，前端只能显示「服务内部错误」 | RAGFlow 在 `POST /documents` 阶段返回 `code=500` + "This type of file has not been supported yet!"，适配器把非 2xx 一律包成 `DomainError("INTERNAL")`，没有区分「上游 5xx」与「上游拒绝该输入」 | 暂未改代码。生产影响有限（前端上传组件限制扩展名），但如果放开上传类型，应按上游错误体里的「unsupported」语义映射为 400 `VALIDATION_FAILED` | 上游返回 5xx 不代表就是服务故障：先看响应体是不是「拒绝输入」；「我能处理的格式」清单要有单一出处，前后端与上游三方对齐 |
| 109 | 详情卡写着「Shift + 单击另一个实体看路径」，在 3D 星图里按 Shift 点没反应（2D 正常） | 3D 没有 DOM 节点，修饰键只能由指针桥从 `MouseEvent` 上带出；`PointerBridge` 的 `onIntent("select", id)` 只传两个参数，`event.shiftKey` 在中间层被丢掉，容器只能当普通单击处理 | 意图回调扩成 `(intent, id, options?)`（新增 `SceneIntentOptions`），命中时带上 `{ shiftKey: event.shiftKey }`；容器 `handleIntent` 的 `select` 统一走 `handleSelect(id, options)`，与 2D 共用同一套语义 | 画布桥接要把「影响语义的修饰键」显式列进回调签名；2D 能用的交互不会自动继承到 3D，验收三条路径（2D / 3D / 键盘）要分别点名 |
| 110 | 「问图谱」自称在用本机模型，与「设置 → 大模型」里绑定的供应商无关 | 原链路把 LightRAG 的 `/query` 当作完整问答（`llm_generated: true`），生成用的是 LightRAG 自己的 `local_llm`，应用侧配置的模型只被 LightRAG 抽取使用 | 改成 `/query` 带 `only_need_context` 只取上下文（`references[].file_path` 按 `<SEP>` 拆分并过 ADR-011 归属过滤），答案由绑定模型经 OpenAI 兼容 `/chat/completions` 生成；新增 `graph-answer-service.ts`，密钥只进 `Authorization`、上游错误体整体丢弃、按状态码映射中文文案；响应补 `model` / `provider` 供界面署名 | 「检索」与「生成」是两个可替换的部件，生成必须走用户自己配置的模型；外部服务的错误体不进日志也不回显，只保留状态码与端点 |
| 111 | 无头验收里点「相关文档」没反应，展开后列表也停在可视区下方 | 详情卡自身是滚动容器（`max-height: calc(100dvh − 180px)`），折叠按钮在小视口下被滚出可视区，CDP 的真实鼠标点击落在卡片外；展开列表同理落在折叠线以下 | 产品侧展开时 `scrollIntoView({ block: "start" })` 把该段拉进可视区；验收脚本先 `scrollIntoView({ block: "nearest" })` + hit-test 再真实点击，并断言入口与首条链接都「可见」 | 可滚动容器里的控件，点击前先断言它真的在可视区；`element.click()` 能「点中」看不见的东西，那种通过不算数 |
| 112 | 验收报「搜索卡没居中」，但截图看是居中的 | 断言拿 `window.innerWidth / 2` 当中心，而应用外壳左侧常驻导航占 300px（390 下占 76px 的图标栏），搜索卡是相对 `.graph-page` 居中的 | 改测 `.graph-page` 的 `left/right` 求中心，移动端内边距也按 `page.left + 12` 校验；换 `getBoundingClientRect` 前后都打印实测值便于比对 | 布局断言的参照物必须是元素的实际定位容器，不是视口；有侧栏 / 抽屉的应用里「居中」永远指内容区 |
| 113 | 改完界面跑旧脚本 `verify-graph-glass.mjs` 全红：`.graph-qa` 找不到，dev 实例还去 `.next-glass` 找产物 | 脚本选择器绑定的是被替换的右下角面板；执行方式还是 `next dev` + 独立 `NEXT_DIST_DIR`，与本轮「只验生产包」的交付口径脱节 | 选择器迁到 `.graph-ask-dock` / `.graph-ask-form`，执行方式改为对生产 `.next` 跑 `next start`；脚本首行写明「先 `npm run build` 再跑」 | 验收脚本是交付口径的一部分：界面结构变了必须同步脚本，且脚本要跑在被交付的那份产物上 |
| 109 | 图谱页一个实体都没有，界面上只写「抽取失败」，看不出是模型太慢还是服务挂了 | 本地 `deepseek-r1:7b` 纯 CPU 约 7 tok/s，300 秒内跑不完长文分块，LightRAG 只把 `C[1/4]: doc-…-chunk-000:` 这类前缀写进 `error_msg`，真正的 `ReadTimeout` 只在服务日志里；旧界面把所有错误压成一句「失败」 | `describeGraphFailure` 归一为六类原因（超时 / 连接失败 / 密钥或权限 / 限流或额度 / 未返回原因 / 首行摘要），原始串一并保留；`/api/graph/status` 只上报本账号对象，失败项可展开原因并直接 `POST /api/graph/retry` | 「空图」先查状态再查渲染；长文抽取前先量单篇耗时与 tok/s；「还在抽」与「已失败」必须在界面上分开表达 |
| 110 | 管理员保存过大模型 API Key，过一阵子配置全部读不出来，只能重填 | 初版把设置加密密钥挂在 Logto 的 Cookie 密钥上，轮换登录密钥后旧密文全部解不开 | 改用独立变量 `SETTINGS_ENC_KEY`（HKDF-SHA256 → AES-256-GCM），缺失时报错而不是明文降级；密文带 `v1.` 版本前缀，便于将来换算法时保留旧格式解析 | 凭据加密密钥与身份 / 会话密钥必须分离；更换加密密钥等同作废旧数据，要有明确的操作记录与重填指引 |
| 111 | 预览弹窗里 PDF 一片空白，或者点开直接变成下载 | 下载接口默认 `Content-Disposition: attachment`；且 RAGFlow 对 PDF 常回 `application/octet-stream`，浏览器按附件处理 iframe 响应 | 新增 `?inline=1` 切换为 `inline`；`Content-Type` 优先本地 `content_refs.mime`，只有本地没有时才用 RAGFlow 回传值 | 内联展示要同时对齐 `Content-Disposition` 与 `Content-Type`，只改一个仍会被浏览器当下载 |
| 112 | 预览弹窗右上角「打开详情」点了没反应；偶尔能跳但后退一下又停回列表页 | ① 原生 `<dialog>` 在自身点击处理器里被 `onDismiss()` 卸载，锚点的默认跳转随 DOM 一起被取消；② `dismiss()` 里调 `window.history.replaceState` 抹掉了弹窗的 `?preview=` 参数，与 App Router 的内部状态失去同步 | `openDetail` 先 `event.preventDefault()`、再 `onDismiss()`、最后 `router.push(detailHref)`；从 `dismiss()` 移除 `replaceState`，只清 `pushedRef` 与本地 target；程序化关闭用 `suppressCloseRef` 跳过 `onClose`，避免把「已经导航」误当成「用户关闭」 | 组件在事件处理器里把自己卸载时，任何依赖默认行为的导航都会静默消失；和路由库共用 history 时，只有它能写 history，业务代码别手动 `replaceState`。验收要同时看「点击」与「点完后退」两条路径 |
| 113 | 作品目录里点标题周围一大片空白也会弹预览，和「全部内容」区域「点标题跳详情」的习惯不一致 | 列表行被做成「整行 Link + 标题按钮」，按钮的 `preventDefault` 让整行都变成预览热点；两处列表的点击语义因此分叉 | 改成 stretched link：行内一个绝对定位铺满整行的 `<Link>`（`z-index:0`）负责跳详情，标题做成 `z-index:1` 的 `<button>` 只负责预览；无预览上下文时标题退化回纯文本。两个列表共用同一段结构 | 一个区域要承载两种动作时，用「铺满的链接 + 抬高的按钮」而不是嵌套可交互元素；同一交互在多个列表出现，就抽成同一个组件，别各写一套 |
| 114 | `/admin/llm` 点「应用并重启」返回成功，`restarted: true`，但图谱仍然一抽取就失败，引擎实际还在跑旧配置 | 三处叠加：① 进程查询脚本用空格拼 PowerShell 语句，`if (...)` 被当成 `Select-Object` 的参数，脚本 exit 1、stdout 为空；② 代码没检查退出码和空结果，照样往下走；③ 旧 `lightrag-server` 没被杀掉，新实例抢不到 9621 端口，健康检查由旧进程回答，于是「重启成功」 | 脚本改成分号分隔；`defaultRunPowerShell` 与非 0 退出码直接抛错；`restartLightrag` 在进程列表为空时抛「没有找到正在运行的 LightRAG 进程」并回滚 `.env`；`killProcessTree` 在 `taskkill` 非 0 时抛错。补两条单测锁住「查不到进程必须失败」与「脚本必须含分号」 | 「操作成功」只能由**可观测的外部状态变化**证明，不能由本进程返回码证明：重启后要确认进程 PID 变了、启动日志里的模型名是新的。任何被吞掉的 shell 退出码，都会把失败变成假成功 |
| 115 | 图谱抽取失败，页面只写「未返回原因」，看不出是模型挂了还是网络不通 | LightRAG 的 `role_ollama_complete` 把底层 `httpx.ReadError` 吞掉，`doc_status.error_msg` 只剩 `C[1/29]: doc-…-chunk-000: ` 这样的空尾巴；同时引擎停留在旧配置、目标 Ollama 早已停止，两边都不报真因 | 新增 `model-endpoint-probe.ts`：按当前生效配置（库内 → 环境变量 → `infra/lightrag/.env` → 默认）直连供应商 `GET {base}/models`（Ollama 走 `/api/tags`），3 秒超时、30 秒缓存、永不抛错；`/api/graph/status` 在有失败对象时附带 `diagnosis`，图谱页在失败面板与进度区展示结论与下一步 | 上游吞异常时，别在它给的字段里找原因，直接去探它依赖的端点；诊断要么只读（不改配置、不重启），要么就明确写成一次操作。探测结果要说「能连但抽取仍失败」，否则会把服务健康误读成抽取成功 |
| 116 | 改了提炼解析器后，`verify-lifecycle-v2.mjs` 报「提炼应产出 1 条资产，实际 0」「重复提炼应 409，实际 201」，看着像功能回归 | 脚本里的假模型还在返回旧格式 `{title, description}`，新解析器按模板要求 `summary / scenario / keyPoints / excerpt（逐字）/ tags`，把整条候选丢弃——于是 0 条资产，重复提炼自然也不会 409 | 夹具升级到新契约：mock RAGFlow 的正文抽成常量 `MOCK_BODY`，提炼夹具的 `excerpt` 直接 `MOCK_BODY.slice(0, 160)`，保证「逐字」永远成立；摘要按 60–120 字硬要求写（首版只有 32 字，被 `SUMMARY_MIN` 丢掉） | 验收脚本的假模型是「解析器契约的第二份实现」：改解析器必须同步改夹具，且夹具文本要从同一常量派生，别手写两遍 |
| 117 | `npm run lint` 突然报 1297 条 error，`tsc` 却是 0 | `.next-v21` / `.next-v21b2` 是验收脚本的独立 dist 目录，只加进了 `.gitignore`，没进 `eslint.config.mjs` 的 `globalIgnores`，ESLint 把压缩后的产物当源码扫 | 两处都加：`.gitignore` 与 `globalIgnores`；顺带把两个目录写进 `tsconfig.json` 的 `include`，避免 tsc 也扫到 | 自定义构建目录必须三处同步（git / lint / tsconfig）；「门禁全绿」要跑在干净工作区上 |
| 118 | 目录里「浏览」「归属」两组条目和分组标题齐平，只有「作品进程」那组看着有层级 | 缩进做成 `DirGroup` 的 `nested` 开关，只有被显式传 `nested` 的调用点才缩进；新增的「浏览」「归属」没传，就一直是平的。视觉上像两套规则 | 删掉开关，`<div className="dir-group">` 下的 `.dir-item` 一律 `margin-left: 16px` + 从属竖线；`FilterChips` 之外的分组标题保持 88，条目统一 104 | 层级是容器的事，不该让每个调用点自己决定要不要缩进——默认继承，特例才覆盖，否则新分组迟早漏掉 |
| 119 | 列表上方「全部 / 资产 / 作品」胶囊条和下面的「类型」下拉是同一件事；其余条件全是下拉，要一个个展开才知道有什么可选 | 类型做了两个入口（快捷胶囊 + 下拉），两者都写 URL 的 `type`，只是外壳不同；其余筛选沿用 `<select>` | 全部改成 `FilterChips` 平铺按钮组（类型 / 库别 / 状态 / 标签 / 复核状态 / 价值等级 / 排序），每个条件一行、点一下生效；删除 `.type-switch` / `.type-option` 与对应 CSS，`filters-fields` 从四列网格改成竖排 | 同一维度只留一个入口；验收脚本按 `data-filter="…"` 定位而不是样式类名，样式再改也不会把断言一起改坏 |

**通用预防**（比单条修复更重要）：

- 每完成一个可交付切片就跑 typecheck + lint + test，并用真实 HTTP 请求验证关键路径；
- 数据库约束与领域规则同时写，测试里至少各有一条「绕过应用层直写」的断言；
- 外部契约（Logto / RAGFlow）以实测响应为准，实测值进 `04_INTEGRATION.md`，不写「应该是」。

---

## 5. 验证流程

### 5.1 提交前五条（全部在项目根目录执行）

```bash
npm run typecheck    # node node_modules/typescript/bin/tsc --noEmit
npm run lint         # node node_modules/eslint/bin/eslint.js .
npm test             # node node_modules/vitest/vitest.mjs run
npm run check:theme  # 主题契约：四块 98 名相等、几何只在 :root、字面量不超基线、theme.ts 零 hex
npm run check:contrast  # 四套主题的对比度；改图谱 / 主题色时必跑
npm run build        # 改动涉及构建配置或路由时执行
```

通过标准：typecheck / lint 无输出、测试全绿、`check:theme` 打印四行 `98 tokens PASS` 且退出 0、`check:contrast` 41/41。当前基线是 **66 个测试文件 916 项**（916 通过 + 3 项基准默认跳过，2026-11-14 Phase 6J 复跑确认）；lint 基线是 **0 error / 16 warning**（既有 `fail` 未使用）。

> **验收脚本产生的 `.next-*` 目录要同时进两处忽略**：`.gitignore` 与 `eslint.config.mjs` 的 `globalIgnores`。v2.1 验收用了 `.next-v21` / `.next-v21b2` 两个独立 dist 目录，只加 git 忽略时 `npm run lint` 报出 1297 条 error（扫描的是构建产物）。见第 4 节第 116 条。

> 本机（Windows，内存偏紧）直接 `npm test` 会因 Vitest 默认 worker 池占满内存而崩（`FATAL ERROR: Committing semi space failed`，Exit 134，多个 worker "exited unexpectedly"）。门禁与本地复跑一律用 `node ./node_modules/vitest/vitest.mjs run --maxWorkers=2`；这不是测试失败，别去改代码。

### 5.2 本地起服务与健康检查

```bash
npm run dev
# Next.js 默认 http://localhost:3000
curl -s http://localhost:3000/api/health
# {"status":"ok","service":"personal-asset-knowledge-platform","timestamp":"..."}
```

> 本地 `.env` 当前是 `AUTH_MODE=logto`。要用 mock 身份做接口冒烟，需临时改成 `AUTH_MODE=mock`（`.env.example` 的默认值就是 `mock`），完成后再改回，避免影响登录联调。
>
> 冒烟前先确认端口归属：`netstat -ano \| findstr :3000`。残留的 `next start` 子进程会占住端口，让请求打到旧代码上（表现为莫名其妙的 405），见第 4 节第 13 条。

**本机依赖一键拉起（幂等）**：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\autostart.ps1 -Check   # 只检查
powershell -ExecutionPolicy Bypass -File scripts\autostart.ps1         # 拉起 Logto / RAGFlow / LightRAG + embedding
```

- 开机自启：`powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1` 在当前用户的「启动」文件夹创建 `PAKP Autostart.lnk`（无需管理员；`-Remove` 撤销）。`schtasks` 方式需要提权，未采用。
- `autostart.ps1` 只负责拉起，不轮询健康；脚本末尾会打印各服务端口状态，全部就绪时退出码 0。

### 5.2.1 真实 Logto 登录冒烟（无头浏览器，不打断前台）

后台窗口里的 Chromium 会冻结渲染，靠截图 / 可访问性树判断页面状态不可靠（第 4 节第 33 条）。用本机已有的 `chrome-headless-shell` + CDP 跑完整流程，脚本放临时目录，不写进仓库：

1. 启动：`chrome-headless-shell --headless=new --remote-debugging-port=9333 --user-data-dir=<临时目录>`
2. `PUT http://127.0.0.1:9333/json/new?about:blank` 拿页面 WS，`Runtime.evaluate` 驱动。
3. 打开 `/api/logto/sign-in`，等 `location.host === 'localhost:3001'`；用原生 setter 写 `input[name=identifier]` / `input[type=password]`，点 `button[type=submit]`。
4. 等回到 `localhost:3000`，断言 `/workspace` 显示账号名；依次访问 `/search`、`/graph`、`/workspace` 并断言 `document.body.innerText` 非空。
5. 同会话内 `fetch('/api/objects', {method:'POST'})` 建一条资产，再打开 `/workspace/{id}` 断言标题出现；另测非法请求体 400、匿名请求 401。

最近一次结果（2026-11-11）：9 项全过（登录、工作区、检索、图谱、详情、身份、400、401、创建 201）。测试账号 `pakp_test`（Logto `sub` `7vjekboa76zu`），验证完可在 Logto 控制台删除。完整操作步骤、断言表与排障过程见 [08_RUN_LOG.md](08_RUN_LOG.md)。

### 5.3 HTTP 冒烟（`AUTH_MODE=mock`，无需 Cookie）

```bash
BASE=http://localhost:3000

# 新建作品：固定 draft，revision=1
curl -s -X POST $BASE/api/objects \
  -H 'Content-Type: application/json' \
  -d '{"type":"work","title":"冒烟用例","library":"internal","format":"article"}'

# 列表
curl -s "$BASE/api/objects?type=work"

# 列表筛选与分页（非法值一律 400）
curl -s -G "$BASE/api/objects" --data-urlencode "q=冒烟" -d "sort=created&limit=20"

# 状态迁移 draft -> finished（expectedRevision 用上一步返回值）
curl -s -X POST $BASE/api/objects/<id>/status \
  -H 'Content-Type: application/json' \
  -d '{"to":"finished","expectedRevision":1}'

# 上传主内容（multipart，25 MB 以内；需要真实 RAGFlow 配置）
printf '冒烟内容\n' > note.txt
curl -s -X POST $BASE/api/objects/<id>/content \
  -F "file=@note.txt" \
  -F "role=primary"

# 查迁移审计（时间正序，未迁移返回 []）
curl -s $BASE/api/objects/<id>/library

# 手动催一轮 outbox 投递（返回 claimed / done / failed；需要真实 RAGFlow 配置）
curl -s -X POST $BASE/api/sync/run

# 图谱：同步 → 查抽取状态 → 实体列表 → 邻域（需要本机 LightRAG）
curl -s -X POST $BASE/api/graph/sync
curl -s $BASE/api/graph/status
curl -s $BASE/api/graph/labels
curl -s -G "$BASE/api/graph" --data-urlencode "label=品牌蓝" -d "depth=2"

# 图问答：请求体写文件，避免中文内联（可能约 90 秒）
printf '{"q":"品牌蓝是什么？"}' > question.json
curl -s --max-time 180 -X POST $BASE/api/graph/query \
  -H 'Content-Type: application/json' --data-binary @question.json
```

完整端点、字段与错误码见 [06_API.md](06_API.md) 第 4、5、7 节。

已按此流程记录过的实测（来自 `05_CHANGELOG.md`，非本次复跑）：状态迁移 200、跳级 409、过期 revision 409、资产迁移 400、未知 id 404；编辑 200、用 PATCH 改库别 400、跨库迁移 200、缺 reason 400、归档 200、取消归档 200、删除 204；对象详情 200、审计 200、未知 id 404；内容上传 201（落 1 条 `content_refs` + 1 条 `pending` upsert，真实 RAGFlow）。

### 5.4 迁移验证

- `tests/server/db-client.test.ts` 覆盖：PRAGMA 生效、全部表创建、**重复打开同一文件不重复执行迁移**、约束兜底、迁移目录缺失时的可读报错。
- 迁移文件在 `drizzle/`，命名递增；打开连接时按序执行（`src/server/db/client.ts`）。目录默认取 `cwd/drizzle`，可用 `MIGRATIONS_FOLDER` 覆盖——以 `next start` 从其他目录启动时不必依赖「cwd 恰好是仓库根」；缺 `meta/_journal.json` 时直接报「找不到迁移目录」。
- `0004_library_events_cross_check.sql` 给 `library_events` 加了 `from_library <> to_library` 的 CHECK；服务层本就拒绝同库迁移，这条是直写数据库时的兜底。
- 手工核对时，`drizzle/meta/000N_snapshot.json` 是「应然」，`.sql` 是「实然」，两者不一致以能执行且测试通过的 SQL 为准，并回头修快照。

**破坏性迁移（重建表 / 删列，如 `0005_vocabulary.sql`）三段式**：

```bash
# ① 备份：openDatabase 在检测到未应用迁移时会自动 VACUUM INTO 一份
#    data/app.db.bak-<ISO>；手工再备一份更保险（含 WAL）
cp data/app.db "data/app.db.manual-$(date +%Y%m%d-%H%M%S)"

# ② 副本演练：复制 → 完整迁移 → 前后计数 → 外键自检 → 删副本
node scripts/rehearse-vocabulary-migration.mjs
#  输出 JSON：before/after 的对象数、各 format 计数、work_formats / tags /
#  object_tags 行数、foreignKeyCheck（必须为 0）、elapsedMs

# ③ 真库执行：重启开发服务（或任何打开数据库的进程），
#    迁移在 openDatabase 里一次性跑完；日志会打印备份路径
node node_modules/next/dist/bin/next dev   # 或 restart 现有 dev server

# 收尾核对（真库）
node -e "const D=require('better-sqlite3');const d=new D('data/app.db',{readonly:true});console.log(d.prepare('select type,count(*) n from objects group by type').all(),d.prepare('select format,count(*) n from objects where type=\'work\' group by format').all(),d.prepare('select count(*) n from work_formats').get(),d.prepare('pragma foreign_key_check').all())"
```

注意：重建表时 `PRAGMA foreign_keys` 必须在 `migrate()` **外层**切换（见问题 49），迁移文件里写是空操作。

### 5.4.1 词表界面验收（真实登录，无头浏览器）

数据层与接口的验收用 `AUTH_MODE=mock` 的 HTTP 冒烟就够；**界面**验收必须用真实登录态，因为目录管理区、管理页与弹窗的显隐都读 session。整套流程不碰用户本人的 Chrome（问题 56 / `08_RUN_LOG.md` 里的边界）：

1. **准备身份**：管理员页需要管理员。若 `ADMIN_SUBS` 只有用户本人、而其账号不便使用，按问题 56 备份 `.env.local` → 临时加入测试账号 `sub` → 重启 dev 服务。
2. **起无头 Chromium**：`chrome-headless-shell` + CDP（`--remote-debugging-port` + 独立 `--user-data-dir`），脚本与截图放临时目录，不入库。
3. **登录**：导航 `/api/logto/sign-in` → 在 Logto（`localhost:3001`）填 identifier / password → 处理授权页 → 回到 `localhost:3000`。脚本里的密码从既有冒烟脚本 `set(pass, …)` 读取，不写进文档与日志。
4. **管理页 CRUD**：`/admin/vocabulary/formats` 新增一个测试形态 → 确认出现在列表末尾 → 改名 → ↑ 两次 / ↓ 一次核对**整表顺序** → 删除（无引用时直删）。
5. **弹窗与筛选同步**：回 `/workspace` 新建弹窗，确认形态 chips 与词表顺序一致、「管理」入口指向 `/admin/vocabulary/formats`；建一个作品 + 一个资产各打一个标签；第三列「标签」下拉只剩这两条。
6. **改名穿透**：在管理页把标签改名，再回工作台确认筛选下拉、列表 chips 与详情页同步（靠 `revalidateVocabulary()`，无需硬刷新）。
7. **409 路径**：建一个被引用的形态，删除 → 弹窗显示引用数量 → 选「迁移到…」完成；标签同理，验证「合并到…」后关联保留、源标签消失。
8. **两种视口**：`Emulation.setDeviceMetricsOverride` 切 1280×800 与 860×1000，断言 `document.documentElement.scrollWidth <= clientWidth`、弹窗高度不超过视口且正文可滚。
9. **收尾**：删除测试形态 / 标签（含迁移产生的关联），核对对象数回到基线（9，可见 7）、形态 7、标签 1、`object_tags` 3、`pragma foreign_key_check` 为空；把被排序测试改过的 `sort_order`（如「未分类」999）改回原值；还原 `.env.local` 并重启，访问 `/workspace` 确认 200。

判定口径：控制台里删除被引用项的 409 属预期（问题 57），其余报错一律算失败。

### 5.4.2 后台权限迁移验收（ADR-019）

授权从环境变量搬进数据库，验收重点是「不丢数据、不断人」：

1. **副本演练**：复制 `data/app.db`（含 `-wal` / `-shm`）→ 用 `openDatabase` 打开副本 → 断言对象 / 作品数与迁移前一致、角色 4 / 权限 13 / 关联 27、`foreign_key_check` 为空。
2. **真实库**：`openDatabase` 会先 `VACUUM INTO` 备份（`data/app.db.bak-<ISO>`），再执行 0006；迁移后核对同样的计数。
3. **引导**：以真实 `sub`（`gdv8t04dw4ca`）调一次 `resolveSessionAccess`（`authMode=logto`、`adminSubs` 取 `.env.local`），应得 `roles: ["owner"]` 与一条 `user.bootstrap`；再用 `adminSubs: ""` 调一次，仍是同一 `userId`、仍是 owner。
4. **守卫**：用该会话依次调 `requirePermissionWith(..., "system:read" / "user:write" / "audit:read")`，应全部返回 `null`；陌生账号同项应得 403。
5. **离线恢复**：把库复制一份，`DATABASE_PATH=<副本> npm run admin:grant -- <测试sub> editor`，确认只写入 `editor` 一个角色与 `cli:admin-grant` 的审计，完成后删除副本。
6. **收尾**：真实库只保留本人 owner 记录；不改 `.env.local` 也能验证「清空 `ADMIN_SUBS` 仍可进入」，因此无需临时提权与还原。

### 5.4.3 图谱 2D 验收截图（`scripts/phase6d-capture.mjs`）

图谱界面的验收不依赖本机 LightRAG：脚本自建临时库与 mock 服务，用无头 Chrome 走一遍真实页面。

1. **前置**：`APP_PORT`（默认 3123）与 CDP 端口（默认 9338）必须空闲。跑前先 `netstat -ano | findstr :3123`，有残留 `next start-server` 或上一轮的 headless Chrome 就先结束进程——残留会让脚本连到旧服务或直接报「端口已被占用」（问题 91）。
2. **执行**：`node scripts/phase6d-capture.mjs`（6D-3 起全套约 2–3 分钟，3D 场景要等布局稳定）；调试时用 `PHASE6D_STEPS=center,status` 只跑指定步骤：`empty` / `desktop` / `center` / `list` / `mobile` / `3d` / `downgrade` / `maxnodes` / `overbudget` / `error` / `status`。`3d` 含桌面默认入口、移动端回落、低档三张图；`overbudget` 会重启一次 dev（宽夹具独占进程，见问题 101）。另有 B 线只读脚本 `node scripts/graph-perf.mjs`（自包含，3125 / CDP 9340）。
3. **它做了什么**：临时库放 `%TEMP%`（放进项目会让 Turbopack 一直重编译，见问题 85）→ mock LightRAG 按场景切模式（`empty` / `full` / `graph-error` / `status-error` / `center-error`）→ `AUTH_MODE=mock` 的 dev（3123，`NEXT_DIST_DIR=.next-mock`）→ CDP 断言 + 截图。
4. **断言口径**：横向溢出、console / page / network 错误默认都算失败；失败态场景里故意制造的 500 与对应的服务端日志按 URL / 文本白名单放行（问题 57 的同一口径）。
5. **产物**：`docs/screenshots/phase6d-2d-{desktop,empty,list,mobile,error,center-error,status-unknown}.png` 与 `phase6d-3d-{default-entry,mobile-2d,low-tier,overbudget}.png`，桌面 1440×900、移动 390×844 dpr 2；`graph-perf.mjs` 另出 `phase6d-3d-{default,selection,low}.png`。均无水印。
6. **读截图**：`center-error` 应保留旧图 + 一条红色横幅；`status-unknown` 应是「图谱状态暂时读不到」而不是「图谱还是空的」；`mobile` 不应有节点全贴在舞台边上。

### 5.4.4 资产生命周期与 v2.1 交付验收（全部对生产构建跑）

四条脚本都在**独立临时库 + 独立端口 + 假外部服务**上跑，不碰 `data/app.db`，也不碰 3000 上的实例。先 `npm run build`。

| 脚本 | 覆盖 | 端口 / dist | 结果口径 |
|------|------|-------------|----------|
| `scripts/verify-lifecycle-v2.mjs` | 提炼（新模板契约）→ 六维打分三档出口 → 人工复核 → 发布 → 实践结算 → 价值重评 → 规则守卫 + 4 个页面渲染 | 3141 / `.next` | 打印「全部断言通过」 |
| `scripts/verify-v21-ui.mjs` | 编辑器顺序与双向滚动联动、目录四组条目左缘同为 104（标题 88）、类型按钮组写进 `?type=asset`、拖拽分栏（340→460、刷新保持、键盘 16px、双击复位）、首页五指标、1440 / 390 断点 | 3132 / `.next-v21` | 同上 |
| `scripts/verify-v21-batch2.mjs` | `added=7d` 胶囊、快照面板、停留 8 秒 / 打开原文各计一次、评估历史三条、锁定 / 解锁、新建内库二次确认、批量重评、390 / 1024 断点 | 3133 / `.next-v21b2` | 同上 |
| `scripts/calibrate-model.mjs` | 真实模型对**真实库副本**逐条打分，输出六维明细 | 3155 / `.next` | 写 `docs/evaluation/calibration-latest.json` |

`verify-lifecycle-v2.mjs` 对模型输出的依赖全部在脚本内的假模型里：改提炼提示词 / 解析器时必须同步改 `MOCK_BODY` 与夹具（第 4 节第 116 条）。`calibrate-model.mjs` 会真实消耗模型额度（5 条约 7 秒），并且**必须**在 `.env.local` 有 `SETTINGS_ENC_KEY` 时才能解密库里的供应商密钥。

用 `NEXT_DIST_DIR=.next-v21 npm run build` 时，Next 会把生成的 `next-env.d.ts` 改写成指向 `.next-v21/dev/types`。提交前要**再跑一次普通的 `npm run build`**（或 `git checkout -- next-env.d.ts`）把它改回来，否则类型引用会指向验收用的临时目录。

### 5.5 外部服务连通性（已部署时）

```bash
# Logto：204 表示服务正常
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3001/api/status

# RAGFlow：返回版本字符串
curl -s http://localhost:9380/v1/system/version

# LightRAG：带 X-API-Key 返回 200，不带返回 403
curl -s -o /dev/null -w '%{http_code}\n' \
  -H "X-API-Key: $LIGHTRAG_API_KEY" http://127.0.0.1:9621/health

# Embedding 服务：返回模型列表
curl -s http://127.0.0.1:9381/v1/models
```

端口与版本以 [04_INTEGRATION.md](04_INTEGRATION.md) 的实测表为准（Logto 3001 / 控制台 3002；RAGFlow API 9380 / Web 18080；LightRAG 9621；本地 embedding 9381；Ollama 11434）。

### 5.6 换大模型与重抽图谱（管理员操作）

**换大模型**（`/admin/llm`，需 `settings:read`；改配置需 `settings:write`）：

1. 进「系统 → 大模型」，在「模型服务」里选预设（OpenAI / DeepSeek / 通义千问 / 自定义 OpenAI 兼容 / 本机 Ollama），再填 `Base URL`、模型名、API Key、超时。
2. API Key **留空表示沿用已保存的那把**；只有换供应商时才必须重填（端口 / 地址变了但模型没变也算换供应商）。
3. 点「测试连接」——它会向供应商发一个 `max_tokens: 8` 的最小请求。返回失败时先看是网络、密钥还是模型名，别急着保存。
4. 「保存」只落库，不影响正在运行的 LightRAG；「应用并重启 LightRAG」才会写 `infra/lightrag/.env` 并重启服务（10–30 秒，在途抽取中断，失败自动回滚）。
5. 应用后回图谱页确认「当前生效」与「运行中」一致；不一致的黄色提示条说明库里的配置还没落到 `.env`。

**图谱一个实体都没有**：

1. 打开 `/graph`，看提示条与状态区：是「抽取中」还是「抽取失败」。失败项可展开看原因原文。
2. 原因写着「抽取超时：本地模型过慢」——说明模型在 300 秒内跑不完一个分块，不是页面问题；本机 `deepseek-r1:7b` 纯 CPU 约 7 tok/s，长文必然超时。
3. 按上面步骤换成外部模型并应用，然后回到失败项点「重新抽取」（也可直接调 `POST /api/graph/retry`，一次 1–20 个对象）。
4. 重抽是异步的，进度以页面轮询 / `GET /api/graph/status` 为准；若仍是超时，先缩短单篇篇幅或减小分块，再重试。
5. 不要在生产 / 验收实例上随手点「应用并重启」——它会真实中断正在服务的 LightRAG。

---

## 6. 协作分工

本轮由多个角色并行推进，产出物可核对：

| 角色 | 负责 | 本轮实际产出（可核实） | 不负责 |
|------|------|------------------------|--------|
| 产品 Product | 范围、验收标准、旧项目盘点 | `PRODUCT_INPUT_功能盘点与验收标准_2026-11-11.md`；ADR-007 / 008 的业务依据（内库 / 外库定义、资产无 status） | 不写代码、不改 `docs/` |
| 主程 Coder | 实现、迁移、测试 | `e95d154` ~ `1ea0b86` 的代码、迁移与测试提交 | 不自行扩大范围 |
| 审查 Architect | 代码审查、P0 / P1 分级 | P0 四项（取值域 CHECK、状态迁移写路径、outbox 生命周期、外键完整性）与 P1 清单驱动了 `bd005d1` ~ `40561f7` | 不直接改业务代码 |
| 前端设计 Designer | 工作台信息架构与交互 | `b6e719b` 的工作台首屏重排、`82d8d54` 的对象行内操作；工作区已无未提交前端改动 | 不定义业务规则 |
| 文档 Docs | 00~07 文档、ADR 同步 | `docs/01` ~ `docs/05` 的本轮更新；新建 `docs/06_API.md`（接口契约）与本文件 | 不改业务代码 |
| Chief（MausBot） | 派单、汇总、对外汇报 | 任务拆分与阻塞裁决 | 不替代上述角色产出 |

协作接口：

- 产品给**验收标准**（编号 + 优先级），文档把结论合并进 `docs/`，主程按标准实现；
- 审查给**带优先级的缺陷清单**，主程修完在 changelog 记「验证方式」，文档复核一致性；
- 前端只改 `src/app`、`src/components` 与样式，接口契约以 `06_API.md` 为准，需要新字段先提给主程。

---

## 7. 当前阻塞与待人工验证

### 7.1 阻塞

| 项 | 影响 | 需要谁 | 现状 |
|----|------|--------|------|
| 本人账号的一次真实登录 | 确认 `JCzero001` 的 `sub`（`gdv8t04dw4ca`）能写入业务库 | 用户本人 | 登录链路已用测试账号 `pakp_test` 完整验证；本人账号只需按同样方式点一次登录即可 |
| 审查机器人 provider 401 | 后续提交没有独立复审，P1 之后的回归风险靠自测兜底 | 恢复审查通道 | 本轮仍不可用；不影响已提交代码运行 |
| LightRAG 单 workspace | 实体抽取仍是全局的；读侧已按账号过滤（ADR-011），强隔离未做 | 多账号同时使用图谱前 | 标签 / 邻域 / 进度 / 问答引用已按 `file_path` 过滤；同事实体仍在 LightRAG 内部合并 |

### 7.2 待验证 / 未完成

- **outbox 失败重试未经真实环境验证**：`sync-service` 的 404 视为达成目标、失败退避只有假网关单测；真实 RAGFlow 下已验证迁移后 meta 回读与删除后文档消失，但未构造真实 500/断网来观察退避。
- **worker 的启动条件容易误判**：`instrumentation` 只在同时配置 `RAGFLOW_BASE_URL` 与 `RAGFLOW_API_KEY` 且 `SYNC_WORKER_ENABLED` 不为 `false` 时挂定时器；因此「队列一直 pending」先查配置，而不是查 worker 逻辑。
- **图谱同步是手动的**：没有定时同步，也没有对象变更后自动入图；单轮最多 50 个对象。长期运行需要补自动同步与失败重试。
- **图谱抽取质量未评估**：7B 模型会把「#」等符号当实体、关系描述偶有格式告警；换更强模型后需在真实语料上复评，当前图谱不作为质量基线。
- **CPU 很慢**：118 字文档抽取约 3.8 分钟、`mix` 问答约 94 秒；长文档的等待时间未测，生产使用需评估 GPU 或云模型。
- **真实 Logto 下的前端冒烟已完成**（2026-11-11）：无头浏览器走通登录 → `/workspace`、`/search`、`/graph`、`/workspace/{id}`，创建 201、非法请求 400、匿名 401。测试账号 `pakp_test` 可在 Logto 控制台删除。
- **生产构建已复跑**：`next build` 通过；`next start`（3100 端口，`AUTH_MODE=logto`）实测 `/api/health 200`、`/ 200`、未登录 `/graph 307 → /`、`/api/logto/sign-in 307` 到 Logto。`MIGRATIONS_FOLDER` 指向仓库 `drizzle/` 的跨目录部署仍需在目标机器确认。
- **图谱 3D 已在生产运行时（`next start`）复验**（2026-11-13）：默认入口进 3D、`?maxNodes=600` 走真 Worker（换中心后仍走）、低档抽稀计数与画布一致、24× 降速下真实降档且不回升。仍跑在 mock LightRAG 夹具 + 无头 SwiftShader 上；真实 LightRAG / 真实 Logto 会话未在 `next start` 下复测，Worker 消息流量未在生产构建下埋点。
- **服务开机自启已配置**：`scripts\autostart.ps1` + 「启动」文件夹快捷方式；Logto / RAGFlow / LightRAG / embedding 四项开机拉起，Ollama 由现有自启项负责。
- **验收标准与实现的端点名不一致**：产品验收标准使用 `/api/assets`、`/api/works`、`/api/auth/callback`、`/api/auth/sign-out`；实现是 `/api/objects` 与 `/api/logto/*`。验收前必须统一口径，否则「按标准测」会全部对不上。

---

## 附录 A：提交索引

| 提交 | 一句话 |
|------|--------|
| `ebe32e6` | 纳入版本控制，保存重构前基线 |
| `91a68b5` | 同步 Docker 就绪后的进度，加入旧项目功能盘点 |
| `acc4ee5` | 固化三条 ADR，落地界面设计规范 |
| `e95d154` | 落地业务数据层与 Logto 自托管部署 |
| `b96b9d0` | 接入身份端口与最小持久化 CRUD |
| `b6e719b` | 接入 Logto 真实登录并落地工作台首屏 |
| `bd005d1` | 在数据库层钉死对象取值域与作品 / 资产字段边界 |
| `feb670e` | 补齐作品状态迁移写路径，堵死新建即 practiced |
| `8c53880` | 补齐 outbox 的认领、去重、重试与完成标记 |
| `ca7396f` | 补强外键与引用完整性，修掉 upsert 无法清空字段 |
| `5cbbcad` | 补齐对象编辑、删除、跨库迁移与归档接口 |
| `5b19bfe` | 部署 RAGFlow 并落地最小内容适配器 |
| `40561f7` | 把 outbox 入队并入对象写事务 |
| `07652b7` | 补齐对象详情与迁移审计读取接口 |
| `13d2940` | 加固迁移目录解析与跨库审计约束 |
| `0e4d798` | 为对象列表补上关键字、分类、标签、状态与排序分页 |
| `49e26de` | 打通内容上传到 RAGFlow 与 `content_refs` 的落库链路 |
| `82d8d54` | 工作台对象行内操作：状态推进、跨库迁移、编辑、归档与删除 |
| `1ea0b86` | 补齐 outbox 消费端：把元数据变更投递到 RAGFlow |
| `a7aa5f3` | 列表支持只看已归档（`archived=only`） |
| `decfabc` | 补齐 API 参考与工程手册，同步架构文档 |
| `b1bde9d` | 接入 RAGFlow 解析触发与状态轮询 |
| `44c3b8d` | 新增对象内容下载接口 |
| `1258e15` | 新增内容检索接口 |
| `b860530` | 统一仓储层 SQLite 约束错误翻译 |
| `3b8ddb4` | 工作台列表筛选与归档视图 |
| `4e86ddf` | 拒绝推进已归档作品的状态 |
| `26fcbe5` | 文档同步：解析轮询、下载与检索 |
| `cd2dc50` | 文档：归档状态守卫与工作台筛选 |
| `3a51888` | 内容检索页、对象详情页与内容文件界面 |
| `2e7f70a` | 文档：检索与详情前端落地 |

## 附录 B：常用命令

```bash
npm run dev        # 开发服务器，http://localhost:3000
npm run build      # 生产构建
npm run start      # 生产启动（需先 build）
npm run typecheck  # tsc --noEmit
npm run lint       # eslint .
npm test           # vitest run
```

LightRAG 链路（embedding + lightrag-server）在本机 Windows 上启动：

```powershell
cd infra\lightrag
.\start.ps1
# embedding: http://127.0.0.1:9381/health
# lightrag:  http://127.0.0.1:9621/health
```

脚本用 venv 解释器的绝对路径，避免命中 Windows 的 `python` 占位程序；`.env`、`.venv`、`models`、`data` 均不入库。

数据库文件默认 `data/app.db`，用 `DATABASE_PATH` 覆盖；迁移目录默认 `cwd/drizzle`，用 `MIGRATIONS_FOLDER` 覆盖；连接固定开 WAL、外键、`busy_timeout=5000`。

## 附录 C：术语

| 词 | 含义 |
|----|------|
| 内库 / 外库 | 已验证可复用 / 输入与待验证；判断标准是「敢不敢直接拿去用」，不是内容来源（ADR-008） |
| content_ref | 业务对象与 RAGFlow 文档的映射行，独立表 |
| content_key | 映射的幂等键，写入 RAGFlow `meta_fields`，用于删除重传后认回文档 |
| 乐观锁 revision | 每次写入 +1；更新时校验，防止覆盖并发修改 |
| outbox | `sync_jobs` 表：元数据变更先可靠落队，再异步投递 |
