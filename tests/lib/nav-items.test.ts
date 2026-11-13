import { describe, expect, it } from "vitest";

import { NAV_ITEMS, navItemsFor } from "@/lib/nav-items";

describe("navItemsFor", () => {
  it("普通账号只看到三项，管理员项被过滤", () => {
    const items = navItemsFor(false);
    expect(items.map((item) => item.key)).toEqual(["workspace", "search", "graph"]);
    expect(items.some((item) => item.key === "admin")).toBe(false);
  });

  it("管理员多出「系统」，其余顺序不变", () => {
    const items = navItemsFor(true);
    expect(items.map((item) => item.key)).toEqual(["workspace", "search", "graph", "admin"]);
    expect(items).toHaveLength(NAV_ITEMS.length);
  });

  it("导航项是同一个只读源，抽屉与图标栏不会各写一份", () => {
    expect(navItemsFor(true)[0]).toBe(NAV_ITEMS[0]);
    expect(navItemsFor(true)[0].href).toBe("/workspace");
    expect(navItemsFor(true).at(-1)?.href).toBe("/admin");
  });
});
