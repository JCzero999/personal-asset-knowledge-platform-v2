import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { openDatabase, type DatabaseHandle } from "../../src/server/db/client";
import { settings } from "../../src/server/db/schema";
import { encryptSecret } from "../../src/server/security/secret-box";
import {
  MODEL_PROBE_TTL_MS,
  createModelProbeCache,
  probeModelEndpoint,
  resolveModelProbeConfig,
  type ModelProbeConfig,
  type ModelProbeFetch,
} from "../../src/server/services/model-endpoint-probe";

/**
 * 模型端点探测（图谱失败诊断的取证旁路）：
 * 全部用注入的 fetch，不打真实网络，也不碰真实的 .env / 数据库文件。
 */

const CONFIG: ModelProbeConfig = {
  provider: "openai",
  baseUrl: "https://api.example.com/v1",
  apiKey: "sk-test-SECRET-9876",
};

function fixedClock(start = 1_700_000_000_000) {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

function connectionRefused(): Error {
  const error = new TypeError("fetch failed");
  (error as { cause?: unknown }).cause = { code: "ECONNREFUSED" };
  return error;
}

let handle: DatabaseHandle;
let envKeys: string[] = [];

beforeAll(() => {
  handle = openDatabase({ file: ":memory:" });
  // 测试进程里若本来就带 LLM_* 变量，会干扰「回退到 .env」的断言，先摘掉再还原。
  envKeys = ["LLM_BINDING", "LLM_BINDING_HOST", "LLM_MODEL", "LLM_BINDING_API_KEY", "LLM_TIMEOUT"];
  for (const key of envKeys) delete process.env[key];
});

afterAll(() => {
  handle.close();
});

describe("probeModelEndpoint 结论", () => {
  it("2xx：可连接但仍要去查引擎日志", async () => {
    const status = await probeModelEndpoint(null, {
      config: CONFIG,
      cache: null,
      fetch: async () => ({ status: 200 }),
    });

    expect(status.ok).toBe(true);
    expect(status.message).toContain("可连接");
    expect(status.message).toContain("抽取仍然失败");
    expect(status.message).toContain("api.example.com");
    expect(status.latencyMs).toBeGreaterThanOrEqual(0);
    expect(Number.isNaN(Date.parse(status.checkedAt))).toBe(false);
  });

  it("连接被拒绝：点名 host，并说清本机 / 云端各查什么", async () => {
    const status = await probeModelEndpoint(null, {
      config: { provider: "ollama", baseUrl: "http://127.0.0.1:11434", apiKey: "" },
      cache: null,
      fetch: async () => {
        throw connectionRefused();
      },
    });

    expect(status.ok).toBe(false);
    expect(status.message).toContain("不可达");
    expect(status.message).toContain("连接被拒绝");
    expect(status.message).toContain("127.0.0.1:11434");
    expect(status.message).toContain("ollama serve");
  });

  it("超时（TimeoutError / AbortError）归成「探测超时」", async () => {
    const timeout = new Error("timed out");
    timeout.name = "TimeoutError";

    const status = await probeModelEndpoint(null, {
      config: CONFIG,
      cache: null,
      timeoutMs: 3_000,
      fetch: async () => {
        throw timeout;
      },
    });

    expect(status.ok).toBe(false);
    expect(status.message).toContain("探测超时");
    expect(status.message).toContain("3 秒");
  });

  it("401 / 403：指向「系统 → 大模型」检查 Key", async () => {
    const status = await probeModelEndpoint(null, {
      config: CONFIG,
      cache: null,
      fetch: async () => ({ status: 401 }),
    });

    expect(status.ok).toBe(false);
    expect(status.message).toContain("鉴权失败");
    expect(status.message).toContain("401");
    expect(status.message).toContain("系统 → 大模型");
  });

  it("404：提示 baseUrl 可能缺少 /v1", async () => {
    const status = await probeModelEndpoint(null, {
      config: CONFIG,
      cache: null,
      fetch: async () => ({ status: 404 }),
    });

    expect(status.message).toContain("404");
    expect(status.message).toContain("/v1");
  });

  it("没有 baseUrl 时不下结论（ok: null），并给出下一步", async () => {
    let calls = 0;
    const status = await probeModelEndpoint(null, {
      config: { provider: "openai", baseUrl: "  ", apiKey: "" },
      cache: null,
      fetch: async () => {
        calls += 1;
        return { status: 200 };
      },
    });

    expect(calls).toBe(0);
    expect(status.ok).toBeNull();
    expect(status.message).toContain("系统 → 大模型");
  });
});

describe("probeModelEndpoint 请求形态", () => {
  it("OpenAI 兼容：GET {baseUrl}/models，Key 只进 Authorization 头", async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];

    const status = await probeModelEndpoint(null, {
      config: { ...CONFIG, baseUrl: "https://api.example.com/v1///" },
      cache: null,
      fetch: async (url, init) => {
        seen.push({ url, headers: init.headers });
        return { status: 200 };
      },
    });

    expect(seen[0].url).toBe("https://api.example.com/v1/models");
    expect(seen[0].headers.authorization).toBe(`Bearer ${CONFIG.apiKey}`);
    expect(JSON.stringify(status)).not.toContain(CONFIG.apiKey);
    expect(JSON.stringify(status)).not.toContain("SECRET-9876");
  });

  it("Ollama 原生：GET /api/tags，占位 Key 不带 Authorization", async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];

    await probeModelEndpoint(null, {
      config: { provider: "ollama", baseUrl: "http://127.0.0.1:11434", apiKey: "ollama" },
      cache: null,
      fetch: async (url, init) => {
        seen.push({ url, headers: init.headers });
        return { status: 200 };
      },
    });

    expect(seen[0].url).toBe("http://127.0.0.1:11434/api/tags");
    expect(seen[0].headers.authorization).toBeUndefined();
  });

  it("baseUrl 里带 user:pass@ 时，message 只出现 host，不出现凭据", async () => {
    const status = await probeModelEndpoint(null, {
      config: { provider: "custom", baseUrl: "https://user:pa55@api.example.com/v1", apiKey: "" },
      cache: null,
      fetch: async () => {
        throw connectionRefused();
      },
    });

    expect(status.message).toContain("api.example.com");
    expect(status.message).not.toContain("pa55");
  });
});

