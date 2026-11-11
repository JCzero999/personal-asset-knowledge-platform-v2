"""
入口脚本：启动「个人知识工作台」项目进度管理 Crew。

用法：
    cd agents
    python main.py

运行前请先配置环境变量（见 README.md）：
  OPENAI_API_KEY, OPENAI_API_BASE, OPENAI_MODEL_NAME
"""

import os
import sys

from dotenv import load_dotenv

# 确保能直接运行本文件（无论从哪个工作目录启动）
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from crew import ProjectCrew


def main() -> None:
    # 加载 .env 文件（若存在）
    load_dotenv()

    if not os.getenv("OPENAI_API_KEY"):
        print("[警告] 未检测到 OPENAI_API_KEY，Agent 可能无法正常调用模型。")
        print("       请参阅 agents/README.md 配置环境变量后再运行。\n")

    # 构建 Crew 并启动（分层流程，Project Manager 担任 Manager 指派任务）
    crew = ProjectCrew().crew()
    result = crew.kickoff()

    print("\n" + "=" * 60)
    print("CREW 执行完毕，最终结果如下：")
    print("=" * 60 + "\n")
    print(result)


if __name__ == "__main__":
    main()
