(function () {
  const PROJECT_ORDER = ['taxio_hub'];
  let sessionSummary = { taxio_hub: { connected: false, label: 'Taxio Hub' } };
  let entities = [];
  let selectedEntity = null;
  let entityMode = (function () { try { return localStorage.getItem('coretax_entity_mode') || 'group'; } catch (e) { return 'group'; } })();
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
    const isRestricted = PROJECT_ORDER.some((id) => sessionSummary[id] && sessionSummary[id].connected && sessionSummary[id].role === 'restricted_editor');
    const openBtn = $('open-coretax-btn');
    if (openBtn) openBtn.style.display = isRestricted ? 'none' : '';
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
        const data = await api('/api/entities?mode=' + entityMode);
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
      const tagHtml = e.project === 'manual' ? ' <span class="project-tag">MANUAL</span>' : '';
      return '<div class="entity-row' + (isSelected ? ' selected' : '') + '" data-idx="' + idx + '">'
        + '<div class="entity-name">' + escapeHtml(e.entity_name) + tagHtml + '</div>'
        + '<div class="entity-meta">' + escapeHtml(e.entity_id) + (e.pic_name ? (' · PIC: ' + escapeHtml(e.pic_name)) : '') + '</div>'
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

  function renderEntityModeSeg() {
    $('entity-mode-btn-group').classList.toggle('active', entityMode === 'group');
    $('entity-mode-btn-personal').classList.toggle('active', entityMode === 'personal');
  }
  document.querySelectorAll('#entity-mode-seg button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      if (mode === entityMode) return;
      entityMode = mode;
      try { localStorage.setItem('coretax_entity_mode', entityMode); } catch (e) { }
      renderEntityModeSeg();
      selectedEntity = null;
      loadEntities();
    });
  });
  renderEntityModeSeg();

  function renderActionForm() {
    if (!selectedEntity) return;
    $('no-entity-hint').style.display = 'none';
    $('action-form-body').style.display = 'block';
    $('selected-entity-label').textContent = selectedEntity.entity_name + (selectedEntity.entity_id !== 'MANUAL' ? (' (' + selectedEntity.entity_id + ')') : '');
    // Manual sessions already log themselves in by hand - the standalone Login action is only
    // meaningful for Taxio Hub entities that need credential login + impersonate.
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
  document.querySelectorAll('.bupot-jenis').forEach((cb) => cb.addEventListener('change', updateFormForBupot));
  const KODE_OBJEK_TYPES = ['bp21', 'bppu']; // only these two ever filter by Kode Objek Pajak
  function selectedBupotTypes() { return [...document.querySelectorAll('.bupot-jenis:checked')].map((c) => c.value); }
  function updateFormForBupot() {
    const types = selectedBupotTypes();
    // Kode Objek filter shows if ANY selected type supports it (BP21/BPPU) - irrelevant types
    // in the same batch just ignore it (see the request-building loop below).
    $('kode-objek-row').style.display = types.some((t) => KODE_OBJEK_TYPES.includes(t)) ? 'block' : 'none';
    // BPMP has no PDF at all. If it's the ONLY thing selected, force Excel-only and lock the
    // toggle same as before; if it's mixed with PDF-capable types, leave Output as the user's
    // choice for those - the BPMP leg of the run always requests Excel-only regardless (handled
    // per-request when the download queue is built), so the global toggle doesn't need to lie.
    const outSel = $('output-mode');
    if (types.length === 1 && types[0] === 'bpmp') { outSel.value = 'excel_only'; outSel.disabled = true; }
    else { outSel.disabled = false; }
  }

  // ---------- Feature tabs (e-Bupot / SPT / Dividen) ----------
  let activeFeature = 'ebupot';
  $('feature-tabs').querySelectorAll('.feature-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      activeFeature = btn.dataset.feature;
      $('feature-tabs').querySelectorAll('.feature-tab').forEach((b) => b.classList.toggle('active', b === btn));
      $('feature-ebupot').style.display = activeFeature === 'ebupot' ? 'block' : 'none';
      $('feature-spt').style.display = activeFeature === 'spt' ? 'block' : 'none';
      $('feature-dividen').style.display = activeFeature === 'dividen' ? 'block' : 'none';
      // Dividen has its own Import button + reads the live Coretax window (not a saved-to-disk
      // download), so the shared Download fields/button are irrelevant for it.
      $('dl-fields').style.display = activeFeature === 'dividen' ? 'none' : 'block';
    });
  });

  // ---------- Dividen import (reads the .xlsx locally, posts it as base64) ----------
  function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const bytes = new Uint8Array(reader.result);
        let binary = '';
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
        resolve(btoa(binary));
      };
      reader.onerror = () => reject(reader.error || new Error('Gagal membaca file.'));
      reader.readAsArrayBuffer(file);
    });
  }
  let selectedDividenFile = null;

  $('pick-dividen-file-btn').addEventListener('click', async () => {
    try {
      const data = await api('/api/actions/pick-file', { method: 'POST', body: JSON.stringify({ title: 'Pilih File Template Dividen (.xlsx)', filter: 'File Excel (*.xlsx)|*.xlsx|Semua File (*.*)|*.*' }) });
      if (data && !data.canceled && data.fileBase64) {
        selectedDividenFile = { fileName: data.fileName, fileBase64: data.fileBase64 };
        $('dividen-file-label').textContent = '✓ ' + data.fileName;
        return;
      }
    } catch (e) {}
    $('dividen-file').click();
  });

  $('dividen-file').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) {
      try {
        const fileBase64 = await readFileAsBase64(file);
        selectedDividenFile = { fileName: file.name, fileBase64 };
        $('dividen-file-label').textContent = '✓ ' + file.name;
      } catch (err) { alert('Gagal membaca file: ' + err.message); }
    }
  });

  $('pick-folder-btn').addEventListener('click', async () => {
    try {
      const data = await api('/api/actions/pick-folder', { method: 'POST', body: JSON.stringify({ title: 'Pilih Folder Tempat Menyimpan Hasil Download' }) });
      if (data && !data.canceled && data.folderPath) {
        $('save-root-input').value = data.folderPath;
      }
    } catch (e) {}
  });

  $('create-dividen-case-btn').addEventListener('click', async () => {
    const btn = $('create-dividen-case-btn');
    btn.disabled = true; btn.textContent = 'Membuat kasus...';
    try {
      await api('/api/actions/create-dividen-case', { method: 'POST' });
      pollRunStatus();
    } catch (e) {
      alert('Gagal membuat kasus: ' + e.message);
    } finally {
      setTimeout(() => { btn.disabled = false; btn.textContent = 'Buat Kasus Baru (AS.39-01)'; }, 1500);
    }
  });

  $('import-dividen-btn').addEventListener('click', async () => {
    let fileBase64 = selectedDividenFile ? selectedDividenFile.fileBase64 : null;
    let fileName = selectedDividenFile ? selectedDividenFile.fileName : null;
    if (!fileBase64) {
      const fileInput = $('dividen-file');
      const file = fileInput.files && fileInput.files[0];
      if (!file) { alert('Pilih file template .xlsx dulu.'); return; }
      fileBase64 = await readFileAsBase64(file);
      fileName = file.name;
    }
    const btn = $('import-dividen-btn');
    btn.disabled = true; btn.textContent = 'Mengimpor...';
    try {
      await api('/api/actions/import-dividen', { method: 'POST', body: JSON.stringify({ fileBase64, fileName }) });
      pollRunStatus();
    } catch (e) {
      alert('Gagal memulai impor: ' + e.message);
    } finally {
      setTimeout(() => { btn.disabled = false; btn.textContent = 'Impor ke Coretax'; }, 1500);
    }
  });

  $('check-dividen-btn').addEventListener('click', async () => {
    let fileBase64 = selectedDividenFile ? selectedDividenFile.fileBase64 : null;
    let fileName = selectedDividenFile ? selectedDividenFile.fileName : null;
    if (!fileBase64) {
      const fileInput = $('dividen-file');
      const file = fileInput.files && fileInput.files[0];
      if (!file) { alert('Pilih file template .xlsx dulu (dipakai sebagai pembanding).'); return; }
      fileBase64 = await readFileAsBase64(file);
      fileName = file.name;
    }
    const btn = $('check-dividen-btn');
    btn.disabled = true; btn.textContent = 'Mengecek...';
    try {
      await api('/api/actions/check-dividen', { method: 'POST', body: JSON.stringify({ fileBase64, fileName }) });
      pollRunStatus();
    } catch (e) {
      alert('Gagal memulai Cek Hasil: ' + e.message);
    } finally {
      setTimeout(() => { btn.disabled = false; btn.textContent = 'Cek Hasil (bandingkan dengan file ini)'; }, 1500);
    }
  });

  // Bupot types run one at a time (the underlying automation/ebupot.js run is built around a
  // single type's endpoint/combo loop, with its own retry+run-control machinery already proven
  // in production - reusing it unchanged per type here rather than teaching it a second type
  // dimension). Multi-select just means the GUI queues one request per checked type and waits
  // for each to finish (poll /api/run/status) before firing the next.
  let bupotQueue = [];
  function waitForRunToFinish() {
    return new Promise((resolve) => {
      const check = async () => {
        let st; try { st = await api('/api/run/status'); } catch (e) { st = { active: false }; }
        renderRunStatus(st);
        if (st && st.active) setTimeout(check, 1200);
        else resolve();
      };
      setTimeout(check, 1200);
    });
  }
  async function runNextInBupotQueue() {
    const next = bupotQueue.shift();
    if (!next) return;
    log_local('Bupot: memulai ' + next.bupotType.toUpperCase() + (bupotQueue.length ? (' (' + bupotQueue.length + ' jenis lagi menyusul)') : '') + '...');
    try {
      await api('/api/actions/download-ebupot', { method: 'POST', body: JSON.stringify(next) });
      pollRunStatus();
      await waitForRunToFinish();
    } catch (e) {
      log_local('Bupot ' + next.bupotType.toUpperCase() + ' gagal dimulai: ' + e.message);
    }
    if (bupotQueue.length) await runNextInBupotQueue();
  }

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
        pollRunStatus();
      } else {
        const bupotTypes = selectedBupotTypes();
        const masaInput = $('masa-input').value.trim();
        const kodeInput = $('kode-objek-input').value.trim();
        const pageSize = $('page-size').value;
        const outputMode = $('output-mode').value;
        if (!masaInput) { alert('Masa wajib diisi.'); return; }
        if (!bupotTypes.length) { alert('Pilih minimal satu Jenis Bupot.'); return; }
        bupotQueue = bupotTypes.map((bupotType) => ({
          entity: selectedEntity,
          bupotType,
          masaInput,
          // Kode Objek only means anything for BP21/BPPU - sending it for BPA1/BPMP would just
          // be a silently-ignored filter, but omitting it is clearer about what actually applies.
          kodeInput: KODE_OBJEK_TYPES.includes(bupotType) ? kodeInput : '',
          saveRoot: saveRoot || undefined,
          pageSize,
          // BPMP has no PDF, period - force Excel-only for that leg of the queue regardless of
          // what the (possibly-disabled, possibly-PDF+Excel-for-other-types) toggle says.
          outputMode: bupotType === 'bpmp' ? 'excel_only' : outputMode
        }));
        runNextInBupotQueue(); // fire-and-forget: it self-chains via waitForRunToFinish()
      }
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
