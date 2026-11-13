/**
 * Phase 6D 3D 验收：真实渲染读数 + 三张截图（ADR-022 附录 A8）。
 *
 * 自包含，不需要手工起服务：
 *   1. 系统临时目录建库、跑迁移、播入 8 个对象（**不能放项目目录**：SQLite 的 -wal
 *      每次写入都会被 Turbopack 判定为「文件变了」→ HMR 整页重载，页面永远点不动，
 *      见 07_PLAYBOOK 第 85 条）；
 *   2. 起 mock LightRAG，图夹具 150 个实体 / 中心 3 层可达，正好等于
 *      `GRAPH_MAX_NODES_DEFAULT`；
 *   3. `AUTH_MODE=mock` 起 next dev，无头 Chrome（**不带 --disable-gpu**）打开
 *      `?mode=3d`，通过 `window.__graphStats` 读 drawCalls / labels / dpr / frames；
 *   4. 记录：首帧 layoutMs、2 秒空闲 frames delta、自动旋转 2 秒 frames 增长；
 *      截图 `docs/screenshots/phase6d-3d-{default,selection,low}.png`。
 *
 * 读数全部来自真实浏览器。无头环境拿不到 WebGL 时脚本直接失败并打印诊断，
 * 不会伪造数字。
 *
 * 两套规模：
 * - 默认（150 节点，主线程布局）→ 三张桌面/移动截图 + 原有读数；
 * - `GRAPH_PERF_NODES=600`（宽夹具：两个互不相连的枢纽，各自深度 3 可达 373 个实体）
 *   → 页面带 `?maxNodes=600`，373 > 300 走**真 Worker**；断言 Worker 目标真实存在、
 *   `cancelled` 语义与端到端布局时间，截图 `phase6d-3d-worker-600.png`。
 *
 * 用法：
 *   node scripts/graph-perf.mjs
 *   GRAPH_PERF_NODES=600 node scripts/graph-perf.mjs
 * 可选环境变量：APP_PORT（默认 3125）、CDP_PORT（默认 9340）、CHROME_PATH。
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

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
].filter(Boolean);
const CHROME = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));

const APP_PORT = Number(process.env.APP_PORT || 3125);
// 必须用 localhost：Next dev 默认只放行自己的 host，用 127.0.0.1 访问会被
// 拦掉 /_next/hmr 等 dev 资源，RSC 载荷不执行 → 页面永远停在 SSR、不水合。
const BASE = `http://localhost:${APP_PORT}`;
const CDP_PORT = Number(process.env.CDP_PORT || 9340);
const OWNER_SUB = "mock-local-user";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 给可能挂住的异步操作加一道时限：超时直接抛出，定位到具体步骤。 */
async function withTimeout(promise, ms, label) {
  let timer = null;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}：${ms}ms 内没有返回`)), ms);
  });
  try {
    return await Promise.race([promise, guard]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ *
 * 1. 数据库：8 个对象只用于「归属过滤」，图数据全部来自 mock LightRAG。
 * ------------------------------------------------------------------ */

const OBJECTS = [
  { id: "6d0a1f10-3b28-4a61-9e3a-8c1d2f4a7b01", title: "知识管理实践笔记" },
  { id: "6d0a1f10-3b28-4a61-9e3a-8c1d2f4a7b02", title: "卡片笔记写作法摘录" },
  { id: "6d0a1f10-3b28-4a61-9e3a-8c1d2f4a7b03", title: "第二大脑搭建记录" },
  { id: "6d0a1f10-3b28-4a61-9e3a-8c1d2f4a7b04", title: "渐进式总结练习" },
  { id: "6d0a1f10-3b28-4a61-9e3a-8c1d2f4a7b05", title: "PARA 方法拆解" },
  { id: "6d0a1f10-3b28-4a61-9e3a-8c1d2f4a7b06", title: "常青笔记的维护" },
  { id: "6d0a1f10-3b28-4a61-9e3a-8c1d2f4a7b07", title: "深度工作读书笔记" },
  { id: "6d0a1f10-3b28-4a61-9e3a-8c1d2f4a7b08", title: "检索增强生成调研" },
];

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
      insert.run(object.id, object.title, `${object.title}（Phase 6D-2 截图夹具）`, OWNER_SUB, now, now);
    }
  });
  run();
  sqlite.close();
}


/* ------------------------------------------------------------------ *
 * 2. 图夹具：150 个实体（1 中心 + 8 一环 + 41 二环 + 100 三环），
 *    中心 3 层可达，正好是 `GRAPH_MAX_NODES_DEFAULT` 的规模。
 * ------------------------------------------------------------------ */

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
];

const RING2 = [
  "费曼学习法", "双向链接", "每日回顾", "主题阅读", "写作冲刺", "概念地图",
  "渐进式阅读", "卡片盒", "文献笔记", "周回顾", "深度阅读", "输出倒逼输入",
  "知识花园", "标签体系", "内容日历", "选题池", "素材库", "灵感捕捉",
  "长期主义", "刻意练习", "复盘模板", "知识资产", "检索技巧", "语义搜索",
  "RAG 调优", "信息茧房", "间隔重复", "认知负荷", "写作工作流", "检索增强生成",
  "笔记回顾", "主题标记", "归档规则", "链接密度", "摘要练习", "问题清单",
  "阅读批次", "素材归档", "主题索引", "写作节奏", "回顾节奏",
];

const RING3 = Array.from(
  { length: 100 },
  (_, index) => `素材 ${String(index + 1).padStart(3, "0")}`,
);

const TYPE_CYCLE = ["概念", "方法", "人物", "机构", "作品", "其他"];

const ENTITIES = [
  { id: CENTER, type: "概念", description: "把个人经验沉淀成可检索、可复用的知识体系，是整张图的中心。" },
  ...RING1.map(([id, type], index) => ({
    id,
    type,
    description: index === 4 ? "" : `${id}是知识管理里经常出现的一个概念，来自${OBJECTS[index % OBJECTS.length].title}。`,
  })),
  ...RING2.map((id, index) => ({
    id,
    type: TYPE_CYCLE[index % TYPE_CYCLE.length],
    description: `${id}与${RING1[index % RING1.length][0]}一起出现在同一批笔记里。`,
  })),
  ...RING3.map((id, index) => ({
    id,
    type: TYPE_CYCLE[(index + 2) % TYPE_CYCLE.length],
    description: `${id}是二环主题展开后的具体素材与案例。`,
  })),
];

const entityById = new Map(ENTITIES.map((entity) => [entity.id, entity]));
ENTITIES.forEach((entity, index) => {
  entity.filePath = filePathFor(OBJECTS[index % OBJECTS.length].id);
});

const EDGES = [];
function addEdge(source, target, description) {
  const object = OBJECTS[(EDGES.length + 3) % OBJECTS.length];
  EDGES.push({ source, target, description, filePath: filePathFor(object.id) });
}

for (const [id] of RING1) {
  addEdge(CENTER, id, `关联<SEP>${id}在知识管理的日常实践里被反复引用。`);
}
RING2.forEach((id, index) => {
  addEdge(RING1[index % RING1.length][0], id, `延伸<SEP>${id}从${RING1[index % RING1.length][0]}继续展开。`);
});
RING3.forEach((id, index) => {
  addEdge(RING2[index % RING2.length], id, `包含<SEP>${id}是${RING2[index % RING2.length]}的一个具体案例。`);
});
// 一环之间补几条横向关系：让二点之间存在多跳路径，也给强边/普通边都留出样本。
addEdge("卡片笔记", "常青笔记", "演化<SEP>卡片笔记逐步演化成常青笔记。");
addEdge("常青笔记", "第二大脑", "沉淀<SEP>常青笔记最终沉淀进第二大脑。");
addEdge("渐进式总结", "常青笔记", "产出<SEP>渐进式总结的终点是常青笔记。");
addEdge("PARA 方法", "内容工作室", "组织<SEP>PARA 方法用来组织内容工作室的素材。");
addEdge("林默", "内容工作室", "协作<SEP>林默在内容工作室里实践卡片笔记。");
addEdge("内容工作室", "林默", "雇佣<SEP>内容工作室由林默独立运营。");
addEdge("检索增强生成", "RAG 调优", "包含<SEP>检索增强生成包含 RAG 调优这一实践环节。");
addEdge("费曼学习法", "输出倒逼输入", "依赖<SEP>费曼学习法依赖输出倒逼输入。");

const LABELS = [CENTER, ...RING1.slice(0, 8).map(([id]) => id), ...RING2.slice(0, 4)];

/* ------------------------------------------------------------------ *
 * 2b. 宽图夹具（GRAPH_PERF_NODES > 300 时启用）。
 *
 * 为什么要宽：`LAYOUT_WORKER_THRESHOLD = 300`，<=300 节点在图外壳里是**主线程同步**算，
 * Worker 那条分支（含相对路径、协议、取消）根本不会被走到。上一轮 150 节点的验收
 * 因此看不到 `Module not found` 之外的 Worker 问题。
 *
 * 形状：两个**互不相连**的枢纽，每个 1 + 12 + 120 + 240 = 373 个实体（深度 3 全可达）。
 * - 373 > 300 → 一定建 Worker；请求 `?maxNodes=600`，373 < 600 → `truncated=false`；
 * - 两个枢纽是为了「换中心」能连续发出两次**真 Worker** 请求，才能验取消语义。
 * ------------------------------------------------------------------ */

const WIDE_HUB_A = "宽图中心甲";
const WIDE_HUB_B = "宽图中心乙";

function buildWideHub(hubId, tag) {
  const entities = [{ id: hubId, type: "概念", description: `${hubId} 是宽图夹具的枢纽。` }];
  const edges = [];
  const ring1 = Array.from(
    { length: 12 },
    (_, index) => `${tag} 主题 ${String(index + 1).padStart(2, "0")}`,
  );
  const addEdgeWide = (source, target) => {
    edges.push({
      source,
      target,
      description: `关联<SEP>${target} 与 ${source} 在宽图夹具里相连。`,
      filePath: filePathFor(OBJECTS[edges.length % OBJECTS.length].id),
    });
  };
  for (const id of ring1) {
    entities.push({ id, type: "概念", description: `${id} 是宽图的一环主题。` });
    addEdgeWide(hubId, id);
  }
  for (const id of ring1) {
    for (let k = 1; k <= 10; k += 1) {
      const sub = `${id} 子题 ${k}`;
      entities.push({ id: sub, type: "方法", description: `${sub} 挂在 ${id} 下。` });
      addEdgeWide(id, sub);
      for (let m = 1; m <= 2; m += 1) {
        const leaf = `${sub} 素材 ${m}`;
        entities.push({ id: leaf, type: "其他", description: `${leaf} 是 ${sub} 的具体素材。` });
        addEdgeWide(sub, leaf);
      }
    }
  }
  return { entities, edges, ring1 };
}

function buildWorkerDataset() {
  const a = buildWideHub(WIDE_HUB_A, "甲");
  const b = buildWideHub(WIDE_HUB_B, "乙");
  const entities = [...a.entities, ...b.entities];
  entities.forEach((entity, index) => {
    entity.filePath = filePathFor(OBJECTS[index % OBJECTS.length].id);
  });
  return {
    entities,
    byId: new Map(entities.map((entity) => [entity.id, entity])),
    edges: [...a.edges, ...b.edges],
    labels: [WIDE_HUB_A, WIDE_HUB_B, ...a.ring1.slice(0, 8)],
  };
}

/* 与 `src/lib/graph-render.ts` 的 `LAYOUT_WORKER_THRESHOLD` 保持一致（脚本不 import TS）。 */
const LAYOUT_WORKER_THRESHOLD = 300;
const PERF_NODES = Number(process.env.GRAPH_PERF_NODES || 150);
if (!Number.isFinite(PERF_NODES) || PERF_NODES < 50 || PERF_NODES > 600) {
  throw new Error(`GRAPH_PERF_NODES 只支持 50–600（当前 ${process.env.GRAPH_PERF_NODES}）`);
}
const WORKER_SCALE = PERF_NODES > LAYOUT_WORKER_THRESHOLD;
const REQUEST_MAX_NODES = WORKER_SCALE ? 600 : 150;
/** 宽夹具单枢纽深度 3 的实体数；默认夹具 150。 */
const EXPECTED_NODES = WORKER_SCALE ? 373 : 150;
const WIDE = WORKER_SCALE ? buildWorkerDataset() : null;

/** 只保留前端展示需要的读法：与 LightRAG `/graphs` 的原始结构一致。 */
function neighborhood(label, maxDepth, maxNodes, dataset) {
  const { byId, entities, edges: datasetEdges } = dataset ?? {
    byId: entityById,
    entities: ENTITIES,
    edges: EDGES,
  };
  const start = byId.get(label);
  if (!start) return { nodes: [], edges: [] };

  const adjacency = new Map(entities.map((entity) => [entity.id, []]));
  for (const edge of datasetEdges) {
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

  let ids = [...distance.keys()].sort(
    (a, b) => (distance.get(a) ?? 0) - (distance.get(b) ?? 0) || a.localeCompare(b),
  );
  if (ids.length > maxNodes) {
    ids = [label, ...ids.filter((id) => id !== label).slice(0, Math.max(0, maxNodes - 1))];
  }
  const kept = new Set(ids);

  return {
    nodes: ids.map((id) => {
      const entity = byId.get(id);
      return {
        id: entity.id,
        labels: ["Entity"],
        properties: {
          entity_type: entity.type,
          description: entity.description,
          file_path: entity.filePath,
        },
      };
    }),
    edges: datasetEdges.filter((edge) => kept.has(edge.source) && kept.has(edge.target)).map((edge) => ({
      source: edge.source,
      target: edge.target,
      properties: { description: edge.description, file_path: edge.filePath },
    })),
  };
}

const DOC_STATUSES = [
  { index: 0, status: "processed" },
  { index: 1, status: "processed" },
  { index: 2, status: "failed", error: "抽取超时：本地模型 120s 未返回（fixture）" },
  { index: 3, status: "processed" },
  { index: 4, status: "failed", error: "正文为空，跳过实体抽取（fixture）" },
  { index: 5, status: "processed" },
  { index: 6, status: "processing" },
];
/* ------------------------------------------------------------------ *
 * 3. mock LightRAG：只实现图谱链路真正会调到的接口。
 * ------------------------------------------------------------------ */

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function json(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

async function startMockLightrag() {
  const state = { mode: "full" };

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const pathname = url.pathname;

    if (pathname === "/__mode") {
      const mode = url.searchParams.get("mode");
      if (mode === "empty" || mode === "full" || mode === "graph-error" || mode === "status-error" || mode === "center-error") {
        state.mode = mode;
      }
      json(response, 200, { mode: state.mode });
      return;
    }

    if (state.mode === "status-error") {
      // 实体与图都能读，只有状态接口挂：界面必须说「状态读不到」，而不是「图谱是空的」。
      if (pathname === "/graph/label/list") return json(response, 200, []);
      if (pathname === "/graphs") return json(response, 200, { nodes: [], edges: [] });
      if (pathname === "/documents/paginated") {
        response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("mock LightRAG：文档状态接口不可用（phase6d fixture）");
        return;
      }
    }

    if (state.mode === "center-error" && pathname === "/graphs") {
      // 只让「换中心」那种 2 层展开失败；1 层探测照常成功，标签才会留在下拉里（ADR-011）。
      const label = url.searchParams.get("label") ?? "";
      const depth = Number(url.searchParams.get("max_depth") || 2);
      if (label === FAIL_CENTER && depth >= 2) {
        response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("mock LightRAG：图谱存储不可用（phase6d 换中心失败 fixture）");
        return;
      }
    }

    if (state.mode === "empty") {
      if (pathname === "/graph/label/list") return json(response, 200, []);
      if (pathname === "/graphs") return json(response, 200, { nodes: [], edges: [] });
      if (pathname === "/documents/paginated") {
        return json(response, 200, { documents: [], pagination: { total_count: 0 } });
      }
      if (pathname === "/query") return json(response, 200, { response: "", references: [] });
    }

    if (pathname === "/graph/label/list" && request.method === "GET") {
      return json(response, 200, WIDE ? WIDE.labels : LABELS);
    }

    if (pathname === "/graphs" && request.method === "GET") {
      const label = url.searchParams.get("label") ?? "";
      if (state.mode === "graph-error" && label === ERROR_LABEL) {
        const body = "mock LightRAG：图谱存储不可用（phase6d fixture）";
        response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        response.end(body);
        return;
      }
      const maxDepth = Number(url.searchParams.get("max_depth") || 2);
      const maxNodes = Number(url.searchParams.get("max_nodes") || 200);
      return json(response, 200, neighborhood(label, maxDepth, maxNodes, WIDE));
    }

    if (pathname === "/documents/paginated" && request.method === "POST") {
      await readBody(request);
      const documents = DOC_STATUSES.map(({ index, status, error }) => ({
        id: `doc-6d-${index + 1}`,
        file_path: filePathFor(OBJECTS[index].id),
        status,
        chunks_count: 3,
        error_msg: error ?? null,
      }));
      return json(response, 200, {
        documents,
        pagination: { page: 1, page_size: 50, total_count: documents.length },
      });
    }

    if (pathname === "/query" && request.method === "POST") {
      await readBody(request);
      return json(response, 200, {
        response: "知识管理把卡片笔记、第二大脑和渐进式总结串成了一条可复用的路径。",
        references: [{ reference_id: "ref-1", file_path: filePathFor(OBJECTS[0].id) }],
      });
    }

    if (pathname === "/documents/text" && request.method === "POST") {
      await readBody(request);
      response.writeHead(204);
      response.end();
      return;
    }

    if (pathname === "/documents/delete_document" && request.method === "DELETE") {
      await readBody(request);
      response.writeHead(204);
      response.end();
      return;
    }

    json(response, 404, { detail: `mock 未实现 ${request.method} ${pathname}` });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}`;

  return {
    url,
    async setMode(mode) {
      state.mode = mode;
      const response = await fetch(`${url}/__mode?mode=${mode}`);
      const data = await response.json();
      if (data.mode !== mode) throw new Error(`mock 模式切换失败：${data.mode}`);
    },
    async close() {
      // dev 服务到 mock 的连接是 keep-alive：不主动断开，close() 永远等不到。
      server.closeAllConnections?.();
      server.close();
      await Promise.race([once(server, "close"), sleep(2000)]).catch(() => {});
    },
  };
}

