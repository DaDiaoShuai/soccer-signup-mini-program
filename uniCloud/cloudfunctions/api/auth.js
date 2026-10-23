/**
 * auth.js —— 自建会话鉴权（替代微信云开发的上下文 OPENID 自动鉴权）
 *
 * 背景：uniCloud 的 URL 化接口是公开 HTTP 接口，没有微信云函数那种
 * 「上下文自带 OPENID」的待遇，必须自己证明调用者是谁。方案：
 *
 *  1. 小程序端 wx.login() 拿到临时 code，连同 action:'login' 发来；
 *  2. 本模块把 code 转发微信 code2session（appid/secret 只在云端
 *     配置里，见 config.js），换回 openid；
 *  3. 生成不透明随机 token（crypto 32 字节随机数，与 openid 无
 *     可推导关系），写入 sessions 集合：token → openid + 过期时间
 *     （默认 30 天，见 config.SESSION_TTL_MS）；
 *  4. 之后每个 action 都必须带 token，本模块校验并换回 openid，
 *     再交给 service 层走原有权限逻辑（发起人校验等一律不变）。
 *     无 token / token 不存在 / 已过期，一律返回统一的
 *     { ok:false, error:'unauthorized' }（在 handler 层收口）。
 *
 * httpGet 可注入：生产环境默认用 Node 内置 https 请求微信接口，
 * 本地测试注入 stub，不发真实网络请求。
 */

const crypto = require('node:crypto');
const https = require('node:https');

const rules = require('./rules');
const config = require('./config');

function defaultHttpGet(url) {
  return new Promise((resolve, reject) => {
    https
      .get(url, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on('error', reject);
  });
}

/**
 * createAuth({ db, now, httpGet, config })
 * db：uniDb.js 适配层（或同签名 stub）；只需 users 与 sessions 相关方法。
 */
function createAuth({ db, now, httpGet, config: cfg }) {
  const nowMs = typeof now === 'function' ? now : () => Date.now();
  const conf = cfg || config;
  const get = typeof httpGet === 'function' ? httpGet : defaultHttpGet;

  async function code2session(code) {
    const url =
      conf.CODE2SESSION_ENDPOINT +
      '?appid=' + encodeURIComponent(conf.WX_APPID) +
      '&secret=' + encodeURIComponent(conf.WX_APP_SECRET) +
      '&js_code=' + encodeURIComponent(code) +
      '&grant_type=authorization_code';
    return get(url);
  }

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

  /**
   * login(code) → { ok:true, token, expiresAt, profile } |
   *               { ok:false, error:'code_required' | 'server_not_configured' | 'login_failed' }
   * profile 结构与 service.getUserProfile 对齐（惰性 require 避免循环依赖，
   * 这里按 rules 口径就地组装，与 service.profileOf 同算法）。
   */
  async function login(code, extra) {
    if (!code) return { ok: false, error: 'code_required' };
    if (!conf.WX_APPID || !conf.WX_APP_SECRET) {
      // 云端没配 AppID/AppSecret 环境变量时明确报配置错误，不伪装成登录失败
      return { ok: false, error: 'server_not_configured' };
    }
    let sess;
    try {
      sess = await code2session(code);
    } catch (e) {
      return { ok: false, error: 'login_failed' };
    }
    if (!sess || sess.errcode || !sess.openid) {
      return { ok: false, error: 'login_failed' };
    }
    const openid = sess.openid;
    await ensureUser(openid, extra && extra.nickname);
    const token = crypto.randomBytes(32).toString('hex');
    const createdAt = nowMs();
    const expiresAt = createdAt + conf.SESSION_TTL_MS;
    await db.insertSession({ token, openid, createdAt, expiresAt });
    return { ok: true, token, expiresAt, openid };
  }

  /**
   * verify(token) → session 文档（含 openid）| null
   * 过期 session 顺手删除，避免 sessions 集合无限膨胀。
   */
  async function verify(token) {
    if (!token || typeof token !== 'string') return null;
    const session = await db.getSessionByToken(token);
    if (!session) return null;
    if (!session.expiresAt || session.expiresAt <= nowMs()) {
      if (session.id && db.deleteSession) {
        try {
          await db.deleteSession(session.id);
        } catch (e) {
          /* 删除失败不阻塞鉴权结论 */
        }
      }
      return null;
    }
    return session;
  }

  return { login, verify };
}

module.exports = createAuth;
