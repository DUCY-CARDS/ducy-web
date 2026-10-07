// Saved club tables (#107), in this browser's IndexedDB, so a hand in
// progress survives the host's tab closing or the browser restarting. One
// record per running table, keyed "<club code>/<table id>":
//   {key, json, ledgerN, seq, at}
// where json is ducy's MultiTable.save() (every card of the hand in
// progress: only this browser's host page reads it), ledgerN the table's
// newest ledger entry when it was saved (club-tables.js tableLedgerN), and
// seq the engine's state number.

const DB = 'ducy-tables', STORE = 'tables';

let dbp = null;
function db() {
  dbp ||= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, {keyPath: 'key'});
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { dbp = null; reject(req.error); };
  });
  return dbp;
}

function done(t) {
  return new Promise((resolve, reject) => { t.oncomplete = resolve; t.onerror = t.onabort = () => reject(t.error); });
}

const key = (code, tid) => `${code}/${tid}`;

// Resolves once the record is on disk.
export async function putTable(code, tid, rec) {
  const t = (await db()).transaction(STORE, 'readwrite', {durability: 'strict'});
  t.objectStore(STORE).put({...rec, key: key(code, tid)});
  return done(t);
}

export async function getTable(code, tid) {
  const t = (await db()).transaction(STORE, 'readonly');
  const req = t.objectStore(STORE).get(key(code, tid));
  await done(t);
  return req.result || null;
}

export async function dropTable(code, tid) {
  const t = (await db()).transaction(STORE, 'readwrite');
  t.objectStore(STORE).delete(key(code, tid));
  return done(t);
}
