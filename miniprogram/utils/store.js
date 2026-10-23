/**
 * store.js —— 本地 mock 数据层（第一阶段）
 *
 * 设计约定（后端可插拔）：
 *  - 所有对外方法都返回 Promise，签名在 mock 与 uniCloud 两种模式下
 *    完全一致，页面层只依赖这些方法名与入参/出参结构，换实现时页面不用改。
 *  - 数据只存内存 + 本模块种子数据；小程序重启后恢复为种子状态（演示用）。
 *  - 业务判定一律调用 rules.js，本层只负责存取与组装，不复制规则数值。
 */

const rules = require('./rules');

// ---------- 后端模式：mock | unicloud（BACKEND 开关） ----------
// BACKEND = 'mock'：走下方本地 mock（默认，演示与本地开发用）。
// BACKEND = 'unicloud'：走 uniCloud 免费服务空间（支付宝云）的 api
//   云函数 URL 化 HTTPS 接口。切换前置条件（详见 README
//   「需要用户配合的事项清单（uniCloud 版）」）：
//   ① 把 UNICLOUD_API_URL 换成你的空间函数地址（见下方占位注释）；
//   ② 在小程序公众平台把该域名加入 request 合法域名。
// 微信云开发分支（wx.cloud.callFunction）已随 cloudfunctions/ 一起
// 弃用并从本文件移除（历史实现只读保留在 cloudfunctions/api）。
const BACKEND = 'mock';

// ← 替换位置：uniCloud api 云函数的 URL 化地址，开通免费空间并对
//   api 函数开启 URL 化后得到，形如：
//   'https://{spaceId}.api-hz.cloudbasefunction.cn/api'
//   （{spaceId} 是你的服务空间 ID，只改这一处常量。）
const UNICLOUD_API_URL = '';

const SESSION_STORAGE_KEY = 'unicloud_session';
let sessionCache = null; // { token, expiresAt }

function wxLoginCode() {
  return new Promise((resolve, reject) => {
    wx.login({
      success: (res) => (res && res.code ? resolve(res.code) : reject(new Error('wx.login 未返回 code'))),
      fail: reject,
    });
  });
}

function wxRequestUni(data, token) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: UNICLOUD_API_URL,
      method: 'POST',
      header: {
        'content-type': 'application/json',
        authorization: token ? 'Bearer ' + token : '',
      },
      data,
      success: (res) => resolve(res.data),
      fail: reject,
    });
  });
}

/** 会话管理：优先用内存/本地缓存的 token，缺失或将过期时 wx.login 换新 */
async function ensureSession(forceRefresh) {
  const now = Date.now();
  if (!forceRefresh) {
    if (sessionCache && sessionCache.expiresAt > now + 60 * 1000) return sessionCache;
    try {
      const stored = wx.getStorageSync(SESSION_STORAGE_KEY);
      if (stored && stored.token && stored.expiresAt > now + 60 * 1000) {
        sessionCache = stored;
        return sessionCache;
      }
    } catch (e) { /* 读缓存失败则重新登录 */ }
  }
  const code = await wxLoginCode();
  const result = await wxRequestUni({ action: 'login', code }, '');
  if (!result || result.error || !result.token) {
    throw new Error('unicloud login failed: ' + ((result && result.error) || 'no_token'));
  }
  sessionCache = { token: result.token, expiresAt: result.expiresAt };
  try {
    wx.setStorageSync(SESSION_STORAGE_KEY, sessionCache);
  } catch (e) { /* 缓存失败不影响本次调用 */ }
  return sessionCache;
}

/**
 * uniCloud 调用：与 mock 方法同名同出入参，页面层零改动。
 * 首次调用前自动完成登录并缓存 token；服务端回 unauthorized
 * （token 失效/过期）时自动重新登录一次并重试原请求（只重试一次）。
 */
async function uniCall(action, payload) {
  if (!UNICLOUD_API_URL) throw new Error('UNICLOUD_API_URL 未配置（见 store.js 顶部 BACKEND 说明）');
  const session = await ensureSession(false);
  let result = await wxRequestUni(Object.assign({ action }, payload || {}), session.token);
  if (result && result.error === 'unauthorized') {
    const fresh = await ensureSession(true);
    result = await wxRequestUni(Object.assign({ action }, payload || {}), fresh.token);
  }
  return result;
}

// ---------- 通用小工具 ----------
let seq = 100;
function nextId(prefix) {
  seq += 1;
  return prefix + '_' + seq;
}
function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}
function todayAt(hour, minute) {
  const d = new Date();
  d.setHours(hour, minute || 0, 0, 0);
  return d.getTime();
}
function daysAgoAt(days, hour, minute) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(hour, minute || 0, 0, 0);
  return d.getTime();
}

