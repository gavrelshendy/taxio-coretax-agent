/* Coretax Agent - system tray icon.
   There's no Electron here (plain Node + Playwright + pkg, see main.js's header comment), so
   there's no built-in tray API. This spawns a small hidden PowerShell process that hosts a real
   Win32 NotifyIcon (System.Windows.Forms) with its own message loop - the standard no-extra-
   dependency way to get a tray icon out of a plain Node/pkg app on Windows. The tray process
   never touches app state directly; its two menu actions just POST to this app's own local
   dashboard API (already bound to 127.0.0.1), same as any other GUI client would.

   Packaging note: pkg's virtual snapshot filesystem (assets baked into the exe) is only
   readable by THIS Node process, not by an external process like powershell.exe - so the icon
   PNG and the .ps1 script itself are both first written out to real files under os.tmpdir()
   before spawning, rather than pointing PowerShell at an in-package path. */
const { spawn, execSync } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { log } = require('./log');

let trayProcess = null;
let intentionalStop = false; // set by stop() so its own taskkill doesn't get logged as a crash

function writeIconFile() {
    const src = path.join(__dirname, '..', 'gui', 'public', 'assets', 'coretax-agent-icon.png');
    try {
        const dest = path.join(os.tmpdir(), 'coretax-agent-tray-icon.png');
        fs.writeFileSync(dest, fs.readFileSync(src));
        return dest;
    } catch (e) {
        return ''; // PS script falls back to a system icon when this is blank/unreadable
    }
}

// Menu: "Buka Dashboard" reopens/brings up the window; "Keluar" quits the whole app - the two
// things a tray icon exists for here. Both just call the dashboard's own local HTTP API rather
// than duplicating any app logic in PowerShell.
// The ENTIRE body is wrapped in one top-level try/catch that writes any exception straight to a
// file (not just relies on stderr piped back to Node) - CONFIRMED LIVE that the packaged exe's
// tray process was exiting with code=0 within ~100ms with nothing captured on stderr, which
// itself is more consistent with the script hitting an early exception in a PowerShell version/
// environment quirk (e.g. an older PowerShell 5.1 not supporting some syntax used here) than
// with external termination - a file trace survives even the Node-side stdio pipe's own timing
// subtleties (the 'exit' event can fire before a 'data' event on a piped stream is delivered).
const PS_SCRIPT = [
    'param([int]$Port = 51733, [string]$IconPath = "")',
    '$ErrorActionPreference = "Stop"',
    '$errLog = Join-Path $env:TEMP "coretax-agent-tray-error.log"',
    'try {',
    '  Add-Type -AssemblyName System.Windows.Forms',
    '  Add-Type -AssemblyName System.Drawing',
    '  try {',
    '      $bmp = New-Object System.Drawing.Bitmap($IconPath)',
    '      $icon = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())',
    '  } catch {',
    '      $icon = [System.Drawing.SystemIcons]::Application',
    '  }',
    '  $notifyIcon = New-Object System.Windows.Forms.NotifyIcon',
    '  $notifyIcon.Icon = $icon',
    '  $notifyIcon.Text = "Coretax Agent"',
    '  $notifyIcon.Visible = $true',
    '  $menu = New-Object System.Windows.Forms.ContextMenuStrip',
    '  $openItem = $menu.Items.Add("Buka Dashboard")',
    '  $quitItem = $menu.Items.Add("Keluar")',
    '  $notifyIcon.ContextMenuStrip = $menu',
    '  function Invoke-LocalApi([string]$p) {',
    '      try { Invoke-RestMethod -Method Post -Uri ("http://127.0.0.1:" + $Port + $p) -TimeoutSec 5 | Out-Null } catch {}',
    '  }',
    '  $openItem.add_Click({ Invoke-LocalApi "/api/tray/open" })',
    '  $notifyIcon.add_MouseClick({',
    '      param($s, $e)',
    '      if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Invoke-LocalApi "/api/tray/open" }',
    '  })',
    '  $quitItem.add_Click({',
    '      Invoke-LocalApi "/api/quit"',
    '      $notifyIcon.Visible = $false',
    '      [System.Windows.Forms.Application]::Exit()',
    '  })',
    '  [System.Windows.Forms.Application]::Run()',
    '} catch {',
    '  $_ | Out-String | Add-Content -Path $errLog -Encoding UTF8',
    '  exit 1',
    '}'
].join('\r\n');

