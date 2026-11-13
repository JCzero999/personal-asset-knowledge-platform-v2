import { describe, expect, it } from "vitest";

import { buildGraphViewModel } from "@/lib/graph-model";
import type { LightragEdge, LightragNode } from "@/server/adapters/lightrag/client";
import {
  decimate,
  MAX_3D_LAYOUT_NODES,
  resolveGraphDpr,
  selectGraphMode,
  TIER_BUDGETS,
  type GraphQualityInput,
} from "@/lib/graph-quality";

/**
 * 画质档位与视图降级（ADR-022 第 8 / 10 条、附录 A7）。
 * 组件不许自己写这些 `if`，所以这里要覆盖全组合：webgl × reduced-motion × 规模 × URL。
 */

function input(overrides: Partial<GraphQualityInput> = {}): GraphQualityInput {
  return {
    webgl: true,
    reducedMotion: false,
    nodeCount: 150,
    urlMode: null,
    hardwareConcurrency: 8,
    isMobile: false,
    softwareRenderer: false,
    previousTier: null,
    ...overrides,
  };
}

describe("selectGraphMode：默认视图", () => {
  it("桌面、有 WebGL、不减少动效 → 3d", () => {
    const decision = selectGraphMode(input());
    expect(decision.mode).toBe("3d");
    expect(decision.reason).toBe("auto-3d");
    expect(decision.canUse3d).toBe(true);
  });

  it("无 WebGL → 2d，3D 入口隐藏", () => {
    const decision = selectGraphMode(input({ webgl: false }));
    expect(decision.mode).toBe("2d");
    expect(decision.reason).toBe("no-webgl");
    expect(decision.canUse3d).toBe(false);
  });

  it("prefers-reduced-motion → 2d，3D 入口隐藏", () => {
    const decision = selectGraphMode(input({ reducedMotion: true }));
    expect(decision.mode).toBe("2d");
    expect(decision.reason).toBe("reduced-motion");
    expect(decision.canUse3d).toBe(false);
  });

  it("移动端 → 2d，3D 入口隐藏", () => {
    const decision = selectGraphMode(input({ isMobile: true }));
    expect(decision.mode).toBe("2d");
    expect(decision.reason).toBe("mobile");
    expect(decision.canUse3d).toBe(false);
  });

  it("超过 3D 布局上限（>2000）→ 2d", () => {
    expect(selectGraphMode(input({ nodeCount: MAX_3D_LAYOUT_NODES })).mode).toBe("3d");
    const decision = selectGraphMode(input({ nodeCount: MAX_3D_LAYOUT_NODES + 1 }));
    expect(decision.mode).toBe("2d");
    expect(decision.reason).toBe("too-many-nodes");
    expect(MAX_3D_LAYOUT_NODES).toBe(2000);
  });
});

describe("selectGraphMode：URL 显式覆盖", () => {
  it("?mode=2d 在没有 WebGL 时也照样是 2d", () => {
    const decision = selectGraphMode(input({ urlMode: "2d", webgl: false }));
    expect(decision.mode).toBe("2d");
    expect(decision.reason).toBe("url-2d");
  });

  it("?mode=list 直接进列表", () => {
    const decision = selectGraphMode(input({ urlMode: "list" }));
    expect(decision.mode).toBe("list");
    expect(decision.reason).toBe("url-list");
  });

  it("?mode=3d 覆盖软降级（reduced-motion / 移动端）", () => {
    const reduced = selectGraphMode(input({ urlMode: "3d", reducedMotion: true }));
    expect(reduced.mode).toBe("3d");
    expect(reduced.reason).toBe("url-3d");
    expect(reduced.canUse3d).toBe(false);

    const mobile = selectGraphMode(input({ urlMode: "3d", isMobile: true }));
    expect(mobile.mode).toBe("3d");
    expect(mobile.canUse3d).toBe(false);
  });

  it("?mode=3d 不能覆盖「没有 WebGL」", () => {
    const decision = selectGraphMode(input({ urlMode: "3d", webgl: false }));
    expect(decision.mode).toBe("2d");
    expect(decision.reason).toBe("no-webgl");
  });
});

