/**
 * api 云函数入口（uniCloud 版）—— 小程序端唯一的后端入口，一个函数三用：
 *
 *  1. URL 化 HTTPS 接口：小程序端 store.js（BACKEND='unicloud'）用
 *     wx.request 调本函数的 URL 化地址，POST { action, ...参数 }，
 *     请求头带 Authorization: Bearer <会话 token>。URL 化要在
 *     uniCloud 控制台/HBuilderX 对本函数开启，地址形如
 *     https://{spaceId}.api-hz.cloudbasefunction.cn/api
 *  2. 每小时定时触发：config.json 的 triggers 每小时唤醒本函数跑
 *     settle 全量结算扫描（另有读路径惰性结算兜底，见 service.js）。
 *  3. 云函数直调（联调/控制台测试）：参数即 { action, ... }。
 *
 * 本文件只做运行时接线：uniCloud.database() → uniDb 适配 → handler。
 * 身份不再来自上下文（URL 化是公开 HTTP），由 handler 内的自建
 * 会话鉴权负责（auth.js）；AppID/AppSecret 从云函数环境变量读
 * （config.js），绝不出现在小程序端代码里。
 */
const createUniDb = require('./uniDb');
const createHandler = require('./handler');
const config = require('./config');

let handler = null;
function getHandler() {
  if (!handler) {
    handler = createHandler({
      db: createUniDb(uniCloud.database()),
      now: () => Date.now(),
      config,
    });
  }
  return handler;
}

exports.main = async (event, context) => {
  void context;
  return getHandler().handleEvent(event || {});
};
