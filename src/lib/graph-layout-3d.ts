/**
 * 3D 银河布局（ADR-022 附录 A3，v1.2；设计稿 §4.3 / §4.4）。
 *
 * 纯数学：不 import three、不 import React、不 import 任何 `@/components`。
 * 输入是冻结件 `GraphViewModel`，输出是坐标 + 每节点世界半径。
 *
 * 纪律（改动前先读 A3 的约束表）：
 * - **世界单位**：三层盘 85 / 150 / 210，不可达节点 340，与相机 260–1100 同一坐标空间。
 *   ADR-022 正文第 5 条的 `1.0 / 1.9 / 2.7` 是归一化比例，不是这里用的数。
 * - **确定性**：同 view + 同 anchors + 同 maxTicks → `positions` 逐字节相等。
 *   随机源只有 `stableHash(id)`；步长固定、迭代顺序按 id 码点序。唯一读取时钟的地方是
 *   `layoutMs` 测量与 `deadlineMs` 预算判断，它们不参与坐标计算。
 * - **盘面只是播种**：播种之后必须松弛（边弹簧 + 斥力 + 径向约束 + 碰撞），
 *   不松弛看不出结构，不播种每次形状都漂。
 * - **半径只在这里算**：`SIZE_WORLD_RADIUS` 填进 `result.radius`，渲染层只读，
 *   不许自己再查一次 `node.size`；2D 的 `clamp(5 + 3.1√degree)` 是另一套，不许统一。
 */

import { MAX_3D_LAYOUT_NODES } from "./graph-quality";
import type { GraphNode, GraphViewModel, NodeSizeTier } from "./graph-model";

export interface GalaxyLayoutOptions {
  /** 只用于缓存与基线命名，**不作随机源**：随机源只有 hash(id)，否则换中心全图重排。 */
  seedKey: string;
  /** 上一版布局里仍存在的节点 ⇒ 坐标；换中心时优先保持。 */
  anchors?: Readonly<Record<string, readonly [number, number, number]>>;
  /** 松弛步数上限。整数、固定 → 结果与机器快慢无关。默认按节点数分档（见下表）。 */
  maxTicks?: number;
  /** 安全阀：仅 Worker 包装层用；超时返回当前解并置 truncated。 */
  deadlineMs?: number;
}

export interface GalaxyLayoutResult {
  /** 长度 = nodes.length × 3，xyz 交错。 */
  readonly positions: Float32Array;
  /** id → 顶点序号。 */
  readonly indexById: ReadonlyMap<string, number>;
  /** 序号 → id，Worker 传输用（Map 虽可克隆，仍保留一份便于序列化与调试）。 */
  readonly ids: readonly string[];
  /** 每节点包围半径，视锥/标签剔除用。 */
  readonly radius: Float32Array;
  readonly bounds: { readonly center: readonly [number, number, number]; readonly radius: number };
  readonly ticks: number;
  /** 安全阀触发（deadline 到）或 >2000 节点降级布局时为 true。 */
  readonly truncated: boolean;
  readonly layoutMs: number;
}

/**
 * 节点四档世界半径（A3.1，2026-11-13 冻结）：`layoutGalaxy3d` 内部即用它填充
 * `result.radius`。星核 5.4、选中 ×1.15、光晕 3.2× 是纯视觉，留在渲染层。
 */
export const SIZE_WORLD_RADIUS: Readonly<Record<NodeSizeTier, number>> = {
  s: 1.9,
  m: 2.5,
  l: 3.3,
  xl: 4.4,
};

/**
 * 布局算法的版本号：**只在算法改动时 bump**，它进 3D 布局缓存键，
 * bump 必须同时更新截图基线（ADR-022 §4.3「缓存键」）。
 */
export const GALAXY_LAYOUT_VERSION = 1;

/** 三层盘的播种参数（设计稿 §4.3，世界单位）。只播种，不是最终解。 */
export const DISK_SEED: Readonly<
  Record<1 | 2 | 3, { readonly radius: number; readonly jitterY: number }>
> = {
  1: { radius: 85, jitterY: 10 },
  2: { radius: 150, jitterY: 22 },
  3: { radius: 210, jitterY: 32 },
};

/** 不可达节点（BFS 到不了）的外环半径；A3 播种表。 */
export const UNREACHABLE_SEED_RADIUS = 340;

/** 同层角度均分后的 hash 抖动上限（弧度）。 */
const ANGLE_JITTER_RAD = 0.06;

