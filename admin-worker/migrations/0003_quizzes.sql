-- Kanal pollari anonim bo'lishi shart (Telegram cheklovi) — shu sababli viktorina
-- endi native Poll o'rniga inline tugmali xabar orqali yuboriladi.

CREATE TABLE IF NOT EXISTS quizzes (
  quiz_key TEXT PRIMARY KEY, -- `${chatId}:${messageId}`
  correct_index INTEGER NOT NULL,
  options TEXT NOT NULL, -- JSON array
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS quiz_answers (
  quiz_key TEXT NOT NULL,
  user_id INTEGER NOT NULL,
  chosen_index INTEGER NOT NULL,
  is_correct INTEGER NOT NULL,
  answered_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (quiz_key, user_id)
);
