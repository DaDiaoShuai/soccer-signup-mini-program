/**
 * memoryDb.js —— 云数据库适配层的内存 stub（仅供本地测试）
 *
 * 与 cloudfunctions/(api|settle)/cloudDb.js 及 uniCloud/cloudfunctions/api/uniDb.js
 * 暴露相同的方法签名（uniDb 多出的 sessions/notifications 方法这里也一并实现），
 * 区别只是数据存内存数组。云函数 service 层只依赖这组签名，
 * 因此可以在完全没有微信云环境的情况下单测全部云端逻辑。
 */

function clone(obj) {
  return obj == null ? obj : JSON.parse(JSON.stringify(obj));
}

const PREFIX = {
  games: 'g',
  signups: 's',
  checkins: 'c',
  pigeon_records: 'pr',
  appeals: 'a',
  users: 'u',
  sessions: 'sess',
  notifications: 'n',
};

function createMemoryDb(seed) {
  const data = {
    users: [],
    games: [],
    signups: [],
    checkins: [],
    pigeon_records: [],
    appeals: [],
    sessions: [],
    notifications: [],
  };
  let seq = 1000;

  function insertInto(name, doc) {
    const stored = clone(doc) || {};
    if (!stored.id) {
      seq += 1;
      stored.id = (PREFIX[name] || 'x') + '_' + seq;
    }
    data[name].push(stored);
    return clone(stored);
  }

  function listFrom(name, filter) {
    const f = filter || {};
    const keys = Object.keys(f).filter((k) => f[k] !== undefined);
    return data[name]
      .filter((doc) => keys.every((k) => doc[k] === f[k]))
      .map(clone);
  }

  function getById(name, id) {
    const found = data[name].find((d) => d.id === id);
    return found ? clone(found) : null;
  }

  function updateIn(name, id, patch) {
    const found = data[name].find((d) => d.id === id);
    if (found) Object.assign(found, clone(patch));
    return true;
  }

  if (seed) {
    Object.keys(data).forEach((name) => {
      (seed[name] || []).forEach((doc) => insertInto(name, doc));
    });
  }

  return {
    // 原始数据直达（测试断言用）
    _data: data,

    listGames: async () => listFrom('games'),
    getGame: async (id) => getById('games', id),
    insertGame: async (doc) => insertInto('games', doc),
    updateGame: async (id, patch) => updateIn('games', id, patch),

    listSignups: async (filter) => listFrom('signups', filter),
    insertSignup: async (doc) => insertInto('signups', doc),
    updateSignup: async (id, patch) => updateIn('signups', id, patch),

    listCheckins: async (filter) => listFrom('checkins', filter),
    insertCheckin: async (doc) => insertInto('checkins', doc),
    updateCheckin: async (id, patch) => updateIn('checkins', id, patch),

    getUser: async (id) => getById('users', id),
    insertUser: async (doc) => insertInto('users', doc),
    updateUser: async (id, patch) => updateIn('users', id, patch),

    listPigeonRecords: async (filter) => listFrom('pigeon_records', filter),
    insertPigeonRecord: async (doc) => insertInto('pigeon_records', doc),
    updatePigeonRecord: async (id, patch) => updateIn('pigeon_records', id, patch),

    listAppeals: async (filter) => listFrom('appeals', filter),
    getAppeal: async (id) => getById('appeals', id),
    insertAppeal: async (doc) => insertInto('appeals', doc),
    updateAppeal: async (id, patch) => updateIn('appeals', id, patch),

    // sessions（uniCloud 自建会话鉴权，与 uniDb.js 同签名的新增部分）
    insertSession: async (doc) => insertInto('sessions', doc),
    getSessionByToken: async (token) => {
      const found = data.sessions.find((d) => d.token === token);
      return found ? clone(found) : null;
    },
    deleteSession: async (id) => {
      const idx = data.sessions.findIndex((d) => d.id === id);
      if (idx >= 0) data.sessions.splice(idx, 1);
      return true;
    },

    // notifications（与 uniDb.js 同签名的新增部分）
    listNotifications: async (filter) => listFrom('notifications', filter),
    insertNotification: async (doc) => insertInto('notifications', doc),
    updateNotification: async (id, patch) => updateIn('notifications', id, patch),
  };
}

module.exports = createMemoryDb;
