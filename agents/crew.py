"""
Crew 主定义 - 「个人知识工作台」项目进度管理多 Agent 协作体系。

设计要点（严格遵守项目文档体系）：
- 采用 CrewAI 最新装饰器写法：@CrewBase + @agent + @task + @crew
- 过程模型：Process.hierarchical（分层流程），由 Project Manager 担任 Manager，负责任务指派与协调
- 模型配置全部从环境变量读取：OPENAI_API_KEY / OPENAI_API_BASE / OPENAI_MODEL_NAME，
  temperature 固定为 0.2，方便接入 DeepSeek 或其他 OpenAI 兼容接口
- 三个 Agent 均以 ADR-005（RAGFlow 统一内容存储）及 docs/ 体系为方向锚点
- 当前阶段仅跑通「理解文档 + 任务拆解」，不执行 Docker 命令、不写业务代码、
  不修改已有 docs 文件
"""

import os
from pathlib import Path

from crewai import Agent, Crew, LLM, Process, Task
from crewai.project import CrewBase, agent, crew, task

# 项目根目录（agents/ 所在目录的上一级）
BASE_DIR = Path(__file__).resolve().parent
DOCS_DIR = BASE_DIR.parent / "docs"


def build_llm() -> LLM:
    """
    从环境变量构建 LLM。

    环境变量：
      OPENAI_MODEL_NAME   - 模型名称（如 deepseek-chat、gpt-4o-mini），默认 gpt-4o-mini
      OPENAI_API_BASE     - 兼容接口基地址（如 https://api.deepseek.com），留空则使用官方 OpenAI
      OPENAI_API_KEY      - API 密钥
    temperature 固定为 0.2，保证输出稳定、可复现。
    """
    return LLM(
        model=os.getenv("OPENAI_MODEL_NAME", "gpt-4o-mini"),
        base_url=os.getenv("OPENAI_API_BASE") or None,
        api_key=os.getenv("OPENAI_API_KEY"),
        temperature=0.2,
    )


