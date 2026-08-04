#!/usr/bin/env python3
"""
Turn the two HRL PDFs into data/hrl-rules-2026.json — the index behind the
"Rules" search button on the team site and in the log app.

    pip install pypdf
    python tools/build_rules_index.py \
        ~/Downloads/HRL-Inboard-Racing-rules-2026_2.pdf \
        ~/Downloads/HRL_ANNEXES-2026_V8.pdf

Run it once per HRL publication, commit the JSON. Nothing parses a PDF at
runtime — the browser only ever fetches the finished index.

Two things the PDFs make awkward, and how this handles them:

  * Several pages are pictures, not text (points chart, prize table, the Annex J
    lane grid, the Annex G/H checklists). pypdf returns nothing for those, so
    they are transcribed by hand in tools/rules_supplements.json and merged in.
    --check-images re-lists which pages carry images so you can spot a new one.

  * Rules that cover every class in one article (field sizes, minimum ages, hull
    dimensions) get split into per-class segments so the UI can put the Formula F
    line first and fold the rest away. We race F; a Grand Prix number read by
    mistake is the failure mode worth designing against.
"""

import argparse
import json
import os
import re
import sys
from collections import OrderedDict

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SUPPLEMENTS = os.path.join(HERE, "rules_supplements.json")
DEFAULT_OUT = os.path.join(ROOT, "data", "hrl-rules-2026.json")

# ---------------------------------------------------------------- class tags

# Order matters: longer / more specific patterns first so "Formula R/F" is not
# eaten by the bare "Formula R" pattern.
CLASS_PATTERNS = [
    ("FR|FF", r"formula\s*r\s*/\s*f|formula\s*r\s*(?:&|and)\s*f|formule\s*r\s*(?:&|et)\s*f|formula\s*r,\s*formula\s*f"),
    ("FF", r"formula\s*f\b|formule\s*f\b"),
    ("FR", r"formula\s*r\b|formule\s*r\b"),
    ("JSS", r"\bjss\b|jersey\s*speed\s*skiff"),
    ("H350", r"hydro\s*350|\bh\s*350\b|\bh350\b"),
    ("PRO", r"pro[\s\-]*hydro"),
    ("GP", r"grand\s*prix"),
    ("NOV", r"\bnovice\b"),
]

CLASS_LABELS = {
    "ALL": "All classes",
    "FF": "Formula F",
    "FR": "Formula R",
    "JSS": "Jersey Speed Skiff",
    "H350": "Hydro 350",
    "PRO": "Pro Hydro",
    "GP": "Grand Prix",
    "NOV": "Novice",
}

OUR_CLASS = "FF"


def classes_in(text):
    """Class codes named in a chunk of text, in a stable order."""
    low = text.lower()
    found = []
    for codes, pattern in CLASS_PATTERNS:
        if re.search(pattern, low):
            for code in codes.split("|"):
                if code not in found:
                    found.append(code)
    return found


# ------------------------------------------------------------- text cleanup

RUNNING_HEADERS = [
    re.compile(r"^HRL\s+Inboard\s+Racing\s+rules\s+\S+\s+\d+\s*$", re.I),
    re.compile(r"^HRL_ANNEXES\s+\S+\.docx\s+\d+\s*$", re.I),
]

# pypdf hands back a few characters that are painful to type into a search box.
NORMALISE = {
    "’": "'", "‘": "'", "“": '"', "”": '"',
    "–": "-", "—": "-", " ": " ", "ﬁ": "fi", "ﬂ": "fl",
    "``": '"', "″": '"', "′": "'",
}


def normalise(text):
    for bad, good in NORMALISE.items():
        text = text.replace(bad, good)
    return text


def clean_lines(page_text):
    out = []
    for raw in (page_text or "").split("\n"):
        line = normalise(raw).rstrip()
        if not line.strip():
            out.append("")
            continue
        if any(rx.match(line.strip()) for rx in RUNNING_HEADERS):
            continue
        out.append(re.sub(r"[ \t]{2,}", " ", line).rstrip())
    return out


def squash(lines):
    """Join a rule's lines into one string, dropping runs of blank lines."""
    text = "\n".join(lines)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def extract_pages(path):
    try:
        from pypdf import PdfReader
    except ImportError:
        sys.exit("pypdf is required:  pip install pypdf")
    reader = PdfReader(path)
    return [clean_lines(page.extract_text()) for page in reader.pages]


