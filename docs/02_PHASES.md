# 分阶段计划与当前进度

> 每次完成重要工作后，由 AI 根据 `docs/prompts/maintain-docs.md` 更新本文件。  
> 方向锚点：`00_SCOPE.md` + `03_DECISIONS.md`（含 ADR-005 ~ ADR-009）。

## 当前状态

- **整体进度：约 97%**。Phase 0、1、2、3、4 主路径完成；Phase 5 剩失败路径实测与多轮问答；**Phase 6 全部落地**（6A 分类统一、6B 检索模糊查询与语义混合、6C 主题收尾、6D 知识图谱 2D 聚焦 + 3D 星河，含生产运行时复验）。Logto 真实登录已用测试账号端到端验证。
- **所处阶段**：**Phase 5 收尾 + Phase 6 已完成**。Phase 1 的真实登录验收已完成（测试账号 `pakp_test`）；Phase 3 图谱增加读侧按账号过滤（ADR-011），强隔离仍待多用户前改造。
- **环境**：Docker 29.9.2、Docker Compose v5.6.1、WSL Ubuntu 已就绪（2026-11-11 实测）；Logto 1.46.0、RAGFlow v0.20.5 与 LightRAG 1.5.7 均已在本机运行并通过连通性 / API 实测。
- **业务侧**：Next.js 16 App Router + TypeScript + SQLite/Drizzle 已落地；对象 CRUD、作品状态机、跨库迁移与审计、归档、工作台筛选与行内操作、内容检索页、对象详情页、管理后台与词表管理均已实现，共 31 个 `route.ts` 路径 / 按「方法 × 路径」36 条接口（33 条业务 / 系统 + 3 条 Logto 跳转，见 [06_API.md](06_API.md)）。
- **内容侧**：内容上传、`meta_fields` 映射、outbox 投递、解析触发与轮询、引用列表、原文下载、检索均已实现；RAGFlow v0.20.5 上「上传 → 解析 → 检索 → 下载 → 归档后检索为 0」端到端跑通。
- **图谱侧**：LightRAG 1.5.7 本机部署；`/graph` 支持 **2D 聚焦阅读**（SVG 力导向，选中 / 邻域 / 最短路径 / 列表）、**3D 星系**（three.js，节点 / 边 / 标签各一次 instanced 绘制，>300 节点走 Web Worker 布局）与列表三种视图，桌面默认 3D、移动端与无 WebGL / reduced-motion 回落 2D；三档画质按预算抽稀并限制标签与 DPR，连续两个慢窗口自动降档且只降不升；5 条 `/api/graph/*` 路由已实现，`GET /api/graph` 支持 `maxNodes=50–600`。真实数据下实体抽取、邻域查询与问答均跑通。
- **前端**：`/search`、`/workspace/[id]` 与 `/graph` 已在 **`AUTH_MODE=logto` 真实身份**下用无头浏览器冒烟通过（2026-11-11）；此前 mock 身份的页面实测仍有效。首页 `/` 于 2026-11-12 升级为银河首页（Phase 5.11），同日 Phase 5.12 把背景换成 three.js 3D 星系，并把全站主题从浅色绿改为深空暖金（ADR-020）。
- **管理后台**：`/admin` 已实现（ADR-012）：`ADMIN_SUBS` 白名单派生 `Session.isAdmin`，页面展示依赖服务、存储与队列、按账号归属统计，提供「立即同步队列 / 推进解析状态」；非管理员渲染 403 说明页；两个维护接口收紧为仅管理员。临时生产实例（mock 身份）实测 `/admin` 200。
- **未验证**：同步 / 解析失败重试仍只有假网关单测，未在真实 RAGFlow 上构造 500 / 断网观察退避；本人账号 `JCzero001` 尚未走过一次应用内登录（链路已由测试账号验证）；图谱 3D 已在 `next start` 生产构建下复验，但仍是 mock LightRAG 夹具 + 无头 SwiftShader，真实 LightRAG / 真实 Logto 会话未在生产运行时复测。
- **未实现**：基于 RAGFlow 的多轮问答会话（需要 chat model API key）；LightRAG 强多租户隔离（当前为读侧过滤）。
- **最新提交**：`208d518` 文档沉淀真实登录联调、问题复盘与操作实录；此前 `85c6093` 文档更新、`d945a83` Phase 3 文档、`ec6a48f` 图谱前端、`8432585` 图谱接口、`c9ea9a0` LightRAG 基础设施与适配器。
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
| **Phase 6** | 体验与图谱深化 | **已完成**（2026-11-13） | 6A 分类词表统一、6B 检索模糊查询与语义混合、6C 主题令牌收尾、6D 知识图谱 2D 聚焦 + 3D 星河（默认入口 / Worker / 抽稀 / 自适应降档已在 `next start` 复验） |
| **Phase 6E** | 大模型配置、内容预览与图谱失败自愈 | **已完成**（2026-11-13） | ADR-025 设置页与四条接口（权限 13 → 15）、ADR-026 预览弹窗（工作台 + 详情入口）、图谱失败归因与重抽；门禁与真实数据验收通过，`apply` 待单独窗口 |

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
- [x] 详情页「内容文件」区新增正文编辑器：行号列、行数/字数、Tab 缩进、Ctrl/Cmd+S 保存、未保存确认；保存复用 `POST /api/objects/{id}/content`（role=primary），主内容仍是「同一行替换 + 删除旧文档」
- [x] `/admin` 管理后台（ADR-012）：依赖服务探测、存储与同步队列、按账号归属；「立即同步 / 推进解析」两个动作；非管理员 403 说明页
- [x] 正文编辑器新增「类型」（ADR-014）：纯文本 / Markdown 分段切换；Markdown 左写右预览，保存为 `text/markdown`；预览由零依赖解析器渲染 React 元素，正文以源码存 RAGFlow

### Phase 5.5：统一三栏应用框架（ADR-013）

- [x] `.app-frame` 网格：76px 图标导航栏 + 模块目录 + 列表 / 详情；`:has(> .directory)` 决定三列，`.has-list` 变四列；页面只组合子元素
- [x] `/workspace` 四列：工作台目录（浏览 / 归属 / 作品进程）+ 列表 + 详情；列表与详情共用同一份 URL 筛选，点条目只换右栏，活动行高亮
- [x] `/search`、`/graph`、`/admin` 统一为「导航栏 + 模块目录 + 内容区」；后台 403 页同样保留导航栏；目录内锚点用原生 `<a>`
- [x] 响应式：≤1100px 隐藏目录，≤900px 列表与详情互斥（`data-selected`），≤560px 导航只留图标
- [x] 清理旧壳：删除 `app-sidebar.tsx` / `workspace-shell.tsx` 与 `.app-shell` / `.sidebar` / `.nav-item` 样式
- [x] 实测（2026-11-11，真实 Logto 账号 + 无头 Chromium，1680×1000 / 860×1000）：列宽 76 / 224 / 340 / 1040 与 76 / 224 / 1380 符合预期，四档页面均无横向溢出、无控制台报错与水合告警

### Phase 5.6：批量操作与界面微调（ADR-015）

- [x] 归属文案统一：目录、检索目录、内容构成、新建对话框不再显示「已验证 / 待验证」，只保留「内库 / 外库」，说明改为「长期复用 / 收集的输入」
- [x] 目录层级：分组标题改为 13px 半粗；「作品进程」四个阶段相对标题缩进 16px 并加从属竖线，活动项竖线变绿
- [x] 第三列批量条（筛选框与列表之间，顺序「标题 → 筛选 → 批量 → 列表」）：全选、已选计数、`批量归档 / 批量导出 / 批量删除`；行内常驻复选框，未选中时禁用
- [x] 批量归档 / 删除复用单条接口逐项执行，部分失败给出数量；删除保留二次确认；成功后清空选择并刷新
- [x] 批量导出：浏览器拼 Markdown（元信息 + 纯文本正文 + 附件文件名），下载 `资产与作品-YYYYMMDD.md`；新增 `export-markdown` 单测
- [x] 实测（2026-11-12，真实 Logto 账号 + 无头 Chromium，1680 / 1100）：批量条顺序与位置正确、无横向溢出、无控制台报错；选择计数、按钮启用、删除弹窗、导出内容均符合预期
- [x] 根布局屏蔽浏览器扩展注入属性导致的水合告警：`<html>` / `<body>` 加 `suppressHydrationWarning`，注入 `data-atm-ext-installed` 复测控制台零告警

### Phase 5.7：长内容滚动（工作台列表与正文编辑器）

- [x] 列表：`.app-frame` 显式 `grid-template-rows: minmax(0, 1fr)`，条目区 `.record-scroll` 拿到有界高度；标题、筛选框、批量条固定不动，只有条目滚动
- [x] 编辑器：`.markdownPane` 加同样的行轨道约束，书写区与预览区补 `min-height: 0`，纯文本 textarea 与 Markdown 左右两栏各自独立滚动，底部统计与「取消 / 保存正文」始终可见
- [x] 滚动条改为常驻细条（10px，`::-webkit-scrollbar`），不再依赖 Windows 11 默认的覆盖式滚动条；列表加 `scrollbar-gutter: stable`，条数变化不抖列宽
- [x] 实测（2026-11-12，真实 Logto 账号 + 无头 Chromium，45 条临时数据）：1680×900 / 1280×800 / 860×1000 下滚轮可滚、可拖到底，末条完整可见、标题与批量条位置不变，滚动条占位 10px；编辑器贴 240 行正文（5908px），纯文本与 Markdown 两栏均可滚到底，底部按钮在 600×800 下仍完整可见；临时数据实测后全部删除

### Phase 5.8：作品形态与标签词表化 · 第一阶段（数据层与接口，ADR-016）

大改造分两阶段：本阶段只做**数据层与服务端接口**，新建对话框、目录管理页、后台与首页留到第二阶段；因此本阶段验收标准是「库结构与 API 就绪、对外契约不变」，不是「界面上能改形态」。

- [x] `work_formats`（`code` 主键 + `label` / `sort_order` / `state` / `is_system`）落地；`objects.format` 由原六值 CHECK 改为外键引用；种子 7 条内置形态（`sort_order` 10…999，`is_system=1`），现有 `article` 对象零改写
- [x] `tags` + `object_tags` 落地，删除 `objects.tags` JSON 列；存量标签按 `json_each` 灌入并按 `lower(trim())` 归并，同一标签的不同写法不产生重复行
- [x] 迁移 `0005_vocabulary.sql` 手工排序：先建词表与种子 → 再重建 `objects`。外键开关移到 `migrate()` 之外（Drizzle 的单事务内 `PRAGMA foreign_keys=OFF` 是空操作），迁移后跑 `PRAGMA foreign_key_check`，非空即抛错拒绝启动；迁移前用 `VACUUM INTO` 自动备份 `<db>.bak-<ISO>`
- [x] 仓储层对外契约不变：`format: string`、`tags: string[]` 由 `object_tags` 水合；标签筛选改走 `EXISTS (... normalized = ?)`，与展示写法解耦
- [x] 统一读取入口 `GET /api/vocabulary`（形态 + 标签，带引用计数，**软删对象不计入**）；新增 `POST/PATCH/DELETE` 形态、标签与 `POST /api/vocabulary/tags/[id]/merge`，全部管理员校验
- [x] 删除保护：被引用的形态 / 标签返回 409 + `usage` + 样例；形态支持 `?migrateTo=` 批量迁移后删除，标签支持 `removeFromObjects` 强制移除；内置形态与最后一个启用形态不可删
- [x] 标签归一化单一实现（`src/domain/vocabulary.ts`）：分隔符（半/全角逗号、顿号、分号、换行）、trim、内部空白折叠、NFKC 全半角、大小写、去重、**每对象 ≤10 个、单标签 ≤20 字**；启用形态 ≤30 个
- [x] 7 处 `workFormats` 硬编码清除，并加 ESLint `no-restricted-imports` 守卫（只允许 `src/domain/objects.ts` 定义 `SYSTEM_FORMAT_SEEDS`）
- [x] 迁移演练脚本 `scripts/rehearse-vocabulary-migration.mjs`（副本 + 前后计数 + 外键自检），并有自动化版本 `tests/server/vocabulary-migration.test.ts`（0000–0004 造旧数据 → 升级 → 旧数据可读）
- [x] 真实库实测（2026-11-12）：`data/app.db` 迁移前后对象 9 / 作品 4 / `article:4` 完全一致，7 条内置形态、1 个标签（`smoke`）、3 条关联，`foreign_key_check` 为空

