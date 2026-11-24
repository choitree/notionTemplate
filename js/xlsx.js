/*
 * 엑셀 파일 읽기 (가벼운 자체 구현)
 *  - .xlsx: zip(fflate로 해제) 안의 XML을 읽어 첫 번째 시트를 행 배열로 변환
 *    날짜 서식 셀은 'YYYY-MM-DD'로, 숫자는 문자열 숫자로, 공유 문자열·서식 있는 문자열 지원
 *  - HTML 표를 .xls 확장자로 내려주는 사이트(일부 카드사·은행)도 지원
 *  - 옛 바이너리 .xls(Excel 97-2003)는 지원하지 않음 → 안내 메시지
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./vendor/fflate.js'));
  else root.Xlsx = factory(root.fflate);
})(typeof self !== 'undefined' ? self : this, function (fflate) {
  'use strict';

  const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  const unescape = (s) =>
    String(s).replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
      if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
      return ENT[e.toLowerCase()] ?? m;
    });
  const utf8 = (bytes) => new TextDecoder('utf-8').decode(bytes);

  /** 파일 종류 판별 */
  function sniff(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (b[0] === 0x50 && b[1] === 0x4b) return 'xlsx'; // PK (zip)
    if (b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) return 'xls-binary'; // OLE2
    const head = new TextDecoder('utf-8').decode(b.slice(0, 2048)).toLowerCase();
    if (/<table|<html|<\?xml[\s\S]*urn:schemas-microsoft-com:office:spreadsheet/.test(head)) return 'html';
    return 'text';
  }

  /* ---------- .xlsx ---------- */
  const colIndex = (ref) => {
    const letters = String(ref).match(/^[A-Z]+/i);
    if (!letters) return -1;
    let n = 0;
    for (const ch of letters[0].toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  };
  const attr = (s, name) => {
    const m = s.match(new RegExp(`\\b${name}="([^"]*)"`));
    return m ? m[1] : null;
  };
  // <t> 안의 글자만 모음 (서식 있는 문자열의 여러 조각 포함, 발음 표기 <rPh>는 제외)
  const textOf = (xml) =>
    unescape(
      xml
        .replace(/<(?:\w+:)?rPh\b[\s\S]*?<\/(?:\w+:)?rPh>/g, '')
        .match(/<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g)
        ?.map((t) => t.replace(/<[^>]+>/g, ''))
        .join('') || ''
    );

  const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);
  function isDateFormat(code) {
    // 따옴표·대괄호 안(색상, 통화 기호)과 이스케이프 문자를 빼고 y/d 또는 m+(시간 아님)이 있으면 날짜
    const c = String(code).replace(/"[^"]*"|\[[^\]]*\]|\\./g, '');
    return /[yd]/i.test(c) || (/m/i.test(c) && !/h|s/i.test(c));
  }

  function serialToDate(serial, date1904) {
    const ms = Math.round((serial + (date1904 ? 1462 : 0)) * 86400000) + Date.UTC(1899, 11, 30);
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }

  function readXlsx(bytes) {
    let files;
    try {
      files = fflate.unzipSync(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    } catch (e) {
      throw new Error('엑셀 파일을 열 수 없습니다 (손상되었거나 암호가 걸린 파일일 수 있습니다).');
    }
    const get = (p) => (files[p] ? utf8(files[p]) : null);
    const workbook = get('xl/workbook.xml');
    if (!workbook) throw new Error('엑셀(.xlsx) 파일 구조가 아닙니다.');
    const date1904 = /date1904="(1|true)"/.test(workbook);

    // 첫 번째 시트 경로
    const sheetTags = workbook.match(/<(?:\w+:)?sheet\b[^>]*\/?>/g) || [];
    let sheetPath = 'xl/worksheets/sheet1.xml';
    const rels = get('xl/_rels/workbook.xml.rels');
    if (sheetTags.length && rels) {
      const rid = attr(sheetTags[0], 'r:id');
      const rel = (rels.match(/<Relationship\b[^>]*\/?>/g) || []).find((r) => attr(r, 'Id') === rid);
      if (rel) {
        const target = attr(rel, 'Target');
        sheetPath = target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '');
      }
    }
    const sheet = get(sheetPath) || get(Object.keys(files).find((k) => /^xl\/worksheets\/[^/]+\.xml$/.test(k)) || '');
    if (!sheet) throw new Error('엑셀 파일에서 시트를 찾지 못했습니다.');

    // 공유 문자열
    const sstXml = get('xl/sharedStrings.xml') || '';
    const sst = (sstXml.match(/<(?:\w+:)?si\b[\s\S]*?<\/(?:\w+:)?si>/g) || []).map(textOf);

    // 날짜 서식
    const stylesXml = get('xl/styles.xml') || '';
    const custom = new Map();
    for (const m of stylesXml.match(/<(?:\w+:)?numFmt\b[^>]*\/?>/g) || []) custom.set(Number(attr(m, 'numFmtId')), unescape(attr(m, 'formatCode') || ''));
    const xfsBlock = (stylesXml.match(/<(?:\w+:)?cellXfs\b[\s\S]*?<\/(?:\w+:)?cellXfs>/) || [''])[0];
    const dateStyle = (xfsBlock.match(/<(?:\w+:)?xf\b[^>]*\/?>/g) || []).map((xf) => {
      const id = Number(attr(xf, 'numFmtId') || 0);
      return BUILTIN_DATE_FORMATS.has(id) || (custom.has(id) && isDateFormat(custom.get(id)));
    });

    const rows = [];
    const rowRe = /<(?:\w+:)?row\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?row>/g;
    const cellRe = /<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g;
    let rm;
    let lastRow = 0;
    while ((rm = rowRe.exec(sheet))) {
      const rNum = Number(attr(rm[1], 'r')) || lastRow + 1;
      while (lastRow < rNum - 1) {
        rows.push([]); // 빈 행 유지 (행 번호 맞추기)
        lastRow++;
      }
      lastRow = rNum;
      const row = [];
      let cm;
      let lastCol = -1;
      while ((cm = cellRe.exec(rm[2]))) {
        const a = cm[1];
        const inner = cm[2] || '';
        const ref = attr(a, 'r');
        const ci = ref ? colIndex(ref) : lastCol + 1;
        lastCol = ci;
        const t = attr(a, 't') || 'n';
        const s = Number(attr(a, 's') || 0);
        const v = (inner.match(/<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/) || [])[1];
        let val = '';
        if (t === 's') val = sst[Number(v)] ?? '';
        else if (t === 'inlineStr') val = textOf(inner);
        else if (t === 'str' || t === 'e') val = unescape(v ?? '');
        else if (t === 'b') val = v === '1' ? 'TRUE' : 'FALSE';
        else if (t === 'd') val = String(v || '').slice(0, 10);
        else if (v != null && v !== '') {
          const num = Number(v);
          val = dateStyle[s] && isFinite(num) ? serialToDate(num, date1904) : String(num);
        }
        row[ci] = val;
      }
      for (let i = 0; i < row.length; i++) if (row[i] == null) row[i] = '';
      rows.push(row);
    }
    return rows;
  }

  /* ---------- HTML 표 (.xls로 내려받아지는 경우) ---------- */
  function readHtmlTable(text) {
    const rows = [];
    const body = String(text).replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '');
    for (const tr of body.match(/<tr\b[\s\S]*?<\/tr>/gi) || []) {
      const row = [];
      for (const td of tr.match(/<t[dh]\b[\s\S]*?<\/t[dh]>/gi) || []) {
        const span = Number((td.match(/colspan\s*=\s*"?(\d+)/i) || [])[1] || 1);
        const cell = unescape(td.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
        row.push(cell);
        for (let i = 1; i < span; i++) row.push('');
      }
      rows.push(row);
    }
    return rows;
  }

  /**
   * 파일 바이트 → { kind, rows | text }
   *  kind: 'xlsx' | 'html' | 'text'
   */
  function read(bytes, decodeText) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const kind = sniff(b);
    if (kind === 'xls-binary') {
      throw new Error('옛 엑셀 형식(.xls, Excel 97-2003)은 바로 읽을 수 없습니다. 엑셀에서 “다른 이름으로 저장 → Excel 통합 문서(.xlsx)” 또는 CSV로 저장해 주세요.');
    }
    if (kind === 'xlsx') return { kind, rows: readXlsx(b) };
    const text = decodeText(b);
    if (kind === 'html') return { kind, rows: readHtmlTable(text) };
    return { kind: 'text', text };
  }

  return { read, readXlsx, readHtmlTable, sniff, serialToDate, isDateFormat };
});
