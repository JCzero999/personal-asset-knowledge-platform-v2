# 旧项目功能盘点 · 内库外库定义 · Phase 1/2 验收标准

> 产品侧输入文档。**不修改 `docs/`**，结论供文档同事合并进 00_SCOPE / 01_ARCHITECTURE / 02_PHASES / 03_DECISIONS。
> 盘点依据：`D:\projects\Personal Asset & Knowledge Platform` 的实际代码、测试与 `vault/` 真实数据（只读），不是复述它的 PRD。
> 日期：2026-11-11

---

## 0. 结论摘要

1. **旧项目确实有 5 个一级模块**：资产库、编辑工作区、知识图谱、评估与复盘、设置。新项目第一期收敛为 **2 个业务对象（资产 / 作品）+ 1 个内容底座（RAGFlow）+ 1 个图谱（LightRAG）**，模块数从 5 降到 3，这是重构的主收益。
2. **功能上的真实损失不在「砍掉的那几项」**，而在于 **12 条从未写进新文档的既有规则**（第 1.4 节），其中 4 条是产品核心逻辑而非体验细节：作品 `format`、作品→转资产、手写优先排序、外库禁止直接 `practiced`。不补进文档，实现阶段必然丢。
3. **内库/外库不是「内部/外部来源」，是「是否经过真实世界验证」。** 它是单值、互斥、可迁移的生命周期属性，与「内容从哪来」正交。旧项目把这两件事混在一个维度里（`flomo-import` 目录 + `library: outer`），这是要修掉的第一个概念债。
4. **RAGFlow 侧建议单 Dataset**，`library` 只做业务元数据、不做内容分区。否则「外库→内库」会变成跨 Dataset 搬运文档，直接违反 01_ARCHITECTURE §5「状态变化只改元数据，内容位置稳定」。
5. **旧项目里有两处自相矛盾的数据形态**（`library: inner` + `status: draft`；资产 3 态 vs 作品 4 态），说明资产不应有 `status` 字段。建议砍掉，把生命周期统一收进 `library` + `archived`。

---

## 1. 旧项目功能盘点

### 1.1 信息架构总览（代码事实）

| 维度 | 旧项目实际形态 |
|---|---|
| 路由 | `/` → 重定向 `/workspace`；`/assets`、`/knowledge`、`/assessments`、`/settings` |
| 内容真相 | 本地 Markdown + YAML Frontmatter，`vault/` 目录即数据库 |
| 一级对象 | **资产 Asset**（`vault/assets/{inner,outer}/<主分类>/*.md`）、**作品 Work**（`vault/knowledge/{inner,outer}/{drafts,flomo-import,works}/*.md`） |
| 辅助存储 | `meta/tags.json`、`categories.json`、`directories.json`、`knowledge-map.json`、`ai-config.json`、`assessment-runs.json` |
| API | 12 个路由：`assets`、`works`、`metadata`、`directories`、`search`、`knowledge`、`import`、`flomo/import`、`assessments`、`assessments/run`、`assessments/runs`、`ai-config` |
| 外部依赖 | 本机 `cheat-on-content` 项目（只读 `predictions/`、`.cheat-state.json`、`rubric_notes.md`）；OpenAI 兼容 LLM 接口 |
| 代码规模 | 6 个 page 文件（含 1 个重定向）、18 个 lib 模块、15 个测试文件；最大页面 1476 行 |

**关键设计事实（影响新定义）**：

- `library` 在旧项目里**同时是物理目录**。改 `library` 就是 `rename()` 移动文件。
- `status` 与 `library` **互相独立**：改状态不移动文件，只有「迁移到内库」同时改两者。
- 作品内库（`knowledge/inner/works/`）**只读**——`updateWork` 直接拒绝 `library !== "outer"` 的编辑。
- 资产的 `library` 可以**手动双向移动**（列表行内「移动库」按钮），PRD 3.1.3 明确允许。

### 1.2 功能盘点表

判定口径：**第一期保留** / **明确砍掉** / **文档里漏了**（= 旧项目有、新文档没写、也未被 ADR 明确砍掉）。

#### A. 资产库（`/assets` + `lib/assets.ts`）