### Phase 5.9：词表界面落地 · 第二阶段（弹窗 / 目录 / 筛选 / 管理页，ADR-016 + ADR-019）

- [x] 新建弹窗：形态按 `/api/vocabulary` 的启用项与 `sort_order` 渲染；新增「标签」区（已有标签按使用次数排序、输入即建、可点选）；资产与作品都能打标签；每对象 ≤10 个、单标签 ≤20 字，超限禁用提交并就地提示；归一化仍只有 `src/domain/vocabulary.ts` 一份实现
- [x] 编辑弹窗复用同一套标签控件：读得出已有标签、改得动，保存走 `PATCH /api/objects/[id]` 的 `tags`
- [x] 第二列目录新增「管理」分组（仅管理员可见）：管理形态 / 管理标签 → `/admin/vocabulary/formats`、`/admin/vocabulary/tags`（ADR-019 定案，不用 `?tab`）；工作台、检索、图谱、管理后台四个目录底部都带这一组
- [x] 管理页（服务端壳 + 客户端管理器）：列表显示名称 / 排序 / 使用次数 / 状态；新增、重命名、上移下移、停用启用；删除被引用项返回 409 时弹窗显示引用数量并提供「迁移到…（形态）/ 合并到…（标签）」；内置形态与最后一个启用形态不可删；删除与「从对象移除」二次确认；空 / 加载 / 错误状态齐全
- [x] 列表筛选：第三列工具条新增「标签」下拉（v1 单选 + 全部标签），与类型 / 库别 / 状态 / 排序同级，查询走服务端 `tag` 参数（仓储按归一化键匹配），URL 可往返
- [x] 全局同步：5 条词表写接口成功后调用 `revalidateVocabulary()`（首页 / 工作台 / 检索 / 图谱 / 管理后台 / 两个词表页）；弹窗、筛选、详情、列表与导出标签全部读词表；`domain/objects.ts` 只剩 `SYSTEM_FORMAT_SEEDS` 供迁移种子与测试
- [x] 真实登录态实测（2026-11-12，`pakp_test` + 无头 Chromium，1280×800 / 860×1000）：目录管理组与两个入口、新增→改名→弹窗同步、上移下移、作品与资产各打一个标签、标签下拉只筛出这两条、改名后筛选 / 详情同步、合并保留关联、删除被引用形态的 409→迁移、删除被引用标签的 409→合并或移除、两档尺寸均无横向溢出、弹窗在视口内且正文可滚、控制台除两处预期 409 外无报错
- [x] 实测中发现并修掉一个真实缺陷：上移 / 下移按「相邻行 ±10」算新值，`sort_order` 间隔不足或相等时列表原地不动；改为交换相邻两行的值，相等时整表按 10、20、30… 重排后再交换（问题 54）
- [x] 测试数据全部清理：实测后对象 9 / 可见 7 / 形态 7 / 标签 1（`smoke`）/ 关联 3，`foreign_key_check` 为空，`未分类` 的排序恢复为 999；为完成后台实测曾把测试账号临时加入 `ADMIN_SUBS`，结束后已还原并重启开发服务

### Phase 5.10：后台权限重构（ADR-019 Phase 3）

- [x] 迁移 `0006_admin_rbac`：`users` / `roles` / `permissions` / `role_permissions` / `user_roles` / `audit_events` 六表 + 4 角色 / 13 权限 / 27 条关联；沿用「迁移前 `VACUUM INTO` 备份、外键开关放在 `migrate()` 外层、`foreign_key_check` 非空拒绝启动」
- [x] `ADMIN_SUBS` 降级为首次引导：库里没有 active owner 时才生效；owner 落库后环境变量不再参与授权；全部 owner 丢失可重新引导；桌面离线恢复 `npm run admin:grant -- <sub> [role]`
- [x] `src/server/authz.ts` 为唯一强制层（`requirePermission`）；`Session` 增加 `userId` / `permissions`，`isAdmin` 只作导航显隐；所有 `/api/**` 按 13 个权限点重挂，写服务签名强制携带 `actor`
- [x] 审计：对象删除 / 归档 / 取消归档 / 跨库迁移与 7 个词表写操作同事务写入；403 `denied` 由守卫独立写、失败不放行；维护动作（同步 / 解析）同样留痕
- [x] 页面：`/admin` 总览；运维迁 `/admin/system`（旧锚点保留）；新增 `/admin/users`（角色、停用启用、最后 owner 保护）、`/admin/roles`（只读矩阵）、`/admin/audit`（筛选 + 游标）、`/admin/objects`（跨账号只读）；四个模块目录按权限展开「词表 / 账号 / 运维」
- [x] 状态与降级：管理段 `loading.tsx` / `error.tsx`；≤900px 用户表转卡片；二次确认与 `LAST_OWNER` 行内提示
- [x] 测试：52 格权限矩阵逐格核对、路由守卫全扫描、审计同事务回滚、引导与最后 owner 保护；基线 29 个文件 351 项
- [x] 迁移演练与真实执行（2026-11-12）：副本先跑通；真实库备份 `app.db.bak-2026-11-12T04-51-44-303Z`，对象 9 / 作品 4 不变；真实账号 `gdv8t04dw4ca` 引导为 owner，清空 `ADMIN_SUBS` 后仍可进入后台

### Phase 5.11：银河首页（ADR-018，设计稿 §4）

- [x] 单画布 Canvas 2D：1600 粒子（移动端 900）+ 260 星点 + 偶发流星，粒子初始化预计算进 `Float32Array`，每帧只算一次全局 `cos/sin`，三张预渲染 sprite 走 `drawImage` + `lighter`；未引入 three.js / GSAP / 任何粒子库
- [x] 盘面与核心：`resize()` 时预建 disk / core 两个 `CanvasGradient`，绘制顺序为盘面椭圆 → 核心椭圆 → 粒子 → 流星；核心另有 CSS 呼吸辉光（reduced-motion 关闭）
- [x] 布局按设计稿 §4.3 / §4.4：星系中心桌面 (62%, 46%)、移动 (50%, 36%)；搜索框桌面 640×64 / y=320，移动 358×56 / y=264；把手桌面 28×72 且 y=378–450，移动视觉 22×56、触控区 44×56
- [x] 搜索 v1：回车跳 `/search?q=`（`encodeURIComponent`），空 / 纯空格 / 输入法组合中不跳转，`maxLength=200`，不做内联结果面板；输入框非受控，水合前即可打字
- [x] 未登录：搜索框渲染但禁用，占位「登录后可检索内容」，禁用控件上叠一层透明按钮指向登录；页面不发任何 `/api/**` 请求，抽屉与把手不渲染（`navItems=[]`）
- [x] 抽屉：条目读 `src/lib/nav-items.ts` 单一来源（与 NavRail 同源，管理员多「系统」一项），打开后焦点进第一项、Tab 循环、Esc 关闭、关闭后焦点回到把手、遮罩点击关闭
- [x] 导航栏 logo：第一列最上方「三条竖杠」换成银河图标（24 / 28px、36px 容器、hover 6°），点击回 `/`；其余导航项与 active 判断不变
- [x] 四级降级：`prefers-reduced-motion` 画一帧静态图后停 rAF → 低配（≤2 核 / ≤2GB 或窄屏）粒子减半、DPR 1.5、30fps、流星 1 颗 → Canvas 不可用改 CSS 星点 + 静态 SVG 星系 → 无 `backdrop-filter` 用不透明玻璃色；任何一级下搜索与抽屉完整可用
- [x] 性能与首屏：`requestIdleCallback` 后才启动星图（画布晚到不抢主线程），`document.hidden` 时停帧、回前台续帧；实测 1440×900 首帧 2.3ms、平均 1.41ms/帧；390×844 首帧 1.3ms、平均 0.97ms/帧
- [x] 实测（真实 Logto 会话，无头 Chromium）：两档尺寸 `scrollWidth == innerWidth`（1440 / 390）无横向滚动、搜索框回车落到 `/search?q=…` 且出结果、抽屉开合与焦点归还正常、reduced-motion 与 canvas 降级两档均可用、控制台零报错；截图存 `docs/screenshots/phase4-home-*.png`
- [x] 测试：新增 `tests/lib/galaxy.test.ts`（23 项：按 q 构造地址、未登录禁用不发请求、降级分支、星图数学）与 `tests/lib/nav-items.test.ts`（3 项）；基线 **29 个文件 351 项 → 31 个文件 374 项**
- [x] 遗留：设计稿 §4.7 / 需求 R5 的抽屉条目写的是「工作台 / 资产 / 作品 / 图谱 / 检索」，与 ADR-018 第 4 条「抽屉是导航栏镜像」冲突；本期按 ADR 执行（工作台 / 检索 / 图谱，管理员多「系统」），差异待 Product 拍板

### Phase 5.12：深空视觉主题与 Three.js 星系首页（ADR-020）

> 使用者本轮「视觉主题 + 首页背景」指令（内部按 Phase 5 批次编号，落在文档里是 5.12）。只改视觉与背景，不动业务逻辑、数据库与真实库数据。

