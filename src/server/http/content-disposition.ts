/**
 * 内容下载的响应头口径：附件名怎么给，以及哪些内容可以内联按纯文本打开。
 *
 * 抽成纯函数是为了单测——这两个判断直接决定「点查看原文是预览还是下载」。
 */

/** 文本类内容：浏览器能当纯文本展示，且不该在本站源里执行。 */
export function isTextLikeContent(contentType: string, filename: string): boolean {
  const mime = contentType.split(";")[0].trim().toLowerCase();
  if (mime.startsWith("text/")) return true;
  if (mime === "application/json" || mime.endsWith("+json")) return true;
  if (mime === "application/xml" || mime.endsWith("+xml")) return true;
  return /\.(md|markdown|txt|log|csv|tsv|json|ya?ml)$/i.test(filename);
}

/**
 * 内联查看时的实际类型。浏览器对 text/markdown 会直接下载，text/html 会在
 * 本站源里执行脚本，所以文本类一律降成 text/plain；其余（PDF、图片）原样透传。
 */
export function inlineContentType(contentType: string, filename: string): string {
  return isTextLikeContent(contentType, filename)
    ? "text/plain; charset=utf-8"
    : contentType;
}

/** 同时给出 ASCII 兜底名与 UTF-8 原名，中文文件名在两种浏览器上都能还原。 */
export function contentDisposition(filename: string, inline = false): string {
  const safe = filename.replace(/[\r\n"\\]/g, "").trim() || "content";
  const extension = /\.[A-Za-z0-9]{1,8}$/.exec(safe)?.[0] ?? "";
  const stem = safe
    .slice(0, safe.length - extension.length)
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/[:*?<>|/]/g, "")
    .trim();
  const fallback = `${stem || "download"}${extension}`;

  const kind = inline ? "inline" : "attachment";
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(safe)}`;
}
