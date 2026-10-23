/**
 * service.js —— settle 云函数的结算服务层（不直接依赖 wx-server-sdk，可本地单测）
 *
 * 由定时触发器周期调用（见 config.json，每 5 分钟一次），职责：
 *  扫描「已到结算时刻（开球 +4 小时）且未结算」的球局，逐场调用 rules.settleGame
 *  产生结论（守约 / 鸽 / 免记 / 空降），把鸽记录与信誉变更落库。
 *
 * 结算口径唯一来源：同目录 rules.js —— miniprogram/utils/rules.js 的逐字副本
 * （同步方式见 cloudfunctions/SHARED_RULES.md）。本层不另写任何判定数值。
 *
 * 幂等设计（重复执行同一球局绝不重复记账），三道保险：
 *  1. 球局级：games.settled 标记，结算完成后置 true，扫描时直接跳过；
 *  2. 记录级：pigeon_records 以 gameId+userId 为唯一键，写鸽前先查存在性，
 *     已有记录则视为该用户的记鸽已落账，跳过其信誉变更；
 *  3. 进度级：每条 signup 落 outcome/settledAt、每条空降 checkin 落 settledAt，
 *     中途失败重跑时只补未落账的用户，已落账者信誉原样保留。
 */

const rules = require('./rules');

function createSettle({ db, now }) {
  const nowMs = typeof now === 'function' ? now : () => Date.now();

  async function settleOneGame(game, t) {
    const signups = await db.listSignups({ gameId: game.id });
    const checkins = await db.listCheckins({ gameId: game.id });

    const userIds = Array.from(
      new Set(signups.map((s) => s.userId).concat(checkins.map((c) => c.userId)))
    );
    const creditsIn = {};
    const usersIn = {};
    for (const uid of userIds) {
      const u = await db.getUser(uid);
      usersIn[uid] = u;
      creditsIn[uid] = Object.assign(rules.emptyCredit(), (u && u.credit) || {});
    }

    const outcome = rules.settleGame(game, signups, checkins, creditsIn, t);
    if (!outcome.settled) {
      // 理论上扫描已过滤掉未到点与整场取消，这里只是兜底
      return { gameId: game.id, settled: false, reason: outcome.reason || 'not_due' };
    }

    const signupByUser = {};
    signups.forEach((s) => { signupByUser[s.userId] = s; });
    const checkinByUser = {};
    checkins.forEach((c) => { checkinByUser[c.userId] = c; });

    let pigeons = 0;
    let applied = 0;
    for (const r of outcome.results) {
      const signupRec = signupByUser[r.userId];
      const isWalkin = r.outcome === 'walkin';
      // 已落账判定：报名者看 signup.outcome，空降者看 checkin.settledAt
      const alreadyApplied = isWalkin
        ? !!(checkinByUser[r.userId] && checkinByUser[r.userId].settledAt)
        : !!(signupRec && signupRec.outcome);

      // 鸽记录唯一键防重：记录在、但本地标记缺失（上次写一半）时也算已落账
      let pigeonRecordExists = false;
      if (r.outcome === 'pigeon') {
        const exist = await db.listPigeonRecords({ gameId: game.id, userId: r.userId });
        pigeonRecordExists = exist.length > 0;
      }
      if (alreadyApplied || (r.outcome === 'pigeon' && pigeonRecordExists)) {
        continue;
      }

      // 1) 先落鸽记录（唯一结论凭证）
      if (r.outcome === 'pigeon') {
        await db.insertPigeonRecord({
          gameId: game.id,
          userId: r.userId,
          createdAt: t,
          status: 'active', // active 有效 | redeemed 已被守约抵消 | revoked 已被发起人撤销
          redeemedAt: null,
          revokedBy: null,
          revokedAt: null,
          revokeReason: null,
        });
        pigeons += 1;
      }

      // 2) 再落信誉（settleGame 已按 rules 统一算好，含守约进度与抵消）
      const nextCredit = outcome.credits[r.userId];
      if (usersIn[r.userId]) {
        await db.updateUser(r.userId, { credit: nextCredit, updatedAt: t });
      } else {
        await db.insertUser({
          id: r.userId, openid: r.userId, nickname: '', avatarUrl: '',
          credit: nextCredit, createdAt: t, updatedAt: t,
        });
      }

      // 3) 抵消落账：本次守约使 redeemedPigeons 增加时，把该用户最早的
      //    active 鸽记录标记为 redeemed，保持记录与计数口径一致
      const before = creditsIn[r.userId];
      if (nextCredit.redeemedPigeons > before.redeemedPigeons) {
        const actives = (await db.listPigeonRecords({ userId: r.userId, status: 'active' }))
          .sort((a, b) => a.createdAt - b.createdAt);
        if (actives.length) {
          await db.updatePigeonRecord(actives[0].id, { status: 'redeemed', redeemedAt: t });
        }
      }

      // 4) 最后打落账标记
      if (isWalkin) {
        if (checkinByUser[r.userId]) {
          await db.updateCheckin(checkinByUser[r.userId].id, { settledAt: t });
        }
      } else if (signupRec) {
        await db.updateSignup(signupRec.id, { outcome: r.outcome, settledAt: t });
      }
      applied += 1;
    }

    // 全部用户落账后才置球局已结算标记（保险 1）
    await db.updateGame(game.id, {
      status: 'settled',
      settled: true,
      settledAt: t,
      updatedAt: t,
    });
    return { gameId: game.id, settled: true, pigeons, applied };
  }

  /**
   * run()：扫描并结算所有到期球局，返回逐场摘要。
   * 跳过：已结算（settled 标记）、整场取消（全员免鸽，无账可记，
   * 与 settleGame 对 cancelled 的 exempt 结论等价）、未到开球 +4 小时。
   * 发起人提前结束（status='ended'）的球局照常按 +4 小时结算，不提前。
   */
  async function run() {
    const t = nowMs();
    const games = await db.listGames();
    const due = games.filter(
      (g) => !g.settled && g.status !== 'cancelled' && rules.settleAtOf(g) <= t
    );
    const summary = [];
    for (const game of due) {
      summary.push(await settleOneGame(game, t));
    }
    return { ranAt: t, settledCount: summary.filter((s) => s.settled).length, results: summary };
  }

  return { run, settleOneGame };
}

module.exports = createSettle;
