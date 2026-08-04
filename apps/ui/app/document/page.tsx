"use client";
import * as React from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  getStatus,
  getPageInfo,
  getPreflight,
  getBlocks,
  getPageText,
  getReaderAnnotations,
  createReaderAnnotation,
  deleteReaderAnnotation,
  getLog,
  getRepairRequests,
  pageImg,
  saveReadingBookmark,
  submitRepairRequest,
  translateReaderSelection,
  updateBlock,
} from "../../lib/api";
import { useToast, useChat, useEngine } from "../../components/Providers";
import { IconBookmark, IconChat } from "../../components/icons";
import {
  clampReaderSplitRatio,
  clampReaderZoom,
  readerSplitRatioFromPointer,
  READER_SPLIT_CENTER,
  READER_SPLIT_MAX,
  READER_SPLIT_MIN,
  READER_ZOOM_MAX,
  READER_ZOOM_MIN,
  readerZoomFromWheel,
  setReaderPaneZoom,
  validReaderPage,
  type ReaderZoomBySide,
} from "../../lib/reader-page";
import {
  buildAskAiDraft,
  MAX_SELECTED_TEXT_LENGTH,
  normalizeSelectedText,
  normalizeSelectionRects,
  capSelectedText,
  positionSelectionMenu,
  type NumericRect,
  type SelectionMenuPosition,
} from "../../lib/reader-selection";
import { useStatus } from "../../lib/useStatus";
import type {
  BlockReport,
  DocumentBlock,
  PageInfo,
  PreflightReport,
  RepairRequest,
  RepairRequestKind,
  ReaderAnnotation,
  ReaderAnnotationKind,
  ReaderAnnotationRect,
  ReaderAnnotationSide,
  ReaderTextPage,
} from "../../lib/types";

export default function DocumentPage() {
  // useSearchParams must be inside Suspense for static export.
  return (
    <React.Suspense fallback={<div className="page">Đang tải…</div>}>
      <Reader />
    </React.Suspense>
  );
}

type ViewMode = "split" | "original" | "translated";
type ReaderSide = ReaderAnnotationSide;

interface ActiveSelection {
  text: string;
  side: ReaderSide;
  rects: ReaderAnnotationRect[];
  anchor: {
    left: number;
    top: number;
    right: number;
    bottom: number;
  };
  pointer?: { x: number; y: number };
}

interface PageSelectionPayload {
  text: string;
  side: ReaderSide;
  rects: ReaderAnnotationRect[];
  menuRect: NumericRect;
  pointer?: { x: number; y: number };
}

interface SelectionTranslationState {
  sourceText: string;
  translatedText: string;
  targetLanguage: "en" | "vi";
  detectedLanguage: string | null;
  status: "loading" | "success" | "error";
  error: string;
}

const REPAIR_OPTIONS: { value: RepairRequestKind; label: string }[] = [
  { value: "translation", label: "Dịch lại nội dung" },
  { value: "layout", label: "Lệch / tràn layout" },
  { value: "formula", label: "Công thức có vấn đề" },
  { value: "table", label: "Bảng có vấn đề" },
  { value: "other", label: "Vấn đề khác" },
];

const REPAIR_KIND_LABEL = Object.fromEntries(
  REPAIR_OPTIONS.map((option) => [option.value, option.label])
) as Record<RepairRequestKind, string>;

const REPAIR_STATUS_LABEL: Record<RepairRequest["status"], string> = {
  running: "Đang xử lý",
  completed: "Đã chạy lại",
  failed: "Có lỗi",
};

function findLocalEnglishVoice(
  voices: readonly SpeechSynthesisVoice[]
): SpeechSynthesisVoice | null {
  const englishVoices = voices.filter(
    (voice) => voice.localService && /^en(?:-|$)/i.test(voice.lang)
  );
  return englishVoices.find(
    (voice) => voice.default && voice.lang.toLowerCase() === "en-us"
  ) || englishVoices.find(
    (voice) => voice.lang.toLowerCase() === "en-us"
  ) || englishVoices.find(
    (voice) => voice.default
  ) || englishVoices[0] || null;
}

