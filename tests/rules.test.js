/**
 * rules.test.js —— 规则引擎单元测试（Node 内置 node:test，零依赖）
 * 运行：node --test（在工程根目录）或 node --test tests/rules.test.js
 * 覆盖 PRD 第 10.3 节 8 条核心验收用例，编号与 PRD 一一对应，另加核心函数补充用例。
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const rules = require('../miniprogram/utils/rules');

const H = 60 * 60 * 1000;
// 基准球局：今晚 18:00 开球、5 人制、固定坐标
const VENUE = { name: '测试球场', poiId: 'venue_test', latitude: 31.2304, longitude: 121.4737 };
const T0 = new Date('2026-10-23T18:00:00+08:00').getTime();

function baseGame(overrides) {
  return Object.assign(
    {
      id: 'g_origin',
      organizerId: 'org',
      location: Object.assign({}, VENUE),
      startTime: T0,
      teamSize: 5,
      status: 'recruiting',
      fenceRadiusMeters: 500,
    },
    overrides || {}
  );
}

// ---------- 验收用例 1：同场 19:30 对 18:00 原局 → 合并 ----------
test('验收1：同场、开球相差1.5小时（≤2h）应命中合并', () => {
  const origin = baseGame();
  const attempt = baseGame({ id: 'g_new', startTime: T0 + 1.5 * H });
  const target = rules.findMergeTarget(attempt, [origin]);
  assert.ok(target, '应命中合并目标');
  assert.equal(target.id, 'g_origin');
});

// ---------- 验收用例 2：同场 21:00 对 18:00 原局 → 不合并 ----------
test('验收2：同场、开球相差3小时（>2h）不应合并', () => {
  const origin = baseGame();
  const attempt = baseGame({ id: 'g_new', startTime: T0 + 3 * H });
  assert.equal(rules.findMergeTarget(attempt, [origin]), null);
});

// 防连环合并补充：19:30 的尝试并入 18:00 原局后，不产生新锚点；
// 21:00 的尝试只与原局 18:00 比（差 3h），仍不合并。
test('补充：防连环合并——只与原局官方时间比', () => {
  const origin = baseGame();
  const attempt2 = baseGame({ id: 'g_new2', startTime: T0 + 3 * H });
  // 已有球局列表里只有原局（被合并的尝试从未生成球局）
  assert.equal(rules.findMergeTarget(attempt2, [origin]), null);
  // 距离判定补充：同名同 POI 必同场；坐标漂移 3 公里外则不同场
  const farAttempt = baseGame({
    id: 'g_far',
    startTime: T0 + 0.5 * H,
    location: { name: '另一球场', poiId: 'venue_other', latitude: 31.26, longitude: 121.4737 },
  });
  assert.equal(rules.findMergeTarget(farAttempt, [origin]), null);
});

// ---------- 验收用例 3：5 人制第 20 人无上限、组 4 队 ----------
test('验收3：5人制到场20人无上限拦截，组满4队接波', () => {
  const arrived = Array.from({ length: 20 }, (_, i) => ({
    userId: 'u' + (i + 1),
    checkinAt: T0 + i * 60000,
  }));
  const r = rules.buildTeams(arrived, 5);
  assert.equal(r.total, 20);
  assert.equal(r.fullTeamCount, 4);
  assert.equal(r.teams.length, 4);
  assert.equal(r.formingTeam, null);
  assert.equal(r.playingTeams.length, 2);
  assert.equal(r.waitingTeams.length, 2);
  // 成局门槛 = 每队人数 × 2
  assert.equal(rules.formedThreshold(5), 10);
  assert.ok(rules.isFormed(20, 5));
  // PRD 示例：17 人 = 3 队满 + 第 4 队 2/5 组队中
  const r17 = rules.buildTeams(arrived.slice(0, 17), 5);
  assert.equal(r17.fullTeamCount, 3);
  assert.equal(r17.formingTeam.size, 2);
  assert.equal(r17.formingTeam.needed, 3);
});

// ---------- 验收用例 4：围栏外签到判定拒绝 ----------
test('验收4：围栏外（约3公里）签到应被拒绝', () => {
  const game = baseGame();
  const farLocation = { latitude: 31.2574, longitude: 121.4737 }; // 纬度 +0.027° ≈ 3 公里
  const verdict = rules.canCheckin(game, farLocation, T0); // 开球时刻、时间窗内
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'too_far');
  assert.ok(verdict.distance > 500);
  // 对照：围栏内同一时刻应通过
  const near = rules.canCheckin(game, VENUE, T0);
  assert.equal(near.ok, true);
});

// ---------- 验收用例 5：开球后 3 小时取消免鸽 ----------
test('验收5：结算前（开球后3小时）取消，结算时免鸽', () => {
  const game = baseGame();
  const signups = [
    { userId: 'late_cancel', gameId: game.id, type: 'confirmed', status: 'cancelled', cancelledAt: T0 + 3 * H },
  ];
  const res = rules.settleGame(game, signups, [], {}, T0 + 4 * H);
  assert.equal(res.settled, true);
  assert.equal(res.results.length, 1);
  assert.equal(res.results[0].outcome, 'exempt');
  assert.equal(res.credits.late_cancel.historyPigeons, 0);
});

// ---------- 验收用例 6：开球后 4 小时未到记鸽 ----------
test('验收6：报名未取消未签到，开球后4小时结算记鸽+1', () => {
  const game = baseGame();
  const signups = [{ userId: 'ghost', gameId: game.id, type: 'confirmed', status: 'confirmed', cancelledAt: null }];

  // 结算时刻之前不应结算
  const early = rules.settleGame(game, signups, [], {}, T0 + 3.9 * H);
  assert.equal(early.settled, false);
  assert.equal(early.reason, 'before_settle_time');

  const res = rules.settleGame(game, signups, [], {}, T0 + 4 * H);
  assert.equal(res.settled, true);
  assert.equal(res.results[0].outcome, 'pigeon');
  assert.equal(res.credits.ghost.historyPigeons, 1);
  assert.equal(rules.effectivePigeons(res.credits.ghost), 1);
  assert.equal(rules.pigeonLevel(res.credits.ghost).label, '一级鸽王');
});

// ---------- 验收用例 7：连续守约 5 场抵消最早 1 次且进度清零 ----------
test('验收7：连续守约满5场抵消1次鸽，进度清零重攒', () => {
  let credit = { historyPigeons: 2, redeemedPigeons: 0, revokedPigeons: 0, streakProgress: 0, totalAttendance: 0, totalConfirmedSignups: 0 };
  for (let i = 0; i < 4; i += 1) credit = rules.applyAttendance(credit, 'attended');
  assert.equal(credit.streakProgress, 4);
  assert.equal(credit.redeemedPigeons, 0);
  credit = rules.applyAttendance(credit, 'attended'); // 第 5 场
  assert.equal(credit.redeemedPigeons, 1, '应抵消最早 1 次');
  assert.equal(credit.streakProgress, 0, '抵消后进度清零');
  assert.equal(rules.effectivePigeons(credit), 1);
  // 无有效鸽时继续守约：进度正常攒，不产生负抵消
  let clean = rules.emptyCredit();
  for (let i = 0; i < 5; i += 1) clean = rules.applyAttendance(clean, 'attended');
  assert.equal(clean.redeemedPigeons, 0);
  assert.equal(clean.streakProgress, 0);
});

// ---------- 验收用例 8：中途再鸽进度清零 ----------
test('验收8：赎鸽进度中途再鸽，进度清零且有效鸽+1', () => {
  let credit = { historyPigeons: 1, redeemedPigeons: 0, revokedPigeons: 0, streakProgress: 4, totalAttendance: 9, totalConfirmedSignups: 10 };
  credit = rules.applyAttendance(credit, 'pigeon');
  assert.equal(credit.streakProgress, 0);
  assert.equal(credit.historyPigeons, 2);
  assert.equal(rules.effectivePigeons(credit), 2);
});

// ---------- 补充：鸽王等级映射 ----------
test('补充：鸽王等级映射（有效鸽次数）', () => {
  assert.equal(rules.pigeonLevel(0).label, '');
  assert.equal(rules.pigeonLevel(1).label, '一级鸽王');
  assert.equal(rules.pigeonLevel(2).label, '二级鸽王');
  assert.equal(rules.pigeonLevel(3).label, '二级鸽王');
  assert.equal(rules.pigeonLevel(4).label, '三级鸽王');
  assert.equal(rules.pigeonLevel(6).label, '三级鸽王');
  assert.equal(rules.pigeonLevel(7).label, '鸽帝');
});

// ---------- 补充：haversine 距离量级 ----------
test('补充：haversine——同点为0，纬度差0.009°约1公里', () => {
  assert.equal(rules.haversineMeters(31.2304, 121.4737, 31.2304, 121.4737), 0);
  const d = rules.haversineMeters(31.2304, 121.4737, 31.2394, 121.4737);
  assert.ok(d > 950 && d < 1050, '实际距离 ' + d);
});

// ---------- 补充：观望不担鸽责 / 空降只计出席 / 全场取消全员免鸽 ----------
test('补充：观望免记、空降只计出席不清进度', () => {
  const game = baseGame();
  const signups = [
    { userId: 'watcher', gameId: game.id, type: 'watching', status: 'watching', cancelledAt: null },
    { userId: 'member', gameId: game.id, type: 'confirmed', status: 'confirmed', cancelledAt: null },
  ];
  const checkins = [
    { userId: 'member', gameId: game.id, checkinAt: T0 },
    { userId: 'walkin', gameId: game.id, checkinAt: T0 },
  ];
  const creditsIn = { walkin: { historyPigeons: 1, redeemedPigeons: 0, revokedPigeons: 0, streakProgress: 3, totalAttendance: 5, totalConfirmedSignups: 6 } };
  const res = rules.settleGame(game, signups, checkins, creditsIn, T0 + 4 * H);
  const byUser = {};
  res.results.forEach((r) => { byUser[r.userId] = r.outcome; });
  assert.equal(byUser.watcher, 'exempt');
  assert.equal(byUser.member, 'attended');
  assert.equal(byUser.walkin, 'walkin');
  assert.equal(res.credits.walkin.totalAttendance, 6);
  assert.equal(res.credits.walkin.streakProgress, 3, '空降不计抵消进度');

  const cancelledGame = baseGame({ status: 'cancelled' });
  const res2 = rules.settleGame(cancelledGame, signups, [], {}, T0 + 4 * H);
  assert.equal(res2.cancelled, true);
  assert.ok(res2.results.every((r) => r.outcome === 'exempt'));
});

// ---------- 补充：报名冲突判定与重叠场次签到归属 ----------
test('补充：同时段冲突判定；已报名者签入报名场、空降者签入最新开球场', () => {
  const g1 = baseGame({ id: 'ga' });
  const g2 = baseGame({ id: 'gb', startTime: T0 + 1 * H, location: { name: '另一场', poiId: 'v2', latitude: 31.31, longitude: 121.5 } });
  assert.equal(rules.findSignupConflict([g1], g2).id, 'ga');
  assert.equal(rules.findSignupConflict([g1], baseGame({ id: 'gc', startTime: T0 + 5 * H })), null);

  // 同场重叠两场（第二场晚 2.5 小时开球，未被合并），现在是第二场开球后
  const overlapA = baseGame({ id: 'oa', startTime: T0 });
  const overlapB = baseGame({ id: 'ob', startTime: T0 + 2.5 * H });
  const now = T0 + 3 * H;
  const mySignups = [{ userId: 'me', gameId: 'oa', type: 'confirmed', status: 'confirmed' }];
  assert.equal(rules.resolveCheckinTarget('me', [overlapA, overlapB], mySignups, now).id, 'oa');
  assert.equal(rules.resolveCheckinTarget('stranger', [overlapA, overlapB], [], now).id, 'ob');
});
