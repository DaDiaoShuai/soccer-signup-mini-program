/**
 * settleService.js —— 结算服务层（自已弃用的 cloudfunctions/settle/service.js 迁移）
 *
 * 在 uniCloud 方案里，settle 不再是独立云函数，而是与 api 同住一个
 * 云函数（uniCloud/cloudfunctions/api），由两条通道触发：
 *  1. 定时：config.json 的 triggers 每小时触发一次 index.main 做全量扫描；
 *  2. 惰性：api 读到「已过结算时刻且未结算」的球局时，先对该局结算
 *     再返回（见 service.js 的 ensureSettled）—— 目的是省云函数调用
 *     配额（支付宝云免费空间 1.5 万次/月），日常读多写少的场景下，
 *     大部分结算会被读请求顺手带走，定时触发只做兜底。
 *
 * 结算判定口径与迁移前完全一致：唯一来源是同目录 rules.js
 * （miniprogram/utils/rules.js 的逐字副本），本层不另写判定数值；
 * 幂等设计也原样保留（球局 settled 标记 + 鸽记录 gameId+userId
 * 唯一键 + 每条报名/签到落账标记，三道保险）。
 *
 * 与迁移前的唯一行为增量：真正落鸽 / 真正抵消发生时，顺手往
 * notifications 集合写一条结算通知（记鸽 / 抵消成功），供小程序端
 * listNotifications 拉取。通知写在「确认未落账」分支内，天然幂等：
 * 重跑不会重复写。写通知失败不影响结算落账（已 try/catch 兜底）。
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
      let insertedPigeon = null;
      if (r.outcome === 'pigeon') {
        insertedPigeon = await db.insertPigeonRecord({
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
        // 结算通知（uniCloud 新增）：只在此真正落鸽的分支写，重跑不会重复
        if (db.insertNotification) {
          try {
            await db.insertNotification({
              userId: r.userId,
              type: 'settlement_pigeon',
              gameId: game.id,
              pigeonRecordId: insertedPigeon.id,
              title: '结算结果：被记鸽 1 次',
              content: '你报名的球局已结算，因未签到被记鸽 1 次。如有特殊情况，可向本场发起人申诉。',
              read: false,
              createdAt: t,
            });
          } catch (e) { /* 通知失败不阻塞结算 */ }
        }
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
          // 抵消成功通知（uniCloud 新增），同样只在真正抵消时写一次
          if (db.insertNotification) {
            try {
              await db.insertNotification({
                userId: r.userId,
                type: 'redeem_success',
                gameId: game.id,
                pigeonRecordId: actives[0].id,
                title: '已抵消 1 次鸽',
                content: '连续守约满 5 场，已抵消最早的 1 次鸽记录，鸽王等级已实时更新。',
                read: false,
                createdAt: t,
              });
            } catch (e) { /* 通知失败不阻塞结算 */ }
          }
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
