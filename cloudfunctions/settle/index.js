/**
 * settle 云函数入口 —— 定时触发器专用（触发器配置见 config.json，每 5 分钟）。
 *
 * 只负责 SDK 初始化并调用 service.run()；全部结算逻辑在 service.js，
 * 口径来自同目录 rules.js（miniprogram/utils/rules.js 的逐字副本）。
 * 也可由开发者工具手动调用本函数做联调，效果与定时触发相同（幂等）。
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const createCloudDb = require('./cloudDb');
const createSettle = require('./service');

exports.main = async () => {
  const settle = createSettle({ db: createCloudDb(cloud.database()), now: () => Date.now() });
  return settle.run();
};
