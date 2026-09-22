/* web/app.js —— 前端逻辑
 * 学习：取 N 个未学知识点，三档自评任一选择都转为已学
 * 复习：仅已学知识点，按遗忘曲线排队
 * 会话进度：切页不重置，刷新页面也不丢（localStorage 按天保存）
 */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  /* ------------------------------------------------ 基础工具 */
  async function api(path, { method = "GET", body } = {}) {
    const res = await fetch(path, {
      method,
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: body ? JSON.stringify(body) : undefined,
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      json = { ok: false, error: "响应解析失败" };
    }
    return { status: res.status, ...json };
  }

  function toast(msg) {
    const el = document.createElement("div");
    el.textContent = msg;
    el.style.cssText =
      "background:rgba(0,0,0,.82);color:#fff;padding:10px 18px;border-radius:10px;" +
      "font-size:14px;box-shadow:0 4px 14px rgba(0,0,0,.2);margin-top:8px;text-align:center";
    $("toastWrap").appendChild(el);
    setTimeout(() => el.remove(), 1800);
  }

  function esc(s) {
    const d = document.createElement("div");
    d.textContent = s == null ? "" : s;
    return d.innerHTML;
  }

  function todayStr() {
    const d = new Date();
    return (
      d.getFullYear() +
      "-" +
      String(d.getMonth() + 1).padStart(2, "0") +
      "-" +
      String(d.getDate()).padStart(2, "0")
    );
  }

  const RATING_LABEL = { know: "认识", vague: "模糊", forget: "忘记" };
  const DEFAULT_BATCH = 20;

  /* ------------------------------------------------ 全局状态 */
  const state = {
    user: null,
    subjects: [],
    scope: [],
    today: todayStr(),
    sessions: {
      // 学习会话
      learn: { queue: [], idx: 0, batch: DEFAULT_BATCH, finished: false, day: null },
      // 复习会话
      review: { queue: [], idx: 0, finished: false, day: null },
    },
  };

  /* ------------------------------------------------ 会话进度持久化 */
  const skey = (page) => `rq_session_${state.user ? state.user.id : "anon"}_${page}`;

  function saveSession(page) {
    if (!state.user) return;
    const s = state.sessions[page];
    try {
      localStorage.setItem(
        skey(page),
        JSON.stringify({ day: s.day, queue: s.queue, idx: s.idx, batch: s.batch, finished: s.finished })
      );
    } catch {
      /* localStorage 不可用时忽略 */
    }
  }

  /** 从 localStorage 恢复会话；跨天或数据异常则放弃恢复。 */
  function restoreSession(page) {
    if (!state.user) return false;
    try {
      const raw = localStorage.getItem(skey(page));
      if (!raw) return false;
      const d = JSON.parse(raw);
      if (!d || !Array.isArray(d.queue)) return false;
      // 队列按天有效：复习的到期集合每天不同，学习批次也按天隔离
      if (d.day !== state.today) return false;
      const s = state.sessions[page];
      s.queue = d.queue;
      s.idx = Number.isFinite(d.idx) ? d.idx : 0;
      s.finished = !!d.finished;
      if (page === "learn" && Number.isFinite(d.batch)) s.batch = d.batch;
      s.day = d.day;
      return true;
    } catch {
      return false;
    }
  }

  function resetSession(page) {
    const s = state.sessions[page];
    s.queue = [];
    s.idx = 0;
    s.finished = false;
    s.day = null;
    if (state.user) {
      try {
        localStorage.removeItem(skey(page));
      } catch {}
    }
  }

  /** 页面加载时把过期的会话清掉（跨天）。 */
  function dropStaleSessions() {
    for (const page of ["learn", "review"]) {
      const s = state.sessions[page];
      if (s.day && s.day !== state.today) resetSession(page);
    }
  }

  /* ================================================ 登录 / 注册 */
  let mode = "login";

  $("tabLogin").addEventListener("click", () => setMode("login"));
  $("tabRegister").addEventListener("click", () => setMode("register"));

  function setMode(m) {
    mode = m;
    $("tabLogin").classList.toggle("on", m === "login");
    $("tabRegister").classList.toggle("on", m === "register");
    $("codeField").classList.toggle("hidden", m !== "register");
    $("authSubmit").textContent = m === "login" ? "登录" : "注册";
    $("password").setAttribute("autocomplete", m === "login" ? "current-password" : "new-password");
    $("authErr").textContent = "";
  }

  $("authForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const username = $("username").value.trim();
    const password = $("password").value;
    const code = $("code").value;
    $("authErr").textContent = "";
    $("authSubmit").disabled = true;

    const path = mode === "login" ? "/api/login" : "/api/register";
    const payload = mode === "login" ? { username, password } : { username, password, code };
    const r = await api(path, { method: "POST", body: payload });
    $("authSubmit").disabled = false;

    if (!r.ok) {
      $("authErr").textContent = r.error || "操作失败";
      return;
    }
    state.user = r.user;
    $("password").value = "";
    $("code").value = "";
    await enterApp();
  });

  $("logoutBtn").addEventListener("click", async () => {
    await api("/api/logout", { method: "POST" });
    state.user = null;
    resetSession("learn");
    resetSession("review");
    $("appView").classList.add("hidden");
    $("loginView").classList.remove("hidden");
    toast("已退出登录");
  });

  /* ================================================ 进入主应用 */
  async function enterApp() {
    $("loginView").classList.add("hidden");
    $("appView").classList.remove("hidden");
    await loadMe();
    dropStaleSessions();
    await showPage("learn");
  }

  async function loadMe() {
    const r = await api("/api/me");
    if (r.status === 401) return handleUnauth();
    if (!r.ok) return toast(r.error || "加载失败");
    state.user = r.user;
    state.subjects = r.subjects || [];
    state.scope = (r.settings && r.settings.subjects) || [];
    $("meName").textContent = r.user.username;
    renderSubjectPickers();
    updateScopeLabels();
  }

  function handleUnauth() {
    state.user = null;
    $("appView").classList.add("hidden");
    $("loginView").classList.remove("hidden");
  }

  /* ================================================ 页面切换 */
  const PAGES = {
    learn: "learnPage",
    review: "reviewPage",
    random: "randomPage",
    stats: "statsPage",
    me: "mePage",
  };

  document.querySelectorAll(".nav button").forEach((btn) => {
    btn.addEventListener("click", () => showPage(btn.dataset.page));
  });

  async function showPage(name) {
    state.today = todayStr();
    dropStaleSessions();

    for (const [key, id] of Object.entries(PAGES)) {
      $(id).classList.toggle("hidden", key !== name);
    }
    document.querySelectorAll(".nav button").forEach((b) => {
      b.classList.toggle("on", b.dataset.page === name);
    });
    window.scrollTo(0, 0);

    // 注意：进入页面时优先恢复已有会话，不重新拉取，避免"切页就重头开始"
    if (name === "learn") await enterLearn();
    if (name === "review") await enterReview();
    if (name === "stats") await loadStats();
    if (name === "random") renderSubjectPickers();
  }

  /* ================================================ 提醒角标（待复习数） */
  async function refreshBadge() {
    const r = await api("/api/stats");
    if (r.status === 401) return handleUnauth();
    if (!r.ok) return;
    const badge = $("navBadge");
    const due = r.due || 0;
    if (due > 0) {
      badge.textContent = due > 99 ? "99+" : String(due);
      badge.classList.remove("hidden");
    } else {
      badge.classList.add("hidden");
    }
  }

  function updateScopeLabels() {
    const txt = state.scope.length === 0 ? "全部科目" : state.scope.join("、");
    $("reviewScope").textContent = txt;
    $("learnScope").textContent = txt;
  }

  /* ================================================ 通用卡片渲染 */
  function doneBox(icon, title, sub, btnId, btnLabel) {
    return `
      <div class="card done-box">
        <div class="big">${icon}</div>
        <h3>${esc(title)}</h3>
        <div class="muted" style="font-size:14px">${sub}</div>
        ${btnId ? `<button class="btn" id="${btnId}" type="button" style="margin-top:18px">${esc(btnLabel)}</button>` : ""}
      </div>`;
  }

  function cardHtml(q, kind) {
    const previews = q.previews || { know: 1, vague: 1, forget: 1 };
    const tag = `<span class="tag">${esc(q.subject)}</span>`;
    const hint =
      kind === "learn"
        ? "这是未学知识点。选任意一项都会把它标记为<b>已学</b>，并开始按遗忘曲线安排复习。"
        : "回忆答案后，按实际掌握程度自评。";
    return `
      <div class="qcard">
        ${tag}
        <div class="qtext">${esc(q.text)}</div>
        <div class="hint">${hint}</div>
      </div>
      <div class="rate-row">
        <button class="rate-btn know" data-rating="know" type="button">
          <span>认识</span><span class="sub">${previews.know}天后</span>
        </button>
        <button class="rate-btn vague" data-rating="vague" type="button">
          <span>模糊</span><span class="sub">${previews.vague}天后</span>
        </button>
        <button class="rate-btn forget" data-rating="forget" type="button">
          <span>忘记</span><span class="sub">${previews.forget}天后</span>
        </button>
      </div>`;
  }

  /* ================================================ 学习页 */
  async function enterLearn() {
    const s = state.sessions.learn;
    // 已有会话（含已完成）→ 直接恢复渲染，不重新拉取
    if (s.queue.length > 0) {
      renderLearnCard();
      return;
    }
    // 尝试从 localStorage 恢复（刷新页面后不回退）
    if (restoreSession("learn")) {
      renderLearnCard();
      return;
    }
    await renderLearnStart();
  }

  async function renderLearnStart() {
    const s = state.sessions.learn;
    $("learnProgress").textContent = "准备学习";
    $("learnBody").innerHTML = '<div class="card center muted" style="padding:24px">加载中…</div>';

    const r = await api("/api/learn/summary");
    if (r.status === 401) return handleUnauth();
    if (!r.ok) return ($("learnBody").innerHTML = `<div class="card err">${esc(r.error || "加载失败")}</div>`);

    const remaining = r.remaining ?? 0;
    const learned = r.learned ?? 0;

    if (remaining === 0) {
      $("learnProgress").textContent = "已全部学完";
      $("learnBody").innerHTML = doneBox(
        "🎉",
        "所有知识点都学过了",
        `已学 ${learned} 个。去「复习」按遗忘曲线巩固吧。`
      );
      return;
    }

    $("learnBody").innerHTML = `
      <div class="card">
        <h2 class="sec">开始学习新知识点</h2>
        <div class="muted" style="font-size:14px;margin-bottom:14px">
          未学 <b>${remaining}</b> 个 ｜ 已学 <b>${learned}</b> 个
        </div>
        <label class="field">
          <span>这一批学多少个？</span>
          <input id="batchInput" type="number" min="1" max="200" value="${s.batch}" style="width:100%">
        </label>
        <div class="quick" id="batchQuick" style="margin-bottom:14px">
          ${[10, 20, 30, 50]
            .map((n) => `<button type="button" data-batch="${n}" class="${n === s.batch ? "on" : ""}">${n}</button>`)
            .join("")}
        </div>
        <button class="btn" id="learnStart" type="button">开始学习</button>
        <div class="muted center" style="font-size:12px;margin-top:8px">
          每张卡片选「认识 / 模糊 / 忘记」任一项，都会把它标记为已学
        </div>
      </div>`;

    $("batchQuick").querySelectorAll("button").forEach((b) => {
      b.addEventListener("click", () => {
        $("batchInput").value = b.dataset.batch;
        $("batchQuick").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
      });
    });
    $("learnStart").addEventListener("click", startLearn);
  }

  async function startLearn() {
    const raw = Number($("batchInput").value);
    const count = Math.max(1, Math.min(Number.isFinite(raw) ? raw : DEFAULT_BATCH, 200));
    const s = state.sessions.learn;
    s.batch = count;

    $("learnBody").innerHTML = '<div class="card center muted" style="padding:24px">抽取知识点…</div>';
    const r = await api("/api/learn/next?count=" + count);
    if (r.status === 401) return handleUnauth();
    if (!r.ok) return ($("learnBody").innerHTML = `<div class="card err">${esc(r.error || "加载失败")}</div>`);

    if (r.questions.length === 0) {
      resetSession("learn");
      return renderLearnStart();
    }

    s.queue = r.questions;
    s.idx = 0;
    s.finished = false;
    s.day = state.today;
    saveSession("learn");
    renderLearnCard();
  }

  function renderLearnCard() {
    const s = state.sessions.learn;
    const total = s.queue.length;

    if (s.idx >= total) {
      s.finished = true;
      saveSession("learn");
      $("learnProgress").textContent = `完成 ${total} / ${total}`;
      $("learnBody").innerHTML = doneBox(
        "✅",
        "这一批学完了",
        `本批 ${total} 个知识点已全部标记为已学，并已按遗忘曲线排好复习时间。`,
        "learnAgain",
        "再学一批"
      );
      $("learnAgain").addEventListener("click", () => {
        resetSession("learn");
        renderLearnStart();
      });
      refreshBadge();
      return;
    }

    const q = s.queue[s.idx];
    $("learnProgress").textContent = `${s.idx + 1} / ${total}`;
    $("learnBody").innerHTML = cardHtml(q, "learn");

    document.querySelectorAll("#learnBody .rate-btn").forEach((b) => {
      b.addEventListener("click", () => onLearnRate(q, b.dataset.rating));
    });
  }

  async function onLearnRate(q, rating) {
    document.querySelectorAll("#learnBody .rate-btn").forEach((b) => (b.disabled = true));
    const r = await api("/api/learn/rate", { method: "POST", body: { questionId: q.id, rating } });
    if (r.status === 401) return handleUnauth();
    if (!r.ok) {
      toast(r.error || "提交失败");
      document.querySelectorAll("#learnBody .rate-btn").forEach((b) => (b.disabled = false));
      return;
    }
    toast(`已标记为已学 · ${r.result.intervalDays} 天后复习`);
    state.sessions.learn.idx++;
    saveSession("learn");
    renderLearnCard();
  }

  /* ================================================ 复习页 */
  async function enterReview() {
    const s = state.sessions.review;
    if (s.queue.length > 0) {
      renderReviewCard();
      return;
    }
    if (restoreSession("review")) {
      renderReviewCard();
      return;
    }
    await loadReviewQueue();
  }

  async function loadReviewQueue() {
    $("reviewProgress").textContent = "加载中…";
    $("reviewBody").innerHTML = '<div class="card center muted" style="padding:30px">加载中…</div>';

    const r = await api("/api/review/today");
    if (r.status === 401) return handleUnauth();
    if (!r.ok) return ($("reviewBody").innerHTML = `<div class="card err">${esc(r.error || "加载失败")}</div>`);

    const s = state.sessions.review;
    s.queue = r.due || [];
    s.idx = 0;
    s.finished = false;
    s.day = state.today;
    saveSession("review");
    renderReviewCard();
    refreshBadge();
  }

  function renderReviewCard() {
    const s = state.sessions.review;
    const total = s.queue.length;

    if (total === 0) {
      $("reviewProgress").textContent = "今日无待复习";
      $("reviewBody").innerHTML = doneBox(
        "🎉",
        "今日复习已完成",
        "没有到期的已学知识点。<br>去「学习」继续学新知识点，或稍后再来。",
        "reviewReload",
        "重新检查"
      );
      $("reviewReload").addEventListener("click", () => {
        resetSession("review");
        loadReviewQueue();
      });
      return;
    }

    if (s.idx >= total) {
      s.finished = true;
      saveSession("review");
      $("reviewProgress").textContent = `完成 ${total} / ${total}`;
      $("reviewBody").innerHTML = doneBox(
        "✅",
        "本轮复习完成",
        `共复习 ${total} 个知识点，进度已同步到服务器。`,
        "reviewAgain",
        "看看还有没有到期的"
      );
      $("reviewAgain").addEventListener("click", () => {
        resetSession("review");
        loadReviewQueue();
      });
      refreshBadge();
      return;
    }

    const q = s.queue[s.idx];
    $("reviewProgress").textContent = `${s.idx + 1} / ${total}`;
    $("reviewBody").innerHTML = cardHtml(q, "review");

    document.querySelectorAll("#reviewBody .rate-btn").forEach((b) => {
      b.addEventListener("click", () => onReviewRate(q, b.dataset.rating));
    });
  }

  async function onReviewRate(q, rating) {
    document.querySelectorAll("#reviewBody .rate-btn").forEach((b) => (b.disabled = true));
    const r = await api("/api/review/rate", { method: "POST", body: { questionId: q.id, rating } });
    if (r.status === 401) return handleUnauth();
    if (!r.ok) {
      toast(r.error || "提交失败");
      document.querySelectorAll("#reviewBody .rate-btn").forEach((b) => (b.disabled = false));
      return;
    }
    toast(`${RATING_LABEL[rating]} · ${r.result.intervalDays} 天后再复习`);
    state.sessions.review.idx++;
    saveSession("review");
    renderReviewCard();
    refreshBadge();
  }

  /* ================================================ 统计页 */
  async function loadStats() {
    const r = await api("/api/stats");
    if (r.status === 401) return handleUnauth();
    if (!r.ok) return toast(r.error || "加载失败");

    $("statsGrid").innerHTML = `
      <div class="stat-box"><div class="num">${r.total}</div><div class="lbl">题库总题数</div></div>
      <div class="stat-box"><div class="num">${r.learned}</div><div class="lbl">已学知识点</div></div>
      <div class="stat-box"><div class="num">${r.remaining}</div><div class="lbl">未学知识点</div></div>
      <div class="stat-box"><div class="num">${r.due}</div><div class="lbl">今日待复习</div></div>
      <div class="stat-box"><div class="num">${r.learnActions || 0}</div><div class="lbl">累计学习次数</div></div>
      <div class="stat-box"><div class="num">${r.reviews}</div><div class="lbl">累计复习次数</div></div>
    `;

    const stages = r.stages || [];
    const byStage = new Map((r.byStage || []).map((x) => [x.stage, x.c]));
    const maxC = Math.max(1, ...(r.byStage || []).map((x) => x.c));
    let sh = "";
    stages.forEach((days, i) => {
      const c = byStage.get(i) || 0;
      const w = Math.round((c / maxC) * 100);
      sh += `<div class="bar-row">
        <span class="stage-name">第${i + 1}档 ${days}天</span>
        <span class="bar-track"><span class="bar-fill" style="width:${w}%"></span></span>
        <span class="cnt">${c}</span>
      </div>`;
    });
    $("stageBox").innerHTML = sh || '<div class="muted center">暂无已学知识点</div>';

    const ratings = new Map((r.ratings || []).map((x) => [x.rating, x.c]));
    $("ratingBox").innerHTML = ["know", "vague", "forget"]
      .map(
        (k) =>
          `<div class="bar-row"><span class="stage-name">${RATING_LABEL[k]}</span>
           <span class="bar-track"></span><span class="cnt">${ratings.get(k) || 0}</span></div>`
      )
      .join("");
  }

  /* ================================================ 随机出题页 */
  function renderSubjectPickers() {
    const meBox = $("meSubjects");
    if (meBox) {
      if (state.subjects.length === 0) {
        meBox.innerHTML = '<div class="muted center">暂无科目</div>';
      } else {
        meBox.innerHTML = state.subjects
          .map((s) => {
            const on = state.scope.includes(s.subject);
            return `<div class="subj-item ${on ? "on" : ""}" data-subject="${esc(s.subject)}">
              <span class="name">${esc(s.subject)}</span>
              <span class="cnt">${s.count} 题</span>
              <span class="tick">${on ? "✓" : ""}</span>
            </div>`;
          })
          .join("");
        meBox.querySelectorAll(".subj-item").forEach((el) => {
          el.addEventListener("click", () => {
            const sub = el.dataset.subject;
            state.scope = state.scope.includes(sub)
              ? state.scope.filter((x) => x !== sub)
              : [...state.scope, sub];
            renderSubjectPickers();
            updateScopeLabels();
          });
        });
      }
    }

    const rBox = $("randomSubjects");
    if (rBox) {
      if (state.subjects.length === 0) {
        rBox.innerHTML = '<div class="muted center">暂无科目</div>';
      } else {
        rBox.innerHTML = state.subjects
          .map((s) => {
            const on = state.randomScope ? state.randomScope.includes(s.subject) : state.scope.includes(s.subject);
            return `<div class="subj-item ${on ? "on" : ""}" data-rand="${esc(s.subject)}">
              <span class="name">${esc(s.subject)}</span>
              <span class="cnt">${s.count} 题</span>
              <span class="tick">${on ? "✓" : ""}</span>
            </div>`;
          })
          .join("");
        rBox.querySelectorAll(".subj-item").forEach((el) => {
          el.addEventListener("click", () => {
            const sub = el.dataset.rand;
            const cur = state.randomScope || [...state.scope];
            state.randomScope = cur.includes(sub) ? cur.filter((x) => x !== sub) : [...cur, sub];
            renderSubjectPickers();
          });
        });
      }
    }
  }

  $("saveScope").addEventListener("click", async () => {
    const r = await api("/api/settings", { method: "POST", body: { subjects: state.scope } });
    if (r.status === 401) return handleUnauth();
    if (!r.ok) return toast(r.error || "保存失败");
    // 范围变了，清掉当前会话，避免队列与新范围不一致
    resetSession("learn");
    resetSession("review");
    state.randomScope = undefined;
    toast("范围已保存");
    updateScopeLabels();
  });

  $("randomGo").addEventListener("click", async () => {
    const subs = state.randomScope || state.scope;
    const n = Math.max(1, Math.min(Number($("randomCount").value) || 10, 200));
    const qs = subs.length ? `?subjects=${encodeURIComponent(subs.join(","))}&count=${n}` : `?count=${n}`;

    $("randomResult").innerHTML = '<div class="card center muted" style="padding:24px">出题中…</div>';
    const r = await api("/api/random" + qs);
    if (r.status === 401) return handleUnauth();
    if (!r.ok) return ($("randomResult").innerHTML = `<div class="card err">${esc(r.error || "出题失败")}</div>`);
    if (r.questions.length === 0) {
      return ($("randomResult").innerHTML = '<div class="card center muted">该范围暂无题目</div>');
    }

    $("randomResult").innerHTML =
      `<div class="card">
        <div class="muted" style="font-size:13px;margin-bottom:6px">
          科目：${subs.length ? esc(subs.join("、")) : "全部"} ｜ 共 ${r.count} 题（不记录进度）
        </div>
        <ul class="qlist">
          ${r.questions
            .map((q, i) => `<li><div class="qnum">${i + 1}</div><div class="qtext-s">${esc(q.text)}</div></li>`)
            .join("")}
        </ul>
      </div>`;
  });

  /* ================================================ 启动 */
  (async function boot() {
    const r = await api("/api/me");
    if (r.ok && r.user) {
      state.user = r.user;
      state.subjects = r.subjects || [];
      state.scope = (r.settings && r.settings.subjects) || [];
      $("meName").textContent = r.user.username;
      $("loginView").classList.add("hidden");
      $("appView").classList.remove("hidden");
      renderSubjectPickers();
      updateScopeLabels();
      dropStaleSessions();
      await showPage("learn");
      refreshBadge();
    } else {
      setMode("login");
    }
  })();
})();
