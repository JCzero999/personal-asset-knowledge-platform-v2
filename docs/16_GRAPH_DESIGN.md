# 16 · 知识图谱改版设计（V2 · 3D 银河主视图 + 2D 聚焦阅读）

- **v2：按 15 号调研改为 3D 混合方案**（2026-11-12）。v1 的 2D 稿不再作为默认视图，**保留为「聚焦阅读模式」与降级方案**（见 §5），相关视觉、布局与交互均已并入本文，不整段删除。
- **状态**：ADR-022 已裁决，设计基线待实施评审；**未改生产代码、未提交**。
- **适用范围**：`/graph` 页面、`src/components/graph-explorer.tsx`、`src/lib/graph-layout.ts` 及其样式段。
- **上游约束**：ADR-020（深空主题）、ADR-011（图谱按账号过滤）、ADR-019（权限）、ADR-022（3D 受控例外与渲染契约）。
- **已由 ADR-022 裁决**：`/graph` 为子页面 WebGL 受控例外（懒加载、可暂停、`prefers-reduced-motion` 降级 2D、页面隐藏即停），修订 ADR-020 第 11 条。ADR-022 同时冻结依赖、视图 URL、`GraphViewModel`、3D 布局签名与档位预算。
- **口径优先级**：本文的 fov 42°、距离 520、三层盘、节点四档、边透明度等**视觉参数为设计基线**；凡与 ADR-022 冲突的技术口径（依赖、frameloop、URL、档位、接口），**以 ADR-022 为准**。
- **参考**：`docs/15_GRAPH_UI_RESEARCH.md` §2（CBM Lens 技术栈与 `GraphScene / NodeCloud / EdgeLines / NodeLabels / HaloLayer` 分层）；调研结论为「重做（Path C），首选 three.js + @react-three/fiber」。
- **配套**：3D 静态/可交互原型 `docs/mockups/graph-v3-galaxy.html`；2D 聚焦与移动端原型 `docs/mockups/graph-v2.html`；实拍见 `docs/screenshots/graph-v3-*.png`、`graph-v2-*.png`。

---

## 0. 结论

**默认看星系，点开看关系。**

- 默认：全幅 3D「知识星系」。节点是发光星点，按度数与类型编码；边是静态极细丝线；可开启极慢自转（默认关），可拖拽、可暂停。
- 聚焦：双击或详情「镜头聚焦」后镜头推近到 1–2 跳邻域，其余变暗；**单击只高亮 + 打开详情，不切 2D**。需要逐字读关系时，用「聚焦阅读」按钮或快捷键 `2` 切到 2D 平面视图（v1 稿）——那里标签不重叠、可键盘遍历、可做路径高亮。
- 降级：WebGL 不可用、`prefers-reduced-motion`、移动端窄屏，**默认直接进 2D**，功能不缺，只是没有星系。

这样既拿到 CBM Lens 的「第一眼效果」，又不把「读关系」这件事交给 3D 标签去赌。

---

## 1. 现状审计

### 1.1 代码事实

| 项 | 现状 | 证据 |
|---|---|---|
| 页面结构 | 三列壳层（76 导航 + 224 目录 + 主区），主区再放状态条、实体列表、画布卡片、问答卡片 | `src/app/graph/page.tsx:62-94`；`globals.css:3400-3419` |
| 画布尺寸 | 固定 `viewBox 640×420`，`width:100%`，`height:auto`；宽高比永远 1.52 | `graph-explorer.tsx:55-56, 382-386`；`globals.css:2982-2986` |
| 渲染技术 | 纯 SVG，无 WebGL；`/graph` 未使用 three.js | `graph-explorer.tsx` 全文 |
| 布局算法 | 单环放射：中心 r=26，其余全部 r=14，均匀排在一个半径 `0.36×min(w,h)` 的圆上 | `src/lib/graph-layout.ts:38-72` |
| 节点样式 | 所有节点同一套：`--surface` 底 + `--green-300`（现为暖金）描边 2px；中心反色 | `globals.css:3009-3019` |
| 类型编码 | 仅详情区一个 `.badge` 显示 `entity_type`；画布上**类型不可见** | `graph-explorer.tsx:443` |
| 边 | 直线，`--line` 1.5px，无方向、无粗细差异、无高亮 | `globals.css:3004-3007` |
| 标签 | 恒显 11px，非中心截断 10 字符、中心 12 字符；无避让、无 LOD | `graph-explorer.tsx:426-433`；`globals.css:3038-3047` |
| 交互 | 仅「点击非中心节点 → 以它为中心重新请求」；无缩放、平移、拖拽、路径、图例、快捷键 | `graph-explorer.tsx:407-435` |
| 请求 | 固定 `depth=2`；接口允许 1–3；服务端 `maxNodes` 默认 150 | `graph-explorer.tsx:114`；`graph-service.ts:401` |
| 问答 | 独立卡片置于画布下方；答案纯文本 + 来源链接；答案里的实体不可点 | `graph-explorer.tsx:452-503` |
| 同步状态 | 15s 轮询一次；`status.failed` 后端已返回但**界面从未渲染** | `graph-explorer.tsx:157-165` |
| 空态 | 左侧纯文字；画布纯文字「这个实体还没有可见的邻居」 | 截图 `phase5-graph-desktop.png` |

### 1.2 截图证据

**桌面 1440×900（`docs/screenshots/phase5-graph-desktop.png`）**

- 首屏四块同权重卡片，内容在 y≈600 结束，下方 300px 死区。
- 内容内宽约 1060；实体列 260、画布仅 784，高度被 640×420 锁死约 500。
- 画布与卡片同表面、同圆角，没有「空间」感。

**移动 390×844（`docs/screenshots/phase5-graph-mobile.png`）**

- 画布在第二屏以下；用户第一眼看到两张空卡片。
- 画布实际宽约 282，`viewBox` 640 → 11px 标签实际约 4.8px，不可读。
- 空态「点右上角『同步内容到图谱』」在移动端指向错误位置。

### 1.3 「为什么显得 low」条目

| # | 问题 | 证据 | 影响 |
|---|---|---|---|
| L1 | **画布不是主角** | 截图；`globals.css:2982` | 第一眼是空状态页，不是图谱 |
| L2 | **单一环布局** | `graph-layout.ts:57-69` | 节点一多即毛线球 |
| L3 | **节点无信息量** | 尺寸只有 26/14 两档 | 看不出枢纽与边缘 |
| L4 | **颜色无编码** | 全站一种金色描边 | 无法扫视分类 |
| L5 | **边没有语义** | 直线、灰、无方向 | 「关系」不可见 |
| L6 | **标签不可读** | 恒显 11px、10 字截断；移动端 4.8px | 中文实体名被截断 |
| L7 | **没有空间操作** | 无缩放/平移/拖拽 | 像列表翻页，不像图 |
| L8 | **空态无出路** | 无实体时仍写「这个实体没有邻居」 | 文案自相矛盾 |
| L9 | **状态与主行动错位** | 0 实体提示在顶部，画布空着 | 用户要自己找按钮 |
| L10 | **失败不可见** | `status.failed` 从未渲染 | 以为「同步成功但没效果」 |
| L11 | **详情与画布割裂** | 详情是卡片底部一条 120px 文本 | 选中感弱 |
| L12 | **问答与图谱割裂** | 问答在画布下方，答案实体不可点 | 退化成聊天框 |
| L13 | **层级与留白失控** | 四块同权重卡片；下方 300px 空置 | 没有主次 |
| L14 | **只换了颜色** | 画布与卡片同色，无纵深、无星尘 | 换肤完成，视觉语言没建立 |
| L15 | **移动端未重新设计** | 三卡纵向堆叠，画布不可读 | 手机基本不可用 |
| L16 | **无键盘/无障碍路径** | Tab 顺序按 id 字典序 | 只能线性遍历几十个点 |

> 结论：v1 的 2D 改版解决了 L1–L16 的大部分问题，但没有解决「第一眼不够震撼」。v2 用 3D 解决第一眼，用 2D 解决阅读。

---

## 2. 设计目标与原则

对齐 ADR-020 的四个词：**深邃、静谧、高级、克制**。

1. **深**：3D 星系有真实纵深与视差；背景比页面更深一档。
2. **静**：自转默认关闭；开启后 0.55°/s，约 11 分钟一圈；交互即暂停；无粒子雨、无相机漫游。
3. **少**：同屏强调不超过 3 处（星核暖白、选中环、路径）；光晕不透明度 0.22（ADR-022 A3.2）；无后处理也能成立。
4. **准**：3D 负责「看结构」，2D 负责「读关系」；标签只在可读时出现。
5. **稳**：位置可复现、切换不跳版、失败有出口、随时能退回 2D。

**明确不做**：不做 3D 旋转的「球状毛线」、不做 Bloom/后处理过曝、不做节点飞入动画、不做彩虹色、不做自动漫游。

---

## 3. 信息架构与布局

### 3.1 双模架构

