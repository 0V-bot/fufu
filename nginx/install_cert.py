#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把云厂商手动申请的 nginx 格式证书（<domain>.pem + <domain>.key）部署到现有站点。

与 Let's Encrypt 的区别：这是手动申请的 DV 证书，不需要 ACME / 80 端口校验，
因此完全绕开 certbot --nginx 的 301 跳转问题；但也没有自动续期，到期前需重新申请。

脚本只引用证书文件路径，绝不把私钥内容写入仓库或日志。
用法（VPS，需 root）：
    sudo python3 ~/fufu/nginx/install_cert.py --cert-dir /root/certs --check
    sudo python3 ~/fufu/nginx/install_cert.py --cert-dir /root/certs
可选：CERT_DOMAIN（默认 fufu.lwai.work）

安全：先备份 nginx 配置（*.bak-<时间戳>），nginx -t 失败自动回滚；私钥权限 600。
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
INSTALL_DIR = "/etc/nginx/ssl/" + DOMAIN
NGINX_GLOBS = ["/etc/nginx/sites-enabled/*", "/etc/nginx/conf.d/*.conf"]


def run(cmd, check=True):
    p = subprocess.run(cmd, text=True, capture_output=True)
    if check and p.returncode != 0:
        raise RuntimeError("%s\n%s" % (" ".join(cmd), (p.stderr or p.stdout).strip()))
    return p


def mask_comments(src):
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


def patch_443_block(body, cert_path, key_path):
    cert_re = re.compile(r"(?m)^([ \t]*)ssl_certificate(?![_a-zA-Z0-9])\s+[^;]+;[ \t]*(?:#[^\n]*)?$")
    key_re = re.compile(r"(?m)^([ \t]*)ssl_certificate_key\s+[^;]+;[ \t]*(?:#[^\n]*)?$")
    if not cert_re.search(body) or not key_re.search(body):
        return body, False
    new = cert_re.sub(lambda m: m.group(1) + "ssl_certificate %s;" % cert_path, body)
    new = key_re.sub(lambda m: m.group(1) + "ssl_certificate_key %s;" % key_path, new)
    return new, new != body


def validate(cert, key, domain):
    info = run(["openssl", "x509", "-in", cert, "-noout", "-subject", "-issuer", "-dates"]).stdout
    print("  证书信息：")
    for line in info.strip().splitlines():
        print("    " + line)
    san = run(["openssl", "x509", "-in", cert, "-noout", "-ext", "subjectAltName"], check=False).stdout
    if domain not in san:
        # 兼容不支持 -ext 的旧版 openssl
        txt = run(["openssl", "x509", "-in", cert, "-noout", "-text"]).stdout
        san = "\n".join(l for l in txt.splitlines() if "DNS:" in l or "Alternative Name" in l)
    if domain not in san:
        raise RuntimeError("证书 SAN 不含 %s：%s" % (domain, san.strip()))
    print("  SAN: " + san.strip().replace("\n", " "))
    chain = open(cert, encoding="utf-8").read().count("BEGIN CERTIFICATE")
    print("  证书链张数: %d（>=2 表示已含中间证书）" % chain)
    c = subprocess.run(["openssl", "x509", "-noout", "-modulus", "-in", cert], text=True, capture_output=True).stdout
    k = subprocess.run(["openssl", "rsa", "-noout", "-modulus", "-in", key], text=True, capture_output=True)
    if k.returncode != 0 or not c.strip() or c.strip() != k.stdout.strip():
        raise RuntimeError("私钥与证书不匹配，或私钥格式无法读取")
    print("  私钥与证书匹配: OK")


