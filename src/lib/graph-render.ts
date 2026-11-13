/**
 * 3D 渲染层的纯函数（B 线内部共享件，2026-11-13）。
 *
 * 只放**不碰 three / React / WebGL** 的决策逻辑，供 `src/components/graph/*` 与
 * `tests/lib/graph-render.test.ts` 共用：边分组、标签预算与屏幕空间避让、CSS token
 * 解析、布局缓存键、Worker 调度阈值。所有函数无 IO、无时钟、无随机源。
 *
 * 为什么单独成文件：这些规则若写在 `.tsx` 里，node 环境的单测就得把 three 与
 * `@react-three/fiber` 一起 import 进来（模块级副作用与 jsdom 依赖都不受控）。
 * 按 A7 第 3 条，B 线新增共享件只允许落在 `src/lib/graph-*.ts` 命名空间；本文件
 * 只被 B 线的 3D 组件与测试引用，A 线不读。
 */

import type {
  GraphColorToken,
  GraphEdgeColorToken,
  GraphNodeShape,
  GraphViewModel,
} from "./graph-model";
import { GALAXY_LAYOUT_VERSION, stableHash, type GalaxyLayoutResult } from "./graph-layout-3d";
import type { GraphHighlight } from "./graph-selectors";
import { TIER_BUDGETS, type QualityTier } from "./graph-quality";

/** 归一化 sRGB：四个分量都在 [0, 1]，alpha 不做预乘。 */
export type RGBA = readonly [number, number, number, number];

/** 线性光空间 RGB（three 的 working color space），给着色器用。 */
export type LinearRGB = readonly [number, number, number];

/**
 * A2.1 的 12 个舞台 token 的回退值（设计稿 §4.4「上表 hex 作为无 token 时的回退值」）。
 * 组件里不出现任何色值；只有 token 读不到（例如测试环境、样式尚未加载）时才走这里。
 */
export const GRAPH_TOKEN_FALLBACK: Readonly<Record<string, string>> = {
  "--graph-canvas": "#050408",
  "--graph-node-concept": "#e9c08a",
  "--graph-node-person": "#a99bc1",
  "--graph-node-org": "#b08a6a",
  "--graph-node-work": "#8fa6b8",
  "--graph-node-method": "#9db39a",
  "--graph-node-other": "#7c7385",
  "--graph-node-disk": "#0e0c13",
  "--graph-core": "#f6e3c6",
  "--graph-edge": "rgb(243 239 231 / 14%)",
  "--graph-edge-strong": "rgb(243 239 231 / 20%)",
  "--graph-accent": "#f6e3c6",
};

const NODE_TOKENS: readonly GraphColorToken[] = [
  "--graph-node-concept",
  "--graph-node-person",
  "--graph-node-org",
  "--graph-node-work",
  "--graph-node-method",
  "--graph-node-other",
];

/** 渲染层从 CSS 读到的整套颜色；所有分量都是归一化 sRGB。 */
export interface GraphPalette {
  readonly canvas: RGBA;
  readonly core: RGBA;
  readonly accent: RGBA;
  readonly nodeDisk: RGBA;
  readonly nodes: Readonly<Record<GraphColorToken, RGBA>>;
  readonly edge: RGBA;
  readonly edgeStrong: RGBA;
}

/** 形状 → SDF 分支序号（与 node-field 的着色器常量一一对应）。 */
export const SHAPE_INDEX: Readonly<Record<GraphNodeShape, number>> = {
  circle: 0,
  "double-ring": 1,
  "round-square": 2,
  diamond: 3,
  hexagon: 4,
  dot: 5,
};

/** 星核的纯视觉半径（A3.1：布局只给档位半径，5.4 属于渲染层）。 */
export const CORE_WORLD_RADIUS = 5.4;
/** 选中节点的视觉放大（A3.1）。 */
export const SELECTED_SCALE = 1.15;
/**
 * 节点世界半径的整体放大（纯视觉，只影响渲染层）。
 * 布局给的 1.9–4.4 在 1440×900、相机 z=620 下只有 1.7–3.9px 半径，SDF 形状看不出来；
 * ×1.6 后普通节点约 2.7–4.6px、中心约 7.5px，正好落在「可辨认但不糊成一片」的范围。
 */
