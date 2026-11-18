# 个人资产与知识平台

以 RAGFlow 为统一内容存储与检索底座，在其上实现资产管理、四阶段作品工作流的个人知识工作台。

技术栈：Next.js 16 App Router + React 19 + TypeScript + SQLite（Drizzle ORM）；登录用自托管 Logto；知识图谱用 LightRAG。

当前处于 **Phase 6（图谱 2D 聚焦 + 3D 星河的默认入口、Worker、抽稀与自适应降档已落地）**：资产 / 工作流主链路、RAGFlow 内容链路、内容检索页、对象详情页、管理后台与知识图谱均已可用，Logto 真实登录已端到端验证。阶段口径见 [docs/02_PHASES.md](docs/02_PHASES.md)。

> **第一次使用？** 直接看 [docs/09_USER_GUIDE.md](docs/09_USER_GUIDE.md)（新手使用手册，不需要懂代码）。

## 当前实现状态

### 已实现

| 能力 | 说明 |
|------|------|
| 持久化 | SQLite + Drizzle，`drizzle/` 下 9 个迁移；首次访问自动建库并迁移，默认文件 `data/app.db`（可 `DATABASE_PATH` 覆盖） |
| 对象 CRUD | 资产 / 作品统一模型，软删除、`revision` 乐观锁、分类 / 标签 / 优先级；列表支持 `q / type / library / status / tag / sort / archived` 筛选与分页 |
| 形态与标签词表 | 作品形态**内置 6 种，可自定义**（`work_formats`，`objects.format` 外键）；标签是全站共用词表（`tags` + `object_tags`，每对象最多 10 个、单个 ≤ 20 字），改名与合并全站立即生效；`GET /api/vocabulary` 是唯一读取入口，8 条写接口仅管理员（ADR-016 / ADR-019） |
| 作品工作流 | `draft → finished → published → practiced` 状态机；内库 / 外库迁移与迁移审计；归档 / 取消归档；已归档作品推进状态返回 `409` |
| 工作台 | `/workspace` 三栏框架：图标导航栏 + 工作台目录 + 列表 + 详情；服务端渲染筛选、概览统计、新建、行内操作（推进状态、迁移库别、编辑、归档、删除）；列表顶部批量条支持全选后批量归档 / 导出 / 删除（ADR-015）；点列表只换右栏，筛选保留 |
| 界面框架 | 四个页面共用「图标导航栏 + 模块目录 + 内容区」三栏（ADR-013）：目录按模块分区，工作台多一列列表；≤1100px 收起目录，≤900px 列表 / 详情二选一 |
| 内容链路 | 上传到 RAGFlow 统一 dataset、`meta_fields` 映射、`sync_jobs` outbox 投递（进程内 worker + `POST /api/sync/run`）、解析触发与状态轮询（`POST /api/parse/run`）、内容引用列表、原文下载、内容检索 `GET /api/search` |
| 检索页 | `/search` 服务端渲染：URL 保存检索词 / 库别 / 阈值，结果按相似度排序，摘要只渲染纯文本与 `<mark>`，空结果与不可用状态都有下一步 |
| 对象详情页 | `/workspace/[id]`：元数据、四阶段操作、内容文件列表、上传主内容 / 附件、解析状态轮询、下载；对象不存在时展示 404 页 |
| 正文编辑 | 详情页「编写正文 / 编辑正文」，顶部选**类型**（ADR-014）：`纯文本`（行号列、行数 / 字数、Tab 缩进）或 `Markdown`（左写右实时预览，零依赖解析器，不注入 HTML）；`Ctrl/Cmd+S` 保存、未保存离开确认；Markdown 存为 `text/markdown` / `.md`，打开已有 `.md` 自动选中；支持 `.md` `.markdown` `.txt` `.json` `.csv` 与 `text/*`，保存复用内容上传接口（主内容仍是「同一行替换」） |
| 管理后台 | `/admin`（仅 `ADMIN_SUBS` 白名单内的 Logto 账号，ADR-012）：依赖服务探测、存储与同步队列、按账号归属统计，可手动「立即同步 / 推进解析」；非管理员显示 403 说明页 |
| 词表管理 | `/admin/vocabulary/formats`、`/admin/vocabulary/tags`（ADR-019）：新增 / 改名 / 排序 / 停用形态，删除被引用形态前先迁移；标签新增 / 改名 / 合并 / 删除（可选从内容上移除）；入口在第二列目录底部的「管理」分组，仅管理员可见 |
| 知识图谱 | LightRAG 1.5.7 本机进程：实体列表、两层邻域、图问答与手动同步；读侧按账号归属过滤（ADR-011）。`/graph` 三种视图：**2D 聚焦阅读**（SVG 力导向，选中 / 邻域 / 最短路径 / 列表）、**3D 星系**（three.js，节点 / 边 / 标签都各一次 instanced 绘制，超过 300 节点自动进 Worker 布局）、列表；桌面默认 3D，移动端与无 WebGL / reduced-motion 回落 2D。三档画质（low / balanced / high）按预算抽稀节点并限制标签与 DPR，连续两个慢窗口自动降一档且只降不升 |
| 身份 | `AUTH_MODE=mock`（开发默认，固定本地身份）/ `AUTH_MODE=logto`（三条 `/api/logto/*` 跳转路由）；登录后侧栏底部有「退出登录」，顶部显示当前账号 |
| HTTP API | 31 个 `route.ts` 路径、按「方法 × 路径」共 36 条接口：33 条业务 / 系统 + 3 条 Logto 跳转；另有 2 条 308 兼容跳转的旧词表路径。契约见 [docs/06_API.md](docs/06_API.md) |

