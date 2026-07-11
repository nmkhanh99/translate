"use client";
// Per-document AI chat. Opens scoped to one PDF; the agent (Claude / Codex /
// Grok) runs headless in the translate root and is told which source/output
// files this document maps to. Streams tokens from /api/chat (SSE).
//
// Conversations are persisted per document in SQLite on the daemon (mirroring
// open-design's projects → conversations → messages model): each document is a
// "project" that can hold many named conversations, each remembering its own
// transcript and per-engine CLI session id for resume across reloads. If the
// daemon reports persist:false (SQLite unavailable) the drawer degrades to a
// single in-memory conversation.
import * as React from "react";
import { ChatDoc, useToast, useEngine } from "./Providers";
import type { ChatMessage, ChatRole, Engine } from "../lib/types";
import { streamChat } from "../lib/chat";
import {
  listConversations,
  createConversation,
  loadConversation,
  saveConversationApi,
  deleteConversationApi,
  type ConversationMeta,
} from "../lib/api";
import { IconChat, IconClose, IconSend } from "./icons";
import { EngineSwitch, ENGINES } from "./EngineSwitch";

let idSeq = 0;
// Must not collide with ids of messages reloaded from the server. A plain
// counter resets to 0 on every page load, so after a reload it would re-mint
// "m1", "m2"… — the very ids the prior session already persisted. Use a random
// uuid (with a counter fallback for exotic environments) to stay unique.
const nextId = () =>
  "m-" + (globalThis.crypto?.randomUUID?.() ?? Date.now() + "-" + ++idSeq);

function relTime(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "vừa xong";
  if (s < 3600) return Math.floor(s / 60) + " phút trước";
  if (s < 86400) return Math.floor(s / 3600) + " giờ trước";
  return Math.floor(s / 86400) + " ngày trước";
}

const STARTERS: { title: string; prompt: string }[] = [
  {
    title: "Dịch trang",
    prompt: "Dịch giúp tôi các trang 40–46 sang tiếng Việt, giữ thuật ngữ chuyên ngành.",
  },
  {
    title: "Giải thích thuật ngữ",
    prompt: "Giải thích các thuật ngữ quan trọng trong Learning Module đầu tiên của cuốn này bằng tiếng Việt dễ hiểu.",
  },
  {
    title: "Soát bản dịch",
    prompt: "Soát nhanh bản dịch (nếu đã có): lỗi trình bày bảng, số liệu, công thức bị vỡ layout.",
  },
  {
    title: "Tóm tắt module",
    prompt: "Tóm tắt Learning Module 1: mục tiêu LOS và 3 ý chính cần nhớ khi thi.",
  },
];