# ----------------------------------------------------------------- patterns

# "5 POINT SYSTEM", "12 TECHNICAL RULES, SAFETY, AND INSPECTION"
SECTION_RE = re.compile(r"^(\d{1,2})\s+([A-Z][A-Z0-9 ,&/'\-\.]{3,})\s*$")
# "5.5.2 Tie Breaker:", "12.1.10 The boats must meet..."
ARTICLE_RE = re.compile(r"^(\d{1,2}(?:\.\d{1,2}){1,3})\.?\s+(.*)$")
# "1-ENGINE BLOCK", "2-CRANK", "10-OIL SYSTEM"
GROUP_RE = re.compile(r"^(\d{1,2})\s*[-–—]\s*([A-Za-z].*)$")
ANNEX_RE = re.compile(r"^ANNEX\s+([A-Z])\s*$")
# Annex N only: "1. Race Logistics"
NUMBERED_SECTION_RE = re.compile(r"^(\d{1,2})\.\s+([A-Z][A-Za-z].*)$")

CROSSREF_ARTICLE_RE = re.compile(r"\barticles?\s+(\d{1,2}(?:\.\d{1,2}){1,3})", re.I)
CROSSREF_RULE_RE = re.compile(r"\brules?\s+(\d{1,2}\.\d{1,2}(?:\.\d{1,2})?)", re.I)
CROSSREF_ANNEX_RE = re.compile(r"\bannex(?:e)?\s+([A-Z])\b")
PENALTY_RE = re.compile(r"\(?\b(P(?:1[01]|[1-9]))\b\)?")


def title_from(body, num):
    """
    A short label for a rule. The rulebook sometimes gives one outright
    ("5.5.2 Tie Breaker:"); otherwise take the opening clause of the text.
    """
    first = body.strip().split("\n")[0].strip()
    if not first:
        return num
    # "Tie Breaker:" / "FLAGS" style — an explicit heading
    if first.endswith(":") and len(first) <= 70:
        return first[:-1].strip()
    if len(first) <= 60 and first == first.upper() and re.search(r"[A-Z]{3}", first):
        return first.title()
    # otherwise the opening sentence — flattened first, because the PDF wraps
    # mid-sentence and the raw first line usually ends on a stray conjunction
    flat = re.sub(r"\s+", " ", body).strip()
    sentence = re.split(r"(?<=[.;])\s", flat)[0].strip().rstrip(".")
    if len(sentence) > 96:
        sentence = sentence[:93].rsplit(" ", 1)[0] + "..."
    return sentence or num


def classes_for(body, segments):
    """
    Which classes a rule belongs to.

    Default is every class. A rule is only narrowed when its OPENING sentence
    names a class ("To be eligible as a substitute in the Formula R class...") —
    a general rule that merely carries a class exception further down (8.6:
    five laps, "for the Grand Prix and JSS class... four") still applies to us,
    and must not be filed away under someone else's class.
    """
    if segments:
        return ["ALL"]
    flat = re.sub(r"\s+", " ", body).strip()
    opening = re.split(r"(?<=[.;:])\s", flat)[0]
    named = classes_in(opening)
    return named or ["ALL"]


def segment_by_class(text):
    """
    Split a multi-class rule into per-class chunks.

    Articles like 12.1.10 (hull dimensions) or 10.7 (minimum age) list every
    class in one block. A Formula F search should surface the F line, not the
    Grand Prix line that happens to sit two rows above it.

    Returns [{s, e, c}] — character offsets into the rule text plus the class
    codes that stretch covers — or None when the rule is not class-partitioned.
    Offsets rather than copies: the text is the bulk of the index, and this
    would otherwise store the long rules twice.
    """
    lines = text.split("\n")
    offsets = []
    pos = 0
    for line in lines:
        offsets.append(pos)
        pos += len(line) + 1

    blocks = []
    for i, line in enumerate(lines):
        start, end = offsets[i], offsets[i] + len(line)
        found = classes_in(line) if line.strip() else []
        if found:
            blocks.append([start, end, found])
        elif blocks and line.strip():
            blocks[-1][1] = end          # continuation of the block above

    if len(blocks) < 2:
        return None
    if len({tuple(sorted(b[2])) for b in blocks}) < 2:
        return None
    return [{"s": b[0], "e": b[1], "c": b[2]} for b in blocks]


