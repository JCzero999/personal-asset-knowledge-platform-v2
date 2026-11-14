/**
 * 规格 v2.0 端到端验收：AI 提炼 → 六维打分 → 复核 → 实践结算 → 价值评估 → 规则守卫。
 *
 * 隔离：临时库（%TEMP%）+ AUTH_MODE=mock + 独立端口 + mock RAGFlow + mock 绑定大模型，
 * 跑的是生产包（`next start`），不碰 `data/app.db`，也不碰 3000 上的日常服务。
 *
 * 用法：npm run build && node scripts/verify-lifecycle-v2.mjs
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

const ROOT = path.resolve(import.meta.dirname, "..");
const NEXT_BIN = path.join(ROOT, "node_modules/next/dist/bin/next");
const APP_PORT = Number(process.env.APP_PORT || 3141);
const LLM_PORT = Number(process.env.LLM_PORT || 9376);
const RAG_PORT = Number(process.env.RAG_PORT || 9377);
const BASE = `http://localhost:${APP_PORT}`;
const OWNER_SUB = "mock-local-user";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const problems = [];
const facts = {};
const note = (label, value) => {
  facts[label] = value;
  console.log(`[fact] ${label}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
};
const check = (condition, message) => {
  if (!condition) problems.push(message);
};

/* ------------------------------ 夹具 ------------------------------ */

const now = new Date().toISOString();
const WORKS = {
  draft: "work-draft-0001",
  published: "work-published-0001",
};
const ASSETS = {
  high: "asset-high-0001",
  mid: "asset-mid-0001",
  low: "asset-low-0001",
  edge75: "asset-edge75-0001",
  edge60: "asset-edge60-0001",
  review: "asset-review-0001",
  reject: "asset-reject-0001",
};

const objectRow = (overrides) => ({
  description: null,
  titleNorm: null,
  descriptionNorm: null,
  library: "external",
  source: "handwritten",
  origin: "self",
  categoryCode: null,
  priority: "medium",
  archivedAt: null,
  libraryChangedAt: null,
  ownerSub: OWNER_SUB,
  revision: 1,
  createdAt: now,
  updatedAt: now,
  deletedAt: null,
  status: null,
  sourceNote: null,
  publishedAt: null,
  practicedAt: null,
  practiceMetrics: null,
  settledAssetId: null,
  sourceType: "external_direct",
  aiStatus: "unscored",
  aiScore: null,
  aiScoreDetail: null,
  valueLevel: null,
  valueScores: null,
  valueAssessedAt: null,
  useCount: 0,
  lastUsedAt: null,
  originWorkId: null,
  ...overrides,
});

async function seedDatabase(file) {
  const sqlite = new Database(file);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("busy_timeout = 5000");
  migrate(drizzle(sqlite), { migrationsFolder: path.join(ROOT, "drizzle") });

  const insert = (row) => {
    const toColumn = (key) => key.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
    const entries = Object.entries(row).map(([key, value]) => [toColumn(key), value]);
    sqlite
      .prepare(
        `insert into objects (${entries.map(([key]) => `"${key}"`).join(", ")}) values (${entries
          .map(() => "?")
          .join(", ")})`,
      )
      .run(...entries.map(([, value]) => value));
  };

  insert(
    objectRow({
      id: WORKS.draft,
      type: "work",
      title: "提炼验收作品",
      description: "用于验收 AI 提炼的作品。",
      status: "draft",
      categoryCode: "article",
      sourceType: null,
      aiStatus: null,
    }),
  );
  insert(
    objectRow({
      id: WORKS.published,
      type: "work",
      title: "实践验收作品",
      description: "用于验收已实践自动沉淀。",
      status: "published",
      categoryCode: "article",
      publishedAt: now,
      sourceType: null,
      aiStatus: null,
    }),
  );
  insert(
    objectRow({ id: ASSETS.high, type: "asset", title: "高分资产", description: "结构完整的方法论。" }),
  );
  insert(
    objectRow({ id: ASSETS.mid, type: "asset", title: "中分资产", description: "有一定价值的记录。" }),
  );
  insert(
    objectRow({ id: ASSETS.low, type: "asset", title: "低分资产", description: "常识复述。" }),
  );
  insert(objectRow({ id: ASSETS.edge75, type: "asset", title: "边界75" }));
  insert(objectRow({ id: ASSETS.edge60, type: "asset", title: "边界60" }));
  insert(
    objectRow({
      id: ASSETS.review,
      type: "asset",
      title: "复核通过资产",
      aiStatus: "needs_review",
      aiScore: 65,
    }),
  );
  insert(
    objectRow({
      id: ASSETS.reject,
      type: "asset",
      title: "复核拒绝资产",
      aiStatus: "needs_review",
      aiScore: 62,
    }),
  );

  sqlite
    .prepare(
      `insert into content_refs
        (id, owner_type, owner_id, provider, dataset_id, document_id, content_key, role,
         document_name, parse_status, sync_state, created_at, updated_at)
       values ('ref-draft-0001', 'work', ?, 'ragflow', 'ds-verify', 'doc-verify', 'key-verify',
               'primary', '验收正文.md', 'succeeded', 'synced', ?, ?)`,
    )
    .run(WORKS.draft, now, now);

  sqlite.close();
}

