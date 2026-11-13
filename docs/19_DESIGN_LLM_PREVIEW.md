# 19. 大模型配置与内容预览 · 设计稿

- 版本：v1.0（2026-11-13）
- 状态：**已定稿，待实施**
- 关联：ADR-025「大模型供应商配置与凭据存储」、ADR-026「知识内容预览」（审查同步撰写）
- 依赖基线：`docs/13_DESIGN_V3.md`（§3 主题 token、§6 控件）、`docs/16_GRAPH_DESIGN.md`（§4.7 舞台口径）、`src/app/globals.css`（现行 token 与类）
- 范围：只出设计；不改代码、不改 token、不新增依赖与颜色

---

## 0. 范围与硬约束

本文件覆盖两个界面：

| 编号 | 界面 | 入口 | 主要问题 |
|---|---|---|---|
| A | 系统 → 大模型 | 左侧「系统」目录 · 运维组 | 本地 Ollama 7B 抽取太慢（实测 ~7 tok/s、300s 超时），需要管理员填外部 OpenAI 兼容服务的 Key |
| B | 作品 / 资产内容预览弹窗 | 列表点标题、详情页「预览」 | 解析完成后用户找不到正文在哪看 |

硬约束（逐条可验收）：

1. **颜色只来自 token**：新组件的 CSS 里不允许出现十六进制、`rgb()`、`hsl()` 字面量；阴影、背板、滚动条也走 token（沿用 `globals.css` 顶部注释的规则）。
2. **不新增主题变量**：现有 `--bg / --surface / --surface-2 / --surface-3 / --text-1~3 / --line* / --accent* / --ok|warn|info|danger-* / --dialog-backdrop / --shadow-* / --focus / --r-* / --sp-* / --fs-*` 已覆盖全部需求；不做「大模型页专用色」「预览页专用色」。
3. **四套主题逐一成立**：深空银河（默认，深色）、松林绿（浅）、暖沙（浅）、午夜蓝（深）。验收时四套都要截图核对，不允许「深色下能看、浅色下发灰」。
4. **不引组件库、不引图标库**：图标沿用 `src/components/icon.tsx` 现有集合（`settings / refresh / check / alert / download / x / file / edit / sparkles / clock / database`）。
5. **复用现有结构类**：`.panel`、`.panel-heading`、`.field`、`.field-label`、`.field-note`、`.text-input`、`.select`、`.textarea`、`.btn / .btn-primary / .btn-secondary / .btn-ghost / .btn-danger`、`.chip-button`、`.dialog / .dialog-sm / .dialog-head / .dialog-body / .dialog-actions`、`.badge`、`.admin-badge`、`.admin-kv`、`.admin-dot`、`.empty-state`、`.spinner`、`.toast`、`.skeleton`。
6. **新增的只有布局类**（见 §1.3），只写尺寸、间距、栅格、溢出，不写颜色。
7. **文案是中文、面向使用者**：不出现「API、endpoint、payload」这类只在工程内部使用的词；「API Key」按用户原话保留，但配一句解释。

---

## 1. 复用基线

### 1.1 四套主题的关键 token（现行值，实施时直接引用变量名）

| 用途 | token | 深空银河 `galaxy` | 松林绿 `pine` | 暖沙 `sand` | 午夜蓝 `midnight` |
|---|---|---|---|---|---|
| 页面底 | `--bg` | `#07060b` | `#eef1ec` | `#f5efe4` | `#0b1220` |
| 卡片 / 弹窗面 | `--surface` | `#0e0c13` | `#ffffff` | `#fffaf1` | `#111b2e` |
| 次级面（输入框、hover） | `--surface-2` | `#16131d` | `#f6f8f5` | `#f8f1e5` | `#16233a` |
| 三级面（预览舞台底、代码块） | `--surface-3` | `#1d1926` | `#eef3ef` | `#f3e9d8` | `#1b2a44` |
| 分隔线 | `--line` / `--line-soft` | `#2a2433` / `#1c1824` | `#dfe5e0` / `#ebefeb` | `#e4d8c6` / `#efe6d8` | `#263650` / `#1b2a42` |
| 正文 | `--text-1` | `#f3efe7` | `#17251f` | `#2e2419` | `#e6edf9` |
| 次要文字 | `--text-2` | `#c2b8ac` | `#4b5a52` | `#5c4c39` | `#aebdd4` |
| 辅助文字 | `--text-3` | `#93897e` | `#5f6e66` | `#6f5d48` | `#8fa0ba` |
| 强调（主按钮底） | `--accent` | `#e9c08a` | `#2f7657` | `#a45a2a` | `#2563eb` |
| 强调上的字 | `--accent-contrast` | `#17110a` | `#ffffff` | `#ffffff` | `#ffffff` |
| 强调文字（链接/选中） | `--accent-text` | `#e9c08a` | `#2f7657` | `#8a4a22` | `#7cb6ff` |
| 强调浅底 | `--accent-soft` | `#201a12` | `#e8f1eb` | `#f6e7d7` | `rgba(96,165,250,.14)` |
| 成功 | `--ok-bg` / `--ok-fg` | `#12211a` / `#8fd3ae` | `#e9f3ec` / `#35704f` | `#eef3e4` / `#4c6b2f` | `#10241c` / `#7fd6a8` |
| 提示 | `--warn-bg` / `--warn-fg` | `#241d12` / `#e5bc7c` | `#f7f1e6` / `#7a5d2b` | `#f8efd9` / `#7a5a1d` | `#241f12` / `#e2bd7d` |
| 信息 / 进行中 | `--info-bg` / `--info-fg` | `#141b26` / `#a3b7d9` | `#eef1f6` / `#4f6480` | `#eef1f2` / `#4f6470` | `#14203a` / `#a9c3ee` |
| 失败 | `--danger-bg` / `--danger-fg` | `#261315` / `#f0a193` | `#f9ebe8` / `#a13d30` | `#f9e8e2` / `#a13d30` | `#2a171b` / `#f87171` |
| 危险实心按钮 | `--danger-solid` / `--on-danger` | `#a8432f` / `#fff3ef` | `#a13d30` / `#ffffff` | `#a13d30` / `#ffffff` | `#b03a3a` / `#fff5f5` |
| 弹窗背板 | `--dialog-backdrop` | `rgba(3,2,6,.66)` | `rgba(18,33,27,.45)` | `rgba(51,38,26,.45)` | `rgba(3,8,18,.66)` |
| 弹窗阴影 | `--shadow-pop` | `0 24px 56px rgba(0,0,0,.55)` | `0 18px 40px rgba(23,37,31,.10)` | `0 18px 40px rgba(61,44,26,.12)` | `0 20px 50px rgba(0,0,0,.55)` |
| 焦点环 | `--focus-ring` | 暖金 16% | 松绿 16% | 陶土 16% | 蓝 20% |

