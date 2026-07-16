// ── Hamburger menu ──────────────────────────────────────────────────────────
const burger = document.querySelector('.nav-burger');
const nav = document.querySelector('nav');

if (burger && nav) {
  burger.addEventListener('click', () => {
    const open = nav.classList.toggle('nav-open');
    burger.setAttribute('aria-expanded', open);
  });

  document.querySelectorAll('.nav-links a').forEach(a => {
    a.addEventListener('click', () => {
      nav.classList.remove('nav-open');
      burger.setAttribute('aria-expanded', 'false');
    });
  });

  document.addEventListener('click', e => {
    if (!nav.contains(e.target)) {
      nav.classList.remove('nav-open');
      burger.setAttribute('aria-expanded', 'false');
    }
  });
}

// ── Race badges + Race Weekend bar (auto) ────────────────────────────────────
// Reads data-start / data-end (YYYY-MM-DD) on each .row and sets badges.
// The first race that hasn't finished becomes "Next Up"; if today falls inside
// its window it becomes "Race Day" and the red Race Weekend bar goes live.
function updateRaceSchedule() {
  const today = new Date().toISOString().split('T')[0];
  const rows = document.querySelectorAll('.row[data-end]');
  let next = null;        // the row to feature in the bar
  let nextIsLive = false;
  let foundNext = false;

  rows.forEach(row => {
    const end = row.dataset.end;
    const start = row.dataset.start || end;
    const badge = row.querySelector('.rbadge');
    if (!badge) return;

    if (today > end) {
      badge.className = 'rbadge b-done';
      badge.textContent = 'Complete';
      row.classList.remove('live');
    } else if (!foundNext) {
      foundNext = true;
      const live = today >= start;        // inside the race window
      badge.className = 'rbadge b-live';
      badge.textContent = live ? 'Race Day' : 'Next Up';
      row.classList.toggle('live', live);
      next = row;
      nextIsLive = live;
    } else {
      badge.className = 'rbadge b-up';
      badge.textContent = 'Upcoming';
      row.classList.remove('live');
    }
  });

  // ── Race Weekend bar ──
  const bar = document.querySelector('.nextbar');
  if (!bar) return;

  if (!next) {                            // season finished — hide the bar
    bar.hidden = true;
    return;
  }

  const race = bar.querySelector('[data-nextbar="race"]');
  const when = bar.querySelector('[data-nextbar="when"]');
  const status = bar.querySelector('[data-nextbar="status"]');
  const livePill = bar.querySelector('.live');

  const city = next.dataset.city || next.querySelector('.rcity').textContent;
  const region = next.dataset.region || next.querySelector('.rregion').textContent;
  const date = next.querySelector('.rdate').textContent;

  if (race) race.textContent = city;
  if (when) when.textContent = `${date} · ${region}`;
  if (status) status.textContent = nextIsLive ? 'Live Now' : 'Next Up';
  if (livePill) livePill.classList.toggle('is-next', !nextIsLive);

  bar.hidden = false;
}
updateRaceSchedule();

// ── Shared helper for the media renderers below ──────────────────────────────
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ── Photo gallery (admin uploads: GET /api/photos; static grid is the fallback) ─
function openLightbox(src, cap) {
  let lb = document.querySelector('.lb');
  if (!lb) {
    lb = document.createElement('div');
    lb.className = 'lb';
    lb.innerHTML = '<img alt=""><div class="lb-cap"></div>';
    lb.addEventListener('click', () => { lb.hidden = true; });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') lb.hidden = true; });
    document.body.appendChild(lb);
  }
  lb.querySelector('img').src = src;
  lb.querySelector('.lb-cap').textContent = cap || '';
  lb.hidden = false;
}

(function () {
  const grid = document.getElementById('gallery');
  if (!grid) return;
  fetch('/api/photos').then(r => r.ok ? r.json() : []).then(photos => {
    if (!Array.isArray(photos) || !photos.length) return;   // keep the static grid
    const n = photos.length;
    grid.className = 'media-grid dyn ' + (n === 1 ? 'g1' : n === 2 ? 'g2' : n === 3 ? 'g3' : 'g4');
    grid.innerHTML = photos.map((p, i) => {
      const src = '/api/photos/img/' + encodeURIComponent(p.id);
      const cap = p.caption ? '<figcaption class="pcap">' + esc(p.caption) + '</figcaption>' : '';
      return '<figure class="frame' + (n >= 4 && i === 0 ? ' lead' : '') + '" data-cap="' + esc(p.caption || '') + '">'
        + '<img src="' + src + '" alt="' + esc(p.caption || 'Herrin Choker Racing photo') + '" loading="lazy">' + cap + '</figure>';
    }).join('');
    grid.querySelectorAll('.frame').forEach(f => {
      f.addEventListener('click', () => openLightbox(f.querySelector('img').src, f.dataset.cap));
    });
  }).catch(() => { });
})();

// ── Instagram feed (server-cached: GET /api/instagram; hidden until connected) ─
(function () {
  const block = document.getElementById('igfeed');
  if (!block) return;
  fetch('/api/instagram').then(r => r.ok ? r.json() : null).then(d => {
    if (!d || !d.configured || !Array.isArray(d.posts) || !d.posts.length) return;
    if (d.username) {
      const h = document.getElementById('ighandle');
      if (h) {
        h.textContent = '@' + d.username + ' →';
        h.href = 'https://www.instagram.com/' + encodeURIComponent(d.username) + '/';
      }
    }
    const play = '<svg class="ig-badge" width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
    const stack = '<svg class="ig-badge" width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><path d="M4 8h12v12H4z" opacity=".55"/><path d="M8 4h12v12h-2V6H8z"/></svg>';
    block.querySelector('.ig-grid').innerHTML = d.posts.slice(0, 8).map(p =>
      '<a class="ig-tile" href="' + esc(p.permalink) + '" target="_blank" rel="noopener">'
      + '<img src="' + esc(p.img) + '" alt="' + esc(p.caption || 'Instagram post') + '" loading="lazy" referrerpolicy="no-referrer">'
      + (p.type === 'VIDEO' ? play : p.type === 'CAROUSEL_ALBUM' ? stack : '')
      + '</a>').join('');
    block.hidden = false;
  }).catch(() => { });
})();

// ── Race clips (rendered from the clips store: GET /api/clips) ────────────────
(function () {
  const box = document.getElementById('clips');
  if (!box) return;
  fetch('/api/clips').then(r => r.ok ? r.json() : []).then(clips => {
    if (!Array.isArray(clips) || !clips.length) {
      box.classList.add('vids-empty');
      box.innerHTML = '<p class="vids-note">Race clips will appear here through the season. '
        + '<a href="https://www.youtube.com/@HydroplaneRacingLeague" target="_blank">Watch live on HRL →</a></p>';
      return;
    }
    box.innerHTML = clips.map(c => {
      const q = [c.start ? 'start=' + c.start : '', c.end ? 'end=' + c.end : ''].filter(Boolean).join('&');
      const src = 'https://www.youtube.com/embed/' + encodeURIComponent(c.videoId) + (q ? '?' + q : '');
      const cap = c.title ? '<figcaption class="vid-cap">' + esc(c.title) + '</figcaption>' : '';
      return '<figure class="vid-item"><div class="vid"><iframe src="' + src + '" title="'
        + esc(c.title || 'Race clip') + '" allowfullscreen loading="lazy"></iframe></div>' + cap + '</figure>';
    }).join('');
  }).catch(() => { });
})();
