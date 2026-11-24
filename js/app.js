/* global Chart, Analytics, Store, Sample */
(function () {
  'use strict';
  const A = Analytics;

  /* =========================================================
   * 유틸
   * ======================================================= */
  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const won = (n) => `${Math.round(n || 0).toLocaleString('ko-KR')}원`;
  const man = (n) => {
    const v = Math.round(n || 0);
    if (Math.abs(v) >= 100000000) return `${(v / 100000000).toFixed(1).replace(/\.0$/, '')}억`;
    if (Math.abs(v) >= 10000) return `${(v / 10000).toFixed(Math.abs(v) >= 1000000 ? 0 : 1).replace(/\.0$/, '')}만`;
    return v.toLocaleString('ko-KR');
  };
  const pct = (x, digits = 0) => (x == null || !isFinite(x) ? '–' : `${x >= 0 ? '+' : ''}${(x * 100).toFixed(digits)}%`);
  const pad = A.pad;
  const today = new Date();
  const TODAY = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
  const CUR_Y = today.getFullYear();
  const CUR_M = today.getMonth() + 1;
  const fmtDate = (d) => (d ? `${d.slice(0, 4)}.${d.slice(5, 7)}.${d.slice(8, 10)}` : '');
  const fmtRange = (s, e) => {
    if (!e || e === s) return fmtDate(s);
    return s.slice(0, 4) === e.slice(0, 4) ? `${fmtDate(s)} ~ ${e.slice(5, 7)}.${e.slice(8, 10)}` : `${fmtDate(s)} ~ ${fmtDate(e)}`;
  };
  const WEEK = ['일', '월', '화', '수', '목', '금', '토'];
  const weekday = (d) => WEEK[new Date(d + 'T00:00:00').getDay()];
  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  function toast(msg) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2400);
  }

  function download(filename, text, type) {
    const blob = new Blob([text], { type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  const data = () => Store.data;
  const txs = () => Store.data.transactions;

  /* =========================================================
   * 차트 (Chart.js)
   * ======================================================= */
  let charts = [];
  function destroyCharts() {
    charts.forEach((c) => c.destroy());
    charts = [];
  }
  function theme() {
    return {
      ink: cssVar('--ink'),
      ink2: cssVar('--ink-2'),
      muted: cssVar('--muted'),
      grid: cssVar('--grid'),
      axis: cssVar('--axis'),
      surface: cssVar('--surface'),
      y: [cssVar('--y0'), cssVar('--y1'), cssVar('--y2')],
      accent: cssVar('--accent'),
      expense: cssVar('--expense'),
      income: cssVar('--income'),
      critical: cssVar('--critical'),
      warning: cssVar('--warning'),
      good: cssVar('--good'),
    };
  }
  function baseOptions(t, extra = {}) {
    return {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 250 },
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          position: 'top',
          align: 'end',
          labels: { color: t.ink2, boxWidth: 14, boxHeight: 2, usePointStyle: false, font: { size: 12 } },
        },
        tooltip: {
          backgroundColor: t.surface,
          titleColor: t.ink,
          bodyColor: t.ink2,
          borderColor: t.axis,
          borderWidth: 1,
          padding: 10,
          callbacks: { label: (ctx) => ` ${ctx.dataset.label}: ${ctx.parsed.y == null ? '–' : won(ctx.parsed.y)}` },
        },
      },
      scales: {
        x: { grid: { display: false }, border: { color: t.axis }, ticks: { color: t.muted } },
        y: {
          beginAtZero: true,
          grid: { color: t.grid },
          border: { display: false },
          ticks: { color: t.muted, callback: (v) => man(v), maxTicksLimit: 6 },
        },
      },
      ...extra,
    };
  }
  function makeChart(canvas, config) {
    if (!canvas) return null;
    const c = new Chart(canvas, config);
    charts.push(c);
    return c;
  }
  const MONTH_LABELS = [...Array(12)].map((_, i) => `${i + 1}월`);

  /** 3개 연도 라인 (올해/전년/전전년) */
  function threeYearLines(t, seriesByYear, years, { cutCurrent = true } = {}) {
    return years.map((y, i) => {
      let values = seriesByYear[y];
      if (cutCurrent && y === CUR_Y) values = values.map((v, m) => (m + 1 > CUR_M ? null : v));
      return {
        label: `${y}년`,
        data: values,
        borderColor: t.y[i],
        backgroundColor: t.y[i],
        borderWidth: i === 0 ? 2.5 : 2,
        pointRadius: i === 0 ? 3 : 0,
        pointHoverRadius: 5,
        pointBorderColor: t.surface,
        pointBorderWidth: 2,
        tension: 0.25,
        spanGaps: false,
        order: i,
      };
    });
  }

  /* =========================================================
   * 라우터 & 상태
   * ======================================================= */
  const UI = {
    view: 'dashboard',
    year: CUR_Y,
    ym: { y: CUR_Y, m: CUR_M },
    ledgerCat: '',
    ledgerText: '',
    calSel: null,
    recYear: CUR_Y,
    recMonth: CUR_M,
    recCat: null,
    evKind: 'all',
    evYear: 'all',
    query: '',
  };

  function parseHash() {
    const h = location.hash.replace(/^#\/?/, '');
    // 이메일 인증·로그인 링크로 돌아온 경우 (#access_token=… / #error=…)
    if (/(^|&)(access_token|error|error_description)=/.test(h)) {
      const p = new URLSearchParams(h);
      if (p.get('error_description')) setTimeout(() => toast(`로그인 실패: ${p.get('error_description')}`), 0);
      return { view: 'dashboard', params: new URLSearchParams() };
    }
    const [view, qs] = h.split('?');
    const params = new URLSearchParams(qs || '');
    return { view: view || 'dashboard', params };
  }

  function go(view, params) {
    const qs = params ? `?${new URLSearchParams(params).toString()}` : '';
    location.hash = `#/${view}${qs}`;
  }

  const VIEWS = {};
  function render() {
    const { view, params } = parseHash();
    UI.view = VIEWS[view] ? view : 'dashboard';
    if (UI.view === 'search') UI.query = params.get('q') || '';
    $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === UI.view));
    destroyCharts();
    const root = $('#view');
    const scrollY = window.scrollY;
    root.innerHTML = '';
    VIEWS[UI.view](root);
    if (render.keepScroll) window.scrollTo(0, scrollY);
    render.keepScroll = false;
  }
  /** 같은 화면에서 상태만 바뀔 때 스크롤 유지 */
  function rerender() {
    render.keepScroll = true;
    render();
  }

  function yearsAvailable() {
    const ys = new Set(A.yearsWithData(txs()));
    data().events.forEach((e) => ys.add(A.yearOf(e.startDate)));
    ys.add(CUR_Y);
    return [...ys].sort((a, b) => b - a);
  }

  /** 지출이 있는 가장 최근 달 (오늘 이후 제외) */
  function latestMonth() {
    const dates = txs().filter((t) => t.date <= TODAY).map((t) => t.date);
    if (!dates.length) return { y: CUR_Y, m: CUR_M };
    const max = dates.reduce((a, b) => (a > b ? a : b));
    return { y: A.yearOf(max), m: A.monthOf(max) };
  }

  const isEmpty = () => !txs().length && !data().events.length;

  /* =========================================================
   * 공통 조각
   * ======================================================= */
  function yearSelect(id, value, years = yearsAvailable()) {
    return `<select id="${id}">${years.map((y) => `<option value="${y}" ${y === value ? 'selected' : ''}>${y}년</option>`).join('')}</select>`;
  }
  function monthNav(label) {
    return `<div class="month-nav">
      <button class="icon-btn" data-nav="-1" aria-label="이전 달">‹</button>
      <div class="label">${label}</div>
      <button class="icon-btn" data-nav="1" aria-label="다음 달">›</button>
      <button class="btn small" data-nav="0">오늘</button>
    </div>`;
  }
  function bindMonthNav(root) {
    $$('[data-nav]', root).forEach((b) =>
      b.addEventListener('click', () => {
        const d = Number(b.dataset.nav);
        if (d === 0) UI.ym = { y: CUR_Y, m: CUR_M };
        else {
          const dt = new Date(UI.ym.y, UI.ym.m - 1 + d, 1);
          UI.ym = { y: dt.getFullYear(), m: dt.getMonth() + 1 };
        }
        UI.calSel = null;
        rerender();
      })
    );
  }
  function badge(status, label) {
    return `<span class="badge ${status}">${esc(label || A.STATUS_LABEL[status] || status)}</span>`;
  }
  function eventBadge(ev) {
    if (!ev) return '';
    return `<span class="badge ${ev.kind === 'trip' ? 'trip' : 'plain'}">${ev.kind === 'trip' ? '✈ ' : ''}${esc(ev.title)}</span>`;
  }
  function deltaHtml(cur, prev, label) {
    if (!prev) return `<div class="delta">${label}: 데이터 없음</div>`;
    const d = (cur - prev) / prev;
    const cls = d > 0 ? 'delta-up' : 'delta-down';
    return `<div class="delta">${label} <span class="${cls}">${d > 0 ? '▲' : '▼'} ${pct(Math.abs(d)).replace('+', '')}</span> (${man(prev)}원)</div>`;
  }
  function txRow(t) {
    const ev = t.eventId ? Store.event(t.eventId) : null;
    return `<div class="tx" data-tx="${t.id}">
      <span class="dot" style="background:${esc(Store.color(t.category))}"></span>
      <span class="cat">${esc(t.category)}</span>
      <span class="memo">${esc(t.memo || '')}${eventBadge(ev)}</span>
      <span class="amt ${t.type}">${t.type === 'income' ? '+' : '-'}${won(t.amount)}</span>
    </div>`;
  }
  function txListGrouped(list) {
    if (!list.length) return '<div class="empty">거래 내역이 없습니다.</div>';
    const byDate = new Map();
    [...list].sort((a, b) => b.date.localeCompare(a.date)).forEach((t) => {
      if (!byDate.has(t.date)) byDate.set(t.date, []);
      byDate.get(t.date).push(t);
    });
    return [...byDate.entries()]
      .map(([d, items]) => {
        const exp = A.sum(items.filter((t) => t.type === 'expense').map((t) => t.amount));
        return `<div class="tx-day"><div class="tx-day-head"><span>${Number(d.slice(8))}일 (${weekday(d)})</span><span class="num">${exp ? '-' + won(exp) : ''}</span></div>${items.map(txRow).join('')}</div>`;
      })
      .join('');
  }
  function bindTxClicks(root) {
    $$('[data-tx]', root).forEach((el) => el.addEventListener('click', () => openTxForm(txs().find((t) => t.id === el.dataset.tx))));
    $$('[data-ev]', root).forEach((el) =>
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        openEventDetail(el.dataset.ev);
      })
    );
  }
  function barList(items, total) {
    const max = Math.max(...items.map((i) => i.total), 1);
    return `<div class="bar-list">${items
      .map(
        (i) => `<div class="bar-item">
          <span class="row" style="gap:6px;flex-wrap:nowrap;min-width:0"><span class="dot" style="background:${esc(Store.color(i.category))}"></span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(i.category)}</span></span>
          <div class="bar-track"><div class="bar-fill" style="width:${(i.total / max) * 100}%"></div></div>
          <span class="num">${won(i.total)}${total ? ` <span class="muted small">${Math.round((i.total / total) * 100)}%</span>` : ''}</span>
        </div>`
      )
      .join('')}</div>`;
  }

  /* =========================================================
   * 첫 화면
   * ======================================================= */
  function welcome(root) {
    root.innerHTML = `<div class="welcome card">
      <h1>가계부 + 캘린더</h1>
      <p class="muted">지출·수입을 기록하고, 여행·일정과 연결하고, 3년치 데이터로 고정비 이상 여부를 확인하세요.</p>
      <ul>
        <li>월별·연도별 지출과 <b>전년·전전년 비교 그래프</b></li>
        <li>가스비·수도비·주유비 등 <b>고정비의 계절 패턴</b>과 이상 급등 감지</li>
        <li>“여행” 검색 한 번으로 <b>언제·어디로·며칠·얼마</b>를 한눈에</li>
        <li>${
          Auth.user
            ? `<b>${esc(Auth.user.email)}</b> 계정에 저장되어 여러 기기에서 동기화됩니다`
            : Auth.enabled
              ? '로그인하면 여러 기기에서 같은 데이터를 쓸 수 있습니다 (로그인 없이도 이 브라우저에 저장)'
              : '데이터는 이 브라우저에만 저장됩니다 (CSV/JSON 백업 지원)'
        }</li>
      </ul>
      <div class="row" style="justify-content:center;margin-top:12px">
        ${Auth.enabled && !Auth.user ? '<button class="btn primary" id="w-login">로그인 / 회원가입</button>' : ''}
        <button class="btn ${Auth.enabled && !Auth.user ? '' : 'primary'}" id="w-sample">샘플 데이터로 체험하기</button>
        <button class="btn" id="w-tx">첫 거래 입력하기</button>
        <a class="btn" href="#/data" style="text-decoration:none">CSV 가져오기</a>
      </div>
    </div>`;
    $('#w-sample').onclick = () => {
      Store.replace(Sample.generate(today));
      toast('샘플 데이터(최근 3년)를 불러왔습니다.');
      render();
    };
    $('#w-tx').onclick = () => openTxForm();
    if ($('#w-login')) $('#w-login').onclick = () => openLoginModal();
  }

  /* =========================================================
   * 대시보드
   * ======================================================= */
  VIEWS.dashboard = function (root) {
    if (isEmpty() && Auth.user && Auth.status === 'syncing') {
      root.innerHTML = '<div class="card empty">계정 데이터를 불러오는 중…</div>';
      return;
    }
    if (isEmpty()) return welcome(root);
    const Y = UI.year;
    const isCur = Y === CUR_Y;
    const uptoM = isCur ? CUR_M : 12;
    const years = [Y, Y - 1, Y - 2];
    const series = {};
    years.forEach((y) => (series[y] = A.monthlyTotals(txs(), y, { type: 'expense' })));
    const income = A.monthlyTotals(txs(), Y, { type: 'income' });
    const ytd = (arr) => A.sum(arr.slice(0, uptoM));
    const ytdExp = ytd(series[Y]);
    const ytdPrev = ytd(series[Y - 1]);
    const ytdInc = ytd(income);
    const mExp = series[Y][uptoM - 1];
    const mPrev = series[Y - 1][uptoM - 1];
    const saving = ytdInc ? (ytdInc - ytdExp) / ytdInc : null;

    // 고정비 점검: 최근 2개월
    const lm = latestMonth();
    const prevM = new Date(lm.y, lm.m - 2, 1);
    const checks = [
      ...A.recurringOverview(txs(), data().categories, lm.y, lm.m, data().settings),
      ...A.recurringOverview(txs(), data().categories, prevM.getFullYear(), prevM.getMonth() + 1, data().settings),
    ];
    const flagged = checks.filter((r) => ['alert', 'warn', 'event'].includes(r.status));
    const order = { alert: 0, warn: 1, event: 2 };
    flagged.sort((a, b) => order[a.status] - order[b.status]);

    const upcoming = [...data().events]
      .filter((e) => (e.endDate || e.startDate) >= TODAY)
      .sort((a, b) => a.startDate.localeCompare(b.startDate))
      .slice(0, 4);
    const recent = [...data().events]
      .filter((e) => (e.endDate || e.startDate) < TODAY)
      .sort((a, b) => b.startDate.localeCompare(a.startDate))
      .slice(0, 4 - Math.min(upcoming.length, 2));

    const periodNote = isCur ? `1~${uptoM}월 기준` : '연간';

    root.innerHTML = `
      <div class="page-head">
        <div><h1>대시보드</h1><div class="sub">${Y}년 · ${periodNote}, 전년 동기와 비교</div></div>
        <div class="row">${yearSelect('d-year', Y)}<button class="btn primary" id="d-add">+ 거래 추가</button></div>
      </div>
      <div class="grid grid-4">
        <div class="card stat"><div class="label">${Y}년 누적 지출</div><div class="value num">${won(ytdExp)}</div>${deltaHtml(ytdExp, ytdPrev, '전년 동기')}</div>
        <div class="card stat"><div class="label">${uptoM}월 지출</div><div class="value num">${won(mExp)}</div>${deltaHtml(mExp, mPrev, `${Y - 1}년 ${uptoM}월`)}</div>
        <div class="card stat"><div class="label">${Y}년 누적 수입</div><div class="value num">${won(ytdInc)}</div><div class="delta">잔액 ${won(ytdInc - ytdExp)}</div></div>
        <div class="card stat"><div class="label">저축률</div><div class="value num">${saving == null ? '–' : Math.round(saving * 100) + '%'}</div><div class="delta">(수입 − 지출) ÷ 수입</div></div>
      </div>

      <div class="grid grid-3 mt">
        <div class="card span-2">
          <div class="card-head"><div><h2>월별 지출 — 3년 비교</h2><p class="hint">같은 달끼리 비교해 올해 지출 흐름이 예년과 다른지 확인</p></div></div>
          <div class="chart-box"><canvas id="c-monthly"></canvas></div>
        </div>
        <div class="card">
          <div class="card-head"><div><h2>고정비 점검</h2><p class="hint">${lm.y}년 ${prevM.getMonth() + 1}~${lm.m}월 · 예년 같은 달 대비</p></div><a href="#/recurring" class="small">자세히</a></div>
          ${
            flagged.length
              ? flagged
                  .slice(0, 5)
                  .map(
                    (r) => `<div class="alert-item">${badge(r.status)}<div><strong>${r.month}월 ${esc(r.category)}</strong> <span class="num">${won(r.actual)}</span> <span class="muted small">(예상 ${man(r.reference)}원, ${pct(r.diff)})</span><p>${esc(shortExplain(r))}</p></div></div>`
                  )
                  .join('')
              : `<div class="empty">${checks.some((c) => c.status !== 'nodata') ? '✓ 최근 고정비는 모두 정상 범위입니다.' : '비교할 이전 연도 데이터가 없습니다.'}</div>`
          }
        </div>
      </div>

      <div class="grid grid-2 mt">
        <div class="card">
          <div class="card-head"><div><h2>연도별 수입·지출</h2><p class="hint">${isCur ? `올해는 ${CUR_M}월까지` : ''}</p></div></div>
          <div class="chart-box short"><canvas id="c-yearly"></canvas></div>
        </div>
        <div class="card">
          <div class="card-head"><div><h2>카테고리별 지출 — 3년 비교</h2><p class="hint">각 연도 ${periodNote}, 올해 지출 상위 8개</p></div></div>
          <div class="chart-box short"><canvas id="c-cat"></canvas></div>
        </div>
      </div>

      <div class="grid grid-2 mt">
        <div class="card">
          <div class="card-head"><div><h2>${uptoM}월 카테고리별 지출</h2></div><a href="#/ledger" class="small">가계부 보기</a></div>
          ${(() => {
            const items = A.categoryTotals(txs(), { year: Y, month: uptoM }).slice(0, 8);
            return items.length ? barList(items, mExp) : '<div class="empty">지출 없음</div>';
          })()}
        </div>
        <div class="card">
          <div class="card-head"><div><h2>여행·일정</h2></div><a href="#/events" class="small">전체 보기</a></div>
          ${
            [...upcoming, ...recent].length
              ? [...upcoming, ...recent]
                  .map((e) => {
                    const s = A.eventSummary(e, txs());
                    const soon = e.startDate >= TODAY;
                    return `<div class="alert-item" data-ev="${e.id}" style="cursor:pointer">${badge(e.kind === 'trip' ? 'trip' : 'plain', soon ? '예정' : e.kind === 'trip' ? '여행' : '일정')}<div><strong>${esc(e.title)}</strong> <span class="muted small">${fmtRange(e.startDate, e.endDate)} · ${A.periodLabel(s.days)}</span><p>${e.destination ? esc(e.destination) + ' · ' : ''}지출 ${won(s.total)}</p></div></div>`;
                  })
                  .join('')
              : '<div class="empty">등록된 일정이 없습니다.</div>'
          }
        </div>
      </div>`;

    $('#d-year').onchange = (e) => {
      UI.year = Number(e.target.value);
      rerender();
    };
    $('#d-add').onclick = () => openTxForm();
    bindTxClicks(root);

    const t = theme();
    makeChart($('#c-monthly'), {
      type: 'line',
      data: { labels: MONTH_LABELS, datasets: threeYearLines(t, series, years) },
      options: baseOptions(t),
    });

    const allYears = yearsAvailable().slice().reverse();
    const yExp = A.yearlyTotals(txs(), { type: 'expense' });
    const yInc = A.yearlyTotals(txs(), { type: 'income' });
    makeChart($('#c-yearly'), {
      type: 'bar',
      data: {
        labels: allYears.map((y) => `${y}${y === CUR_Y ? '*' : ''}`),
        datasets: [
          { label: '수입', data: allYears.map((y) => yInc[y] || 0), backgroundColor: t.y[0], borderRadius: 4, borderSkipped: 'start', maxBarThickness: 36 },
          { label: '지출', data: allYears.map((y) => yExp[y] || 0), backgroundColor: t.y[1], borderRadius: 4, borderSkipped: 'start', maxBarThickness: 36 },
        ],
      },
      options: baseOptions(t, { datasets: { bar: { categoryPercentage: 0.7, barPercentage: 0.9 } } }),
    });

    const months = [...Array(uptoM)].map((_, i) => i + 1);
    const catYear = (y) => {
      const m = new Map();
      for (const tx of txs()) {
        if (tx.type !== 'expense' || A.yearOf(tx.date) !== y || A.monthOf(tx.date) > uptoM) continue;
        m.set(tx.category, (m.get(tx.category) || 0) + tx.amount);
      }
      return m;
    };
    const cy = years.map(catYear);
    const topCats = [...cy[0].entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map((e) => e[0]);
    void months;
    makeChart($('#c-cat'), {
      type: 'bar',
      data: {
        labels: topCats,
        datasets: years.map((y, i) => ({
          label: `${y}년`,
          data: topCats.map((c) => cy[i].get(c) || 0),
          backgroundColor: t.y[i],
          borderRadius: 4,
          borderSkipped: 'start',
          maxBarThickness: 14,
        })),
      },
      options: (() => {
        const o = baseOptions(t, { indexAxis: 'y', datasets: { bar: { categoryPercentage: 0.8, barPercentage: 0.9 } } });
        o.scales = {
          x: { beginAtZero: true, grid: { color: t.grid }, border: { display: false }, ticks: { color: t.muted, callback: (v) => man(v), maxTicksLimit: 5 } },
          y: { grid: { display: false }, border: { color: t.axis }, ticks: { color: t.ink2 } },
        };
        o.plugins.tooltip.callbacks.label = (ctx) => ` ${ctx.dataset.label}: ${won(ctx.parsed.x)}`;
        return o;
      })(),
    });
  };

  function shortExplain(r) {
    if (r.status === 'event') return `여행·일정 관련 ${won(r.eventAmount)} 포함. 제외하면 ${pct(r.diffExcludingEvents)}로 정상 범위.`;
    const parts = [];
    if (r.seasonalIndex != null && r.seasonalIndex <= 0.8) parts.push('예년엔 지출이 적던 달 — 상승 시점이 평소보다 이릅니다.');
    else if (r.seasonalIndex != null && r.seasonalIndex >= 1.2) parts.push('계절적 상승 시기지만 예년보다 더 높습니다.');
    parts.push(r.status === 'alert' ? '누수·요금 변경·사용량 급증 여부를 확인하세요.' : '조금 높은 편입니다.');
    return parts.join(' ');
  }

  /* =========================================================
   * 가계부 (월별 목록)
   * ======================================================= */
  VIEWS.ledger = function (root) {
    const { y, m } = UI.ym;
    const monthTx = txs().filter((t) => A.yearOf(t.date) === y && A.monthOf(t.date) === m);
    const exp = A.sum(monthTx.filter((t) => t.type === 'expense').map((t) => t.amount));
    const inc = A.sum(monthTx.filter((t) => t.type === 'income').map((t) => t.amount));
    const prevYearExp = A.sum(A.filterTx(txs(), { year: y - 1, month: m }).map((t) => t.amount));
    const cats = A.categoryTotals(monthTx, { type: 'expense' });
    const q = UI.ledgerText.trim().toLowerCase();
    const shown = monthTx.filter(
      (t) =>
        (!UI.ledgerCat || t.category === UI.ledgerCat) &&
        (!q || [t.memo, t.category, ...(t.tags || [])].join(' ').toLowerCase().includes(q))
    );
    const shownSum = A.sum(shown.filter((t) => t.type === 'expense').map((t) => t.amount));
    const allCats = [...new Set(monthTx.map((t) => t.category))];

    root.innerHTML = `
      <div class="page-head">
        ${monthNav(`${y}년 ${m}월`)}
        <button class="btn primary" id="l-add">+ 거래 추가</button>
      </div>
      <div class="grid grid-3">
        <div class="card stat"><div class="label">지출</div><div class="value num">${won(exp)}</div>${deltaHtml(exp, prevYearExp, `${y - 1}년 ${m}월`)}</div>
        <div class="card stat"><div class="label">수입</div><div class="value num" style="color:var(--income)">${won(inc)}</div></div>
        <div class="card stat"><div class="label">잔액</div><div class="value num">${won(inc - exp)}</div></div>
      </div>
      <div class="grid grid-3 mt">
        <div class="card span-2">
          <div class="card-head" style="flex-wrap:wrap">
            <h2>내역 <span class="muted small">${shown.length}건${UI.ledgerCat || q ? ` · 지출 ${won(shownSum)}` : ''}</span></h2>
            <div class="row">
              <select id="l-cat"><option value="">전체 카테고리</option>${allCats.map((c) => `<option ${c === UI.ledgerCat ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>
              <input type="search" id="l-q" placeholder="메모 검색" value="${esc(UI.ledgerText)}" style="width:140px" />
            </div>
          </div>
          ${txListGrouped(shown)}
        </div>
        <div class="card">
          <h2>카테고리별 지출</h2><p class="hint">막대를 누르면 해당 항목만 표시</p>
          ${cats.length ? barList(cats, exp) : '<div class="empty">지출 없음</div>'}
        </div>
      </div>`;
    bindMonthNav(root);
    $('#l-add').onclick = () => openTxForm({ date: y === CUR_Y && m === CUR_M ? TODAY : `${y}-${pad(m)}-01` });
    $('#l-cat').onchange = (e) => {
      UI.ledgerCat = e.target.value;
      rerender();
    };
    $('#l-q').oninput = debounce((e) => {
      UI.ledgerText = e.target.value;
      rerender();
      const el = $('#l-q');
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }, 250);
    $$('.bar-item', root).forEach((el, i) =>
      el.addEventListener('click', () => {
        UI.ledgerCat = UI.ledgerCat === cats[i].category ? '' : cats[i].category;
        rerender();
      })
    );
    $$('.bar-item', root).forEach((el) => (el.style.cursor = 'pointer'));
    bindTxClicks(root);
  };

  function debounce(fn, ms) {
    let id;
    return (...args) => {
      clearTimeout(id);
      id = setTimeout(() => fn(...args), ms);
    };
  }

  /* =========================================================
   * 캘린더
   * ======================================================= */
  VIEWS.calendar = function (root) {
    const { y, m } = UI.ym;
    const first = new Date(y, m - 1, 1);
    const start = new Date(y, m - 1, 1 - first.getDay());
    const cells = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      cells.push(d);
      if (i >= 34 && d.getMonth() !== m - 1 && d.getDay() === 6) break;
    }
    const dateStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const byDate = new Map();
    for (const t of txs()) {
      const v = byDate.get(t.date) || { expense: 0, income: 0 };
      v[t.type] += t.amount;
      byDate.set(t.date, v);
    }
    const monthTx = A.filterTx(txs(), { type: null, year: y, month: m });
    const exp = A.sum(monthTx.filter((t) => t.type === 'expense').map((t) => t.amount));
    const inc = A.sum(monthTx.filter((t) => t.type === 'income').map((t) => t.amount));
    const sel = UI.calSel;

    const cellHtml = (d) => {
      const ds = dateStr(d);
      const v = byDate.get(ds);
      const evs = Store.eventsOn(ds);
      const cls = ['cal-d', d.getMonth() !== m - 1 ? 'other' : '', ds === TODAY ? 'today' : '', ds === sel ? 'sel' : '', d.getDay() === 0 ? 'sun' : '', d.getDay() === 6 ? 'sat' : '']
        .filter(Boolean)
        .join(' ');
      return `<div class="${cls}" data-day="${ds}">
        <span class="dn">${d.getDate()}</span>
        ${evs
          .slice(0, 2)
          .map((e) => `<div class="cal-ev ${e.kind === 'trip' ? 'trip' : ''}" title="${esc(e.title)}">${e.kind === 'trip' ? '✈ ' : ''}${esc(e.title)}</div>`)
          .join('')}${evs.length > 2 ? `<div class="cal-ev">+${evs.length - 2}</div>` : ''}
        <div class="cal-amt">${v && v.expense ? `<span class="e">-${man(v.expense)}</span>` : ''}${v && v.income ? `<span class="i">+${man(v.income)}</span>` : ''}</div>
      </div>`;
    };

    let dayPanel = '';
    if (sel) {
      const dayTx = txs().filter((t) => t.date === sel);
      const evs = Store.eventsOn(sel);
      dayPanel = `<div class="card mt" id="day-panel">
        <div class="card-head" style="flex-wrap:wrap">
          <h2>${fmtDate(sel)} (${weekday(sel)})</h2>
          <div class="row"><button class="btn small" id="cd-ev">+ 일정</button><button class="btn small primary" id="cd-tx">+ 거래</button></div>
        </div>
        ${evs.map((e) => `<div class="alert-item" data-ev="${e.id}" style="cursor:pointer">${badge(e.kind === 'trip' ? 'trip' : 'plain', e.kind === 'trip' ? '여행' : '일정')}<div><strong>${esc(e.title)}</strong> <span class="muted small">${fmtRange(e.startDate, e.endDate)}</span><p>${e.destination ? esc(e.destination) + ' · ' : ''}일정 전체 지출 ${won(A.eventSummary(e, txs()).total)}</p></div></div>`).join('')}
        ${dayTx.length ? dayTx.map(txRow).join('') : '<div class="empty">이 날의 거래가 없습니다.</div>'}
      </div>`;
    }

    root.innerHTML = `
      <div class="page-head">
        ${monthNav(`${y}년 ${m}월`)}
        <div class="row small"><span>지출 <b class="num">${won(exp)}</b></span><span style="color:var(--income)">수입 <b class="num">${won(inc)}</b></span>
          <button class="btn small" id="c-ev">+ 일정·여행</button></div>
      </div>
      <div class="cal">
        ${WEEK.map((w, i) => `<div class="cal-h ${i === 0 ? 'sun' : i === 6 ? 'sat' : ''}">${w}</div>`).join('')}
        ${cells.map(cellHtml).join('')}
      </div>
      ${dayPanel}`;
    bindMonthNav(root);
    $$('[data-day]', root).forEach((el) =>
      el.addEventListener('click', () => {
        UI.calSel = UI.calSel === el.dataset.day ? null : el.dataset.day;
        rerender();
        const p = $('#day-panel');
        if (p) p.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      })
    );
    $('#c-ev').onclick = () => openEventForm({ startDate: sel || TODAY });
    if (sel) {
      $('#cd-tx').onclick = () => {
        const evs = Store.eventsOn(sel);
        openTxForm({ date: sel, eventId: evs.length === 1 ? evs[0].id : null });
      };
      $('#cd-ev').onclick = () => openEventForm({ startDate: sel });
    }
    bindTxClicks(root);
  };

  /* =========================================================
   * 고정비 분석
   * ======================================================= */
  VIEWS.recurring = function (root) {
    const recCats = data().categories.filter((c) => c.recurring && c.type === 'expense');
    if (!recCats.length) {
      root.innerHTML = `<div class="card empty">고정비로 지정된 카테고리가 없습니다. <a href="#/data">데이터 › 카테고리</a>에서 지정하세요.</div>`;
      return;
    }
    if (!UI.recCat || !recCats.some((c) => c.name === UI.recCat)) UI.recCat = recCats[0].name;
    if (!render.recInit) {
      const lm = latestMonth();
      UI.recYear = lm.y;
      UI.recMonth = lm.m;
      render.recInit = true;
    }
    const Y = UI.recYear;
    const M = UI.recMonth;
    const s = data().settings;
    const lastM = Y === CUR_Y ? CUR_M : 12;

    // 히트맵: 카테고리 × 월
    const grid = recCats.map((c) => ({
      cat: c,
      cells: [...Array(12)].map((_, i) => (i + 1 <= lastM ? A.analyzeRecurring(txs(), c.name, Y, i + 1, s) : null)),
    }));
    const t = theme();
    const heatBg = (r) => {
      if (!r || r.diff == null || r.status === 'nodata' || r.status === 'missing') return 'transparent';
      const d = Math.max(-0.6, Math.min(0.6, r.diff));
      const k = Math.abs(d) / 0.6;
      const pole = d >= 0 ? t.critical : t.accent;
      return `color-mix(in srgb, ${pole} ${Math.round(k * 85)}%, ${cssVar('--div-mid')})`;
    };
    const heatInk = (r) => (r && r.diff != null && Math.abs(r.diff) > 0.35 ? '#fff' : 'var(--ink)');

    const r = A.analyzeRecurring(txs(), UI.recCat, Y, M, s);
    const years = [Y, Y - 1, Y - 2];
    const catTx = txs().filter((x) => x.category === UI.recCat);
    const series = {};
    years.forEach((y) => (series[y] = A.monthlyTotals(catTx, y, { type: 'expense' })));
    const monthRows = [...Array(12)].map((_, i) => (i + 1 <= lastM ? A.analyzeRecurring(txs(), UI.recCat, Y, i + 1, s) : null));

    root.innerHTML = `
      <div class="page-head">
        <div><h1>고정비 분석</h1><div class="sub">같은 달의 최근 ${s.lookback}년 평균과 비교 · 올해 추세 보정 · 여행 등 일정 영향 분리</div></div>
        <div class="row">${yearSelect('r-year', Y)}
          <select id="r-month">${MONTH_LABELS.map((l, i) => `<option value="${i + 1}" ${i + 1 === M ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      </div>

      <div class="card">
        <div class="card-head" style="flex-wrap:wrap"><div><h2>${Y}년 고정비 히트맵</h2><p class="hint">칸 색 = 예상 대비 차이 · 칸을 누르면 아래에 상세 분석</p></div>
          <div class="legend"><span><span class="sw" style="background:color-mix(in srgb, ${t.accent} 70%, var(--div-mid))"></span>예상보다 적음</span><span><span class="sw" style="background:var(--div-mid)"></span>비슷</span><span><span class="sw" style="background:color-mix(in srgb, ${t.critical} 70%, var(--div-mid))"></span>예상보다 많음</span></div></div>
        <div class="table-wrap"><table class="heat">
          <thead><tr><th>항목</th>${MONTH_LABELS.map((l) => `<th class="r">${l}</th>`).join('')}<th class="r">합계</th></tr></thead>
          <tbody>${grid
            .map(
              (g) => `<tr><th><span class="row" style="gap:6px;flex-wrap:nowrap"><span class="dot" style="background:${esc(g.cat.color)}"></span>${esc(g.cat.name)}</span></th>${g.cells
                .map((c, i) =>
                  c
                    ? `<td class="cell ${g.cat.name === UI.recCat && i + 1 === M ? 'sel' : ''}" data-cat="${esc(g.cat.name)}" data-m="${i + 1}" style="background:${heatBg(c)};color:${heatInk(c)}" title="${esc(A.STATUS_LABEL[c.status])} ${c.diff != null ? pct(c.diff) : ''}">${c.actual ? man(c.actual) : '–'}<span class="s">${c.diff != null && c.status !== 'missing' ? pct(c.diff) : ''}${c.status === 'event' ? ' ✈' : ''}</span></td>`
                    : '<td class="cell muted">·</td>'
                )
                .join('')}<td class="r num">${man(A.sum(g.cells.filter(Boolean).map((c) => c.actual)))}</td></tr>`
            )
            .join('')}</tbody>
        </table></div>
      </div>

      <div class="chips mt">${recCats
        .map((c) => `<button class="chip ${c.name === UI.recCat ? 'on' : ''}" data-chip="${esc(c.name)}"><span class="dot" style="background:${esc(c.color)}"></span>${esc(c.name)}</button>`)
        .join('')}</div>

      <div class="grid grid-3 mt">
        <div class="card span-2">
          <div class="card-head"><div><h2>${esc(UI.recCat)} — 월별 3년 비교</h2><p class="hint">회색 띠 = 이전 2년의 같은 달 최소~최대 범위. 띠 위로 벗어나면 평소보다 높음</p></div></div>
          <div class="chart-box tall"><canvas id="r-chart"></canvas></div>
        </div>
        <div class="card">
          <div class="card-head"><h2>${Y}년 ${M}월 판정</h2>${badge(r.status)}</div>
          <div class="grid" style="grid-template-columns:1fr 1fr;gap:10px;margin:8px 0 12px">
            <div class="stat"><div class="label">실제</div><div class="value num" style="font-size:20px">${won(r.actual)}</div></div>
            <div class="stat"><div class="label">예상${r.trendFactor != null ? ' (추세 보정)' : ''}</div><div class="value num" style="font-size:20px">${r.reference == null ? '–' : won(r.reference)}</div></div>
            <div class="stat"><div class="label">예상 대비</div><div class="value num" style="font-size:20px">${pct(r.diff)}</div></div>
            <div class="stat"><div class="label">계절 지수</div><div class="value num" style="font-size:20px">${r.seasonalIndex == null ? '–' : r.seasonalIndex.toFixed(2) + '×'}</div></div>
          </div>
          <p style="margin:0;color:var(--ink-2)">${esc(A.explain(r))}</p>
          <p class="muted small" style="margin-top:12px">계절 지수: 예년에 이 달이 그 해 월평균의 몇 배였는지. 1.2× 이상이면 원래 지출이 느는 시기(예: 겨울 난방).</p>
        </div>
      </div>

      <div class="card mt">
        <h2>${esc(UI.recCat)} 월별 상세</h2>
        <div class="table-wrap"><table>
          <thead><tr><th>월</th><th class="r">${Y - 2}년</th><th class="r">${Y - 1}년</th><th class="r">${Y}년</th><th class="r">예상</th><th class="r">차이</th><th>판정</th></tr></thead>
          <tbody>${monthRows
            .map((mr, i) => {
              const v = (y) => (series[y][i] ? won(series[y][i]) : '–');
              return `<tr class="click" data-row="${i + 1}"><td>${i + 1}월</td><td class="r">${v(Y - 2)}</td><td class="r">${v(Y - 1)}</td><td class="r"><b>${mr ? v(Y) : ''}</b></td><td class="r">${mr && mr.reference != null ? won(mr.reference) : '–'}</td><td class="r">${mr && mr.diff != null ? pct(mr.diff) : '–'}</td><td>${mr ? badge(mr.status) : ''}</td></tr>`;
            })
            .join('')}</tbody>
          <tfoot><tr><td>합계</td><td class="r">${won(A.sum(series[Y - 2]))}</td><td class="r">${won(A.sum(series[Y - 1]))}</td><td class="r">${won(A.sum(series[Y]))}</td><td></td><td></td><td></td></tr></tfoot>
        </table></div>
      </div>`;

    $('#r-year').onchange = (e) => {
      UI.recYear = Number(e.target.value);
      if (UI.recYear === CUR_Y && UI.recMonth > CUR_M) UI.recMonth = CUR_M;
      rerender();
    };
    $('#r-month').onchange = (e) => {
      UI.recMonth = Number(e.target.value);
      rerender();
    };
    $$('[data-cat]', root).forEach((el) =>
      el.addEventListener('click', () => {
        UI.recCat = el.dataset.cat;
        UI.recMonth = Number(el.dataset.m);
        rerender();
      })
    );
    $$('[data-chip]', root).forEach((el) =>
      el.addEventListener('click', () => {
        UI.recCat = el.dataset.chip;
        rerender();
      })
    );
    $$('[data-row]', root).forEach((el) =>
      el.addEventListener('click', () => {
        if (Y === CUR_Y && Number(el.dataset.row) > CUR_M) return;
        UI.recMonth = Number(el.dataset.row);
        rerender();
      })
    );

    // 차트: 이전 2년 범위 띠 + 3개 연도 라인
    const prevYears = [Y - 1, Y - 2].filter((y) => series[y].some((v) => v > 0));
    const lo = [...Array(12)].map((_, i) => (prevYears.length ? Math.min(...prevYears.map((y) => series[y][i])) : null));
    const hi = [...Array(12)].map((_, i) => (prevYears.length ? Math.max(...prevYears.map((y) => series[y][i])) : null));
    const lines = threeYearLines(t, series, years, { cutCurrent: Y === CUR_Y });
    const statusColor = { alert: t.critical, warn: t.warning, event: t.y[0] };
    lines[0].pointRadius = monthRows.map((mr, i) => (mr && (statusColor[mr.status] || i + 1 === M) ? 6 : 3));
    lines[0].pointBackgroundColor = monthRows.map((mr) => (mr && statusColor[mr.status]) || t.y[0]);
    lines[0].pointStyle = monthRows.map((mr) => (mr && (mr.status === 'alert' || mr.status === 'warn') ? 'triangle' : 'circle'));
    const band = (label, arr, fill) => ({
      label,
      data: arr,
      borderWidth: 0,
      pointRadius: 0,
      pointHoverRadius: 0,
      backgroundColor: color(t.muted, 0.16),
      fill,
      tension: 0.25,
      order: 10,
    });
    const opts = baseOptions(t);
    opts.plugins.legend.labels.filter = (item) => !item.text.startsWith('_');
    opts.plugins.tooltip.filter = (item) => !item.dataset.label.startsWith('_');
    opts.plugins.tooltip.callbacks.footer = (items) => {
      const i = items[0] && items[0].dataIndex;
      const mr = monthRows[i];
      if (!mr || mr.status === 'nodata') return '';
      return `예상 ${won(mr.reference)} · ${pct(mr.diff)} · ${A.STATUS_LABEL[mr.status]}`;
    };
    opts.plugins.tooltip.footerColor = t.ink;
    makeChart($('#r-chart'), {
      type: 'line',
      data: { labels: MONTH_LABELS, datasets: [band('_lo', lo, false), band('_hi', hi, '-1'), ...lines] },
      options: opts,
    });
  };

  function color(hex, alpha) {
    const h = hex.replace('#', '');
    if (h.length !== 6) return hex;
    const n = parseInt(h, 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }

  /* =========================================================
   * 여행·일정
   * ======================================================= */
  function tripTable(rows, { showKind = false } = {}) {
    if (!rows.length) return '<div class="empty">해당하는 일정이 없습니다.</div>';
    const total = A.sum(rows.map((r) => r.summary.total));
    const days = A.sum(rows.map((r) => r.summary.days));
    return `<div class="table-wrap"><table>
      <thead><tr><th>연도</th>${showKind ? '<th>구분</th>' : ''}<th>이름</th><th>목적지</th><th>기간</th><th>일정</th><th class="r">총 지출</th><th class="r">1일 평균</th><th class="r">건수</th></tr></thead>
      <tbody>${rows
        .map(
          ({ event: e, summary: s }) =>
            `<tr class="click" data-ev="${e.id}"><td>${s.year}</td>${showKind ? `<td>${badge(e.kind === 'trip' ? 'trip' : 'plain', e.kind === 'trip' ? '여행' : '일정')}</td>` : ''}<td><b>${esc(e.title)}</b></td><td>${esc(e.destination || '–')}</td><td>${fmtRange(e.startDate, e.endDate)}</td><td>${A.periodLabel(s.days)}</td><td class="r">${won(s.total)}</td><td class="r">${won(s.perDay)}</td><td class="r">${s.count}</td></tr>`
        )
        .join('')}</tbody>
      <tfoot><tr><td colspan="${showKind ? 5 : 4}">합계 ${rows.length}건</td><td>총 ${days}일</td><td class="r">${won(total)}</td><td class="r">${days ? won(total / days) : '–'}</td><td></td></tr></tfoot>
    </table></div>`;
  }

  VIEWS.events = function (root) {
    const all = data().events.map((e) => ({ event: e, summary: A.eventSummary(e, txs()) }));
    const years = [...new Set(all.map((r) => r.summary.year))].sort((a, b) => b - a);
    const rows = all
      .filter((r) => UI.evKind === 'all' || (UI.evKind === 'trip' ? r.event.kind === 'trip' : r.event.kind !== 'trip'))
      .filter((r) => UI.evYear === 'all' || r.summary.year === Number(UI.evYear))
      .sort((a, b) => b.event.startDate.localeCompare(a.event.startDate));
    const trips = all.filter((r) => r.event.kind === 'trip');
    const tripYears = [...new Set(trips.map((r) => r.summary.year))].sort((a, b) => a - b);

    root.innerHTML = `
      <div class="page-head">
        <div><h1>여행·일정</h1><div class="sub">일정에 연결된 지출을 모아 기간·총액·1일 평균을 계산합니다</div></div>
        <div class="row"><button class="btn" id="e-add">+ 일정</button><button class="btn primary" id="e-trip">+ 여행</button></div>
      </div>
      <div class="grid grid-2">
        <div class="card">
          <div class="card-head"><div><h2>연도별 여행 지출</h2><p class="hint">막대 = 그 해 여행 총지출</p></div></div>
          <div class="chart-box short"><canvas id="e-chart"></canvas></div>
        </div>
        <div class="card">
          <h2>여행 요약</h2><p class="hint">전체 기간</p>
          <div class="grid" style="grid-template-columns:1fr 1fr;gap:12px">
            <div class="stat"><div class="label">여행 횟수</div><div class="value num">${trips.length}회</div></div>
            <div class="stat"><div class="label">총 여행일</div><div class="value num">${A.sum(trips.map((r) => r.summary.days))}일</div></div>
            <div class="stat"><div class="label">총 여행 지출</div><div class="value num">${man(A.sum(trips.map((r) => r.summary.total)))}원</div></div>
            <div class="stat"><div class="label">1회 평균</div><div class="value num">${trips.length ? man(A.sum(trips.map((r) => r.summary.total)) / trips.length) + '원' : '–'}</div></div>
          </div>
        </div>
      </div>
      <div class="card mt">
        <div class="card-head" style="flex-wrap:wrap">
          <h2>목록</h2>
          <div class="row">
            <div class="seg" id="e-kind">${[['all', '전체'], ['trip', '여행'], ['event', '일정']].map(([k, l]) => `<button data-k="${k}" class="${UI.evKind === k ? 'on' : ''}">${l}</button>`).join('')}</div>
            <select id="e-year"><option value="all">전체 연도</option>${years.map((y) => `<option value="${y}" ${String(y) === String(UI.evYear) ? 'selected' : ''}>${y}년</option>`).join('')}</select>
          </div>
        </div>
        ${tripTable(rows, { showKind: UI.evKind === 'all' })}
      </div>`;

    $('#e-add').onclick = () => openEventForm({ kind: 'event' });
    $('#e-trip').onclick = () => openEventForm({ kind: 'trip' });
    $$('#e-kind button').forEach((b) =>
      b.addEventListener('click', () => {
        UI.evKind = b.dataset.k;
        rerender();
      })
    );
    $('#e-year').onchange = (e) => {
      UI.evYear = e.target.value;
      rerender();
    };
    bindTxClicks(root);

    const t = theme();
    const opts = baseOptions(t, { datasets: { bar: { categoryPercentage: 0.6 } } });
    opts.plugins.legend.display = false;
    opts.plugins.tooltip.callbacks.label = (ctx) => {
      const y = tripYears[ctx.dataIndex];
      const ts = trips.filter((r) => r.summary.year === y);
      return [` 총 ${won(ctx.parsed.y)} (${ts.length}회)`, ...ts.map((r) => `  · ${r.event.title} ${won(r.summary.total)}`)];
    };
    makeChart($('#e-chart'), {
      type: 'bar',
      data: {
        labels: tripYears.map((y) => `${y}년`),
        datasets: [
          {
            label: '여행 지출',
            data: tripYears.map((y) => A.sum(trips.filter((r) => r.summary.year === y).map((r) => r.summary.total))),
            backgroundColor: t.y[0],
            borderRadius: 4,
            borderSkipped: 'start',
            maxBarThickness: 48,
          },
        ],
      },
      options: opts,
    });
  };

  /* =========================================================
   * 검색
   * ======================================================= */
  VIEWS.search = function (root) {
    const q = UI.query;
    $('#search-input').value = q;
    const res = A.search(data(), q);
    const txSum = A.sum(res.transactions.filter((t) => t.type === 'expense').map((t) => t.amount));
    const nothing = !res.trips.length && !res.events.length && !res.transactions.length;
    root.innerHTML = `
      <div class="page-head"><div><h1>“${esc(q)}” 검색 결과</h1>
        <div class="sub">${res.years.length ? `${res.years.join(', ')}년 · ` : ''}여행 ${res.trips.length}건 · 일정 ${res.events.length}건 · 거래 ${res.transactions.length}건</div></div></div>
      ${nothing ? `<div class="card empty">결과가 없습니다. 예: <a href="#/search?q=여행">여행</a>, <a href="#/search?q=2025 여행">2025 여행</a>, <a href="#/search?q=가스비">가스비</a></div>` : ''}
      ${
        res.trips.length
          ? `<div class="card"><h2>✈ 여행</h2><p class="hint">언제 · 어디로 · 며칠 · 얼마 — 행을 누르면 상세</p>${tripTable(res.trips)}</div>`
          : ''
      }
      ${res.events.length ? `<div class="card mt"><h2>일정</h2>${tripTable(res.events)}</div>` : ''}
      ${
        res.transactions.length
          ? `<div class="card mt"><div class="card-head"><h2>거래 ${res.transactions.length}건</h2><span class="num">지출 합계 <b>${won(txSum)}</b></span></div>
            ${(() => {
              const byYear = A.yearlyTotals(res.transactions, { type: 'expense' });
              const ys = Object.keys(byYear).sort().reverse();
              return ys.length > 1 ? `<div class="row small muted" style="margin-bottom:8px">${ys.map((y) => `<span>${y}년 <b class="num" style="color:var(--ink)">${won(byYear[y])}</b></span>`).join('<span>·</span>')}</div>` : '';
            })()}
            ${txListGrouped(res.transactions.slice(0, 300))}${res.transactions.length > 300 ? '<p class="muted small">최근 300건만 표시</p>' : ''}</div>`
          : ''
      }`;
    bindTxClicks(root);
    // 월 단위로 묶인 날짜 헤더에 연·월이 보이도록
    $$('.tx-day-head span:first-child', root).forEach((el, i) => {
      const d = $$('.tx-day', root)[i].querySelector('[data-tx]');
      const t = d && txs().find((x) => x.id === d.dataset.tx);
      if (t) el.textContent = `${fmtDate(t.date)} (${weekday(t.date)})`;
    });
  };

  /* =========================================================
   * 데이터 관리
   * ======================================================= */
  VIEWS.data = function (root) {
    const d = data();
    const s = d.settings;
    const counts = new Map();
    d.transactions.forEach((t) => counts.set(t.category, (counts.get(t.category) || 0) + 1));
    root.innerHTML = `
      <div class="page-head"><div><h1>데이터</h1><div class="sub">거래 ${d.transactions.length.toLocaleString()}건 · 일정 ${d.events.length}건 · ${
        Auth.user ? `${esc(Auth.user.email)} 계정에 동기화` : '이 브라우저(localStorage)에 저장됨'
      }</div></div></div>
      ${accountCard()}
      <div class="grid grid-2">
        <div class="card">
          <h2>CSV 가져오기</h2>
          <p class="hint">은행·카드 내역을 아래 열 이름으로 맞춰 저장한 CSV (UTF-8). 필수: 날짜, 금액</p>
          <pre class="small" style="background:var(--surface-2);padding:10px;border-radius:8px;overflow-x:auto;margin:0 0 10px">날짜,구분,금액,카테고리,메모,태그,일정
2025-01-20,지출,182000,가스비,도시가스 요금,,
2025-07-21,지출,96000,교통,간사이 스루패스,해외,오사카 여행
2025-01-25,수입,4350000,급여,월급,,</pre>
          <p class="muted small">구분이 없으면 지출로, 금액이 음수여도 지출로 처리합니다. 없는 카테고리는 자동 추가됩니다. "일정" 열에 기존 일정 이름을 쓰면 자동 연결됩니다.</p>
          <div class="row"><input type="file" id="csv-file" accept=".csv,text/csv" /><button class="btn" id="csv-export">CSV 내보내기</button></div>
        </div>
        <div class="card">
          <h2>백업 · 초기화</h2>
          <p class="hint">JSON 백업에는 거래·일정·카테고리·설정이 모두 들어갑니다</p>
          <div class="row"><button class="btn" id="json-export">JSON 백업 저장</button><label class="btn">JSON 복원<input type="file" id="json-file" accept=".json,application/json" hidden /></label></div>
          <div class="row mt"><button class="btn" id="sample">샘플 데이터 불러오기</button><button class="btn danger" id="reset">모든 데이터 삭제</button></div>
          <h2 style="margin-top:20px">이상 감지 기준</h2>
          <p class="hint">예상치(같은 달 예년 평균, 추세 보정) 대비 초과 비율</p>
          <div class="row">
            <label class="small">주의 <input type="number" id="set-warn" min="1" max="200" value="${Math.round(s.warn * 100)}" style="width:70px" />%</label>
            <label class="small">경고 <input type="number" id="set-alert" min="1" max="300" value="${Math.round(s.alert * 100)}" style="width:70px" />%</label>
            <label class="small">비교 연도 <select id="set-lookback">${[1, 2, 3].map((n) => `<option ${n === s.lookback ? 'selected' : ''} value="${n}">${n}년</option>`).join('')}</select></label>
          </div>
        </div>
      </div>
      <div class="card mt">
        <div class="card-head" style="flex-wrap:wrap"><div><h2>카테고리</h2><p class="hint">“고정비”로 체크한 항목이 고정비 분석·이상 감지 대상입니다</p></div>
          <div class="row"><input type="text" id="cat-name" placeholder="새 카테고리" style="width:140px" /><select id="cat-type"><option value="expense">지출</option><option value="income">수입</option></select><button class="btn" id="cat-add">추가</button></div></div>
        <div class="table-wrap"><table>
          <thead><tr><th>색</th><th>이름</th><th>구분</th><th>고정비</th><th class="r">거래 수</th><th></th></tr></thead>
          <tbody>${d.categories
            .map(
              (c, i) => `<tr><td><input type="color" value="${esc(c.color)}" data-color="${i}" style="width:32px;height:24px;border:0;background:none;padding:0" /></td>
              <td>${esc(c.name)}</td><td>${c.type === 'income' ? '수입' : '지출'}</td>
              <td>${c.type === 'expense' ? `<input type="checkbox" data-rec="${i}" ${c.recurring ? 'checked' : ''} aria-label="${esc(c.name)} 고정비" />` : ''}</td>
              <td class="r">${counts.get(c.name) || 0}</td>
              <td class="r">${counts.get(c.name) ? '' : `<button class="btn small danger" data-del="${i}">삭제</button>`}</td></tr>`
            )
            .join('')}</tbody>
        </table></div>
      </div>`;

    bindAccountCard(root);
    $('#csv-file').onchange = async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      const text = await f.text();
      const res = Store.importCSV(text);
      alert(`${res.transactions.length}건 가져옴${res.newCategories.length ? `, 새 카테고리 ${res.newCategories.length}개` : ''}${res.errors.length ? `\n\n건너뜀 ${res.errors.length}건:\n${res.errors.slice(0, 10).join('\n')}` : ''}`);
      rerender();
    };
    $('#csv-export').onclick = () => download(`가계부_${TODAY}.csv`, Store.exportCSV(), 'text/csv;charset=utf-8');
    $('#json-export').onclick = () => download(`가계부_백업_${TODAY}.json`, Store.exportJSON(), 'application/json');
    $('#json-file').onchange = async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      if (!confirm(`현재 데이터를 백업 파일 내용으로 바꿉니다.${Auth.user ? ' 계정의 다른 기기에도 반영됩니다.' : ''} 계속할까요?`)) return;
      try {
        Store.importJSON(await f.text());
        toast('복원했습니다.');
        rerender();
      } catch (err) {
        alert(err.message);
      }
    };
    $('#sample').onclick = () => {
      if (!isEmpty() && !confirm('현재 데이터를 지우고 샘플 데이터로 바꿉니다. 계속할까요?')) return;
      Store.replace(Sample.generate(today));
      toast('샘플 데이터를 불러왔습니다.');
      rerender();
    };
    $('#reset').onclick = () => {
      const where = Auth.user ? ' 계정에 저장된 데이터와 다른 기기의 데이터도 함께 삭제됩니다.' : '';
      if (!confirm(`모든 거래·일정을 삭제합니다.${where} 먼저 백업을 권장합니다. 삭제할까요?`)) return;
      Store.reset();
      toast('초기화했습니다.');
      go('dashboard');
    };
    const saveSettings = () => {
      const w = Number($('#set-warn').value) / 100;
      const a = Number($('#set-alert').value) / 100;
      if (!(w > 0) || !(a > w)) return toast('경고 기준은 주의 기준보다 커야 합니다.');
      Store.updateSettings({ warn: w, alert: a, lookback: Number($('#set-lookback').value) });
      toast('기준을 저장했습니다.');
    };
    ['#set-warn', '#set-alert', '#set-lookback'].forEach((sel) => ($(sel).onchange = saveSettings));
    $('#cat-add').onclick = () => {
      const name = $('#cat-name').value.trim();
      if (!name) return;
      if (!Store.addCategory({ name, type: $('#cat-type').value })) return toast('이미 있는 이름입니다.');
      rerender();
    };
    $$('[data-rec]').forEach((el) => (el.onchange = () => Store.updateCategory(d.categories[el.dataset.rec].name, { recurring: el.checked })));
    $$('[data-color]').forEach((el) => (el.onchange = () => Store.updateCategory(d.categories[el.dataset.color].name, { color: el.value })));
    $$('[data-del]').forEach(
      (el) =>
        (el.onclick = () => {
          Store.removeCategory(d.categories[el.dataset.del].name);
          rerender();
        })
    );
  };

  /* =========================================================
   * 모달 / 폼
   * ======================================================= */
  function openModal(html, { wide = false } = {}) {
    const root = $('#modal-root');
    root.innerHTML = `<div class="modal-bg"><div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">${html}</div></div>`;
    const bg = $('.modal-bg', root);
    bg.addEventListener('mousedown', (e) => {
      if (e.target === bg) closeModal();
    });
    const first = $('input, select, textarea', root);
    if (first) setTimeout(() => first.focus(), 30);
    return $('.modal', root);
  }
  function closeModal() {
    $('#modal-root').innerHTML = '';
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
  });

  function openTxForm(tx = {}) {
    const isEdit = !!tx.id;
    const t = { date: TODAY, type: 'expense', amount: '', category: '', memo: '', tags: [], eventId: null, ...tx };
    if (!t.category) t.category = t.type === 'income' ? '급여' : Store.category('식비') ? '식비' : '';
    const catOptions = (type, cur) =>
      data()
        .categories.filter((c) => c.type === type)
        .map((c) => `<option ${c.name === cur ? 'selected' : ''}>${esc(c.name)}</option>`)
        .join('') + '<option value="__new">+ 새 카테고리…</option>';
    const eventOptions = (date, cur) => {
      const on = Store.eventsOn(date);
      const others = data()
        .events.filter((e) => !on.includes(e))
        .sort((a, b) => b.startDate.localeCompare(a.startDate));
      const opt = (e) => `<option value="${e.id}" ${e.id === cur ? 'selected' : ''}>${e.kind === 'trip' ? '✈ ' : ''}${esc(e.title)} (${fmtRange(e.startDate, e.endDate)})</option>`;
      return `<option value="">연결 안 함</option>${on.length ? `<optgroup label="이 날짜의 일정">${on.map(opt).join('')}</optgroup>` : ''}${others.length ? `<optgroup label="다른 일정">${others.map(opt).join('')}</optgroup>` : ''}`;
    };
    const m = openModal(`
      <h2>${isEdit ? '거래 수정' : '거래 추가'}</h2>
      <form class="form" id="tx-form">
        <div class="seg" id="tx-type"><button type="button" data-t="expense" class="${t.type === 'expense' ? 'on' : ''}">지출</button><button type="button" data-t="income" class="${t.type === 'income' ? 'on' : ''}">수입</button></div>
        <div class="two">
          <label>날짜<input type="date" name="date" value="${esc(t.date)}" required /></label>
          <label>금액(원)<input type="text" inputmode="numeric" name="amount" value="${t.amount ? Number(t.amount).toLocaleString('ko-KR') : ''}" placeholder="0" required /></label>
        </div>
        <div class="two">
          <label>카테고리<select name="category">${catOptions(t.type, t.category)}</select></label>
          <label>여행·일정 연결<select name="eventId">${eventOptions(t.date, t.eventId)}</select></label>
        </div>
        <label>메모<input type="text" name="memo" value="${esc(t.memo)}" placeholder="사용처, 내용" /></label>
        <label>태그 (쉼표로 구분)<input type="text" name="tags" value="${esc((t.tags || []).join(', '))}" /></label>
        <div class="modal-foot">
          <div>${isEdit ? '<button type="button" class="btn danger" id="tx-del">삭제</button>' : ''}</div>
          <div class="row"><button type="button" class="btn" id="tx-cancel">취소</button><button type="submit" class="btn primary">저장</button></div>
        </div>
      </form>`);
    let type = t.type;
    const form = $('#tx-form', m);
    $$('#tx-type button', m).forEach((b) =>
      b.addEventListener('click', () => {
        type = b.dataset.t;
        $$('#tx-type button', m).forEach((x) => x.classList.toggle('on', x === b));
        form.category.innerHTML = catOptions(type, type === 'income' ? '급여' : '식비');
      })
    );
    form.amount.addEventListener('input', () => {
      const digits = form.amount.value.replace(/[^\d]/g, '');
      form.amount.value = digits ? Number(digits).toLocaleString('ko-KR') : '';
    });
    form.date.addEventListener('change', () => {
      const cur = form.eventId.value;
      form.eventId.innerHTML = eventOptions(form.date.value, cur);
      if (!cur) {
        const on = Store.eventsOn(form.date.value);
        if (on.length === 1 && on[0].kind === 'trip') form.eventId.value = on[0].id;
      }
    });
    form.category.addEventListener('change', () => {
      if (form.category.value !== '__new') return;
      const name = (prompt('새 카테고리 이름') || '').trim();
      if (!name) {
        form.category.selectedIndex = 0;
        return;
      }
      Store.ensureCategory(name, type);
      form.category.innerHTML = catOptions(type, name);
    });
    $('#tx-cancel', m).onclick = closeModal;
    if (isEdit)
      $('#tx-del', m).onclick = () => {
        if (!confirm('이 거래를 삭제할까요?')) return;
        Store.deleteTransaction(t.id);
        closeModal();
        rerender();
      };
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const amount = Number(form.amount.value.replace(/[^\d]/g, ''));
      if (!amount) return toast('금액을 입력하세요.');
      if (form.category.value === '__new') return toast('카테고리를 선택하세요.');
      Store.upsertTransaction({
        id: t.id,
        date: form.date.value,
        type,
        amount,
        category: form.category.value,
        memo: form.memo.value.trim(),
        tags: form.tags.value.split(',').map((s) => s.trim()).filter(Boolean),
        eventId: form.eventId.value || null,
      });
      closeModal();
      toast(isEdit ? '수정했습니다.' : '추가했습니다.');
      rerender();
    });
  }

  function openEventForm(ev = {}) {
    const isEdit = !!ev.id;
    const e = { kind: 'trip', title: '', destination: '', startDate: TODAY, endDate: '', memo: '', tags: [], ...ev };
    const m = openModal(`
      <h2>${isEdit ? '일정 수정' : e.kind === 'trip' ? '여행 추가' : '일정 추가'}</h2>
      <form class="form" id="ev-form">
        <div class="seg" id="ev-kind"><button type="button" data-k="trip" class="${e.kind === 'trip' ? 'on' : ''}">✈ 여행</button><button type="button" data-k="event" class="${e.kind !== 'trip' ? 'on' : ''}">일반 일정</button></div>
        <label>이름<input type="text" name="title" value="${esc(e.title)}" placeholder="예: 오사카 가족여행" required /></label>
        <label id="dest-wrap">목적지<input type="text" name="destination" value="${esc(e.destination)}" placeholder="예: 일본 오사카" /></label>
        <div class="two">
          <label>시작일<input type="date" name="startDate" value="${esc(e.startDate)}" required /></label>
          <label>종료일<input type="date" name="endDate" value="${esc(e.endDate || '')}" /></label>
        </div>
        <label>메모<input type="text" name="memo" value="${esc(e.memo)}" /></label>
        <label>태그 (쉼표로 구분)<input type="text" name="tags" value="${esc((e.tags || []).join(', '))}" placeholder="해외, 가족" /></label>
        <label class="row" style="display:flex"><input type="checkbox" name="autolink" ${isEdit ? '' : 'checked'} /> 기간 중 지출을 이 일정에 자동 연결 (고정비 제외, 주유비 포함)</label>
        <div class="modal-foot">
          <div>${isEdit ? '<button type="button" class="btn danger" id="ev-del">삭제</button>' : ''}</div>
          <div class="row"><button type="button" class="btn" id="ev-cancel">취소</button><button type="submit" class="btn primary">저장</button></div>
        </div>
      </form>`);
    let kind = e.kind;
    const form = $('#ev-form', m);
    const syncKind = () => ($('#dest-wrap', m).style.display = kind === 'trip' ? '' : 'none');
    syncKind();
    $$('#ev-kind button', m).forEach((b) =>
      b.addEventListener('click', () => {
        kind = b.dataset.k;
        $$('#ev-kind button', m).forEach((x) => x.classList.toggle('on', x === b));
        syncKind();
      })
    );
    $('#ev-cancel', m).onclick = closeModal;
    if (isEdit)
      $('#ev-del', m).onclick = () => {
        if (!confirm('일정을 삭제할까요? (연결된 거래는 삭제되지 않고 연결만 해제됩니다)')) return;
        Store.deleteEvent(e.id);
        closeModal();
        rerender();
      };
    form.addEventListener('submit', (evt) => {
      evt.preventDefault();
      const startDate = form.startDate.value;
      let endDate = form.endDate.value || startDate;
      if (endDate < startDate) return toast('종료일이 시작일보다 빠릅니다.');
      const id = Store.upsertEvent({
        id: e.id,
        kind,
        title: form.title.value.trim(),
        destination: kind === 'trip' ? form.destination.value.trim() : '',
        startDate,
        endDate,
        memo: form.memo.value.trim(),
        tags: form.tags.value.split(',').map((s) => s.trim()).filter(Boolean),
      });
      let linked = 0;
      if (form.autolink.checked) linked = Store.linkTransactionsInRange(id);
      closeModal();
      toast(`저장했습니다${linked ? ` · 거래 ${linked}건 연결` : ''}.`);
      rerender();
    });
  }

  function openEventDetail(id) {
    const e = Store.event(id);
    if (!e) return;
    const s = A.eventSummary(e, txs());
    const m = openModal(
      `
      <div class="card-head"><div><h2 style="margin:0">${e.kind === 'trip' ? '✈ ' : ''}${esc(e.title)}</h2>
        <div class="muted">${e.destination ? esc(e.destination) + ' · ' : ''}${fmtRange(e.startDate, e.endDate)} · ${A.periodLabel(s.days)}</div></div>
        <button class="icon-btn" id="ed-close" aria-label="닫기">✕</button></div>
      <div class="grid grid-3" style="margin:12px 0">
        <div class="stat"><div class="label">총 지출</div><div class="value num">${won(s.total)}</div></div>
        <div class="stat"><div class="label">1일 평균</div><div class="value num">${won(s.perDay)}</div></div>
        <div class="stat"><div class="label">거래</div><div class="value num">${s.count}건</div></div>
      </div>
      ${e.memo ? `<p class="muted">${esc(e.memo)}</p>` : ''}
      ${s.byCategory.length ? `<h2 style="font-size:14px">항목별</h2>${barList(s.byCategory, s.total)}` : ''}
      <h2 style="font-size:14px;margin-top:16px">연결된 거래</h2>
      <div id="ed-list">${s.transactions.length ? s.transactions.map(txRow).join('') : '<div class="empty">연결된 거래가 없습니다. “기간 내 지출 연결”을 눌러보세요.</div>'}</div>
      <div class="modal-foot" style="flex-wrap:wrap">
        <div class="row"><button class="btn danger" id="ed-del">삭제</button><button class="btn" id="ed-edit">수정</button></div>
        <div class="row"><button class="btn" id="ed-link">기간 내 지출 연결</button><button class="btn primary" id="ed-add">+ 거래</button></div>
      </div>`,
      { wide: true }
    );
    $('#ed-close', m).onclick = closeModal;
    $('#ed-edit', m).onclick = () => openEventForm(e);
    $('#ed-add', m).onclick = () => openTxForm({ date: e.startDate <= TODAY && TODAY <= e.endDate ? TODAY : e.startDate, eventId: e.id });
    $('#ed-link', m).onclick = () => {
      const n = Store.linkTransactionsInRange(e.id);
      toast(n ? `거래 ${n}건을 연결했습니다.` : '새로 연결할 거래가 없습니다.');
      rerender();
      openEventDetail(e.id);
    };
    $('#ed-del', m).onclick = () => {
      if (!confirm('일정을 삭제할까요? (연결된 거래는 남고 연결만 해제됩니다)')) return;
      Store.deleteEvent(e.id);
      closeModal();
      rerender();
    };
    $$('[data-tx]', m).forEach((el) => el.addEventListener('click', () => openTxForm(txs().find((t) => t.id === el.dataset.tx))));
  }

  /* =========================================================
   * 로그인 · 동기화
   * ======================================================= */
  const CONFIG = window.GAGYEBU_CONFIG || {};
  const STATUS_TEXT = {
    guest: '로그인 안 됨',
    pending: '저장 대기',
    syncing: '동기화 중…',
    synced: '동기화됨',
    offline: '오프라인 · 연결되면 저장',
    error: '오류',
  };
  const Auth = {
    enabled: !!(CONFIG.supabaseUrl && CONFIG.supabaseAnonKey && window.supabase && window.Sync),
    sync: null,
    get user() {
      return this.sync ? this.sync.user : null;
    },
    get status() {
      return this.sync ? this.sync.status : 'guest';
    },
  };

  function accountButton() {
    const btn = $('#account-btn');
    if (!btn) return;
    btn.hidden = !Auth.enabled;
    if (!Auth.enabled) return;
    const u = Auth.user;
    const st = Auth.status;
    btn.className = `btn small account-btn ${u ? 'in' : ''}`;
    btn.innerHTML = u
      ? `<span class="sync-dot ${st}" aria-hidden="true"></span><span class="acct-name">${esc(u.email.split('@')[0])}</span>`
      : '로그인';
    btn.title = u ? `${u.email} · ${STATUS_TEXT[st] || st}` : '로그인하고 여러 기기에서 동기화';
    btn.setAttribute('aria-label', btn.title);
  }

  function accountCard() {
    if (!Auth.enabled) {
      return `<div class="card" style="margin-bottom:16px"><h2>계정</h2><p class="hint" style="margin:0">로그인 기능이 설정되지 않아 이 브라우저에만 저장합니다. 설정 방법은 README의 “로그인·동기화 설정”을 참고하세요.</p></div>`;
    }
    const u = Auth.user;
    if (!u) {
      return `<div class="card" style="margin-bottom:16px"><div class="card-head" style="flex-wrap:wrap;margin:0"><div><h2>계정</h2><p class="hint" style="margin:0">로그인하지 않아 이 브라우저에만 저장 중입니다. 로그인하면 여러 기기에서 같은 데이터를 쓸 수 있습니다.</p></div><button class="btn primary" id="acct-login">로그인 / 회원가입</button></div></div>`;
    }
    return `<div class="card" style="margin-bottom:16px"><div class="card-head" style="flex-wrap:wrap;margin:0">
      <div><h2>계정 · ${esc(u.email)}</h2>
        <p class="hint" style="margin:0" id="acct-status">${acctStatusHtml()}</p></div>
      <div class="row"><button class="btn" id="acct-sync">지금 동기화</button><button class="btn" id="acct-logout">로그아웃</button></div>
    </div></div>`;
  }
  function acctStatusHtml() {
    const st = Auth.status;
    const last = Auth.sync && Auth.sync.lastSynced;
    const err = Auth.sync && Auth.sync.lastError;
    return `<span class="sync-dot ${st}"></span> ${esc(STATUS_TEXT[st] || st)}${last ? ` · 마지막 동기화 ${last.toLocaleTimeString('ko-KR')}` : ''}${err && st !== 'synced' ? ` · ${esc(err)}` : ''}`;
  }
  function bindAccountCard(root) {
    const l = $('#acct-login', root);
    if (l) l.onclick = () => openLoginModal();
    const sy = $('#acct-sync', root);
    if (sy) sy.onclick = () => Auth.sync.pull().then(() => toast(STATUS_TEXT[Auth.status] || Auth.status));
    const lo = $('#acct-logout', root);
    if (lo) lo.onclick = () => doLogout();
  }

  async function doLogout() {
    const ok = await Auth.sync.signOut();
    if (!ok) return;
    closeModal();
    toast('로그아웃했습니다. 이 브라우저에서 계정 데이터를 지웠습니다.');
    go('dashboard');
    rerender();
  }

  function openAccountModal() {
    const u = Auth.user;
    const m = openModal(`
      <div class="card-head"><h2 style="margin:0">계정</h2><button class="icon-btn" id="am-close" aria-label="닫기">✕</button></div>
      <p style="margin:4px 0 2px"><b>${esc(u.email)}</b></p>
      <p class="muted small" style="margin:0 0 14px"><span class="sync-dot ${Auth.status}"></span> ${esc(STATUS_TEXT[Auth.status] || Auth.status)}${Auth.sync.lastError ? ` · ${esc(Auth.sync.lastError)}` : ''}</p>
      <p class="muted small">거래 ${data().transactions.length.toLocaleString()}건 · 일정 ${data().events.length}건이 이 계정에 저장되어 있습니다. 다른 기기에서 같은 이메일로 로그인하면 같은 데이터가 보입니다.</p>
      <div class="modal-foot"><button class="btn" id="am-sync">지금 동기화</button><button class="btn primary" id="am-logout">로그아웃</button></div>`);
    $('#am-close', m).onclick = closeModal;
    $('#am-sync', m).onclick = async () => {
      await Auth.sync.pull();
      closeModal();
      toast(STATUS_TEXT[Auth.status] || Auth.status);
    };
    $('#am-logout', m).onclick = () => doLogout();
  }

  function openLoginModal(mode = 'login') {
    let tab = mode;
    const m = openModal(`
      <div class="card-head"><h2 style="margin:0">로그인</h2><button class="icon-btn" id="lg-close" aria-label="닫기">✕</button></div>
      <p class="muted small" style="margin:4px 0 14px">로그인하면 가계부가 계정에 저장되어 휴대폰·PC 어디서나 같은 데이터를 볼 수 있습니다. 다른 사용자는 내 데이터를 볼 수 없습니다.</p>
      <div class="seg" id="lg-tab" style="margin-bottom:12px"><button type="button" data-t="login">로그인</button><button type="button" data-t="signup">회원가입</button><button type="button" data-t="link">이메일 링크</button></div>
      <form class="form" id="lg-form">
        <label>이메일<input type="email" name="email" autocomplete="email" required /></label>
        <label id="lg-pw-wrap">비밀번호<input type="password" name="password" minlength="6" autocomplete="current-password" /></label>
        <p class="small muted" id="lg-help" style="margin:0"></p>
        <p class="small" id="lg-msg" role="status" style="margin:0"></p>
        <div class="modal-foot"><span></span><button type="submit" class="btn primary" id="lg-submit">로그인</button></div>
      </form>`);
    const form = $('#lg-form', m);
    const msg = $('#lg-msg', m);
    const sync = () => {
      $$('#lg-tab button', m).forEach((b) => b.classList.toggle('on', b.dataset.t === tab));
      $('#lg-pw-wrap', m).style.display = tab === 'link' ? 'none' : '';
      form.password.required = tab !== 'link';
      form.password.autocomplete = tab === 'signup' ? 'new-password' : 'current-password';
      $('#lg-submit', m).textContent = { login: '로그인', signup: '가입하기', link: '로그인 링크 받기' }[tab];
      $('#lg-help', m).textContent = {
        login: '',
        signup: '비밀번호는 6자 이상. 가입 후 인증 메일이 오면 링크를 눌러 완료하세요.',
        link: '비밀번호 없이, 이메일로 받은 링크를 눌러 로그인합니다. 비밀번호를 잊었을 때도 쓸 수 있습니다.',
      }[tab];
      msg.textContent = '';
    };
    sync();
    $$('#lg-tab button', m).forEach((b) =>
      b.addEventListener('click', () => {
        tab = b.dataset.t;
        sync();
      })
    );
    $('#lg-close', m).onclick = closeModal;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = form.email.value.trim();
      const password = form.password.value;
      const btn = $('#lg-submit', m);
      btn.disabled = true;
      msg.style.color = 'var(--ink-2)';
      msg.textContent = '처리 중…';
      try {
        if (tab === 'login') {
          await Auth.sync.signIn(email, password);
          closeModal();
          toast('로그인했습니다.');
        } else if (tab === 'signup') {
          const r = await Auth.sync.signUp(email, password);
          if (r.needsConfirm) {
            msg.style.color = 'var(--good-ink)';
            msg.textContent = `${email}로 인증 메일을 보냈습니다. 메일의 링크를 누르면 가입이 완료되고 자동으로 로그인됩니다.`;
          } else {
            closeModal();
            toast('가입하고 로그인했습니다.');
          }
        } else {
          await Auth.sync.sendMagicLink(email);
          msg.style.color = 'var(--good-ink)';
          msg.textContent = `${email}로 로그인 링크를 보냈습니다. 이 기기에서 메일의 링크를 눌러 주세요.`;
        }
      } catch (err) {
        msg.style.color = 'var(--critical)';
        msg.textContent = err.message;
      } finally {
        btn.disabled = false;
      }
    });
  }

  function startAuth() {
    accountButton();
    if (!Auth.enabled) return;
    const client = window.supabase.createClient(CONFIG.supabaseUrl, CONFIG.supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit' },
    });
    Auth.sync = window.Sync.createSync({
      client,
      store: Store,
      hooks: {
        onStatus: () => {
          accountButton();
          const el = $('#acct-status');
          if (el) el.innerHTML = acctStatusHtml();
        },
        onUser: () => accountButton(),
        onRemoteData: debounce(() => {
          if (!$('.modal-bg')) rerender();
        }, 50),
        confirm: (message) => Promise.resolve(window.confirm(message)),
      },
    });
    $('#account-btn').addEventListener('click', () => (Auth.user ? openAccountModal() : openLoginModal()));
    Auth.sync.start().catch((e) => console.warn('로그인 초기화 실패', e));
    // 다른 기기에서 바꾼 내용 가져오기
    const pull = debounce(() => Auth.sync.pull(), 300);
    window.addEventListener('focus', pull);
    window.addEventListener('online', pull);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') pull();
      else Auth.sync.flush();
    });
    window.addEventListener('beforeunload', (e) => {
      if (Auth.sync.dirty) {
        Auth.sync.flush();
        e.preventDefault();
        e.returnValue = '';
      }
    });
  }

  /* =========================================================
   * 시작
   * ======================================================= */
  Store.load();
  startAuth();
  $('#search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = $('#search-input').value.trim();
    if (q) go('search', { q });
  });
  $('#theme-btn').addEventListener('click', () => {
    const rootEl = document.documentElement;
    const dark = rootEl.dataset.theme ? rootEl.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    rootEl.dataset.theme = dark ? 'light' : 'dark';
    try {
      localStorage.setItem('gagyebu-theme', rootEl.dataset.theme);
    } catch (err) {
      /* 무시 */
    }
    rerender();
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => rerender());
  window.addEventListener('hashchange', render);
  render();
})();
