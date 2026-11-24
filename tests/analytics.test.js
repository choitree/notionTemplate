// 실행: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../js/analytics.js');
const Store = require('../js/store.js');
const Sample = require('../js/sample.js');

const tx = (date, amount, category, extra = {}) => ({ id: date + category + amount, date, type: 'expense', amount, category, memo: '', tags: [], eventId: null, ...extra });

/** 3년치 가스비: 겨울에 높고 여름에 낮은 패턴 */
function gasData({ octThisYear = 45000 } = {}) {
  const pattern = [180, 160, 120, 70, 40, 25, 20, 20, 25, 45, 90, 150].map((v) => v * 1000);
  const out = [];
  for (const y of [2024, 2025, 2026]) {
    pattern.forEach((v, i) => {
      if (y === 2026 && i > 10) return;
      const amount = y === 2026 && i === 9 ? octThisYear : v;
      out.push(tx(`${y}-${String(i + 1).padStart(2, '0')}-20`, amount, '가스비'));
    });
  }
  return out;
}

test('daysInclusive / periodLabel', () => {
  assert.equal(A.daysInclusive('2025-07-20', '2025-07-24'), 5);
  assert.equal(A.periodLabel(5), '4박 5일');
  assert.equal(A.daysInclusive('2025-12-31', '2026-01-01'), 2);
  assert.equal(A.periodLabel(1), '당일');
});

test('monthlyTotals / yearlyTotals', () => {
  const t = [tx('2025-01-03', 100, '식비'), tx('2025-01-20', 50, '식비'), tx('2025-03-01', 30, '외식/카페'), tx('2024-01-01', 7, '식비')];
  assert.deepEqual(A.monthlyTotals(t, 2025).slice(0, 3), [150, 0, 30]);
  assert.deepEqual(A.yearlyTotals(t), { 2024: 7, 2025: 180 });
});

test('계절적으로 오른 겨울 가스비는 정상으로 판정', () => {
  const r = A.analyzeRecurring(gasData(), '가스비', 2026, 1);
  assert.equal(r.status, 'ok');
  assert.ok(r.seasonalIndex > 1.2, '1월은 계절적 상승 시기');
  assert.match(A.explain(r), /계절적 상승/);
});

test('예년보다 일찍 급등한 가스비는 경고', () => {
  const r = A.analyzeRecurring(gasData({ octThisYear: 80000 }), '가스비', 2026, 10);
  assert.equal(r.status, 'alert');
  assert.ok(r.diff > 0.7);
  assert.ok(r.seasonalIndex < 0.8);
  assert.match(A.explain(r), /이른/);
});

test('조금 높은 경우 주의', () => {
  const r = A.analyzeRecurring(gasData({ octThisYear: 54000 }), '가스비', 2026, 10);
  assert.equal(r.status, 'warn');
});

test('이전 연도 데이터가 없으면 nodata', () => {
  const r = A.analyzeRecurring([tx('2026-01-01', 1000, '수도비')], '수도비', 2026, 1);
  assert.equal(r.status, 'nodata');
});

test('추세 보정: 올해 요금이 전반적으로 20% 오르면 예상치도 오른다', () => {
  const base = gasData().map((t) => (t.date.startsWith('2026') ? { ...t, amount: t.amount * 1.2 } : t));
  const r = A.analyzeRecurring(base, '가스비', 2026, 11);
  assert.ok(Math.abs(r.trendFactor - 1.2) < 0.01);
  assert.equal(r.status, 'ok');
});

test('여행 중 주유로 늘어난 주유비는 "일정 영향"으로 분리', () => {
  const t = [];
  for (const y of [2024, 2025, 2026]) for (let m = 1; m <= 9; m++) t.push(tx(`${y}-0${m}-05`, 200000, '주유비'));
  t.push(tx('2026-09-26', 90000, '주유비', { eventId: 'trip1' }));
  const r = A.analyzeRecurring(t, '주유비', 2026, 9);
  assert.equal(r.status, 'event');
  assert.equal(r.eventAmount, 90000);
});

test('검색: "여행"은 모든 여행, 연도·단어로 좁히기', () => {
  const data = Sample.generate(new Date(2026, 10, 24));
  const all = A.search(data, '여행');
  assert.equal(all.trips.length, 6);
  assert.equal(all.events.length, 0);
  assert.ok(all.trips.every((r) => r.summary.total > 0 && r.summary.days >= 2));
  assert.equal(A.search(data, '2025 여행').trips.length, 2);
  const osaka = A.search(data, '오사카');
  assert.equal(osaka.trips.length, 1);
  assert.equal(osaka.trips[0].summary.days, 5);
  assert.ok(A.search(data, '결혼식').events.length >= 2);
  assert.ok(A.search(data, '가스비').transactions.length > 30);
});

test('CSV 가져오기: 헤더 별칭, 음수 금액, 따옴표, 새 카테고리', () => {
  const data = Store.emptyData();
  data.events.push({ id: 'e1', kind: 'trip', title: '오사카 여행', startDate: '2025-07-20', endDate: '2025-07-24' });
  const csv = '﻿거래일,적요,금액,분류,일정\n2025.07.21,"간사이, 스루패스",-96000,교통,오사카 여행\n2025-01-25,월급,4350000,급여,\n잘못된행,,,\n2025/02/01,반려동물 사료,32000,반려동물,';
  const res = Store.csvToTransactions(csv, data);
  assert.equal(res.transactions.length, 3);
  assert.equal(res.errors.length, 1);
  const [a, , c] = res.transactions;
  assert.equal(a.date, '2025-07-21');
  assert.equal(a.amount, 96000);
  assert.equal(a.memo, '간사이, 스루패스');
  assert.equal(a.eventId, 'e1');
  assert.equal(c.date, '2025-02-01');
  assert.deepEqual(res.newCategories.map((x) => x.name), ['반려동물']);
});

test('CSV 내보내기 → 다시 가져오기 왕복', () => {
  const data = Sample.generate(new Date(2026, 10, 24));
  const csv = Store.transactionsToCSV(data);
  const res = Store.csvToTransactions(csv, data);
  assert.equal(res.errors.length, 0);
  assert.equal(res.transactions.length, data.transactions.length);
  const sum = (arr) => arr.reduce((s, t) => s + t.amount, 0);
  assert.equal(sum(res.transactions), sum(data.transactions));
  assert.equal(res.transactions.filter((t) => t.eventId).length, data.transactions.filter((t) => t.eventId).length);
});
