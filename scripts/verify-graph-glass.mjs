/**
 * /graph 全屏星图 + 液态玻璃浮层验收（ADR-027 回归）。
 *
 * 隔离：临时库（%TEMP%）+ AUTH_MODE=mock + 独立端口 3131，跑生产 `next start`（共用 `.next`），
 * 不碰 `data/app.db`，也不碰 3000 上的日常服务。提问卡已改成贴底居中的搜索卡（ADR-028）。
 *
 * 断言：
 *   1. `.graph-page` 宽度 / 父容器宽度 = 1（内容区吃满，不再有 1180 上限）；
 *   2. 打开详情前后舞台 `getBoundingClientRect` 不变（详情不挤压画布）；
 *   3. 浮层以外的点 elementFromPoint 落在舞台层里（拖拽/滚轮/双击不被吞）；
 *   4. 四套主题下玻璃标题的计算色完全一致（玻璃里没有主题 --text-*）；
 *   5. backdrop-filter = blur(14px) saturate(130%)；low 档退 92% 实色且无模糊；
 *   6. 列表模式无画布层、无 .graph-glass；
 *   7. 控制条可收起、详情可收成把手；390×844 下详情为底部抽屉。
 *
 * 用法：先 `npm run build`，再 node scripts/verify-graph-glass.mjs
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "docs/screenshots");
const NEXT_BIN = path.join(ROOT, "node_modules/next/dist/bin/next");
const CHROME = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
].filter(Boolean).find((candidate) => existsSync(candidate));

const APP_PORT = Number(process.env.APP_PORT || 3131);
const CDP_PORT = Number(process.env.CDP_PORT || 9349);
const BASE = `http://localhost:${APP_PORT}`;
const OWNER_SUB = "mock-local-user";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const problems = [];
const facts = {};
const note = (label, value) => {
  facts[label] = value;
  console.log(`[fact] ${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
};

/* ------------------------------ 数据库 ------------------------------ */

const OBJECTS = Array.from({ length: 8 }, (_, index) => ({
  id: `6e0b1f10-3b28-4a61-9e3a-8c1d2f4a7c${String(index + 1).padStart(2, "0")}`,
  title: `玻璃验收样本 ${index + 1}`,
}));

const filePathFor = (objectId) =>
  `pakp:obj:${objectId}:${createHash("sha256").update(objectId).digest("hex").slice(0, 16)}`;

async function seedDatabase(file) {
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("busy_timeout = 5000");
  migrate(drizzle(sqlite), { migrationsFolder: path.join(ROOT, "drizzle") });
  const insert = sqlite.prepare(`
    insert into objects
      (id, type, title, description, library, source, origin, category_code, priority,
       owner_sub, created_at, updated_at)
    values (?, 'asset', ?, ?, 'internal', 'handwritten', 'self', null, 'medium', ?, ?, ?)
  `);
  const now = new Date().toISOString();
  const run = sqlite.transaction(() => {
    for (const object of OBJECTS) {
      insert.run(object.id, object.title, `${object.title}（ADR-027 验收夹具）`, OWNER_SUB, now, now);
    }
  });
  run();
  sqlite.close();
}

/* ------------------------------ 图谱夹具 ------------------------------ */

const CENTER = "知识管理";
const RING1 = [
  ["卡片笔记", "概念"],
  ["第二大脑", "概念"],
  ["渐进式总结", "方法"],
  ["PARA 方法", "方法"],
  ["常青笔记", "概念"],
  ["林默", "人物"],
  ["内容工作室", "机构"],
  ["《深度工作》", "作品"],
  ["检索增强生成", "概念"],
  ["间隔重复", "方法"],
  ["认知负荷", "概念"],
  ["写作工作流", "方法"],
];
const RING2 = Array.from({ length: 24 }, (_, index) => `二环实体 ${String(index + 1).padStart(2, "0")}`);

const ENTITIES = [
  { id: CENTER, type: "概念", description: "整张图的中心。" },
  ...RING1.map(([id, type]) => ({ id, type, description: `${id}是知识管理里的常用概念。` })),
  ...RING2.map((id, index) => ({
    id,
    type: ["方法", "概念", "作品", "其他"][index % 4],
    description: `${id}从一环继续展开。`,
  })),
];
ENTITIES.forEach((entity, index) => {
  entity.filePath = filePathFor(OBJECTS[index % OBJECTS.length].id);
});
const byId = new Map(ENTITIES.map((entity) => [entity.id, entity]));

const EDGES = [];
function addEdge(source, target, relation) {
  EDGES.push({
    source,
    target,
    description: `${relation}<SEP>${source} 与 ${target} 相连。`,
    filePath: filePathFor(OBJECTS[EDGES.length % OBJECTS.length].id),
  });
}
RING1.forEach(([id]) => addEdge(CENTER, id, "关联"));
RING2.forEach((id, index) => addEdge(RING1[index % RING1.length][0], id, "延伸"));

const LABELS = [CENTER, ...RING1.slice(0, 8).map(([id]) => id)];

