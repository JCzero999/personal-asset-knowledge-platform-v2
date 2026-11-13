import { describe, expect, it } from "vitest";

import { buildGraphViewModel, graphEdgeId, RELATION_FALLBACK, type GraphViewModel } from "@/lib/graph-model";
import { layoutGalaxy3d } from "@/lib/graph-layout-3d";
import {
  anchorsFromResult,
  createStarfieldPositions,
  dimLinear,
  inferAnchorNode,
  labelCandidates,
  layoutLabels,
  layoutSeedKey,
  packLabelAtlas,
  parseCssColor,
  rgbaToLinear,
  shapeIndex,
  shouldUseWorker,
  splitEdges,
  visualRadius,
  CORE_WORLD_RADIUS,
  NODE_SIZE_SCALE,
  SELECTED_SCALE,
  type GraphPalette,
  type ProjectedLabel,
} from "@/lib/graph-render";
import type { GraphHighlight } from "@/lib/graph-selectors";
import { EMPTY_GRAPH_HIGHLIGHT } from "@/lib/graph-selectors";
import type { LightragEdge, LightragNode } from "@/server/adapters/lightrag/client";

/**
 * 3D 渲染层的纯函数（A6 清单里「边分组 / 标签预算 / 颜色变量 / 缓存键 / Worker 阈值」）。
 *
 * node 环境、不引 jsdom、不测 WebGL：这里只是渲染组件会调用的决策函数，
 * 每条断言都对应设计稿或 ADR 里一句可以复述的规则。
 */

const FILE_PATH = "pakp:obj:obj1:abc";

function node(id: string, type = "concept"): LightragNode {
  return { id, type, description: "", filePath: FILE_PATH };
}

function edge(source: string, target: string): LightragEdge {
  return { source, target, description: "", filePath: FILE_PATH };
}

function buildView(spec: {
  nodes: readonly string[];
  edges: readonly (readonly [string, string])[];
  center?: string;
  depth?: 1 | 2 | 3;
}): GraphViewModel {
  return buildGraphViewModel({
    subgraph: {
      nodes: spec.nodes.map((id) => node(id)),
      edges: spec.edges.map(([source, target]) => edge(source, target)),
    },
    status: null,
    center: spec.center ?? spec.nodes[0] ?? "",
    depth: spec.depth ?? 3,
    maxNodes: 600,
  });
}

function highlightOf(
  nodes: readonly string[],
  edges: readonly string[],
  path: readonly string[] | null = null,
): GraphHighlight {
  return {
    nodes: new Set(nodes),
    edges: new Set(edges),
    dimmed: new Set<string>(),
    dimmedEdges: new Set<string>(),
    path,
  };
}

const PALETTE: GraphPalette = {
  canvas: [0.02, 0.016, 0.03, 1],
  core: [0.96, 0.89, 0.78, 1],
  accent: [0.96, 0.89, 0.78, 1],
  nodeDisk: [0.05, 0.05, 0.075, 1],
  nodes: {
    "--graph-node-concept": [0.9, 0.75, 0.54, 1],
    "--graph-node-person": [0.66, 0.61, 0.76, 1],
    "--graph-node-org": [0.69, 0.54, 0.42, 1],
    "--graph-node-work": [0.56, 0.65, 0.72, 1],
    "--graph-node-method": [0.62, 0.7, 0.6, 1],
    "--graph-node-other": [0.49, 0.45, 0.52, 1],
  },
  edge: [0.95, 0.94, 0.91, 0.14],
  edgeStrong: [0.95, 0.94, 0.91, 0.2],
};

