/* Coretax Agent - "what can this connected account act on" assembly.
   No single consolidated RPC exists yet for this (see the web apps' own coretax.js ->
   refreshCoretaxIndex(), which does the same 3-way join client-side) - this mirrors that
   exact pattern. Reads only (RLS already scopes every one of these queries to what the
   signed-in user is allowed to see). */
const { log } = require('./log');

async function getMyOrgId(client, userId) {
    const { data, error } = await client.from('memberships')
        .select('org_id, role, status, allowed_ebupot_sections, allowed_entity_ids')
        .eq('user_id', userId)
        .limit(1);
    if (error) throw error;
    if (!data || !data.length) throw new Error('Akun ini belum tergabung ke organisasi manapun (belum disetujui admin?).');
    return data[0];
}

/** Returns entities the connected account can automate, each with its linked Coretax PIC(s).
 *  `hasOwnerColumn`: Taxio.me's coretax_pics has a personal-ownership `owner_user_id` column
 *  that Taxio (Grup)'s does NOT. */
async function listAutomatableEntities(client, orgId, currentUserId, hasOwnerColumn, mode) {
    mode = mode === 'personal' ? 'personal' : 'group';
    const picColumns = 'pic_id, pic_name, username_last4' + (hasOwnerColumn ? ', owner_user_id' : '');
    const [picsRes, linksRes, appDataRes, memRes, personalRes] = await Promise.all([
        client.from('coretax_pics').select(picColumns).eq('org_id', orgId),
        client.from('entity_coretax_pic_links').select('entity_id, pic_id, is_primary').eq('org_id', orgId),
        client.from('app_data').select('data').eq('org_id', orgId).maybeSingle(),
        client.from('memberships').select('role, initial, display_name, allowed_entity_ids, allowed_ebupot_sections').eq('user_id', currentUserId).eq('org_id', orgId).maybeSingle(),
        // Fase 39 (leak fix 2026-08-04): entitas personal_source tidak lagi pernah ada di
        // app_data - cuma di personal_data milik pemiliknya sendiri (RLS owner_user_id =
        // auth.uid()), persis pola merge yang dipakai supabase.js di web. Tanpa ini, klien
        // personal (mis. Jenni Poedjiastoetik) hilang dari mode "Me" di Coretax Agent juga.
        client.from('personal_data').select('data').eq('owner_user_id', currentUserId).maybeSingle()
    ]);
    if (picsRes.error) throw picsRes.error;
    if (linksRes.error) throw linksRes.error;
    if (appDataRes.error) throw appDataRes.error;
    if (personalRes.error) log('[Entities] Gagal memuat entitas personal: ' + personalRes.error.message);

    const mem = memRes.data || {};
    const userRole = String(mem.role || '').trim().toLowerCase();
    const userInitial = (mem.initial || '').trim().toUpperCase();
    const userDisplayName = (mem.display_name || '').trim().toUpperCase();
    const allowedEntityIds = (userRole === 'restricted_editor' && Array.isArray(mem.allowed_entity_ids))
        ? mem.allowed_entity_ids
        : null;

    const picMap = {};
    (picsRes.data || []).forEach(p => { picMap[p.pic_id] = p; });

    const linksByEntity = {};
    (linksRes.data || []).forEach(l => { (linksByEntity[l.entity_id] = linksByEntity[l.entity_id] || []).push(l); });

    const appData = (appDataRes.data && appDataRes.data.data) || {};
    const currentYear = appData.current;
    const entitiesRaw = (currentYear && appData.years && appData.years[currentYear] && appData.years[currentYear].entities) || [];

    const personalData = (personalRes.data && personalRes.data.data) || {};
    const personalEntities = (currentYear && personalData.years && personalData.years[currentYear] && personalData.years[currentYear].entities) || [];
    if (personalEntities.length) entitiesRaw.push(...personalEntities.map(e => Object.assign({}, e, { _fromPersonalTable: true })));

    // Entitas dari personal_data SUDAH dijamin milik user ini oleh RLS (owner_user_id =
    // auth.uid()) - jangan cek ulang lewat matching string PIC di bawah. Pernah ada bug (2026-08-04,
    // Jenni Poedjiastoetik cs. hilang) di web app gara-gara entitas personal dengan field pic
    // kosong/tidak cocok gagal lolos pengecekan PIC-matching walau memang benar miliknya -
    // kepemilikan yang dijamin database seharusnya tidak pernah digantungkan ke akurasi field teks.
    function isEntityOwnedByUser(e) {
        if (e._fromPersonalTable) return true;
        if (!userInitial && !userDisplayName) return true;
        const entityNameUpper = String(e.entity_name || '').trim().toUpperCase();
        if (userDisplayName && (entityNameUpper.includes(userDisplayName) || userDisplayName.includes(entityNameUpper))) {
            return true;
        }
        const fields = [e.pic, e.pic_manager, e.pic_client, e.pic_internal].filter(Boolean);
        if (!fields.length) {
            if (e.personal_source && userInitial && entityNameUpper.includes(userInitial)) return true;
            return false;
        }
        const targets = [userInitial, userDisplayName].filter(Boolean).map(s => s.trim().toUpperCase());
        for (const f of fields) {
            const val = String(f).trim().toUpperCase();
            const parts = val.split(';').map(s => s.trim());
            for (const t of targets) {
                if (parts.includes(t) || val === t) return true;
            }
        }
        return false;
    }

    function isExternalGroup(e) {
        return String(e.group || '').trim().toLowerCase() === 'external';
    }

    const out = [];
    const seenKeys = new Set();

    for (const e of entitiesRaw) {
        const entityId = String(e.entity_id || '').trim();
        if (!entityId) continue;
        if (allowedEntityIds && !allowedEntityIds.includes(entityId)) continue;
        if (isExternalGroup(e)) continue;

        if (mode === 'group') {
            if (e.personal_source) continue;
            const g = String(e.group || '').trim().toLowerCase();
            if (g && !g.includes('ena') && !g.includes('tos') && !g.includes('sasa') && !g.includes('natasha')) continue;
        } else {
            // personal_source dulu lolos tanpa syarat di sini - bikin klien personal SIAPAPUN
            // (bukan cuma milik user yang login) muncul di mode "Me" tiap orang, termasuk akun
            // restricted_editor tanpa allowed_entity_ids. isEntityOwnedByUser sudah punya
            // penanganan personal_source sendiri (match by nama entitas kalau field PIC kosong),
            // jadi cukup panggil itu - jangan bypass total.
            if (!isEntityOwnedByUser(e)) continue;
        }

        const links = linksByEntity[entityId] || [];

        if (links.length > 0) {
            for (const link of links) {
                const pic = picMap[link.pic_id];
                const picId = pic ? pic.pic_id : link.pic_id;
                const key = `${entityId}:${picId}`;
                if (seenKeys.has(key)) continue;
                seenKeys.add(key);

                out.push({
                    entity_id: entityId,
                    entity_name: e.entity_name || entityId,
                    npwp: e.npwp || '',
                    individual: e.profile_type === 'Individual',
                    pic_id: picId,
                    pic_name: pic ? pic.pic_name : '(PIC Coretax)',
                    pic_is_mine: pic && pic.owner_user_id ? pic.owner_user_id === currentUserId : true,
                    is_primary: !!link.is_primary
                });
            }
        } else {
            const key = `${entityId}:unlinked`;
            if (!seenKeys.has(key)) {
                seenKeys.add(key);
                out.push({
                    entity_id: entityId,
                    entity_name: e.entity_name || entityId,
                    npwp: e.npwp || '',
                    individual: e.profile_type === 'Individual',
                    pic_id: 'unlinked',
                    pic_name: 'Belum Taut PIC Coretax',
                    pic_is_mine: true,
                    is_primary: true
                });
            }
        }
    }

    out.sort((a, b) => a.entity_name.localeCompare(b.entity_name));
    return out;
}