export function ChatDrawer({
  doc,
  open,
  onClose,
}: {
  doc: ChatDoc | null;
  open: boolean;
  onClose: () => void;
}) {
  const toast = useToast();
  const { available, rescanAgents } = useEngine();
  const [engine, setEngine] = React.useState<Engine>("claude");
  const [messages, setMessages] = React.useState<ChatMessage[]>([]);
  const [conversations, setConversations] = React.useState<ConversationMeta[]>([]);
  const [convId, setConvId] = React.useState<string | null>(null);
  const [persist, setPersist] = React.useState(true);
  const [input, setInput] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [statusLine, setStatusLine] = React.useState<string | null>(null);
  const abortRef = React.useRef<AbortController | null>(null);
  const logRef = React.useRef<HTMLDivElement>(null);
  const tag = doc?.tag || "";
  // Latest active tag/conversation, so an in-flight stream for a PREVIOUS
  // document doesn't overwrite the visible messages after a switch.
  const tagRef = React.useRef(tag);
  tagRef.current = tag;
  const convIdRef = React.useRef<string | null>(null);
  // Working copy of the visible transcript; read synchronously when starting a
  // turn (setMessages is async). Kept in lock-step via applyMessages().
  const messagesRef = React.useRef<ChatMessage[]>([]);
  // CLI session id per engine for the CURRENT conversation (enables resume).
  const sessionsRef = React.useRef<Partial<Record<Engine, string>>>({});

  const engineOk = available[engine] !== false;
  const engineLabel = ENGINES.find((e) => e.id === engine)?.label || engine;

  function pickEngine(e: Engine) {
    if (e === engine) return;
    setEngine(e);
    toast("Chat dùng: " + (ENGINES.find((x) => x.id === e)?.label || e));
  }

  // Only touch visible state when the message batch belongs to the on-screen
  // document; a background stream for a previous tag still updates its own local
  // `arr` and persists via its captured conversation id.
  const applyMessages = React.useCallback((next: ChatMessage[], forTag: string) => {
    if (tagRef.current === forTag) {
      messagesRef.current = next;
      setMessages(next);
    }
  }, []);

  const toStored = (msgs: ChatMessage[]) =>
    msgs
      .filter((m) => m.text !== undefined)
      .map((m) => ({ id: m.id, role: m.role, text: m.text, engine: m.engine ?? null }));

  const fromStored = (rows: { id: string; role: string; text: string; engine?: string | null }[]) =>
    rows.map((r) => ({
      id: r.id,
      role: r.role as ChatRole,
      text: r.text,
      engine: (r.engine || undefined) as Engine | undefined,
    }));

  const saveConv = React.useCallback(
    (cid: string | null, msgs: ChatMessage[], sessions: Partial<Record<Engine, string>>) => {
      if (!persist || !cid) return;
      saveConversationApi(cid, {
        engine,
        messages: toStored(msgs),
        sessions: sessions as Record<string, string>,
      }).catch(() => {});
    },
    [persist, engine]
  );

  const refreshList = React.useCallback(async (t: string) => {
    if (!t) return;
    try {
      const r = await listConversations(t);
      if (tagRef.current !== t) return;
      setPersist(r.persist);
      setConversations(r.conversations);
    } catch {
      /* ignore */
    }
  }, []);

  // Load this document's conversation list + most-recent transcript on switch.
  React.useEffect(() => {
    if (!tag) {
      setConversations([]);
      setConvId(null);
      convIdRef.current = null;
      sessionsRef.current = {};
      applyMessages([], tag);
      return;
    }
    let alive = true;
    (async () => {
      try {
        const r = await listConversations(tag);
        if (!alive || tagRef.current !== tag) return;
        setPersist(r.persist);
        setConversations(r.conversations);
        sessionsRef.current = {};
        if (r.conversations.length > 0) {
          const first = r.conversations[0];
          const data = await loadConversation(first.id);
          if (!alive || tagRef.current !== tag) return;
          convIdRef.current = first.id;
          setConvId(first.id);
          sessionsRef.current = (data.sessions || {}) as Partial<Record<Engine, string>>;
          applyMessages(fromStored(data.messages || []), tag);
        } else {
          convIdRef.current = null;
          setConvId(null);
          applyMessages([], tag);
        }
      } catch {
        if (!alive) return;
        setPersist(false);
        setConversations([]);
        convIdRef.current = null;
        setConvId(null);
        applyMessages([], tag);
      }
      if (alive) setStatusLine(null);
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tag]);

  // Autoscroll to newest.
  React.useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, open, statusLine]);

  // Esc closes.
  React.useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, onClose]);

  async function selectConv(id: string) {
    if (busy || id === convIdRef.current) return;
    try {
      const data = await loadConversation(id);
      if (tagRef.current !== tag) return;
      convIdRef.current = id;
      setConvId(id);
      sessionsRef.current = (data.sessions || {}) as Partial<Record<Engine, string>>;
      applyMessages(fromStored(data.messages || []), tag);
      setStatusLine(null);
    } catch (e) {
      toast("Lỗi tải hội thoại: " + (e as Error).message);
    }
  }

  function newConv() {
    if (busy) return;
    convIdRef.current = null;
    setConvId(null);
    sessionsRef.current = {};
    applyMessages([], tag);
    setStatusLine(null);
  }

  async function delConv(id: string) {
    try {
      await deleteConversationApi(id);
      if (id === convIdRef.current) newConv();
      await refreshList(tag);
      toast("Đã xóa hội thoại");
    } catch (e) {
      toast("Lỗi: " + (e as Error).message);
    }
  }

  async function send(raw?: string) {
    const text = (raw ?? input).trim();
    if (!text || !doc || busy) return;
    setInput("");
    const sendTag = tag;
    const base = messagesRef.current;
    const userMsg: ChatMessage = { id: nextId(), role: "user", text };
    const botId = nextId();
    const botMsg: ChatMessage = {
      id: botId,
      role: "assistant",
      text: "",
      engine,
      streaming: true,
    };
    let arr = [...base, userMsg, botMsg];
    applyMessages(arr, sendTag);
    setBusy(true);
    setStatusLine(null);

    // Lazily create a conversation to attach these messages to.
    let cid = convIdRef.current;
    if (!cid && persist) {
      try {
        const c = await createConversation(sendTag, text.slice(0, 60), engine);
        cid = c.id;
        convIdRef.current = c.id;
        if (tagRef.current === sendTag) {
          setConvId(c.id);
          setConversations((prev) => [{ ...c, msg_count: 0 }, ...prev]);
        }
      } catch {
        // SQLite unavailable — continue as a single in-memory conversation.
        setPersist(false);
      }
    }
    const sendConvId = cid;
    // Per-send session snapshot. `sessionsRef` tracks the ON-SCREEN
    // conversation; if the user switches document/conversation while this stream
    // is still running, mutating the ref would corrupt the new target. Work on a
    // local copy and only mirror it back when this turn is still the current one.
    const sessions: Partial<Record<Engine, string>> = { ...sessionsRef.current };
    const stillCurrent = () =>
      tagRef.current === sendTag && convIdRef.current === sendConvId;

    // Persist the user turn immediately (exclude the empty streaming bubble) so
    // a reload mid-stream keeps the question.
    saveConv(sendConvId, [...base, userMsg], sessions);
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    const patch = (fn: (m: ChatMessage) => ChatMessage) => {
      arr = arr.map((m) => (m.id === botId ? fn(m) : m));
      applyMessages(arr, sendTag);
    };

    try {
      await streamChat(
        {
          tag: doc.tag,
          engine,
          message: text,
          session: sessions[engine] || null,
        },
        (ev) => {
          if (ev.type === "delta" && ev.text) {
            patch((m) => ({ ...m, text: m.text + ev.text }));
          } else if (ev.type === "tool" && ev.text) {
            // Surface tool activity as a separate dim line above the bubble.
            const toolMsg: ChatMessage = { id: nextId(), role: "tool", text: ev.text };
            const bi = arr.findIndex((m) => m.id === botId);
            arr = [...arr.slice(0, bi), toolMsg, ...arr.slice(bi)];
            applyMessages(arr, sendTag);
          } else if (ev.type === "info" && ev.text) {
            // Resume-retry clears the CLI session on the server; drop local handle
            // so the next turn uses the new session id from `done`.
            if (ev.text.toLowerCase().includes("phiên")) {
              delete sessions[engine];
              const resetMsg: ChatMessage = {
                id: nextId(),
                role: "info",
                text: "🔄 Đã reset phiên CLI — mở phiên mới & gửi lại ngữ cảnh tài liệu",
              };
              const bi = arr.findIndex((m) => m.id === botId);
              arr = [...arr.slice(0, bi), resetMsg, ...arr.slice(bi)];
              applyMessages(arr, sendTag);
            } else {
              setStatusLine(ev.text);
            }
          } else if (ev.type === "done") {
            if (ev.session) sessions[engine] = ev.session;
            else delete sessions[engine];
            patch((m) => ({ ...m, streaming: false }));
            setStatusLine(null);
          } else if (ev.type === "error" && ev.text) {
            patch((m) => ({
              ...m,
              role: "error",
              streaming: false,
              text: (m.text ? m.text + "\n\n" : "") + "⚠ " + ev.text,
            }));
            setStatusLine(null);
          }
        },
        ctrl.signal
      );
    } catch (e) {
      if ((e as Error)?.name === "AbortError") {
        patch((m) =>
          m.streaming ? { ...m, streaming: false, text: m.text || "(đã dừng)" } : m
        );
      } else {
        const msg = e instanceof Error ? e.message : String(e);
        patch((m) => ({ ...m, role: "error", streaming: false, text: "⚠ " + msg }));
      }
    } finally {
      // Ensure the streaming flag clears even if no explicit done arrived.
      patch((m) => (m.streaming ? { ...m, streaming: false } : m));
      setBusy(false);
      abortRef.current = null;
      setStatusLine(null);
      // Only mirror the session back to the on-screen ref if this turn is still
      // the current one; otherwise the user has moved on and we must not touch
      // the new target's session. Persist always targets this turn's own conv.
      if (stillCurrent()) sessionsRef.current = sessions;
      saveConv(sendConvId, arr, sessions);
      void refreshList(sendTag);
    }
  }

  function stop() {
    abortRef.current?.abort();
  }

  return (
    <>
      <div className={"chat-overlay" + (open ? " open" : "")} onClick={onClose} />
      <aside className={"chat-drawer" + (open ? " open" : "")} aria-hidden={!open}>
        <header className="chat-head">
          <EngineSwitch
            value={engine}
            onChange={pickEngine}
            available={available}
            onRescan={rescanAgents}
            ariaLabel="Chọn CLI cho chat"
          />
          <button className="btn btn-icon x" onClick={onClose} aria-label="Đóng">
            <IconClose />
          </button>
        </header>

        {persist && (
          <div className="chat-convbar">
            <ConversationsMenu
              conversations={conversations}
              convId={convId}
              busy={busy}
              onSelect={selectConv}
              onDelete={delConv}
            />
            <button
              className="btn btn-secondary btn-sm"
              onClick={newConv}
              disabled={busy}
              title="Bắt đầu hội thoại mới cho cuốn này"
            >
              ＋ Mới
            </button>
          </div>
        )}

        <div className="chat-scope">
          <small>
            💬 Trò chuyện về <b>{doc?.display || "tài liệu"}</b>. AI chạy trong thư
            mục <span className="num">translate</span> và biết file nguồn/bản dịch
            của cuốn này — hỏi để dịch, giải thích thuật ngữ, hay soát lỗi trình
            bày. Mỗi cuốn giữ nhiều hội thoại, tự lưu lại.
          </small>
        </div>

        {!engineOk ? (
          <div className="chat-banner warn" role="status">
            <small>
              <b>{engineLabel}</b> chưa thấy trên PATH. Cài & đăng nhập CLI, rồi
              bấm ↻ quét lại — vẫn có thể thử gửi.
            </small>
          </div>
        ) : null}

        <div className="chat-log" ref={logRef}>
          {messages.length === 0 ? (
            <div className="chat-empty">
              <div className="dz-mark">
                <IconChat />
              </div>
              <p>
                Hỏi <b>{engineLabel}</b> bất cứ điều gì về cuốn này.
              </p>
              <div className="chat-starters">
                {STARTERS.map((s) => (
                  <button
                    key={s.title}
                    type="button"
                    className="chat-starter"
                    disabled={busy}
                    onClick={() => setInput(s.prompt)}
                    title={s.prompt}
                  >
                    {s.title}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((m) => <Bubble key={m.id} m={m} />)
          )}
          {statusLine ? (
            <div className="msg info">
              <div className="bubble">{statusLine}</div>
            </div>
          ) : null}
        </div>

        <div className="chat-composer">
          <textarea
            className="input"
            placeholder={`Nhắn ${engineLabel}… (Enter gửi · Shift+Enter xuống dòng)`}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            rows={2}
          />
          <div className="row-between">
            <small>
              {busy ? (
                <span className="chat-thinking" aria-label="Đang suy nghĩ">
                  <i />
                  <i />
                  <i />
                </span>
              ) : (
                <>
                  Engine: {engineLabel} · headless
                  {sessionsRef.current[engine] ? " · resume" : ""}
                </>
              )}
            </small>
            {busy ? (
              <button className="btn btn-secondary btn-sm" onClick={stop}>
                Dừng
              </button>
            ) : (
              <button
                className="btn btn-primary btn-sm"
                onClick={() => void send()}
                disabled={!input.trim()}
              >
                <IconSend /> Gửi
              </button>
            )}
          </div>
        </div>
      </aside>
    </>
  );
}

function ConversationsMenu({
  conversations,
  convId,
  busy,
  onSelect,
  onDelete,
}: {
  conversations: ConversationMeta[];
  convId: string | null;
  busy: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);
  const cur = conversations.find((c) => c.id === convId);
  const label = convId ? cur?.title || "Hội thoại" : "Hội thoại mới";

  React.useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", h);
    return () => window.removeEventListener("mousedown", h);
  }, [open]);

  return (
    <div className="conv-menu" ref={ref}>
      <button
        className="conv-trigger"
        onClick={() => setOpen((o) => !o)}
        disabled={busy}
        title="Chọn hội thoại đã lưu"
      >
        <IconChat />
        <span className="title">{label}</span>
        <span className="caret">▾</span>
      </button>
      {open && (
        <ul className="conv-menu-list">
          {conversations.length === 0 && (
            <li className="conv-empty">Chưa có hội thoại nào đã lưu.</li>
          )}
          {conversations.map((c) => (
            <li key={c.id} style={{ display: "flex", alignItems: "center" }}>
              <button
                className={"conv-opt" + (c.id === convId ? " active" : "")}
                onClick={() => {
                  setOpen(false);
                  onSelect(c.id);
                }}
              >
                <span className="body">
                  <span className="t">{c.title || "Hội thoại"}</span>
                  <span className="meta">
                    {c.msg_count} tin · {relTime(c.updated_at)}
                  </span>
                </span>
              </button>
              <button
                className="conv-del"
                title="Xóa hội thoại"
                aria-label="Xóa hội thoại"
                onClick={() => onDelete(c.id)}
              >
                🗑
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Bubble({ m }: { m: ChatMessage }) {
  const who =
    m.role === "user"
      ? "Bạn"
      : m.role === "tool"
      ? "công cụ"
      : m.role === "error"
      ? "lỗi"
      : m.engine || "assistant";
  return (
    <div className={"msg " + m.role}>
      {m.role !== "tool" && m.role !== "info" && <span className="who">{who}</span>}
      <div className="bubble">
        {m.text}
        {m.streaming && <span className="cursor" />}
      </div>
    </div>
  );
}