/* ------------------------------------------------------------------ *
 * 4. next dev：起停 + 健康检查。
 * ------------------------------------------------------------------ */

async function waitForServer(url, timeoutMs = 180000) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        const data = await response.json();
        if (data.status === "ok" && data.authMode === "mock") return data;
        lastError = new Error(`健康检查身份不是 mock（authMode=${data.authMode}）`);
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(300);
  }
  throw new Error(`等待 ${url} 超时：${lastError?.message ?? "无响应"}`);
}

async function serverDown(url) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(1000) });
    return false;
  } catch {
    return true;
  }
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
  // 上一次被强杀的脚本可能留下一个还占着端口的 dev 服务：
  // 健康检查会误连到它（数据库已删、mock 已停），表现为页面永远不水合。
  if (await portInUse(APP_PORT)) {
    throw new Error(`端口 ${APP_PORT} 已被占用；先停掉旧进程，或用 APP_PORT=xxxx 换一个。`);
  }

  const child = spawn(process.execPath, [NEXT_BIN, "dev", "-p", String(APP_PORT)], {
    cwd: ROOT,
    env: {
      ...process.env,
      AUTH_MODE: "mock",
      DATABASE_PATH: dbFile,
      LIGHTRAG_BASE_URL: lightragUrl,
      LIGHTRAG_API_KEY: "phase6d-mock",
      // Next 16 的 dev 锁在 distDir/lock：3000 上的日常 dev 服务占着 `.next`，
      // 这里换一个构建目录才能并存（next.config.ts 已支持 NEXT_DIST_DIR）。
      NEXT_DIST_DIR: ".next-mock",
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
    throw new Error(
      `${error.message}\n端口 ${APP_PORT} 可能被占用，可用 APP_PORT=xxxx 换一个。\n` +
        logs.join("").slice(-4000),
    );
  }

  return { child, logs };
}

async function stopApp(app) {
  if (!app) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(app.child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
  } else {
    app.child.kill("SIGTERM");
  }
  const started = Date.now();
  while (Date.now() - started < 20000) {
    if (await serverDown(`${BASE}/api/health`)) return;
    await sleep(250);
  }
  throw new Error(`端口 ${APP_PORT} 上的 dev 服务没有停下`);
}

/* ------------------------------------------------------------------ *
 * 5. CDP：截图 / 点击 / 键盘 / 错误收集（与 phase6c 同一套写法）。
 * ------------------------------------------------------------------ */

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

/**
 * 开发态探针（`Page.addScriptToEvaluateOnNewDocument`，不改应用代码）：
 * - 记录页面**实际建了哪个 Worker URL**（`new Worker(new URL(...))` 解析后的绝对地址）；
 * - 记录每条进出 Worker 的消息类型，包括 `cancelled` 回执；
 * - 记录「layout 请求发出」与「首帧读数就绪」两个时刻，用来算端到端布局时间
 *   （`__graphStats.layoutMs` 只是 Worker 内的计算耗时，不是端到端）。
 */
const INSTRUMENT_SOURCE = `(() => {
  const log = {
    createdAt: performance.now(),
    workers: [],
    messages: [],
    layoutPostedAt: null,
    layoutDoneAt: null,
    readyAt: null,
    readyStats: null,
  };
  window.__workerLog = log;

  const NativeWorker = window.Worker;
  if (NativeWorker) {
    window.Worker = class InstrumentedWorker extends NativeWorker {
      constructor(url, options) {
        super(url, options);
        log.workers.push({
          at: performance.now(),
          url: String(url),
          name: options && options.name ? options.name : null,
          type: options && options.type ? options.type : 'classic',
        });
        this.addEventListener('message', (event) => {
          const data = event.data;
          const type = data && typeof data === 'object' ? data.type : typeof data;
          const entry = { at: performance.now(), dir: 'out', type: type };
          if (type === 'done' && data && data.result) {
            entry.resultNodes = Array.isArray(data.result.ids) ? data.result.ids.length : null;
            entry.resultHead = Array.isArray(data.result.ids) ? data.result.ids.slice(0, 2) : [];
            entry.resultTicks = data.result.ticks;
            entry.resultLayoutMs = data.result.layoutMs;
            entry.resultTruncated = data.result.truncated;
            log.layoutDoneAt = performance.now();
          }
          log.messages.push(entry);
        });
      }
      postMessage(message, transfer) {
        const type = message && typeof message === 'object' ? message.type : typeof message;
        const entry = { at: performance.now(), dir: 'in', type: type };
        if (type === 'layout') {
          entry.viewNodes = message.view && Array.isArray(message.view.nodes) ? message.view.nodes.length : null;
          entry.viewCenter = message.view && message.view.meta ? message.view.meta.center : null;
          entry.deadlineMs = message.options ? message.options.deadlineMs : null;
          log.layoutPostedAt = performance.now();
        }
        log.messages.push(entry);
        return transfer === undefined ? super.postMessage(message) : super.postMessage(message, transfer);
      }
    };
  }

  // 首帧就绪：__graphStats 由容器在 onReady 之后写入（layoutTicks>0 且 drawCalls>0）。
  const probe = () => {
    if (log.readyAt === null) {
      const stats = window.__graphStats;
      if (stats && stats.layoutTicks > 0 && stats.drawCalls > 0) {
        log.readyAt = performance.now();
        log.readyStats = Object.assign({}, stats);
      }
    }
    requestAnimationFrame(probe);
  };
  requestAnimationFrame(probe);
})();`;

async function launchBrowser() {
  if (!CHROME) throw new Error("找不到 Chrome / Edge，可设置 CHROME_PATH");
  const userDataDir = path.join(os.tmpdir(), `pakp-phase6d-chrome-${Date.now()}`);
  const child = spawn(
    CHROME,
    [
      "--headless=new",
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
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

  // dedicated worker 只有在浏览器级 `Target.setDiscoverTargets` 打开后才会以
  // `type: "worker"` 暴露出来（等价于 Puppeteer 的 `page.workers()`）。
  const workerTargets = [];
  cdp.on("Target.targetCreated", (params) => {
    const info = params?.targetInfo;
    if (!info || info.type !== "worker") return;
    workerTargets.push({ url: info.url, title: info.title, at: Date.now() });
  });
  await cdp.send("Target.setDiscoverTargets", { discover: true });

  return {
    cdp,
    /**
     * 当前还活着的 worker 目标（等价于 Puppeteer 的 `page.workers()`）。
     * dedicated worker 的 `targetInfo.url` 在无头 CDP 里常常是空串，所以 URL 以
     * 页面探针记下的 `new Worker(...)` 实参为准；这里只证明「目标真的存在」。
     */
    async workerTargets() {
      const { targetInfos } = await cdp.send("Target.getTargets");
      const live = targetInfos
        .filter((item) => item.type === "worker")
        .map((item) => ({
          targetId: item.targetId,
          type: item.type,
          url: item.url,
          title: item.title,
          attached: item.attached,
        }));
      return { live, seen: workerTargets.slice() };
    },
    async close() {
      await Promise.race([
        cdp.send("Browser.close").catch(() => child.kill()),
        sleep(3000),
      ]).catch(() => {});
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
    networkErrors: [],
    send: (method, params) => cdp.send(method, params, sessionId),
    async evaluate(expression) {
      // CDP 自身 60s 才超时；脚本卡住时先在这里明确报出来，别让整轮无限拖。
      const result = await withTimeout(
        cdp.send(
          "Runtime.evaluate",
          { expression, awaitPromise: true, returnByValue: true },
          sessionId,
        ),
        25000,
        `页面脚本执行（${expression.slice(0, 60)}）`,
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
      await mkdir(OUT, { recursive: true });
      const file = path.join(OUT, `${name}.png`);
      await writeFile(file, Buffer.from(data, "base64"));
      console.log(`[shot] ${path.relative(ROOT, file)}`);
      return file;
    },
    async close() {
      await cdp.send("Target.closeTarget", { targetId }).catch(() => {});
    },
  };

  await cdp.send("Page.enable", {}, sessionId);
  // 探针必须在任何导航之前装上（含后续 HMR 重载的新文档）。
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: INSTRUMENT_SOURCE }, sessionId);
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Network.enable", {}, sessionId);

  cdp.on(`${sessionId}:Runtime.consoleAPICalled`, (params) => {
    if (params.type !== "error") return;
    page.consoleErrors.push(
      params.args.map((arg) => arg.description ?? arg.value ?? "").join(" ").slice(0, 600),
    );
  });
  cdp.on(`${sessionId}:Runtime.exceptionThrown`, (params) => {
    page.pageErrors.push(params.exceptionDetails?.exception?.description?.slice(0, 600) ?? "exception");
  });
  cdp.on(`${sessionId}:Network.loadingFailed`, (params) => {
    if (params.canceled) return;
    page.networkErrors.push(`${params.type} ${params.errorText} ${params.blockedReason ?? ""}`.trim());
  });
  cdp.on(`${sessionId}:Network.responseReceived`, (params) => {
    // 站点没有 favicon，浏览器每次会请求一次 404；与页面/控制台错误无关。
    if (params.response.url.endsWith("/favicon.ico")) return;
    if (params.response.status >= 400) {
      page.networkErrors.push(`${params.type} ${params.response.status} ${params.response.url}`);
    }
  });

  return page;
}

/* ------------------------------------------------------------------ *
 * 6. 断言与截图。
 * ------------------------------------------------------------------ */

function flushErrors(page, label, problems, allow = []) {
  // 失败态场景本来就会打出 4xx/5xx 和服务端日志：只放过声明过的内容，其它照报。
  const permitted = (text) => allow.some((pattern) => pattern.test(text));
  for (const error of page.consoleErrors) {
    if (permitted(error)) continue;
    problems.push(`${label} console: ${error}`);
  }
  for (const error of page.pageErrors) problems.push(`${label} page: ${error}`);
  for (const error of page.networkErrors) {
    if (permitted(error)) continue;
    problems.push(`${label} network: ${error}`);
  }
  page.consoleErrors.length = 0;
  page.pageErrors.length = 0;
  page.networkErrors.length = 0;
}

/**
 * 故意制造的 500 会让 Next dev 在左下角挂一个「1 Issue」浮标。
 * 它只在开发模式出现，不该进文档截图；截图前把 portal 宿主隐藏掉。
 */
async function hideDevOverlay(page) {
  await page.evaluate(`(() => {
    if (document.querySelector('style[data-capture="hide-dev-overlay"]')) return;
    const style = document.createElement('style');
    style.dataset.capture = 'hide-dev-overlay';
    style.textContent = 'nextjs-portal{display:none!important}';
    document.head.appendChild(style);
  })()`);
}

/**
 * 交互断言的前提：React 已经水合。
 * `window.__graphStats` 由容器里的 effect 写入，SSR 不可能有，出现即代表挂载完成。
 */
async function ensureHydrated(page, label, problems, timeoutMs = 90000) {
  const ok = await page.waitFor("Boolean(window.__graphStats)", timeoutMs);
  if (!ok) {
    const diag = await page
      .evaluate(`({
        readyState: document.readyState,
        scripts: [...document.scripts].map((script) => script.src).filter(Boolean).slice(-6),
        pending: performance.getEntriesByType('resource')
          .filter((entry) => entry.name.includes('/_next/'))
          .slice(-6)
          .map((entry) => ({ name: entry.name.split('/').pop(), ms: Math.round(entry.duration) })),
      })`)
      .catch(() => null);
    problems.push(`${label} 未水合（__graphStats 未出现）：${JSON.stringify(diag)}`);
  }
  return ok;
}

async function checkOverflow(page, label, problems) {
  const metrics = await page.evaluate(`({
    doc: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
    inner: window.innerWidth,
  })`);
  if (metrics.doc > metrics.inner + 1 || metrics.body > metrics.inner + 1) {
    problems.push(`${label} 横向溢出：doc=${metrics.doc} body=${metrics.body} viewport=${metrics.inner}`);
  }
}

async function nodeCenter(page, id) {
  return page.evaluate(`(() => {
    const node = document.querySelector('[data-node-id="' + CSS.escape(${JSON.stringify(id)}) + '"]');
    if (!node) return null;
    const shape = node.querySelector('.g2-shape') ?? node;
    const rect = shape.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return null;
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })()`);
}

async function clickAt(page, point, modifiers = 0) {
  await page.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: point.x,
    y: point.y,
    modifiers,
  });
  await page.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: point.x,
    y: point.y,
    button: "left",
    clickCount: 1,
    modifiers,
  });
  await page.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: point.x,
    y: point.y,
    button: "left",
    clickCount: 1,
    modifiers,
  });
  await sleep(350);
}

