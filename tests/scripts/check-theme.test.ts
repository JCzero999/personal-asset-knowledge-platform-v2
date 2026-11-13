import { describe, expect, it } from "vitest";

import {
  ALLOWED_DUPLICATES,
  LITERAL_BASELINE,
  checkTheme,
  formatReport,
  parseRules,
  readThemeBlocks,
} from "../../scripts/check-theme.mjs";

type Failure = { code: string; theme?: string; token?: string; detail: string };
type Token = { name: string; value: string };

/**
 * 内联最小契约：四个主题块集合相等，登记表里的 2 组重复表达各出现一次。
 * 不读真实文件——脚本口径变了，这里先红。
 */
const NAMES: Record<string, string> = {
  "--bg": "#07060b",
  "--accent": "#e9c08a",
  "--accent-contrast": "#17110a",
  "--on-gold": "#17110a",
  "--surface": "#0e0c13",
  "--surface-1": "var(--surface)",
  "--white": "var(--surface)",
};

function block(selector: string, names: Record<string, string>) {
  const body = Object.entries(names)
    .map(([name, value]) => `  ${name}: ${value};`)
    .join("\n");
  return `${selector} {\n${body}\n}\n`;
}

function fixtures(overrides: Partial<Record<string, Record<string, string>>> = {}) {
  const base = { "--fs-11": "11px", "--sp-1": "4px", ...(overrides.base ?? {}) };
  const theme = (id: string) => ({ ...NAMES, ...(overrides[id] ?? {}) });
  return [
    block(":root", base),
    block(':root,\n[data-theme="galaxy"]', theme("galaxy")),
    block('[data-theme="pine"]', theme("pine")),
    block('[data-theme="sand"]', theme("sand")),
    block('[data-theme="midnight"]', theme("midnight")),
  ].join("\n");
}

const blocksOf = (css: string) =>
  readThemeBlocks(css) as { base: Token[]; themes: Record<string, Token[] | null> };

const failuresOf = (result: unknown, code: string) =>
  (result as { failures: Failure[] }).failures.filter((failure) => failure.code === code);

const codes = (result: unknown) =>
  (result as { failures: Failure[] }).failures.map((failure) => failure.code);

describe("check-theme 切块", () => {
  it("同时认 `:root {` 与 `:root, [data-theme=galaxy] {` 两种块头", () => {
    const { base, themes } = blocksOf(fixtures());
    expect(base.map((item) => item.name)).toEqual(["--fs-11", "--sp-1"]);
    for (const id of ["galaxy", "pine", "sand", "midnight"]) {
      expect(themes[id]).toHaveLength(Object.keys(NAMES).length);
    }
  });

  it("一行多个声明也能全部抓到", () => {
    const css = `:root {\n  --fs-11: 11px;\n}\n:root, [data-theme="galaxy"] {\n  --ok-bg: #e9f3ec; --ok-fg: #35704f;\n}\n[data-theme="pine"] { --ok-bg: #e9f3ec; --ok-fg: #35704f; }\n[data-theme="sand"] { --ok-bg: #e9f3ec; --ok-fg: #35704f; }\n[data-theme="midnight"] { --ok-bg: #e9f3ec; --ok-fg: #35704f; }`;
    const { themes } = blocksOf(css);
    expect((themes.galaxy ?? []).map((item) => item.name)).toEqual(["--ok-bg", "--ok-fg"]);
  });

  it("@media 内部规则按选择器展开", () => {
    const rules = parseRules("@media (max-width: 560px) { .a { color: red; } }");
    expect(rules).toHaveLength(1);
    expect(rules[0].selector).toBe(".a");
    expect(rules[0].at).toContain("@media");
  });
});

