# 架构决策记录（ADR）

> 本文件记录所有影响方向的关键决策。  
> 已采纳的决策原则上不删除，只追加或更新状态。  
> 变更已有决策时，必须新增 ADR 并说明原因，同时同步 00_SCOPE.md 与 01_ARCHITECTURE.md。

---

## ADR-001：LightRAG 与 RAGFlow 的向量存储策略

- **状态**：已采纳
- **日期**：2026-10-26
- **决策**：第一期共用 Embedding 模型，**不共用**向量库
- **原因**：
  - 降低两套系统的耦合，便于独立调试、升级和替换
  - Embedding 共用实现简单、成本低
  - 向量存储结构差异较大，强行共用容易引入一致性问题
- **后果**：
  - 存在两套向量数据，存储有一定冗余
  - 检索与图谱链路需分别维护
- **影响范围**：01_ARCHITECTURE、04_INTEGRATION、Phase 3

---

## ADR-002：第一期功能范围

- **状态**：已采纳
- **日期**：2026-10-26
- **决策**：第一期只保留并实现以下核心能力：
  - 资产（内库/外库、分类、标签、优先级等元数据）
  - 四阶段工作流（draft → finished → published → practiced）
- **明确不做**：
  - 旧知识图谱实现
  - 加密分享（AES ZIP）
  - 平台试运行评估
  - 多用户数据隔离
  - 复杂命令面板与高级批量能力
- **原因**：聚焦核心价值，控制第一期复杂度，快速跑通主路径
- **影响范围**：00_SCOPE、02_PHASES、Phase 4

---

## ADR-003：认证方案

- **状态**：已采纳
- **日期**：2026-10-26
- **决策**：
  - 使用 Logto **Docker 自托管**
  - 第一期仅实现登录 / 注册
  - 不做多用户数据隔离与复杂权限（RBAC）
- **原因**：满足基本身份需求，避免过早引入权限体系复杂度
- **状态变更（2026-11-12，ADR-019）**：第 3 条拆开处理——「不做多用户数据隔离」**继续有效**；「不做复杂权限（RBAC）」**废止**，角色与权限模型见 ADR-019。
- **后果**：所有数据按单用户处理；后续如需多用户需新增 ADR
- **影响范围**：01_ARCHITECTURE、Phase 1

---

## ADR-004：文档维护方式

- **状态**：已采纳
- **日期**：2026-10-26
- **决策**：
  - 使用固定 docs 结构（00_SCOPE ~ 05_CHANGELOG）
  - AI 必须按照 `docs/prompts/maintain-docs.md` 动态更新文档
  - 方向由 00_SCOPE.md 与本文件锚定，重大变更必须新增 ADR
- **原因**：保证重构过程中方向不跑偏，进度可追溯，文档与实现保持同步
- **影响范围**：全项目协作方式

---

## ADR-005：统一内容存储策略（核心）

- **状态**：已采纳
- **日期**：2026-10-26
- **决策**：
  - 以 **RAGFlow 作为统一内容存储与检索底座**
  - 资产与四阶段工作流作为**业务层**，建立在 RAGFlow 之上
  - **不再**以本地 Markdown 文件作为内容唯一真相源
- **原因**：
  1. 避免「本地文件 + RAGFlow」双存储导致的一致性问题
  2. 解析、分块、向量化、检索由 RAGFlow 统一负责
  3. 为知识图谱（LightRAG）和后续问答能力提供统一内容入口
- **后果**：
  - 资产 / 作品的内容主体存储在 RAGFlow
  - 业务侧只维护元数据、状态、以及与 RAGFlow 文档的映射（content_ref）
  - 本地文件系统降级为可选导入来源或临时区
  - 需要在 Phase 2 明确业务对象与 RAGFlow Document 的映射设计
- **影响范围**：
  - 00_SCOPE.md（已同步）
  - 01_ARCHITECTURE.md（已同步）
  - 02_PHASES.md（已同步）
  - 04_INTEGRATION.md
  - Phase 2 与 Phase 4 的实现方式

---

## ADR-006：代码库形态为从零新建（greenfield）

- **状态**：已采纳
- **日期**：2026-11-01
- **决策**：
  - 本仓库**当前全部交付物**为 `docs/`、`agents/`（进度 Agent）、接手指南与 agents 依赖；**不包含**既有 Next.js 业务应用或旧 vault 实现代码
  - 业务应用（Next.js 等）须在后续阶段**新建**，不得假设存在可改造的 `src/` / 旧页面
  - 产品规则（资产、四阶段工作流等）以 docs / ADR 为准实现，而非从旧仓库迁移代码
- **原因**：用户确认上传内容即为项目全部；避免执行 Agent 空等或误改不存在的路径
- **后果**：
  - Phase 1 必须包含：初始化 Next.js 工程 + Logto 集成
  - Phase 4 为新写业务，不是「重构旧模块」
- **影响范围**：00_SCOPE、02_PHASES、AI_CONTINUE_DEV_GUIDE、Phase 1~4

---

## ADR-007：内容映射契约与 Dataset 粒度

- **状态**：已采纳
- **日期**：2026-11-11
- **决策**：
  - RAGFlow 侧只使用 **单一 Dataset**
  - 内容映射放在**独立的 `content_refs` 表**，**不用** JSON 字段内嵌
- **关键结论**：
  - 业务 id（ULID）是**唯一身份**；`document_id` 只是**可变指针**
  - RAGFlow 正文更新是「删除 + 重传」，`document_id` 会变，因此不能把它当身份使用
  - 自建 `content_key` 写入 RAGFlow 的 `meta_fields`，作为**幂等键**认回文档
  - `meta_fields` 只镜像**过滤要用**的字段：`content_key`、`owner_type`、`owner_id`、`library`、`archived`、`format`、`source`
  - 镜像方向**单向**：业务库 → RAGFlow，**永不反向**
  - **不镜像 `status`**（状态只留在业务层，见 ADR-008）
  - 失败处理**不靠分布式事务回滚**，以 `content_refs` 作 **outbox** + 定时**对账**
- **原因**：
  - 分两个 Dataset 会让「迁移到内库」退化为「搬文档 + 换 `document_id`」，违反 `01_ARCHITECTURE.md` 的「状态变化只改业务元数据，内容位置稳定」
  - 单一 Dataset + 业务层过滤字段，才能让库别与状态的变更不触碰内容位置
- **后果**：
  - 所有跨库 / 归档的筛选必须依赖 `meta_fields` 的镜像字段与业务库，而非分库
  - 需要实现 outbox 写入 + 对账任务；短暂不一致可被对账修正
  - `content_refs` 需记录当前 `document_id`、`content_key` 与同步状态
- **影响范围**：01_ARCHITECTURE、04_INTEGRATION、Phase 2、Phase 4
- **变更**：如要推翻本决策，必须新增 ADR，并同步 `00_SCOPE.md` 与 `01_ARCHITECTURE.md`

---

## ADR-008：内库 / 外库的定义与字段拆分

- **状态**：已采纳
- **日期**：2026-11-11
- **决策**：
  - **外库 = 输入与待验证区**；**内库 = 已验证与可复用区**
  - 判定标准是「我现在敢不敢直接拿它去用或教别人」，**不是内容来源**
  - 拆成三个**正交**字段：
    - `library`：`internal` / `external`（**单值互斥**）
    - `source`：人写 / AI 提炼
    - `origin`：自己 / 导入
  - 资产**不设 `status`**，生命周期就是 `library` + `archived`，用数据库 **CHECK 约束**钉死
  - 外库作品**不得直接** `practiced`
  - 同一内容**不能同时属于两库**；需要两处使用就走「转资产」，并产生**两个对象**
- **原因**：
  - 旧项目里 `library=inner` 与 `status=draft` 并存的矛盾组合，说明一个字段塞了两件事
  - 来源（谁写的、从哪来）与验证程度是不同维度，混在一个字段里必然出现非法状态
- **后果**：
  - 前端与 API 需要分别暴露 `library` / `source` / `origin`，不能再用单一「类型」字段
  - 「转资产」是一次显式复制，两个对象此后各自演化
  - 数据库层必须校验 `library` 取值与 `archived` 组合，非法组合在写入时即失败
- **影响范围**：00_SCOPE、01_ARCHITECTURE、Phase 4、`content_refs` 映射字段
- **变更**：如要推翻本决策，必须新增 ADR，并同步 `00_SCOPE.md` 与 `01_ARCHITECTURE.md`

---

## ADR-009：业务元数据存储选型与分层结构

- **状态**：已采纳
- **日期**：2026-11-11
- **决策**：
  - 业务元数据使用 **SQLite + better-sqlite3 + Drizzle ORM**，**Phase 1 就落地**
  - **不用** Postgres，**不用** JSON 文件
  - 目录分层：
    - `domain`：纯类型与规则
    - `server.ports`：接口定义
    - `server.adapters.ragflow`：**唯一**外部入口
    - `server.repositories`
    - `server.db`
    - `server.services`
    - `server.http`
  - route handler **不超过 15 行**
- **原因**：
  - 单用户、单实例场景下 SQLite 足够，且无需额外服务进程
  - 分层把 RAGFlow 收敛到唯一适配器，业务逻辑不直接依赖外部服务
  - route handler 保持极薄，便于测试与替换
- **后果**：
  - Phase 1 的完成标准包含「最小持久化 CRUD」（见 `02_PHASES.md`）
  - 所有出入 RAGFlow 的调用只能经过 `server.adapters.ragflow`
  - 换库有明确触发条件，不因个人偏好提前迁移
- **换库触发条件**（三者任一成立才换 Postgres）：
  1. 出现多用户隔离
  2. 多实例部署
  3. 需要把向量放进业务库
- **影响范围**：01_ARCHITECTURE、02_PHASES、Phase 1、Phase 2、Phase 4
- **变更**：如要推翻本决策，必须新增 ADR，并同步 `00_SCOPE.md` 与 `01_ARCHITECTURE.md`

---

## ADR-010：LightRAG 部署与模型接入方式

- **状态**：已采纳
- **日期**：2026-11-11
- **状态变更（2026-11-13，ADR-025）**：LLM 从「固定 Ollama `deepseek-r1:7b`」改为**可配置的 OpenAI 兼容供应商**（未配置时默认值不变，仍指向本机 Ollama）；Embedding（bge-large-zh-v1.5 @ 9381）与文件存储两条**不变**。
- **决策**：
  - LightRAG 以 **本机 Python 进程**自托管（`lightrag-hku[api]` 1.5.7，官方 `lightrag-server`），不额外起 Docker 栈；环境与数据隔离在 `infra/lightrag/`，不进入仓库。
  - **LLM**：Ollama 本地 `deepseek-r1:7b`（实体 / 关系抽取与摘要），不需要外部 API key。
  - **Embedding**：与 RAGFlow 共用同一份 `BAAI/bge-large-zh-v1.5` 模型文件（从 RAGFlow 镜像缓存取得），通过一个本地 OpenAI 兼容 embedding 服务（`infra/lightrag/embedding_server.py`，默认 `127.0.0.1:9381`）暴露给 LightRAG，满足 ADR-001「共用 Embedding、不共用向量库」。
  - **存储**：LightRAG 默认文件存储（NetworkX 图 + NanoVectorDB 向量 + JSON KV），落在 `infra/lightrag/data/`，与业务 SQLite 完全分离。
- **原因**：
  - `lightrag-server` 不支持本地 sentence-transformers 绑定，只认 OpenAI 兼容接口；加一层极薄的 embedding 服务比魔改 LightRAG 更可控，且模型文件真正共用一份。
  - 本机无 GPU，Ollama 7B 是唯一无需外网的可用 LLM；14B 留作质量不够时的备选。
  - 文件存储在单用户、单实例场景足够，符合 ADR-009 的同一取舍。
- **后果**：
  - 图谱链路依赖三个本机进程：Ollama、embedding 服务、LightRAG 服务端；任一未启动时图谱功能不可用，业务主链路不受影响。
  - 7B 模型在 CPU 上构图较慢，大批量导入需要排队或改用更小分块；该限制写入 02_PHASES 与 07_PLAYBOOK。
  - 业务侧只通过 `server.adapters.lightrag` 访问，与 RAGFlow 适配器并列，不共享客户端。
- **影响范围**：01_ARCHITECTURE、02_PHASES、04_INTEGRATION、Phase 3

---

## ADR-011：图谱按账号归属过滤（读侧过滤）

- **状态**：已采纳
- **日期**：2026-11-11
- **背景**：接入 Logto 真登录后出现第二个账号。业务数据按 `owner_sub` 隔离，但 LightRAG 只有一个工作区：新账号在 `/graph` 能看到其他人的实体（实测新账号 0 条内容却列出 9 个实体）。
- **决策**：
  - 继续使用**单实例、单工作区**的 LightRAG（ADR-010 不变）。
  - 在服务层做**读侧归属过滤**：图文档的 `file_path` 已带 `pakp:obj:{objectId}:{hash}`，凡是节点 / 边 / 问答引用解析出的 `objectId` 不属于当前账号，一律丢弃。
  - 覆盖三个入口：实体标签列表、实体邻域、图增强问答；问答若引用不到本账号文档，直接返回空答复并提示，不返回可能混入他人内容的正文。
  - 标签过滤结果按账号缓存 60 秒，避免每次进页面都逐个实体探测。
- **原因**：
  - LightRAG 1.5.7 的 `--workspace` 是进程级存储命名空间，不能按请求切换；每账号起一个实例要再复制 LLM 连接、embedding 与存储目录，个人单机阶段成本过高。
  - 业务侧已经用 `file_path` 维护了对象溯源，读侧过滤复用这份既有契约，不需要改数据模型。
  - 写侧无法隔离：同事实体在 LightRAG 内部仍按名称全局合并，描述可能混合多个账号的原文。
- **后果 / 已知限制**：
  - 读接口不再泄露他人实体，但**实体抽取仍是全局的**：同名实体被合并后，描述里可能混入他人的话。界面文案已写「只对本账号可见」，强隔离在实现上并不成立，需在 02_PHASES 的已知限制里注明。
  - 标签列表过滤需要对候选标签逐个取一次 1 跳子图，首次进页面会多花几秒；已加缓存。
  - 真正强隔离的触发条件：多账号**同时**使用图谱，或任何一方提出强隔离要求 → 届时改为每账号独立 LightRAG 实例 / 独立工作区。
- **影响范围**：01_ARCHITECTURE、02_PHASES、04_INTEGRATION、07_PLAYBOOK、Phase 3

---

## ADR-012：管理员角色与后台入口

- **背景**：使用者提问「admin 用户该怎么登录，进去后是管理页面」。当前只有一条 Logto 登录链路，`SessionPort` 只暴露 `{sub,name,email}`，没有角色；业务数据按 `objects.owner_sub` 归属，也没有本地用户表。
- **决策**：
  - 管理员**不单独登录**：和普通用户走同一个 Logto 登录页，登录后凭身份判断是否管理员。
  - 角色来源用**环境变量白名单 `ADMIN_SUBS`**（逗号分隔的 Logto `sub`），在 `src/server/roles.ts` 里派生 `Session.isAdmin`；适配器只负责证明「你是谁」，不参与授权判断。
  - `AUTH_MODE=mock` 时本地固定身份直接视为管理员，方便开发与验收后台。
  - 后台入口 `/admin` 放在侧栏「系统管理」，只有管理员可见；已登录但不在白名单 → 渲染 403 说明页；未登录 → 沿用 `requireSession()` 回首页。
  - `POST /api/sync/run`、`POST /api/parse/run` 这类「动全库」的维护接口收紧为仅管理员可调用（新增 `FORBIDDEN: 403`）。
  - 后台 v1 只做三块只读信息 + 两个维护动作：依赖服务探测（RAGFlow / LightRAG / Logto）、存储与同步队列统计、按账号的归属统计；动作只有「立即同步队列」「推进解析状态」。
- **原因**：
  - 单机单用户部署，管理员就是使用者本人；本地 users 表会变成与 Logto 易失配的「影子用户表」，Management API + M2M 密钥对自托管是最重的方案。
  - `sub` 稳定且不可改，email 可改可空，白名单必须用 `sub`。
  - 把判断收敛在 `roles.ts` 一处：以后真要换 Logto 角色只改这里，页面与接口不用动。
- **后果 / 已知限制**：
  - 换管理员要改 `.env.local` 并重启服务；不支持多角色、细粒度权限。
  - 非管理员访问 `/admin` 渲染 403 页面但 HTTP 状态是 200（Server Component 不能直接设状态码），文案已明确说明无权限。
  - 后台不提供改角色、改业务内容、看密钥的能力：身份只来自环境变量与 Logto，避免自我提权；密钥只显示已配置 / 未配置。
  - 审计暂不入库：单用户下操作者恒等于 owner，先以应用日志记录动作。
- **状态变更（2026-11-12，ADR-019）**：第 2 条「角色来源 = `ADMIN_SUBS` 环境变量白名单」**由 ADR-019 取代**——授权改由本地 `users` / `roles` / `permissions` 表承担，`ADMIN_SUBS` 降级为「尚无 owner 时的引导通道」。其余条款（不单独登录、`/admin` 仅管理员可见、维护接口收紧、适配器不参与授权判断）**全部继续有效**。
- **影响范围**：00_SCOPE、06_API、09_USER_GUIDE、10_BACKLOG、05_CHANGELOG

---

## ADR-013：统一三栏应用框架（导航栏 + 模块目录 + 列表 / 详情）

- **背景**：V2 各页面此前各自为政：工作台在单页里先概览再列表，检索、图谱、后台只有单栏，来回切换要重扫整页。使用者明确表示喜欢 V1（`D:\projects\Personal Asset & Knowledge Platform`）的左侧三列目录，并要求参照其结构优化 V2。[11_LEGACY_UI_AUDIT.md](11_LEGACY_UI_AUDIT.md) 也把「列表 + 详情分栏」列为首批可移植项。
- **决策**：
  - 抽出统一网格 `.app-frame`：第一列固定 76px 图标导航栏（`NavRail`，工作台 / 检索 / 图谱 / 系统管理 + 账号与退出）；第二列是模块目录 `.directory`（`WorkspaceDirectory` / `SearchDirectory` / `GraphDirectory` / `AdminDirectory`）；第三列是列表 `.record-list` 或内容区 `.record-detail`。
  - 用 `:has(> .directory)` 决定出现三列，含列表时加 `.has-list` 变四列；页面只组合子元素，不传布局参数。
  - 工作台列表与详情共用同一份 URL 筛选状态（`q / type / library / status / sort / archived`）；点列表项只换详情区，不丢筛选、不整页跳走。
  - 目录项指向同页锚点（如 `/graph#graph-qa`）时用原生 `<a>`，其余用 `<Link>`。
  - ≤1100px 隐藏目录，≤900px 用 `data-selected` 让列表与详情互斥，≤560px 收起导航文字只留图标。
- **原因**：三层结构让「在哪个模块、这个模块有哪些分区、当前有哪些条目」一眼可见；单用户个人工具不需要更深的树形目录，平铺分组比折叠树更快；`:has()` + 少量根修饰类就能覆盖 2 / 3 / 4 列，不必为每个页面写布局；不用引入任何 UI 依赖。
- **后果 / 已知限制**：
  - 全局样式增加约 600 行（`.app-frame` / `.nav-rail` / `.directory` / `.record-list` / `.record-detail` 及四档响应式）。
  - 旧的 `app-sidebar.tsx` 与 `workspace-shell.tsx` 成为死代码，已删除，对应 `.app-shell` / `.sidebar` / `.nav-item` 样式一并移除。
  - ≤1100px 不显示目录，模块内分区只能靠页面内容与锚点到达。
  - `:has()` 依赖现代浏览器；本机 ego / Chrome 已支持，未给旧浏览器降级。
- **影响范围**：01_ARCHITECTURE、02_PHASES、05_CHANGELOG、07_PLAYBOOK、09_USER_GUIDE、11_LEGACY_UI_AUDIT

---

## ADR-014：正文类型（纯文本 / Markdown）与安全渲染

- **背景**：详情页正文编辑器只有带行号的纯文本模式；使用者要求在「编写正文」顶部加「类型」，新增 Markdown 类型，用于写结构化文章。
- **决策**：
  - 编辑器顶栏加「类型」分段控件：`纯文本 | Markdown`，右侧跟随一行当前类型的用法提示。
  - Markdown 模式为左右分屏：左侧书写（等宽字体、Tab 缩进、Ctrl/Cmd+S），右侧实时预览；纯文本模式保持原有行号列与不换行。
  - 预览由零依赖解析器 `src/lib/markdown.ts` + `MarkdownPreview` 渲染成 React 元素，不使用 `dangerouslySetInnerHTML`；链接只放行 `http/https/mailto` 与站内相对地址。
  - 保存仍走 `POST /api/objects/{id}/content`（role=primary）：Markdown 以 `text/markdown`、`.md` 扩展名上传，RAGFlow 仍是内容唯一真相源，不存渲染后的 HTML。
  - 打开已有正文时按 MIME 与文件名（`text/markdown` / `.md` / `.markdown`）自动选中 Markdown，否则按纯文本。
- **原因**：内容以源码形式进入检索与解析链路，比存 HTML 更利于分块与后续转换；自研解析器覆盖常用语法即可，不新增依赖、不引入 XSS 面。
- **后果 / 已知限制**：
  - 支持标题、粗体 / 斜体 / 删除线、行内代码、代码块、有序 / 无序列表、引用、链接、分隔线；不支持表格、脚注、内嵌 HTML、任务列表。
  - 类型不单独落库，由内容文件的 MIME / 文件名表达；把 Markdown 文章改名成 `.txt` 会被当作纯文本打开。
- **影响范围**：02_PHASES、05_CHANGELOG、09_USER_GUIDE、07_PLAYBOOK

---

## ADR-015：批量归档 / 导出 / 删除

- **背景**：使用者要求在第三列加批量删除、批量导出、批量归档；初版放在「列表标题与筛选框之间」，同日按反馈与筛选框互换，最终位于筛选框下方、列表上方。旧项目只有资产批量归档与草稿批量删除，没有导出。当前单条归档、删除已有独立接口。
- **决策**：
  - 列表行常驻复选框，一排批量条：`全选` + 已选计数 + `批量归档 / 批量导出 / 批量删除`；按钮在未选中或执行中禁用，位置固定在筛选框与列表之间（顺序「标题 → 筛选 → 批量 → 列表」），全站列表沿用同一顺序。
  - 归档、删除复用单条接口（`POST /api/objects/{id}/archive`、`DELETE /api/objects/{id}`），浏览器端逐项发出并用 `Promise.allSettled` 汇总，部分失败提示「已处理 N 项，M 项失败」；不新增批量路由，API 仍为 24 条。
  - 删除保留二次确认弹窗；三个动作成功后清空选择并刷新服务端数据。
  - 导出在浏览器里拼 Markdown：每项一节，带类型 / 归属 / 阶段 / 分类 / 标签 / 时间 / 描述；主内容为纯文本（`text/*` 或 `.md/.markdown/.txt/.json/.csv`）时带出正文，二进制只列文件名；最终下载 `资产与作品-YYYYMMDD.md`。
- **原因**：单条接口已经覆盖归属校验、软删除与审计，批量只做前端编排，避免再开一套批量接口与权限面；Markdown 单文件可读、可再导入，也不需要引入压缩库。
- **后果 / 已知限制**：
  - 选择状态只在当前页面内，刷新或切页后清空；导出的上限是当前列表上限（100 条）。
  - 导出不打包二进制附件，只记文件名；部分失败时不会回滚已成功的项。
  - 逐项请求在百条量级仍可接受；若将来需要事务或更大批量，再新增服务端批量接口。
- **影响范围**：02_PHASES、05_CHANGELOG、09_USER_GUIDE、10_BACKLOG

---

## ADR-016：作品形态与标签的词表化数据模型

- **背景**：使用者要求新建面板的作品形态可自定义、形态下方增加「标签」区、左侧目录增加「形态 / 标签」管理区，并强调**所有修改必须全局同步，不能某页改了某页没改**。现状：
  - `objects.format` 是 `text`，`objects_format_check` 把取值钉死在 6 个值（`drizzle/0001_objects_value_domains.sql`）；资产必须为 `NULL`（`objects_asset_has_no_work_fields`），作品必须有值（`objects_work_requires_format`）。
  - 形态列表在**7 处**硬编码：`src/domain/objects.ts:28`、`src/components/create-object-dialog.tsx:231`、`src/components/object-detail.tsx:23`、`src/components/record-list.tsx:22`、`src/app/search/page.tsx:34`、`src/lib/export-markdown.ts:21`、`src/server/services/object-service.ts:164/282`。
  - `objects.tags` 是 JSON 文本数组，无词表、无管理界面、无服务端筛选；新建面板没有标签输入，编辑面板（`src/components/object-actions.tsx:468`）只有一个逗号分隔文本框。
  - 真实数据 9 条（5 资产 + 4 作品），4 条作品的 `format` 全部是 `article`，标签只有 3 条 `["smoke"]`。
- **决策**：
  1. **形态用独立表 + 外键**：`work_formats(code TEXT PRIMARY KEY, label, sort_order, state, is_system, created_at, updated_at)`，`state ∈ {active, archived}`。`code` 一经创建不可改（改名只改 `label`），因此 `objects.format` 的**现有值天然就是合法的外键值**，迁移不需要重写任何一行业务数据。保留系统项 `uncategorized`（未分类，`is_system = 1`，不可删、不可停用）作为兜底与迁移目标。
  2. **`objects.format` 保留列名与类型**，只把 `objects_format_check` 换成 `FOREIGN KEY (format) REFERENCES work_formats(code)`。资产的两条 CHECK 不动。
  3. **标签用真多对多**：`tags(id TEXT PRIMARY KEY, label, normalized UNIQUE, sort_order, created_at, updated_at)` + `object_tags(object_id, tag_id, PRIMARY KEY (object_id, tag_id))`，两侧外键。`objects.tags` 这个 JSON 列在本次表重建中删除，JSON 不再是标签的真相源。
  4. **对外形状不变**：`BusinessObject.tags` 仍是 `string[]`（元素是标签的 `label`），`format` 仍是 code 字符串。仓储在读取时水合（一次 `SELECT object_id, tag_id FROM object_tags WHERE object_id IN (...)`，再在内存分组），**UI / 导出 / 筛选 / 既有测试的契约不变**，改的只有仓储内部。
  5. **唯一读取入口**：新增 `GET /api/vocabulary` 返回 `{ formats, tags }`（含 `label`、`sortOrder`、`state`、`usage`），前端没有浏览器端 provider：服务端组件直接调 `listVocabulary(db)` 取同步快照，把 `VocabularySnapshot` 作为 prop 传给客户端组件（`src/app/workspace/[[...slug]]/page.tsx:41`、`src/app/search/page.tsx:120`、`src/app/graph/page.tsx:31`、`src/app/admin/page.tsx:54`）；对外的读取路径只此 `GET /api/vocabulary` 一条。`src/domain/objects.ts` 的 `workFormats` 降级为 `SYSTEM_FORMAT_SEEDS`，只供迁移种子与测试 fixture 使用。用 ESLint `no-restricted-imports` 禁止业务代码导入 `SYSTEM_FORMAT_SEEDS`——规则在 `eslint.config.mjs`：`files: ["src/**/*.{ts,tsx}"]`、`ignores: ["src/domain/objects.ts"]`、`patterns: [{ group: ["**/domain/objects"], importNames: ["SYSTEM_FORMAT_SEEDS"] }]`，相对路径与 `@/` 别名都覆盖；并加一条测试断言「DB 词表包含全部种子」（`tests/server/vocabulary-service.test.ts`）。**2026-11-12 以实现为准**：原稿写「禁止其他文件从 `@/domain/objects` 导入 `workFormats`」——`workFormats` 已不存在于 `src/domain/objects.ts`（该导出改名为 `SYSTEM_FORMAT_SEEDS`），而同名 `workFormats` 现指 `src/server/db/schema.ts` 的 Drizzle 表常量，是正常用法，不在禁令范围内。
  6. **管理入口**：不放导航栏（`nav-rail` 已有「管理」一项，不必再加第二个），而是放在**第二列目录**里——`/admin` 的目录组件增加「管理」分组：「管理形态」「管理标签」两项 → `/admin/vocabulary`，仅管理员可见（权限见 ADR-019）。之所以选第二列：使用者原话是「最左侧目录也加一个管理区域」，而第一列只有 76px 图标位、文字放不下；第二列本来就是当前模块内的浏览入口，且与新增子路由（`/admin/users` 等）天然同构。路由保持 `/admin/vocabulary`。

     > **末句已被取代（2026-11-12，以实现为准）**：二级路由以 ADR-019 与本文档末尾「待对齐项裁决」第 1 条为准——已拆为 `/admin/vocabulary/formats`（形态）与 `/admin/vocabulary/tags`（标签）两页，代码在 `src/app/admin/vocabulary/{formats,tags}/`。本条其余内容（放第二列目录、不占导航栏、仅管理员可见）继续有效。
  7. **新增入口与权限（2026-11-12 以实现为准，原稿此条与实现不符）**：
     - **词表管理仅管理员**：新增独立词条、改名、停用、合并、删除形态 / 标签，分别对应 `vocabulary:format:write` / `vocabulary:tag:write`（矩阵见 ADR-019），v1 只有 owner / admin 拥有；`/api/vocabulary/formats`、`/api/vocabulary/tags` 及其子路由目前一律 `adminGuard` 拦截（`src/server/http/guard.ts`）。

       > **2026-11-13 以实现为准（ADR-023 落地后）**：本条中的键名与地址已过时——权限键是 `vocabulary:category:write`（`src/server/authz.ts:28`，旧键 `vocabulary:format:write` 已废止），真实接口是 `/api/vocabulary/categories` 与 `/api/vocabulary/categories/[code]`；`/api/vocabulary/formats*` 五个方法现为 308 跳转壳，不再提供写入能力。其余结论（词表管理仅 owner / admin、经 `adminGuard` 拦截）继续有效。
     - **形态没有「就地新增」**：新建面板只列 `state='active'` 的形态；管理员在「作品形态」标题旁看到「管理」链接（`src/components/create-object-dialog.tsx:258`）跳 `/admin/vocabulary/formats`，非管理员不渲染。与设计稿 §2.3「非管理员隐藏『管理』与『新增形态』」一致。
     - **标签不同：打标签时顺带创建，对普通用户开放**。`TagField`（`src/components/tag-field.tsx`）是自由输入 + 已有标签建议，不是「只能从词表里选」；提交后 `replaceObjectTags()`（`src/server/repositories/tag-links.ts`）先按 `normalized` 查，未命中就 `INSERT … ON CONFLICT DO NOTHING` 新建标签，然后链 `object_tags`，整个过程与对象写入同事务。因此**任何拥有 `object:write` 的角色（含 editor）都能隐式创建标签**；`vocabulary:tag:write` 管的是词表本身的维护，不是「标签能否产生」。
     - **为什么这样定（不收紧）**：标签是使用者自发的词汇。若要求「先由管理员建好才能选」，第一次打新标签就得 403 或被迫留空，标签退化成管理员预置的白名单；且标签链接与对象写入同事务，中途拒绝要么丢标签要么丢对象。污染风险由既有机制兜住：`normalizeTag` 归一化去重（全角 / 大小写 / 连续空白）、前端同名提示、单对象 ≤ 10 个、标签总数 500 软上限、管理员可合并。
     - **真要收紧，改这三处（不是只改文案）**：① `replaceObjectTags()` 增加 `actor` 参数，按 `normalized` 未命中且调用者无 `vocabulary:tag:write` 时抛 `ValidationError`（`TAG_NOT_FOUND`），而不是静默新建；② 该参数沿 `sqlite-object-repository.ts:211`（create）与 `:378`（update）透传，服务签名随之加 `ActorContext`，与 ADR-019 第 4 条第二层对齐；③ `TagField` 增加 `canCreate` 开关，非管理员只能选建议项，并补两条测试（editor 直接调接口建新标签 → 403；admin 同名操作 → 200）。代价是第一印象变差，v1 不采纳，仅登记为升级路径。
     - **按钮显隐是体验，接口仍按权限拦截**：这句话只适用于「词表管理」四个动作；「打标签时的新建」属于 `object:write`，本就不设单独拦截。
  8. **删除 / 停用语义**：
     - 形态：仍被引用时删除 → 拒绝（409，`details` 带 `usage` 与前 5 个对象），管理页提供「迁移到…」——选定目标后单事务 `UPDATE objects SET format = ?` 再删；无引用才可真删。停用（`archived`）不出现在新建面板，历史对象照常显示。
     - 标签：被引用时删除 → 拒绝，提供「合并到…」（`UPDATE object_tags SET tag_id = ?`，主键冲突用 `OR IGNORE`，再删源标签）。重命名只改 `label`，因为 `object_tags` 存的是 `tag_id`，所以**重命名是 O(1)，全站立即生效**。
     - 归一化：`trim` → 全角转半角 → 连续空白压成一个 → NFC → ASCII 小写，写入 `normalized` 并唯一；新建时按 `normalized` 命中即复用已有标签。
     - 上限：单标签 label ≤ 20 字；**每对象 ≤ 10 个标签**；标签总数软上限 500（超出只警告不拦）。
  9. **迁移方式（本次最大技术风险，已实测）**：
     - SQLite 重建 `objects` 必须先关外键；但 **`PRAGMA foreign_keys = OFF` 在事务内无效**，而 Drizzle 迁移器把整批迁移包在一个 `BEGIN` 里。实测：`objects` 被子表 `library_events.object_id` 引用（`drizzle/0003_content_refs_integrity.sql:48`），事务内 `DROP TABLE objects` 直接报 `FOREIGN KEY constraint failed`；事务外关闭外键才成功。`0001` 当初能过，是因为那时还没有这条外键。
     - 因此本次迁移**必须**把外键开关移到迁移外层：`openDatabase()` 里 `pragma('foreign_keys = OFF')` → `migrate()` → `pragma('foreign_keys = ON')` → `pragma('foreign_key_check')`，结果非空即抛错拒绝启动。迁移期无并发写（本地单机启动期），窗口安全。
     - 顺序：建 `work_formats` + 灌 7 行（6 个种子 + `uncategorized`）→ 建 `tags` / `object_tags` → 从 `objects.tags` 提取 distinct 灌入 → 重建 `objects`（加新 FK、删 `tags` 列、删 `objects_format_check`）→ 重建 `library_events`（其外键会在 `DROP` 时被连带处理）。
- **备选方案与取舍**：

  | 方案 | 做法 | 取舍 |
  |------|------|------|
  | **A（采纳，形态）** | 词表表 + `objects.format` 外键，对象侧只存 code | 引用完整性由数据库保证，删除有保护、改名只改一处；代价是重建 `objects` 表与启动期外键窗口 |
  | B（形态） | 只建词表表，`objects.format` 仍自由文本、无外键 | 零迁移风险；但「删除正在使用的形态」只能靠应用层检查——本项目 7 处硬编码的历史说明靠约定必漏 |
  | C（形态） | 形态列表放 JSON 配置文件 | 满足不了「管理页可增删」，否决 |
  | **D（采纳，标签）** | `tags` + `object_tags` 真多对多 | 一致性由外键保证、重命名 O(1)、合并是一条 UPDATE、使用次数是一次 `GROUP BY`；代价是读路径多一次查询（由仓储消化，对外形状不变） |
  | E（标签） | 保留 `objects.tags` JSON，另建词表仅作补全建议 | 读路径零改动；但重命名要全表重写 JSON、使用次数要 `json_each` 全表扫，JSON 与词表可能长期不一致——正是使用者抱怨的那类问题 |

- **影响**：
  - 新增 3 张表（`work_formats` / `tags` / `object_tags`），`objects` 与 `library_events` 重建；新增 6 个路由文件 / 8 个方法（`/api/vocabulary` 的 `GET`、`/api/vocabulary/formats` 的 `POST`、`/api/vocabulary/formats/[code]` 的 `PATCH`+`DELETE`、`/api/vocabulary/tags` 的 `POST`、`/api/vocabulary/tags/[id]` 的 `PATCH`+`DELETE`、`/api/vocabulary/tags/[id]/merge` 的 `POST`），对象类接口形状不变。
  - `openDatabase()` 增加迁移期外键开关与 `foreign_key_check` 断言（`src/server/db/client.ts`）。
  - `ListObjectsQuery` 增加 `tag`（按 label 解析为 tag_id 后 join 过滤）；`object-service` 的 `readEnum(format)` 改为「查词表且 `state='active'`」，错误码由 `VALIDATION_FAILED` 细化为 `NOT_FOUND`。
  - 7 处 `workFormats` 引用全部改走 `listVocabulary()`（服务端取快照、按 prop 下发）；`/workspace` 的形态筛选下拉同样改为读词表。
- **验收要点**：
  1. 在 `data/app.db` **副本**上跑迁移：对象数仍为 9、4 条作品的 `format` 仍为 `article`、`PRAGMA foreign_key_check` 为空。
  2. 先在管理页 `/admin/vocabulary/formats` 新增形态「播客」→ 回到新建面板，形态卡片里出现「播客」并选中 → 新建作品 → 刷新 / 重新登录后仍在；详情、列表、导出处显示同一个 label（新建面板已无「就地新增形态」，见第 7 条）。
  3. `grep -rn "SYSTEM_FORMAT_SEEDS" src/` 只命中 `src/domain/objects.ts` 的定义（**2026-11-12 以实现为准**：原写法 `grep -rn "workFormats" src/` 已失效——`workFormats` 现在是 `src/server/db/schema.ts` 的表常量，恒有命中，不能当判定依据）。
  4. 删除被 3 个对象使用的形态 → 409 且 `details.usage = 3`；走「迁移到未分类」后 3 个对象变为 `uncategorized`，该形态可删。
  5. 重命名标签后，详情页、列表、导出三处同时变化，不需要任何额外写入。
  6. **上限与需求文档一致**：第 11 个标签被拒绝且提示「每对象最多 10 个标签」；21 字的标签被拒绝；同一对象重复标签（含全角 / 大小写变体）被去重而不是报错。
  7. `npm test` 全绿（**当时基线 22 文件 / 231 项**——这是本批的历史门槛，保留原值；截至 2026-11-12 已增至 25 文件 / 259 项），新增词表相关测试 ≥ 6 项。
- **影响范围**：00_SCOPE、01_ARCHITECTURE、02_PHASES、05_CHANGELOG、06_API、09_USER_GUIDE、10_BACKLOG

---

## ADR-017：多主题系统

- **状态变更（2026-11-12，ADR-021 修订）**：第 2 条的语义层**部分恢复**并成为权威名——`--bg`、`--accent`、`--accent-hover`、`--accent-soft` 存活，`--accent-fg` 落地为 `--accent-contrast`、`--overlay` 落地为 `--dialog-backdrop`；冻结名单本身由 ADR-021 第 5 条的 **129 名三层契约**取代。第 1、6 条的迁移批次仍未执行（实测 `--green-*` 引用 **152 处**），继续单独立项。

- **背景**：使用者要求支持多主题，且强调登录页 / 首页 / 工作台 / 后台全站一致。现状 `src/app/globals.css` 共 4060 行，`:root` 里**已经有一层语义 token**（`--text-1/2/3`、`--paper`、`--surface`、`--surface-2`、`--line`、`--ok/warn/info/danger`，并逐条标注了对比度），同时保留了品牌色阶 `--green-*` 与旧别名 `--ink/--muted/--green`。实测分布：
  - `var()` 引用 **925** 处；其中直接引用品牌色阶 **107** 处（`--green-600` 30、`--green-700` 25、`--green-300` 19、`--green-050` 19、`--green-100` 8、`--green-800` 6）。
  - 硬编码颜色字面量 **79** 处（其中 `rgba(` 26 处，多为阴影）；TSX 组件里 **0** 处（颜色都写在 CSS 里，这是好消息）。
- **决策**：
  1. **CSS 变量 + `[data-theme]` 手写，不引第三方**。主题 = 一组语义 token 的覆盖；切换 = 设置 `document.documentElement.dataset.theme`。
  2. **主题只允许覆盖语义层**，品牌色阶属于默认主题的实现细节。语义层冻结为这批名字（现有名保留别名，避免一次性改名）：
     `--bg`（现 `--paper`）、`--surface`、`--surface-2`、`--text-1/2/3`、`--text-on-dark`、`--text-on-dark-muted`、`--line`、`--line-soft`、`--accent`（现 `--green-600`）、`--accent-hover`、`--accent-soft`、`--accent-fg`、`--ok/warn/info/danger` 成对、`--shadow-card`、`--shadow-pop`、`--overlay`、`--focus`。**新主题不得引入新 token 名**，只能重定义这组值。
  3. 默认主题 `[data-theme="light"]` 的值**逐字等于当前 `:root` 的值**，上线时视觉零变化。
  4. 持久化与防闪：`src/app/layout.tsx` 的 `<head>` 内联一段**同步**脚本（读 `localStorage.theme` → 无则跟随 `prefers-color-scheme`）在首帧前设置 `data-theme`；`<html suppressHydrationWarning>` 已存在（`layout.tsx:14`），正好覆盖属性差异。不引入 `next-themes`。
  5. **全站一致**：`/`、`/workspace`、`/search`、`/graph`、`/admin` 全部挂在同一个根 `layout.tsx` 与同一份 `globals.css` 上，变量天然一致。**首页（ADR-018）是唯一例外**：它固定使用深色星空背景，但前景控件（按钮 / 输入 / 文字）跟随主题语义 token；例外必须在样式里以 `[data-surface="cosmic"]` 显式标注，**不允许第二处例外**。
  6. **审计与分批**（避免一次动 1000+ 行）：
     - 第 0 批：只加语义 token 别名与 `[data-theme="light"]` 包裹，规则体一行不动；对 4 个页面截图，作为「默认主题基线」。
     - 第 1 批：把 107 处 `--green-*` 规则引用换成 `--accent*`，按 CSS 段落分批，每批 ≤ 30 处，每批后比对截图。
     - 第 2 批：消灭 79 处硬编码（26 处 `rgba` → `--shadow-*` / `--overlay`，其余 → 对应语义 token）。
     - 第 3 批：加第二个主题（先做 `dark`），逐页核对。
     - 审计命令（写进本文档，并作为 CI 断言）：
       `grep -nE '#[0-9a-fA-F]{3,8}\b|rgba?\(' src/app/globals.css` 只允许命中默认主题定义块里的 token 值；
       `grep -c 'var(--green-' src/app/globals.css` 在第 1 批后必须为 0。
  7. 主题选择入口：导航栏底部账号区下拉。v1 **只存 `localStorage`**，不做跨设备同步（那需要一张用户设置表，见未决项）。
- **备选方案与取舍**：

  | 方案 | 做法 | 取舍 |
  |------|------|------|
  | **A（采纳）** | `[data-theme]` + 内联脚本 + 手写 20 行持久化 | 零依赖、SSR 友好、现有 token 命名可保留；代价是防闪脚本要自己写对 |
  | B | 引入 `next-themes` | 省掉防闪与持久化；但项目至今零 UI 依赖（ADR-013 / ADR-014 均以此为据），而它解决的核心就是上面那 20 行，收益不足以换依赖 |
  | C | DaisyUI / Tailwind 主题体系 | 需要引入 Tailwind 并重写 4060 行样式层，等于重做前端，否决 |
  | D | 只换品牌色阶，不补语义层 | 最省事；但深色主题需要 `--surface` 变深、文字反转，只换绿色会得到「换色」而不是「换主题」，107 处引用会散成半深半浅 |

- **影响**：
  - `globals.css` 顶部新增 `[data-theme]` 块与语义别名；`layout.tsx` 增加内联脚本与 `data-theme`；新增 `ThemeToggle` 组件与 `src/lib/theme.ts`（把「解析主题字符串」抽成纯函数，便于单测）。
  - 样式改动分 3~4 批落地，每批都是可独立回滚的提交。
  - 测试：无逻辑测试受影响；新增「无 localStorage 时回落到系统 / light」等 2~3 项纯函数测试。
- **验收要点**：
  1. 默认主题下，`/`、`/workspace`、`/search`、`/admin` 四页截图与基线一致（像素差异 0）。
  2. 切到第二主题后刷新**不闪白、不闪浅色**（首帧即目标主题），登录页同样生效。
  3. `prefers-reduced-motion` 下过渡动画降级。
  4. 上述两条 `grep` 审计达到白名单状态，且全站不存在绕过变量的硬编码颜色。
- **影响范围**：01_ARCHITECTURE、05_CHANGELOG、09_USER_GUIDE、10_BACKLOG

---

## ADR-018：银河首页与导航调整

- **状态**：首页定位、抽屉、`nav-items` 单一来源仍有效；**第 6~8 条已由 ADR-020 取代**（2026-11-12：Canvas 2D 手写星图 → three.js 3D 星系，粒子 / 降级 / DPR 口径一并更新）；**第 3 条搜索链路已由 ADR-024 取代**（2026-11-13：首页内联预览 + 词法/语义混合检索）。以下正文保留为决策历史，不再按第 3、6~8 条实现。

- **背景**：使用者要求把 `/` 做成「整体是旋转的迎银河星系、宇宙星空为背景、偶尔有流星划过」的首页，左侧放可收起的抽屉装工作台入口，并把导航栏顶部「三条竖杠」的 logo 换成银河图标。现状：
  - `/` 已是迎宾页（`src/app/page.tsx` → `src/components/welcome-page.tsx`），`force-dynamic`，按 session 在「进入工作台 / 登录」之间切换。
  - 导航栏 `src/components/nav-rail.tsx:45` 的 `rail-brand` 指向 `/workspace`，里面就是三条竖线。
  - 检索有两条链路：`GET /api/search?q=`（RAGFlow 语义检索，需登录）与 `GET /api/objects?q=`（元数据 LIKE，需登录）；两者在未登录时都返回 401。
  - 项目零 UI 依赖，图标全部是手写 SVG（`icon.tsx`），`prefers-reduced-motion` 的写法在 `globals.css:119` 已有先例。
- **决策**：
  1. `/` 保持迎宾页定位并升级为银河首页；**`/workspace` 一行不动**（ADR-013 的三栏框架不受影响）。
  2. **已登录**：中央「进入工作台」+ 搜索框 + 左侧可收起抽屉；**未登录**：品牌叙事 + 登录按钮 + **禁用态的搜索框**，占位文案「登录后可检索内容」，提交不触发任何请求。~~初版此处写的是「不渲染搜索框」~~，2026-11-12 按设计稿 §4.6 改为「渲染但禁用」：登录前后布局不跳变（避免一次明显的 CLS），也让未登录用户知道这里能搜；禁用态不产生请求，401 问题依然不存在。
  3. ~~**搜索框复用现有接口，不新建**：表单 `GET /search?q=` 直接跳语义检索页，不做即时联想、不发 XHR。理由：首页不该引入第二套检索栈，`/search` 已有完整结果页与空态。~~ **已被 ADR-024 取代**（2026-11-13）：首页增加 ≥2 字 / 200ms 的内联预览（只走词法、不碰 RAGFlow），`/search` 改为词法 + 语义混合结果页；「不引入第二套检索栈」的理由仍成立，因此预览与结果页共用同一套解析与排序。
  4. **抽屉是导航的镜像，不是第二套导航**：把 NavRail 的菜单项抽成 `src/lib/nav-items.ts` 单一来源，`NavRail` 与首页抽屉都从这里读，避免「改一处漏一处」（与 ADR-016 第 5 条同一原则）。
  5. logo 换成银河图标（`icon.tsx` 新增 `galaxy`），`rail-brand` 的 `href` 由 `/workspace` 改为 `/`，`aria-label` 改为「返回首页」。工作台内部靠目录与面包屑回到工作台，不依赖 logo。
  6. **星图用 Canvas 2D 手写，不引 three.js**：螺旋臂粒子 + 缓慢旋转 + 星点闪烁 + 偶发流星，全部画在一个 `<canvas>` 里。理由：这是背景装饰而非交互场景，three.js 会为一张背景引入约 150KB 与一个 WebGL 上下文，且首屏必须 `ssr:false`。
  7. **降级链**：`prefers-reduced-motion: reduce` → 静态星图（不旋转、无流星）；`navigator.hardwareConcurrency ≤ 2` 或 `deviceMemory ≤ 2` → 粒子减半 + 30fps 节流；`document.hidden` → 暂停 `requestAnimationFrame`；Canvas 不可用 → CSS 径向渐变 + 少量星点兜底；`devicePixelRatio` 上限取 2（避免 4K 屏上每帧画 800 万像素）。
  8. **SEO / 首屏**：本地单机应用，SEO 不构成约束，但仍保留 `<h1>` 语义与独立 `metadata`，避免将来要公开时返工。星图在 `useEffect` 里启动，不阻塞首屏文字与按钮；首帧前用 CSS 渐变占位，避免白闪。
- **备选方案与取舍**：

  | 方案 | 做法 | 取舍 |
  |------|------|------|
  | **A（采纳，星图）** | Canvas 2D 手写螺旋星系 | 零依赖、体积小、可控降级；代价是 3D 纵深感不如真 WebGL |
  | B（星图） | three.js 真 3D 星系 | 更像「银河」，但要 WebGL、约 150KB、首屏成本高、低端机风险大 |
  | C（星图） | 纯 CSS 动画星点 | 最轻，但做不出螺旋结构与流星轨迹，且大量元素动画会堆合成层 |
  | **A（采纳，首页位置）** | 升级 `/` | 一套页面同时服务已登录与未登录，登录回调不用改 |
  | B（首页位置） | 新开 `/home`，`/` 重定向 | 多一跳，且现有「未登录回首页」的逻辑全部要改 |
  | **A（采纳，搜索）** | 跳 `/search?q=` | 零新接口、零新状态 |
  | B（搜索） | 首页内嵌结果面板 | 要在首页复制 loading / 空态 / 401 处理，与 `/search` 重复 |

- **影响**：
  - 新增 `src/components/galaxy-home.tsx`、`src/components/galaxy-scene.tsx`（canvas），可单测的部分抽到 `src/lib/galaxy.ts`（粒子初始化、旋转、流星生成、降级阈值判定）。
  - 新增 `src/lib/nav-items.ts`，`nav-rail.tsx` 改为消费它（行为不变，属重构）。
  - `page.tsx` 从 `WelcomePage` 切到 `GalaxyHome`；`welcome-page.tsx` 合并进新组件，`signedIn` 只控制 CTA 区。
  - **行为变更**：点 logo 现在回 `/` 而不是 `/workspace`，需在 09_USER_GUIDE 注明。
  - 测试：新增 `galaxy.test.ts` 4~6 项；`nav-items` 抽离后既有测试不受影响。
- **验收要点**：
  1. 未登录访问 `/`：搜索框存在但禁用且不算作可提交控件、有登录按钮；已登录：搜索框可用、有进工作台按钮、抽屉可开合且抽屉项与导航栏完全一致。
  2. 搜索框提交 → 跳 `/search?q=xx`，结果页正常。
  3. `prefers-reduced-motion: reduce` 下无旋转、无流星，主线程占用接近静态页。
  4. 标签页切走 → rAF 暂停（帧数归零）。
  5. 点 logo 回 `/`，`aria-label` 为「返回首页」。
  6. 首屏可交互时间不差于工作台（同为本地 SSR 页面），星图启动不影响点击。
- **影响范围**：01_ARCHITECTURE、02_PHASES、05_CHANGELOG、06_API、09_USER_GUIDE

---

## ADR-019：管理后台的用户 / 角色 / 权限模型

- **状态**：已采纳，**已实施**（2026-11-12 设计，2026-11-13 按代码核实改状态）。依据：`src/server/authz.ts` 已导出 13 项 `PERMISSIONS` 常量与 `requirePermission` / `requireAnyPermission`；`src/server/http/guard.ts` 的 `adminGuard` 已收敛为薄封装（默认 key 为 `vocabulary:category:write`）；`src/server/services/audit-service.ts` 已存在；`src/app/api/admin/users`、`users/[id]`、`roles`、`audit` 四个路由文件均已上线，对应 `user:read` / `user:write` / `role:write` / `audit:read`。**两点与原文不符，已在正文就地更正**：权限矩阵里的 `vocabulary:format:write` 已由 ADR-023 改名为 `vocabulary:category:write`（第 3 条）；第 10 条的 `GET /api/admin/audit/export`（CSV）**没有实现**，只有设计稿。 **2026-11-13（ADR-025）**：权限清单由 13 项增至 **15 项**（新增 `settings:read` / `settings:write`，仅 owner / admin），矩阵其余不变。

- **背景**：使用者第 4 条需求要求把「过于简陋」的管理页细化重做，明确点名用户管理、角色管理、权限管理。现状：
  - 身份只有一个来源：Logto（`src/server/adapters/session/logto.ts`），`SessionPort` 只返回 `{ sub, name, email }`。
  - 授权只有一条规则：`ADMIN_SUBS` 环境变量白名单（`src/server/roles.ts:24` `computeIsAdmin`），在 `src/server/session.ts:51` 折成 `Session.isAdmin`，再由 `src/server/http/guard.ts:10` 的 `adminGuard` 挡在接口前。
  - 只有两个事实上的角色：管理员 / 非管理员；没有权限粒度，「改词表」和「删用户」是同一个开关。
  - 没有任何审计：`grep -rn audit src/` 命中 **0** 处；`library_events` 只记录内库 / 外库迁移，`actor_sub` 字段是现成的先例。
  - `/admin` 是一个单页（`src/app/admin/page.tsx`），第二列目录 `AdminDirectory`（`src/components/directory.tsx:212`）只有三个锚点：依赖服务 / 存储与队列 / 用户与归属。
  - 部署形态仍是本地单机 + 自托管 Logto，真实账号 1 个。

- **与 ADR-003 / ADR-012 的关系（明确结论，不留模糊）**：
  - **ADR-003 第 3 条「不做多用户数据隔离与复杂权限（RBAC）」拆成两半处理**：「不做多用户数据隔离」**继续有效**，「不做 RBAC」**废止**。本 ADR 引入的是**授权**，不是**多租户**：不做 ACL、不做对象级可见性授权，`objects.owner_sub` 仍是唯一归属键。
    - **2026-11-13 更正**：原文「所有登录用户仍然看到同一批 `objects`…不做按用户过滤」是错的，且在本 ADR 写就之前就已过时——ADR-011（2026-11-11）规定**读侧按 `owner_sub` 过滤**，`sqlite-object-repository.ts` 的列表查询在 `ownerSub` 非空时追加 `eq(objects.ownerSub, …)`，内容服务与图谱服务都按会话传入该值。正确口径：**归属过滤（谁能看见谁的数据）与 RBAC（谁能做哪个动作）是两件事**，前者由 ADR-011 管，后者由本 ADR 管；本 ADR 不做的是对象级 ACL 与跨用户的显式授权。
  - **ADR-012 第 2 条「角色来源 = 环境变量白名单」被本 ADR 取代**；ADR-012 其余条款**全部保留**——尤其是「管理员不单独登录」「后台只有管理员可见」「跨账号图谱按 `file_path` 过滤」三条。`ADMIN_SUBS` 不删除，语义降级为**引导通道**（见下）。
  - 依据不是外部压力，而是这两条 ADR 自己写的演进口：ADR-003 后果栏「后续如需多用户需新增 ADR」、ADR-012 原因栏「以后真要换 Logto 角色只改 `roles.ts`」。本 ADR 走的正是那个口子，而不是推翻它们的设计前提。
  - **ADR-019 生效后，ADR-003 与 ADR-012 的这两处条款以本 ADR 为准**；两份原文的「状态」行各加一句指向（只追加，不删原文）。

- **决策**：
  1. **身份与授权分层，各由一个组件独占**：
     - **Logto 只做身份（authentication）**：证明「你是 `sub`」。适配器仍然不参与任何授权判断（ADR-012 原则不变）。
     - **本地 SQLite 做授权（authorization）**：`users` / `roles` / `permissions` / `role_permissions` / `user_roles` 五张表是唯一真相源。
     - 之所以不直接读 Logto 的角色：那需要 Management API + M2M 应用凭据（ADR-012 已判定为最重方案）；角色改动要等 token 重签才生效，会出现「改了没生效」；Logto 停机时授权会连带失效，而单机应用不该这样；更根本的是**判定点和资源在同一个事务边界里**（词表、对象都在本地 SQLite），跨服务判定无法提供这个保证。
  2. **表结构**（六张表全部落库；`permissions` 的**内容**以代码常量为源，迁移时灌入、启动时校验一致，避免「代码加了权限、库里没有」）：
     - `users(id TEXT PK, sub TEXT UNIQUE NOT NULL, display_name, email, state ∈ {active, disabled}, created_at, last_seen_at)`。**`sub` 唯一但不作主键**：将来换 IdP 时只需改 `sub` 一处，所有外键与审计不受影响。
     - `roles(key TEXT PK, label, is_system INTEGER, sort_order)`。四个系统角色 `owner / admin / editor / viewer`。
     - `permissions(key TEXT PK, label, group_key, sort_order)`。
     - `role_permissions(role_key, permission_key, PK 联合)`、`user_roles(user_id, role_key, PK 联合)`。
     - 所有表带 `ON DELETE CASCADE`，但**审计表不级联**（见第 8 条）。
  3. **权限清单（13 项）与四个角色的矩阵**：

     | 权限 | 说明 | owner | admin | editor | viewer |
     |------|------|:-:|:-:|:-:|:-:|
     | `object:read` | 看列表 / 详情 / 正文 / 检索 | ✓ | ✓ | ✓ | ✓ |
     | `object:write` | 新建、编辑、归档、库别迁移、写正文 | ✓ | ✓ | ✓ | |
     | `object:delete` | 单条与批量删除（软删） | ✓ | ✓ | | |
     | `object:export` | 导出 Markdown | ✓ | ✓ | | |
     | `vocabulary:category:write` | 新增 / 改名 / 停用 / 删除 / 迁移分类（ADR-023 前的键名 `vocabulary:format:write` 已废止） | ✓ | ✓ | | |
     | `vocabulary:tag:write` | 词表维护：新增独立词条 / 改名 / 合并 / 删标签（**不含**对象写入时的隐式建标签，见下方约束第 5 项） | ✓ | ✓ | | |
     | `content:sync` | 手动同步队列 | ✓ | ✓ | | |
     | `content:parse` | 推进解析状态 | ✓ | ✓ | | |
     | `system:read` | 运行时只读：依赖服务、存储、归属统计 | ✓ | ✓ | | |
     | `audit:read` | 查审计日志与导出 | ✓ | ✓ | | |
     | `user:read` | 看用户列表与角色 | ✓ | ✓ | | |
     | `user:write` | 改他人角色、停用 / 恢复用户 | ✓ | | | |
     | `role:write` | 改角色定义（v1 只读，预留） | ✓ | | | |

     五条设计约束（**2026-11-13 补**：矩阵第 5 行的键名已按 ADR-023 改为 `vocabulary:category:write`，下方约束里的「形态」一词保留原文，指的就是今天的「分类」词表）：
     - **形态与标签分成两个权限，虽然 v1 授予的角色完全相同**。这不是冗余：需求文档的矩阵本来就分「管理形态词表」「管理标签词表」两行，两者变更频率与影响面差一个数量级（形态错一次全站新建面板都错，标签错了可合并）。现在合起来写，将来要放开「编辑可加标签」时就得改判定逻辑；分开写则只是改一行矩阵。
     - **批量操作不单设权限**：批量条是否出现 = 其包含动作所需权限的**交集**（归档 = `object:write`，导出 = `object:export`，删除 = `object:delete`）。editor 有 `object:write` 但缺另外两项 → 批量条不出现，单条归档照常可用。这样既没有「单条能删、批量不能删」的怪状态，也不会出现「批量删除绕过 `object:delete`」。
     - **`role:write` 存在但 v1 不开放写入**：角色是 4 个系统角色，不可自定义（理由见备选方案 D）。列出来是为了让矩阵完整、升级路径明确。
     - **编辑角色没有删除权**，尽管角色定义里写的是「内容增删改」。以需求文档的**权限矩阵**为准（更具体、更可测），该表述已在下面的差异清单里标为待 Product 修正。
     - **打标签不另设权限，只有词表维护要 `vocabulary:tag:write`**（2026-11-12，以实现为准）：`replaceObjectTags()` 在对象写入时按 `normalized` 未命中即新建标签（`src/server/repositories/tag-links.ts`），这是 `object:write` 的自然结果，editor 同样拥有，**不是权限漏洞**。若把它也纳入 `vocabulary:tag:write`，则所有「第一次出现的标签」都会挡在 editor 门外。理由与否决后的具体改动点见 ADR-016 第 7 条。
  4. **执行点：三层，但只有一层是安全边界**。
     - **第一层（唯一强制层）**：`src/server/authz.ts` 导出 `requirePermission(session, key): Response | null`，形状与现有 `adminGuard` 一致，**所有 `/api/**` 的 `GET/POST/PATCH/DELETE` 第一行必须调用**。现有 `adminGuard` 收敛为 `requirePermission(session, "vocabulary:category:write")` 的薄封装（键名随 ADR-023 更新；`src/server/http/guard.ts` 的实际默认值即此），不新增第二套判定。
     - **第二层（审计与内部调用）**：所有写服务的方法签名加 `actor: ActorContext { sub, userId, permissions }`，由 route 层传入。让「没有 actor 的写」在类型上不可能，审计因此不依赖开发者记性。
     - **第三层（UI 显隐）**：`Session.permissions: string[]` 随 session 下发，`NavRail` / `AdminDirectory` / 按钮按 `can(key)` 显隐。**明确：UI 隐藏永远不是安全边界**，因此不做「隐藏了就安全」的验收项，只做体验验收。
     - **明确否决 Next middleware 做鉴权**：middleware 拿不到 SQLite（Node 运行时限制与冷启动成本），且它按路径匹配，做不到「同一路径下 `POST` 要权限、`GET` 不要」。鉴权必须在 route 层。
  5. **「前端藏了按钮、接口仍可调」的核心防线是一个测试，不是 code review**：
     - 新增 `tests/server/route-guard.test.ts`：扫描 `src/app/api/**/route.ts` 的每个导出方法，断言其函数体首段包含 `requirePermission` 或 `adminGuard`，否则必须在该测试的 `PUBLIC_ROUTES` 白名单里显式登记（当前只有 `/api/health`、`/api/logto/*`）。
     - 同一测试扫描 `"use server"`：将来若引入 Server Action，同样要求带权限判定。
     - 这条测试是 ADR-019 唯一的「不可绕过」保证；其余都是约定。
  6. **单机阶段的生效范围（写清哪些是真的、哪些只是壳）**：
     - **真正生效**：13 项权限在接口层的判定；导航与按钮的显隐；审计落库；用户表可写（分配 / 撤销角色、停用用户）。
     - **可用但只有一行数据**：真实 Logto 账号 1 个（使用者本人 = owner）。所以「改角色」「停用用户」在界面与接口上完整，实际没有第二个用户可操作。
     - **v1 只读展示**：`/admin/roles` 只展示角色与权限矩阵，不可编辑（理由见 `role:write` 一行与备选方案 D）；权限清单不单开页面，作为代码常量随矩阵一起渲染。
     - **明确不做**：多用户数据隔离、对象级 ACL、跨用户可见性控制——这是 ADR-003 保留部分，不在本次范围内。（2026-11-13 更正：原文「所有登录用户共享同一批对象」不成立，读侧已按 `owner_sub` 过滤，见上条更正。）
  7. **首个 owner 的引导（替代 ADR-012 的白名单授权，但保留逃生舱）**：
     - 迁移**不预置** `users` 行（此时还不知道 `sub`）。
     - **引导条件**：`users` 表中 `state='active'` 且拥有 `owner` 角色的行数为 **0** 时，`ADMIN_SUBS` 白名单生效——第一次登录的命中用户被写入 `users` 并授予 `owner`，同时记一条 `audit_events`。
     - **引导关闭**：一旦存在 active owner，`ADMIN_SUBS` **不再参与任何授权判断**。否则等于保留了第二套授权源，与本 ADR 第 1 条自相矛盾。
     - **逃生舱**：owner 全部失联（被停用 / `sub` 变更）时，`ADMIN_SUBS` 重新生效（同上条件判定，不需要改代码）。另提供 `npm run admin:grant -- <sub> owner` 运维脚本，用于离线恢复；脚本必须走同一服务层并写审计。
     - `AUTH_MODE=mock` 时，mock 固定身份直接是 owner，与今天行为一致；同时 `/api/health` 返回 `authMode`，并在启动日志打印一行警告（避免把 mock 当生产部署）。
     - **换管理员从「改 `.env` 并重启」变成「在 `/admin/users` 里改」**，这是对 ADR-012 已知限制「换管理员要改环境变量并重启」的直接消除。
  8. **审计**：
     - 新表 `audit_events(id TEXT PK, actor_sub TEXT NOT NULL, actor_user_id TEXT NULL, action TEXT NOT NULL, target_type, target_id, detail TEXT /*JSON*/, result ∈ {ok, error, denied}, created_at TEXT NOT NULL)`，索引 `(created_at)`、`(actor_user_id, created_at)`、`(target_type, target_id)`。
     - `result` 取自需求文档字段表（`12_REQUIREMENTS_V3.md`）；`denied` 用来记 **403 拒绝**——「谁试图做了什么但被挡住」和「谁做了什么」同等重要，缺了它审计只能回答一半问题。
     - **`actor_user_id` 故意不加外键**，只存 `actor_sub` 快照。理由：审计必须在用户被删除或 `sub` 变更后仍可读，加外键会让「删用户」连审计一起删。
     - **必须落库的动作**：词表增删改（含合并、迁移到未分类）、对象删除（单条与批量，批量写 1 条汇总 + N 条明细）、对象归档、库别迁移（`library_events` 保留为领域记录，同时写一条 `audit_events`）、导出、手动同步 / 解析触发、用户与角色变更、引导性绑定。
     - **写入语义：与业务写在同一事务里，审计失败则业务回滚。** 这是与 ADR-012「先以应用日志记录动作」的关键差异——审计是断言，不是日志，不能用 best-effort。**唯一的例外是 `result='denied'` 的 403 记录**：它没有业务写可回滚，由 guard 独立写入，写失败只记应用日志，绝不能因为审计写不进去就放行请求。
     - **保留策略**：不自动清理。单机量级下每行都是人操作（不是请求日志），10 万行是明确阈值；超过后按 `created_at` 归档到 `data/audit-YYYY-MM.jsonl` 再删库内行。
  9. **路由与信息架构（与 `12_REQUIREMENTS_V3.md` / `13_DESIGN_V3.md` 对齐）**：
     - `/admin` 改为**总览**（对象计数、解析待完成、同步失败、依赖服务摘要、最近 5 条失败）。
     - 现有三块只读信息与两个维护动作**迁入 `/admin/system`**，行为不变；这是本 ADR 唯一改动既有后台行为的动作。
     - 页面清单：`/admin`、`/admin/objects`、`/admin/vocabulary/formats`、`/admin/vocabulary/tags`、`/admin/users`、`/admin/roles`、`/admin/system`、`/admin/audit`。
     - **`/admin/vocabulary/*` 而非设计稿的 `/admin/vocab/*`**：缩写后缀会与已实现的 `/api/vocabulary/*` 分叉，同一个概念出现两种写法正是使用者抱怨的那类问题；两页拆开则与设计稿 §2.3 一致。
     - **不单开 `/admin/permissions`**：权限清单是代码常量，作为 `/admin/roles` 的矩阵表头渲染即可，多一个页面只是多一个要同步的地方。
     - `AdminDirectory` 从「三个锚点」改为**真链接 + 四个分组**：
       - 概览：总览 / 内容
       - 词表：形态 / 标签
       - 账号：用户 / 角色
       - 系统：运行时 / 审计
     - 「词表」与「账号」两组按设计稿 §2.4 同时出现在**工作台、检索、图谱、管理四个页面**的第二列，非管理员整组不渲染——这就是使用者原话「最左侧目录加一个管理区域」的落点。
     - `NavRail` 的 `adminItem`（`src/components/nav-rail.tsx:21`）**不加第二个入口**；子页面靠第二列目录切换。
  10. **API 契约草案**（新增 3 个路由文件 / 5 个方法，其余复用现有接口）：
      - `GET /api/admin/users?query=&state=` → `{ items: [{ id, sub, displayName, email, roles: string[], state, lastSeenAt, createdAt }] }`
      - `PATCH /api/admin/users/[id]` body `{ roles?: string[], state?: "active" | "disabled", sub?: string }` → 移除或停用最后一个 active owner 时 422 `LAST_OWNER`；改 `sub` 仅 owner
      - `GET /api/admin/roles` → `{ items: [{ key, label, isSystem, permissions: string[] }] }`（权限目录随响应一起给，不单开接口）
      - `GET /api/admin/audit?from=&to=&actor=&action=&result=&cursor=` → `{ items, nextCursor }`（游标分页，不用 offset，避免边写边翻页重复）
      - **`GET /api/admin/audit/export` → CSV 流（未实现，仅设计稿）**：2026-11-13 核实，`src/app/api/admin/audit/` 下只有 `route.ts` 一个 `GET`（游标分页），没有导出路由。矩阵里 `audit:read` 的说明「查审计日志与导出」也只兑现了前半句；要做导出时按本节补路由，不要以为已有。
      - **复用**：`/admin/objects` 用现有 `GET /api/objects` 与批量动作；`/admin/system` 用现有运维数据与 `POST /api/sync/run`、`POST /api/parse/run`；词表用 ADR-016 已实现的 `/api/vocabulary/*`，只把 `adminGuard` 换成对应 `vocabulary:*:write`。
  11. **不引入 CASL 之类的判定库**（需求文档把这个问题留给架构决策）：13 项权限 × 4 个角色是一张二维常量表，`permissions.includes(key)` 已足够；CASL 的价值在「按资源属性判定」（如「只能删自己的对象」），而本项目 v1 没有条件式规则。引入依赖换来的是一个当前用不到的表达力，还要多一层与类型系统的耦合。**留出升级条件**：一旦出现字段级 / 归属级判定，再评估。

- **与 `12_REQUIREMENTS_V3.md` / `13_DESIGN_V3.md` 的对齐与差异**：
  - **已对齐**：4 角色 × 9 类能力的矩阵（本 ADR 只是把它拆成 13 个可判定的权限 key，逐格一致）；审计字段（含本 ADR 补上的 `result`）；`/admin` 页面清单与分组；`/admin/roles` v1 只读；`/admin/users` 不做邀请、不做删除；非管理员看不到第二列「管理」分组与新增入口。
  - **差异 1（路由写法）**：设计稿用 `/admin/vocab/formats`、`/admin/vocab/tags`，本 ADR 定为 `/admin/vocabulary/*`。理由是后端接口已是 `/api/vocabulary/*`，两边用同一个词；**页面拆成两页这一点与设计稿一致**。
  - **差异 2（谁来决定管理员）**：需求文档写「新增管理员 = 修改 `ADMIN_SUBS` 后重启」「真多用户属 v2，独立 ADR」。本 ADR 就是那份 ADR：管理员改由本地表 + 界面决定，`ADMIN_SUBS` 只在「一个 owner 都没有」时起作用。需求文档这两行需要 Product 回改。
  - **差异 3（需求文档内部矛盾）**：角色定义写「编辑 = 内容增删改」，权限矩阵写「删除内容 编辑 ❌」。本 ADR 以**矩阵**为准（更具体、可测），已在上面的矩阵约束里注明。
  - **CASL 问题已定**（需求文档留白）：不引入，理由见第 11 条。
  - 这三处差异**不改需求文档正文**——产品与设计文档的所有权在 Product / Designer，本 ADR 只登记分歧与结论。

- **备选方案与取舍**：

  | 方案 | 做法 | 取舍 |
  |------|------|------|
  | **A（采纳）** | 本地五表做授权，Logto 只做身份 | 判定与资源同库同事务；Logto 停机不影响授权；改动集中在 `authz.ts`；代价是本地表可能与 Logto 失配，用 `sub` 唯一 + 引导 + `repoint` 兜底 |
  | B | 直接用 Logto 的 roles / claims（Management API + M2M） | 单一真相、无需本地表；但要 M2M 密钥、自托管配置最重、token 缓存导致改角色不即时、Logto 停机即授权失效 |
  | C | 维持 `ADMIN_SUBS` 白名单 | 零改动；但满足不了「角色管理」，且 ADR-012 自己已把「换管理员要改 env 重启」列为限制 |
  | D（角色可自定义） | `roles` 表开放写入，任意增删角色与权限 | 最灵活；但 4 角色 × 13 权限 = 52 格可穷举测试，自定义角色后无法穷举，权限矩阵会变成持续回归风险。**v1 否决**，但表结构与 `role:write` 权限已预留升级路径 |
  | E | 每次登录从 Logto 同步角色到本地 | 兼顾两者；但需要 M2M + 冲突合并规则（本地改了、Logto 也改了听谁的），复杂度不换收益 |

- **影响**：
  - **新增表 6 张**：`users` / `roles` / `permissions` / `role_permissions` / `user_roles` / `audit_events`。
  - `src/server/ports/session.ts`：`Session` 增加 `userId: string | null` 与 `permissions: string[]`；`isAdmin` 保留但**降级为 UI 便利标记**（= 拥有 owner 或 admin 角色），授权一律不看它。
  - `src/server/roles.ts`：`computeIsAdmin` 保留为纯函数，但只用于引导判定与 mock；`parseAdminSubs` 语义改为引导白名单。
  - `src/server/http/guard.ts`：`adminGuard` 改为 `requirePermission` 的薄封装，现有 8 个词表写接口与 `POST /api/sync/run`、`POST /api/parse/run` 各改一行。
  - `src/app/admin/page.tsx` 改为总览，并拆出 7 个子页面（`objects` / `vocabulary/formats` / `vocabulary/tags` / `users` / `roles` / `system` / `audit`）；`src/components/directory.tsx:212` 的 `AdminDirectory` 重写为分组链接，并按设计稿出现在四个模块的第二列。
  - 新增 `src/server/authz.ts`、`src/server/services/user-service.ts`、`src/server/services/audit-service.ts`、`src/components/admin-users.tsx`。
  - `.env.example:55` 的 `ADMIN_SUBS` 注释改写为「引导用 owner 白名单；已有 owner 后不再生效」。
  - **测试**：现有 25 文件 / 259 项不受影响（`computeIsAdmin` 的纯函数测试保留）；新增 `authz`（矩阵 52 格 + 边界）、`route-guard`（全路由覆盖）、`audit`、`user-service`（最后一个 owner 保护）约 4 个文件 / 40 项；改 `session` 相关 fixture 3 处。

- **验收要点**：
  1. 全新数据库首次登录（`sub` 在 `ADMIN_SUBS` 里）→ 自动成为 owner，`/admin/users` 能看到自己一条记录，审计里有一条 `user.bootstrap`。
  2. 把 `ADMIN_SUBS` 清空后重启 → 依然能进后台（引导已关闭，授权来自表），证明环境变量不再是授权源。
  3. 把唯一 owner 改成 admin → 422 `LAST_OWNER`，且事务回滚后仍是 owner。
  4. 以 viewer 身份调用 `POST /api/objects`、`DELETE /api/objects/{id}`、`POST /api/vocabulary/tags` → 全部 403；而 `GET /api/objects` 正常。
  5. 以 editor 身份：新建 / 编辑 / 归档对象成功；`DELETE /api/objects/{id}`、`POST /api/vocabulary/tags`、`POST /api/vocabulary/formats` 全部 403；列表页批量条**不出现**（因为缺 `object:delete` 与 `object:export`）。
  6. 非管理员访问 `/admin/objects` 直链 → 403 说明页；第二列「词表」「账号」两组不渲染。
  7. `route-guard` 测试通过：`src/app/api/**/route.ts` 全部有判定或已白名单登记。
  8. 删除一个对象 → `audit_events` 恰好新增 1 行，`actor_sub` 与操作者一致；把该用户从 `users` 删除后，这行审计仍可读。
  9. 以 editor 身份尝试删除 → `audit_events` 多一条 `result='denied'`。
  10. `npm test` 全绿（基线 25 文件 / 259 项），新增测试 ≥ 35 项。

- **风险**：

  | # | 风险 | 触发点 | 应对 |
  |---|------|--------|------|
  | A1 | **升级后没人能进后台**：表里没有用户，而 `ADMIN_SUBS` 恰好为空 | 第 7 条引导 | 启动时若 active owner 数为 0 且 `ADMIN_SUBS` 为空 → 日志与 `/api/health` 明确报错「无可用管理员」；`npm run admin:grant` 兜底 |
  | A2 | **最后一个 owner 被移除 → 死锁** | `/admin/users` 改角色 | 服务层在事务内 `count` 检查，SQLite 没有断言能力，只能靠这一处；配套 422 文案与测试 |
  | A3 | **`sub` 变更（重建 Logto / 换 IdP）→ 本地用户全部失联** | Logto 侧操作 | `users.sub` 可改，提供 `PATCH /api/admin/users/[id]` 的 `sub` 字段（仅 owner），审计保留旧 `sub` 快照 |
  | A4 | **审计写失败导致业务回滚**，用户看到「保存不了」却不知道原因 | 第 8 条同事务 | 审计失败必须是独立、可读的错误码（`AUDIT_FAILED`），不能混成 `INTERNAL`；面板上要能看出是审计表问题 |
  | A5 | **权限判定放 route 层，将来引入 Server Action 会漏** | 后续开发 | `route-guard` 测试同时扫 `"use server"`；这条测试是新权限的准入门槛 |
  | A6 | **`AUTH_MODE=mock` 被当成生产部署**，人人都是 owner | 环境配置 | `/api/health` 暴露 `authMode`；启动日志显眼警告；生产缺省已是 `disabled`（`session.ts` 已有逻辑） |
  | A7 | **角色 / 权限表与代码常量漂移**（代码加了权限，迁移没灌） | 后续加权限 | 一致性测试：`PERMISSIONS` 常量 ⊆ `permissions` 表，缺一项即失败 |

- **影响范围**：00_SCOPE、01_ARCHITECTURE、02_PHASES、05_CHANGELOG、06_API、09_USER_GUIDE、10_BACKLOG

---

## ADR-020：深空视觉主题与 Three.js 星系首页（Phase 5）

- **状态**：已实施（2026-11-12）。**取代 ADR-018 第 6~8 条**（星图技术、降级链、粒子与 DPR 上限）：ADR-018 的页面定位、抽屉、搜索链路、`nav-items` 单一来源全部作废与否之外照旧。ADR-017 的多主题机制保留，本期只改 token 取值，不新增第二套主题开关。**（2026-11-12 补注）第 8 条的「全局单一深空 token」已由 ADR-021 修订：恢复四套主题、默认 `galaxy`。**

- **背景**：使用者本轮要求「实现高质量的首页全屏背景 + 建立与首页统一的全局视觉主题」，并给出四条硬要求：深空纯黑 / 明亮黄白核心过渡到暖橙与淡金 / 旋臂用尘埃棕、灰紫、暗紫 / 安静、有科幻感、高级感、低饱和、不要霓虹。现状的问题是：
  - 首页星系是 Canvas 2D 手写（ADR-018），本质是一张点阵星图：没有盘面倾斜、没有核球体积感，旋臂靠 2D 轨迹画出，放大看是平的，撑不起「全屏背景」。
  - 主题是浅色白底 + 品牌绿（ADR-017 第 1 批）。首页深空、其余页面浅色，从首页点进工作台会有一次「从宇宙掉回白纸」的跳变，两者不是一套视觉语言。
  - 参考图 `docs/reference/galaxy-reference.png` 右下角有第三方水印，**不能进产品资源**，静态降级图必须由本项目自己的场景渲染。
  - 项目零 UI 框架、图标全手写 SVG，本期不引入任何 UI 组件库；唯一新增运行时依赖是 `three`。

- **决策**：
  1. **首页背景改为 Three.js 3D 星系**：`three@0.187.0` + 自定义 `ShaderMaterial` 点精灵（additive 混合、按距离衰减尺寸、每粒子随机相位闪烁）。五层粒子——旋臂、核球、盘面雾光、暗尘带（正常混合，压在旋臂上刻出尘带）、背景星场——外加两层 billboard 辉光与一张盘面椭圆柔光。每层的预算、颜色、透明度都在配置里，不散落在着色器里。外缘的灰紫 / 暗紫在加法混合下最易过曝成白点，按半径 `smoothstep(0.68, 1.05)` 压掉 42% 亮度，保住「尘埃」而不是「霓虹」（首版截图中外圈是一片紫白亮点，与本条要求不符）。
  2. **场景层级固定为 `pivot → root → tilt → spin`**：`pivot` 承担鼠标视差与呼吸浮动，`root` 承担屏幕倾角 / 构图偏移 / 缩放，`tilt` 负责盘面绕 X 轴倾斜（64°，近侧视），`spin` 只做自转。这样改构图不会碰到运动，改运动不会碰到构图。
  3. **参数单一来源 `src/lib/galaxy-config.ts`**：配色取样、相机、构图（桌面 / 移动两套）、亮度、视差、呼吸、闪烁、尘埃透明度、画质两档预算、DPR 上限、帧率上限、静态图路径与尺寸、统计窗口全在这里。组件、着色器、CSS 不写裸数值。
  4. **运动**：自转一周 90 秒（配置项，需求区间 60–120，`rotation.periodSeconds`）；呼吸 26 秒 ±0.32°；旋臂闪烁 0.18、背景星 0.45，速度 0.9；鼠标视差最大 1.4°、阻尼半衰期 520ms（触屏忽略 `pointermove`，不做设备方向监听）。
  5. **降级链三段**：`webgl` → `poster`（本项目自己渲染的 JPG）→ `fallback`（CSS 星点 + 单层暖金星云）。WebGL 探针失败、上下文创建抛错、`?still=1`、`prefers-reduced-motion: reduce` 全部不建场景、不启 rAF；静态图加载失败时 CSS 星点层兜底，任何一段坏掉都有画面。
  6. **静态图必须由本项目场景渲染**：新增截图路由 `/galaxy/poster` 与 `scripts/phase5-capture.mjs poster`，在无头 Chrome 里以 1920×1080 / 1170×2532 渲染同一套场景后截帧、转 JPG（≤400KB）。**禁止使用参考图**（水印）；禁用文字、水印、任何 UI 元素。
  7. **性能上限**：DPR 上限桌面 2、移动 / 低性能档 1.5；帧率上限桌面 60、受约束档 30；`document.hidden` 立即 `cancelAnimationFrame` 并置 `paused`，`visibilitychange` 恢复后重启；`prefers-reduced-motion` 下零 rAF（验收读数是 `rafCalls = 0`）。粒子预算 high 46300、balanced 17560。
  8. **全局主题重写 `:root`，但沿用旧变量名**：三档文字（`--text-1/2/3`）、五级表面（`--void-deep/--void/--paper/--surface/--surface-2/--surface-3`）、`--line*`、`--hover`；品牌绿整套换成暖金 `--gold-*`，并用 `--green-*` 保留为**别名**指向金阶，避免 107 处引用一次性全改导致半深半浅（ADR-017 R5 的教训）。映射表见本节末。
  9. **`[data-surface="cosmic"]` 重建**：从旧版青紫霓虹改为暖金 + 尘埃棕 + 灰紫，`--galaxy-from/--galaxy-to` 指向暖白金；删掉旧的星云光斑与核心辉光两层 DOM（改由 WebGL 承担），只保留 `.galaxy-poster / .galaxy-canvas / .galaxy-fallback-stars` 三层。
  10. **可访问性与克制**：正文级文字对所属表面 ≥4.5:1、大字号与图标 ≥3:1，由 `scripts/check-contrast.mjs`（`npm run check:contrast`）从 `:root` 实际取值计算，注释里的数字必须与实测一致；焦点环统一暖金 `--focus`；hover 只做描边 / 底色 / 阴影的轻微变化，不做位移与放大。
  11. **子页面只做「深空 + 微量星点」**：`body` 用固定渐变给出单层星点与一层极淡暖金 / 灰紫光晕，**不引入任何 WebGL、不放动画**（工作台、检索、图谱、后台、登录同一套）。首页之外的页面不允许再出现第二套背景语言。
  12. **纯函数层与运行时契约**：螺旋几何、配色采样、旋转角、视差阻尼、构图换算、画质分档、降级判定、首页搜索提交全在 `src/lib/galaxy.ts`，由 `tests/lib/galaxy.test.ts` 覆盖；运行时把 `mode / tier / particles / dpr / fpsCap / frames / avgFrameMs / firstFrameMs / firstFrameWallMs / rafActive / paused / rotationPeriodSeconds` 写进 `window.__galaxyStats`，验收脚本只读它，不去猜 DOM。
  13. **业务零改动**：首页的搜索提交、抽屉开合、登录态分支、`nav-items` 来源一律不动；本期只改视觉层与背景层，不碰接口、不碰数据库。

- **备选方案与取舍**：

  | 方案 | 做法 | 取舍 |
  |------|------|------|
  | **A（采纳，技术）** | three.js + 自定义点精灵着色器 | 真正有纵深、盘面倾斜与核球体积；代价是约 600KB 未压缩 / 约 160KB gzip 的依赖、必须有降级链 |
  | B（技术） | 继续 Canvas 2D，加伪 3D 投影 | 体积最小，但做不出尘埃带遮挡与核球辉光的层次，放大即露馅 |
  | C（技术） | CSS 3D / WebGL 库（babylon、regl） | 前者做不了十万级粒子，后者要自己写整套几何管线，收益不明显 |
  | **A（采纳，配置）** | 单一 `galaxy-config.ts` | 调参一处生效；代价是配置对象偏大，需靠类型约束防止漏项 |
  | **A（采纳，降级）** | WebGL → 自渲染静态图 → CSS 星点 | 三段都有画面，最差也是一张好看的静态星系 |
  | B（降级） | WebGL 失败直接 CSS 星点 | 省一张图，但用户看到的是「坏了」而不是「静止的星系」 |
  | **A（采纳，主题）** | 旧变量名 + 值替换 + 金阶别名 | 一次改完所有页面，不改 107 处引用；代价是 `--green-*` 名不副实，必须靠本条 ADR 与注释解释 |
  | B（主题） | 全量重命名为 `--gold-*` 再逐页迁移 | 名字干净，但会经历一个长期「半深半浅」的过渡态，正是 ADR-017 R5 记录过的坑 |

- **影响**：
  - 新增：`src/lib/galaxy-config.ts`、`src/lib/galaxy-three.ts`、`src/app/galaxy/poster/page.tsx`、`public/galaxy/galaxy-1920x1080.jpg`（177KB）、`public/galaxy/galaxy-1170x2532.jpg`（125KB）、`scripts/phase5-capture.mjs`、`scripts/check-contrast.mjs`、`docs/screenshots/phase5-*`。
  - 重写：`src/components/galaxy-scene.tsx`（Canvas 2D → Three.js 生命周期 + 三段降级 + `__galaxyStats`）、`src/app/globals.css` 的 `:root` 与 `[data-surface="cosmic"]` 段。
  - 小改：`src/components/galaxy-home.tsx`（只删掉三个纯视觉 div）、`src/components/content-editor.module.css`、`src/components/vocabulary-manager.module.css`（硬编码浅色描边）、`next.config.ts`（`devIndicators: false` + `distDir` 可覆盖）。
  - 依赖：`three@0.187.0` + `@types/three@0.187.0`（唯一新增运行时依赖）。
  - 测试：`tests/lib/galaxy.test.ts` 随 3D 实现重写（23 → 38 项），全量基线 31 个文件 374 项 → 392 项；`npm run check:contrast` 校验 28 组配色。
  - 文档：本 ADR、`02_PHASES.md` Phase 5、`05_CHANGELOG.md`、`09_USER_GUIDE.md`（视觉说明）。

- **`--green-*` → 暖金映射**：

  | 旧变量 | 新值 | 语义 |
  |--------|------|------|
  | `--green-900` | `#08070d` | 品牌最暗面（原深绿） |
  | `--green-800` | `#0b0912` | 侧栏底 / 深底块 |
  | `--green-700` | `#f0d0a2`（= `--gold-600`） | 旧 hover / 深底上的强调文字 |
  | `--green-600` | `#e9c08a`（= `--gold-500`） | 品牌主色 |
  | `--green-300` | `#c79e68`（= `--gold-300`） | 深底图标 / 指示条 |
  | `--green-100` | `#201a12`（= `--gold-100`） | 浅底块（现在是深底上的金调块） |
  | `--green-050` | `#16110b`（= `--gold-050`） | 更浅的块底 |
  | `--green` / `--green-dark` / `--green-soft` | 分别指向 600 / 700 / 100 | 兼容别名 |

- **验收要点**：
  1. `npm run lint`、`npm run typecheck`、`npm test`、`npm run check:contrast` 全绿；既有 374 项不回归（现 392 项）。
  2. 首页 1440×900 / 390×844 首帧 <150ms（软件渲染下实测 29.9ms / 18.9ms），平均帧耗时 <3ms，无横向溢出、无滚动条。
  3. `prefers-reduced-motion: reduce`：`mode = poster`、`rafCalls = 0`、静态图可见。
  4. 切走标签页 700ms 内帧数不增长、`rafActive = false`、`paused = true`。
  5. 禁用 WebGL：`mode = fallback`、1920×1080 静态图可见、canvas 透明度 0。
  6. 首页以外的页面（工作台 / 详情 / 编辑 / 检索 / 图谱 / 后台 / 登录）同属深空主题，5 页抽查无 console 错误。

- **风险**：
  | # | 风险 | 触发点 | 应对 |
  |---|------|--------|------|
  | A1 | **`three` 让首包变大**，弱网首屏变慢 | 第 1 条 | 动态 `import()` + 静态图先上屏；主包不含 three，首屏文字与搜索框不等它 |
  | A2 | **软件渲染 / 远程桌面下帧耗时暴涨** | 第 7 条 | 两档预算 + 帧率上限 + DPR 上限；验收在 SwiftShader 下跑，读数留档 |
  | A3 | **静态图与实时画面构图不一致**（改了配置忘了重出图） | 第 6 条 | 出图与截图共用同一脚本，改完构图必须重跑 `poster`；两张图尺寸固定 1920×1080 / 1170×2532 |
  | A4 | **误用参考图**（含第三方水印） | 第 6 条 | `public/galaxy` 只放本脚本产物；参考图留在 `docs/reference/` 且不被打包 |
  | A5 | **`--green-*` 名不副实**，后来者以为它真是绿色 | 第 8 条 | 本 ADR 的映射表 + `:root` 注释；新代码一律用 `--gold-*` |
  | A6 | **子页面偷偷加了 WebGL / 动画**，把首页的重量摊到全站 | 第 11 条 | 除 `/` 与 `/galaxy/poster` 外不 import `galaxy-three`；验收脚本按页面统计 canvas 数量与 rAF |

- **影响范围**：01_ARCHITECTURE、02_PHASES、05_CHANGELOG、09_USER_GUIDE

- **状态变更**：全局单主题部分由 ADR-021 修订（2026-11-12）。
- **状态变更（2026-11-12，ADR-022）**：第 11 条「子页面零 WebGL」修订为「除 `/graph` 外零 WebGL」；风险 A6 的验收口径同步放宽到允许 `/graph` 一个 canvas 与按需 rAF。

---

## ADR-021：多主题恢复与默认主题决策（Phase 5 返工）

- **状态**：已采纳；**下列各件均已实施并通过**：token 层、切换器、首帧内联脚本、`scripts/check-theme.mjs`（E1–E8，`npm run check:theme` 绿）、旧键 `theme` → `pakp.theme` 防御式兼容（仓库历史中旧键从未被写入，无数据要迁移）、`THEME_META.swatch` 去色值（2026-11-13 复核）。修订 ADR-020 第 8 条（全局单主题 token）；恢复 ADR-017 的 `[data-theme]` 机制并改写其 token 名单口径。首页星系部分（ADR-020 第 1~7、9~13 条）不受影响。
- **修订记录（2026-11-12，实施后对表）**：第 3、4、5、7 条按 `src/app/globals.css` 实测重写——契约由「85 名」更正为「**129 名 = 98 主题 + 31 几何**」，**撤销「不再引入 `--bg` / `--accent*`」「ADR-017 语义层作废」**，并补入 `scripts/check-theme.mjs` 的可实施规范。触发原因：实现落地的四个主题块与本节旧文本直接冲突，且旧数字是人工统计的漏计。

- **背景**：使用者对 Phase 5 提出返工，原话是「我没有看到可以切换主题的地方，我之前的主题也被删掉了」。事实核对后，这不是一次视觉偏好调整，而是**两件事叠加**：
  1. **多主题机制从未落地，不是被实现后又删掉**。全仓 `data-theme` 命中 **0**；`src/app/layout.tsx` 没有首帧内联脚本；`src/components/` 下没有 `ThemeToggle` / `theme-menu`，`src/lib/` 下没有 `theme.ts`；`tests/lib/` 里没有任何主题测试。ADR-017 只留下了名字，机制一行没写。设计稿 §3 定义的 4 套主题（`pine` 松林绿 / `galaxy` 深空银河 / `sand` 暖沙 / `midnight` 午夜蓝）也从未进入代码。**（2026-11-12 复核：以上是返工前的状态；机制现已由 `theme.ts` + `theme-switcher.tsx` + `layout.tsx` 内联脚本落地，本段保留为历史背景。）**
  2. **唯一存在的主题被换掉了**。Phase 5 把 `:root` 整体重写为深空暖金（ADR-020 第 8 条），`--green-*` 降为金阶别名。改版前的观感（`#eef1ec` 纸底 + `#2f7657` 品牌绿）在代码里已无对应，所以用户说「我之前的主题被删掉了」是准确的。
  3. **更棘手的是：三套 token 词汇同时存在，而且没有一套是完整的。** 这是本次返工最大的隐性成本：
     - ADR-017 第 2 条冻结的语义层（`--bg`、`--accent`、`--accent-hover`、`--accent-soft`、`--accent-fg`、`--overlay`）：实测 `var(--accent` 命中 **0**，第 1 批迁移（118 处 `--green-*` → `--accent*`）从未执行。**（2026-11-12：这批名字已落地并成为 L2 权威名，`--accent-fg` → `--accent-contrast`、`--overlay` → `--dialog-backdrop`；`--green-*` 引用现为 152 处。）**
     - 设计稿 §3.1/§3.2 的 token 表（`--nav`、`--accent-text`、`--accent-strong`、`--accent-contrast`、`--accent-050`、`--accent-soft`）：名字与上一条**不同**，也从未落地。
     - Phase 5 实际写进 `:root` 的一套：`--gold-*`（7）、`--void*`（2）、`--surface-3`、`--line-strong`、`--hairline`、`--hover`、`--glass*`（2）、`--on-gold`、`--danger-solid*`（2）、`--on-danger`。
     若只写一句「恢复四套主题」，实现者按哪一份名单写都会漏；漏掉的名字在切换后要么继承上一主题的值，要么落成 `unset`——这就是「半深半浅」的来源，而且它是逐页出现的，验收时不看那一页就发现不了。
  4. 设计稿有两处与 Phase 5 现状直接冲突，必须一并裁决：§3.2 的「深空银河」列是 `#070b14` 底 + `#22b8d9` 青色强调，与已上线的**暖金深空**不是同一套视觉；§3.5「首次访问默认 `pine`」写于 Phase 5 之前，与本次返工口径相反。

- **决策**：
  1. **四套主题，id 固定为 `pine | galaxy | sand | midnight`**，切换 = `document.documentElement.dataset.theme = <id>`，与 ADR-017 同机制。取值来源按主题分别钉死（见下表），不允许「大概照着设计稿调」。
  2. **默认主题 `galaxy`**。无 `localStorage`、读到非法值、脚本未执行（无 JS）时一律 galaxy，**不跟随 `prefers-color-scheme`**。理由见备选方案 A/B/C。
  3. **`galaxy` 与 Phase 5 的视觉逐字相等**：把 Phase 5 的 `:root` 里那批随主题变化的变量原样搬进 `:root, [data-theme="galaxy"]` 块（实测 **98 个**），上线时视觉零变化。这与 ADR-017 第 3 条是同一手法，只是这次「零变化」的对象是深空，而不是松林绿。
  4. **`pine` 与 Phase 5 之前的 `:root` 逐字相等**。精确口径（2026-11-12 实测；数字由 `npm run check:theme` 打印，文档不手抄）：
     - 旧 `:root`（`git show HEAD:src/app/globals.css`）**64 个**名字；现契约 **129 个 = 31 几何 + 98 主题**。98 个主题名里 **36 个与旧 `:root` 同名**（pine 逐条回填旧值），**62 个是 Phase 5 起新增**（pine 必须补浅色值，不回填就是「半深半浅」）。
     - **31 个几何档位**（字号 9、行高 3、字重 3、间距 12、圆角 4）不随主题变，只留在 `:root` 基础层，四套主题天然一致。**设计稿 §3.2 让 `--r-md/--r-lg` 随主题变化的做法本期不采纳**：换肤只换颜色与 `color-scheme`，不动几何档位，否则每个组件要在 4 套圆角下各验一遍，收益远小于成本。
     - 下方补值表只列 62 个新名里**最易漏、漏了立刻穿帮**的 19 个颜色与状态色；其余 43 个（玻璃、阴影、滚动条、头像、徽标、轨道线、页面底渐变等）的浅色值同样必须在 pine 块内给出，以 `globals.css` 的 pine 块为现状基准、以第 5 条「四块集合相等」为硬约束。
     - **旧表述作废**：本节早先写「现 `:root` 有 85 个、共有 63、新增 22、删去 `--sidebar`」，是人工统计的漏计——`--ok-bg: …; --ok-fg: …` 这类**一行两声明只算了一个**，且未计入把规则区字面量提成 token 的那批名字；`--sidebar` 实际保留为别名（实测 0 引用）。
  5. **token 契约 = 三层、共 129 名，冻结**（2026-11-12 按实现实测重写。**旧表述「85 名」「不再引入 `--bg` / `--accent*`」「ADR-017 语义层作废」全部撤销**，理由见下方四条）：

     | 层 | 数量 | 内容 | 位置与约束 |
     |---|------|------|-----------|
     | **L1 几何** | 31 | `--fs-*` 9、`--lh-*` 3、`--fw-*` 3、`--sp-*` 12、`--r-*` 4 | 只在 `:root`；**不得出现在主题块** |
     | **L2 主题语义** | 91 | 表面栈（`--bg`、`--void-deep`、`--void`、`--paper`、`--surface`、`--surface-1..3`、`--nav`、`--glass`、`--glass-blur`）、文字（`--text-*` 5）、描边（`--line`、`--line-soft`、`--line-strong`、`--hairline`、`--hover`）、强调（`--accent`、`--accent-text`、`--accent-strong`、`--accent-contrast`、`--accent-hover`、`--accent-soft`、`--accent-050`）、色阶（`--green-*` 7、`--gold-*` 6、`--on-gold`）、状态色 12、阴影 5、页面底 4、其余语义件 | 四个主题块；**每块 98 个，集合严格相等** |
     | **L3 兼容别名** | 7 | `--ink`、`--muted`、`--white`、`--green`、`--green-dark`、`--green-soft`、`--sidebar` | 主题块末尾，只允许 `var()` 指回 L2，不得写色值 |
     | **主题层合计** | **98** | L2 91 + L3 7，即四个主题块各 98 个名字；再加 L1 31 = **129** | 集合相等以 98 为准（L3 也算在内，否则 `check-theme` 的差分口径会和总数对不上） |

     **为什么把 `--accent*` 纳入契约（撤销旧结论，四条理由全部来自实测）**：
     1. **它们与 `--gold-*` / `--green-*` 不是同一批色的两套名字**。galaxy 与 pine 下 `--accent` 与 `--gold-500` 恰好同值，但 **sand 的 `--accent-text`（#8a4a22）比 `--accent`（#a45a2a）深一档**；**midnight 三档分离**：`--accent` #2563eb（填充）、`--accent-text` #7cb6ff（深底上的强调文字）、`--accent-hover` #1d4ed8（压暗）。压成一个名字等于抹掉「填充色」与「填充上的文字」的区别，`check:contrast` 里 `--accent-contrast on --accent` / `--accent-contrast on --accent-hover` 两组会同步失真。
     2. **依赖方向与旧结论相反**。实现里是 `--green-600: var(--accent-text)`、`--green-700: var(--accent-strong)`——`--accent*` 才是值源，`--green-*` 是别名。按旧结论让 `--green-*` 当权威名，要把四个块的依赖全部反转，且在 galaxy 下得到「金值挂在绿名下」，正是风险 B9。
     3. **代价不对等**。改回旧口径需动 4 块 × 11 个声明 + 89 处 `var()` 引用，并重跑刚通过的 4 × 23 组对比度；收益为零（渲染结果一个字节都不变）。
     4. **与设计稿本来一致**。`13_DESIGN_V3.md` §3.3 第 1 条把 `--bg`、`--accent-text`、`--accent-strong`、`--accent-contrast`、`--accent-050` 直接列为「语义层（新增）」——分叉的是旧 ADR 文本，不是实现。

     **权威名与迁移边界**：新代码只写 L2。`--green-*`（实测 152 处引用）与 `--gold-*`（9 处）**冻结、不再新增**，重命名仍归 ADR-017 第 1 批单独立项（目标名改为「L2 语义名」）。`--gold-*` 是历史名，**midnight 下它取蓝值**，任何人不得据名取义。

     **唯一真相源规则（可机检）**：四套主题下取值完全相等的两个名字视为重复表达，只允许出现在登记表。当前登记 **2 组**：`--surface-1 ≡ --white`（都是 `var(--surface)`）、`--on-gold ≡ --accent-contrast`。出现第三组即 `check:theme` 失败，必须先裁定谁是权威名、另一个改成 `var(...)`。
  6. **`color-scheme` 进主题层**。现在 `html { color-scheme: dark }` 是写死的（`globals.css:114`），pine 下原生 `<select>`、滚动条、自动填充、日期选择器会全部保持深色——这是「半深半浅」里最难查的一类。改为每个主题块声明自己的 `color-scheme: light | dark`。
  7. **子页面底色进主题层**。子页面的星尘底原先硬编码在 `body` 的 `background-image`（5 层渐变 + 字面量色值），实现时拆成 **4 个 token**：`--app-bg-color` / `--app-bg-image` / `--app-bg-repeat` / `--app-bg-size`。分写不是啰嗦：pine / sand 要同时满足 `background-image: none` 与 `background-color: var(--bg)`，合成一个 `background` 简写就做不到。`body` 规则本身只剩 `var()`。**ADR 原文写的单个 `--page-backdrop` 未采用**，以这四个名字为准。
  8. **首页固定深空银河，不随 `[data-theme]` 变**。`<main class="galaxy-home" data-surface="cosmic">` + `--cosmic-*` 已在位，实测星系段（`globals.css:4839` 起）对主题 token 的引用为 **0**，继续守住这条边界。首页上的**主题切换按钮本身**归 cosmic 块（用 `--cosmic-glass*` 样式），切换结果作用于离开首页后的页面与切换器的选中态；首页背景、文字、搜索框一律不变。这条与设计稿 §5「首页固定深空银河，不随工作台主题切换」一致。
  9. **切换入口两处、组件唯一**：`src/components/theme-switcher.tsx`（实现名；本文早先写的 `theme-menu.tsx` 未采用）同时被左侧图标栏的账号区菜单（`nav-rail.tsx`）与首页头像菜单（`galaxy-home.tsx`）消费；选项来源 `src/lib/theme.ts`（id、中文名、顺序），**色点颜色只来自 CSS**（`.theme-swatch[data-theme-id="pine"]`），不在 TS 里写第二份色值——两份色值就是两份真值。（**2026-11-13 复核：已满足**——`theme.ts` 零 `#hex`，色点改由 `.theme-option-dots` 的 `data-theme` 子树取色，见风险 B11 与规范 E8。）菜单项必须是用户菜单的**一级可见项**并显示当前主题名，不塞进二级「设置」：用户这次的问题就是「找不到入口」。
  10. **持久化 `localStorage["pakp.theme"]` + 首帧内联脚本**（键名与值域按设计稿 §3.5）。读取顺序：`pakp.theme` → 旧键 `theme`（ADR-017 文本口径）→ 默认 `galaxy`；命中旧键时写回新键并删除旧键，避免出现「明明设置过却没生效」的第二轮困惑（**2026-11-13 复核：已按防御式兼容实现**——`LEGACY_THEME_STORAGE_KEY` 与首帧脚本由同一份常量生成，命中旧键时写回新键并删除旧键。注意：`git rev-list --all` 的 39 个提交里旧键从未被写入过，**没有真实数据要迁移**，这段兼容只是防止别的分支或早期手工设置留下残值）。脚本同步执行、放在 `<head>` 里 CSS 之前、`try/catch` + 白名单校验（非法值回落 `galaxy`），`<html suppressHydrationWarning>` 已存在可容纳属性差异。不做 cookie、不做服务端读取（沿用「待对齐项」第 6 条的裁决）。
  11. **切换纯前端、不刷新**：`setTheme(id)` 只改 `data-theme` 与 `localStorage`；监听 `storage` 事件做跨标签页同步（双开工作台时不会一边深一边浅）。内联脚本是字符串，必须与 `src/lib/theme.ts` 共用同一份白名单常量（生成或断言），否则会出现「脚本认 pine、运行时认 galaxy」这类无法靠肉眼发现的漂移。
  12. **未登录访客没有切换入口**（首页未登录态与登录页只有品牌叙事与登录按钮）。默认即品牌观感，属可接受留白；若后续要补，只在登录页右下角加一个无文字的紧凑切换器，不进登录表单。

- **四套主题的取值来源（唯一口径）**：

  | 主题 | 取值来源 | 验收口径 |
  |------|----------|----------|
  | `pine` | `git show HEAD:src/app/globals.css` 的 `:root`：**36 个同名逐条回填旧值 + 62 个新名补浅色值**（下方补值表只列其中最易漏的 19 个） | 与 Phase 5 之前的截图基线**逐像素一致** |
  | `galaxy` | Phase 5 的 `:root` 原样搬入（**98 个主题变量**） | 与已上线版本**逐像素一致** |
  | `sand` | 设计稿 §3.2「暖沙」列的颜色值，落到现有变量名上；圆角列不采用 | 4 × 23 组对比度达标 |
  | `midnight` | 设计稿 §3.2「午夜蓝」列，同上 | 同上 |

  > 设计稿 §3.2 的「深空银河」列（`#070b14` / `#22b8d9`）**作废**，以 Phase 5 已上线的暖金深空为准；该列与 §3.5「首次访问默认 pine」两处由 Designer 同步改写 `13_DESIGN_V3.md`，结论以本 ADR 为准。

- **`pine` 必须补齐的 19 个 Phase 5 新增名字**（不回填即「半深半浅」）：

  | 变量 | pine 取值 | 理由 |
  |------|-----------|------|
  | `--void-deep` | `#eef1ec` | 浅色没有「更深的一层」，最底层就是页面底 |
  | `--void` | `#eef1ec` | 同上 |
  | `--surface-1` | `var(--surface)` | 兼容别名 |
  | `--surface-3` | `#edf1ed` | 悬浮 / 选中块；浅色语境下用「更深」表示抬起 |
  | `--line-strong` | `#b9c6be` | 设计稿 §3.1 已给定，用于需要 3:1 的控件边界 |
  | `--hairline` | `rgba(23, 37, 31, .10)` | 与旧阴影同色相的低透明度描边 |
  | `--hover` | `rgba(23, 37, 31, .05)` | 浅底悬浮 |
  | `--glass` | `rgba(255, 255, 255, .72)` | 旧体系无毛玻璃；浅色取白 |
  | `--glass-blur` | `14px` | 只影响模糊强度，与深色一致 |
  | `--gold-050` | `var(--green-050)` | 浅色下没有金阶，指回绿阶以防误用露金 |
  | `--gold-100` | `var(--green-100)` | 同上 |
  | `--gold-300` | `var(--green-300)` | 同上 |
  | `--gold-500` | `var(--green-600)` | 同上（品牌主色） |
  | `--gold-600` | `var(--green-700)` | 同上（hover 一档） |
  | `--gold-700` | `var(--green-700)` | 同上（旧体系无更亮一档，取 700） |
  | `--on-gold` | `#ffffff` | 品牌底上的文字色（对应旧注释「白字 5.45:1」） |
  | `--danger-solid` | `#a13d30` | = pine 的 `--danger-fg` |
  | `--danger-solid-hover` | `#8a3227` | = pine 的 `--danger-hover` |
  | `--on-danger` | `#ffffff` | 白字 6.5:1，与原注释一致 |

  > `--sp-14 / --sp-16 / --sp-20` 也是 Phase 5 新增，但属几何档位，留在 `:root` 基础层，四套主题共用。pine 下的 `--gold-* → var(--green-*)` 不会成环，因为 pine 块同时给出 `--green-*` 的旧字面值。

- **与 ADR-017 / ADR-020 的关系**：

  | 对象 | 处置 |
  |------|------|
  | ADR-017 第 2 条（语义层冻结为 `--bg` / `--accent*` / `--overlay`） | **部分恢复**：`--bg`、`--accent`、`--accent-hover`、`--accent-soft` 存活并成为 L2 权威名；`--accent-fg` 落地为 `--accent-contrast`，`--overlay` 落地为 `--dialog-backdrop`；冻结名单本身由本 ADR 第 5 条的 **129 名三层契约**取代 |
  | ADR-017 第 3 条（默认主题逐字等于旧 `:root`） | 机制保留，对象换成 `pine`；默认主题改为 `galaxy` |
  | ADR-017 第 4 条（内联脚本防闪 + `localStorage`） | **恢复生效**，键名改 `pakp.theme` |
  | ADR-017 第 5 条（全站一致 + 首页唯一例外） | 保留；例外仅限 `[data-surface="cosmic"]` |
  | ADR-017 第 6 条（分批 + `grep` 审计） | 审计保留；第 1 批（实测 **152 处** `--green-*`）与第 2 批（主题块与首页之外的规则区字面量，实测 **26 处** = 18 处真实颜色 + 8 处 `.galaxy-scene` 遮罩停靠点，全部在 `.galaxy-*` / `.theme-switch--home` 首页规则里）仍未执行，本期不做，单独立项 |
  | ADR-017 第 7 条（入口在导航栏账号区） | 保留并扩展到首页头像菜单（本 ADR 第 9 条） |
  | ADR-020 第 8 条（全局 `:root` 重写为深空 + `--green-*` 降为金阶别名） | **修订**：`:root` 只保留 31 个不变档位与 galaxy 值；`--green-*` 在 galaxy 下仍是金阶别名，但不再「全局」 |
  | ADR-020 第 1~7、9~13 条（Three.js 星系、构图、降级链、性能、可访问性、纯函数层、业务零改动） | **不受影响**，继续有效 |
  | ADR-018 第 6~8 条 | 仍由 ADR-020 取代，本 ADR 不改变 |

- **备选方案与取舍**：

  | 方案 | 做法 | 取舍 |
  |------|------|------|
  | **A（采纳）** | 恢复四套，默认 `galaxy` | 升级后看到的仍是深空暖金，想回浅色自己切；不制造「界面又变一次」的二次惊吓。代价是与设计稿 §3.5 相反，需 Designer 改稿 |
  | B | 默认 `pine`（设计稿原意） | 用户刚经历「主题被删」，再变一次浅色更像 bug；且 Phase 5 的首页与子页面视觉语言按深空调过，浅色默认会让首页与工作台的割裂更明显 |
  | C | 跟随 `prefers-color-scheme` | 看似最智能，但同一台机器会因系统设置突然变色，与「主题是用户选择」的语义冲突；且首帧脚本要读两个来源，防闪逻辑复杂一档 |
  | D | 只恢复 `pine` / `galaxy` 两套 | 少做两套验收。但设计稿与 mockup 已是四套，砍掉要改稿；更重要的是只有两套时很容易靠特例糊过去，四套才能把硬编码逼出来 |
  | E | 引入 `next-themes` | 仍否（ADR-017 备选 B）：20 行脚本能解决的事，换 1.5KB 依赖 + 一个状态库，收益不足 |

- **影响**：
  - 新增：`src/lib/theme.ts`（**已存在**：白名单、中文名、顺序、`pakp.theme`、`DEFAULT_THEME`、`normalizeTheme` / `readStoredTheme` / `applyTheme`；原计划的 `themes.ts` 与 `theme.ts` 合为一个文件，名字以 `theme.ts` 为准）、`src/components/theme-switcher.tsx`（**已存在**；替代原计划的 `theme-menu.tsx`）、`tests/lib/theme.test.ts`（**已存在**，10 项：默认值、非法值回落、白名单与内联脚本一致等）。
  - 修改：`src/app/globals.css`（**已完成**：`:root` 留 31 个几何档、`:root, [data-theme="galaxy"]` 与 `[data-theme="pine"|"sand"|"midnight"]` 各 98 个主题变量、`color-scheme` 进主题块、`body` 背景走 `--app-bg-*` 四个 token）、`src/app/layout.tsx`（**已完成**：`<head>` 内联 `THEME_BOOTSTRAP`，与 `src/lib/theme.ts` 共用常量）、`nav-rail.tsx` 与 `galaxy-home.tsx`（**已完成**：挂载同一 `theme-switcher.tsx`）。
  - 脚本：`scripts/check-contrast.mjs` 已从「`:root` 28 组」扩到「**4 主题 × 23 组 = 92 组**」（2026-11-12 实测 4 × 23/23 全绿）；`scripts/check-theme.mjs` **尚未创建**，规范见下一条。
  - 不改：数据模型、API、Three.js 星系与降级链、性能参数、首页业务逻辑。
  - 测试基线：ADR-020 记录为 31 文件 / 392 项；Phase 5b 后为 **32 文件 / 403 项**（含 `tests/lib/theme.test.ts` 10 项）；2026-11-13 现测 **38 文件 / 507 项**（Phase 6B 检索、Phase 6C `check-theme` 与旧键用例之后）。主题层本期是**从零新建**，没有既有测试可回归——这也是它当初能悄悄不落地的原因。

- **`scripts/check-theme.mjs` 实现规范（照此实现即可，无需再确认）**：

  1. **输入**：只读 `src/app/globals.css`；用 `path.resolve(import.meta.dirname, "..")` 定位（与 `check-contrast.mjs` 同款）。不读 TS，不读其它样式文件。
  2. **切块**：先 `replace(/\/\*[\s\S]*?\*\//g, "")` 去注释，再按「行首选择器 … `{` … 行首 `}`」切块。**必须同时认两种块头**：`^:root {`（基础层，31 个）与 `^:root,$` + 下一行 `^\[data-theme="galaxy"\] {`（主题层）。只按单选择器写正则会把 galaxy 块整块漏掉——`check-contrast.mjs` 的 `/:root,\s*\n\[data-theme="galaxy"\]\s*\{/` 就是正确写法，直接复用。
  3. **抓声明**：在整块文本上用 `/(--[\w-]+)\s*:\s*([^;]+);/g`，**允许一行多个声明**（`--ok-bg: …; --ok-fg: …` 这种成对写法是上一版数字数错的直接原因）。
  4. **判定，全部为硬失败**：
     - **E1 缺块**：四个主题块任一不存在 → 报「缺少 `[data-theme="<id>"]` 块」。
     - **E2 集合不等**：以 `galaxy` 的名字集合为基准，其余三块的 `missing` / `extra` 必须为空。**不做子集容忍**，不做「反正有兜底」的例外。
     - **E3 空值 / 非法值**：`--x:` 后为空，或值为 `unset` / `initial` / `inherit` → 失败。
     - **E4 层位错误**：L1 几何名（`--fs-` / `--lh-` / `--fw-` / `--sp-` / `--r-` 前缀）出现在主题块 → 失败；反之，非几何名出现在基础层（指**独立的** `^:root {` 块，不是 `:root, [data-theme="galaxy"]` 那个）→ 失败。
     - **E5 别名悬空**：块内 `var(--X)` 的 `X` 必须在本块可解析（本块定义，或 L1 几何名）→ 否则失败（典型：`--gold-500: var(--green-600)` 而该块没有 `--green-600`）。
     - **E6 重复表达**：四块取值完全相等的两个名字，只允许出现在登记表 `ALLOWED_DUPLICATES = [["--surface-1", "--white"], ["--on-gold", "--accent-contrast"]]`；出现第三组即失败（第 5 条的唯一真相源规则）。
     - **E7 字面量白名单**：`globals.css` 里**除四个主题块与 `[data-surface="cosmic"]` 块之外**的 `#[0-9a-fA-F]{3,8}` / `rgba?(` / `hsla?(` 命中数不得增加。当前实测 **26 处，全部在 `.galaxy-*` 与 `.theme-switch--home` 首页规则里，记为 `BASELINE = 26`，只允许减少**（2026-11-13 按 `npm run check:theme` 输出重算）。白名单按**选择器**给，不按行号（行号会漂）。
       - **26 的来历（可复核）**：`26 = 18 + 8`。其中 **8 处是 Phase 5c 边缘柔化的遮罩停靠点**——`globals.css:5330-5337` 给 `.galaxy-scene > .galaxy-poster` / `.galaxy-canvas` / `.galaxy-fallback-stars` 三层加同一条四周羽化遮罩，`-webkit-mask-image` 与 `mask-image` 各含 4 个 `#000`；**另有 2 处在 Phase 6C 被清掉**（`.theme-option-dots i` 的描边改 `color-mix(in srgb, var(--text-3) 45%, transparent)`，`.theme-switch-layer` 的移动端遮罩改 `color-mix(in srgb, var(--dialog-backdrop) 42%, transparent)`），所以非遮罩部分由 20 降到 **18**。ADR 初版的 20 测于柔化与这两处修复之前，**两个数字不能并存**。旁证：Phase 6C 迁移前的实测值是 **28 = 20 + 8**，清掉那两处后正好 26，与 ADR 的 20 相互印证。
       - **这 8 处不是颜色，是遮罩的 alpha 停靠点**：`mask-image` 只取 alpha 通道，`#000` 是「完全不透明」的惯用写法；换成主题令牌反而会让遮罩随主题变淡（浅色主题下蒙版直接失效）。所以**不许把这 8 个 `#000` 改成 `var(--…)`**，计入基线是度量口径的约定，不是配色债。守住基线的机制也不靠这个数字：E7 对**非白名单选择器**是无条件失败（不看数量），基线只约束 `.galaxy-*` 内部的新增，而这条遮罩规则是静态的、多一处就变 27 并失败。若将来 E7 改为跳过 `mask` / `-webkit-mask` / `mask-image` 声明，**同一次提交里基线必须降到 18**，不允许两套口径并存。
     - **E8 TS 侧零色值**：`src/lib/theme.ts` 不得出现 `#hex`（ADR 初版实测 16 处，即 `THEME_META.swatch` 的四主题色点；**2026-11-13 复核已归零**，色点改为 `.theme-option-dots` 的 `data-theme` 子树取色）。E8 已由 `main()` 读入 `theme.ts` 文本并断言，`npm run check:theme` 通过。
  5. **alias 怎么算**：E5 只判「名字能否在本块解析」，**不递归求值、不查环**——求值与环比对由 `check-contrast.mjs` 的 resolver（6 层上限）负责。两个脚本各管一件事，不重叠。
  6. **输出**：每块一行 `galaxy  98 tokens  PASS`；末行汇总 `129 名（31 几何 + 98 主题）· 4 块集合一致 · 0 失败`。**文档里的契约数字只从这里读**，不手抄。
  7. **退出码**：全通过 `0`；E1~E8 任一失败 `1`（与 `check-contrast.mjs` 一致）；脚本自身异常（文件读不到、一块都解析不出）`2`，把「校验不通过」与「脚本坏了」分开。
  8. **npm script**：`"check:theme": "node scripts/check-theme.mjs"`，与 `"check:contrast"` 并列。
  9. **接入位置**：本仓没有 `.github/workflows`，所以接入点是 `docs/07_PLAYBOOK.md` §5.1「提交前四条」扩为五条，`npm run check:theme` 放在 `npm test` 之前；并建议加一个 `"verify": "npm run check:theme && npm run check:contrast && npm run typecheck"` 供交付前一条命令跑完。**不把两个 check 塞进 `npm test`**：它们验的是 CSS 契约，不是单元行为，混进 vitest 会让「测试红」指向错误的地方。

- **验收要点**：
  1. `npm run check:theme` 绿：四个主题块的变量名集合与 `:root, [data-theme="galaxy"]` 块**严格相等（各 98 个）**；几何层 31 个只在 `:root`、不进主题块；别名无悬空；重复表达只有登记的 2 组。契约总数由脚本打印为 **129**，文档不另写一份。
  2. `npm run check:contrast` 覆盖 4 × 23 = 92 组全部达标；其中 **pine 的 23 组读数必须逐条等于**改版前的历史读数（这证明「逐字相等」不是口号）。
  3. 清空 `localStorage`、以及脚本不执行（无 JS）两种条件下，看到的都是 `galaxy`，且与已上线版本**像素一致**。
  4. 切到 `pine`，与 Phase 5 之前的截图基线**像素一致**（基线用 git 历史版本跑一次截图标定，不靠肉眼回忆）。
  5. 四主题 × 五页（`/`、`/workspace`、`/search`、`/admin`、`/login`）截图，任何一页不允许「一屏两套底色」；**`/` 在四主题下的截图像素完全一致**。
  6. 首屏无闪烁：四主题各强刷 10 次，首帧即目标色；`document.documentElement.dataset.theme` 在首次绘制前已设置。
  7. 主题菜单键盘可完整操作（Tab / 方向键 / Esc 回焦到头像），当前项有 `aria-checked`，刷新后保持。
  8. 双标签页切换后，另一页在一个 `storage` 事件内同步。
  9. `color-scheme` 正确：`pine` 下原生 `<select>`、滚动条、日期选择器为浅色。
  10. 字面量不增加：`grep -nE '#[0-9a-fA-F]{3,8}\b|rgba?\('` 的命中只允许出现在四个主题块、`[data-surface="cosmic"]` 块，以及首页组件规则 `.galaxy-*` / `.theme-switch--home`（实测基线：主题块外 **26 处**——其中 8 处是 `.galaxy-scene` 的遮罩停靠点、18 处是真实颜色；cosmic 块内 **28 处**。两者只允许减少，数字取自 `npm run check:theme` 末行，不手抄）；`src/lib/theme.ts` 的 `#hex` 归零（见规范 E8）。

- **风险**：
  | # | 风险 | 触发点 | 应对 |
  |---|------|--------|------|
  | B1 | **半深半浅**：漏定义一个主题变量，浅色页里出现深色卡片 | 第 5 条 | `check-theme.mjs` 集合差分，缺名即失败；验收 5 要求逐页截图 |
  | B2 | **「逐字等于旧 `:root`」被理解成只需 36 个同名回填**，62 个新名不补浅色值 | 第 4 条 | 补值表（19 个高风险名）+ 集合相等硬断言（98 个一个不能少）+ 验收 4（与历史版本对比截图） |
  | B3 | **浅色主题下对比度失守**：`--text-on-dark` 等深底文字被用到浅底 | 第 5 条 | 4 × 23 组跑分；pine 列必须等于历史读数 |
  | B4 | **首屏闪烁**：脚本读晚了，或内联位置被挪到 CSS 之后 | 第 10 条 | 脚本置 `<head>` 最前、同步执行；验收 6 强刷 10 次 |
  | B5 | **白名单漂移**：内联脚本与 TS 各写一份 | 第 11 条 | 由同一常量生成，测试断言两处一致 |
  | B6 | **首页被主题污染**：有人给 cosmic 子元素用了 `--text-1` | 第 8 条 | 验收 5 要求四主题下首页像素一致；`grep` 断言星系段不出现主题 token |
  | B7 | **入口不可发现**——本次返工的直接起因 | 第 9 条 | 菜单一级可见 + 显示当前主题名；`09_USER_GUIDE` 写明操作路径与位置 |
  | B8 | **设计稿与实现再次分叉**（§3.2 银河列、§3.5 默认 pine） | 背景 4 | 本 ADR 生效后由 Designer 同步 `13_DESIGN_V3.md`，两处以本 ADR 为准 |
  | B9 | **色阶名不副实**：`--green-*` 在 galaxy 下是金；`--gold-*` 在 midnight 下是蓝 | 第 5 条 | 只在注释与本 ADR 说明；重命名走 ADR-017 第 1 批，单独立项，不与本次返工混做 |
  | B10 | **契约数字靠手抄**：本次已发生一次（85 / 54 / 35 三个数字全是错的） | 第 4、5 条 | 数字由 `check:theme` 打印并作为唯一口径；文档只保留「由脚本得出」这句话 |
  | B11 | **第二份色值**：`src/lib/theme.ts` 的 `THEME_META.swatch` 在 TS 里写死四套主题色点 | 第 9 条 | **已关闭（2026-11-13）**：色点改为 `.theme-option-dots` 的 `data-theme` 子树取色，`theme.ts` 零 `#hex`，E8 已由 `main()` 断言并通过 |

- **影响范围**：01_ARCHITECTURE、02_PHASES、05_CHANGELOG、09_USER_GUIDE、13_DESIGN_V3（Designer 同步）

---

## ADR-022：知识图谱 3D 渲染与 2D 降级（Phase 6）

- **状态**：已采纳，**已实施**（2026-11-12 开工，2026-11-13 **生产运行时四项复验通过**；附录 A 于 2026-11-13 升至 **v1.6**：v1.2 补 `onStats` 回报回路、`SIZE_WORLD_RADIUS`、`dimmedEdges`；v1.3 把 A3 的 anchor / 星核 / 不可达抖动 / 两条时钟 / cancel 五处按已落地实现写死，并把正文 §5 与 A6 测试基线一并回写；v1.4 补 A3.2 机位与节点视觉尺寸、A3 `cancelled` 回执、A7 的 dev-only 标签框例外、A9 的 B2 实测读数与 §8/§9 运行时契约，测试基线更新为 46 文件 / 675 项；v1.5 按本轮实现核对补四项——`?maxNodes` 已接线（A9.4）、自适应降档的空闲清零规则（A9.2）、相机 `minDistance` 回到 260（A3.2）、Worker 373 节点端到端读数（A9.1），另记色调映射为 `NoToneMapping` 而非设计稿 §4.7 的 ACES（A8）；v1.6 新增 **A9.6 生产运行时（`next start`）复验**——默认入口 / `?maxNodes=600` 真 Worker / low 档抽稀 / 自适应降档四项读数、隔离方式、DOM-only 断言口径与构建隔离，并把 A9.3「抽稀未跑」、A9.4「抽稀分支仍未跑到」两处按复验结果改写。**状态不再写「实施中」，但也不写「验收完成」**（一行理由）：A/B 两线代码已全部落地、生产运行时已复验，而验收要点 2/3（硬件 GPU 帧时序、2000 节点）、7（上下文丢失）、15（内存）与真实 LightRAG / Logto 会话仍未实测，改口径抹不平。`layoutGalaxy3d` 签名未变，冻结继续有效）。**修订 ADR-020 第 11 条**（「子页面零 WebGL」）与**其风险 A6 的验收口径**：WebGL 例外扩到 `/graph` 一个页面，其余子页面不变。与 ADR-021 第 5 条（token 契约：**129 名 = 98 主题 + 31 几何**）做边界切分，不改主题机制。ADR-011 的读侧过滤、ADR-019 的权限、ADR-001 的图谱分层全部不动。
- **排期**：Phase 5 首页与主题（ADR-020 / ADR-021）验收收尾后开工；本 ADR 只定架构，不含代码。
- **实现契约**：见本文档末「附录 A：实现契约」（三个共享件 + 分线表）。分线开工前两条线都要先读完；附录里的类型与签名是冻结件。

- **背景**：
  1. 使用者看到开源项目 `DeusData/codebase-memory-mcp` 的前端 CBM Lens（React 19 + three.js + @react-three/fiber 的 3D「Galaxy」图），要求「把它的前端预览效果放到我们项目里，或直接结合那个项目」，原话是「现在的知识图谱那一块太 low 了」。排期要求：**先把首页和主题做完**再开工。
  2. 调研报告 `docs/15_GRAPH_UI_RESEARCH.md`（2026-11-12）已核验：项目真实存在、MIT、Galaxy 场景可借鉴；**不建议 iframe 嵌入**（其数据模型是代码符号 + C 守护进程，读不了我们的资产实体）；**不建议移植组件**（深度绑定其数据模型，移植≈重写）；推荐用 three.js + @react-three/fiber 重做，8–12 人日。本 ADR 采纳该路线，不再重复论证。
  3. 现状（`docs/16_GRAPH_DESIGN.md` §1 已逐条核对）：`/graph` 是「实体列表 + 640×420 两层径向 SVG + 下方问答卡片」，没有缩放、没有类型编码、没有边语义、150 节点即成毛线球；`status.failed` 后端已返回但界面从不渲染。设计稿正在按「全幅舞台 + 浮动分析层」的 2D 方案返工，但其 §2 写着「不做 3D 旋转图谱」、§14 C1 写着「不引入 WebGL」——**这两处与本 ADR 冲突，按本 ADR 改写**。
  4. 主题侧刚落下 ADR-021：token 契约是 **129 名**（98 个主题变量，四个主题块全量且集合相等；31 个几何档只在 `:root`）。因此图谱若要新增 `--graph-*`，**不能塞进主题块**，否则每加一个色号都要在四套主题里各验一遍，`check-theme.mjs` 的集合差分立刻变红。

- **决策**：

  1. **`/graph` 变成三个可切换的视图形态：3D 是默认概览，2D 是默认阅读**：
     - `3D`（Galaxy 概览）：全幅 WebGL 银河，相机可环绕，一眼看结构、枢纽、聚类；
     - `2D`（聚焦阅读）：设计稿 §3~§9 的全幅舞台 + 力导向，标签、边语义、详情栏、小地图都在这层；
     - `列表`：按类型分组的关系列表，键盘与读屏的等价信息通道。
     - 视图状态是 **URL 单一来源**（沿用 ADR-013 的同一原则）：`/graph?mode=3d|2d|list&focus=<实体>&depth=1|2|3`。刷新、分享、后退都还原同一画面；服务端仍做首屏数据预取，`mode` 只影响渲染层。
     - **选中不等于切换**：3D 里点节点只做「高亮 + 打开详情栏」，不自动跳 2D（每点一下就换页面会像重载）；工具条上的「聚焦」（快捷键 `2`）才切到 2D 并以该节点为中心。移动端、`prefers-reduced-motion`、WebGL 不可用时**默认进 2D**，3D 入口隐藏而不是置灰。

  2. **技术栈：three.js 沿用 `0.187.0`，新增 `@react-three/fiber@^9.8.2`，不引 `@react-three/drei`，不引 postprocessing**：
     - `three` 从 `^0.187.0` **改为精确 `0.187.0`**。首页星系（ADR-020）与图谱共用同一份 three；`^` 允许一次 minor 升级改掉 shader chunk / 色彩管理语义，届时两页会以不同方式坏掉，而验收脚本只盯首页。
     - `@react-three/fiber@9.8.2`：182.9 KB min / **57.7 KB gzip**，10 个运行时依赖（react-reconciler、zustand、its-fine 等），peer `react >=19 <19.4`、`three >=0.156`，与本项目 React `^19.2.0` 相容。
     - **`@react-three/drei` 不进 v1**：整包 1.68 MB min / **521.5 KB gzip**、21 个依赖（含 `@mediapipe/tasks-vision`、`hls.js`、`stats-gl`、`troika-three-text`）。我们只需要 `OrbitControls` 与标签两件事——前者用 `three/examples/jsm/controls/OrbitControls.js`（tree-shaken 后只带这一个类），后者用自建纹理图集（第 6 条）。为两件事背 21 个传递依赖与一份 CJK 字体，收益不成立。若原型验证后确实还缺 drei 的某个能力，**另开 ADR**，不在本期顺手加。
     - **不用 `@react-three/postprocessing`**：全屏 bloom 在 1440p 上是每帧一次额外 RT + 模糊链，与「静止画面」的成本完全不匹配；且泛光会把中文小字与暗节点糊成一片，正好违反 ADR-020「不霓虹、低饱和」。辉光用第 6 条的加法混合光环实现。

  3. **与 CBM 的边界：只借视觉与交互，不借代码与模型**：
     - **不引入** CBM 的 MCP 服务、C 守护进程、代码符号模型（文件 / 函数 / 调用链）、`graph.db.zst`。我们的节点是资产文本里抽出的实体（`entity_type` 自由文本），不是代码符号。
     - **数据只走现有链路**：`graph-service` → `/api/graph/*` → LightRAG 1.5.7。前端不直连 LightRAG，不新增数据副本。
     - **默认不复制源码**（0 行复制）：其 `GraphScene / NodeCloud / EdgeLines / NodeLabels / HaloLayer` 都把「代码实体」写进了类型与交互，抄过来等于把两套模型焊死。若后续确有一段通用代码值得复制，必须保留 MIT 版权头、在仓库根新增 `THIRD_PARTY_NOTICES.md` 记录出处与修改，并走一次 ADR 评审。

  4. **两个渲染器共用一个 `GraphViewModel`（本 ADR 的核心架构约束）**：
     - 新增 `src/lib/graph-model.ts`（纯函数）：`LightragNode/Edge` → `{ nodes: [{ id, label, shortLabel, type, rawType, shape, colorToken, degree, hop, size, flags }], edges: [{ id, source, target, type, description, weight, direction, hop, strong, colorToken }] }`（**以附录 A2 为准**：node 没有 `radius`——半径是 3D 布局的产物（A3.1）；字段名是 `colorToken`，不是 `colorVar`；边没有 `relation`，关系名是 `type`）。类型 → 形状 / 颜色、度数计算、标签截断、抽稀、连通分量全部在这里，**2D 与 3D 都只读它，不允许各自再写一份映射**（两份映射就是两份真值，正是 ADR-021 背景里「三套 token 词汇」的同一类病）。
     - 类型映射沿用设计稿 §4.2 的 6 类 × 颜色 + 形状双编码；未知类型落 `other`。`entity_type` 是 LightRAG 的自由文本，**只做小写关键词匹配，不猜语义**。
     - 度数由边集合在前端算（`LightragNode` 没有 weight / degree 字段），**不拿 description 长度冒充重要性**。
     - 若后续要区分内库 / 外库（ADR-008），在 view-model 加一维，不改渲染器契约。

  5. **3D 布局是纯函数：确定性、可缓存、换中心不炸图**：
     - 新增 `src/lib/graph-layout-3d.ts`：`layoutGalaxy3d(view, { seedKey, anchors, maxTicks, deadlineMs })` 返回 `Float32Array` 位置 + 半径 + 包围球（精确签名见附录 A3）。
     - 初始落点：中心在原点；1/2/3 跳三层盘 `r = 85 / 150 / 210`（世界单位），垂向抖动 `±10 / ±22 / ±32`，不可达节点外环 `r = 340`（垂向 `±32`）；角度按 `360°/n` 均分 + `hash(id)` 抖动，**同一实体每次落点一致**（截图基线与单测才能稳定）。
     - 松弛：边弹簧 + 节点斥力（≤300 节点 O(n²)，>300 用网格空间哈希）+ 径向约束 + 碰撞；固定步长、按 id 排序迭代，**不读时钟、不读 rAF**，结果只由输入决定。
     - **换中心不重排**：新旧图共有的节点保留相对位置（`anchors`，锚点完全钉住、不参与松弛），新节点在 anchor 邻居质心外 46 世界单位播种后松弛。禁止整图重新随机——每点一次就炸开重排，是最容易把「高级感」做成「廉价特效」的地方。
     - 规模分档：≤300 节点同步算（≤16ms 预算）；301–2000 进 Web Worker（生产 Worker 默认 `deadlineMs = 400`，调用方不传也生效；到点返回当前解并标记 `truncated`）；>2000 不布局，直接提示「仅展开最近 N 个」并抽稀（第 9 条）。
     - 缓存键：`centerId + depth + 节点 id 集合哈希 + 画布尺寸档 + 布局版本号`。

  6. **渲染分层固定，draw call 有上限**：

     | 层 | 实现 | draw call | 说明 |
     |---|---|---|---|
     | 星场 | `THREE.Points`，≤1200 点，固定种子 | 1 | 随相机产生视差；**不在 CSS 里再叠一层星空**，两层会过密 |
     | 光晕 | instanced 面片 + 加法混合，半径 3.2× 节点 | 1 | 只用中心衰减，不用 `filter: blur` / bloom |
     | 节点 | 单个 instanced 面片 + SDF 着色器（圆 / 双环 / 圆角方 / 菱形 / 六边形 / 小圆由逐实例属性选） | 1 | 六种形状一个 draw call；**无光照、纯色 / 自发光**，保证与 `:root` 对比度读数一致（PBR 会让颜色随光照漂移，contrast 脚本就失去意义） |
     | 边 | `LineSegments2` + `LineMaterial`（`three/examples/jsm/lines/*`，不是新依赖）单几何（2 顶点 / 边；曲线按 8 段折线，>600 边自动切直线）；按默认 / 结构 / 选中分 **3 组** | 3 | 关系语义在详情栏，不靠线型。**合计因此正好 8，零余量**；超预算先把「结构」并入「默认」（边 2 组），见 A8 |
     | 标签 | 单纹理图集 + instanced 面片（逐实例 UV 偏移） | 1 | Canvas2D 绘制文字入图集，**不用 troika、不加载字体文件**：CJK 走系统字体栈，DPR 下重绘一次即可；LRU 上限 128 张（每张 ≤256×64），命中率不足时先减标签数量 |
     | 选中环 / 高亮 | 1 个小 mesh | 1 | |
     | **合计** | | **≤8** | 任何一层超预算，先降标签预算，不许加 pass |

     - 标签只在**屏幕空间**判定：投影后字号 <11px 不画；与已放置标签矩形相交不画（宁缺勿挤）；预算 `high` 40 / `balanced` 24 / `low` 12，中心、选中、hover 永远优先。

  7. **静止优先：`frameloop="demand"`，空闲零帧**：
     - r3f 的 `frameloop="demand"` + 交互时 `invalidate()`：不拖、不滚、不悬停时**完全不渲染**。这比「稳态 60fps」更强，也是 ADR-020「静谧」在 3D 里的落点。
     - 「自动旋转」默认**关**，是显式开关；`prefers-reduced-motion: reduce` 下开关隐藏并强制关。
     - `visibilitychange` 隐藏 → `frameloop="never"`，并停掉 15s / 5s 轮询；恢复后只 invalidate 一次，不补帧。

  8. **性能预算与自适应降档**：

     | 档位 | 触发条件 | 节点上限 | 边上限 | 标签上限 | DPR 上限 | 目标 |
     |---|---|---|---|---|---|---|
     | `high` | 桌面、`hardwareConcurrency ≥ 8`、非 reduced-motion | 600 | 1200 | 40 | 2 | 150 节点 ≥60fps（avgFrame ≤8ms） |
     | `balanced` | 默认 | 300 | 600 | 24 | 1.5 | 150 节点 ≥50fps |
     | `low` | `hardwareConcurrency ≤ 4` / 移动 / 软件渲染（SwiftShader）/ 连续掉帧 | 150 | 300 | 12 | 1 | ≥30fps |

     - 自适应：连续 60 帧 `avgFrame > 20ms` → 降一档；**只降不升**，两次降档间隔 ≥3s，一页最多降两次（防止来回抖）。
     - 另设硬预算：单帧 JS ≤6ms、GPU ≤8ms（1440×900 / DPR 2）。超了先砍标签，再切直线边，再降 DPR，最后由 `mode` 回落 2D。
     - **上下文丢失**：监听 `webglcontextlost`（`preventDefault`）→ 显示「正在恢复渲染」→ 只用 view-model 重建场景（不重新请求）；同一 session 丢失两次或恢复超时 1.5s → 本页永久回落 2D 并给一句说明，不再重试。
     - 卸载时显式 `dispose()` 几何、材质、图集纹理、`ResizeObserver`、rAF；进出 `/graph` 3 次 GPU 内存不增长是验收项。

  9. **抽稀与规模**：
     - 输入上限由接口决定（`maxNodes` 默认 150）。**150 以内全部渲染**，只做标签 LOD。
     - 151–600：保留中心、选中、1 跳全部；2 跳按度数降序取到预算，其余汇总为「+N 个实体未显示」提示条（不造假节点、不随机丢弃）。
     - 601–2000：默认只渲染 1 跳；用户显式点「展开更多」才请求 `maxNodes=600`（第 12 条），并强制 `balanced` 档。
     - >2000：不做前端聚合（要后端社区聚类接口），提示「当前视图只显示最近 N 个实体」，给「以某节点为中心深入」。
     - 抽稀是纯函数 `decimate(view, budget)`，**保留集合确定、可单测**；筛类型不触发重布局，只改可见性。

  10. **降级链与首帧（同时解决 SSR）**：
      - 判定是纯函数 `selectGraphMode({ webgl, reducedMotion, nodeCount, tier, urlMode })`，结果 `3d | 2d | list`，可单测。
      - **首帧永远是 DOM**：服务端渲染骨架 / 2D 结构，客户端 `useEffect` 里做 WebGL 探测（`canvas.getContext('webgl2')`），通过后才 `next/dynamic(..., { ssr: false })` 拉 3D chunk，200ms 交叉淡入接管。理由有三：SSR 下 `THREE` 不能进服务端包；探测失败时用户已经看到内容；首屏文字与实体列表不等 3D chunk。
      - 探针失败 / chunk 加载失败 / 上下文两次丢失 → 静默留在 2D，不抛未捕获错误，只在工具条给一个「3D 不可用」小标记（点开说明原因）。
      - `prefers-reduced-motion` 不是「动画变慢」，是**不进 3D**：2D 里相机瞬移、无 shimmer、无脉冲。

  11. **交互与可访问性**：
      - 3D：左键拖拽环绕（极角 25°–155°）、滚轮 / 双指缩放、右键或双指平移、单击选中、双击以它为中心重新取景（400ms，reduced-motion 下瞬移）。相机缓动用 `ease-out-expo`，不做自动漫游、不做惯性甩尾。
      - 2D：沿用设计稿 §5 的指针与触控规范（单指平移、双指捏合、长按 400ms 预览关系）。
      - 键盘：`Canvas` 外层 `tabIndex=0`，`role="img"` + `aria-label="知识图谱，共 N 个实体，中心 X"`；方向键环绕、`+/-` 缩放、`Enter` 选中、`2` 切 2D、`/` 聚焦搜索。**3D 内不做逐节点空间导航**（读屏用户在三维点阵里逐点 Tab 只是折磨），而是提供常驻的「切换到 2D / 列表」入口，切换时 `aria-live` 播报。
      - 颜色 + 形状双编码（设计稿 §4.2），3D 与 2D 同表。
      - 触控命中：3D 用屏幕空间距离取最近节点（≥44px 移动 / ≥24px 桌面），不要求射线真的打中网格。

  12. **数据契约：只补两处必做 + 一处缓议，其余不动**：
      - **（必做）`GET /api/graph` 透传 `maxNodes`**：当前路由只读 `label` 与 `depth`，`maxNodes` 在服务层硬编码为 150（`graph-service.ts:399`）。改为可选查询参数，整数 **50–600**，默认 150，越界按 `ValidationError` 处理（与 `depth` 同风格）。只改路由与一处校验，`GraphGateway` 不动。
      - **（必做）`status.failed` 上界面**：接口早已返回 `failed: [{ objectId, error }]`，界面从未渲染。工具条 chip 变警示色 + 「N 个对象抽取失败」，点开列对象与错误原文（LightRAG 的英文错误原样显示，外面包中文标签）。3D 与 2D 共用这一个状态条。
      - **（缓议）按对象重试**：本期**不做**。契约先钉住，免得前端自造：`POST /api/graph/sync` 增加可选 body `{ objectIds?: string[] }`（≤50、必须属于当前账号、`content:sync` 权限、幂等）。**注意** `syncGraph` 现在是一次全量扫并统计 `removed`，加过滤会改变「旧版本清理」的语义，必须连带补测试。触发条件：`failed` 列表上线后仍无人能自助处理，再立项。
      - **截断信号是推断，不是事实**：LightRAG `/graphs` 不返回 `truncated`。前端只能以 `nodes.length >= 请求的 maxNodes` 推断「已展开最近 N 个实体」。这句要写进代码注释与文案，不要让人以为后端保证了完整性。
      - **ADR-011 的过滤发生在截断之后**：先取 `maxNodes` 再按账号过滤，返回节点数可能远小于请求值，图也可能不连通。3D 布局与抽稀必须容忍「碎图」，不能假设中心连通所有节点。
      - **边没有方向语义**：`LightragEdge` 只有 `source/target`（抽取方向），3D 与 2D 默认都不画箭头；只有选中单条关系时在详情栏给 `A —关系→ B` 原文。
      - 接口错误沿用 `respond.ts` 现有 `{ error: { code, message } }`，不新增字段。

  13. **视觉 token 的边界（与 ADR-021 切分）**：
      - `/graph` 的舞台是**固定深空、不随主题变**的第二种 surface，与首页 cosmic 同级待遇：`[data-surface="graph"]` 块内定义 `--graph-*`（设计稿 §4.6 那组 + 舞台底色），**不进主题块、不进 ADR-021 的 129 名契约**。
      - 理由：四套主题 × 一张图 = 4 套节点色 / 边色 / 对比度验收；而浅色底的「图谱纸张」是另一个设计命题，不该由本次改版顺手捏一个。浅色主题下用 1px 边界 + 内阴影把深色舞台与浅色页面隔开，像编辑器里的深色终端，不违和。
      - 边界规则可 grep 断言：`.graph-stage` 子树内**不允许出现** `var(--text-*|--surface*|--green-*|--gold-*|--paper)`；工具条、详情栏、列表在舞台外，照常用主题 token。
      - `scripts/check-theme.mjs` 的字面量白名单从「cosmic 块」扩到「cosmic + graph 两个块」；`check-contrast.mjs` 新增 graph 块 6 组节点色对 `--graph-canvas` 的读数（设计稿已给：12.0 / 7.9 / 6.5 / 8.1 / 9.1 / 4.5）。

  14. **测试策略：纯函数为主，不引 jsdom、不测 WebGL**：
      - 新增纯函数文件与对应测试（沿用 node 环境与 `tests/lib/*.test.ts`）：
        - `graph-model.test.ts`：类型 → 形状 / 颜色（含未知类型、大小写、中文类型名）、度数与 hop、标签截断（中文 / 英文 / 超长）、`decimate` 的保留集合与预算、碎图不报错。
        - `graph-layout-3d.test.ts`：同输入同输出（两次调用逐字节相等）、中心在原点、hop 半径单调、无 `NaN`、最小间距、换中心时 anchor 保持、tick 预算触发 `truncated`、空图与单节点。
        - `graph-layout-2d.test.ts`：设计稿 §6.1 的力导向，同样的确定性与预算断言；`layoutRadial` 保留为降级基线，旧测试不动。
        - `graph-quality.test.ts`：`selectGraphMode` 全分支（webgl × reducedMotion × 规模 × urlMode）、档位选择、只降不升、DPR 上限。
        - `graph-contract.test.ts`：`maxNodes` 解析与越界、`nodes.length >= maxNodes` 的截断推断、`failed` → 状态条模型。
      - **组件层不引 jsdom**：状态分支收敛到 `selectGraphMode` / `deriveGraphUiState` 这类纯函数，组件只渲染；渲染结果由浏览器验收脚本按 `window.__graphStats` 与截图覆盖。为几个分支给全仓引一套 DOM 环境不划算。
      - **不写 WebGL 单测**：headless GL 的结论与真实 GPU 无关，只会给出「测试通过但线上掉帧」的假安全感。
      - 预计新增 **6** 个文件约 60–70 项（以 A6 的单测清单为准）。**基线不写死数字**：以冻结当天 `npm test` 的输出为准（2026-11-13 现测 **46 个测试文件 / 675 项：672 过、3 跳过**，其中 1 个文件整体跳过；初版写的「31 文件 / 392 项 → 36 文件 / 450–460」是手抄推算，已过期）。

  15. **验收读数**：扩展 `window.__graphStats = { mode, tier, webgl, nodes, edges, labels, drawCalls, dpr, frames, avgFrameMs, layoutMs, layoutTicks, truncated, rafActive }`，验收脚本只读它，不去猜 DOM。与首页 `__galaxyStats` 同风格但**互不复用**（两个页面各自的生命周期，混用会互相污染读数）。

  16. **不动的东西**：权限（`object:read` / `content:sync`）、账号过滤（ADR-011）、同步与问答的业务语义、`/api/graph/query`、`/api/graph/labels`、`/api/graph/sync` 的请求形状、首页星系与降级链、四套主题机制。**不新增数据库字段、不新增表。**

- **备选方案与取舍**：

  | 决策点 | 方案 | 取舍 |
  |---|---|---|
  | 3D 与 2D 的关系 | **A（采纳）3D 概览 + 2D 阅读，可切换** | 3D 负责「一眼看结构」，2D 负责「读得清」；代价是两套渲染器，靠共享 view-model 压住漂移 |
  | | B：只做 3D | 少一半工作量，但 150 节点下的中文标签、边语义、无障碍都要在 3D 里重新发明，移动端基本不可用 |
  | | C：维持 2D 只做视觉升级 | 成本最低，但使用者要的就是「那个效果」，等于不回答需求 |
  | | D：3D 里内嵌 2D 详情卡，不做整页 2D | 读图时视野被卡片压死；关系列表与路径无从呈现 |
  | 依赖 | **A（采纳）fiber + three 自带 OrbitControls + 自建标签图集** | 增量 57.7KB gzip、10 个传递依赖，可控 |
  | | B：fiber + drei | 拿到现成 `OrbitControls / Html / Line`，代价是 521.5KB 整包、21 个依赖（含 mediapipe、hls.js）、troika 的 CJK 字体问题 |
  | | C：弃 fiber，命令式 three | 少 57.7KB，但要自己写 React 生命周期、resize、dispose、状态同步，约 +1.5 人日且更容易泄漏 |
  | 辉光 | **A（采纳）加法混合光环面片** | 零额外 pass，成本随节点数线性；够「高级」且不会过曝 |
  | | B：postprocessing bloom | 观感最接近 CBM，但每帧一次全屏 RT + 模糊链，中文小字会被糊；多一个依赖与 Zlib 许可 |
  | | C：CSS 光斑叠在 canvas 上 | 相机一动就对不上，直接排除 |
  | 舞台主题 | **A（采纳）固定深空，不随主题** | 一张图四套验收变一套；浅色主题下是「深色终端」观感，边界清楚 |
  | | B：随主题给浅色图谱 | 视觉更统一，但要重定 6 类节点色 × 4 主题 = 24 组对比度，且力导向图在浅底上天然发灰 |
  | 布局 | **A（采纳）确定性 3D 力导向 + anchor 保持** | 可测、可复现、换中心不炸图 |
  | | B：每帧持续模拟（d3-force 式） | 有「活着」的感觉，但 CPU 常驻、与「静谧」和按需渲染冲突，截图基线不稳 |
  | | C：固定球面、不做力导向 | 最稳，但 150 节点均匀铺球面，看不出任何结构 |

- **影响**：
  - 新增：`src/lib/graph-model.ts`、`graph-layout-3d.ts`、`graph-layout-2d.ts`、`graph-quality.ts`、`src/components/graph/graph-scene-3d.tsx`（dynamic、client-only）、`src/components/graph/{node-field,edge-field,label-layer,starfield}.tsx`、`src/workers/graph-layout.worker.ts`、`src/components/graph/graph-stage-2d.tsx`、`scripts/graph-perf.mjs`、6 个测试文件。
  - 重写 / 拆分：`src/components/graph-explorer.tsx`（508 行 → 容器：数据、模式、状态条、详情栏、问答，渲染下沉到两个渲染器）、`src/app/graph/page.tsx`（读 URL `mode / focus / depth`）。
  - 小改：`src/app/api/graph/route.ts`（`maxNodes` 透传 + 校验）、`src/app/globals.css`（`[data-surface="graph"]` 块 + 舞台与浮层）、`scripts/check-theme.mjs`、`scripts/check-contrast.mjs`。
  - 依赖：`+@react-three/fiber@^9.8.2`；`three` 由 `^0.187.0` 改精确 `0.187.0`；不新增其他运行时依赖。
  - 文档：本 ADR、`16_GRAPH_DESIGN.md`（§2「不做 3D」、§14 C1、§6 规模表、§8 性能与降级按本 ADR 改写）、`02_PHASES.md` 新增 Phase 6、`05_CHANGELOG.md`、`06_API.md`（`maxNodes`）、`09_USER_GUIDE.md`（三种视图与切换）。
  - 工期：8–12 人日（调研结论）。拆分建议：view-model + 2D 约 4 人日、3D 场景约 4 人日、联调与验收 2 人日；可并行，但**必须先冻结 `GraphViewModel` 与 `layoutGalaxy3d` 两个接口**（风险 G10）。

- **验收要点**：
  1. `npm run lint` / `typecheck` / `test` / `check:contrast` / `check:theme` 全绿；既有 392 项不回归。
  2. 150 节点 / 450 边、1440×900、`high` 档：`avgFrameMs ≤ 8`（硬件 GPU），`balanced` ≤14；拖拽与缩放无 >100ms 的单帧。
  3. 2000 节点：抽稀到档位预算后静态 ≥30fps、拖拽 ≥20fps、布局 ≤1200ms（Worker）、标签 ≤12、`drawCalls ≤ 8`。
  4. 空闲：停手 2s 后 3 秒内 `frames` 增量为 **0**（`frameloop="demand"` 生效）；切走标签页后同样为 0。
  5. `prefers-reduced-motion: reduce`：`mode="2d"`、页面 canvas 数 0、`rafActive=false`。
  6. 禁用 WebGL：`mode="2d"`、`__graphStats.webgl=false`、控制台无未捕获错误。
  7. 注入 `WEBGL_lose_context` 一次：≤1.5s 恢复且画面与丢失前一致；连续两次：本页回落 2D 并有一句说明。
  8. SSR / 首帧：`/graph` 直出 HTML 不含 `THREE`、不含服务端 canvas；3D chunk 到达前文字与实体列表可读；hydration 无 mismatch。
  9. URL：`?mode=2d&focus=<实体>&depth=2` 刷新后画面一致；浏览器后退回到上一视图；非法 `mode` 回落默认。
  10. 键盘：Tab 可达「切换到 2D / 列表」；2D 内方向键移动焦点、Enter 选中；`aria-live` 播报切换与选中；3D canvas 有 `aria-label`。
  11. 主题：四主题下 `/graph` 舞台截图逐像素一致；`.graph-stage` 子树无主题 token（grep）；`check-contrast` 新增 6 组读数全达标。
  12. 包体：`/graph` 路由首载 JS 增量 ≤120KB gzip（相对当前路由）；`/` 首载增量 ≤2KB（fiber 不进口）；`next build` 产物中 `THREE` 不出现在任何 server chunk。
  13. canvas 审计：全站除 `/`、`/galaxy/poster` 外，只有 `/graph` 允许 1 个 canvas；`/graph` 在 2D 模式下为 0。
  14. 状态：`failed` 非空时工具条可见警示与列表；零内容 / 有对象零实体 / 抽取中 / 图请求失败 / 服务未连接 / 无权限六态各有画面与主行动（设计稿 §7.1）。
  15. 内存：进出 `/graph` 3 次，JS 堆不单调增长；卸载后无残留 rAF 与 `ResizeObserver`。

- **风险**：
  | # | 风险 | 触发点 | 应对 |
  |---|---|---|---|
  | G1 | **体积与首屏**：three 让直接进 `/graph` 的冷启动多 ~265KB gzip | 第 2、10 条 | 3D 全在懒加载 chunk，首帧 DOM 先上；主包不含 fiber；首载 JS 增量设 120KB 硬上限 |
  | G2 | **移动端 GPU 撑不住**，发烫掉电 | 第 8 条 | `low` 档 + 默认 2D + 按需渲染（空闲 0 帧）+ 移动端不提供 3D 入口 |
  | G3 | **标签遮挡**：3D 里实体名互相压住，等于没有标签 | 第 6 条 | 屏幕空间预算 + 矩形碰撞 + 中心 / 选中优先；3D 只保证「看清结构」，读名字是 2D 的职责 |
  | G4 | **布局不稳定**：换中心整图重排，用户失去空间记忆 | 第 5 条 | anchor 保持 + 确定性种子；验收用同一中心连点 5 次，位置集合不变 |
  | G5 | **SSR / hydration**：r3f 不能在服务端渲染 | 第 10 条 | 首帧 DOM + 客户端动态加载；验收 8 检查 server chunk |
  | G6 | **three 版本漂移**：首页与图谱共用一份，minor 升级改 shader 语义 | 第 2 条 | 精确锁 `0.187.0`；升级单独 ADR，两页一起验 |
  | G7 | **fiber 的 peer 上限 `react <19.4`** | 升级 React 时 | 升 React 前先确认 fiber 已支持；`npm ls react` 作为验收项 |
  | G8 | **两套渲染器漂移**：2D 改了形状映射，3D 没改 | 第 4 条 | 映射只在 `graph-model.ts`；渲染器内禁止出现类型字面量（grep 断言）；截图基线成对更新 |
  | G9 | **自建 SDF 着色器与纹理图集是长期负担**，作者离开后没人敢改 | 第 6 条 | 参数全进配置对象、着色器集中一个文件、留对照截图；不追求与 CBM 同款，够用即止 |
  | G10 | **工期 8–12 人日与并行人手**：使用者已提出「工程师不够就再建一个 coder 并行」 | 影响章节 | 按 view-model / 2D 与 3D 场景两条线切分，**接口先冻结**（`GraphViewModel`、`layoutGalaxy3d`）；否则并行只会产出两套映射 |
  | G11 | **「借鉴」滑向「复制」**，把 CBM 的代码符号概念带进来 | 第 3 条 | 复制零行；若必须复制，MIT 头 + `THIRD_PARTY_NOTICES.md` + ADR 评审 |
  | G12 | **`/graph` 目前没有错误边界**（ADR-016 风险 R10 遗留） | 页面改版时 | 本次一并补 `src/app/graph/error.tsx`；否则词表读失败仍是 Next 默认错误页 |

- **影响范围**：01_ARCHITECTURE、02_PHASES（新增 Phase 6）、05_CHANGELOG、06_API（`maxNodes`）、09_USER_GUIDE、13_DESIGN_V3（Designer 同步）、16_GRAPH_DESIGN（按本 ADR 改写 §2 / §6 / §8 / §14）

### 附录 A：实现契约（2026-11-12，双线并行冻结件）

> 目的：第 4 条只说了「共用一个 view-model」，不足以让两个人同时开工。本附录把三个共享件（`GraphViewModel`、`layoutGalaxy3d`、高亮 selector）的形状钉成可编译的契约，A/B 两线的文件边界钉成可 review 的清单。
>
> **冻结语义**：本附录里的类型、函数签名、字段名、排序规则、文件归属，**从分线那一刻起视为已冻结**。任何一条要改，必须两线双方 review、同一天由同一个提交完成，并在文末「变更记录」加一行。新增可选字段也算变更（它会让另一线漏读），不许「反正可选，我先加」。
>
> 与任务书的一处偏离：任务书要求 view-model 的 node 带 `x / y / z`，本附录**把坐标移出 view-model**。理由见 A1，这不是省略，是修正。

#### A1. 分层：view-model 不带坐标，坐标属于各自布局的产物

1. **两个渲染器有两份坐标，只有一份数据。** 3D 用 `layoutGalaxy3d` 的产物，2D 用 `graph-layout-2d.ts` 的产物。坐标若写进 `GraphNode`，两个布局函数就要往同一个共享对象里写，谁后写谁生效——切一次视图就互相覆盖，且「2D 降级」反而依赖 3D 布局跑过。
2. **传输形态是 `Float32Array`。** Worker 结构化克隆一条连续的二进制、`BufferAttribute` 直接零拷贝接管；写进对象属性就要在两边各做一次「对象 ↔ 数组」转换，2000 节点上是白送的 GC 压力与错位 bug。
3. **缓存语义不同。** view-model 的缓存键是节点 id 集合哈希，布局的缓存键还带画布尺寸与布局版本号。拆开后 view-model 能跨布局版本复用，布局能单独重算。

坐标的等价物：`GalaxyLayoutResult.positions`（xyz 交错）+ `indexById`（id → 顶点序号）。**渲染器不构造「带坐标的节点对象数组」**，按索引读。

#### A2. `GraphViewModel` 精确形状

```ts
// src/lib/graph-model.ts —— 只有这个文件认识 LightRAG 的字段名
import type { LightragEdge, LightragNode, LightragSubgraph } from "@/server/adapters/lightrag/client";

export type GraphEntityType = "concept" | "person" | "org" | "work" | "method" | "other";
export type GraphNodeShape =
  | "circle" | "double-ring" | "round-square" | "diamond" | "hexagon" | "dot";
export type GraphColorToken =
  | "--graph-node-concept" | "--graph-node-person" | "--graph-node-org"
  | "--graph-node-work" | "--graph-node-method" | "--graph-node-other";
export type NodeSizeTier = "s" | "m" | "l" | "xl";
export type GraphHop = 1 | 2 | 3;

export interface GraphNode {
  /** LightRAG 的 node.id。LightRAG 用实体名作 id，所以它同时是稳定键与展示名。 */
  readonly id: string;
  /** 完整名，= id.trim()，不截断；详情栏、列表、aria-label 用这个。 */
  readonly label: string;
  /** 屏幕标签用，按码点截断：中心 12 字 / 其余 10 字，超出加「…」。 */
  readonly shortLabel: string;
  /** 映射后的六大类，认不出落 other。 */
  readonly type: GraphEntityType;
  /** LightRAG 原始 entity_type 文本：只在详情栏展示，不参与任何逻辑与样式。 */
  readonly rawType: string;
  readonly shape: GraphNodeShape;
  /** 只给 token 名，不给色值：2D 与 3D 各自读同一个 CSS 变量。 */
  readonly colorToken: GraphColorToken;
  /** 去重后的边条数（自环与悬空边不计）。 */
  readonly degree: number;
  readonly hop: GraphHop;
  readonly size: NodeSizeTier;
  readonly flags: {
    /** 本次请求的中心实体：每张图恰好 1 个；中心不在返回集合里时为 0 个。 */
    readonly isCenter: boolean;
    /** degree === 0，ADR-011 过滤后的孤立点。 */
    readonly isOrphan: boolean;
    /** BFS 从中心到不了（碎图）。这类节点 hop 记 3，布局放最外环。 */
    readonly isUnreachable: boolean;
    /** description 为空，详情栏要出空态文案。 */
    readonly hasDescription: boolean;
  };
}

export interface GraphEdge {
  /** 稳定键：排序后的端点对 + 关系名，见 A2 规则 9。抽稀、单测、React key 都用它。 */
  readonly id: string;
  readonly source: string;
  readonly target: string;
  /** 关系名（派生，见 A2 规则 5）。 */
  readonly type: string;
  /** 关系原文，详情栏显示，不截断。 */
  readonly description: string;
  /** 平行关系条数（≥1）。**不是语义强度**，只用于排序与线宽分档。 */
  readonly weight: number;
  /** v1 恒为 "none"：LightRAG 的 source/target 是抽取方向，不是语义方向。 */
  readonly direction: "none";
  readonly hop: 1 | 2;
  /** hop === 1 或 weight >= 2。 */
  readonly strong: boolean;
  readonly colorToken: "--graph-edge" | "--graph-edge-strong";
}

export interface GraphFailure {
  readonly objectId: string;
  readonly error: string;
}

export interface GraphMeta {
  readonly center: string;
  readonly depth: GraphHop;
  /** 过滤后的节点数（= nodes.length，冗余一份给状态条）。 */
  readonly total: number;
  /** 本次请求的 maxNodes；截断推断要用它，所以必须留在 meta 里。 */
  readonly requestMaxNodes: number;
  /** 推断值，见 A5.3。 */
  readonly truncated: boolean;
  readonly truncatedSource: "inferred" | "server";
  /** 来自 /api/graph/status；未请求或请求失败时为空数组。 */
  readonly failed: readonly GraphFailure[];
  /** 状态接口没有时间戳，v1 恒为 null；有值才显示。 */
  readonly lastSync: string | null;
  /** 丢掉的边，只用于调试与单测，界面上不显示。 */
  readonly dropped: { readonly selfLoops: number; readonly danglingEdges: number; readonly nameless: number };
  /** 两个请求各自的成败，状态条据此区分「图失败」与「状态失败」。 */
  readonly sources: { readonly graph: "ok" | "error"; readonly status: "ok" | "error" | "skipped" };
}

export interface GraphViewModel {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  /** id → nodes 下标，build 时建好一次，渲染器不许自己再建。 */
  readonly nodeIndex: ReadonlyMap<string, number>;
  readonly meta: GraphMeta;
  /** 布局缓存键与截图基线都带它。 */
  readonly modelVersion: number; // v1 = 1
}

export interface GraphBuildInput {
  subgraph: LightragSubgraph;
  /** 状态接口的结果；没拿到就传 null，meta.sources.status 记 skipped。 */
  status: GraphStatus | null;
  center: string;
  depth: GraphHop;
  maxNodes: number;
}

export function buildGraphViewModel(input: GraphBuildInput): GraphViewModel;
```

**生成规则（`buildGraphViewModel` 内部，不许挪到渲染器）：**

| # | 规则 |
|---|---|
| 1 | 纯函数：无 IO、无 `Date`、无 `Math.random`、无 `performance`。同输入 → 输出逐字段相等（`nodeIndex` 用 `Object.fromEntries` 比对）。不修改入参。 |
| 2 | 节点：`id = node.id`，`label = id.trim()`；trim 后为空的丢弃并计入 `dropped.nameless`。同 id 只保留首个（按输入顺序）。 |
| 3 | 类型映射：**只做小写关键词匹配，不猜语义**。`person\|人物\|人` → person；`organi[sz]ation\|org\|组织\|机构\|公司` → org；`work\|作品\|资产\|asset\|content` → work；`method\|process\|方法\|流程\|步骤\|技术` → method；`concept\|概念\|理论\|主题\|topic` → concept；其余（含空、中文不认识、`geo\|location\|place` 暂无对应）→ other。表放常量 `ENTITY_RULES`，顺序敏感（先匹配先赢）。 |
| 4 | 形状与颜色：常量表 `ENTITY_STYLE: Record<GraphEntityType, { shape; colorToken; labelZh }>`，颜色值在设计稿 §4.4（概念 `#E9C08A`／人物 `#A99BC1`／组织 `#B08A6A`／作品·资产 `#8FA6B8`／方法·流程 `#9DB39A`／其他 `#7C7385`，对 `--graph-canvas` ≥4.5:1）。**组件里出现任何类型名或色值字面量都算违约**（grep 断言）。 |
| 5 | 关系名 `edge.type`：`LightragEdge` 只有 `description`，没有关系字段。派生规则按序取第一个命中的：`description` 里 `<SEP>` 分隔段的第一个词 → 首行前 12 个字符（去掉首尾引号）→ `"相关"`。规则集中在 `deriveRelationLabel()`，单测按真实样本校准；校准只改函数体，不改契约。 |
| 6 | 去重：同一排序后端点对 + 同一 `type` 合并为一条边，`weight` 累加（1 + 平行条数）。`source === target` 丢弃计入 `dropped.selfLoops`；端点不在 `nodeIndex` 里丢弃计入 `dropped.danglingEdges`（碎图常态，不许抛错）。 |
| 7 | `degree`：去重后边集合的两端各 +1。**不用 description 长度、不用文件数冒充重要性。** |
| 8 | `size`：固定分档，闭合区间：`0–1 → s`、`2–4 → m`、`5–9 → l`、`10+ → xl`（设计稿 §4.4 已定，与分位数无关，所以同一节点在不同视图里档位稳定）。 |
| 9 | 边 id：`${[source, target].sort().join("\u0001")}${"\u0001"}${type}`。用不可打印分隔符（U+0001），避免实体名里出现竖线造成键碰撞。 |
| 10 | **排序是契约的一部分**：`nodes` 按 `(hop 升序, degree 降序, id 升序)`；`edges` 按 `(weight 降序, id 升序)`。抽稀保留顺序、draw 顺序、截图基线、单测逐字节比对全都依赖它，A/B 都不许自行重排。 |
| 11 | `hop`：从 `center` 做 BFS（只走 `hop ≤ depth`），不可达节点记 `hop = 3` 且 `flags.isUnreachable = true`；`center` 不在集合里时所有 `isCenter = false`，不抛错。 |

**A2.1 舞台颜色 token（v1 冻结 12 名）**

只在 `[data-surface="graph"]` 块内定义，**不进主题块、不进 ADR-021 的 129 名契约**。值为设计稿现值，12 名已全部定稿（2026-11-12）：

| token | 用途 | 值 |
|---|---|---|
| `--graph-canvas` | 舞台底色 / 雾色 | `#050408` |
| `--graph-node-concept` | 概念 | `#E9C08A` |
| `--graph-node-person` | 人物 | `#A99BC1` |
| `--graph-node-org` | 组织 | `#B08A6A` |
| `--graph-node-work` | 作品 / 资产 | `#8FA6B8` |
| `--graph-node-method` | 方法 / 流程 | `#9DB39A` |
| `--graph-node-other` | 其他 | `#7C7385` |
| `--graph-node-disk` | 节点底盘 | `#0E0C13` |
| `--graph-core` | 星核 / 选中暖白光 | `#F6E3C6` |
| `--graph-edge` | 默认边 | `rgb(243 239 231 / 14%)` |
| `--graph-edge-strong` | 结构边 | 同上，不透明度 20%（v1 与 `--graph-edge` 同色，只差不透明度） |
| `--graph-accent` | 选中环 / 路径 / 键盘焦点 / 高亮 | `#F6E3C6`（已定稿，见 A8；与 `--graph-core` 同值但语义不同——core 是星核自发光，accent 是选中态，两处由一个来源定值） |

光晕色由 `--graph-accent` 派生，不单独定义；`check-theme.mjs` 的字面量白名单加 graph 块，`check-contrast.mjs` 新增 6 组节点色对 `--graph-canvas`。

2D 子树若要不同的底色或更强的边（设计稿 §5.2 沿用的是 v1 数值），在 `[data-surface="graph"][data-mode="2d"]` 上**覆盖同名 token**（如 `--graph-canvas`、`--graph-edge`），不新增第 13 个名字、更不在组件里写字面量——A7 禁止条款 4 对两线都生效。

#### A3. `layoutGalaxy3d`：签名与约束

```ts
// src/lib/graph-layout-3d.ts —— 纯数学，不 import three、不 import React
export interface GalaxyLayoutOptions {
  /** 只用于缓存与基线命名，**不作随机源**：随机源只有 hash(id)，否则换中心全图重排。 */
  seedKey: string;
  /** 上一版布局里仍存在的节点 ⇒ 坐标；换中心时优先保持。 */
  anchors?: Readonly<Record<string, readonly [number, number, number]>>;
  /** 松弛步数上限。整数、固定 → 结果与机器快慢无关。默认按节点数分档（见下表）。 */
  maxTicks?: number;
  /** 安全阀：仅 Worker 包装层用；超时返回当前解并置 truncated。 */
  deadlineMs?: number;
}

export interface GalaxyLayoutResult {
  /** 长度 = nodes.length × 3，xyz 交错。 */
  readonly positions: Float32Array;
  /** id → 顶点序号。 */
  readonly indexById: ReadonlyMap<string, number>;
  /** 序号 → id，Worker 传输用（Map 虽可克隆，仍保留一份便于序列化与调试）。 */
  readonly ids: readonly string[];
  /** 每节点包围半径，视锥/标签剔除用。 */
  readonly radius: Float32Array;
  readonly bounds: { readonly center: readonly [number, number, number]; readonly radius: number };
  readonly ticks: number;
  /** 安全阀触发（deadline 到）或 >2000 节点降级布局时为 true。 */
  readonly truncated: boolean;
  readonly layoutMs: number;
}

export function layoutGalaxy3d(
  view: GraphViewModel,
  options: GalaxyLayoutOptions,
): GalaxyLayoutResult;
```

| 约束 | 口径 |
|---|---|
| 确定性 | 固定 `maxTicks`、**不传 `deadlineMs`** 时，同 `view` + 同 `anchors` → `positions` 逐字节相等（单测断言）。不读时钟、不读 rAF、不读 `devicePixelRatio`；`layoutMs` 与 deadline 判断只决定 `truncated` 和 `layoutMs`，不进坐标。**截图基线 / 确定性单测必须走这条路径**（见「两个时钟」）。 |
| 播种 | 设计稿 §4.3 的三层盘（世界单位，与相机 260–1100 同一坐标空间）：星核原点，1/2/3 跳 `r = 85 / 150 / 210`，垂向抖动 `±10 / ±22 / ±32`，角度按 `360°/n` 均分 + `hash(id)` 抖动 `±0.06rad`。**不可达节点（BFS 到不了）放 `r = 340` 外环，垂向抖动沿用第三层的 `±32`**，角度仍按 `360°/n` 均分 + 同一 `hash(id)` 抖动。**盘面是播种，不是最终解。** |
| 松弛 | ADR-022 第 5 条：边弹簧 + 节点斥力（≤300 节点 O(n²)，>300 网格哈希）+ 径向约束 + 碰撞；固定步长、按 id 排序迭代。**只播种不松弛 = 150 节点也看不出结构；只松弛不盘面 = 每次形状都漂。** |
| 星核 | 星核**固定在原点**（`pinned = 1`），弹簧、斥力、径向约束都不移动它；`anchors` **不覆盖星核**（`centerIndex` 跳过 anchor 读取）。换中心时旧星核让位：它回到普通节点，按自己的 hop 层重新播种，新中心占原点。星核的位置不因是否传了 `anchors` 而变。 |
| anchor | 语义是「上一版布局里仍存在的节点坐标」。**anchor 节点完全钉住（`pinned = 2`）**：首步落在 anchor 坐标，此后每个 tick 都不更新其位置——**不是「锚点以半力参与松弛」**。只有完全固定才能满足验收第 4 条「同一中心连点 5 次、位置集合不变」：锚点一旦参与移动，每次调用都从同一点再漂一点，第二次起就对不上。为减轻自由端点被硬锚点拽出的抖动，与 pinned 端点相连的弹簧对**自由端**施加的力减半，锚点自身不动。新节点（自己没有 anchor、有 anchor 邻居）在邻居质心外 `46` 世界单位播种（垂向 `±12`），再交给松弛。**如实记录两个副作用**：① 共有节点被冻结在上一版，图结构变化后这一片不再松弛，局部可能显得过挤或过疏；② 新节点从 anchor 邻居质心外 46 单位起步，锚点密集处会聚在锚点附近，靠碰撞项推开，必要时才由调用方调整 anchor 集合。 |
| 预算与停止 | Worker 内每个 tick 间隙检查 `deadlineMs`；到点即以当前解返回、`truncated = true`。默认 `maxTicks` 按节点数分档：≤150 → 80、151–600 → 150、601–2000 → 220。 |
| 取消 | **队列丢弃语义**：布局是同步循环，Worker 的事件循环在整段布局期间不派发新消息，`{ type: "cancel" }` **物理上不可能落在布局进行中**，只可能在两次 `layout` 之间被读到。落地口径：请求先进 **one-slot 队列**，由一次宏任务 flush；flush 之前到达的 `cancel`（或更新的 `layout`）丢弃**尚未开始**的那条，并回一条 `{ type: "cancelled" }`（v1.4 补，见「Worker 协议」）。**运行中的任务由 Worker 自带的 400ms `deadlineMs` 兜底**（到点以当前解返回并置 `truncated`）。**不承诺 cancel 能中断运行中的布局**——旧表述「cancel 可中断运行中布局」作废。库函数的 `shouldStop` 选项保留（`layoutGalaxy3dControlled` 在 deadline 让出的 tick 间隙读一次），**Worker 包装层不接线它**（同步循环里读不到消息，接了也没有效果）；两处都不得据此对外声称具备真中断。 |
| 两个时钟 | **生产口径**：Worker 自己默认 `deadlineMs = 400`，**不依赖调用方传参**（调用方漏传也必须受 400ms 约束）；库函数 `layoutGalaxy3d` 本身不设默认 deadline，`deadlineMs` 只由 Worker 包装层给。ADR-022 第 5 条的「≤400ms」是 Worker 内 tick 预算（超了即 `truncated`）；验收第 3 条的「≤1200ms」是端到端（含序列化、调度、首帧）。**两者不可互校**：400ms 是内部安全阀，1200ms 是用户可感时延。**确定性与截图基线走另一条路**：固定 `maxTicks`、**不传 `deadlineMs`**；否则同输入在不同机器 / 不同负载下会在不同 tick 被截断，`positions` 不可能逐字节相等。 |
| 规模 | ≤300 同步算（≤16ms）；301–2000 进 `src/workers/graph-layout.worker.ts`；>2000 不布局，抽稀到档位上限后再算，并 `truncated = true`。 |
| 缓存键 | `centerId + depth + 节点 id 集合哈希 + 画布尺寸档 + layoutVersion`（`layoutVersion` 只在算法改动时 bump，bump 必须同时更新截图基线）。 |
| Worker 协议 | 入站 `postMessage({ type: "layout", view, options })`（进 one-slot 队列，一次宏任务后 flush）/ `{ type: "cancel" }`（丢弃尚未开始的那条）。出站**每条请求最多一条终态回复**：`{ type: "done", result }` / `{ type: "error", message }` / `{ type: "cancelled" }`——`cancelled` 表示该请求在开始前被 `cancel` 或更新的 `layout` 顶掉（v1.4 补）。**客户端收到 `cancelled` 直接忽略、不重试、不当作失败**，只采纳最后一条 `done`；400ms tick 预算仍由 Worker 自己注入与兜底，不因多这一条回执而改变。Worker 不许 import React / three / 任何 `@/components`。 |

**v1.3 措辞对齐（2026-11-13）**：上面 anchor / 星核 / 不可达抖动 / 预算与停止 / 取消 / 两个时钟六行按**已落地实现**写死，`layoutGalaxy3d` 的签名与返回值不变，冻结继续有效。若以后要让 anchor 参与松弛，必须先有满足「连点 5 次位置集合不变」的验收用例，再改本节——不允许先改代码后补 ADR。

**A3.1 `SIZE_WORLD_RADIUS`：节点四档世界半径（2026-11-13 冻结，v1.2 补）**

```ts
// src/lib/graph-layout-3d.ts 导出；layoutGalaxy3d 内部即用它填充 result.radius
export const SIZE_WORLD_RADIUS: Readonly<Record<NodeSizeTier, number>> = {
  s: 1.9,
  m: 2.5,
  l: 3.3,
  xl: 4.4,
};
```

| 项 | 口径 |
|---|---|
| 值 | `s / m / l / xl → 1.9 / 2.5 / 3.3 / 4.4`（设计稿 §4.4，**世界单位**；与三层盘的 85 / 150 / 210、相机 260–1100 同一坐标空间） |
| 谁算 | **只有 `layoutGalaxy3d`**：`result.radius[i] = SIZE_WORLD_RADIUS[node.size]`，序号由 `indexById` 给。星核 `r = 5.4`、选中 `×1.15`、光晕 `3.2×` 是纯视觉，留在 B 的渲染层，不进布局 |
| 谁读 | 3D 渲染层只读 `result.radius`，**不许自己再拿 `node.size` 查一次表**——两处查表就是两份真值，改一档必然漏一处 |
| 2D 不共用 | 2D 半径是 `clamp(5 + 3.1 × √degree, 5, 20)`（设计稿 §5.2，屏幕像素，随度数连续），与本表**不是一套**。并存是有意的：3D 要稳定的四档世界半径（透视与相机距离再缩放），2D 要随度数连续。**不许「顺手统一」**——统一任何一边，另一边的截图基线全部作废 |
| 变化来源 | `size` 只在 `graph-model.ts` 由 `degree` 分档（0–1 / 2–4 / 5–9 / 10+，A2 规则 8）；布局与渲染都不许重新分档 |

**A3.2 相机机位与节点视觉尺寸（2026-11-13 B2 实测，v1.4 补）**

| 项 | 口径 |
|---|---|
| 机位 | `CAMERA_POSITION = [0, 142, 550]`（世界单位），`fov 45 / near 1 / far 4000`。B2 原实现为 `[0, 160, 620]`——v1.3 附录并没有钉过机位，那个值只存在于 B 线实现与 §14 运行日志里；实测星群亮部包围盒只占画面 **~66% × 70%**，低于验收要点 2 的 75–85%，于是沿同一条视线方向推近 **1.13 倍**（620 → 550，仰角不变）。现测 **76.0% × 80.8%** |
| 不动的部分 | **相机目标仍是原点**（`controls.target = (0,0,0)`），自转组的旋转中心也在原点。三层盘 `r = 85 / 150 / 210`、垂向抖动 `±10 / ±22 / ±32`、不可达 `r = 340`、`SIZE_WORLD_RADIUS` 的 1.9–4.4 **全是世界单位，一个都没改**。机位是渲染层常数：不进布局、不进 view-model、不影响 2D、不影响缓存键与 `layoutVersion` |
| 控制器边界（v1.5 核对） | `controls.minDistance = 260`、`controls.maxDistance = 1100`，与 A3.1 的「相机 260–1100」同一口径，代码一致。**`minDistance` 中途曾被改成 120，v1.5 已改回 260**：120 小于三层盘外圈半径 210，相机推近到该距离就已落进盘面内部，节点投影会随距离急剧放大、失去星群构图；260 与 A3.1 的「260–1100」是同一个数，改这个值时请连同本行与 A3.1 一起改，不要只动代码 |
| 节点视觉尺寸 | `NODE_SIZE_SCALE = 1.6`：渲染半径 = `visualRadius(result.radius[i]) = result.radius[i] × 1.6`（星核先取 `max(base, 5.4)`，选中再 `×1.15`）。理由：布局给的 1.9–4.4 在 1440×900 下投影只有 1.7–3.9px，SDF 六种形状分不出来；×1.6 后普通节点约 2.7–4.6px、星核约 7.5px |
| 选中环 / 光晕 / 边 | 选中环 quad = 视觉半径 **×1.7**，环带画在 quad 的 `0.84` 半径处，宽度按屏幕导数抗锯齿（约 1–2px，不随节点缩放变粗）；光晕 quad = 节点半径 **×3.2**，不透明度选中 / 中心 **0.22**、枢纽 0.08；边三组：accent **2.2px / 0.92**、strong **1.25px / `--graph-edge-strong` 的不透明度**、默认 1px / `--graph-edge` |
| 归属 | 以上全是 B 线渲染常数（`src/lib/graph-render.ts` 导出的 `NODE_SIZE_SCALE / CORE_WORLD_RADIUS / SELECTED_SCALE / HALO_SCALE`，加 `node-field.tsx` / `edge-field.tsx` 里的局部常量），**不是模型数据、也不是布局参数**：`graph-model.ts` 不出现任何像素值，`layoutGalaxy3d` 的 `radius` 保持世界单位。改这些值**不需要动三个冻结件**，但会让 3D 截图基线过期，必须与基线成对更新（A7「合并与回滚」） |
| 2D 不适用 | 2D 半径仍是 `clamp(5 + 3.1 × √degree, 5, 20)` 屏幕像素；`NODE_SIZE_SCALE` 只在 3D 渲染层生效，与 A3.1 的「不许顺手统一」同一口径 |

#### A4. 2D 与 3D 的共享边界：选中、邻域、路径只算一次

```ts
// src/lib/graph-selectors.ts
export interface GraphSelection {
  /** URL ?focus=，2D 的圆心、3D 的取景中心；与「选中」是两件事。 */
  readonly focusId: string | null;
  readonly selectedId: string | null;
  readonly hoverId: string | null;
  /** 「查看路径」的目标端点；null 表示不显示路径。 */
  readonly pathTo: string | null;
}

export interface GraphHighlight {
  /** 需要点亮的节点（选中 + 1 跳邻域 + 路径）。 */
  readonly nodes: ReadonlySet<string>;
  readonly edges: ReadonlySet<string>;
  /** 其余节点降不透明度；空集表示不降（无选中时）。 */
  readonly dimmed: ReadonlySet<string>;
  /** 需要压暗的**边**（= 全部边 − `edges`）；同样只在选中时非空。 */
  readonly dimmedEdges: ReadonlySet<string>;
  /** 路径的节点序列，含两端；无路径为 null。 */
  readonly path: readonly string[] | null;
}

export function selectGraphHighlight(view: GraphViewModel, sel: GraphSelection): GraphHighlight;
export function findShortestPath(view: GraphViewModel, fromId: string, toId: string): string[] | null;
```

- 三个渲染器（3D / 2D / 列表）**只消费 `GraphHighlight`**，不许自己算邻域、不许自己算路径。两边各写一遍 BFS，就是两份真值——这是本附录要防的第一件事。压暗同理：节点的 `dimmed` 与边的 `dimmedEdges` 都在这里算好，渲染器**不许自己求「全部边 − 高亮边」的补集**——补集看着只有一行，但 2D 与 3D 各写一遍，就会在平行边合并、悬空边、`weight > 1` 的边上分叉。
- `GraphSelection` **不进 view-model**：选中是视图态，写进模型会让「点一下」变成模型失效、布局缓存 miss、整图重排。
- 数据流单向：组件只往上抛意图（`GraphIntent = "select" | "focus" | "hover" | "toggle-mode" | "change-depth"`），状态由容器改写 URL，再作为 props 下来。渲染器不持有模型之外的图状态。
- 性能：`selectGraphHighlight` 在 ≤600 节点上是一条 BFS + 一次集合构造，登录后每帧调用也够用；**不要顺手加 memo 依赖整张 view 对象**（引用稳定性不保证），要 memo 就 memo 在 `view.modelVersion + sel` 上。

#### A5. 数据契约

**A5.1 `GET /api/graph` 增加 `maxNodes`**

| 项 | 规格 |
|---|---|
| 参数 | `maxNodes`，可选，整数 **50–600**，缺省 150 |
| 校验 | 非整数 / 越界 → `ValidationError`，与 `depth` 同风格（`{ field: "maxNodes" }`），走 `respond.ts` 既有 `{ error: { code, message } }` |
| 实现位置 | 只改 `src/app/api/graph/route.ts` 的解析与服务层一处校验；`GraphGateway`（`graph-service.ts:399` 的 `options.maxNodes ?? 150`）不动 |
| 副作用 | 无。`depth` 与 `label` 的既有语义不变 |

**A5.2 两个请求、一个模型**

`/api/graph` 返回的是裸 `{ nodes, edges }`，**没有任何 meta**；`failed` 与 `lastSync` 来自 `/api/graph/status`。所以 `buildGraphViewModel` 的输入是 `(subgraph, status | null)`，容器负责并发取两个接口，任一个失败都仍要能构图：

| 情况 | 行为 |
|---|---|
| graph ok + status ok | 正常；`sources = { graph: "ok", status: "ok" }` |
| graph ok + status 失败 | 图照常显示；状态条只显示「构图进度暂不可用」，**不阻塞**；`sources.status = "error"` |
| graph 失败 | 整页错误态（走 `error.tsx` / 页内错误分支），不构造空图 |
| `status.failed` 非空 | 工具条警示 chip + 可展开列表，2D / 3D / 列表三视图共用同一个状态条组件 |

`GraphFailure` 只有 `{ objectId, error }`，**没有 title**。v1 显示 `objectId` 前 8 位 + 错误原文；加 title 需要后端 join 对象表，属于 06_API 的独立待办，本期不做、不许前端自己发 N 个请求去凑。

**A5.3 截断推断（单向，只能漏报不能误报）**

```ts
truncated = receivedNodeCount >= requestMaxNodes;   // received = 服务端过滤后返回的 nodes.length
truncatedSource = "inferred";
```

- 必须写成**反向不成立**：`nodes.length < maxNodes` **不代表没截断**——ADR-011 的账号过滤发生在截断之后，先取 150 再按归属筛，返回 40 个也可能是被截断的。
- 因此这句只用于文案「可能只显示了最近 N 个实体」，不能用于按钮禁用、不能用于「已全部加载」的断言。
- 唯一正确解是后端返回 `truncated: boolean`；届时只改 `truncatedSource = "server"`，界面不动。这条写进 06_API 待办。

**A5.4 不变的部分**：`depth` 1–3、`label` ≤100、错误体形状、`/api/graph/sync` 与 `/api/graph/query` 的请求形状全部不动；按对象重试（`{ objectIds? }`）仍是**缓议**，不进本期。

#### A6. 单测清单（node 环境，纯函数；不引 jsdom、不测 WebGL）

| 文件 | 必测项 |
|---|---|
| `tests/lib/graph-model.test.ts` | 六类映射 + 未知类型 + 大小写 + 中文类型名 + 空 `entity_type`；`entity_type` 里带空格/全角；`shortLabel` 中文 12/10 字、英文、超长、纯 emoji；`degree` 与自环/悬空边的 `dropped` 计数；`size` 三个档界的节点（1/2/4/5/9/10）；排序（hop/degree/id）逐项；同 id 去重；`center` 不在集合里不抛错；纯函数不 mutate 入参（`Object.freeze` 断言）；`meta.total / requestMaxNodes / sources` 组合 |
| `tests/lib/graph-contract.test.ts` | `maxNodes` 解析：缺省 150、边界 50/600、49/601、`"abc"`、`"2.5"`、空串；`nodes.length >= maxNodes` 的截断推断（含「小于也不代表未截断」的反证用例）；`failed` → 状态条模型（0 / 1 / 多条、错误原文保留）；status 为 null 时的降级 |
| `tests/lib/graph-layout-3d.test.ts` | 同输入同输出（两次调用 `positions` 逐字节相等）；中心在原点；1/2/3 跳半径单调；无 `NaN` / `Infinity`；最小间距；`anchors` 保持（同一中心连算 5 次位置集合不变；换中心时共有节点位移 < 阈值）；`maxTicks` 上限触发 `ticks` 截断；空图 / 单节点 / 全不可达碎图；`indexById` 与 `ids` 互逆 |
| `tests/lib/graph-layout-2d.test.ts` | 设计稿 §6 的力导向：确定性、预算、边界钳制；`layoutRadial` 既有用例不动 |
| `tests/lib/graph-render.test.ts`（B 线，v1.4 补登记） | 渲染层里那批**不碰 WebGL** 的纯函数：色值解析与 sRGB → 线性、六种形状的 SDF 序号、边三组拆分（accent / strong / base，组内保 view 顺序）、锚点推断、标签优先级与档位上限（12 / 24 / 40）、屏幕空间避让（高优先占位、forced 夹回视口、普通标签内移或丢弃）、布局缓存键（顺序无关 / 换中心换键 / 带算法版本）与 Worker 阈值、`anchors` 透传、视觉半径缩放（星核抬到 5.4 再 ×1.6、选中 ×1.15）、星场确定性、图集打包 |
| `tests/lib/graph-quality.test.ts` | `selectGraphMode` 全组合（webgl × reducedMotion × nodeCount × urlMode）；档位选择；只降不升；DPR 上限 |
| `tests/lib/graph-selectors.test.ts` | 邻域集合（0/1/2 跳）、`dimmed` / `dimmedEdges` 与空集（含「全部边 − 高亮边」的补集断言，平行边与悬空边各一例）、`findShortestPath` 命中/无路径/自反/端点不存在、选中不进模型 |

- 组件层只测**降级分支**：`selectGraphMode` 与 `deriveGraphUiState` 是纯函数，分支在单测里覆盖；组件本身的可见结果由浏览器验收脚本按 `window.__graphStats` 与截图覆盖。为几个分支给全仓引一套 DOM 环境不划算。
- **不写 WebGL 单测**：headless GL 的结论与真实 GPU 无关，只会给出「测试通过但线上掉帧」的假安全感。
- 预计新增 6 个纯函数文件约 60–70 项（B 线渲染层的 `graph-render.test.ts` 另计，v1.4 登记）。**基线以冻结当天现测为准**（2026-11-13 实测 **46 个测试文件 / 675 项：672 过、3 跳过**；`vitest` 的 `Test Files 45 passed | 1 skipped (46)` 与 `Tests 672 passed | 3 skipped (675)`）。**本机必须 `vitest run --maxWorkers=2`**：默认 worker 池在这台机器上会起 5 个测试进程并报 JS heap OOM，降到 2 worker 全绿——这是机器内存压力，不是用例问题，但写进基线口径，免得下一个人以为测试自己不稳。附录早稿的「31 文件 / 392 项 → 37 文件 / 455–465 项」是手抄推算，不再引用。A 线冻结提交时把当次 `npm test` 的文件数 / 用例数写进 `05_CHANGELOG`，不写进本附录。

#### A7. 并行分线与文件边界

**分线顺序**：A 线第 1 天先单独落三个冻结件（`graph-model.ts`、`graph-quality.ts`、`graph-selectors.ts`）+ 对应单测，`npm test` 绿后**接口冻结**（本附录即在此时生效），之后 A/B 并行。

| 归属 | 文件 | 说明 |
|---|---|---|
| **冻结件**（先落，之后只读） | `src/lib/graph-model.ts`、`src/lib/graph-quality.ts`、`src/lib/graph-selectors.ts` | 三个文件的类型与签名 = 本附录 A2 / A4；改动走冻结规则 |
| **A 线**：view-model + 2D + 容器 | `src/lib/graph-layout-2d.ts`、`src/components/graph/graph-stage-2d.tsx`、`src/components/graph-explorer.tsx`、`src/app/graph/page.tsx`、`src/app/graph/error.tsx`、`src/app/globals.css`（`[data-surface="graph"]` 块）、`src/app/api/graph/route.ts`（`maxNodes`）、`scripts/check-theme.mjs`、`scripts/check-contrast.mjs` | A 独占 `globals.css`；A 负责 `package.json`（加 fiber、`three` 锁精确版本） |
| **B 线**：3D 场景 | `src/lib/graph-layout-3d.ts`、`src/workers/graph-layout.worker.ts`、`src/components/graph/graph-scene-3d.tsx`、`src/components/graph/{node-field,edge-field,label-layer,starfield}.tsx`、`scripts/graph-perf.mjs` | **B 不写任何 CSS**（3D 的视觉全在 WebGL 里，舞台外框归 A） |
| 共用只读 | `package.json` / lockfile、`src/components/graph/types.ts`（若需要，只有类型再导出） | B 不跑 `npm install`；要新依赖先提 A，由 A 加 |

**禁止条款（review 时逐条核）**

1. **B 线不得修改** `graph-model.ts`、`graph-quality.ts`、`graph-selectors.ts`、`graph-explorer.tsx`、`globals.css`、`src/app/graph/*`、`src/app/api/graph/*`。
2. **A 线不得修改** `graph-layout-3d.ts`、`src/workers/*`、`src/components/graph/graph-scene-3d.tsx` 与三个 field/layer 组件。
3. 两条线都不得新增 `src/lib/graph-*.ts` 之外的共享文件；需要新共享件，先在本附录登记归属。
4. 两条线都不许在组件里出现类型名 / 色值 / 形状字面量（渲染器只读 `node.type / shape / colorToken`）。
5. 测试文件不共享：A 写 `graph-model / graph-layout-2d / graph-quality / graph-selectors / graph-contract`，B 写 `graph-layout-3d / graph-render`（后者 v1.4 按实际落地补登记）；谁都不改对方的测试。

**A7 唯一的 `window` 例外：`window.__graphLabelBoxes`（v1.4 补，dev-only）**

前文「B 线不碰 `window`」补一处**明确例外**，范围只到这一行，不构成「B 线可以随便写 `window`」：

- **写什么**：`src/components/graph/label-layer.tsx` 在 `process.env.NODE_ENV !== "production"` 时，把当帧**实际绘制**的标签框写成 `window.__graphLabelBoxes = [{ id, x, y, w, h }]`（屏幕像素，保留 1 位小数）；这些框就是 `layoutLabels` 的输出、也是顶点着色器用的同一个矩形。
- **为什么**：验收要断言「屏幕上真实标签框两两相交 = 0」。只读 `__graphStats.labels` 只能证明「画了几个」，证明不了「没压住」；而让验收脚本自己重算框，等于在脚本里再实现一遍避让——两份真值，动画和脚本会各说各话（§14 第 5 条修的就是这种错位）。
- **边界（四条）**：① **只在非生产构建写入**，生产构建不写、不留任何全局；② 命名空间**只此一个**，不许再开第二个 `__graph*` 诊断口；③ 读方只有 `scripts/graph-perf.mjs`，组件、容器与产品代码都不读它；④ 它**不豁免其他条款**——B 线仍不得为功能写 `window`（`__graphStats` 仍由 A 线写），A 线仍不得读 canvas。

**B 线对外只暴露一个组件**（A 的容器按此调用，props 即契约）：

```tsx
// src/components/graph/graph-scene-3d.tsx —— 只被 dynamic(..., { ssr: false }) 引入
export interface GraphScene3DProps {
  view: GraphViewModel;
  highlight: GraphHighlight;
  tier: QualityTier;
  autoRotate: boolean;
  onIntent: (intent: GraphIntent, id?: string) => void;
  /** 布局完成并画出首帧时调用一次（含布局读数，A 线据此填 `__graphStats` 的首帧部分）。 */
  onReady: (stats: {
    layoutMs: number;
    layoutTicks: number;
    truncated: boolean;
    drawCalls: number;
  }) => void;
  /**
   * 运行时读数，**每 30 帧发布一次**（`frameloop="demand"` 下按每 30 次 `invalidate` 计；
   * `visibilitychange` 隐藏后停止发布，恢复时补发一次）。
   * **只上报、不改档位**：档位由 A 线按 `selectGraphMode` 与「只降不升」规则决定，
   * 再作为只读 `tier` 传回本组件。B 线不得据此自行降档、改标签预算或写 `window`。
   */
  onStats: (stats: {
    frames: number;
    avgFrameMs: number;
    labels: number;
    drawCalls: number;
    dpr: number;
    rafActive: boolean;
    layoutTicks: number;
    truncated: boolean;
  }) => void;
  onError: (reason: "context-lost" | "chunk-failed" | "webgl-unavailable") => void;
}
```

> **`onStats` 是 2026-11-13 补的回路（v1.2）**：没有它，ADR-022 第 15 条要的 `frames / avgFrameMs / labels / dpr / rafActive` 无处产出，第 8 条的自适应降档也没有输入。分工写死：**B 测量并上报，A 汇总进 `window.__graphStats` 并决定档位**（口径与首页 `__galaxyStats` 同风格、互不复用）；`tier` 始终由 A 只读传入。B 线不碰 `window`，A 线不碰 canvas。

`QualityTier` 不是本附录新造的类型：它由冻结件 `src/lib/graph-quality.ts` 定义并导出，取值为 `"low" | "balanced" | "high"`，三档对应的节点 / 边 / 标签 / DPR 上限见 ADR-022 正文第 8 条的档位表，与设计稿 §8.2 一致。B 线只 import 该类型，不自行声明。

**合并与回滚**

- 合并顺序：冻结件 → A（2D 全流程可用、`test` 绿、截图基线成对更新）→ B（`mode=3d` 成为默认）。B 后合并是因为 A 的容器是宿主。
- B 的提交必须能单独回滚：关掉 3D 入口只改 `selectGraphMode` 一处（`webgl: false` 或删掉 3D 分支），其余代码不动。
- 每线的独立验收：A 通过 `?mode=2d` 走完设计稿 §5 全流程 + `npm test`；B 通过 `graph-layout-3d.test.ts` + `/graph?mode=3d` 手动核对 `__graphStats`（`drawCalls ≤ 8`、空闲 `frames` 不再增长）。

#### A8. 与设计稿的口径统一（`docs/16_GRAPH_DESIGN.md`）

| 处 | 统一后的口径 |
|---|---|
| §4.3 三层盘 | 那是**播种**，不是最终布局；松弛在 `layoutGalaxy3d` 内完成（A3）。设计稿的数值原样进 `DISK_SEED` 常量。 |
| §4.4 度数分档 0–1 / 2–4 / 5–9 / 10+ | 已采纳为 `size` 档 `s/m/l/xl` 的定义（A2 规则 8），不再另算分位数。 |
| §10 改造映射里的 `computeDegrees` / `layoutForce` / `bfsPath` / `placeLabels` | 度数归 `graph-model.ts`（`computeDegrees` 不再单独存在）；2D 力导向与标签放置归 `graph-layout-2d.ts`；`bfsPath` 归 `graph-selectors.ts`（只有一份）。`src/lib/graph-layout.ts` **只保留 `layoutRadial` 作为降级基线与旧测试**，不再加新函数。 |
| §4.7「后处理：可选 UnrealBloom」 | v1 **关闭**，与 ADR-022 第 2 条一致（它会多一个 pass 与 draw call 预算）。要开另开 ADR。 |
| §4.7 DPR `min(dpr,2)` / 移动 1.5 | 与 ADR 三档 `2 / 1.5 / 1` 不冲突：`1` 是给软件渲染与连续掉帧的兜底档。 |
| §4.7 色调映射 `ACESFilmicToneMapping` / exposure 1.0 | **不采纳，实现用 `NoToneMapping`**（`starfield.tsx` 的 `handleCreated` 里显式 `gl.toneMapping = NoToneMapping`，`outputColorSpace = SRGBColorSpace`）。理由：ACES 会压高光、整体提亮中段，节点色就不再等于 token 里的 hex，`scripts/check-contrast.mjs` 的对比度读数与截图基线对不上；舞台靠「淡出 + 雾」控制亮度，不需要胶片曲线。**后来者不要「按设计稿修回去」**——真要开 ACES，得连 token、对比度脚本、全部 3D 截图基线一起重做，那是新 ADR。设计稿 §4.7 与 §4.7 末段「效果上限靠色调映射控制」这两处的这一行随之作废，其余行（antialias、雾、后处理、阴影、帧循环）仍然有效 |
| §4.2 自转 `0.55°/s`（默认开） | **与 ADR-022 第 7 条冲突，采纳 ADR：默认关**。理由：常驻自转 = 永远不空闲，验收第 4 条（空闲 `frames` 增量 0）直接失败。改为工具条上的显式开关「缓慢自转」；开启时 `rafActive = true`、验收第 4 条只在该开关关闭时评估。`prefers-reduced-motion` 下开关不出现。 |
| §4.5 「方向脉冲：朝 target 移动的微光」 | **与 ADR-022 第 12 条冲突，取消方向表达**：`source/target` 是抽取方向，不是语义方向，画成"流"等于替数据编造因果。3D 不画箭头、不加移动光点；2D 只在选中单条关系时于详情栏写 `A —关系→ B` 原文。`GraphEdge.direction` 恒为 `"none"`。 |
| §4.5 边宽 0.5–1px（`LineBasicMaterial` 的 `linewidth` 在多数平台被忽略） | 这条是对的，实现必须用 three 自带的 `LineSegments2` + `LineMaterial`（`three/examples/jsm/lines/*`，**不是新依赖**）。按「默认 / 结构 / 选中」分 3 组，draw call 3：星场 1 + 光晕 1 + 节点 1 + 边 3 + 标签 1 + 选中环 1 = 8，正好到顶。超预算时先把「结构」并入「默认」（边 2 组）。 |
| §4.4 选中环 `#E9C08A` | **与「概念」类型色完全同值**：概念节点被选中时环与描边同色，等于没有选中态。`--graph-accent` 改用暖白 `#F6E3C6`（**已定稿，2026-11-12**，Designer 设计稿 §4.7 按本行授权取值，同时用作键盘焦点色）；**命名先冻结**，A/B 都读 `--graph-accent`，不再各自挑色。 |
| ADR-022 第 13 条「设计稿 §4.6 那组 token」 | 设计稿重写后 §4.6 已是「背景与运镜」，那组 token 不存在了。v1 名单以附录 **A2.1 的 12 名**为准。 |
| ADR-022 第 5 条的跳半径 `1.0 / 1.9 / 2.7` | 那是**归一化比例**（1 : 1.9 : 2.7），只用来校验三层盘的半径关系；**世界单位以 §4.3 的 `85 / 150 / 210` 为准**（与相机 260–1100 同空间）。两张表同时存在时容易照错的正是这一层。 |
| §5.2 2D 仍写 v1 字面量：画布 `#06050a`、边 `rgba(243,239,231,.18)` | 与 token（`--graph-canvas #050408`、`--graph-edge 14%`）差 1–2/255 与 4 个百分点。**不改数值、也不新增第 13 个 token**：在 `[data-surface="graph"][data-mode="2d"]` 覆盖同名 token（A2.1 末段），组件照旧只读 token，否则就撞上 A7 禁止条款 4。 |
| §8.2「自适应：稳定 10s 后才允许回升」 | **与 ADR-022 第 8 条冲突，采纳 ADR：只降不升**。回升会让同一页出现画质反复跳动，`__graphStats.tier` 的验收基线也不可复现；降档只在掉帧窗口内发生，一页最多两次、间隔 ≥3s。 |
| §8.2 降档触发「连续 2s 低于 50fps」 | 阈值等价（50fps ≈ 20ms/帧），**窗口以 ADR 为准：连续 60 帧 `avgFrame > 20ms`**（≈1s@60fps）。50fps 只是 high 档的验收目标，不作触发条件。 |
| §8.2「手动『低画质』优先」 | ADR 未定义手动档位。保留为 A 线工具条的画质菜单，**只允许向低档**，自动档仍只降不升；不扩 `GraphIntent`（B 线不感知，`GraphScene3DProps.tier` 照旧只读最终档）。 |

#### A9. 验收读数与运行时契约（2026-11-13，v1.4 补读数与契约、v1.5 补端到端与现状核对、v1.6 补生产运行时复验）

**A9.1 B2 实测读数：参考值，不是硬指标**

测试条件：无头 Chrome、真实 WebGL 但走 SwiftShader 软件渲染、`1440×900`、`dpr = 1`、150 节点 / 157 边、`high` 档（除非另注）。读数由 `window.__graphStats`（A 线写）与 `window.__graphLabelBoxes`（A7 唯一例外）产出，脚本 `scripts/graph-perf.mjs`；同脚本每次重跑覆盖 `docs/screenshots/phase6d-*.png`。

| 场景 | tier | drawCalls | labels | frames | 布局 |
|---|---|---|---|---|---|
| 默认视角 | high | **6** | 28（预算 40） | 2（发布节拍） | 6.9 ms / 80 ticks |
| 选中 + 路径 | high | **8** | 28 | 2 | 6.9 ms / 80 ticks |
| 低档窄屏 `390×844` | low | 6 | **8**（预算 12） | 2 | 6.7 ms / 80 ticks |
| 自转开 2 s | high | 6 | 27 | 2 s 内 240 帧（计数器 120 → 360） | 同上，`avgFrameMs ≈ 8.3` |
| 静止 2 s | high | — | — | **增量 0**（`rafActive = false`） | — |

口径三条：

1. **这些数字是参考读数，不写进验收判定。** 正文验收要点 2 的「high 档 `avgFrameMs ≤ 8`（硬件 GPU）」没有被它们满足也没有被它们否定——软件渲染的帧时序不代表真机，6.9 ms 是**布局**耗时不是帧耗时。
2. `drawCalls 6 / 8` 是本层的**实测上限**，与正文第 6 条的 ≤8 预算一致。分解：**6 = 星场 1 + 光晕 1 + 节点 1 + 边 2（base / strong；accent 组为空时不挂载）+ 标签 1**；选中态再多 **边 accent 1 + 选中环 1 = 8**。任何一次改动把默认视角推到 7，都说明多挂了一个 pass 或一组几何，按违约处理。
3. 「帧增量 0」的评估前提是自转开关**关闭**且标签页可见，与验收要点 4、A8 的自转裁决同一口径。

**A9.1b 真实 Worker 端到端读数（2026-11-13，v1.5 补；同样是参考值）**

条件同 A9.1，`GRAPH_PERF_NODES=600` 的宽夹具（两个互不相连的枢纽，各自深度 3 可达 **373 个实体 / 372 条边**），`?maxNodes=600`，`high` 档，同一脚本 `scripts/graph-perf.mjs`。

| 项 | 读数 | 说明 |
|---|---|---|
| Worker 内布局 | `layoutMs` **56.2–59.6 ms / 150 ticks** | 对比 150 节点基线 7.1 ms / 80 ticks：节点 2.5×、tick 1.9×，耗时却约 8×。两组的度数分布与边数都不同，本轮没有逐项拆解来源，但**结论够用：布局耗时不可按节点数线性外推，600 档的预算按这条实测曲线估** |
| Worker 回包 | 约 **85 ms** | 含序列化与调度 |
| 端到端 | 约 **795 ms** | 首帧到图出现，低于验收要点 3 的 1200 ms（150 基线没有同口径的端到端读数，不做对比，避免拿两个夹具互相校） |
| 渲染 | `drawCalls 6`、`labels 21`、`dpr 1`、`truncated = false` | 请求的 600 已到 A5.1 上限；`truncated=false` 说明夹具本身没被截断 |
| 通道证据 | 页面探针看到 `new Worker(...)` 实参含 `src_workers_graph-layout_worker_ts`；CDP 有 1 个 `type:"worker"` 目标；Worker 实际回 `done`；无 `Module not found` / `chunk-failed` / `g3-stub` | 「用了真 Worker」以这四条为准，不看耗时推断 |
| 150 基线复测 | `layoutMs 7.1 ms / 80 ticks`、`drawCalls 6`、`labels 28`、标签重叠 **0** | 与 A9.1 表里的 6.9 ms 是同一测量在噪声内（±0.5 ms），两者都作参考值，不取其一作硬指标 |

换中心路径的实测结论（v1.5 补）：旧中心的 `done` 可能在新 `layout` **之后**返回，被客户端丢弃，最终采纳新中心的布局——结果正确，但**这条路径上 `cancelled` 回执出现 0 次**：旧请求已经开始执行，按 A3「队列丢弃」语义只有尚未开始的排队请求才会被 cancel。因此**端到端从未收到过 `cancelled`**，该回执只有单测口径，不能在验收记录里写成「实测到取消」。

**生产构建（v1.5 补，v1.6 更新）**：`NEXT_DIST_DIR=.next-build npm run build` 退出 0，产物里全部路由为动态渲染、构建期不连库。**生产运行时已复验**（`next start`，见 A9.6）：默认入口、`?maxNodes=600` 真 Worker、low 档抽稀、自适应降档四项全部通过，`next dev` 与生产构建之间没有观察到行为差异。仍未验证的只剩真实 Logto 会话、真实 LightRAG 下游与硬件 GPU 帧时序（A9.6 末段三条）。

**A9.2 §8 自适应降档的实现契约（代码已接线，2026-11-13 实跑降档路径；真机 GPU 验收未做）**

正文第 8 条只给了阈值与次数；落进容器需要更死的口径，否则两个人会写出两套窗口。以下与容器现实现（`graph-explorer.tsx` 的 `handleSceneStats`）逐条一致：

- **只看 3D 且在看帧时**：`mode === "3d"` 且 `rafActive === true` 才推进窗口。`rafActive === false`（空闲、页面隐藏、`frameloop="never"`）的发布**直接跳过**：不累积、不判定，绝不把「没有帧」当成低帧耗时。
- **空闲会打断连续性（v1.5 补）**：以下四条都会把 `slowWindows` **清零**，并从当前 `frames` 重新起算，绝不跨空闲把两次慢窗口拼起来——
  1. `mode !== "3d"`（切到 2D / list）；
  2. `rafActive === false`（无帧发布：静止、后台标签页）；
  3. `frames` 与上次记录**相同**（同一窗口的重复发布，没有新帧）；
  4. `frames` **小于**上次记录（帧计数器回绕 / 换布局归零）。

  只有「`frames` 有增长、且本窗口 `avgFrameMs > 20ms`」才累加。等价说法：**连续性只认「真有新帧的相邻窗口」，「连续两个发布窗口」的定义不变，仍 ≈ 60 帧**（B 每 30 帧发布一次）。这条比 v1.4 的措辞更严：原稿只写了「任一次低于阈值即归零」，够不到「空闲之后不清零」这种误判——空闲 10 秒再回来，旧实现会把空闲前那一次慢窗口当成第一次，第二个慢窗口就误降一档。
- **窗口单位是发布次数，不是帧**：B 每 30 帧发布一次 `onStats`，容器按「连续 2 次发布都 `avgFrameMs > 20ms`」计数。这与正文的「连续 60 帧平均 > 20ms」等价，但**实现里只有 `SLOW_FRAME_MS = 20` 与 `SLOW_WINDOWS = 2` 两个常量**，不许再按帧数另算一遍。任一次发布低于阈值即把窗口计数归零。
- **`frames` 回绕**：B 的帧计数器在布局更换后归零。新值小于上次记录时**只重新起算窗口**（即上条第 4 项），不判降档（否则每次换中心都可能误降一档）。
- **动作**：降一档（high → balanced → low），**只降不升**；`MAX_TIER_DROPS = 2`（一页最多两次）、两次之间 `TIER_DROP_COOLDOWN_MS = 3000`。已在 `low` 时不再降。
- **档位只有一个来源**：降档时用 `TIER_ORDER` 取「比当前低一档」写进 `tierCeiling`，再由 `selectGraphMode({ ..., previousTier: tierCeiling })` 参与决策——容器**不另造档位表或档位序**。`previousTier` 是上限：它只能把档位压低，不能抬高。
- 降档后 DPR 上限、标签预算、节点上限随正文第 8 条的档位表生效；节点数超出新档上限时才触发 A9.3 的抽稀。
- **实跑记录（2026-11-13，参考值）**：`PHASE6D_STEPS=downgrade` + DevTools 24× CPU 降速，档位由 `high` 掉到 `balanced`（掉档窗口 `avgFrameMs 54.38`），页面出现播报「已自动降低画质以保持流畅」；**撤销 CPU 降速后仍是 `balanced`**——这正是「只降不升」的预期表现，不是没恢复。真机 GPU（非软件渲染）下的掉帧阈值仍未验证。

**A9.3 §9 抽稀的施加范围（A 线代码已接线，v1.6 已跑生产运行时验收）**

- `next dev` 下 373 节点的 Worker 实测**没有触发抽稀**：373 < `high` 档的 600 节点预算，`overBudget` 为假。抽稀的真实验收要一个「返回节点数超过当前档位预算」的组合，例如 `?maxNodes=600` 配 `balanced`（300）或 `low`（150）档。**v1.6 已跑到该组合**：390 宽 + `?mode=3d` 落在 `low` 档，373 > 150 触发抽稀，页面渲染 **133 个实体 / 132 条关系**并播报「另有 240 个实体未显示」（读数见 A9.6 第 3 项）。A9.3 由「代码已接线、未跑」改为**已跑（生产运行时）**；仍缺的是**真机 GPU 下抽稀后的帧率**，本轮只验了「抽到多少、播报对不对」，没验「抽完以后多快」。
- **只有 3D 吃抽稀**：容器在 `selectGraphMode(...).overBudget === true` 时，对 **3D 渲染视图**调 `decimate(view, { budget, keepIds })`；`mode !== "3d"`（2D / list）直接返回**原 view**，不抽稀。理由：列表是等价信息通道（正文第 1、10 条），抽稀会让读屏与键盘用户少数据；2D 有自己的布局预算。
- `keepIds` = **当前中心**（`displayCenter`）+ **选中** + **hover** + **路径端点**（`pathTo`，存在时）。`decimate` 内部已保留全部 1 跳，容器不重复保留。
- 2D 超预算（>600）由 2D 布局自己的预算处理，**不共用** 3D 的 `decimate` 结果——两个渲染器两套坐标，共用一份可见集合迟早漂。
- `decimate` 是纯函数、保留集合确定可单测（`graph-quality.test.ts` 已覆盖）；容器只负责「选哪份 view 交出去」。

**A9.4 `?maxNodes`：验收诊断参数（2026-11-13 已接线，v1.5 改写）**

- 形态：`/graph?maxNodes=<50–600 整数>`，缺省 150；**仅 URL 诊断，无 UI 控件**，不进工具条、不进 `GraphIntent`。
- 性质：它只是把 A5.1 已经有的 `maxNodes` API 参数暴露到页面上，**不是新产品行为**；服务层校验仍沿用 A5.1（非整数 / 越界 → `ValidationError`），页面这一层遇到非法值**回落 150** 而不是整页报错——页面是 SSR，脏参数不该把整页打成错误页。
- 实现（`src/app/graph/page.tsx` 的 `parseMaxNodes`）：只接受 50–600 的整数，`null` / 空串 / 小数 / 越界 / 非数字一律回到 `GRAPH_MAX_NODES_DEFAULT`（150）。解析出的同一个值**同时**给 SSR 的 `getGraphNeighborhood` 首屏预取和 `GraphExplorer` 的 `maxNodes` 属性，客户端换中心时才和首屏同规模；两处取不同值就是「首屏与点选后是两个规模的图」。
- 用途：`GRAPH_MAX_NODES_DEFAULT = 150` 时 UI 永远走不到 301+ 的 Worker 分支与「2 跳按度数补齐」的抽稀路径，这两段在验收里原本不可达（§14 记为未验证项）。**Worker 分支已用 `?maxNodes=600` 补上读数（A9.1b，373 节点 / 372 边）；它的生产验收同样是这个参数——v1.6 的 `next start` 复验就是靠 `?maxNodes=600` 把真 Worker 拉起来的（A9.6 第 2 项），抽稀分支也在同一参数落到 `low` 档时跑到（A9.3、A9.6 第 3 项）**。这个参数是把大图路径测起来的**唯一入口**，不是给用户用的开关。
- 边界：它只改「请求多少」，不改档位、不改抽稀预算、不改缓存键的构成；档位仍由 `selectGraphMode` 与 `tierCeiling` 决定。600 是 A5.1 的上限，**不要为了压测在页面上放开到 2000**——正文第 12 条的 601–2000 是另一条产品路径（默认只渲染 1 跳 + 显式「展开更多」），不走这个参数。

**A9.6 生产运行时（`next start`）复验（2026-11-13，v1.6 补）**

v1.5 记的是「生产构建通过、运行时未实测」。本节把那条「未验证③」补上：四项在**真实生产构建 + `next start`** 下跑通。读数来自 `scripts/phase6d-capture.mjs` 的 `PHASE6D_PROD=1` 分支，截图五张：`docs/screenshots/phase6d-3d-default-entry-prod.png`、`-worker-600-prod.png`、`-worker-600-prod-switch.png`、`-decimate-prod.png`、`-downgrade-prod.png`。

| # | 场景 | 生产运行时读数 | 判定 |
|---|---|---|---|
| 1 | 默认入口（不带 `?mode`） | `data-mode="3d"`、画布存在、`.g3-stub` 计数 **0**、工具条「星系」`aria-pressed="true"`、提示条「40 个实体 · 49 条关系」、`window.__graphStats === undefined` | 通过：生产态默认 3D 入口成立，且 dev 钩子确实没有泄漏到线上 |
| 2 | `?maxNodes=600` + 宽夹具（373 实体 / 372 边） | CDP `Target` 域有 **1 个 `type:"worker"` 目标**；换中心到「宽图枢纽二」后仍 **373**、worker 目标仍在、无 `chunk-failed` / `Module not found` | 通过：生产构建下 Worker 真的跑起来了，换中心不会悄悄回落到主线程布局 |
| 3 | 低档抽稀（视口 390 宽 + `?mode=3d`） | 档位「星系 · low」；提示条「373 个实体 · 372 条关系 · 另有 240 个实体未显示」；画布 `aria-label`「133 个实体、132 条关系」 | 通过：**373 − 240 = 133，≤ low 档预算 150**；A9.3 的抽稀分支首次跑到 |
| 4 | 自适应降档（自动旋转 + 24× CPU 降速） | 12.2 s 后 `high` → `balanced`，播报「已自动降低画质以保持流畅」；撤速 3 s 后仍是 `balanced` | 通过：只降不升在生产态同样成立，降档不是 dev 专有行为 |

**隔离方式（可复现）**：真实库只读备份到 `%TEMP%`，在副本上播夹具对象；`NEXT_DIST_DIR=.next-build` 构建 + `next start -p 3134` + `AUTH_MODE=mock`；用后删除构建目录与临时库。**有一条容易踩空**：夹具对象的 `filePath` 必须命中副本里真实存在的对象 id，否则 ADR-011 的归属过滤会把它们整批滤掉——页面呈现出来的是「没有实体」，不是「权限失败」，很容易被误读成「生产构建读不到数据」。本轮先踩过一次再改对。

**生产态只能断言 DOM（口径，重要）**：`__graphStats` 与 `__graphLabelBoxes` 都带 `process.env.NODE_ENV !== "production"` 守卫（`src/components/graph-explorer.tsx` 的读数 `useEffect`、`src/components/graph/label-layer.tsx` 的写入点），生产构建里**不写全局**。由此三条：

- 生产验收的断言集合只有：`data-mode`、画布 `aria-label`、工具条 `aria-pressed`、提示条文本、`.meta-chip` 档位、`.g3-stub` 数量、`.sr-only` 播报，加截图像素统计。这些是用户真能看见的东西，比 dev 全局读数更接近验收本意。
- A9.1 / A9.1b 的 `drawCalls` / `layoutMs` / `avgFrameMs` **在生产构建下无法复现**，要这几个数只能回 `next dev`。不要把「dev 读数」和「prod DOM」当成同一份证据的两个视图——它们读的是两条不同的通道。
- 将来若长期需要生产态性能读数，**加显式 opt-in**（如 `?debug=stats` 时才写同一个全局），**不要去掉 `NODE_ENV` 守卫**：那是「生产不写全局」唯一的执行点，拆掉等于把 A7 的例外扩到线上。

**构建隔离**：`NEXT_DIST_DIR` 由 `next.config.ts` 的 `distDir: process.env.NEXT_DIST_DIR || ".next"` 支持，`.next-build` 已进 `.gitignore` 与 `eslint.config.mjs` 的 `globalIgnores`（注释指向本脚本）。**`.next-build` 存在时跑 `eslint .` 会连带扫描产物、报出大量假错误**；取 lint 基线前先删该目录，否则看到的不是仓库的真实问题。

**仍未验证（三条，不随本节升级为「已验证」）**：

1. 全部跑在 **mock LightRAG 夹具 + 无头 SwiftShader** 上：真实 LightRAG 下游与真实 Logto 会话未在 `next start` 下复测。生产构建里跑通的是「页面 + Worker」，不是「真实鉴权 + 真实抽取链路」。
2. 生产构建下**页面内 Worker 消息流量没有埋点**：只验到「CDP 有 worker 目标、无 chunk 加载失败、换中心后节点数不变」，看不到消息条数、回包时序与 `cancelled` 计数。要那层证据得给 Worker 加一条生产可用的计数通道。
3. **硬件 GPU 帧时序**（验收要点 2 的 `avgFrameMs ≤ 8`）仍未测；第 4 项降档是在 24× CPU 降速下人为触发的，能证明「机制在工作」，不能证明「真机上何时会掉到该档」。

**结论**：Phase 6D 的生产运行时风险由「未验证」降为「已复验，受上述三条限制」。这三条属于环境与埋点，不是代码缺口；它们不该继续挡着 6D 收口，但也不该被写成「全部验收完成」。

#### 变更记录

| 日期 | 版本 | 变更 | 提出 / review |
|---|---|---|---|
| 2026-11-12 | v1 | 初版冻结：`GraphViewModel`、`layoutGalaxy3d`、`GraphHighlight`、12 名舞台 token、数据契约、单测清单、分线表，以及与设计稿的 11 处口径统一（A8） | 审查 Architect；待 A/B 两线确认后生效 |
| 2026-11-12 | v1.1 | 回写 `--graph-accent = #F6E3C6`（A2.1 + A8，Designer 设计稿 §4.7 按 A8 授权定稿）；A7 补 `QualityTier` 来源；token 表 hex 大小写归一；A8 增补设计稿 v2.2 收尾后仍残留的三处（2D 字面量改子树覆盖、档位只降不升、手动低画质入口的归属）。签名与分线边界不变，冻结继续有效 | 审查 Architect |
| 2026-11-13 | v1.2 | 补三处开工前缺口：A7 加 `onStats` 回报回路（B 测 A 决、`tier` 只读传入）、A3.1 冻结 `SIZE_WORLD_RADIUS`（s/m/l/xl → 1.9/2.5/3.3/4.4，布局返回、渲染只读，**不与 2D 的 `clamp(5+3.1√degree)` 统一**）、A4 的 `GraphHighlight` 加必填 `dimmedEdges`（边压暗不再由各渲染器求补集）；A6 补该用例并把用例计数改为「冻结当天现测」。同时把正文 §4 字段名与坐标归属、§6 边 draw call 3 组、§14 计数三处按附录回写。`buildGraphViewModel` / `layoutGalaxy3d` 签名未变；两线尚未开工，`dimmedEdges` 是必填字段但无兼容负担，开工后加必填字段仍须走冻结规则 | 审查 Architect |
| 2026-11-13 | v1.3 | A3 措辞与**已落地实现**对齐（不改签名、不改冻结边界）：anchor 写死为「完全钉住」，**不是**「以半力参与松弛」——只有完全固定才能满足连点 5 次位置集合不变，并如实记录副作用（共有节点不再松弛、新节点从 anchor 邻居质心外 46 单位起步）；新增「星核」行（固定原点、anchor 不覆盖、换中心时旧星核让位）；「播种」补不可达节点 `r=340` 沿用 `±32` 垂向抖动；「可中断」拆为「预算与停止」+「取消」，cancel 定为**队列丢弃**（运行中任务由 400ms deadline 兜底），删除「cancel 可中断运行中布局」；「两个时钟」写明生产 Worker 默认 `deadlineMs=400`、不依赖调用方传参，截图 / 确定性基线固定 `maxTicks` 且**不传 deadline**，400ms 与 1200ms 不可互校。正文第 5 条（`tickBudget` → `maxTicks`、球面半径 / 黄金角 → 三层盘 / hash、Worker 预算）、第 14 条与 A6 的测试基线同步回写为 **45 文件 / 628 项（625 过、3 跳过）** | 审查 Architect |
| 2026-11-13 | v1.4 | 按 B2 已落地渲染层与验收实测补齐（不改冻结签名、不改世界单位、不改分线边界）：**A3.2** 新增机位 `[0,142,550]`（原 `[0,160,620]`，为构图推近 1.13×，现测占画面 76.0%×80.8%；相机目标与旋转组中心仍在原点）与节点视觉尺寸常数（`NODE_SIZE_SCALE=1.6`、选中环 ×1.7、光晕 ×3.2 / 0.22、accent 边 2.2px/0.92、strong 1.25px），写明它们是渲染层常数、不进模型与布局；**A3** 的「取消」与「Worker 协议」两行补 `{ type: "cancelled" }` 回执（队列被顶掉时回一条，客户端忽略、只认最后一条 `done`），并修正原文「不回消息」与「Worker 保留 `shouldStop`」两处与实现对不上的措辞；**A7** 补唯一一处 `window` 例外 `__graphLabelBoxes`（dev-only、单命名空间、只给验收脚本读），并补登记 B 线 `graph-render.test.ts` 的归属与必测项；**A9** 新增 B2 实测读数（参考值非硬指标）、§8 自适应降档实现契约（仅 3D + `rafActive`；窗口按 B 每 30 帧一次的发布计，连续 2 次 >20ms 等价于正文的连续 60 帧；`frames` 回绕只重新起算；只降不升、最多 2 次、间隔 ≥3s；降档经 `TIER_ORDER` 写入 `tierCeiling`，再由 `selectGraphMode` 的 `previousTier` 生效）、§9 抽稀施加范围（仅 3D 视图，2D/list 用原 view，`keepIds` 含中心/选中/hover/路径端点）与 `?maxNodes` 诊断参数契约（未接线）——A9.2 / A9.3 代码已接线，**验收尚未跑**，不按「已验证」记；A6 与正文第 14 条测试基线更新为 **46 文件 / 675 项（672 过、3 跳过）**，注明本机须 `--maxWorkers=2` | 审查 Architect |
| 2026-11-13 | v1.5 | 按本轮实现复核把附录 A 从「契约」改成「已验证的现状」（仍不改冻结签名、不改世界单位、不改分线边界）：**A9.4** `?maxNodes` 由「尚未接线」改为**已接线**，保留 50–600 / 缺省 150 / 非法回落 150 / 无 UI / 只是 A5.1 API 参数暴露这五条性质，补「同一个值同给 SSR 预取与客户端」「它是 373 节点 Worker 验收的唯一入口」「不放开到 2000」；**A9.2** 补「空闲打断连续性」四条清零规则（非 3D、`rafActive=false`、`frames` 不增长、`frames` 回绕），写明只有真有新帧的窗口才累计、连续两个发布窗口仍 ≈60 帧，并记 `PHASE6D_STEPS=downgrade` 在 24× CPU 降速下 high → balanced（54.38ms）的实跑；**A9.1** 新增 A9.1b 真实 Worker 端到端读数（373 节点 / 372 边、Worker 内 56.2–59.6ms / 150 ticks、回包 ~85ms、端到端 ~795ms、drawCalls 6、labels 21、`truncated=false`、真 Worker 的四条通道证据）、150 基线复测 7.1ms / 80 ticks、换中心 `cancelled` 回执 0 次的口径、生产构建通过的边界；**A9.3** 记明本轮 373 < 600 未触发抽稀，仍属未跑；**A3.2** 补控制器边界 `minDistance 260 / maxDistance 1100`，并把中途出现的 120 正式写回 260；**A8** 新增 §4.7 色调映射实际为 `NoToneMapping`（不是 `ACESFilmicToneMapping`），给出理由并禁止「按设计稿修回去」；状态行由「待实施」改为「实施中」（A/B 两线均已落地，验收未完成，不再是零代码状态）。测试基线保持 **46 文件 / 675 项（672 过、3 跳过）** | 审查 Architect |
| 2026-11-13 | v1.6 | 补生产运行时（`next start`）复验，收口 6D 的最后一条「未验证」（不改冻结签名、不改世界单位、不改分线边界、不动代码）：新增 **A9.6**——默认入口（`data-mode=3d`、`.g3-stub` 0、`aria-pressed` 为真、提示条 40 实体 / 49 关系、`__graphStats` 为 `undefined`）、`?maxNodes=600` 真 Worker（CDP 1 个 worker 目标、换中心后仍 373、无 `chunk-failed`）、low 档抽稀（373 → 渲染 133 ≤ 预算 150，播报「另有 240 个实体未显示」）、自适应降档（12.2 s high → balanced、撤速后不回升）四项读数，连同隔离方式（只读库副本 + `filePath` 必须命中副本对象 id 才过 ADR-011 过滤）、**DOM-only 断言口径**（两个调试全局带 `NODE_ENV` 守卫，生产不写；A9.1/A9.1b 的 drawCalls / layoutMs 在生产构建下不可复现，要读性能只能回 `next dev`；将来加 `?debug=stats` opt-in，不许拆守卫）与构建隔离（`.next-build` 已进 `.gitignore` 与 `globalIgnores`，该目录存在时跑 `eslint .` 会出假错误）；**A9.3** 由「代码已接线、未跑」改为**已跑生产运行时**，只保留「真机 GPU 抽稀后帧率未测」；**A9.4** 补「生产验收同样以 `?maxNodes=600` 为唯一入口」；A9.1b 末段「生产运行时未实测」改为「已复验」并指向 A9.6；**状态行由「实施中」改为「已实施」，但明确不写「验收完成」**（验收要点 2/3、7、15 与真实 LightRAG / Logto 仍未实测）。测试基线本轮实跑复核：`node node_modules/vitest/vitest.mjs run --maxWorkers=2` → **46 文件 / 675 项（672 过、3 跳过）**，与 v1.4/v1.5 一致 | 审查 Architect |

---

## ADR-023：分类词表统一与迁移（废止「作品形态 / 分类」双轨）

- **状态**：已采纳，**已实施**（2026-11-12 设计，2026-11-13 按代码核实改状态）。依据：`drizzle/0007_categories.sql` 已建 `categories` 表并把 `objects.format` 迁到 `objects.category_code`（含自由值折叠进词表）；`/api/vocabulary/categories` 与 `/api/vocabulary/categories/[code]` 已上线，旧地址 `/api/vocabulary/formats*` 保留为 308 跳转壳（`src/app/api/vocabulary/formats/route.ts` 的 `GET/POST/PATCH/DELETE/PUT` 全部 `redirectToCategories`）；权限键已改为 `vocabulary:category:write`（`src/server/authz.ts`，13 行不变）。**取代** ADR-016 第 1、2 条与第 7 条中「形态」的命名、作用域与写入权限；ADR-016 的「词表 + 外键」「标签真多对多」「启动期外键窗口」三条工程结论继续有效。**修订** ADR-019 权限清单（`vocabulary:format:write` → `vocabulary:category:write`）。
- **背景**（以 2026-11-12 代码与数据为准）：

  1. **同一个概念有两套数据，互不相干**：
     - `objects.primary_category`（text）+ `objects.categories`（JSON 数组）：编辑弹窗里是一个「逗号分隔」的自由文本框（`src/components/object-actions.tsx:463`，`splitList` 按 `,，、` 切分），可随便写、无词表、无校验。
     - `work_formats` 词表（`code/label/sort_order/state/is_system`）+ `objects.format` 外键：6 个内置项 + 兜底「未分类」，只在作品上使用，新建弹窗是单选 chip。
  2. **同一个概念有两个用户可见名称**：编辑里叫「分类」，系统页叫「管理形态」，新建弹窗叫「作品形态」，详情页同时显示「作品形态」与「分类」两行（`object-detail.tsx:101` 与 `:109`）。使用者第 2 条要求就是消灭这种双口径。
  3. **新建弹窗没有分类区**：资产 / 作品二选一；只有作品出现「作品形态」；标签在作品时位于形态之后、资产时位于「放在哪里」之后；**两类都没有分类区域**（`create-object-dialog.tsx:230-350`）。
  4. **数据实测**（`data/app.db`）：对象 3 条 = 1 资产 + 2 作品（`format` 均为 `article`）；`categories` 非空的只有 1 条（`["学习"]`，`primary_category = "学习"`）；`tags` 0 条；`work_formats` 7 行。`data/dev.db`：3 条 = 1 资产 + 2 作品（`course`），`categories` 全空。多值分类在生产数据里**从未真正出现**，但 schema 允许。
  5. **为什么现在必须合并**：使用者已明确「同一个功能不要叫两个名称」；继续保留两套数据，就会在筛选、导出、图谱、检索、管理页各出现一次「哪个才是我说的分类」的二次解释。本轮一次性收口，代价是 `objects` 表再重建一次。
  6. **现状里还有一处文档与代码不一致**：`docs/12_REQUIREMENTS_V3.md` 写「列表筛选新增形态下拉」，但 `ObjectFilters` 实际只有关键字 / 类型 / 库别 / 状态 / 标签 / 排序，没有形态筛选。本 ADR 不扩这个范围，只把文档口径改对（见命名矩阵）。

- **决策**：

  1. **一个概念只保留一个名字：分类（Category）**。`作品形态` 从产品词汇、代码标识、路由、权限键、审计动作里全部删除，**不保留 `format` 作为别名**。理由：本轮问题就是「一处改了另一处没改」；留一个兼容别名，下一次改动必然继续漂移。内部表 `categories`、对象列 `objects.category_code`、领域 / API 字段 `category`、权限 `vocabulary:category:write`、路由 `/admin/vocabulary/categories` 与 `/api/vocabulary/categories`。
  2. **分类单选，标签多选**：
     - 依据一：使用者原话是「只能单选或多选已有的分类和标签」——允许单选；依据二：分类是结构字段（作品的生产方式），参与状态流、列表副标题、导出与图谱元数据，多选会让「一个作品同时是文章和课程」成立，现有语义与筛选都会失效；依据三：现有 `format` 是单值，自由文本 `categories` 在生产库里只有 1 个值，多选能力从未被使用。
     - 作品**必须有且只有一个**分类（沿用「作品必须有形态」的不变式）；资产**可以有 0 或 1 个**（资产是输入，不承担生产方式）。
     - 「未分类」（`uncategorized`）继续作为系统兜底项：不可删除、不可停用、不可改名（沿用 ADR-016 第 8 条），作品默认选中排序第一的启用分类；它不作为筛选下拉项（沿用「待对齐项裁决」第 7 条）。
     - **升级路径**：若将来确实需要多分类，新增 `object_categories` 关联表并另开 ADR；本 ADR 不预留半套多值结构。
  3. **最终表结构**（`0007_categories.sql`）：

     ```sql
     CREATE TABLE `categories` (
       `code` text PRIMARY KEY NOT NULL,
       `label` text NOT NULL,
       `normalized` text NOT NULL,
       `sort_order` integer DEFAULT 0 NOT NULL,
       `state` text DEFAULT 'active' NOT NULL,
       `is_system` integer DEFAULT false NOT NULL,
       `created_at` text NOT NULL,
       `updated_at` text NOT NULL,
       CONSTRAINT "categories_state_check" CHECK(state in ('active', 'archived'))
     );
     CREATE UNIQUE INDEX `categories_normalized_uq` ON `categories` (`normalized`);
     CREATE INDEX `categories_sort_idx` ON `categories` (`sort_order`);
     ```

     - `normalized` 是新增的查重键：`displayLabel`（NFKC、连续空白压成一个、trim）后小写；重命名只改 `label`，同时重算 `normalized`，冲突 → 409。
     - `objects.category_code text NULL REFERENCES categories(code)`；`objects.categories`、`objects.primary_category`、`objects.format` 三列删除。
     - CHECK 改写：`objects_work_requires_category CHECK(type = 'asset' OR category_code IS NOT NULL)`；原 `objects_asset_has_no_work_fields` 里的 format 分支删除，改名为 `objects_asset_has_no_source_note CHECK(type = 'work' OR source_note IS NULL)`。
     - 索引：`objects_category_code_idx (category_code)`；词表使用数统计改为 `GROUP BY category_code`，且**统计全部未删除对象**（资产也计入），不再只数作品。
  4. **迁移规则（不丢数据，逐条可验证）**：

     | # | 规则 | 说明 |
     |---|------|------|
     | M1 | 作品的分类 = 原 `format` 的 code | 7 个内置 code 原样保留，`objects.category_code` 直接取值，零改写 |
     | M2 | 资产的分类 = `categories[0]` 在词表中的 code；无值则 `NULL` | 自由值先在词表里按 `normalized` 查重，命中即复用，未命中则新建（`code` 规则见 M5） |
     | M3 | 未成为该对象分类的自由值，逐条转为**标签** | 作品的全部 `categories` 值（除与所选分类同名的）、资产第 1 项之后的全部值。归一化键与已有标签相同则复用，链接写入 `object_tags`。这是「不丢数据」的落点：分类从多值收敛为单值，多余维度由标签承接 |
     | M4 | `primary_category` 直接删除 | 它恒等于 `categories[0]`，没有独立信息（`sqlite-object-repository.ts:194` 写入时派生） |
     | M5 | 新分类 code = `'c-' + lower(hex(randomblob(4)))` | 8 位十六进制、满足 `^[a-z0-9][a-z0-9_-]{1,31}$`；迁移只对「词表里不存在的 label」插入，重跑时靠 `WHERE NOT EXISTS` 跳过，已生成 code 不再变化。中文 label 不参与 code 生成 |
     | M6 | 归一化碰撞 | 两个不同写法（全角 / 大小写 / 连续空白）映射到同一 `normalized` 时只建一个词条，展示名取迁移查询里 `min(trim(value))` 的结果，并在迁移报告中列出被合并的原始写法 |
     | M7 | 原值等于某个内置分类的 label（如「文章」） | 复用内置词条，不新建 |
     | M8 | 原值等于「未分类」 | 映射到 `uncategorized` |

  5. **迁移步骤（单事务，每步可核验；失败恢复备份）**：

     - **第 0 步 · 备份与外键**：迁移前复制 `data/app.db` → `data/app.db.bak-<时间戳>`；沿用 ADR-016 的结论，`PRAGMA foreign_keys = OFF` 必须在 `migrate()` 外层（`src/server/db/client.ts`），迁移后 `PRAGMA foreign_key_check` 非空即拒绝启动。
     - **第 1 步 · 建词表并灌入**：建 `categories`，从 `work_formats` 原样复制 7 行（`normalized = lower(trim(label))`），再把自由文本值去重灌入。
     - **第 2 步 · 留档**：把即将删除的三列写入 `objects_category_legacy_backup`（`object_id, categories, primary_category, format`），保留一个版本，供回滚与迁移报告；后续迁移再删。
     - **第 3 步 · 自由值转标签**：补建缺失的 `tags`，再用 `INSERT OR IGNORE` 建 `object_tags` 链接。
     - **第 4 步 · 重建 objects**：新表含 `category_code` 外键、新的两条 CHECK、`objects_category_code_idx`；`INSERT … SELECT` 时按 M1/M2 计算取值。
     - **第 5 步 · 删旧词表**：确认 `objects` 已无 `format` 引用后 `DROP TABLE work_formats`。
     - **第 6 步 · 权限键改名**：见第 8 条。
     - **第 7 步 · 校验**：跑第 5 条末尾的验证查询；任一不符即整体回滚。

     SQL 骨架（Drizzle 每条以 `--> statement-breakpoint` 分隔；`strftime(...)` 简写为 `:now`）：

     ```sql
     -- 1) 词表
     CREATE TABLE `categories` ( /* 见第 3 条 */ );
     CREATE UNIQUE INDEX `categories_normalized_uq` ON `categories` (`normalized`);
     CREATE INDEX `categories_sort_idx` ON `categories` (`sort_order`);

     INSERT INTO `categories` (`code`,`label`,`normalized`,`sort_order`,`state`,`is_system`,`created_at`,`updated_at`)
     SELECT w.`code`, w.`label`, lower(trim(w.`label`)), w.`sort_order`, w.`state`, w.`is_system`, w.`created_at`, w.`updated_at`
     FROM `work_formats` w
     WHERE NOT EXISTS (SELECT 1 FROM `categories` c WHERE c.`code` = w.`code`);

     -- 自由文本：按 lower(trim()) 去重，只为不存在的键建词条（NFKC 由迁移脚本先做，见风险 A1）
     INSERT INTO `categories` (`code`,`label`,`normalized`,`sort_order`,`state`,`is_system`,`created_at`,`updated_at`)
     SELECT 'c-' || lower(hex(randomblob(4))), v.`label`, v.`norm`, 500, 'active', 0, :now, :now
     FROM (
       SELECT lower(trim(j.value)) AS norm, min(trim(j.value)) AS label
       FROM `objects` o, json_each(o.`categories`) j
       WHERE trim(j.value) <> ''
       GROUP BY lower(trim(j.value))
     ) v
     WHERE NOT EXISTS (SELECT 1 FROM `categories` c WHERE c.`normalized` = v.`norm`);

     -- 2) 留档
     CREATE TABLE `objects_category_legacy_backup` AS
     SELECT `id` AS object_id, `categories`, `primary_category`, `format` FROM `objects`;

     -- 3) 每个对象的分类码（作品看 format，资产看 categories[0]）
     CREATE TEMP TABLE `_object_category` AS
     SELECT o.`id` AS object_id,
            CASE
              WHEN o.`type` = 'work' THEN o.`format`
              ELSE (SELECT c.`code` FROM `categories` c
                    WHERE c.`normalized` = lower(trim(json_extract(o.`categories`, '$[0]')))
                    LIMIT 1)
            END AS category_code
     FROM `objects` o;

     -- 3b) 其余自由值 → 标签（复用已有 normalized）
     INSERT INTO `tags` (`id`,`label`,`normalized`,`sort_order`,`created_at`,`updated_at`)
     SELECT 'tag_' || lower(hex(randomblob(8))), v.`label`, v.`norm`, 0, :now, :now
     FROM (
       SELECT lower(trim(j.value)) AS norm, min(trim(j.value)) AS label
       FROM `objects` o, json_each(o.`categories`) j
       LEFT JOIN `categories` c ON c.`code` = (
         CASE WHEN o.`type` = 'work' THEN o.`format`
              ELSE (SELECT `code` FROM `categories`
                    WHERE `normalized` = lower(trim(json_extract(o.`categories`, '$[0]'))) LIMIT 1)
         END)
       WHERE trim(j.value) <> ''
         AND (c.`normalized` IS NULL OR lower(trim(j.value)) <> c.`normalized`)
       GROUP BY lower(trim(j.value))
     ) v
     WHERE NOT EXISTS (SELECT 1 FROM `tags` t WHERE t.`normalized` = v.`norm`);

     INSERT OR IGNORE INTO `object_tags` (`object_id`,`tag_id`)
     SELECT DISTINCT o.`id`, t.`id`
     FROM `objects` o, json_each(o.`categories`) j
     JOIN `tags` t ON t.`normalized` = lower(trim(j.value))
     JOIN `_object_category` oc ON oc.`object_id` = o.`id`
     LEFT JOIN `categories` c ON c.`code` = oc.`category_code`
     WHERE trim(j.value) <> ''
       AND (c.`normalized` IS NULL OR lower(trim(j.value)) <> c.`normalized`);

     -- 4) 重建 objects（外键已在事务外关闭）
     CREATE TABLE `__new_objects` (
       /* 其余列不变；新增： */
       `category_code` text,
       FOREIGN KEY (`category_code`) REFERENCES `categories`(`code`),
       CONSTRAINT "objects_work_requires_category" CHECK(type = 'asset' OR category_code IS NOT NULL),
       CONSTRAINT "objects_asset_has_no_source_note" CHECK(type = 'work' OR source_note IS NULL)
       /* 不再有 format / categories / primary_category 列 */
     );
     INSERT INTO `__new_objects` (/* 列清单 */)
     SELECT o.`id`, o.`type`, o.`title`, o.`description`, o.`library`, o.`source`, o.`origin`,
            o.`priority`, o.`archived_at`, o.`library_changed_at`, o.`owner_sub`, o.`revision`,
            o.`created_at`, o.`updated_at`, o.`deleted_at`, o.`status`, o.`source_note`,
            oc.`category_code`
     FROM `objects` o JOIN `_object_category` oc ON oc.`object_id` = o.`id`;
     DROP TABLE `objects`;
     ALTER TABLE `__new_objects` RENAME TO `objects`;
     CREATE INDEX `objects_category_code_idx` ON `objects` (`category_code`);
     CREATE INDEX `objects_type_status_idx` ON `objects` (`type`,`status`);
     CREATE INDEX `objects_library_idx` ON `objects` (`library`);
     CREATE INDEX `objects_updated_at_idx` ON `objects` (`updated_at`);

     -- 5) 旧词表退场
     DROP TABLE `work_formats`;
     ```

     **验证查询**（全部必须满足）：

     ```sql
     SELECT count(*) FROM objects;                                                  -- = 3（迁移前实测）
     SELECT count(*) FROM objects WHERE type='work' AND category_code IS NULL;      -- = 0
     SELECT count(*) FROM objects o LEFT JOIN categories c ON c.code=o.category_code
       WHERE o.category_code IS NOT NULL AND c.code IS NULL;                        -- = 0
     SELECT normalized, count(*) FROM categories GROUP BY normalized HAVING count(*)>1; -- 空
     SELECT count(*) FROM work_formats;                                             -- 第 5 步前 = 7
     -- 每个遗留自由值都必须有归宿（分类或标签）
     SELECT j.value FROM objects_category_legacy_backup b, json_each(b.categories) j
     WHERE trim(j.value) <> ''
       AND NOT EXISTS (SELECT 1 FROM categories c WHERE c.normalized = lower(trim(j.value)))
       AND NOT EXISTS (SELECT 1 FROM tags t WHERE t.normalized = lower(trim(j.value))); -- 空
     PRAGMA foreign_key_check;                                                      -- 空
     ```

     **回滚**：整个迁移是一个事务，失败即回滚；成功后要回滚只能恢复备份文件（`app.db.bak-*`）。`objects_category_legacy_backup` 保留原始三列，保证「迁后仍能人工重建旧视图」，下一个版本再删。

  6. **命名矩阵（全仓用户可见位置）**：

     | # | 位置 | 现在 | 改成 |
     |---|------|------|------|
     | 1 | 管理页标题 `vocabulary-page.tsx:78` | 管理形态 | **管理分类** |
     | 2 | 管理页副标题 `:81` | 作品形态决定内容的生产方式… | 分类决定内容的归属。改动会立刻同步到新建弹窗、编辑弹窗、详情与导出 |
     | 3 | 目录入口 `directory.tsx:107` | 管理形态 | **管理分类** |
     | 4 | 目录分组 `directory.tsx` | 词表 | **分类与标签** |
     | 5 | 新建弹窗字段 `create-object-dialog.tsx:254` | 作品形态（单选 · 决定内容的生产方式） | **分类**（单选 · 只能选已有分类） |
     | 6 | 新建弹窗空态 `:274` | 还没有可用形态，请管理员先添加一个 | 还没有可用分类，请先添加一个 |
     | 7 | 新建弹窗管理链接 `:259` | 管理 | 管理（文案不变，指向 `/admin/vocabulary/categories`） |
     | 8 | 编辑弹窗 `object-actions.tsx:463` | 分类（逗号分隔，自由文本） | **分类**（单选 chips + 右侧「＋ 自定义」） |
     | 9 | 详情页 `object-detail.tsx:101` | 作品形态 | **分类** |
     | 10 | 详情页 `object-detail.tsx:109` | 分类（自由文本） | **删除该行**（与第 9 行合并为唯一一行） |
     | 11 | 列表副标题 `record-list.tsx:297` | 形态名 · 状态 | 分类名 · 状态（数据源改 `object.category`） |
     | 12 | 检索结果徽标 `search/page.tsx:66` | `object.format` 的形态名 | `object.category` 的分类名 |
     | 13 | 后台对象表 `admin/objects/page.tsx:135,160` | 表头「形态」 | 表头「**分类**」；资产显示「—」 |
     | 14 | 词表管理页 `vocabulary-manager.tsx`（20+ 处） | 形态 / 新增形态 / 全部形态 / 新形态名称 / 形态列表 / 内置形态 / 停用形态 / 删除形态 / 目标形态 | 对应全部改为「分类」；「作品数」改「**对象数**」（资产也计入） |
     | 15 | 删除迁移提示 `vocabulary-manager.tsx:943` | 该形态下还有 N 个作品 | 该分类下还有 N 个对象 |
     | 16 | 错误字段名 `api-error.ts:22` | `format: 作品形态` | `category: 分类` |
     | 17 | 权限标签 `authz.ts:28` | 管理形态词表 | 管理分类词表 |
     | 18 | 权限键 | `vocabulary:format:write` | `vocabulary:category:write` |
     | 19 | 审计动作 `audit-service.ts:165-167` | `vocabulary.format.*` | `vocabulary.category.*`（历史行不改，见风险 A5） |
     | 20 | 导出 `export-markdown.ts:29,52` | `作品 · 形态名`；`分类：<自由文本数组>` | `作品 · 分类名`；`分类：<分类名>`（只一行） |
     | 21 | 图谱抽取文本 `graph-service.ts:141` | `分类：<自由文本数组>` | `分类：<分类名>` |
     | 22 | RAGFlow 文档元数据 `content-service.ts:235` | `meta.format = code` | **键名 `format` 保留**（外部索引契约，避免全量重同步），值改取 `category`；旧文档在下次同步前仍是旧值，不影响检索（该字段当前不参与过滤） |
     | 23 | 管理页路由 | `/admin/vocabulary/formats` | `/admin/vocabulary/categories`（旧路由 308 一年） |
     | 24 | 词表 API 路由 | `/api/vocabulary/formats` | `/api/vocabulary/categories`（旧路由 308 一个版本） |
     | 25 | 词表响应键 | `formats[]` | `categories[]` |
     | 26 | 对象 API 字段 | `format` / `categories` / `primaryCategory` | `category`（code，可 null） |
     | 27 | 列表查询参数 | `category=`（自由文本 JSON 匹配） | `category=`（按 code 匹配；传入中文 label 时服务端按 `normalized` 解析，兼容旧书签） |
     | 28 | 测试夹具 / 断言 | `format: "article"`、`work.format` | `category: "article"`、`work.category` |
     | 29 | `docs/06_API.md` §6 及全文 34 处 | 形态 / format | 分类 / category（本 ADR 实施时同步） |
     | 30 | `docs/09_USER_GUIDE.md` 16 处 | 形态 | 分类（本 ADR 实施时同步） |
     | 31 | `docs/01_ARCHITECTURE.md` §5.9 与表 | 形态 / `work_formats` | 分类 / `categories` |
     | 32 | `docs/12_REQUIREMENTS_V3.md`、`13_DESIGN_V3.md` | 形态（47 / 62 处） | Product / Designer 按本 ADR 同步；**同时修正**「列表有形态筛选」这一与代码不符的描述 |
     | 33 | `docs/15`、`16`、`17` | 历史调研快照 | **不改**。`16_GRAPH_DESIGN.md` 无「形态」字样，唯一「分类」是颜色编码描述，与本 ADR 无关 |

     **判定口径**：实施完成后 `grep -rn "作品形态\|管理形态\|新增形态\|形态列表" src/ tests/` 必须为 0；`grep -rn "\.format\b" src/` 只允许 `content-format.ts`、`formatDateTime`、`Intl.*format` 等无关同名。
  7. **API 契约**：

     | 方法 | 路径 | 权限 | 说明 |
     |------|------|------|------|
     | GET | `/api/vocabulary` | `object:read` | `{ categories: VocabularyCategory[], tags: VocabularyTag[] }`；`VocabularyCategory = { code, label, normalized, sortOrder, state, isSystem, usage }` |
     | POST | `/api/vocabulary/categories` | `object:write`（内联）或 `vocabulary:category:write` | `{ label, code?, reuseExisting? }`；成功 201；`reuseExisting: true` 且命中同名 → 200 返回已有项；否则 409 `CATEGORY_EXISTS` |
     | PATCH | `/api/vocabulary/categories/{code}` | `vocabulary:category:write` | `{ label?, sortOrder?, state? }`；改名重算 `normalized`，冲突 409 |
     | DELETE | `/api/vocabulary/categories/{code}` | `vocabulary:category:write` | `?migrateTo=`；被引用时先迁移再删（事务内改写 `category_code`） |

     - 对象接口：`POST/PATCH /api/objects*` 接受 `category`；作品必填、资产可空；不存在或已停用 → 404（错误 `details.category`）。
     - 对象响应：`category`（code 字符串或 `null`）取代 `format` / `categories` / `primaryCategory`；这是**破坏性字段变更**，仓库内全部调用点同批改完，`docs/06_API.md` 记录迁移说明。
     - `/api/search` 的 `hit.object` 同样把 `format` 换成 `category`（与 ADR-024 同批）。
  8. **自定义新增流（使用者第 1 条）**：
     - **控件**：新增 `CategoryPicker`（单选 chip 网格，启用项按 `sortOrder`；超过 12 项时顶部出现过滤框）与改造后的 `TagField`（多选 chip 网格 + 过滤框）。两者右侧固定一个「＋ 自定义」按钮，打开共用的 `VocabularyQuickCreate` 小弹窗（只填名称）。
     - **不允许自由输入**：输入框只用于过滤，回车只选中已有项；没有精确匹配时提示「没有这个分类/标签，点右侧『自定义』新建」。保存时服务端不再「遇到未知标签就静默建」——`replaceObjectTags()` 改为未知 `normalized` 直接 `ValidationError`（`TAG_NOT_FOUND`），堵住绕过自定义弹窗的入口。这是对 ADR-016 第 7 条「标签可隐式创建」的**收紧**，原升级路径从此生效。
     - **权限与边界**：内联创建向 `object:write` 开放（使用者要求普通编辑者也能新增）。边界四条：① 名称 1–12 字（分类）/ 1–20 字（标签），NFKC 归一后唯一；② 启用分类总数 ≤ 30（沿用 `MAX_ACTIVE_FORMATS`，改名 `MAX_ACTIVE_CATEGORIES`）；③ 标签总数软上限 500，超出只警告；④ 新建项一律 `state=active`、`is_system=false`、`sort_order = max+10`，并写审计 `vocabulary.category.create` / `vocabulary.tag.create`（`details.source = "inline"`、actor）。**不做审核**：单工作区、可随时改名/停用/合并，审核只会让第一次录入卡住。
     - **重名**：前端实时按 `normalized` 查重并提示；服务端对同名但已停用的分类返回 409 `CATEGORY_ARCHIVED`，提示「已停用，请联系管理员启用」，**不自动复活**（避免普通编辑者绕过管理动作）。
  9. **权限迁移**：`permissions` 主键改名不能用 `UPDATE`（`role_permissions.permission_key` 外键 `ON UPDATE NO ACTION`），按「插入新键 → 复制授权 → 删旧链接 → 删旧键」四步：

     ```sql
     INSERT INTO `permissions` (`key`,`label`,`group_key`,`sort_order`)
     SELECT 'vocabulary:category:write','管理分类词表',`group_key`,`sort_order`
     FROM `permissions` WHERE `key` = 'vocabulary:format:write';
     INSERT INTO `role_permissions` (`role_key`,`permission_key`)
     SELECT `role_key`, 'vocabulary:category:write' FROM `role_permissions`
     WHERE `permission_key` = 'vocabulary:format:write';
     DELETE FROM `role_permissions` WHERE `permission_key` = 'vocabulary:format:write';
     DELETE FROM `permissions` WHERE `key` = 'vocabulary:format:write';
     ```

     迁移后断言：`permissions` 仍为 13 行、`vocabulary:category:write` 的授权角色集合与迁移前 `vocabulary:format:write` 完全一致（owner / admin）。

- **备选方案与取舍**：

  | 方案 | 做法 | 取舍 |
  |------|------|------|
  | **A（采纳）** | `work_formats` 升级为 `categories`、`objects.format` → `category_code`、自由文本值并入同一词表；单选 | 一个词表、一条外键、筛选与状态流不变；数据库层就能保证「作品必有分类」。代价是自由多值收敛为单值，多余值转标签（规则 M3），并再重建一次 `objects` |
  | B | 新建 `categories` + `object_categories` 多对多，分类多选 | 不丢任何多值语义；但「作品必须有分类」无法用 CHECK 表达（要触发器）、读路径多一次水合、分类与标签的边界被打散，且与使用者「结构 / 属性」的心智不符。约 2.5 倍改动面 |
  | C | 保留两套数据，只把「形态」文案改成「分类」 | 改动最小；但编辑弹窗的「分类」仍是自由文本，使用者第 1 条（只能选已有 + 自定义）无法实现，等于没解决 |
  | D | 保留 `work_formats` 表名与 `format` 字段，只改 UI 文案 | 内部两套词汇继续存在；下一个开发者仍要猜「format 和 categories 哪个是分类」，正是本轮要消灭的技术债 |

- **影响**：
  - 新增迁移 `drizzle/0007_categories.sql`；`objects` 与 `work_formats` 重建 / 退场；新增 `objects_category_code_idx`、`categories_normalized_uq`；新增留档表 `objects_category_legacy_backup`。
  - 领域层：`BusinessObject.format` / `categories` / `primaryCategory` → `category: string | null`；`WorkObject.category: string`、`AssetObject.category: string | null`；`WorkFormat` 类型改名 `Category`。
  - 服务 / 仓储：`object-service` 的 `format` 校验改 `category`（作品必填、资产可空、停用项不允许新选）；`sqlite-object-repository` 写入 / 筛选 / 水合全部改列；`vocabulary-service` 的 6 个函数改 `category`（`listCategories`、`createCategory`、`updateCategory`、`deleteCategory`、`listActiveCategoryCodes`、`categoryUsage`）；`listVocabulary` 返回 `categories`。
  - UI：`create-object-dialog` 新增分类区（资产 / 作品都有，位于标签上方），作品不再有独立「作品形态」区；`object-actions` 的分类自由文本框替换为 `CategoryPicker`；`TagField` 改为选择优先 + 自定义按钮；`object-detail` 合并两行；`record-list` / `search` / `admin/objects` / `vocabulary-manager` / `directory` 文案与数据源同步。
  - 路由：`/admin/vocabulary/categories`、`/api/vocabulary/categories*`；旧路由 308。
  - 权限：13 项不变，1 项改名；`object:write` 增加「内联创建分类 / 标签」一条能力，不新增权限键。
  - 测试：基线 **32 文件 / 405 项**（2026-11-12 实测全绿），预计改动 12 个文件、新增 `categories-migration.test.ts`、`category-picker` 纯逻辑测试。

- **实施顺序（主程照此执行，不需再问）**：
  1. **迁移与领域类型**：`0007` + `schema.ts` + `domain/objects.ts` + `domain/vocabulary.ts`；先在 `data/app.db` 副本上跑通验证查询，再进测试库。
  2. **仓储与服务**：对象 CRUD、筛选、水合；词表服务六个函数改名；`replaceObjectTags` 收紧未知标签。此步结束跑 `npm test`，只允许预期内的断言改动。
  3. **API 与权限**：新路由 + 308 旧路由；权限键迁移；审计动作改名；`toActor` 透传到内联创建。
  4. **UI 文案与控件**：`CategoryPicker`、`TagField` 改造、`VocabularyQuickCreate`；新建 / 编辑 / 详情 / 列表 / 检索 / 后台 / 管理页；按命名矩阵逐条核。
  5. **文档**：`06_API`、`09_USER_GUIDE`、`01_ARCHITECTURE`；12/13 交由 Product / Designer。
  6. **收尾**：`grep` 断言、全量测试、迁移演练报告。

- **验收标准**：
  1. 在 `data/app.db` **副本**上跑迁移：对象数 3、2 条作品 `category_code = 'article'`、1 条资产若有「学习」则 `category_code` 指向新建的「学习」词条、`foreign_key_check` 为空、无孤儿 code、无重复 `normalized`、遗留值查询为空。
  2. 新建作品：分类区位于标签上方，默认选中第一个启用分类；不选不能提交；点「＋ 自定义」输入「播客」→ 立即出现在 chips 并选中 → 保存 → 刷新后仍在。新建资产：分类区同样存在，可不选。
  3. 编辑内容：分类是单选 chips，不能输入任意文本；标签是多选 chips，回车不会创建新标签；两者都能通过「自定义」新建并自动选中。
  4. 全站文案：任务栏目录、管理页、新建 / 编辑 / 详情 / 列表 / 检索 / 导出 / 后台对象表只出现「分类」，`grep` 断言为 0；详情页只有一行「分类」。
  5. 权限：`editor` 可内联创建并保存，不能改名 / 停用 / 删除（403）；`viewer` 只能看；`owner/admin` 管理动作正常；迁移后 13 项权限与授权角色数不变。
  6. 旧地址：`/admin/vocabulary/formats` 与 `/api/vocabulary/formats` 308 到新地址；`/api/vocabulary` 不含 `formats` 键。
  7. `npm test` 全绿（新基线在实施时更新），新增迁移 / 词表 / 仓储测试 ≥ 10 项。
  8. 回滚演练：恢复 `app.db.bak-*` 后旧版本应用可正常启动、旧编辑弹窗能读出原 `categories` 与 `format`。

- **影响范围**：ADR-016（命名与权限条款）、ADR-019（权限键）、06_API、09_USER_GUIDE、01_ARCHITECTURE、05_CHANGELOG、12 / 13（Product / Designer 同步）

---

## ADR-024：检索的模糊查询与语义混合

- **状态**：已采纳，**已实施**（2026-11-12 设计，2026-11-13 按代码核实改状态）。依据：`/api/search` 已支持 `mode=hybrid|lexical|semantic`（`src/lib/search-query.ts` 的 `searchModes` / `DEFAULT_SEARCH_MODE`，非法值 400）；对象级六级权重排序已在 `src/server/services/search-service.ts` 落地；语法错误走 `QUERY_SYNTAX`（`src/domain/errors.ts` → `respond.ts` 映 400）；首页内联预览由 `src/components/galaxy-home.tsx` + `src/hooks/use-search-preview.ts` 实现（≥2 字、200ms 防抖、`mode=lexical&limit=8`）；`docs/06_API.md` 第 5 节已按本 ADR 写全参数与响应。依赖 ADR-023 的字段改名（`hit.object.category`）；**取代** ADR-018 第 3 条「表单跳 `/search?q=`，不做即时联想、不发 XHR」的结论——首页改为输入即内联预览（≥ 2 字、200ms 防抖、8 条、`mode=lexical`、不碰 RAGFlow），`/search` 保留为完整结果页；不改变 ADR-001 的分层（RAGFlow 仍是正文语义的唯一来源），不引入新服务或新依赖。
- **背景**：
  1. **现状只有语义召回**：`GET /api/search` → `searchContent()`（`search-service.ts`）把 `q` 原样交给 RAGFlow `retrieve`，只做归属、归档、库别过滤；SQLite 侧没有任何关键词匹配。RAGFlow 不可用或未建 dataset 时，搜索直接返回空 / 报错。
  2. **首页搜索框只是跳转**：`galaxy-home.tsx` 提交后 `router.push('/search?q=')`，没有预览、没有防抖、没有键盘选择；`/search` 页只有语义结果与阈值下拉。
  3. **正文不在 SQLite**：正文存 RAGFlow，业务库只有 `title` / `description` / 分类 / 标签。因此词法层只能覆盖**元数据**，正文关键词仍由语义层承担——这个边界必须写进产品文案，不能假装词法搜得到正文。
  4. **旧项目可借鉴的能力**（`D:\projects\Personal Asset & Knowledge Platform`）：`src/lib/search-query.ts` 支持 `title/content/tags/categories/description` 字段前缀、引号短语、`AND/OR/NOT`、`-` 排除、`~` 编辑距离；`command-palette.tsx` 是 **180ms 防抖、最少 2 字、约 12 条结果、↑↓/Enter/Esc** 的顶栏搜索。使用者要求「参考上一版并优化」。
  5. **规模目标**：1 万对象、约 5 万条 `object_tags` 链接，单用户单工作区。
  6. **技术事实**：本机 SQLite 3.53.4，`ENABLE_FTS5 = 1`（已实测）。

- **决策**：

  1. **词法层用 SQLite `instr()` 子串匹配，不用 FTS5**：
     - 中文没有空格分词；FTS5 默认 `unicode61` 把连续汉字当一个 token，`MATCH '知识'` 匹配不到「个人知识系统」；`trigram` 分词器要求查询 ≥ 3 字符，2 字中文词（「写作」「复盘」）直接失效——而 2 字正是中文最常用的查询粒度。
     - 自建分词 / 外部分词器意味着新增依赖与一份索引副本；`categories` / `tags` 改名后还要靠触发器同步，正是「两套真相」的复发点。
     - `instr(lower(col), ?) > 0` 天然支持任意长度子串、无需转义 `%` / `_`、不会因用户输入拼出非法 SQL；1 万行 × 4 个字段的全表扫描在毫秒级，远低于语义调用的网络开销。
     - **预留切换点**：对象数超过 10 万或词法 p95 超过 150ms 时，另开 ADR 评估 FTS5 `trigram` + 2 字查询回退 `instr` 的双路径；本期不做。
  2. **归一化：写入时落「搜索影子列」，查询时同一函数**：
     - 新增纯函数 `normalizeSearchText()`：NFKC（全角转半角）→ 小写 → 连续空白压成一个空格 → trim。
     - `objects` 增加 `title_norm`、`description_norm` 两列（`TEXT NULL`），由 `sqlite-object-repository` 在 create / update 时写入；迁移 `0008` 回填存量。这样全半角、英文大小写都能命中，且不依赖 SQLite 做不到的 NFKC。
     - 分类与标签不建影子列：`categories.normalized`（ADR-023 新增）与 `tags.normalized` 本身就是归一化键，改名时同步更新，天然单一真相。
     - 查询串先经同一函数归一化再进 SQL；`q` 的原始文本只用于展示与 `question` 回显。
  3. **查询语法：小而确定的子集**（明确不追求旧项目的完整布尔表达式）：

     | 语法 | 行为 | 示例 |
     |------|------|------|
     | 空格分隔 | 全部满足（隐式 AND） | `写作 复盘` |
     | `"…"` | 短语，整段子串匹配 | `"个人知识系统"` |
     | `title:` / `标题:` | 只匹配标题 | `title:复盘` |
     | `desc:` / `描述:` | 只匹配描述 | `desc:模板` |
     | `category:` / `分类:` | 只匹配分类名 | `分类:课程` |
     | `tag:` / `标签:` | 只匹配标签名 | `标签:工具类` |
     | `-词` | 排除（对上述任一字段命中即排除） | `复盘 -草稿` |
     | `AND` | 与空格等价，兼容旧习惯 | `写作 AND 复盘` |
     | `OR` / `NOT` / 括号 | **不支持**：`OR` 与括号返回 400 `QUERY_SYNTAX` 并给可操作提示；`NOT` 与 `-` 等价 | — |
     | `~` | **不支持**：子串匹配已经是「模糊」，编辑距离在 1 万对象上要全量算 Levenshtein，收益不成立。输入 `~` 按普通字符处理并在结果页给一次提示 | — |
     | 未知 `x:` | 按普通文本处理（与旧项目一致，避免把 `http://` 之类误判为字段） | — |

     - 语法错误（未闭合引号、只有 `-`、`OR`、括号）→ 400 `QUERY_SYNTAX`，`details.position` 给出出错位置；`/search` 页在输入框下方显示原文与该位置，不发请求。
     - 少于 2 个字符（归一化后）→ 200 + 空结果 + `hint: "至少输入 2 个字"`；首页预览直接不发请求。中文单字歧义太大，旧项目同样以 2 字为门槛。
  4. **匹配与排序（对象级，确定性）**：

     | 层级 | 命中 | 分值 |
     |------|------|------|
     | T1 | 标题与查询（单词查询）完全相等 | 100 |
     | T2 | 标题包含任一词 / 短语 | 80（前缀命中 +10） |
     | T3 | 分类名精确相等 70；标签名精确相等 65 | 70 / 65 |
     | T4 | 分类名或标签名包含 | 50 |
     | T5 | RAGFlow 正文片段命中 | `30 + 15 × similarity`（30–45） |
     | T6 | 描述包含 | 20 |

     - 同一对象多条证据取**最高层**计分，`matchedFields` 取并集；同层按 `updatedAt` 倒序，再按 `id` 升序保证稳定。
     - **对象级去重**：一个对象只出一条结果；语义层同对象的多个 chunk 只保留相似度最高的一条，其余 chunk 数记入 `chunkCount`。
     - 为什么元数据排在正文之前：用户输入短词时，标题 / 分类命中几乎总是「我要找的那条」；把语义片段排前面会让搜索结果看起来「答非所问」。描述放最后，因为它常是套话。
  5. **摘要与高亮**：词法命中用 `description` 生成摘要（命中词附近截 300 字），复用 `buildHighlightSnippet()`（纯文本 + `<mark>`，不把 HTML 交给浏览器）；无描述时摘要为「分类：X · 标签：Y」。语义命中沿用 RAGFlow 的 `highlight`。摘要只用于展示，不参与排序。
  6. **混合策略：始终并行，语义失败只降级不报错**：
     - `mode = hybrid | lexical | semantic`（API 参数，默认 `hybrid`）；`lexical` 完全不调用 RAGFlow，`semantic` 完全不查 SQLite。
     - 词法查询与 RAGFlow 召回并行；RAGFlow 设 **3 秒超时**，超时 / 网络错 / 未建 dataset 都记 `semantic.status = "timeout" | "unavailable" | "no_dataset"`，词法结果照常返回；页面上给一条中性提示「语义检索暂不可用，当前只显示关键词匹配结果」，不出错误页。
     - `threshold` 只作用于语义层（原样透传 RAGFlow），对词法结果**不生效**；响应里用 `semantic.thresholdApplied: true` 说明，`/search` 页在阈值下拉旁标注「仅影响语义结果」。`mode=lexical` 时该参数被忽略且不报错。
  7. **`/api/search` 响应（增量扩展，不删旧字段）**：

     ```jsonc
     {
       "question": "写作 复盘",
       "mode": "hybrid",
       "hits": [ /* 合并后的对象级结果，见下 */ ],
       "total": 7,
       "counts": { "lexical": 5, "semantic": 4, "merged": 7 },
       "lexical": { "total": 5, "truncated": false, "hint": null },
       "semantic": { "total": 4, "status": "ok", "thresholdApplied": true },
       "library": null
     }
     ```

     - `hits[]` 保留现有全部键（`chunkId` / `content` / `highlight` / `similarity` / `documentId` / `documentName` / `refId` / `role` / `object`），词法独有项这些键为 `null`，**不删键**；新增 `source: "lexical" | "semantic" | "both"`、`score`、`matchedFields: ("title"|"description"|"category"|"tag")[]`、`chunkCount`。
     - `object` 里的 `format` 按 ADR-023 换成 `category`。
     - `total` 从「语义命中数」改为「合并去重后的对象数」；旧消费者若只关心语义，读 `semantic.total`。这是一次**语义变化**，在 `06_API.md` 与变更记录里写明。
     - 兼容：新增字段全部可选；`mode=semantic` 时 `hits` 与今天的语义结果逐字段一致（除 `object.format → category`）。
  8. **首页搜索框（使用者第 4 条）**：
     - **输入即预览**：≥ 2 字、**200ms 防抖**（旧项目 180ms；取 200 减少请求）、`AbortController` 取消在途请求、序号比对丢弃过期响应；只调 `mode=lexical&limit=8`，**不碰 RAGFlow**，保证输入不掉帧。
     - **中文输入法**：`compositionstart` / `compositionend` 期间不触发查询，结束后再防抖，避免拼音中间态打出无意义请求。
     - **键盘**：↑ / ↓ 移动、`Enter` 打开选中项（无选中则进 `/search?q=`）、`Esc` 先关面板再清空、`⌘K` / `/` 聚焦（沿用现有）；`aria-combobox` + `aria-activedescendant` + `role=listbox/option`。
     - **结果项**：标题（命中词高亮）+ 类型 / 分类 / 标签一行 + 「N 条 · 回车查看全部」页脚；面板最大高 `50dvh`，移动端全宽；点击外部关闭。
     - 未登录：沿用现状——输入框渲染但禁用，提示「登录后可检索内容」，不发请求。
     - `/search` 页：结果改为**一个对象级列表**，每条带来源徽标「标题/分类命中」或「正文片段」；顶部保留阈值、库别与示例；语义不可用时显示中性提示而不是空状态。
  9. **性能与上限**：
     - 目标：1 万对象、5 万标签链接下，词法 p95 ≤ **60ms**（服务端，不含网络）、首页预览 p95 ≤ **30ms**；合并 + 摘要 ≤ 10ms。
     - SQL 只跑一条候选查询：`WHERE owner_sub = ? AND deleted_at IS NULL AND archived_at IS NULL` + 每个词一个 `instr(...)` 条件；`LIMIT 501`，取到 501 条即 `truncated = true` 并只取前 500（在响应里明示「结果过多，请加关键词」）。
     - 索引：新增 `objects_owner_scope_idx (owner_sub, deleted_at, archived_at)`、`objects_category_code_idx (category_code)`；标签过滤走 `object_tags` 主键与 `tags_normalized_uq`。`instr` 本身不走索引，靠 owner 索引把扫描面收敛到当前用户。
     - 不 N+1：候选对象一次取回，标签按 `object_id IN (...)` 一次水合（沿用仓储现有批量水合）。
  10. **安全**：只返回 `owner_sub = 当前会话`、`deleted_at IS NULL`、默认 `archived_at IS NULL` 的对象（与现有语义检索一致）；`object:read` 必需；`q` ≤ 200 字；所有值参数化绑定；高亮只经 `buildHighlightSnippet` 输出纯文本片段，不 `dangerouslySetInnerHTML`；错误信息不回显数据库原文。

- **备选方案与取舍**：

  | 方案 | 做法 | 取舍 |
  |------|------|------|
  | **A（采纳）** | `instr` 子串 + 影子归一列 + 对象级排序，语义并行 | 中文 2 字可用、零新依赖、改名即时生效；代价是每次全表扫（1 万级可接受），正文搜不到（交给语义层） |
  | B | FTS5 `trigram` + 外部内容表 | 有索引、可扩展；但 2 字查询失效、触发器同步与改名耦合、多一套影子表，本期收益为负 |
  | C | FTS5 `unicode61` + 自建中文分词 | 分词质量不可控、新增词典与依赖，且分词边界与用户预期不一致 |
  | D | 只扩 RAGFlow 的关键词召回 | 不改库；但 RAGFlow 不可用时搜索完全失效，且中文关键词召回不可控，正是使用者要修的问题 |
  | E | 词法优先、语义只在词法为空时兜底 | 请求少；但「词法命中 30 条就完全不看语义」会漏掉正文相关，用户体验不可预期 |

- **影响**：
  - 新增 `src/lib/search-query.ts`（解析 + 归一化 + 评分纯函数，名字沿用旧项目但实现更小）、`src/server/repositories/sqlite-object-repository.ts` 的 `lexicalSearch()`、`src/server/services/lexical-search-service.ts`；`search-service.ts` 变为编排层（词法 + 语义 + 合并），现有 RAGFlow 调用抽成内部函数，行为不变。
  - 迁移 `0008_search_norm.sql`：`title_norm` / `description_norm` 两列 + 回填 + `objects_owner_scope_idx`；`schema.ts` 同步。
  - `galaxy-home.tsx` 从「纯表单」升级为 combobox（约 150 行客户端逻辑，抽 `use-search-preview.ts` 便于单测）。
  - `/search` 页结果组件从 `HitCard` 拆成「对象级卡片 + 来源徽标」；阈值旁加「仅影响语义结果」说明。
  - 测试：新增 `tests/lib/search-query.test.ts`、`tests/lib/search-rank.test.ts`、`tests/server/lexical-search.test.ts`、`tests/server/search-service-hybrid.test.ts`；改 `search-service.test.ts` 与 `search-params.test.ts`。

- **实施顺序**：
  1. 纯函数：`normalizeSearchText`、解析器、评分器、摘要（全部无 IO，先写测试）。
  2. 影子列迁移 + 仓储 `lexicalSearch`（含归档 / 软删 / 归属 / 库别过滤）。
  3. `search-service` 编排 + `/api/search` 响应扩展 + `mode` 参数 + 3s 超时降级。
  4. `/search` 页合并列表与状态提示。
  5. 首页 combobox 预览 + 键盘 / IME / 移动端。
  6. 文档（06_API 检索一节、09_USER_GUIDE 检索一节）与性能实测。

- **验收标准**：
  1. 中文子串：标题含「个人知识系统」，输入 `知识` 命中；输入 `知识 系统` 仍命中（AND）；`title:知识` 命中，`tag:知识` 不命中。
  2. 归一化：全角 `ＡＢＣ` 与半角 `abc` 都能命中同一标题；连续空格不影响；分类 / 标签改名后立即按新名命中（无需重建索引）。
  3. 排序：标题完全相等 > 标题包含 > 分类/标签 > 正文片段 > 描述；同层按更新时间倒序；结果按对象去重，一个对象只出现一次。
  4. 语义降级：停掉 RAGFlow 后搜索 200、词法结果完整、页面显示「语义检索暂不可用」；`mode=lexical` 不产生任何 RAGFlow 请求；3 秒超时生效。
  5. 首页：输入 1 字不发请求；2 字后 200ms 内出预览；快速连打只保留最后一次；中文输入法拼写过程不发请求；↑↓/Enter/Esc/⌘K 全部可用；移动端不遮挡输入框。
  6. 安全：`viewer` 可搜；未登录 401；他人对象、已删除、已归档对象不出现；`q` 超 200 字 400；`OR` / 未闭合引号 400 且带位置。
  7. 性能：1 万对象夹具下词法 p95 ≤ 60ms、预览 p95 ≤ 30ms（本地实测记录进 `08_RUN_LOG`）；`EXPLAIN QUERY PLAN` 显示使用 `objects_owner_scope_idx`。
  8. 对照旧项目 3 条用例（标题前缀 + 引号短语 + `-` 排除）结果一致；`npm test` 全绿。

- **风险**：
  | # | 风险 | 应对 |
  |---|------|------|
  | S1 | 影子列 `title_norm` / `description_norm` 与主列漂移（绕过仓储写入） | 所有写入只经 `sqlite-object-repository`；create / update 同一函数生成；迁移回填；测试断言「写入后 norm 等于 normalize(title)」 |
  | S2 | 1 万级全表 `instr` 随数据增长退化 | 先实测再上线；超过 10 万或 p95 > 150ms 时按第 1 条的切换点另开 ADR |
  | S3 | 用户按旧项目习惯输入 `OR` / `~` 被拒或降级 | 错误信息给替代写法（`OR` → 分两次搜索 / 标签筛选；`~` → 已默认模糊）；`/search` 页帮助文字列出支持语法 |
  | S4 | 中文子串误命中（「学习」命中「学习资料」） | 词越多越精确；提供字段前缀与短语；不做分词是明确取舍，写进用户指南 |
  | S5 | 语义超时让搜索「感觉变慢」 | 3 秒硬超时、词法先行返回、页面中性提示；首页预览完全不依赖语义 |
  | S6 | 合并后 `total` 语义变化影响旧调用方 | `semantic.total` 保留原义；`06_API.md` 变更记录标注；仓库内调用点同批改 |
  | S7 | 高亮与归一化后的匹配位置不一致（全角 / 大小写） | 高亮是对原文本的 best-effort 大小写不敏感匹配，不承诺逐字符精确；断言只验证包含关系 |
  | S8 | 拼音 / 首字母搜索缺失 | 明确不在本期；记为 v1.5 候选（需拼音词典与额外列） |

- **影响范围**：06_API、09_USER_GUIDE、01_ARCHITECTURE（检索链路）、05_CHANGELOG、08_RUN_LOG（性能实测）、10_BACKLOG（拼音 / 多值分类）

---

## ADR-025：大模型供应商配置与凭据存储

- **状态**：已采纳·已实施（2026-11-13）
- **日期**：2026-11-13
- **实施说明（2026-11-13）**：表名最终定为 **`settings`**（列 `key` / `value_encrypted` / `updated_at` / `updated_by`，`updated_by` 非空、存操作者 sub 快照）；下文 `app_settings(value_enc …)` 是最初草稿的形状。其余决策（AES-256-GCM + HKDF、独立 `SETTINGS_ENC_KEY`、权限 13 → 15、`test` / `apply` 分离、60 秒健康检查与回滚）均按原文落地。
- **背景**：图谱页 0 实体，实测根因在模型侧太慢，不是链路接错：
  - `infra/lightrag/.env` 当前是 `LLM_BINDING=ollama`、`LLM_MODEL=deepseek-r1:7b`、`LLM_BINDING_HOST=http://127.0.0.1:11434`、`LLM_TIMEOUT=300`；本机无 GPU，实测生成约 **7 tokens/s**，一篇中等长度内容的分块实体抽取远超 300 秒。
  - `infra/lightrag/lightrag.err.log` 里 `ReadTimeout` 命中 **16 次**，4 篇内容全部抽取失败；报错串只剩 `C[1/4]: doc-…-chunk-000:`，页面的失败卡片因此没有可读原因（该问题由图谱线另行修复，本 ADR 不重复设计）。
  - 改模型要手改 `infra/lightrag/.env` 再手动重启进程：没有审计，没有校验，也没有任何地方能回答「现在保存的配置到底生效了没有」。
  - **三处与任务书不一致的现状（已实测，必须先裁决）**：

    | 任务书假设 | 仓库实际 | 本 ADR 的裁决 |
    |---|---|---|
    | 有 `AUTH_SECRET` | `grep -rn "AUTH_SECRET" src/ scripts/` 命中 **0**；`.env.local` 只有 `LOGTO_COOKIE_SECRET` / `LOGTO_APP_SECRET` | 新增专用变量 **`SETTINGS_ENC_KEY`**，不复用 Logto 的 cookie secret（理由见第 2 条） |
    | 迁移编号 `0008_settings.sql` | `drizzle/0008_search_norm.sql` 已占用（ADR-024） | 改用 **`drizzle/0009_settings.sql`** |
    | `.env.example` 里有 `OPENAI_API_KEY` 等可作回退 | `src/`、`scripts/` 对该组变量**零读取**，是历史遗留 | 不把它当回退来源；DB 是唯一真相源，`.env.example` 只保留说明 |

- **决策**：
  1. **配置落库，DB 是唯一真相源**：新表 `app_settings(key TEXT PK, value_enc TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT NULL)`，本次只有一行 `key = "llm"`，值是一整组配置的**加密 JSON**（`provider / baseUrl / model / apiKey / timeoutMs`）。
     - 一 key 存一整组，而不是一字段一行：`test` 与 `apply` 天然需要一组彼此一致的值，按行拆开会出现「`provider` 已改成 openai、`apiKey` 还是 ollama 的默认占位」这种半更新态，而它只能靠额外的事务约束来防。
     - 迁移 **`drizzle/0009_settings.sql`**（编号理由见背景表）。
  2. **密钥加密：AES-256-GCM，密钥来自专用环境变量 `SETTINGS_ENC_KEY`**（32 字节随机值，base64 或 hex 写进 `.env.local`；生成命令 `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`）。
     - 派生：`HKDF-SHA256(SETTINGS_ENC_KEY, salt="pakp.settings.salt.v1", info="pakp.settings.aes-256-gcm")` → 32 字节密钥；IV 每次随机 12 字节，存储格式 `v1.<iv-b64url>.<tag-b64url>.<ciphertext-b64url>`。**没有 AAD**：草稿设想的「AAD 绑定 key 名」未实现，防串行的责任因此落在调用侧（`key` 与密文一起读出，不允许跨 key 复用）；将来真出现多 key 时再升 `v2` 补 AAD，版本前缀已留出升级位。
     - **不沿用任务书的 `AUTH_SECRET`**：这个变量在本仓库不存在。**也不复用 `LOGTO_COOKIE_SECRET`**：轮换 Logto cookie secret 会让库里所有已存 API key 当场解不开（密文还在、解密密钥变了），而且 cookie secret 的暴露面比一个只用于设置的密钥大得多。轮换 `SETTINGS_ENC_KEY` 同理：解不开时 `SecretBoxError` 给固定文案「应用密钥已更换或密文被篡改，请重新录入 API Key」，**解密失败不得自动清空该行**，步骤写进 `07_PLAYBOOK`。
     - `SETTINGS_ENC_KEY` 缺失或格式错误时：**读接口返回 `hasKey=false` 并带 `keyError: "未配置加密密钥"`，写接口 503 `SETTINGS_KEY_MISSING`**。绝不静默回落到默认密钥——默认密钥等于明文。
     - **诚实边界（必须写进文档，防止误解）**：`apply` 之后明文 API key 仍会落在 `infra/lightrag/.env`，因为 LightRAG 只从环境变量读模型配置。这层加密保护的是**业务库、数据库备份、导出产物、接口与日志**，不是「本机磁盘上的全部副本」。该文件已在 `.gitignore`（`/infra/lightrag/.env`）里，不入库。
  3. **权限：新增 `settings:read` / `settings:write`，权限清单由 13 项变为 15 项**（修订 ADR-019 第 3 条）：owner / admin 全有，editor / viewer 皆无。`requirePermission` 仍是唯一强制层；`authz.ts` 的 `PERMISSIONS`、`ROLE_PERMISSIONS` 与 `permissions` 表随迁移同批更新，ADR-019 第 2 条的启动一致性校验会守住「代码加了、库里没有」。
     - 只授管理员：这份配置是**全局**的——同一个 LightRAG 实例、同一个图库（ADR-011），editor 改它等于改所有人的抽取行为。
  4. **接口四件套**（`src/app/api/settings/llm/**`），任何响应都不含明文：
     - `GET /api/settings/llm` → `{ provider, baseUrl, model, timeoutMs, hasKey, keyMasked, appliedToLightrag, updatedAt }`（实现未返回 `updatedBy`；操作者信息只在审计里，符合「接口不回多余凭据线索」）。
       - `keyMasked` 取前 4 + 后 4（`sk-…abcd`），短于 12 位只给 `••••`，空则 `null`。
       - `appliedToLightrag` 是**现算的布尔**，不是存下来的标记：把 DB 配置与 `infra/lightrag/.env` 的 `LLM_BINDING / LLM_MODEL / LLM_BINDING_HOST / LLM_TIMEOUT` 逐项比对，全等为 `true`；读不到 `.env` 或任一项不同为 `false`。页面只呈现「已生效 / 未生效（需应用）」两态，不编第三态。
     - `PUT /api/settings/llm` → 校验：`provider ∈ {openai, deepseek, qwen, custom, ollama}`；`baseUrl` 必须 `https://`，或 `http://` 且主机为 `localhost / 127.0.0.1 / ::1 / RFC1918`；`model` 非空、≤ 100 字符；`timeoutMs ∈ [30000, 1800000]`。**`apiKey` 省略 = 保持原值，显式空串 = 清除**——否则「只想改超时」的请求会把密钥抹掉，这是这类表单最常见的坑。保存**不重启、不自动 apply**，返回与 GET 同形。
     - `POST /api/settings/llm/test` → 向 `{baseUrl}/chat/completions` 发最小请求（`max_tokens: 8`、内容 `ping`、客户端超时 10s），返回 `{ ok, latencyMs, model, error? }`。错误只归四类：`401 密钥无效` / `404 路径或模型不存在` / `超时` / `网络不可达`，**不透传上游响应体**（它可能回显请求头）。
     - `POST /api/settings/llm/apply` → 写 `infra/lightrag/.env` 并重启 `lightrag-server`，六步：
       1. 备份：`.env` → `.env.bak-<UTC 时间戳>`（同一目录）。
       2. **逐键替换，不整文件重写**：只改 `LLM_BINDING / LLM_MODEL / LLM_BINDING_HOST / LLM_BINDING_API_KEY / LLM_TIMEOUT`，保留注释、`EMBEDDING_*`、`LIGHTRAG_API_KEY` 等全部其余行；缺失键追加到 `# LLM` 段尾。写入前**拒绝任何含 `\n` / `\r` 的值**（否则一个换行就能注入出新的 env 行）。落盘用临时文件 + rename，避免半写。
       3. 结束 `lightrag-server` 进程：**只按 `lightrag-server` 匹配并只杀它**，绝不碰 9381 的 embedding 服务、Ollama 与任何容器；匹配不到就报错退出，不猜 PID。
       4. 用 `infra/lightrag/start.ps1` 里那条启动命令（同一工作目录）重新拉起。
       5. 轮询 `GET /health` 最多 60s。
       6. 任一步失败 → 用备份覆盖 `.env`、按原配置重启、返回 502，并说明「已回滚到 `<备份时间戳>` 的配置」。
     - 审计：`apply` 写 `settings.llm.apply`、`PUT` 写 `settings.llm.update`，`detail` 只记 `provider / baseUrl / model / 掩码 / 备份文件名`。**审计、日志、错误响应、异常栈一律不含明文 key**；实现上 key 只出现在「加解密函数」与「上游请求头」两处。
  5. **provider 与 LightRAG 环境变量的映射（唯一的写入口径）**：

     | provider | `LLM_BINDING` | `LLM_BINDING_HOST` | `LLM_BINDING_API_KEY` |
     |---|---|---|---|
     | `openai` / `deepseek` / `qwen` / `custom` | `openai` | 用户填的 `baseUrl`（不带 `/chat/completions`） | 用户填的 key |
     | `ollama` | `ollama` | `http://127.0.0.1:11434`（固定，忽略 `baseUrl`） | 占位 `ollama`，不写用户 key |

     `LLM_TIMEOUT` 取 `timeoutMs / 1000` 的整数秒。`EMBEDDING_*` 一行都不动（ADR-001：共用 bge，不共用向量库）。
  6. **可测性**：`src/server/services/llm-settings-service.ts` 收 `env`、`spawn`、`envPath` 等依赖，单测用临时目录 + 假 spawn，**测试里绝不启动真实进程**。
  7. **生效语义**：保存 ≠ 生效。页面必须同时显示「已保存」与「生效中（`appliedToLightrag`）」两件事；`apply` 是唯一让配置落到 LightRAG 的动作，且必须提示「重启会打断正在进行的抽取」。

- **备选方案与取舍**：

  | 方案 | 做法 | 取舍 |
  |------|------|------|
  | **A（采纳）** | DB + AES-256-GCM（`SETTINGS_ENC_KEY`）+ 掩码接口 + 显式 apply | 有审计、有校验、有「是否生效」的答案；代价是多一个环境变量与一次显式重启 |
  | B | 维持手改 `infra/lightrag/.env` + 手动重启 | 零代码；但没有界面（正是使用者要的）、没有审计、没有校验，改错一个键只能靠日志发现 |
  | C | 明文存 DB | 实现最省事；但数据库备份、`data/app.db` 拷走、导出、错误日志任意一处泄漏就是终局泄漏 |
  | D | 不落库，页面每次输入、直接转发或只写 `.env` | 免存储；但无人值守的抽取任务没有 key 可用，每次重抽都要人重填，且仍要写 `.env`，等于用一个更差的入口换掉更好的入口 |
  | E | 用 Windows 凭据管理器 / OS keyring | 本机更安全；但 LightRAG 仍只认环境变量，明文最终还是要落到 `.env`，多一层依赖却没消除主要暴露面 |

- **对 ADR-010 的修订**：LLM 从「固定 Ollama `deepseek-r1:7b`」改为**可配置的 OpenAI 兼容供应商**，默认值不变（仍指向本机 Ollama，未配置时行为与今天一致）。Embedding（bge-large-zh-v1.5 @ 9381）与文件存储两条**不变**。ADR-010 的「本机无 GPU，7B 是唯一可用 LLM」作为事实保留，不再作为约束。

- **影响**：
  - 新增迁移 `drizzle/0009_settings.sql` 与 `settings` 表（列名见「实施说明」）；`src/server/db/schema.ts` 加定义。
  - `src/server/authz.ts`：`PERMISSIONS` 13 → 15，矩阵随之更新；迁移灌入两个新 key。
  - 新增 `src/server/security/secret-box.ts`（加解密 / 掩码 / 取密钥）、`src/server/services/llm-settings-service.ts`（读写 / test / apply）、`src/app/api/settings/llm/{route.ts,test/route.ts,apply/route.ts}`、`src/app/admin/settings/llm/page.tsx`。
  - 导航：第一列「系统」（`NavRail` 的 `adminItem`）进入后，第二列 `AdminDirectory` 的**「系统」分组**新增「大模型」，与「系统状态 / 审计日志」同级；非管理员整项不渲染（与 ADR-019 第 9 条同一做法）。
  - 设计稿：`docs/19_DESIGN_LLM_PREVIEW.md` 的 A 部分；本 ADR 只定契约，不定视觉。

- **风险**：

  | # | 风险 | 应对 |
  |---|------|------|
  | K1 | 密钥从日志 / 审计 / 错误串泄漏 | 审计 detail 只存掩码；上游错误按四类归一，不透传响应体；单测断言「序列化后的响应与审计行不含 key 子串」 |
  | K2 | `apply` 重启打断在途抽取，正在跑的文档丢失进度 | 重启前查 LightRAG 是否有处理中的文档，有则要求二次确认（30 秒内可取消）；被打断的文档需要重新抽取（与图谱线的「重新抽取」同批） |
  | K3 | 配置是全局的，多账号共用同一个 LightRAG 图库 | 本 ADR 明确：设置不按账号区分（ADR-011 的单实例前提）。单机单 owner 下无实际冲突；将来多账号同时使用需按 ADR-011 的强隔离条件重估 |
  | K4 | `.env` 写到一半、或键替换吃掉注释与其他配置 | 临时文件 + rename 原子落盘；逐键替换；apply 后 `git diff --no-index` 式比对，断言只有 5 个 `LLM_*` 行变化（单测用临时目录验证） |
  | K5 | Windows 进程重启不可靠（同名进程、被其他终端拉起） | 只匹配 `lightrag-server`，找不到就报错不猜；失败一律回滚并保留备份文件 |
  | K6 | 轮换 / 丢失 `SETTINGS_ENC_KEY` → 已存密钥全部解不开 | 格式带 `v1.` 版本前缀，轮换需重录一次 key；恢复与轮换步骤写进 `07_PLAYBOOK`，并明确「换密钥不等于换 API key」 |
  | K7 | 「测试连接通过」被误解为「抽取会变快」 | `test` 只证明连通与鉴权，不证明吞吐；页面文案分两行写清，验收项里也分开 |
  | K8 | `baseUrl` 被填成任意内网地址或 `file:` 之类协议 | 白名单 scheme + 私网限制；写入 `.env` 前再次校验（防止绕过 UI 直接调接口） |

- **验收要点**：
  1. `curl` 实测四个接口：`GET` 只返回掩码与 `hasKey`；`PUT` 后 `GET` 立即反映；`POST /test` 对错误 key 返回 401 类原因、对正确 key 返回延迟；`POST /apply` 后 `GET` 的 `appliedToLightrag` 变 `in-sync`。
  2. editor / viewer 调用四个接口全部 403，且 `audit_events` 有 `denied` 记录。
  3. `.env` 前后 diff 只有 5 个 `LLM_*` 行变化，`EMBEDDING_*`、`LIGHTRAG_API_KEY` 与注释逐字不变；备份文件存在。
  4. 故意把 `baseUrl` 写成不可达地址后 `apply`：服务回滚，`.env` 与重启前逐字一致，LightRAG 仍可用。
  5. 单测：加密往返、AAD 不匹配时解密失败、掩码长度边界、`apiKey` 省略与空串两种语义、403、校验边界、`.env` 生成与回滚（临时目录 + 假 spawn）。
  6. 门禁：`npm run typecheck`、`npm run lint`、`vitest run --maxWorkers=2` 全绿。

- **影响范围**：01_ARCHITECTURE（模型接入层）、04_INTEGRATION、06_API、07_PLAYBOOK（密钥轮换与回滚）、09_USER_GUIDE、05_CHANGELOG

---

## ADR-026：知识内容预览（作品 / 资产内容弹窗）

- **状态**：已采纳·已实施（2026-11-13，工作台与详情两入口；检索与图谱入口待接）
- **日期**：2026-11-13
- **实施说明（2026-11-13）**：本轮先接工作台列表标题与详情页「预览」两处，检索与图谱入口留到下一轮（图谱侧同期在改）；列表普通单击改为就地预览，⌘ / Ctrl / Shift 单击仍保持原详情页链接。`?inline=1` 由服务端切换 `Content-Disposition`，`Content-Type` 优先本地 `content_refs.mime`（RAGFlow 对 PDF 常回 `application/octet-stream`）。
- **背景**：正文与元数据早已分离——内容在 RAGFlow，`content_refs` 只存引用（ADR-005 / 007 / 014）。今天唯一能看到内容的入口是工作台右栏的 `ObjectContent`：列出引用、编辑纯文本 / Markdown 正文、下载。它有三处不够：
  - 列表标题点击进的是**详情**，不是「看一眼」；检索结果、图谱节点、首页预览根本没有正文入口。
  - 浏览器默认行为是**下载**（`Content-Disposition: attachment`），想看一眼 PDF 或 Markdown 也要先落盘。
  - 使用者的原话是「解析完不知道内容在哪里看」，本质是缺少一个**读完即关**的预览面，而不是缺编辑面。
- **决策**：
  1. **一个统一组件 `ContentPreviewDialog`**，用原生 `<dialog>` + `showModal()`（与 `record-list` 的删除确认框同一原语，`.dialog` 样式已存在）。四个入口共用：工作台列表标题、检索结果、图谱节点、首页预览。**入口只传 `objectId`，不传内容**——内容一律由弹窗自己按需取。
  2. **打开状态进 URL：`?preview=<objectId>`**，沿用 ADR-013「URL 是选中 / 筛选状态的唯一来源」。刷新、浏览器返回、从检索跳到工作台都能复现；关闭时 `router.replace` 去掉该参数（不新增历史项）。Esc、焦点圈定、`::backdrop` 交给浏览器，不自绘遮罩。
  3. **只用现有接口，不新增预览专用接口**：
     - `GET /api/objects/{id}` → 标题、分类、标签、时间、`parseStatus` 等元数据；
     - `GET /api/objects/{id}/content` → 引用列表（`role` / `mime` / `documentName` / `sizeBytes` / `parseStatus` / `parseError`）；
     - `GET /api/objects/{id}/content/{refId}?inline=1` → 文件流。
     - **`inline=1` 是本 ADR 唯一新增的参数**：置位时 `Content-Disposition: inline`，其余不变（仍 `private, no-store`，仍透传 RAGFlow 的 `Content-Type` / `Content-Length` / 文件流）。不置位时保持今天的「下载」语义，现有调用点（`object-content.tsx` 的下载链接、`record-list.tsx` 的导出）零改动。
  4. **渲染矩阵**（判定收在一处 `contentPreviewKind(ref)`，与 `content-format.ts` 的 `isEditableTextContent` 同一口径）：

     | 内容类型 | 渲染方式 | 边界 |
     |---|---|---|
     | `text/markdown`、`.md` / `.markdown` | 取文本 → `MarkdownPreview`（ADR-014 的零依赖解析器） | 单文件 > 512 KB 只渲染前 2000 行 + 「下载全文」 |
     | 其它 `text/*`、`.txt` / `.json` / `.csv` | `<pre>` 等宽、可滚动、长行横向滚 | 同上 |
     | `application/pdf` | `<iframe title="…">` 同源内嵌 | 打开即加载；> 20 MB 或 iframe 触发下载时降级为「下载后打开」 |
     | `image/*` | `<img>`，容器内 `object-fit: contain` | 不预解码、不做缩略图缓存 |
     | 其余（office / zip / 未知） | 不预览，显示元信息 + 下载按钮 | 文案固定「该类型暂不支持预览」 |

  5. **文本怎么取**：`fetch(url)` 读 `text()`，**先看 `Content-Length`，超过 512 KB 直接降级**；长度未知时流式读取并截断。取回后按 MIME 与扩展名决定 Markdown 还是纯文本——与 ADR-014「类型不落库，由 MIME / 文件名表达」完全一致，不引入第二个类型来源。
  6. **附件切换**：`refs` 中 `role=primary` 默认选中，其余作为附件列在顶部；**主内容缺失时选第一个附件并明确标注「这是附件，不是主内容」**，避免把附件当正文误读。
  7. **解析状态**：显示 `parseStatusLabels` 与 `parseError`，`pending / running` 时沿用 5 秒刷新节奏（与 `ObjectContent` 同一常量，不另写一套）。**解析中也能预览**：预览读的是 RAGFlow 里的原始文件，不依赖抽取结果——这条必须写在界面上，否则会被理解成「解析完才能看」。`failed` 时给「到图谱页重新抽取」的链接（重抽能力由图谱线提供，本 ADR 不实现）。
  8. **权限与归属**：全程 `object:read`；归属校验沿用 `downloadObjectContent` 里的 `getObject(ownerSub)`，**不开第二条读文件路径**；无权限或不属于本账号一律 404，不泄露存在性。
  9. **安全**：不渲染原始 HTML（沿用 ADR-014）；链接仍走 `safeHref`；PDF / 图片与页面同源，不为预览放宽任何响应头。**当前仓库没有 CSP**；将来加 CSP 时必须补 `frame-src 'self'`，已列入验收清单，避免上线后 PDF 全白。
  10. **主题**：只用现有 token（`--surface-*` / `--border-*` / `--text-*`），明暗两套逐一核对。**PDF 内嵌容器固定浅色底**——浏览器内置阅读器不跟随主题，套深色会让纸面变成一块发光的白方块；这是与「全站随主题」刻意不同的一处，设计稿需单独标注。
  11. **性能**：弹窗挂载才发请求，关闭即 `AbortController.abort()`；列表不预取正文；同一对象重复打开用组件内内存缓存（刷新即失效，不做持久化）。

- **备选方案与取舍**：

  | 方案 | 做法 | 取舍 |
  |------|------|------|
  | **A（采纳）** | `<dialog>` 弹窗 + `?preview=` 参数 + 复用现有接口 | 读完即关、可分享可刷新、零新接口；代价是一个新组件与一处 `inline` 参数 |
  | B | 独立路由 `/preview/[id]` | 可深链、可打印；但离开当前上下文，返回会丢滚动与筛选，且与使用者要的「弹窗」不符 |
  | C | 复用工作台右栏详情 | 零新组件；但检索 / 图谱 / 首页没有右栏，四个入口里三个用不了 |
  | D | 引入 `pdf.js` / `react-pdf` | 渲染可控、可做页码与文本层；但多出数百 KB 依赖与 worker，v1 用浏览器内嵌足够，大文件已在矩阵里降级 |
  | E | `<object type="application/pdf">` / 浏览器插件 | 省事；但各浏览器行为不一致，移动端基本不支持，排障成本高于收益 |

- **与既有 ADR 的冲突核对（结论：不冲突）**：
  - **ADR-011**：预览只读，归属过滤照旧走 `owner_sub`。
  - **ADR-019**：仍只需 `object:read`，**不新增权限**；弹窗不是安全边界，真正的挡板仍在 route 的 `requirePermission`。
  - **ADR-022**：图谱节点打开的是同一个弹窗，3D 行为不变；只传 `objectId`，不碰 `GraphSelection` 与两个时钟。
  - **ADR-014**：Markdown 复用同一解析器与 `safeHref`，不新增 XSS 面。
  - **ADR-013**：打开状态进 URL，与「URL 单一状态」一致；不新增第四列。

- **影响**：
  - 新增 `src/components/content-preview-dialog.tsx`、`src/components/content-preview-body.tsx`（按类型分支）、`src/lib/content-preview.ts`（`contentPreviewKind` 纯函数，可单测）。
  - 改动 `src/app/api/objects/[id]/content/[refId]/route.ts`：读 `?inline=1`，只在 `contentDisposition()` 里切换 `inline` / `attachment`；下载路径行为不变。
  - 四个入口各加一行「打开预览」（列表标题按钮、检索结果标题、图谱节点操作、首页预览条目）。
  - 设计稿：`docs/19_DESIGN_LLM_PREVIEW.md` 的 B 部分；本 ADR 只定边界与契约。

- **风险**：

  | # | 风险 | 应对 |
  |---|------|------|
  | P1 | RAGFlow 是否支持 Range 未验证，大 PDF 在 iframe 里整包下载、首屏慢 | 以实测为准：`curl -H "Range: bytes=0-1023"` 看是否 206。不支持就按矩阵的 20 MB 上限降级为下载；**不伪造进度条** |
  | P2 | iOS Safari 内嵌 PDF 只显示首页或直接下载 | 移动端改为「在新标签打开」按钮，文案写清；不承诺内嵌 |
  | P3 | 大文件把页面内存撑爆 | 文本 512 KB 上限、PDF 20 MB 上限、图片走浏览器解码；超限一律降级而不是加载后截断 |
  | P4 | `Content-Disposition` 仍是 `attachment`，iframe 直接触发下载 | `inline=1` 是硬前提；验收用 `curl -I` 断言响应头，并加一条单测 |
  | P5 | 三种「空白」被混为一谈：无内容、解析失败、类型不支持 | 三种空态文案分开写，各自给下一步动作（上传 / 重新抽取 / 下载） |
  | P6 | 深色主题下 PDF 白块刺眼 | 容器固定浅色 + 细边框；设计稿明暗两套都标 |
  | P7 | RAGFlow 回传的文件名可能只剩扩展名 | 一律显示 `ref.documentName`（本地记录的上传名），与下载路由 `route.ts` 的取值口径一致 |

- **验收要点**：
  1. 四个入口都能打开同一弹窗，URL 出现 `?preview=<id>`，Esc / 点遮罩关闭后参数被移除，焦点回到触发元素。
  2. Markdown、纯文本、PDF、图片、未知类型五条分支各有一个真实对象走通；PDF 用 `curl -I "...?inline=1"` 断言 `Content-Disposition: inline`，不带参数时仍是 `attachment`。
  3. 解析中（`running`）的对象能正常预览原文；解析失败的对象显示 `parseError` 与重抽入口。
  4. 他人对象（`owner_sub` 不同）打开返回 404；`viewer` 角色可预览、不可编辑（编辑入口按 `object:write` 显隐）。
  5. 明暗两主题逐项核对：背景、边框、文字、PDF 容器、空态、加载态无一处裸色值（新增样式只引用 token，`npm run check:theme` 不因本次新增字面量而变红）。
  6. 门禁：`npm run typecheck`、`npm run lint`、`vitest run --maxWorkers=2` 全绿；新增 `content-preview` 纯函数单测覆盖类型判定与大小边界。

- **影响范围**：02_PHASES、06_API（`?inline=1`）、09_USER_GUIDE、05_CHANGELOG

---

## ADR-027：/graph 全屏星图画布 + 液态玻璃浮层

- **状态**：已采纳·已实施（2026-11-13）
- **日期**：2026-11-13（v1.1 修订：2026-11-13，见文末修订行）
- **背景**：ADR-022 落地后图谱功能可用，但使用者反馈「布局别扭，星图太小」。根因是**布局层把画布当成了一个卡片**：
  - `.graph-page` 固定 `max-width: 1180px`，内容区再扣掉目录栏与内边距，画布实际只有约 1100×800 中的一部分。
  - `.graph-toolbar` 是普通主题面板，`.graph-layout` 是 `1fr + 336px` 的网格，详情栏**参与布局**——选中实体后画布从 1108 缩到 756（`16_GRAPH_DESIGN.md` §3.2 原设计如此）。星图作为「看整体结构」的视图，反而被面板挤到最小。
  - 结果是：功能都在，但星空没有成为页面的主角；使用者要的是「这一整页的背景都做成星图，玻璃板不挡着星图」。
- **决策**：把 `/graph` 内容区从「卡片里的画布」改为「**画布即背景，控件浮在上面**」。
  1. **范围**：只覆盖内容区（右侧主区域，含页头），**不含**最左侧导航栏与第二列模块目录（ADR-013 的三栏结构不变）。列表模式例外，见第 6 条。
  2. **坐标与尺寸**：`.graph-page` 取消 `max-width: 1180px`，改为填满内容区；`.graph-workspace` 成为定位容器——`position: relative`，高度 `calc(100dvh - <页头>)`，最小 560px。画布层 `position: absolute; inset: 0; z-index: 0`，铺满且不参与文档流；浮层全部 `z-index: 1` 以上。
  3. **控制区（左上角紧凑玻璃卡，v1.1 改写）**：原 `.graph-toolbar` 面板（标题、实体计数、同步状态、中心/邻域、深度、2D 聚焦、星系、列表、自动旋转、刷新、同步内容）改为**贴左上角的紧凑玻璃卡**：`position: absolute; top: 16px; left: 16px`，宽度按内容自适应，**上限 `min(880px, calc(100% - var(--graph-rail-w) - 48px))`**。其中 `--graph-rail-w` 就是右栏宽度（默认 `356px`，`max-width: 1000px` 断点内为 `300px`——按实现取 1000：更宽时 356 的右栏仍放得下，1024 宽下再扩到 356 会把控制卡压到 320px 以内），`48px` = 左 16 + 两卡间距 16 + 右 16。标题、状态、原有一排控件全部在卡内，**允许控件折成两行排列**（宽度更窄时可再增行），**不压缩控件命中区、不删功能**；原 `.graph-page-header` 的标题与说明并入这张卡，不再单独占一块。收起态只保留**标题 + 状态 + 展开按钮**。
     - **理由（实机反馈）**：横贯整条在 1440×900 上压掉了星图顶部约 230px，而且与右侧详情卡形成**两条互不相干、顶边还不对齐**的横带——视觉上像两排工具栏而不是两个浮件。收到左上角后，星图中上部完整露出，两张卡在同一水平线上成对出现（一左一右各守一个角）。
     - **定位基准**：绝对定位的包含块是 `.graph-workspace` 的 **padding box**；浮层模式下 `.graph-workspace` 的内边距必须归零，否则现有的 `padding: 10px` 会让视觉边距变成 26px。
     - **顶部标签胶囊**：`.graph-stage-head`（「…的邻域 / N 个实体 · M 条关系 / 星系 · high」）原本就在左上角，控制条脱离文档流后它会与控制卡重叠。**首选并入控制卡**（成为标题行下方的元信息行，不再单独一个药丸）；若保留独立胶囊，其 `top` 必须由控制卡实测高度驱动（`top: calc(16px + var(--graph-bar-h) + 8px)`，变量由组件写入），不允许写死。
     - 原表述「`top/left/right` 各 16px 的**顶部一整条**、宽度不足时换行而不是压缩控件」**作废**，由本条取代。
  4. **实体详情（右上角玻璃卡，v1.1 改写）**：`.graph-inspector` 从网格列改为**贴右上角的玻璃浮层**：`position: absolute; top: 16px; right: 16px`，宽 `var(--graph-rail-w)`（默认 **356px**，`max-width: 1000px` 为 300px），最高 `60%`（相对 `.graph-workspace` 高度）、内部独立滚动 + `overscroll-behavior: contain`。**顶边与左上控制卡是同一条水平线**（实测差 ≤1px），**不再从控制条底部起算**，也不再 `bottom: 16px` 拉满整列。未选中时显示引导文案（「点击星图里的实体查看详情」），选中后切换为详情。**画布尺寸与相机不因详情打开而改变**——这与设计稿 §3.2「详情栏参与布局、选中时画布 1108→756」**相反**，本条取代该行。
     - **横向关系**：两卡之间至少 **16px**，1440 与 1920 下均不得重叠；间距由第 3 条的上限公式保证（上限里已经扣掉 48px，见验收第 8 条）。
     - **右栏剩下的位置**：`.graph-workspace` 的第二列网格行继续留给「问图谱」卡（贴右下、同宽 `var(--graph-rail-w)`、`align-self: end`）；详情卡浮在它上方，两者不互相挤压，画布中心不被覆盖。
     - 原表述「宽 336px、`top: calc(控制条实际高度 + 12px)`、`bottom: 16px`」**作废**——336 是浮层模式之前的旧网格值，实际令牌已是 356。
  5. **2D 聚焦模式同样全幅**：`.graph-stage-wrap` 去掉边框与圆角，SVG 铺满画布层，浮层位置与控制区一致；`[data-surface="graph"][data-mode="2d"]` 的边对比度令牌不变。
  6. **列表模式保持常规文档流**：`mode=list` 不挂载画布、不使用玻璃，回到主题面板与普通排版；这样既不浪费一个 WebGL context，也保证长列表的可读性与无障碍语义。
  7. **指针分层（硬约束）**：浮层的**容器** `pointer-events: none`，每个玻璃板自身 `pointer-events: auto`；画布接收其余全部指针事件。**禁止**用全屏透明遮罩承载点击或滚动——那会吞掉星图的拖拽、滚轮与双击。
  8. **浮层可折叠但不可消失**：控制条可收到「摘要行」（标题 + 计数 + 展开按钮），详情可收到右侧把手；折叠状态不进 URL（属纯视觉偏好，与 ADR-022「URL 是视图状态源」不冲突，因为 `mode / focus / depth` 仍只在 URL 里）。
  9. **液态玻璃配方（唯一实现，v1.1 扩写）**：在既有固定深色面 `[data-surface="graph"]` 里新增令牌，规则体一律引用令牌，**不写裸色值**：

     | 令牌 | 值 | 用途 |
     |---|---|---|
     | `--graph-glass-bg` | `color-mix(in srgb, var(--graph-canvas) 72%, transparent)` | 玻璃底色（72% 是文字可读与「看得见星」的折中点） |
     | `--graph-glass-border` | `color-mix(in srgb, var(--graph-accent) 22%, transparent)` | 1px 外框 |
     | `--graph-glass-highlight` | `rgb(255 255 255 / 6%)` | `inset 0 1px 0` 内高光 |
     | `--graph-glass-pointer-core` | `rgb(255 255 255 / 30%)` | `::before` 指针径向高光的最亮色 |
     | `--graph-glass-pointer-mid` | `rgb(255 255 255 / 12%)` | 同上，中段衰减色 |
     | `--graph-glass-sheen-1` | `rgb(255 255 255 / 18%)` | `::after` 斜向反光的 0% 停止点 |
     | `--graph-glass-sheen-2` | `rgb(255 255 255 / 3%)` | 22% 停止点（最暗） |
     | `--graph-glass-sheen-3` | `rgb(255 255 255 / 8%)` | 55% 停止点 |
     | `--graph-glass-sheen-4` | `rgb(255 255 255 / 14%)` | 100% 停止点（另一侧亮边） |

     > 以上九项全部写在 `[data-surface="graph"]` 令牌块内（含白 30% / 12% / 18% / 3% / 8% / 14% 六个字面量）。E7 只统计「主题块与 cosmic / graph 块之外」的字面量，因此基线仍是 26；规则体（含伪元素）只写 `var(--graph-glass-*)`。

     **基础层（不变）**：`background: var(--graph-glass-bg)`、`backdrop-filter: blur(14px) saturate(130%)`（`-webkit-` 前缀同写）、`border: 1px solid var(--graph-glass-border)`、`border-radius: var(--r-md)`、`box-shadow: inset 0 1px 0 var(--graph-glass-highlight)`。模糊半径上限 **18px**：再大只是 GPU 开销，视觉上已无差别。

     **三层质感（v1.1 新增，这是「塑料感」与「液态玻璃」的分界）**——`backdrop-filter` 只负责「糊」，**厚度与湿度来自这三层**：
     - **① 跟随指针的径向高光**（`::before`）：`position: absolute; inset: 0; border-radius: inherit; pointer-events: none; z-index: -1;`，`background: radial-gradient(circle at var(--mx, 50%) var(--my, 50%), var(--graph-glass-pointer-core) 0%, var(--graph-glass-pointer-mid) 16%, transparent 42%)`——即中心 30% 白、16% 处 12%、**42% 处收敛为透明**，再往外只剩底与星空；指针离开即删掉 `--mx/--my`，回到 50% / 50%。
     - **② 160° 斜向反光**（`::after`）：同上定位与 `pointer-events: none`，`background: linear-gradient(160deg, --graph-glass-sheen-1 0%, -2 22%, -3 55%, -4 100%)`，`mix-blend-mode: screen`（白 18% → 3% → 8% → 14%，两边亮中间暗，模拟一块玻璃的斜面厚度）。卡片自身加 `isolation: isolate`，让 `screen` 只与玻璃底混合、**不与背后的星图混合**。
     - **③ 轻微厚度倾斜**：卡片 `transform: perspective(1200px) rotateX(var(--rx, 0deg)) rotateY(var(--ry, 0deg))`，**最大 3°**（系数 0.06：`(x% − 50) × 0.06`，超过就变成「会动的卡片」，不再像玻璃）。倾斜只在指针位于卡内时生效，离开即删变量回零，`transition: transform 220ms ease-out`。
     - **实现约束（硬性）**：
       - 两层伪元素必须 `pointer-events: none`；实现用 `z-index: -1` 把光层放在卡片自身底色之上、内容之下，子元素因此不必逐个加定位（细节卡的折叠把手仍按普通子元素排版）。
       - `--mx / --my / --rx / --ry` 用 **ref + `style.setProperty`** 写到卡片元素上（不走 React state，避免每帧重渲染），`pointermove` 监听挂在**卡片自身**、`{ passive: true }`，并用 **`requestAnimationFrame` 合并**一帧内多次事件；`pointerleave` 删除变量复位；卸载时移除监听与 rAF。**不在 `workspace` / `document` / `window` 上挂指针监听。**
       - **`prefers-reduced-motion: reduce`**：`transform: none`（不倾斜）、`::before` 设 `opacity: 0`（不跟随），保留 `::after` 静态斜向反光。
       - `data-glass="solid"`（`low` 档 / 运行时降档）与 `prefers-reduced-transparency: reduce` 下：底色提高到 92%、关掉 `backdrop-filter`；倾斜与两层光仍按上一档规则运行（它们不产生背景采样开销）。
       - 触屏：`pointerType === "touch"` 的移动直接忽略；宽度 < 768px 时整段跟随/倾斜逻辑不挂载，只渲染静态两层。
     - **统一材质**：控制卡、详情卡、问图谱卡，以及左上角标题胶囊（`.graph-stage-head.is-chip`）用的是**同一套** `.graph-glass` 规则；不允许某一块单独调底或单独加边框色。
     - **字面量基线仍是 26**：新增的高光 / 反光写成白 30% / 12% / 18% / 3% / 8% / 14% 六个字面量，且**只出现在 `[data-surface="graph"]` 令牌块内**（该块不在 E7 的统计范围内），规则体与伪元素不新增裸色值。
  10. **玻璃内的文字与控件一律用** **graph 面令牌**（`--graph-core` / `--graph-accent` / `--graph-edge-strong`），**禁止使用主题的 `--text-*` / `--surface-*`**。原因很具体：舞台固定深色，而 `pine` / `sand` 是浅色主题，`--text-1` 在浅色主题下是深色——照搬会得到「深字压深玻璃」，四个主题里有两个直接不可读。这条同时意味着：**玻璃浮层里不要再出现 `.panel` 这类主题面板类**。
     - **实施说明（2026-11-13，按实现修正）**：落地手法是**作用域内重映射**——在 `.graph-workspace.is-float` 上把 `--text-*` / `--surface-*` / `--line*` / `--danger-*` / `--warn-*` 等主题变量重新定义为 graph 面令牌的取值，共用规则里仍写 `var(--text-1)`，但解析出来就是星图色。四主题实测标题计算色相同（`rgb(246 227 198)`），对玻璃底 16.17:1，条款目的已达成，因此不要求逐条改写选择器。判定口径不变：**只要在玻璃里出现主题的浅色/深色实际取值就算违规**，以四主题计算色一致为验收。
  11. **对比度**：扩展 `scripts/check-contrast.mjs` 增加 `graph.glass` 组——正文/正文级文字对**玻璃底与最亮画布合成后的等效色** ≥ 4.5:1，图标与链接 ≥ 3:1；**1px 玻璃描边按装饰性边界 ≥ 1.5:1**。`npm run check:contrast` 与 `npm run check:theme` 都必须继续绿；后者 E7 的**字面量基线仍是 26**（新令牌写在 `[data-surface="graph"]` 块内，规则体不新增字面量，所以基线不动；若将来在别处写裸色值，照旧按「只允许减少」失败）。
     - **描边为何不按 3:1（2026-11-13 裁决）**：22% 强调色的描边对玻璃底实测 1.73:1，要够 3:1 需提到约 48%，观感会从「细边框」变成「亮圈」，与液态玻璃的目标相反。面板的辨认并不依赖这条描边——72% 的玻璃底本身与星图有明确亮度差，描边只是层次提示；因此按 WCAG 1.4.11「非必需的装饰性边界」处理，门禁按 1.5:1。文字与可交互控件不受此豁免。
  12. **降级链（按顺序短路）**：
      - `@supports not (backdrop-filter: blur(1px))` → 玻璃底色提高到 `color-mix(in srgb, var(--graph-canvas) 92%, transparent)`，仍是深色面板；
      - `prefers-reduced-transparency: reduce` → 同上（92%）；
      - 档位为 `low`，或运行时连续掉帧触发降档 → **关闭 `backdrop-filter`**，只留 92% 底；
      - 无 WebGL → 既有 2D 回落不变（ADR-022），2D 玻璃同规则；
      - `prefers-reduced-motion` → 既有约定不变：星图不自动旋转，玻璃不加入场动画。
  13. **性能边界（不新增数字，沿用 ADR-022）**：画布变大只增加填充率，**不改**节点 / 边 / 标签 / DPR 预算（150 / 300 / 600 与 DPR 2 / 1.5 / 1），也不改 2000 节点输入抽稀与 Worker 的验收口径。`backdrop-filter` 只作用于**尺寸固定的浮层**，不得挂在随帧变化或随滚动重排的元素上；画布尺寸变化按既有路径处理——2D 用 `graph-stage-2d.tsx` 已有的 `ResizeObserver`（已按 32px 分档防抖），3D 用 `@react-three/fiber` 的画布尺寸与相机 aspect 自动更新；**不在每帧改 canvas 尺寸**，也不为改布局新增第二套尺寸监听。
  14. **移动端（≤ 767px，v1.1 按实现校准）**：3D 入口本就隐藏（ADR-022），2D 全幅铺满；**控制条仍为单行**（标题 + 状态点 + `⋯` 展开按钮，展开后才出控件），**实体详情仍为底部抽屉玻璃板**（`max-height: 55dvh`、内容超出时内部滚动，未选中实体时整块不出现；收起走抽屉上的「收起」把手，**本轮没有实现上下滑动手势**），「问图谱」在文档流最底部。
      - **抽屉打开时的画布语义（原条款没写清，此处钉死）**：**画布层 `.graph-stage-layer` 仍 `inset: 0` 全幅**（背景/星点铺满到抽屉底下，不出白边）；**只把 2D 舞台盒子 `.g2-stage` 缩进安全区**——`top: var(--graph-stage-top)`、`height: var(--graph-stage-h)`，两个变量由组件按「栏底 / 抽屉顶」实测写入，舞台按新尺寸重排。
      - **可读性底线**：选中实体与它的 1 跳邻居，**底边必须高于抽屉顶边至少 8px**（`--graph-stage-h` 就按「抽屉 `getBoundingClientRect().top - 8 - 舞台起点`」计算）；抽屉不得盖住星核与 1 跳环。
      - 桌面宽度下的鼠标跟随高光与倾斜在触摸端不启用（`pointer: coarse`），只保留静态两层。
      - 原表述「画布上半（≥ 45dvh）必须始终可拖拽」保留，但**以本条的安全区缩放为准**：拖拽区域是缩进后的舞台，不是被抽屉压着的整层画布。
  15. **空态与错误态**：沿用现有 `graph-state-card` 文案与分支（加载中 / 加载失败 / 状态读不到 / 图谱为空 / 无邻居 / 抽取失败列表），只把它们放进玻璃浮层并居中；**不新增状态**，也不因为改布局重写文案。

- **与既有 ADR 的关系（结论：只改容器层，不动渲染层）**：
  - **ADR-022**：3D 渲染、档位（`low / balanced / high`）、`frameloop="demand"`、8 个 draw call、Worker、两个时钟、`onStats` 契约**全部不变**。本 ADR 只改「舞台放在哪、多大、上面盖什么」。
  - **ADR-021**：`[data-surface="graph"]` 是既有固定面，新增 6 个玻璃令牌（底 / 边 / 内高光 / 指针高光两段 / 斜向反光）写在同一个块里，**不新增第四个主题块、不改 129 名契约**；`check-theme` 的 E1–E8 不受影响。
  - **ADR-013**：三栏结构、URL 单一状态不变；第二列目录仍是普通主题面板，不玻璃化。
  - **ADR-026**：实体详情里的「打开内容预览」入口位置不变，预览弹窗层级高于玻璃浮层。
  - **16_GRAPH_DESIGN.md**：§3.2 / §3.3 中与「详情栏参与布局、画布 1108→756」「按视口分档改浮层位置」相关的条款由本 ADR 取代，统一为「画布恒定全幅 + 左上角控制卡 + 右上角详情卡（顶边同线）」；相机、避让中心 40% 圆区、问答 dock、小地图等其余条款不变。设计稿由 Designer 按本条修订。

- **备选方案与取舍**：

  | 方案 | 做法 | 取舍 |
  |------|------|------|
  | **A（采纳）** | 画布铺满内容区，控制条与详情做成玻璃浮层 | 星图真正成为页面主体，功能不丢；代价是浮层对比度与指针层级要单独验收 |
  | B | 保留卡片，只把卡片与画布放大到 1440 | 改动最小；但达不到「整页背景」，只是把同一块画布放大一点 |
  | C | 全屏半透明暗色遮罩（不做模糊） | 便宜、稳；但「玻璃」的层次感没有，且遮罩一厚就挡住星图，与需求相反 |
  | D | 用磨砂 PNG / SVG 纹理贴图模拟玻璃 | 不依赖 `backdrop-filter`；但每种尺寸与 DPR 都要多套资源，且背景是动态星图，贴图无法跟随 |
  | E | 画布全幅、浮层保持普通主题面板 | 实现最省；但浅色主题下会在星空上出现亮色面板，割裂感比现在更强，且主题文本令牌在固定深色面上本就不可读 |

- **影响**：
  - `src/app/globals.css`：`.graph-page` 去掉 `max-width`；`.graph-toolbar` / `.graph-inspector` 改为浮层；**v1.1：两张卡从网格列改为绝对定位（`top: 16px` + 左/右 16），`padding` 归零，控制卡宽度上限改为 `min(880px, 100% - var(--graph-rail-w) - 48px)`，详情卡顶边与它同线、去掉 `bottom: 16px`**；新增 6 个高光 / 反光令牌（`--graph-glass-pointer-core` / `-mid`、`--graph-glass-sheen-1..4`）与 `@supports` / `prefers-reduced-transparency` / `data-glass="solid"` 分支；触屏与 <768px 由组件不挂跟随逻辑。
  - `src/components/graph-explorer.tsx`：DOM 层级从「工具条 → 网格（主 + 详情）」改为「canvas 层 → 浮层（控制条 / 详情）」，`data-surface="graph"` 保持在最外层容器上；`pointer-events` 分层。**v1.1 追加**：玻璃统一由 `.graph-glass` 承担；新增指针跟随与倾斜——`ref` + 每张卡自身的 `pointermove`（`passive`）+ `requestAnimationFrame` 合并写 `--mx/--my/--rx/--ry`，`pointerleave` 复位，卸载清理；`prefers-reduced-motion` 与触屏 / 窄屏下不挂监听。左上角标题胶囊按第 3 条并入控制卡（或由 `--graph-bar-h` 驱动下移）。
  - `src/components/graph/graph-scene-3d.tsx` 与 2D 舞台：容器从卡片改为 `inset: 0`，尺寸变化交给 `ResizeObserver`。
  - `scripts/check-contrast.mjs`：新增 `graph.glass` 组。
  - `docs/16_GRAPH_DESIGN.md`：§3.2 / §3.3 两处由 Designer 回改（本 ADR 登记分歧，不代改设计稿）。

- **风险**：

  | # | 风险 | 应对 |
  |---|------|------|
  | G1 | 画布面积变大后填充率上升，1440 或 1920 下掉帧 | 预算与档位不变，先按 ADR-022 的次序砍标签 → 降 DPR → 回落 2D；验收在 1440×900 与 1920×1080 各采一次 `__graphStats`，读数不设新阈值 |
  | G2 | `backdrop-filter` 在弱 GPU / 远程桌面下很贵 | 模糊半径 ≤18px、只作用于固定尺寸浮层；`low` 档与 reduced-transparency 下直接关闭，退到 92% 实色 |
  | G3 | 玻璃里误用主题文本令牌，浅色主题下深字压深底 | 第 10 条写成硬规则；`grep -n "text-1\|text-2\|text-3\|surface-" src/components/graph-explorer.tsx` 作为提交前自检；四主题逐一截图 |
  | G4 | 玻璃上的文字对比度随星点亮度波动 | 玻璃底不透明度 ≥72% + 模糊把星点摊平；对比度按「玻璃底与最亮画布合成」计算并按 WCAG 2.1 判定，读数进 `check:contrast` |
  | G5 | 浮层吞掉画布交互（拖拽、滚轮、双击聚焦） | 容器 `pointer-events: none` + 面板 `auto`；用真实指针 e2e 验收，不只看截图 |
  | G6 | 详情浮层盖住星核或 1 跳环 | 沿用设计稿的「中心 40% 圆区不被覆盖」避让规则；1920 宽下浮层只占右 356px，仍满足 |
  | G7 | 列表模式误挂 WebGL，或退出列表后 context 泄漏 | `mode=list` 条件挂载画布；切回时新建、切走时卸载，沿用 ADR-022 的上下文生命周期 |
  | G8 | 窗口缩放或浮层折叠时布局抖动、画布反复重排 | 沿用两条既有路径（2D 的 `ResizeObserver` 32px 分档、3D 的 fiber 画布尺寸），浮层折叠用固定宽高过渡，不触发每帧尺寸变化 |
  | G9 | **v1.1 新增**：控制卡与详情卡在窄内容区相撞（`≤1000px` 时内容区约 700px，右栏 300、控制卡上限约 352） | 上限公式统一用 `var(--graph-rail-w)` 表达而不是写死 356；公式里扣的 48px 就是三段间距，按验收第 8 条在 1440 / 1920 各测一次 `getBoundingClientRect`；`≤1000px` 断点（详情卡退为 300px 宽）同样适用 |
  | G10 | **v1.1 新增**：控制卡收窄后控件折行，卡片变高，重新压住星图顶部 | 允许折行但**不许压缩命中区**；确认两行内的排布（1440 下预期两行）；卡片加 `max-height` 与内部滚动兜底，折叠入口保留在卡头 |
  | G11 | **v1.1 新增**：`transform` 倾斜 + `backdrop-filter` 叠加导致玻璃内文字发虚、或引入新的合成层吃显存 | 倾斜上限 3°、`perspective(1200px)`；只在指针位于卡内时才写 `--rx/--ry`（静止时变量被删除，回 0deg，不创建持久合成层）；不用 `will-change` 常驻；验收时逐卡检查文字清晰度（1440 与 2×DPR 各一次） |

- **验收要点**：
  1. 1440×900 与 1920×1080：画布铺满内容区（不再有 1180 上限与卡片边框），**控制卡贴左上、详情卡贴右上，均为玻璃浮层**；`document.querySelector(".graph-page").scrollWidth` 不超出内容区。
  2. 四套主题（`galaxy / pine / sand / midnight`）逐一切换：玻璃内文字、图标、边框全部可读，无深字压深底；玻璃浮层里不再出现 `.panel` 类。
  3. `node scripts/check-theme.mjs`：129 名契约通过、字面量仍为 **26**；`node scripts/check-contrast.mjs`：新增 `graph.glass` 组通过，其余组读数不回退。
  4. 关闭 `backdrop-filter` 支持（或强制 `low` 档）时，玻璃退为 92% 实色板，文字仍达标，星图仍可见。
  5. 指针与键盘：星图拖拽 / 滚轮缩放 / 双击聚焦在浮层之外全部可用；Tab 顺序为「控制条 → 画布 → 详情」；控制条可折叠并用键盘展开。
  6. 390×844：控制条一行、详情为底部抽屉、画布上半仍可拖拽；列表模式无画布、无玻璃。
  7. `__graphStats` 在 150 / 300 / 600 三档下读数与 ADR-022 一致（`drawCalls ≤ 8`、`dpr ≤ 档位上限`、空闲 `frames` 不增长）。
  8. **两卡几何（v1.1）**：1440×900 与 1920×1080 下，控制卡与详情卡 `getBoundingClientRect().top` **差 ≤1px**；控制卡 `right` 与详情卡 `left` 的**间距 ≥16px**；两卡均不越出 `.graph-workspace`，页面无横向滚动；`≤1000px` 断点（右栏 300）下同样成立。
  9. **指针高光与画布手势（v1.1）**：鼠标移过任一玻璃卡，`--mx / --my` 连续变化、`::before` 高光跟着走，移出后平滑复位；倾斜角始终 ≤3° 且文字不发虚；在卡片之间的空隙、卡片上方的星图区域，**拖拽 / 滚轮缩放 / 双击设为中心照常**；`prefers-reduced-motion: reduce` 下无倾斜、`::before` 隐藏（`opacity: 0`），`::after` 静态反光保留。
  10. **主题与对比度门禁（v1.1）**：`node scripts/check-theme.mjs` 129 名契约通过、字面量仍 **26**；`node scripts/check-contrast.mjs` **41/41 通过**，四主题（`galaxy / pine / sand / midnight`）读数均**不回退**（`--graph-core` 对玻璃底 ≥15.92:1、`--graph-glass-border` 1.73:1）。

- **影响范围**：01_ARCHITECTURE（图谱容器层）、13_DESIGN_V3、16_GRAPH_DESIGN（§3.2 / §3.3 由 Designer 回改）、globals.css、check-contrast.mjs、05_CHANGELOG

> **v1.1 修订（2026-11-13）：按实机反馈调整几何与材质。** 第 3、4 条由「横贯顶部一条 + 从条底起算的右侧栏」改为「左上角紧凑控制卡 + 右上角同线详情卡」；第 9 条在原有 72% 底 + 模糊 + 22% 描边 + 1px 内高光之上，补指针径向高光、160° 斜向反光与 ≤3° 倾斜三层质感，令牌由 3 个增至 9 个（新增的 6 个是白 30/12/18/3/8/14% 字面量，全部写在 `[data-surface="graph"]` 块内，字面量基线仍 26）；第 14 条按实现补写「画布层 `inset: 0`、只缩进 2D 舞台盒子、选中实体与 1 跳邻居底边高于抽屉 ≥8px」；验收补第 8、9、10 条。第 10、11 条的既有裁决（玻璃作用域内重映射主题变量、描边按装饰性边界 1.5:1）不变。

---

## ADR-016 ~ 018 实施风险清单

> 按严重程度排序。前 3 条必须在动手前处理完，其余随实现跟进。

| # | 风险 | 触发点 | 应对 |
|---|------|--------|------|
| R1 | **迁移直接失败**：Drizzle 把迁移包在单个事务里，`PRAGMA foreign_keys = OFF` 在事务内无效，`DROP TABLE objects` 被 `library_events` 外键挡住（已实测） | ADR-016 第 8 条 | 把外键开关移到 `migrate()` 外层 + `PRAGMA foreign_key_check` 断言；先在 `data/app.db` 副本上跑通再打包 |
| R2 | **迁移语义错误但语法通过**（如 format 映射错、标签灌重），项目没有 down 迁移 | ADR-016 | 迁移前自动备份 `data/app.db` → `app.db.bak-<时间戳>`（仅当存在未应用迁移时）；演练脚本保留在 `scripts/`；断言对象数、work 的 format 分布不变 |
| R3 | **软删除不清理 `object_tags`**：对象是软删，外键级联不会触发，删除后标签使用次数会虚高，删标签时被「看不见的引用」挡住 | ADR-015 批量删除 + ADR-016 第 3 条 | 使用次数统计一律带 `join objects ... and objects.deleted_at is null`；`softDelete` 事务里不做删除，但在文档与测试里钉死这条语义 |
| R4 | 批量操作用 `Promise.allSettled` 逐项发请求，词表外键冲突会变成 N 个 409，提示信息容易退化 | ADR-015 | 批量条对 409 单独聚合（「M 项因词表引用失败」），不做静默忽略 |
| R5 | 主题分批改造期间出现「半深半浅」的过渡态，被当成 bug 上报 | ADR-017 第 6 条 | 每批一个独立提交 + 4 页截图基线；第 1 批完成前不合并第二个主题 |
| R6 | 深色主题下 26 处 `rgba(23,37,31,…)` 阴影会变成脏黑块 | ADR-017 第 6 条第 2 批 | 阴影全部转成 `--shadow-*` / `--overlay` 语义 token，再定义主题值 |
| R7 | 首页 canvas 常驻 rAF 拖慢低端机与电池 | ADR-018 第 7 条 | 四级降级链 + `devicePixelRatio` 上限 + 隐藏即暂停；验收用 5 秒性能采样 |
| R8 | 首页成为新的硬编码颜色重灾区（星空自己一套颜色） | ADR-017 第 5 条 | 星空色值必须走 `[data-surface="cosmic"]` 的 token 块，纳入同一条 `grep` 审计 |
| R9 | 测试基线 22 文件 / 231 项受影响：`object-repository`、`object-service`、`export-markdown`、`workspace-filters`、`content-service` 里都有 format / tags fixture | ADR-016 | 预计改 4~6 个文件、新增 3 个（vocabulary、theme、galaxy）；全绿是合入门槛 |
| R10 | **词表读取失败会整页渲染失败——当前没有兜底** | ADR-016 第 5 条 | 以实现为准（2026-11-12）：`listVocabulary(db)` 是同步查询，四个页面调用点都没有 try/catch——`/workspace` 抛错由 `src/app/workspace/error.tsx` 错误边界接住，`/search`、`/graph`、`/admin` 没有错误边界，落到 Next 默认错误页；`GET /api/vocabulary` 自带 try/catch，返回错误 JSON。词表**为空**（不是读失败）时，新建面板显示「还没有可用形态，请管理员先添加一个。」（`create-object-dialog.tsx:273`）。原稿写的「`VocabularyProvider` 内置 `SYSTEM_FORMAT_SEEDS` 兜底」不存在，`src/` 里已没有任何种子兜底。建议**不**静默回落种子（词表读失败基本等于库读失败，假装有形态只会让人以为标签 / 形态丢了），改为给 `/search`、`/graph`、`/admin` 补错误边界与可操作文案；是否补由后续决定 |
| R11 | 标签归一化碰撞（全角 / 半角、`A` vs `a`、重复空白）在前端表现为「明明没重名却 409」 | ADR-016 第 7 条 | 前端先用同一套 `normalizeTag` 本地查重并提示「已有同名标签：X」，服务端唯一约束是最后防线 |
| R12 | ~~**未纳入本批**：使用者提出的「管理页面细化（用户 / 角色 / 权限管理）」与 ADR-003、ADR-012 冲突~~ **已由 ADR-019 决策** | 使用者反馈第 4 条 | ADR-019 废止 ADR-003 的 RBAC 条款、取代 ADR-012 的角色来源条款，引入本地五表 + 13 项权限 + 审计表；本清单不重复其风险，见 ADR-019 的 A1~A7 |

---

## 附：与需求 / 设计文档的待对齐项裁决（2026-11-12）

> `12_REQUIREMENTS_V3.md`「待对齐项」表里 7 条标注「需 Architect 拍板」的，逐条裁决如下。第 5 条已回改需求文档；其余结论已写入对应 ADR，需求 / 设计正文由 Product / Designer 同步。

| # | 冲突点 | 裁决 | 依据 |
|---|--------|------|------|
| 1 | 词表管理路由 | **`/admin/vocabulary/formats`、`/admin/vocabulary/tags`**，不采用设计稿的 `/admin/vocab/*` | 后端接口已是 `/api/vocabulary/*`，页面与接口必须同词；同一概念两种写法正是「一处改了另一处没改」的来源。两页拆开仍按设计稿 |
| 2 | 首页渲染技术 | **Canvas 2D 手写**，视觉效果向设计稿靠，但不为一张背景引入 WebGL | 零依赖、可四级降级（ADR-018 第 7 条）；WebGL 在无 GPU / 远程桌面 / 老驱动上直接黑屏，且必须 `ssr:false` |
| 3 | 未登录首页搜索框 | **渲染但禁用 + 提示「登录后可检索内容」**（采纳设计稿，覆盖 ADR-018 初稿） | 登录前后布局不跳变；禁用态不发请求，401 问题不存在。ADR-018 第 2 条与验收第 1 条已改 |
| 4 | 首页是否内联结果 | **本 ADR 采纳：首页内联预览**（≥ 2 字、200ms 防抖、8 条、不碰 RAGFlow）；`/search` 仍是完整结果页 | 覆盖 ADR-018 时期「v1 只跳结果页、内联留待以后」的旧口径，参数见 ADR-024 第 8 条。预览走同一个 `/api/search?mode=lexical&limit=8`，状态机是结果页的子集（无 RAGFlow、无阈值、无分页），不存在复制 loading / 空态 / 401 三套逻辑的成本 |
| 5 | 单对象标签上限 | **10 个** | 与需求文档、设计稿、已实现常量三方一致；ADR-016 已回改 |
| 6 | 主题持久化 | **只做 `localStorage` + 内联脚本**，不做 cookie | 内联脚本已能保证首帧正确；读 cookie 会迫使根布局变成动态渲染，且两种存储必然漂移。出现「服务端必须知道主题」的硬需求时再加 |
| 7 | 形态筛选里的「未分类」 | **不作为筛选项**，只在对象详情 / 列表里作为兜底值展示 | 它是迁移与兜底的落点，不是浏览维度；做成可选项等于引导用户主动把内容丢进去 |

---

## 决策索引（快速查看）

| 编号 | 标题 | 状态 | 核心结论 |
|------|------|------|----------|
| ADR-001 | LightRAG 与 RAGFlow 向量策略 | 已采纳 | 共用 Embedding，不共用向量库 |
| ADR-002 | 第一期功能范围 | 已采纳 | 只做资产 + 四阶段工作流 |
| ADR-003 | 认证方案 | 已采纳 | Logto 自托管，仅登录注册 |
| ADR-004 | 文档维护方式 | 已采纳 | 固定结构 + AI 动态更新 |
| ADR-005 | 统一内容存储策略 | 已采纳 | RAGFlow 为内容唯一底座 |
| ADR-006 | 代码库形态 | 已采纳 | greenfield，业务代码从零新建 |
| ADR-007 | 内容映射契约与 Dataset 粒度 | 已采纳 | 单一 Dataset；`content_refs` 表；`content_key` 作幂等键；outbox + 对账 |
| ADR-008 | 内库 / 外库定义与字段拆分 | 已采纳 | 按「敢不敢直接用」判定；`library` / `source` / `origin` 三正交字段；资产无 `status` |
| ADR-009 | 业务元数据存储与分层 | 已采纳 | SQLite + better-sqlite3 + Drizzle；分层到唯一 RAGFlow 适配器 |
| ADR-010 | LightRAG 部署与模型接入 | 已采纳 | 本机 Python 进程；Ollama deepseek-r1:7b；共用 bge-large-zh-v1.5 经本地 OpenAI 兼容 embedding 服务；文件存储 |
| ADR-011 | 图谱按账号归属过滤 | 已采纳 | 单工作区 + 读侧按 `file_path` 过滤；抽取仍全局合并，强隔离需每账号独立实例 |
| ADR-012 | 管理员角色与后台入口 | 已采纳 | 同一条 Logto 登录；`ADMIN_SUBS` 白名单派生 `isAdmin`；`/admin` 仅管理员可见 |
| ADR-013 | 统一三栏应用框架 | 已采纳 | 76px 导航栏 + 模块目录 + 列表 / 详情；`:has()` 决定列数；URL 单一筛选状态 |
| ADR-014 | 正文类型与 Markdown 编辑 | 已采纳 | 纯文本 / Markdown 分段切换；零依赖解析器渲染预览；正文仍以源码存 RAGFlow |
| ADR-015 | 批量归档 / 导出 / 删除 | 已采纳 | 列表复选框 + 批量条；复用单条接口逐项执行；导出拼一份 Markdown |
| ADR-016 | 作品形态与标签的词表化数据模型 | 已采纳 | 形态建表 + `objects.format` 外键（code 作主键，现有值天然合法）；标签 `tags` + `object_tags` 多对多；对外仍返回字符串，仓储水合；`/api/vocabulary` 作唯一读取入口 |
| ADR-017 | 多主题系统 | 已采纳 | CSS 变量 + `[data-theme]`；主题只覆盖语义 token 层；内联脚本防闪；107 处品牌色阶 + 79 处硬编码分 3 批迁移 |
| ADR-018 | 银河首页与导航调整 | 已采纳 | `/` 升级为银河首页，`/workspace` 不动；Canvas 2D 星图零依赖 + 四级降级；logo 改回首页；抽屉复用 `nav-items` 单一来源 |
| ADR-019 | 管理后台用户 / 角色 / 权限模型 | 已采纳·已实施（`GET /api/admin/audit/export` 未实现） | 废止 ADR-003 的 RBAC 限制、取代 ADR-012 的角色来源（多租户与对象级 ACL 仍不做；读侧按 `owner_sub` 过滤见 ADR-011）；Logto 只做身份，本地五表做授权；13 项权限 × 4 角色；`requirePermission` 为唯一强制层 + 全路由覆盖测试；审计同事务落库 |
| ADR-020 | 深空视觉主题与 Three.js 星系首页 | 已实施 | 首页背景改 three.js 3D 星系（90s 自转 + 呼吸 + 视差）、三段降级（WebGL → 自渲染静态图 → CSS 星点）；全局 `:root` 重写为深空 + 暖金，`--green-*` 降为金阶别名；子页面只留静态星点。取代 ADR-018 第 6~8 条。**第 8 条（全局单主题）由 ADR-021 修订** |
| ADR-021 | 多主题恢复与默认主题决策 | 已采纳·token 层已实施 | 恢复 `pine / galaxy / sand / midnight` 四套，默认 `galaxy`（保持上线观感）；**token 契约 = 三层 129 名（98 主题 × 四块集合相等 + 31 几何只在 `:root`）**，`--bg` / `--accent*` 属 L2 语义层权威名，`--green-*` / `--gold-*` 为冻结别名；`pine` 逐字等于 Phase 5 之前的 `:root`（36 回填 + 62 补值）；`check-theme.mjs` 断言集合、层位、别名、重复表达与字面量基线；首页固定 cosmic 不随主题变；入口在账号菜单与首页头像菜单，`localStorage["pakp.theme"]` + 首帧脚本防闪 |
| ADR-022 | 知识图谱 3D 渲染与 2D 降级 | 已采纳·已实施（生产运行时已复验；真机 GPU 帧时序、2000 节点、真实 Logto / LightRAG 未测） | `/graph` 主视图改 three.js + @react-three/fiber 的 3D 银河、选中后可切 2D 聚焦；两套渲染器共用一个 `GraphViewModel`；不引 drei / postprocessing；`frameloop="demand"` 空闲零帧；150 节点 60fps、2000 节点抽稀可用；舞台固定深空不随主题；补 `maxNodes` 透传与 `failed` 渲染 |
| ADR-023 | 分类词表统一与迁移 | 已采纳·已实施 | 废止「作品形态 / 自由文本分类」双轨：`work_formats` 升级为 `categories`、`objects.format` → `category_code`、自由值折叠进同一词表（多余值转标签）；分类单选、标签多选；全站文案 / 路由 / 权限 / API 统一为「分类」，含迁移 SQL、命名矩阵与回滚留档 |
| ADR-024 | 检索的模糊查询与语义混合 | 已采纳·已实施 | SQLite `instr` 元数据子串匹配（标题 / 描述 / 分类 / 标签）+ RAGFlow 语义并行混合；对象级六级权重排序、3s 超时降级；`/api/search` 增量扩展 `mode` 与 `lexical`；首页 200ms 防抖预览 8 条 |
| ADR-025 | 大模型供应商配置与凭据存储 | 已采纳·已实施（2026-11-13） | 配置落 `settings` 单行加密 JSON（AES-256-GCM，密钥来自专用变量 `SETTINGS_ENC_KEY`，非 `AUTH_SECRET`，也不复用 Logto 密钥）；接口只回掩码与 `hasKey`；`settings:read/write`（权限 13 → 15，仅 owner/admin）；`test` 最小请求、`apply` 逐键改 `infra/lightrag/.env` + 只重启 `lightrag-server` + 60s 健康检查 + 失败回滚；迁移编号 `0009`；修订 ADR-010 的 LLM 固定条款 |
| ADR-026 | 知识内容预览（弹窗） | 已采纳·已实施（2026-11-13，工作台与详情两入口） | 统一 `ContentPreviewDialog`（原生 `<dialog>`），工作台 / 检索 / 图谱 / 首页四入口；打开状态 `?preview=<id>` 进 URL；复用现有三接口，仅新增 `?inline=1` 切换 `Content-Disposition`；Markdown 走 ADR-014 的零依赖解析器，PDF 同源 iframe（>20MB 降级下载），文本 512KB 上限；仅需 `object:read` |
| ADR-027 | /graph 全屏星图画布 + 液态玻璃浮层 | 已采纳·已实施（2026-11-13） | 内容区取消 1180 上限，画布铺满作背景层；**控制卡贴左上（`min(880px, 100% − rail − 48px)`）+ 详情卡贴右上（356/60%）顶边同线、间距 ≥16px**；玻璃 = 72% 底 + `blur(14px) saturate(130%)` + 22% 边框 + 1px 内高光 + **指针径向高光 + 160° 斜向反光 + ≤3° 倾斜**（9 令牌，新增 6 个写在 `[data-surface="graph"]` 块内，字面量基线仍 26）；玻璃内禁用主题 `--text-*`；不支持模糊 / `low` / reduced-transparency 退 92% 实色；移动端单行控制条 + 底部抽屉，画布层 `inset: 0` 只缩进 2D 舞台盒子；`check:theme` 基线 26 与 ADR-022 的档位、DPR、draw call 预算均不变 |

---

## 变更规则

1. 已采纳决策不删除，只追加新 ADR 或更新状态。
2. 若要推翻已有决策，必须新增 ADR，说明原因，并同步修改 00_SCOPE 与 01_ARCHITECTURE。
3. 每次新增或变更 ADR 后，在 05_CHANGELOG.md 留下记录。