- [x] 首页背景：Canvas 2D 星图换成 three.js 3D 星系（`three@0.187.0` + `@types/three@0.187.0`，唯一新增运行时依赖）。五层点精灵（旋臂 / 核球 / 盘面雾光 / 暗尘带 / 背景星场）+ 两层 billboard 辉光 + 盘面椭圆柔光，自定义 `ShaderMaterial`（additive、距离衰减、每粒子随机相位闪烁）
- [x] 场景层级 `pivot → root → tilt → spin`：视差与呼吸在 `pivot`、屏幕倾角与构图在 `root`、盘面倾斜 64° 在 `tilt`、自转只在 `spin`
- [x] 运动：自转 90 秒 / 周（`GALAXY_CONFIG.rotation.periodSeconds`，需求区间 60–120）；呼吸 26 秒 ±0.32°；闪烁旋臂 0.18 / 背景星 0.45；鼠标视差 1.4°、阻尼半衰期 520ms（触屏忽略）
- [x] 参数集中 `src/lib/galaxy-config.ts`：配色取样、相机、桌面 / 移动两套构图、亮度 1.78、视差、呼吸、闪烁、尘埃透明度 0.24、两档预算（high 46300 / balanced 17560）、DPR 上限（2 / 1.5）、帧率上限（60 / 30）、静态图路径与尺寸
- [x] 三段降级：`webgl` → `poster`（本项目场景自渲染的 JPG）→ `fallback`（CSS 星点 + 暖金星云）。`prefers-reduced-motion` / `?still=1` / WebGL 探针失败 / 上下文创建抛错全部零 rAF；静态图加载失败由 CSS 星点兜底
- [x] 静态图由自己的场景出图：`/galaxy/poster` 截图路由 + `scripts/phase5-capture.mjs poster`，无头 Chrome 以 1920×1080 与 1170×2532 渲染后截帧转 JPG；`public/galaxy/galaxy-1920x1080.jpg` 177KB、`galaxy-1170x2532.jpg` 125KB（≤400KB）。**未使用参考图**（`docs/reference/galaxy-reference.png` 右下有第三方水印），产物无文字、无水印、无 UI
- [x] 性能与暂停：`document.hidden` 立即停 rAF，回前台重启；DPR 按视口封顶；`requestIdleCallback` 后才起场景，首屏文字与搜索框不等它
- [x] 全局主题：重写 `:root`（三档文字、五级表面、描边、hover、间距补档 `--sp-14/16/20`、深色阴影、`--focus` 暖金），品牌绿整套换暖金并保留 `--green-*` 为金阶别名（映射表见 ADR-020）；`html { color-scheme: dark }`；`body` 用固定渐变给出单层星点 + 一层极淡暖金 / 灰紫光晕
- [x] 子页面统一深空：导航栏、目录、列表、详情、编辑器、检索、图谱、后台、登录全部改深色，逐个修掉硬编码浅色（品牌徽标、主按钮文字、危险按钮、骨架屏、滚动条、遮罩、提示条、标签描边等）
- [x] `[data-surface="cosmic"]` 重建：青紫霓虹 → 暖金 + 尘埃棕 + 灰紫，`--galaxy-from/--galaxy-to` 指向暖白金；删掉旧的星云光斑与核心辉光两层 DOM（体积光改由 WebGL 承担），只留 `poster / canvas / fallback-stars` 三层
- [x] 可访问性：正文级文字 ≥4.5:1、大字号与图标 ≥3:1；焦点环统一暖金；hover 只改描边 / 底色 / 阴影，不做位移与放大；首页搜索提示文案加了暗色暗角与文字阴影，避免压在星系核心上不可读
- [x] 布局修复（截图中发现）：工作台「作品进程」轨道原为 4 列 `min-width: 680px`，在 ~430px 卡片里被横向裁切，改为 2×2 网格并重画连接线；移动端星系中心 `centerY` 0.38 → 0.44，避免核心被搜索框压住
- [x] 实测读数（`node scripts/phase5-capture.mjs probe`，无头 Chrome + SwiftShader）：桌面 1440×900 首帧 29.9ms / 平均 1.36ms/帧 / 46300 粒子 / DPR 1；移动 390×844 首帧 18.9ms / 平均 0.99ms/帧 / 17560 粒子 / DPR 1.5；两档 `scrollWidth == innerWidth` 无横向滚动；`prefers-reduced-motion` 下 `mode=poster`、`rafCalls=0`；切走标签页 700ms 帧数 51 → 51、`rafActive=false`；禁用 WebGL 时 `mode=fallback`、1920×1080 静态图可见、canvas 透明度 0
- [x] 对比度：新增 `scripts/check-contrast.mjs`（`npm run check:contrast`），直接从 `:root` 取值计算 28 组配对，28/28 通过；据此把危险按钮 hover 从 `#bd533d` 调深到 `#b54a35`（白字 4.32:1 → 4.83:1）
- [x] 截图：`docs/screenshots/phase5-home-desktop.png`、`phase5-home-mobile.png`、`phase5-home-static-desktop.png`、`phase5-home-no-webgl.png`、`phase5-drawer-mobile.png`、`phase5-login-desktop.png`、`phase5-workspace-{desktop,mobile}.png`、`phase5-detail-desktop.png`、`phase5-editor-desktop.png`、`phase5-search-{desktop,mobile}.png`、`phase5-graph-{desktop,mobile}.png`、`phase5-admin-desktop.png`；全部页面零 console 错误、移动端无横向溢出
- [x] 测试：`tests/lib/galaxy.test.ts` 随实现更新（几何、配色、旋转、阻尼、构图、画质分档、降级判定、搜索提交）；基线 **31 个文件 374 项 → 31 个文件 392 项**
- [x] 遗留：`three` 约 160KB gzip，弱网首屏仍靠静态图先上屏；`--green-*` 名字与实际颜色不符，属刻意保留的兼容层，新代码一律用 `--gold-*`；SwiftShader 读数不代表真机 GPU 表现，真机需另测

### 工程与文档

- [x] 功能提交 `3b8ddb4` / `4e86ddf` 上 lint、typecheck、`next build` 均通过；Phase 3 后复跑 19 个测试文件 / 216 项全部通过（2026-11-11）；补编辑器与后台用例后 20 个文件 / 223 项；三栏框架与 Markdown 正文落地后 21 个文件 / 228 项；批量操作落地后 22 个文件 / 231 项；词表数据层落地后 25 个文件 / 256 项；词表界面落地后 25 个文件 / 259 项（新增 3 项标签筛选用例）；后台权限重构后 **29 个文件 351 项**（新增矩阵、审计、引导、路由守卫 92 项）；银河首页落地后 **31 个文件 374 项**（新增星图 / 搜索 / 降级 / 导航单源 26 项）；深空主题与 Three.js 星系落地后 **31 个文件 392 项**（星图纯函数层随 3D 重写，新增 18 项）
- [x] [06_API.md](06_API.md) 覆盖全部 24 条路由与未实现清单；[07_PLAYBOOK.md](07_PLAYBOOK.md) 记录开发流程与问题沉淀；[08_RUN_LOG.md](08_RUN_LOG.md) 留档真实登录联调与验收的操作过程；[09_USER_GUIDE.md](09_USER_GUIDE.md) 提供面向使用者的新手手册；[10_BACKLOG.md](10_BACKLOG.md) 记录 2026-11-11 集中反馈的 6 个问题；[11_LEGACY_UI_AUDIT.md](11_LEGACY_UI_AUDIT.md) 是旧项目前端审计
- [x] 每轮实现后同步 CHANGELOG 与阶段文档

### Phase 5.13：Phase 5b 返工（主题系统、首页构图、翻面与降级一致性）

> 使用者本轮返工指令：恢复多主题并修复首页「星系太高、搜索框偏下」的问题。只改视觉与主题，不动业务逻辑、数据库与真实库数据；不提交、不推送，`03_DECISIONS.md` 留给 Architect 补 ADR。

- [x] **四套主题恢复**：`galaxy`（深空银河，默认，与线上一致）、`pine`（Phase 5 前浅色，token 逐项取 `git show HEAD:src/app/globals.css` 原值）、`sand`（暖沙）、`midnight`（午夜蓝），后两者按设计稿 §3.2 token 表。`<html data-theme="...">`，`:root` 保持 galaxy 作无脚本兜底；`galaxy` 之外的三个块只覆盖语义层与旧别名，每套各自声明 `color-scheme`
- [x] **首帧防闪**：新增 `src/lib/theme.ts`（枚举、非法值回落、`readStoredTheme` 容错、`applyTheme`）；`layout.tsx` 的 `<head>` 内联同步脚本在 CSS 前读 `localStorage["pakp.theme"]` 写 `data-theme`，无脚本或非法值回落 `galaxy`；`<html>`/`<body>` 加 `suppressHydrationWarning`
- [x] **主题切换入口**：新增 `ThemeSwitcher`（左侧图标栏底部头像 + 首页右上角头像共用）。面板含身份、2×2 主题网格（每格 4 个 8px 色点 + 名称 + 勾选）、词表管理（管理员）与退出登录；移动端为底部纵向抽屉。键盘 Tab 循环、方向键移动并即时应用、Enter/Space 应用、Esc 关闭并归还焦点、点击面板外关闭；首页入口使用 cosmic token，不受工作台主题影响
- [x] **逐页清理写死深色**：`globals.css` 中约 30 处裸色值改为 token（欢迎页、纹理、局部标识、主按钮、轨道、头像、危险按钮、输入焦点、对话框遮罩、骨架屏、命中卡、高亮、加载圈、图谱圆点、侧栏选中 / 头像 / 徽标、滚动条、进度条、品牌渐变等）；新增 `text-on-dark*` / `rail-active-fg` / `accent-hover` / `accent-contrast` 等语义令牌，避免浅色主题把正文色直接铺到深色导航底
- [x] **对比度校验扩到四主题**：`scripts/check-contrast.mjs` 改为逐主题解析 token 块，23 组配对覆盖正文 / 次级 / 辅助文字、深色导航、强调文字与按钮、状态色、危险按钮与描边；`galaxy / pine / sand / midnight` 均 23/23 通过（`npm run check:contrast`）
- [x] **首页构图（最终值）**：桌面 `centerX 0.54 → 0.39`、`centerY 0.48 → 0.62`；移动 `centerX 0.5 → 0.42`、`centerY 0.44 → 0.60`；`fill / rollDeg` 未动。搜索组 `top: 32vh`（移动 `32dvh`，`max-height: 640px` 兜底时 `top: 118px`），搜索框中心实测 43.8%（桌面）/ 43.4%（移动），落在星系上缘之上；暗雾范围随之同步
- [x] **观察面翻到背面**：新增配置 `GALAXY_CONFIG.facingDeg = 180`，场景层级改为 `pivot → root → facing → tilt → spin`；`facing` 在 `tilt / spin` 之上，arms / core / haze / dust 一起左右镜像、缠绕方向反转、盘面倾角方向镜像。自转角按 `spinSign` 取反，翻面后屏幕上仍是同一转向；poster 走同一份配置，降级图与动画态同向
- [x] **六条旋臂与加密**：`ARM_BASES` 扩为 2 主（0 / π）+ 4 次（π/3、2π/3、4π/3、5π/3），主臂粒子占比 57%；`SPIRAL_TURNS 0.62 → 0.58`，半径抖动与臂宽收紧，团簇空档补 52% 贴臂薄雾并把盘光亮度 0.055 → 0.075
- [x] **粒子预算**：high `arms 34000 / core 9000 / haze 6000 / dust 8500 / stars 1100`，合计 **58600**；balanced `14000 / 3600 / 2400 / 3200 / 460`，合计 **23660**。`window.__galaxyStats` 逐项计数口径未变
- [x] **静态图重出**：`public/galaxy/galaxy-1920x1080.jpg` **201KB**、`galaxy-1170x2532.jpg` **154KB**（均 ≤400KB，无文字 / 水印 / UI）
- [x] **三路径位置一致（实测）**：桌面 1440×900 核球亮度质心 `webgl 38.9%, 62.1%` / `reduced-motion 37.6%, 62.0%` / `no-webgl 37.6%, 62.0%`；移动 390×844 `42.0%, 59.9%` / `41.9%, 59.9%` / `41.9%, 59.9%`。两档均无横向溢出、搜索组不与顶栏重叠、提示在视口内、控制台零报错
- [x] **主题切换实测**（`node scripts/phase5-capture.mjs theme`，`AUTH_MODE=mock` 验收实例 3101）：首屏 galaxy；点击头像打开菜单并聚焦选中项；方向键切 pine 不刷新、滚动容器 `scrollTop 115` 不变；连续方向键可达 sand / midnight 且 `color-scheme` 跟随；Esc 关闭并归还焦点；点击外部关闭；刷新保持 pine；强刷 10 次首帧均为 pine；切到 pine 后首页标题 / 占位色与 galaxy 下完全一致；首页右上角菜单可打开。10/10 通过
- [x] **截图**：`docs/screenshots/phase5b-*` 共 30 张 —— 首页新构图桌面 / 移动、首页静态降级、抽屉、登录；工作台 / 详情 / 检索 / 图谱 / 后台在 `galaxy` 与 `pine` 各一张（编辑器补 galaxy 一张）；`sand`、`midnight` 工作台各一张；主题菜单（侧栏 / 首页 / 移动抽屉）三张；全部零 console 错误、移动端无横向溢出
- [x] **测试**：新增 `tests/lib/theme.test.ts` 10 项（枚举、默认值、非法值回落、`pakp.theme` 读写与抛错容错、元数据四色点），`tests/lib/galaxy.test.ts` 补 1 项观察面 / `spinSign` 断言并修正两处旧 centerY 方向断言；基线 **392 → 403 项**，32 个文件全绿
- [x] **质量门**：`npm run lint` 0 error（16 条既有未使用变量警告）、`npm run typecheck` 通过、`npm run check:contrast` 四主题全过
- [x] **遗留**：`SwiftShader` 下的实测数字不代表真机 GPU；首页在 `pine` 下仍固定深空（符合本轮要求）；侧栏底部头像菜单在窄屏走抽屉，横向 2×2 网格只在 ≥561px 出现；`--green-*` 名字与语义仍不符（兼容层保留）

