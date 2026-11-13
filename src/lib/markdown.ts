/**
 * 极简 Markdown 解析：只覆盖写文章会用到的语法，输出纯数据结构。
 *
 * 不引入 `react-markdown` 一类依赖，也不使用 `dangerouslySetInnerHTML`：
 * 解析结果是块 + 行内片段，由组件渲染成 React 元素，原始 HTML 永远当文本。
 * 支持：标题、段落、粗体、斜体、行内代码、链接、有序 / 无序列表、引用、代码块、分隔线。
 */

export type InlineSpan =
  | { kind: "text"; text: string }
  | { kind: "strong"; children: InlineSpan[] }
  | { kind: "em"; children: InlineSpan[] }
  | { kind: "code"; text: string }
  | { kind: "link"; href: string; children: InlineSpan[] };

export type MarkdownBlock =
  | { kind: "heading"; level: number; spans: InlineSpan[] }
  | { kind: "paragraph"; spans: InlineSpan[] }
  | { kind: "list"; ordered: boolean; items: InlineSpan[][] }
  | { kind: "quote"; spans: InlineSpan[] }
  | { kind: "code"; lang: string; code: string }
  | { kind: "hr" };

/** 只放行 http(s)、mailto、站内绝对路径与页内锚点，挡掉 `javascript:` 之类的伪协议。 */
export function safeHref(href: string): string | null {
  const value = href.trim();

  if (!value) return null;
  if (value.startsWith("/") || value.startsWith("#")) return value;
  if (/^https?:\/\//i.test(value) || /^mailto:/i.test(value)) return value;

  return null;
}

function flushText(spans: InlineSpan[], buffer: string) {
  if (buffer) spans.push({ kind: "text", text: buffer });
}

/** 行内解析：反引号代码 → 链接 → 粗体 → 斜体，未闭合的标记按文本处理。 */
export function parseInline(source: string): InlineSpan[] {
  const spans: InlineSpan[] = [];
  let buffer = "";
  let index = 0;

  const flush = () => {
    flushText(spans, buffer);
    buffer = "";
  };

  while (index < source.length) {
    const char = source[index];

    if (char === "`") {
      const end = source.indexOf("`", index + 1);
      if (end !== -1) {
        flush();
        spans.push({ kind: "code", text: source.slice(index + 1, end) });
        index = end + 1;
        continue;
      }
    }

    if (char === "[") {
      const match = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(source.slice(index));
      if (match) {
        const href = safeHref(match[2]);
        if (href) {
          flush();
          spans.push({ kind: "link", href, children: parseInline(match[1]) });
          index += match[0].length;
          continue;
        }
      }
    }

    if (source.startsWith("**", index) || source.startsWith("__", index)) {
      const marker = source.slice(index, index + 2);
      const end = source.indexOf(marker, index + 2);
      if (end !== -1) {
        flush();
        spans.push({
          kind: "strong",
          children: parseInline(source.slice(index + 2, end)),
        });
        index = end + 2;
        continue;
      }
    }

    if (char === "*" || char === "_") {
      const end = source.indexOf(char, index + 1);
      if (end > index + 1) {
        flush();
        spans.push({ kind: "em", children: parseInline(source.slice(index + 1, end)) });
        index = end + 1;
        continue;
      }
    }

    buffer += char;
    index += 1;
  }

  flush();
  return spans;
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const HR = /^\s*([-*_])(?:\s*\1){2,}\s*$/;
const LIST_ITEM = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const FENCE = /^\s*```([^\s`]*)\s*$/;

/** 块级解析：空行分段，代码块原样保留（含缩进）。 */
export function parseMarkdown(markdown: string): MarkdownBlock[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      index += 1;
      blocks.push({ kind: "code", lang: fence[1], code: code.join("\n") });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({
        kind: "heading",
        level: heading[1].length,
        spans: parseInline(heading[2].trim()),
      });
      index += 1;
      continue;
    }

    if (HR.test(line)) {
      blocks.push({ kind: "hr" });
      index += 1;
      continue;
    }

    if (LIST_ITEM.test(line)) {
      const ordered = LIST_ITEM.exec(line)?.[2] !== undefined;
      const items: InlineSpan[][] = [];
      while (index < lines.length) {
        const item = LIST_ITEM.exec(lines[index]);
        if (!item) break;
        items.push(parseInline(item[3].trim()));
        index += 1;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }

    if (QUOTE.test(line)) {
      const quote: string[] = [];
      while (index < lines.length) {
        const match = QUOTE.exec(lines[index]);
        if (!match) break;
        quote.push(match[1]);
        index += 1;
      }
      blocks.push({ kind: "quote", spans: parseInline(quote.join("\n").trim()) });
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length) {
      const current = lines[index];
      if (
        !current.trim()
        || HEADING.test(current)
        || HR.test(current)
        || LIST_ITEM.test(current)
        || QUOTE.test(current)
        || FENCE.test(current)
      ) {
        break;
      }
      paragraph.push(current.trim());
      index += 1;
    }
    blocks.push({ kind: "paragraph", spans: parseInline(paragraph.join("\n")) });
  }

  return blocks;
}

/** 编辑器默认类型：`.md` / `.markdown` / `text/markdown` 打开 Markdown，其余按纯文本。 */
export function isMarkdownContent(
  ref: { mime?: string | null; documentName?: string | null } | null,
): boolean {
  if (!ref) return false;

  const mime = ref.mime?.trim().toLowerCase() ?? "";
  if (mime === "text/markdown" || mime === "text/x-markdown") return true;

  const name = ref.documentName?.trim().toLowerCase() ?? "";
  return name.endsWith(".md") || name.endsWith(".markdown");
}
