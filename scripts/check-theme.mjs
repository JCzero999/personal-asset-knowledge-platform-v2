/**
 * 主题 token 契约校验（ADR-021 第 5 条 / `scripts/check-theme.mjs` 实现规范）。
 *
 * 契约：129 名 = 31 几何（只在 `:root`）+ 98 主题（四个 `[data-theme]` 块集合严格相等）。
 * 本脚本只读 `src/app/globals.css`（E8 额外读 `src/lib/theme.ts`），按 E1–E8 断言：
 *
 *   E1 缺块          四个主题块任一不存在
 *   E2 集合不等      以 galaxy 为基准，其余三块 missing / extra 必须为空
 *   E3 空值/非法值   值为空、`unset`、`initial`、`inherit`
 *   E4 层位错误      几何名进主题块，或非几何名进独立 `:root` 基础层
 *   E5 别名悬空      块内 `var(--X)` 的 X 不在本块、也不是 L1 几何名
 *   E6 重复表达      四块取值全等的两个名字，只允许登记表里的 2 组
 *   E7 字面量白名单  主题块与 cosmic / graph 块之外的颜色字面量，只允许出现在首页规则里且不增加
 *   E8 TS 侧零色值   `src/lib/theme.ts` 不得出现 `#hex`
 *
 * 用法：`node scripts/check-theme.mjs`（npm run check:theme）
 * 退出码：0 全通过；1 有 E1~E8 失败；2 脚本自身异常（读不到文件 / 一块都解析不出）。
 *
 * 纯函数全部导出，单测用内联 CSS 字符串直接调用，不依赖真实文件。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const THEME_IDS = ["galaxy", "pine", "sand", "midnight"];

/** L1 几何档位前缀：只在 `:root`，不进主题块。 */
export const GEOMETRY_PREFIXES = ["--fs-", "--lh-", "--fw-", "--sp-", "--r-"];

/** E6 登记表：唯一真相源规则允许的重复表达（ADR-021 第 5 条）。 */
export const ALLOWED_DUPLICATES = [
  ["--surface-1", "--white"],
  ["--on-gold", "--accent-contrast"],
];

/**
 * E7 基线（按匹配数计，不是行数）。
 *
 * ADR-021 写的是 20；这 20 处在当时确实等于「主题块与 cosmic 块之外的匹配数」。
 * Phase 5c 构图微调给 `.galaxy-scene` 三层加了四周羽化蒙版（`#000` × 8），
 * Phase 6C 又把主题菜单里两处裸色值换成了 token，所以当前应为 26：
 *   20（ADR 实测）+ 8（Phase 5c 蒙版）− 2（Phase 6C 修复）= 26
 * 只允许减少；增加即失败，并给出选择器。
 */
export const LITERAL_BASELINE = 26;

/** E7 白名单：首页固定深空，允许有自己的字面量。 */
export const ALLOWED_LITERAL_SELECTORS = [/\.galaxy-/, /\.theme-switch--home/];

const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/g;

export function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * 扁平化 CSS：返回 `{ selector, body, at }` 列表。
 * `@media` / `@supports` / `@layer` / `@container` 只作为作用域前缀，内部规则照常展开；
 * `@keyframes` 内部的 `from` / `to` 也按规则展开（当前无颜色字面量，不影响 E7）。
 */
export function parseRules(css) {
  const source = stripComments(css);
  const rules = [];

  function walk(text, at) {
    let cursor = 0;
    while (cursor < text.length) {
      const open = text.indexOf("{", cursor);
      if (open < 0) break;

      // 语句头：从上一段的结尾（`;` 或 `}`）到 `{`。顶层通常就是选择器本身。
      let start = cursor;
      for (let k = open - 1; k >= cursor; k -= 1) {
        if (text[k] === ";" || text[k] === "}") {
          start = k + 1;
          break;
        }
      }
      const header = text.slice(start, open).trim();

      let depth = 1;
      let close = open + 1;
      while (close < text.length && depth > 0) {
        if (text[close] === "{") depth += 1;
        else if (text[close] === "}") depth -= 1;
        close += 1;
      }
      const body = text.slice(open + 1, close - 1);

      if (header.startsWith("@") && !/^@(-webkit-)?keyframes\b/.test(header)) {
        walk(body, at ? `${at} ${header}` : header);
      } else {
        rules.push({ selector: header.replace(/\s+/g, " "), body, at });
      }

      cursor = close;
    }
  }

  walk(source, "");
  return rules;
}

function readDeclarations(body) {
  const declarations = [];
  for (const match of body.matchAll(/(--[\w-]+)\s*:\s*([^;]*);/g)) {
    declarations.push({ name: match[1], value: match[2].trim() });
  }
  return declarations;
}

