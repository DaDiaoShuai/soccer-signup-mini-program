// pages/game/game.js —— 球局详情
// 展示：人数统计（报名/观望/已到场分开）、到场地图（围栏圈 + 到场聚合点）、
// 报名名单（带鸽王标签）、接波队列；发起人可在此裁决本场待处理申诉。
// 当前用户可报名 / 观望 / 取消 / 定位签到；签到完成后跳签到结果页看入队结果或失败原因。
const store = require('../../utils/store');

function fmtTime(ts) {
  const d = new Date(ts);
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}
const TEAM_STATUS_TEXT = { playing: '正在踢', waiting: '等候接波', forming: '组队中' };
const APPEAL_STATUS_TEXT = { pending: '待裁决', approved: '已撤销', rejected: '已驳回' };

Page({
  data: {
    gameId: '',
    game: null,
    timeText: '',
    signupList: [],
    teamsView: [],
    myState: '', // '' 未报名 | confirmed | watching | cancelled
    isOrganizer: false,
    pendingAppeals: [],
    arrivedCount: 0,
    fullTeamCount: 0,
    neededForNextTeam: 0,
    notArrivedCount: 0,
    progressPercent: 0,
    mapLatitude: 0,
    mapLongitude: 0,
    mapMarkers: [],
    mapCircles: [],
    loading: true,
  },
  onLoad(options) {
    this.setData({ gameId: options.id });
  },
  onShow() {
    if (this.data.gameId) this.loadDetail();
  },
  loadDetail() {
    store.getGameDetail(this.data.gameId).then((g) => {
      if (!g) {
        this.setData({ loading: false });
        return;
      }
      const me = store.getCurrentUserId();
      const mine = (g.signupList || []).find((s) => s.userId === me);
      const myState = !mine ? '' : mine.status === 'cancelled' ? 'cancelled' : mine.type;
      const arrivedIds = {};
      (g.stats.arrived || []).forEach((c) => { arrivedIds[c.userId] = true; });
      const signupList = (g.signupList || [])
        .filter((s) => s.status !== 'cancelled')
        .map((s) => ({
          userId: s.userId,
          nickname: s.nickname,
          typeText: s.type === 'watching' ? '观望' : '确定报名',
          arrived: !!arrivedIds[s.userId],
          pigeonLabel: s.pigeon.label,
        }));
      const teamsView = (g.stats.teams.teams || []).map((t) => ({
        index: t.index,
        statusText: TEAM_STATUS_TEXT[t.status] || t.status,
        status: t.status,
        size: t.size,
        needed: t.needed,
        memberNames: t.members.map((m) => m.nickname).join('、'),
      }));
      const teams = g.stats.teams || {};
      const arrivedCount = g.stats.arrivedCount;
      // 未到者只报人数、不显示位置：确定报名但还没签到的人数（空降到场会让它兜底为 0）
      const notArrivedCount = Math.max(0, g.stats.confirmedCount - arrivedCount);
      const radius = g.fenceRadiusMeters || 500;
      const mapMarkers = [
        {
          id: 1,
          latitude: g.location.latitude,
          longitude: g.location.longitude,
          iconPath: '/assets/marker-green.png',
          width: 32,
          height: 40,
          callout: {
            content: '已到场 ' + arrivedCount + ' 人',
            color: '#222222',
            fontSize: 12,
            borderRadius: 6,
            bgColor: '#dff3e6',
            padding: 6,
            display: 'ALWAYS',
            textAlign: 'center',
          },
        },
      ];
      const mapCircles = [
        {
          latitude: g.location.latitude,
          longitude: g.location.longitude,
          radius,
          color: '#1a7f4b88',
          fillColor: '#1a7f4b22',
          strokeWidth: 2,
        },
      ];
      const isOrganizer = g.organizerId === me;
      this.setData({
        game: g,
        timeText: fmtTime(g.startTime),
        signupList,
        teamsView,
        myState,
        isOrganizer,
        arrivedCount,
        fullTeamCount: teams.fullTeamCount || 0,
        neededForNextTeam: teams.neededForNextTeam != null ? teams.neededForNextTeam : g.teamSize,
        notArrivedCount,
        progressPercent: Math.min(100, Math.round((g.stats.confirmedCount / Math.max(1, g.stats.threshold)) * 100)),
        mapLatitude: g.location.latitude,
        mapLongitude: g.location.longitude,
        mapMarkers,
        mapCircles,
        loading: false,
      });
      if (isOrganizer) this.loadAppeals();
    });
  },
  loadAppeals() {
    store.listAppeals(this.data.gameId).then((list) => {
      const pendingAppeals = (list || [])
        .filter((a) => a.status === 'pending')
        .map((a) => ({
          id: a.id,
          nickname: a.nickname || a.userId,
          reason: a.reason,
          createdText: fmtTime(a.createdAt),
          statusText: APPEAL_STATUS_TEXT[a.status] || a.status,
        }));
      this.setData({ pendingAppeals });
    });
  },
  doSignup() {
    store.signup(this.data.gameId, store.getCurrentUserId(), 'confirmed').then(() => this.loadDetail());
  },
  doWatch() {
    store.signup(this.data.gameId, store.getCurrentUserId(), 'watching').then(() => this.loadDetail());
  },
  doCancel() {
    // 结算前任意时间取消免鸽，直接取消即可
    store.cancelSignup(this.data.gameId, store.getCurrentUserId()).then(() => this.loadDetail());
  },
  doCheckin() {
    const that = this;
    wx.getLocation({
      type: 'gcj02',
      success(res) {
        store
          .checkin(that.data.gameId, store.getCurrentUserId(), {
            latitude: res.latitude,
            longitude: res.longitude,
          })
          .then((r) => {
            const q =
              'gameId=' + that.data.gameId +
              '&ok=' + (r.ok ? '1' : '0') +
              '&reason=' + encodeURIComponent(r.reason || '') +
              (r.distance != null ? '&distance=' + Math.round(r.distance) : '');
            wx.navigateTo({ url: '/pages/checkin-result/checkin-result?' + q });
          });
      },
      fail() {
        wx.navigateTo({
          url: '/pages/checkin-result/checkin-result?gameId=' + that.data.gameId + '&ok=0&reason=no_location',
        });
      },
    });
  },
  approveAppeal(e) {
    const id = e.currentTarget.dataset.id;
    store.resolveAppeal(id, true, '').then((r) => {
      wx.showToast({ title: r.ok ? '已撤销这条鸽记录' : '操作失败：' + r.error, icon: r.ok ? 'success' : 'none' });
      this.loadAppeals();
    });
  },
  rejectAppeal(e) {
    const id = e.currentTarget.dataset.id;
    store.resolveAppeal(id, false, '').then((r) => {
      wx.showToast({ title: r.ok ? '已驳回' : '操作失败：' + r.error, icon: r.ok ? 'success' : 'none' });
      this.loadAppeals();
    });
  },
  onShareAppMessage() {
    const g = this.data.game;
    return {
      title: g
        ? g.location.name + ' ' + this.data.timeText + ' 约球，已报名 ' + g.stats.confirmedCount + ' 人'
        : '约球',
      path: '/pages/game/game?id=' + this.data.gameId,
    };
  },
});