async function getCredential(client, orgId, picId) {
    // picId 'unlinked' adalah baris placeholder dari listAutomatableEntities (entitas belum
    // ditautkan PIC Coretax sama sekali) - bukan UUID asli, jangan sampai lolos ke RPC (bikin
    // Postgres error "invalid input syntax for type uuid" yang membingungkan user).
    if (picId === 'unlinked') throw new Error('Entitas ini belum ditautkan ke PIC Coretax manapun - tautkan dulu lewat "Manage Coretax PIC" di Taxio sebelum login.');
    const { data, error } = await client.rpc('get_coretax_pic_credential_for_automation', { p_org: orgId, p_pic_id: picId });
    if (error) throw error;
    const row = (data || [])[0];
    if (!row || !row.username || !row.password) throw new Error('Kredensial PIC belum lengkap atau tidak ditemukan.');
    return row;
}

/** Silent-null-on-failure is intentional (a missing passphrase must never block the login/
 *  download flow itself) but was previously ALSO silent about WHY, so "widget doesn't show up"
 *  was undiagnosable from the app's own log panel. Logs the specific reason once instead. */
async function getPassphrase(client, orgId, picId) {
    if (picId === 'unlinked') return null;
    try {
        const { data, error } = await client.rpc('get_coretax_pic_passphrase', { p_org: orgId, p_pic_id: picId });
        if (error) { log('[Passphrase] RPC get_coretax_pic_passphrase gagal untuk PIC ' + picId + ': ' + error.message); return null; }
        const pass = typeof data === 'string' ? data.trim() : ((data && data[0] && data[0].passphrase) ? data[0].passphrase.trim() : null);
        if (!pass) log('[Passphrase] Tidak ada passphrase tersimpan untuk PIC ' + picId + ' - widget salin-passphrase tidak akan muncul.');
        return pass;
    } catch (e) {
        log('[Passphrase] Error tak terduga saat ambil passphrase PIC ' + picId + ': ' + e.message);
        return null;
    }
}

module.exports = { getMyOrgId, listAutomatableEntities, getCredential, getPassphrase };
