# 国内云服务器部署手册（免 VPN 直连）

目标：把「傅傅的工作台」跑在**大陆云服务器**上，用 `http(s)://公网IP` 或域名直接访问，
不再依赖 Railway / VPN。后端仍是纯 Node，数据照常写入飞书多维表格。

---

## 一、准备服务器
- 购买 **腾讯云轻量应用服务器** 或 **阿里云轻量应用服务器**，地域选大陆（上海 / 广州 / 北京 等）。
- 镜像任选：**Docker 基础镜像**（自带 Docker，推荐）或 **Ubuntu 22.04 系统镜像**。
- 记录分配到的 **公网 IP**。

## 二、开放端口（最关键，否则外网打不开）
- **腾讯云轻量**：控制台 → 防火墙 → 添加规则：
  - 应用端口 `TCP 3000`（必开）
  - 若后续用域名 + HTTPS，再加 `TCP 80`、`TCP 443`
- **阿里云**：云服务器 → 安全组 → 入方向 → 允许 `TCP 3000`（及 `80/443`）。

> ⚠️ 外网打不开，99% 是这一步没放端口。

## 三、装 Docker（仅当系统镜像未自带时）
```bash
curl -fsSL https://get.daocloud.io/docker | sh
systemctl enable --now docker
```
轻量「Docker 镜像」已自带，跳过本步。

## 四、拉代码 + 填密钥
```bash
git clone https://github.com/0V-bot/fufu.git
cd fufu
cp .env.example .env
nano .env      # 填入 FEISHU_APP_ID / FEISHU_APP_SECRET / ACCESS_PWD（BASE_TOKEN 可留默认）
```

## 五、启动
```bash
docker compose up -d --build
docker compose ps        # 看状态，应为 Up
docker compose logs -f   # 看日志，确认出现「飞书应用鉴权成功」
```
> 没有 `docker compose` 旧版用 `docker-compose`；更老的 Docker 用 `docker-compose.yml` 同样适用。

## 六、访问（大陆免 VPN）
浏览器打开 **`http://<你的公网IP>:3000`** → 输入访问密码 → 进入工作台。
自检：
```bash
curl http://localhost:3000/api/env-check
# 应返回 mode=openapi，hasAppId / hasSecret / hasPwd 均为 true
```

## 七、（推荐）绑定域名 + HTTPS
1. 在阿里云 / 腾讯云买一个国内域名并做 **ICP 备案**（轻量服务器备案一般免费）。
2. 域名解析：A 记录指向公网 IP。
3. 用 **nginx + certbot** 反代 3000 并申请免费证书：
   ```bash
   apt install -y nginx certbot python3-certbot-nginx
   # 写入下方 nginx 配置后：
   certbot --nginx -d your.domain.com
   ```
4. 之后访问 `https://your.domain.com`，全程加密，登录 Cookie 自动带 `Secure`。

### nginx 反代配置示例
```nginx
server {
    listen 80;
    server_name your.domain.com;
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;   # 必须传，否则 HTTPS 下 Cookie 不带 Secure
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```
> 代码按 `X-Forwarded-Proto: https` 判断是否给 Cookie 加 `Secure`；不传这个头，HTTPS 下登录会异常。

## 八、更新代码
```bash
git pull
docker compose up -d --build
```

## 九、不用 Docker 的极简方式（服务器已装 Node ≥ 18）
```bash
git clone https://github.com/0V-bot/fufu.git
cd fufu
npm install            # 0 依赖
ACCESS_PWD=xxx FEISHU_APP_ID=xxx FEISHU_APP_SECRET=xxx node server.js
# 长期运行推荐 pm2：
npm i -g pm2 && pm2 start server.js --name fufu && pm2 save
```

## 十、常见问题
- **外网打不开** → 防火墙 / 安全组没放端口（第二步），或容器没起来（`docker compose ps`）。

## 十一、fufu.lwai.work 域名访问（已备案 + 解析到 8.130.181.74）

DNS 已就绪（A 记录 fufu.lwai.work → 8.130.181.74）。让域名能直接打开有两种方式：

### 方式 A（最快，免 nginx，仅 HTTP）
1. 阿里云安全组入方向放行 **TCP 80**（域名默认走 80）。
2. 在 VPS 的 `~/fufu/.env` 里加一行：`APP_PORT=80`，保存。
3. 重建：`cd ~/fufu && git pull && sudo docker compose up -d --build`。
4. 浏览器开 `http://fufu.lwai.work`（地址栏不用带端口）。
   > 注意：此方式 node 直接监听 80，且 Cookie 不带 Secure（仅 HTTP，非加密）。

### 方式 B（推荐，nginx 反代 + 免费 HTTPS）
1. 阿里云安全组入方向放行 **TCP 80 和 443**。
2. 安装：`apt install -y nginx certbot python3-certbot-nginx`。
3. 把仓库里的 `nginx/fufu.lwai.work.conf` 放到 VPS 的
   `/etc/nginx/sites-available/fufu.lwai.work.conf`，并软链到 `sites-enabled/`
   （或直接放 `/etc/nginx/conf.d/fufu.lwai.work.conf`）。
   该配置把 80 反代到 `127.0.0.1:3000`，并透传 `X-Forwarded-Proto`。
4. 校验并重载：`nginx -t && systemctl reload nginx`。
5. 申请免费证书（certbot 会自动改写该文件加上 443 + HTTP→HTTPS 跳转）：
   `certbot --nginx -d fufu.lwai.work`。
6. 之后访问 `https://fufu.lwai.work`，全程加密，登录 Cookie 自动带 `Secure`。
   > `.env` 保持 `APP_PORT=3000`（容器 3000 不动，由 nginx 反代）；
   > 若只想暴露域名、不再直连 :3000，可把 docker-compose 的 ports 改成
   > `"127.0.0.1:3000:3000"`（仅本机可访问 3000，外网只走 nginx 的 80/443）。

> 代码里 `API='/api'` 是相对路径、`server.js` 不限制 Host 头，因此换域名零改造即可生效。

- **登录后页面空白 / 接口 401** → `ACCESS_PWD` 没真写进 `.env`，或改完没重启容器。
- **飞书读写失败** → 飞书应用需开通 `bitable:app` 权限，且被加为 Base `Wwtfbm66VaJyLOsBQaTcTm1vnHg` 的「可编辑」协作者（与 Railway 阶段要求一致）。
- **想换端口** → 改 `.env` 里的 `APP_PORT` 并放行对应端口，重启容器。
