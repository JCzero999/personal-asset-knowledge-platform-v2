import { describe, expect, it, vi } from "vitest";

import {
  DomainError,
  NotFoundError,
  ValidationError,
} from "../../../src/domain/errors";
import {
  createRagflowClientFromEnv,
  RagflowClient,
} from "../../../src/server/adapters/ragflow";

const BASE_URL = "http://localhost:9380";
const API_KEY = "ragflow-test-token";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeClient(response: Response | Error) {
  const fetchMock = vi.fn(async () => {
    if (response instanceof Error) {
      throw response;
    }
    return response;
  });
  const client = new RagflowClient({
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    fetch: fetchMock as unknown as typeof fetch,
  });
  return { client, fetchMock };
}

describe("RagflowClient.listDatasets", () => {
  it("按实测契约请求 /api/v1/datasets 并解析字段", async () => {
    const { client, fetchMock } = makeClient(
      jsonResponse({
        code: 0,
        data: [
          {
            id: "ds_1",
            name: "测试库",
            description: "desc",
            embedding_model: "BAAI/bge-large-zh-v1.5@BAAI",
            document_count: 2,
            chunk_count: 7,
            create_date: "2026-11-11 14:00:00",
            update_date: "2026-11-11 14:01:00",
          },
        ],
      }),
    );

    const datasets = await client.listDatasets();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      `${BASE_URL}/api/v1/datasets?page=1&page_size=30&orderby=create_time&desc=true`,
    );
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${API_KEY}`,
    );

    expect(datasets).toEqual([
      {
        id: "ds_1",
        name: "测试库",
        description: "desc",
        embeddingModel: "BAAI/bge-large-zh-v1.5@BAAI",
        documentCount: 2,
        chunkCount: 7,
        createdAt: "2026-11-11 14:00:00",
        updatedAt: "2026-11-11 14:01:00",
      },
    ]);
  });

  it("带 name 过滤时写入查询串", async () => {
    const { client, fetchMock } = makeClient(jsonResponse({ code: 0, data: [] }));

    await client.listDatasets({ name: "abc", page: 2, pageSize: 5 });

    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toContain("name=abc");
    expect(url).toContain("page=2");
    expect(url).toContain("page_size=5");
  });
});

describe("RagflowClient.createDocument", () => {
  it("以 multipart 单次 POST 上传，字段名 file", async () => {
    const { client, fetchMock } = makeClient(
      jsonResponse({
        code: 0,
        data: [
          {
            id: "doc_1",
            name: "note.txt",
            dataset_id: "ds_1",
            chunk_count: 0,
            token_count: 0,
            chunk_method: "naive",
            run: "UNSTART",
          },
        ],
      }),
    );

    const doc = await client.createDocument("ds_1", {
      filename: "note.txt",
      data: new TextEncoder().encode("hello ragflow"),
      mimeType: "text/plain",
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(`${BASE_URL}/api/v1/datasets/ds_1/documents`);
    expect(init.method).toBe("POST");
    expect(init.body).toBeInstanceOf(FormData);

    const file = (init.body as FormData).get("file") as File;
    expect(file.name).toBe("note.txt");
    expect(await file.text()).toBe("hello ragflow");
    // multipart 不应手动设置 Content-Type（需要 boundary）
    expect(
      (init.headers as Record<string, string>)["Content-Type"],
    ).toBeUndefined();

    expect(doc).toEqual({
      id: "doc_1",
      name: "note.txt",
      datasetId: "ds_1",
      chunkCount: 0,
      tokenCount: 0,
      chunkMethod: "naive",
      run: "UNSTART",
    });
  });

  it("datasetId 或内容为空时本地拒绝，不发请求", async () => {
    const { client, fetchMock } = makeClient(jsonResponse({ code: 0, data: [] }));

    await expect(
      client.createDocument("", { filename: "a.txt", data: new Uint8Array([1]) }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      client.createDocument("ds_1", { filename: "a.txt", data: new Uint8Array() }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("RagflowClient.deleteDocument", () => {
  it("按 { ids } 批量删除", async () => {
    const { client, fetchMock } = makeClient(jsonResponse({ code: 0 }));

    await client.deleteDocument("ds_1", ["doc_1", "doc_2"]);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(`${BASE_URL}/api/v1/datasets/ds_1/documents`);
    expect(init.method).toBe("DELETE");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json",
    );
    expect(JSON.parse(init.body as string)).toEqual({
      ids: ["doc_1", "doc_2"],
    });
  });

  it("单个 id 也包装成数组", async () => {
    const { client, fetchMock } = makeClient(jsonResponse({ code: 0 }));

    await client.deleteDocument("ds_1", "doc_1");

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ ids: ["doc_1"] });
  });
});

describe("RagflowClient 错误映射", () => {
  it("HTTP 401 映射为 INTERNAL 并保留状态码", async () => {
    const { client } = makeClient(jsonResponse({ message: "unauthorized" }, 401));

    const error = await client.listDatasets().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe("INTERNAL");
    expect((error as DomainError).details?.status).toBe(401);
  });

  it("HTTP 404 映射为 NotFoundError", async () => {
    const { client } = makeClient(jsonResponse({ message: "missing" }, 404));

    await expect(client.listDatasets()).rejects.toBeInstanceOf(NotFoundError);
  });

  it("业务 code=102 映射为 ValidationError", async () => {
    const { client } = makeClient(
      jsonResponse({ code: 102, message: "Dataset name is required" }),
    );

    const error = await client.listDatasets().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ValidationError);
    expect((error as DomainError).details?.code).toBe(102);
  });

  it("message 表示未找到时映射为 NotFoundError", async () => {
    const { client } = makeClient(
      jsonResponse({
        code: 102,
        message: "Can't find the dataset with ID ds_x",
      }),
    );

    await expect(client.deleteDocument("ds_x", "doc_1")).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("网络异常映射为 INTERNAL", async () => {
    const { client } = makeClient(new Error("ECONNREFUSED"));

    const error = await client.listDatasets().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe("INTERNAL");
    expect((error as DomainError).details?.cause).toBe("ECONNREFUSED");
  });

  it("非 JSON 响应映射为 INTERNAL", async () => {
    const { client } = makeClient(new Response("<html>bad gateway</html>", { status: 200 }));

    const error = await client.listDatasets().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe("INTERNAL");
  });
});

describe("客户端构造", () => {
  it("缺失 baseUrl / apiKey 时抛 ValidationError", () => {
    expect(() => new RagflowClient({ baseUrl: "", apiKey: API_KEY })).toThrow(
      ValidationError,
    );
    expect(() => new RagflowClient({ baseUrl: BASE_URL, apiKey: " " })).toThrow(
      ValidationError,
    );
  });

  it("baseUrl 末尾斜杠会被去掉", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ code: 0, data: [] }));
    const client = new RagflowClient({
      baseUrl: `${BASE_URL}/`,
      apiKey: API_KEY,
      fetch: fetchMock as unknown as typeof fetch,
    });

    await client.listDatasets();

    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url.startsWith(`${BASE_URL}/api/v1/datasets`)).toBe(true);
  });

  it("createRagflowClientFromEnv 缺配置时报错，齐全时可构造", () => {
    expect(() => createRagflowClientFromEnv({})).toThrow(DomainError);

    const client = createRagflowClientFromEnv({
      RAGFLOW_BASE_URL: BASE_URL,
      RAGFLOW_API_KEY: API_KEY,
    });
    expect(client).toBeInstanceOf(RagflowClient);
  });
});
