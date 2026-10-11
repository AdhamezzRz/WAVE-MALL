/* Wave Mall presentation engine: navigation, bilingual EN/AR, animated modules. No dependencies except three.js (scene.js). */
(function () {
  'use strict';
  const $ = (s, r) => (r || document).querySelector(s), $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const store = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) { } } };
  let lang = document.documentElement.dataset.forceLang || store.get('wm-lang') || ((navigator.language || '').toLowerCase().indexOf('ar') === 0 ? 'ar' : 'en');
  const tt = s => { const p = String(s).split('||'); return lang === 'ar' && p[1] ? p[1] : p[0]; };
  const fmt = n => Number(n).toLocaleString('en-US');
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  const slides = $$('.slide'); let cur = -1;
  const Scene = window.Scene3D; const Mod = {};

  /* ---------- language ---------- */
  function applyLang() {
    document.documentElement.lang = lang; document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
    $$('[data-t]').forEach(el => { el.textContent = tt(el.dataset.t); });
    $$('#langSw button').forEach(b => b.classList.toggle('on', b.dataset.l === lang));
    document.title = lang === 'ar' ? 'ويف مول · دراسة الموقع والسوق · NAJ' : 'Wave Mall · Location & Market Study · NAJ';
    if (Scene && Scene.ready) Scene.setLang(lang);
    buildMenu(); buildNav(); updateChrome();
    Object.keys(Mod).forEach(k => Mod[k].lang && Mod[k].lang());
    buildCover(); $$('.slide.active [data-to]').forEach(el => countUp(el));
  }
  function setLang(l) { lang = l; store.set('wm-lang', l); applyLang(); }

  /* ---------- cover letters ---------- */
  function buildCover() {
    const h = $('#coverTitle'); if (!h) return;
    h.innerHTML = '';
    if (lang === 'ar') { h.textContent = 'ويف مول'; return; }
    'WAVE MALL'.split('').forEach((c, i) => { const s = document.createElement('span'); s.textContent = c === ' ' ? ' ' : c; s.style.setProperty('--i', i); h.appendChild(s); });
  }

  /* ---------- tooltip ---------- */
  const tip = $('#tip');
  function showTip(html, x, y) { tip.innerHTML = html; tip.classList.add('on'); const w = tip.offsetWidth, h = tip.offsetHeight; tip.style.left = clamp(x + 16, 8, innerWidth - w - 8) + 'px'; tip.style.top = clamp(y + 16, 8, innerHeight - h - 8) + 'px'; }
  function hideTip() { tip.classList.remove('on'); }
  document.addEventListener('pointermove', e => { if (tip.classList.contains('on')) { const w = tip.offsetWidth, h = tip.offsetHeight; tip.style.left = clamp(e.clientX + 16, 8, innerWidth - w - 8) + 'px'; tip.style.top = clamp(e.clientY + 16, 8, innerHeight - h - 8) + 'px'; } });
  const tipOn = (el, fn) => { el.addEventListener('pointerenter', e => showTip(fn(), e.clientX, e.clientY)); el.addEventListener('pointerleave', hideTip); };

  /* ---------- numbers ---------- */
  function countUp(el) {
    const tk = (el._ct = {}); const to = parseFloat(el.dataset.to), dec = +el.dataset.dec || 0, pre = el.dataset.pre || '', suf = (lang === 'ar' && el.dataset.sufAr !== undefined) ? el.dataset.sufAr : (el.dataset.suf || ''), dur = +el.dataset.dur || 1700; const t0 = performance.now();
    const f = now => { if (el._ct !== tk) return; const p = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - p, 4); el.textContent = pre + (to * e).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec }) + suf; if (p < 1) requestAnimationFrame(f); };
    requestAnimationFrame(f);
  }
  function tween(el, to, dur) { const from = el._v || 0, t0 = performance.now(); dur = dur || 900; el._v = to; const tok = (el._tk = (el._tk || 0) + 1); const f = now => { if (el._tk !== tok) return; const p = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - p, 3); el.textContent = fmt(Math.round(from + (to - from) * e)); if (p < 1) requestAnimationFrame(f); }; requestAnimationFrame(f); }

  /* ---------- website mode: scroll-driven sections ---------- */
  const NAV = [['Overview||نظرة عامة', 'cover'], ['Identity||الهوية', 'pin'], ['Location||الموقع', 'numbers'], ['Catchment||منطقة الجذب', 'catchment'], ['Competitors||المنافسون', 'bubble'], ['Market||السوق', 'market'], ['Strategy||الاستراتيجية', 'swot'], ['Plan||الخطة', 'roadmap'], ['Next||الخطوات', 'gaps'], ['Sources||المصادر', 'references']];
  const idxOf = id => slides.findIndex(s => s.id === 's-' + id);
  let ticking = false, firstCur = true;
  function fitSoon() { }
  function buildNav() { const n = $('#topnav'); if (!n) return; n.innerHTML = ''; NAV.forEach(x => { const a = document.createElement('a'); a.href = '#s-' + x[1]; a.textContent = tt(x[0]); a.dataset.i = idxOf(x[1]); n.appendChild(a); }); markNav(); }
  function markNav() { let best = -1; $$('#topnav a').forEach(a => { if (cur >= 0 && +a.dataset.i <= cur) best = +a.dataset.i; }); $$('#topnav a').forEach(a => a.classList.toggle('on', +a.dataset.i === best)); }
  function updateChrome() { if (cur < 0) return; markNav(); $$('#menu button').forEach((b, k) => b.classList.toggle('cur', k === cur)); }
  function reveal(s) {
    if (s.classList.contains('active')) return;
    $$('.rv', s).forEach((el, k) => { if (!el.dataset.fixed) el.style.setProperty('--d', (k * 75 + 80) + 'ms'); });
    s.classList.add('active'); $$('[data-to]', s).forEach(el => countUp(el));
  }
  function setCurrent(i) {
    if (i === cur) return; const prev = slides[cur]; if (prev) { prev.classList.remove('current'); const pm = Mod[prev.id.slice(2)]; pm && pm.leave && pm.leave(prev); }
    cur = i; const s = slides[cur]; s.classList.add('current'); reveal(s);
    document.body.classList.toggle('free', s.classList.contains('free'));
    if (Scene && Scene.ready) {
      Scene.setPreset(s.dataset.cam || 'iso', { snap: firstCur }); Scene.setDim(s.dataset.dim || '1'); Scene.setBlur(s.dataset.blur || 0);
      Scene.setLayers((s.dataset.layers || 'health,school,retail,living,transit').split(',')); Scene.setLabels(s.dataset.labels || 'none'); Scene.setRadar(s.dataset.radar === '1'); Scene.arcs = s.dataset.arcs === '1'; Scene.highlight(null);
    }
    firstCur = false; const m = Mod[s.id.slice(2)]; m && m.enter && m.enter(s);
    updateChrome(); hideTip(); try { history.replaceState(null, '', '#' + s.id); } catch (e) { }
  }
  function onScroll() {
    ticking = false; const vh = innerHeight; let c = -1;
    slides.forEach((s, i) => { const r = s.getBoundingClientRect(); if (r.top < vh * .9) reveal(s); if (r.top <= vh * .5 && r.bottom > vh * .5) c = i; });
    if (c >= 0) setCurrent(c);
    const h = document.documentElement; const p = h.scrollTop / ((h.scrollHeight - vh) || 1); $('#bar i').style.width = (clamp(p, 0, 1) * 100) + '%';
    const hint = $('#hint'); if (hint) hint.style.opacity = h.scrollTop < 60 ? 1 : 0;
  }
  addEventListener('scroll', () => { if (!ticking) { ticking = true; requestAnimationFrame(onScroll); } }, { passive: true });
  addEventListener('resize', onScroll);
  function go(i) { slides[clamp(i, 0, slides.length - 1)].scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  function buildMenu() {
    const g = $('#menu .grid'); g.innerHTML = '';
    slides.forEach((s, k) => { const b = document.createElement('button'); b.innerHTML = '<em>' + String(k + 1).padStart(2, '0') + '</em><span></span>'; b.querySelector('span').textContent = tt(s.dataset.title || s.dataset.sec || ''); b.onclick = () => { toggleMenu(false); go(k); }; g.appendChild(b); });
  }
  function toggleMenu(v) { const m = $('#menu'); const on = v === undefined ? !m.classList.contains('on') : v; m.classList.toggle('on', on); document.body.style.overflow = on ? 'hidden' : ''; }
  addEventListener('keydown', e => {
    if (e.target.matches('input,textarea')) return; const k = e.key;
    if (k === 'm' || k === 'M') toggleMenu(); else if (k === 'Escape') toggleMenu(false); else if (k === 'l' || k === 'L') setLang(lang === 'ar' ? 'en' : 'ar');
  });
  document.addEventListener('click', e => { const f = e.target.closest('.flip'); if (f) f.classList.toggle('on'); });

  /* scene drag (horizontal only, so the page still scrolls) on the 3D explorer */
  (function () { const c = $('#scene'); let d = false, lx = 0;
    c.addEventListener('pointerdown', e => { if (!document.body.classList.contains('free')) return; d = true; lx = e.clientX; try { c.setPointerCapture(e.pointerId); } catch (x) { } c.style.cursor = 'grabbing'; });
    c.addEventListener('pointermove', e => { if (!d) return; Scene.nudge(e.clientX - lx, 0); lx = e.clientX; });
    c.addEventListener('pointerup', () => { d = false; c.style.cursor = ''; });
  })();

  /* ====================== MODULES ====================== */
  /* film: decoded from the embedded base64 when this is the single-file build */
  Mod.film = {
    enter(s) { const v = $('video', s); const p = v.play(); p && p.catch(() => { }); const b = $('#filmBtn'); if (b) b.textContent = v.paused ? '▶' : '❚❚'; },
    leave(s) { $('video', s).pause(); }
  };
  function loadFilm() {
    const v = $('#s-film video'), d = $('#filmData'); if (!v) return;
    if (d && d.textContent.trim()) { try { const bin = atob(d.textContent.trim()), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); v.src = URL.createObjectURL(new Blob([u], { type: 'video/mp4' })); d.textContent = ''; } catch (e) { } }
    const b = $('#filmBtn'); if (b) b.onclick = () => { if (v.paused) { v.play(); b.textContent = '❚❚'; } else { v.pause(); b.textContent = '▶'; } };
  }

  /* explore (3D) */
  (function () {
    const cats = [['all', 'All||الكل', '#e6e7e7'], ['health', 'Health||الصحة', '#3ecf9e'], ['school', 'Schools||المدارس', '#e08a6c'], ['retail', 'Retail||التجزئة', '#d9a441'], ['living', 'Living & hotels||السكن والفنادق', '#8f9bea'], ['transit', 'Monorail||المونوريل', '#7ff0c5']];
    let sel = 'all', box, info, list;
    function build() {
      box = $('#expChips'); box.innerHTML = '';
      cats.forEach(c => { const b = document.createElement('button'); b.className = 'chip' + (c[0] === sel ? ' on' : ''); b.style.setProperty('--c', c[2]); b.innerHTML = '<i></i><span></span>'; b.querySelector('span').textContent = tt(c[1]); b.onclick = () => pick(c[0]); box.appendChild(b); });
    }
    function pick(c) {
      sel = c; build(); const all = c === 'all';
      Scene.setLayers(all ? ['health', 'school', 'retail', 'living', 'transit'] : [c]); Scene.setLabels(all ? 'imp' : 'all'); Scene.arcs = !all;
      if (all) Scene.setPreset('explore'); else if (c === 'transit') Scene.setPreset('mono'); else Scene.focusCat(c);
      fill(all ? null : c);
    }
    function fill(c) {
      list = $('#expList'); const pts = Scene.pois.filter(p => (c ? p.cat === c : p.imp)).sort((a, b) => a.d - b.d);
      list.innerHTML = ''; pts.forEach(p => { const r = document.createElement('button'); r.className = 'xrow'; r.innerHTML = '<span></span><em>' + p.d.toFixed(2) + (lang === 'ar' ? ' كم' : ' km') + '</em>'; r.firstChild.textContent = p[lang] || p.en; r.onclick = () => show(p); r.onpointerenter = () => Scene.highlight(p.k); r.onpointerleave = () => Scene.highlight(null); list.appendChild(r); });
    }
    function show(p) { info = $('#expInfo'); info.innerHTML = '<h4></h4><p></p><small>' + p.d.toFixed(2) + ' km ' + tt('from the pin||من الموقع') + '</small>'; $('h4', info).textContent = p[lang] || p.en; $('p', info).textContent = lang === 'ar' ? p.nar : p.nen; info.classList.add('on'); Scene.focusPOI(p.k); Scene.highlight(p.k); }
    Mod.explore = { enter() { sel = 'all'; build(); fill(null); $('#expInfo').classList.remove('on'); Scene.onPin = p => { if (p.k !== 'pin') show(p); }; Scene.onPinOver = (p, e, on) => { if (!on || p.k === 'pin') return hideTip(); showTip('<h4>' + (p[lang] || p.en) + '</h4>' + (lang === 'ar' ? p.nar : p.nen) + '<small>' + p.d.toFixed(2) + ' km</small>', e.clientX, e.clientY); }; }, leave() { Scene.onPin = function () { }; Scene.onPinOver = function () { }; hideTip(); }, lang() { if ($('#expChips')) { build(); fill(sel === 'all' ? null : sel); } } };
  })();

  /* catchment simulator */
  (function () {
    const D = { 0: [5400, 68500, 471000], 1: [1900, 22700, 112000], 2: [300, 5400, 22700] }; const F = [1, .75, .5];
    const names = ['Free-flow roads||الطرق فاضية', 'Moderate traffic||زحمة متوسطة', 'Peak traffic||ذروة الزحمة']; const sub = ['late evening, weekend morning||آخر الليل أو صباح الإجازة', 'normal daytime||النهار العادي', 'school run, 8 am and 3 pm||طابور المدارس، 8 صباحًا و3 عصرًا'];
    function render(v) {
      v = +v; const d = D[v]; $$('.cc-n').forEach((el, i) => tween(el, d[i]));
      $$('.cc-h').forEach((el, i) => tween(el, Math.round(d[Math.floor(i / 2)] / 4 / 100) * 100));
      $('#ccName').textContent = tt(names[v]); $('#ccSub').textContent = tt(sub[v]);
      [70, 140, 210].forEach((r, i) => { const c = $('#ccr' + i); c.setAttribute('r', r * F[v]); c.style.r = (r * F[v]) + 'px'; }); $$('.cc-lab').forEach((t, i) => { t.setAttribute('y', 258 - [70, 140, 210][i] * F[v] - 6); });
    }
    Mod.catchment = { enter() { const r = $('#ccRange'); r.value = 0; render(0); r.oninput = () => render(r.value); setTimeout(() => { if ($('#s-catchment').classList.contains('active') && +r.value === 0) { r.value = 2; render(2); } }, 3600); }, lang() { const r = $('#ccRange'); r && render(r.value); } };
  })();

  /* day in the life */
  (function () {
    const hrs = []; for (let h = 6; h <= 23; h++) hrs.push(h);
    const ROWS = [
      ['School-run parents||أولياء الأمور (طابور المدارس)', '#e08a6c', [0, 3, 3, 1, 0, 0, 0, 1, 3, 3, 2, 0, 0, 0, 0, 0, 0, 0]],
      ['Hospital staff & visitors||العاملون والزوار بالمستشفيات', '#3ecf9e', [1, 1, 2, 3, 3, 3, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 0]],
      ['Clinic & office users||مستخدمو العيادات والمكاتب', '#8f9bea', [0, 0, 1, 3, 3, 3, 2, 3, 3, 3, 2, 1, 0, 0, 0, 0, 0, 0]],
      ['Residents (Lakeview & nearby)||السكان (ليك فيو وما حولها)', '#d9a441', [0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 2, 3, 3, 3, 3, 2, 1]],
      ['Monorail riders||ركاب المونوريل', '#7ff0c5', [1, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 1, 1, 0, 0]]
    ];
    const WIN = [[7, 9, 'Morning coffee & grab-and-go||قهوة الصباح وطلبات سريعة'], [12, 14, 'Pharmacy, services, lunch||صيدلية وخدمات وغداء'], [14, 16, 'School pick-up hour||ساعة خروج المدارس'], [18, 21, 'Family dinner & weekend outing||عشاء العائلة وخروجة الإجازة']];
    let timer, hr = 7;
    function build() {
      const g = $('#dayGrid'); g.innerHTML = '';
      const head = document.createElement('div'); head.className = 'dh'; head.innerHTML = '<span></span>' + hrs.map(h => '<span class="hh">' + String(h).padStart(2, '0') + '</span>').join(''); g.appendChild(head);
      ROWS.forEach((r, ri) => { const row = document.createElement('div'); row.className = 'dr'; const l = document.createElement('span'); l.className = 'dl'; l.textContent = tt(r[0]); row.appendChild(l);
        r[2].forEach((v, i) => { const c = document.createElement('span'); c.className = 'dc v' + v; c.style.setProperty('--c', r[1]); c.style.setProperty('--dd', (ri * 60 + i * 18) + 'ms'); c.dataset.h = hrs[i]; row.appendChild(c); }); g.appendChild(row); });
      const ph = document.createElement('div'); ph.className = 'ph'; ph.id = 'dayHead'; g.appendChild(ph); place(hr);
      $('#dayWin').innerHTML = WIN.map(w => '<div class="glass"><span class="tag">' + String(w[0]).padStart(2, '0') + '–' + String(w[1]).padStart(2, '0') + '</span><p class="cap" style="margin-top:.6rem">' + tt(w[2]) + '</p></div>').join('');
    }
    function who(h) { const i = h - 6; const act = ROWS.filter(r => r[2][i] >= 3).map(r => tt(r[0]).split(' (')[0]); const med = ROWS.filter(r => r[2][i] === 2).map(r => tt(r[0]).split(' (')[0]); return act.length ? act : med.length ? med : [tt('Quiet hour||ساعة هادئة')]; }
    function place(h) { hr = h; const g = $('#dayGrid'); const first = $('.dr .dc[data-h="' + h + '"]', g); const ph = $('#dayHead'); if (!first || !ph) return; const gr = g.getBoundingClientRect(), cr = first.getBoundingClientRect(); ph.style.left = (cr.left - gr.left) + 'px'; ph.style.width = cr.width + 'px'; $$('.dc', g).forEach(c => c.classList.toggle('now', +c.dataset.h === h)); $('#dayNow').textContent = String(h).padStart(2, '0') + ':00'; $('#dayWho').textContent = who(h).join(' · '); }
    Mod.day = { enter() { build(); hr = 7; clearInterval(timer); timer = setInterval(() => { hr = hr >= 23 ? 6 : hr + 1; place(hr); $('#dayRange').value = hr; }, 1600); const r = $('#dayRange'); r.value = 7; r.oninput = () => { clearInterval(timer); place(+r.value); }; setTimeout(() => place(7), 50); }, leave() { clearInterval(timer); }, lang() { if ($('#dayGrid')) build(); } };
  })();

  /* distance ladder */
  (function () {
    const L = [
      ['Health||الصحة', '#3ecf9e', [[.33, 'Air Force Hospital||مستشفى القوات الجوية'], [1.36, 'Al Salam Intl||السلام الدولي'], [1.43, 'Tabarak||تبارك'], [1.95, 'Al Tabib||الطبيب']]],
      ['Schools||المدارس', '#e08a6c', [[.86, 'Deutsche Schule||الألمانية الخاصة'], [.92, 'Balzac||بلزاك'], [.96, 'MES||مودرن إنجلش'], [1.12, 'German School||المدرسة الألمانية'], [1.32, 'Hayah||حياة'], [1.7, 'British||البريطانية'], [2.18, 'Akhnaton||إخناتون']]],
      ['Retail||التجزئة', '#d9a441', [[1.51, 'G.OUT||جي أوت'], [1.89, 'Downtown Katameya||داون تاون القطامية'], [2.2, 'One Ninety||ون ناينتي'], [2.53, 'Cairo Festival City||كايرو فستيفال سيتي'], [5.0, 'Waterway||ووتر واي'], [6.0, 'Point 90||بوينت 90'], [8.1, 'Eastown||إيستاون']]],
      ['Compounds||الكمبوندات', '#8f9bea', [[1.01, 'Lakeview||ليك فيو'], [3.7, 'Katameya Heights||قطامية هايتس'], [5.9, 'Katameya Plaza||قطامية بلازا'], [8.0, 'Eastown (SODIC)||إيستاون (سوديك)'], [8.6, 'Katameya Dunes||قطامية ديونز'], [9.4, 'Mivida||ميفيدا'], [11.5, 'Hyde Park||هايد بارك']]]
    ];
    const MAX = 12;
    function build() {
      const w = $('#ladder'); w.innerHTML = ''; const body = document.createElement('div'); body.className = 'lbody'; w.appendChild(body);
      const axis = document.createElement('div'); axis.className = 'lax'; for (let k = 0; k <= MAX; k += 2) { const t = document.createElement('span'); t.style.left = (k / MAX * 100) + '%'; t.textContent = k + ' km'; axis.appendChild(t); } body.appendChild(axis);
      const band = document.createElement('div'); band.className = 'lband'; band.style.width = (2.5 / MAX * 100) + '%'; band.innerHTML = '<span>' + tt('Daily-trip zone · 2.5 km||نطاق المشاوير اليومية · 2.5 كم') + '</span>'; body.appendChild(band);
      L.forEach((row, ri) => { const lane = document.createElement('div'); lane.className = 'lane'; const lb = document.createElement('span'); lb.className = 'llb'; lb.textContent = tt(row[0]); lb.style.color = row[1]; lane.appendChild(lb);
        const tr = document.createElement('div'); tr.className = 'ltr'; let last = -9; row[2].forEach((d, i) => { const dot = document.createElement('button'); dot.className = 'ld' + (d[0] - last >= 1.0 ? ' lab' : ''); if (d[0] - last >= 1.0) last = d[0]; dot.style.setProperty('--c', row[1]); dot.style.left = (d[0] / MAX * 100) + '%'; dot.style.setProperty('--dd', (ri * 160 + i * 70 + 500) + 'ms'); dot.style.setProperty('--lv', (i % 2)); dot.innerHTML = '<i></i><u>' + tt(d[1]) + '<br><b>' + d[0].toFixed(2) + ' km</b></u>'; tr.appendChild(dot); }); lane.appendChild(tr); body.appendChild(lane); });
    }
    Mod.ladder = { enter() { build(); }, lang() { if ($('#ladder')) build(); } };
  })();

  /* bubble chart: distance vs GLA */
  (function () {
    const P = [
      ['The pin building||مبنى الموقع', 0, 20000, '#ffd27a', 'Visual estimate of footprint, about 15–25k m²||تقدير بصري لمساحة البصمة، نحو 15–25 ألف م²', 1],
      ['Listed "The Wave" plot||قطعة "ذا ويف" بالإعلانات', 0, 4250, '#e6e7e7', 'Broker listings: 4,250 m² plot, ground + 3||إعلانات الوسطاء: 4,250 م² أرض، أرضي + 3', 2],
      ['Cairo Festival City||كايرو فستيفال سيتي', 2.5, 160000, '#d9a441', '160,000 m² GLA, operator figure||160,000 م² مساحة تأجيرية، رقم المشغّل', 0],
      ['Downtown Katameya||داون تاون القطامية', 1.9, 34000, '#d9a441', '34,000 m² retail, operator site||34,000 م² تجزئة، موقع المشغّل', 0],
      ['Galleria (office-led)||جاليريا (مكاتب غالبًا)', 5.6, 18000, '#d9a441', '~18,000 m², converted largely to offices||نحو 18,000 م²، تحوّل أغلبه لمكاتب', 0],
      ['Point 90||بوينت 90', 6.0, 26289, '#d9a441', '26,289 m² GLA, broker figure||26,289 م² مساحة تأجيرية، رقم وسيط', 0],
      ['Eastown District||إيستاون ديستريكت', 8.1, 14765, '#d9a441', '14,765 m² GLA||14,765 م² مساحة تأجيرية', 0],
      ['Fifth Square (claimed)||فيفث سكوير (معلن)', 10.7, 68000, '#8f9bea', '68,000 m² claimed by a broker, sales stage||68,000 م² حسب وسيط، مرحلة البيع', 0]
    ];
    function build() {
      const w = 1000, h = 470, ml = 70, mb = 50, mt = 44, mr = 20; const sx = d => ml + d / 12 * (w - ml - mr), sy = g => h - mb - Math.sqrt(g) / Math.sqrt(180000) * (h - mb - mt); const rr = g => 6 + Math.sqrt(g) / Math.sqrt(160000) * 44;
      let s = '<svg viewBox="0 0 ' + w + ' ' + h + '" width="100%" role="img">';
      for (let k = 0; k <= 12; k += 2) s += '<line x1="' + sx(k) + '" x2="' + sx(k) + '" y1="' + mt + '" y2="' + (h - mb) + '" stroke="rgba(230,231,231,.08)"/><text x="' + sx(k) + '" y="' + (h - 22) + '" fill="#9fb0a7" font-size="13" text-anchor="middle">' + k + ' km</text>';
      [0, 50000, 100000, 150000].forEach(g => { s += '<line x1="' + ml + '" x2="' + (w - mr) + '" y1="' + sy(g) + '" y2="' + sy(g) + '" stroke="rgba(230,231,231,.08)"/><text x="' + (ml - 10) + '" y="' + (sy(g) + 4) + '" fill="#9fb0a7" font-size="13" text-anchor="end">' + (g / 1000) + 'k</text>'; });
      s += '<text x="' + (w / 2) + '" y="' + (h - 4) + '" fill="#6f7d76" font-size="12" text-anchor="middle">' + tt('Straight-line distance from the pin||المسافة الخطية من الموقع') + '</text>';
      P.forEach((p, i) => { const x = sx(p[1]), y = sy(p[2]), r = rr(p[2]); s += '<g class="bub" data-i="' + i + '" style="--dd:' + (i * 120 + 300) + 'ms;transform-origin:' + x + 'px ' + y + 'px"><circle cx="' + x + '" cy="' + y + '" r="' + r + '" fill="' + p[3] + '" fill-opacity="' + (p[6] === 2 ? '0' : '.22') + '" stroke="' + p[3] + '" stroke-width="2"' + (p[6] === 2 ? ' stroke-dasharray="5 4"' : '') + '/>' + (p[2] >= 14000 || p[6] ? '<text x="' + x + '" y="' + (y - r - 8) + '" fill="#e6e7e7" font-size="13" text-anchor="middle">' + tt(p[0]) + '</text>' : '') + '</g>'; });
      s += '</svg>'; const box = $('#bubble'); box.innerHTML = s;
      $$('.bub', box).forEach(g => { const p = P[+g.dataset.i]; tipOn(g, () => '<h4>' + tt(p[0]) + '</h4>' + tt(p[4]) + '<small>' + p[1].toFixed(1) + ' km · ' + fmt(p[2]) + ' m²</small>'); });
    }
    Mod.bubble = { enter() { build(); }, lang() { if ($('#bubble')) build(); } };
  })();

  /* competitor table */
  (function () {
    const R = [
      ['Cairo Festival City Mall||كايرو فستيفال سيتي مول', 2.5, '160,000', 'IKEA, Carrefour, 20 screens, 22M visits a year||إيكيا وكارفور و20 شاشة و22 مليون زيارة سنويًا', 'reg'],
      ['Downtown Katameya||داون تاون القطامية', 1.9, '34,000', 'Outdoor street: home, jewellery, luxury fashion||شارع مفتوح: أثاث ومجوهرات وأزياء فاخرة', 'dir'],
      ['One Ninety||ون ناينتي', 2.2, 'n/f', 'Offices, W and Aloft hotels, monorail station||مكاتب وفنادق W وAloft ومحطة مونوريل', 'dir'],
      ['G.OUT + local strip malls||جي أوت ومولات الحي', 1.5, 'n/f', 'Unbranded convenience retail||تجزئة يومية غير معروفة العلامة', 'dir'],
      ['Waterway Mall||ووتر واي مول', 5.0, 'n/f', 'F&B strip inside an admin district||شريط مطاعم داخل منطقة إدارية', 'ind'],
      ['Point 90 Mall||بوينت 90 مول', 6.0, '26,289', 'H&M, Starbucks; AUC crowd; reviewers call it quiet||H&M وستاربكس؛ جمهور الجامعة الأمريكية؛ زوار يصفونه بالهادئ', 'ind'],
      ['Eastown District||إيستاون ديستريكت', 8.1, '14,765', 'Boutique upscale: Seoudi, Nobu||راقٍ وبوتيك: سعودي ونوبو', 'ind'],
      ['Mivida Boulevard||ميفيدا بوليفارد', 10.3, 'conflicting', 'Open-air, multiplex, food court||مفتوح، سينما متعددة وفود كورت', 'reg'],
      ['Fifth Square||فيفث سكوير', 10.7, '68,000*', 'Sales stage; hyper + cinema claimed||مرحلة البيع؛ هايبر وسينما معلنة', 'reg']
    ]; let f = 'all';
    const F = [['all', 'All||الكل'], ['dir', 'Direct · ≤2.5 km||مباشر · حتى 2.5 كم'], ['ind', 'Indirect · 3–8 km||غير مباشر · 3–8 كم'], ['reg', 'Regional benchmarks||مراجع إقليمية']];
    function build() {
      const ch = $('#rvChips'); ch.innerHTML = ''; F.forEach(x => { const b = document.createElement('button'); b.className = 'chip' + (x[0] === f ? ' on' : ''); b.innerHTML = '<span></span>'; b.firstChild.textContent = tt(x[1]); b.onclick = () => { f = x[0]; build(); }; ch.appendChild(b); });
      const tb = $('#rvBody'); tb.innerHTML = ''; R.forEach(r => { const tr = document.createElement('tr'); if (f !== 'all' && r[5] !== f) tr.className = 'dim'; tr.innerHTML = '<td><b></b></td><td class="n">' + r[1].toFixed(1) + ' km</td><td class="n">' + (r[2] === 'n/f' ? tt('not found||غير متاح') : r[2].indexOf('conf') === 0 ? tt('conflicting||متضارب') : r[2] + ' m²') + '</td><td></td>'; $('b', tr).textContent = tt(r[0]); tr.lastChild.textContent = tt(r[3]); tb.appendChild(tr); });
    }
    Mod.rivals = { enter() { f = 'all'; build(); }, lang() { if ($('#rvBody')) build(); } };
  })();

  /* crowd: typewriter */
  (function () {
    const lines = ['Price per m²||السعر للمتر', '10-year installments||تقسيط 10 سنوات', '"Fixed price from the first unit to the last"||"سعر ثابت من أول وحدة لآخر وحدة"', '"Guaranteed return"||"عائد مضمون"', 'WhatsApp button||زر واتساب'];
    let tm;
    Mod.crowd = { enter() { const el = $('#typer'); clearTimeout(tm); el.innerHTML = ''; let i = 0, c = 0, cur = null; const step = () => { if (i >= lines.length) return; if (!cur) { cur = document.createElement('div'); cur.className = 'tl'; el.appendChild(cur); } const txt = tt(lines[i]); c++; cur.textContent = '› ' + txt.slice(0, c); if (c >= txt.length) { i++; c = 0; cur = null; tm = setTimeout(step, 450); } else tm = setTimeout(step, 38); }; tm = setTimeout(step, 1200); }, leave() { clearTimeout(tm); }, lang() { if ($('#s-crowd').classList.contains('active')) Mod.crowd.enter(); } };
  })();

  /* fork toggle */
  (function () {
    let mode = 'a';
    function set(m) { mode = m; const s = $('#s-fork'); s.dataset.mode = m; $$('#forkSw button', s).forEach(b => b.classList.toggle('on', b.dataset.m === m)); const on = $('#forkSw button.on'); const k = $('#forkSw .knob'); if (on && k) { k.style.width = on.offsetWidth + 'px'; k.style.insetInlineStart = on.offsetLeft + 'px'; } }
    Mod.fork = { enter() { $$('#forkSw button').forEach(b => b.onclick = () => set(b.dataset.m)); setTimeout(() => set('a'), 60); }, lang() { setTimeout(() => set(mode), 30); } };
  })();

  /* gaps checklist persistence */
  Mod.gaps = { enter(s) { $$('input[type=checkbox]:not([disabled])', s).forEach((c, i) => { c.checked = store.get('wm-gap-' + i) === '1'; c.onchange = () => { store.set('wm-gap-' + i, c.checked ? '1' : '0'); prog(); }; }); prog(); function prog() { const all = $$('input[type=checkbox]:not([disabled])', s), d = all.filter(x => x.checked).length; $('#gapProg').textContent = d + ' / ' + all.length; $('#gapBar').style.width = (d / all.length * 100) + '%'; } } };

  /* ---------- init ---------- */
  function init() {
    $('#menuBtn').onclick = () => toggleMenu(); $('#menu .x').onclick = () => toggleMenu(false); $$('#langSw button').forEach(b => b.onclick = () => setLang(b.dataset.l));
    try { Scene.init($('#scene'), $('#pins')); } catch (e) { console.warn('3D unavailable', e); document.body.classList.add('no3d'); }
    loadFilm(); applyLang(); buildNav();
    const h = location.hash.slice(1); let t = slides.find(s => s.id === h) || slides.find(s => s.id === 's-' + h);
    onScroll(); if (t && t.id !== 's-cover') { t.scrollIntoView({ behavior: 'auto', block: 'start' }); setTimeout(onScroll, 60); }
    setTimeout(() => $('#loader') && $('#loader').classList.add('gone'), 300);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
