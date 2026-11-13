# 操作实录：真实登录联调与验收（2026-11-11）

> **目的**：把「从回调 500 到真实登录跑通」这一轮的实际操作、命令、观察值和判定依据原样留档，供复现与排障。
> **写法**：只写实测到的值和亲眼看到的输出；未实测的标「未验证」。问题编号与 [07_PLAYBOOK.md](07_PLAYBOOK.md) 第 4 节一致。
> **环境**：Windows 11，项目根目录 `D:\projects\Personal Asset & Knowledge PlatformV2`，分支 `master`，时区 Asia/Shanghai。

---

## 1. 前置状态

| 服务 | 端口 | 版本 | 检查命令 | 实测结果 |
|------|------|------|----------|----------|
| Next.js（dev，`AUTH_MODE=logto`） | 3000 | Next.js 16.4.3 | `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3000/api/health` | `200` |
| Logto | 3001 / 控制台 3002 | 1.46.0 | `curl -s -o /dev/null -w '%{http_code}' http://localhost:3001/api/status` | `204` |
| RAGFlow | 9380 / Web 18080 | v0.20.5 | `curl -s -o /dev/null -w '%{http_code}' http://localhost:9380/v1/system/version` | `200` |
| LightRAG | 9621 | 1.5.7 | `curl -s -o /dev/null -w '%{http_code}' -H "X-API-Key: $LIGHTRAG_API_KEY" http://127.0.0.1:9621/health` | `200` |
| 本地 embedding | 9381 | bge-large-zh-v1.5 | `curl -s http://127.0.0.1:9381/v1/models` | 返回模型列表 |
| Ollama | 11434 | deepseek-r1:7b | `ollama list` | 模型存在 |

**账号**

| 账号 | Logto `sub` | 用途 |
|------|-------------|------|
| `pakp_test` | `7vjekboa76zu` | 联调与冒烟；验证完可在 Logto 控制台删除 |
| `JCzero001` | `gdv8t04dw4ca` | 用户本人账号；链路同一，尚未在应用内亲自登录一次 |

**操作边界**：用户要求不动其 Chrome（保留 Logto 控制台登录与个人浏览），且不打断前台使用。因此全部验证走后台：HTTP + 无头 Chromium（`chrome-headless-shell` + CDP），不激活窗口、不移动真实光标。

---

## 2. 问题一：登录回调 500（`redirect_uri_mismatched`）

### 2.1 现象

点击首页「登录」→ 进入 Logto 登录页 → 输入 `pakp_test` 账号密码 → Logto 回跳 `http://localhost:3000/api/logto/sign-in-callback`，页面 500。

### 2.2 定位过程

1. 看应用日志：回调路由抛错，错误码 `callback_uri_verification.redirect_uri_mismatched`，提示 "The callback URI mismatches the redirect URI."
2. 对照 Logto 控制台登记值：应用「个人资产与知识平台」的 Redirect URI 是 `http://localhost:3000/api/logto/sign-in-callback`。
3. 读 `@logto/next` 的 `handleSignIn` 实现：第二个参数传 `URLSearchParams` 时，SDK 会**自行**按 `${baseUrl}/callback` 拼回调地址，不读取路由实际路径。
4. 结论：请求里带去的 `redirect_uri` 是 `http://localhost:3000/callback`，与控制台登记的 `/api/logto/sign-in-callback` 不一致，Logto 拒绝换码。

### 2.3 修复（`src/app/api/logto/sign-in-callback/route.ts`）

```ts
export async function GET(request: Request) {
  // 传完整回调 URL：助手默认按 `${baseUrl}/callback` 拼地址，与登记的
  // `/api/logto/sign-in-callback` 不一致时会报 redirect_uri_mismatched。
  await handleSignIn(createLogtoConfig(), new URL(request.url));
  redirect("/workspace");
}
```

### 2.4 复验

| 步骤 | 命令 / 动作 | 实测结果 | 判定 |
|------|-------------|----------|------|
| 假 code 探针 | `GET /api/logto/sign-in-callback?code=fake&state=fake` | 报错从 `redirect_uri_mismatched` 变为 `sign_in_session.not_found` | 回调地址校验已通过，剩下的是假 code 导致的预期错误 |
| 真实登录 | 无头浏览器提交 `pakp_test` 账号密码 | 回调 `307` → `/workspace` `200`，页面显示账号名 | 换码、写会话 Cookie、落到工作台全链路通 |

---

## 3. 问题二：注册 / 改密 500（弱密码检查回调外网）

### 3.1 现象

在 Logto 控制台创建账号、或用户提交密码时，`POST /api/experience/profile` 返回 500。

### 3.2 定位

```text
getaddrinfo EAI_AGAIN api.pwnedpasswords.com
```

Logto 默认启用 pwned password 检查，每次设置密码都请求外网 `api.pwnedpasswords.com`。本机当前 DNS 解析不了该域名，请求直接失败，注册流程 500。

### 3.3 修复（`infra/logto/docker-compose.yml`）

```yaml
logto:
  environment:
    # 无外网 DNS 时 pwned password 检查会 EAI_AGAIN 导致注册 500，这里关闭
    ENABLE_PWNED_PASSWORD_API: "false"
```

执行 `docker compose -f infra/logto/docker-compose.yml up -d` 重建容器。复验：`pakp_test` 注册成功，`/api/status` 仍为 `204`。

---

## 4. 真实登录端到端冒烟（无头浏览器）

### 4.1 为什么不用前台窗口

后台被遮挡的 Chromium 会冻结渲染：地址栏和标题已经变了，页面内容还停在上一页，可访问性树为空（现象见 [07_PLAYBOOK.md](07_PLAYBOOK.md) 第 4 节第 33 条）。用截图判断页面状态会得到假结果。

替代方案：本机 `chrome-headless-shell` + CDP，独立临时用户目录、独立调试端口 9333，不碰用户 Chrome。

### 4.2 操作步骤

1. 启动无头浏览器：`chrome-headless-shell --headless=new --remote-debugging-port=9333 --user-data-dir=<临时目录>`
2. `PUT http://127.0.0.1:9333/json/new?about:blank` 新建页面，拿到 WebSocket 地址。
3. 导航到 `/api/logto/sign-in`，等待 `location.host === "localhost:3001"`。
4. 用原生 setter 写入 `input[name=identifier]` 与 `input[type=password]`，派发 `input` 事件，点击 `button[type=submit]`。
5. 等待回到 `localhost:3000`，逐页断言。
6. 同一会话内用 `fetch` 打接口，验证写路径与错误路径。

