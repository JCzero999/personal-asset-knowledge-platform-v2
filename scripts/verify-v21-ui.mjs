/**
 * v2.1 第一批界面修复的实机验收（隔离实例）。
 *
 * 用法：node scripts/verify-v21-ui.mjs
 *
 * 独立端口 3132 + 独立 dist 目录 .next-v21 + 临时数据库 + AUTH_MODE=mock，
 * 不碰 data/app.db，也不碰 3000 上的生产包。跑完自动清理进程与临时库。
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

const ROOT = path.resolve(import.meta.dirname, "..");
const NEXT_BIN = path.join(ROOT, "node_modules/next/dist/bin/next");
const CHROME = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
].find((candidate) => existsSync(candidate));

const APP_PORT = Number(process.env.APP_PORT || 3132);
const CDP_PORT = Number(process.env.CDP_PORT || 9350);
const BASE = `http://localhost:${APP_PORT}`;
const OWNER_SUB = "mock-local-user";
const SHOTS = process.env.SHOT_DIR || path.join(os.tmpdir(), "pakp-v21-shots");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const problems = [];
const facts = {};
const note = (label, value) => {
  facts[label] = value;
  console.log(`[fact] ${label}:`, typeof value === "string" ? value : JSON.stringify(value));
};

/* ------------------------------ 夹具 ------------------------------ */

const NOW = new Date();
const iso = (daysAgo) => new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString();

const OBJECTS = [
  // 作品只存在于外库且必须有分类（ADR-029 / schema check）。
  { id: "a0000000-0000-4000-8000-000000000001", type: "work", title: "产品体验复盘", status: "draft", library: "external", days: 1 },
  { id: "a0000000-0000-4000-8000-000000000002", type: "work", title: "设计系统手册", status: "finished", library: "external", days: 3 },
  // 外库资产：未评分，落在「待人工复核」。
  { id: "a0000000-0000-4000-8000-000000000003", type: "asset", title: "竞品调研笔记", status: null, library: "external", days: 2, ai: { status: "needs_review", score: 68 } },
  // 内库资产：必须有五维分与等级，否则 schema 不过。
  { id: "a0000000-0000-4000-8000-000000000004", type: "asset", title: "可复用组件清单", status: null, library: "internal", days: 9, value: { level: "A", scores: '{"value":4,"reuse":5,"depth":4,"freshness":3,"actionability":4}' } },
];

const CATEGORY = { code: "product", label: "产品", normalized: "产品" };

