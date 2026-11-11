# 集成细节（RAGFlow / LightRAG / Logto）

> 本文件只记录已确认决策与已实测的集成事实。`待实测` 表示当前没有可填写的真实值；禁止把历史建议端口、规划地址或草案字段写成已可用配置。
>
> 当前环境：本机 Docker 可用（Docker 29.9.2 / Compose v5.6.1）；Logto 1.46.0 与 RAGFlow v0.20.5 已自托管部署并完成连通性 / API 实测；Logto 的浏览器端完整登录仍待人工验证；LightRAG 未部署。

## 填写规则

1. 服务启动并实际访问后，才填写版本、Base URL、端口与控制台地址。
2. 真实 API 调用验证后，才填写接口路径、请求/响应契约与 SDK 用法。
3. 密钥不在本文档记录；只记录经代码验证的环境变量名称。
4. 应用侧设计草案统一放在 `docs/drafts/`，不得视为真实集成事实。

## Logto

- 部署方式：Docker 自托管（ADR-003），编排文件 `infra/logto/docker-compose.yml`
- 当前状态：容器已启动并通过连通性验证（2026-11-11 实测）；管理员账号已创建，应用已配置，应用侧已接入（客户端流程待人工登录验证）

| 字段 | 实测值 |
|---|---|
| 版本 | 1.46.0（镜像 label `org.opencontainers.image.version`，容器内 `@logto/core` package.json 一致） |
| 镜像 tag | `svhd/logto:1.46.0`；数据库 `postgres:14-alpine` |
| 容器名 | `logto`、`logto-postgres`（compose project `logto`，均 `Up (healthy)`） |
| 服务端口 | 3001（容器 3001→宿主 3001）；控制台 3002（容器 3002→宿主 3002） |
| Base URL | `http://localhost:3001`（`ENDPOINT`） |
| 控制台地址 | `http://localhost:3002/console`；未初始化时 302 → `http://localhost:3002/console/welcome`（Create account 页面） |
| 健康检查接口 | `GET /api/status` → 204 |
| 验证结果 | `curl -o /dev/null -w '%{http_code}' http://localhost:3001` → 302（Location `/unknown-session`，无会话时的正常跳转）；`http://localhost:3002` → 302（`/console/welcome`）；`/oidc/.well-known/openid-configuration` 返回正常 JSON |
| 已验证环境变量名 | 服务端（compose 传入）：`DB_URL`、`ENDPOINT`、`ADMIN_ENDPOINT`、`TRUST_PROXY_HEADER`；编排层：`POSTGRES_USER`、`POSTGRES_PASSWORD`、`POSTGRES_DB`、`LOGTO_VERSION`、`LOGTO_PORT`、`LOGTO_ADMIN_PORT`（真实密码仅存在于 `infra/logto/.env`，不入库） |
| 应用类型 / 应用 ID | 传统 Web 应用（Next.js App Router 指南创建），应用名「个人资产与知识平台」，App ID `9nyn3ox0u36w37qu2adab` |
| OIDC 回调地址 | 登录回调 `http://localhost:3000/api/logto/sign-in-callback`；登出后回跳 `http://localhost:3000/`（控制台已保存） |
| Next.js 接入方式 | `@logto/next` 4.2.11 的 server-actions：`signIn` / `handleSignIn` / `getLogtoContext` / `signOut` |
| 应用侧路由 | `GET /api/logto/sign-in`（发起登录）、`GET /api/logto/sign-in-callback`（换码后进 `/workspace`）、`GET /api/logto/sign-out`（清会话并回首页） |
| 应用侧环境变量名 | `AUTH_MODE=logto`、`APP_URL`、`LOGTO_ENDPOINT`、`LOGTO_APP_ID`、`LOGTO_APP_SECRET`、`LOGTO_COOKIE_SECRET`；真实值只写 `.env.local`（已 gitignore），本文档不记录 |
| 登录 / 注册 / 会话验证结果 | `GET /api/logto/sign-in` → 307，`redirect_uri` 为已保存的回调地址；该 authorize URL 被 Logto 接受（303 → `/unknown-session`，非 `invalid_redirect_uri`）。浏览器内完整登录与回调换码待人工完成一次后补记 |

