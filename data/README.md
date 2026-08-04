# data/

`hrl-rules-2026.json` — the search index behind the **Rules** button on the site
and in the log app. Generated, but **committed**: the site is a static deploy and
nothing parses a PDF at runtime.

## Regenerating it

Whenever HRL publishes a revision (the rulebook is versioned `2026_2`, the
annexes `V8` — both are printed on every page footer):

```
python tools/build_rules_index.py path/to/HRL-Inboard-Racing-rules-XXXX.pdf path/to/HRL_ANNEXES-XXXX.pdf
```

Needs `pip install pypdf`. Then check the diff and commit.

Two follow-ups after a new revision:

1. Update `revision` in `tools/rules_supplements.json` → `sources`.
2. Run `--check-images` and compare against the transcriptions:

   ```
   python tools/build_rules_index.py rules.pdf annexes.pdf --check-images
   ```

   Several pages of these PDFs are **pictures, not text** — the points chart,
   the prize table, the Annex J lane grid, the Annex G and H checklists. pypdf
   returns nothing for them, so they are transcribed by hand in
   `tools/rules_supplements.json`. If a page grows or loses an image, the
   transcription for it needs a look.

## Season rollover

`seasonEndsAfter` in `tools/rules_supplements.json` is the last day of the last
race weekend (currently `2026-08-23`, Beauharnois). Past that date the search
panel flags every answer as coming from the 2026 book. Bump it — along with
`season` and `seasonEndLabel` — when the next calendar is out.
