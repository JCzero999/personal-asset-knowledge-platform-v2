import Link from "next/link";
import type { Metadata } from "next";

import { SearchDirectory } from "@/components/directory";
import { NavRail } from "@/components/nav-rail";
import { Icon } from "@/components/icon";
import { SearchForm } from "@/components/search-form";
import { similarityPercent, similarityPercentValue } from "@/lib/content-format";
import { buildCategoryLabelMap, type CategoryLabelMap } from "@/lib/category-labels";
import {
  contentRoleLabels,
  libraryLabels,
  objectTypeLabels,
  statusLabels,
} from "@/lib/object-labels";
import { buildSearchHref, parseSearchParams } from "@/lib/search-params";
import { buildHighlightSnippet } from "@/lib/search-highlight";
import {
  meetsSearchLength,
  parseSearchInput,
  searchFieldLabels,
  SearchSyntaxError,
} from "@/lib/search-query";
import { getDb } from "@/server/db/client";
import {
  searchContent,
  type SearchHit,
  type SearchResult,
} from "@/server/services/search-service";
import { listVocabulary } from "@/server/services/vocabulary-service";
import { requireSession, resolveAuthMode } from "@/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "内容检索 · 知产工作台",
  description: "按关键词或语义在你的资产与作品中查找内容。",
};

const examples = ["内容复盘怎么做", "写作方法论", "title:复盘", "分类:课程", "标签:工具类"];

/** 命中来源徽标：词法给出具体字段，语义给出「正文片段」。 */
function sourceLabel(hit: SearchHit): string {
  const fields = hit.matchedFields.map((field) => `${searchFieldLabels[field]}命中`);

  if (hit.source === "semantic") return "正文片段";
  if (hit.source === "both") return [...fields, "正文片段"].join(" · ");

  return fields.join(" · ") || "关键词命中";
}

function ObjectHitCard({
  hit,
  categoryLabels,
}: {
  hit: SearchHit;
  categoryLabels: CategoryLabelMap;
}) {
  // 语义命中沿用 RAGFlow 的 highlight；词法命中用命中词给摘要补标重点。
  const snippet = buildHighlightSnippet(hit.highlight, hit.content, hit.highlightTerms.join(" "));
  const object = hit.object;
  const percent = hit.similarity === null ? null : similarityPercentValue(hit.similarity);

  return (
    <li>
      <article className="hit-card">
        <div className="hit-head">
          <div className="badge-row">
            <span className={`badge search-source source-${hit.source}`}>{sourceLabel(hit)}</span>
            <span className={`badge type-${object.type}`}>
              {objectTypeLabels[object.type]}
            </span>
            <span className={`badge library-${object.library}`}>
              {libraryLabels[object.library]}
            </span>
            {object.type === "work" && object.status ? (
              <span className="badge">{statusLabels[object.status]}</span>
            ) : null}
            {object.category ? (
              <span className="badge">
                {categoryLabels.get(object.category) ?? object.category}
              </span>
            ) : null}
          </div>
          {hit.similarity !== null ? (
            <span className="similarity" title="语义相似度">
              <span className="similarity-value">{similarityPercent(hit.similarity)}</span>
              <span className="similarity-bar" aria-hidden="true">
                <span style={{ width: `${percent ?? 0}%` }} />
              </span>
            </span>
          ) : null}
        </div>

        <h2 className="hit-title">
          <Link href={`/workspace/${object.id}`}>{object.title}</Link>
        </h2>

        {snippet.segments.length > 0 ? (
          <p className="hit-snippet">
            {snippet.segments.map((segment, index) =>
              segment.strong ? (
                <mark className="hit-mark" key={index}>{segment.text}</mark>
              ) : (
                <span key={index}>{segment.text}</span>
              ),
            )}
          </p>
        ) : (
          <p className="hit-snippet hit-snippet-empty">这条内容暂无可展示的摘要。</p>
        )}

        {object.tags.length > 0 ? (
          <p className="hit-tags">
            {object.tags.map((tag) => (
              <span className="badge badge-ghost" key={tag}>{tag}</span>
            ))}
          </p>
        ) : null}

        <footer className="hit-foot">
          <span>
            {hit.documentName
              ? `${hit.documentName} · ${contentRoleLabels[hit.role ?? "primary"]}`
              : `关键词命中 ${hit.matchedFields.length} 个字段`}
            {hit.chunkCount > 1 ? ` · 合并 ${hit.chunkCount} 段` : ""}
          </span>
          <Link className="text-link" href={`/workspace/${object.id}`}>
            查看对象
            <Icon name="arrow-right" size={14} />
          </Link>
        </footer>
      </article>
    </li>
  );
}