/** Starts the tray icon. Idempotent (a second call while one's already running is a no-op) -
 *  safe to call unconditionally from the primary instance's own startup path. */
function start(port) {
    if (trayProcess) return;
    try {
        const iconPath = writeIconFile();
        const scriptPath = path.join(os.tmpdir(), 'coretax-agent-tray.ps1');
        fs.writeFileSync(scriptPath, PS_SCRIPT, 'utf8');
        const spawnedAt = Date.now();
        // stderr piped (not fully ignored) specifically so a silent early death - e.g. Windows
        // Defender or another AV terminating an unsigned exe's child PowerShell process, a real
        // failure mode CONFIRMED LIVE in the packaged exe (the process vanished within seconds
        // of spawn with zero prior indication, dev-mode `node main.js` never reproduced it) -
        // leaves an actual diagnostic trail instead of just quietly not existing.
        trayProcess = spawn('powershell.exe', [
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
            '-File', scriptPath, '-Port', String(port), '-IconPath', iconPath
        // detached:false is DELIBERATE - CONFIRMED LIVE (both in dev mode and via the packaged
        // exe) that detached:true makes a WinForms Application.Run() message loop exit almost
        // immediately (code 0, ~100-150ms, no error of any kind - only surfaced by isolating
        // spawn() options one at a time against a plain `Start-Process` baseline that DID stay
        // alive). Not needed anyway: stop() below always explicitly taskkills this process by
        // PID rather than relying on OS-level detachment, and main.js's own `process.on('exit')`
        // safety net calls stop() too - this app never depended on the tray surviving an
        // unmanaged parent death, only living for as long as the parent explicitly keeps it.
        ], { detached: false, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
        let stderrBuf = '';
        trayProcess.stderr.on('data', (d) => { stderrBuf += d.toString(); });
        trayProcess.unref();
        // 'close' (not 'exit') - guaranteed to fire only after stdio streams are fully flushed,
        // so stderrBuf is complete by the time this reads it ('exit' can fire first and race a
        // still-arriving 'data' event on a piped stream).
        trayProcess.on('close', (code, signal) => {
            const aliveMs = Date.now() - spawnedAt;
            if (intentionalStop) { intentionalStop = false; trayProcess = null; return; }
            if (aliveMs < 15000) {
                const errLogPath = path.join(os.tmpdir(), 'coretax-agent-tray-error.log');
                let fileErr = '';
                try { fileErr = fs.readFileSync(errLogPath, 'utf8').trim().slice(-800); fs.unlinkSync(errLogPath); } catch (e) {}
                log('[SECURITY/DIAG] Ikon tray berhenti tak terduga ' + aliveMs + 'ms setelah dimulai (code=' + code + ', signal=' + signal + ').'
                    + (fileErr ? ' Error dari skrip: ' + fileErr : '')
                    + (stderrBuf ? ' stderr: ' + stderrBuf.trim().slice(0, 500) : '')
                    + (!fileErr && !stderrBuf ? ' Tidak ada jejak error sama sekali - kemungkinan dihentikan paksa dari luar (mis. Windows Defender/antivirus, karena exe ini belum ditandatangani).' : ''));
            }
            trayProcess = null;
        });
        log('Ikon tray Coretax Agent aktif.');
    } catch (e) {
        log('Gagal memulai ikon tray: ' + e.message);
    }
}

/** Kills the tray helper process. MUST be called before the app quits (from whichever path -
 *  the tray's own "Keluar", the topbar "Keluar" button, or a fatal startup error) - otherwise
 *  the NotifyIcon is orphaned: still visible in the tray, but both its menu actions silently
 *  fail forever since the dashboard server behind them is gone. `taskkill /T` (not a plain
 *  process.kill) so PowerShell's own child handles go with it, not just the top process. */
function stop() {
    if (!trayProcess) return;
    const pid = trayProcess.pid;
    intentionalStop = true;
    try { execSync('taskkill /PID ' + pid + ' /T /F', { windowsHide: true, stdio: 'ignore' }); } catch (e) { /* already gone */ }
    trayProcess = null;
}

module.exports = { start, stop };
