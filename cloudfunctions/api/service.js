/**
 * service.js —— api 云函数的业务服务层（不直接依赖 wx-server-sdk，可本地单测）
 *
 * 约定：
 *  - 用户身份一律用云函数上下文传入的 OPENID（见 index.js），
 *    本层任何方法都不信任前端传入的 user_id；需要操作他人数据的动作
 *    （代签）只能由本场发起人发起，且目标用户只是数据字段、不是身份。
 *  - 方法名与入参/出参结构与 miniprogram/utils/store.js 保持一致，
 *    store 的 USE_CLOUD 开关打开后页面层零改动。
 *  - 业务判定一律调用同目录 rules.js —— 它是 miniprogram/utils/rules.js
 *    的逐字副本（同步方式见 cloudfunctions/SHARED_RULES.md），口径唯一。
 *  - 安全红线：本层不提供任何「手动记鸽」入口。鸽记录只能由 settle
 *    云函数在结算时产生；这里只能由发起人撤销（且必须留痕）。
 */

const rules = require('./rules');

function clone(obj) {
  return obj == null ? obj : JSON.parse(JSON.stringify(obj));
}

/**
 * createApi({ db, now })
 * db：cloudDb.js 适配层（云端）或内存 stub（本地测试），接口见 cloudDb.js。
 * now：() => ms，便于测试注入固定时间。
 */
