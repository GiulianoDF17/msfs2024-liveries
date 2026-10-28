/**
 * Full end-to-end UI test of Livery Forge (runs the real Electron app).
 *
 *   SB_URL=http://127.0.0.1:54321 SB_KEY=<anon key> xvfb-run -a node test/ui/e2e.js <screenshot dir>
 *
 * Needs a Supabase server with supabase/schema.sql applied (e.g. `npx supabase start`).
 */
'use strict';
const { _electron: electron } = require('playwright');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { makeFixture } = require('./fixture');

const OUT = process.argv[2] || path.join(__dirname, 'shots');
fs.mkdirSync(OUT, { recursive: true });
const rnd = Math.random().toString(36).slice(2, 7);
let n = 0;

async function launch(fx) {
  const app = await electron.launch({
    args: [path.join(__dirname, '..', '..'), '--no-sandbox'],
    executablePath: require('electron'),
    env: { ...process.env, LIVERY_FORGE_HOME: fx.home, LIVERY_FORGE_USERDATA: fx.userData },
  });
  const win = await app.firstWindow();
  win.on('pageerror', (e) => { console.log('[pageerror]', e.message); errors.push(e.message); });
  win.on('console', (m) => { if (m.type() === 'error') console.log('[console.error]', m.text()); });
  await win.setViewportSize({ width: 1440, height: 900 }).catch(() => {});
  // Replace file dialogs with fixed answers (main process).
  await app.evaluate(({ dialog }, shot) => {
    dialog.showOpenDialog = async (_w, opts) => ({ canceled: false, filePaths: [opts.properties.includes('openDirectory') ? '/tmp' : shot] });
  }, fx.shot);
  return { app, win };
}
const errors = [];
const shot = async (win, name) => { n++; await win.screenshot({ path: path.join(OUT, `${String(n).padStart(2, '0')}-${name}.png`) }); };
const toastText = (win) => win.locator('.toast').allTextContents();
const step = (s) => console.log('▶', s);

