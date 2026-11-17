# binance-trade-sync

将普通币安 USDⓈ-M（U 本位）合约账户的成交明细和资金流水同步到私有 OSS。使用阿里云 FC 3.0 内置 Node.js 20，支持 GitHub Actions 在 main 更新时自动部署，也支持手工上传代码包。

此仓库独立于 `vite-shadcnui-blog`。不会读取、覆盖原站点的交易日志，也不会自动生成计划、复盘或下单。

## 支持范围与数据口径

- 单账户、普通 U 本位合约。默认拉取 `BTCUSDT`，可配置多个交易对。现货、币本位、统一/组合保证金账户不属于此版本范围。
- `GET /fapi/v1/userTrades`：按配置的交易对拉取实际成交，包括价格、数量、方向、持仓方向、手续费、手续费币种、已实现盈亏等原始字段。
- `GET /fapi/v1/income`：拉取账户全部资金流水和全部类型，包括资金费用、手续费、盈亏、转账等；不限于 `BINANCE_SYMBOLS`。不把转账当交易利润。
- 成交和资金流水分别存储。两者中的手续费和已实现盈亏存在对应关系，后续统计不能直接把两份金额相加。
- 保留十进制金额字符串；ID 统一保存为完整字符串，避免 JavaScript 大整数精度损失。不按买卖方向直接推断开平仓，不自动计算保证金收益率、胜率或 R。
- 首次默认最近 30 天；后续从每条数据流的游标回看 24 小时，补充延迟数据。结束时间固定为币安服务器时间前 60 秒，正在产生的成交在后续同步获取。
- 按不超过 7 天的区间查询。返回 1000 条时继续二分时间范围；同一毫秒也达到上限时返回 `DENSE_TIMESTAMP`，不会假装完整。普通接口当前文档限制近 3 个月，本实现保守限制近 80 天；更旧历史须单独导出，尚未实现 CSV 导入。

## 1. 创建 FC

| 配置 | 值 |
| --- | --- |
| 地域 | 韩国（首尔）`ap-northeast-2`，须实际验证币安账户接口访问条件 |
| 函数类型 | 事件函数，使用内置运行时 |
| 运行时 | Node.js 20 |
| 执行入口 | `index.handler` |
| 内存 / CPU | 初始建议 512 MB / 0.5 vCPU，或控制台对应档位 |
| 超时 | **300 秒**，代码默认在 240 秒预算内停止发起新工作，预留报告和解锁时间 |
| 单实例并发 / 最大实例数 | 1 / 1；OSS 锁仍然用于防止跨实例、版本或别名的并发写入 |
| 最小实例数 / 预留实例 | 0 |
| 公网访问 | 开启；先不配置 VPC。使用固定出口时按实际 VPC/NAT 网络配置调整 |
| 文件系统挂载 | 不需要，使用 OSS SDK |
| 日志 | 开启，建议保留 7～14 天 |
| 触发器 | 首次测试不需要 HTTP 或定时触发器 |

币安 Key 只授予读取所需权限，不授予下单、划转或提现权限。如果设置了 IP 白名单，需要先配置并核实 FC 的固定出网 IP。部署地域不改变账户适用条件，公共行情可达也不代表账户查询可用。

## 2. OSS 和授权

使用北京的**私有、标准存储、从未启用版本控制**的 Bucket。境外 FC 使用公网端点，不能填 `-internal` 端点，也不通过公开网站/CDN提供这些文件。

这里的版本控制限制与同步锁有关：OSS 在版本控制为 Enabled 或 Suspended 时会忽略 `x-oss-forbid-overwrite`。代码会在每次获取锁前查询 Bucket 状态并拒绝这两种情况。**如果现有 Bucket 启用了版本控制，请另选独立 Bucket，不要为了部署此函数修改现有 Bucket 的保护设置。** 不要在同步期间更改 Bucket 的版本控制、保留策略或生命周期规则。

OSS 支持两种凭据来源：配置 FC 环境变量 `ACCESS_KEY_ID` 和 `ACCESS_KEY_SECRET` 时优先使用这对 RAM 用户凭据；两项均未配置时，使用绑定到函数的 RAM 角色临时凭证。只配置其中一项会报错，不会静默切换凭据。

使用 [examples/ram-policy.json](examples/ram-policy.json) 中的策略授权给相应 RAM 用户或角色，将两处 `YOUR_BUCKET` 替换为实际 Bucket；若调整 `OSS_PREFIX`，同步调整对象资源路径。使用角色方式时，可信主体选择云服务“函数计算”，并将角色绑定到本函数。