@CrewBase
class ProjectCrew:
    """个人知识工作台 - 项目进度管理 Crew。"""

    # 角色配置文件路径
    agents_config = str(BASE_DIR / "config" / "agents.yaml")

    def __init__(self) -> None:
        self._llm = build_llm()

    # ------------------------------------------------------------------
    # Agent 定义
    # ------------------------------------------------------------------

    @agent
    def project_manager(self) -> Agent:
        """
        项目经理（总管）：
        - 允许委派任务（allow_delegation=True）
        - 担任 hierarchical process 的 Manager，负责把任务指派给其他 Agent
        - 严格遵守 ADR-005 与已采纳决策，不偏离项目方向
        - 注意：CrewAI 限制 manager_agent 不得拥有 tools，因此此处不注入任何工具
        """
        return Agent(
            config=self.agents_config["project_manager"],
            llm=self._llm,
            allow_delegation=True,
            verbose=True,
        )

    @agent
    def docs_keeper(self) -> Agent:
        """
        文档管理员：
        - 严格按 docs/prompts/maintain-docs.md 更新文档
        - 不编造未实现接口，不修改已采纳决策
        - 拥有 docs 读取与有限写入工具（update_phases / append_changelog / write_doc）
        """
        # 延迟导入，避免模块加载时因工具依赖问题导致失败
        from tools.docs_tools import (
            list_docs,
            read_doc,
            read_maintain_prompt,
            update_phases,
            append_changelog,
            write_doc,
        )

        return Agent(
            config=self.agents_config["docs_keeper"],
            llm=self._llm,
            allow_delegation=False,
            verbose=True,
            tools=[
                list_docs,
                read_doc,
                read_maintain_prompt,
                update_phases,
                append_changelog,
                write_doc,
            ],
        )

    @agent
    def infra_agent(self) -> Agent:
        """
        基础设施工程师：
        - 负责 Logto / RAGFlow Docker 准备工作与验证思路
        - 仅输出计划，暂不执行危险命令
        - 拥有 infra 只读检查工具，禁止执行 docker run / compose up / pull / stop
        """
        # 延迟导入，避免模块加载时因工具依赖问题导致失败
        from tools.infra_tools import (
            check_docker_available,
            check_port_in_use,
            list_running_containers,
        )

        return Agent(
            config=self.agents_config["infra_agent"],
            llm=self._llm,
            allow_delegation=False,
            verbose=True,
            tools=[
                check_docker_available,
                check_port_in_use,
                list_running_containers,
            ],
        )


    # ------------------------------------------------------------------
    # Task 定义
    # ------------------------------------------------------------------

    @task
    def analyze_current_status(self) -> Task:
        """
        Task 1：分析当前项目状态。

        由 Docs Keeper 执行：读取 00_SCOPE.md、02_PHASES.md、03_DECISIONS.md 及
        maintain-docs.md，总结当前阶段、已完成/未完成/阻塞项，并确认是否与 ADR-005 一致。
        """
        return Task(
            name="分析当前项目状态",
            description=(
                "请阅读以下文档并用中文输出项目状态总结报告：\n"
                "1. docs/00_SCOPE.md —— 产品边界与最终决策\n"
                "2. docs/02_PHASES.md —— 分阶段计划与当前进度\n"
                "3. docs/03_DECISIONS.md —— 架构决策记录（ADR），重点关注 ADR-005\n"
                "4. docs/prompts/maintain-docs.md —— 文档维护指令\n\n"
                "报告必须包含：\n"
                "- 当前所处阶段（Phase 0）及本周目标\n"
                "- 已完成的工作（对照 02_PHASES.md 勾选项）\n"
                "- 尚未完成的关键项\n"
                "- 阻塞项与风险（如有）\n"
                "- 是否与 ADR-005（RAGFlow 统一内容存储）及已采纳 ADR 保持一致\n"
                "不要编造未实现的接口，不要超出文档已载明的范围做推断。"
            ),
            expected_output=(
                "一份中文的项目状态总结报告，清晰列出：当前阶段、本周目标、已完成项、"
                "未完成项、阻塞项与风险、是否符合 ADR-005 及文档体系。"
            ),
            agent=self.docs_keeper(),
        )

    @task
    def plan_next_steps(self) -> Task:
        """
        Task 2：根据当前状态制定下一步可执行任务清单。

        由 Project Manager 执行：基于 Task 1 的输出，制定下一步任务清单，
        每项明确负责人、做什么、完成标准、ADR 对齐说明。
        """
        return Task(
            name="制定下一步可执行任务清单",
            description=(
                "基于「分析当前项目状态」Task 的输出，制定下一步可执行任务清单。\n"
                "清单中的每一项必须明确以下四项：\n"
                "1. 负责人：必须是 Project Manager / Docs Keeper / Infra Agent 中的一位\n"
                "2. 做什么：具体、可执行，不编造接口、不执行 Docker 命令\n"
                "3. 完成标准：如何判断该项已完成（可观察、可验证）\n"
                "4. ADR/文档对齐说明：该项如何遵守 ADR-005 及文档体系\n\n"
                "当前处于 Phase 0，建议聚焦以下方向（不限于此，可增删）：\n"
                "- 核对 docs/ 下 00~05 文件及 prompts/maintain-docs.md 是否齐全并与当前决策一致\n"
                "- 输出 Logto Docker 启动与验证思路（仅计划，不执行 docker run）\n"
                "- 输出 RAGFlow Docker 启动与验证思路（仅计划，不执行 docker run）\n"
                "- 将实际端口、访问地址、基础环境变量建议写入 04_INTEGRATION.md 的草案内容\n"
                "- 更新 02_PHASES.md「已完成」与「下一步行动」，准备进入 Phase 1\n"
                "- 在 05_CHANGELOG.md 追加本次协作记录\n\n"
                "约束：\n"
                "- Infra Agent 仅输出 Docker 准备计划与验证思路，不执行 docker run / docker compose up 等危险命令\n"
                "- Docs Keeper 仅输出建议的文档更新内容，当前不直接修改已有 docs 文件\n"
                "- 不得修改 00_SCOPE.md、03_DECISIONS.md 中已采纳的决策；如需变更必须新增 ADR"
            ),
            expected_output=(
                "一份中文的可执行任务清单（建议用表格或列表），每项含：负责人、做什么、"
                "完成标准、ADR/文档对齐说明。"
            ),
            agent=self.project_manager(),
            context=[self.analyze_current_status()],
        )


    # ------------------------------------------------------------------
    # Crew 组装
    # ------------------------------------------------------------------

    @crew
    def crew(self) -> Crew:
        """
        组装 Crew，采用分层流程（hierarchical process）。

        manager_agent = Project Manager（总管），负责将任务指派给 Docs Keeper、
        Infra Agent 等执行 Agent，并对结果进行协调与验证。

        注意：manager_agent 不得同时出现在普通 agents 列表中（CrewAI 限制），
        因此从 self.agents 中排除 Project Manager。
        """
        manager = self.project_manager()
        # 排除 manager，避免“Manager agent should not be included in agents list”
        worker_agents = [a for a in self.agents if a.role != manager.role]
        return Crew(
            agents=worker_agents,
            tasks=self.tasks,
            process=Process.hierarchical,
            manager_agent=manager,
            manager_llm=self._llm,
            verbose=True,
        )

