import { describe, expect, it } from "vitest";

import type { LightragEdge, LightragNode } from "@/server/adapters/lightrag/client";
import type { GraphStatus } from "@/server/services/graph-service";
import {
  buildGraphViewModel,
  deriveRelationLabel,
  ENTITY_RULES,
  ENTITY_STYLE,
  graphEdgeId,
  mapEntityType,
  sizeForDegree,
} from "@/lib/graph-model";

/**
 * 视图模型是 2D / 3D / 列表唯一的真值来源（ADR-022 附录 A2）。
 * 这里逐条守住 A6 表里属于本文件的项：类型映射、短标签、度数、排序、去重、
 * 自环 / 悬空边的计数、meta 组合、以及「纯函数不碰入参」。
 */

function node(id: string, type = "", description = ""): LightragNode {
  return { id, type, description, filePath: "pakp:obj:obj1:abc" };
}

function edge(source: string, target: string, description = ""): LightragEdge {
  return { source, target, description, filePath: "pakp:obj:obj1:abc" };
}

function build(
  nodes: LightragNode[],
  edges: LightragEdge[] = [],
  options: {
    center?: string;
    depth?: 1 | 2 | 3;
    maxNodes?: number;
    status?: GraphStatus | null;
    statusFailed?: boolean;
  } = {},
) {
  return buildGraphViewModel({
    subgraph: { nodes, edges },
    status: options.status ?? null,
    ...(options.statusFailed === undefined ? {} : { statusFailed: options.statusFailed }),
    center: options.center ?? nodes[0]?.id ?? "",
    depth: options.depth ?? 3,
    maxNodes: options.maxNodes ?? 150,
  });
}

describe("mapEntityType：六类映射", () => {
  it("六类各命中一个典型值", () => {
    expect(mapEntityType("Person")).toBe("person");
    expect(mapEntityType("Organisation")).toBe("org");
    expect(mapEntityType("Work")).toBe("work");
    expect(mapEntityType("Method")).toBe("method");
    expect(mapEntityType("Concept")).toBe("concept");
    expect(mapEntityType("Event")).toBe("other");
  });

  it("中文类型名同样命中", () => {
    expect(mapEntityType("人物")).toBe("person");
    expect(mapEntityType("组织")).toBe("org");
    expect(mapEntityType("机构")).toBe("org");
    expect(mapEntityType("公司")).toBe("org");
    expect(mapEntityType("作品")).toBe("work");
    expect(mapEntityType("资产")).toBe("work");
    expect(mapEntityType("方法")).toBe("method");
    expect(mapEntityType("流程")).toBe("method");
    expect(mapEntityType("步骤")).toBe("method");
    expect(mapEntityType("技术")).toBe("method");
    expect(mapEntityType("概念")).toBe("concept");
    expect(mapEntityType("理论")).toBe("concept");
    expect(mapEntityType("主题")).toBe("concept");
  });

  it("大小写不敏感", () => {
    expect(mapEntityType("CONCEPT")).toBe("concept");
    expect(mapEntityType("pErSoN")).toBe("person");
    expect(mapEntityType("ASSET")).toBe("work");
  });

  it("空 entity_type、纯空白与未知类型都落 other", () => {
    expect(mapEntityType("")).toBe("other");
    expect(mapEntityType("   ")).toBe("other");
    expect(mapEntityType("Geo")).toBe("other");
    expect(mapEntityType("unknown-type")).toBe("other");
  });

  it("带空格与全角字母先归一（NFKC + trim）再匹配", () => {
    expect(mapEntityType("  PERSON  ")).toBe("person");
    expect(mapEntityType("Ｃｏｎｃｅｐｔ")).toBe("concept");
    expect(mapEntityType("　人物　")).toBe("person");
  });

  it("规则表顺序敏感：先命中先赢", () => {
    // 「作品内容」同时含 work 与 content，两者都归 work，不会落到 other。
    expect(mapEntityType("作品内容")).toBe("work");
    expect(ENTITY_RULES[0].type).toBe("person");
  });
});

describe("ENTITY_STYLE", () => {
  it("六类各有形状 + 颜色 token，且颜色互不重复", () => {
    const types = Object.keys(ENTITY_STYLE);
    expect(types.sort()).toEqual(["concept", "method", "org", "other", "person", "work"]);
    const tokens = new Set(types.map((type) => ENTITY_STYLE[type as keyof typeof ENTITY_STYLE].colorToken));
    expect(tokens.size).toBe(6);
    expect(ENTITY_STYLE.concept.shape).toBe("circle");
    expect(ENTITY_STYLE.other.shape).toBe("dot");
  });
});

