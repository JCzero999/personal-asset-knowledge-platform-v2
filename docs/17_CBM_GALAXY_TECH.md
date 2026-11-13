# 17. CBM Lens Galaxy 3D 场景技术拆解（codebase-memory-mcp）

> 调研日期：2026-11-12（Asia/Shanghai）
> 数据来源：GitHub API + contents API 直接抓取源码（非 README）。上游 `DeusData/codebase-memory-mcp` @ `main`，最近提交 2026-11-11；`graph-ui/` 即 npm 包 `cbm-lens@0.0.1`（`private: true`）。
> 性质：实现级调研，仅拆解给 Coder 参考；不写产品代码、不改数据模型、不提交、不碰 `docs/03_DECISIONS.md`。
> 许可：仓库根 `LICENSE` = MIT（Copyright (c) 2025 DeusData）；`graph-ui/THIRD_PARTY.md` 声明 Galaxy 场景系自 `CodeAtlasIDE`（作者 Bernhard Jackiewicz）移植，整体仍为 MIT。

## 0. 一页结论摘要

- Galaxy 的"高级感"来自四件可复刻的事：**服务端预计算 3D 坐标**（确定性、无客户端力导向）、**节点按度数映射恒星光谱色 + 发光叠加（Bloom）**、**边用 additive 线 + 方向脉冲 shader**、**标签用 Canvas 纹理 Sprite（非 DOM）做 top-N LOD**。
- 数据契约很小：节点 `{id,x,y,z,label,name,size,color,...}`，边 `{source,target,type}`；`color`/`size` 由后端 `layout3d.c` 按度数算好，前端只负责画。对我们只需把 LightRAG 的 entity/relation 映射成同形结构，**自己产坐标、自己算色**。
- 渲染核心可整体借鉴：`instancedMesh` 球 + 顶点色（>7.5 万才切 point sprite），`lineSegments` + `AdditiveBlending`（1px 线，粗细靠亮度而非几何），`THREE.Sprite` 标签，`HaloLayer` 地标光晕，`@react-three/postprocessing` Bloom。
- 布局不要照搬：上游没有浏览器端力导向（Galaxy 坐标全在 C 端 `layout3d.c` 算好）；我们几十~几千节点，直接在 Web Worker 里跑一个确定性弹簧/聚类即可（可参考其 `organic-clusters.ts`）。
- 必改项：砍掉所有"代码实体"耦合（`file_path`/`start_line`/`qualified_name`、Monaco、twin、coverage shadow、agent 层、branch 节点），只保留场景五件套 `GraphScene/NodeCloud/EdgeLines/NodeLabels/HaloLayer` + `density` + 相机/取景。

---

## 1. 目录与组件分层

全部在 `graph-ui/src/`，Galaxy 主目录 `galaxy/`，共享的图工具在 `graph/`。