> 上表是现行取值，实施时只写 `var(--token)`，不复制 hex。新增的对比度组合（表单控件底 `--surface-2` 上的 `--text-2`、`--surface-3` 舞台上的 `--text-3`）上线前用 `scripts/check-contrast.mjs` 补测，正文目标 ≥4.5:1、辅助信息 ≥3:1。

### 1.2 直接复用的现有类

| 现有类 | 用在哪 | 备注 |
|---|---|---|
| `.admin-workspace` / `.workspace-header` / `.admin-page-head` | A 页骨架 | 由 `AdminPageShell` 提供，不重写 |
| `.panel` / `.panel-heading` | A 页四张卡 | 标题统一 `h2`，说明 `p` |
| `.admin-kv` | A 页「当前生效」键值行 | `dl > div > dt + dd` |
| `.admin-badge.is-ok / .is-warn / .is-error` | 状态徽标 | 不新建状态色 |
| `.admin-dot.is-ok / .is-down` | 服务连通点 | 与系统状态页同款 |
| `.field` / `.field-label` / `.field-note` / `.field-head` | 表单 | 标签与说明的位置关系沿用 |
| `.text-input` / `.select` / `.textarea` | 输入 | 已有 hover / focus / `aria-invalid` 三态 |
| `.btn*` / `.icon-button` / `.chip-button` | 动作 | 主按钮一个视图只有一个 |
| `.dialog` / `.dialog-sm` / `.dialog-head` / `.dialog-body` / `.dialog-actions` | 确认框、预览框 | 原生 `<dialog>` + `showModal()`，焦点圈定与 Esc 由浏览器保证 |
| `.empty-state` / `.empty-icon` / `.empty-copy` / `.empty-action` | 空态 | 预览无内容、无配置都用它 |
| `.spinner` | 测试中、应用中、PDF 加载 | 深色主题已在 token 里处理轨道色 |
| `.toast` | 保存成功、应用成功 | 4.2s 自动消失 |
| `.skeleton` | 首屏加载 | A 页三卡骨架、预览文档骨架 |

### 1.3 新增类（只有布局，无颜色）

| 类 | 归属 | 职责 |
|---|---|---|
| `.llm-grid` | A | 单列栅格，`max-width: 880px`，`gap: var(--sp-6)` |
| `.llm-presets` | A | 5 个供应商卡的响应式栅格 |
| `.llm-preset` | A | 单个预设卡；选中态只改 `border-color: var(--accent-text)` + `background: var(--accent-soft)` |
| `.llm-key-row` | A | 密钥输入 + 「替换」按钮的 1fr / auto 两列 |
| `.panel-actions` | A | 卡片底部动作行：`display:flex; justify-content:flex-end; gap: var(--sp-2)` |
| `.llm-result` | A | 测试结果条，`display:flex; gap: var(--sp-2)`；配色只按 `is-ok / is-error / is-info` 套现有语义 token |
| `.llm-steps` | A | 应用进度步骤列表，左侧 20px 图标列 + 1fr 文案 |
| `.llm-diff` | A | 「数据库配置 ≠ 运行配置」提示条，`padding: var(--sp-3) var(--sp-4)`，底色 `--warn-bg` |
| `.dialog-preview` | B | 预览弹窗尺寸覆盖，见 §3.10 |
| `.preview-shell` | B | `display:grid; grid-template-rows:auto auto 1fr`，撑满弹窗 |
| `.preview-head` / `.preview-title-block` / `.preview-head-actions` | B | 头部三段 |
| `.preview-toolbar` / `.preview-file` | B | 文件切换条 |
| `.preview-body` / `.preview-stage` / `.preview-rail` | B | 文档区 + 右侧文件栏 |
| `.preview-doc` / `.preview-text` / `.preview-media` | B | 三种文档容器的宽度与滚动 |
| `.preview-banner` | B | 解析中 / 解析失败的顶部提示条 |
| `.preview-error` | B | 文档区错误态：`padding: var(--sp-10) var(--sp-6); text-align: center`，配色走 `--danger-bg / --danger-fg` |

这些类落在 `globals.css` 的同一区段（建议放在「管理后台」之后、「图谱」之前），命名与现有 `.admin-*` 一致。

---

## 2. A. 系统 → 大模型

### 2.1 入口与信息架构

- 位置：左侧二级目录「系统」→ **运维** 组，排在「系统状态」之后、「审计日志」之前；与「用户 / 角色」同为二级项，不新开分组。
- 路由：`/admin/llm`（页面路由）。后端接口仍是 `/api/settings/llm*`，两者不同根，页面上不展示接口路径。
- 可见性：`settings:read` 才渲染目录项（与 `AdminDirectory` 现有 `hasPermission` 写法一致）；`settings:write` 才可编辑。
- 直接访问无权限：复用 `AdminForbidden`，`area="大模型"`、`permission="settings:read"`，文案说明「大模型配置决定图谱抽取用哪个服务，只有管理员能看」。

目录前后对照：

```text
系统
├─ 概览      总览 / 全部内容
├─ 分类与标签 管理分类 / 管理标签
├─ 账号      用户 / 角色
└─ 运维      系统状态 / 大模型 / 审计日志   ← 新增「大模型」
```

图标沿用 `settings`（或 `sparkles`），16px，颜色 `--text-3`，active 时 `--text-1` + 左侧 2px 强调条（与现有 `dir-item.is-active` 完全一致，不新增样式）。

### 2.2 页面骨架与组件树