async function seedDatabase(file) {
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("busy_timeout = 5000");
  migrate(drizzle(sqlite), { migrationsFolder: path.join(ROOT, "drizzle") });

  const insertCategory = sqlite.prepare(`
    insert into categories (code, label, normalized, sort_order, state, is_system, created_at, updated_at)
    values (?, ?, ?, 1, 'active', 0, ?, ?)
  `);
  const insert = sqlite.prepare(`
    insert into objects
      (id, type, title, description, library, source, origin, category_code, priority,
       owner_sub, status, ai_status, ai_score, value_level, value_scores,
       value_assessed_at, created_at, updated_at)
    values (?, ?, ?, ?, ?, 'handwritten', 'self', ?, 'medium', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const run = sqlite.transaction(() => {
    insertCategory.run(CATEGORY.code, CATEGORY.label, CATEGORY.normalized, iso(30), iso(30));
    for (const object of OBJECTS) {
      insert.run(
        object.id,
        object.type,
        object.title,
        `${object.title}（v2.1 验收夹具）`,
        object.library,
        object.type === "work" ? CATEGORY.code : null,
        OWNER_SUB,
        object.status,
        object.ai?.status ?? null,
        object.ai?.score ?? null,
        object.value?.level ?? null,
        object.value?.scores ?? null,
        object.value ? iso(object.days) : null,
        iso(object.days),
        iso(object.days),
      );
    }
  });
  run();
  sqlite.close();
}

/* ------------------------------ 进程 ------------------------------ */

function portInUse(port) {
  return new Promise((resolve) => {
    fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(600) })
      .then(() => resolve(true))
      .catch(() => resolve(false));
  });
}

async function waitForServer(url, timeoutMs = 180000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return;
    } catch {
      // 还在编译
    }
    await sleep(400);
  }
  throw new Error(`等待 ${url} 超时`);
}

async function startApp({ dbFile }) {
  if (await portInUse(APP_PORT)) throw new Error(`端口 ${APP_PORT} 已被占用`);
  const child = spawn(process.execPath, [NEXT_BIN, "dev", "-p", String(APP_PORT)], {
    cwd: ROOT,
    env: {
      ...process.env,
      AUTH_MODE: "mock",
      DATABASE_PATH: dbFile,
      NEXT_DIST_DIR: ".next-v21",
      NEXT_TELEMETRY_DISABLED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const logs = [];
  const collect = (chunk) => {
    logs.push(chunk.toString());
    if (logs.length > 400) logs.shift();
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  try {
    await waitForServer(`${BASE}/api/health`);
  } catch (error) {
    throw new Error(`${error.message}\n${logs.join("").slice(-3000)}`);
  }
  return { child, logs };
}

async function stopApp(app) {
  if (!app) return;
  spawn("taskkill", ["/pid", String(app.child.pid), "/T", "/F"], {
    stdio: "ignore",
    windowsHide: true,
  });
  const started = Date.now();
  while (Date.now() - started < 20000) {
    try {
      await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(800) });
    } catch {
      return;
    }
    await sleep(250);
  }
}

/* ------------------------------ CDP ------------------------------ */

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
  const userDataDir = path.join(os.tmpdir(), `pakp-v21-chrome-${Date.now()}`);
  const child = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--hide-scrollbars",
      "about:blank",
    ],
    { stdio: "ignore", windowsHide: true },
  );
  const version = await waitForEndpoint(`http://127.0.0.1:${CDP_PORT}/json/version`);
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  return { child, cdp: new Cdp(ws) };
}

async function openPage(cdp) {
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const page = {
    sessionId,
    consoleErrors: [],
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
        setTimeout(resolve, 20000);
      });
      await cdp.send("Page.navigate", { url }, sessionId);
      await loaded;
    },
    async waitFor(expression, timeoutMs = 60000, intervalMs = 150) {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        try {
          if (await page.evaluate(expression)) return true;
        } catch {
          // 页面还在导航
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
      await mkdir(SHOTS, { recursive: true });
      const file = path.join(SHOTS, `${name}.png`);
      await writeFile(file, Buffer.from(data, "base64"));
      console.log(`[shot] ${file}`);
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
      params.args.map((arg) => arg.description ?? arg.value ?? "").join(" ").slice(0, 300),
    );
  });
  return page;
}

/* ------------------------------ 断言工具 ------------------------------ */

async function moveMouse(page, x, y, extra = {}) {
  await page.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: Math.round(x),
    y: Math.round(y),
    button: extra.button ?? "none",
    buttons: extra.buttons ?? 0,
    clickCount: 0,
    pointerType: "mouse",
  });
}

async function click(page, x, y) {
  await moveMouse(page, x, y);
  await page.send("Input.dispatchMouseEvent", {
    type: "mousePressed", x: Math.round(x), y: Math.round(y),
    button: "left", buttons: 1, clickCount: 1, pointerType: "mouse",
  });
  await page.send("Input.dispatchMouseEvent", {
    type: "mouseReleased", x: Math.round(x), y: Math.round(y),
    button: "left", buttons: 0, clickCount: 1, pointerType: "mouse",
  });
  await sleep(500);
}

async function pressKey(page, key, code, vk) {
  await page.send("Input.dispatchKeyEvent", {
    type: "keyDown", key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
  });
  await page.send("Input.dispatchKeyEvent", {
    type: "keyUp", key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
  });
  await sleep(200);
}

