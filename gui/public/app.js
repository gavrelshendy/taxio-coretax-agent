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

  // Explicit user request 2026-08-14: rather than let a restricted editor pick BPMP/BPA1 and
  // only find out it's blocked after clicking download (gui/server.js's server-side block was
  // already absolute - this is purely about not letting the click happen in the first place),
  // grey the checkboxes out directly. Covers both e-Bupot's .bupot-jenis and "Bukti Potong
  // Saya"'s .mybupot-jenis - server-side rejection (isEbupotTypeAllowed/
  // ABSOLUTELY_BLOCKED_MYBUPOT_TYPES in gui/server.js) stays as the real enforcement either way.
  function applyRestrictedBupotLock(isRestricted) {
    document.querySelectorAll('.bupot-jenis, .mybupot-jenis').forEach((el) => {
      if (el.value !== 'bpmp' && el.value !== 'bpa1') return;
      el.disabled = isRestricted;
      el.checked = isRestricted ? false : el.checked;
      const label = el.closest('label');
      if (label) {
        label.style.opacity = isRestricted ? '0.45' : '';
        label.title = isRestricted ? 'Tidak diizinkan untuk Restricted Editor.' : '';
      }
    });
  }

  function isA1Restricted() {
    return PROJECT_ORDER.some(id => sessionSummary[id]?.connected && String(sessionSummary[id].role || '').toLowerCase().includes('restricted'));
  }
  function applyA1Access() {
    const blocked = isA1Restricted();
    const pph21 = document.querySelector('.spt-jenis[value="pph21"]');
    pph21.disabled=blocked;if(blocked)pph21.checked=false;
    pph21.closest('label').title=blocked?'SPT PPh 21 tidak tersedia untuk pengguna Restricted.':'';
    const button = document.querySelector('[data-feature="a1"]');
    button.hidden = blocked;
    button.style.display = blocked ? 'none' : '';
    button.disabled = blocked;
    if (blocked && activeFeature === 'a1') selectFeatureTab(document.querySelector('[data-feature="dividen"]'));
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
    const isRestricted = PROJECT_ORDER.some((id) => sessionSummary[id] && sessionSummary[id].connected && (String(sessionSummary[id].role || '').toLowerCase().includes('restricted')));
    const openBtn = $('open-coretax-btn');
    if (openBtn) openBtn.style.display = isRestricted ? 'none' : '';
    applyRestrictedBupotLock(isRestricted);
    applyA1Access();
    const showApp = anyConnected || manualStatus.loggedIn;
    $('main-layout').style.display = showApp ? 'grid' : 'none';
    $('empty-hint').style.display = showApp ? 'none' : 'flex';
    updateUserProfileHeader();
    renderSessionBar();
    if (showApp) loadEntities();
  }

  function updateUserProfileHeader() {
    const profileBadge = $('user-profile-badge');
    if (!profileBadge) return;
    const activeSession = Object.values(sessionSummary || {}).find((s) => s && s.connected);
    if (activeSession && activeSession.email) {
      const r = String(activeSession.role || '').toLowerCase();
      const isRestricted = r.includes('restricted');
      const roleLabel = isRestricted ? 'Restricted Editor' : (activeSession.role || 'Member');
      const roleClass = isRestricted ? 'restricted' : 'admin';
      profileBadge.style.display = 'inline-flex';
      profileBadge.innerHTML = '<span style="font-size:12px;">👤</span>'
        + '<span class="user-email">' + escapeHtml(activeSession.email) + '</span>'
        + '<span class="role-badge ' + roleClass + '">' + escapeHtml(roleLabel) + '</span>';
    } else {
      profileBadge.style.display = 'none';
      profileBadge.innerHTML = '';
    }
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

  // Full-auto by explicit request (2026-08-07): finding an update means it downloads and the
  // app restarts into it on its own - this button just surfaces that it's happening, it doesn't
  // ask for a separate confirmation step.
  $('check-update-btn').addEventListener('click', async () => {
    const btn = $('check-update-btn');
    const statusEl = $('update-status-text');
    btn.disabled = true;
    statusEl.textContent = 'Mengecek update...';
    try {
      const info = await api('/api/check-update', { method: 'POST' });
      if (info.available) {
        statusEl.textContent = 'Update v' + info.version + ' ditemukan - mengunduh & memasang, aplikasi akan tertutup dan terbuka ulang otomatis...';
      } else {
        statusEl.textContent = 'Sudah versi terbaru.';
        btn.disabled = false;
      }
    } catch (e) {
      statusEl.textContent = 'Gagal cek update: ' + e.message;
      btn.disabled = false;
    }
  });
  $('outdated-banner-check-btn').addEventListener('click', async () => {
    const btn = $('outdated-banner-check-btn');
    const text = $('outdated-banner-text');
    btn.disabled = true;
    text.textContent = 'Mengecek update...';
    try {
      const info = await api('/api/check-update', { method: 'POST' });
      text.textContent = info.available
        ? ('Update v' + info.version + ' ditemukan - mengunduh & memasang, aplikasi akan tertutup dan terbuka ulang otomatis...')
        : 'Sudah versi terbaru - coba lagi sebentar lagi.';
    } catch (e) {
      text.textContent = 'Gagal cek update: ' + e.message;
    }
    btn.disabled = false;
  });

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

  $('clear-log-btn').addEventListener('click', async () => {
    $('log-view').innerHTML = '';
    try { await api('/api/log/clear', { method: 'POST' }); } catch (e) {}
  });

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
      const initial = (e.entity_name || 'E').trim().charAt(0).toUpperCase();
      return '<div class="entity-row' + (isSelected ? ' selected' : '') + '" data-idx="' + idx + '">'
        + '<div style="display:flex;align-items:center;gap:10px;">'
        + '<div style="width:30px;height:30px;border-radius:8px;background:rgba(13,148,136,0.12);border:1px solid rgba(13,148,136,0.3);display:flex;align-items:center;justify-content:center;font-weight:700;font-size:12px;color:var(--cyan);flex-shrink:0;">' + initial + '</div>'
        + '<div style="flex:1;min-width:0;">'
        + '<div class="entity-name" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + escapeHtml(e.entity_name) + tagHtml + '</div>'
        + '<div class="entity-meta">' + escapeHtml(e.entity_id) + (e.pic_name ? (' · PIC Coretax: ' + escapeHtml(e.pic_name)) : '') + '</div>'
        + '</div>'
        + '</div>'
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
    updateMyBupotForEntity();
    updateSptForEntity();
  }
  // SPT Orang Pribadi (annual) only ever works for a genuinely Individual entity - Coretax
  // disables that menu entirely while impersonating a Badan entity (live-confirmed 2026-08-05) -
  // same "personal-only" guard pattern as updateMyBupotForEntity() above.
  function updateSptForEntity() {
    if (!selectedEntity) return;
    const allow = selectedEntity.project === 'manual' || !!selectedEntity.individual;
    const cb = $('spt-op-checkbox');
    if (!cb) return;
    cb.disabled = !allow;
    if (!allow && cb.checked) { cb.checked = false; updateSptMasaLabel(); }
  }
  // BPMP/BP21/BPA1/BPA2 only ever have data under the PIC's own personal identity (confirmed
  // live - see automation/mybupot.js's header comment), never under an impersonated company, so
  // disable+uncheck them whenever the selected entity requires impersonation. Manual sessions
  // are skipped entirely (the user already drives that browser window directly, same "manual
  // bypasses automated guardrails" pattern used elsewhere in this app).
  const PERSONAL_ONLY_MYBUPOT_TYPES = ['bpmp', 'bp21', 'bpa1', 'bpa2'];
  function updateMyBupotForEntity() {
    if (!selectedEntity) return;
    const allow = selectedEntity.project === 'manual' || !!selectedEntity.individual;
    document.querySelectorAll('.mybupot-jenis').forEach((cb) => {
      if (!PERSONAL_ONLY_MYBUPOT_TYPES.includes(cb.value)) return;
      cb.disabled = !allow;
      if (!allow && cb.checked) cb.checked = false;
    });
    if (typeof syncMyBupotSelectAll === 'function') syncMyBupotSelectAll();
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
  // ---------- Generic "select all" icon buttons for checkbox groups ----------
  function wireSelectAll(btnId, checkboxSelector, onChangeAfter) {
    const btn = $(btnId);
    if (!btn) return;
    function enabledBoxes() { return [...document.querySelectorAll(checkboxSelector)].filter((cb) => !cb.disabled); }
    function sync() {
      const boxes = enabledBoxes();
      btn.classList.toggle('all-selected', boxes.length > 0 && boxes.every((cb) => cb.checked));
    }
    btn.addEventListener('click', () => {
      const boxes = enabledBoxes();
      const allChecked = boxes.length > 0 && boxes.every((cb) => cb.checked);
      boxes.forEach((cb) => { cb.checked = !allChecked; });
      sync();
      if (onChangeAfter) onChangeAfter();
    });
    document.querySelectorAll(checkboxSelector).forEach((cb) => cb.addEventListener('change', sync));
    sync();
    return sync;
  }
  wireSelectAll('ebupot-select-all-btn', '.bupot-jenis', updateFormForBupot);
  const syncMyBupotSelectAll = wireSelectAll('mybupot-select-all-btn', '.mybupot-jenis');
  // SPT Badan/Orang Pribadi (annual, data-annual="1") use a whole-year TaxPeriodCode - Coretax
  // has no way to combine them with the monthly types above in one run (automation/spt.js's
  // runSptDownload rejects a mixed selection outright), so "select all" only ever targets the
  // monthly group; the two annual boxes get their own mutual-exclusivity handling below instead.
  wireSelectAll('spt-select-all-btn', '.spt-jenis:not([data-annual]):not(:disabled)');
  function updateSptMasaLabel() {
    const isAnnual = !!document.querySelector('.spt-jenis[data-annual]:checked');
    $('spt-masa-label').firstChild.textContent = isAnnual ? 'Tahun Pajak ' : 'Masa Pajak ';
    $('spt-masa-hint').title = isAnnual ? 'mis. 2025 atau 2024-2025' : 'mis. 0126;0226 atau 0125-1225';
  }
  function updateSptLampiranOptions() {
    const enabled = $('spt-download-lampiran').checked;
    $('spt-lampiran-options').style.display = enabled ? 'block' : 'none';
    $('spt-pdf-options').style.display = $('spt-lampiran-format').value === 'excel' ? 'none' : 'block';
    const keys = [...document.querySelectorAll('.spt-jenis:checked')].map((item) => item.value);
    const confidential = $('spt-lampiran-mode').querySelector('option[value="confidential"]');
    const confidentialAllowed = keys.length === 1 && keys[0] === 'pph21';
    confidential.disabled = !confidentialAllowed;
    if (!confidentialAllowed && $('spt-lampiran-mode').value === 'confidential') $('spt-lampiran-mode').value = 'print';
  }
  document.querySelectorAll('.spt-jenis').forEach((cb) => cb.addEventListener('change', () => {
    if (cb.checked) {
      const isAnnualBox = !!cb.dataset.annual;
      document.querySelectorAll('.spt-jenis').forEach((other) => {
        if (other === cb) return;
        const otherIsAnnual = !!other.dataset.annual;
        // Annual boxes are mutually exclusive with EVERYTHING else (each other included - only
        // one annual return type makes sense per run); monthly boxes just exclude annual ones.
        if (isAnnualBox || otherIsAnnual) other.checked = false;
      });
    }
    updateSptMasaLabel();
    updateSptLampiranOptions();
  }));
  $('spt-download-lampiran').addEventListener('change', updateSptLampiranOptions);
  $('spt-lampiran-format').addEventListener('change', updateSptLampiranOptions);
  updateSptMasaLabel();
  updateSptLampiranOptions();

  document.querySelectorAll('.bupot-jenis').forEach((cb) => cb.addEventListener('change', updateFormForBupot));
  document.querySelectorAll('.ebupot-status').forEach((radio) => radio.addEventListener('change', updateFormForBupot));
  const KODE_OBJEK_TYPES = ['bp21', 'bppu']; // only these two ever filter by Kode Objek Pajak
  function selectedBupotTypes() { return [...document.querySelectorAll('.bupot-jenis:checked')].map((c) => c.value); }
  function selectedEbupotStatus() { return (document.querySelector('.ebupot-status:checked') || {}).value || 'issued'; }
  function updateFormForBupot() {
    const types = selectedBupotTypes();
    // Kode Objek filter shows if ANY selected type supports it (BP21/BPPU) - irrelevant types
    // in the same batch just ignore it (see the request-building loop below).
    $('kode-objek-row').style.display = types.some((t) => KODE_OBJEK_TYPES.includes(t)) ? 'block' : 'none';
    // BPMP has no PDF at all. Likewise, Coretax's Belum Terbit listing has no official PDF, so
    // every not-issued run is Excel-only. Preserve the user's issued-PDF choice while locked.
    const outPdf = $('output-pdf');
    const forceExcelOnly = selectedEbupotStatus() === 'not_issued' || (types.length === 1 && types[0] === 'bpmp');
    if (forceExcelOnly) {
      if (!outPdf.disabled) outPdf.dataset.previousChecked = outPdf.checked ? '1' : '0';
      outPdf.checked = false;
      outPdf.disabled = true;
    } else {
      outPdf.disabled = false;
      if (outPdf.dataset.previousChecked != null) {
        outPdf.checked = outPdf.dataset.previousChecked === '1';
        delete outPdf.dataset.previousChecked;
      }
    }
  }

  // ---------- Mode tabs (Download / Import & Otomasi) + feature tabs within each ----------
  // Two-tier nav: 5 feature tabs no longer share one crowded row - Download (e-Bupot/Bukti
  // Potong Saya/SPT) and Import & Otomasi (Dividen/Pajak Masukan) are separate groups, and the
  // shared Download fields (folder simpan + Mulai Otomasi) are scoped to MODE, not to an
  // ever-growing per-feature exception list.
  let activeMode = 'download';
  let activeFeature = 'spt';

  function applyFeaturePanels() {
    $('feature-a1').style.display = activeFeature === 'a1' ? 'block' : 'none';
    $('feature-ebupot').style.display = activeFeature === 'ebupot' ? 'block' : 'none';
    $('feature-mybupot').style.display = activeFeature === 'mybupot' ? 'block' : 'none';
    $('feature-spt').style.display = activeFeature === 'spt' ? 'block' : 'none';
    $('feature-pm-download').style.display = activeFeature === 'pm-download' ? 'block' : 'none';
    $('feature-dividen').style.display = activeFeature === 'dividen' ? 'block' : 'none';
    $('feature-pajakmasukan').style.display = activeFeature === 'pajakmasukan' ? 'block' : 'none';
    $('dl-fields').style.display = activeMode === 'download' || activeFeature === 'a1' ? 'block' : 'none';
  }

  function selectFeatureTab(btn) {
    if(btn.dataset.feature === 'a1' && isA1Restricted()) return;
    activeFeature = btn.dataset.feature;
    document.querySelectorAll('.feature-tab').forEach((b) => b.classList.toggle('active', b === btn));
    applyFeaturePanels();
  }

  $('mode-tabs').querySelectorAll('.mode-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      activeMode = btn.dataset.mode;
      $('mode-tabs').querySelectorAll('.mode-tab').forEach((b) => b.classList.toggle('active', b === btn));
      $('feature-tabs-download').style.display = activeMode === 'download' ? 'flex' : 'none';
      $('feature-tabs-import').style.display = activeMode === 'import' ? 'flex' : 'none';
      // Pindah mode selalu jatuh ke tab pertama dalam grup itu, supaya tidak pernah nyangkut di
      // panel yang tersembunyi karena mode-nya sendiri sudah tidak aktif.
      const group = activeMode === 'download' ? $('feature-tabs-download') : $('feature-tabs-import');
      selectFeatureTab(group.querySelector('.feature-tab'));
    });
  });

  document.querySelectorAll('.feature-tab').forEach((btn) => {
    btn.addEventListener('click', () => selectFeatureTab(btn));
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
      const data = await api('/api/actions/pick-folder', { method: 'POST', body: JSON.stringify({ title: 'Pilih Folder Tempat Menyimpan Hasil Unduhan' }) });
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

  // ---------- Pajak Masukan import (entitas+PIC seperti SPT, file .xlsx seperti Dividen) ----------
  let selectedPmFile = null;

  $('pick-pm-file-btn').addEventListener('click', async () => {
    try {
      const data = await api('/api/actions/pick-file', { method: 'POST', body: JSON.stringify({ title: 'Pilih File Excel Pajak Masukan (.xlsx)', filter: 'File Excel (*.xlsx)|*.xlsx|Semua File (*.*)|*.*' }) });
      if (data && !data.canceled && data.fileBase64) {
        selectedPmFile = { fileName: data.fileName, fileBase64: data.fileBase64 };
        $('pm-file-label').textContent = '✓ ' + data.fileName;
        return;
      }
    } catch (e) {}
    $('pm-file').click();
  });

  $('pm-file').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) {
      try {
        const fileBase64 = await readFileAsBase64(file);
        selectedPmFile = { fileName: file.name, fileBase64 };
        $('pm-file-label').textContent = '✓ ' + file.name;
      } catch (err) { alert('Gagal membaca file: ' + err.message); }
    }
  });

  $('import-pm-btn').addEventListener('click', async () => {
    if (!selectedEntity) { alert('Pilih entitas dulu di atas.'); return; }
    if (selectedEntity.project === 'manual') { alert('Pajak Masukan butuh entitas dengan PIC Coretax terhubung, bukan sesi manual.'); return; }
    const targetMasaInput = $('pm-credit-masa-input').value.trim();
    if (targetMasaInput && !/^(0[1-9]|1[0-2])\d{2}$/.test(targetMasaInput)) {
      alert('Masa Pengkreditan harus berformat MMYY, misalnya 0726 untuk Juli 2026.');
      return;
    }
    let fileBase64 = selectedPmFile ? selectedPmFile.fileBase64 : null;
    if (!fileBase64) {
      const fileInput = $('pm-file');
      const file = fileInput.files && fileInput.files[0];
      if (!file) { alert('Pilih file Excel yang sudah terisi dulu.'); return; }
      fileBase64 = await readFileAsBase64(file);
    }
    const btn = $('import-pm-btn');
    btn.disabled = true; btn.textContent = 'Mengimpor...';
    try {
      await api('/api/actions/import-pajak-masukan', { method: 'POST', body: JSON.stringify({ entity: selectedEntity, fileBase64, targetMasaInput: targetMasaInput || undefined }) });
      pollRunStatus();
    } catch (e) {
      alert('Gagal memulai impor: ' + e.message);
    } finally {
      setTimeout(() => { btn.disabled = false; btn.textContent = 'Impor ke Coretax'; }, 1500);
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
      if (activeFeature === 'a1') {
        if(isA1Restricted())throw new Error('Mode A1 tidak tersedia untuk pengguna Restricted.');
        const year = $('a1-year').value.trim();
        if (!/^(20)\d{2}$/.test(year) || Number(year)<2025) throw new Error('Isi tahun pajak mulai 2025, misalnya 2026.');
        await api('/api/actions/download-spt', {method:'POST', body:JSON.stringify({entity:selectedEntity,a1Year:year,saveRoot:saveRoot||undefined})});
        pollRunStatus();
      } else if (activeFeature === 'mybupot') {
        const buktiTypeKeys = [...document.querySelectorAll('.mybupot-jenis:checked')].map((c) => c.value);
        const masaInput = $('mybupot-masa-input').value.trim();
        const pageSize = $('mybupot-page-size').value;
        const outputMode = $('mybupot-output-pdf').checked ? 'pdf_excel' : 'excel_only';
        if (!masaInput) { alert('Masa wajib diisi.'); return; }
        if (!buktiTypeKeys.length) { alert('Pilih minimal satu Jenis Bukti Potong.'); return; }
        await api('/api/actions/download-mybupot', {
          method: 'POST',
          body: JSON.stringify({ entity: selectedEntity, buktiTypeKeys, masaInput, saveRoot: saveRoot || undefined, pageSize, outputMode })
        });
        pollRunStatus();
      } else if (activeFeature === 'spt') {
        const masaInput = $('spt-masa-input').value.trim();
        const jenisPajakKeys = [...document.querySelectorAll('.spt-jenis:checked')].map((c) => c.value);
        if(isA1Restricted()&&jenisPajakKeys.includes('pph21'))throw new Error('SPT PPh 21 tidak tersedia untuk pengguna Restricted.');
        const checkPph25 = $('spt-check-pph25').checked;
        const includeLampiran = $('spt-download-lampiran').checked;
        const includeBpe = $('spt-download-bpe').checked;
        const includeInduk = $('spt-download-induk').checked;
        if (!includeLampiran && !includeBpe && !includeInduk) throw new Error('Pilih minimal satu dokumen untuk diunduh.');
        const lampiranFormat = $('spt-lampiran-format').value;
        const lampiranMode = lampiranFormat === 'excel' ? 'full' : $('spt-lampiran-mode').value;
        const outputLayout = $('spt-output-layout').value;
        if (!masaInput) { alert('Masa wajib diisi.'); return; }
        if (!jenisPajakKeys.length) { alert('Pilih minimal satu Jenis Pajak.'); return; }
        await api('/api/actions/download-spt', {
          method: 'POST',
          body: JSON.stringify({ entity: selectedEntity, jenisPajakKeys, masaInput, saveRoot: saveRoot || undefined, checkPph25,
            includeLampiran, includeBpe, includeInduk, lampiranMode, lampiranFormat, outputLayout })
        });
        pollRunStatus();
      } else if (activeFeature === 'pm-download') {
        const masaInput = $('pm-download-masa-input').value.trim();
        if (!masaInput) { alert('Masa wajib diisi.'); return; }
        await api('/api/actions/download-pajak-masukan', {
          method: 'POST',
          body: JSON.stringify({ entity: selectedEntity, masaInput, saveRoot: saveRoot || undefined })
        });
        pollRunStatus();
      } else {
        const bupotTypes = selectedBupotTypes();
        const masaInput = $('masa-input').value.trim();
        const kodeInput = $('kode-objek-input').value.trim();
        const pageSize = $('page-size').value;
        const documentStatus = selectedEbupotStatus();
        const outputMode = $('output-pdf').checked ? 'pdf_excel' : 'excel_only';
        if (!masaInput) { alert('Masa wajib diisi.'); return; }
        if (!bupotTypes.length) { alert('Pilih minimal satu Jenis Bupot.'); return; }
        bupotQueue = bupotTypes.map((bupotType) => ({
          entity: selectedEntity,
          bupotType,
          documentStatus,
          masaInput,
          // Kode Objek only means anything for BP21/BPPU - sending it for BPA1/BPMP would just
          // be a silently-ignored filter, but omitting it is clearer about what actually applies.
          kodeInput: KODE_OBJEK_TYPES.includes(bupotType) ? kodeInput : '',
          saveRoot: saveRoot || undefined,
          pageSize,
          // BPMP has no PDF, period - force Excel-only for that leg of the queue regardless of
          // what the (possibly-disabled, possibly-PDF+Excel-for-other-types) toggle says.
          outputMode: documentStatus === 'not_issued' || bupotType === 'bpmp' ? 'excel_only' : outputMode
        }));
        runNextInBupotQueue(); // fire-and-forget: it self-chains via waitForRunToFinish()
      }
    } catch (e) {
      alert('Gagal memulai: ' + e.message);
    }
  });

  // ---------- Run control (pause / skip / stop) ----------
  let runStatusTimer = null;
  // SPT: tandai tiap checkbox Jenis Pajak dengan hasil run TERAKHIR yang menyertakannya -
  // ✓ teal kalau ada dokumen benar-benar terunduh, ⚠ kalau diminta tapi Coretax memang tidak
  // punya data (bukan gagal), ✕ merah kalau semuanya gagal. Status "kosong" (⚠) baru
  // ditampilkan setelah run SELESAI (bukan saat masih berjalan) - selama masih jalan, tally
  // yang belum terisi untuk suatu jenis cuma berarti "belum diproses", bukan "sudah dicek dan
  // ternyata kosong".
  function renderJenisTally(st) {
    const requested = (st && st.jenisRequested) || [];
    const tally = (st && st.jenisTally) || {};
    const finished = !(st && st.active);
    document.querySelectorAll('.spt-jenis').forEach((cb) => {
      const card = cb.closest('.custom-checkbox-card');
      if (!card) return;
      card.classList.remove('jenis-done-ok', 'jenis-done-empty', 'jenis-done-fail');
      if (requested.indexOf(cb.value) === -1) return;
      const t = tally[cb.value];
      if (t && t.ok > 0) card.classList.add('jenis-done-ok');
      else if (t && t.fail > 0) card.classList.add('jenis-done-fail');
      else if (finished) card.classList.add('jenis-done-empty');
    });
  }

  function renderRunStatus(st) {
    lastRunStatus = st || { active: false };
    renderSessionBar(); // keep "Login as" showing the currently-impersonated Coretax entity
    const running = st && st.active;
    $('run-controls').style.display = running ? 'flex' : 'none';
    $('start-download-btn').disabled = !!running;
    $('start-download-btn').textContent = running ? 'Sedang Berjalan...' : 'Mulai Unduh';
    $('login-only-btn').disabled = !!running;
    if (running) {
      $('run-label').textContent = (st.label || '') + (st.currentPageSize ? (' · ' + st.currentPageSize + '/hal') : '');
      $('run-pause-btn').textContent = st.paused ? '▶ Lanjut' : '⏸ Jeda';
      document.querySelectorAll('.run-size [data-size]').forEach((b) => {
        b.classList.toggle('active', Number(b.dataset.size) === st.currentPageSize);
      });
    }
    renderJenisTally(st);
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
    if (!confirm('Hentikan seluruh proses unduhan?')) return;
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
    try {
      const v = await api('/api/version');
      const badge = document.querySelector('.version-badge');
      if (badge && v && v.version) badge.textContent = 'v' + v.version;
      const settingsVer = $('settings-current-version');
      if (settingsVer && v && v.version) settingsVer.textContent = '(v' + v.version + ')';
      // Explicit user request 2026-08-13: makes the hard version-gate (gui/server.js's
      // rejectIfOutdated, 426 on new actions) visible instead of just failing silently -
      // actions still get rejected server-side regardless of whether this banner is seen.
      const banner = $('outdated-banner');
      if (banner && v && v.outdated) {
        banner.style.display = 'block';
        const text = $('outdated-banner-text');
        if (text) text.textContent = 'Versi ini (v' + v.version + ') sudah usang - v' + v.latestVersion + ' tersedia. Aksi baru diblokir sampai diperbarui.';
      }
    } catch (e) {}
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
