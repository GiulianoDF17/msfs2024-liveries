'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const packager = require('../lib/packager');
const scanner = require('../lib/scanner');
const { ProjectStore } = require('../lib/projects');
const { makeFakeSim, tmpDir } = require('./helpers');

const PNG_1x1 = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63f8cfc0f01f0005000201a1e8e7a90000000049454e44ae426082', 'hex');

function makeProject(modular = false) {
  const sim = makeFakeSim();
  const docs = tmpDir();
  const store = new ProjectStore(path.join(docs, 'Projects'));
  const acPath = modular ? sim.a320 : sim.c172;
  const ac = scanner.scanAircraft([{ path: sim.community, source: 'Community' }]).find((a) => a.path === acPath);
  ac.textures = scanner.listTextures(acPath);
  if (modular) ac.fallbackFolders = scanner.modularFallbackFolders(acPath).map((f) => path.relative(acPath, f));
  const p = store.create({ name: 'Red Baron N123', aircraft: ac, author: 'Jane Doe' });
  const texName = modular ? 'A320_FUSELAGE_ALBD' : 'C172_FUSELAGE_ALBD';
  p.textures.push({ id: 'tex1', name: texName, type: 'albedo', width: 1, height: 1, layers: [] });
  p.textures.push({ id: 'tex2', name: 'C172_FUSELAGE_COMP', type: 'comp', width: 1, height: 1, layers: [], include: false });
  p.details.atcId = 'N123RB';
  p.details.icaoAirline = 'RBN';
  p.details.atcAirline = 'Red "Baron"';
  p.details.description = 'A red livery.';
  p.details.version = '1.2';
  store.writeFile(p.id, `textures/${texName}.PNG`, PNG_1x1);
  store.save(p);
  return { sim, docs, store, p, dir: store.dir(p.id) };
}

test('packageName is a safe lowercase slug', () => {
  assert.strictEqual(packager.packageName('Jane Doe', 'Asobo_C172', 'Red Baron N123'), 'jane-doe-asobo-c172-red-baron-n123');
  assert.strictEqual(packager.packageName('', '', ''), 'liveryforge-aircraft-livery');
  assert.match(packager.packageName('../x', 'A/B', 'C\\D'), /^[a-z0-9-]+$/);
});

test('textureXml uses the right bitmap slot', () => {
  assert.match(packager.textureXml('albedo'), /<BitmapSlot>MTL_BITMAP_DECAL0<\/BitmapSlot>/);
  assert.match(packager.textureXml('decal'), /MTL_BITMAP_DECAL0/);
  assert.match(packager.textureXml('comp'), /MTL_BITMAP_METAL_ROUGH_AO/);
  assert.match(packager.textureXml('normal'), /MTL_BITMAP_NORMAL/);
  assert.match(packager.textureXml('albedo', true), /QUALITYHIGH/);
  assert.doesNotMatch(packager.textureXml('albedo', false), /QUALITYHIGH/);
});

test('normalizeVersion', () => {
  assert.strictEqual(packager.normalizeVersion('1.2'), '1.2.0');
  assert.strictEqual(packager.normalizeVersion('v?'), '1.0.0');
  assert.strictEqual(packager.normalizeVersion('2.3.4-beta'), '2.3.4');
});

