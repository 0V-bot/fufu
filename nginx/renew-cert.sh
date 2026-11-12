#!/usr/bin/env bash
# 傅傅的工作台 · 免费 HTTPS 证书重新签发 + 自动续期守护
#
# 证书：Let's Encrypt DV，免费，90 天有效。
# 用法（VPS，需 root）：sudo bash ~/fufu/nginx/renew-cert.sh
# 可选：CERT_DOMAIN=other.example.com sudo bash ~/fufu/nginx/renew-cert.sh
#
# 说明：
#   1) --force-renewal 是「重新签发一张全新的 90 天证书」（新序列号 / 新私钥 / 新到期日），
#      不是延长旧证书，效果等价于重新申请；不删除旧 lineage、不改 nginx 配置，服务不中断。
#   2) 成功后请勿反复执行 force-renewal：Let's Encrypt 对同一域名有「7 天 5 张」重复签发限制，
#      后续交给第 4 步的自动续期即可。
#   3) HTTP-01 校验必须能从公网访问 80 端口（阿里云安全组需放行 TCP 80）。
set -euo pipefail

DOMAIN="${CERT_DOMAIN:-fufu.lwai.work}"

if [ "$(id -u)" -ne 0 ]; then
  echo "请用 sudo 运行：sudo bash nginx/renew-cert.sh"
  exit 1
fi
for bin in certbot nginx; do
  command -v "$bin" >/dev/null 2>&1 || {
    echo "缺少 $bin，请先安装：sudo apt install -y certbot python3-certbot-nginx nginx"
    exit 1
  }
done

echo "==> [1/5] 当前证书状态"
certbot certificates || true

# 预检：若 80 端口的 ACME 校验路径被 301 跳到 HTTPS，--nginx 插件签发必然失败，
# 直接引导去跑 fix_acme_and_renew.py（修 challenge + webroot 重签），避免白等一次超时。
probe=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 "http://${DOMAIN}/.well-known/acme-challenge/__probe__" 2>/dev/null || true)
if [ "$probe" = "301" ] || [ "$probe" = "302" ]; then
  echo "WARN: 80 端口的 ACME 校验路径被跳转（HTTP $probe），nginx 插件无法通过校验。"
  echo "请先修复：sudo python3 nginx/fix_acme_and_renew.py --check"
  echo "确认无误后执行：sudo python3 nginx/fix_acme_and_renew.py"
  exit 2
fi

echo "==> [2/5] 强制重新签发免费证书（90 天）"
certbot renew --force-renewal --cert-name "$DOMAIN" --non-interactive

echo "==> [3/5] 校验并重载 nginx，让新证书生效"
nginx -t
systemctl reload nginx 2>/dev/null || service nginx reload

echo "==> [4/5] 启用自动续期守护（90 天后自动再签，不再需要人工干预）"
if systemctl list-unit-files 2>/dev/null | grep -q '^certbot\.timer'; then
  systemctl enable --now certbot.timer
  echo "已启用 certbot.timer"
elif systemctl list-unit-files 2>/dev/null | grep -q '^snap\.certbot\.renew\.timer'; then
  systemctl enable --now snap.certbot.renew.timer
  echo "已启用 snap.certbot.renew.timer"
else
  printf '0 3 * * * root certbot renew --quiet --deploy-hook "systemctl reload nginx"\n' > /etc/cron.d/certbot-renew
  chmod 644 /etc/cron.d/certbot-renew
  echo "未找到 certbot timer，已写入兜底任务 /etc/cron.d/certbot-renew"
fi

echo "==> [5/5] 验证自动续期通道（staging 模拟，不影响正式证书）"
certbot renew --dry-run || echo "WARN: dry-run 未通过，请检查 80 端口与安全组后重跑本脚本"
echo
certbot certificates
echo
echo "完成。请用浏览器强刷（Ctrl+Shift+R）确认 HTTPS 恢复。"
