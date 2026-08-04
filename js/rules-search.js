/* ────────────────────────────────────────────────────────────────────────────
   HRL rule search — shared by the team site nav and the log app topbar.

   Loads data/hrl-rules-2026.json (built by tools/build_rules_index.py from the
   two HRL PDFs) and searches it entirely in the browser. No PDF is ever fetched,
   nothing hits the network after the first open.

   Mount it by putting a button on the page:
       <button data-rules-search>Rules</button>
   or call  HRLRules.open()  yourself. Keyboard: Ctrl/⌘+K or "/" opens it.

   Two things drive the design:

   * We race Formula F. Every result is class-aware — rules that split by class
     (field sizes, hull dimensions, minimum ages) show OUR line first and fold
     the other classes away, and whole annexes belonging to other classes sit
     below a divider instead of mixing into the list.
   * Penalty codes are looked up under pressure. Typing "P3" answers straight
     away rather than returning prose that happens to contain the string.
   ──────────────────────────────────────────────────────────────────────────── */
(function (window, document) {
  'use strict';

  var DATA_URL = '/data/hrl-rules-2026.json';

  /* Field weights. A rule number typed verbatim should beat every prose match;
     hand-written search terms on the transcribed tables rank just under titles. */
  var W = { num: 9, title: 5, terms: 3, section: 2, text: 1 };

  var MAX_RESULTS = 40;
  var MAX_OFFCLASS = 8;

  /* Ordinary stop words, plus the question words people actually type into a
     search box ("how many laps am I doing"). Left in deliberately: must, may,
     shall, before, after — those carry meaning in a rulebook. */
  var STOP = ('a an the of to in on for and or be is are was were will' +
    ' as at by it its his her their this that with without from not no any all' +
    ' if then than there here have has had do does did' +
    ' how what which when where who why whose many much can could would' +
    ' i we our us you your my me am get got need').split(' ');
  var STOPSET = Object.create(null);
  STOP.forEach(function (w) { STOPSET[w] = true; });

  /* ── tokenising ───────────────────────────────────────────────────────────
     Penalty codes first, then dotted rule numbers, so "P3" and "5.5.2" survive
     as single tokens instead of shattering into "p","3" and "5","5","2". */
  var TOKEN_RE = /p(?:1[01]|[1-9])(?![0-9a-z])|[a-z]+|\d+(?:\.\d+)+|\d+/g;

  function tokenise(text) {
    return String(text || '').toLowerCase().match(TOKEN_RE) || [];
  }

  function stem(token) {
    if (token.length > 4 && /(ies)$/.test(token)) return token.slice(0, -3) + 'y';
    if (token.length > 3 && /(sses|shes|ches)$/.test(token)) return token.slice(0, -2);
    if (token.length > 3 && /s$/.test(token) && !/ss$/.test(token)) return token.slice(0, -1);
    return token;
  }

  function escapeHTML(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ── the index ───────────────────────────────────────────────────────────── */

  function Index(data) {
    this.data = data;
    this.records = data.records;
    this.sections = data.sections || [];
    this.penalties = data.penalties || [];
    this.aliases = data.aliases || {};
    this.synonyms = data.synonyms || {};
    this.byId = Object.create(null);
    this.postings = Object.create(null);   // token -> [docIdx, weight, ...]
    this.tokens = [];                      // sorted, for prefix matching
    this.build();
  }

  Index.prototype.sectionOf = function (rec) {
    return rec.sec != null ? this.sections[rec.sec] : '';
  };
  Index.prototype.groupOf = function (rec) {
    return rec.grp != null ? this.sections[rec.grp] : '';
  };

  Index.prototype.build = function () {
    var self = this;
    var postings = this.postings;

    this.records.forEach(function (rec, i) {
      self.byId[rec.id] = rec;

      var weights = Object.create(null);
      function add(text, weight) {
        tokenise(text).forEach(function (raw) {
          if (STOPSET[raw]) return;
          var t = stem(raw);
          weights[t] = (weights[t] || 0) + weight;
          if (t !== raw) weights[raw] = (weights[raw] || 0) + weight;
        });
      }

      add(rec.num, W.num);
      add(rec.title, W.title);
      add(rec.terms, W.terms);
      add(self.sectionOf(rec) + ' ' + self.groupOf(rec), W.section);
      add(rec.text, W.text);
      if (rec.penalties) add(rec.penalties.join(' '), W.num);

      for (var token in weights) {
        (postings[token] || (postings[token] = [])).push(i, weights[token]);
      }
    });

    /* Penalty cards ride along in the same posting lists, addressed by a
       negative index so a "P6" search can return the card and the rules. */
    this.penalties.forEach(function (pen, p) {
      var weights = Object.create(null);
      function add(text, weight) {
        tokenise(text).forEach(function (raw) {
          if (STOPSET[raw]) return;
          var t = stem(raw);
          weights[t] = (weights[t] || 0) + weight;
        });
      }
      add(pen.code, W.num * 3);
      add('penalty infraction', W.title);
      add(pen.terms, W.terms);
      add(pen.text, W.text);
      for (var token in weights) {
        (postings[token] || (postings[token] = [])).push(-(p + 1), weights[token]);
      }
    });

    this.tokens = Object.keys(postings).sort();
    this.total = this.records.length + this.penalties.length;
  };

  /* tokens sharing a prefix — powers as-you-type matching on the last word */
  Index.prototype.withPrefix = function (prefix) {
    var tokens = this.tokens, lo = 0, hi = tokens.length;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (tokens[mid] < prefix) lo = mid + 1; else hi = mid;
    }
    var out = [];
    for (var i = lo; i < tokens.length && tokens[i].indexOf(prefix) === 0; i++) {
      out.push(tokens[i]);
      if (out.length > 60) break;
    }
    return out;
  };

  Index.prototype.expand = function (queryTokens) {
    var self = this, out = [];
    queryTokens.forEach(function (t) {
      out.push(t);
      var syn = self.synonyms[t];
      if (syn) syn.forEach(function (s) { if (out.indexOf(s) < 0) out.push(s); });
    });
    return out;
  };

  /* Naming a class in the query means you want that class. "grand prix minimum
     length" should answer about Grand Prix, not quietly hand back our numbers. */
  var CLASS_QUERY = [
    [['FR', 'FF'], /formula\s*r\s*[\/&]\s*f|formula\s*r\s*and\s*f/],
    [['FF'], /formula\s*f|formule\s*f/],
    [['FR'], /formula\s*r|formule\s*r/],
    [['JSS'], /\bjss\b|jersey\s*speed\s*skiff/],
    [['H350'], /hydro\s*350|\bh\s*350\b|\bh350\b/],
    [['PRO'], /pro[\s\-]*hydro/],
    [['GP'], /grand\s*prix/],
    [['NOV'], /\bnovice\b/]
  ];

  function classesAskedFor(query) {
    var low = query.toLowerCase(), found = [];
    CLASS_QUERY.forEach(function (pair) {
      if (pair[1].test(low)) {
        pair[0].forEach(function (c) { if (found.indexOf(c) < 0) found.push(c); });
      }
    });
    return found;
  }

  Index.prototype.search = function (query, opts) {
    opts = opts || {};
    var self = this;
    var asked = classesAskedFor(query);
    var askedElsewhere = asked.length > 0 && asked.indexOf(OUR_CLASS) < 0;
    var raw = tokenise(query);
    if (!raw.length) return [];

    var terms = this.expand(raw).map(stem).filter(function (t) { return !STOPSET[t]; });
    if (!terms.length) terms = raw;

    var scores = Object.create(null);
    var hitCount = Object.create(null);
    var endsOpen = !/[\s.,;:!?)]$/.test(query);   // still typing the last word

    terms.forEach(function (term, ti) {
      var variants = [term];
      var isLast = ti === terms.length - 1;
      if (isLast && endsOpen && term.length >= 2) {
        self.withPrefix(term).forEach(function (t) {
          if (variants.indexOf(t) < 0) variants.push(t);
        });
      }
      variants.forEach(function (variant) {
        var list = self.postings[variant];
        if (!list) return;
        var docs = list.length / 2;
        var idf = Math.log(1 + self.total / docs);
        var damp = variant === term ? 1 : 0.45;      // prefix matches count less
        for (var i = 0; i < list.length; i += 2) {
          var doc = list[i];
          var weight = list[i + 1];
          var score = idf * Math.sqrt(weight) * damp;
          scores[doc] = (scores[doc] || 0) + score;
          if (variant === term || damp < 1) {
            (hitCount[doc] || (hitCount[doc] = {}))[term] = true;
          }
        }
      });
    });

    /* Exact address lookups: "5.5.2", "9.1", "annex j", "P3" */
    var direct = query.trim().toLowerCase();
    var numMatch = direct.match(/^(?:art(?:icle)?\.?\s*|rule\s*)?(\d{1,2}(?:\.\d{1,2}){0,3})$/);
    if (numMatch) {
      var wanted = numMatch[1];
      this.records.forEach(function (rec, i) {
        if (rec.doc !== 'rules') return;
        if (rec.num === wanted) scores[i] = (scores[i] || 0) + 500;
        else if (rec.num.indexOf(wanted + '.') === 0) scores[i] = (scores[i] || 0) + 200;
      });
    }
    var annexMatch = direct.match(/^annex(?:e)?\s+([a-n])\b/);
    if (annexMatch) {
      var letter = annexMatch[1].toUpperCase();
      this.records.forEach(function (rec, i) {
        if (rec.annex === letter) scores[i] = (scores[i] || 0) + 120;
      });
    }
    var penMatch = direct.match(/^p\s*(\d{1,2})$/);
    if (penMatch) {
      var code = 'P' + penMatch[1];
      this.penalties.forEach(function (pen, p) {
        if (pen.code === code) scores[-(p + 1)] = (scores[-(p + 1)] || 0) + 800;
      });
    }

    var results = [];
    for (var key in scores) {
      var idx = +key;
      var score = scores[key];
      var matched = hitCount[key] ? Object.keys(hitCount[key]).length : 0;

      /* Every query term present is worth far more than one term present
         loudly — otherwise "formula f weight" is won by any page saying
         "weight" a dozen times. */
      if (terms.length > 1) score *= 1 + 0.9 * (matched / terms.length);
      if (matched < terms.length && terms.length > 1) score *= 0.55;

      var isPenalty = idx < 0;
      var rec = isPenalty ? null : this.records[idx];
      var ours = isPenalty ? true : !!rec.ourClass;

      /* An explicitly named class outranks the Formula F default — but only
         for records actually belonging to it. */
      if (askedElsewhere && rec && rec.classes.some(function (c) {
            return asked.indexOf(c) >= 0;
          })) {
        score *= 1.8;
        ours = true;
      }

      if (isPenalty) score *= 1.15;
      if (!ours) score *= 0.5;

      results.push({ idx: idx, score: score, penalty: isPenalty, rec: rec, ours: ours });
    }

    /* Alias nudges: "tie" should reach 5.5.2 even though the article never
       uses the bare word, "prize"/"purse" should reach the payout table. */
    raw.forEach(function (t) {
      var ids = self.aliases[t] || self.aliases[stem(t)];
      if (!ids) return;
      ids.forEach(function (id) {
        var rec = self.byId[id];
        if (!rec) return;
        var at = results.findIndex(function (r) { return r.rec === rec; });
        /* These pairings are curated by hand, so trust them well above the
           word statistics — "laps" should land on 8.6, not on whichever
           article happens to say "laps" most often. */
        if (at >= 0) results[at].score = results[at].score * 1.5 + 12;
        else results.push({
          idx: self.records.indexOf(rec), score: 10,
          penalty: false, rec: rec, ours: !!rec.ourClass
        });
      });
    });

    results.sort(function (a, b) { return b.score - a.score; });

    var out;
    if (opts.formulaFOnly !== false) {
      var mine = results.filter(function (r) { return r.ours; }).slice(0, MAX_RESULTS);
      var rest = results.filter(function (r) { return !r.ours; }).slice(0, MAX_OFFCLASS);
      out = mine.concat(rest);
    } else {
      out = results.slice(0, MAX_RESULTS + MAX_OFFCLASS);
    }
    out.asked = askedElsewhere ? asked : null;
    return out;
  };

  /* ── answers & snippets ──────────────────────────────────────────────────── */

  var OUR_CLASS = 'FF';

  /* The line that actually answers the question. For a rule that splits by
     class, that is our class's line — not the first sentence, which is usually
     "the boats must meet the following dimensions". */
  function answerFor(rec, prefer) {
    var want = prefer && prefer.length ? prefer : [OUR_CLASS];
    if (rec.seg) {
      for (var i = 0; i < rec.seg.length; i++) {
        if (rec.seg[i].c.some(function (c) { return want.indexOf(c) >= 0; })) {
          var text = rec.text.slice(rec.seg[i].s, rec.seg[i].e);
          /* Segments are cut on the PDF's line breaks, which land mid-sentence
             often enough ("consolation. In that specific case, for the Formula
             R, Formula F..."). Drop the orphaned tail of the previous sentence. */
          if (/^[a-z]/.test(text)) {
            var boundary = text.indexOf('. ');
            if (boundary > 0 && text.length - boundary > 40) {
              text = text.slice(boundary + 2);
            }
          }
          return {
            text: text,
            ourLine: true,
            label: rec.seg[i].c.map(function (c) { return CLASS_LABEL[c] || c; }).join(' · ')
          };
        }
      }
    }
    var flat = rec.text.replace(/\s+/g, ' ').trim();
    var parts = flat.split(/(?<=[.!?])\s+/);
    var out = parts[0] || flat;
    if (out.length < 70 && parts[1]) out += ' ' + parts[1];
    return { text: out.length > 260 ? out.slice(0, 257) + '…' : out, ourLine: false };
  }

  function highlight(text, terms) {
    var html = escapeHTML(text);
    if (!terms.length) return html;
    var pattern = terms
      .filter(function (t) { return t.length > 1; })
      .map(function (t) { return t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); })
      .sort(function (a, b) { return b.length - a.length; })
      .join('|');
    if (!pattern) return html;
    try {
      return html.replace(new RegExp('(' + pattern + ')', 'gi'), '<mark>$1</mark>');
    } catch (e) { return html; }
  }

  function snippetFor(rec, terms) {
    var flat = rec.text.replace(/\s+/g, ' ').trim();
    if (!terms.length) return flat.slice(0, 190);
    var lower = flat.toLowerCase(), at = -1;
    for (var i = 0; i < terms.length && at < 0; i++) at = lower.indexOf(terms[i]);
    if (at < 0) return flat.slice(0, 190);
    var start = Math.max(0, at - 70);
    if (start > 0) start = flat.indexOf(' ', start) + 1;
    var text = flat.slice(start, start + 210);
    return (start > 0 ? '…' : '') + text + (start + 210 < flat.length ? '…' : '');
  }

  /* ── UI ──────────────────────────────────────────────────────────────────── */

  var CLASS_LABEL = {
    ALL: 'All classes', FF: 'Formula F', FR: 'Formula R', JSS: 'Jersey Speed Skiff',
    H350: 'Hydro 350', PRO: 'Pro Hydro', GP: 'Grand Prix', NOV: 'Novice'
  };

  var QUICK = [
    { label: 'Penalties', q: 'penalty infraction' },
    { label: 'Points', q: 'point distribution chart' },
    { label: 'Start', q: 'start countdown buoy' },
    { label: 'Lanes', q: 'lane assignment' },
    { label: 'Our specs', q: 'formula f dimensions weight' },
    { label: 'Safety', q: 'safety inspection' }
  ];

  var UI = {
    index: null, loading: null, root: null, input: null, list: null,
    status: null, skin: 'site', formulaFOnly: true, lastResults: [], lastTerms: [],
    openId: null, seasonOver: false
  };

  function load() {
    if (UI.index) return Promise.resolve(UI.index);
    if (UI.loading) return UI.loading;
    UI.loading = fetch(DATA_URL, { cache: 'default' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        UI.index = new Index(data);
        UI.seasonOver = seasonIsOver(data.seasonEndsAfter);
        return UI.index;
      })
      .catch(function (err) {
        UI.loading = null;
        throw err;
      });
    return UI.loading;
  }

  /* The season flag the whole thing hangs on: once the last race of the year is
     behind us, say plainly that these answers come from the 2026 book. */
  function seasonIsOver(endsAfter) {
    if (!endsAfter) return false;
    var parts = endsAfter.split('-');
    var end = new Date(+parts[0], +parts[1] - 1, +parts[2]);
    end.setHours(23, 59, 59, 999);
    return new Date() > end;
  }

  function build() {
    if (UI.root) return UI.root;

    var root = document.createElement('div');
    root.className = 'hrls';
    root.setAttribute('data-hrls-skin', UI.skin);
    root.hidden = true;
    root.innerHTML =
      '<div class="hrls-backdrop" data-close></div>' +
      '<div class="hrls-panel" role="dialog" aria-modal="true" aria-label="Search HRL rules">' +
        '<div class="hrls-head">' +
          '<div class="hrls-searchrow">' +
            '<span class="hrls-icon" aria-hidden="true">⌕</span>' +
            '<input class="hrls-input" type="search" autocomplete="off" spellcheck="false" ' +
              'placeholder="Search the HRL rulebook — try “P3”, “tie breaker”, “5.5.2”" ' +
              'aria-label="Search the HRL rulebook">' +
            '<button class="hrls-close" data-close aria-label="Close">✕</button>' +
          '</div>' +
          '<div class="hrls-controls">' +
            '<div class="hrls-quick"></div>' +
            '<label class="hrls-toggle">' +
              '<input type="checkbox" class="hrls-allclasses"> <span>All classes</span>' +
            '</label>' +
          '</div>' +
        '</div>' +
        '<div class="hrls-status" role="status" aria-live="polite"></div>' +
        '<div class="hrls-list" tabindex="-1"></div>' +
        '<div class="hrls-foot"></div>' +
      '</div>';

    document.body.appendChild(root);
    UI.root = root;
    UI.input = root.querySelector('.hrls-input');
    UI.list = root.querySelector('.hrls-list');
    UI.status = root.querySelector('.hrls-status');

    var quick = root.querySelector('.hrls-quick');
    QUICK.forEach(function (item) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'hrls-chip';
      btn.textContent = item.label;
      btn.addEventListener('click', function () {
        UI.input.value = item.q;
        run();
        UI.input.focus();
      });
      quick.appendChild(btn);
    });

    root.querySelector('.hrls-allclasses').addEventListener('change', function () {
      UI.formulaFOnly = !this.checked;
      run();
    });

    root.addEventListener('click', function (ev) {
      if (ev.target.closest('[data-close]')) close();
    });

    var timer;
    UI.input.addEventListener('input', function () {
      clearTimeout(timer);
      timer = setTimeout(run, 90);
    });

    UI.input.addEventListener('keydown', function (ev) {
      if (ev.key === 'ArrowDown') {
        ev.preventDefault();
        var first = UI.list.querySelector('.hrls-hit');
        if (first) first.focus();
      }
    });

    UI.list.addEventListener('keydown', function (ev) {
      if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
      var hits = Array.prototype.slice.call(UI.list.querySelectorAll('.hrls-hit'));
      var at = hits.indexOf(document.activeElement);
      ev.preventDefault();
      if (ev.key === 'ArrowUp' && at <= 0) { UI.input.focus(); return; }
      var next = hits[at + (ev.key === 'ArrowDown' ? 1 : -1)];
      if (next) next.focus();
    });

    root.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') { ev.stopPropagation(); close(); }
    });

    return root;
  }

  function classTags(rec) {
    if (!rec || !rec.classes || rec.classes.indexOf('ALL') >= 0) return '';
    return rec.classes.map(function (code) {
      var mine = code === OUR_CLASS || code === 'ALL';
      return '<span class="hrls-tag' + (mine ? ' is-ours' : '') + '">' +
        escapeHTML(CLASS_LABEL[code] || code) + '</span>';
    }).join('');
  }

  function sourceLine(rec) {
    var src = UI.index.data.sources[rec.doc];
    return src.title + ' ' + UI.index.data.season + ' (rev ' + src.revision + ') · p. ' + rec.page;
  }

  function renderPenalty(pen, terms, expanded) {
    var refs = (pen.refs || []).map(function (num) {
      return '<button class="hrls-ref" data-goto="rules-' + escapeHTML(num) + '">Article ' +
        escapeHTML(num) + '</button>';
    }).join('');
    return '<article class="hrls-hit hrls-penalty' + (expanded ? ' is-open' : '') +
        '" tabindex="0" data-key="pen-' + pen.code + '">' +
        '<div class="hrls-hit-top">' +
          '<span class="hrls-num hrls-pcode">' + escapeHTML(pen.code) + '</span>' +
          '<span class="hrls-title">' + highlight(pen.text, terms) + '</span>' +
        '</div>' +
        '<p class="hrls-answer">' + escapeHTML(pen.consequence) + '</p>' +
        (refs ? '<div class="hrls-refs">' + refs + '</div>' : '') +
        '<div class="hrls-src">HRL Inboard Racing Rules ' + UI.index.data.season +
          ' · article 9.1 (Penalties)</div>' +
      '</article>';
  }

  function renderSegments(rec, prefer) {
    if (!rec.seg) return '';
    var want = prefer && prefer.length ? prefer : [OUR_CLASS];
    var ours = [], others = [];
    var preamble = rec.text.slice(0, rec.seg[0].s).trim();
    rec.seg.forEach(function (seg) {
      var mine = seg.c.some(function (c) { return want.indexOf(c) >= 0; });
      var label = seg.c.map(function (c) { return CLASS_LABEL[c] || c; }).join(' · ');
      var html = '<div class="hrls-seg' + (mine ? ' is-ours' : '') + '">' +
        '<span class="hrls-seg-label">' + escapeHTML(label) + '</span>' +
        '<pre>' + escapeHTML(rec.text.slice(seg.s, seg.e)) + '</pre></div>';
      (mine ? ours : others).push(html);
    });
    return (preamble ? '<pre class="hrls-pre">' + escapeHTML(preamble) + '</pre>' : '') +
      ours.join('') +
      (others.length
        ? '<details class="hrls-others"><summary>Other classes (' + others.length + ')</summary>' +
          others.join('') + '</details>'
        : '');
  }

  function renderRecord(result, terms, expanded, prefer) {
    var rec = result.rec;
    var answer = answerFor(rec, prefer);
    var refs = (rec.refs || []).map(function (id) {
      var target = UI.index.byId[id];
      var label = id.indexOf('annex-') === 0
        ? 'Annex ' + id.slice(6)
        : 'Article ' + id.slice(6);
      if (!target && id.indexOf('annex-') !== 0) return '';
      return '<button class="hrls-ref" data-goto="' + escapeHTML(id) + '">' +
        escapeHTML(label) + '</button>';
    }).filter(Boolean).join('');

    var body = expanded
      ? '<div class="hrls-body">' +
          (rec.note ? '<p class="hrls-note">' + escapeHTML(rec.note) + '</p>' : '') +
          (rec.seg ? renderSegments(rec, prefer)
                   : '<pre class="hrls-pre">' + highlight(rec.text, terms) + '</pre>') +
          (refs ? '<div class="hrls-refs">' + refs + '</div>' : '') +
          '<div class="hrls-src">' + escapeHTML(sourceLine(rec)) + '</div>' +
        '</div>'
      : '<p class="hrls-snippet">' + highlight(snippetFor(rec, terms), terms) + '</p>';

    return '<article class="hrls-hit' + (expanded ? ' is-open' : '') +
        (result.ours ? '' : ' is-offclass') +
        '" tabindex="0" data-key="' + escapeHTML(rec.id) + '">' +
        '<div class="hrls-hit-top">' +
          '<span class="hrls-num">' + escapeHTML(rec.num) + '</span>' +
          '<span class="hrls-title">' + highlight(rec.title, terms) + '</span>' +
          classTags(rec) +
        '</div>' +
        '<p class="hrls-answer' + (answer.ourLine ? ' is-ourline' : '') + '">' +
          (answer.ourLine
            ? '<span class="hrls-ourbadge">' + escapeHTML(answer.label) + '</span>'
            : '') +
          highlight(answer.text, terms) + '</p>' +
        body +
        '<div class="hrls-where">' + escapeHTML(UI.index.sectionOf(rec) || '') +
          (rec.kind === 'table' ? ' · table' : '') + '</div>' +
      '</article>';
  }

  function render(results, terms) {
    if (!results.length) {
      UI.list.innerHTML = '<p class="hrls-empty">Nothing found. Try a rule number ' +
        '(<code>5.5.2</code>), a penalty code (<code>P6</code>), or a plain word ' +
        'like <code>propeller</code>.</p>';
      return;
    }

    var html = '';
    var dividerDone = false;
    results.forEach(function (result) {
      if (!result.ours && !dividerDone) {
        dividerDone = true;
        var focus = results.asked
          ? results.asked.map(function (c) { return CLASS_LABEL[c] || c; }).join(' / ')
          : 'Formula F';
        html += '<div class="hrls-divider"><span>Other classes — these do not apply to ' +
          escapeHTML(focus) + '</span></div>';
      }
      var key = result.penalty ? 'pen-' + UI.index.penalties[-result.idx - 1].code : result.rec.id;
      var expanded = UI.openId === key;
      html += result.penalty
        ? renderPenalty(UI.index.penalties[-result.idx - 1], terms, expanded)
        : renderRecord(result, terms, expanded, results.asked);
    });
    UI.list.innerHTML = html;
  }

  function run() {
    if (!UI.index) return;
    var query = UI.input.value.trim();
    if (!query) {
      UI.openId = null;
      UI.list.innerHTML = '<p class="hrls-empty">' + UI.index.records.length +
        ' rules from the ' + UI.index.data.season + ' HRL rulebook and annexes. ' +
        'Search by rule number, penalty code, or plain English.</p>';
      UI.status.textContent = '';
      return;
    }
    var results = UI.index.search(query, { formulaFOnly: UI.formulaFOnly });
    var terms = tokenise(query).filter(function (t) { return !STOPSET[t] && t.length > 1; });
    UI.lastResults = results;
    UI.lastTerms = terms;
    render(results, terms);

    var ours = results.filter(function (r) { return r.ours; }).length;
    UI.status.textContent = results.length
      ? results.length + ' result' + (results.length === 1 ? '' : 's') +
        (results.length - ours ? ' · ' + ours + ' for Formula F' : '')
      : 'No results';
  }

  function foot() {
    var data = UI.index.data;
    var rules = data.sources.rules, annex = data.sources.annex;
    var stamp = '<span class="hrls-season' + (UI.seasonOver ? ' is-stale' : '') + '">' +
      data.season + ' rules</span>';
    var note = UI.seasonOver
      ? 'The ' + data.season + ' season ended after ' + escapeHTML(data.seasonEndLabel) +
        '. These answers come from the ' + data.season + ' rulebook — check for a ' +
        (data.season + 1) + ' revision before relying on them.'
      : 'Source: ' + escapeHTML(rules.title) + ' rev ' + escapeHTML(rules.revision) +
        ' · ' + escapeHTML(annex.title) + ' rev ' + escapeHTML(annex.revision) + '.';
    UI.root.querySelector('.hrls-foot').innerHTML = stamp + '<span>' + note + '</span>';
  }

  function open(prefill) {
    build();
    UI.root.hidden = false;
    document.documentElement.classList.add('hrls-open');
    UI.input.focus();
    if (prefill) UI.input.value = prefill;

    if (!UI.index) {
      UI.list.innerHTML = '<p class="hrls-empty">Loading the rulebook…</p>';
      load().then(function () {
        foot();
        run();
      }).catch(function () {
        UI.list.innerHTML = '<p class="hrls-empty">Could not load the rule index. ' +
          'Check that <code>' + DATA_URL + '</code> is deployed.</p>';
      });
    } else {
      foot();
      run();
    }
  }

  function close() {
    if (!UI.root) return;
    UI.root.hidden = true;
    document.documentElement.classList.remove('hrls-open');
  }

  function goto(id) {
    var rec = UI.index && UI.index.byId[id];
    if (!rec) {
      /* cross-reference to a whole annex — search for it instead */
      UI.input.value = id.indexOf('annex-') === 0 ? 'annex ' + id.slice(6) : id.slice(6);
    } else {
      UI.input.value = rec.num;
      UI.openId = rec.id;
    }
    run();
    UI.list.scrollTop = 0;
  }

  /* expand / collapse a result, and follow cross-reference chips */
  document.addEventListener('click', function (ev) {
    var ref = ev.target.closest && ev.target.closest('.hrls-ref');
    if (ref) {
      ev.stopPropagation();
      goto(ref.getAttribute('data-goto'));
      return;
    }
    var hit = ev.target.closest && ev.target.closest('.hrls-hit');
    if (!hit || !UI.root || UI.root.hidden) return;
    if (ev.target.closest('details') || ev.target.tagName === 'SUMMARY') return;
    var key = hit.getAttribute('data-key');
    UI.openId = UI.openId === key ? null : key;
    render(UI.lastResults, UI.lastTerms);
    var again = UI.list.querySelector('[data-key="' + (key || '').replace(/"/g, '') + '"]');
    if (again && UI.openId) again.focus();
  });

  document.addEventListener('keydown', function (ev) {
    if (UI.root && !UI.root.hidden && ev.key === 'Enter') {
      var hit = document.activeElement && document.activeElement.closest('.hrls-hit');
      if (hit) { ev.preventDefault(); hit.click(); }
      return;
    }
    var typing = /^(INPUT|TEXTAREA|SELECT)$/.test((ev.target.tagName || '')) ||
      ev.target.isContentEditable;
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'k') {
      ev.preventDefault();
      open();
    } else if (ev.key === '/' && !typing && (!UI.root || UI.root.hidden)) {
      ev.preventDefault();
      open();
    }
  });

  function mount() {
    var buttons = document.querySelectorAll('[data-rules-search]');
    if (!buttons.length) return;
    UI.skin = document.documentElement.hasAttribute('data-theme') ? 'log' : 'site';
    Array.prototype.forEach.call(buttons, function (btn) {
      btn.addEventListener('click', function (ev) {
        ev.preventDefault();
        open();
      });
      /* warm the index before it is needed — trackside, on a phone, the first
         search should not also be the first download */
      btn.addEventListener('mouseenter', function () { load().catch(function () {}); },
        { once: true });
    });
    if ('requestIdleCallback' in window) {
      window.requestIdleCallback(function () { load().catch(function () {}); },
        { timeout: 6000 });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }

  window.HRLRules = { open: open, close: close, load: load };
})(window, document);
