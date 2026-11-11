# 分阶段计划与当前进度

> 每次完成重要工作后，由 AI 根据 `docs/prompts/maintain-docs.md` 更新本文件。  
> 方向锚点：`00_SCOPE.md` + `03_DECISIONS.md`（含 ADR-005 ~ ADR-009）。

## 当前状态

- **整体进度：约 92%**。Phase 0、1、2、3、4 主路径完成，Phase 5 剩失败路径实测、多轮问答与打磨；Logto 真实登录已用测试账号端到端验证。
- **所处阶段**：**Phase 5（主路径贯通，进入打磨与实测）**。Phase 1 的真实登录验收已完成（测试账号 `pakp_test`）；Phase 3 图谱增加读侧按账号过滤（ADR-011），强隔离仍待多用户前改造。
- **环境**：Docker 29.9.2、Docker Compose v5.6.1、WSL Ubuntu 已就绪（2026-11-11 实测）；Logto 1.46.0、RAGFlow v0.20.5 与 LightRAG 1.5.7 均已在本机运行并通过连通性 / API 实测。
- **业务侧**：Next.js 16 App Router + TypeScript + SQLite/Drizzle 已落地；对象 CRUD、作品状态机、跨库迁移与审计、归档、工作台筛选与行内操作、内容检索页、对象详情页均已实现，共 24 条 HTTP 路由（21 条业务 / 系统 + 3 条 Logto 跳转，见 [06_API.md](06_API.md)）。
- **内容侧**：内容上传、`meta_fields` 映射、outbox 投递、解析触发与轮询、引用列表、原文下载、检索均已实现；RAGFlow v0.20.5 上「上传 → 解析 → 检索 → 下载 → 归档后检索为 0」端到端跑通。
- **图谱侧**：LightRAG 1.5.7 本机部署；`/graph` 页支持实体列表、两层邻域 SVG、图增强问答与手动同步；5 条 `/api/graph/*` 路由已实现；真实数据下实体抽取、邻域查询与问答均跑通。
- **前端**：`/search`、`/workspace/[id]` 与 `/graph` 已在 **`AUTH_MODE=logto` 真实身份**下用无头浏览器冒烟通过（2026-11-11）；此前 mock 身份的页面实测仍有效。
- **未验证**：同步 / 解析失败重试仍只有假网关单测，未在真实 RAGFlow 上构造 500 / 断网观察退避；本人账号 `JCzero001` 尚未走过一次应用内登录（链路已由测试账号验证）。
- **未实现**：基于 RAGFlow 的多轮问答会话（需要 chat model API key）；LightRAG 强多租户隔离（当前为读侧过滤）。
- **最新提交**：`85c6093` 文档更新、`d945a83` Phase 3 文档、`ec6a48f` 图谱前端、`8432585` 图谱接口、`c9ea9a0` LightRAG 基础设施与适配器；此前 `3b8ddb4` 工作台筛选、`4e86ddf` 归档状态守卫、`26fcbe5` / `cd2dc50` 文档同步。
- **阻塞项**：无。唯一待人工的是本人账号的一次登录（可选，链路已验证）。

## 阶段总览

| 阶段 | 目标 | 状态 | 完成标准 |
|------|------|------|----------|
| **Phase 0** | 文档体系 + 基础环境就绪 | **已完成**（2026-11-11） | docs 与 ADR 对齐；Logto、RAGFlow 能 Docker 启动并访问 |
| **Phase 1** | Next.js 骨架 + Logto 认证 + 最小持久化 | **已完成**（真实登录已用测试账号验证，2026-11-11） | Next.js 应用可运行；`POST /api/objects` 落库、重启后数据仍在；mock 与 logto 两种身份模式可切换 |
| **Phase 2** | RAGFlow 内容底座 | **已完成** | Dataset / Document、解析与检索可用；业务侧通过 `content_ref` 关联 |
| **Phase 3** | LightRAG 知识图谱 | **主路径完成**（读侧按账号过滤，ADR-011） | 构图与查询；共用 Embedding、独立存储 |
| **Phase 4** | 核心业务（资产 + 工作流） | **已完成** | 资产 CRUD + 四阶段流转；内容映射进 RAGFlow；归档与迁移审计可用 |
| **Phase 5** | 联调与打磨 | **主路径完成** | 登录 → 资产 / 工作流 → 检索 / 图谱主路径贯通；剩登录验证与失败路径 |