describe("probeModelEndpoint 缓存", () => {
  it("30 秒内复用结论，过期后重新探测", async () => {
    const clock = fixedClock();
    const cache = createModelProbeCache();
    let calls = 0;
    const fetchStub: ModelProbeFetch = async () => {
      calls += 1;
      return { status: 200 };
    };

    const options = { config: CONFIG, cache, fetch: fetchStub, now: clock.now };

    const first = await probeModelEndpoint(null, options);
    clock.advance(10_000);
    const second = await probeModelEndpoint(null, options);
    expect(calls).toBe(1);
    expect(second.checkedAt).toBe(first.checkedAt);

    clock.advance(MODEL_PROBE_TTL_MS);
    await probeModelEndpoint(null, options);
    expect(calls).toBe(2);
  });

  it("cache: null 时每次都探测", async () => {
    let calls = 0;
    const options = {
      config: CONFIG,
      cache: null,
      fetch: (async () => {
        calls += 1;
        return { status: 200 };
      }) as ModelProbeFetch,
    };

    await probeModelEndpoint(null, options);
    await probeModelEndpoint(null, options);
    expect(calls).toBe(2);
  });

  it("换了 API Key 不会命中旧结论", async () => {
    const cache = createModelProbeCache();
    let calls = 0;
    const fetchStub: ModelProbeFetch = async () => {
      calls += 1;
      return { status: 200 };
    };

    await probeModelEndpoint(null, { config: CONFIG, cache, fetch: fetchStub });
    await probeModelEndpoint(null, {
      config: { ...CONFIG, apiKey: "sk-test-another-key" },
      cache,
      fetch: fetchStub,
    });

    expect(calls).toBe(2);
  });
});

describe("resolveModelProbeConfig 优先级", () => {
  it("库内配置优先于环境变量", async () => {
    const secret = "test-settings-secret";
    const stored = {
      provider: "qwen",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      model: "qwen-plus",
      timeoutMs: 120_000,
      apiKey: "sk-qwen-stored",
    };
    handle.db
      .insert(settings)
      .values({
        key: "llm",
        valueEncrypted: encryptSecret(JSON.stringify(stored), secret),
        updatedAt: new Date().toISOString(),
        updatedBy: "user_test",
      })
      .run();

    const resolved = resolveModelProbeConfig(handle.db, {
      secret,
      env: { LLM_BINDING: "ollama", LLM_BINDING_HOST: "http://127.0.0.1:11434" },
    });

    expect(resolved.provider).toBe("qwen");
    expect(resolved.baseUrl).toBe(stored.baseUrl);
    expect(resolved.apiKey).toBe("sk-qwen-stored");
  });

  it("没有库内配置时读 LLM_* 环境变量", () => {
    const resolved = resolveModelProbeConfig(null, {
      env: {
        LLM_BINDING: "openai",
        LLM_BINDING_HOST: "https://api.deepseek.com/v1",
        LLM_MODEL: "deepseek-chat",
        LLM_BINDING_API_KEY: "sk-env-key",
      },
    });

    expect(resolved.provider).toBe("deepseek");
    expect(resolved.baseUrl).toBe("https://api.deepseek.com/v1");
    expect(resolved.apiKey).toBe("sk-env-key");
  });

  it("库内配置损坏（密钥不对）时退回环境，不抛错", () => {
    const secret = "broken-secret";
    handle.db
      .update(settings)
      .set({ valueEncrypted: encryptSecret(JSON.stringify({ provider: "openai" }), secret) })
      .run();

    const resolved = resolveModelProbeConfig(handle.db, {
      secret: "另一个-secret",
      env: { LLM_BINDING: "ollama", LLM_BINDING_HOST: "http://127.0.0.1:11434" },
    });

    expect(resolved.baseUrl).toBe("http://127.0.0.1:11434");
  });
});
