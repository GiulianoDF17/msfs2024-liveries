/**
 * editor.js - the built-in texture painter
 * ========================================
 * A small layer-based paint program made for aircraft textures.
 *
 * How drawing works (so it stays smooth on 4096x4096 textures):
 *  - Every layer is its own <canvas> the size of the texture.
 *  - `comp` is a canvas holding all visible layers blended together. We only
 *    re-blend the small rectangle that changed ("dirty rect"), not everything.
 *  - The visible screen canvas (`view`) just draws `comp` scaled by the zoom.
 *  - Brush strokes are first drawn into a separate "stroke buffer" at full
 *    strength. The stroke is shown on top of the layer with the brush opacity,
 *    and only merged into the layer when the mouse is released. This way
 *    overlapping dabs in ONE stroke never build up past the chosen opacity.
 *
 * Undo / redo:
 *  - Pixel changes store the "before" and "after" pixels of the changed
 *    rectangle as Blobs. Blobs are read-only, so a stored snapshot can never
 *    be changed afterwards.
 *  - Layer changes (add, delete, reorder, rename, opacity...) store the whole
 *    layer list before and after.
 *  - At least 20 steps are kept (more if memory allows).
 */
(function () {
  'use strict';

  const MIN_UNDO = 20;
  const MAX_UNDO = 60;
  const UNDO_BUDGET = 1.5 * 1024 * 1024 * 1024; // bytes kept for undo snapshots

  const BLENDS = [
    ['source-over', 'Normal'], ['multiply', 'Multiply'], ['screen', 'Screen'], ['overlay', 'Overlay'],
    ['darken', 'Darken'], ['lighten', 'Lighten'], ['color-dodge', 'Color dodge'], ['color-burn', 'Color burn'],
    ['hard-light', 'Hard light'], ['soft-light', 'Soft light'], ['difference', 'Difference'], ['exclusion', 'Exclusion'],
    ['hue', 'Hue'], ['saturation', 'Saturation'], ['color', 'Color'], ['luminosity', 'Luminosity'], ['lighter', 'Add (linear dodge)'],
  ];

  const TOOLS = [
    { id: 'hand', key: 'H', label: 'Hand / pan', icon: '✋' },
    { id: 'move', key: 'V', label: 'Move layer', icon: '✥' },
    { id: 'brush', key: 'B', label: 'Brush', icon: '🖌' },
    { id: 'eraser', key: 'E', label: 'Eraser', icon: '⌫' },
    { id: 'fill', key: 'G', label: 'Flood fill', icon: '◧' },
    { id: 'line', key: 'L', label: 'Line', icon: '╱' },
    { id: 'rect', key: 'R', label: 'Rectangle', icon: '▭' },
    { id: 'ellipse', key: 'O', label: 'Ellipse', icon: '◯' },
    { id: 'text', key: 'T', label: 'Text (registrations)', icon: 'T' },
    { id: 'picker', key: 'I', label: 'Eyedropper', icon: '⊙' },
  ];

  const FONTS = ['Arial', 'Arial Black', 'Bahnschrift', 'Calibri', 'Consolas', 'Courier New', 'Franklin Gothic Medium', 'Georgia', 'Helvetica', 'Impact', 'Segoe UI', 'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana'];

  /* ---------------- tiny helpers ---------------- */

  const uid = () => Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  function el(tag, attrs = {}, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'style') e.style.cssText = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (k === 'text') e.textContent = v;
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) {
      if (kid === null || kid === undefined || kid === false) continue;
      e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return e;
  }

  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return { r: 0, g: 0, b: 0 };
    const n = parseInt(m[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  const rgbToHex = (r, g, b) => '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');

  function unionRect(a, b) {
    if (!a) return b; if (!b) return a;
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
  }

  /** Stores pixels as an immutable Blob. */
  function snap(ctx, r) {
    const img = ctx.getImageData(r.x, r.y, r.w, r.h);
    return { blob: new Blob([img.data]), w: r.w, h: r.h, bytes: img.data.byteLength };
  }
  async function unsnap(s) {
    const buf = await s.blob.arrayBuffer();
    return new ImageData(new Uint8ClampedArray(buf), s.w, s.h);
  }

  /* ================================================================ */

  class Editor {
    /**
     * @param {HTMLElement} root  container element
     * @param {object} opts { toast(msg, kind), onDirty(), onSelectionChange() }
     */
    constructor(root, opts = {}) {
      this.root = root;
      this.opts = opts;
      this.doc = null;            // { width, height, layers: [], activeId }
      this.allLayers = new Map(); // id -> layer (also deleted ones, for undo)
      this.undo = [];
      this.redo = [];
      this.undoBytes = 0;
      this.busy = Promise.resolve();
      this.dirty = false;
      this.tool = 'brush';
      this.zoom = 1; this.panX = 0; this.panY = 0;
      this.brush = { size: 24, hardness: 0.8, opacity: 1 };
      this.eraser = { size: 48, hardness: 0.8, opacity: 1 };
      this.fillOpts = { tolerance: 24, sampleAll: false, opacity: 1 };
      this.shapeOpts = { fill: true, width: 8, opacity: 1 };
      this.textOpts = { text: 'N123LF', font: 'Arial', size: 160, bold: true, italic: false, rotation: 0, mirror: false };
      this.color = '#d32f2f';
      this.recent = this.loadRecent();
      this.spaceDown = false;
      this.pointer = null;       // current drag state
      this.cursor = null;        // doc coords of mouse for brush outline
      this.renderQueued = false;
      this.thumbTimer = null;
      this.buildUi();
      this.bindEvents();
    }

    /* ---------------- UI ---------------- */

    buildUi() {
      this.root.classList.add('editor');
      this.toolbar = el('div', { class: 'ed-tools' });
      for (const t of TOOLS) {
        const b = el('button', { class: 'ed-tool', title: `${t.label} (${t.key})`, 'data-tool': t.id, onclick: () => this.setTool(t.id) }, t.icon);
        this.toolbar.append(b);
      }
      this.toolbar.append(el('div', { class: 'ed-sep' }));
      this.toolbar.append(el('button', { class: 'ed-tool', title: 'Import image as a new layer (logos, decals)', onclick: () => this.opts.onImportImage && this.opts.onImportImage() }, '🖼'));
      this.toolbar.append(el('button', { class: 'ed-tool', title: 'Transform layer (scale, rotate, flip)', onclick: () => this.openTransform() }, '⟲'));

      this.optionsBar = el('div', { class: 'ed-options' });
      this.viewWrap = el('div', { class: 'ed-view' });
      this.view = el('canvas', { class: 'ed-canvas', tabindex: '0' });
      this.viewWrap.append(this.view);
      this.status = el('div', { class: 'ed-status' });
      this.emptyMsg = el('div', { class: 'ed-empty' },
        el('div', { class: 'empty-icon' }, '🎨'),
        el('h3', { text: 'No texture open' }),
        el('p', { text: 'Add a texture on the left: from the aircraft, from the developer paint kit (PSD/PNG) or a blank canvas.' }));
      this.viewWrap.append(this.emptyMsg);

      // Right panel: color + layers
      this.side = el('div', { class: 'ed-side' });
      this.colorPanel = el('div', { class: 'panel ed-color' });
      this.layerPanel = el('div', { class: 'panel ed-layers' });
      this.side.append(this.colorPanel, this.layerPanel);

      const center = el('div', { class: 'ed-center' }, this.optionsBar, this.viewWrap, this.status);
      this.root.append(this.toolbar, center, this.side);
      this.buildColorPanel();
      this.setTool('brush');
    }

    buildColorPanel() {
      const p = this.colorPanel;
      p.textContent = '';
      this.colorInput = el('input', { type: 'color', value: this.color, oninput: (e) => this.setColor(e.target.value, false), onchange: (e) => this.setColor(e.target.value, true) });
      this.hexInput = el('input', { class: 'hex', value: this.color, maxlength: '7', spellcheck: 'false', onchange: (e) => {
        const v = e.target.value.trim();
        const hex = v.startsWith('#') ? v : '#' + v;
        if (/^#[0-9a-f]{6}$/i.test(hex)) this.setColor(hex.toLowerCase(), true); else e.target.value = this.color;
      } });
      this.recentEl = el('div', { class: 'swatches' });
      p.append(el('div', { class: 'panel-title' }, 'Color'), el('div', { class: 'color-row' }, this.colorInput, this.hexInput), el('div', { class: 'muted small' }, 'Recent'), this.recentEl);
      this.renderRecent();
    }

    renderRecent() {
      this.recentEl.textContent = '';
      const base = ['#ffffff', '#000000', '#c0c0c0', '#1e3a8a', '#d32f2f', '#f59e0b'];
      const list = [...this.recent, ...base.filter((c) => !this.recent.includes(c))].slice(0, 18);
      for (const c of list) {
        this.recentEl.append(el('button', { class: 'swatch', title: c, style: `background:${c}`, onclick: () => this.setColor(c, true) }));
      }
    }

    loadRecent() {
      try { return JSON.parse(localStorage.getItem('lf.recentColors') || '[]').filter((c) => /^#[0-9a-f]{6}$/i.test(c)).slice(0, 12); } catch { return []; }
    }

    setColor(hex, remember) {
      this.color = hex;
      if (this.colorInput.value !== hex) this.colorInput.value = hex;
      this.hexInput.value = hex;
      this.dabCache = null;
      if (remember) {
        this.recent = [hex, ...this.recent.filter((c) => c !== hex)].slice(0, 12);
        try { localStorage.setItem('lf.recentColors', JSON.stringify(this.recent)); } catch { /* private mode */ }
        this.renderRecent();
      }
    }

    setTool(id) {
      this.tool = id;
      this.toolbar.querySelectorAll('.ed-tool[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === id));
      this.renderOptions();
      this.updateCursor();
      this.requestRender();
    }

    /** Builds the options bar for the current tool. */
    renderOptions() {
      const bar = this.optionsBar;
      bar.textContent = '';
      const t = TOOLS.find((x) => x.id === this.tool);
      bar.append(el('span', { class: 'opt-tool' }, t ? t.label : ''));
      const slider = (label, obj, key, min, max, step, fmt = (v) => v) => {
        const val = el('span', { class: 'opt-val' }, fmt(obj[key]));
        const input = el('input', { type: 'range', min, max, step, value: obj[key], oninput: (e) => { obj[key] = Number(e.target.value); val.textContent = fmt(obj[key]); this.dabCache = null; this.requestRender(); } });
        input.dataset.key = key;
        return el('label', { class: 'opt' }, label, input, val);
      };
      const check = (label, obj, key) => el('label', { class: 'opt' }, el('input', { type: 'checkbox', checked: obj[key] ? true : null, onchange: (e) => { obj[key] = e.target.checked; this.requestRender(); } }), label);
      const pct = (v) => Math.round(v * 100) + '%';

      if (this.tool === 'brush' || this.tool === 'eraser') {
        const o = this.tool === 'brush' ? this.brush : this.eraser;
        bar.append(slider('Size', o, 'size', 1, 500, 1, (v) => v + 'px'), slider('Hardness', o, 'hardness', 0, 1, 0.01, pct), slider('Opacity', o, 'opacity', 0.01, 1, 0.01, pct));
        bar.append(el('span', { class: 'muted small' }, '[ and ] change size'));
      } else if (this.tool === 'fill') {
        bar.append(slider('Tolerance', this.fillOpts, 'tolerance', 0, 255, 1), slider('Opacity', this.fillOpts, 'opacity', 0.01, 1, 0.01, pct), check('Sample all layers', this.fillOpts, 'sampleAll'));
      } else if (['line', 'rect', 'ellipse'].includes(this.tool)) {
        if (this.tool !== 'line') bar.append(check('Filled', this.shapeOpts, 'fill'));
        bar.append(slider('Line width', this.shapeOpts, 'width', 1, 300, 1, (v) => v + 'px'), slider('Opacity', this.shapeOpts, 'opacity', 0.01, 1, 0.01, pct));
        bar.append(el('span', { class: 'muted small' }, 'Hold Shift to constrain'));
      } else if (this.tool === 'text') {
        bar.append(el('span', { class: 'muted small' }, 'Click on the texture where the text should go.'));
      } else if (this.tool === 'move') {
        bar.append(el('span', { class: 'muted small' }, 'Drag to move the active layer. Arrow keys move 1px (Shift: 10px).'));
      } else if (this.tool === 'hand') {
        bar.append(el('span', { class: 'muted small' }, 'Drag to pan. Mouse wheel zooms. Ctrl+0 fits the texture.'));
      } else if (this.tool === 'picker') {
        bar.append(el('span', { class: 'muted small' }, 'Click to pick a color from the texture.'));
      }
      const zoomBox = el('div', { class: 'opt-right' },
        el('button', { class: 'btn small ghost', title: 'Undo (Ctrl+Z)', onclick: () => this.doUndo() }, '↶ Undo'),
        el('button', { class: 'btn small ghost', title: 'Redo (Ctrl+Y)', onclick: () => this.doRedo() }, '↷ Redo'),
        el('button', { class: 'btn small ghost', title: 'Zoom out', onclick: () => this.zoomBy(1 / 1.25) }, '−'),
        this.zoomLabel = el('span', { class: 'opt-val' }, Math.round(this.zoom * 100) + '%'),
        el('button', { class: 'btn small ghost', title: 'Zoom in', onclick: () => this.zoomBy(1.25) }, '+'),
        el('button', { class: 'btn small ghost', title: 'Fit (Ctrl+0)', onclick: () => this.fit() }, 'Fit'),
        el('button', { class: 'btn small ghost', title: '100%', onclick: () => this.setZoom(1) }, '1:1'));
      bar.append(zoomBox);
    }

    /* ---------------- documents ---------------- */

    hasDoc() { return !!this.doc; }

    clear() {
      this.doc = null;
      this.allLayers.clear();
      this.undo = []; this.redo = []; this.undoBytes = 0;
      this.dirty = false;
      this.emptyMsg.style.display = '';
      this.renderLayers();
      this.requestRender();
    }

    /** Starts a document. `layers` = [{ id?, name, canvas, visible, locked, opacity, blend, dirty }] */
    startDoc(width, height, layers) {
      this.allLayers.clear();
      this.undo = []; this.redo = []; this.undoBytes = 0;
      this.doc = { width, height, layers: [], activeId: null };
      for (const l of layers) {
        const layer = this.makeLayer(l);
        this.doc.layers.push(layer);
      }
      this.doc.activeId = this.doc.layers.length ? this.doc.layers[this.doc.layers.length - 1].id : null;
      this.comp = makeCanvas(width, height);
      this.compCtx = this.comp.getContext('2d');
      this.strokeCanvas = makeCanvas(width, height);
      this.strokeCtx = this.strokeCanvas.getContext('2d');
      this.tmp = makeCanvas(256, 256);
      this.tmpCtx = this.tmp.getContext('2d');
      this.emptyMsg.style.display = 'none';
      this.dirty = layers.some((l) => l.dirty);
      this.composite();
      this.renderLayers();
      this.fit();
      if (width * height > 4096 * 4096) this.toast('8K textures use a lot of memory. Keep the number of layers low.', 'warn');
    }

    makeLayer({ id, name, canvas, visible = true, locked = false, opacity = 1, blend = 'source-over', dirty = false }) {
      const layer = {
        id: id || uid(),
        name: name || 'Layer',
        canvas,
        ctx: canvas.getContext('2d'),
        visible, locked,
        opacity: clamp(Number(opacity) || 0, 0, 1),
        blend: BLENDS.some(([b]) => b === blend) ? blend : 'source-over',
        dirty,
      };
      this.allLayers.set(layer.id, layer);
      return layer;
    }

    /** New blank canvas. `fill` = '#rrggbb' or '' for transparent. */
    newBlank(width, height, fill) {
      const c = makeCanvas(width, height);
      if (fill) { const x = c.getContext('2d'); x.fillStyle = fill; x.fillRect(0, 0, width, height); }
      this.startDoc(width, height, [{ name: fill ? 'Background' : 'Layer 1', canvas: c, dirty: true }]);
    }

    /** New document from one image (ImageBitmap / HTMLImageElement). */
    newFromImage(img, name = 'Background') {
      const c = makeCanvas(img.width, img.height);
      c.getContext('2d').drawImage(img, 0, 0);
      this.startDoc(img.width, img.height, [{ name, canvas: c, dirty: true }]);
    }

    /** New document from PSD layers: [{ bitmap, name, left, top, visible, opacity, blend }] */
    newFromLayers(width, height, layers) {
      const list = layers.map((l) => {
        const c = makeCanvas(width, height);
        c.getContext('2d').drawImage(l.bitmap, l.left || 0, l.top || 0);
        return { name: l.name, canvas: c, visible: l.visible !== false, opacity: l.opacity, blend: l.blend, dirty: true };
      });
      if (!list.length) list.push({ name: 'Layer 1', canvas: makeCanvas(width, height), dirty: true });
      this.startDoc(width, height, list);
    }

    /** Loads saved layers: meta = [{ id, name, ... }], bitmaps = same order. */
    openSaved(width, height, metas, bitmaps) {
      const list = metas.map((m, i) => {
        const c = makeCanvas(width, height);
        if (bitmaps[i]) c.getContext('2d').drawImage(bitmaps[i], 0, 0);
        return { ...m, canvas: c, dirty: !bitmaps[i] };
      });
      this.startDoc(width, height, list);
    }

    get active() {
      return this.doc ? this.doc.layers.find((l) => l.id === this.doc.activeId) || null : null;
    }

    markDirty() {
      this.dirty = true;
      if (this.opts.onDirty) this.opts.onDirty();
    }

    toast(msg, kind) { if (this.opts.toast) this.opts.toast(msg, kind); }

    /* ---------------- compositing & rendering ---------------- */

    fullRect() { return { x: 0, y: 0, w: this.doc.width, h: this.doc.height }; }

    clipRect(r) {
      const x = clamp(Math.floor(r.x), 0, this.doc.width);
      const y = clamp(Math.floor(r.y), 0, this.doc.height);
      const x2 = clamp(Math.ceil(r.x + r.w), 0, this.doc.width);
      const y2 = clamp(Math.ceil(r.y + r.h), 0, this.doc.height);
      return { x, y, w: x2 - x, h: y2 - y };
    }

    ensureTmp(w, h) {
      if (this.tmp.width < w || this.tmp.height < h) {
        this.tmp.width = Math.max(this.tmp.width, w);
        this.tmp.height = Math.max(this.tmp.height, h);
      }
    }

    /** Re-blends all visible layers inside rectangle `r` into `comp`. */
    composite(r) {
      if (!this.doc) return;
      r = this.clipRect(r || this.fullRect());
      if (r.w <= 0 || r.h <= 0) return;
      const c = this.compCtx;
      c.save();
      c.globalAlpha = 1;
      c.globalCompositeOperation = 'source-over';
      c.clearRect(r.x, r.y, r.w, r.h);
      const active = this.active;
      const stroke = this.pointer && this.pointer.stroke;
      const move = this.pointer && this.pointer.move;
      for (const layer of this.doc.layers) {
        if (!layer.visible) continue;
        c.globalAlpha = layer.opacity;
        c.globalCompositeOperation = layer.blend;
        if (layer === active && stroke) {
          // Layer + stroke buffer, mixed in a temporary canvas.
          this.ensureTmp(r.w, r.h);
          const t = this.tmpCtx;
          t.save();
          t.globalAlpha = 1; t.globalCompositeOperation = 'copy';
          t.drawImage(layer.canvas, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
          t.globalAlpha = stroke.opacity;
          t.globalCompositeOperation = stroke.erase ? 'destination-out' : 'source-over';
          t.drawImage(this.strokeCanvas, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
          t.restore();
          c.drawImage(this.tmp, 0, 0, r.w, r.h, r.x, r.y, r.w, r.h);
        } else if (layer === active && move) {
          c.drawImage(layer.canvas, move.dx, move.dy);
        } else {
          c.drawImage(layer.canvas, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
        }
      }
      c.restore();
    }

    requestRender() {
      if (this.renderQueued) return;
      this.renderQueued = true;
      requestAnimationFrame(() => { this.renderQueued = false; this.render(); });
    }

    resizeView() {
      const dpr = window.devicePixelRatio || 1;
      const r = this.viewWrap.getBoundingClientRect();
      const w = Math.max(1, Math.round(r.width * dpr));
      const h = Math.max(1, Math.round(r.height * dpr));
      if (this.view.width !== w || this.view.height !== h) {
        this.view.width = w; this.view.height = h;
        this.view.style.width = r.width + 'px';
        this.view.style.height = r.height + 'px';
      }
    }

    checker() {
      if (this._checker) return this._checker;
      const c = makeCanvas(16, 16);
      const x = c.getContext('2d');
      x.fillStyle = '#2a2f36'; x.fillRect(0, 0, 16, 16);
      x.fillStyle = '#353b44'; x.fillRect(0, 0, 8, 8); x.fillRect(8, 8, 8, 8);
      this._checker = this.view.getContext('2d').createPattern(c, 'repeat');
      return this._checker;
    }

    render() {
      this.resizeView();
      const ctx = this.view.getContext('2d');
      const dpr = window.devicePixelRatio || 1;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#0b0f14';
      ctx.fillRect(0, 0, this.view.width, this.view.height);
      if (!this.doc) return;
      const z = this.zoom * dpr;
      ctx.setTransform(z, 0, 0, z, this.panX * dpr, this.panY * dpr);
      // transparent background checkerboard (drawn in screen space for crispness)
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = this.checker();
      ctx.fillRect(this.panX * dpr, this.panY * dpr, this.doc.width * z, this.doc.height * z);
      ctx.restore();
      ctx.imageSmoothingEnabled = this.zoom < 2;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(this.comp, 0, 0);

      // overlays: shape preview, text preview, brush outline
      ctx.lineWidth = 1 / this.zoom;
      const p = this.pointer;
      if (p && p.shape) this.drawShapePath(ctx, p.shape, true);
      if (this.textPreview) this.drawText(ctx, this.textPreview);
      if (this.cursor && (this.tool === 'brush' || this.tool === 'eraser')) {
        const o = this.tool === 'brush' ? this.brush : this.eraser;
        ctx.beginPath();
        ctx.arc(this.cursor.x, this.cursor.y, Math.max(0.5, o.size / 2), 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(0,0,0,0.8)';
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(this.cursor.x, this.cursor.y, Math.max(0.5, o.size / 2) + 1 / this.zoom, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255,255,255,0.8)';
        ctx.stroke();
      }
      // texture border
      ctx.strokeStyle = 'rgba(88,166,255,0.35)';
      ctx.strokeRect(0, 0, this.doc.width, this.doc.height);
      if (this.zoomLabel) this.zoomLabel.textContent = Math.round(this.zoom * 100) + '%';
      this.updateStatus();
    }

    updateStatus() {
      if (!this.doc) { this.status.textContent = ''; return; }
      const a = this.active;
      const pos = this.cursor ? `  ·  x ${Math.floor(this.cursor.x)}, y ${Math.floor(this.cursor.y)}` : '';
      this.status.textContent = `${this.doc.width} × ${this.doc.height}  ·  ${this.doc.layers.length} layers  ·  active: ${a ? a.name : '-'}  ·  undo: ${this.undo.length}${pos}${this.dirty ? '  ·  unsaved changes' : ''}`;
    }

    /* ---------------- view: zoom / pan ---------------- */

    fit() {
      if (!this.doc) return;
      this.resizeView();
      const r = this.viewWrap.getBoundingClientRect();
      const z = Math.min((r.width - 40) / this.doc.width, (r.height - 40) / this.doc.height);
      this.zoom = clamp(z, 0.02, 32);
      this.panX = (r.width - this.doc.width * this.zoom) / 2;
      this.panY = (r.height - this.doc.height * this.zoom) / 2;
      this.requestRender();
    }

    setZoom(z, cx, cy) {
      const r = this.viewWrap.getBoundingClientRect();
      if (cx === undefined) { cx = r.width / 2; cy = r.height / 2; }
      const nz = clamp(z, 0.02, 32);
      const dx = (cx - this.panX) / this.zoom;
      const dy = (cy - this.panY) / this.zoom;
      this.zoom = nz;
      this.panX = cx - dx * nz;
      this.panY = cy - dy * nz;
      this.requestRender();
    }

    zoomBy(f, cx, cy) { this.setZoom(this.zoom * f, cx, cy); }

    toDoc(e) {
      const r = this.view.getBoundingClientRect();
      return { x: (e.clientX - r.left - this.panX) / this.zoom, y: (e.clientY - r.top - this.panY) / this.zoom };
    }

    updateCursor() {
      const map = { hand: 'grab', move: 'move', picker: 'crosshair', fill: 'crosshair', text: 'text', line: 'crosshair', rect: 'crosshair', ellipse: 'crosshair', brush: 'none', eraser: 'none' };
      this.view.style.cursor = this.spaceDown ? 'grab' : (map[this.tool] || 'default');
    }

    /* ---------------- events ---------------- */

    bindEvents() {
      this.view.addEventListener('pointerdown', (e) => this.onDown(e));
      this.view.addEventListener('pointermove', (e) => this.onMove(e));
      this.view.addEventListener('pointerup', (e) => this.onUp(e));
      this.view.addEventListener('pointercancel', (e) => this.onUp(e));
      this.view.addEventListener('pointerleave', () => { this.cursor = null; this.requestRender(); });
      this.view.addEventListener('wheel', (e) => {
        e.preventDefault();
        const r = this.view.getBoundingClientRect();
        const f = Math.pow(1.0015, -e.deltaY);
        this.zoomBy(f, e.clientX - r.left, e.clientY - r.top);
      }, { passive: false });
      this.view.addEventListener('contextmenu', (e) => e.preventDefault());
      this.resizeObs = new ResizeObserver(() => this.requestRender());
      this.resizeObs.observe(this.viewWrap);
      this.keyHandler = (e) => this.onKey(e);
      this.keyUpHandler = (e) => { if (e.code === 'Space') { this.spaceDown = false; this.updateCursor(); } };
      window.addEventListener('keydown', this.keyHandler);
      window.addEventListener('keyup', this.keyUpHandler);
    }

    /** Only handle keys while the editor screen is visible and no input has focus. */
    isActiveScreen() {
      return this.root.offsetParent !== null && !document.querySelector('.modal-backdrop.open');
    }

    onKey(e) {
      if (!this.isActiveScreen()) return;
      const tag = (document.activeElement && document.activeElement.tagName) || '';
      const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) && document.activeElement.type !== 'range';
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.key.toLowerCase() === 's') { e.preventDefault(); if (this.opts.onSaveShortcut) this.opts.onSaveShortcut(); return; }
      if (typing) return;
      if (ctrl && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); this.doUndo(); return; }
      if (ctrl && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); this.doRedo(); return; }
      if (ctrl && e.key === '0') { e.preventDefault(); this.fit(); return; }
      if (ctrl && (e.key === '+' || e.key === '=')) { e.preventDefault(); this.zoomBy(1.25); return; }
      if (ctrl && e.key === '-') { e.preventDefault(); this.zoomBy(1 / 1.25); return; }
      if (ctrl) return;
      if (e.code === 'Space') { if (!this.spaceDown) { this.spaceDown = true; this.updateCursor(); } e.preventDefault(); return; }
      if (e.key === '[' || e.key === ']') {
        const o = this.tool === 'eraser' ? this.eraser : this.brush;
        const step = Math.max(1, Math.round(o.size * 0.15));
        o.size = clamp(o.size + (e.key === ']' ? step : -step), 1, 500);
        this.dabCache = null;
        this.renderOptions();
        this.requestRender();
        return;
      }
      if (this.tool === 'move' && this.active && e.key.startsWith('Arrow')) {
        e.preventDefault();
        const s = e.shiftKey ? 10 : 1;
        const dx = e.key === 'ArrowLeft' ? -s : e.key === 'ArrowRight' ? s : 0;
        const dy = e.key === 'ArrowUp' ? -s : e.key === 'ArrowDown' ? s : 0;
        this.commitMove(dx, dy);
        return;
      }
      const tool = TOOLS.find((t) => t.key.toLowerCase() === e.key.toLowerCase());
      if (tool) { this.setTool(tool.id); e.preventDefault(); }
    }

    canPaint() {
      const a = this.active;
      if (!a) { this.toast('Add a layer first.', 'warn'); return false; }
      if (a.locked) { this.toast(`Layer "${a.name}" is locked. Unlock it in the layer list.`, 'warn'); return false; }
      if (!a.visible) { this.toast(`Layer "${a.name}" is hidden. Show it first.`, 'warn'); return false; }
      return true;
    }

    onDown(e) {
      if (!this.doc) return;
      this.view.focus();
      const pt = this.toDoc(e);
      const panning = this.tool === 'hand' || this.spaceDown || e.button === 1;
      if (panning) {
        this.pointer = { pan: true, sx: e.clientX, sy: e.clientY, px: this.panX, py: this.panY };
        this.view.setPointerCapture(e.pointerId);
        this.view.style.cursor = 'grabbing';
        return;
      }
      if (e.button !== 0) return;
      switch (this.tool) {
        case 'brush':
        case 'eraser': {
          if (!this.canPaint()) return;
          const o = this.tool === 'brush' ? this.brush : this.eraser;
          this.pointer = { stroke: { erase: this.tool === 'eraser', opacity: o.opacity, size: o.size, hardness: o.hardness, last: pt, bounds: null, carry: 0 } };
          this.view.setPointerCapture(e.pointerId);
          this.dab(pt.x, pt.y);
          break;
        }
        case 'line': case 'rect': case 'ellipse': {
          if (!this.canPaint()) return;
          this.pointer = { shape: { type: this.tool, x0: pt.x, y0: pt.y, x1: pt.x, y1: pt.y } };
          this.view.setPointerCapture(e.pointerId);
          break;
        }
        case 'move': {
          if (!this.active) return;
          if (this.active.locked) { this.toast('This layer is locked.', 'warn'); return; }
          this.pointer = { move: { dx: 0, dy: 0, sx: pt.x, sy: pt.y } };
          this.view.setPointerCapture(e.pointerId);
          break;
        }
        case 'fill': if (this.canPaint()) this.floodFill(pt.x, pt.y); break;
        case 'picker': this.pickColor(pt.x, pt.y); break;
        case 'text': if (this.canPaint()) this.openText(pt.x, pt.y); break;
        default: break;
      }
    }

    onMove(e) {
      if (!this.doc) return;
      const p = this.pointer;
      const pt = this.toDoc(e);
      this.cursor = pt;
      if (!p) { this.requestRender(); return; }
      if (p.pan) {
        this.panX = p.px + (e.clientX - p.sx);
        this.panY = p.py + (e.clientY - p.sy);
        this.requestRender();
        return;
      }
      if (p.stroke) {
        // Coalesced events give every mouse position, so fast strokes stay smooth.
        const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
        for (const ev of events.length ? events : [e]) this.strokeTo(this.toDoc(ev));
        return;
      }
      if (p.shape) {
        let { x0, y0 } = p.shape;
        let x1 = pt.x, y1 = pt.y;
        if (e.shiftKey) {
          if (p.shape.type === 'line') {
            const ang = Math.round(Math.atan2(y1 - y0, x1 - x0) / (Math.PI / 4)) * (Math.PI / 4);
            const len = Math.hypot(x1 - x0, y1 - y0);
            x1 = x0 + Math.cos(ang) * len; y1 = y0 + Math.sin(ang) * len;
          } else {
            const s = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
            x1 = x0 + Math.sign(x1 - x0 || 1) * s; y1 = y0 + Math.sign(y1 - y0 || 1) * s;
          }
        }
        p.shape.x1 = x1; p.shape.y1 = y1;
        this.requestRender();
        return;
      }
      if (p.move) {
        p.move.dx = Math.round(pt.x - p.move.sx);
        p.move.dy = Math.round(pt.y - p.move.sy);
        this.composite();
        this.requestRender();
      }
    }

    onUp(e) {
      const p = this.pointer;
      if (!p) return;
      try { this.view.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      if (p.pan) { this.pointer = null; this.updateCursor(); return; }
      if (p.stroke) { this.commitStroke(); return; }
      if (p.shape) {
        const s = p.shape;
        this.pointer = null;
        if (Math.hypot(s.x1 - s.x0, s.y1 - s.y0) < 1) { this.requestRender(); return; }
        this.commitShape(s);
        return;
      }
      if (p.move) {
        const { dx, dy } = p.move;
        this.pointer = null;
        if (dx || dy) this.commitMove(dx, dy); else this.composite();
        this.requestRender();
      }
    }

    /* ---------------- brush ---------------- */

    /** Pre-rendered round brush tip, cached until size/hardness/color change. */
    getDab(size, hardness, color) {
      const key = `${size}|${hardness}|${color}`;
      if (this.dabCache && this.dabCache.key === key) return this.dabCache.canvas;
      const d = Math.max(1, Math.ceil(size));
      const c = makeCanvas(d + 2, d + 2);
      const x = c.getContext('2d');
      const r = size / 2;
      const cx = (d + 2) / 2;
      const { r: R, g: G, b: B } = hexToRgb(color);
      if (hardness >= 0.99 || size <= 2) {
        x.fillStyle = color;
        x.beginPath(); x.arc(cx, cx, Math.max(0.5, r), 0, Math.PI * 2); x.fill();
      } else {
        const g = x.createRadialGradient(cx, cx, 0, cx, cx, r);
        g.addColorStop(0, `rgba(${R},${G},${B},1)`);
        g.addColorStop(clamp(hardness, 0, 0.98), `rgba(${R},${G},${B},1)`);
        g.addColorStop(1, `rgba(${R},${G},${B},0)`);
        x.fillStyle = g;
        x.fillRect(0, 0, d + 2, d + 2);
      }
      this.dabCache = { key, canvas: c };
      return c;
    }

    dab(x, y) {
      const s = this.pointer.stroke;
      const tip = this.getDab(s.size, s.hardness, s.erase ? '#000000' : this.color);
      const half = tip.width / 2;
      this.strokeCtx.drawImage(tip, x - half, y - half);
      const r = { x: x - half - 1, y: y - half - 1, w: tip.width + 2, h: tip.height + 2 };
      s.bounds = unionRect(s.bounds, r);
      return r;
    }

    strokeTo(pt) {
      const s = this.pointer.stroke;
      const dx = pt.x - s.last.x, dy = pt.y - s.last.y;
      const dist = Math.hypot(dx, dy);
      const spacing = Math.max(0.75, s.size * 0.12);
      let dirty = null;
      let t = spacing - s.carry;
      while (t <= dist) {
        const r = this.dab(s.last.x + dx * (t / dist), s.last.y + dy * (t / dist));
        dirty = unionRect(dirty, r);
        t += spacing;
      }
      s.carry = dist - (t - spacing);
      s.last = pt;
      if (dirty) { this.composite(dirty); }
      this.requestRender();
    }

    /** Merges the stroke buffer into the active layer and records undo. */
    commitStroke() {
      const s = this.pointer.stroke;
      const layer = this.active;
      const r = s.bounds ? this.clipRect(s.bounds) : null;
      if (r && r.w > 0 && r.h > 0 && layer) {
        const before = snap(layer.ctx, r);
        layer.ctx.save();
        layer.ctx.globalAlpha = s.opacity;
        layer.ctx.globalCompositeOperation = s.erase ? 'destination-out' : 'source-over';
        layer.ctx.drawImage(this.strokeCanvas, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
        layer.ctx.restore();
        const after = snap(layer.ctx, r);
        this.strokeCtx.clearRect(r.x, r.y, r.w, r.h);
        this.pushHistory({ type: 'pixels', layer, rect: r, before, after });
        layer.dirty = true;
      }
      this.pointer = null;
      if (r) this.composite(r);
      this.afterChange();
    }

    /* ---------------- shapes ---------------- */

    drawShapePath(ctx, s, preview) {
      ctx.save();
      const o = this.shapeOpts;
      ctx.lineWidth = o.width;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = this.color;
      ctx.fillStyle = this.color;
      if (preview) ctx.globalAlpha = o.opacity;
      ctx.beginPath();
      const x = Math.min(s.x0, s.x1), y = Math.min(s.y0, s.y1);
      const w = Math.abs(s.x1 - s.x0), h = Math.abs(s.y1 - s.y0);
      if (s.type === 'line') { ctx.moveTo(s.x0, s.y0); ctx.lineTo(s.x1, s.y1); ctx.stroke(); }
      else if (s.type === 'rect') { ctx.rect(x, y, w, h); if (o.fill) ctx.fill(); else ctx.stroke(); }
      else if (s.type === 'ellipse') { ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2); if (o.fill) ctx.fill(); else ctx.stroke(); }
      ctx.restore();
    }

    commitShape(s) {
      const layer = this.active;
      const pad = this.shapeOpts.width + 2;
      const r = this.clipRect({ x: Math.min(s.x0, s.x1) - pad, y: Math.min(s.y0, s.y1) - pad, w: Math.abs(s.x1 - s.x0) + pad * 2, h: Math.abs(s.y1 - s.y0) + pad * 2 });
      if (r.w <= 0 || r.h <= 0) { this.requestRender(); return; }
      // Draw at full strength into the stroke buffer, then merge with opacity.
      this.strokeCtx.clearRect(r.x, r.y, r.w, r.h);
      this.drawShapePath(this.strokeCtx, s, false);
      const before = snap(layer.ctx, r);
      layer.ctx.save();
      layer.ctx.globalAlpha = this.shapeOpts.opacity;
      layer.ctx.drawImage(this.strokeCanvas, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
      layer.ctx.restore();
      this.strokeCtx.clearRect(r.x, r.y, r.w, r.h);
      const after = snap(layer.ctx, r);
      this.pushHistory({ type: 'pixels', layer, rect: r, before, after });
      layer.dirty = true;
      this.composite(r);
      this.afterChange();
    }

    /* ---------------- move ---------------- */

    commitMove(dx, dy) {
      const layer = this.active;
      if (!layer || layer.locked) return;
      const full = this.fullRect();
      const before = snap(layer.ctx, full);
      this.ensureTmp(full.w, full.h);
      const t = this.tmpCtx;
      t.save(); t.globalCompositeOperation = 'copy'; t.drawImage(layer.canvas, 0, 0); t.restore();
      layer.ctx.clearRect(0, 0, full.w, full.h);
      layer.ctx.drawImage(this.tmp, 0, 0, full.w, full.h, dx, dy, full.w, full.h);
      const after = snap(layer.ctx, full);
      this.pushHistory({ type: 'pixels', layer, rect: full, before, after });
      layer.dirty = true;
      this.composite();
      this.afterChange();
    }

    /* ---------------- flood fill ---------------- */

    floodFill(fx, fy) {
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      const { width: W, height: H } = this.doc;
      if (x0 < 0 || y0 < 0 || x0 >= W || y0 >= H) return;
      const layer = this.active;
      const srcCtx = this.fillOpts.sampleAll ? this.compCtx : layer.ctx;
      const src = new Uint32Array(srcCtx.getImageData(0, 0, W, H).data.buffer);
      const target = src[y0 * W + x0];
      const tol = this.fillOpts.tolerance;
      const tr = target & 255, tg = (target >>> 8) & 255, tb = (target >>> 16) & 255, ta = target >>> 24;
      const match = (i) => {
        const v = src[i];
        return Math.abs((v & 255) - tr) <= tol && Math.abs(((v >>> 8) & 255) - tg) <= tol &&
          Math.abs(((v >>> 16) & 255) - tb) <= tol && Math.abs((v >>> 24) - ta) <= tol;
      };
      const mask = new Uint8Array(W * H);
      let minX = x0, maxX = x0, minY = y0, maxY = y0;
      const stack = [x0, y0];
      // Scanline flood fill: fills whole horizontal runs at a time (fast).
      while (stack.length) {
        const y = stack.pop(); let x = stack.pop();
        let i = y * W + x;
        while (x >= 0 && !mask[i] && match(i)) { x--; i--; }
        x++; i++;
        let up = false, down = false;
        while (x < W && !mask[i] && match(i)) {
          mask[i] = 1;
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
          if (y > 0) {
            const u = i - W;
            if (!mask[u] && match(u)) { if (!up) { stack.push(x, y - 1); up = true; } } else up = false;
          }
          if (y < H - 1) {
            const d = i + W;
            if (!mask[d] && match(d)) { if (!down) { stack.push(x, y + 1); down = true; } } else down = false;
          }
          x++; i++;
        }
      }
      const r = { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
      // Paint the mask in the chosen color into the stroke buffer.
      const { r: R, g: G, b: B } = hexToRgb(this.color);
      const img = new ImageData(r.w, r.h);
      const out = new Uint32Array(img.data.buffer);
      const color = (255 << 24) | (B << 16) | (G << 8) | R;
      for (let y = 0; y < r.h; y++) {
        const row = (r.y + y) * W + r.x;
        for (let x = 0; x < r.w; x++) if (mask[row + x]) out[y * r.w + x] = color;
      }
      this.strokeCtx.putImageData(img, r.x, r.y);
      const before = snap(layer.ctx, r);
      layer.ctx.save();
      layer.ctx.globalAlpha = this.fillOpts.opacity;
      layer.ctx.drawImage(this.strokeCanvas, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
      layer.ctx.restore();
      this.strokeCtx.clearRect(r.x, r.y, r.w, r.h);
      const after = snap(layer.ctx, r);
      this.pushHistory({ type: 'pixels', layer, rect: r, before, after });
      layer.dirty = true;
      this.composite(r);
      this.afterChange();
    }

    pickColor(x, y) {
      x = Math.floor(x); y = Math.floor(y);
      if (x < 0 || y < 0 || x >= this.doc.width || y >= this.doc.height) return;
      const d = this.compCtx.getImageData(x, y, 1, 1).data;
      if (d[3] === 0) { this.toast('That spot is transparent.', 'warn'); return; }
      this.setColor(rgbToHex(d[0], d[1], d[2]), true);
    }

    /* ---------------- text ---------------- */

    fontString(o) {
      return `${o.italic ? 'italic ' : ''}${o.bold ? 'bold ' : ''}${o.size}px "${o.font.replace(/"/g, '')}", sans-serif`;
    }

    drawText(ctx, t) {
      ctx.save();
      ctx.translate(t.x, t.y);
      ctx.rotate((t.rotation * Math.PI) / 180);
      if (t.mirror) ctx.scale(-1, 1);
      ctx.font = this.fontString(t);
      ctx.fillStyle = t.color;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const lines = String(t.text).split('\n');
      lines.forEach((line, i) => ctx.fillText(line, 0, (i - (lines.length - 1) / 2) * t.size * 1.15));
      ctx.restore();
    }

    openText(x, y) {
      const o = this.textOpts;
      this.textPreview = { ...o, x, y, color: this.color };
      const upd = () => { this.textPreview = { ...o, x, y, color: this.color }; this.requestRender(); };
      const field = (label, input) => el('label', { class: 'field' }, el('span', {}, label), input);
      const text = el('textarea', { rows: '2', oninput: (e) => { o.text = e.target.value; upd(); } });
      text.value = o.text;
      const font = el('select', { onchange: (e) => { o.font = e.target.value; upd(); } }, ...FONTS.map((f) => el('option', { value: f, selected: f === o.font ? true : null }, f)));
      const size = el('input', { type: 'number', min: '4', max: '2000', value: o.size, oninput: (e) => { o.size = clamp(Number(e.target.value) || 12, 4, 2000); upd(); } });
      const rot = el('input', { type: 'number', min: '-360', max: '360', value: o.rotation, oninput: (e) => { o.rotation = Number(e.target.value) || 0; upd(); } });
      const chk = (label, key) => el('label', { class: 'check' }, el('input', { type: 'checkbox', checked: o[key] ? true : null, onchange: (e) => { o[key] = e.target.checked; upd(); } }), label);
      const body = el('div', { class: 'form-grid' },
        field('Text (e.g. registration)', text),
        field('Font', font),
        field('Size (px)', size),
        field('Rotation (°)', rot),
        el('div', { class: 'row gap' }, chk('Bold', 'bold'), chk('Italic', 'italic'), chk('Mirror (for the other side of the aircraft)', 'mirror')),
        el('p', { class: 'muted small' }, 'Text uses the current color and is placed on a NEW layer, so you can move or delete it later. Tip: the left side of a fuselage is often mirrored on the texture.'));
      this.opts.modal({
        title: 'Add text',
        body,
        okLabel: 'Add text layer',
        onOk: () => { this.textPreview = null; this.commitText({ ...o, x, y, color: this.color }); },
        onCancel: () => { this.textPreview = null; this.requestRender(); },
      });
      setTimeout(() => text.focus(), 50);
      this.requestRender();
    }

    commitText(t) {
      if (!String(t.text).trim()) return;
      const c = makeCanvas(this.doc.width, this.doc.height);
      this.drawText(c.getContext('2d'), t);
      this.addLayerFromCanvas(c, `Text: ${String(t.text).split('\n')[0].slice(0, 24)}`);
    }

    /* ---------------- layers ---------------- */

    snapshotState() {
      return {
        order: this.doc.layers.slice(),
        meta: this.doc.layers.map((l) => ({ id: l.id, name: l.name, visible: l.visible, locked: l.locked, opacity: l.opacity, blend: l.blend })),
        activeId: this.doc.activeId,
      };
    }

    restoreState(s) {
      this.doc.layers = s.order.slice();
      for (const m of s.meta) {
        const l = this.allLayers.get(m.id);
        Object.assign(l, { name: m.name, visible: m.visible, locked: m.locked, opacity: m.opacity, blend: m.blend, dirty: true });
      }
      this.doc.activeId = s.activeId;
    }

    /** Runs `fn` that changes layers, and records it as one undo step. */
    structural(fn) {
      if (!this.doc) return;
      const before = this.snapshotState();
      fn();
      const after = this.snapshotState();
      this.pushHistory({ type: 'struct', before, after });
      this.composite();
      this.afterChange(true);
    }

    addLayer(name) {
      this.structural(() => {
        const layer = this.makeLayer({ name: name || `Layer ${this.doc.layers.length + 1}`, canvas: makeCanvas(this.doc.width, this.doc.height), dirty: true });
        const idx = this.doc.layers.indexOf(this.active);
        this.doc.layers.splice(idx + 1, 0, layer);
        this.doc.activeId = layer.id;
      });
    }

    addLayerFromCanvas(canvas, name) {
      this.structural(() => {
        const layer = this.makeLayer({ name, canvas, dirty: true });
        const idx = this.doc.layers.indexOf(this.active);
        this.doc.layers.splice(idx + 1, 0, layer);
        this.doc.activeId = layer.id;
      });
    }

    /** Adds an image (logo/decal) as a new layer, centered and scaled to fit. */
    addImageLayer(img, name) {
      if (!this.doc) { this.toast('Open a texture first.', 'warn'); return; }
      const c = makeCanvas(this.doc.width, this.doc.height);
      const s = Math.min(1, this.doc.width / img.width, this.doc.height / img.height);
      const w = img.width * s, h = img.height * s;
      c.getContext('2d').drawImage(img, (this.doc.width - w) / 2, (this.doc.height - h) / 2, w, h);
      this.addLayerFromCanvas(c, name || 'Image');
      this.setTool('move');
      this.toast('Image added as a new layer. Drag it into place with the Move tool.', 'ok');
    }

    duplicateLayer() {
      const a = this.active;
      if (!a) return;
      this.structural(() => {
        const c = makeCanvas(this.doc.width, this.doc.height);
        c.getContext('2d').drawImage(a.canvas, 0, 0);
        const layer = this.makeLayer({ name: `${a.name} copy`, canvas: c, opacity: a.opacity, blend: a.blend, dirty: true });
        this.doc.layers.splice(this.doc.layers.indexOf(a) + 1, 0, layer);
        this.doc.activeId = layer.id;
      });
    }

    deleteLayer() {
      const a = this.active;
      if (!a) return;
      if (this.doc.layers.length === 1) { this.toast('A texture needs at least one layer.', 'warn'); return; }
      this.structural(() => {
        const idx = this.doc.layers.indexOf(a);
        this.doc.layers.splice(idx, 1);
        this.doc.activeId = this.doc.layers[Math.max(0, idx - 1)].id;
      });
    }

    moveLayer(delta) {
      const a = this.active;
      if (!a) return;
      const idx = this.doc.layers.indexOf(a);
      const to = clamp(idx + delta, 0, this.doc.layers.length - 1);
      if (to === idx) return;
      this.structural(() => {
        this.doc.layers.splice(idx, 1);
        this.doc.layers.splice(to, 0, a);
      });
    }

    reorderLayer(id, toIndex) {
      const l = this.allLayers.get(id);
      const idx = this.doc.layers.indexOf(l);
      if (idx < 0 || idx === toIndex) return;
      this.structural(() => {
        this.doc.layers.splice(idx, 1);
        this.doc.layers.splice(clamp(toIndex, 0, this.doc.layers.length), 0, l);
      });
    }

    /** Merges the active layer into the layer below it. */
    mergeDown() {
      const a = this.active;
      const idx = this.doc.layers.indexOf(a);
      if (idx <= 0) { this.toast('There is no layer below to merge into.', 'warn'); return; }
      const below = this.doc.layers[idx - 1];
      if (below.locked) { this.toast('The layer below is locked.', 'warn'); return; }
      const full = this.fullRect();
      const beforePx = snap(below.ctx, full);
      const beforeState = this.snapshotState();
      below.ctx.save();
      below.ctx.globalAlpha = a.visible ? a.opacity : 0;
      below.ctx.globalCompositeOperation = a.blend;
      below.ctx.drawImage(a.canvas, 0, 0);
      below.ctx.restore();
      below.dirty = true;
      const afterPx = snap(below.ctx, full);
      this.doc.layers.splice(idx, 1);
      this.doc.activeId = below.id;
      const afterState = this.snapshotState();
      this.pushHistory({ type: 'group', entries: [
        { type: 'pixels', layer: below, rect: full, before: beforePx, after: afterPx },
        { type: 'struct', before: beforeState, after: afterState },
      ] });
      this.composite();
      this.afterChange(true);
    }

    setLayerProp(layer, key, value) {
      if (layer[key] === value) return;
      this.structural(() => { layer[key] = value; });
    }

    selectLayer(id) {
      if (!this.doc || this.doc.activeId === id) return;
      this.doc.activeId = id;
      this.renderLayers();
      this.requestRender();
    }

    /* ---------------- transform ---------------- */

    openTransform() {
      const a = this.active;
      if (!a) { this.toast('Open a texture first.', 'warn'); return; }
      if (a.locked) { this.toast('This layer is locked.', 'warn'); return; }
      const o = { scale: 100, rotate: 0, flipH: false, flipV: false };
      const field = (label, input) => el('label', { class: 'field' }, el('span', {}, label), input);
      const body = el('div', { class: 'form-grid' },
        el('p', { class: 'muted' }, `Transforms the layer "${a.name}" around the texture center.`),
        field('Scale (%)', el('input', { type: 'number', min: '1', max: '1000', value: '100', oninput: (e) => { o.scale = Number(e.target.value) || 100; } })),
        field('Rotate (°)', el('input', { type: 'number', min: '-360', max: '360', value: '0', oninput: (e) => { o.rotate = Number(e.target.value) || 0; } })),
        el('div', { class: 'row gap' },
          el('label', { class: 'check' }, el('input', { type: 'checkbox', onchange: (e) => { o.flipH = e.target.checked; } }), 'Flip horizontal'),
          el('label', { class: 'check' }, el('input', { type: 'checkbox', onchange: (e) => { o.flipV = e.target.checked; } }), 'Flip vertical')));
      this.opts.modal({ title: 'Transform layer', body, okLabel: 'Apply', onOk: () => this.applyTransform(o) });
    }

    applyTransform({ scale = 100, rotate = 0, flipH = false, flipV = false }) {
      const layer = this.active;
      if (!layer) return;
      const full = this.fullRect();
      const before = snap(layer.ctx, full);
      this.ensureTmp(full.w, full.h);
      const t = this.tmpCtx;
      t.save(); t.globalCompositeOperation = 'copy'; t.drawImage(layer.canvas, 0, 0); t.restore();
      const x = layer.ctx;
      x.save();
      x.clearRect(0, 0, full.w, full.h);
      x.translate(full.w / 2, full.h / 2);
      x.rotate((rotate * Math.PI) / 180);
      x.scale((flipH ? -1 : 1) * scale / 100, (flipV ? -1 : 1) * scale / 100);
      x.imageSmoothingQuality = 'high';
      x.drawImage(this.tmp, 0, 0, full.w, full.h, -full.w / 2, -full.h / 2, full.w, full.h);
      x.restore();
      const after = snap(layer.ctx, full);
      this.pushHistory({ type: 'pixels', layer, rect: full, before, after });
      layer.dirty = true;
      this.composite();
      this.afterChange();
    }

    /* ---------------- history ---------------- */

    entryBytes(e) {
      if (e.type === 'pixels') return e.before.bytes + e.after.bytes;
      if (e.type === 'group') return e.entries.reduce((s, x) => s + this.entryBytes(x), 0);
      return 1024;
    }

    pushHistory(entry) {
      entry.bytes = this.entryBytes(entry);
      this.undo.push(entry);
      this.undoBytes += entry.bytes;
      this.redo = [];
      // Drop the oldest steps if we use too much memory (but keep 20).
      while (this.undo.length > MAX_UNDO || (this.undo.length > MIN_UNDO && this.undoBytes > UNDO_BUDGET)) {
        const old = this.undo.shift();
        this.undoBytes -= old.bytes;
      }
    }

    async applyEntry(entry, dir) {
      if (entry.type === 'group') {
        const list = dir === 'undo' ? entry.entries.slice().reverse() : entry.entries;
        for (const e of list) await this.applyEntry(e, dir);
        return;
      }
      if (entry.type === 'pixels') {
        const data = await unsnap(dir === 'undo' ? entry.before : entry.after);
        entry.layer.ctx.putImageData(data, entry.rect.x, entry.rect.y);
        entry.layer.dirty = true;
        return;
      }
      if (entry.type === 'struct') this.restoreState(dir === 'undo' ? entry.before : entry.after);
    }

    /** Undo/redo run one after another (they can be async). */
    doUndo() { return this.queueHistory('undo'); }
    doRedo() { return this.queueHistory('redo'); }

    queueHistory(dir) {
      this.busy = this.busy.then(async () => {
        if (!this.doc || this.pointer) return;
        const from = dir === 'undo' ? this.undo : this.redo;
        const to = dir === 'undo' ? this.redo : this.undo;
        const entry = from.pop();
        if (!entry) { this.toast(dir === 'undo' ? 'Nothing to undo.' : 'Nothing to redo.'); return; }
        if (dir === 'undo') this.undoBytes -= entry.bytes; else this.undoBytes += entry.bytes;
        await this.applyEntry(entry, dir);
        to.push(entry);
        this.composite();
        this.afterChange(true);
      }).catch((e) => this.toast('Undo failed: ' + e.message, 'error'));
      return this.busy;
    }

    afterChange(layersChanged) {
      this.markDirty();
      if (layersChanged) this.renderLayers();
      else this.scheduleThumbs();
      this.requestRender();
    }

    /* ---------------- layer panel ---------------- */

    scheduleThumbs() {
      clearTimeout(this.thumbTimer);
      this.thumbTimer = setTimeout(() => this.updateThumbs(), 250);
    }

    updateThumbs() {
      if (!this.doc) return;
      for (const l of this.doc.layers) {
        const t = this.layerPanel.querySelector(`canvas[data-layer="${l.id}"]`);
        if (!t) continue;
        const x = t.getContext('2d');
        x.clearRect(0, 0, t.width, t.height);
        x.drawImage(l.canvas, 0, 0, t.width, t.height);
      }
    }

    renderLayers() {
      const p = this.layerPanel;
      p.textContent = '';
      const header = el('div', { class: 'panel-title row' }, el('span', {}, 'Layers'),
        el('div', { class: 'row gap-s' },
          el('button', { class: 'icon-btn', title: 'New layer', onclick: () => this.addLayer() }, '＋'),
          el('button', { class: 'icon-btn', title: 'Duplicate layer', onclick: () => this.duplicateLayer() }, '⧉'),
          el('button', { class: 'icon-btn', title: 'Merge down', onclick: () => this.mergeDown() }, '⤓'),
          el('button', { class: 'icon-btn', title: 'Move up', onclick: () => this.moveLayer(1) }, '▲'),
          el('button', { class: 'icon-btn', title: 'Move down', onclick: () => this.moveLayer(-1) }, '▼'),
          el('button', { class: 'icon-btn danger', title: 'Delete layer', onclick: () => this.deleteLayer() }, '🗑')));
      p.append(header);
      if (!this.doc) { p.append(el('p', { class: 'muted small pad' }, 'Layers appear here when a texture is open.')); return; }
      const a = this.active;
      if (a) {
        const op = el('input', { type: 'range', min: '0', max: '100', value: Math.round(a.opacity * 100) });
        const opVal = el('span', { class: 'opt-val' }, Math.round(a.opacity * 100) + '%');
        op.addEventListener('input', () => { a.opacity = Number(op.value) / 100; opVal.textContent = op.value + '%'; this.composite(); this.requestRender(); });
        op.addEventListener('change', () => { const v = Number(op.value) / 100; const old = this._opStart ?? v; this._opStart = undefined; a.opacity = old; this.setLayerProp(a, 'opacity', v); });
        op.addEventListener('pointerdown', () => { this._opStart = a.opacity; });
        const blend = el('select', { onchange: (e) => this.setLayerProp(a, 'blend', e.target.value) }, ...BLENDS.map(([v, n]) => el('option', { value: v, selected: v === a.blend ? true : null }, n)));
        p.append(el('div', { class: 'layer-props' }, el('label', { class: 'opt' }, 'Opacity', op, opVal), el('label', { class: 'opt' }, 'Blend', blend)));
      }
      const list = el('div', { class: 'layer-list' });
      // Top layer first, like Photoshop.
      const layers = this.doc.layers.slice().reverse();
      const tw = 48, th = Math.max(8, Math.round(48 * this.doc.height / this.doc.width));
      layers.forEach((l) => {
        const thumb = el('canvas', { class: 'layer-thumb', width: tw, height: th, 'data-layer': l.id });
        const name = el('span', { class: 'layer-name', title: 'Double-click to rename' }, l.name);
        name.addEventListener('dblclick', (e) => {
          e.stopPropagation();
          const input = el('input', { class: 'layer-rename', value: l.name });
          const finish = (ok) => { if (ok && input.value.trim()) this.setLayerProp(l, 'name', input.value.trim().slice(0, 60)); else this.renderLayers(); };
          input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') finish(true); if (ev.key === 'Escape') finish(false); });
          input.addEventListener('blur', () => finish(true));
          name.replaceWith(input);
          input.focus(); input.select();
        });
        const row = el('div', { class: 'layer-row' + (l.id === this.doc.activeId ? ' active' : '') + (l.visible ? '' : ' hidden'), draggable: 'true', onclick: () => this.selectLayer(l.id) },
          el('button', { class: 'icon-btn', title: l.visible ? 'Hide' : 'Show', onclick: (e) => { e.stopPropagation(); this.setLayerProp(l, 'visible', !l.visible); } }, l.visible ? '👁' : '◌'),
          thumb,
          name,
          el('button', { class: 'icon-btn' + (l.locked ? ' on' : ''), title: l.locked ? 'Unlock' : 'Lock', onclick: (e) => { e.stopPropagation(); this.setLayerProp(l, 'locked', !l.locked); } }, l.locked ? '🔒' : '🔓'));
        row.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/x-layer', l.id); row.classList.add('dragging'); });
        row.addEventListener('dragend', () => row.classList.remove('dragging'));
        row.addEventListener('dragover', (e) => { e.preventDefault(); row.classList.add('drop'); });
        row.addEventListener('dragleave', () => row.classList.remove('drop'));
        row.addEventListener('drop', (e) => {
          e.preventDefault();
          const id = e.dataTransfer.getData('text/x-layer');
          if (id && id !== l.id) this.reorderLayer(id, this.doc.layers.indexOf(l));
        });
        list.append(row);
      });
      p.append(list);
      this.updateThumbs();
      this.updateStatus();
    }

    /* ---------------- saving ---------------- */

    /** Layer descriptions for project.json. */
    layerMeta() {
      return this.doc.layers.map((l) => ({ id: l.id, name: l.name, visible: l.visible, locked: l.locked, opacity: l.opacity, blend: l.blend }));
    }

    static toPng(canvas) {
      return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encode failed'))), 'image/png'));
    }

    /**
     * Returns PNG bytes to save: changed layers + the flattened texture +
     * a small preview. [{ kind: 'layer'|'flat'|'preview', id?, bytes }]
     */
    async exportForSave(includeAllLayers = false) {
      this.composite();
      const out = [];
      for (const l of this.doc.layers) {
        if (!includeAllLayers && !l.dirty) continue;
        out.push({ kind: 'layer', id: l.id, layer: l, bytes: new Uint8Array(await (await Editor.toPng(l.canvas)).arrayBuffer()) });
      }
      out.push({ kind: 'flat', bytes: new Uint8Array(await (await Editor.toPng(this.comp)).arrayBuffer()) });
      const s = Math.min(1, 512 / Math.max(this.doc.width, this.doc.height));
      const pv = makeCanvas(Math.max(1, Math.round(this.doc.width * s)), Math.max(1, Math.round(this.doc.height * s)));
      pv.getContext('2d').drawImage(this.comp, 0, 0, pv.width, pv.height);
      out.push({ kind: 'preview', bytes: new Uint8Array(await (await Editor.toPng(pv)).arrayBuffer()) });
      return out;
    }

    markSaved() {
      for (const l of this.doc.layers) l.dirty = false;
      this.dirty = false;
      this.updateStatus();
    }

    /** Small PNG of the current texture for thumbnails. */
    async previewPng(maxSide = 1280) {
      this.composite();
      const s = Math.min(1, maxSide / Math.max(this.doc.width, this.doc.height));
      const pv = makeCanvas(Math.round(this.doc.width * s), Math.round(this.doc.height * s));
      const x = pv.getContext('2d');
      x.fillStyle = '#ffffff'; x.fillRect(0, 0, pv.width, pv.height);
      x.drawImage(this.comp, 0, 0, pv.width, pv.height);
      return new Uint8Array(await (await Editor.toPng(pv)).arrayBuffer());
    }
  }

  Editor.BLENDS = BLENDS;
  Editor.TOOLS = TOOLS;
  window.LFEditor = Editor;
})();
