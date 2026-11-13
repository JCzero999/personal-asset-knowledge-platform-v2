/**
 * 图谱的画质档位与视图降级（ADR-022 附录 A7、正文第 8 / 10 条，**冻结件**）。
 *
 * 两件事只在这里判定，组件不许自己 `if`：
 * - 默认进 3D 还是 2D：`selectGraphMode`，输入 webgl × reduced-motion × 节点数 × URL；
 * - 画质档位 `low / balanced / high` 与各档预算（节点 / 边 / 标签 / DPR 上限）。
 *
 * 规则：**只降不升**。自动降档只会往低走，回到高档位必须刷新页面；
 * URL 里的显式 `?mode=` 优先于「软降级」（reduced-motion、移动端、超大图），
 * 但不优先于物理上做不到的「没有 WebGL」。
 */

import type { GraphNode, GraphViewModel } from "./graph-model";

export type QualityTier = "low" | "balanced" | "high";
export type GraphViewMode = "3d" | "2d" | "list";

export interface TierBudget {
  readonly maxNodes: number;
  readonly maxEdges: number;
  readonly maxLabels: number;
  readonly maxDpr: number;
}

/** 档位表（ADR-022 第 8 条 / 设计稿 §8.2）。 */
export const TIER_BUDGETS: Readonly<Record<QualityTier, TierBudget>> = {
  low: { maxNodes: 150, maxEdges: 300, maxLabels: 12, maxDpr: 1 },
  balanced: { maxNodes: 300, maxEdges: 600, maxLabels: 24, maxDpr: 1.5 },
  high: { maxNodes: 600, maxEdges: 1200, maxLabels: 40, maxDpr: 2 },
};

/** 由低到高，`只降不升` 比较档位用。 */
export const TIER_ORDER: readonly QualityTier[] = ["low", "balanced", "high"];

/** 3D 布局的规模上限（ADR-022 第 5 条：>2000 不布局）。 */
export const MAX_3D_LAYOUT_NODES = 2000;

/** 落到某个结果的原因，给状态条与验收脚本读；不要用自由文本。 */
export type GraphModeReason =
  | "url-list"
  | "url-2d"
  | "url-3d"
  | "auto-3d"
  | "no-webgl"
  | "reduced-motion"
  | "mobile"
  | "too-many-nodes";

export interface GraphQualityInput {
  readonly webgl: boolean;
  readonly reducedMotion: boolean;
  readonly nodeCount: number;
  /** URL 上的 `?mode=`；非法值由调用方先归一成 null。 */
  readonly urlMode?: GraphViewMode | null;
  /** `navigator.hardwareConcurrency`；拿不到传 null。 */
  readonly hardwareConcurrency?: number | null;
  readonly isMobile?: boolean;
  /** 软件渲染（SwiftShader 之类）。 */
  readonly softwareRenderer?: boolean;
  /** 当前已生效的档位；给了就只降不升。 */
  readonly previousTier?: QualityTier | null;
}

export interface GraphModeDecision {
  readonly mode: GraphViewMode;
  readonly tier: QualityTier;
  /** 3D 入口是否显示：无 WebGL、reduced-motion、移动端都不给入口（隐藏而不是置灰）。 */
  readonly canUse3d: boolean;
  /** 节点数超出当前档位预算，渲染前要先 `decimate`。 */
  readonly overBudget: boolean;
  readonly reason: GraphModeReason;
}

/**
 * 判定视图与档位。
 *
 * 顺序：URL 显式 → 无 WebGL → reduced-motion → 移动端 → 超大图 → 默认 3D。
 * URL 的 `mode=3d` 只认「物理上可能」这一条：没有 WebGL 仍然回落 2D。
 */
