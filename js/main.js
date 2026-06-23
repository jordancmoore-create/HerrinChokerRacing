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