function neighborhood(label, maxDepth, maxNodes) {
  const adjacency = new Map(ENTITIES.map((entity) => [entity.id, []]));
  for (const edge of EDGES) {
    adjacency.get(edge.source)?.push(edge.target);
    adjacency.get(edge.target)?.push(edge.source);
  }
  const distance = new Map([[label, 0]]);
  const queue = [label];
  while (queue.length > 0) {
    const id = queue.shift();
    const depth = distance.get(id) ?? 0;
    if (depth >= maxDepth) continue;
    for (const next of adjacency.get(id) ?? []) {
      if (!distance.has(next)) {
        distance.set(next, depth + 1);
        queue.push(next);
      }
    }
  }
  let ids = [...distance.keys()];
  if (ids.length > maxNodes) ids = ids.slice(0, maxNodes);
  const kept = new Set(ids);
  return {
    nodes: ids.map((id) => {
      const entity = byId.get(id);
      return {
        id,
        labels: ["Entity"],
        properties: {
          entity_type: entity?.type ?? "概念",
          description: entity?.description ?? "",
          file_path: entity?.filePath ?? filePathFor(OBJECTS[0].id),
        },
      };
    }),
    edges: EDGES.filter((edge) => kept.has(edge.source) && kept.has(edge.target)).map((edge) => ({
      source: edge.source,
      target: edge.target,
      properties: { description: edge.description, file_path: edge.filePath },
    })),
  };
}

/* ------------------------------ mock LightRAG ------------------------------ */

function json(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

async function startMockLightrag() {
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const pathname = url.pathname;
    if (pathname === "/graph/label/list") return json(response, 200, LABELS);
    if (pathname === "/graphs") {
      return json(
        response,
        200,
        neighborhood(
          url.searchParams.get("label") ?? "",
          Number(url.searchParams.get("max_depth") || 2),
          Number(url.searchParams.get("max_nodes") || 200),
        ),
      );
    }
    if (pathname === "/documents/paginated") {
      const documents = OBJECTS.map((object, index) => ({
        id: `doc-glass-${index + 1}`,
        file_path: filePathFor(object.id),
        status: "processed",
        chunks_count: 2,
        error_msg: null,
      }));
      return json(response, 200, { documents, pagination: { total_count: documents.length } });
    }
    if (pathname === "/query") {
      return json(response, 200, { response: "知识管理把这些概念串成一条路径。", references: [] });
    }
    json(response, 404, { detail: `mock 未实现 ${pathname}` });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    async close() {
      server.closeAllConnections?.();
      server.close();
      await Promise.race([once(server, "close"), sleep(2000)]).catch(() => {});
    },
  };
}

/* ------------------------------ 服务起停 ------------------------------ */

async function waitForServer(url, timeoutMs = 180000) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        const data = await response.json();
        if (data.status === "ok" && data.authMode === "mock") return data;
        lastError = new Error(`身份不是 mock（authMode=${data.authMode}）`);
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(300);
  }
  throw new Error(`等待 ${url} 超时：${lastError?.message ?? "无响应"}`);
}

function portInUse(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(1000, () => done(false));
  });
}

