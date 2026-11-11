# 目标架构

> 与 00_SCOPE.md、03_DECISIONS.md（尤其 ADR-005）保持一致。  
> 核心原则：内容统一由 RAGFlow 存储与检索；资产与四阶段工作流是建立在其上的业务层。

## 1. 项目一句话
以 RAGFlow 为统一内容存储与检索底座，在其上实现资产管理和四阶段工作流，结合 LightRAG 提供知识图谱能力，通过 Logto 提供登录注册的个人知识工作台。

> **实现状态（ADR-006 / ADR-009）**：业务侧 Next.js 骨架已落地（App Router + TypeScript），**数据层与 HTTP 接口均已实现**：SQLite + Drizzle 持久化（见第 5 节）、`/api/objects` 系列的对象 CRUD、作品状态迁移、跨库迁移与归档、内容上传、`/api/health` 健康检查，以及 `/workspace` 工作台。登录态来自 `AUTH_MODE`：`mock`（开发默认）使用固定本地身份，`logto` 走 Logto 真实登录（三条 `/api/logto/*` 路由）。**RAGFlow 已接入**：内容上传与 `sync_jobs` outbox 投递（进程内 worker）均已实现并经真实服务端到端验证；**LightRAG 仍未接入**，解析状态轮询、检索问答与内容下载未实现。接口契约见 [06_API.md](06_API.md)。当前 `src/` 是新建实现，不是旧系统代码。

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
| **server.db** | `src/server/db/` | 连接与表结构：`client.ts`（单例连接 + 迁移）、`schema.ts`（四张表）、`id.ts`（ULID） | 不写业务判断 |
| **server.repositories** | `src/server/repositories/` | 端口的 SQLite 实现：`SqliteObjectRepository`、`SqliteContentStore`；负责把数据库约束错误翻译成领域错误 | 不调用 RAGFlow |
| **server.http** | `src/server/http/` | 统一响应信封 `ok` / `created` / `empty` / `fail` / `fromError`，错误码→HTTP 状态映射 | 不写业务逻辑 |
| **server.adapters.ragflow** | `src/server/adapters/ragflow/` | RAGFlow 的**唯一**外部入口（ADR-009）：dataset 查询/创建、文档上传/改名/删除、`meta_fields` 整体更新 | 不做业务映射、重试或 outbox |
| **server.services** | `src/server/services/` | 用例编排：`object-service.ts`（请求解析、字段校验、归属校验）、`content-service.ts`（上传与替换）、`sync-service.ts`（outbox 投递） | 不直接拼 SQL，不绕过适配器调用 RAGFlow |

调用方向是单向的：`route handler → services → ports ← repositories → db`。`domain` 被所有上层引用，自己不知道谁在用它。route handler 的厚度上限为 15 行（ADR-009）。

**连接约定**（`src/server/db/client.ts`）：

- 运行时用 `getDb()` 单例，挂在 `globalThis` 上，避免 Next dev 的 HMR 反复新建连接。
- 数据库文件默认 `data/app.db`，可用环境变量 `DATABASE_PATH` 覆盖。
- 连接固定开启 `journal_mode = WAL`、`foreign_keys = ON`、`busy_timeout = 5000`。
- 打开连接时执行 `drizzle/` 下的迁移，因此迁移可重复执行；测试用 `openDatabase({ file: ":memory:" })` 建内存库，不碰真实文件。

### 5.2 四张表

| 表 | 承担什么 | 要点 |
|----|----------|------|
| **`objects`** | 资产与作品的业务主表，两者**同表**、由 `type`（`asset` / `work`）区分 | 作品才有 `format`、`status`、`source_note`，资产三列恒为 `NULL`；`library` / `source` / `origin` 三个正交字段按 ADR-008 拆分；`primary_category` 由写入时的 `categories[0]` 派生；软删除走 `deleted_at`，不物理删行；`revision` 作乐观锁；索引为 `(type, status)`、`library`、`updated_at` |
| **`content_refs`** | 业务对象与 RAGFlow 文档之间的映射，独立成表而非 JSON 字段（ADR-007） | `provider` 固定为 `ragflow`（单一内容底座）；`document_id` 是**可变指针**，`content_key` 才是幂等键；`role` 为 `primary` / `attachment`，用部分唯一索引保证**每个对象最多一个有效主引用**；`parse_status` 与 `sync_state` 分别跟踪解析进度和同步对账 |
| **`library_events`** | 跨库迁移的审计流水 | 记录 `from_library` / `to_library` / `reason` / `actor_sub`；`reason` 必填，因为「内库 = 已验证」是承诺，必须可追溯；与对象更新**同事务**写入，不出现「库别已变但没有记录」 |
| **`sync_jobs`** | 内容同步的 outbox | 内容变更即入队（`action` 为 `upsert` / `delete`），`state` 走 `pending → running → done / failed`，带 `attempts`、`last_error` 与可延迟的 `available_at`；索引 `(state, available_at)` 供后续 worker 取任务。**本轮只负责可靠落队，不实现投递**，消费由 Phase 3 的 LightRAG worker 承担 |

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
- 约束被触发时，仓储把驱动的 `CHECK constraint failed` 翻译成 `CONSTRAINT_VIOLATION`（HTTP 422），唯一约束冲突翻译成 `CONFLICT`（HTTP 409），上层不必感知 SQLite 报错文本。

