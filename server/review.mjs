// server/review.mjs —— 学习与复习算法：
//   · 学习阶段：取 N 个未学知识点，三档自评任一选择都转为"已学"
//   · 复习阶段：只针对已学知识点，按艾宾浩斯式间隔阶梯安排到期复习
import {
  addDays,
  questionsBySubjects,
  learnedIds,
  dueLearned,
  upsertLearned,
  getProgress,
  logReview,
  questionById,
} from "./db.mjs";

/**
 * 间隔阶梯（天）。下标即 stage。
 * 复习时：认识 → 前进一档；模糊 → 退回一档；忘记 → 重置回第 1 档。
 */
export const STAGES = [1, 2, 4, 7, 15, 30, 60, 90, 180];

/** 第 stage 档对应的间隔天数。 */
export function intervalDays(stage) {
  const i = Math.max(0, Math.min(stage, STAGES.length - 1));
  return STAGES[i];
}

/** 根据自评计算新 stage。 */
export function nextStage(stage, rating) {
  const cur = Number.isFinite(stage) ? stage : 0;
  if (rating === "know") return Math.min(cur + 1, STAGES.length - 1);
  if (rating === "vague") return Math.max(cur - 1, 0);
  if (rating === "forget") return 0;
  throw new Error("未知评价：" + rating);
}

/** 三档评价各自会导致的下次间隔（用于按钮上显示"X天后"）。 */
export function ratingPreviews(stage) {
  return {
    know: intervalDays(nextStage(stage, "know")),
    vague: intervalDays(nextStage(stage, "vague")),
    forget: intervalDays(nextStage(stage, "forget")),
  };
}

/** 已学知识点的三档预览（复习界面的按钮）。 */
export function learnedPreviews(stage) {
  return ratingPreviews(stage);
}

/**
 * 学习界面的三档预览。
 * 首次学习以"第 1 档"为基准套用评价：认识→第 2 档(2天)，模糊/忘记→第 1 档(1天)。
 */
export function freshPreviews() {
  return ratingPreviews(0);
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* ================================================================ 学习 */

/**
 * 取 count 个「未学」知识点用于学习。
 * 只从指定科目范围里取，且排除已学过的。
 */
export function pickUnlearned(userId, subjects, count) {
  const all = questionsBySubjects(subjects);
  const learned = learnedIds(userId);
  const pool = all.filter((q) => !learned.has(q.id));
  const picked = shuffle(pool).slice(0, Math.max(0, count));
  return picked.map((q) => ({
    id: q.id,
    subject: q.subject,
    text: q.text,
    answer: q.answer,
    isNew: true,
    previews: freshPreviews(),
  }));
}

/** 未学知识点总数（用于界面提示还剩多少没学）。 */
export function unlearnedCount(userId, subjects) {
  const all = questionsBySubjects(subjects);
  const learned = learnedIds(userId);
  return all.filter((q) => !learned.has(q.id)).length;
}

/** 已学知识点总数。 */
export function learnedCount(userId, subjects) {
  const all = questionsBySubjects(subjects);
  const learned = learnedIds(userId);
  return all.filter((q) => learned.has(q.id)).length;
}

/**
 * 学习阶段自评：无论选认识 / 模糊 / 忘记，**都转为已学**并开始排复习计划。
 * 评价只影响首次复习的间隔（认识更久，模糊/忘记更近）。
 * @returns {{ stage, intervalDays, nextReview, text, subject, alreadyLearned }}
 */
export function learnQuestion(userId, questionId, rating, today) {
  const q = questionById(questionId);
  if (!q) throw new Error("题目不存在");

  const p = getProgress(userId, questionId);
  if (p && p.status === "learned") {
    // 已经是已学（例如两个设备并发学同一题）：按复习规则推进，避免重复计入
    return { ...rateLearned(userId, questionId, rating, today), alreadyLearned: true };
  }

  const stage = nextStage(0, rating);
  const days = intervalDays(stage);
  const nextReview = addDays(today, days);

  upsertLearned(userId, questionId, stage, nextReview, today);
  logReview(userId, questionId, rating, true, today); // is_new=1 = 学习阶段的首次评价

  return { stage, intervalDays: days, nextReview, text: q.text, subject: q.subject, alreadyLearned: false };
}

/* ================================================================ 复习 */

/**
 * 复习队列：所有**已学**且到期的知识点，全部列出、不限量。
 * 学习界面负责未学知识点，故复习队列不再混入未学内容。
 */
export function dueQueue(userId, today, subjects) {
  return dueLearned(userId, today, subjects).map((r) => ({
    id: r.question_id,
    subject: r.subject,
    text: r.text,
    answer: r.answer,
    stage: r.stage,
    nextReview: r.next_review,
    isNew: false,
    previews: learnedPreviews(r.stage),
  }));
}

/**
 * 复习阶段自评：对「已学」知识点推进阶梯并排下次复习。
 * @returns {{ stage, intervalDays, nextReview, text, subject }}
 */
export function rateLearned(userId, questionId, rating, today) {
  const q = questionById(questionId);
  if (!q) throw new Error("题目不存在");
  const p = getProgress(userId, questionId);
  const curStage = p && p.status === "learned" ? p.stage : 0;
  const stage = nextStage(curStage, rating);
  const days = intervalDays(stage);
  const nextReview = addDays(today, days);

  upsertLearned(userId, questionId, stage, nextReview, today);
  logReview(userId, questionId, rating, false, today); // is_new=0 = 复习阶段的评价

  return { stage, intervalDays: days, nextReview, text: q.text, subject: q.subject };
}

/* ================================================================ 其他 */

/**
 * 随机出题（独立练习功能）：从指定科目随机抽 n 题，不记录学习进度。
 */
export function randomQuestions(subjects, n) {
  const all = questionsBySubjects(subjects);
  const picked = shuffle(all).slice(0, Math.max(0, n));
  return picked.map((q) => ({ id: q.id, subject: q.subject, text: q.text, answer: q.answer }));
}
