#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Fast Butte College program scraper → cleaned/minimal program JSON.
Writes programs_YYYY.json where YYYY = 2010 + yearId (e.g., 08 → 2018).
"""

import argparse
import asyncio
import json
import logging
import random
import re
import sys
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import quote, urljoin

import aiohttp
from aiohttp import ClientTimeout
from bs4 import BeautifulSoup

# ---- Config ----
BASE = "https://programs.butte.edu"
LIST_PATH_TMPL = "/ProgramList/All/{year_id}/false"
INFO_PARAM_TMPL = BASE + "/ProgramInfo?yearId={year_id}&colleagueProgramCode={code_enc}"

DEFAULT_START_YEAR_ID = 8          # 08 => 2018–2019
DEFAULT_CONCURRENCY = 64
DEFAULT_RETRIES = 6
REQUEST_TIMEOUT = 30               # seconds
MAX_CONSEC_SERVER_ERRORS = 2
SLEEP_BETWEEN_YEARS = 0.05

# ---- Logging ----
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-7s %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("butte-scraper")

# ---- Utilities ----

WORD2NUM = {
    "one": 1, "two": 2, "three": 3, "four": 4, "five": 5,
    "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10,
}

def word_or_int(x: str) -> Optional[int]:
    x = x.strip().lower()
    if x.isdigit():
        return int(x)
    return WORD2NUM.get(x)

# Headers like "List A (Select one)"
LIST_HEADER_RE = re.compile(r"^\s*(List\s+[A-Z])\s*(?:\((.*?)\))?:?\s*$", re.IGNORECASE)

# Global rule like: Select 10 units minimum ... with at least 3 units from List A
GLOBAL_UNIT_RULE_RE = re.compile(
    r"Select\s+(\d+)\s+units\s+minimum\s+from\s+the\s+lists\s+below,\s+with\s+at\s+least\s+(\d+)\s+units\s+from\s+(List\s+[A-Z])",
    re.IGNORECASE,
)

# "Select X units ... at least Y units from each area: ..."
SELECT_UNITS_EACH_AREA_RE = re.compile(
    r"^\s*Select\s+(\w+)\s+units.*?at\s+least\s+(\w+)\s+units?\s+from\s+each\s+area\s*:\s*(.+?)\s*$",
    re.IGNORECASE,
)

# "Select X units from at least N disciplines"
SELECT_UNITS_MIN_DISCIPLINES_RE = re.compile(
    r"^\s*Select\s+(\w+)\s+units\s+from\s+at\s+least\s+(\d+)\s+disciplines\s*:?\s*$",
    re.IGNORECASE,
)

# 1. Standard Areas ending in colon
AREA_HEADER_RE = re.compile(r"^\s*(?!Select\b)([A-Za-z][A-Za-z\s/&-,()]*[A-Za-z)])\s*:\s*$", re.IGNORECASE)

# 2. Emphasis/Option/Group headers (often missing colons)
# Matches "Ecological Restoration Emphasis", "Chemistry Option", "Group 1"
# Must NOT match "Select..." lines
IMPLIED_HEADER_RE = re.compile(r"^\s*(?!Select\b|Complete\b|Required\b)(.+?(?:Emphasis|Option|Group|Track)\b.*?)(?::)?\s*$", re.IGNORECASE)

SELECT_UNITS_RE = re.compile(r"^\s*Select\s+(\w+)\s+units?\b.*?:?\s*$", re.IGNORECASE)
SELECT_N_RE = re.compile(r"^\s*Select\s+(\w+)\b(?!.*\bunits\b).*?:?\s*$", re.IGNORECASE)

def parse_rule_clause(clause: Optional[str]) -> Dict[str, Any]:
    """Return COUNT rule; supports ranges and 'allow_from' borrowing."""
    rule: Dict[str, Any] = {"type": "COUNT", "min": 1, "max": 1}
    if not clause:
        return rule

    txt = clause.strip()

    m = re.search(r"Select\s+(\w+)\s+to\s+(\w+)", txt, re.IGNORECASE)
    if m:
        mn = word_or_int(m.group(1)); mx = word_or_int(m.group(2))
        if mn and mx:
            return {"type": "COUNT", "min": mn, "max": mx}

    m2 = re.search(r"Select\s+(\w+)", txt, re.IGNORECASE)
    if m2:
        n = word_or_int(m2.group(1))
        if n:
            rule.update({"min": n, "max": n})

    m3 = re.search(r"any\s+course\s+from\s+(.+?)\s+not\s+already\s+used", txt, re.IGNORECASE)
    if m3:
        raw = m3.group(1)
        tokens = re.findall(r"(?:List\s+)?([A-Z])\b", raw, re.IGNORECASE)
        allow_from = [f"List {t.upper()}" for t in tokens]
        if allow_from:
            rule["allow_from"] = allow_from

    return rule

def parse_list_header_text(txt: str) -> Tuple[Optional[str], Optional[Dict[str, Any]]]:
    """Return (section_name, rule) for a List header or 'Required courses' block."""
    s = safe_text(txt)
    if re.search(r"^Required courses?:?$", s, re.IGNORECASE):
        return ("Required courses", {"type": "ALL"})
    m = LIST_HEADER_RE.match(s)
    if m:
        name = safe_text(m.group(1))
        clause = safe_text(m.group(2)) if m.group(2) else None
        return (name, parse_rule_clause(clause))
    return (None, None)

def extract_row_units(div) -> Optional[float]:
    cols = div.find_all("div", class_=re.compile(r"col-md-\d+"))
    last = cols[-1] if cols else None
    val = text_of(last)
    return parse_number(val)

def new_item_with_option(code: str, units: Optional[float]) -> Dict[str, Any]:
    return {"any_of": [{"code": code, "units": units}]}

def to_two_digit_year_id(n: int) -> str:
    return f"{n:02d}"

def year_id_to_years(year_id: int) -> Tuple[int, int]:
    start = 2010 + year_id
    return start, start + 1

def safe_text(x: Optional[str]) -> str:
    if not x:
        return ""
    return re.sub(r"\s+", " ", x).strip()

def text_of(tag) -> str:
    return safe_text(tag.get_text(" ", strip=True)) if tag else ""

def parse_number(text: str) -> Optional[float]:
    if not text:
        return None
    m = re.search(r"(\d+(?:\.\d+)?)", text)
    return float(m.group(1)) if m else None

def parse_units_range(unit_text: str) -> Tuple[Optional[float], Optional[float]]:
    if not unit_text:
        return (None, None)
    txt = re.sub(r"\s+", " ", unit_text)
    m = re.search(r"(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)", txt)
    if m:
        return float(m.group(1)), float(m.group(2))
    m2 = re.search(r"(\d+(?:\.\d+)?)", txt)
    if m2:
        v = float(m2.group(1))
        return v, v
    return (None, None)

def normalize_course_code(raw: str) -> str:
    txt = safe_text(raw).replace("\xa0", " ")
    txt = re.sub(r"^(?:or\s+)", "", txt, flags=re.IGNORECASE)
    return safe_text(txt)

def absolute_url(path_or_url: str) -> str:
    return urljoin(BASE, path_or_url)

def prune_empty(d: Any) -> Any:
    """Recursively drop None/empty dict/list/blank strings."""
    if isinstance(d, dict):
        out = {}
        for k, v in d.items():
            v2 = prune_empty(v)
            if v2 in (None, {}, []):
                continue
            out[k] = v2
        return out if out else None
    if isinstance(d, list):
        out_list = []
        for item in d:
            it = prune_empty(item)
            if it is not None:
                out_list.append(it)
        return out_list if out_list else None
    if d is None:
        return None
    if isinstance(d, str) and d.strip() == "":
        return None
    return d

# ---- HTML parsing ----

def parse_program_list_html(html: str) -> List[Dict[str, Any]]:
    soup = BeautifulSoup(html, "lxml")
    table = soup.select_one("#scrollTable table")
    programs: List[Dict[str, Any]] = []
    if not table:
        logger.debug("No program table found in list HTML")
        return programs
    tbody = table.find("tbody")
    if not tbody:
        logger.debug("No tbody in list table")
        return programs

    for tr in tbody.find_all("tr"):
        try:
            th = tr.find("th", {"scope": "row"})
            tds = tr.find_all("td")
            if not th or len(tds) < 4:
                continue
            a = th.find("a")
            name = text_of(a) if a else text_of(th)
            href = a.get("href") if a else None
            original_info_url = absolute_url(href) if href else None
            program_type = text_of(tds[0])
            department = text_of(tds[1])
            program_code = text_of(tds[-1])
            programs.append({
                "name": name,
                "program_type": program_type,
                "department": department,
                "program_code": program_code,
                "original_info_url": original_info_url,
            })
        except Exception:
            logger.exception("Error parsing a program row; skipping")
            continue
    return programs

def extract_after_label(html_block, label: str) -> Optional[str]:
    strongs = html_block.find_all("strong")
    for st in strongs:
        if text_of(st).rstrip(":") == label.rstrip(":"):
            pieces = []
            for sib in st.next_siblings:
                if getattr(sib, "name", None) == "br":
                    break
                pieces.append(str(sib))
            val = BeautifulSoup("".join(pieces), "lxml").get_text(" ", strip=True)
            return safe_text(val)
    return None

def split_ge_patterns(ge_text: Optional[str]) -> List[str]:
    if not ge_text:
        return []
    parts = re.split(r"\s*(?:,|/| or )\s*", ge_text, flags=re.IGNORECASE)
    return [safe_text(p) for p in parts if safe_text(p)]

def parse_program_info_html_minimal(html: str) -> Dict[str, Any]:
    """Return rule-aware structure: sections + cross_list_rules."""
    soup = BeautifulSoup(html, "lxml")
    root = soup.find(id="faqOne")
    out: Dict[str, Any] = {
        "program_goal": None,
        "ge_patterns": [],
        "program_learning_outcomes": [],
        "required_units": {"min": None, "max": None},
        "sections": [],
        "cross_list_rules": [],
    }
    if not root:
        return out

    top_p = root.find("p")
    if top_p:
        pg = extract_after_label(top_p, "Program Goal:")
        gp = extract_after_label(top_p, "GE Pattern(s):")
        out["program_goal"] = safe_text(pg)
        out["ge_patterns"] = split_ge_patterns(gp)

    outcomes_ul = root.find("ul", class_="dots")
    if outcomes_ul:
        for li in outcomes_ul.find_all("li"):
            val = safe_text(text_of(li))
            if val:
                out["program_learning_outcomes"].append(val)

    req_header_rows = [div for div in root.find_all("div", class_=re.compile(r"\brow\b"))
                       if "Required courses:" in text_of(div)]
    if req_header_rows:
        header = req_header_rows[0]
        right_cols = header.select(".col-md-2")
        unit_txt = text_of(right_cols[-1]) if right_cols else text_of(header)
        mn, mx = parse_units_range(unit_txt)
        out["required_units"]["min"] = mn
        out["required_units"]["max"] = mx

    sections: List[Dict[str, Any]] = []
    current_section = {"name": "Required courses", "rule": {"type": "ALL"}, "items": []}

    # Cross-list rule applies to the next lists encountered
    pending_cross_rule: Optional[Dict[str, Any]] = None
    lists_seen_in_group: List[str] = []

    # Inline "Select N" blocks: keep appending course rows until another header appears
    select_block = {"active": False, "min": 0}

    # "Select N units ... each area" pattern
    current_units_section = None
    pending_each_area_min = None

    def flush_section():
        nonlocal current_section, sections
        if current_section and current_section.get("items"):
            sections.append(current_section)
        current_section = None

    def start_section(name: str, rule: Dict[str, Any]):
        return {"name": name, "rule": rule, "items": []}

    for div in root.find_all("div", class_=re.compile(r"\brow\b")):
        has_link = bool(div.find("a", class_="classLinks"))
        txt = text_of(div)

        # Global cross-list rule (e.g., Math)
        if not has_link:
            m_glob = GLOBAL_UNIT_RULE_RE.search(txt)
            if m_glob:
                min_total = int(m_glob.group(1))
                min_list_a = int(m_glob.group(2))
                anchor_list = safe_text(m_glob.group(3))
                pending_cross_rule = {
                    "type": "CROSS_LIST_UNITS",
                    "applies_to": [],
                    "min_units_total": min_total,
                    "per_list_min_units": {anchor_list: min_list_a},
                }
                lists_seen_in_group = []
                continue

        # Section headers
        if not has_link:
            # Check UNITS first to avoid grabbing "Select 10 units" as "Select 10"
            m_each = SELECT_UNITS_EACH_AREA_RE.match(txt)
            if m_each:
                total_units = word_or_int(m_each.group(1)) or 0
                per_area_min = word_or_int(m_each.group(2)) or 0
                flush_section()
                current_section = start_section(
                    f"Select {total_units} units",
                    {"type": "UNITS", "min_units": total_units, "allow_from": [], "per_list_min_units": {}},
                )
                select_block = {"active": False, "min": 0}
                current_units_section = current_section
                pending_each_area_min = per_area_min
                lists_seen_in_group = []
                continue

            m_disc = SELECT_UNITS_MIN_DISCIPLINES_RE.match(txt)
            if m_disc:
                total_units = word_or_int(m_disc.group(1)) or 0
                min_disciplines = int(m_disc.group(2))
                flush_section()
                current_section = start_section(
                    f"Select {total_units} units",
                    {"type": "UNITS", "min_units": total_units, "min_disciplines": min_disciplines, "discipline_from": "prefix"},
                )
                select_block = {"active": True, "min": 0}
                continue

            m_units = SELECT_UNITS_RE.match(txt)
            if m_units:
                n = word_or_int(m_units.group(1)) or 0
                flush_section()
                current_section = start_section(f"Select {n} units", {"type": "UNITS", "min_units": n})
                select_block = {"active": True, "min": 0}
                continue

            # Now check Select N (Count)
            m_sel = SELECT_N_RE.match(txt)
            if m_sel:
                n = word_or_int(m_sel.group(1)) or 1
                flush_section()
                current_section = start_section(f"Select {n}", {"type": "COUNT", "min": n, "max": n})
                select_block = {"active": True, "min": n}
                continue

            # Check for Implied Headers (Emphasis/Option/Group)
            m_implied = IMPLIED_HEADER_RE.match(txt)
            if m_implied:
                header_name = safe_text(m_implied.group(1))
                flush_section()
                # Default to LIST behavior (Select from this group)
                current_section = start_section(header_name, {"type": "LIST"})
                select_block = {"active": False, "min": 0}
                
                # Wire into units-per-area if active
                if current_units_section is not None and pending_each_area_min is not None:
                    rule = current_units_section["rule"]
                    rule.setdefault("allow_from", []).append(header_name)
                    rule.setdefault("per_list_min_units", {})[header_name] = pending_each_area_min
                    lists_seen_in_group.append(header_name)
                continue

            # Area header with colon, e.g., "Biological Sciences:"
            m_area = AREA_HEADER_RE.match(txt)
            if m_area:
                area_name = safe_text(m_area.group(1))
                flush_section()
                current_section = start_section(area_name, {"type": "LIST"})
                select_block = {"active": False, "min": 0}

                # Wire areas into the units-per-area rule
                if current_units_section is not None and pending_each_area_min is not None:
                    rule = current_units_section["rule"]
                    rule.setdefault("allow_from", []).append(area_name)
                    rule.setdefault("per_list_min_units", {})[area_name] = pending_each_area_min
                    lists_seen_in_group.append(area_name)
                continue

            # List headers (e.g., "List A (Select one)") and Required courses
            name, rule = parse_list_header_text(txt)
            if name:
                flush_section()
                current_section = start_section(name, rule)
                select_block = {"active": False, "min": 0}
                if pending_cross_rule and name.startswith("List "):
                    lists_seen_in_group.append(name)
                    pending_cross_rule["applies_to"] = lists_seen_in_group
                continue

        # Course row
        link = div.find("a", class_="classLinks")
        if link:
            cols = link.find_all("div", class_=re.compile(r"col-md-\d+"))
            code_raw = text_of(cols[0]) if len(cols) >= 1 else ""
            code_clean = normalize_course_code(code_raw)
            units = extract_row_units(link)
            is_or = bool(re.match(r"^\s*or\b", safe_text(code_raw), flags=re.IGNORECASE))

            if select_block["active"]:
                if is_or and current_section["items"]:
                    prev = current_section["items"][-1]
                    prev.setdefault("any_of", []).append({"code": code_clean, "units": units})
                else:
                    current_section["items"].append(new_item_with_option(code_clean, units))
                continue

            if is_or and current_section and current_section["items"]:
                prev = current_section["items"][-1]
                prev.setdefault("any_of", [])
                prev["any_of"].append({"code": code_clean, "units": units})
            else:
                if current_section is None:
                    current_section = start_section("Required courses", {"type": "ALL"})
                current_section["items"].append(new_item_with_option(code_clean, units))

    flush_section()
    out["sections"] = sections

    if pending_cross_rule and pending_cross_rule.get("applies_to"):
        out["cross_list_rules"].append(pending_cross_rule)

    if current_units_section and lists_seen_in_group:
        out["cross_list_rules"].append({
            "type": "CROSS_LIST_UNITS",
            "applies_to": lists_seen_in_group,
            "min_units_total": current_units_section["rule"]["min_units"],
            "per_list_min_units": current_units_section["rule"]["per_list_min_units"],
        })

    return prune_empty(out) or {}

# ---- Async HTTP + retry ----

async def exponential_backoff_sleep(attempt: int, base: float = 0.2, cap: float = 6.0):
    jitter = random.random() * 0.1 * base
    wait = min(cap, base * (2 ** attempt) + jitter)
    await asyncio.sleep(wait)

async def fetch_text_with_retries(session: aiohttp.ClientSession, url: str, retries: int) -> Tuple[Optional[str], int]:
    last_status = 0
    for attempt in range(retries):
        try:
            timeout = ClientTimeout(total=REQUEST_TIMEOUT)
            async with session.get(url, timeout=timeout) as resp:
                text = await resp.text()
                last_status = resp.status
                if 200 <= resp.status < 400:
                    return text, resp.status
                if resp.status == 404:
                    return None, resp.status
                logger.debug("Non-OK status %s for %s (attempt %d/%d)", resp.status, url, attempt + 1, retries)
        except asyncio.TimeoutError:
            logger.debug("Timeout for %s on attempt %d/%d", url, attempt + 1, retries)
        except Exception as e:
            logger.debug("Fetch exception for %s attempt %d/%d: %s", url, attempt + 1, retries, e)
        await exponential_backoff_sleep(attempt)
    return None, last_status

# ---- Core async flows ----

async def fetch_program_info_worker(
    semaphore: asyncio.Semaphore,
    session: aiohttp.ClientSession,
    program: Dict[str, Any],
    year_id: int,
    retries: int,
) -> Dict[str, Any]:
    async with semaphore:
        name = program.get("name")
        code = program.get("program_code")
        logger.debug("Fetching program info for %s (%s)", name, code)
        result: Dict[str, Any] = {
            "name": name,
            "program_type": program.get("program_type"),
            "department": program.get("department"),
            "program_code": code,
            "year_id": to_two_digit_year_id(year_id),
            "year_label": f"{year_id_to_years(year_id)[0]}-{year_id_to_years(year_id)[1]}",
            "detail": None,
            "errors": [],
        }
        code_enc = quote(code or "", safe="")
        param_url = INFO_PARAM_TMPL.format(year_id=to_two_digit_year_id(year_id), code_enc=code_enc)
        html, status = await fetch_text_with_retries(session, param_url, retries)
        if html:
            try:
                parsed = parse_program_info_html_minimal(html)
                result["detail"] = parsed
                logger.info("OK  param URL %s -> %s", param_url, name)
                return prune_empty(result) or {}
            except Exception as e:
                logger.warning("Parse error (param) for %s: %s", name, e)
                result["errors"].append(f"parse param error: {e}")
        else:
            logger.debug("Param URL failed status=%s for %s", status, name)

        fallback = program.get("original_info_url")
        if fallback:
            html2, status2 = await fetch_text_with_retries(session, fallback, retries)
            if html2:
                try:
                    parsed2 = parse_program_info_html_minimal(html2)
                    result["detail"] = parsed2
                    logger.info("OK  fallback URL %s -> %s", fallback, name)
                    return prune_empty(result) or {}
                except Exception as e:
                    logger.warning("Parse error (fallback) for %s: %s", name, e)
                    result["errors"].append(f"parse fallback error: {e}")
            else:
                logger.debug("Fallback URL failed status=%s for %s", status2, name)
                result["errors"].append(f"fallback fetch failed status={status2}")
        else:
            result["errors"].append("no fallback URL provided")

        return prune_empty(result) or {}

async def process_year_async(
    session: aiohttp.ClientSession,
    year_id: int,
    concurrency: int,
    retries: int,
) -> Dict[str, Any]:
    start_year, end_year = year_id_to_years(year_id)
    list_url = absolute_url(LIST_PATH_TMPL.format(year_id=to_two_digit_year_id(year_id)))
    logger.info("Fetching list page %s", list_url)
    html, status = await fetch_text_with_retries(session, list_url, retries)
    if not html:
        raise RuntimeError(f"List page fetch failed for yearId={year_id:02d} status={status}")

    programs = parse_program_list_html(html)
    logger.info("Found %d programs for %s-%s", len(programs), start_year, end_year)
    out = {
        "year_id": to_two_digit_year_id(year_id),
        "year_label": f"{start_year}-{end_year}",
        "source_list_url": list_url,
        "program_count": len(programs),
        "programs": [],
    }

    semaphore = asyncio.Semaphore(concurrency)
    tasks = [asyncio.create_task(fetch_program_info_worker(semaphore, session, p, year_id, retries)) for p in programs]

    # Batch to keep memory reasonable
    results = []
    BATCH = max(64, concurrency * 2)
    for i in range(0, len(tasks), BATCH):
        batch = tasks[i:i + BATCH]
        batch_res = await asyncio.gather(*batch, return_exceptions=False)
        results.extend(batch_res)
    out["programs"] = [r for r in results if r]
    return out

# ---- Runner ----

async def main_async(start_year_id: int, concurrency: int, retries: int, stop_after_consec_5xx: int):
    conn = aiohttp.TCPConnector(limit=concurrency * 2, force_close=False)
    headers = {"User-Agent": "Mozilla/5.0 (compatible; ButteScraper/1.0)"}
    timeout = ClientTimeout(total=None)
    async with aiohttp.ClientSession(connector=conn, timeout=timeout, headers=headers) as session:
        consec_server_errors = 0
        year_id = start_year_id
        while True:
            try:
                logger.info("=== Processing yearId=%02d (%s-%s) ===", year_id, *year_id_to_years(year_id))
                year_result = await process_year_async(session, year_id, concurrency, retries)
                first_year = int(year_result["year_label"].split("-")[0])
                filename = f"programs_{first_year}.json"
                with open(filename, "w", encoding="utf-8") as f:
                    json.dump(prune_empty(year_result), f, ensure_ascii=False, indent=2)
                logger.info("Wrote %s (%d programs)", filename, year_result.get("program_count", 0))
                consec_server_errors = 0
            except RuntimeError as re_err:
                logger.warning("List page error: %s", re_err)
                consec_server_errors += 1
                if consec_server_errors >= stop_after_consec_5xx:
                    logger.error("Encountered %d consecutive list-page errors — stopping", consec_server_errors)
                    break
            except KeyboardInterrupt:
                logger.warning("Interrupted by user")
                raise
            except Exception as e:
                logger.exception("Unexpected error for yearId=%02d: %s", year_id, e)
            finally:
                year_id += 1
                await asyncio.sleep(SLEEP_BETWEEN_YEARS)

def parse_args():
    p = argparse.ArgumentParser(description="Butte College programs scraper (clean minimal output)")
    p.add_argument("--start", type=int, default=DEFAULT_START_YEAR_ID, help="start yearId (e.g., 8)")
    p.add_argument("--concurrency", type=int, default=DEFAULT_CONCURRENCY, help="concurrency (program fetches)")
    p.add_argument("--retries", type=int, default=DEFAULT_RETRIES, help="per-request retries")
    p.add_argument("--stop_after", type=int, default=MAX_CONSEC_SERVER_ERRORS, help="stop after N consecutive list 5xx errors")
    return p.parse_args()

if __name__ == "__main__":
    args = parse_args()
    if args.concurrency < 1:
        logger.error("concurrency must be >=1")
        sys.exit(1)
    if args.retries < 1:
        logger.error("retries must be >=1")
        sys.exit(1)
    try:
        asyncio.run(
            main_async(
                start_year_id=args.start,
                concurrency=args.concurrency,
                retries=args.retries,
                stop_after_consec_5xx=args.stop_after,
            )
        )
    except KeyboardInterrupt:
        logger.info("Stopped by user")
        sys.exit(0)
    except Exception:
        logger.exception("Fatal error")
        sys.exit(1)