脚本只放系统临时目录（`%TEMP%\pakp-smoke\`），不入库；请求中的密码来自测试账号，不写入文档与日志。

### 4.3 断言与实测

| # | 断言 | 期望 | 实测 |
|---|------|------|------|
| 1 | 登录后落地页 | `/workspace`，显示账号名 | 通过 |
| 2 | `/workspace` 渲染 | 页面文本非空、含对象区 | 通过 |
| 3 | `/search` 渲染 | 检索表单可见 | 通过 |
| 4 | `/graph` 渲染 | 实体区可见 | 通过 |
| 5 | `/workspace/{id}` 详情 | 标题与元数据出现 | 通过 |
| 6 | 身份写入 | `POST /api/objects` 返回 `201`，响应体顶层 `id` 存在 | 通过（首次误判为 FAIL，见 4.4） |
| 7 | 非法请求体 | `POST /api/objects` 空标题 → `400` | 通过 |
| 8 | 匿名访问 | 无 Cookie `GET /api/objects` → `401` | 通过 |
| 9 | 兜底 | 无异常页面 / 控制台报错 | 通过 |

### 4.4 冒烟脚本自身的一个误判

第一版断言读 `body.data.id`，而接口返回的是 `{ id, ... }` 顶层字段，于是「创建失败」实为断言写错；数据库里对象已建成。改为 `body.id ?? body.data.id` 后通过。教训：冒烟失败先核对响应体结构，再怀疑业务。

---

## 5. 问题三：图谱跨账号可见

### 5.1 现象

用新账号（0 个对象）登录后打开 `/graph`，实体列表显示 **9 个实体**，均为另一账号此前同步过的测试文档抽出的实体。

### 5.2 根因

- LightRAG 1.5.7 的 workspace 是**进程级**的，`LIGHTRAG-WORKSPACE` 请求头只覆盖部分路由（如 `/health`），`/graphs`、`/query` 等使用的是实例默认 workspace，无法按请求切换。
- 因此所有账号的数据写进同一个图；`/api/graph/labels`、`/graphs` 直接返回全局结果。
- 图上还留有已删除对象的历史文档（`file_path` 指向已不存在的对象），放大了泄漏面。

### 5.3 决策与实现（ADR-011，读侧过滤）

不重建 LightRAG，也不假装有强隔离；在应用侧把「属于当前账号」作为读取前提：

| 位置 | 处理 |
|------|------|
| `LightragNode` / `LightragEdge` | 带出 `properties.file_path` |
| 标签列表 | 探针最多 200 个全局标签，逐个取 `maxDepth=1` 子图，只保留触达本账号 `pakp:obj:{objectId}:*` 的标签；结果按账号缓存 60 秒 |
| 实体邻域 | 节点按 `file_path` 归属过滤；边要求两端都保留且自身 `file_path` 归属 |
| 构图进度 | 文档状态按本账号对象 ID 过滤 |
| 图问答 | 引用只认 `pakp:obj:` 前缀并回查归属；无有效引用时返回空答复，不混入他人内容 |

### 5.4 复验

| 账号 | 修复前 `/graph` | 修复后 `/graph` |
|------|------------------|------------------|
| `pakp_test`（0 个对象） | 9 个实体 | 0 个实体，空状态提示 |
| 有对象的账号 | 正常 | 正常，实体与邻域不受影响 |

### 5.5 代价与触发条件

同名的全局实体仍在抽取阶段合并，图内数据本身不是隔离的。多账号同时使用图谱前，需要按 `ownerSub` 拆分 LightRAG 实例或工作目录；这一条写进了 [02_PHASES.md](02_PHASES.md) 的待办与 [07_PLAYBOOK.md](07_PLAYBOOK.md) 第 7.1 节。

---

## 6. 生产模式运行检查

| 步骤 | 命令 | 实测结果 |
|------|------|----------|
| 构建 | `npm run build` | 成功，路由全部编译 |
| 启动 | `npm run start`（临时改用 3100，避免占用 dev 的 3000） | 正常监听 |
| 健康 | `GET /api/health` | `200` |
| 首页 | `GET /` | `200` |
| 未登录受保护页 | `GET /graph` | `307 → /`（`AUTH_MODE=logto` 的预期行为） |
| 登录入口 | `GET /api/logto/sign-in` | `307` 到 Logto 授权页 |

检查完即停掉临时进程，dev server（3000）保持运行。

---

## 7. 服务自启

| 项 | 内容 |
|----|------|
| `scripts/autostart.ps1` | 幂等拉起 Logto（Docker）、RAGFlow（Docker）、LightRAG + embedding（本机 Python）；`-Check` 只检查，`-App` 连带起应用；末尾打印端口状态，全部就绪退出码 0 |
| `scripts/install-autostart.ps1` | 在当前用户「启动」文件夹创建 `PAKP Autostart.lnk`，指向 `powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File <根目录>\scripts\autostart.ps1`；`-Remove` 撤销 |
| 提权 | `schtasks` 方式被系统拒绝（拒绝访问），因此改用启动文件夹，无需管理员 |
| 编码坑 | PowerShell 5.1 把无 BOM 的 UTF-8 当 ANSI 读，两个脚本首版报「字符串缺少终止符」；已改为带 BOM 保存 |
| 验证 | `powershell -ExecutionPolicy Bypass -File scripts\autostart.ps1 -Check` 输出四项均 `up`，退出码 0 |

Ollama 已有独立自启项，本脚本不重复拉起。

---

## 8. 质量门禁

| 检查 | 命令 | 结果 |
|------|------|------|
| 类型 | `npm run typecheck` | 通过 |
| 规范 | `npm run lint` | 通过 |
| 测试 | `npm test` | 19 个测试文件 / 216 项通过 |
| 构建 | `npm run build` | 通过 |

---

## 9. 遗留事项（未验证 / 未实现）

1. **真实 RAGFlow 故障注入未做**：解析失败回写、outbox 退避、500 / 断网语义目前只有假网关单测覆盖，没有在真实 RAGFlow 上构造故障实测。
2. **多轮问答未实现**：需要 chat model API key；当前 RAGFlow 只有本地 embedding，检索可用、生成不可用。
3. **图谱强隔离未做**：读侧过滤已上线（ADR-011），抽取阶段仍是全局合并。
4. **本人账号未亲自登录**：`JCzero001`（`sub` `gdv8t04dw4ca`）的链路与测试账号相同，只差一次应用内登录。
5. **测试账号待清理**：`pakp_test` 验证完可在 Logto 控制台删除；删除不影响代码。
6. **自启脚本只拉起、不等待健康**：调用方需用 `-Check` 复核，或在应用侧做重试。

---

## 10. 2026-11-11 第 2 轮：反馈修复、正文编辑与管理员后台

来源：使用者一次性反馈 6 个问题（[10_BACKLOG.md](10_BACKLOG.md)）。本节只记真实操作，不写「应该」。

### 10.1 三条 UI 缺陷的定位与修复

| 问题 | 定位过程 | 结论 |
|------|----------|------|
| 检索框占位文字被圆圈压住 | 读 `globals.css` 里 `.text-input` / `.filter-input` 的声明顺序：`.filter-input` 的 `padding-left: 34px` 写在前面，`.text-input` 的 `padding` 简写写在后面、优先级相同 → 被整体覆盖 | 用 `.text-input.filter-input` 组合选择器覆盖；另隐藏 WebKit 原生搜索清除按钮（视觉上也是一个「圆圈」） |
| 侧栏「最近内容 / 作品进程」点了不动 | 两项目 `href` 是 `/workspace#recent` / `/workspace#track`；页面地址已经是 `/workspace`，`<Link>` 视为同一路由，不触发滚动 | 页内锚点改原生 `<a>`；`.recent-panel` / `.track-panel` 加 `scroll-margin-top: 24px` |
| 登录后找不到退出登录 | 原实现只有一个 11px 弱化文字链接，且仅在 `signOutHref` 非空时渲染 | 侧栏底部改为账号卡片 + 整行「退出登录」描边按钮；mock 身份显示「本地身份，无需登录」 |

