# 目标架构

> 与 00_SCOPE.md、03_DECISIONS.md（尤其 ADR-005）保持一致。  
> 核心原则：内容统一由 RAGFlow 存储与检索；资产与四阶段工作流是建立在其上的业务层。

## 1. 项目一句话
以 RAGFlow 为统一内容存储与检索底座，在其上实现资产管理和四阶段工作流，结合 LightRAG 提供知识图谱能力，通过 Logto 提供登录注册的个人知识工作台。

> **实现状态（ADR-006 / ADR-009 / ADR-010）**：业务侧 Next.js 骨架已落地（App Router + TypeScript），**数据层与 HTTP 接口均已实现**：SQLite + Drizzle 持久化（见第 5 节）、`/api/objects` 系列的对象 CRUD、作品状态迁移、跨库迁移与归档、内容上传、内容引用列表、内容原文下载、内容检索 `GET /api/search`、解析触发与状态轮询 `POST /api/parse/run`、`/api/health` 健康检查，以及 `/workspace`、`/search`、`/graph`、`/admin` 加两个词表管理页共六个页面（共用三栏框架，ADR-013）。**形态与标签已词表化**（ADR-016，见 5.9）：内置 6 种形态之外可自定义，标签是全站共用的词表，`GET /api/vocabulary` 是唯一读取入口；管理页 `/admin/vocabulary/formats` 与 `/admin/vocabulary/tags`（ADR-019）从第二列目录底部的「管理」分组进入，仅管理员可见。登录态来自 `AUTH_MODE`：`mock`（开发默认）使用固定本地身份，`logto` 走 Logto 真实登录（三条 `/api/logto/*` 路由）。**RAGFlow 已接入**：内容上传、`sync_jobs` outbox 投递（进程内 worker）、解析状态轮询、检索与下载均已实现，上传 → 解析 → 检索 → 下载 → 归档后检索为 0 的链路已在真实 RAGFlow v0.20.5 上端到端跑通。**LightRAG 知识图谱已接入**：本机 Python 进程 + Ollama + 复用 RAGFlow 的 Embedding，`/api/graph/*` 五条接口与 `/graph` 页可用，实体抽取与 `mix` 问答已实测（见 5.7）。**尚未实现**：图谱多用户隔离（LightRAG 单 workspace）、图谱自动同步、基于 RAGFlow 的多轮问答会话（需要 chat model）。接口契约见 [06_API.md](06_API.md)。当前 `src/` 是新建实现，不是旧系统代码。

## 2. 逻辑架构（高层）

```text
[浏览器]
│
▼
[Next.js 前端 + API Routes]
│
├── 认证 ──────────────────► Logto (Docker 自托管)
│
├── 业务层（资产 + 工作流）
│       │
│       ├── 元数据 / 状态 / 关系 ──► 轻量存储（DB 或本地 JSON/SQLite，仅业务数据）
│       │
│       └── 内容主体 ─────────────► RAGFlow (Docker)
│                                      ├── 文档存储
│                                      ├── 解析 / 分块
│                                      ├── 向量化
│                                      └── 检索 / 问答
│
└── 知识图谱 ──────────────────► LightRAG
        ├── 共用 Embedding 模型（与 RAGFlow）
        └── 独立图存储 + 向量存储（不共用 RAGFlow 向量库）
```

## 3. 模块职责

| 模块 | 职责 | 技术选型 | 说明 |
|------|------|----------|------|
| **认证** | 登录、注册、会话管理 | Logto Docker 自托管 | 第一期仅身份，不做多用户数据隔离 |
| **内容底座** | 文档存储、解析、分块、向量化、检索、问答 | RAGFlow Docker | **唯一内容真相源**（ADR-005） |
| **业务层：资产** | 内库/外库、分类、标签、优先级等元数据与业务规则 | Next.js API + 轻量元数据存储 | 内容本身存在 RAGFlow，业务侧只存元数据与映射 |
| **业务层：工作流** | 四阶段状态流转（draft → finished → published → practiced） | Next.js API + 状态机 | 状态与流转规则保留，内容指向 RAGFlow 文档 |
| **知识图谱** | 实体关系构建与查询 | LightRAG | 共用 Embedding，独立存储（ADR-001） |
| **配置** | 模型、Embedding、服务地址、密钥 | .env + 少量配置文件 | 密钥不进内容存储 |

## 4. 核心数据关系（概念）

