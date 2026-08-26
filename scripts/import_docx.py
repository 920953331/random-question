# -*- coding: utf-8 -*-
"""
导入 / 清洗脚本：把 inputs/*.docx 里的考点条目整理成标准题库 JSON。

一个科目一个输出文件：
    data/<科目>.json
结构：
    {
      "subject": "<科目名>",
      "questions": [
        {"q": "<题目文本>", "a": "<答案/备注，默认空>"},
        ...
      ]
    }

用法：
    python scripts/import_docx.py
"""
import json
import os
import re
import zipfile
from xml.etree import ElementTree as ET

# ---------------------------------------------------------------- 配置
WS = "E:\\AIcoding Projects\\random-question"
SRC = os.path.join(WS, "inputs")
DST = os.path.join(WS, "data")

# 科目名 -> 源 docx
SUBJECTS = {
    "机械设计": "机设.docx",
    "计算机": "计算机.docx",
    "农业机械": "农业机械.docx",
}

NS = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"

# ---------------------------------------------------------------- 错别字/不规范 修正字典
# 左侧是原文里常见的错字或乱串，右侧统一替换成规范表达。
# 注意：按"长词优先"顺序排列，避免子串误替换（如先"内存储器"再"储存"）。
FIXES = [
    ("内储存器", "内存储器"),
    ("外储存器", "外存储器"),
    ("未算机", "计算机"),
    ("Ipv6", "IPv6"),
    ("ipv6", "IPv6"),
    ("IPV6", "IPv6"),
    ("pv4", "IPv4"),
    ("p v4", "IPv4"),
    ("复 试", "复式"),
    ("复 式", "复式"),
    ("复试", "复式"),
    ("取决与", "取决于"),
    ("储存", "存储"),
    ("不低于____v", "不低于____"),
]


def docx_paragraphs(path):
    """提取 docx 里非空段落文本。"""
    with zipfile.ZipFile(path) as z:
        xml = z.read("word/document.xml")
    root = ET.fromstring(xml)
    out = []
    for p in root.iter(NS + "p"):
        texts = [t.text or "" for t in p.iter(NS + "t")]
        para = "".join(texts).strip()
        if para:
            out.append(para)
    return out


# 整行章节标记："二天"、"第10天"、"三天"等（无内容）
CHAPTER_RE = re.compile(r"^[第]?[一二三四五六七八九十\d]+\s*天[·、.]?$")
# 行首"第X天"前缀（后面还有内容，需剥离前缀保住主题）："第三天 摩擦..." -> "摩擦..."
DAY_PREFIX_RE = re.compile(r"^[第][一二三四五六七八九十\d]+\s*天\s*")
# 行首编号（仅当数字后跟编号分隔符或空格才认为是编号，避免误删 5G / 3s）
LEAD_NUM_RE = re.compile(r"^[.、．]?\s*\d+\s*[.、．)]\s*")
# 行首孤立标点：  .  /  ， 等
LEAD_PUNCT_RE = re.compile(r"^[.、．，,；;、)\s]+")


def clean_para(para):
    s = para.strip()

    # 整行章节标记丢弃
    if CHAPTER_RE.match(s):
        return None

    # 剥离行首"第X天"前缀（保住后面的主题）
    s = DAY_PREFIX_RE.sub("", s)

    # 去掉行首编号与孤立标点
    s = LEAD_NUM_RE.sub("", s)
    s = LEAD_PUNCT_RE.sub("", s)
    s = s.strip()

    # 应用修正字典
    for bad, good in FIXES:
        s = s.replace(bad, good)

    # 去掉行尾多余标点（保留问号/填空下划线）
    s = re.sub(r"[：:、，,；;]+$", "", s).strip()

    # 去掉残留的孤立成对引号（中文弯引号常残一半）
    s = re.sub(r"”|“|’|‘|“”，|，”“|""", "", s).strip()

    # 清理多余空白（保留填空下划线）
    s = re.sub(r"[ \t]+", " ", s).strip()

    # 剔除过长残字（如孤立"马"字）
    if len(s) < 2:
        return None
    return s


def main():
    os.makedirs(DST, exist_ok=True)
    for subject, src_name in SUBJECTS.items():
        path = os.path.join(SRC, src_name)
        paras = docx_paragraphs(path)

        questions = []
        skipped = []
        for i, p in enumerate(paras, 1):
            q = clean_para(p)
            if q is None:
                skipped.append(p)
                continue
            questions.append({"q": q, "a": ""})

        out_path = os.path.join(DST, f"{subject}.json")
        payload = {"subject": subject, "questions": questions}
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)

        print(f"[{subject}] 源 {len(paras)} 条 -> 保留 {len(questions)} 条; 丢弃(章节等) {len(skipped)} 条")
        for s in skipped:
            print(f"    丢弃: {s!r}")


if __name__ == "__main__":
    main()