function createApi({ db, now }) {
  const nowMs = typeof now === 'function' ? now : () => Date.now();

  // ---------- 用户 ----------
  async function ensureUser(openid, nickname) {
    let user = await db.getUser(openid);
    if (!user) {
      user = await db.insertUser({
        id: openid,
        openid,
        nickname: nickname || '',
        avatarUrl: '',
        credit: rules.emptyCredit(),
        createdAt: nowMs(),
        updatedAt: nowMs(),
      });
    }
    return user;
  }

  async function usersById(userIds) {
    const map = {};
    const ids = Array.from(new Set(userIds || []));
    for (const id of ids) {
      const u = await db.getUser(id);
      map[id] = u || { id, nickname: id, credit: rules.emptyCredit() };
    }
    return map;
  }

  function profileOf(user) {
    const credit = Object.assign(rules.emptyCredit(), user.credit || {});
    const eff = rules.effectivePigeons(credit);
    const total = credit.totalConfirmedSignups;
    const attended = Math.max(0, total - (credit.historyPigeons - credit.revokedPigeons));
    const isNewcomer = total < 5; // 报名不足 5 场显示「新人」，与 mock 口径一致
    return {
      id: user.id,
      nickname: user.nickname || '',
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
    };
  }

  // ---------- 球局组装（与 store.gameStats 同口径） ----------
  async function enrichGame(game) {
    const signups = await db.listSignups({ gameId: game.id });
    const checkins = await db.listCheckins({ gameId: game.id });
    const userIds = signups.map((s) => s.userId).concat(checkins.map((c) => c.userId), [game.organizerId]);
    const users = await usersById(userIds);

    const confirmed = signups.filter((s) => s.type === 'confirmed' && s.status !== 'cancelled' && !s.cancelledAt);
    const watching = signups.filter((s) => s.type === 'watching' && s.status !== 'cancelled');
    const arrived = checkins
      .slice()
      .sort((a, b) => a.checkinAt - b.checkinAt)
      .map((c) => {
        const u = users[c.userId];
        const eff = rules.effectivePigeons(u.credit);
        return Object.assign({}, c, { nickname: u.nickname, pigeon: rules.pigeonLevel(eff) });
      });

    const organizer = users[game.organizerId];
    return Object.assign({}, game, {
      organizerNickname: organizer ? organizer.nickname : game.organizerId,
      stats: {
        confirmedCount: confirmed.length,
        watchingCount: watching.length,
        arrivedCount: new Set(checkins.map((c) => c.userId)).size,
        threshold: rules.formedThreshold(game.teamSize),
        formed: rules.isFormed(confirmed.length, game.teamSize),
        teams: rules.buildTeams(arrived, game.teamSize),
        arrived,
      },
      _signups: signups, // 内部字段，detail 组装用，出参前剔除
      _users: users,
    });
  }

  function stripInternal(enriched) {
    const out = Object.assign({}, enriched);
    delete out._signups;
    delete out._users;
    return out;
  }

  function enrichSignup(s, users) {
    const user = users[s.userId] || { nickname: s.userId, credit: rules.emptyCredit() };
    const eff = rules.effectivePigeons(user.credit);
    return Object.assign({}, s, {
      nickname: user.nickname,
      effectivePigeons: eff,
      pigeon: rules.pigeonLevel(eff),
    });
  }

  async function findActiveSignup(gameId, userId) {
    const list = await db.listSignups({ gameId, userId });
    return list.find((s) => s.status !== 'cancelled') || null;
  }

  async function isOrganizer(game, openid) {
    return !!game && game.organizerId === openid;
  }

  // ---------- 与 store 同名同签名的方法 ----------

  async function listGames() {
    const games = (await db.listGames())
      .filter((g) => g.status !== 'cancelled')
      .sort((a, b) => a.startTime - b.startTime);
    const out = [];
    for (const g of games) out.push(stripInternal(await enrichGame(g)));
    return clone(out);
  }

  async function getGameDetail(gameId) {
    const game = await db.getGame(gameId);
    if (!game) return null;
    const enriched = await enrichGame(game);
    enriched.signupList = enriched._signups.map((s) => enrichSignup(s, enriched._users));
    return clone(stripInternal(enriched));
  }

  /**
   * 发起球局：合并查重在服务端做（查全库未取消/未结算球局）。
   * 命中 → { merged:true, target }，不新建、也不静默替后来者报名；
   * 未命中 → 新建，发起人（OPENID）自动成为第一个确定报名人。
   */
  async function createGame(openid, data) {
    await ensureUser(openid, data.nickname);
    const candidate = {
      location: data.location,
      startTime: data.startTime,
      teamSize: data.teamSize || 5,
    };
    const target = rules.findMergeTarget(candidate, await db.listGames());
    if (target) {
      return { merged: true, target: clone(stripInternal(await enrichGame(target))) };
    }
    const game = await db.insertGame({
      organizerId: openid,
      location: clone(data.location),
      startTime: data.startTime,
      teamSize: data.teamSize || 5,
      note: data.note || '',
      status: 'recruiting',
      settled: false,
      settledAt: null,
      fenceRadiusMeters: rules.MERGE_RADIUS_METERS,
      createdAt: nowMs(),
      updatedAt: nowMs(),
    });
    await db.insertSignup({
      gameId: game.id,
      userId: openid,
      type: 'confirmed',
      status: 'confirmed',
      signedAt: nowMs(),
      cancelledAt: null,
      outcome: null,
      settledAt: null,
    });
    return { merged: false, game: clone(stripInternal(await enrichGame(game))) };
  }

  /** 报名；同场已有未取消记录则改类型，已取消的记录直接复活（配合 gameId+userId 唯一索引） */
  async function signup(openid, gameId, type) {
    const game = await db.getGame(gameId);
    if (!game) return { ok: false, error: 'game_not_found' };
    if (game.status === 'cancelled' || game.status === 'settled') return { ok: false, error: 'game_closed' };
    await ensureUser(openid);
    const t = type || 'confirmed';
    const existing = await db.listSignups({ gameId, userId: openid });
    let rec = existing.find((s) => s.status !== 'cancelled');
    if (rec) {
      await db.updateSignup(rec.id, { type: t, status: t, updatedAt: nowMs() });
      rec = Object.assign({}, rec, { type: t, status: t });
    } else if (existing.length) {
      rec = existing[0];
      await db.updateSignup(rec.id, {
        type: t, status: t, cancelledAt: null, signedAt: nowMs(), outcome: null, settledAt: null, updatedAt: nowMs(),
      });
      rec = Object.assign({}, rec, { type: t, status: t, cancelledAt: null });
    } else {
      rec = await db.insertSignup({
        gameId, userId: openid, type: t, status: t,
        signedAt: nowMs(), cancelledAt: null, outcome: null, settledAt: null,
      });
    }
    const users = await usersById([openid]);
    return clone(enrichSignup(rec, users));
  }

  /** 取消报名：结算前任意时间取消均免鸽（免鸽结论在结算层产生） */
  async function cancelSignup(openid, gameId) {
    const rec = await findActiveSignup(gameId, openid);
    if (rec) {
      await db.updateSignup(rec.id, { status: 'cancelled', cancelledAt: nowMs(), updatedAt: nowMs() });
    }
    return { ok: true };
  }

  /**
   * 签到：围栏距离在服务端用「上报经纬度 vs 球局坐标」复算（rules.canCheckin），
   * 绝不采信前端算好的布尔值。不带 gameId 时按重叠场次归属规则选场：
   * 已报名者签入其报名场次，空降者签入最新开球场次。
   */
  async function checkin(openid, data) {
    const loc = {
      latitude: data.latitude != null ? data.latitude : data.location && data.location.latitude,
      longitude: data.longitude != null ? data.longitude : data.location && data.location.longitude,
    };
    let game = null;
    if (data.gameId) {
      game = await db.getGame(data.gameId);
      if (!game) return { ok: false, reason: 'no_game' };
    } else {
      const games = await db.listGames();
      const t = nowMs();
      const candidates = games.filter((g) => rules.canCheckin(g, loc, t).ok);
      const mySignups = await db.listSignups({ userId: openid });
      game = rules.resolveCheckinTarget(openid, candidates, mySignups, t);
      if (!game) return { ok: false, reason: 'no_game_nearby' };
    }
    const verdict = rules.canCheckin(game, loc, nowMs());
    if (!verdict.ok) return { ok: false, reason: verdict.reason, distance: verdict.distance };
    const existing = await db.listCheckins({ gameId: game.id, userId: openid });
    if (existing.length) return { ok: true, reason: 'already', checkin: clone(existing[0]) };
    const rec = await db.insertCheckin({
      gameId: game.id,
      userId: openid,
      checkinAt: nowMs(),
      method: 'location',
      verifiedDistance: Math.round(verdict.distance), // 服务端复算的距离，留作校验结果
      location: loc,
      proxyBy: null,
      proxyAt: null,
      proxyReason: null,
      settledAt: null,
    });
    return { ok: true, reason: 'ok', checkin: clone(rec) };
  }

  /**
   * 个人主页。userId 缺省或查不到时回退到调用者本人
   * （第一阶段 mock 的演示 ID 在云端不存在，避免页面空白）；
   * 查他人时返回的也是公开信誉档案（与名单里可见的标签口径一致）。
   */
  async function getUserProfile(openid, userId) {
    let user = userId ? await db.getUser(userId) : null;
    if (!user) user = await ensureUser(openid);
    return clone(profileOf(user));
  }

  // ---------- 发起人管理动作（全部校验调用者是本场发起人） ----------

  /** 改球局：签到开启（开球前 1 小时）后时间/地点锁定，只能改备注等非关键字段 */
  async function updateGame(openid, gameId, patch) {
    const game = await db.getGame(gameId);
    if (!game) return { ok: false, error: 'game_not_found' };
    if (!(await isOrganizer(game, openid))) return { ok: false, error: 'forbidden' };
    if (game.status === 'cancelled' || game.status === 'settled') return { ok: false, error: 'game_closed' };
    const touchesKeyField = patch.startTime != null || patch.location != null;
    if (touchesKeyField && nowMs() >= game.startTime - rules.CHECKIN_OPEN_BEFORE_MS) {
      return { ok: false, error: 'locked', message: '签到已开启，时间与地点锁定' };
    }
    const allowed = {};
    ['startTime', 'location', 'teamSize', 'note'].forEach((k) => {
      if (patch[k] !== undefined) allowed[k] = patch[k];
    });
    allowed.updatedAt = nowMs();
    await db.updateGame(gameId, allowed);
    return { ok: true, game: clone(stripInternal(await enrichGame(Object.assign({}, game, allowed)))) };
  }

  /** 取消整场：全员免鸽（结算层对 cancelled 球局不产鸽） */
  async function cancelGame(openid, gameId) {
    const game = await db.getGame(gameId);
    if (!game) return { ok: false, error: 'game_not_found' };
    if (!(await isOrganizer(game, openid))) return { ok: false, error: 'forbidden' };
    await db.updateGame(gameId, { status: 'cancelled', cancelledAt: nowMs(), updatedAt: nowMs() });
    return { ok: true };
  }

  /** 提前结束：只关入口，不提前结算（结算时刻仍为开球 +4 小时，见 settle） */
  async function endGame(openid, gameId) {
    const game = await db.getGame(gameId);
    if (!game) return { ok: false, error: 'game_not_found' };
    if (!(await isOrganizer(game, openid))) return { ok: false, error: 'forbidden' };
    await db.updateGame(gameId, { status: 'ended', endedAt: nowMs(), updatedAt: nowMs() });
    return { ok: true };
  }

  /**
   * 发起人代签：目标用户手机没电/定位异常时的兜底。
   * 必须留痕：proxyBy（发起人）、proxyAt、proxyReason 都会写进签到记录。
   */
  async function proxyCheckin(openid, gameId, targetUserId, reason) {
    const game = await db.getGame(gameId);
    if (!game) return { ok: false, error: 'game_not_found' };
    if (!(await isOrganizer(game, openid))) return { ok: false, error: 'forbidden' };
    if (!targetUserId) return { ok: false, error: 'target_required' };
    const existing = await db.listCheckins({ gameId, userId: targetUserId });
    if (existing.length) return { ok: true, reason: 'already', checkin: clone(existing[0]) };
    const rec = await db.insertCheckin({
      gameId,
      userId: targetUserId,
      checkinAt: nowMs(),
      method: 'proxy',
      verifiedDistance: null, // 代签无定位校验，靠留痕与发起人信誉兜底
      location: null,
      proxyBy: openid,
      proxyAt: nowMs(),
      proxyReason: reason || '',
      settledAt: null,
    });
    return { ok: true, reason: 'ok', checkin: clone(rec) };
  }

  // ---------- 申诉与撤销（发起人只有撤销权，没有定罪权） ----------

  /** 被记鸽者向本场发起人申诉：只能申诉自己名下、状态为 active 的鸽记录 */
  async function submitAppeal(openid, data) {
    let record = null;
    if (data.pigeonRecordId) {
      const list = await db.listPigeonRecords({ userId: openid });
      record = list.find((r) => r.id === data.pigeonRecordId) || null;
    } else if (data.gameId) {
      const list = await db.listPigeonRecords({ gameId: data.gameId, userId: openid });
      record = list[0] || null;
    }
    if (!record) return { ok: false, error: 'record_not_found' };
    if (record.status !== 'active') return { ok: false, error: 'record_not_active' };
    const pending = await db.listAppeals({ pigeonRecordId: record.id, status: 'pending' });
    if (pending.length) return { ok: false, error: 'appeal_pending' };
    const appeal = await db.insertAppeal({
      pigeonRecordId: record.id,
      gameId: record.gameId,
      userId: openid,
      reason: data.reason || '',
      status: 'pending',
      decidedBy: null,
      decidedAt: null,
      decisionNote: null,
      createdAt: nowMs(),
    });
    return { ok: true, appeal: clone(appeal) };
  }

  /** 申诉列表：本人看自己的，发起人看本场的 */
  async function listAppeals(openid, gameId) {
    if (gameId) {
      const game = await db.getGame(gameId);
      if (game && (await isOrganizer(game, openid))) {
        return clone(await db.listAppeals({ gameId }));
      }
    }
    return clone(await db.listAppeals({ userId: openid }));
  }

  /**
   * 撤销一次鸽记录（发起人专属）：记录状态置 revoked 并写留痕
   * （revokedBy / revokedAt / revokeReason），同时用户信誉 revokedPigeons +1，
   * 有效鸽随之下降。已抵消/已撤销的记录不能再撤销，避免重复扣减。
   */
  async function revokePigeon(openid, pigeonRecordId, reason) {
    const all = await db.listPigeonRecords({});
    const record = all.find((r) => r.id === pigeonRecordId) || null;
    if (!record) return { ok: false, error: 'record_not_found' };
    const game = await db.getGame(record.gameId);
    if (!game) return { ok: false, error: 'game_not_found' };
    if (!(await isOrganizer(game, openid))) return { ok: false, error: 'forbidden' };
    if (record.status !== 'active') return { ok: false, error: 'record_not_active' };
    await db.updatePigeonRecord(record.id, {
      status: 'revoked',
      revokedBy: openid,
      revokedAt: nowMs(),
      revokeReason: reason || '',
    });
    const user = await ensureUser(record.userId);
    const credit = Object.assign(rules.emptyCredit(), user.credit || {});
    credit.revokedPigeons += 1;
    await db.updateUser(record.userId, { credit, updatedAt: nowMs() });
    return { ok: true, recordId: record.id, effectivePigeons: rules.effectivePigeons(credit) };
  }

  /** 裁决申诉：通过 = 走撤销流程；驳回只写裁决留痕，不动鸽记录 */
  async function resolveAppeal(openid, appealId, decision) {
    const appeal = await db.getAppeal(appealId);
    if (!appeal) return { ok: false, error: 'appeal_not_found' };
    const game = await db.getGame(appeal.gameId);
    if (!game) return { ok: false, error: 'game_not_found' };
    if (!(await isOrganizer(game, openid))) return { ok: false, error: 'forbidden' };
    if (appeal.status !== 'pending') return { ok: false, error: 'appeal_decided' };
    if (decision && decision.approve) {
      const revoked = await revokePigeon(openid, appeal.pigeonRecordId, (decision && decision.note) || appeal.reason);
      if (!revoked.ok) return revoked;
    }
    await db.updateAppeal(appealId, {
      status: decision && decision.approve ? 'approved' : 'rejected',
      decidedBy: openid,
      decidedAt: nowMs(),
      decisionNote: (decision && decision.note) || '',
    });
    return { ok: true };
  }

  return {
    listGames,
    getGameDetail,
    createGame,
    signup,
    cancelSignup,
    checkin,
    getUserProfile,
    updateGame,
    cancelGame,
    endGame,
    proxyCheckin,
    submitAppeal,
    listAppeals,
    resolveAppeal,
    revokePigeon,
  };
}

module.exports = createApi;