/** 固定步长：单节点单 tick 的位移上限（世界单位）。 */
const STEP_LIMIT = 4;

/**
 * 边弹簧刚度（每单位长度误差的位移）与**饱和上限**。
 * 饱和是必须的：盘面半径相差 60–130，若弹簧力随误差线性增长，它会在远距离压过径向约束，
 * 把三层盘挤成一团（实测 85 环会掉到 29）。远距离由径向约束说了算，弹簧只负责近场整形。
 */
const SPRING_K = 0.12;
const SPRING_MAX = 1.5;

/** 斥力：`K / (d + 软化)`，超过 CUTOFF 的对直接忽略（远场对构图没有贡献，纯烧 CPU）。 */
const REPULSION_K = 30;
const REPULSION_SOFTENING = 6;
const REPULSION_CUTOFF = 96;

/**
 * 径向约束刚度与饱和上限：把节点拴在自己那一层盘上，防止松弛把三层盘拉成球。
 * 平衡点由 `SPRING_MAX / RADIAL_K` 决定（约 10 个世界单位）——弹簧最多把节点拽离盘面 10，
 * 再远就拽不动了。
 */
const RADIAL_K = 0.25;
const RADIAL_MAX = 3.5;

/** 碰撞：两节点相切之外再留 1.2 世界单位的呼吸位。 */
const COLLISION_PAD = 1.2;
const COLLISION_K = 1.2;

/** 新节点（有 anchor 邻居、自己没有 anchor）在有 anchor 邻居附近的播种距离。 */
const NEIGHBOR_SEED_DISTANCE = 46;

/** >300 节点改用网格哈希找邻居（A3「松弛」行）。 */
const GRID_THRESHOLD = 300;
const GRID_CELL = 96;

const TWO_PI = Math.PI * 2;

/**
 * Worker 内部用的额外控制面（**不属于** A3 冻结签名）：
 * `shouldStop` 在每个 tick 间隙被读一次，返回 true 就以当前解结束并置 `truncated`。
 */
export interface GalaxyLayoutControl {
  readonly shouldStop?: () => boolean;
}

/**
 * A3 冻结签名。同步、纯函数；`deadlineMs` 只给 Worker 包装层用。
 */
export function layoutGalaxy3d(
  view: GraphViewModel,
  options: GalaxyLayoutOptions,
): GalaxyLayoutResult {
  return layoutGalaxy3dControlled(view, options);
}

/**
 * 与 `layoutGalaxy3d` 同一实现，额外接受 Worker 的取消信号。
 * 生产路径（组件）只用 `layoutGalaxy3d`；Worker 用这个。
 */
