/**
 * v2.1 第二批（返工 added + A–F）实机验收（隔离实例）。
 *
 * 用法：node scripts/verify-v21-batch2.mjs
 * 独立端口 3133 + 独立 dist 目录 .next-v21b2 + 临时库 + AUTH_MODE=mock，
 * 不碰 data/app.db，也不碰 3000 上的生产包。
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
].find((candidate) => existsSync(candidate));

const APP_PORT = Number(process.env.APP_PORT || 3133);
const CDP_PORT = Number(process.env.CDP_PORT || 9351);
const BASE = `http://localhost:${APP_PORT}`;
const OWNER_SUB = "mock-local-user";
const SHOTS = process.env.SHOT_DIR || path.join(os.tmpdir(), "pakp-v21b2-shots");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const problems = [];
const note = (label, value) => {
  console.log(`[fact] ${label}:`, typeof value === "string" ? value : JSON.stringify(value));
};

/* ------------------------------ 夹具 ------------------------------ */

const NOW = new Date();
const iso = (daysAgo, hoursAgo = 0) =>
  new Date(NOW.getTime() - daysAgo * 86_400_000 - hoursAgo * 3_600_000).toISOString();

const WORK_ID = "b0000000-0000-4000-8000-000000000001";
const ASSET_MAIN = "b0000000-0000-4000-8000-000000000002";
const ASSET_LOCKED = "b0000000-0000-4000-8000-000000000003";
const ASSET_OLD = "b0000000-0000-4000-8000-000000000004";
const ASSET_EXTERNAL = "b0000000-0000-4000-8000-000000000005";

const SCORES_A = JSON.stringify({
  source: "model",
  assessedAt: iso(2),
  dimensions: [
    { key: "practice", score: 4, reason: "已在两个项目里验证" },
    { key: "reuse", score: 5, reason: "每季度都会用到" },
    { key: "transferability", score: 4 },
    { key: "uniqueness", score: 3 },
    { key: "timeliness", score: 3 },
  ],
});

const SCORES_C = JSON.stringify({ source: "fallback", assessedAt: iso(4), dimensions: [] });

const SNAPSHOT = [
  "## 产品体验复盘",
  "",
  "这次改版的核心是把「能用」推进到「顺手」：目录、列表、详情三列的密度重新分配，",
  "把最常做的三件事（找内容、看正文、判断价值）各自缩短一步。",
  "",
  "真实的反馈里，用户最常抱怨的是「不知道自己在哪个库里」，所以这一版把类型筛选提到",
  "了工具条上方，并把归属做成了一级目录。后续还打算把沉淀后的正文快照直接展示出来，",
  "省掉「点开原作品再翻一遍」这一步。",
  "",
  "这一段专门写长，用来验证快照区块只截前 300 字并补省略号，而不是整段铺满详情页。",
  "再补几句让总长度明确超过三百个字，避免因为短文本让断言形同虚设。",
  "用户在同一份资料里反复找的是那些「上次看过、这次要用」的结论，所以快照要保留最开头",
  "那段结论性的判断，而不是把整篇原文搬进详情页。",
  "另外，快照只在沉淀时生成一次，原文后来改了，这里也不会跟着变，正好用来判断是否对得上。",
  "最后一句：如果这里被完整显示，说明截断逻辑没生效。",
].join("\n");

const CATEGORY = { code: "product", label: "产品", normalized: "产品" };