### 10.2 管理员后台

1. 按 ADR-012 实现：`src/server/roles.ts` 纯函数派生 `isAdmin`，`session.ts` 注入，适配器只返回身份。
2. `ADMIN_SUBS=gdv8t04dw4ca` 写入 `.env.local`（未跟踪），`.env.example` 留空占位。
3. 验证不碰在跑的 3000 dev 服务：复制项目到临时目录 → `node node_modules/next/dist/bin/next build --webpack` → `next start -p 3211` 并临时覆盖 `AUTH_MODE=mock`：
   - `/admin` 返回 200，页面含「依赖服务」「存储与队列」「用户与归属」「立即同步队列」「推进解析状态」；
   - 侧栏出现「系统管理」；`/workspace` 200；详情页含「编写正文」；
   - 验证完关闭 3211 进程并删除临时目录，原 `node_modules` 与 dev 服务未受影响。
4. 收紧 `POST /api/sync/run`、`POST /api/parse/run`：非管理员返回 `403 FORBIDDEN`（新增错误码与状态映射）。

### 10.3 正文编辑器（主程交付，已复核）

- `content-editor.tsx`：原生 `textarea` + 行号列（超过 20000 行不再渲染行号）、行数 / 字数、Tab 缩进、`Ctrl/Cmd+S`、未保存离开确认；保存走 `POST /api/objects/{id}/content`（`role=primary`），仍是「同一行替换 + 删旧文档」。
- 可编辑判定在 `src/lib/content-format.ts`：扩展名 `.md/.markdown/.txt/.json/.csv` 或 MIME `text/*`。
- 复核方式：读代码 + 跑全量单测（20 个文件 / 223 项）。

### 10.4 旧项目前端审计

前端设计工程师读取 `D:\projects\Personal Asset & Knowledge Platform` 的页面、组件与样式变量，输出 [11_LEGACY_UI_AUDIT.md](11_LEGACY_UI_AUDIT.md)。结论：可优先搬「正文编辑 + 预览」「Ctrl+K 命令面板」「列表 + 详情分栏」；旧项目**没有**登录 / 会话 / 角色，相关设计不能照搬。

### 10.5 遗留

- 三条 UI 修复需使用者在真实账号下点一次（本次只在临时实例里做了页面级验证）。
- 管理员入口需重启开发服务后才会读到新的 `ADMIN_SUBS`。
- 编辑器暂无语法高亮与分屏预览，按审计建议排下一轮。

---

## 11. 2026-11-13 Phase 6B：检索影子列迁移、1 万对象压测与降级实测

**迁移演练**（`node scripts/rehearse-search-migration.mjs`，两份库先 `VACUUM INTO` 备份再在副本上跑 0008 + 回填）：

| 库 | 备份 | 对象数 | 迁移数 | 回填 | `missingNorms` | 外键自检 |
|----|------|--------|--------|------|----------------|----------|
| `data/app.db` | `data/backups/2026-11-12T16-44-10/app.db` | 5 | 8 → 9 | 5 | 0 | 0 |
| `data/dev.db` | `data/backups/2026-11-12T16-44-10/dev.db` | 3 | 8 → 9 | 3 | 0 | 0 |

两份库 `ok: true`、`failures: []`，`objects_owner_scope_idx` 存在，抽样行的 `title_norm` 与 JS 归一化结果一致。

**真实库迁移**：`data/app.db` 启动时自动执行，日志留痕 `[db] 迁移前已备份：…\data\app.db.bak-2026-11-12T16-44-28-555Z`；`data/dev.db` 手工执行，回填 3 行，备份 `data/dev.db.bak-2026-11-12T16-44-45-684Z`。两库迁移后 `missing = 0`、`foreign_key_check` 为空。

**截图用演示数据**：为了拍出有结果的检索页面，临时在 `data/app.db` 里插了 6 个对象（`obj6b…`）与 4 个标签（`tag6b…`），再 `VACUUM INTO` 复制成 `data/capture-6b.db` 并把归属改成 `mock-local-user`。拍完后已把 6 个对象、8 条对象标签关联与 4 个标签从 `data/app.db` 删除，真实库回到迁移后的 5 个对象 / 2 个标签；演示数据只留在 `data/capture-6b.db`，重拍截图时用它即可。

**压测**（`PERF=1 node node_modules/vitest/vitest.mjs run tests/perf/search-bench.test.ts`，内存库，单进程，Windows 本机）：

| 项目 | 读数 | 目标 |
|------|------|------|
| 写入 1 万条对象 | 2236 ms | — |
| 词法 p95 `复盘` | 11.51 ms | ≤ 60 ms |
| 词法 p95 `个人知识` | 6.74 ms | ≤ 60 ms |
| 词法 p95 `课程` | 12.12 ms | ≤ 60 ms |
| 词法 p95 `写作模板` | 7.17 ms | ≤ 60 ms |
| 词法 p95 `知识 系统` | 8.26 ms | ≤ 60 ms |
| 预览 8 条 p95（同上五组） | 4.71 / 3.83 / 6.14 / 4.04 / 3.63 ms | ≤ 30 ms |
| 语义挂起降级 | `status=timeout`，3020 ms，命中 10 条 | 3 秒硬截止，词法结果照常返回 |

`EXPLAIN QUERY PLAN` 输出：`SEARCH objects USING INDEX objects_owner_scope_idx (owner_sub=? AND deleted_at=? AND archived_at=?)`——候选集先按归属与状态收窄，再对影子列求 `instr`。

**截图**（`node scripts/phase6b-capture.mjs`，`AUTH_MODE=mock`、`DATABASE_PATH=data/capture-6b.db`、3000 端口，脚本自带无头 Chrome + CDP）：

- `phase6b-home-preview-desktop.png`：首页输入「复盘」，200ms 后出现 2 条下拉项，`<mark>` 高亮存在
- `phase6b-home-preview-mobile.png`：390×844，下拉整宽、`panel.top ≥ input.bottom`、无横向溢出
- `phase6b-home-no-results.png`：输入「量子纠缠实验」，显示「没有匹配的内容」
- `phase6b-search-syntax-error.png`：`/search?q=复盘 OR 写作`，错误块整行显示原文、金色 `^` 与「第 4 个字符附近」
- `phase6b-search-results.png`：`/search?q=复盘&mode=lexical`，2 个对象各一条，「关键词命中」徽标与「仅影响语义结果」说明在位