async function key(page, keyName, code, keyCode) {
  for (const type of ["keyDown", "keyUp"]) {
    await page.send("Input.dispatchKeyEvent", {
      type,
      key: keyName,
      code,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
    });
  }
  await sleep(150);
}


/* ------------------------------------------------------------------ *
 * 7. 3D 验收：真实读数 + 三张截图。
 *
 * 读数口径（设计稿 §8.3 / ADR-022 A8）：
 * - drawCalls 取 `gl.info.render.calls`，预算 ≤ 8；
 * - labels 取标签层每帧实际放置的实例数，预算 low 12 / balanced 24 / high 40；
 * - 空闲 frames delta 用 demand 渲染的累计帧数差，静默时应为 0；
 * - autoRotate 打开后同一窗口内的 frames 增长应明显 > 0。
 * ------------------------------------------------------------------ */

const LABEL_CAPS = { low: 12, balanced: 24, high: 40 };
const DRAW_CALL_BUDGET = 8;
const SEGMENT_URL = (focus) =>
  `${BASE}/graph?mode=3d&focus=${encodeURIComponent(focus)}&depth=3&maxNodes=${REQUEST_MAX_NODES}`;

async function statsOf(page) {
  return page.evaluate(`(() => {
    const stats = window.__graphStats;
    return stats ? { ...stats } : null;
  })()`);
}

