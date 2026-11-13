/**
 * 图谱的选中 / 邻域 / 路径（ADR-022 附录 A4，**冻结件**）。
 *
 * 三个渲染器（3D / 2D / 列表）只消费 `GraphHighlight`：
 * 自己算邻域或自己求「全部边 − 高亮边」的补集，就会在平行边合并、
 * 悬空边、`weight > 1` 的边上分叉——这里是唯一真值。
 *
 * `GraphSelection` **不进 view-model**：选中是视图态，写进模型会让「点一下」
 * 变成模型失效、布局缓存 miss、整图重排。
 */

import type { GraphEdge, GraphViewModel } from "./graph-model";

export interface GraphSelection {
  /** URL ?focus=，2D 的圆心、3D 的取景中心；与「选中」是两件事。 */
  readonly focusId: string | null;
  readonly selectedId: string | null;
  readonly hoverId: string | null;
  /** 「查看路径」的目标端点；null 表示不显示路径。 */
  readonly pathTo: string | null;
}

export interface GraphHighlight {
  /** 需要点亮的节点（选中 + 1 跳邻域 + 路径）。 */
  readonly nodes: ReadonlySet<string>;
  readonly edges: ReadonlySet<string>;
  /** 其余节点降不透明度；空集表示不降（无选中时）。 */
  readonly dimmed: ReadonlySet<string>;
  /** 需要压暗的**边**（= 全部边 − `edges`）；同样只在选中时非空。 */
  readonly dimmedEdges: ReadonlySet<string>;
  /** 路径的节点序列，含两端；无路径为 null。 */
  readonly path: readonly string[] | null;
}

const EMPTY_SET: ReadonlySet<string> = new Set<string>();

export const EMPTY_GRAPH_HIGHLIGHT: GraphHighlight = {
  nodes: EMPTY_SET,
  edges: EMPTY_SET,
  dimmed: EMPTY_SET,
  dimmedEdges: EMPTY_SET,
  path: null,
};

/**
 * 选中 → 高亮集合。
 *
 * 点亮规则（A4）：选中节点 + 它的 1 跳邻域 + 路径上的节点；边则点亮「挂在选中节点上」的边
 * 与路径边（邻居之间那条边不点亮，它不是以选中为中心的关系）。
 *
 * 压暗的真实规则：**hover 也是锚点**。没有选中时，`hoverId` 顶替它参与同一套计算，
 * 于是 `dimmed` / `dimmedEdges` 非空、整层除悬停邻域外全部压暗——这是产品要的
 * 「悬停预览」，不是漏判。选中与悬停同时存在时以选中为准；两者都没有才返回空集
 * （空集表示不压暗，渲染器据此保持全亮）。
 *
 * 全部边 − 高亮边 的补集在这里一次算完，`dimmedEdges` 直接给结果。
 */
export function selectGraphHighlight(
  view: GraphViewModel,
  selection: GraphSelection,
): GraphHighlight {
  const selected = resolveExisting(view, selection.selectedId);
  const anchor = selected ?? resolveExisting(view, selection.hoverId);
  const path = resolvePath(view, selection);
  if (anchor === null && path === null) return EMPTY_GRAPH_HIGHLIGHT;

  const nodes = new Set<string>();
  if (path) {
    for (const id of path) nodes.add(id);
  }

  const edges = new Set<string>();
  if (anchor !== null) {
    nodes.add(anchor);
    for (const edge of view.edges) {
      if (edge.source !== anchor && edge.target !== anchor) continue;
      edges.add(edge.id);
      nodes.add(edge.source === anchor ? edge.target : edge.source);
    }
  }

  if (path) {
    for (let index = 0; index < path.length - 1; index += 1) {
      const edge = findEdgeBetween(view, path[index], path[index + 1]);
      if (edge) edges.add(edge.id);
    }
  }

  const dimmed = new Set<string>();
  for (const node of view.nodes) {
    if (!nodes.has(node.id)) dimmed.add(node.id);
  }

  const dimmedEdges = new Set<string>();
  for (const edge of view.edges) {
    if (!edges.has(edge.id)) dimmedEdges.add(edge.id);
  }

  return { nodes, edges, dimmed, dimmedEdges, path };
}

/**
 * 最短路径（按边数），返回节点序列（含两端）；任一端不存在或不可达返回 null。
 * 自反（from === to）返回单元素数组；方向按 BFS 找到的那条，边本身无方向语义。
 */
export function findShortestPath(
  view: GraphViewModel,
  fromId: string,
  toId: string,
): string[] | null {
  if (!view.nodeIndex.has(fromId) || !view.nodeIndex.has(toId)) return null;
  if (fromId === toId) return [fromId];

  const adjacency = buildAdjacency(view);
  const previous = new Map<string, string>();
  const queue: string[] = [fromId];
  const seen = new Set<string>([fromId]);

  while (queue.length > 0) {
    const current = queue.shift() as string;
    for (const next of adjacency.get(current) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      previous.set(next, current);
      if (next === toId) return reconstruct(previous, fromId, toId);
      queue.push(next);
    }
  }
  return null;
}

/** 路径的起点：优先选中，其次 URL 的取景中心；两者都不在集合里时不出路径。 */
function resolvePath(view: GraphViewModel, selection: GraphSelection): string[] | null {
  if (!selection.pathTo) return null;
  const fromId = resolveExisting(view, selection.selectedId) ?? resolveExisting(view, selection.focusId);
  if (fromId === null) return null;
  return findShortestPath(view, fromId, selection.pathTo);
}

function resolveExisting(view: GraphViewModel, id: string | null): string | null {
  if (!id) return null;
  return view.nodeIndex.has(id) ? id : null;
}

/** 邻接表按模型里的边顺序（weight↓, id↑）建立，BFS 结果因此可复现。 */
function buildAdjacency(view: GraphViewModel): Map<string, string[]> {
  const adjacency = new Map<string, string[]>();
  for (const node of view.nodes) adjacency.set(node.id, []);
  for (const edge of view.edges) {
    adjacency.get(edge.source)?.push(edge.target);
    adjacency.get(edge.target)?.push(edge.source);
  }
  return adjacency;
}

function reconstruct(previous: ReadonlyMap<string, string>, fromId: string, toId: string): string[] {
  const path: string[] = [toId];
  let current = toId;
  while (current !== fromId) {
    const parent = previous.get(current);
    if (parent === undefined) return [fromId, toId];
    path.push(parent);
    current = parent;
  }
  return path.reverse();
}

/**
 * 两个相邻节点之间的边：优先 `strong`、再按模型顺序取第一条。
 * 平行边在模型里已合并成一条 `weight > 1` 的边，所以这里通常只有一条。
 */
function findEdgeBetween(view: GraphViewModel, a: string, b: string): GraphEdge | null {
  let fallback: GraphEdge | null = null;
  for (const edge of view.edges) {
    const connects =
      (edge.source === a && edge.target === b) || (edge.source === b && edge.target === a);
    if (!connects) continue;
    if (edge.strong) return edge;
    fallback ??= edge;
  }
  return fallback;
}
