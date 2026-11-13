/**
 * Phase 6A 验收截图（ADR-023）：新建 / 编辑弹窗里的分类选择器、自定义弹窗，
 * 以及分类管理页。用本机 Chrome + CDP，不引入 puppeteer。
 *
 * 用法：
 *   node scripts/phase6a-capture.mjs           # 输出 docs/screenshots/phase6a-*
 *   BASE_URL=http://localhost:3000 node scripts/phase6a-capture.mjs
 *
 * 每张图都收集 console / page error，最后汇总；有任何错误时退出码为 2。
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
const PORT = Number(process.env.CDP_PORT || 9334);
const BASE = process.env.BASE_URL || "http://localhost:3000";
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
  const userDataDir = path.join(os.tmpdir(), `pakp-phase6a-${Date.now()}`);
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
      const file = path.join(OUT, `phase6a-${name}.png`);
      await mkdir(OUT, { recursive: true });
      await writeFile(file, Buffer.from(data, "base64"));
      console.log(`[shot] ${path.relative(ROOT, file)}`);
      return file;
    },
    /** 真实鼠标点击：React 的 onClick 走指针事件，element.click() 不够稳。 */
    async clickSelector(selector, textPattern) {
      const point = await page.evaluate(`(() => {
        const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
        const matcher = ${JSON.stringify(textPattern ?? null)};
        const node = matcher
          ? nodes.find((item) => new RegExp(matcher).test(item.textContent || ""))
          : nodes[0];
        if (!node) return null;
        node.scrollIntoView({ block: "center" });
        const rect = node.getBoundingClientRect();
        if (!rect.width || !rect.height) return null;
        return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      })()`);

      if (!point) return false;
      for (const type of ["mousePressed", "mouseReleased"]) {
        await page.send("Input.dispatchMouseEvent", {
          type,
          x: point.x,
          y: point.y,
          button: "left",
          buttons: 1,
          clickCount: 1,
        });
      }
      return true;
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

async function openCreateDialog(page) {
  console.log("[step] open create dialog");
  await page.goto(`${BASE}/workspace`);
  console.log("[step] workspace loaded:", await page.waitFor("document.querySelector('.record-row')", 30000));
  console.log("[step] click 新建:", await page.clickSelector("button", "新建"));
  console.log("[step] dialog open:", await page.waitFor("Boolean(document.querySelector('.dialog-form'))", 8000));
  await sleep(500);
}

async function capture(browser) {
  const problems = [];

  console.log("[step] 1. 新建弹窗（桌面）");
  // 1. 新建弹窗（桌面）：类型 → 标题 → 分类 → 标签 → 放在哪里 → 说明
  {
    const page = await openPage(browser.cdp);
    await page.setViewport(VIEWPORTS.desktop);
    await openCreateDialog(page);
    await page.screenshot("create-desktop");
    problems.push(...page.consoleErrors.map((e) => `create-desktop console: ${e}`));
    problems.push(...page.pageErrors.map((e) => `create-desktop page: ${e}`));
    await page.close();
  }

  console.log("[step] 2. 新建弹窗（390×844）");
  // 2. 新建弹窗（390×844），并检查横向溢出
  {
    const page = await openPage(browser.cdp);
    await page.setViewport(VIEWPORTS.mobile);
    await openCreateDialog(page);
    await page.screenshot("create-mobile");
    const overflow = await page
      .evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
      .catch(() => 0);
    if (overflow > 1) problems.push(`create-mobile 横向溢出 ${overflow}px`);
    problems.push(...page.consoleErrors.map((e) => `create-mobile console: ${e}`));
    problems.push(...page.pageErrors.map((e) => `create-mobile page: ${e}`));
    await page.close();
  }

  console.log("[step] 3. 分类选择器的「自定义」小弹窗");
  // 3. 分类选择器的「自定义」小弹窗
  {
    const page = await openPage(browser.cdp);
    await page.setViewport(VIEWPORTS.desktop);
    await openCreateDialog(page);
    await page.clickSelector('[aria-label="自定义新建分类"]');
    await page.waitFor('document.querySelector(\'[aria-label="自定义（分类）"]\')', 8000);
    await sleep(400);
    await page.screenshot("picker-custom-category");
    problems.push(...page.consoleErrors.map((e) => `picker-custom-category console: ${e}`));
    problems.push(...page.pageErrors.map((e) => `picker-custom-category page: ${e}`));
    await page.close();
  }

  console.log("[step] 4. 标签选择器的「自定义」小弹窗");
  // 4. 标签选择器的「自定义」小弹窗
  {
    const page = await openPage(browser.cdp);
    await page.setViewport(VIEWPORTS.desktop);
    await openCreateDialog(page);
    await page.clickSelector('[aria-label="自定义新建标签"]');
    await page.waitFor('document.querySelector(\'[aria-label="自定义（标签）"]\')', 8000);
    await sleep(400);
    await page.screenshot("picker-custom-tag");
    problems.push(...page.consoleErrors.map((e) => `picker-custom-tag console: ${e}`));
    problems.push(...page.pageErrors.map((e) => `picker-custom-tag page: ${e}`));
    await page.close();
  }

  console.log("[step] 5. 编辑弹窗：打开第一条内容 → 编辑");
  // 5. 编辑弹窗：打开第一条内容 → 编辑
  {
    const page = await openPage(browser.cdp);
    await page.setViewport(VIEWPORTS.desktop);
    await page.goto(`${BASE}/workspace`);
    await page.waitFor("document.querySelector('.record-row')", 30000);
    // 优先挑一条中文标题正常的作品，避免历史脏数据影响截图可读性。
    const picked = await page.clickSelector(".record-row", "个人知识系统的搭建方法");
    if (!picked) await page.clickSelector(".record-row");
    await page.waitFor("document.querySelector('.object-more')", 15000);
    await sleep(400);
    await page.clickSelector(".object-more");
    // 面板展开后底部才有「编辑」。
    await page.waitFor("document.querySelector('.object-panel-foot')", 15000);
    await sleep(400);
    const editPoint = await page.evaluate(`(() => {
      const node = [...document.querySelectorAll('.object-panel-foot button, .object-panel-foot .text-button')]
        .find((item) => (item.textContent || '').trim() === '编辑');
      if (!node) return false;
      node.scrollIntoView({ block: 'center' });
      return true;
    })()`);
    const opened = editPoint ? await page.clickSelector(".object-panel-foot button", "^\\s*编辑\\s*$") : false;
    await page.waitFor("Boolean(document.querySelector('.dialog-form'))", 8000);
    await sleep(500);
    await page.screenshot("edit-desktop");
    if (!opened) problems.push("edit-desktop: 没找到「编辑」按钮");
    problems.push(...page.consoleErrors.map((e) => `edit-desktop console: ${e}`));
    problems.push(...page.pageErrors.map((e) => `edit-desktop page: ${e}`));
    await page.close();
  }

  console.log("[step] 6. 分类管理页");
  // 6. 分类管理页
  {
    const page = await openPage(browser.cdp);
    await page.setViewport(VIEWPORTS.desktop);
    await page.goto(`${BASE}/admin/vocabulary/categories`);
    await page.waitFor("document.querySelector('table, .vocab-table, main')", 25000);
    await sleep(1200);
    await page.screenshot("categories-admin");
    const text = await page.evaluate("document.body.innerText.includes('管理分类')");
    if (!text) problems.push("categories-admin: 页面标题不是「管理分类」");
    problems.push(...page.consoleErrors.map((e) => `categories-admin console: ${e}`));
    problems.push(...page.pageErrors.map((e) => `categories-admin page: ${e}`));
    await page.close();
  }

  console.log("[step] 7. 详情页的分类元信息");
  // 7. 详情页的分类元信息
  {
    const page = await openPage(browser.cdp);
    await page.setViewport(VIEWPORTS.desktop);
    await page.goto(`${BASE}/workspace`);
    await page.waitFor("document.querySelector('.record-row')", 25000);
    const picked = await page.clickSelector(".record-row", "个人知识系统的搭建方法");
    if (!picked) await page.clickSelector(".record-row");
    await sleep(900);
    await page.screenshot("detail-category");
    const hasCategory = await page.evaluate(
      "(document.body.innerText.match(/分类/g) || []).length > 0",
    );
    if (!hasCategory) problems.push("detail-category: 详情里没有分类字样");
    problems.push(...page.consoleErrors.map((e) => `detail-category console: ${e}`));
    problems.push(...page.pageErrors.map((e) => `detail-category page: ${e}`));
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
  console.log(`[phase6a] ${problems.length} 个问题`);
  for (const problem of problems) console.log(`  - ${problem}`);
  process.exitCode = 2;
} else {
  console.log("[phase6a] 截图完成，无 console / page 错误，无横向溢出");
}