/** 探针读出的 Worker 生命周期（URL / 消息流 / 两个时刻）。 */
async function workerLogOf(page) {
  return page.evaluate(`(() => {
    const log = window.__workerLog;
    return log ? JSON.parse(JSON.stringify(log)) : null;
  })()`);
}

/** 标签框两两相交检查（像素，>0.5px 才算重叠）。数据来自 LabelLayer 的开发态导出。 */
function countLabelOverlaps(boxes) {
  const list = Array.isArray(boxes) ? boxes : [];
  const overlaps = [];
  for (let i = 0; i < list.length; i += 1) {
    for (let j = i + 1; j < list.length; j += 1) {
      const a = list[i];
      const b = list[j];
      const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (overlapX > 0.5 && overlapY > 0.5) {
        overlaps.push({
          a: a.id,
          b: b.id,
          overlapX: Math.round(overlapX),
          overlapY: Math.round(overlapY),
        });
      }
    }
  }
  return overlaps;
}

/**
 * 连续读几次 __graphStats，返回每次的 frames / labels。
 * demand 渲染静止后帧数不再增长，读数应当是「已经稳定」的那一版，而不是挂载瞬间的 0。
 */async function sampleStats(page, times = 6, gapMs = 250) {
  const samples = [];
  for (let index = 0; index < times; index += 1) {
    const stats = await statsOf(page);
    samples.push({
      frames: stats?.frames ?? null,
      labels: stats?.labels ?? null,
      drawCalls: stats?.drawCalls ?? null,
      rafActive: stats?.rafActive ?? null,
    });
    if (index < times - 1) await sleep(gapMs);
  }
  return samples;
}