### Phase 5.14：Phase 5c 构图微调（星系放大、上移、向水平中心收 20%）

> 使用者看首页截图反馈「星河又偏下了」，要求再放大并往水平居中位置调 20%。只改构图参数与产物，不改几何、粒子预算与朝向；不提交、不推送。

- [x] **构图（最终值）**：桌面 `centerX 0.39 → 0.412`（= 0.39 + 0.2 ×（0.5 − 0.39））、`centerY 0.62 → 0.55`、`fill 0.42 → 0.50`；移动 `centerX 0.42 → 0.436`、`centerY 0.60 → 0.55`、`fill 0.50 → 0.56`。`rollDeg −14 / −22`、`facingDeg 180`、六条臂、`SPIRAL_TURNS` 与两档粒子预算（58600 / 23660）全部未动
- [x] **边缘柔化**：`fill 0.5` 让星盘直径正好等于视口宽、旋臂最外半径 1.06 再溢出 6%，移动端直径 112% 视口宽。`.galaxy-scene` 的三层（静态图 / canvas / CSS 星点）统一加 `clamp(36px, 6vw, 88px)` 四边遮罩：桌面左缘逐列均值 5.7 → 13.8、下缘 6.5 → 16.2、上缘 6.4 → 16.5，40px 内单调衰减，没有亮度台阶，也没有直线切口
- [x] **亮核与搜索框的间距（像素实测）**：搜索框底边 426px / 900（47.3% 视口高）、394px / 844（46.7%）；亮核（92% 峰值阈值）上沿 496px（55.1%）、463px（54.9%），**净空 70px / 69px**；75% 阈值下亮斑外沿 52.9% / 53.5%，仍未顶到搜索框下沿。搜索框中心实测 43.8% / 43.4%，与上一轮一致（本轮未动 `top: 32vh`）
- [x] **静态图重出**：`public/galaxy/galaxy-1920x1080.jpg` **214KB**、`galaxy-1170x2532.jpg` **178KB**，均 ≤400KB
- [x] **三路径位置一致（实测）**：桌面 1440×900 核球亮度质心 `webgl 41.1%, 57.6%` / `reduced-motion 39.9%, 57.6%` / `no-webgl 39.9%, 57.7%`，最大偏差 **1.2 个百分点**（≤1.3%）；移动 390×844 `43.9%, 56.2%` / `43.6%, 55.8%` / `43.6%, 55.8%`，最大偏差 0.4
- [x] **测试**：`tests/lib/galaxy.test.ts` 三处位置断言改为 0.412 / 0.436 / 0.55；「竖屏 centerY 更靠上」改为「两档一致」；新增 2 项——直径与 fill 的关系（直径 = 视口宽，且 < 1.25 倍上限）、亮核上沿与搜索框下沿的间距（≥ 2.5% 视口高）。基线 **403 → 405 项**，32 个文件全绿
- [x] **工具与截图**：`scripts/phase5-capture.mjs` 新增 `home` 命令（首页桌面 / 移动 / 禁用 WebGL 三张，前缀 `SHOT_PREFIX`）；`docs/screenshots/phase5c-home-galaxy-desktop.png`、`phase5c-home-galaxy-mobile.png`、`phase5c-home-static-galaxy-desktop.png` 三张全部零 console 报错
- [x] **质量门**：`npm run lint` 0 error（16 条既有 warning）、`npm run typecheck` 通过、`npm test` 32 个文件 405 项全过
- [x] **遗留**：静态图按 16:9 渲染后被 `cover` 裁进 16:10 视口，静态回退态下星系比 WebGL 态略大（核球位置仍在 1.2 个百分点内）；`SwiftShader` 实测数字不代表真机 GPU

### Phase 6A：分类词表统一落地（ADR-023）

> 使用者四条反馈中的第 1–3 条（分类 / 标签选择器、新建与编辑布局一致、全局命名统一）。本轮只做 ADR-023；首页搜索的模糊查询（第 4 条 / ADR-024）留到下一轮。不提交、不推送。

- [x] **数据层**：`drizzle/0007_categories.sql` 把 `work_formats` 升级为 `categories`（新增 `normalized` 唯一键、`is_system`、`sort_order` 保留），表重建 `objects`：`format` / `categories` / `tags` JSON 列换成 `category_code` 外键；自由文本分类值折叠进同一词表（主值入分类，其余转标签），旧值原样留档在 `objects_category_legacy_backup`；权限键 `vocabulary:format:write` → `vocabulary:category:write`，owner / admin 授权保留
- [x] **迁移演练**：`scripts/rehearse-categories-migration.mjs` 在 `VACUUM INTO` 备份的副本上跑 `migrate()` 两遍（幂等），核对对象数、作品无空分类、无失联 code、`normalized` 唯一、自由值全部有归宿、旧 format 全部在词表、留档行数、外键自检、权限键与授权；两份库 `ok: true`、`failures: []`、`foreignKeyCheck: 0`
- [x] **迁移应用**：先停开发服务，再对真实库执行同一迁移。`data/app.db` 迁移前后：对象 5（作品 2 / 资产 3）不变，作品分类全部为 `article`，资产分类为空，词表 7（原 `work_formats` 的 7 个内置项原样迁入 `categories`），标签 1 → 2（原「学习」自由值转标签），外键自检为空；`data/dev.db`：对象 3（作品 2 `course` / 资产 1）不变，分类 7。备份在 `data/backups/2026-11-12T16-01-11/`（`app.db` / `dev.db` 及 `.report.json`）
- [x] **选择器**：`category-picker.tsx` 单选 chips + 过滤框 + 固定「＋ 自定义」；`tag-field.tsx` 多选 chips + 过滤 + 自定义。只允许从词表里选，输入框只做过滤，回车仅在归一化完全命中时选中；上限分类 30 / 标签每人 10；纯逻辑抽到 `src/components/vocabulary-selection.ts` 并单测
- [x] **自定义新增**：`VocabularyQuickCreate` 小弹窗复用同一个服务端接口；分类带 `reuseExisting`（同名启用项直接复用），停用同名项回 409 `CATEGORY_ARCHIVED`，不自动复活；标签重名归一化命中即复用。组件嵌在新建弹窗的 `<form>` 内，改用 `div` + 手动回车提交，消除嵌套表单的 hydration 报错
- [x] **新建 / 编辑一致**：两个弹窗都是「类型 → 标题 → 分类 → 标签 → 放在哪里 → 说明」；作品分类必选、资产可不选；编辑沿用同一组字段，作品清空分类被拒绝；服务端只接受 `category`，旧 `format` / `categories` / `primaryCategory` 一律 400
- [x] **命名统一**：界面、API、权限键、路由统一叫「分类」；旧路由 `/api/vocabulary/formats*` 与 `/admin/vocabulary/formats` 只做 308 跳转，管理页改名 `管理分类`（`/admin/vocabulary/categories`）。仓库内 `作品形态 / 管理形态 / 新增形态 / 形态列表` 字样清零（ADR-023 文档与历史 CHANGELOG 除外）
- [x] **测试**：新增 `tests/components/vocabulary-selection.test.ts`、`tests/server/category-consistency.test.ts`；重写 `vocabulary-migration.test.ts`、`vocabulary-service.test.ts`、`object-service.test.ts`、`object-repository.test.ts` 等以 `category` 为准；基线 **420 项 / 34 个文件全绿**
- [x] **截图**：`docs/screenshots/phase6a-*` 7 张——新建桌面 / 390×844、分类与标签自定义弹窗、编辑弹窗、分类管理页、详情分类元信息；零 console / page 错误，移动端无横向溢出。脚本 `scripts/phase6a-capture.mjs` 用本机 Chrome CDP，不引入 puppeteer
- [x] **质量门**：`npm run typecheck` 通过、`npm run lint` 0 error、`npm test` 34 文件 420 项全过
- [x] **遗留 / 未验证**：截图与交互实测在 mock 身份实例（`AUTH_MODE=mock`、`DATABASE_PATH=data/dev.db`）上完成，未用真实 Logto 账号复走新建 / 编辑全流程；分类与标签的内联创建走同名复用，不校验跨用户隔离（词表本身是全局的）；新建作品不预选分类（与「必须由人明确选择」一致，但与旧版默认第一个形态不同）

### Phase 6B：检索模糊查询与语义混合落地（ADR-024）

> 对应使用者第 4 条反馈（首页搜索至少支持模糊查询，参考旧项目顶栏搜索再优化）。ADR-024 全部条目按原文实施；`03_DECISIONS.md` 未改，不提交、不推送。

