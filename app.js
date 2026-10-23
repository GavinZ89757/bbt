/*
 * 体温日记 · UI layer.
 * All data lives in this phone's browser (localStorage). Nothing is sent over the network.
 */
(function () {
  'use strict';
  const B = window.BBT;
  const KEY = 'bbt-tracker-v1';
  const $ = (id) => document.getElementById(id);
  const form = $('recForm');
  const DEMO = new URLSearchParams(location.search).has('demo');
  const WEEK = ['日', '一', '二', '三', '四', '五', '六'];

  let db = DEMO ? { records: B.makeDemoRecords(B.todayISO()), meta: {} } : load();
  const view = { tab: 'record', cycleIndex: null, scrollPending: true };
  let lastChart = null;       // what is on screen, for PNG export
  let storagePersisted = null;
  let installPrompt = null;
  let shownDay = B.todayISO();

  // ---------- storage ----------
  function load() {
    let raw = null;
    try {
      raw = localStorage.getItem(KEY);
      if (!raw) return { records: {}, meta: {} };
      const parsed = JSON.parse(raw) || {};
      const meta = parsed.meta && typeof parsed.meta === 'object' ? parsed.meta : {};
      return {
        records: B.sanitizeRecords(parsed.records).records,
        meta: { lastBackup: B.isValidDate(meta.lastBackup) ? meta.lastBackup : null },
      };
    } catch (err) {
      // Keep the unreadable copy so a later save cannot overwrite it.
      try { if (raw) localStorage.setItem(`${KEY}-unreadable-${Date.now()}`, raw); } catch (_) { /* storage full */ }
      alert('本地数据读取失败，原始数据已另存。可以在“备份/设置”里从备份文件恢复。');
      return { records: {}, meta: {} };
    }
  }

  function persist() {
    if (DEMO) return true;
    try {
      localStorage.setItem(KEY, JSON.stringify({ version: 1, records: db.records, meta: db.meta }));
      return true;
    } catch (err) {
      alert('保存失败：' + err.message);
      return false;
    }
  }

  // ---------- helpers ----------
  const md = (iso) => { const [, m, d] = iso.split('-'); return `${+m}月${+d}日`; };
  const mdShort = (iso) => { const [, m, d] = iso.split('-'); return `${+m}/${+d}`; };
  const weekday = (iso) => '周' + WEEK[new Date(iso + 'T00:00:00').getDay()];
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  let toastTimer = null;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
  }
  const parseTemp = B.parseTemp;
  function lastTempBefore(date) {
    const prev = Object.keys(db.records).filter((d) => d < date && typeof db.records[d].temp === 'number').sort().pop();
    return prev ? db.records[prev].temp : null;
  }
  function derive() {
    const today = B.todayISO();
    const cycles = B.buildCycles(db.records, today);
    return { today, cycles, pred: B.predict(cycles, db.records, today) };
  }

  // ---------- summary ----------
  function renderSummary(d) {
    const box = $('summary');
    box.textContent = '';
    const n = Object.keys(db.records).length;
    if (!n) {
      box.append(el('div', 'big', '开始记录吧'),
        el('p', 'hint', '每天早上醒来、起床前测一次体温记在下面。来月经的第一天在“月经”里选“少/中/多”，就会自动划分周期并生成基础体温表。'));
      return;
    }
    const p = d.pred;
    if (!p.cycleDay) {
      box.append(el('div', 'big', `已记录 ${n} 天`),
        el('p', 'hint', '还没有标记过月经。记录一次月经开始日后，就能计算周期并预测下次月经。'));
      return;
    }
    box.append(el('div', 'big', `今天是周期第 ${p.cycleDay} 天`));
    const dl = el('dl');
    const add = (k, v) => dl.append(el('dt', null, k), el('dd', null, v));
    let next = md(p.nextPeriod);
    if (p.daysToNext > 0) next += `（还有 ${p.daysToNext} 天）`;
    else if (p.daysToNext === 0) next += '（今天）';
    else next += `（已推迟 ${-p.daysToNext} 天）`;
    add('预计下次月经', next);
    if (p.fertileEnd >= d.today && p.daysToNext >= 0) add('易孕期（估算）', `${md(p.fertileStart)} – ${md(p.fertileEnd)}`);
    add('平均周期', p.stats.avg ? `${p.stats.avg} 天（最近 ${p.stats.count} 个周期）` : '暂按 28 天估算');
    if (p.stats.periodAvg) add('平均经期', `${p.stats.periodAvg} 天`);
    const an = B.analyzeCycle(p.current, db.records);
    if (an.shift) add('本周期升温', `${md(an.shift.firstHighDate)} 起，覆盖线 ${an.shift.coverLine.toFixed(2)}℃`);
    box.append(dl);
    if (!db.records[d.today] || typeof db.records[d.today].temp !== 'number') box.append(el('p', 'hint', '今天还没记录体温。'));
  }

  // ---------- record form ----------
  function fillForm(date) {
    const today = B.todayISO();
    const r = db.records[date] || {};
    $('fDate').max = today;
    $('fDate').value = date;
    $('fTemp').value = typeof r.temp === 'number' ? r.temp.toFixed(2) : '';
    form.elements.flow.value = String(r.flow || 0);
    form.elements.lh.value = r.lh || '';
    $('fSex').checked = !!r.sex;
    $('fDist').checked = !!r.disturbed;
    $('fNote').value = r.note || '';
    const exists = !!db.records[date];
    $('btnDel').hidden = !exists;
    $('dNext').disabled = date >= today;
    $('formTitle').textContent = (date === today ? '今天' : `${md(date)} ${weekday(date)}`) + (exists ? ' · 已记录，可修改' : ' · 未记录');
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const date = $('fDate').value;
    if (!B.isValidDate(date)) return toast('请先选择日期');
    if (date > B.todayISO()) return toast('不能记录未来的日期');
    const temp = parseTemp($('fTemp').value);
    if (Number.isNaN(temp) || (temp !== null && (temp < B.TEMP_MIN || temp > B.TEMP_MAX))) {
      toast(`体温请输入 ${B.TEMP_MIN}.00 – ${B.TEMP_MAX}.00 之间的数字`);
      $('fTemp').focus();
      return;
    }
    const rec = B.sanitizeRecord({
      temp, flow: Number(form.elements.flow.value), lh: form.elements.lh.value,
      sex: $('fSex').checked, disturbed: $('fDist').checked, note: $('fNote').value,
    });
    if (rec) db.records[date] = rec;
    else delete db.records[date];
    if (persist()) {
      toast(rec ? '已保存' : '这一天没有内容，已清除');
      renderAll();
      fillForm(date);
    }
  });

  $('btnDel').addEventListener('click', () => deleteDay($('fDate').value));
  function deleteDay(date) {
    if (!db.records[date]) return;
    if (!confirm(`确定删除 ${md(date)} 的记录吗？`)) return;
    delete db.records[date];
    if (persist()) {
      toast('已删除');
      renderAll();
      if ($('fDate').value === date) fillForm(date);
    }
  }

  $('fDate').addEventListener('change', () => {
    const v = $('fDate').value;
    if (B.isValidDate(v)) fillForm(v > B.todayISO() ? B.todayISO() : v);
  });
  $('dPrev').addEventListener('click', () => fillForm(B.addDays($('fDate').value || B.todayISO(), -1)));
  $('dNext').addEventListener('click', () => {
    const next = B.addDays($('fDate').value || B.todayISO(), 1);
    if (next <= B.todayISO()) fillForm(next);
  });
  document.querySelectorAll('.step').forEach((btn) => btn.addEventListener('click', () => {
    let cur = parseTemp($('fTemp').value);
    if (cur === null || Number.isNaN(cur)) cur = lastTempBefore($('fDate').value) ?? 36.5;
    const next = Math.min(B.TEMP_MAX, Math.max(B.TEMP_MIN, Math.round((cur + Number(btn.dataset.step)) * 100) / 100));
    $('fTemp').value = next.toFixed(2);
  }));

  // ---------- chart ----------
  /** Show the current cycle up to the predicted next period so the fertile window is visible. */
  function extendForPrediction(c, pred) {
    if (!pred.nextPeriod) return c;
    const wanted = B.addDays(pred.nextPeriod, -1);
    const cap = B.addDays(c.start, 44);
    const target = wanted < cap ? wanted : cap;
    if (target <= c.end) return c;
    return Object.assign({}, c, { end: target, length: B.diffDays(target, c.start) + 1 });
  }
  const wrapSvg = (inner, w, h, label) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" ` +
    (label ? `role="img" aria-label="${B.esc(label)}"` : 'aria-hidden="true"') + `>${inner}</svg>`;

  function renderChart(d) {
    const { cycles } = d;
    $('chartEmpty').hidden = cycles.length > 0;
    $('chartBody').hidden = cycles.length === 0;
    if (!cycles.length) { lastChart = null; return; }
    if (view.cycleIndex == null || view.cycleIndex > cycles.length - 1) view.cycleIndex = cycles.length - 1;
    const idx = view.cycleIndex;
    const isCurrent = idx === cycles.length - 1;
    const base = cycles[idx];
    const shownCycle = isCurrent ? extendForPrediction(base, d.pred) : base;
    const an = B.analyzeCycle(shownCycle, db.records);
    const fertile = isCurrent && d.pred.fertileStart ? [d.pred.fertileStart, d.pred.fertileEnd] : null;
    const ch = B.buildChart(an, { today: d.today, fertile });

    const range = `${md(base.start)} – ${isCurrent ? '今天' : md(base.end)}`;
    const title = $('cycleTitle');
    title.textContent = range;
    title.append(el('small', null, `${base.start.slice(0, 4)}年 · 第 ${idx + 1} / ${cycles.length} 个周期`));
    $('prevCycle').disabled = idx === 0;
    $('nextCycle').disabled = isCurrent;

    const parts = [];
    if (!base.startKnown) parts.push('起始日未知（这之前没有月经记录）');
    else if (base.closed) parts.push(`周期 ${base.length} 天`);
    else parts.push(`进行中，第 ${B.diffDays(d.today, base.start) + 1} 天`);
    if (an.shift) {
      parts.push(`${mdShort(an.shift.firstHighDate)} 升温`, `覆盖线 ${an.shift.coverLine.toFixed(2)}℃`, `推测排卵 ≈ ${mdShort(an.shift.ovulationDate)}`);
      if (an.shift.highDays != null) parts.push(`高温期 ${an.shift.highDays} 天`);
    } else {
      parts.push('尚未出现可确认的升温');
    }
    const info = parts.join(' · ');
    $('cycleInfo').textContent = info;

    $('chartAxis').innerHTML = wrapSvg(ch.axisInner, ch.axisWidth, ch.height, '');
    const scroller = $('chartScroll');
    scroller.innerHTML = wrapSvg(ch.gridInner, ch.width, ch.height, `基础体温图，${range}，${info}`);
    lastChart = { ch, start: base.start, title: `基础体温表  ${base.start.replace(/-/g, '/')} – ${isCurrent ? '今天' : base.end.replace(/-/g, '/')}`, subtitle: info };

    if (view.scrollPending && view.tab === 'chart') {
      view.scrollPending = false;
      const todayIdx = an.days.findIndex((x) => x.date === d.today);
      const col = B.CHART.col;
      scroller.scrollLeft = isCurrent && todayIdx >= 0 ? Math.max(0, (todayIdx + 4) * col - scroller.clientWidth) : 0;
    }
  }

  $('prevCycle').addEventListener('click', () => { view.cycleIndex--; view.scrollPending = true; renderChart(derive()); });
  $('nextCycle').addEventListener('click', () => { view.cycleIndex++; view.scrollPending = true; renderChart(derive()); });
  $('chartScroll').addEventListener('click', (e) => {
    const hit = e.target.closest('[data-date]');
    if (!hit) return;
    const date = hit.getAttribute('data-date');
    if (date > B.todayISO()) return toast('这一天还没到');
    fillForm(date);
    showTab('record');
  });

  $('btnPng').addEventListener('click', async () => {
    if (!lastChart) return;
    const btn = $('btnPng');
    btn.disabled = true;
    try {
      const out = B.buildExportSVG(lastChart.ch, lastChart.title, lastChart.subtitle);
      const img = new Image();
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(out.svg);
      await img.decode();
      const scale = 2;
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(out.width * scale);
      canvas.height = Math.round(out.height * scale);
      const ctx = canvas.getContext('2d');
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0, out.width, out.height);
      const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
      if (!blob) throw new Error('图片生成失败');
      // Show the picture instead of downloading it: 小米浏览器 and other in-app browsers silently drop
      // blob downloads, but long-press "保存图片" (or a screenshot) always lands in the gallery.
      openViewer(canvas.toDataURL('image/png'), new File([blob], `基础体温表_${lastChart.start}.png`, { type: 'image/png' }));
    } catch (err) {
      alert('导出失败：' + err.message);
    } finally {
      btn.disabled = false;
    }
  });

  // ---------- image viewer ----------
  let viewerFile = null;
  let viewerReturn = null;
  function openViewer(dataUrl, file) {
    viewerFile = file;
    viewerReturn = $('btnPng'); // the button is disabled while rendering, so activeElement is not reliable here
    $('viewerImg').src = dataUrl;
    $('viewerShare').hidden = !(navigator.canShare && navigator.canShare({ files: [file] }));
    $('viewer').hidden = false;
    document.body.style.overflow = 'hidden';
    $('viewerClose').focus();
  }
  function closeViewer() {
    $('viewer').hidden = true;
    $('viewerImg').removeAttribute('src');
    document.body.style.overflow = '';
    viewerFile = null;
    if (viewerReturn && viewerReturn.focus) viewerReturn.focus();
  }
  $('viewerClose').addEventListener('click', closeViewer);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('viewer').hidden) closeViewer(); });
  $('viewerShare').addEventListener('click', async () => {
    if (!viewerFile) return;
    try { await navigator.share({ files: [viewerFile], title: viewerFile.name }); }
    catch (err) { if (!err || err.name !== 'AbortError') toast('分享失败，请长按图片保存'); }
  });

  async function shareOrDownload(blob, name, type) {
    try {
      const file = new File([blob], name, { type });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: name });
        return 'shared';
      }
    } catch (err) {
      if (err && err.name === 'AbortError') return 'cancelled';
      // any other share failure → fall back to a normal download
    }
    const url = URL.createObjectURL(blob);
    const a = el('a');
    a.href = url;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    return 'downloaded';
  }

  // ---------- history ----------
  function renderHistory() {
    const list = $('histList');
    list.textContent = '';
    const dates = Object.keys(db.records).sort().reverse();
    if (!dates.length) { list.append(el('li', 'hint', '还没有记录。')); return; }
    let month = '';
    for (const d of dates) {
      if (d.slice(0, 7) !== month) {
        month = d.slice(0, 7);
        list.append(el('li', 'month', `${+month.slice(0, 4)}年${+month.slice(5)}月`));
      }
      const r = db.records[d];
      const li = el('li', 'hist');
      const main = el('button', 'hist-main');
      main.type = 'button';
      main.dataset.date = d;
      const dateEl = el('span', 'hist-date', mdShort(d));
      dateEl.append(el('small', null, weekday(d)));
      main.append(dateEl);
      main.append(el('span', 'hist-temp' + (r.disturbed ? ' dist' : ''), typeof r.temp === 'number' ? `${r.temp.toFixed(2)}℃` : '—'));
      if (r.flow) main.append(el('span', 'tag flow', '月经·' + B.FLOW_LABELS[r.flow]));
      if (r.lh) main.append(el('span', 'tag lh', '试纸·' + B.LH_LABELS[r.lh]));
      if (r.sex) main.append(el('span', 'tag sex', '同房'));
      if (r.disturbed) main.append(el('span', 'tag', '受干扰'));
      if (r.note) main.append(el('span', 'note', r.note));
      const del = el('button', 'hist-del', '删除');
      del.type = 'button';
      del.dataset.del = d;
      del.setAttribute('aria-label', `删除 ${md(d)} 的记录`);
      li.append(main, del);
      list.append(li);
    }
  }
  $('histList').addEventListener('click', (e) => {
    const del = e.target.closest('[data-del]');
    if (del) return deleteDay(del.dataset.del);
    const item = e.target.closest('[data-date]');
    if (item) { fillForm(item.dataset.date); showTab('record'); }
  });

  // ---------- backup / settings ----------
  function renderSettings() {
    const dates = Object.keys(db.records).sort();
    let txt = dates.length ? `共 ${dates.length} 天记录（${dates[0]} 至 ${dates[dates.length - 1]}）。` : '还没有记录。';
    const lb = db.meta.lastBackup;
    txt += lb ? ` 上次备份：${lb}。` : ' 还没有备份过。';
    if (dates.length && (!lb || B.diffDays(B.todayISO(), lb) > 30)) txt += ' 建议现在备份一次。';
    $('dataInfo').textContent = txt;
    $('storageInfo').textContent =
      storagePersisted === true ? '存储状态：已获得“持久保存”，浏览器不会自动清理这些数据。'
        : storagePersisted === false ? '存储状态：暂未获得“持久保存”（安装到桌面后通常会获得），请定期备份。' : '';
  }

  $('btnExport').addEventListener('click', async () => {
    const payload = { app: 'bbt-tracker', version: 1, exportedAt: new Date().toISOString(), records: db.records };
    const blob = new Blob([JSON.stringify(payload, null, 1)], { type: 'application/json' });
    const how = await shareOrDownload(blob, `体温日记备份_${B.todayISO()}.json`, 'application/json');
    if (how === 'cancelled') return;
    db.meta.lastBackup = B.todayISO();
    persist();
    renderSettings();
    toast(how === 'downloaded' ? '备份已保存到“下载”文件夹' : '已分享备份文件');
  });

  $('btnImport').addEventListener('click', () => $('fileImport').click());
  $('fileImport').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    if (f.size > 5 * 1024 * 1024) return alert('文件太大，不像是本 App 的备份文件。');
    try {
      const data = JSON.parse(await f.text());
      const { records, skipped } = B.sanitizeRecords(data && data.records ? data.records : data);
      const n = Object.keys(records).length;
      if (!n) return alert('这个文件里没有可导入的记录。');
      const overlap = Object.keys(records).filter((k) => db.records[k]).length;
      const msg = `将导入 ${n} 天的记录` + (overlap ? `，其中 ${overlap} 天和现有记录重复，将以备份文件为准` : '') + '。继续吗？';
      if (!confirm(msg)) return;
      Object.assign(db.records, records);
      if (persist()) {
        view.cycleIndex = null;
        renderAll();
        fillForm($('fDate').value || B.todayISO());
        toast(`已导入 ${n} 天` + (skipped ? `，跳过 ${skipped} 条无效数据` : ''));
      }
    } catch (err) {
      alert('无法读取这个文件：' + err.message);
    }
  });

  $('btnClear').addEventListener('click', () => {
    const n = Object.keys(db.records).length;
    if (!n) return toast('没有可删除的数据');
    const ans = prompt(`将永久删除全部 ${n} 天的记录，无法恢复。\n建议先导出备份。\n确认删除请输入：删除`);
    if (ans === null) return;
    if (ans.trim() !== '删除') return toast('输入不一致，已取消');
    db.records = {};
    if (persist()) {
      view.cycleIndex = null;
      renderAll();
      fillForm(B.todayISO());
      toast('已清空全部记录');
    }
  });

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installPrompt = e;
    $('btnInstall').hidden = false;
  });
  $('btnInstall').addEventListener('click', async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;
    $('btnInstall').hidden = true;
  });

  // ---------- tabs ----------
  function showTab(name) {
    view.tab = name;
    document.querySelectorAll('.tab').forEach((s) => { s.hidden = s.id !== `tab-${name}`; });
    document.querySelectorAll('.tabbar button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
    if (name === 'chart') { view.scrollPending = true; renderChart(derive()); }
    window.scrollTo(0, 0);
  }
  document.querySelectorAll('.tabbar button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

  function renderAll() {
    const d = derive();
    renderSummary(d);
    renderHistory();
    renderSettings();
    renderChart(d);
  }

  // Re-render if the app was left open over midnight.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    const t = B.todayISO();
    if (t !== shownDay) { shownDay = t; fillForm(t); renderAll(); }
  });

  // ---------- start ----------
  if (DEMO) $('demoBanner').hidden = false;
  fillForm(B.todayISO());
  renderAll();
  const startTab = location.hash.slice(1); // e.g. index.html#chart opens the chart directly
  if (['chart', 'history', 'settings'].includes(startTab)) showTab(startTab);
  if (!DEMO && navigator.storage && navigator.storage.persist) {
    navigator.storage.persisted()
      .then((p) => p || navigator.storage.persist())
      .then((p) => { storagePersisted = p; renderSettings(); })
      .catch(() => { /* not supported */ });
  }
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline cache is optional */ });
  }
})();