export function layoutGalaxy3dControlled(
  view: GraphViewModel,
  options: GalaxyLayoutOptions,
  control?: GalaxyLayoutControl,
): GalaxyLayoutResult {
  const startedAt = nowMs();

  const sourceNodes: readonly GraphNode[] = view?.nodes ?? [];
  const sourceEdges = view?.edges ?? [];
  const downsampled = sourceNodes.length > MAX_3D_LAYOUT_NODES;

  // 抽稀是确定性的：view.nodes 已按 (hop↑, degree↓, id↑) 排好，取前 N 个即可；
  // 中心节点 hop 为 0 排在最前，必然被保留。之后按 id 码点序迭代（A3「按 id 排序」）。
  const ordered = (downsampled ? sourceNodes.slice(0, MAX_3D_LAYOUT_NODES) : sourceNodes.slice()).sort(
    compareNodesById,
  );
  const n = ordered.length;

  const ids: string[] = new Array(n);
  const indexById = new Map<string, number>();
  for (let i = 0; i < n; i += 1) {
    ids[i] = ordered[i].id;
    indexById.set(ordered[i].id, i);
  }

  if (n === 0) {
    return {
      positions: new Float32Array(0),
      indexById,
      ids,
      radius: new Float32Array(0),
      bounds: { center: [0, 0, 0], radius: 0 },
      ticks: 0,
      truncated: downsampled,
      layoutMs: elapsedMs(startedAt),
    };
  }

  const radius = new Float32Array(n);
  /** 0 = 自由，1 = 星核，2 = anchor；后两者首步之后不再移动。 */
  const pinned = new Uint8Array(n);
  /** 盘层：0 星核、1/2/3 三层盘、4 不可达外环。 */
  const band = new Uint8Array(n);
  const px = new Float64Array(n);
  const py = new Float64Array(n);
  const pz = new Float64Array(n);

  let centerIndex = -1;
  for (let i = 0; i < n; i += 1) {
    const node = ordered[i];
    radius[i] = SIZE_WORLD_RADIUS[node.size] ?? SIZE_WORLD_RADIUS.m;
    if (centerIndex < 0 && node.hop === 0 && !node.flags.isUnreachable) centerIndex = i;
  }

  // —— 播种：三层盘 + 不可达外环 ——
  const buckets: number[][] = [[], [], [], [], []];
  for (let i = 0; i < n; i += 1) {
    const node = ordered[i];
    if (i === centerIndex) {
      band[i] = 0;
      continue;
    }
    // hop 0 但不止一个中心（病态输入）：除首个外按 1 跳处理，避免叠在原点。
    const value = node.flags.isUnreachable
      ? 4
      : node.hop === 0
        ? 1
        : (node.hop as 1 | 2 | 3);
    band[i] = value;
    buckets[value].push(i);
  }

  for (let b = 1; b <= 4; b += 1) {
    const list = buckets[b];
    const count = list.length;
    if (count === 0) continue;
    const ringRadius = b === 4 ? UNREACHABLE_SEED_RADIUS : DISK_SEED[b as 1 | 2 | 3].radius;
    const jitterY = b === 4 ? DISK_SEED[3].jitterY : DISK_SEED[b as 1 | 2 | 3].jitterY;
    for (let k = 0; k < count; k += 1) {
      const i = list[k];
      const id = ids[i];
      const angle =
        -Math.PI / 2 +
        (TWO_PI * k) / count +
        (unitFromHash(id, "angle") - 0.5) * 2 * ANGLE_JITTER_RAD;
      px[i] = Math.cos(angle) * ringRadius;
      pz[i] = Math.sin(angle) * ringRadius;
      py[i] = (unitFromHash(id, "height") * 2 - 1) * jitterY;
    }
  }

  if (centerIndex >= 0) {
    px[centerIndex] = 0;
    py[centerIndex] = 0;
    pz[centerIndex] = 0;
    pinned[centerIndex] = 1; // 星核固定在原点，弹簧与斥力都不许把它推走。
  }

  // —— 边：只保留两端都在本次布局集合里的（抽稀后可能丢边），按边 id 排序 ——
  const edgeI: number[] = [];
  const edgeJ: number[] = [];
  const sortableEdges = sourceEdges
    .filter(
      (edge) =>
        edge.source !== edge.target && indexById.has(edge.source) && indexById.has(edge.target),
    )
    .sort((a, b) => compareIds(a.id, b.id));
  for (const edge of sortableEdges) {
    edgeI.push(indexById.get(edge.source) as number);
    edgeJ.push(indexById.get(edge.target) as number);
  }
  const m = edgeI.length;

  const adjacency: number[][] = new Array(n);
  for (let i = 0; i < n; i += 1) adjacency[i] = [];
  for (let e = 0; e < m; e += 1) {
    adjacency[edgeI[e]].push(edgeJ[e]);
    adjacency[edgeJ[e]].push(edgeI[e]);
  }

  // —— anchors：首步落在原坐标；星核除外（星核永远在原点，换中心时旧中心让位）——
  const anchors = options.anchors ?? {};
  let hasAnchor = false;
  for (let i = 0; i < n; i += 1) {
    if (i === centerIndex) continue;
    const point = readAnchor(anchors, ids[i]);
    if (point === null) continue;
    px[i] = point[0];
    py[i] = point[1];
    pz[i] = point[2];
    pinned[i] = 2;
    hasAnchor = true;
  }

  // —— 新节点在有 anchor 的邻居附近播种，再交给松弛（A3「anchor」行）——
  if (hasAnchor) {
    for (let i = 0; i < n; i += 1) {
      if (pinned[i] !== 0) continue;
      let sx = 0;
      let sy = 0;
      let sz = 0;
      let count = 0;
      for (const j of adjacency[i]) {
        if (pinned[j] === 0) continue;
        sx += px[j];
        sy += py[j];
        sz += pz[j];
        count += 1;
      }
      if (count === 0) continue;
      const angle = unitFromHash(ids[i], "neighbor") * TWO_PI;
      px[i] = sx / count + Math.cos(angle) * NEIGHBOR_SEED_DISTANCE;
      pz[i] = sz / count + Math.sin(angle) * NEIGHBOR_SEED_DISTANCE;
      py[i] = sy / count + (unitFromHash(ids[i], "neighbor-y") * 2 - 1) * 12;
    }
  }

  // 播种坐标留一份：任何数值意外（NaN/Infinity）都退回播种点，保证输出永远有限。
  const seedX = px.slice();
  const seedY = py.slice();
  const seedZ = pz.slice();

  // —— 松弛 ——
  const bandRadius = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    bandRadius[i] =
      band[i] === 4
        ? UNREACHABLE_SEED_RADIUS
        : band[i] === 0
          ? 0
          : DISK_SEED[band[i] as 1 | 2 | 3].radius;
  }

  const restLength = new Float64Array(m);
  for (let e = 0; e < m; e += 1) {
    const i = edgeI[e];
    const j = edgeJ[e];
    restLength[e] =
      band[i] === band[j]
        ? sameRingRestLength(bandRadius[i], buckets[band[i]]?.length ?? 1)
        : crossRingRestLength(bandRadius[i], bandRadius[j]);
  }

  const maxTicks = resolveMaxTicks(options.maxTicks, n);
  const deadlineMs = resolveDeadline(options.deadlineMs);
  const shouldStop = control?.shouldStop;

  const fx = new Float64Array(n);
  const fy = new Float64Array(n);
  const fz = new Float64Array(n);

  // >300 节点：网格哈希。scratch 在 tick 之间复用（每 tick 重建 Map 是 2000 节点下最大的开销）。
  const gridScratch: GridScratch | null = n > GRID_THRESHOLD ? createGridScratch() : null;

  let ticks = 0;
  let truncated = downsampled;

  for (let tick = 0; tick < maxTicks; tick += 1) {
    // 两个时钟里的第一个：Worker 内 tick 预算。到点就以当前解返回（A3「可中断」）。
    if (deadlineMs !== null && elapsedMs(startedAt) >= deadlineMs) {
      truncated = true;
      break;
    }
    if (shouldStop?.()) {
      truncated = true;
      break;
    }

    fx.fill(0);
    fy.fill(0);
    fz.fill(0);

    // 1) 边弹簧。端点里有 pinned（星核 / anchor）时弹簧力减半。
    for (let e = 0; e < m; e += 1) {
      const i = edgeI[e];
      const j = edgeJ[e];
      const dx = px[j] - px[i];
      const dy = py[j] - py[i];
      const dz = pz[j] - pz[i];
      const distSq = dx * dx + dy * dy + dz * dz;
      if (distSq < 1e-12) continue;
      const dist = Math.sqrt(distSq);
      const half = pinned[i] !== 0 || pinned[j] !== 0 ? 0.5 : 1;
      const pull = clamp(SPRING_K * (dist - restLength[e]), -SPRING_MAX, SPRING_MAX) * half;
      const ux = dx / dist;
      const uy = dy / dist;
      const uz = dz / dist;
      fx[i] += ux * pull;
      fy[i] += uy * pull;
      fz[i] += uz * pull;
      fx[j] -= ux * pull;
      fy[j] -= uy * pull;
      fz[j] -= uz * pull;
    }

    // 2) 节点斥力 + 碰撞（一个 pass 同时算）。
    if (gridScratch) {
      applyGridRepulsion(gridScratch, n, px, py, pz, radius, fx, fy, fz);
    } else {
      applyPairRepulsion(n, px, py, pz, radius, fx, fy, fz);
    }

    // 3) 径向约束：把节点拴回自己那一层盘。
    for (let i = 0; i < n; i += 1) {
      if (pinned[i] !== 0) continue;
      const target = bandRadius[i];
      const horizontal = Math.sqrt(px[i] * px[i] + pz[i] * pz[i]);
      if (horizontal < 1e-6) {
        // 正好落在轴上：用 hash 给一个固定方向，避免除零与「随机感」。
        const angle = unitFromHash(ids[i], "radial") * TWO_PI;
        fx[i] += Math.cos(angle) * 0.5;
        fz[i] += Math.sin(angle) * 0.5;
        continue;
      }
      // 目标半径减当前半径：在环内 → 正 → 沿外法线推出；在环外 → 负 → 沿外法线拉回。
      const push = clamp((target - horizontal) * RADIAL_K, -RADIAL_MAX, RADIAL_MAX);
      fx[i] += (px[i] / horizontal) * push;
      fz[i] += (pz[i] / horizontal) * push;
    }

    // 4) 固定步长积分：单节点位移不超过 STEP_LIMIT，保证不炸。
    for (let i = 0; i < n; i += 1) {
      if (pinned[i] !== 0) continue;
      const length = Math.sqrt(fx[i] * fx[i] + fy[i] * fy[i] + fz[i] * fz[i]);
      const scale = length > STEP_LIMIT ? STEP_LIMIT / length : 1;
      px[i] += fx[i] * scale;
      py[i] += fy[i] * scale;
      pz[i] += fz[i] * scale;
    }

    ticks += 1;
  }

  // —— 输出 ——
  const positions = new Float32Array(n * 3);
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  for (let i = 0; i < n; i += 1) {
    const x = Number.isFinite(px[i]) ? px[i] : seedX[i];
    const y = Number.isFinite(py[i]) ? py[i] : seedY[i];
    const z = Number.isFinite(pz[i]) ? pz[i] : seedZ[i];
    positions[i * 3] = x;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = z;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }

  const center: [number, number, number] = [
    (minX + maxX) / 2,
    (minY + maxY) / 2,
    (minZ + maxZ) / 2,
  ];
  let boundsRadius = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = positions[i * 3] - center[0];
    const dy = positions[i * 3 + 1] - center[1];
    const dz = positions[i * 3 + 2] - center[2];
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz) + radius[i];
    if (distance > boundsRadius) boundsRadius = distance;
  }

  return {
    positions,
    indexById,
    ids,
    radius,
    bounds: { center, radius: boundsRadius },
    ticks,
    truncated,
    layoutMs: elapsedMs(startedAt),
  };
}

