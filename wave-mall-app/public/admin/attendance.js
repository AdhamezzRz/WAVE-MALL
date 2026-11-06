/* Attendance & activity (src/admin/routes/attendance.js): the live board refreshes itself every 30
   seconds, "4 min ago" stays true, worked time keeps counting, and on the settings page HR can set
   the mall's centre from where they stand (several readings, the precise ones weighing most). */
(() => {
  'use strict';
  const conf = document.querySelector('[data-att-i18n]');
  const T = conf ? JSON.parse(conf.dataset.attI18n || '{}') : {};
  const fill = (s, o) => String(s || '').replace(/\{(\w+)\}/g, (_, k) => (o[k] !== undefined ? o[k] : ''));

  // ---------- "… ago" ----------
  const ago = () => document.querySelectorAll('[data-ago]').forEach((el) => {
    const s = Math.max(0, (Date.now() - Date.parse(el.getAttribute('datetime'))) / 1000);
    if (s >= 86400 || !T.justNow) return;
    el.textContent = s < 60 ? T.justNow : s < 3600 ? fill(T.minAgo, { n: Math.floor(s / 60) }) : fill(T.hMinAgo, { h: Math.floor(s / 3600), m: Math.floor((s % 3600) / 60) });
  });
  // ---------- worked so far ----------
  const worked = () => document.querySelectorAll('[data-live-from]').forEach((el) => {
    if (!T.durM) return;
    const m = Math.max(0, Math.floor((Date.now() - Date.parse(el.dataset.liveFrom)) / 60000));
    const h = Math.floor(m / 60);
    const b = el.querySelector('b') || el;
    b.textContent = !h ? fill(T.durM, { m }) : m % 60 ? fill(T.durHM, { h, m: m % 60 }) : fill(T.durH, { h });
  });
  setInterval(() => { ago(); worked(); }, 20000);

  // ---------- the live board ----------
  const live = document.getElementById('att-live');
  if (live && live.dataset.live) {
    const stamp = document.querySelector('[data-att-updated]');
    const refresh = () => {
      if (document.visibilityState !== 'visible') return;
      fetch(live.dataset.live, { credentials: 'same-origin', headers: { Accept: 'application/json' } }).then((r) => (r.ok ? r.json() : null)).then((j) => {
        if (!j || !j.ok) return;
        live.innerHTML = j.html;
        if (stamp) stamp.textContent = j.updated;
        live.classList.remove('is-fresh');
        void live.offsetWidth; // restart the fade
        live.classList.add('is-fresh');
      }).catch(() => {});
    };
    setInterval(refresh, 30000);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
  }

  // ---------- settings: the centre from where I stand ----------
  const here = document.querySelector('[data-att-here]');
  if (here) {
    const input = document.querySelector('[data-att-point]');
    const out = document.querySelector('[data-att-here-out]');
    here.addEventListener('click', () => {
      if (!('geolocation' in navigator)) { out.textContent = T.noGeo || ''; return; }
      const got = [];
      here.disabled = true;
      out.textContent = T.reading || '';
      const id = navigator.geolocation.watchPosition((p) => {
        got.push(p.coords);
        out.textContent = fill(T.readings || '{n}', { n: got.length, acc: Math.round(p.coords.accuracy) });
      }, () => {}, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
      setTimeout(() => {
        navigator.geolocation.clearWatch(id);
        here.disabled = false;
        if (!got.length) { out.textContent = T.noGeo || ''; return; }
        // weight each reading by 1/accuracy²
        let w = 0; let lat = 0; let lng = 0;
        got.forEach((c) => { const k = 1 / Math.max(1, c.accuracy) ** 2; w += k; lat += c.latitude * k; lng += c.longitude * k; });
        const acc = Math.min(...got.map((c) => c.accuracy));
        input.value = `${(lat / w).toFixed(6)}, ${(lng / w).toFixed(6)}`;
        out.textContent = fill(T.got || '', { n: got.length, acc: Math.round(acc) });
      }, 15000);
    });
  }
})();
