/**
 * /graph 第三轮验收：Shift 看路径、底部问图谱卡、相关文档入口（ADR-027 / ADR-028）。
 *
 * 隔离：临时库（%TEMP%）+ AUTH_MODE=mock + 独立端口 3136 + mock LightRAG + mock 绑定大模型，
 * 不碰 `data/app.db`，也不碰 3000 上的日常服务。跑的是生产包（`next start`）。
 *
 * 断言：
 *   1. 搜索卡贴底居中（1440 / 1920 / 390 三档）、宽 min(720, 100%-32)、统一玻璃配方，
 *      旧右下角面板不再存在，页面不出现「本机模型」字样；
 *   2. 2D 里单击实体后 Shift + 单击另一实体出现 `.graph-path-bar`（含方向与跳数），
 *      选中停在起点；
 *   3. 详情里的「相关文档」能展开、列出本账号文档，点进去落在 `/workspace/<id>` 详情；
 *   4. 底部搜索框提问 → 回答卡由**绑定模型**生成（mock LLM 收到 Bearer key 与检索上下文），
 *      署名「由 custom/round3-fake-model 生成」，引用文档可点；
 *   5. 列表模式问答卡回到文档流（非玻璃）；390 下抽屉打开时搜索卡让位、不重叠；
 *   6. 3D 画布仍在，搜索卡同样贴底居中。
 *
 * 用法：node scripts/verify-graph-round3.mjs
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

const APP_PORT = Number(process.env.APP_PORT || 3136);
const CDP_PORT = Number(process.env.CDP_PORT || 9350);
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
    description: `${source} 与 ${target} 相连（${relation}）。`,
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
      // LightRAG 1.5.x：only_need_context 时 response 是检索上下文，llm_generated=false。
      return json(response, 200, {
        response: "上下文：知识管理把卡片笔记、第二大脑与渐进式总结串成一条路径。",
        references: [{ reference_id: "ref-1", file_path: filePathFor(OBJECTS[0].id) }],
        llm_generated: false,
      });
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

/* ------------------------------ mock 绑定大模型 ------------------------------ */

const llmCalls = [];

function startMockLlm() {
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString("utf8");
    if (!/\/chat\/completions$/.test(new URL(request.url ?? "/", "http://127.0.0.1").pathname)) {
      return json(response, 404, { error: "not found" });
    }
    llmCalls.push({
      path: request.url,
      auth: request.headers.authorization ?? "",
      body,
    });
    return json(response, 200, {
      choices: [
        {
          message: {
            content: "绑定模型的回答：你的笔记把卡片笔记、第二大脑和渐进式总结连成了一条知识管理路径。",
          },
        },
      ],
      model: "round3-fake-model",
    });
  });
  server.listen(0, "127.0.0.1");
  return once(server, "listening").then(() => ({
    url: `http://127.0.0.1:${server.address().port}`,
    calls: llmCalls,
    async close() {
      server.closeAllConnections?.();
      server.close();
      await Promise.race([once(server, "close"), sleep(2000)]).catch(() => {});
    },
  }));
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
      // 临时库里的模型配置整段加密落库，验收只需要一个仅本次进程使用的密钥。
      SETTINGS_ENC_KEY: "round3-harness-only-secret",
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

/* ------------------------------ 断言工具 ------------------------------ */

function near(actual, expected, tolerance = 1) {
  return typeof actual === "number" && Math.abs(actual - expected) <= tolerance;
}

const LAYOUT_METRICS = `(() => {
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
  const page = document.querySelector('.graph-page');
  const dock = document.querySelector('.graph-ask-dock');
  const form = document.querySelector('.graph-ask-form');
  const result = document.querySelector('.graph-ask-result');
  const formCs = form ? getComputedStyle(form) : null;
  const resultCs = result ? getComputedStyle(result) : null;
  return {
    viewport: { w: innerWidth, h: innerHeight },
    page: box('.graph-page'),
    parentWidth: page?.parentElement ? Math.round(page.parentElement.getBoundingClientRect().width) : null,
    pageOverflow: page ? page.scrollWidth - page.clientWidth : null,
    stage: box('.graph-stage-layer'),
    bar: box('.graph-bar'),
    inspector: box('.graph-inspector'),
    dock: box('.graph-ask-dock'),
    form: box('.graph-ask-form'),
    result: box('.graph-ask-result'),
    dockPosition: dock ? getComputedStyle(dock).position : null,
    dockDisplay: dock ? getComputedStyle(dock).display : null,
    dockInWorkspace: Boolean(dock && dock.closest('.graph-workspace')),
    formInDock: Boolean(form && form.closest('.graph-ask-dock')),
    formClass: form ? form.className : null,
    formBackdrop: formCs ? (formCs.backdropFilter || formCs.webkitBackdropFilter || 'none') : null,
    formRadius: formCs ? formCs.borderRadius : null,
    resultBackdrop: resultCs ? (resultCs.backdropFilter || resultCs.webkitBackdropFilter || 'none') : null,
    oldPanel: document.querySelectorAll('.graph-qa').length,
    glassCount: document.querySelectorAll('.graph-glass').length,
    saysLocalModel: /本机模型|本地模型/.test(document.body.innerText),
    drawer: document.querySelector('.graph-workspace')?.dataset.drawer ?? null,
    stageHead: box('.graph-stage-head'),
  };
})()`;

