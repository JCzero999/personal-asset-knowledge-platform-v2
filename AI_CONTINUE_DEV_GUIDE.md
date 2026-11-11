# AI 继续开发指导文档（Handoff）

> 本文件供任意编码 Agent / DSH 环境直接阅读并执行。  
> **生成日期**：2026-11-01 ｜ **最近同步**：2026-11-11  
> **当前状态**（2026-11-11 复核，提交 `e95d154`）：Docker / WSL 就绪；**Logto 容器已启动并通过连通性实测**（1.46.0，服务 3001 / 控制台 3002），**但管理员账号尚未创建，应用与回调未配置**；**RAGFlow 尚未部署**；业务数据层（SQLite + Drizzle）已落地，API 路由与页面未接  
> **原则**：Docker 阻塞已解除，后续工作按 **第 6 节** 的顺序执行：先建 Logto 管理员账号并完成控制台配置 → 再部署 RAGFlow。

---

## 0. 你是谁、要做什么

你是本项目的执行型开发 Agent。必须：

1. **严格遵守** `docs/00_SCOPE.md` 与 `docs/03_DECISIONS.md`（尤其 ADR-005）
2. **每次有意义工作后**按 `docs/prompts/maintain-docs.md` 更新 `02_PHASES.md` 与 `05_CHANGELOG.md`
3. **禁止编造**未实现的 API / 端口 / 接口细节（写入 `04_INTEGRATION.md` 前必须真实可验证）
4. **禁止**在未获用户确认时执行破坏性操作（删库、强制推送、覆盖已采纳 ADR）

**当前阻塞**：无硬阻塞。Logto 容器已在跑，剩下的是**只有人能做的一步**——在浏览器打开 `http://localhost:3002/console/welcome` 创建管理员账号，然后在控制台建应用、拿应用 ID / Secret 与回调地址。RAGFlow 仍未部署。两者完成前，Phase 1 的「接真 Logto」无法收尾。

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
- [x] 本机检查：Docker 当时不可用；端口 3000 / 3001 / 9380 空闲（当时状态，已于 2026-11-11 复查，见 3.2）
- [x] 仓库纳入 Git 版本控制，基线提交 `ebe32e6`（此前无版本控制）
- [x] **业务数据层落地**（提交 `e95d154`，ADR-007~009）：`domain` / `server.ports` / `server.db` / `server.repositories` / `server.http` 分层；SQLite + better-sqlite3 + Drizzle；`objects` / `content_refs` / `library_events` / `sync_jobs` 四张表；两条 CHECK 约束钉死「资产无 status」「外库作品不得 practiced」；6 个测试文件 40 项用例通过（2026-11-11 实测）
- [x] **Logto Docker 自托管启动并完成连通性实测**（1.46.0；服务 3001、控制台 3002；`/api/status` 204、OIDC discovery 正常），实测值已写入 `04_INTEGRATION.md`
- [x] 修复 `drizzle` 迁移与 `04_INTEGRATION.md` 的 Logto 记录：迁移可重复执行，文档只写真值

### 3.2 未完成清单与阻塞状态（截至 2026-11-11，提交 `e95d154`）

**环境阻塞已解除**，前四项为复查通过的记录，其余未勾选项才是待办：

