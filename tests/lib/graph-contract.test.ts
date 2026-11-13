import { describe, expect, it } from "vitest";

import { ValidationError } from "@/domain/errors";
import { buildGraphViewModel } from "@/lib/graph-model";
import type { LightragEdge, LightragNode } from "@/server/adapters/lightrag/client";
import {
  GRAPH_MAX_NODES_DEFAULT,
  GRAPH_MAX_NODES_MAX,
  GRAPH_MAX_NODES_MIN,
  resolveGraphMaxNodes,
  type GraphStatus,
} from "@/server/services/graph-service";

/**
 * 数据契约（ADR-022 附录 A5）：`maxNodes` 的解析与边界、截断只做单向推断、
 * status 失败时状态条的降级。全部是纯函数，不读真实接口。
 */

function node(id: string): LightragNode {
  return { id, type: "", description: "", filePath: "pakp:obj:obj1:abc" };
}

function edge(source: string, target: string): LightragEdge {
  return { source, target, description: "", filePath: "pakp:obj:obj1:abc" };
}

function viewOf(nodes: LightragNode[], edges: LightragEdge[], maxNodes: number, status: GraphStatus | null = null) {
  return buildGraphViewModel({
    subgraph: { nodes, edges },
    status,
    center: nodes[0]?.id ?? "",
    depth: 3,
    maxNodes,
  });
}

describe("resolveGraphMaxNodes：边界", () => {
  it("缺省 150（不传 / null）", () => {
    expect(resolveGraphMaxNodes(undefined)).toBe(GRAPH_MAX_NODES_DEFAULT);
    expect(resolveGraphMaxNodes(null)).toBe(GRAPH_MAX_NODES_DEFAULT);
    expect(GRAPH_MAX_NODES_DEFAULT).toBe(150);
  });

  it("边界值 50 / 600 通过", () => {
    expect(GRAPH_MAX_NODES_MIN).toBe(50);
    expect(GRAPH_MAX_NODES_MAX).toBe(600);
    expect(resolveGraphMaxNodes(50)).toBe(50);
    expect(resolveGraphMaxNodes(600)).toBe(600);
    expect(resolveGraphMaxNodes("50")).toBe(50);
    expect(resolveGraphMaxNodes("600")).toBe(600);
    expect(resolveGraphMaxNodes(" 150 ")).toBe(150);
  });

  it("越界 49 / 601 抛 ValidationError，field 是 maxNodes", () => {
    for (const value of [49, 601, "49", "601", 0, -1, 100000]) {
      expect(() => resolveGraphMaxNodes(value)).toThrow(ValidationError);
      try {
        resolveGraphMaxNodes(value);
      } catch (error) {
        expect((error as ValidationError).details).toEqual({ field: "maxNodes" });
        expect((error as ValidationError).code).toBe("VALIDATION_FAILED");
      }
    }
  });

  it("非整数与空串一律拒绝", () => {
    for (const value of ["abc", "2.5", "", "   ", Number.NaN, 2.5, Number.POSITIVE_INFINITY]) {
      expect(() => resolveGraphMaxNodes(value)).toThrow(ValidationError);
    }
  });
});

describe("截断推断：received >= requestMaxNodes（单向）", () => {
  it("收到的节点数等于请求值 → 视为已截断", () => {
    const view = viewOf([node("a"), node("b"), node("c")], [edge("a", "b")], 3);
    expect(view.meta.requestMaxNodes).toBe(3);
    expect(view.meta.truncated).toBe(true);
    expect(view.meta.truncatedSource).toBe("inferred");
  });

  it("超过请求值同样视为截断", () => {
    const view = viewOf([node("a"), node("b"), node("c"), node("d")], [], 3);
    expect(view.meta.truncated).toBe(true);
  });

  it("少于请求值 → 推断为未截断", () => {
    const view = viewOf([node("a"), node("b")], [edge("a", "b")], 3);
    expect(view.meta.truncated).toBe(false);
  });

  it("反证：nodes.length < maxNodes 不代表未截断", () => {
    // ADR-011 先按 maxNodes 截断、再按账号过滤，再加上同 id 去重，
    // 所以「返回得少」完全可能已经被截断。收到 3 条、去重后只剩 2 条，仍是 truncated。
    const view = viewOf([node("a"), node("b"), node("a")], [edge("a", "b")], 3);
    expect(view.meta.total).toBe(2);
    expect(view.meta.total).toBeLessThan(view.meta.requestMaxNodes);
    expect(view.meta.truncated).toBe(true);
  });
});

describe("status 降级与 failed 状态条模型", () => {
  it("status 为 null：skipped，不阻塞构图", () => {
    const view = viewOf([node("a")], [], 150, null);
    expect(view.meta.sources.status).toBe("skipped");
    expect(view.meta.failed).toEqual([]);
    expect(view.meta.total).toBe(1);
  });

  it("status 请求失败：sources.status = error，failed 仍为空", () => {
    const view = buildGraphViewModel({
      subgraph: { nodes: [node("a")], edges: [] },
      status: null,
      statusFailed: true,
      center: "a",
      depth: 2,
      maxNodes: 150,
    });
    expect(view.meta.sources).toEqual({ graph: "ok", status: "error" });
    expect(view.meta.failed).toEqual([]);
  });

  it("0 条失败：空数组", () => {
    const view = viewOf([node("a")], [], 150, {
      total: 1,
      byStatus: { processed: 1 },
      counts: { processed: 1, extracting: 0, queued: 0, failed: 0, unknown: 0 },
      objects: [],
      failed: [],
    });
    expect(view.meta.sources.status).toBe("ok");
    expect(view.meta.failed).toHaveLength(0);
  });

  it("1 条 / 多条失败：objectId 与错误原文原样保留", () => {
    const failed = [
      { objectId: "obj-11111111", error: "LightRAG: extraction failed: Expecting ',' delimiter" },
      { objectId: "obj-22222222", error: "timeout" },
      { objectId: "obj-33333333", error: "No graph data found" },
    ];
    const view = viewOf([node("a")], [], 150, {
      total: 3,
      byStatus: { failed: 3 },
      counts: { processed: 0, extracting: 0, queued: 0, failed: 3, unknown: 0 },
      objects: [],
      failed,
    });

    expect(view.meta.failed).toHaveLength(3);
    expect(view.meta.failed.map((item) => item.objectId)).toEqual(failed.map((item) => item.objectId));
    expect(view.meta.failed[0].error).toBe(failed[0].error);
    // 只读拷贝：改模型不回写状态接口的结果。
    expect(view.meta.failed).not.toBe(failed);
  });
});