async function seedDatabase(file) {
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("busy_timeout = 5000");
  migrate(drizzle(sqlite), { migrationsFolder: path.join(ROOT, "drizzle") });

  sqlite
    .prepare(
      `insert into categories (code, label, normalized, sort_order, state, is_system, created_at, updated_at)
       values (?, ?, ?, 1, 'active', 0, ?, ?)`,
    )
    .run(CATEGORY.code, CATEGORY.label, CATEGORY.normalized, iso(40), iso(40));

  const insert = sqlite.prepare(`
    insert into objects
      (id, type, title, description, library, source, origin, category_code, priority,
       owner_sub, status, ai_status, ai_score, value_level, value_scores,
       value_assessed_at, value_level_locked, use_count, last_used_at,
       content_snapshot, content_snapshot_at, origin_work_id, created_at, updated_at)
    values (?, ?, ?, ?, ?, 'handwritten', 'self', ?, 'medium', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const run = sqlite.transaction(() => {
    insert.run(
      WORK_ID, "work", "设计系统手册", "一篇成形的作品",
      "external", CATEGORY.code, OWNER_SUB, "draft",
      null, null, null, null, null,
      0, 0, null, null, null, null,
      iso(1), iso(1),
    );
    insert.run(
      ASSET_MAIN, "asset", "产品体验复盘 · 沉淀", "从作品沉淀出的内库资产",
      "internal", null, OWNER_SUB, null,
      null, null, "A", SCORES_A,
      iso(2), 0, 3, iso(1),
      SNAPSHOT, iso(2), WORK_ID,
      iso(2), iso(1),
    );
    insert.run(
      ASSET_LOCKED, "asset", "待重评的低价值资产", "用来验证锁定与批量重评",
      "internal", null, OWNER_SUB, null,
      null, null, "C", SCORES_C,
      iso(4), 1, 0, null,
      null, null, null,
      iso(4), iso(4),
    );
    insert.run(
      ASSET_OLD, "asset", "两周前的旧笔记", "应被 added=7d 排除",
      "external", null, OWNER_SUB, null,
      "auto_pass", 82, null, null,
      null, 0, 0, null,
      null, null, null,
      iso(14), iso(14),
    );
    insert.run(
      ASSET_EXTERNAL, "asset", "待复核的外部资料", "外库资产，没有价值面板",
      "external", null, OWNER_SUB, null,
      "needs_review", 68, null, null,
      null, 0, 0, null,
      null, null, null,
      iso(2), iso(2),
    );
  });
  run();

  const history = sqlite.prepare(`
    insert into value_assessment_history
      (id, asset_id, assessed_at, assessed_by, trigger, value_level, value_scores, prev_level, prev_scores, reason)
    values (?, ?, ?, ?, ?, ?, ?, ?, null, ?)
  `);
  history.run("h1", ASSET_MAIN, iso(9), OWNER_SUB, "create", "C", SCORES_C, null, "沉淀时按五维给到 C");
  history.run("h2", ASSET_MAIN, iso(5), "system", "auto_upgrade", "B", SCORES_A, "C", "近 30 天调用 3 次，复用分上调");
  history.run("h3", ASSET_MAIN, iso(2), OWNER_SUB, "manual_reassess", "A", SCORES_A, "B", "手动重评：实践验证补全");

  // 主内容是文本：详情页才会出现「查看原文 / 复制」，用来验证 open_source / copy 上报。
  // 正文本体在 RAGFlow 上，隔离实例没有它，复制会走到失败分支，这是预期内的。
  sqlite
    .prepare(
      `insert into content_refs
         (id, owner_type, owner_id, provider, dataset_id, document_id, content_key, role,
          document_name, content_hash, mime, size_bytes, parse_status, parse_error,
          sync_state, last_synced_at, created_at, updated_at, deleted_at)
       values ('c1', 'asset', ?, 'ragflow', 'ds-1', 'doc-1', 'key-1', 'primary',
               '产品体验复盘.md', null, 'text/markdown', 2400, 'succeeded', null,
               'synced', ?, ?, ?, null)`,
    )
    .run(ASSET_MAIN, iso(2), iso(2), iso(2));

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
      NEXT_DIST_DIR: ".next-v21b2",
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
      }, 90000);
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
  if (!CHROME) throw new Error("找不到 Chrome / Edge");
  const userDataDir = path.join(os.tmpdir(), `pakp-v21b2-chrome-${Date.now()}`);
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

/* ------------------------------ 主流程 ------------------------------ */

async function main() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pakp-v21b2-"));
  const dbFile = path.join(dir, "b2.db");
  await seedDatabase(dbFile);
  await mkdir(SHOTS, { recursive: true });

  let app = null;
  let browser = null;

  try {
    app = await startApp({ dbFile });
    browser = await launchBrowser();
    const page = await openPage(browser.cdp);
    await page.setViewport({ width: 1440, height: 900 });

    /* ---------- 返工：首页「本周新增」带着 added=7d 进列表 ---------- */
    await page.goto(`${BASE}/workspace`);
    await page.waitFor("Boolean(document.querySelector('.overview-item'))", 120000);
    await sleep(600);

    const weekly = await page.evaluate(`(() => {
      const card = [...document.querySelectorAll('.overview-item')]
        .find((el) => el.querySelector('.overview-copy span')?.textContent?.trim() === '本周新增');
      return card ? { href: card.getAttribute('href'), tag: card.tagName } : null;
    })()`);
    note("本周新增卡片", weekly);
    if (weekly?.href !== "/workspace?added=7d") {
      problems.push(`本周新增链接不对：${weekly?.href}`);
    }

    await page.evaluate(`(() => {
      const card = [...document.querySelectorAll('.overview-item')]
        .find((el) => el.querySelector('.overview-copy span')?.textContent?.trim() === '本周新增');
      card.click();
    })()`);
    await sleep(1500);

    const weeklyList = await page.evaluate(`(() => ({
      url: location.pathname + location.search,
      titles: [...document.querySelectorAll('.record-row-title')].map((el) => el.textContent.replace(/\\s+/g, ' ').trim()),
      chips: [...document.querySelectorAll('.filter-chip')].map((el) => el.textContent.trim()),
      heading: document.querySelector('.record-list-title')?.textContent?.trim(),
      note: document.querySelector('.record-list-note')?.textContent?.trim(),
    }))()`);
    note("本周新增列表", weeklyList);
    if (weeklyList.url !== "/workspace?added=7d") problems.push(`URL 没带上 added：${weeklyList.url}`);
    if (weeklyList.titles.length !== 4) {
      problems.push(`近 7 天应剩 4 条，实际 ${weeklyList.titles.length}`);
    }
    if (weeklyList.titles.some((title) => title.includes("两周前"))) {
      problems.push("两周前的笔记没被过滤掉");
    }
    if (!weeklyList.chips.some((chip) => chip.startsWith("近 7 天"))) {
      problems.push(`筛选条件里没有「近 7 天」：${JSON.stringify(weeklyList.chips)}`);
    }
    if (weeklyList.heading !== "最近新增") problems.push(`列表标题没变：${weeklyList.heading}`);
    await page.screenshot("b2-weekly-1440");

    // 摘掉「近 7 天」后回到全量
    await page.evaluate(`(() => {
      [...document.querySelectorAll('.filter-chip')].find((el) => el.textContent.trim().startsWith('近 7 天')).click();
    })()`);
    await sleep(1200);
    const cleared = await page.evaluate(`(() => ({
      url: location.pathname + location.search,
      rows: document.querySelectorAll('.record-row-item').length,
    }))()`);
    note("摘掉条件后", cleared);
    if (cleared.url !== "/workspace") problems.push(`摘掉 added 后 URL 不干净：${cleared.url}`);
    if (cleared.rows !== 5) problems.push(`清空后应有 5 条，实际 ${cleared.rows}`);

    // 刷新后保留
    await page.goto(`${BASE}/workspace?added=7d`);
    await page.waitFor("Boolean(document.querySelector('.record-row-item'))", 60000);
    await sleep(400);
    const refreshed = await page.evaluate("document.querySelectorAll('.record-row-item').length");
    note("刷新后行数", refreshed);
    if (refreshed !== 4) problems.push(`刷新后 added 丢失：${refreshed} 行`);

    /* ---------- A + B + C + D：资产详情 ---------- */
    await page.goto(`${BASE}/workspace/${ASSET_MAIN}`);
    await page.waitFor("Boolean(document.querySelector('.lifecycle-panel'))", 90000);
    await sleep(500);

    const detail = await page.evaluate(`(() => {
      const panel = document.querySelector('.lifecycle-panel');
      const buttons = [...document.querySelectorAll('.lifecycle-toolbar button')];
      const snapshot = document.querySelector('.snapshot-text');
      const snapshotLink = document.querySelector('.snapshot-link');
      return {
        meta: panel?.querySelector('.lifecycle-meta')?.textContent?.trim(),
        lockedBadge: [...document.querySelectorAll('.lifecycle-badge')].map((el) => el.textContent.trim()),
        buttons: buttons.map((el) => el.textContent.trim()),
        snapshotLength: snapshot ? snapshot.textContent.length : 0,
        snapshotEllipsis: snapshot ? snapshot.textContent.endsWith('…') : false,
        snapshotLink: snapshotLink ? snapshotLink.getAttribute('href') : null,
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    })()`);
    note("资产详情", detail);
    if (!/使用 3 次 · 最近/.test(detail.meta ?? "")) {
      problems.push(`使用次数文案不对：${detail.meta}`);
    }
    if (!detail.buttons.some((label) => label.includes("锁定等级"))) {
      problems.push(`价值卡没有锁定按钮：${JSON.stringify(detail.buttons)}`);
    }
    if (detail.snapshotLength === 0) problems.push("正文快照没显示");
    if (detail.snapshotLength > 310) problems.push(`快照没截断：${detail.snapshotLength} 字`);
    if (!detail.snapshotEllipsis) problems.push("快照缺省略号");
    if (detail.snapshotLink !== `/workspace/${WORK_ID}`) {
      problems.push(`快照链接不对：${detail.snapshotLink}`);
    }
    if (detail.overflow > 0) problems.push(`1440 横向溢出 ${detail.overflow}`);

    // 8 秒有效调用
    await sleep(9000);
    const usage = await page.evaluate(`(async () => {
      const response = await fetch('/api/objects/${ASSET_MAIN}', { cache: 'no-store' });
      const data = await response.json();
      return data?.object?.useCount ?? data?.useCount ?? null;
    })()`);
    note("停留 8 秒后的使用次数", usage);
    if (usage === null || usage < 4) problems.push(`detail_dwell 没记上：useCount=${usage}`);
    if (usage !== null && usage > 5) problems.push(`detail_dwell 报了多次：useCount=${usage}`);

    // 「查看原文」→ open_source（链接会开新标签，这里只看上报是否落库）
    const hasOpenSource = await page.evaluate(
      "Boolean([...document.querySelectorAll('.content-actions a')].find((el) => el.textContent.includes('查看原文')))",
    );
    if (!hasOpenSource) problems.push("主内容行没有「查看原文」按钮");
    else {
      await page.evaluate(`(() => {
        [...document.querySelectorAll('.content-actions a')]
          .find((el) => el.textContent.includes('查看原文'))?.click();
      })()`);
      await sleep(1500);
    }
    const afterOpen = await page.evaluate(`(async () => {
      const response = await fetch('/api/objects/${ASSET_MAIN}', { cache: 'no-store' });
      const data = await response.json();
      return data?.useCount ?? null;
    })()`);
    note("点过查看原文后的使用次数", afterOpen);
    if (hasOpenSource && afterOpen !== null && afterOpen <= usage) {
      problems.push(`open_source 没上报：${usage} → ${afterOpen}`);
    }

    // 「复制」→ copy（RAGFlow 不在，正文取不到会走失败文案；这里只确认按钮与提示）
    const copyState = await page.evaluate(`(async () => {
      const button = [...document.querySelectorAll('.content-actions button')]
        .find((el) => el.textContent.trim() === '复制');
      if (!button) return { found: false };
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 1800));
      return {
        found: true,
        toast: document.querySelector('.toast')?.textContent?.trim() ?? null,
        alert: document.querySelector('.content-alert')?.textContent?.trim() ?? null,
      };
    })()`);
    note("复制结果", copyState);
    if (!copyState.found) problems.push("主内容行没有「复制」按钮");

    // 展开评估历史
    await page.evaluate(`(() => {
      [...document.querySelectorAll('.lifecycle-toggle')]
        .find((el) => el.textContent.includes('评估历史'))?.click();
    })()`);
    await sleep(300);
    const history = await page.evaluate(`(() => ({
      items: [...document.querySelectorAll('.value-timeline-item')].map((el) => ({
        trigger: el.querySelector('.value-timeline-trigger')?.textContent?.trim(),
        level: el.querySelector('.value-timeline-level')?.textContent?.trim(),
        time: el.querySelector('.value-timeline-time')?.textContent?.trim(),
        reason: el.querySelector('.value-timeline-reason')?.textContent?.trim(),
      })),
    }))()`);
    note("评估历史", history.items);
    if (history.items.length !== 3) problems.push(`评估历史应有 3 条，实际 ${history.items.length}`);
    const triggers = history.items.map((item) => item.trigger);
    for (const expected of ["手动重评", "自动升级", "创建"]) {
      if (!triggers.includes(expected)) problems.push(`历史里缺「${expected}」：${triggers}`);
    }
    if (!history.items.some((item) => item.level === "B → A")) {
      problems.push(`等级变化没显示 prev→new：${history.items.map((i) => i.level)}`);
    }
    await page.evaluate(
      "document.querySelector('.snapshot-panel')?.scrollIntoView({ block: 'center' })",
    );
    await sleep(400);
    await page.screenshot("b2-asset-snapshot-1440");
    await page.evaluate("window.scrollTo(0, 0)");
    await sleep(300);
    await page.screenshot("b2-asset-detail-1440");

    // 锁定 / 解锁
    await page.evaluate(`(() => {
      [...document.querySelectorAll('.lifecycle-toolbar button')]
        .find((el) => el.textContent.includes('锁定等级'))?.click();
    })()`);
    await sleep(2000);
    const locked = await page.evaluate(`(() => ({
      badge: [...document.querySelectorAll('.lifecycle-badge')].map((el) => el.textContent.trim()),
      button: [...document.querySelectorAll('.lifecycle-toolbar button')].map((el) => el.textContent.trim()),
      verdict: document.querySelector('.lifecycle-verdict')?.textContent?.trim(),
    }))()`);
    note("锁定后", locked);
    if (!locked.badge.includes("已锁定")) problems.push(`没显示已锁定：${JSON.stringify(locked.badge)}`);
    if (!locked.button?.some((label) => label.includes("解锁"))) {
      problems.push(`按钮没切成解锁：${JSON.stringify(locked.button)}`);
    }
    if (!/不会改动/.test(locked.verdict ?? "")) problems.push(`锁定说明缺失：${locked.verdict}`);
    await page.screenshot("b2-asset-locked-1440");

    // 解锁恢复
    await page.evaluate(`(() => {
      [...document.querySelectorAll('.lifecycle-toolbar button')]
        .find((el) => el.textContent.includes('解锁等级'))?.click();
    })()`);
    await sleep(2000);
    const unlocked = await page.evaluate(`(() => ({
      badge: [...document.querySelectorAll('.lifecycle-badge')].map((el) => el.textContent.trim()),
      locked: document.querySelector('[aria-pressed="true"]')?.textContent?.trim() ?? null,
    }))()`);
    note("解锁后", unlocked);
    if (unlocked.badge.includes("已锁定")) problems.push("解锁后仍显示已锁定");

    /* ---------- E：新建对话框内库置灰 ---------- */
    await page.goto(`${BASE}/workspace`);
    await page.waitFor("Boolean(document.querySelector('.record-row-item'))", 60000);
    await sleep(1500);

    // 首次 SSR 之后 React 还要 hydration，点太早点不到，重试到对话框真的打开。
    let dialogOpen = false;
    for (let attempt = 0; attempt < 15 && !dialogOpen; attempt += 1) {
      await page.evaluate(`(() => {
        const buttons = [...document.querySelectorAll('button')]
          .filter((el) => el.textContent.trim() === '新建');
        (buttons[buttons.length - 1] ?? buttons[0])?.click();
      })()`);
      dialogOpen = await page.waitFor("Boolean(document.querySelector('dialog[open]'))", 1200);
    }
    if (!dialogOpen) problems.push("新建对话框打不开");
    await sleep(400);

    const createDialog = await page.evaluate(`(() => {
      const dialog = document.querySelector('dialog[open]');
      if (!dialog) return null;
      const internal = dialog.querySelector('input[name$="-library"][value="internal"]');
      const external = dialog.querySelector('input[name$="-library"][value="external"]');
      return {
        internalDisabled: internal?.disabled ?? null,
        externalChecked: external?.checked ?? null,
        override: Boolean(dialog.querySelector('.library-override input')),
        hint: dialog.querySelector('.library-hint')?.textContent?.trim(),
      };
    })()`);
    note("新建对话框", createDialog);
    if (!createDialog) problems.push("新建对话框没打开");
    else {
      if (createDialog.internalDisabled !== true) problems.push("新建时内库没有置灰");
      if (createDialog.externalChecked !== true) problems.push("新建时外库不是默认选中");
      if (!createDialog.override) problems.push("没有「仍要直接进入内库」勾选项");
    }
    await page.screenshot("b2-create-dialog-1440");

    // 勾选覆盖 → 内库可选，选中后给出确认文案
    await page.evaluate(`(() => {
      const dialog = document.querySelector('dialog[open]');
      dialog?.querySelector('.library-override input')?.click();
    })()`);
    await sleep(200);
    await page.evaluate(`(() => {
      const dialog = document.querySelector('dialog[open]');
      dialog?.querySelector('input[name$="-library"][value="internal"]')?.click();
    })()`);
    await sleep(300);
    const overridden = await page.evaluate(`(() => {
      const dialog = document.querySelector('dialog[open]');
      const internal = dialog?.querySelector('input[name$="-library"][value="internal"]');
      if (!internal) return { enabled: false, checked: false, warning: null };
      return {
        enabled: !internal.disabled,
        checked: internal.checked,
        warning: dialog.querySelector('.library-warning')?.textContent?.trim() ?? null,
      };
    })()`);
    note("勾选覆盖后", overridden);
    if (!overridden.enabled) problems.push("勾选覆盖后内库仍不可选");
    if (!overridden.checked) problems.push("勾选覆盖后没选中内库");
    if (!overridden.warning) problems.push("直接进内库没有确认文案");
    await page.screenshot("b2-create-override-1440");

    await page.evaluate(`(() => {
      const dialog = document.querySelector('dialog[open]');
      [...(dialog?.querySelectorAll('button') ?? [])].find((el) => el.textContent.trim() === '取消')?.click();
    })()`);
    await sleep(400);

    /* ---------- F：批量重评 ---------- */
    await page.goto(`${BASE}/workspace?type=asset`);
    await page.waitFor("Boolean(document.querySelector('.record-row-item'))", 60000);
    await sleep(1500);
    let picked = false;
    for (let attempt = 0; attempt < 15 && !picked; attempt += 1) {
      picked = await page.evaluate(`(() => {
        const rows = [...document.querySelectorAll('.record-row-item')];
        const target = rows.find((row) => row.textContent.includes('待重评的低价值资产'));
        if (!target) return false;
        target.querySelector('input[type="checkbox"]').click();
        return true;
      })()`);
      if (picked) {
        picked = await page.waitFor(
          "Boolean([...document.querySelectorAll('.record-bulk-count')].find((el) => el.textContent.includes('已选')))",
          1500,
        );
      }
      if (!picked) await sleep(600);
    }
    if (!picked) problems.push("列表里选不中待重评的资产");
    await sleep(300);
    await page.evaluate(`(() => {
      [...document.querySelectorAll('.record-bulk-actions button')]
        .find((el) => el.textContent.trim() === '批量重评')?.click();
    })()`);
    await page.waitFor("Boolean(document.querySelector('.record-bulk-result'))", 120000);
    await sleep(400);
    const reassess = await page.evaluate(`(() => {
      const box = document.querySelector('.record-bulk-result');
      return {
        head: box?.querySelector('.record-bulk-result-head')?.textContent?.replace(/\\s+/g, ' ').trim(),
        ok: [...box?.querySelectorAll('.record-bulk-result-list li') ?? []].map((el) => el.textContent.trim()),
        failed: box?.querySelectorAll('.record-bulk-result-list.is-failed li').length ?? 0,
      };
    })()`);
    note("批量重评结果", reassess);
    if (!/成功 1 条、失败 0 条/.test(reassess.head ?? "")) {
      problems.push(`重评结果文案不对：${reassess.head}`);
    }
    if (reassess.ok.length !== 1) problems.push(`重评成功列表不对：${JSON.stringify(reassess.ok)}`);
    await page.screenshot("b2-reassess-1440");

    /* ---------- 390 窄屏 ---------- */
    await page.setViewport({ width: 390, height: 844, dpr: 2, mobile: true });
    await page.goto(`${BASE}/workspace/${ASSET_MAIN}`);
    await page.waitFor("Boolean(document.querySelector('.lifecycle-panel'))", 90000);
    await sleep(600);
    const mobile = await page.evaluate(`(() => ({
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      width: innerWidth,
      actions: (() => {
        const el = document.querySelector('.content-actions');
        return el ? Math.round(el.getBoundingClientRect().right) : null;
      })(),
    }))()`);
    note("390 资产详情", mobile);
    if (mobile.overflow > 0) problems.push(`390 横向溢出 ${mobile.overflow}`);
    if (mobile.actions === null) problems.push("390 详情没有内容动作组");
    if (mobile.actions !== null && mobile.actions > mobile.width) {
      problems.push(`内容动作组溢出：${mobile.actions} > ${mobile.width}`);
    }
    await page.screenshot("b2-asset-detail-390");

    await page.evaluate(
      "document.querySelector('.content-actions')?.scrollIntoView({ block: 'center' })",
    );
    await sleep(400);
    await page.screenshot("b2-asset-content-390");

    await page.evaluate(
      "document.querySelector('.snapshot-panel')?.scrollIntoView({ block: 'start' })",
    );
    await sleep(400);
    await page.screenshot("b2-asset-snapshot-390");

    await page.goto(`${BASE}/workspace?added=7d`);
    await page.waitFor("Boolean(document.querySelector('.record-row-item'))", 60000);
    await sleep(500);
    const mobileList = await page.evaluate(`(() => ({
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      chips: [...document.querySelectorAll('.filter-chip')].map((el) => el.textContent.trim()),
      chipRight: Math.round(document.querySelector('.filter-chips')?.getBoundingClientRect().right ?? 0),
    }))()`);
    note("390 本周新增", mobileList);
    if (mobileList.overflow > 0) problems.push(`390 列表横向溢出 ${mobileList.overflow}`);
    if (mobileList.chipRight > 390) problems.push(`筛选胶囊溢出：${mobileList.chipRight}`);
    await page.screenshot("b2-weekly-390");

    // 中间宽度（1024）再看一眼：动作组不能撑破内容列
    await page.setViewport({ width: 1024, height: 800 });
    await page.goto(`${BASE}/workspace/${ASSET_MAIN}`);
    await page.waitFor("Boolean(document.querySelector('.content-actions'))", 90000);
    await sleep(400);
    const mid = await page.evaluate(`(() => {
      const el = document.querySelector('.content-actions');
      return {
        right: Math.round(el.getBoundingClientRect().right),
        width: innerWidth,
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    })()`);
    note("1024 内容动作组", mid);
    if (mid.overflow > 0) problems.push(`1024 横向溢出 ${mid.overflow}`);
    if (mid.right > mid.width) problems.push(`1024 动作组溢出：${mid.right} > ${mid.width}`);

    if (page.consoleErrors.length) {
      const noisy = page.consoleErrors.filter((line) => !/favicon|React DevTools/.test(line));
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
