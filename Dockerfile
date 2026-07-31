# 傅傅的工作台 · 部署镜像（纯 Node，0 依赖）
FROM node:18-alpine
WORKDIR /app
# 先拷 package.json 利用镜像层缓存；本应用 0 依赖，install 为空操作也安全
COPY package.json ./
RUN npm install --omit=dev 2>/dev/null || true
COPY . .
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