| 文件 | 职责 | 关键 props / 数据流 |
|---|---|---|
| `galaxy/GalaxyPanel.tsx` | 面板壳：加载、焦点、高亮、图例/过滤、显示设置，把状态编排后喂给场景 | `loadLayout(/api/layout)` → `GraphData` → `<GraphScene data=... highlightedIds cameraTarget ...>`；回调 `onNodeClick/onRenderBusyChange/onLabelLayout` 回传 |
| `galaxy/GraphScene.tsx` | 场景装配器：`<Canvas>`、相机、`OrbitControls`、Bloom、各层挂载、`CameraAnimator`、`IdleAutoRotate`、`FrameCapDriver`、`FitProbe`、`ScreenNodeSeparation`、`RootMarkers`/`PathFrame` | props 见第 5、6 节 |
| `galaxy/NodeCloud.tsx` | 节点云：instanced 球 / point sprite 两档 | `nodes, highlightedIds, onHover, onClick, opacity, boost` |
| `galaxy/EdgeLines.tsx` | 边：`lineSegments` + additive + GPU 脉冲 shader，叠加 `EdgePulseLayer` 箭头 | `nodes, edges, highlightedIds, brightness, ...` |
| `galaxy/NodeLabels.tsx` | 节点名：`THREE.Sprite` + Canvas 纹理，top-N LOD | `nodes, highlightedIds, maxLabels=80, maxDistance` |
| `galaxy/HaloLayer.tsx` | 地标光晕：12 个最大节点的 additive 光圈 | `nodes` |
| `galaxy/density.ts` | 密度自适应缩放与显示设置：`edgeIntensityScale/nodeBoostScale/bloomIntensityScale/nodeGlowBoost` | 纯函数，无 React |
| `galaxy/PathLayer.tsx` | 路径/调用链高亮层：独立线 + DOM 边标签避让 | `nodes, path, namedRoots` |
| `galaxy/ScreenNodeSeparation.tsx` + `projected-node-spacing.ts` | 屏幕空间避让（显示层位移，不改坐标/身份） | `nodes, active, onChange, pinned` |
| `galaxy/camera-frame.ts` | 取景数学：`frameDistance/orthographicZoom/fitCamera/containShift` | 纯函数 |
| `galaxy/frame-rate.ts` | 帧率窗口测量与报告 | `FRAME_WINDOW_MS=500` |
| `galaxy/layout-source.ts` + `galaxy-model.ts` | 数据加载与模型；`LAYOUT_NODE_BUDGET=5000`、`/api/layout` | `loadLayout(project)` |
| `galaxy/galaxy-legend.ts` | 图例文案 + 边类型计数 + 过滤（`withoutEdgeKinds`） | `data, hidden` |
| `galaxy/types.ts` | `GraphNode/GraphEdge/GraphData` 类型 | — |
| `graph/edge-style.ts` | 边颜色表 `EDGE_TYPE_COLORS`、方向判定 `isDirectedEdge`、相位哈希 `edgePhase` | — |
| `graph/edge-motion.ts` | 脉冲开关：用户偏好 + `prefers-reduced-motion` + 页面可见性 | `useEdgeMotion(active)` |
| `graph/EdgePulseLayer.tsx` | 边上的箭头/脉冲叠加层 | `paths, active` |
| `galaxy/organic-clusters.ts` + `organic-layout.worker.ts` | **另一种**布局：确定性粒子-弹簧聚类，跑在 Web Worker（架构视图用，Galaxy 不用） | — |
| `galaxy/hierarchy-layout.ts` | 调用深度列布局（Hierarchy 视图用，Galaxy 不用） | — |

数据流一句话：`GalaxyPanel` 自己调 `/api/layout` 拿到 `GraphData` → 交给 `GraphScene` → 拆给 `EdgeLines/NodeCloud/NodeLabels/HaloLayer`；交互（hover/click/背景点击）通过 props 回传面板，面板维护 `highlightedIds`（邻居集）与 `cameraTarget`（飞向目标）。

---

## 2. 节点渲染

### 2.1 几何体：instanced 球（默认）与 point sprite（超大图）

`NodeCloud.tsx` 两档切换，阈值 `POINT_MODE_THRESHOLD = 75000`：

- `<75000`：`instancedMesh` + `sphereGeometry` + `meshBasicMaterial vertexColors toneMapped={false}`，`frustumCulled={false}`，`key={nodes.length}` 强制重挂载（保证 buffer 尺寸正确）。
- `>=75000`：`<points>` + `bufferGeometry` + `pointsMaterial size={4} sizeAttenuation map={getPointSprite()} alphaTest={0.35} transparent toneMapped={false}`。

球细分按节点数降级（`sphereDetail(count)`）：

| 节点数 | `[radial, widthSegments, heightSegments]` |
|---|---|
| <= 8000 | `[1, 32, 24]` |
| <= 25000 | `[1, 16, 12]` |
| 其余 | `[1, 10, 7]` |

实例矩阵只随"节点集或高亮"变化（坐标静态），`useEffect([nodes, highlightedIds])` 里一次性写 `setMatrixAt`，非逐帧。尺寸：`scale = node.size * (isHighlighted ? 0.5 : 0.2)`——高亮节点放大、未高亮缩小，形成对比。

point sprite 是懒加载的 64px Canvas 径向渐变纹理（中心白 → 边缘透明），模块级单例。

### 2.2 材质、shader 与颜色/尺寸映射

关键点：**节点不写自定义 shader**，颜色是"预先按语义算好 + 逐实例顶点色"，辉光是"把颜色推到 >1 让 Bloom 捡起溢出"。

- 基色来自服务端：`tempColor.set(node.color)`；`node.color` 由后端 `layout3d.c` 的 `stellar_color(degree)` 生成——**按度数映射恒星光谱类**：边少=红矮星、边多=蓝巨星。`node.size` = 每种 `label` 的基础尺寸 + 度数加成，也是服务端算好。
- 高亮衰减：有高亮集且该节点不在集内 → `multiplyScalar(0.15)`（暗到 15%）。
- 发光放大（`nodeColor`）：`applied = 1 + (nodeGlowBoost(r,g,b) - 1) * boost`，再乘 `opacity`。`nodeGlowBoost`（`density.ts`）按**通道主导性**而非亮度给增益：

