/**
 * P0-1 真实模型校准：用「设置 → 大模型」里绑定的真实模型，对真实库里的外库资产逐条打分，
 * 输出六维明细与出口，供人工对照期望值计算一致率。
 *
 * 隔离：把 data/app.db 用 SQLite backup 复制到临时目录，起独立端口的 AUTH_MODE=mock 实例，
 * 只在副本上打分，绝不改动 3000 上的真实库。
 *
 * 用法：node scripts/calibrate-model.mjs [--db data/app.db] [--out calibration.json]
 * 前置：npm run build（跑的是生产包）；本机 .env.local 里有 SETTINGS_ENC_KEY。
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";

const ROOT = path.resolve(import.meta.dirname, "..");
const NEXT_BIN = path.join(ROOT, "node_modules/next/dist/bin/next");
const APP_PORT = Number(process.env.CAL_PORT || 3155);
const BASE = `http://localhost:${APP_PORT}`;
const MOCK_SUB = "mock-local-user";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function argOf(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index > -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const SOURCE_DB = path.resolve(ROOT, argOf("db", "data/app.db"));
const OUT = path.resolve(ROOT, argOf("out", "docs/evaluation/calibration-latest.json"));

function readEnvKey() {
  const file = path.join(ROOT, ".env.local");

  if (!existsSync(file)) throw new Error("缺少 .env.local");

  const match = readFileSync(file, "utf8").match(/^SETTINGS_ENC_KEY=(.*)$/m);

  if (!match) throw new Error(".env.local 缺少 SETTINGS_ENC_KEY");

  return match[1].trim().replace(/^["']|["']$/g, "");
}

function portInUse(port) {
  return new Promise((done) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
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

async function api(pathname, options = {}) {
  const response = await fetch(`${BASE}${pathname}`, {
    method: options.method ?? "GET",
    headers: options.body ? { "content-type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  let json = null;

  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* 非 JSON */
  }

  return { status: response.status, json, text };
}

const dimShort = {
  completeness: "完整",
  insight: "洞察",
  actionability: "可操作",
  relevance: "关联",
  timeliness: "时效",
  credibility: "可信",
};

async function main() {
  if (!existsSync(path.join(ROOT, ".next"))) throw new Error("先 npm run build");

  if (await portInUse(APP_PORT)) throw new Error(`端口 ${APP_PORT} 被占用，用 CAL_PORT 换一个`);

  const dir = await mkdtemp(path.join(os.tmpdir(), "pakp-cal-"));
  const dbFile = path.join(dir, "app.db");

  const source = new Database(SOURCE_DB, { readonly: true });
  await source.backup(dbFile);
  source.close();

  const copy = new Database(dbFile);

  copy
    .prepare("update objects set owner_sub = ?")
    .run(MOCK_SUB);
  copy.close();

  const key = readEnvKey();
  const child = spawn(process.execPath, [NEXT_BIN, "start", "-p", String(APP_PORT)], {
    cwd: ROOT,
    env: {
      ...process.env,
      AUTH_MODE: "mock",
      DATABASE_PATH: dbFile,
      SETTINGS_ENC_KEY: key,
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

    const list = await api("/api/objects?type=asset&library=external");

    if (list.status !== 200) {
      throw new Error(`列表失败 ${list.status}\n${logs.join("").slice(-2000)}`);
    }

    const assets = list.json?.items ?? list.json ?? [];
    const results = [];

    for (const asset of assets) {
      const started = Date.now();
      const response = await api(`/api/objects/${asset.id}/score`, { method: "POST", body: {} });
      const elapsed = Date.now() - started;
      const scored = response.json?.object ?? response.json?.asset ?? null;
      const detail = scored?.aiScoreDetail ?? null;

      results.push({
        id: asset.id,
        title: asset.title,
        status: response.status,
        elapsedMs: elapsed,
        total: detail?.total ?? scored?.aiScore ?? null,
        verdict: detail?.verdict ?? scored?.aiStatus ?? null,
        library: scored?.library ?? null,
        valueLevel: scored?.valueLevel ?? null,
        model: detail?.model ?? null,
        dimensions: (detail?.dimensions ?? []).map((item) => ({
          key: item.key,
          score: item.score,
          reason: item.reason,
        })),
        error: response.status >= 400 ? response.json?.error?.message ?? response.text.slice(0, 200) : null,
      });

      console.log(
        `[score] ${asset.title} → ${response.status} ${detail ? `${detail.total} ${detail.verdict}` : results.at(-1).error} (${elapsed}ms)`,
      );
    }

    const report = {
      generatedAt: new Date().toISOString(),
      sourceDb: SOURCE_DB,
      baseUrl: BASE,
      samples: results.length,
      results,
    };

    await writeFile(OUT, `${JSON.stringify(report, null, 2)}\n`, "utf8");

    console.log("");
    console.log("=== 校准明细 ===");

    for (const item of results) {
      const dims = item.dimensions
        .map((dimension) => `${dimShort[dimension.key] ?? dimension.key}${dimension.score}`)
        .join(" ");

      console.log(`${item.total ?? "-"} ${item.verdict ?? "-"} | ${item.title} | ${dims}`);
    }

    console.log(`\n结果写入：${OUT}（${results.length} 条）`);
  } finally {
    child.kill();

    await sleep(500);
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
