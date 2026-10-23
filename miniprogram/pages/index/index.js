// pages/index/index.js —— 首页：球局列表 / 发现地图一键切换
// 列表与地图都只展示未结束的局（已结算/已取消/已过结算时刻的不再出现在发现页，
// 它们在「我的球局」里按分组查看）。状态色口径（PRD 7.1）：
// 灰 = 还差人成局，绿 = 已成局，橙 = 正在踢、可接波加入。
const store = require('../../utils/store');
const rules = require('../../utils/rules');

// 时间格式化：毫秒 -> 「M月d日 HH:mm」
function fmtTime(ts) {
  const d = new Date(ts);
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}
function fmtClock(ts) {
  const d = new Date(ts);
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  return pad(d.getHours()) + ':' + pad(d.getMinutes());
}

// 球局展示状态：playing（正在踢）/ formed（已成局）/ recruiting（还差人）
function phaseOf(g, now) {
  if (now >= g.startTime && now <= g.startTime + rules.SETTLE_DELAY_MS && g.status !== 'ended') return 'playing';
  if (g.stats.formed) return 'formed';
  return 'recruiting';
}
const PHASE_META = {
  playing: { text: '正在踢 · 可接波', tagClass: 'tag-orange', icon: '/assets/marker-orange.png' },
  formed: { text: '已成局', tagClass: 'tag-green', icon: '/assets/marker-green.png' },
  recruiting: { text: '还差人成局', tagClass: 'tag-grey', icon: '/assets/marker-grey.png' },
};

Page({
  data: {
    games: [],
    markers: [],
    viewMode: 'list', // list | map
    selectedGame: null,
    mapLatitude: 31.2304,
    mapLongitude: 121.4737,
    mapScale: 12,
    loading: true,
  },
  onShow() {
    this.loadGames();
  },
  loadGames() {
    store.listGames().then((games) => {
      const now = Date.now();
      const visible = games.filter(
        (g) => g.status !== 'settled' && g.status !== 'cancelled' && now < g.startTime + rules.SETTLE_DELAY_MS
      );
      const view = visible.map((g) => {
        const phase = phaseOf(g, now);
        const meta = PHASE_META[phase];
        return {
          id: g.id,
          venueName: g.location.name,
          latitude: g.location.latitude,
          longitude: g.location.longitude,
          timeText: fmtTime(g.startTime),
          clockText: fmtClock(g.startTime),
          teamSize: g.teamSize,
          confirmedCount: g.stats.confirmedCount,
          watchingCount: g.stats.watchingCount,
          arrivedCount: g.stats.arrivedCount,
          threshold: g.stats.threshold,
          phase,
          phaseText: meta.text,
          phaseTagClass: meta.tagClass,
          statusText:
            phase === 'playing'
              ? '正在踢，已到场 ' + g.stats.arrivedCount + ' 人，可来接波'
              : g.stats.formed
                ? '已成局'
                : '还差 ' + Math.max(0, g.stats.threshold - g.stats.confirmedCount) + ' 人成局',
          progressPercent: Math.min(100, Math.round((g.stats.confirmedCount / Math.max(1, g.stats.threshold)) * 100)),
          note: g.note,
        };
      });
      const markers = view.map((v, i) => ({
        id: i + 1,
        gameId: v.id,
        latitude: v.latitude,
        longitude: v.longitude,
        iconPath: PHASE_META[v.phase].icon,
        width: 32,
        height: 40,
        callout: {
          content: v.clockText + ' · 已到 ' + v.arrivedCount + ' 人',
          color: '#222222',
          fontSize: 12,
          borderRadius: 6,
          bgColor: v.phase === 'playing' ? '#fdeeda' : v.phase === 'formed' ? '#dff3e6' : '#eceff1',
          padding: 6,
          display: 'ALWAYS',
          textAlign: 'center',
        },
      }));
      const center = view[0] || null;
      this.setData({
        games: view,
        markers,
        loading: false,
        mapLatitude: center ? center.latitude : this.data.mapLatitude,
        mapLongitude: center ? center.longitude : this.data.mapLongitude,
        selectedGame: this.data.selectedGame
          ? view.find((v) => v.id === this.data.selectedGame.id) || null
          : null,
      });
    });
  },
  switchView(e) {
    this.setData({ viewMode: e.currentTarget.dataset.mode });
  },
  onMarkerTap(e) {
    const marker = this.data.markers.find((m) => m.id === e.markerId);
    if (!marker) return;
    const game = this.data.games.find((g) => g.id === marker.gameId);
    if (game) this.setData({ selectedGame: game, mapLatitude: game.latitude, mapLongitude: game.longitude });
  },
  goGame(e) {
    wx.navigateTo({ url: '/pages/game/game?id=' + e.currentTarget.dataset.id });
  },
  goSelected() {
    if (this.data.selectedGame) {
      wx.navigateTo({ url: '/pages/game/game?id=' + this.data.selectedGame.id });
    }
  },
  closeSelected() {
    this.setData({ selectedGame: null });
  },
  goCreate() {
    wx.navigateTo({ url: '/pages/create/create' });
  },
});