| 模式 | 触发 | 渲染 | 主要用途 |
|---|---|---|---|
| **星系（默认）** | 进入 `/graph?mode=3d`，WebGL 可用，非 reduced-motion、非移动窄屏 | three.js 3D | 看整体结构、找枢纽、第一眼质感 |
| **聚焦（3D）** | 双击节点 / 详情「镜头聚焦」/ 快捷键 `F` | 同一 3D 场景，相机推近、其余变暗 | 看 1–2 跳邻域 |
| **阅读（2D）** | 「聚焦阅读」按钮 / 快捷键 `2` / 降级 | SVG + 冻结力导向（v1 稿） | 读标签、读关系、路径、键盘遍历 |
| **列表** | 工具条「列表视图」/ `mode=list` | 语义 HTML 列表 | 无障碍等价通道 |

- **选中 ≠ 切换**：单击只做「高亮 + 打开右侧详情」，不改变 `mode`、不切 2D；2D 只由「聚焦阅读」按钮、快捷键 `2` 或降级条件进入。
- **按钮命名**：进入 2D 的按钮叫「聚焦阅读」，即 brief 里的「聚焦」按钮；3D 镜头推近叫「镜头聚焦」（`F`），两者不混用。
- 四种视图共享同一个 **`GraphViewModel`**（ADR-022）：类型→颜色/形状、度数、跳数、截断推断在建模时算一次，抽稀由 `graph-quality.ts` 的 `decimate(view, budget)` 统一算一次；切换只换渲染器，不重新请求、不在组件里二次映射。
- **URL 是视图状态源**：`/graph?mode=3d|2d|list&focus=<实体>&depth=1|2|3`；`focus` 是取景中心（2D 圆心 / 3D 取景），**与选中是两件事**；单击选中只改容器里的 `selectedId`，不改 `mode`、不写 `focus`；双击 /「镜头聚焦」才写 `focus`。模式、取景、深度可由后退/刷新恢复；不再使用 `localStorage: pakp.graph.mode`。
- 3D ↔ 2D 切换做 320ms 交叉淡入淡出，选中与相机位置保留；返回 3D 时恢复之前的轨道角度。

### 3.2 桌面 1440×900

星图铺满整个内容区，功能区全部是浮在上面的液态玻璃板（ADR-027）。画布尺寸恒定为整幅，不再因为详情栏开合而变宽变窄。

两张卡分居左右上角、顶边同一条水平线：左边是紧凑的控制卡（宽度按内容自适应，不横贯整行），右边是实体详情卡；问图谱贴右下，提示条贴左下。

```
┌ 76 ┬── 224 目录 ──┬──────────── 1140 内容区 ─────────────┐
│    │              │  星图层 1140×900：整幅背景，inset: 0  │
│ 导 │  浏览        │ ┌ 控制卡 736 ───────────┐ ┌ 356 ────┐ │
│ 航 │  工作台      │ │ 标题 / 状态 / [收起]  │ │ 实体详情 │ │
│    │  图谱        │ │ 中心·邻域·模式·旋转   │ │  玻璃板  │ │
│    │  词表        │ │ [刷新] [同步内容]     │ │ 最高 60% │ │
│    │              │ └───────────────────────┘ └─────────┘ │
│    │              │ [邻域 chip]                          │
│    │              │          ·   ✦   ·                   │
│    │              │       ✦ ──── ● ──── ✦                │
│    │              │          ✦   ·   ✦    ┌ 356 ────┐    │
│    │              │     提示条            │ 问图谱   │    │
│    │              │       [ + − ⟲ ]       └─────────┘    │
└────┴──────────────┴──────────────────────────────────────┘
```

| 区域 | 位置 / 尺寸 | 说明 |
|---|---|---|
| 星图层 | 整幅 1140×900；`position: absolute; inset: 0; z-index: 0` | 2D SVG / 3D canvas 铺满；宽度不受右栏开合影响，页面不出滚动条 |
| 控制卡 | `top: 16; left: 16`；宽 `max-content`，上限 `min(880, 100% − 右栏 − 48)` | 标题、状态、整排控件（中心 / 邻域 / 模式 / 自动旋转 / 刷新 / 同步）与「收起」都在卡内；放不下一代就换行，不删功能。实测 1440 宽 736、1920 宽 880（单行） |
| 邻域条 | 控制卡下沿 + 8（`--graph-bar-h` 由组件实测写入），靠左，玻璃 chip | 聚焦实体 + 度数 / 关系数；不压控制卡 |
| 实体详情 | `top: 16; right: 16`，宽 356，最高 60%，内部滚动 | 未选中时给空状态；收起后收成右上角把手。顶边与控制卡同线（实测差 0px） |
| 问图谱 | `bottom: 16; right: 16`，宽 356，最高 `min(36%, 40% − 40px)` | 与详情卡上下分区，留出 40% 减去留白的余量，两块永不重叠 |
| 画布控件 | 画布列右下：右内缩 356 + 24，下 16 | `+` / `−` / 重置；移出右栏是因为原来的右下角正好被问图谱盖住 |
| 提示条 | `bottom: 16; left: 16`，最宽 520，最高 52% | 容器 `pointer-events: none`，只有提示条本身吃事件，空隙仍拖得动画布 |

**避让规则**：浮层只占顶部两张角卡、右侧 356 一列与左下提示条，画面中心与 1 跳环保持完全可见；控制卡右缘与详情卡左缘至少留 16（1440 实测 16、1920 实测 352）。

**液态玻璃材质（三张卡共用一套）**：

| 层 | 做法 | 说明 |
|---|---|---|
| 底 | 72% 画布色 + `backdrop-filter: blur(14px) saturate(130%)` | 低档降级为 92% 实色（ADR-027 第 12 条） |
| 跟随高光 | `::before` 径向渐变，圆心 `--mx/--my`（百分比，默认 50%） | 组件按帧写 CSS 变量，不触发 React 重渲染；`pointer-events: none` |
| 斜向反光 | `::after` 160° 线渐变（白 18→3→8→14%），`mix-blend-mode: screen` | 两层伪元素都在 `z-index: -1`：压在自己底色之上、内容之下，子元素不必逐个定位 |
| 厚度 | `perspective(1200px) rotateX/rotateY`，最大 3°，离开后 220ms 归位 | `prefers-reduced-motion` 与触屏下关闭倾斜与跟随高光，只留静态反光 |

`--mx/--my/--rx/--ry` 由**每张卡自身的 `pointermove`** 写入（`passive`，不进 React 渲染），并 `requestAnimationFrame` 合并，一帧最多提交一次；画布拖拽 / 滚轮 / 双击照常穿透（浮层容器 `pointer-events: none`，卡片自身 `auto`）。

### 3.3 断点

| 断点 | 变化 |
|---|---|
| ≥768 | 两张角卡绝对定位；控制卡右缘与详情卡左缘至少留 16，不重叠 |
| ≥1001 | 右栏 356（`--graph-rail-w: 356px`）；控制卡上限 `min(880, 内容区 − 404)` |
| 768–1000 | 右栏收窄到 300（`--graph-rail-w: 300px`），控制卡上限跟着放宽到 `内容区 − 348`，画布控件左移到新的列右缘 |
| 768–900 | 非触屏 3D lite：DPR 1.5、无星尘、无后处理、默认 1 跳；触屏设备按 <768 处理 |
| <768 / 触屏 | **默认 2D 阅读模式；3D 入口隐藏**（ADR-022）：控制条回到网格第一行，压成一行（标题 + 状态 + `控制` 按钮），详情改为底部抽屉（≤55dvh，画布上半屏 ≥45dvh 可拖），问图谱落在文档流最后一格，画布缩放按钮隐藏（触摸端用双指缩放） |
| ≤560 | 见 §3.4 |

### 3.4 移动 390×844（默认 2D）

```
┌ 76 ┬──── 314 ────┐
│    │ 工具条 48    │  知识图谱 / 状态点 / ⋯
│ 导 ├──────────────┤
│ 航 │ [🔍 搜索 266]│  浮在画布上
│    │              │
│    │   2D 画布    │  290×724，默认 1 跳
│    │   ○   ◇      │
│    │      ●       │  命中区 ≥44×44
│    │   ○          │
│    │              │
│    │        [＋]  │  「展开第二层」
│    ├──────────────┤
│    │ 问图谱 dock  │  48 → 70dvh 抽屉
│    └──────────────┘
```

- 默认 2D 的理由：390 宽下 3D 星点平均直径不足 8px，标签无法读；2D 同屏可读的实体数量明显更多。
- 移动端**不提供 3D 入口**（ADR-022）：不做「试试 3D」，需要 3D 时在桌面打开；退出 2D 即保持 2D。

---

## 4. 3D 星系视觉规范（默认视图）

### 4.1 场景分层（借鉴 CBM Lens，符号名仅作结构参考）

