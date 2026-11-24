// 실행: node --test tests/*.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const Store = require('../js/store.js');
const Sync = require('../js/sync.js');
const Fake = require('./helpers/fake-supabase.js');

function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    keys: () => [...m.keys()],
  };
}

/** 기기 하나 = 브라우저 저장소 + Store + 가짜 supabase 클라이언트 + Sync */
function device(backend, { confirm = async () => true } = {}) {
  const storage = memoryStorage();
  const store = Store.createStore(storage);
  store.load();
  const client = Fake.createClient(backend);
  const sync = Sync.createSync({ client, store, hooks: { confirm, redirectTo: 'http://localhost/' } });
  return { storage, store, client, sync };
}
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const tx = (memo, amount = 1000) => ({ date: '2026-11-01', type: 'expense', amount, category: '식비', memo, tags: [], eventId: null });
const memos = (store) => store.data.transactions.map((t) => t.memo).sort();

/* ---------- mergeData ---------- */

test('merge: 양쪽에서 추가한 거래는 모두 남는다', () => {
  const base = Store.migrateData(Store.emptyData());
  const a = { ...base, transactions: [{ id: 'a', memo: 'A', updatedAt: 1 }] };
  const b = { ...base, transactions: [{ id: 'b', memo: 'B', updatedAt: 2 }] };
  const m = Sync.mergeData(a, b);
  assert.deepEqual(m.data.transactions.map((t) => t.id).sort(), ['a', 'b']);
  assert.equal(m.remoteChanged, true);
});

test('merge: 같은 거래는 더 최근에 고친 쪽이 이긴다', () => {
  const base = Store.migrateData(Store.emptyData());
  const a = { ...base, transactions: [{ id: 'x', memo: '로컬', updatedAt: 5 }] };
  const b = { ...base, transactions: [{ id: 'x', memo: '서버', updatedAt: 9 }] };
  assert.equal(Sync.mergeData(a, b).data.transactions[0].memo, '서버');
  assert.equal(Sync.mergeData(a, b).remoteChanged, false);
  assert.equal(Sync.mergeData(b, a).data.transactions[0].memo, '서버');
});

test('merge: 삭제 표시가 더 최근이면 지워지고, 이후에 고친 건 살아남는다', () => {
  const base = Store.migrateData(Store.emptyData());
  const del = { ...base, deleted: { transactions: { x: 10 }, events: {}, categories: {} } };
  const old = { ...base, transactions: [{ id: 'x', updatedAt: 5 }] };
  const newer = { ...base, transactions: [{ id: 'x', updatedAt: 20 }] };
  assert.equal(Sync.mergeData(del, old).data.transactions.length, 0);
  assert.equal(Sync.mergeData(del, newer).data.transactions.length, 1);
});

test('merge: 전체 초기화(resetAt) 이전의 다른 기기 데이터는 되살아나지 않는다', () => {
  const base = Store.migrateData(Store.emptyData());
  const resetSide = { ...base, resetAt: 100, transactions: [{ id: 'new', updatedAt: 150 }] };
  const staleSide = { ...base, resetAt: 0, transactions: [{ id: 'old', updatedAt: 50 }, { id: 'later', updatedAt: 120 }] };
  const ids = (m) => m.data.transactions.map((t) => t.id).sort();
  assert.deepEqual(ids(Sync.mergeData(staleSide, resetSide)), ['later', 'new']);
  assert.deepEqual(ids(Sync.mergeData(resetSide, staleSide)), ['later', 'new']);
});

/* ---------- 동기화 ---------- */

test('가입 → 거래 추가 → 다른 기기에서 로그인하면 같은 데이터', async () => {
  const backend = Fake.createBackend();
  const pc = device(backend);
  await pc.sync.start();
  await pc.sync.signUp('me@example.com', 'secret1');
  pc.store.upsertTransaction(tx('PC에서 입력'));
  await pc.sync.push();
  assert.equal(pc.sync.status, 'synced');

  const phone = device(backend);
  await phone.sync.start();
  await phone.sync.signIn('me@example.com', 'secret1');
  assert.deepEqual(memos(phone.store), ['PC에서 입력']);
});

test('다른 사용자는 서로의 데이터를 볼 수 없다', async () => {
  const backend = Fake.createBackend();
  const a = device(backend);
  await a.sync.start();
  await a.sync.signUp('a@example.com', 'secret1');
  a.store.upsertTransaction(tx('A의 지출'));
  await a.sync.push();

  const b = device(backend);
  await b.sync.start();
  await b.sync.signUp('b@example.com', 'secret1');
  b.store.upsertTransaction(tx('B의 지출'));
  await b.sync.push();
  assert.deepEqual(memos(b.store), ['B의 지출']);
  assert.equal(backend.rows.size, 2);

  await a.sync.pull();
  assert.deepEqual(memos(a.store), ['A의 지출']);
});

