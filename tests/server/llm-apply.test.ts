import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { actor } from "../helpers/actor";
import { DomainError } from "../../src/domain/errors";
import { openDatabase, type DatabaseHandle } from "../../src/server/db/client";
import { auditEvents } from "../../src/server/db/schema";
import {
  applyLlmSettings,
  findLightragProcesses,
  getLlmSettings,
  updateLlmSettings,
  type LlmApplyDeps,
} from "../../src/server/services/llm-settings-service";

const SECRET = "unit-test-settings-key-0123456789";

const ENV_FIXTURE = `# 本机 LightRAG 配置
HOST=127.0.0.1
PORT=9621
LLM_BINDING=ollama
LLM_MODEL=deepseek-r1:7b
LLM_BINDING_HOST=http://127.0.0.1:11434
LLM_BINDING_API_KEY=ollama
LLM_TIMEOUT=300
EMBEDDING_BINDING=openai
EMBEDDING_BINDING_HOST=http://127.0.0.1:9381/v1
LIGHTRAG_API_KEY=local-secret
`;

let handle: DatabaseHandle;
let dir: string;
let envPath: string;

function saveConfig() {
  updateLlmSettings(
    handle.db,
    actor("u-owner"),
    {
      provider: "deepseek",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-chat",
      timeoutMs: 120_000,
      apiKey: "sk-abcdef123456",
    },
    { envPath, secret: SECRET },
  );
}

/** 每次「重启」都只记录调用，绝不碰真实进程。 */
function harness(healthOk: boolean) {
  let clock = 0;
  const killed: number[] = [];
  const spawns: { exe: string; cwd: string }[] = [];
  const healthCalls: string[] = [];

  const deps: LlmApplyDeps = {
    envPath,
    secret: SECRET,
    env: { LIGHTRAG_BASE_URL: "http://127.0.0.1:9621", LIGHTRAG_API_KEY: "local-secret" },
    fetchImpl: (async (input: RequestInfo | URL) => {
      healthCalls.push(String(input));
      return new Response(healthOk ? "ok" : "starting", { status: healthOk ? 200 : 503 });
    }) as unknown as typeof fetch,
    sleep: async (ms: number) => {
      clock += ms;
    },
    now: () => clock,
    healthTimeoutMs: 6_000,
    pollIntervalMs: 1_000,
    runPowerShell: () =>
      JSON.stringify([
        {
          ProcessId: 4321,
          Name: "python.exe",
          CommandLine:
            '"D:\\projects\\Personal Asset & Knowledge PlatformV2\\infra\\lightrag\\.venv\\Scripts\\lightrag-server.exe"',
        },
        {
          ProcessId: 9876,
          Name: "python.exe",
          CommandLine: "... -m uvicorn embedding_server:app --port 9381",
        },
      ]),
    killProcess: (pid: number) => killed.push(pid),
    spawnDetached: (exe: string, cwd: string) => spawns.push({ exe, cwd }),
  };

  return { deps, killed, spawns, healthCalls };
}

beforeEach(() => {
  handle = openDatabase({ file: ":memory:" });
  handle.sqlite.exec("DELETE FROM settings; DELETE FROM audit_events;");

  dir = mkdtempSync(path.join(tmpdir(), "pakp-llm-apply-"));
  envPath = path.join(dir, ".env");
  writeFileSync(envPath, ENV_FIXTURE, "utf8");

  mkdirSync(path.join(dir, ".venv", "Scripts"), { recursive: true });
  writeFileSync(path.join(dir, ".venv", "Scripts", "lightrag-server.exe"), "", "utf8");
});

