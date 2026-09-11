# 傅傅的工作台 · 部署镜像
# 用 Debian(slim/glibc) 而非 alpine(musl)：better-sqlite3 对 glibc 有官方预编译二进制，
# 免装 python3/make/g++ 编译工具链（国内 VPS 从 alpinelinux CDN 拉包极慢，曾导致构建卡死）。
FROM node:18-slim
WORKDIR /app
# npmmirror 加速：npm 包 + better-sqlite3 预编译二进制都走国内镜像（GitHub Releases 直连慢/易断）
ENV npm_config_registry=https://registry.npmmirror.com
ENV npm_config_better_sqlite3_binary_host_mirror=https://registry.npmmirror.com/-/binary/better-sqlite3
# 先拷依赖清单利用镜像层缓存
COPY package.json package-lock.json ./
RUN npm install --omit=dev
COPY . .
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
