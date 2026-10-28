/* The Wave · Leasing office. Small, dependency-free enhancements; every page works without them. */
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const csrf = $('meta[name=csrf]')?.content || '';
  const AR = document.body.dataset.lang === 'ar';
  const STR = {
    hint: ['Type a name, a reference or a unit code.', 'اكتب اسمًا أو رقمًا مرجعيًا أو رمز وحدة.'],
    none: ['Nothing matches “{q}”.', 'لا توجد نتائج لـ «{q}».'],
    moveFail: ['Could not move this lead.', 'تعذّر نقل هذه الفرصة.'],
    moved: ['Moved to {s}.', 'نُقلت إلى مرحلة «{s}».'],
    terrace: ['{n} terrace', 'تراس {n} م²'],
    m2: ['m²', 'م²'],
    year: ['Year {n}', 'السنة {n}'],
    free: ['{n} mo free', '{n} شهر مجاني'],
    offline: ['No connection. Try again.', 'لا يوجد اتصال. حاول مرة أخرى.'],
    uploading: ['Uploading… {p}%', 'جارٍ الرفع… {p}%'],
    uploaded: ['Uploaded. Refreshing…', 'تم الرفع. جارٍ التحديث…'],
    uploadFail: ['Upload failed. Try again.', 'تعذّر الرفع. حاول مرة أخرى.'],
    tooBig: ['That file is larger than 25 MB.', 'حجم الملف أكبر من 25 ميجابايت.'],
  };
  const tr = (k, p = {}) => STR[k][AR ? 1 : 0].replace(/\{(\w+)\}/g, (m, x) => (p[x] ?? m));
  // Arabic counted months: شهر واحد مجاني، شهران مجانيان، 3 أشهر مجانية، 12 شهرًا مجانيًا
  const freeAr = (n) => (n === 1 ? 'شهر مجاني' : n === 2 ? 'شهران مجانيان' : n >= 3 && n <= 10 ? `${n} أشهر مجانية` : `${n} شهرًا مجانيًا`);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  // ---------- toast ----------
  function toast(text, type = 'ok') {
    $$('[data-toast]').forEach((t) => t.remove());
    const t = document.createElement('div');
    t.className = `toast toast--${type}`;
    t.setAttribute('role', 'status');
    t.dataset.toast = '';
    t.innerHTML = `<span>${esc(text)}</span>`;
    document.body.append(t);
    hide(t);
  }
  function hide(t) {
    setTimeout(() => { t.classList.add('is-out'); setTimeout(() => t.remove(), 350); }, 4200);
  }
  $$('[data-toast]').forEach(hide);

  // ---------- sidebar on small screens ----------
  $$('[data-side-toggle]').forEach((b) => b.addEventListener('click', (e) => {
    e.stopPropagation();
    document.body.classList.toggle('side-open');
  }));
  document.addEventListener('click', (e) => {
    if (document.body.classList.contains('side-open') && !e.target.closest('[data-side]')) document.body.classList.remove('side-open');
  });

  // ---------- clickable rows and cards ----------
  document.addEventListener('click', (e) => {
    const row = e.target.closest('tr[data-href], .kcard[data-href]');
    if (!row || e.target.closest('a, button, input, select, textarea, label, form, summary')) return;
    if (e.metaKey || e.ctrlKey) window.open(row.dataset.href, '_blank');
    else location.href = row.dataset.href;
  });

  // ---------- confirmations and print ----------
  document.addEventListener('submit', (e) => {
    const f = e.target;
    const msg = f.dataset.confirm || e.submitter?.dataset.confirm;
    if (msg && !confirm(msg)) { e.preventDefault(); return; }
    // Avoid double submits.
    if (f.method === 'post' && !e.defaultPrevented) {
      setTimeout(() => $$('button[type=submit], button:not([type])', f).forEach((b) => { b.disabled = true; }), 0);
    }
  });
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-confirm], button[data-confirm]:not([type=submit])');
    if (a && !confirm(a.dataset.confirm)) e.preventDefault();
    if (e.target.closest('[data-print]')) { e.preventDefault(); window.print(); }
  });

  // ---------- ⌘K search ----------
  const box = $('[data-cmdk]');
  if (box) {
    const input = $('[data-cmdk-input]', box);
    const list = $('[data-cmdk-list]', box);
    let items = [];
    let on = 0;
    let timer;
    let seq = 0;
    const open = () => { box.hidden = false; input.value = ''; list.innerHTML = `<p>${esc(tr('hint'))}</p>`; setTimeout(() => input.focus(), 10); };
    const close = () => { box.hidden = true; };
    const paint = () => {
      list.innerHTML = items.length
        ? items.map((r, i) => `<a href="${esc(r.href)}" class="${i === on ? 'is-on' : ''}"><span>${esc(r.type)}</span><b>${esc(r.label)}</b><small>${esc(r.sub || '')}</small></a>`).join('')
        : `<p>${esc(tr('none', { q: input.value }))}</p>`;
    };
    $$('[data-cmdk-open]').forEach((b) => b.addEventListener('click', open));
    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); box.hidden ? open() : close(); }
      else if (e.key === '/' && box.hidden && !e.target.closest('input, textarea, select, [contenteditable]')) { e.preventDefault(); open(); }
      else if (e.key === 'Escape' && !box.hidden) close();
    });
    box.addEventListener('click', (e) => { if (e.target === box) close(); });
    input.addEventListener('input', () => {
      clearTimeout(timer);
      const q = input.value.trim();
      if (!q) { items = []; list.innerHTML = `<p>${esc(tr('hint'))}</p>`; return; }
      timer = setTimeout(async () => {
        const mine = ++seq;
        try {
          const r = await fetch(`/admin/search?q=${encodeURIComponent(q)}`, { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
          if (mine !== seq) return;
          items = r.ok ? await r.json() : [];
        } catch { items = []; }
        on = 0;
        paint();
      }, 140);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!items.length) return;
        on = (on + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        paint();
        $('.is-on', list)?.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter' && items[on]) {
        location.href = items[on].href;
      }
    });
  }

  // ---------- pipeline: drag and drop between stages ----------
  const board = $('[data-kanban]');
  if (board) {
    let drag = null;
    let from = null;
    const recount = () => $$('.kcol', board).forEach((c) => { $('[data-count]', c).textContent = $$('.kcard', c).length; });
    board.addEventListener('dragstart', (e) => {
      drag = e.target.closest('.kcard[draggable=true]');
      if (!drag) return;
      from = drag.parentElement;
      drag.classList.add('is-drag');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', drag.dataset.id);
    });
    board.addEventListener('dragend', () => {
      drag?.classList.remove('is-drag');
      $$('.is-over', board).forEach((x) => x.classList.remove('is-over'));
    });
    board.addEventListener('dragover', (e) => {
      const list = e.target.closest('[data-drop]');
      if (!drag || !list) return;
      e.preventDefault();
      $$('.is-over', board).forEach((x) => x !== list && x.classList.remove('is-over'));
      list.classList.add('is-over');
    });
    board.addEventListener('dragleave', (e) => {
      const list = e.target.closest('[data-drop]');
      if (list && !list.contains(e.relatedTarget)) list.classList.remove('is-over');
    });
    board.addEventListener('drop', async (e) => {
      const list = e.target.closest('[data-drop]');
      if (!drag || !list) return;
      e.preventDefault();
      list.classList.remove('is-over');
      if (list === from) return;
      const card = drag;
      const back = from;
      const stage = list.closest('[data-stage]').dataset.stage;
      list.prepend(card);
      recount();
      try {
        const r = await fetch(`/admin/leads/${card.dataset.id}/stage`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRF': csrf },
          body: JSON.stringify({ stage }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.ok) throw new Error(j.error || tr('moveFail'));
        toast(tr('moved', { s: j.label }));
      } catch (err) {
        if (err instanceof TypeError) err = new Error(tr('offline'));
        back.prepend(card);
        recount();
        toast(err.message, 'error');
      }
    });
  }

  // ---------- the plan: tooltips and links ----------
  $$('[data-plan]').forEach((wrap) => {
    const tip = $('[data-plan-tip]', wrap);
    const svg = $('svg', wrap);
    $$('[data-focus]', document).forEach((code) => {
      const u = $(`[data-code="${code.dataset.focus}"]`, wrap);
      if (u) u.setAttribute('data-focus', '');
    });
    wrap.addEventListener('mousemove', (e) => {
      const u = e.target.closest('[data-tip]');
      if (!u) { tip.hidden = true; return; }
      const box = wrap.getBoundingClientRect();
      tip.textContent = u.dataset.tip;
      tip.style.left = `${e.clientX - box.left}px`;
      tip.style.top = `${e.clientY - box.top}px`;
      tip.hidden = false;
    });
    wrap.addEventListener('mouseleave', () => { tip.hidden = true; });
    svg?.addEventListener('click', (e) => {
      const u = e.target.closest('[data-href]');
      if (u) location.href = u.dataset.href;
    });
  });

  // ---------- unit picks ----------
  $$('.pick input').forEach((i) => i.addEventListener('change', () => i.closest('.pick').classList.toggle('is-on', i.checked)));

  // ---------- the offer calculator (mirrors model.schedule) ----------
  const offer = $('[data-offer]');
  if (offer) {
    const cur = offer.dataset.cur || 'EGP';
    const maxDisc = Number(offer.dataset.maxDiscount) || 0;
    const fmt = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '—');
    const money = (n) => (Number.isFinite(n) && n ? (AR ? `${fmt(n)} ${cur}` : `${cur} ${fmt(n)}`) : '—');
    const val = (k) => {
      const el = $(`[data-calc="${k}"]`, offer);
      const n = parseFloat(el?.value);
      return Number.isFinite(n) ? n : 0;
    };
    const out = (k) => $(`[data-o="${k}"]`, offer);
    const calc = () => {
      const units = $$('.pick input:checked', offer);
      const indoor = units.reduce((t, u) => t + (+u.dataset.indoor || 0), 0);
      const terraceA = units.reduce((t, u) => t + (+u.dataset.terrace || 0), 0);
      const rent = val('rent');
      const terrace = val('terrace');
      const service = val('service');
      const term = Math.max(1, Math.round(val('term')) || 1);
      const esc_ = val('esc');
      const free = val('free');
      const month = indoor * rent + terraceA * terrace;
      const years = [];
      let totalRent = 0;
      for (let y = 0; y < term; y++) {
        const f = (1 + esc_ / 100) ** y;
        const freeY = Math.max(0, Math.min(12, free - y * 12));
        const r = month * f * (12 - freeY);
        years.push({ y: y + 1, r, free: freeY });
        totalRent += r;
      }
      const serviceY = indoor * service * 12;
      const total = totalRent + serviceY * term + val('key');
      const weighted = indoor + terraceA * (terrace / (rent || 1));
      const eff = weighted ? totalRent / (term * 12) / weighted : 0;
      const lists = units.map((u) => parseFloat(u.dataset.list)).filter(Number.isFinite);
      const list = lists.length ? Math.max(...lists) : 0;
      const disc = list && rent ? (rent / list - 1) * 100 : null;

      out('area').textContent = indoor ? `${fmt(indoor)} ${tr('m2')}${terraceA ? ` + ${tr('terrace', { n: fmt(terraceA) })}` : ''}` : '—';
      out('month').textContent = money(month);
      out('annual').textContent = money(month * 12);
      out('service').textContent = money(serviceY);
      out('deposit').textContent = money(month * val('deposit'));
      out('total').textContent = money(total);
      out('eff').textContent = eff ? money(eff) : '—';
      const d = out('disc');
      d.textContent = disc === null ? '—' : `${disc > 0 ? '+' : ''}${disc.toFixed(1)}%`;
      d.className = disc === null ? '' : disc < -0.05 ? 'down' : 'up';
      out('approval').hidden = !(list && rent && rent < list * (1 - maxDisc / 100));
      const top = Math.max(...years.map((y) => y.r), 1);
      out('years').innerHTML = month
        ? years.map((y) => `<p><span>${esc(tr('year', { n: y.y }))}</span><i style="width:${((y.r / top) * 100).toFixed(1)}%"></i><b>${fmt(y.r)}${y.free ? ` <small class="muted">· ${esc(AR ? freeAr(y.free) : tr('free', { n: y.free }))}</small>` : ''}</b></p>`).join('')
        : '';
    };
    offer.addEventListener('input', calc);
    offer.addEventListener('change', calc);
    calc();
  }

  // ---------- document uploads (routes/files.js) ----------
  // The file is sent as the request body with its details in the query string, so no form encoding
  // is needed and a progress bar can follow it.
  const MAX = 25 * 1024 * 1024;
  function send(url, file, { onProgress } = {}) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open('POST', url);
      x.setRequestHeader('X-CSRF', csrf);
      x.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
      x.setRequestHeader('Accept', 'application/json');
      x.setRequestHeader('Content-Type', 'application/octet-stream');
      x.upload.onprogress = (e) => e.lengthComputable && onProgress && onProgress(Math.round((e.loaded / e.total) * 100));
      x.onload = () => {
        let j = {};
        try { j = JSON.parse(x.responseText); } catch { /* not JSON */ }
        if (x.status < 300 && j.ok) resolve(j);
        else reject(new Error(j.error || tr('uploadFail')));
      };
      x.onerror = () => reject(new Error(tr('offline')));
      x.send(file);
    });
  }
  $$('[data-upload]').forEach((f) => {
    const input = $('input[type=file]', f);
    const drop = $('.drop', f);
    const msg = $('[data-upload-msg]', f);
    const bar = $('.drop__bar', f);
    const say = (text, bad) => { msg.hidden = !text; msg.textContent = text || ''; msg.classList.toggle('is-bad', !!bad); };
    const go = async (file) => {
      if (!file) return;
      if (file.size > MAX) return say(tr('tooBig'), true);
      const q = new URLSearchParams();
      for (const el of f.elements) if (el.name && el.type !== 'file' && (el.type !== 'checkbox' || el.checked) && el.value) q.set(el.name, el.value);
      f.classList.add('is-busy');
      bar.hidden = false;
      try {
        await send(`${f.dataset.upload}&${q}`, file, { onProgress: (p) => { say(tr('uploading', { p })); $('b', bar).style.width = `${p}%`; } });
        say(tr('uploaded'));
        location.reload();
      } catch (err) {
        f.classList.remove('is-busy');
        bar.hidden = true;
        say(err.message, true);
      }
    };
    input.addEventListener('change', () => go(input.files[0]));
    ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('is-over'); }));
    ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, () => drop.classList.remove('is-over')));
    drop.addEventListener('drop', (e) => { e.preventDefault(); go(e.dataTransfer.files[0]); });
    f.addEventListener('submit', (e) => e.preventDefault());
  });
  // "Upload a new version" on a document row: same record, replaces the old file (kept in history).
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-replace]');
    if (!b) return;
    const panel = b.closest('.docs');
    const base = panel && $('[data-upload]', panel);
    if (!base) return;
    const pick = document.createElement('input');
    pick.type = 'file';
    pick.accept = $('input[type=file]', base).accept;
    pick.onchange = async () => {
      const file = pick.files[0];
      if (!file) return;
      if (file.size > MAX) return toast(tr('tooBig'), 'error');
      b.disabled = true;
      try {
        await send(`${base.dataset.upload}&replaces=${encodeURIComponent(b.dataset.replace)}`, file, { onProgress: (p) => { b.title = tr('uploading', { p }); } });
        location.reload();
      } catch (err) {
        b.disabled = false;
        toast(err.message, 'error');
      }
    };
    pick.click();
  });

  // ---------- small conveniences ----------
  // Select-all for lists with checkboxes, and auto-submit filters.
  $$('[data-autosubmit]').forEach((el) => el.addEventListener('change', () => el.form?.requestSubmit()));
  $$('select[data-nav]').forEach((s) => s.addEventListener('change', () => { if (s.value) location.href = s.value; }));
})();