```ts
const GLOW_BASE = 1.35, GLOW_BLUE_GAIN = 2.4, GLOW_RED_GAIN = 0.9;
const blueness = Math.max(0, b - Math.max(r, g));   // 蓝主导=枢纽，增益最强
const redness  = Math.max(0, r - Math.max(g, b));   // 红主导=叶子，适度增益
return GLOW_BASE + blueness * GLOW_BLUE_GAIN + redness * GLOW_RED_GAIN;
```

这样蓝色 hub 最亮、红叶子次之、白/黄（本身亮度高、容易过曝）最少——避免"亮度加权"导致白黄先爆掉。

### 2.3 光晕叠加：HaloLayer（独立 Points）+ Bloom（后处理）

- `HaloLayer.tsx`：`HALO_COUNT = 12`，取 `size` 最大的 12 个节点作为地标，`PointsMaterial`：`size = max(node.size)*6`、`vertexColors`、`opacity=0.28`、`AdditiveBlending`、`depthWrite=false`、`sizeAttenuation`，贴同一张 128px 径向渐变纹理。用途是"漫游时的稳定视觉锚点"，不是每个节点都有。
- 整体 Bloom 在 `GraphScene` 的 `EffectComposer`：

```tsx
<EffectComposer multisampling={0}>
  <Bloom luminanceThreshold={0.3} luminanceSmoothing={0.7}
         intensity={bloomIntensity} mipmapBlur radius={0.6} />
</EffectComposer>
```

`bloomIntensity = BASE_BLOOM_INTENSITY(1.45) * bloomIntensityScale(nodes.length) * display.bloom`。

所以辉光 = 「节点色增益喂给 Bloom 阈值」+「12 个地标光圈」两层，不是每节点单独 postprocessing。

---

## 3. 边渲染

`EdgeLines.tsx`：`createEdgeGeometry` 一次性构建 `position/color/edgeFlow` 三个 attribute，`<lineSegments>` + `lineBasicMaterial`：

```tsx
<lineBasicMaterial vertexColors transparent opacity={opacity}
  blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false}
  onBeforeCompile={prepareMaterial} customProgramCacheKey={() => 'directed-edge-pulse-v1'} />
```

### 3.1 线宽与性能取舍

- 用 `lineSegments` 的 **1px 细线**（WebGL 原生线宽），**不用 Line2/LineMaterial** 做粗线。视觉厚度靠 additive 混合的亮度堆叠，不靠几何加粗——这是它能在几万边下不炸的关键取舍。
- `depthWrite=false` 让边不写深度、互相叠加；`toneMapped=false` 保证颜色不被色调映射压掉。
- 同簇/跨簇用不同强度（`getClusterKey` 取 `file_path` 前两段判断是否同簇）。

### 3.2 颜色与强度曲线

颜色按**边类型**取 `edgeColor(edge.type)`（`graph/edge-style.ts` 的 `EDGE_TYPE_COLORS`，见第 9 节完整表），`colorByType` Map 缓存。

强度曲线（`edgeIntensityFor`，重点在"少边时更亮、多边时压暗"）：

| 边数 | 簇内 | 簇外 | 说明 |
|---|---|---|---|
| 178 | 0.62 | 0.30 | `EDGE_FULL_COUNT=2000` 以下恒定 |
| 2000 | 0.62 | 0.30 | 分界点 |
| 8000 | 0.206 | 0.070 | 对数插值段 |
| 30000+ | 0.0722 | 0.0173 | `EDGE_WASH_COUNT=30000` 以上回到原版 `0.25/0.06 * edgeIntensityScale` |

`edgeIntensityScale`（`density.ts`）= `max(0.05, sqrt(2500/edgeCount))`——约 `1/√n`，4 倍边数让每条亮度减半、总辉光持平，防止中心烧成白块。用户亮度乘数 `brightness` 叠在上面。

**焦点分支**：有高亮时，选中邻域边用 `EDGE_INTENSITY_FOCUS=0.5`（不参与密度缩放），其余 `EDGE_INTENSITY_MUTED=0.04 * densityScale`。

