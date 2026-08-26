#!/usr/bin/env node
/**
 * 打包脚本：把 data/*.json 题库内嵌进 src/template.html，生成单文件出题工具。
 *
 * 用法：
 *   node src/build.mjs
 *
 * 流程：
 *   1. 读取 data/ 下所有 <科目>.json
 *   2. 合并成一个数组（保留字段 subject / questions[{q,a}]）
 *   3. 读取 template.html，把 __DATA__ 占位符替换成 JSON 字符串
 *   4. 写出两份产物：
 *        - outputs/出题工具.html    （本地 / 局域网 / 直接双击用）
 *        - index.html                （部署到 GitHub Pages 根目录用）
 *
 * 说明：GitHub Pages 从根目录发布时必须存在 index.html（当前仓库即如此），
 *      所以打包时同步生成两份，改完题库跑一次 build 再 git push 即可上线。
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WS = join(__dirname, "..");
const DATA_DIR = join(WS, "data");
const TEMPLATE = join(__dirname, "template.html");
const OUT_DIR = join(WS, "outputs");
const OUT_FILE = join(OUT_DIR, "出题工具.html");
const ROOT_INDEX = join(WS, "index.html");

// 1. 读取题库
const files = readdirSync(DATA_DIR).filter((f) => f.toLowerCase().endsWith(".json"));
const bank = [];
let total = 0;
for (const f of files) {
  const item = JSON.parse(readFileSync(join(DATA_DIR, f), "utf-8"));
  bank.push({
    subject: item.subject,
    questions: (item.questions || []).map((q) => ({ q: q.q, a: q.a || "" })),
  });
  total += (item.questions || []).length;
}

// 2. 读取模板并替换
let html = readFileSync(TEMPLATE, "utf-8");
if (!html.includes("__DATA__")) {
  console.error("[build] 模板中找不到 __DATA__ 占位符");
  process.exit(1);
}
html = html.replace("__DATA__", JSON.stringify(bank));

// 3. 写出两份产物
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT_FILE, html, "utf-8");
writeFileSync(ROOT_INDEX, html, "utf-8");

console.log(`[build] 合并 ${bank.length} 个科目，共 ${total} 题`);
console.log(`[build] 写出 -> ${OUT_FILE}`);
console.log(`[build] 同步 -> ${ROOT_INDEX}`);
