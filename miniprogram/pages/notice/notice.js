// pages/notice/notice.js —— 消息 / 通知落地页
// 两个职责：
//  1) 承接订阅消息跳转：参数 type、gameId、pigeonRecordId，按 type 渲染落地内容；
//  2) 展示历史通知列表（store.listNotifications 的 mock 数据），点列表项在本页切换落地内容。
// type 口径：game_change 球局变更 / settlement_pigeon 结算被记鸽 / redeem_success 抵消成功 /
//            milestone 成局里程碑 / appeal_decision 申诉裁决结果。
const store = require('../../utils/store');

function fmtTime(ts) {
  const d = new Date(ts);
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

const TYPE_META = {
  game_change: { title: '球局信息有变更', cls: 'tag-orange' },
  settlement_pigeon: { title: '结算结果：被记鸽', cls: 'tag-red' },
  redeem_success: { title: '信誉抵消成功', cls: 'tag-green' },
  milestone: { title: '成局里程碑', cls: 'tag-green' },
  appeal_decision: { title: '申诉裁决结果', cls: 'tag-orange' },
};

Page({
  data: {
    landing: null, // { type, title, content, gameId, pigeonRecordId, canAppeal }
    game: null,
    gameTimeText: '',
    notifications: [],
    loading: true,
  },
  onLoad(options) {
    const hasLanding = !!(options && options.type);
    if (hasLanding) {
      this.applyLanding({
        type: options.type,
        gameId: options.gameId || '',
        pigeonRecordId: options.pigeonRecordId || '',
        title: options.title ? decodeURIComponent(options.title) : '',
        content: options.content ? decodeURIComponent(options.content) : '',
      });
    }
    this.loadList(hasLanding);
  },
  loadList(hasLanding) {
    store.listNotifications().then((list) => {
      const view = (list || []).map((n) => ({
        id: n.id,
        type: n.type,
        typeTitle: (TYPE_META[n.type] || {}).title || n.type,
        typeClass: (TYPE_META[n.type] || {}).cls || 'tag-grey',
        title: n.title,
        content: n.content,
        gameId: n.gameId || '',
        pigeonRecordId: n.pigeonRecordId || '',
        createdText: fmtTime(n.createdAt),
        read: !!n.read,
      }));
      this.setData({ notifications: view, loading: false });
      // 没有跳转参数时，默认把最新一条渲染成落地内容，页面不空着
      if (!hasLanding && view.length) this.applyLanding(view[0]);
    });
  },
  applyLanding(item) {
    const meta = TYPE_META[item.type] || { title: '通知', cls: 'tag-grey' };
    const defaults = {
      game_change: '本场的时间、地点或备注有变更，请以球局详情为准。计划有变记得提前取消，结算前取消不算鸽。',
      settlement_pigeon: '这场球局你已报名但未签到，结算时被记鸽 1 次。如有特殊情况（没电、定位异常等），可以向本场发起人申诉。',
      redeem_success: '你已连续守约满 5 场，系统自动抵消了最早的 1 次鸽记录，鸽王等级已实时更新。',
      milestone: '这场球局的确定报名人数已达到成局门槛，可以放心出发。',
      appeal_decision: '你提交的申诉已有裁决结果，点下方按钮查看这条鸽记录与裁决说明。',
    };
    this.setData({
      landing: {
        type: item.type,
        typeTitle: meta.title,
        title: item.title || meta.title,
        content: item.content || defaults[item.type] || '',
        gameId: item.gameId || '',
        pigeonRecordId: item.pigeonRecordId || '',
        canAppeal: item.type === 'settlement_pigeon' && !!item.pigeonRecordId,
      },
    });
    if (item.gameId) {
      store.getGameDetail(item.gameId).then((g) => {
        if (g) this.setData({ game: g, gameTimeText: fmtTime(g.startTime) });
      });
    } else {
      this.setData({ game: null, gameTimeText: '' });
    }
  },
  tapNotification(e) {
    const item = this.data.notifications.find((n) => n.id === e.currentTarget.dataset.id);
    if (item) this.applyLanding(item);
  },
  goGame() {
    if (this.data.landing && this.data.landing.gameId) {
      wx.navigateTo({ url: '/pages/game/game?id=' + this.data.landing.gameId });
    }
  },
  goAppeal() {
    if (this.data.landing && this.data.landing.pigeonRecordId) {
      wx.navigateTo({
        url: '/pages/appeal/appeal?pigeonRecordId=' + this.data.landing.pigeonRecordId,
      });
    }
  },
  goProfile() {
    wx.switchTab({ url: '/pages/profile/profile' });
  },
});
