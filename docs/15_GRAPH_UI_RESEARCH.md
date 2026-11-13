# 15. 图谱前端可视化选型调研（codebase-memory-mcp / CBM Lens）

> 调研日期：2026-11-12（Asia/Shanghai）· 数据来源：GitHub API、npm registry、PyPI、pkg.go.dev、bundlephobia、项目 README 与 graph-ui/THIRD_PARTY.md（均为当日实时抓取）
> 性质：仅调研与选型建议；不改代码、不改数据模型、不提交；不碰 docs/03_DECISIONS.md、不写 ADR（ADR 由 Architect 后续完成）。

## 0. 一页结论摘要

- **项目真实存在**：`DeusData/codebase-memory-mcp`，MIT，48,556 Star / 4,019 Fork，主语言 C，昨日（2026-11-11）仍在提交。
- **视频说法核验**：①「百万行代码」→ 已证实且更强（官方基准：Linux 内核 28M 行 / 75K 文件，全量索引 3 分钟）；②「省 99% Token」→ 部分证实（早期五查询口径 3,400 vs 412,000 = 99.2%，官方现口径已弱化为 31 仓库预印本的 10× ≈ 90%）；③「跨 Claude Code / Cursor」→ 已证实（46 个客户端集成）；④「本地部署」→ 已证实（默认 air-gapped、无 API key）。
- **前端预览 = CBM Lens**（open beta v0.0.1）：React 19 + three.js + @react-three/fiber 的 **3D「Galaxy」图谱** + Monaco 源码阅读器 + 本地 on-device AI 问答，loopback `127.0.0.1:9749`。
- **许可证**：仓库根 `LICENSE` = MIT（©2025 DeusData），Galaxy 3D 场景同为 MIT，依赖 MIT/Apache-2.0/Zlib，**无 AGPL、可借鉴代码与视觉**。
- **关键排除**：NVL = Neo4j Visualization Library 为**专有许可**（仅限 Neo4j Aura / 商用数据库产品），不可用。
- **推荐路径**：**C 重做**，首选 **three.js + @react-three/fiber** 复刻 CBM Lens「Galaxy」深空 3D 视觉（three.js 已在 package.json、fiber 9 支持 React 19）；2D 高可读性备选 **Sigma.js**。
- **预计工作量**：约 8–12 人日（1 名前端 1.5–2 周）。
- **未验证**：未实际安装运行 CBM Lens demo，交互与性能体感依据官方 GIF / README / 源码。

---

## 1. 项目核验（是否真实存在）

### 1.1 基本信息

| 项 | 值 | 来源 |
|---|---|---|
| 仓库 | `DeusData/codebase-memory-mcp` | https://github.com/DeusData/codebase-memory-mcp |
| 作者/组织 | DeusData | 同上 |
| Star / Fork / Issue | 48,556 / 4,019 / 551 | GitHub API（2026-11-12） |
| 主语言 | C（后端原生 C，Go/npm/PyPI 为包装层） | GitHub API |
| 许可证 | **MIT**（Copyright (c) 2025 DeusData） | https://github.com/DeusData/codebase-memory-mcp/blob/main/LICENSE |
| 创建 / 最近提交 | 2026-02-24 / 2026-11-11（pushed_at） | GitHub API |
| 官网 | https://deusdata.github.io/codebase-memory-mcp/ | GitHub API homepage |
| 分发 | npm `codebase-memory-mcp@0.12.1`（MIT，2026-10-16）；PyPI `0.11.0`；Go `go install github.com/DeusData/codebase-memory-mcp/pkg/go@latest` | https://www.npmjs.com/package/codebase-memory-mcp · https://pypi.org/project/codebase-memory-mcp/ · https://pkg.go.dev/github.com/DeusData/codebase-memory-mcp |
| 核心能力（README） | tree-sitter 静态分析 163 种语言 → 持久化知识图谱（函数/类/调用链/HTTP 路由/跨服务关系）；17 个 MCP 工具；BM25 + 语义搜索（内置 Nomic embedding）；单静态二进制、零运行时依赖 | https://github.com/DeusData/codebase-memory-mcp |

### 1.2 视频说法逐条核验

