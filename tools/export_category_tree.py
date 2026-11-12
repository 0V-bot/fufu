# -*- coding: utf-8 -*-
"""
导出「傅傅的工作台」分类树（一级 / 二级 / 三级）为 JSON。

数据源：SQLite 中两张表
  1) 原始分类表 tblfMizz0bw1juvw —— 按行保存 一级/二级/三级分类，是完整的分类清单
  2) 分类注册表 —— 稳定 ID 节点（level=1/2/3/ctype），支持改名/停用，是工作台界面实际读取的源

两者并不完全重合：注册表可能少一级节点、也可能有后来新增的二级节点。
本脚本以「原始分类表」为主干保留完整清单与顺序，补入注册表的新增节点，
并给每个节点挂上注册表的稳定 ID；无 ID 的节点标 null。

用法：
  python3 tools/export_category_tree.py                       # 默认读 data/workbench.db，写 category-tree.json
  python3 tools/export_category_tree.py --db /path/to.db -o out.json
在 VPS 的 ~/fufu 目录执行即可导出线上最新分类树。
只读打开数据库，不修改任何数据。
"""
import argparse
import collections
import datetime
import json
import os
import re
import sqlite3

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DEFAULT_DB = os.path.join(ROOT, "data", "workbench.db")
DEFAULT_OUT = os.path.join(ROOT, "category-tree.json")
RAW_TABLE = "tblfMizz0bw1juvw"
REG_TABLE = "分类注册表"


def text(v):
    """兼容飞书单选（纯字符串 / {text:..} / 数组）与布尔值。"""
    if v is None:
        return ""
    if isinstance(v, dict):
        return str(v.get("text") or v.get("value") or "").strip()
    if isinstance(v, list):
        return ",".join(text(x) for x in v).strip()
    if isinstance(v, bool):
        return "true" if v else "false"
    return str(v).strip()


def norm(s):
    """折叠换行/连续空白，用于匹配注册表规范名与原始表中的旧写法。"""
    return re.sub(r"\s+", " ", s or "").strip()


def active(v):
    return v is not False and text(v) not in ("否", "false", "False", "0")


def load_rows(con, table):
    cur = con.execute("select rec, fields from records where tbl = ?", (table,))
    out = []
    for rec, fields in cur.fetchall():
        d = json.loads(fields)
        d["_rec"] = rec
        out.append(d)
    return out