**部署要点（实测）**：镜像只 `EXPOSE 3001`，但进程同时监听 3002（`ADMIN_PORT` 默认值）；控制台挂在 `ADMIN_ENDPOINT` 的 `/console` 路径下。默认 entrypoint 只跑 `npm start`，而启动时会校验数据库已 seed 且业务表已启用 RLS，因此 compose 中把入口覆盖为 `npm run cli db seed -- --swe && npm start`，`--swe` 保证已初始化时跳过、可重复执行。

**待人工完成**：浏览器打开 `http://localhost:3000`，点「登录」用 Logto 账号完成一次登录；成功后 `requireSession()` 应放行 `/workspace`，记录写入的 `ownerSub` 为 Logto 用户 `sub`。

## RAGFlow

- 部署方式：本地 Docker Compose（`infra/ragflow/docker-compose.yml`，基于官方 v0.20.5 编排精简，只保留 elasticsearch 文档引擎）
- 内容职责：统一内容存储、解析、分块、向量化与检索（ADR-005）
- 当前状态：已部署并通过 API 实测（2026-11-11）；内容上传、meta 同步、解析、检索与下载已端到端跑通；归档后检索返回 0 条。失败重试路径只有假网关单测
- 应用侧适配器：`src/server/adapters/ragflow/client.ts`（`listDatasets` / `createDataset` / `createDocument` / `updateDocumentMetaFields` / `listDocuments` / `startParsing` / `retrieve` / `downloadDocument` / `deleteDocument` 等，mock 单测见 `tests/server/adapters/ragflow-client.test.ts`）

| 字段 | 实测值 |
|---|---|
| 版本 | 镜像 tag `infiniflow/ragflow:v0.20.5`（image id `sha256:e9438614aec3…`，即 22.6GB 的 full 版）；`GET /v1/system/version` → `{"code":0,"data":"v0.20.5 full"}` |
| 依赖镜像 | `mysql:8.0.39`、`elasticsearch:8.11.3`、`valkey/valkey:8`、`pgsty/minio:latest`（MinIO 官方镜像已无法匿名拉取，暂用社区重建版，命令与官方一致） |
| 容器名 / 状态 | `ragflow-server`、`ragflow-mysql`、`ragflow-minio`、`ragflow-redis`、`ragflow-es-01`，`docker compose ps` 均 `Up (healthy)` |
| Base URL | `http://localhost:9380` |
| 服务端口 | API 9380；Web UI 18080（容器 80，nginx）；MySQL 5455；Elasticsearch 1200；MinIO 19000 / 控制台 19001；Redis 16379（均为宿主机端口，刻意避开 Logto 的 3001/3002） |
| 管理界面地址 | `http://localhost:18080`（实测 HTTP 200） |
| 健康检查 | 容器自带 healthcheck：ragflow-server 用 Python 探 127.0.0.1:9380；ES 用带密码的 `_cluster/health` |
| 已验证环境变量名 | 编排层：`RAGFLOW_IMAGE`、`STACK_VERSION`、`MINIO_IMAGE`、`SVR_HTTP_PORT`、`SVR_WEB_PORT`、`MYSQL_PORT`、`ES_PORT`、`MINIO_PORT`、`MINIO_CONSOLE_PORT`、`REDIS_PORT`、`TIMEZONE`、`HF_ENDPOINT`、`MEM_LIMIT`、`MYSQL_DBNAME`、`MYSQL_PASSWORD`、`MINIO_USER`、`MINIO_PASSWORD`、`REDIS_PASSWORD`、`ELASTIC_PASSWORD`、`REGISTER_ENABLED`；应用侧：`RAGFLOW_BASE_URL`、`RAGFLOW_API_KEY`、`RAGFLOW_DATASET_ID`、`RAGFLOW_DATASET_NAME` |
| 鉴权方式 | `POST /v1/user/register`（密码需用容器内 `conf/private.pem` 对应公钥做 RSA 加密后 base64）→ `POST /v1/system/new_token` 返回 `token`（`ragflow-` 前缀）。后续 API 用 `Authorization: Bearer <token>`；该 token 对应 `api_token.token`，不是返回里的 `beta` |
| ES 前置条件 | Docker Desktop 的 Linux VM 需 `vm.max_map_count=262144`（本机实测已为该值） |
| 镜像拉取 | 本机从华为云镜像 `swr.cn-north-4.myhuaweicloud.com/infiniflow/ragflow:v0.20.5` 拉取后重打 tag；`docker pull` 需分段续传，见 `infra/ragflow/README.md` |
| Dataset / Document 接口契约 | 见下方“已验证 API 调用”，均为实测请求/响应 |
| 解析与检索验证结果 | 已实测（2026-11-11）：上传后触发 `POST /api/v1/datasets/{id}/chunks`，文档约 9–12 秒后转为 `DONE`、`chunk_count = 1`；`POST /api/v1/retrieval` 召回同一文档，相似度约 0.38–0.48；归档后同一检索返回 0 条 |
| Asset / Work 映射结果 | 已实测单对象内容上传 / 替换（2026-11-11 15:02）；附件、批量与对账未实测 |

