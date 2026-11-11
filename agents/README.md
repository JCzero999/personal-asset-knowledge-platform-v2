# agents/ - 项目进度管理多 Agent 协作体系

本目录实现基于 **CrewAI** 的多 Agent 协作体系，用于管理「个人知识工作台」项目的开发进度。
所有设计严格基于现有 `docs/` 文档体系，核心决策以 `ADR-005`（RAGFlow 统一内容存储）为锚点。

## 目录结构

```
agents/
├── crew.py              # Crew 主定义（@CrewBase + @agent + @task + @crew）
├── main.py              # 入口脚本
├── tools/
│   ├── __init__.py
│   ├── docs_tools.py    # docs 读写工具（只读 + 有限写入，所有写操作先备份）
│   └── infra_tools.py   # 基础设施只读检查工具（docker/端口/容器查询，禁止执行部署命令）
├── config/
│   ├── __init__.py
│   └── agents.yaml      # 三个 Agent 的角色配置（goal/backstory/allow_delegation）
├── backups/             # docs 写入前的自动备份目录（文件名带时间戳）
└── README.md            # 本文件
```

## 工具能力与限制

### 工具清单

| 工具文件 | 工具函数 | 能做什么 | 不能做什么 |
|----------|----------|----------|------------|
| `tools/docs_tools.py` | `list_docs()` | 列出 docs/ 下所有 Markdown 文件 | ❌ |
| | `read_doc(filename)` | 读取 docs/ 下任意 Markdown 文件内容 | ❌ |
| | `read_maintain_prompt()` | 读取文档维护指令 `maintain-docs.md` | ❌ |
| | `update_phases(section, content)` | 仅更新 `02_PHASES.md` 中「当前状态」「已完成」「下一步行动」区域 | ❌ 禁止改动阶段总览表格历史；❌ 禁止删除已有记录；❌ 禁止修改 `00_SCOPE.md`、`03_DECISIONS.md`、`01_ARCHITECTURE.md` 核心内容 |
| | `append_changelog(entry)` | 仅在 `05_CHANGELOG.md` 末尾追加记录（格式：`## YYYY-MM-DD\n- 内容`） | ❌ 禁止修改已有记录 |
| | `write_doc(filename, content)` | 写入 docs/ 下非受保护文件 | ❌ 禁止修改 `00_SCOPE.md`、`03_DECISIONS.md` |
| `tools/infra_tools.py` | `check_docker_available()` | 检查 docker / docker compose 是否在 PATH 及版本 | ❌ 禁止执行 `docker run` / `compose up` / `pull` / `stop` |
| | `check_port_in_use(port)` | 检查指定端口是否被占用 | ❌ 任何修改系统状态的命令 |
| | `list_running_containers()` | 仅列出当前运行容器名和端口映射 | ❌ 禁止启动/停止/删除容器 |

### 备份机制

- 所有写入操作（`update_phases`、`append_changelog`、`write_doc`）在修改文件前，**必须先备份**到 `agents/backups/` 目录。
- 备份文件名格式：`原文件名_YYYYMMDD_HHMMSS.md`（例如 `02_PHASES_20261027_143022.md`）。
- 备份使用 `shutil.copy2`，保留元数据。
- 如果写入失败，原始文件内容未受影响，可从备份恢复。

### Agent 工具权限分配

| Agent | 已注入工具 | 权限说明 |
|-------|-----------|----------|
| **Project Manager** | `list_docs`, `read_doc`, `read_maintain_prompt` | 仅只读 docs，不直接写文件，不调用 infra 工具 |
| **Docs Keeper** | `list_docs`, `read_doc`, `read_maintain_prompt`, `update_phases`, `append_changelog`, `write_doc` | 读 + 有限写 docs，仅限允许区域，所有写操作先备份 |
| **Infra Agent** | `check_docker_available`, `check_port_in_use`, `list_running_containers` | 仅只读检查，禁止执行任何 docker 部署命令 |

## 三个 Agent


| 角色 | 职责 | allow_delegation |
|------|------|------------------|
| **Project Manager** | 总管。读取 `00_SCOPE.md` / `02_PHASES.md` / `03_DECISIONS.md`，判断状态，拆解任务并指派。担任 hierarchical process 的 Manager。 | `True` |
| **Docs Keeper** | 文档管理员。严格按 `docs/prompts/maintain-docs.md` 更新 `02_PHASES.md` 和 `05_CHANGELOG.md`，不编造接口。 | `False` |
| **Infra Agent** | 基础设施。负责 Logto / RAGFlow Docker 准备工作与验证思路，仅输出计划，不执行危险命令。 | `False` |

## 两个初始 Task

1. **分析当前项目状态**（Docs Keeper 执行）：读取核心文档，总结当前阶段、已完成/未完成/阻塞项，确认与 ADR-005 一致性。
2. **制定下一步可执行任务清单**（Project Manager 执行）：基于任务 1 输出，给出每项的负责人、做什么、完成标准、ADR 对齐说明。

