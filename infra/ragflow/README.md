# RAGFlow 自托管（本地开发）

Phase 0 集成验证用部署：RAGFlow `v0.20.5` + MySQL + MinIO + Valkey + Elasticsearch，
编排文件为本目录 `docker-compose.yml`（由官方 `docker/docker-compose.yml` 精简，只保留 elasticsearch 文档引擎）。

## 首次启动

```bash
cd infra/ragflow
cp .env.example .env        # 至少改掉 4 个密码
docker compose up -d
docker compose ps           # 等 ragflow-server 变成 healthy
```

宿主机端口（默认值，可在 `.env` 改）：

| 用途 | 地址 |
|---|---|
| Web UI | http://localhost:18080 |
| HTTP API | http://localhost:9380（`/api/v1/...`） |
| MySQL | localhost:5455 |
| Elasticsearch | http://localhost:1200 |
| MinIO API / 控制台 | localhost:19000 / http://localhost:19001 |

默认端口刻意避开 Logto 占用的 3001/3002。

## 首次使用：拿 API key

RAGFlow 没有默认账号，仓库也不保存账号信息。首次启动后按下面步骤拿 key：

```bash
# 1. 注册（密码需要 RSA 加密，公钥由容器内 private.pem 导出）
docker cp ragflow-server:/ragflow/conf/private.pem /tmp/ragflow-private.pem
openssl rsa -in /tmp/ragflow-private.pem -passin pass:Welcome -pubout -out /tmp/ragflow-public.pem
ENC=$(printf '%s' '你的密码' | openssl pkeyutl -encrypt -pubin -inkey /tmp/ragflow-public.pem \
  -pkeyopt rsa_padding_mode:pkcs1 | base64 -w0)

curl -s -X POST http://localhost:9380/v1/user/register \
  -H 'Content-Type: application/json' \
  -d "{\"nickname\":\"local-admin\",\"email\":\"admin@example.com\",\"password\":\"$ENC\"}"

# 2. 用响应头里的 Authorization 换 API key（也可在 Web UI 的用户设置里点生成）
curl -s -X POST http://localhost:9380/v1/system/new_token \
  -H "Authorization: $AUTH" | jq .data.token
```

拿到 `ragflow-...` 后写入应用侧环境变量（不提交）：

```bash
RAGFLOW_BASE_URL=http://localhost:9380
RAGFLOW_API_KEY=ragflow-...
```

注意：`/api/v1/datasets` 只认 `api_token` 表里的 `token`（`ragflow-` 前缀），
不是 `/v1/system/new_token` 返回的 `beta` 字段。

## 当前限制

- 未配置任何外部模型 API key。完整版镜像自带 BAAI embedding 模型，可以建 dataset / 上传文档；
  但文档解析（chunk + 向量化）还需要 chat model 或可用的本地模型，见 `docs/04_INTEGRATION.md`。
- 镜像较大（约 9GB），国内网络可先用华为云镜像拉取再打 tag：

```bash
docker pull swr.cn-north-4.myhuaweicloud.com/infiniflow/ragflow:v0.20.5
docker tag  swr.cn-north-4.myhuaweicloud.com/infiniflow/ragflow:v0.20.5 infiniflow/ragflow:v0.20.5
```

## 常用命令

```bash
docker compose ps
docker compose logs -f ragflow
docker compose down            # 保留数据
docker compose down -v         # 连数据一起删除
```