```text
AdminPageShell（kicker「系统 · 接入」/ title「大模型」）
└─ div.llm-grid
   ├─ section.panel                    ① 当前生效
   │  ├─ .panel-heading  h2「当前生效」 + 状态徽标
   │  ├─ .llm-diff（仅不一致时）
   │  └─ .admin-kv × 2 组：LightRAG 运行中 / 已保存待应用
   ├─ section.panel                    ② 模型服务
   │  ├─ .panel-heading  h2「模型服务」+ p「保存后不会立刻生效，需在下方应用并重启」
   │  ├─ .llm-presets（5 个 .llm-preset）
   │  ├─ 字段：服务地址 / 模型名 / API Key / 超时
   │  └─ .panel-actions：测试连接（次要）· 保存（主要）
   ├─ section.panel                    ③ 连接测试
   │  └─ .llm-result（最近一次结果，含时间）
   └─ section.panel                    ④ 应用到图谱抽取
      ├─ .panel-heading  h2「应用到图谱抽取」
      ├─ 影响说明（重启 60s 内不可用、失败自动回滚）
      └─ .llm-steps（应用后出现）+ 主按钮「应用并重启」
```

页面头右侧不放动作；所有主操作留在卡片内，避免「头上一排按钮 + 卡里一排按钮」的重复。

### 2.3 卡片 ① 当前生效

目的：回答「现在到底用哪个模型、这份配置从哪来」。

结构：两组 `.admin-kv`，中间用 `--line-soft` 分隔。

| 组 | 行 | 取值来源 |
|---|---|---|
| LightRAG 运行中 | 状态 / 供应商 / 模型 / 地址 / 超时 | `appliedToLightrag` + 应用成功时回写的运行配置 |
| 已保存（数据库） | 供应商 / 模型 / 地址 / 超时 / 密钥 / 更新时间 / 操作人 | `GET /api/settings/llm` |

- 状态徽标：`已应用`（`.admin-badge.is-ok`）/ `待应用`（`.is-warn`）/ `未配置`（中性 `.badge`）。
- 密钥行只显示 `sk-…8f3a` 或「未设置」，**任何位置都不出现明文**；旁边一句 `--fs-12 --text-3`「保存后不可查看，只能替换」。
- 两组不一致时，在组上方插 `.llm-diff`：左 `alert` 图标（`--warn-fg`），文案「数据库里的配置还没应用到 LightRAG，当前仍在使用上表的模型。」右侧「去应用」文字按钮滚动到卡片 ④。
- 数据库为空时整卡换成空态：`还未配置外部模型，当前使用本机 Ollama（deepseek-r1:7b）。` + 次要按钮「填入本机预设」。

### 2.4 卡片 ② 模型服务

#### 2.4.1 供应商预设

5 张卡，桌面 5 列（`repeat(5, minmax(0,1fr))`），≤1100px 3 列，≤700px 2 列，≤480px 1 列。每张卡：名称（`--fs-14 --fw-semibold`）+ 一行提示（`--fs-12 --text-3`）。

| 预设 | 服务地址默认值 | 模型默认值 | 密钥 | 提示 |
|---|---|---|---|---|
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` | 必填 | 标准 OpenAI 接口 |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` | 必填 | 国内直连，延迟低 |
| 通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` | 必填 | 走兼容模式 |
| 自定义（OpenAI 兼容） | 空 | 空 | 视服务而定 | 填服务商文档里的兼容地址 |
| 本机 Ollama | `http://127.0.0.1:11434/v1` | `deepseek-r1:7b` | 可空 | 免费但慢，约 7 字/秒 |

选中态：`border: 1px solid var(--accent-text)` + `background: var(--accent-soft)` + 左上角 `check` 图标 14px；未选中 `border: 1px solid var(--line)` + `background: var(--surface)`；hover 时边框 `--line-strong`。焦点态用全局 `:focus-visible` 的 `--focus` 描边，不额外写。

切换预设的字段行为（可解释、不覆盖用户输入）：

1. 选预设 → 只有当前 `baseUrl` / `model` **为空或仍等于上一个预设的默认值**时才替换；
2. 用户改过任一字段后，预设卡显示小字「已自定义」，再点别的预设只更新未改动的字段；
3. 选「本机 Ollama」时，地址允许 `http://`，其余预设地址校验要求 `https://`（本机 loopback 例外，与后端校验一致）。

#### 2.4.2 字段

| 字段 | 控件 | 占位 / 默认 | 说明（`.field-note`） | 校验（错误显示在字段下方，`aria-invalid`） |
|---|---|---|---|---|
| 服务地址 | `.text-input`，等宽 `--fs-13` | `https://api.deepseek.com/v1` | 「要带版本前缀，例如 `/v1`；只填到域名会 404。」 | 必填；`https://`，或 `http://127.0.0.1` / `http://localhost`；不以 `/` 结尾时自动去掉尾斜杠 |
| 模型名 | `.text-input`，等宽 | `deepseek-chat` | 「填服务商文档里的模型 id，不是显示名。」 | 必填；不含空格；≤100 字 |
| API Key | `type="password"`，等宽；右侧 `.btn-ghost`「替换」 | 未保存时为空 | 「只写不回显。保存后这里显示掩码。」 | 必填（本机预设可空）；≤200 字；首尾空格自动去掉 |
| 超时 | `.text-input` 数字 + 后缀「秒」（后缀用 `--text-3`，绝对定位在右内边距内） | `300` | 「本机 7B 建议 600 秒以上；外部服务 60–120 秒通常够。」 | 30–1800 的整数 |

已保存密钥的展示态：输入框替换为只读行——`sk-…8f3a`（`--fs-13`，等宽）+ `.admin-badge.is-ok`「已保存」+「替换」按钮。点「替换」后变回空密码框，光标自动落入，提示改为「输入新密钥后保存，旧密钥会被覆盖」。

保存按钮的禁用条件：无 `settings:write`、必填未过、或与上次保存值完全一致。测试中 / 应用中同样禁用。

#### 2.4.3 表单布局与间距