| 层 | 职责 | 实现（ADR-022 冻结） |
|---|---|---|
| `GraphScene` | canvas、相机、控制器、雾、色调映射 | `<Canvas frameloop="demand">` + `PerspectiveCamera` + three 内置 `OrbitControls` |
| `Starfield` | 背景星尘，不参与拾取 | `Points`，900 点，静态 |
| `NodeCloud` | 节点星点 | **instanced SDF**：圆 / 双环 / 圆角方 / 菱形 / 六边形共用一套实例化几何，单 draw call |
| `EdgeLines` | 丝状连线 | **3 组 `LineSegments2` + `LineMaterial`**（默认 / 结构 / 选中，均来自 `three/examples/jsm/lines/*`，不是新依赖） |
| `HaloLayer` | 选中与枢纽的光晕 | **additive 混合 instanced quad**，最多 6 个，不用 Bloom |
| `NodeLabels` | 标签 | **Canvas 纹理图集 + instanced Sprite**（ADR-022、`docs/17_CBM_GALAXY_TECH.md`）；预算 40/24/12，不做 DOM overlay |
| `density` | 统一控制标签/边/光晕的 LOD | 由相机距离与节点数推导的 0–1 系数 |

- **无 drei、无 postprocessing**：不装 `@react-three/drei`，不装 `postprocessing`/`UnrealBloom`；`OrbitControls` 从 `three/examples/jsm/controls/OrbitControls.js` 引入。
- draw calls 预算 8：星场 1 + 光晕 1 + 节点 1 + 边 3（默认/结构/选中）+ 标签 1 + 选中环 1；超预算时先把「结构」并入「默认」（边 2 组）。

### 4.2 相机与构图

| 参数 | 值 | 说明 |
|---|---|---|
| fov | **42°** | 比默认 50° 更「长焦」，减少边缘拉伸 |
| near / far | 1 / 4000 | — |
| 初始距离 | **520**（世界单位） | 3 层盘最大直径约 850px，占 1108 画布宽 77%；详情展开时按视口重算约 760 |
| 目标点 | `(0, 0, 0)` | 星核 |
| 初始方位 | 方位角 0°（原型取 35°，避免正对称），仰角 **22°** | 略高于盘面，能看到纵深但不俯瞰 |
| 极角限制 | 25°–155°（相对 +Y，ADR-022） | 允许略低于盘面观察，但不做无限翻转 |
| 缩放范围 | 260–1100 | 320 ≈ 聚焦 1 跳；520 ≈ 默认；1100 ≈ 全局 |
| 阻尼 | `enableDamping`，`dampingFactor 0.08` | 松手后 0.5s 内停 |
| 旋转速度 | 拖拽 0.55（OrbitControls rotateSpeed） | 不晕 |
| 缩放速度 | 0.8 | — |
| 自转 | **默认关闭**；开启后 0.55°/s，绕 Y 轴 | 一圈约 10.9 分钟；交互即暂停，静置 8s 恢复；reduced-motion 隐藏开关 |
| 盘面倾角 | 场景组绕 X 轴 **-12°** | 与相机仰角叠加，形成 34° 视觉倾角 |
| 雾 | `FogExp2(#050408, 0.0009)` | 远环自然衰减，制造纵深 |

### 4.3 布局：三层盘 + 少量垂向抖动

- 星核在原点；1 跳环 `r = 85`，2 跳 `r = 150`，3 跳 `r = 210`（世界单位，与相机 260–1100 同一坐标空间）。
- 垂向抖动：1 跳 `±10`，2 跳 `±22`，3 跳 `±32`，按 `hash(id)` 固定，形成「盘状」而不是平面。
- **播种**：同层角度按 `360° / n` 均分，再按 `hash(id)` 抖动 ±0.06rad；不可达节点放 `r = 340` 外环；`seedKey` 只用于缓存与基线命名，**不作随机源**。
- **松弛**：`layoutGalaxy3d` 内在播种后做边弹簧 + 节点斥力（≤300 节点 O(n²)，>300 网格哈希）+ 径向约束 + 碰撞；固定步长、按 id 排序迭代。只播种不松弛看不出结构，只松弛不盘面形状会漂。
- **预算**：`maxTicks` 按节点数分档 ≤150 → 80、151–600 → 150、601–2000 → 220；Worker 内 `deadlineMs` 400ms，超时返回当前解并置 `truncated = true`。
- **anchors**：语义是「上一版布局里仍存在的节点坐标」；anchor 节点首步落在原坐标、弹簧力减半，新节点在相邻节点附近播种后松弛。同一中心连点 5 次，位置集合不变。
- 规模与执行：≤300 节点同步布局（≤16ms）；301–2000 放 Web Worker；>2000 先抽稀到档位上限再布局，并置 `truncated = true`。
- 布局缓存键 = `centerId + depth + 节点 id 集合哈希 + 画布尺寸档 + layoutVersion`；`layoutVersion` 只在算法改动时 bump，并同步更新截图基线。
- 相机适配：包围球半径 `R`，距离 `d = R / tan(fov/2) × 1.25`，再夹在 260–1100。

### 4.4 节点

**世界尺寸**（不是屏幕像素，随距离自然缩放）——按 `GraphViewModel.node.size` 分 **4 档**（`size` 已由度数在模型里算好，渲染层不再数边）：

| size | s | m | l | xl |
|---|---|---|---|---|
| 对应度数 | 0–1 | 2–4 | 5–9 | 10+ |
| 世界半径 | 1.9 | 2.5 | 3.3 | 4.4 |
| 屏幕直径 @520 | 7.7px | 10.2px | 13.4px | 17.9px |

```
r_world = BAND[node.size]   // s/m/l/xl → 1.9 / 2.5 / 3.3 / 4.4
星核 r_world = 5.4
选中额外 × 1.15（160ms 过渡）
```

详情栏展开后相机距离按视口重算（约 760），屏幕尺寸约 ×0.68；2 跳外缘因透视再小 10–18%。

**结构**（从下到上）：

1. 光晕 quad：半径 `3.2 × 节点半径`，径向渐变，**只有选中 / 星核 / 枢纽渲染**（选中与星核 **0.22**，枢纽 0.08，普通节点不渲染；ADR-022 A3.2）；additive 混合，无 Bloom；
2. 星体：深色盘 `#0e0c13` + 类型色 1px 描边 + 类型色内核（`0.34r`），保证小尺寸下仍能看出颜色；
3. 星核：额外 0.16r 暖白心（`#f6e3c6`，仅星核与选中），让视觉焦点有「亮度」而不是「大小」；
4. 选中环：屏幕空间 1.5px 暖白环（`--graph-accent #F6E3C6`），直径 `节点直径 + 10px`，不随距离变粗。

**类型**：沿用 v1 的 6 类色 + 形状双编码（3D 下形状用 instanced SDF 几何区分圆 / 双环 / 圆角方 / 菱形 / 六边形 / 小圆，不用逐节点 sprite），颜色对 `#050408` 全部 ≥4.5:1：

| 类型 | 色值 | 形状 | 对比度 |
|---|---|---|---|
| 概念 | `#E9C08A` | 圆 | 12.0 |
| 人物 | `#A99BC1` | 双环 | 7.9 |
| 组织 | `#B08A6A` | 圆角方 | 6.5 |
| 作品/资产 | `#8FA6B8` | 菱形 | 8.1 |
| 方法/流程 | `#9DB39A` | 六边形 | 9.1 |
| 其他 | `#7C7385` | 小圆 | 4.5 |

> `GraphViewModel.node.colorToken` 指向 `[data-surface="graph"]` 下的 `--graph-node-concept / person / org / work / method / other`；上表 hex 作为无 token 时的回退值。组件里不出现类型名或色值字面量。

**深度暗示**：越远越暗（opacity 0.55–1.0）且越小；不给远处节点加光晕，避免「一片糊光」。

### 4.5 边

| 状态 | 颜色 / 宽度 | 透明度 | 说明 |
|---|---|---|---|
| 默认 | `rgba(243,239,231,.14)`，屏幕宽 1px（视觉目标 0.5–1px） | 0.14 × 深度系数（0.6–1.0） | 丝线，不与节点争 |
| 结构边（连星核 / 两端度 ≥8） | 同上 | 0.20 | 让骨架可见 |
| 悬停邻域 | `rgba(246,227,198,.45)`（暖白） | 0.45 | 非邻域边降到 0.06 |
| 选中 / 路径 | `--graph-accent #F6E3C6`，1.5px | 0.80 | 只改颜色与透明度，**不做移动光点**；路径两端加 1.5px 静态光点 |

- **方向语义**：LightRAG 的 `source/target` 是抽取方向，不是真实语义方向（ADR-022 §12）。`GraphEdge.direction` 恒为 `"none"`；默认**不画箭头、不加移动光点**。只有选中单条关系时，详情栏给 `A —关系→ B` 的原文。
- 边按「默认 / 结构 / 选中」分 3 组，`LineSegments2` + `LineMaterial` 控制 0.5–1px；不新增依赖，也不用 `LineBasicMaterial` 的默认 1px。
- 悬停只改透明度与颜色，不引入移动粒子；`prefers-reduced-motion` 下所有边保持静态。

### 4.6 背景与运镜

- 底：`#050408`（与全站一致），不用首页那颗大星系。
- 星尘 `Starfield`：900 点，分布在 1400×900×600 的盒内，尺寸 0.6–1.6，透明度 0.18–0.35，静态（不自转、不闪烁）。
- 一层极淡暖白光晕在星核后方：半径 320，`rgba(246,227,198,.05)`，静止。
- 自转（可选）：整个星系组绕 Y 轴，0.55°/s；**默认关闭**，由工具条显式开关；开启后 `pointerdown` 暂停，`pointerup` 8s 恢复；`document.hidden` 暂停；`prefers-reduced-motion` 隐藏开关且不启动。
- 相机聚焦：**400ms**，`cubic-bezier(.22,1,.36,1)`；返回全局 400ms；不做「飞行穿越」。
- 帧循环：`frameloop="demand"`；静止时零帧，交互/过渡时 `invalidate()` 单帧渲染；页面隐藏切 `never`。