async function startApp({ dbFile, lightragUrl }) {
  if (await portInUse(APP_PORT)) {
    throw new Error(`端口 ${APP_PORT} 已被占用；用 APP_PORT=xxxx 换一个。`);
  }
  const child = spawn(process.execPath, [NEXT_BIN, "start", "-p", String(APP_PORT)], {
    cwd: ROOT,
    env: {
      ...process.env,
      AUTH_MODE: "mock",
      DATABASE_PATH: dbFile,
      LIGHTRAG_BASE_URL: lightragUrl,
      LIGHTRAG_API_KEY: "glass-mock",
      NEXT_TELEMETRY_DISABLED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const logs = [];
  const collect = (chunk) => {
    logs.push(chunk.toString());
    if (logs.length > 300) logs.shift();
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
  const userDataDir = path.join(os.tmpdir(), `pakp-glass-chrome-${Date.now()}`);
  const child = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      // 不关 GPU：3D 入口要真的起来；无头下走 SwiftShader 软件渲染。
      "--enable-unsafe-swiftshader",
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
  const cdp = new Cdp(ws);
  return {
    cdp,
    async close() {
      await Promise.race([cdp.send("Browser.close").catch(() => child.kill()), sleep(3000)]).catch(
        () => {},
      );
      ws.close();
      await sleep(300);
      await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

async function openPage(cdp) {
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const scriptUrls = new Map();
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
        setTimeout(resolve, 20000);
      });
      await cdp.send("Page.navigate", { url }, sessionId);
      await loaded;
    },
    async waitFor(expression, timeoutMs = 30000, intervalMs = 120) {
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
      await mkdir(OUT, { recursive: true });
      const file = path.join(OUT, `${name}.png`);
      await writeFile(file, Buffer.from(data, "base64"));
      console.log(`[shot] ${path.relative(ROOT, file)}`);
      return file;
    },
    async close() {
      await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
    },
    /* 监听来自哪个脚本：用来区分「我们挂的」和「框架委派的」。 */
    scriptUrl(scriptId) {
      return scriptUrls.get(scriptId) ?? null;
    },
  };
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Runtime.enable", {}, sessionId);
  // 先注册再 enable，才不会漏掉首帧解析的脚本
  cdp.on(`${sessionId}:Debugger.scriptParsed`, (params) => {
    scriptUrls.set(params.scriptId, params.url);
  });
  await cdp.send("Debugger.enable", {}, sessionId).catch(() => {});
  cdp.on(`${sessionId}:Runtime.consoleAPICalled`, (params) => {
    if (params.type !== "error") return;
    page.consoleErrors.push(
      params.args.map((arg) => arg.description ?? arg.value ?? "").join(" ").slice(0, 400),
    );
  });
  cdp.on(`${sessionId}:Runtime.exceptionThrown`, (params) => {
    page.pageErrors.push(params.exceptionDetails?.exception?.description?.slice(0, 400) ?? "exception");
  });
  return page;
}

/* ------------------------------ 断言 ------------------------------ */

const PAGE_METRICS = `(() => {
  const page = document.querySelector('.graph-page');
  const stage = document.querySelector('.graph-stage-layer');
  const bar = document.querySelector('.graph-bar');
  const inspector = document.querySelector('.graph-inspector');
  const rect = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const glass = document.querySelector('.graph-glass');
  const cs = glass ? getComputedStyle(glass) : null;
  return {
    pageWidth: page ? Math.round(page.getBoundingClientRect().width) : null,
    parentWidth: page?.parentElement ? Math.round(page.parentElement.getBoundingClientRect().width) : null,
    pageRect: rect(page),
    stageRect: rect(stage),
    barRect: rect(bar),
    inspectorRect: rect(inspector),
    viewport: { w: innerWidth, h: innerHeight },
    backdrop: cs ? (cs.backdropFilter || cs.webkitBackdropFilter || 'none') : null,
    glassBg: cs ? cs.backgroundColor : null,
    titleColor: (() => {
      const el = document.querySelector('.graph-bar-title');
      return el ? getComputedStyle(el).color : null;
    })(),
    glassCount: document.querySelectorAll('.graph-glass').length,
    panelInGlass: document.querySelectorAll('.graph-glass .panel, .graph-glass.panel').length,
    pageOverflow: page ? page.scrollWidth - page.clientWidth : null,
  };
})()`;

const HIT_TEST = (ratioX, ratioY) => `(() => {
  const x = Math.round(innerWidth * ${ratioX});
  const y = Math.round(innerHeight * ${ratioY});
  const el = document.elementFromPoint(x, y);
  return {
    x, y,
    tag: el ? el.tagName : null,
    inStage: Boolean(el && el.closest('.graph-stage-layer')),
    inGlass: Boolean(el && el.closest('.graph-glass')),
  };
})()`;

/* 两张角落卡的实际盒子 + 控制卡上的高光坐标 / 倾斜。 */
const CORNER_METRICS = `(() => {
  const box = (selector) => {
    const el = document.querySelector(selector);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      left: Math.round(r.left),
      top: Math.round(r.top),
      right: Math.round(r.right),
      bottom: Math.round(r.bottom),
      w: Math.round(r.width),
      h: Math.round(r.height),
    };
  };
  const bar = document.querySelector('.graph-bar');
  const inspector = document.querySelector('.graph-inspector');
  // 底部的「问图谱」已改成贴底居中的搜索卡（ADR-028）：dock 是排布容器，玻璃在表单上。
  const qa = document.querySelector('.graph-ask-form');
  const readVar = (el, name) => (el ? getComputedStyle(el).getPropertyValue(name).trim() : null);
  return {
    workspace: box('.graph-workspace'),
    bar: box('.graph-bar'),
    inspector: box('.graph-inspector'),
    qa: box('.graph-ask-dock'),
    stage: box('.graph-stage-layer'),
    barPosition: bar ? getComputedStyle(bar).position : null,
    barMx: readVar(bar, '--mx'),
    barMy: readVar(bar, '--my'),
    barTilt: bar ? getComputedStyle(bar).transform : null,
    inspectorMx: readVar(inspector, '--mx'),
    qaMx: readVar(qa, '--mx'),
    qaBg: qa ? getComputedStyle(qa, '::after').backgroundImage.slice(0, 80) : null,
  };
})()`;

async function moveMouse(page, x, y) {
  await page.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: Math.round(x),
    y: Math.round(y),
    button: "none",
    buttons: 0,
    pointerType: "mouse",
  });
  // 两帧足够让 rAF 合并的那次提交落到样式上
  await sleep(120);
}

/* 真实挂在某个对象上的事件监听（CDP DOMDebugger）。比在页面里打补丁可信。 */
async function eventListeners(page, expression) {
  const target = await page.send("Runtime.evaluate", {
    expression,
    objectGroup: "probe",
    returnByValue: false,
  });
  const objectId = target.result?.objectId;
  if (!objectId) return null;
  const { listeners } = await page.send("DOMDebugger.getEventListeners", {
    objectId,
    depth: 0,
    pierce: true,
  });
  await page.send("Runtime.releaseObject", { objectId });
  return listeners ?? [];
}

const countOfType = (listeners, type) => (listeners ?? []).filter((item) => item.type === type).length;

async function main() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pakp-glass-"));
  const dbFile = path.join(dir, "glass.db");
  await seedDatabase(dbFile);
  const lightrag = await startMockLightrag();
  let app = null;
  let browser = null;

  try {
    app = await startApp({ dbFile, lightragUrl: lightrag.url });
    browser = await launchBrowser();
    const page = await openPage(browser.cdp);

    /* ---------- 桌面 1440×900：2D ---------- */
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(`${BASE}/graph?mode=2d&depth=2`);
    await page.waitFor("Boolean(document.querySelector('.g2-stage svg'))", 90000);
    await sleep(1200);

    let metrics = await page.evaluate(PAGE_METRICS);
    note("desktop 2d page/parent", `${metrics.pageWidth}/${metrics.parentWidth}`);
    note("desktop 2d stage", metrics.stageRect);
    note("desktop 2d pageOverflow", metrics.pageOverflow);
    note("desktop 2d backdrop", metrics.backdrop);
    if (metrics.pageWidth !== metrics.parentWidth) {
      problems.push(`.graph-page 未吃满内容区：${metrics.pageWidth} vs ${metrics.parentWidth}`);
    }
    if (metrics.pageOverflow > 0) problems.push(`.graph-page 横向溢出 ${metrics.pageOverflow}`);
    if (!/blur\(14px\)/.test(metrics.backdrop ?? "")) {
      problems.push(`backdrop-filter 不是 14px 配方：${metrics.backdrop}`);
    }
    if (metrics.panelInGlass > 0) problems.push(`玻璃里出现 .panel：${metrics.panelInGlass}`);

    // 浮层之外的指针必须落在舞台层
    const stageRatioX = ((metrics.stageRect.x + metrics.stageRect.w * 0.32) / metrics.viewport.w);
    const stageRatioY = ((metrics.stageRect.y + metrics.stageRect.h * 0.52) / metrics.viewport.h);
    const hit = await page.evaluate(HIT_TEST(stageRatioX, stageRatioY));
    note("desktop 2d hit-test", hit);
    if (!hit.inStage) problems.push(`画布中心被浮层挡住：命中 ${hit.tag}`);

    await page.screenshot("graph-glass-2d-desktop");

    /* ---------- 角落卡：控制卡贴左上、详情卡贴右上、顶边齐平 ---------- */
    let corners = await page.evaluate(CORNER_METRICS);
    note("1440 角落卡", { bar: corners.bar, inspector: corners.inspector, qa: corners.qa });
    note("1440 控制卡 position", corners.barPosition);
    if (corners.barPosition !== "absolute") {
      problems.push(`控制卡不是绝对定位：${corners.barPosition}`);
    }
    if (
      Math.abs(corners.bar.left - (corners.workspace.left + 16)) > 1 ||
      Math.abs(corners.bar.top - (corners.workspace.top + 16)) > 1
    ) {
      problems.push(
        `控制卡没贴左上：left ${corners.bar.left}（应 ${corners.workspace.left + 16}）, top ${corners.bar.top}`,
      );
    }
    if (Math.abs(corners.inspector.right - (corners.workspace.right - 16)) > 1) {
      problems.push(
        `详情卡没贴右边：right ${corners.inspector.right}（应 ${corners.workspace.right - 16}）`,
      );
    }
    const topDelta = Math.abs(corners.bar.top - corners.inspector.top);
    note("1440 顶边差", `${topDelta}px`);
    if (topDelta > 1) problems.push(`两张卡顶边差 ${topDelta}px（要求 ≤1px）`);
    const cardGap = corners.inspector.left - corners.bar.right;
    note("1440 控制卡右缘 / 详情卡左缘 / 间距", `${corners.bar.right} / ${corners.inspector.left} / ${cardGap}`);
    if (cardGap < 16) problems.push(`两张卡间距 ${cardGap}px（要求 ≥16px）`);
    if (corners.bar.w > 880) problems.push(`控制卡宽 ${corners.bar.w}（上限 880）`);
    if (corners.inspector.bottom > corners.qa.top) {
      problems.push(`详情卡压到问图谱：${corners.inspector.bottom} > ${corners.qa.top}`);
    }

    /* ---------- pointermove 只挂在三张卡上：工作区与 document/window 上不许有 ---------- */
    await page.send("DOM.enable").catch(() => {});
    const listening = {};
    const rawListeners = {};
    for (const [name, expression] of [
      ["bar", "document.querySelector('.graph-bar')"],
      ["inspector", "document.querySelector('.graph-inspector')"],
      ["qa", "document.querySelector('.graph-ask-form')"],
      ["workspace", "document.querySelector('.graph-workspace')"],
      ["document", "document"],
      ["window", "window"],
    ]) {
      const listeners = (await eventListeners(page, expression)) ?? [];
      rawListeners[name] = listeners;
      listening[name] = {
        pointermove: countOfType(listeners, "pointermove"),
        pointerleave: countOfType(listeners, "pointerleave"),
      };
    }
    // 全局对象上若还有 pointermove，必须能说清是谁挂的：记下脚本来源，而不是只数条数。
    const originOf = (listener) => {
      const url = page.scriptUrl(listener.scriptId) ?? "";
      return {
        url: url.split("/").slice(-1)[0] || url,
        line: listener.lineNumber,
        source: (listener.handler?.description ?? "").slice(0, 90).replace(/\s+/g, " "),
      };
    };
    const outerOrigins = {
      document: (rawListeners.document ?? [])
        .filter((item) => item.type === "pointermove")
        .map(originOf),
      window: (rawListeners.window ?? [])
        .filter((item) => item.type === "pointermove")
        .map(originOf),
    };
    note("pointermove 挂载位置", listening);
    if (outerOrigins.document.length || outerOrigins.window.length) {
      note("document/window 上 pointermove 的来源", outerOrigins);
    }
    for (const name of ["bar", "inspector", "qa"]) {
      const label = name === "qa" ? "ask-form" : name;
      if (listening[name].pointermove !== 1) {
        problems.push(`.graph-${label} 上 pointermove 监听 ${listening[name].pointermove} 条（应为 1）`);
      }
      if (listening[name].pointerleave !== 1) {
        problems.push(`.graph-${label} 上 pointerleave 监听 ${listening[name].pointerleave} 条（应为 1）`);
      }
    }
    if (listening.workspace.pointermove !== 0) {
      problems.push(`工作区上仍有 ${listening.workspace.pointermove} 条 pointermove`);
    }
    // 只允许框架（React 事件委派）落在 document 上；图谱页面自己的脚本一条都不许。
    const ownOnOuter = [...outerOrigins.document, ...outerOrigins.window].filter(
      (item) => /graph-explorer|graph-stage|graph-module|app\/graph/.test(item.url),
    );
    if (ownOnOuter.length) {
      problems.push(`图谱脚本在 document/window 上挂了 pointermove：${JSON.stringify(ownOnOuter)}`);
    }

    /* ---------- 跟随指针的高光：坐标真的变，画布不受影响 ---------- */
    const beforeMx = corners.barMx;
    await moveMouse(page, corners.bar.left + 36, corners.bar.top + 24);
    const moved1 = await page.evaluate(CORNER_METRICS);
    note("控制卡 --mx/--my（指针左上）", `${beforeMx} → ${moved1.barMx} / ${moved1.barMy}`);
    if (!moved1.barMx || moved1.barMx === "50%") {
      problems.push(`指针移过后 --mx 没变化：${moved1.barMx}`);
    }
    if (moved1.barMx === beforeMx && moved1.barMy === corners.barMy) {
      problems.push("指针移过后高光坐标没变");
    }
    await moveMouse(page, corners.bar.left + corners.bar.w - 40, corners.bar.top + corners.bar.h - 30);
    const moved2 = await page.evaluate(CORNER_METRICS);
    note("控制卡 --mx/--my（指针右下）", `${moved2.barMx} / ${moved2.barMy}`);
    if (moved2.barMx === moved1.barMx) problems.push("两次不同位置的高光坐标一样");
    if (moved2.stage.w !== moved1.stage.w || moved2.stage.top !== moved1.stage.top) {
      problems.push("跟随高光改变了画布盒子");
    }
    if (!/matrix3d|matrix\(/.test(moved2.barTilt ?? "")) {
      problems.push(`控制卡没有厚度倾斜：${moved2.barTilt}`);
    }

    // 指针在详情卡上时，高光落在详情卡而不是控制卡
    await moveMouse(page, corners.inspector.left + 60, corners.inspector.top + 60);
    const moved3 = await page.evaluate(CORNER_METRICS);
    note("详情卡 --mx", moved3.inspectorMx);
    if (!moved3.inspectorMx) problems.push("详情卡没有收到跟随高光");
    note("玻璃反光层", moved3.qaBg);
    if (!/gradient/.test(moved3.qaBg ?? "")) problems.push("玻璃卡缺少斜向反光层");

    // 指针移开后回到默认值，画布拖拽照常
    await moveMouse(page, metrics.stageRect.x + 20, metrics.stageRect.y + metrics.stageRect.h - 20);
    const leftGlass = await page.evaluate(CORNER_METRICS);
    note("移出后 --mx", { bar: JSON.stringify(leftGlass.barMx), inspector: JSON.stringify(leftGlass.inspectorMx) });
    if (leftGlass.barMx !== "" || leftGlass.inspectorMx !== "") {
      problems.push(
        `指针移出卡片后高光变量没被移除：bar=${JSON.stringify(leftGlass.barMx)} inspector=${JSON.stringify(leftGlass.inspectorMx)}`,
      );
    }
    const hitAfterGlass = await page.evaluate(HIT_TEST(stageRatioX, stageRatioY));
    if (!hitAfterGlass.inStage) problems.push(`玻璃交互后画布被挡：命中 ${hitAfterGlass.tag}`);

    // 画布缩放按钮不能被右栏玻璃板盖住
    const zoomProbe = await page.evaluate(`(() => {
      const box = document.querySelector('.g2-zoom');
      if (!box) return { found: false };
      const r = box.getBoundingClientRect();
      const cs = getComputedStyle(box);
      const pt = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      const top = document.elementFromPoint(pt.x, pt.y);
      return {
        found: true,
        display: cs.display,
        rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
        topTag: top ? top.tagName : null,
        reachable: !!(top && box.contains(top)),
      };
    })()`);
    note("desktop 2d zoom", zoomProbe);
    if (zoomProbe.found && !zoomProbe.reachable) {
      problems.push(`缩放按钮被挡住：命中 ${zoomProbe.topTag}`);
    }

    // 2D 拖拽：真实指针拖动一次，确认画布收得到
    const dragStart = await page.evaluate(`(() => {
      const stage = document.querySelector('.graph-stage-layer');
      const r = stage.getBoundingClientRect();
      return { x: Math.round(r.x + r.width * 0.3), y: Math.round(r.y + r.height * 0.6) };
    })()`);
    for (const [type, dx, dy] of [["mousePressed", 0, 0], ["mouseMoved", 40, 30], ["mouseReleased", 40, 30]]) {
      await page.send("Input.dispatchMouseEvent", {
        type,
        x: dragStart.x + dx,
        y: dragStart.y + dy,
        button: type === "mouseMoved" ? "left" : "left",
        buttons: type === "mouseReleased" ? 0 : 1,
        clickCount: 1,
      });
    }
    await sleep(400);

    /* ---------- 详情打开前后：画布尺寸不变 ---------- */
    const nodePoint = await page.evaluate(`(() => {
      const node = document.querySelector('[data-node-id]');
      if (!node) return null;
      const shape = node.querySelector('.g2-shape') ?? node;
      const r = shape.getBoundingClientRect();
      if (r.width < 2) return null;
      return { id: node.dataset.nodeId, x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    if (!nodePoint) {
      problems.push("2D 舞台里找不到可点的节点");
    } else {
      const before = await page.evaluate(`(() => {
        const r = document.querySelector('.graph-stage-layer').getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height) };
      })()`);
      for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
        await page.send("Input.dispatchMouseEvent", {
          type,
          x: nodePoint.x,
          y: nodePoint.y,
          button: "left",
          buttons: type === "mouseReleased" ? 0 : 1,
          clickCount: 1,
        });
      }
      await sleep(700);
      const after = await page.evaluate(`(() => {
        const r = document.querySelector('.graph-stage-layer').getBoundingClientRect();
        const inspector = document.querySelector('.graph-inspector');
        return {
          w: Math.round(r.width),
          h: Math.round(r.height),
          hasDetail: Boolean(document.querySelector('.graph-inspector-body')),
          collapsed: inspector?.classList.contains('is-collapsed') ?? null,
        };
      })()`);
      note("canvas before/after detail", { before, after });
      if (before.w !== after.w || before.h !== after.h) {
        problems.push(`打开详情后画布尺寸变化：${JSON.stringify(before)} → ${JSON.stringify(after)}`);
      }
      if (!after.hasDetail) problems.push("点选节点后详情面板没有出现");

      // 详情可收成把手
      await page.evaluate(`document.querySelector('.graph-inspector-handle')?.click()`);
      await sleep(300);
      const collapsed = await page.evaluate(
        `document.querySelector('.graph-inspector')?.classList.contains('is-collapsed') ?? null`,
      );
      note("inspector collapsed", collapsed);
      if (collapsed !== true) problems.push("详情把手点了没有收起");
      await page.evaluate(`document.querySelector('.graph-inspector-handle')?.click()`);
      await sleep(200);
    }

    /* ---------- 控制条收起 / 展开 ---------- */
    await page.evaluate(`document.querySelector('.graph-bar-toggle')?.click()`);
    await sleep(250);
    let barState = await page.evaluate(
      `document.querySelector('.graph-toolbar-actions')?.dataset.open ?? null`,
    );
    note("bar collapsed data-open", barState);
    if (barState !== "false") problems.push(`控制条收起后 data-open=${barState}`);
    await page.evaluate(`document.querySelector('.graph-bar-toggle')?.click()`);
    await sleep(250);
    barState = await page.evaluate(
      `document.querySelector('.graph-toolbar-actions')?.dataset.open ?? null`,
    );
    if (barState !== "true") problems.push(`控制条展开后 data-open=${barState}`);

    /* ---------- 1920×1080：画布仍是整幅，窄屏安全区不生效 ---------- */
    await page.setViewport({ width: 1920, height: 1080, dpr: 1, mobile: false });
    await page.goto(`${BASE}/graph?mode=2d&depth=2`);
    await page.waitFor("Boolean(document.querySelector('.g2-stage svg'))", 60000);
    await sleep(900);
    const wide = await page.evaluate(`(() => {
      const ws = document.querySelector('.graph-workspace');
      const layer = document.querySelector('.graph-stage-layer');
      const page = document.querySelector('.graph-page');
      const r = layer.getBoundingClientRect();
      return {
        stage: { w: Math.round(r.width), h: Math.round(r.height) },
        pageWidth: Math.round(page.getBoundingClientRect().width),
        parentWidth: Math.round(page.parentElement.getBoundingClientRect().width),
        drawerFlag: ws.dataset.drawer ?? null,
      };
    })()`);
    note("1920 stage", wide);
    if (wide.drawerFlag) problems.push("桌面 1920 不该启用窄屏安全区");
    if (wide.stage.w !== wide.parentWidth) {
      problems.push(`1920 画布未全幅：${wide.stage.w}/${wide.parentWidth}`);
    }

    const wideCorners = await page.evaluate(CORNER_METRICS);
    note("1920 角落卡", {
      bar: wideCorners.bar,
      inspector: wideCorners.inspector,
      qa: wideCorners.qa,
    });
    if (Math.abs(wideCorners.bar.top - wideCorners.inspector.top) > 1) {
      problems.push(`1920 两张卡顶边不齐：${wideCorners.bar.top} / ${wideCorners.inspector.top}`);
    }
    if (wideCorners.inspector.left - wideCorners.bar.right < 16) {
      problems.push(`1920 两张卡相撞：间距 ${wideCorners.inspector.left - wideCorners.bar.right}px`);
    }
    if (wideCorners.inspector.bottom > wideCorners.qa.top) {
      problems.push(`1920 详情卡压到问图谱：${wideCorners.inspector.bottom} > ${wideCorners.qa.top}`);
    }
    await page.screenshot("graph-glass-2d-1920");
    await page.setViewport({ width: 1440, height: 900, dpr: 1, mobile: false });

    /* ---------- 四套主题：玻璃文字色必须一致 ---------- */
    const themeColors = {};
    for (const theme of ["galaxy", "pine", "sand", "midnight"]) {
      await page.evaluate(`localStorage.setItem('pakp.theme', ${JSON.stringify(theme)})`);
      await page.goto(`${BASE}/graph?mode=2d`);
      await page.waitFor("Boolean(document.querySelector('.g2-stage svg'))", 60000);
      await sleep(900);
      themeColors[theme] = await page.evaluate(`(() => {
        const el = document.querySelector('.graph-bar-title');
        const chip = document.querySelector('.graph-stage-head');
        const cs = el ? getComputedStyle(el) : null;
        return {
          title: cs ? cs.color : null,
          stageHeadBg: chip ? getComputedStyle(chip).backgroundColor : null,
        };
      })()`);
      // galaxy 就是桌面那两张，另外三套各留一张，方便并排看玻璃观感是否一致
      if (theme !== "galaxy") await page.screenshot(`graph-glass-2d-${theme}`);
    }
    note("theme title colors", themeColors);
    const uniqueTitles = new Set(Object.values(themeColors).map((item) => item.title));
    if (uniqueTitles.size !== 1) {
      problems.push(`四套主题下玻璃标题色不一致：${JSON.stringify(themeColors)}`);
    }

    /* ---------- 3D ---------- */
    await page.evaluate(`localStorage.setItem('pakp.theme', 'galaxy')`);
    await page.goto(`${BASE}/graph?mode=3d&depth=2`);
    const has3d = await page.waitFor(
      `Boolean(document.querySelector('.graph-stage-layer canvas'))`,
      90000,
    );
    note("3d canvas present", has3d);
    if (has3d) {
      await sleep(2500);
      const hit3d = await page.evaluate(
        `(() => {
          const canvas = document.querySelector('.graph-stage-layer canvas');
          const r = canvas.getBoundingClientRect();
          const el = document.elementFromPoint(Math.round(r.left + r.width * 0.35), Math.round(r.top + r.height * 0.55));
          return { inCanvas: el?.tagName === 'CANVAS', tag: el?.tagName, inGlass: Boolean(el?.closest('.graph-glass')) };
        })()`,
      );
      note("3d hit-test", hit3d);
      if (!hit3d.inCanvas) problems.push(`3D 画布中心被挡住：${hit3d.tag}`);
      await page.screenshot("graph-glass-3d-desktop");
      const stats = await page.evaluate(`window.__graphStats ?? null`);
      note("__graphStats", stats);
    } else {
      problems.push("3D 画布没有出现（swiftshader 下也应可用）");
    }

    /* ---------- 列表模式：无画布、无玻璃 ---------- */
    await page.goto(`${BASE}/graph?mode=list`);
    await page.waitFor("Boolean(document.querySelector('.graph-list'))", 60000);
    await sleep(500);
    const listState = await page.evaluate(`({
      stage: document.querySelectorAll('.graph-stage-layer').length,
      glass: document.querySelectorAll('.graph-glass').length,
      panel: document.querySelectorAll('.graph-inspector.panel').length,
    })`);
    note("list mode", listState);
    if (listState.stage !== 0) problems.push("列表模式仍挂着画布层");
    if (listState.glass !== 0) problems.push("列表模式仍挂着玻璃类");

    /* ---------- 移动端 390×844 ---------- */
    await page.setViewport({ width: 390, height: 844, dpr: 2, mobile: true });
    await page.goto(`${BASE}/graph?mode=2d&depth=2`);
    await page.waitFor("Boolean(document.querySelector('.g2-stage svg'))", 60000);
    await sleep(1200);
    const mobile = await page.evaluate(PAGE_METRICS);
    note("mobile metrics", mobile);
    note("mobile page/parent", `${mobile.pageWidth}/${mobile.parentWidth}`);
    if (mobile.pageWidth !== mobile.parentWidth) {
      problems.push(`移动端 .graph-page 未吃满：${mobile.pageWidth}/${mobile.parentWidth}`);
    }
    if (mobile.pageOverflow > 0) problems.push(`移动端横向溢出 ${mobile.pageOverflow}`);
    const mobileHit = await page.evaluate(
      `(() => {
        const el = document.elementFromPoint(Math.round(innerWidth * 0.5), Math.round(innerHeight * 0.42));
        return { tag: el?.tagName, inStage: Boolean(el?.closest('.graph-stage-layer')) };
      })()`,
    );
    note("mobile hit-test", mobileHit);
    if (!mobileHit.inStage) problems.push(`390 上半屏被挡住：${mobileHit.tag}`);
    const mobile3d = await page.evaluate(
      `[...document.querySelectorAll('.graph-mode-button')].map((b) => b.textContent.trim())`,
    );
    note("mobile mode buttons", mobile3d);
    await page.screenshot("graph-glass-2d-mobile");

    // 移动端选中实体 → 底部抽屉
    const mobileNode = await page.evaluate(`(() => {
      const node = document.querySelector('[data-node-id]');
      if (!node) return null;
      const shape = node.querySelector('.g2-shape') ?? node;
      const r = shape.getBoundingClientRect();
      return r.width < 2 ? null : { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    if (mobileNode) {
      for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
        await page.send("Input.dispatchMouseEvent", {
          type,
          x: mobileNode.x,
          y: mobileNode.y,
          button: "left",
          buttons: type === "mouseReleased" ? 0 : 1,
          clickCount: 1,
        });
      }
      await sleep(700);
      const drawer = await page.evaluate(`(() => {
        const el = document.querySelector('.graph-inspector');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return {
          visible: getComputedStyle(el).display !== 'none',
          position: getComputedStyle(el).position,
          height: Math.round(r.height),
          bottomGap: Math.round(innerHeight - r.bottom),
          ratio: Number((r.height / innerHeight).toFixed(3)),
          topFree: Math.round(r.top / innerHeight * 100) / 100,
        };
      })()`);
      note("mobile drawer", drawer);
      const layering = await page.evaluate(`(() => {
        const insp = document.querySelector('.graph-inspector');
        const qa = document.querySelector('.graph-ask-dock');
        if (!insp) return null;
        const r = insp.getBoundingClientRect();
        const pt = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height * 0.75) };
        const top = document.elementFromPoint(pt.x, pt.y);
        const cs = getComputedStyle(insp);
        return {
          z: cs.zIndex,
          bg: cs.backgroundColor,
          filter: cs.backdropFilter,
          qaZ: qa ? getComputedStyle(qa).zIndex : null,
          qaBg: qa ? getComputedStyle(qa).backgroundColor : null,
          topTag: top ? top.tagName : null,
          topInInspector: !!(top && insp.contains(top)),
          zoom: (() => {
            const z = document.querySelector('.g2-zoom');
            return z ? getComputedStyle(z).display : 'none';
          })(),
        };
      })()`);
      note("mobile layering", layering);
      if (layering && !layering.topInInspector) {
        problems.push(`移动端抽屉被盖住：命中 ${layering.topTag}`);
      }

      // ADR-027 第 14 条：选中实体与 1 跳邻居都要落在抽屉上方的安全区里（留 8px）。
      const ego = await page.evaluate(`(() => {
        const drawer = document.querySelector('.graph-inspector');
        const stage = document.querySelector('.graph-stage-layer');
        if (!drawer) return null;
        const drawerTop = drawer.getBoundingClientRect().top;
        const nodes = [...document.querySelectorAll('.g2-node')].filter(
          (n) => n.classList.contains('is-selected') || (n.classList.contains('is-lit') && !n.classList.contains('is-dim')),
        );
        if (nodes.length === 0) return null;
        let bottom = -Infinity;
        let top = Infinity;
        for (const node of nodes) {
          const r = node.getBoundingClientRect();
          if (r.height < 1) continue;
          bottom = Math.max(bottom, r.bottom);
          top = Math.min(top, r.top);
        }
        const selected = document.querySelector('.g2-node.is-selected');
        const sr = selected ? selected.getBoundingClientRect() : null;
        const layer = stage.getBoundingClientRect();
        return {
          drawerTop: Math.round(drawerTop),
          selectedBottom: sr ? Math.round(sr.bottom) : null,
          egoBottom: Math.round(bottom),
          egoTop: Math.round(top),
          egoNodes: nodes.length,
          gap: Math.round(drawerTop - bottom),
          layer: { x: Math.round(layer.x), y: Math.round(layer.y), w: Math.round(layer.width), h: Math.round(layer.height) },
        };
      })()`);
      note("mobile ego vs drawer", ego);
      if (ego) {
        if (!(ego.egoBottom <= ego.drawerTop - 8)) {
          problems.push(`1 跳邻域被抽屉压住：底边 ${ego.egoBottom} / 抽屉 ${ego.drawerTop}`);
        }
        if (!(ego.selectedBottom <= ego.drawerTop - 8)) {
          problems.push(`选中节点被抽屉压住：底边 ${ego.selectedBottom} / 抽屉 ${ego.drawerTop}`);
        }
        if (!(ego.egoTop >= 0)) problems.push(`1 跳邻域跑到视口上方：${ego.egoTop}`);
        if (ego.layer.w !== 314 || ego.layer.h !== 844) {
          problems.push(`画布层不再是全幅：${JSON.stringify(ego.layer)}`);
        }
      }
      await page.screenshot("graph-glass-2d-mobile-drawer");
      if (drawer && drawer.position !== "absolute") {
        problems.push(`移动端详情不是浮层抽屉：position=${drawer.position}`);
      }
      if (drawer && drawer.height > 844 * 0.56) {
        problems.push(`移动端抽屉超过 55dvh：${drawer.height}px`);
      }
    } else {
      problems.push("移动端 2D 舞台里找不到可点的节点");
    }

    if (page.consoleErrors.length > 0) problems.push(`console: ${page.consoleErrors.join(" | ")}`);
    if (page.pageErrors.length > 0) problems.push(`page errors: ${page.pageErrors.join(" | ")}`);
    await page.close();
  } finally {
    if (browser) await browser.close();
    await stopApp(app);
    await lightrag.close();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }

  console.log("\n===== 结论 =====");
  if (problems.length === 0) {
    console.log("全部断言通过");
    process.exit(0);
  }
  for (const problem of problems) console.log(`FAIL ${problem}`);
  process.exit(1);
}

main().catch(async (error) => {
  console.error(error);
  process.exit(1);
});
