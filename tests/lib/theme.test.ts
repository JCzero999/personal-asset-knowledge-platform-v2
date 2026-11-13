import { describe, expect, it } from "vitest";

import {
  DEFAULT_THEME,
  LEGACY_THEME_STORAGE_KEY,
  THEMES,
  THEME_BOOTSTRAP,
  THEME_META,
  THEME_STORAGE_KEY,
  isThemeId,
  normalizeTheme,
  readStoredTheme,
  resolveStoredTheme,
  themeMeta,
} from "@/lib/theme";

describe("主题枚举", () => {
  it("四套主题齐全且顺序稳定", () => {
    expect(THEMES).toEqual(["galaxy", "pine", "sand", "midnight"]);
  });

  it("默认主题是深空银河", () => {
    expect(DEFAULT_THEME).toBe("galaxy");
    expect(THEMES).toContain(DEFAULT_THEME);
  });

  it("isThemeId 只认枚举内的字符串", () => {
    for (const id of THEMES) expect(isThemeId(id)).toBe(true);
    for (const value of ["", "Pine", "dark", null, undefined, 0, {}]) {
      expect(isThemeId(value)).toBe(false);
    }
  });

  it("normalizeTheme 把非法值回落到默认主题", () => {
    for (const id of THEMES) expect(normalizeTheme(id)).toBe(id);
    expect(normalizeTheme(null)).toBe(DEFAULT_THEME);
    expect(normalizeTheme("light")).toBe(DEFAULT_THEME);
    expect(normalizeTheme(42)).toBe(DEFAULT_THEME);
  });
});

describe("主题持久化", () => {
  it("存储键固定为 pakp.theme", () => {
    expect(THEME_STORAGE_KEY).toBe("pakp.theme");
  });

  it("读出已保存的主题", () => {
    const storage = { getItem: (key: string) => (key === THEME_STORAGE_KEY ? "sand" : null) };
    expect(readStoredTheme(storage)).toBe("sand");
  });

  it("没有存储、空值、非法值都回落默认主题", () => {
    expect(readStoredTheme(null)).toBe(DEFAULT_THEME);
    expect(readStoredTheme(undefined)).toBe(DEFAULT_THEME);
    expect(readStoredTheme({ getItem: () => null })).toBe(DEFAULT_THEME);
    expect(readStoredTheme({ getItem: () => "" })).toBe(DEFAULT_THEME);
    expect(readStoredTheme({ getItem: () => "sepia" })).toBe(DEFAULT_THEME);
  });

  it("存储抛错（隐私模式）不冒泡", () => {
    const storage = {
      getItem: () => {
        throw new Error("SecurityError");
      },
    };
    expect(() => readStoredTheme(storage)).not.toThrow();
    expect(readStoredTheme(storage)).toBe(DEFAULT_THEME);
  });
});

describe("主题元数据", () => {
  it("每套主题都有名称和说明，色点不再由 TS 提供", () => {
    expect(THEME_META).toHaveLength(THEMES.length);
    expect(THEME_META.map((item) => item.id)).toEqual([...THEMES]);

    for (const item of THEME_META) {
      expect(item.name.length).toBeGreaterThan(0);
      expect(item.hint.length).toBeGreaterThan(0);
      expect(item).not.toHaveProperty("swatch");
    }
  });

  it("themeMeta 按 id 取，找不到时兜底第一条", () => {
    expect(themeMeta("midnight").name).toBe("午夜蓝");
    // 运行期不该出现，但兜底不能返回 undefined。
    expect(themeMeta("unknown" as never)).toBe(THEME_META[0]);
  });
});

/** 用 Map 模拟 localStorage，并记录首帧脚本应用的主题。 */
function runBootstrap(initial: Record<string, string>) {
  const store = new Map(Object.entries(initial));
  const storage = {
    getItem: (key: string) => (store.has(key) ? (store.get(key) as string) : null),
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  };
  let applied = "";
  const document = {
    documentElement: {
      setAttribute: (_name: string, value: string) => {
        applied = value;
      },
    },
  };

  new Function("localStorage", "document", THEME_BOOTSTRAP)(storage, document);
  return { applied, store };
}

describe("旧主题键迁移（theme → pakp.theme）", () => {
  it("只有旧键：采用旧键，回写新键并删除旧键", () => {
    const { applied, store } = runBootstrap({ theme: "pine" });
    expect(applied).toBe("pine");
    expect(store.get(THEME_STORAGE_KEY)).toBe("pine");
    expect(store.has(LEGACY_THEME_STORAGE_KEY)).toBe(false);
  });

  it("只有新键：直接用新键，不写旧键", () => {
    const { applied, store } = runBootstrap({ [THEME_STORAGE_KEY]: "sand" });
    expect(applied).toBe("sand");
    expect(store.get(THEME_STORAGE_KEY)).toBe("sand");
    expect(store.has(LEGACY_THEME_STORAGE_KEY)).toBe(false);
  });

  it("两个键都有：以新键为准，旧键被清掉", () => {
    const { applied, store } = runBootstrap({
      [THEME_STORAGE_KEY]: "midnight",
      [LEGACY_THEME_STORAGE_KEY]: "pine",
    });
    expect(applied).toBe("midnight");
    expect(store.get(THEME_STORAGE_KEY)).toBe("midnight");
    expect(store.has(LEGACY_THEME_STORAGE_KEY)).toBe(false);
  });

  it("两个键都没有：回落默认主题", () => {
    const { applied } = runBootstrap({});
    expect(applied).toBe(DEFAULT_THEME);
  });

  it("新键非法时仍以新键为准，不偷偷回退旧键", () => {
    const { applied, store } = runBootstrap({
      [THEME_STORAGE_KEY]: "sepia",
      [LEGACY_THEME_STORAGE_KEY]: "pine",
    });
    expect(applied).toBe(DEFAULT_THEME);
    expect(store.has(LEGACY_THEME_STORAGE_KEY)).toBe(false);
  });

  it("旧键值非法时回落默认主题", () => {
    const { applied } = runBootstrap({ [LEGACY_THEME_STORAGE_KEY]: "sepia" });
    expect(applied).toBe(DEFAULT_THEME);
  });

  it("resolveStoredTheme 与脚本口径一致", () => {
    const storageOf = (entries: Record<string, string>) => ({
      getItem: (key: string) => (key in entries ? entries[key] : null),
    });

    expect(resolveStoredTheme(storageOf({ theme: "pine" }))).toEqual({
      theme: "pine",
      migratedFrom: "pine",
    });
    expect(resolveStoredTheme(storageOf({ [THEME_STORAGE_KEY]: "sand" }))).toEqual({
      theme: "sand",
      migratedFrom: null,
    });
    expect(
      resolveStoredTheme(storageOf({ [THEME_STORAGE_KEY]: "midnight", theme: "pine" })),
    ).toEqual({ theme: "midnight", migratedFrom: null });
    expect(resolveStoredTheme(storageOf({}))).toEqual({
      theme: DEFAULT_THEME,
      migratedFrom: null,
    });
  });

  it("内联脚本与运行时共用同一份键名和白名单", () => {
    expect(THEME_BOOTSTRAP).toContain(THEME_STORAGE_KEY);
    expect(THEME_BOOTSTRAP).toContain(LEGACY_THEME_STORAGE_KEY);
    for (const id of THEMES) expect(THEME_BOOTSTRAP).toContain(id);
  });
});
