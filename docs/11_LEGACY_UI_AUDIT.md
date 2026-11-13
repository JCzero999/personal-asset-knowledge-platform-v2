# 旧项目前端设计审计（V1 → V2 可沿用清单）

> 审计对象：`D:\projects\Personal Asset & Knowledge Platform`（只读，未修改任何文件）
> 对照对象：`D:\projects\Personal Asset & Knowledge PlatformV2`
> 审计方式：逐文件阅读页面、组件与样式源码；本文所有结论均标注文件路径（必要时含行号），未在代码中找到的内容明确写「未找到」。
> 审计日期：2026-11-11
>
> **落地状态（2026-11-11 同日晚）**：建议一（正文编辑 + 预览）与建议三（列表 + 详情同屏）已落地为 ADR-013 三栏框架与 ADR-014 正文类型；命令面板（建议二）未做。文中提到的 V2 旧文件 `app-sidebar.tsx`、`workspace-shell.tsx` 已在落地时删除，改由 `nav-rail.tsx`、`directory.tsx`、`workspace-view.tsx` 承担；旧项目路径与行号仍是审计时的只读记录，保持原样。

---

## 1. 技术栈与前端目录结构

### 1.1 依赖与框架

| 项 | 取值 | 依据 |
|---|---|---|
| 框架 | Next.js `^15.5.4`，App Router，RSC | `package.json` |
| React | `^19.1.1` | `package.json` |
| 语言 | TypeScript `^5.9.2` | `package.json` |
| 样式 | Tailwind CSS v4（`@tailwindcss/postcss`）+ 手写全局 CSS | `package.json`、`src/app/globals.css:1` |
| 组件库约定 | shadcn 配置（new-york / neutral / cssVariables），但**没有安装 `src/components/ui` 目录**，实际没有使用 shadcn 组件 | `components.json`、`src/components/` 文件列表 |
| 图标 | `lucide-react` `^0.468.0` | `package.json`、`src/components/app-shell.tsx:3-18` |
| 主题 | `next-themes` `^0.4.6`，class 模式，跟随系统 | `src/app/layout.tsx:18`、`src/components/theme-toggle.tsx` |
| Markdown | `react-markdown` `^10.1.0` | `src/app/workspace/page.tsx:3`、`src/app/assets/page.tsx:18` |
| 导入解析 | `gray-matter`、`turndown`、`cheerio` | `package.json`、`src/lib/flomo.ts`、`src/lib/cheat-import.ts` |
| 加密分享 | `@zip.js/zip.js` | `package.json`、`src/lib/asset-share.ts` |
| 测试 | Vitest（只覆盖 lib/api，不含组件测试） | `package.json`、`vitest.config.ts` |

### 1.2 目录结构

```text
src/
├── app/                 # 6 个页面路由 + 12 组 API 路由
│   ├── layout.tsx       # 根布局：ThemeProvider + globals.css
│   ├── globals.css      # 2253 行：设计变量 + 全部布局/组件样式 + 断点
│   ├── page.tsx         # 重定向到 /workspace
│   ├── workspace/       # 工作区（1276 行客户端组件）
│   ├── assets/          # 资产库（1476 行客户端组件）
│   ├── knowledge/       # 知识图谱（10 行壳 + knowledge-view）
│   ├── assessments/     # 评估与复盘（445 行）
│   ├── settings/        # 设置整页（360 行）
│   ├── loading.tsx      # 全局加载态
│   └── error.tsx        # 全局错误边界
├── components/          # 12 个功能组件（无 ui/ 原子组件目录）
├── hooks/               # use-panel-resize.ts（面板拖拽）
├── lib/                 # 数据与格式化（含前端共用的 search/assessment 纯函数）
├── types/               # 7 个领域类型文件
└── styles/              # 空目录（.gitkeep）
```

**与 V2 的关键差异**：V1 是「Tailwind 工具类写页面内 + 全局 CSS 写复杂结构」的混合写法；V2 是「零 CSS 框架、全量 CSS 变量 + 类名」的写法（`src/app/globals.css` 的 `:root` 定义）。V1 的样式是最值得看的部分，但它直接照搬 Tailwind 依赖，不适合直接搬进 V2。