### 4.7 渲染参数

| 项 | 桌面 high | 移动 / lite |
|---|---|---|
| renderer | `antialias: true, powerPreference: "high-performance"` | `antialias: false` |
| DPR | `min(devicePixelRatio, 2)` | 1.5（low 档 1） |
| 色调映射 | **以实现为准：`NoToneMapping`**（理由见 ADR-022 A8，不要按本表修回去） | **以实现为准：`NoToneMapping`**（同左，ADR-022 A8） |
| 色彩空间 | sRGB | sRGB |
| 后处理 | **无**（ADR-022 禁止 postprocessing/Bloom） | **无** |
| 阴影 | 无 | 无 |
| 雾 | `FogExp2` 0.0009 | 0.0007 |
| 帧循环 | `frameloop="demand"`，静止 0 帧 | 同 |
| draw calls | ≤8 | ≤8 |

> ADR-022 明确不引入 postprocessing/Bloom；光晕全部由 additive 混合 quad 完成，效果上限由光晕不透明度控制（**0.22**，ADR-022 A3.2）；色调映射以实现为准，见上一行与 ADR-022 A8。
> 图谱舞台的 token 放在 `[data-surface="graph"]` 下的 `--graph-*`，不扩 ADR-021 的 129 名契约（98 主题语义 + 31 几何），也不改主题 `:root`。

**A2.1 的 12 个舞台 token**（名字冻结，值以本节为准）：

| token | 用途 | 值 |
|---|---|---|
| `--graph-canvas` | 舞台底色 / 雾色 | `#050408` |
| `--graph-node-concept` | 概念 | `#E9C08A` |
| `--graph-node-person` | 人物 | `#A99BC1` |
| `--graph-node-org` | 组织 | `#B08A6A` |
| `--graph-node-work` | 作品 / 资产 | `#8FA6B8` |
| `--graph-node-method` | 方法 / 流程 | `#9DB39A` |
| `--graph-node-other` | 其他 | `#7C7385` |
| `--graph-node-disk` | 节点底盘 | `#0E0C13` |
| `--graph-core` | 星核 / 选中暖白光 | `#F6E3C6` |
| `--graph-edge` | 默认边 | `rgb(243 239 231 / 14%)` |
| `--graph-edge-strong` | 结构边 | 同色，不透明度 20% |
| `--graph-accent` | 选中环 / 路径 / 高亮 | `#F6E3C6`（暖白，不与概念金同值） |

---

## 5. 2D 聚焦阅读模式（保留 v1 稿）

### 5.1 何时进入

- 用户点「聚焦阅读」（工具条或详情栏），或按快捷键 `2`；
- WebGL 不可用 / 上下文丢失 / 3D 加载超时 4s；
- `prefers-reduced-motion: reduce` 默认进入；
- 宽度 <768 或触屏（移动端）；
- URL 为 `mode=2d`（刷新/后退恢复）。

**不因单击选中而切换**：选中只在 3D 内高亮并打开详情；`focus` 参数不改变 `mode`。

切换：320ms 交叉淡化；保留 `selected`、筛选、深度；返回 3D 时恢复轨道角度与距离。

### 5.2 视觉（沿用 v1）

- 画布：`var(--graph-canvas)` + 固定星尘 pattern + 内阴影；无自转、无脉冲。
- 节点：半径 `clamp(5 + 3.1×√degree, 5, 20)`，中心 26；深色盘 + 类型色描边 + 30% 内核；形状同 §4.4。
- 边：直线/贝塞尔，1px `var(--graph-edge)`；选中暖白 2px（`--graph-accent`）；单条关系选中时**不画箭头**，方向原文只在详情栏给出（ADR-022 §12）。
- 2D 颜色只读 A2.1 的 12 个 `--graph-*` token，不再保留 v1 的画布/边色值；若后续确需 2D 专色，只在 `[data-surface="graph"][data-mode="2d"]` 覆盖同名 token，不新增第 13 个 token，组件不写色值字面量。
- 标签：11px，四级候选位避让，缩放 LOD（<0.55 仅中心/选中；0.55–0.85 加度数 ≥6；>0.85 全部）；宁缺勿挤。
- 选中/悬停/路径/暗淡/焦点环：
  - 选中：节点加 1.5px 暖白环（`--graph-accent`，offset 4px）+ 光晕 0.22；相邻边暖白 0.72。
  - 悬停：描边 2px、邻域边 0.45、非邻域节点 0.55。
  - 路径：暖白 2px（`--graph-accent`）、其余边 0.10，逐段点亮 180ms（reduced-motion 下直接全亮）。
  - 焦点环：`outline: 2px solid var(--graph-accent); outline-offset: 2px`，仅键盘可见。
- 布局：冻结力导向（斥力 -260、link 88/0.35、径向约束 0.27/0.46、碰撞 +8、向心 .02），300 tick 后冻结；同数据位置可复现。
- 力导向与 3D 盘布局**不共享坐标**：切换时以选中节点为锚做 320ms 过渡，不做节点逐个飞行。

### 5.3 移动端（390×844）

- 内容宽 314，舞台 290×724；默认 1 跳。
- 节点视觉半径同 2D；命中区 `max(r+12, 22)`，保证 44px 触控。
- 标签仅中心 + 选中 + 度数 ≥4；10px。
- 筛选/详情/索引为底部抽屉，最大 70dvh，互斥打开。
- 手势：单指拖动平移、双指捏合缩放、单击选中、双击展开。

---

## 6. 交互规范

### 6.1 3D 指针

| 操作 | 桌面 | 移动 | 反馈 |
|---|---|---|---|
| 旋转 | 左键拖拽 | 单指拖动 | 跟手；松手阻尼 0.5s 停；暂停自转 |
| 缩放 | 滚轮 / `+ −` | 双指捏合 | 以指针为锚；260–1100 |
| 平移 | 右键拖拽 / 空格+拖拽 | 双指拖动 | 限制在 ±R 内，防丢 |
| 悬停 | 160ms 后高亮 1 跳邻域 + 标签 + 浮层 | 长按 400ms | 非邻域边 0.06、节点 0.25 |
| 选中 | 单击 | 单击 | 详情栏 220ms；选中环 + 光晕 0.22 |
| 镜头聚焦 | 双击 / 详情「镜头聚焦」 / `F` | 双击 | 相机 400ms 推近至距离 320，其余 0.15 |
| 返回 | `Esc` / `Alt+←` / 面包屑 | 工具条 ← | 400ms 回全局；保留历史栈 |
| 切 2D | 工具条「聚焦阅读」/ 快捷键 `2` | 详情「聚焦阅读」 | 320ms 交叉淡化；**选中不触发** |
| 路径 | 选中 A 后 `Shift+单击` B | 详情「查看路径」 | 3D 暖白路径 + 2D 逐段点亮 |

### 6.2 聚焦模式

- 进入：相机目标 = 选中节点，距离 320；保留当前方位角与仰角（不强行转到正面）。
- 1 跳节点保持 1.0，2 跳 0.55，其余 0.15；非邻域边 0.04；只显示 1 跳标签与 2 跳枢纽标签。
- 聚焦时自转暂停；用户拖拽可环绕选中节点旋转。
- 详情栏常驻；问答 dock 收起为 48px，避免遮挡。
- 「聚焦阅读」在该状态下最有用：所有 1–2 跳标签都能读全。

### 6.3 搜索与命令面板

- `⌘K` / `/` 打开；前缀 > 包含 > 子序列匹配；`↑↓` 选择、`Enter` 选中并镜头聚焦（3D 相机 400ms；2D 相机飞行 420ms）。
- 最近访问 3 个；无结果给「查看全部实体 / 重新同步」。
- 搜索定位后自动展开 1 跳标签 2s，再回落 LOD。

### 6.4 筛选与图例

- 类型 chips 一行，**即图例**：形状 + 颜色 + 名称 + 计数；不设独立图例框。
- 点击：非选中类型 `opacity .18`（3D 降到 0.12 且不参与拾取）；位置不动，不重排。
- 「仅看邻居」：只保留 1 跳（3D 下同时把相机拉近）。
- 「全部」恢复；筛选状态不写 URL。

### 6.5 详情与问答

- 详情栏 340（v1 结构不变）：类型、名称、度、1 跳邻居数、描述、关系列表（按对方度数排序，前 20 条）、动作「镜头聚焦 / 聚焦阅读 / 钉住」。
- 问答 dock：收起 560×48，展开 560×min(480,70%)；答案里的实体渲染为 chip，点击选中并聚焦；来源对象保留链接。
- 3D 下问答展开时相机目标上移 24px，避免星核被盖。

### 6.6 键盘

