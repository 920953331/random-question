// server/review.mjs —— 复习算法：艾宾浩斯式间隔阶梯、三档自评推进、今日队列。
import {
  addDays,
  questionsBySubjects,
  learnedIds,
  dueLearned,
  upsertLearned,
  getProgress,
  logReview,
  newRemindCounts,
  remindedTodayIds,
  questionById,
} from "./db.mjs";

/**
 * 间隔阶梯（天）。下标即 stage。
 * 认识 → 前进一档；模糊 → 退回一档；忘记 → 重置回第 1 档。
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

/**
 * 计算今日队列。
 * @returns {{ due: Array, fresh: Array }}
 *   due   = 到期待复习的已学知识点（不限量）
 *   fresh = 额外混入的未学知识点（约 due 数量的 30%，仅提醒、可评价但不转已学）
 */
export function todayQueue(userId, today, opts = {}) {
  const subjects = opts.subjects || [];
  const freshRatio = opts.freshRatio ?? 0.3;
  const freshWhenEmpty = opts.freshWhenEmpty ?? 10;

  const dueRows = dueLearned(userId, today, subjects);

  const due = dueRows.map((r) => ({
    id: r.question_id,
    subject: r.subject,
    text: r.text,
    answer: r.answer,
    stage: r.stage,
    nextReview: r.next_review,
    isNew: false,
    previews: ratingPreviews(r.stage),
  }));

  // 未学提醒数量：到期数的 30%；若今日 0 到期，则给一批起步量
  const want = due.length > 0 ? Math.round(due.length * freshRatio) : freshWhenEmpty;

  const fresh = want > 0 ? pickFresh(userId, today, subjects, want) : [];

  return { due, fresh };
}

/**
 * 从"未学池"里挑 fresh 个知识点作为提醒。
 * 优先：从未提醒过的 → 提醒次数少的 → 随机；同一天内不重复提醒同一题。
 */
export function pickFresh(userId, today, subjects, want) {
  const all = questionsBySubjects(subjects);
  const learned = learnedIds(userId);
  const counts = newRemindCounts(userId);
  const remindedToday = remindedTodayIds(userId, today);

  const isNew = (q) => !learned.has(q.id);

  // 第一优先池：未学 且 今天未提醒过
  let pool = all.filter((q) => isNew(q) && !remindedToday.has(q.id));
  // 若不够，放宽"今天未提醒过"的限制（避免提醒量不足）
  if (pool.length < want) {
    pool = all.filter(isNew);
  }

  // 按提醒次数升序，再随机打散
  const shuffled = shuffle(pool);
  shuffled.sort((a, b) => (counts.get(a.id) || 0) - (counts.get(b.id) || 0));

  return shuffled.slice(0, want).map((q) => ({
    id: q.id,
    subject: q.subject,
    text: q.text,
    answer: q.answer,
    isNew: true,
    remindedBefore: counts.get(q.id) || 0,
    previews: ratingPreviews(0),
  }));
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * 对「已学」知识点自评：推进阶梯并排下次复习。
 * @returns {{ stage:number, intervalDays:number, nextReview:string }}
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
  logReview(userId, questionId, rating, false, today);

  return { stage, intervalDays: days, nextReview, text: q.text, subject: q.subject };
}

/**
 * 对「未学」知识点（30% 提醒）自评：只记流水，不转已学、不排复习计划。
 * @returns {{ promoted:false, recorded:true }}
 */
export function rateFresh(userId, questionId, rating, today) {
  const q = questionById(questionId);
  if (!q) throw new Error("题目不存在");
  const p = getProgress(userId, questionId);
  if (p && p.status === "learned") {
    // 已经是已学题，按已学规则处理（防止前端串了状态）
    return { promoted: false, recorded: true, redirect: "learned", ...rateLearned(userId, questionId, rating, today) };
  }
  logReview(userId, questionId, rating, true, today);
  return { promoted: false, recorded: true };
}

/**
 * 把未学知识点「加入复习」：转为已学，从第 1 档开始排计划（次日复习）。
 */
export function addToReview(userId, questionId, today) {
  const q = questionById(questionId);
  if (!q) throw new Error("题目不存在");
  const stage = 0;
  const days = intervalDays(stage);
  const nextReview = addDays(today, days);
  upsertLearned(userId, questionId, stage, nextReview, today);
  return { stage, intervalDays: days, nextReview, text: q.text, subject: q.subject };
}

/**
 * 随机出题（保留的原功能）：从指定科目随机抽 n 题，不记录学习进度。
 */
export function randomQuestions(subjects, n) {
  const all = questionsBySubjects(subjects);
  const picked = shuffle(all).slice(0, Math.max(0, n));
  return picked.map((q) => ({ id: q.id, subject: q.subject, text: q.text, answer: q.answer }));
}
