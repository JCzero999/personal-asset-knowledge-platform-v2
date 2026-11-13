import { describe, expect, it } from "vitest";

import { buildGraphViewModel, graphEdgeId, type GraphViewModel } from "@/lib/graph-model";
import { findShortestPath, selectGraphHighlight, EMPTY_GRAPH_HIGHLIGHT } from "@/lib/graph-selectors";
import type { LightragEdge, LightragNode } from "@/server/adapters/lightrag/client";

/**
 * 选中 / 邻域 / 路径是 2D、3D、列表唯一的真值来源（ADR-022 附录 A4）。
 * 这里守住：1 跳邻域（2 跳不算）、`dimmed` 与 `dimmedEdges` 的补集、
 * 路径的四种边界，以及「选中不进模型」。
 */

function node(id: string): LightragNode {
  return { id, type: "", description: "", filePath: "pakp:obj:obj1:abc" };
}

function edge(source: string, target: string, description = ""): LightragEdge {
  return { source, target, description, filePath: "pakp:obj:obj1:abc" };
}

function build(nodes: string[], edges: Array<[string, string, string?]>, center = nodes[0]): GraphViewModel {
  return buildGraphViewModel({
    subgraph: {
      nodes: nodes.map(node),
      edges: edges.map(([source, target, description]) =>
        edge(source, target, description ?? ""),
      ),
    },
    status: null,
    center,
    depth: 3,
    maxNodes: 600,
  });
}

/** hub — a — c — d，hub — b，另有一个孤立点 iso。 */
function chain(): GraphViewModel {
  return build(
    ["hub", "a", "b", "c", "d", "iso"],
    [
      ["hub", "a"],
      ["hub", "b"],
      ["a", "c"],
      ["c", "d"],
    ],
  );
}

const emptySelection = {
  focusId: null,
  selectedId: null,
  hoverId: null,
  pathTo: null,
} as const;

describe("selectGraphHighlight：无选中", () => {
  it("空选中集合 → 全空，不压暗", () => {
    const highlight = selectGraphHighlight(chain(), emptySelection);
    expect(highlight.nodes.size).toBe(0);
    expect(highlight.edges.size).toBe(0);
    expect(highlight.dimmed.size).toBe(0);
    expect(highlight.dimmedEdges.size).toBe(0);
    expect(highlight.path).toBeNull();
    expect(highlight).toEqual(EMPTY_GRAPH_HIGHLIGHT);
  });

  it("选中的 id 不在模型里当作没选中", () => {
    const highlight = selectGraphHighlight(chain(), { ...emptySelection, selectedId: "不存在" });
    expect(highlight.nodes.size).toBe(0);
  });
});

describe("selectGraphHighlight：邻域", () => {
  it("选中心：点亮 1 跳邻居与挂在它上面的边，2 跳不点亮", () => {
    const view = chain();
    const highlight = selectGraphHighlight(view, { ...emptySelection, selectedId: "hub" });

    expect([...highlight.nodes].sort()).toEqual(["a", "b", "hub"]);
    expect(highlight.nodes.has("c")).toBe(false);
    expect([...highlight.edges].sort()).toEqual(
      [graphEdgeId("hub", "a", "相关"), graphEdgeId("hub", "b", "相关")].sort(),
    );
    expect([...highlight.dimmed].sort()).toEqual(["c", "d", "iso"]);
    expect(highlight.dimmedEdges.has(graphEdgeId("a", "c", "相关"))).toBe(true);
    expect(highlight.dimmedEdges.has(graphEdgeId("c", "d", "相关"))).toBe(true);
    expect(highlight.dimmedEdges.size).toBe(2);
  });

  it("孤立点：只点亮自己，所有边都压暗", () => {
    const view = chain();
    const highlight = selectGraphHighlight(view, { ...emptySelection, selectedId: "iso" });

    expect([...highlight.nodes]).toEqual(["iso"]);
    expect(highlight.edges.size).toBe(0);
    expect(highlight.dimmed.size).toBe(5);
    expect(highlight.dimmedEdges.size).toBe(view.edges.length);
  });

  it("没有选中时 hover 顶替锚点；有选中则选中优先", () => {
    const view = chain();
    const hovered = selectGraphHighlight(view, { ...emptySelection, hoverId: "a" });
    expect([...hovered.nodes].sort()).toEqual(["a", "c", "hub"]);

    const both = selectGraphHighlight(view, {
      ...emptySelection,
      selectedId: "b",
      hoverId: "a",
    });
    expect([...both.nodes].sort()).toEqual(["b", "hub"]);
  });
});