// ---------- 当前演示用户 ----------
const CURRENT_USER_ID = 'u1';

// ---------- 种子数据 ----------
// 地点坐标为公开球场示意坐标，仅用于演示围栏/距离计算，不含任何个人信息。
const VENUE_A = { name: '市体育中心足球场', poiId: 'venue_a', latitude: 31.2304, longitude: 121.4737 };
const VENUE_B = { name: '滨江公园笼式足球场', poiId: 'venue_b', latitude: 31.2401, longitude: 121.4902 };

function seedData() {
  const startA = todayAt(19, 30); // 今晚 19:30，5 人制演示局
  const startB = todayAt(21, 45); // 同日另一场（与 A 相差 2h15m，不会合并）

  const users = {};
  const mkUser = (id, nickname, credit) => {
    users[id] = { id, nickname, credit: Object.assign(rules.emptyCredit(), credit || {}) };
  };
  // u1 的信誉与下方 5 条历史鸽记录对应：历史 5 − 抵消 1 − 撤销 1 = 有效 3（二级鸽王）
  mkUser('u1', '球友01', { historyPigeons: 5, redeemedPigeons: 1, revokedPigeons: 1, totalAttendance: 8, totalConfirmedSignups: 13, streakProgress: 0 });
  mkUser('u2', '球友02', { historyPigeons: 1, totalAttendance: 6, totalConfirmedSignups: 7, streakProgress: 2 }); // 一级鸽王，其鸽记录即下方 pg_org 那条
  mkUser('u3', '球友03', { historyPigeons: 3, redeemedPigeons: 1, totalAttendance: 15, totalConfirmedSignups: 17, streakProgress: 4 }); // 有效鸽 2，二级鸽王
  for (let i = 4; i <= 14; i += 1) {
    mkUser('u' + i, '球友' + (i < 10 ? '0' + i : '' + i), { totalAttendance: i, totalConfirmedSignups: i + 1, streakProgress: i % 4 });
  }

  const games = [
    {
      id: 'g1',
      organizerId: 'u1',
      location: clone(VENUE_A),
      startTime: startA,
      teamSize: 5,
      note: '自带深浅两色球衣，场地费 AA',
      status: 'recruiting', // recruiting | formed | playing | ended | settled | cancelled
      fenceRadiusMeters: rules.MERGE_RADIUS_METERS,
      createdAt: startA - 6 * 60 * 60 * 1000,
    },
    {
      id: 'g2',
      organizerId: 'u3',
      location: clone(VENUE_B),
      startTime: startB,
      teamSize: 8,
      note: '晚场慢节奏，欢迎新人',
      status: 'recruiting',
      fenceRadiusMeters: rules.MERGE_RADIUS_METERS,
      createdAt: startB - 5 * 60 * 60 * 1000,
    },
    // —— 历史已结算球局（第三阶段演示：我的球局分组、鸽记录与申诉流转都挂在这些局上）——
    {
      id: 'pg1', organizerId: 'u3', location: clone(VENUE_A),
      startTime: daysAgoAt(1, 19, 30), teamSize: 5, note: '昨日夜场',
      status: 'settled', settled: true, settledAt: daysAgoAt(1, 19, 30) + rules.SETTLE_DELAY_MS,
      fenceRadiusMeters: rules.MERGE_RADIUS_METERS, createdAt: daysAgoAt(1, 19, 30) - 6 * 60 * 60 * 1000,
    },
    {
      id: 'pg2', organizerId: 'u2', location: clone(VENUE_B),
      startTime: daysAgoAt(2, 20, 0), teamSize: 5, note: '笼式小场',
      status: 'settled', settled: true, settledAt: daysAgoAt(2, 20, 0) + rules.SETTLE_DELAY_MS,
      fenceRadiusMeters: rules.MERGE_RADIUS_METERS, createdAt: daysAgoAt(2, 20, 0) - 6 * 60 * 60 * 1000,
    },
    {
      id: 'pg3', organizerId: 'u3', location: clone(VENUE_A),
      startTime: daysAgoAt(3, 19, 0), teamSize: 5, note: '',
      status: 'settled', settled: true, settledAt: daysAgoAt(3, 19, 0) + rules.SETTLE_DELAY_MS,
      fenceRadiusMeters: rules.MERGE_RADIUS_METERS, createdAt: daysAgoAt(3, 19, 0) - 6 * 60 * 60 * 1000,
    },
    {
      id: 'pg4', organizerId: 'u2', location: clone(VENUE_B),
      startTime: daysAgoAt(4, 20, 30), teamSize: 8, note: '大场对抗',
      status: 'settled', settled: true, settledAt: daysAgoAt(4, 20, 30) + rules.SETTLE_DELAY_MS,
      fenceRadiusMeters: rules.MERGE_RADIUS_METERS, createdAt: daysAgoAt(4, 20, 30) - 6 * 60 * 60 * 1000,
    },
    {
      id: 'pg5', organizerId: 'u3', location: clone(VENUE_A),
      startTime: daysAgoAt(5, 19, 30), teamSize: 5, note: '',
      status: 'settled', settled: true, settledAt: daysAgoAt(5, 19, 30) + rules.SETTLE_DELAY_MS,
      fenceRadiusMeters: rules.MERGE_RADIUS_METERS, createdAt: daysAgoAt(5, 19, 30) - 6 * 60 * 60 * 1000,
    },
    {
      id: 'pg_org', organizerId: 'u1', location: clone(VENUE_A),
      startTime: daysAgoAt(1, 21, 45), teamSize: 5, note: 'u1 发起的已结算局，含一条待裁决申诉',
      status: 'settled', settled: true, settledAt: daysAgoAt(1, 21, 45) + rules.SETTLE_DELAY_MS,
      fenceRadiusMeters: rules.MERGE_RADIUS_METERS, createdAt: daysAgoAt(1, 21, 45) - 6 * 60 * 60 * 1000,
    },
  ];

  // g1：12 人确定报名（含发起人）、2 人观望；其中 7 人已签到（可演示接波组队）
  const signups = [];
  const checkins = [];
  for (let i = 1; i <= 12; i += 1) {
    signups.push({
      id: 's_u' + i,
      gameId: 'g1',
      userId: 'u' + i,
      type: 'confirmed',
      status: 'confirmed',
      signedAt: startA - 5 * 60 * 60 * 1000 + i * 60000,
      cancelledAt: null,
    });
  }
  signups.push({ id: 's_u13', gameId: 'g1', userId: 'u13', type: 'watching', status: 'watching', signedAt: startA - 4 * 60 * 60 * 1000, cancelledAt: null });
  signups.push({ id: 's_u14', gameId: 'g1', userId: 'u14', type: 'watching', status: 'watching', signedAt: startA - 4 * 60 * 60 * 1000, cancelledAt: null });
  for (let i = 1; i <= 7; i += 1) {
    checkins.push({
      id: 'c_u' + i,
      gameId: 'g1',
      userId: 'u' + i,
      checkinAt: startA - 20 * 60000 + i * 3 * 60000, // 开球前陆续到场
      method: 'location', // location | proxy（发起人代签）
    });
  }
  // g2：4 人确定报名
  for (let i = 1; i <= 4; i += 1) {
    signups.push({
      id: 's2_u' + i,
      gameId: 'g2',
      userId: 'u' + i,
      type: 'confirmed',
      status: 'confirmed',
      signedAt: startB - 3 * 60 * 60 * 1000,
      cancelledAt: null,
    });
  }

  // —— 历史局报名：u1 在 pg1–pg5 确定报名后未到场（各产生一条鸽记录，见下）；
  //    u2 在 u1 发起的 pg_org 未到场，产生 pr_org ——
  ['pg1', 'pg2', 'pg3', 'pg4', 'pg5'].forEach((gid, idx) => {
    const g = games.find((x) => x.id === gid);
    signups.push({
      id: 's_' + gid + '_u1', gameId: gid, userId: 'u1', type: 'confirmed', status: 'confirmed',
      signedAt: g.startTime - 5 * 60 * 60 * 1000, cancelledAt: null,
      outcome: 'pigeon', settledAt: g.startTime + rules.SETTLE_DELAY_MS,
    });
    void idx;
  });
  signups.push({
    id: 's_pg_org_u2', gameId: 'pg_org', userId: 'u2', type: 'confirmed', status: 'confirmed',
    signedAt: daysAgoAt(1, 21, 45) - 5 * 60 * 60 * 1000, cancelledAt: null,
    outcome: 'pigeon', settledAt: daysAgoAt(1, 21, 45) + rules.SETTLE_DELAY_MS,
  });

  // —— 鸽记录（只能由结算产生；状态：active 有效 / redeemed 已抵消 / revoked 已撤销）——
  const settleTs = (gid) => games.find((x) => x.id === gid).startTime + rules.SETTLE_DELAY_MS;
  const pigeonRecords = [
    { id: 'pr1', gameId: 'pg1', userId: 'u1', createdAt: settleTs('pg1'), status: 'active', redeemedAt: null, revokedBy: null, revokedAt: null, revokeReason: null },
    { id: 'pr2', gameId: 'pg2', userId: 'u1', createdAt: settleTs('pg2'), status: 'active', redeemedAt: null, revokedBy: null, revokedAt: null, revokeReason: null },
    { id: 'pr3', gameId: 'pg3', userId: 'u1', createdAt: settleTs('pg3'), status: 'revoked', redeemedAt: null, revokedBy: 'u3', revokedAt: settleTs('pg3') + 2 * 60 * 60 * 1000, revokeReason: '队友作证确已到场，定位未打开' },
    { id: 'pr4', gameId: 'pg4', userId: 'u1', createdAt: settleTs('pg4'), status: 'active', redeemedAt: null, revokedBy: null, revokedAt: null, revokeReason: null },
    { id: 'pr5', gameId: 'pg5', userId: 'u1', createdAt: settleTs('pg5'), status: 'redeemed', redeemedAt: daysAgoAt(1, 9, 0), revokedBy: null, revokedAt: null, revokeReason: null },
    { id: 'pr_org', gameId: 'pg_org', userId: 'u2', createdAt: settleTs('pg_org'), status: 'active', redeemedAt: null, revokedBy: null, revokedAt: null, revokeReason: null },
  ];

  // —— 申诉（状态：pending 待裁决 / approved 已通过→记录撤销 / rejected 已驳回）——
  const appeals = [
    { id: 'ap1', pigeonRecordId: 'pr2', gameId: 'pg2', userId: 'u1', reason: '临时加班，结束后赶到球场时定位没打开', status: 'pending', decidedBy: null, decidedAt: null, decisionNote: null, createdAt: settleTs('pg2') + 30 * 60000 },
    { id: 'ap2', pigeonRecordId: 'pr3', gameId: 'pg3', userId: 'u1', reason: '人在现场，手机没电没签上到', status: 'approved', decidedBy: 'u3', decidedAt: settleTs('pg3') + 2 * 60 * 60 * 1000, decisionNote: '队友作证，撤销这一次', createdAt: settleTs('pg3') + 30 * 60000 },
    { id: 'ap3', pigeonRecordId: 'pr4', gameId: 'pg4', userId: 'u1', reason: '那天去的是另一个球场，记混了', status: 'rejected', decidedBy: 'u2', decidedAt: settleTs('pg4') + 3 * 60 * 60 * 1000, decisionNote: '本场名单与现场确认均无到场记录', createdAt: settleTs('pg4') + 30 * 60000 },
    { id: 'ap_org', pigeonRecordId: 'pr_org', gameId: 'pg_org', userId: 'u2', reason: '手机没电，到了现场但没签上到', status: 'pending', decidedBy: null, decidedAt: null, decisionNote: null, createdAt: settleTs('pg_org') + 30 * 60000 },
  ];

  // —— 通知（当前演示用户 u1 的历史通知，通知落地页列表用）——
  const notifications = [
    { id: 'nt1', type: 'game_change', gameId: 'g1', pigeonRecordId: null, title: '球局信息变更', content: '发起人补充了备注：自带深浅两色球衣，场地费 AA。时间地点不变。', createdAt: Date.now() - 30 * 60000, read: false },
    { id: 'nt2', type: 'milestone', gameId: 'g1', pigeonRecordId: null, title: '已成局', content: '今晚 19:30 市体育中心足球场已达到成局门槛：确定报名 12 人（门槛 10 人）。', createdAt: Date.now() - 60 * 60000, read: false },
    { id: 'nt3', type: 'settlement_pigeon', gameId: 'pg1', pigeonRecordId: 'pr1', title: '结算结果：被记鸽 1 次', content: '你报名了昨日 19:30 的球局但未签到，已记鸽 1 次。如有特殊情况可向本场发起人申诉。', createdAt: settleTs('pg1') + 10 * 60000, read: true },
    { id: 'nt4', type: 'appeal_decision', gameId: 'pg4', pigeonRecordId: 'pr4', title: '申诉已驳回', content: '你对该场鸽记录的申诉已被发起人驳回：本场名单与现场确认均无到场记录。', createdAt: settleTs('pg4') + 3 * 60 * 60 * 1000, read: true },
    { id: 'nt5', type: 'redeem_success', gameId: 'pg5', pigeonRecordId: 'pr5', title: '已抵消 1 次鸽', content: '连续守约满 5 场，已抵消最早的 1 次鸽记录，鸽王等级已实时更新。', createdAt: daysAgoAt(1, 9, 0), read: true },
  ];

  return { users, games, signups, checkins, pigeonRecords, appeals, notifications };
}

