# ButteMAP

Academic planning tool for Butte College students. Plan terms, track GE progress, evaluate program completion, and find the best-fit degrees based on completed coursework.

**[Try ButteMAP](https://shorttimenosee.github.io/ButteMAP/)**

## Disclaimer

**This tool does NOT replace a counselor.** ButteMAP is an unofficial planning aid. Always verify your academic plan with a Butte College counselor before making enrollment decisions.

**This tool is naturally susceptible to errors:**

- **Course data** is scraped from Ellucian's course search API. If the catalog updates, local data becomes stale until re-scraped.
- **GE patterns** are manually authored by transcribing official GE worksheets. Transcription errors, omissions, or misinterpretations of policy are possible.
- **Exam credit mappings** are parsed from HTML tables on Butte's website. These tables can change without notice, and the parser may misread edge cases.
- **Program requirements** are fetched from the API via scraping. API structure changes, incomplete upstream data, or programs marked in unexpected/unsupported ways can cause missing/incorrect requirements.
- **Prerequisite parsing** uses regex heuristics to convert human-readable requirement text into structured trees. Complex or ambiguous phrasing may be parsed incorrectly.
- **Catalog rights logic** may not account for every edge case in Butte's actual policy.

**Found an issue?** Report bugs, data errors, or suggestions:
- GitHub Issues: https://github.com/ShortTimeNoSee/ButteMAP/issues
- Email: nikolaythompson@gmail.com

## Overview

ButteMAP is a CLIENT-side web application that:
- Manages semester-by-semester course planning
- Evaluates GE requirements across multiple patterns (Butte Local, CSU Breadth, IGETC, Cal-GETC)
- Tracks AP/IB/CLEP exam credits and their GE applicability
- Ranks AA/AS/Certificate programs by completion percentage
- Handles catalog rights across academic years

All data stays local in the browser. Export/import plans as JSON.

## Quick Start

```bash
python serve.py
# Open http://127.0.0.1:8000
```

Requires Python 3.8+. No external dependencies for the web app itself.

## Project Structure

```
├── app.js                  # Main application logic
├── app.css                 # Styles
├── index.html              # Entry point
├── serve.py                # Local dev server
├── requirements.txt        # Python deps for data scripts
│
├── courses/
│   ├── courses.json        # Raw course data from Ellucian
│   ├── courses_cleaned.json # Processed course catalog
│   ├── course_aliases.json  # Course code mappings (old -> new)
│   └── coursecleaner.py     # Transforms raw courses to cleaned format
│
├── exams/
│   ├── AP.html, IB.html, CLEP.html  # Source HTML from Butte website
│   ├── exams_ap.json, exams_ib.json, exams_clep.json  # Parsed exam credit data
│   ├── exams_notes.json     # Policy notes
│   └── extract_exam_credit.py  # HTML table parser
│
├── ge/
│   ├── 2023/, 2024/, 2025/  # GE patterns by catalog year
│   │   ├── ge_local.json    # Butte Local GE
│   │   ├── ge_csu.json      # CSU Breadth
│   │   ├── ge_igetc.json    # IGETC (pre-2025)
│   │   └── ge_calgetc.json  # Cal-GETC (2025+)
│
└── programs/
    ├── programs_2025.json   # Program requirements (current)
    ├── ellucianscraper.py   # Fetches requirements from DegreeWorks API
    ├── help.md              # Auth setup instructions
    └── ellucian_evals/      # Cached raw API responses
```

## Data Pipeline

### 1. Courses

Source: Butte's Ellucian course search API.

```bash
cd courses
# See 'courses/course-extract-and-clean (GUIDE).md' for browser extraction steps
python coursecleaner.py
```

Produces `courses_cleaned.json` with:
- Normalized course codes (ENGL-2 -> ENGL 2)
- Parsed prerequisite trees
- Stripped metadata

### 2. Exam Credits

Source: Butte's exam credit policy pages (manually saved as HTML).

```bash
cd exams
python extract_exam_credit.py AP.html IB.html CLEP.html
```

Produces:
- `exams_ap.json`, `exams_ib.json`, `exams_clep.json`
- `exams_notes.json`

Each entry maps an exam+score to GE areas and course equivalencies per pattern.

### 3. Programs (ellucianscraper.py)

Source: Ellucian DegreeWorks program evaluation API (requires auth).

```bash
cd programs
# 1. Follow help.md to get auth_config.txt
# 2. Run scraper
python ellucianscraper.py
```

#### How It Works

The scraper hits Butte's internal `ProgramEvaluation` endpoint, which is the same API that powers the "View a New Program" feature in the student portal. It performs a "What-If" evaluation for each program code against your student ID.

**Authentication Flow:**
1. You log into the student portal and trigger a program evaluation manually
2. Copy the cURL command from DevTools (includes session cookies + CSRF tokens)
3. Paste into `auth_config.txt`
4. The scraper parses this cURL to extract headers, cookies, and your student ID

**Concurrency:**
- Runs 15 parallel threads by default (`MAX_WORKERS`)
- Uses connection pooling with retry logic (5 retries, exponential backoff)
- Each response is cached to `ellucian_evals/raw_{code}.json` so re-runs skip already-fetched programs

**The Transform Pipeline:**

Raw API responses have deeply nested structures. The `transform()` function flattens them:

```
API Structure                          Output Structure
─────────────────────────────────────────────────────────────────
Program
 └─ Requirements[]                     sections[]
     └─ Subrequirements[]               └─ name: "Req - Subreq"
         └─ Groups[]                        rule: {type, min, min_units}
             ├─ MinCredits                  items[]
             ├─ MinCourses                   └─ any_of: [{code}, ...]
             ├─ Courses[]
             └─ FromCourses[]
```

**Rule Type Detection:**
- `MinCredits > 0` → `UNITS` rule (need N units from pool)
- `MinCourses > 0` → `COUNT` rule (need N courses from pool)  
- Otherwise → `ALL` rule (every course required)

**OR-Group Merging:**

When `MinGroups=1` with exactly 2 groups that share most courses but differ by one each, the scraper merges them into a single pool with an OR option. This handles patterns like "Take A, B, C, and (X or Y)".

**Filtered Out:**
- Sections containing "Electives", "Grad Check", or "Graduation Requirement"
- Empty sections after processing

#### Troubleshooting

**"No Student ID found"** - Your cURL doesn't include the `--data-raw` payload with `studentId`. Make sure you copied from an actual ProgramEvaluation request, not just any random request.

**Programs returning empty** - Some programs have no structured requirements in DegreeWorks (they show "See counselor"). These get skipped.

**Auth expires** - Session cookies last some number of minutes. If scraping a full catalog, you may hypothetically need to refresh `auth_config.txt` mid-run. Cached programs won't need re-fetching.

**Rate limits** - Haven't hit any, but if you do, reduce `MAX_WORKERS` to 5.

Produces `programs_2025.json` with structured requirements:
- Section names, rule types (ALL, COUNT, UNITS)
- Course options (any_of arrays)
- Cross-list rules for shared elective pools

### 4. GE Patterns

Manually (for now) authored JSON files defining:
- Area requirements (courses, units, distinct disciplines)
- Logic trees (AND/OR combinations)
- Attribute constraints (lab requirements)

## Application Logic

### Catalog Rights

Students have "rights" to use GE patterns from catalog years where they were continuously enrolled. The app auto-detects this from entered terms or allows manual override. However, previous catalog years are not as of now handled.

### GE Evaluation

Greedy optimizer that:
1. Builds candidate pools per area from completed courses + exam credits
2. Allocates courses to areas (each course used once)
3. Handles OR groups by branch scoring
4. Enforces distinct disciplines and lab attributes

### Program Matching

For each eligible program:
1. Evaluates course requirements (ALL/COUNT/UNITS rules)
2. Evaluates applicable GE pattern (Local for AA/AS, Cal-GETC/IGETC for transfers)
3. Computes composite completion percentage
4. Calculates prerequisite gaps for missing courses

### Prerequisite Checking

Parses requirement text into AND/OR trees. Checks against:
- Completed courses
- Course aliases (old codes -> new codes)
- HS background flags (chemistry, intermediate algebra)

## Development

### Adding a New Catalog Year

1. Copy GE JSON files to `ge/YYYY/`
2. Update course lists per area
3. Add program file `programs/programs_YYYY.json`
4. Update `loadData()` in app.js to load new files

### Updating Course Data

1. Re-extract from Ellucian (see courses guide)
2. Run `coursecleaner.py`
3. Update `course_aliases.json` if codes changed

### Updating Exam Credits

1. Save updated HTML from Butte's website
2. Run `extract_exam_credit.py` with new files
3. Review output for parsing issues

## Data Formats

### Course (courses_cleaned.json)

```json
{
  "CourseCode": "MATH 30",
  "Title": "Calculus I",
  "MinimumCredits": 4,
  "RequirementTree": {
    "op": "OR",
    "nodes": [
      {"course": "MATH 20"},
      {"course": "MATH 21"}
    ]
  }
}
```

### Program Section (programs_YYYY.json)

```json
{
  "name": "Core Requirements",
  "rule": {"type": "ALL"},
  "items": [
    {"any_of": [{"code": "MATH 30"}]},
    {"any_of": [{"code": "PHYS 41"}, {"code": "PHYS 21"}]}
  ]
}
```

Rule types:
- `ALL`: Every item required
- `COUNT`: Minimum N items from pool
- `UNITS`: Minimum N units from pool

### GE Pattern (ge_*.json)

```json
{
  "pattern": "butte_local",
  "catalog_year": "2025-2026",
  "logic": {
    "op": "AND",
    "nodes": [
      {"area": "1A", "min_courses": 1, "min_units": 3},
      {"op": "OR", "nodes": [
        {"area": "1B", "min_courses": 1},
        {"area": "1C", "min_courses": 1}
      ]}
    ]
  },
  "buckets": {
    "1A": {"courses": ["ENGL C1000", "ENGL C1000E"]},
    "1B": {"courses": ["CMST 14", "MATH 7", "..."]}
  }
}
```

## Browser Compatibility

Tested on modern Chrome/Firefox. Uses ES2020+ features (optional chaining, nullish coalescing). No build step required.

## License

Internal tool. Not for redistribution.
