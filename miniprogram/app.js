// app.js —— 小程序入口
// 第二阶段：云开发代码已就绪（cloudfunctions/ + utils/store.js 的 USE_CLOUD 开关），
// 等用户开通云环境后按 README「云环境部署步骤清单」操作即可切换，页面层无需改动。

// 云环境 ID 占位：开通云开发后把这里换成你的环境 ID（形如 'prod-xxxxxxxx'）。
// 留空时 wx.cloud.init 使用默认环境；未开通云环境时初始化会被跳过，不影响本地 mock。
const CLOUD_ENV_ID = '';

// 订阅消息模板 ID 占位（需用户配合申请，见 README「需要用户配合的事项清单」）：
// 在微信公众平台「功能 → 订阅消息」里选用/申请模板后，把模板 ID 填到对应键里。
// 留空时不影响任何现有功能；通知的触发点与落地页（pages/notice）已就绪，
// 后续接发送时统一从这里取模板 ID，不要散落到各页面。
const SUBSCRIBE_TEMPLATE_IDS = {
  gameChange: '', // 球局变更（改时间/地点、取消整场）—— 必推
  checkinOpen: '', // 开球前 1 小时签到开启提醒
  settleResult: '', // 结算结果（被记鸽附申诉入口 / 抵消成功）
  formedMilestone: '', // 成局里程碑（达到门槛 / 掉回门槛以下 / 开球前未成局预警）
};

App({
  globalData: {
    // 当前演示用户（mock 层种子用户 u1）；云端模式下身份由云函数上下文的 OPENID 决定
    currentUserId: 'u1',
    cloudReady: false,
    cloudEnvId: CLOUD_ENV_ID,
    subscribeTemplateIds: SUBSCRIBE_TEMPLATE_IDS,
  },
  onLaunch() {
    if (wx.cloud) {
      try {
        wx.cloud.init({ env: CLOUD_ENV_ID || undefined, traceUser: true });
        this.globalData.cloudReady = true;
      } catch (e) {
        // 未开通云环境 / 占位 AppID 下 init 失败属预期，继续走本地 mock
        this.globalData.cloudReady = false;
      }
    }
  },
});
