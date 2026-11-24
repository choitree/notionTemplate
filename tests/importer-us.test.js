// 미국 카드사·은행 내보내기 형식 (tests/fixtures/us/ — 공개 안내 문서에 나오는 열 구성으로 만든 가상 거래)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const I = require('../js/importer.js');
const X = require('../js/xlsx.js');
const Store = require('../js/store.js');

const load = (name) => {
  const r = X.read(fs.readFileSync(path.join(__dirname, 'fixtures', 'us', name)), I.decode);
  return I.analyze(r.rows || r.text, Store.migrateData(Store.emptyData()));
};
const amounts = (a) => a.rows.map((r) => [r.type, r.amount]);
const catOf = (a, memoStart) => a.merchants.find((m) => m.memo.startsWith(memoStart)).category;

test('American Express CSV: 구매 양수, 납부 제외, 환불 차감, 여러 줄 주소 칸', () => {
  const a = load('amex.csv');
  assert.equal(a.format, 'card');
  assert.equal(a.currency, 'USD');
  assert.equal(a.rows.length, 7);
  assert.equal(a.payments.length, 1);
  assert.equal(a.payments[0].amount, 1500);
  const refund = a.rows.find((r) => r.date === '2026-10-09');
  assert.deepEqual([refund.amount, refund.refund], [-39.99, true]);
  assert.equal(a.rows.find((r) => r.memo.startsWith('WHOLEFDS')).amount, 1084.3);
  assert.equal(catOf(a, 'SHELL'), '주유비');
  assert.equal(catOf(a, 'WHOLEFDS'), '식비');
  assert.equal(catOf(a, 'DELTA'), '항공');
  assert.equal(catOf(a, 'STARBUCKS'), '외식/카페');
});

test('American Express 엑셀(.xlsx): 위쪽 안내 행, 날짜 셀, 숫자 셀', () => {
  const a = load('amex-activity.xlsx');
  assert.equal(a.format, 'card');
  assert.deepEqual(a.rows.map((r) => r.date), ['2026-11-01', '2026-11-02', '2026-11-04']);
  assert.deepEqual(a.rows.map((r) => r.amount), [6.45, 389.2, 40]);
  assert.equal(a.payments.length, 1);
  assert.equal(catOf(a, 'MARRIOTT'), '숙박');
});

test('Chase 카드: 구매 음수, Type 열(Sale/Return/Payment)', () => {
  const a = load('chase-card.csv');
  assert.deepEqual(amounts(a), [
    ['expense', 28.4],
    ['expense', 64.12],
    ['expense', 142.77],
    ['expense', -15],
    ['expense', 18.9],
  ]);
  assert.equal(a.payments.length, 1);
  assert.equal(catOf(a, 'UBER *EATS'), '외식/카페');
  assert.equal(catOf(a, 'UBER *TRIP'), '교통');
  assert.equal(catOf(a, 'TRADER JOE'), '식비');
});

test('Capital One: Debit/Credit 열, 자동이체 납부 제외', () => {
  const a = load('capital-one.csv');
  assert.deepEqual(amounts(a), [
    ['expense', 48.2],
    ['expense', 15.49],
    ['expense', 201.33],
  ]);
  assert.equal(a.payments[0].memo, 'CAPITAL ONE AUTOPAY PYMT');
  assert.equal(catOf(a, 'NETFLIX'), '문화/여가');
});

test('Citi: Pending 건 건너뜀, 음수 Credit 납부', () => {
  const a = load('citi.csv');
  assert.equal(a.pending, 1);
  assert.deepEqual(amounts(a), [
    ['expense', 85],
    ['expense', 22.17],
  ]);
  assert.equal(catOf(a, 'VERIZON'), '통신비');
  assert.equal(catOf(a, 'CVS'), '의료');
});

test('Discover: "Trans. Date", 납부·적립 크레딧 제외', () => {
  const a = load('discover.csv');
  assert.deepEqual(amounts(a), [['expense', 87.45]]);
  assert.equal(a.payments.length, 2);
});

test('Apple Card: Merchant 열을 가맹점으로, Amount (USD)', () => {
  const a = load('apple-card.csv');
  assert.deepEqual(a.rows.map((r) => [r.memo, r.amount]), [
    ['Uber Eats', 24.36],
    ['Apple Services', 9.99],
  ]);
  assert.equal(a.payments.length, 1);
});