> **Phase 1 范围扩展（2026-11-11）**：完成标准由「骨架 + Logto 登录」扩展为「身份 + 最小持久化 CRUD」。依据是产品的 **DATA-01 / DATA-05 / DATA-08**，存储选型见 ADR-009。

## 已完成

### Phase 0：环境与外部服务

- [x] 明确产品边界与技术选型（Logto 自托管、RAGFlow 本地 Docker、LightRAG、单用户），采纳 ADR-001 ~ ADR-006
- [x] 建立完整 docs 体系（范围、架构、决策、阶段、集成、API、手册、变更日志）
- [x] Docker 环境实测就绪：Docker 29.9.2、Compose v5.6.1、WSL 内有 Ubuntu；资源满足要求（内存 31.5 GB、D 盘可用 494 GB）
- [x] **Logto 1.46.0 部署**：`logto` / `logto-postgres` 容器 healthy；控制台 `http://localhost:3002/console`、API `http://localhost:3001`；`/oidc/.well-known/openid-configuration` 返回正常
- [x] **RAGFlow v0.20.5 部署**：`ragflow-server` 等 5 个容器 healthy；API `http://localhost:9380`、Web UI `http://localhost:18080` 可访问
- [x] 实测端口、版本、环境变量写入 [04_INTEGRATION.md](04_INTEGRATION.md)

### Phase 1：身份与持久化

- [x] 从零初始化 Next.js 16 App Router + TypeScript + ESLint + Vitest（ADR-006）
- [x] SQLite + Drizzle 持久化：5 个迁移，首次访问自动建库并迁移；`data/` 已 gitignore
- [x] 对象模型与仓储：资产 / 作品统一表、`revision` 乐观锁、软删除、CHECK 约束兜底
- [x] 身份抽象：`AUTH_MODE=mock`（开发默认固定身份）与 `AUTH_MODE=logto`（`@logto/next` 会话适配器）
- [x] 三条 Logto 跳转路由：`/api/logto/sign-in`、`/sign-in-callback`、`/sign-out`，回调地址已在 Logto 控制台保存
- [ ] **浏览器内完成一次真实登录**（人工步骤；成功后 `requireSession()` 放行 `/workspace`，`ownerSub` 应等于 Logto `sub`）

### Phase 2：RAGFlow 内容底座

- [x] 统一 Dataset（ADR-007）：默认 `pakp-content`，ID 或名称二选一查找，缺失时自动创建
- [x] 内容上传与替换：`POST /api/objects/{id}/content`（multipart，25 MB 上限），上传后写 `meta_fields`
- [x] `sync_jobs` outbox：与业务写库同事务入队，进程内 worker 定时投递，`POST /api/sync/run` 可手动催一轮
- [x] 解析触发与轮询：上传后触发 `POST /api/v1/datasets/{id}/chunks`，`POST /api/parse/run` 回写 `parse_status`
- [x] 内容引用列表 `GET /api/objects/{id}/content`、原文下载 `GET /api/objects/{id}/content/{refId}`
- [x] 内容检索 `GET /api/search`：RAGFlow 召回 + 归属 / 归档 / 库别过滤
- [x] 真实 RAGFlow v0.20.5 端到端实测：上传 → 解析（9–12 秒，`chunk_count = 1`）→ 检索（相似度 0.38–0.48）→ 下载（逐字节一致）→ 归档后同一检索 0 条
- [ ] 失败路径实测（解析 FAIL、Token 失效、RAGFlow 停机时的重试与退避）

### Phase 3：LightRAG 知识图谱

