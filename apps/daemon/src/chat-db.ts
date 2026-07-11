// SQLite-backed persistence for per-document chat, mirroring open-design's
// projects → conversations → messages → agent_sessions model. Here a
// "project" is a document tag; each tag can hold many conversations, each with
// its own transcript and per-engine CLI session id (for resume across reloads).
//
// The whole module degrades gracefully: if better-sqlite3 fails to load (e.g.
// an ABI mismatch inside a packaged Electron build), getDb() returns null, the
// daemon logs once, and the chat routes report persist:false so the UI falls
// back to in-memory conversations instead of crashing.
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { TOOL_DIR } from "./paths.js";

// Load the native module through a real CJS require. A static ESM `import` of a
// native addon can trip both tsx (dev) and the esbuild bundle; createRequire is
// the portable escape hatch that works in both.
const requireCjs = createRequire(import.meta.url);

// Loaded lazily so a missing/broken native module never crashes daemon startup.
type SqliteDb = import("better-sqlite3").Database;

export interface ConversationRow {
  id: string;
  tag: string;
  title: string | null;
  engine: string | null;
  created_at: number;
  updated_at: number;
}
export interface ConversationMeta extends ConversationRow {
  msg_count: number;
}
export interface MessageRow {
  id: string;
  role: string;
  text: string;
  engine: string | null;
  position: number;
  created_at: number;
}
export interface SaveMessage {
  id?: string;
  role: string;
  text: string;
  engine?: string | null;
}

let db: SqliteDb | null = null;
let initTried = false;

function getDb(): SqliteDb | null {
  if (initTried) return db;
  initTried = true;
  try {
    // Synchronous require keeps this off the ESM top level so a load failure is
    // catchable rather than fatal at import time.
    const Database = requireCjs("better-sqlite3") as typeof import("better-sqlite3");
    mkdirSync(TOOL_DIR, { recursive: true });
    const file = join(TOOL_DIR, "chat.sqlite");
    const d = new Database(file);
    d.pragma("journal_mode = WAL");
    d.pragma("foreign_keys = ON");
    d.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        tag TEXT NOT NULL,
        title TEXT,
        engine TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_conv_tag
        ON conversations(tag, updated_at DESC);

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        engine TEXT,
        position INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_msg_conv
        ON messages(conversation_id, position);

      CREATE TABLE IF NOT EXISTS agent_sessions (
        conversation_id TEXT NOT NULL,
        engine TEXT NOT NULL,
        session_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (conversation_id, engine),
        FOREIGN KEY(conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
      );
    `);
    db = d;
  } catch (e) {
    console.error(
      "[chat-db] SQLite không khả dụng — tắt lưu hội thoại:",
      e instanceof Error ? e.message : String(e)
    );
    db = null;
  }
  return db;
}

export function chatDbReady(): boolean {
  return !!getDb();
}

export function listConversations(tag: string): ConversationMeta[] {
  const d = getDb();
  if (!d) return [];
  return d
    .prepare(
      `SELECT c.*,
        (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS msg_count
       FROM conversations c WHERE c.tag = ? ORDER BY c.updated_at DESC`
    )
    .all(tag) as ConversationMeta[];
}

export function createConversation(
  tag: string,
  title: string | null,
  engine: string | null
): ConversationRow {
  const d = getDb();
  if (!d) throw new Error("SQLite không khả dụng");
  const now = Date.now();
  const id = randomUUID();
  d.prepare(
    `INSERT INTO conversations (id, tag, title, engine, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, tag, title, engine, now, now);
  return { id, tag, title, engine, created_at: now, updated_at: now };
}

export function deleteConversation(id: string): boolean {
  const d = getDb();
  if (!d) return false;
  return d.prepare(`DELETE FROM conversations WHERE id = ?`).run(id).changes > 0;
}

export function getConversation(id: string): {
  conversation: ConversationRow | null;
  messages: MessageRow[];
  sessions: Record<string, string>;
} {
  const d = getDb();
  if (!d) return { conversation: null, messages: [], sessions: {} };
  const conversation =
    (d.prepare(`SELECT * FROM conversations WHERE id = ?`).get(id) as
      | ConversationRow
      | undefined) || null;
  if (!conversation) return { conversation: null, messages: [], sessions: {} };
  const messages = d
    .prepare(
      `SELECT id, role, text, engine, position, created_at
       FROM messages WHERE conversation_id = ? ORDER BY position`
    )
    .all(id) as MessageRow[];
  const sessRows = d
    .prepare(`SELECT engine, session_id FROM agent_sessions WHERE conversation_id = ?`)
    .all(id) as { engine: string; session_id: string }[];
  const sessions: Record<string, string> = {};
  for (const r of sessRows) sessions[r.engine] = r.session_id;
  return { conversation, messages, sessions };
}

// Full snapshot replace: the client owns transcript assembly, so each save
// rewrites the conversation's messages and session map atomically. Transcripts
// are small (tens of rows), so a delete+reinsert is simpler and safe.
export function saveConversation(
  id: string,
  opts: {
    title?: string | null;
    engine?: string | null;
    messages: SaveMessage[];
    sessions?: Record<string, string>;
  }
): boolean {
  const d = getDb();
  if (!d) return false;
  if (!d.prepare(`SELECT id FROM conversations WHERE id = ?`).get(id)) return false;
  const now = Date.now();
  const tx = d.transaction(() => {
    // COALESCE keeps the existing value when a field is not supplied.
    d.prepare(
      `UPDATE conversations
       SET updated_at = ?, title = COALESCE(?, title), engine = COALESCE(?, engine)
       WHERE id = ?`
    ).run(now, opts.title ?? null, opts.engine ?? null, id);

    d.prepare(`DELETE FROM messages WHERE conversation_id = ?`).run(id);
    const ins = d.prepare(
      `INSERT INTO messages (id, conversation_id, role, text, engine, position, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    opts.messages.forEach((m, i) => {
      ins.run(m.id || randomUUID(), id, m.role, m.text, m.engine ?? null, i, now);
    });

    if (opts.sessions) {
      d.prepare(`DELETE FROM agent_sessions WHERE conversation_id = ?`).run(id);
      const si = d.prepare(
        `INSERT INTO agent_sessions (conversation_id, engine, session_id, updated_at)
         VALUES (?, ?, ?, ?)`
      );
      for (const [eng, sid] of Object.entries(opts.sessions)) {
        if (sid) si.run(id, eng, sid, now);
      }
    }
  });
  tx();
  return true;
}
