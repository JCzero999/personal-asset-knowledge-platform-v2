/**
 * 图谱的前端布局：把「中心实体 + 邻居」摆成同心圆。
 *
 * 纯函数、无 IO：给定节点与画布尺寸返回坐标，方便单测。
 * 关系多的实体靠固定排序，保证同一份数据每次渲染位置一致。
 */

export interface LayoutInputNode {
  id: string;
  type?: string;
  description?: string;
}

export interface LayoutNode extends LayoutInputNode {
  x: number;
  y: number;
  /** 节点半径：中心节点更大。 */
  radius: number;
  center: boolean;
}

export interface LayoutOptions {
  width?: number;
  height?: number;
  /** 选中的实体；不在节点里时取第一个。 */
  centerId?: string;
}

const DEFAULT_WIDTH = 640;
const DEFAULT_HEIGHT = 420;

/**
 * 环形布局：
 * - 中心节点放在正中，半径 26；
 * - 其余节点均匀分布在半径 0.36 × min(w,h) 的圆上，半径 14；
 * - 节点按 id 排序，位置因此可复现。
 */
export function layoutRadial(nodes: LayoutInputNode[], options: LayoutOptions = {}): LayoutNode[] {
  if (nodes.length === 0) return [];

  const width = options.width ?? DEFAULT_WIDTH;
  const height = options.height ?? DEFAULT_HEIGHT;
  const cx = width / 2;
  const cy = height / 2;

  const sorted = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
  const centerIndex =
    options.centerId !== undefined ? sorted.findIndex((node) => node.id === options.centerId) : 0;

  const center = sorted[centerIndex >= 0 ? centerIndex : 0];
  const rest = sorted.filter((node) => node !== center);

  const result: LayoutNode[] = [
    { ...center, x: round(cx), y: round(cy), radius: 26, center: true },
  ];

  const ringRadius = Math.min(width, height) * 0.36;
  const count = rest.length;

  rest.forEach((node, index) => {
    // 从正上方开始顺时针排列，单节点时也落在顶部，视觉上稳定。
    const angle = -Math.PI / 2 + (2 * Math.PI * index) / Math.max(count, 1);
    result.push({
      ...node,
      x: round(cx + ringRadius * Math.cos(angle)),
      y: round(cy + ringRadius * Math.sin(angle)),
      radius: 14,
      center: false,
    });
  });

  return result;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

/** 只保留两端都在本次布局里的边，避免画到画布外。 */
export function visibleEdges<T extends { source: string; target: string }>(
  edges: T[],
  nodes: LayoutNode[],
): T[] {
  const ids = new Set(nodes.map((node) => node.id));
  return edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target));
}
