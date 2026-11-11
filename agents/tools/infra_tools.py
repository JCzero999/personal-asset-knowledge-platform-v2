"""
基础设施检查工具（只读）。

明确禁止：
- 任何 docker run / docker compose up / docker pull / docker stop 等执行函数
- 任何会修改系统状态的命令
"""

import socket
import shutil
import subprocess
from typing import Dict, List

from crewai.tools import tool


@tool
def check_docker_available() -> Dict[str, object]:
    """
    检查 docker / docker compose 是否在 PATH，以及版本信息。

    只读操作：仅执行 --version，不启动任何容器，不修改系统状态。

    Returns:
        字典，包含：
        - docker_cli: bool, docker 命令是否可用
        - docker_version: str, docker 版本信息（若可用）
        - docker_compose: bool, docker compose 命令是否可用
        - docker_compose_version: str, docker compose 版本信息（若可用）
    """
    result: Dict[str, object] = {
        "docker_cli": False,
        "docker_version": None,
        "docker_compose": False,
        "docker_compose_version": None,
    }

    # 检查 docker
    docker_path = shutil.which("docker")
    if docker_path:
        result["docker_cli"] = True
        try:
            version_output = subprocess.run(
                ["docker", "--version"],
                capture_output=True, text=True, timeout=10,
            )
            if version_output.returncode == 0:
                result["docker_version"] = version_output.stdout.strip()
            else:
                result["docker_version"] = f"命令执行失败（退出码 {version_output.returncode}）"
        except Exception as exc:
            result["docker_version"] = f"无法获取版本：{exc}"

    # 检查 docker compose（作为 docker 的子命令）
    if docker_path:
        try:
            compose_output = subprocess.run(
                ["docker", "compose", "version"],
                capture_output=True, text=True, timeout=10,
            )
            if compose_output.returncode == 0:
                result["docker_compose"] = True
                result["docker_compose_version"] = compose_output.stdout.strip()
            else:
                result["docker_compose_version"] = (
                    f"命令执行失败（退出码 {compose_output.returncode}）"
                )
        except Exception as exc:
            result["docker_compose_version"] = f"无法获取版本：{exc}"

    return result


@tool
def check_port_in_use(port: int) -> Dict[str, object]:
    """
    检查指定端口是否被占用。

    只读操作：尝试绑定端口，立即释放，不修改系统状态。

    Args:
        port: 要检查的端口号

    Returns:
        字典，包含：
        - port: int
        - in_use: bool
        - message: str
    """
    in_use = False
    message = ""

    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(1)
            result = s.connect_ex(("127.0.0.1", port))
            if result == 0:
                in_use = True
                message = f"端口 {port} 已被占用"
            else:
                message = f"端口 {port} 未被占用"
    except Exception as exc:
        message = f"检查端口 {port} 时出错：{exc}"

    return {
        "port": port,
        "in_use": in_use,
        "message": message,
    }


@tool
def list_running_containers() -> Dict[str, object]:
    """
    仅列出当前运行的容器名和端口映射（只读）。

    尝试执行 docker ps（只读命令，不修改系统状态）获取容器列表。
    如果 Docker 不可用或命令失败，返回提示信息。

    Returns:
        字典，包含：
        - success: bool
        - containers: list[dict], 每项含 name 和 ports
        - message: str
    """
    docker_path = shutil.which("docker")
    if not docker_path:
        return {
            "success": False,
            "containers": [],
            "message": (
                "Docker 未安装或不在 PATH 中，无法列出运行容器。"
                "请手动执行 'docker ps' 查看。"
            ),
        }

    try:
        result = subprocess.run(
            ["docker", "ps", "--format", "{{.Names}}|{{.Ports}}"],
            capture_output=True, text=True, timeout=10,
        )
        if result.returncode != 0:
            return {
                "success": False,
                "containers": [],
                "message": f"执行 docker ps 失败：{result.stderr.strip()}",
            }

        containers: List[Dict[str, str]] = []
        for line in result.stdout.strip().splitlines():
            if not line:
                continue
            parts = line.split("|", 1)
            name = parts[0] if len(parts) > 0 else ""
            ports = parts[1] if len(parts) > 1 else ""
            containers.append({"name": name, "ports": ports})

        return {
            "success": True,
            "containers": containers,
            "message": f"共发现 {len(containers)} 个运行中的容器",
        }
    except Exception as exc:
        return {
            "success": False,
            "containers": [],
            "message": f"列出容器时出错：{exc}",
        }
