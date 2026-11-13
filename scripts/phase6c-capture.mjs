/**
 * Phase 6C 验收截图（ADR-021 收尾）：四套主题下的头像菜单色板。
 *
 * 色点颜色本轮从 `THEME_META.swatch`（TS 里 16 个 hex）移到 CSS：
 * 每个色点外层带 `data-theme`，色点读 `var(--bg/--surface/--accent/--text-1)`。
 * 本脚本做两件事：
 *   1. 逐主题截图 `docs/screenshots/theme-swatches-<theme>.png`；
 *   2. 读出四个色点的计算色，与迁移前 TS 里的 16 个 hex 逐一比对，
 *      证明「视觉零变化」不是口号。
 *
 * 前置：另起一个 mock 身份的 dev 服务（不要打在真实 Logto 会话上）。
 * 数据库必须放在项目目录**外**：SQLite 的 -wal 每次写入都会让 Turbopack 判定
 * 「文件变了」→ 重编译 → HMR 整页 reload，循环起来页面永远点不动
 * （表现：aria-expanded 始终 false、document.readyState 在 complete/interactive 之间抖动）。
 *
 *   AUTH_MODE=mock DATABASE_PATH="$TMP/pakp-capture-6c.db" \
 *     node node_modules/next/dist/bin/next dev -p 3100
 *
 * 用法：BASE_URL=http://localhost:3100 node scripts/phase6c-capture.mjs
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
].filter(Boolean);
const CHROME = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
const PORT = Number(process.env.CDP_PORT || 9337);
const BASE = process.env.BASE_URL || "http://localhost:3100";
const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "docs/screenshots");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 迁移前 `THEME_META.swatch` 的 16 个值：用于逐点比对（不是新的真值来源）。 */
const EXPECTED_DOTS = {
  galaxy: ["#07060b", "#0e0c13", "#e9c08a", "#f3efe7"],
  pine: ["#eef1ec", "#ffffff", "#2f7657", "#17251f"],
  sand: ["#f5efe4", "#fffaf1", "#a45a2a", "#2e2419"],
  midnight: ["#0b1220", "#111b2e", "#2563eb", "#e6edf9"],
};

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Map();

    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const entry = this.pending.get(message.id);
        if (!entry) return;
        this.pending.delete(message.id);
        if (message.error) entry.reject(new Error(`${entry.method}: ${message.error.message}`));
        else entry.resolve(message.result);
        return;
      }
      const key = `${message.sessionId ?? ""}:${message.method}`;
      for (const fn of this.listeners.get(key) ?? []) fn(message.params);
      for (const fn of this.listeners.get(message.method) ?? []) fn(message.params, message.sessionId);
    });
  }

  send(method, params = {}, sessionId) {
    const id = ++this.nextId;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`${method}: timeout`));
        }
      }, 60000);
    });
  }

  on(event, fn) {
    const list = this.listeners.get(event) ?? [];
    list.push(fn);
    this.listeners.set(event, list);
  }
}

async function waitForEndpoint(url, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch {
      // Chrome 还没起来
    }
    await sleep(200);
  }
  throw new Error(`等待 ${url} 超时`);
}