const LAYOUT = `(() => {
  const rect = (selector) => {
    const el = document.querySelector(selector);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), right: Math.round(r.right) };
  };
  const frame = document.querySelector('.app-frame.has-list');
  return {
    viewport: { w: innerWidth, h: innerHeight },
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    frame: rect('.app-frame.has-list'),
    list: rect('.record-list'),
    detail: rect('.record-detail'),
    resizer: rect('.list-resizer'),
    resizerDisplay: (() => {
      const el = document.querySelector('.list-resizer');
      return el ? getComputedStyle(el).display : null;
    })(),
    listWidthVar: frame ? getComputedStyle(frame).getPropertyValue('--list-width').trim() : null,
    rows: document.querySelectorAll('.record-row-item').length,
    stored: (() => {
      try { return localStorage.getItem('pakp.workspace.list-width'); } catch { return null; }
    })(),
  };
})()`;

const DIR_METRICS = `(() => {
  const groups = [...document.querySelectorAll('.dir-group')];
  const pick = (label) => {
    const group = groups.find((item) => item.querySelector('.dir-label')?.textContent?.trim() === label);
    if (!group) return null;
    const items = [...group.querySelectorAll('.dir-item')].map((el) => ({
      label: el.querySelector('.dir-item-label')?.textContent?.trim(),
      left: Math.round(el.getBoundingClientRect().left),
      paddingLeft: Math.round(parseFloat(getComputedStyle(el).paddingLeft)),
      nested: group.classList.contains('is-nested'),
    }));
    return { nested: group.classList.contains('is-nested'), items };
  };
  return {
    browse: pick('浏览'),
    track: pick('作品进程'),
    taxonomy: pick('分类与标签'),
    account: pick('账号'),
  };
})()`;

/* ------------------------------ 主流程 ------------------------------ */