export const NODE_SIZE_SCALE = 1.6;
/** 光晕 quad 相对节点半径的倍数（设计稿 §4.4）。 */
export const HALO_SCALE = 3.2;
/** 节点压暗后的不透明度（dimmed 节点仍可见）。 */
export const NODE_DIM_ALPHA = 0.3;
/** 边压暗：乘在顶点色上的系数（LineMaterial 只有整组 opacity，逐段压暗只能走颜色）。 */
export const EDGE_DIM_FACTOR = 0.35;
/** >300 节点改走 Worker（设计稿 §4.3 / §8.2）。 */
export const LAYOUT_WORKER_THRESHOLD = 300;
/** 布局缓存最多保留的条目数。 */
export const LAYOUT_CACHE_LIMIT = 8;

/** 图例 / 边分组用的三个桶；数值是 `view.edges` 的下标。 */
export interface EdgeSplit {
  readonly base: readonly number[];
  readonly strong: readonly number[];
  readonly accent: readonly number[];
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function parseHex(text: string): RGBA | null {
  const hex = text.slice(1);
  if (!/^[0-9a-f]+$/i.test(hex)) return null;
  if (hex.length === 3 || hex.length === 4) {
    const [r, g, b, a] = hex.split("").map((part) => parseInt(part + part, 16));
    return [r / 255, g / 255, b / 255, hex.length === 4 ? a / 255 : 1];
  }
  if (hex.length === 6 || hex.length === 8) {
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) : 255;
    return [r / 255, g / 255, b / 255, a / 255];
  }
  return null;
}

function parseAlpha(text: string): number {
  const value = text.trim();
  if (value.endsWith("%")) return clamp01(parseFloat(value.slice(0, -1)) / 100);
  return clamp01(parseFloat(value));
}

function parseChannel(text: string): number {
  const value = text.trim();
  if (value.endsWith("%")) return clamp01(parseFloat(value.slice(0, -1)) / 100);
  const number = parseFloat(value);
  return clamp01(number / 255);
}

/**
 * 解析 CSS 颜色：#rgb / #rgba / #rrggbb / #rrggbbaa、`rgb(r g b / a)`、
 * `rgba(r, g, b, a)`、百分比通道与百分比 alpha。返回归一化 sRGB；认不出返回 null。
 *
 * 之所以要自己写：`--graph-edge` 的定义是 `rgb(243 239 231 / 14%)`，
 * 而 `getComputedStyle().getPropertyValue("--graph-edge")` 返回的是**原始文本**
 * 而不是规范化后的 `rgba()`，直接塞给 `THREE.Color` 会得到 NaN。
 */
export function parseCssColor(value: string): RGBA | null {
  const text = value.trim();
  if (!text) return null;
  if (text.startsWith("#")) return parseHex(text);

  const match = /^rgba?\(([^)]*)\)$/i.exec(text);
  if (!match) return null;

  let body = match[1].trim();
  let alphaText: string | null = null;
  const slash = body.split("/");
  if (slash.length === 2) {
    body = slash[0].trim();
    alphaText = slash[1].trim();
  }

  const parts = body.split(/[\s,]+/).filter((part) => part.length > 0);
  if (parts.length < 3) return null;
  const alpha =
    alphaText !== null ? parseAlpha(alphaText) : parts.length >= 4 ? parseAlpha(parts[3]) : 1;
  const color: RGBA = [
    parseChannel(parts[0]),
    parseChannel(parts[1]),
    parseChannel(parts[2]),
    alpha,
  ];
  return color.every((component) => Number.isFinite(component)) ? color : null;
}

/** sRGB → 线性光。只转 RGB，alpha 原样返回。 */
export function rgbaToLinear(rgba: RGBA): LinearRGB {
  const convert = (channel: number): number =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  return [convert(rgba[0]), convert(rgba[1]), convert(rgba[2])];
}

/** 乘一个系数得到压暗后的线性色（LineMaterial 的逐段压暗只能改颜色）。 */
export function dimLinear(color: LinearRGB, factor: number): LinearRGB {
  return [color[0] * factor, color[1] * factor, color[2] * factor];
}

function readToken(
  style: CSSStyleDeclaration | null,
  token: string,
  fallback: string,
): RGBA {
  const raw = style?.getPropertyValue(token).trim() ?? "";
  return parseCssColor(raw) ?? (parseCssColor(fallback) as RGBA);
}

/**
 * 从 `[data-surface="graph"]` 宿主读取 12 个 token；读不到的走 A2.1 回退值。
 * 这是整个 3D 渲染层**唯一**知道颜色值的地方（组件只拿 token → RGBA）。
 */
