"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { ContentPreviewDialog, type PreviewTarget } from "./content-preview-dialog";
import { Icon } from "./icon";

/**
 * 预览弹窗的唯一宿主（ADR-026 / 19_DESIGN_LLM_PREVIEW §3.1）。
 *
 * 列表与详情页只调 `open(objectId)`；弹窗本身、URL 参数与历史行为集中在这里，
 * 避免同一屏出现两个 dialog，也保证「后退关闭」只有一套实现。
 */

interface PreviewApi {
  /** detailHref：来源行的详情链接，保留当前筛选；没有就退回 `/workspace/<id>`。 */
  open: (objectId: string, refId?: string | null, detailHref?: string) => void;
}

const PreviewContext = createContext<PreviewApi | null>(null);

/** 不在宿主里（例如未来单独渲染的列表）时返回 null，调用方按普通链接处理。 */
export function usePreview(): PreviewApi | null {
  return useContext(PreviewContext);
}

export function PreviewProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<PreviewTarget | null>(null);
  /** 当前弹窗是不是由本页 pushState 打开的；决定关闭时用 back 还是 replaceState。 */
  const pushedRef = useRef(false);

  useEffect(() => {
    function readFromUrl() {
      const params = new URLSearchParams(window.location.search);
      const objectId = params.get("preview");
      setTarget(objectId ? { objectId, refId: params.get("file") } : null);
    }

    readFromUrl();
    window.addEventListener("popstate", readFromUrl);
    return () => window.removeEventListener("popstate", readFromUrl);
  }, []);

  const open = useCallback((objectId: string, refId: string | null = null, detailHref?: string) => {
    const url = new URL(window.location.href);
    url.searchParams.set("preview", objectId);
    if (refId) url.searchParams.set("file", refId);
    else url.searchParams.delete("file");

    window.history.pushState({ preview: true }, "", url);
    pushedRef.current = true;
    setTarget({ objectId, refId, detailHref });
  }, []);

  const close = useCallback(() => {
    setTarget(null);

    if (!pushedRef.current) {
      // 深链（刷新或别人发来的链接）：只清参数，不制造一条多余历史。
      const url = new URL(window.location.href);
      url.searchParams.delete("preview");
      url.searchParams.delete("file");
      window.history.replaceState(null, "", url);
      return;
    }

    pushedRef.current = false;
    window.history.back();
  }, []);

  /** 去详情页等导航前调用：清参数但不回退，否则会把即将发生的跳转撤掉。 */
  const dismiss = useCallback(() => {
    pushedRef.current = false;
    setTarget(null);

    const url = new URL(window.location.href);
    url.searchParams.delete("preview");
    url.searchParams.delete("file");
    window.history.replaceState(null, "", url);
  }, []);

  const api = useMemo<PreviewApi>(() => ({ open }), [open]);

  return (
    <PreviewContext.Provider value={api}>
      {children}
      <ContentPreviewDialog target={target} onClose={close} onDismiss={dismiss} />
    </PreviewContext.Provider>
  );
}

/** 详情页头部的「预览」入口。 */
export function PreviewButton({
  objectId,
  label = "预览",
}: {
  objectId: string;
  label?: string;
}) {
  const preview = usePreview();
  if (!preview) return null;

  return (
    <button
      className="btn btn-secondary preview-trigger"
      type="button"
      onClick={() => preview.open(objectId)}
    >
      <Icon name="file" size={15} />
      {label}
    </button>
  );
}