```text
Asset / Work（业务对象）
│
├── id、library、categories、tags、priority、status、...
│
└── content_ref ──────────────► RAGFlow Document / Dataset
                                   │
                                   ├── 原始文件 / 文本
                                   ├── chunks
                                   └── vectors

Knowledge Graph (LightRAG)
└── 从 RAGFlow 内容或业务元数据中抽取实体与关系
```

- **内容**：只存在 RAGFlow。
- **业务元数据与状态**：存在业务侧轻量存储（可后续用 SQLite / PostgreSQL / 甚至结构化 JSON）。
- **映射**：每个资产/作品通过 `content_ref`（或等价字段）关联到 RAGFlow 中的文档。

## 5. 业务数据层实现

> 本节记录**已落地**的实现（随当前 HEAD 更新），依据 ADR-007（内容映射契约）、ADR-008（内外库字段拆分）、ADR-009（存储选型与分层）。表结构以 `src/server/db/schema.ts` 与 `drizzle/` 迁移为准；两者不一致时以代码和迁移为准，并修文档。

### 5.1 分层与职责

| 层 | 目录 | 职责 | 明确不做 |
|----|------|------|----------|
| **domain** | `src/domain/` | 纯类型、取值集合与规则：`objects.ts`（Asset / Work 类型与取值）、`content-ref.ts`（内容引用）、`workflow.ts`（四阶段状态机）、`errors.ts`（带稳定错误码的 `DomainError`） | 不引入任何 IO，不依赖数据库或框架 |
| **server.ports** | `src/server/ports/` | 仓储端口接口：`ObjectRepository`、`ContentStore` | 不做权限、不发起外部调用 |
| **server.db** | `src/server/db/` | 连接与表结构：`client.ts`（单例连接 + 迁移）、`schema.ts`（七张表）、`id.ts`（ULID） | 不写业务判断 |
| **server.repositories** | `src/server/repositories/` | 端口的 SQLite 实现：`SqliteObjectRepository`、`SqliteContentStore`、`tag-links.ts`（对象 ↔ 标签的写入，按归一化键复用或新建标签）；负责把数据库约束错误翻译成领域错误 | 不调用 RAGFlow |
| **server.http** | `src/server/http/` | 统一响应信封 `ok` / `created` / `empty` / `fail` / `fromError`，错误码→HTTP 状态映射 | 不写业务逻辑 |
| **server.adapters.ragflow** | `src/server/adapters/ragflow/` | RAGFlow 的**唯一**外部入口（ADR-009）：dataset 查询/创建、文档上传/改名/删除、`meta_fields` 整体更新、文档状态列表（解析进度）、触发解析、分块原文读取、检索、下载 | 不做业务映射、重试或 outbox；归属、归档与库别过滤在服务层 |
| **server.adapters.lightrag** | `src/server/adapters/lightrag/` | LightRAG 的**唯一**外部入口（ADR-010）：文本入库、文档分页与删除、实体标签、邻域子图、`mix` 问答；API Key 走 `X-API-Key`，慢请求超时 180 秒 | 不做归属过滤或图文本构造，那些在服务层 |
| **server.services** | `src/server/services/` | 用例编排：`object-service.ts`（请求解析、字段校验、归属校验）、`content-service.ts`（上传、替换、列表、下载）、`sync-service.ts`（outbox 投递）、`parse-service.ts`（解析状态轮询）、`search-service.ts`（检索编排、参数校验、混合召回与降级）、`lexical-search-service.ts`（SQLite 词法检索与六级排序）、`graph-service.ts`（图谱文本、同步判重、邻域与问答引用回映射）、`vocabulary-service.ts`（形态与标签的读写、使用次数、迁移与合并） | 不直接拼 SQL，不绕过适配器调用 RAGFlow / LightRAG |

调用方向是单向的：`route handler → services → ports ← repositories → db`。`domain` 被所有上层引用，自己不知道谁在用它。route handler 的厚度上限为 15 行（ADR-009）。

**连接约定**（`src/server/db/client.ts`）：

- 运行时用 `getDb()` 单例，挂在 `globalThis` 上，避免 Next dev 的 HMR 反复新建连接。
- 数据库文件默认 `data/app.db`，可用环境变量 `DATABASE_PATH` 覆盖。
- 连接固定开启 `journal_mode = WAL`、`foreign_keys = ON`、`busy_timeout = 5000`。
- 打开连接时执行 `drizzle/` 下的迁移，因此迁移可重复执行；测试用 `openDatabase({ file: ":memory:" })` 建内存库，不碰真实文件。

