import { describe, expect, it } from "vitest";

import { layoutRadial, visibleEdges } from "@/lib/graph-layout";

/**
 * 图谱布局是纯几何计算：这里守住三件事——
 * 中心节点稳定在画布中央、邻居按确定顺序均匀分布、画布外的边不会画出来。
 */

describe("layoutRadial", () => {
  it("空图返回空数组", () => {
    expect(layoutRadial([])).toEqual([]);
  });

  it("把指定实体放在画布中心", () => {
    const nodes = layoutRadial(
      [{ id: "甲" }, { id: "乙" }, { id: "丙" }],
      { width: 600, height: 400, centerId: "乙" },
    );

    const center = nodes.find((node) => node.center);
    expect(center?.id).toBe("乙");
    expect(center?.x).toBe(300);
    expect(center?.y).toBe(200);
    expect(center?.radius).toBeGreaterThan(14);
  });

  it("centerId 不在节点里时退回第一个（按 id 排序）", () => {
    const nodes = layoutRadial([{ id: "b" }, { id: "a" }], { centerId: "z" });
    expect(nodes.find((node) => node.center)?.id).toBe("a");
  });

  it("邻居均匀分布且不重叠于中心", () => {
    const nodes = layoutRadial([{ id: "中心" }, { id: "n1" }, { id: "n2" }, { id: "n3" }], {
      width: 640,
      height: 420,
      centerId: "中心",
    });

    const ring = nodes.filter((node) => !node.center);
    expect(ring).toHaveLength(3);

    const distances = ring.map((node) =>
      Math.hypot(node.x - 320, node.y - 210).toFixed(1),
    );
    expect(new Set(distances).size).toBe(1);
  });

  it("输出顺序可复现：同一份数据两次布局结果相同", () => {
    const input = [{ id: "乙" }, { id: "甲" }, { id: "丙" }];
    expect(layoutRadial(input, { centerId: "甲" })).toEqual(
      layoutRadial([...input].reverse(), { centerId: "甲" }),
    );
  });
});

describe("visibleEdges", () => {
  it("丢弃一端不在节点集合里的边", () => {
    const nodes = layoutRadial([{ id: "a" }, { id: "b" }], { centerId: "a" });
    const edges = visibleEdges(
      [
        { source: "a", target: "b" },
        { source: "a", target: "外部" },
      ],
      nodes,
    );
    expect(edges).toEqual([{ source: "a", target: "b" }]);
  });
});
