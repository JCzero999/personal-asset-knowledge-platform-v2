import { describe, expect, it } from "vitest";

import {
  activeFilterChips,
  buildWorkspaceHref,
  hasActiveFilters,
  parseWorkspaceFilters,
  toListObjectsQuery,
  type WorkspaceFilters,
} from "@/lib/workspace-filters";

const filters: WorkspaceFilters = {
  q: "",
  type: null,
  library: null,
  status: null,
  tag: null,
  added: null,
  sort: "updated",
  archived: "active",
};

describe("parseWorkspaceFilters", () => {
  it("空参数得到默认视图", () => {
    const parsed = parseWorkspaceFilters({});
    expect(parsed).toEqual(filters);
    expect(hasActiveFilters(parsed)).toBe(false);
  });

  it("解析全部合法参数并去掉关键字首尾空格", () => {
    const parsed = parseWorkspaceFilters({
      q: "  设计  ",
      type: "work",
      library: "external",
      status: "published",
      sort: "title",
      archived: "only",
    });

    expect(parsed).toEqual({
      q: "设计",
      type: "work",
      library: "external",
      status: "published",
      tag: null,
      added: null,
      sort: "title",
      archived: "only",
    });
    expect(hasActiveFilters(parsed)).toBe(true);
  });

  it("非法值退回默认而不是抛错", () => {
    const parsed = parseWorkspaceFilters({
      type: "video",
      library: "cloud",
      status: "pending",
      sort: "size",
      archived: "yes",
    });

    expect(parsed).toEqual(filters);
  });

  it("类型为资产时丢弃状态，避免必然为空的组合", () => {
    const parsed = parseWorkspaceFilters({ type: "asset", status: "finished" });
    expect(parsed.type).toBe("asset");
    expect(parsed.status).toBeNull();
  });

  it("类型为全部或作品时保留状态", () => {
    expect(parseWorkspaceFilters({ status: "draft" }).status).toBe("draft");
    expect(parseWorkspaceFilters({ type: "work", status: "draft" }).status).toBe("draft");
  });

  it("标签参数去空格，空值视为未筛选", () => {
    expect(parseWorkspaceFilters({ tag: "  工具类 " }).tag).toBe("工具类");
    expect(parseWorkspaceFilters({ tag: "   " }).tag).toBeNull();
    expect(hasActiveFilters(parseWorkspaceFilters({ tag: "工具类" }))).toBe(true);
  });

  it("新增时间窗只接受 1d / 7d / 30d，其余退回不限", () => {
    expect(parseWorkspaceFilters({ added: "7d" }).added).toBe("7d");
    expect(parseWorkspaceFilters({ added: "30d" }).added).toBe("30d");
    expect(parseWorkspaceFilters({ added: "90d" }).added).toBeNull();
    expect(parseWorkspaceFilters({ added: "week" }).added).toBeNull();
    expect(parseWorkspaceFilters({}).added).toBeNull();
    expect(hasActiveFilters(parseWorkspaceFilters({ added: "7d" }))).toBe(true);
  });

  it("重复参数取第一个", () => {
    expect(parseWorkspaceFilters({ type: ["work", "asset"] }).type).toBe("work");
  });
});

