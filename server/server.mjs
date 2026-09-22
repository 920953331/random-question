// server/server.mjs —— HTTP 服务：静态资源 + REST API（零外部依赖）。
import http from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import {
  initSchema,
  ymd,
  countQuestions,
  listSubjects,
  getSettings,
  setSubjects,
  statsByStage,
  countLearned,
  countDue,
  countReviews,
  ratingBreakdown,
  recentActivity,
  questionById,
} from "./db.mjs";
import { register, login, logout, userFromToken, REGISTER_CODE } from "./auth.mjs";
import {
  todayQueue,
  rateLearned,
  rateFresh,
  addToReview,
  randomQuestions,
  STAGES,
} from "./review.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(__dirname, "..", "web");
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || "0.0.0.0";

// 登录/注册失败限流（防止公网暴力破解）
const AUTH_MAX_FAILS = Number(process.env.AUTH_MAX_FAILS || 10);
const AUTH_WINDOW_MS = Number(process.env.AUTH_WINDOW_MS || 10 * 60 * 1000);

initSchema();

/* ---------------------------------------------------------------- 安全 */

/** 统一安全响应头。 */
function applySecurityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
}

/** 取客户端 IP（优先反向代理头）。 */
function clientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length > 0) {
    return xff.split(",")[0].trim();
  }
  return req.socket?.remoteAddress || "unknown";
}

// ip -> { count, firstAt }
const authFails = new Map();

function isRateLimited(ip) {
  const rec = authFails.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.firstAt > AUTH_WINDOW_MS) {
    authFails.delete(ip);
    return false;
  }
  return rec.count >= AUTH_MAX_FAILS;
}

function recordAuthFailure(ip) {
  const now = Date.now();
  const rec = authFails.get(ip);
  if (!rec || now - rec.firstAt > AUTH_WINDOW_MS) {
    authFails.set(ip, { count: 1, firstAt: now });
  } else {
    rec.count++;
  }
}

function clearAuthFailures(ip) {
  authFails.delete(ip);
}

/* ---------------------------------------------------------------- 工具 */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function readBody(req, limit = 1024 * 256) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

