/* Coretax Agent - writes back to Taxio's own compliance tracking, mirroring the legacy
   coretax-helper tool's markSptCompliance() exactly (same RPC, same field names) so a Coretax
   Agent SPT download shows up as "done" in Taxio's compliance grid the same way the legacy
   .exe's downloads always did - this is the actual substance of "terintegrasi ke Taxio", not
   just reusing the taxio-coretax:// URL scheme. */
const { log } = require('./log');

// Maps this app's internal jenisPajak key -> the compliance_records column the legacy tool
// flips to 'Y' once a submitted SPT's PDF is confirmed downloaded (proof it was actually
// submitted, not just marked done by hand).
const SPT_COMPLIANCE_FIELD = { pph21: 'spt_pph21', unifikasi: 'spt_unifikasi', ppn: 'spt_ppn' };

/** `params`: { org, year, masa, entity, uid, uemail } - the same shape the deep link passes
 *  through (see lib/deeplink.js's parseIncomingUrl). Best-effort: logs on failure but never
 *  throws - a compliance-marking hiccup must never be mistaken for the download itself having
 *  failed (the PDF is already safely on disk by the time this is called). */
async function markSptCompliance(client, params, jenisPajakKey) {
    const field = SPT_COMPLIANCE_FIELD[jenisPajakKey];
    if (!field || !params.org || !params.year || !params.entity) return;
    try {
        const { error } = await client.rpc('compliance_upsert_patch', {
            p_org: params.org,
            p_year: params.year,
            p_month: params.masa,
            p_entity: String(params.entity),
            p_patch: { [field]: 'Y' },
            p_scalars: {},
            p_updated_by: params.uid || null,
            p_updated_by_email: params.uemail || null
        });
        if (error) throw error;
        log('Compliance "' + field + '" ditandai selesai di Taxio untuk entitas ' + params.entity + '.');
    } catch (e) {
        log('Gagal menandai compliance "' + field + '" (tidak fatal, PDF tetap ter-download): ' + e.message);
    }
}

module.exports = { markSptCompliance, SPT_COMPLIANCE_FIELD };