async function clickAt(page, x, y, modifiers = 0) {
  const point = { x: Math.round(x), y: Math.round(y) };
  await page.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    ...point,
    button: "none",
    buttons: 0,
    modifiers,
    pointerType: "mouse",
  });
  await page.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    ...point,
    button: "left",
    buttons: 1,
    clickCount: 1,
    modifiers,
    pointerType: "mouse",
  });
  await page.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    ...point,
    button: "left",
    buttons: 0,
    clickCount: 1,
    modifiers,
    pointerType: "mouse",
  });
  await sleep(450);
}

/** 2D 节点中心；同时报告该点是否真的点得到（不被浮层盖住）。 */
const NODE_POINT = (id) => `(() => {
  const node = [...document.querySelectorAll('[data-node-id]')].find(
    (item) => item.dataset.nodeId === ${JSON.stringify(id)},
  );
  if (!node) return null;
  const shape = node.querySelector('.g2-shape') ?? node;
  const r = shape.getBoundingClientRect();
  if (r.width < 2) return null;
  const x = Math.round(r.left + r.width / 2);
  const y = Math.round(r.top + r.height / 2);
  const top = document.elementFromPoint(x, y);
  return {
    id: ${JSON.stringify(id)},
    x,
    y,
    reachable: Boolean(top && node.contains(top)),
    topTag: top ? top.tagName : null,
    topClass: top ? String(top.getAttribute('class') || '') : null,
  };
})()`;

const INSPECTOR_STATE = `(() => {
  const body = document.querySelector('.graph-inspector-body');
  const path = document.querySelector('.graph-path-bar');
  return {
    selected: body ? (body.querySelector('h2')?.textContent ?? '').trim() : null,
    path: path ? path.textContent.replace(/\\s+/g, ' ').trim() : null,
  };
})()`;

async function pickNode(page, id) {
  const point = await page.evaluate(NODE_POINT(id));
  if (!point || !point.reachable) return null;
  await clickAt(page, point.x, point.y);
  return point;
}

/** 点开「相关文档」并等结果落定（入口在详情卡底部，先滚进可视区再点）。 */
async function openDocs(page) {
  const prep = await page.evaluate(`(() => {
    const el = document.querySelector('.graph-docs-toggle');
    if (!el) return null;
    el.scrollIntoView({ block: 'nearest' });
    const r = el.getBoundingClientRect();
    const x = Math.round(r.left + r.width / 2);
    const y = Math.round(r.top + r.height / 2);
    const top = document.elementFromPoint(x, y);
    return {
      x,
      y,
      reachable: Boolean(top && el.contains(top)),
      topTag: top ? top.tagName : null,
      topClass: top ? String(top.getAttribute('class') || '') : null,
      expanded: el.getAttribute('aria-expanded'),
    };
  })()`);
  if (!prep) return null;
  note("相关文档入口命中", prep);
  if (prep.reachable) await clickAt(page, prep.x, prep.y);
  else await page.evaluate(`document.querySelector('.graph-docs-toggle').click()`);
  await page.waitFor(
    `(() => {
      const body = document.querySelector('.graph-docs-body');
      if (!body) return false;
      return Boolean(body.querySelector('a')) || /还没有关联文档|没有取到|重试|正在查找/.test(body.textContent || '');
    })()`,
    15000,
  );
  await page.waitFor(
    `(() => {
      const body = document.querySelector('.graph-docs-body');
      if (!body) return false;
      return Boolean(body.querySelector('a')) || /还没有关联文档|没有取到/.test(body.textContent || '');
    })()`,
    15000,
  );
  return page.evaluate(`(() => {
    const body = document.querySelector('.graph-docs-body');
    const inspector = document.querySelector('.graph-inspector');
    if (!body) return { open: false };
    const links = [...body.querySelectorAll('a')].map((a) => ({
      href: a.getAttribute('href'),
      text: a.textContent.replace(/\\s+/g, ' ').trim(),
    }));
    let visible = null;
    if (links.length > 0 && inspector) {
      const first = body.querySelector('a').getBoundingClientRect();
      const box = inspector.getBoundingClientRect();
      visible = first.top >= box.top - 1 && first.bottom <= box.bottom + 1;
    }
    return {
      open: true,
      expanded: document.querySelector('.graph-docs-toggle')?.getAttribute('aria-expanded') ?? null,
      text: body.textContent.replace(/\\s+/g, ' ').trim().slice(0, 200),
      links,
      visible,
    };
  })()`);
}

