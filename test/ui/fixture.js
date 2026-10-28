/**
 * Builds a fake Windows-like environment for UI tests:
 *  - fake MSFS folders (from test/helpers.js) with a real PNG texture
 *  - a fake SDK whose fspackagetool.exe is a Node script
 *  - settings.json pointing at all of it
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { makeFakeSim, tmpDir } = require('../helpers');

function makeFixture({ supabaseUrl = '', supabaseKey = '' } = {}) {
  const sim = makeFakeSim();
  const home = tmpDir('lf-home-');
  const userData = tmpDir('lf-ud-');
  const sdk = path.join(tmpDir('lf-sdk-'), 'MSFS 2024 SDK');
  const tool = path.join(sdk, 'Tools', 'bin', 'fspackagetool.exe');
  fs.mkdirSync(path.dirname(tool), { recursive: true });
  fs.writeFileSync(tool, `#!${process.execPath}\nrequire(${JSON.stringify(path.join(__dirname, '..', 'fake-fspackagetool.js'))});\n`);
  fs.chmodSync(tool, 0o755);
  // A real editable PNG texture inside the fake C172 (64x64 blue).
  const { encodePng } = require('../../lib/png');
  const px = new Uint8Array(64 * 64 * 4);
  for (let i = 0; i < px.length; i += 4) { px[i] = 30; px[i + 1] = 60; px[i + 2] = 200; px[i + 3] = 255; }
  fs.writeFileSync(path.join(sim.c172, 'texture', 'C172_WINGS_ALBD.PNG'), encodePng(px, 64, 64));
  // Screenshot image for the details screen.
  const shot = path.join(home, 'shot.png');
  const big = new Uint8Array(320 * 180 * 4).map((_, i) => (i % 4 === 3 ? 255 : (i * 7) % 255));
  fs.writeFileSync(shot, encodePng(big, 320, 180));
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({
    communityPath: sim.community,
    officialPath: sim.official,
    sdkPath: sdk,
    edition: 'store',
    installMode: 'link',
    defaultAuthor: 'Test Painter',
    supabaseUrl,
    supabaseAnonKey: supabaseKey,
  }, null, 2));
  return { sim, home, userData, sdk, shot };
}

module.exports = { makeFixture };
