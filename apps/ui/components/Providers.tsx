"use client";
// App-wide providers: toast, translation engine (CLI) + agent availability,
// per-document chat drawer.
import * as React from "react";
import { ChatDrawer } from "./ChatDrawer";
import { getStatus, getAgents, saveConfig } from "../lib/api";
import type { AgentDetection, Engine } from "../lib/types";

/* ---------------- Toast ---------------- */
const ToastCtx = React.createContext<(msg: string) => void>(() => {});
export const useToast = () => React.useContext(ToastCtx);

/* ------------- Translation engine (CLI) ------------- */
interface EngineCtxValue {
  engine: Engine;
  setEngine: (e: Engine) => void;
  /** id → available on PATH (from /api/agents) */
  available: Partial<Record<Engine, boolean>>;
  agents: AgentDetection[];
  rescanAgents: () => Promise<void>;
}
const EngineCtx = React.createContext<EngineCtxValue>({
  engine: "claude",
  setEngine: () => {},
  available: {},
  agents: [],
  rescanAgents: async () => {},
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

function mapAvailable(list: AgentDetection[]): Partial<Record<Engine, boolean>> {
  const out: Partial<Record<Engine, boolean>> = {};
  for (const a of list) {
    if (a.id === "claude" || a.id === "codex" || a.id === "grok") {
      out[a.id] = !!a.available;
    }
  }
  return out;
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [toastMsg, setToastMsg] = React.useState("");
  const [show, setShow] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const toast = React.useCallback((msg: string) => {
    setToastMsg(msg);
    setShow(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setShow(false), 2400);
  }, []);

  const [engine, setEngineState] = React.useState<Engine>("claude");
  const [agents, setAgents] = React.useState<AgentDetection[]>([]);
  const [available, setAvailable] = React.useState<
    Partial<Record<Engine, boolean>>
  >({});

  const rescanAgents = React.useCallback(async () => {
    try {
      const a = await getAgents();
      setAgents(a.agents || []);
      setAvailable(mapAvailable(a.agents || []));
    } catch {
      /* ignore */
    }
  }, []);

  React.useEffect(() => {
    getStatus()
      .then((s) => {
        const e = s.config?.engine as Engine | undefined;
        if (e === "claude" || e === "codex" || e === "grok") setEngineState(e);
        if (s.agents?.length) {
          setAgents(s.agents);
          setAvailable(mapAvailable(s.agents));
        }
      })
      .catch(() => {});
    void rescanAgents();
  }, [rescanAgents]);

  const setEngine = React.useCallback(
    (e: Engine) => {
      setEngineState(e);
      saveConfig({ engine: e })
        .then(() => toast("CLI dịch: " + ENGINE_LABEL[e]))
        .catch((err) => toast("Lỗi lưu engine: " + (err as Error).message));
    },
    [toast]
  );

  const [activeDoc, setActiveDoc] = React.useState<ChatDoc | null>(null);
  const [open, setOpen] = React.useState(false);
  const openChat = React.useCallback((doc: ChatDoc) => {
    setActiveDoc(doc);
    setOpen(true);
  }, []);
  const closeChat = React.useCallback(() => setOpen(false), []);

  return (
    <ToastCtx.Provider value={toast}>
      <EngineCtx.Provider
        value={{ engine, setEngine, available, agents, rescanAgents }}
      >
        <ChatCtx.Provider value={{ openChat, closeChat, activeDoc, open }}>
          {children}
          <ChatDrawer doc={activeDoc} open={open} onClose={closeChat} />
          <div className={"toast" + (show ? " show" : "")}>{toastMsg}</div>
        </ChatCtx.Provider>
      </EngineCtx.Provider>
    </ToastCtx.Provider>
  );
}
