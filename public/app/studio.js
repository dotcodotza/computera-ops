/* Studio document pane: POV (pdfcraft) proxied on our own origin, so its
   same-origin postMessage bridge works:
     pov:ready  -> we may push files
     pov:open   -> { name, bytes } opens a tab in POV
     pov:save   -> { name, saveAs, bytes } written back through /api/document/save-bytes
     pov:dirty  -> unsaved indicator
   A stat poll reloads POV when the file changes on disk, which is how AI/Kilo
   edits (made in the workspace) reach the document the user is looking at. */
(function () {
  'use strict';

  const POV_EMBED = 'https://skywalkingzulu1.github.io/pdfcraft/';
  const POLL_MS = 5000;
  const READY_TIMEOUT_MS = 8000;

  const frame = document.getElementById('pov-frame');
  const chatPanel = document.getElementById('chat-copilot-panel');
  const handle = document.getElementById('split-handle');
  const titleEl = document.getElementById('pov-doc-title');
  const statusEl = document.getElementById('pov-status');
  const banner = document.getElementById('pov-banner');
  const bannerText = document.getElementById('pov-banner-text');

  let mode = 'proxy';
  let ready = false;
  let dirty = false;
  let pendingOpen = null;
  let readyTimer = null;
  let pollTimer = null;
  let current = { path: null, name: null, mtimeMs: 0, size: 0 };
  const IDLE_STATUS = 'Open a PDF from Files, or drop one in.';

  /* POV (egui) keeps its appearance in localStorage, and this app is same-origin,
     so its bright workbench can be matched to the dark shell before the canvas
     boots. A deliberate light choice is left alone; only the follow-the-system
     default becomes dark. */
  function seedPovTheme() {
    try {
      const raw = localStorage.getItem('pov');
      if (raw) {
        const settings = JSON.parse(raw);
        if (!settings.theme || settings.theme === 'System') {
          settings.theme = 'Dark';
          localStorage.setItem('pov', JSON.stringify(settings));
        }
      }
      const memory = localStorage.getItem('egui_memory_ron');
      if (memory && /theme_preference:System/.test(memory)) {
        localStorage.setItem('egui_memory_ron', memory.replace(/theme_preference:[A-Za-z]+/, 'theme_preference:Dark'));
      }
    } catch { /* a corrupt or missing setting is POV's to reset */ }
  }

  const basename = (p) => (window.Copilot ? window.Copilot.baseName(p) : String(p).split(/[\\/]/).pop());
  const toast = (msg, err) => { if (window.Copilot) window.Copilot.toast(msg, err); };
  const povUrl = () => '/pdfcraft/?host=parent&author=' + encodeURIComponent(author());

  function author() {
    try { return localStorage.getItem('computera_author') || 'Computera'; } catch { return 'Computera'; }
  }

  function setStatus(text, bad) {
    if (!statusEl) return;
    statusEl.textContent = text || '';
    statusEl.classList.toggle('bad', !!bad);
  }

  function setTitle(name) {
    titleEl.textContent = name || 'No PDF open';
    document.title = (name ? name + ' · ' : '') + 'Studio · Computera';
  }

  function showBanner(text) { bannerText.textContent = text; banner.classList.add('active'); }
  function hideBanner() { banner.classList.remove('active'); }

  function formatSize(n) {
    if (!n) return '0 B';
    const k = 1024, units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(n) / Math.log(k));
    return parseFloat((n / Math.pow(k, i)).toFixed(1)) + ' ' + units[i];
  }

  function startReadyTimer() {
    ready = false;
    clearTimeout(readyTimer);
    readyTimer = setTimeout(() => {
      if (ready || mode === 'embed') return;
      showBanner('POV did not start (WebGL or bridge unavailable). Reload, or open it in a new tab.');
      setStatus('POV did not start', true);
    }, READY_TIMEOUT_MS);
  }

  // ---------- bridge: our side ----------
  function pushOpen(bytes, name) {
    if (!ready) { pendingOpen = { bytes, name }; return; }
    const copy = bytes.slice(0);
    frame.contentWindow.postMessage({ type: 'pov:open', name, bytes: copy }, location.origin, [copy]);
  }

  async function pushFromDisk(showToast) {
    if (!current.path) { toast('Open a PDF from the Files tab first'); return; }
    if (mode === 'embed') { toast('Embedded mode: open the file inside POV itself'); return; }
    setStatus('Loading ' + current.name + '…');
    try {
      const res = await fetch('/api/document/pdf-bytes?path=' + encodeURIComponent(current.path));
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || ('HTTP ' + res.status));
      }
      const bytes = await res.arrayBuffer();
      await statNow(current.path);
      pushOpen(bytes, current.name);
      setStatus(formatSize(bytes.byteLength) + ' · saves to this file');
      if (showToast) toast('Sent to POV');
    } catch (err) {
      setStatus('Could not load: ' + err.message, true);
      toast('Could not load document: ' + err.message, true);
    }
  }

  async function statNow(filepath) {
    try {
      const res = await fetch('/api/filesystem/stat?path=' + encodeURIComponent(filepath));
      if (!res.ok) return null;
      const s = await res.json();
      current.mtimeMs = s.mtimeMs || 0;
      current.size = s.size || 0;
      return s;
    } catch { return null; }
  }

  async function onSave(data) {
    const raw = data && data.bytes;
    const buf = raw instanceof ArrayBuffer ? raw : (raw && raw.buffer instanceof ArrayBuffer ? raw.buffer : null);
    if (!buf) return;
    const name = data.name || current.name || 'document.pdf';

    if (!data.saveAs && current.path) {
      try {
        const res = await fetch('/api/document/save-bytes?path=' + encodeURIComponent(current.path), {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: buf,
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || res.statusText);
        current.mtimeMs = body.mtimeMs || current.mtimeMs;
        current.size = body.size || current.size;
        setStatus('Saved to workspace · ' + new Date().toLocaleTimeString());
        toast('Saved to workspace');
      } catch (err) {
        toast('Workspace save failed: ' + err.message, true);
        download(buf, name);
      }
      return;
    }

    download(buf, name);
    toast('Downloaded a copy — use “Upload” in the POV header to keep it in the workspace');
  }

  function download(bytes, name) {
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name || 'document.pdf';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  function onMessage(ev) {
    if (ev.origin !== location.origin) return;
    if (ev.source !== frame.contentWindow) return;
    const d = ev.data || {};
    if (d.type === 'pov:ready') {
      ready = true;
      clearTimeout(readyTimer);
      hideBanner();
      if (pendingOpen) {
        const p = pendingOpen;
        pendingOpen = null;
        pushOpen(p.bytes, p.name);
      }
      return;
    }
    if (d.type === 'pov:save') { onSave(d); return; }
    if (d.type === 'pov:dirty') {
      dirty = !!d.dirty;
      if (dirty) setStatus('Unsaved changes in POV');
      return;
    }
    if (d.type === 'pov:failed') {
      showBanner('POV could not start: ' + (d.error || 'unknown') + '. Reload, or open it in a new tab.');
      setStatus('POV failed', true);
    }
  }

  // ---------- disk change detection ----------
  function startPolling() {
    clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
      if (mode !== 'proxy' || !current.path) return;
      let s = null;
      try {
        const res = await fetch('/api/filesystem/stat?path=' + encodeURIComponent(current.path));
        if (!res.ok) return;
        s = await res.json();
      } catch { return; }
      if (!s || !s.mtimeMs) return;
      if (!current.mtimeMs) { current.mtimeMs = s.mtimeMs; current.size = s.size; return; }
      if (s.mtimeMs === current.mtimeMs && s.size === current.size) return;
      current.mtimeMs = s.mtimeMs;
      current.size = s.size;
      if (dirty) {
        showBanner('This file changed on disk (AI or another editor). Save or reload POV to pick it up.');
        return;
      }
      await pushFromDisk(false);
      setStatus('Reloaded — file changed on disk', false);
    }, POLL_MS);
  }

  // ---------- the document host used by chat.js ----------
  const host = {
    async open(filepath, ext) {
      if (ext && ext !== '.pdf') {
        window.Copilot.setActiveDocumentPath(filepath);
        window.Copilot.openFileModal(filepath);
        return;
      }
      current = { path: filepath, name: basename(filepath), mtimeMs: 0, size: 0 };
      dirty = false;
      pendingOpen = null;
      setTitle(current.name);
      hideBanner();
      window.Copilot.setActiveDocumentPath(filepath);
      if (!ready) setStatus('Starting POV…');
      await pushFromDisk(false);
    },
    close() {
      current = { path: null, name: null, mtimeMs: 0, size: 0 };
      dirty = false;
      pendingOpen = null;
      setTitle(null);
      setStatus(IDLE_STATUS);
      hideBanner();
      if (mode === 'proxy') {
        ready = false;
        seedPovTheme();
        frame.src = povUrl();
        startReadyTimer();
      }
    },
  };

  // ---------- collapsing the chat ----------
  // Manual work on the document wants the whole pane, so the chat can be dropped
  // away entirely and brought back with the rail button. The last split is kept.
  let reapplySplit = () => {};
  let collapsed = false;

  function setChatCollapsed(next) {
    collapsed = !!next;
    document.body.classList.toggle('chat-collapsed', collapsed);
    try { localStorage.setItem('computera_chat_collapsed', collapsed ? '1' : '0'); } catch {}
    const btn = document.getElementById('chat-collapse');
    if (btn) btn.title = collapsed ? 'Show chat' : 'Collapse chat (work on the document)';
    if (!collapsed) reapplySplit();
  }

  // ---------- chrome ----------
  function wire() {
    document.getElementById('pov-reload').addEventListener('click', () => pushFromDisk(true));
    document.getElementById('pov-newtab').addEventListener('click', () => window.open(frame.src, '_blank'));
    document.getElementById('pov-max').addEventListener('click', () => document.body.classList.toggle('pov-max'));

    const collapseBtn = document.getElementById('chat-collapse');
    if (collapseBtn) collapseBtn.addEventListener('click', () => setChatCollapsed(true));
    const railBtn = document.getElementById('chat-rail-btn');
    if (railBtn) railBtn.addEventListener('click', () => setChatCollapsed(false));
    handle.addEventListener('dblclick', () => setChatCollapsed(!collapsed));
    document.getElementById('pov-banner-reload').addEventListener('click', () => pushFromDisk(true));
    document.getElementById('pov-banner-close').addEventListener('click', hideBanner);

    const input = document.getElementById('pov-upload-input');
    document.getElementById('pov-upload').addEventListener('click', () => input.click());
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      input.value = '';
      if (!file) return;
      try {
        const form = new FormData();
        form.append('file', file);
        const res = await fetch('/api/document/upload', { method: 'POST', body: form });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body.error) throw new Error(body.error || res.statusText);
        await host.open(body.filepath, '.pdf');
        toast('Uploaded ' + file.name);
      } catch (err) { toast('Upload failed: ' + err.message, true); }
    });
  }

  // The split is stored as a percentage but applied in pixels: a saved 22% of a
  // 700px area left the chat pane 158px wide, which crushed the composer. Each
  // pane keeps a usable minimum whatever the saved ratio. Above 1200px the panes
  // sit side by side (chat width); below it they stack (chat height), so the
  // handle drags on whichever axis the layout is currently using.
  const MIN_CHAT = 360, MIN_POV = 320;      // side by side, px
  const MIN_CHAT_H = 300, MIN_POV_H = 300;  // stacked, px

  function initSplit() {
    const wrap = chatPanel.parentElement;
    let dragging = false;
    let pct = 45;

    function metrics() {
      const rect = wrap.getBoundingClientRect();
      const stacked = getComputedStyle(wrap).flexDirection === 'column';
      const gap = stacked ? handle.getBoundingClientRect().height : handle.getBoundingClientRect().width;
      return {
        rect, stacked,
        size: stacked ? rect.height : rect.width,
        minA: stacked ? MIN_CHAT_H : MIN_CHAT,
        minB: stacked ? MIN_POV_H : MIN_POV,
        gap: gap || 6,
      };
    }

    // Chat sits after the handle when stacked, so its size grows upwards.
    function chatSizeAt(e, m) {
      return m.stacked ? m.rect.bottom - e.clientY : e.clientX - m.rect.left;
    }

    function apply(nextPct, persist) {
      const m = metrics();
      if (!m.size) return;
      const maxChat = Math.max(m.minA, m.size - m.gap - m.minB);
      const size = Math.min(maxChat, Math.max(m.minA, (nextPct / 100) * m.size));
      pct = (size / m.size) * 100;
      chatPanel.style.flex = '0 0 ' + Math.round(size) + 'px';
      if (persist) { try { localStorage.setItem('computera_split', String(pct)); } catch {} }
    }

    handle.addEventListener('pointerdown', (e) => {
      dragging = true;
      try { handle.setPointerCapture(e.pointerId); } catch {}
      document.body.classList.add('resizing');
    });
    handle.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const m = metrics();
      if (!m.size) return;
      apply((chatSizeAt(e, m) / m.size) * 100, true);
    });
    handle.addEventListener('pointerup', (e) => {
      dragging = false;
      document.body.classList.remove('resizing');
      try { handle.releasePointerCapture(e.pointerId); } catch {}
    });

    let saved = NaN;
    try { saved = parseFloat(localStorage.getItem('computera_split')); } catch {}
    apply(saved >= 10 && saved <= 90 ? saved : 45, false);
    window.addEventListener('resize', () => apply(pct, false));
    reapplySplit = () => apply(pct, false);
  }

  window.addEventListener('message', onMessage);

  window.addEventListener('DOMContentLoaded', async () => {
    if (window.Copilot) window.Copilot.setDocumentHost(host);
    wire();
    initSplit();
    try { if (localStorage.getItem('computera_chat_collapsed') === '1') setChatCollapsed(true); } catch {}
    try {
      const health = await fetch('/api/health').then((r) => r.json());
      mode = health.povMode === 'embed' ? 'embed' : 'proxy';
    } catch { mode = 'proxy'; }

    if (mode === 'embed') {
      frame.src = POV_EMBED;
      setStatus('Embedded POV from github.io — no save-back to the workspace', true);
    } else {
      seedPovTheme();
      frame.src = povUrl();
      startReadyTimer();
    }

    startPolling();
    const doc = new URLSearchParams(location.search).get('doc');
    if (doc) await host.open(doc, '.pdf');
  });
})();