| 键 | 3D | 2D |
|---|---|---|
| `Tab` | 进入画布（仅一个可聚焦容器）→ 详情/浮层 | roving tabindex 遍历节点 |
| `↑↓←→` | 环绕旋转（10°/次） | 空间移动到最近节点 |
| `+ / -` | 缩放 | 缩放 |
| `Enter` | 选中 | 选中 |
| `Space` | 聚焦 | 以此为中心 |
| `Esc` | 聚焦 → 全局 → 取消选中（逐层） | 关闭浮层 → 取消选中 |
| `F` | 聚焦选中 | 聚焦选中 |
| `2` | 切换到 2D 阅读 | 切换回星系 |
| `0` | 回到全局 | 适配 |
| `⌘K` / `/` | 搜索 | 搜索 |
| `Alt+←` | 返回上一层 | 同 |
| `?` | 快捷键帮助 | 同 |

> 3D canvas 用 `tabIndex=0`、`role="img"`、`aria-label`（ADR-022）；3D **不承诺逐节点空间导航**，完整遍历由「2D 阅读 + 列表视图」承担。进入时播报「当前为星系视图，按 F 聚焦，按 2 切换到 2D」。

### 6.7 动效

| 场景 | 时长 | 缓动 |
|---|---|---|
| 悬停高亮 / 标签出现 | 120ms | ease-out |
| 选中环 / 光晕 | 160ms | ease-out |
| 详情栏 | 220ms | `--ease-panel` |
| 相机聚焦 / 返回 | 400ms | `cubic-bezier(.22,1,.36,1)` |
| 3D ↔ 2D | 320ms 交叉淡化 | ease-in-out |
| 自转（仅开启时） | 0.55°/s 连续 | linear |
| 边高亮 | 160ms | ease-out |
| reduced-motion | 全部 0ms；无自转、无移动光点 | — |

---

## 7. 状态设计

| 状态 | 触发 | 3D 画面 | 主行动 | 次行动 |
|---|---|---|---|---|
| **A. 零内容** | `status.total === 0` 且无对象 | 星尘 + 12 个 10% 透明「原初星点」示意；中央玻璃卡 | 同步内容到图谱 | 刷新状态 |
| **B. 有对象零实体** | 有对象未同步 | 同上，标题「还没有抽取实体」；步骤 1/3 | 同步内容 | 查看说明 |
| **C. 首次加载** | 进入页面 | 壳层先出（工具条/实体数）；3D 区先 CSS 星点骨架，模块到位后 180ms 淡入；不跳版 | — | — |
| **D. 抽取中** | pending+processing>0 | 顶部 chip 进度 7/24；可浏览已完成实体；星核轻微呼吸（reduced-motion 静止） | 浏览 | 查看队列 |
| **E. 部分失败** | `status.failed.length>0` | 顶部警示 chip「N 个对象抽取失败」；可展开失败列表（objectId 前 8 位 + LightRAG 原始错误）；图谱仍可浏览 | 查看失败 | 重新同步 |
| **F. 无邻居** | 选中实体无边 | 星核单独存在，外圈两圈极淡轨道环；文案「这个实体还没有已抽取的关系」 | 展开第三层 | 换实体 / 重新同步 |
| **G. 3D 加载失败** | 模块超时/异常 | 直接切 2D，toast「已切换到 2D 视图」 | 重试 3D | — |
| **H. 图请求失败** | API 错误 | 保留上次成功图（0.5 灰显）+ 错误卡 | 重试 | 刷新状态 |
| **I. 服务未连接** | LightRAG 不可达 | 灰色 chip；2D/3D 都显示上次数据 | 刷新状态 | 管理员：系统页 |
| **J. 无权限** | 403 | 整页说明 | 返回工作台 | — |
| **K. 超限** | `nodes.length >= requestMaxNodes`（150 默认，50–600）或输入 >2000 | 右下提示「已展开最近 N 个实体」/「已截断 2000/4500」 | 仅看邻居 | 以此节点深入 |
| **L. 上下文丢失** | `webglcontextlost` | 首次丢失 1s 内自动恢复；再次丢失立即切 2D + toast；恢复后不自动切回 | 重新开启 3D | — |

空状态细则同 v1：必须给 1 个主按钮 + 1 个可理解的下一步；没有对象时主行动改为「去创建第一条内容」。

---

## 8. 性能与降级

### 8.1 预算

| 指标 | 目标 | 说明 |
|---|---|---|
| 150 节点 / 300 边 | **60fps**（≥57） | 1440×900，DPR 2，high 档 |
| high 档上限 | 600 节点 / 1200 边 / 40 标签 / DPR 2 | ADR-022 |
| 2000 输入 | 采样到 ≤600 后 **≥30fps**（可交互） | 不承诺 2000 全量渲染 |
| 首帧（3D 可见） | ≤1.2s（本地缓存后 ≤400ms） | 壳层 <100ms |
| 3D chunk | ≤260KB gzip（three 181 + fiber 58 + 场景） | 懒加载，不进首屏 |
| 路由首载（不含 3D 懒加载） | ≤120KB gzip | ADR-022 验收 |
| 主线程单帧 | **≤6ms**；GPU ≤8ms | 投影/标签更新 ≤2ms |
| 空闲帧 | **0**（`frameloop="demand"`） | 无自转、无过渡时不渲染 |
| 内存 | ≤120MB 增量；连续 3 次进出不持续增长 | 释放 geometry/material/texture |
| 移动 lite | ≥50fps | DPR 1.5，1 跳 |

### 8.2 档位与 2000 输入策略

| 档位 | 节点 / 边 | 标签 | DPR | 布局 |
|---|---|---|---|---|
| low | 150 / 300 | 12 | 1 | 3D 盘 |
| balanced | 300 / 600 | 24 | 1.5 | 3D 盘 |
| high | 600 / 1200 | 40 | 2 | 3D 盘 |

- **自适应只降不升**：连续 60 帧（≈1s）低于当前档目标即降一档，一页最多两次、间隔 ≥3s；**不自动升档**，50fps 只是 high 档验收目标，不是升档条件。保留「手动低画质」菜单，只允许继续向低档，不扩 `GraphIntent`。
- **输入 601–2000**：默认只取 1 跳；用户显式要更多时，按 `degree` 降序采样到档位上限（同分按 id），始终保留星核与选中 2 跳邻域；界面明示「已截断」。
- **输入 >2000**：前端截断到 2000 再进档位采样，并提示「已截断 2000 / 4500」；不把 2000 个节点直接塞进 high 档。
- `maxNodes` 由 API 透传，整数 **50–600**，默认 150；`nodes.length >= requestMaxNodes` 即视为截断，不依赖上游返回 `truncated`。
- 按账号过滤发生在截断之后，可能得到不连通子图；这是已知取舍，用空态/孤立点提示承接，不二次请求补偿。
- 标签固定 40/24/12 个 Canvas 纹理 Sprite 复用，不在 DOM 里建标签池；超出预算按「选中 > 悬停 > 星核 > 度数」排序。
- 类型筛选用逐实例 alpha/可见性，不重建几何；布局 ≤300 同步，301–2000 放 Web Worker。
- 视锥剔除：相机视锥外节点不参与标签与拾取；`frustumCulled` 保持默认。

### 8.3 首屏不阻塞

1. 服务端先出工具条、实体计数、实体列表/搜索入口（不依赖 three）。
2. 3D 区先渲染 CSS 星点骨架（纯 CSS，<1KB），高度固定。
3. `useEffect` 内先做 WebGL 探针，通过后再 `import("./graph-galaxy")`；不通过直接 2D，不下载 three。
4. three 与首页共用同一版本 **0.187.0**，浏览器可复用缓存；但 `/graph` 的 chunk 仍独立懒加载。
5. 3D 模块 4s 未就绪 → 切 2D，不白屏；`frameloop="demand"`，静止不烧 rAF。
6. 开发态暴露 `window.__graphStats = {mode,tier,webgl,nodes,edges,labels,drawCalls,dpr,frames,avgFrameMs,layoutMs,layoutTicks,truncated,rafActive}` 供验收。

### 8.4 降级矩阵

| 条件 | 默认视图 | 3D 是否可用 | 备注 |
|---|---|---|---|
| WebGL 不可用 | 2D | 否 | 提示一次，不反复重试 |
| `prefers-reduced-motion: reduce` | 2D | **否（入口隐藏）** | ADR-022；自转/移动光点/过渡 0 |
| 宽度 <768 或触屏 | 2D | **否（入口隐藏）** | 不提供「试试 3D」 |
| 768–1023 非触屏 | 3D lite | 是 | DPR 1.5、无星尘、无后处理 |
| 设备内存 ≤4GB 或 `hardwareConcurrency ≤4` | 2D 或 lite | 视探针 | 无光晕外溢 |
| 页面隐藏 | 暂停 | — | `frameloop="never"`，`rafActive=false` |
| 3D 加载超时 | 2D | 重试按钮 | — |
| 上下文丢失 | 首次自动恢复；再次 2D | 可重试 | 不自动切回 |

---

## 9. 可访问性