### 验证状态

- **RAGFlow v0.20.5**：上传 → 解析（约 9–12 秒完成，`chunk_count = 1`）→ 检索（相似度 0.38–0.48）→ 原文下载（与上传文件逐字节一致）→ 归档后同一检索返回 0 条，已在本机端到端跑通。
- **Logto 1.46.0**：容器、控制台、OIDC discovery 与 sign-in 重定向已实测；**浏览器内完整登录已用测试账号 `pakp_test` 端到端验证**（回调 307 → `/workspace 200`），操作过程见 [docs/08_RUN_LOG.md](docs/08_RUN_LOG.md)。
- **检索页 / 详情页**：`AUTH_MODE=mock` + 本机 RAGFlow 下用真实数据跑通。检索页提交「内容复盘」得到 1 条结果（相似度 70%），摘要按 `<mark>` 高亮且不含原始 HTML；详情页显示解析状态「已解析」，下载与上传接口可用；不存在的对象展示 404 页面。
- 同步投递 / 解析轮询的失败重试与退避目前只有假网关单测覆盖，真实 RAGFlow 上验证的是成功路径。
- **质量门全绿**（2026-11-13 实跑）：`tsc --noEmit` 退出 0、`eslint .` 0 error、`vitest run --maxWorkers=2` 46 个测试文件 675 项（672 通过 / 3 项基准跳过）、`check:theme` 129 名 0 失败、`check:contrast` 37/37。
- **图谱 3D 已在生产运行时（`next start`）复验**：桌面默认入口进 3D、`?maxNodes=600` 走真 Worker、低档抽稀计数与画布一致、24× CPU 降速下真实降档且不回升；截图见 `docs/screenshots/phase6d-3d-*-prod.png`。仍跑在 mock LightRAG 夹具与无头 SwiftShader 上，真实 LightRAG + 真实 Logto 会话未复测。

### 未实现

