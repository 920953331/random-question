// tests/test_api.mjs —— 后端接口端到端测试（自包含：自建临时库 + 服务器）。
// 覆盖：注册登录 / 学习（三档都转已学）/ 复习（仅已学+阶梯）/ 统计 / 隔离 / 边界 / 安全
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
  return { status: res.status, json, headers: res.headers };
}

try {
  console.log("== 健康检查 ==");
  let r = await api("/api/health", { auth: false });
  A.ok(r.json.ok && r.json.questions > 400, "题库已导入（>400 题）", r.json);
  A.ok(JSON.stringify(r.json.stages) === JSON.stringify([1,2,4,7,15,30,60,90,180]), "9 档阶梯正确");

  console.log("== 注册（口令）==");
  const uname = "api_" + Date.now();
  r = await api("/api/register", { method: "POST", auth: false, body: { username: uname, password: "pass123456", code: "wrong" } });
  A.ok(r.status === 400, "错误注册口令被拒绝", r.json);
  r = await api("/api/register", { method: "POST", auth: false, body: { username: uname, password: "pass123456", code: CODE } });
  A.ok(r.status === 200 && r.json.ok, "正确口令注册成功", r.json);
  r = await api("/api/register", { method: "POST", auth: false, body: { username: uname, password: "pass123456", code: CODE } });
  A.ok(r.status === 400, "重复用户名被拒绝", r.json);

  console.log("== 未登录拒绝 ==");
  const savedCookie = cookie;
  cookie = "";
  r = await api("/api/learn/next?count=5");
  A.ok(r.status === 401, "未登录取学习内容被拒绝", r.status);
  r = await api("/api/review/today");
  A.ok(r.status === 401, "未登录取复习队列被拒绝", r.status);
  cookie = savedCookie;

  console.log("== 学习概览（新用户）==");
  r = await api("/api/learn/summary");
  A.ok(r.json.learned === 0, "新用户已学数 0", r.json.learned);
  A.ok(r.json.remaining === 495, "新用户未学数 495", r.json.remaining);

  console.log("== 学习：取 20 个未学知识点（默认批量）==");
  r = await api("/api/learn/next?count=20");
  A.ok(r.status === 200 && r.json.questions.length === 20, "返回 20 个未学知识点", r.json.count);
  A.ok(r.json.questions.every((q) => q.isNew === true && q.text), "均为未学且含题目文本");
  A.ok(r.json.questions.every((q) => q.previews && q.previews.know > 0), "带三档预览", r.json.questions[0].previews);
  const batch = r.json.questions;

  console.log("== 学习：不传 count 时默认 20 ==");
  r = await api("/api/learn/next");
  A.ok(r.json.questions.length === 20, "默认返回 20 个", r.json.count);

  console.log("== 学习：三档评价任一都转为「已学」==");
  // 认识 → 第2档(2天)
  r = await api("/api/learn/rate", { method: "POST", body: { questionId: batch[0].id, rating: "know" } });
  A.ok(r.json.ok && r.json.result.stage === 1 && r.json.result.intervalDays === 2,
    "学习时选「认识」→ 已学 + stage1/2天", r.json.result);
  A.ok(r.json.result.alreadyLearned === false, "首次学习标记正确");
  // 模糊 → 第1档(1天)
  r = await api("/api/learn/rate", { method: "POST", body: { questionId: batch[1].id, rating: "vague" } });
  A.ok(r.json.result.stage === 0 && r.json.result.intervalDays === 1,
    "学习时选「模糊」→ 已学 + stage0/1天", r.json.result);
  // 忘记 → 第1档(1天)
  r = await api("/api/learn/rate", { method: "POST", body: { questionId: batch[2].id, rating: "forget" } });
  A.ok(r.json.result.stage === 0 && r.json.result.intervalDays === 1,
    "学习时选「忘记」→ 已学 + stage0/1天", r.json.result);

  r = await api("/api/learn/summary");
  A.ok(r.json.learned === 3, "三个评价不同的知识点都已转为已学（已学=3）", r.json.learned);
  A.ok(r.json.remaining === 492, "未学数降为 492", r.json.remaining);

  console.log("== 学习：已学过的不会再出现在学习列表 ==");
  r = await api("/api/learn/next?count=100");
  const ids = new Set(r.json.questions.map((q) => q.id));
  A.ok(!ids.has(batch[0].id) && !ids.has(batch[1].id) && !ids.has(batch[2].id),
    "刚学过的 3 个不再出现在学习清单");

  console.log("== 重复学习同一题：不重复计入，按复习规则处理 ==");
  r = await api("/api/learn/rate", { method: "POST", body: { questionId: batch[1].id, rating: "know" } });
  A.ok(r.json.result.alreadyLearned === true, "已是已学 → 标记 alreadyLearned=true", r.json.result);
  A.ok(r.json.result.stage === 1, "按复习规则推进（stage0 选认识 → stage1）", r.json.result);
  r = await api("/api/learn/summary");
  A.ok(r.json.learned === 3, "已学数仍为 3（未重复计入）", r.json.learned);

  console.log("== 复习队列：只包含已学知识点 ==");
  r = await api("/api/review/today");
  A.ok(r.status === 200, "取复习队列成功");
  A.ok(r.json.dueCount === 0, "刚学的都排在未来，今日 0 到期", r.json.dueCount);
  A.ok(r.json.due !== undefined && r.json.fresh === undefined, "复习队列不再返回未学提醒字段", Object.keys(r.json));

  console.log("== 制造到期：应只推出已学且到期的题 ==");
  const me = (await api("/api/me")).json;
  const uid = me.user.id;
  const dbm = await import("../server/db.mjs");
  dbm.db.prepare("UPDATE progress SET next_review='2000-01-01' WHERE user_id=?").run(uid);
  r = await api("/api/review/today");
  A.ok(r.json.dueCount === 3, "到期的 3 个已学知识点全部推出", r.json.dueCount);
  A.ok(r.json.due.every((q) => q.isNew === false), "复习队列里没有未学知识点");
  A.ok(r.json.due.every((q) => q.previews && q.previews.know > 0), "复习项带三档预览");

  console.log("== 复习：三档阶梯推进 ==");
  const rid = batch[0].id; // 当前 stage 1（2天）
  const cases = [
    ["know", 2, 4],
    ["vague", 1, 2],
    ["forget", 0, 1],
    ["know", 1, 2],
  ];
  for (const [rating, stage, days] of cases) {
    r = await api("/api/review/rate", { method: "POST", body: { questionId: rid, rating } });
    A.ok(r.json.result.stage === stage && r.json.result.intervalDays === days,
      `复习 ${rating} → stage${stage} / ${days}天`, r.json.result);
  }
  r = await api("/api/review/today");
  A.ok(r.json.dueCount === 2, "自评后该题不再到期（3→2）", r.json.dueCount);

  console.log("== 统计 ==");
  r = await api("/api/stats");
  A.ok(r.json.learned === 3, "统计：已学 3", r.json.learned);
  A.ok(r.json.remaining === 492, "统计：未学 492", r.json.remaining);
  A.ok(r.json.learnActions === 3, "统计：学习阶段评价 3 次", r.json.learnActions);
  // 5 = 4 次复习自评 + 1 次"对已学题重复学习"（按复习规则走了 rateLearned，故计入复习）
  A.ok(r.json.reviews === 5, "统计：复习阶段评价 5 次", r.json.reviews);
  A.ok(r.json.byStage.length > 0, "统计：间隔分布非空");
  A.ok(r.json.stages.length === 9, "统计：返回 9 档定义");

  console.log("== 随机出题：不影响进度 ==");
  const before = (await api("/api/stats")).json.learned;
  r = await api("/api/random?count=8");
  A.ok(r.json.questions.length === 8, "返回 8 题", r.json.count);
  A.ok((await api("/api/stats")).json.learned === before, "随机出题不改变已学数");

  console.log("== 学习/复习范围筛选 ==");
  r = await api("/api/subjects");
  A.ok(r.json.subjects.length === 3, "3 个科目", r.json.subjects);
  r = await api("/api/settings", { method: "POST", body: { subjects: ["机械设计"] } });
  A.ok(r.json.settings.subjects.includes("机械设计"), "范围已保存");
  r = await api("/api/learn/next?count=10");
  A.ok(r.json.questions.every((q) => q.subject === "机械设计"), "学习内容只来自选定科目");
  // 机械设计共 82 题，此前已学 3 题（可能落在该科目内），故未学数应为 82 减去其中的 0~3 个
  A.ok(r.json.remaining <= 82 && r.json.remaining >= 79,
    "未学数按选定科目统计（82 减去已学）", r.json.remaining);
  r = await api("/api/random?subjects=机械设计&count=6");
  A.ok(r.json.questions.every((q) => q.subject === "机械设计"), "随机出题遵守范围");

  console.log("== 边界条件 ==");
  {
    // 非法 rating
    r = await api("/api/learn/rate", { method: "POST", body: { questionId: batch[3].id, rating: "bogus" } });
    A.ok(r.status === 400, "学习时非法 rating 被拒绝", r.json);
    r = await api("/api/review/rate", { method: "POST", body: { questionId: rid, rating: "bogus" } });
    A.ok(r.status === 400, "复习时非法 rating 被拒绝", r.json);

    // 不存在的题目
    r = await api("/api/learn/rate", { method: "POST", body: { questionId: 999999, rating: "know" } });
    A.ok(r.status === 400, "学习不存在的题目被拒绝", r.json);
    r = await api("/api/review/rate", { method: "POST", body: { questionId: 999999, rating: "know" } });
    A.ok(r.status === 400, "复习不存在的题目被拒绝", r.json);

    // 非法 JSON → 400（不是 500）
    {
      const res = await fetch(BASE + "/api/login", {
        method: "POST", headers: { "Content-Type": "application/json", Cookie: cookie }, body: "{不是合法json",
      });
      A.ok(res.status === 400, "非法 JSON 请求体返回 400（不是 500）", res.status);
    }

    // keep-alive 连接复用（提前 return 不得破坏连接）
    {
      const http = await import("node:http");
      const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
      const req1 = (path, method, body) =>
        new Promise((resolve, reject) => {
          const u = new URL(BASE + path);
          const rq = http.request(
            { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, agent,
              headers: { "Content-Type": "application/json" } },
            (rs) => {
              const localPort = rs.socket ? rs.socket.localPort : null;
              let data = "";
              rs.on("data", (c) => (data += c));
              rs.on("end", () => resolve({ status: rs.statusCode, localPort }));
            }
          );
          rq.on("error", reject);
          if (body) rq.write(body);
          rq.end();
        });
      try {
        const o = await req1("/api/settings", "POST", JSON.stringify({ subjects: [] }));
        A.ok(o.status === 401, "未登录 POST（带 body）返回 401", o.status);
        const h1 = await req1("/api/health", "GET", null);
        const h2 = await req1("/api/health", "GET", null);
        A.ok(h1.status === 200 && h2.status === 200, "keep-alive 连接后续请求正常");
        A.ok(o.localPort === h1.localPort && h1.localPort === h2.localPort,
          `三次请求复用同一 TCP 连接（端口 ${o.localPort}）`, { a: o.localPort, b: h1.localPort });
      } catch (e) {
        A.ok(false, "keep-alive 请求链不应报错：" + e.message);
      } finally {
        agent.destroy();
      }
    }

    // count 边界
    r = await api("/api/learn/next?count=0");
    A.ok(r.status === 200 && r.json.questions.length >= 0, "count=0 不崩", r.json.count);
    r = await api("/api/learn/next?count=99999");
    A.ok(r.json.questions.length <= 200, "count 超大被夹到上限 200", r.json.count);
    r = await api("/api/learn/next?count=abc");
    A.ok(r.status === 200, "count 非数字不崩（走默认）", r.json.count);

    // 不存在科目 → 空
    await api("/api/settings", { method: "POST", body: { subjects: ["不存在的科目"] } });
    r = await api("/api/learn/next?count=5");
    A.ok(r.status === 200 && r.json.questions.length === 0, "不存在科目 → 学习内容为空");
    A.ok(r.json.remaining === 0, "不存在科目 → 未学数为 0", r.json.remaining);
    r = await api("/api/review/today");
    A.ok(r.status === 200 && r.json.dueCount === 0, "不存在科目 → 复习队列为空");
    await api("/api/settings", { method: "POST", body: { subjects: [] } });

    // 全部学完的情形
    const all = dbm.db.prepare("SELECT id FROM questions").all();
    const stmt = dbm.db.prepare(
      `INSERT INTO progress (user_id, question_id, status, stage, next_review, review_count)
       VALUES (?,?,'learned',0,'2099-01-01',1)
       ON CONFLICT(user_id, question_id) DO UPDATE SET status='learned', next_review='2099-01-01'`
    );
    for (const q of all) stmt.run(uid, q.id);
    r = await api("/api/learn/summary");
    A.ok(r.json.remaining === 0, "全部学完后未学数为 0", r.json.remaining);
    r = await api("/api/learn/next?count=10");
    A.ok(r.json.questions.length === 0, "全部学完后学习列表为空");
    r = await api("/api/review/today");
    A.ok(r.json.dueCount === 0, "全部未到期 → 复习队列为空（不硬塞）");

    // 超长用户名
    r = await api("/api/register", { method: "POST", auth: false, body: { username: "x".repeat(500), password: "pass123456", code: CODE } });
    A.ok(r.status === 400, "超长用户名被拒绝", r.json);
  }

  console.log("== 多账号进度隔离 ==");
  {
    cookie = "";
    const u2 = "api2_" + Date.now();
    await api("/api/register", { method: "POST", auth: false, body: { username: u2, password: "pass123456", code: CODE } });
    const s2 = (await api("/api/stats")).json;
    A.ok(s2.learned === 0, "新账号已学数 0（进度隔离）", s2.learned);
    A.ok(s2.remaining === 495, "新账号未学数 495", s2.remaining);
    cookie = savedCookie;
    A.ok((await api("/api/stats")).json.learned === 495, "原账号进度不受影响", 495);
  }

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
    A.ok((await fetch(BASE + "/")).headers.get("x-content-type-options") === "nosniff", "静态页面同样带安全头");
  }

  console.log("== 登录失败限流 ==");
  {
    let got429 = false, last = 0;
    for (let i = 0; i < 12; i++) {
      const res = await fetch(BASE + "/api/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "no_such_user_xyz", password: "wrong-password" }),
      });
      last = res.status;
      if (res.status === 429) { got429 = true; break; }
    }
    A.ok(got429, "连续失败登录后返回 429（限流生效）", last);
    const res = await fetch(BASE + "/api/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "no_such_user_xyz", password: "wrong-password" }),
    });
    const j = await res.json().catch(() => ({}));
    A.ok(res.status === 429 && /尝试次数过多/.test(j.error || ""), "限流返回友好提示", j);
  }
} finally {
  await srv.close();
}

process.exit(A.report() ? 0 : 1);