| 项 | 方案 |
|---|---|
| 等价通道 | 「聚焦阅读」与「列表视图」是 3D 的完整等价物；3D 不承载唯一信息 |
| 键盘 | 3D 容器 `tabIndex=0`，方向键环绕、`+/-` 缩放、`F` 聚焦、`2` 切 2D；3D 不做逐节点空间导航；2D 内 roving tabindex + 空间导航 |
| 语义 | 3D canvas `role="img"` + `aria-label`（中心、节点数、当前模式）；列表视图是语义 `<ul>` |
| 播报 | 选中/聚焦/模式切换/加载完成用 `aria-live="polite"`，限 1 条/2s |
| 对比度 | 节点色 ≥4.5:1；正文沿用 `--text-*`；默认细边 1.5:1 属装饰，关系含义在详情与列表 |
| 色盲 | 颜色 + 形状双编码；筛选 chips 同形状；灰度下至少 4 类可辨 |
| 动效 | `prefers-reduced-motion` 默认 2D，**3D 入口隐藏**；所有过渡 0ms |
| 晕动 | 自转默认关，开启后 0.55°/s；无相机自动漫游、无 FOV 推拉；可随时暂停 |
| 触控 | 移动端默认 2D，**不提供 3D 入口**；命中区移动 ≥44×44、桌面 ≥24×24 |
| 缩放 | 页面 200% 下详情栏变抽屉，无横向溢出 |

---

## 10. 改造映射（给 Coder，仅说明改动点）

| 文件 | 改动 |
|---|---|
| `package.json` | 新增 `@react-three/fiber@^9.8.2`（MIT）；`three` **精确锁 `0.187.0`**；**不装 `@react-three/drei`、不装 `postprocessing`**；`OrbitControls` 取自 `three/examples/jsm/controls/OrbitControls.js` |
| `src/lib/graph-model.ts` | **冻结件**：`buildGraphViewModel` + `GraphViewModel`；类型→颜色 token/形状、`degree`、`hop`、`size`、截断推断只算一次；未知类型归 `other` |
| `src/lib/graph-quality.ts` | **冻结件**：`selectGraphMode`、档位选择、`decimate(view, budget)`；自适应只降不升；DPR 上限 |
| `src/lib/graph-selectors.ts` | **冻结件**：`GraphSelection` / `GraphHighlight`；邻域、路径 BFS 只此一份；渲染器只消费，不自己算 |
| `src/lib/graph-layout-3d.ts` | **新增，纯数学**：`layoutGalaxy3d(view, options)`；三层盘播种 + 弹簧/斥力松弛；`maxTicks` 分档、`deadlineMs` 400ms；返回 `positions / indexById / ids / radius / bounds / ticks / truncated / layoutMs` |
| `src/workers/graph-layout.worker.ts` | `layout / cancel / done / error` 消息协议；不 import React / three / 任何 `@/components` |
| `src/lib/graph-layout-2d.ts` | 2D 力导向与标签放置；`src/lib/graph-layout.ts` 只保留 `layoutRadial` 作降级基线与旧测试，不再加新函数 |
| `src/components/graph/graph-scene-3d.tsx` | 3D 对外唯一组件；props 见 §10.1；`<Canvas frameloop="demand">`、上下文丢失、页面隐藏与暂停 |
| `src/components/graph/node-field.tsx` | instanced SDF 节点（6 形状一套实例化几何）+ additive 光晕 quad；单文件合并，不单独建 halo 组件 |
| `src/components/graph/edge-field.tsx` | 3 组 `LineSegments2` + `LineMaterial`（默认 / 结构 / 选中），逐顶点 alpha，无箭头、无移动光点 |
| `src/components/graph/label-layer.tsx` | Canvas 纹理图集 + instanced Sprite（40/24/12），**不是 DOM 标签池** |
| `src/components/graph/starfield.tsx` | 静态 `Points` 星尘；不参与拾取 |
| `src/components/graph/graph-stage-2d.tsx` | 2D SVG 渲染器；消费同一 `GraphViewModel` + `GraphHighlight` |
| `src/components/graph/graph-status-bar.tsx` | 2D / 3D / 列表共用：`status.failed` 警示 chip + 可展开失败列表（objectId 前 8 位 + 原始 error） |
| `src/components/graph-explorer.tsx` | 容器：并发取 `/api/graph` 与 `/api/graph/status`、组 `GraphViewModel`、写 URL、编排 3D/2D/列表；拆出 inspector / search / qa / minimap；不持有图状态 |
| `src/app/graph/page.tsx` | 页头压缩为 56px 工具条；3D 区全幅；解析 URL `mode/focus/depth`，URL 是视图状态唯一来源（选中不回写 URL） |
| `src/app/graph/error.tsx` | 新增路由级错误边界，3D 异常不拖垮整页（ADR-022 影响面） |
| `src/app/globals.css` | 替换图谱段（2784–3192）；`[data-surface="graph"]` 块内定义 A2.1 的 12 个 `--graph-*` token；3D canvas 容器固定高度 |
| `src/app/api/graph/route.ts` | 透传 `maxNodes`（默认 150，**整数 50–600**，越界 `ValidationError`）；`depth` 已支持 1–3 |
| `src/app/api/graph/status/route.ts` | 无改动；状态条开始渲染 `failed`：警示 chip + 可展开失败列表 + 原始错误 |

**渲染器边界**：3D 组件全部 `"use client"`；`next/dynamic` + `ssr:false`；不在服务端 import three，服务端 chunk 不出现 `THREE`。**不绑定 CBM 的代码符号模型**，只复用「分层 + 视觉 + 交互」思路；如直接复制其代码片段，保留 MIT 版权头。

**组件拆分与数据流**（A/B 并行前必须按此对齐）：A 线容器取数 → `buildGraphViewModel` 只建一次 `GraphViewModel`；`graph-selectors` 从同一份 view 产 `GraphHighlight`；B 线 `GraphScene3D` 与 A 线 `GraphStage2D` 都只读 `view + highlight`。B 线不请求数据、不建 model、不算 degree / type 映射、不做采样；两套渲染器之间没有第二份图状态。

### 10.1 实现契约依赖（Coder 开工前必须有）

以下接口由 **ADR-022 附录冻结**，属于架构契约，不在视觉设计里二次发明（`GraphFailure` 沿用现有 API 字段，不新增模型）。Coder 开始 3D 实现前必须先拿到；如果字段缺失或签名对不上，**停下回到 Architect 修订 ADR**，不要在组件里临时补一套映射。

```ts
// src/lib/graph-model.ts —— 纯函数，不依赖 React / three
export type GraphEntityType = "concept" | "person" | "org" | "work" | "method" | "other";
export type GraphNodeShape =
  | "circle" | "double-ring" | "round-square" | "diamond" | "hexagon" | "dot";
export type GraphColorToken =
  | "--graph-node-concept" | "--graph-node-person" | "--graph-node-org"
  | "--graph-node-work" | "--graph-node-method" | "--graph-node-other";
export type NodeSizeTier = "s" | "m" | "l" | "xl";
export type GraphHop = 1 | 2 | 3;

export interface GraphNode {
  readonly id: string;
  readonly label: string;
  readonly shortLabel: string;       // 中心 12 字 / 其余 10 字，超出加「…」
  readonly type: GraphEntityType;    // 未知类型归 "other"
  readonly rawType: string;          // 只在详情栏展示，不参与逻辑与样式
  readonly shape: GraphNodeShape;
  readonly colorToken: GraphColorToken;
  readonly degree: number;           // 由去重后的 edges 两端计数
  readonly hop: GraphHop;
  readonly size: NodeSizeTier;       // s/m/l/xl，3D 再映射世界半径
  readonly flags: {
    readonly isCenter: boolean;
    readonly isOrphan: boolean;
    readonly isUnreachable: boolean;
    readonly hasDescription: boolean;
  };
}

export interface GraphEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly type: string;             // 关系名，派生
  readonly description: string;      // 关系原文，详情栏不截断
  readonly weight: number;           // 平行关系条数，≥1；不是语义强度
  readonly direction: "none";        // v1 恒为 none，不表达语义方向
  readonly hop: 1 | 2;
  readonly strong: boolean;          // hop === 1 或 weight >= 2
  readonly colorToken: "--graph-edge" | "--graph-edge-strong";
}

export interface GraphFailure {
  readonly objectId: string;
  readonly error: string;            // 沿用 GraphStatus.failed，原样展示
}

export interface GraphMeta {
  readonly center: string;
  readonly depth: GraphHop;
  readonly total: number;
  readonly requestMaxNodes: number;  // 50–600，默认 150
  readonly truncated: boolean;
  readonly truncatedSource: "inferred" | "server";
  readonly failed: readonly GraphFailure[];
  readonly lastSync: string | null;
  readonly dropped: { readonly selfLoops: number; readonly danglingEdges: number; readonly nameless: number };
  readonly sources: { readonly graph: "ok" | "error"; readonly status: "ok" | "error" | "skipped" };
}

export interface GraphViewModel {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  readonly nodeIndex: ReadonlyMap<string, number>;
  readonly meta: GraphMeta;
  readonly modelVersion: number;     // v1 = 1
}
```