describe("颜色 token 解析", () => {
  it("解析 #rrggbb / #rgb / #rrggbbaa", () => {
    expect(parseCssColor("#050408")).toEqual([5 / 255, 4 / 255, 8 / 255, 1]);
    expect(parseCssColor("#fff")).toEqual([1, 1, 1, 1]);
    expect(parseCssColor("#f6e3c680")).toEqual([246 / 255, 227 / 255, 198 / 255, 128 / 255]);
  });

  it("解析 CSS 变量的原始文本 rgb(r g b / a%)", () => {
    const color = parseCssColor("rgb(243 239 231 / 14%)");
    expect(color).not.toBeNull();
    expect(color![0]).toBeCloseTo(243 / 255, 6);
    expect(color![3]).toBeCloseTo(0.14, 6);
  });

  it("解析 rgba(r, g, b, a) 与百分比通道", () => {
    expect(parseCssColor("rgba(255, 0, 0, 0.5)")).toEqual([1, 0, 0, 0.5]);
    const percent = parseCssColor("rgb(50% 100% 0% / 25%)");
    expect(percent![0]).toBeCloseTo(0.5, 6);
    expect(percent![1]).toBeCloseTo(1, 6);
    expect(percent![3]).toBeCloseTo(0.25, 6);
  });

  it("认不出的色值返回 null（调用方回退到 A2.1 token）", () => {
    expect(parseCssColor("")).toBeNull();
    expect(parseCssColor("color-mix(in srgb, red 50%, blue)")).toBeNull();
    expect(parseCssColor("#12345")).toBeNull();
  });

  it("sRGB → 线性光：端点固定，0.5 走 gamma 曲线", () => {
    expect(rgbaToLinear([0, 0, 0, 1])).toEqual([0, 0, 0]);
    expect(rgbaToLinear([1, 1, 1, 0.3])).toEqual([1, 1, 1]);
    expect(rgbaToLinear([0.5, 0.5, 0.5, 1])[0]).toBeCloseTo(0.21404114, 6);
  });

  it("压暗是线性乘系数（边逐段 dimmed 只能改颜色）", () => {
    expect(dimLinear([1, 0.5, 0.25], 0.35)).toEqual([0.35, 0.175, 0.0875]);
  });

  it("六种形状都有稳定的 SDF 序号", () => {
    expect(shapeIndex("circle")).toBe(0);
    expect(shapeIndex("double-ring")).toBe(1);
    expect(shapeIndex("round-square")).toBe(2);
    expect(shapeIndex("diamond")).toBe(3);
    expect(shapeIndex("hexagon")).toBe(4);
    expect(shapeIndex("dot")).toBe(5);
  });
});

describe("边的三组拆分", () => {
  const view = buildView({
    nodes: ["center", "a", "b", "c", "d"],
    // 规则：hop 1 或 weight ≥ 2 即 strong。center—a、a—b、a—c 都挨着 hop 1；
    // b—c 两端都是 hop 2、权重 1 → 唯一的 base；c—d 出现两次 → weight 2 → strong。
    edges: [
      ["center", "a"],
      ["a", "b"],
      ["a", "c"],
      ["b", "c"],
      ["c", "d"],
      ["c", "d"],
    ],
  });

  it("accent 只收 highlight.edges，strong 收结构边，其余进 base", () => {
    const accentId = graphEdgeId("center", "a", RELATION_FALLBACK);
    const accentIndex = view.edges.findIndex((item) => item.id === accentId);
    expect(accentIndex).toBeGreaterThanOrEqual(0);
    const split = splitEdges(view, highlightOf(["center", "a"], [accentId]));
    expect(split.accent).toEqual([accentIndex]);
    expect(split.base.length + split.strong.length).toBe(view.edges.length - 1);
    // 边的 hop 取两端较大值：只有 center—a 是 hop 1。c—d 合并后 weight 2 也是 strong。
    expect(split.base.length).toBe(3);
    expect(split.strong.length).toBe(1);
  });

  it("组内保持 view.edges 顺序（几何逐字节稳定的前提）", () => {
    const split = splitEdges(view, EMPTY_GRAPH_HIGHLIGHT);
    for (const group of [split.base, split.strong, split.accent]) {
      expect([...group]).toEqual([...group].sort((a, b) => a - b));
    }
    expect(split.accent).toEqual([]);
  });

  it("无高亮时所有边都归 base/strong，不产生空组以外的变化", () => {
    const split = splitEdges(view, EMPTY_GRAPH_HIGHLIGHT);
    expect(split.base.length + split.strong.length).toBe(view.edges.length);
  });
});

