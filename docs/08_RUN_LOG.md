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