def collect_plans(cert_path, key_path):
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
            if DOMAIN not in src or "ssl_certificate" not in src:
                continue
            repl = []
            for start, end, body in server_blocks(src):
                if not re.search(r"\blisten\s+443\b", body) or DOMAIN not in body:
                    continue
                patched, changed = patch_443_block(body, cert_path, key_path)
                if changed:
                    repl.append((start, end, patched))
            if not repl:
                continue
            new_src = src
            for start, end, patched in sorted(repl, key=lambda x: -x[0]):
                new_src = new_src[:start] + patched + new_src[end:]
            plans.append((f, src, new_src))
    return plans


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cert-dir", required=True, help="存放 <domain>.pem 与 <domain>.key 的目录")
    ap.add_argument("--check", action="store_true", help="只校验与预览，不安装、不改配置")
    args = ap.parse_args()

    if os.geteuid() != 0:
        print("请用 sudo 运行")
        return 1
    cert = os.path.join(args.cert_dir, DOMAIN + ".pem")
    key = os.path.join(args.cert_dir, DOMAIN + ".key")
    for f in (cert, key):
        if not os.path.isfile(f):
            print("找不到文件：%s" % f)
            return 1

    print("==> [1/5] 校验证书与私钥")
    try:
        validate(cert, key, DOMAIN)
    except RuntimeError as e:
        print("  校验失败：%s" % e)
        return 1

    target_cert = os.path.join(INSTALL_DIR, DOMAIN + ".pem")
    target_key = os.path.join(INSTALL_DIR, DOMAIN + ".key")

    print("\n==> [2/5] 定位 nginx 中 %s 的 443 server 块" % DOMAIN)
    plans = collect_plans(target_cert, target_key)
    if not plans:
        print("  未找到可替换的 ssl_certificate 配置。请贴出：")
        print("  sudo nginx -T | grep -A25 'server_name %s'" % DOMAIN)
        return 1
    for f, _old, _new in plans:
        print("  待修改: %s" % f)
        print("    ssl_certificate     -> %s" % target_cert)
        print("    ssl_certificate_key -> %s" % target_key)

    if args.check:
        print("\n[--check] 预览结束，未安装证书、未修改配置。")
        return 0

    print("\n==> [3/5] 安装证书文件（私钥权限 600）")
    os.makedirs(INSTALL_DIR, exist_ok=True)
    os.chmod(INSTALL_DIR, 0o755)
    shutil.copy2(cert, target_cert)
    shutil.copy2(key, target_key)
    os.chmod(target_cert, 0o644)
    os.chmod(target_key, 0o600)
    print("  已安装到 %s" % INSTALL_DIR)

    print("\n==> [4/5] 改写 nginx 配置并校验（失败自动回滚）")
    stamp = time.strftime("%Y%m%d-%H%M%S")
    backups = []
    try:
        for f, _old, new in plans:
            bak = f + ".bak-" + stamp
            shutil.copy2(f, bak)
            backups.append((f, bak))
            with open(f, "w", encoding="utf-8") as fh:
                fh.write(new)
            print("  备份 %s" % bak)
        run(["nginx", "-t"])
        print("  nginx -t 通过")
        run(["systemctl", "reload", "nginx"])
    except Exception as e:
        print("  出错，回滚配置：%s" % e)
        for f, bak in backups:
            shutil.copy2(bak, f)
            print("  已恢复 %s" % f)
        return 1

    print("\n==> [5/5] 验证")
    probe = subprocess.run(
        ["curl", "-sS", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "10", "https://" + DOMAIN + "/"],
        text=True, capture_output=True,
    )
    if probe.returncode == 0 and probe.stdout.strip().startswith("2"):
        print("  HTTPS 校验通过：HTTP %s（证书已被客户端信任）" % probe.stdout.strip())
    else:
        print("  本地自测未通过（可能是 VPS 出网回环限制），请用本机浏览器访问确认。")
        print("  " + (probe.stderr or "").strip())
    dates = run(["openssl", "x509", "-in", target_cert, "-noout", "-dates"]).stdout.strip()
    print("  " + dates.replace("\n", " | "))
    print("\n完成。注意：手动证书无自动续期，请在到期前重新申请并再跑一次本脚本。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