| 权限 | 范围 / 用途 |
| --- | --- |
| `oss:GetObject`、`oss:PutObject` | 仅同步目录；读取和写入数据、进度及报告 |
| `oss:DeleteObject` | 仅同步目录；释放锁 |
| `oss:PutObjectAcl` | 仅同步目录；上传时显式设置对象为 private |
| `oss:GetBucketVersioning` | 指定 Bucket；检查锁的前提条件 |

不需要 `AliyunOSSFullAccess` 或 Bucket 列举权限。显式 AccessKey 不会混入函数角色的 STS Token；只有两项都留空时，SDK 才从本次调用的 `context.credentials` 读取临时凭证。两种凭据都没有时返回 `FC_ROLE_REQUIRED`。AccessKey 提供身份，相应 RAM 用户仍须获得上述 OSS 授权。示例按同一阿里云账号配置；跨账号授权需额外处理，不在此处自动设置。

## 3. 环境变量

在 FC 控制台配置。仓库的 `.env.example` 仅为清单，函数不会读取本地 `.env` 文件。

### 必填（共 5 项）

| 名称 | 示例 | 说明 |
| --- | --- | --- |
| `BINANCE_API_KEY` | 你的专用只读 Key | HMAC 系统生成型 API Key；不支持 RSA/Ed25519 Key |
| `BINANCE_API_SECRET` | 对应 Secret | 不写入仓库、请求或日志 |
| `OSS_BUCKET` | 你的私有 Bucket 名称 | 北京目标 Bucket |
| `OSS_REGION` | `oss-cn-beijing` | `ali-oss` SDK 格式；**不是首尔地域** |
| `OSS_ENDPOINT` | `https://oss-cn-beijing.aliyuncs.com` | 北京公网地域端点；不要手工拼入 Bucket 名。若使用已绑定到 Bucket 的自定义域名则配合 `OSS_CNAME=true` |

### 使用 AccessKey 访问 OSS 时追加 2 项

| 名称 | 填写内容 | 说明 |
| --- | --- | --- |
| `ACCESS_KEY_ID` | 获得 OSS 授权的 RAM 用户 AccessKey ID | 与下一项成对配置，优先于 FC 角色 |
| `ACCESS_KEY_SECRET` | 对应 AccessKey Secret | 在 FC 环境变量中配置，不写入代码或请求 |

这两项用于函数运行时访问 OSS，与 GitHub Repository secrets 中用于部署的 `ALIYUN_FC_ACCESS_KEY_ID`、`ALIYUN_FC_ACCESS_KEY_SECRET` 分开配置。不要将真实密钥提交到仓库；工作流会保留控制台已有的环境变量。继续使用函数角色时，将 `ACCESS_KEY_ID` 和 `ACCESS_KEY_SECRET` 同时删除或同时留空。

### 可选（不填即使用默认值）

| 名称 | 默认值 | 说明 |
| --- | --- | --- |
| `BINANCE_BASE_URL` | `https://fapi.binance.com` | 实盘；仅另外允许 `https://demo-fapi.binance.com`，使用测试环境专用 Key 和独立 OSS_PREFIX |
| `BINANCE_SYMBOLS` | `BTCUSDT` | 逗号分隔，例如 `BTCUSDT,ETHUSDT`，最多 20 个；仅影响成交明细 |
| `OSS_PREFIX` | `fc/binance-sync/owner` | 无开头或结尾斜线；与 RAM 策略一致。一个前缀只对应一个账户/Key/环境 |
| `OSS_CNAME` | `false` | 使用 Bucket 绑定的自定义公网域名时填 `true`，不能填写 CDN 域名 |
| `SYNC_INITIAL_DAYS` | `30` | 未建立游标的数据流初次回溯天数，1～80；不改变已有游标 |
| `SYNC_OVERLAP_SECONDS` | `86400` | 每次增量同步重查的时间，60～604800 秒 |
| `REQUEST_TIMEOUT_MS` | `15000` | 单次网络请求超时，1000～30000 毫秒 |
| `SYNC_MAX_SECONDS` | `240` | 本次执行预算，30～240 秒；FC 超时仍应设 300 秒 |
| `BINANCE_RECV_WINDOW` | `5000` | 币安签名接收窗口，1000～60000 毫秒；会先校准时间，遇 -1021 只校时重试一次 |
| `BINANCE_REQUEST_GAP_MS` | `250` | 请求间隔，100～5000 毫秒；遇 429/418 立即停止，遵守返回的等待时间后手工重试 |
| `SYNC_JWT_JWKS` | 必填（HTTP） | RS256 公钥 JWKS 的 JSON 字符串；缺失或无效时 HTTP 返回 503，控制台事件不受影响 |
| `SYNC_JWT_ISSUER` | `https://www.yanxiao.me` | 必须与北京签发端一致 |
| `SYNC_JWT_AUDIENCE` | `binance-trade-sync` | 必须与北京签发端一致 |

