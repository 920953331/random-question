// server/seed.mjs —— 把 data/*.json 题库导入数据库（幂等：默认先清空题库再导入）。
//
// 用法：
//   node server/seed.mjs            # 清空并重新导入
//   node server/seed.mjs --append   # 追加导入（不清空）
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { initSchema, clearQuestions, insertQuestion, countQuestions, listSubjects, db } from "./db.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WS = join(__dirname, "..");
const DATA_DIR = join(WS, "data");

function loadBank() {
  const files = readdirSync(DATA_DIR).filter((f) => f.toLowerCase().endsWith(".json"));
  const out = [];
  for (const f of files) {
    const item = JSON.parse(readFileSync(join(DATA_DIR, f), "utf-8"));
    const subject = item.subject;
    if (!subject) {
      console.warn(`[seed] 跳过（无 subject 字段）：${f}`);
      continue;
    }
    for (const q of item.questions || []) {
      if (q && typeof q.q === "string" && q.q.trim()) {
        out.push({ subject, text: q.q.trim(), answer: q.a || "" });
      }
    }
  }
  return out;
}

export function seed({ append = false } = {}) {
  initSchema();
  if (!append) clearQuestions();

  const rows = loadBank();
  const existing = new Set(
    db.prepare("SELECT subject, text FROM questions").all().map((r) => r.subject + "\u0000" + r.text)
  );

  let added = 0;
  let skipped = 0;
  db.exec("BEGIN");
  try {
    for (const r of rows) {
      const key = r.subject + "\u0000" + r.text;
      if (existing.has(key)) {
        skipped++;
        continue;
      }
      insertQuestion(r.subject, r.text, r.answer);
      existing.add(key);
      added++;
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }

  console.log(`[seed] 导入完成：新增 ${added} 题，跳过重复 ${skipped} 题，当前题库共 ${countQuestions()} 题`);
  for (const s of listSubjects()) {
    console.log(`  - ${s.subject}: ${s.count} 题`);
  }
  return { added, skipped, total: countQuestions() };
}

// 直接运行时执行导入
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("seed.mjs")) {
  const append = process.argv.includes("--append");
  seed({ append });
}
