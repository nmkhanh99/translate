"use client";
// Per-document AI chat. Opens scoped to one PDF; the agent (Claude / Codex /
// Grok) runs headless in the translate root and is told which source/output
// files this document maps to. Streams tokens from /api/chat (SSE).
import * as React from "react";
import { ChatDoc, useToast } from "./Providers";
import type { ChatMessage, Engine } from "../lib/types";
import { streamChat } from "../lib/chat";
import { IconChat, IconClose, IconSend } from "./icons";
import { EngineSwitch, ENGINES } from "./EngineSwitch";

// In-memory conversation store, keyed by document tag. Survives drawer
// open/close within a session; sessions[engine] lets the backend resume context.
interface Conv {
  messages: ChatMessage[];
  sessions: Partial<Record<Engine, string>>;
}
const store = new Map<string, Conv>();
function convFor(tag: string): Conv {
  let c = store.get(tag);
  if (!c) {
    c = { messages: [], sessions: {} };
    store.set(tag, c);
  }
  return c;
}

let idSeq = 0;
const nextId = () => "m" + ++idSeq;

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
  const [engine, setEngine] = React.useState<Engine>("claude");
  const [messages, setMessages] = React.useState<ChatMessage[]>([]);
  const [input, setInput] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const abortRef = React.useRef<AbortController | null>(null);
  const logRef = React.useRef<HTMLDivElement>(null);
  const tag = doc?.tag || "";
  // Latest active tag, so an in-flight stream for a PREVIOUS document doesn't
  // overwrite the visible messages after the user switches documents.
  const tagRef = React.useRef(tag);
  tagRef.current = tag;

  function pickEngine(e: Engine) {
    if (e === engine) return;
    setEngine(e);
    toast("Chat dùng: " + (ENGINES.find((x) => x.id === e)?.label || e));
  }

  // Load this document's conversation when the drawer target changes.
  React.useEffect(() => {
    if (!tag) return;
    setMessages(convFor(tag).messages.slice());
  }, [tag]);

  // Autoscroll to newest.
  React.useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, open]);

  // Esc closes.
  React.useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, onClose]);

  // forTag defaults to the tag captured when this closure was created (send-time).
  // Always persist to that document's store, but only update the visible list if
  // that document is still the one on screen.
  function persist(next: ChatMessage[], forTag: string = tag) {
    if (forTag) convFor(forTag).messages = next;
    if (tagRef.current === forTag) setMessages(next);
  }

  async function send() {
    const text = input.trim();
    if (!text || !doc || busy) return;
    setInput("");
    const conv = convFor(tag);
    const userMsg: ChatMessage = { id: nextId(), role: "user", text };
    const botId = nextId();
    const botMsg: ChatMessage = {
      id: botId,
      role: "assistant",
      text: "",
      engine,
      streaming: true,
    };
    let arr = [...conv.messages, userMsg, botMsg];
    persist(arr);
    setBusy(true);
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    const patch = (fn: (m: ChatMessage) => ChatMessage) => {
      arr = arr.map((m) => (m.id === botId ? fn(m) : m));
      persist(arr);
    };

    try {
      await streamChat(
        { tag: doc.tag, engine, message: text, session: conv.sessions[engine] || null },
        (ev) => {
          if (ev.type === "delta" && ev.text) {
            patch((m) => ({ ...m, text: m.text + ev.text }));
          } else if (ev.type === "tool" && ev.text) {
            // Surface tool activity as a separate dim line above the bubble.
            const toolMsg: ChatMessage = {
              id: nextId(),
              role: "tool",
              text: ev.text,
            };
            const bi = arr.findIndex((m) => m.id === botId);
            arr = [...arr.slice(0, bi), toolMsg, ...arr.slice(bi)];
            persist(arr);
          } else if (ev.type === "done") {
            if (ev.session) conv.sessions[engine] = ev.session;
            patch((m) => ({ ...m, streaming: false }));
          } else if (ev.type === "error" && ev.text) {
            patch((m) => ({
              ...m,
              role: "error",
              streaming: false,
              text: (m.text ? m.text + "\n\n" : "") + "⚠ " + ev.text,
            }));
          }
        },
        ctrl.signal
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      patch((m) => ({ ...m, role: "error", streaming: false, text: "⚠ " + msg }));
    } finally {
      // Ensure the streaming flag clears even if no explicit done arrived.
      patch((m) => (m.streaming ? { ...m, streaming: false } : m));
      setBusy(false);
      abortRef.current = null;
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
          <EngineSwitch value={engine} onChange={pickEngine} ariaLabel="Chọn CLI cho chat" />
          <button className="btn btn-icon x" onClick={onClose} aria-label="Đóng">
            <IconClose />
          </button>
        </header>

        <div className="chat-scope">
          <small>
            💬 Trò chuyện về <b>{doc?.display || "tài liệu"}</b>. AI chạy trong thư
            mục <span className="num">translate</span> và biết file nguồn/bản dịch
            của cuốn này — hỏi để dịch, giải thích thuật ngữ, hay soát lỗi trình
            bày. Mỗi cuốn giữ hội thoại riêng.
          </small>
        </div>

        <div className="chat-log" ref={logRef}>
          {messages.length === 0 ? (
            <div className="chat-empty">
              <div className="dz-mark">
                <IconChat />
              </div>
              <p>
                Hỏi <b>{ENGINES.find((e) => e.id === engine)?.label}</b> bất cứ điều
                gì về cuốn này. Ví dụ: “Dịch trang 40–46”, “Giải thích thuật ngữ
                trong trang này”, “Soát lỗi bảng biểu bản dịch”.
              </p>
            </div>
          ) : (
            messages.map((m) => <Bubble key={m.id} m={m} />)
          )}
        </div>

        <div className="chat-composer">
          <textarea
            className="input"
            placeholder={`Nhắn ${
              ENGINES.find((e) => e.id === engine)?.label
            }… (Enter gửi · Shift+Enter xuống dòng)`}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            rows={2}
          />
          <div className="row-between">
            <small>
              {busy ? (
                <span className="chat-thinking">
                  <i />
                  <i />
                  <i />
                </span>
              ) : (
                <>Engine: {ENGINES.find((e) => e.id === engine)?.label} · headless</>
              )}
            </small>
            {busy ? (
              <button className="btn btn-secondary btn-sm" onClick={stop}>
                Dừng
              </button>
            ) : (
              <button
                className="btn btn-primary btn-sm"
                onClick={send}
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
      {m.role !== "tool" && <span className="who">{who}</span>}
      <div className="bubble">
        {m.text}
        {m.streaming && !m.text && <span className="cursor" />}
        {m.streaming && m.text && <span className="cursor" />}
      </div>
    </div>
  );
}
