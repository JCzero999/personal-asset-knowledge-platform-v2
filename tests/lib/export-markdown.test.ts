import { describe, expect, it } from "vitest";

import type { ContentRef } from "@/domain/content-ref";
import type { BusinessObject } from "@/domain/objects";
import { buildExportMarkdown, exportFileName } from "@/lib/export-markdown";

const work: BusinessObject = {
  id: "w1",
  type: "work",
  title: "个人知识系统",
  description: "从收集到输出",
  library: "internal",
  source: "handwritten",
  origin: "self",
  category: "article",
  tags: ["复盘", "写作"],
  priority: "medium",
  archivedAt: null,
  libraryChangedAt: null,
  ownerSub: "u1",
  revision: 1,
  createdAt: "2026-11-01T02:00:00.000Z",
  updatedAt: "2026-11-10T02:00:00.000Z",
  deletedAt: null,
  status: "draft",
  sourceNote: null,
  publishedAt: null,
  practicedAt: null,
  practiceMetrics: null,
  settledAssetId: null,
  sourceType: null,
  aiStatus: null,
  aiScore: null,
  aiScoreDetail: null,
  valueLevel: null,
  valueScores: null,
  valueAssessedAt: null,
  useCount: 0,
  lastUsedAt: null,
  originWorkId: null,
};

const asset: BusinessObject = {
  ...work,
  id: "a1",
  type: "asset",
  title: "读书笔记",
  library: "external",
  status: null,
  sourceNote: null,
};

function attachment(name: string): ContentRef {
  return {
    id: `ref-${name}`,
    ownerType: "work",
    ownerId: work.id,
    provider: "ragflow",
    datasetId: "d1",
    documentId: "doc",
    contentKey: "key",
    role: "attachment",
    documentName: name,
    contentHash: null,
    mime: "application/pdf",
    sizeBytes: 10,
    parseStatus: "succeeded",
    parseError: null,
    syncState: "synced",
    lastSyncedAt: null,
    createdAt: "2026-11-01T02:00:00.000Z",
    updatedAt: "2026-11-01T02:00:00.000Z",
    deletedAt: null,
  };
}

const exportedAt = new Date("2026-11-12T01:00:00.000Z");
/** 分类名称来自词表（ADR-023），导出函数接收 code → label 映射。 */
const categoryLabels = new Map([["article", "文章"]]);

describe("buildExportMarkdown", () => {
  it("按选中顺序输出标题、元信息与正文", () => {
    const markdown = buildExportMarkdown(
      [
        { object: work, content: "# 正文\n\n第一段", attachments: [attachment("参考.pdf")] },
        { object: asset, content: null, attachments: [] },
      ],
      exportedAt,
      categoryLabels,
    );

    expect(markdown).toContain("共 2 项");
    expect(markdown).toContain("导出时间：2026-11-12 09:00");
    expect(markdown.indexOf("## 1. 个人知识系统")).toBeLessThan(
      markdown.indexOf("## 2. 读书笔记"),
    );
    expect(markdown).toContain("- 类型：作品");
    expect(markdown).toContain("- 分类：文章");
    expect(markdown).toContain("- 归属：内库");
    expect(markdown).toContain("- 阶段：草稿");
    expect(markdown).toContain("- 标签：#复盘 #写作");
    expect(markdown).toContain("> 从收集到输出");
    expect(markdown).toContain("# 正文\n\n第一段");
    expect(markdown).toContain("- 参考.pdf");
    expect(markdown).toContain("- 归属：外库");
    expect(markdown).toContain("（无纯文本正文）");
  });

  it("没有成品时不输出空章节", () => {
    const markdown = buildExportMarkdown([], exportedAt, categoryLabels);

    expect(markdown).toContain("共 0 项");
    expect(markdown).not.toContain("### 正文");
  });
});

describe("exportFileName", () => {
  it("按导出日期命名 Markdown 文件", () => {
    expect(exportFileName(new Date(2026, 10, 12))).toBe("资产与作品-20261112.md");
  });
});
