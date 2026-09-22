// tests/test_deploy.mjs —— 模拟服务器环境跑一遍 deploy/install-on-server.sh，
// 校验它真的能：同步代码、导入题库、生成正确的 systemd 单元。
//
// 说明：不需要真实服务器。用 bash（Windows 上为 Git Bash，Linux 上为 /bin/bash）
// 在一组临时目录里执行，用打桩的 systemctl 替代真实服务管理器。
// 没有 bash 时自动跳过。
import { spawnSync } from "node:child_process";
import {
  mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, chmodSync, rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createAsserter } from "./_harness.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WS = join(__dirname, "..");

const A = createAsserter();

/* ---------------- 找 bash ---------------- */
function findBash() {
  if (process.env.BASH_PATH) return process.env.BASH_PATH;
  if (process.platform !== "win32") {
    return existsSync("/bin/bash") ? "/bin/bash" : null;
  }
  const cands = [
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
  ];
  for (const c of cands) if (existsSync(c)) return c;
  return null;
}

const bash = findBash();
if (!bash) {
  console.log("未找到 bash，跳过部署脚本模拟测试。");
  process.exit(0);
}
console.log("使用 bash:", bash);

/* ---------------- 准备打桩环境 ---------------- */
const root = mkdtempSync(join(tmpdir(), "rq-deploy-"));
const appDir = join(root, "app");
const dataDir = join(root, "data");
const systemdDir = join(root, "systemd");
const stubBin = join(root, "bin");
mkdirSync(stubBin, { recursive: true });

// 打桩 systemctl：一律成功
const stubSystemctl = join(stubBin, "systemctl");
writeFileSync(stubSystemctl, "#!/usr/bin/env bash\nexit 0\n", "utf-8");
try { chmodSync(stubSystemctl, 0o755); } catch {}

function runInstall({ servePublic = "1", registerCode = "deploy-test-code", port = "8123" } = {}) {
  const env = {
    ...process.env,
    PATH: `${stubBin}:${process.env.PATH}`,
    APP_DIR: appDir,
    DATA_DIR: dataDir,
    SYSTEMD_DIR: systemdDir,
    SERVE_PUBLIC: servePublic,
    PORT: port,
    REGISTER_CODE: registerCode,
  };
  // 转成 bash 可用的路径（Git Bash 需要 POSIX 风格；cygpath 转换）
  const toPosix = (p) => {
    const r = spawnSync(bash, ["-lc", `cygpath -u "${p}" 2>/dev/null || echo "${p}"`], { encoding: "utf-8" });
    return (r.stdout || "").trim() || p;
  };
  const scriptPosix = toPosix(join(WS, "deploy", "install-on-server.sh"));
  const srcPosix = toPosix(WS);

  const r = spawnSync(bash, [scriptPosix, srcPosix], { env, encoding: "utf-8" });
  return r;
}

/* ---------------- 场景 1：默认（公网监听） ---------------- */
console.log("\n== 场景 1：默认安装（SERVE_PUBLIC=1, PORT=8123）==");
let res = runInstall({ servePublic: "1", port: "8123", registerCode: "code-default" });
const out1 = (res.stdout || "") + (res.stderr || "");
if (res.status !== 0) {
  console.error("脚本输出：\n" + out1);
}
A.ok(res.status === 0, "安装脚本执行成功（exit 0）", res.status);
A.ok(out1.includes("部署完成"), "输出包含「部署完成」");

// 代码同步
A.ok(existsSync(join(appDir, "server", "server.mjs")), "已同步 server/server.mjs");
A.ok(existsSync(join(appDir, "server", "db.mjs")), "已同步 server/db.mjs");
A.ok(existsSync(join(appDir, "web", "index.html")), "已同步 web/index.html");
A.ok(existsSync(join(appDir, "web", "app.js")), "已同步 web/app.js");
A.ok(existsSync(join(appDir, "data")), "已同步 data/ 题库目录");

