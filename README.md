# workcheck · 第三方数据接收与可视化看板

接收第三方推送的 JSON 数据，原样留存 + 实时图表与日志展示；并按天聚合飞书群的签到数据。

## 快速开始

```bash
npm install
npm start
```

浏览器打开 http://localhost:3000 。端口被占用时会自动顺延到 3001、3002…

首次使用走三步：

1. 打开 **`/setup.html`**（看板右上角有入口）→ 库里没有账号，会先让你**创建管理员**
2. 切到 **「配置信息」** 标签，填 CapSolver / TT识图 / 飞书的凭证 → 保存即生效
3. 点「飞书授权」完成一次 OAuth，再点「**立即拉取一次**」，签到数据就进看板了

> 容器化部署（直接从 GitHub 拉代码运行）见文末 [部署](#部署) 一节：
> `docker compose up -d --build` 即可，凭证同样在页面上配。

### 配置只有一处

三个平台的凭证统一放在数据目录下的 **`config.json`**（默认 `data/config.json`），
页面上改完立即生效、不用重启。没有环境变量覆盖，也不散落在数据库或各平台独立文件里 ——
避免出现「到底哪一份在生效」的问题。

```json
{
  "capsolver": { "apiKey": "CAP-xxx", "lowThreshold": 0.5, "unitPricePer1k": 0.8 },
  "ttshitu":   { "username": "账号", "password": "密码" },
  "feishu":    { "appId": "cli_xxx", "appSecret": "xxx", "chatId": "", "redirectUri": "" }
}
```

飞书那三项留空时用内置默认值（群 ID、`http://localhost:3000/feishu/callback`、`im:message im:chat:readonly`），
页面上输入框的 placeholder 就是那个默认值。这个文件不进版本库（`.gitignore` 已排除），
容器里落在挂载卷 `/data` 下。

## 主题模块（可切换）

顶栏右侧的分段控件切换主题，选择存在浏览器 localStorage，刷新、换页面（含接入配置页）都保持；
主题文件挂在 `<link id="themeCss">` 上。这个 link 由 head 的内联脚本在**解析期**用
`document.write` 写出并直接带上正确的 href —— 样式表必须在解析期就位才能阻塞首屏渲染。
别改成「先写空 link、等 JS 再补 href」：那样浏览器会把主题 css 当成脚本动态加载、不阻塞渲染，
会先用 `style.css` 的兜底色（= 初樱）画一帧，非默认主题的用户每次刷新都看见初樱闪一下
（实测踩过的坑，探针里 rAF 首帧从 51ms 推到主题 css 到货后才恢复就是证据）。

| 主题 | 文件 | 壁纸 | 取色 |
|---|---|---|---|
| 🌸 初樱（默认） | `public/themes/sakura.css` | `bg/portrait.jpg` / `bg/landscape.jpg` | 暖褐暗部 + 发粉 `#ff9fb9` + 暖光蜜桃 `#f2b48c` |
| 🌧 雨夜 | `public/themes/rain.css` | `bg/rain-portrait.webp` / `bg/rain-landscape.webp` | 一蓝到底：主色=天青石板蓝 `#8ba7cd`（壁纸主导色 `#506080/#7080a0` 提亮）、成功=冰蓝 `#b9e0f0`、失败=红瞳暗玫 `#d96485`、漏签=街灯暖琥珀 `#dfb272` |

- 竖屏窗口（含手机）自动用 9:16 壁纸，横屏用 16:9（`max-aspect-ratio: 1/1` 媒体查询），
  遮罩浓度也是主题变量（`--wall-scrim`），雨夜天空亮所以遮罩更重
- `public/style.css` 只放布局，其 `:root` 是「默认主题」兜底——主题文件加载失败时页面依然可用；
  界面为深色玻璃：半透明面板 + `backdrop-filter` 模糊，卡中卡用更淡的 `--surface-2`
- 主题色直接从壁纸采样取值，不凭肉眼估：把图塞进 canvas 缩到 96×54 后统计主色与分区均值
  （这一步用无头浏览器跑，`--dump-dom` 把结果带出来）。雨夜那两张实测九成是蓝灰，暖色只占零头，
  所以整套配色以壁纸主导的石板蓝为基调，主色也用蓝
- 两主题的状态色都避开了绿色和紫色：初樱 成功=蜜桃/失败=眼色玫红；
  雨夜 成功=冰蓝 `#b9e0f0`（比主色更浅一档，避免和蓝色主色混）/ 失败=红瞳暗玫 `#d96485` / 漏签=街灯暖琥珀 `#dfb272`
- **浅主色要配深字**：凡是「主色渐变 + 文字」的地方（标签、分段控件、按钮、toast）
  统一用 `--accent-on` 控制文字色；失败徽章同理用 `--fail-badge-text`。
  新主题的主色偏浅时，记得在主题文件里把这两个变量改成深色

### 添加新主题（两步）

1. 往 `public/themes/` 放一个 `<名字>.css`，结构照 `sakura.css`：只写 `:root` 变量
   （`--accent / --ok / --fail / --warn / --plat-tb / --plat-st / --wall-* / --wall-scrim / --*-grad-* / --glow-*`），
   壁纸图放 `public/bg/`；需要整体微调某个组件时再写具体选择器（参考 `rain.css` 末尾的 `.wallpaper::after`）
2. 在 `public/common.js` 的 `THEMES` 数组加一行 `{ id: '<名字>', icon: 'emoji', name: '名字' }`

刷新页面即可在顶栏看到新主题按钮，无需改其他任何文件。注意 id 只能用
小写字母 / 数字 / 连字符（head 内联脚本按这个字符集白名单拼链接，防 localStorage
怪值注入 HTML），首套大写或下划线的名字首屏会回落默认主题。

## 页面

| 路径 | 用途 |
|---|---|
| `/` | **看板**：两个标签页 —— 📊 数据看板（打码平台余额、最新一次签到、签到日历）、🧾 日志与报文（实时日志、最近原始报文）。**四个数据面板都能点标题行折叠**（默认全部展开，只有报文默认收起），状态各记一份存在本地；收起时不请求该面板的数据，展开时补拉一次。两个列表都按 **每页 20 条** 分页，底部「‹ 上一页 / 第 x/y 页 · 共 n 条 / 下一页 ›」，列表自身滚动不撑长页面）。面板可拖标题前的 `⠿` 排序，顺序存在浏览器本地；📅 签到日历点任意一天看当天明细。只读展示，不放任何操作项 |
| `/setup.html`（`/setup` 亦可） | **接入配置**：两个标签页 —— **数据推送**（来源与 API Key 管理、curl / JS 推送示例、链路自检）、**配置信息**（CapSolver / TT识图 / 飞书三组凭证、飞书授权与回调地址比对、立即拉取）。需要登录 |

两页共用 `public/common.js`（`$ / api / toast / escapeHtml` 等基础函数），
看板逻辑在 `app.js`，接入配置逻辑在 `setup.js`。

## 推送数据

```bash
curl -X POST http://localhost:3000/api/ingest \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: 你的APIKey" \
  -d '{"orderId":"ORD-1001","amount":268.5,"status":"paid","timestamp":"2026-10-13T11:47:00+08:00"}'
```

支持的请求体形态：单个 JSON 对象、`{"events":[...]}`、`{"data":[...]}`，或直接一个数组。单次最多 500 条。

首次启动会自动创建「示例来源」并在控制台打印它的 API Key；
新增来源、复制 Key、停用或删除都在 **接入配置页 `/setup.html`**（看板右上角有入口）。

## 接口一览

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/ingest` | 接收推送，Header `X-Api-Key` 或 `Authorization: Bearer` |
| GET | `/api/checkin/daily` | 签到数据按天聚合，`?days=7|14|30`（不传或 0 为全部） |
| GET | `/api/ttshitu/balance` | TT识图余额与今日识别次数推算（见下） |
| GET | `/api/capsolver/balance` | CapSolver 云盾余额与今日消耗推算（见下） |
| GET | `/api/logs` | 历史日志，支持 `limit` / `offset` / `status=ok\|fail` / `source=`，返回 `{ items, total }` |
| GET | `/api/stream/logs` | SSE 实时日志流 |
| GET | `/api/events` | 最近原始报文，支持 `limit` / `offset`，返回 `{ items, total }` |
| GET/POST/DELETE | `/api/sources` | 来源与 API Key 管理 |
| POST | `/api/demo/push` | 灌入模拟数据，用于链路自检 |
| GET | `/api/credentials` | 三组平台凭证（密钥一律掩码），需登录 |
| PUT/DELETE | `/api/credentials/:group` | 保存 / 清除某组凭证（`capsolver` / `ttshitu` / `feishu`），需登录 |
| GET | `/api/scheduler` | 定时拉取状态与最近 20 次历史，需登录 |
| POST | `/api/scheduler/run` | 立即拉取一次（进程内直写入库），需登录 |

## 通用收纳规则

不需要预先定义字段结构，报文进来后自动处理：

- **事件 ID**：依次尝试 `eventId / event_id / id / uid / orderId / order_id / traceId / trace_id / uuid / sn`，都没有就按内容哈希生成。同一来源下 ID 重复会被丢弃（幂等）。
- **业务时间**：依次尝试 `timestamp / time / ts / createdAt / created_at / eventTime / event_time / date / datetime`，秒级和毫秒级时间戳都能识别。

原始报文完整保存在 `raw_events` 表，清洗规则随时可以重跑。

## 飞书群签到数据接入

用**用户身份 OAuth** 读取群消息（不需要把机器人拉进群，也能读历史消息）。

首次使用：到 **`/setup.html` → 配置信息** 填好应用凭证，再点「飞书授权 / 重新授权」，
令牌存到 `data/feishu_token.json`，过期会自动用 refresh_token 续期。
授权报错 20029 时，用同页的回调地址比对工具逐字核对。

**数据由服务进程直接拉取入库**：点「立即拉取一次」，或等定时器（默认每 2 小时）。
不需要任何 API Key，也不存在「脚本推送」这条链路 —— 早期那个
`scripts/parse_checkin.js --push` 的形态已经移除了，原因见「定时拉取」一节。

```bash
npm run selftest        # 解析规则单测（10 个用例）
```

解析两类卡片：`📊 贴吧签到结果`（总数/成功/失败）与 `📊 色花堂自动签到`
（登录/回复/签到 三项状态 + 耗时）。

**幂等键是「平台@业务时间」，不是飞书的 `message_id`。** 同一条签到被重推时飞书会生成新的
`message_id`，用它做键会让同一次签到变成两条；业务时间取自卡片正文（如 `2026-10-14T00:05:08+08:00`），
重推也不变，用它去重才稳。时间缺失时逐级退化到日期、`message_id`，保证不会互相覆盖。

三层去重：

| 层 | 位置 | 作用 |
|---|---|---|
| 入库 | `raw_events.event_id` 唯一索引 | 同一次签到重推 → 计入 duplicated，不重复入库 |
| 解析 | `checkin.dedupeRecords()` | 拉取逻辑与接口共用，合并同键记录并记下尝试次数 |
| 聚合 | `checkin.aggregate()` | 同一天跑过多次只出一根柱，取最终状态 |

同一天跑多次时保留业务时间最晚的那条（重试后成功就显示成功），但会带出
`attempts`（次数）和 `hadFailure`（过程中是否失败过），日历上标 `↻`，悬停可看详情 ——
不把重试掩盖掉，也不让重试误报成失败。

解析规则集中在 `server/checkin.js`，接口与拉取逻辑共用同一份实现，改一处两边同时生效。

### 配置飞书应用凭证

开放平台的 **App ID / App Secret** 是运行期配置，**不要写进源码**。
到 **`/setup.html` → 配置信息 → 飞书应用凭证** 里填写，保存后立即生效、不用重启。

同页还可以改 **群 ID** 与 **回调地址**。

> **群 ID 没有源码级默认值**，必须自己填一次（从飞书群链接或开放平台获取）。
> 它是你的实际群标识，写进源码就等于跟着仓库公开出去 —— 所以这一项刻意留空，
> 没填时拉取会直接报「未配置飞书群 ID」。回调地址是通用值，可以给默认。
>
> **scope 不需要配置**（页面上已经没有这个输入框）：权限的真正来源是飞书开发者后台
> 「权限管理」里申请并发布的那份列表，授权 URL 里的 `scope` 只是可选的「增量授权」参数。
> 程序固定使用 `im:message im:chat:readonly`（读消息 + 读群）；真要换权限请去后台申请，并改
> `server/config.js` 里的 `DEFAULT_SCOPE`。

没配就点授权时页面会直接提示缺什么。OAuth 的 `state` 每次随机生成并存 Cookie，
回调时逐枚比对一次性值 —— 防止别人拿自己的授权码拼链接来劫持你的会话。

> `raw_events`（原始报文）没有自动清理：那是有业务字段的实际数据，删了不可逆，
> 所以不设自动清理。长期跑库会变大，需要的话按 `received_at` 手动归档旧记录。

## 看板「签到数据」面板

- **最新一次签到**：两个平台各一张卡 —— 成功/失败徽章、精确到秒的签到时间、关键数字
  （贴吧 成功/总数；色花堂 耗时 + 三个步骤状态）。以最新有数据的那一天为准。
- **签到日历**：月历网格，紫=当天全部成功、玫红=有失败、淡黄=漏签（开始统计之后过去了却没数据）、
  虚线=无签到，今天粉色描边，可翻月。底部统计本月签到/成功/失败/漏签天数 + 连续与最长连续；
  **点任意一天看当天明细**（各平台的签到时刻、失败原因、当天跑了几次）。
- **汇总条**：贴吧/色花堂的天数、成功失败数、成功率、平均与最长耗时，支持近 7/14/30 天 / 全部切换
  （只作用于这一条，日历始终看全量）。

日志走 SSE 实时推送，页面不做轮询；面板内容无变化时不重绘，避免打断鼠标悬停。

## 打码平台余额

首页「💰 打码平台余额」并排显示两个平台。
凭证在 **`/setup.html` → 配置信息** 里填写，统一落在 `data/config.json`，服务端保存明文、前端只见结果。
接口带 15 秒超时与 30 秒缓存，不是每次刷新都打官方接口。

| 平台 | 配置字段 | 官方接口 | 展示内容 |
|---|---|---|---|
| TT识图 | `username` / `password` | `GET https://api.ttshitu.com/queryAccountInfo.json?username=&password=` | 余额（元）、**今日识别次数**、累计消费（元） |
| CapSolver 云盾 | `apiKey` / `lowThreshold`（默认 0.5）/ `unitPricePer1k`（默认 0.8） | `POST https://api.capsolver.com/getBalance` body `{"clientKey":"..."}` | 余额（USD）、今日消耗与折算次数、套餐数 |

**两家官方都没有「今日用量」接口**，所以当天数据都用**快照差值**推算：每次查到真实数据就记一笔到按天的快照文件（最多留 60 天），用「今日首次采样 → 当前」的增量得出当日用量，前端 hover 会显示这一天是从几点开始统计的。
服务端每 10 分钟自动采样一次（`unref` 定时器，不看板也记账，进程启动时立刻采一笔），
「今日」的起点因此尽量早，不必等谁来打开页面。

- **TT识图 官方只有三个接口**：识别 `/predict`、报错 `reporterror.json`、余额
  `queryAccountInfo.json`（GET），没有任何按天/明细的统计接口。余额接口返回的
  `balance / consumed / successNum / failNum` 全是**账号开通以来的累计值**
- **TT识图**（快照存 `data/ttshitu_usage.json`）：今日识别次数取 `successNum / failNum` 的当日增量，
  **数值是准确的**（不是按单价折算的估算）；今日消耗虽在接口里返回，前端卡片不展示，
  卡片只保留三行：余额、今日识别次数、累计消费
- **CapSolver**（快照存 `data/capsolver_usage.json`）：公开接口只有 `createTask / getTaskResult / getBalance` 三个（试过 `getTodayTaskCount`、`getUserInfo`、`getStatistics` 等十余个路径全是 404；dashboard 的统计页要登录 session，不认 clientKey），只能按「今日首次采样余额 − 当前余额」算消耗，再用 `unitPricePer1k` 折算成次，**只是估算**
- 快照文件是采样出来的派生数据，删掉会自动重建，**不属于配置**；配置只有 `config.json` 一个
- 折算误差：不同验证码类型单价不同（CapSolver 默认 0.8 是 reCAPTCHA v2 档），改单价即改估算结果
- 服务没在跑的时段没有采样，那部分用量不会计入；当天首次采样之前花掉的自然也算不进来
- CapSolver 当天充过值会标出「当天充过值」，此时消耗不再有意义（TT识图的累计计数不受充值影响）
- 余额低于 `lowThreshold`（默认 0.5 USD）时数字转琥珀色并提示充值

## 定时拉取

服务启动后自带定时器，每 2 小时拉一次并**直接写入数据库**，启动时会先跑一次补回停机期间的缺口。

```bash
PULL_INTERVAL_MIN=120 npm start              # 默认就是 120
curl -X POST http://localhost:3000/api/scheduler/run   # 手动立刻跑一次
curl http://localhost:3000/api/scheduler               # 查看执行状态与历史
```

页面上也能触发：**接入配置 → 配置信息 → 立即拉取一次**，旁边显示定时状态与上次结果。

设计要点：

- 拉取在**服务进程内**完成（`server/checkin_pull.js`）：取令牌 → 拉群消息 → 解析去重 → `insertMany`
- 幂等完全交给数据库的 `UNIQUE(source_id, event_id)`，**不再需要「已推清单」**
  （早期要靠 `data/checkin_pushed_ids.json` 记录推过哪些，否则每轮全量推会把「重复」计数刷高）
- 服务没起来就没有拉取这回事，**不再需要「待推暂存」**（早期的 `data/checkin_pending.json`）
- 同一次没跑完不会启动下一次；失败后 15 分钟自动补跑一次
- 单次超过 `PULL_TIMEOUT_MS`（默认 5 分钟）会中止，不会让调度器永远停在「运行中」
- 数据挂在名为 `飞书签到（内置）` 的来源下（列表里标「内置」，不可删除）
- 这个来源**不持有推送 Key**：它的数据是进程内直接写进去的，全程不走 HTTP，
  留一把 `/api/ingest` 的鉴权 Key 既没用、又等于给签到看板留了个可被灌假数据的入口。
  页面上的 Key 位显示「无需 Key」，取 Key 的接口对它返回 404

### 为什么去掉了「脚本推送」

早期形态是：定时器 spawn 一个子进程跑 `scripts/parse_checkin.js --push`，脚本再 HTTP POST 回
`/api/ingest`。绕这一圈的唯一理由是「让脚本能脱离服务独立运行」，但代价是：

1. 推送要一把 API Key，而管理接口早已要求登录、且不再下发明文 key，脚本只能直接读库去「偷」；
2. **用户一旦删掉那个来源的 Key，整条链路就断** —— 而签到数据本来就不该依赖一个可被删掉的凭证；
3. 子进程 + HTTP + 待推暂存 + 已推清单，四套外部状态要维护，任一环节出错就丢数据。

改成进程内直写之后这四条全部消失。要单纯跑解析单测仍然可以：

```bash
npm run selftest
```

## 发版

一个版本号散在**三处文件、四个位置**，手工改漏一处的后果不轻 —— 尤其是漏了
`docker-compose.yaml` 的 `context`，用户下到的编排文件还指着旧版本，部署出来就是旧代码。
所以发版走脚本：

```bash
npm run release 1.0.1              # 正式版
npm run release 1.1.0-rc.1         # 预发布（GitHub 上会标 pre-release）
bash scripts/release.sh 1.0.1 --dry-run   # 只检查、打印将做什么，不改任何东西
```

脚本按顺序做六件事，任一步失败就停：

1. **前置检查** —— 版本号格式（semver，允许 `-rc.1`）、工作区干净、在 `main` 上、标签不存在、与远程同步，以及**当前四处版本号本身是否自洽**（不自洽就先修再来发）
2. **同步四处版本号** —— `package.json`(1 处) / `package-lock.json`(2 处) / `docker-compose.yaml`(4 处：context、image、两处注释)，改完再由 `check-version.js` 复核一致
3. **跑 `selftest`** —— 不过就中止
4. **提交并推送 `main`**
5. **打附注标签并推送**
6. **按 `release-notes-template.md` 生成正文**（本版变化从 `<上一标签>..HEAD` 的提交历史按 `feat:` / `fix:` / `ui:` / `docs:` / `refactor:` 前缀自动归类）+ `gh release create`

单独检查版本号一致性：

```bash
npm run check-version          # 只检查
npm run check-version 1.0.1    # 额外断言等于 1.0.1
```

改动前建议看一遍将做什么，`--dry-run` 不碰任何文件、不建标签、不推远程。

发布后确认 Release 页面上的 compose 链接可用：

```bash
curl -sI https://raw.githubusercontent.com/AidanAllen/workcheck/refs/tags/v1.0.1/docker-compose.yaml | head -1
```

## 目录结构

```
server/index.js        接入网关：鉴权、限流、幂等、API 路由
server/config.js       唯一配置文件（data/config.json）的读写：三组平台凭证
server/db.js           SQLite 建表与查询
server/data_dir.js     数据目录唯一出处（WORKCHECK_DATA_DIR）
server/util.js         服务端小工具（读取 Cookie）
server/feishu.js       飞书 OAuth 路由（授权、回调、回调地址自检）
server/feishu_token.js 飞书令牌读写与自动续期（凭证每次现读，页面改完即时生效）
server/scheduler.js    定时拉取调度器
server/checkin.js      签到解析与去重核心（接口与拉取共用）
server/checkin_pull.js 飞书群拉取 + 直写入库（进程内，不经 HTTP、不需要 API Key）
server/ttshitu.js      TT识图余额 + 今日识别次数推算（快照 data/ttshitu_usage.json，10 分钟后台采样）
server/capsolver.js    CapSolver 余额 + 今日消耗推算（快照 data/capsolver_usage.json，10 分钟后台采样）
scripts/selftest.js    解析规则单测入口
scripts/release.sh     发版：同步四处版本号 → 跑测试 → 打标签 → 建 Release
scripts/check-version.js 版本号一致性检查（发版脚本会在改前/改后各调一次）
scripts/release-notes-template.md Release 正文模板（占位符 <!--CHANGELOG--> 与 __VERSION__）
public/               前端看板（原生 HTML/CSS/JS，不依赖 CDN）
  ├─ style.css        布局与组件样式（不含主题，:root 为默认主题兜底）
  ├─ common.js        公共函数 + 主题注册表 THEMES / applyTheme / initThemeSwitcher
  ├─ themes/          主题文件（一主题一 css，只写变量）
  └─ bg/              壁纸（初樱 portrait/landscape，雨夜 rain-*.webp）
Dockerfile            多阶段构建（builder 装编译工具链，运行镜像只带运行时）
docker-compose.yaml   编排：直接以 GitHub 仓库为 build context
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

### 恢复出厂

要清空业务数据、重新走一遍初始化流程（**保留** `data/config.json` 里的三组平台凭证）：

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
刚清空的库立刻又被灌满（那是「补回停机缺口」的既定行为，不是没清干净）。
确认干净后再用 `npm start` 恢复定时。

> 因为幂等靠数据库唯一索引、而不是外部「已推清单」，所以清库之后的历史数据
> **一定会被重新拉回来**（这正是我们想要的：库是唯一真相）。只想保留近 N 天的话，
> 把 `server/checkin_pull.js` 的 `pull({ days: N })` 参数用起来，
> 或在「配置信息」里把群 ID 临时改成另一个群。

## 可调参数

环境变量只放**部署参数**。三家平台的凭证不属于这里 —— 它们在 `data/config.json`，
页面上改，改完立即生效。

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `3000` | 监听端口；被占用时自动顺延到 3001、3002… |
| `WORKCHECK_DATA_DIR` | 项目下 `data/` | 数据目录唯一出处（`server/data_dir.js`）。数据库、`config.json`、飞书令牌、用量快照全部跟着它走。容器里指向挂载卷 `/data` |
| `RATE_LIMIT` | `600` | 每来源每分钟请求上限 |
| `LOG_KEEP` | `20000` | `access_logs` 保留条数，超出后每 6 小时清理一次最老的 |
| `ADMIN_TOKEN` | 空 | 管理接口应急口令，见「访问控制」 |
| `PULL_ENABLED` | `1` | 设 `0` 关闭定时拉取（页面上的「立即拉取」仍可用） |
| `PULL_INTERVAL_MIN` | `120` | 定时拉取间隔分钟数 |
| `PULL_START_DELAY` | `8` | 启动后首次拉取的延迟秒数 |
| `PULL_RETRY_MIN` | `15` | 一轮失败后补跑的间隔分钟数 |
| `PULL_TIMEOUT_MS` | `300000` | 单次拉取超时（毫秒） |

单次批量上限在 `server/index.js` 的 `MAX_BATCH`。

## 访问控制

`/api/ingest`（收数据）靠来源自己的 `X-Api-Key`，这一条一直有。其余接口分三类：

### 管理类 —— 需要账号密码登录

**接入配置页**（`/setup.html`）现在要登录才能用。第一次打开时库里没有账号，页面显示的是**创建管理员**；建完之后再进来就是**登录**页。登录成功后才渲染管理内容，右上角显示当前账号和「退出登录」。

**改密码**：点右上角那个「已登录 &lt;账号&gt;」按钮就弹出改密码面板，要填当前密码 + 新密码两遍。保存成功后：

- 当前这台设备**不用重新登录**（会话保留）
- 其它设备的登录状态**全部失效**（防止会话被别人留着）

所以页面会把「踢掉了几个会话」告诉你。密码本身不落磁盘，改完就只有你自己知道。

接口的把关规则：

- `GET /api/sources`、`GET /api/sources/:id/key` —— 来源列表与明文 Key
- `POST /api/sources`、`POST /api/sources/:id/enabled`、`DELETE /api/sources/:id`
  （删除来源会**连带删掉该来源的全部历史报文**，不可恢复；
  内置来源「飞书签到（内置）」不允许删除）
- `GET/PUT/DELETE /api/credentials[/:group]` —— 三组平台凭证。读出的一律是掩码，
  **明文永远不下发**；保存时某字段传空串表示「不改」，避免把掩码原样提交回来覆盖真值
- `POST /api/demo/push`、`GET /api/scheduler`、`POST /api/scheduler/run`

账号密码存在 SQLite 的 `admins` 表里：

| 项 | 做法 |
| --- | --- |
| 密码存储 | `scrypt` 加盐哈希，库里不存明文，也不存可逆的东西 |
| 密码校验 | `timingSafeEqual` 定长比较，避免靠响应时间试探 |
| 会话 | 32 字节随机 token 存 `sessions` 表，`HttpOnly` + `SameSite=Lax` 的 Cookie，有效期 7 天，退出即失效 |
| 撞库 | 同一 IP + 账号 5 分钟内错 5 次就锁 5 分钟 |
| 账号枚举 | 账号不存在和密码错误返回同一句提示 |
| 改密码 | `POST /api/auth/password`，要验当前密码，改完只保留发起改动的那个会话 |

会话过期或被踢下线时，页面会自动退回登录屏，不会留一个「点了没反应」的死界面。

**忘了怎么办**：用 sqlite3 直接改库，或者走预留的应急通道 ——

```bash
# 关掉服务，用环境变量启动，此时请求头带上口令即可绕过登录
ADMIN_TOKEN=your-secret node server/index.js
curl -H "X-Admin-Token: your-secret" http://127.0.0.1:3000/api/sources
```

只想重建管理员时用这行（只删账号和会话，不碰来源与历史报文）：

```bash
node -e "const db=require('./server/db.js');db.db.prepare('DELETE FROM sessions').run();db.db.prepare('DELETE FROM admins').run()"
```

删完重启服务，重开 `setup.html` 就是创建页了。

### 看板类 —— 仍对外开放

`/`、`/api/checkin/daily`、`/api/logs`、`/api/events`、`/api/stream/logs` 不需要登录，手机在同一局域网能正常看。出于隐私考虑，**访问日志里的来源 IP 不会下发**给任何前端和 SSE，只在数据库留存。

> 提醒：如果外面套了 Nginx 反代，Node 这层看到的来源 IP 是 Nginx 的。**`ADMIN_TOKEN` 是唯一贯穿所有管理接口的静态凭证**，一旦设置就相当于永久后门，用完记得取消。

## 部署

### 方式一：Docker（推荐）

编排文件里已经可以直接用 GitHub 仓库地址当构建上下文，**不需要先把仓库 clone 下来**：

```bash
# 1. 下载编排文件（也可以直接 clone 整个仓库）
curl -O https://raw.githubusercontent.com/AidanAllen/workcheck/main/docker-compose.yaml

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

> `docker-compose.yaml` 里的 `build.context` 已经指向本仓库。如果你 fork 了，
> 记得把那一行改成自己的地址（分支用 `#` 指定）。

要点：

- **凭证全部在页面上配**，`docker-compose.yaml` 里不写任何密钥；
  容器环境变量只放部署参数（端口、数据目录、拉取周期）
- **数据卷是唯一要持久化的东西**：SQLite 库、`config.json`、飞书令牌、用量快照都在 `/data`。
  容器重建、镜像升级都不丢数据；迁移机器时把卷拷走即可
- 镜像用 `node:22-slim`（不是 alpine）：`better-sqlite3` 不为 musl 提供预编译包，
  alpine 上每次都要从源码编译。构建阶段装 `python3/make/g++`，运行阶段只带编好的 `.node`
- 容器里以 `node` 用户（非 root）运行，`config.json` 落盘时权限是 `600`
- 镜像里**不含** `data/`（`.dockerignore` 已排除）：那里有明文凭证，打进镜像就等于凭证跟着镜像走
- 端口默认映射到 `0.0.0.0`。这是管理后台，**只给本机或内网访问就改成 `127.0.0.1:3000:3000`**

### 方式二：直接跑（PM2 / systemd）

代码本身跨平台（路径用 `path.join`）。用 PM2 或 systemd 常驻即可：

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
只有看板本身（`/`、`/api/checkin/daily`、`/api/logs`、`/api/events`、`/api/stream/logs`）开放。
放进公网前建议：

1. 改掉默认映射，或只在内网/组网（WireGuard、Tailscale）里访问
2. 前面挂 Nginx 并配 HTTPS —— 否则管理员密码是明文过网的
3. 如果挂了反代，记得让 Node 能看到真实来源 IP（否则登录限流会把所有人当成同一个 IP）