afterAll(() => {
  handle?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("应用配置（ADR-025）", () => {
  it("写 .env → 只重启 lightrag-server → /health 通过", async () => {
    saveConfig();
    const { deps, killed, spawns, healthCalls } = harness(true);

    const result = await applyLlmSettings(handle.db, actor("u-owner"), deps);

    expect(result.applied).toBe(true);
    expect(result.restarted).toBe(true);
    expect(result.rolledBack).toBe(false);
    expect(result.backup).toMatch(/^\.env\.bak-/);
    expect(result.healthLatencyMs).toBe(0);

    const content = readFileSync(envPath, "utf8");
    expect(content).toContain("LLM_BINDING=openai");
    expect(content).toContain("LLM_MODEL=deepseek-chat");
    expect(content).toContain("LLM_BINDING_HOST=https://api.deepseek.com");
    expect(content).toContain("LLM_BINDING_API_KEY=sk-abcdef123456");
    expect(content).toContain("LLM_TIMEOUT=120");
    // 非 LLM 行不动。
    expect(content).toContain("EMBEDDING_BINDING_HOST=http://127.0.0.1:9381/v1");
    expect(content).toContain("LIGHTRAG_API_KEY=local-secret");

    // 只杀 lightrag-server（embedding 的 9876 被过滤）。
    expect(killed).toEqual([4321]);
    expect(spawns).toHaveLength(1);
    expect(spawns[0].cwd).toBe(dir);
    expect(spawns[0].exe).toBe(path.join(dir, ".venv", "Scripts", "lightrag-server.exe"));
    expect(healthCalls).toEqual(["http://127.0.0.1:9621/health"]);

    // 备份保留原文件。
    const backup = path.join(dir, result.backup);
    expect(existsSync(backup)).toBe(true);
    expect(readFileSync(backup, "utf8")).toBe(ENV_FIXTURE);

    // 应用后读取视图标记为已应用。
    expect(getLlmSettings(handle.db, { envPath, secret: SECRET }).appliedToLightrag).toBe(true);

    const audit = handle.db.select().from(auditEvents).all();
    expect(audit).toHaveLength(2); // save + apply
    const applyAudit = audit.find((row) => row.action === "settings.llm.apply")!;
    expect(applyAudit.result).toBe("ok");
    expect(applyAudit.detail).not.toContain("sk-abcdef123456");
  });

  it("健康检查不通过：回滚 .env、重启回原配置、审计记 error", async () => {
    saveConfig();
    const { deps, killed, spawns } = harness(false);

    let caught: unknown;
    try {
      await applyLlmSettings(handle.db, actor("u-owner"), deps);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(DomainError);
    const domain = caught as DomainError;
    expect(domain.code).toBe("INTERNAL");
    expect(domain.message).toContain("回滚");
    expect(domain.details?.rolledBack).toBe(true);

    // 文件回到原始内容。
    expect(readFileSync(envPath, "utf8")).toBe(ENV_FIXTURE);
    // 第一次重启 + 回滚重启。
    expect(killed).toEqual([4321, 4321]);
    expect(spawns).toHaveLength(2);
    expect(getLlmSettings(handle.db, { envPath, secret: SECRET }).appliedToLightrag).toBe(false);

    const applyAudit = handle.db
      .select()
      .from(auditEvents)
      .all()
      .find((row) => row.action === "settings.llm.apply")!;
    expect(applyAudit.result).toBe("error");
    expect(applyAudit.detail).toContain("rolledBack");
    expect(applyAudit.detail).not.toContain("sk-abcdef123456");
  });

  it("没有保存过配置时拒绝应用", async () => {
    const { deps } = harness(true);
    await expect(applyLlmSettings(handle.db, actor("u"), deps)).rejects.toThrowError(
      /请先保存大模型配置/,
    );
  });

  it(".env 不存在时拒绝应用（不猜测运行时目录）", async () => {
    saveConfig();
    const { deps } = harness(true);
    await expect(
      applyLlmSettings(handle.db, actor("u"), { ...deps, envPath: path.join(dir, "missing.env") }),
    ).rejects.toThrowError(/找不到/);
  });

  it("skipRestart 只写文件，不碰进程（演练用）", async () => {
    saveConfig();
    const { deps, killed, spawns } = harness(true);

    const result = await applyLlmSettings(handle.db, actor("u"), { ...deps, skipRestart: true });

    expect(result.restarted).toBe(false);
    expect(result.healthLatencyMs).toBeNull();
    expect(killed).toEqual([]);
    expect(spawns).toEqual([]);
    expect(readFileSync(envPath, "utf8")).toContain("LLM_MODEL=deepseek-chat");
  });
});

describe("进程定位只匹配 lightrag-server", () => {
  it("排除 embedding 与 9381，保留 python 拉起的 lightrag-server", () => {
    const processes = findLightragProcesses(() =>
      JSON.stringify([
        { ProcessId: 1, Name: "lightrag-server.exe", CommandLine: '"...\\lightrag-server.exe"' },
        {
          ProcessId: 2,
          Name: "python.exe",
          CommandLine: '"...python.exe" "...\\lightrag-server.exe"',
        },
        { ProcessId: 3, Name: "python.exe", CommandLine: "... embedding_server:app --port 9381" },
        { ProcessId: 4, Name: "python.exe", CommandLine: "... 9381 ... lightrag-server" },
        { ProcessId: 5, Name: "docker.exe", CommandLine: "docker ps" },
      ]),
    );

    expect(processes.map((item) => item.pid)).toEqual([1, 2]);
  });

  it("空输出返回空数组，不误杀", () => {
    expect(findLightragProcesses(() => "")).toEqual([]);
  });
});
