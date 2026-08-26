# -*- coding: utf-8 -*-
"""校验 scripts/import_docx.py 的清洗逻辑（抽取关键规则做回归测试）。"""
import importlib.util
import os
import re
import sys

WS = "E:\\AIcoding Projects\\random-question"
spec = importlib.util.spec_from_file_location(
    "import_docx", os.path.join(WS, "scripts", "import_docx.py")
)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

pass_n = fail_n = 0


def assert_(cond, msg):
    global pass_n, fail_n
    if cond:
        pass_n += 1
        print("  ok:", msg)
    else:
        fail_n += 1
        print("  FAIL:", msg)


cases = [
    # (输入, 期望输出, 说明)
    ("第一天连接部分", "连接部分", "剥离第X天前缀"),
    ("第三天 摩擦定义，分类定义 分类", "摩擦定义，分类定义 分类", "剥离第X天前缀保留主题"),
    ("二天", None, "整行章节标记丢弃"),
    ("一天·", None, "整行章节标记(带点)丢弃"),
    ("1. 计算机发展历程", "计算机发展历程", "去行首编号"),
    (".计算机特点", "计算机特点", "去行首孤立点"),
    ("未算机未来发展趋势", "计算机未来发展趋势", "未算机->计算机"),
    ("5G移动通信特点，在农业中的应用", "5G移动通信特点，在农业中的应用", "5G保留(不被误删5)"),
    ("3s技术在农业领域的应用", "3s技术在农业领域的应用", "3s保留"),
    ("pv4 的地址格式", "IPv4 的地址格式", "pv4->IPv4"),
    ("IPV6 的优势", "IPv6 的优势", "IPV6->IPv6"),
    ("数字图像的储存格式:", "数字图像的存储格式", "储存->存储"),
    ("复试种子精选机工作原理", "复式种子精选机工作原理", "复试->复式"),
    ("5G 移动通信技术的峰值速率要求不低于____v", "5G 移动通信技术的峰值速率要求不低于____", "去掉行尾v"),
    ("什么是 “基因编辑？", "什么是 基因编辑？", "去掉孤立左引号"),
    ("定义的特点", "定义的特点", "正常文本原样保留"),
    ("马", None, "单字残字剔除"),
]

for inp, want, desc in cases:
    got = mod.clean_para(inp)
    if want is None:
        assert_(got is None, f"{desc}: {inp!r} -> None")
    else:
        assert_(got == want, f"{desc}: {inp!r} -> {got!r} (期望 {want!r})")

print(f"\n结果: {pass_n} 通过, {fail_n} 失败")
sys.exit(0 if fail_n == 0 else 1)
