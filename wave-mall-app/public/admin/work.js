// The work hub (/admin/work): drag tasks between the board's columns, select rows for bulk actions,
// and suggest names after "@" in comments. Every page works without it (forms do the same).
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const csrf = $('meta[name=csrf]')?.content || '';
  const ar = document.documentElement.lang === 'ar';
  const T = {
    moved: ar ? 'نُقلت إلى «{s}»' : 'Moved to {s}',
    fail: ar ? 'تعذّر النقل. حاول مرة أخرى.' : 'Could not move it. Try again.',
    offline: ar ? 'لا يوجد اتصال بالإنترنت.' : 'You are offline.',
  };
  const toast = (text, type = 'ok') => {
    $$('[data-toast]').forEach((t) => t.remove());
    const t = document.createElement('div');
    t.className = `toast toast--${type}`;
    t.setAttribute('role', 'status');
    t.dataset.toast = '';
    t.textContent = text;
    document.body.append(t);
    setTimeout(() => { t.classList.add('is-out'); setTimeout(() => t.remove(), 400); }, 3200);
  };

  // ---------- board: drag and drop ----------
  const board = $('[data-wk-board]');
  if (board) {
    let drag = null;
    let from = null;
    const recount = () => $$('[data-wk-lane]', board).forEach((lane) => {
      const n = $$('.wk-card', lane).length;
      const c = $('[data-wk-count]', lane);
      if (c) c.textContent = n;
      const empty = $('.wk-lane__empty', lane);
      if (empty) empty.hidden = n > 0;
    });
    board.addEventListener('dragstart', (e) => {
      drag = e.target.closest('.wk-card[draggable=true]');
      if (!drag) return;
      from = drag.parentElement;
      drag.classList.add('is-drag');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', drag.dataset.wkTask);
    });
    board.addEventListener('dragend', () => {
      drag?.classList.remove('is-drag');
      $$('.is-over', board).forEach((x) => x.classList.remove('is-over'));
      drag = null;
    });
    board.addEventListener('dragover', (e) => {
      const list = e.target.closest('[data-wk-drop]');
      if (!drag || !list) return;
      e.preventDefault();
      $$('.is-over', board).forEach((x) => x !== list && x.classList.remove('is-over'));
      list.classList.add('is-over');
    });
    board.addEventListener('dragleave', (e) => {
      const list = e.target.closest('[data-wk-drop]');
      if (list && !list.contains(e.relatedTarget)) list.classList.remove('is-over');
    });
    board.addEventListener('drop', async (e) => {
      const list = e.target.closest('[data-wk-drop]');
      if (!drag || !list) return;
      e.preventDefault();
      list.classList.remove('is-over');
      if (list === from) return;
      const card = drag;
      const back = from;
      const status = list.closest('[data-wk-lane]').dataset.wkLane;
      list.prepend(card);
      card.classList.toggle('is-done', status === 'done');
      recount();
      try {
        const r = await fetch(`/admin/work/tasks/${card.dataset.wkTask}/move`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRF': csrf },
          body: JSON.stringify({ status }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.ok) throw new Error(j.error || T.fail);
        toast(T.moved.replace('{s}', j.label));
      } catch (err) {
        back.prepend(card);
        card.classList.toggle('is-done', back.closest('[data-wk-lane]').dataset.wkLane === 'done');
        recount();
        toast(err instanceof TypeError ? T.offline : err.message, 'error');
      }
    });
    recount();
  }

  // ---------- list: select rows, show the fields the chosen action needs ----------
  const bulk = $('#wk-bulk');
  if (bulk) {
    const picks = () => $$('input.wk-pick');
    const count = $('[data-wk-selected]', bulk);
    const update = () => {
      const n = picks().filter((x) => x.checked).length;
      if (count) count.textContent = n;
      bulk.classList.toggle('has-picks', n > 0);
      picks().forEach((x) => x.closest('tr')?.classList.toggle('is-picked', x.checked));
    };
    $('[data-wk-all]', bulk)?.addEventListener('change', (e) => { picks().forEach((x) => { x.checked = e.target.checked; }); update(); });
    document.addEventListener('change', (e) => { if (e.target.matches('input.wk-pick')) update(); });
    const action = $('[data-wk-action]', bulk);
    const show = () => $$('[data-wk-for]', bulk).forEach((el) => { el.hidden = el.dataset.wkFor !== action.value; });
    action?.addEventListener('change', show);
    if (action) show();
    update();
  }

  // ---------- @mentions: suggest names while typing ----------
  $$('textarea[data-wk-people]').forEach((ta) => {
    let names = [];
    try { names = JSON.parse(ta.dataset.wkPeople); } catch { names = []; }
    if (!names.length) return;
    const box = document.createElement('ul');
    box.className = 'wk-suggest';
    box.hidden = true;
    box.setAttribute('role', 'listbox');
    ta.parentElement.style.position = 'relative';
    ta.after(box);
    let at = -1;
    let active = 0;
    const close = () => { box.hidden = true; at = -1; };
    const pick = (name) => {
      const caret = ta.selectionStart;
      ta.value = `${ta.value.slice(0, at)}@${name} ${ta.value.slice(caret)}`;
      const pos = at + name.length + 2;
      ta.setSelectionRange(pos, pos);
      close();
      ta.focus();
    };
    const render = (list) => {
      box.innerHTML = '';
      list.forEach((n, i) => {
        const li = document.createElement('li');
        li.textContent = n;
        li.setAttribute('role', 'option');
        if (i === active) li.classList.add('is-on');
        li.addEventListener('mousedown', (e) => { e.preventDefault(); pick(n); });
        box.append(li);
      });
      box.hidden = !list.length;
    };
    const matches = () => {
      const caret = ta.selectionStart;
      const before = ta.value.slice(0, caret);
      const m = before.match(/(^|\s)@([^\s@]{0,20})$/u);
      if (!m) { close(); return []; }
      at = caret - m[2].length - 1;
      const q = m[2].toLowerCase();
      return names.filter((n) => n.toLowerCase().split(/\s+/).some((w) => w.startsWith(q)) || n.toLowerCase().startsWith(q)).slice(0, 6);
    };
    ta.addEventListener('input', () => { active = 0; render(matches()); });
    ta.addEventListener('keydown', (e) => {
      if (box.hidden) return;
      const items = $$('li', box);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        active = (active + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items.forEach((li, i) => li.classList.toggle('is-on', i === active));
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pick(items[active].textContent);
      } else if (e.key === 'Escape') close();
    });
    ta.addEventListener('blur', () => setTimeout(close, 150));
  });

  // ---------- people pickers: highlight the chosen ----------
  document.addEventListener('change', (e) => {
    const l = e.target.closest('.wk-pick-p');
    if (l) l.classList.toggle('is-on', e.target.checked);
  });
})();
