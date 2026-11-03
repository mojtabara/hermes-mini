-- hermes-mini · migration 0001 — initial schema (Cloudflare D1 / SQLite)
--
-- Conventions (documented for Phase 3):
--   * "today"/clock strings (due_date, due_time) are Tehran-local wall time.
--     Tehran = UTC+03:30 fixed — Iran abolished DST in 2022, so the offset is
--     constant all year; the Worker converts wall time ↔ epoch-ms.
--   * due_ts / remind_at / created_at / done_at are epoch MILLISECONDS (UTC)
--     so comparisons never depend on any server timezone.
--   * The Worker itself has no timezone of its own; "today" is always derived
--     by shifting Date.now() by +210 minutes and reading UTC fields.

CREATE TABLE IF NOT EXISTS tasks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,              -- Telegram user id (the whitelisted owner, R5)
  title       TEXT    NOT NULL,              -- short Persian title produced by the LLM
  due_date    TEXT,                          -- 'YYYY-MM-DD' Gregorian, Tehran-local
  due_time    TEXT,                          -- 'HH:MM' 24h, Tehran-local (NULL = all-day)
  due_ts      INTEGER,                       -- epoch ms of the due moment (NULL = dateless task)
  remind_at   INTEGER,                       -- epoch ms when to remind (NULL = no reminder)
  remind_sent INTEGER NOT NULL DEFAULT 0,    -- 1 once the reminder has fired
  done        INTEGER NOT NULL DEFAULT 0,    -- 1 = checked off
  created_at  INTEGER NOT NULL,              -- epoch ms
  done_at     INTEGER                        -- epoch ms when marked done
);

CREATE INDEX IF NOT EXISTS idx_tasks_list   ON tasks (user_id, done, due_ts);
CREATE INDEX IF NOT EXISTS idx_tasks_remind ON tasks (done, remind_sent, remind_at);

-- Rolling chat memory for conversational replies (R4).
-- history = JSON array of {r:'u'|'b', t:'...'} — user/bot turns, newest last.
CREATE TABLE IF NOT EXISTS memory (
  user_id    INTEGER PRIMARY KEY,
  history    TEXT    NOT NULL DEFAULT '[]',
  updated_at INTEGER NOT NULL
);

-- Small key/value scratchpad: Gemini round-robin cursor, last daily-list date, ...
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
