/*
 * 거래 내역 파일 가져오기
 *  - 미국 카드사(American Express, Chase, Capital One, Citi, Discover, Apple Card, Bank of America, Wells Fargo, US Bank 등),
 *    미국 은행 계좌, 국내 카드사·은행, 이 앱의 CSV를 자동 구분
 *  - CSV(EUC-KR/UTF-8, 쉼표·탭·세미콜론) 또는 엑셀에서 읽은 행 배열(js/xlsx.js)을 받음
 *  - 상단 안내 문구가 있어도 헤더 행을 찾고, 헤더가 없는 파일(Wells Fargo)도 처리
 *  - 카드사마다 다른 금액 부호(구매가 + 인지 - 인지)를 파일 내용으로 판별
 *  - 카드 대금 납부(Payment)는 제외, 환불·취소는 음수 지출, 은행 입금은 수입
 *  - 이미 있는 거래와 같은 건 중복으로 건너뜀
 *  - 카테고리: 이전에 직접 분류한 가맹점 → 가맹점 이름 규칙 → 카드사 분류 → 기타
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
    const count = (re) => (sample.match(re) || []).length;
    const c = count(/,/g), t = count(/\t/g), s = count(/;/g);
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
    return rows.filter((r) => r.some((v) => String(v).trim() !== ''));
  }

  const csvCell = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  /* ---------- 열 이름 ---------- */
  // 앞에 있을수록 우선. 비교할 때 대소문자·공백·괄호·마침표·# 무시
  const COLS = {
    date: [
      '날짜', '일자', '거래일', '거래일자', '거래일시', '이용일', '이용일자', '이용일시', '승인일', '승인일자', '승인일시', '매출일', '매출일자', '사용일', '사용일자', '결제일자',
      'transactiondate', 'date', 'transdate', 'trandate', 'purchasedate', 'postingdate', 'posteddate', 'postdate',
    ],
    type: ['구분', '유형', '수입/지출', '입출금구분', '거래유형', 'type', 'transactiontype', 'details', 'transaction', 'debitcredit'],
    amount: ['금액', '이용금액', '승인금액', '거래금액', '사용금액', '매출금액', '결제금액', '원화금액', '이용원금', 'amount', 'amountusd', 'transactionamount'],
    withdraw: ['출금액', '출금', '찾으신금액', '지급액', '출금금액', '인출금액', 'debit', 'debitamount', 'withdrawal', 'withdrawals', 'withdrawalamount'],
    deposit: ['입금액', '입금', '맡기신금액', '입금금액', 'credit', 'creditamount', 'deposit', 'deposits', 'depositamount'],
    category: ['카테고리', '분류', '항목'], // 이 앱의 카테고리
    issuerCategory: ['category', 'merchantcategory', 'transactioncategory'], // 카드사가 붙인 분류
    memo: [
      '메모', '내용', '적요', '사용처', '가맹점', '가맹점명', '이용가맹점', '이용하신가맹점', '이용처', '상호', '상호명', '거래처', '기재내용', '받는분', '보낸분',
      'merchant', 'merchantname', 'description', 'payee', 'name', 'memo',
    ],
    tags: ['태그', 'tags'],
    event: ['일정', '여행', 'event', 'trip'],
    cancel: ['취소여부', '승인구분', '취소구분', '상태', '매출구분', '거래구분', '승인상태'],
    balance: ['잔액', '거래후잔액', 'balance', 'runningbal', 'runningbalance', 'availablebalance'],
    status: ['status'],
  };
  const EXACT_ONLY = new Set(['type', 'status', 'tags', 'event']); // 포함 매칭 금지 (예: "Extended Details"가 type으로 잡히지 않게)
  const AMOUNT_EXCLUDE = /해외|현지|외화|잔액|포인트|수수료|할인|적립|예정|청구|이자|부가세|balance|reward|points|foreign|cashback/i;
  const MERCHANT_HEADERS = /가맹점|이용처|상호/;

  const norm = (h) => String(h).toLowerCase().replace(/[\s"'()\[\].#]/g, '').replace(/원$/, '');

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
          const r = exact ? rank : !EXACT_ONLY.has(key) && a.length >= 3 && h.includes(a) ? rank + 100 : Infinity;
          if (r < bestRank) {
            bestRank = r;
            best = i;
          }
        });
      });
      col[key] = best;
      if (best >= 0 && key !== 'type' && key !== 'cancel') used.add(best);
    }
    if (col.cancel < 0 && col.type >= 0) col.cancel = col.type; // 국내 카드: "구분"에 취소 여부가 있는 경우
    return col;
  }

  const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  const monthNum = (w) => MONTHS[String(w).slice(0, 3).toLowerCase()] || 0;

  /** 날짜 → 'YYYY-MM-DD'. 미국식(MM/DD/YYYY, Nov 3, 2026)·국내식 모두 */
  function normalizeDate(s) {
    const str = String(s).trim();
    let y, mo, d, m;
    if ((m = str.match(/^(\d{4})\s*[.\-/년]\s*(\d{1,2})\s*[.\-/월]\s*(\d{1,2})/))) [y, mo, d] = [m[1], m[2], m[3]];
    else if ((m = str.match(/^(\d{4})(\d{2})(\d{2})(?!\d)/))) [y, mo, d] = [m[1], m[2], m[3]];
    else if ((m = str.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4}|\d{2})(?!\d)/))) [mo, d, y] = [m[1], m[2], m[3].length === 2 ? `20${m[3]}` : m[3]]; // 미국식
    else if ((m = str.match(/^(\d{2})\s*\.\s*(\d{1,2})\s*\.\s*(\d{1,2})(?!\d)/))) [y, mo, d] = [`20${m[1]}`, m[2], m[3]]; // 26.11.03
    else if ((m = str.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/)) && monthNum(m[1])) [mo, d, y] = [monthNum(m[1]), m[2], m[3]]; // Nov 3, 2026
    else if ((m = str.match(/^(\d{1,2})[\s-]+([A-Za-z]{3,9})\.?[\s,-]+(\d{4})/)) && monthNum(m[2])) [d, mo, y] = [m[1], monthNum(m[2]), m[3]]; // 3 Nov 2026
    else return null;
    y = Number(y);
    mo = Number(mo);
    d = Number(d);
    if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 1990 || y > 2100) return null;
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }

  /** "$1,234.56", "-$12.34", "(12.34)", "12,500원", "25.00-" → 숫자 */
  function parseAmount(s) {
    const str = String(s == null ? '' : s).trim();
    if (!str) return null;
    const digits = str.replace(/[^\d.]/g, '');
    if (!digits || !/\d/.test(digits)) return null;
    const n = Number(digits);
    if (!isFinite(n)) return null;
    const neg = /^\(.*\)$/.test(str) || /[-−]/.test(str);
    return Math.round((neg ? -n : n) * 100) / 100;
  }

  function findHeader(rows) {
    for (let i = 0; i < Math.min(rows.length, 40); i++) {
      const col = findColumns(rows[i]);
      if (col.date >= 0 && (col.amount >= 0 || col.withdraw >= 0 || col.deposit >= 0)) return { index: i, col };
    }
    return null;
  }

  /** 헤더 없는 파일 (예: Wells Fargo: "날짜","금액","*","","설명") */
  function guessHeaderless(rows) {
    const sample = rows.slice(0, 15).filter((r) => r.length >= 2);
    if (!sample.length) return null;
    const ok = sample.filter((r) => normalizeDate(r[0]) && parseAmount(r[1]) != null).length;
    if (ok < Math.max(1, Math.ceil(sample.length * 0.8))) return null;
    // 설명 열 = 평균 글자 수가 가장 긴 열
    let memo = -1;
    let best = 0;
    const width = Math.max(...sample.map((r) => r.length));
    for (let c = 2; c < width; c++) {
      const avg = sample.reduce((a, r) => a + String(r[c] || '').length, 0) / sample.length;
      if (avg > best) {
        best = avg;
        memo = c;
      }
    }
    const col = Object.fromEntries(Object.keys(COLS).map((k) => [k, -1]));
    Object.assign(col, { date: 0, amount: 1, memo });
    return { index: -1, col };
  }

  /* ---------- 카테고리 추측 ---------- */
  // 가맹점 이름 규칙 (앞에 있을수록 우선)
  const RULES = [
    ['주유비', /주유|칼텍스|sk에너지|s-oil|에쓰오일|오일뱅크|알뜰주유|충전소|전기차충전|costco gas|gas station|\bfuel\b|\bshell\b|chevron|exxon|\bmobil\b|\bbp\b|\barco\b|valero|speedway|sunoco|circle k|\b76\b|marathon petro|phillips 66|conoco|quiktrip|racetrac|sheetz|kwik trip|chargepoint|electrify america|supercharger|evgo/i],
    ['가스비', /도시가스|가스공사|삼천리|예스코|코원에너지|socalgas|southern california gas|national grid|nicor|peoples gas|washington gas|piedmont natural|atmos energy|\bspire\b|columbia gas|natural gas/i],
    ['전기비', /한전|한국전력|전기요금|pg&e|pacific gas|edison|\bsce\b|con ?ed|duke energy|dominion energy|xcel|ladwp|pseg|\bfpl\b|florida power|georgia power|ameren|eversource|entergy|\baps\b|\bsrp\b|electric|power co/i],
    ['수도비', /수도|상수도|수자원|\bwater\b|sewer/i],
    ['관리비', /관리비|관리사무소|\brent\b|\bhoa\b|property manag|apartments|leasing office|homeowners/i],
    ['통신비', /skt|sk텔레콤|케이티|lg\s?u\+|유플러스|lgu|알뜰폰|통신|인터넷요금|sk브로드밴드|verizon|at&t|\batt\b|t-mobile|tmobile|sprint|comcast|xfinity|spectrum|cox comm|optimum|frontier comm|google \*?fi|mint mobile|visible|cricket wireless|metro by|boost mobile|us mobile|starlink|\binternet\b/i],
    ['보험료', /보험|화재|생명|손해|geico|state farm|progressive ins|allstate|liberty mutual|farmers ins|usaa|nationwide|lemonade|insurance/i],
    ['항공', /항공|대한항공|아시아나|제주항공|진에어|티웨이|에어부산|이스타|에어서울|파라타|delta air|united air|american air|aa\.com|southwest|jetblue|alaska air|spirit air|frontier air|hawaiian air|korean air|air canada|lufthansa|british airways|airlines?\b|airways/i],
    ['숙박', /호텔|모텔|리조트|펜션|게스트하우스|숙박|에어비앤비|airbnb|vrbo|agoda|아고다|booking\.com|부킹|야놀자|여기어때|hotels\.com|expedia|priceline|marriott|hilton|hyatt|\bihg\b|holiday inn|sheraton|westin|hampton inn|best western|motel|hotel|\binn\b|resort|lodging/i],
    ['외식/카페', /스타벅스|starbucks|커피|카페|cafe|café|투썸|이디야|메가엠지씨|메가커피|빽다방|컴포즈|폴바셋|배달의민족|배민|요기요|쿠팡이츠|맥도날드|버거|롯데리아|치킨|피자|베이커리|파리바게뜨|뚜레쥬르|식당|음식|분식|김밥|국밥|고기|횟집|주점|호프|레스토랑|uber\s*\*?\s*eats|doordash|grubhub|postmates|seamless|mcdonald|chipotle|dunkin|panera|subway|taco bell|chick-fil-a|in-n-out|in n out|shake shack|wendy|burger|domino|pizza|papa john|five guys|panda express|sweetgreen|\bcava\b|blue bottle|peet|philz|dutch bros|tim hortons|kfc|restaurant|grill|kitchen|bistro|diner|coffee|bakery|\bbar\b|\bpub\b|tavern|brewing|sushi|ramen|bbq|taqueria|\btst\s*\*|eatery|\bdeli\b|boba|\btea\b/i],
    ['식비', /이마트|홈플러스|롯데마트|코스트코|트레이더스|하나로|마트|슈퍼|컬리|쿠팡프레시|정육|청과|시장|반찬|gs더프레시|노브랜드|whole ?foods|wholefds|trader joe|safeway|kroger|costco|instacart|albertsons|\bvons\b|ralphs|publix|\baldi\b|sprouts|h ?mart|99 ranch|wegmans|\bheb\b|h-e-b|stop & shop|giant food|food lion|harris teeter|meijer|smart & final|grocery|supermarket|amazon fresh|\bmarket\b/i],
    ['생활용품', /다이소|올리브영|생활|무인양품|이케아|ikea|세탁|home depot|lowe'?s|bed bath|container store|laundry|dry clean/i],
    ['교통', /택시|카카오t|카카오모빌리티|티머니|t-money|교통|코레일|ktx|srt|지하철|버스|고속|하이패스|도로공사|주차|쏘카|그린카|따릉이|\buber\b|\blyft\b|\bmta\b|\bbart\b|clipper|transit|parking|parkmobile|spothero|\btoll|e-?zpass|fastrak|sunpass|amtrak|greyhound|zipcar|hertz|\bavis\b|enterprise rent|budget rent|national car|\bturo\b|caltrain|metro/i],
    ['의료', /병원|의원|약국|치과|한의원|안과|피부과|내과|정형외과|이비인후과|소아과|의료|\bcvs\b|walgreens|rite aid|pharmacy|clinic|medical|dental|\bdds\b|hospital|urgent care|kaiser|one medical|optometr|labcorp|quest diag/i],
    ['문화/여가', /cgv|메가박스|롯데시네마|넷플릭스|netflix|유튜브|youtube|멜론|지니|스포티파이|spotify|디즈니|disney|티빙|웨이브|왓챠|쿠팡플레이|교보문고|yes24|알라딘|영풍|공연|전시|티켓|인터파크|헬스|피트니스|수영|골프|볼링|노래|pc방|hulu|\bhbo\b|max\.com|paramount|peacock|apple music|itunes|audible|kindle|\bamc\b|regal|cinemark|fandango|ticketmaster|stubhub|eventbrite|steam|playstation|xbox|nintendo|twitch|patreon|equinox|planet fitness|24 hour fitness|la fitness|crunch fit|orangetheory|peloton|classpass|museum|\bzoo\b|golf|bowling/i],
    ['쇼핑', /쿠팡|11번가|g마켓|지마켓|옥션|위메프|티몬|ssg|무신사|29cm|지그재그|에이블리|네이버페이|스마트스토어|백화점|아울렛|유니클로|uniqlo|자라|\bzara\b|h&m|나이키|nike|아디다스|adidas|이랜드|오늘의집|amazon|amzn|target|best buy|ebay|etsy|macy|nordstrom|tj ?maxx|marshalls|\bross\b|old navy|\bgap\b|apple store|apple\.com|walmart|wal-mart|kohl|sephora|ulta|shein|temu|wayfair/i],
    ['교육', /학원|교습|과외|인강|클래스101|유데미|udemy|교육|tuition|university|college|coursera|masterclass|duolingo/i],
    ['경조사', /축의|조의|부의|경조|donation|charity|gofundme|red cross|church|tithe/i],
  ];
  // 카드사가 붙인 분류 → 이 앱의 카테고리 (가맹점 규칙으로 못 찾을 때)
  const ISSUER_RULES = [
    ['주유비', /\bgas(oline)?\b|fuel|service station/i],
    ['항공', /airline|airfare|air travel/i],
    ['숙박', /lodging|hotel|motel/i],
    ['외식/카페', /restaurant|dining|food ?& ?drink|fast food|\bbar\b|cafe|coffee/i],
    ['식비', /grocer|supermarket|warehouse/i],
    ['교통', /transportation|taxi|parking|toll|transit|rideshare|car rental|auto rental|travel/i],
    ['의료', /health|medical|pharmac|drug|dental|vision/i],
    ['문화/여가', /entertainment|movie|theat|music|stream|recreation|sport|fitness|amusement/i],
    ['통신비', /phone|cable|internet|telecom|communication/i],
    ['보험료', /insurance/i],
    ['교육', /education|tuition/i],
    ['경조사', /gift|donation|charit/i],
    ['생활용품', /home improvement|household|personal care|\bhome\b/i],
    ['쇼핑', /merchandise|shopping|department|retail|clothing|electronics|general merch/i],
  ];
  // 카드 대금 납부(카드 파일 안의 Payment 행)
  const PAYMENT = /\bpayments?\b|autopay|auto[- ]?pmt|\bpymt\b|e-?payment|thank you|online pmt|mobile pmt|ach pmt/i;
  // 은행 파일 안의 카드대금 출금
  const CARD_PAYMENT = new RegExp(
    [
      '카드\\s*(대금|결제|출금)',
      '^(신한|삼성|현대|국민|kb|롯데|하나|우리|bc|비씨|nh|농협)\\s*카드$',
      '카드론|결제대금',
      '(amex|american express|chase|citi|capital one|discover|apple ?card|applecard|gs bank|goldman sachs|barclay|synchrony|bank of america|wells fargo card|us bank card|credit ?c(ar)?d|crd).{0,30}(pmt|payment|autopay|epay|e-pay)',
      '(pmt|payment|autopay|epay).{0,20}(amex|american express|chase card|citi card|capital one|discover|apple ?card)',
    ].join('|'),
    'i'
  );
  const REFUND = /refund|return|reversal|credit adj|cancel|취소|환불|반품/i;
  const PAYROLL = /급여|월급|상여|payroll|direct dep|salary|paycheck|\badp\b|gusto|paychex/i;
  const DEPOSIT = /payroll|direct dep|salary|paycheck|\bdeposit\b|zelle from|transfer from|interest paid|cashout/i;

  // 가맹점 묶음 키: 매장 번호·날짜·결제대행 접두어를 빼고 앞 두 단어
  const PREFIX = /^(?:(?:sq|tst|py|sp|pp|paypal|dd|ddr|in|cke|bt|ckc)\s*\*\s*)|^(?:purchase authorized on|recurring payment authorized on|purchase return authorized on|pos purchase|pos debit|debit card purchase|checkcard|check card|ach debit|ach credit|purchase)\s+/i;
  function merchantKey(memo) {
    const raw = String(memo || '').trim();
    let s = raw.toLowerCase();
    for (let i = 0; i < 3; i++) s = s.replace(PREFIX, '').trim();
    s = s
      .replace(/[*#]/g, ' ')
      .replace(/\S*\d\S*/g, ' ')
      .replace(/[^\p{L}\p{N}&' ]+/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const key = s.split(' ').slice(0, 2).join(' ');
    return key || raw.toLowerCase();
  }

  function historyMap(data) {
    const counts = new Map();
    for (const t of data.transactions || []) {
      if (!t.memo || !t.category || t.category === '기타' || t.category === '기타수입') continue;
      const k = `${t.type}|${merchantKey(t.memo)}`;
      const m = counts.get(k) || new Map();
      m.set(t.category, (m.get(t.category) || 0) + 1);
      counts.set(k, m);
    }
    const out = new Map();
    for (const [k, m] of counts) out.set(k, [...m.entries()].sort((a, b) => b[1] - a[1])[0][0]);
    return out;
  }

  function guessCategory(memo, type, history, issuerCategory) {
    const k = `${type}|${merchantKey(memo)}`;
    if (history && history.has(k)) return { category: history.get(k), source: 'history' };
    if (type === 'income') return { category: PAYROLL.test(memo) ? '급여' : '기타수입', source: 'rule' };
    for (const [cat, re] of RULES) if (re.test(memo)) return { category: cat, source: 'rule' };
    if (issuerCategory) for (const [cat, re] of ISSUER_RULES) if (re.test(issuerCategory)) return { category: cat, source: 'issuer' };
    return { category: '기타', source: 'none' };
  }

  /* ---------- 분석 ---------- */
  const FORMAT_LABEL = { ledger: '가계부 CSV', card: '카드 이용내역', bank: '은행 거래내역' };
  const CHARGE_TYPE = /sale|purchase|debit|fee|interest|charge|installment|withdrawal|\batm\b|check|pos/i;

  /**
   * input: CSV 텍스트 또는 행 배열(엑셀)
   * 반환: 미리보기용 분석 결과 (data는 바꾸지 않음)
   */
  function analyze(input, data) {
    const rows = (Array.isArray(input) ? input.map((r) => (r || []).map((v) => (v == null ? '' : String(v)))) : parseCSV(input)).filter((r) =>
      r.some((v) => String(v).trim() !== '')
    );
    const empty = { format: null, currency: null, rows: [], payments: [], pending: 0, errors: [], duplicates: 0, cardPayments: [], merchants: [], header: null };
    if (!rows.length) return { ...empty, errors: ['빈 파일입니다.'] };
    const found = findHeader(rows) || guessHeaderless(rows);
    if (!found) {
      return {
        ...empty,
        errors: ['날짜와 금액 열을 찾지 못했습니다. 열 이름 행에 "Date / Transaction Date / 이용일자"와 "Amount / Debit / 이용금액" 같은 이름이 있어야 합니다.'],
      };
    }
    const { index, col } = found;
    const headerless = index < 0;
    const header = headerless ? [] : rows[index];
    const body = rows.slice(index + 1);
    const get = (r, k) => (col[k] >= 0 ? String(r[col[k]] == null ? '' : r[col[k]]).trim() : '');

    // 미국 파일 여부 (영문 헤더, 미국식 날짜, $ 표기)
    const english = !headerless && /^[a-z]/i.test(String(header[col.date] || '').trim());
    const usDates = body.slice(0, 20).filter((r) => /^\d{1,2}\/\d{1,2}\/\d{2,4}/.test(get(r, 'date'))).length;
    const dollars = body.slice(0, 20).some((r) => /\$/.test(get(r, 'amount') + get(r, 'withdraw') + get(r, 'deposit')));
    const us = english || headerless || usDates > 0 || dollars;
    const currency = us ? 'USD' : 'KRW';

    let format;
    if (col.category >= 0) format = 'ledger';
    else if (us) format = col.balance >= 0 || headerless ? 'bank' : 'card';
    else if (col.withdraw >= 0 || col.deposit >= 0) format = 'bank';
    else if (MERCHANT_HEADERS.test(header[col.memo] || '') || /이용|승인|매출/.test((header[col.amount] || '') + (header[col.date] || ''))) format = 'card';
    else format = col.type >= 0 ? 'ledger' : 'unknown';

    // 금액 열 하나로 부호만 다른 경우: 어느 부호가 "나가는 돈"인지 판별
    const split = col.withdraw >= 0 || col.deposit >= 0;
    let outSign = 1; // 원래 금액 × outSign > 0 이면 나가는 돈(구매·출금)
    if (!split && col.amount >= 0 && format !== 'ledger') {
      let pos = 0, neg = 0, tPos = 0, tNeg = 0;
      for (const r of body) {
        const a = parseAmount(get(r, 'amount'));
        if (!a) continue;
        const ty = get(r, 'type');
        if (ty && CHARGE_TYPE.test(ty) && !PAYMENT.test(ty)) a > 0 ? tPos++ : tNeg++;
        if (PAYMENT.test(get(r, 'memo')) || PAYMENT.test(ty)) continue;
        a > 0 ? pos++ : neg++;
      }
      if (tPos + tNeg > 0) outSign = tNeg > tPos ? -1 : 1;
      else if (format === 'unknown') {
        // 국내 은행: 부호가 섞여 있으면 음수 = 출금
        if (pos && neg) {
          format = 'bank';
          outSign = -1;
        } else format = 'ledger';
      } else if (pos !== neg) outSign = neg > pos ? -1 : 1;
      else outSign = format === 'bank' ? -1 : 1;
    }
    if (format === 'unknown') format = 'ledger';

    const knownEvents = new Map((data.events || []).map((e) => [e.title, e.id]));
    const out = [];
    const payments = [];
    let pending = 0;
    const errors = [];
    body.forEach((r, i) => {
      const line = index + i + 2;
      const rawDate = get(r, 'date');
      const date = normalizeDate(rawDate);
      if (!date) {
        const joined = r.join(' ');
        if (r.some((v) => String(v).trim()) && !/합계|소계|총|total|balance|beginning|ending|summary/i.test(joined))
          errors.push(`${line}행: 날짜를 읽을 수 없습니다 (${rawDate.slice(0, 20) || '빈 칸'})`);
        return;
      }
      if (/pending/i.test(get(r, 'status'))) {
        pending++; // 승인 대기 건은 확정된 뒤 다시 나오므로 건너뜀
        return;
      }
      const memo = get(r, 'memo');
      const typeRaw = get(r, 'type');
      const issuerCategory = get(r, 'issuerCategory');
      const base = { line, date, memo, issuerCategory, category: get(r, 'category') || null, eventId: knownEvents.get(get(r, 'event')) || null };
      base.tags = get(r, 'tags') ? get(r, 'tags').split(/[;|#]/).map((s) => s.trim()).filter(Boolean) : [];

      // 이 앱의 CSV: 구분 열로 지출/수입
      if (format === 'ledger') {
        const a = parseAmount(get(r, 'amount'));
        if (!a) {
          if (a == null && get(r, 'amount')) errors.push(`${line}행: 금액을 읽을 수 없습니다`);
          return;
        }
        out.push({ ...base, type: /수입|입금|income/i.test(typeRaw) ? 'income' : 'expense', amount: Math.abs(a), refund: false });
        return;
      }

      // 나가는 돈(+) / 들어오는 돈(-)으로 통일
      let flow;
      if (split) {
        const w = Math.abs(parseAmount(get(r, 'withdraw')) || 0);
        const dep = Math.abs(parseAmount(get(r, 'deposit')) || 0);
        flow = w && !dep ? w : dep && !w ? -dep : w - dep;
        if (!flow && col.amount >= 0) flow = (parseAmount(get(r, 'amount')) || 0) * outSign;
      } else {
        const a = parseAmount(get(r, 'amount'));
        if (a == null) {
          if (get(r, 'amount')) errors.push(`${line}행: 금액을 읽을 수 없습니다 (${get(r, 'amount').slice(0, 20)})`);
          return;
        }
        flow = a * outSign;
      }
      if (!flow) return;
      flow = Math.round(flow * 100) / 100;

      if (format === 'card') {
        const koreanCancel = !us && (REFUND.test(get(r, 'cancel')) || REFUND.test(typeRaw));
        if (koreanCancel) {
          out.push({ ...base, type: 'expense', amount: -Math.abs(flow), refund: true });
          return;
        }
        if (flow > 0) {
          out.push({ ...base, type: 'expense', amount: flow, refund: false });
          return;
        }
        // 들어온 돈: 급여·입금이면 수입, 카드 대금 납부면 제외, 아니면 환불
        if (DEPOSIT.test(memo) || DEPOSIT.test(typeRaw)) {
          out.push({ ...base, type: 'income', amount: -flow, refund: false });
          return;
        }
        const isPayment = (PAYMENT.test(typeRaw) || PAYMENT.test(memo) || /payment/i.test(issuerCategory)) && !REFUND.test(typeRaw + ' ' + memo);
        if (isPayment) payments.push({ ...base, amount: -flow });
        else out.push({ ...base, type: 'expense', amount: flow, refund: true });
        return;
      }
      // 은행
      out.push({ ...base, type: flow > 0 ? 'expense' : 'income', amount: Math.abs(flow), refund: false });
    });

    // 중복: 이미 있는 거래와 날짜·구분·금액·메모가 같으면 건너뜀 (같은 파일 안의 동일 거래는 유지)
    const key = (t) => `${t.date}|${t.type}|${Math.round(t.amount * 100)}|${String(t.memo || '').trim().replace(/\s+/g, ' ').toLowerCase()}`;
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

    // 은행 파일의 카드대금 출금 (카드 내역과 이중 계산 방지)
    const cardPayments = format === 'bank' ? fresh.filter((t) => t.type === 'expense' && CARD_PAYMENT.test(t.memo.trim())) : [];

    const history = historyMap(data);
    const merchants = new Map();
    for (const t of fresh) {
      if (t.category) continue;
      const k = `${t.type}|${merchantKey(t.memo)}`;
      let m = merchants.get(k);
      if (!m) {
        m = { key: k, memo: t.memo || '(내용 없음)', type: t.type, count: 0, total: 0, issuerCategory: t.issuerCategory || '', ...guessCategory(t.memo, t.type, history, t.issuerCategory) };
        merchants.set(k, m);
      }
      m.count++;
      m.total = Math.round((m.total + t.amount) * 100) / 100;
      t.merchantKey = k;
    }

    const dates = fresh.map((t) => t.date).sort();
    return {
      format,
      formatLabel: FORMAT_LABEL[format],
      currency,
      header: {
        row: index + 1,
        headerless,
        columns: headerless ? { date: '1열', amount: '2열', memo: `${col.memo + 1}열` } : Object.fromEntries(Object.entries(col).filter(([, v]) => v >= 0).map(([k, v]) => [k, header[v]])),
      },
      rows: fresh,
      payments,
      pending,
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
   * opts.skipCardPayments: 은행의 카드대금 출금 제외 (기본 true)
   * opts.linkTrips: 여행 기간의 지출을 여행에 연결 (기본 true)
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

  return { decode, parseCSV, detectDelimiter, findColumns, normalizeDate, parseAmount, merchantKey, guessCategory, analyze, build, transactionsToCSV, FORMAT_LABEL };
});