### 3.3 方向脉冲（GPU shader，不重建几何）

`prepareMaterial` 通过 `onBeforeCompile` 注入：`edgeFlow` attribute（相位/方向）+ `edgeTime` uniform（`useFrame` 里按 `performance.now()` 累加，非帧数，保证帧率封顶后速度不变）。脉冲周期 `EDGE_PULSE_SECONDS = 4.8`，一条软带沿 source→target 行进：

```glsl
float edgeHead = fract(edgeTime / 4.8 + vEdgeFlow.y) * 1.24 - 0.12;
float edgePulse = 1.0 - smoothstep(0.0, 0.10, abs(vEdgeFlow.x - edgeHead));
diffuseColor.rgb *= 0.72 + 0.28 * edgeMotion * vEdgeFlow.z * edgePulse;
```

- 只有有向边（`isDirectedEdge`）才脉冲（`vEdgeFlow.z`）。
- `edgePhase` 用 FNV-1a 哈希对每条边 id 生成确定性相位，避免全图同闪。
- `edgeMotion` uniform 由 `useEdgeMotion` 控制（用户关 / `prefers-reduced-motion` / 页面隐藏 → 0），暂停不重建几何。
- 另有 `EdgePulseLayer` 在边旁画箭头标记；reduced-motion 时显示静止箭头保持方向可见。

---

## 4. 标签

`NodeLabels.tsx`：用 **`THREE.Sprite` + Canvas 纹理**，不用 `drei Html`、不用 troika。（路径/根标记名才用 `drei Html`，见第 6 节。）

- **显示谁**：无高亮时按 `size` 排序取前 `maxLabels=80`；有高亮时只显示高亮节点（仍按 size 排序截断）。即"纯 top-N LOD"，没有基于屏幕大小的自适应字号分级。
- **纹理构建**：Canvas 2D，字体 `600 64px Inter, system-ui, ...`，`fillStyle=node.color`、描边 `rgba(0,0,0,0.9)` 8px、内边距 24/14；`pixelRatio = min(devicePixelRatio, 2)`；`texture.colorSpace = SRGBColorSpace`、`LinearFilter`、不生成 mipmap。文本超宽用二分截断加 `...`。
- **世界尺寸**：`worldFontSize = fixed ?? max(1.8, node.size * 0.4)`；sprite 放在节点上方 `node.y + node.size*0.7 + worldHeight/2`，`renderOrder=20`、`frustumCulled=false`、`spriteMaterial transparent depthWrite=false toneMapped=false`。
- **距离 LOD（W10 新增）**：`maxDistance`（= `labelDistanceFactor * sceneRadius`）为 0 时不限制；>0 时在 `useFrame` 里做 `camera.distanceTo(sprite.position) <= maxDistance` 的距离判断，**只 `sprite.visible=false` 不卸载**（纹理留着，回拉不重建）。最多 80 次距离计算，比多余 draw call 便宜。
- 节点名之间**不做避让**；避让是给"路径边标签"和"根标记名"单独做的（见第 6 节）。

---

## 5. 布局与相机

### 5.1 节点坐标怎么来

**Galaxy：服务端预计算，不是浏览器力导向。** `layout-source.ts` 只负责 `fetch('/api/layout?project=X&max_nodes=5000')` 并严格校验字段；坐标/尺寸/颜色全部由后端 C 代码 `layout3d.c` 产出（`graph-ui/src/galaxy/galaxy-legend.ts` 注释明确）。`galaxy-model.ts`：`LAYOUT_NODE_BUDGET = 5000`。性质是**确定性**："same index gives same sky"，客户端零布局成本，这是场景能这么小的原因。

客户端另有两套布局（供其它视图，**不是 Galaxy**）：

- `organic-clusters.ts`（跑在 `organic-layout.worker.ts`）：确定性多级粒子-弹簧聚类——网格邻域斥力 + 有界弹簧引力 + 固定迭代预算（`relax(..., passes, 190/56, ...)`），几何结果带缓存（`MAX_GEOMETRY_ENTRIES=4`、`MAX_GEOMETRY_WEIGHT=100_000`）。**这是我们自算坐标时可借鉴的算法**。
- `hierarchy-layout.ts`：调用深度列投影（Hop=列、名字序=行），纯确定、无随机、无时钟。

### 5.2 相机

