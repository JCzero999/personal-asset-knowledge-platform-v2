import type { ContentRef } from "@/domain/content-ref";
import { type BusinessObject } from "@/domain/objects";

import { formatDateTime } from "./content-format";
import { categoryLabel, type CategoryLabelMap } from "./category-labels";
import { libraryLabels, objectTypeLabels, statusLabels } from "./object-labels";

/**
 * 批量导出：把选中的资产 / 作品拼成一份 Markdown。
 *
 * 不打包二进制：纯文本主内容（含 Markdown）直接带出正文，PDF、图片等只列
 * 文件名。这样导出物可以读、可以再导入，也不用引入压缩库。
 */

export interface ExportItem {
  object: BusinessObject;
  /** 主内容原文；只有纯文本类内容会被带出，其余为 null。 */
  content: string | null;
  attachments: ContentRef[];
}

function meta(label: string, value: string): string {
  return `- ${label}：${value}`;
}

function typeLabel(object: BusinessObject, categoryLabels: CategoryLabelMap): string {
  if (object.type === "asset") return objectTypeLabels.asset;
  return `作品 · ${categoryLabel(categoryLabels, object.category)}`;
}

export function buildExportMarkdown(
  items: ExportItem[],
  exportedAt: Date,
  categoryLabels: CategoryLabelMap,
): string {
  const lines: string[] = [
    "# 资产与作品导出",
    "",
    `导出时间：${formatDateTime(exportedAt.toISOString())} · 共 ${items.length} 项`,
  ];

  items.forEach((item, index) => {
    const { object } = item;

    lines.push("", "---", "", `## ${index + 1}. ${object.title}`, "");
    lines.push(meta("类型", typeLabel(object, categoryLabels)));
    lines.push(meta("归属", libraryLabels[object.library]));
    if (object.type === "work") {
      lines.push(meta("阶段", statusLabels[object.status]));
    }
    if (object.category) {
      lines.push(meta("分类", categoryLabel(categoryLabels, object.category)));
    }
    if (object.tags.length > 0) {
      lines.push(meta("标签", object.tags.map((tag) => `#${tag}`).join(" ")));
    }
    lines.push(meta("创建", formatDateTime(object.createdAt)));
    lines.push(meta("更新", formatDateTime(object.updatedAt)));

    if (object.description?.trim()) {
      lines.push("", `> ${object.description.trim().replace(/\n/g, "\n> ")}`);
    }

    lines.push("", "### 正文", "");
    lines.push(item.content?.trim() ? item.content.trim() : "（无纯文本正文）");

    if (item.attachments.length > 0) {
      lines.push("", "### 附件", "");
      item.attachments.forEach((ref) => {
        lines.push(`- ${ref.documentName ?? "未命名附件"}`);
      });
    }
  });

  return `${lines.join("\n").trimEnd()}\n`;
}

export function exportFileName(exportedAt: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `资产与作品-${exportedAt.getFullYear()}${pad(exportedAt.getMonth() + 1)}${pad(exportedAt.getDate())}.md`;
}
