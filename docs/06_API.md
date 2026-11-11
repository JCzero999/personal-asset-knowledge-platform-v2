# HTTP API 参考

> **适用对象**：调用本服务接口的前端 / 脚本开发者，以及需要核对接口契约的后端开发者。
> **文档范围**：只记录 `src/app/api/` 下**当前已实现**的路由。未实现的能力统一列在第 10 节，避免把规划当成契约。
> **核对依据**（2026-11-11）：`src/app/api/**/route.ts`、`src/server/http/respond.ts`、`src/server/services/{object,content,sync,parse,search,graph}-service.ts`、`src/server/sync-worker-runtime.ts`、`src/server/adapters/ragflow/client.ts`、`src/server/adapters/lightrag/client.ts`、`src/server/session.ts`、`src/domain/{errors,objects,workflow,content-ref}.ts`、`src/server/repositories/{sqlite-object-repository,sqlite-content-store}.ts`。代码与本文不一致时以代码为准，并回头修本文。

---

## 1. 通用约定

### 1.1 Base URL 与运行方式

| 项 | 值 |
|----|----|
| 开发环境默认地址 | `http://localhost:3000` |
| 可配置项 | `APP_URL`（Logto 回调与跳转使用；未设置时按 `http://localhost:3000`） |
| 路由运行时 | 全部为 `runtime = "nodejs"`、`dynamic = "force-dynamic"`，响应不做静态缓存 |
| 启动 | `npm run dev`（Next.js 16） |

除三条 Logto 登录路由（返回重定向，见第 8 节）外，所有接口返回 JSON；例外有两处：内容上传收 `multipart/form-data` 请求体（见 4.10），内容下载成功时返回二进制文件流而非 JSON（见 4.12）。

### 1.2 数据格式

- 请求体与响应体均为 JSON，UTF-8（内容上传除外）。
- 带 JSON 请求体的接口应发送 `Content-Type: application/json`。
- 时间字段为 UTC ISO-8601 字符串，例如 `2026-11-11T06:00:00.000Z`。
- 对象 `id` 为 ULID 字符串，由服务端生成，调用方不传。

### 1.3 鉴权与会话

身份统一从 `src/server/session.ts` 的 `getSession()` 获取，接口不各自判断环境变量。行为由 `AUTH_MODE` 决定：

| `AUTH_MODE` | 生效条件 | 会话 |
|-------------|----------|------|
| `mock` | 显式设置，或**开发环境未设置**时的默认值 | 固定本地身份：`sub = "mock-local-user"`、`name = "林默"`、`email = null` |
| `logto` | 显式设置 | 读取 Logto 会话 Cookie；会话失效按未登录处理 |
| 其他任意值，或生产环境未设置 | — | 无身份：所有业务接口返回 `401 UNAUTHORIZED`，`/workspace` 跳回首页 |

要点：

- **开发时无需登录即可调接口**：`AUTH_MODE=mock`（开发默认）下，所有 `/api/objects*` 请求都按 `mock-local-user` 执行。
- **归属隔离**：所有对象读写都按当前会话的 `sub` 过滤。访问不属于自己的对象时返回 `404 NOT_FOUND`（与「不存在」不区分，避免用 id 探测他人数据）。该规则对详情、编辑、删除、状态迁移、跨库迁移、归档、迁移审计、内容上传、内容列表、内容下载与内容检索**全部生效**。
- **未登录**：业务接口返回 `401`，响应体 `message` 为「请先登录」。页面侧由 `requireSession()` 重定向到 `/`。
- **配置缺失不降级**：`AUTH_MODE=logto` 但 `LOGTO_*` 环境变量不全时，会话解析直接抛错，请求以 500 失败——不会静默当成「未登录」，避免把配置问题藏起来。

### 1.4 响应信封与错误码

**成功响应**：直接返回数据本体（单个对象、对象数组或内容引用），不额外包 `data` 字段。