---

## 2. 页面清单

| 路由 | 文件 | 解决什么问题 | 布局要点 |
|---|---|---|---|
| `/` | `src/app/page.tsx` | 统一入口，直接 `redirect("/workspace")`，不让用户先做「选择」 | 无 UI |
| `/workspace` | `src/app/workspace/page.tsx` | 日常创作主战场：草稿、作品四阶段、外部导入、Markdown 编辑与预览 | 顶栏 + 一级图标栏 + 二级目录 + **三栏**：可拖拽列表（默认 300px）→ 详情/编辑器 → 右侧元数据（280px）；列表可收起为 30px 贴边窄条（`globals.css:2198-2229`） |
| `/assets` | `src/app/assets/page.tsx` | 可复用资产库：筛选、归档、批量归档、加密分享、手动编辑资产正文 | 与工作区同构：列表 270–330px + 详情；详情为「正文 1fr + 元数据 280px」网格（`globals.css:649-653, 966-972`）；列表头 sticky（`globals.css:661-668`） |
| `/knowledge` | `src/app/knowledge/page.tsx` → `src/components/knowledge-view.tsx` | 内库/外库知识关系图：节点悬停高亮、聚焦邻域、点击编辑节点类型与标签 | 内容区单个大卡片（`globals.css:1421-1426`），SVG `viewBox="0 0 900 620"` 放射布局（`knowledge-graph.tsx:35-50`） |
| `/assessments` | `src/app/assessments/page.tsx` | 评估与复盘：预测评分、概率分布条、Rubric 时间线、关联作品 | 单列 `max-w-6xl` 阅读流：状态卡片 → 评估卡片（`lg:grid-cols-[1fr_0.8fr]`）→ 时间线；概率用水平条（`assessments/page.tsx:242-256`） |
| `/settings` | `src/app/settings/page.tsx` | 目录同步、标签与分类管理 | `max-w-[920px]` 居中（`globals.css:1302-1306`）+ 卡片分区；与侧边设置抽屉功能重复（`settings-drawer.tsx`） |
| 全局加载 | `src/app/loading.tsx` | 路由级加载态 | 居中胶囊 + 旋转指示器，`aria-busy/aria-live/role=status` |
| 全局错误 | `src/app/error.tsx` | 渲染失败兜底 | 居中卡片 + 错误编号 + 「重试」按钮 |

> 未找到：登录页、注册页、账号页、管理后台页。V1 全仓库没有任何 auth/session 代码（`src/middleware.ts`、`src/proxy.ts` 均不存在；`grep 登录/账号/用户` 在页面与组件中无结果），身份是「本地单用户」。

---

## 3. 组件清单

