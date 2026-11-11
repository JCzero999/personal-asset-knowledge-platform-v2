# 分阶段计划与当前进度

> 每次完成重要工作后，由 AI 根据 `docs/prompts/maintain-docs.md` 更新本文件。  
> 方向锚点：00_SCOPE.md + 03_DECISIONS.md（含 ADR-005、ADR-006）。

## 当前状态

- **所处阶段**：Phase 0（环境待就绪）；Phase 1 的无 Docker 骨架已提前完成
- **状态表述**：文档与多 Agent 已就绪；已按 **greenfield / ADR-006** 从零创建 Next.js + TypeScript 骨架、Mock UI、health 与元数据 DRAFT；真实 Logto / RAGFlow 仍未连接
- **最新关键决策**：ADR-005（RAGFlow 内容底座）+ ADR-006（从零新建业务代码）
- **阻塞项**：Docker 环境未就绪（WSL/Docker Desktop；用户侧暂缓重启）

## 阶段总览

| 阶段 | 目标 | 状态 | 完成标准 |
|------|------|------|----------|
| **Phase 0** | 文档体系 + 基础环境就绪 | 进行中（仅环境阻塞） | docs 与 ADR 对齐；Logto、RAGFlow 能 Docker 启动并访问 |
| **Phase 1** | Next.js 骨架 + Logto 认证 | 进行中（骨架已完成） | **新建** Next.js 应用；登录/注册可用；能获取用户身份 |
| **Phase 2** | RAGFlow 内容底座 | 未开始（映射 DRAFT 已写） | Dataset/Document、解析与检索；业务侧有 content_ref |
| **Phase 3** | LightRAG 知识图谱 | 未开始 | 构图与查询；共用 Embedding、独立存储 |
| **Phase 4** | 核心业务（资产 + 工作流） | 未开始（状态机 DRAFT 已写） | **新写**资产 CRUD + 四阶段流转；内容映射进 RAGFlow |
| **Phase 5** | 联调与打磨 | 未开始 | 登录 → 资产/工作流 → 检索 → 图谱 主路径通 |

## 已完成

- [x] 明确产品边界与技术选型（Logto 自托管、RAGFlow 本地 Docker、LightRAG、单用户）
- [x] 确定第一期只保留：资产 + 四阶段工作流
- [x] 采纳 ADR-001 ~ ADR-005
- [x] 采纳 **ADR-006**（仓库起点为 greenfield，无既有 Next.js 业务代码，应用从零新建）
- [x] 建立完整 docs 目录与初始文件（含本文件）
- [x] 编写 `docs/prompts/maintain-docs.md`
- [x] CrewAI 多 Agent 体系已跑通（Project Manager + Docs Keeper + Infra Agent）
- [x] docs 安全读写工具与自动备份机制已验证
- [x] 确认 greenfield 起点并新建业务应用；当前 `src/` 为本轮新代码
- [x] 从零初始化 Next.js 16 App Router + TypeScript + ESLint + Vitest
- [x] 增加 `.env.example` 的 Logto / RAGFlow / Embedding 空占位，无真实密钥
- [x] 实现 `/api/health` 与无外部依赖的单元测试
- [x] 创建未登录 / 已登录 UI 壳，已登录身份明确标注为 Mock 用户
- [x] 新写 Asset / Work / `content_ref` 元数据类型与映射 DRAFT，不接 RAGFlow API、不写假 ID
- [x] 编写四阶段合法迁移边 / 触发者与 Logto 待验证清单 DRAFT
- [x] 整理 `04_INTEGRATION.md` 待实测模板，修复 `01_ARCHITECTURE.md` 格式断裂
- [x] lint、TypeScript、单元测试、生产构建通过；首页与 health 实测 HTTP 200
- [ ] Logto Docker 可启动并验证
- [ ] RAGFlow Docker 可启动并验证
- [ ] 将 Mock 身份替换为真实 Logto 登录 / 注册 / 会话

## 下一步行动

### A. 不依赖 Docker（可在 DSH 先做）

1. 保留当前新骨架，不重复初始化；如需继续，只做接手指南第 5 节允许的文档 / DRAFT 工作
2. 保持 Mock 身份与真实认证边界清晰，不将 DRAFT 当作已实施的外部接口
3. 保持 `04_INTEGRATION.md` 中未实测项为「待实测」，禁止编造 URL / 端口或假 `content_ref`

### B. 依赖 Docker（用户本机 WSL 重启并 Docker 可用后）

1. 先验证 `docker version`、`docker compose version`、`wsl --status`
2. 启动 Logto Docker，验证控制台 / 登录页可访问
3. 启动 RAGFlow Docker，验证管理界面 / API 可访问
4. 将**实测**端口、地址、版本、环境变量写入 `04_INTEGRATION.md`
5. 更新本文件已完成项，关闭 Phase 0 环境部分，再在 Phase 1 接真 Logto 并替换 Mock 身份

## 各阶段关键约束（提醒）

- **Phase 0~1**：先环境与身份；业务内容存储仍以 RAGFlow 为准（接真在 Phase 2）
- **Phase 1**：包含 **新建 Next.js**，不是改造旧前端（ADR-006）
- **Phase 2**：RAGFlow 为内容唯一真相源；业务必须通过 content_ref 关联
- **Phase 3**：LightRAG 与 RAGFlow 仅共用 Embedding，不共用向量库（ADR-001）
- **Phase 4**：**新写**资产与工作流，只维护元数据 + 状态 + content_ref
- **全程**：方向变更必须新增 ADR，并同步 00_SCOPE / 01_ARCHITECTURE

## 风险与注意点（当前）

| 风险 | 应对 |
|------|------|
| 执行 Agent 寻找旧代码或重复初始化 | 以 ADR-006 的 greenfield 起点为准，维护当前新骨架 |
| RAGFlow 资源占用较高 | 本机建议 ≥16GB 内存；先验证能启动再优化 |
| 映射设计不当 | Phase 2 结束前明确字段并写入 04_INTEGRATION.md |
| 文档与实现脱节 | 遵守 maintain-docs；每次有意义工作后更新本文件与 CHANGELOG |
| 无 Docker 时编造集成细节 | 禁止；04_INTEGRATION 只写已验证信息 |