- 卡片内 `padding: var(--sp-5) var(--sp-6)`，字段之间 `gap: var(--sp-4)`。
- 标签在上（`--fs-13 --fw-semibold`），说明在标签右下方（`--fs-12 --text-3`），错误文案替换说明的位置（`--danger-fg`），避免布局跳动。
- 服务地址与模型名并排（≥900px 两列，1fr / 1fr，`gap: var(--sp-4)`），窄屏堆叠。
- 底部动作右对齐：`测试连接`（`.btn-secondary`）+ `保存`（`.btn-primary`），`gap: var(--sp-2)`。

### 2.5 卡片 ③ 连接测试

结果只在这里显示，**不用 toast**（toast 会消失，测试结果需要留在页面上对照）。

| 状态 | 视觉 | 文案 |
|---|---|---|
| 未测试 | `.llm-result` 中性底（`--surface-2`），`sparkles` 图标 `--text-3` | 「还没测试过。保存前建议先测一次。」 |
| 测试中 | `.spinner` 14px + 文案 | 「正在向 deepseek-chat 发一个最小请求…」按钮变 loading，禁用保存 |
| 成功 | `--ok-bg` / `--ok-fg`，`check` 图标 | 「连接成功 · 820ms · 模型返回了 8 个 token」；第二行 `--fs-12`「测的是当前表单里的值，未保存也会测。」 |
| 失败 · 401 | `--danger-bg` / `--danger-fg` | 「密钥被拒绝（401）。检查 Key 是否复制完整、是否属于这个服务。」 |
| 失败 · 404 | 同上 | 「地址或模型名不对（404）。确认服务地址带 `/v1`，模型 id 与服务商一致。」 |
| 失败 · 超时 | 同上 | 「等了 60 秒没有响应。换外部服务，或把超时调大后重试。」 |
| 失败 · 网络 | 同上 | 「连不上这个地址。若填的是本机地址，确认 Ollama 已启动。」 |

- 结果条 `role="status" aria-live="polite"`，失败时 `role="alert"`。
- 结果里永远不回显密钥；错误原文若包含请求头，前端只显示服务端给的 `message`。
- 每次结果带时间戳（`--fs-12 --text-3`），例如「12:41 测过」。

### 2.6 卡片 ④ 应用并重启

#### 2.6.1 说明与确认

卡片正文（`--fs-13 --text-2`）：

> 应用会把当前保存的配置写入 LightRAG 的 `.env` 并重启抽取服务。
> 重启期间图谱抽取不可用，通常 10–30 秒，最长等 60 秒；正在抽取的内容会中断，需要重新抽取。
> 失败会自动回滚到原来的配置。

主按钮「应用并重启」（`.btn-primary`），仅在「已保存的配置 ≠ 运行中的配置」时可用；否则禁用并显示「已经是最新配置」。

点击后弹 `.dialog dialog-sm` 确认框：

- 标题：「应用并重启 LightRAG？」
- 正文：三条影响（抽取暂停 ≤60s / 在途任务中断 / 失败自动回滚），外加当前要应用的一行摘要：`DeepSeek · deepseek-chat · 超时 300 秒`。
- 按钮：`取消`（`.btn-ghost`）、`应用并重启`（`.btn-primary`）。
- 确认框关闭前不开始请求；请求开始后确认框关闭，进度显示在卡片内。

#### 2.6.2 进度步骤

`.llm-steps`，每步：图标列 20px（待执行 `circle` 空心 `--text-3`；进行中 `.spinner` 12px；完成 `check` `--ok-fg`；失败 `alert` `--danger-fg`）+ 主文案 + 次要说明。

| # | 步骤 | 进行中文案 | 完成文案 |
|---|---|---|---|
| 1 | 校验配置 | 校验配置… | 配置校验通过 |
| 2 | 备份原配置 | 备份 `.env`… | 原配置已备份 |
| 3 | 写入配置 | 写入新配置… | 已写入 |
| 4 | 重启抽取服务 | 正在重启 lightrag-server… | 服务已重启 |
| 5 | 等待就绪 | 等待服务就绪（≤60 秒）… | 服务就绪 · 共用 12 秒 |

- 失败时当前步变红，后面步骤保持待执行；卡片底部出现 `.llm-result` 失败条：
  - 已回滚：「应用失败：<原因>。已回滚到原配置，LightRAG 仍按原模型运行。」+「重新尝试」
  - 回滚也失败（危险，需人工）：「应用失败且回滚未完成。请检查 `infra/lightrag/.env` 后手动重启服务。」+ 显示备份文件路径（等宽、可选中、不展示密钥）
- 应用成功：`toast`「已应用，图谱抽取将使用新模型」+ 卡片 ① 刷新为「已应用」。
- 应用期间禁用整张表单（`fieldset[disabled]`），防止改了表单却不知道应用了哪一版。

### 2.7 A 页状态矩阵

| 场景 | 页面表现 | 主按钮 | 辅助提示 |
|---|---|---|---|
| 无 `settings:read` | `AdminForbidden` 整页 | — | 说明缺哪个权限 |
| 有 read 无 write | 表单全部 disabled，顶部 `.llm-result` 中性条 | 禁用 | 「只读：你没有修改大模型配置的权限。」 |
| 首次进入、未配置 | 卡片 ① 空态；表单预填「本机 Ollama」 | 「保存」可用 | 空态按钮「填入本机预设」 |
| 读取失败（500） | 页面级错误卡（复用 `.graph-state-card.is-error` 的版式，颜色走 `--danger-*`） | 「重试」 | 显示服务端 `message` |
| 保存中 | 按钮 loading，字段只读 | 禁用 | — |
| 保存成功 | toast + 卡片 ① 更新时间变化 + 徽标「待应用」 | 恢复 | — |
| 密钥未改 | 掩码行 + 「替换」 | 保存禁用（无改动） | — |
| 应用失败已回滚 | 步骤停在失败步 + 失败条 | 「重新尝试」 | 原配置仍生效 |
| 403（接口） | 页面顶部错误条，保留已读数据 | 禁用 | 「登录状态变了，刷新页面重新登录。」 |

### 2.8 A 页文案清单（直接可用）