describe("档位选择", () => {
  it("桌面 8 核及以上 → high", () => {
    expect(selectGraphMode(input({ hardwareConcurrency: 8 })).tier).toBe("high");
    expect(selectGraphMode(input({ hardwareConcurrency: 16 })).tier).toBe("high");
  });

  it("性能信息缺失或中等 → balanced", () => {
    expect(selectGraphMode(input({ hardwareConcurrency: null })).tier).toBe("balanced");
    expect(selectGraphMode(input({ hardwareConcurrency: 6 })).tier).toBe("balanced");
  });

  it("4 核及以下 / 移动 / 软件渲染 → low", () => {
    expect(selectGraphMode(input({ hardwareConcurrency: 4 })).tier).toBe("low");
    expect(selectGraphMode(input({ hardwareConcurrency: 2 })).tier).toBe("low");
    expect(selectGraphMode(input({ isMobile: true, hardwareConcurrency: 8 })).tier).toBe("low");
    expect(selectGraphMode(input({ softwareRenderer: true })).tier).toBe("low");
  });

  it("reduced-motion 下不给 high", () => {
    expect(selectGraphMode(input({ reducedMotion: true, hardwareConcurrency: 16 })).tier).toBe(
      "balanced",
    );
  });

  it("只降不升：previousTier 更低就保留更低的", () => {
    expect(selectGraphMode(input({ hardwareConcurrency: 16, previousTier: "low" })).tier).toBe("low");
    expect(selectGraphMode(input({ hardwareConcurrency: 16, previousTier: "balanced" })).tier).toBe(
      "balanced",
    );
    expect(selectGraphMode(input({ hardwareConcurrency: 4, previousTier: "high" })).tier).toBe("low");
    expect(selectGraphMode(input({ hardwareConcurrency: 6, previousTier: "high" })).tier).toBe(
      "balanced",
    );
  });

  it("各档预算与 ADR 第 8 条一致", () => {
    expect(TIER_BUDGETS.high).toEqual({ maxNodes: 600, maxEdges: 1200, maxLabels: 40, maxDpr: 2 });
    expect(TIER_BUDGETS.balanced).toEqual({
      maxNodes: 300,
      maxEdges: 600,
      maxLabels: 24,
      maxDpr: 1.5,
    });
    expect(TIER_BUDGETS.low).toEqual({ maxNodes: 150, maxEdges: 300, maxLabels: 12, maxDpr: 1 });
  });

  it("超出档位节点预算时标记 overBudget（渲染前先抽稀）", () => {
    expect(selectGraphMode(input({ nodeCount: 300, hardwareConcurrency: 6 })).overBudget).toBe(false);
    expect(selectGraphMode(input({ nodeCount: 301, hardwareConcurrency: 6 })).overBudget).toBe(true);
    expect(selectGraphMode(input({ nodeCount: 600, hardwareConcurrency: 16 })).overBudget).toBe(
      false,
    );
    expect(selectGraphMode(input({ nodeCount: 601, hardwareConcurrency: 16 })).overBudget).toBe(true);
  });
});

describe("resolveGraphDpr：DPR 上限", () => {
  it("按档夹到上限", () => {
    expect(resolveGraphDpr("high", 3)).toBe(2);
    expect(resolveGraphDpr("balanced", 2)).toBe(1.5);
    expect(resolveGraphDpr("low", 1.5)).toBe(1);
    expect(resolveGraphDpr("high", 1)).toBe(1);
  });

  it("设备值非法时按 1 处理", () => {
    expect(resolveGraphDpr("high", Number.NaN)).toBe(1);
    expect(resolveGraphDpr("high", 0)).toBe(1);
    expect(resolveGraphDpr("high", -2)).toBe(1);
  });
});

describe("decimate：抽稀", () => {
  function node(id: string): LightragNode {
    return { id, type: "", description: "", filePath: "pakp:obj:obj1:abc" };
  }
  function edge(source: string, target: string): LightragEdge {
    return { source, target, description: "", filePath: "pakp:obj:obj1:abc" };
  }

  function fixture() {
    const nodes = ["hub", "a", "b", "c", "d", "e", "f"].map(node);
    const edges = [
      edge("hub", "a"),
      edge("hub", "b"),
      edge("a", "c"),
      edge("a", "d"),
      edge("b", "c"),
      edge("b", "e"),
      edge("a", "f"),
    ];
    return buildGraphViewModel({
      subgraph: { nodes, edges },
      status: null,
      center: "hub",
      depth: 3,
      maxNodes: 600,
    });
  }

  it("预算足够时原样返回，不标记截断", () => {
    const view = fixture();
    const result = decimate(view, { budget: 7 });
    expect(result.nodes).toHaveLength(7);
    expect(result.edges).toHaveLength(view.edges.length);
    expect(result.hiddenCount).toBe(0);
    expect(result.truncated).toBe(false);
  });

  it("保留中心与全部 1 跳，剩余名额给度数高的 2 跳节点", () => {
    const view = fixture();
    const result = decimate(view, { budget: 4 });

    expect(result.nodes.map((item) => item.id)).toEqual(["hub", "a", "b", "c"]);
    expect(result.hiddenCount).toBe(3);
    expect(result.truncated).toBe(true);
    // 边只保留两端都在的：a-d / b-e / a-f 被抽掉。
    expect(result.edges.map((item) => item.id)).toHaveLength(4);
    expect(result.edges.every((item) => result.nodes.some((n) => n.id === item.source))).toBe(true);
  });

  it("保留集合确定、可复现，且保持模型顺序", () => {
    const first = decimate(fixture(), { budget: 4 });
    const second = decimate(fixture(), { budget: 4 });
    expect(first.nodes.map((item) => item.id)).toEqual(second.nodes.map((item) => item.id));
    const order = fixture().nodes.map((item) => item.id);
    const picked = first.nodes.map((item) => item.id);
    expect(picked).toEqual(order.filter((id) => picked.includes(id)));
  });

  it("keepIds 里的节点无条件保留（即使超出预算）", () => {
    const result = decimate(fixture(), { budget: 3, keepIds: new Set(["e"]) });
    expect(result.nodes.map((item) => item.id)).toEqual(["hub", "a", "b", "e"]);
  });

  it("不改动入参 view", () => {
    const view = fixture();
    const before = view.nodes.map((item) => item.id);
    decimate(view, { budget: 2 });
    expect(view.nodes.map((item) => item.id)).toEqual(before);
  });
});
