/**
 * unicloud.test.js —— 后端迁移（微信云开发 → uniCloud 免费空间）单测
 *
 * 迁移后的云端逻辑全部收敛在 uniCloud/cloudfunctions/api/ 一个函数内：
 *   service.js（业务）/ settleService.js（结算）/ auth.js（自建会话鉴权）/
 *   handler.js（路由 + 事件归一化）/ uniDb.js（uniCloud 数据库适配层）。
 * 本地测试仍用 memoryDb stub 顶替 uniDb（两者同签名），鉴权所需的
 * code2session HTTP 调用注入 stub，不依赖真实 uniCloud 环境与网络：
 *   node --test            （工程根目录，全量跑）
 *
 * 覆盖：原云端 6 条用例的等价版本（经 uniDb 适配层接口）+ 鉴权 3 条
 * + 惰性结算 1 条 + uniDb 适配层本身 1 条。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rules = require('../miniprogram/utils/rules');
const createMemoryDb = require('./helpers/memoryDb');
const createFakeUniDb = require('./helpers/fakeUniDb');
const createUniApi = require('../uniCloud/cloudfunctions/api/service');
const createUniSettle = require('../uniCloud/cloudfunctions/api/settleService');
const createUniDb = require('../uniCloud/cloudfunctions/api/uniDb');
const createHandler = require('../uniCloud/cloudfunctions/api/handler');

const H = 60 * 60 * 1000;
const VENUE = { name: '测试球场', poiId: 'venue_test', latitude: 31.2304, longitude: 121.4737 };
const T0 = new Date('2026-10-23T18:00:00+08:00').getTime();

function emptyUser(id) {
  return { id, openid: id, nickname: id, credit: rules.emptyCredit(), createdAt: T0 - 24 * H, updatedAt: T0 - 24 * H };
}

// code2session 的 HTTP stub：code=good-code 换到固定 openid，其余按微信口径回 errcode
function stubHttpGet(url) {
  const m = /[?&]js_code=([^&]+)/.exec(url);
  const code = m ? decodeURIComponent(m[1]) : '';
  if (code === 'good-code') return Promise.resolve({ openid: 'ox_player', session_key: 'sk_test' });
  return Promise.resolve({ errcode: 40029, errmsg: 'invalid code' });
}

const TEST_CONFIG = {
  WX_APPID: 'wx_test_appid',
  WX_APP_SECRET: 'test_secret_not_real',
  SESSION_TTL_MS: 30 * 24 * H,
  CODE2SESSION_ENDPOINT: 'https://example.invalid/sns/jscode2session',
};

function makeHandler(db, nowFn) {
  return createHandler({ db, now: nowFn, httpGet: stubHttpGet, config: TEST_CONFIG });
}

// ---------- 等价用例 1：合并查重（原云端1） ----------
test('uni1：createGame 服务端合并查重，同场+1.5h 命中既有局、+3h 才新建', async () => {
  const db = createMemoryDb();
  const api = createUniApi({ db, now: () => T0 - 6 * H });

  const first = await api.createGame('orgA', { location: VENUE, startTime: T0, teamSize: 5 });
  assert.equal(first.merged, false);

  const dup = await api.createGame('userB', { location: Object.assign({}, VENUE), startTime: T0 + 1.5 * H, teamSize: 5 });
  assert.equal(dup.merged, true);
  assert.equal(dup.target.id, first.game.id);
  assert.equal((await db.listGames()).length, 1);

  const separate = await api.createGame('userB', { location: Object.assign({}, VENUE), startTime: T0 + 3 * H, teamSize: 5 });
  assert.equal(separate.merged, false);
  assert.equal((await db.listGames()).length, 2);
});

// ---------- 等价用例 2：settle 幂等（原云端2）+ 结算通知只写一次 ----------
test('uni2：settle 到点结算且幂等——连跑/重置标记重跑都只记一次鸽，通知也只写一条', async () => {
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

  const early = await createUniSettle({ db, now: () => T0 + 3.9 * H }).run();
  assert.equal(early.settledCount, 0);
  assert.equal((await db.listPigeonRecords({})).length, 0);

  const settle = createUniSettle({ db, now: () => T0 + 5 * H });
  const first = await settle.run();
  assert.equal(first.settledCount, 1);
  assert.equal((await db.listPigeonRecords({})).length, 1);
  assert.equal((await db.getUser('late')).credit.historyPigeons, 1);
  assert.equal((await db.getUser('ontime')).credit.streakProgress, 1);
  let notes = await db.listNotifications({ userId: 'late' });
  assert.equal(notes.length, 1, '落鸽时应写一条结算通知');
  assert.equal(notes[0].type, 'settlement_pigeon');

  const second = await settle.run();
  assert.equal(second.settledCount, 0);
  assert.equal((await db.listPigeonRecords({})).length, 1);

  await db.updateGame(game.id, { settled: false, status: 'ended' });
  const third = await settle.run();
  assert.equal(third.settledCount, 1);
  assert.equal((await db.listPigeonRecords({})).length, 1, '重跑不得产生第二条鸽记录');
  assert.equal((await db.getUser('late')).credit.historyPigeons, 1);
  assert.equal((await db.getUser('ontime')).credit.totalAttendance, 1, '守约出席不得重复累计');
  notes = await db.listNotifications({ userId: 'late' });
  assert.equal(notes.length, 1, '重跑不得重复写通知');
});

// ---------- 等价用例 3：非发起人撤销被拒（原云端3） ----------
test('uni3：撤销鸽记录必须本场发起人本人，非发起人被拒、发起人撤销留痕生效', async () => {
  const db = createMemoryDb({ users: [emptyUser('org'), emptyUser('late')] });
  const game = await db.insertGame({
    organizerId: 'org', location: VENUE, startTime: T0, teamSize: 5,
    status: 'recruiting', settled: false, settledAt: null, fenceRadiusMeters: 500, createdAt: T0 - 6 * H,
  });
  await db.insertSignup({ gameId: game.id, userId: 'late', type: 'confirmed', status: 'confirmed', signedAt: T0 - 5 * H, cancelledAt: null, outcome: null, settledAt: null });
  await createUniSettle({ db, now: () => T0 + 5 * H }).run();
  const record = (await db.listPigeonRecords({}))[0];
  assert.ok(record);

  const api = createUniApi({ db, now: () => T0 + 6 * H });
  const denied = await api.revokePigeon('someoneElse', record.id, '我来乱撤销');
  assert.equal(denied.ok, false);
  assert.equal(denied.error, 'forbidden');
  assert.equal((await db.listPigeonRecords({}))[0].status, 'active');

  const done = await api.revokePigeon('org', record.id, '手机没电，队友作证');
  assert.equal(done.ok, true);
  const after = (await db.listPigeonRecords({}))[0];
  assert.equal(after.status, 'revoked');
  assert.equal(after.revokedBy, 'org');
  assert.equal(after.revokeReason, '手机没电，队友作证');
  assert.ok(after.revokedAt);
  assert.equal(done.effectivePigeons, 0);
});

// ---------- 等价用例 4：围栏服务端复算（原云端4） ----------
test('uni4：签到围栏在服务端复算，前端谎报在场也拒；围栏内正常签到', async () => {
  const db = createMemoryDb({ users: [emptyUser('org'), emptyUser('player')] });
  const game = await db.insertGame({
    organizerId: 'org', location: VENUE, startTime: T0, teamSize: 5,
    status: 'recruiting', settled: false, settledAt: null, fenceRadiusMeters: 500, createdAt: T0 - 6 * H,
  });
  const api = createUniApi({ db, now: () => T0 });

  const far = await api.checkin('player', {
    gameId: game.id,
    latitude: VENUE.latitude + 0.027,
    longitude: VENUE.longitude,
    withinFence: true,
  });
  assert.equal(far.ok, false);
  assert.equal(far.reason, 'too_far');
  assert.ok(far.distance > 500);
  assert.equal((await db.listCheckins({})).length, 0);

  const ok = await api.checkin('player', { gameId: game.id, latitude: VENUE.latitude, longitude: VENUE.longitude });
  assert.equal(ok.ok, true);
  const dup = await api.checkin('player', { gameId: game.id, latitude: VENUE.latitude, longitude: VENUE.longitude });
  assert.equal(dup.reason, 'already');
  assert.equal((await db.listCheckins({})).length, 1);
});

// ---------- 等价用例 5：rules 副本一致（原云端5，扩展到 uniCloud 共三份副本） ----------
test('uni5：源头与三份 rules.js 副本逐字一致；settle 定时触发为每小时', () => {
  const root = path.join(__dirname, '..');
  const source = fs.readFileSync(path.join(root, 'miniprogram/utils/rules.js'), 'utf8');
  const copies = [
    'cloudfunctions/api/rules.js',
    'cloudfunctions/settle/rules.js',
    'uniCloud/cloudfunctions/api/rules.js',
  ];
  for (const rel of copies) {
    assert.equal(fs.readFileSync(path.join(root, rel), 'utf8'), source, rel + ' 与源头不一致：按 SHARED_RULES.md 整文件复制源头');
  }
  const cfg = JSON.parse(fs.readFileSync(path.join(root, 'uniCloud/cloudfunctions/api/config.json'), 'utf8'));
  assert.equal(cfg.triggers.length, 1);
  assert.equal(cfg.triggers[0].type, 'timer');
  assert.equal(cfg.triggers[0].config, '0 0 * * * * *', 'settle 定时触发应为每小时整点');
});

// ---------- 等价用例 6：代签权限与留痕（原云端6） ----------
test('uni6：代签仅限发起人，且签到记录带 proxy 留痕', async () => {
  const db = createMemoryDb({ users: [emptyUser('org'), emptyUser('target')] });
  const game = await db.insertGame({
    organizerId: 'org', location: VENUE, startTime: T0, teamSize: 5,
    status: 'recruiting', settled: false, settledAt: null, fenceRadiusMeters: 500, createdAt: T0 - 6 * H,
  });
  const api = createUniApi({ db, now: () => T0 });

  const denied = await api.proxyCheckin('notOrg', game.id, 'target', '手机没电');
  assert.equal(denied.ok, false);
  assert.equal(denied.error, 'forbidden');

  const ok = await api.proxyCheckin('org', game.id, 'target', '手机没电');
  assert.equal(ok.ok, true);
  assert.equal(ok.checkin.method, 'proxy');
  assert.equal(ok.checkin.proxyBy, 'org');
  assert.equal(ok.checkin.proxyReason, '手机没电');
  assert.ok(ok.checkin.proxyAt);
});

// ---------- 鉴权用例 1：无 token / 伪造 token 被拒 ----------
test('uni7：无 token 与伪造 token 调用业务 action 一律 unauthorized（含 HTTP 事件形态）', async () => {
  const db = createMemoryDb();
  const handler = makeHandler(db, () => T0);

  const noToken = await handler.handle({ action: 'listGames' });
  assert.equal(noToken.ok, false);
  assert.equal(noToken.error, 'unauthorized');

  const forged = await handler.handle({ action: 'listGames', token: 'deadbeef'.repeat(8) });
  assert.equal(forged.ok, false);
  assert.equal(forged.error, 'unauthorized');

  // URL 化 HTTP 事件：无 authorization 头同样被拒，响应为组合响应且 body 是统一错误码
  const httpRes = await handler.handleEvent({
    httpMethod: 'POST',
    headers: {},
    body: JSON.stringify({ action: 'listGames' }),
  });
  assert.equal(httpRes.statusCode, 200);
  const parsed = JSON.parse(httpRes.body);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.error, 'unauthorized');
});

// ---------- 鉴权用例 2：login 全流程（stub code2session） ----------
test('uni8：login 换 token 后可正常调用；坏 code 被拒；HTTP Bearer 头与定时事件都通', async () => {
  const db = createMemoryDb();
  const handler = makeHandler(db, () => T0);

  const bad = await handler.handle({ action: 'login', code: 'wrong-code' });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'login_failed');

  const login = await handler.handle({ action: 'login', code: 'good-code' });
  assert.equal(login.ok, true);
  assert.equal(typeof login.token, 'string');
  assert.equal(login.token.length, 64, 'token 应为 32 字节随机数的 hex');
  assert.equal(login.expiresAt, T0 + TEST_CONFIG.SESSION_TTL_MS);
  assert.equal(login.openid, 'ox_player');
  assert.equal(db._data.sessions.length, 1);
  assert.equal(db._data.sessions[0].openid, 'ox_player');
  assert.ok(await db.getUser('ox_player'), 'login 应顺带建用户档案');

  const empty = await handler.handle({ action: 'listGames', token: login.token });
  assert.ok(Array.isArray(empty));
  assert.equal(empty.length, 0);

  const created = await handler.handle({
    action: 'createGame', token: login.token,
    location: VENUE, startTime: T0 + 24 * H, teamSize: 5,
  });
  assert.equal(created.merged, false);

  // HTTP 事件 + Bearer 头
  const httpRes = await handler.handleEvent({
    httpMethod: 'POST',
    headers: { authorization: 'Bearer ' + login.token },
    body: JSON.stringify({ action: 'listGames' }),
  });
  const games = JSON.parse(httpRes.body);
  assert.ok(Array.isArray(games));
  assert.equal(games.length, 1);

  // 带合法 token 的未知 action 应报 unknown_action（证明已过鉴权层）
  const unknown = await handler.handle({ action: 'hackThePlanet', token: login.token });
  assert.equal(unknown.error, 'unknown_action');

  // 定时触发事件走 settle 扫描，不需要 token
  const timer = await handler.handleEvent({ Type: 'Timer', TriggerName: 'settleTimerHourly' });
  assert.equal(timer.settledCount, 0, '未到结算时刻的局不应被结算');
});

// ---------- 鉴权用例 3：token 过期被拒 ----------
test('uni9：token 过期后被拒，且过期 session 被顺手清理', async () => {
  const db = createMemoryDb();
  const atLogin = makeHandler(db, () => T0);
  const login = await atLogin.handle({ action: 'login', code: 'good-code' });
  assert.equal(login.ok, true);

  const later = makeHandler(db, () => T0 + 31 * 24 * H); // 30 天 TTL 之后
  const res = await later.handle({ action: 'listGames', token: login.token });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'unauthorized');
  assert.equal(db._data.sessions.length, 0, '过期 session 应被删除');
});

// ---------- 惰性结算：读已过结算期的局会先结算且不重复记鸽 ----------
test('uni10：惰性结算——getGameDetail 读到过期未结算的局先结算，重读不重复记鸽', async () => {
  const db = createMemoryDb({ users: [emptyUser('org'), emptyUser('late')] });
  const game = await db.insertGame({
    organizerId: 'org', location: VENUE, startTime: T0, teamSize: 5,
    status: 'recruiting', settled: false, settledAt: null, fenceRadiusMeters: 500, createdAt: T0 - 6 * H,
  });
  await db.insertSignup({ gameId: game.id, userId: 'late', type: 'confirmed', status: 'confirmed', signedAt: T0 - 5 * H, cancelledAt: null, outcome: null, settledAt: null });

  const nowFn = () => T0 + 5 * H; // 已过开球 +4h 结算时刻
  const settle = createUniSettle({ db, now: nowFn });
  const api = createUniApi({ db, now: nowFn, settle });

  assert.equal((await db.listPigeonRecords({})).length, 0, '前置：尚未结算');
  const detail = await api.getGameDetail(game.id);
  assert.equal(detail.status, 'settled', '读详情时应已惰性结算');
  const records = await db.listPigeonRecords({});
  assert.equal(records.length, 1);
  assert.equal(records[0].userId, 'late');
  assert.equal((await db.getUser('late')).credit.historyPigeons, 1);

  const again = await api.getGameDetail(game.id);
  assert.equal(again.status, 'settled');
  assert.equal((await db.listPigeonRecords({})).length, 1, '重复读不得重复记鸽');
  assert.equal((await db.getUser('late')).credit.historyPigeons, 1);

  const notes = await api.listNotifications('late');
  assert.equal(notes.length, 1);
  assert.equal(notes[0].type, 'settlement_pigeon');
});

// ---------- uniDb 适配层本身：经 fake 原始 uniCloud DB 验证映射 ----------
test('uni11：uniDb 适配层在 fake uniCloud DB 上映射正确（_id↔id、users 主键、sessions）', async () => {
  const raw = createFakeUniDb();
  const db = createUniDb(raw);

  const game = await db.insertGame({ organizerId: 'ox_1', location: VENUE, startTime: T0, teamSize: 5, status: 'recruiting' });
  assert.ok(game.id);
  const fetched = await db.getGame(game.id);
  assert.equal(fetched.location.name, '测试球场');
  await db.updateGame(game.id, { status: 'ended' });
  assert.equal((await db.getGame(game.id)).status, 'ended');
  assert.equal((await db.listGames()).length, 1);

  // users 以 openid 作 _id：插入后按 openid 直查
  await db.insertUser({ id: 'ox_1', openid: 'ox_1', nickname: '甲', credit: rules.emptyCredit() });
  const user = await db.getUser('ox_1');
  assert.equal(user.id, 'ox_1');
  assert.equal(user.nickname, '甲');
  assert.equal(await db.getUser('nobody'), null);

  // sessions：签发 → 查 → 删
  const sess = await db.insertSession({ token: 'tok_abc', openid: 'ox_1', createdAt: T0, expiresAt: T0 + H });
  assert.ok(sess.id);
  assert.equal((await db.getSessionByToken('tok_abc')).openid, 'ox_1');
  assert.equal(await db.getSessionByToken('tok_nope'), null);
  await db.deleteSession(sess.id);
  assert.equal(await db.getSessionByToken('tok_abc'), null);

  // notifications：按 userId 过滤
  await db.insertNotification({ userId: 'ox_1', type: 'settlement_pigeon', gameId: game.id, createdAt: T0, read: false });
  await db.insertNotification({ userId: 'ox_2', type: 'settlement_pigeon', gameId: game.id, createdAt: T0, read: false });
  assert.equal((await db.listNotifications({ userId: 'ox_1' })).length, 1);

  // signups 等值过滤
  await db.insertSignup({ gameId: game.id, userId: 'ox_1', type: 'confirmed', status: 'confirmed' });
  await db.insertSignup({ gameId: game.id, userId: 'ox_2', type: 'watching', status: 'watching' });
  assert.equal((await db.listSignups({ gameId: game.id, userId: 'ox_1' })).length, 1);
  assert.equal((await db.listSignups({ gameId: game.id })).length, 2);
});