export function selectGraphMode(input: GraphQualityInput): GraphModeDecision {
  const urlMode = input.urlMode ?? null;
  const nodeCount = Number.isFinite(input.nodeCount) ? input.nodeCount : 0;
  const tier = selectTier(input);
  const overBudget = nodeCount > TIER_BUDGETS[tier].maxNodes;

  let mode: GraphViewMode;
  let reason: GraphModeReason;

  if (urlMode === "list") {
    mode = "list";
    reason = "url-list";
  } else if (urlMode === "2d") {
    mode = "2d";
    reason = "url-2d";
  } else if (urlMode === "3d") {
    if (input.webgl) {
      mode = "3d";
      reason = "url-3d";
    } else {
      mode = "2d";
      reason = "no-webgl";
    }
  } else if (!input.webgl) {
    mode = "2d";
    reason = "no-webgl";
  } else if (input.reducedMotion) {
    mode = "2d";
    reason = "reduced-motion";
  } else if (input.isMobile) {
    mode = "2d";
    reason = "mobile";
  } else if (nodeCount > MAX_3D_LAYOUT_NODES) {
    mode = "2d";
    reason = "too-many-nodes";
  } else {
    mode = "3d";
    reason = "auto-3d";
  }

  return {
    mode,
    tier,
    canUse3d: input.webgl && !input.reducedMotion && !input.isMobile,
    overBudget,
    reason,
  };
}

/**
 * 设备基础档位（ADR-022 第 8 条触发条件）：
 * 移动 / 软件渲染 / 4 核及以下 → low；桌面 ≥8 核且非 reduced-motion → high；其余 balanced。
 * `previousTier` 存在时取更低的那个——只降不升。
 */
function selectTier(input: GraphQualityInput): QualityTier {
  const cores = input.hardwareConcurrency ?? null;
  let base: QualityTier;
  if (input.isMobile || input.softwareRenderer === true || (cores !== null && cores <= 4)) {
    base = "low";
  } else if (!input.reducedMotion && cores !== null && cores >= 8) {
    base = "high";
  } else {
    base = "balanced";
  }

  const previous = input.previousTier ?? null;
  if (previous === null) return base;
  return TIER_ORDER.indexOf(previous) < TIER_ORDER.indexOf(base) ? previous : base;
}

/** 实际渲染 DPR：设备值夹在档位上限内；设备值非法时按 1 处理。 */
export function resolveGraphDpr(tier: QualityTier, devicePixelRatio: number): number {
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  return Math.min(dpr, TIER_BUDGETS[tier].maxDpr);
}

export interface GraphDecimationOptions {
  /** 目标节点数。 */
  readonly budget: number;
  /** 必须保留的节点（选中、hover、路径端点等）。 */
  readonly keepIds?: ReadonlySet<string>;
}

export interface GraphDecimation {
  readonly nodes: readonly GraphNode[];
  readonly edges: GraphViewModel["edges"];
  /** 被挡在提示条后面的节点数（界面上写「+N 个实体未显示」）。 */
  readonly hiddenCount: number;
  readonly truncated: boolean;
}

/**
 * 抽稀（ADR-022 第 9 条）：≤ 预算全保留；超出时保留中心、`keepIds`、**全部 1 跳**，
 * 剩下的名额给 2 跳节点按「度数降序、id 升序」补齐，其余汇总为提示条。
 * 不可达节点（hop 3）不参与补齐，除非显式在 `keepIds` 里。
 *
 * 结果是模型的子序列（不改顺序、不重排），只留两端都在的边；不改 `view`。
 */
export function decimate(
  view: GraphViewModel,
  options: GraphDecimationOptions,
): GraphDecimation {
  const budget = Math.max(0, Math.floor(options.budget));
  if (!Number.isFinite(budget)) return allNodes(view);

  if (view.nodes.length <= budget) return allNodes(view);

  const keepIds = options.keepIds ?? new Set<string>();
  const kept = new Set<string>();
  for (const node of view.nodes) {
    if (node.hop === 1 || node.flags.isCenter || keepIds.has(node.id)) kept.add(node.id);
  }

  const remaining = budget - kept.size;
  if (remaining > 0) {
    // 模型内 nodes 已按 (hop↑, degree↓, id↑) 排好，直接顺序取前 remaining 个 2 跳节点。
    for (const node of view.nodes) {
      if (kept.size >= budget) break;
      if (node.hop !== 2 || kept.has(node.id)) continue;
      kept.add(node.id);
    }
  }

  const nodes = view.nodes.filter((node) => kept.has(node.id));
  const edges = view.edges.filter((edge) => kept.has(edge.source) && kept.has(edge.target));

  return {
    nodes,
    edges,
    hiddenCount: view.nodes.length - nodes.length,
    truncated: nodes.length < view.nodes.length,
  };
}

function allNodes(view: GraphViewModel): GraphDecimation {
  return { nodes: view.nodes, edges: view.edges, hiddenCount: 0, truncated: false };
}
