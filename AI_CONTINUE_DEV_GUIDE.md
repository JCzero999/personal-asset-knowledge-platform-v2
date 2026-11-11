# AI 继续开发指导文档（Handoff）

> 本文件供任意编码 Agent / DSH 环境直接阅读并执行。  
> **生成日期**：2026-11-01  
> **当前阻塞**：本机 Docker / WSL 未就绪（用户有任务在跑，暂不重启）  
> **原则**：无 Docker 时只做不依赖容器的工作；有 Docker 后再做 Phase 0 收尾与 Phase 1。

---

## 0. 你是谁、要做什么

你是本项目的执行型开发 Agent。必须：

1. **严格遵守** `docs/00_SCOPE.md` 与 `docs/03_DECISIONS.md`（尤其 ADR-005）
2. **每次有意义工作后**按 `docs/prompts/maintain-docs.md` 更新 `02_PHASES.md` 与 `05_CHANGELOG.md`
3. **禁止编造**未实现的 API / 端口 / 接口细节（写入 `04_INTEGRATION.md` 前必须真实可验证）
4. **禁止**在未获用户确认时执行破坏性操作（删库、强制推送、覆盖已采纳 ADR）

先读完本文件，再读 `docs/00_SCOPE.md` → `03_DECISIONS.md` → `02_PHASES.md` → `01_ARCHITECTURE.md`。

---

## 1. 项目一句话

以 **RAGFlow** 为统一内容存储与检索底座，在其上实现 **资产 + 四阶段工作流**，用 **LightRAG** 做知识图谱，用 **Logto（Docker 自托管）** 做登录注册的个人知识工作台。

---

## 2. 已锁定决策（不可擅自推翻）

| 编号 | 结论 |
|------|------|
| **ADR-001** | LightRAG 与 RAGFlow：**共用 Embedding，不共用向量库** |
| **ADR-002** | 第一期只做：**资产 + 四阶段工作流**；砍掉旧图谱、加密分享、试运行评估、多用户隔离 |
| **ADR-003** | Logto Docker 自托管；第一期仅登录/注册，不做 RBAC |
| **ADR-004** | 固定 docs 结构 + AI 按 maintain-docs 更新 |
| **ADR-005（核心）** | **RAGFlow = 内容唯一真相源**；资产/工作流是业务层（元数据 + 状态 + content_ref），不再以本地 Markdown 为内容真相 |
| **ADR-006** | 仓库为 **greenfield**：仅有 docs + agents；Next.js 业务代码需从零新建，禁止假设存在旧 `src/` |

若需变更：必须**新增 ADR**，并同步改 `00_SCOPE` / `01_ARCHITECTURE`，在 `05_CHANGELOG` 留痕。

---

## 3. 当前真实进度（以仓库为准）

### 3.1 已完成

- [x] 产品边界、ADR-001~005、架构与阶段文档
- [x] `docs/prompts/maintain-docs.md`
- [x] CrewAI 多 Agent：Project Manager + Docs Keeper + Infra Agent（hierarchical）
- [x] docs 安全读写工具 + `agents/backups/` 自动备份（`append_changelog` / `update_phases` 已验证）
- [x] 从零创建 Next.js App Router + TypeScript 骨架、Mock UI、`.env.example` 业务占位与 `/api/health`
- [x] Asset / Work 元数据、`content_ref` 映射、四阶段状态机与 Logto 清单 DRAFT；未连接真实服务
- [x] lint、TypeScript、单元测试、生产构建与首页 / health HTTP 200 验证
- [x] 本机检查：Docker 当时不可用；端口 3000 / 3001 / 9380 空闲（以当时验证为准，重新环境后需再查）

### 3.2 未完成 / 阻塞

- [ ] WSL + Docker Desktop 可用（用户侧：装 WSL 需重启，当前 DSH 任务未结束故延后）
- [ ] Logto Docker 启动并验证
- [ ] RAGFlow Docker 启动并验证
- [ ] `04_INTEGRATION.md` 填入**真实**端口、URL、环境变量（禁止虚构）
- [ ] Phase 1：Next.js 对接 Logto（登录/注册/会话）
- [ ] Phase 2~5：见 `02_PHASES.md`

### 3.3 仓库起点与当前内容（重要 · ADR-006）

**用户已确认：ADR-006 记录本轮开发前的仓库起点，当时仓库即项目全部内容。**

| 初始有 | 初始无 |
|--------|--------|
| `docs/`、`agents/`、接手指南、agents 的 `requirements.txt` | Next.js 业务应用、`src/`、业务 `package.json`、旧 vault 实现代码 |