| # | 功能 | 旧项目实际行为 | 判定 | 理由 / 处置 |
|---|---|---|---|---|
| A1 | 资产列表 | 内/外库两个根目录递归扫描 `.md`；frontmatter `library` 必须与目录一致，否则报错 | 第一期保留 | 核心。新实现改为查业务库 + `content_ref` |
| A2 | 多维筛选 | 库（内/外/全部）、来源（手写/AI/全部）、分类（多选 OR）、标签（AND/OR 可配置）、优先级、全文（标题+描述+正文+标签） | 第一期保留 | 标签 AND/OR 语义是用户真实用过的，不要简化成单一模式 |
| A3 | 排序 | **手写永远在 AI 前** → 优先级 → 更新时间/创建时间，三级排序 | 第一期保留（见 1.4-③） | 这是产品规则，不是排序选项 |
| A4 | 新建 / 编辑 | 标题、正文（Markdown 文本域）、多分类（首个为主分类决定目录）、标签、优先级、来源、库 | 第一期保留 | 多分类的「主分类」语义要保留，否则归档目录失去依据 |
| A5 | 删除 | 物理 `rm`，**无二次确认弹窗外的保护** | 改造后保留 | 建议改为「内库不可删，只能归档」 |
| A6 | 归档 / 恢复 | 移到 `assets/archive/<library>/<主分类>/`，恢复时避免重名覆盖 | **文档漏了** | 旧项目唯一的内容保全机制，新文档零提及 |
| A7 | 内↔外库手动移动 | 行内按钮，双向、无确认、无理由记录 | **文档漏了** | 与作品规则冲突，需在 2.4-④ 明确定义 |
| A8 | 批量归档 | 列表多选 + 批量移动 | 明确砍掉 | ADR-002「高级批量能力」 |
| A9 | 加密分享 | 勾选资产 → 设 8–128 位密码 → 浏览器端生成 AES ZIP 下载 | 明确砍掉 | ADR-002 已定 |
| A10 | 标签/分类全局管理 | 新增、移除、**重命名标签并批量改写所有资产 frontmatter**（带事务回滚） | **文档漏了** | 重命名是数据治理刚需，不含它等于标签只能加不能改 |
| A11 | 资产 `status` | `draft / published / practiced`，与 `library` 并存 | **文档漏了**（建议砍） | 见 2.4-⑥：真实数据里出现 `inner + draft` 矛盾组合 |

#### B. 编辑工作区 / 作品（`/workspace` + `lib/workspace.ts`）

| # | 功能 | 旧项目实际行为 | 判定 | 理由 / 处置 |
|---|---|---|---|---|
| B1 | 作品列表与导航 | 全部 / 内库 / 外库 / 草稿 / 外部导入 / 进行中的作品 / 评估与复盘 / 已验证沉淀 | 保留（合并为 4 段） | 见 1.5-② |
| B2 | 新建 / 编辑草稿 | 标题、正文、格式、标签、分类、描述、状态；**仅外库可编辑** | 第一期保留 | 内库只读是强约束，必须继承 |
| B3 | 删除草稿 | 仅 `library: outer && status: draft`；已转资产的来源作品禁止删除 | 第一期保留 | 防误删的规则要保留 |
| B4 | 批量删除草稿 | 列表多选 | 明确砍掉 | ADR-002「高级批量」 |
| B5 | 迁移到内库（practice） | 二次确认 → 移动文件到 `knowledge/inner/works/` → 写入 `practiced` | 第一期保留（**核心**） | 唯一的内库入口 |
| B6 | 外库禁止直接 `practiced` | `updateWork` 抛错，提示走「迁移到内库」 | 第一期保留（**核心**） | 内库质量闸门 |
| B7 | 转为资产 | 保留原作品，新建 `source: handwritten` 资产；`source_note` 关联来源；同一作品重复转换被拒（加锁） | **文档漏了** | 「写→验证→沉淀为可复用资产」闭环的关键一环 |
| B8 | 作品 `format` | `article / script / flomo / course / live / consult` 六值 | **文档漏了** | 影响列表、筛选、未来评估接入 |
| B9 | 作品详情弹窗 | 独立只读弹窗，含评估摘要 | 砍掉 | 合并进详情面板即可 |
| B10 | 评估摘要回写 | 写 `cheat_score`、`assessment_id`、`rubric_version`、`cheat_bucket` | 砍掉但保留字段 | 见 1.4-⑨ |

#### C. 导入（`/api/import`、`/api/flomo/import`）

| # | 功能 | 旧项目实际行为 | 判定 | 理由 / 处置 |
|---|---|---|---|---|
| C1 | flomo 导入 | 解析 flomo 导出 HTML（Cheerio）或纯文本 → 拆成多篇笔记 → 保留原日期与 #标签 → 落外库 `flomo-import/` | **文档漏了** | 新 scope 只说「本地文件降级为导入来源」，无任何规格 |
| C2 | 多文件批量导入 | `.md` / `.markdown` / `.docx` / `.html` / `.txt`，逐个处理，部分失败不中断，汇总成功/失败数 | **文档漏了** | 首个内容进入系统的唯一现实路径 |
| C3 | docx → Markdown | 解 ZIP 读 `word/document.xml`，处理段落、制表、换行、表格、删除修订 | **文档漏了** | 用户真实素材大量是 Word |
| C4 | 「外部导入」独立视图 | 作为外库下的固定目录 + 导航项 | **文档漏了** | 见 2.4-①：这正是 library 与来源混淆的现场 |

#### D. 知识图谱（`/knowledge`）

