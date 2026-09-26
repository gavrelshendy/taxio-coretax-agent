/* Taxio Pilot - menyambungkan sesi Supabase yang sudah terautentikasi ke state aplikasi.
   Satu pintu untuk tiga jalur (login di dashboard, pulihkan sesi saat start, periksa status
   pendaftaran), supaya aturan "hanya anggota aktif yang dianggap terhubung" tidak tersebar.
   Akun yang belum aktif ditaruh di state.pending, sesinya tetap tersimpan sehingga pengguna
   tidak perlu mengetik kata sandi lagi untuk memeriksa status. */
const state = require('./state');
const entitiesLib = require('./entities');
const registration = require('./registration');
const { log } = require('./log');

/** `auth`: { client, project, session, user }. Mengembalikan { status, initial? }; status
 *  'active' berarti state.set() sudah dipanggil dan aplikasi siap dipakai. */
async function attach(projectId, auth, deps) {
    const d = Object.assign({ registration, entitiesLib, state, log }, deps);
    const { client, project, session, user } = auth;
    const email = user.email || '';
    const reg = await d.registration.resolveStatus(client, user, email);
    if (reg.status !== 'active') {
        d.state.clear(projectId);
        d.state.setPending(projectId, { client, project, session, user, email, status: reg.status, initial: reg.initial || d.registration.recallInitial(email) || '' });
        d.log('Akun ' + email + ' belum aktif di grup manapun (' + reg.status + ').');
        return reg;
    }
    const membership = await d.entitiesLib.getMyOrgId(client, user.id);
    d.state.clearPending(projectId);
    d.state.set(projectId, { client, project, session, user, orgId: membership.org_id, role: membership.role, membership });
    return { status: 'active' };
}

module.exports = { attach };