async function launchBrowser() {
  if (!CHROME) throw new Error("找不到 Chrome / Edge，可设置 CHROME_PATH");
  const userDataDir = path.join(os.tmpdir(), `pakp-phase6c-${Date.now()}`);
  const child = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--hide-scrollbars",
      "about:blank",
    ],
    { stdio: "ignore", windowsHide: true },
  );

  const version = await waitForEndpoint(`http://127.0.0.1:${PORT}/json/version`);
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });

  const cdp = new Cdp(ws);

  return {
    cdp,
    async close() {
      try {
        await cdp.send("Browser.close");
      } catch {
        child.kill();
      }
      ws.close();
      await sleep(300);
      await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

async function openPage(cdp) {
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const page = {
    sessionId,
    consoleErrors: [],
    pageErrors: [],
    send: (method, params) => cdp.send(method, params, sessionId),
    async evaluate(expression) {
      const result = await cdp.send(
        "Runtime.evaluate",
        { expression, awaitPromise: true, returnByValue: true },
        sessionId,
      );
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description ?? "页面脚本执行失败");
      }
      return result.result?.value;
    },
    async goto(url) {
      const loaded = new Promise((resolve) => {
        cdp.on(`${sessionId}:Page.loadEventFired`, resolve);
        setTimeout(resolve, 15000);
      });
      await cdp.send("Page.navigate", { url }, sessionId);
      await loaded;
    },
    async waitFor(expression, timeoutMs = 20000, intervalMs = 120) {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        try {
          if (await page.evaluate(expression)) return true;
        } catch {
          // 页面还在导航/重建
        }
        await sleep(intervalMs);
      }
      return false;
    },
    async setViewport({ width, height, dpr = 1, mobile = false }) {
      await page.send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: dpr,
        mobile,
        screenWidth: width,
        screenHeight: height,
      });
    },
    async screenshot(name, clip = null) {
      const { data } = await page.send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: false,
        fromSurface: true,
        ...(clip ? { clip: { ...clip, scale: 2 } } : {}),
      });
      const file = path.join(OUT, `${name}.png`);
      await mkdir(OUT, { recursive: true });
      await writeFile(file, Buffer.from(data, "base64"));
      console.log(`[shot] ${path.relative(ROOT, file)}`);
      return file;
    },
    async close() {
      await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
    },
  };

  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Runtime.enable", {}, sessionId);

  cdp.on(`${sessionId}:Runtime.consoleAPICalled`, (params) => {
    if (params.type !== "error") return;
    page.consoleErrors.push(
      params.args.map((arg) => arg.description ?? arg.value ?? "").join(" ").slice(0, 600),
    );
  });
  cdp.on(`${sessionId}:Runtime.exceptionThrown`, (params) => {
    page.pageErrors.push(params.exceptionDetails?.exception?.description?.slice(0, 600) ?? "exception");
  });

  return page;
}

function hexToRgb(hex) {
  const value = hex.replace("#", "");
  const full = value.length === 3 ? value.split("").map((ch) => ch + ch).join("") : value;
  return [0, 2, 4].map((offset) => parseInt(full.slice(offset, offset + 2), 16));
}

const rgbText = (hex) => `rgb(${hexToRgb(hex).join(", ")})`;

async function openRailMenu(page) {
  // 流式渲染期间内容会短暂挂在 hidden 容器里（尺寸 0），等它真的有尺寸再点。
  const visible = await page.waitFor(`(() => {
    const trigger = document.querySelector('.theme-switch-trigger--rail');
    if (!trigger) return false;
    const rect = trigger.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  })()`, 30000);
  if (!visible) return false;

  // 等 hydration：菜单的 onClick 是 React 事件，水合前点不动。
  await sleep(1500);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const state = await page.evaluate(`(() => {
      const trigger = document.querySelector('.theme-switch-trigger--rail');
      if (!trigger) return null;
      const rect = trigger.getBoundingClientRect();
      return {
        expanded: trigger.getAttribute('aria-expanded') === 'true',
        options: document.querySelectorAll('.theme-option').length,
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
      };
    })()`);
    if (!state) return false;
    if (state.options === 4) return true;
    if (state.expanded) {
      await sleep(250);
      continue;
    }

    // 用 CDP 发真实鼠标事件：比 element.click() 更接近用户操作。
    for (const type of ["mousePressed", "mouseReleased"]) {
      await page.send("Input.dispatchMouseEvent", {
        type,
        x: state.x,
        y: state.y,
        button: "left",
        clickCount: 1,
      });
    }
    await sleep(350);
  }
  return false;
}