| # | 功能 | 旧项目实际行为 | 判定 | 理由 / 处置 |
|---|---|---|---|---|
| D1 | 标签共现图 | 读内/外库作品 → 节点；**共享标签即连边**；上限 250 节点 / 1000 边；点击节点跳搜索 | 明确砍掉 | ADR-002「旧知识图谱实现」 |
| D2 | 节点类型/标签覆盖编辑 | `meta/knowledge-map.json` 覆盖节点 type 与 tags | 明确砍掉 | 属于旧实现 |
| D3 | 实体关系图 | — | 新增（LightRAG） | ADR-001 |

> 注意：D1 是**伪图谱**（tag 共现，不是实体抽取）。它不是「LightRAG 的简化版」，两者不可平滑替换，不要按 D1 的交互去设计 D3。

#### E. 评估与复盘（`/assessments`）

| # | 功能 | 旧项目实际行为 | 判定 | 理由 / 处置 |
|---|---|---|---|---|
| E1 | 读 cheat-on-content 预测日志 | 通过 `CHEAT_ON_CONTENT_ROOT` 只读本机项目：作品脚本、盲预测、rubric 版本、实际数据 | 明确砍掉 | ADR-002「平台试运行评估」 |
| E2 | 平台内试运行评估 | 用 OpenAI 兼容接口按 rubric 打分，结果落 `predictions-drafts/`（git 忽略） | 明确砍掉 | ADR-002 |
| E3 | 工作流指标卡 | 拍摄 buffer 数、待复盘队列、校准样本、当前 rubric | 明确砍掉 | 依赖 E1 |
| E4 | 多模型配置抽屉 | `ai-config.json` + 每模型绑定 `keyEnv`，密钥只写 `.env.local` | **文档漏了** | 新项目 `.env.example` 已有 `OPENAI_*`，但「是否支持多模型切换」未决策 |

#### F. 全局与体验层

| # | 功能 | 旧项目实际行为 | 判定 | 理由 / 处置 |
|---|---|---|---|---|
| F1 | 全局搜索 | 跨资产+作品，支持布尔语法（AND/OR/引号/字段限定），返回前 12 条，带类型与库标识 | 部分保留，**规格漏了** | 新项目由 RAGFlow 承担语义检索，但「跨对象、返回带来源、可回跳」的产品要求没写 |
| F2 | 命令面板 `Ctrl+K` | 命令 + 内容混合搜索 | 明确砍掉 | ADR-002「复杂命令面板」 |
| F3 | 快速捕捉 | 顶栏一键记一条，`localStorage` 暂存防丢，保存为外库草稿 | **文档漏了** | 单用户日常高频动作，成本极低 |
| F4 | 主题切换 / 面板拖拽 / 焦点陷阱 / skip-link | 深色模式、三处分栏拖拽并记忆、对话框焦点管理 | 砍掉（体验层） | 但建议把「键盘可达 + 焦点可见」写进验收（3.1.2 的 KBD-01） |
| F5 | 设置页 | 知识库与工作区**目录**增删、标签/分类管理 | 部分保留 | 「目录」概念在 RAGFlow 下需重新映射，见 2.4-⑧ |

### 1.3 本次重构的功能差额（一句话版）

| 类别 | 内容 |
|---|---|
| **保留并重新定义** | 资产 CRUD 与多维筛选、多分类主分类、优先级、手写优先排序、四阶段工作流、外库禁止直接进内库、迁移到内库、内库只读、导入（flomo/Word/Markdown）、标签分类治理、归档 |
| **明确砍掉** | 本地 Markdown 作为真相源、旧 tag 共现图谱、加密分享 ZIP、cheat-on-content 读取、平台内试运行评估、批量操作、命令面板、评估与复盘页 |
| **新增** | Logto 登录注册、RAGFlow 内容底座（解析/分块/向量/检索）、LightRAG 图谱、`content_ref` 映射、语义检索 |
| **被砍掉但需要"留位置"** | 评估摘要字段（`cheat_score`/`assessment_id`/`rubric_version`）——砍功能，别砍字段 |

### 1.4 文档遗漏清单（12 条，必须补进 docs）

按「不补就会在实现阶段丢」的严重度排序。建议全部以 ADR 或 scope 条目形式落定，而不是留在对话里。