如 OSS 账号要求使用自定义域名访问大陆 Bucket，填写已绑定该 Bucket 的 HTTPS 公网域名并设 `OSS_CNAME=true`。不要直接复用仅供原北京函数访问的内网地址。

## 4. GitHub Actions 自动部署

工作流：[.github/workflows/deploy-fc.yml](.github/workflows/deploy-fc.yml)。每次推送到 `main` 都会执行，也可在 Actions 的 `Deploy FC` 页面选择 `main` 手工运行。

Repository secrets 只需要：

| Secret | 用途 |
| --- | --- |
| `ALIYUN_FC_ACCESS_KEY_ID` | 部署使用的 RAM 用户 AccessKey ID |
| `ALIYUN_FC_ACCESS_KEY_SECRET` | 对应 AccessKey Secret |

部署账号需要 `fc:GetFunction` 和 `fc:UpdateFunction` 权限。FC API 文档将这两项列为 All Resource；按账号的实际授权策略配置，缺少读取权限也无法完成验证。部署流程不使用 OSS 上传中转，因此不需要为部署账号增加 OSS 权限或配置代码包 Bucket。

`s.yaml` 中记录目标：首尔 `ap-northeast-2`、函数 `binance-trade-sync`、`nodejs20`、入口 `index.handler`、超时 `300` 秒、代码包 `./dist/binance-trade-sync.zip`。它是 CI 的目标参数来源；CI 使用官方 FC 3.0 Python SDK 更新已有函数，不执行 Serverless Devs 全量资源部署。

执行步骤：

1. 在 Node.js 20 下安装锁定的生产依赖，执行语法检查、函数测试和依赖审计。
2. 测试部署脚本的配置保留逻辑，打包源码与生产依赖。
3. 检查当前提交仍为 main 最新提交；已有新提交时跳过旧版本的部署。
4. 在 Secret 仅注入到部署步骤的条件下，通过 FC API 直接上传 ZIP，更新代码和 300 秒超时。
5. 回读函数，状态字段存在时等待 Active/Successful；部分普通 CPU 函数省略这些状态字段，此时仍须通过代码 CRC-64、入口、运行时和超时验证，并检查环境变量、角色、CPU、内存、磁盘、网络等原有配置保持一致。校验未通过则工作流失败。

部署到 `LATEST`，与你导出的 HTTP 触发器 qualifier 一致。现有触发器及其签名认证、角色 `aliyunfcdefaultrole`、0.35 vCPU、512 MB 内存、10240 MB 磁盘、网络及资源组均由 FC 控制台管理，工作流不提交这些字段。原有 `timeout=60` 会调整为 `300`，适配同步代码的执行预算。

工作流使用固定 concurrency group 串行部署，不取消正在执行的更新。每次运行成功后，在 Actions Summary 查看源代码提交、ZIP SHA-256 和 FC 代码 CRC-64。不会输出 FC 环境变量、Secret、完整 API 响应或 SDK 错误堆栈。

币安密钥、OSS 参数和用于 OSS 的 `ACCESS_KEY_ID`、`ACCESS_KEY_SECRET` 仍按上节配置在 **FC 环境变量** 中，不是上述两个 GitHub Secrets。部署成功只说明代码和配置验证通过；不会在流水线中调用同步业务、访问币安或修改交易记录，首次业务验证按下一节在控制台执行。

### 本地打包和手工部署

如已使用 GitHub Actions 自动部署，无需再次手工上传。以下保留本地打包方法。

本地需要 Node.js 20+ 和 Python 3：

```bash
git clone https://github.com/jacofun/binance-trade-sync.git
cd binance-trade-sync
npm ci --omit=dev --ignore-scripts
npm test
python3 scripts/package.py
```

Windows 可将最后一行改为 `py scripts/package.py` 或 `python scripts/package.py`。`npm run package` 使用的是 `python3` 命令。