### 5.2 七张表

| 表 | 承担什么 | 要点 |
|----|----------|------|
| **`objects`** | 资产与作品的业务主表，两者**同表**、由 `type`（`asset` / `work`）区分 | 作品才有 `category_code`、`status`、`source_note`，资产 `status` / `source_note` 恒为 `NULL`、分类可空；`category_code` 是指向 `categories(code)` 的**外键**（ADR-023），作品必填、资产可空；`tags` / `categories` JSON 列已删除，标签走向 `object_tags`；`library` / `source` / `origin` 三个正交字段按 ADR-008 拆分；软删除走 `deleted_at`，不物理删行；`revision` 作乐观锁；索引为 `(type, status)`、`library`、`updated_at` |
| **`content_refs`** | 业务对象与 RAGFlow 文档之间的映射，独立成表而非 JSON 字段（ADR-007） | `provider` 固定为 `ragflow`（单一内容底座）；`document_id` 是**可变指针**，`content_key` 才是幂等键；`role` 为 `primary` / `attachment`，用部分唯一索引保证**每个对象最多一个有效主引用**；`parse_status` 与 `sync_state` 分别跟踪解析进度和同步对账 |
| **`library_events`** | 跨库迁移的审计流水 | 记录 `from_library` / `to_library` / `reason` / `actor_sub`；`reason` 必填，因为「内库 = 已验证」是承诺，必须可追溯；与对象更新**同事务**写入，不出现「库别已变但没有记录」 |
| **`sync_jobs`** | 内容同步的 outbox | 内容变更即入队（`action` 为 `upsert` / `delete`），`state` 走 `pending → running → done / failed`，带 `attempts`、`last_error` 与可延迟的 `available_at`；索引 `(state, available_at)` 供 worker 取任务。落队与投递同属本期：`sync-service` 消费、进程内 worker 定时推进 |
| **`categories`** | 分类词表（ADR-023，原 `work_formats`） | `code` 是主键且**创建后不可改**，对象只存 code，所以改名只需改一行、全站立即生效；`normalized` 唯一，重名判定与标签同一套归一化规则；`state` 为 `active` / `archived`（CHECK 限定），停用项不进新建 / 编辑面板但历史对象照常显示；`is_system = 1` 的 7 个种子分类（含兜底 `uncategorized`）不能删除，`uncategorized` 也不能停用，它是删除分类时的迁移目标；启用分类上限 30 个，`sort_order` 决定面板顺序 |
| **`tags`** | 标签词表 | `normalized`（全角转半角、空白压缩、小写）**唯一**，查重与合并都按它；`label` 保留首次创建时的写法；重命名只改这一行，因为 `object_tags` 存的是 `tag_id` |
| **`object_tags`** | 对象 ↔ 标签的多对多链接 | 复合主键 `(object_id, tag_id)`，两侧外键级联删除；**软删对象保留链接**，使用次数靠 `join objects ... deleted_at IS NULL` 排除，否则「看不见的引用」会挡住标签删除 |

### 5.3 两条 CHECK 约束（数据库兜底）

规则在领域层与数据库里**各实现一次**，两层都不能省：应用层给可读错误，数据库是最后防线。

```sql
-- 资产无 status：status 只属于作品（ADR-008）
CONSTRAINT "objects_status_only_for_work" CHECK(type = 'work' OR status IS NULL)

-- 外库作品不得直接 practiced：必须先迁移到内库（ADR-008）
CONSTRAINT "objects_external_not_practiced" CHECK(NOT (library = 'external' AND status = 'practiced'))
```

- 第一条对应 `src/domain/objects.ts` 里 `AssetObject.status: null` 的类型约束，以及仓储在写入前对「资产携带 status / format / sourceNote」的拒绝。
- 第二条对应 `src/domain/workflow.ts` 的 `canTransition` / `assertTransition`：状态只能 `draft → finished → published → practiced` 逐级前进，不允许跳级或回退，且 `practiced` 在 `library = 'external'` 时被拒绝。
- 约束被触发时，仓储统一经 `sqlite-errors.ts` 把驱动报错翻译成领域错误：`CHECK constraint failed` 与 `NOT NULL constraint failed` → `CONSTRAINT_VIOLATION`（HTTP 422），`UNIQUE constraint failed` 与 `FOREIGN KEY constraint failed` → `CONFLICT`（HTTP 409）。上层不必感知 SQLite 报错文本；前三种的 `details.constraint` 带出被拒绝的约束名（外键冲突不带）。

