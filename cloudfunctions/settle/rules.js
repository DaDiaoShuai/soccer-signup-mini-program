/**
 * rules.js —— 核心规则引擎（纯函数，无副作用，不依赖 wx API 和存储层）
 *
 * 所有数值均为已定版 PRD 口径，改动阈值前请先改 PRD：
 *  - 合并：同场（同地点或距离 ≤500 米）且与原局开球时间相差 ≤2 小时
 *  - 成局门槛：每队人数 × 2；报名与到场人数不设上限
 *  - 结算：开球时间 + 4 小时；结算前取消免鸽
 *  - 抵消：连续守约 5 场抵消最早 1 次鸽，中途再鸽进度清零
 */

// ---------- 定版常量 ----------
const MERGE_RADIUS_METERS = 500; // 同场判定 / 签到围栏默认半径（米）
const MERGE_WINDOW_MS = 2 * 60 * 60 * 1000; // 合并时间窗口：2 小时
const SETTLE_DELAY_MS = 4 * 60 * 60 * 1000; // 结算时刻 = 开球 + 4 小时
const CHECKIN_OPEN_BEFORE_MS = 1 * 60 * 60 * 1000; // 签到开启：开球前 1 小时
const REDEEM_REQUIRED = 5; // 连续守约抵消所需场数
const ASSUMED_SESSION_MS = 2 * 60 * 60 * 1000; // 冲突判定假定单场时长：2 小时

// ---------- 工具：时间归一化（接受毫秒数 / Date / ISO 字符串） ----------
function toMs(t) {
  if (t == null) return NaN;
  if (typeof t === 'number') return t;
  if (t instanceof Date) return t.getTime();
  const ms = Date.parse(t);
  return ms;
}

// ---------- 1. 距离：haversine（米） ----------
function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000; // 地球平均半径（米）
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** 取地点对象的经纬度（兼容 {latitude, longitude} 与 {lat, lng}） */
function pointOf(loc) {
  if (!loc) return null;
  const lat = loc.latitude != null ? loc.latitude : loc.lat;
  const lng = loc.longitude != null ? loc.longitude : loc.lng;
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;
  return { lat, lng };
}

/** 两地点是否同一球场：POI/名称相同，或距离 ≤ 半径 */
function isSameVenue(locA, locB, radiusMeters = MERGE_RADIUS_METERS) {
  if (!locA || !locB) return false;
  if (locA.poiId && locB.poiId && locA.poiId === locB.poiId) return true;
  if (locA.name && locB.name && locA.name === locB.name) return true;
  const a = pointOf(locA);
  const b = pointOf(locB);
  if (!a || !b) return false;
  return haversineMeters(a.lat, a.lng, b.lat, b.lng) <= radiusMeters;
}

// ---------- 2. 合并判定 ----------
/**
 * findMergeTarget(newGame, existingGames) -> 命中的原局对象 | null
 *
 * 规则：
 *  - 只考虑未取消、未结算的已有球局（它们都是“原局”）
 *  - 同一球场 且 |新局时间 - 原局官方开球时间| ≤ 2 小时 → 合并
 *  - 防连环合并：永远只跟原局的官方时间比。被合并的尝试不会生成新局，
 *    因此不存在以“被合并者时间”为锚点的链式合并。
 *  - 命中多个时取时间差最小的一个。
 */
function findMergeTarget(newGame, existingGames) {
  const newStart = toMs(newGame && newGame.startTime);
  if (Number.isNaN(newStart)) return null;
  let best = null;
  let bestDiff = Infinity;
  (existingGames || []).forEach((g) => {
    if (!g) return;
    if (g.status === 'cancelled' || g.status === 'settled') return;
    if (g.id && newGame.id && g.id === newGame.id) return;
    if (!isSameVenue(newGame.location, g.location)) return;
    const diff = Math.abs(newStart - toMs(g.startTime));
    if (diff <= MERGE_WINDOW_MS && diff < bestDiff) {
      best = g;
      bestDiff = diff;
    }
  });
  return best;
}

// ---------- 3. 成局门槛 ----------
function formedThreshold(teamSize) {
  return (teamSize || 0) * 2;
}

/** 已成局：确定报名人数（或到场人数）达到门槛 */
function isFormed(count, teamSize) {
  return count >= formedThreshold(teamSize);
}

// ---------- 4. 接波组队 ----------
/**
 * buildTeams(arrived, teamSize)
 * arrived: 已签到人员数组，元素可带 checkinAt/checkedAt/arrivalAt 时间戳；
 *          内部按签到时间升序排序（先到先踢），无时间戳时保持原顺序。
 * 返回：
 *  {
 *    teamSize, total, fullTeamCount,
 *    teams: [{ index, members, size, isFull, status: 'playing'|'waiting'|'forming', needed }],
 *    playingTeams, waitingTeams, formingTeam, neededForNextTeam
 *  }
 * status 说明：满员队中前两队为 playing（正在踢），其余满员队 waiting（等候接波），
 *              未满的最后一队为 forming（组队中）。
 */