describe("buildWorkspaceHref", () => {
  it("默认条件不写进 URL", () => {
    expect(buildWorkspaceHref(filters)).toBe("/workspace");
    expect(buildWorkspaceHref(filters, { sort: "updated", archived: "active" })).toBe(
      "/workspace",
    );
  });

  it("按工具条顺序拼接非默认条件", () => {
    expect(
      buildWorkspaceHref(filters, {
        q: "笔记",
        type: "work",
        library: "internal",
        status: "draft",
        sort: "created",
        archived: "only",
      }),
    ).toBe(
      "/workspace?q=%E7%AC%94%E8%AE%B0&type=work&library=internal&status=draft&sort=created&archived=only",
    );
  });

  it("切到资产时同时清掉状态参数", () => {
    const withStatus: WorkspaceFilters = { ...filters, status: "published" };
    expect(buildWorkspaceHref(withStatus, { type: "asset" })).toBe("/workspace?type=asset");
  });

  it("标签写进 URL，清空时不留参数", () => {
    expect(buildWorkspaceHref(filters, { tag: "工具类" })).toBe(
      "/workspace?tag=%E5%B7%A5%E5%85%B7%E7%B1%BB",
    );
    expect(buildWorkspaceHref({ ...filters, tag: "工具类" }, { tag: null })).toBe("/workspace");
  });

  it("切换归档范围保留其它筛选", () => {
    const current: WorkspaceFilters = { ...filters, q: "复盘", type: "work" };
    expect(buildWorkspaceHref(current, { archived: "only" })).toBe(
      "/workspace?q=%E5%A4%8D%E7%9B%98&type=work&archived=only",
    );
  });

  it("新增时间窗写进 URL，摘掉后不留参数", () => {
    expect(buildWorkspaceHref(filters, { added: "7d" })).toBe("/workspace?added=7d");
    expect(buildWorkspaceHref({ ...filters, added: "7d" }, { added: null })).toBe("/workspace");
    expect(
      buildWorkspaceHref(filters, { added: "7d", type: "asset", library: "external" }),
    ).toBe("/workspace?type=asset&library=external&added=7d");
  });

  it("解析后再生成的地址可以往返一致", () => {
    const href = buildWorkspaceHref(filters, {
      q: "asset",
      type: "asset",
      library: "external",
      sort: "title",
    });
    const search = new URLSearchParams(href.split("?")[1]);
    expect(parseWorkspaceFilters(Object.fromEntries(search.entries()))).toEqual({
      q: "asset",
      type: "asset",
      library: "external",
      status: null,
      tag: null,
      added: null,
      sort: "title",
      archived: "active",
    });
  });
});

describe("toListObjectsQuery", () => {
  it("默认只按更新时间排序并带 limit", () => {
    expect(toListObjectsQuery(filters, 100)).toEqual({ sort: "updated", limit: 100 });
  });

  it("标签沿用到仓储查询条件", () => {
    expect(toListObjectsQuery({ ...filters, tag: "工具类" }, 20)).toEqual({
      tag: "工具类",
      sort: "updated",
      limit: 20,
    });
  });

  it("关键字映射为 search，归档视图映射为 archivedOnly", () => {
    const query = toListObjectsQuery(
      { ...filters, q: "大纲", type: "work", status: "finished", archived: "only" },
      50,
    );

    expect(query).toEqual({
      search: "大纲",
      type: "work",
      status: "finished",
      sort: "updated",
      archivedOnly: true,
      limit: 50,
    });
  });

  it("新增时间窗换算成 createdSince（按注入的 now 计算）", () => {
    const now = new Date("2026-11-14T04:00:00.000Z");
    expect(toListObjectsQuery({ ...filters, added: "7d" }, 100, now).createdSince).toBe(
      "2026-11-07T04:00:00.000Z",
    );
    expect(toListObjectsQuery({ ...filters, added: "1d" }, 100, now).createdSince).toBe(
      "2026-11-13T04:00:00.000Z",
    );
    expect(toListObjectsQuery({ ...filters, added: "30d" }, 100, now).createdSince).toBe(
      "2026-10-15T04:00:00.000Z",
    );
    expect(toListObjectsQuery(filters, 100, now)).not.toHaveProperty("createdSince");
  });
});

describe("activeFilterChips", () => {
  it("按工具条顺序给出中文条件", () => {
    expect(
      activeFilterChips({
        q: "设计",
        type: "work",
        library: "external",
        status: "published",
        tag: "工具类",
        added: "7d",
        sort: "title",
        archived: "only",
      }),
    ).toEqual([
      { key: "q", label: "关键字「设计」" },
      { key: "type", label: "作品" },
      { key: "library", label: "外库" },
      { key: "status", label: "已发布" },
      { key: "tag", label: "标签「工具类」" },
      { key: "added", label: "近 7 天" },
      { key: "archived", label: "已归档" },
      { key: "sort", label: "按标题排序" },
    ]);
  });

  it("默认视图没有条件", () => {
    expect(activeFilterChips(filters)).toEqual([]);
  });
});