| # | 遗漏项 | 为什么必须写进文档 | 建议落点 |
|---|---|---|---|
| ① | **作品 `format` 六值**（文章/脚本/课程/直播/咨询/外部笔记） | 影响数据模型、列表、筛选；后补要迁移 | 00_SCOPE + 01_ARCHITECTURE 数据模型 |
| ② | **作品 → 转资产** 路径与防重规则 | 这是「资产从哪来」的主要来源，缺了闭环不成立 | 00_SCOPE 保留项 |
| ③ | **手写优先于 AI 提炼**的排序与默认优先级规则 | 旧 PRD 第 1.2 条把它列为**第一优先级目标**，新文档完全丢失 | 00_SCOPE + 验收标准 |
| ④ | **外库作品禁止直接 `practiced`** | 内库质量闸门，唯一强制规则 | 00_SCOPE + 02_PHASES Phase 4 |
| ⑤ | **导入能力**（flomo HTML/文本、docx、md、多文件） | 没有导入，「内容进入 RAGFlow」没有入口 | 00_SCOPE + Phase 2 |
| ⑥ | **归档 / 恢复** | 唯一的删除替代方案，内库不可删则必须有归档 | 00_SCOPE |
| ⑦ | **标签重命名 + 批量改写** | 数据治理刚需 | Phase 4 |
| ⑧ | **资产/作品是否需要 `status`** | 现有 DRAFT 只给 Work 加 status，与旧实现不一致，属未决策 | ADR（本文件 2.4-⑥ 给建议） |
| ⑨ | **评估字段保留但功能砍掉** | 砍功能时容易连字段一起删，后补成本高 | 00_SCOPE「砍掉」旁注 |
| ⑩ | **导入后的库归属**（导入内容默认进外库） | 与 2.4-⑤ 新建默认库必须一致 | 03_DECISIONS |
| ⑪ | **RAGFlow Dataset 粒度**（单库 vs 按内/外分库） | 决定「迁移到内库」是不是搬文档，架构级 | ADR-007（见 2.4-③） |
| ⑫ | **`inner/outer` → `internal/external` 命名映射** | 旧代码与旧文档全用 inner/outer，新 DRAFT 用 internal/external，易混 | 04_INTEGRATION 名词表 |

### 1.5 盘点中发现的三处内部矛盾（产品决策依据）

| # | 矛盾 | 证据 | 结论 |
|---|---|---|---|
| ① | 资产的 `status` 与 `library` 语义重叠 | `vault/assets/inner/测试/20261017-test2.md` 同时是 `library: inner` + `status: draft`；按定义「内库=已验证」却是草稿，自相矛盾 | 资产不要 `status`（见 2.4-⑥） |
| ② | 导航项混了三种维度 | 工作区第二列同时列「内库/外库」（库）、「草稿/进行中/评估复盘」（状态）、「外部导入」（目录） | 新导航按 **库 → 状态** 两维，导入不再是一级导航 |
| ③ | 「知识库」名不副实 | `/knowledge` 是 tag 共现图，`knowledge/inner|outer/` 是作品目录，两者同名不同物 | 新项目把「知识库」归还给 RAGFlow，图谱叫「知识图谱」，不要复用「知识库」这个词 |

---

## 2. 内库 / 外库的精确定义

### 2.1 一句话定义

> **外库 = 输入与待验证区**：已进入系统、但尚未经过真实世界（发布/使用/讲授）检验的内容。
> **内库 = 已验证与可复用区**：经过真实反馈检验、可以直接拿出来用或教别人的知识。

判定标准只有一条：**"我现在敢不敢直接拿它去用 / 去教别人？"** 敢 → 内库；不敢 → 外库。
它不是「自己写的 vs 外部来的」，不是「原创 vs 转载」，也不是「文集 vs 素材库」。

### 2.2 可操作的判定规则

| 情形 | 归属 | 说明 |
|---|---|---|
| 刚导入的 flomo 笔记、剪藏、别人课程的笔记 | 外库 | 未经自己验证 |
| 自己写、但还没写完的草稿 | 外库 | |
| 写完了、还没发布 | 外库 | 对应 `finished` |
| 已发布、还在等数据回来看效果 | 外库 | 对应 `published`，**发布 ≠ 验证通过** |
| 已发布且真实数据/实践反馈回来、确认有效 | 内库 | 对应 `practiced`，唯一入口是「迁移到内库」 |
| 自己总结的方法论、工具手册，已在自己项目里用过并跑通 | 内库 | 资产里最常见的内库形态 |
| 从别处学来、装过一次、确实解决了问题的手册 | 内库 | 来源是外部不改变归属——**验证过就是内库** |

反例（明确不属于本维度）：

- 「内库 = 私有，外库 = 公开分享」→ 错。旧项目的加密分享对**两个库都可用**。
- 「外库 = 外部导入」→ 错。旧项目 `flomo-import` 只是外库下的一个物理目录；自己写的草稿也在外库。
- 「内库 = 只读」→ 部分对。旧项目**作品**内库只读，**资产**内库可编辑。

### 2.3 与「来源」正交：需要两个独立字段

旧项目的混乱根源是把「从哪来」和「验证没验证」塞进一个 `library`：

```text
             验证过          没验证
自己写      内库/资产        外库/草稿
外部来      内库/资产        外库/导入笔记
```

四象限都真实存在。因此：

| 字段 | 取值 | 回答的问题 | 谁维护 |
|---|---|---|---|
| `library` | `internal` / `external` | 验证没验证？ | 用户显式迁移 |
| `source` | `handwritten` / `ai_extracted` | 内容是人写的还是 AI 生成的？ | 创建时确定 |
| `origin` | `self` / `imported` | 内容最初从哪来？ | 导入时确定，之后不变 |

**推荐**：第一期落地 `library` + `source`（沿用旧项目，成本为零）；`origin` 可延迟到 Phase 2 导入功能时加，但**不要在 `library` 里编码来源**。