- [x] **ADR-010**：本机 Python 进程部署 LightRAG；LLM 用 Ollama `deepseek-r1:7b`；Embedding 复用 RAGFlow 的 `BAAI/bge-large-zh-v1.5`（经本地 OpenAI 兼容服务暴露）；图 / 向量存储独立于 RAGFlow
- [x] 基础设施 `infra/lightrag/`：独立 venv、`.env` / `.env.example`、`start.ps1`、`embedding_server.py`（:9381）；数据与模型目录已 gitignore
- [x] `LightragClient` 适配器：文本入库、文档分页、删除、标签、子图、`mix` 问答；API Key 走 `X-API-Key`，问答超时 180 秒
- [x] `graph-service`：内容 → 分块原文 → 带元数据头的图谱文本；`pakp:obj:{id}:{hash}` 作为 `file_source`，内容哈希判重、旧版本清理、引用回映射业务对象
- [x] 5 条接口：`GET /api/graph/labels`、`GET /api/graph`、`POST /api/graph/sync`、`GET /api/graph/status`、`POST /api/graph/query`
- [x] `/graph` 页：实体筛选列表、两层邻域同心圆 SVG（点击切换中心）、实体描述、图问答与来源对象、同步按钮与抽取进度轮询
- [x] 实测（2026-11-11，本机 CPU）：118 字测试文档抽取约 3.8 分钟完成，产出 9 个实体 / 3 条关系；`/graph` 页面 SSR 正常，点击实体切换邻域；`mix` 问答 93.8 秒返回中文答案
- [ ] **多用户隔离**：LightRAG 图 / 问答路由绑定单实例默认 workspace，`LIGHTRAG-WORKSPACE` 头只覆盖部分接口；当前依赖「单用户本地部署」，多用户前必须为每个 `ownerSub` 拆分实例或改造路由
- [ ] 抽取质量评估：7B 模型会把「#」等噪声当实体，关系描述偶有格式告警；换用更强模型或 14B 后需复测

### Phase 4：资产与工作流

- [x] 对象 CRUD：新建、详情、编辑、软删除；列表关键字 / 类型 / 库别 / 状态 / 排序 / 分页
- [x] 四阶段状态机 `draft → finished → published → practiced`；外库作品不得直接 `practiced`
- [x] 跨库迁移（内库 ↔ 外库）与 `library_events` 审计流水
- [x] 归档 / 取消归档；**已归档作品推进状态返回 `409 CONFLICT`**
- [x] `/workspace` 工作台：服务端筛选（`q / type / library / status / sort / archived`）、概览统计、新建、行内操作、归档视图

### Phase 5：检索与详情前端

- [x] `/search` 检索页：URL 保存检索词 / 库别 / 阈值；结果按相似度排序，展示类型、库别、状态、形态徽标与相似度
- [x] 摘要渲染：RAGFlow 返回的 HTML 先剥离标签与脚本，只以 React 文本 + `<mark>` 输出，不使用 `dangerouslySetInnerHTML`
- [x] 空状态与错误状态：未输入、条件非法、检索不可用、无结果都有明确的下一步（放宽阈值 / 去掉库别 / 重试）
- [x] `/workspace/[id]` 详情页：元数据、四阶段操作、内容文件列表、解析状态、下载、上传主内容 / 附件
- [x] 对象不存在时展示 404 页面；工作台行标题链接到详情页，侧栏统一为共用组件
- [x] 实测（2026-11-11，`AUTH_MODE=mock` + 本机 RAGFlow）：检索「内容复盘」返回 1 条（相似度 70%）、`<mark>` 高亮正确；详情页显示「已解析」；下载 650 B 与上传一致；404 页面可见

### 工程与文档

- [x] 功能提交 `3b8ddb4` / `4e86ddf` 上 lint、typecheck、`next build` 均通过；Phase 3 后复跑 19 个测试文件 / 216 项全部通过（2026-11-11）
- [x] [06_API.md](06_API.md) 覆盖全部 24 条路由与未实现清单；[07_PLAYBOOK.md](07_PLAYBOOK.md) 记录开发流程与问题沉淀；[08_RUN_LOG.md](08_RUN_LOG.md) 留档真实登录联调与验收的操作过程
- [x] 每轮实现后同步 CHANGELOG 与阶段文档

