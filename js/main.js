// ── Hamburger menu ──────────────────────────────────────────────────────────
const burger = document.querySelector('.nav-burger');
const nav = document.querySelector('nav');

if (burger) {
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

// ── Race badge auto-update ───────────────────────────────────────────────────
// Reads data-start / data-end (YYYY-MM-DD) on each .race-row and sets badges.
function updateRaceBadges() {
  const today = new Date().toISOString().split('T')[0];
  let foundNext = false;
  document.querySelectorAll('.race-row[data-end]').forEach(row => {
    const end = row.dataset.end;
    const start = row.dataset.start || end;
    const badge = row.querySelector('.race-badge');
    if (!badge) return;
    if (today > end) {
      badge.className = 'race-badge badge-past';
      badge.textContent = 'Complete';
      row.classList.remove('next-up');
    } else if (!foundNext) {
      badge.className = 'race-badge badge-next';
      badge.textContent = today >= start ? 'Race Day' : 'Next Up';
      row.classList.add('next-up');
      foundNext = true;
    } else {
      badge.className = 'race-badge badge-upcoming';
      badge.textContent = 'Upcoming';
      row.classList.remove('next-up');
    }
  });
}
updateRaceBadges();

