/*
 * 테스트용 가짜 Supabase — 인증 + ledgers 테이블(행 수준 보안 흉내)
 * 여러 "기기"(클라이언트)가 하나의 backend를 공유할 수 있음
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FakeSupabase = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  function createBackend() {
    return { users: new Map(), rows: new Map(), requests: 0, offline: false };
  }

  function createClient(backend, { delay = 0 } = {}) {
    let session = null;
    const listeners = [];
    const emit = (evt) => listeners.forEach((fn) => fn(evt, session));
    const wait = () => new Promise((r) => setTimeout(r, delay));
    const clone = (x) => (x == null ? x : JSON.parse(JSON.stringify(x)));
    const net = async () => {
      await wait();
      backend.requests++;
      if (backend.offline) throw new TypeError('Failed to fetch');
    };

    const auth = {
      async getSession() {
        return { data: { session }, error: null };
      },
      onAuthStateChange(fn) {
        listeners.push(fn);
        return { data: { subscription: { unsubscribe() {} } } };
      },
      async signUp({ email, password }) {
        await net();
        if (password.length < 6) return { data: {}, error: { message: 'Password should be at least 6 characters.' } };
        if (backend.users.has(email)) return { data: { user: { id: 'x', identities: [] }, session: null }, error: null };
        const user = { id: 'u-' + (backend.users.size + 1), email, identities: [{}] };
        backend.users.set(email, { user, password });
        session = { user, access_token: 't' };
        emit('SIGNED_IN');
        return { data: { user, session }, error: null };
      },
      async signInWithPassword({ email, password }) {
        await net();
        const u = backend.users.get(email);
        if (!u || u.password !== password) return { data: {}, error: { message: 'Invalid login credentials' } };
        session = { user: u.user, access_token: 't' };
        emit('SIGNED_IN');
        return { data: { user: u.user, session }, error: null };
      },
      async signInWithOtp() {
        await net();
        return { data: {}, error: null };
      },
      async signOut() {
        session = null;
        emit('SIGNED_OUT');
        return { error: null };
      },
    };

    function from(table) {
      if (table !== 'ledgers') throw new Error('unknown table ' + table);
      const uid = () => (session ? session.user.id : null);
      const q = { op: 'select', filters: [], payload: null };
      const match = (row) => q.filters.every(([k, v]) => row[k] === v);
      const exec = async () => {
        await net();
        const me = uid();
        if (!me) return { data: null, error: { message: 'JWT required' } };
        const visible = [...backend.rows.values()].filter((r) => r.owner === me); // RLS
        if (q.op === 'select') {
          const rows = visible.filter(match).map(clone);
          return { data: q.single ? rows[0] || null : rows, error: null };
        }
        if (q.op === 'insert') {
          if (q.payload.owner !== me) return { data: null, error: { code: '42501', message: 'RLS violation' } };
          if (backend.rows.has(me)) return { data: null, error: { code: '23505', message: 'duplicate key' } };
          backend.rows.set(me, { ...clone(q.payload), updated_at: new Date().toISOString() });
          return { data: null, error: null };
        }
        if (q.op === 'update') {
          const hit = visible.filter(match);
          hit.forEach((r) => Object.assign(r, clone(q.payload)));
          return { data: hit.map((r) => ({ version: r.version })), error: null };
        }
        return { data: null, error: { message: 'bad op' } };
      };
      const b = {
        select() {
          if (q.op === 'select') q.op = 'select';
          return b;
        },
        insert(payload) {
          q.op = 'insert';
          q.payload = payload;
          return b;
        },
        update(payload) {
          q.op = 'update';
          q.payload = payload;
          return b;
        },
        eq(k, v) {
          q.filters.push([k, v]);
          return b;
        },
        maybeSingle() {
          q.single = true;
          return b;
        },
        then(res, rej) {
          return exec().then(res, rej);
        },
      };
      return b;
    }

    return { auth, from, _setSession: (s) => (session = s) };
  }

  return { createBackend, createClient };
});
