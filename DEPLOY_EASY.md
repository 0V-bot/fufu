# 傻瓜版部署教程（不懂 Linux 也能照做）

目标：在国内云服务器上跑起「傅傅的工作台」，浏览器**免 VPN** 直接打开。  
你全程只做三件事：**买服务器 → 网页上点几下放行端口 → 粘贴我给的命令块**。所有 Linux 细节我都包好了。

---

## 第 0 步：买服务器（网页操作，无需 Linux）

- 平台：阿里云「轻量应用服务器」（或个人 ECS 都行）。
- **地域**：选大陆，如「华东 1（杭州）」「华南 1（深圳）」「华北 2（北京）」。
- **镜像/系统**：务必选 **Ubuntu 22.04**（后面的一键脚本按它写，最稳）。
- **规格**：2 核 2G 足够；带宽 3M 对个人也够（页面很小）。
- 下单后，在控制台找到这台服务器的 **公网 IP**（一串数字，记下来）。

## 第 1 步：放行端口（网页操作）

- 阿里云轻量：控制台 → 该服务器 → **防火墙** → 添加规则 → 应用类型「自定义」→ 协议 **TCP** → 端口 **3000** → 确定。
- 阿里云 ECS：控制台 → 安全组 → 配置规则 → 入方向 → 添加 → 端口 3000 / 授权 0.0.0.0/0。

> 这一步不做，外网永远打不开。后面加域名 HTTPS 时再放 80、443。

## 第 2 步：打开终端（网页操作，不用装任何软件）

- 阿里云轻量：服务器详情 → **远程连接** → 选择「Workbench」或「SSH 连接」，浏览器里直接出终端。
- 进去后是一个黑框（命令行），不用懂，照第 3 步粘贴。

## 第 3 步：粘贴一键部署（核心一步）

把下面**整段**复制，粘贴进终端，回车：

```bash
curl -fsSL https://raw.githubusercontent.com/0V-bot/fufu/main/setup.sh -o setup.sh 2>/dev/null || \
curl -fsSL https://gitclone.com/github.com/0V-bot/fufu/raw/main/setup.sh -o setup.sh
bash setup.sh
```

脚本会自动：装 Docker → 拉代码 → 让你填飞书密钥 → 启动。  
中途会让你输入三项（粘贴后回车，**屏幕不显示你输入的内容，属正常**）：

- `FEISHU_APP_ID`：飞书应用 ID（之前给过 `cli_aae1d99a1ff89bcf`）
- `FEISHU_APP_SECRET`：飞书应用 Secret（你在飞书开放平台拿的）
- `ACCESS_PWD`：网页访问密码（自己设一个强的，比如 12 位以上混合）

跑完最后会显示容器状态，并提示访问地址。

## 第 4 步：浏览器访问（免 VPN）

打开 `http://<你的公网IP>:3000` → 输入访问密码 → 进入工作台。  
自检（可选，在终端执行）：

```bash
curl http://localhost:3000/api/env-check
```

返回里 `mode=openapi`、`hasAppId/hasSecret/hasPwd` 都为 `true` 即正常。

---

## （可选）第 5 步：绑定域名 + 免费 HTTPS

想用 `https://你的域名.com` 访问（更正规、全程加密）再做这步：

1. 在阿里云买一个域名并做 **ICP 备案**（轻量/国内服务器备案一般免费，按提示走）。
2. 域名控制台 → 解析 → 添加 **A 记录**，指向你的公网 IP。
3. 回到服务器终端，粘贴：

```bash
curl -fsSL https://raw.githubusercontent.com/0V-bot/fufu/main/setup-https.sh -o setup-https.sh
bash setup-https.sh
```

按提示输入你的域名，脚本会自动装 nginx、申请免费证书。  
完成后用 `https://你的域名.com` 访问即可。

---

## 常见问题

- **外网打不开页面**：99% 是第 1 步没放行 3000 端口；其次确认容器在跑（`sudo docker compose ps`）。
- **登录后空白 / 接口 401**：`ACCESS_PWD` 没填对或改完没重启；重跑 `bash setup.sh` 会跳过已存在的 .env，可手动 `nano ~/fufu/.env` 改后 `sudo docker compose restart`。
- **飞书读写报错**：飞书应用需开通 `bitable:app` 权限，并被加为 Base `Wwtfbm66VaJyLOsBQaTcTm1vnHg` 的「可编辑」协作者（和之前 Railway 阶段要求一致）。
- **更新代码**：终端执行 `cd ~/fufu && git pull && sudo docker compose up -d --build`。
- **卡在 Docker 安装（报错 `Connection reset by peer` / `no valid OpenPGP data found`）**：是旧版脚本用了被墙的 `download.docker.com`。重新执行第 3 步即可拉到最新脚本（已改用阿里云镜像 `mirrors.aliyun.com/docker-ce`，国内直连）。若第 3 步的 curl 拉不下来，可改用：`curl -fsSL https://gitclone.com/github.com/0V-bot/fufu/raw/main/setup.sh -o setup.sh && bash setup.sh`。
- **构建/启动卡在 `node:18-alpine` 报 `i/o timeout`（docker.io 被墙）**：已在新版脚本里自动配置 Docker 国内镜像加速器（`registry-mirrors`）。重新执行第 3 步拉最新脚本并重跑即可。若仍慢，建议用阿里云专属加速器：控制台 `cr.console.aliyun.com` → 镜像加速器 → 复制你的 `https://xxxx.mirror.aliyuncs.com`，`sudo nano /etc/docker/daemon.json` 把里面任一地址替换掉，再 `sudo systemctl restart docker`、`sudo docker compose up -d --build`。
- **卡住/报错**：把终端里的报错文字发我，我一步步帮你排。
