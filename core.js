/*
 * 体温日记 · core logic (no DOM).
 * Loaded by index.html as window.BBT, and by the Node tests via require().
 * Dates are local calendar days as 'YYYY-MM-DD'; temperatures are °C rounded to 0.01.
 */
(function (root) {
  'use strict';

  const DAY_MS = 86400000;
  const TEMP_MIN = 35;
  const TEMP_MAX = 42;
  const PERIOD_MIN_FLOW = 2; // 1 = 点滴 (spotting) never starts a new cycle
  const MIN_CYCLE_GAP = 18;  // a period start closer than this to the previous one is ignored (e.g. ovulation bleeding)
  const CLEAR_DAYS = 3;      // a period start must follow 3 days without bleeding
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const FLOW_LABELS = ['无', '点滴', '少', '中', '多'];
  const LH_LABELS = { '': '未测', neg: '阴性', weak: '弱阳', pos: '强阳' };

  // ---------- dates ----------
  const pad = (n) => String(n).padStart(2, '0');
  function dayNum(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
  }
  const fromDayNum = (n) => new Date(n * DAY_MS).toISOString().slice(0, 10);
  const addDays = (iso, k) => fromDayNum(dayNum(iso) + k);
  const diffDays = (a, b) => dayNum(a) - dayNum(b); // a - b, in days
  function todayISO(now) {
    const d = now || new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }
  function isValidDate(iso) {
    return typeof iso === 'string' && DATE_RE.test(iso) && fromDayNum(dayNum(iso)) === iso;
  }

  // ---------- data validation (used for localStorage load and backup import) ----------
  /**
   * Parse typed temperature. Accepts 36.45 / 36,45 / 3645 / "36.45度", and the full-width
   * digits and punctuation that Chinese input methods (搜狗/百度/讯飞) often produce.
   * Returns null for empty input, NaN for unparseable input, otherwise the number.
   */
  function parseTemp(input) {
    let s = String(input == null ? '' : input)
      .replace(/[\uFF10-\uFF19]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFF10 + 48)) // ０-９ → 0-9
      .replace(/[,\uFF0C\u3002\uFF0E]/g, '.')   // , ， 。 ． → .
      .replace(/[\s℃°度cC]/g, '');
    if (!s) return null;
    if (/^\d{4}$/.test(s)) s = s.slice(0, 2) + '.' + s.slice(2); // 3645 → 36.45
    if (!/^\d{2}(\.\d{1,2})?$/.test(s)) return NaN;
    return Number(s);
  }

  function sanitizeRecord(r) {
    if (!r || typeof r !== 'object') return null;
    const out = {};
    if (r.temp !== undefined && r.temp !== null && r.temp !== '') {
      const t = Number(r.temp);
      if (Number.isFinite(t) && t >= TEMP_MIN && t <= TEMP_MAX) out.temp = Math.round(t * 100) / 100;
    }
    const flow = Number(r.flow);
    if (Number.isInteger(flow) && flow >= 1 && flow <= 4) out.flow = flow;
    if (r.sex === true) out.sex = true;
    if (r.lh === 'neg' || r.lh === 'weak' || r.lh === 'pos') out.lh = r.lh;
    if (r.disturbed === true) out.disturbed = true;
    if (typeof r.note === 'string' && r.note.trim()) out.note = r.note.trim().slice(0, 200);
    return Object.keys(out).length ? out : null;
  }

  function sanitizeRecords(obj) {
    const records = {};
    let skipped = 0;
    if (obj && typeof obj === 'object') {
      for (const [k, v] of Object.entries(obj)) {
        const r = isValidDate(k) ? sanitizeRecord(v) : null;
        if (r) records[k] = r;
        else skipped++;
      }
    }
    return { records, skipped };
  }

  // ---------- cycles ----------
  const flowOf = (rec) => (rec && rec.flow) || 0;

  function detectCycleStarts(records) {
    const bleed = Object.keys(records).filter((d) => flowOf(records[d]) >= PERIOD_MIN_FLOW).sort();
    const set = new Set(bleed);
    const starts = [];
    for (const d of bleed) {
      let clear = true;
      for (let k = 1; k <= CLEAR_DAYS; k++) {
        if (set.has(addDays(d, -k))) { clear = false; break; }
      }
      if (!clear) continue;
      if (starts.length && diffDays(d, starts[starts.length - 1]) < MIN_CYCLE_GAP) continue;
      starts.push(d);
    }
    return starts;
  }

  /** Split all records into cycles. The last cycle runs up to today. */
  function buildCycles(records, today) {
    const dates = Object.keys(records).sort();
    if (!dates.length) return [];
    const starts = detectCycleStarts(records);
    const lastDate = dates[dates.length - 1];
    const last = lastDate > today ? lastDate : today;
    const cycles = [];
    if (!starts.length || dates[0] < starts[0]) {
      // Records before the first marked period: start day unknown.
      cycles.push({ start: dates[0], end: starts.length ? addDays(starts[0], -1) : last, startKnown: false, closed: starts.length > 0 });
    }
    starts.forEach((s, i) => {
      const closed = i + 1 < starts.length;
      cycles.push({ start: s, end: closed ? addDays(starts[i + 1], -1) : last, startKnown: true, closed });
    });
    for (const c of cycles) c.length = diffDays(c.end, c.start) + 1;
    return cycles;
  }

  /**
   * "3 over 6" rule (sympto-thermal method):
   * three consecutive valid readings above the highest of the 6 readings before them,
   * the 3rd at least 0.20 °C above that cover line — or, if not, a 4th reading still above it.
   * points: [{ idx, t }] with t in hundredths of °C (integers avoid float rounding errors).
   */
  function detectShift(points) {
    for (let k = 6; k + 2 < points.length; k++) {
      const cover = Math.max(...points.slice(k - 6, k).map((p) => p.t));
      const a = points[k], b = points[k + 1], c = points[k + 2];
      if (a.t <= cover || b.t <= cover || c.t <= cover) continue;
      let confirm = null;
      if (c.t >= cover + 20) confirm = c;
      else if (points[k + 3] && points[k + 3].t > cover) confirm = points[k + 3];
      if (confirm) return { cover, firstHigh: a.idx, confirmIdx: confirm.idx };
    }
    return null;
  }

  function analyzeCycle(cycle, records) {
    const days = [];
    for (let i = 0; i < cycle.length; i++) {
      const date = addDays(cycle.start, i);
      days.push({ idx: i, date, cd: cycle.startKnown ? i + 1 : null, rec: records[date] || null });
    }
    const points = days
      .filter((d) => d.rec && typeof d.rec.temp === 'number' && !d.rec.disturbed)
      .map((d) => ({ idx: d.idx, t: Math.round(d.rec.temp * 100) }));
    const s = detectShift(points);
    let shift = null;
    if (s) {
      const ov = Math.max(0, s.firstHigh - 1);
      shift = {
        coverLine: s.cover / 100,
        firstHighIdx: s.firstHigh,
        firstHighDate: days[s.firstHigh].date,
        confirmDate: days[s.confirmIdx].date,
        ovulationIdx: ov,
        ovulationDate: days[ov].date, // estimate: the day before the temperature rise
        highDays: cycle.closed ? cycle.length - s.firstHigh : null,
      };
    }
    return { cycle, days, shift };
  }

  function periodLength(cycle, records) {
    let n = 0;
    while (n < 15 && flowOf(records[addDays(cycle.start, n)]) >= 1) n++;
    return n;
  }

  function cycleStats(cycles, records) {
    const closed = cycles.filter((c) => c.startKnown && c.closed);
    const lens = closed.map((c) => c.length).filter((l) => l >= MIN_CYCLE_GAP && l <= 60).slice(-6);
    const pers = closed.map((c) => periodLength(c, records)).filter((l) => l > 0).slice(-6);
    const avg = (a) => (a.length ? Math.round(a.reduce((s, v) => s + v, 0) / a.length) : null);
    return { avg: avg(lens), count: lens.length, periodAvg: avg(pers) };
  }

  /** Calendar estimate from the average of the last ≤6 complete cycles (28 days if none yet). */
  function predict(cycles, records, today) {
    const stats = cycleStats(cycles, records);
    const current = cycles.length ? cycles[cycles.length - 1] : null;
    const out = { stats, current, cycleDay: null, nextPeriod: null, daysToNext: null, ovulation: null, fertileStart: null, fertileEnd: null };
    if (!current || !current.startKnown) return out;
    const len = stats.avg || 28;
    out.cycleDay = diffDays(today, current.start) + 1;
    out.nextPeriod = addDays(current.start, len);
    out.daysToNext = diffDays(out.nextPeriod, today);
    out.ovulation = addDays(out.nextPeriod, -14);
    out.fertileStart = addDays(out.ovulation, -5);
    out.fertileEnd = addDays(out.ovulation, 1);
    return out;
  }

  // ---------- chart (SVG strings; all styling inline so the PNG export looks identical) ----------
  const C = { col: 26, axisW: 46, row: 20, step: 9, tempRow: 38 }; // step = px per 0.05 °C
  const COLORS = {
    low: '#1e6fd9', high: '#d63a4a', dist: '#9e9e9e', cover: '#ef6c00', line: '#78909c',
    period: '#fde3e7', spot: '#fff0f2', ovu: '#ece3fa', fertile: '#e3eefc', future: '#f7f7f7',
    today: '#c2405a', text: '#333333', muted: '#666666',
  };
  const FONT = `font-family="Roboto, 'Noto Sans CJK SC', 'PingFang SC', 'Microsoft YaHei', sans-serif"`;
  const r1 = (v) => Math.round(v * 10) / 10;

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }
  function svgText(x, y, s, o = {}) {
    return `<text x="${r1(x)}" y="${r1(y)}" font-size="${o.size || 10}" fill="${o.fill || COLORS.text}"` +
      (o.anchor ? ` text-anchor="${o.anchor}"` : '') +
      (o.weight ? ` font-weight="${o.weight}"` : '') +
      (o.extra || '') + `>${esc(s)}</text>`;
  }
  const svgLine = (x1, y1, x2, y2, stroke, w = 1, extra = '') =>
    `<line x1="${r1(x1)}" y1="${r1(y1)}" x2="${r1(x2)}" y2="${r1(y2)}" stroke="${stroke}" stroke-width="${w}"${extra}/>`;
  const svgRect = (x, y, w, h, fill, extra = '') =>
    `<rect x="${r1(x)}" y="${r1(y)}" width="${r1(w)}" height="${r1(h)}" fill="${fill}"${extra}/>`;

  /**
   * Medical-style BBT chart for one cycle.
   * opts.today: 'YYYY-MM-DD' (outline + grey future days); opts.fertile: [start, end] predicted window.
   * Returns inner SVG markup for the fixed Y axis and the scrollable grid, plus their sizes.
   */
  function buildChart(an, opts = {}) {
    const { days, shift } = an;
    const { col, axisW, row, step, tempRow } = C;
    const n = days.length;

    const all = days.filter((d) => d.rec && typeof d.rec.temp === 'number').map((d) => Math.round(d.rec.temp * 100));
    let lo = 3600, hi = 3720;
    if (all.length) {
      lo = Math.min(lo, Math.floor((Math.min(...all) - 10) / 10) * 10);
      hi = Math.max(hi, Math.ceil((Math.max(...all) + 10) / 10) * 10);
    }
    const plotTop = row * 2 + 10;
    const plotH = ((hi - lo) / 5) * step;
    const yOf = (t) => plotTop + ((hi - t) / 5) * step;
    const rowsTop = plotTop + plotH + 10;
    const rows = [];
    let yy = rowsTop;
    for (const [label, h] of [['体温', tempRow], ['月经', row], ['同房', row], ['试纸', row], ['干扰', row]]) {
      rows.push({ label, y: yy, h });
      yy += h;
    }
    const height = yy;
    const width = n * col;
    const cx = (i) => i * col + col / 2;
    const sepYs = [row, row * 2, rowsTop, ...rows.map((r) => r.y + r.h)];

    // Y axis (stays fixed while the grid scrolls)
    const ax = [svgRect(0, 0, axisW, height, '#ffffff')];
    ax.push(svgText(axisW - 6, row / 2 + 4, '周期', { anchor: 'end', fill: COLORS.muted }));
    ax.push(svgText(axisW - 6, row * 1.5 + 4, '日期', { anchor: 'end', fill: COLORS.muted }));
    ax.push(svgText(4, plotTop - 2, '℃', { fill: COLORS.muted }));
    for (let t = lo; t <= hi; t += 10) {
      const major = t % 50 === 0;
      ax.push(svgLine(axisW - 4, yOf(t), axisW, yOf(t), '#999999'));
      ax.push(svgText(axisW - 6, yOf(t) + 3.5, (t / 100).toFixed(1), {
        anchor: 'end', size: major ? 10.5 : 9.5, weight: major ? 'bold' : null, fill: major ? '#222222' : '#555555',
      }));
    }
    for (const r of rows) ax.push(svgText(axisW - 6, r.y + r.h / 2 + 4, r.label, { anchor: 'end', fill: COLORS.muted }));
    for (const y of sepYs) ax.push(svgLine(0, y, axisW, y, '#e3e3e3'));

    // Grid
    const g = [svgRect(0, 0, width, height, '#ffffff')];
    days.forEach((d, i) => {
      const flow = flowOf(d.rec);
      let bg = null;
      if (opts.today && d.date > opts.today) bg = COLORS.future;
      if (opts.fertile && d.date >= opts.fertile[0] && d.date <= opts.fertile[1]) bg = COLORS.fertile;
      if (shift && i === shift.ovulationIdx) bg = COLORS.ovu;
      if (flow >= 2) bg = COLORS.period;
      else if (flow === 1) bg = COLORS.spot;
      if (bg) g.push(svgRect(i * col, plotTop, col, plotH, bg));
    });
    for (let t = lo; t <= hi; t += 5) {
      g.push(svgLine(0, yOf(t), width, yOf(t), t % 50 === 0 ? '#b0b0b0' : t % 10 === 0 ? '#d4d4d4' : '#eeeeee'));
    }
    for (let i = 0; i <= n; i++) g.push(svgLine(i * col, 0, i * col, height, '#e6e6e6'));
    for (const y of sepYs) g.push(svgLine(0, y, width, y, '#e3e3e3'));

    // Header rows: cycle day + date
    days.forEach((d, i) => {
      if (d.cd != null) {
        g.push(svgText(cx(i), row / 2 + 4, String(d.cd), { anchor: 'middle', fill: d.cd === 1 ? COLORS.today : COLORS.text, weight: d.cd === 1 ? 'bold' : null }));
      }
      const [, mm, dd] = d.date.split('-');
      const label = i === 0 || dd === '01' ? `${+mm}/${+dd}` : String(+dd);
      g.push(svgText(cx(i), row * 1.5 + 4, label, { anchor: 'middle', size: label.length > 3 ? 8.5 : 10 }));
    });

    // Labels inside the plot
    if (shift) g.push(svgText(cx(shift.ovulationIdx), plotTop + 12, '排', { anchor: 'middle', fill: '#6a3fb8', weight: 'bold' }));
    if (opts.fertile) {
      const fi = days.findIndex((d) => d.date >= opts.fertile[0] && d.date <= opts.fertile[1]);
      if (fi >= 0) g.push(svgText(fi * col + 3, plotTop + plotH - 5, '易孕期', { fill: '#1d5bb5' }));
    }

    // Cover line
    if (shift) {
      const y = yOf(Math.round(shift.coverLine * 100));
      g.push(svgLine(0, y, width, y, COLORS.cover, 1.5, ' stroke-dasharray="6 4"'));
      // Right end, just below the line: post-rise readings sit above it, so this spot is usually empty.
      g.push(svgText(width - 3, y + 12, `覆盖线 ${shift.coverLine.toFixed(2)}`, { anchor: 'end', fill: '#e65100' }));
    }

    // Temperature curve. Missing days break the line; disturbed readings are bridged over.
    const pts = [];
    days.forEach((d, i) => {
      if (d.rec && typeof d.rec.temp === 'number') pts.push({ i, t: Math.round(d.rec.temp * 100), dist: !!d.rec.disturbed });
    });
    const distIdx = new Set(pts.filter((p) => p.dist).map((p) => p.i));
    const valid = pts.filter((p) => !p.dist);
    for (let k = 0; k + 1 < valid.length; k++) {
      const a = valid[k], b = valid[k + 1];
      let connected = true;
      for (let j = a.i + 1; j < b.i; j++) if (!distIdx.has(j)) { connected = false; break; }
      if (connected) g.push(svgLine(cx(a.i), yOf(a.t), cx(b.i), yOf(b.t), COLORS.line, 1.6));
    }
    for (const p of pts) {
      const x = r1(cx(p.i)), y = r1(yOf(p.t));
      if (p.dist) g.push(`<circle cx="${x}" cy="${y}" r="3.6" fill="#ffffff" stroke="${COLORS.dist}" stroke-width="1.5"/>`);
      else {
        const color = shift && p.i >= shift.firstHighIdx ? COLORS.high : COLORS.low;
        g.push(`<circle cx="${x}" cy="${y}" r="3.9" fill="${color}" stroke="#ffffff" stroke-width="1"/>`);
      }
    }

    // Bottom rows
    days.forEach((d, i) => {
      const r = d.rec;
      if (!r) return;
      const x = cx(i);
      if (typeof r.temp === 'number') {
        const ty = r1(rows[0].y + rows[0].h / 2);
        const fill = r.disturbed ? COLORS.dist : shift && i >= shift.firstHighIdx ? COLORS.high : COLORS.low;
        g.push(`<text x="${r1(x)}" y="${ty}" font-size="9.5" fill="${fill}" text-anchor="middle" dy="0.35em" transform="rotate(-90 ${r1(x)} ${ty})">${r.temp.toFixed(2)}</text>`);
      }
      if (r.flow) {
        const rr = rows[1];
        if (r.flow === 1) g.push(`<circle cx="${r1(x)}" cy="${r1(rr.y + rr.h / 2)}" r="2.5" fill="${COLORS.high}"/>`);
        else g.push(svgRect(i * col + 5, rr.y + 4, col - 10, rr.h - 8, COLORS.high, ` rx="2" fill-opacity="${[0, 0, 0.35, 0.65, 1][r.flow]}"`));
      }
      if (r.sex) g.push(svgText(x, rows[2].y + 14.5, '♥', { anchor: 'middle', size: 13, fill: '#e0528a' }));
      if (r.lh) {
        const [sym, fill] = { neg: ['−', '#9e9e9e'], weak: ['+', '#ef8f00'], pos: ['++', COLORS.high] }[r.lh];
        g.push(svgText(x, rows[3].y + 14, sym, { anchor: 'middle', size: 11, fill, weight: 'bold' }));
      }
      if (r.disturbed) g.push(svgText(x, rows[4].y + 14.5, '×', { anchor: 'middle', size: 13, fill: '#757575' }));
    });

    // Today outline + tap targets
    days.forEach((d, i) => {
      if (d.date === opts.today) g.push(svgRect(i * col + 1, 1, col - 2, height - 2, 'none', ` stroke="${COLORS.today}" stroke-width="1.5" rx="3"`));
    });
    days.forEach((d, i) => {
      const t = d.rec && typeof d.rec.temp === 'number' ? ` ${d.rec.temp.toFixed(2)}℃` : '';
      g.push(`<rect class="hit" data-date="${d.date}" x="${i * col}" y="0" width="${col}" height="${r1(height)}" fill="transparent"><title>${esc(d.date + t)}</title></rect>`);
    });

    return {
      axisInner: `<g ${FONT}>${ax.join('')}</g>`,
      gridInner: `<g ${FONT}>${g.join('')}</g>`,
      axisWidth: axisW,
      width,
      height: r1(height),
    };
  }

  /** One self-contained SVG (title + axis + grid) for PNG export. */
  function buildExportSVG(ch, title, subtitle) {
    const head = 50;
    const width = Math.max(ch.axisWidth + ch.width, 360);
    const height = r1(ch.height + head);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
      svgRect(0, 0, width, height, '#ffffff') +
      `<g ${FONT}>${svgText(10, 21, title, { size: 15, weight: 'bold', fill: '#222222' })}${svgText(10, 40, subtitle, { size: 10.5, fill: '#555555' })}</g>` +
      `<g transform="translate(0 ${head})">${ch.axisInner}</g>` +
      `<g transform="translate(${ch.axisWidth} ${head})">${ch.gridInner}</g>` +
      svgLine(ch.axisWidth, head, ch.axisWidth, height, '#cccccc') +
      '</svg>';
    return { svg, width, height };
  }

  // ---------- demo data (index.html?demo — never written to storage) ----------
  function makeDemoRecords(today) {
    let seed = 20261022;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const recs = {};
    const cycles = [
      { start: addDays(today, -67), len: 28 },
      { start: addDays(today, -39), len: 30 },
      { start: addDays(today, -9), len: 10, current: true },
    ];
    cycles.forEach((c, ci) => {
      const ovCd = (c.current ? 28 : c.len) - 14; // cycle day of ovulation
      for (let cd = 1; cd <= c.len; cd++) {
        if (ci === 0 && cd === 20) continue; // a forgotten day → gap in the curve
        const r = {};
        const high = cd > ovCd;
        r.temp = Math.round((high ? 36.72 + rnd() * 0.16 : 36.32 + rnd() * 0.16) * 100) / 100;
        if (cd <= 5) r.flow = [3, 4, 3, 2, 1][cd - 1];
        if (cd === ovCd - 2) r.lh = 'weak';
        if (cd === ovCd - 1) r.lh = 'pos';
        if (cd === ovCd + 1) r.lh = 'neg';
        if (cd === 11 || cd === ovCd - 1 || cd === ovCd + 3) r.sex = true;
        if (ci === 1 && cd === 8) { r.temp = 36.98; r.disturbed = true; r.note = '熬夜'; }
        recs[addDays(c.start, cd - 1)] = r;
      }
    });
    return recs;
  }

  const api = {
    TEMP_MIN, TEMP_MAX, FLOW_LABELS, LH_LABELS, CHART: C,
    addDays, diffDays, todayISO, isValidDate,
    sanitizeRecord, sanitizeRecords, parseTemp,
    detectCycleStarts, buildCycles, detectShift, analyzeCycle, cycleStats, predict,
    buildChart, buildExportSVG, makeDemoRecords, esc,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BBT = api;
})(typeof window !== 'undefined' ? window : globalThis);
