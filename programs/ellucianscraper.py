"""
ellucianscraper.py - Scrapes program requirements from Butte's Ellucian DegreeWorks API.
Requires authenticated session cookies from a logged-in browser session.
"""
import requests
import json
import time
import re
import shlex
import concurrent.futures
from pathlib import Path
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
from tqdm import tqdm

# ================= CONFIGURATION =================

AUTH_FILE = Path("auth_config.txt")
INPUT_PROGRAMS_FILE = Path("bak/programs_2025.json")
OUTPUT_DIR = Path("ellucian_evals")
FINAL_OUTPUT_FILE = "programs_2025.json"

API_URL = "https://selfservice.butte.edu/student/Planning/Programs/ProgramEvaluation"
CATALOG_YEAR = "2025" 

MAX_WORKERS = 15

OUTPUT_DIR.mkdir(exist_ok=True)

# ================= AUTH PARSER =================

def parse_auth_config():
    if not AUTH_FILE.exists():
        print(f"[!] Error: {AUTH_FILE} not found. Paste your cURL command there.")
        exit(1)

    with open(AUTH_FILE, "r", encoding="utf-8") as f:
        content = f.read().replace("\\\n", " ") 
    
    try:
        tokens = shlex.split(content)
    except Exception as e:
        print(f"[!] Error parsing cURL string: {e}")
        exit(1)

    headers = {}
    cookies = {}
    student_id = None

    i = 0
    while i < len(tokens):
        token = tokens[i]
        if token in ["-H", "--header"] and i + 1 < len(tokens):
            if ":" in tokens[i+1]:
                k, v = tokens[i+1].split(":", 1)
                headers[k.strip()] = v.strip()
            i += 2
        elif token in ["-b", "--cookie"] and i + 1 < len(tokens):
            for pair in tokens[i+1].split(";"):
                if "=" in pair:
                    k, v = pair.split("=", 1)
                    cookies[k.strip()] = v.strip()
            i += 2
        elif token in ["--data-raw", "-d"] and i + 1 < len(tokens):
            match = re.search(r'studentId"\s*:\s*"?(\d+)"?', tokens[i+1])
            if match: student_id = match.group(1)
            i += 2
        else:
            i += 1
            
    return headers, cookies, student_id

# ================= SESSION SETUP =================

def get_session(headers, cookies):
    session = requests.Session()
    
    retries = Retry(
        total=5,
        backoff_factor=0.5,
        status_forcelist=[500, 502, 503, 504],
        allowed_methods=["POST"] 
    )
    
    adapter = HTTPAdapter(max_retries=retries, pool_connections=MAX_WORKERS, pool_maxsize=MAX_WORKERS)
    session.mount("https://", adapter)
    session.headers.update(headers)
    session.cookies.update(cookies)
    return session

# ================= DATA LOGIC =================
# CRITICAL: pool_maxsize must be >= MAX_WORKERS or threads will block

def get_program_list():
    if not INPUT_PROGRAMS_FILE.exists(): return ["43185.00AS"] 
    with open(INPUT_PROGRAMS_FILE, 'r', encoding='utf-8') as f:
        data = json.load(f)
        return [p.get("program_code", "").strip() for p in data.get("programs", []) if p.get("program_code")]

def clean_course_code(code_str):
    return code_str.replace("-", " ").strip().upper() if code_str else ""

def extract_courses_from_text(text):
    if not text: return []
    matches = re.findall(r'\b([A-Z]{2,4}[- ]\w{1,5})\b', text)
    cleaned = []
    for m in matches:
        c = clean_course_code(m)
        if any(char.isdigit() for char in c):
            cleaned.append(c)
    return sorted(list(set(cleaned)))

