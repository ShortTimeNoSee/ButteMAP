"""
extract_exam_credit.py - Parses AP/IB/CLEP exam credit HTML tables from Butte College website.
Outputs structured JSON for exam-to-GE-area mappings and course equivalencies.
"""
import sys
import json
import re
from pathlib import Path
from typing import List, Dict, Any, Optional, Tuple
from bs4 import BeautifulSoup

COURSE_TOKEN_RE = re.compile(r"\b([A-Za-z]{2,})\s*(?:-?\s*([A-Za-z]?\d+[A-Za-z-]*))\b")
NUM_RE = re.compile(r"(\*+)?\s*(\d+(?:\.\d+)?)(\*+)?")
ONLY_GE_RE = re.compile(r"only\s+(\d+(?:\.\d+)?)\s*GE", re.I)
AREA_RE = re.compile(
  r"\bAreas?\s+[0-9A-Z]+(?:\s*(?:&|or)\s*(?:US\d+|[0-9A-Z]+))*",
  re.I
)

def clean_text(html) -> str:
  """Extract visible text; normalize spaces; preserve newlines as record separators."""
  if html is None:
    return ""
  pieces = []
  if hasattr(html, "descendants"):
    for elem in html.descendants:
      if getattr(elem, "name", None) == "br":
        pieces.append("\n")
      elif isinstance(elem, str):
        pieces.append(elem)
    text = "".join(pieces)
  else:
    text = str(html)
  lines = [re.sub(r"\s+", " ", ln).strip() for ln in text.split("\n")]
  text = "\n".join([ln for ln in lines if ln])
  text = text.replace("\xa0", " ")
  text = re.sub(r"\s*/\s*", "/", text)
  return text.strip()

def parse_number(s: str) -> Tuple[Optional[float], Optional[str], Optional[str]]:
  """Return (number, asterisks, leftover_text). Captures leading/trailing '*' and removes the matched number from leftover."""
  if not s:
    return None, None, None
  m = NUM_RE.search(s)
  if not m:
    return None, None, s if s else None
  num = float(m.group(2))
  stars = "".join([p for p in (m.group(1), m.group(3)) if p]) or None
  start, end = m.span()
  leftover = (s[:start] + s[end:]).strip() or None
  return num, stars, leftover

def parse_only_ge_cap(s: str) -> Optional[float]:
  """Extract 'only X GE' unit caps."""
  if not s:
    return None
  m = ONLY_GE_RE.search(s)
  return float(m.group(1)) if m else None

def extract_courses(s: str) -> List[str]:
  """Find course tokens like 'MATH 30' and dedupe; ignore 'Area' noise and generic tokens."""
  if not s:
    return []
  courses = []
  lowered = s.lower()
  bad_depts = {"AREA", "SCORE", "OR", "AND", "US"}
  for m in COURSE_TOKEN_RE.finditer(s):
    start = m.start()
    if "area" in lowered[max(0, start - 6):start]:
      continue
    dept = m.group(1).upper()
    if dept in bad_depts:
      continue
    num = m.group(2)
    courses.append(f"{dept} {num}")
  return sorted(set(courses))

def extract_area(s: str) -> Optional[str]:
  """Return the longest 'Area ...' span (keeps combined patterns like 'Area 3A or 3B' or 'Area 4 & US1')."""
  if not s:
    return None
  matches = AREA_RE.findall(s)
  if matches:
    cand = max(matches, key=len)
    return re.sub(r"\s+", " ", cand).strip()
  t = s.strip()
  return t if t and t.upper() != "N/A" else None

def is_limitation_row(exam_name: str) -> bool:
  tokens = exam_name.lower()
  return ("limitation" in tokens) or ("limit" in tokens)

def simplify_na(s: Optional[str]) -> Optional[str]:
  if not s:
    return None
  t = s.strip()
  return None if not t or t.upper() in {"N/A", "NA"} else t

NA_TOKENS = {"N/A", "NA", "—", "-", ""}

def meaningful(chunk: Optional[str]) -> bool:
  if not chunk:
    return False
  t = chunk.strip().upper().replace("\u00a0", " ")
  return t not in NA_TOKENS and t != "UNITS,"

def parse_ap_score_ranges(s: str) -> tuple[Optional[int], Optional[int]]:
  """Extract min/max AP scores from text like 'Score 3 ... Score 4/5 ...'."""
  if not s:
    return None, None
  score_matches = re.findall(r"Score\s+(\d+)(?:/([\d/]+))?", s, re.I)
  if not score_matches:
    return None, None
  scores = []
  for match in score_matches:
    primary = int(match[0])
    scores.append(primary)
    if match[1]:
      for score_str in match[1].split("/"):
        if score_str.isdigit():
          scores.append(int(score_str))
  return (min(scores), max(scores)) if scores else (None, None)