async function main() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pakp-v21-"));
  const dbFile = path.join(dir, "v21.db");
  await seedDatabase(dbFile);
  await mkdir(SHOTS, { recursive: true });

  let app = null;
  let browser = null;

  try {
    app = await startApp({ dbFile });
    browser = await launchBrowser();
    const page = await openPage(browser.cdp);

    /* ---------- 1440：工作台列表 + 目录 ---------- */
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(`${BASE}/workspace`);
    await page.waitFor("Boolean(document.querySelector('.record-row-item'))", 120000);
    await sleep(600);

    const layout = await page.evaluate(LAYOUT);
    note("1440 布局", layout);
    if (layout.rows !== 4) problems.push(`列表应有 4 行，实际 ${layout.rows}`);
    if (layout.overflow > 0) problems.push(`1440 横向溢出 ${layout.overflow}`);
    if (Math.abs(layout.list.w - 340) > 1) problems.push(`列表默认宽度 ${layout.list.w}（应为 340）`);
    if (!layout.resizer || layout.resizerDisplay === "none") problems.push("1440 分隔条不可见");

    // 目录缩进：管理分类 / 管理标签 / 用户 / 角色 与作品进程同深度
    const dirs = await page.evaluate(DIR_METRICS);
    note("目录缩进", dirs);
    const stageLeft = dirs.track?.items?.[0]?.left;
    const targets = [
      ["管理分类", dirs.taxonomy?.items?.[0]],
      ["管理标签", dirs.taxonomy?.items?.[1]],
      ["用户", dirs.account?.items?.[0]],
      ["角色", dirs.account?.items?.[1]],
    ];
    if (stageLeft === undefined) problems.push("找不到作品进程分组");
    for (const [label, item] of targets) {
      if (!item) {
        problems.push(`目录里没有「${label}」`);
        continue;
      }
      if (item.left !== stageLeft) {
        problems.push(`「${label}」缩进 ${item.left} 与作品进程 ${stageLeft} 不一致`);
      }
    }
    if (dirs.browse?.items?.[0] && dirs.browse.items[0].left >= stageLeft) {
      problems.push("一级条目没有比二级更深（缩进方向反了）");
    }

    await page.screenshot("v21-workspace-1440");

    /* ---------- 类型快捷筛选 ---------- */
    const typeSwitch = await page.evaluate(`(() => {
      const el = document.querySelector('.type-switch');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        options: [...el.querySelectorAll('.type-option')].map((a) => ({
          label: a.textContent.trim(),
          href: a.getAttribute('href'),
          active: a.classList.contains('is-active'),
        })),
        right: Math.round(r.right),
        bottom: Math.round(r.bottom),
        listTop: Math.round(document.querySelector('.record-bulk').getBoundingClientRect().top),
      };
    })()`);
    note("类型快捷筛选", typeSwitch);
    if (!typeSwitch) problems.push("列表工具条没有类型快捷筛选");
    else {
      if (typeSwitch.options.length !== 3) problems.push(`类型快捷筛选应有 3 项，实际 ${typeSwitch.options.length}`);
      if (!typeSwitch.options[0].active) problems.push("默认应高亮「全部」");
      if (typeSwitch.bottom > typeSwitch.listTop) problems.push("类型筛选跑到批量条下面了");
      if (typeSwitch.options[2].href !== "/workspace?type=work") {
        problems.push(`「作品」链接不对：${typeSwitch.options[2].href}`);
      }
    }

    await page.evaluate(`document.querySelectorAll('.type-option')[1].click()`);
    await sleep(1200);
    const filtered = await page.evaluate(LAYOUT);
    const filteredUrl = await page.evaluate("location.search");
    note("点「资产」后", { url: filteredUrl, rows: filtered.rows });
    if (!/type=asset/.test(filteredUrl)) problems.push(`点「资产」没写进 URL：${filteredUrl}`);
    if (filtered.rows !== 2) problems.push(`按资产筛选应剩 2 行，实际 ${filtered.rows}`);
    const activeAfter = await page.evaluate(
      `[...document.querySelectorAll('.type-option')].map((a) => a.classList.contains('is-active'))`,
    );
    if (!activeAfter[1] || activeAfter[0]) problems.push(`「资产」项没有变成高亮：${JSON.stringify(activeAfter)}`);

    // 刷新后仍是资产筛选
    await page.goto(`${BASE}/workspace?type=asset`);
    await page.waitFor("Boolean(document.querySelector('.record-row-item'))", 60000);
    const afterReload = await page.evaluate(LAYOUT);
    note("刷新后行数", afterReload.rows);
    if (afterReload.rows !== 2) problems.push(`刷新后筛选丢了：${afterReload.rows} 行`);

    /* ---------- 拖拽分栏 ---------- */
    await page.goto(`${BASE}/workspace`);
    await page.waitFor("Boolean(document.querySelector('.record-row-item'))", 60000);
    await sleep(400);
    await page.evaluate(`localStorage.removeItem('pakp.workspace.list-width')`);
    await page.goto(`${BASE}/workspace`);
    await page.waitFor("Boolean(document.querySelector('.record-row-item'))", 60000);
    await sleep(400);

    const before = await page.evaluate(LAYOUT);
    const startX = before.resizer.x + before.resizer.w / 2;
    const startY = before.resizer.y + Math.round(before.resizer.h * 0.35);
    await moveMouse(page, startX, startY);
    await page.send("Input.dispatchMouseEvent", {
      type: "mousePressed", x: startX, y: startY, button: "left", buttons: 1, clickCount: 1, pointerType: "mouse",
    });
    for (const dx of [30, 70, 120]) {
      await page.send("Input.dispatchMouseEvent", {
        type: "mouseMoved", x: startX + dx, y: startY, button: "left", buttons: 1, pointerType: "mouse",
      });
      await sleep(60);
    }
    await page.send("Input.dispatchMouseEvent", {
      type: "mouseReleased", x: startX + 120, y: startY, button: "left", buttons: 0, clickCount: 1, pointerType: "mouse",
    });
    await sleep(400);

    const dragged = await page.evaluate(LAYOUT);
    note("拖到 +120 后", {
      listWidth: dragged.list.w,
      detailWidth: dragged.detail.w,
      variable: dragged.listWidthVar,
      stored: dragged.stored,
    });
    if (Math.abs(dragged.list.w - (before.list.w + 120)) > 3) {
      problems.push(`拖动后列表宽 ${dragged.list.w}（期望 ${before.list.w + 120}）`);
    }
    if (dragged.detail.w >= before.detail.w - 100) {
      problems.push(`详情列没有让位：${before.detail.w} → ${dragged.detail.w}`);
    }
    if (Math.abs(Number.parseInt(dragged.stored ?? "0", 10) - dragged.list.w) > 3) {
      problems.push(`宽度没存进 localStorage：${dragged.stored}`);
    }
    await page.screenshot("v21-splitter-dragged-1440");

    // 刷新后保留
    await page.goto(`${BASE}/workspace`);
    await page.waitFor("Boolean(document.querySelector('.record-row-item'))", 60000);
    await sleep(500);
    const reloaded = await page.evaluate(LAYOUT);
    note("刷新后列表宽", reloaded.list.w);
    if (Math.abs(reloaded.list.w - dragged.list.w) > 3) {
      problems.push(`刷新后宽度没保留：${reloaded.list.w} vs ${dragged.list.w}`);
    }

    // 键盘调整
    await page.evaluate(`document.querySelector('.list-resizer').focus()`);
    await pressKey(page, "ArrowLeft", "ArrowLeft", 37);
    const keyboarded = await page.evaluate(LAYOUT);
    note("键盘 ← 后列表宽", keyboarded.list.w);
    if (keyboarded.list.w !== reloaded.list.w - 16) {
      problems.push(`键盘 ← 没按 16px 调整：${reloaded.list.w} → ${keyboarded.list.w}`);
    }

    // 上限：拖到很远
    await page.evaluate(`(() => {
      const el = document.querySelector('.list-resizer');
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: r.left + 3, clientY: r.top + 40, button: 0, pointerId: 1 }));
    })()`);
    await page.evaluate(`(() => {
      const el = document.querySelector('.list-resizer');
      const r = el.getBoundingClientRect();
      el.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: r.left + 900, clientY: r.top + 40, button: 0, pointerId: 1 }));
      el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: r.left + 900, clientY: r.top + 40, button: 0, pointerId: 1 }));
    })()`);
    await sleep(300);
    const capped = await page.evaluate(LAYOUT);
    note("拖到极限", { listWidth: capped.list.w, variable: capped.listWidthVar });
    if (capped.list.w > 561) problems.push(`宽度上限失效：${capped.list.w}`);

    // 双击复位
    await page.evaluate(`(() => {
      const el = document.querySelector('.list-resizer');
      el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    })()`);
    await sleep(300);
    const reset = await page.evaluate(LAYOUT);
    note("双击复位", reset.list.w);
    if (Math.abs(reset.list.w - 340) > 1) problems.push(`双击没复位到 340：${reset.list.w}`);

    /* ---------- 首页指标 ---------- */
    const overview = await page.evaluate(`(() => {
      const items = [...document.querySelectorAll('.overview-item')];
      return {
        total: items.length,
        links: items.filter((el) => el.tagName === 'A').length,
        cards: items.map((el) => ({
          label: el.querySelector('.overview-copy span')?.textContent?.trim(),
          href: el.getAttribute('href'),
          tag: el.tagName,
        })),
      };
    })()`);
    note("首页指标", overview);
    if (overview.total !== 5) problems.push(`首页指标应有 5 个，实际 ${overview.total}`);
    if (overview.links !== 5) problems.push(`可点指标只有 ${overview.links} 个`);
    const expectedHref = {
      全部内容: "/workspace",
      资产: "/workspace?type=asset",
      作品: "/workspace?type=work",
      本周新增: "/workspace?added=7d",
    };
    for (const card of overview.cards) {
      const want = expectedHref[card.label];
      if (want && card.href !== want) problems.push(`「${card.label}」链接 ${card.href}（期望 ${want}）`);
      if (card.label === "待人工复核" && !/needs_review|review/.test(card.href ?? "")) {
        problems.push(`「待人工复核」链接退化了：${card.href}`);
      }
    }
    await page.screenshot("v21-overview-1440");

    // 点「作品」卡片
    await page.evaluate(`(() => {
      const card = [...document.querySelectorAll('.overview-item')].find((el) => el.querySelector('.overview-copy span')?.textContent?.trim() === '作品');
      card.click();
    })()`);
    await sleep(1200);
    const metricUrl = await page.evaluate("location.search");
    const metricRows = await page.evaluate("document.querySelectorAll('.record-row-item').length");
    note("点「作品」指标", { url: metricUrl, rows: metricRows });
    if (!/type=work/.test(metricUrl)) problems.push(`指标卡没带筛选跳转：${metricUrl}`);
    if (metricRows !== 2) problems.push(`作品指标应剩 2 行，实际 ${metricRows}`);

    /* ---------- 编辑器：顺序、默认 Markdown、双栏同步 ---------- */
    await page.goto(`${BASE}/workspace/a0000000-0000-4000-8000-000000000001`);
    await page.waitFor("Boolean(document.querySelector('.content-section, .object-content'))", 60000).catch(() => {});
    await sleep(800);
    const openedEditor = await page.evaluate(`(() => {
      const buttons = [...document.querySelectorAll('button')];
      const target = buttons.find((el) => el.textContent.trim() === '编写正文');
      if (!target) return false;
      target.click();
      return true;
    })()`);
    if (!openedEditor) problems.push("对象详情里找不到「编写正文」按钮");
    await sleep(800);

    const editor = await page.evaluate(`(() => {
      const dialog = document.querySelector('[role="dialog"]');
      if (!dialog) return null;
      const modes = [...dialog.querySelectorAll('button[aria-pressed]')].map((el) => ({
        label: el.textContent.trim(),
        pressed: el.getAttribute('aria-pressed') === 'true',
      }));
      return {
        modes,
        hasWrite: Boolean(dialog.querySelector('textarea')),
        hasPreview: Boolean(dialog.querySelector('.markdown-empty, .previewScroll, [class*="previewScroll"]')),
        buttons: [...dialog.querySelectorAll('button')].map((el) => el.textContent.trim()).slice(0, 8),
      };
    })()`);
    note("编辑器弹窗", editor);
    if (!editor) problems.push("编辑器弹窗没打开");
    else {
      if (editor.modes[0]?.label !== "Markdown") problems.push(`类型顺序不对：${JSON.stringify(editor.modes)}`);
      if (!editor.modes[0]?.pressed) problems.push("新建正文没有默认 Markdown");
    }

    if (editor && !editor.modes[0]?.pressed === false) {
      // 灌入长文档，验证双向滚动同步
      await page.evaluate(`document.querySelector('[role="dialog"] textarea').focus()`);
      const longDoc = Array.from({ length: 90 }, (_, index) => `## 第 ${index + 1} 节\n\n这一节用来把预览栏撑长，验证左右两边滚动是否同步。\n`).join("\n");
      await page.send("Input.insertText", { text: longDoc });
      await sleep(600);

      const sync = await page.evaluate(`(() => {
        const dialog = document.querySelector('[role="dialog"]');
        const write = dialog.querySelector('textarea');
        const preview = dialog.querySelector('[class*="previewScroll"]');
        write.scrollTop = Math.round((write.scrollHeight - write.clientHeight) * 0.5);
        return {
          writeMax: write.scrollHeight - write.clientHeight,
          previewMax: preview ? preview.scrollHeight - preview.clientHeight : 0,
        };
      })()`);
      await sleep(400);
      const afterWrite = await page.evaluate(`(() => {
        const dialog = document.querySelector('[role="dialog"]');
        return {
          write: Math.round(dialog.querySelector('textarea').scrollTop),
          preview: Math.round(dialog.querySelector('[class*="previewScroll"]').scrollTop),
        };
      })()`);
      note("拖动左侧 → 右侧", { ...sync, ...afterWrite });
      if (afterWrite.preview <= 0) problems.push("左侧滚动没有带动右侧预览");

      await page.evaluate(`(() => {
        const dialog = document.querySelector('[role="dialog"]');
        const preview = dialog.querySelector('[class*="previewScroll"]');
        preview.scrollTop = 0;
      })()`);
      await sleep(400);
      const afterPreview = await page.evaluate(`(() => {
        const dialog = document.querySelector('[role="dialog"]');
        return {
          write: Math.round(dialog.querySelector('textarea').scrollTop),
          preview: Math.round(dialog.querySelector('[class*="previewScroll"]').scrollTop),
        };
      })()`);
      note("拖动右侧 → 左侧", afterPreview);
      if (afterPreview.write > 40) problems.push(`右侧滚回顶部后左侧没跟上：${afterPreview.write}`);

      await page.screenshot("v21-editor-1440");
    }

    /* ---------- 390 窄屏 ---------- */
    await page.setViewport({ width: 390, height: 844, dpr: 2, mobile: true });
    await page.goto(`${BASE}/workspace`);
    await page.waitFor("Boolean(document.querySelector('.record-row-item'))", 60000);
    await sleep(600);
    const mobile = await page.evaluate(`(() => {
      const sw = document.querySelector('.type-switch');
      const r = sw ? sw.getBoundingClientRect() : null;
      return {
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        viewport: innerWidth,
        typeSwitch: r ? { left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width) } : null,
        resizer: (() => {
          const el = document.querySelector('.list-resizer');
          return el ? getComputedStyle(el).display : null;
        })(),
        directory: (() => {
          const el = document.querySelector('.directory');
          return el ? getComputedStyle(el).display : null;
        })(),
        rows: document.querySelectorAll('.record-row-item').length,
      };
    })()`);
    note("390 窄屏", mobile);
    if (mobile.overflow > 0) problems.push(`390 横向溢出 ${mobile.overflow}`);
    if (!mobile.typeSwitch) problems.push("窄屏看不到类型快捷筛选");
    else if (mobile.typeSwitch.right > mobile.viewport) {
      problems.push(`类型筛选溢出：右缘 ${mobile.typeSwitch.right} > ${mobile.viewport}`);
    }
    if (mobile.resizer !== "none") problems.push(`窄屏分隔条应隐藏，实际 ${mobile.resizer}`);
    await page.screenshot("v21-workspace-390");

    if (page.consoleErrors.length) {
      const noisy = page.consoleErrors.filter((line) => !/favicon|Download the React DevTools/.test(line));
      if (noisy.length) problems.push(`控制台报错：${noisy.slice(0, 3).join(" | ")}`);
    }
  } finally {
    await stopApp(app);
    if (browser) {
      await browser.cdp.send("Browser.close").catch(() => {});
      try { browser.child.kill(); } catch { /* 已退出 */ }
    }
  }

  console.log("\n===== 结论 =====");
  if (problems.length) {
    for (const problem of problems) console.log(`FAIL ${problem}`);
    process.exitCode = 1;
  } else {
    console.log("全部断言通过");
  }
  console.log(`截图目录：${SHOTS}`);
}

await main();
