# 个人资产与知识平台

以 RAGFlow 为统一内容存储与检索底座，在其上实现资产管理、四阶段作品工作流的个人知识工作台。

技术栈：Next.js 16 App Router + React 19 + TypeScript + SQLite（Drizzle ORM）；登录用自托管 Logto；知识图谱计划接 LightRAG（未开始）。

当前处于 **Phase 5（主路径完成）**：资产 / 工作流主链路、RAGFlow 内容链路、内容检索页与对象详情页均已可用；Logto 真实登录待人工验证。阶段口径见 [docs/02_PHASES.md](docs/02_PHASES.md)。

## 当前实现状态

### 已实现

| 能力 | 说明 |
|------|------|
| 持久化 | SQLite + Drizzle，`drizzle/` 下 5 个迁移；首次访问自动建库并迁移，默认文件 `data/app.db`（可 `DATABASE_PATH` 覆盖） |
| 对象 CRUD | 资产 / 作品统一模型，软删除、`revision` 乐观锁、分类 / 标签 / 优先级；列表支持 `q / type / library / status / sort / archived` 筛选与分页 |
| 作品工作流 | `draft → finished → published → practiced` 状态机；内库 / 外库迁移与迁移审计；归档 / 取消归档；已归档作品推进状态返回 `409` |
| 工作台 | `/workspace` 服务端渲染列表、概览统计、新建、行内操作（推进状态、迁移库别、编辑、归档、删除） |
| 内容链路 | 上传到 RAGFlow 统一 dataset、`meta_fields` 映射、`sync_jobs` outbox 投递（进程内 worker + `POST /api/sync/run`）、解析触发与状态轮询（`POST /api/parse/run`）、内容引用列表、原文下载、内容检索 `GET /api/search` |
| 检索页 | `/search` 服务端渲染：URL 保存检索词 / 库别 / 阈值，结果按相似度排序，摘要只渲染纯文本与 `<mark>`，空结果与不可用状态都有下一步 |
| 对象详情页 | `/workspace/[id]`：元数据、四阶段操作、内容文件列表、上传主内容 / 附件、解析状态轮询、下载；对象不存在时展示 404 页 |
| 身份 | `AUTH_MODE=mock`（开发默认，固定本地身份）/ `AUTH_MODE=logto`（三条 `/api/logto/*` 跳转路由） |
| HTTP API | 共 19 条路由：16 条业务 / 系统接口 + 3 条 Logto 跳转；契约见 [docs/06_API.md](docs/06_API.md) |

### 验证状态

- **RAGFlow v0.20.5**：上传 → 解析（约 9–12 秒完成，`chunk_count = 1`）→ 检索（相似度 0.38–0.48）→ 原文下载（与上传文件逐字节一致）→ 归档后同一检索返回 0 条，已在本机端到端跑通。
- **Logto 1.46.0**：容器、控制台、OIDC discovery 与 sign-in 重定向已实测；**浏览器内完整登录与回调换码尚未人工验证**，`AUTH_MODE=logto` 因此不能视为已验收。
- **检索页 / 详情页**：`AUTH_MODE=mock` + 本机 RAGFlow 下用真实数据跑通。检索页提交「内容复盘」得到 1 条结果（相似度 70%），摘要按 `<mark>` 高亮且不含原始 HTML；详情页显示解析状态「已解析」，下载与上传接口可用；不存在的对象展示 404 页面。
- 同步投递 / 解析轮询的失败重试与退避目前只有假网关单测覆盖，真实 RAGFlow 上验证的是成功路径。

### 未实现

- LightRAG 知识图谱；RAGFlow 多轮问答会话（不组装上下文、不调用 chat model）。
- 内容单独删除 / 附件解绑、列表 `total` / 游标、多用户权限与协作。

## 本地运行

要求 Node.js **20.9 或更高**（Next.js 16 要求）。

```bash
npm install
# 首次运行且没有 .env.local 时，从模板复制；已有 .env.local 请勿覆盖
cp .env.example .env.local   # Windows PowerShell: Copy-Item .env.example .env.local
npm run dev
```

打开 `http://localhost:3000`。

- 模板默认 `AUTH_MODE=mock`：开发环境使用固定本地身份，无需 Logto 即可进入 `/workspace`。若 `.env.local` 已改为 `AUTH_MODE=logto`，则需先完成 Logto 登录。
- 数据库：首次访问自动创建 `data/app.db` 并执行 `drizzle/` 迁移；`data/` 已 gitignore，无需手工建表。
- 内容链路需要可用的 RAGFlow：按 [infra/ragflow/README.md](infra/ragflow/README.md) 启动，并在 `.env.local` 填写 `RAGFLOW_BASE_URL`、`RAGFLOW_API_KEY`、`RAGFLOW_DATASET_NAME`（或 `RAGFLOW_DATASET_ID`）。未配置时上传 / 解析 / 检索接口会报错，工作台其余功能不受影响。
- Logto 登录需 `AUTH_MODE=logto` + `LOGTO_*` 环境变量，部署见 [infra/logto/README.md](infra/logto/README.md)。