let db = seedData();

function resetSeed() {
  db = seedData();
}

// ---------- 内部组装 ----------
function enrichSignup(s) {
  const user = db.users[s.userId] || { id: s.userId, nickname: s.userId, credit: rules.emptyCredit() };
  const credit = user.credit;
  const eff = rules.effectivePigeons(credit);
  return Object.assign({}, s, {
    nickname: user.nickname,
    effectivePigeons: eff,
    pigeon: rules.pigeonLevel(eff),
  });
}

function gameStats(game) {
  const list = db.signups.filter((s) => s.gameId === game.id);
  const checkinList = db.checkins.filter((c) => c.gameId === game.id);
  const confirmed = list.filter((s) => s.type === 'confirmed' && s.status !== 'cancelled' && !s.cancelledAt);
  const watching = list.filter((s) => s.type === 'watching' && s.status !== 'cancelled');
  const arrivedUserIds = new Set(checkinList.map((c) => c.userId));
  const arrived = checkinList
    .slice()
    .sort((a, b) => a.checkinAt - b.checkinAt)
    .map((c) => {
      const u = db.users[c.userId] || { nickname: c.userId, credit: rules.emptyCredit() };
      const eff = rules.effectivePigeons(u.credit);
      return Object.assign({}, c, { nickname: u.nickname, pigeon: rules.pigeonLevel(eff) });
    });
  return {
    confirmedCount: confirmed.length,
    watchingCount: watching.length,
    arrivedCount: arrivedUserIds.size,
    threshold: rules.formedThreshold(game.teamSize),
    formed: rules.isFormed(confirmed.length, game.teamSize),
    teams: rules.buildTeams(arrived, game.teamSize),
    arrived,
  };
}