- Canvas 默认相机：`position [0,0,800]`、`fov = GRAPH_CAMERA_FOV = 50`、`near 0.1`、`far 100000`。
- 光照：`ambientLight 0.5` + 两个 `pointLight`（`[500,500,500] 0.6`、`[-300,-200,-300] 0.4 color #6040ff`）。因节点用 `meshBasicMaterial`，光只影响场景里少数的非 basic 元素，主要是氛围。
- 背景 `#0D0F12`，`gl={{ antialias:false, alpha:false, powerPreference:'high-performance' }}`，`dpr={[1, 1.5]}`。

### 5.3 OrbitControls 参数

```tsx
<OrbitControls enableDamping dampingFactor={0.08} rotateSpeed={0.5} zoomSpeed={1.5}
  zoomToCursor autoRotateSpeed={0.4} enableRotate={!flat}
  minDistance={Math.max(5, sceneRadius * 0.02)}
  maxDistance={Math.max(sceneRadius, orbitReach) * 4} />
```

要点：阻尼 0.08（丝滑）；`zoomToCursor`（缩放跟随鼠标指针而非中心）；`autoRotateSpeed=0.4`；距离边界随场景实际包围盒（`sceneRadius`/`orbitReach`）自适应。

### 5.4 初始取景与聚焦动画

- **整体拟合**：`computeFitTarget` → `fitCamera`（`camera-frame.ts`）用 `principalFrame` 求点云最大投影面，把相机垂直放在该面前、远到全装下（`FRAME_MARGIN=1.12`、`FRAME_MIN_DISTANCE=40`）。`immediate:true` 直接到位。
- **聚焦单点/邻居**：`computeCameraTarget` 取节点集质心，`distance = max(minDist, maxDist*3)`，`minDist = count<=5 ? 300 : 200`，相机放到 `center + (0.2, 0.15, 1)*distance` 的斜上方。
- **飞行动画 `CameraAnimator`**：`progress += delta * FLY_PROGRESS_PER_SECOND(1.2)`；缓动 `ease-out cubic`（`t = 1-(1-p)^3`），每帧 lerp 分数 `1-(1-0.08*t)^(delta*60)`；`FLY_MAX_DELTA=0.1` 防止切回标签页一次跳完。同步 lerp `OrbitControls.target`（否则下一次 `update()` 会把相机拉回原点）。另有 `spring` 变体（临界阻尼弹簧，给跟随 agent 的相机用，`springStep` in `agents/agent-motion.ts`）。
- **空闲自转**：`IdleAutoRotate`，`IDLE_TIMEOUT_MS=60_000` 无 `pointerdown/wheel` 后开启 `autoRotate`。
- **二次取景 `FitContainment`**：scope 展开后不重新 fit，而是沿视线方向后退/前进让最外节点贴边（`containShift`），保持方向与上向量。

---

## 6. 交互与状态

- **拾取**：r3f 的 `onPointerOver/onPointerOut/onClick`，instanced 球用 `e.instanceId`，points 用 `e.index`；point 模式把 raycaster 阈值放宽到 `raycaster.params.Points = { threshold: 3 }`。点击空背景触发 `onBackgroundClick`（清焦点）。
- **hover**：`hovered` 节点 → `NodeTooltipCard`，内容是布局数据里现成的 `name/label/file_path/fan-in/fan-out/lines/status`，**不额外请求**。DOM 通过 `hover-layer.tsx` 的 portal 挂到 Canvas 外的覆盖层（`HOVER_LAYER_Z_INDEX=28`），保证卡片盖在场景面上、又低于工具栏/搜索/菜单。
- **selected/path 高亮**：面板维护 `highlightedIds`（= 选中节点 + 直接邻居，`galaxy-model.neighbourIds` 双向一步）。节点未命中 ×0.15、边命中 0.5/未命中 0.04，高亮不参与密度缩放。`PathLayer` 单独画路径线（`depthTest=false`、`renderOrder=18`，当前步向白色 lerp 0.55）。
- **聚焦**：点击节点 → 面板更新 `cameraTarget` → `CameraAnimator` 飞过去（见 5.4）。
- **筛选**：图例即过滤器（`galaxy-legend.ts` 的 `withoutEdgeKinds`），在"数据进场景之前"过滤边；节点保留（"隐藏的是关系类型，不是符号"）。`edgeKinds` 统计真实出现过的类型并按出现次数降序。
- **reduced-motion**：`useEdgeMotion` = 用户开关 && `!prefers-reduced-motion` && `!document.hidden`；关掉即停边脉冲（`edgeMotion=0`），`EdgePulseLayer` 显示静止箭头。
- **WebGL 不可用降级**：**上游没有专门的 2D 降级**（代码假设 WebGL 可用，Canvas 直接失败）。已有的"降级"是性能/可访问性开关：`flat` 正交投影（丢 z 轴）、`drawEdges=false` 不挂边层、`halos/bloom=false`、`frameCap=30`（`THRIFTY_GRAPH_DISPLAY` 一键组合）。面板折叠时 `frameloop="never"` 但**不卸载 Canvas**，保住 WebGL 上下文。

