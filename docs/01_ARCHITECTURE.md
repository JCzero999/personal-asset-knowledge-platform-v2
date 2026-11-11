# 目标架构

> 与 00_SCOPE.md、03_DECISIONS.md（尤其 ADR-005）保持一致。  
> 核心原则：内容统一由 RAGFlow 存储与检索；资产与四阶段工作流是建立在其上的业务层。

## 1. 项目一句话
以 RAGFlow 为统一内容存储与检索底座，在其上实现资产管理和四阶段工作流，结合 LightRAG 提供知识图谱能力，通过 Logto 提供登录注册的个人知识工作台。

> **实现状态（ADR-006）**：业务侧 Next.js 已从零创建本地骨架（App Router + TypeScript）；真实认证、内容服务与业务持久化尚未接入。当前 `src/` 是本轮新建实现，不是旧系统代码。

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

## 5. 主要数据流

1. **用户登录** → Logto 完成认证，前端获得身份。
2. **创建/更新资产或作品**  
   - 业务侧写入元数据 + 状态  
   - 内容提交至 RAGFlow（创建或更新 Document）  
   - 保存两者之间的映射关系
3. **检索 / 问答** → 直接请求 RAGFlow。
4. **知识图谱构建 / 查询** → LightRAG 基于内容（可从 RAGFlow 获取或同步）进行。
5. **四阶段流转** → 仅更新业务侧状态；内容仍留在 RAGFlow，不随状态物理移动文件。

## 6. 与旧系统的关键差异

| 旧系统 | 新系统 |
|--------|--------|
| 本地 Markdown 文件 = 内容唯一真相 | RAGFlow = 内容唯一真相 |
| 资产/作品直接读写文件系统 | 资产/作品通过映射关联 RAGFlow 文档 |
| 知识库是附加功能 | 知识库（RAGFlow）是内容底座 |
| 状态变化可能伴随文件移动 | 状态变化只改业务元数据，内容位置稳定 |

## 7. 第一期明确不做的部分
- 多用户数据隔离
- 旧知识图谱实现
- 加密分享
- 平台试运行评估
- 以本地文件系统作为内容主存储

## 8. 待 Phase 中细化的内容（写入 04_INTEGRATION.md）
- RAGFlow Dataset / Document 与业务 Asset/Work 的具体映射字段
- 内容变更后如何触发 LightRAG 更新
- 业务元数据存储的最终选型（SQLite / 其他）
- Logto 与 Next.js 的具体集成方式（SDK、回调、会话）
- 各服务的端口、环境变量、网络连通方式

## 9. 架构原则（必须遵守）
1. **内容只认 RAGFlow**（ADR-005）
2. **业务状态与内容分离**
3. **LightRAG 与 RAGFlow 解耦存储，仅共用 Embedding**（ADR-001）
4. **方向由 00_SCOPE + 03_DECISIONS 锚定**，变更需新增 ADR