function buildTeams(arrived, teamSize) {
  const size = teamSize || 5;
  const sorted = (arrived || []).slice().sort((a, b) => {
    const ta = toMs(a && (a.checkinAt != null ? a.checkinAt : a.checkedAt != null ? a.checkedAt : a.arrivalAt));
    const tb = toMs(b && (b.checkinAt != null ? b.checkinAt : b.checkedAt != null ? b.checkedAt : b.arrivalAt));
    if (Number.isNaN(ta) || Number.isNaN(tb)) return 0;
    return ta - tb;
  });

  const chunks = [];
  for (let i = 0; i < sorted.length; i += size) {
    chunks.push(sorted.slice(i, i + size));
  }
  const fullTeamCount = chunks.filter((c) => c.length === size).length;

  const teams = chunks.map((members, idx) => {
    const isFull = members.length === size;
    let status;
    if (!isFull) status = 'forming';
    else if (fullTeamCount >= 2 && idx < 2) status = 'playing';
    else status = 'waiting';
    return {
      index: idx + 1,
      members,
      size: members.length,
      isFull,
      status,
      needed: isFull ? 0 : size - members.length,
    };
  });

  const formingTeam = teams.find((t) => t.status === 'forming') || null;
  return {
    teamSize: size,
    total: sorted.length,
    fullTeamCount,
    teams,
    playingTeams: teams.filter((t) => t.status === 'playing'),
    waitingTeams: teams.filter((t) => t.status === 'waiting'),
    formingTeam,
    // 下一队还差几人：有组队中的队看它缺口；否则还差一整队
    neededForNextTeam: formingTeam ? formingTeam.needed : size,
  };
}

// ---------- 5. 签到判定 ----------
/**
 * canCheckin(game, userLocation, now) -> { ok, reason, distance }
 * reason: 'ok' | 'too_far' | 'too_early' | 'closed' | 'cancelled' | 'no_location'
 * 规则：围栏内（默认 500 米）+ 开球前 1 小时 ~ 开球后 4 小时（结算时刻）之间。
 */
function canCheckin(game, userLocation, now) {
  if (!game) return { ok: false, reason: 'no_game', distance: null };
  if (game.status === 'cancelled') return { ok: false, reason: 'cancelled', distance: null };
  const venue = pointOf(game.location);
  const user = pointOf(userLocation);
  if (!venue || !user) return { ok: false, reason: 'no_location', distance: null };
  const distance = haversineMeters(venue.lat, venue.lng, user.lat, user.lng);
  const radius = game.fenceRadiusMeters || MERGE_RADIUS_METERS;
  if (distance > radius) return { ok: false, reason: 'too_far', distance };

  const start = toMs(game.startTime);
  const t = now == null ? Date.now() : toMs(now);
  if (t < start - CHECKIN_OPEN_BEFORE_MS) return { ok: false, reason: 'too_early', distance };
  if (t > start + SETTLE_DELAY_MS) return { ok: false, reason: 'closed', distance };
  return { ok: true, reason: 'ok', distance };
}

/** 仅判断是否在围栏内（不看时间窗） */
function isWithinFence(game, userLocation) {
  const venue = pointOf(game && game.location);
  const user = pointOf(userLocation);
  if (!venue || !user) return false;
  const radius = (game && game.fenceRadiusMeters) || MERGE_RADIUS_METERS;
  return haversineMeters(venue.lat, venue.lng, user.lat, user.lng) <= radius;
}

// ---------- 6. 报名时间冲突判定 ----------
/**
 * findSignupConflict(userGames, newGame, sessionMs)
 * userGames：该用户已确定报名且未取消的球局数组。
 * 两场开球时间间隔小于假定单场时长（默认 2 小时）视为同时段冲突。
 * 返回冲突的球局或 null。
 */
function findSignupConflict(userGames, newGame, sessionMs = ASSUMED_SESSION_MS) {
  const newStart = toMs(newGame && newGame.startTime);
  if (Number.isNaN(newStart)) return null;
  return (
    (userGames || []).find((g) => {
      if (!g || g.status === 'cancelled' || g.status === 'settled') return false;
      if (g.id && newGame.id && g.id === newGame.id) return false;
      return Math.abs(toMs(g.startTime) - newStart) < sessionMs;
    }) || null
  );
}

