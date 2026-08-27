#!/usr/bin/env python3
# 傅傅的工作台 · 文件库上传上限一键修复（小白专用，路径无关）
#
# 原理：在 /etc/nginx/conf.d/fufu-upload.conf 写入 http 全局指令
#       （client_max_body_size 512M 等）。该文件被 nginx.conf 的 http{} 自动包含，
#       对所有 server 块（含 certbot 生成的 443 块）统一生效——
#       无需定位站点配置文件，也不会触碰 certbot 已生成的证书段。幂等（已含 512M 则跳过）。
#
# 用法（在 VPS 仓库根目录执行）：
#   sudo python3 nginx/fix_upload_limit.py
# 脚本会执行 nginx -t 校验并在通过后 reload。

import os
import subprocess

CONF_D = '/etc/nginx/conf.d'
TARGET = os.path.join(CONF_D, 'fufu-upload.conf')
DIRECTIVES = (
    'client_max_body_size 512M;\n'
    'proxy_read_timeout 600s;\n'
    'proxy_send_timeout 600s;\n'
)

os.makedirs(CONF_D, exist_ok=True)

if os.path.exists(TARGET):
    cur = open(TARGET, encoding='utf-8').read()
    if 'client_max_body_size 512M' in cur:
        print('已存在且含 512M 指令，无需修改。')
    else:
        open(TARGET, 'w', encoding='utf-8').write(DIRECTIVES)
        print('已更新', TARGET)
else:
    open(TARGET, 'w', encoding='utf-8').write(DIRECTIVES)
    print('已写入', TARGET)

r = subprocess.run(['nginx', '-t'], capture_output=True, text=True)
print('--- nginx -t ---')
print(r.stdout, r.stderr)
if r.returncode == 0:
    subprocess.run(['systemctl', 'reload', 'nginx'])
    print('nginx 已重载，配置生效。')
else:
    print('nginx -t 校验失败，未执行 reload，请检查上面的报错。')
