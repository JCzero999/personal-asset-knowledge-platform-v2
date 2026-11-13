/**
 * 我对 /graph 玻璃改版的独立验收（临时脚本，验完删除）。
 * 夹具自建（假 LightRAG），断言与 Designer 那套无共用代码。
 * 隔离：临时库 + AUTH_MODE=mock + 端口 3133 + NEXT_DIST_DIR=.next-glass-ego。
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";

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

const APP_PORT = Number(process.env.APP_PORT || 3133);
const CDP_PORT = Number(process.env.CDP_PORT || 9343);
const BASE = `http://localhost:${APP_PORT}`;
const OWNER = "mock-local-user";
const OUT = path.join(os.tmpdir(), "pakp-ego-shots");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const OBJECTS = [
  { id: "6e0b1f10-3b28-4a61-9e3a-8c1d2f4a7c51", title: "验收夹具一" },
  { id: "6e0b1f10-3b28-4a61-9e3a-8c1d2f4a7c52", title: "验收夹具二" },
  { id: "6e0b1f10-3b28-4a61-9e3a-8c1d2f4a7c53", title: "验收夹具三" },
];
const fileOf = (objectId) =>
  `pakp:obj:${objectId}:${createHash("sha256").update(objectId).digest("hex").slice(0, 12)}`;

const CENTER = "知识管理";
const RING1 = ["卡片笔记", "第二大脑", "渐进式总结", "PARA 方法", "常青笔记", "林默", "内容工作室", "深度工作"];
const RING2 = Array.from({ length: 12 }, (_, index) => `二环实体${String(index + 1).padStart(2, "0")}`);
const ENTITIES = [CENTER, ...RING1, ...RING2].map((id, index) => ({
  id,
  type: ["概念", "方法", "人物", "机构", "作品"][index % 5],
  filePath: fileOf(OBJECTS[index % OBJECTS.length].id),
}));
const byId = new Map(ENTITIES.map((item) => [item.id, item]));
const EDGES = [];
for (const id of RING1) {
  EDGES.push({ source: CENTER, target: id, filePath: fileOf(OBJECTS[EDGES.length % 3].id) });
}
RING2.forEach((id, index) => {
  EDGES.push({ source: RING1[index % RING1.length], target: id, filePath: fileOf(OBJECTS[index % 3].id) });
});
const LABELS = [CENTER, ...RING1.slice(0, 5)];

function neighborhood(label, depth, maxNodes) {
  const adjacency = new Map(ENTITIES.map((item) => [item.id, []]));
  for (const edge of EDGES) {
    adjacency.get(edge.source)?.push(edge.target);
    adjacency.get(edge.target)?.push(edge.source);
  }
  const distance = new Map([[label, 0]]);
  const queue = [label];
  while (queue.length) {
    const id = queue.shift();
    const d = distance.get(id) ?? 0;
    if (d >= depth) continue;
    for (const next of adjacency.get(id) ?? []) {
      if (!distance.has(next)) {
        distance.set(next, d + 1);
        queue.push(next);
      }
    }
  }
  let ids = [...distance.keys()];
  if (ids.length > maxNodes) ids = ids.slice(0, maxNodes);
  const kept = new Set(ids);
  return {
    nodes: ids.map((id) => ({
      id,
      labels: ["Entity"],
      properties: {
        entity_type: byId.get(id)?.type ?? "概念",
        description: `${id} 的验收描述。`,
        file_path: byId.get(id)?.filePath ?? fileOf(OBJECTS[0].id),
      },
    })),
    edges: EDGES.filter((edge) => kept.has(edge.source) && kept.has(edge.target)).map((edge) => ({
      source: edge.source,
      target: edge.target,
      properties: { description: `${edge.source}<SEP>${edge.target} 相连`, file_path: edge.filePath },
    })),
  };
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(body);
}

async function startFakeLightrag() {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/graph/label/list") return sendJson(response, 200, LABELS);
    if (url.pathname === "/graphs") {
      return sendJson(
        response,
        200,
        neighborhood(
          url.searchParams.get("label") ?? "",
          Number(url.searchParams.get("max_depth") || 2),
          Number(url.searchParams.get("max_nodes") || 200),
        ),
      );
    }
    if (url.pathname === "/documents/paginated") {
      return sendJson(response, 200, {
        documents: OBJECTS.map((object, index) => ({
          id: `doc-ego-${index}`,
          file_path: fileOf(object.id),
          status: "processed",
          chunks_count: 2,
          error_msg: null,
        })),
        pagination: { total_count: OBJECTS.length },
      });
    }
    if (url.pathname === "/query") return sendJson(response, 200, { response: "验收问答。", references: [] });
    sendJson(response, 404, { detail: "not mocked" });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: async () => {
      server.closeAllConnections?.();
      server.close();
      await Promise.race([once(server, "close"), sleep(1500)]).catch(() => {});
    },
  };
}

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
  for (const object of OBJECTS) insert.run(object.id, object.title, "玻璃验收夹具", OWNER, now, now);
  sqlite.close();
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) return;
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`${method} timeout`));
        }
      }, 120000);
    });
  }
}

async function main() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "pakp-ego-"));
  const dbFile = path.join(tempDir, "app.db");
  await seedDatabase(dbFile);
  await mkdir(OUT, { recursive: true });
  const fake = await startFakeLightrag();

  const app = spawn(process.execPath, [NEXT_BIN, "dev", "-p", String(APP_PORT)], {
    cwd: ROOT,
    env: {
      ...process.env,
      AUTH_MODE: "mock",
      DATABASE_PATH: dbFile,
      LIGHTRAG_BASE_URL: fake.url,
      LIGHTRAG_API_KEY: "ego-key",
      NEXT_DIST_DIR: ".next-glass-ego",
      NEXT_TELEMETRY_DISABLED: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const logs = [];
  app.stdout.on("data", (chunk) => logs.push(chunk.toString()));
  app.stderr.on("data", (chunk) => logs.push(chunk.toString()));

  const chromeDir = await mkdtemp(path.join(os.tmpdir(), "pakp-ego-chrome-"));
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${chromeDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--enable-unsafe-swiftshader",
      "about:blank",
    ],
    { stdio: "ignore", windowsHide: true },
  );

  try {
    const started = Date.now();
    let ready = false;
    while (Date.now() - started < 180000 && !ready) {
      try {
        const response = await fetch(`${BASE}/api/health`);
        const data = await response.json();
        ready = response.ok && data.authMode === "mock";
      } catch {
        // 启动中
      }
      if (!ready) await sleep(400);
    }
    if (!ready) throw new Error("应用未就绪");

    let version = null;
    for (let index = 0; index < 40 && !version; index += 1) {
      try {
        version = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json();
      } catch {
        await sleep(250);
      }
    }
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
      const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? "evaluate");
      return result.result?.value;
    };
    const waitFor = async (expression, timeout = 60000) => {
      const from = Date.now();
      while (Date.now() - from < timeout) {
        try {
          if (await evaluate(expression)) return true;
        } catch {
          // 导航中
        }
        await sleep(200);
      }
      return false;
    };
    const click = async (x, y) => {
      for (const type of ["mousePressed", "mouseReleased"]) {
        await send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
      }
    };
    const dblclick = async (x, y) => {
      for (const count of [1, 2]) {
        for (const type of ["mousePressed", "mouseReleased"]) {
          await send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: count });
        }
      }
    };
    const viewport = (width, height) =>
      send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 640 });
    const shot = async (name) => {
      const { data } = await send("Page.captureScreenshot", { format: "png" });
      const file = path.join(OUT, `${name}.png`);
      await writeFile(file, Buffer.from(data, "base64"));
      return file;
    };

    await send("Page.enable");
    await send("Runtime.enable");
    const results = [];
    const record = (name, pass, detail) => {
      results.push({ name, pass, detail });
      console.log(`${pass ? "PASS" : "FAIL"} ${name} — ${detail}`);
    };

    /* ---------------- 桌面 1440×900 ---------------- */
    await viewport(1440, 900);
    await send("Page.navigate", { url: `${BASE}/graph` });
    await waitFor(`!!document.querySelector('.graph-stage-layer') || !!document.querySelector('.graph-state-card')`, 90000);
    await sleep(3000);
    const desk = await evaluate(`(() => {
      const ws = document.querySelector('.graph-workspace');
      const page = document.querySelector('.graph-page');
      const layer = document.querySelector('.graph-stage-layer');
      const bar = document.querySelector('.graph-bar');
      const main = document.querySelector('.graph-main');
      const inspector = document.querySelector('.graph-inspector');
      const canvas = document.querySelector('.graph-stage-layer canvas');
      const r = (el) => el ? el.getBoundingClientRect() : null;
      const rect = (el) => { const b = r(el); return b ? { x: b.x, y: b.y, w: b.width, h: b.height, right: b.right, bottom: b.bottom } : null; };
      const style = (el, prop) => el ? getComputedStyle(el)[prop] : null;
      return {
        mode: ws?.dataset.mode, float: ws?.classList.contains('is-float'),
        pageWidth: rect(page)?.w, parentWidth: page?.parentElement?.clientWidth,
        ws: rect(ws), layer: rect(layer), bar: rect(bar), inspector: rect(inspector),
        canvas: rect(canvas),
        backdrop: style(bar, 'backdropFilter'), barBg: style(bar, 'backgroundColor'),
        barZ: style(bar, 'zIndex'), layerZ: style(layer, 'zIndex'),
        mainPe: style(main, 'pointerEvents'), barPe: style(bar, 'pointerEvents'),
        inspectorPe: style(inspector, 'pointerEvents'),
        glass: document.querySelectorAll('.graph-glass').length,
        stateCard: !!document.querySelector('.graph-state-card'),
        toolbarText: (document.querySelector('.graph-bar-title')?.textContent ?? ''),
      };
    })()`);
    record("星图是背景层（无空态卡片）", desk.float && !!desk.layer && !desk.stateCard, `mode=${desk.mode} layer=${!!desk.layer} stateCard=${desk.stateCard}`);
    record(
      "内容区吃满（page == 父容器）",
      Math.abs(desk.pageWidth - desk.parentWidth) <= 1 && desk.ws.w === desk.pageWidth,
      `page=${Math.round(desk.pageWidth)} 父=${desk.parentWidth}`,
    );
    // 1440 下内容区本来就只有 1140，看不出 1180 上限；用 1920 再看一次。
    await viewport(1920, 1080);
    await send("Page.navigate", { url: `${BASE}/graph` });
    await waitFor(`!!document.querySelector('.graph-workspace')`, 60000);
    await sleep(2500);
    const wide = await evaluate(`(() => {
      const page = document.querySelector('.graph-page').getBoundingClientRect();
      const layer = document.querySelector('.graph-stage-layer')?.getBoundingClientRect();
      return { page: page.width, parent: document.querySelector('.graph-page').parentElement.clientWidth,
               layer: layer ? layer.width : 0, mode: document.querySelector('.graph-workspace')?.dataset.mode };
    })()`);
    record(
      "1920 宽下仍吃满、无 1180 上限",
      wide.page > 1180 && Math.abs(wide.page - wide.parent) <= 1 && Math.abs(wide.layer - wide.page) <= 1,
      `page=${Math.round(wide.page)} 父=${wide.parent} layer=${Math.round(wide.layer)}`,
    );
    await shot("ego-3d-1920");
    await viewport(1440, 900);
    await send("Page.navigate", { url: `${BASE}/graph` });
    await waitFor(`!!document.querySelector('.graph-workspace')`, 60000);
    await sleep(2000);
    record(
      "画布层覆盖整个工作区",
      Math.abs(desk.layer.w - desk.ws.w) <= 1 && Math.abs(desk.layer.h - desk.ws.h) <= 1,
      `layer=${Math.round(desk.layer.w)}×${Math.round(desk.layer.h)} ws=${Math.round(desk.ws.w)}×${Math.round(desk.ws.h)}`,
    );
    const blur = /blur\(([\d.]+)px\)/.exec(desk.backdrop ?? "");
    record(
      "玻璃配方 blur(14px) 且 ≤18px",
      blur !== null && Number(blur[1]) === 14 && (desk.backdrop ?? "").includes("saturate(1.3"),
      `backdrop=${desk.backdrop}`,
    );
    const alpha = (() => {
      const value = desk.barBg ?? "";
      const slash = /\/\s*([\d.]+)\s*\)$/.exec(value);
      if (slash) return Number(slash[1]);
      const match = /rgba?\(([^)]+)\)/.exec(value);
      if (!match) return null;
      const parts = match[1].split(",").map(Number);
      return parts.length === 4 ? parts[3] : 1;
    })();
    record("玻璃底半透明（约 72%）", alpha !== null && alpha > 0.6 && alpha < 0.8, `bg=${desk.barBg}`);
    record("浮层在画布之上", Number(desk.barZ) > Number(desk.layerZ), `bar z=${desk.barZ} layer z=${desk.layerZ}`);
    record(
      "指针分层：容器不接手势、面板接",
      desk.mainPe === "none" && desk.barPe === "auto" && desk.inspectorPe === "auto",
      `main=${desk.mainPe} bar=${desk.barPe} inspector=${desk.inspectorPe}`,
    );
    const hits = await evaluate(`(() => {
      const b = document.querySelector('.graph-workspace').getBoundingClientRect();
      return [[0.35, 0.7], [0.15, 0.5], [0.8, 0.7]].map(([fx, fy]) => {
        const el = document.elementFromPoint(b.x + b.width * fx, b.y + b.height * fy);
        return { x: Math.round(b.x + b.width * fx), y: Math.round(b.y + b.height * fy),
                 tag: el?.tagName ?? null, stage: !!el?.closest('.graph-stage-layer'),
                 glass: !!el?.closest('.graph-glass') };
      });
    })()`);
    record("空白处指针落到底下画布", hits.filter((h) => h.stage).length >= 2, JSON.stringify(hits));
    record("3D 画布已挂载且尺寸跟随", !!desk.canvas && Math.abs(desk.canvas.w - desk.ws.w) <= 2, `canvas=${desk.canvas ? Math.round(desk.canvas.w) + "×" + Math.round(desk.canvas.h) : "无"}`);
    await shot("ego-3d-1440");

    /* ---------------- 控制条可收起，画布不重排 ---------------- */
    const toggleBox = await evaluate(`(() => {
      const button = document.querySelector('.graph-bar-toggle');
      const b = button?.getBoundingClientRect();
      return b ? { x: b.x + b.width / 2, y: b.y + b.height / 2, text: button.textContent } : null;
    })()`);
    if (toggleBox) {
      const barBefore = await evaluate(`document.querySelector('.graph-bar').getBoundingClientRect().height`);
      await click(toggleBox.x, toggleBox.y);
      await sleep(600);
      const collapsed = await evaluate(`(() => ({
        bar: document.querySelector('.graph-bar').getBoundingClientRect().height,
        canvas: (() => { const c = document.querySelector('.graph-stage-layer canvas')?.getBoundingClientRect();
          return c ? { w: c.width, h: c.height } : null; })(),
        expanded: document.querySelector('.graph-bar-toggle')?.getAttribute('aria-expanded'),
      }))()`);
      record(
        "控制条可收起且画布尺寸不变",
        collapsed.bar < barBefore - 8 && collapsed.expanded === "false" &&
          Math.abs(collapsed.canvas.w - desk.ws.w) <= 2,
        `bar ${Math.round(barBefore)} → ${Math.round(collapsed.bar)}px canvas=${collapsed.canvas ? Math.round(collapsed.canvas.w) + "×" + Math.round(collapsed.canvas.h) : "无"}`,
      );
      await click(toggleBox.x, toggleBox.y);
      await sleep(500);
    } else {
      record("控制条可收起且画布尺寸不变", false, "桌面没有收起按钮");
    }

    /* ---------------- 2D：选中/双击 ---------------- */
    await send("Page.navigate", { url: `${BASE}/graph?mode=2d` });
    await waitFor(`!!document.querySelector('.g2-nodes [aria-label]')`, 90000);
    await sleep(1200);
    const before = await evaluate(`(() => {
      const layer = document.querySelector('.graph-stage-layer').getBoundingClientRect();
      const node = document.querySelector('.g2-nodes [aria-label]');
      const b = node?.getBoundingClientRect();
      const zoom = document.querySelector('.g2-zoom');
      const z = zoom?.getBoundingClientRect();
      const zoomHit = z ? document.elementFromPoint(z.x + z.width / 2, z.y + z.height / 2) : null;
      return { layer: { w: layer.width, h: layer.height, x: layer.x, y: layer.y },
               node: b ? { x: b.x + b.width / 2, y: b.y + b.height / 2, label: node.getAttribute('aria-label') } : null,
               zoomHit: zoomHit ? { tag: zoomHit.tagName, inside: !!zoomHit.closest('.g2-zoom') } : null };
    })()`);
    await click(before.node.x, before.node.y);
    await sleep(900);
    const after = await evaluate(`(() => {
      const layer = document.querySelector('.graph-stage-layer').getBoundingClientRect();
      return { layer: { w: layer.width, h: layer.height },
               ring: !!document.querySelector('.g2-selection-ring'),
               inspector: (document.querySelector('.graph-inspector')?.innerText ?? '').replace(/\\s+/g, ' ').slice(0, 50),
               inspectorRect: (() => { const b = document.querySelector('.graph-inspector').getBoundingClientRect();
                 return { x: b.x, y: b.y, w: b.width, h: b.height, right: b.right }; })() };
    })()`);
    record(
      "点实体后画布尺寸不变（详情浮在上面）",
      Math.abs(after.layer.w - before.layer.w) <= 1 && Math.abs(after.layer.h - before.layer.h) <= 1,
      `前 ${Math.round(before.layer.w)}×${Math.round(before.layer.h)} → 后 ${Math.round(after.layer.w)}×${Math.round(after.layer.h)}`,
    );
    record("选中态与详情内容出现", after.ring && after.inspector.length > 0, `ring=${after.ring} 详情="${after.inspector}"`);
    record("缩放控件没被浮层盖住", before.zoomHit?.inside === true, JSON.stringify(before.zoomHit));
    await dblclick(before.node.x, before.node.y);
    const focused = await waitFor(`location.search.includes('focus=')`, 8000);
    record("双击画布实体设为中心", focused, `search=${await evaluate(`location.search`)}`);
    await shot("ego-2d-selected-1440");

    /* ---------------- 主题可读性 ---------------- */
    const themes = ["galaxy", "pine", "sand", "midnight"];
    const readings = [];
    for (const theme of themes) {
      readings.push(
        await evaluate(`(() => {
          document.documentElement.setAttribute('data-theme', '${theme}');
          const clamp = (v) => Math.max(0, Math.min(255, v));
          const parse = (value) => {
            const text = (value ?? '').trim();
            const srgb = text.match(/^color\\(srgb\\s+([^)]+)\\)$/);
            if (srgb) {
              const [rgbPart, alphaPart] = srgb[1].split('/');
              const rgb = rgbPart.trim().split(/\\s+/).map((n) => clamp(Number(n) * 255));
              return { r: rgb[0], g: rgb[1], b: rgb[2], a: alphaPart ? Number(alphaPart.trim()) : 1 };
            }
            const hex = text.match(/^#([0-9a-f]{6})$/i);
            if (hex) {
              const n = parseInt(hex[1], 16);
              return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
            }
            const fn = text.match(/rgba?\\(([^)]+)\\)/);
            if (fn) {
              const parts = fn[1].split(',').map((n) => Number(n.trim()));
              return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
            }
            return { r: 0, g: 0, b: 0, a: 1 };
          };
          const lum = (c) => { const f=(v)=>{const s=v/255;return s<=0.03928?s/12.92:Math.pow((s+0.055)/1.055,2.4);};
            return 0.2126*f(c.r)+0.7152*f(c.g)+0.0722*f(c.b); };
          const over = (fg,bg) => ({ r:fg.r*fg.a+bg.r*(1-fg.a), g:fg.g*fg.a+bg.g*(1-fg.a), b:fg.b*fg.a+bg.b*(1-fg.a), a:1 });
          const bar = document.querySelector('.graph-bar.graph-glass');
          const canvas = parse(getComputedStyle(document.querySelector('.graph-workspace')).getPropertyValue('--graph-canvas'));
          const glass = over(parse(getComputedStyle(bar).backgroundColor), canvas);
          const title = document.querySelector('.graph-bar-title');
          const color = getComputedStyle(title).color;
          const merged = over(parse(color), glass);
          const [hi, lo] = [lum(merged), lum(glass)].sort((a,b)=>b-a);
          return { theme: document.documentElement.getAttribute('data-theme'), color,
                   ratio: Number(((hi+0.05)/(lo+0.05)).toFixed(2)) };
        })()`),
      );
      await sleep(200);
    }
    record(
      "四主题玻璃文字同色且 ≥4.5:1",
      new Set(readings.map((r) => r.color)).size === 1 && readings.every((r) => r.ratio >= 4.5),
      JSON.stringify(readings),
    );
    await shot("ego-theme-pine");
    await evaluate(`document.documentElement.removeAttribute('data-theme')`);

    /* ---------------- 列表模式 ---------------- */
    await send("Page.navigate", { url: `${BASE}/graph?mode=list` });
    await waitFor(`!!document.querySelector('.graph-workspace')`, 30000);
    await sleep(1500);
    const list = await evaluate(`(() => {
      const ws = document.querySelector('.graph-workspace');
      return { float: ws.classList.contains('is-float'), stage: !!document.querySelector('.graph-stage-layer'),
               glass: document.querySelectorAll('.graph-glass').length,
               panel: !!document.querySelector('.graph-main.panel'), mode: ws.dataset.mode,
               barText: document.querySelector('.graph-bar-title')?.textContent ?? '' };
    })()`);
    record("列表模式回文档流、不玻璃", !list.float && !list.stage && list.glass === 0 && list.panel, JSON.stringify(list));
    await shot("ego-list-1440");

    /* ---------------- 390×844 ---------------- */
    await viewport(390, 844);
    await send("Page.navigate", { url: `${BASE}/graph?mode=2d` });
    await waitFor(`!!document.querySelector('.graph-workspace')`, 60000);
    await waitFor(`!!document.querySelector('.g2-nodes [aria-label]')`, 60000);
    await sleep(2000);
    const mobileNode = await evaluate(`(() => {
      const node = document.querySelector('.g2-nodes [aria-label]');
      const b = node?.getBoundingClientRect();
      return b ? { x: b.x + b.width / 2, y: b.y + b.height / 2 } : null;
    })()`);
    if (mobileNode) {
      await click(mobileNode.x, mobileNode.y);
      await sleep(900);
    }
    const mobile = await evaluate(`(() => {
      const ws = document.querySelector('.graph-workspace').getBoundingClientRect();
      const bar = document.querySelector('.graph-bar').getBoundingClientRect();
      const toggle = document.querySelector('.graph-bar-toggle');
      const inspector = document.querySelector('.graph-inspector');
      const ir = inspector?.getBoundingClientRect();
      const hit = document.elementFromPoint(ws.x + ws.width / 2, ws.y + 170);
      const ring = document.querySelector('.g2-selection-ring');
      const node = ring?.closest('g')?.getBoundingClientRect() ?? null;
      const core = document.querySelector('.g2-nodes [aria-label]')?.closest('g')?.getBoundingClientRect() ?? null;
      return { ws: { y: ws.y, h: ws.height, bottom: ws.bottom, w: ws.width },
               barH: bar.height,
               toggle: toggle ? { display: getComputedStyle(toggle).display, w: toggle.getBoundingClientRect().width } : null,
               drawer: ir ? { y: ir.y, h: ir.height, bottom: ir.bottom, w: ir.width } : null,
               ratio: ir ? Number((ir.height / ws.height).toFixed(3)) : null,
               selectedNode: node ? { top: node.y, bottom: node.y + node.height, h: node.height } : null,
               coreNode: core ? { top: core.y, bottom: core.y + core.height } : null,
               hit: { tag: hit?.tagName ?? null, stage: !!hit?.closest('.graph-stage-layer'), glass: !!hit?.closest('.graph-glass') },
               canvas3d: !!document.querySelector('.graph-stage-layer canvas'),
               glassCount: document.querySelectorAll('.graph-glass').length };
    })()`);
    record("窄屏控制条压成一条并带展开按钮", mobile.toggle?.w > 0 && mobile.barH < 110, `bar=${Math.round(mobile.barH)}px toggle=${JSON.stringify(mobile.toggle)}`);
    record("窄屏上半屏留给画布", mobile.hit.stage, JSON.stringify(mobile.hit));
    record(
      "窄屏详情为抽屉且 ≤55% 屏高",
      mobile.drawer !== null && mobile.ratio !== null && mobile.ratio <= 0.58 && Math.abs(mobile.drawer.bottom - mobile.ws.bottom) <= 24,
      `抽屉 ${Math.round(mobile.drawer?.h ?? -1)}px / ${Math.round(mobile.ws.h)}px = ${mobile.ratio}`,
    );
    record("窄屏不加载 3D 画布", !mobile.canvas3d, `canvas3d=${mobile.canvas3d}`);
    record(
      "窄屏抽屉不盖住当前实体",
      mobile.drawer !== null &&
        mobile.selectedNode !== null &&
        mobile.selectedNode.bottom <= mobile.drawer.y + 2,
      `实体底 ${Math.round(mobile.selectedNode?.bottom ?? -1)} / 抽屉顶 ${Math.round(mobile.drawer?.y ?? -1)}`,
    );
    await shot("ego-2d-390");

    const failed = results.filter((item) => !item.pass);
    console.log(`\n截图目录：${OUT}`);
    console.log(`结果：${results.length - failed.length}/${results.length} 通过`);
    cdp.send("Browser.close").catch(() => chrome.kill());
    ws.close();
    if (failed.length) process.exitCode = 1;
  } catch (error) {
    console.error("验收失败：", error.message);
    console.error(logs.join("").slice(-2500));
    process.exitCode = 1;
  } finally {
    await fake.close().catch(() => {});
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(app.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      spawn("taskkill", ["/pid", String(chrome.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    } else {
      app.kill("SIGTERM");
      chrome.kill("SIGTERM");
    }
    await sleep(1500);
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    await rm(chromeDir, { recursive: true, force: true }).catch(() => {});
  }
}

await main();