def transform(raw_json):
    program_data = raw_json.get("Program")
    if not program_data: return None

    cleaned = {
        "name": program_data.get("Title"),
        "code": program_data.get("Code"),
        "program_type": program_data.get("Degree"), 
        "department": (program_data.get("Departments") or ["Unknown"])[0],
        "detail": {"sections": []}
    }

    for req in program_data.get("Requirements", []):
        req_name = req.get("Description") or req.get("Code")
        for sub in req.get("Subrequirements", []):
            sub_name = sub.get("Code")
            display_text = sub.get("DisplayText", "")
            groups = sub.get("Groups", [])
            min_groups = sub.get("MinGroups", 0)
            
            if min_groups == 1 and len(groups) == 2:
                group_courses = []
                for group in groups:
                    allowed = []
                    for c in group.get("Courses", []):
                        course_name = c.get("CourseName", "")
                        if course_name:
                            allowed.append(clean_course_code(course_name))
                    if not allowed:
                        for c in group.get("FromCourses", []):
                            course_name = c.get("CourseName", "")
                            if course_name:
                                allowed.append(clean_course_code(course_name))
                    group_courses.append((allowed, group))
                
                set1 = set(group_courses[0][0])
                set2 = set(group_courses[1][0])
                common = set1 & set2
                diff1 = set1 - set2
                diff2 = set2 - set1
                if len(common) > 0 and len(diff1) == 1 and len(diff2) == 1:
                    group = groups[0]
                    min_c = group.get("MinCredits", 0.0) or 0.0
                    min_k = group.get("MinCourses", 0) or 0
                    min_s = group.get("MinSubjects", 0) or 0
                    
                    full_name = f"{req_name} - {sub_name}".replace("General Education - ", "GE ")
                    is_admin_section = ("Electives" in full_name or 
                                       "Grad Check" in full_name or 
                                       "Graduation Requirement" in full_name)
                    if is_admin_section:
                        continue
                    
                    if min_c > 0:
                        rtype, rmin = "UNITS", float(min_c)
                    elif min_k > 0:
                        rtype, rmin = "COUNT", int(min_k)
                    else:
                        rtype, rmin = "ALL", 0
                    
                    section = {"name": full_name, "rule": {"type": rtype}, "items": []}
                    if rtype == "UNITS":
                        section["rule"]["min_units"] = rmin
                        if min_s > 0: section["rule"]["min_disciplines"] = min_s
                    elif rtype == "COUNT":
                        section["rule"]["min"] = rmin
                    all_courses = sorted(common | diff1 | diff2)
                    if rtype == "COUNT" and rmin < len(all_courses):
                        pool = [{"code": c} for c in all_courses]
                        for _ in range(max(1, int(rmin))):
                            section["items"].append({"any_of": list(pool)})
                    else:
                        for code in all_courses:
                            section["items"].append({"any_of": [{"code": code}]})
                    
                    if section["items"]:
                        cleaned["detail"]["sections"].append(section)
                    continue
            for group in groups:
                min_c = group.get("MinCredits", 0.0) or 0.0
                min_k = group.get("MinCourses", 0) or 0
                min_s = group.get("MinSubjects", 0) or 0 
                
                allowed = []
                for c in group.get("Courses", []):
                    course_name = c.get("CourseName", "")
                    if course_name:
                        allowed.append(clean_course_code(course_name))
                
                if not allowed:
                    for c in group.get("FromCourses", []):
                        course_name = c.get("CourseName", "")
                        if course_name:
                            allowed.append(clean_course_code(course_name))
                
                if not allowed:
                    allowed = extract_courses_from_text(display_text)
                
                total_courses = len(allowed)
                
                full_name = f"{req_name} - {sub_name}".replace("General Education - ", "GE ")
                is_ge_section = "GE " in full_name or "General Education" in full_name
                
                is_admin_section = ("Electives" in full_name or 
                                   "Grad Check" in full_name or 
                                   "Graduation Requirement" in full_name)
                if is_admin_section:
                    continue
                
                if min_c > 0:
                    rtype, rmin = "UNITS", float(min_c)
                elif min_k > 0:
                    rtype, rmin = "COUNT", int(min_k)
                elif is_ge_section and total_courses > 1:
                    rtype, rmin = "COUNT", 1
                else:
                    rtype, rmin = "ALL", 0
                
                section = {"name": full_name, "rule": {"type": rtype}, "items": []}
                if rtype == "UNITS":
                    section["rule"]["min_units"] = rmin
                    if min_s > 0: section["rule"]["min_disciplines"] = min_s
                elif rtype == "COUNT":
                    section["rule"]["min"] = rmin

                if allowed:
                    if rtype == "ALL":
                        for code in allowed:
                            section["items"].append({"any_of": [{"code": code}]})
                    elif rtype == "UNITS":
                        for code in allowed:
                            section["items"].append({"any_of": [{"code": code}]})
                    elif rtype == "COUNT" and rmin >= total_courses:
                        for code in allowed:
                            section["items"].append({"any_of": [{"code": code}]})
                    elif rtype == "COUNT":
                        pool = [{"code": c} for c in allowed]
                        for _ in range(max(1, int(rmin))):
                            section["items"].append({"any_of": list(pool)})
                
                if section["items"] or rtype != "ALL":
                    cleaned["detail"]["sections"].append(section)

    return cleaned