| 组件 | 文件 | 职责 | 被哪些页面使用 |
|---|---|---|---|
| `AppShell` | `src/components/app-shell.tsx`（483 行） | 全局骨架：60px 顶栏（品牌/全局搜索/主题/模型/设置/新建菜单）、68px 一级图标栏、228px 二级目录、移动端抽屉导航、全局快捷键 | workspace、assets、assessments、settings、knowledge-view |
| `CommandPalette` | `src/components/command-palette.tsx` | `Ctrl/Cmd+K` 命令面板：静态命令 + 全站搜索（≥2 字、180ms 防抖）、↑↓/Enter/Esc、AND/OR/NOT 语法提示 | AppShell |
| `QuickCaptureDialog` | `src/components/quick-capture-dialog.tsx` | 快速捕捉：标题可空（取正文首行）、`Ctrl/Cmd+Enter` 保存、内容自动存 localStorage 防丢 | AppShell |
| `SettingsDrawer` | `src/components/settings-drawer.tsx` | 右侧 384px 设置抽屉：目录、标签、分类 | AppShell（与 `/settings` 页重复） |
| `AIModelDrawer` | `src/components/ai-model-drawer.tsx` | 大模型配置抽屉：厂商预设、密钥环境变量、启用状态 | AppShell |
| `ThemeToggle` | `src/components/theme-toggle.tsx` | 明暗切换，`mounted` 前渲染禁用占位避免水合闪烁 | AppShell |
| `WorkDetailDialog` | `src/components/work-detail-dialog.tsx` | 作品详情弹窗：正文 + 元数据 + 流转操作（实践、转资产、删草稿） | workspace |
| `AssessmentTrialRun` | `src/components/assessment-trial-run.tsx` | 试运行评估：选作品/模型、轮询运行状态（2s） | workspace、assessments |
| `AssetShareDialog` | `src/components/asset-share-dialog.tsx` | 加密 ZIP 分享：密码 + 确认 + 下载 | assets |
| `KnowledgeGraph` | `src/components/knowledge-graph.tsx` | SVG 放射关系图：悬停高亮/淡化、聚焦邻域、节点编辑弹窗、键盘可达 | knowledge-view |
| `KnowledgeView` | `src/components/knowledge-view.tsx` | 图谱数据加载与保存、`?library=` 切换 | knowledge 页 |
| `useDialogFocus` | `src/components/use-dialog-focus.ts` | 自定义弹层焦点陷阱：自动聚焦、Tab 循环、Esc 关闭、关闭后焦点归还 | AppShell、命令面板、快速捕捉、作品详情、图谱节点编辑、分享弹窗 |
| `usePanelResize` | `src/hooks/use-panel-resize.ts` | 三处拖拽：列表宽度 220–520px、简介高度 60–300px、正文高度 120–900px；localStorage 持久化 | workspace、assets |

**组件层面的可复用性判断**：`useDialogFocus`、`usePanelResize`、`CommandPalette`、`QuickCaptureDialog` 是纯逻辑 + 标记结构，搬到 V2 成本低；`AppShell` 与 V2 的 `AppSidebar` 结构差异大（V1 无品牌绿侧栏、无统计概览），只能借鉴信息架构，不能整段复制。

---

## 4. 设计变量（实际取值）

### 4.1 颜色（`src/app/globals.css:74-114`）

亮色 `:root`：

| 变量 | 值 | 用途 |
|---|---|---|
| `--background` | `#f8fafc` | 页面底色 |
| `--surface` | `#ffffff` | 卡片、侧栏 |
| `--foreground` | `#0f172a` | 主文字 |
| `--muted` | `#f1f5f9` | 悬停底、内嵌块 |
| `--border` | `#e2e8f0` | 1px 描边 |
| `--primary` | `#059669`（emerald-600） | 主色、焦点环、激活态 |

深色 `.dark`（`globals.css:95-114`）：背景 `#0b1220`、表面 `#101a2b`、文字 `#e2e8f0`、描边 `#273449`、主色提亮为 `#34d399`。整套 slate 色阶被重映射（`--slate-50`…`--slate-950`），因此页面里写死的 `text-slate-500` 在深色下自动翻转，这是 V1 深色模式能一次性切换的关键。

语义色：内库 `#10b981`/`#047857`，外库 `#f97316`/`#c2410c`，高优先级 `#f59e0b`/`#b45309`，危险 `#dc2626`，成功 `#047857`（`globals.css:856-900, 1392-1414`）。全部用 `color-mix()` 以 13–16% 混入表面色做底，避免刺眼。

### 4.2 字体与字号层级

- 字体：`Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`，正文 14px（`globals.css:129-133`）。
- 实际字号档位（按出现频率）：10px（徽标、日期、大写小标）、11px（辅助说明、元信息）、12px（次级按钮、表单）、13px（列表标题、导航）、15px（品牌名、面板标题）、2xl（详情标题 `text-2xl sm:text-3xl`，`workspace/page.tsx:1070`）。V1 **没有**统一的字号变量，10/11/12/13/14/15 混用，这也是 V2 当初收敛字号档位的原因（V2 `--fs-11`…`--fs-26`）。
- 字重：主文字 400，列表标题 650，按钮 600，数字统计 700（`globals.css:242-249, 708-721, 361-375`）。
- 大写小标：`font-size:10px; letter-spacing:0.11em; text-transform:uppercase`（`globals.css:556-564`），用于侧栏分组名与面板小标。