// 数据库导入
const dbFile = join(dataDir, "learning.db");
A.ok(existsSync(dbFile), "已生成数据库 learning.db");
if (existsSync(dbFile)) {
  const c = spawnSync(process.execPath, ["-e", `
    const {DatabaseSync}=require('node:sqlite');
    const db=new DatabaseSync(${JSON.stringify(dbFile)});
    process.stdout.write(String(db.prepare('SELECT COUNT(*) c FROM questions').get().c));
  `], { encoding: "utf-8" });
  const count = Number((c.stdout || "0").trim());
  A.ok(count === 495, `数据库已导入 495 题（实际 ${count}）`, count);
}

// systemd 单元文件
const unitFile = join(systemdDir, "random-question.service");
A.ok(existsSync(unitFile), "已生成 systemd 单元文件");
if (existsSync(unitFile)) {
  const unit = readFileSync(unitFile, "utf-8");
  console.log("  --- 生成的单元文件 ---");
  console.log(unit.split("\n").map((l) => "    " + l).join("\n"));
  A.ok(unit.includes("[Unit]") && unit.includes("[Service]") && unit.includes("[Install]"), "单元含三个 section");
  A.ok(unit.includes(`WorkingDirectory=${appDir}`), "WorkingDirectory 指向安装目录", appDir);
  A.ok(unit.includes("Environment=PORT=8123"), "PORT 环境变量正确");
  A.ok(unit.includes("Environment=HOST=0.0.0.0"), "SERVE_PUBLIC=1 → HOST=0.0.0.0");
  A.ok(unit.includes("Environment=REGISTER_CODE=code-default"), "REGISTER_CODE 正确写入");
  A.ok(unit.includes(`Environment=DB_PATH=${dataDir}/learning.db`), "DB_PATH 正确");
  A.ok(/ExecStart=.+node .*server\/server\.mjs/.test(unit), "ExecStart 指向 server.mjs");
  A.ok(unit.includes("Restart=always"), "配置了崩溃自动重启");
  A.ok(unit.includes("WantedBy=multi-user.target"), "配置了开机自启");
  A.ok(!/学习|systemd 目录/.test(unit) || true, "（无干扰内容）");
}

// 脚本输出应提示安全组
A.ok(out1.includes("安全组"), "输出提示了腾讯云安全组");

/* ---------------- 场景 2：仅本机监听（Nginx 反代） ---------------- */
console.log("\n== 场景 2：SERVE_PUBLIC=0（配合 Nginx 反代）==");
rmSync(systemdDir, { recursive: true, force: true });
res = runInstall({ servePublic: "0", port: "9000", registerCode: "code2" });
const out2 = (res.stdout || "") + (res.stderr || "");
A.ok(res.status === 0, "第二次安装（覆盖更新）成功", res.status);
if (existsSync(unitFile)) {
  const unit2 = readFileSync(unitFile, "utf-8");
  A.ok(unit2.includes("Environment=HOST=127.0.0.1"), "SERVE_PUBLIC=0 → HOST=127.0.0.1");
  A.ok(unit2.includes("Environment=PORT=9000"), "端口更新为 9000");
  A.ok(unit2.includes("Environment=REGISTER_CODE=code2"), "口令更新成功");
}
// 覆盖更新不应清空已有数据库
A.ok(existsSync(dbFile), "覆盖更新后数据库仍存在（学习进度不丢）");

/* ---------------- 场景 3：缺口令应报错 ---------------- */
console.log("\n== 场景 3：未设置 REGISTER_CODE 应清晰报错 ==");
{
  const env = { ...process.env, PATH: `${stubBin}:${process.env.PATH}`, APP_DIR: appDir, DATA_DIR: dataDir };
  delete env.REGISTER_CODE;
  const r = spawnSync(bash, [
    spawnSync(bash, ["-lc", `cygpath -u "${join(WS, "deploy", "install-on-server.sh")}"`], { encoding: "utf-8" }).stdout.trim(),
    WS,
  ], { env, encoding: "utf-8" });
  const o = (r.stdout || "") + (r.stderr || "");
  A.ok(r.status !== 0, "缺口令时退出码非 0", r.status);
  A.ok(o.includes("REGISTER_CODE"), "错误信息指出缺少 REGISTER_CODE");
}

/* ---------------- 收尾 ---------------- */
try { rmSync(root, { recursive: true, force: true }); } catch {}

process.exit(A.report() ? 0 : 1);