async function sceneDiagnostics(page) {
  return page.evaluate(`(() => {
    const stage = document.querySelector('.graph-stage-wrap[data-mode="3d"]');
    const stub = document.querySelector('.g3-stub');
    return {
      stats: window.__graphStats ? { ...window.__graphStats } : null,
      stage: Boolean(stage),
      canvas: stage ? Boolean(stage.querySelector('canvas')) : false,
      stubText: stub ? stub.innerText.replace(/\\s+/g, ' ').slice(0, 240) : null,
      body: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 240),
    };
  })()`);
}

async function waitForScene3d(page, label, problems, timeoutMs = 150000) {
  const ok = await page.waitFor(
    `(() => {
      const stats = window.__graphStats;
      const stage = document.querySelector('.graph-stage-wrap[data-mode="3d"]');
      return Boolean(stats)
        && stats.mode === '3d'
        && stats.drawCalls > 0
        && Boolean(stage && stage.querySelector('canvas'));
    })()`,
    timeoutMs,
    250,
  );
  if (!ok) {
    const diagnostics = await sceneDiagnostics(page).catch(() => null);
    problems.push(`${label} 3D 场景没有起来：${JSON.stringify(diagnostics)}`);
  }
  return ok;
}

function checkBudgets(stats, label, problems, expectedNodes = EXPECTED_NODES) {
  if (!stats) {
    problems.push(`${label} 没有读数`);
    return;
  }
  if (stats.drawCalls > DRAW_CALL_BUDGET) {
    problems.push(`${label} draw calls ${stats.drawCalls} 超过预算 ${DRAW_CALL_BUDGET}`);
  }
  const cap = LABEL_CAPS[stats.tier];
  if (cap !== undefined && stats.labels > cap) {
    problems.push(`${label} 标签 ${stats.labels} 超过 ${stats.tier} 档上限 ${cap}`);
  }
  if (stats.nodes !== expectedNodes) {
    problems.push(`${label} 节点数 ${stats.nodes}，夹具应该是 ${expectedNodes}`);
  }
}

