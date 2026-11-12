#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
修复 Let's Encrypt HTTP-01 校验被 nginx 301 跳转拦截，并重新签发免费 90 天证书。

背景：certbot --nginx 首次申请时若选择了 Redirect，会把 80 端口的 server 块改写成
      server 级的 `if ($host = ...) { return 301 https://... }` 加一句 `return 404;`。
      server 级 return 在 location 匹配之前执行，导致 /.well-known/acme-challenge/
      请求也被 301 跳到 HTTPS；443 侧没有 challenge 处理，校验拿到 404 -> 签发失败。

做法：把 80 server 块改成「challenge 走本地目录 + 其余走 location / 跳转」，
      再用 --webroot 重新签发。certonly 会把该 lineage 的认证方式固化为 webroot，
      今后自动续期也不再依赖 nginx 插件临时改写配置。

用法（VPS，需 root）：
    sudo python3 ~/fufu/nginx/fix_acme_and_renew.py --check   # 只预览诊断，不改任何东西
    sudo python3 ~/fufu/nginx/fix_acme_and_renew.py           # 执行修复 + 重新签发
可选环境变量：CERT_DOMAIN（默认 fufu.lwai.work）

安全：改动前逐文件备份 *.bak-<时间戳>；写回后先 nginx -t，失败自动全量回滚。
"""
import argparse
import glob
import os
import re
import shutil
import subprocess
import sys
import time

DOMAIN = os.environ.get("CERT_DOMAIN", "fufu.lwai.work")
WEBROOT = "/var/www/letsencrypt"
NGINX_GLOBS = ["/etc/nginx/sites-enabled/*", "/etc/nginx/conf.d/*.conf"]

CHALLENGE_LOC = """    # [fix_acme] Let's Encrypt HTTP-01 challenge: serve locally, never redirect
    location ^~ /.well-known/acme-challenge/ {
        root %s;
        default_type "text/plain";
        try_files $uri =404;
    }
""" % WEBROOT

ROOT_REDIRECT = """    location / {
        return 301 https://$host$request_uri;
    }