describe("锚点推断（props 里没有 selectedId）", () => {
  const view = buildView({
    nodes: ["hub", "a", "b", "c"],
    edges: [
      ["hub", "a"],
      ["hub", "b"],
      ["hub", "c"],
    ],
  });

  it("所有关联边都被点亮的节点就是锚点", () => {
    const highlight = highlightOf(["hub", "a"], view.edges.map((item) => item.id));
    expect(inferAnchorNode(view, highlight)).toBe("hub");
  });

  it("只有一个亮点时直接用它", () => {
    expect(inferAnchorNode(view, highlightOf(["b"], []))).toBe("b");
  });

  it("没有高亮时返回 null", () => {
    expect(inferAnchorNode(view, EMPTY_GRAPH_HIGHLIGHT)).toBeNull();
  });

  it("退化（没有边被点亮）时取高亮集合里度数最高的", () => {
    expect(inferAnchorNode(view, highlightOf(["a", "hub"], []))).toBe("hub");
  });
});

describe("标签预算与优先级", () => {
  const nodes = ["hub", "a", "b", "c", "d", "e"];
  const view = buildView({
    nodes,
    edges: [
      ["hub", "a"],
      ["hub", "b"],
      ["hub", "c"],
      ["a", "b"],
    ],
  });
  const path = ["c", "hub", "a"];

  it("选中与路径排在最前，且不重复（星核就是选中项时只出现一次）", () => {
    const candidates = labelCandidates(view, highlightOf(["hub", "a"], [], path), "low", "hub");
    expect(candidates.slice(0, 3)).toEqual(["hub", "c", "a"]);
    expect(new Set(candidates).size).toBe(candidates.length);
  });

  it("数量受档位上限约束：12 / 24 / 40", () => {
    const many = Array.from({ length: 60 }, (_, index) => `n${String(index).padStart(2, "0")}`);
    const wide = buildView({
      nodes: ["hub", ...many],
      edges: many.map((id) => ["hub", id] as const),
    });
    expect(labelCandidates(wide, EMPTY_GRAPH_HIGHLIGHT, "low", null).length).toBe(12);
    expect(labelCandidates(wide, EMPTY_GRAPH_HIGHLIGHT, "balanced", null).length).toBe(24);
    expect(labelCandidates(wide, EMPTY_GRAPH_HIGHLIGHT, "high", null).length).toBe(40);
  });

  it("中心优先，其余按度数降序、id 升序", () => {
    const candidates = labelCandidates(view, EMPTY_GRAPH_HIGHLIGHT, "balanced", null);
    expect(candidates[0]).toBe("hub");
    const rest = candidates.slice(1);
    expect(rest.slice(0, 3)).toEqual(["a", "b", "c"]);
  });
});

