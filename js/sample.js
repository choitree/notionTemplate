/*
 * 체험용 샘플 데이터 (오늘 기준 최근 3년)
 *  - 난방비(가스비)는 겨울에 오르는 계절 패턴
 *  - 전기비는 여름(에어컨)·겨울에 상승
 *  - 일부러 넣은 이상치: 지난달 가스비가 예년보다 일찍 급등, 2개월 전 수도비 급증
 *  - 여행 6건 + 일반 일정 몇 건
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./store.js'));
  else root.Sample = factory(root.Store);
})(typeof self !== 'undefined' ? self : this, function (Store) {
  'use strict';

  function rng(seed) {
    return function () {
      seed |= 0;
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const pad = (n) => String(n).padStart(2, '0');
  const ds = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
  const daysIn = (y, m) => new Date(y, m, 0).getDate();
  const round = (n, unit = 10) => Math.round(n / unit) * unit;

  function addDays(dateStr, n) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d + n));
    return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
  }

  function generate(today = new Date()) {
    const r = rng(20240101);
    const noise = (p) => 1 + (r() * 2 - 1) * p;
    const pick = (arr) => arr[Math.floor(r() * arr.length)];
    const todayStr = ds(today.getFullYear(), today.getMonth() + 1, today.getDate());
    const Y = today.getFullYear();
    const years = [Y - 2, Y - 1, Y];

    const data = Store.emptyData();
    const tx = [];
    const add = (date, type, amount, category, memo, extra = {}) => {
      if (date > todayStr) return;
      tx.push({ id: Store.uid() + tx.length, date, type, amount: round(amount), category, memo, tags: [], eventId: null, ...extra });
    };

    // 이상치를 넣을 달: 지난달(가스비 조기 급등), 2개월 전(수도비 급증)
    const ref = new Date(today.getFullYear(), today.getMonth() - 1, 1);
    const gasSpike = { y: ref.getFullYear(), m: ref.getMonth() + 1 };
    const ref2 = new Date(today.getFullYear(), today.getMonth() - 2, 1);
    const waterSpike = { y: ref2.getFullYear(), m: ref2.getMonth() + 1 };

    const GAS = [182000, 165000, 121000, 72000, 41000, 26000, 21000, 20000, 24000, 43000, 92000, 151000];
    const ELEC = [58000, 52000, 46000, 41000, 43000, 61000, 96000, 112000, 72000, 46000, 47000, 56000];
    const WATER = [29000, 28000, 28000, 29000, 31000, 33000, 36000, 37000, 33000, 30000, 29000, 29000];
    const FUEL_PRICE = { [Y - 2]: 1.0, [Y - 1]: 0.97, [Y]: 1.03 };

    for (const y of years) {
      const k = 1 + (y - years[0]) * 0.04; // 요금 인상 추세
      for (let m = 1; m <= 12; m++) {
        let gas = GAS[m - 1] * k * noise(0.07);
        if (y === gasSpike.y && m === gasSpike.m) gas = GAS[m - 1] * k * 1.75;
        add(ds(y, m, 20), 'expense', gas, '가스비', '도시가스 요금');
        add(ds(y, m, 18), 'expense', ELEC[m - 1] * k * noise(0.08), '전기비', '한전 전기요금');
        let water = WATER[m - 1] * k * noise(0.05);
        if (y === waterSpike.y && m === waterSpike.m) water *= 1.6;
        add(ds(y, m, 22), 'expense', water, '수도비', '상수도 요금');
        add(ds(y, m, 10), 'expense', 215000 * k * noise(0.03), '관리비', '아파트 관리비');
        add(ds(y, m, 15), 'expense', 98000, '통신비', '휴대폰·인터넷');
        add(ds(y, m, 5), 'expense', 186000, '보험료', '실손·운전자보험');
        add(ds(y, m, 25), 'income', 4200000 + (y - years[0]) * 150000, '급여', '월급');
        if (m === 1 || m === 7) add(ds(y, m, 10), 'income', 1500000, '부수입', '상여금');

        // 주유: 월 3~4회
        const fills = 3;
        for (let i = 0; i < fills; i++) {
          add(ds(y, m, 2 + i * 7 + Math.floor(r() * 4)), 'expense', 64000 * FUEL_PRICE[y] * noise(0.08), '주유비', pick(['GS칼텍스', 'SK에너지', 'S-OIL', '현대오일뱅크']));
        }
        // 장보기: 주 1~2회
        for (let d = 1; d <= daysIn(y, m); d += 3 + Math.floor(r() * 4)) {
          add(ds(y, m, d), 'expense', (45000 + r() * 90000) * k, '식비', pick(['이마트', '홈플러스', '동네마트', '쿠팡 프레시', '시장']));
        }
        for (let i = 0; i < 6; i++) add(ds(y, m, 1 + Math.floor(r() * daysIn(y, m))), 'expense', 8000 + r() * 50000, '외식/카페', pick(['스타벅스', '김밥천국', '동네 고깃집', '파스타집', '치킨', '중국집']));
        for (let i = 0; i < 2; i++) add(ds(y, m, 1 + Math.floor(r() * 28)), 'expense', 15000 + r() * 60000, '생활용품', pick(['다이소', '쿠팡', '올리브영']));
        add(ds(y, m, 1 + Math.floor(r() * 28)), 'expense', 55000, '교통', '교통카드 충전');
        if (r() < 0.7) add(ds(y, m, 1 + Math.floor(r() * 28)), 'expense', 30000 + r() * 220000, '쇼핑', pick(['옷', '신발', '전자기기 소품', '온라인 쇼핑']));
        if (r() < 0.4) add(ds(y, m, 1 + Math.floor(r() * 28)), 'expense', 10000 + r() * 70000, '의료', pick(['병원', '약국', '치과']));
        if (r() < 0.6) add(ds(y, m, 1 + Math.floor(r() * 28)), 'expense', 15000 + r() * 50000, '문화/여가', pick(['영화', '넷플릭스', '전시회', '책']));
      }
    }

    // 일정·여행
    const events = [];
    const trip = (title, destination, start, nights, items, tags = []) => {
      const id = Store.uid() + events.length;
      const endDate = addDays(start, nights);
      events.push({ id, kind: 'trip', title, destination, startDate: start, endDate, memo: '', tags });
      for (const [offset, category, amount, memo] of items) {
        const date = typeof offset === 'string' ? offset : addDays(start, offset);
        add(date, 'expense', amount, category, memo, { eventId: id });
      }
      return id;
    };
    const ev = (title, date, items = [], memo = '') => {
      const id = Store.uid() + events.length;
      events.push({ id, kind: 'event', title, destination: '', startDate: date, endDate: date, memo, tags: [] });
      for (const [category, amount, m] of items) add(date, 'expense', amount, category, m, { eventId: id });
    };
    const dailyFood = (nights, base) => [...Array(nights + 1)].map((_, i) => [i, '외식/카페', base * noise(0.3), `${i + 1}일차 식사`]);

    const [a, b, c] = years;
    trip('제주도 가족여행', '제주', ds(a, 5, 3), 3, [
      [ds(a, 3, 28), '항공', 412000, '제주항공 왕복 3인'],
      [0, '숙박', 540000, '애월 펜션 3박'],
      [0, '교통', 168000, '렌터카 4일'],
      [1, '문화/여가', 87000, '아쿠아플라넷'],
      [2, '쇼핑', 64000, '감귤 초콜릿·기념품'],
      ...dailyFood(3, 85000),
    ], ['가족']);
    trip('강릉 바다 여행', '강릉', ds(a, 10, 12), 1, [
      [0, '주유비', 78000, '왕복 주유'],
      [0, '숙박', 165000, '오션뷰 호텔'],
      [1, '외식/카페', 52000, '초당순두부·커피거리'],
      ...dailyFood(1, 60000),
    ]);
    trip('부산 겨울 여행', '부산', ds(b, 2, 9), 2, [
      [ds(b, 1, 20), '교통', 179000, 'KTX 왕복 3인'],
      [0, '숙박', 298000, '해운대 호텔 2박'],
      [1, '문화/여가', 45000, '해변열차'],
      [2, '쇼핑', 38000, '어묵 선물'],
      ...dailyFood(2, 95000),
    ]);
    trip('오사카 여행', '일본 오사카', ds(b, 7, 20), 4, [
      [ds(b, 5, 2), '항공', 1080000, '인천-간사이 왕복 3인'],
      [ds(b, 5, 10), '숙박', 920000, '난바 호텔 4박'],
      [0, '교통', 96000, '간사이 스루패스'],
      [1, '문화/여가', 342000, '유니버설 스튜디오'],
      [3, '쇼핑', 285000, '돈키호테·면세'],
      ...dailyFood(4, 120000),
    ], ['해외']);
    trip('다낭 가족여행', '베트남 다낭', ds(c, 8, 5), 4, [
      [ds(c, 6, 1), '항공', 1240000, '인천-다낭 왕복 3인'],
      [ds(c, 6, 3), '숙박', 860000, '미케비치 리조트 4박'],
      [1, '문화/여가', 210000, '바나힐'],
      [2, '교통', 54000, '그랩'],
      [3, '쇼핑', 132000, '한시장 기념품'],
      ...dailyFood(4, 70000),
    ], ['해외', '가족']);
    trip('경주 1박 2일', '경주', ds(c, 9, 26), 1, [
      [0, '주유비', 92000, '왕복 주유'],
      [0, '숙박', 142000, '한옥 스테이'],
      [1, '문화/여가', 24000, '불국사 입장료'],
      ...dailyFood(1, 65000),
    ]);

    ev('친구 결혼식', ds(a, 11, 16), [['경조사', 100000, '축의금']]);
    ev('어머니 생신', ds(b, 4, 13), [['외식/카페', 186000, '한정식 가족 모임'], ['쇼핑', 150000, '생신 선물']]);
    ev('회사 동료 결혼식', ds(c, 6, 14), [['경조사', 100000, '축의금']]);
    ev('자동차 정기검사', ds(c, 3, 21), [['교통', 54000, '검사 수수료']]);

    data.transactions = tx;
    data.events = events;
    return data;
  }

  return { generate };
});