### 4.3 间距

不遵循严格网格，主要取值：`0.25 / 0.35 / 0.4 / 0.5 / 0.55 / 0.6 / 0.65 / 0.7 / 0.75 / 0.9 / 1 / 1.25 / 1.5rem`（`globals.css` 全篇）。列表行内边距 `0.7rem 0.6rem`，行高 66px（`globals.css:677-691`）；侧栏项高 36px、嵌套 32px（`572-598`）；顶栏 60px（`196-208`）。结论：**间距节奏可用，但取值过碎**，搬到 V2 应映射到现有 `--sp-1/2/3/4/5/6/8`。

### 4.4 圆角

代码中出现 5/6/7/8/9/10/11/12/14/999px 共 10 档（如 `button 7px` `370`、面板 `10px` `1315`、图谱卡 `11px` `1425`、弹窗 `12px` `1101`、移动端底部抽屉 `14px` `1994`、徽标 `999px` `848`）。这是 V1 明显的设计债，不建议沿用；V2 的 4 档（6/10/14/999）更干净。

### 4.5 阴影与描边

- 卡片：几乎不用阴影，靠 `1px var(--border)` 描边 + 白底（`globals.css:1312-1317`）。
- 弹层：`0 10px 30px #0f172a1a`（下拉，`438`）、`0 24px 80px #02061740`（命令面板，`1104`）、`12px 0 40px #02061725`（移动侧栏，`639`）。
- 分段控件选中：`0 1px 2px #0f172a14`（`333`）。
- 焦点：`outline: 2px solid var(--primary); outline-offset: 2px`（`182-189`）。

### 4.6 断点

`1150px`（收窄列表与元数据栏）、`900px`（隐藏二级目录、元数据沉底）、`680px`（顶栏两行、弹窗变底部抽屉、侧栏 52px）、`768px`（工作区双栏转单栏，`47-72`）、`901px`（拖拽与列表收起仅桌面，`2198-2229`）。

---

## 5. 布局与导航模式

### 5.1 三段式骨架（顶栏 + 一级栏 + 二级栏）

- 顶栏 `height:60px`，`grid-template-columns: 1fr minmax(360px,720px) 1fr`，搜索永远居中且宽度受限（`globals.css:196-208`）。
- 一级栏 68px 图标+10px 文字，垂直排列，`min-height:62px`；当前项用 10% 主色底 + 主色文字（`470-508`）。
- 二级栏 228px，折叠式：点一级栏展开当前模块的二级目录，再点一次收起；二级项激活时左侧 3px 主色竖条（`600-615`）。
- 内容区固定 `calc(100vh - 60px)`，页面内部自己滚动，不做整页滚动（`shell-content`，`621-624`）。移动端改为 52px 一级栏 + 抽屉导航（`626-647, 1926-1957`）。

**要点**：导航层级是「模块 → 目录 → 列表 → 详情」四层，一级栏常驻，二级栏按需出现，避免同时暴露五个入口。

### 5.2 列表 + 详情同屏（核心可借鉴点）

- 资产/工作区都是 `grid-template-columns: minmax(270px,330px) 1fr`（`649-653`），拖拽后可由内联宽度覆盖为 220–520px（`use-panel-resize.ts:47-61`）。
- 详情是「正文 + 280px 元数据栏」两列（`966-972`），元数据栏 `position:sticky`（`918-928`），编辑表单时变 240px 右栏（`942-951`）。
- 列表可一键收起，留 30px 贴边窄条用于展开（`2198-2229`）。
- 列表行 66px 两行布局：第一行「标题 + 尾部徽标」，第二行「标签/元信息 + 日期」（`677-721`）；选中行左侧 3px 主色条（`698-706`）。

### 5.3 表单与编辑

