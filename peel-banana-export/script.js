// Peel Banana — standalone export from Little Nook (originally
// js/minigames/peel.js). Plain script (no ES modules, no build step) so
// it drops into any page as-is via <script src="script.js">.
//
// USAGE
// -----
//   mountPeelBananaGame(container, { onEnd })
//     - container: any DOM element to mount the game into.
//     - onEnd(score): optional hook, called once per round with the integer
//       score just earned - purely informational (e.g. if a host page wants
//       to log it or award something of its own alongside it).
//
// NOTE - this version is NOT backend-free. Replaying, naming + saving a
// banana, and browsing the leaderboard are handled internally inside
// `container`, but the leaderboard itself is stored server-side (a text
// file on whatever host serves this page), not in localStorage. It reads
// and writes via:
//   GET  /banana/leaderboard          -> JSON array of saved entries
//   POST /banana/leaderboard {entry}  -> appends one entry, returns {ok}
// A host without those two routes will still let you play, but Save and
// the leaderboard view will silently fail / show empty. This is a step
// down in portability from the original all-client-side version, traded
// for a leaderboard that's shared across every visitor instead of being
// stuck in one browser's storage.
//
// Needs assets/peel-banana-whole.svg and assets/peel-banana-peeled.svg
// sitting alongside this file (see the ASSET_DIR path below) — both a
// thin body tapering to a rounded point top/bottom (not a plain
// cylinder), sized 20x64 so 3 equal-width vertical clip-path thirds line
// up with 3 actually-equal thirds of the banana itself.

