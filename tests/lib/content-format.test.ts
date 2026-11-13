import { describe, expect, it } from "vitest";

import {
  formatDateTime,
  formatFileSize,
  isEditableTextContent,
  isParsePending,
  parseStatusLabels,
  parseStatusTones,
  similarityPercent,
  similarityPercentValue,
} from "@/lib/content-format";

describe("formatFileSize", () => {
  it("缺失或非法体积显示占位符", () => {
    expect(formatFileSize(null)).toBe("—");
    expect(formatFileSize(undefined)).toBe("—");
    expect(formatFileSize(-1)).toBe("—");
    expect(formatFileSize(Number.NaN)).toBe("—");
  });

  it("按字节档位换算并去掉多余的 .0", () => {
    expect(formatFileSize(0)).toBe("0 B");
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(1024)).toBe("1 KB");
    expect(formatFileSize(1536)).toBe("1.5 KB");
    expect(formatFileSize(1024 * 1024)).toBe("1 MB");
    expect(formatFileSize(25 * 1024 * 1024)).toBe("25 MB");
    expect(formatFileSize(2.5 * 1024 * 1024 * 1024)).toBe("2.5 GB");
  });
});

describe("formatDateTime", () => {
  it("UTC ISO 统一转成北京时间", () => {
    expect(formatDateTime("2026-11-11T07:43:00.000Z")).toBe("2026-11-11 15:43");
  });

  it("缺失或非法时间显示占位符", () => {
    expect(formatDateTime(null)).toBe("—");
    expect(formatDateTime("")).toBe("—");
    expect(formatDateTime("not-a-date")).toBe("—");
  });
});

describe("similarityPercent", () => {
  it("四舍五入成整数百分比", () => {
    expect(similarityPercent(0.483)).toBe("48%");
    expect(similarityPercent(0.2)).toBe("20%");
    expect(similarityPercent(0)).toBe("0%");
  });

  it("超出范围时收敛到 0–100", () => {
    expect(similarityPercent(1.4)).toBe("100%");
    expect(similarityPercent(-0.2)).toBe("0%");
  });

  it("非法值不显示假数字", () => {
    expect(similarityPercent(null)).toBe("—");
    expect(similarityPercent(Number.NaN)).toBe("—");
    expect(similarityPercentValue(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("解析状态", () => {
  it("四种状态都有中文标签与语义色", () => {
    expect(parseStatusLabels).toEqual({
      pending: "待解析",
      running: "解析中",
      succeeded: "已解析",
      failed: "解析失败",
    });
    expect(parseStatusTones.failed).toBe("error");
    expect(parseStatusTones.succeeded).toBe("ok");
  });

  it("pending / running 视为未完成，需要继续刷新", () => {
    expect(isParsePending("pending")).toBe(true);
    expect(isParsePending("running")).toBe(true);
    expect(isParsePending("succeeded")).toBe(false);
    expect(isParsePending("failed")).toBe(false);
  });
});

describe("isEditableTextContent", () => {
  it("text/* 的 MIME 可以直接编辑", () => {
    expect(isEditableTextContent({ mime: "text/plain", documentName: "note" })).toBe(true);
    expect(isEditableTextContent({ mime: "text/markdown", documentName: null })).toBe(true);
    expect(isEditableTextContent({ mime: "TEXT/CSV", documentName: null })).toBe(true);
  });

  it("常见纯文本扩展名即使 MIME 不准也能编辑", () => {
    for (const name of ["a.md", "b.markdown", "c.txt", "d.json", "e.csv", "F.MD"]) {
      expect(isEditableTextContent({ mime: "application/octet-stream", documentName: name })).toBe(
        true,
      );
    }
  });

  it("二进制与未知类型不给编辑入口", () => {
    expect(isEditableTextContent({ mime: "application/pdf", documentName: "a.pdf" })).toBe(false);
    expect(isEditableTextContent({ mime: "image/png", documentName: "a.png" })).toBe(false);
    expect(isEditableTextContent({ mime: null, documentName: "archive" })).toBe(false);
    expect(isEditableTextContent({ mime: null, documentName: "notes.txt.bak" })).toBe(false);
    expect(isEditableTextContent({})).toBe(false);
  });
});
