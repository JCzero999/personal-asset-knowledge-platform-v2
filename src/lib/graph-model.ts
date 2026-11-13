/**
 * 知识图谱的共享视图模型（ADR-022 附录 A2，**冻结件**）。
 *
 * 这是整个仓库里唯一认识 LightRAG 字段名的地方：类型 → 形状 / 颜色、
 * 度数、hop、标签截断、边的合并与关系名派生全在这里算一次。
 * 2D、3D、列表三种渲染器只读 `GraphViewModel`，不许各自再写一份映射
 * （两份映射就是两份真值，与 ADR-021 背景里「三套 token 词汇」同一类病）。
 *
 * 三条硬约束：
 * - 纯函数：无 IO、无 `Date`、无 `Math.random`、无 `performance`；不修改入参；
 * - 不带坐标：坐标是布局产物（A1），3D 与 2D 各有各的一份；
 * - 排序是契约的一部分：`nodes` 按 (hop↑, degree↓, id↑)，`edges` 按 (weight↓, id↑)。
 */

import type { LightragSubgraph } from "@/server/adapters/lightrag/client";
import type { GraphStatus } from "@/server/services/graph-service";

export type GraphEntityType = "concept" | "person" | "org" | "work" | "method" | "other";
export type GraphNodeShape =
  | "circle"
  | "double-ring"
  | "round-square"
  | "diamond"
  | "hexagon"
  | "dot";
export type GraphColorToken =
  | "--graph-node-concept"
  | "--graph-node-person"
  | "--graph-node-org"
  | "--graph-node-work"
  | "--graph-node-method"
  | "--graph-node-other";
export type GraphEdgeColorToken = "--graph-edge" | "--graph-edge-strong";
export type NodeSizeTier = "s" | "m" | "l" | "xl";
/** 请求深度与边所在环：只有 1 / 2 / 3。 */
export type GraphHop = 1 | 2 | 3;
/**
 * 节点到中心的 BFS 距离：中心自身是 **0**，不可达记 3。
 *
 * ADR-022 A2 把 `GraphNode.hop` 写成 `GraphHop`（1–3），但同一条规则里的 BFS 定义
 * 让中心距离为 0；强塞成 1 会把星核放进 1 跳环，布局必然错位。故单列此类型。
 */
export type GraphNodeHop = 0 | 1 | 2 | 3;

export interface GraphNode {
  /** LightRAG 的 node.id。LightRAG 用实体名作 id，所以它同时是稳定键与展示名。 */
  readonly id: string;
  /** 完整名，= id.trim()，不截断；详情栏、列表、aria-label 用这个。 */
  readonly label: string;
  /** 屏幕标签用，按码点截断：中心 12 字 / 其余 10 字，超出加「…」。 */
  readonly shortLabel: string;
  /** 映射后的六大类，认不出落 other。 */
  readonly type: GraphEntityType;
  /** LightRAG 原始 entity_type 文本：只在详情栏展示，不参与任何逻辑与样式。 */
  readonly rawType: string;
  readonly shape: GraphNodeShape;
  /** 只给 token 名，不给色值：2D 与 3D 各自读同一个 CSS 变量。 */
  readonly colorToken: GraphColorToken;
  /** 去重后的边条数（自环与悬空边不计）。 */
  readonly degree: number;
  readonly hop: GraphNodeHop;
  readonly size: NodeSizeTier;
  readonly flags: {
    /** 本次请求的中心实体：每张图恰好 1 个；中心不在返回集合里时为 0 个。 */
    readonly isCenter: boolean;
    /** degree === 0，ADR-011 过滤后的孤立点。 */
    readonly isOrphan: boolean;
    /** BFS 从中心到不了（碎图）。这类节点 hop 记 3，布局放最外环。 */
    readonly isUnreachable: boolean;
    /** description 为空，详情栏要出空态文案。 */
    readonly hasDescription: boolean;
  };
}

export interface GraphEdge {
  /** 稳定键：排序后的端点对 + 关系名，见 A2 规则 9。抽稀、单测、React key 都用它。 */
  readonly id: string;
  readonly source: string;
  readonly target: string;
  /** 关系名（派生，见 A2 规则 5）。 */
  readonly type: string;
  /** 关系原文，详情栏显示，不截断。 */
  readonly description: string;
  /** 平行关系条数（≥1）。**不是语义强度**，只用于排序与线宽分档。 */
  readonly weight: number;
  /** v1 恒为 "none"：LightRAG 的 source/target 是抽取方向，不是语义方向。 */
  readonly direction: "none";
  readonly hop: 1 | 2;
  /** hop === 1 或 weight >= 2。 */
  readonly strong: boolean;
  readonly colorToken: GraphEdgeColorToken;
}

export interface GraphFailure {
  readonly objectId: string;
  readonly error: string;
}