(function () {
  'use strict';

  var ASSET_DIR = 'assets/';
  var WHOLE_URI = ASSET_DIR + 'peel-banana-whole.svg';
  var PEELED_URI = ASSET_DIR + 'peel-banana-peeled.svg';

  var PEEL_SECTIONS = 3;
  var BROWN_MIN = 0;
  var BROWN_MAX = 100;

  var LEADERBOARD_URL = '/banana/leaderboard';

  // Shared by both the per-section floating verdict and the overall end-of-
  // game rarity — ordered low-to-high; `max` is the top (inclusive) of this
  // tier's *freshness* range (100 - brownness). `score` is the [min,max]
  // point range this tier's *band* covers — a section's actual points are
  // interpolated continuously within its own tier's band by pointsFor()
  // below, not snapped to a fixed value, and the final score is just the
  // plain average of the 3 sections' own points. `glow` (0-4) scales a
  // colored halo (and a matching hue-rotate tint) derived from the tier's
  // own color, applied to top-end tiers so the rarest ones actually read as
  // rare at a glance.
  //
  // `max` values are constructed, not eyeballed: since freshness rolls as
  // 100*U^2 (U~Uniform(0,1)), P(freshness<=F) = sqrt(F/100), so picking a
  // target PER-SECTION percentage for every tier and taking its cumulative
  // sum S (as a fraction) gives an exact boundary via max = 100*S^2. Target
  // per-section shares: 5/10/40.81/18.14/11.34/6.80/3.97/2.27/1.13/0.45/0.1
  // (Rotten..Celestial) - Rotten/Crap were cut to 5%/10% and that freed-up
  // 10 points folded back into Common..Divine proportionally (each scaled
  // by the same 84.9/74.9 factor), so the *shape* above Crap is identical
  // to before, just uniformly more common. A natural-feeling decay, not a
  // strictly-enforced mathematical curve. The anchor: Celestial, the
  // rarest SLICE, is pinned at exactly 1-in-1000 (0.1%) per section - to
  // change it, rescale the other ten shares to still sum to 100.
  //
  // The OVERALL banana label - tierForFreshness((avg+best)/2) in endGame() -
  // is a different, non-closed-form distribution over the same rolls, and
  // the best-of-3 term biases it toward rarer classifications than any raw
  // per-section roll would suggest (simulated at N=8,000,000): Uncommon
  // (~34.1%) and Rare (~30.0%) actually edge out Common (~25.2%) now that
  // Common's own per-section share dropped relatively less than the tiers
  // just above it gained - fine, since the shape doesn't need to be
  // strictly monotonic, but worth knowing the label's peak isn't Common
  // anymore. The same compounding means Celestial's label chance is far
  // rarer than 1-in-1000: didn't land once in 8M trials. The 1-in-1000
  // anchor is about the per-section roll specifically, not the compound
  // label. Re-simulate before retuning any of this further.
  //
  // Only Rare and up glow, on a 1 (Rare, barely-there) to 7 (Celestial,
  // maximal) scale - each step up is a visibly bigger/more intense halo
  // and a stronger color tint (see buildBrownFilter below).
  var QUALITY_TIERS = [
    { key: 'rotten',    label: 'Rotten',    color: '#5c5c5c', max: 0.25,    score: [0, 8],     glow: 0 },
    { key: 'crap',      label: 'Crap',      color: '#8a8a8a', max: 2.25,    score: [5, 15],    glow: 0 },
    { key: 'common',    label: 'Common',    color: '#4A4038', max: 31.1436, score: [12, 25],   glow: 0 },
    { key: 'uncommon',  label: 'Uncommon',  color: '#3f8f4f', max: 54.6751, score: [20, 35],   glow: 0 },
    { key: 'rare',      label: 'Rare',      color: '#2f7bd1', max: 72.7229, score: [30, 50],   glow: 1 },
    { key: 'epic',      label: 'Epic',      color: '#9b3fd1', max: 84.7850, score: [45, 70],   glow: 2 },
    { key: 'mythic',    label: 'Mythic',    color: '#d1493f', max: 92.2485, score: [65, 95],   glow: 3 },
    { key: 'legendary', label: 'Legendary', color: '#d19a1a', max: 96.6546, score: [90, 130],  glow: 4 },
    { key: 'ascended',  label: 'Ascended',  color: '#1aa39a', max: 98.8963, score: [125, 170], glow: 5 },
    { key: 'divine',    label: 'Divine',    color: '#d1358f', max: 99.8001, score: [165, 220], glow: 6 },
    { key: 'celestial', label: 'Celestial', color: '#4fa8ff', max: 100,     score: [215, 300], glow: 7 },
  ];

  function tierForFreshness(freshness) {
    for (var i = 0; i < QUALITY_TIERS.length; i++) {
      if (freshness <= QUALITY_TIERS[i].max) return QUALITY_TIERS[i];
    }
    return QUALITY_TIERS[QUALITY_TIERS.length - 1];
  }

  // A section's points, interpolated linearly across its own tier's [min,max]
  // score band by where its freshness falls within that tier's freshness
  // range - so two sections landing in the same tier still score slightly
  // differently instead of both snapping to one fixed value.
  function pointsForFreshness(freshness) {
    var lower = 0;
    for (var i = 0; i < QUALITY_TIERS.length; i++) {
      var tier = QUALITY_TIERS[i];
      if (freshness <= tier.max) {
        var frac = tier.max === lower ? 1 : (freshness - lower) / (tier.max - lower);
        return tier.score[0] + frac * (tier.score[1] - tier.score[0]);
      }
      lower = tier.max;
    }
    var last = QUALITY_TIERS[QUALITY_TIERS.length - 1];
    return last.score[1];
  }

  // Skewed toward HIGH brownness values (squaring a uniform [0,1) roll
  // skews toward 0, so subtracting that from BROWN_MAX skews toward
  // BROWN_MAX instead) — most sections come up at least somewhat browned,
  // so a section staying genuinely fresh (needed for the rarest tiers) is
  // the rare, special case.
  function rollBrownness() {
    return BROWN_MAX - Math.pow(Math.random(), 2) * (BROWN_MAX - BROWN_MIN);
  }

  function hexToRgb(hex) {
    var num = parseInt(hex.replace('#', ''), 16);
    return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
  }

  function hexToHue(hex) {
    var rgb = hexToRgb(hex);
    var r = rgb.r / 255, g = rgb.g / 255, b = rgb.b / 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b);
    var d = max - min;
    if (d === 0) return 0;
    var h;
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    return h < 0 ? h + 360 : h;
  }

  // Roughly where a browser's sepia(1) filter lands a pale/cream source
  // pixel on the hue wheel — used as the zero-point for hue-rotate() so a
  // rotation lands on the TARGET tier color rather than an arbitrary spin.
  var SEPIA_BASE_HUE = 35;

  // 0 brownness = the peeled banana's normal pale color unchanged; 100
  // pushes it toward a deeply browned/bruised look. If `tier.glow` is set
  // (Rare and up), the whole section is additionally hue-rotated to match
  // that tier's own color — same halo color as the glow, just tinting the
  // banana itself instead of just haloing it — and gets a colored
  // drop-shadow halo on top, since an inline `filter` style replaces (not
  // adds to) a CSS class's value so both effects have to live in one string.
  function buildBrownFilter(amt, tier) {
    var t = amt / 100;
    var glow = tier && tier.glow;
    var filter = 'sepia(' + t.toFixed(2) + ')';
    if (glow) {
      var rotate = Math.round(hexToHue(tier.color) - SEPIA_BASE_HUE);
      filter += ' hue-rotate(' + rotate + 'deg)';
    }
    filter += ' saturate(' + (1 + t * 0.4 + (glow ? tier.glow * 0.15 : 0)).toFixed(2) +
      ') brightness(' + (1 - t * 0.28).toFixed(2) + ') drop-shadow(0 4px 4px rgba(0,0,0,0.2))';
    if (glow) {
      var rgb = hexToRgb(tier.color);
      var rgbStr = rgb.r + ',' + rgb.g + ',' + rgb.b;
      var s = tier.glow;
      filter += ' drop-shadow(0 0 ' + (3 + s) + 'px rgba(' + rgbStr + ',' + Math.min(0.95, 0.55 + s * 0.1).toFixed(2) + '))';
      if (s >= 2) {
        filter += ' drop-shadow(0 0 ' + (6 + s * 3) + 'px rgba(' + rgbStr + ',' + Math.min(0.8, 0.3 + s * 0.1).toFixed(2) + '))';
      }
    }
    return filter;
  }

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
  }

  function loadLeaderboard() {
    return fetch(LEADERBOARD_URL)
      .then(function (res) { return res.ok ? res.json() : []; })
      .catch(function () { return []; });
  }

  function saveLeaderboardEntry(entry) {
    return fetch(LEADERBOARD_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(entry),
    })
      .then(function (res) { return res.ok; })
      .catch(function () { return false; });
  }

  // Small non-interactive rendering of a fully-peeled banana using that
  // save's own per-section brownness, so every leaderboard/end-screen
  // thumbnail looks like the actual banana that earned its score - not a
  // generic icon.
  function buildMiniBananaHtml(brownness) {
    var html = '<div class="peel-mini-banana">';
    for (var i = 0; i < brownness.length; i++) {
      var leftPct = (i / brownness.length) * 100;
      var rightPct = 100 - ((i + 1) / brownness.length) * 100;
      var tier = tierForFreshness(100 - brownness[i]);
      html +=
        '<div class="peel-mini-section" style="clip-path: inset(0 ' + rightPct + '% 0 ' + leftPct + '%);">' +
          '<img src="' + PEELED_URI + '" style="filter: ' + buildBrownFilter(brownness[i], tier) + ';" alt="">' +
        '</div>';
    }
    html += '</div>';
    return html;
  }

  function mountPeelBananaGame(container, opts) {
    var onEnd = opts && opts.onEnd ? opts.onEnd : function () {};

    // Space bar: peels the next un-peeled section left-to-right while a
    // round is active, or triggers "Play again" from the end screen. Each
    // render* function below re-points these so the one global listener
    // always does the right thing for whatever's currently showing - and
    // backs off entirely while a text field (the name input) has focus, so
    // typing a literal space into your banana's name still works normally.
    var mode = 'game';
    var peelNextFn = null;
    var playAgainFn = null;

    document.addEventListener('keydown', function (e) {
      if (e.code !== 'Space' && e.key !== ' ') return;
      var active = document.activeElement;
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) return;
      if (mode === 'game' && peelNextFn) {
        e.preventDefault();
        peelNextFn();
      } else if (mode === 'end' && playAgainFn) {
        e.preventDefault();
        playAgainFn();
      }
    });

    renderGame();

    // ---------------- Peeling round ----------------
    function renderGame() {
      mode = 'game';
      playAgainFn = null;
      // Rolled once per playthrough, before a single click happens — the
      // banana's fate (and its rarity) is already sealed, just not visible yet.
      var brownness = [];
      for (var b = 0; b < PEEL_SECTIONS; b++) brownness.push(rollBrownness());
      var sectionTiers = brownness.map(function (br) { return tierForFreshness(100 - br); });

      // Skin comes BEFORE flesh in the DOM (z-index still puts it visually
      // on top) so the CSS sibling combinator `.peel-section:hover +
      // .peel-flesh-section` can target the flesh immediately after it -
      // that's what lets hovering (or peeling) one specific section reveal
      // just that section's own glow, not all of them.
      var sectionsHtml = '';
      for (var i = 0; i < PEEL_SECTIONS; i++) {
        var leftPct = (i / PEEL_SECTIONS) * 100;
        var rightPct = 100 - ((i + 1) / PEEL_SECTIONS) * 100;
        var clip = 'clip-path: inset(0 ' + rightPct + '% 0 ' + leftPct + '%);';
        sectionsHtml +=
          '<div class="peel-section" data-section="' + i + '" style="' + clip + '">' +
            '<img src="' + WHOLE_URI + '" alt="">' +
          '</div>' +
          '<div class="peel-flesh-section" style="' + clip + '">' +
            '<img src="' + PEELED_URI + '" style="filter: ' + buildBrownFilter(brownness[i], sectionTiers[i]) + ';" alt="">' +
          '</div>';
      }

      container.innerHTML =
        '<div class="game-hud">' +
          '<span>🍌 Peeled: <span id="peel-count">0</span>/' + PEEL_SECTIONS + '</span>' +
          '<button class="link-btn" id="peel-leaderboard-link">🏆 Leaderboard</button>' +
        '</div>' +
        '<div class="game-stage peel-stage" id="peel-stage">' +
          '<div class="peel-banana-wrap" id="peel-banana">' + sectionsHtml + '</div>' +
        '</div>' +
        '<p style="font-size:12px;color:var(--ink-soft);margin-top:6px;">Click each section of the banana to peel it (or press space) - left to right. No rush - take your time.</p>';

      container.querySelector('#peel-leaderboard-link').addEventListener('click', renderLeaderboard);

      var stage = container.querySelector('#peel-stage');
      var bananaWrap = container.querySelector('#peel-banana');
      var sections = Array.prototype.slice.call(container.querySelectorAll('.peel-section'));
      var countEl = container.querySelector('#peel-count');

      // .peel-section elements come out of querySelectorAll in DOM order,
      // which is also left-to-right (data-section 0, 1, 2 in that order) -
      // so the first one that isn't already .peeled is simply the next one
      // left-to-right. A real .click() reuses onSectionClick below as-is.
      peelNextFn = function () {
        for (var s = 0; s < sections.length; s++) {
          if (!sections[s].classList.contains('peeled')) {
            sections[s].click();
            return;
          }
        }
      };

      var peeledCount = 0;
      var running = true;

      // A little strip flies off from the clicked section toward a random
      // direction, for juice. Originates from that section's own horizontal
      // center (left/middle/right third), not always the banana's center.
      function spawnPeelBit(originXPct) {
        var bit = document.createElement('div');
        bit.className = 'peel-strip-bit';
        bit.style.left = originXPct + '%';
        var angle = -90 + (Math.random() * 140 - 70); // mostly upward, some spread
        var dist = 40 + Math.random() * 18;
        bit.style.setProperty('--peel-dx', (Math.cos((angle * Math.PI) / 180) * dist) + 'px');
        bit.style.setProperty('--peel-dy', (Math.sin((angle * Math.PI) / 180) * dist) + 'px');
        bit.style.setProperty('--peel-rot', (Math.random() * 360 - 180) + 'deg');
        bananaWrap.appendChild(bit);
        bit.addEventListener('animationend', function () { bit.remove(); });
      }

      // Floats a short-lived quality-tier verdict up from the section that
      // was just peeled, color-coded by tier — this is that section's own
      // reading, separate from (and not necessarily matching) the overall
      // rarity you only find out once all 3 are peeled.
      function spawnQualityLabel(originXPct, tier) {
        var label = document.createElement('div');
        label.className = 'peel-quality-label';
        label.style.left = originXPct + '%';
        label.style.color = tier.color;
        label.textContent = tier.label;
        bananaWrap.appendChild(label);
        label.addEventListener('animationend', function () { label.remove(); });
      }

      // Floats this specific slice's own point value for a couple seconds -
      // separate from the tier-name label above (own position, own timing)
      // so a player can read the actual number, not just the rarity word.
      function spawnPointsLabel(originXPct, points) {
        var label = document.createElement('div');
        label.className = 'peel-points-label';
        label.style.left = originXPct + '%';
        label.textContent = '+' + points + ' pts';
        bananaWrap.appendChild(label);
        label.addEventListener('animationend', function () { label.remove(); });
      }

      function onSectionClick(e) {
        if (!running) return;
        var el = e.currentTarget;
        if (el.classList.contains('peeled')) return;
        el.classList.add('peeled');
        peeledCount++;
        countEl.textContent = peeledCount;

        var i = Number(el.dataset.section);
        // Peels off sideways, away from the banana's own center — the left
        // third slides left, the right third slides right.
        var dir = i - (PEEL_SECTIONS - 1) / 2;
        el.style.setProperty('--peel-out-x', (dir * 22) + 'px');
        el.style.setProperty('--peel-out-rot', (dir * 18) + 'deg');
        var centerXPct = ((i + 0.5) / PEEL_SECTIONS) * 100;
        spawnPeelBit(centerXPct);
        spawnQualityLabel(centerXPct, sectionTiers[i]);
        spawnPointsLabel(centerXPct, Math.round(pointsForFreshness(100 - brownness[i])));
        if (bananaWrap.animate) {
          bananaWrap.animate(
            [{ transform: 'scale(1)' }, { transform: 'scale(1.1)' }, { transform: 'scale(1)' }],
            { duration: 200, easing: 'ease-out' }
          );
        }

        if (peeledCount >= PEEL_SECTIONS) endGame();
      }
      sections.forEach(function (el) { el.addEventListener('click', onSectionClick); });

      function endGame() {
        if (!running) return;
        running = false;
        sections.forEach(function (el) { el.removeEventListener('click', onSectionClick); });

        var freshnessValues = brownness.map(function (br) { return 100 - br; });
        var avgFreshness = freshnessValues.reduce(function (a, c) { return a + c; }, 0) / PEEL_SECTIONS;
        var bestFreshness = Math.max.apply(null, freshnessValues);
        // The overall rarity label still gives a nod to your best single
        // section (half average, half best) so one great peel visibly pulls
        // the label up — but the SCORE itself is just the plain average of
        // all three peels' own points, continuously interpolated within
        // each one's tier band (pointsForFreshness), no extra roll on top.
        var effectiveFreshness = (avgFreshness + bestFreshness) / 2;
        var tier = tierForFreshness(effectiveFreshness);

        var score = Math.round(
          freshnessValues.reduce(function (a, f) { return a + pointsForFreshness(f); }, 0) / PEEL_SECTIONS
        );

        onEnd(score);
        renderEndScreen(score, tier, brownness);
      }
    }

    // ---------------- End-of-round screen: score + name + save ----------------
    function renderEndScreen(score, tier, brownness) {
      mode = 'end';
      playAgainFn = renderGame;

      container.innerHTML =
        '<div class="game-end">' +
          '<div style="font-size:32px;">🍌</div>' +
          '<div><strong style="color:' + tier.color + ';">' + escapeHtml(tier.label) + ' Banana!</strong></div>' +
          '<div>Score: <strong>' + score + '</strong></div>' +
          buildMiniBananaHtml(brownness) +
          '<div class="save-row">' +
            '<input type="text" id="peel-name-input" maxlength="24" placeholder="Name this banana...">' +
            '<button class="primary-btn" id="peel-save-btn">Save</button>' +
          '</div>' +
          '<div class="save-confirm" id="peel-save-confirm" style="display:none;"></div>' +
          '<div class="end-actions">' +
            '<button class="secondary-btn" id="peel-leaderboard-btn">View leaderboard</button>' +
            '<button class="primary-btn" id="peel-again-btn">Play again</button>' +
          '</div>' +
        '</div>';

      var nameInput = container.querySelector('#peel-name-input');
      var saveBtn = container.querySelector('#peel-save-btn');
      var confirmEl = container.querySelector('#peel-save-confirm');
      var saved = false;

      function trySave() {
        if (saved) return;
        saved = true;
        saveBtn.disabled = true;
        nameInput.disabled = true;
        var name = nameInput.value.trim() || 'Anonymous Banana';
        saveLeaderboardEntry({
          name: name,
          score: score,
          tierKey: tier.key,
          tierLabel: tier.label,
          tierColor: tier.color,
          brownness: brownness,
        }).then(function (ok) {
          confirmEl.style.display = 'block';
          if (ok) {
            confirmEl.style.color = '#2c7a2c';
            confirmEl.textContent = 'Saved to the leaderboard!';
          } else {
            confirmEl.style.color = '#b23b3b';
            confirmEl.textContent = "Couldn't reach the leaderboard - try again?";
            saved = false;
            saveBtn.disabled = false;
            nameInput.disabled = false;
          }
        });
      }

      saveBtn.addEventListener('click', trySave);
      nameInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') trySave(); });

      container.querySelector('#peel-leaderboard-btn').addEventListener('click', renderLeaderboard);
      container.querySelector('#peel-again-btn').addEventListener('click', renderGame);
    }

    // ---------------- Leaderboard: every saved banana, highest score first ----------------
    function renderLeaderboard() {
      mode = 'leaderboard';
      peelNextFn = null;
      playAgainFn = null;

      container.innerHTML = '<p style="text-align:center;font-size:13px;color:var(--ink-soft);padding:24px 0;">Loading leaderboard...</p>';

      loadLeaderboard().then(function (list) {
        list = list.slice().sort(function (a, b) { return b.score - a.score; });

        var rowsHtml;
        if (list.length === 0) {
          rowsHtml = '<p style="font-size:13px;color:var(--ink-soft);text-align:center;">No bananas saved yet - go peel one!</p>';
        } else {
          rowsHtml = '';
          for (var i = 0; i < list.length; i++) {
            var entry = list[i];
            rowsHtml +=
              '<div class="leaderboard-row">' +
                '<span class="leaderboard-rank">#' + (i + 1) + '</span>' +
                buildMiniBananaHtml(entry.brownness) +
                '<span class="leaderboard-name">' + escapeHtml(entry.name) + '</span>' +
                '<span class="leaderboard-tier" style="color:' + entry.tierColor + ';">' + escapeHtml(entry.tierLabel) + '</span>' +
                '<span class="leaderboard-score">' + entry.score + '</span>' +
              '</div>';
          }
        }

        container.innerHTML =
          '<div class="leaderboard-header">' +
            '<h2 style="margin:0;font-size:15px;">🏆 Banana Leaderboard</h2>' +
            '<button class="secondary-btn" id="peel-back-btn">Back</button>' +
          '</div>' +
          '<div class="leaderboard-list">' + rowsHtml + '</div>';

        container.querySelector('#peel-back-btn').addEventListener('click', renderGame);
      });
    }
  }

  // Expose globally — call window.mountPeelBananaGame(container, { onEnd })
  // from your own site's code.
  window.mountPeelBananaGame = mountPeelBananaGame;
})();