"""


def run(cmd, check=True):
    print("  $ " + " ".join(cmd), flush=True)
    p = subprocess.run(cmd, text=True, capture_output=True)
    if p.stdout.strip():
        print(p.stdout.strip()[-3000:], flush=True)
    if p.stderr.strip():
        print("[stderr] " + p.stderr.strip()[-2000:], flush=True)
    if check and p.returncode != 0:
        raise RuntimeError("command failed (exit %d): %s" % (p.returncode, " ".join(cmd)))
    return p


def mask_comments(src):
    """返回等长文本，把注释与引号内容替换为空格，避免花括号干扰括号配对。"""
    out = list(src)
    i, n = 0, len(src)
    while i < n:
        c = src[i]
        if c == "#":
            while i < n and src[i] != "\n":
                out[i] = " "
                i += 1
        elif c in ('"', "'"):
            q = c
            out[i] = " "
            i += 1
            while i < n and src[i] != q:
                out[i] = " "
                i += 1
            if i < n:
                out[i] = " "
        i += 1
    return "".join(out)


def server_blocks(src):
    masked = mask_comments(src)
    blocks = []
    for m in re.finditer(r"\bserver\s*\{", masked):
        depth, j = 1, m.end()
        while j < len(masked) and depth:
            if masked[j] == "{":
                depth += 1
            elif masked[j] == "}":
                depth -= 1
            j += 1
        blocks.append((m.start(), j, src[m.start():j]))
    return blocks


def patch_server_block(body, domain):
    """把 certbot 生成的 80 块改写为 challenge 可达的形式；返回 (新块, 是否有改动)。"""
    if_re = re.compile(
        r"if\s*\(\s*\$host\s*=\s*" + re.escape(domain)
        + r"\s*\)\s*\{\s*return\s+301\s+[^;]+;\s*\}\s*(?:#[^\n]*)?",
        re.I | re.S,
    )
    ret404_re = re.compile(r"(?m)^([ \t]*)return\s+404\s*;[ \t]*(?:#[^\n]*)?$")

    new = if_re.sub("", body)
    new = ret404_re.sub(
        lambda m: m.group(1) + "# [fix_acme] removed server-level return (it blocks location matching)",
        new,
    )
    idx = new.rfind("}")
    if idx < 0:
        return body, False
    insert = CHALLENGE_LOC
    if not re.search(r"\blocation\s+/\s*\{", new):
        insert += ROOT_REDIRECT
    new = new[:idx] + insert + "\n" + new[idx:]
    return new, new != body


def collect_plans():
    plans = []
    for pattern in NGINX_GLOBS:
        for f in sorted(set(glob.glob(pattern))):
            if not os.path.isfile(f):
                continue
            try:
                with open(f, encoding="utf-8") as fh:
                    src = fh.read()
            except (OSError, UnicodeDecodeError):
                continue
            if DOMAIN not in src or not re.search(r"\blisten\s+80\b", src):
                continue
            repl = []
            for start, end, body in server_blocks(src):
                if not re.search(r"\blisten\s+80\b", body) or DOMAIN not in body:
                    continue
                already_fixed = "acme-challenge" in body and not re.search(r"if\s*\(\s*\$host", body)
                if already_fixed:
                    print("  [skip] %s 的 80 块已包含 challenge location" % f)
                    continue
                patched, changed = patch_server_block(body, DOMAIN)
                if changed:
                    repl.append((start, end, patched))
            if not repl:
                continue
            new_src = src
            for start, end, patched in sorted(repl, key=lambda x: -x[0]):
                new_src = new_src[:start] + patched + new_src[end:]
            plans.append((f, src, new_src))
    return plans


def enable_renew_timer():
    p = subprocess.run(["systemctl", "list-unit-files"], text=True, capture_output=True)
    units = p.stdout or ""
    if re.search(r"(?m)^certbot\.timer", units):
        run(["systemctl", "enable", "--now", "certbot.timer"])
        print("  -> certbot.timer 已启用")
    elif re.search(r"(?m)^snap\.certbot\.renew\.timer", units):
        run(["systemctl", "enable", "--now", "snap.certbot.renew.timer"])
        print("  -> snap.certbot.renew.timer 已启用")
    else:
        line = '0 3 * * * root certbot renew --quiet --deploy-hook "systemctl reload nginx"\n'
        with open("/etc/cron.d/certbot-renew", "w", encoding="utf-8") as fh:
            fh.write(line)
        os.chmod("/etc/cron.d/certbot-renew", 0o644)
        print("  -> 未找到 certbot timer，已写入兜底 /etc/cron.d/certbot-renew")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="只诊断与预览，不修改任何文件")
    args = ap.parse_args()

    if os.geteuid() != 0:
        print("请用 sudo 运行：sudo python3 nginx/fix_acme_and_renew.py")
        return 1
    for binary in ("nginx", "certbot", "systemctl"):
        if not shutil.which(binary):
            print("缺少 %s，请先安装 certbot / nginx" % binary)
            return 1

    print("域名: %s   webroot: %s" % (DOMAIN, WEBROOT))
    print("\n==> [1/6] 扫描 nginx 配置中 80 端口的 %s server 块" % DOMAIN)
    plans = collect_plans()
    if not plans:
        print("  未发现需要修补的配置（可能已修好，或配置不在 sites-enabled/conf.d 下）。")
        print("  请贴出：sudo nginx -T | grep -A30 'server_name %s'" % DOMAIN)
    else:
        for f, _old, new in plans:
            print("  待修补: %s" % f)
            print("    将移除 server 级 301/404 return，插入 challenge location + location / 跳转")

    if args.check:
        print("\n[--check] 预览结束，未修改任何文件、未签发证书。")
        return 0

    print("\n==> [2/6] 备份并写入 nginx 配置（nginx -t 失败会自动回滚）")
    stamp = time.strftime("%Y%m%d-%H%M%S")
    backups = []
    try:
        for f, old, new in plans:
            bak = f + ".bak-" + stamp
            shutil.copy2(f, bak)
            backups.append((f, bak, old))
            with open(f, "w", encoding="utf-8") as fh:
                fh.write(new)
            print("  备份 %s" % bak)
        t = subprocess.run(["nginx", "-t"], text=True, capture_output=True)
        if t.returncode != 0:
            print("  nginx -t 失败：\n" + (t.stderr or t.stdout))
            raise RuntimeError("nginx 配置校验失败")
        print("  nginx -t 通过")
        run(["systemctl", "reload", "nginx"])
    except Exception as e:
        print("  出错，回滚所有配置：%s" % e)
        for f, bak, old in backups:
            shutil.copy2(bak, f)
            print("  已恢复 %s" % f)
        return 1

    print("\n==> [3/6] 准备 webroot 目录")
    os.makedirs(os.path.join(WEBROOT, ".well-known", "acme-challenge"), exist_ok=True)
    for root, dirs, files in os.walk(WEBROOT):
        for d in dirs:
            os.chmod(os.path.join(root, d), 0o755)
        for fn in files:
            os.chmod(os.path.join(root, fn), 0o644)

    print("\n==> [4/6] 用 webroot 方式重新签发免费 90 天证书")
    try:
        run([
            "certbot", "certonly", "--webroot", "-w", WEBROOT,
            "--cert-name", DOMAIN, "-d", DOMAIN,
            "--non-interactive", "--agree-tos",
        ])
    except RuntimeError:
        print("  签发失败。nginx 配置已修好可安全重试；完整原因见：")
        print("  sudo tail -80 /var/log/letsencrypt/letsencrypt.log")
        return 1

    print("\n==> [5/6] 重载 nginx 并启用自动续期守护")
    run(["nginx", "-t"])
    run(["systemctl", "reload", "nginx"])
    enable_renew_timer()
    dry = subprocess.run(["certbot", "renew", "--dry-run"], text=True, capture_output=True)
    print("  dry-run: " + ("通过" if dry.returncode == 0 else "未通过，请检查 80 端口与安全组"))
    if dry.returncode != 0:
        print("  " + (dry.stderr or dry.stdout).strip()[-1500:])

    print("\n==> [6/6] 当前证书")
    run(["certbot", "certificates"], check=False)
    print("\n完成。浏览器强刷 Ctrl+Shift+R 确认 HTTPS 恢复；新证书到期日应为约 90 天后。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