/* ---------- HR: live net pay on a draft payroll (routes/hr.js) ----------
   Each row carries basic, allowances, the employee insurance share and the daily rate; typing
   overtime, bonus, unpaid days, deductions or tax updates that row's net before saving. */
(() => {
  'use strict';
  const form = document.querySelector('[data-payroll]');
  if (!form) return;
  const fmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
  const val = (row, name) => {
    const el = row.querySelector(`input[name^="${name}_"]`);
    const n = parseFloat(el && el.value);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  const calc = (row) => {
    const d = row.dataset;
    const net = (+d.basic || 0) + (+d.allow || 0) + val(row, 'overtime') + val(row, 'bonus') - val(row, 'deductions') - (+d.daily || 0) * val(row, 'unpaid_days') - (+d.ins || 0) - val(row, 'tax');
    const out = row.querySelector('[data-net]');
    if (out) {
      out.textContent = fmt.format(Math.round(net));
      out.classList.toggle('late', net < 0);
    }
  };
  form.addEventListener('input', (e) => {
    const row = e.target.closest('[data-payrow]');
    if (row) calc(row);
  });
})();

/* ---------- mobile app ---------- */
/* The phone app shell (≤ 860px): the "More" sheet, search from the tab bar, the floating main action,
   long forms that keep their button in reach, pull-to-refresh in the installed app, and a light
   touch of haptics. Everything here is an enhancement: the shell works without script. */
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const phone = () => window.matchMedia('(max-width: 860px)').matches;
  const buzz = (ms = 8) => { try { if (phone() && navigator.vibrate) navigator.vibrate(ms); } catch { /* not supported */ } };
  if (!document.body.classList.contains('has-tabbar')) return;

  // ---------- the "More" sheet ----------
  const sheet = $('[data-more]');
  if (sheet) {
    let pushed = false;
    const shut = () => { sheet.classList.remove('is-open'); document.body.classList.remove('sheet-open'); };
    const open = () => {
      sheet.classList.add('is-open');
      document.body.classList.add('sheet-open');
      if (location.hash !== '#more') { history.pushState({ more: 1 }, '', '#more'); pushed = true; }
    };
    const close = () => {
      shut();
      if (pushed) { pushed = false; history.back(); }
      else if (location.hash === '#more') location.replace('#close'); // opened without script (:target)
    };
    if (location.hash === '#more') { sheet.classList.add('is-open'); document.body.classList.add('sheet-open'); }
    $$('[data-more-open]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); buzz(); open(); }));
    $$('[data-more-close]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); close(); }));
    window.addEventListener('popstate', () => { if (location.hash !== '#more') { pushed = false; shut(); } });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && sheet.classList.contains('is-open')) close(); });
    // swipe the sheet down to close it
    const panel = $('[data-sheet-panel]', sheet);
    let y0 = null;
    let dy = 0;
    panel.addEventListener('touchstart', (e) => { if (panel.scrollTop > 0) return; y0 = e.touches[0].clientY; dy = 0; panel.style.transition = 'none'; }, { passive: true });
    panel.addEventListener('touchmove', (e) => { if (y0 === null) return; dy = Math.max(0, e.touches[0].clientY - y0); panel.style.transform = `translateY(${dy}px)`; }, { passive: true });
    panel.addEventListener('touchend', () => {
      if (y0 === null) return;
      panel.style.transition = '';
      panel.style.transform = '';
      if (dy > 90) close();
      y0 = null;
    });
  }

  // ---------- tab bar: search opens the search screen; a light tap on every tab ----------
  $$('.tabbar__a').forEach((a) => a.addEventListener('click', () => buzz(6)));
  $$('a[data-cmdk-open]').forEach((a) => a.addEventListener('click', (e) => e.preventDefault()));
  const box = $('[data-cmdk]');
  $$('[data-cmdk-close]').forEach((b) => b.addEventListener('click', () => { if (box) box.hidden = true; }));

  // ---------- the page's main action floats above the tab bar ----------
  const fab = $('.bar__actions .btn--primary');
  if (fab) fab.classList.add('is-fab');

  // ---------- long forms keep their button in reach ----------
  const markLong = () => $$('main form').forEach((f) => {
    const last = f.lastElementChild;
    const submit = !!last && (last.matches('.btn--primary, button[type=submit]') || (last.matches('.row') && !!last.querySelector('.btn--primary')));
    f.classList.toggle('form--sticky', submit && phone() && f.offsetHeight > window.innerHeight * 0.9);
  });
  markLong();
  window.addEventListener('resize', markLong);

  // ---------- pull to refresh, in the installed app (browsers have their own) ----------
  const installed = document.documentElement.classList.contains('is-app') || window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  const ind = $('[data-ptr]');
  if (installed && ind) {
    let dirty = false;
    document.addEventListener('input', (e) => { if (e.target.closest('main form')) dirty = true; });
    const blocked = (t) => dirty || document.body.classList.contains('sheet-open') || (box && !box.hidden)
      || !!t.closest('input, textarea, select, [contenteditable], .kanban, .tablewrap, .plan-wrap, details[open], [data-no-ptr]');
    let start = null;
    let pull = 0;
    let armed = false;
    const reset = () => { ind.style.opacity = ''; ind.style.transform = ''; ind.classList.remove('is-armed'); };
    window.addEventListener('touchstart', (e) => {
      start = window.scrollY <= 0 && e.touches.length === 1 && !blocked(e.target) ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
      pull = 0;
      armed = false;
    }, { passive: true });
    window.addEventListener('touchmove', (e) => {
      if (!start) return;
      const dy = e.touches[0].clientY - start.y;
      const dx = e.touches[0].clientX - start.x;
      if (Math.abs(dx) > Math.abs(dy) || dy <= 0) { if (dy < 0) { start = null; reset(); } return; }
      pull = Math.min(120, dy * 0.5);
      ind.style.opacity = String(Math.min(1, pull / 48));
      ind.style.transform = `translateY(${pull + 44}px)`;
      const a = pull > 64;
      if (a && !armed) buzz(6);
      armed = a;
      ind.classList.toggle('is-armed', a);
    }, { passive: true });
    window.addEventListener('touchend', () => {
      if (!start) return;
      start = null;
      if (armed) {
        ind.classList.add('is-busy');
        ind.style.transform = 'translateY(96px)';
        buzz(10);
        location.reload();
      } else reset();
      armed = false;
    });
  }
})();