def build(db_path):
    con = sqlite3.connect("file:" + db_path.replace("?", "%3f") + "?mode=ro", uri=True)
    try:
        raw = load_rows(con, RAW_TABLE)
        reg = load_rows(con, REG_TABLE)
    finally:
        con.close()

    # ---- 1) 主干：原始分类表（保序、去重） ----
    tree = collections.OrderedDict()          # 一级 -> 二级 -> [三级]
    for r in raw:
        a, b, c = text(r.get("一级分类")), text(r.get("二级分类")), text(r.get("三级分类"))
        if not a:
            continue
        tree.setdefault(a, collections.OrderedDict())
        if b:
            tree[a].setdefault(b, [])
            if c and c not in tree[a][b]:
                tree[a][b].append(c)

    # ---- 2) 注册表节点索引 ----
    by_id = {r["_rec"]: r for r in reg}
    reg_nodes = []
    for r in reg:
        L = text(r.get("level"))
        reg_nodes.append({
            "id": r["_rec"],
            "name": text(r.get("name")),
            "level": L,
            "parentId": text(r.get("parentId")),
            "active": active(r.get("active")),
            "aliases": [x.strip() for x in text(r.get("aliases")).split(",") if x.strip()],
        })
    live = [n for n in reg_nodes if n["active"] and n["name"]]
    name_of = {n["id"]: n["name"] for n in live}
    # (level, 父名规范, 本名规范) -> 注册表 id
    idx = {}
    for n in live:
        parent = norm(name_of.get(n["parentId"], ""))
        idx[(n["level"], parent, norm(n["name"]))] = n["id"]

    def find_id(level, parent_name, name):
        return idx.get((level, norm(parent_name), norm(name)))

    # ---- 3) 补入注册表独有的节点（后来通过界面新增 / 改名后的规范名） ----
    # 一级
    for n in live:
        if n["level"] != "1":
            continue
        if not any(norm(a) == norm(n["name"]) for a in tree):
            tree[n["name"]] = collections.OrderedDict()
    # 二级
    for n in live:
        if n["level"] != "2":
            continue
        p = name_of.get(n["parentId"], "")
        key = next((a for a in tree if norm(a) == norm(p)), None)
        if not key:
            key = p
            tree.setdefault(key, collections.OrderedDict())
        if not any(norm(b) == norm(n["name"]) for b in tree[key]):
            tree[key][n["name"]] = []
    # 三级
    for n in live:
        if n["level"] != "3":
            continue
        p = name_of.get(n["parentId"], "")
        if not p:
            continue
        for a, subs in tree.items():
            b = next((x for x in subs if norm(x) == norm(p)), None)
            if b and not any(norm(c) == norm(n["name"]) for c in subs[b]):
                subs[b].append(n["name"])
                break

    # ---- 4) 输出结构 ----
    def node(name, level, parent_name, parent_path):
        rid = find_id(level, parent_name, name)
        canonical = name_of.get(rid, name) if rid else name
        item = {
            "name": canonical,
            "level": int(level),
            "id": rid,
            "inRegistry": bool(rid),
            "path": (parent_path + [canonical]),
        }
        if norm(canonical) != norm(name):
            item["originalName"] = name
        return item

    categories = []
    flat = []
    api_cat1, api_tree = [], {}
    for a, subs in tree.items():
        n1 = node(a, "1", "", [])
        api_cat1.append(n1["name"])
        api_tree[n1["name"]] = {}
        l1 = dict(n1, children=[])
        flat.append({k: n1[k] for k in ("name", "level", "id", "inRegistry", "path")})
        for b, thirds in subs.items():
            n2 = node(b, "2", a, [n1["name"]])
            api_tree[n1["name"]][n2["name"]] = []
            l2 = dict(n2, children=[])
            flat.append({k: n2[k] for k in ("name", "level", "id", "inRegistry", "path")})
            for c in thirds:
                n3 = node(c, "3", b, [n1["name"], n2["name"]])
                api_tree[n1["name"]][n2["name"]].append(n3["name"])
                l3 = dict(n3, children=[])
                flat.append({k: n3[k] for k in ("name", "level", "id", "inRegistry", "path")})
                l2["children"].append(l3)
            l1["children"].append(l2)
        categories.append(l1)

    ctypes = [n["name"] for n in live if n["level"] == "ctype"]
    counts = {
        "level1": len(categories),
        "level2": sum(len(x["children"]) for x in categories),
        "level3": sum(len(y["children"]) for x in categories for y in x["children"]),
        "contentTypes": len(ctypes),
        "withRegistryId": sum(1 for x in flat if x["id"]),
    }
    db_mtime = datetime.datetime.fromtimestamp(os.path.getmtime(db_path)).strftime("%Y-%m-%d %H:%M:%S")
    result = collections.OrderedDict()
    result["meta"] = {
        "title": "傅傅的工作台 · 分类树（一级 / 二级 / 三级）",
        "exportedAt": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "database": os.path.basename(db_path),
        "databaseModifiedAt": db_mtime,
        "sources": [RAW_TABLE + "（原始分类表）", REG_TABLE + "（分类注册表，稳定 ID）"],
        "rule": "以原始分类表为主干保留完整清单与顺序，补入分类注册表的新增/改名节点；能匹配到注册表的节点带稳定 id，未匹配则 id=null",
        "note": "contentTypes 是「内容类型」，不属于三级分类树，单独列出；apiFormat 与 GET /api/category 的 cat1/tree/ctypes 结构一致，可直接作为回退数据源",
    }
    result["counts"] = counts
    result["categories"] = categories
    result["flat"] = flat
    result["contentTypes"] = ctypes
    result["apiFormat"] = {"cat1": api_cat1, "tree": api_tree, "ctypes": ctypes}
    return result


def main():
    ap = argparse.ArgumentParser(description="导出工作台分类树为 JSON")
    ap.add_argument("--db", default=DEFAULT_DB, help="SQLite 数据库路径（只读）")
    ap.add_argument("-o", "--out", default=DEFAULT_OUT, help="输出 JSON 路径")
    args = ap.parse_args()
    if not os.path.exists(args.db):
        raise SystemExit("找不到数据库: " + args.db)
    data = build(args.db)
    with open(args.out, "w", encoding="utf-8", newline="\n") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")
    c = data["counts"]
    print("已导出: " + args.out)
    print("一级 %d / 二级 %d / 三级 %d / 内容类型 %d；带稳定 ID 的节点 %d / %d" %
          (c["level1"], c["level2"], c["level3"], c["contentTypes"],
           c["withRegistryId"], len(data["flat"])))


if __name__ == "__main__":
    main()
