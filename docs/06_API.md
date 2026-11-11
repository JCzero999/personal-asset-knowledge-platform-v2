# HTTP API 参考

> **适用对象**：调用本服务接口的前端 / 脚本开发者，以及需要核对接口契约的后端开发者。
> **文档范围**：只记录 `src/app/api/` 下**当前已实现**的路由。未实现的能力统一列在第 8 节，避免把规划当成契约。
> **核对依据**（2026-11-11，HEAD `a7aa5f3`）：`src/app/api/**/route.ts`、`src/server/http/respond.ts`、`src/server/services/{object,content,sync}-service.ts`、`src/server/sync-worker-runtime.ts`、`src/server/adapters/ragflow/client.ts`、`src/server/session.ts`、`src/domain/{errors,objects,workflow,content-ref}.ts`、`src/server/repositories/{sqlite-object-repository,sqlite-content-store}.ts`。代码与本文不一致时以代码为准，并回头修本文。

---

## 1. 通用约定

### 1.1 Base URL 与运行方式

| 项 | 值 |
|----|----|
| 开发环境默认地址 | `http://localhost:3000` |
| 可配置项 | `APP_URL`（Logto 回调与跳转使用；未设置时按 `http://localhost:3000`） |
| 路由运行时 | 全部为 `runtime = "nodejs"`、`dynamic = "force-dynamic"`，响应不做静态缓存 |
| 启动 | `npm run dev`（Next.js 16） |

除三条 Logto 登录路由（返回重定向，见第 6 节）外，所有接口返回 JSON；唯一的请求体例外是内容上传 `POST /api/objects/{id}/content`，它收 `multipart/form-data`（见 4.10）。

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
- **归属隔离**：所有对象读写都按当前会话的 `sub` 过滤。访问不属于自己的对象时返回 `404 NOT_FOUND`（与「不存在」不区分，避免用 id 探测他人数据）。该规则对详情、编辑、删除、状态迁移、跨库迁移、归档、迁移审计与内容上传**全部生效**。
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

异常统一由 `fromError()` 收敛，未识别的异常一律转为 `INTERNAL`。

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

> 对象结构里**没有**内容字段。正文存在 RAGFlow，业务侧用 `content_refs` 记录映射；目前没有任何接口把内容读回来（见第 8 节）。

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
| POST | `/api/sync/run` | 手动触发一轮 outbox 投递 | 200 |
| GET | `/api/logto/sign-in` | 跳转 Logto 登录（浏览器） | 307 |
| GET | `/api/logto/sign-in-callback` | 登录回调（浏览器） | 307 |
| GET | `/api/logto/sign-out` | 退出并清会话（浏览器） | 307 |

合计 15 条路由：12 条业务 / 系统接口 + 3 条 Logto 跳转。`/api/objects*` 与 `/api/sync/run` 需要会话；`/api/health` 不需要。

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

额外规则：**外库（`external`）作品不能进入 `practiced`**，必须先迁到内库。数据库 CHECK `objects_external_not_practiced` 作为最后防线。

**响应**：`200`，状态已更新、`revision + 1` 的对象。

**主要错误**：

| 状态 / 错误码 | 场景 |
|---------------|------|
| 400 `VALIDATION_FAILED` | `to` 非法；目标是资产（资产没有状态）；`expectedRevision` 非正整数 |
| 401 `UNAUTHORIZED` | 未登录 |
| 404 `NOT_FOUND` | 对象不存在 / 已删除 / 不属于当前用户 |
| 409 `INVALID_TRANSITION` | 跳级、回退、或与当前状态相同（`details` 带 `from` / `to`，跳级时另带 `allowed`） |
| 409 `EXTERNAL_LIBRARY_PRACTICED` | 外库作品试图变为 `practiced` |
| 409 `CONFLICT` | 版本号不一致 |

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

上传对象内容：把文件写进 RAGFlow，并在本地落一条 `content_refs` + 一条 `sync_jobs(upsert)`。这是当前唯一会触达 RAGFlow 的业务接口。

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
- **不触发解析**：上传后不调用 chunk 接口，`parseStatus` 恒为 `pending`（第 8 节）。`syncState` 写入时是 `pending`；上传成功后入队的那条 `upsert` 被 worker 投递成功时变为 `synced` 并写 `lastSyncedAt`。若 RAGFlow 侧该文档已不存在，worker 把引用标为 `sync_failed` 且不重试——重新上传正文会生成新的 `document_id`，状态随之回到 `synced`。
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
| `parseStatus` | `pending` \| `running` \| `succeeded` \| `failed` | 上传后恒为 `pending`（未接线解析） |
| `parseError` | string \| null | 解析错误；当前恒为 `null` |
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
  "parseStatus": "pending",
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