describe("shortLabel：按码点截断", () => {
  it("中心 12 字、其余 10 字，超出加「…」", () => {
    const long = "一二三四五六七八九十甲乙丙丁";
    const view = build([node(long), node("邻居"), node("路人")], [edge(long, "邻居"), edge(long, "路人")], {
      center: long,
    });

    expect(view.nodes.find((item) => item.flags.isCenter)?.shortLabel).toBe("一二三四五六七八九十甲乙…");
    expect(view.nodes.find((item) => item.id === "路人")?.shortLabel).toBe("路人");
    expect(view.nodes.find((item) => item.id === "路人")?.label).toBe("路人");
  });

  it("非中心节点的 10 字边界与英文一样按码点算", () => {
    const eleven = "abcdefghijk";
    const view = build([node("中心"), node(eleven)], [edge("中心", eleven)], { center: "中心" });
    expect(view.nodes.find((item) => item.id === eleven)?.shortLabel).toBe("abcdefghij…");
  });

  it("长度正好等于上限时不加省略号，纯 emoji 不劈开代理对", () => {
    const tenChinese = "一二三四五六七八九十";
    const emojis = "🌕".repeat(13);
    const view = build([node("中心"), node(tenChinese), node(emojis)], [edge("中心", tenChinese)], {
      center: "中心",
    });
    expect(view.nodes.find((item) => item.id === tenChinese)?.shortLabel).toBe(tenChinese);
    const emojiLabel = view.nodes.find((item) => item.id === emojis)?.shortLabel ?? "";
    expect(Array.from(emojiLabel)).toHaveLength(11);
    expect(emojiLabel.endsWith("…")).toBe(true);
  });
});

describe("deriveRelationLabel：关系名派生", () => {
  it("<SEP> 段取第一个词", () => {
    expect(deriveRelationLabel("ALICE<SEP>ALICE 与 BOB 是同事")).toBe("ALICE");
    expect(deriveRelationLabel("合作，共同<SEP>他们一起做过三个项目")).toBe("合作，共同");
  });

  it("没有 <SEP> 时取首行前 12 个字符", () => {
    expect(deriveRelationLabel("Alice and Bob worked together at Acme")).toBe("Alice and Bo");
    expect(deriveRelationLabel("同事\n第二行还有说明")).toBe("同事");
  });

  it("去掉首尾引号", () => {
    expect(deriveRelationLabel('"同事"<SEP>说明')).toBe("同事");
    expect(deriveRelationLabel("“合作”")).toBe("合作");
  });

  it("空描述与只有空白落「相关」", () => {
    expect(deriveRelationLabel("")).toBe("相关");
    expect(deriveRelationLabel("   ")).toBe("相关");
    expect(deriveRelationLabel("<SEP>")).toBe("相关");
  });
});

