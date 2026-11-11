# 工程手册：开发计划、执行过程与问题复盘

> **读者**：接手本项目的开发者 / AI、需要评估进度的协作者。
> **写法**：只记录仓库里能核实的事实（提交、文件、测试、实测端口）。无法核实的标「未验证」，不写规划口吻的完成状态。
> **快照时间**：2026-11-11 15:14（Asia/Shanghai），HEAD `a7aa5f3`，分支 `master`，共 20 个提交；测试基线 10 个文件 127 项。Coder 与 Designer 仍在连续提交，本快照只对上述提交负责。
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
| Phase 1 | 身份 + 最小持久化 CRUD | 代码完成；**浏览器内完整登录未人工验证**（见第 7 节） |
| Phase 2 | RAGFlow 内容底座 | 上传 / 替换 / meta 镜像已打通并端到端实测（`49e26de`）；outbox 投递端已实现并端到端实测迁移与删除（`1ea0b86`）；解析、分块、检索仍未接线 |
| Phase 3 | LightRAG 知识图谱 | 未开始 |
| Phase 4 | 核心业务（资产 + 工作流） | 元数据、工作流、内容上传与同步投递均已实现；前端行内操作随 `82d8d54` 提交 |
| Phase 5 | 联调与打磨 | 未开始 |

> **注意文档不一致**：[02_PHASES.md](02_PHASES.md) 的「当前状态 / 已完成」仍停留在「Logto / RAGFlow 未部署、未验证」，与本轮实测（`04_INTEGRATION.md` 记录两者均已部署）冲突。本手册不改该文件，同步它属于文档维护待办（第 7 节）。

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
| services | `src/server/services/` | 用例编排：`object-service.ts` 负责请求体 / 查询参数解析、字段校验、`ownerSub` 归属校验；`content-service.ts` 编排内容上传（解析 multipart → 调 RAGFlow → 落 refs + 入队） | 不直接拼 SQL；不绕开 adapters 发外部请求 |
| http | `src/server/http/` | 统一响应信封、错误码 → HTTP 状态 | 不写业务逻辑 |
| adapters | `src/server/adapters/` | RAGFlow 与 Logto 的**唯一**外部入口 | 不被 domain 依赖 |

硬约束（ADR-009）：route handler **不超过 15 行**；所有 RAGFlow 调用只经 `server/adapters/ragflow`。

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

**本快照的实测结果（2026-11-11 15:13，工作区）**：`npm test` 10 个文件 127 项全部通过（本轮复跑确认）。typecheck / lint 在 `49e26de`、`1ea0b86`、`a7aa5f3` 提交时记录通过，本次未复跑。

### 3.1 工作区未提交内容

15:14 时工作区如下。注意：Coder 与 Designer 仍在连续提交 / 改文件，本节只代表该时刻。

- 已修改（文档）：`docs/01_ARCHITECTURE.md` —— 本次文档工作补写的「5.5 HTTP 接口层」与实现状态段落。其中「内容上传与同步投递尚未实现」一句在 `49e26de` / `1ea0b86` 之后已过时，属待修（见 7.2）。
- 未跟踪（本轮文档）：`docs/06_API.md`、`docs/07_PLAYBOOK.md`
- 未跟踪（工具生成）：`AGENTS.md` —— `next dev` 自动写入的 Next.js 版本提示，删掉也会再生，提交与否都不影响运行
- 未跟踪（前端在改）：截至快照有 `src/lib/workspace-filters.ts`、`src/components/object-filters.tsx` —— 归档视图的筛选实现，尚未随任何提交进入仓库

已提交的业务代码覆盖上表 1~20 行；此前列的「前端未提交」已随 `82d8d54` 提交，但前端此后又有新文件在写。

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

**通用预防**（比单条修复更重要）：

- 每完成一个可交付切片就跑 typecheck + lint + test，并用真实 HTTP 请求验证关键路径；
- 数据库约束与领域规则同时写，测试里至少各有一条「绕过应用层直写」的断言；
- 外部契约（Logto / RAGFlow）以实测响应为准，实测值进 `04_INTEGRATION.md`，不写「应该是」。

---

## 5. 验证流程

### 5.1 提交前四条（全部在项目根目录执行）

```bash
npm run typecheck   # node node_modules/typescript/bin/tsc --noEmit
npm run lint        # node node_modules/eslint/bin/eslint.js .
npm test            # node node_modules/vitest/vitest.mjs run
npm run build       # 改动涉及构建配置或路由时执行
```

通过标准：typecheck / lint 无输出、测试全绿。当前基线是 **10 个测试文件 127 项**（`a7aa5f3`，2026-11-11 15:13 复跑确认）。

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
```

完整端点、字段与错误码见 [06_API.md](06_API.md) 第 4、7 节。

已按此流程记录过的实测（来自 `05_CHANGELOG.md`，非本次复跑）：状态迁移 200、跳级 409、过期 revision 409、资产迁移 400、未知 id 404；编辑 200、用 PATCH 改库别 400、跨库迁移 200、缺 reason 400、归档 200、取消归档 200、删除 204；对象详情 200、审计 200、未知 id 404；内容上传 201（落 1 条 `content_refs` + 1 条 `pending` upsert，真实 RAGFlow）。

### 5.4 迁移验证

- `tests/server/db-client.test.ts` 覆盖：PRAGMA 生效、全部表创建、**重复打开同一文件不重复执行迁移**、约束兜底、迁移目录缺失时的可读报错。
- 迁移文件在 `drizzle/`，命名递增；打开连接时按序执行（`src/server/db/client.ts`）。目录默认取 `cwd/drizzle`，可用 `MIGRATIONS_FOLDER` 覆盖——以 `next start` 从其他目录启动时不必依赖「cwd 恰好是仓库根」；缺 `meta/_journal.json` 时直接报「找不到迁移目录」。
- `0004_library_events_cross_check.sql` 给 `library_events` 加了 `from_library <> to_library` 的 CHECK；服务层本就拒绝同库迁移，这条是直写数据库时的兜底。
- 手工核对时，`drizzle/meta/000N_snapshot.json` 是「应然」，`.sql` 是「实然」，两者不一致以能执行且测试通过的 SQL 为准，并回头修快照。

### 5.5 外部服务连通性（已部署时）

```bash
# Logto：204 表示服务正常
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3001/api/status