- [x] WSL + Docker 已就绪：Docker 29.9.2、Docker Compose v5.6.1、WSL 内有 Ubuntu 发行版（2026-11-11 实测）
- [x] 端口复查：3000 / 3001 / 9380 在部署前均空闲；资源满足 RAGFlow 要求（31.5 GB 内存，D 盘可用 494 GB）
- [x] Logto 容器启动并实测连通（`logto` / `logto-postgres` 均 `Up (healthy)`，端口 3001 / 3002 已被占用）
- [x] `04_INTEGRATION.md` 的 Logto 段已填入实测值（版本、端口、Base URL、控制台地址、健康检查接口）
- [ ] **Logto 管理员账号创建与控制台应用配置**——需人工在浏览器打开 `http://localhost:3002/console/welcome` 完成；当前无应用 ID / Secret / 回调地址
- [ ] **RAGFlow Docker 启动并验证**——**尚未部署**：仓库中无编排文件，复核时无 RAGFlow 容器运行
- [ ] `04_INTEGRATION.md` 的 RAGFlow / LightRAG / Embedding 段仍为 `待实测`（禁止虚构）
- [ ] **Phase 1 剩余：API 路由与页面**——截至提交 `e95d154`，`src/app/api` 只有 `/api/health`；需要补对象 CRUD 与库别迁移的路由、对应页面，并用真实 Logto 身份替换 Mock 身份。注：本文档同步时工作区已出现并行的 Phase 1 路由 / 页面改动（未提交），接手时以主程提交后的实际代码为准重新核对本节。
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
- Phase 1 的初始化部分已完成，剩余为：**补齐 `/api` 业务路由与页面**，并**接入真实 Logto** 替换 Mock 身份。
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

## 5. 当前起点（2026-11-11，提交 `e95d154`）

本轮之后，仓库处于「**服务半就绪 + 数据层就绪 + 接口未接**」的状态。接手时不要重做已完成的部分。

### 5.1 已完成（不要重复做）

| 项 | 状态 | 位置 / 证据 |
|----|------|-------------|
| 业务数据层 | 已落地 | `src/domain/`、`src/server/{ports,db,repositories,http}/`；迁移 `drizzle/0000_military_wasp.sql`；见 `01_ARCHITECTURE.md` 第 5 节 |
| 四张表与两条 CHECK | 已落地并测试 | `objects` / `content_refs` / `library_events` / `sync_jobs`；资产无 `status`、外库作品不得 `practiced` |
| Logto 自托管部署 | 容器已跑、连通性已实测 | `infra/logto/docker-compose.yml`；`logto` / `logto-postgres` 均 `Up (healthy)`；服务 3001、控制台 3002 |
| `04_INTEGRATION.md` 的 Logto 段 | 已填实测值 | 版本、端口、Base URL、控制台地址、健康检查接口 |
| Next.js 骨架、`/api/health`、Mock 登录态 UI | 已完成 | 见 3.1 |
| 测试 | 6 文件 40 项通过 | `npm test`（2026-11-11 实测） |

### 5.2 未完成（下一步就是这些）

1. **Logto 管理员账号（需人工）**：打开 `http://localhost:3002/console/welcome` → Create account。之后在控制台创建应用、拿应用 ID / Secret 与回调地址。这一步没有替代方案，必须由人在浏览器完成。
2. **RAGFlow 部署**：尚未落地编排文件，也没有容器在运行。端口、地址、接口契约一律保持 `待实测`，不得先写进 `04_INTEGRATION.md`。
3. **Phase 1 剩余：API 路由与页面**：截至 `e95d154`，`src/app/api` 只有 `/api/health`，`server.services` 与 `server.adapters.ragflow` 是占位 README。需要补 `objects` 的 CRUD、库别迁移路由与对应页面，并把 Mock 身份换成真实 Logto 会话。本文档同步时工作区已有并行的 Phase 1 改动（未提交），以提交后的代码为准再核对。
4. **Phase 2~5**：见 `02_PHASES.md`。

### 5.3 仍然有效的约束（与 Docker 是否就绪无关）

1. **不要**把 Logto 写成「已接通应用侧」：容器与连通性实测通过 ≠ 应用能登录。管理员账号、应用 ID、回调地址都没配，Phase 1 的登录链路尚未打通。
2. **不要**把 RAGFlow 写成已部署、已连接；也不要在没有实测值的情况下填 `04_INTEGRATION.md`。
3. **不要**编造端口、URL、`content_ref`；只写实测值。
4. **不要**实现「写死假 content_ref 当生产逻辑」。
5. **不要**恢复已砍功能（加密分享、试运行评估、旧图谱、多用户隔离）。
6. **不要**重复初始化 Next.js 骨架或数据层，也不要寻找不存在的旧业务代码（ADR-006）。

---

## 6. 执行顺序（从当前起点继续，不要从第 1 步重来）

