## 这是什么

`workcheck` 是一个**第三方数据接收与可视化看板**：把外部系统（签到脚本、订单系统、任意服务）的数据收进 SQLite，用网页看板展示趋势与明细，并带一个实时的访问日志流。

## 本版变化

<!--CHANGELOG-->

## 核心能力

**数据接收**
- 每个来源一把独立 API Key，互不干扰，走 `POST /api/ingest` + `X-Api-Key`
- 幂等入库：唯一键 `UNIQUE(source_id, event_id)`，同一条数据重推只会合并计数，不会重复
- 时间字段容错：秒 / 毫秒时间戳（数字或字符串，含 `"1700000000.123"` 这类秒带毫秒）、ISO 字符串、纯日期都能识别，认不出时退回接收时间

**飞书群签到**
- 走**你本人的 OAuth 身份**读群消息，不需要把机器人拉进群，也不需要任何 API Key
- 数据由服务进程**直接入库**，不经 HTTP 推送接口
- 令牌自动续期（约 2 小时），只有授权被撤销才需要重新点一次

**接入配置页**
- 两个标签：**数据推送**（来源与 Key 管理、curl / JS 推送示例、链路自检）、**配置信息**（CapSolver / TT识图 / 飞书三组凭证）
- 凭证读出时一律掩码，**明文永远不下发**
- 飞书回调地址支持「去开放平台配置」直达跳转与一键复制，20029 报错有逐字比对工具

**账号体系**
- `scrypt` 加盐哈希存密码，`timingSafeEqual` 定长比较防时序试探
- 会话 7 天、`HttpOnly` + `SameSite=Lax`；同 IP + 账号 5 分钟错 5 次锁定
- 支持改密码：改完**保留当前设备、踢掉其它设备**的登录

**运维**
- Docker 多阶段构建（编译工具链留在构建阶段，运行镜像只带运行时）
- compose 直接从 GitHub 构建，**不用先 clone 仓库**；版本钉在发布标签上，不会悄悄跟着 `main` 变
- **凭证全部在页面上配**，compose 文件里不写任何密钥；数据卷是唯一需要持久化的东西
- `/api/health` 返回 `app` 与 `version`，部署后可直接确认版本

## 环境要求

- Node.js **22 或以上**
- `better-sqlite3` 是原生模块，官方**不为 musl 提供预编译包** —— 容器基线请用 debian 系（`node:22-slim`），不要用 alpine

## 快速开始（Docker，推荐）

**第一步**：取本版本的 compose 文件 —— 它已经钉在 `v__VERSION__` 上，不会跟着 `main` 漂。

```bash
curl -O https://raw.githubusercontent.com/AidanAllen/workcheck/refs/tags/v__VERSION__/docker-compose.yaml
```

**第二步**：构建并启动。首次会编译 `better-sqlite3`，需要几分钟。

```bash
docker compose up -d --build
```

**第三步**：打开 `http://<服务器IP>:3000/setup`，首次进入先创建管理员账号，然后在「配置信息」标签里填平台凭证。改完立即生效，不用重启容器。

确认跑起来的是哪个版本：

```bash
curl -s http://127.0.0.1:3000/api/health
# {"ok":true,"time":"...","app":"workcheck","version":"__VERSION__"}
```

不用 Docker 的话：

```bash
git clone --depth 1 --branch v__VERSION__ https://github.com/AidanAllen/workcheck.git
cd workcheck && npm ci && npm start
```

## 从旧版本升级

数据都在命名卷里，升级只换镜像、不动数据：

```bash
curl -O https://raw.githubusercontent.com/AidanAllen/workcheck/refs/tags/v__VERSION__/docker-compose.yaml
docker compose up -d --build
```

`workcheck.db`、`config.json`、飞书令牌都在卷里，容器重建不会丢。想回滚就把 compose 里的版本号改回上一个。

## 数据放在哪

| 位置 | 内容 |
| --- | --- |
| `workcheck.db`（+ `-wal` / `-shm`） | 看板数据、管理员账号、来源 |
| `config.json` | 三组平台凭证 |
| `feishu_token.json` | 飞书令牌，程序自动续期 |
| `*_usage.json` | 打码平台用量快照 |

容器里默认落在命名卷 `workcheck-data` 挂载的 `/data`；换机器把卷拷走即可。

## 配置项

平台凭证**不走环境变量**，只在页面上配。环境变量只管部署参数：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 监听端口 |
| `WORKCHECK_DATA_DIR` | 项目下 `data/` | 数据目录唯一出处，容器里指向 `/data` |
| `PULL_ENABLED` | `1` | 是否开启定时拉取飞书群数据 |
| `PULL_INTERVAL_MIN` | `120` | 拉取间隔（分钟） |
| `LOG_KEEP` | `20000` | 访问日志保留条数，超出清理最老的 |
| `ADMIN_TOKEN` | 空 | 应急入口：带上 `X-Admin-Token` 可绕过登录访问管理接口，**平时留空** |