/* ------------------------------ 主流程 ------------------------------ */

async function main() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pakp-r3-"));
  const dbFile = path.join(dir, "round3.db");
  await seedDatabase(dbFile);
  const lightrag = await startMockLightrag();
  const llm = await startMockLlm();
  let app = null;
  let browser = null;

  try {
    app = await startApp({ dbFile, lightragUrl: lightrag.url });
    browser = await launchBrowser();
    const page = await openPage(browser.cdp);

    /* ---------- 绑定大模型：走设置接口换成 mock LLM ---------- */
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(`${BASE}/graph?mode=2d&depth=2`);
    await page.waitFor("Boolean(document.querySelector('.g2-stage svg'))", 90000);

    const saved = await page.evaluate(
      `(async () => {
        const response = await fetch('/api/settings/llm', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            provider: 'custom',
            baseUrl: ${JSON.stringify(llm.url)},
            model: 'round3-fake-model',
            timeoutMs: 60000,
            apiKey: 'round3-key',
          }),
        });
        return { status: response.status, body: await response.json().catch(() => null) };
      })()`,
    );
    note("绑定大模型 PUT", { status: saved.status, provider: saved.body?.provider, model: saved.body?.model, hasKey: saved.body?.hasKey });
    if (saved.status !== 200 || saved.body?.model !== "round3-fake-model") {
      problems.push(`绑定大模型失败：HTTP ${saved.status} ${JSON.stringify(saved.body)}`);
    }
    await sleep(600);

    /* ---------- 桌面 1440×900：底部居中搜索卡 ---------- */
    let metrics = await page.evaluate(LAYOUT_METRICS);
    note("1440 layout", {
      page: metrics.page,
      parentWidth: metrics.parentWidth,
      stage: metrics.stage,
      bar: metrics.bar,
      inspector: metrics.inspector,
      dock: metrics.dock,
      form: metrics.form,
    });
    if (metrics.page?.w !== metrics.parentWidth) {
      problems.push(`.graph-page 未吃满内容区：${metrics.page?.w} vs ${metrics.parentWidth}`);
    }
    if (metrics.pageOverflow > 0) problems.push(`.graph-page 横向溢出 ${metrics.pageOverflow}`);
    if (metrics.oldPanel !== 0) problems.push(`旧的右下角 .graph-qa 面板还在：${metrics.oldPanel}`);
    if (!metrics.formInDock) problems.push("搜索卡不在 .graph-ask-dock 里");
    if (metrics.dockInWorkspace !== true) problems.push("搜索卡不在图谱工作区里");
    if (metrics.dockPosition !== "absolute") problems.push(`搜索卡不是浮层定位：${metrics.dockPosition}`);
    if (!/blur\(14px\)/.test(metrics.formBackdrop ?? "")) {
      problems.push(`搜索卡不是 14px 玻璃配方：${metrics.formBackdrop}`);
    }
    if (!/graph-glass/.test(metrics.formClass ?? "")) {
      problems.push(`搜索卡没有统一玻璃类：${metrics.formClass}`);
    }
    // 居中的基准是图谱内容区（左侧还有 300px 应用导航），不是整个视口。
    const dockCenter = (metrics.dock.left + metrics.dock.right) / 2;
    const viewCenter = (metrics.page.left + metrics.page.right) / 2;
    note("1440 搜索卡居中 / 底距 / 宽度", `${dockCenter} vs ${viewCenter} / ${metrics.viewport.h - metrics.dock.bottom} / ${metrics.dock.w}`);
    if (!near(dockCenter, viewCenter, 1)) {
      problems.push(`搜索卡没有水平居中：中心 ${dockCenter}，视口中心 ${viewCenter}`);
    }
    if (!near(metrics.viewport.h - metrics.dock.bottom, 16, 1)) {
      problems.push(`搜索卡底距不是 16px：${metrics.viewport.h - metrics.dock.bottom}`);
    }
    if (!near(metrics.dock.w, Math.min(720, metrics.page.w - 32), 2)) {
      problems.push(`搜索卡宽度不是 min(720, 100%-32)：${metrics.dock.w}`);
    }
    if (metrics.inspector && metrics.dock.top < metrics.inspector.bottom) {
      problems.push(`详情卡与搜索卡重叠：详情底 ${metrics.inspector.bottom} / 搜索顶 ${metrics.dock.top}`);
    }
    if (metrics.saysLocalModel) problems.push("页面仍出现「本机模型」/「本地模型」字样");
    if (metrics.form && metrics.stage) {
      const inside = await page.evaluate(
        `(() => {
          const form = document.querySelector('.graph-ask-form');
          const r = form.getBoundingClientRect();
          const el = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
          return { tag: el ? el.tagName : null, inForm: Boolean(el && form.contains(el)) };
        })()`,
      );
      note("搜索卡可点性", inside);
      if (!inside.inForm) problems.push(`搜索卡被画布盖住：命中 ${inside.tag}`);
    }
    await page.screenshot("graph-r3-2d-desktop");

    /* ---------- 问题1：Shift + 单击两个实体看路径 ---------- */
    const first = await pickNode(page, CENTER);
    note("问题1 起点", first);
    if (!first) problems.push(`找不到可点的中心实体 ${CENTER}`);
    let afterFirst = await page.evaluate(INSPECTOR_STATE);
    note("问题1 单击选中", afterFirst);
    if (afterFirst.selected !== CENTER) problems.push(`单击没有选中 ${CENTER}：${afterFirst.selected}`);

    let endpoint = null;
    let afterShift = null;
    for (const candidate of RING1.map(([id]) => id)) {
      if (candidate === CENTER) continue;
      const point = await page.evaluate(NODE_POINT(candidate));
      if (!point || !point.reachable) continue;
      await clickAt(page, point.x, point.y, 8);
      const state = await page.evaluate(INSPECTOR_STATE);
      if (state.path) {
        endpoint = { id: candidate, point };
        afterShift = state;
        break;
      }
    }
    note("问题1 Shift 终点 / 路径条", afterShift ?? null);
    if (!endpoint || !afterShift) {
      problems.push("Shift + 单击没有出现路径条");
    } else {
      if (!afterShift.path.includes("→")) problems.push(`路径条文案不对：${afterShift.path}`);
      if (!/跳$|跳 ·|跳\s/.test(afterShift.path) && !/\d+ 跳/.test(afterShift.path)) {
        problems.push(`路径条没有跳数：${afterShift.path}`);
      }
      if (afterShift.selected !== CENTER) {
        problems.push(`Shift 后选中被换掉了（应保持起点）：${afterShift.selected}`);
      }
      note("问题1 结果", `${CENTER} → ${endpoint.id}：${afterShift.path}`);
    }
    await page.screenshot("graph-r3-path");

    /* ---------- 问题3：相关文档入口 → 文章详情 ---------- */
    const docs = await openDocs(page);
    note("问题3 相关文档", docs);
    if (!docs || !docs.open) {
      problems.push("详情里没有「相关文档」入口");
    } else {
      if (docs.expanded !== "true") problems.push(`相关文档 aria-expanded=${docs.expanded}`);
      if (!docs.links || docs.links.length === 0) {
        problems.push(`相关文档没有列出条目：${docs.text}`);
      } else {
        if (docs.visible !== true) problems.push("展开后相关文档列表不在详情卡可视区内");
        const target = docs.links[0];
        if (!/^\/workspace\/[0-9a-z-]+$/.test(target.href ?? "")) {
          problems.push(`相关文档链接不是文章详情：${target.href}`);
        }
        note("问题3 首条", target);
        await page.screenshot("graph-r3-docs");
        await page.evaluate(`document.querySelector('.graph-docs-body a').click()`);
        const arrived = await page.waitFor(
          `location.pathname === ${JSON.stringify(target.href)} && Boolean(document.querySelector('.app-frame[data-selected="true"]'))`,
          20000,
        );
        const landed = await page.evaluate(`({
          path: location.pathname,
          selected: document.querySelector('.app-frame')?.dataset.selected ?? null,
          title: document.body.innerText.includes('玻璃验收样本') ? '含样本标题' : '缺样本标题',
        })`);
        note("问题3 跳转", landed);
        if (!arrived) problems.push(`相关文档点击后没落在文章详情：${JSON.stringify(landed)}`);
        await page.screenshot("graph-r3-doc-detail");
      }
    }

    /* ---------- 问题2：底部搜索框用绑定大模型回答 ---------- */
    await page.goto(`${BASE}/graph?mode=2d&depth=2`);
    await page.waitFor("Boolean(document.querySelector('.g2-stage svg'))", 90000);
    await sleep(900);

    const inputBox = await page.evaluate(`(() => {
      const input = document.querySelector('.graph-ask-input');
      const r = input.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    })()`);
    await clickAt(page, inputBox.x, inputBox.y);
    await page.send("Input.insertText", { text: "知识管理有哪些方法？" });
    await sleep(200);
    const typed = await page.evaluate(`document.querySelector('.graph-ask-input').value`);
    note("问题2 输入", typed);
    if (typed !== "知识管理有哪些方法？") problems.push(`搜索框没有接收输入：${typed}`);

    const submitBox = await page.evaluate(`(() => {
      const button = document.querySelector('.graph-ask-submit');
      const r = button.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), disabled: button.disabled };
    })()`);
    if (submitBox.disabled) problems.push("提问按钮在输入后仍是禁用");
    await clickAt(page, submitBox.x, submitBox.y);

    const answered = await page.waitFor(
      `Boolean(document.querySelector('.graph-ask-result .graph-ask-answer, .graph-ask-result .graph-ask-error'))`,
      20000,
    );
    note("问题2 出答案", answered);
    if (!answered) {
      problems.push("提问后没有出现回答卡");
    } else {
      const answer = await page.evaluate(`(() => {
        const result = document.querySelector('.graph-ask-result');
        if (!result) return null;
        const r = result.getBoundingClientRect();
        const form = document.querySelector('.graph-ask-form').getBoundingClientRect();
        const cs = getComputedStyle(result);
        return {
          text: (result.querySelector('.graph-ask-answer')?.textContent ?? '').replace(/\\s+/g, ' ').trim(),
          error: result.querySelector('.graph-ask-error')?.textContent?.trim() ?? null,
          question: result.querySelector('.graph-ask-question')?.textContent?.trim() ?? null,
          model: result.querySelector('.graph-ask-model')?.textContent?.trim() ?? null,
          refs: [...result.querySelectorAll('.graph-ask-refs a')].map((a) => ({
            href: a.getAttribute('href'),
            text: a.textContent.replace(/\\s+/g, ' ').trim(),
          })),
          entities: result.querySelectorAll('.graph-ask-entity').length,
          rect: { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width) },
          formTop: Math.round(form.top),
          backdrop: cs.backdropFilter || cs.webkitBackdropFilter || 'none',
          isGlass: result.classList.contains('graph-glass'),
        };
      })()`);
      note("问题2 回答卡", answer);
      if (!answer) {
        problems.push("读不到回答卡");
      } else {
        if (answer.error) problems.push(`问答失败：${answer.error}`);
        if (!answer.text.includes("绑定模型的回答")) {
          problems.push(`回答不是绑定模型生成的：${answer.text.slice(0, 80)}`);
        }
        if (!/由 custom\/round3-fake-model 生成/.test(answer.model ?? "")) {
          problems.push(`模型署名不对：${answer.model}`);
        }
        if (!answer.isGlass || !/blur\(14px\)/.test(answer.backdrop ?? "")) {
          problems.push(`结果卡不是同一套玻璃：${answer.isGlass} / ${answer.backdrop}`);
        }
        if (!(answer.rect.bottom <= answer.formTop + 1)) {
          problems.push(`结果卡压住搜索卡：${answer.rect.bottom} > ${answer.formTop}`);
        }
        if (!answer.refs.some((ref) => /^\/workspace\/[0-9a-z-]+$/.test(ref.href ?? ""))) {
          problems.push(`回答没有引用文档链接：${JSON.stringify(answer.refs)}`);
        }
        if (answer.entities < 1) note("提示：回答里没有实体胶囊", answer.entities);
        await page.screenshot("graph-r3-answer");

        // 引用文档点得进去
        if (answer.refs.length > 0) {
          await page.evaluate(`document.querySelector('.graph-ask-refs a').click()`);
          const refArrived = await page.waitFor(
            `location.pathname.startsWith('/workspace/') && Boolean(document.querySelector('.app-frame[data-selected="true"]'))`,
            20000,
          );
          note("问题2 引用跳转", await page.evaluate("location.pathname"));
          if (!refArrived) problems.push("回答里的引用文档点不进文章详情");
        }
      }
    }

    note("mock LLM 调用", llm.calls.map((call) => ({
      path: call.path,
      auth: call.auth,
      model: (() => {
        try {
          return JSON.parse(call.body).model;
        } catch {
          return null;
        }
      })(),
      usesContext: call.body.includes("知识管理把卡片笔记"),
    })));
    if (llm.calls.length !== 1) problems.push(`绑定模型调用次数 ${llm.calls.length}（应为 1）`);
    if (llm.calls[0]?.auth !== "Bearer round3-key") problems.push("绑定模型请求没有带 API Key");
    if (!/知识管理把卡片笔记/.test(llm.calls[0]?.body ?? "")) {
      problems.push("发给绑定模型的请求里没有检索上下文");
    }

    /* ---------- Esc 关闭结果卡 ---------- */
    await page.goto(`${BASE}/graph?mode=2d&depth=2`);
    await page.waitFor("Boolean(document.querySelector('.g2-stage svg'))", 60000);
    await sleep(700);

    /* ---------- 1920×1080 ---------- */
    await page.setViewport({ width: 1920, height: 1080, dpr: 1, mobile: false });
    await page.goto(`${BASE}/graph?mode=2d&depth=2`);
    await page.waitFor("Boolean(document.querySelector('.g2-stage svg'))", 60000);
    await sleep(900);
    const wide = await page.evaluate(LAYOUT_METRICS);
    note("1920 搜索卡", { dock: wide.dock, page: wide.page, stage: wide.stage, viewport: wide.viewport });
    if (!near((wide.dock.left + wide.dock.right) / 2, (wide.page.left + wide.page.right) / 2, 1)) {
      problems.push("1920 搜索卡没有居中");
    }
    if (!near(wide.dock.w, 720, 2)) problems.push(`1920 搜索卡宽度 ${wide.dock.w}（应 720）`);
    if (!near(wide.viewport.h - wide.dock.bottom, 16, 1)) {
      problems.push(`1920 搜索卡底距 ${wide.viewport.h - wide.dock.bottom}`);
    }
    if (wide.stage.w !== wide.parentWidth) problems.push(`1920 画布未全幅：${wide.stage.w}/${wide.parentWidth}`);
    await page.screenshot("graph-r3-2d-1920");

    /* ---------- 列表模式：文档流里的同一张卡（非玻璃） ---------- */
    await page.setViewport({ width: 1440, height: 900, dpr: 1, mobile: false });
    await page.goto(`${BASE}/graph?mode=list`);
    await page.waitFor("Boolean(document.querySelector('.graph-list'))", 60000);
    const list = await page.evaluate(`(() => {
      const dock = document.querySelector('.graph-ask-dock');
      const form = document.querySelector('.graph-ask-form');
      const page = document.querySelector('.graph-page');
      const r = dock.getBoundingClientRect();
      const p = page.getBoundingClientRect();
      return {
        stage: document.querySelectorAll('.graph-stage-layer').length,
        static: dock.classList.contains('is-static'),
        position: getComputedStyle(dock).position,
        glass: document.querySelectorAll('.graph-glass').length,
        formClass: form.className,
        width: Math.round(r.width),
        centered: Math.abs((r.left + r.right) / 2 - (p.left + p.right) / 2) < 2,
      };
    })()`);
    note("list mode", list);
    if (list.stage !== 0) problems.push("列表模式仍挂着画布层");
    if (!list.static) problems.push("列表模式的问答卡不是文档流里的静态卡");
    if (list.glass !== 0) problems.push(`列表模式仍挂着 ${list.glass} 张玻璃卡`);
    if (!list.centered) problems.push("列表模式的问答卡没有居中");

    /* ---------- 移动端 390×844 ---------- */
    await page.setViewport({ width: 390, height: 844, dpr: 2, mobile: true });
    await page.goto(`${BASE}/graph?mode=2d&depth=2`);
    await page.waitFor("Boolean(document.querySelector('.g2-stage svg'))", 60000);
    await sleep(1200);
    const mobile = await page.evaluate(LAYOUT_METRICS);
    note("390 搜索卡", { dock: mobile.dock, page: mobile.page, drawer: mobile.drawer, overflow: mobile.pageOverflow });
    if (!near(mobile.dock.left, mobile.page.left + 12, 1) || !near(mobile.page.right - mobile.dock.right, 12, 1)) {
      problems.push(`390 搜索卡左右不是 12px：左 ${mobile.dock.left - mobile.page.left} 右 ${mobile.page.right - mobile.dock.right}`);
    }
    if (!near(mobile.viewport.h - mobile.dock.bottom, 12, 1)) {
      problems.push(`390 搜索卡底距 ${mobile.viewport.h - mobile.dock.bottom}`);
    }
    if (mobile.pageOverflow > 0) problems.push(`390 横向溢出 ${mobile.pageOverflow}`);
    await page.screenshot("graph-r3-2d-mobile");

    const mobileNode = await page.evaluate(NODE_POINT(CENTER));
    if (!mobileNode || !mobileNode.reachable) {
      problems.push("390 下找不到可点的中心实体");
    } else {
      await clickAt(page, mobileNode.x, mobileNode.y);
      const drawer = await page.evaluate(`(() => {
        const workspace = document.querySelector('.graph-workspace');
        const dock = document.querySelector('.graph-ask-dock');
        const inspector = document.querySelector('.graph-inspector');
        const r = inspector.getBoundingClientRect();
        return {
          drawer: workspace?.dataset.drawer ?? null,
          dockDisplay: dock ? getComputedStyle(dock).display : null,
          inspector: { position: getComputedStyle(inspector).position, top: Math.round(r.top), h: Math.round(r.height) },
          overlap: Boolean(inspector && dock && getComputedStyle(dock).display !== 'none' &&
            !(dock.getBoundingClientRect().bottom < r.top || dock.getBoundingClientRect().top > r.bottom)),
        };
      })()`);
      note("390 详情抽屉", drawer);
      if (drawer.drawer !== "true") problems.push(`390 选中后没进抽屉态：${drawer.drawer}`);
      if (drawer.dockDisplay !== "none") problems.push("390 抽屉打开时搜索卡没有让位");
      if (drawer.overlap) problems.push("390 搜索卡与详情抽屉重叠");
      if (drawer.inspector.position !== "absolute") problems.push("390 详情不是浮层抽屉");
      await page.screenshot("graph-r3-2d-mobile-drawer");
    }

    /* ---------- 3D：画布仍可用，搜索卡仍在底部居中 ---------- */
    await page.setViewport({ width: 1440, height: 900, dpr: 1, mobile: false });
    await page.goto(`${BASE}/graph?mode=3d&depth=2`);
    const has3d = await page.waitFor("Boolean(document.querySelector('.graph-stage-layer canvas'))", 90000);
    note("3D canvas", has3d);
    if (!has3d) {
      problems.push("3D 画布没有出现（swiftshader 下也应可用）");
    } else {
      await sleep(3000);
      const threeD = await page.evaluate(LAYOUT_METRICS);
      note("3D 搜索卡", { dock: threeD.dock, page: threeD.page });
      if (!near((threeD.dock.left + threeD.dock.right) / 2, (threeD.page.left + threeD.page.right) / 2, 1)) {
        problems.push("3D 搜索卡没有居中");
      }
      const center = await page.evaluate(`(() => {
        const canvas = document.querySelector('.graph-stage-layer canvas');
        const r = canvas.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      })()`);
      await clickAt(page, center.x, center.y);
      await sleep(600);
      const selected3d = await page.evaluate(INSPECTOR_STATE);
      note("3D 单击画布中心", selected3d);
      await page.screenshot("graph-r3-3d-desktop");
    }

    if (page.consoleErrors.length > 0) problems.push(`console: ${page.consoleErrors.join(" | ")}`);
    if (page.pageErrors.length > 0) problems.push(`page errors: ${page.pageErrors.join(" | ")}`);
    await page.close();
  } finally {
    if (browser) await browser.close();
    await stopApp(app);
    await lightrag.close();
    await llm.close();
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