describe("屏幕空间标签避让", () => {
  const viewport = { width: 400, height: 300 };

  const label = (
    id: string,
    x: number,
    y: number,
    width = 60,
    height = 16,
    forced = false,
  ): ProjectedLabel => ({ id, x, y, width, height, forced });

  it("高优先级先占位，后到者错位或让位，绝不相叠", () => {
    const placed = layoutLabels(
      [label("a", 10, 10), label("b", 30, 18), label("c", 200, 200)],
      viewport,
    );
    const ids = placed.map((item) => item.id);
    expect(ids).toContain("a");
    expect(ids).toContain("c");
    for (let i = 0; i < placed.length; i += 1) {
      for (let j = i + 1; j < placed.length; j += 1) {
        const one = placed[i];
        const two = placed[j];
        const overlapX =
          Math.min(one.x + one.width, two.x + two.width) - Math.max(one.x, two.x);
        const overlapY =
          Math.min(one.y + one.height, two.y + two.height) - Math.max(one.y, two.y);
        expect(overlapX <= 0 || overlapY <= 0).toBe(true);
      }
    }
  });

  it("forced 即使重叠也保留，并被夹回视口", () => {
    const placed = layoutLabels(
      [label("a", 10, 10), label("selected", -80, 400, 60, 16, true)],
      viewport,
    );
    const selected = placed.find((item) => item.id === "selected");
    expect(selected).toBeDefined();
    expect(selected!.x).toBeGreaterThanOrEqual(0);
    expect(selected!.y).toBeLessThanOrEqual(viewport.height - selected!.height);
  });

  it("forced 标签撞上已占位标签时换偏移，而不是压上去", () => {
    const placed = layoutLabels(
      [label("taken", 100, 100), label("selected", 100, 100, 60, 16, true)],
      viewport,
    );
    expect(placed.map((item) => item.id)).toContain("selected");
    const taken = placed.find((item) => item.id === "taken")!;
    const selected = placed.find((item) => item.id === "selected")!;
    const overlapX =
      Math.min(selected.x + selected.width, taken.x + taken.width) -
      Math.max(selected.x, taken.x);
    const overlapY =
      Math.min(selected.y + selected.height, taken.y + taken.height) -
      Math.max(selected.y, taken.y);
    expect(overlapX <= 0 || overlapY <= 0).toBe(true);
  });

  it("普通标签只做小位移内移，移不进视口才丢弃（不出现半截文字）", () => {
    // x=380 / width=60 只差 40px，超过半宽位移上限 → 丢；y=-50 只允许下移一行 → 仍出界 → 丢。
    const placed = layoutLabels([label("edge", 380, 10), label("top", 10, -50)], viewport);
    expect(placed).toEqual([]);
    // x=-30 的框向内挪半宽（33px）就能完整露出一行字。
    expect(layoutLabels([label("left", -30, 10)], viewport).map((item) => item.id)).toEqual([
      "left",
    ]);
  });

  it("maxCount 是硬上限", () => {
    const placed = layoutLabels(
      [label("a", 0, 0), label("b", 0, 40), label("c", 0, 80)],
      viewport,
      { maxCount: 2 },
    );
    expect(placed).toHaveLength(2);
  });
});

describe("布局缓存键与 Worker 阈值", () => {
  const view = buildView({
    nodes: ["a", "b", "c"],
    edges: [
      ["a", "b"],
      ["b", "c"],
    ],
    center: "a",
    depth: 2,
  });

  it("同一 id 集合换顺序不影响键（稳定哈希）", () => {
    const shuffled: GraphViewModel = { ...view, nodes: [...view.nodes].reverse() };
    expect(layoutSeedKey(shuffled)).toBe(layoutSeedKey(view));
  });

  it("中心或深度变化会换键；选中不进键", () => {
    const other = buildView({
      nodes: ["a", "b", "c"],
      edges: [
        ["a", "b"],
        ["b", "c"],
      ],
      center: "b",
      depth: 2,
    });
    expect(layoutSeedKey(other)).not.toBe(layoutSeedKey(view));
    const deeper = buildView({
      nodes: ["a", "b", "c"],
      edges: [
        ["a", "b"],
        ["b", "c"],
      ],
      center: "a",
      depth: 3,
    });
    expect(layoutSeedKey(deeper)).not.toBe(layoutSeedKey(view));
  });

  it("键里带算法版本号（格式 hash|center|depth|version）", () => {
    expect(layoutSeedKey(view).split("|")).toHaveLength(4);
  });

  it("≤300 主线程、>300 才起 Worker", () => {
    expect(shouldUseWorker(0)).toBe(false);
    expect(shouldUseWorker(300)).toBe(false);
    expect(shouldUseWorker(301)).toBe(true);
    expect(shouldUseWorker(Number.NaN)).toBe(false);
  });
});