### 已验证 API 调用（2026-11-11 14:52，全部使用上面的真实 API key）

| 动作 | 请求 | 实测响应 |
|---|---|---|
| 列 dataset（空库） | `GET /api/v1/datasets` | `{"code":0,"data":[]}` |
| 建 dataset | `POST /api/v1/datasets`，body `{"name":"phase0-smoke-test","description":"…"}` | `{"code":0,"data":{…"id":"6ef7a234…","name":"phase0-smoke-test","embedding_model":"BAAI/bge-large-zh-v1.5@BAAI",…}}`（未传 embedding_model 时落到租户默认模型） |
| 上传 document | `POST /api/v1/datasets/{dataset_id}/documents`，multipart 字段 `file` | `{"code":0,"data":[{"id":"779a934c…","name":"smoke.txt","dataset_id":"…","chunk_method":"naive","run":"UNSTART","size":56,"suffix":"txt",…}]}`（单次请求即落库，不是先建记录再 PUT） |
| 列 document | `GET /api/v1/datasets/{dataset_id}/documents?page=1&page_size=10` | `{"code":0,"data":{"docs":[{…"id":"779a934c…","chunk_count":0,…}],"total":1}}`（注意是 `data.docs`，不是数组） |
| 删 document | `DELETE /api/v1/datasets/{dataset_id}/documents`，body `{"ids":["779a934c…"]}` | `{"code":0}`；随后列表 `docs:[] , total:0` |
| 删 dataset | `DELETE /api/v1/datasets`，body `{"ids":["6ef7a234…"]}` | `{"code":0}`；随后 `GET /api/v1/datasets` → `{"code":0,"data":[]}`（测试数据已清理干净） |

### 内容上传契约（2026-11-11 15:02 实测，含应用侧端到端冒烟）

内容上传走 `src/server/services/content-service.ts`，适配器新增 `createDataset` / `updateDocumentMetaFields`。以下四条是**实测结论**，不是推测：

| 结论 | 实测依据 |
|---|---|
| 上传接口**不接受** `meta_fields` | `POST /api/v1/datasets/{id}/documents` 只读取 multipart 的 `file` 字段（服务端 `api/apps/sdk/doc.py` 的 `upload()` 里没有读取 `meta_fields`）；只能上传后再更新 |
| meta 写入用 `PUT /api/v1/datasets/{id}/documents/{doc_id}`，body `{"meta_fields":{…}}` | 实测返回 `code:0`；随后列表接口读回 `meta_fields` 与写入值完全一致（`content_key` / `owner_type` / `owner_id` / `library` / `archived` / `format` / `source`） |
| 该更新是**整体替换**，不是合并 | 服务端 `DocumentService.update_meta_fields()` 直接覆盖 `meta_fields` JSON 列；所以每次都要传完整字段集 |
| `GET /api/v1/datasets/{id}/documents/{doc_id}` 是**下载**接口（返回文件流） | 直接请求拿到的是原文内容而非 JSON；文档元数据（含 `meta_fields`）只能从列表接口 `data.docs[]` 读 |

建 dataset 契约：`POST /api/v1/datasets`，body `{name, description?, embedding_model?}`，响应 `data` 是**单个对象**（不是数组）；不传 `embedding_model` 时落到租户默认模型 `BAAI/bge-large-zh-v1.5@BAAI`。

应用侧 dataset 选择（ADR-007 单一 Dataset）：

- `RAGFLOW_DATASET_ID` 非空则直接用，不做查找；
- 否则按 `RAGFLOW_DATASET_NAME`（默认 `pakp-content`）调 `GET /api/v1/datasets?name=…` 精确匹配；RAGFlow 对不存在的名称返回**错误码**而不是空列表（`lacks permission for dataset '…'`），服务层把这种情况当作「没有」并新建；
- 本机已创建 `pakp-content`（id `cdca6016dd9d11f1820ba6aa99b57ab2`），作为统一内容库保留，冒烟测试产生的临时文档已删除，当前 `document_count = 0`。