/** 从 Cookie 或 Authorization 头里取 token。 */
function tokenFrom(req) {
  const auth = req.headers["authorization"];
  if (auth && auth.startsWith("Bearer ")) return auth.slice(7).trim();
  const cookie = req.headers["cookie"] || "";
  const m = cookie.match(/(?:^|;\s*)sid=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

function setSessionCookie(res, token) {
  res.setHeader(
    "Set-Cookie",
    `sid=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 3600}`
  );
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", "sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
}

/** 要求登录；返回 user，未登录则已发送 401 并返回 null。 */
function requireUser(req, res) {
  const user = userFromToken(tokenFrom(req), { refresh: true });
  if (!user) {
    sendJson(res, 401, { ok: false, error: "未登录或登录已过期" });
    return null;
  }
  return user;
}

/* ---------------------------------------------------------------- 静态资源 */

function serveStatic(req, res, urlPath) {
  let rel = urlPath === "/" ? "/index.html" : urlPath;
  // 防目录穿越
  rel = normalize(rel).replace(/^(\.\.[\\/])+/, "");
  const filePath = join(WEB_DIR, rel);
  if (!filePath.startsWith(WEB_DIR)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    // SPA 兜底：未命中的非 API 路径返回 index.html
    const index = join(WEB_DIR, "index.html");
    if (existsSync(index)) {
      const html = readFileSync(index);
      res.writeHead(200, { "Content-Type": MIME[".html"], "Content-Length": html.length });
      res.end(html);
      return;
    }
    res.writeHead(404).end("Not Found");
    return;
  }
  const data = readFileSync(filePath);
  res.writeHead(200, {
    "Content-Type": MIME[extname(filePath)] || "application/octet-stream",
    "Content-Length": data.length,
    "Cache-Control": "no-cache",
  });
  res.end(data);
}

/* ---------------------------------------------------------------- API 路由 */

async function handleApi(req, res, pathname, query) {
  const method = req.method.toUpperCase();

  // ---- 公开接口 ----
  if (pathname === "/api/health" && method === "GET") {
    return sendJson(res, 200, { ok: true, questions: countQuestions(), stages: STAGES });
  }

  if (pathname === "/api/register" && method === "POST") {
    const ip = clientIp(req);
    if (isRateLimited(ip)) {
      return sendJson(res, 429, { ok: false, error: "尝试次数过多，请稍后再试" });
    }
    const body = await readBody(req);
    try {
      const r = register(body.username, body.password, body.code);
      clearAuthFailures(ip);
      setSessionCookie(res, r.token);
      return sendJson(res, 200, { ok: true, user: r.user });
    } catch (e) {
      recordAuthFailure(ip);
      return sendJson(res, 400, { ok: false, error: e.message });
    }
  }

  if (pathname === "/api/login" && method === "POST") {
    const ip = clientIp(req);
    if (isRateLimited(ip)) {
      return sendJson(res, 429, { ok: false, error: "尝试次数过多，请稍后再试" });
    }
    const body = await readBody(req);
    try {
      const r = login(body.username, body.password);
      clearAuthFailures(ip);
      setSessionCookie(res, r.token);
      return sendJson(res, 200, { ok: true, user: r.user });
    } catch (e) {
      recordAuthFailure(ip);
      return sendJson(res, 400, { ok: false, error: e.message });
    }
  }

  if (pathname === "/api/logout" && method === "POST") {
    logout(tokenFrom(req));
    clearSessionCookie(res);
    return sendJson(res, 200, { ok: true });
  }

  // ---- 以下均需登录 ----
  const user = requireUser(req, res);
  if (!user) return;

  if (pathname === "/api/me" && method === "GET") {
    const s = getSettings(user.id);
    return sendJson(res, 200, {
      ok: true,
      user: { id: user.id, username: user.username },
      settings: s,
      subjects: listSubjects(),
    });
  }

  if (pathname === "/api/subjects" && method === "GET") {
    return sendJson(res, 200, { ok: true, subjects: listSubjects() });
  }

  if (pathname === "/api/settings" && method === "POST") {
    const body = await readBody(req);
    const subs = Array.isArray(body.subjects) ? body.subjects.filter((x) => typeof x === "string") : [];
    setSubjects(user.id, subs);
    return sendJson(res, 200, { ok: true, settings: getSettings(user.id) });
  }

  // 今日复习队列
  if (pathname === "/api/review/today" && method === "GET") {
    const today = ymd();
    const { subjects } = getSettings(user.id);
    const q = todayQueue(user.id, today, { subjects });
    return sendJson(res, 200, {
      ok: true,
      today,
      dueCount: q.due.length,
      freshCount: q.fresh.length,
      due: q.due,
      fresh: q.fresh,
      subjects,
    });
  }

  // 对已学知识点自评
  if (pathname === "/api/review/rate" && method === "POST") {
    const body = await readBody(req);
    try {
      const r = rateLearned(user.id, Number(body.questionId), String(body.rating), ymd());
      return sendJson(res, 200, { ok: true, result: r });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message });
    }
  }

  // 对未学提醒自评（不转已学）
  if (pathname === "/api/review/rate-fresh" && method === "POST") {
    const body = await readBody(req);
    try {
      const r = rateFresh(user.id, Number(body.questionId), String(body.rating), ymd());
      return sendJson(res, 200, { ok: true, result: r });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message });
    }
  }

  // 把未学知识点加入复习（转为已学）
  if (pathname === "/api/review/add" && method === "POST") {
    const body = await readBody(req);
    try {
      const r = addToReview(user.id, Number(body.questionId), ymd());
      return sendJson(res, 200, { ok: true, result: r });
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: e.message });
    }
  }

  // 随机出题（保留原功能，不记进度）
  if (pathname === "/api/random" && method === "GET") {
    const subsParam = query.get("subjects");
    const subs = subsParam ? subsParam.split(",").filter(Boolean) : [];
    const n = Math.max(1, Math.min(Number(query.get("count") || 10), 200));
    const today = ymd();
    const picked = randomQuestions(subs, n);
    return sendJson(res, 200, { ok: true, count: picked.length, questions: picked });
  }

  // 统计
  if (pathname === "/api/stats" && method === "GET") {
    const today = ymd();
    return sendJson(res, 200, {
      ok: true,
      total: countQuestions(),
      learned: countLearned(user.id),
      due: countDue(user.id, today),
      reviews: countReviews(user.id),
      byStage: statsByStage(user.id),
      ratings: ratingBreakdown(user.id),
      recent: recentActivity(user.id, 14),
      stages: STAGES,
    });
  }

  sendJson(res, 404, { ok: false, error: "接口不存在" });
}

/* ---------------------------------------------------------------- 服务器 */

const server = http.createServer(async (req, res) => {
  try {
    applySecurityHeaders(res);

    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const pathname = decodeURIComponent(url.pathname);

    if (pathname.startsWith("/api/")) {
      await handleApi(req, res, pathname, url.searchParams);
      return;
    }
    serveStatic(req, res, pathname);
  } catch (e) {
    console.error("[server] 处理请求出错:", e);
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: "服务器内部错误" });
    else res.end();
  }
});

export function start(port = PORT, host = HOST) {
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      console.log(`[server] 已启动: http://${host}:${port}`);
      console.log(`[server] 题库共 ${countQuestions()} 题`);
      if (REGISTER_CODE === "ask-owner") {
        console.log(`[server] 提示：未设置 REGISTER_CODE 环境变量，注册口令为默认值 "ask-owner"`);
      }
      resolve(server);
    });
  });
}

// 直接运行
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("server.mjs")) {
  start();
}