理由：`library` 一旦承担来源语义，就无法表达「导入的笔记被验证后进内库」——而这恰好是用户最主要的真实动线。

### 2.4 八个边界问题的推荐做法

| # | 问题 | 推荐做法 | 理由 |
|---|---|---|---|
| ① | 外库是否指「外部来源导入」？ | **不是。** 外库是「未验证」；导入是 `origin`，二者独立。导入内容**默认落外库**，因为它天然未验证。 | 见 2.3 四象限。若把外库等同导入，自己写的草稿无处安放 |
| ② | 同一内容能否同时属于两库？ | **不能。** 单值、互斥。同一份内容需分两处使用时，走「转资产」产生**两个业务对象**，用 `source_note` 关联，各自独立演化。 | 库是生命周期状态，不是标签。「同时两库」会让「内库有多少资产」「迁移算不算完成」无法回答 |
| ③ | 检索时是否分开？ | **业务侧统一检索，结果带库标识并可筛选；RAGFlow 侧单 Dataset。** 默认不过滤，用户想只看内库时一键切换。 | 用户诉求是「找到东西」，默认分库=搜两次。单 Dataset 的硬理由：ADR-005 + 01_ARCHITECTURE §5「状态变化只改元数据，内容位置稳定」——若内外库分 Dataset，`practice` 就得搬文档，违反已采纳架构。**此项需确认（ADR-007）** |
| ④ | 谁能改库？方向？ | **外→内**：只能通过显式动作（作品的「迁移到内库」、资产的「提升为内库」），二次确认。**内→外**：允许，但必须填理由，记 `demoted_at` / `demote_reason`，并保留 30 天可撤销。 | 旧项目资产可无确认双向乱移，导致内库失去含义；作品则完全禁止降级，用户写错无法自救。折中：允许降级但留痕 |
| ⑤ | 新建内容默认进哪个库？ | **外库。** 无例外。 | 内库是质量承诺；默认进内库等于取消闸门 |
| ⑥ | 资产需要 `status` 吗？ | **不需要。** 资产生命周期 = `library`（外/内）+ `archived`（布尔/时间）。砍掉旧的三态。 | 旧数据已有 `inner + draft` 矛盾；资产的「发布/实践」语义与作品的四阶段重复，且资产本身是「已被验证的成品」，再加状态是二次记账 |
| ⑦ | 内库内容可删吗？ | **不可硬删除。** 只能归档；归档后可恢复。作品内库**不可编辑**（继承旧规则），资产内库可编辑但每次编辑留版本时间戳。 | 内库是长期资产，误删不可逆；只读是对「已验证」的尊重 |
| ⑧ | 旧「知识库目录」怎么映射？ | **不映射。** 旧 `knowledge/{inner,outer}/<folder>/` 是文件分区；新项目用 RAGFlow Dataset + 业务侧 `categories`。第一期只保留**一个**内容 Dataset，分类靠业务字段。 | 目录是文件系统的妥协产物；RAGFlow 下再用目录分层会造成「元数据在业务库、结构在 RAGFlow」双重真相 |

### 2.5 状态机（合并旧项目两套规则）

```text
                     ┌──────────── 归档（可恢复）────────────┐
                     │                                      │
  [外库 external] ──迁移到内库(confirm)──► [内库 internal] ──► [已归档 archived]
        ▲                                      │
        └──────── 降级(需理由, 留痕) ◄──────────┘

  作品在外库内： draft → finished → published   （practiced 只能由迁移动作写入）
  资产无 status，只有 library + archived
```

硬规则（建议写成验收项）：

1. `library = external` 的作品，`status` 不得为 `practiced`（服务端拒绝，返回明确错误码）。
2. 内库作品不可编辑（`PATCH` 返回 409 或 403）。
3. 迁移是**改字段**，不产生副本；`content_ref` 不变。
4. 「转资产」是唯一产生副本的路径，必须写 `source_note` 且同一来源只能转一次。
5. 任何库变化都写审计（`library_changed_at`、`from`、`to`、`reason`）。

### 2.6 命名对齐（写进 04_INTEGRATION 名词表）

| 旧项目 | 新项目 | 说明 |
|---|---|---|
| `inner` / `outer` | `internal` / `external` | 值改名，语义不变；UI 中文仍是「内库 / 外库」 |
| `vault/assets/*` | 资产（业务对象）+ RAGFlow 文档 | 不再是目录 |
| `vault/knowledge/*` | 作品（业务对象）+ RAGFlow 文档 | 不再是目录 |
| `location`（drafts/works/flomo-import/inner） | 不保留 | 由 `library` + `status` + `origin` 表达 |
| `flomo-import` 目录 | `origin: imported` + 导入批次 | 不再是导航项 |

---

## 3. 验收标准

### 3.0 总则

- 每条都必须是**黑盒可断言**的：给定前置条件，执行一次操作，观察一个明确结果（HTTP 状态码、页面可见文本、数据库行、RAGFlow 侧对象）。
- 标注 `P0` = 不做完不能进下一阶段；`P1` = 阶段内应做；`P2` = 可延后。
- 「需要用户确认」的项在 3.4 单独列出，未确认前按**建议默认值**实现。

