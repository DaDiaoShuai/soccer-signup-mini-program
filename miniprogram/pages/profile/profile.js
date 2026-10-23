// pages/profile/profile.js —— 个人主页（信誉档案）
// 除信誉汇总外，第三阶段起展示我的鸽记录（带关联场次与申诉状态），
// 每条可跳申诉页查看/提交/看裁决；另有消息入口跳通知落地页。
const store = require('../../utils/store');

function fmtTime(ts) {
  const d = new Date(ts);
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}
const RECORD_STATUS = {
  active: { text: '有效', cls: 'tag-red' },
  revoked: { text: '已撤销', cls: 'tag-green' },
  redeemed: { text: '已抵消', cls: 'tag-green' },
};
const APPEAL_STATUS = {
  pending: '申诉待裁决',
  approved: '申诉已通过',
  rejected: '申诉已驳回',
};

Page({
  data: {
    profile: null,
    records: [],
    loading: true,
  },
  onShow() {
    this.loadAll();
  },
  loadAll() {
    Promise.all([store.getUserProfile(), store.listPigeonRecords()]).then(([p, records]) => {
      const view = (records || []).map((r) => {
        const rs = RECORD_STATUS[r.status] || { text: r.status, cls: 'tag-grey' };
        return {
          id: r.id,
          gameId: r.gameId,
          venueName: r.game ? r.game.location.name : r.gameId,
          timeText: r.game ? fmtTime(r.game.startTime) : '',
          statusText: rs.text,
          statusClass: rs.cls,
          appealText: r.appeal ? APPEAL_STATUS[r.appeal.status] || '' : r.status === 'active' ? '尚未申诉' : '',
          actionText: r.status !== 'active' ? '查看' : r.appeal && r.appeal.status === 'pending' ? '查看申诉' : '去申诉',
        };
      });
      this.setData({ profile: p, records: view, loading: false });
    });
  },
  goAppeal(e) {
    const id = e.currentTarget.dataset.id;
    const gameId = e.currentTarget.dataset.gameId;
    wx.navigateTo({ url: '/pages/appeal/appeal?pigeonRecordId=' + id + (gameId ? '&gameId=' + gameId : '') });
  },
  goNotice() {
    wx.navigateTo({ url: '/pages/notice/notice' });
  },
  goMy() {
    wx.switchTab({ url: '/pages/my/my' });
  },
});
