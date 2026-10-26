'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const paths = require('../lib/msfs-paths');
const { tmpDir, write } = require('./helpers');
const { safeJoin, slugify, isInside } = require('../lib/safe-path');
const { Settings } = require('../lib/settings');

test('parseUserCfg reads InstalledPackagesPath', () => {
  assert.strictEqual(paths.parseUserCfg('Version 1\nInstalledPackagesPath "D:\\MSFS 2024"\nOther 1'), 'D:\\MSFS 2024');
  assert.strictEqual(paths.parseUserCfg('nothing here'), null);
});

test('detectInstall finds Store edition, Community and Official', () => {
  const root = tmpDir();
  const local = path.join(root, 'local');
  const pkgs = path.join(root, 'pkgs');
  write(path.join(local, 'Packages', paths.STORE_PACKAGE, 'LocalCache', 'UserCfg.opt'), `InstalledPackagesPath "${pkgs}"\n`);
  write(path.join(pkgs, 'Official', 'OneStore', 'x.txt'), 'x');
  const sdk = path.join(root, 'sdk');
  write(path.join(sdk, 'Tools', 'bin', 'fspackagetool.exe'), 'fake');
  const r = paths.detectInstall({ LOCALAPPDATA: local, APPDATA: path.join(root, 'roaming'), MSFS2024_SDK: sdk });
  assert.strictEqual(r.found, true);
  assert.strictEqual(r.edition, 'store');
  assert.strictEqual(r.communityPath, path.join(pkgs, 'Community'));
  assert.strictEqual(r.officialPath, path.join(pkgs, 'Official', 'OneStore'));
  assert.strictEqual(r.sdkPath, sdk);
  assert.strictEqual(paths.isValidSdk(sdk), true);
  assert.strictEqual(paths.isValidSdk(root), false);
});

test('detectInstall finds Steam edition', () => {
  const root = tmpDir();
  const pkgs = path.join(root, 'steam pkgs');
  write(path.join(root, 'roaming', 'Microsoft Flight Simulator 2024', 'UserCfg.opt'), `InstalledPackagesPath "${pkgs}"`);
  const r = paths.detectInstall({ APPDATA: path.join(root, 'roaming') });
  assert.strictEqual(r.edition, 'steam');
  assert.strictEqual(r.officialPath, path.join(pkgs, 'Official', 'Steam'));
  assert.ok(r.notes.some((n) => /SDK/.test(n)));
});

test('detectInstall reports when nothing is found', () => {
  const r = paths.detectInstall({});
  assert.strictEqual(r.found, false);
});

test('safeJoin blocks path traversal', () => {
  const root = tmpDir();
  assert.strictEqual(safeJoin(root, 'layers/a.png'), path.join(root, 'layers', 'a.png'));
  assert.throws(() => safeJoin(root, '../evil.txt'));
  assert.throws(() => safeJoin(root, 'a/../../evil.txt'));
  assert.throws(() => safeJoin(root, path.resolve('/etc/passwd')));
  assert.throws(() => safeJoin(root, ''));
  assert.throws(() => safeJoin(root, '.'));
  assert.strictEqual(isInside(root, path.join(root, 'x')), true);
  assert.strictEqual(isInside(root, root + '-other'), false);
});

test('slugify makes safe names', () => {
  assert.strictEqual(slugify('Delta Air Lines A320!'), 'delta-air-lines-a320');
  assert.strictEqual(slugify('  Ünïcödé  ✈ '), 'unicode');
  assert.strictEqual(slugify('../../etc'), 'etc');
});

test('Settings saves, reloads and ignores unknown keys', () => {
  const dir = tmpDir();
  const s = new Settings(dir);
  s.update({ communityPath: 'C:\\X', bogus: 1, installMode: 5, extraAircraftPaths: ['a', 3] });
  const s2 = new Settings(dir);
  assert.strictEqual(s2.get().communityPath, 'C:\\X');
  assert.strictEqual(s2.get().installMode, 'link');
  assert.deepStrictEqual(s2.get().extraAircraftPaths, ['a']);
  assert.strictEqual(s2.get().bogus, undefined);
});