1. 环境核验 ✅ 已实测（2026-11-11）：Docker 29.9.2、`docker compose` v5.6.1、WSL 内有 Ubuntu 发行版。
2. Infra：落地 **Logto** compose ✅ 已完成（`infra/logto/docker-compose.yml`；服务 3001、控制台 3002；实测值已写入 `04_INTEGRATION.md`）。
3. 验证 Logto 控制台可打开 ✅ 已实测（`/api/status` → 204，控制台 302 → `/console/welcome`）；**但管理员账号尚未创建**。
4. **【下一步 · 需人工】创建 Logto 管理员账号**：浏览器打开 `http://localhost:3002/console/welcome` → Create account；随后在控制台创建应用，记录应用 ID / Secret 与回调地址，填入 `04_INTEGRATION.md`。
5. Infra：落地 **RAGFlow** compose（尚无编排文件）；验证 Web / API 可访问。
6. 把 RAGFlow 的真实 baseURL、端口、版本、必要 env **只写真实值** 进 `04_INTEGRATION.md`。
7. 更新 `02_PHASES.md`：勾选 Logto / RAGFlow Docker 项；Phase 0 关闭后进入 Phase 1 收尾。
8. **Phase 1 收尾**：`server.services` 用例编排 + `/api` 业务路由（对象 CRUD、库别迁移）+ 页面；用真实 Logto 会话替换 Mock 身份。
9. Phase 2：`server.adapters.ragflow` 适配层 + `content_refs` 映射与 outbox 投递。
10. Phase 3 / 4 / 5 按 `02_PHASES.md`。

端口现状（**以实测为准**）：

| 服务 | 实测端口 | 说明 |
|------|----------|------|
| Next.js | 3000（规划值，未与 Logto 实测冲突） | 主应用 |
| Logto | 3001（服务）/ 3002（控制台） | 已在运行 |
| RAGFlow | 待实测 | 以官方 compose 为准，未部署 |

---

## 7. 架构硬约束（写代码时对照）

```
浏览器 → Next.js (UI + API Routes)
           ├─ 认证 ──────────→ Logto
           ├─ 元数据/状态 ───→ SQLite（Drizzle；ADR-009，仅业务数据）
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

上一轮（提交 `e95d154`）已完成业务数据层与 Logto 自托管。后续 Agent 按以下状态接续：

1. **确认工作区**：ADR-006 是 greenfield 起点记录；Next.js 骨架与业务数据层均已存在，不要找旧代码，也不要重复初始化。
2. **文档卫生**：继续与 SCOPE / PHASES / ADR 保持一致；`04_INTEGRATION.md` 只写实测值，RAGFlow 段保持 `待实测`。
3. **当前状态**：Logto 容器在跑、连通性已实测，但管理员账号未创建；RAGFlow 未部署；Phase 1 缺 API 路由与页面。
4. **顺序**：创建 Logto 管理员账号并配置应用 → RAGFlow 部署与实测 → 实测值写入 `04_INTEGRATION.md` → 关闭 Phase 0 → 补齐 Phase 1 的 `/api` 路由与页面。
5. **输出**：简短《本轮完成》+《下一步命令清单》。

---

## 11. 给用户的同步点（你完成后告诉用户）

- 本轮改了哪些文件
- 当前服务状态：Docker 就绪；**Logto 容器在跑且连通性已实测，但管理员账号未创建、控制台未配置**；**RAGFlow 尚未部署**
- 代码状态：业务数据层（四表 + 两条 CHECK）已落地并有测试覆盖；`/api` 业务路由与页面未实现
- 下一步：需要用户本人在浏览器打开 `http://localhost:3002/console/welcome` 创建 Logto 管理员账号；之后才能继续 Phase 1 的应用侧接入

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
Docker 依赖已解除，文档、骨架、映射设计与业务数据层均已完成。下一步按第 6 节：**先让人建 Logto 管理员账号并配置应用，再部署 RAGFlow**，不要跳步。表述纪律：Logto 只能写到「容器已跑、连通性已实测」为止（应用侧未接通）；RAGFlow 在部署并实测前一律写「未部署」。
