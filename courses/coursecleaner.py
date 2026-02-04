"""
coursecleaner.py - Cleans raw Ellucian course JSON into normalized format.
Parses prerequisite text into structured requirement trees.
"""
import json
import re
from pathlib import Path
from typing import Any, List, Dict, Optional

_SCRIPT_DIR = Path(__file__).resolve().parent

UNWANTED_KEYS = {
    "FullTitleDisplay",
    "TermsAndSections",
    "LocationsDisplay",
    "HasSections",
    "LocationCycleRestrictionDescriptions",
    "CreditsCeusDisplay",
    "CreditsDisplayLabel",
    "MatchingSectionIds",
    "Ceus",
    "TermSessionCycle",
    "TermYearlyCycle",
    "YearsOffered",
    "TermsOffered",
    "LocationCodes",
    "IsPseudoCourse",
    "EquatedCourseIds",
    "LocationCycleRestrictions",
    "VerifyGrades",
    "ShowDropRoster",
    "SubjectCode",
    "Number",
    "CorequisiteCourseId",
    "IsProtected",
    "ReferencesInvalidCourseOrSection",
}

CODE_RE = re.compile(r"([A-Za-z]+)-(\d+)")
COURSE_TOKEN_RE = re.compile(r"([A-Za-z]{2,})\s*-?\s*(\d+[A-Za-z-]*)")

def transform_course_title(value: Any) -> Any:
  if isinstance(value, str):
    return CODE_RE.sub(r"\1 \2", value)
  return value

def split_top_level(text: str, sep_word: str) -> List[str]:
  """Split by the logical word only at top level (ignore () and [])."""
  res, i, start, n = [], 0, 0, len(text)
  lower, sep = text.lower(), f" {sep_word.lower()} "
  L = len(sep)
  bdepth = pdepth = 0
  while i < n:
    ch = text[i]
    if ch == '[': bdepth += 1
    elif ch == ']': bdepth = max(0, bdepth - 1)
    elif ch == '(': pdepth += 1
    elif ch == ')': pdepth = max(0, pdepth - 1)
    elif bdepth == 0 and pdepth == 0 and lower.startswith(sep, i):
      seg = text[start:i].strip()
      if seg: res.append(seg)
      i += L; start = i; continue
    i += 1
  tail = text[start:].strip()
  if tail: res.append(tail)
  return res

def strip_outer_brackets(s: str) -> str:
  """Strip one full pair of surrounding [] if they wrap the entire string."""
  s = s.strip()
  if not (s.startswith("[") and s.endswith("]")):
    return s
  depth = 0
  for i, ch in enumerate(s):
    if ch == "[": depth += 1
    elif ch == "]":
      depth -= 1
      if depth == 0 and i != len(s) - 1:
        return s
  return s[1:-1].strip()

def has_course_codes(text: str) -> bool:
  """Check if text contains any course codes."""
  return bool(COURSE_TOKEN_RE.search(text))

def parse_requirement_text(text: str) -> Optional[Dict[str, Any]]:
  """Parse prerequisite text into a small boolean tree (AND/OR/leaves)."""
  if not text or not text.strip():
    return None
  s = text.strip()
  s = re.sub(r"\([^)]*or concurrent enrollment[^)]*\)", "", s, flags=re.I).strip()
  s = strip_outer_brackets(s)

  if has_course_codes(s):
    and_parts = split_top_level(s, "and")
    if len(and_parts) > 1:
      nodes = [parse_requirement_text(p) for p in and_parts]
      nodes = [n for n in nodes if n]
      return {"op": "AND", "nodes": nodes} if nodes else None

    or_parts = split_top_level(s, "or")
    if len(or_parts) > 1:
      nodes = [parse_requirement_text(p) for p in or_parts]
      nodes = [n for n in nodes if n]
      return {"op": "OR", "nodes": nodes} if nodes else None

  s_noparen = re.sub(r"\([^)]*\)", "", s).strip()
  s_noparen = strip_outer_brackets(s_noparen)
  courses = [f"{m.group(1).upper()} {m.group(2)}" for m in COURSE_TOKEN_RE.finditer(s_noparen)]

  if not courses:
    return {"text": s}
  if len(courses) == 1:
    return {"course": courses[0]}
  return {"op": "OR", "nodes": [{"course": c} for c in courses]}