function enrichGame(game) {
  const stats = gameStats(game);
  const organizer = db.users[game.organizerId];
  return Object.assign({}, game, {
    organizerNickname: organizer ? organizer.nickname : game.organizerId,
    stats,
  });
}

// ---------- 第三阶段内部组装：鸽记录 / 申诉 / 通知 ----------
function gameBrief(gameId) {
  const g = db.games.find((x) => x.id === gameId);
  if (!g) return null;
  const organizer = db.users[g.organizerId];
  return {
    id: g.id,
    organizerId: g.organizerId,
    organizerNickname: organizer ? organizer.nickname : g.organizerId,
    location: clone(g.location),
    startTime: g.startTime,
    teamSize: g.teamSize,
    status: g.status,
  };
}

function latestAppealOf(pigeonRecordId) {
  const list = db.appeals
    .filter((a) => a.pigeonRecordId === pigeonRecordId)
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt);
  return list[0] || null;
}

function enrichPigeonRecord(r) {
  const user = db.users[r.userId] || { nickname: r.userId };
  const appeal = latestAppealOf(r.id);
  return Object.assign({}, r, {
    nickname: user.nickname,
    game: gameBrief(r.gameId),
    appeal: appeal ? clone(appeal) : null,
  });
}

function enrichAppeal(a) {
  const user = db.users[a.userId] || { nickname: a.userId };
  const record = db.pigeonRecords.find((r) => r.id === a.pigeonRecordId) || null;
  return Object.assign({}, a, {
    nickname: user.nickname,
    recordStatus: record ? record.status : null,
    game: gameBrief(a.gameId),
  });
}