def cell_val(td) -> str:
  return clean_text(td)

def parse_ap_table(soup: BeautifulSoup) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
  rows = soup.select("table tbody tr")
  data: List[Dict[str, Any]] = []
  notes: List[Dict[str, Any]] = []

  # Header sniffing (robust to minor variations)
  header_trs = soup.select("table thead tr")
  colnames = []
  if header_trs:
    head = max(header_trs, key=lambda tr: len(tr.find_all(["td", "th"])))
    for th in head.find_all(["td", "th"]):
      colnames.append(clean_text(th).lower())

  # Fallback mapping by position:
  # 0 AP Exam, 1 Butte GE Area & Course, 2 Semester Units, 3 CSU GE Area,
  # 4 CSU GE Units, 5 CSU Transfer Units, 6 Cal-GETC GE Area, 7 Cal-GETC GE Units, 8 UC Units
  for tr in rows:
    tds = tr.find_all("td")
    if len(tds) < 3:
      continue
    exam = cell_val(tds[0])
    if not exam:
      continue
    if exam.lower().strip() in {"ap exam"}:
      continue
    if is_limitation_row(exam):
      note_text = " ".join([cell_val(td) for td in tds[1:]]).strip()
      notes.append({"program": "AP", "exam": exam, "note": note_text})
      continue

    def td_text(i): return cell_val(tds[i]) if i < len(tds) else ""
    butte_ge_area_course = td_text(1)
    butte_sem_units_raw = td_text(2)
    csu_ge_area_raw = td_text(3)
    csu_ge_units_raw = td_text(4)
    csu_transfer_units_raw = td_text(5)
    cal_getc_area_raw = td_text(6)
    cal_getc_units_raw = td_text(7)
    uc_units_raw = td_text(8)

    courses = extract_courses(butte_ge_area_course)
    butte_area = extract_area(butte_ge_area_course)
    min_score, max_score = parse_ap_score_ranges(butte_ge_area_course)

    butte_units, butte_stars, butte_left = parse_number(butte_sem_units_raw)
    butte_ge_cap = parse_only_ge_cap(butte_sem_units_raw)

    csu_ge_area = extract_area(csu_ge_area_raw)
    csu_ge_units, csu_stars1, csu_left1 = parse_number(csu_ge_units_raw)
    csu_transfer_units, csu_stars2, csu_left2 = parse_number(csu_transfer_units_raw)

    cal_getc_area = extract_area(cal_getc_area_raw)
    cal_getc_units, getc_stars, getc_left = parse_number(cal_getc_units_raw)

    uc_transfer_units, uc_stars, uc_left = parse_number(uc_units_raw)

    notes_blob = []
    for chunk in [butte_left, csu_left1, csu_left2, getc_left, uc_left]:
      if meaningful(chunk):
        notes_blob.append(chunk)
    for label, stars in [("Butte", butte_stars), ("CSU_GE", csu_stars1),
                         ("CSU_Transfer", csu_stars2), ("Cal-GETC", getc_stars),
                         ("UC", uc_stars)]:
      if stars:
        notes_blob.append(f"{label} column footnote: {stars}")

    data.append({
      "program": "AP",
      "exam": exam,
      "min_score_butte_csu": min_score,
      "min_score_cal_getc": None,
      "score_cutoff": max_score,
      "butte_ge_area": simplify_na(butte_area),
      "butte_course_equivalencies": courses or None,
      "butte_units": butte_units,
      "butte_ge_units_cap": butte_ge_cap,
      "csu_ge_area": simplify_na(csu_ge_area),
      "csu_ge_units": csu_ge_units,
      "csu_transfer_units": csu_transfer_units,
      "cal_getc_area": simplify_na(cal_getc_area),
      "cal_getc_units": cal_getc_units,
      "uc_transfer_units": uc_transfer_units,
      "notes": " | ".join(notes_blob) if notes_blob else None
    })

  return data, notes

