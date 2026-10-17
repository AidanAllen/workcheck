# workcheck · 第三方数据接收与可视化看板

把外部系统（签到脚本、订单系统、任意服务）推来的 JSON 收进 SQLite，用网页看板展示趋势与明细，
并带一条实时的访问日志流；同时按天聚合飞书群的签到数据。

三件事是它的核心：

- **收数据**：每个来源一把独立 API Key，`POST /api/ingest` 入库，唯一键保证重推不重复
- **飞书群签到**：走你本人的 OAuth 身份读群消息，服务进程直接入库 —— 不用拉机器人进群，不用 API Key
- **看板**：余额、签到日历、实时日志与原始报文，手机上也能看

---

## 目录

- [快速开始](#快速开始)
- [配置只有一处](#配置只有一处)
- [界面](#界面)
- [收数据](#收数据)
- [接口一览](#接口一览)
- [飞书群签到数据](#飞书群签到数据)
- [打码平台余额](#打码平台余额)
- [定时拉取](#定时拉取)
- [测试](#测试)
- [访问控制](#访问控制)
- [可调参数](#可调参数)
- [发版](#发版)
- [目录结构](#目录结构)
- [部署](#部署)
- [手机端（安卓 App）](#手机端安卓-app)

---

## 快速开始

### 本地跑

```bash
npm install
npm start
```

浏览器打开 http://localhost:3000 。端口被占用时会自动顺延到 3001、3002…

### Docker 跑

编排文件的构建上下文直接指向 GitHub 仓库，**不用先 clone**：

```bash
curl -O https://raw.githubusercontent.com/AidanAllen/workcheck/refs/tags/v1.0.2/docker-compose.yaml
docker compose up -d --build
```

细节见文末 [部署](#部署)。

### 首次使用三步

1. 打开 **`/setup.html`**（看板右上角有入口）→ 库里没有账号，会先让你**创建管理员**
2. 切到 **「配置信息」** 标签，填 CapSolver / TT识图 / 飞书的凭证 → 保存即生效
3. 点「飞书授权」完成一次 OAuth，再点「**立即拉取一次**」，签到数据就进看板了

### 确认跑的是哪个版本

```bash
curl -s http://127.0.0.1:3000/api/health
# {"ok":true,"time":"...","app":"workcheck","version":"1.0.2"}
```

---

## 配置只有一处

三组平台凭证统一放在数据目录下的 **`config.json`**（默认 `data/config.json`），
页面上改完立即生效、不用重启。**没有环境变量覆盖**，也不散落在数据库或各平台独立文件里 ——
避免出现「到底哪一份在生效」的问题。

```json
{
  "capsolver": { "apiKey": "CAP-xxx", "lowThreshold": 0.5, "unitPricePer1k": 0.8 },
  "ttshitu":   { "username": "账号", "password": "密码" },
  "feishu":    { "appId": "cli_xxx", "appSecret": "xxx", "chatId": "", "redirectUri": "" }
}
```

这个文件不进版本库（`.gitignore` 已排除），容器里落在挂载卷 `/data` 下，落盘权限 `600`。
仓库里的 `config.example.json` 是字段样例，**不要往里填真凭证** —— 它进版本库。

关于飞书这一组，有三条容易踩的：

- **群 ID 没有源码级默认值，必须自己填一次**（从飞书群链接或开放平台获取）。
  它是你的实际群标识，写进源码就等于跟着仓库公开出去；没填时拉取会直接报「未配置飞书群 ID」
- **回调地址有默认值** `http://localhost:3000/feishu/callback`，页面上输入框的 placeholder 就是它
- **scope 不需要配**（页面上已经没有这个输入框）：权限的真正来源是飞书开发者后台「权限管理」里
  申请并发布的那份列表，授权 URL 里的 `scope` 只是可选的「增量授权」参数。程序固定使用
  `im:message im:chat:readonly`；真要换权限请去后台申请，并改 `server/config.js` 的 `DEFAULT_SCOPE`

---

## 界面

| 路径 | 用途 |
|---|---|
| `/` | **看板**：两个标签页 —— 📊 数据看板（打码平台余额、最新一次签到、签到日历）、🧾 日志报文（实时日志、最近原始报文）。只读展示，不放任何操作项 |
| `/setup.html`（`/setup` 亦可） | **接入配置**：两个标签页 —— **数据推送**（来源与 API Key 管理、curl / JS 推送示例、链路自检）、**配置信息**（三组凭证、飞书授权与回调地址比对、立即拉取）。**需要登录** |

两页共用 `public/common.js`（`$ / api / toast / escapeHtml` 等基础函数），
看板逻辑在 `app.js`，接入配置逻辑在 `setup.js`。前端是原生 HTML/CSS/JS，不依赖任何 CDN。

### 看板面板

- **四个面板都能点标题行折叠**（默认全部展开，只有报文默认收起），状态各记一份存在本地；
  收起时不请求该面板的数据，展开时补拉一次
- 面板可拖标题前的 `⠿` 排序，顺序存在浏览器本地
- 两个列表都按 **每页 20 条** 分页，底部「‹ 上一页 / 第 x/y 页 · 共 n 条 / 下一页 ›」，列表自身滚动不撑长页面
- 📅 **签到日历点任意一天看当天明细**：各平台的签到时刻、失败原因、当天跑了几次
- 日志走 SSE 实时推送，页面不做轮询；面板内容无变化时不重绘，避免打断鼠标悬停

### 主题（可切换）

顶栏右侧的分段控件切换主题，选择存在 localStorage，刷新、换页面都保持。

| 主题 | 文件 | 壁纸 | 取色 |
|---|---|---|---|
| 🌸 初樱（默认） | `public/themes/sakura.css` | `bg/portrait.jpg` / `bg/landscape.jpg` | 暖褐暗部 + 发粉 `#ff9fb9` + 暖光蜜桃 `#f2b48c` |
| 🌧 雨夜 | `public/themes/rain.css` | `bg/rain-portrait.webp` / `bg/rain-landscape.webp` | 石板蓝 `#8ba7cd` 主色，成功=冰蓝 `#b9e0f0`、失败=红瞳暗玫 `#d96485`、漏签=街灯暖琥珀 `#dfb272` |

- 竖屏窗口（含手机）自动用 9:16 壁纸，横屏用 16:9；遮罩浓度也是主题变量（`--wall-scrim`）
- `public/style.css` 只放布局，其 `:root` 是「默认主题」兜底 —— 主题文件加载失败时页面依然可用
- **主题 link 必须由 head 内联脚本在解析期用 `document.write` 写出并直接带上正确的 href**。
  别改成「先写空 link、等 JS 再补 href」：那样浏览器不把它当阻塞渲染的样式表，
  会先用兜底色（= 初樱）画一帧，非默认主题的用户每次刷新都看见初樱闪一下（实测踩过的坑）
- **浅主色要配深字**：「主色渐变 + 文字」的地方统一用 `--accent-on`，失败徽章用 `--fail-badge-text`。
  新主题主色偏浅时记得在主题文件里把这两个变量改成深色

**添加新主题**（两步）：往 `public/themes/` 放 `<名字>.css`（只写 `:root` 变量，结构照 `sakura.css`），
再在 `public/common.js` 的 `THEMES` 数组加一行 `{ id, icon, name }`。id 只能用小写字母 / 数字 / 连字符
（head 内联脚本按这个字符集白名单拼链接，防 localStorage 怪值注入 HTML）。

---

## 收数据

```bash
curl -X POST http://localhost:3000/api/ingest \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: 你的APIKey" \
  -d '{"orderId":"ORD-1001","amount":268.5,"status":"paid","timestamp":"2026-10-13T11:47:00+08:00"}'
```

- 支持的请求体形态：单个 JSON 对象、`{"events":[...]}`、`{"data":[...]}`，或直接一个数组
- 单次最多 **500 条**（`server/index.js` 的 `MAX_BATCH`）
- 首次启动会自动创建「示例来源」并在控制台打印它的 API Key；新增来源、复制 Key、停用或删除
  都在 **接入配置页 `/setup.html`**

### 通用收纳规则

不需要预先定义字段结构，报文进来后自动处理：

- **事件 ID**：依次尝试 `eventId / event_id / id / uid / orderId / order_id / traceId / trace_id / uuid / sn`，
  都没有就按内容哈希生成。同一来源下 ID 重复会被丢弃（幂等）
- **业务时间**：依次尝试 `timestamp / time / ts / createdAt / created_at / eventTime / event_time / date / datetime`，
  秒级和毫秒级时间戳都能识别

原始报文完整保存在 `raw_events` 表，清洗规则随时可以重跑。
该表**没有自动清理**：那是有业务字段的实际数据，删了不可逆；长期跑库会变大，
需要的话按 `received_at` 手动归档旧记录。

---

## 接口一览

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/ingest` | 接收推送，Header `X-Api-Key` 或 `Authorization: Bearer` |
| GET | `/api/health` | 健康检查，返回 `{ ok, time, app, version }` —— 部署后用它确认版本 |
| GET | `/api/checkin/daily` | 签到数据按天聚合，`?days=7\|14\|30`（不传或 0 为全部） |
| GET | `/api/logs` | 历史日志，`limit` / `offset` / `status=ok\|fail` / `source=`，返回 `{ items, total }` |
| GET | `/api/stream/logs` | SSE 实时日志流 |
| GET | `/api/events` | 最近原始报文，`limit` / `offset`，返回 `{ items, total }` |
| GET | `/api/ttshitu/balance` | TT识图余额与今日识别次数推算 |
| GET | `/api/capsolver/balance` | CapSolver 云盾余额与今日消耗推算 |
| GET/POST/DELETE | `/api/sources` | 来源与 API Key 管理（需登录） |
| GET | `/api/sources/:id/key` | 取明文 Key（需登录；内置来源返回 404） |
| POST | `/api/sources/:id/enabled` | 停用 / 启用来源（需登录） |
| GET/PUT/DELETE | `/api/credentials[/:group]` | 三组平台凭证（需登录；读出的一律掩码） |
| POST | `/api/demo/push` | 灌入模拟数据，用于链路自检（需登录） |
| GET | `/api/scheduler` | 定时拉取状态与最近 20 次历史（需登录） |
| POST | `/api/scheduler/run` | 立即拉取一次（需登录；`{"full":true}` 为全量重建） |
| GET/POST | `/api/feishu/*` | 飞书 OAuth：`auth` / `callback` / `status` / `check-redirect`（需登录） |
| POST | `/api/auth/setup` | 创建管理员（库里没有账号时） |
| POST | `/api/auth/login` / `/api/auth/logout` | 登录 / 退出 |
| GET | `/api/auth/state` | 当前登录态 |
| POST | `/api/auth/password` | 改密码（需登录，要验当前密码） |

---

## 飞书群签到数据

用**用户身份 OAuth** 读取群消息（不需要把机器人拉进群，也能读历史消息）。

首次使用：到 **`/setup.html` → 配置信息** 填好应用凭证与群 ID，再点「飞书授权 / 重新授权」，
令牌存到 `data/feishu_token.json`，过期会自动用 refresh_token 续期。
授权报错 20029 时，用同页的回调地址比对工具逐字核对。
OAuth 的 `state` 每次随机生成并存 Cookie，回调时逐枚比对一次性值 —— 防止别人拿自己的授权码拼链接来劫持会话。

**数据由服务进程直接拉取入库**：点「立即拉取一次」，或等定时器（默认每 2 小时）。
不需要任何 API Key，也不存在「脚本推送」这条链路。

解析两类卡片：`📊 贴吧签到结果`（总数/成功/失败）与 `📊 色花堂自动签到`（登录/回复/签到三项状态 + 耗时）。
解析规则集中在 `server/checkin.js`，接口与拉取逻辑共用同一份实现。

### 幂等键是「平台@业务时间」，不是 message_id

同一条签到被重推时飞书会生成新的 `message_id`，用它做键会让同一次签到变成两条；
业务时间取自卡片正文（如 `2026-10-14T00:05:08+08:00`），重推也不变，用它去重才稳。
时间缺失时逐级退化到日期、`message_id`，保证不会互相覆盖。

三层去重：

| 层 | 位置 | 作用 |
|---|---|---|
| 入库 | `raw_events.event_id` 唯一索引 | 同一次签到重推 → 计入 duplicated，不重复入库 |
| 解析 | `checkin.dedupeRecords()` | 拉取逻辑与接口共用，合并同键记录并记下尝试次数 |
| 聚合 | `checkin.aggregate()` | 同一天跑过多次只出一根柱，取最终状态 |

同一天跑多次时保留业务时间最晚的那条（重试后成功就显示成功），但会带出 `attempts`（次数）
和 `hadFailure`（过程中是否失败过），日历上标 `↻`，悬停可看详情 —— 不把重试掩盖掉，也不让重试误报成失败。

### 增量拉取（水位线）

拉取不是每轮把整个群重扫一遍，而是只问飞书「上次拉到的时间点之后有什么」：

- **水位线**存在 `data/feishu_pull_state.json`，记着「哪个群 + 拉到哪了」。下次拉取带上 `start_time`，
  由飞书服务端把旧消息滤掉 —— 通常**一页就结束**，与群里总共有多少条消息无关
- **`start_time` 往前回退 1 小时**（`PULL_OVERLAP_SEC`）。飞书没写清这个参数是开区间还是闭区间，
  消息也可能延迟到达，所以刻意多退一点；多拉的重复由唯一索引幂等吸收，成本为零 —— 宁可多拉，不可漏拉
- **万一飞书没采纳 `start_time`**，第一页就会被识破（返回里出现了更早的消息），随即改成降序从最新往回翻、
  碰到不比水位线新的就停。没这层兜底的话，参数一失效就悄悄退化成「每轮翻完整群」，而且很难察觉
- **换群自动全量**：水位线连带记着群 ID，换了群就用不上，自动从头拉
- **停机自动补齐**：停机三天后重启，`start_time` 还是三天前那个点，缺口自然补回来
- **水位线只在完整翻完后才推**：中途撞上翻页上限就下次重来，宁可浪费一次请求也不跳数据

需要重扫全群时（换群之后、或怀疑漏了数据），点页面上的**「全量重建」**，
或 `curl -X POST /api/scheduler/run -d '{"full":true}'`。重复数据会自动去重。

### 为什么去掉了「脚本推送」

早期形态是：定时器 spawn 子进程跑 `scripts/parse_checkin.js --push`，脚本再 HTTP POST 回 `/api/ingest`。
代价是：① 脚本要一把 API Key，而管理接口早已要求登录、且不再下发明文 Key；
② 用户一旦删掉那个来源的 Key，整条链路就断；③ 子进程 + HTTP + 待推暂存 + 已推清单，
四套外部状态要维护。改成进程内直写之后这些全部消失。要单纯跑解析单测仍然可以：`npm run selftest`。

---

## 打码平台余额

首页「💰 打码平台余额」并排显示两个平台。凭证在 **`/setup.html` → 配置信息** 里填写，
服务端保存明文、前端只见结果。接口带 15 秒超时与 30 秒缓存，不是每次刷新都打官方接口。

| 平台 | 配置字段 | 官方接口 | 展示内容 |
|---|---|---|---|
| TT识图 | `username` / `password` | `GET https://api.ttshitu.com/queryAccountInfo.json?username=&password=` | 余额（元）、**今日识别次数**、累计消费（元） |
| CapSolver 云盾 | `apiKey` / `lowThreshold`（默认 0.5）/ `unitPricePer1k`（默认 0.8） | `POST https://api.capsolver.com/getBalance` body `{"clientKey":"..."}` | 余额（USD）、今日消耗与折算次数、套餐数 |

**两家官方都没有「今日用量」接口**，所以当天数据都用**快照差值**推算：每次查到真实数据就记一笔到
按天的快照文件（最多留 60 天），用「今日首次采样 → 当前」的增量得出当日用量，hover 会显示这天从几点开始统计。
服务端每 10 分钟自动采样一次（`unref` 定时器，不看板也记账，进程启动时立刻采一笔）。

- **TT识图**（快照 `data/ttshitu_usage.json`）：官方只有识别 / 报错 / 余额三个接口，
  余额接口返回的 `balance / consumed / successNum / failNum` 全是**账号开通以来的累计值**；
  今日识别次数取 `successNum / failNum` 的当日增量，**数值是准确的**（不是按单价折算的估算）
- **CapSolver**（快照 `data/capsolver_usage.json`）：公开接口只有 `createTask / getTaskResult / getBalance`
  三个（试过 `getTodayTaskCount`、`getUserInfo`、`getStatistics` 等十余个路径全是 404；dashboard 统计页要登录
  session，不认 clientKey），只能按「今日首次采样余额 − 当前余额」算消耗，再用 `unitPricePer1k` 折算成次，**只是估算**
- 快照文件是派生数据，删掉会自动重建，**不属于配置**；配置只有 `config.json` 一个
- 折算误差：不同验证码类型单价不同（CapSolver 默认 0.8 是 reCAPTCHA v2 档），改单价即改估算结果
- 服务没在跑的时段没有采样，那部分用量不会计入；当天首次采样之前花掉的自然也算不进来
- CapSolver 当天充过值会标出「当天充过值」，此时消耗不再有意义（TT识图的累计计数不受充值影响）
- 余额低于 `lowThreshold`（默认 0.5 USD）时数字转琥珀色并提示充值

---

## 定时拉取

服务启动后自带定时器，每 2 小时拉一次并**直接写入数据库**，启动时会先跑一次补回停机期间的缺口。

```bash
PULL_INTERVAL_MIN=120 npm start                        # 默认就是 120
curl -X POST http://localhost:3000/api/scheduler/run   # 手动立刻跑一次
curl http://localhost:3000/api/scheduler               # 查看执行状态与历史
```

页面上也能触发：**接入配置 → 配置信息 → 立即拉取一次**，旁边显示定时状态与上次结果。

设计要点：

- 拉取在**服务进程内**完成（`server/checkin_pull.js`）：取令牌 → 拉群消息 → 解析去重 → `insertMany`
- 幂等完全交给数据库的 `UNIQUE(source_id, event_id)`，**不再需要「已推清单」**
- 服务没起来就没有拉取这回事，**不再需要「待推暂存」**
- 同一次没跑完不会启动下一次；失败后 15 分钟自动补跑一次
- 单次超过 `PULL_TIMEOUT_MS`（默认 5 分钟）会中止，不会让调度器永远停在「运行中」
- 数据挂在名为 `飞书签到（内置）` 的来源下（列表里标「内置」，不可删除）
- 这个来源**不持有推送 Key**：它的数据是进程内直接写进去的，全程不走 HTTP，
  留一把 `/api/ingest` 的 Key 既没用、又等于给签到看板留了个可被灌假数据的入口。
  页面上的 Key 位显示「无需 Key」，取 Key 的接口对它返回 404

---

## 测试

```bash
npm run selftest   # 解析规则单测（10 个用例）—— 纯函数，动 server/checkin.js 后跑
npm run flowtest   # 端到端流程测试（109 项）—— 动路由 / 鉴权 / 入库后跑
npm run pulltest   # 飞书增量拉取回归（30 项）—— 动 server/checkin_pull.js 后跑
```

- `selftest` 只测解析规则
- `flowtest` 会**另起一个隔离实例**（独立 data 目录、独立端口、关掉定时拉取），把 HTTP 链路整条跑一遍：
  鉴权与会话、来源管理、入库与去重、停用闸门、演示推送、查询与聚合、SSE、凭证配置、调度、改密码、
  登录限流、静态资源，最后直接读 SQLite 核对落库结果。**不碰你的 `data/`**，退出码非 0 即有用例失败
- `pulltest` 把 `globalThis.fetch` 换成假飞书接口，跑 `server/checkin_pull.js` 的真代码，
  验证增量拉取的各条分支（首次全量、`start_time` 被忽略时的降序兜底、换群重置、水位线不回退与时钟回拨）。
  不需要真令牌，不碰真实 API —— 它单独成脚本是因为要替换全局 `fetch`，必须在同一进程内完成

---

## 访问控制

`/api/ingest`（收数据）靠来源自己的 `X-Api-Key`，这一条一直有。其余接口分三类：

### 管理类 —— 需要账号密码登录

**接入配置页**（`/setup.html`）要登录才能用。第一次打开时库里没有账号，页面显示**创建管理员**；
建完之后再进来就是**登录**页。登录成功后才渲染管理内容，右上角显示当前账号和「退出登录」。

**改密码**：点右上角「已登录 <账号>」弹出面板，要填当前密码 + 新密码两遍。保存成功后：
当前这台设备不用重新登录，其它设备的登录状态**全部失效**（页面会告诉你踢掉了几个会话）。

把关的接口：`/api/sources*`（删除来源会**连带删掉该来源的全部历史报文**，不可恢复；内置来源不允许删除）、
`/api/credentials*`、`/api/demo/push`、`/api/scheduler*`、`/api/feishu/*`、
`/api/auth/password`。

| 项 | 做法 |
| --- | --- |
| 密码存储 | `scrypt` 加盐哈希，库里不存明文，也不存可逆的东西 |
| 密码校验 | `timingSafeEqual` 定长比较，避免靠响应时间试探 |
| 会话 | 32 字节随机 token 存 `sessions` 表，`HttpOnly` + `SameSite=Lax` Cookie，有效期 7 天 |
| 撞库 | 同一 IP + 账号 5 分钟内错 5 次就锁 5 分钟 |
| 账号枚举 | 账号不存在和密码错误返回同一句提示 |

会话过期或被踢下线时，页面会自动退回登录屏，不会留一个「点了没反应」的死界面。

**忘了密码**：走预留的应急通道 ——

```bash
ADMIN_TOKEN=your-secret node server/index.js
curl -H "X-Admin-Token: your-secret" http://127.0.0.1:3000/api/sources
```

只想重建管理员时用这行（只删账号和会话，不碰来源与历史报文）：

```bash
node -e "const db=require('./server/db.js');db.db.prepare('DELETE FROM sessions').run();db.db.prepare('DELETE FROM admins').run()"
```

删完重启服务，重开 `setup.html` 就是创建页了。

### 看板类 —— 仍对外开放

`/`、`/api/checkin/daily`、`/api/logs`、`/api/events`、`/api/stream/logs`、`/api/health` 不需要登录，
手机在同一局域网能正常看。出于隐私考虑，**访问日志里的来源 IP 不会下发**给任何前端和 SSE，只在数据库留存。

> 提醒：如果外面套了 Nginx 反代，Node 这层看到的来源 IP 是 Nginx 的（登录限流会把所有人当成同一个 IP）。
> **`ADMIN_TOKEN` 是唯一贯穿所有管理接口的静态凭证**，一旦设置就相当于永久后门，用完记得取消。

---

## 可调参数

环境变量只放**部署参数**。三家平台的凭证不属于这里 —— 它们在 `data/config.json`，页面上改。

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `3000` | 监听端口；被占用时自动顺延到 3001、3002… |
| `WORKCHECK_DATA_DIR` | 项目下 `data/` | 数据目录唯一出处（`server/data_dir.js`）。数据库、`config.json`、飞书令牌、用量快照全部跟着它走；容器里指向挂载卷 `/data` |
| `RATE_LIMIT` | `600` | 每来源每分钟请求上限 |
| `LOG_KEEP` | `20000` | `access_logs` 保留条数，超出后每 6 小时清理一次最老的 |
| `ADMIN_TOKEN` | 空 | 管理接口应急口令，见「访问控制」 |
| `PULL_ENABLED` | `1` | 设 `0` 关闭定时拉取（页面上的「立即拉取」仍可用） |
| `PULL_INTERVAL_MIN` | `120` | 定时拉取间隔分钟数 |
| `PULL_START_DELAY` | `8` | 启动后首次拉取的延迟秒数 |
| `PULL_RETRY_MIN` | `15` | 一轮失败后补跑的间隔分钟数 |
| `PULL_TIMEOUT_MS` | `300000` | 单次拉取超时（毫秒） |
| `PULL_OVERLAP_SEC` | `3600` | 增量起点往前回退多少秒（防漏；多拉的重复会被幂等吸收） |
| `PULL_MAX_PAGES` | `200` | 单次拉取的翻页上限，撞上就下次继续，不推水位线 |

单次批量上限在 `server/index.js` 的 `MAX_BATCH`。

---

## 发版

一个版本号散在**三处文件、五个位置**，手工改漏一处的后果不轻 —— 尤其是漏了
`docker-compose.yaml` 的 `context`，用户下到的编排文件还指着旧版本，部署出来就是旧代码。
所以发版走脚本：

```bash
npm run release 1.0.3              # 正式版
npm run release 1.1.0-rc.1         # 预发布（GitHub 上会标 pre-release）
bash scripts/release.sh 1.0.3 --dry-run   # 只检查、打印将做什么，不改任何东西
```

脚本按顺序做六件事，任一步失败就停：

1. **前置检查** —— 版本号格式（semver，允许 `-rc.1`）、工作区干净、在 `main` 上、标签不存在、
   与远程同步，以及**当前各处版本号本身是否自洽**（不自洽就先修再来发）
2. **同步版本号** —— `package.json`(1 处) / `package-lock.json`(2 处) /
   `docker-compose.yaml`(4 处：context、image、两处注释)，改完由 `check-version.js` 复核一致
3. **跑 `selftest`** —— 不过就中止
4. **提交并推送 `main`**
5. **打附注标签并推送**
6. **按 `release-notes-template.md` 生成正文**（本版变化从 `<上一标签>..HEAD` 的提交历史按前缀
   自动归类：`feat:` 新功能 / `fix:` 修复 / `ui:` 界面 / `perf:` 优化 / `docs:` 文档 /
   `chore:` 杂项，其余进「其他」）+ `gh release create`

> 发版前建议先用 `--dry-run` 扫一眼生成的说明正文，别只看脚本有没有报错 ——
> 说明是先生成再发布的，分类不对只能事后用 `gh release edit --notes-file` 补修。

**compose 有两种形态，脚本都能处理**：钉版本（`#v1.0.2` + `:v1.0.2`）时它同步那 4 处；
跟分支（`#main` + `:main`）时文件里没有版本号，脚本跳过并打印说明。
⚠️ 想在发版时让脚本接管 compose，**发版前 compose 必须已经处于「钉版本 + 当前版本号」状态并已提交推送** ——
脚本是「从 package.json 的当前版本往上替换」，你若手工先写成了目标版本，它找不到旧版本号、替换 0 处，会直接中止。

单独检查版本号一致性：

```bash
npm run check-version          # 只检查
npm run check-version 1.0.2    # 额外断言等于 1.0.2
```

⚠️ **发版后要在远端核验**，别只信脚本的「已推送」打印。交叉验证：

```bash
git ls-remote --tags origin
gh release list
curl -sI https://raw.githubusercontent.com/AidanAllen/workcheck/refs/tags/v1.0.2/docker-compose.yaml | head -1
```

---

## 目录结构

```
server/index.js        接入网关：鉴权、限流、幂等、API 路由
server/version.js      版本号读取（`/api/health` 用，取自 package.json）
server/config.js       唯一配置文件（data/config.json）的读写：三组平台凭证
server/db.js           SQLite 建表与查询
server/data_dir.js     数据目录唯一出处（WORKCHECK_DATA_DIR）
server/util.js         服务端小工具（读取 Cookie）
server/feishu.js       飞书 OAuth 路由（授权、回调、回调地址自检）
server/feishu_token.js 飞书令牌读写与自动续期（凭证每次现读，页面改完即时生效）
server/scheduler.js    定时拉取调度器
server/checkin.js      签到解析与去重核心（接口与拉取共用）
server/checkin_pull.js 飞书群拉取 + 直写入库（进程内，不经 HTTP、不需要 API Key）
server/ttshitu.js      TT识图余额 + 今日识别次数推算（快照 10 分钟后台采样）
server/capsolver.js    CapSolver 余额 + 今日消耗推算（快照 10 分钟后台采样）
scripts/selftest.js    解析规则单测
scripts/flowtest.js    端到端流程测试：起隔离实例把 HTTP 链路整条跑一遍
scripts/pulltest.js    飞书增量拉取回归（假飞书接口，跑真拉取代码）
scripts/release.sh     发版：同步版本号 → 跑测试 → 打标签 → 建 Release
scripts/check-version.js 版本号一致性检查（发版脚本改前/改后各调一次）
scripts/release-notes-template.md Release 正文模板（占位符 <!--CHANGELOG--> 与 __VERSION__）
public/               前端（原生 HTML/CSS/JS，不依赖 CDN）
  ├─ index.html       看板
  ├─ setup.html       接入配置页
  ├─ app.js           看板逻辑
  ├─ setup.js         接入配置逻辑
  ├─ common.js        公共函数 + 主题注册表 THEMES / applyTheme / initThemeSwitcher
  ├─ style.css        布局与组件样式（不含主题，:root 为默认主题兜底）
  ├─ themes/          主题文件（一主题一 css，只写变量）
  └─ bg/              壁纸（初樱 portrait/landscape，雨夜 rain-*.webp）
Dockerfile            多阶段构建（builder 装编译工具链，运行镜像只带运行时）
docker-compose.yaml   编排：直接以 GitHub 仓库为 build context，钉在发布标签上
config.example.json   config.json 的字段样例（真正的配置在 data/ 下，不进版本库）
data/                 SQLite 库、config.json（平台凭证）、飞书令牌、用量快照
```

### 数据表

| 表 | 用途 |
| --- | --- |
| `sources` | 推送来源与其 API Key（`api_key` 可空；内置的「飞书签到（内置）」没有 Key） |
| `raw_events` | 原始报文，按 `(source_id, event_id)` 唯一，幂等去重的基础 |
| `access_logs` | 每次推送与每轮拉取的日志（IP 只入库、不下发给前端） |
| `admins` / `sessions` | 接入配置页的登录账号与会话 |

> 早期「数值字段自动识别」功能的 `metrics` 表已随功能删除。
> 平台凭证不在数据库里 —— 只有 `data/config.json` 一个文件。
> `data/` 不进版本库（`.gitignore` 已排除，`.dockerignore` 也排除了它，不会打进镜像）。

### 恢复出厂

清空业务数据、重新走一遍初始化流程（**保留** `data/config.json` 里的三组平台凭证）：

```bash
node -e "
const db=require('./server/db');
db.db.exec('BEGIN');
['raw_events','access_logs','sessions','admins'].forEach(t=>db.db.prepare('DELETE FROM '+t).run());
db.db.exec('DELETE FROM sqlite_sequence');
db.db.exec('COMMIT'); db.db.exec('VACUUM');
"
rm -f data/*_usage.json      # 用量快照，删掉会自动重建
```

清完建议用 `PULL_ENABLED=0 npm start` 启动：否则服务起来会在 8 秒后先从飞书群拉一次历史签到，
刚清空的库立刻又被灌满（那是「补回停机缺口」的既定行为，不是没清干净）。确认干净后再恢复定时。

> 因为幂等靠数据库唯一索引、而不是外部「已推清单」，所以清库之后的历史数据
> **一定会被重新拉回来**（这正是我们想要的：库是唯一真相）。只想保留近 N 天的话，
> 把 `server/checkin_pull.js` 的 `pull({ days: N })` 参数用起来，
> 或在「配置信息」里把群 ID 临时改成另一个群。

---

## 部署

### 方式一：Docker（推荐）

```bash
# 1. 下载编排文件（钉在当前发布标签上）
curl -O https://raw.githubusercontent.com/AidanAllen/workcheck/refs/tags/v1.0.2/docker-compose.yaml

# 2. 构建并启动
docker compose up -d --build

# 3. 打开配置页，创建管理员，然后在「配置信息」标签里填三组凭证
open http://<服务器IP>:3000/setup
```

也可以不写 compose、直接一条命令（仓库要公开可访问）：

```bash
docker build -t workcheck https://github.com/AidanAllen/workcheck.git#main
docker run -d --name workcheck -p 3000:3000 -v workcheck-data:/data workcheck
```

> `docker-compose.yaml` 里的 `build.context` 指向本仓库的发布标签。如果你 fork 了，
> 记得把那一行改成自己的地址（ref 用 `#` 指定）。

要点：

- **凭证全部在页面上配**，`docker-compose.yaml` 里不写任何密钥；
  容器环境变量只放部署参数（端口、数据目录、拉取周期）
- **数据卷是唯一要持久化的东西**：SQLite 库、`config.json`、飞书令牌、用量快照都在 `/data`。
  容器重建、镜像升级都不丢数据；迁移机器时把卷拷走即可
- 镜像用 `node:22-slim`（不是 alpine）：`better-sqlite3` 不为 musl 提供预编译包，
  alpine 上每次都要从源码编译。构建阶段装 `python3/make/g++`，运行阶段只带编好的 `.node`
- 容器里以 `node` 用户（非 root）运行，`config.json` 落盘时权限是 `600`
- 端口默认映射到 `0.0.0.0`。这是管理后台，**只给本机或内网访问就改成 `127.0.0.1:3000:3000`**

### 方式二：直接跑（PM2 / systemd）

代码本身跨平台（路径用 `path.join`）：

```bash
npm ci --omit=dev
PULL_INTERVAL_MIN=120 pm2 start server/index.js --name workcheck
pm2 save && pm2 startup      # 开机自启
```

### 时区

消息时间是从卡片文本里正则提取的字符串（不是 `new Date` 转换），
所以 UTC 服务器上显示的签到时间依然是北京时间，不受影响。
容器里仍建议设 `TZ=Asia/Shanghai`（compose 已默认设置），这样日志时间戳读起来顺眼。

### 安全边界

`/setup.html` 与所有管理接口都要登录，`/api/ingest` 要 API Key；
只有看板本身（`/`、`/api/checkin/daily`、`/api/logs`、`/api/events`、`/api/stream/logs`、`/api/health`）开放。
放进公网前建议：

1. 改掉默认映射，或只在内网 / 组网（WireGuard、Tailscale）里访问
2. 前面挂 Nginx 并配 HTTPS —— 否则管理员密码是明文过网的
3. 如果挂了反代，记得让 Node 能看到真实来源 IP（否则登录限流会把所有人当成同一个 IP）

---

## 手机端（安卓 App）

手机上看这套看板有个专门的壳：**看板娘** —— 一个 Capacitor 7 安卓工程，里面只有一个 WebView 装着本站点。
代码在**独立仓库**：

> <https://github.com/AidanAllen/workcheck-app>

分成两个仓库而不是放一个仓库的两个目录，是因为两边**没有任何共享代码**：
App 只持有一个站点地址，一行后端代码都不引用；技术栈也不搭界（Node/SQLite 与 Gradle/Java 21）。
更实际的原因是版本号 —— 本仓库发版打的是 `v1.0.2` 这种标签，App 那边出 APK 的 CI 监听的也是 `v*`，
而 **Git 标签全局唯一、不分分支**，挤在一个仓库里必然撞车。

对使用者而言两边完全解耦：

- App 不含任何业务页面，内容实时从服务器加载，**改网页不需要重新发 App 版本**
- 站点地址首次启动在 App 里填（存本机 SharedPreferences），同一个 APK 可以分发给不同的人，各自连自己的站点
- 网页端照常用 `npm run release` 发版，部署链路没有任何变化
