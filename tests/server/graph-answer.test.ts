import { describe, expect, it } from "vitest";

import { DomainError } from "../../src/domain/errors";
import {
  GRAPH_ANSWER_SYSTEM_PROMPT,
  chatCompletionsUrl,
  generateGraphAnswer,
  graphAnswerContextBudget,
} from "../../src/server/services/graph-answer-service";
import type { LlmConfig } from "../../src/server/services/llm-settings-service";

/**
 * 图谱问答的生成环节：请求形状（模型、system 提示、超时、密钥只在请求头）、
 * 上下文裁剪、上游失败的中文映射（且不外泄密钥与上游错误体）。
 */

const SECRET = "sk-unit-test-secret-0123456789";

const OLLAMA: LlmConfig = {
  provider: "ollama",
  baseUrl: "http://127.0.0.1:11434",
  model: "deepseek-r1:7b",
  timeoutMs: 300_000,
  apiKey: "",
};

const DEEPSEEK: LlmConfig = {
  provider: "deepseek",
  baseUrl: "https://api.deepseek.com/v1",
  model: "deepseek-chat",
  timeoutMs: 120_000,
  apiKey: SECRET,
};

interface Captured {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
}

function captureFetch(): {
  calls: Captured[];
  fetchImpl: typeof fetch;
} {
  const calls: Captured[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push({ url: String(input), init: init ?? {}, body });
    return Response.json({
      choices: [{ message: { content: "  这是绑定模型写的答案。  " } }],
    });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function replyWith(status: number, payload: unknown): typeof fetch {
  return (async () => new Response(JSON.stringify(payload), { status })) as typeof fetch;
}

describe("请求地址", () => {
  it("Ollama 原生地址补 /v1，其它供应商按保存值直连", () => {
    expect(chatCompletionsUrl(OLLAMA)).toBe("http://127.0.0.1:11434/v1/chat/completions");
    expect(chatCompletionsUrl(DEEPSEEK)).toBe("https://api.deepseek.com/v1/chat/completions");
    expect(
      chatCompletionsUrl({ provider: "ollama", baseUrl: "http://127.0.0.1:11434/v1/" }),
    ).toBe("http://127.0.0.1:11434/v1/chat/completions");
  });
});

describe("请求形状", () => {
  it("带模型、system 约束与问题上下文，密钥只在请求头", async () => {
    const { calls, fetchImpl } = captureFetch();
    const result = await generateGraphAnswer(
      DEEPSEEK,
      { question: "这个实体是什么？", context: "实体描述：一个本地模型网关。" },
      { fetchImpl },
    );

    expect(result).toEqual({
      response: "这是绑定模型写的答案。",
      model: "deepseek-chat",
      provider: "deepseek",
    });

    const [call] = calls;
    expect(call.url).toBe("https://api.deepseek.com/v1/chat/completions");
    expect((call.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${SECRET}`);
    expect(call.body.model).toBe("deepseek-chat");
    expect(call.body.stream).toBe(false);

    const messages = call.body.messages as Array<{ role: string; content: string }>;
    expect(messages[0]).toEqual({ role: "system", content: GRAPH_ANSWER_SYSTEM_PROMPT });
    expect(messages[0].content).toContain("只使用<上下文>里的信息");
    expect(messages[0].content).toContain("不要编造出处");
    expect(messages[1].role).toBe("user");
    expect(messages[1].content).toContain("这个实体是什么？");
    expect(messages[1].content).toContain("一个本地模型网关");

    // 密钥只出现在请求头：请求体里任何一个位置都不该有它。
    expect(JSON.stringify(call.body)).not.toContain(SECRET);
    expect(call.init.signal).toBeInstanceOf(AbortSignal);
  });

  it("Ollama 无密钥时不发 Authorization 头", async () => {
    const { calls, fetchImpl } = captureFetch();
    await generateGraphAnswer(OLLAMA, { question: "问题", context: "上下文" }, { fetchImpl });
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("local 模型上下文按 4000 字裁剪，云端按 12000 字保留", async () => {
    expect(graphAnswerContextBudget("ollama")).toBe(4_000);
    expect(graphAnswerContextBudget("deepseek")).toBe(12_000);

    const longContext = "甲".repeat(5_000);

    const local = captureFetch();
    await generateGraphAnswer(OLLAMA, { question: "问题", context: longContext }, {
      fetchImpl: local.fetchImpl,
    });
    const localPrompt = (local.calls[0].body.messages as Array<{ content: string }>)[1].content;
    expect(localPrompt).toContain("已截断");
    expect(localPrompt.length).toBeLessThan(longContext.length + 200);

    const cloud = captureFetch();
    await generateGraphAnswer(DEEPSEEK, { question: "问题", context: longContext }, {
      fetchImpl: cloud.fetchImpl,
    });
    const cloudPrompt = (cloud.calls[0].body.messages as Array<{ content: string }>)[1].content;
    expect(cloudPrompt).not.toContain("已截断");
    expect(cloudPrompt).toContain(longContext);
  });
});

describe("上游失败映射", () => {
  async function failure(config: LlmConfig, fetchImpl: typeof fetch): Promise<string> {
    const error = await generateGraphAnswer(
      config,
      { question: "问题", context: "上下文" },
      { fetchImpl },
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DomainError);
    return (error as DomainError).message;
  }

  it("401 给鉴权提示，不回传上游错误体与密钥", async () => {
    const message = await failure(
      DEEPSEEK,
      replyWith(401, { error: { message: `Incorrect API key provided: ${SECRET}` } }),
    );
    expect(message).toContain("模型鉴权失败");
    expect(message).toContain("设置 → 大模型");
    expect(message).not.toContain(SECRET);
    expect(message).not.toContain("Incorrect API key");
  });

  it("404 指向地址，429 指向限流，5xx 指向稍后重试", async () => {
    expect(await failure(DEEPSEEK, replyWith(404, {}))).toContain("404");
    expect(await failure(DEEPSEEK, replyWith(429, {}))).toContain("限流");
    expect(await failure(DEEPSEEK, replyWith(503, {}))).toContain("模型服务内部错误");
  });

  it("超时与连接失败给可行动的文案", async () => {
    const timedOut = Object.assign(new Error("The operation was aborted"), {
      name: "TimeoutError",
    });
    const timeoutFetch = (async () => {
      throw timedOut;
    }) as unknown as typeof fetch;
    expect(await failure({ ...DEEPSEEK, timeoutMs: 45_000 }, timeoutFetch)).toContain(
      "45 秒内没有响应",
    );

    const refused = Object.assign(new Error("fetch failed"), {
      cause: { code: "ECONNREFUSED" },
    });
    const refusedFetch = (async () => {
      throw refused;
    }) as unknown as typeof fetch;
    expect(await failure(OLLAMA, refusedFetch)).toContain("没有服务在监听");
  });

  it("模型返回空内容时报「没有返回内容」", async () => {
    const message = await failure(
      DEEPSEEK,
      replyWith(200, { choices: [{ message: { content: "   " } }] }),
    );
    expect(message).toContain("没有返回内容");
  });
});