describe("buildGraphViewModel：边与度数", () => {
  it("平行边合并成一条，weight 是条数不是强度", () => {
    const view = build(
      [node("甲"), node("乙")],
      [edge("甲", "乙", "同事"), edge("乙", "甲", "同事"), edge("甲", "乙", "同事")],
    );

    expect(view.edges).toHaveLength(1);
    expect(view.edges[0].weight).toBe(3);
    expect(view.edges[0].direction).toBe("none");
    expect(view.edges[0].type).toBe("同事");
    expect(view.edges[0].strong).toBe(true);
    expect(view.edges[0].colorToken).toBe("--graph-edge-strong");
  });

  it("边 id 用 U+0001 连接排序后的端点对与关系名", () => {
    const view = build([node("甲"), node("乙")], [edge("乙", "甲", "同事")]);
    expect(view.edges[0].id).toBe(graphEdgeId("甲", "乙", "同事"));
    // 端点顺序不影响键：正反两个方向的同一关系是同一个 id。
    expect(graphEdgeId("甲", "乙", "同事")).toBe(graphEdgeId("乙", "甲", "同事"));
    expect(view.edges[0].id.split("\u0001")).toHaveLength(3);
    expect(view.edges[0].id).not.toContain("|");
  });

  it("自环与悬空边只计数不抛错，度数不算它们", () => {
    const view = build(
      [node("甲"), node("乙"), node("丙"), node("孤儿")],
      [edge("甲", "乙", "同事"), edge("甲", "甲", "自指"), edge("甲", "不存在", "悬空"), edge("乙", "丙", "合作")],
    );

    expect(view.meta.dropped).toEqual({ selfLoops: 1, danglingEdges: 1, nameless: 0 });
    expect(view.meta.total).toBe(4);
    const degree = new Map(view.nodes.map((item) => [item.id, item.degree]));
    expect(degree.get("甲")).toBe(1);
    expect(degree.get("乙")).toBe(2);
    expect(degree.get("丙")).toBe(1);
    expect(degree.get("孤儿")).toBe(0);
    expect(view.nodes.find((item) => item.id === "孤儿")?.flags.isOrphan).toBe(true);
    expect(view.nodes.find((item) => item.id === "乙")?.flags.isOrphan).toBe(false);
  });

  it("trim 后为空的节点计入 nameless", () => {
    const view = build([node("甲"), node("   "), node("")]);
    expect(view.meta.dropped.nameless).toBe(2);
    expect(view.meta.total).toBe(1);
  });

  it("同 id 只保留输入里的第一个", () => {
    const view = build([node("甲", ""), node("甲", "Person", "后来的")]);
    expect(view.meta.total).toBe(1);
    expect(view.nodes[0].rawType).toBe("");
    expect(view.nodes[0].type).toBe("other");
  });

  it("hasDescription 反映描述是否为空", () => {
    const view = build([node("甲", "Concept", "有说明"), node("乙")], [edge("甲", "乙")]);
    expect(view.nodes.find((item) => item.id === "甲")?.flags.hasDescription).toBe(true);
    expect(view.nodes.find((item) => item.id === "乙")?.flags.hasDescription).toBe(false);
  });
});

describe("size：三档边界（0–1 / 2–4 / 5–9 / 10+）", () => {
  it("直接对分档函数取边界", () => {
    expect(sizeForDegree(0)).toBe("s");
    expect(sizeForDegree(1)).toBe("s");
    expect(sizeForDegree(2)).toBe("m");
    expect(sizeForDegree(4)).toBe("m");
    expect(sizeForDegree(5)).toBe("l");
    expect(sizeForDegree(9)).toBe("l");
    expect(sizeForDegree(10)).toBe("xl");
    expect(sizeForDegree(42)).toBe("xl");
  });

  it("模型里的中心节点按度数取档", () => {
    for (const [degree, expected] of [
      [1, "s"],
      [2, "m"],
      [5, "l"],
      [10, "xl"],
    ] as const) {
      const leaves = Array.from({ length: degree }, (_, index) => node(`叶${index}`));
      const view = build([node("心"), ...leaves], leaves.map((leaf) => edge("心", leaf.id)), {
        center: "心",
      });
      expect(view.nodes.find((item) => item.id === "心")?.size).toBe(expected);
    }
  });
});

describe("hop 与排序", () => {
  it("hop 从中心 BFS 得出，排序为 (hop↑, degree↓, id↑)", () => {
    const view = build(
      [node("hub"), node("a"), node("b"), node("c"), node("y"), node("z")],
      [edge("hub", "a"), edge("hub", "b"), edge("hub", "y"), edge("hub", "z"), edge("b", "c")],
      { center: "hub" },
    );

    expect(view.nodes.map((item) => item.id)).toEqual(["hub", "b", "a", "y", "z", "c"]);
    expect(view.nodes.map((item) => item.hop)).toEqual([0, 1, 1, 1, 1, 2]);
    expect(view.nodeIndex.get("c")).toBe(5);
    expect(view.nodeIndex.get("hub")).toBe(0);
  });

  it("depth 之外的节点记为 hop 3 + 不可达", () => {
    const view = build([node("hub"), node("a"), node("b")], [edge("hub", "a"), edge("a", "b")], {
      center: "hub",
      depth: 1,
    });
    const b = view.nodes.find((item) => item.id === "b");
    expect(b?.hop).toBe(3);
    expect(b?.flags.isUnreachable).toBe(true);
    expect(view.nodes.find((item) => item.id === "a")?.flags.isUnreachable).toBe(false);
  });

  it("碎图里从中心到不了的节点不报错，记 hop 3", () => {
    const view = build([node("hub"), node("孤岛1"), node("孤岛2")], [edge("孤岛1", "孤岛2")], {
      center: "hub",
    });
    expect(view.meta.total).toBe(3);
    expect(view.nodes.filter((item) => item.flags.isUnreachable).map((item) => item.id)).toEqual([
      "孤岛1",
      "孤岛2",
    ]);
  });

  it("中心不在返回集合里：0 个 isCenter，全部不可达，不抛错", () => {
    const view = build([node("甲"), node("乙")], [edge("甲", "乙")], { center: "不存在" });
    expect(view.nodes.every((item) => !item.flags.isCenter)).toBe(true);
    expect(view.nodes.every((item) => item.flags.isUnreachable)).toBe(true);
    expect(view.meta.center).toBe("不存在");
  });
});