端到端冒烟（真实 RAGFlow v0.20.5，内存 SQLite，临时 `pakp-smoke.txt`）：

1. 首次上传 → `document_id` 落库、`meta_fields` 写入并可读回；
2. 再次上传主内容 → 旧文档在列表中消失、`content_refs` 仍是同一行（`refIdStable: true`）、`content_key` 不变、`document_id` 换成新值；
3. 本地库：1 条 `primary` 引用 + 1 条 `pending` 的 `upsert` 同步任务；
4. 冒烟结束后删除临时文档，`docs:[] , total:0`。

### 解析、检索与下载（2026-11-11 实测）

- **解析触发**：上传时调用 `POST /api/v1/datasets/{id}/chunks`，body `{document_ids:[…]}`；触发失败不影响上传，引用停在 `pending`，由 `POST /api/parse/run` 兜底重试。
- **解析轮询**：读取 `GET /api/v1/datasets/{id}/documents` 的 `run`、`progress_msg`、`chunk_count`，回写 `content_refs.parse_status`；状态覆盖 `UNSTART / RUNNING / SCHEDULE / DONE / FAIL / CANCEL`。实测上传后为 `running`，约 9–12 秒转为 `succeeded`、`chunk_count = 1`。
- **检索**：`POST /api/v1/retrieval`，请求含 `question`、`dataset_ids`、`page_size`、`similarity_threshold`（默认 0.2）等字段；响应 `chunks[]` 带 `document_id` 与 `similarity`，应用层据此认回 `content_refs` 并做归属 / 归档 / 库别过滤。实测同一文档相似度 0.38–0.48，归档后同一检索 0 条。
- **下载**：`GET /api/v1/datasets/{id}/documents/{document_id}` 返回文件流（实测 `Content-Type: application/octet-stream`），内容与上传文件逐字节一致；该路径不是 JSON 详情接口。
- **失败路径**：解析 `FAIL` 回写、outbox 重试退避目前只有假网关单测覆盖，真实 RAGFlow 上的失败场景待实测。

### 还缺什么才能跑通问答

- 未配置任何 chat model API key。full 版镜像自带 embedding 模型（租户默认 `BAAI/bge-large-zh-v1.5@BAAI`），建库、上传、解析、向量化与检索均已够用；
- 问答 / 多轮会话、GraphRAG、RAPTOR 需要 chat model，当前不可用；应用侧 `GET /api/search` 只返回召回片段，不组装上下文、不调用生成模型；
- 若改用 `-slim` 镜像，必须额外配置外部 embedding 服务，否则创建 dataset 就会失败。

## LightRAG

- 部署方式：待定
- 与 RAGFlow 关系：共用 Embedding 模型，独立图存储与向量存储（ADR-001）
- 当前状态：待 Phase 3；未部署、未连接、未验证

| 字段 | 实测值 |
|---|---|
| 版本 / 部署方式 | 待实测 |
| 地址与端口 | 待实测 |
| 图存储 / 向量存储位置 | 待实测 |
| 构图与查询验证结果 | 待 Phase 3 验证 |
| 内容更新同步方式 | 待 Phase 3 验证 |

## Embedding

- 决策：RAGFlow 与 LightRAG 共用 Embedding 模型，不共用向量库（ADR-001）
- 当前状态：RAGFlow 侧使用镜像内置默认模型（租户默认 `BAAI/bge-large-zh-v1.5@BAAI`，解析与检索已实测可用）；LightRAG 侧尚未部署，共用配置待 Phase 3 实测

| 字段 | 实测值 |
|---|---|
| 提供方 / 模型 | RAGFlow 内置默认：`BAAI/bge-large-zh-v1.5@BAAI`（实测）；LightRAG 侧待实测 |
| 服务地址 | RAGFlow 内置，无独立服务地址；LightRAG 侧待实测 |
| 维度与配置 | 待实测（应用侧未直接读取维度） |
| 两套系统验证结果 | RAGFlow 已用于解析与检索；LightRAG 待 Phase 3 验证 |

## 设计草案（非已验证集成）

- [DRAFT：元数据、content_ref、四阶段状态机与 Logto 清单](drafts/01_PHASE1_DESIGN.md)
- 草案中的应用 env 名和 OIDC 路径均需正式实现后复核，不得据此判断服务已可用。