- 编辑器 = 顶部标题区 + 「主内容 1fr / 元数据 240px」：标题、简介、Markdown 正文 textarea、实时预览（`workspace/page.tsx:876-893`、`assets/page.tsx:1080-1107`）。
- 元数据栏字段统一 `min-height:34px`、12px 字、`--background` 底（`1012-1023`）；底部操作条 `position:sticky; bottom:-1.25rem`（`1025-1034`）。
- 输入行可拖拽高度（简介/正文各一根横向手柄，`2156-2173`），高度持久化（`use-panel-resize.ts:22-36`）。

### 5.4 反馈层级

- 页面级：顶部横幅（成功绿 / 失败红），`aria-live` 或 `role=alert`（`workspace/page.tsx:715-716`）。
- 空状态：图标 + 一句解释 + 主/次按钮（`workspace/page.tsx:759-783`），图谱空状态单独写文案（`globals.css:1555-1573`）。
- 加载：列表骨架 `animate-pulse` 三行（`workspace/page.tsx:660`）、图谱整块骨架（`knowledge-view.tsx:66-70`）、路由级 loading.tsx。

---

## 6. 交互与动效

| 交互 | 做法 | 依据 |
|---|---|---|
| 全局搜索 | 顶栏输入框点击或键入即打开命令面板；`Ctrl/Cmd+K` 打开；面板内 180ms 防抖、≥2 字符才请求；↑↓ 选择、Enter 打开、Esc 关闭 | `app-shell.tsx:123-142, 290-308`、`command-palette.tsx:99-148, 176-196` |
| 搜索语法 | 支持 `'关键词' AND '关键词' | OR | NOT`，页脚常驻语法提示 | `command-palette.tsx:227-232` |
| 快速捕捉 | `Ctrl+Shift+Space`；标题留空自动取正文首行；`Ctrl/Cmd+Enter` 保存；内容写 localStorage 防丢 | `quick-capture-dialog.tsx:31-38, 42-80, 112-117` |
| 导航手风琴 | 一级栏展开/收起二级栏；二级项点击时联动第三级列表收起；当前一级项再点一次收起 | `app-shell.tsx:146-159, 372-379` |
| 筛选 | 分类/格式/状态/排序四个下拉 + 标签 chip 多选（AND/OR 切换）+「清除筛选」文字按钮 + 批量选择模式 | `workspace/page.tsx:569-657` |
| 归档视图 | 列表标题切换为「资产归档」，提供返回按钮，归档行不显示编辑/移动操作 | `assets/page.tsx:525-561, 890` |
| 面板拖拽 | 鼠标/键盘可操作的分隔条（`role=separator`），拖动时给 body 加 `resize-dragging` 禁选中，尺寸存 localStorage | `use-panel-resize.ts`、`globals.css:2135-2184` |
| 弹层规范 | 遮罩点击关闭、`aria-modal`、首个可聚焦元素自动聚焦、Tab 循环、Esc 关闭、关闭后焦点归还 | `use-dialog-focus.ts:13-61` |
| 移动端弹层 | ≤680px 时弹窗变底部抽屉（圆角 14px 14px 0 0，`padding-bottom: env(safe-area-inset-bottom)`） | `globals.css:1983-1996` |
| 动效 | 只用 150ms 级别的透明度/描边过渡（图谱边 `1462-1467`、节点 `1479-1493`）；全局 `prefers-reduced-motion` 时全部关到 0.01ms | `globals.css:2124-2133` |
| 状态轮询 | 试运行记录每 2 秒刷新 | `assessment-trial-run.tsx:11` |
| 快捷键 | `Ctrl+K`、`Ctrl+Shift+Space`、`Ctrl/Cmd+Enter`（捕捉保存） | 见上 |

**未发现**：Toast 通知系统（全部是页内横幅）、骨架以外的动画库、路由切换过渡动画。

---

## 7. 与 V2 的对照表