---

## 7. 性能参数汇总

| 参数 | 值 | 位置 |
|---|---|---|
| 节点预算 | `LAYOUT_NODE_BUDGET = 5000`（后端最多回 5000） | `galaxy-model.ts` |
| 球 → point sprite 阈值 | `75000` | `NodeCloud.tsx` |
| 球细分降级 | 8000→`[1,32,24]`；25000→`[1,16,12]`；其余→`[1,10,7]` | `NodeCloud.tsx` |
| 标签上限 | `maxLabels = 80`（top-N by size） | `NodeLabels.tsx` |
| 标签距离 LOD | `labelDistanceFactor * sceneRadius`（0=关） | `GraphScene.tsx` |
| 地标光晕 | `12` 个，`size = max(size)*6`，opacity `0.28` | `HaloLayer.tsx` |
| 边强度基准/拐点 | 2500 起 `~1/√n`；全亮≤2000、原版曲线≥30000 | `density.ts` / `EdgeLines.tsx` |
| 节点/光晕 fade | ≤25000 全亮；25000→250000 缓降到 0.8/0.7 | `density.ts` |
| Bloom | threshold `0.3`、smoothing `0.7`、intensity `1.45*scale*user`、mipmapBlur、radius `0.6` | `GraphScene.tsx` |
| DPR | `[1, 1.5]`（上限 1.5） | `GraphScene.tsx` |
| 帧率策略 | `frameloop`：inactive=`never`；cap>0=`never`+`FrameCapDriver` rAF 定时 `advance`；否则 `always`；cap 可选 `[0,60,30]` | `GraphScene.tsx` / `density.ts` |
| 帧率测量 | 500ms 窗口、16 个样本、噪声带判定 | `frame-rate.ts` |
| 百万级节点的实际做法 | **不在浏览器**：百万级是后端的 28M LOC 全量索引；前端只拿 top-5000 布局（截图里几万节点已是 point-sprite 档） | `layout3d.c` / README performance |

关键取舍：**坐标静态 → 实例矩阵只在数据/高亮变时写**；**屏幕避让只在数据或相机变后、debounce 100ms 才算**（`ScreenNodeSeparation`）；**标签距离判断用 `visible=false` 而非卸载**；**脉冲走 uniform 不重建几何**。

---

## 8. 适配我们项目（LightRAG entity/relation，几十~几千节点）

### 8.1 数据模型映射

我们：entity（名称、类型、degree/权重、描述、向量） + relation（source、target、type、weight、description）。上游类型见 `galaxy/types.ts`：

```ts
GraphNode { id, x, y, z, label, name, size, color, file_path?, qualified_name?, ... }
GraphEdge { source, target, type, offset? }
```

映射建议（Coder 可据此建一层 adapter，不改我们数据库 schema）：

- `GraphNode.name` = entity 名；`label` = 实体类型（person/org/topic/project…，用于基础尺寸与图例）。
- `GraphNode.size` = 基础尺寸 + `k * log(degree)`（degree 用 LightRAG 入度+出度，或关系权重和）。
- `GraphNode.color` = 自算的 `stellar_color(degree)` 光谱色（见 8.3）。
- `GraphEdge.type` = relation 类型（如 `KNOWS/OWNS/MENTIONS`），直接用其 `EDGE_TYPE_COLORS` 思路自建调色板；`weight` 可映射为边亮度/脉冲相位的输入。
- `x/y/z`：我们没有 `layout3d.c`，需**自算**。几千节点用 Web Worker 跑确定性弹簧/聚类（参考 `organic-clusters.ts`），小图（<500）用球面/环形+轻度斥力即可，保证"同一数据同一张图"。

### 8.2 清单：直接可用 / 要改 / 不要学

