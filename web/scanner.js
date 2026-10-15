/* Barcode and text reading: live camera, photo and printed-text reading. Tuned in Phase 0. */
(function () {
  'use strict';
  const C = () => window.PTCodes;

  // ---------- Decoders: the phone's built-in reader where available (Android), otherwise ZXing ----------
  const FORMATS_NATIVE = ['code_128', 'code_39', 'code_93', 'codabar', 'ean_13', 'ean_8', 'itf', 'upc_a', 'upc_e', 'qr_code', 'data_matrix'];
  let native = null;
  if ('BarcodeDetector' in window) {
    BarcodeDetector.getSupportedFormats().then(fmts => {
      const use = FORMATS_NATIVE.filter(f => fmts.includes(f));
      if (use.length) native = new BarcodeDetector({ formats: use });
    }).catch(() => {});
  }
  let zx = null;
  function zxReader() {
    if (zx || !window.ZXing) return zx;
    const Z = window.ZXing;
    const hints = new Map();
    hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [
      Z.BarcodeFormat.CODE_128, Z.BarcodeFormat.CODE_39, Z.BarcodeFormat.CODE_93, Z.BarcodeFormat.CODABAR,
      Z.BarcodeFormat.EAN_13, Z.BarcodeFormat.EAN_8, Z.BarcodeFormat.ITF, Z.BarcodeFormat.UPC_A,
      Z.BarcodeFormat.QR_CODE, Z.BarcodeFormat.DATA_MATRIX
    ]);
    hints.set(Z.DecodeHintType.TRY_HARDER, true);
    zx = new Z.MultiFormatReader();
    zx.setHints(hints);
    return zx;
  }
  function zxDecode(canvas) {
    const r = zxReader(); if (!r) return null;
    const Z = window.ZXing;
    try {
      return r.decode(new Z.BinaryBitmap(new Z.HybridBinarizer(new Z.HTMLCanvasElementLuminanceSource(canvas)))).getText();
    } catch (e) { return null; }
    finally { try { r.reset(); } catch (e) {} }
  }
  async function decodeCanvas(canvas) {
    if (native) {
      try {
        const found = await native.detect(canvas);
        if (found && found.length) return { text: found[0].rawValue, engine: 'built-in' };
      } catch (e) {}
    }
    const t = zxDecode(canvas);
    return t ? { text: t, engine: 'ZXing' } : null;
  }

  // ---------- Live camera ----------
  const REQUIRED_MATCHES = 2;
  // A read that does not look like a part code must repeat more before it counts (guards against misreads)
  const REQUIRED_MATCHES_UNUSUAL = 6;

  function startLive(opts) {
    const { video, guide, viewport, onRead, onStatus } = opts;
    const work = document.createElement('canvas');
    let stream = null, track = null, hwZoom = null, digitalZoom = 1, running = false, paused = false;
    let timer = null, lastText = '', sameCount = 0;
    const status = t => onStatus && onStatus(t);

    function guideRegion() {
      const vw = video.videoWidth, vh = video.videoHeight;
      const W = video.clientWidth, H = video.clientHeight;
      const s = Math.max(W / vw, H / vh) * digitalZoom;
      const g = guide.getBoundingClientRect(), v = viewport.getBoundingClientRect();
      const x = (g.left - v.left - W / 2) / s + vw / 2, y = (g.top - v.top - H / 2) / s + vh / 2;
      const w = g.width / s, h = g.height / s;
      return { x: Math.max(0, x), y: Math.max(0, y), w: Math.min(vw - Math.max(0, x), w), h: Math.min(vh - Math.max(0, y), h) };
    }
    function grab(target, scaleUp) {
      const r = guideRegion();
      const k = scaleUp || Math.min(1, 1280 / r.w);
      target.width = Math.round(r.w * k); target.height = Math.round(r.h * k);
      target.getContext('2d', { willReadFrequently: true }).drawImage(video, r.x, r.y, r.w, r.h, 0, 0, target.width, target.height);
      return target;
    }
    async function loop() {
      if (!running) return;
      if (!paused && video.readyState >= 2 && video.videoWidth) {
        const res = await decodeCanvas(grab(work));
        if (res && res.text && res.text.length >= 3) {
          if (res.text === lastText) sameCount++; else { lastText = res.text; sameCount = 1; }
          guide.classList.add('hit'); setTimeout(() => guide.classList.remove('hit'), 200);
          const needed = C().normalise(res.text).warning ? REQUIRED_MATCHES_UNUSUAL : REQUIRED_MATCHES;
          if (sameCount >= needed) { paused = true; lastText = ''; sameCount = 0; onRead(res); }
        }
      }
      timer = setTimeout(loop, 120);
    }
    function applyZoom(v) {
      if (hwZoom && track) { track.applyConstraints({ advanced: [{ zoom: v }] }).catch(() => {}); digitalZoom = 1; }
      else digitalZoom = v;
      video.style.transform = 'scale(' + digitalZoom + ')';
    }
    async function start(deviceId) {
      stop();
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { status('Camera not available on this browser.'); return null; }
      const constraints = deviceId
        ? { deviceId: { exact: deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 } }
        : { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } };
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: constraints, audio: false });
      } catch (e) {
        status(e.name === 'NotAllowedError' ? 'Camera blocked. Allow camera access for this site, or use Take photo or Search.' : 'Camera could not start (' + e.name + ').');
        return null;
      }
      track = stream.getVideoTracks()[0];
      video.srcObject = stream;
      await video.play().catch(() => {});
      const caps = track.getCapabilities ? track.getCapabilities() : {};
      if (caps.focusMode && caps.focusMode.includes('continuous')) track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
      let zoom;
      if (caps.zoom && caps.zoom.max > caps.zoom.min) {
        hwZoom = caps.zoom;
        zoom = { min: caps.zoom.min, max: Math.min(caps.zoom.max, 8), step: caps.zoom.step || 0.1, value: track.getSettings().zoom || caps.zoom.min };
      } else {
        hwZoom = null;
        zoom = { min: 1, max: 4, step: 0.1, value: 1 };
      }
      digitalZoom = 1; applyZoom(zoom.value);
      running = true; paused = false; lastText = ''; sameCount = 0;
      status('');
      loop();
      let cameras = [];
      try { cameras = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput').map((d, i) => ({ id: d.deviceId, label: d.label || 'Camera ' + (i + 1) })); } catch (e) {}
      return { zoom, torch: !!caps.torch, cameras, deviceId: track.getSettings().deviceId };
    }
    // Some phones leave the torch lit if the camera is stopped with it on, so switch it off first
    function stop() {
      running = false; clearTimeout(timer);
      const oldStream = stream, oldTrack = track, wasLit = torchOn;
      stream = null; track = null; torchOn = false; video.srcObject = null;
      if (!oldStream) return;
      const off = wasLit && oldTrack ? oldTrack.applyConstraints({ advanced: [{ torch: false }] }).catch(() => {}) : Promise.resolve();
      off.then(() => oldStream.getTracks().forEach(t => t.stop()));
    }
    let torchOn = false;
    return {
      start, stop, applyZoom,
      resume() { paused = false; lastText = ''; sameCount = 0; },
      pause() { paused = true; },
      torch() {
        if (!track) return;
        torchOn = !torchOn;
        track.applyConstraints({ advanced: [{ torch: torchOn }] }).catch(() => { torchOn = false; });
      },
      frame() { return running && video.videoWidth ? grab(document.createElement('canvas'), 1) : null; },
      get running() { return running; }
    };
  }

  // ---------- Photo ----------
  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Could not open the photo'));
      img.src = URL.createObjectURL(file);
    });
  }
  function drawScaled(img, maxSide, rotate) {
    const c = document.createElement('canvas');
    const k = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.round(img.naturalWidth * k), h = Math.round(img.naturalHeight * k);
    if (rotate) { c.width = h; c.height = w; } else { c.width = w; c.height = h; }
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (rotate) { ctx.translate(h, 0); ctx.rotate(Math.PI / 2); }
    ctx.drawImage(img, 0, 0, w, h);
    return c;
  }
  function drawStrip(img, y0, y1, scale) {
    const c = document.createElement('canvas');
    const k = Math.min(1, 1600 / img.naturalWidth) * scale;
    const sh = (y1 - y0) * img.naturalHeight;
    c.width = Math.round(img.naturalWidth * k); c.height = Math.round(sh * k);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, y0 * img.naturalHeight, img.naturalWidth, sh, 0, 0, c.width, c.height);
    return c;
  }
  /** Returns { text, engine } for a valid read, { suspect } for a damaged-looking read, or null. */
  async function decodePhoto(file) {
    const img = await loadImage(file);
    let res = null, suspect = null;
    const attempt = async canvas => {
      const r = await decodeCanvas(canvas);
      if (!r) return false;
      if (C().normalise(r.text).warning) { suspect = suspect || r.text; return false; }
      res = r; return true;
    };
    outer: for (const size of [1600, 2400, 1000]) {
      for (const rot of [false, true]) if (await attempt(drawScaled(img, size, rot))) break outer;
    }
    for (let y = 0; !res && y <= 0.8; y += 0.1) await attempt(drawStrip(img, y, Math.min(1, y + 0.25), 2));
    return res || (suspect ? { suspect } : null);
  }

  // ---------- Text reading (Tesseract.js, loaded on first use) ----------
  let ocrWorker = null;
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script'); s.src = src; s.onload = resolve;
      s.onerror = () => reject(new Error('Text reader could not be downloaded. Check the connection.'));
      document.head.appendChild(s);
    });
  }
  async function getOcr(progress) {
    if (ocrWorker) return ocrWorker;
    progress && progress('Downloading text reader (first time only)…');
    if (!window.Tesseract) await loadScript('https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js');
    ocrWorker = await Tesseract.createWorker('eng');
    await ocrWorker.setParameters({ tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -/.' });
    return ocrWorker;
  }
  function prepForOcr(src, target) {
    const k = Math.max(1, (target || 1600) / Math.max(src.width, src.height));
    const c = document.createElement('canvas');
    c.width = Math.round(src.width * k); c.height = Math.round(src.height * k);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.filter = 'grayscale(1) contrast(1.4)';
    ctx.drawImage(src, 0, 0, c.width, c.height);
    return c;
  }
  function threshold(c) {
    const ctx = c.getContext('2d', { willReadFrequently: true });
    const img = ctx.getImageData(0, 0, c.width, c.height), d = img.data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += d[i];
    const cut = sum / (d.length / 4) * 0.85;
    for (let i = 0; i < d.length; i += 4) { const v = d[i] < cut ? 0 : 255; d[i] = d[i + 1] = d[i + 2] = v; }
    ctx.putImageData(img, 0, 0);
    return c;
  }
  /** Reads part codes from a photo file or canvas: normal pass, then enlarged, then black and white. */
  async function readText(source, progress) {
    const canvas = source instanceof HTMLCanvasElement ? source : drawScaled(await loadImage(source), 2000, false);
    const worker = await getOcr(progress);
    progress && progress('Reading text…');
    await worker.setParameters({ tessedit_pageseg_mode: '3' });
    let raw = ((await worker.recognize(prepForOcr(canvas))).data.text || '').trim();
    let candidates = C().findCandidates(raw);
    if (!candidates.length) {
      progress && progress('Trying again, enlarged…');
      await worker.setParameters({ tessedit_pageseg_mode: '11' });
      const big = Math.min(4000, 2 * Math.max(canvas.width, canvas.height, 1600));
      const raw2 = ((await worker.recognize(prepForOcr(canvas, big))).data.text || '').trim();
      raw += '\n' + raw2;
      candidates = C().findCandidates(raw2);
      if (!candidates.length) {
        progress && progress('Trying again, black and white…');
        const raw3 = ((await worker.recognize(threshold(prepForOcr(canvas)))).data.text || '').trim();
        raw += '\n' + raw3;
        candidates = C().findCandidates(raw3);
      }
    }
    return { raw, candidates, fragments: candidates.length ? [] : C().findFragments(raw) };
  }

  window.PTScanner = { startLive, decodePhoto, readText, decodeCanvas };
})();