(async () => {
  const fx = makeFixture({ supabaseUrl: process.env.SB_URL, supabaseKey: process.env.SB_KEY });
  let { app, win } = await launch(fx);

  step('sign up as creator');
  await win.waitForSelector('#auth:not(.hidden)');
  await win.click('text=Create account');
  await win.fill('input[placeholder="e.g. Captain Sarah"]', 'UI Tester');
  await win.fill('input[placeholder="e.g. sarah_paints"]', `ui_${rnd}`);
  await win.waitForSelector('text=is available');
  await win.click('.role-card:has-text("Creator")');
  await win.fill('input[type=email]', `ui_${rnd}@example.com`);
  await win.fill('input[placeholder="At least 8 characters"]', 'Sup3r-secret!');
  await win.fill('input[placeholder="Type it again"]', 'Sup3r-secret!');
  await win.check('form input[type=checkbox]');
  await shot(win, 'signup');
  await win.click('button:has-text("Create my account")');
  await win.waitForSelector('#app:not(.hidden)');
  await win.waitForSelector('text=No liveries yet');
  await shot(win, 'projects-empty');
  assert.ok(await win.locator('#account').textContent().then((t) => t.includes('Creator')));

  step('pick aircraft and create project');
  await win.click('#nav button[data-screen=aircraft]');
  await win.waitForSelector('.list-item');
  await win.click('.list-item:has-text("Cessna 172 Skyhawk")');
  await win.waitForSelector('text=C172_FUSELAGE_ALBD');
  await shot(win, 'aircraft');
  await win.fill('input[placeholder="e.g. Red Baron N123LF"]', 'Sunset Stripes');
  await win.click('button:has-text("Create project")');
  await win.waitForSelector('.tex-panel');

  step('add blank texture and paint');
  await win.click('button:has-text("Add texture")');
  await win.click('.choice:has-text("Blank canvas")');
  await win.selectOption('.modal select >> nth=0', '1024');
  await win.fill('input[list=texNames]', 'C172_FUSELAGE_ALBD');
  await win.waitForSelector('text=Matches a texture of this aircraft');
  await win.click('.modal-foot button:has-text("Add texture")');
  await win.waitForSelector('.tex-item.active:has-text("C172_FUSELAGE_ALBD")');
  await win.waitForTimeout(500);
  const box = await win.locator('.ed-canvas').boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  // brush stroke
  await win.keyboard.press('b');
  await win.mouse.move(cx - 150, cy - 50);
  await win.mouse.down();
  for (let i = 0; i <= 20; i++) await win.mouse.move(cx - 150 + i * 15, cy - 50 + Math.sin(i / 3) * 30);
  await win.mouse.up();
  // rectangle
  await win.keyboard.press('r');
  await win.mouse.move(cx - 100, cy + 40); await win.mouse.down(); await win.mouse.move(cx + 120, cy + 120, { steps: 5 }); await win.mouse.up();
  // fill in a new layer
  await win.click('button[title="New layer"]');
  const layerCount = await win.locator('.layer-row').count();
  assert.strictEqual(layerCount, 2);
  await win.keyboard.press('g');
  await win.mouse.click(cx + 200, cy - 150);
  // undo & redo
  await win.keyboard.press('Control+z');
  await win.waitForTimeout(200);
  await win.keyboard.press('Control+y');
  await win.waitForTimeout(200);
  // text tool
  await win.keyboard.press('t');
  await win.mouse.click(cx, cy + 200);
  await win.waitForSelector('.modal:has-text("Add text")');
  await win.fill('.modal textarea', 'N42UI');
  await win.click('.modal-foot button:has-text("Add text layer")');
  assert.strictEqual(await win.locator('.layer-row').count(), 3);
  await shot(win, 'paint');
  // pixel check: composite has paint
  const painted = await win.evaluate(() => {
    const ed = window.__lfTest.S.editor;
    const d = ed.compCtx.getImageData(0, 0, ed.doc.width, ed.doc.height).data;
    let red = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 150 && d[i + 1] < 90) red++;
    return { red, undo: ed.undo.length };
  });
  assert.ok(painted.red > 1000, 'red paint present ' + JSON.stringify(painted));
  // brush opacity must not stack within one stroke
  const stack = await win.evaluate(async () => {
    const ed = window.__lfTest.S.editor;
    ed.addLayer('opacity test');
    ed.setTool('brush');
    ed.brush.opacity = 0.5; ed.brush.hardness = 1; ed.brush.size = 40;
    const view = ed.view.getBoundingClientRect();
    const toScreen = (x, y) => ({ clientX: view.left + ed.panX + x * ed.zoom, clientY: view.top + ed.panY + y * ed.zoom });
    const fire = (type, x, y) => ed.view.dispatchEvent(new PointerEvent(type, { ...toScreen(x, y), button: 0, pointerId: 1, bubbles: true }));
    fire('pointerdown', 500, 900); for (let i = 0; i < 30; i++) fire('pointermove', 500 + (i % 2) * 2, 900); fire('pointerup', 500, 900);
    const a = ed.active.ctx.getImageData(500, 900, 1, 1).data[3];
    ed.brush.opacity = 1;
    return a;
  });
  assert.ok(stack >= 120 && stack <= 135, 'stroke alpha should be ~128, got ' + stack);
  await win.evaluate(() => window.__lfTest.S.editor.doUndo());
  await win.keyboard.press('Control+s');
  await win.waitForTimeout(1500);

  step('import aircraft PNG texture');
  await win.click('button:has-text("Add texture")');
  await win.click('.choice:has-text("Aircraft texture")');
  await win.selectOption('.modal select[size]', { index: 0 });
  await win.click('.modal-foot button:has-text("Add texture")');
  await win.waitForSelector('.tex-item.active:has-text("C172_WINGS_ALBD")');

  step('details');
  await win.click('#nav button[data-screen=details]');
  await win.fill('input[placeholder="e.g. N123LF"]', 'N42UI');
  await win.fill('textarea[placeholder^="Describe your livery"]', 'This is a bright sunset striped livery for the Cessna 172 with a custom registration and new textures.');
  await win.check('text=This is my own work or I have written permission.');
  await win.fill('.tags-input input', 'cessna');
  await win.keyboard.press('Enter');
  await win.click('button:has-text("Add screenshots")');
  await win.waitForSelector('.shot .num');
  await win.click('button:has-text("Choose image...")');
  await win.waitForTimeout(1200);
  await shot(win, 'details');

  step('export & test');
  await win.click('#nav button[data-screen=export]');
  await win.waitForSelector('text=Package name');
  await shot(win, 'export-before');
  await win.click('button:has-text("Export & test in sim")');
  await win.waitForSelector('.log .l-ok:has-text("Linked into Community")', { timeout: 30000 });
  await win.waitForSelector('text=Last export');
  await shot(win, 'export-done');
  const pkgDir = fs.readdirSync(fx.sim.community).find((d) => d.startsWith('test-painter-asobo-c172-sunset-stripes'));
  assert.ok(pkgDir, 'package linked in Community');
  assert.ok(fs.lstatSync(path.join(fx.sim.community, pkgDir)).isSymbolicLink());
  const tex = path.join(fx.sim.community, pkgDir, 'SimObjects', 'Airplanes', pkgDir, 'texture.SUNSET_STRIPES');
  assert.ok(fs.existsSync(path.join(tex, 'C172_FUSELAGE_ALBD.PNG')), 'painted texture packaged');
  assert.ok(fs.existsSync(path.join(tex, 'C172_WINGS_ALBD.PNG.xml')));
  const zips = fs.readdirSync(path.join(fx.home, 'Output'));
  assert.ok(zips.includes(`${pkgDir}_v1.0.0.zip`), 'zip created: ' + zips);

  step('publish: flightsim.to + marketplace');
  await win.click('#nav button[data-screen=publish]');
  await win.waitForSelector('button:has-text("Prepare upload")');
  await win.click('button:has-text("Prepare upload")');
  await win.waitForSelector('button:has-text("Open upload folder")');
  assert.ok(fs.existsSync(path.join(fx.home, 'Output', `${pkgDir}_flightsimto`, 'UPLOAD-CHECKLIST.txt')));
  await shot(win, 'publish');
  await win.click('button:has-text("Publish to marketplace")');
  await win.waitForSelector('.gallery-main', { timeout: 30000 });
  await shot(win, 'listing');

  step('marketplace browse + download/install');
  await win.click('button:has-text("Back to marketplace")');
  await win.waitForSelector('.listing-card:has-text("Sunset Stripes")');
  await shot(win, 'market');
  await win.click('.listing-card:has-text("Sunset Stripes")');
  await win.click('button:has-text("Download & install")');
  await win.waitForSelector('text=In Community', { timeout: 30000 });
  await win.click('#nav button[data-screen=studio]');
  await win.waitForSelector('text=Total downloads');
  await shot(win, 'studio');
  await win.click('#nav button[data-screen=hangar]');
  await win.waitForSelector('.listing-card');
  await shot(win, 'hangar');

  step('profile + settings screens');
  await win.click('.account-card');
  await win.waitForSelector('text=Account type');
  await win.click('.role-card:has-text("Both")');
  await win.fill('input[placeholder="e.g. KSEA"]', 'ksea');
  await win.click('button:has-text("Save profile")');
  await win.waitForSelector('text=Pilot & Creator');
  await shot(win, 'profile');
  await win.click('#nav button[data-screen=settings]');
  await win.waitForSelector('text=fspackagetool.exe found');
  await shot(win, 'settings');

  step('reinstall: wipe local data, log in again, projects come back');
  await win.waitForTimeout(5000); // let auto-sync push the latest changes
  await win.click('#nav button[data-screen=projects]');
  await win.click('button:has-text("Sync now")');
  await win.waitForSelector('text=Sync done');
  await app.close();
  fs.rmSync(path.join(fx.home, 'Projects'), { recursive: true, force: true });
  fs.rmSync(path.join(fx.userData, 'session.dat'), { force: true });
  ({ app, win } = await launch(fx));
  await win.waitForSelector('#auth:not(.hidden)');
  await win.fill('input[type=email]', `ui_${rnd}@example.com`);
  await win.fill('input[type=password]', 'Sup3r-secret!');
  await win.click('form button:has-text("Log in")');
  await win.waitForSelector('.project-card:has-text("Sunset Stripes")', { timeout: 30000 });
  await shot(win, 'projects-restored');
  await win.click('.project-card:has-text("Sunset Stripes") button:has-text("Open")');
  await win.waitForSelector('.layer-row');
  await win.waitForTimeout(800);
  const restored = await win.evaluate(() => {
    const ed = window.__lfTest.S.editor;
    const d = ed.compCtx.getImageData(0, 0, ed.doc.width, ed.doc.height).data;
    let red = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 150 && d[i + 1] < 90) red++;
    return { red, layers: ed.doc.layers.length, w: ed.doc.width };
  });
  assert.ok(restored.red > 1000 && restored.layers >= 3, 'restored paint ' + JSON.stringify(restored));
  await shot(win, 'paint-restored');
  await app.close();

  assert.deepStrictEqual(errors, [], 'no page errors');
  console.log('\nE2E UI TEST PASSED ✔');
})().catch(async (e) => {
  console.error('E2E FAILED:', e);
  process.exit(1);
});
