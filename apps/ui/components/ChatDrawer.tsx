"use client";
// Per-document AI chat. Opens scoped to one PDF; the agent (Claude / Codex /
// Grok) runs headless in the translate root and is told which source/output
// files this document maps to. Streams tokens from /api/chat (SSE).
// UX patterns ported from open-design: starter prompts, clear session, info
// status lines, CLI availability banner, robust SSE heartbeats.
import * as React from "react";
import { ChatDoc, useToast, useEngine } from "./Providers";
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
  const [input, setInput] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [statusLine, setStatusLine] = React.useState<string | null>(null);
  const abortRef = React.useRef<AbortController | null>(null);
  const logRef = React.useRef<HTMLDivElement>(null);
  const tag = doc?.tag || "";
  // Latest active tag, so an in-flight stream for a PREVIOUS document doesn't
  // overwrite the visible messages after the user switches documents.
  const tagRef = React.useRef(tag);
  tagRef.current = tag;

  const engineOk = available[engine] !== false;
  const engineLabel = ENGINES.find((e) => e.id === engine)?.label || engine;

  function pickEngine(e: Engine) {
    if (e === engine) return;
    setEngine(e);
    toast("Chat dùng: " + (ENGINES.find((x) => x.id === e)?.label || e));
  }

  // Load this document's conversation when the drawer target changes.
  React.useEffect(() => {
    if (!tag) return;
    setMessages(convFor(tag).messages.slice());
    setStatusLine(null);
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

  // forTag defaults to the tag captured when this closure was created (send-time).
  // Always persist to that document's store, but only update the visible list if
  // that document is still the one on screen.
  function persist(next: ChatMessage[], forTag: string = tag) {
    if (forTag) convFor(forTag).messages = next;
    if (tagRef.current === forTag) setMessages(next);
  }

  function clearConversation() {
    if (!tag || busy) return;
    store.set(tag, { messages: [], sessions: {} });
    setMessages([]);
    setStatusLine(null);
    toast("Đã xóa hội thoại · phiên CLI reset");
  }

  async function send(raw?: string) {
    const text = (raw ?? input).trim();
    if (!text || !doc || busy) return;
    if (!raw) setInput("");
    else setInput("");
    const conv = convFor(tag);
    const sendTag = tag;
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
    persist(arr, sendTag);
    setBusy(true);
    setStatusLine(null);
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    const patch = (fn: (m: ChatMessage) => ChatMessage) => {
      arr = arr.map((m) => (m.id === botId ? fn(m) : m));
      persist(arr, sendTag);
    };

    try {
      await streamChat(
        {
          tag: doc.tag,
          engine,
          message: text,
          session: conv.sessions[engine] || null,
        },
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
            persist(arr, sendTag);
          } else if (ev.type === "info" && ev.text) {
            setStatusLine(ev.text);
            // Resume-retry clears the CLI session on the server; drop local handle
            // so the next turn uses the new session id from `done`.
            if (ev.text.toLowerCase().includes("phiên")) {
              delete conv.sessions[engine];
            }
          } else if (ev.type === "done") {
            if (ev.session) conv.sessions[engine] = ev.session;
            else delete conv.sessions[engine];
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
          m.streaming
            ? {
                ...m,
                streaming: false,
                text: m.text || "(đã dừng)",
              }
            : m
        );
      } else {
        const msg = e instanceof Error ? e.message : String(e);
        patch((m) => ({
          ...m,
          role: "error",
          streaming: false,
          text: "⚠ " + msg,
        }));
      }
    } finally {
      // Ensure the streaming flag clears even if no explicit done arrived.
      patch((m) => (m.streaming ? { ...m, streaming: false } : m));
      setBusy(false);
      abortRef.current = null;
      setStatusLine(null);
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
          <button
            className="btn btn-icon x"
            onClick={clearConversation}
            disabled={busy || messages.length === 0}
            title="Xóa hội thoại & reset phiên CLI"
            aria-label="Xóa hội thoại"
          >
            ⌫
          </button>
          <button className="btn btn-icon" onClick={onClose} aria-label="Đóng">
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
                    onClick={() => {
                      setInput(s.prompt);
                    }}
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
                  {convFor(tag).sessions[engine] ? " · resume" : ""}
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
        {m.streaming && <span className="cursor" />}
      </div>
    </div>
  );
}