- 页面说明：「图谱的实体抽取由这里配置的模型完成。本机模型免费但慢；换成外部服务后，同样的内容通常几十秒抽完。」
- 卡片 ② 说明：「保存只改数据库，不会立刻影响正在跑的抽取。确认无误后再点『应用并重启』。」
- 密钥说明：「只写不回显。保存后这里只显示掩码，忘了就替换一把新的。」
- 测试成功：「连接成功 · 820ms · 模型返回了 8 个 token」
- 应用确认：「抽取服务会重启，通常 10–30 秒；正在抽取的内容会中断。」
- 应用成功 toast：「已应用，图谱抽取将使用新模型」
- 回滚提示：「已回滚到原配置，LightRAG 仍按原模型运行。」

### 2.9 A 页响应式

| 断点 | 变化 |
|---|---|
| ≥1100px | 页面 `max-width: 880px`；预设 5 列；地址/模型两列 |
| 900–1099 | 预设 3 列；地址/模型两列保留 |
| 700–899 | 预设 2 列；地址/模型堆叠；卡片 padding 降为 `var(--sp-4) var(--sp-5)` |
| ≤560 | 预设 1 列；按钮整行（`width:100%`，纵向 `gap: var(--sp-2)`）；键值行 `dt` 在上、`dd` 在下 |

### 2.10 A 页四主题核对

| 检查点 | 深空银河 | 松林绿 | 暖沙 | 午夜蓝 |
|---|---|---|---|---|
| 卡片面与页面底有层次（不糊成一片） | `#0e0c13` on `#07060b` ✓ | `#fff` on `#eef1ec` ✓ | `#fffaf1` on `#f5efe4` ✓ | `#111b2e` on `#0b1220` ✓ |
| 预设选中态可辨（不只靠颜色） | 边框 + 浅底 + check 图标 | 同 | 同 | 同 |
| 输入框底与卡片面可辨 | `--surface-2` 深于卡片 ✓ | `#f6f8f5` 浅于白卡 ✓ | `#f8f1e5` ✓ | `#16233a` ✓ |
| 成功/失败条不刺眼 | 深底浅字 ✓ | 浅底深字 ✓ | 浅底深字 ✓ | 深底浅字 ✓ |
| 主按钮文字对比 | 深字 on 暖金 ✓ | 白字 on 松绿 ✓ | 白字 on 陶土 ✓ | 白字 on 蓝 ✓ |
| 进度步骤 4 态可区分 | 图标形状 + 颜色双编码 | 同 | 同 | 同 |
| 焦点可见 | `--focus` 2px ✓ | ✓ | ✓ | ✓ |

### 2.11 A 页验收清单

- [ ] 目录项只在有 `settings:read` 时出现；直接访问 `/admin/llm` 的普通用户看到 403 页而不是空白。
- [ ] 5 个预设切换时按 §2.4.1 的字段规则填充，不覆盖已手改的值。
- [ ] 密钥输入 `type="password"`，保存后页面任何位置都取不到明文（含 DOM、网络响应、toast）。
- [ ] 测试连接四类失败各有可执行建议，不显示原始请求头。
- [ ] 应用进度 5 步状态正确；失败时明确写出「已回滚 / 回滚失败」。
- [ ] 四套主题截图各一张（1440 宽），无裸色值、无低对比文字。
- [ ] 900px 与 390px 宽无横向滚动；按钮不换行截断。

---

## 3. B. 作品 / 资产内容预览弹窗

### 3.1 入口与触发

| 入口 | 行为 |
|---|---|
| 列表（`record-list`）点标题 | 打开预览弹窗，不离开列表；地址栏加 `?preview=<objectId>` |
| 详情页（`/workspace/[id]`）头部「预览」按钮 | 打开同一弹窗，初始选中主内容 |
| 搜索结果的标题 | 与列表一致（同一组件） |
| 弹窗内「打开详情」 | 跳 `/workspace/<id>`，弹窗关闭 |

- 标题仍是 `<a href="/workspace/<id>">`：`Cmd/Ctrl/中键` 照常在新标签打开详情；普通单击由 JS 拦截改为开弹窗（渐进增强，禁用 JS 时仍能进详情）。
- 弹窗地址参数：`?preview=<objectId>&file=<refId>`。打开 `pushState`，关闭时若是自己压入的历史则 `history.back()`，否则 `replaceState` 清掉参数；刷新可恢复同一弹窗与文件。

### 3.2 组件树与布局

```text
<dialog class="dialog dialog-preview" aria-labelledby="preview-title">
└─ .preview-shell
   ├─ header.preview-head
   │  ├─ .preview-title-block
   │  │  ├─ span.object-type-icon（复用列表类型点）
   │  │  ├─ h2#preview-title（单行省略）
   │  │  └─ p（类型 · 库别 · 更新时间 · N 个文件）
   │  └─ .preview-head-actions
   │     ├─ 下载（.btn-ghost + download 图标）
   │     ├─ 打开详情（.btn-secondary）
   │     └─ 关闭（.icon-button + x，aria-label「关闭预览」）
   ├─ .preview-toolbar（文件 >1 或需展示解析状态时出现）
   │  ├─ .preview-file × N（主内容 / 附件名 + 状态点）
   │  └─ 右侧：文件大小 / 解析状态
   ├─ .preview-banner（解析中 / 解析失败时出现，否则不占位）
   └─ .preview-body
      ├─ .preview-stage
      │  ├─ iframe.preview-doc（PDF）
      │  ├─ img.preview-media（图片）
      │  ├─ .preview-doc.markdown-body（Markdown）
      │  ├─ pre.preview-text（纯文本 / CSV / JSON）
      │  ├─ .empty-state（无内容）
      │  └─ .preview-error（预览失败）
      └─ aside.preview-rail（≥1200px 才显示）
         └─ 文件列表 + 每个文件的解析状态 / 大小 / 上传时间 / 下载
```

桌面（≥1200px）：弹窗 `min(1120px, 100vw-48px)` × `min(880px, 100vh-64px)`；`grid-template-columns: minmax(0,1fr) 264px`。
900–1199px：右侧文件栏收起，文件切换只在工具条。
≤560px：全屏，见 §3.10。

### 3.3 头部

- 高度 64px，`padding: var(--sp-3) var(--sp-6)`，下边框 `--line-soft`。
- 标题 `--fs-16 --fw-semibold --text-1`，`max-width: 46ch`，单行省略；`title` 属性放全名。
- 元信息 `--fs-12 --text-3`，用 `·` 分隔；归档对象额外一个 `.badge.badge-archived`「已归档」。
- 「下载」下载当前选中的文件（不是全部）；附件多时按钮文案仍是「下载」，`title="下载 <文件名>"`。
- 「打开详情」是唯一的导航出口，放右侧倒数第二，视觉上比「下载」重一档。

