// Pretends to be fspackagetool.exe for tests: reads project.xml and creates
// Packages/<name>/ with a manifest.json and copies PackageSources over.
'use strict';
const fs = require('fs');
const path = require('path');
const xmlPath = process.argv[2];
const text = fs.readFileSync(xmlPath, 'utf8');
const name = /Name="([^"]+)"/.exec(text)[1];
if (process.env.FAKE_FAIL) { console.error('error: Bitmap FOO.PNG could not be compiled'); process.exit(3); }
const buildDir = path.dirname(xmlPath);
const out = path.join(buildDir, 'Packages', name);
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
fs.cpSync(path.join(buildDir, 'PackageSources'), out, { recursive: true });
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({ dependencies: [], content_type: 'LIVERY', title: 'x', creator: '', package_version: '0.0.1' }));
console.log('Building package ' + name);
console.log('warning: something minor');
console.log('Done.');