5 张图零 console / page 错误。验收用的 mock 实例用完即停，3000 端口已恢复为 `AUTH_MODE=logto` 指向 `data/app.db`。

**质量门**：`npm test` 37 文件 484 项全绿（`tests/perf/search-bench.test.ts` 的 3 项默认跳过）；`npm run typecheck` 通过；`npm run lint` 0 error（15 条既有未使用变量警告）。

**未验证**：真实 Logto 会话下的首页预览；移动端触摸与软键盘交互（只验证了渲染与布局）；真实 RAGFlow 服务上的并发语义检索（只用假网关与挂起网关验证降级）；10 万级对象下的 `instr` 全表扫描成本。

---

## 12. 2026-11-13 Phase 6：3D 银河布局与 Worker（`layoutGalaxy3d`，ADR-022 附录 A3）

**范围**：只落三个文件——`src/lib/graph-layout-3d.ts`、`src/workers/graph-layout.worker.ts`、`tests/lib/graph-layout-3d.test.ts`。不碰界面 / CSS / API / `package.json` / 三个冻结件；不提交、不推送、不安装依赖。

**播种口径**：三层盘世界单位 85 / 150 / 210（垂向抖动 ±10 / ±22 / ±32），角度 `360°/n` 均分 + `hash(id)` 抖动 ±0.06rad，不可达节点 340。随机源只有 `stableHash(id)`；`seedKey` 不参与坐标（单测断言换 `seedKey` 结果逐字节相同）。

**松弛**：边弹簧（饱和 1.5）+ 节点斥力（≤300 节点 O(n²)，>300 网格哈希，cutoff 96）+ 径向约束（刚度 0.25、饱和 3.5）+ 碰撞（相切外 1.2 世界单位）。固定步长，单 tick 位移上限 4，按 id 码点序迭代。径向约束的符号在初版写反（沿外法线朝外推），实测 85 环塌到 29、340 外环塌到 14，被「1/2/3 跳半径单调」与「不可达外环」两条用例挡住后修正。

**实测（Node 24 / vitest node 环境，同机）**：

| 输入 | ticks | truncated | layoutMs | 包围球半径 |
|---|---|---|---|---|
| 150 节点（冷启动） | 80 | false | 7.1 ms | 254.5 |
| 150 节点（第 2 次） | 80 | false | 3.0 ms | 254.5 |
| 300 节点 | 150 | false | 17.9 ms | 306.9 |
| 625 节点 | 220 | false | 139.5 ms | 407.8 |
| 2271 节点 → 抽稀到 2000，`deadlineMs: 400` | 144 | true | 402.4 ms | 458.1 |

150 节点松弛后的平均半径 93.6 / 152.0 / 222.0（播种 85 / 150 / 210），最小间距 28.5 世界单位。300 节点 17.9ms 略高于 A3 表里「≤300 同步算（≤16ms）」的参考值，是冷启动 JIT 未热的一测，未做进一步优化。

**质量门（本轮现测）**：`node node_modules/vitest/vitest.mjs run` → 45 文件 625 项通过 / 3 项跳过（新增 `graph-layout-3d.test.ts` 24 项全绿）；`node node_modules/typescript/bin/tsc --noEmit` 通过；`eslint` 对三个新文件 0 error。

**未验证**：真实 WebGL 下的观感（半径与 ring 只是数学产物，屏幕效果要等 B 线渲染层接上）；真 Worker 实例里的 postMessage 往返（协议只测纯函数与假作用域）；`deadlineMs` 到点截断的位置与机器负载相关，所以「逐字节确定」只在显式固定 `maxTicks` 时成立。

---

## 13. 2026-11-13 Phase 6 修一轮：Worker 双时钟接线与取消语义（ADR-022 A3 v1.3）

**范围**：只改 `src/workers/graph-layout.worker.ts` 与 `tests/lib/graph-layout-3d.test.ts`；`src/lib/graph-layout-3d.ts` 本轮**零改动**（冻结签名、算法、世界单位全部未动）。不碰界面 / CSS / API / `package.json` / 三个冻结件；不提交、不推送、不装依赖。

**1）默认 400ms 预算接线**：新增 `WORKER_TICK_BUDGET_MS = 400` 与 `withWorkerBudget()`，在 Worker 包装层注入 `deadlineMs`——调用方显式给值（含 `0`）优先，不给就是 400。`layoutGalaxy3d` 的冻结签名没有默认值这件事保持不变，主线程直调仍然不受隐式 deadline 约束（用例锁定：2000 节点 220 tick、`truncated=false`）。

**2）取消选 b（队列丢弃）**：布局是同步循环，Worker 在整段布局期间不派发消息 → 「运行中取消」物理上不存在；旧实现还把 `cancelled` 在下次 layout 前清零，等于永远无效。现在请求进 one-slot 队列、由一次宏任务 flush；flush 之前到达的 `cancel`（或更新的 `layout`）丢弃尚未开始的请求，并回一条 `{ type: "cancelled" }`；已经开始的布局由 400ms 预算兜底。旧用例「cancel 后下一次 layout 立即退出并 truncated」本身就是「cancel 无效」的证据，已按新语义重写。**出站协议因此多了一个成员 `cancelled`**，A3 回写时需一并更新。

**3）主线程 import 无副作用**：自动挂载判据由 `typeof self` 改为 `WorkerGlobalScope !== undefined`（浏览器主线程 `self === window`，用 `self` 判断会把监听装到 window 上并向 window postMessage）。新增两条用例：模拟 window（`self` 指向带 `postMessage` / `addEventListener` 的对象）import 后不注册监听、不 postMessage；模拟 `WorkerGlobalScope` 存在时只挂一个 `message` 监听。

**4）现状核对（不改代码，供 A3 回写「钉住」措辞）**：anchor 节点 `pinned=2`、首步落在 anchor 坐标、积分循环跳过 → 完全钉住；星核固定原点（`pinned=1`，换中心时旧中心让位）；不可达节点在 340 外环 + `±32` 垂向抖动；>2000 节点按 view.nodes 已有排序取前 2000。与「钉住」口径一致。

**实测（同机，Node 24 / vitest node 环境）**：

| 路径 | ticks | layoutMs | truncated |
|---|---|---|---|
| 2000 节点，Worker 默认预算（不传 `deadlineMs`） | 119 | 401.1 ms | true |
| 2000 节点，直调 `layoutGalaxy3d`（无默认预算） | 220 | 700.6 ms | false |

**质量门（本轮现测）**：`vitest run tests/lib/graph-layout-3d.test.ts` → 33 项全绿（原 24 项中 22 项原样通过、2 项按新取消语义改写，新增 9 项）；全仓 `vitest run --maxWorkers=2` → 45 文件 634 项通过 / 3 项跳过（默认并发下 5 个测试进程报 JS heap OOM，是这台机器的并行内存压力，降到 2 worker 全绿）；`tsc --noEmit` 0 错误；eslint 对两个改动文件 0 error。

