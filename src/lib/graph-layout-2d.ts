/**
 * 2D 聚焦阅读的布局与标签放置（ADR-022 A8 / 设计稿 §5.2、§6）。
 *
 * 纯几何：不 import React / three，不读时钟、不读 `Math.random`。
 * 同一份 `GraphViewModel` + 同一组 anchors → 同一组坐标（截图基线与单测都靠它）。
 *
 * 与 `graph-layout.ts`（旧单环 `layoutRadial`）的关系：后者只作为降级基线保留，
 * 新容器不再使用；这里的三条规则与 3D 的 `layoutGalaxy3d` 不共享坐标。
 *
 * 参数照设计稿 §5.2：斥力 -260、link 88 / 0.35、径向约束 0.27 / 0.46、
 * 碰撞 +8、向心 0.02，300 tick 后冻结。
 */

import type { GraphNode, GraphViewModel } from "./graph-model";

/** 屏幕像素半径（设计稿 §5.2）：中心 26，其余随度数连续增长并夹在 5–20。 */
export const NODE_RADIUS_MIN = 5;
export const NODE_RADIUS_MAX = 20;
export const NODE_RADIUS_CENTER = 26;

/** 力导向常量（设计稿 §5.2；单位是「像素 / tick」，不是物理单位）。 */
const REPULSION = 260;
const LINK_LENGTH = 88;
const LINK_STRENGTH = 0.35;
const RADIAL_1 = 0.27;
const RADIAL_2 = 0.46;
const RADIAL_STRENGTH = 0.12;
const CENTER_STRENGTH = 0.02;
const COLLISION_GAP = 8;
const STEP = 0.5;
const DAMPING = 0.6;
const MAX_SPEED = 30;
const SETTLE_SPEED = 0.05;
const SETTLE_TICKS = 12;
const DEFAULT_TICKS = 300;
const DEFAULT_PADDING = 32;

/**
 * 主线程布局的 tick 预算（按节点数分档，ADR-022 第 9 条 / 阻断项 6D-2-R9）。
 * 斥力是 O(n²)，600 节点 × 300 tick 会在中端机上卡住一帧以上；
 * 150 以内保持设计稿原值，超过后逐档收缩，宁可少松弛几轮也不让首帧掉队。
 */
export function layoutTicksForNodeCount(count: number): number {
  const safe = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  if (safe <= 150) return DEFAULT_TICKS;
  if (safe <= 300) return 180;
  if (safe <= 600) return 120;
  return 60;
}

/**
 * 尺寸档变化后是否还能沿用上一轮锚点（阻断项 1）。
 *
 * 锚点坐标是按旧画布算出来的；画布换档（比如 760 → 390）之后继续钉住，
 * 所有节点会被 `clamp` 压到新画布的边界上，而且因为 `pinned = 1` 永不自愈。
 * 因此只有画布尺寸完全一致才复用锚点，换档一律全量重排。
 */
export function anchorsForSize(
  anchors: Readonly<Record<string, readonly [number, number]>>,
  previous: { readonly width: number; readonly height: number } | null,
  next: { readonly width: number; readonly height: number },
): Record<string, readonly [number, number]> {
  if (!previous) return {};
  if (previous.width === next.width && previous.height === next.height) return { ...anchors };
  return {};
}

export interface Layout2DOptions {
  readonly width: number;
  readonly height: number;
  /** 取景中心（URL `?focus=`）；模型里 `flags.isCenter` 优先。 */
  readonly centerId?: string | null;
  /**
   * 上一版布局里仍存在的节点坐标：给了就**钉住**这些节点（不再被力推动），
   * 新节点在相邻节点附近播种后松弛。换中心时用它可以避免全图重排。
   */
  readonly anchors?: Readonly<Record<string, readonly [number, number]>>;
  /** 固定步数上限，默认 300；结果与机器快慢无关，只与这个数有关。 */
  readonly maxTicks?: number;
  /** 画布内边距，节点圆心被钳制在 [padding, width-padding] 内。 */
  readonly padding?: number;
}

export interface Layout2DNode {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  /** 到中心的 BFS 跳数：0 = 中心，3 = 不可达。 */
  readonly hop: GraphNode["hop"];
  readonly center: boolean;
  readonly anchored: boolean;
}

export interface Layout2DResult {
  readonly nodes: readonly Layout2DNode[];
  readonly indexById: ReadonlyMap<string, number>;
  /** 实际执行的 tick 数（≤ maxTicks）。 */
  readonly ticks: number;
  /** tick 预算耗尽时仍有一位速度超过阈值：位置仍是可用解。 */
  readonly truncated: boolean;
  readonly bounds: {
    readonly minX: number;
    readonly minY: number;
    readonly maxX: number;
    readonly maxY: number;
  };
}