/** 默认 maxTicks 分档（A3「可中断」行）：≤150 → 80、151–600 → 150、601–2000 → 220。 */
export function defaultMaxTicks(nodeCount: number): number {
  if (nodeCount <= 150) return 80;
  if (nodeCount <= 600) return 150;
  return 220;
}

function resolveMaxTicks(raw: number | undefined, nodeCount: number): number {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return Math.max(0, Math.floor(raw));
  }
  return defaultMaxTicks(nodeCount);
}

function resolveDeadline(raw: number | undefined): number | null {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  return null;
}

// —— 斥力：≤300 节点 O(n²)，>300 网格哈希 ——

function applyPairRepulsion(
  n: number,
  px: Float64Array,
  py: Float64Array,
  pz: Float64Array,
  radius: Float32Array,
  fx: Float64Array,
  fy: Float64Array,
  fz: Float64Array,
): void {
  const cutoffSq = REPULSION_CUTOFF * REPULSION_CUTOFF;
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const dx = px[j] - px[i];
      const dy = py[j] - py[i];
      const dz = pz[j] - pz[i];
      const distSq = dx * dx + dy * dy + dz * dz;
      if (distSq > cutoffSq) continue;
      accumulateRepulsion(i, j, dx, dy, dz, distSq, radius, fx, fy, fz);
    }
  }
}

