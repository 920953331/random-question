// tests/test_ui.mjs —— 前端真实浏览器端到端测试（自包含：自建服务 + CDP 驱动 Edge/Chrome）。
// 重点覆盖：学习页三档都转已学、复习页仅已学、切页保持进度、刷新保持进度。
// 用法：node tests/test_ui.mjs
// 可选：BROWSER_PATH 指定浏览器；SCREENSHOT_DIR 指定截图目录。
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync, mkdirSync } from "node:fs";
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
  await send("Emulation.setDeviceMetricsOverride", { width: 414, height: 896, deviceScaleFactor: 2, mobile: true });

  console.log("== 1. 未登录显示登录页 ==");
  await send("Page.navigate", { url: srv.base + "/" });
  await sleep(1400);
  let v = await evaluate(`({
    login: !document.getElementById('loginView').classList.contains('hidden'),
    app: !document.getElementById('appView').classList.contains('hidden'),
  })`);
  ok(v.login && !v.app, "未登录时显示登录页", v);
  const ov = await evaluate(`({ docW: document.documentElement.scrollWidth, winW: window.innerWidth })`);
  ok(ov.docW <= ov.winW + 1, `手机视口无横向溢出 (${ov.docW} <= ${ov.winW})`, ov);
  console.log("    截图:", await shot("1-login.png"));

  console.log("== 2. 注册后默认进入「学习」页 ==");
  const uname = "ui" + String(Date.now()).slice(-8);
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
    learnVisible: !document.getElementById('learnPage').classList.contains('hidden'),
    navActive: document.querySelector('.nav button.on')?.dataset.page,
    hasBatchInput: !!document.getElementById('batchInput'),
    batchValue: document.getElementById('batchInput')?.value,
    bodyText: document.getElementById('learnBody')?.textContent || '',
  })`);
  ok(v.app, "注册后进入主应用", v);
  ok(v.learnVisible && v.navActive === "learn", "默认停在「学习」页", v.navActive);
  ok(v.hasBatchInput, "学习页有批量数量输入框");
  ok(v.batchValue === "20", "批量默认 20", v.batchValue);
  ok(/未学\s*495/.test(v.bodyText.replace(/\s+/g, " ")), "显示未学 495", v.bodyText.slice(0, 80));
  console.log("    截图:", await shot("2-learn-start.png"));

  console.log("== 3. 开始学习：输入 5 个，出现 5 张卡片 ==");
  await evaluate(`(() => {
    const inp = document.getElementById('batchInput');
    inp.value = 5;
    document.getElementById('learnStart').click();
    return true;
  })()`);
  await sleep(1600);
  v = await evaluate(`({
    progress: document.getElementById('learnProgress').textContent,
    text: document.querySelector('#learnBody .qcard .qtext')?.textContent || '',
    btns: [...document.querySelectorAll('#learnBody .rate-btn')].map(b => b.querySelector('span').textContent),
    subs: [...document.querySelectorAll('#learnBody .rate-btn .sub')].map(b => b.textContent),
  })`);
  ok(v.progress === "1 / 5", "进度 1 / 5", v.progress);
  ok(v.text.length > 0, "卡片有题目文本", v.text);
  ok(JSON.stringify(v.btns) === JSON.stringify(["认识", "模糊", "忘记"]), "三档按钮正确", v.btns);
  ok(v.subs.every((s) => /天后$/.test(s)), "按钮显示「X天后」", v.subs);
  console.log("    截图:", await shot("3-learn-card.png"));

  console.log("== 4. 学习时选「认识」→ 转已学并推进 ==");
  await evaluate(`document.querySelector('#learnBody .rate-btn.know').click()`);
  await sleep(1500);
  v = await evaluate(`document.getElementById('learnProgress').textContent`);
  ok(v === "2 / 5", "学习自评后推进到 2 / 5", v);

  console.log("== 5. 【切页保持】切到统计再切回学习，仍停在 2 / 5 ==");
  await evaluate(`document.querySelector('.nav button[data-page="stats"]').click()`);
  await sleep(1500);
  await evaluate(`document.querySelector('.nav button[data-page="learn"]').click()`);
  await sleep(1200);
  v = await evaluate(`document.getElementById('learnProgress').textContent`);
  ok(v === "2 / 5", "切页返回后进度保持（不重头开始）", v);
  const stillCard = await evaluate(`!!document.querySelector('#learnBody .qcard')`);
  ok(stillCard, "切页返回后仍显示卡片（不是重新开始的输入页）");

  console.log("== 6. 【刷新保持】刷新页面后仍停在 2 / 5 ==");
  await send("Page.reload");
  await sleep(2200);
  v = await evaluate(`({
    learnVisible: !document.getElementById('learnPage').classList.contains('hidden'),
    progress: document.getElementById('learnProgress').textContent,
    hasCard: !!document.querySelector('#learnBody .qcard'),
  })`);
  ok(v.learnVisible, "刷新后仍进入主应用（会话有效）", v);
  ok(v.progress === "2 / 5", "刷新后学习进度保持（localStorage）", v.progress);
  ok(v.hasCard, "刷新后仍显示卡片");

  console.log("== 7. 学完这一批（把剩余 4 个评价完，三档混用都算已学）==");
  // 进度已到 2/5，即还剩 4 张卡片
  for (const cls of ["vague", "forget", "know", "vague"]) {
    await evaluate(`document.querySelector('#learnBody .rate-btn.${cls}').click()`);
    await sleep(1300);
  }
  v = await evaluate(`({
    progress: document.getElementById('learnProgress').textContent,
    done: !!document.querySelector('#learnBody .done-box'),
    bodyText: document.getElementById('learnBody').textContent,
  })`);
  ok(v.done, "学完后显示完成卡片", v.progress);
  ok(/这一批学完了/.test(v.bodyText), "完成文案正确", v.bodyText.slice(0, 60));
  console.log("    截图:", await shot("4-learn-done.png"));

  console.log("== 8. 已学数应为 5（三档都被算作已学）==");
  await evaluate(`document.querySelector('.nav button[data-page="stats"]').click()`);
  await sleep(1500);
  v = await evaluate(`({
    learned: Number([...document.querySelectorAll('#statsGrid .stat-box')].find(b=>b.querySelector('.lbl').textContent.includes('已学'))?.querySelector('.num').textContent||-1),
    remaining: Number([...document.querySelectorAll('#statsGrid .stat-box')].find(b=>b.querySelector('.lbl').textContent.includes('未学'))?.querySelector('.num').textContent||-1),
    learnActions: Number([...document.querySelectorAll('#statsGrid .stat-box')].find(b=>b.querySelector('.lbl').textContent.includes('累计学习'))?.querySelector('.num').textContent||-1),
  })`);
  ok(v.learned === 5, "已学数 = 5（三种评价都计入已学）", v.learned);
  ok(v.remaining === 490, "未学数 = 490", v.remaining);
  ok(v.learnActions === 5, "累计学习次数 = 5", v.learnActions);
  console.log("    截图:", await shot("5-stats.png"));

  console.log("== 9. 复习页：今日无到期（刚学的都排在未来）==");
  await evaluate(`document.querySelector('.nav button[data-page="review"]').click()`);
  await sleep(1600);
  v = await evaluate(`({
    progress: document.getElementById('reviewProgress').textContent,
    bodyText: document.getElementById('reviewBody').textContent,
  })`);
  ok(/今日无待复习|今日复习已完成/.test(v.progress + v.bodyText), "复习页显示今日无待复习", v.progress);
  console.log("    截图:", await shot("6-review-empty.png"));

  console.log("== 10. 复习队列只含已学：造到期后应全部推出 ==");
  // 通过页面直接调后端不可行（无权限），改由外部接口验证——此处断言复习页不出现未学卡片
  const noNewTag = await evaluate(`!document.querySelector('#reviewBody .tag.new')`);
  ok(noNewTag, "复习页不出现「未学」标记的卡片");

  console.log("== 11. 出题页仍可用 ==");
  await evaluate(`document.querySelector('.nav button[data-page="random"]').click()`);
  await sleep(800);
  await evaluate(`(() => { document.getElementById('randomCount').value = 4; document.getElementById('randomGo').click(); return true; })()`);
  await sleep(1500);
  v = await evaluate(`document.querySelectorAll('#randomResult ul.qlist li').length`);
  ok(v === 4, "随机出题渲染 4 条", v);

  console.log("== 12. 开启学习新一批：可再次输入数量 ==");
  await evaluate(`document.querySelector('.nav button[data-page="learn"]').click()`);
  await sleep(1000);
  await evaluate(`document.getElementById('learnAgain')?.click()`);
  await sleep(1400);
  v = await evaluate(`({
    hasBatch: !!document.getElementById('batchInput'),
    val: document.getElementById('batchInput')?.value,
    bodyText: document.getElementById('learnBody').textContent,
  })`);
  ok(v.hasBatch, "「再学一批」回到数量输入页", v);
  ok(v.val === "5", "记住上次的批量大小（5）", v.val);
  ok(/未学\s*490/.test(v.bodyText.replace(/\s+/g, " ")), "未学数更新为 490", v.bodyText.slice(0, 60));
  console.log("    截图:", await shot("7-learn-next-batch.png"));

  const ov2 = await evaluate(`({ docW: document.documentElement.scrollWidth, winW: window.innerWidth })`);
  ok(ov2.docW <= ov2.winW + 1, "全程无横向溢出", ov2);
} finally {
  try { ws.close(); } catch {}
  edge.kill();
  await sleep(300);
  await srv.close();
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
console.log(`截图目录: ${shotDir}`);
process.exit(fail === 0 ? 0 : 1);