// ---------- 7. 鸽王等级与有效鸽 ----------
function emptyCredit() {
  return {
    historyPigeons: 0, // 历史鸽总次数
    redeemedPigeons: 0, // 已抵消次数
    revokedPigeons: 0, // 已被发起人撤销次数
    streakProgress: 0, // 连续守约进度 0~4（满 5 触发抵消后清零）
    totalAttendance: 0, // 总出席（含空降）
    totalConfirmedSignups: 0, // 累计确定报名次数（算守约率用）
  };
}

/** 有效鸽 = 历史鸽 - 已抵消 - 已撤销，最低 0 */
function effectivePigeons(credit) {
  const c = Object.assign(emptyCredit(), credit || {});
  return Math.max(0, c.historyPigeons - c.redeemedPigeons - c.revokedPigeons);
}

/**
 * pigeonLevel(effectiveCount) -> { level, label }
 * 0 无标签 / 1 一级鸽王 / 2-3 二级鸽王 / 4-6 三级鸽王 / 7+ 鸽帝
 */
function pigeonLevel(count) {
  const n = typeof count === 'object' && count !== null ? effectivePigeons(count) : count || 0;
  if (n <= 0) return { level: 0, label: '' };
  if (n === 1) return { level: 1, label: '一级鸽王' };
  if (n <= 3) return { level: 2, label: '二级鸽王' };
  if (n <= 6) return { level: 3, label: '三级鸽王' };
  return { level: 4, label: '鸽帝' };
}

// ---------- 8. 守约进度与抵消 ----------
/**
 * applyAttendance(credit, outcome) -> 新 credit（不修改入参）
 * outcome:
 *  - 'attended' 守约到场（确定报名 + 签到）：出席+1，进度+1；进度满 5 且有有效鸽时
 *               抵消最早 1 次（redeemed+1），进度清零重攒；无有效鸽时进度满 5 也清零。
 *  - 'pigeon'   记鸽：历史鸽+1，进度清零。
 *  - 'walkin'   空降到场：仅总出席+1，不计抵消进度。
 *  - 'exempt' / 'cancelled' / 'watching'：免记，无任何变化。
 */
function applyAttendance(credit, outcome) {
  const next = Object.assign(emptyCredit(), credit || {});
  switch (outcome) {
    case 'attended': {
      next.totalAttendance += 1;
      next.streakProgress += 1;
      if (next.streakProgress >= REDEEM_REQUIRED) {
        if (effectivePigeons(next) > 0) next.redeemedPigeons += 1;
        next.streakProgress = 0;
      }
      break;
    }
    case 'pigeon': {
      next.historyPigeons += 1;
      next.streakProgress = 0;
      break;
    }
    case 'walkin': {
      next.totalAttendance += 1;
      break;
    }
    default:
      break; // exempt 等：无变化
  }
  return next;
}

// ---------- 9. 结算 ----------
/** 结算时刻（毫秒）= 开球 + 4 小时 */
function settleAtOf(game) {
  return toMs(game && game.startTime) + SETTLE_DELAY_MS;
}

function signupTypeOf(s) {
  // 报名类型：type/status 任一处标 watching 都算观望
  if (!s) return 'confirmed';
  if (s.type === 'watching' || s.status === 'watching') return 'watching';
  return 'confirmed';
}
function isCancelledSignup(s) {
  return !!s && (s.status === 'cancelled' || s.cancelledAt != null);
}

/**
 * settleGame(game, signups, checkins, creditsByUserId, now)
 * 输入：球局、本场报名记录、本场签到记录、各用户当前信誉、当前时间（可省略，省略视为已到期）
 * 输出：
 *  - 未到结算时刻：{ settled:false, reason:'before_settle_time'|'game_cancelled', settleAt, results:[] }
 *    注意：发起人取消整场时 settled 同样为 false —— 全员免鸽，由 results 给出逐人免记结论。
 *    为方便调用方区分，这里取消整场返回 { settled:false, cancelled:true, results:[全员 exempt] }。
 *  - 正常结算：{ settled:true, settleAt, gameId, results, credits }
 *    results: [{ userId, outcome:'attended'|'pigeon'|'exempt'|'walkin', label:'守约'|'鸽'|'免记'|'空降到场' }]
 *    credits: 结算后的信誉 map（新对象）
 * 规则要点：
 *  - 发起人提前结束（status='ended'）不影响结算时刻，照常按开球+4h 判定；
 *  - 任何人都不能手动记鸽，本函数是唯一产鸽入口；撤销走独立的 revoke 流程（留痕），不在这里。
 */
