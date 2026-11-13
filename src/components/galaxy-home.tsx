"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import { useSearchPreview } from "@/hooks/use-search-preview";
import { resolveHomeSearchSubmit } from "@/lib/galaxy";
import type { NavItem } from "@/lib/nav-items";
import { libraryLabels, objectTypeLabels } from "@/lib/object-labels";
import { buildHighlightSnippet } from "@/lib/search-highlight";
import { MAX_SEARCH_QUESTION } from "@/lib/search-params";
import { resolvePreviewKey } from "@/lib/search-preview";
import { GalaxyMark } from "./galaxy-mark";
import { GalaxyScene } from "./galaxy-scene";
import { Icon } from "./icon";
import { ThemeSwitcher } from "./theme-switcher";

/**
 * 银河首页（ADR-018 定位，背景技术见 ADR-020，搜索预览见 ADR-024）。
 *
 * 搜索框是受服务端会话控制的 combobox：未登录时禁用且不产生任何请求；
 * 输入 ≥ 2 字后 200ms 防抖请求 `mode=lexical&limit=8`，只查本地元数据，
 * 不碰 RAGFlow，因此输入不掉帧。回车仍进 `/search` 看完整结果。
 * 左侧抽屉是导航栏的镜像，条目与 `nav-items.ts` 同源。
 */
