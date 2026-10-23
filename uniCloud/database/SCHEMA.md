# uniCloud 数据库结构（uniCloud/database/）

共 **8 个集合**：原六集合 `users`、`games`、`signups`、`checkins`、`pigeon_records`、`appeals`
（字段与已弃用的 `database/SCHEMA.md` 完全一致，此处不重复字段表，需要查字段时以那份为准），
外加 uniCloud 方案新增的两个：

## 7. sessions —— 会话（自建鉴权专用）

URL 化接口是公开 HTTP，没有微信云函数的上下文 OPENID，因此登录态自建：
小程序 `wx.login` 的 code 经 api 云函数转发微信 code2session 换到 openid 后，
云函数签发不透明随机 token 存入本集合，后续请求靠 token 反查 openid。

| 字段 | 类型 | 说明 |
|---|---|---|
| token | string | 32 字节随机数的 hex（64 字符），与 openid 无可推导关系 |
| openid | string | token 对应的用户 openid |
| createdAt | number | 签发时间（毫秒） |
| expiresAt | number | 过期时间（毫秒），默认签发 +30 天；校验时过期即删除该条 |

索引建议：`{ token: 1 }` **唯一索引**（每次鉴权都按 token 查，必须快且不重复）；
`{ expiresAt: 1 }`（方便定期清理过期会话）。
权限：只允许云函数读写（见下方权限口径），客户端永远不该直接碰这张表——
拿到别人的 token 等于冒充登录。

## 8. notifications —— 通知

迁移前微信云版没有通知集合（mock 里是本地种子）。uniCloud 版把通知落库，
由云函数写入、小程序经 api 的 `listNotifications` 读取（订阅消息模板 ID
到位后，发送通道再另接，落库口径不变）。

| 字段 | 类型 | 说明 |
|---|---|---|
| userId | string | 接收人 openid |
| type | string | settlement_pigeon（结算被记鸽，settle 写）/ redeem_success（抵消成功，settle 写）/ game_change / checkin_open / formed_milestone / appeal_decision（后四类预留，发送侧后续补） |
| gameId | string | 关联球局 |
| pigeonRecordId | string\|null | 关联鸽记录（结算类通知用，落地页据此跳申诉） |
| title / content | string | 标题与正文 |
| read | boolean | 是否已读 |
| createdAt | number | 毫秒时间戳 |

索引建议：`{ userId: 1, createdAt: -1 }`（通知列表按人倒序拉）。

## 原六集合的索引与口径（与弃用版一致，此处备忘）

- `games`：`{ status: 1, startTime: 1 }`
- `signups` / `checkins` / `pigeon_records`：`{ gameId: 1, userId: 1 }` **唯一索引**
  （分别对应：一人一场一条报名、一条签到、一条鸽记录——settle 幂等的数据库级保证）
- `appeals`：`{ gameId: 1, status: 1 }`、`{ userId: 1, status: 1 }`
- `pigeon_records` 另有 `{ userId: 1, status: 1 }` 查个人有效鸽
- `users` 主键即 openid（`_id = openid`），无额外索引

## 权限口径（与弃用版一致的实现路径）

原则不变：**客户端不直连数据库，一切读写只走云函数**。

- 每个集合都配了 `<集合>.schema.json`，其中 `permission` 四项
  （read/create/update/delete）全部为 `false`：任何通过 clientDB /
  前端 SDK 的直连读写都会被拒。
- 云函数内 `uniCloud.database()` 是服务端身份，不受 schema permission
  约束（与微信云函数用服务端 SDK 同理），业务读写全经 api 云函数，
  身份与权限校验在 handler/service 层完成。
- 因此即使有人拿到空间 ID 与 URL 化域名，没有合法会话 token 也调不动
  任何业务 action（鉴权细节见 `uniCloud/cloudfunctions/api/auth.js`）。

## 种子数据（*.init_data.json）

`users / games / signups / checkins` 四个集合各有一份 `init_data.json`
（JSON 数组格式，由弃用版 `database/seed/` 的 JSON Lines 种子转换而来，
内容一一对应：今晚 19:30 的 5 人制局 g1、今晚 21:45 的 8 人制局 g2、
用户 u1–u14）。在 uniCloud 控制台/HBuilderX 里对集合执行「导入初始化
数据」即可，仅供联调演示；演示用户的 `_id` 是 `u1`–`u14` 占位、不是
真实 openid，不要带进正式数据。

`pigeon_records`、`appeals`、`sessions`、`notifications` 不给种子：
前两者只能由运行中的结算与申诉产生，后两者只能由登录与结算产生，
建空集合即可。