### 3.4 文件切换

- 工具条高度 48px，`padding: 0 var(--sp-6)`，`gap: var(--sp-2)`，下边框 `--line-soft`；溢出时横向滚动（隐藏滚动条视觉，保留键盘可达），不做「更多」菜单。
- 单个文件项 `.preview-file`：`height: 32px; padding: 0 var(--sp-3); border-radius: var(--r-pill); font-size: var(--fs-12)`。
  - 默认：透明底、`--text-2`、hover `--surface-2`。
  - 选中：`--accent-soft` 底、`--accent-text` 字、1px `--accent-text` 边框。
  - 状态点 6px：已解析 `--ok-fg`、解析中 `--info-fg`、失败 `--danger-fg`、待解析 `--warn-fg`（与 `parseStatusTones` 一致）。
- 主内容固定排第一，标签「主内容」；附件按上传时间升序。
- 只有一个文件时不显示工具条，但解析状态在头部元信息右侧以 `.admin-badge` 呈现。

### 3.5 文档区渲染分支

| 文件类型判断 | 渲染 | 说明 |
|---|---|---|
| `mime === "application/pdf"` 或 `.pdf` | `<iframe src="/api/objects/<id>/content/<refId>?inline=1">`，高 100% | 依赖 ADR-026 的 `?inline=1`；未就绪时先显示加载骨架，若响应仍是 `attachment` 则降级为文件卡 |
| `mime.startsWith("image/")` | `<img>`，`max-width:100%; max-height:100%; object-fit:contain` | 舞台底 `--surface-3`，图片自带白底也不刺眼；`alt` 用文件名 |
| `.md` / `text/markdown` | 取文本 → 现有 `MarkdownPreview` | 复用 `lib/markdown` 的安全渲染，不新增解析器 |
| `text/plain`、`.txt` / `.csv` / `.json` | `<pre class="preview-text">`，等宽、`white-space: pre-wrap`、`word-break: break-word` | 行高 `--lh-body`，字号 `--fs-13` |
| 其他（docx / zip / 音视频） | 文件卡：类型图标 + 文件名 + 大小 + 「下载原文」 | 明确写「这类文件不能在页面里直接看」 |

文本类上限：`sizeBytes > 512 KB` 时只取前 512 KB 渲染，底部一行 `--fs-12 --text-3`「文件较大，预览已截断（显示前 512 KB）」+「下载全文」。不预加载全文是 ADR-026 的性能边界。

### 3.6 解析状态与失败原因

工具条下方 `.preview-banner`（`padding: var(--sp-2) var(--sp-6)`，`--fs-12`）：

| 状态 | 视觉 | 文案 |
|---|---|---|
| 已解析 | 不出现（只在文件项显示绿点） | — |
| 待解析 / 解析中 | `--info-bg` / `--info-fg` + `.spinner` 12px | 「正在解析，完成后可在检索与图谱里找到。正文现在也能看。」 |
| 解析失败 | `--danger-bg` / `--danger-fg` + `alert` 图标 | 「解析失败：<parseError 可读文案>」+ 右侧「打开详情」文字按钮 |

- 失败原因与图谱页共用同一套可读映射（超时 / 服务未就绪 / 文件不受支持 / 未返回原因），原始错误只作为第二行小字，最多两行省略。
- 解析状态自动刷新：弹窗打开时若存在 `pending / running`，每 5 秒刷新一次详情数据，最多 60 次（与 `ObjectContent` 现有节奏一致），关闭弹窗即停止。

### 3.7 空态与错误态

| 场景 | 视觉 | 文案与动作 |
|---|---|---|
| 对象没有任何内容文件 | `.empty-state`，`file` 图标 | 标题「这个作品还没有内容文件」；说明「上传原文后，这里会直接显示正文。」；主按钮「去详情上传」→ `/workspace/<id>` |
| 内容文件被删除 / 404 | `.preview-error`（`--danger-bg` 底、`--danger-fg` 字） | 「这个文件已经不在内容库里了。」+「重新加载」+「打开详情」 |
| 文本读取失败 | 同上 | 「正文读取失败：<原因>」+「下载原文」保底 |
| 浏览器不支持内嵌 PDF | 舞台中央文件卡 | 「这个浏览器不能内嵌 PDF。」+「下载后用本地阅读器打开」 |

空态与错误态都保留头部和工具条，用户能直接换文件或下载，不用先关弹窗。

### 3.8 状态矩阵（B 页）

| 场景 | 头部 | 工具条 | 文档区 | 可用动作 |
|---|---|---|---|---|
| 打开瞬间（对象数据未到） | 标题 2 条骨架 | 隐藏 | 6 行文本骨架 | 关闭 |
| 正常 · 单文件 | 标题 + 元信息 + 解析徽标 | 隐藏 | 按 §3.5 渲染 | 下载 / 打开详情 / 关闭 |
| 正常 · 多文件 | 同上 | N 个文件项 + 状态点 | 当前文件 | 切换 / 下载 / 打开详情 / 关闭 |
| PDF 加载中 | 同上 | 同上 | 舞台内 `.spinner` + 「正在载入 PDF…」 | 关闭（加载完自动显示） |
| 解析中 / 待解析 | 元信息 + info 徽标 | info 状态点 | banner + 正文照常可看 | 同正常；每 5s 刷新状态 |
| 解析失败 | 元信息 + danger 徽标 | danger 状态点 | banner + 正文照常可看 | 打开详情 / 下载 / 关闭 |
| 无内容文件 | 标题 + 「0 个文件」 | 隐藏 | 空态 | 去详情上传 / 关闭 |
| 文件已被删除（404） | 标题 | 该文件标 danger | 错误态 | 重新加载 / 打开详情 |
| 文本读取失败 | 标题 | 正常 | 错误态 | 下载原文 / 重新加载 |
| 已归档对象 | 多一个「已归档」徽标 | 同正常 | 同正常 | 同正常（不放「下一步」类动作） |
| 窄屏 ≤560 | 标题单行省略，动作收成图标 | 横向滚动 | 全屏 | 关闭（40×40） |

