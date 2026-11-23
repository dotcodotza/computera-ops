
    // State
    let currentDir = ''; let currentDirParent = null; let directoryFiles = [];
    let activeModel = 'qwen2.5-coder:1.5b'; let availableModels = [];
    let attachedFiles = []; let chatSessions = []; let currentSessionId = null;
    let isGenerating = false; let abortController = null; let currentEditingFilepath = null;
    let activeDocumentPath = null;
    // Kilo state
    let kiloAgent = 'master'; let kiloSessions = []; let currentKiloSessionId = null;
    let kiloAbortController = null; let isKiloGenerating = false; let kiloModels = [];
    let activeTask = null; let taskAutoRan = false;

    // Init
    window.addEventListener('DOMContentLoaded', async () => {
      loadSessionsFromStorage(); loadSettingsFromStorage(); 
      await checkHealthAndModels(); 
      await loadDirectory(); await loadMemories();
      await checkKiloHealth();
      await loadKiloSessions();
      setInterval(checkKiloHealth, 30000);
      renderChatSessionsList();
      renderKiloSessionsList();
      if (!currentSessionId || !chatSessions.find(s => s.id === currentSessionId)) startNewChat();
      else renderCurrentChat();
      await loadTaskContext();
    });

    // ---------- Health & Models ----------
    async function checkHealthAndModels() {
      try {
        const healthRes = await fetch('/api/health'); const healthData = await healthRes.json();
        const badge = document.getElementById('ollama-status'); const text = document.getElementById('ollama-status-text');
        if (healthData.ollamaStatus === 'online') { badge.classList.remove('offline'); text.textContent = 'Ollama Online'; }
        else { badge.classList.add('offline'); text.textContent = 'Ollama Offline'; }
        if (healthData.workspace) { document.getElementById('settings-workspace-path').value = healthData.workspace; document.getElementById('workspace-subtext').textContent = healthData.workspace; }
        const modelsRes = await fetch('/api/models');
        if (modelsRes.ok) { availableModels = (await modelsRes.json()).models || []; }
        try {
          const kiloRes = await fetch('/api/kilo/models');
          if (kiloRes.ok) kiloModels = (await kiloRes.json()).models || [];
        } catch {}
        populateModelDropdowns();
      } catch (err) {
        document.getElementById('ollama-status').classList.add('offline');
        document.getElementById('ollama-status-text').textContent = 'Server Offline';
      }
    }

    function populateModelDropdowns() {
      const headerSelect = document.getElementById('header-model-select'); const settingsSelect = document.getElementById('settings-model-select');
      headerSelect.innerHTML = ''; settingsSelect.innerHTML = '';
      const targets = [headerSelect, settingsSelect];
      if (availableModels.length === 0) {
        targets.forEach(t => t.add(new Option('qwen2.5-coder:1.5b', 'qwen2.5-coder:1.5b')));
      } else {
        availableModels.forEach(m => {
          targets.forEach(t => {
            const o = new Option(m.name, m.name);
            if (m.name === activeModel) o.selected = true;
            t.add(o);
          });
        });
      }
      if (kiloModels.length) {
        targets.forEach(t => {
          const group = document.createElement('optgroup');
          group.label = '🤖 Kilo Gateway';
          kiloModels.forEach(m => {
            const value = 'kilo/' + m.id;
            const o = new Option('Kilo · ' + m.name, value);
            if (value === activeModel) o.selected = true;
            group.appendChild(o);
          });
          t.appendChild(group);
        });
      }
      activeModel = headerSelect.value;
    }

    function changeModel(modelName) { activeModel = modelName; document.getElementById('header-model-select').value = modelName; document.getElementById('settings-model-select').value = modelName; }

    function changeKiloAgent(agent) { kiloAgent = agent; document.getElementById('kilo-agent-select').value = agent; }

    // ---------- Kilo Health & Sessions ----------
    async function checkKiloHealth() {
      try {
        const res = await fetch('/api/kilo/health');
        const data = await res.json();
        const badge = document.getElementById('kilo-status');
        const text = document.getElementById('kilo-status-text');
        if (data.kiloStatus === 'online' || data.healthy === true) {
          badge.classList.remove('offline');
          text.textContent = 'Kilo Online';
        } else {
          badge.classList.add('offline');
          text.textContent = 'Kilo Offline';
        }
      } catch (err) {
        document.getElementById('kilo-status').classList.add('offline');
        document.getElementById('kilo-status-text').textContent = 'Kilo Unreachable';
      }
    }

    async function loadKiloSessions() {
      try {
        const res = await fetch('/api/kilo/sessions');
        const data = await res.json();
        kiloSessions = data.sessions || data || [];
        renderKiloSessionsList();
      } catch (err) {
        console.warn('Could not load Kilo sessions:', err.message);
      }
    }

    async function createKiloSession() {
      try {
        const title = prompt('Session title:', `Task ${new Date().toLocaleTimeString()}`);
        if (!title) return;
        const res = await fetch('/api/kilo/session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, agent: kiloAgent })
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        currentKiloSessionId = data.sessionId;
        await loadKiloSessions();
        switchSidebarTab('kilo');
      } catch (err) { alert('Failed to create Kilo session: ' + err.message); }
    }

    async function selectKiloSession(sessionId) {
      currentKiloSessionId = sessionId;
      renderKiloSessionsList();
      await loadKiloSessionMessages(sessionId);
      await attachActiveKiloRun(sessionId);
      // Show Kilo mode indicator
      const indicator = document.getElementById('active-doc-indicator');
      const session = kiloSessions.find(s => s.id === sessionId);
      if (session) {
        document.getElementById('active-doc-name').textContent = `Kilo: ${session.title} (${session.agent})`;
        indicator.style.display = 'flex';
        indicator.style.background = 'rgba(16, 185, 129, 0.1)';
        indicator.style.borderColor = 'rgba(16, 185, 129, 0.2)';
        indicator.style.color = '#10b981';
      }
    }

    async function loadKiloSessionMessages(sessionId) {
      try {
        const res = await fetch(`/api/kilo/session/${sessionId}/messages`);
        const data = await res.json();
        // Display Kilo messages in chat panel
        renderKiloMessages(Array.isArray(data) ? data : (data.messages || []));
      } catch (err) { console.error('Failed to load Kilo messages:', err); }
    }

    function renderKiloSessionsList() {
      const container = document.getElementById('kilo-sessions-list');
      if (!container) return;
      container.innerHTML = '';
      if (!kiloSessions.length) {
        container.innerHTML = '<div style="color: var(--text-dim); font-size: 12px; text-align: center; padding: 20px 0;">No Kilo sessions yet. Click + to create one.</div>';
        return;
      }
      kiloSessions.forEach(s => {
        const item = document.createElement('div');
        item.className = 'chat-session-item' + (s.id === currentKiloSessionId ? ' active' : '');
        item.onclick = () => selectKiloSession(s.id);
        item.innerHTML = `
          <span class="chat-session-title">${s.title || 'Untitled'} <span style="font-size:10px;color:var(--text-dim);">(${s.agent || 'master'})</span></span>
          <span style="font-size: 10px; color: var(--text-dim);">${s.updatedAt ? new Date(s.updatedAt).toLocaleTimeString() : ''}</span>
        `;
        container.appendChild(item);
      });
    }

    function renderKiloMessages(messages) {
      const welcome = document.getElementById('welcome-screen');
      if (welcome) welcome.style.display = 'none';
      const messagesList = document.getElementById('messages-list');
      messagesList.innerHTML = '';

      const msgArray = Array.isArray(messages) ? messages : (messages.data || []);
      msgArray.forEach(msg => {
        const info = msg.info || msg;
        const parts = msg.parts || msg.content || [];
        const role = info.role || info.type || 'assistant';
        const text = Array.isArray(parts)
          ? parts.filter(p => p && p.type === 'text' && p.text).map(p => p.text).join('')
          : (typeof parts === 'string' ? parts : '');
        if (!text.trim()) return;

        const row = document.createElement('div');
        row.className = `message-row ${role === 'user' ? 'user' : 'assistant'}`;
        const avatar = document.createElement('div');
        avatar.className = 'message-avatar';
        avatar.textContent = role === 'user' ? '👤' : '🤖';
        const body = document.createElement('div');
        body.className = 'message-body';
        const header = document.createElement('div');
        header.className = 'message-header';
        const label = role === 'user' ? 'You' : `Kilo Agent${info.modelID ? ' · ' + info.modelID : ''}`;
        header.innerHTML = `<span class="message-sender"></span>`;
        header.querySelector('.message-sender').textContent = label;
        const content = document.createElement('div');
        content.className = 'message-content';
        content.innerHTML = renderMarkdown(text);
        body.appendChild(header);
        body.appendChild(content);
        row.appendChild(avatar);
        row.appendChild(body);
        messagesList.appendChild(row);
      });
      const c = document.getElementById('messages-container');
      c.scrollTop = c.scrollHeight;
    }

    // ---------- Kilo runs ----------
    // A Kilo run lives on the server (kilo-runs.js); this page only watches it.
    // That is what lets a long task survive a reload, a dropped connection, or a
    // restart of the app. Polling carries an offset, so each read is incremental.
    let currentKiloRunId = null;
    let kiloRunPoll = null;
    let kiloRunClock = null;

    function kiloUiBusy(busy) {
      isKiloGenerating = busy;
      const send = document.getElementById('send-btn');
      const stop = document.getElementById('stop-btn');
      if (send) send.style.display = busy ? 'none' : 'inline-flex';
      if (stop) stop.style.display = busy ? 'inline-flex' : 'none';
    }

    function clearKiloTimers() {
      if (kiloRunPoll) { clearInterval(kiloRunPoll); kiloRunPoll = null; }
      if (kiloRunClock) { clearInterval(kiloRunClock); kiloRunClock = null; }
    }

    function startKiloWatcher(runId, panel, assistantMsg, opts = {}) {
      let accumulated = opts.initialText || '';
      let offset = opts.offset || 0;
      let polling = false;
      const titleEl = panel.row.querySelector ? panel.row.querySelector('.popup-title') : null;
      const startedAt = Date.now() - (opts.elapsedMs || 0);

      const paint = () => {
        panel.content.innerHTML = renderMarkdown(accumulated);
        const c = document.getElementById('messages-container');
        if (c) c.scrollTop = c.scrollHeight;
      };

      const finish = (data) => {
        clearKiloTimers();
        currentKiloRunId = null;
        kiloUiBusy(false);
        panel.content.classList.remove('typing-cursor');
        if (data.status === 'error') {
          if (accumulated.trim()) paint();
          const errEl = document.createElement('div');
          errEl.style.color = 'var(--danger)';
          errEl.style.marginTop = '6px';
          errEl.textContent = '⚠️ ' + (data.error || 'Kilo run failed');
          panel.content.appendChild(errEl);
          return;
        }
        if (data.status === 'stopped') {
          paint();
          const stopped = document.createElement('div');
          stopped.innerHTML = '<em style="color: var(--text-dim);">[Stopped]</em>';
          panel.content.appendChild(stopped);
          return;
        }
        if (!accumulated.trim()) accumulated = '*(No response received)*';
        assistantMsg.content = accumulated;
        if (data.modelID) assistantMsg.model = 'kilo · ' + data.modelID;
        panel.content.innerHTML = renderMarkdown(accumulated);
        saveSessionsToStorage();
        if (activeTask) markTaskSeen();
      };

      const tick = async () => {
        if (polling) return false;
        polling = true;
        try {
          const res = await fetch(`/api/kilo/run/${encodeURIComponent(runId)}?offset=${offset}`);
          if (res.status === 404) { finish({ status: 'error', error: 'This run is no longer tracked (it may predate a restart).' }); return true; }
          if (!res.ok) throw new Error('HTTP ' + res.status);
          const data = await res.json();
          if (data.text) { accumulated += data.text; paint(); }
          if (typeof data.offset === 'number') offset = data.offset;
          if (data.modelID && titleEl) titleEl.textContent = '⚡ Kilo · ' + data.modelID;
          if (data.status !== 'running') { finish(data); return true; }
          if (data.waiting && titleEl) titleEl.textContent = '⚡ Kilo · reconnecting…';
        } catch (err) {
          // A failed poll is not a failed run: the server keeps working and the
          // run state is the truth, so just keep watching.
          if (titleEl) titleEl.textContent = '⚡ Kilo · waiting for server…';
        } finally { polling = false; }
        return false;
      };

      currentKiloRunId = runId;
      kiloUiBusy(true);
      panel.content.classList.add('typing-cursor');
      if (accumulated) paint();

      kiloRunClock = setInterval(() => {
        if (!titleEl || !currentKiloRunId) return;
        const secs = Math.round((Date.now() - startedAt) / 1000);
        const label = secs < 60 ? secs + 's' : Math.floor(secs / 60) + 'm ' + (secs % 60) + 's';
        titleEl.textContent = `⚡ Kilo · working ${label}`;
      }, 1000);

      tick().then((done) => {
        if (done) return;
        kiloRunPoll = setInterval(async () => {
          if (await tick()) { clearInterval(kiloRunPoll); kiloRunPoll = null; }
        }, 1000);
      });
    }

    /** Re-attach to a run this session already has in flight (reload / tab switch). */
    async function attachActiveKiloRun(sessionId) {
      if (!sessionId || isKiloGenerating) return false;
      try {
        const res = await fetch(`/api/kilo/session/${encodeURIComponent(sessionId)}/active-run`);
        if (!res.ok) return false;
        const data = await res.json();
        if (!data.runId || data.status !== 'running') return false;

        // The in-flight answer is already in Kilo's history; drop that rendered
        // copy so the live pop-up is the only one.
        const lastPopup = document.querySelector('#messages-list .response-popup:last-child');
        if (lastPopup && data.text && (lastPopup.textContent || '').includes(data.text.slice(0, 40))) lastPopup.remove();

        const session = getCurrentSession();
        const assistantMsg = {
          role: 'assistant',
          content: data.text || '',
          model: data.modelID ? 'kilo · ' + data.modelID : 'kilo · ' + kiloAgent,
        };
        if (session) { session.messages.push(assistantMsg); saveSessionsToStorage(); }
        const panel = appendMessageElement(assistantMsg);
        startKiloWatcher(data.runId, panel, assistantMsg, {
          initialText: data.text || '',
          offset: data.fullLength || 0,
          elapsedMs: data.elapsedMs || 0,
        });
        return true;
      } catch { return false; }
    }

    // Send message to Kilo session
    async function sendKiloMessage(prefill) {
      if (isKiloGenerating) return;
      const input = document.getElementById('chat-input');
      const text = (typeof prefill === 'string' && prefill.trim()) ? prefill.trim() : input.value.trim();
      if (!text) return;
      if (!currentKiloSessionId) {
        try {
          const created = await fetch('/api/kilo/session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: text.slice(0, 40), agent: kiloAgent })
          });
          const createdData = await created.json();
          if (createdData.error) throw new Error(createdData.error);
          currentKiloSessionId = createdData.sessionId;
          loadKiloSessions();
        } catch (err) { alert('Could not start Kilo session: ' + err.message); return; }
      }

      let session = getCurrentSession();
      if (!session) { startNewChat(); session = getCurrentSession(); }
      if (!session) return;
      const userMsg = { role: 'user', content: text };
      session.messages.push(userMsg);
      if (session.messages.length === 1) session.title = text.slice(0, 28);
      if (!prefill) { input.value = ''; autoResizeTextarea(input); }
      saveSessionsToStorage(); appendMessageElement(userMsg);

      const assistantMsg = { role: 'assistant', content: '', model: 'kilo · ' + kiloAgent };
      const panel = appendMessageElement(assistantMsg);
      const titleEl = panel.row.querySelector ? panel.row.querySelector('.popup-title') : null;
      if (titleEl) titleEl.textContent = '⚡ Kilo · starting…';

      try {
        const res = await fetch(`/api/kilo/session/${encodeURIComponent(currentKiloSessionId)}/run`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt: text,
            model: activeModel.startsWith('kilo/') ? activeModel : undefined,
            agent: kiloAgent,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.runId) throw new Error(data.error || `Kilo error (${res.status})`);
        startKiloWatcher(data.runId, panel, assistantMsg, {
          initialText: data.text || '',
          offset: data.fullLength || 0,
          elapsedMs: data.elapsedMs || 0,
        });
      } catch (err) {
        panel.content.classList.remove('typing-cursor');
        panel.content.innerHTML = '';
        const errEl = document.createElement('div');
        errEl.style.color = 'var(--danger)';
        errEl.textContent = '⚠️ ' + err.message;
        panel.content.appendChild(errEl);
        kiloUiBusy(false);
      }
    }

    // ---------- Task runner context ----------
    const TASK_STATUS_LABEL = { todo: 'Todo', in_progress: 'In progress', review: 'Review', done: 'Done' };

    function appToast(msg, isError) {
      const el = document.createElement('div');
      el.className = 'app-toast' + (isError ? ' error' : '');
      el.textContent = msg;
      document.body.appendChild(el);
      setTimeout(() => el.remove(), 3200);
    }

    async function taskFetch(path, options = {}) {
      const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || res.statusText);
      return data;
    }

    async function loadTaskContext() {
      const taskId = new URLSearchParams(location.search).get('task');
      if (!taskId) return;
      try {
        activeTask = await taskFetch('/api/tasks/' + encodeURIComponent(taskId));
      } catch (err) {
        appToast('Task not found: ' + err.message, true);
        return;
      }
      kiloAgent = activeTask.agent || 'master';
      document.getElementById('kilo-agent-select').value = kiloAgent;
      renderTaskBanner();
      if (activeTask.kilo_session_id) {
        currentKiloSessionId = activeTask.kilo_session_id;
        try {
          const hist = await taskFetch('/api/kilo/session/' + encodeURIComponent(currentKiloSessionId) + '/messages');
          renderKiloMessages(Array.isArray(hist) ? hist : []);
          markTaskSeen(Array.isArray(hist) ? hist : []);
          // A reload in the middle of a task run re-attaches to it instead of
          // starting a second one.
          await attachActiveKiloRun(currentKiloSessionId);
        } catch (err) {
          currentKiloSessionId = null;
          await patchTask({ kilo_session_id: null });
          appToast('Previous Kilo session was not found; starting a fresh run.', true);
          await startTaskRun();
        }
      } else {
        await startTaskRun();
      }
    }

    function renderTaskBanner() {
      const banner = document.getElementById('task-banner');
      if (!activeTask) { banner.classList.add('hidden'); return; }
      banner.classList.remove('hidden');
      document.getElementById('task-banner-title').textContent = activeTask.title;
      const pill = document.getElementById('task-banner-status');
      pill.className = 'task-pill ' + activeTask.status;
      pill.textContent = TASK_STATUS_LABEL[activeTask.status] || activeTask.status;
      document.getElementById('task-banner-meta').textContent =
        (activeTask.agent || 'master') + ' · ' + (activeTask.assignee || 'unassigned') +
        (activeTask.due_date ? ' · due ' + activeTask.due_date : '');
    }

    async function patchTask(patch) {
      if (!activeTask) return null;
      try {
        activeTask = await taskFetch('/api/tasks/' + activeTask.id, { method: 'PATCH', body: JSON.stringify(patch) });
        renderTaskBanner();
        return activeTask;
      } catch (err) { appToast(err.message, true); return null; }
    }

    async function setTaskStatus(status) {
      await patchTask({ status });
      if (status === 'done') appToast('Task marked done');
    }

    function dismissTaskBanner() {
      activeTask = null;
      document.getElementById('task-banner').classList.add('hidden');
      const url = new URL(location.href);
      url.searchParams.delete('task');
      history.replaceState({}, '', url.pathname + (url.search ? url.search : ''));
    }

    async function buildSeedPrompt() {
      let peerLines = [];
      try {
        const data = await taskFetch('/api/tasks?status=in_progress');
        const others = (data.tasks || []).filter(t => t.id !== activeTask.id).slice(0, 3);
        peerLines = others.map(t => '- ' + t.title + ' (' + (t.assignee || 'unassigned') + (t.due_date ? ', due ' + t.due_date : '') + ')');
      } catch {}
      return [
        'Task: ' + activeTask.title,
        activeTask.description ? 'Details: ' + activeTask.description : '',
        'Role: ' + (activeTask.agent || 'master') + ' · Assignee: ' + (activeTask.assignee || 'unassigned') + (activeTask.due_date ? ' · Due: ' + activeTask.due_date : ''),
        peerLines.length ? 'Other active work in the team right now:\n' + peerLines.join('\n') : '',
        'Work directly in the current workspace. Use tools where useful, then finish with a short summary of what changed and any follow-ups.'
      ].filter(Boolean).join('\n\n');
    }

    async function startTaskRun() {
      if (!activeTask || taskAutoRan) return;
      taskAutoRan = true;
      try {
        if (!currentKiloSessionId) {
          const created = await taskFetch('/api/kilo/session', {
            method: 'POST',
            body: JSON.stringify({ title: activeTask.title.slice(0, 60), agent: activeTask.agent || 'master' })
          });
          currentKiloSessionId = created.sessionId;
          loadKiloSessions();
        }
        const patch = { kilo_session_id: currentKiloSessionId };
        if (activeTask.status === 'todo') patch.status = 'in_progress';
        await patchTask(patch);
        const seed = await buildSeedPrompt();
        await sendKiloMessage(seed);
      } catch (err) {
        taskAutoRan = false;
        appToast('Could not start task run: ' + err.message, true);
      }
    }

    async function markTaskSeen(messages) {
      if (!activeTask || !currentKiloSessionId) return;
      try {
        let list = messages;
        if (!list) list = await taskFetch('/api/kilo/session/' + encodeURIComponent(currentKiloSessionId) + '/messages');
        if (!Array.isArray(list)) return;
        const last = [...list].reverse().find(m => (m.info || {}).role === 'assistant');
        if (!last || !last.info?.id) return;
        if (last.info.id === activeTask.last_message_id) return;
        const created = last.info.time?.created;
        await patchTask({
          last_message_id: last.info.id,
          last_run_at: created ? new Date(created).toISOString() : new Date().toISOString(),
        });
      } catch {}
    }

    // ---------- Active Document ----------
    // The document surface belongs to the page. studio.js plugs POV in through
    // setDocumentHost(); the plain chat page has no document pane and sends PDFs
    // to Studio. The workspace path is the contract the AI reads (/api/chat).
    let documentHost = null;

    function setDocumentHost(host) { documentHost = host || null; }

    function pathExt(p) { return p.slice(p.lastIndexOf('.')).toLowerCase(); }
    function pathBasename(p) { return p.split(/[\/]/).pop(); }

    function setActiveDocumentPath(filepath, label = null) {
      activeDocumentPath = filepath || null;
      const indicator = document.getElementById('active-doc-indicator');
      const nameEl = document.getElementById('active-doc-name');
      if (!indicator || !nameEl) return;
      if (!activeDocumentPath) { indicator.style.display = 'none'; return; }
      nameEl.textContent = label || pathBasename(activeDocumentPath);
      indicator.style.display = 'flex';
    }

    async function openDocument(filepath, type = null) {
      const ext = type || pathExt(filepath);
      if (documentHost) return documentHost.open(filepath, ext);
      if (ext === '.pdf') {
        appToast('PDFs open in Studio');
        window.open('/studio?doc=' + encodeURIComponent(filepath), '_blank');
        return;
      }
      setActiveDocumentPath(filepath);
      return openFileModal(filepath);
    }

    async function downloadActiveDocument() {
      if (!activeDocumentPath) return;
      window.open('/api/document/view?path=' + encodeURIComponent(activeDocumentPath), '_blank');
    }

    function closeActiveDocument() {
      setActiveDocumentPath(null);
      if (documentHost && documentHost.close) documentHost.close();
      renderKiloSessionsList();
    }

    // ---------- Filesystem ----------
    async function loadDirectory(dir = '') {
      try {
        const res = await fetch('/api/filesystem/list', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ dirpath: dir }) });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        currentDir = data.dirpath; currentDirParent = data.parent; directoryFiles = data.files || [];
        document.getElementById('files-list-container').innerHTML = '';
        directoryFiles.forEach(f => {
          const item = document.createElement('div'); item.className = 'file-item';
          const info = document.createElement('div'); info.className = 'file-info';
          info.innerHTML = `<span class="file-icon">${getFileIcon(f.name, f.isDirectory)}</span><span class="file-name" title="${f.name}">${f.name}</span>`;
          if (f.isDirectory) info.onclick = () => loadDirectory(f.path);
          else { info.onclick = () => { openFileModal(f.path); }; info.onclick = (e) => { if (!e.target.closest('.file-actions')) openFileModal(f.path); }; }
          const actions = document.createElement('div'); actions.className = 'file-actions';
          if (!f.isDirectory) {
            const attachBtn = document.createElement('button'); attachBtn.className = 'btn btn-icon btn-sm'; attachBtn.title = 'Attach to chat'; attachBtn.innerHTML = '📎'; attachBtn.onclick = (e) => { e.stopPropagation(); attachFileToChat(f.path); };
            actions.appendChild(attachBtn);
            const openBtn = document.createElement('button'); openBtn.className = 'btn btn-icon btn-sm'; openBtn.title = 'Open in viewer'; openBtn.innerHTML = '👁️'; openBtn.onclick = (e) => { e.stopPropagation(); openDocument(f.path); };
            actions.appendChild(openBtn);
          }
          item.appendChild(info); item.appendChild(actions); document.getElementById('files-list-container').appendChild(item);
        });
      } catch (err) { document.getElementById('files-list-container').innerHTML = `<div style="color: var(--danger); font-size: 12px; padding: 10px;">Error: ${err.message}</div>`; }
    }

    function getFileIcon(filename, isDir) { if (isDir) return '📁'; const ext = filename.split('.').pop().toLowerCase(); const m = { js:'🟨', mjs:'🟨', html:'🌐', css:'🎨', json:'📦', md:'📝', txt:'📄', pdf:'📕', png:'🖼️', jpg:'🖼️', jpeg:'🖼️' }; return m[ext] || '📄'; }

    // ---------- File Uploads ----------
    function handleDrop(ev) {
      ev.preventDefault();
      const dropped = ev.dataTransfer && ev.dataTransfer.files;
      if (dropped && dropped.length) handleFileUploads(dropped);
    }

    async function handleFileUploads(files) {
      const list = Array.from(files || []);
      if (list.length === 0) return;
      // The upload endpoint accepts one file per request, so send them one at a time
      let last = null;
      for (const f of list) {
        const formData = new FormData();
        formData.append('file', f);
        try {
          const res = await fetch('/api/document/upload', { method: 'POST', body: formData });
          const d = await res.json();
          if (d.error) { alert(`Upload error (${f.name}): ${d.error}`); continue; }
          last = d;
        } catch (e) { alert(`Upload failed (${f.name}): ${e.message}`); }
      }
      await loadDirectory();
      if (last && last.filepath) await openDocument(last.filepath);
    }

    // ---------- File Modal ----------
    async function openFileModal(filepath) {
      try {
        const res = await fetch('/api/filesystem/read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filepath }) });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        currentEditingFilepath = data.filepath;
        document.getElementById('modal-filename').textContent = data.name;
        document.getElementById('modal-filepath-info').textContent = data.filepath;
        document.getElementById('modal-filesize-info').textContent = formatFileSize(data.size);
        document.getElementById('modal-file-content').value = data.content;
        document.getElementById('file-modal').classList.add('active');
      } catch (err) { alert('Could not open file: ' + err.message); }
    }

    async function saveModalFile() { if (!currentEditingFilepath) return; try { const res = await fetch('/api/filesystem/write', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filepath: currentEditingFilepath, content: document.getElementById('modal-file-content').value }) }); const d = await res.json(); if (d.error) throw new Error(d.error); alert('Saved'); loadDirectory(); closeModal('file-modal'); } catch (err) { alert('Failed: ' + err.message); } }
    async function attachCurrentModalFile() { if (currentEditingFilepath) { await attachFileToChat(currentEditingFilepath); closeModal('file-modal'); } }

    function formatFileSize(bytes) { if (!bytes) return '0 B'; const k = 1024; const sizes = ['B','KB','MB','GB']; const i = Math.floor(Math.log(bytes) / Math.log(k)); return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]; }

    // ---------- Attachments ----------
    async function attachFileToChat(filepath) {
      try {
        const res = await fetch('/api/filesystem/read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filepath }) });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        if (!attachedFiles.some(f => f.filepath === data.filepath)) {
          attachedFiles.push({ filepath: data.filepath, name: data.name, content: data.content, type: pathExt(data.filepath) });
          renderAttachmentsBar();
        }
      } catch (err) { alert('Failed to attach: ' + err.message); }
    }
    function removeAttachment(i) { attachedFiles.splice(i, 1); renderAttachmentsBar(); }
    function renderAttachmentsBar() {
      const bar = document.getElementById('attachments-bar'); bar.innerHTML = '';
      attachedFiles.forEach((f, idx) => {
        const chip = document.createElement('div'); chip.className = 'attachment-chip';
        chip.innerHTML = `<span>📄 ${f.name}</span> <span class="remove-chip" onclick="removeAttachment(${idx})">✕</span>`;
        bar.appendChild(chip);
      });
    }
    function openFilePickerModal() { document.getElementById('file-upload-input').click(); }

    // ---------- Chat ----------
    async function sendMessage() {
      // Route to Kilo if a Kilo session is active or a Kilo model is selected
      if (currentKiloSessionId || activeModel.startsWith('kilo/')) return sendKiloMessage();
      
      if (isGenerating) return;
      const input = document.getElementById('chat-input'); const text = input.value.trim();
      if (!text && attachedFiles.length === 0) return;
      const session = getCurrentSession(); if (!session) return;
      let fullPrompt = text; const currentAttachments = [...attachedFiles];
      if (currentAttachments.length > 0) {
        const attCtx = currentAttachments.map(f => `[Attached File: ${f.name}]\n\`\`\`\n${f.content}\n\`\`\``).join('\n\n');
        fullPrompt = `${attCtx}\n\nUser Question:\n${text || 'Inspect attached files.'}`;
      }
      const userMsg = { role: 'user', content: text || 'Inspect attached files', attachments: currentAttachments };
      session.messages.push(userMsg);
      if (session.messages.length === 1) session.title = (text || currentAttachments[0]?.name || 'Chat').slice(0, 28);
      input.value = ''; attachedFiles = []; renderAttachmentsBar(); autoResizeTextarea(input);
      saveSessionsToStorage(); appendMessageElement(userMsg);
      const assistantMsg = { role: 'assistant', content: '', model: activeModel };
      const { row, content, body } = appendMessageElement(assistantMsg); content.classList.add('typing-cursor');
      isGenerating = true; document.getElementById('send-btn').style.display = 'none'; document.getElementById('stop-btn').style.display = 'inline-flex';
      abortController = new AbortController();
      try {
        const history = session.messages.map(m => {
          if (m.role === 'user' && m.attachments && m.attachments.length > 0) {
            const attText = m.attachments.map(f => `[File: ${f.name}]\n\`\`\`\n${f.content}\n\`\`\``).join('\n\n');
            return { role: 'user', content: `${attText}\n\n${m.content}` };
          }
          return { role: m.role, content: m.content };
        });
        const customSystem = document.getElementById('settings-system-prompt').value.trim();
        const response = await fetch('/api/chat', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: activeModel, messages: history, system: customSystem || undefined, stream: true, enableTools: true, activeDocumentPath }),
          signal: abortController.signal
        });
        if (!response.ok) { const e = await response.text(); throw new Error(`Server error (${response.status}): ${e}`); }
        const reader = response.body.getReader(); const decoder = new TextDecoder(); let accumulated = ''; let buffer = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n'); buffer = lines.pop();
          for (const line of lines) {
            if (!line.trim()) continue;
            try { const chunk = JSON.parse(line); if (chunk.error) throw new Error(chunk.error); if (chunk.message?.content) { accumulated += chunk.message.content; content.innerHTML = renderMarkdown(accumulated); document.getElementById('messages-container').scrollTop = document.getElementById('messages-container').scrollHeight; } } catch {} }
        }
        if (!accumulated.trim()) accumulated = '*(No response received)*';
        assistantMsg.content = accumulated; content.classList.remove('typing-cursor'); content.innerHTML = renderMarkdown(accumulated); saveSessionsToStorage();
      } catch (err) {
        if (err.name === 'AbortError') { content.classList.remove('typing-cursor'); content.innerHTML += '<br><em style="color: var(--text-dim);">[Stopped]</em>'; }
        else { content.classList.remove('typing-cursor'); content.innerHTML = `<span style="color: var(--danger);">⚠️ Error: ${err.message}</span>`; }
      } finally { isGenerating = false; abortController = null; document.getElementById('send-btn').style.display = 'inline-flex'; document.getElementById('stop-btn').style.display = 'none'; }
    }

    function stopGeneration() {
      if (abortController) abortController.abort();
      if (kiloAbortController) kiloAbortController.abort();
      // Stop the run server-side too, so it does not keep working unseen.
      if (currentKiloRunId) fetch(`/api/kilo/run/${encodeURIComponent(currentKiloRunId)}/stop`, { method: 'POST' }).catch(() => {});
    }

    function renderMarkdown(text) {
      if (!window.marked) return text;
      try {
        const raw = marked.parse(text); const temp = document.createElement('div'); temp.innerHTML = raw;
        temp.querySelectorAll('pre code').forEach(block => {
          hljs.highlightElement(block);
          const pre = block.parentElement;
          const lang = block.className.match(/language-(\w+)/)?.[1] || 'code';
          const header = document.createElement('div'); header.className = 'code-header';
          header.innerHTML = `<span>${lang}</span><button class="copy-btn" onclick="copyCode(this)">Copy</button><button class="save-btn" onclick="saveCodeBlock(this)">💾 Save to File</button>`;
          pre.insertBefore(header, block);
        });
        return temp.innerHTML;
      } catch (e) { return text; }
    }

    function copyCode(btn) { const code = btn.closest('pre').querySelector('code').innerText; navigator.clipboard.writeText(code).then(() => { btn.textContent = 'Copied!'; setTimeout(() => btn.textContent = 'Copy', 1500); }); }
    async function saveCodeBlock(btn) {
      const codeEl = btn.closest('.code-header')?.nextElementSibling; if (!codeEl) return;
      const code = (codeEl.querySelector('code') || codeEl).innerText;
      const name = prompt('Save as:', `output_${Date.now()}.txt`);
      if (!name) return;
      try {
        const res = await fetch('/api/filesystem/write', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filepath: name, content: code }) });
        const d = await res.json();
        if (d.error) throw new Error(d.error);
        btn.textContent = '✅ Saved'; setTimeout(() => btn.textContent = '💾 Save to File', 1500);
      } catch (e) { alert('Save failed: ' + e.message); }
    }

    // ---------- Draggable response pop-ups ----------
    let popupSeq = 0;
    let popupZ = 10;

    // The pop-ups live in a window-level layer, so they can be dragged anywhere
    // on screen, including over the POV pane in the Studio split view.
    function responseLayer() {
      let layer = document.getElementById('response-layer');
      if (!layer) {
        layer = document.createElement('div');
        layer.id = 'response-layer';
        document.body.appendChild(layer);
      }
      return layer;
    }

    function clearResponses() {
      const layer = document.getElementById('response-layer');
      if (layer) layer.innerHTML = '';
      popupSeq = 0;
    }

    function placePopup(pop) {
      responseLayer();
      const gap = 14;
      const viewW = window.innerWidth;
      const viewH = window.innerHeight;
      const width = Math.max(280, Math.min(560, viewW - gap * 2));
      const step = popupSeq++ % 8;
      const maxX = Math.max(gap, viewW - width - gap);
      const maxY = Math.max(gap, viewH - 200);
      pop.style.width = width + 'px';
      pop.style.left = Math.max(gap, maxX - step * 22) + 'px';
      pop.style.top = Math.max(gap, Math.min(maxY, 78 + step * 24)) + 'px';
    }

    function makeDraggable(pop, handle) {
      handle.style.touchAction = 'none';
      handle.addEventListener('pointerdown', (e) => {
        if (e.target.closest('button')) return;
        e.preventDefault();
        responseLayer();
        const rect = pop.getBoundingClientRect();
        const grabX = e.clientX - rect.left;
        const grabY = e.clientY - rect.top;
        try { handle.setPointerCapture(e.pointerId); } catch {}
        pop.classList.add('dragging');
        pop.style.zIndex = String(++popupZ);
        const move = (ev) => {
          const maxX = Math.max(0, window.innerWidth - pop.offsetWidth);
          const maxY = Math.max(0, window.innerHeight - Math.min(pop.offsetHeight, 64));
          pop.style.left = Math.min(maxX, Math.max(0, ev.clientX - grabX)) + 'px';
          pop.style.top = Math.min(maxY, Math.max(0, ev.clientY - grabY)) + 'px';
        };
        const up = () => {
          pop.classList.remove('dragging');
          handle.removeEventListener('pointermove', move);
          handle.removeEventListener('pointerup', up);
          handle.removeEventListener('pointercancel', up);
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', up);
        handle.addEventListener('pointercancel', up);
      });
      pop.addEventListener('pointerdown', () => { pop.style.zIndex = String(++popupZ); });
    }

    function appendMessageElement(msg, scroll = true) {
      const welcome = document.getElementById('welcome-screen'); if (welcome) welcome.style.display = 'none';
      const messagesList = document.getElementById('messages-list');
      const content = document.createElement('div'); content.className = 'message-content';

      // Assistant replies float as draggable pop-up windows.
      if (msg.role === 'assistant') {
        content.innerHTML = renderMarkdown(msg.content || '');
        const pop = document.createElement('div'); pop.className = 'response-popup';
        pop.style.zIndex = String(++popupZ);
        const bar = document.createElement('div'); bar.className = 'response-popup-bar';
        const grip = document.createElement('span'); grip.className = 'popup-grip'; grip.textContent = '⠿'; grip.title = 'Drag to move';
        const title = document.createElement('span'); title.className = 'popup-title'; title.textContent = `⚡ ${msg.model || 'Computera AI'}`;
        const actions = document.createElement('div'); actions.className = 'popup-actions';
        const minBtn = document.createElement('button'); minBtn.type = 'button'; minBtn.className = 'popup-btn'; minBtn.title = 'Collapse'; minBtn.textContent = '–';
        minBtn.addEventListener('click', () => pop.classList.toggle('collapsed'));
        const closeBtn = document.createElement('button'); closeBtn.type = 'button'; closeBtn.className = 'popup-btn'; closeBtn.title = 'Close'; closeBtn.textContent = '✕';
        closeBtn.addEventListener('click', () => pop.remove());
        actions.append(minBtn, closeBtn);
        bar.append(grip, title, actions);
        const body = document.createElement('div'); body.className = 'response-popup-body';
        body.appendChild(content);
        pop.append(bar, body);
        responseLayer().appendChild(pop);
        placePopup(pop);
        makeDraggable(pop, bar);
        return { row: pop, content, body };
      }

      // User messages stay in the conversation flow.
      const row = document.createElement('div'); row.className = 'message-row user';
      const avatar = document.createElement('div'); avatar.className = 'message-avatar'; avatar.textContent = '👤';
      const body = document.createElement('div'); body.className = 'message-body';
      const header = document.createElement('div'); header.className = 'message-header';
      header.innerHTML = '<span class="message-sender">You</span>';
      content.textContent = msg.content;
      body.appendChild(header); body.appendChild(content); row.appendChild(avatar); row.appendChild(body); messagesList.appendChild(row);
      if (scroll) { const c = document.getElementById('messages-container'); c.scrollTop = c.scrollHeight; }
      return { row, content, body };
    }

    function handleInputKeydown(e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }
    function autoResizeTextarea(el) { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; }

    // ---------- Sessions ----------
    function loadSessionsFromStorage() { try { chatSessions = JSON.parse(localStorage.getItem('computera_chat_sessions') || '[]'); } catch { chatSessions = []; } }
    function saveSessionsToStorage() { try { localStorage.setItem('computera_chat_sessions', JSON.stringify(chatSessions)); } catch {} }
    function startNewChat() { const s = { id: 'session_' + Date.now(), title: 'New Conversation', messages: [], createdAt: new Date().toISOString() }; chatSessions.unshift(s); currentSessionId = s.id; saveSessionsToStorage(); renderChatSessionsList(); renderCurrentChat(); }
    function selectSession(id) { currentSessionId = id; renderChatSessionsList(); renderCurrentChat(); }
    function deleteSession(id, e) { e.stopPropagation(); if (chatSessions.length <= 1) { startNewChat(); return; } chatSessions = chatSessions.filter(s => s.id !== id); if (currentSessionId === id) currentSessionId = chatSessions[0].id; saveSessionsToStorage(); renderChatSessionsList(); renderCurrentChat(); }
    function renderChatSessionsList() { const c = document.getElementById('chat-sessions-list'); c.innerHTML = ''; chatSessions.forEach(s => { const item = document.createElement('div'); item.className = 'chat-session-item' + (s.id === currentSessionId ? ' active' : ''); item.onclick = () => selectSession(s.id); const title = document.createElement('div'); title.className = 'chat-session-title'; title.textContent = s.title || 'Conversation'; const del = document.createElement('button'); del.className = 'btn-icon btn-sm'; del.innerHTML = '✕'; del.title = 'Delete'; del.onclick = (e) => deleteSession(s.id, e); item.appendChild(title); item.appendChild(del); c.appendChild(item); }); }
    function getCurrentSession() { return chatSessions.find(s => s.id === currentSessionId); }
    function clearCurrentChat() { const s = getCurrentSession(); if (s) { s.messages = []; saveSessionsToStorage(); renderCurrentChat(); } }
    function renderCurrentChat() { clearResponses(); const welcome = document.getElementById('welcome-screen'); const list = document.getElementById('messages-list'); const s = getCurrentSession(); if (!s || s.messages.length === 0) { if (welcome) welcome.style.display = 'flex'; if (list) list.innerHTML = ''; return; } if (welcome) welcome.style.display = 'none'; if (list) { list.innerHTML = ''; s.messages.forEach(m => appendMessageElement(m, false)); } const c = document.getElementById('messages-container'); if (c) c.scrollTop = c.scrollHeight; }

    // ---------- Sidebar ----------
    function toggleSidebar() { document.getElementById('sidebar').classList.toggle('collapsed'); }
    function switchSidebarTab(tab) { document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.remove('active')); document.querySelectorAll('.sidebar-pane').forEach(p => p.classList.remove('active')); document.getElementById(`tab-${tab}`).classList.add('active'); event?.target?.classList.add('active'); }

    // ---------- Memory ----------
    async function loadMemories() {
      try { const d = await fetch('/api/memory/list').then(r => r.json()); const c = document.getElementById('memory-list-container'); c.innerHTML = ''; if (!d.memories || d.memories.length === 0) { c.innerHTML = '<div style="color: var(--text-dim); text-align: center; padding: 20px;">No memories</div>'; return; } d.memories.forEach(m => { const card = document.createElement('div'); card.className = 'memory-card'; card.innerHTML = `<div style="display:flex;justify-content:space-between;"><span class="memory-key">${m.key}</span><button class="btn btn-icon btn-sm" onclick="deleteMemory('${m.key}')">🗑️</button></div><div class="memory-data">${typeof m.data === 'object' ? JSON.stringify(m.data, null, 2) : m.data}</div><button class="btn btn-sm btn-secondary" onclick="injectMemory('${m.key}')" style="margin-top:4px;">Inject to Chat</button>`; c.appendChild(card); }); } catch {}
    }
    async function injectMemory(key) { try { const d = await fetch(`/api/memory/load/${encodeURIComponent(key)}`).then(r => r.json()); const content = typeof d.data === 'object' ? JSON.stringify(d.data, null, 2) : d.data; document.getElementById('chat-input').value = `Here is memory [${key}]:\n\`\`\`\n${content}\n\`\`\`\nPlease review.`; autoResizeTextarea(document.getElementById('chat-input')); } catch {} }
    async function deleteMemory(key) { if (!confirm('Delete?')) return; await fetch(`/api/memory/delete/${encodeURIComponent(key)}`, { method: 'DELETE' }); loadMemories(); }
    function openNewMemoryModal() { document.getElementById('new-memory-key').value = ''; document.getElementById('new-memory-data').value = ''; document.getElementById('new-memory-modal').classList.add('active'); }
    async function saveNewMemorySubmit() { const key = document.getElementById('new-memory-key').value.trim(); const data = document.getElementById('new-memory-data').value.trim(); if (!key) return; try { await fetch('/api/memory/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, data }) }); closeModal('new-memory-modal'); loadMemories(); } catch (e) { alert('Failed: ' + e.message); } }

    // ---------- Modals & Files ----------
    function openNewFileModal() { document.getElementById('new-filename-input').value = ''; document.getElementById('new-file-initial-content').value = ''; document.getElementById('new-file-modal').classList.add('active'); }
    async function createNewFileSubmit() { const name = document.getElementById('new-filename-input').value.trim(); const content = document.getElementById('new-file-initial-content').value; if (!name) return; try { await fetch('/api/filesystem/write', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filepath: name, content }) }); closeModal('new-file-modal'); loadDirectory(); alert('Created: ' + name); } catch (e) { alert('Failed: ' + e.message); } }
    function closeModal(id) { document.getElementById(id).classList.remove('active'); }
    function saveSettings() {
      try {
        localStorage.setItem('computera_settings', JSON.stringify({ systemPrompt: document.getElementById('settings-system-prompt').value, model: activeModel }));
      } catch {}
      alert('Settings saved!');
    }
    function loadSettingsFromStorage() {
      try {
        const s = JSON.parse(localStorage.getItem('computera_settings') || 'null');
        if (!s) return;
        if (s.systemPrompt) document.getElementById('settings-system-prompt').value = s.systemPrompt;
        if (s.model) activeModel = s.model;
      } catch {}
    }

    // ---------- Shell hooks (used by studio.html / studio.js) ----------
    window.Copilot = {
      setDocumentHost,
      openDocument,
      downloadActiveDocument,
      closeActiveDocument,
      setActiveDocumentPath,
      getActiveDocumentPath: () => activeDocumentPath,
      openFileModal,
      baseName: pathBasename,
      extOf: pathExt,
      uploadFiles: handleFileUploads,
      toast: appToast,
    };