**直接可用（搬逻辑，改写语言/命名）**
- `NodeCloud.tsx` 的 instanced 球 + 顶点色 + `nodeGlowBoost` 通道增益（我们的规模始终走 instanced 球，point-sprite 分支可删）。
- `EdgeLines.tsx` 的 `lineSegments` + `AdditiveBlending` + `edgeIntensityFor` 强度曲线 + GPU 脉冲 shader（4.8s 有向脉冲）。
- `NodeLabels.tsx` 的 Sprite+Canvas 纹理 top-N LOD（`maxLabels` 改小，如 50）。
- `HaloLayer.tsx` 12 个地标光圈。
- `GraphScene.tsx` 的 Bloom 参数、OrbitControls 参数、`CameraAnimator` 缓动、`IdleAutoRotate`、`computeCameraTarget`、`frameDistance/fitCamera`。
- `density.ts` 的 `edgeIntensityScale/nodeBoostScale/bloomIntensityScale` 三条自适应曲线（小图直接恒定分支）。
- `ScreenNodeSeparation`（若实体密集重叠）。

**要改（适配而非照搬）**
- 数据源：`/api/layout` → 我们的实体/关系查询（本地 SQLite/Drizzle 读 entity+relation，一次算布局，缓存结果）。
- 布局：自算坐标（Web Worker），不依赖 `layout3d.c`。
- 颜色/尺寸：自算 `stellar_color(degree)` 与 size 映射；`label` 语义换成实体类型。
- `file_path/start_line/qualified_name/twin` 全部去掉，点击改为"打开实体详情/聚焦邻居"，hover 卡片只显示类型+degree+描述摘要。
- 图例/过滤：保留"图例即过滤器"，条目改为实体类型 + 关系类型。
- 移除 `coverage shadow`、`branch` 节点、`agent` 层、Monaco、RPC provider。

**不要学**
- 7.5 万节点的 point-sprite 档与球细分降级表（我们的规模用不上，保留 instanced 球最省心）。
- 服务端 `layout3d.c` 的整体思路（那是 C 全量索引，不是我们的形态）。
- `GalaxyPanel.tsx` 的重型编排（160KB，含大量代码阅读器耦合）——只学它的"面板自己加载、折叠不卸载 Canvas、过滤在数据层做"三条决策。
- 无 WebGL 降级的"裸奔"做法：我们应保留一个 2D/Sigma 兜底或至少明确 WebGL 提示（本地单机可控，风险低，但值得给 `reduced-motion`/低端机一条 `flat` 正交 + 关 Bloom 的省钱路径）。

### 8.3 关键参数建议（几十~几千实体）

| 项 | 建议值 | 依据 |
|---|---|---|
| 渲染路径 | instanced 球（不切 point sprite） | 我们的规模远小于 75000 |
| 节点尺寸 | 基础 1.6–3.2，`size = base(label) * (0.7 + 0.3*log2(degree+1))`；高亮 ×2.5、未高亮 ×1（用 0.5/0.2 的相对比例即可） | 上游 `size * (0.5/0.2)` |
| 节点颜色 | `stellar_color(degree)` 映射（红→黄白→蓝，按 degree 分桶插值），`nodeGlowBoost` 增益 1.35/蓝2.4/红0.9 | 上游 `nodeGlowBoost` |
| 边宽 | 1px `lineSegments`（不加粗几何），靠强度与 additive 表达 | 上游取舍 |
| 边强度 | 簇内 `0.62`、簇外 `0.30`（边数<2000 恒定档）；有向关系脉冲 `4.8s` | `edgeIntensityFor` 近端档 |
| 标签 | top-50 by degree；字号 `max(1.8, size*0.4)`；DPR≤2；距离 LOD 可用 `2*sceneRadius` | `NodeLabels` |
| 光晕 | 地标 8–12 个，`size=max(size)*6`、opacity `0.28`；Bloom threshold `0.3`、intensity `1.0–1.45`、mipmapBlur | `HaloLayer`/`GraphScene` |
| 相机 | fov `50`、初始距离 = `frameDistance(包围盒)`；`dampingFactor 0.08`、`rotateSpeed 0.5`、`zoomSpeed 1.5`、`zoomToCursor`、`autoRotateSpeed 0.4` | `GraphScene` |
| 聚焦动画 | `ease-out cubic`，进度 `1.2/s`，`FLY_MAX_DELTA 0.1` | `CameraAnimator` |
| 帧率/DPR | DPR `[1,1.5]`；默认 `always`，低端机 `frameCap=30` + `flat` + 关 Bloom | `GRAPH_CANVAS_DPR`/`FRAME_CAPS` |
| 栈接入 | `@react-three/fiber@9`（React 19 兼容）+ `@react-three/drei` + `@react-three/postprocessing`；Next.js 16 下 3D 组件标 `'use client'`，`dynamic(() => import(...), { ssr:false })` | fiber 9 支持 React 19（已核实） |

