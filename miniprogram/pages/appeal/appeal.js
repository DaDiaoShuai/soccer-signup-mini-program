// pages/appeal/appeal.js —— 申诉页
// 带 pigeonRecordId 进入（个人主页鸽记录、通知落地页都会这么跳）。
// 展示关联场次与当前流转状态：无申诉可填写提交；待裁决 / 已撤销（通过）/ 已驳回。
// 驳回后可改理由重新提交（云端口径：只要记录仍为 active 且没有 pending 申诉即可）。
const store = require('../../utils/store');

function fmtTime(ts) {
  const d = new Date(ts);
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}
const RECORD_STATUS = {
  active: { text: '有效（计入鸽王等级）', cls: 'tag-red' },
  revoked: { text: '已撤销', cls: 'tag-green' },
  redeemed: { text: '已抵消', cls: 'tag-green' },
};
const APPEAL_STATUS = {
  pending: { text: '待裁决', cls: 'tag-orange' },
  approved: { text: '已通过 · 鸽记录已撤销', cls: 'tag-green' },
  rejected: { text: '已驳回', cls: 'tag-red' },
};
const ERROR_TEXT = {
  record_not_found: '这条鸽记录不存在，或不是你本人的记录。',
  record_not_active: '这条记录已经不是有效状态，不能再申诉。',
  appeal_pending: '已有一条待裁决的申诉，请等发起人处理。',
};

Page({
  data: {
    pigeonRecordId: '',
    record: null,
    game: null,
    appeal: null,
    gameTimeText: '',
    recordTimeText: '',
    recordStatusText: '',
    recordStatusClass: '',
    appealStatusText: '',
    appealStatusClass: '',
    canSubmit: false,
    reason: '',
    submitting: false,
    loading: true,
    notFound: false,
  },
  onLoad(options) {
    this.setData({ pigeonRecordId: options.pigeonRecordId || '' });
    this.loadContext();
  },
  loadContext() {
    if (!this.data.pigeonRecordId) {
      this.setData({ loading: false, notFound: true });
      return;
    }
    store.getAppealContext(this.data.pigeonRecordId).then((ctx) => {
      if (!ctx || !ctx.record) {
        this.setData({ loading: false, notFound: true });
        return;
      }
      const record = ctx.record;
      const appeal = ctx.appeal;
      const rs = RECORD_STATUS[record.status] || { text: record.status, cls: 'tag-grey' };
      const as = appeal ? APPEAL_STATUS[appeal.status] || { text: appeal.status, cls: 'tag-grey' } : null;
      const canSubmit = record.status === 'active' && (!appeal || appeal.status === 'rejected');
      this.setData({
        record,
        game: ctx.game,
        appeal,
        gameTimeText: ctx.game ? fmtTime(ctx.game.startTime) : '',
        recordTimeText: fmtTime(record.createdAt),
        recordStatusText: rs.text,
        recordStatusClass: rs.cls,
        appealStatusText: as ? as.text : '尚未申诉',
        appealStatusClass: as ? as.cls : 'tag-grey',
        canSubmit,
        loading: false,
      });
    });
  },
  onReasonInput(e) {
    this.setData({ reason: e.detail.value });
  },
  submit() {
    const reason = (this.data.reason || '').trim();
    if (!reason) {
      wx.showToast({ title: '先写一下申诉理由', icon: 'none' });
      return;
    }
    this.setData({ submitting: true });
    store.submitAppeal(this.data.pigeonRecordId, reason).then((r) => {
      this.setData({ submitting: false });
      if (!r.ok) {
        wx.showToast({ title: ERROR_TEXT[r.error] || '提交失败：' + r.error, icon: 'none' });
        return;
      }
      wx.showToast({ title: '已提交，等发起人裁决', icon: 'success' });
      this.setData({ reason: '' });
      this.loadContext();
    });
  },
  backToGame() {
    if (this.data.game) {
      wx.redirectTo({ url: '/pages/game/game?id=' + this.data.game.id });
    }
  },
  backProfile() {
    wx.switchTab({ url: '/pages/profile/profile' });
  },
});
