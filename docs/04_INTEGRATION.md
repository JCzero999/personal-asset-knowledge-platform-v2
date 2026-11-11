# 集成细节（RAGFlow / LightRAG / Logto）

> 本文件只记录已确认决策与已实测的集成事实。`待实测` 表示当前没有可填写的真实值；禁止把历史建议端口、规划地址或草案字段写成已可用配置。
>
> 当前环境：本机 Docker 可用（Docker 29.9.2 / Compose v5.6.1）；已完成 Logto 自托管部署与连通性实测，RAGFlow / LightRAG / Embedding 仍未部署。

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

- 部署方式：本地 Docker
- 内容职责：统一内容存储、解析、分块、向量化与检索（ADR-005）
- 当前状态：等待 Docker；未部署、未连接、未验证

| 字段 | 实测值 |
|---|---|
| 版本 | 待实测 |
| Base URL | 待实测 |
| 服务端口 | 待实测 |
| 管理界面地址 | 待实测 |
| 已验证环境变量名 | 待实现并验证 |
| Dataset / Document 接口契约 | 待 Phase 2 真实调用验证 |
| 解析与检索验证结果 | 待 Phase 2 验证 |
| Asset / Work 映射结果 | 待 Phase 2 验证 |

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
- 当前状态：模型与服务配置待实测

| 字段 | 实测值 |
|---|---|
| 提供方 / 模型 | 待实测 |
| 服务地址 | 待实测 |
| 维度与配置 | 待实测 |
| 两套系统验证结果 | 待 Phase 2 / Phase 3 验证 |

## 设计草案（非已验证集成）

- [DRAFT：元数据、content_ref、四阶段状态机与 Logto 清单](drafts/01_PHASE1_DESIGN.md)
- 草案中的应用 env 名和 OIDC 路径均需正式实现后复核，不得据此判断服务已可用。