async function capture(browser) {
  const problems = [];
  const page = await openPage(browser.cdp);
  await page.setViewport({ width: 1440, height: 900, dpr: 1 });

  await page.goto(`${BASE}/workspace`);
  if (!(await page.waitFor("Boolean(document.querySelector('.theme-switch-trigger--rail'))", 25000))) {
    throw new Error("/workspace 没有渲染账号菜单，确认 AUTH_MODE=mock 且数据库可读");
  }

  for (const theme of Object.keys(EXPECTED_DOTS)) {
    console.log(`[step] ${theme}: 打开头像菜单`);
    await page.evaluate(
      `localStorage.setItem('pakp.theme', ${JSON.stringify(theme)}); localStorage.removeItem('theme')`,
    );
    await page.goto(`${BASE}/workspace`);
    const applied = await page.evaluate("document.documentElement.getAttribute('data-theme')");
    if (applied !== theme) problems.push(`${theme}: data-theme=${applied}`);

    if (!(await openRailMenu(page))) {
      const diagnostics = await page.evaluate(`(() => {
        const trigger = document.querySelector('.theme-switch-trigger--rail');
        return {
          expanded: trigger?.getAttribute('aria-expanded') ?? null,
          triggerHtml: trigger ? trigger.outerHTML.slice(0, 240) : null,
          options: document.querySelectorAll('.theme-option').length,
          panel: Boolean(document.querySelector('.theme-switch-panel')),
          bodyText: document.body.innerText.slice(0, 160),
        };
      })()`);
      problems.push(`${theme}: 菜单没有出现 4 个主题项 ${JSON.stringify(diagnostics)}`);
      problems.push(...page.consoleErrors.map((error) => `${theme} console: ${error}`));
      problems.push(...page.pageErrors.map((error) => `${theme} page: ${error}`));
      continue;
    }
    await sleep(250);
    await page.screenshot(`theme-swatches-${theme}`);
    // 菜单贴着屏幕底部，全屏截图会切掉下半张；再补一张菜单区的特写。
    const panelClip = await page.evaluate(`(() => {
      const panel = document.querySelector('.theme-switch-panel');
      if (!panel) return null;
      const rect = panel.getBoundingClientRect();
      const x = Math.max(0, rect.left - 12);
      const y = Math.max(0, rect.top - 12);
      const width = Math.min(window.innerWidth, rect.right + 12) - x;
      const height = Math.min(window.innerHeight, rect.bottom + 12) - y;
      return { x, y, width, height };
    })()`);
    if (panelClip && panelClip.width > 0 && panelClip.height > 0) {
      await page.screenshot(`theme-swatches-${theme}-panel`, panelClip);
    }

    const readings = await page.evaluate(`(() => {
      return [...document.querySelectorAll('.theme-option')].map((option) => ({
        theme: option.querySelector('.theme-option-dots')?.getAttribute('data-theme') ?? null,
        dots: [...option.querySelectorAll('.theme-option-dots i')].map(
          (dot) => getComputedStyle(dot).backgroundColor
        ),
      }));
    })()`);

    const order = ["galaxy", "pine", "sand", "midnight"];
    if (readings.length !== order.length) problems.push(`${theme}: 主题项数量 ${readings.length}`);
    for (const reading of readings) {
      const expected = EXPECTED_DOTS[reading.theme];
      if (!expected) {
        problems.push(`${theme}: 色点容器缺少 data-theme`);
        continue;
      }
      reading.dots.forEach((actual, index) => {
        if (actual !== rgbText(expected[index])) {
          problems.push(
            `${theme} 面板 / ${reading.theme} 色点 ${index + 1}: ${actual} ≠ ${rgbText(expected[index])}`,
          );
        }
      });
    }

    await page.evaluate("document.querySelector('.theme-switch-trigger--rail').click()");
    await sleep(150);
    problems.push(...page.consoleErrors.map((error) => `${theme} console: ${error}`));
    problems.push(...page.pageErrors.map((error) => `${theme} page: ${error}`));
    page.consoleErrors.length = 0;
    page.pageErrors.length = 0;
  }

  console.log("[step] 旧键迁移：只有 theme=pine 时首帧脚本应迁移到 pakp.theme");
  await page.evaluate(
    "localStorage.removeItem('pakp.theme'); localStorage.setItem('theme', 'pine')",
  );
  await page.goto(`${BASE}/workspace`);
  const migration = await page.evaluate(`({
    applied: document.documentElement.getAttribute('data-theme'),
    current: localStorage.getItem('pakp.theme'),
    legacy: localStorage.getItem('theme'),
  })`);
  if (migration.applied !== "pine") problems.push(`迁移: data-theme=${migration.applied}`);
  if (migration.current !== "pine") problems.push(`迁移: pakp.theme=${migration.current}`);
  if (migration.legacy !== null) problems.push(`迁移: 旧键未删除 (${migration.legacy})`);

  await page.evaluate("localStorage.clear()");
  await page.close();
  return problems;
}

const browser = await launchBrowser();
let problems = [];

try {
  problems = await capture(browser);
} finally {
  await browser.close();
}

if (problems.length > 0) {
  console.error("\n[problems]");
  for (const problem of problems) console.error(`- ${problem}`);
  process.exit(2);
}

console.log("\n相位 6C 截图与色点比对全部通过");