- RAGFlow 多轮问答会话（不组装上下文、不调用 chat model）。
- 内容单独删除 / 附件解绑、列表 `total` / 游标、多用户权限与协作。
- LightRAG 强多租户隔离：当前为读侧过滤，多账号同时使用图谱前需拆分实例或工作目录。

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
node ./node_modules/vitest/vitest.mjs run --maxWorkers=2   # 46 个测试文件 / 675 项（672 通过、3 项基准跳过）
npm run check:theme        # 主题令牌契约：四块 98 名相等、129 名汇总
npm run check:contrast     # 四套主题的对比度：37/37 组
npm run build
```

> 本机内存偏紧，Vitest 默认 worker 池会 OOM；测试一律带 `--maxWorkers=2`。

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
| `ADMIN_SUBS` | 管理员白名单：逗号或空格分隔的 Logto `sub`，命中即显示「系统管理」并可调用维护接口；`AUTH_MODE=mock` 恒为管理员（ADR-012） |

**安全约束**：不要提交 `.env`、`.env.local`、`infra/*/.env` 或任何真实密钥；仓库只保留 `.env.example` 占位。真实值仅写入本地未跟踪文件。

## 目录

```text
src/app/api/               31 个 route.ts（对象、内容、检索、同步 / 解析、词表、管理员、图谱、Logto、health）
src/app/workspace/         工作台与对象详情页（服务端筛选 / 读取）
src/app/search/            内容检索页（URL 保存检索条件）
src/app/graph/             知识图谱页：2D 聚焦 / 3D 星系 / 列表
src/components/            工作台、检索、图谱与后台 UI
src/components/graph/      3D 场景：星场、节点、边、标签层
src/lib/                   前端筛选参数与展示辅助；图谱模型 / 画质档位 / 选择器 / 2D·3D 布局
src/workers/               图谱 3D 布局 Web Worker
src/server/adapters/       RAGFlow 与 Logto 会话适配器
src/server/db/             SQLite 连接与 Drizzle schema
src/server/repositories/   对象仓储、内容引用仓储
src/server/services/       对象、内容、同步、解析、检索、图谱服务
src/server/http/           响应信封与错误映射
src/server/ports/          会话 / 存储端口接口
drizzle/                   SQL 迁移文件
infra/                     Logto / RAGFlow 本地 Docker 编排
scripts/                   主题 / 对比度 / 各阶段截图验收与迁移演练脚本
tests/                     单元测试（46 个文件）
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
| [docs/06_API.md](docs/06_API.md) | HTTP API 参考（31 个路由文件 / 36 条方法×路径） |
| [docs/07_PLAYBOOK.md](docs/07_PLAYBOOK.md) | 开发流程与问题沉淀 |
| [docs/08_RUN_LOG.md](docs/08_RUN_LOG.md) | 真实登录联调与验收的操作实录 |
| [docs/09_USER_GUIDE.md](docs/09_USER_GUIDE.md) | 新手使用手册（面向使用者） |
| [docs/16_GRAPH_DESIGN.md](docs/16_GRAPH_DESIGN.md) | 知识图谱设计稿（2D 聚焦 + 3D 银河） |
| [docs/17_CBM_GALAXY_TECH.md](docs/17_CBM_GALAXY_TECH.md) | 3D 银河的技术实现说明 |

## 开发约束

1. 改动前先读 [AI_CONTINUE_DEV_GUIDE.md](AI_CONTINUE_DEV_GUIDE.md)、[docs/00_SCOPE.md](docs/00_SCOPE.md)、[docs/03_DECISIONS.md](docs/03_DECISIONS.md)；改接口前读 [docs/06_API.md](docs/06_API.md)。
2. 每次有意义的工作后更新 [docs/02_PHASES.md](docs/02_PHASES.md) 与 [docs/05_CHANGELOG.md](docs/05_CHANGELOG.md)。
3. 方向变化必须新增 ADR，不得直接推翻已采纳决策。
4. 文档与代码不一致时以代码为准，并回头修正文档；未实测的集成细节标注「待实测」，不得编造端口、地址或凭据。

## 许可

本项目采用 [PolyForm Noncommercial License 1.0.0](LICENSE)：可免费用于个人学习、研究、实验等**非商业**用途，允许修改和分发（需保留许可与署名）。

**商业用途需要单独授权**，请联系：1975824324@qq.com
