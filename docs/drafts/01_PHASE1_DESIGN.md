# DRAFT — Phase 1 业务元数据、工作流与 Logto 接入清单

> **状态：设计草案，未接真实服务。** 本文件不描述已验证的 Logto / RAGFlow 接口，也不确认任何外部端口。真实集成信息必须在 Docker 环境验证后写入 `docs/04_INTEGRATION.md`。
>
> 约束：ADR-005（RAGFlow 为内容唯一真相源）、ADR-003（单用户登录/注册，无 RBAC）、ADR-006（greenfield）。

## 1. 本轮边界

- 已落地：Next.js 本地骨架、Mock 用户 UI、`/api/health`、TypeScript 元数据类型。
- 未落地：数据库持久化、Logto SDK/OIDC、RAGFlow 客户端、真实 `content_ref`、资产 CRUD、工作流 API。
- 下述 SQLite 与字段设计均为草案；本轮不引入数据库依赖，不创建业务数据库文件。

## 2. Asset / Work 业务元数据草案

### 2.1 存储建议

候选为 **SQLite**（待后续阶段确认），只保存业务元数据、状态和 RAGFlow 映射，不保存内容正文，不保存本地 Markdown 副本。

代码中的初步类型位于 `src/lib/metadata.ts`。TypeScript 使用 `contentRef` camelCase；持久化与文档字段名为 `content_ref`，序列化时一一对应。

| 字段 | 适用对象 | 草案类型 | 职责 |
|---|---|---|---|
| `id` | Asset / Work | string | 业务对象本地唯一标识 |
| `type` | Asset / Work | `asset` / `work` | 区分业务对象类型 |
| `title` | Asset / Work | string | 业务展示元数据，不是内容正文 |
| `library` | Asset / Work | `internal` / `external` | 内库 / 外库分类 |
| `categories` | Asset / Work | string[] | 业务分类元数据 |
| `tags` | Asset / Work | string[] | 业务标签元数据 |
| `priority` | Asset / Work | `low` / `medium` / `high` | 业务优先级 |
| `status` | Work | 四阶段枚举 | 工作流状态；只存业务侧 |
| `content_ref` | Asset / Work | object / null | 指向真实 RAGFlow 内容的应用映射 |
| `created_at` | Asset / Work | ISO 8601 string | 业务创建时间 |
| `updated_at` | Asset / Work | ISO 8601 string | 业务更新时间 |

`content_ref = null` 仅表示尚未建立真实映射的草案状态；禁止写入假 ID 冒充已同步。后续内容操作必须基于真实 RAGFlow 返回的标识。

### 2.2 Asset / Work ↔ RAGFlow Document 映射 DRAFT

> `provider`、`dataset_id`、`document_id` 是**业务侧映射字段名**，不代表已核实的 RAGFlow API 请求或响应字段。

| 业务字段 | 映射目标 | 当前状态与规则 |
|---|---|---|
| `content_ref.provider` | 内容提供方标识 | 应用内固定候选值 `ragflow`，仅用于业务判别 |
| `content_ref.dataset_id` | RAGFlow Dataset 标识 | **待真实接口验证**；由 Phase 2 适配层返回值填充 |
| `content_ref.document_id` | RAGFlow Document 标识 | **待真实接口验证**；由 Phase 2 适配层返回值填充 |
| `title` / 分类 / 标签 / 优先级 | 业务元数据 | 保存在业务侧；是否同步及同步格式待验证 |
| `status` | 无物理内容映射 | 状态流转不移动 RAGFlow 文档 |
| 内容正文 / 原始文件 | RAGFlow 管理的内容 | 不进入 SQLite/JSON 业务元数据存储 |

### 2.3 后续实现顺序（未执行）

1. 依据真实部署与官方文档验证 Dataset / Document 的创建、读取、更新契约。
2. 在 Phase 2 实现独立 RAGFlow 适配层，不让业务对象依赖未核实的响应结构。
3. 仅在真实调用成功后保存映射；失败时保留明确错误，不生成伪 `content_ref`。
4. 补充事务边界、重复提交、内容更新与删除的一致性策略，再启用业务 CRUD。

## 3. 四阶段状态机 DRAFT

初始状态为 `draft`。本草案只定义顺序前进，不定义回退、跳过或并行分支；未确认前不得自行增加这些边。

| 当前状态 | 下一状态 | 触发者 | 副作用边界 |
|---|---|---|---|
| `draft` | `finished` | 已通过 Logto 认证的本工作区单一用户（待实现） | 只更新业务状态与 `updated_at` |
| `finished` | `published` | 同上 | 只更新业务状态与 `updated_at` |
| `published` | `practiced` | 同上 | 只更新业务状态与 `updated_at` |

- 不跨阶段流转；其他迁移边暂未定义。
- 触发者规则不包含 RBAC 或多用户数据隔离。
- 状态变化不复制、移动或重写 RAGFlow 内容。
- 除状态外的进入条件、回退规则与审计字段仍待产品确认。
- 当前 Mock UI 不是认证，不触发上述状态迁移。

## 4. Logto 集成步骤清单（Docker 后逐项验证）

以下 env 名与回调路径是**应用侧规划**，不是对 Logto 已配置值或官方 SDK 细节的声明。

### A. 环境与真实配置

- [ ] 按接手指南第 6 节先验证 Docker / WSL，再部署并访问 Logto。
- [ ] 在 `04_INTEGRATION.md` 记录实测版本、地址、端口与控制台入口。
- [ ] 按实际 Logto 控制台与官方文档创建应用，记录真实应用配置。
- [ ] 将密钥仅写入本地 `.env`，不提交 Git，不写入 RAGFlow 内容。

### B. 应用配置候选

| 规划项 | 候选名称 / 路径 | 验证状态 |
|---|---|---|
| 应用根地址 | `APP_URL` | 待实际运行地址 |
| Logto 服务地址 | `LOGTO_ENDPOINT` | 待 Docker 实测 |
| 应用 ID | `LOGTO_APP_ID` | 待控制台创建 |
| 应用密钥 | `LOGTO_APP_SECRET` | 待控制台创建 |
| 会话 Cookie 密钥 | `LOGTO_COOKIE_SECRET` | 待本地安全生成 |
| 登录入口 | `/api/auth/sign-in` | DRAFT，未实现 |
| OIDC 回调 | `/api/auth/callback` | DRAFT，未实现 |
| 退出入口 | `/api/auth/sign-out` | DRAFT，未实现 |

### C. 正式接入与验收

- [ ] 根据当前 Next.js 版本和 Logto 官方文档确认 SDK / OIDC 方案，再调整上述候选路径。
- [ ] 在真实 Logto 应用配置中登记实际回调地址，核对协议、主机、端口与路径。
- [ ] 实现登录 / 注册入口、OIDC 回调、会话存储和退出。
- [ ] 移除 Mock 用户作为身份来源，从服务端会话读取真实用户身份。
- [ ] 验证未登录访问、登录、注册、回调、刷新后会话与退出的完整路径。
- [ ] 将已验证的 env 名、回调路径与调用方式更新到 `04_INTEGRATION.md`。

## 5. 明确不在本草案内

- 不定义或猜测 RAGFlow / Logto 的请求 URL、响应 schema、默认端口。
- 不实现加密分享、试运行评估、旧图谱、多用户隔离或 RBAC。
- 不让本地文件、SQLite 或 JSON 成为内容真相源。
