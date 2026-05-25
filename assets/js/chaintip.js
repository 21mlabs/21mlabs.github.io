/*
 * chaintip.js — renders the Bitcoin blockchain as a horizontal strip of block
 * tiles (a minimal, ASCII take on mempool.space's block view): fee rate, fee
 * range, fees, transaction count, age, and the block hash with its leading
 * zeros — the proof-of-work difficulty — drawn lighter. The block number sits
 * above each tile in bitcoin orange and links to the explorer. A bold arrow
 * between neighbours shows the older block's hash feeding the next.
 *
 * Scroll horizontally (left/right) over the strip, or drag it, to travel back
 * through history toward the genesis block. The strip is virtualized (only the
 * tiles near center exist in the DOM, positioned via transforms) and every
 * field comes from the same batch calls used to page the chain — so there are
 * no extra network requests. Source: mempool.space, falling back to
 * blockstream.info. No keys, no cookies, no third-party scripts.
 */
(function () {
  "use strict";

  var chain = document.getElementById("chain");
  var hint = document.getElementById("chain-hint");
  if (!chain) return;

  var EXPLORER = "https://blockstream.info/block/";

  var data = new Map();            // height -> normalized block
  var claimed = new Set();         // heights already fetched or in flight
  var cards = new Map();           // height -> card element

  var h0 = null;                   // newest height (the chain's right edge)
  var tipAt = 0;                   // when the tip was last fetched from the network
  var camHeight = 0;               // fractional height at the screen center
  var dragging = false;
  var startX = 0, startCam = 0;
  var pending = false;
  var reduceMotion = window.matchMedia
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  var vw, centerX, pitch, cardW, WIN;

  function setMetrics() {
    vw = chain.clientWidth || window.innerWidth;
    centerX = vw / 2;
    pitch = Math.max(224, Math.min(268, vw * 0.24));
    cardW = Math.max(166, Math.round(pitch - 58));
    WIN = Math.ceil(centerX / pitch) + 2;
    chain.style.setProperty("--pitch", pitch + "px");
    chain.style.setProperty("--card-w", cardW + "px");
  }

  function scheduleUpdate() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(function () { pending = false; if (h0 != null) update(); });
  }

  // ── formatting ─────────────────────────────────────────────────
  // Block subsidy (BTC) straight from the halving schedule — derivable from
  // height alone, so it's available even on the fallback source.
  function subsidy(h) { return 50 / Math.pow(2, Math.floor(h / 210000)); }

  // "key: value" — key (col 1) highlighted, value (col 2) quieter; aligned by
  // the box grid, gofmt-style.
  function row(title, value) {
    return '<span class="k">' + title + ':</span><span class="v">' + value + "</span>";
  }

  function ago(ts) {
    var s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
    if (s < 3600) return Math.floor(s / 60) + " min ago";
    if (s < 86400) return Math.floor(s / 3600) + " hr ago";
    if (s < 2592000) return Math.floor(s / 86400) + " days ago";
    if (s < 31536000) return Math.floor(s / 2592000) + " mo ago";
    return Math.floor(s / 31536000) + " yr ago";
  }

  // ── data ───────────────────────────────────────────────────────
  function okJson(r) { if (!r.ok) throw new Error(r.status); return r.json(); }

  function normalize(b) {
    var x = b.extras || {};
    var fr = x.feeRange;
    return {
      id: b.id,
      medianFee: x.medianFee,
      feeMin: fr && fr.length ? fr[0] : null,
      feeMax: fr && fr.length ? fr[fr.length - 1] : null,
      fees: x.totalFees,             // sats (absent on the blockstream fallback)
      txs: b.tx_count,
      ts: b.timestamp,
    };
  }

  // mempool.space returns 15 blocks ending at :start (newest first); the bare
  // endpoint returns the latest 15. blockstream.info is the fallback.
  function fetchBlocks(start) {
    var suffix = start == null ? "" : "/" + start;
    return fetch("https://mempool.space/api/v1/blocks" + suffix).then(okJson)
      .catch(function () {
        return fetch("https://blockstream.info/api/blocks" + suffix).then(okJson);
      });
  }

  function store(list) {
    list.forEach(function (b) {
      data.set(b.height, normalize(b));
      var c = cards.get(b.height);
      if (c) fill(c, b.height);
    });
    saveCache();
  }

  function fetchBatch(start) {
    var to = Math.max(0, start - 14);
    for (var h = to; h <= start; h++) claimed.add(h);
    fetchBlocks(start).then(function (list) {
      if (!Array.isArray(list)) throw new Error("bad response");
      store(list);
      // A source may return fewer than requested (blockstream's fallback gives
      // 10, not 15). Un-claim any height it didn't actually return so ensureData
      // can request it again with a covering start, then re-run to fill the gap.
      var gap = false;
      for (var g = to; g <= start; g++) if (!data.has(g)) { claimed.delete(g); gap = true; }
      if (gap) scheduleUpdate();
    }).catch(function () {
      for (var d = to; d <= start; d++) claimed.delete(d);  // allow retry
    });
  }

  function ensureData(lo, hi) {
    lo = Math.max(0, lo);
    var budget = 2;
    for (var h = hi; h >= lo && budget > 0; h--) {
      if (!data.has(h) && !claimed.has(h)) { fetchBatch(h); budget--; }
    }
  }

  // ── cards ──────────────────────────────────────────────────────
  function div(cls, parent) {
    var d = document.createElement("div");
    d.className = cls;
    parent.appendChild(d);
    return d;
  }

  function createCard(h) {
    var card = document.createElement("div");
    var tip = h === h0;                          // the chain tip — special block
    card.className = "card" + (h === 0 ? " no-prev" : "") + (tip ? " is-tip" : "");

    var arrow = document.createElement("span");
    arrow.className = "arrow";
    card.appendChild(arrow);

    var num = document.createElement("a");
    num.className = "num";
    num.target = "_blank";
    num.rel = "noopener noreferrer";
    num.textContent = "# " + h.toLocaleString("en-US");
    card.appendChild(num);

    var box = document.createElement("div");
    box.className = "box";
    var els = {
      num: num,
      fee: div("stat fee", box),
      fees: div("stat fees", box),
      subsidy: div("stat subsidy", box),
      txs: div("stat txs", box),
      age: div("stat age", box),
      hash: div("hash", box),
    };
    card.appendChild(box);
    card.__els = els;
    card.__box = box;

    if (data.has(h)) fill(card, h);
    else placeholder(els);

    chain.appendChild(card);
    cards.set(h, card);
    if (tip) startGlow();              // the tip is on screen — make it live
    return card;
  }

  // ── live tip glow: a random walk at random intervals, no fixed rhythm ──
  var GLOW_MIN = 0.32;             // floor — the tip always keeps a visible glow
  var glowOn = false, glowLevel = 0.6;
  function paintGlow(box) {
    var ring = (28 + glowLevel * 30).toFixed(0);     // 28%..58%
    var blur = (12 + glowLevel * 18).toFixed(0);     // 12px..30px
    var spread = (-10 + glowLevel * 6).toFixed(0);   // -10..-4
    box.style.boxShadow =
      "0 0 0 1px color-mix(in srgb, var(--accent) " + ring + "%, transparent), " +
      "0 0 " + blur + "px " + spread + "px var(--accent)";
  }
  function glowTick() {
    var card = cards.get(h0);
    if (!card) { glowOn = false; return; }           // tip left the DOM — pause
    glowLevel = Math.min(1, Math.max(GLOW_MIN, glowLevel + (Math.random() - 0.5) * 0.7));
    if (card.__box) paintGlow(card.__box);
    setTimeout(glowTick, 140 + Math.random() * 760);  // irregular cadence
  }
  function startGlow() {
    if (reduceMotion || glowOn || h0 == null) return;
    glowOn = true;
    glowTick();
  }

  function placeholder(els) {
    els.fee.innerHTML = row("Fee rate", "·");
    els.fees.innerHTML = row("Total fees", "·");
    els.subsidy.innerHTML = row("Subsidy", "·");
    els.txs.innerHTML = row("Transactions", "·");
    els.age.innerHTML = row("Age", "·");
    els.hash.textContent = "·";
  }

  function fill(card, h) {
    var d = data.get(h);
    var e = card.__els;

    e.fee.innerHTML = row("Fee rate", d.medianFee != null ? "~" + Math.round(d.medianFee) + " sat/vB" : "—");
    e.fees.innerHTML = row("Total fees", d.fees != null ? (d.fees / 1e8).toFixed(3) + " BTC" : "—");
    e.subsidy.innerHTML = row("Subsidy", subsidy(h) + " BTC");
    e.txs.innerHTML = row("Transactions", d.txs != null ? d.txs.toLocaleString("en-US") : "—");
    e.age.innerHTML = row("Age", d.ts ? ago(d.ts) : "—");

    var i = 0;                                  // leading-zero run = difficulty
    while (i < d.id.length && d.id[i] === "0") i++;
    e.hash.innerHTML = '<span class="z">' + d.id.slice(0, i) + "</span>" + d.id.slice(i);

    e.num.href = EXPLORER + d.id;
  }

  // Bound memory on long deep-scroll sessions: keep a generous band around the
  // camera (and always the tip); evict far entries — they're refetched if
  // revisited. The band dwarfs the render window, so no visible card is dropped.
  function prune() {
    if (data.size <= 3000) return;
    var lo = Math.floor(camHeight) - 1200, hi = Math.ceil(camHeight) + 1200;
    data.forEach(function (_, h) {
      if (h !== h0 && (h < lo || h > hi)) { data.delete(h); claimed.delete(h); }
    });
  }

  // ── render ─────────────────────────────────────────────────────
  function update() {
    camHeight = Math.max(0, Math.min(h0, camHeight));

    var lo = Math.max(0, Math.floor(camHeight) - WIN);
    var hi = Math.min(h0, Math.ceil(camHeight) + WIN);

    cards.forEach(function (card, h) {
      if (h < lo || h > hi) { chain.removeChild(card); cards.delete(h); }
    });
    for (var h = lo; h <= hi; h++) if (!cards.has(h)) createCard(h);

    ensureData(lo - 3, hi);

    cards.forEach(function (card, h) {
      var dd = h - camHeight;
      var ad = Math.abs(dd);
      var scale = Math.max(0.55, 1 - ad * 0.1);
      var opacity = Math.max(0.05, 1 - ad * 0.24);
      var left = centerX + dd * pitch - cardW / 2;
      card.style.transform = "translate(" + left + "px, -50%) scale(" + scale + ")";
      card.style.opacity = opacity;
      card.style.zIndex = String(1000 - Math.round(ad * 10));
      card.classList.toggle("is-center", ad < 0.5);
    });

    prune();
  }

  // ── refresh: pick up newly-mined blocks (~every 10 min) ────────
  function setTip(newTip) {
    var followed = camHeight >= h0 - 0.5;            // were we watching the tip?
    var old = cards.get(h0);
    if (old) { old.classList.remove("is-tip"); if (old.__box) old.__box.style.boxShadow = ""; }
    h0 = newTip;
    if (followed) camHeight = h0;                     // ride along to the new tip
    var fresh = cards.get(h0);
    if (fresh) { fresh.classList.add("is-tip"); startGlow(); }
    scheduleUpdate();
  }

  function refresh() {
    fetchBlocks(null).then(function (list) {
      if (!Array.isArray(list) || !list.length) return;   // malformed; next interval retries
      store(list);                                    // updates data + re-fills (ages too)
      list.forEach(function (b) { claimed.add(b.height); });
      tipAt = Date.now();
      var newTip = list[0].height;
      if (newTip > h0) setTip(newTip);
      else scheduleUpdate();                          // at least refresh on-screen ages
    }).catch(function () { /* try again next interval */ });
  }

  // ── interaction: horizontal wheel + touch/mouse drag with flick momentum ──
  var velocity = 0;            // blocks per ms, captured during a drag
  var lastT = 0, lastCam = 0, flingRAF = 0;

  function stopFling() { if (flingRAF) { cancelAnimationFrame(flingRAF); flingRAF = 0; } }

  function startFling() {      // carry the drag's momentum, decaying with friction
    if (h0 == null || Math.abs(velocity) < 0.0008) return;
    var prev = performance.now();
    function step(now) {
      var dt = Math.min(48, now - prev); prev = now;
      velocity *= Math.pow(0.95, dt / 16);
      camHeight += velocity * dt;
      if (camHeight <= 0) { camHeight = 0; velocity = 0; }
      else if (camHeight >= h0) { camHeight = h0; velocity = 0; }
      update();
      flingRAF = Math.abs(velocity) > 0.0008 ? requestAnimationFrame(step) : 0;
    }
    flingRAF = requestAnimationFrame(step);
  }

  // Horizontal wheel only (left/right). Vertical scroll is left to the page.
  chain.addEventListener("wheel", function (e) {
    if (h0 == null) return;
    var dx = e.deltaX || (e.shiftKey ? e.deltaY : 0);
    if (!dx) return;
    e.preventDefault();
    stopFling();
    camHeight += dx / pitch;                    // scroll left → older
    scheduleUpdate();
  }, { passive: false });

  chain.addEventListener("pointerdown", function (e) {
    if (h0 == null || (e.target.closest && e.target.closest("a.num"))) return;
    stopFling();
    dragging = true;
    startX = e.clientX;
    startCam = camHeight;
    lastT = performance.now();
    lastCam = camHeight;
    velocity = 0;
    chain.classList.add("dragging");
    chain.setPointerCapture(e.pointerId);
  });
  chain.addEventListener("pointermove", function (e) {
    if (!dragging) return;
    camHeight = startCam - (e.clientX - startX) / pitch;   // drag right → older
    var now = performance.now(), dt = now - lastT;
    if (dt > 0) { velocity = (camHeight - lastCam) / dt; lastT = now; lastCam = camHeight; }
    scheduleUpdate();
  });
  function endDrag() {
    if (!dragging) return;
    dragging = false;
    chain.classList.remove("dragging");
    startFling();                               // flick → momentum scroll
  }
  chain.addEventListener("pointerup", endDrag);
  chain.addEventListener("pointercancel", endDrag);

  window.addEventListener("resize", function () { setMetrics(); scheduleUpdate(); });

  // ── persistent cache ───────────────────────────────────────────
  // Block data is public, and below the tip it's immutable, so we keep a small
  // localStorage cache. Repeated reloads then cost ZERO requests while the
  // cached tip is fresh, and already-seen history is never refetched — which is
  // what keeps us comfortably under the explorers' rate limits.
  var CACHE_KEY = "21m.chain.v1";
  // Blocks land ~every 10 min, so a tip cached this recently is almost always
  // still current — no need to refetch on every reload. (Reload *spam* is
  // seconds apart, so it's cached regardless of this value.)
  var TIP_TTL = 300000;            // 5 min ≈ half a block interval
  var saveTimer = 0;

  function loadCache() {
    try {
      var c = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
      if (!c || !c.blocks) return null;
      Object.keys(c.blocks).forEach(function (h) {
        data.set(+h, c.blocks[h]);
        claimed.add(+h);           // already have it — don't refetch
      });
      return c;
    } catch (e) { return null; }
  }

  function saveCache() {
    if (saveTimer || h0 == null) return;
    saveTimer = setTimeout(function () {
      saveTimer = 0;
      try {
        var hs = Array.from(data.keys()).sort(function (a, b) { return b - a; }).slice(0, 1200);
        var blocks = {};
        hs.forEach(function (h) { blocks[h] = data.get(h); });
        localStorage.setItem(CACHE_KEY, JSON.stringify({ blocks: blocks, tipHeight: h0, tipAt: tipAt }));
      } catch (e) { /* private mode / quota exceeded — just skip */ }
    }, 1500);                       // throttle writes
  }

  // ── boot ───────────────────────────────────────────────────────
  setMetrics();

  function start(tip, at) {
    h0 = tip;
    tipAt = at;
    camHeight = h0;
    if (hint) hint.remove();
    update();
    saveCache();
    setInterval(refresh, 600000);          // ~every 10 min, the average block time
  }

  function boot() {
    fetchBlocks(null).then(function (list) {
      if (!Array.isArray(list) || !list.length) throw new Error("empty response");
      store(list);
      list.forEach(function (b) { claimed.add(b.height); });
      start(list[0].height, Date.now());
    }).catch(function () {
      if (data.size && cached && cached.tipHeight != null) {
        start(cached.tipHeight, cached.tipAt);     // show stale cache; don't hammer
      } else if (hint) {
        hint.textContent = "couldn't reach the chain — retrying…";
        setTimeout(boot, 30000);                    // single delayed retry, no reload loop
      }
    });
  }

  var cached = loadCache();
  if (cached && cached.tipHeight != null && data.has(cached.tipHeight) &&
      Date.now() - cached.tipAt < TIP_TTL) {
    start(cached.tipHeight, cached.tipAt);          // fresh enough → zero network calls
  } else {
    boot();
  }
})();