def crossrefs(text, doc):
    refs = []
    for rx in (CROSSREF_ARTICLE_RE, CROSSREF_RULE_RE):
        for m in rx.finditer(text):
            ref = "rules-" + m.group(1)
            if ref not in refs:
                refs.append(ref)
    for m in CROSSREF_ANNEX_RE.finditer(text):
        ref = "annex-" + m.group(1)
        if ref not in refs:
            refs.append(ref)
    return refs


# ------------------------------------------------------------ rules parsing

def parse_rules(pages):
    records = []
    section_num = None
    section_title = None
    pending = None   # rule being accumulated

    def flush():
        nonlocal pending
        if not pending:
            return
        body = squash(pending["lines"])
        if body:
            pending["body"] = body
            records.append(pending)
        pending = None

    for page_no, lines in enumerate(pages, start=1):
        if page_no == 1:            # table of contents
            continue
        for line in lines:
            stripped = line.strip()

            m = SECTION_RE.match(stripped)
            if m and not ARTICLE_RE.match(stripped):
                flush()
                section_num = int(m.group(1))
                section_title = "%s %s" % (m.group(1), m.group(2).strip())
                continue

            m = ARTICLE_RE.match(stripped)
            # Guard against decimals in the prose ("0.050 inches", "9, 5:1")
            # being read as rule numbers: the leading part must match the
            # section we are currently inside.
            if m and section_num is not None and \
                    m.group(1).split(".")[0] == str(section_num):
                flush()
                pending = {
                    "num": m.group(1),
                    "section": section_title,
                    "page": page_no,
                    "lines": [m.group(2)],
                }
                continue

            if pending:
                pending["lines"].append(line)

    flush()

    out = []
    for rec in records:
        num = rec["num"]
        body = rec["body"]
        rid = "rules-" + num
        segments = segment_by_class(body)
        out.append({
            "id": rid,
            "doc": "rules",
            "num": num,
            "title": title_from(body, num),
            "section": rec["section"],
            "page": rec["page"],
            "text": body,
            "classes": classes_for(body, segments),
            "seg": segments,
            "refs": [r for r in crossrefs(body, "rules") if r != rid],
            "penalties": sorted(set(PENALTY_RE.findall(body)),
                                key=lambda p: int(p[1:])),
        })
    return out


# ----------------------------------------------------------- annex parsing

