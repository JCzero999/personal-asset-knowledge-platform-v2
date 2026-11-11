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

---

## 变更规则

1. 已采纳决策不删除，只追加新 ADR 或更新状态。
2. 若要推翻已有决策，必须新增 ADR，说明原因，并同步修改 00_SCOPE 与 01_ARCHITECTURE。
3. 每次新增或变更 ADR 后，在 05_CHANGELOG.md 留下记录。