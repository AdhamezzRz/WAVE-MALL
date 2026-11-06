/* The staff app (/staff): reads the phone's position, shows how far the mall is, takes the photo
   when asked, sends the clocking, and while clocked in sends the position every few minutes.
   The server decides everything (src/admin/attendance/engine.js); this only reports. */
(() => {
  'use strict';
  const root = document.querySelector('[data-staff]');
  // live "worked so far" counters work on every staff page
  const T = root ? JSON.parse(root.dataset.i18n || '{}') : {};
  const fill = (s, o) => String(s || '').replace(/\{(\w+)\}/g, (_, k) => (o[k] !== undefined ? o[k] : ''));
  if (!root) return;
  const csrf = root.dataset.csrf;
  const fence = root.dataset.lat ? { lat: Number(root.dataset.lat), lng: Number(root.dataset.lng) } : null;
  const radius = Number(root.dataset.radius) || 100;
  const maxAcc = Number(root.dataset.maxacc) || 60;
  const selfie = root.dataset.selfie === '1';
  const pingMin = Math.max(1, Number(root.dataset.ping) || 5);
  let open = root.dataset.open === '1';
  const where = root.querySelector('[data-where]');
  const whereText = root.querySelector('[data-where-text]');
  const accBar = root.querySelector('[data-acc-bar]');
  const result = root.querySelector('[data-result]');
  const buttons = [...root.querySelectorAll('[data-kind]')];

  const rad = (d) => (d * Math.PI) / 180;
  const dist = (a, b) => {
    const dLat = rad(b.lat - a.lat);
    const dLng = rad(b.lng - a.lng);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(s)));
  };

  // ---------- reading the position: keep the best of the last few seconds ----------
  let best = null;
  const startedAt = Date.now();
  const fresh = () => best && Date.now() - best.seen < 45000;
  function show() {
    if (!best) return;
    const acc = Math.round(best.accuracy);
    const d = fence ? Math.round(dist(fence, best)) : null;
    const precise = acc <= maxAcc;
    where.classList.toggle('is-in', precise && d !== null && d <= radius);
    where.classList.toggle('is-out', precise && d !== null && d > radius);
    where.classList.toggle('is-weak', !precise);
    whereText.textContent = !precise ? fill(T.weak, { m: fill(T.m, { m: acc }) }) : d === null ? '' : fill(d <= radius ? T.inside : T.outside, { m: fill(T.m, { m: d }) });
    accBar.style.width = `${Math.max(6, Math.min(100, (maxAcc / Math.max(acc, 1)) * 60))}%`;
    // buttons wait for a precise reading, or 20 seconds (the server then explains what is wrong)
    const ready = precise || Date.now() - startedAt > 20000;
    buttons.forEach((b) => { b.disabled = !ready; });
  }
  function take(pos) {
    const c = pos.coords;
    const r = { lat: c.latitude, lng: c.longitude, accuracy: c.accuracy, taken: pos.timestamp || Date.now(), seen: Date.now() };
    // a better reading wins; an old best gives way to a newer one
    if (!best || r.accuracy <= best.accuracy || Date.now() - best.seen > 15000) best = r;
    show();
  }
  function fail(err) {
    where.classList.add('is-weak');
    whereText.textContent = err && err.code === 1 ? T.denied : T.waitBetter;
    if (Date.now() - startedAt > 20000) buttons.forEach((b) => { b.disabled = false; });
  }
  if (!('geolocation' in navigator)) whereText.textContent = T.unsupported;
  else {
    navigator.geolocation.watchPosition(take, fail, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
    setTimeout(show, 20500);
  }

  // ---------- the photo ----------
  const cam = root.querySelector('[data-cam]');
  const video = root.querySelector('[data-video]');
  const canvas = root.querySelector('[data-canvas]');
  const shot = root.querySelector('[data-shot]');
  const snapBtn = root.querySelector('[data-snap]');
  const cancelBtn = root.querySelector('[data-cam-cancel]');
  const camText = root.querySelector('[data-cam-text]');
  function photo() {
    return new Promise((resolve) => {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { resolve(null); return; }
      let stream = null;
      let taken = null;
      const stop = () => { if (stream) stream.getTracks().forEach((t) => t.stop()); cam.hidden = true; shot.hidden = true; video.hidden = false; };
      camText.textContent = T.camera;
      snapBtn.textContent = T.snap;
      cancelBtn.textContent = T.cancel;
      cam.hidden = false;
      navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, audio: false }).then((s) => {
        stream = s;
        video.srcObject = s;
      }).catch(() => { camText.textContent = T.noCamera; });
      snapBtn.onclick = () => {
        if (taken) { stop(); resolve(taken); return; }
        if (!video.videoWidth) return;
        const w = 480;
        const hgt = Math.round((video.videoHeight / video.videoWidth) * w);
        canvas.width = w;
        canvas.height = hgt;
        canvas.getContext('2d').drawImage(video, 0, 0, w, hgt);
        let q = 0.72;
        let url = canvas.toDataURL('image/jpeg', q);
        while (url.length > 260000 && q > 0.3) { q -= 0.12; url = canvas.toDataURL('image/jpeg', q); }
        taken = url;
        shot.src = url;
        shot.hidden = false;
        video.hidden = true;
        snapBtn.textContent = T.use;
        cancelBtn.textContent = T.retake;
        cancelBtn.onclick = () => { taken = null; shot.hidden = true; video.hidden = false; snapBtn.textContent = T.snap; cancelBtn.textContent = T.cancel; cancelBtn.onclick = cancel; };
      };
      const cancel = () => { stop(); resolve(null); };
      cancelBtn.onclick = cancel;
    });
  }

  // ---------- clocking ----------
  const say = (cls, html) => { result.className = `att-result att-result--${cls}`; result.innerHTML = html; };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  buttons.forEach((b) => b.addEventListener('click', async () => {
    const kind = b.dataset.kind;
    let pic = null;
    if (selfie && (kind === 'in' || kind === 'out')) {
      pic = await photo();
      if (!pic) return;
    }
    if (!fresh()) { say('wait', esc(T.waitBetter)); }
    buttons.forEach((x) => { x.disabled = true; });
    say('wait', esc(T.sending));
    const r = best || {};
    try {
      const res = await fetch('/staff/punch', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRF': csrf },
        body: JSON.stringify({ kind, lat: r.lat, lng: r.lng, accuracy: r.accuracy, taken: r.taken, sent: Date.now(), selfie: pic }),
      });
      const j = await res.json();
      if (j.ok) {
        say('ok', `<b>${esc(j.message)}</b>${j.flags && j.flags.length ? `<small>${esc(j.flags.join(' · '))}</small>` : ''}`);
        if (navigator.vibrate) navigator.vibrate(60);
        setTimeout(() => location.reload(), 1600);
      } else {
        say('no', `<b>${esc(j.message || j.error || '')}</b>${(j.advice || []).map((a) => `<small>${esc(a)}</small>`).join('')}`);
        buttons.forEach((x) => { x.disabled = false; });
      }
    } catch {
      say('no', `<b>${esc(T.offline)}</b>`);
      buttons.forEach((x) => { x.disabled = false; });
    }
  }));

  // ---------- while clocked in: the position every few minutes, while the page is open ----------
  let lastPing = 0;
  function ping() {
    if (!open || !('geolocation' in navigator)) return;
    lastPing = Date.now();
    navigator.geolocation.getCurrentPosition((pos) => {
      take(pos);
      const c = pos.coords;
      fetch('/staff/ping', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRF': csrf },
        body: JSON.stringify({ lat: c.latitude, lng: c.longitude, accuracy: c.accuracy, taken: pos.timestamp, visible: document.visibilityState === 'visible' }),
      }).then((r) => r.json()).then((j) => { if (j && j.open === false) open = false; }).catch(() => {});
    }, () => {}, { enableHighAccuracy: true, maximumAge: 20000, timeout: 25000 });
  }
  if (open) {
    setTimeout(ping, 4000);
    setInterval(ping, pingMin * 60000);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && Date.now() - lastPing > 60000) ping(); });
  }
})();

/* "Worked so far" keeps counting on the page (data-live-from: when the count would have started). */
(() => {
  'use strict';
  const els = [...document.querySelectorAll('[data-live-from]')];
  if (!els.length) return;
  const root = document.querySelector('[data-staff], [data-att-i18n]');
  const T = root ? JSON.parse(root.dataset.i18n || root.dataset.attI18n || '{}') : {};
  const fill = (s, o) => String(s || '').replace(/\{(\w+)\}/g, (_, k) => (o[k] !== undefined ? o[k] : ''));
  const tick = () => els.forEach((el) => {
    const m = Math.max(0, Math.floor((Date.now() - Date.parse(el.dataset.liveFrom)) / 60000));
    const h = Math.floor(m / 60);
    const text = !h ? fill(T.durM, { m }) : m % 60 ? fill(T.durHM, { h, m: m % 60 }) : fill(T.durH, { h });
    const b = el.querySelector('b') || el;
    if (T.durM) b.textContent = text;
  });
  setInterval(tick, 30000);
})();