**未验证**：真 Worker 实例里的 cancel / 队列往返（协议仍是纯函数 + 假作用域测试）；「模拟 window」是 node 里伪造的 `self`，不是真 jsdom；`cancelled` 回执需要 B 线调用方消费（当前仓里还没有 worker 调用方）。

---

## 14. 2026-11-13 Phase 6D：3D 真实渲染层（B 线第二步）

**范围**：`src/components/graph/graph-scene-3d.tsx` 整体替换（默认导出与 `GraphScene3DProps` 字节级不变），新增 `node-field.tsx` / `edge-field.tsx` / `label-layer.tsx` / `starfield.tsx` 与 `src/lib/graph-render.ts`，测试 `tests/lib/graph-render.test.ts`，验收脚本 `scripts/graph-perf.mjs`。不碰 `globals.css` / `graph-explorer.tsx` / `src/app/**` / `package.json` / 三个冻结件；无新依赖（不用 drei、不用后处理）；不提交、不推送。

**分层与 draw call**：星场 1 + 光晕 1 + 节点 1（单 `InstancedMesh`，六种 SDF 形状在片元里区分）+ 边 3（`LineSegments2` 默认 / strong / accent）+ 标签 1（`InstancedBufferGeometry` + 2048×1024 canvas 图集）+ 选中环 1。默认视角实测 6，最重的选中态 8，仍在 ≤8 内。

**这一轮验收揪出并修掉的 6 个真问题**：

1. **节点整层不可见（draw call 照常计数）**：实例属性在 effect 里 `setAttribute`，JSX 又挂了零值占位属性，任何一次重渲染都会把占位属性重新 attach 回去，`vColor` 全变 0 → 片段 `discard`。改成声明式 `instancedBufferAttribute attach="attributes-*"`、由 memoized 数组驱动。
2. **自转打开后 0 帧**：`frameloop="demand"` 下 props 变化本身不启动循环。`Rotator` 增加 `useEffect(() => invalidate(), [autoRotate])`，关闭时画完最后一帧自然停。
3. **选中态误报「3D 渲染上下文丢失」**：R3F 卸载 Canvas 会 `forceContextLoss()`，同样派发 `webglcontextlost`。改成 `setTimeout(0)` 后确认 `canvas.isConnected` 才回调 `onError("context-lost")`。
4. **2D→3D 切回后 frames / labels 停在 0**：Canvas 以 0×0 挂载、尺寸落定后 R3F 不补帧；且静止时只有 1–3 帧，永远到不了 30 帧的发布节拍。加尺寸 effect（`invalidate(3)` + 260ms 后主动 `publish` 一次真实读数）。
5. **标签避让算的框和画出来的位置不一致**：避让按「星点上方」算框，渲染却把四边形**居中在星点**上，两边错位 → 中心区仍然重叠。新增 `aOffset` 实例属性（屏幕像素位移），渲染矩形 = `layoutLabels` 输出的框；同时注意视图空间 Y 轴朝上、屏幕 Y 轴朝下，取反后文字才落在框里。
6. **避让只做截断、中心标签仍挤在一起**：`layoutLabels` 改为每个标签依次试 5 个候选位移（默认 / 上移一行 / 左移半宽 / 右移半宽 / 下移一行），高优先级先占位、低优先级错位或隐藏；`forced`（选中 / 悬停 / 路径）候选全冲突时夹回视口硬放。非 forced 的候选必须整框落在视口内。

**取景**：ADR-022 的初始机位 `[0,160,620]` 实测亮部包围盒只有 ~66%×70%（验收要求 75–85%）。按同一视线方向推近 1.13 倍到 `[0,142,550]`，实测 76.0%×80.8%。fov 45 / near 1 / far 4000、OrbitControls 的 120–1100 距离范围都没动 —— **这是对 ADR 初始机位的有意偏离，需要 A3 回写时确认**。节点世界半径乘 `NODE_SIZE_SCALE = 1.6`（普通节点 2.7–4.6 px、星核 ~7.5 px 半径）。

**实测（无头 Chrome，真实 WebGL / SwiftShader，1440×900 dpr 1，150 节点 157 边）**：

| 场景 | tier | dpr | drawCalls | labels | frames | layoutMs / ticks | 说明 |
|---|---|---|---|---|---|---|---|
| 默认视角 | high | 1 | 6 | 28（预算 40） | 2 | 6.9 ms / 80 | 空闲 2s 帧差 0；标签框两两相交 0 对 |
| 自动旋转（开 2s） | high | 1 | 6 | 27 | 120 → 360 | 同上 | `rafActive=true`，关闭后帧差 0 且 `rafActive=false` |
| 选中 + 路径 | high | 1 | 8 | 28 | 2 | 6.9 ms / 80 | 无错误横幅；路径条「知识管理 → 常青笔记 · 1 跳」 |
| 低档窄屏 390×844 | low | 1 | 6 | 8（预算 12） | 2 | 6.7 ms / 80 | 移动端 `isMobile` 生效，DPR 压到 1 |

截图：`docs/screenshots/phase6d-3d-default.png`、`phase6d-3d-selection.png`、`phase6d-3d-low.png`（同一脚本每次重跑覆盖）。

**质量门（本轮现测）**：`vitest run tests/lib/graph-render.test.ts` → 34 项全绿（新增视觉半径缩放、forced 错位、候选位移内移三组断言）；全仓 `vitest run --maxWorkers=2` → 45 文件 672 项通过 / 3 项跳过；`tsc --noEmit` 0 错误；eslint 对本轮 8 个文件 0 error / 0 warning。

**未验证 / 需要知会**：

- **Worker 路径没有被这次渲染验收覆盖**：`GRAPH_MAX_NODES_DEFAULT = 150`，UI 里走不到 >300 节点分支；Worker 侧只有 `graph-layout-3d.test.ts` 的纯函数与假作用域用例。渲染层读的是同一个 `GalaxyLayoutResult`，但「真 Worker → 真渲染」没有端到端跑过。
- **`truncated` 一直是 `true`**：冻结件 `graph-model.ts` 的判据是 `subgraph.nodes.length >= maxNodes`，150/150 也命中。页面标题的「可能只显示了最近 150 个」来自这里，不是本轮引入的。
- 无头环境是 SwiftShader 软件渲染（`--enable-unsafe-swiftshader`，未用 `--disable-gpu`），帧率与时序不代表真机 GPU；`avgFrameMs` 在自转窗口约 8.3 ms。
- 标签图集用的是系统字体（`pickFontFamily` 读容器 `font-family`），字体差异会让标签宽度与图集打包在别的机器上略有不同；避让是每帧重算的，不会因此重叠。
- `LabelLayer` 在开发态会把每帧的标签框写到 `window.__graphLabelBoxes`，供 `scripts/graph-perf.mjs` 自动检查「框两两相交 = 0」；口径与容器已有的 `window.__graphStats` 一致，生产构建不写。

