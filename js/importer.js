/*
 * 거래 내역 파일 가져오기
 *  - 이 앱의 CSV, 카드사 이용내역, 은행 거래내역 CSV를 자동 구분
 *  - EUC-KR(CP949)·UTF-8 자동 판별, 상단 안내 문구가 있어도 헤더 행을 찾아냄
 *  - 카드 취소는 음수 지출(환불)로, 은행 출금/입금 열은 지출/수입으로
 *  - 이미 있는 거래와 같은 건 중복으로 건너뜀
 *  - 가맹점 이름으로 카테고리 추측 (이전에 직접 분류한 가맹점이 우선)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Importer = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------- 디코딩 ---------- */
  function decode(buffer) {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (e) {
      text = new TextDecoder('euc-kr').decode(bytes); // 국내 카드사·은행 기본 인코딩
    }
    return text.replace(/^﻿/, '');
  }

  /* ---------- CSV ---------- */
  function detectDelimiter(text) {
    const sample = text.split(/\r?\n/).slice(0, 30).join('\n');
    const count = (ch) => (sample.match(new RegExp(ch === '\t' ? '\t' : `\\${ch}`, 'g')) || []).length;
    const c = count(','), t = count('\t'), s = count(';');
    if (t > c && t >= s) return '\t';
    if (s > c && s > t) return ';';
    return ',';
  }

  function parseCSV(text, delim) {
    text = String(text).replace(/^﻿/, '');
    const d = delim || detectDelimiter(text);
    const rows = [];
    let row = [];
    let field = '';
    let q = false;
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
      else if (c === d) {
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

  /* ---------- 열 이름 ---------- */
  // 앞에 있을수록 우선. 공백·괄호는 무시하고 비교
  const COLS = {
    date: ['날짜', '일자', '거래일', '거래일자', '거래일시', '이용일', '이용일자', '이용일시', '승인일', '승인일자', '승인일시', '매출일', '매출일자', '사용일', '사용일자', '결제일자', 'date'],
    time: ['시간', '이용시간', '승인시간', '승인시각', '거래시간', 'time'],
    type: ['구분', '유형', '수입/지출', '입출금구분', '거래유형', 'type'],
    amount: ['금액', '이용금액', '승인금액', '거래금액', '사용금액', '매출금액', '결제금액', '원화금액', '이용원금', 'amount'],
    withdraw: ['출금액', '출금', '찾으신금액', '지급액', '출금금액', '인출금액'],
    deposit: ['입금액', '입금', '맡기신금액', '입금금액'],
    category: ['카테고리', '분류', '항목', 'category'],
    memo: ['메모', '내용', '적요', '사용처', '가맹점', '가맹점명', '이용가맹점', '이용하신가맹점', '이용처', '상호', '상호명', '거래처', '기재내용', '받는분', '보낸분', 'memo', 'description', 'merchant'],
    tags: ['태그', 'tags'],
    event: ['일정', '여행', 'event', 'trip'],
    cancel: ['취소여부', '승인구분', '취소구분', '상태', '매출구분', '거래구분', '승인상태'],
  };
  // 금액 열로 잘못 잡으면 안 되는 이름 (해외 현지 금액, 잔액, 포인트 등)
  const AMOUNT_EXCLUDE = /해외|현지|외화|달러|usd|잔액|포인트|수수료|할인|적립|예정|청구|수수료|이자|부가세/i;
  const MERCHANT_HEADERS = /가맹점|이용처|상호/;

  const norm = (h) => String(h).toLowerCase().replace(/[\s"'()\[\]]/g, '').replace(/\(원\)|원$/, '');

  function findColumns(header) {
    const H = header.map(norm);
    const used = new Set();
    const col = {};
    for (const [key, aliases] of Object.entries(COLS)) {
      let best = -1;
      let bestRank = Infinity;
      H.forEach((h, i) => {
        if (!h || used.has(i)) return;
        if ((key === 'amount' || key === 'withdraw' || key === 'deposit') && AMOUNT_EXCLUDE.test(h)) return;
        aliases.forEach((a, rank) => {
          const exact = h === a;
          // 정확히 같으면 우선, 아니면 포함(예: "이용금액(원)") — 짧은 별칭은 포함 매칭 안 함
          const r = exact ? rank : a.length >= 3 && h.includes(a) ? rank + 100 : Infinity;
          if (r < bestRank) {
            bestRank = r;
            best = i;
          }
        });
      });
      col[key] = best;
      if (best >= 0 && key !== 'type' && key !== 'cancel') used.add(best);
    }
    // "구분"이 취소 여부를 나타내는 경우도 있어 type과 cancel은 같은 열 허용
    if (col.cancel < 0 && col.type >= 0) col.cancel = col.type;
    return col;
  }

  function normalizeDate(s) {
    const str = String(s).trim();
    let m = str.match(/^(\d{4})\s*[.\-/년]\s*(\d{1,2})\s*[.\-/월]\s*(\d{1,2})/);
    if (!m) m = str.match(/^(\d{4})(\d{2})(\d{2})(?!\d)/); // 20261103
    if (!m) {
      const y2 = str.match(/^(\d{2})\s*[.\-/]\s*(\d{1,2})\s*[.\-/]\s*(\d{1,2})(?!\d)/); // 26.11.03
      if (y2) m = [y2[0], `20${y2[1]}`, y2[2], y2[3]];
    }
    if (!m) return null;
    const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1990 || y > 2100) return null;
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }

  function parseAmount(s) {
    const str = String(s || '').trim();
    if (!str) return null;
    const neg = /^\(.*\)$/.test(str) || /^-|^−|-$/.test(str.replace(/[원\s,]/g, ''));
    const digits = str.replace(/[^\d.]/g, '');
    if (!digits) return null;
    const n = Number(digits);
    if (!isFinite(n)) return null;
    return neg ? -n : n;
  }

  /** 헤더 행 찾기: 날짜 열과 금액(또는 입·출금) 열이 있는 첫 행 */
  function findHeader(rows) {
    for (let i = 0; i < Math.min(rows.length, 40); i++) {
      const col = findColumns(rows[i]);
      if (col.date >= 0 && (col.amount >= 0 || col.withdraw >= 0 || col.deposit >= 0)) return { index: i, col };
    }
    return null;
  }

  /* ---------- 카테고리 추측 ---------- */
  const RULES = [
    ['주유비', /주유|칼텍스|gs칼텍스|sk에너지|s-oil|에쓰오일|오일뱅크|알뜰주유|충전소|ev충전|전기차충전/i],
    ['가스비', /도시가스|가스공사|삼천리|예스코|코원에너지|서울도시가스|귀뚜라미/i],
    ['전기비', /한전|한국전력|전기요금/i],
    ['수도비', /수도|상수도|수자원/i],
    ['관리비', /관리비|관리사무소/i],
    ['통신비', /skt|sk텔레콤|kt\b|케이티|lg\s?u\+|유플러스|lgu|알뜰폰|헬로모바일|통신|인터넷요금|sk브로드밴드/i],
    ['보험료', /보험|화재|생명|손해/i],
    ['항공', /항공|airline|air\b|대한항공|아시아나|제주항공|진에어|티웨이|에어부산|이스타|에어서울|파라타/i],
    ['숙박', /호텔|모텔|리조트|펜션|게스트하우스|숙박|에어비앤비|airbnb|agoda|아고다|booking|부킹|야놀자|여기어때|hotels/i],
    ['외식/카페', /스타벅스|starbucks|커피|카페|cafe|투썸|이디야|메가엠지씨|메가커피|빽다방|컴포즈|폴바셋|배달의민족|배민|요기요|쿠팡이츠|맥도날드|버거|롯데리아|kfc|치킨|피자|베이커리|파리바게뜨|뚜레쥬르|식당|음식|분식|김밥|국밥|고기|횟집|주점|호프|레스토랑/i],
    ['식비', /이마트|홈플러스|롯데마트|코스트코|트레이더스|하나로|마트|슈퍼|컬리|쿠팡프레시|정육|청과|시장|반찬|gs더프레시|노브랜드/i],
    ['생활용품', /다이소|올리브영|생활|무인양품|이케아|ikea|세탁/i],
    ['교통', /택시|카카오t|카카오모빌리티|티머니|t-money|교통|코레일|ktx|srt|지하철|버스|고속|하이패스|도로공사|주차|쏘카|그린카|따릉이/i],
    ['의료', /병원|의원|약국|치과|한의원|안과|피부과|내과|정형외과|이비인후과|소아과|의료/i],
    ['문화/여가', /cgv|메가박스|롯데시네마|넷플릭스|netflix|유튜브|youtube|멜론|지니|스포티파이|spotify|디즈니|티빙|웨이브|왓챠|쿠팡플레이|교보문고|yes24|알라딘|영풍|공연|전시|티켓|인터파크|헬스|피트니스|수영|골프|볼링|노래|pc방/i],
    ['쇼핑', /쿠팡|11번가|g마켓|지마켓|옥션|위메프|티몬|ssg|무신사|29cm|지그재그|에이블리|네이버페이|스마트스토어|백화점|아울렛|유니클로|자라|h&m|나이키|아디다스|이랜드|오늘의집/i],
    ['교육', /학원|교습|과외|인강|클래스101|유데미|udemy|교육/i],
    ['경조사', /축의|조의|부의|경조/i],
  ];
  const CARD_PAYMENT = /카드\s*(대금|결제|출금)|^(신한|삼성|현대|국민|kb|롯데|하나|우리|bc|비씨|nh|농협)\s*카드$|카드론|결제대금/i;

  const memoKey = (m) => String(m || '').trim().replace(/\s+/g, ' ').toLowerCase();

  function historyMap(data) {
    const counts = new Map();
    for (const t of data.transactions || []) {
      if (!t.memo || !t.category || t.category === '기타' || t.category === '기타수입') continue;
      const k = memoKey(t.memo);
      const m = counts.get(k) || new Map();
      m.set(t.category, (m.get(t.category) || 0) + 1);
      counts.set(k, m);
    }
    const out = new Map();
    for (const [k, m] of counts) out.set(k, [...m.entries()].sort((a, b) => b[1] - a[1])[0][0]);
    return out;
  }

  function guessCategory(memo, type, history) {
    const k = memoKey(memo);
    if (history && history.has(k)) return { category: history.get(k), source: 'history' };
    if (type === 'income') return { category: /급여|월급|salary|상여/i.test(memo) ? '급여' : '기타수입', source: 'rule' };
    for (const [cat, re] of RULES) if (re.test(memo)) return { category: cat, source: 'rule' };
    return { category: '기타', source: 'none' };
  }

  /* ---------- 분석 ---------- */
  const FORMAT_LABEL = { ledger: '가계부 CSV', card: '카드 이용내역', bank: '은행 거래내역' };

  /**
   * 파일 내용을 분석해 미리보기용 결과를 돌려줌 (data는 바꾸지 않음)
   */
  function analyze(text, data) {
    const rows = parseCSV(text);
    const empty = { format: null, rows: [], errors: [], duplicates: 0, cardPayments: [], merchants: [], header: null };
    if (!rows.length) return { ...empty, errors: ['빈 파일입니다.'] };
    const found = findHeader(rows);
    if (!found) {
      return { ...empty, errors: ['날짜와 금액 열을 찾지 못했습니다. 첫 줄(또는 상단)에 "날짜/이용일자", "금액/이용금액" 같은 열 이름이 있어야 합니다.'] };
    }
    const { index, col } = found;
    const header = rows[index];
    const body = rows.slice(index + 1);
    const get = (r, k) => (col[k] >= 0 ? String(r[col[k]] == null ? '' : r[col[k]]).trim() : '');

    let format = 'ledger';
    if (col.withdraw >= 0 || col.deposit >= 0) format = 'bank';
    else if (col.category < 0 && (MERCHANT_HEADERS.test(header[col.memo] || '') || /이용|승인|매출/.test(header[col.amount] || '') || /이용|승인|매출/.test(header[col.date] || '')))
      format = 'card';

    // 부호만으로 입출금을 나타내는 은행 파일 (예: 거래금액 -5000 / +30000)
    let signed = false;
    if (format === 'ledger' && col.type < 0 && col.amount >= 0) {
      let pos = 0, neg = 0;
      for (const r of body) {
        const a = parseAmount(get(r, 'amount'));
        if (a > 0) pos++;
        else if (a < 0) neg++;
      }
      if (pos && neg) {
        signed = true;
        format = 'bank';
      }
    }

    const knownEvents = new Map((data.events || []).map((e) => [e.title, e.id]));
    const out = [];
    const errors = [];
    body.forEach((r, i) => {
      const line = index + i + 2;
      const date = normalizeDate(get(r, 'date'));
      if (!date) {
        if (r.some((v) => String(v).trim()) && !/합계|소계|총|total/i.test(r.join(''))) errors.push(`${line}행: 날짜를 읽을 수 없습니다 (${String(get(r, 'date')).slice(0, 20) || '빈 칸'})`);
        return;
      }
      const memo = get(r, 'memo');
      const typeRaw = get(r, 'type');
      const cancelRaw = col.cancel >= 0 ? get(r, 'cancel') : '';
      let type;
      let amount;

      if (format === 'bank' && !signed) {
        const w = parseAmount(get(r, 'withdraw')) || 0;
        const dep = parseAmount(get(r, 'deposit')) || 0;
        if (w && !dep) {
          type = 'expense';
          amount = Math.abs(w);
        } else if (dep && !w) {
          type = 'income';
          amount = Math.abs(dep);
        } else if (col.amount >= 0) {
          const a = parseAmount(get(r, 'amount'));
          if (a == null || a === 0) return;
          type = /입금|수입/.test(typeRaw) ? 'income' : 'expense';
          amount = Math.abs(a);
        } else return; // 0원 행
      } else {
        const a = parseAmount(get(r, 'amount'));
        if (a == null || a === 0) {
          if (a == null) errors.push(`${line}행: 금액을 읽을 수 없습니다`);
          return;
        }
        if (format === 'card') {
          type = 'expense';
          const cancelled = /취소|환불|반품/.test(cancelRaw) || /취소|환불/.test(typeRaw);
          amount = cancelled || a < 0 ? -Math.abs(a) : Math.abs(a); // 취소 = 음수 지출 (그 달 지출에서 빠짐)
        } else if (signed) {
          type = a < 0 ? 'expense' : 'income';
          amount = Math.abs(a);
        } else {
          type = /수입|입금|income/i.test(typeRaw) ? 'income' : 'expense';
          amount = Math.abs(a);
        }
      }
      const tags = get(r, 'tags') ? get(r, 'tags').split(/[;|#]/).map((s) => s.trim()).filter(Boolean) : [];
      out.push({
        line,
        date,
        type,
        amount,
        memo,
        category: get(r, 'category') || null,
        tags,
        eventId: knownEvents.get(get(r, 'event')) || null,
        refund: format === 'card' && amount < 0,
      });
    });

    // 중복: 이미 있는 거래와 날짜·구분·금액·메모가 같으면 건너뜀 (같은 파일 안의 동일 거래는 유지)
    const key = (t) => `${t.date}|${t.type}|${t.amount}|${memoKey(t.memo)}`;
    const existing = new Map();
    for (const t of data.transactions || []) existing.set(key(t), (existing.get(key(t)) || 0) + 1);
    let duplicates = 0;
    const fresh = [];
    for (const t of out) {
      const n = existing.get(key(t)) || 0;
      if (n > 0) {
        existing.set(key(t), n - 1);
        duplicates++;
      } else fresh.push(t);
    }

    // 은행 파일의 카드대금 출금은 카드 내역과 이중으로 잡히므로 따로 분리
    const cardPayments = format === 'bank' ? fresh.filter((t) => t.type === 'expense' && CARD_PAYMENT.test(t.memo.trim())) : [];

    // 가맹점별 카테고리 추측
    const history = historyMap(data);
    const merchants = new Map();
    for (const t of fresh) {
      if (t.category) continue;
      const k = `${t.type}|${memoKey(t.memo)}`;
      const m = merchants.get(k) || { key: k, memo: t.memo || '(내용 없음)', type: t.type, count: 0, total: 0, ...guessCategory(t.memo, t.type, history) };
      m.count++;
      m.total += t.amount;
      merchants.set(k, m);
      t.merchantKey = k;
    }

    const dates = fresh.map((t) => t.date).sort();
    return {
      format,
      formatLabel: FORMAT_LABEL[format],
      header: { row: index + 1, columns: Object.fromEntries(Object.entries(col).filter(([, v]) => v >= 0).map(([k, v]) => [k, header[v]])) },
      rows: fresh,
      duplicates,
      cardPayments,
      errors,
      merchants: [...merchants.values()].sort((a, b) => b.count - a.count || Math.abs(b.total) - Math.abs(a.total)),
      period: dates.length ? { start: dates[0], end: dates[dates.length - 1] } : null,
    };
  }

  /**
   * 미리보기 결과 → 실제로 추가할 거래 목록
   * opts.categories: { merchantKey: 카테고리 } (화면에서 고친 값)
   * opts.skipCardPayments: 카드대금 출금 제외 (기본 true)
   * opts.linkTrips: 여행 기간의 지출을 여행에 연결 (기본 true)
   * opts.uid: id 생성 함수
   */
  function build(analysis, data, opts = {}) {
    const skip = opts.skipCardPayments !== false ? new Set(analysis.cardPayments) : new Set();
    const chosen = opts.categories || {};
    const merchantCat = new Map(analysis.merchants.map((m) => [m.key, chosen[m.key] || m.category]));
    const known = new Set((data.categories || []).map((c) => c.name));
    const recurring = new Set((data.categories || []).filter((c) => c.recurring).map((c) => c.name));
    const trips = opts.linkTrips === false ? [] : (data.events || []).filter((e) => e.kind === 'trip');
    const uid = opts.uid || (() => Math.random().toString(36).slice(2));
    const newCategories = [];
    const transactions = [];
    for (const r of analysis.rows) {
      if (skip.has(r)) continue;
      const category = r.category || merchantCat.get(r.merchantKey) || (r.type === 'income' ? '기타수입' : '기타');
      if (!known.has(category)) {
        known.add(category);
        newCategories.push({ name: category, type: r.type, recurring: false });
      }
      let eventId = r.eventId;
      if (!eventId && r.type === 'expense' && (!recurring.has(category) || category === '주유비')) {
        const trip = trips.find((e) => r.date >= e.startDate && r.date <= (e.endDate || e.startDate));
        if (trip) eventId = trip.id;
      }
      const tags = r.refund && !r.tags.includes('취소') ? [...r.tags, '취소'] : r.tags;
      transactions.push({ id: uid(), date: r.date, type: r.type, amount: r.amount, category, memo: r.memo, tags, eventId: eventId || null });
    }
    return { transactions, newCategories };
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

  return { decode, parseCSV, detectDelimiter, findColumns, normalizeDate, parseAmount, guessCategory, analyze, build, transactionsToCSV, FORMAT_LABEL };
});
