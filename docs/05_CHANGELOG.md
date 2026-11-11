# 变更日志

## 2026-10-26
- 确立项目方向：RAGFlow + LightRAG + Logto，保留资产与四阶段工作流
- 创建文档体系（00~05）
- 采纳 ADR-001 ~ ADR-004

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