生成 `dist/binance-trade-sync.zip` 后，在 FC 的“代码”页面选择上传 ZIP 包并部署。包根目录直接是 `index.js`、`package.json`、`src/`、`node_modules/`，不能多套一层仓库目录。打包脚本仅打包本地文件，不调用部署接口，不包含 `.env`、测试或 GitHub 配置。请使用这个依赖完整的包，GitHub“Download ZIP”的源代码包不能直接替代它。

## 5. 第一次测试

FC 控制台“配置测试参数”选择自定义 JSON，填写：

```json
{ "action": "sync" }
```

运行后检查返回的 `status` 为 `completed`、`newRecords` 和 `completedWindows`，并在 OSS 查看数据和 `state.json`。没有成交/资金流水的月份不会创建空分区；即使结果为零，也会保存进度与运行报告。控制台调用会真实写入数据。

再执行相同事件，重复记录不会新增。增量会重查最近 24 小时，因此 `fetchedRecords` 不是新增条数，`newRecords` 才是本次实际新增条数；这些都不是交易胜率或“完成的一笔交易”数量。

指定时间补查时使用：

```json
{
  "action": "sync",
  "startTime": "2026-11-01T00:00:00+08:00",
  "endTime": "2026-11-02T00:00:00+08:00"
}
```

请把日期改为实际时间，必须在近 80 天内，结束时间早于服务器当前时间至少 60 秒。支持毫秒时间戳或带时区的 ISO 时间，区间含起止毫秒。显式补查只合并分区，不推进日常同步游标，避免跳过中间缺口；补查期间中断则重发原请求。

## 6. 登录后前端直连首尔

调用链为：前端携带网站 Cookie 与 CSRF → 北京 `POST /api/private-auth/trading/binance/token` → 获得 120 秒 JWT → 前端 `POST /trade/api` → CDN 转发首尔。只有现有登录系统中的 `owner` 可以领取凭证，北京不转发同步请求。前端请求体固定为 `{"action":"sync"}`；原始成交和资金流水仍独立保存，不自动生成网站日志或统计。

### 生成密钥和配置两端

在自己的电脑、此仓库目录执行一次（Node.js 20+）：

```sh
node scripts/generate-sync-keys.mjs
```

脚本生成 `.local-sync-keys/`，不打印密钥，目录已忽略并禁止覆盖已有目录。`beijing.env.json` 含私钥，只用于北京 FC；`seoul.env.json` 含公钥验证配置，用于首尔 FC；`public-jwks.json` 用于首尔 HTTP 触发器。文件中的 JSON 对象是**增量环境变量**，请逐项新增到现有 FC 环境变量，保留原登录和币安/OSS 配置。不要用它们覆盖函数的全部环境变量。工作流只部署代码，不写入这些密钥。

北京需要配置：

| 环境变量 | 值 |
| --- | --- |
| `BINANCE_SYNC_PRIVATE_KEY` | 生成文件中的 PKCS#8 PEM 私钥，可使用真实换行或字面量 `\n` |
| `BINANCE_SYNC_KEY_ID` | `trade-sync-v1`，与 JWKS 的 `kid` 一致 |
| `BINANCE_SYNC_ISSUER` | `https://www.yanxiao.me` |
| `BINANCE_SYNC_AUDIENCE` | `binance-trade-sync` |
| `BINANCE_SYNC_URL` | `https://yanxiao.me/trade/api`，首尔的 HTTPS 反向代理地址，与北京 API 域名独立 |

首尔新增：`SYNC_JWT_JWKS`（JSON **字符串**）、`SYNC_JWT_ISSUER`、`SYNC_JWT_AUDIENCE`，值见 `seoul.env.json`。原 `BINANCE_*`、`OSS_*`、`ACCESS_KEY_ID`、`ACCESS_KEY_SECRET` 保持原配置，删除旧 `SYNC_HTTP_TOKEN`，HTTP 不再接受 `X-Sync-Token`。

已有北京 FC 的环境变量优先于代码默认值。如果此前设置了带 www 的 `BINANCE_SYNC_URL`，请手工改为 `https://yanxiao.me/trade/api`。不用重新生成密钥；`BINANCE_SYNC_ISSUER` 和首尔 `SYNC_JWT_ISSUER` 保持一致，JWT 签发者标识不要求与同步端点域名相同。

### 首尔 HTTP 触发器

