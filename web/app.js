/* web/app.js —— 前端逻辑：登录/注册、复习卡片、三档自评、统计、范围设置、随机出题 */
(function () {
  "use strict";

  /* ------------------------------------------------ 基础工具 */
  const $ = (id) => document.getElementById(id);

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

  const RATING_LABEL = { know: "认识", vague: "模糊", forget: "忘记" };

  /* ------------------------------------------------ 全局状态 */
  const state = {
    user: null,
    subjects: [],        // [{subject,count}]
    scope: [],           // 选中的科目（空=全部）
    queue: [],           // 复习队列
    idx: 0,
    todayDue: 0,
    todayFresh: 0,
  };

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
    $("appView").classList.add("hidden");
    $("loginView").classList.remove("hidden");
    toast("已退出登录");
  });

  /* ================================================ 进入主应用 */
  async function enterApp() {
    $("loginView").classList.add("hidden");
    $("appView").classList.remove("hidden");
    await loadMe();
    await showPage("review");
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
    updateScopeLabel();
  }

  function handleUnauth() {
    state.user = null;
    $("appView").classList.add("hidden");
    $("loginView").classList.remove("hidden");
  }

  /* ================================================ 页面切换 */
  const PAGES = { review: "reviewPage", random: "randomPage", stats: "statsPage", me: "mePage" };

  document.querySelectorAll(".nav button").forEach((btn) => {
    btn.addEventListener("click", () => showPage(btn.dataset.page));
  });

  async function showPage(name) {
    for (const [key, id] of Object.entries(PAGES)) {
      $(id).classList.toggle("hidden", key !== name);
    }
    document.querySelectorAll(".nav button").forEach((b) => {
      b.classList.toggle("on", b.dataset.page === name);
    });
    window.scrollTo(0, 0);

    if (name === "review") await loadReview();
    if (name === "stats") await loadStats();
    if (name === "random") renderSubjectPickers();
  }

  /* ================================================ 复习页 */
  async function loadReview() {
    $("reviewBody").innerHTML = '<div class="card center muted" style="padding:30px">加载中…</div>';
    const r = await api("/api/review/today");
    if (r.status === 401) return handleUnauth();
    if (!r.ok) return ($("reviewBody").innerHTML = `<div class="card err">${esc(r.error || "加载失败")}</div>`);

    state.todayDue = r.dueCount;
    state.todayFresh = r.freshCount;
    state.queue = [...r.due, ...r.fresh];
    state.idx = 0;

    updateBadge(r.dueCount, r.freshCount);
    updateScopeLabel();
    renderCard();
  }

  function updateBadge(due, fresh) {
    const total = due + fresh;
    const badge = $("navBadge");
    if (total > 0) {
      badge.textContent = total > 99 ? "99+" : String(total);
      badge.classList.remove("hidden");
    } else {
      badge.classList.add("hidden");
    }
  }

  function updateScopeLabel() {
    $("reviewScope").textContent =
      state.scope.length === 0 ? "全部科目" : state.scope.join("、");
  }

  function renderCard() {
    const total = state.queue.length;
    if (total === 0) {
      $("reviewProgress").textContent = "今日无内容";
      $("reviewBody").innerHTML = doneBox(
        "🎉",
        "今日复习已完成",
        "没有到期知识点，题库也都学过啦。可以点「出题」自由练习。"
      );
      return;
    }

    if (state.idx >= total) {
      $("reviewProgress").textContent = `完成 ${total} / ${total}`;
      const learnedNow = state.queue.filter((q) => !q.isNew).length;
      $("reviewBody").innerHTML = doneBox(
        "✅",
        "本轮复习完成",
        `共处理 ${total} 张卡片（含 ${state.todayFresh} 个新知识点提醒）。<br>进度已同步到服务器。`,
        true
      );
      bindDoneButtons();
      return;
    }

    const q = state.queue[state.idx];
    $("reviewProgress").textContent = `${state.idx + 1} / ${total}`;

    const previews = q.previews || { know: 1, vague: 1, forget: 1 };
    const tagHtml = q.isNew
      ? '<span class="tag new">未学 · 仅提醒</span>'
      : `<span class="tag">${esc(q.subject)}</span>`;

    let html = `
      <div class="qcard">
        ${tagHtml}
        <div class="qtext">${esc(q.text)}</div>
        ${q.isNew ? '<div class="hint">这是未学知识点，仅作提醒；评价不会计入已学。</div>' : '<div class="hint">回忆答案后，按实际掌握程度自评。</div>'}
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
      </div>
    `;

    if (q.isNew) {
      html += `<div class="add-row"><button class="btn ghost" id="addBtn" type="button">＋ 加入复习（转为已学）</button></div>`;
    }

    $("reviewBody").innerHTML = html;

    document.querySelectorAll(".rate-btn").forEach((b) => {
      b.addEventListener("click", () => onRate(q, b.dataset.rating));
    });
    const addBtn = $("addBtn");
    if (addBtn) addBtn.addEventListener("click", () => onAdd(q));
  }

  function doneBox(icon, title, sub, withAgain) {
    return `
      <div class="card done-box">
        <div class="big">${icon}</div>
        <h3>${esc(title)}</h3>
        <div class="muted" style="font-size:14px">${sub}</div>
        ${withAgain ? '<button class="btn" id="againBtn" type="button" style="margin-top:18px">再复习一轮</button>' : ""}
      </div>`;
  }

  function bindDoneButtons() {
    const b = $("againBtn");
    if (b) b.addEventListener("click", () => loadReview());
  }

  async function onRate(q, rating) {
    document.querySelectorAll(".rate-btn").forEach((b) => (b.disabled = true));
    const path = q.isNew ? "/api/review/rate-fresh" : "/api/review/rate";
    const r = await api(path, { method: "POST", body: { questionId: q.id, rating } });
    if (r.status === 401) return handleUnauth();
    if (!r.ok) {
      toast(r.error || "提交失败");
      document.querySelectorAll(".rate-btn").forEach((b) => (b.disabled = false));
      return;
    }

    if (q.isNew) {
      if (r.result && r.result.redirect === "learned") {
        toast("该题已是已学，按复习处理");
      } else {
        toast("已记录提醒（不计入已学）");
      }
    } else {
      const d = r.result.intervalDays;
      toast(`${RATING_LABEL[rating]} · ${d} 天后再复习`);
    }

    state.idx++;
    renderCard();
  }

  async function onAdd(q) {
    const btn = $("addBtn");
    if (btn) btn.disabled = true;
    const r = await api("/api/review/add", { method: "POST", body: { questionId: q.id } });
    if (r.status === 401) return handleUnauth();
    if (!r.ok) {
      toast(r.error || "操作失败");
      if (btn) btn.disabled = false;
      return;
    }
    toast(`已加入复习 · ${r.result.intervalDays} 天后复习`);
    state.todayFresh = Math.max(0, state.todayFresh);
    state.idx++;
    renderCard();
  }

  /* ================================================ 统计页 */
  async function loadStats() {
    const r = await api("/api/stats");
    if (r.status === 401) return handleUnauth();
    if (!r.ok) return toast(r.error || "加载失败");

    $("statsGrid").innerHTML = `
      <div class="stat-box"><div class="num">${r.total}</div><div class="lbl">题库总题数</div></div>
      <div class="stat-box"><div class="num">${r.learned}</div><div class="lbl">已学知识点</div></div>
      <div class="stat-box"><div class="num">${r.due}</div><div class="lbl">今日待复习</div></div>
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
    // 「我的」页的复习范围选择
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
            updateScopeLabel();
          });
        });
      }
    }

    // 「出题」页的科目选择（独立于复习范围，默认与复习范围一致）
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
    toast("复习范围已保存");
    updateScopeLabel();
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
      updateScopeLabel();
      await showPage("review");
    } else {
      setMode("login");
    }
  })();
})();
