import type { ParseStatus } from "@/domain/content-ref";

/**
 * 内容区的纯展示格式化：文件大小、解析状态、时间、相似度。
 *
 * 这些函数不依赖 React 与服务端环境，页面、客户端组件与单测共用一份口径，
 * 避免同一条内容在列表和详情里显示成两种样子。
 */

/** 与服务端 `MAX_CONTENT_BYTES` 保持一致；客户端在选文件时先挡一次。 */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

const BYTE_UNITS = ["B", "KB", "MB", "GB"] as const;

export function formatFileSize(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) {
    return "—";
  }

  if (bytes < 1024) {
    return `${Math.round(bytes)} B`;
  }

  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }

  return `${Number(value.toFixed(1))} ${BYTE_UNITS[unit]}`;
}

export const parseStatusLabels: Record<ParseStatus, string> = {
  pending: "待解析",
  running: "解析中",
  succeeded: "已解析",
  failed: "解析失败",
};

/** 与 globals.css 的语义色对应，页面只按 tone 选样式。 */
export type StatusTone = "ok" | "info" | "warn" | "error";

export const parseStatusTones: Record<ParseStatus, StatusTone> = {
  pending: "warn",
  running: "info",
  succeeded: "ok",
  failed: "error",
};

/** 解析未结束时页面需要提示与自动刷新。 */
export function isParsePending(status: ParseStatus): boolean {
  return status === "pending" || status === "running";
}

/** 可以在页面里直接编辑的纯文本扩展名（与 text/* 一起判断）。 */
const EDITABLE_TEXT_EXTENSIONS = [".md", ".markdown", ".txt", ".json", ".csv"];

/**
 * 主内容是否可以直接用文本编辑器打开。
 *
 * 只认 `text/*` 与常见的纯文本扩展名：PDF、图片等二进制文件即使能被浏览器
 * 解码成人看不懂的乱码，也不该给它编辑入口，否则保存一次就把原文毁了。
 */
export function isEditableTextContent(
  ref: { mime?: string | null; documentName?: string | null },
): boolean {
  const mime = ref.mime?.trim().toLowerCase() ?? "";
  if (mime.startsWith("text/")) {
    return true;
  }

  const name = ref.documentName?.trim().toLowerCase() ?? "";
  return EDITABLE_TEXT_EXTENSIONS.some((extension) => name.endsWith(extension));
}

/**
 * 绝对时间统一按 Asia/Shanghai 展示：数据库里是 UTC ISO，
 * 服务端与浏览器所在时区可能不同，这里固定成用户习惯的北京时间。
 */
export function formatDateTime(
  iso: string | null | undefined,
  timeZone = "Asia/Shanghai",
): string {
  if (!iso) return "—";

  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";

  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);

  const valueOf = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";

  return `${valueOf("year")}-${valueOf("month")}-${valueOf("day")} ${valueOf("hour")}:${valueOf("minute")}`;
}

/** 相似度统一显示为 0–100 的整数百分比；异常值不显示假数字。 */
export function similarityPercent(value: number | null | undefined): string {
  const percent = similarityPercentValue(value);
  return percent === null ? "—" : `${percent}%`;
}

export function similarityPercentValue(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return null;
  }

  const clamped = Math.min(1, Math.max(0, value));
  return Math.round(clamped * 100);
}