- 方法仅 `POST`，鉴权方式改为 **JWT 认证**，替换原 `function` 签名认证；固定 Bearer 认证与此短期 JWT 方案不兼容。
- JWKS 使用生成的 `public-jwks.json` 完整对象，仅含公钥，禁止放入私钥。
- Token 位置 `Header`，参数名 `Authorization`，去除前缀为 `Bearer `（包含末尾空格），匹配模式为“全部匹配”。
- 保留原 `Authorization` 请求头，不需要将 Claim 映射为用户身份 Header。函数内部再次验证 RS256、`kid`、签发者、受众、`trading:sync` 用途、签发/过期时间和不超过 120 秒的有效期，不信任外部身份 Header。
- 使用 FC 3.0 内置 Node.js 20 HTTP 事件映射；不启动 HTTP Server，不设置监听端口。本仓库工作流不会修改触发器。

### CDN

`https://yanxiao.me/trade/api` 回源首尔 HTTP URL，透传 `POST` 方法、JSON 请求体和 `Authorization` Header，回源使用 HTTPS。该路径禁用缓存，响应头保留 `Cache-Control: no-store`，回源超时须覆盖同步运行时间（FC 300 秒）。浏览器设置 310 秒等待，但 CDN 套餐的实际超时上限仍需在控制台核实；如果 CDN 上限更短，长同步会中断响应，应缩短单次同步范围或另行设计异步查询。

页面从 `https://yanxiao.me` 打开时，同步请求为同源，无需首尔 CORS。获取 JWT 的北京接口仍位于 `https://www.yanxiao.me/api/private-auth/`，两个服务的域名无需一致。是否跨域以浏览器页面的 Origin 为准；若页面从 `https://www.yanxiao.me` 打开，请在 CDN/网关处理不携带 JWT 的 OPTIONS 预检，并为实际响应配置允许 www 来源的 CORS（POST 仍验证 JWT），或将网站入口统一到 `https://yanxiao.me`。不要把网站 Cookie 的 Path 扩大到 `/trade/api`。前端主动设置 `credentials: omit`，只发送当前 JWT，不把网站 Cookie、CSRF、阿里云 AK 或币安密钥发送到首尔。

### 验证和边界

1. 未登录、CSRF 错误、非 owner、已注销或已撤销会话不能在北京领取凭证。
2. 首尔拒绝缺失/篡改/过期/用途错误的 JWT；未配置有效公钥时不会开始同步。控制台 `{ "action": "sync" }` 和受 RAM 授权的 InvokeFunction 事件仍可用。
3. 登录后点击“同步币安记录”，只有 HTTP 200 且 `status=completed` 才视为完成，页面显示本次新增条数。
4. 令牌只存当前请求内存，不写浏览器存储或日志。它在有效期内可重复使用；注销网站会阻止签发新令牌，已签发令牌最多继续有效 120 秒，已开始的同步继续执行。并发同步仍由 OSS 锁控制。
5. 网络中断或超时后不自动重试；先检查首尔 FC 日志与 OSS `runs/` 报告。代码不在响应返回后继续后台执行。
6. 轮换时先把新旧公钥一起加入首尔环境变量和触发器 JWKS，再更新北京私钥与 `kid`，等待旧令牌全部过期后移除旧公钥。支持最多 5 把不同 `kid` 的 RS256 公钥。


## OSS 文件结构

| 路径（相对 OSS_PREFIX） | 内容 |
| --- | --- |
| `usdm/trades/BTCUSDT/2026-11.json` | 按交易对、UTC 月分区的成交原始记录 |
| `usdm/income/2026-11.json` | 按 UTC 月分区的全账户资金流水 |
| `state.json` | 每个交易对的成交游标、全账户资金流水游标 |
| `runs/<requestId>.json` | 本次时间区间、条数、请求数、完成或失败状态 |
| `sync.lock.json` | 正在执行的同步锁；正常结束后删除 |

分区文档包含 `schemaVersion: 1`、`product: "usdm"`、`kind`、`symbol`、`month`、`updatedAt`、`binding` 和 `records`。`binding` 是 API Key 和环境的单向摘要，不包含 Key/Secret 本身。时间戳保留毫秒，文件按 UTC 月归档，前端展示时再转为北京时间。

同一成交按 `symbol + id` 去重；资金流水按 `incomeType + tranId` 去重。单次对象替换是原子的，多个分区与进度文件不是同一事务：先写明细，全部成功后再推进该段游标；失败后重查并去重。若响应丢失，重试后的 `newRecords` 会以已落盘内容为准。