function isGeometryName(name) {
  return GEOMETRY_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * 切出 `:root` 基础层与四个主题块。
 * 返回 `{ base, themes }`，找不到的块给出 `null`。
 */
export function readThemeBlocks(css) {
  const rules = parseRules(css);
  const base = [];
  const themes = Object.fromEntries(THEME_IDS.map((id) => [id, null]));

  for (const rule of rules) {
    if (rule.selector === ":root") {
      base.push(...readDeclarations(rule.body));
      continue;
    }
    if (rule.selector === ':root, [data-theme="galaxy"]') {
      themes.galaxy = (themes.galaxy ?? []).concat(readDeclarations(rule.body));
      continue;
    }
    const match = rule.selector.match(/^\[data-theme="([\w-]+)"\]$/);
    if (match && THEME_IDS.includes(match[1])) {
      themes[match[1]] = (themes[match[1]] ?? []).concat(readDeclarations(rule.body));
    }
  }

  return { base, themes };
}

function toMap(declarations) {
  const map = new Map();
  for (const { name, value } of declarations) map.set(name, value);
  return map;
}

/**
 * 校验入口（纯函数）：
 *   checkTheme(css, { themeTsText, baseline })
 * 返回 `{ failures, counts, blocks }`；`failures` 为空即通过。
 */
export function checkTheme(css, options = {}) {
  const { themeTsText = null, baseline = LITERAL_BASELINE } = options;
  const failures = [];
  const { base, themes } = readThemeBlocks(css);

  // ---------- E1 缺块 ----------
  for (const id of THEME_IDS) {
    if (!themes[id]) {
      failures.push({ code: "E1", theme: id, detail: `缺少 [data-theme="${id}"] 块` });
    }
  }
  if (!base.length) {
    failures.push({ code: "E1", theme: "base", detail: "缺少独立的 ^:root { 基础层" });
  }

  // ---------- E4 基础层层位 ----------
  for (const { name } of base) {
    if (!isGeometryName(name)) {
      failures.push({
        code: "E4",
        theme: "base",
        token: name,
        detail: `非几何名 ${name} 出现在 :root 基础层`,
      });
    }
  }

  const geometry = new Set(base.filter((d) => isGeometryName(d.name)).map((d) => d.name));

  // ---------- E3 / E4 主题块 ----------
  for (const id of THEME_IDS) {
    if (!themes[id]) continue;

    // 同一块内重名按最后一次生效；先记一次，便于 E2 差分。
    for (const { name, value } of themes[id]) {
      if (isGeometryName(name)) {
        failures.push({
          code: "E4",
          theme: id,
          token: name,
          detail: `几何名 ${name} 不允许出现在主题块`,
        });
      }
      if (value === "" || /^(unset|initial|inherit)$/i.test(value)) {
        failures.push({
          code: "E3",
          theme: id,
          token: name,
          detail: `--${name.slice(2)} 的值非法：「${value}」`,
        });
      }
    }
  }

  // ---------- E2 集合相等（以 galaxy 为基准） ----------
  const maps = {};
  for (const id of THEME_IDS) maps[id] = themes[id] ? toMap(themes[id]) : new Map();

  const galaxyNames = new Set(maps.galaxy.keys());
  for (const id of THEME_IDS) {
    if (id === "galaxy" || !themes[id]) continue;
    const names = new Set(maps[id].keys());
    const missing = [...galaxyNames].filter((name) => !names.has(name));
    const extra = [...names].filter((name) => !galaxyNames.has(name));
    if (missing.length || extra.length) {
      failures.push({
        code: "E2",
        theme: id,
        detail: [
          missing.length ? `缺少 ${missing.length} 个：${missing.join(", ")}` : "",
          extra.length ? `多出 ${extra.length} 个：${extra.join(", ")}` : "",
        ]
          .filter(Boolean)
          .join("；"),
      });
    }
  }

  // ---------- E5 别名悬空 ----------
  for (const id of THEME_IDS) {
    if (!themes[id]) continue;
    const defined = maps[id];
    for (const [name, value] of defined) {
      for (const reference of value.matchAll(/var\(\s*(--[\w-]+)/g)) {
        const ref = reference[1];
        if (!defined.has(ref) && !geometry.has(ref)) {
          failures.push({
            code: "E5",
            theme: id,
            token: name,
            detail: `--${name.slice(2)} 引用的 ${ref} 在本块不可解析`,
          });
        }
      }
    }
  }

  // ---------- E6 重复表达 ----------
  if (THEME_IDS.every((id) => themes[id])) {
    const allowed = new Set(
      ALLOWED_DUPLICATES.map(([a, b]) => [a, b].sort().join("|")),
    );
    const names = [...galaxyNames];
    const duplicates = [];
    for (let i = 0; i < names.length; i += 1) {
      for (let j = i + 1; j < names.length; j += 1) {
        const [a, b] = [names[i], names[j]];
        const equalEverywhere = THEME_IDS.every((id) => maps[id].get(a) === maps[id].get(b));
        if (!equalEverywhere) continue;
        const key = [a, b].sort().join("|");
        if (!allowed.has(key)) duplicates.push([a, b, maps.galaxy.get(a)]);
      }
    }
    for (const [a, b, value] of duplicates) {
      failures.push({
        code: "E6",
        token: a,
        detail: `${a} 与 ${b} 在四套主题下取值全等（${value}），未登记为重复表达`,
      });
    }
    const allowedCount = ALLOWED_DUPLICATES.length;
    if (duplicates.length + allowedCount > 0) {
      // 计数留给输出，仅确认登记表本身仍是 2 组。
      if (ALLOWED_DUPLICATES.length !== 2) {
        failures.push({ code: "E6", detail: `登记表应为 2 组，实际 ${allowedCount} 组` });
      }
    }
  }

  // ---------- E7 字面量白名单 ----------
  const literalHits = [];
  for (const rule of parseRules(css)) {
    if (isThemeSelector(rule.selector) || isFixedSurfaceSelector(rule.selector)) continue;
    const matches = rule.body.match(COLOR_LITERAL);
    if (!matches) continue;
    literalHits.push({ selector: rule.selector, at: rule.at, count: matches.length });
  }

  const literalTotal = literalHits.reduce((sum, hit) => sum + hit.count, 0);
  for (const hit of literalHits) {
    if (!ALLOWED_LITERAL_SELECTORS.some((pattern) => pattern.test(hit.selector))) {
      failures.push({
        code: "E7",
        detail: `${hit.at ? `${hit.at} ` : ""}${hit.selector} 内有 ${hit.count} 处裸色值（不在首页白名单）`,
      });
    }
  }
  if (literalTotal > baseline) {
    failures.push({
      code: "E7",
      detail: `主题块与 cosmic / graph 块之外的颜色字面量 ${literalTotal} 处，超过基线 ${baseline}（只允许减少）`,
    });
  }

  // ---------- E8 TS 侧零色值 ----------
  if (typeof themeTsText === "string") {
    const hexes = themeTsText.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    if (hexes.length > 0) {
      failures.push({
        code: "E8",
        detail: `src/lib/theme.ts 仍有 ${hexes.length} 处 #hex：${[...new Set(hexes)].join(", ")}`,
      });
    }
  }

  return {
    failures,
    counts: {
      geometry: geometry.size,
      theme: galaxyNames.size,
      base: base.length,
      literals: literalTotal,
    },
    blocks: Object.fromEntries(THEME_IDS.map((id) => [id, maps[id].size])),
  };
}

function isThemeSelector(selector) {
  return (
    selector === ":root" ||
    selector === ':root, [data-theme="galaxy"]' ||
    THEME_IDS.some((id) => selector === `[data-theme="${id}"]`)
  );
}

function isFixedSurfaceSelector(selector) {
  return /\[data-surface="(cosmic|graph)"\]/.test(selector);
}

/**
 * 人可读输出。`verbose` 打印失败明细；每块一行，末行汇总。
 */
export function formatReport(result) {
  const lines = [];
  for (const id of THEME_IDS) {
    const count = result.blocks[id];
    const failed = result.failures.some((failure) => failure.theme === id);
    lines.push(`${id.padEnd(9)}${String(count).padStart(3)} tokens  ${failed ? "FAIL" : "PASS"}`);
  }

  if (result.failures.length > 0) {
    lines.push("");
    for (const failure of result.failures) {
      const where = [failure.theme, failure.token].filter(Boolean).join(" / ");
      lines.push(`  ${failure.code}${where ? `  ${where}` : ""}  ${failure.detail}`);
    }
  }

  const { geometry, theme, literals } = result.counts;
  lines.push("");
  lines.push(
    `${geometry + theme} 名（${geometry} 几何 + ${theme} 主题）· 4 块集合一致 · ${result.failures.length} 失败 · 字面量 ${literals}`,
  );
  return lines.join("\n");
}

function main() {
  const root = path.resolve(import.meta.dirname, "..");
  const cssPath = path.join(root, "src/app/globals.css");
  const themeTsPath = path.join(root, "src/lib/theme.ts");

  let css;
  let themeTs;
  try {
    css = readFileSync(cssPath, "utf8");
    themeTs = readFileSync(themeTsPath, "utf8");
  } catch (error) {
    console.error(`check-theme: 读不到输入文件（${error.message}）`);
    process.exit(2);
  }

  let result;
  try {
    result = checkTheme(css, { themeTsText: themeTs });
  } catch (error) {
    console.error(`check-theme: 解析失败（${error.message}）`);
    process.exit(2);
  }

  if (Object.values(result.blocks).every((count) => count === 0)) {
    console.error("check-theme: 一个主题块都没解析出来，脚本口径与 globals.css 可能已脱节");
    process.exit(2);
  }

  console.log(formatReport(result));
  process.exit(result.failures.length > 0 ? 1 : 0);
}

const invokedDirectly =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) main();
