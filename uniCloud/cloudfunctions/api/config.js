/**
 * config.js —— api 云函数的集中配置（所有部署相关常量只放这里）
 *
 * ⚠️ 微信 AppSecret 填入位置（给部署者）：
 *   在 uniCloud 控制台 / HBuilderX 中给 api 云函数配置环境变量
 *   WX_APPID、WX_APP_SECRET 后重启云函数即可，不要把真实值写进
 *   本文件提交进仓库，更不要出现在小程序端（miniprogram/）任何
 *   文件里 —— 小程序包可以被任何人下载反编译，密钥写在前端
 *   等于公开。AppSecret 也不应发到聊天/工单里传递，只填云端配置。
 *
 * 未配置时 login 会返回 { ok:false, error:'server_not_configured' }，
 * 其余需要鉴权的 action 无法通过（没有合法 token 来源），属预期。
 */

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 会话 token 有效期：30 天

module.exports = {
  // 微信小程序凭证：只从云函数环境变量读取，代码里不落明文
  WX_APPID: process.env.WX_APPID || '',
  WX_APP_SECRET: process.env.WX_APP_SECRET || '',

  SESSION_TTL_MS,
  CODE2SESSION_ENDPOINT: 'https://api.weixin.qq.com/sns/jscode2session',
};
