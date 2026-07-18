(function () {
  const PROJECT_ORDER = ['grup', 'personal'];
  let sessionSummary = { grup: { connected: false, label: 'Taxio (Grup)' }, personal: { connected: false, label: 'Taxio.me' } };
  let entities = [];
  let selectedEntity = null;
  let connectFormOpen = null; // project id currently showing its inline connect form, or null

  function $(id) { return document.getElementById(id); }
  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function api(path, opts) {
    const res = await fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts));
    let body = null;
    try { body = await res.json(); } catch (e) {}
    if (!res.ok) throw new Error((body && body.error) || ('Request gagal (' + res.status + ')'));
    return body;
  }

  // ---------- Connections bar ----------
  function renderConnections() {
    const bar = $('connections-bar');
    bar.innerHTML = PROJECT_ORDER.map((id) => {
      const s = sessionSummary[id] || { connected: false, label: id };
      if (s.connected) {
        return '<div class="conn-card connected">'
          + '<div class="conn-card-title">' + escapeHtml(s.label) + '</div>'
          + '<div class="conn-card-sub">' + escapeHtml(s.email) + '</div>'
          + '<button class="btn btn-ghost btn-sm" data-disconnect="' + id + '">Putuskan</button>'
          + '</div>';
      }
      const formOpen = connectFormOpen === id;
      return '<div class="conn-card">'
        + '<div class="conn-card-title">' + escapeHtml(s.label) + '</div>'
        + (formOpen
          ? '<input type="email" class="conn-email" placeholder="Email" id="conn-email-' + id + '">'
            + '<input type="password" class="conn-pass" placeholder="Kata sandi" id="conn-pass-' + id + '">'
            + '<div class="conn-card-actions">'
            + '<button class="btn btn-primary btn-sm" data-connect-submit="' + id + '">Hubungkan</button>'
            + '<button class="btn btn-ghost btn-sm" data-connect-cancel="' + id + '">Batal</button>'
            + '</div>'
            + '<div class="error-text" id="conn-error-' + id + '"></div>'
          : '<button class="btn btn-outline btn-sm" data-connect-open="' + id + '">Hubungkan</button>')
        + '</div>';
    }).join('');

    bar.querySelectorAll('[data-connect-open]').forEach((b) => b.addEventListener('click', () => { connectFormOpen = b.dataset.connectOpen; renderConnections(); }));
    bar.querySelectorAll('[data-connect-cancel]').forEach((b) => b.addEventListener('click', () => { connectFormOpen = null; renderConnections(); }));
    bar.querySelectorAll('[data-connect-submit]').forEach((b) => b.addEventListener('click', () => doConnect(b.dataset.connectSubmit)));
    bar.querySelectorAll('[data-disconnect]').forEach((b) => b.addEventListener('click', () => doDisconnect(b.dataset.disconnect)));

    const anyConnected = PROJECT_ORDER.some((id) => sessionSummary[id] && sessionSummary[id].connected);
    const showApp = anyConnected || manualStatus.loggedIn;
    $('main-layout').style.display = showApp ? 'grid' : 'none';
    $('empty-hint').style.display = showApp ? 'none' : 'flex';
    renderSessionBar();
    if (showApp) loadEntities();
  }

  // "Login as" = who you're logged into CORETAX as (NPWP · name), NOT the Taxio/gmail account
  // used to connect. Sources: the manual Coretax window's detected identity, (while an
  // automation run is active) the entity currently being impersonated, and the last confirmed
  // standalone Login (persists after that action finishes - see lib/login-status.js for why).
  let lastRunStatus = { active: false };
  let lastLoginStatus = null;
  function renderSessionBar() {
    const chips = [];
    if (manualStatus.loggedIn) chips.push({ who: manualStatus.identity || 'Sesi Coretax (nama belum terbaca)', src: 'Coretax · Manual', manual: true });
    if (lastRunStatus && lastRunStatus.active && lastRunStatus.coretaxAs) chips.push({ who: lastRunStatus.coretaxAs, src: 'Coretax · Otomasi', manual: false });
    else if (lastLoginStatus && lastLoginStatus.at) chips.push({ who: (lastLoginStatus.npwp ? lastLoginStatus.npwp + ' · ' : '') + lastLoginStatus.name, src: 'Coretax · Login', manual: false });
    const bar = $('session-bar');
    if (!chips.length) { bar.style.display = 'none'; bar.innerHTML = ''; return; }
    bar.style.display = 'flex';
    bar.innerHTML = '<span class="lead">Login as</span>' + chips.map((c) =>
      '<span class="session-chip' + (c.manual ? ' manual' : '') + '"><span class="dot"></span>'
      + '<span class="who">' + escapeHtml(c.who) + '</span><span class="src">· ' + escapeHtml(c.src) + '</span></span>'
    ).join('');
  }

  // ---------- Settings overlay ----------
  function openSettings() { $('settings-overlay').style.display = 'flex'; renderConnections(); }
  function closeSettings() { $('settings-overlay').style.display = 'none'; }
  $('settings-btn').addEventListener('click', openSettings);
  $('settings-close').addEventListener('click', closeSettings);
  $('empty-settings-btn').addEventListener('click', openSettings);
  $('settings-overlay').addEventListener('click', (e) => { if (e.target === $('settings-overlay')) closeSettings(); });

  async function doConnect(projectId) {
    const email = $('conn-email-' + projectId).value.trim();
    const password = $('conn-pass-' + projectId).value;
    const errEl = $('conn-error-' + projectId);
    errEl.textContent = '';
    if (!email || !password) { errEl.textContent = 'Email & kata sandi wajib diisi.'; return; }
    try {
      sessionSummary = await api('/api/connect', { method: 'POST', body: JSON.stringify({ project: projectId, email, password }) });
      connectFormOpen = null;
      renderConnections();
    } catch (e) {
      errEl.textContent = e.message;
    }
  }
  async function doDisconnect(projectId) {
    sessionSummary = await api('/api/disconnect', { method: 'POST', body: JSON.stringify({ project: projectId }) });
    selectedEntity = null;
    renderConnections();
  }

  $('quit-btn').addEventListener('click', async () => {
    if (!confirm('Tutup Coretax Agent sepenuhnya?')) return;
    await api('/api/quit', { method: 'POST' });
  });

  $('open-coretax-btn').addEventListener('click', async () => {
    $('open-coretax-btn').disabled = true;
    try { await api('/api/actions/open-coretax', { method: 'POST' }); startManualPolling(); }
    catch (e) { alert('Gagal membuka Coretax: ' + e.message); }
    finally { setTimeout(() => { $('open-coretax-btn').disabled = false; }, 2000); }
  });

  // ---------- Manual-login status ----------
  let manualStatus = { open: false, loggedIn: false, identity: '' };
  let manualPollTimer = null;
  function startManualPolling() {
    if (manualPollTimer) return;
    manualPollTimer = setInterval(pollManualStatus, 2000);
    pollManualStatus();
  }
  async function pollManualStatus() {
    let st;
    try { st = await api('/api/manual/status'); } catch (e) { return; }
    const was = manualStatus.loggedIn;
    manualStatus = st;
    const btn = $('open-coretax-btn');
    const checkBtn = $('check-manual-btn');
    // The "🔄 Cek Login" button shows whenever a manual window is open (so you can force a
    // re-check the moment you finish logging in, without waiting for the next auto-poll).
    checkBtn.style.display = st.open ? 'inline-flex' : 'none';
    if (st.loggedIn) { const who = st.identity ? (st.identity.length > 28 ? st.identity.slice(0, 28) + '…' : st.identity) : 'aktif'; btn.textContent = '● Manual: ' + who; btn.title = 'Login manual aktif' + (st.identity ? (' — ' + st.identity) : ''); btn.classList.add('btn-gold'); btn.classList.remove('btn-outline'); }
    else if (st.open) { btn.textContent = 'Menunggu login...'; btn.classList.remove('btn-gold'); btn.classList.add('btn-outline'); }
    else { btn.textContent = 'Login Coretax'; btn.classList.remove('btn-gold'); btn.classList.add('btn-outline'); if (manualPollTimer) { clearInterval(manualPollTimer); manualPollTimer = null; } }
    renderSessionBar(); // keep the "Login as" chip fresh as the identity resolves
    // When manual login just became available (or dropped), refresh the entity list so the
    // synthetic "Sesi Manual" entity appears/disappears, the layout shows, and it auto-selects.
    if (st.loggedIn !== was) { renderConnections(); }
  }
  $('check-manual-btn').addEventListener('click', async () => {
    const b = $('check-manual-btn'); b.disabled = true; b.textContent = '🔄 Mengecek...';
    await pollManualStatus();
    setTimeout(() => { b.disabled = false; b.textContent = '🔄 Cek Login'; }, 500);
    if (!manualStatus.loggedIn) log_local('Belum terdeteksi login. Pastikan sudah masuk ke Coretax di jendela yang terbuka, lalu klik "Cek Login" lagi.');
  });
  function manualEntity() {
    if (!manualStatus.loggedIn) return null;
    return { entity_id: 'MANUAL', entity_name: manualStatus.identity ? ('Sesi Manual · ' + manualStatus.identity) : 'Sesi Manual', npwp: '', individual: false, pic_id: 'manual', pic_name: 'Login manual', pic_is_mine: true, project: 'manual', project_label: 'Manual' };
  }

  // ---------- Entities ----------
  async function loadEntities() {
    const list = $('entity-list');
    list.innerHTML = '<div class="muted pad">Memuat...</div>';
    const anySupa = PROJECT_ORDER.some((id) => sessionSummary[id] && sessionSummary[id].connected);
    let supa = [];
    if (anySupa) {
      try {
        const data = await api('/api/entities');
        supa = data.entities || [];
        if (data.errors && data.errors.length) log_local('Sebagian entitas gagal dimuat: ' + data.errors.join('; '));
      } catch (e) {
        log_local('Gagal memuat entitas dari akun: ' + e.message);
      }
    }
    // The manual session (if logged in) is presented as a selectable entity at the top, so the
    // exact same e-Bupot form/run works against whatever you logged into by hand.
    const me = manualEntity();
    entities = (me ? [me] : []).concat(supa);
    if (!entities.length) { list.innerHTML = '<div class="muted pad">Belum ada entitas. Hubungkan akun di Pengaturan, atau Login Coretax.</div>'; return; }
    // Manual login has exactly one active entity (whatever you impersonated in Coretax), so
    // auto-select it - no need to pick from a list. Only auto-selects when nothing's chosen yet
    // or the previous choice was the manual entity, so a deliberate Taxio pick isn't overridden.
    if (me && (!selectedEntity || selectedEntity.project === 'manual')) {
      selectedEntity = me;
      renderActionForm();
    }
    renderEntities();
  }
  function log_local(msg) {
    const view = $('log-view');
    const line = document.createElement('div');
    line.className = 'log-line';
    line.textContent = '[gui] ' + msg;
    view.appendChild(line);
    view.scrollTop = view.scrollHeight;
  }

  function renderEntities() {
    const list = $('entity-list');
    const q = $('entity-search').value.trim().toLowerCase();
    const filtered = entities.filter((e) => !q || e.entity_name.toLowerCase().indexOf(q) !== -1 || e.entity_id.toLowerCase().indexOf(q) !== -1);
    if (!filtered.length) { list.innerHTML = '<div class="muted pad">Tidak ada entitas ditemukan.</div>'; return; }
    list.innerHTML = filtered.map((e) => {
      const idx = entities.indexOf(e);
      const isSelected = selectedEntity && selectedEntity.entity_id === e.entity_id && selectedEntity.pic_id === e.pic_id && selectedEntity.project === e.project;
      return '<div class="entity-row' + (isSelected ? ' selected' : '') + '" data-idx="' + idx + '">'
        + '<div class="entity-name">' + escapeHtml(e.entity_name) + ' <span class="project-tag">' + escapeHtml(e.project_label) + '</span></div>'
        + '<div class="entity-meta">' + escapeHtml(e.entity_id) + ' · PIC: ' + escapeHtml(e.pic_name) + (e.pic_is_mine === false ? ' (bukan milik Anda)' : '') + '</div>'
        + '</div>';
    }).join('');
    list.querySelectorAll('.entity-row').forEach((row) => {
      row.addEventListener('click', () => {
        selectedEntity = entities[parseInt(row.dataset.idx, 10)];
        renderEntities();
        renderActionForm();
      });
    });
  }
  $('entity-search').addEventListener('input', renderEntities);

  function renderActionForm() {
    if (!selectedEntity) return;
    $('no-entity-hint').style.display = 'none';
    $('action-form-body').style.display = 'block';
    $('selected-entity-label').textContent = selectedEntity.entity_name + ' (' + selectedEntity.entity_id + ') · ' + selectedEntity.project_label;
    // Manual sessions already log themselves in by hand - the standalone Login action is only
    // meaningful for Taxio/Taxio.me entities that need credential login + impersonate.
    $('login-only-btn').style.display = selectedEntity.project === 'manual' ? 'none' : 'block';
    updateFormForBupot();
  }
  $('login-only-btn').addEventListener('click', async () => {
    if (!selectedEntity) return;
    const btn = $('login-only-btn');
    btn.disabled = true;
    try {
      await api('/api/actions/login-entity', { method: 'POST', body: JSON.stringify({ entity: selectedEntity }) });
      pollRunStatus(); // pick up the "running" state immediately, same as a download run
    } catch (e) {
      alert('Gagal memulai login: ' + e.message);
      btn.disabled = false;
    }
  });
  $('bupot-type').addEventListener('change', updateFormForBupot);
  $('output-mode').addEventListener('change', updateFormForBupot);
  function updateFormForBupot() {
    const type = $('bupot-type').value;
    // Kode Objek filter only exists for BP21/BPPU.
    $('kode-objek-row').style.display = (type === 'bp21' || type === 'bppu') ? 'block' : 'none';
    // BPMP has no PDF at all - force Excel-only and lock the toggle.
    const outSel = $('output-mode');
    if (type === 'bpmp') { outSel.value = 'excel_only'; outSel.disabled = true; }
    else { outSel.disabled = false; }
  }

  // ---------- Feature tabs (e-Bupot / SPT) ----------
  let activeFeature = 'ebupot';
  $('feature-tabs').querySelectorAll('.feature-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      activeFeature = btn.dataset.feature;
      $('feature-tabs').querySelectorAll('.feature-tab').forEach((b) => b.classList.toggle('active', b === btn));
      $('feature-ebupot').style.display = activeFeature === 'ebupot' ? 'block' : 'none';
      $('feature-spt').style.display = activeFeature === 'spt' ? 'block' : 'none';
    });
  });

  $('start-download-btn').addEventListener('click', async () => {
    if (!selectedEntity) return;
    const saveRoot = $('save-root-input').value.trim();
    try {
      if (activeFeature === 'spt') {
        const masaInput = $('spt-masa-input').value.trim();
        const jenisPajakKeys = [...document.querySelectorAll('.spt-jenis:checked')].map((c) => c.value);
        if (!masaInput) { alert('Masa wajib diisi.'); return; }
        if (!jenisPajakKeys.length) { alert('Pilih minimal satu Jenis Pajak.'); return; }
        await api('/api/actions/download-spt', {
          method: 'POST',
          body: JSON.stringify({ entity: selectedEntity, jenisPajakKeys, masaInput, saveRoot: saveRoot || undefined })
        });
      } else {
        const bupotType = $('bupot-type').value;
        const masaInput = $('masa-input').value.trim();
        const kodeInput = $('kode-objek-input').value.trim();
        const pageSize = $('page-size').value;
        const outputMode = $('output-mode').value;
        if (!masaInput) { alert('Masa wajib diisi.'); return; }
        await api('/api/actions/download-ebupot', {
          method: 'POST',
          body: JSON.stringify({ entity: selectedEntity, bupotType, masaInput, kodeInput, saveRoot: saveRoot || undefined, pageSize, outputMode })
        });
      }
      pollRunStatus(); // pick up the "running" state immediately
    } catch (e) {
      alert('Gagal memulai: ' + e.message);
    }
  });

  // ---------- Run control (pause / skip / stop) ----------
  let runStatusTimer = null;
  function renderRunStatus(st) {
    lastRunStatus = st || { active: false };
    renderSessionBar(); // keep "Login as" showing the currently-impersonated Coretax entity
    const running = st && st.active;
    $('run-controls').style.display = running ? 'flex' : 'none';
    $('start-download-btn').disabled = !!running;
    $('start-download-btn').textContent = running ? 'Sedang Berjalan...' : 'Mulai Download';
    $('login-only-btn').disabled = !!running;
    if (running) {
      $('run-label').textContent = (st.label || '') + (st.currentPageSize ? (' · ' + st.currentPageSize + '/hal') : '');
      $('run-pause-btn').textContent = st.paused ? '▶ Lanjut' : '⏸ Jeda';
      document.querySelectorAll('.run-size [data-size]').forEach((b) => {
        b.classList.toggle('active', Number(b.dataset.size) === st.currentPageSize);
      });
    }
  }
  async function pollRunStatus() {
    try { renderRunStatus(await api('/api/run/status')); } catch (e) {}
  }
  async function pollLoginStatus() {
    try { const st = await api('/api/login/status'); if (st && st.at) { lastLoginStatus = st; renderSessionBar(); } } catch (e) {}
  }
  // Cheap local poll so the buttons appear/disappear promptly even if the run was started
  // from a different window of this same dashboard.
  runStatusTimer = setInterval(pollRunStatus, 1500);
  setInterval(pollLoginStatus, 3000);
  $('run-pause-btn').addEventListener('click', async () => {
    const st = await api('/api/run/status');
    renderRunStatus(await api(st.paused ? '/api/run/resume' : '/api/run/pause', { method: 'POST' }));
  });
  $('run-skip-btn').addEventListener('click', async () => {
    renderRunStatus(await api('/api/run/skip', { method: 'POST' }));
  });
  $('run-retry-btn').addEventListener('click', async () => {
    renderRunStatus(await api('/api/run/retry', { method: 'POST' }));
  });
  $('run-back-btn').addEventListener('click', async () => {
    renderRunStatus(await api('/api/run/back', { method: 'POST' }));
  });
  $('run-stop-btn').addEventListener('click', async () => {
    if (!confirm('Hentikan seluruh proses download?')) return;
    renderRunStatus(await api('/api/run/stop', { method: 'POST' }));
  });
  document.querySelectorAll('.run-size [data-size]').forEach((b) => {
    b.addEventListener('click', async () => {
      renderRunStatus(await api('/api/run/pagesize', { method: 'POST', body: JSON.stringify({ size: Number(b.dataset.size) }) }));
    });
  });

  // ---------- Live log (SSE) ----------
  function connectEvents() {
    const view = $('log-view');
    const es = new EventSource('/events');
    es.onmessage = (ev) => {
      try {
        const entry = JSON.parse(ev.data);
        const line = document.createElement('div');
        line.className = 'log-line';
        line.textContent = entry.line;
        view.appendChild(line);
        view.scrollTop = view.scrollHeight;
      } catch (e) {}
    };
    es.onerror = () => { /* EventSource auto-reconnects */ };
  }

  // ---------- Boot ----------
  (async function boot() {
    connectEvents();
    try { sessionSummary = await api('/api/session'); } catch (e) {}
    startManualPolling(); // detect an already-open manual window too
    pollLoginStatus();
    renderConnections();
    // First run with nothing connected: open Settings straight away so the first thing the
    // user sees is where to connect, instead of an empty dashboard.
    const anyConnected = PROJECT_ORDER.some((id) => sessionSummary[id] && sessionSummary[id].connected);
    if (!anyConnected) openSettings();
  })();
})();
