/* The office in use: once a minute, while this tab is visible, tell the office which module is open
   and whether the keyboard, mouse or screen was used in the last two minutes. Nothing typed is ever
   sent: only the page's address (without its query) and "in use" or "idle". Shown to HR on the
   attendance pages (src/admin/routes/attendance.js). */
(() => {
  'use strict';
  const token = () => (document.querySelector('meta[name=csrf]') || {}).content || '';
  if (!token() || !/^\/admin(\/|$)/.test(location.pathname) || document.body.classList.contains('signin')) return;
  let lastInput = Date.now();
  let lastMove = 0;
  const touched = () => { lastInput = Date.now(); };
  ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll'].forEach((ev) => addEventListener(ev, touched, { passive: true, capture: true }));
  addEventListener('pointermove', () => { if (Date.now() - lastMove > 5000) { lastMove = Date.now(); touched(); } }, { passive: true });
  const send = () => {
    if (document.visibilityState !== 'visible') return;
    fetch('/admin/me/beat', {
      method: 'POST', credentials: 'same-origin', keepalive: true,
      headers: { 'Content-Type': 'application/json', 'X-CSRF': token() },
      body: JSON.stringify({ path: location.pathname, active: Date.now() - lastInput < 120000 }),
    }).catch(() => {});
  };
  send();
  setInterval(send, 60000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') send(); });
})();
