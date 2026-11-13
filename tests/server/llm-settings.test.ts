import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { actor } from "../helpers/actor";
import { ValidationError } from "../../src/domain/errors";
import {
  permissionsForRoles,
  requirePermissionWith,
  type PermissionKey,
} from "../../src/server/authz";
import { openDatabase, type DatabaseHandle } from "../../src/server/db/client";
import { auditEvents } from "../../src/server/db/schema";
import {
  DEFAULT_LLM_CONFIG,
  LLM_TIMEOUT_MAX_MS,
  LLM_TIMEOUT_MIN_MS,
  getLlmSettings,
  isAppliedToLightrag,
  normalizeBaseUrl,
  normalizeLlmConfig,
  parseEnvFile,
  readEnvConfig,
  renderLightragEnv,
  testLlmConnection,
  updateLlmSettings,
} from "../../src/server/services/llm-settings-service";
import type { Session } from "../../src/server/ports/session";

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

function sessionWith(permissions: readonly string[]): Session {
  return {
    sub: "u-editor",
    name: "编辑",
    email: null,
    userId: "u-1",
    permissions: [...permissions],
    isAdmin: false,
  };
}

beforeEach(() => {
  handle = openDatabase({ file: ":memory:" });
  handle.sqlite.exec("DELETE FROM settings; DELETE FROM audit_events;");

  dir = mkdtempSync(path.join(tmpdir(), "pakp-llm-settings-"));
  envPath = path.join(dir, ".env");
  writeFileSync(envPath, ENV_FIXTURE, "utf8");
});

