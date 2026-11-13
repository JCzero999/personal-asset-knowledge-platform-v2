import { describe, expect, it } from "vitest";

import { buildGraphViewModel } from "@/lib/graph-model";
import {
  anchorsForSize,
  estimateTextWidth,
  layoutForce2d,
  layoutTicksForNodeCount,
  nodeRadius2d,
  placeLabels,
  NODE_RADIUS_CENTER,
  NODE_RADIUS_MAX,
  NODE_RADIUS_MIN,
} from "@/lib/graph-layout-2d";
import type { LightragEdge, LightragNode } from "@/server/adapters/lightrag/client";

/**
 * 2D 聚焦布局（ADR-022 A8 / 设计稿 §5.2）：
 * 确定性、预算、边界钳制、锚点复用、空图 / 单点、无 NaN，以及标签避让。
 */

const FILE = "pakp:obj:obj1:hash";

function node(id: string, type = ""): LightragNode {
  return { id, type, description: `${id} 的描述`, filePath: FILE };
}

function edge(source: string, target: string, description = "关系<SEP>说明"): LightragEdge {
  return { source, target, description, filePath: FILE };
}

function fanView(neighbors = 12, secondRing = 18) {
  const nodes: LightragNode[] = [node("中心", "concept")];
  const edges: LightragEdge[] = [];
  for (let index = 0; index < neighbors; index += 1) {
    const id = `一层${index}`;
    nodes.push(node(id, index % 2 === 0 ? "person" : "org"));
    edges.push(edge("中心", id));
  }
  for (let index = 0; index < secondRing; index += 1) {
    const id = `二层${index}`;
    nodes.push(node(id, index % 3 === 0 ? "work" : "method"));
    edges.push(edge(`一层${index % neighbors}`, id));
  }
  // 孤立点：不可达，布局放外环。
  nodes.push(node("孤立甲"), node("孤立乙"));
  return buildGraphViewModel({
    subgraph: { nodes, edges },
    status: null,
    center: "中心",
    depth: 2,
    maxNodes: 150,
  });
}

const OPTIONS = { width: 760, height: 560, padding: 32 } as const;

describe("layoutForce2d：确定性", () => {
  it("同一份 view 两次调用逐字段相等", () => {
    const view = fanView();
    const a = layoutForce2d(view, OPTIONS);
    const b = layoutForce2d(view, OPTIONS);
    expect(a.nodes).toEqual(b.nodes);
    expect(a.ticks).toBe(b.ticks);
    expect(a.bounds).toEqual(b.bounds);
  });

  it("输入节点顺序不影响结果（内部按 id 排序迭代）", () => {
    const forward = buildGraphViewModel({
      subgraph: {
        nodes: [node("a"), node("b"), node("c"), node("d")],
        edges: [edge("a", "b"), edge("b", "c"), edge("c", "d")],
      },
      status: null,
      center: "a",
      depth: 3,
      maxNodes: 150,
    });
    const reversed = buildGraphViewModel({
      subgraph: {
        nodes: [node("d"), node("c"), node("b"), node("a")],
        edges: [edge("c", "d"), edge("b", "c"), edge("a", "b")],
      },
      status: null,
      center: "a",
      depth: 3,
      maxNodes: 150,
    });
    const a = layoutForce2d(forward, OPTIONS);
    const b = layoutForce2d(reversed, OPTIONS);
    expect(a.nodes).toEqual(b.nodes);
  });
});

describe("layoutForce2d：预算与边界", () => {
  it("maxTicks 是硬上限", () => {
    const view = fanView();
    for (const maxTicks of [0, 1, 5, 30]) {
      const result = layoutForce2d(view, { ...OPTIONS, maxTicks });
      expect(result.ticks).toBeLessThanOrEqual(maxTicks);
    }
    expect(layoutForce2d(view, { ...OPTIONS, maxTicks: 0 }).ticks).toBe(0);
  });

  it("所有圆心被钳制在 padding 内", () => {
    const result = layoutForce2d(fanView(20, 30), OPTIONS);
    for (const node of result.nodes) {
      expect(node.x).toBeGreaterThanOrEqual(OPTIONS.padding);
      expect(node.x).toBeLessThanOrEqual(OPTIONS.width - OPTIONS.padding);
      expect(node.y).toBeGreaterThanOrEqual(OPTIONS.padding);
      expect(node.y).toBeLessThanOrEqual(OPTIONS.height - OPTIONS.padding);
    }
  });

  it("不产生 NaN / Infinity", () => {
    const result = layoutForce2d(fanView(20, 30), OPTIONS);
    for (const node of result.nodes) {
      expect(Number.isFinite(node.x)).toBe(true);
      expect(Number.isFinite(node.y)).toBe(true);
      expect(Number.isFinite(node.radius)).toBe(true);
    }
    expect(Number.isFinite(result.bounds.minX)).toBe(true);
    expect(Number.isFinite(result.bounds.maxY)).toBe(true);
  });
});