export interface GraphMeta {
  readonly center: string;
  readonly depth: GraphHop;
  /** 过滤后的节点数（= nodes.length，冗余一份给状态条）。 */
  readonly total: number;
  /** 本次请求的 maxNodes；截断推断要用它，所以必须留在 meta 里。 */
  readonly requestMaxNodes: number;
  /**
   * 推断值，见 A5.3：`receivedNodeCount >= requestMaxNodes`。
   * **反向不成立**——ADR-011 的账号过滤发生在截断之后，返回数小于请求数也可能是被截断的。
   */
  readonly truncated: boolean;
  readonly truncatedSource: "inferred" | "server";
  /** 来自 /api/graph/status；未请求或请求失败时为空数组。 */
  readonly failed: readonly GraphFailure[];
  /** 状态接口没有时间戳，v1 恒为 null；有值才显示。 */
  readonly lastSync: string | null;
  /** 丢掉的边，只用于调试与单测，界面上不显示。 */
  readonly dropped: {
    readonly selfLoops: number;
    readonly danglingEdges: number;
    readonly nameless: number;
  };
  /** 两个请求各自的成败，状态条据此区分「图失败」与「状态失败」。 */
  readonly sources: { readonly graph: "ok" | "error"; readonly status: "ok" | "error" | "skipped" };
}

export interface GraphViewModel {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
  /** id → nodes 下标，build 时建好一次，渲染器不许自己再建。 */
  readonly nodeIndex: ReadonlyMap<string, number>;
  readonly meta: GraphMeta;
  /** 布局缓存键与截图基线都带它。 */
  readonly modelVersion: number;
}

export interface GraphBuildInput {
  readonly subgraph: LightragSubgraph;
  /** 状态接口的结果；没拿到就传 null，meta.sources.status 记 skipped。 */
  readonly status: GraphStatus | null;
  /**
   * 状态接口本次是**失败**（区别于「没请求」）。A5.2 要求状态条能区分
   * 「构图进度暂不可用」与「未请求」，而 status=null 同时表示这两种，故补这一个可选位。
   */
  readonly statusFailed?: boolean;
  readonly center: string;
  readonly depth: GraphHop;
  readonly maxNodes: number;
}

/** 模型版本：只在映射 / 排序 / 派生规则变更时 bump，布局缓存键与截图基线都带它。 */
export const GRAPH_MODEL_VERSION = 1;

/** 边 id 的分隔符：不可打印的 U+0001，避免实体名里的竖线造成键碰撞。 */
const EDGE_ID_SEPARATOR = "\u0001";

/** 关系名派生的兜底值。 */
export const RELATION_FALLBACK = "相关";

/** 关系名最多保留的字符数（A2 规则 5）。 */
const RELATION_MAX_CHARS = 12;

/** 中心节点的屏幕标签长度；其余节点 10 字（A2）。 */
const SHORT_LABEL_CENTER = 12;
const SHORT_LABEL_OTHER = 10;

interface EntityRule {
  readonly type: GraphEntityType;
  readonly pattern: RegExp;
}

/**
 * 类型映射表（A2 规则 3）：**只做小写关键词匹配，不猜语义**，顺序敏感、先命中先赢。
 * `entity_type` 是 LightRAG 的自由文本，会出现 `Person` / `人物` / 空串 / 全角字母。
 */
export const ENTITY_RULES: readonly EntityRule[] = [
  { type: "person", pattern: /person|人物|人/ },
  { type: "org", pattern: /organi[sz]ation|org|组织|机构|公司/ },
  { type: "work", pattern: /work|作品|资产|asset|content/ },
  { type: "method", pattern: /method|process|方法|流程|步骤|技术/ },
  { type: "concept", pattern: /concept|概念|理论|主题|topic/ },
];

/** 六类的形状 / 颜色 token / 中文名（A2 规则 4）。组件里不许再出现类型名字面量。 */
export const ENTITY_STYLE: Readonly<
  Record<GraphEntityType, { readonly shape: GraphNodeShape; readonly colorToken: GraphColorToken; readonly labelZh: string }>
> = {
  concept: { shape: "circle", colorToken: "--graph-node-concept", labelZh: "概念" },
  person: { shape: "double-ring", colorToken: "--graph-node-person", labelZh: "人物" },
  org: { shape: "round-square", colorToken: "--graph-node-org", labelZh: "组织" },
  work: { shape: "diamond", colorToken: "--graph-node-work", labelZh: "作品 / 资产" },
  method: { shape: "hexagon", colorToken: "--graph-node-method", labelZh: "方法 / 流程" },
  other: { shape: "dot", colorToken: "--graph-node-other", labelZh: "其他" },
};

