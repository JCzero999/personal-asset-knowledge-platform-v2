# HTTP API 参考

> **适用对象**：调用本服务接口的前端 / 脚本开发者，以及需要核对接口契约的后端开发者。
> **文档范围**：只记录 `src/app/api/` 下**当前已实现**的路由。未实现的能力统一列在第 12 节，避免把规划当成契约。
> **核对依据**（2026-11-13）：`src/app/api/**/route.ts`、`src/server/http/respond.ts`、`src/server/http/guard.ts`、`src/server/authz.ts`、`src/server/services/{object,content,sync,parse,search,graph,vocabulary,user,audit}-service.ts`、`src/server/sync-worker-runtime.ts`、`src/server/adapters/ragflow/client.ts`、`src/server/adapters/lightrag/client.ts`、`src/server/session.ts`、`src/domain/{errors,objects,workflow,content-ref}.ts`、`src/server/repositories/{sqlite-object-repository,sqlite-content-store}.ts`。代码与本文不一致时以代码为准，并回头修本文。

---

## 1. 通用约定

### 1.1 Base URL 与运行方式

| 项 | 值 |
|----|----|
| 开发环境默认地址 | `http://localhost:3000` |
| 可配置项 | `APP_URL`（Logto 回调与跳转使用；未设置时按 `http://localhost:3000`） |
| 路由运行时 | 全部为 `runtime = "nodejs"`、`dynamic = "force-dynamic"`，响应不做静态缓存 |
| 启动 | `npm run dev`（Next.js 16） |

除三条 Logto 登录路由（浏览器跳转，见第 10 节）与两条词表旧路径（308 跳转，见 6.9）外，所有接口返回 JSON；另有两点形状差异：内容上传收 `multipart/form-data` 请求体（见 4.10），内容下载成功时返回二进制文件流而非 JSON（见 4.12）。

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
- **权限判定（ADR-019）**：授权来自本地 `users` / `roles` / `permissions` / `role_permissions` / `user_roles` 五张表，**15 项权限 × 4 个系统角色**（`owner` / `admin` / `editor` / `viewer`）。每个接口在 route 层调用 `requirePermission()`（`src/server/authz.ts`，唯一强制层）；缺权限返回 `403 FORBIDDEN`，`details.permission` 指出缺哪一项。矩阵见 7.4，账号与审计接口见 7.5–7.8。
- **`ADMIN_SUBS` 只剩引导作用**：仅当库中没有任何 `active` 的 `owner` 时，白名单命中的 `sub` 首次登录会被写入 `users` 并授予 `owner`；一旦存在 active owner，它不再参与任何授权判断。`AUTH_MODE=mock` 的固定身份恒为 `owner`（`src/server/roles.ts`、`src/server/services/user-service.ts`）。
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
| `QUERY_SYNTAX` | 400 | 检索语句语法错误；`details.position` 为原文中的 0 基出错位置（见 5.1） |
| `TAG_NOT_FOUND` | 400 | 写对象时 `tags` 里出现词表没有的标签（不再静默创建，ADR-023）；`details.tag` 是原值，`details.normalized` 是归一化键 |
| `UNAUTHORIZED` | 401 | 无会话（`AUTH_MODE` 为 `logto` 且未登录，或 `disabled`） |
| `FORBIDDEN` | 403 | 已登录但缺少该接口要求的权限（`requirePermission` 拒绝，ADR-019）；`details.permission` 是缺失的权限键；「任一满足」的接口（词表内联创建）用 `details.permissions` 给出可选集合 |
| `NOT_FOUND` | 404 | 对象不存在、已删除、或不属于当前用户；用户 id 不存在；RAGFlow 返回 404 |
| `CONFLICT` | 409 | 乐观锁版本不一致（`expectedRevision` 与库中 `revision` 不符）；唯一约束冲突；RAGFlow 返回 409 |
| `INVALID_TRANSITION` | 409 | 作品状态迁移不在允许的迁移表中（跳级、回退、原地迁移） |
| `EXTERNAL_LIBRARY_PRACTICED` | 409 | 外库作品被要求变为 `practiced`，或已 `practiced` 的作品要迁回外库 |
| `CATEGORY_EXISTS` | 409 | 同名词表分类已存在（ADR-023，见 6.2） |
| `CATEGORY_ARCHIVED` | 409 | 命中的分类已停用，或迁移目标已停用（ADR-023，见 6.2、6.4） |
| `CONSTRAINT_VIOLATION` | 422 | 数据库 CHECK 约束拒绝写入（服务层漏校验时的最后防线）；`details.reason = "LAST_OWNER"` 表示要移除或停用最后一个所有者（见 7.6） |
| `AUDIT_FAILED` | 500 | 审计写入失败，业务事务回滚（审计与业务写同一事务，见 7.8） |
| `INTERNAL` | 500 | 未预期异常；RAGFlow 配置缺失、响应非 JSON、返回 5xx 或结构不符；日志记录原始错误，响应不暴露内部信息 |

异常统一由 `fromError()` 收敛，未识别的异常一律转为 `INTERNAL`。两个不走信封的例外：`GET /api/health`（保持原有形状）与内容下载（成功是文件流，未登录是纯文本 401，见 4.12）。

### 1.5 请求体校验通则