describe("layoutForce2d：锚点与退化输入", () => {
  it("锚点节点坐标原样保留，且连续 5 次布局位置集合不变", () => {
    const view = fanView(6, 6);
    const first = layoutForce2d(view, OPTIONS);
    const anchors: Record<string, readonly [number, number]> = {
      一层0: [200, 180],
      一层1: [520, 240],
    };

    let positions = first.nodes;
    for (let round = 0; round < 5; round += 1) {
      const next = layoutForce2d(view, { ...OPTIONS, anchors });
      expect(next.indexById.size).toBe(view.nodes.length);
      const byId = new Map(next.nodes.map((item) => [item.id, item]));
      expect(byId.get("一层0")?.x).toBe(200);
      expect(byId.get("一层0")?.y).toBe(180);
      expect(byId.get("一层1")?.x).toBe(520);
      expect(byId.get("一层1")?.y).toBe(240);
      if (round > 0) expect(next.nodes).toEqual(positions);
      positions = next.nodes;
    }
  });

  it("空图返回空结果，不抛错", () => {
    const view = buildGraphViewModel({
      subgraph: { nodes: [], edges: [] },
      status: null,
      center: "",
      depth: 2,
      maxNodes: 150,
    });
    const result = layoutForce2d(view, OPTIONS);
    expect(result.nodes).toEqual([]);
    expect(result.ticks).toBe(0);
    expect(result.indexById.size).toBe(0);
  });

  it("单点图落在画布中心", () => {
    const view = buildGraphViewModel({
      subgraph: { nodes: [node("only")], edges: [] },
      status: null,
      center: "only",
      depth: 2,
      maxNodes: 150,
    });
    const result = layoutForce2d(view, OPTIONS);
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].center).toBe(true);
    expect(result.nodes[0].x).toBe(OPTIONS.width / 2);
    expect(result.nodes[0].y).toBe(OPTIONS.height / 2);
    expect(result.nodes[0].radius).toBe(NODE_RADIUS_CENTER);
  });

  it("indexById 与节点顺序互逆", () => {
    const result = layoutForce2d(fanView(), OPTIONS);
    result.nodes.forEach((node, index) => {
      expect(result.indexById.get(node.id)).toBe(index);
    });
  });
});

describe("nodeRadius2d：度数连续、夹在 5–20", () => {
  it("中心固定 26", () => {
    expect(nodeRadius2d(0, true)).toBe(NODE_RADIUS_CENTER);
    expect(nodeRadius2d(42, true)).toBe(NODE_RADIUS_CENTER);
  });

  it("随度数单调不减且落在区间内", () => {
    let previous = 0;
    for (const degree of [0, 1, 2, 5, 10, 30, 100]) {
      const radius = nodeRadius2d(degree);
      expect(radius).toBeGreaterThanOrEqual(NODE_RADIUS_MIN);
      expect(radius).toBeLessThanOrEqual(NODE_RADIUS_MAX);
      expect(radius).toBeGreaterThanOrEqual(previous);
      previous = radius;
    }
    expect(nodeRadius2d(1000)).toBe(NODE_RADIUS_MAX);
  });
});

describe("placeLabels：四级候选位避让", () => {
  it("可见标签互不重叠且留在画布内", () => {
    const layout = layoutForce2d(fanView(10, 14), OPTIONS);
    const labels = Object.fromEntries(
      layout.nodes.map((item) => [item.id, item.id.length > 8 ? `${item.id}…` : item.id]),
    );
    const placements = placeLabels(layout.nodes, labels, {
      width: OPTIONS.width,
      height: OPTIONS.height,
      fontSize: 11,
    });

    expect(placements).toHaveLength(layout.nodes.length);
    const visible = placements.filter((item) => item.visible);
    expect(visible.length).toBeGreaterThan(0);

    for (const item of visible) {
      const left =
        item.anchor === "start" ? item.x : item.anchor === "end" ? item.x - item.width : item.x - item.width / 2;
      expect(left).toBeGreaterThanOrEqual(0);
      expect(left + item.width).toBeLessThanOrEqual(OPTIONS.width);
    }

    for (let i = 0; i < visible.length; i += 1) {
      for (let j = i + 1; j < visible.length; j += 1) {
        const a = rectOf(visible[i]);
        const b = rectOf(visible[j]);
        const overlap = a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
        expect(overlap).toBe(false);
      }
    }
  });

  it("优先 id 先拿到位置；onlyIds 模拟缩放 LOD", () => {
    const layout = layoutForce2d(fanView(4, 0), OPTIONS);
    const labels = Object.fromEntries(layout.nodes.map((item) => [item.id, item.id]));
    const placements = placeLabels(layout.nodes, labels, {
      width: OPTIONS.width,
      height: OPTIONS.height,
      fontSize: 11,
      priorityIds: ["一层0", "中心"],
    });
    const byId = new Map(placements.map((item) => [item.id, item]));
    expect(byId.get("一层0")?.visible).toBe(true);
    expect(byId.get("中心")?.visible).toBe(true);

    const lod = placeLabels(layout.nodes, labels, {
      width: OPTIONS.width,
      height: OPTIONS.height,
      fontSize: 11,
      onlyIds: new Set(["中心"]),
    });
    expect(lod.filter((item) => item.visible).map((item) => item.id)).toEqual(["中心"]);
  });
});

