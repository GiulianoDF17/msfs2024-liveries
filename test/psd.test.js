'use strict';
const test = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');
const { writePsd } = require('ag-psd');
const { importPsd, blendFor } = require('../lib/psd');
const { encodePng, pngSize } = require('../lib/png');

function solid(w, h, rgba) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < d.length; i += 4) d.set(rgba, i);
  return { width: w, height: h, data: d };
}

/** Decodes our own PNG output (Sub filter only) for checking. */
function decode(png) {
  const { width, height } = pngSize(png);
  let off = 8; const idat = [];
  while (off < png.length) {
    const len = png.readUInt32BE(off); const type = png.toString('ascii', off + 4, off + 8);
    if (type === 'IDAT') idat.push(png.subarray(off + 8, off + 8 + len));
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width * 4; x++) {
      const v = raw[y * (width * 4 + 1) + 1 + x];
      out[y * width * 4 + x] = (v + (x >= 4 ? out[y * width * 4 + x - 4] : 0)) & 0xff;
    }
  }
  return { width, height, data: out };
}

test('encodePng round-trips exact RGBA (incl. semi-transparent)', () => {
  const img = solid(3, 2, [200, 100, 50, 128]);
  img.data.set([1, 2, 3, 4], 4);
  const png = encodePng(img.data, 3, 2);
  assert.deepStrictEqual(pngSize(png), { width: 3, height: 2 });
  const back = decode(png);
  assert.deepStrictEqual([...back.data], [...img.data]);
});

test('importPsd keeps layers, groups, visibility, opacity, blend, offsets', () => {
  const psd = {
    width: 8, height: 8,
    imageData: solid(8, 8, [255, 255, 255, 255]),
    children: [
      { name: 'Base', imageData: solid(8, 8, [255, 255, 255, 255]), left: 0, top: 0 },
      { name: 'Stripes', opened: true, children: [
        { name: 'Red', imageData: solid(4, 2, [255, 0, 0, 255]), left: 2, top: 3, opacity: 0.5, blendMode: 'multiply' },
      ], hidden: true },
    ],
  };
  const buf = Buffer.from(writePsd(psd, { generateThumbnail: false }));
  const r = importPsd(buf);
  assert.strictEqual(r.width, 8);
  assert.strictEqual(r.layers.length, 2);
  const [base, red] = r.layers;
  assert.strictEqual(base.name, 'Base');
  assert.strictEqual(red.name, 'Stripes/Red');
  assert.strictEqual(red.visible, false);
  assert.strictEqual(red.left, 2);
  assert.strictEqual(red.top, 3);
  assert.ok(Math.abs(red.opacity - 0.5) < 0.01);
  assert.strictEqual(red.blend, 'multiply');
  const px = decode(red.png);
  assert.deepStrictEqual([...px.data.subarray(0, 4)], [255, 0, 0, 255]);
});

test('blendFor maps Photoshop names', () => {
  assert.strictEqual(blendFor('color dodge'), 'color-dodge');
  assert.strictEqual(blendFor('unknown'), 'source-over');
});
