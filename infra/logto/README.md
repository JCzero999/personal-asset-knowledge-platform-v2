# Logto 自托管（本地开发）

官方单实例部署：`svhd/logto` + `postgres:14-alpine`，数据在 named volume `logto_logto-postgres-data`。

## 首次启动

```bash
cd infra/logto
cp .env.example .env        # 修改 POSTGRES_PASSWORD，并同步改 DB_URL 里的密码
docker compose up -d
```

`DB_URL` 的密码中不要使用 `@ : / ? #` 等需要在 URL 中转义的字符。

容器首次启动会执行 `npm run cli db seed -- --swe` 建表并写入初始数据（可重复执行），随后启动服务。

## 地址

| 用途 | 地址 |
|---|---|
| OIDC / API 端点 | http://localhost:3001 |
| 状态检查 | http://localhost:3001/api/status（204） |
| 管理控制台 | http://localhost:3002/console |

首次打开控制台会跳到 `/console/welcome`，需要**手动创建管理员账号**（Logto 不提供默认账号）。

## 常用命令

```bash
docker compose ps
docker compose logs -f logto
docker compose down            # 保留数据
docker compose down -v         # 连数据一起删除
```