describe("selectGraphHighlight：dimmedEdges 是补集，只在这里算一次", () => {
  it("平行边（weight > 1）与悬空边各一例", () => {
    const view = build(
      ["x", "y", "z"],
      [
        ["x", "y", "同事"],
        ["y", "x", "同事"], // 平行边，合并成一条 weight = 2
        ["x", "z", "合作"],
        ["y", "幽灵", "悬空"], // 端点不在集合里，被 build 丢弃
      ],
    );

    expect(view.meta.dropped.danglingEdges).toBe(1);
    expect(view.edges).toHaveLength(2);

    const highlight = selectGraphHighlight(view, { ...emptySelection, selectedId: "y" });
    expect(highlight.edges.has(graphEdgeId("x", "y", "同事"))).toBe(true);
    expect(highlight.dimmedEdges.has(graphEdgeId("x", "z", "合作"))).toBe(true);
    expect(highlight.dimmedEdges.size).toBe(view.edges.length - highlight.edges.size);
    for (const id of highlight.dimmedEdges) expect(highlight.edges.has(id)).toBe(false);
  });
});

describe("findShortestPath", () => {
  it("命中：返回含两端的节点序列", () => {
    const view = chain();
    expect(findShortestPath(view, "hub", "d")).toEqual(["hub", "a", "c", "d"]);
    expect(findShortestPath(view, "d", "hub")).toEqual(["d", "c", "a", "hub"]);
    expect(findShortestPath(view, "hub", "b")).toEqual(["hub", "b"]);
    expect(findShortestPath(view, "c", "d")).toEqual(["c", "d"]);
  });

  it("自反：返回单元素数组", () => {
    expect(findShortestPath(chain(), "hub", "hub")).toEqual(["hub"]);
  });

  it("端点不存在 → null", () => {
    expect(findShortestPath(chain(), "hub", "不存在")).toBeNull();
    expect(findShortestPath(chain(), "不存在", "hub")).toBeNull();
  });

  it("无路径（碎图）→ null", () => {
    expect(findShortestPath(chain(), "hub", "iso")).toBeNull();
    expect(findShortestPath(chain(), "iso", "d")).toBeNull();
  });
});

describe("selectGraphHighlight：路径", () => {
  it("只有 URL 取景中心时，点亮路径本身", () => {
    const view = chain();
    const highlight = selectGraphHighlight(view, {
      ...emptySelection,
      focusId: "hub",
      pathTo: "d",
    });

    expect(highlight.path).toEqual(["hub", "a", "c", "d"]);
    expect([...highlight.nodes].sort()).toEqual(["a", "c", "d", "hub"]);
    expect(highlight.nodes.has("b")).toBe(false);
    expect(highlight.dimmed.has("b")).toBe(true);
    expect([...highlight.dimmedEdges].sort()).toEqual([graphEdgeId("hub", "b", "相关")]);
  });

  it("选中 + 路径：邻域与路径取并集", () => {
    const view = chain();
    const highlight = selectGraphHighlight(view, {
      ...emptySelection,
      selectedId: "hub",
      pathTo: "d",
    });

    expect(highlight.path).toEqual(["hub", "a", "c", "d"]);
    expect([...highlight.nodes].sort()).toEqual(["a", "b", "c", "d", "hub"]);
    expect(highlight.edges.size).toBe(view.edges.length);
    expect(highlight.dimmedEdges.size).toBe(0);
  });

  it("路径端点不存在时不出路径，其余照常", () => {
    const view = chain();
    const highlight = selectGraphHighlight(view, {
      ...emptySelection,
      selectedId: "hub",
      pathTo: "不存在",
    });
    expect(highlight.path).toBeNull();
    expect([...highlight.nodes].sort()).toEqual(["a", "b", "hub"]);
  });
});

describe("选中不进模型", () => {
  it("调用前后 view 的字段与顺序不变，两次结果相等", () => {
    const view = chain();
    const before = JSON.stringify(view.nodes);

    const first = selectGraphHighlight(view, { ...emptySelection, selectedId: "hub" });
    const second = selectGraphHighlight(view, { ...emptySelection, selectedId: "hub" });

    expect(JSON.stringify(view.nodes)).toBe(before);
    expect(Object.keys(view.meta)).not.toContain("selectedId");
    expect(JSON.stringify(view)).not.toContain("selectedId");
    expect([...first.nodes].sort()).toEqual([...second.nodes].sort());
  });
});
