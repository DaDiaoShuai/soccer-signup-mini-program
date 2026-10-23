/**
 * uniDb.js —— uniCloud 数据库适配层（api 云函数专用，本函数一份即可）
 *
 * 把 uniCloud.database() 的 API 收敛成与已弃用微信云开发版 cloudDb.js
 * 完全相同的方法签名，service / settleService 只依赖这组签名，
 * 因此本地测试可以用 tests/helpers/memoryDb.js（同签名）替换本文件，
 * 也可以用 tests/helpers/fakeUniDb.js 验证本适配层本身的映射逻辑。
 *
 * 接口约定（与 cloudDb.js 一致）：
 *  - 所有读方法返回「普通对象，含 id 字段」（由 _id 映射而来）
 *  - insert 返回带 id 的完整文档；update 返回 true
 *  - list 的过滤条件只做等值匹配，undefined 的键自动忽略
 *
 * 相比 cloudDb.js 的新增：sessions（自建会话鉴权）与 notifications
 * （通知）两个集合的访问方法。
 *
 * 权限说明：云函数内调用 uniCloud.database() 为服务端身份，不受
 * database/*.schema.json 里 permission 的限制；schema 权限是用来
 * 挡住客户端直连（clientDB / 前端 SDK）的，口径见 uniCloud/database/SCHEMA.md。
 */

function createUniDb(database) {
  const col = (name) => database.collection(name);
  const norm = (doc) => (doc ? Object.assign({}, doc, { id: doc._id }) : null);
  const cleanWhere = (where) => {
    const out = {};
    Object.keys(where || {}).forEach((k) => {
      if (where[k] !== undefined) out[k] = where[k];
    });
    return out;
  };

  async function list(name, where) {
    const w = cleanWhere(where);
    let q = col(name);
    if (Object.keys(w).length) q = q.where(w);
    const res = await q.limit(1000).get();
    return (res.data || []).map(norm);
  }

  async function getById(name, id) {
    if (!id) return null;
    try {
      const res = await col(name).doc(id).get();
      // uniCloud doc().get() 返回 { data: [doc] } 或 { data: doc }，两种都兼容
      const doc = Array.isArray(res.data) ? res.data[0] : res.data;
      return norm(doc || null);
    } catch (e) {
      return null; // 文档不存在时统一成 null
    }
  }

  async function insert(name, doc) {
    const data = Object.assign({}, doc);
    delete data.id;
    // users 集合以 openid 作为文档 _id，方便按身份直查（与 cloudDb 口径一致）
    if (name === 'users' && doc.id) data._id = doc.id;
    const res = await col(name).add(data);
    const newId = res.id || res._id || data._id;
    return Object.assign({}, doc, { id: newId });
  }

  async function update(name, id, patch) {
    const data = Object.assign({}, patch);
    delete data.id;
    delete data._id;
    await col(name).doc(id).update(data);
    return true;
  }

  async function remove(name, id) {
    await col(name).doc(id).remove();
    return true;
  }

  return {
    // games
    listGames: () => list('games'),
    getGame: (id) => getById('games', id),
    insertGame: (doc) => insert('games', doc),
    updateGame: (id, patch) => update('games', id, patch),
    // signups
    listSignups: (filter) => list('signups', filter),
    insertSignup: (doc) => insert('signups', doc),
    updateSignup: (id, patch) => update('signups', id, patch),
    // checkins
    listCheckins: (filter) => list('checkins', filter),
    insertCheckin: (doc) => insert('checkins', doc),
    updateCheckin: (id, patch) => update('checkins', id, patch),
    // users（_id = openid）
    getUser: (id) => getById('users', id),
    insertUser: (doc) => insert('users', doc),
    updateUser: (id, patch) => update('users', id, patch),
    // pigeon_records
    listPigeonRecords: (filter) => list('pigeon_records', filter),
    insertPigeonRecord: (doc) => insert('pigeon_records', doc),
    updatePigeonRecord: (id, patch) => update('pigeon_records', id, patch),
    // appeals
    listAppeals: (filter) => list('appeals', filter),
    getAppeal: (id) => getById('appeals', id),
    insertAppeal: (doc) => insert('appeals', doc),
    updateAppeal: (id, patch) => update('appeals', id, patch),
    // sessions（自建会话鉴权：token → openid）
    insertSession: (doc) => insert('sessions', doc),
    getSessionByToken: async (token) => {
      if (!token) return null;
      const found = await list('sessions', { token });
      return found[0] || null;
    },
    deleteSession: (id) => remove('sessions', id),
    // notifications
    listNotifications: (filter) => list('notifications', filter),
    insertNotification: (doc) => insert('notifications', doc),
    updateNotification: (id, patch) => update('notifications', id, patch),
  };
}

module.exports = createUniDb;
