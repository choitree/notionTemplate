// 실행: node --test tests/*.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const I = require('../js/importer.js');
const Store = require('../js/store.js');

const fixture = (name) => I.decode(fs.readFileSync(path.join(__dirname, 'fixtures', name)));
const empty = () => Store.migrateData(Store.emptyData());

test('카드 이용내역 (EUC-KR, 상단 안내 문구, 취소, 합계 행, 해외금액 열)', () => {
  const a = I.analyze(fixture('card-preamble-euckr.csv'), empty());
  assert.equal(a.format, 'card');
  assert.equal(a.header.row, 4);
  assert.equal(a.header.columns.amount, '이용금액', '해외이용금액이 아니라 원화 금액 열');
  assert.equal(a.rows.length, 7, '합계 행 제외');
  assert.equal(a.errors.length, 0);
  assert.ok(a.rows.every((r) => r.type === 'expense'));
  const cancel = a.rows.find((r) => r.date === '2026-10-08');
  assert.equal(cancel.amount, -39900);
  assert.equal(cancel.refund, true);
  const cat = Object.fromEntries(a.merchants.map((m) => [m.memo, m.category]));
  assert.equal(cat['GS칼텍스 서초주유소'], '주유비');
  assert.equal(cat['스타벅스 강남점'], '외식/카페');
  assert.equal(cat['이마트 성수점'], '식비');
  assert.equal(cat['AGODA.COM'], '숙박');
  assert.equal(cat['쿠팡'], '쇼핑');
});

test('카드 승인내역 (날짜+시간, "원" 표기, 음수 취소)', () => {
  const a = I.analyze(fixture('card-signed-utf8.csv'), empty());
  assert.equal(a.format, 'card');
  assert.deepEqual(a.rows.map((r) => [r.date, r.amount]), [
    ['2026-10-20', 3000],
    ['2026-10-21', 25000],
    ['2026-10-21', -25000],
    ['2026-10-22', 14200],
  ]);
  assert.equal(a.merchants.find((m) => m.memo === '카카오T 택시').category, '교통');
});

test('은행 거래내역 (출금/입금 열, 카드대금은 따로 분리)', () => {
  const a = I.analyze(fixture('bank-inout-euckr.csv'), empty());
  assert.equal(a.format, 'bank');
  assert.deepEqual(a.rows.map((r) => [r.type, r.amount]), [
    ['expense', 231000],
    ['expense', 1203400],
    ['expense', 81270],
    ['income', 4500000],
  ]);
  assert.deepEqual(a.cardPayments.map((r) => r.memo), ['신한카드']);
  const built = I.build(a, empty());
  assert.equal(built.transactions.length, 3, '카드대금 기본 제외');
  assert.equal(I.build(a, empty(), { skipCardPayments: false }).transactions.length, 4);
  const cats = Object.fromEntries(built.transactions.map((t) => [t.memo, t.category]));
  assert.equal(cats['도시가스'], '가스비');
  assert.equal(cats['관리비'], '관리비');
  assert.equal(cats['급여 (주)회사'], '급여');
});

test('은행 파일: 부호로만 입출금을 나타내는 경우', () => {
  const a = I.analyze(fixture('bank-signed.csv'), empty());
  assert.equal(a.format, 'bank');
  assert.deepEqual(a.rows.map((r) => [r.memo, r.type, r.amount]), [
    ['한국전력공사', 'expense', 48920],
    ['홍길동', 'income', 50000],
    ['SKT 통신요금', 'expense', 98000],
  ]);
});

test('같은 파일을 다시 가져오면 모두 중복으로 건너뜀, 같은 파일 안의 동일 거래는 유지', () => {
  const store = Store.createStore(null);
  const text = '이용일자,가맹점명,이용금액\n2026.10.01,스타벅스,4500\n2026.10.01,스타벅스,4500\n';
  const first = I.analyze(text, store.data);
  assert.equal(first.rows.length, 2);
  store.addImported(I.build(first, store.data, { uid: Store.uid }));
  const again = I.analyze(text, store.data);
  assert.equal(again.rows.length, 0);
  assert.equal(again.duplicates, 2);
});

test('한 번 고친 가맹점 카테고리는 다음 가져오기에 그대로 적용', () => {
  const store = Store.createStore(null);
  const a = I.analyze('이용일자,가맹점명,이용금액\n2026.10.01,모퉁이상회,70000\n', store.data);
  const m = a.merchants[0];
  assert.equal(m.category, '기타');
  store.addImported(I.build(a, store.data, { categories: { [m.key]: '문화/여가' }, uid: Store.uid }));
  const b = I.analyze('이용일자,가맹점명,이용금액\n2026.11.01,모퉁이상회,70000\n', store.data);
  assert.equal(b.merchants[0].category, '문화/여가');
  assert.equal(b.merchants[0].source, 'history');
});

test('여행 기간의 카드 지출은 여행에 자동 연결 (고정비는 제외)', () => {
  const d = empty();
  d.events.push({ id: 'osaka', kind: 'trip', title: '오사카', startDate: '2026-10-10', endDate: '2026-10-13' });
  const a = I.analyze('이용일자,가맹점명,이용금액\n2026.10.11,돈키호테 난바,52000\n2026.10.11,SKT 통신요금,98000\n2026.10.20,이마트,30000\n', d);
  const t = I.build(a, d).transactions;
  assert.equal(t.find((x) => x.memo === '돈키호테 난바').eventId, 'osaka');
  assert.equal(t.find((x) => x.memo === 'SKT 통신요금').eventId, null, '통신비(고정비)는 연결 안 함');
  assert.equal(t.find((x) => x.memo === '이마트').eventId, null, '여행 기간 밖');
});

test('날짜·금액 형식', () => {
  assert.equal(I.normalizeDate('2026.11.03'), '2026-11-03');
  assert.equal(I.normalizeDate('2026-11-03 12:34:56'), '2026-11-03');
  assert.equal(I.normalizeDate('2026년 1월 5일'), '2026-01-05');
  assert.equal(I.normalizeDate('20261103'), '2026-11-03');
  assert.equal(I.normalizeDate('26.11.03'), '2026-11-03');
  assert.equal(I.normalizeDate('합계'), null);
  assert.equal(I.parseAmount('12,500원'), 12500);
  assert.equal(I.parseAmount('-25,000원'), -25000);
  assert.equal(I.parseAmount('(3,000)'), -3000);
  assert.equal(I.parseAmount(''), null);
});

test('열 이름을 못 찾으면 안내 메시지', () => {
  const a = I.analyze('이름,나이\n홍길동,30\n', empty());
  assert.equal(a.format, null);
  assert.match(a.errors[0], /날짜와 금액 열/);
});
