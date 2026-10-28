/**
 * psd.js
 * ------
 * Reads Photoshop paint kits (.psd) with the ag-psd library and turns every
 * pixel layer into a PNG file, keeping name, visibility, opacity, blend mode
 * and position. Groups are flattened: "Group/Layer" names, and a hidden
 * group hides its children.
 *
 * Not supported (the layer is imported as plain pixels or skipped):
 * layer masks, adjustment layers, smart filters and layer effects.
 */
'use strict';

const { readPsd, initializeCanvas } = require('ag-psd');
const { encodePng } = require('./png');

// We run in Node (Electron main process) where there is no <canvas>.
// ag-psd only needs a way to create raw pixel buffers, so we give it one.
initializeCanvas(
  () => { throw new Error('Canvas is not available in the main process.'); },
  undefined,
  (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }),
);

// Photoshop blend mode -> canvas globalCompositeOperation
const BLEND_MAP = {
  normal: 'source-over',
  'pass through': 'source-over',
  dissolve: 'source-over',
  multiply: 'multiply',
  screen: 'screen',
  overlay: 'overlay',
  darken: 'darken',
  lighten: 'lighten',
  'color dodge': 'color-dodge',
  'color burn': 'color-burn',
  'hard light': 'hard-light',
  'soft light': 'soft-light',
  difference: 'difference',
  exclusion: 'exclusion',
  hue: 'hue',
  saturation: 'saturation',
  color: 'color',
  luminosity: 'luminosity',
  'linear dodge': 'lighter',
};

function blendFor(mode) {
  return BLEND_MAP[String(mode || 'normal').toLowerCase()] || 'source-over';
}

/**
 * Parses a PSD buffer.
 * Returns { width, height, layers: [{ name, png, left, top, width, height, visible, opacity, blend }] }
 * Layers are ordered bottom -> top. `onProgress(i, total)` is optional.
 */
function importPsd(buffer, onProgress = () => {}) {
  const psd = readPsd(buffer, {
    useImageData: true,
    skipThumbnail: true,
    skipCompositeImageData: false,
    skipLinkedFilesData: true,
    throwForMissingFeatures: false,
  });
  const flat = [];
  const walk = (nodes, prefix, parentVisible, parentOpacity) => {
    for (const n of nodes || []) {
      const visible = parentVisible && !n.hidden;
      const opacity = parentOpacity * (n.opacity === undefined ? 1 : n.opacity);
      const name = prefix ? `${prefix}/${n.name || 'Layer'}` : (n.name || 'Layer');
      if (n.children) {
        walk(n.children, name, visible, opacity);
      } else if (n.imageData && n.imageData.width > 0 && n.imageData.height > 0) {
        flat.push({ node: n, name, visible, opacity, blend: blendFor(n.blendMode) });
      }
    }
  };
  walk(psd.children, '', true, 1);

  const layers = [];
  // No usable layers (flattened PSD): use the composite image.
  if (flat.length === 0 && psd.imageData) {
    layers.push({
      name: 'Background', left: 0, top: 0, width: psd.width, height: psd.height,
      visible: true, opacity: 1, blend: 'source-over',
      png: encodePng(psd.imageData.data, psd.width, psd.height),
    });
    return { width: psd.width, height: psd.height, layers };
  }
  flat.forEach((f, i) => {
    onProgress(i, flat.length);
    const img = f.node.imageData;
    layers.push({
      name: f.name.slice(0, 80),
      left: f.node.left || 0,
      top: f.node.top || 0,
      width: img.width,
      height: img.height,
      visible: f.visible,
      opacity: Math.max(0, Math.min(1, f.opacity)),
      blend: f.blend,
      png: encodePng(img.data, img.width, img.height),
    });
    f.node.imageData = null; // free memory as we go
  });
  return { width: psd.width, height: psd.height, layers };
}

module.exports = { importPsd, blendFor, BLEND_MAP };
