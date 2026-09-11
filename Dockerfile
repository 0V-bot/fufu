# 傅傅的工作台 · 部署镜像
FROM node:18-alpine
WORKDIR /app
# better-sqlite3 优先下载预编译二进制；alpine(musl) 无匹配预编译时回退源码编译，需构建工具链
RUN apk add --no-cache python3 make g++
# 先拷 package.json 利用镜像层缓存
COPY package.json ./
RUN npm install --omit=dev
COPY . .
ENV PORT=3000
EXPOSE 3000
CMD ["node", "server.js"]