async function captureDefaultView(page, problems) {
  console.log("[step] 3D 桌面：默认视角");
  await page.setViewport({ width: 1440, height: 900, dpr: 1 });
  await page.goto(SEGMENT_URL(CENTER));
  if (!(await ensureHydrated(page, "3D 桌面", problems))) return null;
  if (!(await waitForScene3d(page, "3D 桌面", problems))) return null;

  // 等第一轮布局/标签稳定；demand 渲染下这里没有持续动画，睡眠只是给 React/GL 尾巴。
  await sleep(1500);
  const ready = await statsOf(page);
  // 全幅改版后画布尺寸随容器变化：把真实画布宽高比记进读数，取景就是按它求的。
  const canvasBox = await page.evaluate(`(() => {
    const canvas = document.querySelector('.graph-stage-wrap[data-mode="3d"] canvas');
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return { width: Math.round(rect.width), height: Math.round(rect.height) };
  })()`);
  if (canvasBox) {
    console.log(`[note] 3D 画布 ${canvasBox.width}×${canvasBox.height}（宽高比 ${(canvasBox.width / canvasBox.height).toFixed(2)}）`);
  }
  const labelBoxes = await page.evaluate(
    "window.__graphLabelBoxes ? JSON.parse(JSON.stringify(window.__graphLabelBoxes)) : []",
  );
  const labelOverlaps = countLabelOverlaps(labelBoxes);
  if (labelOverlaps.length > 0) {
    problems.push(
      "标签框相互重叠：" +
        labelOverlaps
          .slice(0, 5)
          .map((item) => `${item.a}/${item.b} ${item.overlapX}x${item.overlapY}`)
          .join("，"),
    );
  }
  await sleep(2000);
  const idle = await statsOf(page);

  await hideDevOverlay(page);
  await checkOverflow(page, "3D 桌面", problems);
  await page.screenshot("phase6d-3d-default");
  flushErrors(page, "3D 桌面", problems);
  checkBudgets(ready, "3D 桌面", problems);

  const idleFrames = (idle?.frames ?? 0) - (ready?.frames ?? 0);
  // demand 渲染：不拖不转时不该有帧。允许控制器的阻尼尾巴，但必须接近 0。
  if (idleFrames > 6) {
    problems.push(`3D 桌面空闲 2s 仍在出帧：${idleFrames}`);
  }
  return { ready, idle, idleFrames, labelBoxes, labelOverlaps, canvasBox };
}

async function measureAutoRotate(page, problems) {
  console.log("[step] 3D 桌面：自动旋转帧数");
  const toggle = `(() => {
    const button = [...document.querySelectorAll('button')]
      .find((item) => item.textContent.trim() === '自动旋转');
    if (!button) return false;
    button.click();
    return true;
  })()`;

  if (!(await page.evaluate(toggle))) {
    problems.push("3D 桌面 找不到「自动旋转」按钮");
    return null;
  }
  await sleep(1200);
  const before = await statsOf(page);
  await sleep(2000);
  const during = await statsOf(page);
  await page.evaluate(toggle);
  await sleep(1200);
  const settled = await statsOf(page);
  await sleep(1500);
  const afterOff = await statsOf(page);

  const frames = (during?.frames ?? 0) - (before?.frames ?? 0);
  const offFrames = (afterOff?.frames ?? 0) - (settled?.frames ?? 0);
  if (frames < 30) problems.push(`自动旋转 2s 只出了 ${frames} 帧`);
  if (offFrames > 6) problems.push(`关掉自动旋转后仍在出帧：${offFrames}`);
  if (during?.rafActive !== true) problems.push("自动旋转时 rafActive 不是 true");
  return { frames, offFrames, before, during, settled, afterOff };
}

async function captureSelection(page, problems) {
  console.log("[step] 3D 桌面：选中 + 路径");
  await page.setViewport({ width: 1440, height: 900, dpr: 1 });

  // 3D 画布的点击意图只有 select/focus，没有修饰键；先进 2D 用 Shift+单击建立路径，
  // 再按 3 切回 3D —— highlight.path 是容器状态，切换视图不会丢。
  await key(page, "2", "Digit2", 50);
  const ready2d = await page.waitFor(
    `document.querySelectorAll('[data-node-id]').length >= 100`,
    60000,
  );
  if (!ready2d) {
    problems.push("切到 2D 后节点没有铺开");
    return null;
  }
  await sleep(400);

  const centerPoint = await nodeCenter(page, CENTER);
  const targetPoint = await nodeCenter(page, "常青笔记");
  if (!centerPoint || !targetPoint) {
    problems.push(`2D 找不到节点坐标：center=${Boolean(centerPoint)} target=${Boolean(targetPoint)}`);
    return null;
  }
  await clickAt(page, centerPoint);
  await clickAt(page, targetPoint, 8); // 8 = Shift
  const pathShown = await page.waitFor(
    `document.body.innerText.includes('正在显示到')`,
    15000,
  );
  if (!pathShown) {
    const text = await page.evaluate("document.body.innerText.replace(/\\s+/g, ' ').slice(0, 400)");
    problems.push(`2D 路径没有建立：${text}`);
  }

  await key(page, "3", "Digit3", 51);
  if (!(await waitForScene3d(page, "3D 选中", problems))) return null;
  const samples = await sampleStats(page);
  await hideDevOverlay(page);
  await page.screenshot("phase6d-3d-selection");
  flushErrors(page, "3D 选中", problems);

  const stats = await statsOf(page);
  if (!stats || stats.labels < 1) {
    problems.push("3D 选中态标签数为 0（标签层没排或没有发布读数）：" + JSON.stringify(stats));
  }
  checkBudgets(stats, "3D 选中", problems);
  return { stats, samples, pathShown };
}

async function captureLowTier(page, problems) {
  console.log("[step] 3D 低档：窄屏");
  // 390px 宽触发 isMobile → 档位 low；URL 的 mode=3d 仍然走 3D（reason=url-3d）。
  await page.setViewport({ width: 390, height: 844, dpr: 2, mobile: true });
  await sleep(300);
  await page.goto(SEGMENT_URL(CENTER));
  if (!(await ensureHydrated(page, "3D 低档", problems))) return null;
  if (!(await waitForScene3d(page, "3D 低档", problems))) return null;

  const samples = await sampleStats(page);
  const stats = await statsOf(page);
  if (!stats || stats.labels < 1) {
    problems.push("低档标签数为 0：" + JSON.stringify(stats));
  }
  if (stats?.tier !== "low") {
    problems.push(`低档截图档位不是 low：${stats?.tier}（isMobile 没生效？）`);
  }
  if (stats?.dpr !== 1) {
    problems.push(`低档 DPR 应为 1（预算上限），实际 ${stats?.dpr}`);
  }

  const canvasBox = await page.evaluate(`(() => {
    const canvas = document.querySelector('.graph-stage-wrap[data-mode="3d"] canvas');
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return { width: Math.round(rect.width), height: Math.round(rect.height) };
  })()`);
  if (canvasBox) {
    console.log(`[note] 窄屏 3D 画布 ${canvasBox.width}×${canvasBox.height}（宽高比 ${(canvasBox.width / canvasBox.height).toFixed(2)}）`);
  }

  await hideDevOverlay(page);
  await checkOverflow(page, "3D 低档", problems);
  await page.screenshot("phase6d-3d-low");
  flushErrors(page, "3D 低档", problems);
  checkBudgets(stats, "3D 低档", problems);
  return { stats, samples, canvasBox };
}

/**
 * 换中心：走页面上真实的下拉（`select[aria-label="选择中心实体"]`），
 * 用 HTMLSelectElement 的 value setter + change 事件，等价于用户选一次。
 */