function enrichNotification(n) {
  return Object.assign({}, n, { game: n.gameId ? gameBrief(n.gameId) : null });
}

// ---------- 对外接口（均为 Promise，未来对应云函数同名方法） ----------

/** 球局列表（按开球时间升序） */
function listGames() {
  if (BACKEND === 'unicloud') return uniCall('listGames');
  const games = db.games
    .filter((g) => g.status !== 'cancelled')
    .slice()
    .sort((a, b) => a.startTime - b.startTime)
    .map(enrichGame);
  return Promise.resolve(clone(games));
}

/** 球局详情：球局 + 统计 + 名单 + 接波队列 */
function getGameDetail(gameId) {
  if (BACKEND === 'unicloud') return uniCall('getGameDetail', { gameId });
  const game = db.games.find((g) => g.id === gameId);
  if (!game) return Promise.resolve(null);
  const enriched = enrichGame(game);
  enriched.signupList = db.signups.filter((s) => s.gameId === gameId).map(enrichSignup);
  return Promise.resolve(clone(enriched));
}

/**
 * 发起球局：先走合并判定。
 * 命中合并 → { merged:true, target }，不新建，后来者由页面引导转报名；
 * 未命中 → 新建并把发起人自动记为第一个确定报名人，返回 { merged:false, game }。
 */