test('simple livery: writes aircraft.cfg, texture.cfg and XML files', () => {
  const { p, dir } = makeProject(false);
  const r = packager.writeSdkProject(p, dir, { highQuality: true });
  assert.strictEqual(r.mode, 'simple');
  const pkg = 'jane-doe-asobo-c172-red-baron-n123';
  assert.strictEqual(r.pkg, pkg);
  const b = (rel) => fs.readFileSync(path.join(dir, 'build', ...rel.split('/')), 'utf8');

  const proj = b('project.xml');
  assert.match(proj, new RegExp(`<Package>PackageDefinitions\\\\${pkg}.xml</Package>`));
  const def = b(`PackageDefinitions/${pkg}.xml`);
  assert.match(def, /<Type>SimObject<\/Type>/);
  assert.match(def, new RegExp(`<AssetDir>PackageSources\\\\SimObjects\\\\Airplanes\\\\${pkg}\\\\</AssetDir>`));
  assert.match(def, /Version="1.2.0"/);
  assert.match(def, /<Creator>Jane Doe<\/Creator>/);

  const cfgText = b(`PackageSources/SimObjects/Airplanes/${pkg}/aircraft.cfg`);
  const cfg = scanner.parseCfg(cfgText);
  assert.strictEqual(scanner.getCfg(cfg, 'VARIATION', 'base_container'), '..\\Asobo_C172');
  assert.strictEqual(scanner.getCfg(cfg, 'FLTSIM.0', 'texture'), 'RED_BARON_N123');
  assert.strictEqual(scanner.getCfg(cfg, 'FLTSIM.0', 'atc_id'), 'N123RB');
  assert.strictEqual(scanner.getCfg(cfg, 'FLTSIM.0', 'icao_airline'), 'RBN');
  assert.strictEqual(scanner.getCfg(cfg, 'FLTSIM.0', 'atc_airline'), "Red 'Baron'");
  assert.strictEqual(scanner.getCfg(cfg, 'FLTSIM.0', 'ui_createdby'), 'Jane Doe');
  assert.strictEqual(scanner.getCfg(cfg, 'FLTSIM.0', 'atc_parking_types'), 'RAMP');

  const texDir = `PackageSources/SimObjects/Airplanes/${pkg}/texture.RED_BARON_N123`;
  const tcfg = scanner.parseCfg(b(`${texDir}/texture.cfg`));
  assert.strictEqual(scanner.getCfg(tcfg, 'fltsim', 'fallback.1'), '..\\..\\Asobo_C172\\texture');
  assert.strictEqual(scanner.getCfg(tcfg, 'fltsim', 'fallback.2'), '..\\..\\Asobo_C172\\texture.common');
  assert.match(b(`${texDir}/C172_FUSELAGE_ALBD.PNG.xml`), /MTL_BITMAP_DECAL0/);
  assert.ok(fs.existsSync(path.join(dir, 'build', ...`${texDir}/C172_FUSELAGE_ALBD.PNG`.split('/'))));
  // include:false texture must NOT be written
  assert.ok(!fs.existsSync(path.join(dir, 'build', ...`${texDir}/C172_FUSELAGE_COMP.PNG`.split('/'))));
});

test('modular livery (experimental): writes livery.cfg in liveries folder', () => {
  const { p, dir } = makeProject(true);
  p.details.company = 'Jane Studio';
  p.details.requiredTags = 'node_default';
  const r = packager.writeSdkProject(p, dir);
  assert.strictEqual(r.mode, 'modular');
  const base = 'PackageSources/SimObjects/Airplanes/Vendor_A320/liveries/jane-studio/red-baron-n123';
  const b = (rel) => fs.readFileSync(path.join(dir, 'build', ...rel.split('/')), 'utf8');
  const cfg = scanner.parseCfg(b(`${base}/livery.cfg`));
  assert.strictEqual(scanner.getCfg(cfg, 'Version', 'major'), '1');
  assert.strictEqual(scanner.getCfg(cfg, 'General', 'name'), 'Red Baron N123');
  assert.strictEqual(scanner.getCfg(cfg, 'FLTSIM.0', 'icao_airline'), 'RBN');
  assert.strictEqual(scanner.getCfg(cfg, 'FLTSIM.0', 'atc_id'), 'N123RB');
  assert.strictEqual(scanner.getCfg(cfg, 'SELECTION', 'required_tags'), 'node_default');
  const tcfg = scanner.parseCfg(b(`${base}/texture/texture.cfg`));
  assert.strictEqual(scanner.getCfg(tcfg, 'fltsim', 'fallback.1'), '..\\..\\..\\..\\common\\texture');
  assert.ok(fs.existsSync(path.join(dir, 'build', ...`${base}/texture/A320_FUSELAGE_ALBD.PNG.xml`.split('/'))));
});