def parse_ib_table(soup: BeautifulSoup) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
  rows = soup.select("table tbody tr")
  data: List[Dict[str, Any]] = []
  notes: List[Dict[str, Any]] = []

  # Column positions:
  # 0 Exam, 1 Min Score (Butte & CSU), 2 Butte GE Area, 3 Units Toward Butte Degree,
  # 4 CSU Sem Units, 5 CSU GE Units, 6 CSU GE Area, 7 Min Score Cal-GETC,
  # 8 Cal-GETC Area, 9 Cal-GETC Units
  for tr in rows:
    tds = tr.find_all("td")
    if len(tds) < 3:
      continue
    exam = cell_val(tds[0]).strip()
    if not exam:
      continue

    def td_text(i): return cell_val(tds[i]) if i < len(tds) else ""

    min_score_butte_csu_raw = td_text(1)
    butte_ge_area_raw = td_text(2)
    butte_units_raw = td_text(3)
    csu_sem_units_raw = td_text(4)
    csu_ge_units_raw = td_text(5)
    csu_ge_area_raw = td_text(6)
    min_score_getc_raw = td_text(7)
    cal_getc_area_raw = td_text(8)
    cal_getc_units_raw = td_text(9)

    min_score_butte_csu, _, _ = parse_number(min_score_butte_csu_raw)
    min_score_cal_getc, _, _ = parse_number(min_score_getc_raw)

    butte_area = extract_area(butte_ge_area_raw)
    butte_units, _, butte_left = parse_number(butte_units_raw)

    csu_sem_units, _, csu_sem_left = parse_number(csu_sem_units_raw)
    csu_ge_units, _, csu_ge_left = parse_number(csu_ge_units_raw)
    csu_ge_area = extract_area(csu_ge_area_raw)

    cal_getc_area = extract_area(cal_getc_area_raw)
    cal_getc_units, _, getc_left = parse_number(cal_getc_units_raw)

    notes_blob = []
    for chunk in [butte_left, csu_sem_left, csu_ge_left, getc_left]:
      if meaningful(chunk):
        notes_blob.append(chunk)

    data.append({
      "program": "IB",
      "exam": exam,
      "min_score_butte_csu": int(min_score_butte_csu) if min_score_butte_csu is not None else None,
      "min_score_cal_getc": int(min_score_cal_getc) if min_score_cal_getc is not None else None,
      "score_cutoff": None,
      "butte_ge_area": simplify_na(butte_area),
      "butte_course_equivalencies": None,
      "butte_units": butte_units,
      "butte_ge_units_cap": None,
      "csu_ge_area": simplify_na(csu_ge_area),
      "csu_ge_units": csu_ge_units,
      "csu_transfer_units": csu_sem_units,  # systemwide semester units earned
      "cal_getc_area": simplify_na(cal_getc_area),
      "cal_getc_units": cal_getc_units,
      "uc_transfer_units": 5.3,  # UC policy for HL 5–7
      "notes": " | ".join(notes_blob) if notes_blob else None
    })

  return data, notes

def parse_clep_table(soup: BeautifulSoup) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
  rows = soup.select("table tbody tr")
  data: List[Dict[str, Any]] = []
  notes: List[Dict[str, Any]] = []

  # Column positions:
  # 0 Exam, 1 Score, 2 Butte GE Area, 3 Semester Units (Butte),
  # 4 CSU GE Area, 5 CSU GE Units Earned, 6 CSU Transfer Units Earned
  for tr in rows:
    tds = tr.find_all("td")
    if len(tds) < 3:
      continue
    exam = cell_val(tds[0]).strip()
    if not exam or exam.lower().startswith("clep exam"):
      continue

    def td_text(i): return cell_val(tds[i]) if i < len(tds) else ""

    score_raw = td_text(1)
    butte_ge_area_raw = td_text(2)
    butte_units_raw = td_text(3)
    csu_ge_area_raw = td_text(4)
    csu_ge_units_raw = td_text(5)
    csu_transfer_units_raw = td_text(6)

    score, _, _ = parse_number(score_raw)
    butte_area = extract_area(butte_ge_area_raw)
    butte_units, _, butte_left = parse_number(butte_units_raw)

    csu_ge_area = extract_area(csu_ge_area_raw)
    csu_ge_units, _, csu_left1 = parse_number(csu_ge_units_raw)
    csu_transfer_units, _, csu_left2 = parse_number(csu_transfer_units_raw)

    notes_blob = [c for c in [butte_left, csu_left1, csu_left2] if meaningful(c)]

    data.append({
      "program": "CLEP",
      "exam": exam.replace("\n", " "),
      "min_score_butte_csu": None,
      "min_score_cal_getc": None,
      "score_cutoff": int(score) if score is not None else None,
      "butte_ge_area": simplify_na(butte_area),
      "butte_course_equivalencies": None,
      "butte_units": butte_units,
      "butte_ge_units_cap": None,
      "csu_ge_area": simplify_na(csu_ge_area),
      "csu_ge_units": csu_ge_units,
      "csu_transfer_units": csu_transfer_units,
      "cal_getc_area": None,  # CLEP not applicable to Cal-GETC
      "cal_getc_units": None,
      "uc_transfer_units": None,
      "notes": " | ".join(notes_blob) if notes_blob else None
    })

  return data, notes