| 视频说法 | 判定 | 依据 |
|---|---|---|
| 处理「百万行」代码 | **已证实（更强）** | 官方基准：Linux 内核 **28M LOC / 75K 文件** → 4.81M 节点 / 7.72M 边，全量索引 **3 分钟**（Apple M3 Pro）；快索引 1m12s | https://github.com/DeusData/codebase-memory-mcp#performance |
| 省 99% Token | **部分证实（口径已弱化）** | 早期「五查询对比」：结构化查询 ~3,400 vs 逐文件 ~412,000 token ≈ 99.2%；但官方现主引 **31 仓库预印本：10× 更少 token、2.1× 更少工具调用**（≈90%）。99% 是特定早期口径，不宜当通用承诺 | https://arxiv.org/html/2603.27277v1 · https://github.com/DeusData/codebase-memory-mcp#performance |
| 跨平台兼容 Claude Code / Cursor | **已证实** | `install` 自动检测并注册客户端；README 列 **46 个自动/条件集成**：Claude Code、Codex CLI、Cursor、Windsurf、Aider、Gemini CLI、KiloCode 等 | https://github.com/DeusData/codebase-memory-mcp#multi-agent-support |
| 本地部署、代码隐私 | **已证实** | 本地处理、无需托管服务或 API key；CBM 不主动联网、默认 air-gapped（Lens 走 loopback）；见 SECURITY.md | https://github.com/DeusData/codebase-memory-mcp#security |

### 1.3 同类替代参考（仅列最接近的 2 个，本报告主目标仍是 codebase-memory-mcp）

| 项目 | 许可证 | 说明 | 来源 |
|---|---|---|---|
| `codegraph-engine`（CodeGraph MCP） | 自述 AST 上下文包（本次未深核） | 全栈知识图谱 MCP，Claude/Cursor/Codex 安装器 | https://pypi.org/project/codegraph-engine/ |
| `pigeongraph` | npm（本次未深核） | 单轮架构查询、符号调用链与爆炸半径 | https://www.npmjs.com/package/pigeongraph |

> 注：以上两项目本次未逐一核验许可证与活跃度，仅作「同类方案」定位参考。

---

## 2. 前端拆解（CBM Lens）

### 2.1 形态与入口

- **形态**：独立 Web 应用（Vite + React 19 SPA），打包进 `codebase-memory-mcp` 原生二进制，由 C 守护进程在 **loopback `127.0.0.1:9749`** 提供；**不是独立 npm 组件、不是 VS Code 插件**。
- **启动**：`codebase-memory-mcp daemon start --open --port=9749`；MCP 会话可用 `--ui=true --port=9749`。
- **源码目录**：`graph-ui/`（npm 名 `cbm-lens`，version 0.0.1，`private: true`）。
- **渊源**：构建于 Bernhard Jackiewicz 的 CodeAtlasIDE（README 称 CodeAtlasWeb，THIRD_PARTY 称 CodeAtlasIDE，为同一作者项目）；其 Provider / 语义 IR / twin / 语义搜索模块由作者本人移植入本仓库，源文件头保留来源标记，整体沿用仓库 MIT。

### 2.2 技术栈

| 层 | 选型 | 版本 | 许可证 |
|---|---|---|---|
| 3D 渲染 | three.js | 0.183.2 | MIT |
| React 3D 绑定 | @react-three/fiber | 9.5.0 | MIT |
| 3D 辅助 | @react-three/drei | 10.7.7 | MIT |
| 后处理（辉光等） | @react-three/postprocessing + postprocessing | 3.0.4 / 6.38.3 | MIT / Zlib |
| 代码阅读器 | monaco-editor | 0.56.0 | MIT |
| 本地 AI 问答 | @huggingface/transformers + onnxruntime-web（on-device） | 4.2.0 / 1.26.0-dev | Apache-2.0 / MIT |
| Markdown | react-markdown + remark-gfm | 10.1.0 / 4.0.1 | MIT |
| 构建 | Vite + TypeScript + React | 6.4.5 / 5.9.3 / 19.2.8 | MIT / Apache-2.0 |

### 2.3 Galaxy 图的交互与数据