### 5.4 一致性要点

- **乐观锁**：`update` 与 `changeLibrary` 都要求传入的 `expectedRevision` 与库中 `revision` 一致，不一致抛 `CONFLICT`，避免读-改-写覆盖。
- **身份与指针分离**：`content_refs` 的 upsert 以 `(dataset_id, content_key)` 认回记录，再更新 `document_id`。RAGFlow 更新正文是「删除 + 重传」，`document_id` 必变，不能当身份用。
- **失败不回滚外部**：跨服务失败不靠分布式事务，靠 `sync_jobs` 落队 + 后续对账修正（ADR-007）。
- **状态与内容解耦**：状态流转与跨库迁移只改业务元数据，不移动内容、不换 `document_id`（ADR-005 / ADR-007）。

### 5.5 HTTP 接口层

- `src/app/api/objects/**` 的 route handler 只做四件事：取会话 → 解析 JSON → 调 `object-service` → 用统一信封返回；业务校验集中在服务层，路由不写业务规则（ADR-009 的「路由厚度上限」）。
- 身份统一由 `src/server/session.ts` 解析：`AUTH_MODE=mock` 是固定本地身份，`logto` 读 Logto 会话，其他取值视为无身份（接口 401，页面跳回首页）。
- 端点清单、请求字段、错误码映射与 curl 示例见 [06_API.md](06_API.md)。该文档只写代码中真实存在的路由；未实现能力单独列出。

### 5.6 内容上传与 outbox 投递

- **上传**：`content-service.uploadObjectContent` 先校验归属与 multipart，再写 RAGFlow（单一 Dataset，按 `RAGFLOW_DATASET_ID` 或名称解析），最后落 `content_refs` 并入队 `sync_jobs`。替换主内容采用「临时名上传 → 写 meta → 落库 → 删旧文档 → 改回原名」，新上传失败时旧内容保持可用。
- **投递**：`sync-service.runSyncOnce` 原子认领到期任务；`upsert` 按 `content_key` 认回文档并整体重写 `meta_fields`，`delete` 删除文档并软删本地引用；文档已不存在视为达到目标状态，其它失败按指数退避重试，达上限置 `failed`。
- **触发**：`POST /api/sync/run` 可手动跑一轮；`src/instrumentation.ts` 在配置了 `RAGFLOW_BASE_URL` 与 `RAGFLOW_API_KEY` 时挂进程内定时 worker（默认 30 秒，`SYNC_WORKER_ENABLED=false` 可关闭）。
- **实测边界**：上传/迁移/删除三段已在真实 RAGFlow v0.20.5 上端到端验证（meta 读回与文档删除均核对）；生产模式下 `instrumentation` 的实际挂载未单独验证；解析状态仍恒为 `pending`（未接轮询）。

## 6. 主要数据流

1. **用户登录** → Logto 完成认证，前端获得身份。
2. **创建/更新资产或作品**
   - 业务侧写入元数据 + 状态，并在同一事务里入队 `sync_jobs`
   - 内容经 `POST /api/objects/{id}/content` 提交至 RAGFlow（单一 Dataset），并保存 `content_refs` 映射
   - worker 消费 `sync_jobs`，把库别、归档等元数据同步进 RAGFlow `meta_fields`；删除对象时删除对应文档
3. **检索 / 问答** → 直接请求 RAGFlow。
4. **知识图谱构建 / 查询** → LightRAG 基于内容（可从 RAGFlow 获取或同步）进行。
5. **四阶段流转** → 仅更新业务侧状态；内容仍留在 RAGFlow，不随状态物理移动文件。

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
- 内容变更后如何触发 LightRAG 更新
- 业务元数据存储的最终选型（SQLite / 其他）—— **已定案**：SQLite + better-sqlite3 + Drizzle（ADR-009，实现见第 5 节）
- Logto 与 Next.js 的具体集成方式（SDK、回调、会话）—— **已落地**：`@logto/next`，`/api/logto/sign-in`、`sign-in-callback`、`sign-out` 三条路由，会话由 `src/server/session.ts` 统一解析（见 06_API.md 第 6 节）
- 各服务的端口、环境变量、网络连通方式

## 10. 架构原则（必须遵守）
1. **内容只认 RAGFlow**（ADR-005）
2. **业务状态与内容分离**
3. **LightRAG 与 RAGFlow 解耦存储，仅共用 Embedding**（ADR-001）
4. **方向由 00_SCOPE + 03_DECISIONS 锚定**，变更需新增 ADR