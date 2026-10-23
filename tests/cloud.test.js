/**
 * cloud.test.js —— 第二阶段云端逻辑单测（node:test，零依赖）
 *
 * 云函数的 service 层不依赖 wx-server-sdk，数据库用 tests/helpers/memoryDb.js
 * 的内存 stub 顶替 cloudDb.js（两者方法签名一致），因此全部用例可在本地跑：
 *   node --test            （工程根目录，与 rules.test.js 一起全量跑）
 *
 * 覆盖任务要点：api 合并查重命中既有局 / settle 幂等 / 非发起人撤销被拒 /
 * 围栏外签到被服务端拒绝 / 云端 rules 副本与源头逐字一致。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rules = require('../miniprogram/utils/rules');
const createMemoryDb = require('./helpers/memoryDb');
const createApi = require('../cloudfunctions/api/service');
const createSettle = require('../cloudfunctions/settle/service');

const H = 60 * 60 * 1000;
const VENUE = { name: '测试球场', poiId: 'venue_test', latitude: 31.2304, longitude: 121.4737 };
const T0 = new Date('2026-10-23T18:00:00+08:00').getTime();

function emptyUser(id) {
  return { id, openid: id, nickname: id, credit: rules.emptyCredit(), createdAt: T0 - 24 * H, updatedAt: T0 - 24 * H };
}

// ---------- 用例 1：合并查重走 api 逻辑，命中既有局 ----------
test('云端1：createGame 服务端合并查重，同场+1.5h 命中既有局、+3h 才新建', async () => {
  const db = createMemoryDb();
  const api = createApi({ db, now: () => T0 - 6 * H });

  const first = await api.createGame('orgA', { location: VENUE, startTime: T0, teamSize: 5 });
  assert.equal(first.merged, false);
  assert.ok(first.game.id);

  // 另一用户同场、开球 +1.5h 发起 → 命中合并，不新建局
  const dup = await api.createGame('userB', { location: Object.assign({}, VENUE), startTime: T0 + 1.5 * H, teamSize: 5 });
  assert.equal(dup.merged, true);
  assert.equal(dup.target.id, first.game.id);
  assert.equal((await db.listGames()).length, 1, '合并时不得产生第二个球局');

  // 同场 +3h（超过 2h 窗口）→ 允许新建
  const separate = await api.createGame('userB', { location: Object.assign({}, VENUE), startTime: T0 + 3 * H, teamSize: 5 });
  assert.equal(separate.merged, false);
  assert.equal((await db.listGames()).length, 2);
});

// ---------- 用例 2：settle 幂等，连跑两次只记一次鸽 ----------
test('云端2：settle 到点结算且幂等——连跑两次、甚至重置标记重跑，都只记一次鸽', async () => {
  const db = createMemoryDb({
    users: [emptyUser('org'), emptyUser('late'), emptyUser('ontime')],
  });
  const game = await db.insertGame({
    organizerId: 'org', location: VENUE, startTime: T0, teamSize: 5,
    status: 'recruiting', settled: false, settledAt: null, fenceRadiusMeters: 500, createdAt: T0 - 6 * H,
  });
  await db.insertSignup({ gameId: game.id, userId: 'late', type: 'confirmed', status: 'confirmed', signedAt: T0 - 5 * H, cancelledAt: null, outcome: null, settledAt: null });
  await db.insertSignup({ gameId: game.id, userId: 'ontime', type: 'confirmed', status: 'confirmed', signedAt: T0 - 5 * H, cancelledAt: null, outcome: null, settledAt: null });
  await db.insertCheckin({ gameId: game.id, userId: 'ontime', checkinAt: T0 + 10 * 60 * 1000, method: 'location', verifiedDistance: 12, location: VENUE, settledAt: null });

  // 未到开球+4h：不结算
  const early = await createSettle({ db, now: () => T0 + 3.9 * H }).run();
  assert.equal(early.settledCount, 0);
  assert.equal((await db.listPigeonRecords({})).length, 0);

  // 到点结算
  const settle = createSettle({ db, now: () => T0 + 5 * H });
  const first = await settle.run();
  assert.equal(first.settledCount, 1);
  let records = await db.listPigeonRecords({});
  assert.equal(records.length, 1, '只有未到场的 late 被记鸽');
  assert.equal(records[0].userId, 'late');
  assert.equal(records[0].status, 'active');
  assert.equal((await db.getUser('late')).credit.historyPigeons, 1);
  assert.equal((await db.getUser('ontime')).credit.totalAttendance, 1);
  assert.equal((await db.getUser('ontime')).credit.streakProgress, 1);

  // 连跑第二次：settled 标记拦截，账目纹丝不动
  const second = await settle.run();
  assert.equal(second.settledCount, 0);
  assert.equal((await db.listPigeonRecords({})).length, 1);
  assert.equal((await db.getUser('late')).credit.historyPigeons, 1);

  // 模拟上次结算中途失败、标记丢失后重跑：靠 signup.outcome 与鸽记录唯一键兜底，仍不重复记账
  await db.updateGame(game.id, { settled: false, status: 'ended' });
  const third = await settle.run();
  assert.equal(third.settledCount, 1, '标记丢失时应补结算流程');
  records = await db.listPigeonRecords({});
  assert.equal(records.length, 1, '重跑不得产生第二条鸽记录');
  assert.equal((await db.getUser('late')).credit.historyPigeons, 1, '重跑不得重复 +1');
  assert.equal((await db.getUser('ontime')).credit.totalAttendance, 1, '守约出席不得重复累计');
});

// ---------- 用例 3：非发起人调用撤销被拒绝 ----------
test('云端3：撤销鸽记录必须本场发起人本人，非发起人被拒、发起人撤销留痕生效', async () => {
  const db = createMemoryDb({
    users: [emptyUser('org'), emptyUser('late')],
  });
  const game = await db.insertGame({
    organizerId: 'org', location: VENUE, startTime: T0, teamSize: 5,
    status: 'recruiting', settled: false, settledAt: null, fenceRadiusMeters: 500, createdAt: T0 - 6 * H,
  });
  await db.insertSignup({ gameId: game.id, userId: 'late', type: 'confirmed', status: 'confirmed', signedAt: T0 - 5 * H, cancelledAt: null, outcome: null, settledAt: null });
  await createSettle({ db, now: () => T0 + 5 * H }).run();
  const record = (await db.listPigeonRecords({}))[0];
  assert.ok(record, '前置条件：应已产生鸽记录');

  const api = createApi({ db, now: () => T0 + 6 * H });
  const denied = await api.revokePigeon('someoneElse', record.id, '我来乱撤销');
  assert.equal(denied.ok, false);
  assert.equal(denied.error, 'forbidden');
  assert.equal((await db.listPigeonRecords({}))[0].status, 'active', '被拒后记录不得变化');

  const done = await api.revokePigeon('org', record.id, '手机没电，队友作证');
  assert.equal(done.ok, true);
  const after = (await db.listPigeonRecords({}))[0];
  assert.equal(after.status, 'revoked');
  assert.equal(after.revokedBy, 'org', '撤销必须留痕：操作者');
  assert.equal(after.revokeReason, '手机没电，队友作证', '撤销必须留痕：原因');
  assert.ok(after.revokedAt, '撤销必须留痕：时间');
  assert.equal(done.effectivePigeons, 0, '撤销后有效鸽归零');
  assert.equal((await db.getUser('late')).credit.revokedPigeons, 1);

  const again = await api.revokePigeon('org', record.id, '再撤一次');
  assert.equal(again.ok, false, '已撤销的记录不能重复撤销');
});

// ---------- 用例 4：围栏外签到被服务端拒绝（不信前端布尔值） ----------
test('云端4：签到围栏在服务端复算，前端谎报在场也拒；围栏内正常签到', async () => {
  const db = createMemoryDb({ users: [emptyUser('org'), emptyUser('player')] });
  const game = await db.insertGame({
    organizerId: 'org', location: VENUE, startTime: T0, teamSize: 5,
    status: 'recruiting', settled: false, settledAt: null, fenceRadiusMeters: 500, createdAt: T0 - 6 * H,
  });
  const api = createApi({ db, now: () => T0 }); // 开球时刻，时间窗内

  // 球场以北约 3 公里，前端还谎报 withinFence:true —— 服务端只认坐标复算
  const far = await api.checkin('player', {
    gameId: game.id,
    latitude: VENUE.latitude + 0.027,
    longitude: VENUE.longitude,
    withinFence: true,
  });
  assert.equal(far.ok, false);
  assert.equal(far.reason, 'too_far');
  assert.ok(far.distance > 500, '应返回服务端复算的真实距离');
  assert.equal((await db.listCheckins({})).length, 0, '被拒不得落签到记录');

  // 球场原点签到 → 成功；重复签到 → already，不重复落记录
  const ok = await api.checkin('player', { gameId: game.id, latitude: VENUE.latitude, longitude: VENUE.longitude });
  assert.equal(ok.ok, true);
  assert.equal(ok.checkin.method, 'location');
  const dup = await api.checkin('player', { gameId: game.id, latitude: VENUE.latitude, longitude: VENUE.longitude });
  assert.equal(dup.reason, 'already');
  assert.equal((await db.listCheckins({})).length, 1);
});

// ---------- 用例 5：云端 rules 副本与源头逐字一致 ----------
test('云端5：cloudfunctions 两份 rules.js 副本与 miniprogram 源头逐字一致', () => {
  const root = path.join(__dirname, '..');
  const source = fs.readFileSync(path.join(root, 'miniprogram/utils/rules.js'), 'utf8');
  const apiCopy = fs.readFileSync(path.join(root, 'cloudfunctions/api/rules.js'), 'utf8');
  const settleCopy = fs.readFileSync(path.join(root, 'cloudfunctions/settle/rules.js'), 'utf8');
  assert.equal(apiCopy, source, 'api/rules.js 与源头不一致：按 SHARED_RULES.md 整文件复制源头');
  assert.equal(settleCopy, source, 'settle/rules.js 与源头不一致：按 SHARED_RULES.md 整文件复制源头');
});

// ---------- 用例 6（补充）：代签权限与留痕 ----------
test('云端6：代签仅限发起人，且签到记录带 proxy 留痕', async () => {
  const db = createMemoryDb({ users: [emptyUser('org'), emptyUser('target')] });
  const game = await db.insertGame({
    organizerId: 'org', location: VENUE, startTime: T0, teamSize: 5,
    status: 'recruiting', settled: false, settledAt: null, fenceRadiusMeters: 500, createdAt: T0 - 6 * H,
  });
  const api = createApi({ db, now: () => T0 });

  const denied = await api.proxyCheckin('notOrg', game.id, 'target', '手机没电');
  assert.equal(denied.ok, false);
  assert.equal(denied.error, 'forbidden');

  const ok = await api.proxyCheckin('org', game.id, 'target', '手机没电');
  assert.equal(ok.ok, true);
  assert.equal(ok.checkin.method, 'proxy');
  assert.equal(ok.checkin.proxyBy, 'org');
  assert.equal(ok.checkin.proxyReason, '手机没电');
  assert.ok(ok.checkin.proxyAt, '代签必须留痕：时间');
});