function semanticNotice(result: SearchResult): string | null {
  if (result.mode === "lexical") return null;

  switch (result.semantic.status) {
    case "timeout":
      return "语义检索超时，当前只显示关键词匹配结果。";
    case "unavailable":
      return "语义检索暂不可用，当前只显示关键词匹配结果。";
    case "no_dataset":
      return "语义库还没有可检索的正文，当前只显示关键词匹配结果。";
    default:
      return null;
  }
}

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession();
  const state = parseSearchParams(await searchParams);
  // 分类名称来自词表（ADR-016 / ADR-023），不再读代码常量。
  const vocabulary = listVocabulary(getDb());
  const categoryLabels = buildCategoryLabelMap(vocabulary.categories);
  const signOutHref = resolveAuthMode() === "logto" ? "/api/logto/sign-out" : null;

  let result: SearchResult | null = null;
  let failure = false;
  let syntaxError: { message: string; position: number } | null = null;
  let tooShort = false;

  // 语法错误在输入框下方展示原文与位置，不发起任何查询（ADR-024 第 3 条）。
  if (state.q && !state.error) {
    try {
      tooShort = !meetsSearchLength(parseSearchInput(state.q));
    } catch (error) {
      if (error instanceof SearchSyntaxError) {
        syntaxError = { message: error.message, position: error.position };
      } else {
        throw error;
      }
    }
  }

  if (state.q && !state.error && !syntaxError && !tooShort) {
    try {
      result = await searchContent(getDb(), session.sub, {
        question: state.q,
        ...(state.library ? { library: state.library } : {}),
        mode: state.mode,
        similarityThreshold: state.threshold,
      });
    } catch (error) {
      console.error("[search] 检索失败", error);
      failure = true;
    }
  }

  const currentHref = buildSearchHref(state);
  const libraryLabel = state.library ? libraryLabels[state.library] : "全部库别";
  const notice = result ? semanticNotice(result) : null;

  return (
    <div className="app-frame">
      <NavRail session={session} active="search" signOutHref={signOutHref} />
      <SearchDirectory
        library={state.library}
        session={session}
        taxonomyCounts={{
          categories: vocabulary.categories.filter((item) => item.state === "active").length,
          tags: vocabulary.tags.length,
        }}
      />

      <main className="record-detail">
        <div className="detail-scroll">
          <div className="workspace search-workspace">
            <header className="workspace-header">
              <div className="workspace-greeting">
                <p className="workspace-date">知识索引 · 关键词 + 语义</p>
                <h1>内容检索</h1>
                <p className="workspace-subtitle">
                  标题、描述、分类与标签走关键词匹配，正文片段由语义检索补充；结果只来自你自己的内容。
                </p>
              </div>
            </header>

            <section className="panel search-panel" aria-label="检索条件">
              <div className="search-panel-body">
                <SearchForm
                  key={currentHref}
                  q={state.q}
                  library={state.library}
                  threshold={state.threshold}
                  mode={state.mode}
                  syntaxError={syntaxError}
                />
                <p className="search-hint">
                  支持空格 AND、<code>&quot;短语&quot;</code>、<code>title:</code> / <code>desc:</code> /{" "}
                  <code>category:</code> / <code>tag:</code> 前缀与 <code>-排除</code>；
                  相似度阈值只影响语义结果。
                </p>
              </div>
            </section>

            {state.error ? (
              <section className="panel search-state" role="alert">
                <span className="empty-icon"><Icon name="alert" size={26} /></span>
                <div className="empty-copy">
                  <strong>检索条件有误</strong>
                  <p>{state.error}</p>
                </div>
                <div className="state-actions">
                  <Link className="btn btn-primary" href="/search">清空条件</Link>
                  {state.q ? (
                    <Link
                      className="btn btn-secondary"
                      href={buildSearchHref({ q: state.q, threshold: 0.2 })}
                    >
                      按默认条件检索
                    </Link>
                  ) : null}
                </div>
              </section>
            ) : syntaxError ? (
              <section className="panel search-state" role="alert">
                <span className="empty-icon"><Icon name="alert" size={26} /></span>
                <div className="empty-copy">
                  <strong>检索语法有误</strong>
                  <p>{syntaxError.message}（第 {syntaxError.position + 1} 个字符附近）</p>
                  <p>
                    不支持 <code>OR</code> 与括号；需要排除时用 <code>-词</code>，短语用双引号。
                  </p>
                </div>
                <div className="state-actions">
                  <Link className="btn btn-primary" href={buildSearchHref({ q: state.q.split(/\s+/)[0] ?? "", threshold: state.threshold })}>
                    只搜第一个词
                  </Link>
                  <Link className="btn btn-ghost" href="/search">清空检索</Link>
                </div>
              </section>
            ) : tooShort ? (
              <section className="panel search-state">
                <span className="empty-icon"><Icon name="search" size={26} /></span>
                <div className="empty-copy">
                  <strong>至少输入 2 个字</strong>
                  <p>单个字歧义太大，补一个字或换一个更具体的词再试。</p>
                </div>
              </section>
            ) : !state.q ? (
              <section className="panel search-state search-idle">
                <span className="empty-icon"><Icon name="search" size={26} /></span>
                <div className="empty-copy">
                  <strong>从一个问题或关键词开始</strong>
                  <p>
                    关键词会匹配标题、描述、分类与标签；正文里的说法由语义检索补充，
                    两条结果按对象合并。
                  </p>
                </div>
                <div className="example-row" aria-label="示例检索词">
                  {examples.map((example) => (
                    <Link
                      className="example-chip"
                      href={buildSearchHref({ q: example, threshold: 0.2 })}
                      key={example}
                    >
                      {example}
                    </Link>
                  ))}
                </div>
                <ul className="search-tips">
                  <li>空格表示「同时满足」；<code>-词</code> 排除，<code>&quot;短语&quot;</code> 整段匹配。</li>
                  <li><code>title:</code>、<code>desc:</code>、<code>category:</code>、<code>tag:</code> 限定字段。</li>
                  <li>正文不在本地索引里，只靠语义检索；语义不可用时关键词结果照常返回。</li>
                  <li>结果会按当前身份过滤，归档内容默认不出现。</li>
                </ul>
              </section>
            ) : failure ? (
              <section className="panel search-state" role="alert">
                <span className="empty-icon"><Icon name="alert" size={26} /></span>
                <div className="empty-copy">
                  <strong>检索暂时不可用</strong>
                  <p>本地关键词索引没有正常响应。稍后重试通常能恢复。</p>
                </div>
                <div className="state-actions">
                  <a className="btn btn-primary" href={currentHref}>重试</a>
                  <Link className="btn btn-secondary" href="/search">清空条件</Link>
                </div>
              </section>
            ) : result && result.hits.length === 0 ? (
              <section className="panel search-state">
                <span className="empty-icon"><Icon name="search" size={26} /></span>
                <div className="empty-copy">
                  <strong>没有找到匹配的对象</strong>
                  <p>
                    关键词覆盖标题、描述、分类与标签，正文由语义检索补充。
                    可以换一种说法、减少排除词，或去掉库别限制。
                  </p>
                </div>
                <div className="state-actions">
                  {state.library ? (
                    <Link
                      className="btn btn-secondary"
                      href={buildSearchHref({ q: state.q, threshold: state.threshold })}
                    >
                      去掉库别筛选
                    </Link>
                  ) : null}
                  <Link className="btn btn-ghost" href="/search">清空检索</Link>
                </div>
              </section>
            ) : result ? (
              <>
                {notice ? (
                  <p className="search-notice" role="status">
                    <Icon name="alert" size={16} />
                    {notice}
                  </p>
                ) : null}

                <div className="search-summary" role="status">
                  <p>
                    找到 <strong>{result.total}</strong> 个对象与「{result.question}」相关
                  </p>
                  <span className="meta-chip">
                    关键词 {result.counts.lexical} · 正文 {result.counts.semantic} · {libraryLabel}
                    {state.mode === "lexical" ? " · 仅关键词" : ` · 阈值 ${similarityPercent(state.threshold)}（仅语义）`}
                  </span>
                </div>

                {result.lexical.hint ? (
                  <p className="search-notice" role="status">
                    <Icon name="alert" size={16} />
                    {result.lexical.hint}
                  </p>
                ) : null}

                <ol className="hit-list">
                  {result.hits.map((hit) => (
                    <ObjectHitCard
                      hit={hit}
                      key={hit.object.id}
                      categoryLabels={categoryLabels}
                    />
                  ))}
                </ol>

                <p className="search-footnote">
                  按「标题 &gt; 分类 / 标签 &gt; 正文 &gt; 描述」排序，同分按更新时间倒序；
                  一个对象只出现一次。相似度不是置信度，只用来排序。
                </p>
              </>
            ) : null}
          </div>
        </div>
      </main>
    </div>
  );
}
