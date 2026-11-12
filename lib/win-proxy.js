/* Pengaturan proxy Windows pengguna saat ini (HKCU ...\Internet Settings), dibaca SEKALI per proses
 * lewat `reg query` (tanpa PowerShell). Dipakai dua tempat:
 *   - lib/chrome.js noWpadFlags(): bila tidak ada proxy maupun PAC, Chrome otomasi dijalankan dengan
 *     --no-proxy-server (lihat komentar di sana - WPAD yang tidak menjawab menahan navigasi pertama ±30 dtk);
 *   - lib/doctor.js: melaporkan proxy/PAC yang aktif - diikuti aplikasi desktop (net.fetch Electron, lihat
 *     lib/net.js), TIDAK diikuti mode headless `node main.js` (fetch Node).
 * Tidak pernah melempar; di luar Windows / bila gagal dibaca: { known: false }. */
let _cached = null;

function parse(out) {
    const text = String(out || '');
    const enabled = /ProxyEnable\s+REG_DWORD\s+0x0*1\b/i.test(text);
    const server = (/ProxyServer\s+REG_SZ\s+(\S.*)$/im.exec(text) || [])[1] || '';
    const pacUrl = (/AutoConfigURL\s+REG_SZ\s+(\S.*)$/im.exec(text) || [])[1] || '';
    return { known: true, enabled, server: enabled ? server.trim() : '', pac: !!pacUrl.trim(), pacUrl: pacUrl.trim() };
}

function read() {
    if (_cached) return _cached;
    if (process.platform !== 'win32') return (_cached = { known: false, enabled: false, server: '', pac: false, pacUrl: '' });
    try {
        const out = require('child_process').execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
        _cached = parse(out);
    } catch (e) {
        _cached = { known: false, enabled: false, server: '', pac: false, pacUrl: '' };
    }
    return _cached;
}

module.exports = { read, parse };