GLOBAL_NOTES = {
  "AP": [
    "Credit granted for AP scores of 3, 4, or 5; units are semester unless noted.",
    "Official AP results must be sent from College Board to Butte College Admissions & Records.",
    "Use of AP for Butte credit/GE/major per Butte policy; Cal-GETC per Butte and Cal-GETC policy.",
    "CSU info reflects systemwide policy and applies only to CSU transfers without GE certification.",
    "Course credit/units at Butte may differ from a transfer institution.",
    "If no Butte equivalency, major credit may be approved via substitution by department."
  ],
  "IB": [
    "IB credit applies to HL exams; official results required.",
    "IB can meet Cal-GETC and Butte GE/major per policies.",
    "Cal-GETC requires HL score 5/6/7; equates to 3 semester units.",
    "For transfer, UC grants 5.3 semester units for each HL exam with 5/6/7.",
    "CSU info reflects systemwide policy and applies only to CSU transfers without GE certification.",
    "IB credit at Butte may differ from transfer institutions."
  ],
  "CLEP": [
    "CLEP credit cannot be applied to Cal-GETC.",
    "CLEP can be used for CSU GE and AA/AS GE/major per policies.",
    "Official CLEP results must be sent to Butte College Admissions & Records.",
    "All units are semester unless noted.",
    "If no Butte equivalency, major credit may be via department substitution petition.",
    "Butte vs. transfer institution credits/units may differ.",
    "Language CLEP: if more than one in same language, only one may be applied; Level I=6 units, Level II adds units and Area 3B per CSU GE note."
  ]
}

def soup_from_file(path: Path) -> BeautifulSoup:
  html = path.read_text(encoding="utf-8")
  return BeautifulSoup(html, "html.parser")

def main():
  if len(sys.argv) < 2:
    print("Usage: python extract_exam_credit.py AP.html IB.html CLEP.html")
    sys.exit(1)

  in_paths = [Path(p) for p in sys.argv[1:]]
  ap_rows: List[Dict[str, Any]] = []
  ib_rows: List[Dict[str, Any]] = []
  clep_rows: List[Dict[str, Any]] = []
  all_notes: List[Dict[str, Any]] = []

  for p in in_paths:
    soup = soup_from_file(p)
    name = p.name.lower()
    if "ap" in name:
      rows, notes = parse_ap_table(soup)
      ap_rows.extend(rows)
      all_notes.extend([{"program": "AP", **n} for n in notes])
      for n in GLOBAL_NOTES["AP"]:
        all_notes.append({"program": "AP", "exam": None, "note": n})
    elif "ib" in name:
      rows, notes = parse_ib_table(soup)
      ib_rows.extend(rows)
      all_notes.extend([{"program": "IB", **n} for n in notes])
      for n in GLOBAL_NOTES["IB"]:
        all_notes.append({"program": "IB", "exam": None, "note": n})
    elif "clep" in name:
      rows, notes = parse_clep_table(soup)
      clep_rows.extend(rows)
      all_notes.extend([{"program": "CLEP", **n} for n in notes])
      for n in GLOBAL_NOTES["CLEP"]:
        all_notes.append({"program": "CLEP", "exam": None, "note": n})
    else:
      print(f"Skipped unrecognized file: {p}")

  def dump(path: str, obj: Any):
    with open(path, "w", encoding="utf-8") as f:
      json.dump(obj, f, indent=2, ensure_ascii=False)

  if ap_rows:
    dump("exams_ap.json", ap_rows)
  if ib_rows:
    dump("exams_ib.json", ib_rows)
  if clep_rows:
    dump("exams_clep.json", clep_rows)
  if all_notes:
    dump("exams_notes.json", all_notes)

  print(
    "Done:",
    f"{len(ap_rows)} AP rows,",
    f"{len(ib_rows)} IB rows,",
    f"{len(clep_rows)} CLEP rows,",
    f"{len(all_notes)} notes",
  )

if __name__ == "__main__":
  main()