function Reader() {
  const sp = useSearchParams();
  const toast = useToast();
  const { openChat, closeChat, open: chatOpen } = useChat();
  const { engine } = useEngine();
  const status = useStatus(2000);
  const [tag, setTag] = React.useState<string | null>(sp.get("tag"));
  const [info, setInfo] = React.useState<PageInfo | null>(null);
  const [preflight, setPreflight] = React.useState<PreflightReport | null>(null);
  const [cur, setCur] = React.useState(1);
  const [pageInput, setPageInput] = React.useState("1");
  const [bookmarkPage, setBookmarkPage] = React.useState<number | null>(null);
  const [bookmarkSaving, setBookmarkSaving] = React.useState(false);
  const [mode, setMode] = React.useState<ViewMode>("split");
  const [splitRatio, setSplitRatio] = React.useState(READER_SPLIT_CENTER);
  const [blockEditMode, setBlockEditMode] = React.useState(false);
  const [blockReport, setBlockReport] = React.useState<BlockReport | null>(null);
  const [selectedBlock, setSelectedBlock] = React.useState<DocumentBlock | null>(null);
  const [blockDrafts, setBlockDrafts] = React.useState<Record<string, string>>({});
  const [blockSaveError, setBlockSaveError] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [savingSeconds, setSavingSeconds] = React.useState(0);
  const [renderVersion, setRenderVersion] = React.useState(0);
  const [repairOpen, setRepairOpen] = React.useState(false);
  const [repairKind, setRepairKind] = React.useState<RepairRequestKind>("translation");
  const [repairNote, setRepairNote] = React.useState("");
  const [repairSubmitting, setRepairSubmitting] = React.useState(false);
  const [repairRequests, setRepairRequests] = React.useState<RepairRequest[]>([]);
  const [textPages, setTextPages] = React.useState<Partial<Record<ReaderSide, ReaderTextPage>>>({});
  const [annotations, setAnnotations] = React.useState<ReaderAnnotation[]>([]);
  const [selection, setSelection] = React.useState<ActiveSelection | null>(null);
  const [noteDraft, setNoteDraft] = React.useState("");
  const [noteOpen, setNoteOpen] = React.useState(false);
  const [annotationBusy, setAnnotationBusy] = React.useState(false);
  const [selectionTranslation, setSelectionTranslation] = React.useState<SelectionTranslationState | null>(null);
  const [selectionMenuPosition, setSelectionMenuPosition] = React.useState<SelectionMenuPosition | null>(null);
  const [isFullscreen, setIsFullscreen] = React.useState(false);
  const [viewerZoom, setViewerZoom] = React.useState<ReaderZoomBySide>({
    source: 1,
    translated: 1,
  });
  const repairStatuses = React.useRef<Map<string, RepairRequest["status"]>>(new Map());
  const localEnglishVoice = React.useRef<SpeechSynthesisVoice | null>(null);
  const selectionMenuRef = React.useRef<HTMLDivElement>(null);
  const readerRef = React.useRef<HTMLDivElement>(null);
  const translationRequest = React.useRef<AbortController | null>(null);

  const volumeStatus = status?.volumes.find((volume) => volume.tag === tag);
  const volumeRunning = !!volumeStatus?.running;
  const runningRepair = repairRequests.find((request) => request.status === "running") || null;
  const documentBusy = volumeRunning || !!runningRepair || repairSubmitting || saving;

  const cancelSelectionTranslation = React.useCallback(() => {
    translationRequest.current?.abort();
    translationRequest.current = null;
    setSelectionTranslation(null);
  }, []);

  React.useEffect(() => {
    document.body.classList.add("reader-route");
    return () => {
      translationRequest.current?.abort();
      document.body.classList.remove("reader-route", "reader-fullscreen");
    };
  }, []);

  React.useEffect(() => {
    if (!("speechSynthesis" in window)) return;
    const synthesizer = window.speechSynthesis;
    const refreshVoice = () => {
      localEnglishVoice.current = findLocalEnglishVoice(synthesizer.getVoices());
    };
    refreshVoice();
    synthesizer.addEventListener("voiceschanged", refreshVoice);
    return () => {
      synthesizer.removeEventListener("voiceschanged", refreshVoice);
      synthesizer.cancel();
      localEnglishVoice.current = null;
    };
  }, []);

  React.useEffect(() => {
    const syncFullscreen = () => {
      setIsFullscreen(document.fullscreenElement === document.documentElement);
    };
    syncFullscreen();
    document.addEventListener("fullscreenchange", syncFullscreen);
    return () => document.removeEventListener("fullscreenchange", syncFullscreen);
  }, []);

  React.useEffect(() => {
    document.body.classList.toggle("reader-fullscreen", isFullscreen);
    return () => document.body.classList.remove("reader-fullscreen");
  }, [isFullscreen]);

  const acceptRepairSnapshot = React.useCallback((requests: RepairRequest[]) => {
    const previous = repairStatuses.current;
    const justCompleted = previous.size > 0 && requests.some(
      (request) => request.status === "completed" && previous.get(request.id) === "running"
    );
    const completedHistoryLoaded = previous.size === 0 && requests.some(
      (request) => request.status === "completed"
    );
    repairStatuses.current = new Map(requests.map((request) => [request.id, request.status]));
    setRepairRequests(requests);
    if (justCompleted || completedHistoryLoaded) setRenderVersion((version) => version + 1);
  }, []);

  // Resolve a tag (fall back to first done/available volume) then load info.
  React.useEffect(() => {
    let alive = true;
    (async () => {
      let t = sp.get("tag");
      if (!t) {
        try {
          const s = await getStatus();
          const done =
            s.volumes.filter((v) => !v.skip && v.stage === "done")[0] ||
            s.volumes.filter((v) => !v.skip)[0];
          t = done?.tag || null;
        } catch {
          /* ignore */
        }
      }
      if (!alive) return;
      setTag(t);
      setInfo(null);
      setPreflight(null);
      setBookmarkPage(null);
      setBlockEditMode(false);
      setSelectedBlock(null);
      setBlockDrafts({});
      setBlockSaveError("");
      setRepairRequests([]);
      repairStatuses.current = new Map();
      if (!t) {
        toast("Không có tài liệu");
        return;
      }
      try {
        const i = await getPageInfo(t);
        if (alive) {
          const savedPage = validReaderPage(i.bookmark_page, Math.max(1, i.pages || 1));
          const firstPage = savedPage || 1;
          setInfo(i);
          setBookmarkPage(savedPage);
          setCur(firstPage);
          setPageInput(String(firstPage));
        }
      } catch (e) {
        toast("Lỗi: " + (e as Error).message);
      }
      try {
        const p = await getPreflight(t);
        if (alive) setPreflight(p);
      } catch {
        if (alive) setPreflight(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [sp, toast]);

  React.useEffect(() => {
    if (!tag || !info?.out_exists) return;
    let alive = true;
    let inFlight = false;
    const refresh = () => {
      if (inFlight) return;
      inFlight = true;
      getRepairRequests(tag)
        .then(({ requests }) => {
          if (alive) acceptRepairSnapshot(requests);
        })
        .catch(() => {})
        .finally(() => {
          inFlight = false;
        });
    };
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [tag, info?.out_exists, acceptRepairSnapshot]);

  React.useEffect(() => {
    if (!tag || !info?.out_exists) {
      setBlockReport(null);
      setSelectedBlock(null);
      return;
    }
    let alive = true;
    getBlocks(tag, cur - 1)
      .then((report) => {
        if (!alive) return;
        setBlockReport(report);
        setSelectedBlock((old) => (
          old ? report.blocks.find((block) => block.id === old.id) || null : null
        ));
        setBlockSaveError("");
      })
      .catch(() => {
        // Older/incomplete runs have no report yet; the PDF reader remains useful.
        if (alive) {
          setBlockReport(null);
          setSelectedBlock(null);
        }
      });
    return () => {
      alive = false;
    };
  }, [tag, cur, info?.out_exists, renderVersion]);

  React.useEffect(() => {
    if (!saving) {
      setSavingSeconds(0);
      return;
    }
    setSavingSeconds(0);
    const timer = window.setInterval(() => {
      setSavingSeconds((seconds) => seconds + 1);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [saving]);

  React.useEffect(() => {
    if (!tag || !info) {
      setTextPages({});
      return;
    }
    const sides: ReaderSide[] = mode === "original"
      ? ["source"]
      : mode === "translated"
        ? ["translated"]
        : ["source", "translated"];
    let alive = true;
    setTextPages({});
    Promise.all(
      sides.map(async (side) => {
        try {
          return [side, await getPageText(tag, cur, side)] as const;
        } catch {
          return [side, null] as const;
        }
      })
    ).then((entries) => {
      if (!alive) return;
      setTextPages(
        Object.fromEntries(entries.filter((entry): entry is [ReaderSide, ReaderTextPage] => !!entry[1]))
      );
    });
    return () => {
      alive = false;
    };
  }, [tag, cur, mode, info?.out_exists, renderVersion]);

  React.useEffect(() => {
    if (!tag || !info) {
      cancelSelectionTranslation();
      setSelection(null);
      setNoteDraft("");
      setNoteOpen(false);
      setAnnotations([]);
      return;
    }
    let alive = true;
    cancelSelectionTranslation();
    setSelection(null);
    setNoteDraft("");
    setNoteOpen(false);
    getReaderAnnotations(tag, cur)
      .then(({ annotations: next }) => {
        if (alive) setAnnotations(next);
      })
      .catch(() => {
        if (alive) setAnnotations([]);
      });
    return () => {
      alive = false;
    };
  }, [tag, cur, info, cancelSelectionTranslation]);

  const total = Math.max(1, info?.pages || 1);
  const goToPage = (page: number) => {
    const next = validReaderPage(page, total);
    if (!next) return;
    setSelectedBlock(null);
    setBlockSaveError("");
    setCur(next);
    setPageInput(String(next));
  };

  const clearBrowserSelection = React.useCallback(() => {
    const current = window.getSelection();
    if (current && !current.isCollapsed) current.removeAllRanges();
  }, []);

  const onPageSelection = React.useCallback((payload: PageSelectionPayload) => {
    const text = normalizeSelectedText(payload.text);
    if (!text || !payload.rects.length) return;
    const anchor = {
      left: payload.menuRect.left,
      top: payload.menuRect.top,
      right: payload.menuRect.right ?? payload.menuRect.left,
      bottom: payload.menuRect.bottom ?? payload.menuRect.top + 24,
    };
    cancelSelectionTranslation();
    setSelectionMenuPosition(null);
    setNoteDraft("");
    setNoteOpen(false);
    setSelection({
      text,
      side: payload.side,
      rects: payload.rects,
      anchor,
      pointer: payload.pointer,
    });
  }, [cancelSelectionTranslation]);

  const dismissSelection = React.useCallback(() => {
    cancelSelectionTranslation();
    setSelection(null);
    setNoteDraft("");
    setNoteOpen(false);
    clearBrowserSelection();
  }, [cancelSelectionTranslation, clearBrowserSelection]);

  const updatePaneZoom = React.useCallback((
    side: ReaderSide,
    next: React.SetStateAction<number>
  ) => {
    setViewerZoom((current) => setReaderPaneZoom(
      current,
      side,
      typeof next === "function" ? next(current[side]) : next
    ));
  }, []);

  React.useEffect(() => {
    dismissSelection();
  }, [dismissSelection, mode, renderVersion]);

  React.useLayoutEffect(() => {
    if (!selection || !selectionMenuRef.current) return;
    const positionMenu = () => {
      const menu = selectionMenuRef.current;
      if (!menu) return;
      const rect = menu.getBoundingClientRect();
      const next = positionSelectionMenu({
        anchor: selection.anchor,
        pointer: selection.pointer,
        menu: {
          width: rect.width,
          height: Math.max(rect.height, menu.scrollHeight),
        },
        viewport: { width: window.innerWidth, height: window.innerHeight },
      });
      setSelectionMenuPosition((current) =>
        current &&
          current.left === next.left &&
          current.top === next.top &&
          current.maxHeight === next.maxHeight &&
          current.placement === next.placement
          ? current
          : next
      );
    };
    positionMenu();
    const observer = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(positionMenu);
    observer?.observe(selectionMenuRef.current);
    window.addEventListener("resize", positionMenu);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", positionMenu);
    };
  }, [noteOpen, selection, selectionTranslation]);

  React.useEffect(() => {
    if (!selection) return;
    const dismissOutside = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (target?.closest(".reader-selection-menu")) return;
      if (target?.closest("[data-reader-text-layer]")) return;
      dismissSelection();
    };
    const dismissOnScroll = (event: Event) => {
      const target = event.target;
      if (target instanceof Node && selectionMenuRef.current?.contains(target)) return;
      dismissSelection();
    };
    document.addEventListener("mousedown", dismissOutside);
    document.addEventListener("scroll", dismissOnScroll, true);
    return () => {
      document.removeEventListener("mousedown", dismissOutside);
      document.removeEventListener("scroll", dismissOnScroll, true);
    };
  }, [dismissSelection, selection]);

  const saveSelectionAnnotation = React.useCallback(async (kind: ReaderAnnotationKind) => {
    if (!tag || !selection || annotationBusy) return;
    const note = noteDraft.trim();
    if (kind === "note" && !note) {
      toast("Nhập ghi chú trước khi lưu");
      return;
    }
    setAnnotationBusy(true);
    try {
      const result = await createReaderAnnotation({
        tag,
        page: cur,
        side: selection.side,
        kind,
        text: selection.text,
        note,
        rects: selection.rects,
      });
      setAnnotations((old) => [result.annotation, ...old.filter((item) => item.id !== result.annotation.id)]);
      toast(kind === "note" ? "Đã lưu ghi chú" : "Đã đánh dấu đoạn văn");
      dismissSelection();
    } catch (error) {
      toast("Không lưu được: " + (error as Error).message);
    } finally {
      setAnnotationBusy(false);
    }
  }, [annotationBusy, cur, dismissSelection, noteDraft, selection, tag, toast]);

  const askAboutSelection = React.useCallback(() => {
    if (!tag || !info || !selection) return;
    openChat(
      { tag, display: info.display, pages: info.pages },
      buildAskAiDraft(selection.text, cur, selection.side)
    );
    dismissSelection();
  }, [cur, dismissSelection, info, openChat, selection, tag]);

  const translateCurrentSelection = React.useCallback(async () => {
    if (!selection || selectionTranslation?.status === "loading") return;
    translationRequest.current?.abort();
    const controller = new AbortController();
    translationRequest.current = controller;
    const sourceText = capSelectedText(selection.text, MAX_SELECTED_TEXT_LENGTH);
    const targetLanguage = selection.side === "source" ? "vi" : "en";
    setSelectionTranslation({
      sourceText,
      translatedText: "",
      targetLanguage,
      detectedLanguage: null,
      status: "loading",
      error: "",
    });
    try {
      const result = await translateReaderSelection(sourceText, targetLanguage, controller.signal);
      if (controller.signal.aborted) return;
      setSelectionTranslation({
        sourceText,
        translatedText: result.translation,
        targetLanguage: result.target_language,
        detectedLanguage: result.detected_language,
        status: "success",
        error: "",
      });
    } catch (error) {
      if (controller.signal.aborted) return;
      setSelectionTranslation({
        sourceText,
        translatedText: "",
        targetLanguage,
        detectedLanguage: null,
        status: "error",
        error: (error as Error).message || "Google Dịch tạm thời không phản hồi",
      });
    } finally {
      if (translationRequest.current === controller) translationRequest.current = null;
    }
  }, [selection, selectionTranslation?.status]);

  const readSelection = React.useCallback(() => {
    if (!selection) return;
    if (!("speechSynthesis" in window) || typeof SpeechSynthesisUtterance === "undefined") {
      toast("Thiết bị này không hỗ trợ đọc văn bản");
      return;
    }
    const text = selection.text;
    if (!text) return;
    const synthesizer = window.speechSynthesis;
    const voice = localEnglishVoice.current || findLocalEnglishVoice(synthesizer.getVoices());
    if (!voice) {
      toast("Chưa có giọng tiếng Anh offline. Hãy cài trong System Settings → Accessibility → Spoken Content");
      return;
    }
    localEnglishVoice.current = voice;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.voice = voice;
    utterance.lang = voice.lang;
    utterance.rate = 0.85;
    utterance.pitch = 1;
    utterance.volume = 1;
    synthesizer.cancel();
    synthesizer.speak(utterance);
    dismissSelection();
  }, [dismissSelection, selection, toast]);

  const removeAnnotation = React.useCallback(async (id: string) => {
    if (!tag) return;
    try {
      await deleteReaderAnnotation(tag, id);
      setAnnotations((old) => old.filter((item) => item.id !== id));
      toast("Đã xóa đánh dấu");
    } catch (error) {
      toast("Không xóa được: " + (error as Error).message);
    }
  }, [tag, toast]);

  const toggleFullscreen = React.useCallback(async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      toast("Màn hình hiện tại không hỗ trợ chế độ toàn màn");
    }
  }, [toast]);

  // Page navigation updates the image immediately; never leave the previous
  // page's overlay/editor active while the next block report is loading.
  const currentBlockReport = blockReport?.tag === tag && blockReport.page === cur - 1
    ? blockReport
    : null;
  const blocks = currentBlockReport?.blocks || [];
  const selectedBlockIndex = selectedBlock
    ? blocks.findIndex((block) => block.id === selectedBlock.id)
    : -1;
  const draft = selectedBlock
    ? blockDrafts[selectedBlock.id] ?? selectedBlock.translation
    : "";
  const blockDirty = !!selectedBlock && draft.trim() !== selectedBlock.translation.trim();
  const selectBlock = (block: DocumentBlock) => {
    if (!blockEditMode || saving) return;
    setSelectedBlock(block);
    setBlockSaveError("");
  };
  const toggleBlockEditMode = () => {
    if (saving) return;
    dismissSelection();
    setSelectedBlock(null);
    setBlockSaveError("");
    setBlockEditMode((active) => !active);
  };
  const moveSplitDivider = (clientX: number, dividerWidth: number) => {
    const reader = readerRef.current;
    if (!reader) return;
    const rect = reader.getBoundingClientRect();
    setSplitRatio(readerSplitRatioFromPointer(clientX, rect.left, rect.width, dividerWidth));
  };

  if (!info || !tag) {
    return <div className="page">Đang tải…</div>;
  }

  return (
    <div className="document-reader-root">
      <div className="topbar">
        <div>
          <h1>{info.display}</h1>
          <div className="sub">
            {info.pages} trang{info.out_exists ? "" : " · chưa có bản dịch"}
          </div>
        </div>
        <span className="spacer" />
        <div className="row" style={{ gap: "var(--space-2)" }}>
          {(["split", "original", "translated"] as ViewMode[]).map((m) => (
            <button
              key={m}
              className={"btn btn-sm " + (mode === m ? "btn-secondary" : "btn-ghost")}
              onClick={() => setMode(m)}
              aria-pressed={mode === m}
            >
              {m === "split" ? "Cả hai" : m === "original" ? "Gốc" : "Dịch"}
            </button>
          ))}
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => chatOpen ? closeChat() : openChat({ tag, display: info.display, pages: info.pages })}
          >
            <IconChat /> {chatOpen ? "Ẩn chat" : "Chat AI"}
          </button>
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => void toggleFullscreen()}
            aria-pressed={isFullscreen}
            title={isFullscreen ? "Thoát chế độ toàn màn hình (Esc)" : "Mở chế độ toàn màn hình"}
          >
            {isFullscreen ? "⤢ Thoát" : "⛶ Toàn màn"}
          </button>
        </div>
      </div>

      <div className="page stack-4 reader-page-content">
        {preflight && preflight.document_mode !== "native" && (
          <div className="card" style={{ borderColor: "#d97706" }}>
            <strong>Preflight: tài liệu không hoàn toàn là PDF text native.</strong>
            <p className="muted" style={{ marginTop: 6 }}>
              {preflight.document_mode === "scanned"
                ? "Một hoặc nhiều trang là scan/ảnh. MVP hiện giữ an toàn và yêu cầu OCR có bounding box trước khi dịch."
                : "Có trang scan hoặc vùng ảnh lớn; hãy kiểm tra thủ công trước khi chạy pipeline."}
            </p>
          </div>
        )}
        <div className="row-between wrap">
          <div className="row wrap" style={{ gap: "var(--space-2)" }}>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={cur <= 1}
              onClick={() => goToPage(cur - 1)}
            >
              ‹ Trước
            </button>
            <form
              className="row"
              style={{ gap: "var(--space-2)" }}
              noValidate
              onSubmit={(event) => {
                event.preventDefault();
                const page = validReaderPage(pageInput, total);
                if (!page) {
                  toast(`Nhập số trang từ 1 đến ${total}`);
                  setPageInput(String(cur));
                  return;
                }
                goToPage(page);
              }}
            >
              <label className="muted" htmlFor="reader-page-input">
                Trang
              </label>
              <input
                id="reader-page-input"
                className="input num"
                type="number"
                inputMode="numeric"
                min={1}
                max={total}
                step={1}
                value={pageInput}
                onChange={(event) => setPageInput(event.target.value)}
                aria-label={`Đi đến trang, từ 1 đến ${total}`}
                style={{ width: 72, padding: "6px 8px" }}
              />
              <span className="num muted">/ {total}</span>
              <button type="submit" className="btn btn-secondary btn-sm">
                Đi
              </button>
            </form>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={cur >= total}
              onClick={() => goToPage(cur + 1)}
            >
              Sau ›
            </button>
          </div>
          <div className="row wrap" style={{ gap: "var(--space-2)" }}>
            {bookmarkPage && bookmarkPage !== cur && (
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => goToPage(bookmarkPage)}
              >
                Đọc tiếp · trang {bookmarkPage}
              </button>
            )}
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={bookmarkSaving || bookmarkPage === cur}
              onClick={async () => {
                setBookmarkSaving(true);
                try {
                  const saved = await saveReadingBookmark(tag, cur);
                  const page = validReaderPage(saved.bookmark_page, total);
                  if (!page) throw new Error("daemon trả về trang không hợp lệ");
                  setBookmarkPage(page);
                  toast(`Đã đánh dấu trang ${page}`);
                } catch (error) {
                  toast("Không lưu được dấu đọc: " + (error as Error).message);
                } finally {
                  setBookmarkSaving(false);
                }
              }}
            >
              <IconBookmark fill={bookmarkPage === cur ? "currentColor" : "none"} />
              {bookmarkSaving
                ? "Đang lưu…"
                : bookmarkPage === cur
                  ? "Đã đánh dấu trang này"
                : "Đánh dấu trang này"}
            </button>
            <button
              type="button"
              className={"btn btn-sm " + (repairOpen ? "btn-primary" : "btn-secondary")}
              disabled={!info.out_exists}
              onClick={() => setRepairOpen((open) => !open)}
            >
              Yêu cầu xử lý trang {cur}
            </button>
          </div>
        </div>

        <div
          ref={readerRef}
          className={"reader reader-" + mode}
          style={mode === "split" ? {
            "--reader-left": `${splitRatio}fr`,
            "--reader-right": `${100 - splitRatio}fr`,
          } as React.CSSProperties : undefined}
        >
          {mode !== "translated" && (
            <ReaderPageCanvas
              key="source"
              cap={"English · trang " + cur}
              side="source"
              zoom={viewerZoom.source}
              onZoomChange={updatePaneZoom}
              src={pageImg(tag, "source", cur - 1)}
              textPage={textPages.source || null}
              annotations={annotations}
              report={mode === "split" ? currentBlockReport : null}
              selectedId={mode === "split" && blockEditMode ? selectedBlock?.id || null : null}
              onSelect={mode === "split" && blockEditMode ? selectBlock : undefined}
              blockEditMode={mode === "split" && blockEditMode}
              blockEditModeDisabled={saving}
              onSelectionReset={dismissSelection}
              onSelection={onPageSelection}
            />
          )}
          {mode === "split" && (
            <div className="reader-split-divider">
              <button
                type="button"
                className="reader-split-reset"
                disabled={splitRatio === READER_SPLIT_CENTER}
                onClick={() => setSplitRatio(READER_SPLIT_CENTER)}
                aria-label="Cân hai tài liệu về giữa"
                title="Cân hai tài liệu về 50 / 50"
              >
                ↔
              </button>
              <div
                className="reader-split-handle"
                role="separator"
                tabIndex={0}
                aria-orientation="vertical"
                aria-label="Đổi độ rộng bản gốc và bản dịch"
                aria-valuemin={READER_SPLIT_MIN}
                aria-valuemax={READER_SPLIT_MAX}
                aria-valuenow={Math.round(splitRatio)}
                aria-valuetext={`Bản gốc ${Math.round(splitRatio)}%, bản dịch ${Math.round(100 - splitRatio)}%`}
                onPointerDown={(event) => {
                  event.currentTarget.setPointerCapture(event.pointerId);
                  moveSplitDivider(event.clientX, event.currentTarget.parentElement?.getBoundingClientRect().width || 0);
                }}
                onPointerMove={(event) => {
                  if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
                  moveSplitDivider(event.clientX, event.currentTarget.parentElement?.getBoundingClientRect().width || 0);
                }}
                onPointerUp={(event) => {
                  if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                    event.currentTarget.releasePointerCapture(event.pointerId);
                  }
                }}
                onKeyDown={(event) => {
                  const step = event.shiftKey ? 10 : 2;
                  let next: number | null = null;
                  if (event.key === "ArrowLeft") next = splitRatio - step;
                  else if (event.key === "ArrowRight") next = splitRatio + step;
                  else if (event.key === "Home") next = READER_SPLIT_MIN;
                  else if (event.key === "End") next = READER_SPLIT_MAX;
                  if (next === null) return;
                  event.preventDefault();
                  setSplitRatio(clampReaderSplitRatio(next));
                }}
              />
            </div>
          )}
          {mode !== "original" &&
            (info.out_exists ? (
              <ReaderPageCanvas
                key="translated"
                cap={"Tiếng Việt · trang " + cur}
                side="translated"
                accent
                zoom={viewerZoom.translated}
                onZoomChange={updatePaneZoom}
                src={pageImg(tag, "out", cur - 1) + (renderVersion ? `&v=${renderVersion}` : "")}
                textPage={textPages.translated || null}
                annotations={annotations}
                report={currentBlockReport}
                selectedId={blockEditMode ? selectedBlock?.id || null : null}
                onSelect={blockEditMode ? selectBlock : undefined}
                blockEditMode={blockEditMode}
                blockEditModeDisabled={saving}
                onBlockEditModeToggle={toggleBlockEditMode}
                onSelectionReset={dismissSelection}
                onSelection={onPageSelection}
              />
            ) : (
              <div className="page-sheet">
                <div className="sheet-cap" style={{ color: "var(--accent)" }}>
                  Tiếng Việt
                </div>
                <p className="muted">
                  Chưa có bản dịch cho cuốn này. Dịch ở trang{" "}
                  <Link href="/library">Thư viện</Link>.
                </p>
              </div>
            ))}
        </div>

        {annotations.length > 0 && (
          <section className="reader-annotations card stack-2" aria-label={`Đánh dấu và ghi chú trang ${cur}`}>
            <div className="row-between">
              <strong>Đánh dấu & ghi chú · trang {cur}</strong>
              <span className="muted" style={{ fontSize: "var(--text-xs)" }}>
                {annotations.length} mục
              </span>
            </div>
            {annotations.map((annotation) => (
              <div className="reader-annotation-row" key={annotation.id}>
                <div className="reader-annotation-copy">
                  <span className="badge">
                    {annotation.kind === "note" ? "Ghi chú" : "Đánh dấu"} · {annotation.side === "source" ? "Gốc" : "Dịch"}
                  </span>
                  <span className="reader-annotation-text">{annotation.text}</span>
                  {annotation.note && <span className="muted">{annotation.note}</span>}
                </div>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => void removeAnnotation(annotation.id)}
                  aria-label="Xóa đánh dấu hoặc ghi chú"
                >
                  Xóa
                </button>
              </div>
            ))}
          </section>
        )}

        {selection && (
          <div
            ref={selectionMenuRef}
            className={"reader-selection-menu" + (selectionTranslation ? " has-translation" : "")}
            style={{
              left: selectionMenuPosition?.left ?? 12,
              top: selectionMenuPosition?.top ?? 12,
              maxHeight: selectionMenuPosition?.maxHeight,
            }}
            data-placement={selectionMenuPosition?.placement}
            role="dialog"
            aria-label="Đoạn văn đã chọn"
          >
            {selectionTranslation ? (
              <div className="reader-selection-translation">
                <section className="reader-selection-translation-pane" aria-label="Nội dung gốc">
                  <div className="reader-selection-preview-head">
                    <strong>Gốc</strong>
                    <span>
                      {selectionTranslation.detectedLanguage
                        ? `${selectionTranslation.detectedLanguage.toUpperCase()} · `
                        : ""}
                      {selectionTranslation.sourceText.length} ký tự
                    </span>
                  </div>
                  <div className="reader-selection-translation-text">
                    {selectionTranslation.sourceText}
                  </div>
                </section>
                <section className="reader-selection-translation-pane" aria-label="Nội dung dịch">
                  <div className="reader-selection-preview-head">
                    <strong>Dịch</strong>
                    <span>
                      Google · {selectionTranslation.targetLanguage === "vi" ? "Tiếng Việt" : "Tiếng Anh"}
                    </span>
                  </div>
                  <div className="reader-selection-translation-text" aria-live="polite">
                    {selectionTranslation.status === "loading"
                      ? <span className="muted">Đang dịch với Google…</span>
                      : selectionTranslation.status === "error"
                        ? <span className="reader-selection-translation-error">{selectionTranslation.error}</span>
                        : selectionTranslation.translatedText}
                  </div>
                </section>
              </div>
            ) : (
              <div className="reader-selection-preview">
                <div className="reader-selection-preview-head">
                  <strong>Đã chọn · {selection.side === "source" ? "Gốc" : "Dịch"}</strong>
                  <span>{selection.text.length} ký tự</span>
                </div>
                <div className="reader-selection-preview-text">{selection.text}</div>
              </div>
            )}
            <div className="reader-selection-actions" role="toolbar" aria-label="Thao tác đoạn văn đã chọn">
              <button type="button" onClick={askAboutSelection} disabled={annotationBusy}>Hỏi AI</button>
              <button
                type="button"
                onClick={() => void translateCurrentSelection()}
                disabled={annotationBusy || selectionTranslation?.status === "loading"}
              >
                {selectionTranslation?.status === "loading" ? "Đang dịch…" : "Google Dịch"}
              </button>
              <button type="button" onClick={readSelection} disabled={annotationBusy}>Đọc</button>
              <button type="button" onClick={() => void saveSelectionAnnotation("highlight")} disabled={annotationBusy}>Đánh dấu</button>
              <button type="button" onClick={() => setNoteOpen((open) => !open)} disabled={annotationBusy}>Ghi chú</button>
            </div>
            {noteOpen && (
              <div className="reader-note-editor">
                <input
                  className="input"
                  autoFocus
                  value={noteDraft}
                  maxLength={4000}
                  onChange={(event) => setNoteDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void saveSelectionAnnotation("note");
                    }
                  }}
                  placeholder="Nhập ghi chú…"
                  aria-label="Nội dung ghi chú"
                />
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => void saveSelectionAnnotation("note")}
                  disabled={annotationBusy || !noteDraft.trim()}
                >
                  Lưu
                </button>
              </div>
            )}
          </div>
        )}

        {repairOpen && (
          <section className="card stack-3" aria-label={`Yêu cầu xử lý trang ${cur}`}>
            <div className="row-between wrap" style={{ gap: "var(--space-3)" }}>
              <div>
                <h3>Yêu cầu xử lý trang {cur}</h3>
                <p className="muted" style={{ marginTop: 4, fontSize: "var(--text-sm)" }}>
                  Yêu cầu chỉ tác động đến trang này và được lưu trong lịch sử tài liệu.
                </p>
              </div>
              {documentBusy && <span className="badge badge-accent">Đang có tiến trình</span>}
            </div>

            <div className="row wrap" style={{ alignItems: "flex-end", gap: "var(--space-3)" }}>
              <label className="field" style={{ minWidth: 220, flex: "0 1 280px" }}>
                <span>Loại yêu cầu</span>
                <select
                  className="input"
                  value={repairKind}
                  onChange={(event) => setRepairKind(event.target.value as RepairRequestKind)}
                >
                  {REPAIR_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="btn btn-primary"
                disabled={repairSubmitting || documentBusy}
                onClick={async () => {
                  setRepairSubmitting(true);
                  try {
                    const result = await submitRepairRequest(
                      tag,
                      cur,
                      repairKind,
                      repairNote,
                      engine
                    );
                    acceptRepairSnapshot([
                      result.request,
                      ...repairRequests.filter((request) => request.id !== result.request.id),
                    ]);
                    setRepairNote("");
                    toast(`Đã gửi yêu cầu xử lý trang ${cur}`);
                  } catch (error) {
                    toast("Không gửi được yêu cầu: " + (error as Error).message);
                  } finally {
                    setRepairSubmitting(false);
                  }
                }}
              >
                {repairSubmitting ? "Đang gửi…" : documentBusy ? "Đang có tiến trình…" : "Gửi và thực hiện lại"}
              </button>
            </div>

            <label className="field">
              <span>Mô tả thêm (không bắt buộc)</span>
              <textarea
                className="input"
                rows={3}
                maxLength={1000}
                value={repairNote}
                onChange={(event) => setRepairNote(event.target.value)}
                placeholder="Ví dụ: đoạn cuối dịch thiếu ý; công thức thứ hai bị vỡ; bảng lệch cột bên phải…"
              />
            </label>

            <p className="muted" style={{ fontSize: "var(--text-xs)" }}>
              {repairKind === "translation"
                ? "App sẽ dịch lại các đoạn của riêng trang này, render PDF và kiểm tra layout lại."
                : "App sẽ render và kiểm tra lại đúng trang này. Lỗi văn bản an toàn có thể được tự sửa; lỗi công thức/engine chưa sửa được vẫn được giữ để review."}
            </p>

            {repairRequests.length > 0 && (
              <div className="stack-2">
                <strong style={{ fontSize: "var(--text-sm)" }}>Yêu cầu gần đây</strong>
                {repairRequests.slice(0, 5).map((request) => (
                  <div
                    key={request.id}
                    className="row-between wrap"
                    style={{ gap: "var(--space-2)", borderTop: "1px solid var(--border)", paddingTop: 8 }}
                  >
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => goToPage(request.page)}
                    >
                      Trang {request.page} · {REPAIR_KIND_LABEL[request.kind]}
                    </button>
                    <div className="row wrap" style={{ gap: "var(--space-2)" }}>
                      <span
                        className={
                          "badge " +
                          (request.status === "completed"
                            ? "badge-success"
                            : request.status === "failed"
                              ? "badge-danger"
                              : "badge-accent")
                        }
                        title={request.error || undefined}
                      >
                        {REPAIR_STATUS_LABEL[request.status]}
                      </span>
                      <span className="muted" style={{ fontSize: "var(--text-xs)" }}>
                        {new Date(request.created_at).toLocaleString("vi-VN", {
                          day: "2-digit",
                          month: "2-digit",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                    </div>
                    {request.note && (
                      <div className="muted" style={{ flexBasis: "100%", fontSize: "var(--text-xs)", paddingLeft: 10 }}>
                        {request.note}
                      </div>
                    )}
                    {request.error && (
                      <div style={{ color: "var(--danger)", flexBasis: "100%", fontSize: "var(--text-xs)", paddingLeft: 10 }}>
                        {request.error}
                      </div>
                    )}
                    {request.status === "running" && request.id === runningRepair?.id && (
                      <RepairRunLog
                        tag={tag}
                        runSid={request.run_sid}
                        active={!!request.run_sid}
                      />
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {blockEditMode && mode !== "original" && blocks.length > 0 && selectedBlock && selectedBlockIndex >= 0 && (
          <section className="card stack-3" aria-label="Chỉnh block dịch">
            <div className="row-between wrap" style={{ gap: "var(--space-3)" }}>
              <div>
                <h3>Chỉnh block</h3>
                <div className="muted" style={{ fontSize: "var(--text-xs)" }}>
                  Block {selectedBlockIndex + 1}/{blocks.length} · {selectedBlock.id} · trang {selectedBlock.page + 1} · scale {Math.round((selectedBlock.actual_scale || 1) * 100)}%
                  {selectedBlock.review_required ? " · cần kiểm tra" : ""}
                  {blockDirty ? " · chưa lưu" : ""}
                </div>
              </div>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={saving || documentBusy || !draft.trim() || !blockDirty}
                onClick={async () => {
                  if (!tag) return;
                  const blockToSave = selectedBlock;
                  const translationToSave = draft;
                  setBlockSaveError("");
                  setSaving(true);
                  try {
                    const result = await updateBlock(tag, blockToSave.id, translationToSave);
                    const next = result.block || { ...blockToSave, translation: translationToSave };
                    setBlockDrafts((old) => {
                      const updated = { ...old };
                      delete updated[next.id];
                      return updated;
                    });
                    setSelectedBlock((current) => current?.id === next.id ? next : current);
                    setBlockReport((old) => old
                      ? { ...old, blocks: old.blocks.map((b) => b.id === next.id ? next : b) }
                      : old);
                    setRenderVersion((v) => v + 1);
                    toast("Đã lưu block và render lại trang hiện tại");
                  } catch (e) {
                    const message = (e as Error).message || "lỗi không xác định";
                    setBlockSaveError(message);
                    toast("Không lưu được: " + message);
                  } finally {
                    setSaving(false);
                  }
                }}
              >
                {saving ? "Đang render…" : "Lưu block"}
              </button>
            </div>

            <div className="reader-block-nav">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={saving || selectedBlockIndex <= 0}
                onClick={() => selectBlock(blocks[selectedBlockIndex - 1])}
              >
                ‹ Block trước
              </button>
              <label className="field reader-block-picker">
                <span className="muted">Tất cả block trên trang</span>
                <select
                  className="input"
                  value={selectedBlock.id}
                  disabled={saving}
                  onChange={(event) => {
                    const block = blocks.find((item) => item.id === event.target.value);
                    if (block) selectBlock(block);
                  }}
                >
                  {blocks.map((block, index) => (
                    <option key={block.id} value={block.id}>
                      {index + 1}. {block.id} — {block.source.replace(/\s+/g, " ").slice(0, 90)}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={saving || selectedBlockIndex < 0 || selectedBlockIndex >= blocks.length - 1}
                onClick={() => selectBlock(blocks[selectedBlockIndex + 1])}
              >
                Block sau ›
              </button>
            </div>

            {saving && (
              <div className="reader-block-progress">
                <span className="job-live" aria-hidden="true" />
                <span role="status">Đang kiểm tra nội dung và render lại PDF</span>
                <span aria-hidden="true">
                  · {Math.floor(savingSeconds / 60)}:{String(savingSeconds % 60).padStart(2, "0")}
                </span>
              </div>
            )}
            {!saving && documentBusy && (
              <div className="reader-block-notice">
                Chờ yêu cầu đang chạy hoàn tất rồi mới có thể lưu block.
              </div>
            )}
            {blockSaveError && (
              <div className="reader-block-error" role="alert">
                Không lưu được: {blockSaveError}
              </div>
            )}
            <label className="muted" style={{ fontSize: "var(--text-xs)" }}>
              Bản gốc
              <textarea className="input" value={selectedBlock.source} readOnly rows={3} />
            </label>
            <label className="muted" style={{ fontSize: "var(--text-xs)" }}>
              Bản dịch
              <textarea
                className="input"
                value={draft}
                disabled={saving}
                onChange={(event) => {
                  const value = event.target.value;
                  setBlockDrafts((old) => ({ ...old, [selectedBlock.id]: value }));
                  setBlockSaveError("");
                }}
                rows={4}
              />
            </label>
            {/(?:\{v\d+\}|<\/?(?:b|i|sup)>)/i.test(selectedBlock.source) && (
              <p className="muted" style={{ fontSize: "var(--text-xs)" }}>
                Giữ nguyên các marker như {"{v1}"}, &lt;b&gt;, &lt;i&gt; hoặc &lt;sup&gt; trong bản dịch để công thức và định dạng không bị mất.
              </p>
            )}
          </section>
        )}
      </div>
    </div>
  );
}

function RepairRunLog({
  tag,
  runSid,
  active,
}: {
  tag: string;
  runSid?: string;
  active: boolean;
}) {
  const [lines, setLines] = React.useState<string[]>([]);
  const boxRef = React.useRef<HTMLPreElement>(null);
  const followTailRef = React.useRef(true);

  React.useEffect(() => {
    if (!active || !runSid) {
      setLines([]);
      return;
    }
    let alive = true;
    let inFlight = false;
    const refresh = () => {
      if (inFlight) return;
      inFlight = true;
      getLog(tag)
        .then((result) => {
          if (!alive) return;
          const next = result.lines || [];
          setLines((current) => (
            current.length === next.length && current.every((line, index) => line === next[index])
              ? current
              : next
          ));
        })
        .catch(() => {})
        .finally(() => {
          inFlight = false;
        });
    };
    refresh();
    const timer = window.setInterval(refresh, 2000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [active, tag, runSid]);

  React.useEffect(() => {
    if (boxRef.current && followTailRef.current) {
      boxRef.current.scrollTop = boxRef.current.scrollHeight;
    }
  }, [lines]);

  let start = -1;
  if (runSid) {
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      if (lines[index].includes(`sid=${runSid}`)) {
        start = index;
        break;
      }
    }
  }
  const visible = (start >= 0 ? lines.slice(start) : lines)
    .filter((line) => line.trim())
    .slice(-60);

  return (
    <div className="repair-run-log">
      <div className="repair-run-log-title">
        {active && <span className="job-live" aria-hidden="true" />}
        {active ? "Log xử lý trực tiếp · tự cập nhật" : "Đang đồng bộ log tiến trình…"}
      </div>
      <pre
        ref={boxRef}
        tabIndex={0}
        aria-label="Log xử lý trực tiếp"
        onScroll={(event) => {
          const target = event.currentTarget;
          followTailRef.current = target.scrollHeight - target.scrollTop - target.clientHeight < 24;
        }}
      >
        {active
          ? visible.join("\n") || "Đang khởi động tiến trình…"
          : "Đang chờ daemon xác nhận tiến trình hiện tại…"}
      </pre>
    </div>
  );
}

function Sheet({ cap, src, accent }: { cap: string; src: string; accent?: boolean }) {
  return (
    <div>
      <div
        className="sheet-cap"
        style={{ color: accent ? "var(--accent)" : undefined, marginBottom: 8, fontSize: "var(--text-xs)" }}
      >
        {cap}
      </div>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={cap}
        style={{
          width: "100%",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius-sm)",
          display: "block",
        }}
      />
    </div>
  );
}

function EditableSheet({
  cap,
  src,
  accent,
  report,
  selectedId,
  onSelect,
}: {
  cap: string;
  src: string;
  accent?: boolean;
  report: BlockReport | null;
  selectedId: string | null;
  onSelect: (block: DocumentBlock) => void;
}) {
  const [width, height] = report?.page_size || [595, 842];
  return (
    <div>
      <div
        className="sheet-cap"
        style={{ color: accent ? "var(--accent)" : undefined, marginBottom: 8, fontSize: "var(--text-xs)" }}
      >
        {cap}{report?.blocks.length ? " · bấm block để chỉnh" : ""}
      </div>
      <div style={{ position: "relative", lineHeight: 0 }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={src}
          alt={cap}
          style={{
            width: "100%",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius-sm)",
            display: "block",
          }}
        />
        {report?.blocks.map((block) => {
          const [x0, y0, x1, y1] = block.box;
          const left = Math.max(0, Math.min(100, (x0 / width) * 100));
          const top = Math.max(0, Math.min(100, (y0 / height) * 100));
          const w = Math.max(0.5, Math.min(100 - left, ((x1 - x0) / width) * 100));
          const h = Math.max(0.5, Math.min(100 - top, ((y1 - y0) / height) * 100));
          return (
            <button
              key={block.id}
              type="button"
              title={block.id + (block.review_required ? " · cần kiểm tra" : "")}
              aria-label={"Chỉnh " + block.id}
              onClick={() => onSelect(block)}
              style={{
                position: "absolute",
                left: left + "%",
                top: top + "%",
                width: w + "%",
                height: h + "%",
                padding: 0,
                border: block.id === selectedId
                  ? "2px solid var(--accent)"
                  : block.review_required
                    ? "1px dashed #d97706"
                    : "1px solid transparent",
                background: block.id === selectedId ? "rgba(37, 99, 235, .12)" : "transparent",
                cursor: "pointer",
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

interface ReaderPageCanvasProps {
  cap: string;
  side: ReaderSide;
  zoom: number;
  onZoomChange: (side: ReaderSide, next: React.SetStateAction<number>) => void;
  src: string;
  accent?: boolean;
  textPage: ReaderTextPage | null;
  annotations: ReaderAnnotation[];
  report?: BlockReport | null;
  selectedId?: string | null;
  onSelect?: (block: DocumentBlock) => void;
  blockEditMode?: boolean;
  blockEditModeDisabled?: boolean;
  onBlockEditModeToggle?: () => void;
  onSelectionReset: () => void;
  onSelection: (payload: PageSelectionPayload) => void;
}

function ReaderPageCanvas({
  cap,
  side,
  zoom,
  onZoomChange,
  src,
  accent,
  textPage,
  annotations,
  report,
  selectedId,
  onSelect,
  blockEditMode = false,
  blockEditModeDisabled = false,
  onBlockEditModeToggle,
  onSelectionReset,
  onSelection,
}: ReaderPageCanvasProps) {
  const viewportRef = React.useRef<HTMLDivElement>(null);
  const zoomContentRef = React.useRef<HTMLDivElement>(null);
  const mediaRef = React.useRef<HTMLDivElement>(null);
  const textLayerRef = React.useRef<HTMLDivElement>(null);
  const [imagePageSize, setImagePageSize] = React.useState<[number, number] | null>(null);
  const zoomAnchorRef = React.useRef<{
    clientX: number;
    clientY: number;
    xRatio: number;
    yRatio: number;
  } | null>(null);
  const pageSize = textPage?.page_size || report?.page_size || imagePageSize || [595, 842];
  const [pageWidth, pageHeight] = pageSize;
  const pageAnnotations = annotations.filter((item) => item.side === side);

  React.useLayoutEffect(() => {
    const layer = textLayerRef.current;
    if (!layer) return;

    let alive = true;
    const fitGlyphs = () => {
      if (!alive) return;
      layer.querySelectorAll<HTMLElement>(".reader-text-span").forEach((span) => {
        const glyph = span.querySelector<HTMLElement>(".reader-text-glyph");
        if (!glyph) return;
        glyph.style.transform = "none";
        const naturalWidth = glyph.getBoundingClientRect().width;
        const targetWidth = span.getBoundingClientRect().width;
        const scaleX = naturalWidth > 0 && targetWidth > 0
          ? targetWidth / naturalWidth
          : 1;
        glyph.style.transform = `scaleX(${scaleX})`;
      });
    };

    fitGlyphs();
    const observer = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(fitGlyphs);
    observer?.observe(layer);
    document.fonts?.ready.then(fitGlyphs).catch(() => undefined);
    return () => {
      alive = false;
      observer?.disconnect();
    };
  }, [pageWidth, pageHeight, textPage]);

  const rememberZoomAnchor = React.useCallback((clientX: number, clientY: number) => {
    const content = zoomContentRef.current;
    if (!content) return;
    const rect = content.getBoundingClientRect();
    zoomAnchorRef.current = {
      clientX,
      clientY,
      xRatio: rect.width > 0
        ? Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
        : 0.5,
      yRatio: rect.height > 0
        ? Math.max(0, Math.min(1, (clientY - rect.top) / rect.height))
        : 0.5,
    };
  }, []);

  React.useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const onWheel = (event: WheelEvent) => {
      // Electron/Chromium reports a macOS trackpad pinch as ctrl+wheel.
      // A normal two-finger wheel remains native scrolling inside this pane.
      if (!event.ctrlKey) return;
      event.preventDefault();
      onSelectionReset();
      rememberZoomAnchor(event.clientX, event.clientY);
      onZoomChange(side, (current) => readerZoomFromWheel(current, event.deltaY));
    };
    viewport.addEventListener("wheel", onWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", onWheel);
  }, [onSelectionReset, onZoomChange, rememberZoomAnchor, side]);

  React.useLayoutEffect(() => {
    const anchor = zoomAnchorRef.current;
    const viewport = viewportRef.current;
    const content = zoomContentRef.current;
    if (!anchor || !viewport || !content) return;
    const rect = content.getBoundingClientRect();
    viewport.scrollLeft += rect.left + rect.width * anchor.xRatio - anchor.clientX;
    viewport.scrollTop += rect.top + rect.height * anchor.yRatio - anchor.clientY;
    zoomAnchorRef.current = null;
  }, [zoom]);

  const zoomFromCenter = (next: React.SetStateAction<number>) => {
    const viewport = viewportRef.current;
    if (viewport) {
      const rect = viewport.getBoundingClientRect();
      rememberZoomAnchor(rect.left + rect.width / 2, rect.top + rect.height / 2);
    }
    onSelectionReset();
    onZoomChange(side, next);
  };

  const findTextLayer = (node: Node | null): HTMLElement | null => {
    const el = node?.nodeType === Node.ELEMENT_NODE
      ? node as Element
      : node?.parentElement;
    return el?.closest<HTMLElement>("[data-reader-text-layer]") || null;
  };

  const captureSelection = (
    event: React.MouseEvent<HTMLDivElement> | React.KeyboardEvent<HTMLDivElement>
  ) => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) {
      onSelectionReset();
      return;
    }
    const range = selection.getRangeAt(0);
    const startLayer = findTextLayer(range.startContainer);
    const endLayer = findTextLayer(range.endContainer);
    if (!startLayer || startLayer !== endLayer || !mediaRef.current?.contains(startLayer)) {
      onSelectionReset();
      return;
    }
    const text = normalizeSelectedText(range.toString());
    if (!text) {
      onSelectionReset();
      return;
    }
    const pageRect = mediaRef.current.getBoundingClientRect();
    const clientRects = Array.from(range.getClientRects()).map((rect) => ({
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
    } satisfies NumericRect));
    const rects = normalizeSelectionRects(clientRects, {
      left: pageRect.left,
      top: pageRect.top,
      right: pageRect.right,
      bottom: pageRect.bottom,
    });
    if (!rects.length) {
      onSelectionReset();
      return;
    }
    const rangeRect = range.getBoundingClientRect();
    const pointer = "clientX" in event
      ? { x: event.clientX, y: event.clientY }
      : undefined;
    onSelection({
      text,
      side,
      rects,
      menuRect: {
        left: rangeRect.left,
        top: rangeRect.top,
        right: rangeRect.right,
        bottom: rangeRect.bottom,
      },
      ...(pointer ? { pointer } : {}),
    });
  };

  const selectBlockAt = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!blockEditMode || !onSelect || !report?.blocks.length || !mediaRef.current) return;
    // A text span sits above the legacy transparent block buttons. Preserve
    // click-to-edit by resolving the clicked point back to the smallest block.
    const rect = mediaRef.current.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * pageWidth;
    const y = ((event.clientY - rect.top) / rect.height) * pageHeight;
    const candidates = report.blocks.filter((block) => {
      const [x0, y0, x1, y1] = block.box;
      return x >= x0 && x <= x1 && y >= y0 && y <= y1;
    });
    if (candidates.length) {
      candidates.sort((a, b) =>
        (a.box[2] - a.box[0]) * (a.box[3] - a.box[1]) -
        (b.box[2] - b.box[0]) * (b.box[3] - b.box[1])
      );
      onSelect(candidates[0]);
    }
  };

  return (
    <div className="reader-page-column" data-reader-side={side}>
      <div className="reader-page-toolbar">
        <div
          className="sheet-cap"
          style={{ color: accent ? "var(--accent)" : undefined, fontSize: "var(--text-xs)" }}
        >
          {cap}
          {blockEditMode && report?.blocks.length && onSelect
            ? " · bấm block để chỉnh; bôi đen để thao tác"
            : " · bôi đen để thao tác"}
        </div>
        <div className="reader-page-actions">
          {onBlockEditModeToggle && (blockEditMode || !!report?.blocks.length) && (
            <button
              type="button"
              className={`btn btn-sm ${blockEditMode ? "btn-primary" : "btn-secondary"}`}
              disabled={blockEditModeDisabled}
              aria-pressed={blockEditMode}
              data-block-edit-toggle
              title={blockEditMode ? "Tắt chế độ chỉnh block" : "Hiện vùng block để chỉnh"}
              onClick={onBlockEditModeToggle}
            >
              Chỉnh block
            </button>
          )}
          <div
            className="reader-zoom-controls"
            role="group"
            aria-label={`Thu phóng ${side === "source" ? "bản gốc" : "bản dịch"}`}
          >
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={zoom <= READER_ZOOM_MIN}
              onClick={() => zoomFromCenter((current) => clampReaderZoom(current - 0.1))}
              aria-label={`Thu nhỏ ${side === "source" ? "bản gốc" : "bản dịch"}`}
              title="Thu nhỏ trong khung"
            >
              −
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm num"
              onClick={() => zoomFromCenter(1)}
              aria-label={`Đặt lại ${side === "source" ? "bản gốc" : "bản dịch"} về 100%, hiện tại ${Math.round(zoom * 100)}%`}
              title="Đặt lại 100% · có thể pinch bằng trackpad trong khung"
            >
              {Math.round(zoom * 100)}%
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={zoom >= READER_ZOOM_MAX}
              onClick={() => zoomFromCenter((current) => clampReaderZoom(current + 0.1))}
              aria-label={`Phóng to ${side === "source" ? "bản gốc" : "bản dịch"}`}
              title="Phóng to trong khung"
            >
              +
            </button>
          </div>
        </div>
      </div>
      <div
        ref={viewportRef}
        className="reader-page-viewport"
        style={{ aspectRatio: `${pageWidth} / ${pageHeight}` }}
        data-reader-zoom-viewport={side}
        role="region"
        tabIndex={0}
        aria-label={`Khung tài liệu ${side === "source" ? "bản gốc" : "bản dịch"}`}
      >
        <div
          ref={zoomContentRef}
          className="reader-page-zoom-content"
          style={{
            width: `${zoom * 100}%`,
            aspectRatio: `${pageWidth} / ${pageHeight}`,
          }}
        >
          <div
            ref={mediaRef}
            className="reader-page-media"
            onMouseDown={onSelectionReset}
            onMouseUp={captureSelection}
            onKeyUp={captureSelection}
            onClick={blockEditMode ? selectBlockAt : undefined}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              className="reader-page-image"
              src={src}
              alt={cap}
              onLoad={(event) => {
                const { naturalWidth, naturalHeight } = event.currentTarget;
                if (naturalWidth <= 0 || naturalHeight <= 0) return;
                setImagePageSize((current) =>
                  current?.[0] === naturalWidth && current[1] === naturalHeight
                    ? current
                    : [naturalWidth, naturalHeight]
                );
              }}
            />

            {pageAnnotations.flatMap((annotation) =>
              annotation.rects.map((rect, index) => {
                const x = rect.x * 100;
                const y = rect.y * 100;
                const width = rect.width * 100;
                const height = rect.height * 100;
                return (
                  <span
                    key={`${annotation.id}-${index}`}
                    className={"reader-annotation-mark " + (annotation.kind === "note" ? "note" : "highlight")}
                    style={{ left: `${x}%`, top: `${y}%`, width: `${width}%`, height: `${height}%` }}
                    title={annotation.note || annotation.text}
                    aria-label={annotation.note || annotation.text}
                  />
                );
              })
            )}

            {textPage && (
              <div
                ref={textLayerRef}
                className="reader-text-layer"
                data-reader-text-layer
                data-side={side}
                aria-label={`Lớp chữ ${side === "source" ? "bản gốc" : "bản dịch"}`}
              >
                {textPage.spans.map((span) => {
                  const [x0, y0, x1, y1] = span.box;
                  const left = Math.max(0, Math.min(100, (x0 / pageWidth) * 100));
                  const top = Math.max(0, Math.min(100, (y0 / pageHeight) * 100));
                  const width = Math.max(0.1, Math.min(100 - left, ((x1 - x0) / pageWidth) * 100));
                  const height = Math.max(0.1, Math.min(100 - top, ((y1 - y0) / pageHeight) * 100));
                  return (
                    <span
                      key={span.id}
                      className="reader-text-span"
                      style={{
                        left: `${left}%`,
                        top: `${top}%`,
                        width: `${width}%`,
                        height: `${height}%`,
                        fontSize: `${Math.max(1, span.font_size) / pageWidth * 100}cqw`,
                        fontWeight: span.bold ? 700 : 400,
                        fontStyle: span.italic ? "italic" : "normal",
                      }}
                    >
                      <span className="reader-text-glyph">{span.text}</span>
                    </span>
                  );
                })}
              </div>
            )}

            {blockEditMode && onSelect && report?.blocks.map((block) => {
              const [x0, y0, x1, y1] = block.box;
              const left = Math.max(0, Math.min(100, (x0 / pageWidth) * 100));
              const top = Math.max(0, Math.min(100, (y0 / pageHeight) * 100));
              const width = Math.max(0.5, Math.min(100 - left, ((x1 - x0) / pageWidth) * 100));
              const height = Math.max(0.5, Math.min(100 - top, ((y1 - y0) / pageHeight) * 100));
              return (
                <button
                  key={block.id}
                  type="button"
                  className="reader-block-hitbox"
                  title={block.id + (block.review_required ? " · cần kiểm tra" : "")}
                  aria-label={`Chọn ${block.id} ở ${side === "source" ? "bản gốc" : "bản dịch"}`}
                  aria-pressed={block.id === selectedId}
                  data-block-id={block.id}
                  data-selected={block.id === selectedId ? "true" : "false"}
                  onClick={(event) => {
                    event.stopPropagation();
                    onSelect?.(block);
                  }}
                  style={{
                    left: `${left}%`,
                    top: `${top}%`,
                    width: `${width}%`,
                    height: `${height}%`,
                    border: block.id === selectedId
                      ? "2px solid var(--accent)"
                      : block.review_required
                        ? "1px dashed #d97706"
                        : "1px solid color-mix(in oklab, var(--accent), transparent 65%)",
                    background: block.id === selectedId ? "rgba(37, 99, 235, .12)" : "transparent",
                  }}
                />
              );
            })}
          </div>
        </div>
      </div>
      {textPage && textPage.spans.length === 0 && (
        <small className="muted reader-no-text">Trang này không có lớp chữ để bôi đen (có thể là bản scan).</small>
      )}
      {!textPage && <small className="muted reader-no-text">Đang tải lớp chữ…</small>}
    </div>
  );
}
