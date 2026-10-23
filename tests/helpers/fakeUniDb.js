/**
 * fakeUniDb.js —— uniCloud.database() 原始 API 的内存 fake（仅供本地测试）
 *
 * 与 memoryDb（已适配接口）不同，本 fake 模拟的是 uniCloud 服务端
 * 数据库的「原始」链式 API：
 *   db.collection(name).where({...}).limit(n).get() → { data: [...] }
 *   db.collection(name).doc(id).get() / .update(data) / .remove()
 *   db.collection(name).add(data) → { id }
 * 用它顶替 uniCloud.database() 来验证 uniCloud/cloudfunctions/api/uniDb.js
 * 适配层的映射逻辑（_id ↔ id、users 以 openid 作 _id、过滤与 limit）。
 */

function clone(obj) {
  return obj == null ? obj : JSON.parse(JSON.stringify(obj));
}

function createFakeUniDb(seed) {
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
  let seq = 5000;

  function matches(doc, where) {
    return Object.keys(where || {}).every((k) => doc[k] === where[k]);
  }

  function collection(name) {
    const store = data[name];
    if (!store) throw new Error('unknown collection: ' + name);
    let where = null;
    let limitN = Infinity;
    const query = {
      where(w) {
        where = w;
        return query;
      },
      limit(n) {
        limitN = n;
        return query;
      },
      async get() {
        let rows = store.filter((d) => matches(d, where));
        if (limitN !== Infinity) rows = rows.slice(0, limitN);
        return { data: rows.map(clone) };
      },
      doc(id) {
        return {
          async get() {
            const found = store.find((d) => d._id === id);
            if (!found) throw new Error('document not found');
            return { data: [clone(found)] };
          },
          async update(patch) {
            const found = store.find((d) => d._id === id);
            if (found) Object.assign(found, clone(patch));
            return { updated: found ? 1 : 0 };
          },
          async remove() {
            const idx = store.findIndex((d) => d._id === id);
            if (idx >= 0) store.splice(idx, 1);
            return { deleted: idx >= 0 ? 1 : 0 };
          },
        };
      },
      async add(doc) {
        const stored = clone(doc) || {};
        if (!stored._id) {
          seq += 1;
          stored._id = name + '_' + seq;
        }
        store.push(stored);
        return { id: stored._id };
      },
    };
    return query;
  }

  if (seed) {
    Object.keys(data).forEach((name) => {
      (seed[name] || []).forEach((doc) => {
        const stored = clone(doc);
        if (!stored._id && stored.id) stored._id = stored.id;
        if (!stored._id) {
          seq += 1;
          stored._id = name + '_' + seq;
        }
        data[name].push(stored);
      });
    });
  }

  return { collection, _data: data };
}

module.exports = createFakeUniDb;