### 3.1 Phase 1：Next.js 骨架 + 真实 Logto 身份

目标：把 Mock 身份换成真实 Logto 会话，且业务数据层具备最小可运行形态。

#### 3.1.1 认证与身份

| ID | 优先级 | 前置 | 操作 | 期望结果（断言） |
|---|---|---|---|---|
| AUTH-01 | P0 | 未登录、浏览器无会话 Cookie | 访问 `/workspace` | 返回 302/307；`Location` 指向 Logto 授权端点，且 URL 含 `client_id`、`redirect_uri`、`response_type=code`、`state`、`code_challenge`、`code_challenge_method=S256`、`scope` 含 `openid` |
| AUTH-02 | P0 | 已在 Logto 登录 | 访问 `/workspace` | HTTP 200；页面出现当前 Logto 用户的 `name` 或 `email`（与 Logto 控制台该用户一致）；页面**不出现**「Mock」「预览」「本地骨架」字样 |
| AUTH-03 | P0 | 未登录 | `GET /api/assets`、`POST /api/assets`、`GET /api/works` 各一次 | 均返回 401，响应体 `{"error":{"code":"UNAUTHENTICATED"}}`；**不得**返回 302（避免 fetch 静默失败） |
| AUTH-04 | P0 | 从 `/workspace` 发起登录 | 在 Logto 完成登录后回调 `/api/auth/callback?code=...&state=...` | 302 到 `/workspace`（原始目标路径，不是硬编码首页）；响应 `Set-Cookie` 含会话 Cookie，属性 `HttpOnly`、`SameSite=Lax`、生产环境 `Secure`；Cookie 值不可解码出明文用户信息 |
| AUTH-05 | P0 | 手工构造回调 | 用**过期或伪造**的 `state` 访问回调 | 返回 400 且**不建立**会话；随后访问 `/workspace` 仍跳登录 |
| AUTH-06 | P0 | 未登录 | 在 Logto 登录页点「注册」，用新邮箱完成注册 | 回调后落地 `/workspace`，页面显示新用户标识；再次登录该邮箱仍能进入，且 `sub` 不变 |
| AUTH-07 | P0 | 已登录 | 点「退出」 | 302 到 Logto 登出端点（带 `id_token_hint` 或 `post_logout_redirect_uri`）；回到应用后访问 `/workspace` 又跳登录；Logto 侧会话同步失效（再点登录需重新输密码） |
| AUTH-08 | P0 | 已登录 | 浏览器直接删除会话 Cookie 后刷新 `/workspace` | 跳转登录页，不出现 500，不出现「半登录」页面 |
| AUTH-09 | P0 | 已登录 | 打开第二个标签页访问 `/workspace` | 直接 200，无需再次登录 |
| AUTH-10 | P0 | 已登录 | 调 `POST /api/auth/sign-out`（同源 fetch） | 204/200，会话失效；跨站来源（`Origin` 非本站）调用返回 403 |
| AUTH-11 | P1 | 已登录 | 查看页面源码与 `localStorage`/`sessionStorage` | 不含 access token、ID token 或用户 `sub` 明文；身份只能由服务端会话提供 |
| AUTH-12 | P1 | 服务运行中 | 访问 `/api/health` | 200，`{"status":"ok",...}`；**不需登录**；响应体不含任何 env 值、密钥或内部地址 |
| AUTH-13 | P1 | Logto 容器停止 | 访问 `/workspace` | 返回可读错误页（5xx 或引导页），提示「身份服务不可用」，**不是**无限重定向循环或白屏 |

#### 3.1.2 数据与页面骨架

| ID | 优先级 | 前置 | 操作 | 期望结果（断言） |
|---|---|---|---|---|
| DATA-01 | P0 | 已登录 | `POST /api/assets` 提交 `{title, library:"external", categories:["tools"], tags:[], priority:"high", content:"..."}` | 201；返回 `id`、`contentRef: null`（Phase 1 未接 RAGFlow）、`createdAt`；`GET /api/assets` 能查到该条 |
| DATA-02 | P0 | 已有一条外库资产 | `GET /api/assets?library=internal` | 返回空数组；`?library=external` 返回 1 条 |
| DATA-03 | P0 | 已登录 | 直接访问 `/assets`，刷新页面 | 列表数据来自真实 API（关掉 API 后页面显示错误态而非旧数据） |
| DATA-04 | P0 | 未登录 | 访问 `/` | 跳转登录（不再有「预览已登录工作台」按钮） |
| DATA-05 | P1 | 已登录 | `POST /api/assets`，`library` 传 `"inner"` | 400，错误码 `INVALID_LIBRARY`（新建禁止直接进内库，见 2.4-⑤） |
| DATA-06 | P1 | 已登录 | `PATCH /api/assets/{id}` 把 `library` 从 `external` 改为 `internal` | 200；记录 `library_changed_at` 与 `reason`；审计表新增一行 |
| DATA-07 | P1 | 已有内库资产 | `DELETE /api/assets/{id}` | 409，错误码 `ARCHIVED_ONLY`；`PATCH {archived:true}` 返回 200 |
| DATA-08 | P1 | 已登录、数据库为空 | 重启服务后访问 `/assets` | 数据仍在（持久化生效，不是内存态） |
| DATA-09 | P2 | 已登录 | 检查数据库 schema | 每张业务表有 `owner_sub` 列，值等于当前 Logto `sub`；查询**不做**按 `owner_sub` 过滤（单用户期） |
| KBD-01 | P2 | 已登录 | 键盘 Tab 走完导航与列表 | 焦点顺序合理、焦点环可见、无焦点陷阱；`Esc` 可关闭弹窗 |