def annotate_leaves(node: Any, meta: Dict[str, Any]) -> Any:
  """Copy RequisiteId/IsRequired/CompletionOrder onto every leaf."""
  if not isinstance(node, dict):
    return node
  if "op" in node and isinstance(node.get("nodes"), list):
    return {"op": node["op"], "nodes": [annotate_leaves(ch, meta) for ch in node["nodes"]]}
  new_leaf = dict(node)
  for k in ("RequisiteId", "IsRequired", "CompletionOrder"):
    if meta.get(k) is not None:
      new_leaf[k] = meta[k]
  return new_leaf

def combine_with_and(trees: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
  """Combine multiple trees with AND and flatten nested ANDs."""
  trees = [t for t in trees if t]
  if not trees:
    return None
  if len(trees) == 1:
    return trees[0]
  nodes: List[Any] = []
  for t in trees:
    if isinstance(t, dict) and t.get("op") == "AND" and isinstance(t.get("nodes"), list):
      nodes.extend(t["nodes"])
    else:
      nodes.append(t)
  return {"op": "AND", "nodes": nodes}

def prune_empty(item: Any) -> Any:
  """Recursively remove None, empty dicts, and empty lists."""
  if isinstance(item, dict):
    cleaned = {k: prune_empty(v) for k, v in item.items() if v is not None}
    cleaned = {k: v for k, v in cleaned.items() if not (v == {} or v == [])}
    return cleaned
  if isinstance(item, list):
    cleaned = [prune_empty(v) for v in item]
    cleaned = [v for v in cleaned if v not in (None, {}, [])]
    return cleaned
  return item

def clean_item(item: Any) -> Any:
  if isinstance(item, dict):
    new_item = {}
    for k, v in item.items():
      if k in UNWANTED_KEYS:
        continue
      if k == "CourseTitleDisplay":
        new_item["CourseCode"] = transform_course_title(v)
      else:
        new_item[k] = clean_item(v)

    if "Requisites" in new_item:
      mapping = {
        str(r.get("RequirementCode")): r.get("CompletionOrder")
        for r in (new_item.get("Requisites") or [])
        if isinstance(r, dict) and r.get("RequirementCode") is not None
      }
      cr_list = new_item.get("CourseRequisites")
      if isinstance(cr_list, list):
        for cr in cr_list:
          if isinstance(cr, dict):
            rid = cr.get("RequisiteId")
            if rid is not None and str(rid) in mapping:
              cr["CompletionOrder"] = mapping[str(rid)]

    # Build RequirementTree at course level and annotate leaves with meta
    if isinstance(new_item.get("CourseRequisites"), list):
      trees = []
      for cr in new_item["CourseRequisites"]:
        if not isinstance(cr, dict):
          continue
        tree = parse_requirement_text(cr.get("DisplayText", ""))
        if not tree:
          continue
        meta = {
          "RequisiteId": cr.get("RequisiteId"),
          "IsRequired": cr.get("IsRequired"),
          "CompletionOrder": cr.get("CompletionOrder"),
        }
        trees.append(annotate_leaves(tree, meta))
      combined = combine_with_and(trees)
      if combined:
        new_item["RequirementTree"] = combined

    new_item.pop("CourseRequisites", None)
    new_item.pop("Requisites", None)

    return prune_empty(new_item)

  if isinstance(item, list):
    return [clean_item(i) for i in item]

  return item

def clean_courses_file(input_file="courses.json", output_file="courses_cleaned.json"):
  inp = Path(input_file) if Path(input_file).is_absolute() else _SCRIPT_DIR / input_file
  out = Path(output_file) if Path(output_file).is_absolute() else _SCRIPT_DIR / output_file
  with open(inp, "r", encoding="utf-8") as f:
    data = json.load(f)

  courses = data.get("CourseFullModels", [])
  cleaned = clean_item(courses)

  with open(out, "w", encoding="utf-8") as f:
    json.dump(cleaned, f, indent=2, ensure_ascii=False)

if __name__ == "__main__":
  clean_courses_file()