/** 度数 → 尺寸档（A2 规则 8，闭合区间，与分位数无关）。 */
export function sizeForDegree(degree: number): NodeSizeTier {
  if (degree <= 1) return "s";
  if (degree <= 4) return "m";
  if (degree <= 9) return "l";
  return "xl";
}

/** 单次关键词映射；入参做 NFKC + trim + 小写归一，空串与认不出的都落 `other`。 */
export function mapEntityType(rawType: string): GraphEntityType {
  const normalized = (rawType ?? "").normalize("NFKC").trim().toLowerCase();
  if (!normalized) return "other";
  for (const rule of ENTITY_RULES) {
    if (rule.pattern.test(normalized)) return rule.type;
  }
  return "other";
}

/** 按码点截断（emoji / 代理对不会被劈成半个）。 */
function truncateByCodePoint(text: string, max: number, ellipsis: boolean): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return `${chars.slice(0, max).join("")}${ellipsis ? "…" : ""}`;
}

/** 去掉首尾的引号（中英文都给），用于关系名派生。 */
function stripQuotes(text: string): string {
  return text.replace(/^["'“”‘’「」『』]+/, "").replace(/["'“”‘’「」『』]+$/, "").trim();
}

/**
 * 关系名派生（A2 规则 5），按序取第一个命中的：
 * 1. `description` 里 `<SEP>` 分隔段的第一个词（LightRAG 的格式是「关键词<SEP>描述」）；
 * 2. 没有 `<SEP>` 时取首行前 12 个字符（去掉首尾引号）；
 * 3. 都为空 → `"相关"`。
 *
 * 校准只改这个函数体，不改契约。
 */
export function deriveRelationLabel(description: string): string {
  const text = (description ?? "").trim();
  if (!text) return RELATION_FALLBACK;

  if (/<SEP>/i.test(text)) {
    for (const rawSegment of text.split(/<SEP>/i)) {
      const segment = rawSegment.trim();
      if (!segment) continue;
      const firstLine = stripQuotes((segment.split(/\r?\n/)[0] ?? "").trim());
      const firstWord = stripQuotes((firstLine.split(/\s+/)[0] ?? "").replace(/[,，、;；:：]+$/, ""));
      if (firstWord) return truncateByCodePoint(firstWord, RELATION_MAX_CHARS, false);
    }
    return RELATION_FALLBACK;
  }

  const firstLine = stripQuotes((text.split(/\r?\n/)[0] ?? "").trim());
  if (!firstLine) return RELATION_FALLBACK;
  return truncateByCodePoint(firstLine, RELATION_MAX_CHARS, false);
}

/** 边 id（A2 规则 9）：排序后的端点对 + 关系名，U+0001 连接。 */
export function graphEdgeId(source: string, target: string, type: string): string {
  const [first, second] = [source, target].sort();
  return `${first}${EDGE_ID_SEPARATOR}${second}${EDGE_ID_SEPARATOR}${type}`;
}

/** 码点序比较：固定、跨环境一致，不能换成 localeCompare（截图基线与逐字节比对靠它）。 */
function compareIds(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

interface NodeSeed {
  label: string;
  rawType: string;
  description: string;
}

interface EdgeSeed {
  source: string;
  target: string;
  type: string;
  description: string;
  weight: number;
}

/**
 * LightRAG 子图 + 状态 → `GraphViewModel`。
 *
 * 生成规则全在 A2 表里（1–11 条），尤其是：同 id 只保留首个、自环与悬空边只计数不抛错、
 * BFS 只走 hop ≤ depth、排序固定、`truncated` 只做单向推断。
 */
export function buildGraphViewModel(input: GraphBuildInput): GraphViewModel {
  const { subgraph, status, center, depth, maxNodes } = input;
  const centerLabel = (center ?? "").trim();

  const nodeSeeds = new Map<string, NodeSeed>();
  let nameless = 0;

  for (const node of subgraph.nodes ?? []) {
    const label = (node.id ?? "").trim();
    if (!label) {
      nameless += 1;
      continue;
    }
    if (nodeSeeds.has(node.id)) continue;
    nodeSeeds.set(node.id, {
      label,
      rawType: node.type ?? "",
      description: (node.description ?? "").trim(),
    });
  }

  let selfLoops = 0;
  let danglingEdges = 0;
  const edgeSeeds = new Map<string, EdgeSeed>();

  for (const edge of subgraph.edges ?? []) {
    const source = edge.source ?? "";
    const target = edge.target ?? "";
    if (source === target) {
      selfLoops += 1;
      continue;
    }
    if (!nodeSeeds.has(source) || !nodeSeeds.has(target)) {
      danglingEdges += 1;
      continue;
    }

    const description = (edge.description ?? "").trim();
    const type = deriveRelationLabel(description);
    const id = graphEdgeId(source, target, type);
    const existing = edgeSeeds.get(id);
    if (existing) {
      existing.weight += 1;
      // 平行边合并时保留首条非空原文，详情栏显示这一条。
      if (!existing.description && description) existing.description = description;
      continue;
    }
    edgeSeeds.set(id, { source, target, type, description, weight: 1 });
  }

  const adjacency = new Map<string, string[]>();
  for (const id of nodeSeeds.keys()) adjacency.set(id, []);
  const degreeById = new Map<string, number>();
  for (const seed of edgeSeeds.values()) {
    adjacency.get(seed.source)?.push(seed.target);
    adjacency.get(seed.target)?.push(seed.source);
    degreeById.set(seed.source, (degreeById.get(seed.source) ?? 0) + 1);
    degreeById.set(seed.target, (degreeById.get(seed.target) ?? 0) + 1);
  }

  const hops = computeHops(adjacency, centerLabel, depth, nodeSeeds);

  const nodes: GraphNode[] = [];
  for (const [id, seed] of nodeSeeds) {
    const hopValue = hops.get(id);
    const isCenter = centerLabel !== "" && seed.label === centerLabel;
    const degree = degreeById.get(id) ?? 0;
    const type = mapEntityType(seed.rawType);
    const style = ENTITY_STYLE[type];
    nodes.push({
      id,
      label: seed.label,
      shortLabel: truncateByCodePoint(
        seed.label,
        isCenter ? SHORT_LABEL_CENTER : SHORT_LABEL_OTHER,
        true,
      ),
      type,
      rawType: seed.rawType,
      shape: style.shape,
      colorToken: style.colorToken,
      degree,
      hop: (hopValue ?? 3) as GraphNodeHop,
      size: sizeForDegree(degree),
      flags: {
        isCenter,
        isOrphan: degree === 0,
        isUnreachable: hopValue === undefined,
        hasDescription: seed.description !== "",
      },
    });
  }

  nodes.sort(
    (a, b) => a.hop - b.hop || b.degree - a.degree || compareIds(a.id, b.id),
  );

  const nodeIndex = new Map<string, number>();
  nodes.forEach((node, index) => nodeIndex.set(node.id, index));

  const edges: GraphEdge[] = [];
  for (const [id, seed] of edgeSeeds) {
    // 边所在环 = 两端里更远的那个（下限 1、上限 2）：中心到 1 跳的边算 1 跳，
    // 挂在 2 跳上的边算 2 跳，不可达节点的边也归 2 跳（不再分档）。
    const hop = Math.min(2, Math.max(hops.get(seed.source) ?? 3, hops.get(seed.target) ?? 3, 1)) as 1 | 2;
    const strong = hop === 1 || seed.weight >= 2;
    edges.push({
      id,
      source: seed.source,
      target: seed.target,
      type: seed.type,
      description: seed.description,
      weight: seed.weight,
      direction: "none",
      hop,
      strong,
      colorToken: strong ? "--graph-edge-strong" : "--graph-edge",
    });
  }

  edges.sort((a, b) => b.weight - a.weight || compareIds(a.id, b.id));

  const sources: GraphMeta["sources"] = {
    graph: "ok",
    status: status ? "ok" : input.statusFailed ? "error" : "skipped",
  };

  return {
    nodes,
    edges,
    nodeIndex,
    modelVersion: GRAPH_MODEL_VERSION,
    meta: {
      center: centerLabel,
      depth,
      total: nodes.length,
      requestMaxNodes: maxNodes,
      // A5.3：只做单向推断。`received < maxNodes` **不能**反证未截断（ADR-011 先截断后过滤）。
      truncated: (subgraph.nodes?.length ?? 0) >= maxNodes,
      truncatedSource: "inferred",
      failed: (status?.failed ?? []).map((failure) => ({
        objectId: failure.objectId,
        error: failure.error,
      })),
      lastSync: null,
      dropped: { selfLoops, danglingEdges, nameless },
      sources,
    },
  };
}

/**
 * 从中心做 BFS（只走 hop ≤ depth），返回「节点 id → hop」。
 * 中心不在集合里时返回空表——绑定方据此把所有节点记为 hop 3 + isUnreachable。
 */
function computeHops(
  adjacency: ReadonlyMap<string, readonly string[]>,
  centerId: string,
  depth: GraphHop,
  nodeSeeds: ReadonlyMap<string, NodeSeed>,
): Map<string, number> {
  const hops = new Map<string, number>();
  const start = [...nodeSeeds].find(([, seed]) => seed.label === centerId)?.[0];
  if (start === undefined) return hops;

  hops.set(start, 0);
  let frontier: string[] = [start];
  for (let hop = 1; hop <= depth && frontier.length > 0; hop += 1) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const neighborId of adjacency.get(id) ?? []) {
        if (hops.has(neighborId)) continue;
        hops.set(neighborId, hop);
        next.push(neighborId);
      }
    }
    frontier = next;
  }
  return hops;
}
