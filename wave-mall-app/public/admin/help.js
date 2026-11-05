/* Help & training (routes/help.js): the lesson player, the transcript that follows it, reading
   aloud with the device's voice, keyboard shortcuts, progress, and the live "Show me" tour that
   points at each step on the real pages. Loaded on every office page (the tour can start anywhere). */
(() => {
  'use strict';
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const csrf = () => (document.querySelector('meta[name=csrf]') || {}).content || '';
  const fmt = (s) => { s = Math.max(0, Math.floor(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const store = {
    get(k) { try { return JSON.parse(sessionStorage.getItem(k)); } catch { return null; } },
    set(k, v) { try { if (v === null) sessionStorage.removeItem(k); else sessionStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
    lget(k) { try { return localStorage.getItem(k); } catch { return null; } },
    lset(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
  };

  // ---------------------------------------------------------------- the player
  function player(box) {
    const video = $('[data-hlp-video]', box);
    if (!video) return;
    const lang = box.dataset.lang;
    const cap = $('[data-hlp-cap]', box);
    const big = $('[data-hlp-big]', box);
    const toggle = $('[data-hlp-toggle]', box);
    const timeEl = $('[data-hlp-time]', box);
    const scrub = $('[data-hlp-scrub]', box);
    const fill = $('[data-hlp-fill]', box);
    const tip = $('[data-hlp-tip]', box);
    const speedBtn = $('[data-hlp-speed]', box);
    const ccBtn = $('[data-hlp-cc]', box);
    const voiceBtn = $('[data-hlp-voice]', box);
    const fullBtn = $('[data-hlp-full]', box);
    const toastEl = $('[data-hlp-toast]', box);
    const panel = $('[data-hlp-transcript]');
    const lines = panel ? $$('.hlp-line[data-start]', panel) : [];
    const follow = panel ? $('[data-hlp-follow]', panel) : null;
    let cues = [];
    let current = -1;
    let cc = store.lget('hlp-cc') !== '0';
    let voice = store.lget('hlp-voice') === '1';
    const speeds = [0.75, 1, 1.25, 1.5, 2];
    let speed = Number(store.lget('hlp-speed')) || 1;
    let toastT = 0;
    const toast = (text) => { if (!toastEl) return; toastEl.textContent = text; toastEl.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { toastEl.hidden = true; }, 1400); };

    // cues: from the transcript JSON (also used for chapters and reading aloud)
    fetch(box.dataset.cues, { credentials: 'same-origin' }).then((r) => r.json()).then((d) => { cues = d.cues || []; render(); }).catch(() => {});

    // seen: which seconds were actually played (for the progress)
    const dur = () => video.duration || Number(box.dataset.duration) || 0;
    const seenSet = new Set();
    let lastSent = 0;
    const send = (extra = {}) => {
      const url = box.dataset.progress;
      if (!url || !dur()) return;
      const seen = Math.min(1, seenSet.size / Math.max(1, Math.floor(dur())));
      const body = JSON.stringify({ pos: video.currentTime, dur: dur(), seen, lang, ...extra });
      lastSent = Date.now();
      if (extra.beacon && navigator.sendBeacon) {
        // sendBeacon cannot add the CSRF header: fall back to keepalive fetch
        fetch(url, { method: 'POST', keepalive: true, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRF': csrf() }, body }).catch(() => {});
        return;
      }
      fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRF': csrf() }, body }).catch(() => {});
    };

    const cueAt = (t) => { for (let i = cues.length - 1; i >= 0; i--) if (t >= cues[i].start - 0.05) return t <= cues[i].end + 0.6 ? i : -1; return -1; };
    const steps = () => cues.filter((c) => !c.intro);
    function render() {
      const t = video.currentTime;
      const d = dur();
      if (timeEl) timeEl.textContent = `${fmt(t)} / ${fmt(d)}`;
      if (fill && d) fill.style.width = `${(t / d) * 100}%`;
      if (scrub && d) scrub.setAttribute('aria-valuenow', String(Math.round(t)));
      box.classList.toggle('is-playing', !video.paused);
      const i = cueAt(t);
      if (i !== current) {
        current = i;
        const c = cues[i];
        if (cap) { cap.textContent = c && cc ? c.text : ''; cap.classList.toggle('is-on', !!(c && cc)); }
        lines.forEach((li) => li.classList.toggle('is-on', c && Number(li.dataset.start) === c.start));
        $$('[data-hlp-seek]').forEach((b) => b.closest('li') && b.closest('li').classList.toggle('is-on', c && Number(b.dataset.hlpSeek) === c.start));
        const on = lines.find((li) => li.classList.contains('is-on'));
        if (on && (!follow || follow.checked) && !video.paused) {
          const list = on.parentElement;
          const box2 = list.getBoundingClientRect();
          const r = on.getBoundingClientRect();
          if (list.scrollHeight > list.clientHeight + 4) list.scrollTo({ top: list.scrollTop + (r.top - box2.top) - list.clientHeight / 3, behavior: 'smooth' });
        }
        if (c && voice && !video.paused) speak(c.text);
      }
    }
    // reading aloud with the device's own voice; the video waits for the voice when it lags
    let speaking = false;
    let heldByVoice = false;
    const pickVoice = () => {
      const vs = (window.speechSynthesis && speechSynthesis.getVoices()) || [];
      return vs.find((v) => v.lang && v.lang.toLowerCase().startsWith(lang) && /natural|neural|premium|enhanced/i.test(v.name)) || vs.find((v) => v.lang && v.lang.toLowerCase().startsWith(lang)) || null;
    };
    function speak(text) {
      if (!('speechSynthesis' in window)) return;
      speechSynthesis.cancel();
      const v = pickVoice();
      if (!v) { toast(box.dataset.tNovoice); return; }
      const u = new SpeechSynthesisUtterance(text);
      u.voice = v; u.lang = v.lang; u.rate = Math.min(1.4, Math.max(0.8, speed));
      speaking = true;
      u.onend = u.onerror = () => { speaking = false; if (heldByVoice) { heldByVoice = false; video.play().catch(() => {}); } };
      speechSynthesis.speak(u);
    }
    const setVoice = (on) => {
      voice = on;
      store.lset('hlp-voice', on ? '1' : '0');
      if (voiceBtn) { voiceBtn.classList.toggle('is-on', on); voiceBtn.setAttribute('aria-pressed', String(on)); }
      if (!on && window.speechSynthesis) { speechSynthesis.cancel(); speaking = false; }
      if (on && !pickVoice()) toast(box.dataset.tNovoice);
      current = -2;
      render();
    };
    if (!('speechSynthesis' in window) && voiceBtn) voiceBtn.hidden = true;
    if (window.speechSynthesis) speechSynthesis.onvoiceschanged = () => {};
    const setCc = (on) => { cc = on; store.lset('hlp-cc', on ? '1' : '0'); if (ccBtn) { ccBtn.classList.toggle('is-on', on); ccBtn.setAttribute('aria-pressed', String(on)); } current = -2; render(); };
    const setSpeed = (s) => { speed = s; video.playbackRate = s; store.lset('hlp-speed', String(s)); if (speedBtn) speedBtn.textContent = `${s}×`; toast(`${s}×`); };
    const playPause = () => { if (video.paused) video.play().catch(() => {}); else video.pause(); };
    const seek = (t) => { video.currentTime = Math.max(0, Math.min(dur() - 0.1, t)); current = -2; render(); };
    const stepJump = (dir) => {
      const t = video.currentTime;
      const st = steps();
      if (!st.length) return;
      if (dir > 0) { const n = st.find((c) => c.start > t + 0.3); if (n) seek(n.start); } else {
        const prev = [...st].reverse().find((c) => c.start < t - 1.2);
        seek(prev ? prev.start : 0);
      }
    };

    video.playbackRate = speed;
    if (speedBtn) speedBtn.textContent = `${speed}×`;
    setCc(cc);
    if (voiceBtn) { voiceBtn.classList.toggle('is-on', voice); voiceBtn.setAttribute('aria-pressed', String(voice)); }
    // the captions are drawn by us (bigger, branded), never by the browser
    for (const tr of video.textTracks || []) tr.mode = 'hidden';
    const start = Number(box.dataset.start) || 0;
    if (start) video.addEventListener('loadedmetadata', () => { if (video.currentTime < 1) video.currentTime = start; }, { once: true });

    video.addEventListener('timeupdate', () => {
      seenSet.add(Math.floor(video.currentTime));
      render();
      if (voice && speaking && !video.paused) {
        const c = cues[current];
        if (c && video.currentTime > c.end - 0.15) { heldByVoice = true; video.pause(); }
      }
      if (Date.now() - lastSent > 10000 && !video.paused) send();
    });
    video.addEventListener('play', () => { box.classList.add('has-played'); render(); if (voice && cues[current]) speak(cues[current].text); });
    video.addEventListener('pause', () => { render(); if (!heldByVoice) { if (window.speechSynthesis) speechSynthesis.cancel(); send(); } });
    video.addEventListener('ended', () => {
      send({ ended: true });
      box.classList.add('is-ended');
      const nxt = $('[data-hlp-nextlesson]');
      if (nxt) nxt.classList.add('is-hot');
    });
    window.addEventListener('pagehide', () => send({ beacon: true }));
    video.addEventListener('click', playPause);
    if (big) big.addEventListener('click', () => video.play().catch(() => {}));
    if (toggle) toggle.addEventListener('click', playPause);
    $('[data-hlp-prev]', box)?.addEventListener('click', () => stepJump(-1));
    $('[data-hlp-next]', box)?.addEventListener('click', () => stepJump(1));
    if (speedBtn) speedBtn.addEventListener('click', () => setSpeed(speeds[(speeds.indexOf(speed) + 1) % speeds.length] || 1));
    if (ccBtn) ccBtn.addEventListener('click', () => setCc(!cc));
    if (voiceBtn) voiceBtn.addEventListener('click', () => setVoice(!voice));
    if (fullBtn) fullBtn.addEventListener('click', () => { if (document.fullscreenElement) document.exitFullscreen(); else (box.requestFullscreen || box.webkitRequestFullscreen || (() => {})).call(box); });
    // scrubbing
    if (scrub) {
      const at = (e) => { const r = scrub.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * dur(); };
      let drag = false;
      scrub.addEventListener('pointerdown', (e) => { drag = true; scrub.setPointerCapture(e.pointerId); seek(at(e)); });
      scrub.addEventListener('pointermove', (e) => {
        const t = at(e);
        if (drag) seek(t);
        if (tip && dur()) {
          const c = cues[cueAt(t)];
          tip.hidden = false;
          tip.textContent = `${fmt(t)}${c && !c.intro ? ` · ${c.text.length > 60 ? `${c.text.slice(0, 58)}…` : c.text}` : ''}`;
          tip.style.left = `${(t / dur()) * 100}%`;
        }
      });
      scrub.addEventListener('pointerup', () => { drag = false; });
      scrub.addEventListener('pointerleave', () => { if (tip) tip.hidden = true; });
      scrub.addEventListener('keydown', (e) => { if (e.key === 'ArrowRight') { seek(video.currentTime + 5); e.preventDefault(); } if (e.key === 'ArrowLeft') { seek(video.currentTime - 5); e.preventDefault(); } });
    }
    // every [data-hlp-seek] on the page (transcript lines, the steps list)
    document.addEventListener('click', (e) => {
      const b = e.target.closest('[data-hlp-seek]');
      if (!b) return;
      seek(Number(b.dataset.hlpSeek));
      video.play().catch(() => {});
      if (window.matchMedia('(max-width: 900px)').matches) box.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    // keyboard
    document.addEventListener('keydown', (e) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      const tag = (e.target.tagName || '').toLowerCase();
      if (['input', 'textarea', 'select'].includes(tag) || e.target.isContentEditable) return;
      const k = e.key;
      const map = {
        ' ': playPause, k: playPause, K: playPause,
        ArrowLeft: () => seek(video.currentTime - 5), j: () => seek(video.currentTime - 5), J: () => seek(video.currentTime - 5),
        ArrowRight: () => seek(video.currentTime + 5), l: () => seek(video.currentTime + 5), L: () => seek(video.currentTime + 5),
        ',': () => stepJump(-1), '.': () => stepJump(1),
        c: () => setCc(!cc), C: () => setCc(!cc), r: () => setVoice(!voice), R: () => setVoice(!voice),
        f: () => fullBtn && fullBtn.click(), F: () => fullBtn && fullBtn.click(),
        '<': () => setSpeed(speeds[Math.max(0, speeds.indexOf(speed) - 1)]), '>': () => setSpeed(speeds[Math.min(speeds.length - 1, speeds.indexOf(speed) + 1)]),
      };
      if (map[k]) { e.preventDefault(); map[k](); }
    });
    render();
  }

  // ---------------------------------------------------------------- the transcript tools
  function transcript(panel) {
    const input = $('[data-hlp-tsearch]', panel);
    const lines = $$('.hlp-line', panel);
    const filter = () => {
      const q = (input.value || '').trim().toLowerCase();
      for (const li of lines) {
        const p = $('p', li);
        if (!p.dataset.raw) p.dataset.raw = p.textContent;
        const raw = p.dataset.raw;
        const i = q ? raw.toLowerCase().indexOf(q) : -1;
        li.classList.toggle('is-dim', !!q && i < 0);
        if (i >= 0) { p.textContent = ''; p.append(raw.slice(0, i)); const m = document.createElement('mark'); m.textContent = raw.slice(i, i + q.length); p.append(m, raw.slice(i + q.length)); } else p.textContent = raw;
      }
      const first = lines.find((li) => !li.classList.contains('is-dim') && q);
      if (first) first.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    };
    if (input) { input.addEventListener('input', filter); if (input.value) filter(); }
    const copy = $('[data-hlp-copy]', panel);
    if (copy) copy.addEventListener('click', async () => {
      const text = lines.map((li) => { const t = $('time', li); return `${t ? `[${t.textContent}] ` : ''}${$('p', li).dataset.raw || $('p', li).textContent}`; }).join('\n');
      try { await navigator.clipboard.writeText(text); copy.textContent = copy.dataset.done; } catch { /* no clipboard */ }
    });
  }

  // ---------------------------------------------------------------- support form: the browser
  const agent = $('[data-hlp-agent]');
  if (agent) agent.value = `${navigator.userAgent} · ${window.screen.width}×${window.screen.height} · ${window.innerWidth}×${window.innerHeight} · ${navigator.language}`;

  // ---------------------------------------------------------------- the live tour ("Show me")
  const TOUR = 'hlp-tour';
  const norm = (p) => String(p || '').split('?')[0].replace(/\/+$/, '').replace(/\/\d+(?=\/|$)/g, '/:id') || '/admin';
  function startTour(id, i = 0) { store.set(TOUR, { id, i }); }
  document.addEventListener('click', (e) => {
    const a = e.target.closest('[data-hlp-tour]');
    if (a) startTour(a.dataset.hlpTour, 0);
  });
  async function runTour() {
    const url = new URL(location.href);
    const qid = url.searchParams.get('tour');
    if (qid) {
      const st0 = store.get(TOUR);
      if (!st0 || st0.id !== qid) startTour(qid, 0);
      url.searchParams.delete('tour');
      history.replaceState(null, '', url.pathname + (url.search ? url.search : '') + url.hash);
    }
    const st = store.get(TOUR);
    if (!st || !st.id || location.pathname.startsWith('/admin/help')) return;
    let data;
    try { data = await (await fetch(`/admin/help/l/${encodeURIComponent(st.id)}/tour.json`, { credentials: 'same-origin', headers: { Accept: 'application/json' } })).json(); } catch { return; }
    if (!data || !data.ok || !data.steps.length) { store.set(TOUR, null); return; }
    const rtl = document.documentElement.dir === 'rtl';
    const root = document.createElement('div');
    root.className = 'hlp-tour';
    root.innerHTML = `<div class="hlp-tour__spot" hidden></div><section class="hlp-tour__card" role="dialog" aria-live="polite"><header><span class="hlp-tour__kicker"></span><button type="button" class="hlp-tour__x" aria-label="">×</button></header><h3></h3><p class="hlp-tour__text"></p><p class="hlp-tour__extra" hidden></p><div class="hlp-tour__bar"><i></i></div><footer><button type="button" class="btn btn--ghost btn--sm" data-t="back"></button><a class="btn btn--ghost btn--sm" data-t="open" hidden></a><button type="button" class="btn btn--primary btn--sm" data-t="next"></button></footer></section>`;
    document.body.appendChild(root);
    const spot = $('.hlp-tour__spot', root);
    const card = $('.hlp-tour__card', root);
    $('h3', card).textContent = data.title;
    $('.hlp-tour__x', card).setAttribute('aria-label', data.t.end);
    $('[data-t=back]', card).textContent = data.t.back;
    const nextBtn = $('[data-t=next]', card);
    const openBtn = $('[data-t=open]', card);
    let i = Math.min(st.i || 0, data.steps.length - 1);
    let target = null;
    const end = (done) => {
      store.set(TOUR, null);
      root.remove();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      if (done) {
        const t = document.createElement('div');
        t.className = 'toast toast--ok hlp-tour__done';
        t.textContent = data.t.finished;
        document.body.appendChild(t);
        setTimeout(() => t.remove(), 3200);
      }
    };
    const find = (s) => {
      if (!s.sel) return null;
      let els;
      try { els = $$(s.sel); } catch { return null; }
      els = els.filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden'; });
      if (s.has) els = els.filter((el) => el.textContent.includes(s.has));
      return els[s.nth || 0] || null;
    };
    function place() {
      if (!target || !target.isConnected) { spot.hidden = true; card.classList.add('is-free'); return; }
      const r = target.getBoundingClientRect();
      const pad = 8;
      spot.hidden = false;
      Object.assign(spot.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px` });
      // the card next to the target, inside the screen
      card.classList.remove('is-free');
      const cw = card.offsetWidth;
      const ch = card.offsetHeight;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      if (vw < 640) { card.classList.add('is-free'); return; }
      let top = r.bottom + 16;
      if (top + ch > vh - 12) top = r.top - ch - 16;
      if (top < 12) top = Math.min(vh - ch - 12, Math.max(12, r.top));
      let left = rtl ? r.right - cw : r.left;
      if (r.width > vw * 0.5 || top === Math.max(12, r.top)) left = rtl ? r.left - cw - 16 : r.right + 16;
      left = Math.max(12, Math.min(vw - cw - 12, left));
      card.style.left = `${left}px`;
      card.style.top = `${top}px`;
    }
    function show() {
      const s = data.steps[i];
      store.set(TOUR, { id: data.id, i });
      $('.hlp-tour__kicker', card).textContent = data.t.step.replace('{n}', String(i + 1)).replace('{total}', String(data.steps.length));
      $('.hlp-tour__text', card).textContent = s.text;
      $('.hlp-tour__bar i', card).style.width = `${((i + 1) / data.steps.length) * 100}%`;
      $('[data-t=back]', card).disabled = i === 0;
      nextBtn.textContent = i === data.steps.length - 1 ? data.t.done : data.t.next;
      const extra = $('.hlp-tour__extra', card);
      extra.hidden = true;
      openBtn.hidden = true;
      const herePage = norm(location.pathname);
      const want = norm(s.page);
      target = find(s);
      if (!target && want !== herePage && s.page) {
        // the step is on another page: offer to go there (records: the list it lives in)
        openBtn.hidden = false;
        openBtn.textContent = data.t.open;
        const dest = s.page.includes(':id') || /\/\d+(\/|$)/.test(s.page) ? s.page.replace(/\/\d+(\/.*)?$/, '') : s.page;
        openBtn.href = dest;
        openBtn.onclick = () => store.set(TOUR, { id: data.id, i });
      } else {
        if (target) {
          const r = target.getBoundingClientRect();
          if (r.top < 80 || r.bottom > window.innerHeight - 80) target.scrollIntoView({ block: 'center', behavior: 'smooth' });
          if (s.kind === 'type' && s.value) { extra.hidden = false; extra.textContent = `${data.t.type} ${s.value}`; }
          // when the person does the step themselves, move on
          if (['click', 'check'].includes(s.kind)) target.addEventListener('click', () => store.set(TOUR, { id: data.id, i: Math.min(i + 1, data.steps.length - 1) }), { once: true });
        } else if (s.sel) {
          extra.hidden = false;
          extra.textContent = data.t.missing;
        }
      }
      place();
      setTimeout(place, 420);
    }
    $('[data-t=back]', card).addEventListener('click', () => { if (i > 0) { i -= 1; show(); } });
    nextBtn.addEventListener('click', () => { if (i < data.steps.length - 1) { i += 1; show(); } else end(true); });
    $('.hlp-tour__x', card).addEventListener('click', () => end(false));
    document.addEventListener('keydown', (e) => {
      if (!root.isConnected) return;
      const tag = (e.target.tagName || '').toLowerCase();
      if (['input', 'textarea', 'select'].includes(tag)) { if (e.key === 'Escape') end(false); return; }
      if (e.key === 'Escape') end(false);
      else if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); (rtl && e.key === 'ArrowRight' ? $('[data-t=back]', card) : nextBtn).click(); } else if (e.key === 'ArrowLeft') { e.preventDefault(); (rtl ? nextBtn : $('[data-t=back]', card)).click(); }
    });
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    requestAnimationFrame(() => root.classList.add('is-on'));
    show();
  }

  const boot = () => {
    $$('[data-hlp-player]').forEach(player);
    $$('[data-hlp-transcript]').forEach(transcript);
    runTour();
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