### 5.4 一致性要点

- **乐观锁**：`update` 与 `changeLibrary` 都要求传入的 `expectedRevision` 与库中 `revision` 一致，不一致抛 `CONFLICT`，避免读-改-写覆盖。
- **身份与指针分离**：`content_refs` 的 upsert 以 `(dataset_id, content_key)` 认回记录，再更新 `document_id`。RAGFlow 更新正文是「删除 + 重传」，`document_id` 必变，不能当身份用。
- **失败不回滚外部**：跨服务失败不靠分布式事务，靠 `sync_jobs` 落队 + 后续对账修正（ADR-007）。
- **状态与内容解耦**：状态流转与跨库迁移只改业务元数据，不移动内容、不换 `document_id`（ADR-005 / ADR-007）。

### 5.5 HTTP 接口层

- `src/app/api/objects/**` 的 route handler 只做四件事：取会话 → 解析 JSON → 调 `object-service` → 用统一信封返回；业务校验集中在服务层，路由不写业务规则（ADR-009 的「路由厚度上限」）。
- `src/app/api/vocabulary/**` 同构，只是多一道 `adminGuard`（`src/server/http/guard.ts`）：写接口一律先判管理员，再交给 `vocabulary-service`；读接口 `GET /api/vocabulary` 对登录用户开放。
- 身份统一由 `src/server/session.ts` 解析：`AUTH_MODE=mock` 是固定本地身份，`logto` 读 Logto 会话，其他取值视为无身份（接口 401，页面跳回首页）。
- 端点清单、请求字段、错误码映射与 curl 示例见 [06_API.md](06_API.md)。该文档只写代码中真实存在的路由；未实现能力单独列出。

### 5.6 内容上传、解析与检索

- **上传**：`content-service.uploadObjectContent` 先校验归属与 multipart，再写 RAGFlow（单一 Dataset，按 `RAGFLOW_DATASET_ID` 或名称解析），落 `content_refs` 并入队 `sync_jobs`。替换主内容采用「临时名上传 → 写 meta → 落库 → 删旧文档 → 改回原名」，新上传失败时旧内容保持可用。
- **解析触发**：落库后立即调用 RAGFlow `POST /api/v1/datasets/{id}/chunks`（body `{ document_ids }`），引用置 `running`。触发失败不影响上传结果，引用停在 `pending`，由轮询按 `UNSTART` 补触发。
- **解析轮询**：`parse-service.pollParsingOnce` 每轮取最多 50 条 `pending` / `running` 引用，按 dataset 调用 `GET /documents?page=&page_size=`，把 `UNSTART / RUNNING / SCHEDULE / DONE / FAIL / CANCEL` 映射为应用侧 `parseStatus`；`FAIL` / `CANCEL` 的 `parseError` 取 `progress_msg` 最后一行，文档已不存在则直接标 `failed`。单条或单个 dataset 失败只进 `errors`，不影响整轮。
- **投递**：`sync-service.runSyncOnce` 原子认领到期任务；`upsert` 按 `content_key` 认回文档并整体重写 `meta_fields`，`delete` 删除文档并软删本地引用；文档已不存在视为达到目标状态，其它失败按指数退避重试，达上限置 `failed`。
- **下载**：`content-service.downloadObjectContent` 先校验对象归属与 `refId` 归属，再透传 RAGFlow `GET /documents/{id}` 的文件流；该路径是文件流而不是 JSON 详情接口，不能当元数据查询用。
- **检索**（ADR-024）：`search-service.searchContent` 先解析检索语法（`src/lib/search-query.ts`），再按 `mode` 并行两条召回——**词法层** `lexical-search-service` 在 SQLite 里用 `instr()` 匹配 `title_norm` / `description_norm` / 分类名 / 标签名（归一化只有一个实现：NFKC → 空白折叠 → trim → 小写，写入、回填、查询共用），按六级权重打分；**语义层**让 RAGFlow 召回（默认阈值 0.2，多取 `limit × 3`、上限 50），按 `document_id` 认回 `content_refs`，过滤掉不属于当前用户与已归档的对象，按 `library` 二次筛选。语义侧 3 秒硬超时，超时或报错只降级为词法结果（`semantic.status = timeout / unavailable`），不向前端抛错。合并按对象 id 去重，`score` 取两侧较高者。**业务过滤不能下沉到 RAGFlow**，否则会越过归属隔离；正文不在 SQLite，词法层搜不到正文，这是明确边界。
- **首页预览**：`useSearchPreview`（`src/hooks/`）+ 纯函数层 `src/lib/search-preview.ts`（防抖、请求令牌、键盘下标、响应清洗），只请求 `mode=lexical&limit=8`，200ms 防抖、IME 合成期不请求、`AbortController` 丢弃过期响应。
- **调度**：`POST /api/sync/run` 与 `POST /api/parse/run` 可分别手动跑一轮；`src/instrumentation.ts` 在配置了 `RAGFLOW_BASE_URL` 与 `RAGFLOW_API_KEY` 时挂进程内定时 worker（默认 30 秒，`SYNC_WORKER_ENABLED=false` 可关闭），每轮先投递 outbox 再轮询解析。
- **实测边界**：上传、迁移、删除、解析、检索、下载均已在真实 RAGFlow v0.20.5 上验证——上传后立即 `running`，约 9–12 秒 `succeeded`（`chunk_count = 1`）；检索相似度约 0.38–0.48，归档后同一检索返回 0 条；下载内容与上传文件逐字节一致。生产模式下 `instrumentation` 的实际挂载未单独验证；解析失败与投递重试路径仍只有假网关单测。

