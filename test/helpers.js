/**
 * Test helpers: builds fake MSFS folders in a temp directory.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const KTX2_MAGIC = Buffer.from([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);

function tmpDir(name = 'lf-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), name));
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

/**
 * Creates:
 *  Community/
 *    asobo-aircraft-c172/SimObjects/Airplanes/Asobo_C172/  (simple aircraft)
 *    someone-c172-livery/SimObjects/Airplanes/C172_Red/    (a livery)
 *    vendor-a320/SimObjects/Airplanes/Vendor_A320/         (modular)
 *  Official/OneStore/
 *    payware-jet/  (encrypted, .fsarchive)
 */
function makeFakeSim() {
  const root = tmpDir();
  const community = path.join(root, 'Community');
  const official = path.join(root, 'Official', 'OneStore');

  const c172 = path.join(community, 'asobo-aircraft-c172', 'SimObjects', 'Airplanes', 'Asobo_C172');
  write(path.join(c172, 'aircraft.cfg'), [
    '[VERSION]', 'major = 1', 'minor = 0', '',
    '[GENERAL]', 'icao_manufacturer = "CESSNA" ; maker', 'icao_model = "172"', '',
    '[FLTSIM.0]', 'title = "Cessna 172 Skyhawk" // the title', 'texture = ""', 'ui_variation = "White"', '',
  ].join('\r\n'));
  write(path.join(c172, 'texture', 'C172_FUSELAGE_ALBD.PNG.KTX2'), Buffer.concat([KTX2_MAGIC, Buffer.alloc(100)]));
  write(path.join(c172, 'texture', 'C172_FUSELAGE_COMP.PNG.KTX2'), Buffer.concat([KTX2_MAGIC, Buffer.alloc(50)]));
  write(path.join(c172, 'texture', 'C172_FUSELAGE_NORM.PNG.KTX2'), Buffer.concat([KTX2_MAGIC, Buffer.alloc(50)]));
  write(path.join(c172, 'texture', 'C172_WINGS_ALBD.PNG'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  write(path.join(c172, 'texture', 'texture.cfg'), '[fltsim]\r\n');
  write(path.join(c172, 'texture.common', 'C172_DECALS_ALBD.PNG.KTX2'), KTX2_MAGIC);

  const red = path.join(community, 'someone-c172-livery', 'SimObjects', 'Airplanes', 'C172_Red');
  write(path.join(red, 'aircraft.cfg'), '[VARIATION]\nbase_container = "..\\Asobo_C172"\n[FLTSIM.0]\ntitle = "Cessna 172 Red"\n');

  const a320 = path.join(community, 'vendor-a320', 'SimObjects', 'Airplanes', 'Vendor_A320');
  write(path.join(a320, 'aircraft.cfg'), '[FLTSIM.0]\ntitle = "Vendor A320neo"\n');
  fs.mkdirSync(path.join(a320, 'attachments'), { recursive: true });
  write(path.join(a320, 'common', 'texture', 'A320_FUSELAGE_ALBD.PNG.KTX2'), KTX2_MAGIC);
  write(path.join(a320, 'liveries', 'vendor', 'house', 'texture', 'A320_TAIL_ALBD.PNG.KTX2'), KTX2_MAGIC);
  write(path.join(a320, 'liveries', 'vendor', 'house', 'livery.cfg'), '[Version]\nmajor=1\n');

  const jet = path.join(official, 'payware-jet', 'SimObjects', 'Airplanes', 'Payware_Jet');
  write(path.join(jet, 'aircraft.cfg'), '[FLTSIM.0]\ntitle = "Payware Jet"\n');
  write(path.join(official, 'payware-jet', 'layout.fsarchive'), 'x');

  return { root, community, official, c172, red, a320, jet };
}

module.exports = { tmpDir, write, makeFakeSim, KTX2_MAGIC };