**当前新增**：已按 ADR-006 从零创建 Next.js App Router + TypeScript 骨架，现有 `src/`、业务 `package.json`、Mock UI、`/api/health` 与元数据 / 集成 DRAFT；它们不是恢复的旧代码。

因此：

- 本项目起点是 **文档驱动的从零新建（greenfield）**，不是在旧前端上重构。
- **禁止**查找或等待不存在的旧业务模块，也禁止把新骨架误当旧系统重复初始化。
- Phase 1 的初始化部分已完成，剩余为：**接入真实 Logto** 并替换 Mock 身份。
- Phase 4 是 **新写** 资产与四阶段工作流，规则以 docs/ADR 为准。
- 旧系统：**无业务数据，无需迁移**。

---

## 4. 阶段目标速查

| 阶段 | 目标 | 完成标准 |
|------|------|----------|
| **Phase 0** | 文档 + 环境 | docs 对齐 ADR-005；Logto、RAGFlow 能 Docker 启动并访问 |
| **Phase 1** | **新建** Next.js + Logto | 应用从零创建；登录/注册可用；能拿到用户身份 |
| **Phase 2** | RAGFlow 底座 | Dataset/Document、解析与检索；业务侧有 content_ref |
| **Phase 3** | LightRAG | 构图与查询；共用 Embedding、独立存储 |
| **Phase 4** | 资产 + 工作流 | CRUD + 四阶段；内容经映射进 RAGFlow |
| **Phase 5** | 联调 | 登录 → 资产/工作流 → 检索 → 图谱 主路径通 |

---

## 5. 无 Docker 时你可以做的事（给 DSH 优先任务）

在用户完成 WSL 重启 / Docker 可用之前，**只做下列工作**，不要空等：

### P0 — 文档与仓库卫生（立刻可做）

1. 通读并核对 `docs/00`~`05` 与 `maintain-docs.md` 一致性（有笔误/格式断裂可修，**不改 ADR 结论**）。
2. 整理 `04_INTEGRATION.md` 为「待填模板」：保留章节，明确哪些字段等 Docker 后实测再写。
3. 在 `02_PHASES.md`「下一步行动」中区分：  
   - **不依赖 Docker** 的任务  
   - **依赖 Docker** 的任务  
4. 每次改动后：`append` `05_CHANGELOG.md`，必要时更新 `02_PHASES` 当前状态。

### P1 — Next.js 骨架（默认必做方向，仓库确认无前端）

在**不依赖 Logto 真服务**的前提下可做（ADR-006）：

1. **从零**初始化 Next.js（App Router）+ TypeScript + 基础目录（create-next-app 或等价）。
2. 环境变量模板：`.env.example`（Logto / RAGFlow / Embedding 占位，无真实密钥提交）。
3. 健康检查路由：`/api/health`。
4. 占位页：未登录态 / 已登录态 UI 壳子（Mock 用户即可）。
5. 业务元数据层设计草案（SQLite 或 JSON）：Asset / Work 字段 + `content_ref` 占位，**不接 RAGFlow 真 API**。

### P2 — 设计文档（仍不调用外部服务）

1. **Asset/Work ↔ RAGFlow Document 映射草案**（字段表），写入 `docs/` 下独立草案文件或 `04_INTEGRATION.md` 的「草案」小节，标题标明 **DRAFT**。
2. **四阶段状态机**文字说明（合法迁移边、谁可触发）。
3. Logto 集成步骤清单（OIDC 回调路径、所需 env 名），等 Docker 后逐项勾选。

### 明确不要做（无 Docker 时）

- 不要假装 Logto/RAGFlow 已启动并编造可用 URL。
- 不要执行 `docker run` / `compose up`（环境未就绪会失败且污染文档）。
- 不要实现「写死假 content_ref 当生产逻辑」。
- 不要恢复已砍功能（加密分享、试运行评估、旧图谱、多用户隔离）。

---

## 6. Docker 就绪后的执行顺序（用户重启并确认后）

严格按序：

1. 验证：`docker version`、`docker compose version`、`wsl --status`。
2. Infra：给出并落地 **Logto** compose（端口建议避开冲突；实测后写入 `04_INTEGRATION.md`）。
3. 验证 Logto 控制台 / 登录页可打开。
4. Infra：落地 **RAGFlow** compose；验证 Web/API 可访问。
5. 把真实 baseURL、端口、版本、必要 env **只写真实值** 进 `04_INTEGRATION.md`。
6. 更新 `02_PHASES.md`：勾选 Logto/RAGFlow Docker 项；Phase 0 关闭条件满足后进入 Phase 1。
7. Phase 1：Next.js 正式接 Logto SDK/OIDC。
8. Phase 2：RAGFlow API 封装 + content_ref 映射实现。
9. Phase 3 / 4 / 5 按 PHASES。