- [x] **影子列（`drizzle/0008_search_norm.sql`）**：`objects.title_norm` / `objects.description_norm` 两列 + `objects_owner_scope_idx (owner_sub, deleted_at, archived_at)`；纯加列加索引，不重建表。归一化写在一个函数里（`src/lib/search-query.ts` 的 `normalizeSearchText`：NFKC → 空白折叠 → trim → 小写），写路径、回填、查询、内存打分共用同一份，SQLite 侧不做 NFKC
- [x] **迁移演练**：`scripts/rehearse-search-migration.mjs` 先 `VACUUM INTO` 备份，再在临时副本上跑 `migrate()` + JS 版回填，核对对象数不变、两列齐全、索引存在、`missingNorms = 0`、`description` 与影子列一致、`foreign_key_check` 为空、抽样归一化一致。`data/backups/2026-11-12T16-44-10/` 下两份库均 `ok: true`
- [x] **真实库迁移**：`data/app.db` 8 → 9 个迁移（自动备份 `data/app.db.bak-2026-11-12T16-44-28-555Z`），`data/dev.db` 同批执行（备份 `data/dev.db.bak-2026-11-12T16-44-45-684Z`，回填 3 行）；两库 `missing = 0`、外键自检为空。启动时 `backfillSearchNorm` 兜底补历史行，第二次运行返回 0
- [x] **查询解析器（`src/lib/search-query.ts`）**：空格 = AND、`AND` 同义；`"短语"`；六组字段前缀 `title:` / `desc:` / `category:` / `tag:` / `标题:` / `描述:` / `分类:` / `标签:`；`-` 排除与 `NOT`；`OR`、括号 → 400 `QUERY_SYNTAX` 并带 `details.position`；`~` 当字面量并给一次提示；未知 `x:` 按普通文本；未闭合引号报位置；归一化后不足 2 字 → 200 空结果 + 提示「至少输入 2 个字」；`q` 上限 200 字、词项上限 30
- [x] **词法服务（`src/server/services/lexical-search-service.ts`）**：`instr()` 子串匹配标题 / 描述 / 分类名 / 标签名，正文不参与（只走语义）；六级权重 标题精确 100 / 标题包含 80（前缀 +10）/ 分类精确 70 / 标签精确 65 / 分类或标签包含 50 / 描述 20；按分数 → 更新时间 → id 排序，对象级去重；取 `limit + 1` 判 `truncated`，单次最多 500 条；摘要复用详情与高亮词元
- [x] **`/api/search` 扩展**：新增 `mode=lexical|semantic|hybrid`（默认 hybrid）；hybrid 下词法与 RAGFlow 并行，语义 3 秒硬截止（`SEMANTIC_TIMEOUT_MS`，可由 `semanticTimeoutMs` 覆盖），超时只回词法并在 `semantic.status` 标 `timeout`，页面显示中性提示；`threshold` 只作用于语义；响应增量加 `mode` / `counts` / `total`（去重后的对象数），`hits` 保留并加 `source` / `score` / `matchedFields` / `chunkCount` / `highlightTerms`，旧键仍可空读；未登录 401
- [x] **首页内联预览（`src/hooks/use-search-preview.ts` + `galaxy-home.tsx`）**：≥2 字才请求、200ms 防抖、`AbortController` + 序号丢弃旧响应、IME 合成期不请求；只打 `mode=lexical&limit=8`；下拉含高亮 / 分类 / 标签 / 来源、`aria-combobox`、↑↓ / Enter / Esc / ⌘K、点击外部关闭、登出禁用、移动端整宽不盖输入框；三态（加载 / 有结果 / 无结果）
- [x] **`/search` 页**：一个对象级结果列表，带来源徽标（关键词命中 / 语义命中 / 两者都有）；语法错误在输入框下显示原文 + 位置箭头 + 「第 N 个字符附近」，并在服务端前置解析，**不发请求**；阈值说明「仅影响语义结果」常年在位；语义不可用时给中性提示而非报错；结果 `truncated` 时提示收窄范围
- [x] **1 万对象压测（`tests/perf/search-bench.test.ts`，`PERF=1`）**：写入 1 万条 2236ms；词法 p95 `复盘 11.51` / `个人知识 6.74` / `课程 12.12` / `写作模板 7.17` / `知识 系统 8.26` ms（目标 ≤60）；预览 8 条 p95 `4.71 / 3.83 / 6.14 / 4.04 / 3.63` ms（目标 ≤30）；`EXPLAIN QUERY PLAN` 走 `objects_owner_scope_idx`；语义挂起时 `status=timeout`、耗时 3020ms、词法 10 条照常返回
- [x] **测试**：新增 `tests/lib/search-query.test.ts`（23）、`tests/lib/search-preview.test.ts`（12）、`tests/server/lexical-search.test.ts`（13），重写 `tests/server/search-service.test.ts`（19，含混合 / 超时 / 不可用），扩展 `tests/lib/search-params.test.ts`；基线 **37 个文件 484 项全绿**，另有 `PERF=1` 下 3 项基准
- [x] **质量门**：`npm test` 484/484、`npm run typecheck` 通过、`npm run lint` 0 error（15 条既有未使用变量警告）
- [x] **截图**：`docs/screenshots/phase6b-*` 5 张——首页下拉（桌面）、首页下拉（390×844，整宽且不盖输入框）、首页无结果、`/search` 语法错误（含位置箭头）、`/search` 关键词结果（来源徽标 + 阈值说明）；零 console / page 错误、移动端无横向溢出。脚本 `scripts/phase6b-capture.mjs`
- [x] **遗留 / 未验证**：截图为 mock 身份实例（`AUTH_MODE=mock`、`DATABASE_PATH=data/capture-6b.db`），真实 Logto 会话下的预览未复测；移动端只验证渲染与布局，未实测触摸点选与软键盘；RAGFlow 语义只经假网关与挂起网关验证，未在真实服务上压并发；`instr` 全表子串扫描在 10 万级前需要重新评估（当前无分页游标）

### Phase 6C：ADR-021 三处尾巴清零（check-theme 门禁 / 色板零十六进制 / 旧主题键迁移）

> 对应 ADR-021 留下的三件未完成项。ADR 原文的编号与含义为准，`03_DECISIONS.md` 未改；不提交、不推送。图谱相关文件（`src/lib/graph-*`、`src/components/graph*`、`/graph`）本轮不动。

- [x] **`scripts/check-theme.mjs` + `npm run check:theme`**（ADR-021 E1–E8 逐条实施，未增删规则）：E1 四块齐全（`:root, [data-theme="galaxy"]` / `pine` / `sand` / `midnight`）；E2 四块名字集合严格相等；E3 空值与 `unset` / `initial` / `inherit`；E4 几何名（`--fs-*` / `--lh-*` / `--fw-*` / `--sp-*` / `--r-*`）只能在 `:root`，主题名不能落进基础层；E5 别名 `var()` 指向的名字必须存在（指向 L1 几何名不算悬空）；E6 除登记表两组（`--surface-1 ≡ --white`、`--on-gold ≡ --accent-contrast`）外出现第三组等值即失败；E7 主题块与 `[data-surface="cosmic"]` 之外的字面量按选择器白名单（`.galaxy-*`、`.theme-switch--home`）与基线计数；E8 `src/lib/theme.ts` 出现 `#hex` 即失败。失败信息统一带「主题 / token / E 编号」，退出码 0 / 1 / 2。真实 `globals.css` 运行结果：四块各 98 名 PASS，汇总 `129 名（31 几何 + 98 主题）· 4 块集合一致 · 0 失败 · 字面量 26`
- [x] **字面量基线的实测构成（与 ADR 文本的差异已核实）**：ADR 写 `BASELINE = 20`，实测迁移前为 28。差额 8 个是 Phase 5c 边缘柔化在 `.galaxy-scene*` 三层遮罩上新加的 `#000`（ADR 写于柔化之前）；本轮又清掉 2 个（见下条），故脚本常量为 `26 = 20 + 8 − 2`，并把这个算式写进常量注释。契约本身未变——字面量仍只允许出现在白名单选择器里，且只能减少
- [x] **色板零十六进制**：`src/lib/theme.ts` 删掉 `THEME_META.swatch` 的 16 个 hex（4 主题 × 4 色点），`ThemeMeta` 只留 `id / name / hint`；`theme-switcher.tsx` 的色点容器改为带 `data-theme={item.id}` 的作用域元素，四个圆点分别读 `var(--bg)` / `var(--surface)` / `var(--accent)` / `var(--text-1)`，跨主题预览靠属性选择器拿到对应主题的 token，不再有第二套颜色常量
- [x] **视觉零变化有据**：`scripts/phase6c-capture.mjs` 在 mock 实例上逐主题打开头像菜单，读出 16 个圆点的 `getComputedStyle().backgroundColor`，与迁移前 TS 里的 16 个 hex 逐一比对全部相等；截图 `docs/screenshots/theme-swatches-{galaxy,pine,sand,midnight}.png` 与四张菜单特写 `-panel.png`，零 console / page 错误
- [x] **顺带清掉的两处字面量**：`.theme-option-dots i` 边框 → `color-mix(in srgb, var(--text-3) 45%, transparent)`；窄屏 `.theme-switch-layer` 遮罩 → `color-mix(in srgb, var(--dialog-backdrop) 42%, transparent)`（约等于原来的 0.28 透明度）
- [x] **旧主题键迁移**：先查事实——`git rev-list --all` 39 个提交里 `src/**` 从未出现 `localStorage`，`theme.ts` 与首帧脚本都是本轮新增，即旧键在已发布代码里**从未写入过**（详见下方「遗留」）。仍按 ADR-021 第 10 条实现防御式兼容：首帧内联脚本读 `pakp.theme` → 旧键 `theme` → 默认值；旧键只在「新键不存在且旧键值合法」时生效，采用后立即回写新键并删除旧键；两键同时存在时新键优先（即使新键非法也不回退旧键），旧键一律删除。运行时 `resolveStoredTheme` 与脚本同一口径，切换器只写新键
- [x] **测试**：新增 `tests/scripts/check-theme.test.ts`（15 项，全部用内联 CSS 夹具覆盖 E1–E8 与切块解析，不依赖真实文件）；`tests/lib/theme.test.ts` 增加 8 项——旧键四种组合（只有旧键 / 只有新键 / 两键并存 / 都没有）、两个非法值分支、`resolveStoredTheme` 与脚本同口径、脚本内含键名与白名单。`npm test` **38 个文件 507 项通过**（另有 3 项基准默认跳过，共 39 文件 510 项）
- [x] **质量门**：`npm run check:theme` 退出 0、`npm test` 507/507、`npm run typecheck` 通过、`npm run lint` 0 error（15 条既有 warning）、`npm run check:contrast` 23/23 组通过；`package.json` 新增 `check:theme`，并把 `verify` 改为 `check:theme → check:contrast → typecheck`
- [x] **遗留 / 未验证**：① 旧键 `theme` 只是防御式兼容，没有任何真实用户数据需要迁移——如实记录，不当作「已完成迁移」；② `src/**` 除 `globals.css` 外仍有 hex，但全部在 `galaxy-config.ts` / `galaxy-three.ts` / `galaxy-mark.tsx` 这类宇宙/WebGL 兜底色里，属 E8 管辖范围外，本轮按约定不动；③ 截图为 mock 身份实例，真实 Logto 会话下未复测；④ 字面量基线 26 与 ADR 文本 20 的差额已在上面写明，`03_DECISIONS.md` 未改，是否需要回写由 Architect 决定

### Phase 6D-1：图谱 3D 第一轮 · 冻结件与数据契约（ADR-022 附录 A v1.2）

> A 线第 1 步：只落三个冻结件 + `maxNodes` 契约 + 四个单测文件。`globals.css`、`graph-explorer.tsx`、`/graph` 的视觉与交互本轮不动（文件 mtime 可证）；不提交、不推送；`03_DECISIONS.md` 不改。下一轮 2D 与后续 3D 只 `import type`，不再改这三个文件。

- [x] **`src/lib/graph-model.ts`（冻结件）**：`GraphViewModel` / `GraphNode` / `GraphEdge` / `GraphMeta` / `GraphBuildInput` 与 `buildGraphViewModel(input)`。类型 → 形状 / 颜色（`ENTITY_RULES` 顺序敏感、`ENTITY_STYLE` 六类）、`deriveRelationLabel`（`<SEP>` 段首词 → 首行 12 字 → 「相关」）、度数、`hop`（BFS，中心 0 跳、不可达 3 跳）、`size` 四档（0–1 / 2–4 / 5–9 / 10+）、`shortLabel`（中心 12 / 其余 10，按码点截断）、同 id 去重、自环 / 悬空边只计数、平行边合并 `weight`、边 id 用 U+0001、排序 `(hop↑, degree↓, id↑)` 与 `(weight↓, id↑)`、`meta` 全字段
- [x] **`src/lib/graph-quality.ts`（冻结件）**：`QualityTier`、`TIER_BUDGETS`（150/300/12/1 · 300/600/24/1.5 · 600/1200/40/2）、`selectGraphMode`（webgl × reduced-motion × 移动 × 节点数 × URL）、`resolveGraphDpr`、`decimate`（保留中心 / keepIds / 全部 1 跳，余额按度数补齐 2 跳）。档位只降不升：`previousTier` 更低时保留更低的
- [x] **`src/lib/graph-selectors.ts`（冻结件）**：`GraphSelection`、`GraphHighlight`（含 `dimmedEdges`）、`selectGraphHighlight`、`findShortestPath`。选中 → 自身 + 1 跳邻域 + 路径；边补集（全部边 − 高亮边）只在这里求；hover 只在无选中时顶替锚点；选中不进模型
- [x] **数据契约 `maxNodes`**：`GET /api/graph` 新增可选 `maxNodes`（整数 50–600、默认 150），越界 / 非整数 / 空串 → `ValidationError` + `details.field = "maxNodes"`；解析与校验收敛到 `resolveGraphMaxNodes()` 一处，路由传原始字符串、服务层再兜一次；`GraphGateway` 的 `maxNodes ?? 150` 未动。`/graph` 的 SSR 预取显式带 `GRAPH_MAX_NODES_DEFAULT`，与客户端首请求同值（`maxNodes` 不进 URL，URL 参数仍只有 mode / focus / depth）
- [x] **截断推断**：`truncated = receivedNodeCount >= requestMaxNodes`，`truncatedSource = "inferred"`；单测放了反证——收到 3 条、去重后剩 2 条时 `total < maxNodes` 但仍是 `truncated`（ADR-011 先截断后过滤）
- [x] **测试**：新增 `tests/lib/graph-model.test.ts`（31）、`graph-contract.test.ts`（12）、`graph-quality.test.ts`（23）、`graph-selectors.test.ts`（14），共 **80 项**；夹具全为内联对象，不读真实接口、不引 jsdom
- [x] **质量门**：`npm test` **42 文件 587 项通过**（另 3 项基准默认跳过，共 43 文件 590 项；冻结前基线 38 / 507）、`npm run typecheck` 通过、`npm run lint` 0 error（14 条既有 warning，顺手清掉 `api/graph/route.ts` 里未使用的 `fail` 导入）
- [x] **与本附录的三处对齐差异（已在代码注释与本轮报告写明）**：① `GraphNode.hop` 单列 `GraphNodeHop = 0|1|2|3`（A2 第 1122 行写 `GraphHop`，但同节 BFS 规则让中心距离为 0；强塞 1 会把星核放进 1 跳环）；② `GraphBuildInput` 增可选 `statusFailed`（A5.2 要求区分「状态请求失败」与「未请求」，而 `status: null` 同时表示两者）；③ `selectGraphMode` 的 `tier` 由函数内部算（§10 第 970 行把 `tier` 列为入参，会让调用方先算再传回，等于两处判定）
- [ ] **遗留 / 未验证**：2D / 3D 渲染器、`layoutGalaxy3d`、`[data-surface="graph"]` token 块、`error.tsx`、fiber 依赖、`window.__graphStats` 均未开始；新契约只经单测，未在真实 LightRAG 上跑过 `?maxNodes=`；`/graph` 页面未在浏览器里复看（本轮不改界面）

