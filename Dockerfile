# workcheck —— 数据接收与可视化看板
#
# 多阶段构建：better-sqlite3 是原生模块，装的时候要编译，但运行期只需要编好的 .node，
# 所以把编译工具链留在构建阶段，最终镜像只带运行时。
#
# 必须用 debian 系（slim）而不是 alpine：better-sqlite3 官方不为 musl 提供预编译包，
# 在 alpine 上每次都要从源码编译，镜像和构建时间都会明显变差。

# ---------------------------------------------------------------- 构建阶段
FROM node:22-slim AS build

# python3 / make / g++ 是 node-gyp 编译 better-sqlite3 需要的
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先只拷清单文件：依赖没变时这层能命中缓存，改代码不会触发重新编译
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund

# ---------------------------------------------------------------- 运行阶段
FROM node:22-slim

ENV NODE_ENV=production \
    PORT=3000 \
    WORKCHECK_DATA_DIR=/data \
    TZ=Asia/Shanghai

WORKDIR /app

# 只搬运行期需要的东西：源码 + 编好的依赖
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY server ./server
COPY public ./public
COPY scripts ./scripts

# 数据目录固定挂载点：证书、config.json 与 SQLite 库都落在这里
RUN mkdir -p /data && chown -R node:node /data

# 不用 root 跑：容器里没有任何需要提权的操作
USER node

VOLUME ["/data"]
EXPOSE 3000

# 健康检查打的就是服务自己的 /api/health，不需要额外装 curl
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
