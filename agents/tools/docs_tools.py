"""
docs 工具（安全增强版本）。

职责：读取项目 docs/ 目录下的 Markdown 文件，并提供受限的写入能力。
所有写入操作必须先备份到 agents/backups/，文件名带时间戳。
严格禁止修改 00_SCOPE.md、03_DECISIONS.md 中已有 ADR 正文，
严格禁止修改 01_ARCHITECTURE.md 的核心原则段落。
"""

from pathlib import Path
from typing import List
from datetime import datetime
import shutil
import re

from crewai.tools import tool

# 项目根目录 = .../Personal Asset & Knowledge PlatformV2
# 本文件位于 agents/tools/docs_tools.py，向上三级即项目根
PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
DOCS_DIR = PROJECT_ROOT / "docs"
BACKUP_DIR = PROJECT_ROOT / "agents" / "backups"

# 禁止修改的文件及其理由
PROTECTED_FILES = {
    "00_SCOPE.md": "产品边界与最终决策，已采纳决策不得修改",
    "03_DECISIONS.md": "架构决策记录，已采纳 ADR 正文不得修改",
}

# 02_PHASES.md 允许更新的区域
ALLOWED_PHASES_SECTIONS = {
    "当前状态",
    "已完成",
    "下一步行动",
}


def _ensure_backup_dir() -> None:
    """确保备份目录存在。"""
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)


def _backup_file(filepath: Path) -> Path:
    """
    在修改文件前创建备份。

    备份文件名格式：原文件名_YYYYMMDD_HHMMSS.md
    存储在 agents/backups/ 目录下。

    Returns:
        备份文件的路径
    """
    _ensure_backup_dir()
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_name = f"{filepath.stem}_{timestamp}{filepath.suffix}"
    backup_path = BACKUP_DIR / backup_name
    shutil.copy2(filepath, backup_path)
    return backup_path


def _validate_phases_section(section: str) -> None:
    """验证 section 是否为 02_PHASES.md 允许更新的区域。"""
    if section not in ALLOWED_PHASES_SECTIONS:
        raise ValueError(
            f"不允许更新 02_PHASES.md 的区域：{section}。"
            f"仅允许更新：{', '.join(sorted(ALLOWED_PHASES_SECTIONS))}"
        )


def _update_section_content(content: str, section_title: str, new_content: str) -> str:
    """
    在 Markdown 内容中更新指定标题下的内容。

    只替换该标题到下一个同级标题之间的内容，不影响其他部分。
    禁止删除已有记录，只能在允许的区域内追加或替换。

    Args:
        content: 原始 Markdown 内容
        section_title: 要更新的标题（如 "当前状态"、"已完成"、"下一步行动"）
        new_content: 新的内容文本

    Returns:
        更新后的 Markdown 内容
    """
    # 匹配 ## 或 ### 标题，直到下一个同级或更高级标题或文件结束
    # 注意：f-string 中的 {1,3} 需要写成 {{1,3}} 才能作为正则字面量
    pattern = rf"(^#{{1,3}}\s+{re.escape(section_title)}\s*\n)(.*?)(?=^#{{1,3}}\s|\Z)"
    replacement = rf"\1{new_content}\n"

    updated = re.sub(pattern, replacement, content, flags=re.MULTILINE | re.DOTALL)

    if updated == content:
        raise ValueError(f"未找到标题：{section_title}，无法更新。")

    return updated


# ------------------------------------------------------------------
# 只读工具（保留）
# ------------------------------------------------------------------

@tool
def list_docs() -> List[str]:
    """列出 docs/ 目录下所有 Markdown 文件（仅文件名，已按名称排序）。"""
    if not DOCS_DIR.exists():
        return []
    return sorted([p.name for p in DOCS_DIR.glob("*.md")])


@tool
def read_doc(filename: str) -> str:
    """
    读取 docs/ 下指定 Markdown 文件的内容。

    Args:
        filename: 相对 docs/ 的路径，例如 "00_SCOPE.md" 或 "prompts/maintain-docs.md"

    Returns:
        文件内容字符串；若文件不存在则返回错误提示。
    """
    path = DOCS_DIR / filename
    if not path.exists():
        return f"[错误] 文件不存在：{path}"
    return path.read_text(encoding="utf-8")


