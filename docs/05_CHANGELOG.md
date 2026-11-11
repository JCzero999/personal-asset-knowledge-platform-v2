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
