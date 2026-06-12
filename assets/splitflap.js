/* ──────────────────────────────────────────────────────────────────────────
   splitflap.js — "The Lottery" Solari split-flap headline engine
   waynecolt.com · shared static asset · one engine, many boards.

   PROVENANCE / ENGINE REUSE (ported from the Solari split-flap clock prototype):
     · RING + ringSeq(cur,target): forward-only leaf stepping. The clock advanced
       A→Z→blank; here the ring is extended A→Z→0-9→_→-→symbols→blank so the
       leaf can ever-forward-roll to any normalized glyph.
     · Tile.flip(): the gravity-release falling-leaf with half-swap mid-flip.
       Ported verbatim in shape; CSS classes renamed sf-* and timing exposed.
     · Tile.sequence(): chained per-flap stepping with FLIP_GAP.
   ADAPTED FOR THE LOTTERY (new, not in the clock):
     · Per-board state machine: idle entry-landings → LOTTERY → jackpot → resume.
     · Headline word EXCLUDED from the random pool (only appears as the jackpot).
     · center-pad: leftPad=floor((N-L)/2), rightPad=ceil(...) with blank flaps.
     · FIRST PAINT: static real text → fast first resolve to headline (≤2s) → idle.
     · ONE shared rAF loop drives ALL boards (no per-flap setInterval storms).
     · a11y: real heading stays in DOM (visually-hidden); board aria-hidden.
       prefers-reduced-motion → static, no loop. IO + visibilitychange pause.
   ────────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';

  /* ── CONFIG (CD-spec defaults; data-attrs may override per board) ────────── */
  var FLIP_DUR   = 150;   // ms per single flap — keep in sync with CSS --sf-flip
  var FLIP_GAP   = 14;    // ms between consecutive flaps on one tile
  var ENTRY_HOLD = 1200;  // ms to display a settled corpus entry (1.2s)
  var JACK_HOLD  = 7000;  // ms to hold the jackpot headline (7s)
  var FIRST_HOLD = 1600;  // ms to hold the first resolve before idle begins
  var R_MIN      = 3, R_MAX = 5;  // entry-landings before LOTTERY
  var FIRST_MAXMS = 2000; // first resolve must be legible within ~2s

  /* ── RING: forward-only glyph order. blank LAST so a leaf rolls A..→blank. ── */
  var LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  var DIGITS  = '0123456789';
  var WORDSEP = '_-';
  var SYMS    = '×∏λ=<>+·/';        // symbols rendered in --optic during rolls
  var BLANK   = ' ';
  var RING    = (LETTERS + DIGITS + WORDSEP + SYMS + BLANK).split('');
  var RING_IX = {}; RING.forEach(function (c, i) { RING_IX[c] = i; });
  var SYM_SET = {}; (SYMS).split('').forEach(function (c) { SYM_SET[c] = 1; });

  /* ── NORMALIZATION: uppercase, charset A-Z0-9_- plus symbols; strip others ── */
  var OKCHAR = {};
  (LETTERS + DIGITS + WORDSEP + SYMS).split('').forEach(function (c) { OKCHAR[c] = 1; });
  function normChar(ch) {
    ch = ch.toUpperCase();
    return OKCHAR[ch] ? ch : '';
  }
  function normWord(w) {
    var out = '';
    for (var i = 0; i < w.length; i++) { var c = normChar(w[i]); if (c) out += c; }
    return out;
  }

  /* ── CORPUS (firewalled, public-safe; built by build_corpus.py) ──────────── */
  /* extracted 274 · dropped 152 · shipped 90 · firewall leaks 0 */
  var CORPUS = ["ACR","AGI","ANN","API","ARC","AWS","CDN","CLI","CVT","DCT","DNS","DPO","DSP","FFT","FTS","GPU","IVF","JWT","LLM","LSH","LTE","MCP","MOE","NPU","OCR","OSS","OTA","RAG","RAM","RTX","SDK","SFT","SHA","SMS","SNR","SOC","SQL","SSE","SSH","STT","TLS","TPU","TTS","TTT","URL","VLM","VPN","VPU","BM25","CUDA","GGUF","HNSW","LORA","OFDM","TOPS","VLLM","VRAM","FAISS","LOCAL","NIXOS","OAUTH","PHASH","POSIX","QLORA","REACT","SQLITE","COMPUTE","DISTILL","FASTAPI","FASTIFY","LATENCY","SYSTEMD","ESCALATE","FALLBACK","PIPELINE","QUANTIZE","ARC-AGI-3","COMMODITY","EMBEDDING","INFERENCE","SWE-BENCH","TAILSCALE","TELEMETRY","WEBSOCKET","WIREGUARD","CLOUDFLARE","CONVERGENT","THROUGHPUT","OPEN-SOURCE","MODELCASCADE"];

  /* ── HELPERS ─────────────────────────────────────────────────────────────── */
  function mk(tag, cls) { var e = document.createElement(tag); if (cls) e.className = cls; return e; }
  function randInt(a, b) { return a + Math.floor(Math.random() * (b - a + 1)); }
  function ringIndex(ch) { var i = RING_IX[ch]; return (i == null) ? RING.length - 1 : i; }

  /* forward-only number of single-flaps to step cur → target through the ring */
  function ringSeq(cur, target) {
    var i = ringIndex(cur), t = ringIndex(target), seq = [], guard = 0;
    while (i !== t && guard++ < RING.length) { i = (i + 1) % RING.length; seq.push(RING[i]); }
    return seq;
  }

  /* center-pad a word of length L into N flaps: blanks left/right ───────────── */
  function padCenter(word, N) {
    var L = word.length;
    if (L >= N) return word.slice(0, N).split('');
    var leftPad = Math.floor((N - L) / 2);
    var rightPad = N - L - leftPad;   // == ceil((N-L)/2)
    var arr = [];
    for (var i = 0; i < leftPad; i++) arr.push(BLANK);
    for (var j = 0; j < L; j++) arr.push(word[j]);
    for (var k = 0; k < rightPad; k++) arr.push(BLANK);
    return arr;
  }

  /* ── TILE: one flap leaf (ported from the clock's Tile class) ────────────── */
  function Tile(parent) {
    this.cur = BLANK;
    this.busy = false;
    this.outer = mk('div', 'sf-to');
    this.inner = mk('div', 'sf-ti');
    this.topH = this._half('t');
    this.botH = this._half('b');
    this.inner.appendChild(this.topH);
    this.inner.appendChild(this.botH);
    this.outer.appendChild(this.inner);
    this.outer.appendChild(mk('div', 'sf-div'));
    parent.appendChild(this.outer);
  }
  Tile.prototype._half = function (side) {
    var h = mk('div', 'sf-h ' + side);
    h.appendChild(mk('span', 'sf-ltr'));
    return h;
  };
  Tile.prototype._ltr = function (half) { return half.firstChild; };
  Tile.prototype._optic = function (on) {
    if (on) this.outer.classList.add('sf-optic'); else this.outer.classList.remove('sf-optic');
  };
  Tile.prototype.jackpot = function (on) {
    if (on) this.outer.classList.add('sf-jackpot'); else this.outer.classList.remove('sf-jackpot');
  };
  Tile.prototype.show = function (ch) {
    this.cur = ch;
    var v = (ch === BLANK) ? ' ' : ch;
    this._ltr(this.topH).textContent = v;
    this._ltr(this.botH).textContent = v;
    this._optic(!!SYM_SET[ch]);
  };

  /* one flap: gravity-release a leaf showing [next], swap halves, land.
     `fast` shortens the leaf duration for the first-resolve budget (≤2s). */
  Tile.prototype.flip = function (next, done, fast) {
    if (this.busy) { if (done) done(); return; }
    this.busy = true;
    var self = this;
    var v = (next === BLANK) ? ' ' : next;

    var flap = mk('div', 'sf-flap');
    if (SYM_SET[next]) flap.classList.add('sf-optic');
    var dur = fast ? 46 : FLIP_DUR;
    var fc = mk('span', 'sf-ltr');
    fc.textContent = v;
    flap.appendChild(fc);
    this.outer.appendChild(flap);
    void flap.getBoundingClientRect();

    flap.style.transition = 'transform ' + dur + 'ms cubic-bezier(0.30,0,0.16,1)';
    flap.style.transform = 'rotateX(0deg)';

    setTimeout(function () { self._ltr(self.botH).textContent = v; }, dur * 0.5);

    setTimeout(function () {
      if (flap.parentNode) flap.parentNode.removeChild(flap);
      self._ltr(self.topH).textContent = v;
      self.cur = next;
      self._optic(!!SYM_SET[next]);
      self.busy = false;
      if (done) done();
    }, dur + 8);
  };

  Tile.prototype.sequence = function (chars, onDone, fast) {
    var self = this, i = 0;
    var gap = fast ? 2 : FLIP_GAP;
    (function step() {
      if (i >= chars.length) { if (onDone) onDone(); return; }
      self.flip(chars[i++], function () { setTimeout(step, gap); }, fast);
    })();
  };

  /* drive all flaps of a board to `targetArr`; callback when ALL land.
     `fast` (first-resolve) shortens leaf duration AND caps each tile's visible
     ring run to FAST_CAP steps so the headline is legible within the ≤2s budget. */
  var FAST_CAP = 7;
  function rollBoard(tiles, targetArr, onAll, fast) {
    var landed = 0, N = tiles.length;
    if (N === 0) { if (onAll) onAll(); return; }
    tiles.forEach(function (t, k) {
      t.busy = false;
      var seq = ringSeq(t.cur, targetArr[k]);
      if (fast && seq.length > FAST_CAP) {
        /* snap-near the target, then roll the last FAST_CAP leaves for feel */
        var snapTo = seq[seq.length - FAST_CAP - 1];
        t.show(snapTo);
        seq = seq.slice(seq.length - FAST_CAP);
      }
      if (seq.length === 0) { if (++landed === N && onAll) onAll(); }
      else t.sequence(seq, function () { if (++landed === N && onAll) onAll(); }, fast);
    });
  }

  /* ── BOARD: one headline word, a state machine over the shared loop ──────── */
  function Board(host) {
    this.host = host;
    this.word = normWord(host.getAttribute('data-sf-word') || host.textContent || '');
    this.N = this.word.length;
    this.lockAfterFirstHit = host.getAttribute('data-sf-lock') === 'true';
    this.startDelay = parseInt(host.getAttribute('data-sf-delay') || '0', 10) || 0;

    /* eligible pool: corpus entries with len ≤ N, excluding the headline word */
    var self = this;
    this.pool = CORPUS.filter(function (w) {
      return w.length <= self.N && w !== self.word;
    });

    /* build the visible board */
    this.board = mk('div', 'sf-board');
    this.board.setAttribute('aria-hidden', 'true');
    this.tiles = [];
    for (var i = 0; i < this.N; i++) this.tiles.push(new Tile(this.board));
    this.tiles.forEach(function (t) { t.show(BLANK); });

    /* state */
    this.phase = 'init';     // init | first | idle-roll | entry-hold | lottery | jackpot
    this.entriesSinceJack = 0;
    this.targetR = randInt(R_MIN, R_MAX);
    this.nextAt = 0;         // ms timestamp on the shared clock for the next transition
    this.animating = false;
    this.paused = false;
    this.done = false;
  }

  /* pick the headline target padded to N flaps */
  Board.prototype._headlineTarget = function () { return padCenter(this.word, this.N); };
  /* pick a random eligible entry, center-padded */
  Board.prototype._entryTarget = function () {
    if (this.pool.length === 0) return null; // N=2 IS board: symbol-dominant idle
    var w = this.pool[Math.floor(Math.random() * this.pool.length)];
    return { word: w, arr: padCenter(w, this.N) };
  };
  /* a symbol-flush target (used when pool is empty — proves the IS board works) */
  Board.prototype._symbolTarget = function () {
    var arr = [];
    for (var i = 0; i < this.N; i++) {
      arr.push(Math.random() < 0.6 ? SYMS[Math.floor(Math.random() * SYMS.length)] : BLANK);
    }
    return arr;
  };

  /* FIRST PAINT fast resolve to headline (legible ≤2s). */
  Board.prototype.firstResolve = function (now) {
    this.phase = 'first';
    this.animating = true;
    var self = this;
    rollBoard(this.tiles, this._headlineTarget(), function () {
      self.animating = false;
      self.nextAt = now() + FIRST_HOLD;
      self.phase = 'first-hold';
    }, true);  // fast first resolve
  };

  Board.prototype.jackpotFlush = function (now) {
    this.phase = 'jackpot';
    this.animating = true;
    var self = this;
    rollBoard(this.tiles, this._headlineTarget(), function () {
      /* flush letters optic left→right with soft glow */
      var L = self.tiles, k = 0;
      (function glow() {
        if (k < L.length) {
          if (L[k].cur !== BLANK) L[k].jackpot(true);
          k++; setTimeout(glow, 55);
        }
      })();
      self.animating = false;
      self.entriesSinceJack = 0;
      self.targetR = randInt(R_MIN, R_MAX);
      if (self.lockAfterFirstHit) { self.done = true; self.phase = 'locked'; return; }
      self.nextAt = now() + JACK_HOLD;
      self.phase = 'jack-hold';
    });
  };

  Board.prototype.rollEntry = function (now) {
    var self = this;
    /* clear any lingering jackpot glow before an idle roll */
    this.tiles.forEach(function (t) { t.jackpot(false); });
    var tgt = this._entryTarget();
    if (!tgt) { /* empty pool → symbol churn, then count it as a landing */
      this.animating = true;
      rollBoard(this.tiles, this._symbolTarget(), function () {
        self.animating = false;
        self.entriesSinceJack++;
        self.nextAt = now() + ENTRY_HOLD;
        self.phase = 'entry-hold';
      });
      return;
    }
    this.animating = true;
    rollBoard(this.tiles, tgt.arr, function () {
      self.animating = false;
      self.entriesSinceJack++;
      self.nextAt = now() + ENTRY_HOLD;
      self.phase = 'entry-hold';
    });
  };

  /* per-tick state advance — called by the shared loop. */
  Board.prototype.tick = function (now) {
    if (this.done || this.paused || this.animating) return;
    var t = now();
    if (this.phase === 'init') {
      if (t >= this.nextAt) this.firstResolve(now);
      return;
    }
    if (t < this.nextAt) return;  // still holding

    if (this.phase === 'first-hold' || this.phase === 'entry-hold' || this.phase === 'jack-hold') {
      if (this.entriesSinceJack >= this.targetR) this.jackpotFlush(now);
      else this.rollEntry(now);
    }
  };

  Board.prototype.start = function (now) {
    this.nextAt = now() + this.startDelay;  // staggered top→bottom via data-sf-delay
  };

  /* ── ENGINE: one shared loop driving all boards ──────────────────────────────
     PROGRESSIVE ENHANCEMENT CONTRACT:
       · The page ships the REAL heading VISIBLE (no-JS = a normal, correct heading).
       · A sibling .sf-mount wrapper holds empty board host(s), display:none by default
         (CSS: .sf-mount{display:none}). The wrapper carries data-sf-reveal.
       · On boot (motion ok), the engine: hides the real heading via .sf-vh (kept in
         DOM for a11y/SEO), reveals the .sf-mount, builds boards, runs ONE loop.
       · reduced-motion / no-JS / engine-bail: the real heading simply stays visible.   */
  function boot() {
    var hosts = [].slice.call(document.querySelectorAll('[data-sf-word]'));
    if (!hosts.length) return;

    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce) return;  // leave the real heading visible, no board churn

    var boards = [];

    hosts.forEach(function (host) {
      var b = new Board(host);
      host.textContent = '';
      host.appendChild(b.board);
      boards.push(b);
    });

    if (!boards.length) return;

    /* hide the real heading(s) now that boards are about to render, and reveal
       the mount. Each host names its real heading via data-sf-heading="#id". */
    hosts.forEach(function (host) {
      var sel = host.getAttribute('data-sf-heading');
      if (sel) { var h = document.querySelector(sel); if (h) h.classList.add('sf-vh'); }
    });
    [].slice.call(document.querySelectorAll('.sf-mount[data-sf-reveal]'))
      .forEach(function (m) { m.classList.add('sf-revealed'); });

    /* shared monotonic clock */
    var now = (window.performance && performance.now)
      ? function () { return performance.now(); }
      : function () { return Date.now(); };

    boards.forEach(function (b) { b.start(now); });

    /* IntersectionObserver: pause off-screen boards. */
    var io = null;
    if ('IntersectionObserver' in window) {
      io = new IntersectionObserver(function (ents) {
        ents.forEach(function (e) {
          var b = e.target.__sfBoard;
          if (b) b.paused = !e.isIntersecting;
        });
      }, { threshold: 0.01 });
      boards.forEach(function (b) { b.host.__sfBoard = b; io.observe(b.host); });
    }

    /* document visibility: pause hidden-tab churn (resumes where it left off). */
    var hidden = false;
    document.addEventListener('visibilitychange', function () {
      hidden = document.hidden;
    });

    /* ONE rAF loop. No per-flap timers beyond the leaf-animation setTimeouts. */
    var raf = window.requestAnimationFrame || function (cb) { return setTimeout(function () { cb(Date.now()); }, 16); };
    function loop() {
      if (!hidden) {
        for (var i = 0; i < boards.length; i++) boards[i].tick(now);
      }
      raf(loop);
    }
    raf(loop);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
