import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { DomainError } from "../../src/domain/errors";
import type {
  LightragDeleteResult,
  LightragDocumentPage,
  LightragSubgraph,
} from "../../src/server/adapters/lightrag";
import { openDatabase, type DatabaseHandle } from "../../src/server/db/client";
import { SqliteObjectRepository } from "../../src/server/repositories/sqlite-object-repository";
import {
  GRAPH_ENTITY_DOCUMENTS_LIMIT,
  listEntityDocuments,
  queryGraph,
  splitGraphFileSources,
  type GraphGateway,
} from "../../src/server/services/graph-service";
import type { GraphAnswerRequest } from "../../src/server/services/graph-answer-service";
import type { LlmConfig } from "../../src/server/services/llm-settings-service";

/**
 * 图谱问答的检索/归属边界，以及实体「相关文档」的取数规则：
 * LightRAG 只给上下文、答案来自绑定模型；引用与文档一律按当前账号过滤。
 */

const OWNER = "user_graph_owner";
const OTHER = "user_graph_other";

const LLM: LlmConfig = {
  provider: "deepseek",
  baseUrl: "https://api.deepseek.com/v1",
  model: "deepseek-chat",
  timeoutMs: 120_000,
  apiKey: "sk-unit-test",
};

let handle: DatabaseHandle;
let repo: SqliteObjectRepository;

class FakeGateway implements GraphGateway {
  queryCalls: Array<{ query: string; mode?: string; onlyNeedContext?: boolean }> = [];
  answer: {
    response: string;
    references: Array<{ referenceId: string; filePath: string }>;
    llmGenerated?: boolean;
  } = { response: "", references: [] };
  subgraph: LightragSubgraph = { nodes: [], edges: [] };

  async insertText(): Promise<void> {}

  async listDocuments(): Promise<LightragDocumentPage> {
    return { documents: [], total: 0 };
  }

  async deleteDocuments(): Promise<LightragDeleteResult> {
    return { status: "unknown", message: "" };
  }

  async query(input: {
    query: string;
    mode?: string;
    onlyNeedContext?: boolean;
  }): Promise<{
    response: string;
    references: Array<{ referenceId: string; filePath: string }>;
    llmGenerated?: boolean;
  }> {
    this.queryCalls.push(input);
    return this.answer;
  }

  async listLabels(): Promise<string[]> {
    return [];
  }

  async getSubgraph(): Promise<LightragSubgraph> {
    return this.subgraph;
  }
}

function source(objectId: string, hash = "aaaaaaaaaaaa"): string {
  return `pakp:obj:${objectId}:${hash}`;
}

async function seedAsset(title: string, ownerSub = OWNER) {
  return repo.create({ ownerSub, type: "asset", title, library: "internal" });
}

beforeAll(() => {
  handle = openDatabase({ file: ":memory:" });
});

afterAll(() => {
  handle.close();
});

beforeEach(() => {
  handle.sqlite.exec("DELETE FROM objects;");
  repo = new SqliteObjectRepository(handle.db);
});

describe("splitGraphFileSources", () => {
  it("按 <SEP> 拆开多来源路径，非本系统的路径丢弃", () => {
    expect(splitGraphFileSources(`${source("A", "h1")}<SEP>${source("B", "h2")}`)).toEqual([
      { objectId: "A", hash: "h1" },
      { objectId: "B", hash: "h2" },
    ]);
    expect(splitGraphFileSources(`${source("A")}<SEP>upload.pdf<SEP>${source("B", "h2")}`)).toEqual([
      { objectId: "A", hash: "aaaaaaaaaaaa" },
      { objectId: "B", hash: "h2" },
    ]);
    expect(splitGraphFileSources("")).toEqual([]);
  });
});