# RAGFlow：返回版本字符串
curl -s http://localhost:9380/v1/system/version
```

端口与版本以 [04_INTEGRATION.md](04_INTEGRATION.md) 的实测表为准（Logto 3001 / 控制台 3002；RAGFlow API 9380 / Web 18080）。

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
| Logto 浏览器内完整登录 | Phase 1 验收 AUTH-02 / 04 / 06 / 07 无法确认；`ownerSub` 未与真实 Logto 用户对齐 | 用户本人登录一次 | `GET /api/logto/sign-in` 已验证 307 且回调地址被 Logto 接受；换码与进 `/workspace` **未验证**。步骤见 `04_INTEGRATION.md`「待人工完成」 |
| 审查机器人 provider 401 | 后续提交没有独立复审，P1 之后的回归风险靠自测兜底 | 恢复审查通道 | 本轮仍不可用；不影响已提交代码运行 |
| RAGFlow 解析 / 检索 | `content_refs.parse_status`、chunk 数与检索链路无法接线 | 需要 chat model / embedding 外部 API key | 上传、替换、列表、删除已实测；`POST /api/v1/datasets/{id}/chunks` **未调用** |

### 7.2 待验证 / 未完成

- **outbox 失败重试未经真实环境验证**：`sync-service` 的 404 视为达成目标、失败退避只有假网关单测；真实 RAGFlow 下已验证迁移后 meta 回读与删除后文档消失，但未构造真实 500/断网来观察退避。
- **worker 的启动条件容易误判**：`instrumentation` 只在同时配置 `RAGFLOW_BASE_URL` 与 `RAGFLOW_API_KEY` 且 `SYNC_WORKER_ENABLED` 不为 `false` 时挂定时器；因此「队列一直 pending」先查配置，而不是查 worker 逻辑。
- **解析状态不流转**：`content_refs.parse_status` 上传后恒为 `pending`，不回写 `succeeded` / `failed`，也没有 `chunk_count`。
- **内容只写不读**：没有下载、正文读取、内容引用查询、内容删除或附件管理接口（详见 `06_API.md` 第 8 节）。
- **新建对象不入 outbox**：`create()` 只写 `objects`，不写 `sync_jobs`；编辑、归档、迁移、删除、内容上传会入队。新建本身没有内容可同步，暂不视为缺陷，但新建后立刻改元数据只会产生一条 upsert。
- **生产构建**：`05_CHANGELOG.md` 记录 `b6e719b`、`5cbbcad` 时生产构建通过；`5b19bfe` 之后（含 `07652b7` ~ `1ea0b86`）**未复跑** `npm run build`。`instrumentation.ts` 与进程内定时器是 Next 的生产特性，构建与 `next start` 下是否如期挂载也没验证过。
- **`02_PHASES.md` 状态过时**：仍写 Logto / RAGFlow 未部署，需按 `04_INTEGRATION.md` 的实测结果更新。
- **`01_ARCHITECTURE.md` 未提交改动含过时句**：3.1 里那段写着「内容上传与同步投递尚未实现」，在 `49e26de` 之后前半句已不成立；随该文件提交时一并改。
- **验收标准与实现的端点名不一致**：产品验收标准使用 `/api/assets`、`/api/works`、`/api/auth/callback`、`/api/auth/sign-out`；实现是 `/api/objects` 与 `/api/logto/*`。验收前必须统一口径，否则「按标准测」会全部对不上。
- **P2 清单**：任务简报提到「剩余 P2 见 changelog」，但 `05_CHANGELOG.md` 中没有 P2 标记或列表，无法据此核对。可核实的未完成项即本节与 `01_ARCHITECTURE.md` 列出的内容。
- **LightRAG**：未部署，Phase 3 前无内容。
- **工作区未提交改动**：见 3.1，提交前不计入交付。

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

## 附录 B：常用命令

```bash
npm run dev        # 开发服务器，http://localhost:3000
npm run build      # 生产构建
npm run start      # 生产启动（需先 build）
npm run typecheck  # tsc --noEmit
npm run lint       # eslint .
npm test           # vitest run
```

数据库文件默认 `data/app.db`，用 `DATABASE_PATH` 覆盖；迁移目录默认 `cwd/drizzle`，用 `MIGRATIONS_FOLDER` 覆盖；连接固定开 WAL、外键、`busy_timeout=5000`。

## 附录 C：术语

| 词 | 含义 |
|----|------|
| 内库 / 外库 | 已验证可复用 / 输入与待验证；判断标准是「敢不敢直接拿去用」，不是内容来源（ADR-008） |
| content_ref | 业务对象与 RAGFlow 文档的映射行，独立表 |
| content_key | 映射的幂等键，写入 RAGFlow `meta_fields`，用于删除重传后认回文档 |
| 乐观锁 revision | 每次写入 +1；更新时校验，防止覆盖并发修改 |
| outbox | `sync_jobs` 表：元数据变更先可靠落队，再异步投递 |
