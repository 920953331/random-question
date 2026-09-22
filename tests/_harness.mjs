// tests/_harness.mjs —— 测试基座：启动一个隔离的临时数据库 + 服务器实例。
// 每个测试用独立临时 DB，互不污染，也不影响开发用的 var/learning.db。
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 启动测试服务器。
 * @returns {Promise<{base:string, code:string, close:()=>Promise<void>}>}
 */
export async function bootServer({ code = "test-code", port } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "rq-test-"));
  process.env.DB_PATH = join(dir, "test.db");
  process.env.REGISTER_CODE = code;
  process.env.PORT = "0";

  // 必须在 import 之前设置 DB_PATH（db.mjs 在导入时读取）
  const { seed } = await import("../server/seed.mjs");
  seed();

  const { start } = await import("../server/server.mjs");
  const p = port || 8100 + Math.floor(Math.random() * 900);
  const server = await start(p, "127.0.0.1");

  return {
    base: `http://127.0.0.1:${p}`,
    code,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

/** 简易断言计数器。 */
export function createAsserter() {
  const state = { pass: 0, fail: 0 };
  return {
    ok(cond, msg, extra) {
      if (cond) {
        state.pass++;
        console.log("  ok:", msg);
      } else {
        state.fail++;
        console.error("  FAIL:", msg, extra !== undefined ? JSON.stringify(extra) : "");
      }
    },
    report() {
      console.log(`\n结果: ${state.pass} 通过, ${state.fail} 失败`);
      return state.fail === 0;
    },
    get counts() {
      return { ...state };
    },
  };
}

/** 自动探测本机可用的浏览器（用于 UI 测试）。 */
export function detectBrowser() {
  const candidates = [
    process.env.BROWSER_PATH,
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ].filter(Boolean);
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}