/** 2D 节点半径：与 `SIZE_WORLD_RADIUS`（3D）不是一套，禁止统一（A3.1）。 */
export function nodeRadius2d(degree: number, isCenter = false): number {
  if (isCenter) return NODE_RADIUS_CENTER;
  const safe = Number.isFinite(degree) && degree > 0 ? degree : 0;
  return clamp(5 + 3.1 * Math.sqrt(safe), NODE_RADIUS_MIN, NODE_RADIUS_MAX);
}

/**
 * 冻结力导向。
 *
 * - 按 id 排序迭代，节点对、边、锚点的处理顺序固定；
 * - 播种：中心在画布中央，1 跳 `0.27 × min(w,h)`、2 跳 `0.46`、不可达外环 +40，
 *   同层角度均分 + `hash(id)` 抖动 ±0.06rad（与 3D 同一思路，不共用坐标）；
 * - 固定步长：tick 数不按时间裁剪，只在速度连续低于阈值时提前冻结；
 * - 边界钳制：圆心始终留在 padding 内，贴边即清零该轴速度。
 */
export function layoutForce2d(view: GraphViewModel, options: Layout2DOptions): Layout2DResult {
  const width = Number.isFinite(options.width) && options.width > 0 ? options.width : 640;
  const height = Number.isFinite(options.height) && options.height > 0 ? options.height : 420;
  const padding = clamp(options.padding ?? DEFAULT_PADDING, 0, Math.min(width, height) / 2 - 24);
  const maxTicks = Math.max(
    0,
    Math.floor(Number.isFinite(options.maxTicks ?? DEFAULT_TICKS) ? (options.maxTicks ?? DEFAULT_TICKS) : DEFAULT_TICKS),
  );
  const cx = width / 2;
  const cy = height / 2;
  const ringBase = Math.min(width, height);

  const input = [...view.nodes].sort((a, b) => compareIds(a.id, b.id));
  const count = input.length;

  if (count === 0) {
    return {
      nodes: [],
      indexById: new Map(),
      ticks: 0,
      truncated: false,
      bounds: { minX: cx, minY: cy, maxX: cx, maxY: cy },
    };
  }

  const anchors = options.anchors ?? {};
  const centerIndex = input.findIndex(
    (node) =>
      node.flags.isCenter ||
      (node.id === (options.centerId ?? view.meta.center) && node.hop === 0),
  );

  const xs = new Float64Array(count);
  const ys = new Float64Array(count);
  const vx = new Float64Array(count);
  const vy = new Float64Array(count);
  const radius = new Float64Array(count);
  const pinned = new Uint8Array(count);

  // 播种：同层按出现顺序均分角度，再用 hash(id) 抖动，保证同一 id 每次落在同一角度。
  const rings = new Map<number, number[]>();
  input.forEach((node, index) => {
    const hop = node.hop;
    const list = rings.get(hop);
    if (list) list.push(index);
    else rings.set(hop, [index]);
  });

  for (const [hop, indexes] of rings) {
    const ringRatio =
      hop === 0 ? 0 : hop === 1 ? RADIAL_1 : RADIAL_2;
    let ringRadius = ringRatio * ringBase;
    if (hop >= 3) ringRadius = Math.min(ringRadius + 40, Math.min(width, height) / 2 - padding);
    indexes.forEach((index, order) => {
      if (hop === 0) {
        xs[index] = cx;
        ys[index] = cy;
        return;
      }
      const angle =
        -Math.PI / 2 +
        (2 * Math.PI * order) / Math.max(indexes.length, 1) +
        (unitHash(input[index].id) - 0.5) * 0.12;
      xs[index] = clamp(cx + ringRadius * Math.cos(angle), padding, width - padding);
      ys[index] = clamp(cy + ringRadius * Math.sin(angle), padding, height - padding);
    });
  }

  input.forEach((node, index) => {
    radius[index] = nodeRadius2d(node.degree, index === centerIndex);
    if (index === centerIndex) {
      pinned[index] = 1;
      xs[index] = cx;
      ys[index] = cy;
      return;
    }
    const anchor = anchors[node.id];
    if (anchor) {
      pinned[index] = 1;
      xs[index] = clamp(anchor[0], padding, width - padding);
      ys[index] = clamp(anchor[1], padding, height - padding);
    }
  });

  const indexById = new Map<string, number>();
  input.forEach((node, index) => indexById.set(node.id, index));

  const edges: Array<[number, number]> = [];
  for (const edge of view.edges) {
    const a = indexById.get(edge.source);
    const b = indexById.get(edge.target);
    if (a === undefined || b === undefined) continue;
    edges.push([a, b]);
  }

  const fx = new Float64Array(count);
  const fy = new Float64Array(count);
  let ticks = 0;
  let calmTicks = 0;
  let truncated = false;

  for (let tick = 0; tick < maxTicks; tick += 1) {
    ticks = tick + 1;
    fx.fill(0);
    fy.fill(0);

    // 向心：所有节点略微靠向画布中心，防止碎图漂到角上。
    for (let i = 0; i < count; i += 1) {
      if (pinned[i]) continue;
      fx[i] += (cx - xs[i]) * CENTER_STRENGTH;
      fy[i] += (cy - ys[i]) * CENTER_STRENGTH;
    }

    // 径向约束：1 / 2 跳各自回到设计稿的环半径；不可达节点留在外环。
    for (let i = 0; i < count; i += 1) {
      if (pinned[i] || input[i].hop === 0) continue;
      const target = (input[i].hop === 1 ? RADIAL_1 : RADIAL_2) * ringBase;
      const dx = xs[i] - cx;
      const dy = ys[i] - cy;
      const dist = Math.hypot(dx, dy);
      if (dist < 0.001) continue;
      const delta = (dist - target) * RADIAL_STRENGTH;
      fx[i] -= (dx / dist) * delta;
      fy[i] -= (dy / dist) * delta;
    }

    // 斥力：O(n²)，≤600 节点同步算一次也在预算内（设计稿 §8.1）。
    for (let i = 0; i < count; i += 1) {
      for (let j = i + 1; j < count; j += 1) {
        const dx = xs[i] - xs[j];
        const dy = ys[i] - ys[j];
        const dist = Math.max(Math.hypot(dx, dy), 0.01);
        const push = REPULSION / dist;
        const ux = dx / dist;
        const uy = dy / dist;
        if (!pinned[i]) {
          fx[i] += ux * push;
          fy[i] += uy * push;
        }
        if (!pinned[j]) {
          fx[j] -= ux * push;
          fy[j] -= uy * push;
        }
      }
    }

    // 边弹簧 + 碰撞：按模型里的边顺序（weight↓, id↑）遍历，结果可复现。
    for (const [a, b] of edges) {
      const dx = xs[b] - xs[a];
      const dy = ys[b] - ys[a];
      const dist = Math.max(Math.hypot(dx, dy), 0.01);
      const ux = dx / dist;
      const uy = dy / dist;
      const spring = (dist - LINK_LENGTH) * LINK_STRENGTH;
      if (!pinned[a]) {
        fx[a] += ux * spring;
        fy[a] += uy * spring;
      }
      if (!pinned[b]) {
        fx[b] -= ux * spring;
        fy[b] -= uy * spring;
      }

      const minDistance = radius[a] + radius[b] + COLLISION_GAP;
      if (dist < minDistance) {
        const overlap = (minDistance - dist) * 0.5;
        if (!pinned[a]) {
          fx[a] -= ux * overlap;
          fy[a] -= uy * overlap;
        }
        if (!pinned[b]) {
          fx[b] += ux * overlap;
          fy[b] += uy * overlap;
        }
      }
    }

    let maxSpeed = 0;
    for (let i = 0; i < count; i += 1) {
      if (pinned[i]) continue;
      vx[i] = clamp((vx[i] + fx[i] * STEP) * DAMPING, -MAX_SPEED, MAX_SPEED);
      vy[i] = clamp((vy[i] + fy[i] * STEP) * DAMPING, -MAX_SPEED, MAX_SPEED);
      maxSpeed = Math.max(maxSpeed, Math.abs(vx[i]), Math.abs(vy[i]));

      const nextX = clamp(xs[i] + vx[i], padding, width - padding);
      const nextY = clamp(ys[i] + vy[i], padding, height - padding);
      if (nextX === padding || nextX === width - padding) vx[i] = 0;
      if (nextY === padding || nextY === height - padding) vy[i] = 0;
      xs[i] = nextX;
      ys[i] = nextY;
    }

    if (maxSpeed < SETTLE_SPEED) {
      calmTicks += 1;
      if (calmTicks >= SETTLE_TICKS) break;
    } else {
      calmTicks = 0;
    }

    if (tick === maxTicks - 1) truncated = maxSpeed >= SETTLE_SPEED;
  }

  const nodes: Layout2DNode[] = input.map((node, index) => ({
    id: node.id,
    // 保留一位小数：截图基线稳定，也避免把浮点噪声带进 DOM。
    x: round(xs[index]),
    y: round(ys[index]),
    radius: radius[index],
    hop: node.hop,
    center: index === centerIndex,
    anchored: pinned[index] === 1 && index !== centerIndex,
  }));

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    minX = Math.min(minX, node.x - node.radius);
    minY = Math.min(minY, node.y - node.radius);
    maxX = Math.max(maxX, node.x + node.radius);
    maxY = Math.max(maxY, node.y + node.radius);
  }

  return {
    nodes,
    indexById,
    ticks,
    truncated,
    bounds: { minX, minY, maxX, maxY },
  };
}