| 能力 | 旧项目做法（文件） | V2 现状 | 建议 | 工作量 |
|---|---|---|---|---|
| 命令面板 + 全局搜索 | `command-palette.tsx`（静态命令 + 关键词 AND/OR/NOT + ↑↓ 选择） | 无命令面板；`/search` 是语义检索页（`src/app/search/page.tsx`、`search-form.tsx`） | **改造后沿用**：V2 的检索是「一次提交」，可加一个 `Ctrl+K` 浮层复用语义检索接口，命令部分只放「新建 / 工作台 / 检索 / 图谱 / 退出」 | M |
| 快速捕捉 | `quick-capture-dialog.tsx` + `AppShell` 新建菜单 | 只有 `create-object-dialog.tsx` 的完整新建表单 | **沿用**：加一个「一句话捕捉」轻量入口，减少新建摩擦 | S |
| 明暗主题 | `next-themes` + `.dark` 全套变量重映射（`globals.css:95-114`） | 只有亮色 `:root` token，无 `.dark`（`src/app/globals.css:1-100`） | **改造后沿用**：V2 已有变量层，补一份深色 token 即可；但 V2 深绿侧栏与米白底本身是品牌语言，深色需重新调，不要直接套 V1 的 slate 翻转 | M |
| 三栏可调布局 | `use-panel-resize.ts` + 列表收起窄条 | 工作台单列 + 详情独立页（`src/app/workspace/[id]/page.tsx`）；无拖拽 | **改造后沿用**：把「列表 ↔ 详情」做成同屏分栏，拖动与收起机制可直接借 | M |
| 列表 + 详情同屏 | `asset-workspace` 网格 + sticky 列表头 + 选中竖条（`globals.css:649-721`） | 列表与详情分两个路由，来回跳转丢上下文 | **沿用**（结合上一条）：这是旧项目体验最好的部分 | M |
| 手动编辑正文 + 实时预览 | textarea（等宽、可调高）+ `react-markdown` 预览（`assets/page.tsx:1080-1107`） | `object-content.tsx` 只有上传/下载/解析状态，**没有手动编辑** | **沿用**：正好对应「资产内容支持手动编辑」；V2 无 React Markdown 依赖，需新增或改用纯文本编辑器 | M |
| 标签多选筛选（AND/OR） | `workspace/page.tsx:615-639` 的 chip 行 + 模式切换 | `object-filters.tsx` 只有类型/库别/状态/排序，无标签筛选 | **改造后沿用**：V2 后端需支持按标签过滤（当前接口无此参数） | M |
| 批量操作 | 资产页批量归档、批量加密分享（`assets/page.tsx:665-702`） | 行内单条操作（`object-actions.tsx`） | **改造后沿用**：先做批量归档，分享属第二阶段 | M |
| 加密 ZIP 分享 | `asset-share-dialog.tsx` + `lib/asset-share.ts` | 无 | **不适用（暂缓）**：依赖 V1 的本地文件模型；V2 内容在 RAGFlow，需另设计 | L |
| 知识图谱交互 | 悬停高亮邻边、其余淡化、聚焦模式、节点编辑弹窗（`knowledge-graph.tsx`） | `graph-explorer.tsx` 已有实体列表 + 邻域 SVG + 问答 + 同步 | **部分已有，借交互细节**：悬停淡化与「退出聚焦」按钮值得补 | S |
| 评估与复盘 | `assessments/page.tsx` + `assessment-trial-run.tsx` | 无 | **不适用（V2 范围外）** | L |
| 设置面板 | `settings-drawer.tsx`（右侧抽屉）+ `/settings` 整页（重复） | 无设置入口 | **改造后沿用**：只保留抽屉一种形态，标签/分类管理可后置 | M |
| 空状态 / 骨架 / 错误边界 | 每页空状态 + 骨架屏 + `app/error.tsx` + `app/loading.tsx` | `workspace-shell.tsx` 三种空状态 + `workspace/loading.tsx`、`workspace/error.tsx`，**检索页无独立空状态样式** | **已具备，补检索页** | S |
| 焦点管理与快捷键 | `use-dialog-focus.ts` + skip-link + 全局快捷键 | 新建弹窗用原生 `<dialog showModal>`（自带焦点陷阱），无 skip-link、无全局快捷键 | **改造后沿用**：补 skip-link 与 `Ctrl+K`；弹窗继续用原生 dialog，不需要 V1 的 hook | S |
| 排版密度与字号 | 10/11/12/13px 混用，信息密度高 | 变量化 11–26px，行高 1.5/1.75，留白更大 | **不适用**：V1 的密度偏挤，V2 版式更稳；只借鉴「列表行两行结构 + 右侧日期」 | — |
| 圆角/阴影系统 | 10 档圆角、弹层大阴影 | 4 档圆角 + 极轻阴影 | **不适用**：V2 系统更干净 | — |
| 登录 / 退出 / 管理后台 | **未找到**：无 auth、无 session、无账号页、无角色 | 侧栏底部有退出登录（仅 `AUTH_MODE=logto` 时渲染，`app-sidebar.tsx:92-102`）；无管理页、无角色概念（`schema.ts` 的 `role` 是内容引用角色） | **无参考**：旧项目不能提供方案，需产品与架构单独设计 | — |

