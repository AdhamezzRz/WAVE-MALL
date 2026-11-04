/* The Wave · Leasing office · the assistant (/admin/assistant). The page works without it; this adds
   Enter to send, a "checking the records" bubble while the answer is prepared, copying answers, and
   keeping the latest answer in view. Every text it shows comes from the page (data-* attributes). */
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const thread = $('[data-ai-thread]');
  const compose = $('form.ai-compose');
  const input = $('[data-ai-input]');

  // the answer just asked for (#t12), else the end of the thread
  const target = location.hash && /^#t\d+$/.test(location.hash) ? $(location.hash) : null;
  if (target) target.scrollIntoView({ block: 'start' });
  else if (thread && thread.lastElementChild && $$('.ai-turn', thread).length) thread.lastElementChild.scrollIntoView({ block: 'end' });

  // the question box grows with the text; Enter sends, Shift+Enter starts a new line
  if (input) {
    const grow = () => { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 220)}px`; };
    input.addEventListener('input', grow);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        if (input.value.trim()) compose.requestSubmit();
      }
    });
    if (!target && !$$('.ai-turn').length) input.focus({ preventScroll: true });
  }

  // while the server prepares the answer: the question, and a bubble saying the records are being checked
  let sent = false;
  $$('form[data-ai-form]').forEach((f) => f.addEventListener('submit', (e) => {
    if (sent) { e.preventDefault(); return; }
    const q = (f.querySelector('[name=q]') || {}).value || '';
    if (!q.trim()) { e.preventDefault(); return; }
    sent = true;
    $$('form[data-ai-form] button').forEach((b) => { b.disabled = true; });
    const box = compose || f;
    if (!thread) return;
    $('.ai-hello', thread)?.remove();
    const pending = (compose && compose.dataset.pending) || '…';
    const wait = (compose && compose.dataset.wait) || '';
    const you = (compose && compose.dataset.you) || '';
    const mark = (($('.ai-a__mark svg') || $('.ai-hello__mark') || {}).outerHTML || '').replace(/ai-hello__mark/, '');
    const turn = document.createElement('article');
    turn.className = 'ai-turn ai-turn--pending';
    turn.innerHTML = `<div class="ai-q"><p dir="auto">${esc(q)}</p><span class="avatar avatar--sm" aria-hidden="true">${esc(you)}</span></div>
      <div class="ai-a"><span class="ai-a__mark ai-a__mark--busy" aria-hidden="true">${mark}</span>
      <div class="ai-a__body"><p class="ai-typing" role="status"><span class="ai-dots"><i></i><i></i><i></i></span><span>${esc(pending)}</span> <b data-ai-secs>0</b></p><p class="muted small" data-ai-wait hidden>${esc(wait)}</p></div></div>`;
    thread.append(turn);
    turn.scrollIntoView({ block: 'end', behavior: 'smooth' });
    const t0 = Date.now();
    const secs = $('[data-ai-secs]', turn);
    setInterval(() => {
      const s = Math.round((Date.now() - t0) / 1000);
      secs.textContent = `${s}s`;
      if (s >= 20) $('[data-ai-wait]', turn).hidden = false;
    }, 1000);
    if (input && box === compose) input.readOnly = true;
  }));

  // copy an answer as plain text
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-ai-copy]');
    if (!b) return;
    const text = b.closest('.ai-a__body')?.querySelector('[data-ai-text]')?.dataset.aiText || '';
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const t = document.createElement('textarea');
      t.value = text;
      document.body.append(t);
      t.select();
      document.execCommand('copy');
      t.remove();
    }
    const label = b.querySelector('span');
    const was = label.textContent;
    label.textContent = b.dataset.copied || was;
    b.classList.add('is-done');
    setTimeout(() => { label.textContent = was; b.classList.remove('is-done'); }, 1800);
  });
})();