### Phase 6D-2：图谱 2D 聚焦阅读 · 渲染器、降级与验收截图（ADR-022 附录 A v1.2）

> A 线第 2 步：把 6D-1 的冻结件接成可用界面——2D SVG 舞台、3D 星系布局、容器与 URL 契约、无障碍与验收截图脚本。`03_DECISIONS.md` 不改；不提交、不推送。收尾时按 Architect 的审查意见做了一轮**最小修复**（六条阻断项 + 风险项，见下），没有顺手重构。

- [x] **`src/lib/graph-layout-2d.ts`（力导布局）**：`layoutForce2d` 以中心固定圆心、1/2 跳按环布种、锚点（上一帧位置）`pinned` 后夹进 padding；`placeLabels` 做标签避让；`layoutTicksForNodeCount` 按规模给 tick 预算（≤150 → 300、≤300 → 180、≤600 → 120、>600 → 60），把主线程耗时压到可接受范围；`anchorsForSize` 在画布尺寸换档时丢弃旧锚点。单测 18 项，含 600 节点星形图（120 tick、实测约 350ms、断言 <1500ms）与 760 → 390 的换档回归
- [x] **`src/components/graph/graph-stage-2d.tsx`（2D 舞台）**：纯 SVG，只消费 `GraphViewModel` + `GraphHighlight`，不自己做类型映射 / 邻域 / 路径；交互为单击选中、双击聚焦、拖拽平移、滚轮与双指缩放、Shift+单击选路径终点；键盘 Tab 进入、方向键按空间方位移动、Enter 选中、F / Space 聚焦、Esc 取消、+ / − 缩放、0 适配。首帧尺寸未量到（`size === null`）时不出图，等第一个 ResizeObserver 回调；相机状态按 `focusId` 键控，换中心自动回到默认取景，不用 effect 回写
- [x] **`src/lib/graph-layout-3d.ts` + `graph-scene-3d.tsx`（3D 线）**：星系布局（盘面半径、旋臂、不可达环、`SIZE_WORLD_RADIUS`、`GALAXY_LAYOUT_VERSION`、可暂停的 `layoutGalaxy3dControlled`、`defaultMaxTicks`）与 33 项单测；渲染仍是桩，不 import three / fiber，B 线整体替换该文件，容器契约（`onReady` / `onStats` / `onError` / `autoRotate`）已冻结
- [x] **`src/components/graph-explorer.tsx`（容器）**：URL 契约 `mode` / `focus` / `depth`；模式与档位只问 `selectGraphMode`，容器不自己 `if`；`loadedCenter` 记录「已经画出来的那张图」的中心，标题、舞台 `focusId`、view-model 一律用它，正在请求的中心只用于加载提示；加载中在舞台上浮「正在载入 X 的邻域…」；换中心失败只出横幅并保留旧图；列表模式、详情检查器、路径条、快捷键 2 / 3 / L；空态三分（状态读不到 / 图谱为空 / 未抽取到实体）；截断文案为「可能只显示了最近 N 个」
- [x] **`src/app/graph/error.tsx`**：路由级错误页（`reset()` 重试 + 回 `/workspace`），与控制台日志 `[graph] 页面渲染失败` 配套
- [x] **`globals.css`**：`[data-surface="graph"]` 舞台令牌 + `[data-surface="graph"][data-mode="2d"]` 阅读面覆盖（画布 `#06050a`、普通边 42%、强边 62%）；新增 `.graph-stage-loading` 浮层；`prefers-reduced-motion: reduce` 下 `.g2-edge.is-path` 动画关闭
- [x] **依赖锁定**：`three` / `@types/three` 固定 `0.187.0`，`react` / `react-dom` 固定 `19.3.1`，装 `@react-three/fiber@9.8.2`（peer `react >=19 <19.4`）；lockfile 同步。fiber 只安装、不 import，3D 实现留给 B 线

**收尾修复（Architect 阻断项，逐条）**

1. **窄屏首帧堆边**：原来 `FALLBACK_SIZE`（760 宽）先排一次、Layout 再按真实宽度把锚点夹进边界，等于把所有节点钉在边上且永不自愈。改为首帧 `size = null` 不出图，等第一个 ResizeObserver 报真实尺寸；`anchorsForSize` 在宽高变化时清空锚点整图重排。回归测试与截图脚本都按「760 → 390」复现：旧锚点下 >50% 节点贴边，重排后 0 个贴边
2. **换中心拿新中心配旧图**：新增 `loadedCenter`，view-model 用已加载的中心构建；`graphLoading && subgraph` 时舞台上浮加载提示；失败分支只标横幅，绝不把新中心与旧子图配在一起。验收在同一个页面里选中新中心触发失败，断言 URL 已切、标题仍是旧中心、节点数不变、没有残留加载浮层
3. **urlMode 短路降级**：原来把 `"2d"` 塞进 `urlMode`，`reason` 恒为 `url-2d`，no-webgl / reduced-motion / mobile / too-many-nodes 四条分支与文案永远走不到。改为传 URL 原值；仅在 `decision.mode === "3d" && !THREE_D_READY && reason !== "url-3d"` 时回落一次，`reason` 保留 `selectGraphMode` 的结论。显式 `?mode=3d` 仍进占位桩（否则桩与「星系」入口不可达）
4. **autoRotate 默认开**：容器持有 `autoRotate` state，默认 `false`；工具条给「自动旋转」开关（`aria-pressed`），reduced-motion 下不渲染；传给场景的是 `autoRotate && !reducedMotion`。验收断言 `aria-pressed="false"`，模拟 reduced-motion 后按钮消失
5. **版本未锁定**：见上「依赖锁定」，`npm install` 后 `tsc --noEmit` 通过
6. **风险项**：2D 路径边只消费 `highlight.edges`，不再 `view.edges.find`；`graph-selectors.ts` 注释改成与真实行为一致（hover 也是锚点 → 整层压暗是「悬停预览」，选中优先）；`status === null` 单独出「图谱状态暂时读不到」，不再显示「图谱还是空的」；换中心重置相机；aria 提示由「按 2」改「按 3」；reduced-motion 关路径动画；截断措辞改「可能只显示了最近 N 个」；2D 布局按节点数给 tick 预算并加 600 节点耗时上界测试；对比度把 2D 实际渲染的边单列一组按 3:1 校验，3D 背景细边明确标为「装饰纹理，非信息载体」

- [x] **验收脚本 `scripts/phase6d-capture.mjs`**：临时库（`%TEMP%`，避免 Turbopack 监听写库文件）+ mock LightRAG（`empty` / `full` / `graph-error` / `status-error` / `center-error`）+ `AUTH_MODE=mock` 的 dev（3123，`NEXT_DIST_DIR=.next-mock`）+ 无头 Chrome（CDP，不引 puppeteer）。断言覆盖 2D 渲染规模、失败明细、选择 / 路径 / 键盘、自动旋转默认关、reduced-motion、换中心失败保留旧图、列表、760→390 换档、3D 桩、孤立点、加载失败、状态读不到，以及横向溢出与 console / page / network 错误（预期失败态按 URL 白名单放行）。用 `PHASE6D_STEPS=` 可只跑指定步骤，默认全套约 25 秒（构建已预热）；失败态截图前用样式隐藏 Next dev 左下角的「1 Issue」浮标（只影响截图，不改页面）
- [x] **截图**：`docs/screenshots/phase6d-2d-{desktop,empty,list,mobile,error,center-error,status-unknown}.png`（桌面 1440×900、移动 390×844 dpr 2）
- [x] **测试**：新增 `tests/lib/graph-layout-2d.test.ts`（18）与 `graph-layout-3d.test.ts`（33），共 **51 项**；`npm test -- --maxWorkers=2` **44 个文件 638 项通过**（另 1 个文件 / 3 项基准默认跳过，共 45 文件 641 项；6D-1 结束时 42 文件 587 项）
- [x] **质量门（本轮实跑）**：`tsc --noEmit` 退出 0；`eslint .` 0 error（14 条既有 warning）；`vitest run --maxWorkers=2` 638 通过 / 3 跳过；`check:theme` 129 名（31 几何 + 98 主题）· 0 失败 · 字面量 26；`check:contrast` 四套主题各 37/37（2D 普通边 3.63:1、强边 6.91:1、路径 16.17:1；3D 背景细边 1.2 / 1.5 仅要求可见，标注为装饰纹理）
- [ ] **遗留 / 未验证**：① 2D 只在 mock 实例上验收，真实 LightRAG 与真实 Logto 会话未复测；② 3D 仍是桩，`@react-three/fiber` 只安装未使用；③ hover 压暗按产品行为保留（整层压暗是「悬停预览」），未做 200ms 延迟优化——本机 headless 下未观察到明显掉帧，暂不动；④ 本机跑 `vitest` 默认 worker 池会 OOM（Exit 134），门禁一律加 `--maxWorkers=2`；⑤ 验收脚本的端口（3123 / CDP 9338）被残留进程占用时脚本会直接报错，跑前先清理；⑥ `THREE_D_READY` 仍为 `false`，自动判定不会进 3D，只有显式 `?mode=3d` / 「星系」按钮能看到桩

### Phase 6D-3：图谱默认 3D 接入 · 自适应降档与抽稀（ADR-022 附录 A v1.4）

> A 线第 3 步：把 B 线已完成的真实 three / fiber 渲染器接成桌面默认，并补齐 ADR-022 第 8 条的自适应降档与 `decimate` 消费路径。只动 A 归属文件；`03_DECISIONS.md` 由审查收口，本轮不改；不提交、不推送、不碰真实库。

