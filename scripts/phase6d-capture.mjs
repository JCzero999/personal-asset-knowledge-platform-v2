/**
 * Phase 6D 验收截图：2D 聚焦视图（桌面 / 移动 / 列表 / 空 / 错误）+ 6D-3 的 3D 集成
 * （默认入口 / 移动端回落 / 低档 / 抽稀 / 自适应降档）。
 *
 * 自包含，不需要手工起服务：
 *   1. 在系统临时目录建库、跑迁移、播入 8 个对象（**不能放项目目录**：
 *      SQLite 的 -wal 每次写入都会被 Turbopack 判定为「文件变了」→ HMR 整页重载，
 *      页面永远点不动，见 07_PLAYBOOK 第 85 条）；
 *   2. 起一个 mock LightRAG（标签 / 子图 / 文档状态），可切换 empty / full / wide /
 *      graph-error 等模式；`wide` 是 6D-3 的诊断夹具（373 个实体），默认截图的规模不受影响；
 *   3. `AUTH_MODE=mock` 起 next dev，无头 Chrome（**带 --enable-unsafe-swiftshader，
 *      不用 --disable-gpu**，这样默认会进真实 WebGL）通过 CDP 截图；
 *   4. 断言零 console / page 错误、无横向溢出、关键 DOM 与错误文案存在。
 *
 * 用法：node scripts/phase6d-capture.mjs
 * 可选环境变量：APP_PORT（默认 3123）、CDP_PORT（默认 9338）、CHROME_PATH。
 * 调试时可用 PHASE6D_STEPS=desktop,3d 只跑指定步骤。
 *
 * 生产运行时验收（6D 收尾）：`PHASE6D_PROD=1` 改为 `next build` + `next start`，
 * 默认步骤 prod-default / prod-downgrade / prod-worker / prod-decimate；
 * 生产构建里没有 `__graphStats`，断言只读可见 DOM + 截图像素统计。
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

const APP_PORT = Number(process.env.APP_PORT || 3123);
// 必须用 localhost：Next dev 默认只放行自己的 host，用 127.0.0.1 访问会被
// 拦掉 /_next/hmr 等 dev 资源，RSC 载荷不执行 → 页面永远停在 SSR、不水合。
const BASE = `http://localhost:${APP_PORT}`;
const CDP_PORT = Number(process.env.CDP_PORT || 9338);
const OWNER_SUB = "mock-local-user";

/**
 * 生产运行时验收（6D 收尾）：`PHASE6D_PROD=1` 时用 `next build` + `next start`
 * 跑同一套 mock LightRAG / Chrome，断言只读可见 DOM —— 生产构建里
 * `window.__graphStats` 被 `NODE_ENV !== "production"` 守卫生成，根本不存在。
 */
const PROD = process.env.PHASE6D_PROD === "1";
const BUILD_DIR = ".next-build";

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
 * 2. 图夹具：44 个实体（含 4 个孤立点）、52 条原始边（含平行边）、7 份文档状态。
 * ------------------------------------------------------------------ */

const CENTER = "知识管理";
const ERROR_LABEL = "__boom__";
// 换中心失败要用一个真实存在于下拉里的标签：__boom__ 没有实体，会被 ADR-011 的
// 「只返回本账号内容涉及的实体」过滤掉，根本不会出现在「中心」下拉里。
const FAIL_CENTER = "常青笔记";

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

const RING2_NAMES = [
  "费曼学习法", "双向链接", "每日回顾", "主题阅读", "写作冲刺", "概念地图",
  "渐进式阅读", "卡片盒", "文献笔记", "周回顾", "深度阅读", "输出倒逼输入",
  "知识花园", "笔记回顾", "标签体系", "内容日历", "选题池", "素材库",
  "灵感捕捉", "长期主义", "刻意练习", "复盘模板", "知识资产", "检索技巧",
  "语义搜索", "RAG 调优", "信息茧房",
];
const RING2_TYPES = ["方法", "概念", "作品", "其他", "方法", "概念", "作品"];

const ORPHANS = [
  ["孤岛手记", "其他"],
  ["未整理的剪藏", "作品"],
  ["半成品的想法", "概念"],
  ["待命名的线索", "其他"],
];