function createGame(data) {
  if (BACKEND === 'unicloud') {
    return uniCall('createGame', {
      location: data.location,
      startTime: data.startTime,
      teamSize: data.teamSize,
      note: data.note,
    });
  }
  const candidate = {
    location: data.location,
    startTime: data.startTime,
    teamSize: data.teamSize || 5,
  };
  const target = rules.findMergeTarget(candidate, db.games);
  if (target) {
    return Promise.resolve({ merged: true, target: clone(enrichGame(target)) });
  }
  const game = {
    id: nextId('g'),
    organizerId: data.organizerId || CURRENT_USER_ID,
    location: clone(data.location),
    startTime: data.startTime,
    teamSize: data.teamSize || 5,
    note: data.note || '',
    status: 'recruiting',
    fenceRadiusMeters: rules.MERGE_RADIUS_METERS,
    createdAt: Date.now(),
  };
  db.games.push(game);
  db.signups.push({
    id: nextId('s'),
    gameId: game.id,
    userId: game.organizerId,
    type: 'confirmed',
    status: 'confirmed',
    signedAt: Date.now(),
    cancelledAt: null,
  });
  return Promise.resolve({ merged: false, game: clone(enrichGame(game)) });
}

/** 报名（type: 'confirmed' | 'watching'）；同场重复报名返回已有记录 */
function signup(gameId, userId, type) {
  if (BACKEND === 'unicloud') return uniCall('signup', { gameId, type }); // 身份取会话 token，忽略 userId
  const uid = userId || CURRENT_USER_ID;
  const exist = db.signups.find((s) => s.gameId === gameId && s.userId === uid && s.status !== 'cancelled');
  if (exist) {
    exist.type = type || exist.type;
    exist.status = exist.type;
    return Promise.resolve(clone(enrichSignup(exist)));
  }
  const rec = {
    id: nextId('s'),
    gameId,
    userId: uid,
    type: type || 'confirmed',
    status: type || 'confirmed',
    signedAt: Date.now(),
    cancelledAt: null,
  };
  db.signups.push(rec);
  return Promise.resolve(clone(enrichSignup(rec)));
}

/** 取消报名：结算前任意时间取消均免鸽（规则在结算层保证） */
function cancelSignup(gameId, userId) {
  if (BACKEND === 'unicloud') return uniCall('cancelSignup', { gameId }); // 身份取会话 token，忽略 userId
  const uid = userId || CURRENT_USER_ID;
  const rec = db.signups.find((s) => s.gameId === gameId && s.userId === uid && s.status !== 'cancelled');
  if (rec) {
    rec.status = 'cancelled';
    rec.cancelledAt = Date.now();
  }
  return Promise.resolve({ ok: true });
}

/**
 * 签到：先由 rules.canCheckin 做围栏 + 时间窗判定，通过才落记录。
 * location: { latitude, longitude }；now 可注入便于测试/演示。
 */
function checkin(gameId, userId, location, now) {
  if (BACKEND === 'unicloud') {
    // 只上报原始经纬度，围栏距离由服务端复算，不传任何前端判定结果
    return uniCall('checkin', {
      gameId,
      latitude: location && location.latitude,
      longitude: location && location.longitude,
    });
  }
  const uid = userId || CURRENT_USER_ID;
  const game = db.games.find((g) => g.id === gameId);
  if (!game) return Promise.resolve({ ok: false, reason: 'no_game' });
  const verdict = rules.canCheckin(game, location, now == null ? Date.now() : now);
  if (!verdict.ok) return Promise.resolve({ ok: false, reason: verdict.reason, distance: verdict.distance });
  const dup = db.checkins.find((c) => c.gameId === gameId && c.userId === uid);
  if (dup) return Promise.resolve({ ok: true, reason: 'already', checkin: clone(dup) });
  const rec = {
    id: nextId('c'),
    gameId,
    userId: uid,
    checkinAt: now == null ? Date.now() : now,
    method: 'location',
  };
  db.checkins.push(rec);
  return Promise.resolve({ ok: true, reason: 'ok', checkin: clone(rec) });
}

/** 个人主页数据：出席、守约率（报名 <5 场显示新人）、信誉三数 */
function getUserProfile(userId) {
  if (BACKEND === 'unicloud') return uniCall('getUserProfile', { userId });
  const uid = userId || CURRENT_USER_ID;
  const user = db.users[uid];
  if (!user) return Promise.resolve(null);
  const credit = user.credit;
  const eff = rules.effectivePigeons(credit);
  const total = credit.totalConfirmedSignups;
  const attended = Math.max(0, total - (credit.historyPigeons - credit.revokedPigeons));
  const isNewcomer = total < 5;
  return Promise.resolve(
    clone({
      id: user.id,
      nickname: user.nickname,
      totalAttendance: credit.totalAttendance,
      totalConfirmedSignups: total,
      attendanceRate: isNewcomer ? null : Math.round((attended / total) * 100),
      isNewcomer,
      historyPigeons: credit.historyPigeons,
      redeemedPigeons: credit.redeemedPigeons,
      revokedPigeons: credit.revokedPigeons,
      effectivePigeons: eff,
      pigeon: rules.pigeonLevel(eff),
      streakProgress: credit.streakProgress,
      redeemRequired: rules.REDEEM_REQUIRED,
    })
  );
}