export function readGraphPalette(host: HTMLElement | null): GraphPalette {
  const element = host ?? (typeof document !== "undefined" ? document.documentElement : null);
  const style = element ? getComputedStyle(element) : null;

  const nodes = {} as Record<GraphColorToken, RGBA>;
  for (const token of NODE_TOKENS) {
    nodes[token] = readToken(style, token, GRAPH_TOKEN_FALLBACK[token]);
  }

  return {
    canvas: readToken(style, "--graph-canvas", GRAPH_TOKEN_FALLBACK["--graph-canvas"]),
    core: readToken(style, "--graph-core", GRAPH_TOKEN_FALLBACK["--graph-core"]),
    accent: readToken(style, "--graph-accent", GRAPH_TOKEN_FALLBACK["--graph-accent"]),
    nodeDisk: readToken(style, "--graph-node-disk", GRAPH_TOKEN_FALLBACK["--graph-node-disk"]),
    nodes,
    edge: readToken(style, "--graph-edge", GRAPH_TOKEN_FALLBACK["--graph-edge"]),
    edgeStrong: readToken(
      style,
      "--graph-edge-strong",
      GRAPH_TOKEN_FALLBACK["--graph-edge-strong"],
    ),
  };
}

export function shapeIndex(shape: GraphNodeShape): number {
  return SHAPE_INDEX[shape] ?? SHAPE_INDEX.circle;
}

export function edgeColorTokenOf(edge: { readonly colorToken: GraphEdgeColorToken }): GraphEdgeColorToken {
  return edge.colorToken;
}

/**
 * 边分成 3 组（A8 / 设计稿 §4.5）：
 * - `accent`：选中节点相连的边 + 路径边（`highlight.edges` 已算好，渲染器不再求补集）；
 * - `strong`：其余结构边（`edge.strong`，即 1 跳或 weight ≥ 2）；
 * - `base`：默认丝线。
 * 组内保持 `view.edges` 顺序（模型已按 weight↓ / id↑ 排好），保证几何逐字节稳定。
 */
export function splitEdges(view: GraphViewModel, highlight: GraphHighlight): EdgeSplit {
  const base: number[] = [];
  const strong: number[] = [];
  const accent: number[] = [];
  view.edges.forEach((edge, index) => {
    if (highlight.edges.has(edge.id)) accent.push(index);
    else if (edge.strong) strong.push(index);
    else base.push(index);
  });
  return { base, strong, accent };
}

/**
 * 从高亮集合反推「锚点」（选中或悬停的中心节点）。
 *
 * `GraphScene3DProps` 里没有 `selectedId`（A7 冻结，不许加字段），而 `GraphHighlight`
 * 只给点亮集合。推法：锚点是**所有关联边都被点亮**的节点里度数最高的那个；
 * 悬停邻域 / 路径里的邻居通常只有一条边被点亮，因此不会误判。退化情况（单节点、
 * 全图只有一条边）按「点亮集合里度数最高」兜底。无高亮时返回 null。
 *
 * 这不是重算邻域——邻域仍由 `selectGraphHighlight` 给；这里只挑出环该画在谁身上。
 */
export function inferAnchorNode(view: GraphViewModel, highlight: GraphHighlight): string | null {
  if (highlight.nodes.size === 0) return null;
  if (highlight.nodes.size === 1) {
    for (const id of highlight.nodes) return id;
  }

  const fullyLit = new Map<string, boolean>();
  for (const edge of view.edges) {
    const lit = highlight.edges.has(edge.id);
    if (!lit) {
      fullyLit.set(edge.source, false);
      fullyLit.set(edge.target, false);
    } else {
      if (!fullyLit.has(edge.source)) fullyLit.set(edge.source, true);
      if (!fullyLit.has(edge.target)) fullyLit.set(edge.target, true);
    }
  }

  let best: string | null = null;
  let bestDegree = -1;
  for (const node of view.nodes) {
    if (!highlight.nodes.has(node.id)) continue;
    if (fullyLit.get(node.id) !== true) continue;
    if (node.degree > bestDegree || (node.degree === bestDegree && (best === null || node.id < best))) {
      best = node.id;
      bestDegree = node.degree;
    }
  }
  if (best !== null) return best;

  // 兜底：高亮集合里度数最高（同分取 id 小），保持确定性。
  for (const node of view.nodes) {
    if (!highlight.nodes.has(node.id)) continue;
    if (node.degree > bestDegree || (node.degree === bestDegree && (best === null || node.id < best))) {
      best = node.id;
      bestDegree = node.degree;
    }
  }
  return best;
}

/**
 * 标签候选（按优先级排序，数量受档位上限约束）：
 * 选中/悬停 → 路径 → 星核 → 其余按 (degree↓, id↑)。
 * 选中/悬停与路径节点**始终显示**（即使超出上限，也在返回里）。
 */
