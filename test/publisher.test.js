'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const publisher = require('../lib/publisher');
const { ProjectStore } = require('../lib/projects');
const { tmpDir } = require('./helpers');

function project() {
  const docs = tmpDir();
  const store = new ProjectStore(path.join(docs, 'Projects'));
  const p = store.create({ name: 'Blue Sky', aircraft: { folder: 'Asobo_C172', title: 'Cessna 172' }, author: 'Sam' });
  const dir = store.dir(p.id);
  const zip = path.join(docs, 'Output', 'sam-asobo-c172-blue-sky_v1.0.0.zip');
  fs.mkdirSync(path.dirname(zip), { recursive: true });
  fs.writeFileSync(zip, 'zipdata');
  p.export.zipPath = zip;
  store.writeFile(p.id, 'screenshots/01.jpg', Buffer.alloc(1000));
  p.details.screenshots = ['screenshots/01.jpg'];
  p.details.description = 'This is a clean blue livery for the Cessna 172 with a custom registration and fresh textures.';
  p.details.ownWork = true;
  p.details.tags = ['cessna', 'blue'];
  return { docs, store, p, dir };
}

test('valid project passes validation', () => {
  const { p, dir } = project();
  const v = publisher.validate(p, dir);
  assert.deepStrictEqual(v.errors, []);
  assert.strictEqual(v.ok, true);
});

test('validation catches every rule', () => {
  const { p, dir } = project();
  p.details.title = '';
  p.details.ownWork = false;
  p.details.description = 'Ceci est une livrée bleue pour le Cessna, avec une immatriculation personnalisée et des textures.';
  p.details.screenshots = [];
  p.export.zipPath = path.join(dir, 'missing.zip');
  const v = publisher.validate(p, dir);
  assert.strictEqual(v.ok, false);
  const all = v.errors.join('\n');
  assert.match(all, /Title/);
  assert.match(all, /own work/);
  assert.match(all, /English/);
  assert.match(all, /at least 1 screenshot/);
  assert.match(all, /zip was not found/);
});

test('screenshot limits (count and 5 MB)', () => {
  const { p, dir, store } = project();
  store.writeFile(p.id, 'screenshots/big.jpg', Buffer.alloc(5 * 1024 * 1024 + 1));
  p.details.screenshots = ['screenshots/big.jpg'];
  assert.match(publisher.validate(p, dir).errors.join(), /larger than 5 MB/);
  p.details.screenshots = Array.from({ length: 19 }, () => 'screenshots/01.jpg');
  assert.match(publisher.validate(p, dir).errors.join(), /max 18/);
});

test('prepareBundle creates zip, numbered images, info and checklist', () => {
  const { p, dir, docs } = project();
  const out = path.join(docs, 'Output');
  const r = publisher.prepareBundle(p, dir, out);
  assert.strictEqual(path.basename(r.bundleDir), 'sam-asobo-c172-blue-sky_flightsimto');
  for (const f of ['sam-asobo-c172-blue-sky_v1.0.0.zip', '01.jpg', 'upload-info.json', 'UPLOAD-CHECKLIST.txt']) {
    assert.ok(fs.existsSync(path.join(r.bundleDir, f)), f);
  }
  const info = JSON.parse(fs.readFileSync(path.join(r.bundleDir, 'upload-info.json'), 'utf8'));
  assert.strictEqual(info.simulator, 'Microsoft Flight Simulator 2024');
  assert.strictEqual(info.category, 'Liveries > Cessna 172');
  const check = fs.readFileSync(path.join(r.bundleDir, 'UPLOAD-CHECKLIST.txt'), 'utf8');
  assert.match(check, /only upload your own work/);
  assert.match(check, /DESCRIPTION/);
});

test('prepareBundle refuses invalid projects', () => {
  const { p, dir, docs } = project();
  p.details.ownWork = false;
  assert.throws(() => publisher.prepareBundle(p, dir, docs), /own work/);
});

test('nextAllowedAt paces 3 uploads per hour', () => {
  const now = Date.parse('2026-01-01T12:00:00Z');
  const min = 60 * 1000;
  assert.strictEqual(publisher.nextAllowedAt([], 3, now), now);
  assert.strictEqual(publisher.nextAllowedAt([now - 10 * min, now - 5 * min], 3, now), now);
  const t = publisher.nextAllowedAt([now - 50 * min, now - 20 * min, now - 1 * min], 3, now);
  assert.strictEqual(t, now + 10 * min);
  assert.strictEqual(publisher.nextAllowedAt([now - 70 * min, now - 20 * min, now - 1 * min], 3, now), now);
});

test('looksEnglish', () => {
  assert.strictEqual(publisher.looksEnglish('This is a livery for the A320 with new textures.'), true);
  assert.strictEqual(publisher.looksEnglish('Это ливрея для самолёта'), false);
});