- **交互**：3D orbit 旋转、滚轮缩放、点选节点/边查看；边颜色区分关系、脉冲示方向；`prefers-reduced-motion` 停脉冲；大图显示上限与省略数。
- **视觉/布局**：高度示源码规模、热点引力反映静态 fan-in；节点/边/标签/光晕分层（`GraphScene` / `NodeCloud` / `EdgeLines` / `NodeLabels` / `HaloLayer` / `density`）。
- **数据格式**：后端 SQLite 图（`.codebase-memory/graph.db.zst`），前端经 `/api`、`/rpc` 取 `system_structure` 投影；节点 = 文件/符号/模块/路由等**代码实体**，边 = 调用/依赖/部署等。
- **demo 链接（官方，非本人截图）**：
  - Galaxy 动图：https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/docs/images/lens-galaxy.gif
  - 架构总览动图：https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/docs/images/lens-overview.gif
  - 本地问答动图：https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/docs/images/lens-chat.gif
  - 静态图：lens-architecture.png / lens-galaxy.jpg / lens-explore.jpg / lens-system-structure.png / lens-behavior.png（同 `docs/images/` 目录）

### 2.4 许可证结论（可用性判定）

| 组件 | 许可证 | 能否复用 |
|---|---|---|
| 仓库整体（含 graph-ui/ Galaxy 场景） | **MIT**（©2025 DeusData） | ✅ 可移植代码，保留 Copyright 头 |
| three.js / fiber / drei / react-markdown / monaco | MIT | ✅ |
| postprocessing | Zlib | ✅（保留来源与修改标识） |
| @huggingface/transformers / onnxruntime-web | Apache-2.0 / MIT | ✅ |
| **AGPL / GPL 成分** | 无 | 无传染风险 |

**结论**：CBM Lens 前端可借鉴代码与视觉（MIT）；但它是「代码实体图」的完整应用，数据模型与交互深度绑定 CBM 后端，不能整体照搬。

---

## 3. 落地路径对比（重点）

### 3.1 总表

| 路径 | 人日粗估 | 鉴权/主题/数据源接法 | 许可证 | 风险 | 结论 |
|---|---|---|---|---|---|
| A. 直接嵌入（iframe / 独立服务） | 0–1（部署）+ 高隐性成本 | loopback 无鉴权，需自建反代；CBM 索引代码而非资产，读不了 LightRAG；两套数据模型硬绑 | MIT | 引入 C 二进制 + 常驻 daemon，违背轻栈；资产实体/类型筛选/两层邻域无法表达 | **不推荐** |
| B. 移植前端组件到 Next.js 16 | 6–10 | 复用现有 Logto 鉴权 + graph-service API；数据绑定需重写 | MIT 允许 | GraphScene 等深度绑 CBM 代码符号模型，移植≈重写；与 C 合流 | 可行但不划算 |
| C. 不搬代码，用同类库重做 | **8–12** | 完全复用现有 Logto + graph-service；数据模型不耦合 | MIT（可借鉴视觉与渲染代码） | 3D 标签可读性需原型验证 | **首选** |

### 3.2 A. 直接嵌入

- 鉴权：CBM Lens 只监听 loopback，无账号体系；嵌入 iframe 需自建反代 + 登录 + CORS，等于再维护一套前端服务。
- 主题/数据源：它按「仓库 → 文件 → 符号」建图，不认我们 Drizzle 里的资产实体（objects / tags / format），没有类型筛选、没有两层邻域语义；LightRAG 数据喂不进去。
- 结论：会硬绑两套数据模型 + 引入重型原生后端，与我们「Next.js + SQLite 单机轻栈」冲突，**排除**。

### 3.3 B. 移植前端组件

- 依赖兼容：fiber 9 支持 React 19；Vite→Next 需把场景组件标 `"use client"` 并处理 SSR 边界；three 版本对齐（我们 0.187 vs 其 0.183，可升/锁）。
- 改动量：可移植 `GraphScene / NodeCloud / EdgeLines / NodeLabels / HaloLayer / density / types` 约 7 个文件，但类型、布局、交互、数据绑定全部要改成资产实体图，实质是重写。
- 许可证：MIT 允许，保留头即可。
- 结论：技术上可行，但与 C 的工作量几乎相同，只剩「照抄渲染代码」的边际收益；**不单列，并入 C**。

### 3.4 C. 重做：渲染库对比（按本项目场景：几百~几千实体、两层邻域、类型筛选、点击聚焦、深空暗色、60fps）

