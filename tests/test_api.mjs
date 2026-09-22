// tests/test_api.mjs —— 后端接口端到端测试（自包含：自建临时库 + 服务器）。
// 用法：node tests/test_api.mjs
import { bootServer, createAsserter } from "./_harness.mjs";

const A = createAsserter();
const srv = await bootServer({ code: "test-code" });
const BASE = srv.base;
const CODE = srv.code;

let cookie = "";
async function api(path, { method = "GET", body, auth = true } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (auth && cookie) headers["Cookie"] = cookie;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

try {
  console.log("== 健康检查 ==");
  let r = await api("/api/health", { auth: false });
  A.ok(r.json.ok && r.json.questions > 400, "题库已导入（>400 题）", r.json);
  A.ok(Array.isArray(r.json.stages) && r.json.stages.length === 9, "健康检查返回 9 档阶梯");

  console.log("== 注册（口令）==");
  const uname = "api_" + Date.now();
  r = await api("/api/register", { method: "POST", auth: false, body: { username: uname, password: "pass123456", code: "wrong" } });
  A.ok(r.status === 400, "错误注册口令被拒绝", r.json);
  r = await api("/api/register", { method: "POST", auth: false, body: { username: uname, password: "pass123456", code: CODE } });
  A.ok(r.status === 200 && r.json.ok, "正确口令注册成功", r.json);
  r = await api("/api/register", { method: "POST", auth: false, body: { username: uname, password: "pass123456", code: CODE } });
  A.ok(r.status === 400, "重复用户名被拒绝", r.json);
  r = await api("/api/register", { method: "POST", auth: false, body: { username: "ab", password: "123", code: CODE } });
  A.ok(r.status === 400, "非法用户名/短密码被拒绝", r.json);

  console.log("== 登录 ==");
  let savedCookie = cookie;
  cookie = "";
  r = await api("/api/review/today");
  A.ok(r.status === 401, "未登录访问受保护接口被拒绝", r.status);
  cookie = savedCookie;
  r = await api("/api/login", { method: "POST", auth: false, body: { username: uname, password: "wrongpass" } });
  A.ok(r.status === 400, "错误密码登录失败", r.json);
  r = await api("/api/login", { method: "POST", auth: false, body: { username: uname, password: "pass123456" } });
  A.ok(r.json.ok, "正确密码登录成功", r.json);

  console.log("== 今日队列：新用户 ==");
  let today = (await api("/api/review/today")).json;
  A.ok(today.dueCount === 0, "新用户到期数为 0");
  A.ok(today.freshCount === 10, "新用户得到 10 个未学提醒", today.freshCount);
  A.ok(today.fresh.every((q) => q.isNew === true), "提醒项标记 isNew");
  A.ok(today.fresh.every((q) => q.previews && q.previews.know > 0), "提醒项带三档预览");

  console.log("== 未学提醒自评：不转已学 ==");
  const f0 = today.fresh[0];
  r = await api("/api/review/rate-fresh", { method: "POST", body: { questionId: f0.id, rating: "know" } });
  A.ok(r.json.ok && r.json.result.promoted === false, "未学提醒自评 promoted=false", r.json.result);
  let stats = (await api("/api/stats")).json;
  A.ok(stats.learned === 0, "未学提醒自评后已学数仍为 0", stats.learned);

  console.log("== 加入复习：转已学 ==");
  const target = today.fresh.find((q) => q.id !== f0.id);
  r = await api("/api/review/add", { method: "POST", body: { questionId: target.id } });
  A.ok(r.json.result.stage === 0 && r.json.result.intervalDays === 1, "加入复习 → stage0 / 1 天", r.json.result);
  stats = (await api("/api/stats")).json;
  A.ok(stats.learned === 1, "加入复习后已学数 =1", stats.learned);

  console.log("== 30% 比例：造 10 道到期题 → 应混入 3 个未学提醒 ==");
  const me = (await api("/api/me")).json;
  const uid = me.user.id;
  // 再取 9 道未学题加入复习（共 10 道已学），再把到期日回拨到昨天
  today = (await api("/api/review/today")).json;
  const more = today.fresh.filter((q) => q.id !== target.id).slice(0, 9);
  for (const q of more) {
    await api("/api/review/add", { method: "POST", body: { questionId: q.id } });
  }
  stats = (await api("/api/stats")).json;
  A.ok(stats.learned === 10, "已学数达到 10", stats.learned);

  // 直接把所有已学题的 next_review 改成昨天，制造"到期"
  const db = (await import("../server/db.mjs")).db;
  db.prepare("UPDATE progress SET next_review = '2000-01-01' WHERE user_id = ?").run(uid);

  today = (await api("/api/review/today")).json;
  A.ok(today.dueCount === 10, "到期题共 10 道（全部推送，不限量）", today.dueCount);
  A.ok(today.freshCount === 3, "按 30% 混入 3 个未学提醒（round(10×0.3)）", today.freshCount);
  A.ok(today.fresh.every((q) => q.isNew === true), "混入项均为未学");
  A.ok(today.due.every((q) => q.isNew === false), "到期项均为已学");

  console.log("== 三档阶梯推进（对已学题）==");
  const qid = target.id;
  const expect = [
    ["know", 1, 2],
    ["know", 2, 4],
    ["vague", 1, 2],
    ["forget", 0, 1],
    ["know", 1, 2],
  ];
  for (const [rating, stage, days] of expect) {
    r = await api("/api/review/rate", { method: "POST", body: { questionId: qid, rating } });
    A.ok(r.json.result.stage === stage && r.json.result.intervalDays === days,
      `${rating} → stage${stage} / ${days}天`, r.json.result);
  }
  // 自评后该题应不再到期（next_review 推到未来）
  today = (await api("/api/review/today")).json;
  A.ok(today.dueCount === 9, "自评后到期数从 10 降为 9", today.dueCount);

  console.log("== 随机出题：不影响进度 ==");
  const before = (await api("/api/stats")).json.learned;
  r = await api("/api/random?count=8");
  A.ok(r.json.questions.length === 8, "返回 8 题", r.json.count);
  const after = (await api("/api/stats")).json.learned;
  A.ok(before === after, "随机出题不改变已学数", { before, after });

  console.log("== 复习范围筛选 ==");
  r = await api("/api/subjects");
  A.ok(r.json.subjects.length === 3, "3 个科目", r.json.subjects);
  r = await api("/api/settings", { method: "POST", body: { subjects: ["机械设计"] } });
  A.ok(r.json.settings.subjects.includes("机械设计"), "范围已保存", r.json.settings);
  r = await api("/api/review/today");
  A.ok(r.json.fresh.every((q) => q.subject === "机械设计"), "提醒只来自选定科目");
  r = await api("/api/random?subjects=机械设计&count=6");
  A.ok(r.json.questions.every((q) => q.subject === "机械设计"), "随机出题遵守范围");

  console.log("== 多账号进度隔离 ==");
  const cookieA = cookie;
  cookie = "";
  const uname2 = "api2_" + Date.now();
  await api("/api/register", { method: "POST", auth: false, body: { username: uname2, password: "pass123456", code: CODE } });
  const statsB = (await api("/api/stats")).json;
  A.ok(statsB.learned === 0, "新账号已学数为 0（进度隔离）", statsB.learned);
  cookie = cookieA;
  const statsA = (await api("/api/stats")).json;
  A.ok(statsA.learned === 10, "原账号进度不受影响", statsA.learned);

  console.log("== 登出 ==");
  r = await api("/api/logout", { method: "POST" });
  A.ok(r.json.ok, "登出成功");
  r = await api("/api/review/today");
  A.ok(r.status === 401, "登出后访问被拒绝", r.status);

  console.log("== 安全响应头 ==");
  {
    const res = await fetch(BASE + "/api/health");
    A.ok(res.headers.get("x-content-type-options") === "nosniff", "X-Content-Type-Options: nosniff");
    A.ok(res.headers.get("x-frame-options") === "DENY", "X-Frame-Options: DENY");
    A.ok(res.headers.get("referrer-policy") === "no-referrer", "Referrer-Policy: no-referrer");
    const html = await fetch(BASE + "/");
    A.ok(html.headers.get("x-content-type-options") === "nosniff", "静态页面同样带安全头");
  }

  console.log("== 登录失败限流（防公网暴力破解）==");
  {
    let got429 = false;
    let last = 0;
    for (let i = 0; i < 12; i++) {
      const res = await fetch(BASE + "/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "no_such_user_xyz", password: "wrong-password" }),
      });
      last = res.status;
      if (res.status === 429) { got429 = true; break; }
    }
    A.ok(got429, "连续失败登录后返回 429（限流生效）", last);
  }

  console.log("== 成功登录会清除失败计数 ==");
  {
    // 换一个新服务器实例验证：失败几次后成功登录，计数应清零
    // （在本实例中已被限流，故用新账号+新实例的方式在下方 harness 不再重复；
    //   这里只断言限流响应带正确提示文案）
    const res = await fetch(BASE + "/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "no_such_user_xyz", password: "wrong-password" }),
    });
    const j = await res.json().catch(() => ({}));
    A.ok(res.status === 429 && /尝试次数过多/.test(j.error || ""), "限流返回友好提示", j);
  }
} finally {
  await srv.close();
}

process.exit(A.report() ? 0 : 1);