export function GalaxyHome({
  signedIn,
  userName,
  signInHref,
  signOutHref,
  navItems,
  categoryLabels,
}: {
  signedIn: boolean;
  userName: string | null;
  signInHref: string | null;
  signOutHref: string | null;
  navItems: NavItem[];
  /** 分类 code → 展示名（词表读自服务端，避免首页额外请求）。 */
  categoryLabels: Record<string, string>;
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const handleRef = useRef<HTMLButtonElement | null>(null);
  const drawerRef = useRef<HTMLElement | null>(null);
  const previewRootRef = useRef<HTMLDivElement | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const preview = useSearchPreview({ signedIn, rootRef: previewRootRef });

  // ⌘K / Ctrl+K / “/” 聚焦搜索框；禁用态不抢按键。
  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (!signedIn) return;

      const target = event.target as HTMLElement | null;
      const typing =
        target instanceof HTMLElement
        && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);

      const isShortcut = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k";
      const isSlash = event.key === "/" && !typing && !event.metaKey && !event.ctrlKey && !event.altKey;

      if (!isShortcut && !isSlash) return;
      event.preventDefault();
      inputRef.current?.focus();
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [signedIn]);

  // 抽屉打开后：焦点进入第一项、Tab 循环、Esc 关闭、关闭后归还焦点。
  useEffect(() => {
    if (!drawerOpen) return;
    const drawer = drawerRef.current;
    if (!drawer) return;
    const handle = handleRef.current;

    const focusables = Array.from(
      drawer.querySelectorAll<HTMLElement>('a[href], button:not([disabled])'),
    );
    const firstItem = drawer.querySelector<HTMLElement>(".galaxy-drawer-item");
    (firstItem ?? focusables[0])?.focus();

    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setDrawerOpen(false);
        return;
      }

      if (event.key !== "Tab" || focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      handle?.focus();
    };
  }, [drawerOpen]);

  function submit() {
    const result = resolveHomeSearchSubmit({
      signedIn,
      value: preview.value,
      composing: preview.composing,
    });

    if (result.action === "navigate") {
      preview.close();
      router.push(result.href);
    }
  }

  function openObject(id: string) {
    preview.close();
    router.push(`/workspace/${id}`);
  }

  function clear() {
    preview.reset();
    inputRef.current?.focus();
  }

  function onSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    // 输入法组合期间的回车用于确认候选词，不导航、不提交。
    if (event.nativeEvent.isComposing) return;

    const intent = resolvePreviewKey({
      key: event.key,
      open: preview.open,
      activeIndex: preview.activeIndex,
      count: preview.items.length,
      hasValue: preview.value.trim().length > 0,
    });

    switch (intent) {
      case "next":
        event.preventDefault();
        preview.move(1);
        break;
      case "prev":
        event.preventDefault();
        preview.move(-1);
        break;
      case "open": {
        const item = preview.items[preview.activeIndex];
        if (item) {
          event.preventDefault();
          openObject(item.id);
        }
        break;
      }
      case "close":
        event.preventDefault();
        preview.close();
        break;
      case "clear":
        event.preventDefault();
        clear();
        break;
      default:
        // submit 交给 form 的 onSubmit，保持「回车进结果页」的既有行为。
        break;
    }
  }

  const hasValue = preview.value.length > 0;
  const activeId =
    preview.open && preview.activeIndex >= 0 ? `galaxy-preview-${preview.activeIndex}` : undefined;

  return (
    <main className="galaxy-home" data-surface="cosmic">
      <GalaxyScene />

      <header className="galaxy-topbar">
        <Link className="galaxy-brand" href="/" aria-label="知产工作台首页">
          <span className="galaxy-brand-badge" aria-hidden="true">
            <GalaxyMark id="galaxy-mark-topbar" size={24} />
          </span>
          <span className="galaxy-brand-name">知产工作台</span>
          <span className="galaxy-brand-name-short">知产</span>
        </Link>

        <div className="galaxy-top-actions">
          {signedIn ? (
            <>
              <Link className="galaxy-enter" href="/workspace">
                进入工作台
                <Icon name="arrow-right" size={16} />
              </Link>
              <ThemeSwitcher variant="home" userName={userName ?? "已登录"} signOutHref={signOutHref} />
            </>
          ) : signInHref ? (
            <a className="galaxy-enter" href={signInHref}>
              登录
              <Icon name="arrow-right" size={16} />
            </a>
          ) : (
            <span className="galaxy-enter is-muted">登录尚未开放</span>
          )}
        </div>
      </header>

      <section className="galaxy-search-group" aria-labelledby="galaxy-title">
        <p className="galaxy-eyebrow">PERSONAL KNOWLEDGE</p>
        <h1 className="galaxy-title" id="galaxy-title">从一个问题开始</h1>

        <div className="galaxy-search-wrap" ref={previewRootRef}>
          <form
            className="galaxy-search"
            data-disabled={!signedIn}
            role="search"
            aria-label="搜索内容"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            {!signedIn && signInHref ? (
              <button
                className="galaxy-search-login-layer"
                type="button"
                aria-label="登录后可检索内容"
                onClick={() => { window.location.href = signInHref; }}
              />
            ) : null}
            <label className="sr-only" htmlFor="galaxy-search-input">搜索内容</label>
            <span className="galaxy-search-icon" aria-hidden="true">
              <Icon name="search" size={20} />
            </span>
            <input
              ref={inputRef}
              autoComplete="off"
              className="galaxy-search-input"
              disabled={!signedIn}
              enterKeyHint="search"
              id="galaxy-search-input"
              inputMode="search"
              maxLength={MAX_SEARCH_QUESTION}
              placeholder={signedIn ? "搜索资产、作品与笔记" : "登录后可检索内容"}
              type="search"
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={preview.open}
              aria-controls="galaxy-search-preview"
              aria-activedescendant={activeId}
              aria-describedby="galaxy-search-hint"
              aria-disabled={!signedIn}
              value={preview.value}
              onCompositionStart={preview.onCompositionStart}
              onCompositionEnd={preview.onCompositionEnd}
              onFocus={preview.onFocus}
              onKeyDown={onSearchKeyDown}
              onChange={(event) => preview.setValue(event.target.value)}
            />
            {signedIn && hasValue ? (
              <button
                className="galaxy-search-clear"
                type="button"
                aria-label="清除搜索词"
                onClick={(event) => {
                  event.stopPropagation();
                  clear();
                }}
              >
                <Icon name="x" size={16} />
              </button>
            ) : (
              <kbd className="galaxy-search-kbd" aria-hidden="true">⌘K</kbd>
            )}
          </form>

          {signedIn && preview.open ? (
            <div
              className="galaxy-preview"
              id="galaxy-search-preview"
              role="listbox"
              aria-label="搜索结果预览"
            >
              {preview.status === "loading" ? (
                <p className="galaxy-preview-state">
                  <span className="spinner" aria-hidden="true" />
                  正在搜索…
                </p>
              ) : null}

              {preview.status === "error" ? (
                <p className="galaxy-preview-state">
                  搜索暂时不可用，按回车可以打开完整结果页。
                </p>
              ) : null}

              {preview.status === "empty" ? (
                <div className="galaxy-preview-state">
                  <strong>没有匹配的内容</strong>
                  <span>试试更短的关键词，或分类 / 标签名称。</span>
                </div>
              ) : null}

              {preview.status === "ready" ? (
                <>
                  <ul className="galaxy-preview-list">
                    {preview.items.map((item, index) => {
                      const title = buildHighlightSnippet(
                        null,
                        item.title,
                        item.highlightTerms.join(" "),
                        0,
                      );
                      const snippet = buildHighlightSnippet(
                        null,
                        item.snippet,
                        item.highlightTerms.join(" "),
                        120,
                      );

                      return (
                        <li
                          className={`galaxy-preview-item${index === preview.activeIndex ? " is-active" : ""}`}
                          id={`galaxy-preview-${index}`}
                          key={item.id}
                          role="option"
                          aria-selected={index === preview.activeIndex}
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => openObject(item.id)}
                        >
                          <span className="galaxy-preview-title">
                            {title.segments.map((segment, segmentIndex) =>
                              segment.strong ? (
                                <mark key={segmentIndex}>{segment.text}</mark>
                              ) : (
                                <span key={segmentIndex}>{segment.text}</span>
                              ),
                            )}
                          </span>

                          {snippet.segments.length > 0 ? (
                            <span className="galaxy-preview-snippet">
                              {snippet.segments.map((segment, segmentIndex) =>
                                segment.strong ? (
                                  <mark key={segmentIndex}>{segment.text}</mark>
                                ) : (
                                  <span key={segmentIndex}>{segment.text}</span>
                                ),
                              )}
                            </span>
                          ) : null}

                          <span className="galaxy-preview-meta">
                            <span>{objectTypeLabels[item.type]}</span>
                            <span>{libraryLabels[item.library]}</span>
                            {item.category ? (
                              <span>{categoryLabels[item.category] ?? item.category}</span>
                            ) : null}
                            {item.tags.slice(0, 3).map((tag) => (
                              <span className="galaxy-preview-tag" key={tag}>#{tag}</span>
                            ))}
                          </span>
                        </li>
                      );
                    })}
                  </ul>

                  <p className="galaxy-preview-foot">
                    <span>
                      共 {preview.total} 条{preview.truncated ? "（已截断）" : ""}
                      {preview.hint ? ` · ${preview.hint}` : ""}
                    </span>
                    <span>↑↓ 选择 · 回车查看全部</span>
                  </p>
                </>
              ) : null}
            </div>
          ) : null}
        </div>

        <p className="galaxy-search-hint" id="galaxy-search-hint">
          {signedIn
            ? "输入 2 个字开始预览 · 回车看完整结果 · Esc 关闭"
            : "登录后可检索内容，内容只在登录后显示"}
        </p>
      </section>

      {signedIn ? (
        <>
          <button
            ref={handleRef}
            type="button"
            className={`galaxy-handle${drawerOpen ? " is-open" : ""}`}
            aria-label="打开工作台菜单"
            aria-expanded={drawerOpen}
            aria-controls="galaxy-drawer"
            onClick={() => setDrawerOpen(true)}
          />

          <div
            className={`galaxy-overlay${drawerOpen ? " is-open" : ""}`}
            aria-hidden="true"
            onClick={() => setDrawerOpen(false)}
          />

          <aside
            ref={drawerRef}
            id="galaxy-drawer"
            className={`galaxy-drawer${drawerOpen ? " is-open" : ""}`}
            aria-hidden={!drawerOpen}
            aria-label="工作台菜单"
            inert={!drawerOpen}
          >
            <div className="galaxy-drawer-head">
              <span className="galaxy-brand-badge" aria-hidden="true">
                <GalaxyMark id="galaxy-mark-drawer" size={24} />
              </span>
              <strong>知产工作台</strong>
              <button
                type="button"
                className="galaxy-drawer-close"
                aria-label="关闭工作台菜单"
                onClick={() => setDrawerOpen(false)}
              >
                <Icon name="x" size={18} />
              </button>
            </div>

            <nav className="galaxy-drawer-nav" aria-label="工作台导航">
              {navItems.map((item) => (
                <Link className="galaxy-drawer-item" href={item.href} key={item.key}>
                  <Icon name={item.icon} size={20} />
                  <span>{item.label}</span>
                </Link>
              ))}
            </nav>

            <div className="galaxy-drawer-foot">
              <span className="galaxy-avatar" aria-hidden="true">
                {(userName ?? "已").slice(0, 1)}
              </span>
              <span className="galaxy-drawer-user">
                <strong>{userName ?? "已登录"}</strong>
                <small>本地保存</small>
              </span>
              {signOutHref ? (
                <a className="galaxy-drawer-signout" href={signOutHref} aria-label="退出登录" title="退出登录">
                  <Icon name="logout" size={18} />
                </a>
              ) : null}
            </div>
          </aside>
        </>
      ) : null}

      <p className="galaxy-footnote">内容保存在本机 · ⌘K 唤起搜索</p>
    </main>
  );
}