async function switchCenter(page, label, timeoutMs = 20000) {
  const has = await page.evaluate(`(() => {
    const select = document.querySelector('select[aria-label="选择中心实体"]');
    return Boolean(select) && [...select.options].some((option) => option.value === ${JSON.stringify(label)});
  })()`);
  if (!has) {
    const diag = await page.evaluate(`(() => {
      const select = document.querySelector('select[aria-label="选择中心实体"]');
      return {
        select: Boolean(select),
        total: select ? select.options.length : 0,
        sample: select ? [...select.options].slice(0, 6).map((option) => option.value) : [],
        want: ${JSON.stringify(label)},
      };
    })()`);
    console.log(`[note] switchCenter 找不到目标：${JSON.stringify(diag)}`);
    return false;
  }
  await page.evaluate(`(() => {
    const select = document.querySelector('select[aria-label="选择中心实体"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setter.call(select, ${JSON.stringify(label)});
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  return page.waitFor(
    `new URLSearchParams(location.search).get('focus') === ${JSON.stringify(label)}`,
    timeoutMs,
  );
}

/**
 * 宽夹具（>300 节点）的**真 Worker** 端到端验收。
 *
 * 与 150 基线分开：这里 373 个节点越过 `LAYOUT_WORKER_THRESHOLD=300`，
 * 布局请求必须走 `src/workers/graph-layout.worker.ts`。断言分四组：
 * 1. Worker 真身：页面建的 URL 与 CDP 的 worker 目标都对得上 `graph-layout.worker`；
 * 2. 没有降级：无 `Module not found` / `chunk-failed` / `g3-stub` 横幅；
 * 3. 读数：mode=3d、layoutTicks>0、端到端 <1200ms（400ms 只是 Worker 内预算）、
 *    drawCalls ≤8、labels 不超档位、truncated=false（373 < 600）；
 * 4. 截图落盘 `phase6d-3d-worker-600.png`。
 */
async function captureWorkerScale(page, browser, problems) {
  console.log(
    `[step] 3D Worker：${EXPECTED_NODES} 个实体（请求 ?maxNodes=${REQUEST_MAX_NODES}）`,
  );
  await page.setViewport({ width: 1440, height: 900, dpr: 1 });
  await page.goto(SEGMENT_URL(WIDE_HUB_A));
  if (!(await ensureHydrated(page, "3D Worker", problems))) return null;
  if (!(await waitForScene3d(page, "3D Worker", problems))) return null;

  const settled = await page.waitFor(
    `(() => {
      const stats = window.__graphStats;
      return Boolean(stats) && stats.mode === '3d' && stats.layoutTicks > 0 && stats.nodes === ${EXPECTED_NODES};
    })()`,
    120000,
    100,
  );
  if (!settled) {
    problems.push(
      "3D Worker 布局没有完成：" + JSON.stringify(await sceneDiagnostics(page).catch(() => null)),
    );
  }
  await sleep(800);

  const stats = await statsOf(page);
  const log = await workerLogOf(page);
  const targets = await browser.workerTargets();

  /* ---- 1. Worker 真身 ---- */
  // Turbopack 会把 Worker 包一层 wrapper chunk，真实模块名以 URL 编码的形式挂在 hash 里
  // （`...turbopack-src_workers_graph-layout_worker_ts...`），所以先解码再匹配。
  const looksLikeGraphWorker = (url) => {
    if (!url) return false;
    let decoded = String(url);
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      // 保持原样
    }
    return /graph-layout.worker/i.test(decoded);
  };

  const createdUrl = log?.workers?.[0]?.url ?? null;
  const liveUrls = targets.live.map((item) => item.url);
  const seenUrls = targets.seen.map((item) => item.url);
  const allUrls = [createdUrl, ...liveUrls, ...seenUrls].filter(Boolean).map(String);
  const workerDone = (log?.messages ?? []).find(
    (item) => item.dir === "out" && item.type === "done" && item.resultNodes === EXPECTED_NODES,
  );

  if (!createdUrl) problems.push("页面没有创建任何 Worker（探针没记录到 new Worker）");
  if (targets.live.length === 0) {
    problems.push(`CDP 看不到活着的 worker 目标（见过的：${JSON.stringify(seenUrls)}）`);
  }
  if (!allUrls.some(looksLikeGraphWorker)) {
    problems.push(
      `Worker URL 里没有 graph-layout.worker：${JSON.stringify({ createdUrl, liveUrls, seenUrls })}`,
    );
  }
  if (!workerDone) {
    // 主线程同步布局不会产生任何 Worker 消息；有 done 就说明脚本真的在 Worker 里跑完了。
    problems.push("没有收到 Worker 的 done 回包（布局可能回落到了主线程）");
  }

  /* ---- 2. 没有走降级 ---- */
  const stubText = await page.evaluate(`(() => {
    const node = document.querySelector('.g3-stub');
    return node ? node.innerText.replace(/\\s+/g, ' ').slice(0, 200) : null;
  })()`);
  if (stubText) problems.push(`3D Worker 出现了降级横幅：${stubText}`);

  /* ---- 3. 读数与两个时钟 ---- */
  if (stats?.mode !== "3d") problems.push(`3D Worker mode=${stats?.mode}`);
  if (!(stats?.layoutTicks > 0)) problems.push(`3D Worker layoutTicks=${stats?.layoutTicks}`);
  if (stats?.webgl !== true) problems.push(`3D Worker webgl=${stats?.webgl}`);

  const e2eMs =
    log && log.layoutPostedAt !== null && log.readyAt !== null
      ? Math.round(log.readyAt - log.layoutPostedAt)
      : null;
  if (e2eMs === null) {
    problems.push("量不到端到端布局时间（探针缺 layoutPostedAt / readyAt）");
  } else if (e2eMs >= 1200) {
    problems.push(`3D Worker 端到端布局 ${e2eMs}ms ≥ 1200ms`);
  }

  const workerRtt =
    log && log.layoutPostedAt !== null && log.layoutDoneAt !== null
      ? Math.round(log.layoutDoneAt - log.layoutPostedAt)
      : null;
  if (workerRtt !== null && workerRtt > 400 && log?.layoutDoneAt > 0) {
    // Worker 内的计算本身有 400ms 安全阀；超过它说明预算没生效或被 CPU 降速。
    const ticks = log.messages.find((m) => m.dir === "out" && m.type === "done")?.resultTicks;
    if (!(ticks > 0 && log.messages.some((m) => m.type === "done" && m.resultTruncated === true))) {
      problems.push(`Worker 计算 ${workerRtt}ms 超过 400ms 预算但没有截断（ticks=${ticks}）`);
    }
  }

  if (stats && stats.truncated !== false) {
    problems.push(
      `请求 ${REQUEST_MAX_NODES} 个、拿到 ${stats.nodes} 个，truncated 应为 false，实际 ${stats.truncated}`,
    );
  }
  const truncatedHint = await page.evaluate(
    "document.body.innerText.includes('可能只显示了最近')",
  );
  if (truncatedHint) problems.push("页面提示了截断（请求 600 / 拿到 373 不该提示）");
  if (stats && stats.rendered !== EXPECTED_NODES) {
    problems.push(`3D Worker 场景里渲染 ${stats.rendered} 个，应由 high 档全部保留 ${EXPECTED_NODES}`);
  }
  if (stats && stats.hidden !== 0) problems.push(`3D Worker 隐藏了 ${stats.hidden} 个节点`);
  if (!(stats?.labels >= 1)) problems.push(`3D Worker 标签数为 0：${JSON.stringify(stats)}`);
  checkBudgets(stats, "3D Worker", problems);

  await hideDevOverlay(page);
  await checkOverflow(page, "3D Worker", problems);
  await page.screenshot("phase6d-3d-worker-600");
  flushErrors(page, "3D Worker", problems);

  return {
    stats,
    e2eMs,
    workerRtt,
    workerUrl: createdUrl,
    // Turbopack 把模块名编码进 hash：解码后能看到 src_workers_graph-layout_worker_ts。
    workerUrlDecoded: createdUrl ? decodeURIComponent(createdUrl) : null,
    workerTargets: targets.live,
    seenWorkerTargets: seenUrls,
    workerDone: workerDone
      ? {
          resultNodes: workerDone.resultNodes,
          resultTicks: workerDone.resultTicks,
          resultLayoutMs: workerDone.resultLayoutMs,
          resultTruncated: workerDone.resultTruncated,
        }
      : null,
    log,
    stubText,
  };
}

/**
 * 取消语义：换中心时旧 Worker 请求不能覆盖新布局。
 *
 * 373 个节点在 Worker 里约 60–95ms 就算完，而一次换中心（下拉 → 路由 → 取数 → 重算）
 * 也是几十毫秒，单次几乎撞不进「旧请求还在算」的窗口。所以这里做多轮（默认 5 轮）：
 * 每轮重新加载页面，在布局请求刚发出时切中心，统计有多少轮真的出现「旧 done 晚于
 * 新请求」，以及每一轮最终采纳的布局是否都属于新中心。
 * 一轮都没撞上就返回 `reproduced: false`，报告里写「未验证」——不伪造。
 */
async function measureCenterSwitchCancel(page, problems, attempts = 5) {
  console.log(`[step] 3D Worker：换中心 + 取消语义（${attempts} 轮）`);
  await page.setViewport({ width: 1440, height: 900, dpr: 1 });

  const rounds = [];

  for (let round = 1; round <= attempts; round += 1) {
    await page.goto(SEGMENT_URL(WIDE_HUB_A));
    const posted = await page.waitFor(
      "Boolean(window.__workerLog && window.__workerLog.layoutPostedAt !== null)",
      120000,
      10,
    );
    if (!posted) {
      problems.push(`取消语义（第 ${round} 轮）：等不到 Worker 布局请求`);
      break;
    }

    // 旧布局刚发出（大概率还在 Worker 里算），立刻换中心。
    const switched = await switchCenter(page, WIDE_HUB_B, 30000);
    if (!switched) {
      problems.push(`取消语义（第 ${round} 轮）：换中心没有生效`);
      break;
    }

    const ready = await page.waitFor(
      `(() => {
        const stats = window.__graphStats;
        return Boolean(stats) && stats.focus === ${JSON.stringify(WIDE_HUB_B)} && stats.layoutTicks > 0;
      })()`,
      120000,
      100,
    );
    if (!ready) {
      problems.push(`取消语义（第 ${round} 轮）：换中心后的布局没有完成`);
      break;
    }
    await sleep(400);

    const log = await workerLogOf(page);
    const stats = await statsOf(page);
    const posts = log.messages.filter((m) => m.dir === "in" && m.type === "layout");
    const dones = log.messages.filter((m) => m.dir === "out" && m.type === "done");
    const cancelled = log.messages.filter((m) => m.dir === "out" && m.type === "cancelled");
    const lastPostAt = posts[posts.length - 1]?.at ?? null;
    const lastDone = dones[dones.length - 1] ?? null;
    // 旧中心（甲）的 done 在新请求发出之后才回到主线程 —— 这就是要丢的那条。
    const oldDone = dones.find(
      (item) =>
        Array.isArray(item.resultHead) &&
        item.resultHead.some((id) => String(id).includes("甲")) &&
        lastPostAt !== null &&
        item.at > lastPostAt,
    );
    const finalFromNewCenter =
      Array.isArray(lastDone?.resultHead) &&
      lastDone.resultHead.some((id) => String(id).includes("乙"));

    rounds.push({
      round,
      posts: posts.length,
      dones: dones.length,
      cancelled: cancelled.length,
      oldDoneAfterPost: Boolean(oldDone),
      oldDoneHead: oldDone?.resultHead ?? null,
      finalFromNewCenter,
      finalFocus: stats?.focus ?? null,
      finalNodes: stats?.nodes ?? null,
      lastDoneHead: lastDone?.resultHead ?? null,
    });

    if (!finalFromNewCenter) {
      problems.push(
        `取消语义（第 ${round} 轮）：最终布局不是新中心的 ${JSON.stringify(lastDone?.resultHead)}`,
      );
    }
    if (stats?.focus !== WIDE_HUB_B) {
      problems.push(`取消语义（第 ${round} 轮）：最终 focus=${stats?.focus}`);
    }

    if (oldDone) break; // 已经抓到真实重叠，不必再耗轮次
  }

  const overlappedRounds = rounds.filter((item) => item.oldDoneAfterPost).length;
  return {
    reproduced: overlappedRounds > 0,
    attempts: rounds.length,
    overlappedRounds,
    allFinalFromNewCenter: rounds.length > 0 && rounds.every((item) => item.finalFromNewCenter),
    cancelled: rounds.reduce((sum, item) => sum + item.cancelled, 0),
    rounds,
  };
}

async function main() {
  if (!existsSync(NEXT_BIN)) throw new Error(`找不到 next：${NEXT_BIN}`);
  if (!CHROME) throw new Error("找不到 Chrome / Edge，可设置 CHROME_PATH");

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pakp-graph3d-"));
  const dbFile = path.join(tmpDir, "perf.db");
  const problems = [];
  const readings = {};
  let mock = null;
  let app = null;
  let browser = null;

  try {
    console.log(`[setup] 临时库 ${dbFile}`);
    await seedDatabase(dbFile);
    mock = await startMockLightrag();
    console.log(`[setup] mock LightRAG ${mock.url}`);

    browser = await launchBrowser();
    app = await startApp({ dbFile, lightragUrl: mock.url });
    console.log(`[setup] dev 服务 ${BASE}`);

    const page = await openPage(browser.cdp);

    if (WORKER_SCALE) {
      readings.worker = await captureWorkerScale(page, browser, problems);
      readings.cancel = await measureCenterSwitchCancel(page, problems);
    } else {
      readings.desktop = await captureDefaultView(page, problems);
      readings.autoRotate = await measureAutoRotate(page, problems);
      readings.selection = await captureSelection(page, problems);
      readings.low = await captureLowTier(page, problems);
    }

    await page.close();
  } finally {
    await stopApp(app).catch(() => {});
    await mock?.close();
    await browser?.close();
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }

  console.log("\n[readings]");
  console.log(JSON.stringify(readings, null, 2));

  console.log(
    `[setup] 规模 ${WORKER_SCALE ? "Worker（宽夹具）" : "基线"}：请求 maxNodes=${REQUEST_MAX_NODES}，期望 ${EXPECTED_NODES} 个实体`,
  );
  if (problems.length > 0) {
    console.error("\n[problems]");
    for (const problem of problems) console.error(`- ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log(`\n[ok] 3D 验收通过（${WORKER_SCALE ? "Worker 宽夹具" : "150 基线与截图"}）`);
}

await main();