**失败响应**：固定为下面的信封，`details` 可选：

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "title 不能为空",
    "details": { "field": "title" }
  }
}
```

错误码与 HTTP 状态映射（`src/server/http/respond.ts`）：

| 错误码 | HTTP | 触发场景 |
|--------|------|----------|
| `VALIDATION_FAILED` | 400 | 请求体不是合法 JSON / 不是对象；查询参数取值非法或越界；字段类型、取值、长度不合规；编辑时改动不可变字段；RAGFlow 返回 400 / 422 |
| `UNAUTHORIZED` | 401 | 无会话（`AUTH_MODE` 为 `logto` 且未登录，或 `disabled`） |
| `NOT_FOUND` | 404 | 对象不存在、已删除、或不属于当前用户；RAGFlow 返回 404 |
| `CONFLICT` | 409 | 乐观锁版本不一致（`expectedRevision` 与库中 `revision` 不符）；唯一约束冲突；RAGFlow 返回 409 |
| `INVALID_TRANSITION` | 409 | 作品状态迁移不在允许的迁移表中（跳级、回退、原地迁移） |
| `EXTERNAL_LIBRARY_PRACTICED` | 409 | 外库作品被要求变为 `practiced`，或已 `practiced` 的作品要迁回外库 |
| `CONSTRAINT_VIOLATION` | 422 | 数据库 CHECK 约束拒绝写入（服务层漏校验时的最后防线） |
| `INTERNAL` | 500 | 未预期异常；RAGFlow 配置缺失、响应非 JSON、返回 5xx 或结构不符；日志记录原始错误，响应不暴露内部信息 |

异常统一由 `fromError()` 收敛，未识别的异常一律转为 `INTERNAL`。两个不走信封的例外：`GET /api/health`（保持原有形状）与内容下载（成功是文件流，未登录是纯文本 401，见 4.12）。

### 1.5 请求体校验通则

- JSON 请求体必须是**对象**；`null`、数组、字符串等返回 400「请求体必须是 JSON 对象」。
- 字符串字段会先 `trim()`；必填字段 trim 后为空 → 400。
- `categories` / `tags` 必须是字符串数组；元素逐个 trim，空串被丢弃，去重后最多 20 项，单项最长 40 字符。
- 枚举字段只接受下文列出的取值，其他值 → 400「取值非法」，不做静默回退。
- 请求体中出现未知字段时**不报错**，会被忽略。

### 1.6 查询参数校验通则

- 只对**已实现**的参数做校验；未知参数被忽略。
- 空字符串等同未传（`?q=` 不参与筛选）。
- 非法取值一律 `400`，不静默回退为默认值——分页与排序参数尤其如此，避免调用方以为筛选生效其实没有。

---

## 2. 对象数据结构

`GET` / `POST` / `PATCH` 及动作接口返回的都是同一个对象结构；`GET /api/objects` 的数组元素也与之**完全一致**（没有列表专用的裁剪字段）。资产与作品共用基础字段，作品多三个字段。

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | ULID，服务端生成 |
| `type` | `"asset" \| "work"` | 资产 / 作品，创建后不可改 |
| `title` | string | 标题，最长 200 字符 |
| `description` | string \| null | 描述，最长 5000 字符 |
| `library` | `"internal" \| "external"` | 内库 = 已验证；外库 = 输入与待验证。创建后只能通过迁移接口改 |
| `source` | `"handwritten" \| "ai_extracted"` | 谁写的（与验证程度正交） |
| `origin` | `"self" \| "imported"` | 自己的还是导入的 |
| `primaryCategory` | string \| null | **派生字段**：写入时取 `categories[0]`，不能直接写 |
| `categories` | string[] | 分类，最多 20 项 |
| `tags` | string[] | 标签，最多 20 项 |
| `priority` | `"low" \| "medium" \| "high"` | 优先级 |
| `archivedAt` | string \| null | 归档时间；归档只改元数据 |
| `libraryChangedAt` | string \| null | 最近一次跨库迁移时间；对应 `library_events` 审计流水 |
| `ownerSub` | string | 所属用户，取当前会话 `sub` |
| `revision` | number | 乐观锁版本号，每次写入 +1 |
| `createdAt` / `updatedAt` | string | UTC ISO-8601 |
| `deletedAt` | string \| null | 软删除时间；已删除对象不会出现在任何接口结果中 |
| `format` | 作品：`"article" \| "script" \| "course" \| "live" \| "consult" \| "flomo"`；资产：`null` | 作品形态 |
| `status` | 作品：`"draft" \| "finished" \| "published" \| "practiced"`；资产：`null` | 作品状态 |
| `sourceNote` | 作品：string \| null；资产：`null` | 来源说明 |

作品响应示例：

```json
{
  "id": "01JBDEMO000000000000000000",
  "type": "work",
  "title": "第一篇长文",
  "description": null,
  "library": "internal",
  "source": "handwritten",
  "origin": "self",
  "primaryCategory": "写作",
  "categories": ["写作"],
  "tags": ["长文"],
  "priority": "medium",
  "archivedAt": null,
  "libraryChangedAt": null,
  "ownerSub": "mock-local-user",
  "revision": 1,
  "createdAt": "2026-11-11T06:00:00.000Z",
  "updatedAt": "2026-11-11T06:00:00.000Z",
  "deletedAt": null,
  "format": "article",
  "status": "draft",
  "sourceNote": null
}
```

资产对象则固定 `format` / `status` / `sourceNote` 为 `null`。

> 对象结构里**没有**内容字段。正文存在 RAGFlow，业务侧用 `content_refs` 记录映射；内容引用、原文下载与内容检索走独立接口（4.11、4.12、5.1），不塞进对象结构。

---

## 3. 端点总览

| 方法 | 路径 | 用途 | 成功状态 |
|------|------|------|----------|
| GET | `/api/health` | 健康检查（无需登录） | 200 |
| GET | `/api/objects` | 列出 / 筛选 / 分页当前用户的对象 | 200 |
| POST | `/api/objects` | 新建资产 / 作品 | 201 |
| GET | `/api/objects/{id}` | 读取单个对象 | 200 |
| PATCH | `/api/objects/{id}` | 编辑对象字段 | 200 |
| DELETE | `/api/objects/{id}` | 软删除对象 | 204 |
| POST | `/api/objects/{id}/status` | 作品状态迁移 | 200 |
| POST | `/api/objects/{id}/library` | 跨库迁移（内库 ↔ 外库） | 200 |
| GET | `/api/objects/{id}/library` | 查询该对象的跨库迁移记录 | 200 |
| POST | `/api/objects/{id}/archive` | 归档 / 取消归档 | 200 |
| POST | `/api/objects/{id}/content` | 上传 / 替换内容（multipart） | 201 |
| GET | `/api/objects/{id}/content` | 列出对象的内容引用 | 200 |
| GET | `/api/objects/{id}/content/{refId}` | 下载内容原文（二进制流） | 200 |
| GET | `/api/search` | 内容检索（RAGFlow 召回 + 归属过滤） | 200 |
| POST | `/api/sync/run` | 手动触发一轮 outbox 投递 | 200 |
| POST | `/api/parse/run` | 手动推进一轮解析状态轮询 | 200 |
| GET | `/api/graph/labels` | 图谱实体标签列表 | 200 |
| GET | `/api/graph` | 实体邻域子图 | 200 |
| POST | `/api/graph/sync` | 把对象内容同步进 LightRAG（最多 50 个） | 200 |
| GET | `/api/graph/status` | 本系统图文档的抽取状态 | 200 |
| POST | `/api/graph/query` | 图增强问答（`mix`，可能约 90 秒） | 200 |
| GET | `/api/logto/sign-in` | 跳转 Logto 登录（浏览器） | 307 |
| GET | `/api/logto/sign-in-callback` | 登录回调（浏览器） | 307 |
| GET | `/api/logto/sign-out` | 退出并清会话（浏览器） | 307 |

合计 24 条路由：21 条业务 / 系统接口 + 3 条 Logto 跳转。除 `/api/health` 外都需要会话；`/api/graph/*` 在 LightRAG 不可用时返回 500。

---

## 4. 业务对象接口

### 4.1 `GET /api/objects`

列出当前用户的对象，支持关键字、分类、标签、状态、库别、类型筛选与排序分页。

**查询参数**（全部可选）：

| 参数 | 取值 | 说明 |
|------|------|------|
| `type` | `asset` \| `work` | 按类型筛选；其他值 → 400 |
| `library` | `internal` \| `external` | 按库别筛选；其他值 → 400 |
| `status` | `draft` \| `finished` \| `published` \| `practiced` | 按作品状态筛选；其他值 → 400。资产 `status` 为 `null`，不会命中任何状态筛选 |
| `q` | 字符串，trim 后 ≤ 100 字符 | 标题或描述包含该关键字；大小写不敏感（SQLite `LIKE` 语义，ASCII 字母不区分大小写）。`%` 与 `_` **按字面量匹配**，不会被当成通配符；超长 → 400 |
| `category` | 字符串，≤ 64 字符 | 分类数组元素**精确匹配**（`json_each` 等值比较，不做包含/前缀匹配）；超长 → 400 |
| `tag` | 字符串，≤ 64 字符 | 标签数组元素精确匹配；超长 → 400 |
| `sort` | `updated`（默认）\| `created` \| `title` | 排序字段；其他值 → 400 |
| `limit` | 1–200 的整数，**默认 100** | 返回条数上限；`0`、`201`、小数、非数字 → 400 |
| `offset` | ≥ 0 的整数，默认 `0` | 跳过的条数；负数、小数、非数字 → 400 |
| `archived` | `true` \| `false` \| `only` | `true`：**连已归档一起返回**；`only`：**只返回已归档**；`false` 或不传：只要未归档的。其他值 → 400 |

**默认行为**：

- 只返回当前会话用户的对象；
- **默认过滤已软删除与已归档**；`archived=only` 则反过来只看已归档（仍过滤已删除）；
- 排序：`updated` → `updatedAt` 倒序；`created` → `createdAt` 倒序；`title` → 标题升序；三者都以 `id` 升序作为稳定的第二排序键；
- `limit` 不传时取 100 条（数据层默认值），上限 200。

**响应**：`200`，对象数组（元素结构见第 2 节），**没有**总数、页码或游标信封。

```json
[
  {
    "id": "01JBDEMO000000000000000000",
    "type": "work",
    "title": "第一篇长文",
    "library": "internal",
    "status": "draft",
    "revision": 1
  }
]
```

> 上面的数组元素只保留了关键字段，实际响应包含第 2 节的全部字段。

**主要错误**：`400`（任一筛选 / 分页参数取值非法或越界，含 `archived` 不是 `true` / `false` / `only`）、`401`。

**分页注意**：响应里没有 `total`，调用方只能靠「本页条数 < limit」判断是否取完；翻页期间若有写入，按 `updatedAt` 排序会出现记录跨页漂移。

---

### 4.2 `POST /api/objects`

新建资产或作品。

**请求体**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `type` | `asset` \| `work` | 是 | 对象类型 |
| `title` | string | 是 | 1–200 字符 |
| `library` | `internal` \| `external` | 是 | 所属库 |
| `description` | string \| null | 否 | 最长 5000 字符 |
| `categories` | string[] | 否 | 最多 20 项，单项 ≤ 40 字符；首项写入 `primaryCategory` |
| `tags` | string[] | 否 | 最多 20 项，单项 ≤ 40 字符 |
| `priority` | `low` \| `medium` \| `high` | 否 | 默认 `medium` |
| `source` | `handwritten` \| `ai_extracted` | 否 | 默认 `handwritten` |
| `origin` | `self` \| `imported` | 否 | 默认 `self` |
| `format` | 见第 2 节六个取值 | 作品必填 | 资产传字符串会被拒绝；传 `null` 等同未传 |
| `sourceNote` | string \| null | 否 | 仅作品有效；最长 5000 字符 |
| `status` | — | 否 | **作品禁止传**：任何非 `null` 值都返回 400；资产会忽略该字段 |

规则：

- **新建作品固定为 `draft`**，状态只能通过 `POST /api/objects/{id}/status` 迁移。
- 资产不允许携带 `format`（传了非 `null` 值 → 400「资产没有 format 字段」）；`sourceNote` 对资产无意义，会被忽略。
- `id`、`revision`、时间戳、`ownerSub` 均由服务端生成，请求体中传入会被忽略。
- 新建只写业务元数据，**不创建内容、不入队同步任务**；正文要再调 4.10 上传。

**响应**：`201`，新建的完整对象。

**主要错误**：`400`（字段缺失 / 类型错误 / 取值非法 / 作品带 `status`）、`401`。

---

### 4.3 `GET /api/objects/{id}`

按会话身份读取单个对象。响应结构与应用第 2 节完全一致，包含 `revision`、`library`、`status`、`archivedAt`、`deletedAt` 等全部字段。

**路径参数**：`id` —— 对象 ULID。

**响应**：`200`，单个对象（示例见第 2 节）。

**主要错误**：

| 状态 | 场景 |
|------|------|
| 401 | 未登录 |
| 404 | 对象不存在、已软删除、或不属于当前用户（三者不区分） |

> 已归档对象仍可读——归档只影响列表默认筛选，不影响读取。

---

### 4.4 `PATCH /api/objects/{id}`

编辑对象。只改传入的字段。

**请求体**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `expectedRevision` | 正整数 | **是** | 乐观锁版本号，须与对象当前 `revision` 一致 |
| `title` | string | 否 | 不可为空，≤ 200 字符 |
| `description` | string \| null | 否 | ≤ 5000 字符；显式 `null` 清空 |
| `categories` | string[] \| null | 否 | `null` 等同于清空为 `[]`；同时重算 `primaryCategory` |
| `tags` | string[] \| null | 否 | `null` 等同于清空为 `[]` |
| `priority` | `low` \| `medium` \| `high` | 否 | **不接受 `null`** |
| `source` | `handwritten` \| `ai_extracted` | 否 | **不接受 `null`** |
| `origin` | `self` \| `imported` | 否 | **不接受 `null`** |
| `format` | 六个作品形态之一 | 否 | 仅作品；**不接受 `null`** |
| `sourceNote` | string \| null | 否 | 仅作品；显式 `null` 清空 |

语义：

- **字段缺席 = 保持不变**。
- **显式 `null` = 清空**，仅对 `description`、`sourceNote`、`categories`、`tags` 成立；`title`、`priority`、`source`、`origin`、`format` 传 `null` 会返回 400（这些字段没有空值语义）。
- **不可变字段**：`type`、`library`、`status` 只要出现在请求体里（包括 `null`）就返回 400。改库别用 `/library`，改状态用 `/status`。
- 资产携带 `format` 或 `sourceNote` → 400「资产不允许携带 format / sourceNote」。
- 写入成功后 `revision + 1`、`updatedAt` 刷新，并在**同一事务**内入队一条 `sync_jobs(action = upsert)`；后台 worker（5.2）会把它投递到 RAGFlow，`meta_fields` 因此跟随业务字段变化。

**响应**：`200`，更新后的完整对象。

**主要错误**：

| 状态 | 场景 |
|------|------|
| 400 | 缺 `expectedRevision` / 不是正整数；改动不可变字段；字段校验失败 |
| 401 | 未登录 |
| 404 | 对象不存在、已删除、或不属于当前用户 |
| 409 | `expectedRevision` 与当前 `revision` 不一致 |

---

### 4.5 `DELETE /api/objects/{id}`

软删除对象：只写 `deletedAt`，不物理删行，便于审计与对账。删除在**同一事务**内入队一条 `delete` 同步任务（`sync_jobs`）；RAGFlow 侧文档由 worker 异步删除（5.2），**不是**立即删除——worker 未跑或失败时文档仍在。

**请求体**：无。

**响应**：`204`，无响应体。

**主要错误**：`401`、`404`（不存在、已删除或不属于当前用户）。

> 重复删除同一对象会得到 `404`，不是幂等成功。

---

### 4.6 `POST /api/objects/{id}/status`

迁移作品状态。

**请求体**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `to` | `draft` \| `finished` \| `published` \| `practiced` | 是 | 目标状态 |
| `expectedRevision` | 正整数 | 否 | 省略时以本次读取到的 `revision` 为准；仍能挡住读取之后的并发写入 |

**允许的迁移**（逐级前进，不可跳级、不可回退）：

```text
draft ──► finished ──► published ──► practiced
```

额外规则：**外库（`external`）作品不能进入 `practiced`**，必须先迁到内库。数据库 CHECK `objects_external_not_practiced` 作为最后防线。**已归档作品不能推进状态**：归档表示退出工作台，先 `POST /api/objects/{id}/archive` 传 `{"archived": false}` 取消归档，再按原状态机继续。

**响应**：`200`，状态已更新、`revision + 1` 的对象。

**主要错误**：

| 状态 / 错误码 | 场景 |
|---------------|------|
| 400 `VALIDATION_FAILED` | `to` 非法；目标是资产（资产没有状态）；`expectedRevision` 非正整数 |
| 401 `UNAUTHORIZED` | 未登录 |
| 404 `NOT_FOUND` | 对象不存在 / 已删除 / 不属于当前用户 |
| 409 `INVALID_TRANSITION` | 跳级、回退、或与当前状态相同（`details` 带 `from` / `to`，跳级时另带 `allowed`） |
| 409 `EXTERNAL_LIBRARY_PRACTICED` | 外库作品试图变为 `practiced` |
| 409 `CONFLICT` | 版本号不一致，或作品已归档（`details.archivedAt`） |

---

### 4.7 `POST /api/objects/{id}/library`

跨库迁移（内库 ↔ 外库）。

**请求体**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `to` | `internal` \| `external` | 是 | 目标库 |
| `reason` | string | **是** | 迁移理由，trim 后不能为空，≤ 5000 字符 |
| `expectedRevision` | 正整数 | 否 | 省略时以本次读取到的 `revision` 为准 |

规则：

- `reason` 必填，因为「内库 = 已验证」是承诺，理由要写入 `library_events` 审计表。
- 库别更新与审计写入在**同一事务**内完成，不会出现「库别已变但没有记录」；数据库另有 `from_library <> to_library` CHECK（迁移 `0004`）兜底，同库记录写不进去。
- 已 `practiced` 的作品不能迁回外库（`EXTERNAL_LIBRARY_PRACTICED`，409）。
- 目标库与当前库相同 → 400「对象已处于目标库，无需迁移」。
- 迁移只改元数据，不移动内容、不换内容引用；RAGFlow `meta_fields` 里的 `library` 由 worker 异步同步（5.2），因此 RAGFlow 侧的库别标记**有延迟**。

**响应**：`200`，更新后的对象（`library`、`libraryChangedAt` 已变，`revision + 1`）。

**主要错误**：`400`（`to` 非法 / 缺 `reason` / 同库迁移 / `expectedRevision` 非法）、`401`、`404`、`409`（`EXTERNAL_LIBRARY_PRACTICED` 或 `CONFLICT`）。

---

### 4.8 `GET /api/objects/{id}/library`

读取该对象的跨库迁移审计记录。这是 `POST /api/objects/{id}/library` 的读侧：此前审计只写不可读。

**路径参数**：`id` —— 对象 ULID。

**响应**：`200`，迁移记录数组，**按 `createdAt` 正序**（最早的在前）。从未迁移过的对象返回 `[]`，不是 404。

字段（`LibraryChangeEvent`）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | 审计记录 ULID |
| `objectId` | string | 所属对象 |
| `fromLibrary` | `internal` \| `external` | 迁移前库别 |
| `toLibrary` | `internal` \| `external` | 迁移后库别 |
| `reason` | string | 迁移理由（迁移时必填） |
| `actorSub` | string | 执行迁移的用户 `sub` |
| `createdAt` | string | UTC ISO-8601 |

```json
[
  {
    "id": "01JBEVENT00000000000000000",
    "objectId": "01JBDEMO000000000000000000",
    "fromLibrary": "external",
    "toLibrary": "internal",
    "reason": "已复盘确认",
    "actorSub": "mock-local-user",
    "createdAt": "2026-11-11T07:10:00.000Z"
  }
]
```

**主要错误**：`401`、`404`（对象不存在 / 已删除 / 不属于当前用户——**鉴权发生在审计查询之前**，不会因为对象是谁的而泄露迁移历史）。

> 没有分页参数。同一个对象反复迁移时会返回全部历史，条数由实际迁移次数决定。

---

### 4.9 `POST /api/objects/{id}/archive`

归档或取消归档。

**请求体**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `archived` | boolean | 是 | `true` 归档，`false` 取消归档；缺失或非布尔 → 400 |

规则：

- 归档只写 `archivedAt`，不动内容、不改状态。
- **幂等**：对象已处于目标归档状态时原样返回，`revision` 不变，也不入队重复任务。

**响应**：`200`，对象。

**主要错误**：`400`、`401`、`404`。

---

### 4.10 `POST /api/objects/{id}/content`

上传对象内容：把文件写进 RAGFlow，落一条 `content_refs` + 一条 `sync_jobs(upsert)`，并立即触发一次解析。内容列表、原文下载与检索见 4.11、4.12、5.1。

**请求**：`Content-Type: multipart/form-data`

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `file` | 文件 | **是** | 空文件（0 字节）→ 400；单次上限 **25 MB**（`25 * 1024 * 1024` 字节），超限 → 400 |
| `role` | `primary` \| `attachment` | 否 | 默认 `primary`；其他值 → 400；空串等同未传 |
| `documentName` | 字符串 | 否 | 写入 RAGFlow 的文件名。只取最后一段（客户端传的路径会被剥掉），≤ 200 **字节**（按 UTF-8 计，避免中文名被拒）；缺扩展名时自动继承 `file` 的原后缀；未传则用 `file` 的原文件名，都没有时用 `content.txt` |

**语义**：

- **归属校验先于一切外部调用**：对象不存在 / 已删除 / 不属于当前用户 → `404`，且**不会**向 RAGFlow 发任何请求。
- **单一 Dataset（ADR-007）**：`RAGFLOW_DATASET_ID` 非空则直接用；否则按 `RAGFLOW_DATASET_NAME`（默认 `pakp-content`）查找，找不到就自动创建一个。RAGFlow 对不存在的名称返回错误码而不是空列表，服务层把这种情况当「没有」处理。
- **`content_key` 是幂等键**：主内容固定 `obj:{objectId}:primary`（同一对象重复上传只会更新同一条 `content_refs` 行）；附件带 ULID，即 `obj:{objectId}:attachment:{ULID}`，每次上传都是新引用，同一对象可挂多个附件。
- **`meta_fields` 镜像**：只写 `content_key`、`owner_type`、`owner_id`、`library`、`archived`、`format`（作品才有）、`source`；**不镜像 `status`**。
- **替换主内容的顺序**（关键）：临时名上传新文档 → 写 `meta_fields` → 落 `content_refs` 并入队 → 删除旧文档 → 把新文档改回原名。任一步失败时：
  - 上传或写 meta 失败：删掉刚上传的新文档，旧文档与旧引用**原样保留**；
  - 本地落库失败：删掉新文档，旧引用不变；
  - 旧文档删除失败：只记警告，本次上传仍算成功（留下一个待对账的重复文档）；
  - 改名失败：文档保留临时名，内容不受影响。
- **`meta_fields` 必须整体替换**：RAGFlow 的上传接口**不接受** meta，只能上传后 `PUT` 更新；该 `PUT` 是整体覆盖而非合并，因此每次都传完整字段集。
- **解析触发**：本地落库并入队后，立即调用 RAGFlow `POST /api/v1/datasets/{dataset_id}/chunks`（body `{ document_ids: [documentId] }`），成功后把引用置为 `running`，响应里的 `parseStatus` 即 `running`。触发失败**不影响上传**——异常只记日志，接口仍返回 201，引用停在 `pending`，由解析轮询在下一轮按 `UNSTART` 补触发（见 5.3）。
- **解析进度不由上传接口保证**：上传只负责触发。`running → succeeded / failed` 由后台 worker 每轮轮询 RAGFlow 文档状态回写（默认 30 秒，行为见 5.3）。本机实测（RAGFlow v0.20.5）：上传后立即为 `running`，约 9–12 秒变为 `succeeded`，`chunk_count = 1`。
- **`syncState` 与解析状态相互独立**：`syncState` 写入时是 `pending`；上传成功后入队的那条 `upsert` 被 worker 投递成功时变为 `synced` 并写 `lastSyncedAt`。若 RAGFlow 侧该文档已不存在，worker 把引用标为 `sync_failed` 且不重试——重新上传正文会生成新的 `document_id`，状态随之回到 `synced`。
- 上传**不改**对象 `revision`、`updatedAt` 或任何业务元数据。

**响应**：`201`，内容引用（`ContentRef`）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | `content_refs` 行 ULID |
| `ownerType` | `asset` \| `work` | 所属对象类型 |
| `ownerId` | string | 所属对象 id |
| `provider` | `ragflow` | 内容提供方，当前只有这一个 |
| `datasetId` | string | RAGFlow dataset id |
| `documentId` | string | RAGFlow 文档 id。**可变指针**：替换主内容后必变，不要拿它当身份 |
| `contentKey` | string | 幂等键，见上文 |
| `role` | `primary` \| `attachment` | 内容角色 |
| `documentName` | string \| null | 写入 RAGFlow 的文件名 |
| `contentHash` | string \| null | 文件内容的 SHA-256（hex） |
| `mime` | string \| null | 客户端声明的 MIME；未声明为 `null` |
| `sizeBytes` | number \| null | 字节数 |
| `parseStatus` | `pending` \| `running` \| `succeeded` \| `failed` | 上传触发解析成功后为 `running`；触发失败则为 `pending`，之后由轮询推进 |
| `parseError` | string \| null | 解析失败原因；`failed` 时取 RAGFlow `progress_msg` 最后一行（最多 1000 字符），其余情况为 `null` |
| `syncState` | `pending` \| `synced` \| `sync_failed` \| `deleted` | 刚上传时为 `pending`；worker 投递成功后 `synced`，文档已被删则 `sync_failed`，删除任务完成后 `deleted` |
| `lastSyncedAt` | string \| null | 最近一次成功同步时间；从未同步为 `null` |
| `createdAt` / `updatedAt` | string | UTC ISO-8601 |
| `deletedAt` | string \| null | 软删除时间 |

```json
{
  "id": "01JBREF0000000000000000000",
  "ownerType": "work",
  "ownerId": "01JBDEMO000000000000000000",
  "provider": "ragflow",
  "datasetId": "cdca6016dd9d11f1820ba6aa99b57ab2",
  "documentId": "9f3c1e7a2b4d4c8e",
  "contentKey": "obj:01JBDEMO000000000000000000:primary",
  "role": "primary",
  "documentName": "note.txt",
  "contentHash": "3f786850e387550fdab836ed7e6dc881de23001b…",
  "mime": "text/plain",
  "sizeBytes": 42,
  "parseStatus": "running",
  "parseError": null,
  "syncState": "pending",
  "lastSyncedAt": null,
  "createdAt": "2026-11-11T07:20:00.000Z",
  "updatedAt": "2026-11-11T07:20:00.000Z",
  "deletedAt": null
}
```

**主要错误**：

| 状态 / 错误码 | 场景 |
|---------------|------|
| 400 `VALIDATION_FAILED` | 请求体不是 multipart；缺 `file` 或 `file` 不是文件；空文件；> 25 MB；`role` 非法；`documentName` 非字符串或超 200 字节；RAGFlow 返回 400 / 422 |
| 401 `UNAUTHORIZED` | 未登录 |
| 404 `NOT_FOUND` | 对象不存在 / 已删除 / 不属于当前用户（不触达 RAGFlow）；RAGFlow 返回 404 |
| 409 `CONFLICT` | RAGFlow 返回 409 |
| 500 `INTERNAL` | 缺 `RAGFLOW_BASE_URL` / `RAGFLOW_API_KEY`；RAGFlow 返回 5xx 或非 JSON；上传响应里没有 `document_id`；其他未预期异常 |

**已知限制**：没有删除单条内容 / 解绑附件的接口（删除仍走对象级 `DELETE` + worker）；同名文档在 RAGFlow 上的行为不确定（第二次上传会返回新 id，但列表里可能出现 `(1)` 后缀），因此替换流程一律走「临时名 + 改名」，调用方不要依赖 RAGFlow 侧的文件名去认文档。

---

### 4.11 `GET /api/objects/{id}/content`

列出该对象的内容引用（含解析与同步状态），按 `createdAt` 正序。已软删除的引用不返回。对象本身不存在 / 已删除 / 不属于当前用户 → `404`，与详情接口口径一致。

**路径参数**：`id` —— 对象 ULID。

**响应**：`200`，`ContentRef` 数组，**没有外层包装**（不是 `{ items: [...] }`）。

字段与 4.10 的响应表完全一致，常用字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | 内容引用 ULID，下载时作为 `refId` |
| `role` | `primary` \| `attachment` | 内容角色；每个对象至多一个有效主引用 |
| `documentId` | string | RAGFlow 文档 id，**可变指针**，不要当身份 |
| `documentName` | string \| null | 写入 RAGFlow 的文件名 |
| `parseStatus` | `pending` \| `running` \| `succeeded` \| `failed` | 解析进度 |
| `parseError` | string \| null | 解析失败原因 |
| `syncState` | `pending` \| `synced` \| `sync_failed` \| `deleted` | outbox 对账状态 |
| `sizeBytes` | number \| null | 文件字节数 |
| `createdAt` | string | UTC ISO-8601 |

完整字段（`ownerType`、`provider`、`datasetId`、`contentKey`、`contentHash`、`mime`、`lastSyncedAt`、`updatedAt`、`deletedAt`）以 `src/domain/content-ref.ts` 的 `ContentRef` 为准。

```json
[
  {
    "id": "01JBREF0000000000000000000",
    "ownerType": "work",
    "ownerId": "01JBDEMO000000000000000000",
    "provider": "ragflow",
    "datasetId": "cdca6016dd9d11f1820ba6aa99b57ab2",
    "documentId": "9f3c1e7a2b4d4c8e",
    "contentKey": "obj:01JBDEMO000000000000000000:primary",
    "role": "primary",
    "documentName": "note.txt",
    "contentHash": "3f786850e387550fdab836ed7e6dc881de23001b…",
    "mime": "text/plain",
    "sizeBytes": 42,
    "parseStatus": "succeeded",
    "parseError": null,
    "syncState": "synced",
    "lastSyncedAt": "2026-11-11T07:20:05.000Z",
    "createdAt": "2026-11-11T07:20:00.000Z",
    "updatedAt": "2026-11-11T07:20:05.000Z",
    "deletedAt": null
  }
]
```

没有内容时返回 `[]`，不是 404。

**主要错误**：`401`、`404`（对象不存在 / 已删除 / 不属于当前用户）。

---

### 4.12 `GET /api/objects/{id}/content/{refId}`

下载内容原文：服务端从 RAGFlow 取文件流并透传，不落本地磁盘、不做转码。

**路径参数**：

| 参数 | 说明 |
|------|------|
| `id` | 对象 ULID |
| `refId` | 内容引用 ULID，取自 4.11 列表 |

**成功响应**：`200`，二进制文件流，不是 JSON。

| 响应头 | 值 |
|--------|----|
| `Content-Type` | 透传 RAGFlow 的响应头；本机实测为 `application/octet-stream`，不保证与实际文件类型一致 |
| `Content-Disposition` | `attachment; filename*=UTF-8''<URL 编码文件名>`；文件名优先取 RAGFlow 响应里的名字，其次 `documentName`，都没有时用 `content` |
| `Content-Length` | 仅当 RAGFlow 返回了有效长度时携带 |
| `Cache-Control` | `private, no-store` |

> 这条链路对应 RAGFlow 的 `GET /api/v1/datasets/{dataset_id}/documents/{document_id}`——它返回文件流，**不是** JSON 详情接口。要文档元数据（解析状态、chunk 数）请走列表接口 `GET /documents?page=&page_size=`，不要拿这个路径当详情用。

```bash
curl -s -D headers.txt -o downloaded.bin \
  "$BASE/api/objects/<id>/content/<refId>"
```

实测（RAGFlow v0.20.5，本机）：下载得到的字节与上传文件逐字节一致；响应头里是 `application/octet-stream`，因此不要用它判断文件类型，按 `documentName` 的扩展名或本地记录的 `mime` 判断。

**失败响应**：

| 状态 / 错误码 | 响应体 | 场景 |
|---------------|--------|------|
| 401 | **纯文本**「请先登录」 | 未登录。该 401 是本接口唯一不走 JSON 信封的响应 |
| 404 `NOT_FOUND` | JSON 信封 | 对象不存在 / 已删除 / 不属于当前用户；`refId` 不存在、已软删除或不属于该对象 |
| 500 `INTERNAL` | JSON 信封 | 缺 `RAGFLOW_BASE_URL` / `RAGFLOW_API_KEY`；RAGFlow 5xx、超时或网络错误 |

> `refId` 的归属会在取文件前校验，拿别的对象的 `refId` 拼到自己的对象下只会得到 404。

---

## 5. 内容检索

### 5.1 `GET /api/search`

在 RAGFlow 里做语义检索，返回当前用户**未归档**对象的内容片段。RAGFlow 负责召回，业务库负责归属、归档与库别过滤——不能把 RAGFlow 的原始结果直接当接口响应。

**查询参数**：

| 参数 | 必填 | 取值 | 说明 |
|------|------|------|------|
| `q` | **是** | trim 后 1–200 字符 | 检索词；缺失、空白或超长 → 400 |
| `limit` | 否 | 1–50 的整数，**默认 10** | 返回条数上限；0、51、小数、非数字 → 400 |
| `library` | 否 | `internal` \| `external` | 只返回该库的对象；其他值 → 400（`details.allowed` 给出合法取值） |
| `threshold` | 否 | 0–1 的小数，**默认 0.2** | 相似度阈值，低于它的片段不返回；越界或非数字 → 400 |

**执行规则**：

- Dataset 解析与上传一致：`RAGFLOW_DATASET_ID` 优先，否则按 `RAGFLOW_DATASET_NAME`（默认 `pakp-content`）查找。**找不到 dataset 时返回空结果**（`hits: []`、`total: 0`），不是错误——说明还没有任何内容。
- 先按 `limit * 3`（上限 50）多召回一些，再过滤，抵消归属与归档造成的损耗。
- 每个命中的 `document_id` 在 `content_refs` 里认回引用；认不回的片段直接丢弃。
- 引用对应的对象必须属于当前用户，且**已归档对象不返回**（`archivedAt !== null` 一律过滤）。
- 传了 `library` 时只保留该库的对象。
- `total` 是**过滤后**的条数，等于 `hits.length`；不是召回总数，也不是分页总数。

**响应**：`200`

| 字段 | 类型 | 说明 |
|------|------|------|
| `question` | string | 回显 trim 后的查询词 |
| `hits[].chunkId` | string | RAGFlow chunk id |
| `hits[].content` | string | 片段正文 |
| `hits[].highlight` | string \| null | RAGFlow 返回的高亮片段；没有则为 `null` |
| `hits[].similarity` | number | 相似度，0–1 |
| `hits[].documentId` | string | RAGFlow 文档 id |
| `hits[].documentName` | string \| null | RAGFlow chunk 里的文档名（`document_keyword`）；为空则 `null` |
| `hits[].refId` | string | 内容引用 ULID，可用于 4.12 下载原文 |
| `hits[].role` | `primary` \| `attachment` | 命中内容在该对象里的角色 |
| `hits[].object.id` / `type` / `title` / `library` / `status` / `format` | — | 所属对象的关键字段；资产的 `status` / `format` 为 `null` |
| `total` | number | 过滤后的命中条数 |

```json
{
  "question": "知识管理",
  "hits": [
    {
      "chunkId": "a1b2c3d4e5f6",
      "content": "个人知识管理的关键是把碎片整理成可复用的资产……",
      "highlight": "个人<em>知识管理</em>的关键是把碎片整理成可复用的资产……",
      "similarity": 0.42,
      "documentId": "9f3c1e7a2b4d4c8e",
      "documentName": "note.txt",
      "refId": "01JBREF0000000000000000000",
      "role": "primary",
      "object": {
        "id": "01JBDEMO000000000000000000",
        "type": "work",
        "title": "第一篇长文",
        "library": "internal",
        "status": "draft",
        "format": "article"
      }
    }
  ],
  "total": 1
}
```

实测（RAGFlow v0.20.5，本机，单文档单 chunk）：命中的相似度约 0.38–0.48；对象归档后再查同一关键词返回 0 条。

**主要错误**：

| 状态 / 错误码 | 场景 |
|---------------|------|
| 400 `VALIDATION_FAILED` | `q` 缺失 / 空白 / 超 200 字符；`limit` 非 1–50 整数；`library` 非法；`threshold` 不在 0–1 |
| 401 `UNAUTHORIZED` | 未登录 |
| 500 `INTERNAL` | 缺 `RAGFLOW_BASE_URL` / `RAGFLOW_API_KEY`；RAGFlow 5xx、超时或响应结构不符 |

> 空查询 `?q=` 是 400，不是「返回全部」。这与列表接口「空串等同未传」的约定不同，因为检索没有「不筛选」的语义。

---

## 6. 系统接口

### 6.1 `GET /api/health`

健康检查，无需登录，**不使用**统一错误信封（保持原有形状，便于探活脚本）。

**响应**：`200`

```json
{
  "status": "ok",
  "service": "personal-asset-knowledge-platform",
  "timestamp": "2026-11-11T06:00:00.000Z"
}
```

该接口不检查数据库与外部依赖（RAGFlow / Logto）可达性，只表示 Next.js 进程可响应。

### 6.2 `POST /api/sync/run`

手动触发**一轮** outbox 投递：认领已到期的 `sync_jobs` 并调用 RAGFlow。后台 worker 跑的是同一段逻辑（`runSyncOnce`），这个端点用于排障、脚本化或想立刻生效时手动催一次。

**请求体**：无（传了也不读）。

**执行规则**：

- 单次最多认领 **20** 条任务；`running` 超过 5 分钟视为租约过期，可被重新认领。
- `upsert`：按 `content_key` 认回文档，用对象**当前**的 `library` / `archived` / `format` / `source` 整体重写 `meta_fields`，成功后引用标 `synced` 并写 `lastSyncedAt`。对象已软删除时该任务直接完成（目标不存在）。
- `delete`：删除该对象在 RAGFlow 的全部文档，再软删本地引用；RAGFlow 返回 404 视为已达成目标。
- 失败的任务回到 `pending` 按指数退避重试，达到上限置 `failed`；**失败不影响 HTTP 状态**——端点仍返回 200，失败明细在 `errors` 里。
- **不按调用者归属过滤**：队列里属于任何对象（含其他 `ownerSub`）的到期任务都会被处理，worker 以系统身份运行。

**响应**：`200`

| 字段 | 类型 | 说明 |
|------|------|------|
| `claimed` | number | 本轮认领的任务数 |
| `done` | number | 成功完成数 |
| `failed` | number | 失败数（已按退避安排重试） |
| `errors` | array | 失败明细：`jobId`、`ownerType`、`ownerId`、`action`、`message` |

```json
{
  "claimed": 2,
  "done": 1,
  "failed": 1,
  "errors": [
    {
      "jobId": "01JBJOB0000000000000000000",
      "ownerType": "work",
      "ownerId": "01JBDEMO000000000000000000",
      "action": "upsert",
      "message": "RAGFlow PUT /api/v1/datasets/{id}/documents/{doc_id} 返回 HTTP 502"
    }
  ]
}
```

**主要错误**：

| 状态 / 错误码 | 场景 |
|---------------|------|
| 401 `UNAUTHORIZED` | 未登录 |
| 500 `INTERNAL` | 缺 `RAGFLOW_BASE_URL` / `RAGFLOW_API_KEY`（构造客户端时即失败，此时一条任务也不会被认领） |

> `errors` 里的 `message` 来自 RAGFlow 的错误响应，属于外部系统文案，**不要**把它当作稳定字段解析。

**后台 worker（不是 HTTP 接口，但影响可观察行为）**：

| 项 | 行为 |
|----|------|
| 启动方式 | `src/instrumentation.ts` 在 Node 运行时调用 `startSyncWorker()` |
| 启动条件 | 必须同时配置 `RAGFLOW_BASE_URL` 与 `RAGFLOW_API_KEY`；`SYNC_WORKER_ENABLED=false` 显式关闭 |
| 间隔 | `SYNC_WORKER_INTERVAL_MS`，默认 30000 ms；小于 5000 按默认值处理。该间隔同时驱动 outbox 投递与解析轮询 |
| 每轮做什么 | 先跑一轮 outbox 投递（最多 20 条），再跑一轮解析状态轮询（最多 50 条，见 6.3）；两段互不影响 |
| 并发保护 | 进程内用标志位避免重入；多进程部署各自认领，靠 `claimJobs` 的原子认领保证同一任务不被处理两次 |

---

### 6.3 `POST /api/parse/run`

手动推进**一轮**解析状态轮询：把 RAGFlow 的文档解析进度回写到 `content_refs.parse_status`。后台 worker 每轮跑的是同一段逻辑（`pollParsingOnce`），这个端点用于排障或想让状态立刻更新时手动催一次。

**请求体**：无（传了也不读）。

**执行规则**：

- 每轮最多检查 **50** 条引用：`parseStatus` 为 `pending` 或 `running`、且未软删除的，按 `updatedAt` 正序取前 50 条。
- 按 `datasetId` 分组，逐组调用 `GET /api/v1/datasets/{id}/documents?page=&page_size=`（`page_size` 默认 100，每组最多翻 50 页），建立 `documentId → 文档` 索引。
- 状态映射：

| RAGFlow `run` | 应用侧动作 | 计入结果 |
|---------------|-----------|----------|
| `UNSTART` | 补触发一次解析（`POST /chunks`） | `started` |
| `RUNNING` / `SCHEDULE` | 引用置 `running`，清空 `parseError` | `running` |
| `DONE` | 引用置 `succeeded`，清空 `parseError` | `succeeded` |
| `FAIL` / `CANCEL` | 引用置 `failed`，`parseError` 取 `progress_msg` 最后一行（最多 1000 字符）；`CANCEL` 不计入 `errors` | `failed` |
| 文档不存在 | 引用置 `failed`，`parseError` 为「RAGFlow 文档不存在（可能已被删除）」 | `failed`，同时进 `errors` |
| 其他未知值 | 不改状态 | 进 `errors` |

- **单条失败不拖垮整轮**：某个 dataset 的文档列表请求失败时，该组的引用只进 `errors`、状态不变，其他组照常处理，接口仍返回 200。
- **不按调用者归属过滤**：与其他引用一样，轮询会处理队列中任何 `ownerSub` 的引用，以系统身份运行。

**响应**：`200`

| 字段 | 类型 | 说明 |
|------|------|------|
| `checked` | number | 本轮取到的引用数（≤ 50） |
| `started` | number | 本轮补触发解析的文档数 |
| `running` | number | RAGFlow 侧仍在解析的数 |
| `succeeded` | number | 本轮确认为解析成功的数 |
| `failed` | number | 失败数（含文档不存在） |
| `errors` | array | 失败明细：`refId`、`documentId`、`message` |

```json
{
  "checked": 2,
  "started": 0,
  "running": 1,
  "succeeded": 1,
  "failed": 0,
  "errors": []
}
```

没有待处理的引用时返回全 0 且 `errors: []`，不报错。

**主要错误**：

| 状态 / 错误码 | 场景 |
|---------------|------|
| 401 `UNAUTHORIZED` | 未登录 |
| 500 `INTERNAL` | 缺 `RAGFLOW_BASE_URL` / `RAGFLOW_API_KEY`（仅在本轮确实有待处理引用、需要构造客户端时才触发；没有待处理引用时正常返回全 0） |

> 实测（RAGFlow v0.20.5，本机）：上传后引用立即为 `running`，约 9–12 秒后解析完成，下一轮轮询回写 `succeeded`，文档 `chunk_count = 1`。

---

## 7. 知识图谱

图谱接口把业务对象的主内容同步进 LightRAG，并提供实体、邻域与图增强问答。所有接口都要求登录；LightRAG 不可用时返回 `500 INTERNAL`。

> **单租户限制**：LightRAG 的图 / 问答路由绑定默认 workspace，不按 `ownerSub` 隔离实体与答案正文。当前仅适用于单用户本机部署；`POST /api/graph/query` 的来源对象会按归属过滤，但答案文本仍可能包含其他用户写入的内容。开放多用户前必须先做实例级隔离。

### 7.1 `GET /api/graph/labels`

返回图谱中的全部实体标签，供实体列表使用。

**请求**：无参数。

**响应**：`200`

```json
{ "labels": ["#2B6CB0", "前端设计团队", "品牌蓝"] }
```

排序由 LightRAG 决定（字典序），可能包含抽取噪声（如单独的 `#`）；前端只在展示时把含文字 / 数字的实体排在前面，不删除数据。

**主要错误**：401 未登录；500 LightRAG 请求失败或响应格式异常。

---

### 7.2 `GET /api/graph`

读取一个实体的邻域子图。

**查询参数**：

| 参数 | 必填 | 说明 |
|------|------|------|
| `label` | 是 | 实体名，1–100 字符；空或超长返回 400 |
| `depth` | 否 | 1–3 的整数，默认 2；非法值返回 400 |

**响应**：`200`

```json
{
  "nodes": [
    { "id": "#2B6CB0", "type": "UNKNOWN", "description": "用于统一产品界面配色的深色系主色调。" },
    { "id": "品牌蓝", "type": "UNKNOWN", "description": "用于统一产品界面配色的深色系主色调。" }
  ],
  "edges": [
    { "source": "#2B6CB0", "target": "品牌蓝", "description": "用于统一产品界面配色的深色系主色调。" }
  ]
}
```

- `type` 取 LightRAG 的 `entity_type`，缺省为 `UNKNOWN`；`description` 缺失时为空字符串。
- 节点上限固定 150；子图沿**有向边**展开，只有入边的实体会返回空图。

**主要错误**：400 参数非法；401 未登录；500 LightRAG 失败。

---

### 7.3 `POST /api/graph/sync`

把当前用户的对象内容同步进 LightRAG。**只负责入库**，实体抽取在 LightRAG 后台异步进行，进度看 7.4。

**请求体**：无（忽略）。

**执行规则**：

- 最多检查 **50** 个未归档、未删除的对象（`listObjects` 默认顺序）。
- 只取 `role=primary`、`parseStatus=succeeded`、未软删除的内容引用；按 `pageSize=100` 拉取 RAGFlow 分块，拼成图谱文本（标题、类型、库别、状态、描述、分类、标签 + 正文）。
- `file_source` 为 `pakp:obj:{objectId}:{sha256 前 12 位}`；同一对象已有相同哈希的文档 → 计入 `unchanged`，不重复抽取。
- 内容变化时先删除该对象的旧版本文档，再写入新版本。
- 没有解析成功主内容的对象进 `skipped`，不算失败。

**响应**：`200`

```json
{
  "candidates": 12,
  "submitted": 3,
  "unchanged": 8,
  "skipped": [{ "objectId": "01...", "title": "示例", "reason": "还没有解析成功的主内容" }],
  "removed": 1,
  "errors": []
}
```

| 字段 | 说明 |
|------|------|
| `candidates` | 本轮参与检查的对象数（≤ 50） |
| `submitted` | 已送进 LightRAG、等待抽取的对象数 |
| `unchanged` | 内容哈希未变、跳过的对象数 |
| `skipped` | 无可构图内容的对象及原因 |
| `removed` | 清理掉的旧版本图文档数 |
| `errors` | 单个对象处理失败明细（`objectId`、`title`、`message`），不影响其他对象 |

**主要错误**：401 未登录；500 无法构造 LightRAG / RAGFlow 客户端。

---

### 7.4 `GET /api/graph/status`

汇总 LightRAG 中**本系统写入**的图文档状态（`file_path` 以 `pakp:obj:` 开头）。

**响应**：`200`

```json
{
  "total": 3,
  "byStatus": { "processed": 2, "processing": 1 },
  "objects": [{ "objectId": "01...", "status": "processing", "error": null }],
  "failed": []
}
```

- `byStatus` 的键来自 LightRAG（实测有 `pending` / `processing` / `processed` / `failed`）。
- 同一对象存在多个版本时逐个列出，不做去重。
- 手工放入 LightRAG、未带 `pakp:` 前缀的文档不会计入。

**主要错误**：401 未登录；500 LightRAG 失败。

---

### 7.5 `POST /api/graph/query`

图增强问答：同时使用实体关系与内容片段，返回答案与来源业务对象。

**请求体**：

```json
{ "q": "品牌蓝是什么？它的对比度要求是多少？" }
```

- `q` 必填，1–200 字符；缺失或非字符串返回 400。
- 查询模式固定 `mix`（图谱 + 向量）。

**响应**：`200`

```json
{
  "question": "品牌蓝是什么？",
  "response": "品牌蓝是……",
  "references": [
    { "objectId": "01...", "title": "设计系统色彩规范", "type": "asset", "library": "internal" }
  ]
}
```

- `response` 为纯文本（可能含 Markdown 标题），前端按 `white-space: pre-wrap` 渲染。
- `references` 只包含 `pakp:obj:` 前缀且属于当前用户的对象；同一对象去重。没有可映射引用时为空数组。
- **可能很慢**：本机 CPU 实测约 94 秒，适配器超时 180 秒。调用方应设置 ≥ 180 秒的超时，不要在页面同步阻塞之外的地方重试。

**主要错误**：400 `q` 非法；401 未登录；500 LightRAG 请求失败或超时。

---

## 8. Logto 登录路由（浏览器跳转，非 JSON 接口）

三条路由供页面跳转使用，**不要**在脚本里当 JSON API 调用。

| 方法 | 路径 | 行为 |
|------|------|------|
| GET | `/api/logto/sign-in` | 302/307 跳转到 Logto 授权页；回调地址为 `${APP_URL}/api/logto/sign-in-callback`，登录成功后回 `/workspace` |
| GET | `/api/logto/sign-in-callback` | 处理授权码、写入会话 Cookie，然后重定向到 `/workspace` |
| GET | `/api/logto/sign-out` | 清除会话，重定向到 `/` |

前提条件：

- 仅在 `AUTH_MODE=logto` 且 `LOGTO_ENDPOINT`、`LOGTO_APP_ID`、`LOGTO_APP_SECRET`、`LOGTO_COOKIE_SECRET` 均已配置时可用；缺任一变量会抛错（接口返回 500），**不会**静默降级为未登录。
- `AUTH_MODE=mock` / `disabled` 时页面不展示登录入口；路由本身仍存在，但调用会因缺少 Logto 配置而失败。
- 生产环境 Cookie 带 `Secure`；`APP_URL` 默认 `http://localhost:3000`。

前端入口：首页在 `AUTH_MODE=logto` 时显示「登录」按钮（`/api/logto/sign-in`），工作台侧栏显示「退出」（`/api/logto/sign-out`）；`mock` / `disabled` 下两个入口都不渲染。

> 浏览器内完整登录（换码并进入 `/workspace`）**尚未人工验证**，见 `07_PLAYBOOK.md` 第 7 节。

---

## 9. curl 示例（`AUTH_MODE=mock`，本地直接可用）

开发环境默认就是 `AUTH_MODE=mock`，无需登录、无需 Cookie。

```bash
BASE=http://localhost:3000

# 1. 健康检查
curl -s $BASE/api/health

# 2. 新建作品（作品固定从 draft 开始）
curl -s -X POST $BASE/api/objects \
  -H 'Content-Type: application/json' \
  -d '{
    "type": "work",
    "title": "第一篇长文",
    "library": "internal",
    "format": "article",
    "categories": ["写作"],
    "tags": ["长文"]
  }'

# 3. 列出作品：默认不含已归档、已删除，默认 100 条
curl -s "$BASE/api/objects?type=work&library=internal"

# 4. 关键字 + 分类 + 排序 + 分页（非法值一律 400）
curl -s -G "$BASE/api/objects" \
  --data-urlencode "q=知识" \
  --data-urlencode "category=写作" \
  -d "status=draft&sort=created&limit=20&offset=0"

# 5. 读取单个对象（他人对象 / 已删除 都返回 404）
curl -s $BASE/api/objects/<id>

# 6. 编辑标题（expectedRevision 必填，取上一步返回的 revision）
curl -s -X PATCH $BASE/api/objects/<id> \
  -H 'Content-Type: application/json' \
  -d '{ "expectedRevision": 1, "title": "第一篇长文（修订）" }'

# 7. 状态迁移 draft -> finished
curl -s -X POST $BASE/api/objects/<id>/status \
  -H 'Content-Type: application/json' \
  -d '{ "to": "finished", "expectedRevision": 2 }'

# 8. 跨库迁移（reason 必填）
curl -s -X POST $BASE/api/objects/<id>/library \
  -H 'Content-Type: application/json' \
  -d '{ "to": "external", "reason": "来源待核验", "expectedRevision": 3 }'

# 9. 查迁移审计（时间正序；从未迁移返回 []）
curl -s $BASE/api/objects/<id>/library

# 10. 归档 / 取消归档
curl -s -X POST $BASE/api/objects/<id>/archive \
  -H 'Content-Type: application/json' \
  -d '{ "archived": true }'

# 11. 上传主内容（multipart；25 MB 以内，空文件会被拒绝）
curl -s -X POST $BASE/api/objects/<id>/content \
  -F "file=@note.txt" \
  -F "role=primary" \
  -F "documentName=第一篇长文.txt"

# 12. 追加一个附件（每次上传生成新的 content_key）
curl -s -X POST $BASE/api/objects/<id>/content \
  -F "file=@appendix.pdf" \
  -F "role=attachment"

# 13. 手动催一轮 outbox 投递（返回 claimed / done / failed）
curl -s -X POST $BASE/api/sync/run

# 14. 手动催一轮解析状态轮询（返回 checked / started / running / succeeded / failed / errors）
curl -s -X POST $BASE/api/parse/run

# 15. 列出对象的内容引用（含 parseStatus / syncState）
curl -s $BASE/api/objects/<id>/content

# 16. 下载内容原文（refId 取自上一步返回的 id；响应是文件流）
curl -s -D headers.txt -o downloaded.bin \
  "$BASE/api/objects/<id>/content/<refId>"

# 17. 内容检索（q 必填；limit 1-50，默认 10；threshold 0-1，默认 0.2）
curl -s -G "$BASE/api/search" \
  --data-urlencode "q=知识管理" \
  -d "limit=10&library=internal&threshold=0.2"

# 18. 软删除（预期 204，无响应体）
curl -s -i -X DELETE $BASE/api/objects/<id>

# 19. 图谱实体列表与某个实体的两层邻域
curl -s $BASE/api/graph/labels
curl -s -G "$BASE/api/graph" \
  --data-urlencode "label=品牌蓝" -d "depth=2"

# 20. 同步对象内容进 LightRAG（返回后仍在后台抽取，在 LightRAG 里耗时数分钟）
curl -s -X POST $BASE/api/graph/sync
curl -s $BASE/api/graph/status

# 21. 图增强问答（可能约 90 秒，curl 不要设太短的超时）
curl -s --max-time 180 -X POST $BASE/api/graph/query \
  -H "Content-Type: application/json" \
  --data-binary @question.json
```

`<id>` 替换为上一步返回的对象 `id`，`<refId>` 替换为内容引用列表里的 `id`；示例里的 `revision` 需要按实际返回值调整。中文问题请写进 `question.json`（内容形如 `{"q":"品牌蓝是什么？"}`）再用 `--data-binary @question.json` 提交，Windows 下不要把中文直接内联在 `-d` 里。

内容上传、解析轮询、内容下载与检索都依赖真实 RAGFlow：`.env.local` 里要有 `RAGFLOW_BASE_URL` 与 `RAGFLOW_API_KEY`，缺任一项这些接口返回 500（对象增删改查与 `/api/health` 不受影响）。检索在 dataset 尚未创建时返回空结果而不是错误。

图谱接口依赖本机 LightRAG：`.env.local` 里要有 `LIGHTRAG_BASE_URL`（默认 `http://127.0.0.1:9621`）与 `LIGHTRAG_API_KEY`；LightRAG 未启动或密钥不对时返回 500。图谱内容来自 RAGFlow 已解析的主内容，两者都可用才有意义。

---

## 10. 尚未实现（不要按这些能力设计调用方）

以下能力**当前代码中不存在**，本文不作契约承诺：

| 能力 | 现状 |
|------|------|
| 内容删除 / 附件解绑 | 未实现。没有删除某条 `content_ref`、列出对象全部附件或解绑单个附件的接口；删除只能走对象级 `DELETE` + worker（整对象全部文档） |
| RAGFlow 问答会话 | 未实现。检索接口只返回召回片段，不组装上下文、不调用 chat model，也没有多轮会话 |
| 图谱多用户隔离 | 未实现。LightRAG 图 / 问答路由绑定单实例默认 workspace，`/api/graph/*` 只适用于单用户本机部署（见第 7 节顶部说明） |
| 图谱自动同步 | 未实现。没有定时同步或对象变更后自动入图；只能手动 `POST /api/graph/sync`，且单轮最多 50 个对象 |
| 图谱实体 / 关系编辑 | 未实现。实体与关系只来自 LightRAG 抽取，不能改名、合并或手工补边 |
| 列表总数 / 游标 | 未实现。`GET /api/objects` 只返回数组，没有 `total`、页码或游标 |
| 多用户权限 / 角色 / 共享 | 未实现。只有按 `ownerSub` 的单用户归属过滤，没有角色或协作概念。注意 `/api/sync/run`、`/api/parse/run` 与后台 worker 不按调用者过滤（见 6.2、6.3） |
| OpenAPI / Swagger 描述文件 | 未实现。本文是唯一接口说明 |
| 同步投递与解析轮询的失败路径实测 | 失败重试 / 退避 / 解析失败回写目前只有假网关单测覆盖；真实 RAGFlow 上验证的是成功路径（上传 → 解析完成 → 检索 → 下载 → 归档后检索为 0） |

> 检索的相似度由 RAGFlow 的 embedding 模型决定，换模型或换解析器后同样的查询会得到不同的分数与排序。阈值 0.2 只是默认值，不是质量承诺。

---

## 11. 变更记录

| 日期 | 变更 |
|------|------|
| 2026-11-11 | 首版：覆盖 `health`、`objects` 七个端点与三条 Logto 跳转路由；补充错误码表与未实现清单 |
| 2026-11-11（HEAD `49e26de`） | 补入四个新能力：`GET /api/objects/{id}`（对象详情）、`GET /api/objects/{id}/library`（迁移审计读取）、`POST /api/objects/{id}/content`（multipart 内容上传与 RAGFlow 映射）、`GET /api/objects` 的 `q` / `category` / `tag` / `status` / `sort` / `limit` / `offset`。端点总览更新为 14 条；未实现清单删去已实现的条目 |
| 2026-11-11（HEAD `1ea0b86`） | 补入 outbox 消费端：新增 `POST /api/sync/run` 与后台 worker 行为（启动条件、间隔、认领上限、失败退避），端点总数 15 条；更新 PATCH / DELETE / 跨库迁移里「只入队不投递」的旧表述；未实现清单移除「同步 worker 未实现」，保留解析轮询、检索、下载与 OpenAPI 等当时仍缺失的能力。同日已在真实 RAGFlow 上端到端验证投递：迁移库别后 meta 回读为 `library=external`、删除对象后文档从数据集消失；失败重试仍为假网关单测 |
| 2026-11-11（HEAD `a7aa5f3`） | 列表 `archived` 参数扩展为 `true` / `false` / `only`，非法取值改为 400（此前非 `true` 的值被静默忽略） |
| 2026-11-11（HEAD `b860530`） | 补入四条内容链路接口：`POST /api/parse/run`（手动解析轮询，单轮 50 条）、`GET /api/objects/{id}/content`（内容引用列表）、`GET /api/objects/{id}/content/{refId}`（原文下载，二进制流）、`GET /api/search`（内容检索，含归属 / 归档 / 库别过滤）；端点总数 19 条。上传章节改为「上传即触发解析」，第 10 节移除已实现的解析轮询、检索、下载与内容列表。实测（RAGFlow v0.20.5）：上传即 `running`，9–12 秒后 `succeeded`、`chunk_count=1`；检索相似度 0.38–0.48；下载与上传文件逐字节一致；归档后同一检索 0 条 |
| 2026-11-11（Phase 3） | 新增第 7 节「知识图谱」五条接口：`GET /api/graph/labels`、`GET /api/graph`、`POST /api/graph/sync`、`GET /api/graph/status`、`POST /api/graph/query`；端点总数 24 条。标注单 workspace 限制、50 对象同步上限、`pakp:obj:` 来源前缀、问答 180 秒超时。未实现清单移除「LightRAG 知识图谱」，新增图谱多用户隔离、自动同步、实体编辑三条。实测（LightRAG 1.5.7，本机 CPU）：118 字文档抽取约 3.8 分钟、9 实体 / 3 关系；`mix` 问答 93.8 秒 |