- [x] **默认 3D**：删除 `THREE_D_READY = false` 这道开关与「3D 桩」相关文案，模式完全由 `selectGraphMode` 决定；桌面不带 `mode=` 直接进真实 WebGL 星系（`reason = auto-3d`），`?mode=3d` 仍走显式分支（`url-3d`）；无 WebGL / reduced-motion / 移动端仍回落 2D，移动端「星系」按钮与原来一样不渲染
- [x] **生产环境停止统计重渲染**：`handleReady` / `handleStats` 照旧写 ref，`setDebugVersion` 只在 `NODE_ENV !== "production"` 时调用；`__graphStats` 效果本身已是开发态专用。生产构建下每 30 帧的 stats 不再触发整棵 `GraphExplorer` 重渲染（dev 仍可读）
- [x] **自适应降档（ADR-022 §8）**：容器内 `tierCeiling` + `perfGuardRef`。只统计 `mode === "3d"` 且 `stats.rafActive`、帧数前进的窗口；连续两个 stats 窗口（≈60 帧）`avgFrameMs > 20ms` 才降一档，任一窗口 ≤20ms 清零；**空闲必须打断连续性**：非 3D / `rafActive=false` / 同一窗口重复发布（`frames` 没涨）/ 帧计数回绕（换布局归零）都清零 `slowWindows`，慢两秒再停手十秒不会续上一次的计数；按 `TIER_ORDER` 取下一档，最多降 2 次、间隔 ≥3s、降后清零；降档走 `selectGraphMode({ previousTier: tierCeiling })`，不自造档位表；`tierCeiling` 不持久化；播报一次「已自动降低画质以保持流畅」
- [x] **接上 `overBudget` / `decimate`**：`mode === "3d" && decision.overBudget` 且节点数超过 `TIER_BUDGETS[tier].maxNodes` 时，用 `decimate(view, { budget, keepIds })` 得到 `renderView` 交给 `GraphScene3D`；`keepIds` 含中心 / 选中 / hover / 路径端点；重建 `nodeIndex` 供场景反查；提示条追加「另有 N 个实体未显示」。2D / 列表 / 检查器 / highlight 仍用完整 `view`
- [x] **诊断参数 `?maxNodes=`**：`src/app/graph/page.tsx` 解析 `searchParams.maxNodes`，只接受 50–600 整数，其余（空、小数、越界、非数字）回落 150；SSR 预取与 `GraphExplorer` 用同一个值（`focusKey` 已含 maxNodes）；页面上没有控件，注释写明「验收 / 诊断参数，不面向普通用户」
- [x] **验收脚本**：`scripts/phase6d-capture.mjs` 新增 `3d`（桌面默认入口 / 移动端回落 / 低档）、`downgrade`（自动旋转 + CDP CPU 降速，默认 24× / 观察窗 30s，`PHASE6D_DROP_RATE` / `PHASE6D_DROP_WAIT` 可覆盖，`PHASE6D_DROP_PROBE=1` 打每 500ms 采样）、`maxnodes`（越界回落）、`overbudget`（宽夹具 373 实体）四步；Chrome 去掉 `--disable-gpu`、加 `--enable-unsafe-swiftshader`，默认入口能拿到真实 WebGL。**8× 降速在本机只压到 8–14ms，够不到 20ms 阈值**（2026-11-13 实测），故默认值改为 24×
- [x] **实测读数**（2026-11-13，mock LightRAG + 无头 Chrome）：
  - 桌面默认入口：`data-mode=3d`、`reason=auto-3d`、`tier=high`、drawCalls 6、labels 24、布局 2.3ms / 80 ticks
  - 移动端（390×844）默认入口：`data-mode=2d`、模式按钮 2 个（无「星系」）、2D 40 节点
  - 低档 3D（390 宽 + `?mode=3d`）：`tier=low`、dpr 1、labels 7、drawCalls 6、`reason=url-3d`
  - 自适应降档（2026-11-13 修完空闲清零后复测）：自动旋转 + 24× CPU 降速下**真实触发** `high → balanced`（两个连续慢窗口 30.52ms / 75.82ms），播报出现，撤掉降速 2.5s 后仍是 `balanced`（只降不升）；早期 8× 那一轮是 21.14ms 触发，但 8× 在本机不稳定（多数轮次只到 8–14ms）
  - `?maxNodes=600` + 宽夹具：API 返回 373，低档 3D 渲染 133（中心 + 12 一环 + 120 二环）、隐藏 240，提示条「另有 240 个实体未显示」；切 2D 后完整 373 且无隐藏文案；换中心后的客户端请求带 `maxNodes=600`
  - `?maxNodes=10` 越界：客户端请求回落 `maxNodes=150`
  - `scripts/graph-perf.mjs`（6D-3 时未改动；6D-4 起扩展了 `GRAPH_PERF_NODES`，150 基线仍通过）：150 节点 `layoutMs 7.1 / 80 ticks`、drawCalls 6、labels 28、标签重叠 0、自转 2s 出 240 帧、低档 labels 8
- [x] **截图**：`docs/screenshots/phase6d-3d-default-entry.png`、`phase6d-3d-mobile-2d.png`、`phase6d-3d-low-tier.png`、`phase6d-3d-overbudget.png`；`graph-perf.mjs` 另出 `phase6d-3d-{default,selection,low}.png`。均无水印
- [x] **质量门（本轮实跑）**：`tsc --noEmit` 退出 0；`vitest run --maxWorkers=2` **45 文件 672 项通过 / 3 项跳过（共 46 文件 675 项）**；`check:theme` 129 名（31 几何 + 98 主题）· 0 失败 · 字面量 26；`check:contrast` 37/37
- [x] **生产构建（2026-11-13 实跑）**：`NEXT_DIST_DIR=.next-build npm run build` 退出 0，`✓ Compiled successfully in 4.0s`、TypeScript 5.7s、4 个静态页生成完毕；全部路由为 `ƒ` 动态（`/graph`、`/api/*`），构建期没有查询数据库，`data/app.db` / `-wal` 的 mtime 未变（00:01 / 08:34）。剩 3 条告警，全是 `admin-service.ts` 的动态 `path.resolve` 追踪告警（既有，与本轮无关）；先前第一版构建里的 2 条 Worker 路径告警已被 B 线 6D-4 修掉（`08_RUN_LOG` 第 16 节），修复后重建即消失。另用真实库副本（`%TEMP%`）+ `AUTH_MODE=mock` 起 `next start`（3131 / 3132 各一次）：`/api/health` 200、`/api/graph/status` 200、`/graph` 200（26,207 字节 SSR，`data-mode=2d`，客户端挂载后才切 3D），服务端日志无报错；真实库未被打开，验证后副本已删
- [ ] **已知偏差 / 未验证**：① `decimate` 的二跳补位不保留三跳节点（冻结件既定行为），宽夹具里 240 个三跳节点全部隐藏，属预期；② 自适应降档只在「自动旋转 / 交互」造成的持续出帧窗口生效，静止 demand 渲染不评估（**空闲清零已修**：非 3D / `rafActive=false` / 帧数没涨 / 计数回绕都会把 `slowWindows` 归零，2026-11-13 落代码；这条路径由代码核对与真实触发复测覆盖，没有做「慢→空闲→慢」的专项运行时注入）；③ 宽夹具是 mock 的诊断数据集，真实 LightRAG 上没跑到 373 实体；④ ~~**B 线待修**：`src/components/graph/graph-scene-3d.tsx:258` 的 `new URL("../workers/graph-layout.worker.ts")` 少一层（应为 `../../workers/...`）~~ 已由 B 线 6D-4 修复（`../../workers/...`，见 `08_RUN_LOG` 第 16 节）；相机 `minDistance` 同步回到 ADR 的 260；⑤ ~~生产构建只验证了「能编译 + 能起服务 + `/graph` 出页面」~~ 已在 `next start` 下实测（2026-11-13，见本节后的「Phase 6D 收尾」与 `08_RUN_LOG` §18）：默认 3D 入口、真 Worker、低档抽稀、自适应降档四项全过；**真实 Logto 会话仍未在 `next start` 下复测**

### Phase 6D-4：Worker 相对路径修复 · 相机最近距离 · 真 Worker 端到端验收（ADR-022 附录 A v1.4）

> B 线第 4 步，收口 6D-3 遗留：只动 B 归属文件 `graph-scene-3d.tsx` / `starfield.tsx` / `scripts/graph-perf.mjs`；A 线文件、冻结件、`03_DECISIONS.md` 均不改；不提交、不推送。

- [x] **缺陷一：Worker 相对路径少一层**：`src/components/graph/graph-scene-3d.tsx` 的 `new URL("../workers/graph-layout.worker.ts", import.meta.url)` 是按文件所在目录 `src/components/graph/` 解析的，结果指向 `src/components/workers/...`；`next dev` 报 `Module not found`，节点 >300（`LAYOUT_WORKER_THRESHOLD`）时建 Worker 失败、回落到主线程并出 `chunk-failed` 横幅。修为 `new URL("../../workers/graph-layout.worker.ts", import.meta.url)`，并留一行注释说明层级
- [x] **缺陷二：相机最近距离与 ADR 不一致**：`starfield.tsx` 的 `controls.minDistance` 由 `120` 改回 ADR-022 A3.1 / A8 的 `260`；`maxDistance = 1100` 未动。120 在代码里找不到构图上的必要性（选中态没有推进镜头的逻辑），按 ADR 取值
- [x] **两处都不新增单测**：一个是打包期才存在的 URL 字符串、一个是 WebGL 运行时才生效的常量，node 环境里没有可断言的分支；既有 46 文件 675 项基线不变
- [x] **宽夹具 `GRAPH_PERF_NODES=50–600`**：`scripts/graph-perf.mjs` 新增该环境变量，>300 时换成宽夹具——两个互不相连的枢纽，每个 1 + 12 + 120 + 240，合计 373 个实体、深度 3 全可达，页面带 `?maxNodes=600`。**373 > 300 所以真走 Worker，373 < 600 所以 `truncated=false`**，一次同时验证「确实走 Worker」与「没被截断」
- [x] **实测读数**（2026-11-13，B 线报告 + 12:03 复跑）：
  - 宽夹具：Worker 内 `layoutMs 56.2–59.6ms`、150 ticks；Worker 回包约 85ms（预算 400ms，未触发截断）；端到端约 795ms（< 1200ms）；drawCalls 6、labels 21、dpr 1；`nodes=373 edges=372 rendered=373 hidden=0`
  - 150 基线（回归）：`layoutMs 7.1 / 80 ticks`、drawCalls 6、labels 28、标签重叠 0
- [x] **Worker 真身的证据链**：页面注入 `new Worker` 探针（`Page.addScriptToEvaluateOnNewDocument`，不改应用代码），实参解码后含 `src_workers_graph-layout_worker_ts`；CDP `Target.setDiscoverTargets` 下看到 1 个 `type: "worker"` 目标；Worker 实际回 `done`（`resultNodes=373`）。全程无 `Module not found` / `chunk-failed` / 网络 4xx / `g3-stub` 降级横幅
- [x] **截图**：`docs/screenshots/phase6d-3d-worker-600.png`（1440×900，真实 WebGL，无水印，373 实体 / 372 关系，星系 · high）
- [x] **换中心与取消**：最多 5 轮，每轮重载后在布局请求刚发出时切到另一个枢纽。抓到重叠的那一轮里，旧中心「甲」的 `done` 在新 layout 请求之后才回到主线程并被丢弃，最终采纳新中心「乙」的布局（`focus=乙`、373 节点）。`cancelled` 回执出现 **0 次**——旧布局在 cancel 到达前已经开始（同步循环期间收不到消息），按 A3 v1.3 只有「还没开始」的排队请求才会被 cancel。**协议层 `cancelled` 仍由单测覆盖，本轮端到端没有收到过**
- [x] **质量门（本轮实跑）**：`tsc --noEmit` 退出 0；`vitest run --maxWorkers=2` **46 文件 675 项（672 通过 / 3 跳过）**；`node scripts/graph-perf.mjs` 与 `GRAPH_PERF_NODES=600 node scripts/graph-perf.mjs` 均 `[ok]`
- [ ] **未验证**：① 无头 Chrome 的 `targetInfo.url` 为空串，Worker 脚本 URL 靠页面探针间接证明，不是 CDP 直接读出的地址；② 宽夹具是 mock 诊断数据，真实 LightRAG 上没跑到 373 实体；③ ~~生产运行时（`next start`）下的 3D 与 Worker 路径未实测~~ 已实测（2026-11-13，见下面「Phase 6D 收尾」与 `08_RUN_LOG` §18）