function settleGame(game, signups, checkins, creditsByUserId, now) {
  const settleAt = settleAtOf(game);
  const creditsIn = creditsByUserId || {};
  const checkinUserIds = new Set((checkins || []).map((c) => c.userId));
  const signupUserIds = new Set((signups || []).map((s) => s.userId));

  const buildCredit = (userId, outcome) => {
    const base = Object.assign(emptyCredit(), creditsIn[userId] || {});
    // 守约率分母：本场真正履约判定的确定报名（守约/记鸽各 +1，取消与观望不计）
    if (outcome === 'attended' || outcome === 'pigeon') {
      base.totalConfirmedSignups += 1;
    }
    return applyAttendance(base, outcome);
  };

  // —— 发起人取消整场：全员免鸽 ——
  if (game.status === 'cancelled') {
    const results = (signups || []).map((s) => ({
      userId: s.userId,
      outcome: 'exempt',
      label: '免记',
    }));
    const credits = {};
    results.forEach((r) => { credits[r.userId] = buildCredit(r.userId, 'exempt'); });
    return { settled: false, cancelled: true, reason: 'game_cancelled', settleAt, gameId: game.id, results, credits };
  }

  // —— 未到结算时刻（含发起人提前结束的情况） ——
  if (now != null && toMs(now) < settleAt) {
    return { settled: false, reason: 'before_settle_time', settleAt, gameId: game.id, results: [], credits: Object.assign({}, creditsIn) };
  }

  const results = [];
  (signups || []).forEach((s) => {
    if (signupTypeOf(s) === 'watching') {
      results.push({ userId: s.userId, outcome: 'exempt', label: '免记' }); // 观望不担鸽责
    } else if (isCancelledSignup(s)) {
      results.push({ userId: s.userId, outcome: 'exempt', label: '免记' }); // 结算前取消免鸽
    } else if (checkinUserIds.has(s.userId)) {
      results.push({ userId: s.userId, outcome: 'attended', label: '守约' });
    } else {
      results.push({ userId: s.userId, outcome: 'pigeon', label: '鸽' }); // 报名+未取消+从未签到
    }
  });
  // 空降者：有签到、无报名 —— 只记出席
  (checkins || []).forEach((c) => {
    if (!signupUserIds.has(c.userId)) {
      results.push({ userId: c.userId, outcome: 'walkin', label: '空降到场' });
    }
  });

  const credits = {};
  results.forEach((r) => { credits[r.userId] = buildCredit(r.userId, r.outcome); });
  return { settled: true, settleAt, gameId: game.id, results, credits };
}

// ---------- 10. 重叠场次签到归属 ----------
/**
 * resolveCheckinTarget(userId, candidateGames, userSignups, now)
 * 同一球场重叠场次的签到归属：
 *  - 已报名者 → 签入其确定报名的那场（多场命中取开球时间最近的一场）
 *  - 空降者 → 默认签入最新开球（startTime 最大且已开球）的一场；都未开球取最早一场
 * 候选场次应已通过 canCheckin 的围栏/时间过滤，或至少同场未取消。
 */
function resolveCheckinTarget(userId, candidateGames, userSignups, now) {
  const games = (candidateGames || []).filter((g) => g && g.status !== 'cancelled');
  if (!games.length) return null;
  const t = now == null ? Date.now() : toMs(now);

  const myConfirmedGameIds = new Set(
    (userSignups || [])
      .filter((s) => s.userId === userId && signupTypeOf(s) === 'confirmed' && !isCancelledSignup(s))
      .map((s) => s.gameId)
  );
  const mine = games.filter((g) => myConfirmedGameIds.has(g.id));
  if (mine.length) {
    mine.sort((a, b) => Math.abs(toMs(a.startTime) - t) - Math.abs(toMs(b.startTime) - t));
    return mine[0];
  }
  const started = games.filter((g) => toMs(g.startTime) <= t);
  if (started.length) {
    started.sort((a, b) => toMs(b.startTime) - toMs(a.startTime));
    return started[0]; // 最新开球
  }
  games.sort((a, b) => toMs(a.startTime) - toMs(b.startTime));
  return games[0];
}

module.exports = {
  MERGE_RADIUS_METERS,
  MERGE_WINDOW_MS,
  SETTLE_DELAY_MS,
  CHECKIN_OPEN_BEFORE_MS,
  REDEEM_REQUIRED,
  ASSUMED_SESSION_MS,
  toMs,
  haversineMeters,
  isSameVenue,
  findMergeTarget,
  formedThreshold,
  isFormed,
  buildTeams,
  canCheckin,
  isWithinFence,
  findSignupConflict,
  emptyCredit,
  effectivePigeons,
  pigeonLevel,
  applyAttendance,
  settleAtOf,
  settleGame,
  resolveCheckinTarget,
};
