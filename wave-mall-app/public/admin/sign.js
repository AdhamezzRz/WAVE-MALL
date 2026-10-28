// The Wave · signing a proposal online (/sign/:token). A signature pad that works with a finger,
// a pen or a mouse, or a typed name set in script; either way the signature is sent as a JPEG on
// white (the server checks it and embeds it in the PDF certificate).
(() => {
  'use strict';
  const form = document.querySelector('form[data-sign]');
  if (!form) return;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const canvas = $('[data-sigpad]', form);
  const pad = canvas.parentElement;
  const out = $('[data-sig-out]', form);
  const kindIn = $('[data-sig-kind]', form);
  const typeIn = $('[data-sig-type]', form);
  const preview = $('[data-sig-preview]', form);
  const err = $('[data-sign-err]', form);
  const ink = '#1e2925';
  const ctx = canvas.getContext('2d');
  let strokes = [];
  let current = null;
  let kind = 'drawn';

  // ---------- drawing ----------
  function size() {
    const r = canvas.getBoundingClientRect();
    const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
    canvas.width = Math.round(r.width * dpr);
    canvas.height = Math.round(r.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    redraw();
  }
  function seg(c, a, b, w) {
    c.lineWidth = w;
    c.beginPath();
    c.moveTo(a.x, a.y);
    c.lineTo(b.x, b.y);
    c.stroke();
  }
  // a stroke with a slightly varying width (faster means thinner, like ink)
  function paint(c, s, scale = 1, dx = 0, dy = 0) {
    c.strokeStyle = ink;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    const p = s.map((q) => ({ x: (q.x - dx) * scale, y: (q.y - dy) * scale, w: q.w * scale }));
    if (p.length === 1) {
      c.fillStyle = ink;
      c.beginPath();
      c.arc(p[0].x, p[0].y, p[0].w / 2, 0, Math.PI * 2);
      c.fill();
      return;
    }
    for (let i = 1; i < p.length; i++) seg(c, p[i - 1], p[i], (p[i - 1].w + p[i].w) / 2);
  }
  function redraw() {
    const r = canvas.getBoundingClientRect();
    ctx.clearRect(0, 0, r.width, r.height);
    strokes.forEach((s) => paint(ctx, s));
    pad.classList.toggle('has-ink', strokes.length > 0);
  }
  const at = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, t: e.timeStamp };
  };
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    const p = at(e);
    current = [{ ...p, w: e.pressure && e.pointerType === 'pen' ? 1 + e.pressure * 3 : 2.6 }];
    strokes.push(current);
    redraw();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!current) return;
    e.preventDefault();
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of events) {
      const p = at(ev);
      const last = current[current.length - 1];
      const d = Math.hypot(p.x - last.x, p.y - last.y);
      if (d < 0.8) continue;
      const v = d / Math.max(1, p.t - last.t);
      const target = ev.pointerType === 'pen' && ev.pressure ? 1 + ev.pressure * 3 : Math.max(1.3, Math.min(3.4, 3.6 - v * 1.1));
      const w = last.w * 0.6 + target * 0.4;
      current.push({ ...p, w });
      seg(ctx, last, { ...p }, (last.w + w) / 2);
    }
  });
  const end = () => { current = null; redraw(); };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  // no scrolling or zooming while signing on a phone
  canvas.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });
  $('[data-sig-clear]', form).addEventListener('click', () => { strokes = []; redraw(); });
  window.addEventListener('resize', () => {
    // keep the strokes where they are relative to the pad's new size
    const before = canvas.getBoundingClientRect().width;
    requestAnimationFrame(() => {
      const after = canvas.getBoundingClientRect().width;
      if (before && after && before !== after) strokes = strokes.map((s) => s.map((q) => ({ ...q, x: (q.x * after) / before, y: (q.y * after) / before })));
      size();
    });
  });
  size();

  // ---------- typed ----------
  const arabic = (s) => /[؀-ۿ]/.test(s);
  const typedFont = (s, px) => (arabic(s) ? `700 ${px}px Almarai, Tahoma, sans-serif` : `italic 500 ${px}px "Bodoni Moda", Didot, Georgia, serif`);
  if (typeIn) {
    const name = $('input[name=name]', form);
    typeIn.addEventListener('input', () => { preview.textContent = typeIn.value; preview.classList.toggle('is-ar', arabic(typeIn.value)); });
    name?.addEventListener('input', () => {
      if (!typeIn.dataset.touched) { typeIn.value = name.value; typeIn.dispatchEvent(new Event('input')); }
    });
    typeIn.addEventListener('keydown', () => { typeIn.dataset.touched = '1'; });
  }
  $$('[data-sig-tab]', form).forEach((b) => b.addEventListener('click', () => {
    kind = b.dataset.sigTab;
    kindIn.value = kind;
    $$('[data-sig-tab]', form).forEach((x) => { x.classList.toggle('is-on', x === b); x.setAttribute('aria-selected', String(x === b)); });
    $$('[data-sig-pane]', form).forEach((p) => { p.hidden = p.dataset.sigPane !== kind; });
    if (kind === 'drawn') size();
    else typeIn.focus();
  }));

  // ---------- export: a JPEG on white, the signature centred ----------
  const W = 720;
  const H = 240;
  function exportDrawn() {
    const pts = strokes.flat();
    if (!pts.length) return null;
    const pad2 = 8;
    const minX = Math.min(...pts.map((p) => p.x - p.w)) - pad2;
    const maxX = Math.max(...pts.map((p) => p.x + p.w)) + pad2;
    const minY = Math.min(...pts.map((p) => p.y - p.w)) - pad2;
    const maxY = Math.max(...pts.map((p) => p.y + p.w)) + pad2;
    const bw = maxX - minX;
    const bh = maxY - minY;
    // a dot or a tiny scribble is not a signature
    if (pts.length < 8 || (bw < 40 && bh < 24)) return null;
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const x = c.getContext('2d');
    x.fillStyle = '#fff';
    x.fillRect(0, 0, W, H);
    const scale = Math.min((W - 40) / bw, (H - 30) / bh, 2.2);
    const ox = (W - bw * scale) / 2;
    const oy = (H - bh * scale) / 2;
    x.translate(ox, oy);
    strokes.forEach((s) => paint(x, s, scale, minX, minY));
    return c.toDataURL('image/jpeg', 0.9);
  }
  function exportTyped() {
    const s = (typeIn.value || '').trim();
    if (s.length < 2) return null;
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const x = c.getContext('2d');
    x.fillStyle = '#fff';
    x.fillRect(0, 0, W, H);
    let px = 96;
    x.font = typedFont(s, px);
    while (x.measureText(s).width > W - 60 && px > 28) { px -= 4; x.font = typedFont(s, px); }
    x.fillStyle = ink;
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.direction = arabic(s) ? 'rtl' : 'ltr';
    x.fillText(s, W / 2, H / 2 + 4);
    return c.toDataURL('image/jpeg', 0.9);
  }

  const show = (msg, el) => {
    err.textContent = msg;
    err.hidden = false;
    (el || err).scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (el && el.focus) el.focus({ preventScroll: true });
  };
  form.addEventListener('submit', (e) => {
    err.hidden = true;
    const name = $('input[name=name]', form);
    const email = $('input[name=email]', form);
    const consent = $('input[name=consent]', form);
    if ((name.value || '').trim().length < 2) { e.preventDefault(); show(form.dataset.msgName, name); return; }
    if (email.value && !email.checkValidity()) { e.preventDefault(); show(form.dataset.msgEmail, email); return; }
    const data = kind === 'typed' ? exportTyped() : exportDrawn();
    if (!data) { e.preventDefault(); show(form.dataset.msgSig, kind === 'typed' ? typeIn : pad); return; }
    if (!consent.checked) { e.preventDefault(); show(form.dataset.msgConsent, consent); return; }
    out.value = data;
    const go = $('.signpanel__go', form);
    go.classList.add('is-busy');
    setTimeout(() => { go.disabled = true; }, 0);
  });

  // ---------- the "sign" shortcut, hidden once the panel is on screen ----------
  const jump = $('.signjump');
  const panel = $('#sign');
  if (jump && panel && 'IntersectionObserver' in window) {
    new IntersectionObserver(([en]) => jump.classList.toggle('is-gone', en.isIntersecting), { rootMargin: '0px 0px -30% 0px' }).observe(panel);
  }
})();