describe("meta 组合", () => {
  it("status 为 null：sources.status = skipped，failed 为空", () => {
    const view = build([node("甲")]);
    expect(view.meta.sources).toEqual({ graph: "ok", status: "skipped" });
    expect(view.meta.failed).toEqual([]);
    expect(view.meta.lastSync).toBeNull();
  });

  it("status 请求失败（statusFailed）与「没请求」区分开", () => {
    const view = build([node("甲")], [], { statusFailed: true });
    expect(view.meta.sources.status).toBe("error");
    expect(view.meta.failed).toEqual([]);
  });

  it("status 正常时透传 failed 原文，total 与 requestMaxNodes 就位", () => {
    const status: GraphStatus = {
      total: 2,
      byStatus: { failed: 2 },
      objects: [],
      failed: [
        { objectId: "obj-aaaaaaaa", error: "LightRAG: extraction failed: bad JSON" },
        { objectId: "obj-bbbbbbbb", error: "timeout" },
      ],
    };
    const view = build([node("甲"), node("乙")], [edge("甲", "乙")], {
      status,
      maxNodes: 300,
    });

    expect(view.meta.sources).toEqual({ graph: "ok", status: "ok" });
    expect(view.meta.failed).toEqual(status.failed);
    expect(view.meta.failed[0].error).toBe("LightRAG: extraction failed: bad JSON");
    expect(view.meta.total).toBe(view.nodes.length);
    expect(view.meta.requestMaxNodes).toBe(300);
    expect(view.meta.truncatedSource).toBe("inferred");
    expect(view.meta.depth).toBe(3);
    expect(view.modelVersion).toBe(1);
  });
});

describe("纯函数", () => {
  it("不修改入参（冻结后调用不抛错，顺序与内容不变）", () => {
    const rawNodes = [node("甲", "Person", "说明"), node("乙")];
    const rawEdges = [edge("甲", "乙", "同事")];
    for (const item of rawNodes) Object.freeze(item);
    for (const item of rawEdges) Object.freeze(item);
    Object.freeze(rawNodes);
    Object.freeze(rawEdges);
    const subgraph: { nodes: LightragNode[]; edges: LightragEdge[] } = {
      nodes: rawNodes,
      edges: rawEdges,
    };
    Object.freeze(subgraph);

    const rawStatus: GraphStatus = { total: 0, byStatus: {}, objects: [], failed: [] };
    Object.freeze(rawStatus.failed);
    Object.freeze(rawStatus);

    expect(() =>
      buildGraphViewModel({
        subgraph,
        status: rawStatus,
        center: "甲",
        depth: 3,
        maxNodes: 150,
      }),
    ).not.toThrow();

    expect(rawNodes.map((item) => item.id)).toEqual(["甲", "乙"]);
    expect(rawEdges).toHaveLength(1);
    expect(rawNodes[0].type).toBe("Person");
  });

  it("同输入两次构建结果逐字段相等（nodeIndex 按 entries 比）", () => {
    const args = {
      nodes: [node("甲", "Person"), node("乙", "Concept"), node("丙", "组织")],
      edges: [edge("甲", "乙", "同事"), edge("乙", "丙", "隶属")],
    };
    const first = build(args.nodes, args.edges, { center: "甲" });
    const second = build(args.nodes, args.edges, { center: "甲" });

    expect(first).toEqual(second);
    expect([...first.nodeIndex.entries()]).toEqual([...second.nodeIndex.entries()]);
  });
});