### 5.7 知识图谱（ADR-010）

- **部署边界**：LightRAG 1.5.7 作为本机 Python 进程运行（`127.0.0.1:9621`），LLM 是 Ollama `deepseek-r1:7b`（`11434`），Embedding 复用 RAGFlow 的 `BAAI/bge-large-zh-v1.5`，由 `infra/lightrag/embedding_server.py` 以 OpenAI 兼容接口暴露在 `127.0.0.1:9381/v1`。图（NetworkX graphml）与向量（NanoVectorDB）存储独立于 RAGFlow，只共用模型权重。
- **构图**：`graph-service.buildGraphText` 把对象元数据（标题、类型、库别、状态、描述、分类、标签）与 RAGFlow 已解析主内容的**分块原文**拼成一段文本；只取 `role=primary`、`parseStatus=succeeded`、未删除的引用。没有可用正文的对象计入 `skipped`。
- **身份与版本**：`file_source = pakp:obj:{objectId}:{sha256(text) 前 12 位}`。哈希相同视为未变；内容变化时先删除该对象的旧版本文档再写入新版本，避免同一对象在图中叠加多份。
- **同步**：`POST /api/graph/sync` 手动触发，单轮最多 50 个对象；LightRAG 收到文本后异步抽取，状态经 `GET /api/graph/status` 查看（`pending` / `processing` / `processed` / `failed`）。
- **查询**：`GET /api/graph` 读实体邻域（深度 1–3，`maxNodes` 50–600、默认 150）；`POST /api/graph/query` 用 `mix` 模式（图谱 + 向量）问答，答案引用按 `pakp:` 前缀解析回业务对象并校验归属，不是本系统写入的文档不返回。
- **前端**：`/graph` 是服务端组件，首屏取标签与初始邻域；`GraphExplorer` 负责实体切换、三种视图（2D 聚焦 / 3D 星系 / 列表）、邻域详情、问答与同步状态轮询（只在 `pending` / `processing` 时每 15 秒刷新）。模型层是冻结件 `graph-model.ts` / `graph-quality.ts` / `graph-selectors.ts`：2D 与 3D 只消费同一份 `GraphViewModel` 与 `GraphHighlight`（含 `dimmedEdges`）；2D 用 `graph-layout-2d.ts` 的确定性力导向，3D 用 `graph-layout-3d.ts` 的三层盘播种 + 松弛布局（>300 节点在 `src/workers/graph-layout.worker.ts` 里跑，默认 400ms 预算），渲染层见 `src/components/graph/`（节点 / 边 / 标签各一次 instanced 绘制，预算 ≤8 次 draw call）。档位只降不升：容器按 `onStats` 的帧时连续两个窗口超阈值降一档，并在超预算时用 `decimate` 只抽稀 3D 视图。布局与标签排序是纯函数，单测覆盖。
- **失败与重抽（ADR-025 同期）**：`GET /api/graph/status` 只上报当前账号拥有的对象，每项带 `state`、`error` 与归一后的 `reason`；`describeGraphFailure` 把 LightRAG 原始错误分成超时 / 连接失败 / 密钥或权限 / 限流或额度 / 未返回原因 / 首行摘要六类，原始串一并保留。`POST /api/graph/retry` 按传入的 1–20 个对象重新入队（权限 `content:sync`），逐条返回 `resubmitted` / `skipped` / `failed`，进度仍以 `/api/graph/status` 为准。
- **已知限制**：LightRAG 的图 / 问答路由绑定单实例默认 workspace，`LIGHTRAG-WORKSPACE` 头只覆盖部分接口，因此图谱是**单租户**；`/graphs` 只沿有向出边遍历，只有入边的实体返回空图；本机 CPU 上 118 字文档抽取约 226 秒、问答约 94 秒。