// ---------- Deal communication (routes/comms.js) ----------
// Copy buttons, setting names that select on focus, quick replies into the composer, the inbox
// opening at the newest message, Enter to send, and WhatsApp click-to-chat forms (they open in a
// new tab; this page then reloads to show the message it logged).
(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-copy]');
    if (!b) return;
    const src = $('[data-copy-src]', b.closest('.copyfield') || document);
    if (!src) return;
    src.select();
    const done = () => { b.classList.add('is-done'); setTimeout(() => b.classList.remove('is-done'), 1600); };
    if (navigator.clipboard) navigator.clipboard.writeText(src.value).then(done, () => { document.execCommand('copy'); done(); });
    else { document.execCommand('copy'); done(); }
  });
  $$('[data-select]').forEach((el) => el.addEventListener('focus', () => el.select()));
  $$('[data-snippet]').forEach((sel) => sel.addEventListener('change', () => {
    const box = $('[data-composer]', sel.closest('form'));
    if (box && sel.value) {
      box.value = box.value ? `${box.value.trimEnd()}\n${sel.value}` : sel.value;
      box.dispatchEvent(new Event('input'));
      box.focus();
    }
    sel.value = '';
  }));
  const body = $('[data-convbody]');
  if (body) {
    body.scrollTop = body.scrollHeight;
    if (window.matchMedia('(max-width: 860px)').matches) window.scrollTo(0, document.documentElement.scrollHeight);
  }
  $$('textarea[data-composer]').forEach((t) => {
    const grow = () => { t.style.height = 'auto'; t.style.height = `${Math.min(180, t.scrollHeight + 2)}px`; };
    t.addEventListener('input', grow);
    // Enter sends a chat message (Shift+Enter for a new line); emails keep Enter for new lines
    if (!t.form.querySelector('[name=subject]')) {
      t.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && window.matchMedia('(hover: hover)').matches && t.value.trim()) { e.preventDefault(); t.form.requestSubmit(); }
      });
    }
  });
  // the lead's quick message: only WhatsApp opens in a new tab
  $$('form[data-wa-maybe]').forEach((f) => f.addEventListener('submit', () => {
    const wa = f.elements.channel && f.elements.channel.value === 'whatsapp';
    if (wa) { f.target = '_blank'; setTimeout(() => location.reload(), 1200); } else f.removeAttribute('target');
  }));
  $$('form[data-wa]').forEach((f) => f.addEventListener('submit', () => {
    setTimeout(() => {
      $$('button', f).forEach((x) => { x.disabled = false; });
      location.reload();
    }, 1200);
  }));
})();