---

## 15. 2026-11-13 Phase 6D-3：A 线默认 3D 接入 · 自适应降档与抽稀

改动：`src/components/graph-explorer.tsx`、`src/app/graph/page.tsx`、`scripts/phase6d-capture.mjs`、`docs/{02_PHASES,05_CHANGELOG,07_PLAYBOOK,08_RUN_LOG}.md`。未改 B 线文件、未提交、未动真实库。

```bash
# 截图与断言（临时库 + mock LightRAG + AUTH_MODE=mock dev 3123 + CDP 9338）
node scripts/phase6d-capture.mjs
# → Phase 6D 截图与断言全部通过（空态 / 2D / 3D 默认 / 移动回落 / 低档 / 降档 / maxNodes / 抽稀 / 失败态）
#   默认入口 data-mode=3d reason=auto-3d tier=high drawCalls=6 labels=24 layoutMs=2.3/80 ticks
#   移动端 data-mode=2d，模式按钮 2 个（无「星系」）
#   低档 tier=low dpr=1 labels=7 drawCalls=6
#   降档真实触发 high → balanced（avgFrameMs 21.14），撤掉 8× 降速后仍 balanced
#   宽夹具 373 → 渲染 133 / 隐藏 240（提示条「另有 240 个实体未显示」），2D 仍 373
#   ?maxNodes=10 越界请求回落 maxNodes=150；换中心请求带 maxNodes=600

# B 线性能验收（未改动脚本，自包含 3125 / CDP 9340）
node scripts/graph-perf.mjs
# → [ok] 3D 验收通过；150 节点 layoutMs 7.1 / 80 ticks、drawCalls 6、labels 28、
#   标签重叠 0、自转 2s 出 240 帧（约 8.3ms/帧）、低档 labels 8、dpr 1

# 质量门
node node_modules/typescript/bin/tsc --noEmit      # exit 0
node node_modules/vitest/vitest.mjs run --maxWorkers=2
# → 45 个文件通过 / 1 跳过；672 项通过 / 3 项跳过（共 46 文件 675 项）
npm run check:theme                                # 129 名（31 几何 + 98 主题）· 0 失败 · 字面量 26
npm run check:contrast                             # 37/37 组通过
```

注意：`npx tsc` 在本仓库路径（含 `&` 与中文）下会被 cmd 解析截断，统一走 `node node_modules/typescript/bin/tsc`；`vitest` 必须带 `--maxWorkers=2`（默认 worker 池在本机会 OOM，退出码 134）。

发现但未修（B 线）：`src/components/graph/graph-scene-3d.tsx:258` 的 Worker 相对路径 `../workers/graph-layout.worker.ts` 少一层，应为 `../../workers/...`；`>300` 节点走 Worker 会失败并回落主线程（`chunk-failed`）。已记入 `02_PHASES` 6D-3 与 `07_PLAYBOOK` 问题 102，等 B 线处理。

## 16. 2026-11-13 Phase 6D-4：Worker 相对路径修复 · 相机最近距离 · 真 Worker 端到端验收

改动：`src/components/graph/graph-scene-3d.tsx`、`src/components/graph/starfield.tsx`、`scripts/graph-perf.mjs`、本节。未改 A 线文件（`graph-explorer.tsx` / `app/**` / CSS / API / `package.json` / 冻结件 / `02·03·05·07`），未提交未推送。

### 16.1 两个缺陷

1. **Worker 相对路径少一层**。`graph-scene-3d.tsx` 在 `src/components/graph/`，`../workers/...` 会解析成 `src/components/workers`，`next dev` 报 `Module not found`，>300 节点建 Worker 失败并回落主线程（`chunk-failed`）。改为 `../../workers/graph-layout.worker.ts`，并留一行注释说明层级。
2. **相机最近距离与 ADR 不一致**。`starfield.tsx` 的 `controls.minDistance` 由 `120` 改回 ADR-022 A3.1 / A8 的 `260`；`maxDistance = 1100` 未动。120 找不到构图上的必要性（选中态没有推进镜头的逻辑），按 ADR 取值。

两处都是字符串 / 常量，没有能在 node 环境验证的行为分支：Worker URL 要经过 Turbopack 打包才存在，相机距离要 WebGL 运行时才生效，所以本轮不新增单测（既有 46 文件 675 项基线不变）。

### 16.2 真 Worker 端到端验收（此前未覆盖）

`scripts/graph-perf.mjs` 新增 `GRAPH_PERF_NODES`（50–600）：>300 时换成宽夹具——两个互不相连的枢纽，各 1 + 12 + 120 + 240 = 373 个实体、深度 3 全可达，页面带 `?maxNodes=600`（373 < 600 → `truncated=false`，同时 373 > `LAYOUT_WORKER_THRESHOLD=300` 真走 Worker）。脚本在页面里注入开发态探针（`Page.addScriptToEvaluateOnNewDocument`，不改应用代码）记录 `new Worker` 实参、进出消息、layout 请求发出与首帧就绪两个时刻；CDP 侧用 `Target.setDiscoverTargets` 看 `type: "worker"` 目标（等价 Puppeteer 的 `page.workers()`）。

```bash
GRAPH_PERF_NODES=600 node scripts/graph-perf.mjs
# → [ok] 3D 验收通过（Worker 宽夹具）
#   stats: mode=3d tier=high webgl=true nodes=373 edges=372 rendered=373 hidden=0
#          truncated=false layoutMs=56.2（Worker 内）layoutTicks=150 drawCalls=6 labels=21 dpr=1
#   两个时钟：Worker 回包 85ms（post→done）；端到端 795ms（layout post→首帧读数，< 1200ms）
#   Worker 真身：new Worker 的 URL 解码后含 src_workers_graph-layout_worker_ts；
#                CDP 有 1 个 type=worker 目标（无头下 targetInfo.url 为空串，故以页面探针为准）；
#                Worker 实际回 done：resultNodes=373 ticks=150 layoutMs=56.2 truncated=false
#   无 Module not found / chunk-failed / 网络 4xx / g3-stub 降级横幅（problems 为空）
```

**换中心与取消**（最多 5 轮，每轮重载后在布局请求刚发出时切到另一个枢纽）：

- 第 1 轮：3 条 layout、2 条 done，旧请求在新请求之前已回，没撞上重叠窗口；最终布局属于新中心「乙」。
- 第 2 轮（抓到重叠）：旧中心「甲」的 done 在新 layout 请求之后才回到主线程，被 `requestCounterRef` 丢弃；最终采纳 `lastDoneHead = ["乙 主题 01", "乙 主题 01 子题 1"]`，`focus=乙`、`nodes=373`。
- `cancelled` 回执出现 0 次：旧布局在 cancel 到达前**已经开始**（同步循环期间收不到消息），按 A3 v1.3 只有「还没开始」的请求会被 cancel 丢掉并回 `cancelled`。所以本轮证据是「旧结果后到但不覆盖新布局」，不是 `cancelled` 回包本身；协议层的 `cancelled` 仍由单测覆盖。

