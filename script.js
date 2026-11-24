/* ============================================================================
   scrollcraft.js â€” Runtime completo + interaÃ§Ãµes da pÃ¡gina
   ========================================================================== */
(function (global) {
  'use strict';

  var reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  var fineMQ = matchMedia('(hover: hover) and (pointer: fine)');
  var smallMQ = matchMedia('(max-width: 860px)');
  var coarse = matchMedia('(hover: none) and (pointer: coarse)').matches;
  var isMobile = function () { return coarse || smallMQ.matches; };

  var clamp = function (x, a, b) { return x < a ? a : x > b ? b : x; };
  var clamp01 = function (x) { return clamp(x, 0, 1); };
  var smooth = function (x) { x = clamp01(x); return x * x * (3 - 2 * x); };
  var lerp = function (a, b, t) { return a + (b - a) * t; };

  function dwell(x, L) {
    if (!L) return x;
    L = clamp01(L);
    var c = x - 0.5;
    return (1 - L) * x + L * (4 * c * c * c + 0.5);
  }

  function lerpRate(el) {
    var v = parseFloat(el && el.getAttribute && el.getAttribute('data-sc-lerp'));
    return isNaN(v) || v <= 0 ? 0 : clamp(v, 0.02, 1);
  }

  function parseColor(str) {
    str = (str || '').trim();
    var m = str.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (m) {
      var h = m[1];
      if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    }
    m = str.match(/rgba?\(([^)]+)\)/i);
    if (m) {
      var p = m[1].split(/[,\s/]+/).filter(Boolean).map(parseFloat);
      return [p[0], p[1], p[2]];
    }
    return null;
  }

  function mixColor(a, b, t) {
    return 'rgb(' + Math.round(lerp(a[0], b[0], t)) + ',' +
                    Math.round(lerp(a[1], b[1], t)) + ',' +
                    Math.round(lerp(a[2], b[2], t)) + ')';
  }

  function splitText(el, mode) {
    if (el.__scSplit) return el.__scSplit;
    var text = el.textContent;
    var units = [];

    if (mode === 'chars' || mode === 'words') {
      var parts = mode === 'chars' ? Array.from(text) : text.split(/(\s+)/);
      el.textContent = '';
      parts.forEach(function (t) {
        if (/^\s+$/.test(t)) { el.appendChild(document.createTextNode(t)); return; }
        var mask = document.createElement('span');
        mask.className = 'sc-split';
        var inner = document.createElement('span');
        inner.className = 'sc-split__i';
        inner.textContent = t;
        mask.appendChild(inner);
        el.appendChild(mask);
        units.push(inner);
      });
    } else {
      var words = text.split(/\s+/).filter(Boolean);
      el.textContent = '';
      var probes = words.map(function (w, i) {
        var s = document.createElement('span');
        s.textContent = w;
        el.appendChild(s);
        if (i < words.length - 1) el.appendChild(document.createTextNode(' '));
        return s;
      });
      var lines = [], cur = null, lastTop = null;
      probes.forEach(function (s) {
        var top = s.offsetTop;
        if (lastTop === null || Math.abs(top - lastTop) > 1) { cur = []; lines.push(cur); lastTop = top; }
        cur.push(s.textContent);
      });
      el.textContent = '';
      lines.forEach(function (words, li) {
        var mask = document.createElement('span');
        mask.className = 'sc-split sc-split--line';
        var inner = document.createElement('span');
        inner.className = 'sc-split__i';
        inner.textContent = words.join(' ');
        mask.appendChild(inner);
        el.appendChild(mask);
        if (li < lines.length - 1) el.appendChild(document.createTextNode(' '));
        units.push(inner);
      });
    }
    el.classList.add('sc-is-split');
    el.__scSplit = units;
    return units;
  }

  function formatNum(v, template) {
    var decimals = 0;
    var dot = template.indexOf('.');
    if (dot > -1) decimals = template.length - dot - 1;
    var s = v.toFixed(decimals);
    if (/,/.test(template) || Math.abs(v) >= 10000) {
      var bits = s.split('.');
      bits[0] = bits[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
      s = bits.join('.');
    }
    return s;
  }

  function mount(root, opts) {
    root = typeof root === 'string' ? document.querySelector(root) : (root || document);
    opts = opts || {};

    var scListeners = [];
    var scDead = false;
    var scPointerFrame = 0;
    function on(type, fn, o) {
      addEventListener(type, fn, o);
      scListeners.push([type, fn, o]);
    }

    var acts = [];
    var worlds = [];
    var drifts = [];
    var playheads = [];
    var vh = innerHeight, vw = innerWidth;
    var y = 0;
    var progressBar = root.querySelector('[data-sc-progress]');
    var docEl = document.documentElement;

    var LERP = lerpRate(root.nodeType === 1 ? root : null) ||
               lerpRate(docEl) ||
               (opts.lerp > 0 ? clamp(opts.lerp, 0.02, 1) : 0) ||
               0.18;

    Array.prototype.forEach.call(root.querySelectorAll('[data-sc-act]'), function (el) {
      var device = el.getAttribute('data-sc-act') || 'flow';
      var pinned = device === 'scrub' || device === 'pin' || device === 'pan';
      var act = {
        el: el,
        device: device,
        pinned: pinned,
        span: parseFloat(el.getAttribute('data-sc-span')) || (pinned ? 1.5 : 0),
        dwell: parseFloat(el.getAttribute('data-sc-dwell')) || 0,
        p: 0, raw: 0, top: 0, height: 0, live: false,
        cues: [], parallax: [], reveals: [], counts: [],
        rail: null
      };

      if (pinned) {
        act.stage = el.querySelector('[data-sc-stage]') || el.querySelector('.sc-stage');
        if (act.stage) act.stage.classList.add('sc-stage');
        el.classList.add('sc-act--pinned');
      }

      act.rail = el.querySelector('[data-sc-pan]');
      if (act.rail) act.railExtra = parseFloat(act.rail.getAttribute('data-sc-pan')) || 0;

      Array.prototype.forEach.call(el.querySelectorAll('[data-sc-cue]'), function (c) {
        var nums = (c.getAttribute('data-sc-cue') || '').trim().split(/\s+/).map(parseFloat);
        var cue = {
          el: c,
          from: isNaN(nums[0]) ? 0 : nums[0],
          to: nums.length > 1 && !isNaN(nums[1]) ? nums[1] : null,
          rIn: nums.length > 2 && !isNaN(nums[2]) ? clamp01(nums[2]) : 0.3,
          rOut: nums.length > 3 && !isNaN(nums[3]) ? clamp01(nums[3]) : null,
          rise: parseFloat(c.getAttribute('data-sc-rise')),
          kinetic: c.getAttribute('data-sc-kinetic'),
          units: null, state: -1
        };
        if (cue.rOut === null) cue.rOut = 0.3;
        if (isNaN(cue.rise)) cue.rise = 1;
        act.cues.push(cue);
      });

      Array.prototype.forEach.call(el.querySelectorAll('[data-sc-parallax]'), function (c) {
        act.parallax.push({ el: c, rate: parseFloat(c.getAttribute('data-sc-parallax')) || 0 });
      });

      Array.prototype.forEach.call(el.querySelectorAll('[data-sc-reveal]'), function (c) {
        var nums = (c.getAttribute('data-sc-reveal-at') || '0 0.5').trim().split(/\s+/).map(parseFloat);
        act.reveals.push({ el: c, dir: c.getAttribute('data-sc-reveal') || 'up', from: nums[0] || 0, to: nums[1] || 0.5 });
      });

      Array.prototype.forEach.call(el.querySelectorAll('[data-sc-count]'), function (c) {
        var nums = (c.getAttribute('data-sc-count') || '').trim().split(/\s+/);
        var at = (c.getAttribute('data-sc-count-at') || '0.1 0.55').trim().split(/\s+/).map(parseFloat);
        var num = function (s) { return parseFloat(String(s).replace(/,/g, '')) || 0; };
        act.counts.push({
          el: c, a: num(nums[0]), b: num(nums[1]),
          tpl: nums[1] || '0', from: at[0], to: at[1], last: null
        });
      });

      acts.push(act);

      var d = el.getAttribute('data-sc-drift');
      if (d) { var rgb = parseColor(d); if (rgb) drifts.push({ act: act, rgb: rgb }); }
    });

    var io = null;
    if ('IntersectionObserver' in window) {
      io = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) {
          if (!e.isIntersecting) return;
          var el = e.target;
          el.classList.add('sc-in');
          var stagger = parseFloat(el.getAttribute('data-sc-stagger'));
          if (!isNaN(stagger)) {
            Array.prototype.forEach.call(el.children, function (kid, i) {
              kid.style.transitionDelay = (i * stagger) + 'ms';
              kid.classList.add('sc-in');
            });
          }
          io.unobserve(el);
        });
      }, { rootMargin: '0px 0px -12% 0px', threshold: 0.01 });
      Array.prototype.forEach.call(root.querySelectorAll('[data-sc-in]'), function (el) { io.observe(el); });
    } else {
      Array.prototype.forEach.call(root.querySelectorAll('[data-sc-in]'), function (el) { el.classList.add('sc-in'); });
    }

    function layout() {
      if (scDead) return;
      vh = innerHeight; vw = innerWidth;
      acts.forEach(function (a) {
        if (a.pinned) a.el.style.height = (a.span * 100) + 'vh';
      });
      acts.forEach(function (a) {
        var r = a.el.getBoundingClientRect();
        a.top = r.top + scrollY;
        a.height = r.height;
      });
      read();
    }

    function read() {
      if (scDead) return;
      y = scrollY || pageYOffset;
      var driftA = null, driftB = null, driftT = 0;

      for (var i = 0; i < acts.length; i++) {
        var a = acts[i];
        var raw;
        if (a.pinned) {
          var travel = Math.max(a.height - vh, 1);
          raw = clamp01((y - a.top) / travel);
        } else {
          raw = clamp01((y + vh - a.top) / (a.height + vh));
        }
        a.raw = raw;
        a.p = a.dwell ? dwell(raw, a.dwell) : raw;
        a.live = (y > a.top - vh * 1.25) && (y < a.top + a.height + vh * 1.25);
        a.el.style.setProperty('--sc-p', a.p.toFixed(4));

        if (a.rail) {
          var panStart = a.top - vh * 0.42;
          var panEnd = a.top + a.height - vh * 0.58;
          var panP = clamp01((y - panStart) / Math.max(panEnd - panStart, 1));

          var over = a.rail.scrollWidth - vw;
          if (over > 0) {
            var extra = over * (a.railExtra || 0);
            a.rail.style.transform = 'translate3d(' + (-(over + extra) * panP).toFixed(2) + 'px,0,0)';
          }
          var railIdxEl = document.getElementById('rail-idx');
          if (railIdxEl) {
            var slideNum = clamp(Math.floor(panP * 5) + 1, 1, 5);
            railIdxEl.textContent = String(slideNum).padStart(2, '0');
          }
        }

        if (!a.live) {
          if (a.parked !== true) {
            for (var z = 0; z < a.cues.length; z++) {
              var pq = a.cues[z];
              pq.el.style.opacity = '0';
              pq.el.style.pointerEvents = 'none';
              pq.state = 0;
              if (pq.units) for (var zu = 0; zu < pq.units.length; zu++) pq.units[zu].style.opacity = '0';
            }
            a.parked = true;
          }
          continue;
        }
        a.parked = false;

        for (var c = 0; c < a.cues.length; c++) {
          var q = a.cues[c];
          var vis;
          if (q.to === null) {
            vis = smooth((a.p - q.from) / 0.18);
          } else {
            var win = Math.max(q.to - q.from, 0.001);
            var inEnd = q.from + win * q.rIn;
            var outStart = q.to - win * q.rOut;
            if (a.p < inEnd) vis = smooth((a.p - q.from) / Math.max(inEnd - q.from, 0.001));
            else if (a.p <= outStart) vis = 1;
            else vis = smooth(1 - (a.p - outStart) / Math.max(q.to - outStart, 0.001));
          }
          vis = clamp01(vis);

          if (q.kinetic) {
            if (!q.units) q.units = splitText(q.el, q.kinetic);
            var n = q.units.length;
            for (var u = 0; u < n; u++) {
              var uStart = (u / Math.max(n, 1)) * 0.62;
              var uv = clamp01((vis - uStart) / (1 - 0.62 + 0.001));
              uv = smooth(uv);
              q.units[u].style.opacity = uv.toFixed(3);
              q.units[u].style.transform = reduce ? 'none'
                : 'translate3d(0,' + ((1 - uv) * 100).toFixed(2) + '%,0)';
            }
            q.el.style.opacity = '1';
          } else {
            q.el.style.opacity = vis.toFixed(3);
            q.el.style.transform = reduce ? 'none'
              : 'translate3d(0,' + ((1 - vis) * 2.4 * q.rise).toFixed(2) + 'vh,0)';
          }
          var on = vis > 0.5;
          if (on !== (q.state === 1)) { q.state = on ? 1 : 0; q.el.style.pointerEvents = on ? 'auto' : 'none'; }
        }

        if (!reduce) {
          for (var pz = 0; pz < a.parallax.length; pz++) {
            var pp = a.parallax[pz];
            pp.el.style.transform = 'translate3d(0,' + (pp.rate * (a.p - 0.5) * 100).toFixed(2) + 'px,0)';
          }
        }

        for (var rv = 0; rv < a.reveals.length; rv++) {
          var R = a.reveals[rv];
          var t = smooth((a.p - R.from) / Math.max(R.to - R.from, 0.001));
          var pct = ((1 - t) * 100).toFixed(2);
          R.el.style.clipPath =
            R.dir === 'down' ? 'inset(' + pct + '% 0 0 0)' :
            R.dir === 'left' ? 'inset(0 ' + pct + '% 0 0)' :
            R.dir === 'right' ? 'inset(0 0 0 ' + pct + '%)' :
            R.dir === 'iris' ? 'circle(' + (t * 78).toFixed(2) + '% at 50% 50%)' :
                               'inset(0 0 ' + pct + '% 0)';
        }

        for (var ct = 0; ct < a.counts.length; ct++) {
          var K = a.counts[ct];
          var kt = smooth((a.p - K.from) / Math.max(K.to - K.from, 0.001));
          var val = lerp(K.a, K.b, kt);
          var out = formatNum(val, K.tpl);
          if (out !== K.last) { K.el.textContent = out; K.last = out; }
        }
      }

      for (var d = 0; d < drifts.length; d++) {
        var D = drifts[d];
        if (D.act.raw > 0 && D.act.raw < 1) {
          driftA = D; driftT = smooth(D.act.raw / 0.35);
          driftB = drifts[d - 1] || D;
          break;
        }
        if (D.act.raw >= 1) { driftA = D; driftB = D; driftT = 1; }
      }
      if (driftA) {
        docEl.style.setProperty('--sc-canvas', mixColor(driftB.rgb, driftA.rgb, driftT));
      }

      if (progressBar) {
        var max = Math.max(document.body.scrollHeight - vh, 1);
        progressBar.style.transform = 'scaleX(' + clamp01(y / max).toFixed(4) + ')';
      }
    }

    var tilts = [], magnets = [], spots = [];
    function initPointer() {
      if (reduce || !fineMQ.matches) return;
      Array.prototype.forEach.call(root.querySelectorAll('[data-sc-tilt]'), function (el) {
        tilts.push({ el: el, max: parseFloat(el.getAttribute('data-sc-tilt')) || 6, x: 0, ty: 0, tx: 0, y: 0 });
      });
      Array.prototype.forEach.call(root.querySelectorAll('[data-sc-magnet]'), function (el) {
        magnets.push({ el: el, k: parseFloat(el.getAttribute('data-sc-magnet')) || 0.3, x: 0, y: 0, tx: 0, ty: 0 });
      });
      Array.prototype.forEach.call(root.querySelectorAll('[data-sc-spotlight]'), function (el) {
        spots.push(el);
      });
      if (!tilts.length && !magnets.length && !spots.length) return;

      on('pointermove', function (e) {
        if (e.pointerType !== 'mouse') return;
        for (var i = 0; i < tilts.length; i++) {
          var T = tilts[i], r = T.el.getBoundingClientRect();
          if (r.bottom < -200 || r.top > vh + 200) { T.tx = 0; T.ty = 0; continue; }
          var nx = (e.clientX - (r.left + r.width / 2)) / (r.width / 2);
          var ny = (e.clientY - (r.top + r.height / 2)) / (r.height / 2);
          var inside = Math.abs(nx) < 1.6 && Math.abs(ny) < 1.6;
          T.tx = inside ? clamp(ny, -1, 1) * -T.max : 0;
          T.ty = inside ? clamp(nx, -1, 1) * T.max : 0;
        }
        for (var m = 0; m < magnets.length; m++) {
          var M = magnets[m], mr = M.el.getBoundingClientRect();
          var dx = e.clientX - (mr.left + mr.width / 2);
          var dy = e.clientY - (mr.top + mr.height / 2);
          var near = Math.abs(dx) < mr.width && Math.abs(dy) < mr.height * 2.5;
          M.tx = near ? dx * M.k : 0;
          M.ty = near ? dy * M.k : 0;
        }
        for (var s = 0; s < spots.length; s++) {
          var sr = spots[s].getBoundingClientRect();
          spots[s].style.setProperty('--sc-mx', clamp01((e.clientX - sr.left) / sr.width).toFixed(3));
          spots[s].style.setProperty('--sc-my', clamp01((e.clientY - sr.top) / sr.height).toFixed(3));
        }
      }, { passive: true });

      (function pointerTick() {
        if (scDead) return;
        for (var i = 0; i < tilts.length; i++) {
          var T = tilts[i];
          T.x += (T.tx - T.x) * 0.09; T.y += (T.ty - T.y) * 0.09;
          if (Math.abs(T.x) > 0.001 || Math.abs(T.y) > 0.001) {
            T.el.style.transform = 'perspective(1100px) rotateX(' + T.x.toFixed(3) + 'deg) rotateY(' + T.y.toFixed(3) + 'deg)';
          }
        }
        for (var m = 0; m < magnets.length; m++) {
          var M = magnets[m];
          M.x += (M.tx - M.x) * 0.12; M.y += (M.ty - M.y) * 0.12;
          M.el.style.transform = 'translate3d(' + M.x.toFixed(2) + 'px,' + M.y.toFixed(2) + 'px,0)';
        }
        scPointerFrame = requestAnimationFrame(pointerTick);
      })();
    }

    var ticking = false;
    on('scroll', function () {
      if (scDead) return;
      if (!ticking) { ticking = true; requestAnimationFrame(function () { if (!scDead) read(); ticking = false; }); }
    }, { passive: true });

    on('focusin', function (e) {
      var el = e.target;
      if (!el || !el.closest) return;
      var act = el.closest('[data-sc-act]');
      if (!act || !root.contains(act)) return;
      var cue = el.closest('[data-sc-cue]');
      if (!cue) return;
      if (parseFloat(getComputedStyle(cue).opacity || '1') > 0.85) return;
      el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    });

    var lastW = innerWidth;
    on('resize', function () {
      if (scDead) return;
      if (innerWidth === lastW && isMobile()) { vh = innerHeight; return; }
      lastW = innerWidth;
      layout();
    }, { passive: true });

    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(function () {
        if (scDead) return;
        acts.forEach(function (a) { a.cues.forEach(function (q) { if (q.kinetic && q.units) { q.el.__scSplit = null; q.units = null; } }); });
        layout();
      });
    }

    layout();
    initPointer();
    document.documentElement.classList.add('sc-ready');

    var api = { layout: layout, read: read, acts: acts, worlds: worlds, clips: playheads, lerp: LERP };
    api.destroy = function () {
      if (scDead) return;
      scDead = true;
      for (var i = 0; i < scListeners.length; i++) {
        removeEventListener(scListeners[i][0], scListeners[i][1], scListeners[i][2]);
      }
      scListeners.length = 0;
      if (scPointerFrame) cancelAnimationFrame(scPointerFrame);
      if (io) io.disconnect();
    };
    global.ScrollCraft.instances.push(api);
    return api;
  }

  global.ScrollCraft = { mount: mount, reduce: reduce, instances: [] };
})(window);

function initPage() {
  var sc = ScrollCraft.mount(document);
  window.addEventListener('load', function () { sc.layout(); });

  var btn = document.getElementById('promise-btn');
  var secret = document.getElementById('promise-secret');
  if (btn && secret) {
    btn.addEventListener('click', function () {
      secret.classList.add('is-open');
      btn.textContent = 'Promessa guardada â™¥';
    });
  }
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', initPage);
} else {
  initPage();
}