def parse_annexes(pages, annex_titles, annex_classes):
    records = []
    annex = None
    annex_title = None
    group_num = None
    group_title = None
    pending = None
    prose = None
    novice_section = None

    def flush_rule():
        nonlocal pending
        if not pending:
            return
        body = squash(pending["lines"])
        if body:
            pending["body"] = body
            records.append(pending)
        pending = None

    def flush_prose():
        nonlocal prose
        if not prose:
            return
        body = squash(prose["lines"])
        if len(body) > 40:
            prose["body"] = body
            records.append(prose)
        prose = None

    for page_no, lines in enumerate(pages, start=1):
        if page_no == 1:            # table of contents
            continue
        for line in lines:
            stripped = line.strip()

            m = ANNEX_RE.match(stripped)
            if m:
                flush_rule()
                flush_prose()
                annex = m.group(1)
                annex_title = annex_titles.get(annex, "Annex " + annex)
                group_num = group_title = novice_section = None
                continue

            if annex is None:
                continue

            # skip the annex's own subtitle line ("Lane Assignment" etc.)
            if annex_title and stripped and \
                    stripped.lower() in annex_title.lower() and not pending:
                continue

            if annex == "N":
                m = NUMBERED_SECTION_RE.match(stripped)
                if m and not re.match(r"^\d+\.\d", stripped):
                    flush_rule()
                    flush_prose()
                    novice_section = int(m.group(1))
                    group_title = "%s. %s" % (m.group(1), m.group(2).strip())
                    continue
                m = ARTICLE_RE.match(stripped)
                if m and novice_section is not None and \
                        m.group(1).split(".")[0] == str(novice_section):
                    flush_rule()
                    flush_prose()
                    pending = {
                        "annex": annex, "num": m.group(1),
                        "group": group_title, "page": page_no,
                        "lines": [m.group(2)],
                    }
                    continue
            else:
                m = GROUP_RE.match(stripped)
                if m and len(stripped) < 60:
                    flush_rule()
                    flush_prose()
                    group_num = int(m.group(1))
                    group_title = "%s-%s" % (m.group(1), m.group(2).strip())
                    continue

                m = ARTICLE_RE.match(stripped)
                if m and group_num is not None and \
                        m.group(1).split(".")[0] == str(group_num):
                    flush_rule()
                    flush_prose()
                    pending = {
                        "annex": annex, "num": m.group(1),
                        "group": group_title, "page": page_no,
                        "lines": [m.group(2)],
                    }
                    continue

            if pending:
                pending["lines"].append(line)
                continue

            # Annexes F, G, H, I, J, K, M are prose or forms with no numbering:
            # collect them paragraph-wise so they are still searchable.
            if stripped:
                if prose is None:
                    prose = {
                        "annex": annex, "num": None, "group": None,
                        "page": page_no, "lines": [],
                    }
                prose["lines"].append(line)
            elif prose and prose["lines"]:
                flush_prose()

    flush_rule()
    flush_prose()

    out = []
    seen = {}
    for rec in records:
        annex = rec["annex"]
        body = rec["body"]
        if rec["num"]:
            rid = "annex-%s-%s" % (annex, rec["num"])
            num = "Annex %s §%s" % (annex, rec["num"])
        else:
            seen[annex] = seen.get(annex, 0) + 1
            rid = "annex-%s-p%d-%d" % (annex, rec["page"], seen[annex])
            num = "Annex " + annex
        base = annex_classes.get(annex, ["ALL"])
        # Annex A is Grand Prix, C and D are ours, and so on — the annex it
        # sits in is the strongest signal there is. Only the general annexes
        # (F, G, H, I, J, K, M) get their classes read out of the text.
        segments = segment_by_class(body) if base == ["ALL"] else None
        klasses = classes_for(body, segments) if base == ["ALL"] else base
        section = "ANNEX %s - %s" % (annex, annex_titles.get(annex, ""))
        out.append({
            "id": rid,
            "doc": "annex",
            "annex": annex,
            "num": num,
            "title": title_from(body, num),
            "section": section.rstrip(" -"),
            "group": rec["group"],
            "page": rec["page"],
            "text": body,
            "classes": klasses,
            "seg": segments,
            "refs": [r for r in crossrefs(body, "annex") if r != rid],
            "penalties": sorted(set(PENALTY_RE.findall(body)),
                                key=lambda p: int(p[1:])),
        })
    return out


# --------------------------------------------------------------- penalties

def build_penalties(rules_records, extras):
    """
    Pull P1-P11 out of article 9.1 into first-class cards, so typing "P3"
    answers the question instead of returning a page of prose.
    """
    nine_one = next((r for r in rules_records if r["num"] == "9.1"), None)
    if not nine_one:
        return []

    text = nine_one["text"]
    hits = list(re.finditer(r"^\s*(P(?:1[01]|[1-9]))\s*[-–]\s*", text, re.M))
    penalties = []
    for i, m in enumerate(hits):
        code = m.group(1)
        start = m.end()
        end = hits[i + 1].start() if i + 1 < len(hits) else len(text)
        desc = re.sub(r"\s+", " ", text[start:end]).strip().rstrip(".")
        extra = extras.get(code, {})
        penalties.append({
            "code": code,
            "text": desc,
            "consequence": ("Automatic disqualification (DNQ) from the race."
                            if code == "P2" else
                            "One (1) lap penalty. In a qualification heat a "
                            "penalised boat scores a maximum of 8 points "
                            "(next penalised boat 7, and so on)."),
            "refs": extra.get("refs", []),
            "terms": extra.get("terms", ""),
        })
    return penalties


# ------------------------------------------------------------------ output

