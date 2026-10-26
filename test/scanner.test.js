'use strict';
const test = require('node:test');
const assert = require('node:assert');
const scanner = require('../lib/scanner');
const { makeFakeSim } = require('./helpers');

test('parseCfg reads sections, strips comments and quotes', () => {
  const cfg = scanner.parseCfg('\uFEFF; header\n[General]\ntitle = "A ; B" ; comment\nicao = C172 // c\n\n[FLTSIM.1]\ntitle=x\n[fltsim.0]\ntitle="y"\n');
  assert.strictEqual(cfg.General.title, 'A ; B');
  assert.strictEqual(cfg.General.icao, 'C172');
  assert.strictEqual(scanner.getCfg(cfg, 'general', 'TITLE'), 'A ; B');
  const fs = scanner.fltsimSections(cfg);
  assert.deepStrictEqual(fs.map((s) => s.title), ['y', 'x']);
});

test('splitTextureName and detectTextureType', () => {
  assert.deepStrictEqual(scanner.splitTextureName('A_FUSELAGE_ALBD.PNG.KTX2'), { name: 'A_FUSELAGE_ALBD', ext: '.png.ktx2' });
  assert.deepStrictEqual(scanner.splitTextureName('x.dds'), { name: 'x', ext: '.dds' });
  assert.strictEqual(scanner.splitTextureName('readme.txt'), null);
  assert.strictEqual(scanner.detectTextureType('FUSELAGE_ALBD'), 'albedo');
  assert.strictEqual(scanner.detectTextureType('FUSELAGE_COMP'), 'comp');
  assert.strictEqual(scanner.detectTextureType('FUSELAGE_NORM'), 'normal');
  assert.strictEqual(scanner.detectTextureType('REG_DECAL'), 'decal');
  assert.strictEqual(scanner.detectTextureType('PANEL_EMIS'), 'emissive');
});

test('scanAircraft finds aircraft with badges', () => {
  const sim = makeFakeSim();
  const list = scanner.scanAircraft([
    { path: sim.community, source: 'Community' },
    { path: sim.official, source: 'Official' },
    { path: sim.community, source: 'Community' }, // duplicates removed
  ]);
  const byFolder = Object.fromEntries(list.map((a) => [a.folder, a]));
  assert.strictEqual(list.length, 4);
  assert.strictEqual(byFolder.Asobo_C172.title, 'Cessna 172 Skyhawk');
  assert.strictEqual(byFolder.Asobo_C172.manufacturer, 'CESSNA');
  assert.strictEqual(byFolder.Asobo_C172.modular, false);
  assert.strictEqual(byFolder.C172_Red.isLivery, true);
  assert.strictEqual(byFolder.Vendor_A320.modular, true);
  assert.strictEqual(byFolder.Payware_Jet.encrypted, true);
  assert.strictEqual(byFolder.Payware_Jet.source, 'Official');
});

test('listTextures lists editable and compiled textures', () => {
  const sim = makeFakeSim();
  const tex = scanner.listTextures(sim.c172);
  const names = tex.map((t) => t.name);
  assert.ok(names.includes('C172_FUSELAGE_ALBD'));
  assert.ok(names.includes('C172_DECALS_ALBD'));
  const wings = tex.find((t) => t.name === 'C172_WINGS_ALBD');
  assert.strictEqual(wings.editable, true);
  const fus = tex.find((t) => t.name === 'C172_FUSELAGE_ALBD');
  assert.strictEqual(fus.editable, false);
  assert.match(fus.reason, /paint kit/);
  assert.strictEqual(tex.find((t) => t.name === 'C172_FUSELAGE_NORM').type, 'normal');

  const mod = scanner.listTextures(sim.a320);
  assert.deepStrictEqual(mod.map((t) => t.folder.replace(/\\/g, '/')).sort(), ['common/texture', 'liveries/vendor/house/texture']);
  const fb = scanner.modularFallbackFolders(sim.a320);
  assert.strictEqual(fb.length, 2);
});

test('looksEncrypted recognises real KTX2 and garbage', () => {
  const sim = makeFakeSim();
  const path = require('path');
  assert.strictEqual(scanner.looksEncrypted(path.join(sim.c172, 'texture', 'C172_FUSELAGE_ALBD.PNG.KTX2')), false);
  assert.strictEqual(scanner.looksEncrypted(path.join(sim.official, 'payware-jet', 'layout.fsarchive')), true);
});
