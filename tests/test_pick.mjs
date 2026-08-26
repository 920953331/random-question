// 校验 src/template.html 内嵌的核心出题算法：随机、不重复、数量。
// 直接内联复刻逻辑，用题库数据跑几轮断言。
import { readFileSync } from "node:fs";

function pick(n, questions) {
  var pool = questions.slice();
  var out = [];
  for (var i = 0; i < n && pool.length > 0; i++) {
    var r = Math.floor(Math.random() * pool.length);
    out.push(pool.splice(r, 1)[0]);
  }
  return out;
}
function shuffle(arr) {
  var a = arr.slice(), i, r, t;
  for (i = a.length - 1; i > 0; i--) {
    r = Math.floor(Math.random() * (i + 1));
    t = a[i]; a[i] = a[r]; a[r] = t;
  }
  return a;
}

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log("  ok:", msg); }
  else { fail++; console.error("  FAIL:", msg); }
}

// 构造模拟题库
const mock = [];
for (let i = 0; i < 100; i++) mock.push({ q: "题" + i, a: "" });

// 1) 抽取数量正确
let r = pick(10, mock);
assert(r.length === 10, "抽取10题得到10题");

// 2) 不重复（相同题目不出现两次）
const seen = new Set(r.map(x => x.q));
assert(seen.size === 10, "10题无重复");

// 3) 抽取超过题库数量时，返回全部且不重复
r = pick(200, mock);
assert(r.length === 100 && new Set(r.map(x => x.q)).size === 100, "超量抽取返回全部且不重复");

// 4) 随机性：两次抽取顺序不同（大概率）
const r1 = pick(20, mock).map(x => x.q);
const r2 = pick(20, mock).map(x => x.q);
assert(JSON.stringify(r1) !== JSON.stringify(r2), "两次抽取顺序不同(随机性)");

// 5) shuffle 保持集合不变
const shuffled = shuffle(mock);
assert(shuffled.length === mock.length, "shuffle 长度不变");
assert(new Set(shuffled.map(x => x.q)).size === 100, "shuffle 不改变题目集合");

// 6) 多科目合并再抽取（模拟前端把多个科目 concat 后 shuffle+pick）
const subjA = mock.slice(0, 40), subjB = mock.slice(40, 100);
let all = subjA.concat(subjB);
all = shuffle(all);
const picked = pick(15, all);
assert(picked.length === 15 && new Set(picked.map(x => x.q)).size === 15, "多科目合并后抽取15题无重复");

// 7) 空输入处理
assert(pick(5, []).length === 0, "空题库返回空");
assert(pick(0, mock).length === 0, "量0返回空");

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
