/**
 * 工作台主题枚举与持久化（设计稿 §3.5）。
 *
 * 主题只影响工作台、检索、图谱、后台与登录等页面；首页银河固定深空，
 * 由 `[data-surface="cosmic"]` 单独持有暖金 token，不读这里的值。
 *
 * 纯函数放这里，组件与首帧内联脚本都引用同一份常量，避免键名漂移。
 * 色点颜色不在这里：只由 CSS 的 `.theme-option-dot--*` 从主题块取（ADR-021 第 9 条）。
 */

export const THEMES = ["galaxy", "pine", "sand", "midnight"] as const;

export type ThemeId = (typeof THEMES)[number];

/** 无脚本或非法值时的兜底主题：与 `:root` 的 token 一致。 */
export const DEFAULT_THEME: ThemeId = "galaxy";

export const THEME_STORAGE_KEY = "pakp.theme";

/**
 * ADR-017 文本里登记的旧键名。核查结论：v1 从未发布过写这个键的代码
 * （39 个提交里 `localStorage` 只出现在本轮新增的 theme.ts / layout.tsx），
 * 所以线上不存在需要迁移的数据；这里保留读取 + 回写 + 删除，
 * 只为按 ADR-021 第 10 条的读取顺序兜住任何早期本地会话。
 */
export const LEGACY_THEME_STORAGE_KEY = "theme";

export interface ThemeMeta {
  readonly id: ThemeId;
  readonly name: string;
  /** 一句话说明，屏幕阅读器与菜单副标题使用。 */
  readonly hint: string;
}

export const THEME_META: readonly ThemeMeta[] = [
  { id: "galaxy", name: "深空银河", hint: "默认，暖金深空" },
  { id: "pine", name: "松林绿", hint: "浅色纸感" },
  { id: "sand", name: "暖沙", hint: "米色暖光" },
  { id: "midnight", name: "午夜蓝", hint: "深蓝夜色" },
];

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === "string" && (THEMES as readonly string[]).includes(value);
}

/** 任何读到的值先归一化：非法值回落到默认主题。 */
export function normalizeTheme(value: unknown): ThemeId {
  return isThemeId(value) ? value : DEFAULT_THEME;
}

/** 只读写 `getItem`，方便在 node 测试里注入假 storage。 */
export function readStoredTheme(storage: Pick<Storage, "getItem"> | null | undefined): ThemeId {
  if (!storage) return DEFAULT_THEME;
  try {
    return normalizeTheme(storage.getItem(THEME_STORAGE_KEY));
  } catch {
    return DEFAULT_THEME;
  }
}

export interface StoredThemePreference {
  /** 最终生效的主题。 */
  readonly theme: ThemeId;
  /** 存在旧键、且以旧键为准时返回它，调用方负责回写新键并删除旧键。 */
  readonly migratedFrom: string | null;
}

/**
 * 读取顺序（ADR-021 第 10 条）：`pakp.theme` → 旧键 `theme` → 默认主题。
 * 两个键同时存在时以新键为准（即使新键非法，也不回退旧键）。
 */
export function resolveStoredTheme(
  storage: Pick<Storage, "getItem"> | null | undefined,
): StoredThemePreference {
  if (!storage) return { theme: DEFAULT_THEME, migratedFrom: null };
  try {
    const current = storage.getItem(THEME_STORAGE_KEY);
    if (current !== null) return { theme: normalizeTheme(current), migratedFrom: null };

    const legacy = storage.getItem(LEGACY_THEME_STORAGE_KEY);
    if (isThemeId(legacy)) return { theme: legacy, migratedFrom: legacy };
  } catch {
    // 隐私模式或存储被禁用：按默认主题渲染。
  }
  return { theme: DEFAULT_THEME, migratedFrom: null };
}

export function themeMeta(id: ThemeId): ThemeMeta {
  return THEME_META.find((item) => item.id === id) ?? THEME_META[0];
}

/** 把主题写到 `<html data-theme>` 并持久化；存储不可用时只影响本次会话。 */
export function applyTheme(id: ThemeId): void {
  const theme = normalizeTheme(id);
  document.documentElement.setAttribute("data-theme", theme);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // 隐私模式或存储被禁用：主题仍然立即生效，只是不跨刷新保留。
  }
}

/**
 * 首帧防闪脚本（设计稿 §3.5 / ADR-021 第 10 条）。
 *
 * 在 CSS 生效前同步执行：读 `pakp.theme` → 旧键 `theme` → 默认主题，
 * 命中旧键时回写新键并删除旧键；任何异常都回落到默认主题。
 * 白名单直接取 `THEMES` 与 `DEFAULT_THEME`，与运行时共用一份常量。
 */
export const THEME_BOOTSTRAP = `(function(){var K=${JSON.stringify(
  THEME_STORAGE_KEY,
)},L=${JSON.stringify(LEGACY_THEME_STORAGE_KEY)},OK=${JSON.stringify(
  THEMES,
)},D=${JSON.stringify(DEFAULT_THEME)};try{var s=localStorage,t=null;try{t=s.getItem(K);}catch(e){}if(t===null){try{var l=s.getItem(L);if(OK.indexOf(l)>=0){t=l;try{s.setItem(K,l);s.removeItem(L);}catch(e){}}}catch(e){}}else{try{if(s.getItem(L)!==null)s.removeItem(L);}catch(e){}}document.documentElement.setAttribute("data-theme",OK.indexOf(t)>=0?t:D);}catch(e){document.documentElement.setAttribute("data-theme",D);}})();`;