## 重试和维护

- 普通失败可重新发送 `{"action":"sync"}`，已经完成的分段无需从头补录。若单次数据过多，可多次执行直到完成。
- `BINANCE_RATE_LIMIT`：等待错误中的 `retryAfterSeconds` 后再试；不绕过封禁或不断重试。
- `BINANCE_ACCESS_DENIED`：检查账户适用条件、出口和 IP 白名单。函数不会切换域名或代理绕过限制。
- `HISTORY_GAP`：游标落后超过 80 天，不会静默把游标跳到最近区间。需先处理历史缺口；当前不支持自动下载历史导出文件。
- `STATE_MISMATCH`：换账户、实盘/测试环境或 API Key 后不能共用旧目录。最简单的密钥轮换方式是使用新的 `OSS_PREFIX` 并重新同步，旧数据保留；同账户历史合并需明确迁移，不要只删除状态文件绕过校验。
- 仅增加 `BINANCE_SYMBOLS` 时，新交易对按初始天数建立独立游标；移除交易对不会删除历史分区。首次区间不覆盖更早的开仓，数据同步并不保证能够还原每笔完整持仓。
- `SYNC_BUSY`：先确认当前调用是否还在运行。锁没有自动过期接管；FC 被强制终止或删除锁失败时会保留锁。**确认所有版本/别名的调用和待重试任务均已结束后**，手工删除且仅删除 `OSS_PREFIX/sync.lock.json`，再重试；不要在任务仍执行时清锁，不要给锁配置自动生命周期删除。
- 日志只输出请求编号、计数和脱敏错误码，不输出密钥、签名 URL、原始响应或 SDK 错误堆栈。`runs/` 中也不包含密钥或完整成交，但仍应保持私有。
- 只有当前运行拿到锁之后的结果会写入 `runs/`；配置、鉴权、角色或锁获取失败时看 FC 错误日志。

## 开发验证

```bash
npm ci --ignore-scripts
npm test
npm run check
npm audit --omit=dev
```

部署脚本测试另需安装 `python -m pip install -r scripts/requirements-deploy.txt`，再执行：

```bash
python -m unittest discover -s test -p 'test_deploy_fc.py' -v
```

测试使用模拟币安响应和 OSS 适配器，覆盖大整数、HMAC、分页截断、限流、时钟偏差、重复执行、分段恢复、资金流水唯一性、补查游标、并发锁、Bucket 版本控制、HTTP 鉴权和错误脱敏。上线前仍需在实际 FC 中核实角色临时凭证、首尔出口、币安读取权限和北京 OSS 写入；本仓库不包含真实账户凭据。

## 官方参考

- [币安 U 本位成交接口](https://developers.binance.com/docs/derivatives/usds-margined-futures/trade/rest-api/Account-Trade-List)
- [币安资金流水接口](https://developers.binance.com/docs/derivatives/usds-margined-futures/account/rest-api/Get-Income-History)
- [FC Node.js 请求处理程序](https://help.aliyun.com/zh/functioncompute/request-handlers)
- [FC HTTP 请求与响应格式](https://help.aliyun.com/zh/functioncompute/http-trigger-invoking-function)
- [FC 函数角色](https://help.aliyun.com/zh/functioncompute/grant-function-compute-permissions-to-access-other-alibaba-cloud-services)
- [FC 3.0 UpdateFunction](https://help.aliyun.com/en/functioncompute/api-fc-2023-03-30-updatefunction)
- [FC 3.0 代码包参数和 CRC-64](https://help.aliyun.com/en/functioncompute/api-fc-2023-03-30-struct-inputcodelocation)
- [OSS PutObject 与禁止覆盖限制](https://help.aliyun.com/zh/oss/developer-reference/putobject)


浏览器跨域访问须额外处理 CORS；仅更改同步 URL 不会自动更改 FC 触发器/CDN 配置。FC 3.0 的网关 CORS（邀测功能）可处理 OPTIONS 并允许 `https://www.yanxiao.me` 来源、`POST` 方法以及 `Authorization`、`Content-Type` 请求头；`corsConfig.allowMethods` 不包含 OPTIONS。未启用该功能时，应由 CDN/网关返回预检响应，并保留 POST 的 JWT 认证，不能让带 JWT 全部匹配的触发器直接拦截浏览器的无凭证预检。参考 [FC HTTP 触发器 CORS 文档](https://www.alibabacloud.com/help/en/functioncompute/http-triggers-overview)。