/**
 * 网格哈希的可复用状态：`lists` 跨 tick 保留，`used` 记录上一 tick 用到的键，
 * 每 tick 只把这些列表清空再填充——避免每 tick 分配上千个数组与字符串键。
 */
interface GridScratch {
  readonly lists: Map<number, number[]>;
  readonly used: number[];
}

function createGridScratch(): GridScratch {
  return { lists: new Map<number, number[]>(), used: [] };
}

/** 整数单元格键：坐标先除以 cell 再加偏移，乘基后保证双精度下无碰撞（|cell| < 1024）。 */
function cellKey(cx: number, cy: number, cz: number): number {
  return ((cx + 1024) * 2048 + (cy + 1024)) * 2048 + (cz + 1024);
}

function applyGridRepulsion(
  scratch: GridScratch,
  n: number,
  px: Float64Array,
  py: Float64Array,
  pz: Float64Array,
  radius: Float32Array,
  fx: Float64Array,
  fy: Float64Array,
  fz: Float64Array,
): void {
  const { lists, used } = scratch;
  for (const key of used) {
    const list = lists.get(key);
    if (list) list.length = 0;
  }
  used.length = 0;

  const cellsX = new Int32Array(n);
  const cellsY = new Int32Array(n);
  const cellsZ = new Int32Array(n);
  for (let i = 0; i < n; i += 1) {
    const cx = Math.floor(px[i] / GRID_CELL);
    const cy = Math.floor(py[i] / GRID_CELL);
    const cz = Math.floor(pz[i] / GRID_CELL);
    cellsX[i] = cx;
    cellsY[i] = cy;
    cellsZ[i] = cz;
    const key = cellKey(cx, cy, cz);
    const list = lists.get(key);
    if (list) {
      // 清空过的空列表 = 本 tick 第一次用到这个格子，补记到 used，下一 tick 才会被清空。
      if (list.length === 0) used.push(key);
      list.push(i);
    } else {
      lists.set(key, [i]);
      used.push(key);
    }
  }

  const cutoffSq = REPULSION_CUTOFF * REPULSION_CUTOFF;
  for (let i = 0; i < n; i += 1) {
    const cx = cellsX[i];
    const cy = cellsY[i];
    const cz = cellsZ[i];
    for (let ox = -1; ox <= 1; ox += 1) {
      for (let oy = -1; oy <= 1; oy += 1) {
        for (let oz = -1; oz <= 1; oz += 1) {
          const list = lists.get(cellKey(cx + ox, cy + oy, cz + oz));
          if (!list || list.length === 0) continue;
          for (let k = 0; k < list.length; k += 1) {
            const j = list[k];
            if (j <= i) continue;
            const dx = px[j] - px[i];
            const dy = py[j] - py[i];
            const dz = pz[j] - pz[i];
            const distSq = dx * dx + dy * dy + dz * dz;
            if (distSq > cutoffSq) continue;
            accumulateRepulsion(i, j, dx, dy, dz, distSq, radius, fx, fy, fz);
          }
        }
      }
    }
  }
}

