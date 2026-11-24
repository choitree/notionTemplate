/*
 * 분석 로직 (순수 함수) — 브라우저(window.Analytics)와 Node(require) 양쪽에서 사용.
 *
 * 데이터 형태
 *   transaction: { id, date:'YYYY-MM-DD', type:'expense'|'income', amount, category, memo, tags:[], eventId }
 *   event:       { id, kind:'trip'|'event', title, destination, startDate, endDate, memo, tags:[] }
 *   category:    { name, type:'expense'|'income', recurring:boolean, color }
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Analytics = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const yearOf = (d) => Number(d.slice(0, 4));
  const monthOf = (d) => Number(d.slice(5, 7));
  const dayOf = (d) => Number(d.slice(8, 10));
  const pad = (n) => String(n).padStart(2, '0');
  const sum = (arr) => arr.reduce((a, b) => a + b, 0);
  const mean = (arr) => (arr.length ? sum(arr) / arr.length : 0);

  function toDate(s) {
    const [y, m, d] = s.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d));
  }

  /** 시작일~종료일 포함 일수 (3박4일 → 4) */
  function daysInclusive(start, end) {
    if (!start) return 0;
    const e = end && end >= start ? end : start;
    return Math.round((toDate(e) - toDate(start)) / 86400000) + 1;
  }

  function filterTx(txs, { type = 'expense', year, month, category, categories } = {}) {
    return txs.filter(
      (t) =>
        (!type || t.type === type) &&
        (year == null || yearOf(t.date) === year) &&
        (month == null || monthOf(t.date) === month) &&
        (category == null || t.category === category) &&
        (categories == null || categories.includes(t.category))
    );
  }

  /** 연도별 월 합계 → [12] */
  function monthlyTotals(txs, year, opts = {}) {
    const out = new Array(12).fill(0);
    for (const t of filterTx(txs, { ...opts, year })) out[monthOf(t.date) - 1] += t.amount;
    return out;
  }

  /** { 2024: 합계, ... } */
  function yearlyTotals(txs, opts = {}) {
    const out = {};
    for (const t of filterTx(txs, opts)) {
      const y = yearOf(t.date);
      out[y] = (out[y] || 0) + t.amount;
    }
    return out;
  }

  /** [{category, total, count}] 금액 내림차순 */
  function categoryTotals(txs, opts = {}) {
    const map = new Map();
    for (const t of filterTx(txs, opts)) {
      const cur = map.get(t.category) || { category: t.category, total: 0, count: 0 };
      cur.total += t.amount;
      cur.count += 1;
      map.set(t.category, cur);
    }
    return [...map.values()].sort((a, b) => b.total - a.total);
  }

  /** 해당 월의 일별 합계 { 1: {expense, income}, ... } */
  function dailyTotals(txs, year, month) {
    const out = {};
    for (const t of txs) {
      if (yearOf(t.date) !== year || monthOf(t.date) !== month) continue;
      const d = dayOf(t.date);
      out[d] = out[d] || { expense: 0, income: 0 };
      out[d][t.type] += t.amount;
    }
    return out;
  }

  function yearsWithData(txs) {
    return [...new Set(txs.map((t) => yearOf(t.date)))].sort((a, b) => a - b);
  }

  /** 일정(여행 등) 요약: 기간, 총지출, 1일 평균, 카테고리별 */
  function eventSummary(ev, txs) {
    const linked = txs.filter((t) => t.eventId === ev.id);
    const expenses = linked.filter((t) => t.type === 'expense');
    const total = sum(expenses.map((t) => t.amount));
    const days = daysInclusive(ev.startDate, ev.endDate);
    return {
      days,
      nights: Math.max(0, days - 1),
      total,
      perDay: days ? Math.round(total / days) : 0,
      count: linked.length,
      byCategory: categoryTotals(expenses, { type: 'expense' }),
      transactions: linked.sort((a, b) => a.date.localeCompare(b.date)),
      year: ev.startDate ? yearOf(ev.startDate) : null,
    };
  }

  function periodLabel(days) {
    if (days <= 1) return '당일';
    return `${days - 1}박 ${days}일`;
  }

  /**
   * 고정비(반복 지출) 이상 여부 판단
   *
   * - 기준값: 같은 달의 이전 N년(기본 2년) 금액 평균
   * - 추세 보정: 올해 1~(m-1)월 합계 / 이전 연도 같은 기간 합계 평균 (요금 인상·사용 패턴 변화 반영)
   *   3개월 이상 데이터가 있을 때만 적용, 0.7~1.5 사이로 제한
   * - 계절성: 이전 연도에서 이 달이 그 해 월평균 대비 몇 배였는지 (난방비 겨울 상승 등)
   */
  function analyzeRecurring(txs, category, year, month, opts = {}) {
    const warn = opts.warn ?? 0.15;
    const alert = opts.alert ?? 0.3;
    const lookback = opts.lookback ?? 2;
    const catTx = txs.filter((t) => t.type === 'expense' && t.category === category);
    const yrs = new Set(catTx.map((t) => yearOf(t.date)));

    const series = (y) => monthlyTotals(catTx, y, { type: 'expense' });
    const cur = series(year);
    const actual = cur[month - 1];

    const baseline = [];
    for (let i = 1; i <= lookback; i++) {
      const y = year - i;
      if (!yrs.has(y)) continue;
      const s = series(y);
      const active = s.filter((v) => v > 0);
      baseline.push({
        year: y,
        value: s[month - 1],
        yearMean: active.length ? mean(active) : 0,
        priorSum: sum(s.slice(0, month - 1)),
      });
    }

    const result = {
      category,
      year,
      month,
      actual,
      baseline,
      expected: null,
      adjustedExpected: null,
      reference: null,
      trendFactor: null,
      seasonalIndex: null,
      min: null,
      max: null,
      diff: null,
      eventAmount: 0,
      diffExcludingEvents: null,
      status: 'nodata',
    };
    // 여행·일정에 연결된 지출 (예: 여행 중 주유)
    result.eventAmount = sum(
      catTx.filter((t) => t.eventId && yearOf(t.date) === year && monthOf(t.date) === month).map((t) => t.amount)
    );
    if (!baseline.length) return result;

    const values = baseline.map((b) => b.value);
    result.expected = mean(values);
    result.min = Math.min(...values);
    result.max = Math.max(...values);

    // 계절성 지수: 예년 이 달 / 예년 월평균
    const idx = baseline.filter((b) => b.yearMean > 0).map((b) => b.value / b.yearMean);
    result.seasonalIndex = idx.length ? mean(idx) : null;

    // 추세 보정
    const priorMonthsWithData = cur.slice(0, month - 1).filter((v) => v > 0).length;
    const basePrior = mean(baseline.map((b) => b.priorSum));
    if (priorMonthsWithData >= 3 && basePrior > 0) {
      const f = sum(cur.slice(0, month - 1)) / basePrior;
      result.trendFactor = Math.min(1.5, Math.max(0.7, f));
      result.adjustedExpected = result.expected * result.trendFactor;
    }

    const ref = result.adjustedExpected ?? result.expected;
    result.reference = ref;

    if (actual === 0) {
      result.status = ref > 0 ? 'missing' : 'ok';
      result.diff = ref > 0 ? -1 : 0;
      return result;
    }
    if (ref === 0) {
      result.status = 'new';
      return result;
    }
    const diff = (actual - ref) / ref;
    result.diff = diff;
    if (result.eventAmount > 0) result.diffExcludingEvents = (actual - result.eventAmount - ref) / ref;
    if (diff > alert) result.status = 'alert';
    else if (diff > warn) result.status = 'warn';
    else if (diff < -alert) result.status = 'low';
    else result.status = 'ok';
    if ((result.status === 'alert' || result.status === 'warn') && result.diffExcludingEvents != null && result.diffExcludingEvents <= warn) {
      result.status = 'event'; // 여행·일정 때문에 늘어난 경우
    }
    return result;
  }

  const STATUS_LABEL = {
    alert: '경고',
    warn: '주의',
    ok: '정상',
    low: '평소보다 적음',
    missing: '미납/미기록',
    new: '신규 지출',
    event: '일정 영향',
    nodata: '비교 데이터 없음',
  };

  /** 사람이 읽을 수 있는 설명 문장 */
  function explain(r) {
    const won = (n) => `${Math.round(n).toLocaleString('ko-KR')}원`;
    const pct = (x) => `${x >= 0 ? '+' : ''}${Math.round(x * 100)}%`;
    if (r.status === 'nodata') return `${r.month}월 ${r.category}: 이전 연도 데이터가 없어 비교할 수 없습니다.`;
    const lines = [];
    const prev = r.baseline.map((b) => `${b.year}년 ${won(b.value)}`).join(', ');
    if (r.status === 'missing') {
      lines.push(`${r.month}월 ${r.category} 지출이 아직 없습니다. (예년: ${prev})`);
      return lines.join(' ');
    }
    lines.push(`${r.year}년 ${r.month}월 ${r.category} ${won(r.actual)} — 예년 같은 달(${prev}) 평균 ${won(r.expected)}.`);
    if (r.trendFactor != null && Math.abs(r.trendFactor - 1) >= 0.03) {
      lines.push(`올해 1~${r.month - 1}월 추세(${pct(r.trendFactor - 1)})를 반영한 예상치는 ${won(r.adjustedExpected)}입니다.`);
    }
    if (r.diff != null && r.status !== 'new') lines.push(`예상 대비 ${pct(r.diff)}.`);
    if (r.seasonalIndex != null) {
      if (r.seasonalIndex >= 1.2)
        lines.push(`이 달은 예년에도 월평균의 ${r.seasonalIndex.toFixed(1)}배였던 계절적 상승 시기입니다.`);
      else if (r.seasonalIndex <= 0.8 && (r.status === 'alert' || r.status === 'warn'))
        lines.push(`예년에는 지출이 적었던 달(월평균의 ${r.seasonalIndex.toFixed(1)}배)이라 상승 시점이 평소보다 이른/다른 패턴입니다.`);
    }
    const eventExplains = r.status === 'event';
    if (r.eventAmount > 0)
      lines.push(`이 중 ${won(r.eventAmount)}은 여행·일정에 연결된 지출입니다${eventExplains ? ` (제외하면 ${pct(r.diffExcludingEvents)}로 정상 범위)` : ''}.`);
    if (eventExplains) lines.push('일정 때문에 늘어난 것으로 보입니다.');
    else if (r.status === 'alert') lines.push('확인이 필요합니다 (누수·요금제 변경·사용량 급증 등).');
    else if (r.status === 'warn') lines.push('조금 높은 편입니다.');
    else if (r.status === 'ok') lines.push('정상 범위입니다.');
    else if (r.status === 'low') lines.push('평소보다 크게 적습니다 (청구 누락 여부 확인).');
    else if (r.status === 'new') lines.push('예년에는 이 달에 지출이 없었습니다.');
    return lines.join(' ');
  }

  /** 반복 지출 카테고리 전체를 해당 월 기준으로 점검 */
  function recurringOverview(txs, categories, year, month, opts) {
    return categories
      .filter((c) => c.recurring && c.type === 'expense')
      .map((c) => analyzeRecurring(txs, c.name, year, month, opts));
  }

  const TRIP_WORDS = ['여행', 'trip', 'travel', '휴가', 'vacation'];

  /**
   * 통합 검색
   *  - '여행' 같은 키워드 → 모든 여행 일정
   *  - 4자리 연도 → 연도 필터 (예: "2025 여행")
   *  - 그 외 단어 → 제목/목적지/메모/태그/카테고리 텍스트 매칭 (AND)
   */
  function search(data, query) {
    const tokens = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    const years = tokens.filter((t) => /^(19|20)\d{2}(년)?$/.test(t)).map((t) => Number(t.slice(0, 4)));
    const tripWanted = tokens.some((t) => TRIP_WORDS.includes(t));
    const words = tokens.filter((t) => !/^(19|20)\d{2}(년)?$/.test(t) && !TRIP_WORDS.includes(t));
    const empty = { trips: [], events: [], transactions: [], tokens, years, tripWanted };
    if (!tokens.length) return empty;

    const inYear = (dateStr, endStr) => {
      if (!years.length) return true;
      const ys = yearOf(dateStr);
      const ye = endStr ? yearOf(endStr) : ys;
      return years.some((y) => y >= ys && y <= ye);
    };
    const textMatch = (hay) => words.every((w) => hay.includes(w));

    const events = data.events.filter((e) => {
      if (!inYear(e.startDate, e.endDate)) return false;
      const hay = [e.title, e.destination, e.memo, ...(e.tags || []), e.kind === 'trip' ? '여행' : '일정']
        .join(' ')
        .toLowerCase();
      if (tripWanted && e.kind !== 'trip') return false;
      if (!words.length) return tripWanted || years.length > 0;
      return textMatch(hay);
    });

    const evById = new Map(data.events.map((e) => [e.id, e]));
    const transactions = words.length
      ? data.transactions.filter((t) => {
          if (!inYear(t.date)) return false;
          const ev = t.eventId ? evById.get(t.eventId) : null;
          if (tripWanted && !(ev && ev.kind === 'trip')) return false;
          const hay = [t.category, t.memo, ...(t.tags || []), ev ? ev.title : '', ev ? ev.destination : '']
            .join(' ')
            .toLowerCase();
          return textMatch(hay);
        })
      : [];

    const withSummary = (e) => ({ event: e, summary: eventSummary(e, data.transactions) });
    const byStartDesc = (a, b) => b.event.startDate.localeCompare(a.event.startDate);
    return {
      ...empty,
      trips: events.filter((e) => e.kind === 'trip').map(withSummary).sort(byStartDesc),
      events: events.filter((e) => e.kind !== 'trip').map(withSummary).sort(byStartDesc),
      transactions: transactions.sort((a, b) => b.date.localeCompare(a.date)),
    };
  }

  return {
    yearOf,
    monthOf,
    dayOf,
    pad,
    sum,
    mean,
    daysInclusive,
    periodLabel,
    filterTx,
    monthlyTotals,
    yearlyTotals,
    categoryTotals,
    dailyTotals,
    yearsWithData,
    eventSummary,
    analyzeRecurring,
    recurringOverview,
    explain,
    STATUS_LABEL,
    search,
  };
});