describe("重排 anchors", () => {
  it("只把仍然存在的节点坐标传给下一次布局", () => {
    const first = buildView({
      nodes: ["a", "b", "c"],
      edges: [
        ["a", "b"],
        ["b", "c"],
      ],
      center: "a",
      depth: 2,
    });
    const result = layoutGalaxy3d(first, { seedKey: "first", maxTicks: 4 });
    const next = buildView({
      nodes: ["a", "b"],
      edges: [["a", "b"]],
      center: "a",
      depth: 2,
    });
    const anchors = anchorsFromResult(result, next);
    expect(Object.keys(anchors).sort()).toEqual(["a", "b"]);
    const index = result.indexById.get("b")!;
    expect(anchors.b).toEqual([
      result.positions[index * 3],
      result.positions[index * 3 + 1],
      result.positions[index * 3 + 2],
    ]);
  });
});

describe("视觉半径与星场", () => {
  it("星核抬到 5.4 再乘视觉系数，选中 ×1.15", () => {
    expect(visualRadius(2.5, false, false)).toBeCloseTo(2.5 * NODE_SIZE_SCALE, 6);
    expect(visualRadius(2.5, true, false)).toBeCloseTo(CORE_WORLD_RADIUS * NODE_SIZE_SCALE, 6);
    expect(visualRadius(4.4, true, false)).toBeCloseTo(CORE_WORLD_RADIUS * NODE_SIZE_SCALE, 6);
    expect(visualRadius(2.5, false, true)).toBeCloseTo(2.5 * NODE_SIZE_SCALE * SELECTED_SCALE, 6);
  });

  it("同 seed 的星场逐字节相同、不同 seed 不同", () => {
    const a = createStarfieldPositions(64, 1234);
    const b = createStarfieldPositions(64, 1234);
    const c = createStarfieldPositions(64, 4321);
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(Array.from(a)).not.toEqual(Array.from(c));
  });

  it("星场落在 1400×900×600 盒子里", () => {
    const positions = createStarfieldPositions(200);
    for (let index = 0; index < positions.length; index += 3) {
      expect(Math.abs(positions[index])).toBeLessThanOrEqual(700);
      expect(Math.abs(positions[index + 1])).toBeLessThanOrEqual(450);
      expect(Math.abs(positions[index + 2])).toBeLessThanOrEqual(300);
    }
  });
});

describe("标签图集打包", () => {
  it("按行排布，坐标确定", () => {
    const rects = packLabelAtlas(
      [
        { id: "a", width: 40, height: 10 },
        { id: "b", width: 40, height: 10 },
      ],
      { width: 100, height: 50, padding: 2 },
    );
    expect(rects).toEqual([
      { id: "a", x: 2, y: 2, width: 40, height: 10 },
      { id: "b", x: 44, y: 2, width: 40, height: 10 },
    ]);
  });

  it("放不下返回 null（调用方据此缩字号/减标签）", () => {
    expect(
      packLabelAtlas(
        [
          { id: "a", width: 90, height: 30 },
          { id: "b", width: 90, height: 30 },
        ],
        { width: 100, height: 40 },
      ),
    ).toBeNull();
    expect(packLabelAtlas([{ id: "wide", width: 200, height: 10 }], { width: 100, height: 40 })).toBeNull();
    expect(packLabelAtlas([{ id: "zero", width: 0, height: 10 }], { width: 100, height: 40 })).toBeNull();
  });
});

describe("边 id 与高亮集合一致性", () => {
  it("highlight.edges 用的就是 graphEdgeId 的键", () => {
    const view = buildView({
      nodes: ["a", "b"],
      edges: [["a", "b"]],
    });
    expect(view.edges[0].id).toBe(graphEdgeId("a", "b", RELATION_FALLBACK));
    expect(splitEdges(view, highlightOf(["a", "b"], [view.edges[0].id])).accent).toEqual([0]);
  });
});

describe("palette 结构", () => {
  it("调色板覆盖 6 个节点 token（组件按 colorToken 取值不会缺键）", () => {
    expect(Object.keys(PALETTE.nodes)).toHaveLength(6);
    expect(parseCssColor("#050408")![3]).toBe(1);
  });
});