「加载中」不做假进度条；PDF 的加载由浏览器控制，页面只显示 spinner 与一句说明。

### 3.9 交互：键盘、焦点、滚动、URL

| 项 | 规则 |
|---|---|
| 打开 | `dialog.showModal()`；初始焦点落在「关闭」按钮；滚动锁定由模态对话框保证 |
| Esc | 关闭（原生 `cancel` 事件），焦点回到触发标题链接 |
| 遮罩点击 | **不关闭**（PDF 里拖选文本容易误触）；只有 X 与 Esc 关闭 |
| Tab | 原生焦点圈定在弹窗内；顺序：头部动作 → 工具条 → 文档区（若可聚焦）→ 右侧文件栏 |
| ← / → | 焦点在工具条或文档区时切换上一个 / 下一个文件；输入框内不拦截 |
| Home / End | 工具条内跳到第一个 / 最后一个文件 |
| 滚动 | 文档区独立滚动（`overflow:auto`）；头部与工具条固定；右侧文件栏独立滚动 |
| 关闭后 | 列表滚动位置保持；若 URL 参数是本次压入的，用 `history.back()` 关闭 |
| 后台刷新 | 解析状态轮询只更新状态点与 banner，不重挂 iframe（避免 PDF 重新加载、丢滚动位置） |

### 3.10 尺寸与 token

| 元素 | 尺寸 / token |
|---|---|
| 弹窗 | `width: min(1120px, calc(100vw - 48px))`；`height: min(880px, calc(100vh - 64px))`；`border-radius: var(--r-lg)`；`background: var(--surface)`；`box-shadow: var(--shadow-pop)`；`overflow: hidden` |
| 背板 | `--dialog-backdrop`（原生 `::backdrop`） |
| 头部 | 高 64px；`padding: var(--sp-3) var(--sp-6)`；`border-bottom: 1px solid var(--line-soft)` |
| 工具条 | 高 48px；`padding: 0 var(--sp-6)`；`border-bottom: 1px solid var(--line-soft)` |
| 舞台 | `padding: var(--sp-8)`；PDF/图片区域 `min-height: 320px`；底 `--surface-3`；圆角 `var(--r-md)` |
| Markdown 正文 | 最宽 760px 居中；`font-size: var(--fs-15)`；`line-height: var(--lh-body)`；标题间距 `var(--sp-4) / var(--sp-3)`；代码块底 `--surface-2`、边框 `--line-soft` |
| 纯文本 | `font-size: var(--fs-13)`；等宽字体沿用现有 mono 栈；`padding: var(--sp-5)` |
| 右侧栏 | 宽 264px；`padding: var(--sp-4)`；`border-left: 1px solid var(--line-soft)`；文件行高 44px |
| 底部留白 | 舞台下 `var(--sp-6)`，避免正文贴边 |
| 动效 | 复用 `.dialog[open]` 的 160ms 淡入 + 上移 6px；关闭不另做动画（原生直接移除） |

新增 CSS 只允许上述变量；`.dialog-preview` 覆盖 `.dialog` 的 `width / height / max-height`。

### 3.11 响应式

| 断点 | 变化 |
|---|---|
| ≥1200px | 两栏：舞台 + 264px 文件栏 |
| 900–1199 | 单栏；文件栏内容并入工具条（只显示文件名 + 状态点） |
| 561–899 | 弹窗 `width: calc(100vw - 32px)`；舞台 padding 降为 `var(--sp-5)`；头部动作只留「下载」+「关闭」，「打开详情」收进文件栏顶部 |
| ≤560 | **全屏**：`width:100vw; height:100dvh; max-height:100dvh; border-radius:0`；头部高 56px、`padding: 0 var(--sp-4)`；标题 `--fs-15`；工具条横向滚动、`padding: 0 var(--sp-4)`；舞台 `padding: var(--sp-3)`；PDF 用浏览器自带手势缩放；关闭按钮 40×40 触控区 |

窄屏不允许横向滚动；长文件名 `text-overflow: ellipsis`。

### 3.12 四主题核对

| 检查点 | 深空银河 | 松林绿 | 暖沙 | 午夜蓝 |
|---|---|---|---|---|
| 弹窗与背板的分层 | 深面 + 66% 黑背板 ✓ | 白面 + 45% 墨绿背板 ✓ | 奶白面 + 45% 棕背板 ✓ | 深蓝面 + 66% 背板 ✓ |
| 舞台底与弹窗面可辨 | `#1d1926` vs `#0e0c13` ✓ | `#eef3ef` vs `#fff` ✓ | `#f3e9d8` vs `#fffaf1` ✓ | `#1b2a44` vs `#111b2e` ✓ |
| 选中文件项 | 暖金浅底 + 暖金字 | 松绿浅底 + 深绿字 | 陶土浅底 + 深棕字 | 蓝浅底 + 亮蓝字 |
| Markdown 代码块 | `--surface-2` 底、`--line-soft` 边 ✓ | ✓ | ✓ | ✓ |
| 解析失败条 | 深红底浅红字 | 浅红底深红字 | 同 | 同 |
| 空态图标与文案 | `--text-3` + `--text-2` ✓ | ✓ | ✓ | ✓ |
| 滚动条 | `--scroll-thumb` ✓ | ✓ | ✓ | ✓ |
| 打印 / 选中文字 | 正文用 `--text-1`，选中底色走浏览器默认，不覆盖 | 同 | 同 | 同 |

**PDF 说明（必须写进实现注释）**：内嵌 PDF 用浏览器自带查看器，它的工具栏、加载背景、页面白底由浏览器决定，**不随站点主题变化**。深色主题下舞台是深色、PDF 纸面仍是白色，这是预期行为；不允许用 CSS 反色 / 滤镜把 PDF 变暗（会破坏图片与扫描件）。外壳、页头、工具条、文件栏仍按主题 token。

### 3.13 B 页文案清单