test('preflight catches missing author, unsaved and unknown textures', () => {
  const { p, dir } = makeProject(false);
  p.details.author = '';
  p.textures.push({ id: 'tex3', name: 'NOT_A_REAL_TEX', type: 'albedo', layers: [] });
  const r = packager.preflight(p, dir);
  assert.ok(r.errors.some((e) => /Author/.test(e)));
  assert.ok(r.errors.some((e) => /NOT_A_REAL_TEX has not been saved/.test(e)));
  assert.ok(r.warnings.some((w) => /NOT_A_REAL_TEX/.test(w)));
});

test('compile + finish + zip + Community link/copy/remove (fake SDK tool)', async () => {
  const { p, dir, docs, sim } = makeProject(false);
  const r = packager.writeSdkProject(p, dir);
  const logs = [];
  const res = await packager.compile({
    projectXmlPath: r.projectXml,
    command: process.execPath,
    args: [path.join(__dirname, 'fake-fspackagetool.js'), r.projectXml],
    onLog: (lvl, t) => logs.push([lvl, t]),
  });
  assert.strictEqual(res.ok, true);
  assert.ok(logs.some(([l, t]) => l === 'warn' && /minor/.test(t)));

  const out = path.join(docs, 'Output');
  const fin = await packager.finishPackage(p, dir, out);
  assert.strictEqual(path.basename(fin.zipPath), `${r.pkg}_v1.2.0.zip`);
  assert.ok(fin.zipSize > 0);
  const manifest = JSON.parse(fs.readFileSync(path.join(fin.packageDir, 'manifest.json'), 'utf8'));
  assert.strictEqual(manifest.creator, 'Jane Doe');
  assert.strictEqual(manifest.package_version, '1.2.0');
  assert.match(fs.readFileSync(path.join(fin.packageDir, 'README.txt'), 'utf8'), /INSTALLATION/);

  // zip contains the package folder at its root
  const zipText = fs.readFileSync(fin.zipPath).toString('latin1');
  assert.ok(zipText.includes(`${r.pkg}/manifest.json`));

  // Community link
  const inst = packager.installToCommunity(fin.packageDir, sim.community, 'link');
  assert.strictEqual(packager.communityStatus(r.pkg, sim.community), 'link');
  assert.ok(fs.existsSync(path.join(inst.target, 'manifest.json')));
  // Re-install replaces the link
  packager.installToCommunity(fin.packageDir, sim.community, 'copy');
  assert.strictEqual(packager.communityStatus(r.pkg, sim.community), 'copy');
  packager.removeFromCommunity(r.pkg, sim.community);
  assert.strictEqual(packager.communityStatus(r.pkg, sim.community), null);
  assert.ok(fs.existsSync(fin.packageDir), 'removing must never delete the real package');

  // A foreign folder with the same name is never touched
  fs.mkdirSync(path.join(sim.community, r.pkg));
  assert.throws(() => packager.installToCommunity(fin.packageDir, sim.community, 'link'), /not made by Livery Forge/);
  assert.throws(() => packager.removeFromCommunity(r.pkg, sim.community));
});

test('compile reports failure and missing SDK', async () => {
  const { p, dir } = makeProject(false);
  const r = packager.writeSdkProject(p, dir);
  process.env.FAKE_FAIL = '1';
  const logs = [];
  const res = await packager.compile({ projectXmlPath: r.projectXml, command: process.execPath, args: [path.join(__dirname, 'fake-fspackagetool.js'), r.projectXml], onLog: (l, t) => logs.push([l, t]) });
  delete process.env.FAKE_FAIL;
  assert.strictEqual(res.ok, false);
  assert.ok(logs.some(([l]) => l === 'hint'));
  const res2 = await packager.compile({ sdkPath: '/nope', projectXmlPath: r.projectXml, onLog: (l, t) => logs.push([l, t]) });
  assert.strictEqual(res2.ok, false);
  assert.ok(logs.some(([, t]) => /SDK not found/.test(t)));
});

test('source-only zip', async () => {
  const { p, dir, docs } = makeProject(false);
  packager.writeSdkProject(p, dir);
  const z = await packager.zipSourceProject(p, dir, path.join(docs, 'Output'));
  assert.match(path.basename(z.zipPath), /_source_v1\.2\.0\.zip$/);
  assert.ok(fs.readFileSync(z.zipPath).toString('latin1').includes('HOW-TO-COMPILE.txt'));
});
