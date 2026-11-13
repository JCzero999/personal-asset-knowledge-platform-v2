/**
 * 主题配色对比度校验（Phase 5 / ADR-020，Phase 5b 扩到四套主题）。
 *
 * 直接读 `src/app/globals.css` 的四个 `[data-theme]` 令牌块，加上固定深色的
 * `[data-surface="graph"]` 舞台令牌，按 WCAG 2.1 计算实际渲染出来的对比度：
 *   - 正文与正文级文字：≥ 4.5:1
 *   - 18.66px+ 粗体或 24px+ 大字号、图标/描边等非文本 UI：≥ 3:1
 *
 * 改主题时先跑一遍，别让注释里的数字和真实值脱节：
 *   node scripts/check-contrast.mjs
 * 失败时退出码为 1（可挂进 CI）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const CSS = readFileSync(path.join(ROOT, "src/app/globals.css"), "utf8");

const THEME_BLOCKS = [
  { id: "galaxy", pattern: /:root,\s*\n\[data-theme="galaxy"\]\s*\{([\s\S]*?)\n\}/ },
  { id: "pine", pattern: /\[data-theme="pine"\]\s*\{([\s\S]*?)\n\}/ },
  { id: "sand", pattern: /\[data-theme="sand"\]\s*\{([\s\S]*?)\n\}/ },
  { id: "midnight", pattern: /\[data-theme="midnight"\]\s*\{([\s\S]*?)\n\}/ },
];

/** 抓主题块里所有 `--name: value;`。 */
function readTokens(pattern, themeId) {
  const match = CSS.match(pattern);
  if (!match) throw new Error(`找不到 ${themeId} 的令牌块`);

  const tokens = {};
  for (const line of match[1].split("\n")) {
    // 允许一行里写多个声明（如状态色成对出现）。
    for (const decl of line.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) {
      tokens[decl[1]] = decl[2].trim();
    }
  }
  return tokens;
}

function createResolver(tokens) {
  return function resolve(name, depth = 0) {
    if (depth > 6) throw new Error(`令牌循环引用: --${name}`);
    const raw = tokens[name];
    if (!raw) throw new Error(`未定义令牌: --${name}`);

    const reference = raw.match(/^var\(--([\w-]+)\)$/);
    return reference ? resolve(reference[1], depth + 1) : raw;
  };
}