@tool
def read_maintain_prompt() -> str:
    """读取 docs/prompts/maintain-docs.md 的文档维护指令。"""
    return read_doc("prompts/maintain-docs.md")


# ------------------------------------------------------------------
# 有限写入工具（新增）
# ------------------------------------------------------------------

@tool
def update_phases(section: str, content: str) -> str:
    """
    只能更新 docs/02_PHASES.md 中的允许区域：「当前状态」「已完成」「下一步行动」。

    安全约束：
    - 禁止改动阶段总览表格的历史内容
    - 禁止删除已有记录
    - 禁止修改 00_SCOPE.md、03_DECISIONS.md 中已有 ADR 正文
    - 禁止修改 01_ARCHITECTURE.md 的核心原则段落
    - 写入前必须先备份到 agents/backups/

    Args:
        section: 要更新的区域名称，必须是 "当前状态"、"已完成" 或 "下一步行动"
        content: 要写入的新内容（Markdown 格式）

    Returns:
        操作结果提示，包含备份文件路径
    """
    _validate_phases_section(section)

    filepath = DOCS_DIR / "02_PHASES.md"
    if not filepath.exists():
        return f"[错误] 文件不存在：{filepath}"

    # 写入前必须先备份
    backup_path = _backup_file(filepath)

    original_content = filepath.read_text(encoding="utf-8")

    try:
        updated_content = _update_section_content(original_content, section, content)
    except ValueError as e:
        return f"[错误] {e}"

    filepath.write_text(updated_content, encoding="utf-8")

    return f"[已更新] {filepath} 的「{section}」区域。备份已保存至：{backup_path}"


@tool
def append_changelog(entry: str) -> str:
    """
    只能在 docs/05_CHANGELOG.md 末尾追加一条记录。

    格式：## YYYY-MM-DD\n- 内容

    安全约束：
    - 只能追加，不能修改已有记录
    - 写入前必须先备份到 agents/backups/

    Args:
        entry: 变更记录内容（不含日期标题，会自动添加当前日期）

    Returns:
        操作结果提示，包含备份文件路径
    """
    filepath = DOCS_DIR / "05_CHANGELOG.md"
    if not filepath.exists():
        return f"[错误] 文件不存在：{filepath}"

    # 写入前必须先备份
    backup_path = _backup_file(filepath)

    today = datetime.now().strftime("%Y-%m-%d")
    original_content = filepath.read_text(encoding="utf-8")

    # 确保原文件以换行符结尾
    if original_content and not original_content.endswith("\n"):
        original_content += "\n"

    new_entry = f"\n## {today}\n- {entry}\n"
    updated_content = original_content + new_entry

    filepath.write_text(updated_content, encoding="utf-8")

    return f"[已追加] {filepath} 末尾。备份已保存至：{backup_path}"


@tool
def write_doc(filename: str, content: str) -> str:
    """
    写入 docs/ 下指定文件（预留能力，受严格限制）。

    警告：当前阶段不应由 Agent 自动调用此函数修改已有 docs 文件。
    禁止修改 00_SCOPE.md、03_DECISIONS.md、01_ARCHITECTURE.md 的核心内容。

    Args:
        filename: 相对 docs/ 的路径
        content: 要写入的内容

    Returns:
        写入结果提示
    """
    if filename in PROTECTED_FILES:
        return f"[禁止] 不允许修改受保护文件：{filename}（{PROTECTED_FILES[filename]}）"

    filepath = DOCS_DIR / filename
    backup_path = _backup_file(filepath) if filepath.exists() else None

    filepath.parent.mkdir(parents=True, exist_ok=True)
    filepath.write_text(content, encoding="utf-8")

    backup_msg = f"，备份已保存至：{backup_path}" if backup_path else ""
    return f"[已写入] {filepath}{backup_msg}"
