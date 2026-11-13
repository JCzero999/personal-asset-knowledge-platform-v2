/**
 * Phase 6B 验收截图（ADR-024）：首页内联预览、空结果、语法错误、/search 结果页。
 * 沿用 phase6a 的本机 Chrome + CDP 方案，不引入新依赖。
 *
 * 前置：另起一个 `AUTH_MODE=mock` 的 dev 服务（固定身份 mock-local-user），
 * 并让它指向演示库，避免在真实 Logto 会话里改数据：
 *
 *   AUTH_MODE=mock DATABASE_PATH=data/capture-6b.db \
 *     node node_modules/next/dist/bin/next dev -p 3100
 *
 * 用法：
 *   node scripts/phase6b-capture.mjs
 *   BASE_URL=http://localhost:3100 node scripts/phase6b-capture.mjs
 *
 * 每张图都收集 console / page error；有任何错误时退出码为 2。
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
const PORT = Number(process.env.CDP_PORT || 9336);
const BASE = process.env.BASE_URL || "http://localhost:3100";
const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "docs/screenshots");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  const userDataDir = path.join(os.tmpdir(), `pakp-phase6b-${Date.now()}`);
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
    async screenshot(name) {
      const { data } = await page.send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: false,
        fromSurface: true,
      });
      const file = path.join(OUT, `phase6b-${name}.png`);
      await mkdir(OUT, { recursive: true });
      await writeFile(file, Buffer.from(data, "base64"));
      console.log(`[shot] ${path.relative(ROOT, file)}`);
      return file;
    },
    /** 直接写 value + input 事件：React 受控输入与 CDP 键盘都稳。 */
    async typeInto(selector, text) {
      return page.evaluate(`(() => {
        const input = document.querySelector(${JSON.stringify(selector)});
        if (!input) return false;
        input.focus();
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
        setter.call(input, ${JSON.stringify(text)});
        input.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
      })()`);
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

const VIEWPORTS = {
  desktop: { width: 1440, height: 900, dpr: 1 },
  mobile: { width: 390, height: 844, dpr: 2, mobile: true },
};

/** 等 hydration 完成并确认值真的留在了受控输入里。 */
async function typeStable(page, selector, text) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await page.typeInto(selector, text);
    await sleep(300);
    const value = await page.evaluate(
      `document.querySelector(${JSON.stringify(selector)})?.value ?? ""`,
    );
    if (value === text) return true;
  }
  return false;
}

function collect(problems, name, page) {
  problems.push(...page.consoleErrors.map((error) => `${name} console: ${error}`));
  problems.push(...page.pageErrors.map((error) => `${name} page: ${error}`));
}

