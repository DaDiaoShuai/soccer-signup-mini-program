/**
 * handler.js —— api 云函数的分发层（传输无关，可本地单测）
 *
 * 职责：
 *  1. login 之外的全部 action 先经 auth.verify 校验会话 token，
 *     换回 openid 再分发给 service；无 token / 伪造 / 过期一律
 *     返回统一的 { ok:false, error:'unauthorized' }。
 *  2. action 路由与 miniprogram/utils/store.js 的方法名一一对应
 *     （含迁移前微信云 api 缺的 listPigeonRecords 等读方法）。
 *  3. handleEvent 把 uniCloud 的两类事件归一化到 handle：
 *     - 定时触发事件（config.json triggers，每小时）→ 跑 settle 全量扫描；
 *     - URL 化 HTTP 事件（httpMethod + body 字符串）→ 解析 JSON body /
 *       query 参数 / authorization 请求头里的 token，响应按 URL 化
 *       规范回 JSON（业务错误也回 200，错误码在 body.error，前端只认 body）；
 *     - 普通对象事件（云函数直调/本地调试）→ 字段即参数，直接分发。
 *
 * 安全红线（与迁移前一致）：路由表里没有也不提供任何手动记鸽的
 * action —— 鸽只能由 settle 结算产生。
 */

const createApi = require('./service');
const createSettle = require('./settleService');
const createAuth = require('./auth');
const defaultConfig = require('./config');

function extractToken(event, body) {
  const headers = (event && event.headers) || {};
  const authHeader = headers.authorization || headers.Authorization || '';
  if (typeof authHeader === 'string' && authHeader) {
    return authHeader.replace(/^Bearer\s+/i, '');
  }
  if (body && body.token) return body.token;
  if (event && event.token) return event.token;
  const qs = (event && event.queryStringParameters) || {};
  return qs.token || null;
}

function createHandler({ db, now, httpGet, config }) {
  const conf = config || defaultConfig;
  const settle = createSettle({ db, now });
  const api = createApi({ db, now, settle });
  const auth = createAuth({ db, now, httpGet, config: conf });

  /** req：{ action, token, ...payload }，已被 handleEvent 归一化 */
  async function handle(req) {
    const e = req || {};
    if (!e.action) return { ok: false, error: 'unknown_action', action: null };

    if (e.action === 'login') {
      return auth.login(e.code, e);
    }

    const session = await auth.verify(e.token);
    if (!session) return { ok: false, error: 'unauthorized' };
    const openid = session.openid;

    switch (e.action) {
      // —— 与 store.js 同名同签名 ——
      case 'listGames':
        return api.listGames();
      case 'getGameDetail':
        return api.getGameDetail(e.gameId);
      case 'createGame':
        return api.createGame(openid, e);
      case 'signup':
        return api.signup(openid, e.gameId, e.type);
      case 'cancelSignup':
        return api.cancelSignup(openid, e.gameId);
      case 'checkin':
        return api.checkin(openid, e);
      case 'getUserProfile':
        return api.getUserProfile(openid, e.userId);
      case 'listPigeonRecords':
        return api.listPigeonRecords(openid, e.userId);
      case 'getAppealContext':
        return api.getAppealContext(openid, e.pigeonRecordId);
      case 'listMyGames':
        return api.listMyGames(openid);
      case 'listNotifications':
        return api.listNotifications(openid);
      // —— 发起人管理（service 内逐个校验发起人身份）——
      case 'updateGame':
        return api.updateGame(openid, e.gameId, e.patch || {});
      case 'cancelGame':
        return api.cancelGame(openid, e.gameId);
      case 'endGame':
        return api.endGame(openid, e.gameId);
      case 'proxyCheckin':
        return api.proxyCheckin(openid, e.gameId, e.targetUserId, e.reason);
      // —— 申诉与撤销 ——
      case 'submitAppeal':
        return api.submitAppeal(openid, e);
      case 'listAppeals':
        return api.listAppeals(openid, e.gameId);
      case 'resolveAppeal':
        // store 传 { appealId, approve, note }，service 的 decision 读 approve/note
        return api.resolveAppeal(openid, e.appealId, e);
      case 'revokePigeon':
        return api.revokePigeon(openid, e.pigeonRecordId, e.reason);
      default:
        return { ok: false, error: 'unknown_action', action: e.action || null };
    }
  }

  function isTimerEvent(event) {
    return !!(event && (event.Type === 'Timer' || event.TriggerName || event.triggerName));
  }

  function isHttpEvent(event) {
    return !!(event && (event.httpMethod || typeof event.body === 'string'));
  }

  /** uniCloud 入口事件 → handle；定时事件 → settle.run() */
  async function handleEvent(event) {
    const evt = event || {};

    if (isTimerEvent(evt)) {
      return settle.run();
    }

    let body = {};
    if (typeof evt.body === 'string' && evt.body) {
      try {
        body = JSON.parse(evt.body);
      } catch (err) {
        body = {};
      }
    } else if (evt.body && typeof evt.body === 'object') {
      body = evt.body;
    }
    const req = Object.assign({}, evt.queryStringParameters || {}, evt, body);
    delete req.body;
    delete req.headers;
    delete req.httpMethod;
    delete req.queryStringParameters;
    req.token = extractToken(evt, body);

    const result = await handle(req);

    if (isHttpEvent(evt)) {
      // URL 化响应：统一 200 + JSON body，业务错误码看 body.error
      return {
        mpserverlessComposedResponse: true,
        statusCode: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify(result == null ? null : result),
      };
    }
    return result;
  }

  return { handle, handleEvent, api, auth, settle };
}

module.exports = createHandler;
