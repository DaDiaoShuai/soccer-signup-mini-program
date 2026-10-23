# 云数据库结构设计（database/）

六个集合：`users`、`games`、`signups`、`checkins`、`pigeon_records`、`appeals`。
字段命名与 `miniprogram/utils/store.js`（mock）及云函数 service 层完全一致；
所有时间字段存**毫秒时间戳**（number，与 rules.js 的 `toMs` 口径一致）；
下文的 `id` 在云数据库中即文档 `_id`。

## 1. users —— 用户与信誉（文档 _id = openid）

| 字段 | 类型 | 说明 |
|---|---|---|
| `_id` / openid | string | 微信 openid，同时作为文档主键 |
| nickname | string | 昵称（微信授权后回填，初始可空） |
| avatarUrl | string | 头像地址 |
| credit | object | 信誉账本，结构与 `rules.emptyCredit()` 一致（见下） |
| credit.historyPigeons | number | 历史鸽总次数 |
| credit.redeemedPigeons | number | 已被连续守约抵消的次数 |
| credit.revokedPigeons | number | 已被发起人撤销的次数 |
| credit.streakProgress | number | 连续守约进度 0–4（满 5 触发抵消后清零） |
| credit.totalAttendance | number | 总出席（含空降到场） |
| credit.totalConfirmedSignups | number | 累计已结算的确定报名次数（守约率分母） |
| createdAt / updatedAt | number | 毫秒时间戳 |

有效鸽不落库，由 `rules.effectivePigeons(credit)` 现算：历史鸽 − 已抵消 − 已撤销。

索引：主键即 openid，无需额外索引。

## 2. games —— 球局

| 字段 | 类型 | 说明 |
|---|---|---|
| organizerId | string | 发起人 openid（每场唯一，合并规则保证） |
| location | object | `{ name, poiId, latitude, longitude }`，签到围栏中心 |
| startTime | number | 开球时间（毫秒） |
| teamSize | number | 赛制：每队人数（5/8/11/自定义） |
| note | string | 备注（球衣、费用等自由文本） |
| status | string | recruiting / formed / playing / ended / settled / cancelled（成局与否由统计现算，settled 与 cancelled 为终态） |
| settled | boolean | 结算完成标记（settle 幂等保险 1） |
| settledAt | number\|null | 结算落账时间 |
| fenceRadiusMeters | number | 签到围栏半径，默认 500 |
| createdAt / updatedAt | number | |
| cancelledAt / endedAt | number\|null | 取消整场 / 提前结束的时间（可选留痕） |

索引建议：`{ status: 1, startTime: 1 }`（首页列表与 settle 扫描都按状态 + 开球时间查）。

## 3. signups —— 报名记录

| 字段 | 类型 | 说明 |
|---|---|---|
| gameId | string | 球局 id |
| userId | string | 报名人 openid |
| type | string | confirmed（确定，计成局、担鸽责）/ watching（观望，不计、不担责） |
| status | string | confirmed / watching / cancelled（与 type 同步维护） |
| signedAt | number | 报名时间 |
| cancelledAt | number\|null | 取消时间；结算前取消免鸽 |
| outcome | string\|null | 结算结论：attended / pigeon / exempt，结算前为 null（settle 幂等保险 3） |
| settledAt | number\|null | 该记录被结算落账的时间 |

索引建议：`{ gameId: 1, userId: 1 }` **唯一索引**（一人一场一条记录；取消后重新报名由 api 复活同一条记录），另建 `{ userId: 1, status: 1 }` 查「我的报名」。

## 4. checkins —— 签到记录

| 字段 | 类型 | 说明 |
|---|---|---|
| gameId / userId | string | |
| checkinAt | number | 签到时间 |
| method | string | location（定位签到）/ proxy（发起人代签） |
| verifiedDistance | number\|null | 服务端复算的距球场距离（米），定位签到的校验结果；代签为 null |
| location | object\|null | 签到时上报的经纬度；代签为 null |
| proxyBy / proxyAt / proxyReason | string\|number\|null | 代签留痕：发起人、时间、原因；定位签到为 null |
| settledAt | number\|null | 空降者（无报名直接签到）的结算落账标记（settle 幂等保险 3） |

索引建议：`{ gameId: 1, userId: 1 }` **唯一索引**（同场只允许一条有效签到，与 mock 的 already 语义一致）。

## 5. pigeon_records —— 鸽记录（只能由 settle 结算产生）

| 字段 | 类型 | 说明 |
|---|---|---|
| gameId / userId | string | 哪一场、谁 |
| createdAt | number | 结算产生时间 |
| status | string | active（有效）/ redeemed（已被守约抵消）/ revoked（已被发起人撤销） |
| redeemedAt | number\|null | 被抵消的时间 |
| revokedBy / revokedAt / revokeReason | string\|number\|null | 撤销留痕：本场发起人、时间、原因 |

索引建议：`{ gameId: 1, userId: 1 }` **唯一索引**（settle 幂等保险 2 的数据库级保证），另建 `{ userId: 1, status: 1 }` 查个人有效鸽。
说明：api 云函数不提供任何创建鸽记录的入口；撤销走 `revokePigeon` / `resolveAppeal` 且必须校验发起人身份。

## 6. appeals —— 申诉

| 字段 | 类型 | 说明 |
|---|---|---|
| pigeonRecordId | string | 被申诉的鸽记录 id |
| gameId | string | 所属球局（冗余存一份，方便发起人按场查） |
| userId | string | 申诉人 openid（只能申诉自己名下的记录） |
| reason | string | 申诉理由 |
| status | string | pending / approved / rejected |
| decidedBy / decidedAt / decisionNote | string\|number\|null | 裁决留痕：本场发起人、时间、说明 |
| createdAt | number | |

索引建议：`{ gameId: 1, status: 1 }`、`{ userId: 1, status: 1 }`。

## 权限建议（云控制台「数据库 → 权限设置」）

原则：**小程序前端不直连数据库，一切读写只走云函数**。云函数使用服务端 SDK，
天然拥有管理员权限、不受安全规则限制。因此六个集合的权限统一设置为
「所有用户不可读写」：

```json
{ "read": false, "write": false }
```

这样即使有人扒出环境 ID，也无法绕过云函数的身份与权限校验直接读写数据。

## 种子数据（database/seed/）

`users.json` / `games.json` / `signups.json` / `checkins.json` 为 JSON Lines 格式
（每行一个文档，`_id` 已写好），与 `store.js` 的演示种子一一对应：
今晚 19:30 的 5 人制局 g1（12 人确定报名、2 人观望、7 人已签到）与 21:45 的
8 人制局 g2；用户 u1–u14（昵称均为「球友NN」，含一级/二级鸽王各一例）。
时间戳按生成当天日期换算，导入前如需改日期，直接改 `games.json` 的 `startTime`
并同步 signups/checkins 的相对时间即可。演示用户的 `_id` 是 `u1`–`u14` 占位，
不是真实 openid，仅用于空库联调演示，不要带进正式数据。

`pigeon_records` 与 `appeals` 无种子文件：建空集合即可，这两张表只能由
settle 结算与用户申诉在运行中产生。