## 下一步行动

按优先级：

1. ~~**Phase 1 收尾**~~：已完成（2026-11-11）。测试账号 `pakp_test`（`sub` `7vjekboa76zu`）走通登录 → `/workspace`，`ownerSub` 已记入 [04_INTEGRATION.md](04_INTEGRATION.md)。
2. ~~**前端登录态冒烟**~~：已完成。真实身份下 `/search`、`/workspace/[id]`、`/graph` 均渲染正常，创建资产 201、非法请求 400、匿名 401。
3. **失败路径实测（待做）**：在真实 RAGFlow 上验证解析失败回写、outbox 重试退避、RAGFlow 不可用时接口的 500 语义；现有 12 项单测覆盖，但不等于真实故障实测。
4. **多轮问答会话**：需要 chat model API key；当前 RAGFlow 只有本地 embedding，检索可用但生成不可用。
5. **图谱强隔离（待做）**：读侧过滤已完成（ADR-011）；真正强隔离需按 `ownerSub` 拆分 LightRAG 实例 / 工作目录，触发条件是多账号同时使用图谱。
6. ~~**生产运行检查**~~：已完成。`next build` + `next start`（3100）通过，health 200 / 首页 200 / 未登录 307 / sign-in 307 到 Logto；开机自启由 `scripts\autostart.ps1` + 启动文件夹负责。

## 各阶段关键约束（提醒）

- **Phase 0~1**：环境与身份分离表述；「容器可启动」不等于「登录已验证」。
- **Phase 1**：包含新建 Next.js，不是改造旧前端（ADR-006）。
- **Phase 2**：RAGFlow 为内容唯一真相源；业务只保存元数据 + 状态 + `content_ref`。
- **Phase 3**：LightRAG 与 RAGFlow 仅共用 Embedding，不共用向量库（ADR-001）。
- **Phase 4**：资产与工作流只维护元数据、状态与 `content_ref`，不保存内容正文。
- **全程**：方向变更必须新增 ADR，并同步 `00_SCOPE` / `01_ARCHITECTURE`；未实测的集成细节一律标注「待实测」。

## 风险与注意点（当前）

| 风险 | 应对 |
|------|------|
| 把「Logto 部署可用」误写成「登录已验证」 | 两者分开表述；已用测试账号完成一次完整登录并记录 `ownerSub`，本人账号再登录时按同一链路核对 |
| 把「页面在 mock 身份下实测」误写成「Logto 下已验收」 | 已在真实身份下补做无头浏览器冒烟；新增页面仍需同样复测 |
| RAGFlow 资源占用较高 | 本机 31.5 GB 内存、D 盘可用 494 GB 已满足；启动后关注实际占用 |
| 失败重试只有单测覆盖 | 真实故障场景（停机、解析失败、Token 失效）待补测，文档不得写成已验证 |
| 多实例部署重复投递 | `sync_jobs` 原子认领可避免重复处理，但 worker 为进程内定时器；部署前确认实例数与间隔 |
| LightRAG 单 workspace，实体抽取全局合并 | 读侧已按 `file_path` 过滤（ADR-011）；抽取仍是全局的，开放多用户前需拆分实例 / 工作目录 |
| CPU 构图与问答较慢 | 118 字文档抽取约 3.8 分钟、`mix` 问答约 94 秒；同步接口只负责入队，前端轮询进度；长文档需更长等待或换 GPU / 云模型 |
| 7B 模型抽取质量有限 | 会把「#」等噪声当实体、关系偶发格式告警；换模型后在真实语料上复评，不把当前图谱当作质量基线 |
| 文档与实现脱节 | 遵守 maintain-docs；每次有意义工作后更新本文件与 CHANGELOG |
| 服务未启动就编造集成细节 | 禁止；`04_INTEGRATION.md` 只写实测值 |
