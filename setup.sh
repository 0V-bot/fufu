#!/usr/bin/env bash
# 傅傅的工作台 · 一键部署（不懂 Linux 也能用：把本文件内容整段粘贴到服务器终端即可）
set -e

echo "===== 傅傅的工作台 一键部署开始 ====="

# 1) 安装 Docker（Ubuntu / Debian；Alibaba Cloud Linux 请改用对应安装方式或选 Ubuntu 镜像）
if ! command -v docker >/dev/null 2>&1; then
  echo "[1/4] 安装 Docker ..."
  sudo apt-get update -y
  sudo apt-get install -y ca-certificates curl gnupg lsb-release git
  sudo install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  CODENAME=$(lsb_release -cs 2>/dev/null || echo jammy)
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $CODENAME stable" | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update -y
  sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
  sudo systemctl enable --now docker
  sudo usermod -aG docker "$USER" 2>/dev/null || true
  echo "Docker 安装完成"
else
  echo "[1/4] Docker 已存在，跳过"
fi

# 2) 拉取代码（国内镜像兜底，避免 github 直连慢）
cd ~
if [ ! -d fufu ]; then
  echo "[2/4] 克隆代码 ..."
  git clone https://github.com/0V-bot/fufu.git fufu 2>/dev/null \
    || git clone https://gitclone.com/github.com/0V-bot/fufu.git fufu 2>/dev/null \
    || git clone https://github.com.cnpmjs.org/0V-bot/fufu.git fufu
fi
cd fufu

# 3) 填写密钥
if [ ! -f .env ]; then
  echo "[3/4] 请填写以下三项（粘贴后回车；终端不会显示你输入的内容，正常）："
  read -r -p "FEISHU_APP_ID: " AID
  read -r -p "FEISHU_APP_SECRET: " ASEC
  read -r -p "ACCESS_PWD (网页访问密码): " APWD
  printf 'FEISHU_APP_ID=%s\n' "$AID" > .env
  printf 'FEISHU_APP_SECRET=%s\n' "$ASEC" >> .env
  printf 'BASE_TOKEN=%s\n' "Wwtfbm66VaJyLOsBQaTcTm1vnHg" >> .env
  printf 'ACCESS_PWD=%s\n' "$APWD" >> .env
  echo ".env 已生成"
else
  echo "[3/4] 已存在 .env，跳过"
fi

# 4) 启动
echo "[4/4] 启动容器 ..."
sudo docker compose up -d --build
sleep 3
sudo docker compose ps

echo ""
echo "===== 部署完成 ====="
echo "重要：请在阿里云控制台「防火墙 / 安全组」放行 TCP 3000"
echo "浏览器访问： http://<你的服务器公网IP>:3000"
echo "自检命令：   curl http://localhost:3000/api/env-check"