/** 我的鸽记录（带关联球局与最新申诉，个人主页申诉入口用） */
function listPigeonRecords(userId) {
  if (BACKEND === 'unicloud') return uniCall('listPigeonRecords');
  const uid = userId || CURRENT_USER_ID;
  const list = db.pigeonRecords
    .filter((r) => r.userId === uid)
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(enrichPigeonRecord);
  return Promise.resolve(clone(list));
}

/** 申诉页上下文：一条鸽记录 + 关联球局 + 最新申诉 */
function getAppealContext(pigeonRecordId) {
  if (BACKEND === 'unicloud') return uniCall('getAppealContext', { pigeonRecordId });
  const record = db.pigeonRecords.find((r) => r.id === pigeonRecordId);
  if (!record) return Promise.resolve(null);
  const enriched = enrichPigeonRecord(record);
  return Promise.resolve(
    clone({
      record: enriched,
      game: enriched.game,
      appeal: enriched.appeal,
    })
  );
}

/**
 * 提交申诉（与 uniCloud api.submitAppeal 同签名同错误码）：
 * 只能申诉自己名下、状态为 active 的鸽记录；已有待裁决申诉时拒绝重复提交。
 */
function submitAppeal(pigeonRecordId, reason) {
  if (BACKEND === 'unicloud') return uniCall('submitAppeal', { pigeonRecordId, reason });
  const record = db.pigeonRecords.find((r) => r.id === pigeonRecordId && r.userId === CURRENT_USER_ID);
  if (!record) return Promise.resolve({ ok: false, error: 'record_not_found' });
  if (record.status !== 'active') return Promise.resolve({ ok: false, error: 'record_not_active' });
  const pending = db.appeals.find((a) => a.pigeonRecordId === record.id && a.status === 'pending');
  if (pending) return Promise.resolve({ ok: false, error: 'appeal_pending' });
  const appeal = {
    id: nextId('ap'),
    pigeonRecordId: record.id,
    gameId: record.gameId,
    userId: CURRENT_USER_ID,
    reason: reason || '',
    status: 'pending',
    decidedBy: null,
    decidedAt: null,
    decisionNote: null,
    createdAt: Date.now(),
  };
  db.appeals.push(appeal);
  return Promise.resolve({ ok: true, appeal: clone(enrichAppeal(appeal)) });
}

/**
 * 申诉列表（与 uniCloud api.listAppeals 同口径）：
 * 传 gameId 且当前用户是该场发起人 → 本场全部申诉；否则 → 我自己的申诉。
 */
function listAppeals(gameId) {
  if (BACKEND === 'unicloud') return uniCall('listAppeals', { gameId });
  let list;
  const game = gameId ? db.games.find((g) => g.id === gameId) : null;
  if (game && game.organizerId === CURRENT_USER_ID) {
    list = db.appeals.filter((a) => a.gameId === gameId);
  } else {
    list = db.appeals.filter((a) => a.userId === CURRENT_USER_ID);
  }
  return Promise.resolve(clone(list.slice().sort((a, b) => b.createdAt - a.createdAt).map(enrichAppeal)));
}

/**
 * 裁决申诉（与 uniCloud api.resolveAppeal 同口径）：仅本场发起人可裁决；
 * 通过 → 走撤销留痕（记录置 revoked、信誉 revokedPigeons +1）；驳回只写裁决留痕。
 */
function resolveAppeal(appealId, approve, note) {
  if (BACKEND === 'unicloud') return uniCall('resolveAppeal', { appealId, approve: !!approve, note: note || '' });
  const appeal = db.appeals.find((a) => a.id === appealId);
  if (!appeal) return Promise.resolve({ ok: false, error: 'appeal_not_found' });
  const game = db.games.find((g) => g.id === appeal.gameId);
  if (!game) return Promise.resolve({ ok: false, error: 'game_not_found' });
  if (game.organizerId !== CURRENT_USER_ID) return Promise.resolve({ ok: false, error: 'forbidden' });
  if (appeal.status !== 'pending') return Promise.resolve({ ok: false, error: 'appeal_decided' });
  if (approve) {
    const revoked = revokePigeonMock(appeal.pigeonRecordId, note || appeal.reason);
    if (!revoked.ok) return revoked;
  }
  appeal.status = approve ? 'approved' : 'rejected';
  appeal.decidedBy = CURRENT_USER_ID;
  appeal.decidedAt = Date.now();
  appeal.decisionNote = note || '';
  return Promise.resolve({ ok: true });
}

