/* Patches the built exe's PE header so Windows launches it as a GUI app (no console window
   flashing on double-click or on a taxio-coretax:// deep-link invocation) instead of a Console
   app - @yao-pkg/pkg (like plain Node.exe) always produces a Console-subsystem binary, and pkg
   itself has no built-in option to change that.

   This is a direct, minimal binary patch (no new dependency) rather than reaching for a tool
   like editbin.exe (part of Visual Studio Build Tools, not guaranteed to be installed) or an
   npm package: the PE format's "Subsystem" field lives at a FIXED offset (92 bytes into the PE
   header) for both PE32 and PE32+ binaries - the fields before it (BaseOfData present only in
   PE32 vs ImageBase being 4 vs 8 bytes) cancel out byte-for-byte, so one offset covers both.
   Leaves the PE checksum untouched - Windows does not require it to match for normal .exe
   launch (only for some drivers/system files), so recomputing it isn't necessary. */
const fs = require('fs');
const path = require('path');

const IMAGE_SUBSYSTEM_WINDOWS_GUI = 2;
const IMAGE_SUBSYSTEM_WINDOWS_CUI = 3;

function sleepSync(ms) {
    // fs.openSync on a shared/locked buffer as a crude blocking sleep - avoids adding an async
    // wrapper just for this script's small, one-shot retry loop.
    const end = Date.now() + ms;
    while (Date.now() < end) { /* busy-wait briefly */ }
}

// A repo folder living under OneDrive (as this one does) can have its sync client briefly hold
// a read/write lock on a just-written multi-hundred-MB exe while it hashes/uploads the new
// version - CONFIRMED LIVE (EBUSY immediately after pkg's own build finished writing the same
// file). Retry with backoff instead of failing the whole build over a transient lock.
function withRetry(fn, attempts, delayMs) {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
        try { return fn(); }
        catch (e) {
            if (e.code !== 'EBUSY' && e.code !== 'EPERM') throw e;
            lastErr = e;
            console.log('hide-console: file terkunci sementara (percobaan ' + (i + 1) + '/' + attempts + ') - mungkin OneDrive sedang sinkronisasi, coba lagi...');
            sleepSync(delayMs);
        }
    }
    throw lastErr;
}

function hideConsole(exePath) {
    const buf = withRetry(() => fs.readFileSync(exePath), 8, 1500);
    if (buf.readUInt16LE(0) !== 0x5a4d) throw new Error('Bukan file PE/EXE yang valid (magic "MZ" tidak ditemukan).');
    const peOffset = buf.readUInt32LE(0x3c);
    if (buf.readUInt32LE(peOffset) !== 0x00004550) throw new Error('Signature PE tidak ditemukan di offset yang diharapkan.');
    const subsystemOffset = peOffset + 4 /* "PE\0\0" */ + 20 /* IMAGE_FILE_HEADER */ + 68 /* Subsystem's offset within IMAGE_OPTIONAL_HEADER */;
    const current = buf.readUInt16LE(subsystemOffset);
    if (current === IMAGE_SUBSYSTEM_WINDOWS_GUI) {
        console.log('hide-console: sudah GUI subsystem, tidak ada yang diubah.');
        return;
    }
    if (current !== IMAGE_SUBSYSTEM_WINDOWS_CUI) {
        throw new Error('Nilai Subsystem tak terduga (' + current + ') - dibatalkan demi keamanan, exe tidak diubah.');
    }
    buf.writeUInt16LE(IMAGE_SUBSYSTEM_WINDOWS_GUI, subsystemOffset);
    withRetry(() => fs.writeFileSync(exePath, buf), 8, 1500);
    console.log('hide-console: Subsystem diubah dari Console ke Windows (GUI) - console tidak akan muncul lagi.');
}

const target = process.argv[2] || path.join(__dirname, '..', 'dist', 'coretax-agent.exe');
hideConsole(target);
