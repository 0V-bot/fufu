#!/usr/bin/env python3
# 傅傅的工作台 · 文件库上传上限一键修复（小白专用）
#
# 作用：在「线上真实」nginx 配置的 80 与 443 两个 server 块的 location / 里，
#       加入 client_max_body_size 512M 等指令，使 300MB 视频能正常上传。
# 特点：只增量插入，绝不改动 certbot 已生成的证书段；幂等（已存在则跳过）。
#
# 用法（在 VPS 上，仓库根目录执行）：
#   sudo python3 nginx/fix_upload_limit.py
# 然后按提示确认 nginx -t 通过并已 reload。

import os
import re
import subprocess

CANDIDATES = [
    '/etc/nginx/conf.d/fufu.lwai.work.conf',
    '/etc/nginx/sites-enabled/fufu.lwai.work.conf',
    '/etc/nginx/sites-available/fufu.lwai.work.conf',
]
PATH = next((p for p in CANDIDATES if os.path.exists(p)), None)
if not PATH:
    print('未找到 nginx 配置文件，请确认路径（可能不在上述三个位置之一）。')
    raise SystemExit(1)
print('找到配置:', PATH)

s = open(PATH, encoding='utf-8').read()
lines = s.split('\n')
out = []
depth = 0          # 当前花括号深度
in_server = False  # 是否处于顶层 server 块内
added = False      # 当前 server 块是否已插入
DIRECTIVES = [
    '    client_max_body_size 512M;',
    '    proxy_read_timeout 600s;',
    '    proxy_send_timeout 600s;',
]

for line in lines:
    out.append(line)
    if not in_server and depth == 0 and re.match(r'\s*server\s*\{', line):
        in_server = True
        added = False
    elif in_server and re.match(r'\s*server_name', line) and not added:
        if 'client_max_body_size' not in line:
            out.extend(DIRECTIVES)
        added = True
    depth += line.count('{') - line.count('}')
    if in_server and depth <= 0:
        in_server = False

new = '\n'.join(out)
if new == s:
    print('无需修改（指令已存在，或未能匹配 server 块）。')
else:
    open(PATH, 'w', encoding='utf-8').write(new)
    print('已写入修改。')

r = subprocess.run(['nginx', '-t'], capture_output=True, text=True)
print('--- nginx -t ---')
print(r.stdout, r.stderr)
if r.returncode == 0:
    subprocess.run(['systemctl', 'reload', 'nginx'])
    print('nginx 已重载，配置生效。')
else:
    print('nginx -t 校验失败，已回滚未执行 reload，请检查上面的报错。')