/* ------------------------------ mock 模型 ------------------------------ */

const dimensionKeys = ["completeness", "insight", "actionability", "relevance", "timeliness", "credibility"];
let llmCalls = 0;

function dims(score) {
  return dimensionKeys.map((key) => ({ key, score, reason: `验收固定 ${score} 分` }));
}

function scorePrompt(user) {
  const title = /资产标题：([^\n]+)/.exec(user)?.[1]?.trim() ?? "";
  if (title === "高分资产") return dims(95);
  if (title === "边界75") return dims(75);
  if (title === "边界60") return dims(60);
  if (title === "低分资产") return dims(40);
  return dims(65);
}

function llmReply(system, user) {
  if (system.includes("内容提炼助手")) {
    return JSON.stringify({
      assets: [
        {
          title: "提炼验收资产",
          description: "从作品正文提炼出的可复用资产，包含方法、步骤与判断标准。",
          tags: [],
        },
      ],
    });
  }
  if (system.includes("资产评审员")) {
    // 故意塞一个错的总分，验证服务端不采信模型自报总分。
    return JSON.stringify({ dimensions: scorePrompt(user), total: 999 });
  }
  if (system.includes("价值评估员")) {
    return JSON.stringify({
      dimensions: [
        { key: "practice", score: 4, reason: "有明确数据反馈" },
        { key: "reuse", score: 4, reason: "偶尔调用" },
        { key: "transferability", score: 4, reason: "可迁移相近场景" },
        { key: "uniqueness", score: 4, reason: "有个人视角" },
        { key: "timeliness", score: 4, reason: "中等有效期" },
      ],
    });
  }
  return "{}";
}

function startMockLlm() {
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      if (request.url?.endsWith("/chat/completions")) {
        llmCalls += 1;
        const payload = JSON.parse(body || "{}");
        const system = payload.messages?.find((m) => m.role === "system")?.content ?? "";
        const user = payload.messages?.find((m) => m.role === "user")?.content ?? "";
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            model: "lifecycle-fake-model",
            choices: [{ message: { role: "assistant", content: llmReply(system, user) } }],
          }),
        );
        return;
      }
      response.writeHead(404).end();
    });
  });
  return new Promise((resolve) => {
    server.listen(LLM_PORT, "127.0.0.1", () =>
      resolve({ url: `http://127.0.0.1:${LLM_PORT}/v1`, close: () => server.close() }),
    );
  });
}

/* ------------------------------ mock RAGFlow ------------------------------ */

