#!/usr/bin/env bash
# 傅傅的工作台 · 绑定域名 + 免费 HTTPS（可选）
# 前提：已用 setup.sh 完成基础部署，且域名已做 A 记录解析到本服务器公网 IP
set -e

read -r -p "请输入你的域名（已解析到本服务器 IP，例如 fufu.example.com）: " DOMAIN

echo "安装 nginx 与 certbot ..."
sudo apt-get update -y
sudo apt-get install -y nginx certbot python3-certbot-nginx

sudo tee /etc/nginx/sites-available/fufu >/dev/null <<EOF
server {
    listen 80;
    server_name $DOMAIN;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Real-IP \$remote_addr;
    }
}
EOF

sudo ln -sf /etc/nginx/sites-available/fufu /etc/nginx/sites-enabled/fufu
sudo nginx -t && sudo systemctl reload nginx

echo "申请免费证书（Let's Encrypt）..."
sudo certbot --nginx -d "$DOMAIN"

echo ""
echo "完成！现在可用 https://$DOMAIN 访问（全程加密，登录 Cookie 自动带 Secure）"