### Phase 6D 收尾：生产运行时（`next start`）四项实测（2026-11-13）

> 把 6D-3 / 6D-4 只在 `next dev` 下验过的「默认 3D 入口 / 真 Worker / 抽稀 / 自适应降档」搬到生产构建复验。生产态没有 `__graphStats`，断言只读可见 DOM；只动验收脚本与文档，应用代码未改；`03_DECISIONS.md` 未动。

- [x] **隔离**：`data/app.db` 用 better-sqlite3 只读备份到 `%TEMP%`（源库不打开写），副本上再播夹具对象；`NEXT_DIST_DIR=.next-build` 构建、`next start -p 3134`、`AUTH_MODE=mock`；验证后临时库 / 构建目录 / Chrome 用户目录全部删除
- [x] **四项实测**（1440×900 / 390×844，无头 Chrome + SwiftShader）：
  - 桌面默认入口（URL 不带 `mode`）：`data-mode=3d`、`[data-mode="3d"] canvas` 存在、`.g3-stub` 为 0、工具条「星系」`aria-pressed="true"`、提示条「40 个实体 · 49 条关系」、`window.__graphStats` 为 `undefined`（确认生产构建）；画布像素 674×506、平均亮度 9.16、亮像素 3.60%、颜色桶 855
  - `?maxNodes=600` + 宽夹具 373 实体：CDP `Target` 域观测到 1 个 `worker` 目标；提示条「373 个实体 · 372 条关系」，high 档不抽稀；换中心到「宽图枢纽二」后仍为 373、worker 目标仍在、无 `chunk-failed` / `Module not found`
  - 低档抽稀（390 宽 + `?mode=3d`）：档位「星系 · low」、提示条「373 个实体 · 372 条关系 · 另有 240 个实体未显示」；3D 画布 `aria-label` 写「133 个实体、132 条关系」，与 373 − 240 一致，且 133 ≤ low 档预算 150
  - 自适应降档：自动旋转 + 24× CPU 降速，12.2s 后「星系 · high」→「星系 · balanced」，播报「已自动降低画质以保持流畅」；撤掉降速 3s 后仍为 balanced（只降不升）
- [x] **夹具补强**：宽夹具新增第二个互不相连的枢纽「宽图枢纽二」（同样是 1 + 12 + 120 + 240 = 373）。原来从「宽图主题 01」展开 3 层只有 153 个实体（<300），换中心那一步会掉到 Worker 阈值以下，验不出「换中心后仍走 Worker」
- [x] **截图**：`phase6d-3d-default-entry-prod.png`、`phase6d-3d-downgrade-prod.png`、`phase6d-3d-worker-600-prod.png`、`phase6d-3d-worker-600-prod-switch.png`、`phase6d-3d-decimate-prod.png`（均在 `docs/screenshots/`，无水印）
- [x] **质量门（本轮实跑）**：`tsc --noEmit` 退出 0；`vitest run --maxWorkers=2` 45 文件通过 / 1 跳过，672 通过 / 3 跳过（共 46 文件 675 项）；`eslint .` 0 error / 14 warning（既有）；`check:theme` 129 名 · 0 失败；`check:contrast` 37/37
- [x] **运行记录**：`08_RUN_LOG` §18（命令、读数、脚本改动、证据链）
- [ ] **未验证**：生产运行时跑在 mock LightRAG 夹具 + 无头 SwiftShader 上，真实 LightRAG / 真实 Logto 会话仍未在 `next start` 下复测；Worker 由 CDP 目标证明存在，页面内消息流量未在生产构建下埋点

### Phase 6E：大模型配置 · 内容预览 · 图谱失败自愈（ADR-025 / ADR-026，2026-11-13）

> 起因是图谱页「什么都看不到」：排查后确认不是渲染问题，而是本机模型抽取全部超时、一个实体都没产出，而换模型只能手改 `infra/lightrag/.env`。三条线并行——配置入界面、内容可预览、失败可见可重抽。只改应用与文档，不提交、不推送。

- [x] **ADR-025：大模型供应商配置与凭据存储**：配置落 `settings` 单行加密 JSON，`src/server/security/secret-box.ts` 用 AES-256-GCM + HKDF-SHA256 加密（`v1.<iv>.<tag>.<ct>`，b64url），密钥来自新变量 `SETTINGS_ENC_KEY`；不复用 Logto Cookie 密钥，避免轮换登录密钥后已存 API Key 全部解不开。密钥缺失时报错而非明文落库；接口只回掩码与 `hasKey`
- [x] **权限与迁移**：`drizzle/0009_settings.sql` 建 `settings` 表并插入 `settings:read` / `settings:write`（仅 owner / admin），权限总数 **13 → 15**；`assertAuthzCatalog()` 在启动时核对代码常量与数据库目录
- [x] **四条设置接口**：`GET /api/settings/llm`、`PUT /api/settings/llm`（缺省 `apiKey` 沿用已存值）、`POST /api/settings/llm/test`（`max_tokens: 8` 最小请求，失败以 200 返回业务结果）、`POST /api/settings/llm/apply`（备份 `.env` → 只重启 `lightrag-server` → 60 秒轮询 `/health` → 失败回滚 `.env` 并重启回原配置）
- [x] **设置页 `/admin/llm`**：目录「系统」下新增入口（`settings:read` 可见，无权限与其它 admin 页一致拒绝）；供应商预设 OpenAI / DeepSeek / 通义千问 / 自定义 OpenAI 兼容 / 本机 Ollama；保存与应用分离，应用前确认弹窗写明重启 10–30 秒、在途任务中断、失败自动回滚；后端未就绪（404 / 503 非 JSON）显示「后端未就绪」而不是崩
- [x] **ADR-026：内容预览**：`ContentPreviewDialog`（原生 `<dialog>`）+ `PreviewProvider` 单一宿主，打开状态写 URL `?preview=<objectId>`，可后退关闭、关闭后焦点回触发元素；PDF 同源 iframe、Markdown 复用零依赖渲染器、纯文本、图片内联、其它类型下载；解析状态与失败原因（超时 / 连接 / 不支持格式 / 空内容）可见，附件可切换，移动端全屏
- [x] **预览入口（本轮范围）**：工作台列表标题点击与详情页「预览」；列表普通单击改就地预览，⌘ / Ctrl / Shift 单击仍是详情页链接。检索与图谱入口留到下一轮
- [x] **下载接口 `?inline=1`**：`GET /api/objects/{id}/content/{refId}` 在 `inline` 与 `attachment` 间切换；`Content-Type` 优先本地 `content_refs.mime`，因为 RAGFlow 对 PDF 常回 `application/octet-stream`，照搬会让内联打开退化成下载
- [x] **图谱失败归因**：`describeGraphFailure` 归一为六类可读原因（超时 / 连接失败 / 密钥或权限 / 限流或额度 / 未返回原因 / 首行摘要），原始错误串始终保留；`GET /api/graph/status` 只上报当前账号的对象
- [x] **图谱重抽**：`POST /api/graph/retry`（`objectIds` 1–20 个，权限 `content:sync`），逐条回 `resubmitted` / `skipped` / `failed`；图谱页失败项可展开原因并直接重抽
- [x] **空图根因（实测）**：本机 Ollama `deepseek-r1:7b` 纯 CPU 约 7 tok/s，单请求上限 300 秒，两篇长文双双 `ReadTimeout`——图谱不是「还没抽完」，而是全部抽取失败、一个实体都没有
- [x] **验收**：真实数据下 `/graph` 显示 1 个失败项、原因与重抽入口；`/admin/llm` 与预览弹窗在明暗主题下用浏览器实际打开核对；主题 129 名 0 失败、对比度 37/37、`tsc` 0、`lint` 0 error（14 条既有 warning）、`vitest` 50 文件 734 通过 / 3 跳过
- [ ] **未做 / 未验证**：`apply` 未在验收实例触发（会重启 LightRAG，需单独窗口）；真实供应商 API Key 的连接测试未跑；PDF 内嵌在 Chrome / Edge 的实机渲染、浏览器后退关闭弹窗、移动端全屏未逐项实测；多轮问答仍缺对话模型 key

## 下一步行动

按优先级：

1. ~~**Phase 1 收尾**~~：已完成（2026-11-11）。测试账号 `pakp_test`（`sub` `7vjekboa76zu`）走通登录 → `/workspace`，`ownerSub` 已记入 [04_INTEGRATION.md](04_INTEGRATION.md)。
2. ~~**前端登录态冒烟**~~：已完成。真实身份下 `/search`、`/workspace/[id]`、`/graph` 均渲染正常，创建资产 201、非法请求 400、匿名 401。
3. ~~**失败路径实测**~~：已完成（2026-11-13，真实 RAGFlow 容器 + 隔离实例实测）。① **RAGFlow 不可用时**：上传内容返回 `500 INTERNAL`，`details.cause` 为 `fetch failed` 且带失败端点；语义检索降级为 `semantic.status = "unavailable"`，`/search` 页显示「语义检索暂不可用，当前只显示关键词匹配结果」而关键词结果照常返回；`/api/graph/status`、`/api/objects` 等本地接口仍 200。② **outbox 退避**：RAGFlow 停机后 PATCH 对象入队 `upsert`，第 1 次失败 `attempts=1`、`available_at +60s`，第 2 次 `attempts=2`、`+120s`，`last_error` 记录失败端点；RAGFlow 恢复后第 3 次投递成功、`last_error` 清空、引用回到 `synced`。③ **解析失败回写**：上传结构损坏的 PDF（RAGFlow 接受上传但解析报错），轮询后 `parseStatus = "failed"`、`parseError` 写入 RAGFlow 原始报错「cannot convert float NaN to integer」，`/api/parse/run` 统计 `failed: 1` 并带 `refId` / `documentId`。④ 图谱页与 RAGFlow 无关（后端是 LightRAG），停机期间 `/graph` 正常渲染，这一条也一并确认。
4. **多轮问答会话**：需要 chat model API key；当前 RAGFlow 只有本地 embedding，检索可用但生成不可用。
5. **图谱强隔离（待做）**：读侧过滤已完成（ADR-011）；真正强隔离需按 `ownerSub` 拆分 LightRAG 实例 / 工作目录，触发条件是多账号同时使用图谱。
6. ~~**生产运行检查**~~：已完成。`next build` + `next start`（3100）通过，health 200 / 首页 200 / 未登录 307 / sign-in 307 到 Logto；开机自启由 `scripts\autostart.ps1` + 启动文件夹负责。
7. **管理员后台验收（待你本人确认）**：`.env.local` 已写入 `ADMIN_SUBS=gdv8t04dw4ca`（`JCzero001` 的 Logto `sub`）；用该账号登录后侧栏应出现「系统管理」，进入 `/admin` 可看到依赖服务与统计。若侧栏没有入口，重启开发服务让环境变量生效。本轮词表管理页已用测试账号（临时加入 `ADMIN_SUBS`，测后还原）完成真实登录实测，你自己账号的入口仍待亲自看一眼。

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
