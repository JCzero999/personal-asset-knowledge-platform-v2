# 个人资产与知识平台

以 RAGFlow 为统一内容存储与检索底座，在其上实现资产管理与四阶段工作流的个人知识工作台。当前仓库处于 **greenfield 本地骨架**阶段。

## 当前实现状态

- Next.js 16 App Router + React + TypeScript
- 未登录 / 已登录 UI 壳子；已登录身份是**明确标注的 Mock 用户**
- 本地健康检查：`GET /api/health`
- Asset / Work 业务元数据 TypeScript DRAFT，只包含元数据、状态与 `contentRef`
- `.env.example` 包含 Logto / RAGFlow / Embedding 空占位，不含真实服务密钥
- **未连接** Logto、RAGFlow、LightRAG；未实现数据库持久化、真实认证或资产 CRUD

内容唯一真相源是 RAGFlow（ADR-005）。本地类型与后续轻量存储不得保存另一份内容正文真相。

## 本地运行

要求：Node.js 20.9 或更高版本（Next.js 16 要求）。

```bash
npm install
npm run dev
```

打开 Next.js 输出的本地地址；默认开发地址为 `http://localhost:3000`。首页按钮只切换 Mock UI，不会发起 Logto 登录。

健康检查：

```text
GET /api/health
```

## 验证命令

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

健康检查单元测试不依赖任何容器或外部服务。

## 配置

`.env.example` 保留 agents 已有模型配置，并追加业务应用规划变量。Logto / RAGFlow / Embedding 的真实值必须等实际部署后填写；不要在 Git 中提交 `.env`、`.env.local` 或任何真实密钥。

OIDC 回调路径、应用 env 名和 `content_ref` 映射均为草案，详见 [Phase 1 DRAFT](docs/drafts/01_PHASE1_DESIGN.md)。已验证集成事实只写入 [集成文档](docs/04_INTEGRATION.md)。

## 目录

```text
src/app/                 Next.js App Router、页面与健康检查
src/components/          Mock 工作台 UI 壳
src/lib/metadata.ts      Asset / Work / ContentRef 类型草案
tests/                   无外部依赖的单元测试
docs/                    产品边界、ADR、进度与集成事实
docs/drafts/             未实施、未实测的设计草案
agents/                  CrewAI 文档进度 Agent（非业务应用）
```

## 开发约束

1. 先读 `AI_CONTINUE_DEV_GUIDE.md`、`docs/00_SCOPE.md` 与 `docs/03_DECISIONS.md`。
2. 每次有意义工作后按 `docs/prompts/maintain-docs.md` 更新 `docs/02_PHASES.md` 和 `docs/05_CHANGELOG.md`。
3. Docker 未就绪前不要启动容器，不要编造 Logto / RAGFlow 接口、端口或 `content_ref`。
4. 重大方向变化必须新增 ADR，不得直接推翻已采纳决策。