function startMockRagflow() {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (/^\/api\/v1\/datasets\/[^/]+\/documents\/[^/]+\/chunks$/.test(url.pathname)) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          code: 0,
          data: {
            chunks: [
              {
                id: "chunk-1",
                content:
                  "知识管理的关键是把输入转成可复用的资产：先记录问题与场景，再写下方法与步骤，" +
                  "最后用真实数据验证。卡片笔记负责拆解，第二大脑负责连接，渐进式总结负责压缩。",
              },
            ],
            total: 1,
          },
        }),
      );
      return;
    }
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ code: 404, message: "mock ragflow: not found" }));
  });
  return new Promise((resolve) => {
    server.listen(RAG_PORT, "127.0.0.1", () =>
      resolve({ url: `http://127.0.0.1:${RAG_PORT}`, close: () => server.close() }),
    );
  });
}

/* ------------------------------ 应用进程 ------------------------------ */

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

async function waitForServer(url) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.status < 500) return;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error(`服务未就绪：${url}`);
}

async function startApp({ dbFile, llmUrl, ragUrl }) {
  if (await portInUse(APP_PORT)) {
    throw new Error(`端口 ${APP_PORT} 已被占用；用 APP_PORT=xxxx 换一个。`);
  }
  const child = spawn(process.execPath, [NEXT_BIN, "start", "-p", String(APP_PORT)], {
    cwd: ROOT,
    env: {
      ...process.env,
      AUTH_MODE: "mock",
      DATABASE_PATH: dbFile,
      RAGFLOW_BASE_URL: ragUrl,
      RAGFLOW_API_KEY: "lifecycle-mock",
      RAGFLOW_DATASET_ID: "ds-verify",
      LIGHTRAG_BASE_URL: "http://127.0.0.1:1",
      LIGHTRAG_API_KEY: "lifecycle-mock",
      SETTINGS_ENC_KEY: "lifecycle-harness-only-secret",
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

/* ------------------------------ HTTP 与数据库 ------------------------------ */

async function api(pathname, options = {}) {
  const response = await fetch(`${BASE}${pathname}`, {
    method: options.method ?? "GET",
    headers: { "Content-Type": "application/json" },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

function query(dbFile, sql, params = []) {
  const sqlite = new Database(dbFile, { readonly: true });
  try {
    return sqlite.prepare(sql).all(...params);
  } finally {
    sqlite.close();
  }
}

const objectRowById = (dbFile, id) =>
  query(dbFile, "select * from objects where id = ?", [id])[0] ?? null;

/* ------------------------------ 界面验收（同一份生产构建） ------------------------------ */

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
].filter(Boolean);
const CHROME = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
const CDP_PORT = Number(process.env.CDP_PORT || 9351);

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
      for (const fn of this.listeners.get(message.method) ?? []) fn(message.params);
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
      /* Chrome 还没起来 */
    }
    await sleep(200);
  }
  throw new Error(`等待 ${url} 超时`);
}

async function launchHeadless() {
  if (!CHROME) throw new Error("找不到 Chrome / Edge，可设置 CHROME_PATH");
  const userDataDir = path.join(os.tmpdir(), `pakp-lifecycle-chrome-${Date.now()}`);
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
  const cdp = new Cdp(ws);
  return {
    cdp,
    async close() {
      await Promise.race([
        cdp.send("Browser.close").catch(() => child.kill()),
        sleep(3000),
      ]).catch(() => {});
      ws.close();
      await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

async function runUiChecks() {
  const browser = await launchHeadless();
  try {
    const { targetId } = await browser.cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await browser.cdp.send("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    const pageErrors = [];
    browser.cdp.on(`${sessionId}:Runtime.exceptionThrown`, (params) => {
      pageErrors.push(params.exceptionDetails?.exception?.description?.slice(0, 300) ?? "exception");
    });
    await browser.cdp.send("Page.enable", {}, sessionId);
    await browser.cdp.send("Runtime.enable", {}, sessionId);

    const evaluate = async (expression) => {
      const result = await browser.cdp.send(
        "Runtime.evaluate",
        { expression, awaitPromise: true, returnByValue: true },
        sessionId,
      );
      return result.result?.value;
    };
    const visit = async (pathname, expected) => {
      const loaded = new Promise((resolve) => {
        browser.cdp.on(`${sessionId}:Page.loadEventFired`, resolve);
        setTimeout(resolve, 20000);
      });
      await browser.cdp.send("Page.navigate", { url: `${BASE}${pathname}` }, sessionId);
      await loaded;
      const started = Date.now();
      while (Date.now() - started < 15000) {
        const text = await evaluate("document.body ? document.body.innerText : ''").catch(() => "");
        if (expected.every((word) => (text ?? "").includes(word))) {
          note(`界面 ${pathname}`, "通过");
          return true;
        }
        await sleep(200);
      }
      const text = (await evaluate("document.body ? document.body.innerText : ''").catch(() => "")) ?? "";
      note(`界面 ${pathname}`, { missing: expected.filter((word) => !text.includes(word)) });
      check(false, `界面 ${pathname} 缺少预期内容：${expected.filter((word) => !text.includes(word)).join("、")}`);
      return false;
    };

    await visit("/workspace?type=asset&library=external&aiStatus=needs_review", ["待人工复核", "边界60"]);
    await visit(`/workspace/${ASSETS.high}`, ["A 级", "价值评估"]);
    await visit(`/workspace/${WORKS.draft}`, ["AI 提炼"]);
    await visit(`/workspace/${WORKS.published}`, ["已实践", "沉淀"]);
    await visit("/workspace?valueLevel=A", ["高分资产", "实践验收作品"]);

    note("界面脚本异常数", pageErrors.length);
    check(pageErrors.length === 0, `页面脚本异常：${pageErrors.join(" | ")}`);
  } finally {
    await browser.close();
  }
}

/* ------------------------------ 断言流程 ------------------------------ */

async function run() {
  const llm = await startMockLlm();
  const rag = await startMockRagflow();
  const dir = await mkdtemp(path.join(os.tmpdir(), "pakp-lifecycle-"));
  const seedDb = path.join(dir, "app.db");
  await seedDatabase(seedDb);

  const app = await startApp({ dbFile: seedDb, llmUrl: llm.url, ragUrl: rag.url });

  try {
    const saved = await api("/api/settings/llm", {
      method: "PUT",
      body: {
        provider: "custom",
        baseUrl: llm.url,
        model: "lifecycle-fake-model",
        timeoutMs: 60000,
        apiKey: "lifecycle-key",
      },
    });
    check(saved.status === 200, `绑定模型失败：HTTP ${saved.status}`);

    /* 1. 提炼：仅草稿 */
    const notDraft = await api(`/api/objects/${WORKS.published}/extract`, { method: "POST", body: {} });
    check(notDraft.status === 409, `已发布作品提炼应 409，实际 ${notDraft.status}`);

    const extracted = await api(`/api/objects/${WORKS.draft}/extract`, { method: "POST", body: {} });
    note("提炼响应", { status: extracted.status, count: extracted.body?.assets?.length });
    check(extracted.status === 201, `草稿提炼应 201，实际 ${extracted.status} ${JSON.stringify(extracted.body)}`);

    const extractedAssets = query(
      seedDb,
      "select * from objects where type = 'asset' and source_type = 'ai_extract'",
    );
    note("提炼产物", extractedAssets.map((row) => ({ title: row.title, library: row.library, ai: row.ai_status })));
    check(extractedAssets.length === 1, `提炼应产出 1 条资产，实际 ${extractedAssets.length}`);
    check(extractedAssets.every((row) => row.library === "external"), "提炼产物不得直接进内库");
    check(
      extractedAssets.every((row) => row.ai_status === "needs_review"),
      `65 分提炼产物应进复核池，实际 ${extractedAssets.map((row) => row.ai_status).join(",")}`,
    );

    const duplicate = await api(`/api/objects/${WORKS.draft}/extract`, { method: "POST", body: {} });
    check(duplicate.status === 409, `重复提炼应 409，实际 ${duplicate.status}`);
    const afterDuplicate = query(
      seedDb,
      "select count(*) as n from objects where type = 'asset' and source_type = 'ai_extract'",
    )[0].n;
    check(afterDuplicate === 1, `重复提炼后资产应仍为 1，实际 ${afterDuplicate}`);

    /* 2. 实践结算 */
    const practice = await api(`/api/objects/${WORKS.published}/practice`, {
      method: "POST",
      body: { metrics: { platform: "公众号", bounceRate: "32%" } },
    });
    note("实践结算", {
      status: practice.status,
      workStatus: practice.body?.work?.status,
      assetLibrary: practice.body?.asset?.library,
      level: practice.body?.asset?.valueLevel,
    });
    check(practice.status === 200, `实践结算应 200，实际 ${practice.status} ${JSON.stringify(practice.body)}`);

    const work = objectRowById(seedDb, WORKS.published);
    check(work?.status === "practiced", `作品应为 practiced，实际 ${work?.status}`);
    check(work?.library === "external", `作品应留在外库，实际 ${work?.library}`);
    check(work?.archived_at === null, `作品不应被自动归档，实际 ${work?.archived_at}`);
    check(Boolean(work?.settled_asset_id), "作品应记录 settled_asset_id");
    check(Boolean(work?.practiced_at), "作品应记录 practiced_at");
    check(work?.practice_metrics?.includes("bounceRate"), "实践数据快照应落库");

    const settled = objectRowById(seedDb, work.settled_asset_id);
    check(settled?.library === "internal", `沉淀资产应在内库，实际 ${settled?.library}`);
    check(settled?.source_type === "practiced_work", `沉淀资产来源应为 practiced_work，实际 ${settled?.source_type}`);
    check(
      ["S", "A", "B", "C"].includes(settled?.value_level ?? ""),
      `沉淀资产必须有等级，实际 ${settled?.value_level}`,
    );
    const settledScores = settled?.value_scores ? JSON.parse(settled.value_scores) : null;
    check(settledScores?.dimensions?.length === 5, "沉淀资产必须有 5 维分");

    const repeat = await api(`/api/objects/${WORKS.published}/practice`, { method: "POST", body: {} });
    check(repeat.status === 409, `重复实践应 409，实际 ${repeat.status}`);
    const settledCount = query(
      seedDb,
      "select count(*) as n from objects where origin_work_id = ? and source_type = 'practiced_work'",
      [WORKS.published],
    )[0].n;
    check(settledCount === 1, `重复实践不得产生第二条沉淀资产，实际 ${settledCount}`);

    /* 3. 六维打分三档 + 边界 */
    const high = await api(`/api/objects/${ASSETS.high}/score`, { method: "POST", body: {} });
    const highRow = objectRowById(seedDb, ASSETS.high);
    note("高分", { status: high.status, score: highRow?.ai_score, library: highRow?.library, level: highRow?.value_level });
    check(high.status === 200 && highRow?.library === "internal", "95 分应自动进内库");
    check(Boolean(highRow?.value_level), "自动进内库必须同时有等级");
    const highDetail = highRow?.ai_score_detail ? JSON.parse(highRow.ai_score_detail) : null;
    check(highDetail?.total === 95, `服务端应忽略模型自报总分并按权重计算，实际 ${highDetail?.total}`);
    check(highDetail?.dimensions?.length === 6, "AI 分必须含 6 维明细");

    const edge75 = await api(`/api/objects/${ASSETS.edge75}/score`, { method: "POST", body: {} });
    const edge75Row = objectRowById(seedDb, ASSETS.edge75);
    check(edge75.status === 200 && edge75Row?.library === "internal", "75 分（含等号）应进内库");
    note("边界75", { score: edge75Row?.ai_score, library: edge75Row?.library, level: edge75Row?.value_level });

    const edge60 = await api(`/api/objects/${ASSETS.edge60}/score`, { method: "POST", body: {} });
    const edge60Row = objectRowById(seedDb, ASSETS.edge60);
    check(edge60.status === 200 && edge60Row?.ai_status === "needs_review", "60 分应进待复核");
    check(edge60Row?.library === "external", "待复核资产应留在外库");
    note("边界60", { score: edge60Row?.ai_score, status: edge60Row?.ai_status });

    const low = await api(`/api/objects/${ASSETS.low}/score`, { method: "POST", body: {} });
    const lowRow = objectRowById(seedDb, ASSETS.low);
    check(low.status === 200 && lowRow?.ai_status === "low_value", "40 分应标记低价值");
    check(lowRow?.library === "external", "低价值资产应留在外库");

    /* 4. 人工复核两条出口 */
    const approved = await api(`/api/objects/${ASSETS.review}/review`, {
      method: "POST",
      body: { decision: "approve", note: "内容可用" },
    });
    const approvedRow = objectRowById(seedDb, ASSETS.review);
    check(approved.status === 200 && approvedRow?.library === "internal", "复核通过应进内库");
    check(Boolean(approvedRow?.value_level), "复核通过必须同时有等级");
    check(approvedRow?.ai_status === "approved", `复核通过状态应为 approved，实际 ${approvedRow?.ai_status}`);

    const rejected = await api(`/api/objects/${ASSETS.reject}/review`, {
      method: "POST",
      body: { decision: "reject", note: "重复内容" },
    });
    const rejectedRow = objectRowById(seedDb, ASSETS.reject);
    check(rejected.status === 200 && rejectedRow?.ai_status === "low_value", "复核拒绝应转低价值");
    check(rejectedRow?.library === "external", "复核拒绝应留在外库");

    /* 5. 规则守卫 */
    const bypass = await api(`/api/objects/${ASSETS.edge60}/library`, {
      method: "POST",
      body: { to: "internal", reason: "绕过复核", expectedRevision: edge60Row?.revision },
    });
    check(bypass.status === 409 || bypass.status === 422, `外库资产直接改内库应被拒，实际 ${bypass.status}`);
    check(objectRowById(seedDb, ASSETS.edge60)?.library === "external", "被拒后资产仍应在外库");

    const workInternal = await api(`/api/objects/${WORKS.published}/library`, {
      method: "POST",
      body: { to: "internal", reason: "作品迁内库" },
    });
    check(workInternal.status === 409 || workInternal.status === 422, `作品迁内库应被拒，实际 ${workInternal.status}`);

    const createWorkInternal = await api("/api/objects", {
      method: "POST",
      body: { type: "work", title: "内库作品", library: "internal", category: "article" },
    });
    check(createWorkInternal.status === 409, `新建内库作品应 409，实际 ${createWorkInternal.status}`);

    const practiceDraft = await api(`/api/objects/${WORKS.draft}/practice`, { method: "POST", body: {} });
    check(practiceDraft.status === 409, `草稿不能标记已实践，实际 ${practiceDraft.status}`);

    /* 6. 列表筛选 */
    const reviewList = await api("/api/objects?aiStatus=needs_review");
    const reviewRows = Array.isArray(reviewList.body) ? reviewList.body : [];
    check(
      reviewList.status === 200 && reviewRows.length >= 1 && reviewRows.every((row) => row.aiStatus === "needs_review"),
      `待复核筛选不正确：${JSON.stringify(reviewRows.map((row) => row.aiStatus))}`,
    );
    const levelList = await api("/api/objects?valueLevel=S");
    const levelRows = Array.isArray(levelList.body) ? levelList.body : [];
    check(
      levelList.status === 200 && levelRows.every((row) => row.valueLevel === "S"),
      "价值等级筛选不正确",
    );

    /* 7. 全局不变量：内库资产必须有 5 维分与等级 */
    const violations = query(
      seedDb,
      "select count(*) as n from objects where type='asset' and library='internal' and deleted_at is null and (value_level is null or value_scores is null or value_assessed_at is null)",
    )[0].n;
    note("内库缺等级资产数", violations);
    check(violations === 0, `存在 ${violations} 条无等级的内库资产`);

    note("模型调用次数", llmCalls);
    check(llmCalls > 0, "验收过程中绑定模型未被调用");

    await runUiChecks();
  } finally {
    app.child.kill();
    llm.close();
    rag.close();
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

await run();

if (problems.length > 0) {
  console.error("\n失败项：");
  for (const problem of problems) console.error(` - ${problem}`);
  process.exitCode = 1;
} else {
  console.log("\n全部断言通过（规格 v2.0：提炼 / 打分 / 复核 / 实践结算 / 价值评估 / 规则守卫）。");
}