截图：`docs/screenshots/phase6d-3d-worker-600.png`（1440×900，真实 WebGL，无水印，373 实体 / 372 关系，星系·high）。

### 16.3 150 基线（回归）

```bash
node scripts/graph-perf.mjs
# → [ok] 3D 验收通过（150 基线与截图）
#   桌面 layoutMs 7 / 80 ticks、drawCalls 6、labels 28、空闲 2s 出帧 0、标签重叠 0
#   自动旋转 2s 240 帧、关闭后 0 帧；选中态 labels 28 / drawCalls 8
#   低档 tier=low dpr=1 labels 8 drawCalls 6；problems 为空
```

### 16.4 质量门

```bash
node node_modules/typescript/bin/tsc --noEmit                  # exit 0
node node_modules/vitest/vitest.mjs run --maxWorkers=2
# → 45 个文件通过 / 1 跳过；672 项通过 / 3 项跳过（共 46 文件 675 项）
```

## 17. 2026-11-13 Phase 6D-3 小修：降档窗口跨空闲 · 生产构建验证

改动：`src/components/graph-explorer.tsx`（仅 `handleStats` 的窗口判定）、`scripts/phase6d-capture.mjs`（`downgrade` 步骤的降速倍率 / 观察窗可调 + 采样探针）、`docs/{02_PHASES,05_CHANGELOG,07_PLAYBOOK,08_RUN_LOG}.md`。未改 `03_DECISIONS.md`、未改 B 线文件（`src/components/graph/*`、`src/lib/graph-{layout-3d,render,model,quality,selectors}.ts`、`src/workers/*`、`scripts/graph-perf.mjs`），未提交、未推送、未动真实库。

### 17.1 修法

```ts
if (next.frames < guard.frames) {                 // 换布局，帧计数回绕
  guard.frames = next.frames;
  guard.slowWindows = 0;
  return;
}
if (modeRef.current !== "3d" || !next.rafActive) { // 2D / 后台标签页 = 空闲
  guard.frames = next.frames;
  guard.slowWindows = 0;
  return;
}
if (next.frames === guard.frames) {                // 同一窗口重复发布，没有新帧
  guard.slowWindows = 0;
  return;
}
guard.frames = next.frames;
guard.slowWindows = next.avgFrameMs > SLOW_FRAME_MS ? guard.slowWindows + 1 : 0;
```

窗口大小（连续两个，≈60 帧）、`SLOW_FRAME_MS = 20`、`MAX_TIER_DROPS = 2`、`TIER_DROP_COOLDOWN_MS = 3000`、`TIER_ORDER` 只降不升，均未改。

### 17.2 降档复测（真实触发）

先按原参数（8×）跑，16 秒内没有降档；用新加的 `PHASE6D_DROP_PROBE=1` 采样看到帧率仍在 ~120fps、`avgFrameMs` 8–14ms，根本没到阈值，不是逻辑回归。改成 24× / 40s 观察窗后拿到完整触发：

```bash
PHASE6D_STEPS=downgrade PHASE6D_DROP_PROBE=1 PHASE6D_DROP_RATE=24 PHASE6D_DROP_WAIT=40000 \
  node scripts/phase6d-capture.mjs
# → [probe] +6329ms frames=120 avg=30.52 raf=true tier=high
#   [probe] +15258ms frames=150 avg=61.77 raf=true tier=balanced
#   [check] 降档已触发：high → balanced（avgFrameMs 0 → 61.77），播报「已自动降低画质以保持流畅」，撤销降速后仍为 balanced
```

再把默认值定成 24× / 30s，整套跑一遍：

```bash
node scripts/phase6d-capture.mjs
# → Phase 6D 截图与断言全部通过
#   降档：high → balanced（avgFrameMs 0 → 75.82），撤掉降速 2.5s 后仍 balanced
#   其余读数与 15 节一致（默认入口 drawCalls 6 / labels 24、移动端回落 2d、低档 labels 7、
#   373 → 渲染 133 / 隐藏 240、?maxNodes=10 回落 150）
```

空闲清理由代码核对覆盖：非 3D / `rafActive=false` / 帧数没涨 / 计数回绕四条路径都写回 `frames` 并清零 `slowWindows`；没有做「慢 → 空闲 → 慢」的专项运行时注入。

### 17.3 生产构建

```bash
NEXT_DIST_DIR=.next-build npm run build
# → 第一版（B 线 6D-4 修复前）：Compiled in 1141ms、TS 1582ms、5 warnings
#   （2× graph-scene-3d.tsx 的 Worker 路径 + 3× admin-service.ts 动态 path.resolve）
#   B 线 11:38 改完路径后重建（当前树）：
# → ✓ Compiled successfully in 4.0s
#   Finished TypeScript in 5.7s
#   ✓ Generating static pages (4/4)
#   exit 0；全部路由 ƒ 动态（/graph、/api/*），构建期不连数据库
#   3 warnings：全部是 admin-service.ts 的动态 path.resolve 追踪（既有）
```

构建目录用 `.next-build`（`next.config.ts` 的 `NEXT_DIST_DIR`），避免与 dev 抢 `.next`；验证后已删除。`data/app.db` / `app.db-wal` 的 mtime 在构建前后未变（00:01 / 08:34）。

生产服务冒烟（**库副本，真实库未打开**）：

```bash
cp data/app.db* "$TMP/smoke/"            # %TEMP%，验证后删除
DATABASE_PATH="$TMP/smoke/app.db" AUTH_MODE=mock NEXT_DIST_DIR=.next-build \
  node node_modules/next/dist/bin/next start -p 3131   # 当前构建复测用 3132
# → Ready in 127ms
curl -s -w '%{http_code}\n' http://localhost:3132/api/health        # 200 {"status":"ok",...}
curl -s -w '%{http_code}\n' http://localhost:3132/api/graph/status  # 200 {"total":0,...}（未起 LightRAG）
curl -s -w '%{http_code}\n' http://localhost:3132/graph             # 200，26,207 字节 SSR，data-mode="2d"
# 服务端日志只有 AUTH_MODE=mock 的提示，无报错
```

### 17.4 质量门

```bash
node node_modules/typescript/bin/tsc --noEmit                        # exit 0
node node_modules/vitest/vitest.mjs run --maxWorkers=2
# → 45 个文件通过 / 1 跳过；672 项通过 / 3 项跳过（共 46 文件 675 项）
npm run check:theme                                                  # 129 名（31 几何 + 98 主题）· 0 失败 · 字面量 26
npm run check:contrast                                               # 37/37 组通过
npm run lint                                                         # 0 error / 14 warning（既有）
```

注意：`npm run lint` 会把 `.next-build` 里的产物一起扫（890 error / 11,643 warning 全是构建产物），删掉构建目录后复跑才是真实基线 0 error。2026-11-13 收尾轮已把 `.next-build/**` 加进 `eslint.config.mjs` 的 `globalIgnores`，并在 `.gitignore` 加了 `/.next-build`。

