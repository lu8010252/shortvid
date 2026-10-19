# ---- 构建阶段:编译 better-sqlite3(arm/v7 等没有预编译包的架构会在这里自行编译)----
FROM node:22-bookworm-slim AS build
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- 运行阶段 ----
FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg tzdata ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY package.json server.js ./
COPY public ./public
ENV TZ=Asia/Shanghai NODE_ENV=production DATA_DIR=/data VIDEO_ROOT=/video
EXPOSE 3000
CMD ["node", "server.js"]
