import { describe, expect, it } from "vitest";

import { pickInitialLabel, sortLabels } from "@/lib/graph-labels";

describe("sortLabels", () => {
  it("含文字或数字的实体排在纯符号前", () => {
    const sorted = sortLabels(["#", "品牌蓝", "#2B6CB0", "—"]);
    expect(sorted.slice(0, 2)).toEqual(["#2B6CB0", "品牌蓝"]);
    expect(new Set(sorted.slice(2))).toEqual(new Set(["#", "—"]));
  });

  it("同组内保持字典序，且不修改入参", () => {
    const input = ["设计评审复盘", "前端设计团队"];
    expect(sortLabels(input)).toEqual(["前端设计团队", "设计评审复盘"]);
    expect(input).toEqual(["设计评审复盘", "前端设计团队"]);
  });

  it("空数组返回空数组", () => {
    expect(sortLabels([])).toEqual([]);
  });
});

describe("pickInitialLabel", () => {
  it("跳过纯符号实体", () => {
    expect(pickInitialLabel(["#", "品牌蓝"])).toBe("品牌蓝");
  });

  it("没有标签时返回 null", () => {
    expect(pickInitialLabel([])).toBeNull();
  });
});