## 18. 2026-11-13 Phase 6D 收尾：生产运行时（`next start`）四项实测

### 18.1 目标与隔离

6D-3 / 6D-4 的 3D 默认入口、真 Worker、抽稀、自适应降档此前只在 `next dev` 下验过；`02_PHASES` 6D-4「未验证③」指的就是这一条。本轮把四项搬到**生产构建 + `next start`** 复验。

```bash
# 1) 真实库只读备份（脚本内用 better-sqlite3 backup，源库不打开写）
#    data/app.db → %TEMP%/pakp-phase6d-XXXX/capture.db，副本上再播 8 个夹具对象
#    （mock LightRAG 的 filePath 必须命中副本里的对象 id，ADR-011 才认这些标签）
# 2) 生产构建：构建期给一个临时 DATABASE_PATH，碰不到真实库
DATABASE_PATH="$TMP/pakp-build-unused.db" AUTH_MODE=mock NEXT_DIST_DIR=.next-build \
  node node_modules/next/dist/bin/next build
# → ✓ Compiled successfully；全部路由 ƒ 动态；产物内有 turbopack-worker-*.js
# 3) 生产服务 + mock LightRAG + 无头 Chrome（CDP）
PHASE6D_PROD=1 APP_PORT=3134 CDP_PORT=9339 node scripts/phase6d-capture.mjs
```

端口避开 3000 / 3123 / 3131 / 3132 / 3133。验证后临时库、`.next-build`、Chrome 用户目录全部删除。

### 18.2 断言口径：只读可见 DOM

生产构建里 `window.__graphStats` / `__graphLabelBoxes` 都被 `NODE_ENV !== "production"` 守卫掉（脚本实测 `typeof window.__graphStats === "undefined"`，同时证明跑的是生产构建）。所以生产验收不读任何页面探针，只断言：

- `.graph-workspace[data-mode]`、`.graph-stage-wrap[data-mode="3d"] canvas`
- 工具条「星系」按钮文案与 `aria-pressed`
- `.graph-stage-head p` 的实体 / 关系 / 「另有 N 个实体未显示」
- `.graph-stage-head .meta-chip` 的档位（星系 · high / balanced / low）
- `.graph-note-error`（`chunk-failed` 会落到这里）、`.g3-stub` 必须为 0
- 无障碍播报 `.sr-only[role=status]`
- Worker 存在性走 CDP `Target.setDiscoverTargets` 的 `worker` 目标（DOM 里看不到 Worker）

另有截图像素统计（`sharp`，next 的可选依赖）：裁画布区域，算平均亮度、亮像素占比、颜色桶，防止「canvas 存在但没画出来」。空白画面会低于阈值直接报错。

### 18.3 四项实测结果

| 项 | 断言 | 实测 |
| --- | --- | --- |
| 桌面默认入口（URL 不带 `mode`） | 进 3D、画布可见、无占位 / 错误横幅、星系按钮按下 | `data-mode=3d`、`星系 · high`、提示条「40 个实体 · 49 条关系」、`.g3-stub` 0、`aria-pressed=true`；画布像素 674×506，平均亮度 9.16，亮像素 3.60%，颜色桶 855 |
| `?maxNodes=600` + 宽夹具 373 实体 | 真 Worker；换中心后仍走 Worker | CDP `worker` 目标 1 个；提示条「373 个实体 · 372 条关系」，high 档不抽稀；换中心「宽图枢纽二」后仍 373、worker 目标仍在、无 `chunk-failed` / `Module not found`；画布亮像素 7.87% |
| 低档抽稀（390 宽 + `?mode=3d`） | 提示条计数与渲染数一致 | `星系 · low`；提示条「373 个实体 · 372 条关系 · 另有 240 个实体未显示」；3D 画布 `aria-label`「133 个实体、132 条关系」→ 133 = 373 − 240，且 ≤ low 档预算 150 |
| 自适应降档（生产构建） | 真实触发、只降不升、有播报 | 自动旋转 + 24× CPU 降速，12.2s 后 `星系 · high → 星系 · balanced`，播报「已自动降低画质以保持流畅」；撤掉降速 3s 后仍为 balanced |

### 18.4 夹具补强与脚本改动

- `scripts/phase6d-capture.mjs` 新增 `PHASE6D_PROD=1`：`next build`（一次）+ `next start`；数据库改为真实库只读备份 + 夹具对象；默认步骤 `prod-default,prod-downgrade,prod-worker,prod-decimate`。
- 新增 `prodState()` / `waitForProdScene3d()` / `checkCanvasPainted()` 三个生产态工具，全部只依赖可见 DOM 与截图。
- 宽夹具新增第二个互不相连的枢纽「宽图枢纽二」（1 + 12 + 120 + 240 = 373）。第一版换中心用的是「宽图主题 01」，深度 3 只有 **153** 个实体（<300），会掉到 Worker 阈值以下，跑出来的失败是夹具覆盖不足，不是应用缺陷；补第二个枢纽后换中心仍是 373。
- `.gitignore` 加 `/.next-build`；`eslint.config.mjs` 的 `globalIgnores` 加 `.next-build/**`（否则 lint 会扫构建产物）。

### 18.5 截图

`docs/screenshots/phase6d-3d-default-entry-prod.png`、`phase6d-3d-downgrade-prod.png`、`phase6d-3d-worker-600-prod.png`、`phase6d-3d-worker-600-prod-switch.png`、`phase6d-3d-decimate-prod.png`。均 1440×900 或 390×844 真实 WebGL，无水印；默认入口 / 抽稀 / Worker 三张已人工复核，节点、标签、连线可见。

### 18.6 质量门

```bash
node node_modules/typescript/bin/tsc --noEmit                        # exit 0
node node_modules/vitest/vitest.mjs run --maxWorkers=2
# → Test Files 45 passed | 1 skipped (46)；Tests 672 passed | 3 skipped (675)；8.81s
npm run lint                                                         # 0 error / 14 warning（既有）
npm run check:theme                                                  # 129 名（31 几何 + 98 主题）· 0 失败 · 字面量 26
npm run check:contrast                                               # 37/37 组通过
```

### 18.7 仍未验证

① 生产运行时跑在 mock LightRAG 夹具 + 无头 SwiftShader 上，真实 LightRAG / 真实 Logto 会话仍未在 `next start` 下复测；② Worker 由 CDP 目标证明存在，页面内消息流量没有在生产构建下埋点（生产构建不允许页面探针）；③ 像素统计只证明「画布画出了东西」，节点 / 边的可读性靠截图人工复核。

## 附录：本轮常用命令

```bash
# 质量门禁
npm run typecheck && npm run lint && npm test && npm run build

# 服务健康
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/api/health
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3001/api/status
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:9380/v1/system/version

# 一键拉起依赖（PowerShell）
powershell -ExecutionPolicy Bypass -File scripts\autostart.ps1 -Check
powershell -ExecutionPolicy Bypass -File scripts\autostart.ps1
```