- JSON 请求体必须是**对象**；`null`、数组、字符串等返回 400「请求体必须是 JSON 对象」。
- 字符串字段会先 `trim()`；必填字段 trim 后为空 → 400。
- `tags` 必须是字符串数组；元素逐个 trim，空串被丢弃，去重后最多 10 项，单项最长 20 字。
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
| `tags` | string[] | 标签名称数组，最多 10 项、单项 ≤ 20 字；写入时按词表归一化去重。**词表里没有的标签会被拒绝**（400 `TAG_NOT_FOUND`），要先通过 `POST /api/vocabulary/tags` 建出来（真相源是 `object_tags`，见第 6 节） |
| `priority` | `"low" \| "medium" \| "high"` | 优先级 |
| `archivedAt` | string \| null | 归档时间；归档只改元数据 |
| `libraryChangedAt` | string \| null | 最近一次跨库迁移时间；对应 `library_events` 审计流水 |
| `ownerSub` | string | 所属用户，取当前会话 `sub` |
| `revision` | number | 乐观锁版本号，每次写入 +1 |
| `createdAt` / `updatedAt` | string | UTC ISO-8601 |
| `deletedAt` | string \| null | 软删除时间；已删除对象不会出现在任何接口结果中 |
| `category` | 作品：分类 code（非空）；资产：code 或 `null` | 分类（ADR-023 把原「作品形态」并入分类）。取值以 `GET /api/vocabulary` 的启用项为准，没有固定名单；不存在或已停用 → `404` |
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
  "tags": ["长文"],
  "priority": "medium",
  "archivedAt": null,
  "libraryChangedAt": null,
  "ownerSub": "mock-local-user",
  "revision": 1,
  "createdAt": "2026-11-11T06:00:00.000Z",
  "updatedAt": "2026-11-11T06:00:00.000Z",
  "deletedAt": null,
  "category": "article",
  "status": "draft",
  "sourceNote": null
}
```

资产对象的 `status` / `sourceNote` 恒为 `null`，`category` 可为 `null`。

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
| GET | `/api/search` | 内容检索（词法 + 语义混合召回，`mode` 可切单层） | 200 |
| POST | `/api/sync/run` | 手动触发一轮 outbox 投递（需 `content:sync`，403 否则） | 200 |
| POST | `/api/parse/run` | 手动推进一轮解析状态轮询（需 `content:parse`，403 否则） | 200 |
| GET | `/api/admin/users` | 后台账号列表（需 `user:read`） | 200 |
| PATCH | `/api/admin/users/{id}` | 改角色 / 停用账号 / 改 `sub`（需 `user:write`，默认仅 `owner`） | 200 |
| GET | `/api/admin/roles` | 角色 × 权限矩阵（需 `user:read`） | 200 |
| GET | `/api/admin/audit` | 审计日志，游标分页（需 `audit:read`） | 200 |
| GET | `/api/vocabulary` | 读取分类与标签词表（含使用次数） | 200 |
| POST | `/api/vocabulary/categories` | 新增分类（`object:write` 即可内联创建，`reuseExisting` 命中同名启用项时 200 复用） | 201 |
| PATCH | `/api/vocabulary/categories/{code}` | 分类改名 / 排序 / 停用（需 `vocabulary:category:write`） | 200 |
| DELETE | `/api/vocabulary/categories/{code}` | 删除分类，`?migrateTo=` 先迁移（需 `vocabulary:category:write`） | 200 |
| POST | `/api/vocabulary/tags` | 新增标签，归一化命中即复用（`object:write` 即可内联创建，有 `vocabulary:tag:write` 亦放行） | 201 |
| PATCH | `/api/vocabulary/tags/{id}` | 标签改名（需 `vocabulary:tag:write`） | 200 |
| DELETE | `/api/vocabulary/tags/{id}` | 删除标签，可选一并从对象移除（需 `vocabulary:tag:write`） | 200 |
| POST | `/api/vocabulary/tags/{id}/merge` | 合并标签到目标标签（需 `vocabulary:tag:write`） | 200 |
| GET/POST/PATCH/DELETE/PUT | `/api/vocabulary/formats` | 旧路径 → `/api/vocabulary/categories`，只做 308 跳转（ADR-023） | 308 |
| GET/POST/PATCH/DELETE/PUT | `/api/vocabulary/formats/{code}` | 旧路径 → `/api/vocabulary/categories/{code}`，只做 308 跳转（ADR-023） | 308 |
| GET | `/api/graph/labels` | 图谱实体标签列表 | 200 |
| GET | `/api/graph` | 实体邻域子图 | 200 |
| POST | `/api/graph/sync` | 把对象内容同步进 LightRAG（最多 50 个） | 200 |
| GET | `/api/graph/status` | 本系统图文档的抽取状态 | 200 |
| POST | `/api/graph/retry` | 重新抽取失败对象（1–20 个） | 200 |
| POST | `/api/graph/query` | 图增强问答（`mix`，可能约 90 秒） | 200 |
| GET | `/api/settings/llm` | 大模型配置（密钥掩码） | 200 |
| PUT | `/api/settings/llm` | 保存大模型配置 | 200 |
| POST | `/api/settings/llm/test` | 测试与模型服务的连通性 | 200 |
| POST | `/api/settings/llm/apply` | 写入 .env 并重启 LightRAG | 200 |
| GET | `/api/logto/sign-in` | 跳转 Logto 登录（浏览器） | 307 |
| GET | `/api/logto/sign-in-callback` | 登录回调（浏览器） | 307 |
| GET | `/api/logto/sign-out` | 退出并清会话（浏览器） | 307 |

合计 **43 条**「方法 × 路径」接口：**40 条业务 / 系统** + **3 条 Logto 跳转**，分布在 **35 个 `route.ts` 文件**（35 条路径）上。43 与 35 的差额来自 7 个挂了多个方法的文件（多出 8 条）：`/api/objects`（GET + POST）、`/api/objects/{id}`（GET + PATCH + DELETE）、`/api/objects/{id}/content`（GET + POST）、`/api/objects/{id}/library`（GET + POST）、`/api/vocabulary/categories/{code}`（PATCH + DELETE）、`/api/vocabulary/tags/{id}`（PATCH + DELETE）、`/api/settings/llm`（GET + PUT）。

另有 2 条**只做 308 跳转**的旧路径（`/api/vocabulary/formats`、`/api/vocabulary/formats/{code}`，见 6.9）：它们各接受 5 个方法，但语义只是跳到 `/api/vocabulary/categories*`，表中单列、**不计入** 43 条能力数。

权限：除 `/api/health` 与 `/api/logto/*` 外，每个接口都先过 `requirePermission()`，所需权限键写在各行说明里，矩阵见 7.4；`/api/graph/*` 在 LightRAG 不可用时返回 500。

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
| `category` | 字符串，≤ 64 字符 | 按对象的 `category` **code 精确匹配**（单值，ADR-023 起不再有分类数组）；传入未知 code 返回空数组；超长 → 400 |
| `tag` | 字符串，≤ 64 字符 | 标签名称精确匹配：先按词表归一化（全角转半角、空白压缩、小写）再解析到 `tag_id`，`Tool` 与 ` tool ` 命中同一条；词表里没有该标签时返回空数组，不报错；超长 → 400 |
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
| `tags` | string[] | 否 | 最多 10 项，单项 ≤ 20 字；按词表归一化去重（全角 / 大小写变体算同一个）。只接受**词表里已有**的标签，未知标签 → 400 `TAG_NOT_FOUND` |
| `priority` | `low` \| `medium` \| `high` | 否 | 默认 `medium` |
| `source` | `handwritten` \| `ai_extracted` | 否 | 默认 `handwritten` |
| `origin` | `self` \| `imported` | 否 | 默认 `self` |
| `category` | string | 作品必填；资产可选 | 分类词表里的 code，且必须是**启用状态**（`active`）；取值从 `GET /api/vocabulary` 取。不存在或已停用 → `404 NOT_FOUND`（不是 400）。资产传 `null` 等同未传 |
| `sourceNote` | string \| null | 否 | 仅作品有效；最长 5000 字符 |
| `status` | — | 否 | **作品禁止传**：任何非 `null` 值都返回 400；资产会忽略该字段 |

规则：

- **新建作品固定为 `draft`**，状态只能通过 `POST /api/objects/{id}/status` 迁移。
- 不再接受旧字段 `format` / `categories` / `primaryCategory`，传了直接 400；资产的 `category` 可传 `null`；`sourceNote` 对资产无意义，会被忽略。
- `id`、`revision`、时间戳、`ownerSub` 均由服务端生成，请求体中传入会被忽略。
- 标签走词表（第 6 节）：`tags` 只接受**已存在**的标签，出现词表没有的名称 → 400 `TAG_NOT_FOUND`（`details.tag` 是原值），不会静默新建；要加新标签先调 6.5（`object:write` 即可内联创建）。同一对象里的重复标签（含全角 / 大小写变体）被去重而不是报错。
- 新建只写业务元数据，**不创建内容、不入队同步任务**；正文要再调 4.10 上传。

**响应**：`201`，新建的完整对象。

**主要错误**：`400`（字段缺失 / 类型错误 / 取值非法 / 作品带 `status` / 标签超 10 个或单项超 20 字 / 标签不在词表里 → `TAG_NOT_FOUND`）、`401`、`404`（`category` 不在词表里或已停用，`details.category`）。

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
| `tags` | string[] \| null | 否 | `null` 等同于清空为 `[]`；最多 10 项、单项 ≤ 20 字，整体替换。只接受词表里已有的标签，未知标签 → 400 `TAG_NOT_FOUND` |
| `priority` | `low` \| `medium` \| `high` | 否 | **不接受 `null`** |
| `source` | `handwritten` \| `ai_extracted` | 否 | **不接受 `null`** |
| `origin` | `self` \| `imported` | 否 | **不接受 `null`** |
| `category` | string | null | 否 | 必须是词表里**启用状态**的分类 code；作品不接受 `null`（清空 → 400），资产可以传 `null` 清空。原样传回当前值（哪怕该分类已停用）不会被拒绝 |
| `sourceNote` | string \| null | 否 | 仅作品；显式 `null` 清空 |

语义：

- **字段缺席 = 保持不变**。
- **显式 `null` = 清空**，仅对 `description`、`sourceNote`、`category`（资产）、`tags` 成立；`title`、`priority`、`source`、`origin` 传 `null` 会返回 400（这些字段没有空值语义）。
- **不可变字段**：`type`、`library`、`status` 只要出现在请求体里（包括 `null`）就返回 400。改库别用 `/library`，改状态用 `/status`。
- 资产携带 `sourceNote` → 400；作品把 `category` 传 `null` → 400。
- 写入成功后 `revision + 1`、`updatedAt` 刷新，并在**同一事务**内入队一条 `sync_jobs(action = upsert)`；后台 worker（5.2）会把它投递到 RAGFlow，`meta_fields` 因此跟随业务字段变化。

**响应**：`200`，更新后的完整对象。

**主要错误**：

| 状态 | 场景 |
|------|------|
| 400 | 缺 `expectedRevision` / 不是正整数；改动不可变字段；字段校验失败；`tags` 含词表里不存在的标签（`TAG_NOT_FOUND`） |
| 401 | 未登录 |
| 404 | 对象不存在、已删除、或不属于当前用户；或改 `category` 时目标分类不存在 / 已停用（`details.category`） |
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
- **解析触发**：本地落库并入队后，立即调用 RAGFlow `POST /api/v1/datasets/{dataset_id}/chunks`（body `{ document_ids: [documentId] }`），成功后把引用置为 `running`，响应里的 `parseStatus` 即 `running`。触发失败**不影响上传**——异常只记日志，接口仍返回 201，引用停在 `pending`，由解析轮询在下一轮按 `UNSTART` 补触发（见 7.3）。
- **解析进度不由上传接口保证**：上传只负责触发。`running → succeeded / failed` 由后台 worker 每轮轮询 RAGFlow 文档状态回写（默认 30 秒，行为见 7.3）。本机实测（RAGFlow v0.20.5）：上传后立即为 `running`，约 9–12 秒变为 `succeeded`，`chunk_count = 1`。
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
| `Content-Type` | 透传 RAGFlow 的响应头；本机实测为 `application/octet-stream`，不保证与实际文件类型一致；本地记录的 `mime` 更准确，前端按扩展名/本地记录判断文件类型 |
| `Content-Disposition` | 默认 `attachment; filename*=UTF-8''<URL 编码文件名>`；文件名优先取 RAGFlow 响应里的名字，其次 `documentName`，都没有时用 `content`；带 `?inline=1` 时改为 `inline`，供浏览器内联展示（PDF / 图片），文件名规则不变 |
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

检索分**词法层**与**语义层**（ADR-024）：**词法层**在 SQLite 里对标题 / 描述 / 分类 / 标签做子串匹配，**语义层**在 RAGFlow 里召回正文片段，两者按对象合并。返回的永远是当前用户**未归档**的对象——归属、归档与库别过滤都在业务库完成，不能把 RAGFlow 的原始结果直接当接口响应。正文只存在于 RAGFlow，词法层搜不到正文，这是明确的产品边界。

**查询参数**：

| 参数 | 必填 | 取值 | 说明 |
|------|------|------|------|
| `q` | **是** | trim 后 1–200 字符 | 检索词；缺失、空白或超长 → 400；语法错误 → 400 `QUERY_SYNTAX` |
| `limit` | 否 | 1–50 的整数，**默认 10** | 返回条数上限；0、51、小数、非数字 → 400 |
| `library` | 否 | `internal` \| `external` | 只返回该库的对象；其他值 → 400（`details.allowed` 给出合法取值） |
| `threshold` | 否 | 0–1 的小数，**默认 0.2** | 相似度阈值，**只影响语义结果**；越界或非数字 → 400 |
| `mode` | 否 | `hybrid` \| `lexical` \| `semantic`，**默认 `hybrid`** | `lexical` 完全不碰 RAGFlow；`semantic` 保持改造前的纯语义输出；其他值 → 400（`details.allowed` 给出三项） |

**检索语法**（只作用于词法层，语义层收原文）：

| 写法 | 含义 |
|------|------|
| `复盘 模板` | 空格分隔 = AND，每条都要命中 |
| `AND` | AND 的同义词（大写） |
| `"每周回顾"` | 引号短语，整体匹配 |
| `title:x` / `标题:x` | 只在标题里找 |
| `desc:x` / `描述:x` | 只在描述里找 |
| `category:x` / `分类:x` | 只在分类名里找 |
| `tag:x` / `标签:x` | 只在标签名里找 |
| `-x` / `NOT x` | 排除；可带字段前缀，如 `-tag:模板` |
| `~` | 不支持操作符，按字面量匹配并在 `lexical.hint` 里提示一次 |
| `x:y`（未知前缀） | 当普通文本处理，不报错 |
| `OR` / `(` `)` | **不支持** → 400 `QUERY_SYNTAX`，`details.position` 是原文中的 0 基位置 |

归一化后不足 2 个字时返回 200 空结果，`lexical.hint = "至少输入 2 个字"`，**不做任何查询**。

**执行规则**：

- **词法层**：对 `title_norm` / `description_norm` / 分类名 / 标签名做 `instr()` 子串匹配，参数化 SQL，`%` 与 `_` 都是字面量。归一化只有一个实现（NFKC → 空白折叠 → trim → 小写），写入、回填、查询共用。
- **六级权重**：标题精确 100 → 标题包含 80（前缀再加 10）→ 分类精确 70 → 标签精确 65 → 分类或标签包含 50 → 描述 20；对象级去重，同分按 `updatedAt` 倒序、再按 id 升序。词法单次最多 500 条，取 `limit + 1` 判断 `truncated`。
- **语义层**：Dataset 解析与上传一致（`RAGFLOW_DATASET_ID` 优先，否则按 `RAGFLOW_DATASET_NAME`，默认 `pakp-content`）。找不到 dataset 不是错误，`semantic.status = "no_dataset"`。先按 `limit * 3`（上限 50）多召回，再用 `content_refs` 认回对象，过滤归属 / 归档 / 库别。语义分数 `30 + 15 × similarity`（30–45）。
- **超时与降级**：`hybrid` 下两层 `Promise.all` 并行，语义侧 3 秒硬截止。超时只回词法，`semantic.status = "timeout"`；RAGFlow 报错则为 `"unavailable"`。两种情况都是 200，不向前端抛错。
- **合并**：按对象 id 去重，同一对象只出一条，`source` 取 `both`，`score` 取两侧较高者，`chunkCount` 记该对象命中的语义片段数；排序按 `score` 倒序 → `updatedAt` 倒序 → id 升序。
- **`mode=semantic`**：保持改造前的 chunk 顺序与字段（不做对象级合并），只补新键，旧调用方不用改。

**响应**：`200`

| 字段 | 类型 | 说明 |
|------|------|------|
| `question` | string | 回显 trim 后的查询词 |
| `mode` | `hybrid` \| `lexical` \| `semantic` | 实际执行的模式 |
| `total` | number | **合并去重后的对象数**（不是命中片段数；`mode=semantic` 下等于 `hits.length`） |
| `counts.lexical` / `semantic` / `merged` | number | 词法命中对象数 / 语义命中对象数 / 合并后对象数 |
| `lexical.total` | number | 词法层的命中总数（未按 `limit` 截断前） |
| `lexical.truncated` | boolean | 词法结果超过 500 条上限被截断 |
| `lexical.hint` | string \| null | 提示，如「至少输入 2 个字」「~ 按普通字符处理」 |
| `semantic.total` | number | 语义层过滤后的片段数 |
| `semantic.status` | `ok` \| `timeout` \| `unavailable` \| `no_dataset` \| `skipped` | `skipped` 表示 `mode=lexical` 未调用语义 |
| `semantic.thresholdApplied` | boolean | 本次是否应用了 `threshold` |
| `library` | `internal` \| `external` \| null | 回显库别过滤 |
| `hits[].source` | `lexical` \| `semantic` \| `both` | 命中来自哪一层 |
| `hits[].score` | number | 统一分数（词法 20–110，语义 30–45） |
| `hits[].matchedFields` | string[] | 词法命中的字段：`title` / `description` / `category` / `tag` |
| `hits[].highlightTerms` | string[] | 需要高亮的词；语义命中为空数组 |
| `hits[].chunkCount` | number | 该对象命中的语义片段数（`both` 时仍给出） |
| `hits[].chunkId` | string \| null | RAGFlow chunk id；纯词法命中为 `null` |
| `hits[].content` | string | 片段正文；纯词法命中为摘要（标题或描述） |
| `hits[].highlight` | string \| null | RAGFlow 返回的高亮片段；纯词法为 `null` |
| `hits[].similarity` | number \| null | 相似度 0–1；纯词法为 `null` |
| `hits[].documentId` / `documentName` / `refId` / `role` | — | 同改造前；纯词法命中均为 `null`，`refId` 可空时不能用 4.12 下载 |
| `hits[].object.id` / `type` / `title` / `library` / `status` / `category` / `tags` | — | 所属对象的关键字段；资产的 `status` 为 `null`、`category` 可为 `null` |

```json
{
  "question": "复盘",
  "mode": "hybrid",
  "total": 2,
  "counts": { "lexical": 2, "semantic": 1, "merged": 2 },
  "lexical": { "total": 2, "truncated": false, "hint": null },
  "semantic": { "total": 1, "status": "ok", "thresholdApplied": true },
  "library": null,
  "hits": [
    {
      "chunkId": "a1b2c3d4e5f6",
      "content": "固定五个问题，十五分钟完成一次周复盘",
      "highlight": null,
      "similarity": 0.42,
      "documentId": "9f3c1e7a2b4d4c8e",
      "documentName": "note.txt",
      "refId": "01JBREF0000000000000000000",
      "role": "primary",
      "source": "both",
      "score": 100,
      "matchedFields": ["title", "description", "tag"],
      "chunkCount": 1,
      "highlightTerms": ["复盘"],
      "object": {
        "id": "01JBDEMO000000000000000000",
        "type": "asset",
        "title": "复盘模板：每周回顾",
        "library": "internal",
        "status": null,
        "category": "article",
        "tags": ["复盘"]
      }
    },
    {
      "chunkId": null,
      "content": "从收集、整理到复用的完整流程，含每周复盘模板",
      "highlight": null,
      "similarity": null,
      "documentId": null,
      "documentName": null,
      "refId": null,
      "role": null,
      "source": "lexical",
      "score": 20,
      "matchedFields": ["description", "tag"],
      "chunkCount": 0,
      "highlightTerms": ["复盘"],
      "object": {
        "id": "01JBDEMO000000000000000001",
        "type": "asset",
        "title": "个人知识系统的搭建方法",
        "library": "internal",
        "status": null,
        "category": "article",
        "tags": ["复盘", "模板"]
      }
    }
  ]
}
```

实测（RAGFlow v0.20.5，本机，单文档单 chunk）：命中的相似度约 0.38–0.48；对象归档后再查同一关键词返回 0 条。语义挂起时 `semantic.status = "timeout"`，整体在 3.0 秒左右返回词法结果。1 万对象基准下词法 p95 7–12ms、预览 8 条 p95 4–6ms。

**主要错误**：

| 状态 / 错误码 | 场景 |
|---------------|------|
| 400 `VALIDATION_FAILED` | `q` 缺失 / 空白 / 超 200 字符；`limit` 非 1–50 整数；`library` 非法；`threshold` 不在 0–1；`mode` 不在三项内 |
| 400 `QUERY_SYNTAX` | 用了 `OR` 或括号、引号未闭合、`-` 后为空、`category:` 后为空等；`details.position` 是原文中的 0 基位置，`message` 说明原因 |
| 401 `UNAUTHORIZED` | 未登录 |
| 500 `INTERNAL` | `mode=semantic` 下缺 `RAGFLOW_BASE_URL` / `RAGFLOW_API_KEY` 或 RAGFlow 响应结构不符（`hybrid` 下这类错误只会降级为 `semantic.status = "unavailable"`，不会 500） |

> 空查询 `?q=` 是 400，不是「返回全部」。这与列表接口「空串等同未传」的约定不同，因为检索没有「不筛选」的语义。

---

## 6. 词表接口（分类与标签）

分类与标签已经**词表化**（ADR-016 / ADR-023）：分类在 `categories` 表（原 `work_formats`），标签在 `tags` + `object_tags` 两张表；`objects.categories` / `objects.tags` JSON 列与 `objects.format` 均已删除，换成指向 `categories(code)` 的 `objects.category_code` 外键。`GET /api/vocabulary` 是**唯一读取入口**——前端所有分类 chips、标签 chips、筛选与导出都从这里取，代码里不再保留分类名单常量。

- **读**（6.1）：登录即可，不限管理员。
- **写**（6.2–6.8）：维护动作（改名 / 排序 / 停用 / 删除 / 合并）需要词表权限——分类是 `vocabulary:category:write`、标签是 `vocabulary:tag:write`，默认只有 `owner` / `admin` 拥有（矩阵见 7.4）；分类与标签的**内联创建**（6.2、6.5）另向 `object:write` 开放，`editor` 也能在新建 / 编辑弹窗里「＋ 自定义」（ADR-019 / ADR-023）。
- **上限**：分类名称 1–12 字，标识 2–32 位小写字母 / 数字 / 连字符 / 下划线，启用分类最多 30 个；标签 1–20 字，每个对象最多 10 个，标签总数软上限 500。
- **旧地址**：`/api/vocabulary/formats*` 仍保留，但只做 **308** 跳到 `/api/vocabulary/categories*`；管理页 `/admin/vocabulary/formats` 同样 308 到 `/admin/vocabulary/categories`。
- **界面**：管理页 `/admin/vocabulary/categories`（分类）与 `/admin/vocabulary/tags`（标签）就是这套接口的前端，入口在第二列目录底部的「管理」分组（仅管理员可见）；操作方法见 [09_USER_GUIDE.md](09_USER_GUIDE.md) 4.2。

### 6.1 `GET /api/vocabulary`

读取全量词表，含使用次数。

**响应**：`200`

| 字段 | 类型 | 说明 |
|------|------|------|
| `categories[].code` | string | 分类标识，主键；创建后不可改 |
| `categories[].label` | string | 展示名称，1–12 字 |
| `categories[].normalized` | string | 归一化键，与标签同一套规则；唯一 |
| `categories[].sortOrder` | number | 排序值，升序 |
| `categories[].state` | `active` \| `archived` | 停用（`archived`）不出现在新建 / 编辑面板，历史对象照常显示 |
| `categories[].isSystem` | boolean | 内置分类；`true` 时不能删除，只能改名、排序、停用 |
| `categories[].usage` | number | 引用它的未删除对象数（作品 + 资产） |
| `tags[].id` | string | 标签 ULID |
| `tags[].label` | string | 展示名称，保留首次创建时的写法（不做小写化） |
| `tags[].normalized` | string | 归一化键：全角转半角、连续空白压成一个、去首尾空白、小写；唯一 |
| `tags[].sortOrder` | number | 排序值，升序 |
| `tags[].usage` | number | 引用它的未删除对象数 |

排序：分类按 `sortOrder` 升序、同值按 `code`；标签按 `sortOrder` 升序、同值按 `label`。

使用次数**排除已软删除的对象**（对象是软删，外键不会级联清链接），所以 `usage = 0` 才是真的可以删。

```json
{
  "categories": [
    { "code": "article", "label": "文章", "normalized": "文章", "sortOrder": 10, "state": "active", "isSystem": true, "usage": 4 },
    { "code": "podcast", "label": "播客", "normalized": "播客", "sortOrder": 70, "state": "active", "isSystem": false, "usage": 0 },
    { "code": "uncategorized", "label": "未分类", "normalized": "未分类", "sortOrder": 999, "state": "active", "isSystem": true, "usage": 0 }
  ],
  "tags": [
    { "id": "01JBTAG000000000000000000", "label": "AI", "normalized": "ai", "sortOrder": 0, "usage": 2 }
  ]
}
```

**主要错误**：`401`。

---

### 6.2 `POST /api/vocabulary/categories`

新增分类，写入后全站立即可选（面板只显示 `active` 的分类）。命中同名启用项时可传 `reuseExisting: true` 直接复用（内联「＋ 自定义」走这条，返回 `200` 而不是 `201`）。

**请求体**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `label` | string | 是 | 1–12 字；先做 NFKC、空白压缩、去首尾空白再计数，超长或为空 → 400 |
| `code` | string | 否 | 2–32 位 `[a-z0-9_-]`，首字符必须是字母或数字；不传则从名称推导：能转出至少 2 位 ASCII slug 就用它（如「Podcast Show」→ `podcast-show`），转不出来（纯中文名）回退成 `c-` 加 8 位 ULID 片段；推导出的 code 已存在时自动追加 `-2`、`-3` |
| `reuseExisting` | boolean | 否 | 仅内联创建用：`true` 时命中同名启用分类直接返回已有项（`200`）；命中停用项仍报 `CATEGORY_ARCHIVED` |
| `sortOrder` | number | 否 | 不传取「现有最大排序值 + 10」 |

规则：

- 启用中的分类最多 **30** 个，到上限返回 400，`details.max` 为 30。
- 新建的分类一定是 `state = active`、`isSystem = false`。
- `code` 是不可变主键：写错只能删掉重建（删除见 6.4）。
- 同名判定按 `normalized`（NFKC、空白压缩、去首尾、小写）：命中启用项 → 409 `CATEGORY_EXISTS`（传 `reuseExisting: true` 则 200 复用）；命中停用项 → 409 `CATEGORY_ARCHIVED`，不会自动复活。

**响应**：`201`

```json
{ "code": "podcast", "label": "播客", "sortOrder": 70, "state": "active", "isSystem": false, "usage": 0 }
```

**主要错误**：

| 状态 / 错误码 | 场景 |
|---------------|------|
| 400 `VALIDATION_FAILED` | 请求体不是 JSON 对象；`label` 为空或超 12 字；`code` 格式非法；启用分类已达 30 个 |
| 401 `UNAUTHORIZED` | 未登录 |
| 409 `CATEGORY_EXISTS` | 同名分类已存在（未传 `reuseExisting`），或显式传入的 `code` 已存在 |
| 409 `CATEGORY_ARCHIVED` | 同名分类已停用；内联创建不自动复活 |

---

### 6.3 `PATCH /api/vocabulary/categories/{code}`

改名、排序、停用 / 恢复。`code` 是主键，不可修改。

**请求体**（至少给一个，全部可选）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `label` | string | 1–12 字 |
| `sortOrder` | number | **必须是整数**，小数或字符串 → 400 |
| `state` | `active` \| `archived` | `archived` 即停用 |
| `expectedUpdatedAt` | string | 乐观校验：与库中 `updatedAt` 不一致返回 409，`details.actualUpdatedAt` 给出当前值 |

规则：

- 停用（`archived`）后不出现在新建 / 编辑面板，历史对象照常显示原名称；恢复传 `active`。
- 内置的 `uncategorized`（未分类）**不能停用**，它同时是删除分类时的默认迁移目标。
- 至少要保留一个启用分类，停掉最后一个 → 409。
- 改名只改 `label`；`objects.category_code` 存的是 `code`，所以改名**不需要回写任何对象**，全站立即生效（列表、详情、导出、筛选同一份数据）。

**响应**：`200`，更新后的词表元素（含实时 `usage`）。

**主要错误**：`400`（`sortOrder` 非整数、`state` 取值非法、`label` 校验失败）、`401`、`403`（缺 `vocabulary:category:write`）、`404`（code 不存在，`details.code`）、`409`（`expectedUpdatedAt` 不一致；停用 `uncategorized`；这是最后一个启用分类）。

---

### 6.4 `DELETE /api/vocabulary/categories/{code}`

删除分类。被引用时必须先迁移，否则拒绝。

**查询参数**：

| 参数 | 必填 | 说明 |
|------|------|------|
| `migrateTo` | 否 | 目标分类 `code`；被引用时**必须**给，否则 409 |

规则：

- 内置分类（`isSystem = true`）**不能删除** → 409，只能改名或停用。
- 仍被引用（`usage > 0`）且没给 `migrateTo` → 409：`details.usage` 是引用数，`details.sample` 是前 5 个对象（`{ id, title }`）。
- 给了 `migrateTo` 时在**一个事务**里：把该分类下所有未删除对象的 `category_code` 改成目标分类、`revision + 1`、逐条入队 `sync_jobs(action = upsert)`，然后删除分类。迁移后这些对象的元数据会由 worker 推送到 RAGFlow。
- `migrateTo` 不能等于自身（400）；目标分类必须存在（404），且必须处于 `active`（409 `CATEGORY_ARCHIVED`）。
- 至少要留一个启用分类。

**响应**：`200`

```json
{ "deleted": "podcast", "migrated": 3, "migrateTo": "uncategorized" }
```

没有引用时 `migrated` 为 `0`，并且响应里**没有** `migrateTo` 字段。

**主要错误**：

| 状态 / 错误码 | 场景 |
|---------------|------|
| 400 `VALIDATION_FAILED` | `migrateTo` 等于被删的 code |
| 401 / 403 | 未登录 / 不是管理员 |
| 404 `NOT_FOUND` | `code` 不存在；`migrateTo` 指向的分类不存在 |
| 409 `CONFLICT` | 内置分类；有引用却没给 `migrateTo`（`details.usage` / `details.sample`）；删掉后没有启用分类；`migrateTo` 指向已停用分类（`CATEGORY_ARCHIVED`） |

---

### 6.5 `POST /api/vocabulary/tags`

新增标签。按归一化键命中已有标签时**直接复用，不报错也不产生重复记录**。

**请求体**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `label` | string | 是 | 1–20 字；全角转半角、连续空白压成一个、去首尾空白后计数 |

规则：

- 归一化键 = 上述展示文本再转小写，因此 `ＴＯＯＬ`、`Tool`、` tool ` 是同一条标签，命中后返回**已有那条**（保留首次写法）。
- 标签总数超过 **500**（软上限）时仍然创建成功，响应体多一个 `warning` 字段提示合并同义标签。
- 加新标签**只能**走这个接口：对象写入时 `tags` 只接受已有标签，未知标签返回 400 `TAG_NOT_FOUND`（见 4.2、4.4）。`object:write` 即可调用（内联创建，不必是管理员），界面上的「＋ 自定义」走的就是这条。

**响应**：`201`（复用已有标签也是 201）

```json
{ "id": "01JBTAG000000000000000000", "label": "AI", "normalized": "ai", "sortOrder": 0, "usage": 0 }
```

**主要错误**：`400`（请求体不是 JSON 对象、`label` 缺失 / 为空 / 超 20 字）、`401`、`403`。

---

### 6.6 `PATCH /api/vocabulary/tags/{id}`

标签改名。只接受 `label`，`sortOrder` 目前没有写入路径。

规则：

- 只改 `tags` 表一行；`object_tags` 存的是 `tag_id`，所以改名是 O(1)，详情、列表、导出、筛选四处同时变化，不需要回写对象。
- 归一化后与**另一条**标签同名 → 409，`details.normalized` 与 `details.existing`（`{ id, label }`）给出撞车的那条；这种情况应改用合并（6.8），而不是硬改名。

**请求体**：`{ "label": "人工智能" }`（1–20 字，必填）

**响应**：`200`，更新后的标签元素（含实时 `usage`）。

**主要错误**：`400`（`label` 缺失或超长）、`401`、`403`、`404`（标签不存在，`details.id`）、`409`（归一化后与已有标签重名）。

---

### 6.7 `DELETE /api/vocabulary/tags/{id}`

删除标签。默认**只拒绝，不动对象**；显式要求才会连对象上的标签一起摘掉。

**请求体**（可选）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `removeFromObjects` | boolean | 必须是字面量 `true` 才生效；缺省或 `false` 走拒绝路径 |

规则：

- 仍被引用且没给 `removeFromObjects: true` → 409，`details.usage` 是引用它的未删除对象数，提示改用合并。
- `removeFromObjects: true` → 同一事务里删除该标签的全部 `object_tags` 链接，再删标签；这些对象会**失去这个标签**，且没有撤销接口。
- 请求体不是合法 JSON 时按「没带参数」处理（不会因此报 400）。

**响应**：`200`

```json
{ "deleted": "01JBTAG000000000000000000", "removedFrom": 3 }
```

拒绝路径走不到这里；`removeFromObjects: true` 时 `removedFrom` 是被摘掉链接的对象数，否则为 `0`（仅无引用时才会删成功）。

**主要错误**：`401`、`403`、`404`（标签不存在）、`409`（仍被引用且未显式要求一并移除）。

---

### 6.8 `POST /api/vocabulary/tags/{id}/merge`

合并标签：把源标签（路径里的 `{id}`）的全部引用改到目标标签，再删源标签。

**请求体**（`targetId` 与 `targetLabel` 二选一）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `targetId` | string | 目标标签 id |
| `targetLabel` | string | 目标标签名称；按归一化键查找 |

规则：

- 目标必须已存在：`targetId` 查不到或 `targetLabel` 归一化后没有对应标签 → 400「合并目标不存在」。合并**不会**顺手创建新标签，要新建目标请先调 6.5。
- 目标不能是源标签自己 → 400。
- 链接写入用 `ON CONFLICT DO NOTHING`：某个对象同时挂了两个标签时只保留一条，不会因为主键冲突中断整次合并。
- 整个「补链接 → 删源链接 → 删源标签」在一个事务里完成。

**响应**：`200`，合并后的**目标标签**元素，`usage` 是合并后的新计数

```json
{ "id": "01JBTAGAI0000000000000000", "label": "AI", "normalized": "ai", "sortOrder": 0, "usage": 5 }
```

**主要错误**：

| 状态 / 错误码 | 场景 |
|---------------|------|
| 400 `VALIDATION_FAILED` | 请求体不是 JSON 对象；没给 `targetId` / `targetLabel`；目标不存在；目标是自己 |
| 401 / 403 | 未登录 / 不是管理员 |
| 404 `NOT_FOUND` | 源标签不存在，`details.id` |

---

### 6.9 旧地址 `/api/vocabulary/formats*`（308 兼容跳转）

ADR-023 把「作品形态」改名为「分类」，接口路径一并从 `/api/vocabulary/formats` 改为 `/api/vocabulary/categories`。**旧地址仍然存在，但不承载任何业务逻辑**——没有独立的请求体校验、没有独立权限，只是把请求原样转给新地址：

| 旧路径 | 跳到 | 接受的方法 | 状态 |
|--------|------|-----------|------|
| `/api/vocabulary/formats` | `/api/vocabulary/categories` | GET / POST / PATCH / DELETE / PUT | 308 |
| `/api/vocabulary/formats/{code}` | `/api/vocabulary/categories/{code}` | GET / POST / PATCH / DELETE / PUT | 308 |

- 308（Permanent Redirect）按 RFC 7538 保留原方法与请求体，查询串原样带过去；`/api/vocabulary/formats/abc?x=1` 跳到 `/api/vocabulary/categories/abc?x=1`。
- 跳转前不做鉴权：未登录调用旧地址会先拿到 308，随后新地址返回 401。想看权限 / 校验错误，请看 6.2–6.8。
- 页面对应关系：`/admin/vocabulary/formats` 同样 308 到 `/admin/vocabulary/categories`。
- **新代码请直接调用 `/api/vocabulary/categories*`**。这两个旧路径是给尚未升级的调用方留的一个版本窗口，不要在上面继续开发。
- 页面源码里这两个 route 文件只导出跳转函数（`src/app/api/vocabulary/formats/route.ts`、`.../[code]/route.ts`），method × path 上是 10 个组合，但对调用方而言只是 2 条跳转入口，所以第 3 节不把它们计入 43 条能力数。

---

## 7. 系统接口

### 7.1 `GET /api/health`

健康检查，无需登录，**不使用**统一错误信封（保持原有形状，便于探活脚本）。

**响应**：`200`

```json
{
  "status": "ok",
  "service": "personal-asset-knowledge-platform",
  "timestamp": "2026-11-11T06:00:00.000Z",
  "authMode": "mock"
}
```

`authMode` 是当前生效的身份模式（`mock` / `logto` / `disabled`），用于一眼看出是否误把 `mock` 当生产部署（ADR-019 风险 A6）。

该接口不检查数据库与外部依赖（RAGFlow / Logto）可达性，只表示 Next.js 进程可响应。

### 7.2 `POST /api/sync/run`

手动触发**一轮** outbox 投递：认领已到期的 `sync_jobs` 并调用 RAGFlow。后台 worker 跑的是同一段逻辑（`runSyncOnce`），这个端点用于排障、脚本化或想立刻生效时手动催一次。

**权限**：需要 `content:sync`（ADR-019 矩阵里 `owner` / `admin` 拥有，`editor` / `viewer` 没有），否则 `403 FORBIDDEN`；`AUTH_MODE=mock` 的固定身份是 `owner`，本地开发可直接调用。

**请求体**：无（传了也不读）。

**执行规则**：

- 单次最多认领 **20** 条任务；`running` 超过 5 分钟视为租约过期，可被重新认领。
- `upsert`：按 `content_key` 认回文档，用对象**当前**的 `library` / `archived` / `format` / `source` 整体重写 `meta_fields`，成功后引用标 `synced` 并写 `lastSyncedAt`。对象已软删除时该任务直接完成（目标不存在）。
- `delete`：删除该对象在 RAGFlow 的全部文档，再软删本地引用；RAGFlow 返回 404 视为已达成目标。
- 失败的任务回到 `pending` 按指数退避重试，达到上限置 `failed`；**失败不影响 HTTP 状态**——端点仍返回 200，失败明细在 `errors` 里。
- **不按调用者归属过滤**：队列里属于任何对象（含其他 `ownerSub`）的到期任务都会被处理，worker 以系统身份运行；因此端点要求 `content:sync` 权限。

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
| 403 `FORBIDDEN` | 缺少 `content:sync` 权限（ADR-019），`details.permission = "content:sync"` |
| 500 `INTERNAL` | 缺 `RAGFLOW_BASE_URL` / `RAGFLOW_API_KEY`（构造客户端时即失败，此时一条任务也不会被认领） |

> `errors` 里的 `message` 来自 RAGFlow 的错误响应，属于外部系统文案，**不要**把它当作稳定字段解析。

**后台 worker（不是 HTTP 接口，但影响可观察行为）**：

| 项 | 行为 |
|----|------|
| 启动方式 | `src/instrumentation.ts` 在 Node 运行时调用 `startSyncWorker()` |
| 启动条件 | 必须同时配置 `RAGFLOW_BASE_URL` 与 `RAGFLOW_API_KEY`；`SYNC_WORKER_ENABLED=false` 显式关闭 |
| 间隔 | `SYNC_WORKER_INTERVAL_MS`，默认 30000 ms；小于 5000 按默认值处理。该间隔同时驱动 outbox 投递与解析轮询 |
| 每轮做什么 | 先跑一轮 outbox 投递（最多 20 条），再跑一轮解析状态轮询（最多 50 条，见 7.3）；两段互不影响 |
| 并发保护 | 进程内用标志位避免重入；多进程部署各自认领，靠 `claimJobs` 的原子认领保证同一任务不被处理两次 |

---

### 7.3 `POST /api/parse/run`

手动推进**一轮**解析状态轮询：把 RAGFlow 的文档解析进度回写到 `content_refs.parse_status`。后台 worker 每轮跑的是同一段逻辑（`pollParsingOnce`），这个端点用于排障或想让状态立刻更新时手动催一次。

**权限**：需要 `content:parse`，规则同 7.2（ADR-019）。

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
- **不按调用者归属过滤**：与其他引用一样，轮询会处理队列中任何 `ownerSub` 的引用，以系统身份运行；因此端点要求 `content:parse` 权限。

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
| 403 `FORBIDDEN` | 缺少 `content:parse` 权限（ADR-019），`details.permission = "content:parse"` |
| 500 `INTERNAL` | 缺 `RAGFLOW_BASE_URL` / `RAGFLOW_API_KEY`（仅在本轮确实有待处理引用、需要构造客户端时才触发；没有待处理引用时正常返回全 0） |

> 实测（RAGFlow v0.20.5，本机）：上传后引用立即为 `running`，约 9–12 秒后解析完成，下一轮轮询回写 `succeeded`，文档 `chunk_count = 1`。

---

### 7.4 权限矩阵（管理员接口的判定依据）

授权模型见 ADR-019：15 项权限、4 个系统角色，唯一强制层是 `src/server/authz.ts` 的 `requirePermission()`。管理员接口的权限如下：

| 方法 | 路径 | 需要的权限 | 默认拥有该权限的角色 | 详见 |
|------|------|-----------|--------------------|------|
| GET | `/api/admin/users` | `user:read` | owner、admin | 7.5 |
| PATCH | `/api/admin/users/{id}` | `user:write` | **仅 owner** | 7.6 |
| GET | `/api/admin/roles` | `user:read` | owner、admin | 7.7 |
| GET | `/api/admin/audit` | `audit:read` | owner、admin | 7.8 |

完整矩阵（与 `ROLE_PERMISSIONS` 逐格一致）：

| 权限 | 说明 | owner | admin | editor | viewer |
|------|------|:-:|:-:|:-:|:-:|
| `object:read` | 看列表 / 详情 / 正文 / 检索 | ✓ | ✓ | ✓ | ✓ |
| `object:write` | 新建、编辑、归档、库别迁移、写正文 | ✓ | ✓ | ✓ | |
| `object:delete` | 删除对象（软删） | ✓ | ✓ | | |
| `object:export` | 导出 Markdown | ✓ | ✓ | | |
| `vocabulary:category:write` | 分类词表维护（第 6 节） | ✓ | ✓ | | |
| `vocabulary:tag:write` | 标签词表维护（第 6 节） | ✓ | ✓ | | |
| `content:sync` | 手动同步队列（7.2） | ✓ | ✓ | | |
| `content:parse` | 推进解析状态（7.3） | ✓ | ✓ | | |
| `system:read` | 查看运行时信息 | ✓ | ✓ | | |
| `audit:read` | 查看审计日志（7.8） | ✓ | ✓ | | |
| `user:read` | 查看用户与角色（7.5、7.7） | ✓ | ✓ | | |
| `user:write` | 改用户角色与状态（7.6） | ✓ | | | |
| `role:write` | 修改角色定义（预留，v1 无写入接口） | ✓ | | | |
| `settings:read` | 查看大模型配置（8.1） | ✓ | ✓ | | |
| `settings:write` | 修改 / 测试 / 应用大模型配置（8.2–8.4） | ✓ | ✓ | | |

要点：

- 多角色取**并集**：表结构允许一个账号挂多个角色，v1 每人一个。
- 权限来自库表（`roles` / `role_permissions` / `permissions`），代码常量只用于启动期一致性校验；两边不一致时进程拒绝启动，不会带着「代码有、库里没有」的判定空洞运行。
- 角色 key 只有四个系统角色（`owner` / `admin` / `editor` / `viewer`），不可自定义；`role:write` 存在但**没有**任何写入路径。
- 被停用（`state = disabled`）的账号权限为空：任何需要权限的接口返回 `403 FORBIDDEN`（不是 401——身份仍在，只是没有权限）。
- 每次 403 都会写一条审计：`action = "authz.denied"`、`result = "denied"`、`targetId` 为缺失的权限键。这条写入失败只打应用日志，**不改变**拒绝结果。

---

### 7.5 `GET /api/admin/users`

后台账号列表。账号在**首次登录时**自动落库（`users` 表），没有「新建用户」「删除用户」接口——停用是唯一的移除方式。

**权限**：`user:read`。

**查询参数**：

| 参数 | 必填 | 说明 |
|------|------|------|
| `query` | 否 | 模糊匹配 `sub` / 显示名 / 邮箱，大小写不敏感；空串等同未传 |
| `state` | 否 | `active` \| `disabled`；其他取值 400 |

**响应**：`200`，`{ "items": [...] }`，按 `createdAt` 升序（先注册的在前）。

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | 本地用户 ULID，**不是** Logto `sub` |
| `sub` | string | Logto 身份标识，唯一 |
| `displayName` | string | 显示名，登录时按 Logto 返回刷新 |
| `email` | string \| null | Logto 未提供时为 `null` |
| `state` | `active` \| `disabled` | 停用后权限为空 |
| `roles` | string[] | 角色 key，已排序 |
| `createdAt` | string | 首次落库时间，UTC ISO-8601 |
| `lastSeenAt` | string | 最近一次取会话的时间 |
| `objects` | number | 归属该账号的**未删除**对象数（按 `owner_sub` 统计） |

```json
{
  "items": [
    {
      "id": "01JBUSER000000000000000000",
      "sub": "pakp_test",
      "displayName": "林默",
      "email": null,
      "state": "active",
      "roles": ["owner"],
      "createdAt": "2026-11-11T06:00:00.000Z",
      "lastSeenAt": "2026-11-13T04:20:00.000Z",
      "objects": 12
    }
  ]
}
```

**主要错误**：

| 状态 / 错误码 | 场景 |
|---------------|------|
| 400 `VALIDATION_FAILED` | `state` 取值非法（`details.field = "state"`） |
| 401 `UNAUTHORIZED` | 未登录 |
| 403 `FORBIDDEN` | 缺 `user:read` |
| 500 `INTERNAL` | 数据库异常 |

---

### 7.6 `PATCH /api/admin/users/{id}`

改角色、停用 / 恢复账号、改身份标识。三个字段全部可选，但**至少给一个**。

**权限**：

- `user:write` ——默认只有 `owner` 拥有；`admin` 角色**没有**这个权限，调用返回 403（提示「只有所有者可以修改账号」）。
- 改 `sub` 时还额外要求 `role:write`（同样只有 `owner`）；缺了返回 403，`details.field = "sub"`。

**路径参数**：`id` 是本地用户 ULID（7.5 响应里的 `id`），不是 `sub`。

**请求体**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `roles` | string[] | 角色 key 数组；会去重；含未知角色 → 400，`details.role` 指出是哪个。传空数组表示收回全部角色 |
| `state` | `active` \| `disabled` | 停用 / 恢复 |
| `sub` | string | 改身份标识；空串或全空白 → 400；与别的用户重复 → 409 |

**执行规则**：

- 一个事务里完成：更新 `users` 行 → 重写 `user_roles` → 写审计，任一步失败整体回滚。
- 只给**实际变化**的字段写审计：`user.roles.update`（`detail.from` / `detail.to`）、`user.state.update`（`detail.from` / `detail.to`）、`user.sub.update`（同上）。`roles` 传入相同集合视为无变化，不写审计。
- **不能移除或停用最后一个 active owner**：若该用户当前是 active owner，而变更后不再是（角色里去掉 `owner` 或 `state` 改为 `disabled`），且没有其他 active owner → `422 CONSTRAINT_VIOLATION`，`details.reason = "LAST_OWNER"`，事务回滚。
  - 恢复通道：`ADMIN_SUBS` 逃生舱（库里没有 active owner 时白名单重新生效），或离线执行 `npm run admin:grant -- <sub> owner`。两者都写审计。
- 改 `sub` 只改本地 `users.sub`，不影响 Logto 侧的账号；下一次登录必须使用新的 `sub` 才对得上。

**响应**：`200`，返回改动后的**完整用户对象**（字段同 7.5 的列表项，含实时 `objects` 计数）。

```json
{
  "id": "01JBUSER000000000000000000",
  "sub": "pakp_test",
  "displayName": "林默",
  "email": null,
  "state": "disabled",
  "roles": ["viewer"],
  "createdAt": "2026-11-11T06:00:00.000Z",
  "lastSeenAt": "2026-11-13T04:20:00.000Z",
  "objects": 12
}
```

**主要错误**：

| 状态 / 错误码 | 场景 |
|---------------|------|
| 400 `VALIDATION_FAILED` | 请求体不是 JSON 对象；三个字段都没给（「没有可修改的字段」）；`roles` 不是字符串数组或含未知角色；`state` 取值非法；`sub` 为空 |
| 401 `UNAUTHORIZED` | 未登录 |
| 403 `FORBIDDEN` | 缺 `user:write`（`owner` 以外的所有角色）；或改 `sub` 时缺 `role:write`（`details.field = "sub"`） |
| 404 `NOT_FOUND` | `id` 对应用户不存在（`details.id`） |
| 409 `CONFLICT` | `sub` 已被其他用户占用（`details.field = "sub"`） |
| 422 `CONSTRAINT_VIOLATION` | 移除 / 停用最后一个 active owner（`details.reason = "LAST_OWNER"`） |

> 403 的提示文案由调用方权限决定：缺 `user:write` 时是「只有所有者可以修改账号」；内层服务对改 `sub` 再判一次 `role:write` 时是「只有所有者可以修改账号标识」。两者都是 403，不要按 `message` 分支，按 `details.permission` / `details.field` 判断。

---

### 7.7 `GET /api/admin/roles`

角色 × 权限矩阵，**只读**。权限目录随响应一起返回，不单开 `/api/admin/permissions`。

**权限**：`user:read`（注意不是 `role:write`——查看矩阵与修改角色是两件事）。

**请求参数**：无。

**响应**：`200`

| 字段 | 类型 | 说明 |
|------|------|------|
| `items[]` | array | 角色目录，按 `sortOrder` 升序 |
| `items[].key` | string | `owner` / `admin` / `editor` / `viewer` |
| `items[].label` | string | 中文名（所有者 / 管理员 / 编辑 / 只读） |
| `items[].isSystem` | boolean | v1 恒为 `true`（角色不可自定义） |
| `items[].sortOrder` | number | 排序值 |
| `items[].permissions` | string[] | 该角色的权限 key，**不保证顺序** |
| `permissions[]` | array | 权限目录，每项含 `key`、`label`、`groupKey`、`sortOrder` |

```json
{
  "items": [
    { "key": "owner", "label": "所有者", "isSystem": true, "sortOrder": 10, "permissions": ["object:read", "object:write", "object:delete", "object:export", "vocabulary:category:write", "vocabulary:tag:write", "content:sync", "content:parse", "system:read", "audit:read", "user:read", "user:write", "role:write"] },
    { "key": "viewer", "label": "只读", "isSystem": true, "sortOrder": 40, "permissions": ["object:read"] }
  ],
  "permissions": [
    { "key": "object:read", "label": "查看内容", "groupKey": "内容", "sortOrder": 10 }
  ]
}
```

（示例有删节：真实响应返回全部 4 个角色与 15 项权限。）

**主要错误**：`401`、`403`（缺 `user:read`）、`500`。

---

### 7.8 `GET /api/admin/audit`

审计日志，游标分页。审计与业务写在同一事务里落库（审计写入失败即业务回滚），所以这里看到的每条 `ok` 记录都对应一次已提交的写操作。

**权限**：`audit:read`。

**查询参数**：

| 参数 | 必填 | 说明 |
|------|------|------|
| `action` | 否 | 精确匹配动作名，取值见下方清单；未知动作名不报错，只返回空列表 |
| `result` | 否 | `ok` \| `error` \| `denied`；其他取值 400 |
| `actor` | 否 | 操作者 `sub`，精确匹配 |
| `from` | 否 | 起始时间（含），字符串比较，传 UTC ISO-8601 即可 |
| `to` | 否 | 结束时间（含），同上 |
| `limit` | 否 | 1–200 的整数，默认 50；小数、越界 → 400 |
| `cursor` | 否 | 上一页的 `nextCursor`；**解码失败时静默忽略**，从第一页重新开始（不返回 400） |

动作名全量清单（`AUDIT_ACTIONS`）：

`object.delete`、`object.archive`、`object.unarchive`、`object.library.change`、`vocabulary.category.create`、`vocabulary.category.update`、`vocabulary.category.delete`、`vocabulary.tag.create`、`vocabulary.tag.update`、`vocabulary.tag.delete`、`vocabulary.tag.merge`、`content.sync.run`、`content.parse.run`、`user.roles.update`、`user.state.update`、`user.sub.update`、`user.bootstrap`、`authz.denied`。

**响应**：`200`

| 字段 | 类型 | 说明 |
|------|------|------|
| `items[]` | array | 审计行，按 `createdAt` 降序、同值按 `id` 降序 |
| `items[].id` | string | ULID |
| `items[].actorSub` | string | 操作者 `sub` 快照；CLI 恢复为 `cli:admin-grant` |
| `items[].actorUserId` | string \| null | 本地用户 id；用户已删除或 CLI 操作时为 `null`（审计不级联删除） |
| `items[].action` | string | 动作名 |
| `items[].targetType` | string \| null | 目标类型：`object`、`user`、`category`、`tag`、`permission` 等 |
| `items[].targetId` | string \| null | 目标 id；403 记录里是缺失的权限键 |
| `items[].detail` | string \| null | **JSON 字符串**，不是对象；需要自己 `JSON.parse` |
| `items[].result` | `ok` \| `error` \| `denied` | `denied` 专指 403 拒绝 |
| `items[].createdAt` | string | UTC ISO-8601 |
| `nextCursor` | string \| null | 下一页游标；没有更多时为 `null` |

```json
{
  "items": [
    {
      "id": "01JBAUD0000000000000000000",
      "actorSub": "pakp_test",
      "actorUserId": "01JBUSER000000000000000000",
      "action": "user.state.update",
      "targetType": "user",
      "targetId": "01JBUSER000000000000000000",
      "detail": "{\"from\":\"active\",\"to\":\"disabled\"}",
      "result": "ok",
      "createdAt": "2026-11-13T04:35:00.000Z"
    }
  ],
  "nextCursor": "MjAyNi0xMS0xM1QwNDozNTowMC4wMDBafDAxSkJBVUQwMDAwMDAwMDAwMDAwMDAwMDAw"
}
```

- 游标不透明：不要解析、不要自己拼；翻页期间有新写入也不会重复或漏行（不是 offset 分页）。
- 审计**只增不删**：没有自动清理，也没有归档脚本（ADR-019 只是约定了「10 万行阈值 + 按 `created_at` 归档到 `data/audit-YYYY-MM.jsonl`」，代码里尚未实现）。
- 只有读取接口：没有删除、也没有导出（CSV / JSONL）接口或页面按钮。

**主要错误**：

| 状态 / 错误码 | 场景 |
|---------------|------|
| 400 `VALIDATION_FAILED` | `result` 取值非法（`details.field = "result"`）；`limit` 不是 1–200 的整数（`details.field = "limit"`） |
| 401 `UNAUTHORIZED` | 未登录 |
| 403 `FORBIDDEN` | 缺 `audit:read` |
| 500 `INTERNAL` | 数据库异常 |

---

## 8. 大模型配置（`settings:*`，仅管理员）

「系统 → 大模型」（页面 `/admin/llm`）背后的接口（ADR-025）。图谱抽取默认走本机 Ollama，慢到会超时；这组接口让管理员换成外部 OpenAI 兼容服务。

四条接口对应四步操作，**保存与应用是分开的**：`PUT` 只落库，`POST /apply` 才写进 LightRAG 并重启它。这样「改个超时」不会每次都重启服务。

- **密钥只写不读**：任何响应都不含明文 API Key，只有 `hasKey` 与 `keyMasked`（形如 `sk-…abcd`）。
- **落库加密**：配置整体加密后写入 `settings` 表，密钥派生自环境变量 `SETTINGS_ENC_KEY`（缺这个变量时保存直接报错，不会降级成明文）。
- **`apiKey` 的三种写法**：省略 = 保持原值；显式空串 = 清除；非空字符串 = 替换。
- **`baseUrl` 约束**：必须 `https://`；`http://` 只允许 `localhost` / `127.0.0.1` / `::1`（本机 Ollama 走这条）；地址里不能带账号密码、查询串或锚点。
- **超时范围**：`timeoutMs` 30 000–1 800 000（默认 300 000）。

### 8.1 `GET /api/settings/llm`

读取当前配置。库里有保存值就返回保存值，否则回落到 `infra/lightrag/.env`，再否则用内置默认（Ollama `deepseek-r1:7b`）。

**权限**：`settings:read`。

**响应**：`200`

| 字段 | 类型 | 说明 |
|------|------|------|
| `provider` | `openai` \| `deepseek` \| `qwen` \| `ollama` \| `custom` | 供应商 |
| `baseUrl` | string | 接口地址（如 `https://api.deepseek.com`） |
| `model` | string | 模型名，≤ 120 字符 |
| `timeoutMs` | number | 单次请求超时 |
| `hasKey` | boolean | 是否已保存密钥 |
| `keyMasked` | string \| null | 掩码后的密钥；没有密钥为 `null` |
| `appliedToLightrag` | boolean | 已保存配置是否与 `infra/lightrag/.env` 一致（不一致说明「待应用」） |
| `updatedAt` | string \| null | 最近一次保存时间；`null` 表示当前值来自 `.env` / 内置默认，还没在页面保存过 |

```json
{
  "provider": "deepseek",
  "baseUrl": "https://api.deepseek.com",
  "model": "deepseek-chat",
  "timeoutMs": 300000,
  "hasKey": true,
  "keyMasked": "sk-…abcd",
  "appliedToLightrag": false,
  "updatedAt": "2026-11-13T09:10:00.000Z"
}
```

**主要错误**：401 未登录；403 缺 `settings:read`；500 `SETTINGS_ENC_KEY` 缺失或解密失败。

---

### 8.2 `PUT /api/settings/llm`

保存配置。**不重启、不自动应用。**

**权限**：`settings:write`。

**请求体**（全部可选，缺省沿用当前生效值）：

| 字段 | 类型 | 说明 |
|------|------|------|
| `provider` | 五个枚举之一 | 其他值 → 400 |
| `baseUrl` | string | 见上文约束 |
| `model` | string | 非空，≤ 120 字符 |
| `timeoutMs` | number | 30 000–1 800 000 的整数 |
| `apiKey` | string | 省略 = 保持；`""` = 清除；有值 = 替换，≤ 512 字符 |

**响应**：`200`，与 8.1 同形的配置视图（`updatedAt` 已刷新，密钥仍是掩码）。

**主要错误**：

| 状态 / 错误码 | 场景 |
|---------------|------|
| 400 `VALIDATION_FAILED` | 请求体不是 JSON 对象；`provider` 取值非法；`baseUrl` 不是合法 URL / 用了 `http` 且非本机 / 带账号密码或查询串；`model` 为空或超长；`timeoutMs` 越界或非整数；`apiKey` 超长 |
| 401 / 403 | 未登录 / 缺 `settings:write` |
| 500 `INTERNAL` | `SETTINGS_ENC_KEY` 缺失或加解密失败 |

> 保存会写一条审计 `settings.llm.update`，`detail` 里只有 `provider` / `model` / `baseUrl` / `keyChanged`，**不含密钥**。

---

### 8.3 `POST /api/settings/llm/test`

向供应商发一个最小请求（`max_tokens: 8`，内容 `ping`），验证地址、模型与密钥是否可用。**只测不写**：请求体里可以带尚未保存的新密钥，测试通过也不会落库。

**权限**：`settings:write`。

**请求体**：可选，字段同 8.2（通常只带刚输入、还没保存的 `apiKey` 或 `baseUrl`）。请求体不是 JSON 时按「全部沿用已保存值」处理。

**响应**：`200`（失败原因也是业务结果，不用错误信封）

| 字段 | 类型 | 说明 |
|------|------|------|
| `ok` | boolean | 是否可用 |
| `latencyMs` | number | 往返耗时 |
| `status` | number \| null | 上游 HTTP 状态；网络层失败为 `null` |
| `error` | string（可选） | 失败原因，已归一到四类之一 |

失败原因分两类给出：**上游拒绝**（`401` / `403` → 「鉴权失败（API Key 无效或权限不足）」；`404` → 「接口地址不对」；其它 → 「供应商返回 HTTP <状态码>」，并附上游响应体前 300 字，密钥会被替换成掩码）；**网络层**（「请求超时」「无法连接：目标地址未监听」「无法解析域名」「证书校验失败」或原始错误摘要）。测试请求的超时上限固定为 30 秒，不跟随配置里的长超时。

**主要错误**：401 / 403；400（`baseUrl` / `provider` 等字段非法；未填 API Key 且供应商不是 Ollama）。

---

### 8.4 `POST /api/settings/llm/apply`

把已保存的配置写进 `infra/lightrag/.env`，然后**只重启 `lightrag-server`**（不碰 embedding 服务），并轮询 `/health` 最多 60 秒。

**权限**：`settings:write`。

**请求体**：无。

**执行步骤**：

1. 读库里的配置；没有保存过 → 400「请先保存大模型配置再应用」。
2. 备份现有 `.env` 到 `<同一目录>/.env.bak-<时间戳>`。
3. 重写 `.env` 里的 `LLM_BINDING` / `LLM_MODEL` / `LLM_BINDING_HOST` / `LLM_BINDING_API_KEY` / `LLM_TIMEOUT` 五个键，其他行原样保留；文件中缺失的键追加到末尾。本机 Ollama 的密钥为空时写入占位值 `ollama`。
4. 结束 `lightrag-server` 进程并重新拉起。
5. 每 2 秒请求一次 `/health`，最多 60 秒。

**响应**：`200`

| 字段 | 类型 | 说明 |
|------|------|------|
| `applied` | boolean | 恒为 `true`（失败走错误） |
| `restarted` | boolean | 是否真的重启了服务 |
| `rolledBack` | `false` | 成功响应里恒为 `false` |
| `backup` | string | 备份文件名（不是完整路径） |
| `healthLatencyMs` | number \| null | 健康检查耗时；未重启（演练模式）为 `null` |
| `updatedAt` | string | 应用完成时间 |

**失败与回滚**：写盘之后的任何失败（重启失败、健康检查超时）都会把备份 `.env` 还原回去，再尝试重启回原配置，然后抛出 `500 INTERNAL`；`details.rolledBack` 为 `true` 表示已还原，错误信息里会说明「回滚后服务是否恢复」。**这是唯一会改动运行中服务的接口**，验收实例或 CI 里禁止调用（会把验收实例的 LightRAG 一起重启）。

**主要错误**：

| 状态 / 错误码 | 场景 |
|---------------|------|
| 400 `VALIDATION_FAILED` | 还没有保存过配置 |
| 401 / 403 | 未登录 / 缺 `settings:write` |
| 500 `INTERNAL` | 找不到 `infra/lightrag/.env`；写盘失败；重启失败；60 秒内健康检查未通过（`details.rolledBack`、`details.backup`）；平台不是 Windows（自动重启目前只支持本机 Windows） |

> 成功后写审计 `settings.llm.apply`，`detail` 含 `provider` / `model` / `baseUrl` / `backup` / `restarted`，**不含密钥**。

---

## 9. 知识图谱

图谱接口把业务对象的主内容同步进 LightRAG，并提供实体、邻域与图增强问答。读接口要求 `object:read`，同步接口要求 `content:sync`；LightRAG 不可用时返回 `500 INTERNAL`。

> **单租户限制**：LightRAG 的图 / 问答路由绑定默认 workspace，不按 `ownerSub` 隔离实体与答案正文。当前仅适用于单用户本机部署；`POST /api/graph/query` 的来源对象会按归属过滤，但答案文本仍可能包含其他用户写入的内容。开放多用户前必须先做实例级隔离。

### 9.1 `GET /api/graph/labels`

返回图谱中的全部实体标签，供实体列表使用。

**请求**：无参数。

**响应**：`200`

```json
{ "labels": ["#2B6CB0", "前端设计团队", "品牌蓝"] }
```

排序由 LightRAG 决定（字典序），可能包含抽取噪声（如单独的 `#`）；前端只在展示时把含文字 / 数字的实体排在前面，不删除数据。

**主要错误**：401 未登录；500 LightRAG 请求失败或响应格式异常。

---

### 9.2 `GET /api/graph`

读取一个实体的邻域子图。

**查询参数**：

| 参数 | 必填 | 说明 |
|------|------|------|
| `label` | 是 | 实体名，1–100 字符；空或超长返回 400 |
| `depth` | 否 | 1–3 的整数，默认 2；非法值返回 400 |
| `maxNodes` | 否 | 50–600 的整数，默认 150；非整数 / 越界返回 400（`details.field = "maxNodes"`） |

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
- 节点上限由 `maxNodes` 决定（50–600，默认 150）；子图沿**有向边**展开，只有入边的实体会返回空图。
- 图谱页的 `/graph?maxNodes=` 是同一参数的验收 / 诊断入口，页面不提供 UI 控件；`/graph` 只在 50–600 的整数取值，其余回落 150。

**主要错误**：400 参数非法；401 未登录；500 LightRAG 失败。

---

### 9.3 `POST /api/graph/sync`

把当前用户的对象内容同步进 LightRAG。**只负责入库**，实体抽取在 LightRAG 后台异步进行，进度看 9.4。

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

### 9.4 `GET /api/graph/status`

汇总 LightRAG 中**当前账号拥有**的业务对象的图文档状态（按 `file_path` 的 `pakp:obj:{objectId}:` 前缀映射回对象，再按归属过滤）。

**响应**：`200`

```json
{
  "total": 2,
  "byStatus": { "PROCESSED": 1, "FAILED": 1 },
  "counts": { "processed": 1, "extracting": 0, "queued": 0, "failed": 1, "unknown": 0 },
  "objects": [
    {
      "objectId": "01...",
      "title": "FDE100 案例集_江苏篇",
      "docId": "doc-...",
      "status": "FAILED",
      "state": "failed",
      "error": "抽取超时：本地模型过慢",
      "errorRaw": "C[1/4]: doc-...-chunk-000: ",
      "chunksCount": 4,
      "updatedAt": "2026-11-13T08:12:00"
    }
  ],
  "failed": [{ "objectId": "01...", "error": "抽取超时：本地模型过慢" }]
}
```

- `byStatus` 的键是 LightRAG 原始状态（实测 `PENDING` / `PROCESSING` / `PROCESSED` / `FAILED`），按对象选中那条文档的状态计数。
- `counts` 把原始状态归并为五个应用态：`processed` / `extracting` / `queued` / `failed` / `unknown`，供页面直接显示。
- `state = failed` 时，`error` 是归一后的可读原因（六类：``抽取超时：本地模型过慢``、``抽取服务连接失败：请确认 LightRAG 与模型服务已启动``、``抽取失败：模型接口的密钥或权限被拒绝``、``抽取失败：模型接口限流或额度不足``、``抽取失败（未返回原因）``、``抽取失败：<首行摘要>``），`errorRaw` 始终是 LightRAG 原文；非失败态两者都为 `null`。
- 同一对象存在多个版本时只取当前应展示的一条（按状态优先级挑选），不做逐条罗列。
- 手工放入 LightRAG、未带 `pakp:` 前缀的文档，以及其他账号的对象都不计入。

**主要错误**：401 未登录；500 LightRAG 失败。

---

### 9.5 `POST /api/graph/retry`

重新抽取**失败**态的对象（当前账号拥有的对象）。只重投当前状态为 `failed` 的图文档，非失败对象返回 `skipped`，抽取仍在 LightRAG 后台进行，进度以 `GET /api/graph/status` 为准。不会同步 RAGFlow 内容，只针对图抽取层——若对象主内容还没解析成功，直接返回失败并提示先完成内容解析。

**权限**：`content:sync`。

**请求体**：

| 字段 | 类型 | 说明 |
|------|------|------|
| `objectIds` | `string[]` | 要重新抽取的对象 id 数组，1–20 个；重复项按一次算，非字符串项被忽略 |

**示例**：

```json
{ "objectIds": ["01M786QGYP6NXAPHPPW4GCHJCF"] }
```

**响应**：`200`

```json
{
  "requested": 1,
  "resubmitted": 1,
  "results": [
    { "objectId": "01M786QGYP6NXAPHPPW4GCHJCF", "title": "FDE100 案例集_江苏篇", "outcome": "resubmitted", "message": null }
  ]
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `requested` | number | 去重后请求的对象数（≥ 1，≤ 20） |
| `resubmitted` | number | 已重新投递抽取的数量 |
| `results[]` | array | 每个对象的处理结果，顺序与去重后的请求 id 一致 |
| `results[].objectId` | string | 对象 id |
| `results[].title` | string | 对象标题（用于前端展示，不是 id 短码） |
| `results[].outcome` | `"resubmitted" \| "skipped" \| "failed"` | `resubmitted` 已投递；`skipped` 不是失败态（已完成 / 抽取中 / 排队 / 无记录）；`failed` 这次重试没投递 |
| `results[].message` | string \| null | 未投递时的原因：对象不存在或不属于当前账号 / 已经完成抽取，无需重试 / 正在抽取，等它结束再试 / 还在排队，等它开始再试 / 没有可重试的失败记录，先刷新进度 / 还没有解析成功的主内容，先完成内容解析再重试 |

**主要错误**：
- 400 `objectIds` 不是数组；为空；超过 20 个。
- 401 未登录；403 缺 `content:sync`。
- 500 无法构造 LightRAG / RAGFlow 客户端。

> 重试不等于同步：同步（`POST /api/graph/sync`）负责把内容写进 LightRAG；重试（本接口）只负责对已经入图但抽取失败的对象重发。若失败原因是「模型接口限流或额度不足」，短期内重复重试大概率再次失败，建议先在「系统 → 大模型」里换外部模型或补充额度。

---

### 9.6 `POST /api/graph/query`

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

## 10. Logto 登录路由（浏览器跳转，非 JSON 接口）

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

> 浏览器内完整登录（换码并进入 `/workspace`）已于 2026-11-11 用测试账号 `pakp_test` 端到端验证；操作过程见 [08_RUN_LOG.md](08_RUN_LOG.md)。

---

## 11. curl 示例（`AUTH_MODE=mock`，本地直接可用）

开发环境默认就是 `AUTH_MODE=mock`，无需登录、无需 Cookie。

```bash
BASE=http://localhost:3000

# 1. 健康检查
curl -s $BASE/api/health

# 2a. 先确保标签在词表里（未知标签会让下一步报 400 TAG_NOT_FOUND）
curl -s -X POST $BASE/api/vocabulary/tags \
  -H 'Content-Type: application/json' \
  -d '{"label": "长文"}'

# 2. 新建作品（作品固定从 draft 开始；category 必须是启用中的分类 code）
curl -s -X POST $BASE/api/objects \
  -H 'Content-Type: application/json' \
  -d '{
    "type": "work",
    "title": "第一篇长文",
    "library": "internal",
    "category": "article",
    "tags": ["长文"]
  }'

# 3. 列出作品：默认不含已归档、已删除，默认 100 条
curl -s "$BASE/api/objects?type=work&library=internal"

# 4. 关键字 + 分类 + 排序 + 分页（非法值一律 400）
curl -s -G "$BASE/api/objects" \
  --data-urlencode "q=知识" \
  --data-urlencode "category=article" \
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

# 17. 内容检索（q 必填；limit 1-50，默认 10；threshold 0-1，默认 0.2；mode 默认 hybrid）
curl -s -G "$BASE/api/search" \
  --data-urlencode "q=知识管理" \
  -d "limit=10&library=internal&threshold=0.2&mode=hybrid"

# 17b. 只用词法（首页预览走这条，不碰 RAGFlow）
curl -s -G "$BASE/api/search" \
  --data-urlencode "q=复盘 -tag:模板" \
  -d "mode=lexical&limit=8"

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

# 22. 读词表：分类 + 标签 + 使用次数
curl -s $BASE/api/vocabulary

# 23. 新增分类 → 改名 / 排序 → 删除（被引用时先迁移到 uncategorized）
curl -s -X POST $BASE/api/vocabulary/categories \
  -H "Content-Type: application/json" \
  -d '{"label":"podcast"}'
curl -s -X PATCH $BASE/api/vocabulary/categories/podcast \
  -H "Content-Type: application/json" \
  -d '{"label":"Podcast","sortOrder":70}'
curl -s -X DELETE "$BASE/api/vocabulary/categories/podcast?migrateTo=uncategorized"

# 24. 标签：新增 / 改名 / 合并 / 删除
curl -s -X POST $BASE/api/vocabulary/tags \
  -H "Content-Type: application/json" \
  -d '{"label":"ai"}'
curl -s -X PATCH $BASE/api/vocabulary/tags/<tagId> \
  -H "Content-Type: application/json" \
  -d '{"label":"AI"}'
curl -s -X POST $BASE/api/vocabulary/tags/<tagId>/merge \
  -H "Content-Type: application/json" \
  -d '{"targetLabel":"AI"}'
curl -s -X DELETE $BASE/api/vocabulary/tags/<tagId> \
  -H "Content-Type: application/json" \
  -d '{"removeFromObjects":true}'

# 25. 大模型配置：读 → 保存 → 测试 → 应用（密钥只写不读）
curl -s $BASE/api/settings/llm
curl -s -X PUT $BASE/api/settings/llm \
  -H "Content-Type: application/json" \
  -d '{"provider":"deepseek","baseUrl":"https://api.deepseek.com","model":"deepseek-chat","apiKey":"sk-…"}'
curl -s -X POST $BASE/api/settings/llm/test \
  -H "Content-Type: application/json" \
  -d '{"baseUrl":"https://api.deepseek.com","model":"deepseek-chat","apiKey":"sk-…"}'
curl -s -X POST $BASE/api/settings/llm/apply

# 26. 重新抽取失败对象（1–20 个）
curl -s -X POST $BASE/api/graph/retry \
  -H "Content-Type: application/json" \
  -d '{"objectIds":["01M786QGYP6NXAPHPPW4GCHJCF"]}'
```

`<id>` 替换为上一步返回的对象 `id`，`<refId>` 替换为内容引用列表里的 `id`，`<tagId>` 替换为 `GET /api/vocabulary` 返回的标签 `id`；示例里的 `revision` 需要按实际返回值调整。中文请写进 `.json` 文件再用 `--data-binary @x.json` 提交（例如 `{"label":"播客"}`），Windows 下不要把中文直接内联在 `-d` 里。词表写接口在 `AUTH_MODE=mock` 下直接放行（本地身份恒为管理员）。

内容上传、解析轮询、内容下载与检索都依赖真实 RAGFlow：`.env.local` 里要有 `RAGFLOW_BASE_URL` 与 `RAGFLOW_API_KEY`，缺任一项这些接口返回 500（对象增删改查与 `/api/health` 不受影响）。检索在 dataset 尚未创建时返回空结果而不是错误。

图谱接口依赖本机 LightRAG：`.env.local` 里要有 `LIGHTRAG_BASE_URL`（默认 `http://127.0.0.1:9621`）与 `LIGHTRAG_API_KEY`；LightRAG 未启动或密钥不对时返回 500。图谱内容来自 RAGFlow 已解析的主内容，两者都可用才有意义。

---

## 12. 尚未实现（不要按这些能力设计调用方）

以下能力**当前代码中不存在**，本文不作契约承诺：

| 能力 | 现状 |
|------|------|
| 内容删除 / 附件解绑 | 未实现。没有删除某条 `content_ref`、列出对象全部附件或解绑单个附件的接口；删除只能走对象级 `DELETE` + worker（整对象全部文档） |
| RAGFlow 问答会话 | 未实现。检索接口只返回召回片段，不组装上下文、不调用 chat model，也没有多轮会话 |
| 图谱多用户隔离 | 未实现。LightRAG 图 / 问答路由绑定单实例默认 workspace，`/api/graph/*` 只适用于单用户本机部署（见第 9 节顶部说明） |
| 图谱自动同步 | 未实现。没有定时同步或对象变更后自动入图；只能手动 `POST /api/graph/sync`，且单轮最多 50 个对象 |
| 图谱实体 / 关系编辑 | 未实现。实体与关系只来自 LightRAG 抽取，不能改名、合并或手工补边 |
| 列表总数 / 游标 | 未实现。`GET /api/objects` 只返回数组，没有 `total`、页码或游标 |
| 多用户权限 / 角色 / 共享 | 部分实现（ADR-019）：15 项权限 × 4 个系统角色，接口层统一由 `requirePermission()` 强制（矩阵与管理员接口见 7.4–7.8）。仍**没有**自定义角色（`role:write` 预留、无写入接口）、协作、共享或对象级 ACL；对象继续按 `owner_sub` 归属过滤，跨账号只能看到自己的对象（见 1.3） |
| 审计归档与导出 | 未实现。`audit_events` 只增不删，没有归档脚本、没有导出接口；ADR-019 约定的「10 万行后归档到 `data/audit-YYYY-MM.jsonl`」尚未落地 |
| OpenAPI / Swagger 描述文件 | 未实现。本文是唯一接口说明 |
| 词表界面之外的维护方式 | 管理页已实现（`/admin/vocabulary/categories`、`/admin/vocabulary/tags`），界面以外没有批量导入 / 导出词表、没有分类或标签的回收站，删除即不可撤销 |
| 同步投递与解析轮询的失败路径实测 | 失败重试 / 退避 / 解析失败回写目前只有假网关单测覆盖；真实 RAGFlow 上验证的是成功路径（上传 → 解析完成 → 检索 → 下载 → 归档后检索为 0） |

> 检索的相似度由 RAGFlow 的 embedding 模型决定，换模型或换解析器后同样的查询会得到不同的分数与排序。阈值 0.2 只是默认值，不是质量承诺。

---

## 13. 变更记录

| 日期 | 变更 |
|------|------|
| 2026-11-11 | 首版：覆盖 `health`、`objects` 七个端点与三条 Logto 跳转路由；补充错误码表与未实现清单 |
| 2026-11-11（HEAD `49e26de`） | 补入四个新能力：`GET /api/objects/{id}`（对象详情）、`GET /api/objects/{id}/library`（迁移审计读取）、`POST /api/objects/{id}/content`（multipart 内容上传与 RAGFlow 映射）、`GET /api/objects` 的 `q` / `category` / `tag` / `status` / `sort` / `limit` / `offset`。端点总览更新为 14 条；未实现清单删去已实现的条目 |
| 2026-11-11（HEAD `1ea0b86`） | 补入 outbox 消费端：新增 `POST /api/sync/run` 与后台 worker 行为（启动条件、间隔、认领上限、失败退避），端点总数 15 条；更新 PATCH / DELETE / 跨库迁移里「只入队不投递」的旧表述；未实现清单移除「同步 worker 未实现」，保留解析轮询、检索、下载与 OpenAPI 等当时仍缺失的能力。同日已在真实 RAGFlow 上端到端验证投递：迁移库别后 meta 回读为 `library=external`、删除对象后文档从数据集消失；失败重试仍为假网关单测 |
| 2026-11-11（HEAD `a7aa5f3`） | 列表 `archived` 参数扩展为 `true` / `false` / `only`，非法取值改为 400（此前非 `true` 的值被静默忽略） |
| 2026-11-11（HEAD `b860530`） | 补入四条内容链路接口：`POST /api/parse/run`（手动解析轮询，单轮 50 条）、`GET /api/objects/{id}/content`（内容引用列表）、`GET /api/objects/{id}/content/{refId}`（原文下载，二进制流）、`GET /api/search`（内容检索，含归属 / 归档 / 库别过滤）；端点总数 19 条。上传章节改为「上传即触发解析」，第 10 节移除已实现的解析轮询、检索、下载与内容列表。实测（RAGFlow v0.20.5）：上传即 `running`，9–12 秒后 `succeeded`、`chunk_count=1`；检索相似度 0.38–0.48；下载与上传文件逐字节一致；归档后同一检索 0 条 |
| 2026-11-11（Phase 3） | 新增第 7 节「知识图谱」五条接口：`GET /api/graph/labels`、`GET /api/graph`、`POST /api/graph/sync`、`GET /api/graph/status`、`POST /api/graph/query`；端点总数 24 条。标注单 workspace 限制、50 对象同步上限、`pakp:obj:` 来源前缀、问答 180 秒超时。未实现清单移除「LightRAG 知识图谱」，新增图谱多用户隔离、自动同步、实体编辑三条。实测（LightRAG 1.5.7，本机 CPU）：118 字文档抽取约 3.8 分钟、9 实体 / 3 关系；`mix` 问答 93.8 秒 |
| 2026-11-11（ADR-012） | 新增错误码 `FORBIDDEN`（403）：已登录但不在 `ADMIN_SUBS` 白名单时调用管理员接口。`POST /api/sync/run`、`POST /api/parse/run` 收紧为仅管理员，端点总览与 7.2 / 7.3 执行规则、响应表同步更新；未实现清单的「多用户权限 / 角色」由「未实现」改为「部分实现（单一管理员布尔角色）」。正文编辑复用 `POST /api/objects/{id}/content`，不新增路由，总数仍为 24 条 |
| 2026-11-12（ADR-016 词表化） | 新增第 6 节「词表接口」8 条：`GET /api/vocabulary`（形态 + 标签 + 使用次数，唯一读取入口）、`POST /api/vocabulary/categories`、`PATCH` 与 `DELETE /api/vocabulary/categories/{code}`（`?migrateTo=` 先迁移再删）、`POST /api/vocabulary/tags`、`PATCH` 与 `DELETE /api/vocabulary/tags/{id}`（可选 `removeFromObjects`）、`POST /api/vocabulary/tags/{id}/merge`；写接口仅管理员（403）。端点总数 24 → 32 条。对象结构同步改为词表口径：`tags` 最多 10 项、单项 ≤ 20 字，写入时自动创建缺失标签；`format` 改为 `work_formats` 的 code 且必须是启用状态（不存在或已停用返回 404，不再按「固定六个取值」返回 400）。第 11 节原「词表管理页面未实现」一条由「界面已实现、仅缺批量导入 / 回收站」取代 |
| 2026-11-13（ADR-024 检索） | `GET /api/search` 扩展：新增 `mode=hybrid\|lexical\|semantic`（默认 hybrid）、检索语法表（空格 AND / `"短语"` / `title:` `desc:` `category:` `tag:` 与中文同义前缀 / `-` 与 `NOT` 排除 / 未知前缀按文本 / `OR`、括号报错）；新增错误码 `QUERY_SYNTAX`（400，`details.position` 为 0 基位置）；`total` 语义改为合并去重后的对象数，新增 `counts` / `lexical` / `semantic` 块与 `hits[].source` / `score` / `matchedFields` / `chunkCount` / `highlightTerms`，旧字段在纯词法命中时为 `null`；`threshold` 明确只作用于语义；`hybrid` 下语义 3 秒硬超时只降级不报错。端点总数不变（32 条） |
| 2026-11-13（文档补全：形态与管理员接口） | 补入 4 条管理员接口并新增 7.4–7.8：`GET /api/admin/users`（`user:read`）、`PATCH /api/admin/users/{id}`（`user:write`，改 `sub` 另需 `role:write`；最后一个 active owner 被移除 / 停用时 422 `CONSTRAINT_VIOLATION` + `details.reason = "LAST_OWNER"`）、`GET /api/admin/roles`（`user:read`，角色 × 权限矩阵 + 权限目录只读）、`GET /api/admin/audit`（`audit:read`，游标分页，`detail` 是 JSON 字符串）。**`/api/vocabulary/formats*` 按代码核实为 ADR-023 的 308 跳转壳，不是独立词表接口**，故未按「POST /api/vocabulary/formats」另立端点，改为 6.9 说明跳转行为。端点数核实：`src/app/api/**/route.ts` 共 **31 个文件 / 31 条路径**，按本文既有的「方法 × 路径」口径展开为 **36 条**（33 业务 / 系统 + 3 Logto；此前记 32 条漏了这 4 条管理员接口，差额来自 4 个多方法文件），另有 2 条 308 旧路径单列不计。按 ADR-019 现状同步更正 §1.3 权限判定（`ADMIN_SUBS` 只剩引导作用）、§1.4 错误码（补 `QUERY_SYNTAX` / `TAG_NOT_FOUND` / `CATEGORY_EXISTS` / `CATEGORY_ARCHIVED` / `AUDIT_FAILED`，`FORBIDDEN` 改为缺权限）、§7.1 响应加 `authMode`、§7.2 / §7.3 权限表述、§11「多用户权限」现状。另按代码更正对象结构口径：`categories` / `primaryCategory` 已删除（传入即 400），`tags` 里的未知标签改为 400 `TAG_NOT_FOUND`（不再隐式创建，ADR-023），§4.1 `category` 筛选改为 code 精确匹配，§10 示例补建标签步骤。§8.2 未改动 |
| 2026-11-13（ADR-025 / ADR-026） | 新增第 8 节「大模型配置」四条接口（GET / PUT / POST test / POST apply，需 settings:read / settings:write，权限总数 13 → 15）、`GET /api/objects/{id}/content/{refId}` 的 `?inline=1` 与内容预览弹窗，以及第 9.5 节 `POST /api/graph/retry`（需 content:sync）… 端点总数 36 → 43 条（按实际表格行核对，原文档口径少算 2 条，一并更正），route.ts 文件 31 → 35 个 |