端口规划（历史建议，**以实测为准**）：

| 服务 | 历史建议端口 | 说明 |
|------|----------------|------|
| Next.js | 3000 | 主应用 |
| Logto | 3001 | 认证 |
| RAGFlow | 9380 或官方默认 | 以官方 compose 为准 |

---

## 7. 架构硬约束（写代码时对照）

```
浏览器 → Next.js (UI + API Routes)
           ├─ 认证 ──────────→ Logto
           ├─ 元数据/状态 ───→ 轻量存储（SQLite/JSON/DB）
           ├─ 内容主体 ──────→ RAGFlow（唯一内容真相）
           └─ 知识图谱 ──────→ LightRAG（独立向量/图；Embedding 可与 RAGFlow 同模型）
```

- 四阶段流转：**只改业务状态**，不在 RAGFlow 里靠「搬文件」表达状态。
- 密钥只在 `.env` / 密钥管理，**不进** RAGFlow 文档内容、不进 Git。
- 第一期按**单用户**处理数据。

---

## 8. CrewAI agents/ 使用说明（可选）

路径：`agents/`（需 Python 3.11/3.12 虚拟环境，勿用 3.14）。

```text
.venv 激活后：
python agents/main.py
```

- **Project Manager**：读 docs、拆任务、hierarchical 指派（manager 不挂写工具）。
- **Docs Keeper**：有限写 `02_PHASES` / `05_CHANGELOG`，写前备份到 `agents/backups/`。
- **Infra Agent**：只读检查 docker/端口/容器，**不执行**部署命令。

在 DSH 若不能跑 CrewAI：人工按本指导文档的任务列表执行即可，不必强依赖 agents。

---

## 9. 文档更新检查清单（每次交付前）

- [ ] 是否改了已采纳 ADR 正文？→ 禁止，除非用户要求并新增 ADR  
- [ ] 是否更新了 `02_PHASES.md` 当前状态/已完成/下一步？  
- [ ] 是否在 `05_CHANGELOG.md` 追加一行？  
- [ ] `04_INTEGRATION.md` 是否只含已验证信息？  
- [ ] 是否引入了第一期明确砍掉的功能？→ 禁止  

---

## 10. 建议你（AI）在本轮 DSH 的默认工作包

本轮工作包已完成。后续 Agent 按以下状态接续：

1. **确认工作区**：ADR-006 是 greenfield 起点记录；当前 Next.js 骨架已存在，不要找旧代码，也不要重复初始化。
2. **文档卫生**：继续与 SCOPE/PHASES/ADR 保持一致；`04_INTEGRATION.md` 保持待实测模板，不编造端口。
3. **无 Docker 时**：只维护当前骨架和第 5 节允许的 DRAFT，不接真服务、不扩展资产 CRUD。
4. **Docker 就绪后**：严格转到第 6 节顺序，先验证环境，再从 Logto compose 开始。
5. **输出**：简短《本轮完成》+《待用户 Docker 就绪后的第一步命令清单》。

---

## 11. 给用户的同步点（你完成后告诉用户）

- 本轮改了哪些文件  
- 哪些在等 Docker  
- 用户重启并 `docker version` 成功后，应发你的下一句指令建议（例如：「Docker 已就绪，从 Logto compose 开始」）

---

## 12. 参考文件索引

| 文件 | 用途 |
|------|------|
| `docs/00_SCOPE.md` | 产品边界与成功标准 |
| `docs/01_ARCHITECTURE.md` | 目标架构 |
| `docs/02_PHASES.md` | 进度看板 |
| `docs/03_DECISIONS.md` | ADR |
| `docs/04_INTEGRATION.md` | 真实集成信息（禁止虚构） |
| `docs/05_CHANGELOG.md` | 变更日志 |
| `docs/prompts/maintain-docs.md` | AI 文档维护规则 |
| `agents/README.md` | CrewAI 用法与工具限制 |
| **本文件** `AI_CONTINUE_DEV_GUIDE.md` | 跨环境接手总指南 |

---

**结束语给执行 Agent**：  
方向已锁死在 RAGFlow 内容底座 + 资产/工作流业务层 + Logto + LightRAG。  
现在最大外部依赖是用户本机 Docker。在此之前把文档、骨架与映射设计做扎实；Docker 一就绪就按第 6 节顺序推进，不要跳相。