### 5.8 前端应用框架（ADR-013 / ADR-014 / ADR-015）

- **统一网格**：`.app-frame` 为 `76px + 模块目录 + 内容区`；页面里存在 `.directory` 时由 `:has(> .directory)` 切三列，工作台再加 `.record-list` 变四列。六个页面（`/workspace`、`/search`、`/graph`、`/admin`、`/admin/vocabulary/formats`、`/admin/vocabulary/tags`）只组合 `NavRail`、各自的 `*Directory` 与内容区，不传布局参数；两个词表页共用 `VocabularyPage` 骨架，只在标题与列表类型上不同。
- **状态单一来源**：工作台列表与详情共用 URL 上的 `q / type / library / status / sort / archived`；点列表项只换右栏内容，服务端仍按同一份筛选渲染。目录项同一路径只换 hash 时用原生 `<a>`（Next `<Link>` 不会滚动）。
- **响应式**：≤1100px 隐藏目录；≤900px 用 `.app-frame.has-list[data-selected]` 让列表与详情互斥；≤560px 导航只留图标。
- **正文类型**：详情页编辑器顶栏切换 `纯文本 / Markdown`；Markdown 预览由 `src/lib/markdown.ts` 解析为块与行内片段，`MarkdownPreview` 渲染 React 元素（不使用 `dangerouslySetInnerHTML`，链接只放行 `http/https/mailto` 与站内相对地址）。保存仍以源码（`text/markdown` 或 `text/plain`）上传，RAGFlow 是内容唯一真相源。
- **批量操作**：列表行由客户端组件 `RecordList` 渲染，行内复选框 + 筛选下方的批量条（顺序「标题 → 筛选 → 批量 → 列表」）；归档、删除对每条复用 `POST /api/objects/{id}/archive` 与 `DELETE /api/objects/{id}`，前端汇总结果。导出在浏览器取内容引用，`src/lib/export-markdown.ts` 拼成一份 Markdown 下载，不新增服务端路由。
- **删除的旧壳**：`app-sidebar.tsx`、`workspace-shell.tsx` 与 `.app-shell` / `.sidebar` 样式已移除，避免两套侧栏并存。

### 5.9 形态与标签词表化（ADR-016）

- **两处硬编码变成数据**：`objects.format` 的 `CHECK (format IN (...))` 换成指向 `work_formats(code)` 的外键；`objects.tags`（JSON 文本数组）这列在 `drizzle/0005_vocabulary.sql` 重建 `objects` 时删除，标签改为 `tags` + `object_tags` 真多对多，JSON 不再是标签的真相源。
- **唯一读取入口**：`GET /api/vocabulary` 返回 `{ formats, tags }`，含 `label` / `sortOrder` / `state` / `usage`；服务端页面直接调 `listVocabulary()`，浏览器侧走同一份数据。对象的 `tag` 筛选先按归一化键解析成 `tag_id` 再 join，不再扫 JSON。
- **唯一写入入口**：`/api/vocabulary/**` 的 8 条路由，`adminGuard` 前置，非管理员 403（ADR-019）。对象写入时出现的**新标签**由 `tag-links.ts` 在同一事务内补齐，不存在第二条写路径。
- **管理界面**：`/admin/vocabulary/formats` 与 `/admin/vocabulary/tags` 两个页面（组件 `VocabularyPage` + `VocabularyManager`）只调上面 8 条接口，成功后 `router.refresh()` 重读服务端数据，不在客户端维护副本；删除被引用项时服务端 409 带 `details.usage`，界面据此把「删除」变成「迁移到…」（形态）或「合并到…」（标签），不提供强删。入口 `TaxonomyDirectoryGroup` 挂在每个模块目录底部，仅管理员渲染。
- **7 处硬编码已清除**：`domain/objects.ts`、`create-object-dialog`、`object-detail`、`record-list`、`search/page`、`export-markdown`、`object-service` 原来各自抄一份形态名单；现在只有 `domain/objects.ts` 的 `SYSTEM_FORMAT_SEEDS` 作为**迁移种子与测试 fixture** 存在，UI 一律消费词表，读不到就显示 code（`src/lib/format-labels.ts`），没有「回退到旧常量」的兜底。
- **守卫**：ESLint `no-restricted-imports` 禁止 `src/**` 从 `@/domain/objects` 导入 `SYSTEM_FORMAT_SEEDS`（只有定义文件自身豁免），把「改一处漏一处」变成 lint 错误。
- **对外形状不变**：`BusinessObject.tags` 仍是 `string[]`（元素是 label），仓储读取时再水合并发一次查询分组，UI / 导出 / 筛选 / 既有测试的契约不变。
- **迁移注意**：`0005` 要重建 `objects`（删列 + 加外键），而 `objects` 被 `library_events.object_id` 引用；SQLite 的 `PRAGMA foreign_keys = OFF` 在事务内无效，必须由 `openDatabase()` 放在迁移事务外层，迁移后再跑 `PRAGMA foreign_key_check`，结果非空即拒绝启动。

