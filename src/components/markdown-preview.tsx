import type { ReactNode } from "react";

import { parseMarkdown, type InlineSpan } from "@/lib/markdown";

/**
 * Markdown 预览：把解析结果渲染成 React 元素。
 *
 * 原文里的 HTML 一律当作文本，不经过 `dangerouslySetInnerHTML`，
 * 链接只认 `safeHref` 放行的协议（见 `lib/markdown.ts`）。
 */

function renderInline(spans: InlineSpan[], keyPrefix = ""): ReactNode[] {
  return spans.map((span, index) => {
    const key = `${keyPrefix}${index}`;

    switch (span.kind) {
      case "text":
        return span.text;
      case "strong":
        return <strong key={key}>{renderInline(span.children, `${key}-`)}</strong>;
      case "em":
        return <em key={key}>{renderInline(span.children, `${key}-`)}</em>;
      case "code":
        return <code key={key}>{span.text}</code>;
      case "link":
        return (
          <a
            href={span.href}
            key={key}
            rel="noreferrer noopener"
            target={span.href.startsWith("http") ? "_blank" : undefined}
          >
            {renderInline(span.children, `${key}-`)}
          </a>
        );
    }
  });
}

export function MarkdownPreview({ text }: { text: string }) {
  const blocks = parseMarkdown(text);

  if (blocks.length === 0) {
    return (
      <p className="markdown-empty">
        预览会显示在这里。用 <code>#</code> 加空格写标题，<code>**文字**</code> 加粗。
      </p>
    );
  }

  return (
    <div className="markdown-body">
      {blocks.map((block, index) => {
        const key = `block-${index}`;

        switch (block.kind) {
          case "heading": {
            const Tag = `h${Math.min(block.level, 3)}` as "h1" | "h2" | "h3";
            return <Tag key={key}>{renderInline(block.spans, `${key}-`)}</Tag>;
          }
          case "paragraph":
            return <p key={key}>{renderInline(block.spans, `${key}-`)}</p>;
          case "list": {
            const ListTag = block.ordered ? "ol" : "ul";
            return (
              <ListTag key={key}>
                {block.items.map((item, itemIndex) => (
                  <li key={`${key}-${itemIndex}`}>
                    {renderInline(item, `${key}-${itemIndex}-`)}
                  </li>
                ))}
              </ListTag>
            );
          }
          case "quote":
            return <blockquote key={key}>{renderInline(block.spans, `${key}-`)}</blockquote>;
          case "code":
            return (
              <pre key={key} data-lang={block.lang || undefined}>
                <code>{block.code}</code>
              </pre>
            );
          case "hr":
            return <hr key={key} />;
        }
      })}
    </div>
  );
}