test('Bank of America 계좌: 위쪽 요약, 잔액 열, 급여=수입, 카드 대금 출금 분리', () => {
  const a = load('bofa-checking.csv');
  assert.equal(a.format, 'bank');
  assert.equal(a.errors.length, 0, '요약·시작 잔액 행은 오류 없이 건너뜀');
  assert.deepEqual(amounts(a), [
    ['income', 4200],
    ['expense', 1500],
    ['expense', 61.4],
    ['expense', 300],
  ]);
  assert.equal(a.cardPayments.length, 1);
  assert.equal(catOf(a, 'ACME'), '급여');
  assert.equal(catOf(a, 'SOCALGAS'), '가스비');
  const built = I.build(a, Store.migrateData(Store.emptyData()));
  assert.equal(built.transactions.length, 3, '카드 대금 기본 제외');
});

test('Wells Fargo 계좌: 헤더 없는 파일', () => {
  const a = load('wells-fargo.csv');
  assert.equal(a.format, 'bank');
  assert.equal(a.header.headerless, true);
  assert.deepEqual(amounts(a), [
    ['expense', 48.92],
    ['income', 3100],
    ['expense', 98],
    ['expense', 850],
  ]);
  assert.equal(a.cardPayments.length, 1);
  assert.equal(catOf(a, 'PURCHASE AUTHORIZED'), '주유비');
  assert.equal(catOf(a, 'T-MOBILE'), '통신비');
});

test('매장 번호가 달라도 같은 가맹점으로 묶고, 고친 카테고리를 기억', () => {
  assert.equal(I.merchantKey('STARBUCKS STORE 05812 SEATTLE WA'), I.merchantKey('STARBUCKS STORE 11234 PORTLAND OR'));
  assert.equal(I.merchantKey('SQ *BLUE BOTTLE COFFEE Oakland CA'), 'blue bottle');
  const store = Store.createStore(null);
  const a = I.analyze('Date,Description,Amount\n10/01/2026,BLUE MOON GENERAL STORE #12,23.10\n', store.data);
  store.addImported(I.build(a, store.data, { categories: { [a.merchants[0].key]: '생활용품' }, uid: Store.uid }));
  const b = I.analyze('Date,Description,Amount\n11/01/2026,BLUE MOON GENERAL STORE #45,18.00\n', store.data);
  assert.equal(b.merchants[0].category, '생활용품');
});

test('미국식 날짜·금액', () => {
  assert.equal(I.normalizeDate('11/03/2026'), '2026-11-03');
  assert.equal(I.normalizeDate('1/5/26'), '2026-01-05');
  assert.equal(I.normalizeDate('Nov 3, 2026'), '2026-11-03');
  assert.equal(I.normalizeDate('03 Nov 2026'), '2026-11-03');
  assert.equal(I.parseAmount('$1,234.56'), 1234.56);
  assert.equal(I.parseAmount('-$12.34'), -12.34);
  assert.equal(I.parseAmount('$-12.34'), -12.34);
  assert.equal(I.parseAmount('(12.34)'), -12.34);
});

test('엑셀 읽기: 옛 .xls는 안내, HTML 표 .xls는 읽음', () => {
  const ole = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
  assert.throws(() => X.read(ole, I.decode), /\.xlsx/);
  const html = new TextEncoder().encode('<html><body><table><tr><th>Date</th><th>Description</th><th>Amount</th></tr><tr><td>10/01/2026</td><td>A &amp; B CAFE</td><td>$4.50</td></tr></table></body></html>');
  const r = X.read(html, I.decode);
  assert.equal(r.kind, 'html');
  const a = I.analyze(r.rows, Store.migrateData(Store.emptyData()));
  assert.deepEqual(a.rows.map((x) => [x.date, x.memo, x.amount]), [['2026-10-01', 'A & B CAFE', 4.5]]);
  assert.equal(X.serialToDate(46329), '2026-11-03');
  assert.equal(X.isDateFormat('mm/dd/yyyy'), true);
  assert.equal(X.isDateFormat('#,##0.00'), false);
  assert.equal(X.isDateFormat('[$-409]mmmm d, yyyy'), true);
  assert.equal(X.isDateFormat('"$"#,##0.00'), false);
});

test('통화 표시', () => {
  const A = require('../js/analytics.js');
  assert.equal(A.money(1234.5, 'USD'), '$1,234.50');
  assert.equal(A.money(-12.3, 'USD'), '-$12.30');
  assert.equal(A.money(12500, 'KRW'), '12,500원');
  assert.equal(A.compact(12345, 'USD'), '$12k');
  assert.equal(A.compact(1500, 'USD'), '$1.5k');
  assert.equal(A.compact(27300000, 'KRW'), '2730만원');
});