### 5.10 系统设置与大模型配置（ADR-025）

- **分层**：路由 `src/app/api/settings/llm/**` 只做「取会话 → `requirePermission` → 交给服务」；业务在 `src/server/services/llm-settings-service.ts`（字段归一、供应商预设、`.env` 读写、应用与回滚）；加解密单独收在 `src/server/security/secret-box.ts`，既不读库也不写日志，便于单测与替换。
- **存储**：`drizzle/0009_settings.sql` 的 `settings` 表（`key` / `value_encrypted` / `updated_at` / `updated_by`）。整段 JSON 一起加密（含 API Key），避免出现「漏加密一列」；`updated_by` 是操作者 sub 快照，不建外键，用户删除后审计仍可读。迁移只建表，没有行时按 `infra/lightrag/.env` 推导当前生效值。
- **凭据密钥**：只读 `SETTINGS_ENC_KEY`，经 HKDF-SHA256 派生 32 字节 AES-256-GCM 密钥，密文 `v1.<iv>.<tag>.<ct>`（b64url，IV 每次随机 12 字节）。**不复用** Logto Cookie 密钥：轮换登录密钥不应让已存 API Key 全部解不开。变量缺失时接口报错，不静默降级或临时生成。
- **权限**：`settings:read`（查看，只回掩码与 `hasKey`）与 `settings:write`（保存 / 测试 / 应用），仅 owner / admin；代码常量与数据库目录由 `assertAuthzCatalog()` 启动时核对。权限总数 13 → 15。
- **保存与应用分离**：`PUT` 只落库；`POST /api/settings/llm/apply` 才写 `infra/lightrag/.env`（先备份）、只重启 `lightrag-server`、轮询 `/health` 最多 60 秒，失败自动回滚 `.env` 并重启回原配置。写入是逐键替换，保留 `.env` 里的其它变量与注释。
- **界面**：`/admin/llm`（`src/components/llm-settings.tsx`）四张卡——当前生效 / 模型服务 / 连接测试 / 应用并重启；与后端解耦，后端未就绪（404 / 503 非 JSON）时显示「后端未就绪」。字段校验与供应商预设收在 `src/lib/llm-settings.ts`，请求包装在 `src/lib/api-fetch.ts`。

### 5.11 内容预览（ADR-026）

- **结构与状态**：`PreviewProvider`（`src/components/preview-provider.tsx`）是唯一宿主，挂在 `workspace-view` 外层；打开状态写在 URL `?preview=<objectId>`，后退可关闭，关闭后焦点回到触发元素。弹窗本体 `content-preview-dialog.tsx` 使用原生 `<dialog>`，按对象 key 重新挂载，避免在 effect 里手工清空状态。
- **内容来源**：复用既有三个接口，不新增读取路由——`GET /api/objects/{id}` 取对象与引用、`GET /api/objects/{id}/content/{refId}?inline=1` 取内联正文、`src/lib/content-preview.ts` 判定类型与内容地址。下载接口按 `?inline=1` 在 `inline` / `attachment` 间切换 `Content-Disposition`；`Content-Type` 优先本地 `content_refs.mime`，因为 RAGFlow 对 PDF 常回 `application/octet-stream`，照搬会让内联打开变成下载。
- **各类型**：PDF 同源 iframe（过大降级下载）；Markdown 走 ADR-014 的零依赖解析器，不用 `dangerouslySetInnerHTML`；纯文本按 512 KB 截断并提示；图片内联；其它类型给下载卡片。解析状态与失败原因直接展示，失败归因（超时 / 连接 / 不支持格式 / 空内容）在 `src/lib/content-preview.ts`，附件可切换。
- **响应式**：移动端全屏（`100dvh`），桌面居中；样式复用既有类，新增 `.preview-*` 只写尺寸与间距，不新增颜色字面量。

