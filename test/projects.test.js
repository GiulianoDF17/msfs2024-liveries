'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { ProjectStore } = require('../lib/projects');
const { tmpDir } = require('./helpers');

test('create, list, load, save and delete projects', () => {
  const store = new ProjectStore(path.join(tmpDir(), 'Projects'));
  assert.throws(() => store.create({ name: '', aircraft: { folder: 'x' } }));
  assert.throws(() => store.create({ name: 'x' }));
  const p = store.create({ name: 'My Livery', aircraft: { folder: 'Asobo_C172', title: 'C172', textures: [{ name: 'A', type: 'albedo', folder: 'texture' }] }, author: 'Me' });
  assert.strictEqual(p.details.author, 'Me');
  assert.deepStrictEqual(p.aircraft.textureFolders, ['texture']);
  assert.strictEqual(store.list().length, 1);
  p.details.title = 'Changed';
  store.save(p);
  assert.strictEqual(store.load(p.id).details.title, 'Changed');
  store.remove(p.id);
  assert.strictEqual(store.list().length, 0);
});

test('file access is restricted to the project folder', () => {
  const store = new ProjectStore(path.join(tmpDir(), 'Projects'));
  const p = store.create({ name: 'X', aircraft: { folder: 'A' } });
  store.writeFile(p.id, 'layers/t/l.png', Buffer.from('a'));
  assert.strictEqual(store.readFile(p.id, 'layers/t/l.png').toString(), 'a');
  assert.throws(() => store.writeFile(p.id, '../other/x.png', 'a'));
  assert.throws(() => store.writeFile(p.id, '../../x.png', 'a'));
  assert.throws(() => store.dir('../etc'));
  assert.throws(() => store.dir('ABC'));
});

test('listSyncFiles skips build folder; cleanupLayers removes orphans', () => {
  const store = new ProjectStore(path.join(tmpDir(), 'Projects'));
  const p = store.create({ name: 'X', aircraft: { folder: 'A' } });
  store.writeFile(p.id, 'build/Packages/a.txt', 'x');
  store.writeFile(p.id, 'layers/t1/l1.png', 'x');
  store.writeFile(p.id, 'layers/t1/old.png', 'x');
  store.writeFile(p.id, 'layers/gone/l.png', 'x');
  const rels = store.listSyncFiles(p.id).map((f) => f.rel).sort();
  assert.deepStrictEqual(rels, ['layers/gone/l.png', 'layers/t1/l1.png', 'layers/t1/old.png', 'project.json']);
  p.textures = [{ id: 't1', layers: [{ id: 'l1' }] }];
  store.cleanupLayers(p);
  const after = store.listSyncFiles(p.id).map((f) => f.rel).sort();
  assert.deepStrictEqual(after, ['layers/t1/l1.png', 'project.json']);
  assert.ok(!fs.existsSync(path.join(store.dir(p.id), 'layers', 'gone')));
});
