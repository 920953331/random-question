// server/auth.mjs —— 注册、登录、会话、密码哈希（node:crypto 零依赖）。
import crypto from "node:crypto";
import {
  createUser,
  findUserByName,
  findUserById,
  createSession,
  findSession,
  deleteSession,
  purgeExpiredSessions,
} from "./db.mjs";

const SESSION_DAYS = 30;

/** 注册口令：部署时用环境变量 REGISTER_CODE 设置；未设置时默认 ask-owner。 */
export const REGISTER_CODE = process.env.REGISTER_CODE || "ask-owner";

/** 密码哈希：scrypt + 每用户随机 salt。 */
export function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

function safeEqual(a, b) {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export function validateUsername(username) {
  if (typeof username !== "string") return "用户名无效";
  const u = username.trim();
  if (u.length < 2 || u.length > 24) return "用户名需 2-24 个字符";
  if (!/^[\w\u4e00-\u9fa5.-]+$/.test(u)) return "用户名只能含字母、数字、下划线、点、连字符或中文";
  return null;
}

export function validatePassword(password) {
  if (typeof password !== "string") return "密码无效";
  if (password.length < 6 || password.length > 128) return "密码需 6-128 个字符";
  return null;
}

/** 注册新用户，成功返回 { token, user }，失败抛 Error。 */
export function register(username, password, code) {
  if (!safeEqual(String(code ?? ""), REGISTER_CODE)) {
    throw new Error("注册口令不正确");
  }
  const uErr = validateUsername(username);
  if (uErr) throw new Error(uErr);
  const pErr = validatePassword(password);
  if (pErr) throw new Error(pErr);

  const name = username.trim();
  if (findUserByName(name)) throw new Error("该用户名已被注册");

  const salt = crypto.randomBytes(16).toString("hex");
  const hash = hashPassword(password, salt);
  const userId = createUser(name, hash, salt);
  const token = issueToken(userId);
  return { token, user: { id: userId, username: name } };
}

/** 登录，成功返回 { token, user }，失败抛 Error。 */
export function login(username, password) {
  if (typeof username !== "string" || typeof password !== "string") {
    throw new Error("用户名或密码无效");
  }
  const row = findUserByName(username.trim());
  if (!row) throw new Error("用户名或密码错误");
  const hash = hashPassword(password, row.salt);
  if (!safeEqual(hash, row.password_hash)) throw new Error("用户名或密码错误");
  const token = issueToken(row.id);
  return { token, user: { id: row.id, username: row.username } };
}

function issueToken(userId) {
  const token = crypto.randomBytes(32).toString("hex");
  const expires = new Date();
  expires.setDate(expires.getDate() + SESSION_DAYS);
  createSession(token, userId, expires.toISOString());
  return token;
}

/** 校验 token，返回 user 或 null。 */
export function userFromToken(token, { refresh = false } = {}) {
  if (!token) return null;
  purgeExpiredSessions(new Date().toISOString());
  const s = findSession(token);
  if (!s) return null;
  if (new Date(s.expires_at).getTime() < Date.now()) {
    deleteSession(token);
    return null;
  }
  if (refresh) {
    const expires = new Date();
    expires.setDate(expires.getDate() + SESSION_DAYS);
    deleteSession(token);
    createSession(token, s.user_id, expires.toISOString());
  }
  return findUserById(s.user_id);
}

export function logout(token) {
  if (token) deleteSession(token);
}