## 6. 主要数据流

1. **用户登录** → Logto 完成认证，前端获得身份。
2. **创建/更新资产或作品**
   - 业务侧写入元数据 + 状态，并在同一事务里入队 `sync_jobs`
   - 内容经 `POST /api/objects/{id}/content` 提交至 RAGFlow（单一 Dataset），并保存 `content_refs` 映射
   - worker 消费 `sync_jobs`，把库别、归档等元数据同步进 RAGFlow `meta_fields`；删除对象时删除对应文档
3. **检索** → 前端调 `GET /api/search`（默认 `mode=hybrid`）；词法层在 SQLite 里匹配元数据，语义层由 RAGFlow 召回正文，服务层按 `content_refs` 做归属、归档与库别过滤后按对象合并返回。首页预览走 `mode=lexical&limit=8`，不碰 RAGFlow。问答会话（多轮上下文 + 生成）尚未实现。
4. **知识图谱构建 / 查询** → 手动 `POST /api/graph/sync` 把已解析主内容经 RAGFlow 分块原文送进 LightRAG；抽取完成后 `/graph` 读取实体邻域，或调 `POST /api/graph/query` 做图增强问答。
5. **四阶段流转** → 仅更新业务侧状态；内容仍留在 RAGFlow，不随状态物理移动文件。
6. **形态 / 标签维护** → 管理员改词表只写 `work_formats` / `tags` / `object_tags`，对象本身不动（改名是 O(1)）；只有「删除仍被引用的形态」会在同一事务里把引用迁到目标形态、`revision + 1` 并逐条入队 `sync_jobs`，worker 再把新 `format` 投递进 RAGFlow 的 `meta_fields`。标签的删除 / 合并按调用方选择处理 `object_tags`，不触碰内容底座。

## 7. 与旧系统的关键差异

| 旧系统 | 新系统 |
|--------|--------|
| 本地 Markdown 文件 = 内容唯一真相 | RAGFlow = 内容唯一真相 |
| 资产/作品直接读写文件系统 | 资产/作品通过映射关联 RAGFlow 文档 |
| 知识库是附加功能 | 知识库（RAGFlow）是内容底座 |
| 状态变化可能伴随文件移动 | 状态变化只改业务元数据，内容位置稳定 |

## 8. 第一期明确不做的部分
- 多用户数据隔离
- 旧知识图谱实现
- 加密分享
- 平台试运行评估
- 以本地文件系统作为内容主存储

## 9. 待 Phase 中细化的内容（写入 04_INTEGRATION.md）
- RAGFlow Dataset / Document 与业务 Asset/Work 的具体映射字段 —— **已定案并落地**：单一 Dataset（ADR-007），`content_refs` 保存映射，`meta_fields` 只镜像过滤字段（见 5.6 与 04_INTEGRATION.md）
- 内容变更后如何触发 LightRAG 更新 —— **已落地（手动）**：`POST /api/graph/sync` 按内容哈希判重、删除旧版本后重建；自动同步与失败重试仍未实现
- 业务元数据存储的最终选型（SQLite / 其他）—— **已定案**：SQLite + better-sqlite3 + Drizzle（ADR-009，实现见第 5 节）
- Logto 与 Next.js 的具体集成方式（SDK、回调、会话）—— **已落地**：`@logto/next`，`/api/logto/sign-in`、`sign-in-callback`、`sign-out` 三条路由，会话由 `src/server/session.ts` 统一解析（见 06_API.md 第 10 节）
- 各服务的端口、环境变量、网络连通方式

## 10. 架构原则（必须遵守）
1. **内容只认 RAGFlow**（ADR-005）
2. **业务状态与内容分离**
3. **LightRAG 与 RAGFlow 解耦存储，仅共用 Embedding**（ADR-001）
4. **方向由 00_SCOPE + 03_DECISIONS 锚定**，变更需新增 ADR