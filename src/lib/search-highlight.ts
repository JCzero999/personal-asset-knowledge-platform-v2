/**
 * 检索高亮的安全清洗。
 *
 * RAGFlow 返回的 `highlight` 可能带 `<em>` 等 HTML 标签，也可能混入实体。
 * 页面不直接 `dangerouslySetInnerHTML`，而是先把标签解析成「普通 / 强调」
 * 两类文本片段，再按检索词补标重点，最后由 React 渲染成纯文本 + `<mark>`。
 */

export interface HighlightSegment {
  text: string;
  /** true 表示这一段需要重点显示（来自 RAGFlow 的强调标签或检索词命中）。 */
  strong: boolean;
}

export interface HighlightSnippet {
  segments: HighlightSegment[];
  /** 拼接后的纯文本，方便做 aria-label、复制与断言。 */
  text: string;
}

const EMPHASIS_TAGS = new Set(["em", "b", "strong", "mark"]);
const BLOCK_TAGS = new Set([
  "br",
  "p",
  "div",
  "li",
  "ul",
  "ol",
  "tr",
  "td",
  "th",
  "table",
  "section",
  "article",
  "blockquote",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
]);

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function codePointToString(code: number): string {
  if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return "";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

export function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) =>
      codePointToString(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, decimal: string) =>
      codePointToString(Number.parseInt(decimal, 10)),
    )
    .replace(/&([a-z]+);/gi, (match, name: string) => {
      const decoded = NAMED_ENTITIES[name.toLowerCase()];
      return decoded ?? match;
    });
}

interface RawSegment {
  text: string;
  strong: boolean;
}

/** 把 HTML 拆成文本片段：强调标签只改 strong，其余标签丢弃，块级标签留一个空格。 */
function segmentsFromHtml(html: string): RawSegment[] {
  const withoutScripts = html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<(script|style)\b[^>]*\/?>/gi, " ");

  const raw: RawSegment[] = [];
  const tagPattern = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g;
  let emphasisDepth = 0;
  let cursor = 0;
  let match: RegExpExecArray | null;

  const pushText = (text: string) => {
    if (text) raw.push({ text, strong: emphasisDepth > 0 });
  };

  while ((match = tagPattern.exec(withoutScripts)) !== null) {
    pushText(withoutScripts.slice(cursor, match.index));

    const tagName = match[1].toLowerCase();
    const closing = match[0].startsWith("</");
    const selfClosing = /\/>$/.test(match[0]);

    if (EMPHASIS_TAGS.has(tagName)) {
      if (closing) emphasisDepth = Math.max(0, emphasisDepth - 1);
      else if (!selfClosing) emphasisDepth += 1;
    } else if (BLOCK_TAGS.has(tagName)) {
      pushText(" ");
    }

    cursor = tagPattern.lastIndex;
  }

  pushText(withoutScripts.slice(cursor));
  return raw;
}

/** 合并同类片段、解码实体，并把所有空白收敛成单个空格。 */
function normalizeSegments(raw: RawSegment[]): HighlightSegment[] {
  const result: HighlightSegment[] = [];

  for (const segment of raw) {
    let text = decodeHtmlEntities(segment.text).replace(/\s+/g, " ");
    if (!text) continue;

    const previous = result[result.length - 1];
    if (previous && previous.text.endsWith(" ") && text.startsWith(" ")) {
      text = text.slice(1);
    }
    if (!text) continue;

    if (previous && previous.strong === segment.strong) previous.text += text;
    else result.push({ text, strong: segment.strong });
  }

  if (result.length > 0) {
    result[0] = { ...result[0], text: result[0].text.replace(/^ /, "") };
    const lastIndex = result.length - 1;
    result[lastIndex] = {
      ...result[lastIndex],
      text: result[lastIndex].text.replace(/ $/, ""),
    };
  }

  return result.filter((segment) => segment.text.length > 0);
}