| 库 | 许可证 | 版本 | React 19 | gzip（bundlephobia，2026-11-12） | 暗色适配 | 大图性能 | 活跃度 | 结论 |
|---|---|---|---|---|---|---|---|---|
| three.js + @react-three/fiber | MIT | 0.187.0（已在 package.json）/ fiber 9.5.0 | ✅（fiber 9 peer react ^19） | 181.3 KB + 49.5 KB（drei/postprocessing 按需） | **极佳**（bloom 辉光、深空质感） | WebGL 点云/instanced，数千节点 60fps 可达 | three 118k+ Star，活跃 | **首选** |
| Sigma.js（+graphology） | MIT | 4.0.6 + @react-sigma/core 6.0.0 | ✅（peer react ^18 ‖ ^19） | 94.6 KB + 12.5 KB | 一般（2D，需自配暗色） | WebGL，万级节点强 | npm 2026-11-10 更新，活跃 | 2D 高可读性备选 |
| Cytoscape.js | MIT | 3.35.0 | ⚠️ 无官方 React 绑定（自写 wrapper） | 135.6 KB | 一般（2D） | 小图好，大图吃力 | 11.3k Star，活跃 | 不推荐 |
| React Flow（@xyflow/react） | MIT | 12.12.1 | ✅（peer react >=17） | 58.6 KB | 一般 | 偏流程图/节点编辑器，非力导向知识图谱 | 39.0k Star，活跃 | 范式不符，不推荐 |
| AntV G6 | MIT | 5.1.1 | ⚠️ 无官方 React 绑定（自写 wrapper） | 390.4 KB（体积最大） | 可配 | 中图好 | 12.4k Star，活跃 | 可选但无官方 React 绑定、体积大 |
| NVL（@neo4j-nvl/base） | **专有**（仅限 Neo4j 产品） | 2.1.0 | ✅（有 React 绑定） | — | Bloom 同款 | 强 | Neo4j 维护 | **许可证排除** |

> 包体积为 bundlephobia 当日实测（min+gzip）；React 19 兼容性来自各包 peerDependencies。

### 3.5 一句话推荐

**重做（Path C），首选 three.js + @react-three/fiber**：复刻 CBM Lens「Galaxy」深空 3D 视觉（MIT 可借鉴，three.js 已在依赖里），数据继续走现有 `graph-service` + Logto，不嵌、不全量移植；若团队更看重 2D 标签可读性与开发速度，退而求其次 **Sigma.js**。

---

## 4. 未验证项与风险

- **未实际运行 demo**：本次未安装/启动 CBM Lens，交互细节与 60fps 体感均来自官方 GIF、README 与源码，非亲手验证。
- **「99% Token」口径**：为早期五查询对比；采信前建议按官方 `docs/MEASURING_SAVINGS.md` 在自己的资产语料上自测（我们不是代码库，收益可能显著缩水）。
- **CodeAtlasIDE 独立仓库未找到**：Bernhard Jackiewicz 的原项目本次未定位到公开 repo；其模块已由作者本人并入本仓库并沿用 MIT，若未来单独复用需再核对源文件头与出处。
- **arxiv 预印本 2603.27277v1 未逐页核验**：仅转引官方 README 结论。
- **3D 标签重叠/可读性**：深空 3D 图谱的实体名在几千节点下易遮挡，需在原型阶段验证 LOD/标签策略，并预留 Sigma.js 2D 降级预案。
- **three.js 已在依赖**：若银河首页已使用 three，图谱复用同一版本可省体积；需注意与本页性能预算叠加。

---

## 附：关键来源清单

- 仓库：https://github.com/DeusData/codebase-memory-mcp
- 许可证：https://github.com/DeusData/codebase-memory-mcp/blob/main/LICENSE
- 前端源码：https://github.com/DeusData/codebase-memory-mcp/tree/main/graph-ui
- 前端第三方声明：https://github.com/DeusData/codebase-memory-mcp/blob/main/graph-ui/THIRD_PARTY.md
- 性能基准：https://github.com/DeusData/codebase-memory-mcp#performance
- 预印本：https://arxiv.org/html/2603.27277v1
- 官网/demo：https://deusdata.github.io/codebase-memory-mcp/
- npm：https://www.npmjs.com/package/codebase-memory-mcp · PyPI：https://pypi.org/project/codebase-memory-mcp/