describe("queryGraph", () => {
  it("只向 LightRAG 要检索上下文，答案由绑定模型生成并回传 model/provider", async () => {
    const mine = await seedAsset("我的知识库文档");
    const client = new FakeGateway();
    client.answer = {
      response: "实体：X\n关系：…",
      references: [{ referenceId: "1", filePath: source(mine.id) }],
      llmGenerated: false,
    };

    const calls: Array<{ config: LlmConfig; request: GraphAnswerRequest }> = [];
    const result = await queryGraph(handle.db, OWNER, "X 是什么", {
      client,
      llm: LLM,
      generateAnswer: async (config, request) => {
        calls.push({ config, request });
        return { response: "绑定模型写的答案", model: config.model, provider: config.provider };
      },
    });

    expect(client.queryCalls).toEqual([
      { query: "X 是什么", mode: "mix", onlyNeedContext: true },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0].request.context).toBe("实体：X\n关系：…");
    expect(calls[0].request.contextIsSummary).toBe(false);
    expect(result).toEqual({
      question: "X 是什么",
      response: "绑定模型写的答案",
      references: [
        { objectId: mine.id, title: "我的知识库文档", type: "asset", library: "internal" },
      ],
      model: "deepseek-chat",
      provider: "deepseek",
    });
  });

  it("旧版 LightRAG 只能给摘要时，把它作为上下文并标记", async () => {
    const mine = await seedAsset("我的知识库文档");
    const client = new FakeGateway();
    client.answer = {
      response: "摘要：X 是一个工具。",
      references: [{ referenceId: "1", filePath: source(mine.id) }],
      llmGenerated: true,
    };

    const requests: Array<Record<string, unknown>> = [];
    await queryGraph(handle.db, OWNER, "X 是什么", {
      client,
      llm: LLM,
      generateAnswer: async (config, request) => {
        requests.push(request as unknown as Record<string, unknown>);
        return { response: "答案", model: config.model, provider: config.provider };
      },
    });

    expect(requests[0].contextIsSummary).toBe(true);
  });

  it("没有本账号引用时返回空串，且不调用模型", async () => {
    const theirs = await seedAsset("别人的文档", OTHER);
    const client = new FakeGateway();
    client.answer = {
      response: "来自他人内容的情报",
      references: [{ referenceId: "1", filePath: source(theirs.id) }],
    };

    let called = false;
    const result = await queryGraph(handle.db, OWNER, "问题", {
      client,
      llm: LLM,
      generateAnswer: async () => {
        called = true;
        return { response: "不该出现", model: LLM.model, provider: LLM.provider };
      },
    });

    expect(called).toBe(false);
    expect(result.response).toBe("");
    expect(result.references).toEqual([]);
    expect(result.model).toBe(LLM.model);
  });

  it("模型不可用时错误原样上抛（路由统一收敛）", async () => {
    const mine = await seedAsset("我的知识库文档");
    const client = new FakeGateway();
    client.answer = {
      response: "上下文",
      references: [{ referenceId: "1", filePath: source(mine.id) }],
    };

    const error = await queryGraph(handle.db, OWNER, "问题", {
      client,
      llm: LLM,
      generateAnswer: async () => {
        throw new DomainError("INTERNAL", "模型服务未响应，请到「设置 → 大模型」检查");
      },
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).message).toContain("设置 → 大模型");
  });
});

describe("listEntityDocuments", () => {
  function node(id: string, filePath: string) {
    return { id, type: "artifact", description: "", filePath };
  }

  it("按实体自身的多来源路径反查本账号对象，去重并过滤他人内容", async () => {
    const first = await seedAsset("T01 文档");
    const second = await seedAsset("T02 文档");
    const theirs = await seedAsset("T03 文档", OTHER);

    const client = new FakeGateway();
    client.subgraph = {
      nodes: [
        node("向量数据库", `${source(first.id)}<SEP>${source(second.id)}<SEP>${source(theirs.id)}`),
        node("向量数据库", source(first.id, "bbbbbbbbbbbb")),
        node("别的实体", source(theirs.id)),
      ],
      edges: [],
    };

    const result = await listEntityDocuments(handle.db, OWNER, "向量数据库", { client });

    expect(result.documents).toEqual([
      { objectId: first.id, title: "T01 文档", type: "asset", library: "internal" },
      { objectId: second.id, title: "T02 文档", type: "asset", library: "internal" },
    ]);
    expect(result.truncated).toBe(false);
  });

  it("超过 10 条时截断并按标题排序", async () => {
    const created = [];
    for (let index = 1; index <= 12; index += 1) {
      created.push(await seedAsset(`T${String(index).padStart(2, "0")} 文档`));
    }
    // 打乱来源顺序：返回结果必须按标题重排。
    const filePath = [...created]
      .reverse()
      .map((object) => source(object.id))
      .join("<SEP>");

    const client = new FakeGateway();
    client.subgraph = { nodes: [node("大实体", filePath)], edges: [] };

    const result = await listEntityDocuments(handle.db, OWNER, "大实体", { client });

    expect(result.documents).toHaveLength(GRAPH_ENTITY_DOCUMENTS_LIMIT);
    expect(result.truncated).toBe(true);
    expect(result.documents.map((document) => document.title)).toEqual(
      created.slice(0, 10).map((object) => object.title),
    );
  });

  it("来源路径为空时用词法检索兜底", async () => {
    const match = await seedAsset("向量数据库选型笔记");
    await seedAsset("无关文档");

    const client = new FakeGateway();
    client.subgraph = { nodes: [node("向量数据库", "")], edges: [] };

    const result = await listEntityDocuments(handle.db, OWNER, "向量数据库", { client });

    expect(result.documents.map((document) => document.objectId)).toContain(match.id);
    expect(result.truncated).toBe(false);
  });

  it("查不到时返回空数组而不是报错", async () => {
    const client = new FakeGateway();
    client.subgraph = { nodes: [], edges: [] };

    const result = await listEntityDocuments(handle.db, OWNER, "不存在的实体", { client });
    expect(result).toEqual({ documents: [], truncated: false });
  });

  it("实体名称为空或超长时按校验错误处理", async () => {
    const client = new FakeGateway();
    await expect(listEntityDocuments(handle.db, OWNER, "  ", { client })).rejects.toThrow(
      "实体名称不能为空",
    );
    await expect(
      listEntityDocuments(handle.db, OWNER, "长".repeat(101), { client }),
    ).rejects.toThrow("实体名称不能超过 100 个字符");
  });
});
