// pages/create/create.js —— 发起球局
// 提交时先走 store.createGame 内的合并判定：
// 同一球场 + 与原局开球时间相差 ≤2 小时 → 命中合并，本页展示合并提示，不新建球局。
const store = require('../../utils/store');

function fmtTime(ts) {
  const d = new Date(ts);
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}
function todayStr() {
  const d = new Date();
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

Page({
  data: {
    venues: [], // 种子球场（演示用，后续接地图选点）
    venueIndex: 0,
    venueName: '',
    latitude: '',
    longitude: '',
    date: todayStr(),
    time: '19:30',
    teamSizeOptions: ['5 人制', '8 人制', '11 人制', '自定义'],
    teamSizeValues: [5, 8, 11, 0],
    teamSizeIndex: 0,
    customTeamSize: '',
    note: '',
    mergeTip: null, // 命中合并时的提示数据
  },
  onLoad() {
    store.getSeedVenues().then((venues) => {
      const v = venues[0];
      this.setData({
        venues,
        venueName: v.name,
        latitude: v.latitude,
        longitude: v.longitude,
      });
    });
  },
  onVenueChange(e) {
    const idx = Number(e.detail.value);
    const v = this.data.venues[idx];
    if (v) {
      this.setData({ venueIndex: idx, venueName: v.name, latitude: v.latitude, longitude: v.longitude });
    }
  },
  onInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ [field]: e.detail.value });
  },
  onDateChange(e) {
    this.setData({ date: e.detail.value });
  },
  onTimeChange(e) {
    this.setData({ time: e.detail.value });
  },
  onTeamSizeChange(e) {
    this.setData({ teamSizeIndex: Number(e.detail.value) });
  },
  resolveTeamSize() {
    const { teamSizeIndex, teamSizeValues, customTeamSize } = this.data;
    if (teamSizeIndex === 3) {
      const n = parseInt(customTeamSize, 10);
      return n > 0 ? n : 5;
    }
    return teamSizeValues[teamSizeIndex];
  },
  submit() {
    const startTime = new Date(this.data.date + 'T' + this.data.time + ':00').getTime();
    const payload = {
      location: {
        name: this.data.venueName,
        latitude: Number(this.data.latitude),
        longitude: Number(this.data.longitude),
      },
      startTime,
      teamSize: this.resolveTeamSize(),
      note: this.data.note,
    };
    store.createGame(payload).then((res) => {
      if (res.merged) {
        // 命中合并：不新建，明确提示原局信息，由用户确认加入
        const t = res.target;
        this.setData({
          mergeTip: {
            gameId: t.id,
            text:
              '这个球场已有同一场局：' + t.location.name + '，' + fmtTime(t.startTime) +
              ' 开球，' + t.teamSize + ' 人制，已报名 ' + t.stats.confirmedCount +
              ' 人。与你发起的时间相差 2 小时内，将合并为同一场，你将作为普通报名人加入。',
          },
        });
        return;
      }
      wx.showToast({ title: '发起成功', icon: 'success' });
      wx.redirectTo({ url: '/pages/game/game?id=' + res.game.id });
    });
  },
  joinMerged() {
    const id = this.data.mergeTip.gameId;
    store.signup(id, store.getCurrentUserId(), 'confirmed').then(() => {
      wx.redirectTo({ url: '/pages/game/game?id=' + id });
    });
  },
  dismissMerge() {
    this.setData({ mergeTip: null });
  },
});