## 环境准备

### 推荐 Python 版本
- **首选**：Python 3.12
- **备选**：Python 3.11
- **不推荐**：Python 3.14（本机当前默认版本，`crewai` 依赖的 `numpy` 等包在 3.14 上缺少预编译 wheel，且本机无 C 编译器，`pip install` 会失败）

### 如何创建并激活虚拟环境

在项目根目录（`Personal Asset & Knowledge PlatformV2`）执行：

**前提**：已安装 Python 3.12（或 3.11），且 `python` 命令指向该版本。

```powershell
# 创建虚拟环境（目录名：.venv）
python -m venv .venv

# 激活虚拟环境（PowerShell）
.venv\Scripts\Activate.ps1

# 激活虚拟环境（CMD）
.venv\Scripts\activate.bat
```

> 如果 PowerShell 提示“禁止运行脚本”，请先以管理员身份执行：`Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser`

### 如何安装依赖

激活虚拟环境后，在项目根目录执行：

```powershell
# 先升级 pip
python -m pip install --upgrade pip

# 再安装依赖
pip install -r requirements.txt
```

`requirements.txt` 内容：

```
crewai
python-dotenv
```

### 如何配置环境变量

在项目根目录创建 `.env` 文件（可参考 `.env.example`）：

```
# 必填：模型 API 密钥
OPENAI_API_KEY=sk-xxxxxx

# 可选：兼容接口基地址（如使用 DeepSeek，请填 https://api.deepseek.com；
# 留空则使用官方 OpenAI 接口）
OPENAI_API_BASE=https://api.deepseek.com

# 可选：模型名称（如 deepseek-chat、deepseek-reasoner、gpt-4o-mini）
OPENAI_MODEL_NAME=deepseek-chat
```

> 本体系默认 `temperature=0.2`，已在 `agents/crew.py` 中固定，无需通过环境变量调整。

### 如何运行

激活虚拟环境后，在项目根目录执行：

```powershell
python agents/main.py
```

程序会：
1. 加载 `.env` 中的环境变量；
2. 启动 CrewAI Crew（分层流程，Project Manager 担任 Manager 指派任务）；
3. 依次执行「分析当前项目状态」→「制定下一步可执行任务清单」；
4. 打印最终结果。

### 常见问题

| 问题 | 原因 | 解决方案 |
|------|------|----------|
| `pip install crewai` 报错 `metadata-generation-failed` / `numpy` 编译失败 | 默认 Python 是 3.14，缺少预编译 wheel 且无 C 编译器 | 改用 Python 3.12 或 3.11 创建虚拟环境 |
| `pip` 提示 `SSLEOFError` / 无法连接 `files.pythonhosted.org` | 网络或代理导致 SSL 连接中断 | 检查代理/防火墙，或使用国内镜像：`pip install -i https://pypi.tuna.tsinghua.edu.cn/simple -r requirements.txt` |
| PowerShell 报错“禁止运行脚本” | 执行策略限制 | `Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser` |
| `python` 仍指向 3.14 | PATH 中 miniconda3 的 Python 排在前面 | 使用完整路径调用 3.12 的 python，或先调整 PATH 顺序 |

## 当前支持哪些能力

- ✅ 读取 `docs/` 下所有 Markdown 文件（`00_SCOPE.md`、`01_ARCHITECTURE.md`、`02_PHASES.md`、`03_DECISIONS.md`、`04_INTEGRATION.md`、`05_CHANGELOG.md`、`prompts/maintain-docs.md`）
- ✅ 基于现有文档分析当前项目阶段与状态
- ✅ 基于分析结果制定可执行任务清单（明确负责人、做什么、完成标准、ADR 对齐）
- ✅ 三 Agent 分层协作（hierarchical process，Project Manager 作为 Manager 指派任务）
- ✅ 模型配置从环境变量读取，兼容 DeepSeek 等 OpenAI 接口
- ✅ 不修改任何已有 docs 文件（Phase 0 仅做理解与拆解）

## 暂不支持（后续扩展）

- ❌ 直接执行 `docker run` / `docker compose up` 等危险命令（Infra Agent 仅输出计划与思路）
- ❌ 自动写入/修改已有 docs 文件（Docs Keeper 当前仅输出建议内容，不自动修改）
- ❌ 编写业务代码或真正对接 Logto / RAGFlow 接口

## 约定

- 不修改 `docs/` 下已有文件内容，除非用户明确要求。
- 所有 Agent 的 `goal` / `backstory` 均体现对 `ADR-005` 及文档体系的尊重。
- 方向变更必须新增 ADR，并同步 `00_SCOPE.md` 与 `01_ARCHITECTURE.md`。
