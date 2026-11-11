RAGFlow 适配层（唯一外部内容入口）。

当前进度：Phase 0 已落地最小客户端 `client.ts`，只覆盖内容同步需要的三个动作：

| 方法 | 调用 |
|---|---|
| `listDatasets(query?)` | `GET /api/v1/datasets` |
| `createDocument(datasetId, { filename, data, mimeType? })` | `POST /api/v1/datasets/{id}/documents`（multipart，字段 `file`） |
| `deleteDocument(datasetId, ids)` | `DELETE /api/v1/datasets/{id}/documents`，body `{ ids }` |

约定：

- 鉴权用 `Authorization: Bearer <token>`，token 来自 RAGFlow `api_token.token`（`ragflow-` 前缀）。
- 业务错误统一抛 `src/domain/errors.ts` 里的错误：404/未找到 → `NotFoundError`，参数错误（code 102）→ `ValidationError`，其余外部/鉴权失败 → `DomainError("INTERNAL")`。
- 客户端不做重试、outbox 与业务映射，那些属于 `src/server/services`。
- 环境变量：`RAGFLOW_BASE_URL`、`RAGFLOW_API_KEY`，可用 `createRagflowClientFromEnv()` 构造。

真实接口契约与实测记录见 `docs/04_INTEGRATION.md`；单测使用 mock fetch，不依赖本地服务。
