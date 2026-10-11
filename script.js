(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const onLang = [];   // functions to re-run when the language changes

  /* =====================================================
     1. Language switch (EN / FR)
     ===================================================== */
  let lang = 'en';
  try {
    const saved = localStorage.getItem('lang');
    if (saved && T[saved]) lang = saved;
    else if ((navigator.language || '').toLowerCase().startsWith('fr')) lang = 'fr';
  } catch (e) { /* storage unavailable: keep default */ }

  function applyLang(l) {
    lang = l;
    document.documentElement.lang = l;
    const dict = T[l];
    $$('[data-i18n]').forEach(el => { if (dict[el.dataset.i18n] !== undefined) el.textContent = dict[el.dataset.i18n]; });
    $$('[data-i18n-aria]').forEach(el => { if (dict[el.dataset.i18nAria] !== undefined) el.setAttribute('aria-label', dict[el.dataset.i18nAria]); });
    document.title = dict['meta.title'];
    $$('[data-cv="auto"]').forEach(a => { a.href = `assets/CV_Rihab_Chnayna_${l.toUpperCase()}.docx`; });
    $$('.lang button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.lang === l)));
    onLang.forEach(fn => fn());
    try { localStorage.setItem('lang', l); } catch (e) { /* ignore */ }
  }
  $$('.lang button').forEach(b => b.addEventListener('click', () => applyLang(b.dataset.lang)));

  /* =====================================================
     Shared terrain helpers: value noise + marching squares
     ===================================================== */
  function makeNoise(seed) {
    const hash = (x, y) => {
      let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1442695041)) | 0;
      h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16;
      return (h >>> 0) / 4294967295;
    };
    const smooth = t => t * t * (3 - 2 * t);
    const value = (x, y) => {
      const ix = Math.floor(x), iy = Math.floor(y), fx = smooth(x - ix), fy = smooth(y - iy);
      const a = hash(ix, iy), b = hash(ix + 1, iy), c = hash(ix, iy + 1), d = hash(ix + 1, iy + 1);
      return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
    };
    return (x, y, octaves = 4) => {
      let sum = 0, amp = .5, freq = 1, norm = 0;
      for (let i = 0; i < octaves; i++) { sum += amp * value(x * freq, y * freq); norm += amp; amp *= .5; freq *= 2; }
      return sum / norm;
    };
  }

  // Returns two Path2D objects (thin and index contours) for a scalar field.
  function contourPaths(f, w, h, step, sx, sy, thickEvery) {
    const thin = new Path2D(), thick = new Path2D();
    for (let y = 0; y < h - 1; y++) for (let x = 0; x < w - 1; x++) {
      const a = f[y * w + x], b = f[y * w + x + 1], c = f[(y + 1) * w + x + 1], d = f[(y + 1) * w + x];
      const lo = Math.min(a, b, c, d), hi = Math.max(a, b, c, d);
      for (let k = Math.ceil(lo / step); k * step <= hi; k++) {
        const L = k * step;
        const idx = (a > L ? 8 : 0) | (b > L ? 4 : 0) | (c > L ? 2 : 0) | (d > L ? 1 : 0);
        if (idx === 0 || idx === 15) continue;
        const T = [x + (L - a) / (b - a), y], R = [x + 1, y + (L - b) / (c - b)];
        const B = [x + (L - d) / (c - d), y + 1], Lf = [x, y + (L - a) / (d - a)];
        const p = (k % thickEvery === 0) ? thick : thin;
        const seg = (u, v) => { p.moveTo((u[0] + .5) * sx, (u[1] + .5) * sy); p.lineTo((v[0] + .5) * sx, (v[1] + .5) * sy); };
        switch (idx) {
          case 1: case 14: seg(Lf, B); break;
          case 2: case 13: seg(B, R); break;
          case 3: case 12: seg(Lf, R); break;
          case 4: case 11: seg(T, R); break;
          case 5: seg(Lf, T); seg(B, R); break;
          case 6: case 9: seg(T, B); break;
          case 7: case 8: seg(Lf, T); break;
          case 10: seg(T, R); seg(Lf, B); break;
        }
      }
    }
    return { thin, thick };
  }

  function boxBlur(src, w, h, r) {      // separable box blur
    const tmp = new Float32Array(src.length), out = new Float32Array(src.length), n = 2 * r + 1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let s = 0; for (let k = -r; k <= r; k++) s += src[y * w + Math.min(w - 1, Math.max(0, x + k))];
      tmp[y * w + x] = s / n;
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let s = 0; for (let k = -r; k <= r; k++) s += tmp[Math.min(h - 1, Math.max(0, y + k)) * w + x];
      out[y * w + x] = s / n;
    }
    return out;
  }

  /* =====================================================
     2. Hero: synthetic LiDAR point cloud
     Class codes follow the ASPRS convention in spirit:
     ground, vegetation, building, wire, tower.
     ===================================================== */
  (function pointCloud() {
    const canvas = $('#cloud');
    const ctx = canvas.getContext('2d');
    const CLASS_COLORS = ['#C9B48C', '#5FBF7F', '#FF6B5B', '#F2B705', '#7FD3E0'];

    function rng(seed) {                      // small seeded random: same landscape every visit
      return () => {
        seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    // ---- build the scene ----
    const rand = rng(11);
    const raw = [];
    const add = (x, y, z, c) => raw.push(x, y, z, c);
    const terrain = (x, z) =>
      6 * Math.sin(x * 0.07 + 1.3) * Math.cos(z * 0.06) +
      3.5 * Math.sin(x * 0.13 + z * 0.11) +
      1.6 * Math.sin(x * 0.29 - z * 0.23) +
      8 * Math.exp(-(((x - 25) ** 2) + ((z + 15) ** 2)) / 500);

    for (let x = -60; x <= 60; x += 1.25)
      for (let z = -60; z <= 60; z += 1.25) {
        const jx = x + (rand() - .5) * .9, jz = z + (rand() - .5) * .9;
        add(jx, terrain(jx, jz), jz, 0);
      }

    const buildings = [[-32, -18, 12, 9, 7], [-14, -34, 8, 8, 5], [30, 28, 14, 10, 6]];
    buildings.forEach(([cx, cz, w, d, h]) => {
      const g = terrain(cx, cz), s = 1.1;
      for (let x = -w / 2; x <= w / 2; x += s)
        for (let z = -d / 2; z <= d / 2; z += s) add(cx + x, g + h, cz + z, 2);
      for (let y = 0; y < h; y += s) {
        for (let x = -w / 2; x <= w / 2; x += s) { add(cx + x, g + y, cz - d / 2, 2); add(cx + x, g + y, cz + d / 2, 2); }
        for (let z = -d / 2; z <= d / 2; z += s) { add(cx - w / 2, g + y, cz + z, 2); add(cx + w / 2, g + y, cz + z, 2); }
      }
    });

    for (let i = 0; i < 46; i++) {
      let x, z;
      do { x = (rand() - .5) * 110; z = (rand() - .5) * 110; }
      while (buildings.some(b => Math.abs(x - b[0]) < b[2] / 2 + 5 && Math.abs(z - b[1]) < b[3] / 2 + 5));
      const g = terrain(x, z), th = 5 + rand() * 5, rad = 1.8 + rand() * 1.4;
      for (let y = 0; y < th * .6; y += 1) add(x, g + y, z, 1);
      for (let k = 0; k < 46; k++) {
        const a = rand() * 6.283, u = rand() * 2 - 1, s = Math.sqrt(1 - u * u), r = rad * Math.cbrt(rand());
        add(x + r * s * Math.cos(a), g + th * .85 + r * u * 1.3, z + r * s * Math.sin(a), 1);
      }
    }

    const A = [-54, 2], B = [54, -8], towerH = 17;
    const dx = B[0] - A[0], dz = B[1] - A[1], len = Math.hypot(dx, dz), px = -dz / len, pz = dx / len;
    const gA = terrain(A[0], A[1]), gB = terrain(B[0], B[1]);
    [[A, gA], [B, gB]].forEach(([p, g]) => {
      for (let y = 0; y <= towerH; y += .7) add(p[0], g + y, p[1], 4);
      for (let o = -3; o <= 3; o += .7) add(p[0] + px * o, g + towerH - 2, p[1] + pz * o, 4);
    });
    [-3, 0, 3].forEach(o => {
      for (let t = 0; t <= 1; t += .008) {
        const x = A[0] + dx * t + px * o, z = A[1] + dz * t + pz * o;
        const y = (gA + towerH - 2) * (1 - t) + (gB + towerH - 2) * t - 16 * t * (1 - t);
        add(x, Math.max(y, terrain(x, z) + 6), z, 3);   // keep wires clear of the ground
      }
    });

    const N = raw.length / 4;
    const X = new Float32Array(N), Y = new Float32Array(N), Z = new Float32Array(N), C = new Uint8Array(N);
    let yMin = Infinity, yMax = -Infinity;
    for (let i = 0; i < N; i++) {
      X[i] = raw[i * 4]; Y[i] = raw[i * 4 + 1]; Z[i] = raw[i * 4 + 2]; C[i] = raw[i * 4 + 3];
      yMin = Math.min(yMin, Y[i]); yMax = Math.max(yMax, Y[i]);
    }
    const SX = new Float32Array(N), SY = new Float32Array(N);

    // ---- colour modes ----
    const BUCKETS = 14;
    const stops = [[43, 111, 138], [95, 191, 127], [242, 183, 5]];
    function heightColor(t) {
      const seg = t < .5 ? 0 : 1, u = t < .5 ? t * 2 : (t - .5) * 2;
      const a = stops[seg], b = stops[seg + 1];
      return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * u)).join(',')})`;
    }
    let mode = 'class';
    let groups = [];
    function buildGroups() {
      const lists = new Map();
      const push = (key, color, i) => { if (!lists.has(key)) lists.set(key, { color, idx: [] }); lists.get(key).idx.push(i); };
      for (let i = 0; i < N; i++) {
        if (mode === 'raw') push('r', 'rgba(169,189,195,.8)', i);
        else if (mode === 'height') {
          const b = Math.min(BUCKETS - 1, Math.floor(((Y[i] - yMin) / (yMax - yMin)) * BUCKETS));
          push(b, heightColor(b / (BUCKETS - 1)), i);
        } else push(C[i], CLASS_COLORS[C[i]], i);
      }
      groups = [...lists.values()].map(g => ({ color: g.color, idx: Int32Array.from(g.idx) }));
    }

    // ---- rendering ----
    let W = 0, H = 0, dpr = 1;
    const mouse = { x: 0, y: 0, active: false, nx: 0, smooth: 0 };
    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      const r = canvas.getBoundingClientRect();
      W = canvas.width = Math.round(r.width * dpr);
      H = canvas.height = Math.round(r.height * dpr);
    }

    function render(time) {
      const yaw = .6 + (reduceMotion ? 0 : Math.sin(time * .00022) * .3) + mouse.smooth * .8;
      const pitch = .62, cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
      const D = 190, f = Math.min(W, H * 1.3) * 1.45;
      const ox = W / 2, oy = H * .62;
      for (let i = 0; i < N; i++) {
        const xr = X[i] * cy - Z[i] * sy, zr = X[i] * sy + Z[i] * cy;
        const y2 = (Y[i] - 4) * cp - zr * sp, z2 = (Y[i] - 4) * sp + zr * cp;
        const k = f / (D + z2);
        SX[i] = ox + xr * k; SY[i] = oy - y2 * k;
      }
      const size = Math.max(1.4, dpr * 1.5 * (f / D / 4.6) * .55);
      ctx.clearRect(0, 0, W, H);
      groups.forEach(g => {
        ctx.fillStyle = g.color;
        const idx = g.idx;
        for (let j = 0; j < idx.length; j++) ctx.fillRect(SX[idx[j]], SY[idx[j]], size, size);
      });
      if (mouse.active) {                               // lens: reveal classes under the cursor
        const R = 70 * dpr, R2 = R * R, lists = [[], [], [], [], []];
        for (let i = 0; i < N; i++) {
          const ddx = SX[i] - mouse.x, ddy = SY[i] - mouse.y;
          if (ddx * ddx + ddy * ddy < R2) lists[C[i]].push(i);
        }
        lists.forEach((l, c) => {
          ctx.fillStyle = CLASS_COLORS[c];
          l.forEach(i => ctx.fillRect(SX[i] - size * .25, SY[i] - size * .25, size * 1.5, size * 1.5));
        });
        ctx.strokeStyle = 'rgba(242,183,5,.7)'; ctx.lineWidth = dpr;
        ctx.beginPath(); ctx.arc(mouse.x, mouse.y, R, 0, 6.283); ctx.stroke();
      }
    }

    // ---- loop, only while visible ----
    let visible = true, raf = 0;
    function tick(t) {
      mouse.smooth += (mouse.nx - mouse.smooth) * .06;
      render(t);
      raf = visible && !reduceMotion ? requestAnimationFrame(tick) : 0;
    }
    const kick = () => { if (!raf) raf = requestAnimationFrame(tick); };

    canvas.addEventListener('pointermove', e => {
      const r = canvas.getBoundingClientRect();
      mouse.x = (e.clientX - r.left) * dpr; mouse.y = (e.clientY - r.top) * dpr;
      mouse.nx = (e.clientX - r.left) / r.width - .5; mouse.active = true;
      if (reduceMotion) { mouse.smooth = mouse.nx; kick(); }
    });
    canvas.addEventListener('pointerleave', () => { mouse.active = false; mouse.nx = 0; if (reduceMotion) { mouse.smooth = 0; kick(); } });
    window.addEventListener('resize', () => { resize(); kick(); });
    new IntersectionObserver(([e]) => { visible = e.isIntersecting; if (visible) kick(); }).observe(canvas);

    $$('.modes button').forEach(b => {
      b.addEventListener('click', () => {
        mode = b.dataset.mode; buildGroups();
        $$('.modes button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
        kick();
      });
    });

    resize(); buildGroups(); kick();
  })();

  /* =====================================================
     3. Weighted overlay demo (synthetic data)
     Score = sum(weight x factor) / sum(weights)
     ===================================================== */
  (function overlay() {
    const SIZE = 28, CELL = 16;
    const canvas = $('#ov-canvas'), ctx = canvas.getContext('2d');
    const clamp = v => Math.max(0, Math.min(1, v));
    const factors = [
      (x, y) => clamp(.5 + .5 * Math.sin(x * .33 + .6) * Math.cos(y * .27)),                       // slope
      (x, y) => clamp(.5 + .5 * Math.sin((x + y) * .18 + 1.1)),                                    // rainfall
      (x, y) => clamp(.5 + .5 * Math.cos(x * .21 - y * .3) * Math.sin(y * .15 + .4)),              // lithology / permeability
      (x, y) => clamp(.5 + .5 * Math.sin(x * .45) * Math.sin(y * .38 + 2)),                        // land use
      (x, y) => clamp(1 - Math.abs(y - (14 + 5 * Math.sin(x * .3))) / 5),                           // drainage network
      (x, y) => clamp(1 - Math.min(Math.abs(x - y * .8 - 4), Math.abs(x + y - 30)) / 3.5),          // roads
    ];
    const layers = factors.map(fn => { const a = []; for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) a.push(fn(x, y)); return a; });
    const COLORS = ['#CFE3DD', '#7FB8AE', '#F2B705', '#C8421E'];
    const weights = layers.map(() => 5);

    // sliders
    const sliderBox = $('#ov-sliders');
    const outputs = [];
    layers.forEach((_, i) => {
      const wrap = document.createElement('div'); wrap.className = 'slider';
      const label = document.createElement('label'); label.htmlFor = `w${i}`;
      const name = document.createElement('span'); name.dataset.i18n = `ov.l${i + 1}`;
      const out = document.createElement('output'); out.htmlFor = `w${i}`; out.textContent = weights[i];
      const input = document.createElement('input');
      Object.assign(input, { type: 'range', id: `w${i}`, min: 0, max: 10, step: 1, value: weights[i] });
      input.addEventListener('input', () => { weights[i] = +input.value; out.textContent = input.value; draw(); });
      label.append(name, out); wrap.append(label, input); sliderBox.append(wrap); outputs.push({ input, out });
    });
    $('#ov-reset').addEventListener('click', () => {
      outputs.forEach((o, i) => { weights[i] = 5; o.input.value = 5; o.out.textContent = 5; }); draw();
    });

    // legend
    const legend = $('#ov-legend'), shares = [];
    COLORS.forEach((c, i) => {
      const li = document.createElement('li');
      const sw = document.createElement('i'); sw.style.background = c;
      const nm = document.createElement('span'); nm.dataset.i18n = `ov.c${i + 1}`;
      const pc = document.createElement('b');
      li.append(sw, nm, pc); legend.append(li); shares.push(pc);
    });

    function draw() {
      const total = weights.reduce((a, b) => a + b, 0);
      const score = new Float32Array(SIZE * SIZE);
      let lo = Infinity, hi = -Infinity;
      for (let i = 0; i < score.length; i++) {
        let s = 0; layers.forEach((l, k) => { s += l[i] * weights[k]; });
        score[i] = total ? s / total : 0;
        lo = Math.min(lo, score[i]); hi = Math.max(hi, score[i]);
      }
      const counts = [0, 0, 0, 0];
      for (let i = 0; i < score.length; i++) {
        const t = hi > lo ? (score[i] - lo) / (hi - lo) : 0;
        const c = Math.min(3, Math.floor(t * 4));
        counts[c]++;
        ctx.fillStyle = COLORS[c];
        ctx.fillRect((i % SIZE) * CELL, Math.floor(i / SIZE) * CELL, CELL, CELL);
      }
      counts.forEach((n, i) => { shares[i].textContent = Math.round(n / score.length * 100) + '%'; });
    }
    draw();
  })();


  /* =====================================================
     4. Hero background: drifting contour lines
     ===================================================== */
  (function heroContours() {
    const canvas = $('#contours'), ctx = canvas.getContext('2d');
    const GW = 150, GH = 90, field = new Float32Array(GW * GH), noise = makeNoise(21);
    for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) field[y * GW + x] = noise(x / 28, y / 28, 4) * 100;
    const paths = contourPaths(field, GW, GH, 3.2, 1, 1, 4);
    function draw() {
      const r = canvas.getBoundingClientRect(), dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr);
      ctx.setTransform(canvas.width / GW, 0, 0, canvas.height / GH, 0, 0);
      ctx.lineJoin = 'round';
      ctx.strokeStyle = 'rgba(127,211,224,.16)'; ctx.lineWidth = 1.1 * GW / (r.width || GW); ctx.stroke(paths.thin);
      ctx.strokeStyle = 'rgba(127,211,224,.34)'; ctx.lineWidth = 2 * GW / (r.width || GW); ctx.stroke(paths.thick);
    }
    window.addEventListener('resize', draw); draw();
  })();

  /* =====================================================
     5. Skills: layer stack + QGIS-style properties panel
     ===================================================== */
  (function skills() {
    const groups = [
      { c: '#F2B705', soft: 'rgba(242,183,5,.4)',  tags: ['QGIS', 'ArcGIS', 'Vector analysis', 'Raster analysis', 'Digitizing', 'Spatial queries'],
        pat: 'linear-gradient(var(--cs) 1px, transparent 1px), linear-gradient(90deg, var(--cs) 1px, transparent 1px)', ps: '22px 22px' },
      { c: '#5FBF7F', soft: 'rgba(95,191,127,.4)', tags: ['Thematic maps', 'Hazard maps', 'Hillshade', 'Slope', 'Contours', 'Map layouts', 'GeoServer'],
        pat: 'repeating-radial-gradient(circle at 30% 60%, transparent 0 10px, var(--cs) 10px 12px)', ps: 'auto' },
      { c: '#7FD3E0', soft: 'rgba(127,211,224,.4)', tags: ['Sentinel-1', 'InSAR', 'DInSAR', 'SNAP', 'ENVI', 'Google Earth Engine', 'PyGMTSAR'],
        pat: 'repeating-linear-gradient(45deg, transparent 0 8px, var(--cs) 8px 10px)', ps: 'auto' },
      { c: '#FF6B5B', soft: 'rgba(255,107,91,.4)', tags: ['LiDAR', 'TerraScan', 'MicroStation', 'Point clouds', '3D modeling', 'Sharper Shape'],
        pat: 'radial-gradient(var(--cs) 2px, transparent 2.6px)', ps: '14px 14px' },
      { c: '#9FB4FF', soft: 'rgba(159,180,255,.4)', tags: ['PostgreSQL', 'PostGIS', 'pgAdmin', 'SQL', 'Python', 'JavaScript', 'HTML', 'Google Colab', 'AutoCAD'],
        pat: 'repeating-linear-gradient(0deg, transparent 0 18px, var(--cs) 18px 20px), repeating-linear-gradient(90deg, transparent 0 60px, var(--cs) 60px 62px)', ps: 'auto' },
      { c: '#E8E3D0', soft: 'rgba(232,227,208,.35)', tags: ['Quality control', 'Project coordination', 'Technical documentation', 'Progress reports'],
        pat: 'conic-gradient(var(--cs) 25%, transparent 0 50%, var(--cs) 0 75%, transparent 0)', ps: '28px 28px' },
    ];
    const stack = $('#stack'), list = $('#sk-list');
    const planes = [], buttons = [];
    let active = 0;

    groups.forEach((g, i) => {
      const plane = document.createElement('div');
      plane.className = 'plane';
      plane.style.cssText = `--c:${g.c};--cs:${g.soft};--i:${i};--pat:${g.pat};--ps:${g.ps}`;
      stack.append(plane); planes.push(plane);

      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      const sw = document.createElement('i'); sw.style.setProperty('--c', g.c);
      const name = document.createElement('span'); name.dataset.i18n = `sk.${i + 1}t`;
      btn.append(sw, name); li.append(btn); list.append(li); buttons.push(btn);
      btn.addEventListener('click', () => select(i));
      btn.addEventListener('mouseenter', () => { if (window.matchMedia('(hover: hover)').matches) select(i); });
    });

    function select(i) {
      active = i;
      planes.forEach((p, k) => p.dataset.active = String(k === i));
      buttons.forEach((b, k) => b.setAttribute('aria-pressed', String(k === i)));
      const d = T[lang];
      $('#sk-title').textContent = d[`sk.${i + 1}t`];
      $('#sk-desc').textContent = d[`sk.${i + 1}d`];
      const tags = $('#sk-tags'); tags.replaceChildren();
      groups[i].tags.forEach(t => { const li = document.createElement('li'); li.textContent = t; tags.append(li); });
    }
    onLang.push(() => select(active));
    select(0);
  })();

  /* =====================================================
     6. Mapping sheet: synthetic terrain, QGIS-like layers
     ===================================================== */
  (function mapSheet() {
    const canvas = $('#map'), ctx = canvas.getContext('2d');
    const GW = 260, GH = 182, SC = canvas.width / GW, CELL_M = 30;
    const N = GW * GH, noise = makeNoise(5), noise2 = makeNoise(17);
    const clamp01 = v => Math.max(0, Math.min(1, v));

    // ---- elevation (metres) ----
    const valleyY = x => GH * .55 + Math.sin(x / 38) * 16;
    const H = new Float32Array(N);
    let hMin = Infinity, hMax = -Infinity;
    for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
      const d = y - valleyY(x);
      const v = noise(x / 55, y / 55, 5) - .38 * Math.exp(-(d * d) / (2 * 14 * 14)) + (1 - y / GH) * .22;
      H[y * GW + x] = v; hMin = Math.min(hMin, v); hMax = Math.max(hMax, v);
    }
    const E = H.map(v => 120 + (v - hMin) / (hMax - hMin) * 500);
    $('#e-min').textContent = '120 m'; $('#e-max').textContent = '620 m';

    // ---- slope + hillshade ----
    const slope = new Float32Array(N), shade = new Float32Array(N);
    const L = (() => { const v = [-1, -1, 1.1], m = Math.hypot(...v); return v.map(a => a / m); })();
    for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
      const i = y * GW + x, x0 = Math.max(0, x - 1), x1 = Math.min(GW - 1, x + 1), y0 = Math.max(0, y - 1), y1 = Math.min(GH - 1, y + 1);
      const dzdx = (E[y * GW + x1] - E[y * GW + x0]) / ((x1 - x0) * CELL_M);
      const dzdy = (E[y1 * GW + x] - E[y0 * GW + x]) / ((y1 - y0) * CELL_M);
      slope[i] = Math.atan(Math.hypot(dzdx, dzdy)) * 180 / Math.PI;
      const ex = 2.6, nx = -dzdx * ex, ny = -dzdy * ex, nm = Math.hypot(nx, ny, 1);
      shade[i] = Math.max(0, (nx * L[0] + ny * L[1] + L[2]) / nm);
    }

    // ---- drainage (flow accumulation on a pit-filled copy) ----
    const hf = Float32Array.from(E);
    for (let pass = 0; pass < 40; pass++) {
      let changed = false;
      for (let y = 1; y < GH - 1; y++) for (let x = 1; x < GW - 1; x++) {
        const i = y * GW + x; let m = Infinity;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy) m = Math.min(m, hf[i + dy * GW + dx]);
        if (hf[i] <= m) { hf[i] = m + .01; changed = true; }
      }
      if (!changed) break;
    }
    const down = new Int32Array(N).fill(-1);
    for (let y = 1; y < GH - 1; y++) for (let x = 1; x < GW - 1; x++) {
      const i = y * GW + x; let best = 0, bj = -1;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy) {
        const j = i + dy * GW + dx, g = (hf[i] - hf[j]) / (dx && dy ? 1.414 : 1);
        if (g > best) { best = g; bj = j; }
      }
      down[i] = bj;
    }
    const order = Array.from({ length: N }, (_, i) => i).sort((a, b) => hf[b] - hf[a]);
    const acc = new Float32Array(N).fill(1);
    order.forEach(i => { if (down[i] >= 0) acc[down[i]] += acc[i]; });
    const drainPaths = [60, 200, 600].map(T => {
      const p = new Path2D();
      for (let i = 0; i < N; i++) if (down[i] >= 0 && acc[i] >= T) {
        const j = down[i];
        p.moveTo(((i % GW) + .5) * SC, (Math.floor(i / GW) + .5) * SC);
        p.lineTo(((j % GW) + .5) * SC, (Math.floor(j / GW) + .5) * SC);
      }
      return p;
    });

    // ---- roads (polylines in grid units) ----
    const road = (fn, n) => Array.from({ length: n + 1 }, (_, k) => fn(k / n));
    const roads = [
      { w: 3, pts: road(t => [t * GW, valleyY(t * GW) + 10 + Math.sin(t * 9) * 3], 120) },
      { w: 2.2, pts: road(t => [GW * .3 + Math.sin(t * 7) * 18, t * GH], 90) },
      { w: 2.2, pts: road(t => [GW * (.55 + .45 * t), GH * .7 * t + Math.sin(t * 8) * 6], 90) },
    ];
    const roadMask = new Float32Array(N);
    roads.forEach(r => r.pts.forEach(([x, y]) => {
      const gx = Math.round(x), gy = Math.round(y);
      if (gx >= 0 && gx < GW && gy >= 0 && gy < GH) roadMask[gy * GW + gx] = 1;
    }));

    // ---- contours ----
    const contours = contourPaths(E, GW, GH, 40, SC, SC, 5);

    // ---- susceptibility ----
    const drainMask = new Float32Array(N); for (let i = 0; i < N; i++) drainMask[i] = acc[i] >= 200 ? 1 : 0;
    const dProx = boxBlur(drainMask, GW, GH, 4), rProx = boxBlur(roadMask, GW, GH, 3);
    const dMax = Math.max(...dProx), rMax = Math.max(...rProx);
    let score = new Float32Array(N);
    for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
      const i = y * GW + x, rain = .5 + .5 * (noise2(x / 90 + 10, y / 90, 3) - .5) * 2;
      score[i] = .5 * clamp01(slope[i] / 32) + .2 * clamp01(rain) + .2 * (dProx[i] / dMax) + .1 * (rProx[i] / rMax);
    }
    score = boxBlur(score, GW, GH, 2);
    let sMin = Infinity, sMax = -Infinity; score.forEach(v => { sMin = Math.min(sMin, v); sMax = Math.max(sMax, v); });
    for (let i = 0; i < N; i++) score[i] = (score[i] - sMin) / (sMax - sMin);
    const sorted = Float32Array.from(score).sort();
    const cuts = [.45, .75, .92].map(q => sorted[Math.floor(q * (N - 1))]);
    const classOf = s => (s < cuts[0] ? 0 : s < cuts[1] ? 1 : s < cuts[2] ? 2 : 3);
    const SUSC_RGB = [[207, 227, 221], [127, 184, 174], [242, 183, 5], [200, 66, 30]];

    // ---- pre-rendered raster layers ----
    const tint = [[0, [92, 143, 107]], [.25, [169, 194, 126]], [.5, [227, 215, 154]], [.75, [199, 154, 104]], [1, [154, 107, 78]]];
    const tintAt = t => {
      for (let k = 1; k < tint.length; k++) if (t <= tint[k][0]) {
        const [t0, c0] = tint[k - 1], [t1, c1] = tint[k], u = (t - t0) / (t1 - t0);
        return c0.map((v, j) => v + (c1[j] - v) * u);
      }
      return tint[tint.length - 1][1];
    };
    const base = document.createElement('canvas'); base.width = GW; base.height = GH;
    {
      const bctx = base.getContext('2d'), img = bctx.createImageData(GW, GH);
      for (let i = 0; i < N; i++) {
        const c = tintAt((E[i] - 120) / 500), k = .5 + .75 * shade[i];
        img.data[i * 4] = Math.min(255, c[0] * k); img.data[i * 4 + 1] = Math.min(255, c[1] * k);
        img.data[i * 4 + 2] = Math.min(255, c[2] * k); img.data[i * 4 + 3] = 255;
      }
      bctx.putImageData(img, 0, 0);
    }
    const suscCv = document.createElement('canvas'); suscCv.width = GW * 2; suscCv.height = GH * 2;
    {
      const sctx = suscCv.getContext('2d'), W2 = GW * 2, H2 = GH * 2, img = sctx.createImageData(W2, H2);
      for (let Y = 0; Y < H2; Y++) for (let X = 0; X < W2; X++) {
        const fx = Math.min(GW - 1.001, Math.max(0, (X + .5) / 2 - .5)), fy = Math.min(GH - 1.001, Math.max(0, (Y + .5) / 2 - .5));
        const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0, i = y0 * GW + x0;
        const s = score[i] * (1 - tx) * (1 - ty) + score[i + 1] * tx * (1 - ty) + score[i + GW] * (1 - tx) * ty + score[i + GW + 1] * tx * ty;
        const c = SUSC_RGB[classOf(s)], o = (Y * W2 + X) * 4;
        img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = 255;
      }
      sctx.putImageData(img, 0, 0);
    }

    // ---- InSAR points ----
    const rnd = (() => { let s = 99; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; })();
    const insar = [];
    while (insar.length < 230) {
      const x = rnd() * GW, y = rnd() * GH, s = score[Math.floor(y) * GW + Math.floor(x)];
      if (rnd() < Math.pow(s, 1.6) * 1.15) insar.push({ x, y, v: -34 * s + 8 + (rnd() - .5) * 12 });
    }
    const velColor = v => (v < -20 ? '#B2182B' : v < -8 ? '#EF8A62' : v < 4 ? '#F5F5F5' : '#2166AC');

    // ---- layer panel ----
    const LAYERS = [
      { id: 'elev', key: 'map.l.elev', on: true }, { id: 'susc', key: 'map.l.susc', on: true },
      { id: 'cont', key: 'map.l.cont', on: true }, { id: 'drain', key: 'map.l.drain', on: true },
      { id: 'roads', key: 'map.l.roads', on: true }, { id: 'insar', key: 'map.l.insar', on: true },
      { id: 'grid', key: 'map.l.grid', on: false },
    ];
    const state = {}; LAYERS.forEach(l => { state[l.id] = l.on; });
    let suscOpacity = .6;
    const ul = $('#map-layers');
    LAYERS.forEach(l => {
      const li = document.createElement('li'), label = document.createElement('label');
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = l.on;
      const nm = document.createElement('span'); nm.dataset.i18n = l.key;
      cb.addEventListener('change', () => { state[l.id] = cb.checked; draw(); });
      label.append(cb, nm); li.append(label); ul.append(li);
    });
    $('#susc-op').addEventListener('input', e => { suscOpacity = e.target.value / 100; draw(); });

    function draw() {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = '#E9EEEC'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingEnabled = true;
      if (state.elev) ctx.drawImage(base, 0, 0, canvas.width, canvas.height);
      if (state.susc) { ctx.globalAlpha = suscOpacity; ctx.drawImage(suscCv, 0, 0, canvas.width, canvas.height); ctx.globalAlpha = 1; }
      ctx.lineJoin = ctx.lineCap = 'round';
      if (state.cont) {
        ctx.strokeStyle = 'rgba(70,45,25,.38)'; ctx.lineWidth = .8; ctx.stroke(contours.thin);
        ctx.strokeStyle = 'rgba(70,45,25,.7)'; ctx.lineWidth = 1.5; ctx.stroke(contours.thick);
      }
      if (state.drain) {
        ctx.strokeStyle = '#1F6FB5';
        [1.1, 1.9, 3].forEach((w, k) => { ctx.lineWidth = w; ctx.stroke(drainPaths[k]); });
      }
      if (state.roads) roads.forEach(r => {
        const trace = () => { ctx.beginPath(); r.pts.forEach(([x, y], k) => k ? ctx.lineTo(x * SC, y * SC) : ctx.moveTo(x * SC, y * SC)); ctx.stroke(); };
        ctx.strokeStyle = '#3A2C22'; ctx.lineWidth = r.w * 2.1 + 2; trace();
        ctx.strokeStyle = '#FFF7E0'; ctx.lineWidth = r.w * 2.1; trace();
      });
      if (state.grid) {
        ctx.strokeStyle = 'rgba(15,42,51,.45)'; ctx.lineWidth = 1; ctx.setLineDash([6, 6]);
        const step = (1000 / CELL_M) * SC;
        for (let x = step; x < canvas.width; x += step) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke(); }
        for (let y = step; y < canvas.height; y += step) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke(); }
        ctx.setLineDash([]);
      }
      if (state.insar) insar.forEach(p => {
        ctx.beginPath(); ctx.arc(p.x * SC, p.y * SC, 4.2, 0, 6.283);
        ctx.fillStyle = velColor(p.v); ctx.fill(); ctx.strokeStyle = 'rgba(15,42,51,.85)'; ctx.lineWidth = 1.1; ctx.stroke();
      });
      $$('.mlegend [data-for]').forEach(el => { el.hidden = !state[el.dataset.for]; });
    }

    // ---- readout under the cursor ----
    const frame = $('#mapframe'), marker = $('#map-marker');
    const names = () => [T[lang]['ov.c1'], T[lang]['ov.c2'], T[lang]['ov.c3'], T[lang]['ov.c4']];
    function readAt(e) {
      const r = canvas.getBoundingClientRect();
      const fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
      if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return;
      const i = Math.min(GH - 1, Math.floor(fy * GH)) * GW + Math.min(GW - 1, Math.floor(fx * GW));
      $('#r-elev').textContent = `${Math.round(E[i])} m`;
      $('#r-slope').textContent = `${slope[i].toFixed(0)}°`;
      $('#r-susc').textContent = names()[classOf(score[i])];
      marker.hidden = false; marker.style.left = `${fx * 100}%`; marker.style.top = `${fy * 100}%`;
    }
    canvas.addEventListener('pointermove', readAt);
    canvas.addEventListener('pointerleave', () => { marker.hidden = true; ['r-elev', 'r-slope', 'r-susc'].forEach(id => { $('#' + id).textContent = '–'; }); });

    draw();
  })();

  applyLang(lang);   // run last so generated elements (sliders, legend, layers) are translated too
})();
