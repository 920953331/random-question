// server/db.mjs —— SQLite 数据库层：打开数据库、建表、常用查询封装。
// 依赖 Node 24 内置的 node:sqlite（零外部依赖）。
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WS = join(__dirname, "..");

/** 数据库文件路径：可用环境变量 DB_PATH 覆盖（部署时指向持久化目录）。 */
export const DB_PATH = process.env.DB_PATH || join(WS, "var", "learning.db");

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);

// 性能与一致性设置
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

/** 建表（幂等）。 */
export function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      salt          TEXT NOT NULL,
      created_at    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS questions (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      subject TEXT NOT NULL,
      text    TEXT NOT NULL,
      answer  TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_questions_subject ON questions(subject);

    -- 每个用户对每道题的学习进度
    CREATE TABLE IF NOT EXISTS progress (
      user_id     INTEGER NOT NULL,
      question_id INTEGER NOT NULL,
      status      TEXT NOT NULL DEFAULT 'new',   -- new | learned
      stage       INTEGER NOT NULL DEFAULT 0,    -- 间隔阶梯下标
      next_review TEXT,                          -- YYYY-MM-DD（仅 learned 有意义）
      last_review TEXT,
      review_count INTEGER NOT NULL DEFAULT 0,
      added_at    TEXT,
      PRIMARY KEY (user_id, question_id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_progress_due ON progress(user_id, status, next_review);

    -- 每次自评的流水（用于统计）
    CREATE TABLE IF NOT EXISTS review_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL,
      question_id INTEGER NOT NULL,
      rating      TEXT NOT NULL,                 -- know | vague | forget
      is_new      INTEGER NOT NULL DEFAULT 0,    -- 1=对新知识点的提醒评价
      day         TEXT NOT NULL,                 -- YYYY-MM-DD
      created_at  TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_log_user_day ON review_log(user_id, day);

    -- 用户设置（复习范围等）
    CREATE TABLE IF NOT EXISTS settings (
      user_id  INTEGER PRIMARY KEY,
      subjects TEXT NOT NULL DEFAULT '[]',       -- JSON 数组
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);
}

/* ---------------------------------------------------------------- 日期工具 */

/** 返回本地日期字符串 YYYY-MM-DD。 */
export function ymd(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 在 today(YYYY-MM-DD) 基础上加 n 天，返回 YYYY-MM-DD。 */
export function addDays(todayStr, n) {
  const [y, m, d] = todayStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  return ymd(dt);
}

/* ---------------------------------------------------------------- 用户 */

export function createUser(username, passwordHash, salt) {
  const now = new Date().toISOString();
  const info = db
    .prepare("INSERT INTO users (username, password_hash, salt, created_at) VALUES (?,?,?,?)")
    .run(username, passwordHash, salt, now);
  db.prepare("INSERT INTO settings (user_id, subjects) VALUES (?, '[]')").run(info.lastInsertRowid);
  return info.lastInsertRowid;
}

export function findUserByName(username) {
  return db.prepare("SELECT * FROM users WHERE username = ?").get(username);
}

export function findUserById(id) {
  return db.prepare("SELECT id, username, created_at FROM users WHERE id = ?").get(id);
}

/* ---------------------------------------------------------------- 会话 */

export function createSession(token, userId, expiresAt) {
  db.prepare("INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?,?,?,?)").run(
    token,
    userId,
    new Date().toISOString(),
    expiresAt
  );
}

export function findSession(token) {
  return db.prepare("SELECT * FROM sessions WHERE token = ?").get(token);
}

export function deleteSession(token) {
  db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
}

export function purgeExpiredSessions(nowIso) {
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(nowIso);
}

/* ---------------------------------------------------------------- 题库 */

export function countQuestions() {
  return db.prepare("SELECT COUNT(*) AS c FROM questions").get().c;
}

export function listSubjects() {
  return db
    .prepare("SELECT subject, COUNT(*) AS count FROM questions GROUP BY subject ORDER BY subject")
    .all();
}

/** 按科目范围取题目（subjects 为空数组 = 全部）。 */
export function questionsBySubjects(subjects) {
  if (!subjects || subjects.length === 0) {
    return db.prepare("SELECT id, subject, text, answer FROM questions").all();
  }
  const ph = subjects.map(() => "?").join(",");
  return db
    .prepare(`SELECT id, subject, text, answer FROM questions WHERE subject IN (${ph})`)
    .all(...subjects);
}

export function questionById(id) {
  return db.prepare("SELECT id, subject, text, answer FROM questions WHERE id = ?").get(id);
}

export function insertQuestion(subject, text, answer) {
  const info = db
    .prepare("INSERT INTO questions (subject, text, answer) VALUES (?,?,?)")
    .run(subject, text, answer || "");
  return info.lastInsertRowid;
}

export function clearQuestions() {
  db.exec("DELETE FROM questions");
}

/* ---------------------------------------------------------------- 进度 */

export function getProgress(userId, questionId) {
  return db
    .prepare("SELECT * FROM progress WHERE user_id = ? AND question_id = ?")
    .get(userId, questionId);
}

/** 某用户所有已学题目的 id 集合。 */
export function learnedIds(userId) {
  return new Set(
    db
      .prepare("SELECT question_id FROM progress WHERE user_id = ? AND status = 'learned'")
      .all(userId)
      .map((r) => r.question_id)
  );
}

/** 到期需复习的已学题目（next_review <= today）。 */
export function dueLearned(userId, today, subjects) {
  let sql = `SELECT p.question_id, p.stage, p.next_review, q.subject, q.text, q.answer
             FROM progress p JOIN questions q ON q.id = p.question_id
             WHERE p.user_id = ? AND p.status = 'learned' AND p.next_review <= ?`;
  const args = [userId, today];
  if (subjects && subjects.length > 0) {
    sql += ` AND q.subject IN (${subjects.map(() => "?").join(",")})`;
    args.push(...subjects);
  }
  sql += " ORDER BY p.next_review ASC, p.question_id ASC";
  return db.prepare(sql).all(...args);
}

/** 写入/更新某题的已学进度。 */
export function upsertLearned(userId, questionId, stage, nextReview, today) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO progress (user_id, question_id, status, stage, next_review, last_review, review_count, added_at)
     VALUES (?,?, 'learned', ?, ?, ?, 0, ?)
     ON CONFLICT(user_id, question_id) DO UPDATE SET
       status = 'learned',
       stage = excluded.stage,
       next_review = excluded.next_review,
       last_review = excluded.last_review,
       review_count = progress.review_count + 1`
  ).run(userId, questionId, stage, nextReview, today, now);
}

/* ---------------------------------------------------------------- 自评流水 */

export function logReview(userId, questionId, rating, isNew, day) {
  db.prepare(
    "INSERT INTO review_log (user_id, question_id, rating, is_new, day, created_at) VALUES (?,?,?,?,?,?)"
  ).run(userId, questionId, rating, isNew ? 1 : 0, day, new Date().toISOString());
}

/** 统计每个未学题被"新知识点提醒"过的次数：Map<questionId, count>。 */
export function newRemindCounts(userId) {
  const rows = db
    .prepare(
      `SELECT question_id, COUNT(*) AS c FROM review_log
       WHERE user_id = ? AND is_new = 1 GROUP BY question_id`
    )
    .all(userId);
  const m = new Map();
  for (const r of rows) m.set(r.question_id, r.c);
  return m;
}

/** 某用户当天已提醒过的未学题 id 集合（避免同一天重复提醒同一题）。 */
export function remindedTodayIds(userId, day) {
  return new Set(
    db
      .prepare(
        "SELECT DISTINCT question_id FROM review_log WHERE user_id = ? AND is_new = 1 AND day = ?"
      )
      .all(userId, day)
      .map((r) => r.question_id)
  );
}

/* ---------------------------------------------------------------- 统计 */

export function statsByStage(userId) {
  return db
    .prepare(
      `SELECT stage, COUNT(*) AS c FROM progress
       WHERE user_id = ? AND status = 'learned' GROUP BY stage ORDER BY stage`
    )
    .all(userId);
}

export function countLearned(userId) {
  return db
    .prepare("SELECT COUNT(*) AS c FROM progress WHERE user_id = ? AND status = 'learned'")
    .get(userId).c;
}

export function countDue(userId, today) {
  return db
    .prepare(
      "SELECT COUNT(*) AS c FROM progress WHERE user_id = ? AND status = 'learned' AND next_review <= ?"
    )
    .get(userId, today).c;
}

export function countReviews(userId) {
  return db
    .prepare("SELECT COUNT(*) AS c FROM review_log WHERE user_id = ? AND is_new = 0")
    .get(userId).c;
}

export function ratingBreakdown(userId) {
  return db
    .prepare(
      `SELECT rating, COUNT(*) AS c FROM review_log
       WHERE user_id = ? AND is_new = 0 GROUP BY rating`
    )
    .all(userId);
}

/** 近 n 天的复习量（含新知识点提醒），用于统计页趋势。 */
export function recentActivity(userId, days) {
  return db
    .prepare(
      `SELECT day, SUM(CASE WHEN is_new = 0 THEN 1 ELSE 0 END) AS reviews,
                    SUM(CASE WHEN is_new = 1 THEN 1 ELSE 0 END) AS reminders
       FROM review_log WHERE user_id = ? GROUP BY day ORDER BY day DESC LIMIT ?`
    )
    .all(userId, days);
}

/* ---------------------------------------------------------------- 设置 */

export function getSettings(userId) {
  let row = db.prepare("SELECT * FROM settings WHERE user_id = ?").get(userId);
  if (!row) {
    db.prepare("INSERT INTO settings (user_id, subjects) VALUES (?, '[]')").run(userId);
    row = { user_id: userId, subjects: "[]" };
  }
  let subjects = [];
  try {
    subjects = JSON.parse(row.subjects || "[]");
  } catch {
    subjects = [];
  }
  return { subjects: Array.isArray(subjects) ? subjects : [] };
}

export function setSubjects(userId, subjects) {
  const json = JSON.stringify(subjects || []);
  db.prepare(
    `INSERT INTO settings (user_id, subjects) VALUES (?, ?)
     ON CONFLICT(user_id) DO UPDATE SET subjects = excluded.subjects`
  ).run(userId, json);
}