def apply_supplements(records, supplements):
    """Merge the hand-transcribed image tables in, keeping ids unique."""
    by_id = OrderedDict((r["id"], r) for r in records)
    for extra in supplements.get("records", []):
        rec = dict(extra)
        rec.setdefault("refs", [])
        rec.setdefault("penalties", [])
        rec.setdefault("seg", None)
        rec.setdefault("classes", ["ALL"])
        by_id[rec["id"]] = rec
    return list(by_id.values())


def sort_key(rec):
    doc_order = 0 if rec["doc"] == "rules" else 1
    raw = rec.get("num") or ""
    nums = re.findall(r"\d+", raw)
    annex = rec.get("annex") or ""
    return (doc_order, annex, [int(n) for n in nums] or [999], rec.get("page", 0))


def report_images(paths):
    try:
        from pypdf import PdfReader
    except ImportError:
        sys.exit("pypdf is required:  pip install pypdf")
    print("\nPages carrying images (candidates for transcription):")
    for path in paths:
        reader = PdfReader(path)
        print("  " + os.path.basename(path))
        for i, page in enumerate(reader.pages, start=1):
            try:
                names = [im.name for im in page.images]
            except Exception:
                continue
            # every page carries the same letterhead image; ignore it
            content = [n for n in names if not re.match(r"^Image[56]\.jpg$", n)]
            if content:
                chars = len((page.extract_text() or "").strip())
                print("    p%-3d %-40s (%d chars of text)"
                      % (i, ", ".join(content), chars))


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("rules_pdf", help="HRL Inboard Racing Rules PDF")
    ap.add_argument("annexes_pdf", help="HRL Annexes PDF")
    ap.add_argument("-o", "--out", default=DEFAULT_OUT)
    ap.add_argument("--check-images", action="store_true",
                    help="list pages that contain images, then exit")
    args = ap.parse_args()

    if args.check_images:
        report_images([args.rules_pdf, args.annexes_pdf])
        return

    with open(SUPPLEMENTS, encoding="utf-8") as fh:
        sup = json.load(fh)

    rules_records = parse_rules(extract_pages(args.rules_pdf))
    annex_records = parse_annexes(extract_pages(args.annexes_pdf),
                                  sup["annexTitles"], sup["annexClasses"])

    penalties = build_penalties(rules_records, sup.get("penaltyExtras", {}))
    records = apply_supplements(rules_records + annex_records, sup)
    records.sort(key=sort_key)

    # Drop the scraps the PDF layout leaves behind (stray captions, page
    # furniture) — anything too short to answer a question.
    records = [r for r in records if len(r.get("text", "")) >= 25]

    # Intern the section headings: 744 records share about 25 of them.
    sections = []
    section_ids = {}
    for rec in records:
        for key, out_key in (("section", "sec"), ("group", "grp")):
            value = rec.get(key)
            rec.pop(key, None)
            if not value:
                continue
            if value not in section_ids:
                section_ids[value] = len(sections)
                sections.append(value)
            rec[out_key] = section_ids[value]

        rec["ourClass"] = ("ALL" in rec["classes"]) or (OUR_CLASS in rec["classes"])
        for key in ("seg", "penalties", "refs", "note", "kind", "terms"):
            if not rec.get(key):
                rec.pop(key, None)

    index = {
        "sections": sections,
        "generated": True,
        "season": sup["season"],
        "seasonEndsAfter": sup["seasonEndsAfter"],
        "seasonEndLabel": sup["seasonEndLabel"],
        "ourClass": OUR_CLASS,
        "classLabels": CLASS_LABELS,
        "sources": sup["sources"],
        "annexTitles": sup["annexTitles"],
        "penalties": penalties,
        "aliases": sup.get("aliases", {}),
        "synonyms": sup.get("synonyms", {}),
        "records": records,
    }

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(index, fh, ensure_ascii=False, separators=(",", ":"))

    size = os.path.getsize(args.out)
    ours = sum(1 for r in records if r["ourClass"])
    print("wrote %s" % os.path.relpath(args.out, ROOT))
    print("  %d rules  (%d apply to Formula F, %d other classes)"
          % (len(records), ours, len(records) - ours))
    print("  %d penalty cards  ·  %d transcribed tables  ·  %.0f KB"
          % (len(penalties), len(sup.get("records", [])), size / 1024.0))


if __name__ == "__main__":
    main()