function revokePigeonMock(pigeonRecordId, reason) {
  const record = db.pigeonRecords.find((r) => r.id === pigeonRecordId);
  if (!record) return { ok: false, error: 'record_not_found' };
  const game = db.games.find((g) => g.id === record.gameId);
  if (!game) return { ok: false, error: 'game_not_found' };
  if (game.organizerId !== CURRENT_USER_ID) return { ok: false, error: 'forbidden' };
  if (record.status !== 'active') return { ok: false, error: 'record_not_active' };
  record.status = 'revoked';
  record.revokedBy = CURRENT_USER_ID;
  record.revokedAt = Date.now();
  record.revokeReason = reason || '';
  const user = db.users[record.userId];
  if (user) user.credit.revokedPigeons += 1;
  return { ok: true, recordId: record.id, effectivePigeons: user ? rules.effectivePigeons(user.credit) : 0 };
}

/** 撤销一次鸽记录（发起人专属，与 uniCloud api.revokePigeon 同签名） */
function revokePigeon(pigeonRecordId, reason) {
  if (BACKEND === 'unicloud') return uniCall('revokePigeon', { pigeonRecordId, reason });
  return Promise.resolve(revokePigeonMock(pigeonRecordId, reason));
}

/**
 * 我的球局：我发起的 + 我报名的，按与当前时刻的关系分组。
 * group: 'active' 进行中（未开球/正在踢） | 'pendingSettlement' 待结算（踢完未到结算时刻） | 'ended' 已结束（已结算/已取消/已过结算时刻）
 * 每项带 relation（organizer/signup/both）、mySignup、pendingAppealCount（仅我发起的场统计待裁决申诉）。
 */
function listMyGames(userId) {
  if (BACKEND === 'unicloud') return uniCall('listMyGames');
  const uid = userId || CURRENT_USER_ID;
  const now = Date.now();
  const out = [];
  db.games.forEach((game) => {
    const isOrganizer = game.organizerId === uid;
    const mySignup = db.signups.find((s) => s.gameId === game.id && s.userId === uid && s.status !== 'cancelled') || null;
    if (!isOrganizer && !mySignup) return;
    let group;
    if (game.status === 'settled' || game.status === 'cancelled' || now >= rules.settleAtOf(game)) {
      group = 'ended';
    } else if (game.status === 'ended' || now >= game.startTime + rules.ASSUMED_SESSION_MS) {
      group = 'pendingSettlement';
    } else {
      group = 'active';
    }
    const enriched = enrichGame(game);
    enriched.relation = isOrganizer && mySignup ? 'both' : isOrganizer ? 'organizer' : 'signup';
    enriched.mySignup = mySignup ? { type: mySignup.type, status: mySignup.status, outcome: mySignup.outcome || null } : null;
    enriched.group = group;
    enriched.settleAt = rules.settleAtOf(game);
    enriched.pendingAppealCount = isOrganizer
      ? db.appeals.filter((a) => a.gameId === game.id && a.status === 'pending').length
      : 0;
    out.push(enriched);
  });
  const groupOrder = { active: 0, pendingSettlement: 1, ended: 2 };
  out.sort((a, b) => groupOrder[a.group] - groupOrder[b.group] || (a.group === 'ended' ? b.startTime - a.startTime : a.startTime - b.startTime));
  return Promise.resolve(clone(out));
}

/** 我的通知列表（通知落地页历史列表用，按时间倒序） */
function listNotifications() {
  if (BACKEND === 'unicloud') return uniCall('listNotifications');
  const list = db.notifications
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(enrichNotification);
  return Promise.resolve(clone(list));
}

function getCurrentUserId() {
  return CURRENT_USER_ID;
}

/** 演示用种子球场（页面发起表单默认值） */
function getSeedVenues() {
  return Promise.resolve(clone([VENUE_A, VENUE_B]));
}

module.exports = {
  BACKEND,
  UNICLOUD_API_URL,
  listGames,
  getGameDetail,
  createGame,
  signup,
  cancelSignup,
  checkin,
  getUserProfile,
  listPigeonRecords,
  getAppealContext,
  submitAppeal,
  listAppeals,
  resolveAppeal,
  revokePigeon,
  listMyGames,
  listNotifications,
  getCurrentUserId,
  getSeedVenues,
  resetSeed,
};
