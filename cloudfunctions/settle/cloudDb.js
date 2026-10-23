/**
 * cloudDb.js —— 云数据库适配层（api 与 settle 各持一份相同副本）
 *
 * 把 wx-server-sdk 的数据库 API 收敛成 service.js 需要的最小接口，
 * service 层只依赖这组方法签名，因此本地测试可以用内存 stub 替换本文件。
 * 接口约定：
 *  - 所有读方法返回「普通对象，含 id 字段」（由 _id 映射而来）
 *  - insert 返回带 id 的完整文档；update 返回 true
 *  - list 的过滤条件只做等值匹配，undefined 的键自动忽略
 *
 * 若要修改本文件，api/ 与 settle/ 两份必须同步修改。
 */

function createCloudDb(database) {
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
    return res.data.map(norm);
  }

  async function getById(name, id) {
    if (!id) return null;
    try {
      const res = await col(name).doc(id).get();
      return norm(res.data);
    } catch (e) {
      return null; // 文档不存在时 SDK 会抛错，统一成 null
    }
  }

  async function insert(name, doc) {
    const data = Object.assign({}, doc);
    delete data.id;
    // users 集合以 openid 作为文档 _id，方便按身份直查
    if (name === 'users' && doc.id) data._id = doc.id;
    const res = await col(name).add({ data });
    return Object.assign({}, doc, { id: res._id });
  }

  async function update(name, id, patch) {
    const data = Object.assign({}, patch);
    delete data.id;
    delete data._id;
    await col(name).doc(id).update({ data });
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
  };
}

module.exports = createCloudDb;