export function labelCandidates(
  view: GraphViewModel,
  highlight: GraphHighlight,
  tier: QualityTier,
  anchorId: string | null,
): string[] {
  const limit = TIER_BUDGETS[tier].maxLabels;
  const forced: string[] = [];
  const seen = new Set<string>();

  const pushForced = (id: string | null): void => {
    if (!id || seen.has(id) || !view.nodeIndex.has(id)) return;
    seen.add(id);
    forced.push(id);
  };

  pushForced(anchorId);
  for (const id of highlight.path ?? []) pushForced(id);

  const ordered: string[] = [];
  const center = view.nodes.find((node) => node.flags.isCenter);
  // 星核可能已经是锚点/路径节点（例如它就是选中项），此时不能再排一次，否则图集里
  // 同一个 id 会出现两条实例、标签互相覆盖。
  if (center && !seen.has(center.id)) ordered.push(center.id);

  const rest = view.nodes
    .filter((node) => !seen.has(node.id) && node.id !== center?.id)
    .slice()
    .sort((a, b) => b.degree - a.degree || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const node of rest) ordered.push(node.id);

  const remaining = Math.max(0, limit - forced.length);
  return [...forced, ...ordered.slice(0, remaining)];
}

export interface ProjectedLabel {
  readonly id: string;
  /** 标签框左上角，CSS 像素。 */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** 选中/悬停/路径：始终显示，不受避让与数量限制。 */
  readonly forced?: boolean;
}

export interface LabelViewport {
  readonly width: number;
  readonly height: number;
}

export interface LabelPlacementOptions {
  readonly padding?: number;
  readonly maxCount?: number;
}

function overlaps(
  ax: number,
  ay: number,
  aw: number,
  ah: number,
  bx: number,
  by: number,
  bw: number,
  bh: number,
  padding: number,
): boolean {
  return (
    ax < bx + bw + padding &&
    bx < ax + aw + padding &&
    ay < by + bh + padding &&
    by < ay + ah + padding
  );
}

/**
 * 屏幕空间避让：按传入顺序（已按优先级排好）接受标签。
 *
 * 每个标签按顺序尝试 5 个候选位移：默认位置 → 上移一行 → 左移半宽 → 右移半宽 → 下移一行。
 * 位移上限约一个标签高 / 半个标签宽，标签仍然贴着它自己的星点，不会飘到别的节点上。
 *
 * - 高优先级先占位，后来的只能去空格子，没空格子就丢弃（不是简单数量截断）；
 * - `forced`（选中 / 悬停 / 路径）一定保留：候选都冲突时才夹回视口硬放；
 * - 非 forced 的候选必须完整落在视口内，放不下就丢弃（不做半截文字）；
 * - `maxCount` 是硬上限，默认不限制；达到上限后停止。
 *
 * 返回顺序与传入顺序一致（调用方据此写实例属性）。
 */
export function layoutLabels(
  labels: readonly ProjectedLabel[],
  viewport: LabelViewport,
  options: LabelPlacementOptions = {},
): ProjectedLabel[] {
  const padding = options.padding ?? 4;
  const maxCount = options.maxCount ?? Number.POSITIVE_INFINITY;
  const accepted: ProjectedLabel[] = [];
  const boxes: Array<{ x: number; y: number; width: number; height: number }> = [];

  const clampToViewport = (label: ProjectedLabel, dx: number, dy: number): ProjectedLabel => {
    const x = Math.min(Math.max(0, label.x + dx), Math.max(0, viewport.width - label.width));
    const y = Math.min(Math.max(0, label.y + dy), Math.max(0, viewport.height - label.height));
    return x === label.x && y === label.y ? label : { ...label, x, y };
  };

  const hits = (label: ProjectedLabel): boolean =>
    boxes.some((box) =>
      overlaps(
        label.x,
        label.y,
        label.width,
        label.height,
        box.x,
        box.y,
        box.width,
        box.height,
        padding,
      ),
    );

  const inViewport = (label: ProjectedLabel): boolean =>
    label.x >= 0 &&
    label.y >= 0 &&
    label.x + label.width <= viewport.width &&
    label.y + label.height <= viewport.height;

  for (const label of labels) {
    if (accepted.length >= maxCount) break;
    const candidates: ReadonlyArray<readonly [number, number]> = [
      [0, 0],
      [0, -(label.height + padding * 2)],
      [-(label.width * 0.55), 0],
      [label.width * 0.55, 0],
      [0, label.height + padding * 2],
    ];

    let next: ProjectedLabel | null = null;
    if (label.forced) {
      // forced 必须出现：候选里挑第一个不冲突的（仍然夹回视口，绝不把选中标签推出屏幕）。
      for (const [dx, dy] of candidates) {
        const attempt = clampToViewport(label, dx, dy);
        if (!hits(attempt)) {
          next = attempt;
          break;
        }
      }
      next = next ?? clampToViewport(label, 0, 0);
    } else {
      for (const [dx, dy] of candidates) {
        const attempt = dx === 0 && dy === 0 ? label : { ...label, x: label.x + dx, y: label.y + dy };
        if (!inViewport(attempt)) continue;
        if (hits(attempt)) continue;
        next = attempt;
        break;
      }
    }
    if (!next) continue;

    accepted.push(next);
    boxes.push({ x: next.x, y: next.y, width: next.width, height: next.height });
  }

  return accepted;
}