健康检查（无需登录）：

```text
GET /api/health
```

## 验证命令

```bash
npm run lint
npm run typecheck
npm test          # 17 个测试文件 / 205 项用例（2026-11-11 实测）
npm run build
```

测试不依赖 Docker 或外部服务：SQLite 使用内存库，RAGFlow 使用假网关。

## 配置

| 变量 | 用途 |
|------|------|
| `APP_URL` | 应用地址，Logto 回调与跳转使用；默认 `http://localhost:3000` |
| `AUTH_MODE` | `mock` / `logto`；开发环境未设置时按 `mock`，生产环境未设置时视为无身份 |
| `DATABASE_PATH` | SQLite 文件路径；默认 `data/app.db` |
| `RAGFLOW_BASE_URL` / `RAGFLOW_API_KEY` | RAGFlow API 地址与 token；不配置时同步 worker 不启动，内容接口按配置缺失失败 |
| `RAGFLOW_DATASET_ID` / `RAGFLOW_DATASET_NAME` | 统一内容库；优先用 ID，留空则按名称查找并在缺失时创建（默认名 `pakp-content`） |
| `SYNC_WORKER_ENABLED` / `SYNC_WORKER_INTERVAL_MS` | 进程内 outbox worker 开关与轮询间隔（默认 30 秒） |
| `LOGTO_ENDPOINT` / `LOGTO_APP_ID` / `LOGTO_APP_SECRET` / `LOGTO_COOKIE_SECRET` | `AUTH_MODE=logto` 时必填 |

**安全约束**：不要提交 `.env`、`.env.local`、`infra/*/.env` 或任何真实密钥；仓库只保留 `.env.example` 占位。真实值仅写入本地未跟踪文件。

## 目录

```text
src/app/api/               19 条路由（对象、内容、检索、同步 / 解析、Logto、health）
src/app/workspace/         工作台与对象详情页（服务端筛选 / 读取）
src/app/search/            内容检索页（URL 保存检索条件）
src/app/page.tsx           首页 / 未登录入口
src/components/            工作台与检索 UI：侧栏、列表、筛选、新建、行内操作、内容文件
src/domain/                对象模型、工作流状态机、内容引用、错误类型
src/lib/                   前端筛选参数与展示辅助
src/server/adapters/       RAGFlow 与 Logto 会话适配器
src/server/db/             SQLite 连接与 Drizzle schema
src/server/repositories/   对象仓储、内容引用仓储
src/server/services/       对象、内容、同步、解析、检索服务
src/server/http/           响应信封与错误映射
src/server/ports/          会话 / 存储端口接口
drizzle/                   SQL 迁移文件
infra/                     Logto / RAGFlow 本地 Docker 编排
tests/                     单元测试（17 个文件）
docs/                      范围、架构、决策、阶段、集成、API、手册、变更日志
agents/                    CrewAI 文档进度 Agent（非业务应用）
```

## 文档

| 文档 | 内容 |
|------|------|
| [docs/00_SCOPE.md](docs/00_SCOPE.md) | 第一期产品边界 |
| [docs/01_ARCHITECTURE.md](docs/01_ARCHITECTURE.md) | 架构分层与数据关系 |
| [docs/02_PHASES.md](docs/02_PHASES.md) | 阶段计划与当前进度 |
| [docs/03_DECISIONS.md](docs/03_DECISIONS.md) | ADR 决策记录 |
| [docs/04_INTEGRATION.md](docs/04_INTEGRATION.md) | Logto / RAGFlow / LightRAG 集成事实（只写实测值） |
| [docs/05_CHANGELOG.md](docs/05_CHANGELOG.md) | 变更日志 |
| [docs/06_API.md](docs/06_API.md) | HTTP API 参考（19 条路由） |
| [docs/07_PLAYBOOK.md](docs/07_PLAYBOOK.md) | 开发流程与问题沉淀 |

## 开发约束

1. 改动前先读 [AI_CONTINUE_DEV_GUIDE.md](AI_CONTINUE_DEV_GUIDE.md)、[docs/00_SCOPE.md](docs/00_SCOPE.md)、[docs/03_DECISIONS.md](docs/03_DECISIONS.md)；改接口前读 [docs/06_API.md](docs/06_API.md)。
2. 每次有意义的工作后更新 [docs/02_PHASES.md](docs/02_PHASES.md) 与 [docs/05_CHANGELOG.md](docs/05_CHANGELOG.md)。
3. 方向变化必须新增 ADR，不得直接推翻已采纳决策。
4. 文档与代码不一致时以代码为准，并回头修正文档；未实测的集成细节标注「待实测」，不得编造端口、地址或凭据。
