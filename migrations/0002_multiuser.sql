-- hermes-mini · migration 0002 — multi-user, categories, editable reminders
--
-- Adds:
--   * users        — the whitelist (R5 generalized): who may talk to the bot,
--                    on which platform. Seeded below with the first users.
--   * tasks.category  — short Persian tag (درس/کار/خرید/...) extracted by the LLM
--   * tasks.remind_minutes — the reminder offset is stored, so "edit" can move
--                    the due time and re-derive remind_at automatically
--   * tasks.platform — tasks are scoped per platform (telegram/bale) so the
--                    same numeric id on two messengers never collides

ALTER TABLE tasks ADD COLUMN category TEXT;
ALTER TABLE tasks ADD COLUMN remind_minutes INTEGER;
ALTER TABLE tasks ADD COLUMN platform TEXT NOT NULL DEFAULT 'telegram';

CREATE TABLE IF NOT EXISTS users (
  platform TEXT    NOT NULL,             -- 'telegram' | 'bale'
  user_id  INTEGER NOT NULL,             -- messenger numeric id
  name     TEXT,
  added_at INTEGER NOT NULL,
  active   INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (platform, user_id)
);

DROP INDEX IF EXISTS idx_tasks_list;
CREATE INDEX IF NOT EXISTS idx_tasks_list2   ON tasks (platform, user_id, done, due_ts);
CREATE INDEX IF NOT EXISTS idx_tasks_remind2 ON tasks (done, remind_sent, remind_at);
CREATE INDEX IF NOT EXISTS idx_tasks_search  ON tasks (platform, user_id, title);

-- First users (platform 'telegram' — numeric ids from the bot's whitelist):
INSERT OR IGNORE INTO users (platform, user_id, name, added_at, active) VALUES
  ('telegram', 7521617758, 'mojtaba',  strftime('%s','now') * 1000, 1),
  ('telegram', 401830681,  NULL,      strftime('%s','now') * 1000, 1),
  ('telegram', 358845666,  NULL,      strftime('%s','now') * 1000, 1);
