// tests/test_ui.mjs —— 前端真实浏览器端到端测试（自包含：自建服务 + CDP 驱动 Edge/Chrome）。
// 用法：node tests/test_ui.mjs
// 可选：BROWSER_PATH 指定浏览器；SCREENSHOT_DIR 指定截图目录。
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootServer, detectBrowser } from "./_harness.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (c, m, extra) => {
  if (c) { pass++; console.log("  ok:", m); }
  else { fail++; console.error("  FAIL:", m, extra !== undefined ? JSON.stringify(extra) : ""); }
};

const browserPath = detectBrowser();
if (!browserPath) {
  console.error("未找到 Edge/Chrome，可通过 BROWSER_PATH 指定后重试。跳过 UI 测试。");
  process.exit(0);
}

const shotDir = process.env.SCREENSHOT_DIR || mkdtempSync(join(tmpdir(), "rq-shots-"));
mkdirSync(shotDir, { recursive: true });

const srv = await bootServer({ code: "ui-code" });
const DBG_PORT = 9400 + Math.floor(Math.random() * 500);
const userDataDir = mkdtempSync(join(tmpdir(), "rq-edge-"));

const edge = spawn(browserPath, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--disable-extensions", `--remote-debugging-port=${DBG_PORT}`,
  `--user-data-dir=${userDataDir}`, "about:blank",
], { stdio: "ignore" });

