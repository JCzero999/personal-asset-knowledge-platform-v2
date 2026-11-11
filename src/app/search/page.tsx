import Link from "next/link";
import type { Metadata } from "next";

import { AppSidebar } from "@/components/app-sidebar";
import { Icon } from "@/components/icon";
import { SearchForm } from "@/components/search-form";
import { workFormats } from "@/domain/objects";
import { similarityPercent, similarityPercentValue } from "@/lib/content-format";
import {
  contentRoleLabels,
  libraryLabels,
  objectTypeLabels,
  statusLabels,
} from "@/lib/object-labels";
import { buildSearchHref, parseSearchParams } from "@/lib/search-params";
import { buildHighlightSnippet } from "@/lib/search-highlight";
import { getDb } from "@/server/db/client";
import {
  searchContent,
  type SearchHit,
  type SearchResult,
} from "@/server/services/search-service";
import { requireSession, resolveAuthMode } from "@/server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "内容检索 · 知产工作台",
  description: "按语义在你的资产与作品中查找相关段落。",
};

const formatLabels = new Map(workFormats.map((item) => [item.value, item.label]));

const examples = ["内容复盘怎么做", "写作方法论", "产品需求优先级"];

function HitCard({ hit, question }: { hit: SearchHit; question: string }) {
  const snippet = buildHighlightSnippet(hit.highlight, hit.content, question);
  const percent = similarityPercentValue(hit.similarity);
  const object = hit.object;

  return (
    <li>
      <article className="hit-card">
        <div className="hit-head">
          <div className="badge-row">
            <span className={`badge type-${object.type}`}>
              {objectTypeLabels[object.type]}
            </span>
            <span className={`badge library-${object.library}`}>
              {libraryLabels[object.library]}
            </span>
            {object.type === "work" ? (
              <>
                {object.status ? (
                  <span className="badge">{statusLabels[object.status]}</span>
                ) : null}
                {object.format ? (
                  <span className="badge">{formatLabels.get(object.format) ?? object.format}</span>
                ) : null}
              </>
            ) : null}
          </div>
          <span className="similarity" title="语义相似度">
            <span className="similarity-value">{similarityPercent(hit.similarity)}</span>
            <span className="similarity-bar" aria-hidden="true">
              <span style={{ width: `${percent ?? 0}%` }} />
            </span>
          </span>
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

        <footer className="hit-foot">
          <span>
            {hit.documentName ?? "内容片段"} · {contentRoleLabels[hit.role]}
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

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession();
  const state = parseSearchParams(await searchParams);
  const signOutHref = resolveAuthMode() === "logto" ? "/api/logto/sign-out" : null;

  let result: SearchResult | null = null;
  let failure = false;

  if (state.q && !state.error) {
    try {
      result = await searchContent(getDb(), session.sub, {
        question: state.q,
        ...(state.library ? { library: state.library } : {}),
        similarityThreshold: state.threshold,
      });
    } catch (error) {
      console.error("[search] 检索失败", error);
      failure = true;
    }
  }

  const currentHref = buildSearchHref(state);
  const relaxedHref = buildSearchHref({
    q: state.q,
    library: state.library,
    threshold: 0.1,
  });
  const libraryLabel = state.library ? libraryLabels[state.library] : "全部库别";

  return (
    <div className="app-shell">
      <AppSidebar session={session} active="search" signOutHref={signOutHref} />

      <main className="workspace search-workspace">
        <header className="workspace-header">
          <div className="workspace-greeting">
            <p className="workspace-date">知识索引 · 语义检索</p>
            <h1>内容检索</h1>
            <p className="workspace-subtitle">
              用一句话找到资料里的相关段落，结果只来自你自己的内容。
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
            />
            <p className="search-hint">
              默认按 0.2 相似度过滤；库别与阈值会保留在地址里，刷新或分享都能回到同一份结果。
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
        ) : !state.q ? (
          <section className="panel search-state search-idle">
            <span className="empty-icon"><Icon name="search" size={26} /></span>
            <div className="empty-copy">
              <strong>从一个问题开始</strong>
              <p>
                输入你记得的说法、主题或结论，检索会返回最接近的段落，
                并按相似度排序。
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
              <li>结果会按当前身份过滤，归档内容默认不出现。</li>
              <li>找不到时换一种说法，或把相似度阈值调低再试。</li>
              <li>内容刚上传时可能还在解析，稍等片刻再检索。</li>
            </ul>
          </section>
        ) : failure ? (
          <section className="panel search-state" role="alert">
            <span className="empty-icon"><Icon name="alert" size={26} /></span>
            <div className="empty-copy">
              <strong>检索暂时不可用</strong>
              <p>内容库没有正常响应，可能是服务未启动或网络异常。稍后重试通常能恢复。</p>
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
              <strong>没有找到相关内容</strong>
              <p>
                没有段落达到 {similarityPercent(state.threshold)} 的相似度，
                或者内容还在解析中。可以换一种说法、放宽阈值，或去掉库别限制。
              </p>
            </div>
            <div className="state-actions">
              <Link className="btn btn-primary" href={relaxedHref}>
                放宽到 0.1 再试
              </Link>
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
            <div className="search-summary" role="status">
              <p>
                找到 <strong>{result.total}</strong> 条与「{result.question}」相关的内容
              </p>
              <span className="meta-chip">
                {libraryLabel} · 阈值 {similarityPercent(state.threshold)}
              </span>
            </div>

            <ol className="hit-list">
              {result.hits.map((hit) => (
                <HitCard hit={hit} question={result.question} key={hit.chunkId} />
              ))}
            </ol>

            <p className="search-footnote">
              结果按语义相似度排序，最多显示 10 条。相似度不是置信度，只用来排序。
            </p>
          </>
        ) : null}
      </main>
    </div>
  );
}
