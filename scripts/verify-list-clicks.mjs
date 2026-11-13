/**
 * 列表点击语义验收（临时脚本，验完删除）：
 *   标题 → 弹预览；标题以外的行内区域 → 进详情；弹窗「打开详情」→ 进详情。
 *
 * 隔离：临时库（%TEMP%）+ AUTH_MODE=mock + 独立端口，不碰真实库与 3000 服务。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

const ROOT = path.resolve(import.meta.dirname, "..");
const NEXT_BIN = path.join(ROOT, "node_modules/next/dist/bin/next");
const CHROME = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
].filter(Boolean).find((candidate) => existsSync(candidate));

const APP_PORT = Number(process.env.APP_PORT || 3129);
const CDP_PORT = Number(process.env.CDP_PORT || 9341);
const BASE = `http://localhost:${APP_PORT}`;
const OWNER_SUB = "mock-local-user";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const OBJECTS = [
  { id: "6f0a1f10-3b28-4a61-9e3a-8c1d2f4a7c01", title: "验收样本甲" },
  { id: "6f0a1f10-3b28-4a61-9e3a-8c1d2f4a7c02", title: "验收样本乙" },
  { id: "6f0a1f10-3b28-4a61-9e3a-8c1d2f4a7c03", title: "验收样本丙" },
];

async function seedDatabase(file) {
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  migrate(drizzle(sqlite), { migrationsFolder: path.join(ROOT, "drizzle") });
  const now = new Date().toISOString();
  const insert = sqlite.prepare(`
    insert into objects
      (id, type, title, description, library, source, origin, category_code, priority,
       owner_sub, created_at, updated_at)
    values (?, 'asset', ?, ?, 'internal', 'handwritten', 'self', null, 'medium', ?, ?, ?)
  `);
  for (const object of OBJECTS) {
    insert.run(object.id, object.title, `${object.title}（点击语义验收夹具）`, OWNER_SUB, now, now);
  }
  sqlite.close();
}

async function waitForEndpoint(url, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch {
      // 还没起来
    }
    await sleep(200);
  }
  throw new Error(`等待 ${url} 超时`);
}

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

async function main() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pakp-click-"));
  const dbFile = path.join(tempDir, "app.db");
  await seedDatabase(dbFile);

  const app = spawn(process.execPath, [NEXT_BIN, "dev", "-p", String(APP_PORT)], {
    cwd: ROOT,
    env: {
      ...process.env,
      AUTH_MODE: "mock",
      DATABASE_PATH: dbFile,
      LIGHTRAG_BASE_URL: "http://127.0.0.1:9621",
      LIGHTRAG_API_KEY: "verify-mock",
      NEXT_DIST_DIR: ".next-verify",
      NEXT_TELEMETRY_DISABLED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const appLogs = [];
  app.stdout.on("data", (chunk) => appLogs.push(chunk.toString()));
  app.stderr.on("data", (chunk) => appLogs.push(chunk.toString()));

  const userDataDir = await mkdtemp(path.join(os.tmpdir(), "pakp-click-chrome-"));
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--enable-unsafe-swiftshader",
      "about:blank",
    ],
    { stdio: "ignore", windowsHide: true },
  );

  try {
    await waitForEndpoint(`${BASE}/api/health`);
    const version = await waitForEndpoint(`http://127.0.0.1:${CDP_PORT}/json/version`);
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", reject, { once: true });
    });
    const cdp = new Cdp(ws);
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const send = (method, params) => cdp.send(method, params, sessionId);
    const evaluate = async (expression) => {
      const result = await send("Runtime.evaluate", {
        expression,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description ?? "evaluate failed");
      }
      return result.result?.value;
    };
    const waitFor = async (expression, timeoutMs = 30000) => {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        try {
          if (await evaluate(expression)) return true;
        } catch {
          // 页面还在导航
        }
        await sleep(150);
      }
      return false;
    };
    const clickAt = async (x, y, modifiers = 0) => {
      for (const type of ["mousePressed", "mouseReleased"]) {
        await send("Input.dispatchMouseEvent", {
          type,
          x,
          y,
          button: "left",
          clickCount: 1,
          modifiers,
        });
      }
    };

    await send("Page.enable");
    await send("Runtime.enable");
    await send("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });

    const results = [];
    const record = (name, pass, detail) => {
      results.push({ name, pass, detail });
      console.log(`${pass ? "PASS" : "FAIL"} ${name} — ${detail}`);
    };

    // 1. 列表标题 → 弹预览
    await send("Page.navigate", { url: `${BASE}/workspace` });
    await waitFor(`!!document.querySelector('.record-title-button')`);
    await sleep(1500);
    const titleBox = await evaluate(
      `(() => { const el = document.querySelector('.record-title-button');
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, label: el.textContent }; })()`,
    );
    await clickAt(titleBox.x, titleBox.y);
    let dialogOpened = await waitFor(`!!document.querySelector('dialog[open]')`, 6000);
    if (!dialogOpened) {
      await clickAt(titleBox.x, titleBox.y);
      dialogOpened = await waitFor(`!!document.querySelector('dialog[open]')`, 8000);
    }
    const urlAfterTitle = await evaluate(`location.pathname + location.search`);
    record(
      "标题点击弹预览",
      dialogOpened && urlAfterTitle.includes("preview=") && urlAfterTitle.startsWith("/workspace"),
      `dialog=${dialogOpened} url=${urlAfterTitle} title=${titleBox.label}`,
    );

    // 2. 弹窗右上角「打开详情」→ 进详情
    await waitFor(
      `!!document.querySelector('dialog[open] [aria-label="打开详情"]') || !document.querySelector('dialog[open] .skeleton')`,
      10000,
    );
    const detailButton = await evaluate(
      `(() => { const el = document.querySelector('dialog[open] [aria-label="打开详情"]');
        if (!el) return null; const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, tag: el.tagName }; })()`,
    );
    if (!detailButton) {
      const html = await evaluate(
        `(document.querySelector('dialog[open]')?.innerHTML ?? '').slice(0, 700)`,
      );
      record("弹窗「打开详情」", false, `弹窗里没有找到「打开详情」按钮：${html}`);
    } else {
      await clickAt(detailButton.x, detailButton.y);
      const navigated = await waitFor(
        `location.pathname.startsWith('/workspace/') && !document.querySelector('dialog[open]')`,
        10000,
      );
      record(
        "弹窗「打开详情」",
        navigated,
        `url=${await evaluate(`location.pathname + location.search`)}`,
      );
    }

    // 3. Ctrl + 点标题 → 跳过预览直接进详情
    await send("Page.navigate", { url: `${BASE}/workspace` });
    await waitFor(`!!document.querySelector('.record-title-button')`);
    await sleep(1500);
    const ctrlTitle = await evaluate(
      `(() => { const el = document.querySelector('.record-title-button');
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
    );
    await clickAt(ctrlTitle.x, ctrlTitle.y, 2);
    const ctrlNavigated = await waitFor(
      `location.pathname.startsWith('/workspace/') && !document.querySelector('dialog[open]')`,
      10000,
    );
    record(
      "Ctrl + 点标题进详情",
      ctrlNavigated,
      `url=${await evaluate(`location.pathname + location.search`)}`,
    );

    // 4. 行内非标题区域 → 进详情
    await send("Page.navigate", { url: `${BASE}/workspace` });
    await waitFor(`!!document.querySelector('.record-row-link')`);
    const rowPoint = await evaluate(
      `(() => { const link = document.querySelector('.record-row-link');
        const row = link.closest('li') ?? link.parentElement;
        const title = row.querySelector('.record-title-button');
        const r = row.getBoundingClientRect(); const t = title.getBoundingClientRect();
        return { x: r.right - 24, y: t.y + t.height / 2, titleRight: t.right, rowRight: r.right,
                 href: link.getAttribute('href') }; })()`,
    );
    await clickAt(rowPoint.x, rowPoint.y);
    const detailReached = await waitFor(
      `location.pathname.startsWith('/workspace/') && !document.querySelector('dialog[open]')`,
      10000,
    );
    record(
      "行内非标题区域进详情",
      detailReached,
      `点击 x=${Math.round(rowPoint.x)}（标题右缘 ${Math.round(rowPoint.titleRight)}，行右缘 ${Math.round(rowPoint.rowRight)}）url=${await evaluate(
        `location.pathname + location.search`,
      )}`,
    );

    // 4. 两个列表结构一致（全部内容 / 作品目录）
    const structures = await evaluate(
      `(() => { const rows = [...document.querySelectorAll('.record-row-link')];
        return { rows: rows.length, titles: document.querySelectorAll('.record-title-button').length }; })()`,
    );
    record("列表结构", structures.rows > 0 && structures.titles > 0, JSON.stringify(structures));

    const failures = results.filter((item) => !item.pass);
    console.log(`\n结果：${results.length - failures.length}/${results.length} 通过`);
    cdp.send("Browser.close").catch(() => chrome.kill());
    ws.close();
    if (failures.length > 0) process.exitCode = 1;
  } catch (error) {
    console.error("验收脚本失败：", error.message);
    console.error(appLogs.join("").slice(-3000));
    process.exitCode = 1;
  } finally {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(app.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      spawn("taskkill", ["/pid", String(chrome.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else {
      app.kill("SIGTERM");
      chrome.kill("SIGTERM");
    }
    await sleep(1500);
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  }
}

await main();
