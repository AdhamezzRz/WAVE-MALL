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