**已知限制**：没有删除内容 / 列出内容的接口；同名文档在 RAGFlow 上的行为不确定（第二次上传会返回新 id，但列表里可能出现 `(1)` 后缀），因此替换流程一律走「临时名 + 改名」，调用方不要依赖 RAGFlow 侧的文件名去认文档。

---

## 5. 系统接口

### 5.1 `GET /api/health`

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

### 5.2 `POST /api/sync/run`

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
| 间隔 | `SYNC_WORKER_INTERVAL_MS`，默认 30000 ms；小于 5000 按默认值处理 |
| 单轮上限 | 20 条，与手动端点一致 |
| 并发保护 | 进程内用标志位避免重入；多进程部署各自认领，靠 `claimJobs` 的原子认领保证同一任务不被处理两次 |

---

## 6. Logto 登录路由（浏览器跳转，非 JSON 接口）

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

## 7. curl 示例（`AUTH_MODE=mock`，本地直接可用）

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

# 14. 软删除（预期 204，无响应体）
curl -s -i -X DELETE $BASE/api/objects/<id>
```

`<id>` 替换为上一步返回的对象 `id`；示例里的 `revision` 需要按实际返回值调整。

内容上传依赖真实 RAGFlow：`.env.local` 里要有 `RAGFLOW_BASE_URL` 与 `RAGFLOW_API_KEY`，缺任一项该接口返回 500（其他接口不受影响）。

---

## 8. 尚未实现（不要按这些能力设计调用方）

以下能力**当前代码中不存在**，本文不作契约承诺：

| 能力 | 现状 |
|------|------|
| 解析状态轮询 | 未实现。`parseStatus` 上传后恒为 `pending`，不回写 `succeeded` / `failed`，也没有 `chunk_count` |
| 解析触发的向量化 | 未接线。不调用 `POST /api/v1/datasets/{id}/chunks`；缺 chat model / embedding 外部 API key |
| 搜索 / 全文检索 / 问答 | 未实现。`GET /api/objects?q=` 只做 SQLite 字段匹配，不查 RAGFlow |
| 内容下载 / 正文读取 | 未接入。RAGFlow 的文档下载接口没有被封装成应用接口 |
| 内容引用查询（`content_refs` 列表） | 未实现。只有上传写入口，没有读取端点；调用方只能看上传响应或数据库 |
| 内容删除 / 附件管理 | 未实现。没有删除某条内容、列出对象全部附件或解绑附件的接口；删除走对象级 `DELETE` + worker |
| 列表总数 / 游标 | 未实现。列表只返回数组，没有 `total`、页码或游标 |
| 多用户权限 / 角色 / 共享 | 未实现。只有按 `ownerSub` 的单用户归属过滤，没有角色或协作概念。注意 `/api/sync/run` 与后台 worker 不按调用者过滤（见 5.2） |
| OpenAPI / Swagger 描述文件 | 未实现。本文是唯一接口说明 |
| 同步投递的真实环境验证 | 已在真实 RAGFlow v0.20.5 上端到端验证「迁移→meta 回读→删除→文档消失」；失败重试与退避仍只有假网关单测覆盖 |

---

## 9. 变更记录

| 日期 | 变更 |
|------|------|
| 2026-11-11 | 首版：覆盖 `health`、`objects` 七个端点与三条 Logto 跳转路由；补充错误码表与未实现清单 |
| 2026-11-11（HEAD `49e26de`） | 补入四个新能力：`GET /api/objects/{id}`（对象详情）、`GET /api/objects/{id}/library`（迁移审计读取）、`POST /api/objects/{id}/content`（multipart 内容上传与 RAGFlow 映射）、`GET /api/objects` 的 `q` / `category` / `tag` / `status` / `sort` / `limit` / `offset`。端点总览更新为 14 条；第 8 节删去已实现的条目 |
| 2026-11-11（HEAD `1ea0b86`） | 补入 outbox 消费端：新增 `POST /api/sync/run` 与后台 worker 行为（启动条件、间隔、认领上限、失败退避），端点总数 15 条；更新 PATCH / DELETE / 跨库迁移里「只入队不投递」的旧表述；第 8 节移除「同步 worker 未实现」，保留解析轮询、检索、下载与 OpenAPI 等真正缺失的能力。同日已在真实 RAGFlow 上端到端验证投递：迁移库别后 meta 回读为 `library=external`、删除对象后文档从数据集消失；失败重试仍为假网关单测 |
| 2026-11-11（HEAD `a7aa5f3`） | 列表 `archived` 参数扩展为 `true` / `false` / `only`，非法取值改为 400（此前非 `true` 的值被静默忽略） |
