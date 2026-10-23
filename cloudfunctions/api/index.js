/**
 * api 云函数入口 —— 小程序端唯一调用的业务云函数。
 *
 * - 身份：从云函数上下文取 OPENID 作为调用者身份，event 里任何
 *   user_id / userId 字段都不作为身份使用（getUserProfile 的 userId
 *   仅表示「想看谁的公开档案」）。
 * - 路由：event.action 与 miniprogram/utils/store.js 的方法名一一对应。
 * - 业务逻辑全在 service.js（不依赖 SDK，可本地单测），本文件只做
 *   SDK 初始化、身份提取与分发。
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const createCloudDb = require('./cloudDb');
const createApi = require('./service');

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { ok: false, error: 'no_identity' };

  const api = createApi({ db: createCloudDb(cloud.database()), now: () => Date.now() });
  const e = event || {};

  switch (e.action) {
    // —— 与 store.js 同名同签名 ——
    case 'listGames':
      return api.listGames();
    case 'getGameDetail':
      return api.getGameDetail(e.gameId);
    case 'createGame':
      return api.createGame(OPENID, e);
    case 'signup':
      return api.signup(OPENID, e.gameId, e.type);
    case 'cancelSignup':
      return api.cancelSignup(OPENID, e.gameId);
    case 'checkin':
      return api.checkin(OPENID, e);
    case 'getUserProfile':
      return api.getUserProfile(OPENID, e.userId);
    // —— 发起人管理（服务端逐个校验发起人身份）——
    case 'updateGame':
      return api.updateGame(OPENID, e.gameId, e.patch || {});
    case 'cancelGame':
      return api.cancelGame(OPENID, e.gameId);
    case 'endGame':
      return api.endGame(OPENID, e.gameId);
    case 'proxyCheckin':
      return api.proxyCheckin(OPENID, e.gameId, e.targetUserId, e.reason);
    // —— 申诉与撤销 ——
    case 'submitAppeal':
      return api.submitAppeal(OPENID, e);
    case 'listAppeals':
      return api.listAppeals(OPENID, e.gameId);
    case 'resolveAppeal':
      return api.resolveAppeal(OPENID, e.appealId, e);
    case 'revokePigeon':
      return api.revokePigeon(OPENID, e.pigeonRecordId, e.reason);
    default:
      // 注意：没有也不提供任何手动记鸽的 action，鸽只能由 settle 结算产生
      return { ok: false, error: 'unknown_action', action: e.action || null };
  }
};
