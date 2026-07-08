"use client";
// App-wide providers: toast notifications, the global translation-engine (CLI)
// choice synced to /api/config, and the per-document chat drawer state.
import * as React from "react";
import { ChatDrawer } from "./ChatDrawer";
import { getStatus, saveConfig } from "../lib/api";
import type { Engine } from "../lib/types";

/* ---------------- Toast ---------------- */
const ToastCtx = React.createContext<(msg: string) => void>(() => {});
export const useToast = () => React.useContext(ToastCtx);

/* ------------- Translation engine (CLI) ------------- */
interface EngineCtxValue {
  engine: Engine;
  setEngine: (e: Engine) => void;
}
const EngineCtx = React.createContext<EngineCtxValue>({
  engine: "claude",
  setEngine: () => {},
});
export const useEngine = () => React.useContext(EngineCtx);

/* ---------------- Chat ----------------- */
export interface ChatDoc {
  tag: string;
  display: string;
  pages?: number;
}
interface ChatCtxValue {
  openChat: (doc: ChatDoc) => void;
  closeChat: () => void;
  activeDoc: ChatDoc | null;
  open: boolean;
}
const ChatCtx = React.createContext<ChatCtxValue>({
  openChat: () => {},
  closeChat: () => {},
  activeDoc: null,
  open: false,
});
export const useChat = () => React.useContext(ChatCtx);

const ENGINE_LABEL: Record<Engine, string> = {
  claude: "Claude",
  codex: "Codex",
  grok: "Grok",
};

export function Providers({ children }: { children: React.ReactNode }) {
  /* toast */
  const [toastMsg, setToastMsg] = React.useState("");
  const [show, setShow] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const toast = React.useCallback((msg: string) => {
    setToastMsg(msg);
    setShow(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setShow(false), 2400);
  }, []);

  /* translation engine — load once from config, persist on change */
  const [engine, setEngineState] = React.useState<Engine>("claude");
  React.useEffect(() => {
    getStatus()
      .then((s) => {
        const e = s.config?.engine as Engine | undefined;
        if (e === "claude" || e === "codex" || e === "grok") setEngineState(e);
      })
      .catch(() => {});
  }, []);
  const setEngine = React.useCallback(
    (e: Engine) => {
      setEngineState(e);
      saveConfig({ engine: e })
        .then(() => toast("Engine dịch: " + ENGINE_LABEL[e]))
        .catch((err) => toast("Lỗi lưu engine: " + (err as Error).message));
    },
    [toast]
  );

  /* chat drawer */
  const [activeDoc, setActiveDoc] = React.useState<ChatDoc | null>(null);
  const [open, setOpen] = React.useState(false);
  const openChat = React.useCallback((doc: ChatDoc) => {
    setActiveDoc(doc);
    setOpen(true);
  }, []);
  const closeChat = React.useCallback(() => setOpen(false), []);

  return (
    <ToastCtx.Provider value={toast}>
      <EngineCtx.Provider value={{ engine, setEngine }}>
        <ChatCtx.Provider value={{ openChat, closeChat, activeDoc, open }}>
          {children}
          <ChatDrawer doc={activeDoc} open={open} onClose={closeChat} />
          <div className={"toast" + (show ? " show" : "")}>{toastMsg}</div>
        </ChatCtx.Provider>
      </EngineCtx.Provider>
    </ToastCtx.Provider>
  );
}
