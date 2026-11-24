/*
 * 데이터 저장소 — 브라우저 localStorage에 JSON으로 저장.
 * CSV/JSON 가져오기·내보내기 포함.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Store = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const KEY = 'gagyebu-calendar.v1';

  const DEFAULT_CATEGORIES = [
    // 고정·반복 지출 (이상 감지 대상)
    { name: '가스비', type: 'expense', recurring: true, color: '#e8590c' },
    { name: '전기비', type: 'expense', recurring: true, color: '#f59f00' },
    { name: '수도비', type: 'expense', recurring: true, color: '#1c7ed6' },
    { name: '관리비', type: 'expense', recurring: true, color: '#5c7cfa' },
    { name: '통신비', type: 'expense', recurring: true, color: '#7048e8' },
    { name: '주유비', type: 'expense', recurring: true, color: '#c2255c' },
    { name: '보험료', type: 'expense', recurring: true, color: '#495057' },
    // 변동 지출
    { name: '식비', type: 'expense', recurring: false, color: '#2f9e44' },
    { name: '외식/카페', type: 'expense', recurring: false, color: '#66a80f' },
    { name: '생활용품', type: 'expense', recurring: false, color: '#0ca678' },
    { name: '교통', type: 'expense', recurring: false, color: '#1098ad' },
    { name: '쇼핑', type: 'expense', recurring: false, color: '#d6336c' },
    { name: '의료', type: 'expense', recurring: false, color: '#f03e3e' },
    { name: '문화/여가', type: 'expense', recurring: false, color: '#ae3ec9' },
    { name: '경조사', type: 'expense', recurring: false, color: '#868e96' },
    { name: '항공', type: 'expense', recurring: false, color: '#339af0' },
    { name: '숙박', type: 'expense', recurring: false, color: '#9775fa' },
    { name: '기타', type: 'expense', recurring: false, color: '#adb5bd' },
    // 수입
    { name: '급여', type: 'income', recurring: false, color: '#1971c2' },
    { name: '부수입', type: 'income', recurring: false, color: '#4dabf7' },
    { name: '기타수입', type: 'income', recurring: false, color: '#a5d8ff' },
  ];

  const PALETTE = ['#e64980', '#be4bdb', '#7950f2', '#4c6ef5', '#228be6', '#15aabf', '#12b886', '#40c057', '#82c91e', '#fab005', '#fd7e14'];

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function emptyData() {
    return {
      version: 1,
      categories: DEFAULT_CATEGORIES.map((c) => ({ ...c })),
      transactions: [],
      events: [],
      settings: { warn: 0.15, alert: 0.3, lookback: 2 },
    };
  }

  /* ---------- CSV ---------- */
  function parseCSV(text) {
    const rows = [];
    let row = [];
    let field = '';
    let q = false;
    text = text.replace(/^﻿/, '');
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i++;
          } else q = false;
        } else field += c;
      } else if (c === '"') q = true;
      else if (c === ',') {
        row.push(field);
        field = '';
      } else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(field);
        rows.push(row);
        row = [];
        field = '';
      } else field += c;
    }
    if (field !== '' || row.length) {
      row.push(field);
      rows.push(row);
    }
    return rows.filter((r) => r.some((v) => v.trim() !== ''));
  }

  const csvCell = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const HEADER_ALIASES = {
    date: ['날짜', '일자', '거래일', '거래일자', '사용일', 'date'],
    type: ['구분', '유형', '수입/지출', 'type'],
    amount: ['금액', '거래금액', '사용금액', 'amount'],
    category: ['카테고리', '분류', '항목', 'category'],
    memo: ['메모', '내용', '적요', '사용처', '가맹점', 'memo', 'description'],
    tags: ['태그', 'tags'],
    event: ['일정', '여행', 'event', 'trip'],
  };

  function normalizeDate(s) {
    const m = String(s).trim().match(/(\d{4})[.\-/년\s]*(\d{1,2})[.\-/월\s]*(\d{1,2})/);
    if (!m) return null;
    return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  }

  /** CSV 텍스트 → { transactions, newCategories, errors } (data는 변경하지 않음) */
  function csvToTransactions(text, data) {
    const rows = parseCSV(text);
    if (!rows.length) return { transactions: [], newCategories: [], errors: ['빈 파일입니다.'] };
    const header = rows[0].map((h) => h.trim().toLowerCase());
    const col = {};
    for (const [key, names] of Object.entries(HEADER_ALIASES)) {
      col[key] = header.findIndex((h) => names.includes(h));
    }
    if (col.date < 0 || col.amount < 0) {
      return { transactions: [], newCategories: [], errors: ['헤더에 "날짜"와 "금액" 열이 필요합니다.'] };
    }
    const known = new Set(data.categories.map((c) => c.name));
    const eventByTitle = new Map(data.events.map((e) => [e.title, e.id]));
    const newCategories = [];
    const out = [];
    const errors = [];
    rows.slice(1).forEach((r, i) => {
      const get = (k) => (col[k] >= 0 ? (r[col[k]] || '').trim() : '');
      const date = normalizeDate(get('date'));
      let amount = Number(get('amount').replace(/[^\d.-]/g, ''));
      if (!date || !isFinite(amount) || amount === 0) {
        errors.push(`${i + 2}행: 날짜 또는 금액을 읽을 수 없습니다.`);
        return;
      }
      const typeRaw = get('type');
      let type = /수입|입금|income/i.test(typeRaw) ? 'income' : 'expense';
      if (!typeRaw && amount < 0) type = 'expense';
      amount = Math.abs(amount);
      const category = get('category') || (type === 'income' ? '기타수입' : '기타');
      if (!known.has(category)) {
        known.add(category);
        newCategories.push({ name: category, type, recurring: false, color: PALETTE[(known.size + newCategories.length) % PALETTE.length] });
      }
      const tags = get('tags') ? get('tags').split(/[;|#]/).map((s) => s.trim()).filter(Boolean) : [];
      out.push({ id: uid(), date, type, amount, category, memo: get('memo'), tags, eventId: eventByTitle.get(get('event')) || null });
    });
    return { transactions: out, newCategories, errors };
  }

  function transactionsToCSV(data) {
    const evById = new Map(data.events.map((e) => [e.id, e.title]));
    const lines = [['날짜', '구분', '금액', '카테고리', '메모', '태그', '일정'].join(',')];
    for (const t of [...data.transactions].sort((a, b) => a.date.localeCompare(b.date))) {
      lines.push(
        [t.date, t.type === 'income' ? '수입' : '지출', t.amount, t.category, t.memo, (t.tags || []).join(';'), evById.get(t.eventId) || '']
          .map(csvCell)
          .join(',')
      );
    }
    return '﻿' + lines.join('\n');
  }

  /* ---------- 저장소 ---------- */
  const GUEST_KEY = KEY;
  const ACTIVE_KEY = 'gagyebu-calendar.active-user';
  const userKey = (uid) => `${KEY}:user:${uid}`;
  const GUEST_HANDLED_KEY = (uid) => `${KEY}:guest-handled:${uid}`;
  const now = () => Date.now();

  function hasContent(d) {
    return !!d && ((d.transactions && d.transactions.length) || (d.events && d.events.length));
  }

  function migrate(d) {
    const base = emptyData();
    d.categories = Array.isArray(d.categories) && d.categories.length ? d.categories : base.categories;
    d.transactions = Array.isArray(d.transactions) ? d.transactions : [];
    d.events = Array.isArray(d.events) ? d.events : [];
    d.settings = { ...base.settings, ...(d.settings || {}) };
    const del = d.deleted || {};
    d.deleted = { transactions: del.transactions || {}, events: del.events || {}, categories: del.categories || {} };
    d.settingsUpdatedAt = d.settingsUpdatedAt || 0;
    d.resetAt = d.resetAt || 0;
    d.version = 1;
    return d;
  }

  /**
   * storage: localStorage 호환 객체 (없으면 메모리에만 보관)
   * 로그인하지 않으면 GUEST_KEY, 로그인하면 사용자별 키에 캐시
   */
  function createStore(storage) {
    const read = (k) => {
      try {
        return storage ? storage.getItem(k) : null;
      } catch (e) {
        return null;
      }
    };
    const write = (k, v) => {
      try {
        if (storage) storage.setItem(k, v);
      } catch (e) {
        console.warn('저장 실패', e);
      }
    };
    const remove = (k) => {
      try {
        if (storage) storage.removeItem(k);
      } catch (e) {
        /* 무시 */
      }
    };
    const readData = (k) => {
      const raw = read(k);
      if (!raw) return null;
      try {
        return migrate(JSON.parse(raw));
      } catch (e) {
        return null;
      }
    };

    const Store = {
      data: emptyData(),
      userId: null,
      key: GUEST_KEY,
      seq: 0, // 변경 횟수 (동기화 여부 판단용)
      listeners: [],

      /** 마지막으로 로그인한 사용자의 캐시(있으면) 또는 게스트 데이터를 불러옴 */
      load() {
        const active = read(ACTIVE_KEY);
        this.userId = active || null;
        this.key = active ? userKey(active) : GUEST_KEY;
        this.data = readData(this.key) || emptyData();
        return this.data;
      },

      /** 로그인/로그아웃 시 저장 위치 전환 */
      useUser(uid) {
        this.userId = uid || null;
        this.key = uid ? userKey(uid) : GUEST_KEY;
        if (uid) write(ACTIVE_KEY, uid);
        else remove(ACTIVE_KEY);
        this.data = readData(this.key) || emptyData();
        this.notify({ remote: true });
      },
      /** 로그아웃한 사용자의 캐시를 이 브라우저에서 삭제 */
      clearUser(uid) {
        remove(userKey(uid));
        if (read(ACTIVE_KEY) === uid) remove(ACTIVE_KEY);
      },
      peekGuest() {
        return readData(GUEST_KEY);
      },
      clearGuest() {
        remove(GUEST_KEY);
      },
      guestHandledFor(uid) {
        return read(GUEST_HANDLED_KEY(uid)) === '1';
      },
      markGuestHandled(uid) {
        write(GUEST_HANDLED_KEY(uid), '1');
      },

      hasSaved() {
        return !!read(this.key);
      },

      migrate,

      persist() {
        write(this.key, JSON.stringify(this.data));
      },
      notify(opts) {
        this.listeners.forEach((fn) => fn(opts || {}));
      },
      /** 사용자 변경 저장. opts.force = 서버 데이터를 통째로 덮어씀 (초기화·복원) */
      save(opts = {}) {
        this.seq++;
        this.persist();
        this.notify(opts);
      },
      /** 서버에서 받은 데이터 반영 (동기화 트리거 안 함) */
      replaceLocal(data) {
        this.data = migrate(data);
        this.persist();
        this.notify({ remote: true });
      },

      onChange(fn) {
        this.listeners.push(fn);
      },

      /** 통째로 바꾸기 (샘플·백업 복원). 다른 기기의 이전 데이터도 무효화됨 */
      replace(data) {
        this.data = migrate(data);
        this.data.resetAt = now();
        this.data.deleted = { transactions: {}, events: {}, categories: {} };
        this.save({ force: true });
      },

      reset() {
        this.replace(emptyData());
      },

      updateSettings(patch) {
        Object.assign(this.data.settings, patch);
        this.data.settingsUpdatedAt = now();
        this.save();
      },

      /* 카테고리 */
      category(name) {
        return this.data.categories.find((c) => c.name === name);
      },
      color(name) {
        const c = this.category(name);
        return c ? c.color : '#adb5bd';
      },
      ensureCategory(name, type) {
        if (!name || this.category(name)) return;
        this.data.categories.push({ name, type, recurring: false, color: PALETTE[this.data.categories.length % PALETTE.length], updatedAt: now() });
        delete this.data.deleted.categories[name];
      },
      addCategory(cat) {
        if (this.category(cat.name)) return false;
        this.data.categories.push({ recurring: false, color: PALETTE[this.data.categories.length % PALETTE.length], ...cat, updatedAt: now() });
        delete this.data.deleted.categories[cat.name];
        this.save();
        return true;
      },
      updateCategory(name, patch) {
        const c = this.category(name);
        if (!c) return;
        Object.assign(c, patch, { updatedAt: now() });
        this.save();
      },
      removeCategory(name) {
        if (this.data.transactions.some((t) => t.category === name)) return false;
        this.data.categories = this.data.categories.filter((c) => c.name !== name);
        this.data.deleted.categories[name] = now();
        this.save();
        return true;
      },

      /* 거래 */
      upsertTransaction(t) {
        this.ensureCategory(t.category, t.type);
        const stamp = now();
        if (t.id) {
          const i = this.data.transactions.findIndex((x) => x.id === t.id);
          if (i >= 0) this.data.transactions[i] = { ...this.data.transactions[i], ...t, updatedAt: stamp };
        } else {
          this.data.transactions.push({ ...t, id: uid(), updatedAt: stamp });
        }
        this.save();
      },
      deleteTransaction(id) {
        this.data.transactions = this.data.transactions.filter((t) => t.id !== id);
        this.data.deleted.transactions[id] = now();
        this.save();
      },

      /* 일정 (여행 포함) */
      event(id) {
        return this.data.events.find((e) => e.id === id);
      },
      upsertEvent(e) {
        let id = e.id;
        const stamp = now();
        if (id) {
          const i = this.data.events.findIndex((x) => x.id === id);
          if (i >= 0) this.data.events[i] = { ...this.data.events[i], ...e, updatedAt: stamp };
        } else {
          id = uid();
          this.data.events.push({ ...e, id, updatedAt: stamp });
        }
        this.save();
        return id;
      },
      deleteEvent(id) {
        const stamp = now();
        this.data.events = this.data.events.filter((e) => e.id !== id);
        this.data.deleted.events[id] = stamp;
        this.data.transactions.forEach((t) => {
          if (t.eventId === id) {
            t.eventId = null;
            t.updatedAt = stamp;
          }
        });
        this.save();
      },
      /** 일정이 겹치는 날짜의 지출을 연결 (고정비 제외, 이미 다른 일정에 연결된 것 제외) */
      linkTransactionsInRange(eventId) {
        const ev = this.event(eventId);
        if (!ev) return 0;
        const end = ev.endDate || ev.startDate;
        const stamp = now();
        let n = 0;
        for (const t of this.data.transactions) {
          if (t.type !== 'expense' || t.eventId) continue;
          if (t.date < ev.startDate || t.date > end) continue;
          const c = this.category(t.category);
          if (c && c.recurring && t.category !== '주유비') continue;
          t.eventId = eventId;
          t.updatedAt = stamp;
          n++;
        }
        if (n) this.save();
        return n;
      },
      /** 날짜가 걸치는 일정 */
      eventsOn(date) {
        return this.data.events.filter((e) => date >= e.startDate && date <= (e.endDate || e.startDate));
      },

      /* 가져오기/내보내기 */
      importCSV(text) {
        const res = csvToTransactions(text, this.data);
        const stamp = now();
        res.newCategories.forEach((c) => this.data.categories.push({ ...c, updatedAt: stamp }));
        res.transactions.forEach((t) => (t.updatedAt = stamp));
        this.data.transactions.push(...res.transactions);
        if (res.transactions.length || res.newCategories.length) this.save();
        return res;
      },
      exportCSV() {
        return transactionsToCSV(this.data);
      },
      exportJSON() {
        return JSON.stringify(this.data, null, 2);
      },
      importJSON(text) {
        const d = JSON.parse(text);
        if (!d || !Array.isArray(d.transactions)) throw new Error('올바른 백업 파일이 아닙니다.');
        this.replace(d);
      },
    };
    return Store;
  }

  const storage = typeof localStorage !== 'undefined' ? localStorage : null;
  const Store = createStore(storage);
  Store.createStore = createStore;
  Store.uid = uid;
  Store.emptyData = emptyData;
  Store.migrateData = migrate;
  Store.hasContent = hasContent;
  Store.parseCSV = parseCSV;
  Store.csvToTransactions = csvToTransactions;
  Store.transactionsToCSV = transactionsToCSV;
  Store.DEFAULT_CATEGORIES = DEFAULT_CATEGORIES;
  return Store;
});
