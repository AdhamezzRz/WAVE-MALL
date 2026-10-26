/* The Wave · Leasing office. Small, dependency-free enhancements; every page works without them. */
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const csrf = $('meta[name=csrf]')?.content || '';
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
    const open = () => { box.hidden = false; input.value = ''; list.innerHTML = '<p>Type a name, a reference or a unit code.</p>'; setTimeout(() => input.focus(), 10); };
    const close = () => { box.hidden = true; };
    const paint = () => {
      list.innerHTML = items.length
        ? items.map((r, i) => `<a href="${esc(r.href)}" class="${i === on ? 'is-on' : ''}"><span>${esc(r.type)}</span><b>${esc(r.label)}</b><small>${esc(r.sub || '')}</small></a>`).join('')
        : `<p>Nothing matches “${esc(input.value)}”.</p>`;
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
      if (!q) { items = []; list.innerHTML = '<p>Type a name, a reference or a unit code.</p>'; return; }
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
        if (!r.ok || !j.ok) throw new Error(j.error || 'Could not move this lead.');
        toast(`Moved to ${j.label}.`);
      } catch (err) {
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
    const money = (n) => (Number.isFinite(n) && n ? `${cur} ${fmt(n)}` : '—');
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

      out('area').textContent = indoor ? `${fmt(indoor)} m²${terraceA ? ` + ${fmt(terraceA)} terrace` : ''}` : '—';
      out('month').textContent = money(month);
      out('annual').textContent = money(month * 12);
      out('service').textContent = money(serviceY);
      out('deposit').textContent = money(month * val('deposit'));
      out('total').textContent = money(total);
      out('eff').textContent = eff ? `${cur} ${eff.toFixed(0)}` : '—';
      const d = out('disc');
      d.textContent = disc === null ? '—' : `${disc > 0 ? '+' : ''}${disc.toFixed(1)}%`;
      d.className = disc === null ? '' : disc < -0.05 ? 'down' : 'up';
      out('approval').hidden = !(list && rent && rent < list * (1 - maxDisc / 100));
      const top = Math.max(...years.map((y) => y.r), 1);
      out('years').innerHTML = month
        ? years.map((y) => `<p><span>Year ${y.y}</span><i style="width:${((y.r / top) * 100).toFixed(1)}%"></i><b>${fmt(y.r)}${y.free ? ` <small class="muted">· ${y.free} mo free</small>` : ''}</b></p>`).join('')
        : '';
    };
    offer.addEventListener('input', calc);
    offer.addEventListener('change', calc);
    calc();
  }

  // ---------- small conveniences ----------
  // Select-all for lists with checkboxes, and auto-submit filters.
  $$('[data-autosubmit]').forEach((el) => el.addEventListener('change', () => el.form?.requestSubmit()));
  $$('select[data-nav]').forEach((s) => s.addEventListener('change', () => { if (s.value) location.href = s.value; }));
})();
