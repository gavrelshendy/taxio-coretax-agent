/* Coretax Agent - "what can this connected account act on" assembly.
   No single consolidated RPC exists yet for this (see the web apps' own coretax.js ->
   refreshCoretaxIndex(), which does the same 3-way join client-side) - this mirrors that
   exact pattern rather than introducing a new RPC/schema migration just to ship v1. Reads
   only (RLS already scopes every one of these queries to what the signed-in user is allowed
   to see - on Taxio.me that also means "only MY OWN Coretax PICs", per schema_phase10.sql). */

async function getMyOrgId(client, userId) {
    const { data, error } = await client.from('memberships')
        .select('org_id, role, status')
        .eq('user_id', userId)
        .eq('status', 'active')
        .limit(1);
    if (error) throw error;
    if (!data || !data.length) throw new Error('Akun ini belum tergabung ke organisasi manapun (belum disetujui admin?).');
    return data[0];
}

/** Returns entities the connected account can automate, each with its linked Coretax PIC(s).
 *  `hasOwnerColumn`: Taxio.me's coretax_pics has a personal-ownership `owner_user_id` column
 *  (schema_phase10.sql) that Taxio (Grup)'s does NOT - selecting it unconditionally 500s on
 *  Grup with "column coretax_pics.owner_user_id does not exist", so callers must say which
 *  project they're on (see PROJECTS_WITH_OWNER_COLUMN in gui/server.js). */
async function listAutomatableEntities(client, orgId, currentUserId, hasOwnerColumn) {
    const picColumns = 'pic_id, pic_name, username_last4' + (hasOwnerColumn ? ', owner_user_id' : '');
    const [picsRes, linksRes, appDataRes] = await Promise.all([
        client.from('coretax_pics').select(picColumns).eq('org_id', orgId),
        client.from('entity_coretax_pic_links').select('entity_id, pic_id, is_primary').eq('org_id', orgId),
        client.from('app_data').select('data').eq('org_id', orgId).maybeSingle()
    ]);
    if (picsRes.error) throw picsRes.error;
    if (linksRes.error) throw linksRes.error;
    if (appDataRes.error) throw appDataRes.error;

    const picMap = {};
    (picsRes.data || []).forEach(p => { picMap[p.pic_id] = p; });

    const linksByEntity = {};
    (linksRes.data || []).forEach(l => { (linksByEntity[l.entity_id] = linksByEntity[l.entity_id] || []).push(l); });

    const appData = (appDataRes.data && appDataRes.data.data) || {};
    const currentYear = appData.current;
    const entitiesRaw = (currentYear && appData.years && appData.years[currentYear] && appData.years[currentYear].entities) || [];

    const out = [];
    for (const e of entitiesRaw) {
        const entityId = String(e.entity_id || '').trim();
        if (!entityId) continue;
        const links = linksByEntity[entityId] || [];
        if (!links.length) continue; // no Coretax PIC linked -> nothing this tool can automate for it
        for (const link of links) {
            const pic = picMap[link.pic_id];
            if (!pic) continue; // linked PIC not visible to this user (personal ownership on Taxio.me)
            out.push({
                entity_id: entityId,
                entity_name: e.entity_name || entityId,
                npwp: e.npwp || '',
                individual: e.profile_type === 'Individual',
                pic_id: pic.pic_id,
                pic_name: pic.pic_name,
                pic_is_mine: pic.owner_user_id ? pic.owner_user_id === currentUserId : true,
                is_primary: !!link.is_primary
            });
        }
    }
    out.sort((a, b) => a.entity_name.localeCompare(b.entity_name));
    return out;
}

async function getCredential(client, orgId, picId) {
    const { data, error } = await client.rpc('get_coretax_pic_credential', { p_org: orgId, p_pic_id: picId });
    if (error) throw error;
    const row = (data || [])[0];
    if (!row || !row.username || !row.password) throw new Error('Kredensial PIC belum lengkap atau tidak ditemukan.');
    return row;
}

module.exports = { getMyOrgId, listAutomatableEntities, getCredential };