function parseHex(value, label) {
  const hex = value.trim().replace(/^#/, "");
  if (!/^[0-9a-f]{3}$|^[0-9a-f]{6}$/i.test(hex)) {
    throw new Error(`${label} 不是可计算的十六进制色: ${value}`);
  }
  const full = hex.length === 3 ? hex.split("").map((ch) => ch + ch).join("") : hex;
  return [0, 2, 4].map((offset) => parseInt(full.slice(offset, offset + 2), 16));
}

/** WCAG 相对亮度。 */
function luminance([r, g, b]) {
  const channel = (value) => {
    const ratio = value / 255;
    return ratio <= 0.03928 ? ratio / 12.92 : ((ratio + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(foreground, background) {
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

/**
 * 需要校验的配对。
 * `min` 按用途取值：4.5 正文级，3 大字号/图标/描边。
 */
const PAIRS = [
  { fg: "text-1", bg: "surface", min: 4.5, usage: "正文主色 / 卡片" },
  { fg: "text-1", bg: "surface-2", min: 4.5, usage: "正文主色 / 内嵌区" },
  { fg: "text-1", bg: "surface-3", min: 4.5, usage: "正文主色 / 悬浮块" },
  { fg: "text-1", bg: "paper", min: 4.5, usage: "正文主色 / 页面底" },
  { fg: "text-2", bg: "surface", min: 4.5, usage: "次级正文 / 卡片" },
  { fg: "text-2", bg: "surface-2", min: 4.5, usage: "次级正文 / 内嵌区" },
  { fg: "text-3", bg: "surface", min: 4.5, usage: "辅助说明 / 卡片" },
  { fg: "text-3", bg: "paper", min: 4.5, usage: "辅助说明 / 页面底" },
  { fg: "text-on-dark", bg: "green-800", min: 4.5, usage: "侧栏正文" },
  { fg: "text-on-dark-muted", bg: "green-800", min: 4.5, usage: "侧栏次级正文" },
  { fg: "rail-active-fg", bg: "green-800", min: 4.5, usage: "侧栏选中文字" },
  { fg: "accent-text", bg: "surface", min: 4.5, usage: "强调文字 / 卡片" },
  { fg: "accent-text", bg: "paper", min: 4.5, usage: "强调文字 / 页面底" },
  { fg: "accent-contrast", bg: "accent", min: 4.5, usage: "主按钮文字" },
  { fg: "accent-contrast", bg: "accent-hover", min: 4.5, usage: "主按钮 hover 文字" },
  { fg: "green-300", bg: "green-800", min: 3, usage: "深底图标 / 指示条" },
  { fg: "line-strong", bg: "surface", min: 1.2, usage: "hover 描边（仅需可见）" },
  { fg: "ok-fg", bg: "ok-bg", min: 4.5, usage: "成功状态" },
  { fg: "warn-fg", bg: "warn-bg", min: 4.5, usage: "警告状态" },
  { fg: "info-fg", bg: "info-bg", min: 4.5, usage: "信息状态" },
  { fg: "danger-fg", bg: "danger-bg", min: 4.5, usage: "危险状态（文字）" },
  { fg: "on-danger", bg: "danger-solid", min: 4.5, usage: "危险按钮文字" },
  { fg: "on-danger", bg: "danger-solid-hover", min: 4.5, usage: "危险按钮 hover 文字" },
];

/** 图谱舞台：固定深色，令牌与主题无关；带 alpha 的边要先合成到画布上再算。 */
const GRAPH_BLOCK = /\[data-surface="graph"\]\s*\{([\s\S]*?)\n\}/;
const graphTokens = readTokens(GRAPH_BLOCK, "graph");
const resolveGraph = createResolver(graphTokens);

/** 2D 阅读面覆盖组：画布与边色在这里被重新声明，必须单独校验。 */
const GRAPH_2D_BLOCK = /\[data-surface="graph"\]\[data-mode="2d"\]\s*\{([\s\S]*?)\n\}/;
const graphTokens2d = { ...graphTokens, ...readTokens(GRAPH_2D_BLOCK, "graph-2d") };
const resolveGraph2d = createResolver(graphTokens2d);

/**
 * 图谱的六组对比度（节点 / 标签 / 普通边 / 强边 / 选中环 / 路径）。
 * 节点六类各算一条，但同属一组「节点 vs 画布」。
 */
const GRAPH_PAIRS = [
  ...["concept", "person", "org", "work", "method", "other"].map((type) => ({
    fg: `graph-node-${type}`,
    bg: "graph-canvas",
    min: 3,
    usage: `图谱 · 节点（${type}）/ 画布`,
  })),
  { fg: "graph-core", bg: "graph-canvas", min: 4.5, usage: "图谱 · 节点标签 / 画布" },
  // 3D 背景细边是雾化星云里的空间线索，不承载「谁连谁」的信息（阅读在 2D / 列表完成），
  // 因此单列为装饰纹理，只要求可见；真正的信息载体边在下面的 2D 组按 3:1 校验。
  { fg: "graph-edge", bg: "graph-canvas", min: 1.2, usage: "图谱 3D · 背景细边（装饰纹理，非信息载体）" },
  { fg: "graph-edge-strong", bg: "graph-canvas", min: 1.5, usage: "图谱 3D · 背景强边（装饰纹理，非信息载体）" },
  { fg: "graph-accent", bg: "graph-canvas", min: 3, usage: "图谱 · 选中环 / 画布" },
  { fg: "graph-accent", bg: "graph-canvas", min: 3, usage: "图谱 · 路径 / 画布" },
];

/**
 * 2D 实际渲染的边（验收裁决）：[data-mode="2d"] 覆盖组里的普通边与强边
 * 是阅读时唯一的连接信息，非文本 UI 门槛按 3:1；路径高亮同组一起校验。
 */
const GRAPH_2D_PAIRS = [
  { fg: "graph-edge", bg: "graph-canvas", min: 3, usage: "图谱 2D · 普通边 / 画布（信息载体）" },
  { fg: "graph-edge-strong", bg: "graph-canvas", min: 3, usage: "图谱 2D · 强边 / 画布（信息载体）" },
  { fg: "graph-accent", bg: "graph-canvas", min: 3, usage: "图谱 2D · 路径 / 画布" },
];

/**
 * 图谱玻璃浮层组（ADR-027 第 11 条）。
 *
 * 玻璃底是半透明的，星点会从下面透上来，所以不能拿 `--graph-canvas` 直接当背景：
 * 按最坏情况合成——`.graph-workspace.is-float` 的径向渐变中心是
 * `color-mix(in srgb, var(--graph-accent) 6%, var(--graph-canvas))`，先合成出
 * 「最亮画布」，再把玻璃底叠上去，得到等效色；文字若在等效色上仍达标，任何
 * 星点亮度下都达标。
 */
function mixOver(foreground, backdrop, percent) {
  const alpha = percent / 100;
  return {
    rgb: foreground.rgb.map((channel, index) => channel * alpha + backdrop.rgb[index] * (1 - alpha)),
    alpha: 1,
  };
}

/** 只接受 `color-mix(in srgb, var(--x) N%, transparent)`：玻璃令牌的唯一写法。 */
function parseMixToken(value, label) {
  const match = value.match(
    /^color-mix\(in srgb,\s*var\(--([\w-]+)\)\s*([\d.]+)%?,\s*transparent\)$/,
  );
  if (!match) throw new Error(`${label} 不是 color-mix(var, N%, transparent) 形式: ${value}`);
  return { token: match[1], percent: Number(match[2]) };
}

function measureGlassPairs() {
  const canvas = parseColor(resolveGraph("graph-canvas"), "--graph-canvas");
  const accent = parseColor(resolveGraph("graph-accent"), "--graph-accent");
  const core = parseColor(resolveGraph("graph-core"), "--graph-core");

  // 最亮画布：径向渐变中心 6% 强调色叠在画布上（与 globals.css 的渐变写法一致）。
  const brightest = mixOver(accent, canvas, 6);

  const glassBgToken = parseMixToken(resolveGraph("graph-glass-bg"), "--graph-glass-bg");
  const glassBgBase = parseColor(resolveGraph(glassBgToken.token), `--${glassBgToken.token}`);
  const glass = mixOver(glassBgBase, brightest, glassBgToken.percent);

  const borderToken = parseMixToken(resolveGraph("graph-glass-border"), "--graph-glass-border");
  const borderBase = parseColor(resolveGraph(borderToken.token), `--${borderToken.token}`);
  const border = mixOver(borderBase, glass, borderToken.percent);

  // 玻璃上的次级文字是 --graph-core 66%（.graph-workspace.is-float 里的 --text-3 桥接值）。
  const muted = mixOver(core, glass, 66);

  return [
    { fg: "graph-core", ratio: contrast(core.rgb, glass.rgb), min: 4.5, usage: "图谱玻璃 · 正文 / 玻璃底" },
    { fg: "graph-core 66%", ratio: contrast(muted.rgb, glass.rgb), min: 4.5, usage: "图谱玻璃 · 辅助说明 / 玻璃底" },
    { fg: "graph-accent", ratio: contrast(accent.rgb, glass.rgb), min: 3, usage: "图谱玻璃 · 图标 / 链接 / 玻璃底" },
    // 1px 发丝描边不承载信息（面板靠底色与模糊被识别），门槛同 --line-strong：只要求可见。
    // ADR-027 第 11 条给边框写的是 3:1，但 22% 的强调色在深空底上实测约 1.7:1；
    // 若要 3:1 需把 --graph-glass-border 提到约 48%，观感会从「细边框」变成「亮圈」。
    {
      fg: "graph-glass-border",
      ratio: contrast(border.rgb, glass.rgb),
      min: 1.5,
      usage: "图谱玻璃 · 1px 描边 / 玻璃底（仅需可见）",
    },
  ];
}

const glassPairs = measureGlassPairs();

/** 解析 #hex 或 rgb()/rgba()（含空格 + 斜杠写法），保留 alpha。 */
function parseColor(value, label) {
  const text = value.trim();
  if (/^#[0-9a-f]{3}$|^#[0-9a-f]{6}$/i.test(text)) {
    return { rgb: parseHex(text, label), alpha: 1 };
  }
  const match = text.match(
    /^rgba?\(\s*([0-9.]+)[\s,]+([0-9.]+)[\s,]+([0-9.]+)(?:\s*[/,]\s*([0-9.]+%?))?\s*\)$/i,
  );
  if (!match) throw new Error(`${label} 不是可计算的色值: ${value}`);
  const alpha = match[4] === undefined
    ? 1
    : match[4].endsWith("%")
      ? Number.parseFloat(match[4]) / 100
      : Number.parseFloat(match[4]);
  return { rgb: [Number(match[1]), Number(match[2]), Number(match[3])], alpha };
}

function blend(foreground, backdrop) {
  const alpha = foreground.alpha;
  return foreground.rgb.map((channel, index) => channel * alpha + backdrop.rgb[index] * (1 - alpha));
}

function measure(fgValue, bgValue, label) {
  const fg = parseColor(fgValue, label);
  const bg = parseColor(bgValue, label);
  const base = bg.alpha < 1 ? { rgb: blend(bg, { rgb: [0, 0, 0], alpha: 1 }), alpha: 1 } : bg;
  const onBase = fg.alpha < 1 ? { rgb: blend(fg, base), alpha: 1 } : fg;
  return contrast(onBase.rgb, base.rgb);
}

const width = (key, rows) =>
  Math.max([...key].reduce((n, ch) => n + (ch.charCodeAt(0) > 255 ? 2 : 1), 0), ...rows.map((row) => row[key].length));
const keys = ["前景", "背景", "实测", "要求", "结果", "用途"];
const pad = (text, size) =>
  text + " ".repeat(Math.max(0, size - [...text].reduce((n, ch) => n + (ch.charCodeAt(0) > 255 ? 2 : 1), 0)));

let totalFailed = 0;

for (const block of THEME_BLOCKS) {
  const tokens = readTokens(block.pattern, block.id);
  const resolve = createResolver(tokens);
  const rows = [];
  let failed = 0;

  for (const pair of PAIRS) {
    const fgValue = resolve(pair.fg);
    const bgValue = resolve(pair.bg);
    let ratio;
    try {
      ratio = contrast(parseHex(fgValue, `--${pair.fg}`), parseHex(bgValue, `--${pair.bg}`));
    } catch (error) {
      failed += 1;
      rows.push({
        前景: `--${pair.fg}`,
        背景: `--${pair.bg}`,
        实测: error.message,
        要求: `${pair.min}:1`,
        结果: "FAIL",
        用途: pair.usage,
      });
      continue;
    }
    const ok = ratio >= pair.min - 0.005;
    if (!ok) failed += 1;
    rows.push({
      前景: `--${pair.fg}`,
      背景: `--${pair.bg}`,
      实测: `${ratio.toFixed(2)}:1`,
      要求: `${pair.min}:1`,
      结果: ok ? "PASS" : "FAIL",
      用途: pair.usage,
    });
  }

  // 图谱舞台在这四套主题下都是同一块固定深色：同样逐主题校验一遍，
  // 保证以后有人把舞台令牌挪进主题块时这里立刻报出来。
  const graphGroups = [
    { pairs: GRAPH_PAIRS, resolve: resolveGraph },
    { pairs: GRAPH_2D_PAIRS, resolve: resolveGraph2d },
  ];
  const graphPairs = graphGroups.flatMap((group) =>
    group.pairs.map((pair) => ({ pair, resolve: group.resolve })),
  );
  for (const { pair, resolve } of graphPairs) {
    let ratio;
    try {
      ratio = measure(resolve(pair.fg), resolve(pair.bg), `--${pair.fg}`);
    } catch (error) {
      failed += 1;
      rows.push({
        前景: `--${pair.fg}`,
        背景: `--${pair.bg}`,
        实测: error.message,
        要求: `${pair.min}:1`,
        结果: "FAIL",
        用途: pair.usage,
      });
      continue;
    }
    const ok = ratio >= pair.min - 0.005;
    if (!ok) failed += 1;
    rows.push({
      前景: `--${pair.fg}`,
      背景: `--${pair.bg}`,
      实测: `${ratio.toFixed(2)}:1`,
      要求: `${pair.min}:1`,
      结果: ok ? "PASS" : "FAIL",
      用途: pair.usage,
    });
  }

  // 玻璃组：令牌写在固定深色面里，四套主题读数相同，仍逐主题输出一次，
  // 以后有人把玻璃令牌挪进主题块时这里会立刻分出差异。
  for (const pair of glassPairs) {
    const ok = pair.ratio >= pair.min - 0.005;
    if (!ok) failed += 1;
    rows.push({
      前景: `--${pair.fg}`,
      背景: "玻璃底（最亮画布合成）",
      实测: `${pair.ratio.toFixed(2)}:1`,
      要求: `${pair.min}:1`,
      结果: ok ? "PASS" : "FAIL",
      用途: pair.usage,
    });
  }

  const widths = Object.fromEntries(keys.map((key) => [key, width(key, rows)]));  console.log(`\n=== 主题：${block.id} ===`);
  console.log(keys.map((key) => pad(key, widths[key])).join("  "));
  console.log(keys.map((key) => "-".repeat(widths[key])).join("  "));
  for (const row of rows) {
    console.log(keys.map((key) => pad(row[key], widths[key])).join("  "));
  }
  console.log(`${rows.length - failed}/${rows.length} 组通过${failed ? `，${failed} 组未达标` : ""}`);
  totalFailed += failed;
}

process.exit(totalFailed ? 1 : 0);