describe("estimateTextWidth", () => {
  it("中文按 1em、英文按 0.56em 估算", () => {
    expect(estimateTextWidth("设计系统", 11)).toBeCloseTo(44, 5);
    expect(estimateTextWidth("graph", 10)).toBeCloseTo(28, 5);
  });
});

function rectOf(label: { x: number; y: number; width: number; anchor: string }) {
  const left =
    label.anchor === "start" ? label.x : label.anchor === "end" ? label.x - label.width : label.x - label.width / 2;
  return { left, right: left + label.width, top: label.y - 14, bottom: label.y };
}

describe("尺寸换档：旧锚点作废（阻断项 1）", () => {
  it("anchorsForSize：同尺寸复用，换档与首次测量都返回空表", () => {
    const anchors = { 一层0: [200, 180] as const };
    expect(anchorsForSize(anchors, { width: 760, height: 560 }, { width: 760, height: 560 })).toEqual({
      一层0: [200, 180],
    });
    expect(anchorsForSize(anchors, { width: 760, height: 560 }, { width: 384, height: 560 })).toEqual({});
    expect(anchorsForSize(anchors, { width: 760, height: 560 }, { width: 760, height: 320 })).toEqual({});
    expect(anchorsForSize(anchors, null, { width: 760, height: 560 })).toEqual({});
  });

  it("760 → 390：沿用旧锚点会把绝大多数节点夹到边界，换档重排后不会", () => {
    const view = fanView(10, 14);
    const wide = layoutForce2d(view, { width: 760, height: 560, padding: 32 });
    const anchors: Record<string, readonly [number, number]> = {};
    for (const item of wide.nodes) anchors[item.id] = [item.x, item.y];

    const narrow = { width: 384, height: 560, padding: 32 };
    const pinned = layoutForce2d(view, { ...narrow, anchors });
    const pinnedAtEdge = pinned.nodes.filter((item) => item.x <= 32.5 || item.x >= 351.5).length;
    // 旧锚点钉住且被 clamp：绝大多数节点贴在新画布左右边界上，而且永不自愈。
    expect(pinnedAtEdge).toBeGreaterThan(pinned.nodes.length / 2);

    const relayout = layoutForce2d(view, {
      ...narrow,
      anchors: anchorsForSize(anchors, { width: 760, height: 560 }, narrow),
    });
    const atEdge = relayout.nodes.filter((item) => item.x <= 32.5 || item.x >= 351.5).length;
    expect(atEdge).toBeLessThan(relayout.nodes.length / 2);
    expect(relayout.nodes.some((item) => item.x > 60 && item.x < 324)).toBe(true);
  });
});

describe("布局预算：按节点数降档（阻断项 R9）", () => {
  it("150 以内保持 300 tick，之后逐档收缩", () => {
    expect(layoutTicksForNodeCount(0)).toBe(300);
    expect(layoutTicksForNodeCount(150)).toBe(300);
    expect(layoutTicksForNodeCount(151)).toBeLessThan(300);
    expect(layoutTicksForNodeCount(600)).toBeLessThan(layoutTicksForNodeCount(300));
    expect(layoutTicksForNodeCount(2000)).toBeLessThanOrEqual(60);
    expect(layoutTicksForNodeCount(Number.NaN)).toBe(300);
  });

  it("600 节点的同步布局在预算内完成", () => {
    const nodes: LightragNode[] = [node("中心", "concept")];
    const edges: LightragEdge[] = [];
    for (let index = 0; index < 599; index += 1) {
      nodes.push(node(`星点${index}`, index % 2 === 0 ? "person" : "org"));
      edges.push(edge("中心", `星点${index}`));
    }
    const view = buildGraphViewModel({
      subgraph: { nodes, edges },
      status: null,
      center: "中心",
      depth: 2,
      maxNodes: 600,
    });
    const maxTicks = layoutTicksForNodeCount(view.nodes.length);
    const started = performance.now();
    const result = layoutForce2d(view, { width: 1280, height: 720, padding: 40, maxTicks });
    const elapsed = performance.now() - started;

    expect(result.nodes).toHaveLength(600);
    expect(result.ticks).toBeLessThanOrEqual(120);
    expect(elapsed).toBeLessThan(1500);
  });
});
