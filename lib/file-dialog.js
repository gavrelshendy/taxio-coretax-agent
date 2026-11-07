/* Dialog pilih file/folder Windows untuk dashboard. Dulu setiap klik menyalakan powershell.exe baru lalu memuat
 * Windows Forms - di PC kantor (antivirus) beberapa detik tanpa tanda apa pun, sehingga pengguna mengklik lagi
 * dan muncul DUA dialog (laporan 2026-11-05). Kini satu PowerShell disiapkan sejak aplikasi mulai dan dipakai
 * ulang (permintaan lewat stdin, jawaban satu baris di stdout), dan hanya satu dialog boleh terbuka sekaligus.
 * Bila proses siaga itu mati atau tidak bisa dinyalakan, jatuh ke cara lama (satu PowerShell per dialog). */
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { log } = require('./log');

const PS_SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms
[Console]::InputEncoding = [Text.Encoding]::UTF8
[Console]::OutputEncoding = [Text.Encoding]::UTF8
[Console]::Out.WriteLine('READY')
while (($line = [Console]::In.ReadLine()) -ne $null) {
  try {
    $r = $line | ConvertFrom-Json
    $top = New-Object System.Windows.Forms.Form
    $top.TopMost = $true
    if ($r.kind -eq 'folder') {
      $d = New-Object System.Windows.Forms.FolderBrowserDialog
      $d.Description = $r.title; $d.ShowNewFolderButton = $true
      $ok = $d.ShowDialog($top); $p = $d.SelectedPath
    } else {
      $d = New-Object System.Windows.Forms.OpenFileDialog
      $d.Title = $r.title; $d.Filter = $r.filter; $d.ShowHelp = $false
      if ($r.dir -and (Test-Path -LiteralPath $r.dir)) { $d.InitialDirectory = $r.dir }
      $ok = $d.ShowDialog($top); $p = $d.FileName
    }
    $top.Dispose()
    if ($ok -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.WriteLine('OK ' + $p) } else { [Console]::Out.WriteLine('CANCEL') }
  } catch { [Console]::Out.WriteLine('ERROR ' + $_.Exception.Message) }
}
`;

let worker = null, ready = false, pending = null, buffer = '', busy = false;

function warm() {
    if (worker || process.platform !== 'win32') return;
    try {
        const scriptPath = path.join(os.tmpdir(), 'coretax-agent-file-dialog.ps1');
        fs.writeFileSync(scriptPath, PS_SCRIPT, 'utf8');
        // detached:false - sama dengan lib/tray.js (WinForms di proses detached berhenti seketika).
        worker = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
            { detached: false, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
        worker.stdout.setEncoding('utf8');
        worker.stdout.on('data', (chunk) => {
            buffer += chunk;
            let i;
            while ((i = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, i).replace(/\r$/, ''); buffer = buffer.slice(i + 1);
                if (line === 'READY') { ready = true; continue; }
                if (pending) { const done = pending; pending = null; done(line); }
            }
        });
        const reset = () => { worker = null; ready = false; buffer = ''; if (pending) { const done = pending; pending = null; done(null); } };
        worker.on('close', reset);
        worker.on('error', reset);
        worker.unref();
    } catch (e) { worker = null; log('Dialog file siaga tidak bisa disiapkan (' + e.message + ') - memakai cara lama.'); }
}

function stop() { try { if (worker) worker.kill(); } catch (e) { /* abaikan */ } worker = null; ready = false; }

/** Cara lama: satu PowerShell per dialog (cadangan). */
function oneShot(req) {
    return new Promise((resolve) => {
        const q = (s) => String(s == null ? '' : s).replace(/'/g, "''");
        const body = req.kind === 'folder'
            ? `$d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = '${q(req.title)}'; $d.ShowNewFolderButton = $true; $ok = $d.ShowDialog($top); $p = $d.SelectedPath`
            : `$d = New-Object System.Windows.Forms.OpenFileDialog; $d.Title = '${q(req.title)}'; $d.Filter = '${q(req.filter)}'; $d.ShowHelp = $false; ${req.dir ? "if (Test-Path -LiteralPath '" + q(req.dir) + "') { $d.InitialDirectory = '" + q(req.dir) + "' }; " : ''}$ok = $d.ShowDialog($top); $p = $d.FileName`;
        const script = `Add-Type -AssemblyName System.Windows.Forms; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $top = New-Object System.Windows.Forms.Form; $top.TopMost = $true; ${body}; if ($ok -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $p }`;
        execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, encoding: 'utf8' },
            (err, stdout) => resolve(err || !stdout ? null : stdout.trim() || null));
    });
}

/** { kind: 'file'|'folder', title, filter } -> path, null bila dibatalkan, atau { busy: true } bila dialog lain masih terbuka. */
async function pick(req) {
    if (busy) return { busy: true };
    busy = true;
    try {
        if (worker && ready && !pending) {
            const line = await new Promise((resolve) => { pending = resolve; worker.stdin.write(JSON.stringify(req) + '\n'); });
            if (line && line.startsWith('OK ')) return line.slice(3);
            if (line === 'CANCEL') return null;
            log('Dialog file siaga gagal (' + (line || 'proses berhenti') + ') - memakai cara lama.');
        }
        return await oneShot(req);
    } finally {
        busy = false;
        if (!worker) warm();
    }
}

module.exports = { warm, stop, pick };