# ================= WORKER =================

def process_program(code, session, student_id):
    """
    Worker function executed by threads.
    Returns (SuccessBool, ResultOrNone, LogMessage)
    """
    cache_file = OUTPUT_DIR / f"raw_{code}.json"
    raw_data = None

    # 1. Try Cache
    if cache_file.exists():
        try:
            with open(cache_file, 'r', encoding='utf-8') as f:
                loaded = json.load(f)
                if loaded.get("Program"):
                    raw_data = loaded
        except:
            pass # Corrupt cache, ignore
    
    # 2. Fetch if needed
    if not raw_data:
        payload = {
            "program": code,
            "catalogYear": CATALOG_YEAR,
            "isWhatIfEvaluation": True, 
            "studentId": student_id
        }
        try:
            resp = session.post(API_URL, json=payload, timeout=90)
            resp.raise_for_status()
            fetched_json = resp.json()
            if fetched_json.get("Program"):
                with open(cache_file, "w", encoding="utf-8") as f:
                    json.dump(fetched_json, f, indent=2)
                raw_data = fetched_json
            else:
                return False, None, f"[X] Empty/Invalid Data for {code}"
                
        except Exception as e:
            return False, None, f"[!] Network/Error {code}: {str(e)[:50]}"

    program = raw_data.get("Program", {})
    requirements = program.get("Requirements", [])
    if not requirements:
        notifications = raw_data.get("Notifications", [])
        msg = next((n.get("Message", "") for n in notifications if "no requirements" in n.get("Message", "").lower()), "")
        return False, None, f"[X] No requirements in API for {code}: {msg or 'empty Requirements array'}"
    try:
        final_obj = transform(raw_data)
        if final_obj and final_obj.get("detail", {}).get("sections"):
            return True, final_obj, None
        else:
            return False, None, f"[!] Transform produced no sections for {code}"
    except Exception as e:
        return False, None, f"[!] Transform logic error {code}: {e}"

# ================= MAIN =================

if __name__ == "__main__":
    print("[*] Parsing auth...")
    headers, cookies, student_id = parse_auth_config()
    if not student_id:
        print("[!] No Student ID found in auth_config.txt"); exit(1)
        
    targets = get_program_list()
    print(f"[*] Loaded {len(targets)} programs.")
    
    session = get_session(headers, cookies)
    final_results = []
    
    print(f"[*] Starting scraper with {MAX_WORKERS} threads...")
    
    with concurrent.futures.ThreadPoolExecutor(max_workers=MAX_WORKERS) as executor:
        future_to_code = {
            executor.submit(process_program, code, session, student_id): code 
            for code in targets
        }
        for future in tqdm(concurrent.futures.as_completed(future_to_code), total=len(targets), unit="prog"):
            code = future_to_code[future]
            try:
                success, result, error_msg = future.result()
                if success and result:
                    final_results.append(result)
            except Exception as e:
                tqdm.write(f"[!] Unhandled worker exception for {code}: {e}")

    with open(FINAL_OUTPUT_FILE, "w", encoding="utf-8") as f:
        json.dump({"programs": final_results}, f, indent=2)
        
    print(f"\n[*] Run Complete. Scraped {len(final_results)} programs.")
    print(f"[*] Saved to {FINAL_OUTPUT_FILE}")