### 3.2 Phase 2：RAGFlow 内容底座 + `content_ref` 映射

目标：内容真正进入 RAGFlow，解析、分块、检索可用，业务侧只存映射。

#### 3.2.1 连通与健康

| ID | 优先级 | 前置 | 操作 | 期望结果（断言） |
|---|---|---|---|---|
| CONT-01 | P0 | RAGFlow 已启动 | `GET /api/content/health` | 200，返回**实测**版本号与 Dataset 可达性；值写入 `04_INTEGRATION.md` |
| CONT-02 | P0 | RAGFlow 停止 | 同上一请求 | 503，`{"error":{"code":"CONTENT_UNAVAILABLE"}}`；**不得**返回 `ok` 或缓存的成功态 |
| CONT-03 | P0 | RAGFlow 正常 | 上传一个 2 页 PDF 资产 | 返回 `contentRef: {provider:"ragflow", datasetId, documentId}`，两个 id 均非空且**来自 RAGFlow 响应**（在 RAGFlow 控制台可查到） |
| CONT-04 | P0 | CONT-03 已完成 | 在 RAGFlow 控制台打开该 `documentId` | 文档存在、chunk 数 > 0、解析状态为成功 |

#### 3.2.2 一致性（最容易出孤儿的地方）

| ID | 优先级 | 前置 | 操作 | 期望结果（断言） |
|---|---|---|---|---|
| CONT-05 | P0 | 模拟 RAGFlow 返回 500（断点或停容器） | `POST /api/assets` | 返回 5xx；业务库**无**该资产行（或状态为 `sync_failed` 且可查）；**绝不**出现 `contentRef` 有 id 但 RAGFlow 无此文档 |
| CONT-06 | P0 | 已有资产 | `PATCH` 修改正文 | 200；RAGFlow 同一 `documentId` 内容更新、chunk 重算；`documentId` **不变**；不产生第二个文档 |
| CONT-07 | P0 | 已有资产 | `DELETE`（或归档为删除语义） | RAGFlow 该文档不存在（再 GET 返回 404）；业务库无残留；若 RAGFlow 删除失败，接口返回 5xx 且业务行标为 `sync_failed` |
| CONT-08 | P0 | 已有作品，`library` 从 external 迁到 internal | 执行「迁移到内库」 | 业务 `library` 变化；`contentRef.documentId` 不变；RAGFlow 文档数与 chunk 数均不变（**验证单 Dataset 决策**） |
| CONT-09 | P0 | 作品依次 draft→finished→published | 每次流转后查 RAGFlow | 每次仅业务 `status`/`updatedAt` 变化；RAGFlow 文档数恒为 1，chunk 数不变 |
| CONT-10 | P1 | 同一文件连续上传两次 | 两次 `POST /api/assets` | 产生两个业务对象；接口返回 `possibleDuplicate: true`（按内容 hash 判定）；不静默合并、不报错 |
| CONT-11 | P1 | 上传 50MB 文件 / `.exe` | `POST /api/assets` | 400，错误码 `FILE_TOO_LARGE` / `UNSUPPORTED_TYPE`；业务库无记录；RAGFlow 无残留 |

#### 3.2.3 检索与回跳

| ID | 优先级 | 前置 | 操作 | 期望结果（断言） |
|---|---|---|---|---|
| CONT-12 | P0 | 已入库 3 份内容，其中 1 份含独特词「斑马线」 | `GET /api/search?q=斑马线` | 返回该 chunk 命中；结果含 `documentId`、业务对象 `id`、`title`、`library`；点击可跳到对应详情页（回跳 URL 可解析） |
| CONT-13 | P0 | 同上 | `GET /api/search?q=斑马线&library=internal` | 结果中 `library` 全为 `internal`；若该文档在外库则返回空（验证元数据过滤，不是二次筛选前端） |
| CONT-14 | P1 | 内容解析中（parsing） | 立即 `GET` 资产详情 | 返回 `parseStatus: "parsing"`，前端显示「解析中」；解析完成后（或轮询）自动变为可用，无需刷新两次 |
| CONT-15 | P1 | 解析失败的内容 | `GET` 资产详情 | `parseStatus: "failed"` + 可读原因 + 提供「重试解析」接口，重试后状态改变 |
| CONT-16 | P1 | 空查询 | `GET /api/search?q=` | 400 或空数组（明确的约定，不是 500） |