export interface PlaceLabelsOptions {
  readonly width: number;
  readonly height: number;
  readonly padding?: number;
  /** 字号，默认 11px（移动端传 10）。 */
  readonly fontSize?: number;
  /** 这些 id 优先拿到位置：选中 > 中心 > 其余。 */
  readonly priorityIds?: readonly string[];
  /** 只给这些 id 放标签（LOD 由调用方决定）；不传表示全部尝试。 */
  readonly onlyIds?: ReadonlySet<string>;
}

export interface LabelPlacement {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly anchor: "start" | "middle" | "end";
  readonly width: number;
  readonly visible: boolean;
}

interface Rect {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

/**
 * 标签放置（设计稿 §5.2）：每个节点四个候选位（右 / 左 / 下 / 上），
 * 依次检查「标签矩形不出画布、不压任何节点、不压已放标签」；四处都不行就不显示。
 * 宁缺勿挤：位置本身不随可见性变化，换选中只改变谁优先。
 */
export function placeLabels(
  nodes: readonly Layout2DNode[],
  labels: Readonly<Record<string, string>>,
  options: PlaceLabelsOptions,
): LabelPlacement[] {
  const { width, height } = options;
  const padding = options.padding ?? 8;
  const fontSize = options.fontSize ?? 11;
  const placed: Rect[] = [];
  const result = new Map<string, LabelPlacement>();

  const order = [...nodes].sort((a, b) => {
    const rank = (node: Layout2DNode) => {
      const index = options.priorityIds?.indexOf(node.id) ?? -1;
      if (index >= 0) return index;
      return node.center ? 1000 : 1001;
    };
    return rank(a) - rank(b) || compareIds(a.id, b.id);
  });

  const nodeRects: Rect[] = nodes.map((node) => ({
    left: node.x - node.radius,
    right: node.x + node.radius,
    top: node.y - node.radius,
    bottom: node.y + node.radius,
  }));
  const nodeIndex = new Map(nodes.map((node, index) => [node.id, index]));

  for (const node of order) {
    const selfIndex = nodeIndex.get(node.id) ?? -1;
    const text = labels[node.id] ?? "";
    const textWidth = Math.ceil(estimateTextWidth(text, fontSize));
    const height_ = Math.ceil(fontSize * 1.25);
    const offset = node.radius + 5;
    const candidates: LabelPlacement[] = [
      { id: node.id, x: round(node.x + offset), y: round(node.y + fontSize * 0.36), anchor: "start", width: textWidth, visible: true },
      { id: node.id, x: round(node.x - offset), y: round(node.y + fontSize * 0.36), anchor: "end", width: textWidth, visible: true },
      { id: node.id, x: round(node.x), y: round(node.y + node.radius + fontSize * 1.25), anchor: "middle", width: textWidth, visible: true },
      { id: node.id, x: round(node.x), y: round(node.y - node.radius - 6), anchor: "middle", width: textWidth, visible: true },
    ];

    const wanted = options.onlyIds ? options.onlyIds.has(node.id) : true;
    let chosen: LabelPlacement | null = null;

    if (wanted && text) {
      for (const candidate of candidates) {
        const rect = rectOf(candidate, height_);
        if (rect.left < padding || rect.right > width - padding) continue;
        if (rect.top < padding || rect.bottom > height - padding) continue;
        if (nodeRects.some((other, index) => index !== selfIndex && overlaps(rect, other))) continue;
        if (placed.some((other) => overlaps(rect, other))) continue;
        placed.push(rect);
        chosen = candidate;
        break;
      }
    }

    result.set(node.id, chosen ?? { ...candidates[0], visible: false });
  }

  return nodes.map((node) => result.get(node.id) as LabelPlacement);
}

/** 估算文本宽度：CJK / 全角按 1em，其余按 0.56em。只用于避让，不用于排版。 */
export function estimateTextWidth(text: string, fontSize: number): number {
  let width = 0;
  for (const char of text) width += char.codePointAt(0)! > 255 ? fontSize : fontSize * 0.56;
  return width;
}

function rectOf(label: LabelPlacement, height: number): Rect {
  const left =
    label.anchor === "start" ? label.x : label.anchor === "end" ? label.x - label.width : label.x - label.width / 2;
  return { left, right: left + label.width, top: label.y - height, bottom: label.y };
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.left < b.right + 2 && a.right > b.left - 2 && a.top < b.bottom + 2 && a.bottom > b.top - 2;
}

/** FNV-1a 32 位：与 3D 同一思路的稳定散列，不作随机源。 */
function hashId(id: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** 0–1 的稳定散列值。 */
function unitHash(id: string): number {
  return hashId(id) / 0xffffffff;
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) return (min + max) / 2;
  return Math.min(max, Math.max(min, value));
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function compareIds(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