function accumulateRepulsion(
  i: number,
  j: number,
  dx: number,
  dy: number,
  dz: number,
  distSq: number,
  radius: Float32Array,
  fx: Float64Array,
  fy: Float64Array,
  fz: Float64Array,
): void {
  const gap = radius[i] + radius[j] + COLLISION_PAD;
  if (distSq < 1e-12) {
    // 完全重合：沿固定轴分开（确定性），力度按碰撞缺口给。
    fx[i] -= COLLISION_K * gap;
    fx[j] += COLLISION_K * gap;
    return;
  }
  const dist = Math.sqrt(distSq);
  const ux = dx / dist;
  const uy = dy / dist;
  const uz = dz / dist;
  let push = REPULSION_K / (dist + REPULSION_SOFTENING);
  if (dist < gap) push += (gap - dist) * COLLISION_K;
  fx[i] -= ux * push;
  fy[i] -= uy * push;
  fz[i] -= uz * push;
  fx[j] += ux * push;
  fy[j] += uy * push;
  fz[j] += uz * push;
}

// —— 弹簧静长 ——

/** 同层：按该层节点数算弦长，保证稠密环不会被弹簧挤成一团。 */
function sameRingRestLength(ringRadius: number, count: number): number {
  if (ringRadius <= 0 || count <= 0) return 24;
  const chord = 2 * ringRadius * Math.sin(Math.PI / Math.max(count, 1));
  return clamp(chord, 10, 48);
}

/** 跨层：静长取两层半径差，弹簧只负责「沿半径对齐」，不负责把外环拽向内环。 */
function crossRingRestLength(inner: number, outer: number): number {
  return clamp(Math.abs(outer - inner), 24, 90);
}

// —— 确定性工具 ——

/** 32 位稳定哈希（FNV-1a + 末轮雪崩）；跨平台、跨次调用一致。 */
export function stableHash(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return hash >>> 0;
}

/** `[0, 1)` 的固定伪随机量；随机源只有 id 与用途标签，**不用 seedKey**。 */
function unitFromHash(id: string, salt: string): number {
  return stableHash(`${salt}\u0000${id}`) / 4294967296;
}

function compareIds(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function compareNodesById(a: GraphNode, b: GraphNode): number {
  return compareIds(a.id, b.id);
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function readAnchor(
  anchors: Readonly<Record<string, readonly [number, number, number]>>,
  id: string,
): readonly [number, number, number] | null {
  if (!Object.prototype.hasOwnProperty.call(anchors, id)) return null;
  const point = anchors[id];
  if (!point || point.length !== 3) return null;
  if (!Number.isFinite(point[0]) || !Number.isFinite(point[1]) || !Number.isFinite(point[2])) {
    return null;
  }
  return point;
}

/**
 * 时钟只用于 `layoutMs` 与 `deadlineMs`（ADR-022 A3：不读时钟算坐标）。
 */
function nowMs(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function elapsedMs(startedAt: number): number {
  return Math.round((nowMs() - startedAt) * 1000) / 1000;
}
