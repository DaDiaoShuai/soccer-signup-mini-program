// pages/checkin-result/checkin-result.js —— 签到结果页
// 由详情页签到后带参数跳入：gameId、ok（1/0）、reason、distance（米，too_far 时带）。
// 成功：重新拉详情，按签到顺序算出本人所属队伍/组队进度；
// 失败：按 reason 给出可行动的原因说明（实际距离 vs 围栏半径、签到开启时间等）。
const store = require('../../utils/store');
const rules = require('../../utils/rules');

function fmtTime(ts) {
  const d = new Date(ts);
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}
function fmtDistance(m) {
  if (m == null || isNaN(m)) return '';
  if (m < 1000) return Math.round(m) + ' 米';
  return (m / 1000).toFixed(1) + ' 公里';
}
const TEAM_STATUS_TEXT = { playing: '正在踢', waiting: '等候接波', forming: '组队中' };

Page({
  data: {
    gameId: '',
    ok: false,
    reason: '',
    distance: null,
    game: null,
    timeText: '',
    teamText: '',
    detailText: '',
    loading: true,
  },
  onLoad(options) {
    const ok = options.ok === '1';
    const reason = options.reason ? decodeURIComponent(options.reason) : '';
    const distance = options.distance != null && options.distance !== '' ? Number(options.distance) : null;
    this.setData({ gameId: options.gameId || '', ok, reason, distance });
    if (options.gameId) {
      this.loadGame(options.gameId, ok, reason, distance);
    } else {
      this.setData({ loading: false, detailText: '缺少球局信息，无法确认签到结果。' });
    }
  },
  loadGame(gameId, ok, reason, distance) {
    store.getGameDetail(gameId).then((g) => {
      if (!g) {
        this.setData({ loading: false, detailText: '球局不存在或已被删除。' });
        return;
      }
      let teamText = '';
      let detailText = '';
      if (ok) {
        const me = store.getCurrentUserId();
        const teams = (g.stats.teams && g.stats.teams.teams) || [];
        const mine = teams.find((t) => t.members.some((m) => m.userId === me));
        if (mine) {
          teamText = '第 ' + mine.index + ' 队 · ' + (TEAM_STATUS_TEXT[mine.status] || mine.status);
          detailText = mine.needed > 0
            ? '你已进入第 ' + mine.index + ' 队，还差 ' + mine.needed + ' 人满队，满队后按接波顺序上场。'
            : '你所在的第 ' + mine.index + ' 队已满队（' + (TEAM_STATUS_TEXT[mine.status] || '') + '）。当前已到场 ' + g.stats.arrivedCount + ' 人。';
        } else {
          teamText = '已确认到场';
          detailText = '签到已生效，当前已到场 ' + g.stats.arrivedCount + ' 人。';
        }
        if (reason === 'already') detailText = '你此前已经签到成功，本次没有重复记录。' + detailText;
      } else {
        const radius = g.fenceRadiusMeters || rules.MERGE_RADIUS_METERS;
        const openAt = g.startTime - rules.CHECKIN_OPEN_BEFORE_MS;
        const map = {
          too_far: '你现在距离球场约 ' + fmtDistance(distance) + '，签到围栏半径为 ' + radius + ' 米。请到达球场范围后再签到。',
          too_early: '签到还没开启。本场签到将在 ' + fmtTime(openAt) + '（开球前 1 小时）开启。',
          closed: '本场已过结算时刻（开球后 4 小时），签到通道已关闭。如确已到场，请联系发起人处理。',
          cancelled: '本场球局已被发起人取消，无需签到，本场也不会记鸽。',
          no_location: '没有获取到你的定位，无法校验是否到场。请在系统设置里允许微信使用定位后重试。',
          no_game: '球局不存在或已被删除。',
        };
        detailText = map[reason] || '签到失败（' + (reason || '未知原因') + '），请回到详情页重试。';
      }
      this.setData({ game: g, timeText: fmtTime(g.startTime), teamText, detailText, loading: false });
    });
  },
  backToGame() {
    if (this.data.gameId) {
      wx.redirectTo({ url: '/pages/game/game?id=' + this.data.gameId });
    } else {
      wx.switchTab({ url: '/pages/index/index' });
    }
  },
  backHome() {
    wx.switchTab({ url: '/pages/index/index' });
  },
});