---

## 8. 最值得先搬的三条建议

### 建议一：手动编辑正文 + 实时预览（直接解决「资产只能上传」）

- **搬什么**：`src/app/assets/page.tsx:1046-1107` 的 `AssetEditor` —— 标题、简介、可调高的等宽 Markdown textarea、下方实时预览；`src/hooks/use-panel-resize.ts` 的拖拽高度。
- **搬到 V2 哪里**：`src/app/workspace/[id]/page.tsx` 的 `ObjectContent` 区域（`src/components/object-content.tsx`），在上传区旁加「编辑正文」模式。
- **预期效果**：用户不必先有文件才能改内容；预览即时可见。V2 目前没有 Markdown 渲染依赖，最小实现可先用等宽 textarea + 「预览」切换（不引入依赖），与项目「不新增依赖」的约束兼容。

### 建议二：`Ctrl+K` 命令面板

- **搬什么**：`src/components/command-palette.tsx` 的整体交互（键盘上下选择、Enter/Esc、空状态、加载指示），以及 `app-shell.tsx:123-142` 的快捷键注册。
- **搬到 V2 哪里**：`src/components/app-sidebar.tsx` 所在骨架外挂一个浮层；面板内复用现有 `/search` 的语义检索接口，命令项用现有路由。
- **预期效果**：任何页面一键找内容或跳转，替代「先回工作台再找」；同时把「内容检索」从独立页变成随时可达的能力。

### 建议三：列表 + 详情同屏（可拖拽、可收起）

- **搬什么**：`globals.css:649-721` 的列表结构、`966-972` 的「正文 + 元数据」网格、`2198-2229` 的收起窄条、`use-panel-resize.ts` 的拖拽与持久化。
- **搬到 V2 哪里**：`/workspace` 页（`workspace-shell.tsx`）与 `/workspace/[id]` 详情页合并为同屏分栏；移动端仍回退到单列。
- **预期效果**：点一条看一条，不再整页跳转；列表宽度与收起状态被记住，长时间使用更顺手。

---

## 附：审计中发现、但未写入建议的已知问题

1. **V1 没有身份体系**：无登录、无退出、无角色。因此 V2「退出登录」和管理员页无法从旧项目借鉴，必须新设计（旧项目对应位置在 `app-shell.tsx:387-389` 只留了一句注释 `Reserved for future use (e.g. user management)`）。
2. **V1 两个列表页都是 1200–1500 行的客户端组件**，数据全部在浏览器里 fetch（`workspace/page.tsx:102-128`、`assets/page.tsx` 同类），没有 SSR；搬到 V2 只借交互，不借数据流。
3. **V1 设置有两套入口**（`/settings` 页与 `SettingsDrawer` 抽屉），内容几乎重复；V2 若做设置，只做一种。
4. **V1 小字号偏多**：10–11px 文案占比高，`--slate-400` 在浅底上对比度不足（V1 自带 `ACCESSIBILITY_AUDIT.md` 也提到过）；V2 的 3 档文字色（`--text-1/2/3` 全部 ≥ 4.5:1）更好，不要回退。
5. **V1 断点与 V2 不一致**（1150/900/680 vs 1500/1150/1050/800/560），搬布局时必须重新映射断点，不能直接复制媒体查询。