function mergeAdjacentSegments(segments: HighlightSegment[]): HighlightSegment[] {
  const result: HighlightSegment[] = [];

  for (const segment of segments) {
    if (!segment.text) continue;
    const previous = result[result.length - 1];
    if (previous && previous.strong === segment.strong) previous.text += segment.text;
    else result.push({ text: segment.text, strong: segment.strong });
  }

  return result;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function queryTokens(query: string): string[] {
  return [...new Set(query.trim().split(/\s+/).filter(Boolean))]
    .sort((a, b) => b.length - a.length);
}

/** 在非强调片段里按检索词补标重点；长词优先，避免重叠。 */
function markQueryTokens(
  segments: HighlightSegment[],
  query: string,
): HighlightSegment[] {
  const tokens = queryTokens(query);
  if (tokens.length === 0) return segments;

  const pattern = new RegExp(`(${tokens.map(escapeRegExp).join("|")})`, "gi");
  const result: HighlightSegment[] = [];

  for (const segment of segments) {
    if (segment.strong) {
      result.push(segment);
      continue;
    }

    const pieces = segment.text.split(pattern);
    pieces.forEach((piece, index) => {
      if (!piece) return;
      // split 带捕获组时，奇数下标就是命中的检索词。
      result.push({ text: piece, strong: index % 2 === 1 });
    });
  }

  return mergeAdjacentSegments(result);
}

function totalLength(segments: HighlightSegment[]): number {
  return segments.reduce((sum, segment) => sum + segment.text.length, 0);
}

function sliceSegments(
  segments: HighlightSegment[],
  start: number,
  end: number,
  leadingEllipsis: boolean,
  trailingEllipsis: boolean,
): HighlightSegment[] {
  const sliced: HighlightSegment[] = [];
  let cursor = 0;

  for (const segment of segments) {
    const segmentStart = cursor;
    const segmentEnd = cursor + segment.text.length;
    const from = Math.max(start, segmentStart);
    const to = Math.min(end, segmentEnd);

    if (to > from) {
      sliced.push({
        text: segment.text.slice(from - segmentStart, to - segmentStart),
        strong: segment.strong,
      });
    }

    cursor = segmentEnd;
    if (cursor >= end) break;
  }

  if (sliced.length > 0 && leadingEllipsis) {
    sliced[0] = { ...sliced[0], text: `…${sliced[0].text}` };
  }
  if (sliced.length > 0 && trailingEllipsis) {
    const last = sliced.length - 1;
    sliced[last] = { ...sliced[last], text: `${sliced[last].text}…` };
  }

  return sliced;
}

/** 截取命中词附近的一段，避免把整篇内容塞进卡片。 */
function truncateSegments(
  segments: HighlightSegment[],
  maxLength: number,
): HighlightSegment[] {
  const total = totalLength(segments);
  if (total <= maxLength) return segments;

  let matchStart = -1;
  let cursor = 0;
  for (const segment of segments) {
    if (segment.strong) {
      matchStart = cursor;
      break;
    }
    cursor += segment.text.length;
  }

  const start =
    matchStart > maxLength * 0.4
      ? Math.max(0, matchStart - Math.floor(maxLength * 0.3))
      : 0;
  const end = Math.min(total, start + maxLength);

  return sliceSegments(segments, start, end, start > 0, end < total);
}

/**
 * 生成一段可直接渲染的检索摘要。
 *
 * - 优先使用 RAGFlow 的 highlight，缺失时退回原文；
 * - 所有标签都被剥离，不会把不可信 HTML 交给浏览器；
 * - 结果按检索词补标重点，并截到 maxLength 附近。
 */
export function buildHighlightSnippet(
  highlight: string | null | undefined,
  fallback: string,
  query: string,
  maxLength = 300,
): HighlightSnippet {
  const primary = highlight && highlight.trim() ? highlight : fallback;
  let segments = normalizeSegments(segmentsFromHtml(primary));

  if (segments.length === 0 && primary !== fallback) {
    segments = normalizeSegments(segmentsFromHtml(fallback));
  }

  segments = markQueryTokens(segments, query);

  if (maxLength > 0) {
    segments = truncateSegments(segments, maxLength);
  }

  return { segments, text: segments.map((segment) => segment.text).join("") };
}
