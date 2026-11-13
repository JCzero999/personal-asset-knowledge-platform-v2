import type { ContentRef } from "@/domain/content-ref";
import { isMarkdownContent } from "./markdown";

/**
 * 内容预览的判定与文案（ADR-026 / 19_DESIGN_LLM_PREVIEW §3）。
 *
 * 预览只按「能不能在页面里直接看」分五类；判定以 MIME 为主、扩展名为辅，
 * 因为 RAGFlow 回传的 MIME 可能是 `application/octet-stream`。
 */

/** 文本类单次预览上限：超过就只取前 512 KB（设计稿 §3.5 的性能边界）。 */
export const PREVIEW_TEXT_LIMIT_BYTES = 512 * 1024;

export type PreviewKind = "pdf" | "image" | "markdown" | "text" | "binary";

function extensionOf(name: string | null | undefined): string {
  const match = /\.[A-Za-z0-9]{1,8}$/.exec(name?.trim() ?? "");
  return match ? match[0].toLowerCase() : "";
}

const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp", ".svg"];
const TEXT_EXTENSIONS = [".txt", ".csv", ".json", ".log", ".yaml", ".yml", ".tsv", ".xml"];

export function previewKind(
  ref: Pick<ContentRef, "mime" | "documentName">,
): PreviewKind {
  const mime = (ref.mime ?? "").trim().toLowerCase();
  const extension = extensionOf(ref.documentName);

  if (mime === "application/pdf" || extension === ".pdf") return "pdf";
  if (mime.startsWith("image/") || IMAGE_EXTENSIONS.includes(extension)) return "image";
  if (isMarkdownContent(ref)) return "markdown";
  if (mime.startsWith("text/") || TEXT_EXTENSIONS.includes(extension)) return "text";
  return "binary";
}

/** 内容原文地址；`inline` 需要后端支持（ADR-026），未支持时降级为下载。 */
export function contentUrl(objectId: string, refId: string, inline = false): string {
  const base = `/api/objects/${encodeURIComponent(objectId)}/content/${encodeURIComponent(refId)}`;
  return inline ? `${base}?inline=1` : base;
}

/**
 * 解析失败的可读原因：先给一句能行动的话，原始错误留给第二行小字。
 * 与详情页 `parseError` 共用同一套判断，避免同一错误在两处说法不同。
 */
export function describeParseError(raw: string | null | undefined): {
  headline: string;
  detail: string | null;
} {
  const text = raw?.trim() ?? "";
  if (!text) return { headline: "解析没有完成，没有返回具体原因。", detail: null };

  if (/timeout|timed out|超时/i.test(text)) {
    return { headline: "抽取服务超时（本地模型过慢）。", detail: text };
  }
  if (/econnrefused|connection|connect|unreachable|fetch failed|无法连接|拒绝连接/i.test(text)) {
    return { headline: "抽取服务没有响应。", detail: text };
  }
  if (/unsupported|not supported|不支持|parse failed|invalid format/i.test(text)) {
    return { headline: "这个文件类型暂不支持解析。", detail: text };
  }
  if (/empty|no content|空白|没有内容/i.test(text)) {
    return { headline: "文件里没有可解析的文字。", detail: text };
  }
  return { headline: "解析没有完成。", detail: text };
}

/** 主内容固定第一，其余按上传时间升序（设计稿 §3.4）。 */
export function sortPreviewRefs(refs: ContentRef[]): ContentRef[] {
  return [...refs].sort((a, b) => {
    if (a.role !== b.role) return a.role === "primary" ? -1 : 1;
    return a.createdAt.localeCompare(b.createdAt);
  });
}
