// Minimal test - does Chrome actually show a visible window?
const { chromium } = require('playwright');
const path = require('path');
const os = require('os');

(async () => {
    // Kill orphan chromes first
    const { execSync } = require('child_process');
    try { execSync('taskkill /F /IM chrome.exe /T 2>nul', { stdio: 'ignore' }); } catch(e) {}
    await new Promise(r => setTimeout(r, 1500));

    const testDir = path.join(os.homedir(), '.coretax-agent-profile', '_test_visible');
    
    console.log('Test 1: bare minimum launch...');
    const ctx = await chromium.launchPersistentContext(testDir, {
        headless: false,
        channel: 'chrome',
        viewport: null,
        args: ['--start-maximized', '--no-first-run'],
        ignoreDefaultArgs: ['--enable-automation']
    });
    
    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto('https://example.com', { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
    
    console.log('Page URL:', page.url());
    console.log('Waiting 8 seconds - DO YOU SEE A CHROME WINDOW?');
    
    // Check MainWindowHandle via powershell
    try {
        const out = execSync('powershell -NoProfile -Command "Get-Process chrome -EA 0 | Select Id, MainWindowHandle, MainWindowTitle | Format-Table -AutoSize"', { encoding: 'utf8' });
        console.log('Chrome processes:\n' + out);
    } catch(e) {}
    
    await new Promise(r => setTimeout(r, 8000));
    await ctx.close();
    console.log('Done - closed.');
    process.exit(0);
})();