describe("check-theme E1–E8", () => {
  it("干净的契约全绿，并打印 2 组登记重复", () => {
    const result = checkTheme(fixtures(), { themeTsText: "export const x = 1;" });
    expect(result.failures).toEqual([]);
    expect(ALLOWED_DUPLICATES).toHaveLength(2);
    expect(formatReport(result)).toContain("0 失败");
  });

  it("E1 缺块", () => {
    const css = [
      block(":root", { "--fs-11": "11px" }),
      block(':root, [data-theme="galaxy"]', NAMES),
      block('[data-theme="pine"]', NAMES),
      block('[data-theme="sand"]', NAMES),
    ].join("\n");
    const failures = failuresOf(checkTheme(css, { themeTsText: "" }), "E1");
    expect(failures).toHaveLength(1);
    expect(failures[0].detail).toContain('data-theme="midnight"');
  });

  it("E2 集合不等（缺名与多名都报）", () => {
    const missing = { ...NAMES };
    delete missing["--bg"];
    const css = [
      block(":root", { "--fs-11": "11px" }),
      block(':root, [data-theme="galaxy"]', NAMES),
      block('[data-theme="pine"]', missing),
      block('[data-theme="sand"]', { ...NAMES, "--extra": "#000000" }),
      block('[data-theme="midnight"]', NAMES),
    ].join("\n");
    const failures = failuresOf(checkTheme(css, { themeTsText: "" }), "E2");
    expect(failures).toHaveLength(2);
    expect(failures[0].detail).toContain("--bg");
    expect(failures[1].detail).toContain("--extra");
  });

  it("E3 空值与 unset / initial / inherit", () => {
    const css = fixtures({ pine: { "--bg": "unset", "--accent": "" } });
    const failures = failuresOf(checkTheme(css, { themeTsText: "" }), "E3");
    expect(failures).toHaveLength(2);
    expect(failures.map((failure) => failure.token).sort()).toEqual(["--accent", "--bg"]);
  });

  it("E4 几何名进主题块、非几何名进基础层", () => {
    const css = fixtures({ pine: { "--fs-11": "12px" }, base: { "--bg": "#000" } });
    const failures = failuresOf(checkTheme(css, { themeTsText: "" }), "E4");
    expect(failures).toHaveLength(2);
    expect(failures.map((failure) => failure.token).sort()).toEqual(["--bg", "--fs-11"]);
  });

  it("E5 别名悬空", () => {
    const css = fixtures({ sand: { "--gold-500": "var(--green-600)" } });
    const failures = failuresOf(checkTheme(css, { themeTsText: "" }), "E5");
    expect(failures).toHaveLength(1);
    expect(failures[0].theme).toBe("sand");
    expect(failures[0].detail).toContain("--green-600");
  });

  it("E5 指向 L1 几何名不算悬空", () => {
    const css = fixtures({ midnight: { "--bg": "var(--fs-11)" } });
    expect(codes(checkTheme(css, { themeTsText: "" }))).not.toContain("E5");
  });

  it("E6 第三组重复表达即失败", () => {
    const pair = { "--dup-a": "#123456", "--dup-b": "#123456" };
    const css = fixtures({ galaxy: pair, pine: pair, sand: pair, midnight: pair });
    const failures = failuresOf(checkTheme(css, { themeTsText: "" }), "E6");
    expect(failures).toHaveLength(1);
    expect(failures[0].detail).toContain("--dup-a");
    expect(failures[0].detail).toContain("--dup-b");
  });

  it("E7 字面量出现在非白名单选择器", () => {
    const css = `${fixtures()}\n.card { color: #ff0000; }\n.galaxy-title { color: #ff0000; }`;
    const failures = failuresOf(
      checkTheme(css, { themeTsText: "", baseline: LITERAL_BASELINE }),
      "E7",
    );
    expect(failures.some((failure) => failure.detail.includes(".card"))).toBe(true);
    expect(failures.some((failure) => failure.detail.includes(".galaxy-title"))).toBe(false);
  });

  it("E7 主题块与 cosmic 块内的字面量不计数", () => {
    const css = `${fixtures()}\n[data-surface="cosmic"] {\n  --cosmic-bg: #050408;\n}\n.galaxy-a { color: #fff; }`;
    const result = checkTheme(css, { themeTsText: "", baseline: 1 });
    expect(result.failures).toEqual([]);
    expect(result.counts.literals).toBe(1);
  });

  it("E7 超过基线即失败（只允许减少）", () => {
    const css = `${fixtures()}\n.galaxy-a { color: #fff; }\n.galaxy-b { color: #000; }`;
    const failures = failuresOf(checkTheme(css, { themeTsText: "", baseline: 1 }), "E7");
    expect(failures.some((failure) => failure.detail.includes("超过基线"))).toBe(true);
  });

  it("E8 theme.ts 出现 #hex", () => {
    const failures = failuresOf(
      checkTheme(fixtures(), { themeTsText: "const c = { bg: '#07060b' };" }),
      "E8",
    );
    expect(failures).toHaveLength(1);
    expect(failures[0].detail).toContain("#07060b");
  });
});