afterAll(() => {
  handle?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("设置权限（ADR-025）", () => {
  it("只有所有者与管理员拥有 settings:read / settings:write", () => {
    for (const role of ["owner", "admin"] as const) {
      expect(permissionsForRoles([role])).toEqual(
        expect.arrayContaining(["settings:read", "settings:write"]),
      );
    }

    for (const role of ["editor", "viewer"] as const) {
      expect(permissionsForRoles([role])).not.toContain("settings:read" as PermissionKey);
      expect(permissionsForRoles([role])).not.toContain("settings:write" as PermissionKey);
    }
  });

  it("编辑身份写设置返回 403 并记一条 denied 审计", async () => {
    const denied = requirePermissionWith(
      handle.db,
      sessionWith(permissionsForRoles(["editor"])),
      "settings:write",
    );

    expect(denied?.status).toBe(403);
    const body = (await denied!.json()) as { error: { code: string; details?: unknown } };
    expect(body.error.code).toBe("FORBIDDEN");

    const rows = handle.db.select().from(auditEvents).all();
    expect(rows.some((row) => row.action === "authz.denied" && row.result === "denied")).toBe(
      true,
    );
  });
});

describe("读取：库内配置优先，否则沿用 .env", () => {
  it("没有库内行时按 .env 推导，密钥只回掩码", () => {
    const view = getLlmSettings(handle.db, { envPath });

    expect(view.provider).toBe("ollama");
    expect(view.baseUrl).toBe("http://127.0.0.1:11434");
    expect(view.model).toBe("deepseek-r1:7b");
    expect(view.timeoutMs).toBe(300_000);
    expect(view.hasKey).toBe(false); // ollama 的占位 key 不算「已配置」
    expect(view.keyMasked).toBeNull();
    expect(view.appliedToLightrag).toBe(true);
    expect(view.updatedAt).toBeNull();
  });

  it(".env 缺失时回落到内置默认（本机 Ollama）", () => {
    rmSync(envPath);
    const view = getLlmSettings(handle.db, { envPath });

    expect(view.provider).toBe(DEFAULT_LLM_CONFIG.provider);
    expect(view.model).toBe(DEFAULT_LLM_CONFIG.model);
    expect(view.appliedToLightrag).toBe(false);
  });

  it("外部供应商的 .env 也能推导（DeepSeek）", () => {
    writeFileSync(
      envPath,
      ENV_FIXTURE.replace("LLM_BINDING=ollama", "LLM_BINDING=openai")
        .replace("http://127.0.0.1:11434", "https://api.deepseek.com")
        .replace("LLM_MODEL=deepseek-r1:7b", "LLM_MODEL=deepseek-chat")
        .replace("LLM_BINDING_API_KEY=ollama", "LLM_BINDING_API_KEY=sk-1234567890abcdef"),
      "utf8",
    );

    const view = getLlmSettings(handle.db, { envPath });
    expect(view.provider).toBe("deepseek");
    expect(view.hasKey).toBe(true);
    expect(view.keyMasked).toBe("sk-…cdef");
    expect(view.keyMasked).not.toContain("1234567890");
  });
});

describe("保存：整段加密落库，审计不含密钥", () => {
  it("保存后返回掩码，库里是密文，审计只有元数据", () => {
    const view = updateLlmSettings(
      handle.db,
      actor("u-owner"),
      {
        provider: "deepseek",
        baseUrl: "https://api.deepseek.com/v1",
        model: "deepseek-chat",
        timeoutMs: 120_000,
        apiKey: "sk-1234567890abcdef",
      },
      { envPath, secret: SECRET },
    );

    expect(view.provider).toBe("deepseek");
    expect(view.baseUrl).toBe("https://api.deepseek.com/v1");
    expect(view.hasKey).toBe(true);
    expect(view.keyMasked).toBe("sk-…cdef");
    expect(view.updatedAt).not.toBeNull();
    // 尚未写 .env，所以不算已应用。
    expect(view.appliedToLightrag).toBe(false);

    const raw = handle.sqlite
      .prepare("select value_encrypted from settings where key = 'llm'")
      .get() as { value_encrypted: string };
    expect(raw.value_encrypted.startsWith("v1.")).toBe(true);
    expect(raw.value_encrypted).not.toContain("sk-1234567890abcdef");
    expect(raw.value_encrypted).not.toContain("deepseek-chat");

    const audit = handle.db.select().from(auditEvents).all();
    expect(audit).toHaveLength(1);
    expect(audit[0].action).toBe("settings.llm.update");
    expect(audit[0].result).toBe("ok");
    expect(audit[0].detail).not.toContain("sk-1234567890abcdef");
    expect(audit[0].detail).toContain("keyChanged");

    // 再读一次：解密后再掩码，明文不出服务端。
    const reread = getLlmSettings(handle.db, { envPath, secret: SECRET });
    expect(reread.model).toBe("deepseek-chat");
    expect(reread.keyMasked).toBe("sk-…cdef");
  });

  it("不带 apiKey 字段时保留原密钥；空串对非 ollama 报错", () => {
    updateLlmSettings(
      handle.db,
      actor("u"),
      {
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-4o-mini",
        timeoutMs: 60_000,
        apiKey: "sk-openai-1234567890",
      },
      { envPath, secret: SECRET },
    );

    const kept = updateLlmSettings(
      handle.db,
      actor("u"),
      {
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-4o-mini",
        timeoutMs: 90_000,
      },
      { envPath, secret: SECRET },
    );
    expect(kept.hasKey).toBe(true);
    expect(kept.keyMasked).toBe("sk-…7890");

    const audit = handle.db.select().from(auditEvents).all();
    const last = audit.at(-1)!;
    expect(JSON.parse(last.detail!).keyChanged).toBe(false);

    expect(() =>
      updateLlmSettings(
        handle.db,
        actor("u"),
        {
          provider: "openai",
          baseUrl: "https://api.openai.com/v1",
          model: "gpt-4o-mini",
          timeoutMs: 90_000,
          apiKey: "",
        },
        { envPath, secret: SECRET },
      ),
    ).toThrowError(ValidationError);
  });

  it("本机 Ollama 允许空密钥", () => {
    const view = updateLlmSettings(
      handle.db,
      actor("u"),
      {
        provider: "ollama",
        baseUrl: "http://127.0.0.1:11434",
        model: "qwen2.5:7b",
        timeoutMs: 300_000,
        apiKey: "",
      },
      { envPath, secret: SECRET },
    );

    expect(view.hasKey).toBe(false);
    expect(view.keyMasked).toBeNull();
  });

  it("缺少 SETTINGS_ENC_KEY 时明确报错，不静默降级", () => {
    const previous = process.env.SETTINGS_ENC_KEY;
    delete process.env.SETTINGS_ENC_KEY;

    try {
      expect(() =>
        updateLlmSettings(handle.db, actor("u"), {
          provider: "ollama",
          baseUrl: "http://127.0.0.1:11434",
          model: "m",
          timeoutMs: 60_000,
        }, { envPath }),
      ).toThrowError(/SETTINGS_ENC_KEY/);
    } finally {
      if (previous !== undefined) process.env.SETTINGS_ENC_KEY = previous;
    }
  });
});

describe("校验边界", () => {
  it("远程 http 拒绝，本机 http 与任意 https 允许", () => {
    expect(normalizeBaseUrl("http://127.0.0.1:11434")).toBe("http://127.0.0.1:11434");
    expect(normalizeBaseUrl("http://localhost:8000/v1/")).toBe("http://localhost:8000/v1");
    expect(normalizeBaseUrl("https://api.deepseek.com/")).toBe("https://api.deepseek.com");

    expect(() => normalizeBaseUrl("http://api.deepseek.com")).toThrowError(ValidationError);
    expect(() => normalizeBaseUrl("ftp://example.com")).toThrowError(ValidationError);
    expect(() => normalizeBaseUrl("https://user:pass@example.com")).toThrowError(
      ValidationError,
    );
    expect(() => normalizeBaseUrl("https://example.com?key=1")).toThrowError(ValidationError);
    expect(() => normalizeBaseUrl("")).toThrowError(ValidationError);
  });

  it("模型名非空、超时不越界", () => {
    const base = {
      provider: "openai" as const,
      baseUrl: "https://example.com",
      model: "gpt-4o-mini",
      timeoutMs: 60_000,
      apiKey: "sk-123456",
    };

    expect(normalizeLlmConfig(base).model).toBe("gpt-4o-mini");
    expect(() => normalizeLlmConfig({ ...base, model: "   " })).toThrowError(ValidationError);
    expect(() =>
      normalizeLlmConfig({ ...base, timeoutMs: LLM_TIMEOUT_MIN_MS - 1 }),
    ).toThrowError(ValidationError);
    expect(() =>
      normalizeLlmConfig({ ...base, timeoutMs: LLM_TIMEOUT_MAX_MS + 1 }),
    ).toThrowError(ValidationError);
    expect(() => normalizeLlmConfig({ ...base, provider: "ghost" })).toThrowError(
      ValidationError,
    );
    expect(() => normalizeLlmConfig({ ...base, timeoutMs: 60.5 })).toThrowError(ValidationError);
  });
});

describe(".env 生成与已应用判定", () => {
  it("只改 LLM_* 五个键，其余行原样保留", () => {
    const output = renderLightragEnv(ENV_FIXTURE, {
      provider: "deepseek",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-chat",
      timeoutMs: 120_000,
      apiKey: "sk-abcdef123456",
    });

    expect(output).toContain("LLM_BINDING=openai");
    expect(output).toContain("LLM_MODEL=deepseek-chat");
    expect(output).toContain("LLM_BINDING_HOST=https://api.deepseek.com");
    expect(output).toContain("LLM_BINDING_API_KEY=sk-abcdef123456");
    expect(output).toContain("LLM_TIMEOUT=120");
    expect(output).toContain("EMBEDDING_BINDING_HOST=http://127.0.0.1:9381/v1");
    expect(output).toContain("LIGHTRAG_API_KEY=local-secret");
    expect(output).toContain("# 本机 LightRAG 配置");
    expect(output.endsWith("\n")).toBe(true);
  });

  it("ollama 写占位 key；缺失键追加到文件末尾", () => {
    const original = "# 只有注释\nHOST=127.0.0.1\n";
    const output = renderLightragEnv(original, {
      provider: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      model: "deepseek-r1:7b",
      timeoutMs: 300_000,
      apiKey: "",
    });

    expect(output).toContain("LLM_BINDING=ollama");
    expect(output).toContain("LLM_BINDING_API_KEY=ollama");
    expect(output).toContain("HOST=127.0.0.1");
    expect(output.indexOf("LLM_TIMEOUT=300")).toBeGreaterThan(output.indexOf("HOST=127.0.0.1"));
  });

  it("换行风格保持不变（CRLF）", () => {
    const output = renderLightragEnv("A=1\r\nLLM_BINDING=ollama\r\n", {
      provider: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      model: "m",
      timeoutMs: 60_000,
      apiKey: "",
    });
    expect(output).toContain("\r\n");
    expect(output.split("\n").every((line) => line === "" || line.endsWith("\r"))).toBe(true);
  });

  it("解析 .env：注释、引号、空行都正确", () => {
    const values = parseEnvFile(
      "# c\nA=1\nB=\"quoted value\"\nC='single'\n\nD=\n",
    );
    expect(values).toEqual({ A: "1", B: "quoted value", C: "single", D: "" });
  });

  it("写回后 isAppliedToLightrag 为真", () => {
    const config = {
      provider: "deepseek" as const,
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-chat",
      timeoutMs: 120_000,
      apiKey: "sk-abcdef123456",
    };

    expect(isAppliedToLightrag(config, envPath)).toBe(false);
    writeFileSync(envPath, renderLightragEnv(ENV_FIXTURE, config), "utf8");
    expect(isAppliedToLightrag(config, envPath)).toBe(true);
    expect(readEnvConfig(envPath)?.model).toBe("deepseek-chat");
  });
});

describe("测试连接", () => {
  function fakeFetch(
    respond: (url: string, init: RequestInit) => Response | Promise<Response>,
  ): { fetchImpl: typeof fetch; calls: { url: string; init: RequestInit }[] } {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init: init ?? {} });
      return respond(url, init ?? {});
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  }

  it("向 /chat/completions 发最小请求，返回 ok 与延迟", async () => {
    const { fetchImpl, calls } = fakeFetch(
      () =>
        new Response(JSON.stringify({ choices: [{ message: { content: "pong" } }] }), {
          status: 200,
        }),
    );

    const result = await testLlmConnection(
      handle.db,
      {
        provider: "deepseek",
        baseUrl: "https://api.deepseek.com",
        model: "deepseek-chat",
        timeoutMs: 30_000,
        apiKey: "sk-1234567890abcdef",
      },
      { envPath, secret: SECRET, fetchImpl },
    );

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.deepseek.com/chat/completions");
    const body = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>;
    expect(body.max_tokens).toBe(8);
    expect(body.stream).toBe(false);
    expect(body.model).toBe("deepseek-chat");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(
      "Bearer sk-1234567890abcdef",
    );
  });

  it("401 给出可读原因，且回显里的密钥被掩码", async () => {
    const key = "sk-1234567890abcdef";
    const { fetchImpl } = fakeFetch(
      () => new Response(`Incorrect API key provided: ${key}`, { status: 401 }),
    );

    const result = await testLlmConnection(
      handle.db,
      { provider: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", apiKey: key },
      { envPath, secret: SECRET, fetchImpl },
    );

    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect(result.error ?? "").toContain("鉴权失败");
    expect(result.error ?? "").not.toContain(key);
    expect(result.error ?? "").toContain("sk-…cdef");
  });

  it("网络错误 / 超时收敛成 ok:false，不抛 500", async () => {
    const { fetchImpl } = fakeFetch(() => {
      const error = new Error("The operation was aborted");
      error.name = "TimeoutError";
      throw error;
    });

    const result = await testLlmConnection(
      handle.db,
      {
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        model: "gpt-4o-mini",
        apiKey: "sk-1234567890abcdef",
      },
      { envPath, secret: SECRET, fetchImpl },
    );

    expect(result.ok).toBe(false);
    expect(result.status).toBeNull();
    expect(result.error).toBe("请求超时");
  });

  it("未填密钥时测试直接给 ValidationError", async () => {
    await expect(
      testLlmConnection(
        handle.db,
        { provider: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini", apiKey: "" },
        { envPath, secret: SECRET, fetchImpl: (() => {}) as unknown as typeof fetch },
      ),
    ).rejects.toThrowError(ValidationError);
  });

  it("本机 Ollama 无密钥也能测试，且不发 Authorization", async () => {
    const { fetchImpl, calls } = fakeFetch(
      () => new Response(JSON.stringify({ choices: [{ message: { content: "pong" } }] }), {
        status: 200,
      }),
    );

    const result = await testLlmConnection(
      handle.db,
      {
        provider: "ollama",
        baseUrl: "http://127.0.0.1:11434/v1",
        model: "deepseek-r1:7b",
        timeoutMs: 30_000,
        apiKey: "",
      },
      { envPath, secret: SECRET, fetchImpl },
    );

    expect(result.ok).toBe(true);
    expect(calls[0].url).toBe("http://127.0.0.1:11434/v1/chat/completions");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBeUndefined();
  });
});