- 解析中：「正在解析，完成后可在检索与图谱里找到。正文现在也能看。」
- 解析失败：「解析失败：抽取服务超时（本地模型过慢）。」第二行原始错误小字。
- 无内容：「这个作品还没有内容文件」「上传原文后，这里会直接显示正文。」
- 已归档：「已归档」徽标；不额外写提示，详情页有完整说明。
- 截断：「文件较大，预览已截断（显示前 512 KB）」
- 文件不支持：「这类文件不能在页面里直接看，下载后用对应软件打开。」
- 下载按钮 `title`：「下载 <文件名>」
- 关闭按钮 `aria-label`：「关闭预览」
- 弹窗 `aria-labelledby` 指向标题，`aria-describedby` 指向元信息。

### 3.14 B 页验收清单

- [ ] 列表点标题开弹窗，地址栏出现 `?preview=`；刷新仍打开；浏览器后退关闭弹窗并回到列表原滚动位置。
- [ ] `Cmd/Ctrl+点击`标题在新标签打开详情（不触发弹窗）。
- [ ] PDF 在 `?inline=1` 下内嵌显示；不支持时给下载保底，无空白页。
- [ ] Markdown / 纯文本正常渲染，HTML 被当文本，不执行脚本；>512 KB 截断提示正确。
- [ ] 图片按比例缩放不变形；大图不撑破弹窗。
- [ ] 多附件切换保留各自滚动位置；解析状态点与 `parseStatus` 一致。
- [ ] 解析失败显示可读原因与「打开详情」；不承诺页内重试（重试在图谱页按失败对象做）。
- [ ] 无内容空态能一键去详情上传。
- [ ] Esc 关闭且焦点回到标题；遮罩点击不关闭；Tab 不跑出弹窗。
- [ ] 390px 宽全屏、无横向滚动、关闭按钮 ≥40px 触控区。
- [ ] 四套主题截图各一张（桌面 1440、移动 390），明暗都无「白块 / 黑块」突兀。

---

## 4. 依赖与实施顺序

| 顺序 | 项 | 依赖 | 谁做 |
|---|---|---|---|
| 1 | `GET/PUT /api/settings/llm`、`test`、`apply` | 主程 Coder（ADR-025） | 后端 |
| 2 | `/admin/llm` 页面 + 目录项 | 1 | 前端（按本稿 §2） |
| 3 | `?inline=1` 与 `Content-Disposition: inline` | 主程 Coder（ADR-026） | 后端 |
| 4 | 预览弹窗 + 列表标题接入 | 3 | 前端（按本稿 §3） |
| 5 | 四主题截图 + `check-contrast` 补测 | 2、4 | 设计 + 前端 |

接口字段（A 页消费，来自 ADR-025 草案）：
`provider / baseUrl / model / timeoutMs / hasKey / keyMasked / appliedToLightrag / updatedAt / updatedBy`；`PUT` 不返回明文；`apply` 返回逐步状态或最终结果。

预览字段（B 页消费，现有 `ContentRef`）：`role / documentName / mime / sizeBytes / parseStatus / parseError / updatedAt`。

---

## 5. 明暗一致性检查清单（上线前逐项打勾）

- [ ] 两页新增 CSS 中 `grep -nE '#[0-9a-fA-F]{3,8}|rgba?\(' src/app/globals.css` 在新增区段为空（只允许 `var(--token)`）。
- [ ] 四套主题各截 4 张：A 页（默认态 / 应用进度）、B 页（Markdown / 解析失败）。
- [ ] 所有正文文字对比度 ≥4.5:1，辅助信息 ≥3:1；`scripts/check-contrast.mjs` 覆盖新增的 `--surface-2` 与 `--surface-3` 组合。
- [ ] 状态不只靠颜色：成功 / 失败 / 进行中都有图标或文案。
- [ ] 焦点环在四套主题下都可见（`--focus`），不被 `overflow:hidden` 裁掉。
- [ ] 深色主题下 PDF 纸面保持白色（预期），页面不因此出现「闪白」以外的异常。
- [ ] 浅色主题（pine / sand）下弹窗阴影不脏（沿用 `--shadow-pop`），无黑色重影。
- [ ] 午夜蓝的强调色是蓝色，A 页主按钮、B 页选中文件项都跟蓝走，不残留暖金。
- [ ] 390px / 900px / 1440px 三档无横向滚动，按钮不截断。

---

## 6. 未决问题（实施前需确认）

1. `/admin/llm` 的路由名最终以 ADR-025 为准；若改为 `/admin/settings/llm`，本稿只换路径，视觉不变。
2. 预览是否支持音频 / 视频内嵌：本稿按「文件卡 + 下载」处理，若产品要内嵌播放器需另立 ADR（涉及 Range 与解码兼容）。
3. PDF 的 `Range` 请求是否可用以 RAGFlow 实测为准（ADR-026）；不可用时大 PDF 首屏慢，需在 stage 上显示加载骨架，不做假进度。
4. 应用并重启是管理员全局操作，多账号共用同一个 LightRAG 图库（ADR-025 风险项）：页面是否需要「其他人正在抽取」提醒，待产品确认；本稿保留了警告文案的位置。

---

## 附录：文件依据

| 依据 | 文件 |
|---|---|
| 主题 token 与四套主题 | `src/app/globals.css`（`:root`、`[data-theme="pine|sand|midnight"]`） |
| 后台骨架与目录 | `src/components/admin-shell.tsx`、`src/components/directory.tsx` |
| 弹窗基类 | `src/app/globals.css`（`.dialog`、`.dialog-head/body/actions`）、`src/components/create-object-dialog.tsx` |
| 表单与按钮 | `src/app/globals.css`（`.field`、`.text-input`、`.select`、`.textarea`、`.btn*`） |
| 解析状态与文案 | `src/lib/content-format.ts`（`parseStatusLabels`、`parseStatusTones`）、`src/domain/content-ref.ts` |
| 内容读取 | `src/app/api/objects/[id]/content/[refId]/route.ts`（当前为 `attachment`，需 `?inline=1`） |
| Markdown 渲染 | `src/components/markdown-preview.tsx`、`src/lib/markdown.ts` |
| 主题清单 | `src/lib/theme.ts`（`THEME_META`） |
| 图标 | `src/components/icon.tsx`（`settings / check / alert / download / x / file / refresh / sparkles`） |
