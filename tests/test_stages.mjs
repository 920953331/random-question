// tests/test_stages.mjs —— 复习算法纯逻辑单元测试（不需要数据库/网络）。
// 用法：node tests/test_stages.mjs
import { STAGES, intervalDays, nextStage, ratingPreviews } from "../server/review.mjs";

let pass = 0, fail = 0;
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log("  ok:", msg); }
  else { fail++; console.error("  FAIL:", msg, extra !== undefined ? JSON.stringify(extra) : ""); }
}

console.log("== 间隔阶梯定义 ==");
ok(Array.isArray(STAGES) && STAGES.length === 9, "共 9 档", STAGES.length);
ok(JSON.stringify(STAGES) === JSON.stringify([1, 2, 4, 7, 15, 30, 60, 90, 180]), "阶梯为 1→2→4→7→15→30→60→90→180", STAGES);

console.log("== intervalDays ==");
ok(intervalDays(0) === 1, "stage0 → 1 天");
ok(intervalDays(8) === 180, "stage8 → 180 天");
ok(intervalDays(99) === 180, "超界 stage 被夹到最后一档");
ok(intervalDays(-5) === 1, "负 stage 被夹到第 1 档");

console.log("== nextStage：认识进档 ==");
ok(nextStage(0, "know") === 1, "stage0 认识 → 1");
ok(nextStage(3, "know") === 4, "stage3 认识 → 4");
ok(nextStage(8, "know") === 8, "最高档认识不再前进（封顶）");

console.log("== nextStage：模糊退档 ==");
ok(nextStage(4, "vague") === 3, "stage4 模糊 → 3");
ok(nextStage(1, "vague") === 0, "stage1 模糊 → 0");
ok(nextStage(0, "vague") === 0, "第 1 档模糊不越界（最低 0）");

console.log("== nextStage：忘记重置 ==");
ok(nextStage(7, "forget") === 0, "stage7 忘记 → 0");
ok(nextStage(0, "forget") === 0, "stage0 忘记 → 0");

console.log("== nextStage：非法输入 ==");
let threw = false;
try { nextStage(0, "unknown"); } catch { threw = true; }
ok(threw, "未知评价抛错");

console.log("== ratingPreviews：按钮上的「X天后」 ==");
const p0 = ratingPreviews(0);
ok(p0.know === 2, "stage0：认识显示 2 天后", p0);
ok(p0.vague === 1, "stage0：模糊显示 1 天后", p0);
ok(p0.forget === 1, "stage0：忘记显示 1 天后", p0);

const p5 = ratingPreviews(5); // stage5 = 30 天
ok(p5.know === 60, "stage5(30天)：认识 → 60 天后", p5);
ok(p5.vague === 15, "stage5(30天)：模糊 → 15 天后", p5);
ok(p5.forget === 1, "stage5(30天)：忘记 → 1 天后", p5);

const p8 = ratingPreviews(8); // 最高档
ok(p8.know === 180, "最高档：认识仍 180 天后（封顶）", p8);

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
