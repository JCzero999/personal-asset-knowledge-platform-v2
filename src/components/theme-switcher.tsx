"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";

import {
  applyTheme,
  DEFAULT_THEME,
  THEME_META,
  normalizeTheme,
  type ThemeId,
} from "@/lib/theme";

import { Icon } from "./icon";

/**
 * 把 `<html data-theme>` 当作外部存储：首帧内联脚本先写、`applyTheme` 后写，
 * 两者都会触发下面的 MutationObserver，组件不需要自己再存一份状态。
 */
function subscribeTheme(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-theme"],
  });
  return () => observer.disconnect();
}

function readThemeSnapshot(): ThemeId {
  return normalizeTheme(document.documentElement.getAttribute("data-theme"));
}

/**
 * 账户与主题菜单（设计稿 §3.5）。
 *
 * 两个入口共用同一份实现：
 * - `rail`：左侧图标栏底部的用户头像；
 * - `home`：首页右上角头像，弹层继续使用首页的暖金 token，不随工作台主题变绿。
 *
 * 键盘：Tab 在面板内循环，方向键在 2×2 网格里移动并即时应用，Enter 应用，
 * Esc 关闭并把焦点还给触发按钮；点击面板外关闭。
 */
export function ThemeSwitcher({
  variant,
  userName,
  userEmail = null,
  isAdmin = false,
  signOutHref = null,
}: {
  variant: "rail" | "home";
  userName: string;
  userEmail?: string | null;
  isAdmin?: boolean;
  signOutHref?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const theme = useSyncExternalStore(subscribeTheme, readThemeSnapshot, () => DEFAULT_THEME);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const panelId = useId();
  const labelId = useId();

  useEffect(() => {
    if (!open) return;

    const selectedIndex = Math.max(
      0,
      THEME_META.findIndex((item) => item.id === theme),
    );
    optionRefs.current[selectedIndex]?.focus();

    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
        return;
      }

      if (event.key !== "Tab" || !panelRef.current) return;
      const focusables = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (focusables.length === 0) return;
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
    return () => document.removeEventListener("keydown", onKeyDown);
    // theme 只用于决定打开时的初始焦点。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function close() {
    setOpen(false);
    triggerRef.current?.focus();
  }

  function choose(id: ThemeId) {
    applyTheme(id);
  }

  function onOptionKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const last = THEME_META.length - 1;
    let next: number | null = null;

    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = index === last ? 0 : index + 1;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = index === 0 ? last : index - 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = last;
    else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      choose(THEME_META[index].id);
      return;
    }

    if (next === null) return;
    event.preventDefault();
    optionRefs.current[next]?.focus();
    choose(THEME_META[next].id);
  }

  return (
    <div className={`theme-switch theme-switch--${variant}${open ? " is-open" : ""}`}>
      <button
        ref={triggerRef}
        type="button"
        className={`theme-switch-trigger theme-switch-trigger--${variant}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={`${userName}，打开账户与主题菜单`}
        title={`${userName}${userEmail ? ` · ${userEmail}` : ""}`}
        onClick={() => setOpen((value) => !value)}
      >
        {variant === "home" ? (
          <span className="galaxy-avatar" aria-hidden="true">{userName.slice(0, 1)}</span>
        ) : (
          <span className="rail-avatar" aria-hidden="true">{userName.slice(0, 1)}</span>
        )}
      </button>

      {open ? (
        <div
          className="theme-switch-layer"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) close();
          }}
        >
          <div
            ref={panelRef}
            id={panelId}
            className="theme-switch-panel"
            role="dialog"
            aria-modal="false"
            aria-label="账户与主题"
          >
            <div className="theme-switch-id">
              <span className="theme-switch-avatar" aria-hidden="true">
                {userName.slice(0, 1)}
              </span>
              <span className="theme-switch-user">
                <strong>{userName}</strong>
                <small>{userEmail ?? "本地账号"}</small>
              </span>
            </div>

            <div className="theme-switch-divider" role="presentation" />

            <p className="theme-switch-label" id={labelId}>主题</p>
            <div className="theme-switch-grid" role="radiogroup" aria-labelledby={labelId}>
              {THEME_META.map((item, index) => {
                const checked = item.id === theme;
                return (
                  <button
                    key={item.id}
                    ref={(node) => { optionRefs.current[index] = node; }}
                    type="button"
                    role="radio"
                    aria-checked={checked}
                    tabIndex={checked ? 0 : -1}
                    className={`theme-option${checked ? " is-checked" : ""}`}
                    onClick={() => choose(item.id)}
                    onKeyDown={(event) => onOptionKeyDown(event, index)}
                  >
                    <span className="theme-option-dots" data-theme={item.id} aria-hidden="true">
                      <i className="theme-option-dot--bg" />
                      <i className="theme-option-dot--surface" />
                      <i className="theme-option-dot--accent" />
                      <i className="theme-option-dot--text" />
                    </span>
                    <span className="theme-option-name">{item.name}</span>
                    {checked ? (
                      <span className="theme-option-check" aria-hidden="true">
                        <Icon name="check" size={14} />
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>

            {isAdmin || signOutHref ? (
              <div className="theme-switch-divider" role="presentation" />
            ) : null}

            <div className="theme-switch-links">
              {isAdmin ? (
                <Link className="theme-switch-link" href="/admin/vocabulary/tags">
                  <Icon name="settings" size={16} />
                  词表管理
                </Link>
              ) : null}
              {signOutHref ? (
                <a className="theme-switch-link" href={signOutHref}>
                  <Icon name="logout" size={16} />
                  退出登录
                </a>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
