/*
 * 로그인 + 클라우드 동기화 (Supabase)
 *
 * - 사용자마다 ledgers 테이블에 행 1개 (owner = 사용자 id, data = 가계부 전체 JSON, version = 낙관적 잠금용 번호)
 * - 행 수준 보안(RLS)으로 본인 행만 읽고 쓸 수 있음 (supabase/schema.sql)
 * - 여러 기기에서 동시에 고쳐도 항목별 updatedAt·삭제 표시로 합쳐서 저장 (mergeData)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Sync = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const TABLE = 'ledgers';
  const KINDS = [
    ['transactions', (x) => x.id],
    ['events', (x) => x.id],
    ['categories', (x) => x.name],
  ];

  /**
   * 두 데이터를 합침. 항목별로 더 최근(updatedAt)에 바뀐 쪽을 쓰고, 삭제 표시가 더 최근이면 지움.
   * 반환: { data, remoteChanged } — remoteChanged = 결과가 remote와 달라서 서버에 다시 올려야 함
   */
  function mergeData(local, remote) {
    if (!remote) return { data: local, remoteChanged: true };
    if (!local) return { data: remote, remoteChanged: false };
    let changed = false;
    const out = { ...remote, version: 1, deleted: {} };
    // 초기화·복원(resetAt) 이전의 항목은 버림 — 다른 기기의 옛 데이터가 되살아나지 않게
    const rl = local.resetAt || 0;
    const rr = remote.resetAt || 0;
    const resetAt = Math.max(rl, rr);
    out.resetAt = resetAt;
    if (rl > rr) changed = true;
    const staleL = (e) => rl < resetAt && (e.updatedAt || 0) < resetAt;
    const staleR = (e) => rr < resetAt && (e.updatedAt || 0) < resetAt;

    for (const [kind, keyOf] of KINDS) {
      const dl = (local.deleted && local.deleted[kind]) || {};
      const dr = (remote.deleted && remote.deleted[kind]) || {};
      const del = { ...dr };
      for (const k of Object.keys(dl)) {
        if (!(k in dr) || dl[k] > dr[k]) {
          del[k] = dl[k];
          changed = true;
        }
      }
      out.deleted[kind] = del;

      const map = new Map();
      for (const e of remote[kind] || []) {
        if (staleR(e)) {
          changed = true;
          continue;
        }
        map.set(keyOf(e), { e, src: 'r' });
      }
      for (const e of local[kind] || []) {
        if (staleL(e)) continue;
        const k = keyOf(e);
        const cur = map.get(k);
        if (!cur || (e.updatedAt || 0) > (cur.e.updatedAt || 0)) map.set(k, { e, src: 'l' });
      }
      const list = [];
      for (const [k, { e, src }] of map) {
        const t = del[k];
        if (t != null && t >= (e.updatedAt || 0)) {
          if (src === 'r') changed = true;
          continue;
        }
        if (src === 'l') changed = true;
        list.push(e);
      }
      out[kind] = list;
    }

    const sl = rl < resetAt && (local.settingsUpdatedAt || 0) < resetAt ? -1 : local.settingsUpdatedAt || 0;
    const sr = rr < resetAt && (remote.settingsUpdatedAt || 0) < resetAt ? -1 : remote.settingsUpdatedAt || 0;
    if (sr < 0 && sl >= 0) {
      out.settings = { ...local.settings };
      out.settingsUpdatedAt = local.settingsUpdatedAt || 0;
      changed = true;
    } else if (sl > sr) {
      out.settings = { ...local.settings };
      out.settingsUpdatedAt = local.settingsUpdatedAt;
      changed = true;
    }
    return { data: out, remoteChanged: changed };
  }

  const ERRORS = [
    [/invalid login credentials/i, '이메일 또는 비밀번호가 올바르지 않습니다.'],
    [/email not confirmed/i, '이메일 인증을 먼저 완료해 주세요. 받은편지함을 확인하세요.'],
    [/already registered|already been registered/i, '이미 가입된 이메일입니다. 로그인해 주세요.'],
    [/password should be at least|weak password|password is too short/i, '비밀번호는 6자 이상이어야 합니다.'],
    [/rate limit|too many requests|security purposes/i, '요청이 너무 많습니다. 잠시 후 다시 시도하세요.'],
    [/unable to validate email|invalid email|email address .* is invalid/i, '이메일 형식이 올바르지 않습니다.'],
    [/failed to fetch|network|fetch failed/i, '서버에 연결할 수 없습니다. 인터넷 연결을 확인하세요.'],
  ];
  function friendlyError(err) {
    const msg = (err && (err.message || err.error_description || String(err))) || '알 수 없는 오류';
    for (const [re, ko] of ERRORS) if (re.test(msg)) return ko;
    return msg;
  }

  /**
   * client: supabase-js 클라이언트 (또는 같은 모양의 가짜)
   * store:  Store 인스턴스
   * hooks:  { onStatus(status), onUser(user), onRemoteData(), confirm(message) → Promise<boolean>, redirectTo }
   * 상태: guest | pending | syncing | synced | offline | error
   */
  function createSync({ client, store, hooks = {} }) {
    const h = {
      onStatus() {},
      onUser() {},
      onRemoteData() {},
      confirm: async () => true,
      ...hooks,
    };
    const st = {
      user: null,
      base: 0, // 서버 행의 version (0 = 행 없음)
      pushedSeq: store.seq,
      force: false,
      pushing: false,
      again: false,
      timer: null,
      status: 'guest',
      lastSynced: null,
      lastError: null,
      handling: Promise.resolve(),
    };

    const setStatus = (s, err) => {
      st.status = s;
      st.lastError = err ? friendlyError(err) : null;
      if (s === 'synced') st.lastSynced = new Date();
      h.onStatus(s, st.lastError);
    };
    const dirty = () => store.seq > st.pushedSeq || st.force;
    const clone = (d) => JSON.parse(JSON.stringify(d));

    async function fetchRow() {
      const { data, error } = await client.from(TABLE).select('data, version').eq('owner', st.user.id).maybeSingle();
      if (error) throw error;
      return data;
    }

    async function login(user) {
      st.user = user;
      st.base = 0;
      store.useUser(user.id);
      st.pushedSeq = store.seq;
      h.onUser(user);
      h.onRemoteData();
      setStatus('syncing');
      try {
        const row = await fetchRow();
        let merged = store.data;
        let needPush = false;
        if (row) {
          const m = mergeData(store.data, row.data);
          merged = m.data;
          needPush = m.remoteChanged;
          st.base = row.version;
        } else {
          needPush = true;
        }

        // 로그인 전에 이 브라우저에 입력한 데이터
        const guest = store.peekGuest();
        if (guest && hasContent(guest) && !store.guestHandledFor(user.id)) {
          const ok = await h.confirm(
            `로그인 전에 이 브라우저에 기록한 데이터(거래 ${guest.transactions.length}건, 일정 ${guest.events.length}건)가 있습니다.\n계정 데이터에 합칠까요?\n\n[확인] 합치기 · [취소] 합치지 않고 이 브라우저에만 남겨두기`
          );
          if (ok) {
            const m = mergeData({ ...guest, resetAt: 0 }, merged); // 게스트 쪽 초기화 기록은 계정 데이터에 적용하지 않음
            merged = m.data;
            needPush = needPush || m.remoteChanged;
            store.clearGuest();
          } else {
            store.markGuestHandled(user.id);
          }
        }
        store.replaceLocal(merged);
        h.onRemoteData();
        if (needPush) {
          st.pushedSeq = store.seq - 1; // 강제로 dirty
          await push();
        } else {
          st.pushedSeq = store.seq;
          setStatus('synced');
        }
      } catch (e) {
        st.pushedSeq = -1; // 연결되면 올리기
        setStatus('offline', e);
      }
    }

    function localLogout() {
      const uid = st.user && st.user.id;
      st.user = null;
      st.base = 0;
      st.force = false;
      clearTimeout(st.timer);
      if (uid) store.clearUser(uid);
      store.useUser(null);
      st.pushedSeq = store.seq;
      h.onUser(null);
      h.onRemoteData();
      setStatus('guest');
    }

    function handleSession(session) {
      // 순서대로 처리 (로그인 처리 중에 다른 이벤트가 끼어들지 않게)
      st.handling = st.handling.then(async () => {
        const user = session && session.user ? session.user : null;
        if (user && st.user && user.id === st.user.id) return;
        if (!user) {
          if (st.user) localLogout();
          else if (store.userId) {
            // 세션이 만료됐는데 캐시가 남아 있는 경우
            store.clearUser(store.userId);
            store.useUser(null);
            h.onRemoteData();
          }
          h.onUser(null);
          setStatus('guest');
          return;
        }
        if (st.user) localLogout();
        await login(user);
      });
      return st.handling;
    }

    async function push() {
      if (!st.user) return;
      if (st.pushing) {
        st.again = true;
        return;
      }
      clearTimeout(st.timer);
      st.pushing = true;
      setStatus('syncing');
      try {
        for (let attempt = 0; attempt < 4; attempt++) {
          const seq = store.seq;
          const snapshot = clone(store.data);
          if (st.base === 0) {
            const { error } = await client.from(TABLE).insert({ owner: st.user.id, data: snapshot, version: 1 });
            if (!error) {
              st.base = 1;
              st.pushedSeq = seq;
              st.force = false;
              break;
            }
            if (error.code !== '23505') throw error; // 23505 = 다른 기기가 먼저 만듦 → 합치고 다시
          } else {
            const next = st.base + 1;
            let q = client
              .from(TABLE)
              .update({ data: snapshot, version: next, updated_at: new Date().toISOString() })
              .eq('owner', st.user.id);
            if (!st.force) q = q.eq('version', st.base);
            const { data: rows, error } = await q.select('version');
            if (error) throw error;
            if (rows && rows.length) {
              st.base = next;
              st.pushedSeq = seq;
              st.force = false;
              break;
            }
          }
          // 충돌: 다른 기기가 먼저 저장함 → 서버 데이터와 합쳐서 다시 시도
          const row = await fetchRow();
          if (!row) {
            st.base = 0;
            continue;
          }
          const m = mergeData(store.data, row.data);
          st.base = row.version;
          store.replaceLocal(m.data);
          h.onRemoteData();
          if (!m.remoteChanged) {
            st.pushedSeq = seq;
            break;
          }
        }
        setStatus(dirty() ? 'pending' : 'synced');
      } catch (e) {
        setStatus('offline', e);
      } finally {
        st.pushing = false;
        if (st.again) {
          st.again = false;
          push();
        } else if (dirty() && st.status === 'pending') {
          schedule();
        }
      }
    }

    function schedule(opts = {}) {
      if (!st.user) return;
      if (opts.force) st.force = true;
      clearTimeout(st.timer);
      st.timer = setTimeout(push, 1200);
      if (!st.pushing) setStatus('pending');
    }

    /** 다른 기기에서 바뀐 내용 가져오기 (창에 다시 들어올 때 등) */
    async function pull() {
      if (!st.user || st.pushing) return;
      try {
        const row = await fetchRow();
        if (!st.user) return;
        if (!row) {
          st.base = 0;
          return push();
        }
        if (row.version !== st.base) {
          const m = mergeData(store.data, row.data);
          st.base = row.version;
          const localDirty = dirty();
          store.replaceLocal(m.data);
          h.onRemoteData();
          if (m.remoteChanged || localDirty) {
            st.pushedSeq = Math.min(st.pushedSeq, store.seq - 1);
            return push();
          }
        } else if (dirty()) return push();
        setStatus('synced');
      } catch (e) {
        setStatus('offline', e);
      }
    }

    const redirectTo = () => h.redirectTo || (typeof location !== 'undefined' ? location.origin + location.pathname : undefined);

    const api = {
      get user() {
        return st.user;
      },
      get status() {
        return st.status;
      },
      get lastSynced() {
        return st.lastSynced;
      },
      get lastError() {
        return st.lastError;
      },
      get dirty() {
        return dirty();
      },
      async start() {
        store.onChange((opts) => {
          if (!opts.remote) schedule(opts);
        });
        const { data } = await client.auth.getSession();
        client.auth.onAuthStateChange((_event, session) => {
          // supabase 콜백 안에서 바로 요청하면 교착될 수 있어 다음 틱으로
          setTimeout(() => handleSession(session), 0);
        });
        await handleSession(data && data.session);
      },
      async signIn(email, password) {
        const { data, error } = await client.auth.signInWithPassword({ email, password });
        if (error) throw new Error(friendlyError(error));
        await handleSession(data.session);
        return data;
      },
      /** 반환: { needsConfirm } — 이메일 인증이 켜져 있으면 true */
      async signUp(email, password) {
        const { data, error } = await client.auth.signUp({ email, password, options: { emailRedirectTo: redirectTo() } });
        if (error) throw new Error(friendlyError(error));
        if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
          throw new Error('이미 가입된 이메일입니다. 로그인해 주세요.');
        }
        if (data.session) await handleSession(data.session);
        return { needsConfirm: !data.session };
      },
      async sendMagicLink(email) {
        const { error } = await client.auth.signInWithOtp({ email, options: { emailRedirectTo: redirectTo() } });
        if (error) throw new Error(friendlyError(error));
      },
      /** 동기화 안 된 변경이 있으면 먼저 올리고 로그아웃. 올리지 못하면 확인 후 진행 */
      async signOut() {
        if (dirty()) {
          await push();
          if (dirty() && !(await h.confirm('아직 서버에 저장되지 않은 변경이 있습니다. 로그아웃하면 이 변경은 사라집니다. 계속할까요?'))) return false;
        }
        try {
          await client.auth.signOut();
        } catch (e) {
          /* 오프라인이어도 이 브라우저에서는 로그아웃 */
        }
        await st.handling;
        if (st.user) localLogout();
        return true;
      },
      push,
      pull,
      flush: () => (dirty() ? push() : Promise.resolve()),
    };
    return api;
  }

  function hasContent(d) {
    return !!d && ((d.transactions && d.transactions.length) || (d.events && d.events.length));
  }

  return { mergeData, createSync, friendlyError, TABLE };
});
