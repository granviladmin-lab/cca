/* Frog PDF — PDF viewer and editor for iPad Safari (iOS 12+).
 * Viewing: pdf.js 2.16 (legacy build). Writing: pdf-lib 1.17.
 * Annotations are stored in PDF user space of their source page, so they
 * survive page rotation and reordering and export without conversion.
 * Keep this file ES2018 at most: no ?. or ??, no pointer events (iOS 13+). */
(function () {
  'use strict';

  var pdfjsLib = window.pdfjsLib;
  var L = window.PDFLib;
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js';
  var PDFJS_OPTS = { cMapUrl: 'vendor/cmaps/', cMapPacked: true, standardFontDataUrl: 'vendor/standard_fonts/' };

  var DPR = Math.min(window.devicePixelRatio || 1, 2);
  var MAXPIX = 4.2e6;            // per-canvas pixel budget (iPad Air 1 has 1 GB RAM)
  var COLORS = ['#111111', '#1f5fd6', '#d62f2f', '#1f9d4c', '#ffd60a', '#ffffff'];
  var WIDTHS = { pen: [1.2, 2.5, 5], highlight: [8, 14, 22], rect: [1, 2.5, 5] };
  var DRAW_TOOLS = { pen: 1, highlight: 1, rect: 1, whiteout: 1, eraser: 1, text: 1, sign: 1, image: 1 };

  function $(id) { return document.getElementById(id); }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function show(el, on) { el.classList[on ? 'remove' : 'add']('hidden'); }

  var toastTimer;
  function toast(msg, ms) {
    var t = $('toast');
    t.textContent = msg; show(t, true);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { show(t, false); }, ms || 2600);
  }

  function readFile(file, asDataURL) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error); };
      if (asDataURL) r.readAsDataURL(file); else r.readAsArrayBuffer(file);
    });
  }

  /* ---------- IndexedDB ---------- */
  var dbp = null;
  function idb() {
    if (!dbp) dbp = new Promise(function (resolve, reject) {
      var req = indexedDB.open('frogpdf', 1);
      req.onupgradeneeded = function () {
        var db = req.result;
        db.createObjectStore('docs', { keyPath: 'id' });
        db.createObjectStore('blobs', { keyPath: 'id' });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    return dbp;
  }
  function dbOp(store, mode, fn) {
    return idb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(store, mode);
        var req = fn(tx.objectStore(store));
        tx.oncomplete = function () { resolve(req ? req.result : undefined); };
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error || new Error('Storage full?')); };
      });
    });
  }
  function dbPut(store, v) { return dbOp(store, 'readwrite', function (s) { return s.put(v); }); }
  function dbGet(store, k) { return dbOp(store, 'readonly', function (s) { return s.get(k); }); }
  function dbDel(store, k) { return dbOp(store, 'readwrite', function (s) { return s.delete(k); }); }
  function dbAll(store) { return dbOp(store, 'readonly', function (s) { return s.getAll(); }); }

  /* ---------- pdf.js loading ---------- */
  function loadPdfjs(buf) {
    var opts = Object.assign({ data: new Uint8Array(buf.slice(0)) }, PDFJS_OPTS);
    var task = pdfjsLib.getDocument(opts);
    task.onPassword = function (update, reason) {
      var p = window.prompt(reason === 2 ? 'Wrong password. Try again:' : 'This PDF is password protected. Password:');
      if (p === null) task.destroy(); else update(p);
    };
    return task.promise;
  }

  /* ---------- Library ---------- */
  function fmtDate(t) {
    var d = new Date(t);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' +
      d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  function showLibrary() {
    show($('editor'), false); show($('library'), true);
    return dbAll('docs').then(function (docs) {
      docs.sort(function (a, b) { return b.updated - a.updated; });
      var list = $('docList');
      list.innerHTML = '';
      $('libHint').textContent = docs.length
        ? 'Recent documents. Edits save automatically on this iPad.'
        : 'Open a PDF from Files to view, mark up, sign, rearrange and export it. Everything stays on this iPad.';
      docs.forEach(function (d) {
        var el = document.createElement('div');
        el.className = 'doc';
        el.innerHTML = '<div class="thumb"></div><div class="meta"><div class="name"></div><div class="sub"></div></div><button class="del" title="Delete">&times;</button>';
        if (d.thumb) el.querySelector('.thumb').style.backgroundImage = 'url(' + d.thumb + ')';
        el.querySelector('.name').textContent = d.name;
        el.querySelector('.sub').textContent = (d.pages ? d.pages.length : 0) + ' pages · ' + fmtDate(d.updated);
        el.addEventListener('click', function () { openDoc(d.id); });
        el.querySelector('.del').addEventListener('click', function (e) {
          e.stopPropagation();
          if (!window.confirm('Delete “' + d.name + '” from Frog PDF? The original in Files is not affected.')) return;
          Promise.all([dbDel('docs', d.id)].concat(d.sourceIds.map(function (s) { return dbDel('blobs', s); })))
            .then(showLibrary);
        });
        list.appendChild(el);
      });
    }).catch(function (e) { toast('Storage error: ' + e.message, 5000); });
  }

  function importFile(file) {
    return readFile(file).then(function (buf) {
      var head = String.fromCharCode.apply(null, new Uint8Array(buf.slice(0, 1024)));
      if (head.indexOf('%PDF') < 0) throw new Error('That file is not a PDF.');
      var srcId = uid();
      var doc = {
        id: uid(), name: file.name.replace(/\.pdf$/i, '') || 'Document',
        sourceIds: [srcId], pages: null, images: {}, updated: Date.now(), thumb: null
      };
      return dbPut('blobs', { id: srcId, data: buf })
        .then(function () { return dbPut('docs', doc); })
        .then(function () { return openDoc(doc.id); });
    }).catch(function (e) { toast(e.message || String(e), 5000); });
  }

  $('openInput').addEventListener('change', function () {
    var f = this.files[0]; this.value = '';
    if (f) importFile(f);
  });

  /* ---------- Editor state ---------- */
  var cur = null;          // doc record (persisted)
  var srcBufs = [];        // ArrayBuffer per source
  var srcPdf = [];         // pdf.js document per source
  var proxies = {};        // "s:p" -> PDFPageProxy
  var views = [];          // per displayed page
  var zoom = 1, scale = 1, layoutGen = 0;
  var tool = 'hand';
  var toolColor = { pen: '#111111', highlight: '#ffd60a', text: '#111111', rect: '#d62f2f' };
  var toolWidth = { pen: 1, highlight: 1, rect: 1 };
  var undoStack = [], redoStack = [];
  var sel = null;          // { i, ai }
  var stamp = null;        // { src, w, h, kind }
  var searchHit = null;
  var curPage = 0, sidePage = 0;
  var imgCache = {};
  var measureCtx = document.createElement('canvas').getContext('2d');

  function proxyOf(pg) { return proxies[pg.s + ':' + pg.p]; }
  function effRot(pg) { return ((proxyOf(pg).rotate + pg.rot) % 360 + 360) % 360; }

  function ensureProxies() {
    var jobs = [];
    cur.pages.forEach(function (pg) {
      var k = pg.s + ':' + pg.p;
      if (!proxies[k]) jobs.push(srcPdf[pg.s].getPage(pg.p + 1).then(function (pp) { proxies[k] = pp; }));
    });
    return Promise.all(jobs);
  }

  function addSource(buf) {
    var id = uid();
    return dbPut('blobs', { id: id, data: buf }).then(function () {
      return loadPdfjs(buf);
    }).then(function (pdf) {
      cur.sourceIds.push(id); srcBufs.push(buf); srcPdf.push(pdf);
      return { s: srcPdf.length - 1, n: pdf.numPages };
    });
  }

  function openDoc(id) {
    toast('Opening…', 1500);
    return dbGet('docs', id).then(function (doc) {
      if (!doc) throw new Error('Document not found');
      return Promise.all(doc.sourceIds.map(function (s) { return dbGet('blobs', s); })).then(function (blobs) {
        srcBufs = blobs.map(function (b) { return b.data; });
        return Promise.all(srcBufs.map(loadPdfjs));
      }).then(function (pdfs) {
        cur = doc; srcPdf = pdfs; proxies = {}; imgCache = {};
        undoStack = []; redoStack = []; sel = null; stamp = null; searchHit = null; zoom = 1;
        if (!cur.pages) {
          cur.pages = [];
          for (var i = 0; i < pdfs[0].numPages; i++) cur.pages.push({ s: 0, p: i, rot: 0, a: [] });
        }
        Object.keys(cur.images).forEach(loadImg);
        return ensureProxies();
      }).then(function () {
        show($('library'), false); show($('editor'), true);
        $('docTitle').textContent = cur.name;
        setTool('hand');
        curPage = 0; sidePage = 0;
        layout();
        $('viewer').scrollTop = 0;
        updateUndo();
        if (!cur.thumb) makeThumb().then(saveNow);
        else saveNow();
      });
    }).catch(function (e) {
      if (e && e.name === 'PasswordException') toast('Cancelled.');
      else toast('Could not open: ' + (e.message || e), 5000);
      showLibrary();
    });
  }

  function closeDoc() {
    var done = cur ? makeThumb().then(saveNow) : Promise.resolve();
    return done.then(function () {
      releaseAll();
      srcPdf.forEach(function (p) { p.destroy(); });
      srcPdf = []; srcBufs = []; proxies = {}; cur = null;
      return showLibrary();
    });
  }
  $('backBtn').addEventListener('click', closeDoc);

  function makeThumb() {
    var pg = cur.pages[0];
    if (!pg) return Promise.resolve();
    var pp = proxyOf(pg);
    var vp1 = pp.getViewport({ scale: 1, rotation: effRot(pg) });
    var vp = pp.getViewport({ scale: 336 / vp1.width, rotation: effRot(pg) });
    var c = document.createElement('canvas');
    c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
    return pp.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise.then(function () {
      cur.thumb = c.toDataURL('image/jpeg', 0.7);
      c.width = 0; c.height = 0;
    }).catch(function () {});
  }

  /* ---------- Persistence ---------- */
  var saveTimer = null;
  function saveSoon() { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 700); }
  function saveNow() {
    clearTimeout(saveTimer);
    if (!cur) return Promise.resolve();
    cur.updated = Date.now();
    return dbPut('docs', cur).catch(function (e) { toast('Could not save: ' + e.message, 5000); });
  }
  document.addEventListener('visibilitychange', function () { if (document.hidden) saveNow(); });
  window.addEventListener('pagehide', saveNow);

  function snapshot() { return JSON.stringify(cur.pages); }
  function structureKey(pages) { return pages.map(function (p) { return p.s + ':' + p.p + ':' + p.rot; }).join(','); }
  function pushUndo() {
    undoStack.push(snapshot());
    if (undoStack.length > 60) undoStack.shift();
    redoStack = [];
    updateUndo();
  }
  function restore(from, to) {
    if (!from.length) return;
    var before = structureKey(cur.pages);
    to.push(snapshot());
    cur.pages = JSON.parse(from.pop());
    sel = null; updateSelBar();
    if (structureKey(cur.pages) !== before) { layout(); refreshThumbs(); } else redrawAll();
    updateUndo(); saveSoon();
  }
  function updateUndo() {
    $('undoBtn').disabled = !undoStack.length;
    $('redoBtn').disabled = !redoStack.length;
  }
  $('undoBtn').addEventListener('click', function () { restore(undoStack, redoStack); });
  $('redoBtn').addEventListener('click', function () { restore(redoStack, undoStack); });
  function changed() { redrawAll(); saveSoon(); }

  /* ---------- Layout and rendering ---------- */
  var viewer = $('viewer'), pagesWrap = $('pagesWrap');

  function releaseView(v) {
    if (v.task) { try { v.task.cancel(); } catch (e) { /* ignore */ } v.task = null; }
    v.cv.width = 0; v.cv.height = 0; v.ov.width = 0; v.ov.height = 0;
    v.ctx = null; v.rendered = false;
  }
  function releaseAll() { views.forEach(releaseView); views = []; pagesWrap.innerHTML = ''; }

  function layout() {
    layoutGen++;
    var oldH = pagesWrap.scrollHeight || 1, oldTop = viewer.scrollTop;
    releaseAll();
    var avail = Math.max(200, viewer.clientWidth - 72);
    var maxW = 1;
    cur.pages.forEach(function (pg) {
      maxW = Math.max(maxW, proxyOf(pg).getViewport({ scale: 1, rotation: effRot(pg) }).width);
    });
    scale = (avail / maxW) * zoom;
    var frag = document.createDocumentFragment();
    cur.pages.forEach(function (pg, i) {
      var rot = effRot(pg);
      var vp = proxyOf(pg).getViewport({ scale: scale, rotation: rot });
      var wrap = document.createElement('div');
      wrap.className = 'page';
      wrap.style.width = Math.floor(vp.width) + 'px';
      wrap.style.height = Math.floor(vp.height) + 'px';
      var cv = document.createElement('canvas');
      var ov = document.createElement('canvas');
      ov.className = 'ov';
      var num = document.createElement('div');
      num.className = 'num'; num.textContent = i + 1;
      wrap.appendChild(cv); wrap.appendChild(ov); wrap.appendChild(num);
      frag.appendChild(wrap);
      var v = { i: i, wrap: wrap, cv: cv, ov: ov, vp: vp, rot: rot, rendered: false, ctx: null, os: 1, task: null };
      views.push(v);
      bindInput(v);
    });
    pagesWrap.appendChild(frag);
    pagesWrap.style.minWidth = (maxW * scale + 72) + 'px';
    viewer.scrollTop = oldTop * (pagesWrap.scrollHeight / oldH);
    $('zoomLabel').textContent = zoom === 1 ? 'Fit' : Math.round(zoom * 100) + '%';
    updatePageLabel();
    scheduleRender();
  }

  var renderTimer = null, rendering = false;
  function scheduleRender() { clearTimeout(renderTimer); renderTimer = setTimeout(renderVisible, 50); }

  function renderVisible() {
    if (!cur || rendering) { if (rendering) scheduleRender(); return; }
    var top = viewer.scrollTop, h = viewer.clientHeight;
    var lo = top - h, hi = top + 2 * h;
    var want = [];
    views.forEach(function (v) {
      var y = v.wrap.offsetTop, y2 = y + v.wrap.offsetHeight;
      var near = y2 > lo && y < hi;
      var far = y2 < top - 3 * h || y > top + 4 * h;
      if (near && !v.rendered) want.push(v);
      else if (far && v.rendered) releaseView(v);
    });
    // render the page in the middle of the screen first
    var mid = top + h / 2;
    want.sort(function (a, b) {
      return Math.abs(a.wrap.offsetTop - mid) - Math.abs(b.wrap.offsetTop - mid);
    });
    var gen = layoutGen;
    rendering = true;
    (function next() {
      var v = want.shift();
      if (!v || gen !== layoutGen) { rendering = false; return; }
      renderPage(v).then(next, next);
    })();
  }

  function renderPage(v) {
    var pg = cur.pages[v.i];
    var w = v.vp.width, h = v.vp.height;
    var os = Math.min(DPR, Math.sqrt(MAXPIX / (w * h)));
    v.os = os; v.rendered = true;
    v.cv.width = Math.floor(w * os); v.cv.height = Math.floor(h * os);
    v.ov.width = v.cv.width; v.ov.height = v.cv.height;
    v.ctx = v.ov.getContext('2d');
    drawOverlay(v.i);
    var vp = proxyOf(pg).getViewport({ scale: scale * os, rotation: v.rot });
    v.task = proxyOf(pg).render({ canvasContext: v.cv.getContext('2d'), viewport: vp });
    return v.task.promise.then(function () { v.task = null; }, function () { v.task = null; });
  }

  viewer.addEventListener('scroll', function () { scheduleRender(); updatePageLabel(); });
  window.addEventListener('resize', function () { if (cur) layout(); });

  function updatePageLabel() {
    var mid = viewer.scrollTop + viewer.clientHeight / 2;
    for (var i = 0; i < views.length; i++) {
      var w = views[i].wrap;
      if (w.offsetTop + w.offsetHeight + 12 > mid) { curPage = i; break; }
    }
    $('pageLabel').textContent = (curPage + 1) + ' / ' + views.length;
  }

  function scrollToPage(i) {
    var v = views[i];
    if (v) viewer.scrollTop = v.wrap.offsetTop - 8;
  }

  $('pageLabel').addEventListener('click', function () {
    var n = parseInt(window.prompt('Go to page (1–' + views.length + '):', curPage + 1), 10);
    if (n >= 1 && n <= views.length) scrollToPage(n - 1);
  });

  /* ---------- Zoom ---------- */
  function setZoom(z, cx, cy) {
    z = Math.max(0.5, Math.min(4, z));
    if (Math.abs(z - zoom) < 0.001) return;
    if (cx === undefined) { cx = viewer.clientWidth / 2; cy = viewer.clientHeight / 2; }
    var f = z / zoom;
    var ax = viewer.scrollLeft + cx, ay = viewer.scrollTop + cy;
    zoom = z;
    var keepTop = viewer.scrollTop;
    layout();
    viewer.scrollTop = keepTop; // layout() rescales by height; set precisely below
    viewer.scrollLeft = Math.max(0, ax * f - cx);
    viewer.scrollTop = Math.max(0, ay * f - cy);
    scheduleRender();
  }
  $('zoomIn').addEventListener('click', function () { setZoom(zoom * 1.25); });
  $('zoomOut').addEventListener('click', function () { setZoom(zoom / 1.25); });
  $('zoomLabel').addEventListener('click', function () { setZoom(1); });

  // Safari pinch: preview with a CSS transform, re-render on release
  var pinch = null;
  document.addEventListener('gesturestart', function (e) { e.preventDefault(); });
  viewer.addEventListener('gesturestart', function (e) {
    e.preventDefault();
    var r = viewer.getBoundingClientRect();
    pinch = { cx: e.clientX - r.left, cy: e.clientY - r.top };
    pagesWrap.style.webkitTransformOrigin = (viewer.scrollLeft + pinch.cx) + 'px ' + (viewer.scrollTop + pinch.cy) + 'px';
  });
  viewer.addEventListener('gesturechange', function (e) {
    e.preventDefault();
    if (!pinch) return;
    var s = Math.max(0.5 / zoom, Math.min(4 / zoom, e.scale));
    pagesWrap.style.webkitTransform = 'scale(' + s + ')';
    pinch.s = s;
  });
  viewer.addEventListener('gestureend', function (e) {
    e.preventDefault();
    if (!pinch) return;
    var p = pinch; pinch = null;
    pagesWrap.style.webkitTransform = '';
    if (p.s) setZoom(zoom * p.s, p.cx, p.cy);
  });

  /* ---------- Geometry helpers ---------- */
  function toView(v, x, y) { return v.vp.convertToViewportPoint(x, y); }
  function toPdf(v, x, y) { return v.vp.convertToPdfPoint(x, y); }

  function pathCmds(xy) {
    var n = xy.length / 2, c = [];
    if (n === 1) return [['M', xy[0], xy[1]], ['L', xy[0] + 0.01, xy[1]]];
    c.push(['M', xy[0], xy[1]]);
    if (n === 2) { c.push(['L', xy[2], xy[3]]); return c; }
    for (var k = 1; k < n - 1; k++) {
      var x = xy[2 * k], y = xy[2 * k + 1];
      c.push(['Q', x, y, (x + xy[2 * k + 2]) / 2, (y + xy[2 * k + 3]) / 2]);
    }
    c.push(['L', xy[2 * n - 2], xy[2 * n - 1]]);
    return c;
  }

  function inkViewPts(v, a) {
    var out = [];
    for (var k = 0; k < a.pts.length; k += 2) {
      var p = toView(v, a.pts[k], a.pts[k + 1]);
      out.push(p[0], p[1]);
    }
    return out;
  }

  function textMetrics(a, sc) {
    var lines = a.v.split('\n');
    measureCtx.font = (a.s * sc) + 'px Helvetica, Arial, sans-serif';
    var w = 0;
    lines.forEach(function (l) { w = Math.max(w, measureCtx.measureText(l).width); });
    return { lines: lines, w: w, lh: a.s * 1.2 * sc };
  }

  function rotPts(local, theta, ox, oy) {
    var c = Math.cos(theta), s = Math.sin(theta);
    return local.map(function (p) { return [ox + p[0] * c - p[1] * s, oy + p[0] * s + p[1] * c]; });
  }

  // axis-aligned bounding box in view (CSS px) coordinates
  function bbox(v, a) {
    var xs = [], ys = [], pad = 0, pts;
    if (a.t === 'ink') {
      var vp = inkViewPts(v, a);
      for (var k = 0; k < vp.length; k += 2) { xs.push(vp[k]); ys.push(vp[k + 1]); }
      pad = a.w * scale / 2;
    } else if (a.t === 'rect') {
      var p1 = toView(v, a.x1, a.y1), p2 = toView(v, a.x2, a.y2);
      xs = [p1[0], p2[0]]; ys = [p1[1], p2[1]];
    } else {
      var o = toView(v, a.x, a.y), th = (v.rot - a.r) * Math.PI / 180;
      if (a.t === 'text') {
        var m = textMetrics(a, scale);
        pts = rotPts([[0, -a.s * scale * 0.85], [m.w, -a.s * scale * 0.85], [0, (m.lines.length - 1) * m.lh + a.s * scale * 0.25], [m.w, (m.lines.length - 1) * m.lh + a.s * scale * 0.25]], th, o[0], o[1]);
      } else {
        pts = rotPts([[0, 0], [a.w * scale, 0], [0, -a.h * scale], [a.w * scale, -a.h * scale]], th, o[0], o[1]);
      }
      pts.forEach(function (p) { xs.push(p[0]); ys.push(p[1]); });
    }
    return [Math.min.apply(null, xs) - pad, Math.min.apply(null, ys) - pad, Math.max.apply(null, xs) + pad, Math.max.apply(null, ys) + pad];
  }

  function segDist(px, py, x1, y1, x2, y2) {
    var dx = x2 - x1, dy = y2 - y1, l = dx * dx + dy * dy;
    var t = l ? Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / l)) : 0;
    var qx = x1 + t * dx - px, qy = y1 + t * dy - py;
    return Math.sqrt(qx * qx + qy * qy);
  }

  function hitTest(v, x, y) {
    var anns = cur.pages[v.i].a, tol = 10;
    for (var k = anns.length - 1; k >= 0; k--) {
      var a = anns[k], b = bbox(v, a);
      if (x < b[0] - tol || x > b[2] + tol || y < b[1] - tol || y > b[3] + tol) continue;
      if (a.t !== 'ink') return k;
      var p = inkViewPts(v, a), lim = tol + a.w * scale / 2;
      if (p.length === 2 && segDist(x, y, p[0], p[1], p[0], p[1]) < lim) return k;
      for (var j = 0; j + 3 < p.length; j += 2) {
        if (segDist(x, y, p[j], p[j + 1], p[j + 2], p[j + 3]) < lim) return k;
      }
    }
    return -1;
  }

  function translateAnnot(a, dx, dy) {
    if (a.t === 'ink') {
      for (var k = 0; k < a.pts.length; k += 2) { a.pts[k] += dx; a.pts[k + 1] += dy; }
    } else if (a.t === 'rect') {
      a.x1 += dx; a.x2 += dx; a.y1 += dy; a.y2 += dy;
    } else { a.x += dx; a.y += dy; }
  }

  /* ---------- Overlay drawing ---------- */
  function loadImg(id) {
    if (imgCache[id]) return;
    var im = new Image();
    im.onload = function () { redrawAll(); };
    im.src = cur.images[id];
    imgCache[id] = im;
  }

  function drawAnnot(ctx, v, a) {
    ctx.save();
    if (a.t === 'ink') {
      var c = pathCmds(inkViewPts(v, a));
      ctx.globalAlpha = a.o || 1;
      ctx.strokeStyle = a.c; ctx.lineWidth = a.w * scale;
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath();
      c.forEach(function (s) {
        if (s[0] === 'M') ctx.moveTo(s[1], s[2]);
        else if (s[0] === 'L') ctx.lineTo(s[1], s[2]);
        else ctx.quadraticCurveTo(s[1], s[2], s[3], s[4]);
      });
      ctx.stroke();
    } else if (a.t === 'rect') {
      var p1 = toView(v, a.x1, a.y1), p2 = toView(v, a.x2, a.y2);
      var x = Math.min(p1[0], p2[0]), y = Math.min(p1[1], p2[1]);
      var w = Math.abs(p2[0] - p1[0]), h = Math.abs(p2[1] - p1[1]);
      if (a.f) { ctx.fillStyle = a.f; ctx.fillRect(x, y, w, h); }
      if (a.c && a.w) { ctx.strokeStyle = a.c; ctx.lineWidth = a.w * scale; ctx.strokeRect(x, y, w, h); }
    } else {
      var o = toView(v, a.x, a.y);
      ctx.translate(o[0], o[1]);
      ctx.rotate((v.rot - a.r) * Math.PI / 180);
      if (a.t === 'text') {
        var m = textMetrics(a, scale);
        ctx.font = (a.s * scale) + 'px Helvetica, Arial, sans-serif';
        ctx.fillStyle = a.c; ctx.textBaseline = 'alphabetic';
        m.lines.forEach(function (l, k) { ctx.fillText(l, 0, k * m.lh); });
      } else {
        var im = imgCache[a.id];
        if (im && im.complete && im.naturalWidth) ctx.drawImage(im, 0, -a.h * scale, a.w * scale, a.h * scale);
      }
    }
    ctx.restore();
  }

  var drag = null;   // in-progress gesture
  function drawOverlay(i) {
    var v = views[i];
    if (!v || !v.ctx) return;
    var ctx = v.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, v.ov.width, v.ov.height);
    ctx.setTransform(v.os, 0, 0, v.os, 0, 0);
    cur.pages[i].a.forEach(function (a) { drawAnnot(ctx, v, a); });
    if (drag && drag.i === i && drag.temp) drawAnnot(ctx, v, drag.temp);
    if (searchHit && searchHit.i === i) {
      var p1 = toView(v, searchHit.r[0], searchHit.r[1]), p2 = toView(v, searchHit.r[2], searchHit.r[3]);
      ctx.fillStyle = 'rgba(255,140,0,.35)';
      ctx.fillRect(Math.min(p1[0], p2[0]) - 2, Math.min(p1[1], p2[1]) - 2, Math.abs(p2[0] - p1[0]) + 4, Math.abs(p2[1] - p1[1]) + 4);
    }
    if (sel && sel.i === i && cur.pages[i].a[sel.ai]) {
      var b = bbox(v, cur.pages[i].a[sel.ai]);
      ctx.strokeStyle = '#2f7cf6'; ctx.lineWidth = 1.5;
      if (ctx.setLineDash) ctx.setLineDash([5, 4]);
      ctx.strokeRect(b[0] - 5, b[1] - 5, b[2] - b[0] + 10, b[3] - b[1] + 10);
    }
  }
  var redrawQueued = false;
  function redrawAll() {
    if (redrawQueued) return;
    redrawQueued = true;
    requestAnimationFrame(function () {
      redrawQueued = false;
      views.forEach(function (v) { if (v.ctx) drawOverlay(v.i); });
    });
  }

  /* ---------- Tools ---------- */
  function setTool(t) {
    tool = t;
    var btns = document.querySelectorAll('#toolButtons .tool');
    for (var k = 0; k < btns.length; k++) btns[k].classList.toggle('active', btns[k].getAttribute('data-tool') === t);
    var ed = $('editor');
    ed.classList.toggle('editor-hand', t === 'hand');
    ed.classList.toggle('editor-draw', !!DRAW_TOOLS[t]);
    var ovs = document.querySelectorAll('.page .ov');
    for (k = 0; k < ovs.length; k++) ovs[k].style.touchAction = DRAW_TOOLS[t] ? 'none' : 'auto';
    if (t !== 'select') { sel = null; updateSelBar(); redrawAll(); }
    renderOptions();
  }

  document.querySelectorAll('#toolButtons .tool').forEach(function (b) {
    b.addEventListener('click', function () {
      var t = b.getAttribute('data-tool');
      setTool(t);
      if (t === 'sign') openSignModal();
      if (t === 'image') { stamp = null; $('imageInput').click(); }
      if (t === 'sign' || t === 'image') return;
      var tips = { text: 'Tap the page where the text should go', rect: 'Drag to draw a box', whiteout: 'Drag over content to cover it', eraser: 'Tap or drag over marks to erase', select: 'Tap a mark to select, drag to move' };
      if (tips[t]) toast(tips[t], 1800);
    });
  });

  function colorKey() { return tool === 'whiteout' ? null : (toolColor[tool] !== undefined ? tool : null); }

  function renderOptions() {
    var sw = $('swatches'), wd = $('widths');
    sw.innerHTML = ''; wd.innerHTML = '';
    var selA = sel ? cur.pages[sel.i].a[sel.ai] : null;
    var ck = colorKey();
    var active = selA ? (selA.c || selA.f) : (ck ? toolColor[ck] : null);
    if (ck || (selA && selA.t !== 'img' && !(selA.t === 'rect' && selA.f))) {
      COLORS.forEach(function (c) {
        var b = document.createElement('button');
        b.className = 'sw' + (c === active ? ' active' : '');
        b.style.background = c;
        b.addEventListener('click', function () {
          if (selA) { pushUndo(); selA.c = c; changed(); }
          else toolColor[ck] = c;
          renderOptions();
        });
        sw.appendChild(b);
      });
    }
    var wk = WIDTHS[tool] ? tool : null;
    if (wk && !selA) {
      WIDTHS[wk].forEach(function (w, k) {
        var b = document.createElement('button');
        b.className = 'wd' + (toolWidth[wk] === k ? ' active' : '');
        b.innerHTML = '<i style="height:' + Math.max(2, Math.min(14, w * (wk === 'highlight' ? 0.6 : 1.6))) + 'px"></i>';
        b.addEventListener('click', function () { toolWidth[wk] = k; renderOptions(); });
        wd.appendChild(b);
      });
    }
  }

  function evPoint(e, el) {
    var t = e.changedTouches ? e.changedTouches[0] : e;
    var r = el.getBoundingClientRect();
    return [t.clientX - r.left, t.clientY - r.top];
  }

  function bindInput(v) {
    var ov = v.ov;
    ov.style.touchAction = DRAW_TOOLS[tool] ? 'none' : 'auto';
    function down(e) {
      if (pinch || (e.touches && e.touches.length > 1)) { if (drag) { drag = null; redrawAll(); } return; }
      if (e.button) return;
      var p = evPoint(e, ov);
      if (onDown(v, p[0], p[1])) e.preventDefault();
    }
    function move(e) {
      if (!drag || drag.i !== v.i) return;
      if (e.touches && e.touches.length > 1) { drag = null; redrawAll(); return; }
      e.preventDefault();
      var p = evPoint(e, ov);
      onMove(v, p[0], p[1]);
    }
    function up(e) {
      if (!drag || drag.i !== v.i) return;
      e.preventDefault();
      var p = evPoint(e, ov);
      onUp(v, p[0], p[1]);
    }
    ov.addEventListener('touchstart', down, { passive: false });
    ov.addEventListener('touchmove', move, { passive: false });
    ov.addEventListener('touchend', up, { passive: false });
    ov.addEventListener('touchcancel', function () { drag = null; redrawAll(); });
    ov.addEventListener('mousedown', function (e) {
      if ('ontouchstart' in window && e.sourceCapabilities && e.sourceCapabilities.firesTouchEvents) return;
      down(e);
      if (!drag) return;
      function mm(ev) { move(ev); }
      function mu(ev) { up(ev); window.removeEventListener('mousemove', mm); window.removeEventListener('mouseup', mu); }
      window.addEventListener('mousemove', mm);
      window.addEventListener('mouseup', mu);
    });
  }

  // returns true when the gesture is ours (blocks scrolling)
  function onDown(v, x, y) {
    var pdf = toPdf(v, x, y);
    if (tool === 'pen' || tool === 'highlight') {
      var hl = tool === 'highlight';
      drag = { i: v.i, last: [x, y], temp: { t: 'ink', pts: [pdf[0], pdf[1]], w: WIDTHS[tool][toolWidth[tool]], c: toolColor[tool], o: hl ? 0.4 : 1 } };
      redrawAll();
      return true;
    }
    if (tool === 'rect' || tool === 'whiteout') {
      var wo = tool === 'whiteout';
      drag = { i: v.i, start: [x, y], temp: { t: 'rect', x1: pdf[0], y1: pdf[1], x2: pdf[0], y2: pdf[1], c: wo ? null : toolColor.rect, w: wo ? 0 : WIDTHS.rect[toolWidth.rect], f: wo ? '#ffffff' : null } };
      return true;
    }
    if (tool === 'eraser') {
      drag = { i: v.i, erased: false };
      eraseAt(v, x, y);
      return true;
    }
    if (tool === 'select') {
      var k = hitTest(v, x, y);
      if (k < 0) {
        if (sel) { sel = null; updateSelBar(); redrawAll(); }
        return false;
      }
      var prevSel = sel;
      sel = { i: v.i, ai: k };
      drag = { i: v.i, mv: true, last: pdf, moved: false, tapX: x, tapY: y, again: prevSel && prevSel.i === v.i && prevSel.ai === k };
      updateSelBar(); redrawAll();
      return true;
    }
    if (tool === 'text' || tool === 'sign' || tool === 'image') {
      drag = { i: v.i, tap: [x, y] };
      return true;
    }
    return false;
  }

  function onMove(v, x, y) {
    var pdf = toPdf(v, x, y);
    if (drag.temp && drag.temp.t === 'ink') {
      var dx = x - drag.last[0], dy = y - drag.last[1];
      if (dx * dx + dy * dy < 2.5) return;
      drag.last = [x, y];
      drag.temp.pts.push(pdf[0], pdf[1]);
      redrawAll();
    } else if (drag.temp && drag.temp.t === 'rect') {
      drag.temp.x2 = pdf[0]; drag.temp.y2 = pdf[1];
      redrawAll();
    } else if (drag.erased !== undefined) {
      eraseAt(v, x, y);
    } else if (drag.mv) {
      if (!drag.moved) {
        if (Math.abs(x - drag.tapX) + Math.abs(y - drag.tapY) < 4) return;
        pushUndo(); drag.moved = true;
      }
      translateAnnot(cur.pages[sel.i].a[sel.ai], pdf[0] - drag.last[0], pdf[1] - drag.last[1]);
      drag.last = pdf;
      redrawAll();
    }
  }

  function onUp(v, x, y) {
    var d = drag; drag = null;
    var pg = cur.pages[v.i];
    if (d.temp && d.temp.t === 'ink') {
      pushUndo(); pg.a.push(d.temp); changed();
    } else if (d.temp && d.temp.t === 'rect') {
      var p1 = toView(v, d.temp.x1, d.temp.y1), p2 = toView(v, d.temp.x2, d.temp.y2);
      if (Math.abs(p2[0] - p1[0]) > 4 && Math.abs(p2[1] - p1[1]) > 4) { pushUndo(); pg.a.push(d.temp); }
      changed();
    } else if (d.erased !== undefined) {
      if (d.erased) changed();
    } else if (d.mv) {
      if (d.moved) changed();
      else if (d.again && pg.a[sel.ai] && pg.a[sel.ai].t === 'text') editText(v.i, sel.ai);
    } else if (d.tap) {
      placeAt(v, d.tap[0], d.tap[1]);
    }
  }

  function eraseAt(v, x, y) {
    var k = hitTest(v, x, y);
    if (k < 0) return;
    if (!drag.erased) { pushUndo(); drag.erased = true; }
    cur.pages[v.i].a.splice(k, 1);
    redrawAll();
  }

  function placeAt(v, x, y) {
    if (tool === 'text') {
      openTextModal('', 12, function (txt, size) {
        // tap point is the top-left of the first line
        var base = toPdf(v, x, y + size * scale * 0.85);
        pushUndo();
        cur.pages[v.i].a.push({ t: 'text', x: base[0], y: base[1], r: v.rot, s: size, c: toolColor.text, v: txt });
        changed();
      });
      return;
    }
    if (!stamp) {
      if (tool === 'sign') openSignModal(); else $('imageInput').click();
      return;
    }
    var pageW = v.vp.width / scale;
    var w = Math.min(stamp.kind === 'sign' ? 160 : 260, pageW * 0.8);
    var h = w * stamp.h / stamp.w;
    var bl = toPdf(v, x - w * scale / 2, y + h * scale / 2);
    var id = uid();
    cur.images[id] = stamp.src;
    loadImg(id);
    pushUndo();
    var pg = cur.pages[v.i];
    pg.a.push({ t: 'img', x: bl[0], y: bl[1], w: w, h: h, r: v.rot, id: id });
    setTool('select');
    sel = { i: v.i, ai: pg.a.length - 1 };
    updateSelBar();
    changed();
    toast('Drag to move. Use A− / A+ to resize.');
  }

  /* ---------- Selection bar ---------- */
  function updateSelBar() {
    var a = sel ? cur.pages[sel.i].a[sel.ai] : null;
    show($('selBar'), !!a);
    if (a) show($('selEdit'), a.t === 'text');
    renderOptions();
  }
  function resizeSel(f) {
    var a = cur.pages[sel.i].a[sel.ai];
    pushUndo();
    if (a.t === 'text') a.s = Math.max(4, Math.round(a.s * f * 2) / 2);
    else if (a.t === 'img') { a.w *= f; a.h *= f; }
    else if (a.t === 'ink' || (a.t === 'rect' && a.c)) a.w = Math.max(0.5, a.w * f);
    else if (a.t === 'rect') {
      var cx = (a.x1 + a.x2) / 2, cy = (a.y1 + a.y2) / 2;
      a.x1 = cx + (a.x1 - cx) * f; a.x2 = cx + (a.x2 - cx) * f; a.y1 = cy + (a.y1 - cy) * f; a.y2 = cy + (a.y2 - cy) * f;
    }
    changed();
  }
  $('selBigger').addEventListener('click', function () { resizeSel(1.15); });
  $('selSmaller').addEventListener('click', function () { resizeSel(1 / 1.15); });
  $('selDelete').addEventListener('click', function () {
    pushUndo();
    cur.pages[sel.i].a.splice(sel.ai, 1);
    sel = null; updateSelBar(); changed();
  });
  $('selEdit').addEventListener('click', function () { editText(sel.i, sel.ai); });

  function editText(i, ai) {
    var a = cur.pages[i].a[ai];
    openTextModal(a.v, a.s, function (txt, size) {
      pushUndo(); a.v = txt; a.s = size; changed();
    }, true);
  }

  /* ---------- Modals ---------- */
  function closeModals() {
    var ms = document.querySelectorAll('.modal');
    for (var k = 0; k < ms.length; k++) show(ms[k], false);
  }
  document.querySelectorAll('[data-close]').forEach(function (b) { b.addEventListener('click', closeModals); });

  var textCb = null;
  function openTextModal(val, size, cb, editing) {
    textCb = cb;
    $('textModalTitle').textContent = editing ? 'Edit text' : 'Add text';
    $('textValue').value = val;
    var sizeSel = $('textSize');
    var found = false;
    for (var k = 0; k < sizeSel.options.length; k++) if (+sizeSel.options[k].value === size) found = true;
    if (!found) { var o = document.createElement('option'); o.textContent = size; sizeSel.appendChild(o); }
    sizeSel.value = String(size);
    show($('textModal'), true);
    setTimeout(function () { $('textValue').focus(); }, 50);
  }
  $('textOk').addEventListener('click', function () {
    var txt = $('textValue').value.replace(/\s+$/, '');
    var size = parseFloat($('textSize').value) || 12;
    closeModals();
    $('textValue').blur();
    if (txt && textCb) textCb(txt, size);
    textCb = null;
  });

  // signatures
  function loadSigs() { try { return JSON.parse(localStorage.getItem('frogpdf.sigs') || '[]'); } catch (e) { return []; } }
  function saveSigs(s) { try { localStorage.setItem('frogpdf.sigs', JSON.stringify(s)); } catch (e) { toast('Could not remember signature'); } }

  var pad = $('sigPad'), padCtx = null, padDirty = false;
  function openSignModal() {
    show($('signModal'), true);
    pad.width = pad.clientWidth * 2; pad.height = pad.clientHeight * 2;
    padCtx = pad.getContext('2d');
    padCtx.setTransform(2, 0, 0, 2, 0, 0);
    padCtx.lineCap = 'round'; padCtx.lineJoin = 'round'; padCtx.lineWidth = 2.6;
    padCtx.strokeStyle = toolColor.pen === '#1f5fd6' ? '#1f5fd6' : '#111111';
    padDirty = false;
    var list = $('sigList');
    list.innerHTML = '';
    loadSigs().forEach(function (s, k) {
      var it = document.createElement('div');
      it.className = 'sig-item';
      it.innerHTML = '<img><button>&times;</button>';
      it.querySelector('img').src = s.src;
      it.addEventListener('click', function () { useStamp(s, 'sign'); });
      it.querySelector('button').addEventListener('click', function (e) {
        e.stopPropagation();
        var all = loadSigs(); all.splice(k, 1); saveSigs(all); openSignModal();
      });
      list.appendChild(it);
    });
  }
  (function () {
    var last = null;
    function pt(e) { return evPoint(e, pad); }
    function start(e) { e.preventDefault(); last = pt(e); padCtx.beginPath(); padCtx.moveTo(last[0], last[1]); padCtx.lineTo(last[0] + 0.1, last[1]); padCtx.stroke(); padDirty = true; }
    function mv(e) {
      if (!last) return;
      e.preventDefault();
      var p = pt(e);
      padCtx.beginPath();
      padCtx.moveTo(last[0], last[1]);
      padCtx.quadraticCurveTo(last[0], last[1], (last[0] + p[0]) / 2, (last[1] + p[1]) / 2);
      padCtx.lineTo(p[0], p[1]);
      padCtx.stroke();
      last = p;
    }
    function end() { last = null; }
    pad.addEventListener('touchstart', start, { passive: false });
    pad.addEventListener('touchmove', mv, { passive: false });
    pad.addEventListener('touchend', end);
    pad.addEventListener('mousedown', start);
    window.addEventListener('mousemove', mv);
    window.addEventListener('mouseup', end);
  })();
  $('sigClear').addEventListener('click', function () {
    padCtx.save(); padCtx.setTransform(1, 0, 0, 1, 0, 0); padCtx.clearRect(0, 0, pad.width, pad.height); padCtx.restore();
    padDirty = false;
  });
  $('sigSave').addEventListener('click', function () {
    if (!padDirty) { toast('Draw your signature first'); return; }
    var c = trimCanvas(pad);
    if (!c) { toast('Draw your signature first'); return; }
    var s = { src: c.toDataURL('image/png'), w: c.width, h: c.height };
    var all = loadSigs(); all.unshift(s); saveSigs(all.slice(0, 6));
    useStamp(s, 'sign');
  });
  function useStamp(s, kind) {
    stamp = { src: s.src, w: s.w, h: s.h, kind: kind };
    closeModals();
    if (tool !== kind) setTool(kind);
    toast(kind === 'sign' ? 'Tap the page where the signature goes' : 'Tap the page where the image goes', 2500);
  }
  function trimCanvas(c) {
    var d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    var x1 = c.width, y1 = c.height, x2 = -1, y2 = -1;
    for (var y = 0; y < c.height; y++) {
      for (var x = 0; x < c.width; x++) {
        if (d[(y * c.width + x) * 4 + 3] > 8) {
          if (x < x1) x1 = x; if (x > x2) x2 = x; if (y < y1) y1 = y; if (y > y2) y2 = y;
        }
      }
    }
    if (x2 < 0) return null;
    var m = 6;
    x1 = Math.max(0, x1 - m); y1 = Math.max(0, y1 - m); x2 = Math.min(c.width - 1, x2 + m); y2 = Math.min(c.height - 1, y2 + m);
    var out = document.createElement('canvas');
    out.width = x2 - x1 + 1; out.height = y2 - y1 + 1;
    out.getContext('2d').drawImage(c, x1, y1, out.width, out.height, 0, 0, out.width, out.height);
    return out;
  }

  // images
  $('imageInput').addEventListener('change', function () {
    var f = this.files[0]; this.value = '';
    if (!f) return;
    readFile(f, true).then(function (url) {
      var im = new Image();
      im.onload = function () {
        var k = Math.min(1, 1400 / Math.max(im.naturalWidth, im.naturalHeight));
        var c = document.createElement('canvas');
        c.width = Math.round(im.naturalWidth * k); c.height = Math.round(im.naturalHeight * k);
        c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
        var png = /png|gif/i.test(f.type);
        useStamp({ src: c.toDataURL(png ? 'image/png' : 'image/jpeg', 0.86), w: c.width, h: c.height }, 'image');
        c.width = 0; c.height = 0;
      };
      im.onerror = function () { toast('Could not read that image'); };
      im.src = url;
    });
  });

  /* ---------- Search ---------- */
  var textCache = {}, searchPos = { i: 0, item: -1 };
  $('searchBtn').addEventListener('click', function () {
    var on = $('searchBar').classList.contains('hidden');
    show($('searchBar'), on);
    viewer.classList.toggle('with-search', on);
    if (on) { $('searchInput').focus(); searchPos = { i: curPage, item: -1 }; }
    else clearSearch();
  });
  $('searchClose').addEventListener('click', function () {
    show($('searchBar'), false); viewer.classList.remove('with-search'); clearSearch();
  });
  function clearSearch() { searchHit = null; $('searchStatus').textContent = ''; $('searchInput').blur(); redrawAll(); }
  $('searchInput').addEventListener('keydown', function (e) { if (e.keyCode === 13) { e.preventDefault(); searchNext(); } });
  $('searchInput').addEventListener('input', function () { searchPos = { i: curPage, item: -1 }; });
  $('searchNext').addEventListener('click', searchNext);

  function pageText(pg) {
    var k = pg.s + ':' + pg.p;
    if (!textCache[k]) textCache[k] = proxyOf(pg).getTextContent();
    return textCache[k];
  }
  function searchNext() {
    var q = $('searchInput').value.trim().toLowerCase();
    if (!q) return;
    $('searchStatus').textContent = 'Searching…';
    var n = cur.pages.length, steps = 0;
    var i = searchPos.i, start = searchPos.item + 1;
    (function step() {
      if (steps++ > n) { $('searchStatus').textContent = 'No matches'; searchHit = null; redrawAll(); return; }
      var pg = cur.pages[i];
      pageText(pg).then(function (tc) {
        for (var k = start; k < tc.items.length; k++) {
          var it = tc.items[k];
          if (it.str && it.str.toLowerCase().indexOf(q) >= 0) {
            var t = it.transform, fh = Math.sqrt(t[2] * t[2] + t[3] * t[3]) || 10;
            searchHit = { i: i, r: [t[4], t[5] - fh * 0.2, t[4] + (it.width || fh * it.str.length / 2), t[5] + fh * 0.9] };
            searchPos = { i: i, item: k };
            $('searchStatus').textContent = 'Page ' + (i + 1);
            var v = views[i];
            var p = toView(v, searchHit.r[0], searchHit.r[3]);
            viewer.scrollTop = v.wrap.offsetTop + p[1] - viewer.clientHeight / 3;
            redrawAll();
            return;
          }
        }
        i = (i + 1) % n; start = 0;
        step();
      });
    })();
  }

  /* ---------- Page panel ---------- */
  $('pagesBtn').addEventListener('click', function () {
    var on = $('sidePanel').classList.contains('hidden');
    show($('sidePanel'), on);
    if (on) { sidePage = curPage; refreshThumbs(); }
    else $('thumbs').innerHTML = '';
  });
  $('sideClose').addEventListener('click', function () { show($('sidePanel'), false); $('thumbs').innerHTML = ''; });

  var thumbGen = 0;
  function refreshThumbs() {
    if ($('sidePanel').classList.contains('hidden')) return;
    var box = $('thumbs');
    var old = box.querySelectorAll('canvas');
    for (var k = 0; k < old.length; k++) { old[k].width = 0; old[k].height = 0; }
    box.innerHTML = '';
    var gen = ++thumbGen;
    var items = cur.pages.map(function (pg, i) {
      var el = document.createElement('div');
      el.className = 'th' + (i === sidePage ? ' sel' : '');
      var c = document.createElement('canvas');
      var vp1 = proxyOf(pg).getViewport({ scale: 1, rotation: effRot(pg) });
      var s = 150 / Math.max(vp1.width, vp1.height);
      var vp = proxyOf(pg).getViewport({ scale: s * 2, rotation: effRot(pg) });
      c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
      c.style.width = (c.width / 2) + 'px'; c.style.height = (c.height / 2) + 'px';
      var lbl = document.createElement('div'); lbl.textContent = i + 1;
      el.appendChild(c); el.appendChild(lbl);
      el.addEventListener('click', function () {
        sidePage = i;
        var all = box.querySelectorAll('.th');
        for (var j = 0; j < all.length; j++) all[j].classList.toggle('sel', j === i);
        scrollToPage(i);
      });
      box.appendChild(el);
      return { pg: pg, c: c, vp: vp };
    });
    var sp = box.children[sidePage];
    if (sp) box.scrollTop = sp.offsetTop - 40;
    (function next(k) {
      if (gen !== thumbGen || k >= items.length) return;
      var it = items[k];
      proxyOf(it.pg).render({ canvasContext: it.c.getContext('2d'), viewport: it.vp }).promise
        .then(function () { next(k + 1); }, function () { next(k + 1); });
    })(0);
  }

  function blankPdfLike(pg) {
    var vp = proxyOf(pg).getViewport({ scale: 1, rotation: effRot(pg) });
    return L.PDFDocument.create().then(function (d) {
      d.addPage([vp.width, vp.height]);
      return d.save();
    }).then(function (bytes) { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); });
  }

  function pageOp(op) {
    var i = Math.min(sidePage, cur.pages.length - 1);
    var pages = cur.pages, pg = pages[i];
    var after = function () {
      layout(); refreshThumbs(); saveSoon();
      setTimeout(function () { scrollToPage(sidePage); }, 0);
    };
    if (op === 'rotl' || op === 'rotr') {
      pushUndo(); pg.rot = (pg.rot + (op === 'rotr' ? 90 : 270)) % 360; after();
    } else if (op === 'up' || op === 'down') {
      var j = op === 'up' ? i - 1 : i + 1;
      if (j < 0 || j >= pages.length) return;
      pushUndo(); pages[i] = pages[j]; pages[j] = pg; sidePage = j; after();
    } else if (op === 'del') {
      if (pages.length === 1) { toast('A PDF needs at least one page'); return; }
      if (!window.confirm('Delete page ' + (i + 1) + '?')) return;
      pushUndo(); pages.splice(i, 1); sidePage = Math.min(i, pages.length - 1); after();
    } else if (op === 'dup') {
      pushUndo(); pages.splice(i + 1, 0, JSON.parse(JSON.stringify(pg))); sidePage = i + 1; after();
    } else if (op === 'blank') {
      blankPdfLike(pg).then(addSource).then(function (r) {
        pushUndo();
        pages.splice(i + 1, 0, { s: r.s, p: 0, rot: 0, a: [] });
        sidePage = i + 1;
        return ensureProxies();
      }).then(after).catch(function (e) { toast('Failed: ' + e.message); });
    }
  }
  document.querySelectorAll('.side-actions [data-op]').forEach(function (b) {
    b.addEventListener('click', function () { pageOp(b.getAttribute('data-op')); });
  });

  $('mergeInput').addEventListener('change', function () {
    var f = this.files[0]; this.value = '';
    if (!f) return;
    toast('Adding ' + f.name + '…');
    readFile(f).then(addSource).then(function (r) {
      pushUndo();
      var at = Math.min(sidePage, cur.pages.length - 1) + 1;
      var add = [];
      for (var k = 0; k < r.n; k++) add.push({ s: r.s, p: k, rot: 0, a: [] });
      Array.prototype.splice.apply(cur.pages, [at, 0].concat(add));
      sidePage = at;
      return ensureProxies();
    }).then(function () {
      layout(); refreshThumbs(); saveSoon();
      toast('Added ' + f.name);
    }).catch(function (e) { toast('Could not add: ' + (e.message || e), 5000); });
  });

  /* ---------- Export ---------- */
  function hexRgb(h) {
    var n = parseInt(h.slice(1), 16);
    return L.rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
  }
  function dataUrlBytes(u) {
    var b = atob(u.slice(u.indexOf(',') + 1)), a = new Uint8Array(b.length);
    for (var k = 0; k < b.length; k++) a[k] = b.charCodeAt(k);
    return a;
  }

  function buildPdf() {
    var libs = {}, out, font, embedded = {}, origPages, used = {};
    function lib(key, s) {
      if (!libs[key]) libs[key] = L.PDFDocument.load(srcBufs[s], { ignoreEncryption: true });
      return libs[key];
    }
    function clean(txt) {
      var r = '';
      for (var k = 0; k < txt.length; k++) {
        var ch = txt[k];
        if (ch === '\n') { r += ch; continue; }
        try { font.encodeText(ch); r += ch; } catch (e) { r += '?'; }
      }
      return r;
    }
    function embed(id) {
      if (!embedded[id]) {
        var u = cur.images[id];
        embedded[id] = /^data:image\/png/.test(u) ? out.embedPng(dataUrlBytes(u)) : out.embedJpg(dataUrlBytes(u));
      }
      return embedded[id];
    }
    function drawAnn(page, a) {
      if (a.t === 'ink') {
        var d = pathCmds(a.pts).map(function (c) {
          return c[0] + (c[0] === 'Q' ? [c[1], -c[2], c[3], -c[4]] : [c[1], -c[2]]).map(function (n) { return +n.toFixed(2); }).join(' ');
        }).join(' ');
        page.drawSvgPath(d, { x: 0, y: 0, borderColor: hexRgb(a.c), borderWidth: a.w, borderOpacity: a.o || 1, borderLineCap: L.LineCapStyle.Round });
        return Promise.resolve();
      }
      if (a.t === 'rect') {
        var o = { x: Math.min(a.x1, a.x2), y: Math.min(a.y1, a.y2), width: Math.abs(a.x2 - a.x1), height: Math.abs(a.y2 - a.y1) };
        if (a.f) o.color = hexRgb(a.f);
        if (a.c && a.w) { o.borderColor = hexRgb(a.c); o.borderWidth = a.w; }
        page.drawRectangle(o);
        return Promise.resolve();
      }
      if (a.t === 'text') {
        page.drawText(clean(a.v), { x: a.x, y: a.y, size: a.s, font: font, color: hexRgb(a.c), lineHeight: a.s * 1.2, rotate: L.degrees(a.r) });
        return Promise.resolve();
      }
      return embed(a.id).then(function (img) {
        page.drawImage(img, { x: a.x, y: a.y, width: a.w, height: a.h, rotate: L.degrees(a.r) });
      });
    }

    return lib('0', 0).then(function (base) {
      out = base;
      origPages = out.getPages();
      for (var k = out.getPageCount() - 1; k >= 0; k--) out.removePage(k);
      return out.embedFont(L.StandardFonts.Helvetica);
    }).then(function (f) {
      font = f;
      var chain = Promise.resolve();
      cur.pages.forEach(function (pg) {
        chain = chain.then(function () {
          if (pg.s === 0 && !used[pg.p]) {
            used[pg.p] = true;
            return out.addPage(origPages[pg.p]);
          }
          // duplicates of an original page, and pages from other sources, are copied in
          var key = pg.s === 0 ? '0dup' : String(pg.s);
          return lib(key, pg.s).then(function (src) { return out.copyPages(src, [pg.p]); })
            .then(function (cp) { return out.addPage(cp[0]); });
        }).then(function (page) {
          page.setRotation(L.degrees(effRot(pg)));
          var c2 = Promise.resolve();
          pg.a.forEach(function (a) { c2 = c2.then(function () { return drawAnn(page, a); }); });
          return c2;
        });
      });
      return chain;
    }).then(function () {
      out.setModificationDate(new Date());
      out.setProducer('Frog PDF');
      return out.save();
    });
  }

  $('exportBtn').addEventListener('click', function () {
    var acts = $('exportActions');
    acts.innerHTML = '';
    $('exportMsg').textContent = 'Building PDF…';
    show($('exportModal'), true);
    saveNow();
    buildPdf().then(function (bytes) {
      var name = cur.name + '.pdf';
      var blob = new Blob([bytes], { type: 'application/pdf' });
      var url = URL.createObjectURL(blob);
      $('exportMsg').textContent = name + ' · ' + (bytes.length / 1048576).toFixed(2) + ' MB. On iPad, open it and use the Share button to save it to Files, AirDrop, mail or print it.';
      var file = null;
      try { file = new File([blob], name, { type: 'application/pdf' }); } catch (e) { file = null; }
      if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
        var sb = document.createElement('button');
        sb.className = 'btn primary'; sb.textContent = 'Share / Save to Files';
        sb.addEventListener('click', function () { navigator.share({ files: [file], title: name }).catch(function () {}); });
        acts.appendChild(sb);
      }
      var a = document.createElement('a');
      a.className = 'btn' + (acts.children.length ? '' : ' primary');
      a.href = url; a.target = '_blank'; a.rel = 'noopener';
      a.textContent = 'Open PDF';
      acts.appendChild(a);
      var dl = document.createElement('a');
      dl.className = 'btn'; dl.href = url; dl.download = name; dl.textContent = 'Download';
      acts.appendChild(dl);
      var cp = document.createElement('button');
      cp.className = 'btn'; cp.textContent = 'Save flattened copy in library';
      cp.addEventListener('click', function () {
        var buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        var srcId = uid();
        dbPut('blobs', { id: srcId, data: buf }).then(function () {
          return dbPut('docs', { id: uid(), name: cur.name + ' (copy)', sourceIds: [srcId], pages: null, images: {}, updated: Date.now() - 1, thumb: cur.thumb });
        }).then(function () { toast('Copy saved to library'); cp.disabled = true; });
      });
      acts.appendChild(cp);
    }).catch(function (e) {
      console.error(e);
      var msg = String(e && e.message || e);
      $('exportMsg').textContent = /encrypt/i.test(msg)
        ? 'This PDF is encrypted, so it can only be viewed, not re-saved. (' + msg + ')'
        : 'Export failed: ' + msg;
    });
  });

  /* ---------- Keyboard (iPad keyboards / desktop testing) ---------- */
  document.addEventListener('keydown', function (e) {
    if (!cur || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
    var mod = e.metaKey || e.ctrlKey;
    if (mod && e.key === 'z') { e.preventDefault(); restore(e.shiftKey ? redoStack : undoStack, e.shiftKey ? undoStack : redoStack); }
    else if ((e.key === 'Backspace' || e.key === 'Delete') && sel) { e.preventDefault(); $('selDelete').click(); }
    else if (e.key === 'Escape') { closeModals(); }
  });

  /* ---------- Boot ---------- */
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  }
  // expose for automated tests
  window.FrogPDF = { importFile: importFile, buildPdf: buildPdf, state: function () { return cur; }, setTool: setTool, views: function () { return views; } };

  /* ---------- Lock screen ----------
   * Only a front door: the site is static, so this hides the UI but does not encrypt anything. */
  var LOCK = { salt: 'a88f0887615c6abe077a46c3f4a7590a', iter: 200000, hash: '77977b601b45a85b96d405835c62cc31849630a26b36e372b5ddb5ce6fa45648' };
  function hexBytes(h) { var a = new Uint8Array(h.length / 2); for (var k = 0; k < a.length; k++) a[k] = parseInt(h.substr(k * 2, 2), 16); return a; }
  function bytesHex(buf) { return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join(''); }
  function derive(pw) {
    var subtle = window.crypto && (window.crypto.subtle || window.crypto.webkitSubtle);
    if (!subtle) return Promise.reject(new Error('This browser cannot check the password (needs HTTPS).'));
    var bytes = new TextEncoder().encode(pw);
    return subtle.importKey('raw', bytes, { name: 'PBKDF2' }, false, ['deriveBits']).then(function (key) {
      return subtle.deriveBits({ name: 'PBKDF2', salt: hexBytes(LOCK.salt), iterations: LOCK.iter, hash: 'SHA-256' }, key, 256);
    }).then(bytesHex);
  }
  function unlock() { show($('lock'), false); showLibrary(); }
  var remembered = null;
  try { remembered = localStorage.getItem('frogpdf.key'); } catch (e) { remembered = null; }
  if (remembered === LOCK.hash) unlock();
  else {
    show($('library'), false);
    setTimeout(function () { $('lockPw').focus(); }, 100);
    $('lockForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var card = $('lockForm'), pw = $('lockPw').value;
      if (!pw) return;
      $('lockBtn').disabled = true; $('lockMsg').textContent = 'Checking…';
      derive(pw).then(function (h) {
        $('lockBtn').disabled = false;
        if (h !== LOCK.hash) {
          $('lockMsg').textContent = 'Wrong password';
          card.classList.remove('shake'); void card.offsetWidth; card.classList.add('shake');
          $('lockPw').select();
          return;
        }
        $('lockMsg').textContent = '';
        $('lockPw').value = ''; $('lockPw').blur();
        if ($('lockRemember').checked) { try { localStorage.setItem('frogpdf.key', h); } catch (err) { /* private mode */ } }
        unlock();
      }).catch(function (err) { $('lockBtn').disabled = false; $('lockMsg').textContent = err.message; });
    });
  }
})();
