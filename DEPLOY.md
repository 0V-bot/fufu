# 部署指南：让任何人都能打开「傅傅的工作台」

当前后端已改为**纯 Node**（不再依赖本机 lark-cli），数据通过**飞书应用（app_id/secret）**直连你的多维表格。
这样就能像普通网站一样部署到任意 PaaS / VPS，任何人打开网页、输入访问密码即可使用，数据实时落到你的飞书。

---

## 一、在飞书开放平台创建应用并授权

1. 打开 <https://open.feishu.cn/app> → 创建 **企业自建应用**（名称随意，如「傅傅的工作台」）。
2. 进入应用 → **凭证与基础信息**，复制 **App ID** 和 **App Secret**（填到环境变量）。
3. 进入 **权限管理**，开通多维表格相关权限，至少需要：
   - `bitable:app`（查看、编辑多维表格）
   - 如需更细粒度可加 `base:record`（读写记录）
   开通后点 **申请权限**（企业自建应用由你本人/管理员审批，自己审批即可）。
4. **把应用加为多维表格协作者**（关键一步，否则应用读不到你的表）：
   - 在飞书打开你的多维表格「傅傅的工作台」
   - 右上角 `...` → 更多 → **添加协作者** → 搜索你刚创建的应用名 → 授予「可编辑」权限
5. （可选）如需网页里直接打开飞书，可在应用「应用功能 → 网页」里配置，本部署不需要。

> Base token 已知为 `Wwtfbm66VaJyLOsBQaTcTm1vnHg`（URL 中 `bases/` 之后那段）。

---

## 二、准备代码仓库

把 `workbench/` 目录作为 Git 仓库（需包含：`server.js`、`index.html`、`package.json`、`Procfile`）：

```bash
cd workbench
git init
git add .
git commit -m "傅傅的工作台"
git remote add origin <你的GitHub仓库地址>
git push -u origin main
```

---

## 三、部署到 PaaS（以 Railway 为例，Render 同理）

### Railway
1. 登录 <https://railway.app> → New Project → **Deploy from GitHub repo** → 选该仓库。
2. Railway 会自动识别 `package.json`，用 `npm start`（即 `node server.js`）启动。
3. 进入项目 → **Variables**，添加：
   - `FEISHU_APP_ID` = 你的 App Id
   - `FEISHU_APP_SECRET` = 你的 App Secret
   - `BASE_TOKEN` = `Wwtfbm66VaJyLOsBQaTcTm1vnHg`
   - `ACCESS_PWD` = 你自己设的强密码
   - `PORT` = Railway 会自动注入，无需手填（留空即可）
4. 部署完成后，Railway 生成一个公网域名（如 `xxx.railway.app`）。打开它 → 输入密码 → 进入工作台。

### Render
1. 登录 <https://render.com> → New → **Web Service** → 连 GitHub 仓库。
2. Build Command 留空（无依赖）；Start Command：`node server.js`。
3. 在 Environment 里加同样的环境变量（PORT 用 Render 注入的，或填 10000）。
4. 部署完成后获得 `xxx.onrender.com` 公网地址。

---

## 四、环境变量速查

| 变量 | 说明 | 是否必填 |
|------|------|----------|
| `FEISHU_APP_ID` | 飞书自建应用的 App Id | 用 OpenAPI 模式时必填 |
| `FEISHU_APP_SECRET` | 飞书自建应用的 App Secret | 用 OpenAPI 模式时必填 |
| `BASE_TOKEN` | 多维表格 Base token | 必填（默认已填你的表） |
| `ACCESS_PWD` | 网页访问密码 | **强烈建议必填**，否则任何人可直连写你的飞书 |
| `PORT` | 服务端口 | PaaS 自动注入；本地默认 3210 |

> 若**不**设置 `FEISHU_APP_ID`，服务会回退到本机 `lark-cli` 模式（需 `LARK_CLI` 指向 lark-cli 且本机已登录飞书）。这种模式下适合「本机 + 内网穿透」的轻量分享，不适合纯云部署。

---

## 五、本地运行 / 测试

```bash
# OpenAPI 模式（需填好环境变量）
FEISHU_APP_ID=xxx FEISHU_APP_SECRET=xxx ACCESS_PWD=test PORT=3210 node server.js

# 或本机 lark-cli 回退模式
LARK_CLI=/path/to/lark-cli ACCESS_PWD=test node server.js
```
浏览器打开 <http://localhost:3210> ，输入密码即可。

---

## 六、注意事项

- **安全**：`ACCESS_PWD` 务必用强密码。任何拿到网址+密码的人都能读写你的飞书 Base。
- **飞书限流/抖动**：飞书开放接口有频率限制、且偶发 `connection closed` 抖动；`server.js` 已内置 5 次重试 + 指数退避，偶发失败会自动恢复。
- **表格结构**：依赖 12 张固定表（目标管理/重大事项/每日待办/微习惯/习惯打卡/日复盘/项目/项目任务/灵感库/选题库/发布记录/知识库）。结构见 `create_tables.sh` 与项目记忆。
- **多实例**：`ACCESS_PWD` 用无状态 Cookie 校验，单实例足够；若 PaaS 起多个实例也能工作（密码一致即可）。