---

## 9. 许可证与署名

- 上游 `DeusData/codebase-memory-mcp`：**MIT**，`LICENSE` 内 `Copyright (c) 2025 DeusData`。
- Galaxy 场景源码（`GraphScene/NodeCloud/EdgeLines/NodeLabels/HaloLayer/density` 等）文件头均带 `MIT License. Copyright (c) 2025 DeusData.` 及"Uebernommen aus …/CodeAtlasIDE"来源注释；`graph-ui/THIRD_PARTY.md` 汇总了移植文件清单。
- **复用要求**：MIT 允许商用与修改，但**拷贝代码/代码片段必须保留版权声明**。若 Coder 直接移植上述文件，应保留 `Copyright (c) 2025 DeusData` 与来源说明；仅"借鉴思路/参数"（数值、shader 片段思路、曲线公式）无需署名，但建议在 `docs/` 里注明参考来源。
- 依赖许可：`three` MIT、`@react-three/fiber` MIT、`@react-three/drei` MIT、`@react-three/postprocessing` MIT、`postprocessing` Zlib（保留来源与修改标识）。无 AGPL/GPL 传染风险。
- 边颜色表 `EDGE_TYPE_COLORS`（`graph/edge-style.ts`，MIT）直接可用作关系类型调色板：

```
CALLS #579fc7 IMPORTS #ad7acf USAGE #72b877 DATA_FLOWS #49b8b0 HTTP_CALLS #d58c60
ASYNC_CALLS #cb7fa9 GRPC_CALLS #b9ad58 GRAPHQL_CALLS #bd72ca TRPC_CALLS #898cda
INHERITS #8294d7 IMPLEMENTS #c5b66a OVERRIDE #bc7db8 DEFINES #c6a05c DEFINES_METHOD #dfb87a
CONTAINS #719f89 CONTAINS_FILE #92ad71 CONTAINS_FOLDER #57a88c CONTAINS_PACKAGE #abad65
MEMBER_OF #649daa HANDLES #aebb61 CONFIGURES #bda644 RAISES #d26b72 THROWS #ba606e
CALL_REFERENCE #67c1cf RETURNS #a1bd80 READS #70b59f WRITES #cc9862 TESTS #65a8bb
SIMILAR_TO #cb88b5 SEMANTICALLY_RELATED #b58ebf FILE_CHANGES_WITH #b19b81 RELATIONSHIPS #84939d
```

**可直接借鉴的代码片段**：`NodeCloud.nodeGlowBoost/nodeColor`、`EdgeLines.createEdgeGeometry` + 脉冲 shader 注入、`NodeLabels.createLabelTexture/fitText`、`density.edgeIntensityScale/nodeBoostScale/bloomIntensityScale`、`camera-frame.frameDistance/fitCamera`、`CameraAnimator` 缓动公式。
**仅借鉴思路（勿照抄结构）**：`organic-clusters.ts` 的聚类松弛算法、`ScreenNodeSeparation` 的显示层位移、`GalaxyPanel` 的状态编排与"折叠不卸载 Canvas"。

---

## 10. 未验证项

- 未实际安装运行 CBM Lens demo；动效手感（旋转、脉冲、Bloom 强度）基于源码数值推断，落地后需视觉调参。
- `graph/EdgePulseLayer.tsx` 的箭头几何细节未逐行拆解（只确认其"静止箭头 + 按路径绘制"职责）。
- `GalaxyPanel.tsx`（162KB）只读了头部决策注释与关键装配点，未逐行通读；其与 twin/reader 的耦合点以"要删"处理。
- 后端 `layout3d.c` 的 `stellar_color`/size 具体公式未取到源码（该文件在 C 端，不在 `graph-ui/`），颜色语义来自 `galaxy-legend.ts` 注释。
- 未评估 Next.js 16 + RSC 下 `@react-three/fiber` 的 SSR/水合细节，仅确认 fiber 9 支持 React 19。