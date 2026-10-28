// Quick launch: opens the app and takes a screenshot.
'use strict';
const { _electron: electron } = require('playwright');
const path = require('path');
const { makeFixture } = require('./fixture');
(async () => {
  const fx = makeFixture({ supabaseUrl: process.env.SB_URL || '', supabaseKey: process.env.SB_KEY || '' });
  const app = await electron.launch({
    args: [path.join(__dirname, '..', '..'), '--no-sandbox'],
    executablePath: require('electron'),
    env: { ...process.env, LIVERY_FORGE_HOME: fx.home, LIVERY_FORGE_USERDATA: fx.userData },
  });
  const win = await app.firstWindow();
  win.on('console', (m) => console.log('[renderer]', m.type(), m.text()));
  win.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await win.waitForTimeout(2000);
  await win.screenshot({ path: process.argv[2] || 'shot.png' });
  await app.close();
})().catch((e) => { console.error(e); process.exit(1); });