```ts
// src/lib/graph-layout-3d.ts —— 纯数学；>300 节点在 Worker 中调用
export interface GalaxyLayoutOptions {
  seedKey: string;   // 只用于缓存/基线命名，不作随机源；随机源只有 hash(id)
  anchors?: Readonly<Record<string, readonly [number, number, number]>>;
  maxTicks?: number; // 默认按节点数分档：80 / 150 / 220
  deadlineMs?: number; // Worker 安全阀，400ms
}

export interface GalaxyLayoutResult {
  readonly positions: Float32Array;  // length = nodes.length * 3
  readonly indexById: ReadonlyMap<string, number>;
  readonly ids: readonly string[];
  readonly radius: Float32Array;     // 每节点包围半径
  readonly bounds: { readonly center: readonly [number, number, number]; readonly radius: number };
  readonly ticks: number;
  readonly truncated: boolean;       // deadline 到或 >2000 降级
  readonly layoutMs: number;
}

export function layoutGalaxy3d(
  view: GraphViewModel,
  options: GalaxyLayoutOptions,
): GalaxyLayoutResult;
```

```ts
// src/lib/graph-selectors.ts —— 邻域/路径唯一真值，渲染器只消费结果
export interface GraphSelection {
  readonly focusId: string | null;   // URL ?focus=，取景中心，不是选中
  readonly selectedId: string | null; // 容器状态，不写 URL
  readonly hoverId: string | null;
  readonly pathTo: string | null;
}

export interface GraphHighlight {
  readonly nodes: ReadonlySet<string>;
  readonly edges: ReadonlySet<string>;
  readonly dimmed: ReadonlySet<string>;
  readonly path: readonly string[] | null;
}

export function selectGraphHighlight(
  view: GraphViewModel,
  selection: GraphSelection,
): GraphHighlight;
```

**3D 对外 props（ADR-022 A7，B 线只暴露这一个组件）**：

```tsx
// src/components/graph/graph-scene-3d.tsx —— 只被 dynamic(..., { ssr: false }) 引入
export interface GraphScene3DProps {
  view: GraphViewModel;
  highlight: GraphHighlight;
  tier: QualityTier;
  autoRotate: boolean;              // 默认 false；reduced-motion 下入口不出现
  onIntent: (intent: GraphIntent, id?: string) => void;
  onReady: (stats: { layoutMs: number; drawCalls: number }) => void;
  onError: (reason: "context-lost" | "chunk-failed" | "webgl-unavailable") => void;
}
```

3D 组件不自己取数、不算邻域、不写 CSS；容器 A 线负责 URL、选中、详情栏与 2D 切换。`GraphIntent = "select" | "focus" | "hover" | "toggle-mode" | "change-depth"`（ADR-022 A4）；`QualityTier` 取 `low | balanced | high`（本文 §8.2）。ADR A7 只引用了 `QualityTier` 而未展开定义，实施前请 Architect 在附录补一行类型来源。

**契约要点**：

1. **共享模型**：3D、2D、列表都消费同一个 `GraphViewModel`；`type→shape/colorToken`、`degree`、`hop`、`size`、截断推断只在 `graph-model.ts` 算一次，抽稀只在 `graph-quality.ts` 的 `decimate(view, budget)` 算一次，渲染器不得各自再推导。2D 力导向坐标由 `graph-layout-2d.ts` 单独算，`graph-layout.ts` 只保留既有 `layoutRadial`；拓扑与视觉映射仍来自同一个模型。
2. **`maxNodes` 直通**：`/api/graph` 校验整数 50–600、默认 150，校验失败与 `depth` 一样返回 `ValidationError`；响应与模型里保留 `meta.requestMaxNodes`。上游 LightRAG 不返回 `truncated`，前端用 `nodes.length >= requestMaxNodes` 推断；`nodes.length < maxNodes` **不能**反证未截断，文案只描述已拿到的事实。正常 API 路径最多 600 节点；`layoutGalaxy3d` 的 >2000 分支是函数级防御，不是接口可请求的上限。
3. **`failed` 必须有 UI**：`status.failed` 现在后端已返回（`GraphFailure = { objectId, error }`）、界面从未渲染；实施时顶部警示 chip「N 个对象抽取失败」，展开显示 `objectId` 前 8 位与原始 `error`（ADR 未提供对象标题，不得自行补名），且不阻塞图谱浏览。
4. **布局确定性**：`layoutGalaxy3d` 对同一 `seedKey` 与同一节点集必须逐点复现；随机源只有 `hash(id)`，`seedKey` 只用于缓存与基线命名；`anchors` 存在时不重排已有节点；`maxTicks` 按 80/150/220 分档，Worker 以 `deadlineMs=400` 收口；超过 2000 输入先截断再布局。
5. **不新增第三套映射**：若 3D 需要额外字段（如 `labelPriority`），先加进 `GraphViewModel` 并回写 ADR，不得在 `graph-scene-3d` 里私算。`GraphEdge.direction` 在 v1 恒为 `"none"`，渲染器不得据关系名猜方向。
6. **选中态不在模型里**：`GraphSelection` / `GraphHighlight` 由 `graph-selectors.ts` 计算；`focusId` 来自 URL 取景中心，`selectedId` 是容器状态（刷新不保留，也**不**写 `focus`）；3D、2D、列表只消费同一份 `GraphHighlight`，不得各自 BFS 或各算一套邻域。
7. **排序也是契约**：`nodes` 按 `(hop 升序, degree 降序, id 升序)`，`edges` 按 `(weight 降序, id 升序)`；抽稀保留顺序，draw 顺序、截图基线、单测逐字节比对都依赖它，A/B 都不得自行重排。边的关系名由 `deriveRelationLabel()` 统一派生，组件不猜。

---

## 11. 验收清单（可测）

### 3D 默认视图

- [ ] 1440×900 首屏：详情收起时画布 ≥1060×780，详情展开时 756×800；星核位于视口中心 ±5%。
- [ ] 三层盘横向占画布宽 70–80%，纵向占 30–50%（盘面倾斜投影）；1 跳环直径约为画布宽的 1/3；不出现节点贴边。
- [ ] 拖拽旋转跟手，松手 0.6s 内停；滚轮缩放 260–1100，无穿模、无翻转；极角 25°–155°。
- [ ] **自转默认关闭**，工具条开关可见；开启后 0.55°/s（60s 转角 33°±3°），`pointerdown` 暂停、静置 8s 恢复；reduced-motion 下开关隐藏。
- [ ] **空闲时 rAF 停止**：`window.__graphStats.rafActive === false`，`frames` 不再增长；交互时恢复。
- [ ] 150 节点 / 300 边 ≥57fps；2000 输入采样到 600 后 ≥30fps；首帧 ≤1.2s。
- [ ] 悬停 160ms 内高亮 1 跳邻域并显示标签；非邻域边 ≤0.06。
- [ ] 双击镜头聚焦 **400ms** 完成，相机距离 320±10；1 跳 1.0 / 2 跳 0.55 / 其余 0.15；`Esc` 400ms 回全局。
- [ ] 选中节点光晕不透明度 0.22（ADR-022 A3.2）；同屏金色 + 暖白强调面积 ≤5%；无过曝白块。
- [ ] 节点颜色 6 类对 `#050408` ≥4.5:1；灰度截图至少 4 类形状可辨；节点为 instanced SDF，不是逐节点 DOM。
- [ ] 边默认 ≤1px、透明度 ≤0.2；选中路径暖白 `#F6E3C6` / 0.8；**不出现方向箭头、不出现移动光点**；reduced-motion 下所有边静态。
- [ ] `window.__graphStats`：`drawCalls ≤8`、`labels ≤40`（high）；three 只出现在 `/graph` 懒加载 chunk，服务端 chunk 无 `THREE`。
- [ ] 连续进出 `/graph` 3 次，内存不持续增长；canvas 数量在 3D 下为 1。

### 2D 切换与降级

- [ ] **单击节点不切 2D**：`mode` 不变，只高亮 + 打开详情；2D 只能由「聚焦阅读」、快捷键 `2` 或降级进入。
- [ ] `/graph?mode=3d&focus=<实体>&depth=2` 刷新/后退能恢复取景；单击选中只改 `selectedId`，不改 `mode`、不写 `focus`；双击/镜头聚焦才写 `focus`。
- [ ] 「聚焦阅读」320ms 内完成，选中与筛选保持；「返回星系」恢复原轨道角度。
- [ ] 禁用 WebGL → 自动 2D，无报错弹窗；「重试 3D」可用。
- [ ] `prefers-reduced-motion` → `mode=2d`，canvas 数量 0，3D 入口隐藏，自转/移动光点为 0。
- [ ] 390×844 / 触屏 → 默认 2D，画布 ≥286 宽，标签不重叠；**页面没有「试试 3D」入口**。
- [ ] 3D 模块加载超时 4s → 切 2D + toast；不白屏、不跳版。
- [ ] 页面隐藏 2s 后 `rafActive=false`、`frameloop=never`；回到前台恢复。

### 交互与状态