#### 3.2.4 映射契约（写入 04_INTEGRATION 才算过）

| ID | 优先级 | 操作 | 期望结果 |
|---|---|---|---|
| CONT-17 | P0 | 用真实接口验证 Dataset/Document 的创建、读取、更新、删除 | 4 个契约的实际请求/响应字段写入 `04_INTEGRATION.md`；**禁止**保留「待实测」 |
| CONT-18 | P0 | 检查 `04_INTEGRATION.md` | 版本、Base URL、端口、Dataset 名称均为实测值；无任何猜测地址 |

### 3.3 Phase 1/2 边界说明（避免范围漂移）

- Phase 1 **不做**：RAGFlow 调用、真实 `content_ref`、检索、LightRAG。资产/作品的内容暂存业务库（或临时表），但接口形状必须已含 `contentRef`。
- Phase 2 **不做**：LightRAG 图谱、四阶段完整 UI、导入功能（导入放 Phase 2 后半或 Phase 4，需在 02_PHASES 明确）。
- 两阶段都**不做**：多用户隔离、RBAC、分享、评估。

### 3.4 需要用户确认的 6 项（附建议默认值）

| # | 待确认 | 建议默认值 | 不确认的后果 |
|---|---|---|---|
| ① | **RAGFlow 用单 Dataset 还是内外库两个 Dataset？** | **单 Dataset** + 业务侧 `library` 过滤 | 决定了「迁移到内库」是否要搬文档；改主意等于重做 Phase 2 |
| ② | **资产要不要 `status`？** | **不要**，只用 `library` + `archived` | 数据模型要返工；UI 多一列永远填不对 |
| ③ | **内库作品是否保持只读？** | **保持只读**（继承旧规则），要改先降级到外库 | 影响所有编辑接口的权限判断 |
| ④ | **资产是否允许内→外降级？** | **允许**，需填理由 + 留痕 + 30 天可撤销 | 旧项目允许但无痕，新项目禁止会让用户无法纠错 |
| ⑤ | **导入能力放哪个阶段？** | **Phase 2 后半**（先有内容底座，再有入口） | 不放进去，用户没有把内容送进 RAGFlow 的路径 |
| ⑥ | **作品 `format` 六值是否全保留？** | **全保留**（article/script/course/live/consult/flomo） | 少一个后补要迁移；多一个成本几乎为零 |

---

## 4. 给文档同事的变更清单（本文件不改 docs）

| 文件 | 需要补/改什么 | 依据 |
|---|---|---|
| `00_SCOPE.md` | 「保留并重新定义」补 4 条：作品 `format`、作品→转资产、手写优先排序、导入能力；「砍掉」旁注「评估字段保留」 | 1.4-①②③⑤⑨ |
| `00_SCOPE.md` | 「资产」条目删除 `status` 表述（若采纳 3.4-②） | 1.5-① |
| `01_ARCHITECTURE.md` | 数据关系图补 `format`、`source`、`archived`、`library_changed_at`；补「单 Dataset」原则 | 2.4-③、3.4-① |
| `03_DECISIONS.md` | 新增 **ADR-007 RAGFlow Dataset 粒度**；新增 **ADR-008 内库外库定义与迁移规则**（可直接引本文件第 2 节） | 2.4、3.4-① |
| `02_PHASES.md` | Phase 2 完成标准由「Dataset/Document、解析与检索」细化为本文件 3.2 的 CONT-01~18；标注导入归属 | 3.2 |
| `04_INTEGRATION.md` | 增加名词表（`inner/outer` → `internal/external`）；Dataset 名称定稿 | 2.6、1.4-⑫ |
| `docs/drafts/01_PHASE1_DESIGN.md` | 四阶段状态机补「外库不得 practiced」「内库只读」「降级留痕」三条；资产条目去掉 status | 2.5 |

---

## 附：本文件的判断依据（可复核）

- 代码：`src/types/{asset,work,knowledge,assessment,directory,ai}.ts`、`src/lib/{assets,workspace,directories,knowledge,search,flomo,cheat-import,docx,asset-share,assessment-run}.ts`、`src/app/{workspace,assets,knowledge,assessments,settings}/page.tsx`、`src/app/api/*`
- 规则文档：旧项目 `PRD.md`、`DOCUMENT_STATUS_FLOW.md`、`NEXT_STEPS.md`
- 真实数据：`vault/assets/{inner,outer}/*`、`vault/knowledge/{inner,outer}/*`、`vault/meta/*.json`
- 新项目锚点：`docs/00_SCOPE.md`、`01_ARCHITECTURE.md`、`02_PHASES.md`、`03_DECISIONS.md`、`04_INTEGRATION.md`、`docs/drafts/01_PHASE1_DESIGN.md`、`src/lib/metadata.ts`