// ===================== operations: short-term space booking (OPS) =====================
(() => {
  // empty calendar days open a new booking for that space and date
  document.addEventListener('click', (e) => {
    const cell = e.target.closest('[data-book]');
    if (cell && !e.target.closest('a')) location.href = cell.dataset.book;
  });
  // the booking form: live price from the rate card, clashes, discount approval
  const box = document.querySelector('[data-spc-quote]');
  if (!box) return;
  const form = box.closest('form');
  const el = (k) => box.querySelector(`[data-spc="${k}"]`);
  const out = (k) => box.querySelector(`[data-q="${k}"]`);
  const csrf = document.querySelector('meta[name="csrf"]')?.content || '';
  const share = el('share')?.closest('.spc-share');
  const deposit = el('deposit');
  let depositTouched = false;
  deposit?.addEventListener('input', () => { depositTouched = true; });
  let timer = null;
  let seq = 0;
  const syncSpace = () => {
    const opt = el('space')?.selectedOptions[0];
    if (!opt) return;
    if (share) share.hidden = opt.dataset.shared !== '1';
    if (deposit && !depositTouched && !box.dataset.exclude) deposit.value = opt.dataset.deposit || 0;
  };
  const show = (k, text) => { const o = out(k); if (o) { o.textContent = text || ''; o.hidden = !text; } };
  const run = async () => {
    const mine = ++seq;
    const body = {
      space_id: el('space')?.value, start_date: el('start')?.value, end_date: el('end')?.value,
      share_pct: el('share')?.value, price: el('price')?.value, exclude: box.dataset.exclude || '',
    };
    try {
      const r = await fetch(box.dataset.spcQuote, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', 'x-csrf': csrf }, body: JSON.stringify(body) });
      const q = await r.json();
      if (mine !== seq) return;
      for (const k of ['days', 'rate', 'weekend', 'peak', 'total', 'disc']) { const o = out(k); if (o) o.textContent = q.ok ? q[k] : '—'; }
      show('error', q.ok ? '' : q.error);
      show('clash', q.ok ? q.clash : '');
      const ap = out('approval');
      if (ap) ap.hidden = !(q.ok && q.approval);
    } catch { /* offline: the server checks again on save */ }
  };
  const later = () => { clearTimeout(timer); timer = setTimeout(run, 250); };
  form?.addEventListener('input', later);
  form?.addEventListener('change', (e) => { if (e.target === el('space')) syncSpace(); later(); });
  syncSpace();
  run();
})();

/* ===== Revenue (routes/revenue.js): a CSV file chosen beside a paste box fills the box ===== */
document.addEventListener('change', (e) => {
  const inp = e.target.closest && e.target.closest('input[type=file][data-csv-into]');
  if (!inp || !inp.files || !inp.files[0]) return;
  const box = inp.form && inp.form.querySelector(`textarea[name="${inp.dataset.csvInto}"]`);
  if (!box) return;
  const r = new FileReader();
  r.onload = () => { box.value = String(r.result || '').replace(/^﻿/, ''); box.focus(); };
  r.readAsText(inp.files[0]);
});

/* ===== Accounting (routes/accounting.js): journal lines that balance as you type, budget totals ===== */
(() => {
  'use strict';
  const AR = document.body.dataset.lang === 'ar';
  const nf = new Intl.NumberFormat(AR ? 'ar-EG-u-nu-latn' : 'en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const val = (i) => { const n = Number(String(i?.value || '').replace(/,/g, '')); return Number.isFinite(n) ? n : 0; };
  for (const table of document.querySelectorAll('table[data-je], table[data-bill]')) {
    const form = table.closest('form');
    const body = table.tBodies[0];
    const status = form?.querySelector('[data-je-status]');
    const isEntry = table.hasAttribute('data-je');
    const sum = () => {
      let dr = 0;
      let cr = 0;
      for (const r of body.rows) { dr += val(r.querySelector('[data-je-debit]')); cr += val(r.querySelector('[data-je-credit]')); }
      dr = Math.round(dr * 100) / 100;
      cr = Math.round(cr * 100) / 100;
      const d = table.querySelector('[data-je-dr]');
      const c = table.querySelector('[data-je-cr]');
      if (d) d.textContent = nf.format(dr);
      if (c) c.textContent = nf.format(cr);
      if (status && isEntry) {
        const ok = dr > 0 && Math.abs(dr - cr) < 0.005;
        status.className = `acc-je__status ${ok ? 'is-ok' : dr || cr ? 'is-off' : ''}`;
        status.textContent = ok ? status.dataset.ok : dr || cr ? status.dataset.off.replace('{n}', nf.format(Math.abs(dr - cr))) : '';
      }
    };
    table.addEventListener('input', (e) => {
      // a line is a debit or a credit: typing one clears the other
      const row = e.target.closest('tr');
      if (isEntry && row && e.target.matches('[data-je-debit], [data-je-credit]') && val(e.target)) {
        const other = row.querySelector(e.target.matches('[data-je-debit]') ? '[data-je-credit]' : '[data-je-debit]');
        if (other) other.value = '';
      }
      sum();
    });
    table.addEventListener('click', (e) => {
      if (e.target.closest('[data-je-add]')) {
        const last = body.rows[body.rows.length - 1];
        const row = last.cloneNode(true);
        row.querySelectorAll('input').forEach((i) => { i.value = ''; });
        row.querySelectorAll('select').forEach((s) => { s.selectedIndex = 0; });
        body.append(row);
        row.querySelector('select')?.focus();
      }
      const rm = e.target.closest('[data-je-remove]');
      if (rm && body.rows.length > 2) { rm.closest('tr').remove(); sum(); }
    });
    // the last line takes the difference when you tab into it empty
    if (isEntry) {
      table.addEventListener('focusin', (e) => {
        if (!e.target.matches('[data-je-debit], [data-je-credit]') || e.target.value) return;
        const row = e.target.closest('tr');
        if (row.querySelector('[data-je-debit]').value || row.querySelector('[data-je-credit]').value) return;
        let dr = 0;
        let cr = 0;
        for (const r of body.rows) { dr += val(r.querySelector('[data-je-debit]')); cr += val(r.querySelector('[data-je-credit]')); }
        const diff = Math.round((dr - cr) * 100) / 100;
        if (diff > 0 && e.target.matches('[data-je-credit]')) e.target.value = diff.toFixed(2);
        if (diff < 0 && e.target.matches('[data-je-debit]')) e.target.value = (-diff).toFixed(2);
        sum();
      });
    }
    sum();
  }
  // budget grid: the year total of each row follows the months
  const grid = document.querySelector('.acc-budget');
  if (grid) {
    grid.addEventListener('input', (e) => {
      const id = e.target.dataset?.bud;
      if (!id) return;
      let t = 0;
      grid.querySelectorAll(`[data-bud="${id}"]`).forEach((i) => { t += val(i); });
      const cell = grid.querySelector(`[data-bud-total="${id}"]`);
      if (cell) cell.textContent = nf.format(t);
    });
  }
  // statement import: keep the chosen file's name (the revenue handler above fills the box)
  document.addEventListener('change', (e) => {
    const inp = e.target.closest && e.target.closest('input[type=file][data-csv-into]');
    const name = inp && inp.form && inp.form.querySelector('[data-csv-name]');
    if (name && inp.files && inp.files[0]) name.value = inp.files[0].name;
  });
})();
/* ===== end accounting ===== */