- [ ] 搜索 `⌘K` 全键盘完成「输入 → 选中 → 镜头聚焦」。
- [ ] 类型筛选变暗 180ms，节点位置不动；3D 下不参与拾取。
- [ ] 0 实体 / 抽取中 / 部分失败 / 无邻居 / 服务错误 / 超限 六种状态均有主行动，不出现「暂无数据」。
- [ ] **部分失败**：顶部 chip 显示「N 个对象抽取失败」，展开可见 `objectId` 前 8 位与 LightRAG 原始错误，图谱仍可浏览。
- [ ] **超限**：`maxNodes` 50–600 校验生效；`nodes.length >= requestMaxNodes` 显示「已展开最近 N 个实体」；>2000 输入显示截断提示。
- [ ] 问答中的实体 chip 可点击并聚焦；展开高度 ≤70%。

### 可访问性

- [ ] 键盘可完成：进入画布（`Tab`）→ 选中实体 → 打开详情 → `2` 切 2D → 返回。
- [ ] 3D 容器有 `tabIndex=0`、`role="img"`、`aria-label` 与模式播报；列表视图与画布同源。
- [ ] 3D 不承诺逐节点 Tab 导航；2D/列表提供完整逐节点遍历。
- [ ] 页面 200% 缩放无横向溢出。
- [ ] 3D 连续运行 10 分钟无内存持续增长（≤10%）。

---

## 12. 文案表

| 位置 | 文案 |
|---|---|
| 工具条计数 | `36 个实体 · 128 条关系` |
| 视图按钮 | `聚焦阅读` / `列表` |
| 状态 chip | `已同步 36` / `抽取中 7/24` / `3 个失败` / `服务未连接` |
| 空态标题 | `图谱还是空的` |
| 空态正文 | `同步后，系统会从有正文的对象里抽取实体与关系，只在本账号可见。` |
| 空态步骤 | `① 同步内容 ② 等待抽取 ③ 点击星点开始探索` |
| 无邻居 | `这个实体还没有已抽取的关系。` |
| 无邻居行动 | `展开第三层` / `换一个实体` |
| 搜索占位 | `搜索实体，⌘K` |
| 问答占位 | `问图谱：例如「设计系统里品牌色是怎么定义的？」` |
| 降级提示 | `3D 视图不可用，已切换到 2D。` |
| 采样提示 | `已展开最近 600 个实体，聚焦可查看局部全量。` |
| 截断提示 | `输入超过 2000 个实体，已截断；缩小范围可查看更完整。` |
| 服务错误 | `图谱服务没有响应。检查本机 LightRAG 后重试。` |
| 无权限 | `你没有查看图谱的权限，请联系管理员。` |

---

## 13. 与首页 / ADR-020 / ADR-022 的一致性

| 项 | 首页 | 图谱 3D | 一致 |
|---|---|---|---|
| 底色 | `#050408` | 同 | ✓ |
| 强调色 | 暖金 `#E9C08A` | 选中/路径暖白 `#F6E3C6`；星核暖白 `#F6E3C6` | ✓（同族，选中不与概念金同值） |
| 辅助色 | 尘埃棕、灰紫 | 6 类实体色 | ✓ |
| 发光 | additive、外缘压暗 | 光晕 0.22、**无后处理/Bloom** | ✓ |
| 运动 | 90s 自转 | **默认关**，开启后 0.55°/s，可暂停 | ✓（更慢） |
| 背景 | 一颗大星系 | 只有星尘 + 极淡核光 | ✓（不抢） |
| WebGL | 仅首页 | `/graph` **受控例外**（ADR-022） | ✓（已裁决） |
| 字体/圆角/间距 | Inter / 14 / 4 倍数 | 同 | ✓ |
| Token 范围 | ADR-021 的 129 名契约（98 主题语义 + 31 几何） | `[data-surface="graph"]` 下的 `--graph-*`，不扩主题 | ✓（隔离） |

**ADR 状态**：ADR-022 已采纳（`docs/03_DECISIONS.md`，2026-11-12），`/graph` 的子页面 WebGL 例外成立；ADR-021 是主题 token 契约，与本次 3D 例外无关。实现必须同时满足 ADR-022 的四条硬约束：懒加载、可暂停、reduced-motion 降级 2D、页面隐藏即停。

**ADR 同步提示**：已同步 ADR-022 A2.1 / A8；`--graph-accent` 已回写为 `#F6E3C6`，A2.1 的 12 个 token 为唯一舞台色集。A8 中引用的旧稿章节号（§2「不做 3D」、§14 C1 等）是历史记录，以本文 v2 为准。

---

## 14. 与 CBM Lens 的对齐与差异

| 维度 | CBM Lens | 本设计 | 处理 |
|---|---|---|---|
| 场景分层 | GraphScene / NodeCloud / EdgeLines / NodeLabels / HaloLayer / density | 同构，多一层 Starfield | 借鉴结构 |
| 节点尺寸 | 源码规模 + fan-in | 度数（由 `GraphViewModel` 统一算） | 借鉴思路 |
| 方向表达 | 边颜色 + 脉冲 | LightRAG 边无方向语义：默认不画箭头、不加移动光点；选中单条在详情给原文 | 按 ADR-022 更克制 |
| 3D 标签 | 有 | Canvas 纹理图集 + instanced Sprite，40/24/12 | 自研，不引 drei |
| 依赖 | three + fiber + drei 等 | three 0.187.0 + fiber 9.8.2，无 drei/postprocessing | 更小依赖面 |
| 数据模型 | 代码实体（文件/符号/路由） | 资产实体（6 类语义） | 不复用 |
| 代码阅读器 | Monaco | 无 | 不做 |
| 本地问答 | on-device 模型 | 现有 LightRAG | 复用现有 |
| 许可 | MIT | 只借鉴视觉/结构，重写实现 | 如复制代码保留版权头 |

---

## 15. 风险

| # | 风险 | 触发 | 应对 |
|---|---|---|---|
| R1 | **实现偏离 ADR-022** | 组件内另算类型/度数、自转默认开、URL 被本地 state 覆盖 | ADR 为架构基线；§10.1 契约冻结；验收逐条对照 |
| R2 | 3D 标签遮挡 | 节点密集 | Canvas 纹理图集 + 40/24/12 预算 + 2D 阅读；3D 不承诺全量可读 |
| R3 | 晕动/眩晕 | 自转 + 拖拽 | 自转默认关、0.55°/s、无漫游、可暂停、reduced-motion 降级 2D |
| R4 | 弱机掉帧 | 输入 2000 / 集显 | 档位采样到 600/300/150、instanced、DPR 上限、low 档 |
| R5 | 首包变大 | three + fiber | 懒加载 + 探针后再下载 + 共享缓存；首屏不阻塞 |
| R6 | 与首页 three 版本不一致 | 版本漂移 | 精确锁 `three@0.187.0`，fiber `^9.8.2` |
| R7 | 3D 位置不可复现 | 随机布局 | 三层盘播种（`360°/n` + `hash(id)` 抖动）+ 确定性松弛 + 布局缓存 + `anchors` |
| R8 | 金色/辉光滥用 | 全选金色 | 暖白给星核/选中环/路径；金色只给概念类型；光晕上限 0.22；无 Bloom |
| R9 | 2D 与 3D 状态不同步 | 两套渲染各自映射 | 单一 `GraphViewModel`；切换只换渲染器 |
| R10 | 上下文丢失黑屏 | GPU 重置 | 首次自动恢复，再次切 2D；不自动切回 |
| R11 | 移动端误开 3D | 入口残留 | 触屏/<768/ reduced-motion 一律隐藏 3D 入口；验收检查 DOM |
| R12 | 失败状态再次漏渲染 | 只做 chip 不做列表 | `status.failed` 必须有 chip + 可展开原始错误；验收必测 |
| R13 | 中文字形在纹理图集里发糊 | Canvas 字体/DPR | 图集按 DPR 生成、字号 ≥22px 再缩小、限制 40 个标签 |

---

## 16. 变更记录

| 日期 | 版本 | 变更 |
|---|---|---|
| 2026-11-12 | v1 | 2D 全幅画布 + 浮动分析层；现状审计 16 条；状态/性能/无障碍/验收 |
| 2026-11-12 | **v2** | 按 `15_GRAPH_UI_RESEARCH.md` 改为 **3D 银河主视图 + 2D 聚焦阅读**；新增相机/节点/边/采样/降级规范；v1 2D 稿保留为 §5 与降级方案；标注 ADR-020 例外依赖 |
| 2026-11-12 | **v2.1** | 按 **ADR-022** 校准：选中不切 2D、URL 单一状态源、自转默认关、移动端隐藏 3D 入口、three 0.187.0 + fiber 9.8.2（无 drei/postprocessing）、Canvas 纹理标签、`frameloop="demand"`、600/1200 档位、`GraphViewModel` 与 `layoutGalaxy3d` 契约、`maxNodes` 50–600、`status.failed` UI；视觉参数保留 |
| 2026-11-12 | **v2.2** | ADR-022 收尾：§10.1 契约块替换为附录 A2/A3/A4/A7 原文；补 `GraphSelection` / `GraphHighlight` / `GraphScene3DProps`；补 A2.1 的 12 个舞台 token；`--graph-accent` 定为暖白 `#F6E3C6`，选中环/路径不再与概念金同值；修正 `focus` 语义（取景中心，不是选中；选中不回写 URL）；R7 改为三层盘播种 |