test('두 기기에서 동시에 고쳐도 둘 다 반영된다 (충돌 시 합치기)', async () => {
  const backend = Fake.createBackend();
  const pc = device(backend);
  await pc.sync.start();
  await pc.sync.signUp('me@example.com', 'secret1');
  pc.store.upsertTransaction(tx('처음'));
  await pc.sync.push();

  const phone = device(backend);
  await phone.sync.start();
  await phone.sync.signIn('me@example.com', 'secret1');

  // 서로 모르는 상태에서 각자 추가·삭제
  pc.store.upsertTransaction(tx('PC 추가'));
  const firstId = phone.store.data.transactions[0].id;
  await tick(2);
  phone.store.deleteTransaction(firstId);
  phone.store.upsertTransaction(tx('폰 추가'));
  await pc.sync.push();
  await phone.sync.push(); // 버전이 달라 충돌 → 합친 뒤 저장

  await pc.sync.pull();
  assert.deepEqual(memos(pc.store), ['PC 추가', '폰 추가']);
  assert.deepEqual(memos(phone.store), ['PC 추가', '폰 추가']);
  assert.deepEqual(backend.rows.get(pc.sync.user.id).data.transactions.map((t) => t.memo).sort(), ['PC 추가', '폰 추가']);
});

test('로그인 전 데이터는 확인 후 계정에 합치고, 거절하면 이 브라우저에만 남긴다', async () => {
  const backend = Fake.createBackend();
  const yes = device(backend, { confirm: async () => true });
  yes.store.upsertTransaction(tx('게스트 때 입력'));
  await yes.sync.start();
  await yes.sync.signUp('me@example.com', 'secret1');
  assert.deepEqual(memos(yes.store), ['게스트 때 입력']);
  assert.equal(yes.store.peekGuest(), null, '합친 뒤 게스트 데이터는 비움');

  const no = device(backend, { confirm: async () => false });
  no.store.upsertTransaction(tx('다른 사람의 게스트 데이터'));
  await no.sync.start();
  await no.sync.signIn('me@example.com', 'secret1');
  assert.deepEqual(memos(no.store), ['게스트 때 입력']);
  assert.equal(no.store.peekGuest().transactions.length, 1, '거절하면 게스트 데이터 보존');
});

test('로그아웃하면 이 브라우저에서 계정 데이터를 지우고 게스트로 돌아간다', async () => {
  const backend = Fake.createBackend();
  const d = device(backend);
  await d.sync.start();
  await d.sync.signUp('me@example.com', 'secret1');
  d.store.upsertTransaction(tx('계정 데이터'));
  const ok = await d.sync.signOut(); // 아직 안 올린 변경은 먼저 올림
  assert.equal(ok, true);
  assert.equal(d.sync.user, null);
  assert.equal(d.store.data.transactions.length, 0);
  assert.ok(!d.storage.keys().some((k) => k.includes(':user:')), '사용자 캐시 삭제');
  assert.equal(backend.rows.values().next().value.data.transactions.length, 1, '서버에는 남아 있음');
});

test('오프라인일 때 입력한 내용은 연결되면 올라간다', async () => {
  const backend = Fake.createBackend();
  const d = device(backend);
  await d.sync.start();
  await d.sync.signUp('me@example.com', 'secret1');
  backend.offline = true;
  d.store.upsertTransaction(tx('지하철에서 입력'));
  await d.sync.push();
  assert.equal(d.sync.status, 'offline');
  assert.match(d.sync.lastError, /연결/);
  backend.offline = false;
  await d.sync.pull();
  assert.equal(d.sync.status, 'synced');
  assert.equal(backend.rows.values().next().value.data.transactions[0].memo, '지하철에서 입력');
});

test('한 기기에서 전체 삭제하면 다른 기기의 옛 데이터가 되살아나지 않는다', async () => {
  const backend = Fake.createBackend();
  const pc = device(backend);
  await pc.sync.start();
  await pc.sync.signUp('me@example.com', 'secret1');
  pc.store.upsertTransaction(tx('옛 데이터'));
  await pc.sync.push();
  const phone = device(backend);
  await phone.sync.start();
  await phone.sync.signIn('me@example.com', 'secret1');
  assert.equal(phone.store.data.transactions.length, 1);

  await tick(2);
  pc.store.reset();
  await pc.sync.push();
  await phone.sync.pull();
  assert.equal(phone.store.data.transactions.length, 0);
  await pc.sync.pull();
  assert.equal(pc.store.data.transactions.length, 0);
});

test('로그인 오류 메시지는 한국어로', async () => {
  const backend = Fake.createBackend();
  const d = device(backend);
  await d.sync.start();
  await assert.rejects(d.sync.signIn('none@example.com', 'wrongpw'), /이메일 또는 비밀번호/);
  await assert.rejects(d.sync.signUp('me@example.com', '123'), /6자 이상/);
  await d.sync.signUp('me@example.com', 'secret1');
  await d.sync.signOut();
  await assert.rejects(d.sync.signUp('me@example.com', 'secret1'), /이미 가입된/);
});