async function capture(browser) {
  const problems = [];

  console.log("[step] 1. 首页下拉预览（桌面）");
  {
    const page = await openPage(browser.cdp);
    await page.setViewport(VIEWPORTS.desktop);
    await page.goto(`${BASE}/`);
    const ready = await page.waitFor("Boolean(document.querySelector('.galaxy-search-input'))", 20000);
    if (!ready) problems.push("home-preview-desktop: 搜索框没渲染");
    await sleep(900);

    const typed = await typeStable(page, ".galaxy-search-input", "复盘");
    if (!typed) problems.push("home-preview-desktop: 输入没有进入受控状态");
    const shown = await page.waitFor(
      "document.querySelectorAll('.galaxy-preview-item').length > 0",
      8000,
    );
    if (!shown) problems.push("home-preview-desktop: 200ms 后没有出现预览项");
    await sleep(300);
    await page.screenshot("home-preview-desktop");

    const marks = await page.evaluate("document.querySelectorAll('.galaxy-preview mark').length");
    if (marks === 0) problems.push("home-preview-desktop: 没有高亮 mark");
    collect(problems, "home-preview-desktop", page);
    await page.close();
  }

  console.log("[step] 2. 首页下拉预览（390×844）");
  {
    const page = await openPage(browser.cdp);
    await page.setViewport(VIEWPORTS.mobile);
    await page.goto(`${BASE}/`);
    await page.waitFor("Boolean(document.querySelector('.galaxy-search-input'))", 20000);
    // 等 hydration 完成再写值，否则受控输入可能被首次渲染重置。
    await sleep(900);
    const typed = await typeStable(page, ".galaxy-search-input", "模板");
    if (!typed) problems.push("home-preview-mobile: 输入没有进入受控状态");
    const shown = await page.waitFor(
      "document.querySelectorAll('.galaxy-preview-item').length > 0",
      8000,
    );
    if (!shown) {
      const state = await page.evaluate(
        "document.querySelector('.galaxy-search-input')?.getAttribute('aria-expanded')",
      );
      problems.push(`home-preview-mobile: 没有出现预览项（aria-expanded=${state}）`);
    }
    await sleep(300);
    await page.screenshot("home-preview-mobile");

    const layout = await page.evaluate(`(() => {
      const input = document.querySelector('.galaxy-search')?.getBoundingClientRect();
      const panel = document.querySelector('.galaxy-preview')?.getBoundingClientRect();
      return {
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        hasPanel: Boolean(panel),
        overlapsInput: Boolean(input && panel) && panel.top < input.bottom - 1,
        panelLeft: panel ? Math.round(panel.left) : null,
        panelRight: panel ? Math.round(panel.right) : null,
        viewport: window.innerWidth,
      };
    })()`);

    if (!layout.hasPanel) problems.push("home-preview-mobile: 下拉面板没有渲染");
    if (layout.overflow > 1) problems.push(`home-preview-mobile: 横向溢出 ${layout.overflow}px`);
    if (layout.overlapsInput) problems.push("home-preview-mobile: 下拉遮住了输入框");
    if (layout.panelLeft !== null && (layout.panelLeft < 0 || layout.panelRight > layout.viewport)) {
      problems.push("home-preview-mobile: 下拉超出视口");
    }
    collect(problems, "home-preview-mobile", page);
    await page.close();
  }

  console.log("[step] 3. 首页空结果状态");
  {
    const page = await openPage(browser.cdp);
    await page.setViewport(VIEWPORTS.desktop);
    await page.goto(`${BASE}/`);
    await page.waitFor("Boolean(document.querySelector('.galaxy-search-input'))", 20000);
    await sleep(900);
    const typed = await typeStable(page, ".galaxy-search-input", "量子纠缠实验");
    if (!typed) problems.push("home-no-results: 输入没有进入受控状态");
    const empty = await page.waitFor(
      "document.querySelector('.galaxy-preview') && document.querySelector('.galaxy-preview').innerText.includes('没有匹配的内容')",
      8000,
    );
    if (!empty) problems.push("home-no-results: 没有出现空结果状态");
    await sleep(200);
    await page.screenshot("home-no-results");
    collect(problems, "home-no-results", page);
    await page.close();
  }

  console.log("[step] 4. /search 语法错误");
  {
    const page = await openPage(browser.cdp);
    await page.setViewport(VIEWPORTS.desktop);
    await page.goto(`${BASE}/search?q=${encodeURIComponent("复盘 OR 写作")}`);
    const shown = await page.waitFor("Boolean(document.querySelector('.search-syntax'))", 20000);
    if (!shown) problems.push("search-syntax-error: 没有渲染语法错误块");
    await sleep(200);
    await page.screenshot("search-syntax-error");

    const text = await page.evaluate("document.querySelector('.search-syntax')?.innerText ?? ''");
    if (!text.includes("OR")) problems.push("search-syntax-error: 提示里没有 OR");
    if (!text.includes("^")) problems.push("search-syntax-error: 没有位置指示");
    if (!text.includes("第 4 个字符")) problems.push("search-syntax-error: 没有字符位置说明");
    collect(problems, "search-syntax-error", page);
    await page.close();
  }

  console.log("[step] 5. /search 关键词结果");
  {
    const page = await openPage(browser.cdp);
    await page.setViewport(VIEWPORTS.desktop);
    await page.goto(`${BASE}/search?q=${encodeURIComponent("复盘")}&mode=lexical`);
    const shown = await page.waitFor("document.querySelectorAll('.hit-card').length > 0", 20000);
    if (!shown) problems.push("search-results: 没有命中卡片");
    await sleep(300);
    await page.screenshot("search-results");

    const badges = await page.evaluate(
      "[...document.querySelectorAll('.hit-card .search-source')].map((node) => node.textContent)",
    );
    if (!badges.some((text) => String(text).includes("命中"))) {
      problems.push("search-results: 结果没有来源标记");
    }
    const caption = await page.evaluate("document.body.innerText.includes('仅影响语义结果')");
    if (!caption) problems.push("search-results: 缺少阈值说明");
    collect(problems, "search-results", page);
    await page.close();
  }

  return problems;
}

const browser = await launchBrowser();

let problems = [];

try {
  problems = await capture(browser);
} finally {
  await browser.close();
}

if (problems.length) {
  console.log(`[phase6b] ${problems.length} 个问题`);
  for (const problem of problems) console.log(`  - ${problem}`);
  process.exitCode = 2;
} else {
  console.log("[phase6b] 截图完成，无 console / page 错误，无横向溢出");
}
