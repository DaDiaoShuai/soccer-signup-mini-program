// pages/my/my.js —— 我的球局
// 数据来自 store.listMyGames（我发起的 + 我报名的），按
// 进行中 / 待结算 / 已结束 三组展示；分组口径在 store 层定，页面只做文案映射。
const store = require('../../utils/store');

function fmtTime(ts) {
  const d = new Date(ts);
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

function statusTextOf(g) {
  if (g.status === 'cancelled') return { text: '已取消', cls: 'tag-grey' };
  if (g.status === 'settled') return { text: '已结算', cls: 'tag-grey' };
  if (g.group === 'pendingSettlement') return { text: '待结算', cls: 'tag-orange' };
  if (g.group === 'ended') return { text: '已结束', cls: 'tag-grey' };
  const now = Date.now();
  if (now >= g.startTime) return { text: '正在踢', cls: 'tag-orange' };
  if (g.stats.formed) return { text: '已成局', cls: 'tag-green' };
  return { text: '招募中', cls: 'tag-grey' };
}

Page({
  data: {
    groups: [],
    loading: true,
  },
  onShow() {
    this.loadMy();
  },
  loadMy() {
    store.listMyGames().then((games) => {
      const toView = (g) => {
        const st = statusTextOf(g);
        return {
          id: g.id,
          venueName: g.location.name,
          timeText: fmtTime(g.startTime),
          teamSize: g.teamSize,
          relationText: g.relation === 'both' ? '我发起的 · 已报名' : g.relation === 'organizer' ? '我发起的' : '我报名的',
          statusText: st.text,
          statusClass: st.cls,
          confirmedCount: g.stats.confirmedCount,
          arrivedCount: g.stats.arrivedCount,
          pendingAppealCount: g.pendingAppealCount || 0,
          outcomeText: g.mySignup && g.mySignup.outcome === 'pigeon' ? '本场结果：鸽' : g.mySignup && g.mySignup.outcome === 'attended' ? '本场结果：守约' : '',
        };
      };
      const groups = [
        { key: 'active', title: '进行中', items: games.filter((g) => g.group === 'active').map(toView) },
        { key: 'pendingSettlement', title: '待结算', items: games.filter((g) => g.group === 'pendingSettlement').map(toView) },
        { key: 'ended', title: '已结束', items: games.filter((g) => g.group === 'ended').map(toView) },
      ].filter((gr) => gr.items.length > 0);
      this.setData({ groups, loading: false });
    });
  },
  goGame(e) {
    wx.navigateTo({ url: '/pages/game/game?id=' + e.currentTarget.dataset.id });
  },
  goCreate() {
    wx.navigateTo({ url: '/pages/create/create' });
  },
});
