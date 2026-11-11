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
      progressMessage: null,
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

describe("RagflowClient.listDocuments / startParsing", () => {
  it("列表响应是 { docs, total }，解析 run 与 progress_msg", async () => {
    const { client, fetchMock } = makeClient(
      jsonResponse({
        code: 0,
        data: {
          total: 2,
          docs: [
            {
              id: "doc_1",
              name: "a.txt",
              dataset_id: "ds_1",
              chunk_count: 3,
              token_count: 20,
              chunk_method: "naive",
              run: "DONE",
              progress_msg: "\nDone.",
            },
            { id: "doc_2", run: "FAIL", progress_msg: "parse failed\n" },
          ],
        },
      }),
    );

    const page = await client.listDocuments("ds_1", { page: 2, pageSize: 50 });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      `${BASE_URL}/api/v1/datasets/ds_1/documents?page=2&page_size=50`,
    );
    expect(init.method).toBe("GET");
    expect(page.total).toBe(2);
    expect(page.documents).toEqual([
      {
        id: "doc_1",
        name: "a.txt",
        datasetId: "ds_1",
        chunkCount: 3,
        tokenCount: 20,
        chunkMethod: "naive",
        run: "DONE",
        progressMessage: "Done.",
      },
      {
        id: "doc_2",
        name: "",
        datasetId: "ds_1",
        chunkCount: 0,
        tokenCount: 0,
        chunkMethod: "",
        run: "FAIL",
        progressMessage: "parse failed",
      },
    ]);
  });

  it("触发解析按 { document_ids } POST chunks 接口", async () => {
    const { client, fetchMock } = makeClient(jsonResponse({ code: 0 }));

    await client.startParsing("ds_1", ["doc_1", "doc_2"]);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/api/v1/datasets/ds_1/chunks`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      document_ids: ["doc_1", "doc_2"],
    });
  });

  it("datasetId 或 documentIds 为空时本地拒绝", async () => {
    const { client, fetchMock } = makeClient(jsonResponse({ code: 0 }));

    await expect(client.listDocuments("")).rejects.toBeInstanceOf(ValidationError);
    await expect(client.startParsing("ds_1", [])).rejects.toBeInstanceOf(ValidationError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("RagflowClient.downloadDocument", () => {
  it("透传文件流与响应头，不当作 JSON 解析", async () => {
    const { client, fetchMock } = makeClient(
      new Response("hello ragflow", {
        status: 200,
        headers: {
          "content-type": "application/octet-stream",
          "content-length": "13",
          "content-disposition": "attachment; filename=note.txt",
        },
      }),
    );

    const file = await client.downloadDocument("ds_1", "doc_1");

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/api/v1/datasets/ds_1/documents/doc_1`);
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${API_KEY}`);
    expect(file).toMatchObject({
      contentType: "application/octet-stream",
      contentLength: 13,
      filename: "note.txt",
    });
    expect(await new Response(file.body).text()).toBe("hello ragflow");
  });

  it("文档不存在时抛 NotFoundError", async () => {
    const { client } = makeClient(
      jsonResponse({ code: 100, message: "Document not found" }, 404),
    );

    await expect(client.downloadDocument("ds_1", "doc_missing")).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });
});

describe("RagflowClient.retrieve", () => {
  it("按实测契约 POST /api/v1/retrieval 并解析 chunk 字段", async () => {
    const { client, fetchMock } = makeClient(
      jsonResponse({
        code: 0,
        data: {
          total: 1,
          chunks: [
            {
              id: "chunk_1",
              content: "Copper Lantern",
              highlight: "<em>Copper</em> Lantern",
              document_id: "doc_1",
              document_keyword: "note.txt",
              dataset_id: "ds_1",
              similarity: 0.8,
              term_similarity: 0.5,
              vector_similarity: 0.7,
            },
          ],
        },
      }),
    );

    const result = await client.retrieve({
      question: "codename",
      datasetIds: ["ds_1"],
      pageSize: 5,
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/api/v1/retrieval`);
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toMatchObject({
      question: "codename",
      dataset_ids: ["ds_1"],
      page_size: 5,
      similarity_threshold: 0.2,
      vector_similarity_weight: 0.3,
      top_k: 1024,
      highlight: true,
    });
    expect(result.total).toBe(1);
    expect(result.chunks).toEqual([
      {
        id: "chunk_1",
        content: "Copper Lantern",
        highlight: "<em>Copper</em> Lantern",
        documentId: "doc_1",
        documentName: "note.txt",
        datasetId: "ds_1",
        similarity: 0.8,
        termSimilarity: 0.5,
        vectorSimilarity: 0.7,
      },
    ]);
  });

  it("空问题或空 dataset 本地拒绝", async () => {
    const { client, fetchMock } = makeClient(jsonResponse({ code: 0 }));

    await expect(
      client.retrieve({ question: "  ", datasetIds: ["ds_1"] }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      client.retrieve({ question: "q", datasetIds: [] }),
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

describe("RagflowClient.createDataset", () => {
  it("POST /api/v1/datasets 传 name/description，解析单个对象", async () => {
    const { client, fetchMock } = makeClient(
      jsonResponse({
        code: 0,
        data: {
          id: "ds_new",
          name: "pakp-content",
          description: "统一内容库",
          embedding_model: "BAAI/bge-large-zh-v1.5@BAAI",
          document_count: 0,
          chunk_count: 0,
          create_date: "2026-11-11 15:00:00",
          update_date: "2026-11-11 15:00:00",
        },
      }),
    );

    const dataset = await client.createDataset({
      name: "pakp-content",
      description: "统一内容库",
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/api/v1/datasets`);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json",
    );
    expect(JSON.parse(init.body as string)).toEqual({
      name: "pakp-content",
      description: "统一内容库",
    });

    expect(dataset).toEqual({
      id: "ds_new",
      name: "pakp-content",
      description: "统一内容库",
      embeddingModel: "BAAI/bge-large-zh-v1.5@BAAI",
      documentCount: 0,
      chunkCount: 0,
      createdAt: "2026-11-11 15:00:00",
      updatedAt: "2026-11-11 15:00:00",
    });
  });

  it("名称缺失或响应结构不对时报错", async () => {
    const { client, fetchMock } = makeClient(jsonResponse({ code: 0, data: {} }));

    await expect(client.createDataset({ name: "  " })).rejects.toBeInstanceOf(
      ValidationError,
    );

    // 响应缺 id：不允许把空 id 落到 content_refs。
    const error = await client.createDataset({ name: "pakp-content" }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe("INTERNAL");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("RagflowClient.updateDocumentMetaFields", () => {
  it("PUT 文档并整体提交 meta_fields", async () => {
    const { client, fetchMock } = makeClient(jsonResponse({ code: 0, data: {} }));

    await client.updateDocumentMetaFields("ds_1", "doc_1", {
      content_key: "obj:01ABC:primary",
      owner_type: "asset",
      owner_id: "01ABC",
      library: "internal",
      archived: "false",
    });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/api/v1/datasets/ds_1/documents/doc_1`);
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({
      meta_fields: {
        content_key: "obj:01ABC:primary",
        owner_type: "asset",
        owner_id: "01ABC",
        library: "internal",
        archived: "false",
      },
    });
  });

  it("路径参数做 URL 编码，缺失参数本地拒绝", async () => {
    const { client, fetchMock } = makeClient(jsonResponse({ code: 0, data: {} }));

    await client.updateDocumentMetaFields("ds/1", "doc 1", { k: "v" });
    const [url] = fetchMock.mock.calls[0] as unknown as [string];
    expect(url).toBe(`${BASE_URL}/api/v1/datasets/ds%2F1/documents/doc%201`);

    await expect(
      client.updateDocumentMetaFields("", "doc_1", { k: "v" }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      client.updateDocumentMetaFields("ds_1", "doc_1", [] as unknown as Record<string, string>),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("RagflowClient.renameDocument", () => {
  it("PUT 文档只提交 name，路径参数做 URL 编码", async () => {
    const { client, fetchMock } = makeClient(jsonResponse({ code: 0, data: {} }));

    await client.renameDocument("ds/1", "doc 1", "知识系统.txt");

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${BASE_URL}/api/v1/datasets/ds%2F1/documents/doc%201`);
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual({ name: "知识系统.txt" });
  });

  it("缺失参数在本地拒绝", async () => {
    const { client, fetchMock } = makeClient(jsonResponse({ code: 0, data: {} }));

    await expect(client.renameDocument("", "doc_1", "a.txt")).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(client.renameDocument("ds_1", "doc_1", "  ")).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
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