let target = null;
for (let i = 0; i < 80; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${DBG_PORT}/json/list`)).json();
    target = list.find((t) => t.type === "page");
    if (target) break;
  } catch { /* 未就绪 */ }
  await sleep(250);
}
if (!target) {
  console.error("无法连接浏览器调试端口");
  edge.kill();
  await srv.close();
  process.exit(1);
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let msgId = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  }
};
function send(method, params = {}) {
  const id = ++msgId;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error("CDP 超时: " + method)); } }, 20000);
  });
}
async function evaluate(expression) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error("页面 JS 异常: " + (r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails)));
  return r.result.value;
}
async function shot(name) {
  const r = await send("Page.captureScreenshot", { format: "png" });
  const p = join(shotDir, name);
  writeFileSync(p, Buffer.from(r.data, "base64"));
  return p;
}

try {
  await send("Page.enable");
  await send("Runtime.enable");
  // 手机视口（iPhone 尺寸）
  await send("Emulation.setDeviceMetricsOverride", { width: 414, height: 896, deviceScaleFactor: 2, mobile: true });

  console.log("== 1. 未登录显示登录页 ==");
  await send("Page.navigate", { url: srv.base + "/" });
  await sleep(1400);
  let v = await evaluate(`({
    login: !document.getElementById('loginView').classList.contains('hidden'),
    app: !document.getElementById('appView').classList.contains('hidden'),
    tabs: !!document.getElementById('tabLogin'),
  })`);
  ok(v.login && !v.app && v.tabs, "未登录时显示登录页", v);

  const ov = await evaluate(`({ docW: document.documentElement.scrollWidth, winW: window.innerWidth })`);
  ok(ov.docW <= ov.winW + 1, `手机视口无横向溢出 (${ov.docW} <= ${ov.winW})`, ov);
  console.log("    截图:", await shot("1-login.png"));

  console.log("== 2. 界面注册 ==");
  const uname = "ui_" + Date.now();
  await evaluate(`(() => {
    document.getElementById('tabRegister').click();
    document.getElementById('username').value = ${JSON.stringify(uname)};
    document.getElementById('password').value = 'pass123456';
    document.getElementById('code').value = 'ui-code';
    document.getElementById('authForm').dispatchEvent(new Event('submit', {cancelable:true, bubbles:true}));
    return true;
  })()`);
  await sleep(1900);
  v = await evaluate(`({
    app: !document.getElementById('appView').classList.contains('hidden'),
    me: document.getElementById('meName').textContent,
  })`);
  ok(v.app, "注册后进入主应用", v);
  ok(v.me === uname, "用户名显示正确", v);

  console.log("== 3. 复习卡片 ==");
  const card = await evaluate(`({
    has: !!document.querySelector('.qcard'),
    text: document.querySelector('.qcard .qtext')?.textContent || '',
    isNew: !!document.querySelector('.qcard .tag.new'),
    btns: [...document.querySelectorAll('.rate-btn')].map(b => b.querySelector('span').textContent),
    subs: [...document.querySelectorAll('.rate-btn .sub')].map(b => b.textContent),
    add: !!document.getElementById('addBtn'),
    badge: document.getElementById('navBadge').textContent,
  })`);
  ok(card.has && card.text.length > 0, "渲染卡片与题目文本", card.text);
  ok(JSON.stringify(card.btns) === JSON.stringify(["认识", "模糊", "忘记"]), "三档按钮正确", card.btns);
  ok(card.subs.every((s) => /天后$/.test(s)), "按钮显示「X天后」", card.subs);
  ok(card.isNew && card.add, "未学卡片带「未学·仅提醒」标签与「加入复习」按钮");
  ok(card.badge === "10", "底部导航角标显示 10", card.badge);
  console.log("    截图:", await shot("2-review-new.png"));

  console.log("== 4. 加入复习 → 推进 ==");
  await evaluate(`document.getElementById('addBtn').click()`);
  await sleep(1500);
  const p1 = await evaluate(`document.getElementById('reviewProgress').textContent`);
  ok(p1 === "2 / 10", "进度推进到 2 / 10", p1);

  console.log("== 5. 自评按钮推进 ==");
  await evaluate(`document.querySelector('.rate-btn.know').click()`);
  await sleep(1400);
  const p2 = await evaluate(`document.getElementById('reviewProgress').textContent`);
  ok(p2 === "3 / 10", "自评后推进到 3 / 10", p2);

  console.log("== 6. 统计页 ==");
  await evaluate(`document.querySelector('.nav button[data-page="stats"]').click()`);
  await sleep(1500);
  const st = await evaluate(`({
    boxes: [...document.querySelectorAll('#statsGrid .stat-box')].map(b => b.querySelector('.lbl').textContent),
    stages: document.querySelectorAll('#stageBox .bar-row').length,
    ratings: document.querySelectorAll('#ratingBox .bar-row').length,
    learned: Number([...document.querySelectorAll('#statsGrid .stat-box')].find(b=>b.querySelector('.lbl').textContent.includes('已学'))?.querySelector('.num').textContent || -1),
  })`);
  ok(st.boxes.length === 4, "4 个指标卡", st.boxes);
  ok(st.stages === 9, "9 档间隔分布", st.stages);
  ok(st.ratings === 3, "三档自评分布", st.ratings);
  ok(st.learned === 1, "「加入复习」后已学数 =1", st.learned);
  console.log("    截图:", await shot("3-stats.png"));

  console.log("== 7. 随机出题页 ==");
  await evaluate(`document.querySelector('.nav button[data-page="random"]').click()`);
  await sleep(800);
  await evaluate(`(() => { document.getElementById('randomCount').value = 6; document.getElementById('randomGo').click(); return true; })()`);
  await sleep(1500);
  const rnd = await evaluate(`document.querySelectorAll('#randomResult ul.qlist li').length`);
  ok(rnd === 6, "随机出题渲染 6 条", rnd);
  console.log("    截图:", await shot("4-random.png"));

  console.log("== 8. 我的：复习范围保存到服务器 ==");
  await evaluate(`document.querySelector('.nav button[data-page="me"]').click()`);
  await sleep(800);
  await evaluate(`(() => {
    const t = [...document.querySelectorAll('#meSubjects .subj-item')].find(i => i.querySelector('.name').textContent === '机械设计');
    t.click(); return true;
  })()`);
  await sleep(400);
  await evaluate(`document.getElementById('saveScope').click()`);
  await sleep(1300);
  const saved = await evaluate(`fetch('/api/me',{credentials:'same-origin'}).then(r=>r.json()).then(j=>j.settings.subjects)`);
  ok(Array.isArray(saved) && saved.includes("机械设计"), "复习范围已持久化到服务器", saved);
  console.log("    截图:", await shot("5-me.png"));

  console.log("== 9. 范围生效于复习页 ==");
  await evaluate(`document.querySelector('.nav button[data-page="review"]').click()`);
  await sleep(1600);
  const scope = await evaluate(`document.getElementById('reviewScope').textContent`);
  ok(scope.includes("机械设计"), "复习页显示已选范围", scope);
  const ov2 = await evaluate(`({ docW: document.documentElement.scrollWidth, winW: window.innerWidth })`);
  ok(ov2.docW <= ov2.winW + 1, "复习页无横向溢出", ov2);
  console.log("    截图:", await shot("6-review-scoped.png"));

  console.log("== 10. 换设备（新浏览器会话）凭账号看到同一进度 ==");
  // 清 Cookie 模拟另一台设备：先登出，再用账号密码登录
  await evaluate(`fetch('/api/logout',{method:'POST',credentials:'same-origin'}).then(r=>r.json())`);
  await sleep(500);
  await send("Page.navigate", { url: srv.base + "/" });
  await sleep(1300);
  await evaluate(`(() => {
    document.getElementById('username').value = ${JSON.stringify(uname)};
    document.getElementById('password').value = 'pass123456';
    document.getElementById('authForm').dispatchEvent(new Event('submit', {cancelable:true, bubbles:true}));
    return true;
  })()`);
  await sleep(1900);
  await evaluate(`document.querySelector('.nav button[data-page="stats"]').click()`);
  await sleep(1500);
  const learnedAgain = await evaluate(`Number([...document.querySelectorAll('#statsGrid .stat-box')].find(b=>b.querySelector('.lbl').textContent.includes('已学'))?.querySelector('.num').textContent || -1)`);
  ok(learnedAgain === 1, "另一设备登录后看到相同已学数（服务器同步）", learnedAgain);
} finally {
  try { ws.close(); } catch {}
  edge.kill();
  await sleep(300);
  await srv.close();
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
console.log(`截图目录: ${shotDir}`);
process.exit(fail === 0 ? 0 : 1);