/**
 * 布局缓存键（设计稿 §4.3）：
 * 稳定 id 集合哈希 + focus（`meta.center`）+ depth + `GALAXY_LAYOUT_VERSION`。
 * 不含选中/悬停——它们是视图态，进键会让「点一下」触发整图重排。
 */
export function layoutSeedKey(view: GraphViewModel): string {
  const ids = view.nodes.map((node) => node.id).sort();
  const hash = stableHash(ids.join("\u0000")).toString(16);
  return `${hash}|${view.meta.center}|${view.meta.depth}|${GALAXY_LAYOUT_VERSION}`;
}

export function shouldUseWorker(nodeCount: number): boolean {
  return Number.isFinite(nodeCount) && nodeCount > LAYOUT_WORKER_THRESHOLD;
}

/**
 * 从上一版布局里抽出「本次仍存在」的节点坐标，作为 anchors 传给下一次布局。
 * 只保留两端都在新 view 里的节点，避免 anchors 里出现幽灵 id。
 */
export function anchorsFromResult(
  previous: GalaxyLayoutResult,
  next: GraphViewModel,
): Record<string, readonly [number, number, number]> {
  const anchors: Record<string, readonly [number, number, number]> = {};
  for (const node of next.nodes) {
    const index = previous.indexById.get(node.id);
    if (index === undefined) continue;
    anchors[node.id] = [
      previous.positions[index * 3],
      previous.positions[index * 3 + 1],
      previous.positions[index * 3 + 2],
    ];
  }
  return anchors;
}

/** 视觉半径：只在布局半径上乘纯视觉系数（不重查 node.size）。 */
export function visualRadius(base: number, isCenter: boolean, isSelected: boolean): number {
  const core = isCenter ? Math.max(base, CORE_WORLD_RADIUS) : base;
  const scaled = core * NODE_SIZE_SCALE;
  return scaled * (isSelected ? SELECTED_SCALE : 1);
}

/**
 * 星场坐标：900 点、1400×900×600 盒内、确定性 LCG（同 seed 逐字节相同）。
 * 放在纯函数里是为了单测能验证「不闪烁 = 每次生成一致」。
 */
export function createStarfieldPositions(count = 900, seed = 0x6d2b79f5): Float32Array {
  const positions = new Float32Array(count * 3);
  let state = seed >>> 0;
  const next = (): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  for (let index = 0; index < count; index += 1) {
    positions[index * 3] = (next() - 0.5) * 1400;
    positions[index * 3 + 1] = (next() - 0.5) * 900;
    positions[index * 3 + 2] = (next() - 0.5) * 600;
  }
  return positions;
}

export interface AtlasEntryInput {
  readonly id: string;
  readonly width: number;
  readonly height: number;
}

export interface AtlasEntryRect {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * 标签图集的矩形打包（按行，确定性）。放不下返回 null，调用方据此缩小字号或减少标签。
 * 纯函数：与 canvas / 字体无关，尺寸由调用方量好后传入。
 */
export function packLabelAtlas(
  entries: readonly AtlasEntryInput[],
  options: { readonly width: number; readonly height: number; readonly padding?: number },
): AtlasEntryRect[] | null {
  const padding = options.padding ?? 2;
  const maxWidth = options.width;
  const maxHeight = options.height;
  let x = padding;
  let y = padding;
  let rowHeight = 0;
  const rects: AtlasEntryRect[] = [];

  for (const entry of entries) {
    if (!(entry.width > 0) || !(entry.height > 0)) return null;
    if (entry.width + padding * 2 > maxWidth) return null;
    if (x + entry.width + padding > maxWidth) {
      x = padding;
      y += rowHeight + padding;
      rowHeight = 0;
    }
    if (y + entry.height + padding > maxHeight) return null;
    rects.push({ id: entry.id, x, y, width: entry.width, height: entry.height });
    x += entry.width + padding;
    rowHeight = Math.max(rowHeight, entry.height);
  }
  return rects;
}