const ENTITIES = [
  { id: CENTER, type: "概念", description: "把个人经验沉淀成可检索、可复用的知识体系，是整张图的中心。" },
  ...RING1.map(([id, type], index) => ({
    id,
    type,
    description:
      index === 4
        ? ""
        : `${id}是知识管理里经常出现的一个概念，来自${OBJECTS[index % OBJECTS.length].title}。`,
  })),
  ...RING2_NAMES.map((id, index) => ({
    id,
    type: RING2_TYPES[index % RING2_TYPES.length],
    description: `${id}与${RING1[index % RING1.length][0]}一起出现在同一批笔记里。`,
  })),
  ...ORPHANS.map(([id, type]) => ({ id, type, description: `${id}还没有和任何实体建立关系。` })),
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
RING2_NAMES.forEach((id, index) => {
  addEdge(RING1[index % RING1.length][0], id, `延伸<SEP>${id}从${RING1[index % RING1.length][0]}继续展开。`);
});
// 平行边：同端点、不同关系 → 两条都保留；同关系再写一条 → 合并为 weight 2 的强边。
addEdge(CENTER, "卡片笔记", "扩展<SEP>卡片笔记同时被中心当作入口与出口。");
addEdge(CENTER, "第二大脑", "支撑<SEP>第二大脑是知识管理的长期容器。");
addEdge(CENTER, "第二大脑", "支撑<SEP>第二大脑的维护依赖周期性回顾。");
addEdge("林默", "内容工作室", "协作<SEP>林默在内容工作室里实践卡片笔记。");
addEdge("内容工作室", "林默", "雇佣<SEP>内容工作室由林默独立运营。");
// 环：让两点之间出现 2 跳路径，供 Shift+单击截图使用。
addEdge("卡片笔记", "常青笔记", "演化<SEP>卡片笔记逐步演化成常青笔记。");
addEdge("常青笔记", "第二大脑", "沉淀<SEP>常青笔记最终沉淀进第二大脑。");
addEdge("渐进式总结", "常青笔记", "产出<SEP>渐进式总结的终点是常青笔记。");
addEdge("PARA 方法", "内容工作室", "组织<SEP>PARA 方法用来组织内容工作室的素材。");
addEdge("检索增强生成", "RAG 调优", "包含<SEP>检索增强生成包含 RAG 调优这一实践环节。");
addEdge("费曼学习法", "输出倒逼输入", "依赖<SEP>费曼学习法依赖输出倒逼输入。");

const LABELS = [
  CENTER,
  ...RING1.slice(0, 8).map(([id]) => id),
  ORPHANS[0][0],
  // 放进「中心」下拉，才能在同一个页面里演一次「换中心失败」（旧图必须留着）。
  ERROR_LABEL,
];

/* ------------------------------------------------------------------ *
 * 2b. 宽图夹具（只给 6D-3 的 `wide` 模式用）。
 *
 * 默认夹具只有 44 个实体，任何档位预算都装得下，`decimate` 分支永远走不到。
 * `wide` 造 373 个实体（1 中心 + 12 一环 + 120 二环 + 240 三环），
 * 于是「低档预算 150 + 请求 600」真的会抽稀：中心与 12 个一环全留，
 * 剩余名额补二环，三环全部汇入提示条。默认截图与 2D 断言都不使用这份数据。
 * ------------------------------------------------------------------ */

const WIDE_RING1 = Array.from(
  { length: 12 },
  (_, index) => `宽图主题 ${String(index + 1).padStart(2, "0")}`,
);
// 第二个互不相连的枢纽：换中心后深度 3 仍能到 373 个实体（>300 → 仍走 Worker）。
// 第一个枢纽（知识管理）的 3 层邻域只有 373 个；从任意「宽图主题」出发只有 153 个，
// 换中心那一步会掉到 Worker 阈值以下，验不出「换中心后仍走 Worker」。
const WIDE_HUB2 = "宽图枢纽二";
const WIDE_HUB2_RING = Array.from(
  { length: 12 },
  (_, index) => `宽图支线 ${String(index + 1).padStart(2, "0")}`,
);

function buildWideDataset() {
  const entities = [{ id: CENTER, type: "概念", description: "宽图夹具的中心实体。" }];
  const edges = [];
  const addEdgeWide = (source, target, relation) => {
    edges.push({
      source,
      target,
      description: `${relation}<SEP>${target} 与 ${source} 在宽图夹具里相连。`,
      filePath: filePathFor(OBJECTS[edges.length % OBJECTS.length].id),
    });
  };

  WIDE_RING1.forEach((id) => {
    entities.push({ id, type: "概念", description: `${id} 是宽图的一环主题。` });
    addEdgeWide(CENTER, id, "关联");
  });
  WIDE_RING1.forEach((id) => {
    for (let k = 1; k <= 10; k += 1) {
      const sub = `${id} 子题 ${k}`;
      entities.push({ id: sub, type: "方法", description: `${sub} 挂在 ${id} 下。` });
      addEdgeWide(id, sub, "延伸");
      for (let m = 1; m <= 2; m += 1) {
        const leaf = `${sub} 素材 ${m}`;
        entities.push({ id: leaf, type: "其他", description: `${leaf} 是 ${sub} 的具体素材。` });
        addEdgeWide(sub, leaf, "包含");
      }
    }
  });

  // 第二个枢纽：结构与第一个完全相同，但与「知识管理」不连通。
  entities.push({ id: WIDE_HUB2, type: "概念", description: "宽图夹具的第二个枢纽。" });
  WIDE_HUB2_RING.forEach((id) => {
    entities.push({ id, type: "概念", description: `${id} 是第二枢纽的一环主题。` });
    addEdgeWide(WIDE_HUB2, id, "关联");
  });
  WIDE_HUB2_RING.forEach((id) => {
    for (let k = 1; k <= 10; k += 1) {
      const sub = `${id} 子题 ${k}`;
      entities.push({ id: sub, type: "方法", description: `${sub} 挂在 ${id} 下。` });
      addEdgeWide(id, sub, "延伸");
      for (let m = 1; m <= 2; m += 1) {
        const leaf = `${sub} 素材 ${m}`;
        entities.push({ id: leaf, type: "其他", description: `${leaf} 是 ${sub} 的具体素材。` });
        addEdgeWide(sub, leaf, "包含");
      }
    }
  });

  entities.forEach((entity, index) => {
    entity.filePath = filePathFor(OBJECTS[index % OBJECTS.length].id);
  });
  return {
    entities,
    byId: new Map(entities.map((entity) => [entity.id, entity])),
    edges,
    labels: [CENTER, WIDE_HUB2, ...WIDE_RING1.slice(0, 8)],
  };
}

const WIDE = buildWideDataset();

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
      if (mode === "empty" || mode === "full" || mode === "wide" || mode === "graph-error" || mode === "status-error" || mode === "center-error") {
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
      return json(response, 200, state.mode === "wide" ? WIDE.labels : LABELS);
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
      return json(response, 200, neighborhood(label, maxDepth, maxNodes, state.mode === "wide" ? WIDE : null));
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

let prodBuilt = false;

/**
 * 生产构建只做一次。构建期给一个临时 DATABASE_PATH：即使某个页面试图读库，
 * 也碰不到 `data/app.db`。`PHASE6D_REBUILD=1` 可强制重建。
 */
async function ensureProdBuild() {
  if (prodBuilt) return;
  if (existsSync(path.join(ROOT, BUILD_DIR, "BUILD_ID")) && !process.env.PHASE6D_REBUILD) {
    prodBuilt = true;
    return;
  }

  console.log(`[build] next build → ${BUILD_DIR}（生产构建，约 10–30s）`);
  const child = spawn(process.execPath, [NEXT_BIN, "build"], {
    cwd: ROOT,
    env: {
      ...process.env,
      AUTH_MODE: "mock",
      DATABASE_PATH: path.join(os.tmpdir(), "pakp-build-unused.db"),
      NEXT_DIST_DIR: BUILD_DIR,
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

  const code = await new Promise((resolve) => {
    child.on("exit", resolve);
    setTimeout(() => {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      resolve(-1);
    }, 300000).unref();
  });
  if (code !== 0) {
    throw new Error(`next build 失败（exit ${code}）：\n${logs.join("").slice(-4000)}`);
  }
  const tail = logs.join("").split("\n").filter((line) => /Compiled|TypeScript|static pages/.test(line));
  console.log(`[build] 完成：${tail.join(" · ") || "exit 0"}`);
  prodBuilt = true;
}

async function startApp({ dbFile, lightragUrl }) {
  // 上一次被强杀的脚本可能留下一个还占着端口的 dev 服务：
  // 健康检查会误连到它（数据库已删、mock 已停），表现为页面永远不水合。
  if (await portInUse(APP_PORT)) {
    throw new Error(`端口 ${APP_PORT} 已被占用；先停掉旧进程，或用 APP_PORT=xxxx 换一个。`);
  }

  if (PROD) await ensureProdBuild();

  const child = spawn(
    process.execPath,
    [NEXT_BIN, PROD ? "start" : "dev", "-p", String(APP_PORT)],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        AUTH_MODE: "mock",
        DATABASE_PATH: dbFile,
        LIGHTRAG_BASE_URL: lightragUrl,
        LIGHTRAG_API_KEY: "phase6d-mock",
        // Next 16 的 dev 锁在 distDir/lock：3000 上的日常 dev 服务占着 `.next`，
        // 这里换一个构建目录才能并存（next.config.ts 已支持 NEXT_DIST_DIR）。
        NEXT_DIST_DIR: PROD ? BUILD_DIR : ".next-mock",
        NEXT_TELEMETRY_DISABLED: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );

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
      // 6D-3 起默认入口就是真实 3D：不能关 GPU，否则 webgl=false，页面永远回落 2D。
      // 无头环境用 SwiftShader 软件渲染，读数可复现但帧率不代表真机。
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

async function waitForStage(page, minNodes, timeoutMs = 60000) {
  return page.waitFor(
    `(() => {
      const stage = document.querySelector('.g2-stage');
      if (!stage) return false;
      if (document.querySelectorAll('.g2-node').length < ${minNodes}) return false;
      const rect = stage.getBoundingClientRect();
      return rect.width > 480 && rect.height > 240;
    })()`,
    timeoutMs,
  );
}

async function captureEmpty(page, problems) {
  console.log("[step] 空状态");
  await page.setViewport({ width: 1440, height: 900, dpr: 1 });
  await page.goto(`${BASE}/graph`);
  const shown = await page.waitFor(
    `document.body.innerText.includes('图谱还是空的')`,
    45000,
  );
  if (!shown) {
    const text = await page.evaluate("document.body.innerText.slice(0, 400)");
    problems.push(`空状态没有出现：${text.replace(/\s+/g, " ")}`);
    return;
  }
  await ensureHydrated(page, "空状态", problems);
  await checkOverflow(page, "空状态", problems);
  await page.screenshot("phase6d-2d-empty");
  flushErrors(page, "空状态", problems);
}

async function captureDesktop(page, problems) {
  console.log("[step] 桌面 2D：选择 + 路径");
  await page.setViewport({ width: 1440, height: 900, dpr: 1 });
  await page.goto(`${BASE}/graph?mode=2d&focus=${encodeURIComponent(CENTER)}&depth=2`);

  await ensureHydrated(page, "桌面 2D", problems);
  if (!(await waitForStage(page, 40, 90000))) {
    const text = await page.evaluate("document.body.innerText.slice(0, 400)");
    problems.push(`2D 舞台没有就绪：${text.replace(/\s+/g, " ")}`);
    return;
  }
  await sleep(1500); // 等 hydration 与尺寸稳定

  const stats = await page.evaluate(`({
    nodes: document.querySelectorAll('.g2-node').length,
    edges: document.querySelectorAll('.g2-edges line').length,
    labels: document.querySelectorAll('.g2-label').length,
    mode: document.querySelector('.graph-workspace')?.getAttribute('data-mode'),
    failed: document.querySelector('.graph-failures')?.innerText.slice(0, 200) ?? null,
    pageNodes: (window.__graphStats && window.__graphStats.nodes) ?? null,
  })`);
  console.log(
    `[check] 2D 渲染：${stats.nodes} 个节点 / ${stats.edges} 条边 / ${stats.labels} 个标签（view ${stats.pageNodes}）`,
  );
  if (stats.nodes < 40) problems.push(`2D 舞台只画了 ${stats.nodes} 个节点（预期 ≥40）`);
  if (stats.edges < 40) problems.push(`2D 舞台只画了 ${stats.edges} 条边（预期 ≥40）`);
  if (stats.labels < 1) problems.push("2D 舞台没有可见标签");
  if (stats.mode !== "2d") problems.push(`data-mode=${stats.mode}`);
  if (!stats.failed || !stats.failed.includes("2 个对象抽取失败")) {
    problems.push(`失败明细没有渲染：${stats.failed}`);
  }
  const failureText = await page.evaluate(
    "document.querySelector('.graph-failures')?.textContent ?? ''",
  );
  if (!/6d0a1f10/.test(failureText)) problems.push("失败明细里没有 objectId 前 8 位");

  // 键盘提示与实际按键一致（3 = 星系视图），自动旋转默认关。
  const svgLabel = await page.evaluate(
    "document.querySelector('.g2-svg')?.getAttribute('aria-label') ?? ''",
  );
  if (!svgLabel.includes("按 3")) problems.push(`2D 画布的快捷键提示没有改到 3：${svgLabel}`);
  const rotate = await page.evaluate(`(() => {
    const button = document.querySelector('.graph-autorotate');
    if (!button) return null;
    return { pressed: button.getAttribute('aria-pressed'), text: button.innerText.trim() };
  })()`);
  const modeButtons = await page.evaluate("document.querySelectorAll('.graph-mode-button').length");
  if (modeButtons >= 3) {
    if (!rotate) problems.push("有 3D 入口，但工具栏没有「自动旋转」开关");
    else if (rotate.pressed !== "false") problems.push(`自动旋转默认不是关闭：aria-pressed=${rotate.pressed}`);
    else console.log(`[check] 自动旋转开关：${rotate.text} · aria-pressed=false`);
  } else {
    console.log("[note] 本机 headless 没有 WebGL，3D 入口按判定隐藏，自动旋转开关不出现");
  }

  // 选择：单击「卡片笔记」，Shift + 单击「第二大脑」→ 经过中心的两跳路径。
  const first = await nodeCenter(page, "卡片笔记");
  if (!first) {
    problems.push("找不到「卡片笔记」的节点坐标");
  } else {
    await clickAt(page, first);
    const selected = await page.waitFor(
      `document.querySelector('.graph-inspector h2')?.textContent?.trim() === '卡片笔记'`,
      5000,
    );
    if (!selected) problems.push("单击「卡片笔记」后详情栏没有切换");

    const second = await nodeCenter(page, "第二大脑");
    if (!second) {
      problems.push("找不到「第二大脑」的节点坐标");
    } else {
      await clickAt(page, second, 8);
      const pathShown = await page.waitFor(
        `document.querySelector('.graph-path-bar')?.innerText.includes('2 跳') ?? false`,
        5000,
      );
      if (!pathShown) {
        const bar = await page.evaluate(
          "document.querySelector('.graph-path-bar')?.innerText ?? '(无路径条)'",
        );
        problems.push(`Shift + 单击没有显示路径：${bar}`);
      } else {
        // prefers-reduced-motion：路径边的流动动画必须停下。
        const animationBefore = await page.evaluate(
          "getComputedStyle(document.querySelector('.g2-edge.is-path')).animationName",
        );
        await page.send("Emulation.setEmulatedMedia", {
          features: [{ name: "prefers-reduced-motion", value: "reduce" }],
        });
        await sleep(500);
        const animationAfter = await page.evaluate(
          "getComputedStyle(document.querySelector('.g2-edge.is-path')).animationName",
        );
        const rotateStillThere = await page.evaluate(
          "Boolean(document.querySelector('.graph-autorotate'))",
        );
        if (animationBefore === "none") problems.push("路径边动画没有启用，reduced-motion 断言失去意义");
        if (animationAfter !== "none") problems.push(`reduced-motion 下路径边动画仍在跑：${animationAfter}`);
        if (rotateStillThere) problems.push("reduced-motion 下仍显示自动旋转开关");
        console.log(`[check] 路径动画 ${animationBefore} → reduced-motion 下 ${animationAfter}`);
        await page.send("Emulation.setEmulatedMedia", { features: [] });
        await sleep(300);
      }
    }
  }

  // 键盘：焦点进画布，ArrowRight 移动，Enter 选中。
  await page.evaluate("document.querySelector('.g2-svg').focus()");
  await key(page, "ArrowRight", "ArrowRight", 39);
  await key(page, "Enter", "Enter", 13);
  const announced = await page.evaluate(
    "document.querySelector('.sr-only[role=status]')?.textContent ?? ''",
  );
  if (!announced.includes("已选中")) problems.push(`键盘 Enter 没有选中：${announced}`);

  await checkOverflow(page, "桌面 2D", problems);
  await page.screenshot("phase6d-2d-desktop");
  flushErrors(page, "桌面 2D", problems);
}

async function captureList(page, problems) {
  console.log("[step] 桌面列表");
  await page.setViewport({ width: 1440, height: 900, dpr: 1 });
  await page.goto(`${BASE}/graph?mode=list&focus=${encodeURIComponent(CENTER)}&depth=2`);

  await ensureHydrated(page, "桌面列表", problems);
  const ready = await page.waitFor(
    `document.querySelectorAll('.graph-list-rows li').length >= 40`,
    60000,
  );
  if (!ready) {
    const text = await page.evaluate("document.body.innerText.slice(0, 400)");
    problems.push(`列表没有就绪：${text.replace(/\s+/g, " ")}`);
    return;
  }
  await sleep(800);

  const firstRow = await page.evaluate(`(() => {
    const row = document.querySelector('.graph-list-row');
    if (!row) return null;
    const rect = row.getBoundingClientRect();
    return { x: rect.left + Math.min(80, rect.width / 2), y: rect.top + rect.height / 2 };
  })()`);
  if (firstRow) {
    await clickAt(page, firstRow);
    const selected = await page.waitFor(
      `Boolean(document.querySelector('.graph-list-row[aria-pressed="true"]'))`,
      5000,
    );
    if (!selected) problems.push("列表里点选行后没有选中态");
  } else {
    problems.push("列表里没有可点击的行");
  }

  await checkOverflow(page, "桌面列表", problems);
  await page.screenshot("phase6d-2d-list");
  flushErrors(page, "桌面列表", problems);
}

async function captureMobile(page, problems) {
  console.log("[step] 移动端 390×844（先在 760 宽渲染，再缩到 390）");
  // 先在窄但非移动的宽度出首帧，再切到移动端：这是「尺寸换档后旧锚点被夹到边界」的复现路径。
  await page.setViewport({ width: 760, height: 900, dpr: 1 });
  await page.goto(`${BASE}/graph?mode=2d&focus=${encodeURIComponent(CENTER)}&depth=2`);

  await ensureHydrated(page, "移动端", problems);
  const wideReady = await page.waitFor(
    `(() => {
      if (document.querySelectorAll('.g2-node').length < 40) return false;
      const stage = document.querySelector('.g2-stage');
      if (!stage) return false;
      const rect = stage.getBoundingClientRect();
      return rect.width > 400 && rect.height > 240;
    })()`,
    90000,
  );
  if (!wideReady) {
    const text = await page.evaluate("document.body.innerText.slice(0, 400)");
    problems.push(`移动端前一步（760 宽）2D 没有就绪：${text.replace(/\s+/g, " ")}`);
    return;
  }
  await sleep(1200);

  await page.setViewport({ width: 390, height: 844, dpr: 2, mobile: true });
  const ready = await page.waitFor(
    `(() => {
      if (document.querySelectorAll('.g2-node').length < 40) return false;
      const stage = document.querySelector('.g2-stage');
      if (!stage) return false;
      const rect = stage.getBoundingClientRect();
      return rect.width > 240 && rect.width < 390 && rect.height > 200;
    })()`,
    30000,
  );
  if (!ready) {
    const text = await page.evaluate("document.body.innerText.slice(0, 400)");
    problems.push(`移动端 2D 没有就绪：${text.replace(/\s+/g, " ")}`);
    return;
  }
  await sleep(1500);

  const metrics = await page.evaluate(`(() => {
    const stage = document.querySelector('.g2-stage').getBoundingClientRect();
    const shapes = [...document.querySelectorAll('.g2-node .g2-shape')];
    let hugging = 0;
    for (const shape of shapes) {
      const rect = shape.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      if (
        cx <= stage.left + 12 ||
        cx >= stage.right - 12 ||
        cy <= stage.top + 12 ||
        cy >= stage.bottom - 12
      ) {
        hugging += 1;
      }
    }
    return {
      mode: document.querySelector('.graph-workspace')?.getAttribute('data-mode'),
      nodes: document.querySelectorAll('.g2-node').length,
      stageWidth: Math.round(stage.width),
      inner: window.innerWidth,
      hugging,
      huggingRatio: shapes.length ? hugging / shapes.length : 1,
    };
  })()`);
  if (metrics.mode !== "2d") problems.push(`移动端 data-mode=${metrics.mode}`);
  if (metrics.nodes < 40) problems.push(`移动端只画了 ${metrics.nodes} 个节点`);
  if (metrics.stageWidth > metrics.inner) {
    problems.push(`移动端舞台比视口宽：${metrics.stageWidth} > ${metrics.inner}`);
  }
  // 760 → 390 换档后：沿用旧锚点会把节点全夹在边界上，重排后应低于一半。
  console.log(
    `[check] 移动端 ${metrics.nodes} 个节点，贴边 ${metrics.hugging} 个（${(metrics.huggingRatio * 100).toFixed(0)}%）`,
  );
  if (metrics.huggingRatio >= 0.5) {
    problems.push(`缩到 390 宽后有 ${metrics.hugging}/${metrics.nodes} 个节点贴在舞台边界上（换档没有重排）`);
  }

  await checkOverflow(page, "移动端", problems);
  await page.screenshot("phase6d-2d-mobile");
  flushErrors(page, "移动端", problems);
}

/* ---- 6D-3：3D 集成（默认入口 / 移动端回落 / 低档 / 抽稀 / 自适应降档） ---- */

const LABEL_CAPS = { low: 12, balanced: 24, high: 40 };
const DRAW_CALL_BUDGET = 8;

async function statsOf(page) {
  return page.evaluate("window.__graphStats ? { ...window.__graphStats } : null");
}

/** 3D 真的起来了：容器已水合、判定为 3d、有 WebGL 画布、至少画过一帧。 */
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
    const diagnostics = await page
      .evaluate(`(() => {
        const stage = document.querySelector('.graph-stage-wrap[data-mode="3d"]');
        const stub = document.querySelector('.g3-stub');
        return {
          stats: window.__graphStats ? { ...window.__graphStats } : null,
          stage: Boolean(stage),
          canvas: stage ? Boolean(stage.querySelector('canvas')) : false,
          stubText: stub ? stub.innerText.replace(/\\s+/g, ' ').slice(0, 240) : null,
          body: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 300),
        };
      })()`)
      .catch(() => null);
    problems.push(`${label} 3D 场景没有起来：${JSON.stringify(diagnostics)}`);
  }
  return ok;
}

function check3dBudgets(stats, label, problems) {
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
}

/** 不写 mode：桌面应自动进真实 3D（本轮最核心的验收）。 */
async function capture3dDefault(page, problems, readings) {
  console.log("[step] 桌面默认入口：URL 不带 mode");
  await page.setViewport({ width: 1440, height: 900, dpr: 1 });
  await page.goto(`${BASE}/graph?focus=${encodeURIComponent(CENTER)}&depth=2`);

  await ensureHydrated(page, "3D 默认入口", problems);
  if (!(await waitForScene3d(page, "3D 默认入口", problems))) return;
  await sleep(1800); // 等布局 / 标签稳定（demand 渲染，静止后不再出帧）

  const info = await page.evaluate(`(() => {
    const button = [...document.querySelectorAll('.graph-mode-button')]
      .find((item) => item.textContent.trim() === '星系');
    return {
      mode: document.querySelector('.graph-workspace')?.getAttribute('data-mode'),
      hint: document.querySelector('.graph-status p')?.innerText.trim() ?? '',
      title: button ? button.getAttribute('title') : null,
      pressed: button ? button.getAttribute('aria-pressed') : null,
      canvas: Boolean(document.querySelector('.graph-stage-wrap[data-mode="3d"] canvas')),
      stub: Boolean(document.querySelector('.g3-stub')),
    };
  })()`);
  const stats = await statsOf(page);
  readings.entry = { ...info, ...stats };
  console.log(
    `[check] 默认入口 data-mode=${info.mode} · reason=${stats?.reason} · tier=${stats?.tier} · ` +
      `drawCalls=${stats?.drawCalls} · labels=${stats?.labels} · layoutMs=${stats?.layoutMs}/${stats?.layoutTicks} ticks`,
  );

  if (info.mode !== "3d") problems.push(`默认入口没有进 3D：data-mode=${info.mode}`);
  if (stats?.reason !== "auto-3d") problems.push(`默认入口的判定原因不是 auto-3d：${stats?.reason}`);
  if (!info.canvas) problems.push("默认入口没有挂上 WebGL 画布");
  if (info.stub) problems.push("默认入口仍渲染 3D 桩");
  // 状态条在「有对象在抽取」时显示排队文案而不是视图提示（夹具里常驻 1 个 processing），
  // 所以这里不断言 hint 文案，只断言决定性的 DOM / 读数。
  if (info.title && info.title.includes("桩")) problems.push(`「星系」按钮仍带桩文案：${info.title}`);
  if (info.pressed !== "true") problems.push(`「星系」按钮不是按下态：${info.pressed}`);
  check3dBudgets(stats, "3D 默认入口", problems);

  await hideDevOverlay(page);
  await checkOverflow(page, "3D 默认入口", problems);
  await page.screenshot("phase6d-3d-default-entry");
  flushErrors(page, "3D 默认入口", problems);
}

/** 移动端（390×844）不带 mode：必须回落 2D，且 3D 入口按原规则隐藏。 */
async function capture3dMobileFallback(page, problems, readings) {
  console.log("[step] 移动端默认入口：应回落 2D");
  await page.setViewport({ width: 390, height: 844, dpr: 2, mobile: true });
  await page.goto(`${BASE}/graph?focus=${encodeURIComponent(CENTER)}&depth=2`);

  await ensureHydrated(page, "3D 移动端回落", problems);
  const ready = await page.waitFor(
    `(() => {
      if (document.querySelectorAll('.g2-node').length < 40) return false;
      const stage = document.querySelector('.g2-stage');
      if (!stage) return false;
      const rect = stage.getBoundingClientRect();
      return rect.width > 240 && rect.width < 390 && rect.height > 200;
    })()`,
    90000,
  );
  if (!ready) {
    const text = await page.evaluate("document.body.innerText.slice(0, 400)");
    problems.push(`移动端回落后的 2D 没有就绪：${text.replace(/\s+/g, " ")}`);
    return;
  }
  await sleep(1200);

  const info = await page.evaluate(`(() => ({
    mode: document.querySelector('.graph-workspace')?.getAttribute('data-mode'),
    hint: document.querySelector('.graph-status p')?.innerText.trim() ?? '',
    buttons: document.querySelectorAll('.graph-mode-button').length,
    hasGalaxyButton: [...document.querySelectorAll('.graph-mode-button')]
      .some((item) => item.textContent.trim() === '星系'),
    canvas3d: Boolean(document.querySelector('.graph-stage-wrap[data-mode="3d"] canvas')),
    nodes: document.querySelectorAll('.g2-node').length,
  }))()`);
  readings.mobile = info;
  console.log(
    `[check] 移动端 data-mode=${info.mode} · 模式按钮 ${info.buttons} 个 · 2D 节点 ${info.nodes}`,
  );

  if (info.mode !== "2d") problems.push(`移动端默认入口没有回落 2D：data-mode=${info.mode}`);
  if (info.canvas3d) problems.push("移动端仍挂了 3D 画布");
  if (info.buttons !== 2 || info.hasGalaxyButton) {
    problems.push(`移动端 3D 入口应隐藏：按钮 ${info.buttons} 个，含星系按钮=${info.hasGalaxyButton}`);
  }

  await checkOverflow(page, "3D 移动端回落", problems);
  await page.screenshot("phase6d-3d-mobile-2d");
  flushErrors(page, "3D 移动端回落", problems);
}

/** 显式 ?mode=3d 在移动端仍进 3D，档位落 low、DPR 压到 1。 */
async function capture3dLowTier(page, problems, readings) {
  console.log("[step] 低档 3D：390 宽 + ?mode=3d");
  await page.setViewport({ width: 390, height: 844, dpr: 2, mobile: true });
  await page.goto(`${BASE}/graph?mode=3d&focus=${encodeURIComponent(CENTER)}&depth=2`);

  await ensureHydrated(page, "3D 低档", problems);
  if (!(await waitForScene3d(page, "3D 低档", problems))) return;
  await sleep(1500);

  const stats = await statsOf(page);
  readings.low = stats;
  console.log(
    `[check] 低档 tier=${stats?.tier} · dpr=${stats?.dpr} · labels=${stats?.labels} · drawCalls=${stats?.drawCalls}`,
  );
  if (stats?.tier !== "low") problems.push(`低档截图档位不是 low：${stats?.tier}`);
  if (stats?.dpr !== 1) problems.push(`低档 DPR 应为 1，实际 ${stats?.dpr}`);
  if (stats?.reason !== "url-3d") problems.push(`显式 3D 的判定原因不是 url-3d：${stats?.reason}`);
  check3dBudgets(stats, "3D 低档", problems);

  await hideDevOverlay(page);
  await checkOverflow(page, "3D 低档", problems);
  await page.screenshot("phase6d-3d-low-tier");
  flushErrors(page, "3D 低档", problems);
}

async function captureOrphan(page, problems) {
  console.log("[step] 孤立点");
  await page.setViewport({ width: 1440, height: 900, dpr: 1 });
  await page.goto(`${BASE}/graph?mode=2d&focus=${encodeURIComponent(ORPHANS[0][0])}&depth=2`);
  await ensureHydrated(page, "孤立点", problems);
  const orphan = await page.waitFor(
    `document.querySelector('.graph-orphan-note')?.innerText.includes('还没有已抽取的关系') ?? false`,
    60000,
  );
  if (!orphan) {
    const text = await page.evaluate("document.body.innerText.slice(0, 400)");
    problems.push(`孤立点提示没有出现：${text.replace(/\s+/g, " ")}`);
  }
  const orphanNodes = await page.evaluate("document.querySelectorAll('.g2-node').length");
  if (orphanNodes !== 1) problems.push(`孤立点视图应只有 1 个节点，实际 ${orphanNodes}`);
  flushErrors(page, "孤立点", problems);
}

/**
 * 自适应降档（ADR-022 第 8 条）的真实触发。
 *
 * 帧时来自 stats 的 avgFrameMs：静止时 demand 渲染不出帧、rafActive=false，读数是 0，
 * 所以先开自动旋转保证持续出帧，再用 CDP 把渲染进程降速 8 倍，逼出 >20ms 的窗口。
 * 触发不了不算失败（软渲染时序不稳），但会如实打 [note]，不当成通过。
 */
async function captureAdaptiveDowngrade(page, problems, readings) {
  // 8× 在快机器上仍能跑到 ~120fps，avg 只有 8–14ms，够不到 20ms 阈值（2026-11-13 实测），
  // 所以默认压到 24×：帧时间 ~30–60ms，稳定跨过阈值；压制越强单个 30 帧窗口越慢，
  // 观察窗同时放宽到 30s。PHASE6D_DROP_RATE / PHASE6D_DROP_WAIT 可覆盖。
  const throttleRate = Number(process.env.PHASE6D_DROP_RATE || 24);
  console.log(`[step] 自适应降档：自动旋转 + CPU 降速 ${throttleRate}×`);
  await page.setViewport({ width: 1440, height: 900, dpr: 1 });
  await page.goto(`${BASE}/graph?focus=${encodeURIComponent(CENTER)}&depth=2`);
  await ensureHydrated(page, "自适应降档", problems);
  if (!(await waitForScene3d(page, "自适应降档", problems))) return;

  const before = await statsOf(page);
  if (before?.tier === "low") {
    console.log(
      "[note] 起点档位已经是 low，无法再降；跳过真实触发（代码路径仍由 selectGraphMode 的 previousTier 覆盖）",
    );
    readings.adaptive = { triggered: false, reason: "already-low", before };
    return;
  }

  const toggled = await page.evaluate(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find((item) => item.textContent.trim() === '自动旋转');
    if (!button) return false;
    button.click();
    return true;
  })()`);
  if (!toggled) {
    problems.push("自适应降档：找不到「自动旋转」按钮");
    return;
  }
  await sleep(900);

  await page.send("Emulation.setCPUThrottlingRate", { rate: throttleRate });
  // 压制越强，30 帧一个窗口就越慢；观察窗跟着放大，否则两个慢窗口还没凑齐就超时。
  const waitMs = Number(process.env.PHASE6D_DROP_WAIT || 30000);
  const started = Date.now();
  let dropped = null;
  while (Date.now() - started < waitMs) {
    const current = await statsOf(page);
    // PHASE6D_DROP_PROBE=1 时把每个采样点打出来：降档没触发时要能看出是「帧没涨」
    // 还是「avgFrameMs 没测出来」。
    if (process.env.PHASE6D_DROP_PROBE) {
      console.log(
        `[probe] +${Date.now() - started}ms frames=${current?.frames} avg=${current?.avgFrameMs} raf=${current?.rafActive} tier=${current?.tier}`,
      );
    }
    if (current && current.tier !== before.tier) {
      dropped = current;
      break;
    }
    await sleep(500);
  }
  const announcement = await page.evaluate(
    "document.querySelector('.sr-only[role=status]')?.textContent?.trim() ?? ''",
  );

  // 撤掉降速，等两秒：只降不升——档位不许自己回去。
  await page.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  await sleep(2500);
  const after = await statsOf(page);

  readings.adaptive = {
    triggered: dropped !== null,
    beforeTier: before?.tier,
    droppedTier: dropped?.tier ?? null,
    announcement,
    afterTier: after?.tier ?? null,
    beforeAvgFrameMs: before?.avgFrameMs,
    droppedAvgFrameMs: dropped?.avgFrameMs ?? null,
  };

  if (dropped === null) {
    console.log(
      `[note] ${waitMs / 1000} 秒内没有降档：${throttleRate}× 降速仍没把 avgFrameMs 推过 20ms；只完成代码路径验证`,
    );
  } else {
    console.log(
      `[check] 降档已触发：${before.tier} → ${dropped.tier}（avgFrameMs ${before?.avgFrameMs} → ${dropped.avgFrameMs}），` +
        `播报「${announcement}」，撤销降速后仍为 ${after?.tier}`,
    );
    if (!announcement.includes("已自动降低画质")) problems.push(`降档没有无障碍播报：${announcement}`);
    if (after?.tier !== dropped.tier) problems.push(`降档后档位回升：${dropped.tier} → ${after?.tier}`);
  }

  await page.evaluate(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find((item) => item.textContent.trim() === '自动旋转');
    if (button) button.click();
  })()`);
  await sleep(600);
  flushErrors(page, "自适应降档", problems);
}

/** `?maxNodes=` 非法值（10）回到默认 150：客户端请求与首屏预取用同一个值。 */
async function captureMaxNodesParam(page, problems, readings) {
  console.log("[step] 诊断参数 ?maxNodes=10（越界）→ 应回落 150");
  await page.setViewport({ width: 1440, height: 900, dpr: 1 });
  await page.goto(`${BASE}/graph?mode=2d&maxNodes=10&focus=${encodeURIComponent(CENTER)}&depth=2`);
  await ensureHydrated(page, "maxNodes 越界", problems);
  const ready = await page.waitFor("document.querySelectorAll('.g2-node').length >= 40", 90000);
  if (!ready) {
    const text = await page.evaluate("document.body.innerText.slice(0, 400)");
    problems.push(`maxNodes=10 时 2D 没有就绪：${text.replace(/\s+/g, ' ')}`);
    return;
  }
  await sleep(800);

  // 首屏走服务端预取，浏览器里没有请求记录；换一次中心才会发出客户端请求，
  // 这条请求带的 maxNodes 才能证明「props 与服务端预取同一个值」。
  const switched = await switchCenter(page, RING1[0][0]);
  if (!switched) {
    problems.push("maxNodes 越界：换中心没有生效，抓不到客户端请求");
    return;
  }
  await sleep(1500);

  const info = await page.evaluate(`(() => {
    const requests = performance.getEntriesByType('resource')
      .map((entry) => entry.name)
      .filter((name) => name.includes('/api/graph?'));
    return {
      request: requests[requests.length - 1] ?? null,
      nodes: window.__graphStats?.nodes ?? null,
      hidden: window.__graphStats?.hidden ?? null,
    };
  })()`);
  readings.maxNodesInvalid = info;
  console.log(`[check] 越界请求发出的是 ${info.request ?? "(没有抓到请求)"}；view ${info.nodes} 个节点`);
  if (!info.request || !info.request.includes("maxNodes=150")) {
    problems.push(`?maxNodes=10 没有回落 150：${info.request}`);
  }
  if (info.hidden !== 0) problems.push(`2D 下不应有抽稀：hidden=${info.hidden}`);
  flushErrors(page, "maxNodes 越界", problems);
}

/** 用「中心」下拉换一次中心；返回 URL 是否切换成功。 */
async function switchCenter(page, label) {
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
    8000,
  );
}

/**
 * `?maxNodes=600` + 373 个实体的宽夹具：
 * 低档 3D（预算 150）必须抽稀，提示条追加隐藏数；切回 2D 仍是完整的 373 个。
 */
async function captureOverBudget(page, problems, readings, mock) {
  console.log("[step] overBudget：?maxNodes=600 + 373 个实体 + 低档 3D");
  await page.setViewport({ width: 390, height: 844, dpr: 2, mobile: true });
  await page.goto(`${BASE}/graph?mode=3d&maxNodes=600&focus=${encodeURIComponent(CENTER)}&depth=3`);

  await ensureHydrated(page, "overBudget", problems);
  if (!(await waitForScene3d(page, "overBudget", problems))) return;
  await sleep(1600);

  const stats = await statsOf(page);
  const info = await page.evaluate(`(() => {
    const requests = performance.getEntriesByType('resource')
      .map((entry) => entry.name)
      .filter((name) => name.includes('/api/graph?'));
    return {
      request: requests[requests.length - 1] ?? null,
      head: document.querySelector('.graph-stage-head p')?.innerText.replace(/\\s+/g, ' ').trim() ?? '',
      canvas: Boolean(document.querySelector('.graph-stage-wrap[data-mode="3d"] canvas')),
    };
  })()`);
  readings.overBudget = { ...info, ...stats };
  console.log(
    `[check] view ${stats?.nodes} 个实体 → 渲染 ${stats?.rendered}，隐藏 ${stats?.hidden}；` +
      `提示条「${info.head}」`,
  );
  if (stats?.nodes !== 373) problems.push(`宽夹具应返回 373 个实体，实际 ${stats?.nodes}`);
  if (!stats || !(stats.hidden > 0)) problems.push(`overBudget 没有抽稀：hidden=${stats?.hidden}`);
  if (stats && stats.rendered > 150) problems.push(`低档渲染视图超过预算：${stats.rendered}`);
  if (stats && stats.hidden !== stats.nodes - stats.rendered) {
    problems.push(`隐藏数对不上：${stats.hidden} ≠ ${stats.nodes} - ${stats.rendered}`);
  }
  if (stats && !info.head.includes(`另有 ${stats.hidden} 个实体未显示`)) {
    problems.push(`提示条没有隐藏数：${info.head}`);
  }
  if (!info.canvas) problems.push("overBudget 下 3D 画布不见了");
  check3dBudgets(stats, "overBudget", problems);

  await hideDevOverlay(page);
  await page.screenshot("phase6d-3d-overbudget");
  flushErrors(page, "overBudget", problems);

  // 抽稀只作用于 3D：切到 2D 应画完整的 373 个，提示条也不再有隐藏数。
  await key(page, "2", "Digit2", 50);
  const back = await page.waitFor("document.querySelectorAll('.g2-node').length >= 300", 60000);
  if (!back) {
    problems.push("切到 2D 后没有画满宽夹具");
    return;
  }
  const twoD = await page.evaluate(`({
    nodes: document.querySelectorAll('.g2-node').length,
    head: document.querySelector('.graph-stage-head p')?.innerText.replace(/\\s+/g, ' ').trim() ?? '',
    mode: document.querySelector('.graph-workspace')?.getAttribute('data-mode'),
  })`);
  readings.overBudget2d = twoD;
  console.log(`[check] 2D 回看：data-mode=${twoD.mode}，${twoD.nodes} 个节点`);
  if (twoD.nodes !== 373) problems.push(`2D 应保留全部 373 个节点，实际 ${twoD.nodes}`);
  if (twoD.head.includes("另有")) problems.push(`2D 提示条不应出现抽稀文案：${twoD.head}`);
  flushErrors(page, "overBudget 2D 回看", problems);

  // 首屏走服务端预取，浏览器里没有请求记录；换一次中心才会发出客户端请求，
  // 这条请求里的 maxNodes 才证明「props 与服务端预取用同一个 URL 值」。
  await page.setViewport({ width: 1440, height: 900, dpr: 1 });
  await sleep(600); // 视口从移动端切回桌面，等布局稳定再点下拉
  if (!(await switchCenter(page, WIDE_RING1[0]))) {
    problems.push("overBudget：换中心没有生效，抓不到 ?maxNodes=600 的客户端请求");
  } else {
    await sleep(1500);
    const client = await page.evaluate(`(() => {
      const requests = performance.getEntriesByType('resource')
        .map((entry) => entry.name)
        .filter((name) => name.includes('/api/graph?'));
      return requests[requests.length - 1] ?? null;
    })()`);
    readings.overBudgetRequest = client;
    console.log(`[check] 换中心后的客户端请求：${client ?? "(没有抓到)"}`);
    if (!client || !client.includes("maxNodes=600")) {
      problems.push(`?maxNodes=600 没有传到客户端请求：${client}`);
    }
  }
  flushErrors(page, "overBudget 换中心", problems);

  await mock.setMode("full");
}

/* ------------------------------------------------------------------ *
 * 6C. 生产运行时（next start）验收：只读可见 DOM。
 *
 * 生产构建里 `__graphStats` / `__graphLabelBoxes` 都被 `NODE_ENV` 守卫掉，
 * 所以这里不读任何页面探针，只断言用户能看到的东西：
 *   - `.graph-workspace[data-mode]`、`.graph-stage-wrap[data-mode="3d"] canvas`
 *   - 工具条「星系」按钮的文案与 aria-pressed
 *   - `.graph-stage-head p` 的实体 / 关系 / 「另有 N 个实体未显示」
 *   - `.meta-chip` 的档位（星系 · high / balanced / low）
 *   - `.graph-note-error`（chunk-failed 会落到这里）
 *   - 无障碍播报 `.sr-only[role=status]`
 * 截图另做一次「画布非空白」的像素统计，防止 canvas 存在但没画出东西。
 * ------------------------------------------------------------------ */

async function prodState(page) {
  return page.evaluate(`(() => {
    const workspace = document.querySelector('.graph-workspace');
    const stage = document.querySelector('.graph-stage-wrap[data-mode="3d"]');
    const galaxy = [...document.querySelectorAll('.graph-mode-button')]
      .find((item) => item.textContent.trim() === '星系');
    return {
      mode: workspace ? workspace.getAttribute('data-mode') : null,
      head: document.querySelector('.graph-stage-head p')?.innerText.replace(/\\s+/g, ' ').trim() ?? '',
      heading: document.querySelector('.graph-stage-head h2')?.innerText.trim() ?? '',
      chip: document.querySelector('.graph-stage-head .meta-chip')?.textContent.trim() ?? '',
      galaxyPressed: galaxy ? galaxy.getAttribute('aria-pressed') : null,
      galaxyTitle: galaxy ? galaxy.getAttribute('title') : null,
      canvas: Boolean(stage && stage.querySelector('canvas')),
      stageAria: stage ? stage.getAttribute('aria-label') : null,
      stubs: [...document.querySelectorAll('.g3-stub')]
        .map((item) => item.innerText.replace(/\\s+/g, ' ').trim()).slice(0, 3),
      sceneError: document.querySelector('.graph-note-error')?.innerText.replace(/\\s+/g, ' ').trim() ?? '',
      statsGuard: typeof window.__graphStats,
      announcement: document.querySelector('.sr-only[role=status]')?.textContent?.trim() ?? '',
    };
  })()`);
}

/** 生产态只认可见 DOM：3D 容器 + 画布 + 没有占位 / 错误横幅。 */
async function waitForProdScene3d(page, label, problems, timeoutMs = 150000) {
  const ok = await page.waitFor(
    `(() => {
      const workspace = document.querySelector('.graph-workspace');
      const stage = document.querySelector('.graph-stage-wrap[data-mode="3d"]');
      return Boolean(workspace)
        && workspace.getAttribute('data-mode') === '3d'
        && Boolean(stage && stage.querySelector('canvas'))
        && document.querySelectorAll('.g3-stub').length === 0;
    })()`,
    timeoutMs,
    250,
  );
  if (!ok) {
    const diagnostics = await page
      .evaluate(`(() => ({
        mode: document.querySelector('.graph-workspace')?.getAttribute('data-mode') ?? null,
        stage: Boolean(document.querySelector('.graph-stage-wrap[data-mode="3d"]')),
        canvas: Boolean(document.querySelector('.graph-stage-wrap[data-mode="3d"] canvas')),
        stubs: [...document.querySelectorAll('.g3-stub')].map((item) => item.innerText.replace(/\\s+/g, ' ').trim()),
        note: document.querySelector('.graph-note-error')?.innerText.trim() ?? '',
        body: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 300),
      }))()`)
      .catch(() => null);
    problems.push(`${label} 生产态 3D 没有起来：${JSON.stringify(diagnostics)}`);
  }
  return ok;
}

async function stageRectOf(page) {
  return page.evaluate(`(() => {
    const stage = document.querySelector('.graph-stage-wrap[data-mode="3d"]');
    if (!stage) return null;
    const rect = stage.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  })()`);
}

/** 截图里画布区域不能是纯色：统计亮度与颜色分桶，空白 canvas 会露馅。 */
async function checkCanvasPainted(file, rect, label, problems) {
  if (!rect || rect.width < 100 || rect.height < 100) {
    problems.push(`${label} 找不到足够大的 3D 画布区域：${JSON.stringify(rect)}`);
    return null;
  }
  try {
    const sharp = (await import("sharp")).default;
    const image = sharp(file);
    const meta = await image.metadata();
    const left = Math.max(0, Math.round(rect.x));
    const top = Math.max(0, Math.round(rect.y));
    const width = Math.min(Math.round(rect.width), (meta.width ?? 0) - left);
    const height = Math.min(Math.round(rect.height), (meta.height ?? 0) - top);
    if (width < 50 || height < 50) {
      problems.push(`${label} 画布区域落在截图外：${JSON.stringify({ left, top, width, height })}`);
      return null;
    }
    const { data, info } = await sharp(file)
      .extract({ left, top, width, height })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    let bright = 0;
    let sum = 0;
    const colors = new Set();
    for (let i = 0; i < data.length; i += info.channels) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      sum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if (r + g + b > 120) bright += 1;
      if (colors.size < 20000) colors.add(((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2));
    }
    const pixels = info.width * info.height;
    const reading = {
      width: info.width,
      height: info.height,
      meanLum: Number((sum / pixels).toFixed(2)),
      brightRatio: Number((bright / pixels).toFixed(4)),
      colorBuckets: colors.size,
    };
    console.log(
      `[check] 画布像素 ${reading.width}×${reading.height} · 平均亮度 ${reading.meanLum} · ` +
        `亮像素 ${(reading.brightRatio * 100).toFixed(2)}% · 颜色桶 ${reading.colorBuckets}`,
    );
    if (reading.meanLum < 0.5 || reading.brightRatio < 0.0005 || reading.colorBuckets < 24) {
      problems.push(`${label} 画布疑似空白：${JSON.stringify(reading)}`);
    }
    return reading;
  } catch (error) {
    // sharp 是 next 的可选依赖；缺了不影响断言，只少一层像素证据。
    console.log(`[note] 跳过画布像素统计：${error.message}`);
    return null;
  }
}

/** 断言「这次是生产构建」：开发态才会挂 __graphStats。 */
function assertProdGuard(info, label, problems) {
  if (info.statsGuard !== "undefined") {
    problems.push(`${label} 跑的不是生产构建：window.__graphStats=${info.statsGuard}`);
  }
}

function assertNoSceneError(info, label, problems) {
  if (info.sceneError) problems.push(`${label} 出现场景错误横幅：${info.sceneError}`);
  if (info.stubs.length > 0) problems.push(`${label} 仍渲染 3D 占位 / 降级横幅：${info.stubs.join(" | ")}`);
}

/** 生产构建 · 桌面默认入口（URL 不带 mode）：必须直接进真实 WebGL 星系。 */
async function captureProdDefault(page, problems, readings) {
  console.log("[step][prod] 桌面默认入口（无 mode 参数）");
  await page.setViewport({ width: 1440, height: 900, dpr: 1 });
  await page.goto(`${BASE}/graph?focus=${encodeURIComponent(CENTER)}&depth=2`);
  if (!(await waitForProdScene3d(page, "生产默认入口", problems))) return;
  await sleep(2200); // 布局 + 标签稳定（静止后 demand 渲染不再出帧）

  const info = await prodState(page);
  readings.prodDefault = info;
  console.log(
    `[check] 生产默认入口 data-mode=${info.mode} · 档位「${info.chip}」· 提示条「${info.head}」· ` +
      `星系按钮 aria-pressed=${info.galaxyPressed}`,
  );

  assertProdGuard(info, "生产默认入口", problems);
  if (info.mode !== "3d") problems.push(`生产默认入口没有进 3D：data-mode=${info.mode}`);
  if (!info.canvas) problems.push("生产默认入口没有挂上 WebGL 画布");
  if (info.galaxyPressed !== "true") problems.push(`「星系」按钮不是按下态：${info.galaxyPressed}`);
  if (info.galaxyTitle && info.galaxyTitle.includes("桩")) {
    problems.push(`「星系」按钮仍带桩文案：${info.galaxyTitle}`);
  }
  if (!info.head.includes("40 个实体")) problems.push(`默认入口的实体数不对：${info.head}`);
  if (!info.stageAria || !info.stageAria.includes("3D 星系视图")) {
    problems.push(`3D 画布缺少可读标签：${info.stageAria}`);
  }
  assertNoSceneError(info, "生产默认入口", problems);

  await hideDevOverlay(page);
  await checkOverflow(page, "生产默认入口", problems);
  const shot = await page.screenshot("phase6d-3d-default-entry-prod");
  readings.prodDefaultPixels = await checkCanvasPainted(
    shot,
    await stageRectOf(page),
    "生产默认入口",
    problems,
  );
  flushErrors(page, "生产默认入口", problems);
}

/**
 * 生产构建 · 自适应降档：自动旋转 + 24× CPU 降速，档位必须真的掉一档、
 * 播报出现、撤掉降速后不回升。只读 `.meta-chip` 与播报。
 */
async function captureProdDowngrade(page, problems, readings) {
  const throttleRate = Number(process.env.PHASE6D_DROP_RATE || 24);
  const waitMs = Number(process.env.PHASE6D_DROP_WAIT || 45000);
  console.log(`[step][prod] 自适应降档：自动旋转 + CPU 降速 ${throttleRate}×`);
  await page.setViewport({ width: 1440, height: 900, dpr: 1 });
  await page.goto(`${BASE}/graph?focus=${encodeURIComponent(CENTER)}&depth=2`);
  if (!(await waitForProdScene3d(page, "生产降档", problems))) return;
  await sleep(1200);

  const before = await prodState(page);
  if (!before.chip.includes("high")) {
    console.log(`[note] 起点档位不是 high（${before.chip}），跳过降档实测`);
    readings.prodDowngrade = { skipped: true, before: before.chip };
    return;
  }

  const toggled = await page.evaluate(`(() => {
    const button = document.querySelector('.graph-autorotate');
    if (!button) return false;
    button.click();
    return true;
  })()`);
  if (!toggled) {
    problems.push("生产降档：找不到「自动旋转」按钮");
    return;
  }
  await sleep(900);
  const pressed = await page.evaluate(
    "document.querySelector('.graph-autorotate')?.getAttribute('aria-pressed')",
  );
  if (pressed !== "true") problems.push(`「自动旋转」没有切到按下态：${pressed}`);

  await page.send("Emulation.setCPUThrottlingRate", { rate: throttleRate });
  const started = Date.now();
  let dropped = null;
  while (Date.now() - started < waitMs) {
    const current = await prodState(page);
    if (process.env.PHASE6D_DROP_PROBE) {
      console.log(`[probe] +${Date.now() - started}ms 档位「${current.chip}」`);
    }
    if (!current.chip.includes("high")) {
      dropped = current;
      break;
    }
    await sleep(500);
  }

  // 撤掉降速再等 3 秒：只降不升。
  await page.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  await sleep(3000);
  const after = await prodState(page);

  readings.prodDowngrade = {
    before: before.chip,
    dropped: dropped?.chip ?? null,
    announcement: dropped?.announcement ?? "",
    after: after.chip,
    elapsedMs: dropped ? Date.now() - started : null,
  };

  if (!dropped) {
    problems.push(`生产降档：${waitMs / 1000}s 内档位没有从 high 掉下来（${throttleRate}×）`);
  } else {
    console.log(
      `[check] 生产降档：${before.chip} → ${dropped.chip}，播报「${dropped.announcement}」，` +
        `撤销降速后仍为 ${after.chip}`,
    );
    if (!dropped.announcement.includes("已自动降低画质")) {
      problems.push(`降档没有无障碍播报：${dropped.announcement}`);
    }
    if (after.chip !== dropped.chip) problems.push(`降档后档位回升：${dropped.chip} → ${after.chip}`);
  }

  await hideDevOverlay(page);
  const shot = await page.screenshot("phase6d-3d-downgrade-prod");
  readings.prodDowngradePixels = await checkCanvasPainted(
    shot,
    await stageRectOf(page),
    "生产降档",
    problems,
  );
  flushErrors(page, "生产降档", problems);
}

/**
 * 生产构建 · 真 Worker：宽夹具 373 个实体（>300）走 Worker，换中心后仍走 Worker。
 * Worker 目标由 CDP 的 Target 域观测（页面探针在生产构建里不可用）；
 * 回落主线程会走 `chunk-failed` → `.graph-note-error`，可见 DOM 上必须没有。
 */
async function captureProdWorker(page, problems, readings, workerTargets) {
  console.log("[step][prod] 宽夹具 + ?maxNodes=600：真 Worker");
  await page.setViewport({ width: 1440, height: 900, dpr: 1 });
  await page.goto(`${BASE}/graph?maxNodes=600&focus=${encodeURIComponent(CENTER)}&depth=3`);
  if (!(await waitForProdScene3d(page, "生产 Worker", problems))) return;
  await sleep(2600); // Worker 布局 + 标签

  const info = await prodState(page);
  const workers = workerTargets.length;
  readings.prodWorker = { ...info, workerTargets: workers };
  console.log(
    `[check] 生产 Worker data-mode=${info.mode} · 提示条「${info.head}」· 档位「${info.chip}」· ` +
      `CDP worker 目标 ${workers} 个`,
  );

  assertProdGuard(info, "生产 Worker", problems);
  if (info.mode !== "3d") problems.push(`生产 Worker 没有进 3D：data-mode=${info.mode}`);
  if (!info.canvas) problems.push("生产 Worker 没有画布");
  if (!info.head.includes("373 个实体")) problems.push(`宽夹具没有画满 373 个实体：${info.head}`);
  if (info.head.includes("另有")) problems.push(`high 档预算 600 不应抽稀：${info.head}`);
  if (workers < 1) problems.push("生产构建下没有观测到任何 Worker 目标（373 > 300 应走 Worker）");
  assertNoSceneError(info, "生产 Worker", problems);
  for (const error of [...page.consoleErrors, ...page.pageErrors]) {
    if (/Module not found|chunk-failed|ChunkLoadError/i.test(error)) {
      problems.push(`生产 Worker 控制台出现 chunk 错误：${error}`);
    }
  }

  await hideDevOverlay(page);
  await checkOverflow(page, "生产 Worker", problems);
  const shot = await page.screenshot("phase6d-3d-worker-600-prod");
  readings.prodWorkerPixels = await checkCanvasPainted(
    shot,
    await stageRectOf(page),
    "生产 Worker",
    problems,
  );

  // 换中心：第二个枢纽同样深度 3 可达 373 个实体，>300 → 仍走 Worker。
  const target = WIDE_HUB2;
  if (!(await switchCenter(page, target))) {
    problems.push(`生产 Worker：换中心到「${target}」没有生效`);
  } else {
    const swapped = await page.waitFor(
      `document.querySelector('.graph-stage-head h2')?.innerText.includes(${JSON.stringify(target)})`,
      30000,
    );
    if (!swapped) problems.push(`换中心后标题没有更新为「${target}」`);
    await page.waitFor(
      `Boolean(document.querySelector('.graph-stage-wrap[data-mode="3d"] canvas'))`,
      60000,
    );
    await sleep(2600);
    const after = await prodState(page);
    const workersAfter = workerTargets.length;
    readings.prodWorkerSwitch = { ...after, workerTargets: workersAfter };
    console.log(
      `[check] 换中心后 heading「${after.heading}」· 提示条「${after.head}」· ` +
        `canvas=${after.canvas} · CDP worker 目标 ${workersAfter} 个`,
    );
    if (!after.heading.includes(target)) problems.push(`换中心后标题不对：${after.heading}`);
    if (!after.head.includes("373 个实体")) problems.push(`换中心后没有画满 373 个：${after.head}`);
    if (!after.canvas) problems.push("换中心后 3D 画布消失");
    if (workersAfter < 1) problems.push("换中心后 Worker 目标消失（可能已回落主线程）");
    assertNoSceneError(after, "生产 Worker 换中心", problems);
    await page.screenshot("phase6d-3d-worker-600-prod-switch");
  }

  flushErrors(page, "生产 Worker", problems);
}

/** 生产构建 · 低档抽稀：移动端 390 宽显式 3D，预算 150，373 → 133，提示条给隐藏数。 */
async function captureProdDecimate(page, problems, readings) {
  console.log("[step][prod] 低档 3D 抽稀（390 宽 + ?mode=3d + 宽夹具）");
  await page.setViewport({ width: 390, height: 844, dpr: 2, mobile: true });
  await page.goto(`${BASE}/graph?mode=3d&maxNodes=600&focus=${encodeURIComponent(CENTER)}&depth=3`);
  if (!(await waitForProdScene3d(page, "生产抽稀", problems))) return;
  await sleep(2200);

  const info = await prodState(page);
  const hidden = /另有 (\d+) 个实体未显示/.exec(info.head);
  const hiddenCount = hidden ? Number(hidden[1]) : null;
  const total = /(\d+) 个实体/.exec(info.head);
  const totalCount = total ? Number(total[1]) : null;
  // 3D 画布的 aria-label 用的是**抽稀后**的 renderView（不是提示条里的完整 view），
  // 所以它是生产态唯一能看到的「实际渲染数」，正好用来核对提示条计数。
  const renderedAria = /(\d+) 个实体/.exec(info.stageAria ?? "");
  const renderedInScene = renderedAria ? Number(renderedAria[1]) : null;
  const rendered = totalCount !== null && hiddenCount !== null ? totalCount - hiddenCount : null;
  readings.prodDecimate = { ...info, hiddenCount, totalCount, rendered, renderedInScene };
  console.log(
    `[check] 生产抽稀 档位「${info.chip}」· 提示条「${info.head}」· ` +
      `画布 aria「${info.stageAria}」· 推算渲染 ${rendered}（预算 150）`,
  );

  assertProdGuard(info, "生产抽稀", problems);
  if (info.mode !== "3d") problems.push(`生产抽稀没有进 3D：data-mode=${info.mode}`);
  if (!info.chip.includes("low")) problems.push(`移动端显式 3D 应是 low 档：${info.chip}`);
  if (totalCount !== 373) problems.push(`宽夹具总数不对：${info.head}`);
  if (hiddenCount === null) problems.push(`提示条没有隐藏数：${info.head}`);
  if (rendered === null || rendered > 150) problems.push(`抽稀后渲染数超过 low 档预算：${rendered}`);
  if (renderedInScene === null) {
    problems.push(`画布 aria 里读不到渲染数：${info.stageAria}`);
  } else {
    if (renderedInScene !== rendered) {
      problems.push(`提示条与画布渲染数不一致：${rendered} ≠ ${renderedInScene}`);
    }
    if (renderedInScene > 150) problems.push(`画布实际渲染数超过 low 档预算：${renderedInScene}`);
  }
  if (!info.canvas) problems.push("生产抽稀没有画布");
  assertNoSceneError(info, "生产抽稀", problems);

  await page.screenshot("phase6d-3d-decimate-prod");
  flushErrors(page, "生产抽稀", problems);
}

async function captureError(page, problems) {
  console.log("[step] 加载失败");
  await page.setViewport({ width: 1440, height: 900, dpr: 1 });
  await page.goto(`${BASE}/graph?mode=2d&focus=${encodeURIComponent(ERROR_LABEL)}&depth=2`);

  await ensureHydrated(page, "错误状态", problems);
  const shown = await page.waitFor(
    `document.querySelector('.graph-state-card.is-error')?.innerText.includes('LightRAG 返回 500') ?? false`,
    60000,
  );
  if (!shown) {
    const text = await page.evaluate("document.body.innerText.slice(0, 400)");
    problems.push(`错误状态没有出现：${text.replace(/\s+/g, " ")}`);
    return;
  }
  const retry = await page.evaluate(
    "Boolean(document.querySelector('.graph-state-card.is-error .btn-secondary'))",
  );
  if (!retry) problems.push("错误状态没有重试按钮");

  await checkOverflow(page, "错误状态", problems);
  await hideDevOverlay(page);
  await page.screenshot("phase6d-2d-error");
  // 这里就是要看失败态：图的 500 与服务端那条「读取初始邻域失败」都是预期。
  flushErrors(page, "错误状态", problems, [
    /\/api\/graph\?label=/,
    /\[graph\] 读取初始邻域失败/,
  ]);
}

async function captureCenterSwitchFailure(page, problems, mock) {
  console.log("[step] 换中心失败：旧图必须留着");
  await page.setViewport({ width: 1440, height: 900, dpr: 1 });
  await page.goto(`${BASE}/graph?mode=2d&focus=${encodeURIComponent(CENTER)}&depth=2`);

  await ensureHydrated(page, "换中心失败", problems);
  if (!(await waitForStage(page, 40, 90000))) {
    const text = await page.evaluate("document.body.innerText.slice(0, 400)");
    problems.push(`换中心失败的起点没有就绪：${text.replace(/\s+/g, " ")}`);
    return;
  }
  await sleep(1200);

  const before = await page.evaluate(`(() => {
    const select = document.querySelector('select[aria-label="选择中心实体"]');
    return {
      heading: document.querySelector('.graph-stage-head h2')?.textContent?.trim() ?? '',
      nodes: document.querySelectorAll('.g2-node').length,
      hasSelect: Boolean(select),
      hasFailTarget: Boolean(select) && [...select.options].some((option) => option.value === ${JSON.stringify(FAIL_CENTER)}),
    };
  })()`);
  if (!before.hasSelect) {
    problems.push("工具栏没有「选择中心实体」下拉，换中心无法复现");
    return;
  }
  if (!before.hasFailTarget) {
    problems.push(`「中心」下拉里没有 ${FAIL_CENTER}，换中心失败无法复现`);
    return;
  }
  if (!before.heading.includes("的邻域")) problems.push(`起始标题不对：${before.heading}`);

  await mock.setMode("center-error");
  await page.evaluate(`(() => {
    const select = document.querySelector('select[aria-label="选择中心实体"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
    setter.call(select, ${JSON.stringify(FAIL_CENTER)});
    select.dispatchEvent(new Event("change", { bubbles: true }));
  })()`);
  const switched = await page.waitFor(
    `new URLSearchParams(location.search).get('focus') === ${JSON.stringify(FAIL_CENTER)}`,
    8000,
  );
  if (!switched) problems.push("选择新中心后 URL 没有切换");

  const banner = await page.waitFor(
    `document.querySelector('.graph-note-error')?.innerText.includes('新的邻域没有加载成功') ?? false`,
    30000,
  );
  await sleep(600);
  const searched = await page.evaluate("location.search");
  const selectState = await page.evaluate(`(() => {
    const select = document.querySelector('select[aria-label="选择中心实体"]');
    return select ? { value: select.value, options: select.options.length, disabled: select.disabled } : null;
  })()`);
  console.log(`[diag] 切换后 URL：${searched}；下拉：${JSON.stringify(selectState)}`);
  if (page.networkErrors.length > 0) {
    console.log(`[diag] 本步骤网络错误：${page.networkErrors.join(" | ")}`);
  }
  const after = await page.evaluate(`({
    heading: document.querySelector('.graph-stage-head h2')?.textContent?.trim() ?? '',
    nodes: document.querySelectorAll('.g2-node').length,
    loading: Boolean(document.querySelector('.graph-stage-loading')),
    fullErrorCard: Boolean(document.querySelector('.graph-state-card.is-error')),
    banner: document.querySelector('.graph-note-error')?.innerText ?? '',
  })`);

  if (!banner) problems.push(`换中心失败没有提示：${after.banner || "(无提示)"}`);
  if (after.heading !== before.heading) {
    problems.push(`换中心失败后标题变成「${after.heading}」，应仍是「${before.heading}」`);
  }
  if (after.nodes !== before.nodes) {
    problems.push(`换中心失败后节点数从 ${before.nodes} 变成 ${after.nodes}，旧图没有保留`);
  }
  if (after.loading) problems.push("换中心失败后仍显示「正在载入…」浮层");
  if (after.fullErrorCard) problems.push("换中心失败后把整块视图换成了错误卡，旧图应当保留");
  console.log(`[check] 换中心失败：保留 ${after.nodes} 个节点，标题「${after.heading}」`);

  await checkOverflow(page, "换中心失败", problems);
  await hideDevOverlay(page);
  await page.screenshot("phase6d-2d-center-error");
  // 这个 500 是本步骤故意制造的（只打挂「换中心」这一跳）；
  // 服务端会在 RSC 渲染里打一条「读取初始邻域失败」，同样属于预期。
  flushErrors(page, "换中心失败", problems, [
    /\/api\/graph\?label=/,
    /\[graph\] 读取初始邻域失败/,
  ]);

  await mock.setMode("full");
  await page.goto(`${BASE}/graph?mode=2d&focus=${encodeURIComponent(CENTER)}&depth=2`);
  await sleep(800);
  flushErrors(page, "换中心失败（复位）", problems);
}

async function captureStatusUnavailable(page, problems) {
  console.log("[step] 状态接口读不到");
  await page.setViewport({ width: 1440, height: 900, dpr: 1 });
  await page.goto(`${BASE}/graph`);

  await ensureHydrated(page, "状态读不到", problems);
  const shown = await page.waitFor(
    `document.body.innerText.includes('图谱状态暂时读不到')`,
    45000,
  );
  if (!shown) {
    const text = await page.evaluate("document.body.innerText.slice(0, 400)");
    problems.push(`「状态读不到」没有出现：${text.replace(/\s+/g, " ")}`);
    return;
  }
  const wrong = await page.evaluate("document.body.innerText.includes('图谱还是空的')");
  if (wrong) problems.push("状态读不到时页面仍显示「图谱还是空的」，两种空态没有区分");
  const note = await page.evaluate(
    "document.querySelector('.graph-note-error')?.innerText ?? ''",
  );
  if (!note.includes("图谱服务暂时没有响应")) problems.push(`没有说明状态接口失败：${note || "(无提示)"}`);
  console.log(`[check] 状态读不到：提示「${note.split("\n")[0]}」`);

  await checkOverflow(page, "状态读不到", problems);
  await page.screenshot("phase6d-2d-status-unknown");
  // 状态接口与文档列表都是本场景故意打挂的；服务端会打一条「读取构图进度失败」。
  flushErrors(page, "状态读不到", problems, [
    /\/api\/graph\/status/,
    /documents\/paginated/,
    /\[graph\] 读取构图进度失败/,
  ]);
}



/* ------------------------------------------------------------------ *
 * 7. 主流程。
 * ------------------------------------------------------------------ */

/** PHASE6D_PROBE=1：只跑一次桌面页，打印水合与资源诊断后退出。 */
async function probeHydration() {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pakp-phase6d-probe-"));
  const dbFile = path.join(tmpDir, "probe.db");
  let mock = null;
  let app = null;
  let browser = null;
  try {
    await seedDatabase(dbFile);
    mock = await startMockLightrag();
    await mock.setMode("full");
    app = await startApp({ dbFile, lightragUrl: mock.url });
    browser = await launchBrowser();
    const page = await openPage(browser.cdp);
    await page.setViewport({ width: 1440, height: 900, dpr: 1 });

    const started = Date.now();
    await page.goto(`${BASE}/graph?mode=2d&focus=${encodeURIComponent(CENTER)}&depth=2`);
    console.log(`[probe] goto 完成 ${Date.now() - started}ms`);

    let previous = 0;
    for (const at of [2000, 5000, 10000, 20000, 40000]) {
      await sleep(at - previous);
      previous = at;
      const state = await page.evaluate(`({
        stats: Boolean(window.__graphStats),
        ready: document.readyState,
        next: typeof window.next,
        nodes: document.querySelectorAll('.g2-node').length,
        text: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 240),
        stateCard: document.querySelector('.graph-state-card')?.innerText.replace(/\\s+/g, ' ') ?? null,
        htmlLength: document.documentElement.outerHTML.length,
        flight: Array.isArray(window.__next_f) ? window.__next_f.length : null,
        scripts: [...document.scripts].filter((s) => s.src).map((s) => s.src.split('/').pop()).slice(-8),
        jsLoaded: performance.getEntriesByType('resource')
          .filter((entry) => entry.name.includes('/_next/') && entry.name.includes('.js'))
          .length,
      })`).catch((error) => ({ error: String(error) }));
      console.log(`[probe] t+${at}ms ${JSON.stringify(state)}`);
    }

    console.log(`[probe] console=${JSON.stringify(page.consoleErrors)}`);
    console.log(`[probe] page=${JSON.stringify(page.pageErrors)}`);
    console.log(`[probe] network=${JSON.stringify(page.networkErrors)}`);

    // 直接取一次页面：如果 SSR 流不收尾，这里会超时（不是浏览器的问题）。
    try {
      const response = await fetch(`${BASE}/graph?mode=2d&focus=${encodeURIComponent(CENTER)}`, {
        signal: AbortSignal.timeout(12000),
      });
      const html = await response.text();
      console.log(`[probe] 直连 SSR：${response.status} ${html.length} 字节；结尾 ${JSON.stringify(html.slice(-200))}`);
    } catch (error) {
      console.log(`[probe] 直连 SSR 失败：${error.message}`);
    }
    console.log(`[probe] dev 日志结尾：\n${app.logs.join("").slice(-3000)}`);

    const htmlTail = await page.evaluate(
      "document.documentElement.outerHTML.slice(-500)",
    );
    console.log(`[probe] 浏览器 DOM 结尾：${JSON.stringify(htmlTail)}`);

    // 两个怀疑点：Host 用 127.0.0.1 被 dev 资源跨源拦截；或响应被截断。
    const localUrl = `http://localhost:${APP_PORT}/graph?mode=2d&focus=${encodeURIComponent(CENTER)}&depth=2`;
    await page.goto(localUrl);
    await sleep(6000);
    const local = await page.evaluate(`({
      host: location.host,
      stats: Boolean(window.__graphStats),
      nodes: document.querySelectorAll('.g2-node').length,
      flight: Array.isArray(window.__next_f) ? window.__next_f.length : null,
      textLength: document.body.innerText.length,
    })`).catch((error) => ({ error: String(error) }));
    console.log(`[probe] localhost 导航：${JSON.stringify(local)}`);

    const dispatched = await page.evaluate(`(() => {
      const node = document.querySelector('[data-node-id="卡片笔记"]');
      if (!node) return 'no-node';
      node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return 'dispatched';
    })()`);
    await sleep(800);
    const inspector = await page.evaluate(
      "document.querySelector('.graph-inspector h2')?.textContent ?? null",
    );
    console.log(`[probe] dom click=${dispatched} inspector=${inspector}`);

    await page.close();
  } finally {
    await stopApp(app).catch(() => {});
    await browser?.close().catch(() => {});
    await mock?.close().catch(() => {});
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function main() {
  if (!existsSync(NEXT_BIN)) throw new Error(`找不到 next：${NEXT_BIN}`);
  if (!CHROME) throw new Error("找不到 Chrome / Edge，可设置 CHROME_PATH");

  if (process.env.PHASE6D_PROBE) {
    await probeHydration();
    return;
  }

  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "pakp-phase6d-"));
  const dbFile = path.join(tmpDir, "capture.db");
  const problems = [];
  // 3D 读数汇总：脚本最后打印，报告里的数字都从这里取，不手抄。
  const readings = {};
  let mock = null;
  let app = null;
  let browser = null;

  // 默认跑全套；调试时可 PHASE6D_STEPS=center,status 只跑指定步骤。
  const steps = new Set(
    (process.env.PHASE6D_STEPS ||
      (PROD
        ? "prod-default,prod-downgrade,prod-worker,prod-decimate"
        : "empty,desktop,3d,center,list,mobile,downgrade,maxnodes,overbudget,error,status"))
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
  const want = (name) => steps.has(name);
  const startedAt = Date.now();
  const mark = (text) => console.log(`[t+${((Date.now() - startedAt) / 1000).toFixed(1)}s] ${text}`);

  try {
    if (PROD) {
      // 真实库只读备份：源文件不打开写，副本上再播夹具对象
      // （mock 的 filePath 必须命中副本里的对象 id，ADR-011 才认这些标签）。
      const realDb = path.join(ROOT, "data/app.db");
      if (existsSync(realDb)) {
        const source = new Database(realDb, { readonly: true, fileMustExist: true });
        try {
          await source.backup(dbFile);
        } finally {
          source.close();
        }
        console.log(`[setup] 真实库只读备份 → ${dbFile}`);
      } else {
        console.log("[setup] 没有 data/app.db，使用空库");
      }
    }
    console.log(`[setup] 临时库 ${dbFile}`);
    await seedDatabase(dbFile);

    mock = await startMockLightrag();
    console.log(`[setup] mock LightRAG ${mock.url}`);

    browser = await launchBrowser();

    // 生产态没有 __graphStats；Worker 有无只能靠 CDP Target 域观测。
    const workerTargets = [];
    if (PROD) {
      browser.cdp.on("Target.targetCreated", (params) => {
        const info = params?.targetInfo;
        if (info?.type === "worker") workerTargets.push({ url: info.url, at: Date.now() });
      });
      await browser.cdp.send("Target.setDiscoverTargets", { discover: true });
    }

    if (PROD) {
      app = await startApp({ dbFile, lightragUrl: mock.url });
      console.log(`[setup] 生产服务 next start ${BASE}（full）`);
      const prodPage = await openPage(browser.cdp);
      if (want("prod-default")) {
        mark("开始：生产默认入口");
        await captureProdDefault(prodPage, problems, readings);
        mark("生产默认入口完成");
      }
      if (want("prod-downgrade")) {
        mark("开始：生产自适应降档");
        await captureProdDowngrade(prodPage, problems, readings);
        mark("生产自适应降档完成");
      }
      await prodPage.close();

      if (want("prod-worker") || want("prod-decimate")) {
        // 服务端标签缓存 TTL 60s：换夹具必须重启生产服务，和 dev 脚本同一口径。
        await stopApp(app);
        app = null;
        await mock.setMode("wide");
        app = await startApp({ dbFile, lightragUrl: mock.url });
        console.log(`[setup] 生产服务 next start ${BASE}（wide）`);

        const widePage = await openPage(browser.cdp);
        if (want("prod-worker")) {
          mark("开始：生产真 Worker");
          await captureProdWorker(widePage, problems, readings, workerTargets);
          mark("生产真 Worker 完成");
        }
        if (want("prod-decimate")) {
          mark("开始：生产低档抽稀");
          await captureProdDecimate(widePage, problems, readings);
          mark("生产低档抽稀完成");
        }
        await widePage.close();
      }
    } else {
    if (want("empty")) {
      await mock.setMode("empty");
      app = await startApp({ dbFile, lightragUrl: mock.url });
      console.log(`[setup] dev 服务 ${BASE}`);

      const page = await openPage(browser.cdp);
      // 空状态必须放在最前面：服务端标签缓存 TTL 60s，先拿空结果再切 full 需要重启 dev（下面会做）。
      mark("开始：空状态");
      await captureEmpty(page, problems);
      await page.close();
      await stopApp(app);
      app = null;
      mark("空状态完成");
      console.log("[step] 切到 full 并重启 dev，清掉标签缓存");
    }

    await mock.setMode("full");
    app = await startApp({ dbFile, lightragUrl: mock.url });
    console.log(`[setup] dev 服务 ${BASE}（full）`);

    const page2 = await openPage(browser.cdp);
    if (want("desktop")) {
      mark("开始：桌面 2D");
      await captureDesktop(page2, problems);
      mark("桌面 2D 完成");
    }
    if (want("center")) {
      mark("开始：换中心失败");
      await captureCenterSwitchFailure(page2, problems, mock);
      mark("换中心失败完成");
    }
    if (want("list")) {
      mark("开始：列表");
      await captureList(page2, problems);
      mark("列表完成");
    }
    if (want("mobile")) {
      mark("开始：移动端");
      await captureMobile(page2, problems);
      mark("移动端完成");
    }
    if (want("3d")) {
      mark("开始：3D 默认入口 / 移动端回落 / 低档");
      await capture3dDefault(page2, problems, readings);
      await capture3dMobileFallback(page2, problems, readings);
      await capture3dLowTier(page2, problems, readings);
      await captureOrphan(page2, problems);
      mark("3D 入口与低档完成");
    }
    if (want("downgrade")) {
      mark("开始：自适应降档");
      await captureAdaptiveDowngrade(page2, problems, readings);
      mark("自适应降档完成");
    }
    if (want("maxnodes")) {
      mark("开始：maxNodes 诊断参数");
      await captureMaxNodesParam(page2, problems, readings);
      mark("maxNodes 完成");
    }
    if (want("overbudget")) {
      // 宽夹具独占一个 dev 进程：服务端标签缓存 TTL 60s，切 mock 模式不会刷新首屏标签，
      // 不重启就拿不到宽图的 373 个实体（下拉里还是上一份数据）。
      await stopApp(app);
      app = null;
      await mock.setMode("wide");
      app = await startApp({ dbFile, lightragUrl: mock.url });
      mark("开始：overBudget 抽稀");
      await captureOverBudget(page2, problems, readings, mock);
      mark("overBudget 完成");
    }
    if (want("error")) {
      await mock.setMode("graph-error");
      mark("开始：加载失败");
      await captureError(page2, problems);
      mark("加载失败完成");
    }
    await page2.close();

    if (want("status")) {
      // 状态接口失败要重启 dev：服务端的标签/状态读取有缓存，不能靠客户端切模式。
      await stopApp(app);
      app = null;
      console.log("[step] 切到 status-error 并重启 dev");
      await mock.setMode("status-error");
      app = await startApp({ dbFile, lightragUrl: mock.url });

      const page3 = await openPage(browser.cdp);
      mark("开始：状态读不到");
      await captureStatusUnavailable(page3, problems);
      mark("状态读不到完成");
      await page3.close();
    }
    } // 非生产（next dev）流程结束
  } finally {
    if ((problems.length > 0 || process.env.PHASE6D_DEBUG) && app) {
      console.log(`\n[${PROD ? "next start" : "dev"} 日志末尾]\n${app.logs.join("").slice(-2500)}`);
    }
    await stopApp(app).catch(() => {});
    await browser?.close().catch(() => {});
    await mock?.close().catch(() => {});
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }

  if (problems.length > 0) {
    console.error("\n[problems]");
    for (const problem of problems) console.error(`- ${problem}`);
    process.exit(2);
  }
  console.log("\n[readings]");
  console.log(JSON.stringify(readings, null, 2));
  console.log("\nPhase 6D 截图与断言全部通过");
}

await main();
