// ======== Utilities ========
const $ = (sel, root=document) => root.querySelector(sel);
const $$ = (sel, root=document) => Array.from(root.querySelectorAll(sel));

const GRADE_POINTS = {
  'A':4.0,'B':3.0,'C':2.0,'D':1.0,'F':0.0,'P':null,'NP':null,'IP':null,'PL':null,'W':null
};
const GRADE_OPTIONS = ['IP','PL','A','B','C','D','F','P','NP','W'];
const PASSING_GE = new Set(['A','B','C','P']); // conservative

const TERM_ORDER = ['Winter', 'Spring', 'Summer', 'Fall'];
const TERM_OPTIONS = ['Winter','Spring','Summer','Fall'];

const YEAR_FROM_LABEL = s => parseInt(s.slice(0,4),10);
const AY_LABEL = y => `${y}-${y+1}`;

function normalizeCode(raw) {
  if (!raw) return '';
  return raw.toUpperCase().replace(/-/g,' ').replace(/\s+/g,' ').trim();
}

function canonicalizeCode(code) {
  const norm = normalizeCode(code);
  const map = state.courseAliases.alias_to_canonical_codes || {};
  return map[norm] || norm;
}
function prefixOf(code) { return code.split(' ')[0]; }
function slug(s){ return (s||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,''); }

// ======== Rule-Aware Program Evaluator ========
const norm = s => s.replace(/\s+/g, ' ').trim().toUpperCase();

const ruleTypeOf = (t) => (t || 'ALL').toUpperCase();

const sectionIsInCrossList = (program, sectionName) =>
  (program.detail?.cross_list_rules || [])
    .some(r => r.type === 'CROSS_LIST_UNITS' && (r.applies_to || []).includes(sectionName));

// LIST behaves like ALL unless it's pooled under CROSS_LIST_UNITS.
const isAllish = (program, section) => {
  const x = ruleTypeOf(section.rule?.type);
  if (x === 'ALL') return true;
  if (x === 'LIST') return !sectionIsInCrossList(program, section.name);
  return false;
};

function indexSectionItems(section) {
  // Flatten item.any_of options and track match state
  return section.items.map((it, idx) => ({
    sectionName: section.name,
    itemIdx: idx,
    options: (it.any_of || []).map(o => ({ code: norm(o.code), units: o.units ?? null })),
    matched: false,
    chosen: null
  }));
}

function findMatchForItem(item, takenSet, usedSet) {
  for (const opt of item.options) {
    if (takenSet.has(opt.code) && !usedSet.has(opt.code)) {
      return opt;
    }
  }
  return null;
}

// Greedy allocator for COUNT: prefer local items, then borrow from allowed lists.
function satisfyCountSection(section, sectionItems, poolsByList, takenSet, usedSet) {
  const need = section.rule.min ?? 1;
  const max = section.rule.max ?? need;
  const chosen = [];

  // First: items in this section
  for (const item of sectionItems) {
    if (chosen.length >= max) break;
    const pick = findMatchForItem(item, takenSet, usedSet);
    if (pick) {
      item.matched = true;
      item.chosen = pick;
      usedSet.add(pick.code);
      chosen.push({ code: pick.code, units: pick.units, from: section.name });
    }
  }

  // Then: borrow from allow_from pools until min is met
  const allow = section.rule.allow_from || [];
  for (const listName of allow) {
    if (chosen.length >= need) break;
    const pool = poolsByList[listName] || [];
    for (const item of pool) {
      if (chosen.length >= need) break;
      if (item.matched) continue;
      const pick = findMatchForItem(item, takenSet, usedSet);
      if (pick) {
        item.matched = true;
        item.chosen = pick;
        usedSet.add(pick.code);
        chosen.push({ code: pick.code, units: pick.units, from: listName });
      }
    }
  }

  return { chosen, need, max };
}

// Greedy allocator for UNITS with discipline and per-list minima.
// Strategy: cover discipline constraints first (if any), satisfy per-list minima, then fill to total units.
function satisfyUnitsSection(section, sectionItems, poolsByList, takenSet, usedSet) {
  const minUnitsTotal = section.rule.min_units ?? 0;
  const minDisciplines = section.rule.min_disciplines ?? 0;
  const allow = section.rule.allow_from || [];
  const perListMin = section.rule.per_list_min_units || {};
  const chosen = [];
  let gotUnits = 0;

  function* availableFromList(listName) {
    const pool = poolsByList[listName] || [];
    for (const item of pool) {
      if (item.matched) continue;
      const pick = findMatchForItem(item, takenSet, usedSet);
      if (pick) yield {pick, item, from: listName};
    }
  }

  function* availableFromSection() {
    for (const item of sectionItems) {
      if (item.matched) continue;
      const pick = findMatchForItem(item, takenSet, usedSet);
      if (pick) yield {pick, item, from: section.name};
    }
  }

  function pickOneFromList(listName) {
    const iter = availableFromList(listName);
    const next = iter.next();
    if (next.done) return false;
    const {pick, item, from} = next.value;
    item.matched = true;
    item.chosen = pick;
    usedSet.add(pick.code);
    chosen.push({ code: pick.code, units: pick.units ?? 0, from });
    gotUnits += pick.units ?? 0;
    return true;
  }

  function pickWithFilter(filterFn) {
    for (const {pick, item, from} of availableFromSection()) {
      if (filterFn && !filterFn(pick)) continue;
      item.matched = true;
      item.chosen = pick;
      usedSet.add(pick.code);
      chosen.push({ code: pick.code, units: pick.units ?? 0, from });
      gotUnits += pick.units ?? 0;
      return true;
    }
    for (const listName of allow) {
      for (const {pick, item, from} of availableFromList(listName)) {
        if (filterFn && !filterFn(pick)) continue;
        item.matched = true;
        item.chosen = pick;
        usedSet.add(pick.code);
        chosen.push({ code: pick.code, units: pick.units ?? 0, from });
        gotUnits += pick.units ?? 0;
        return true;
      }
    }
    return false;
  }

  if (minDisciplines > 0) {
    const disciplineSet = new Set();
    while (disciplineSet.size < minDisciplines && (gotUnits < minUnitsTotal || disciplineSet.size < minDisciplines)) {
      const prevSize = disciplineSet.size;
      const found = pickWithFilter(pick => {
        const disc = disciplineFromPrefix(pick.code);
        return !disciplineSet.has(disc);
      });
      if (!found) break;
      disciplineSet.clear();
      for (const c of chosen) disciplineSet.add(disciplineFromPrefix(c.code));
      if (disciplineSet.size === prevSize) break;
    }
  } else {
    for (const item of sectionItems) {
      if (gotUnits >= minUnitsTotal) break;
      const pick = findMatchForItem(item, takenSet, usedSet);
      if (pick) {
        item.matched = true;
        item.chosen = pick;
        usedSet.add(pick.code);
        chosen.push({ code: pick.code, units: pick.units ?? 0, from: section.name });
        gotUnits += pick.units ?? 0;
      }
    }
  }

  // Enforce per-list minima
  for (const listName of allow) {
    const need = perListMin[listName] || 0;
    let have = 0;
    for (const c of chosen) if (c.from === listName) have += (c.units || 0);
    while (have < need) {
      const ok = pickOneFromList(listName);
      if (!ok) break;
      have = chosen.filter(c => c.from === listName).reduce((t,c)=>t+(c.units||0),0);
    }
  }

  // Fill to total
  while (gotUnits < minUnitsTotal) {
    const found = pickWithFilter();
    if (!found) break;
  }

  // Summarize unmet constraints for UI
  const missing = [];
  if (minDisciplines > 0) {
    const disciplineSet = new Set();
    for (const c of chosen) disciplineSet.add(disciplineFromPrefix(c.code));
    if (disciplineSet.size < minDisciplines) {
      missing.push(`need courses from at least ${minDisciplines} disciplines (currently ${disciplineSet.size})`);
    }
  }
  for (const listName of allow) {
    const need = perListMin[listName] || 0;
    const have = chosen.filter(c => c.from === listName).reduce((t,c)=>t+(c.units||0),0);
    if (have < need) missing.push(`${(need - have).toFixed(1)} more units from ${listName}`);
  }
  if (gotUnits < minUnitsTotal) missing.push(`${(minUnitsTotal - gotUnits).toFixed(1)} more units overall`);

  return { chosen, gotUnits, missing, minUnits: minUnitsTotal };
}

// CROSS_LIST_UNITS: meet per-list minima first, then max total units across lists without reusing a course.
function evalCrossListUnits(program, takenSet, usedSet) {
  const rule = (program.detail?.cross_list_rules || [])
    .find(r => r.type === 'CROSS_LIST_UNITS');
  if (!rule) return null;

  const applies = new Set(rule.applies_to || []);
  const perMin = rule.per_list_min_units || {};
  const minTotal = rule.min_units_total || 0;

  // Build section -> [{code, units}]
  const sections = (program.detail?.sections || []).filter(s => applies.has(s.name));
  const sectionPool = {};
  for (const s of sections) {
    const arr = [];
    for (const item of (s.items || [])) {
      for (const opt of (item.any_of || [])) {
        arr.push({ code: String(opt.code).trim().toUpperCase(), units: opt.units || 0, itemRef: item });
      }
    }
    sectionPool[s.name] = arr;
  }

  // Candidate hits by section; highest units first
  const hitsBySection = {};
  for (const [name, arr] of Object.entries(sectionPool)) {
    const hits = arr.filter(x => takenSet.has(x.code));
    hits.sort((a, b) => b.units - a.units);
    hitsBySection[name] = hits;
  }

  const usedCodes = new Set();
  const earnedBySection = Object.fromEntries(Object.keys(sectionPool).map(n => [n, 0]));
  const chosenBySection = Object.fromEntries(Object.keys(sectionPool).map(n => [n, []]));

  // Satisfy per-section minima
  for (const name of Object.keys(sectionPool)) {
    let need = perMin[name] || 0;
    for (const h of hitsBySection[name]) {
      if (earnedBySection[name] >= need) break;
      if (usedCodes.has(h.code) || usedSet.has(h.code)) continue;
      usedCodes.add(h.code);
      usedSet.add(h.code);
      earnedBySection[name] += h.units;
      h.itemRef.matched = true;
      h.itemRef.chosen = { code: h.code, units: h.units };
      chosenBySection[name].push(h);
    }
  }

  // Then fill to total
  let totalUnits = Object.values(earnedBySection).reduce((a, b) => a + b, 0);
  const leftovers = [];
  for (const name of Object.keys(sectionPool)) {
    for (const h of hitsBySection[name]) {
      if (!usedCodes.has(h.code) && !usedSet.has(h.code)) leftovers.push({ ...h, name });
    }
  }
  leftovers.sort((a, b) => b.units - a.units);

  for (const h of leftovers) {
    if (totalUnits >= minTotal) break;
    usedCodes.add(h.code);
    usedSet.add(h.code);
    totalUnits += h.units;
    earnedBySection[h.name] += h.units;
    h.itemRef.matched = true;
    h.itemRef.chosen = { code: h.code, units: h.units };
    chosenBySection[h.name].push(h);
  }

  const perListOK = Object.keys(sectionPool)
    .every(name => (earnedBySection[name] || 0) >= (perMin[name] || 0));
  const done = perListOK && totalUnits >= minTotal;

  return { done, totalUnits, minTotal, earnedBySection, perMin, chosenBySection };
}

// Evaluate a program detail against a transcript.
// Atoms = minimal requirement pieces used to compute % complete:
// 1) ALL (and LIST unless cross-listed): each item is an atom
// 2) COUNT: min count is atom count; borrowed items are allowed
// 3) UNITS: each section contributes 1 atom when constraints met
// + CROSS_LIST_UNITS contributes atoms: total + each per-list min.
function evaluateProgram(detail, transcript, countPlanned = false) {
  // Build taken set (optionally include IP/PL) and exam equivalencies
  const takenCodesRaw = [...transcript.completed.filter(r=>r.isPass).map(r=>r.code)];
  if (countPlanned) {
    takenCodesRaw.push(...transcript.ip.map(r=>r.code));
    takenCodesRaw.push(...transcript.pl.map(r=>r.code));
  }
  const takenSet = new Set(takenCodesRaw.map(c => canonicalizeCode(c)).map(norm));
  for (const code of buildExamEquivalencyCodes(state.userExams)) takenSet.add(code);

  // Runtime safety net: if a section is labeled like "Select two" but came in as LIST,
  // coerce it to COUNT with the correct min.
  function wordsToNum(w) {
    const map = { one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9, ten:10 };
    if (!w) return null;
    const s = String(w).toLowerCase();
    if (/^\d+$/.test(s)) return parseInt(s,10);
    return map[s] ?? null;
  }
  function coerceSelectCountRule(sec) {
    if (!sec || !sec.name) return sec;
    const m = /^\s*Select\s+(\w+)/i.exec(sec.name);
    if (m && ruleTypeOf(sec.rule?.type) === 'LIST') {
      const n = wordsToNum(m[1]);
      if (n) sec.rule = { type: 'COUNT', min: n, max: n };
    }
    return sec;
  }

  const sections = (detail.sections || []).map(s0 => {
    const sec = coerceSelectCountRule({ ...s0 });
    return {
      name: sec.name,
      rule: sec.rule || { type: 'ALL' },
      items: indexSectionItems(sec)
    };
  });

  const poolsByList = {};
  for (const s of sections) poolsByList[s.name] = s.items;

  const usedSet = new Set();
  const report = [];
  let requiredAtomCount = 0;
  let metAtomCount = 0;

  const cross = evalCrossListUnits({ detail }, takenSet, usedSet);
  
  // ALL/LIST (not in cross-list pools)
  for (const s of sections.filter(x => isAllish({ detail }, x))) {
    for (const item of s.items) {
      requiredAtomCount += 1;
      const pick = findMatchForItem(item, takenSet, usedSet);
      if (pick) {
        item.matched = true;
        item.chosen = pick;
        usedSet.add(pick.code);
        metAtomCount += 1;
      }
    }
  }

  // COUNT
  for (const s of sections.filter(
    x => ruleTypeOf(x.rule.type) === 'COUNT' && !sectionIsInCrossList({ detail }, x.name)
  )) {
    const need = s.rule.min ?? 1;
    requiredAtomCount += need;

    const { chosen } = satisfyCountSection(s, s.items, poolsByList, takenSet, usedSet);
    s._chosen = chosen;
    metAtomCount += Math.min(chosen.length, need);

    report.push({
      section: s.name,
      rule: s.rule,
      met: chosen.map(c => `${c.code}${c.from && c.from !== s.name ? ` (from ${c.from})` : ''}`),
      missing: chosen.length >= need ? [] : [`${need - chosen.length} more from ${s.name}`]
    });
  }

  // UNITS
  for (const s of sections.filter(x => ruleTypeOf(x.rule.type) === 'UNITS')) {
    requiredAtomCount += 1;
    const { chosen, gotUnits, missing, minUnits } =
      satisfyUnitsSection(s, s.items, poolsByList, takenSet, usedSet);

    s._chosen = chosen;
    s._units = gotUnits;
    if (gotUnits >= minUnits && missing.length === 0) metAtomCount += 1;

    report.push({
      section: s.name,
      rule: s.rule,
      met: chosen.map(c => `${c.code}${c.from && c.from !== s.name ? ` (from ${c.from})` : ''}`),
      missing: missing.length > 0 ? missing : []
    });
  }

  // CROSS_LIST_UNITS atoms
  if (cross) {
    requiredAtomCount += 1;
    if (cross.totalUnits >= cross.minTotal) metAtomCount += 1;

    const perMinEntries = Object.entries(cross.perMin || {});
    requiredAtomCount += perMinEntries.length;
    for (const [lname, need] of perMinEntries) {
      const got = cross.earnedBySection[lname] || 0;
      if (got >= need) metAtomCount += 1;
    }
  }

  // Cross-list findings for UI summaries
  const crossRules = detail.cross_list_rules || [];
  const crossFindings = [];
  for (const r of crossRules) {
    if ((r.type || '').toUpperCase() !== 'CROSS_LIST_UNITS') continue;
    const lists = r.applies_to || [];
    let totalUnits = 0;
    const perListUnits = {};
    for (const lname of lists) perListUnits[lname] = 0;

    for (const s of sections.filter(s => lists.includes(s.name))) {
      for (const item of s.items) {
        if (item.matched && item.chosen && (item.chosen.units || item.chosen.units === 0)) {
          totalUnits += item.chosen.units;
          perListUnits[s.name] += item.chosen.units;
        }
      }
    }

    const minTotal = r.min_units_total || 0;
    const perMin = r.per_list_min_units || {};
    const perListShort = Object.entries(perMin).filter(([lname, min]) => (perListUnits[lname] || 0) < min);

    crossFindings.push({
      applies_to: lists,
      met_total: totalUnits >= minTotal,
      total_units: totalUnits,
      need_total: minTotal,
      per_list_min_status: perListShort.map(([lname, min]) => ({ list: lname, have: perListUnits[lname] || 0, need: min }))
    });
  }

  // Atom-based %; if no items exist, 100% (e.g., certs with no sections)
  const hasAnyItems = sections.some(sec => (sec.items || []).length > 0);
  const percent = requiredAtomCount
    ? Math.round((metAtomCount / requiredAtomCount) * 100)
    : (hasAnyItems ? 0 : 100);

  function renderCrossListSection(s, cross) {
    const name = s.name;
    const got = cross.earnedBySection[name] || 0;
    const need = cross.perMin[name] || 0;
    const used = (cross.chosenBySection[name] || [])
      .map(h => `${h.code} (${h.units}u)`).join(', ') || '—';

    // Inline suggestion when short: surface unmatched options quickly.
    let suggestion = '';
    if (got < need) {
      const unmatched = s.items.filter(i => !i.matched);
      const opts = uniq(unmatched.flatMap(i =>
        i.options.map(o => `${o.code} (${(o.units ?? 0)}u)`)
      ));
      if (opts.length) suggestion = ` • Take 1 of: ${opts.join(' OR ')}`;
    }

    return {
      section: name,
      items: [{
        type: 'cross-list',
        met: got >= need,
        matched: `${got}/${need} units • Used: ${used}${suggestion}`,
        options: []
      }]
    };
  }

  const details = [];
  for (const s of sections) {
    const ruleType = ruleTypeOf(s.rule.type);
    
    // Compact rendering for cross-list sections
    if (cross && cross.earnedBySection.hasOwnProperty(s.name)) {
      details.push(renderCrossListSection(s, cross));
      continue;
    }
    
    const secRow = { section: s.name, items: [] };

    if (ruleType === 'ALL' || ruleType === 'LIST') {
      for (const item of s.items) {
        if (item.matched) {
          secRow.items.push({ type:'single', met: true, matched: item.chosen.code, options:[item.chosen.code] });
        } else {
          const options = item.options.map(o => o.code);
          secRow.items.push({ type: options.length > 1 ? 'or' : 'single', met: false, matched: null, options });
        }
      }
    } else if (ruleType === 'COUNT') {
      const chosen = s._chosen || [];
      const needed = s.rule.min ?? 1;

      for (const c of chosen) {
        const label = (c.from && c.from !== s.name) ? `${c.code} (from ${c.from})` : c.code;
        secRow.items.push({ type:'single', met: true, matched: label, options:[c.code] });
      }

      const stillNeed = Math.max(0, needed - chosen.length);
      if (stillNeed > 0) {
        const unmatched = s.items.filter(i => !i.matched);
        for (let i = 0; i < Math.min(stillNeed, unmatched.length); i++) {
          const item = unmatched[i];
          const options = item.options.map(o => o.code);
          secRow.items.push({ type: options.length > 1 ? 'or' : 'single', met: false, matched: null, options });
        }
      }
    } else if (ruleType === 'UNITS') {
      const chosen = s._chosen || [];
      const minUnits = s.rule.min_units ?? 0;
      const minDisciplines = s.rule.min_disciplines ?? 0;
      const haveUnits = (s._units ?? chosen.reduce((t,c)=>t+(c.units||0),0));
      const perListMin = s.rule.per_list_min_units || {};
      
      for (const c of chosen) {
        const label = (c.from && c.from !== s.name) ? `${c.code} (from ${c.from})` : c.code;
        secRow.items.push({ type:'single', met: true, matched: label, options:[c.code] });
      }
      
      let disciplinesMet = true;
      if (minDisciplines > 0) {
        const disciplineSet = new Set();
        for (const c of chosen) disciplineSet.add(disciplineFromPrefix(c.code));
        disciplinesMet = disciplineSet.size >= minDisciplines;
      }
      
      let needsMore = false;
      for (const [listName, need] of Object.entries(perListMin)) {
        const have = chosen.filter(c => c.from === listName).reduce((t,c)=>t+(c.units||0),0);
        if (have < need) { needsMore = true; break; }
      }
      if (!needsMore && (haveUnits < minUnits || !disciplinesMet)) needsMore = true;
      
      if (needsMore) {
        const unmatched = s.items.filter(i => !i.matched);
        const allowedLists = s.rule.allow_from || [];
        for (let i = 0; i < Math.min(2, unmatched.length); i++) {
          const options = unmatched[i].options.map(o => o.code);
          secRow.items.push({ type: options.length > 1 ? 'or' : 'single', met: false, matched: null, options });
        }
        if (allowedLists.length > 0 && unmatched.length < 2) {
          secRow.items.push({ 
            type: 'single', 
            met: false, 
            matched: null, 
            options: [`(additional courses from ${allowedLists.join(', ')})`] 
          });
        }
      }
    }

    details.push(secRow);
  }

  const pct = percent / 100;
  const result = {
    pct, 
    requiredItems: requiredAtomCount, 
    satisfied: metAtomCount, 
    confidence: 1.0, 
    details,
    cross_list_checks: crossFindings
  };

  if (cross) {
    result.crossListSummary = cross;
    const isComplete = (metAtomCount === requiredAtomCount);
    result.isComplete = isComplete;
    const totalSummary = `Selected units across areas: ${cross.totalUnits}/${cross.minTotal}`;
    const areaSummaries = Object.keys(cross.earnedBySection)
      .map(name => `${name} ${cross.earnedBySection[name]}/${cross.perMin[name] || 0}`)
      .join(' • ');
    result.crossListHeader = `${totalSummary} • ${areaSummaries}`;
  }

  return result;
}

// Expand catalog-style slash tokens (GE data), e.g. "PHYS 10/11" -> ["PHYS 10","PHYS 11"].
// Only for static lists (not user input).
function expandSlashTokens(deptPlus) {
  const m = /^([A-Z]+)\s+([\dA-Z]+(?:\/[\dA-Z]+)+)$/.exec(deptPlus);
  if (!m) return [deptPlus];
  const dept = m[1];
  const rest = m[2].split('/');
  return rest.map(n => `${dept} ${n}`);
}
function uniq(a){ return Array.from(new Set(a)); }
function sum(a){ return a.reduce((x,y)=>x+y,0); }
function deepClone(v){ return JSON.parse(JSON.stringify(v)); }

function isValidCourse(code) {
  const norm = canonicalizeCode(code);
  return !!state.coursesIndex.get(norm);
}

function firstSuggestion(prefix) {
  const p = normalizeCode(prefix);
  if (!p) return '';
  return state.coursesList.find(c => c.startsWith(p)) || '';
}


// ======== Term Sorting ========
function compareTerms(a, b) {
  if (a.year !== b.year) return a.year - b.year;
  return TERM_ORDER.indexOf(a.season) - TERM_ORDER.indexOf(b.season);
}

// ======== Exam Credit Functions ========
// Map exam rows into pattern-specific areas/units and pseudo-courses.
// LOTE (IGETC 6A) is treated as a waiver with 0 units; only applies to IGETC.
function geAreaForExamRow(row, scheme) {
  if (scheme === 'butte_local') return row.butte_ge_area;
  if (scheme === 'csu_breadth') return row.csu_ge_area;
  if (scheme === 'cal_getc')    return row.cal_getc_area;
  if (scheme === 'igetc')       return row.cal_getc_area;
  return null;
}

function geUnitsForExamRow(row, scheme) {
  if (scheme === 'butte_local') return row.butte_ge_units_cap ?? row.butte_units ?? 0;
  if (scheme === 'csu_breadth') return row.csu_ge_units ?? 0;
  if (scheme === 'cal_getc')    return row.cal_getc_units ?? 0;
  if (scheme === 'igetc')       return (row.cal_getc_units ?? row.csu_ge_units ?? 0);
  return 0;
}

function meetsScore(row, scheme, score) {
  // AP default: credit for 3–5 if null; IB uses scheme-specific min fields.
  const min = (scheme === 'cal_getc') ? (row.min_score_cal_getc ?? 3) 
                                      : (row.min_score_butte_csu ?? 3);
  return score >= min && (!row.score_cutoff || score >= row.score_cutoff);
}

function examToPseudoCourse(row, scheme, score) {
  if (row.program === 'Other' && row.exam.includes('LOTE')) {
    if (scheme === 'igetc') {
      return {
        code: `EXAM:${row.program}:${row.exam}`,
        title: `${row.program} ${row.exam}`,
        units: 0,
        geAreas: ['6A'],
        source: 'exam',
        grade: 'P',
      };
    }
    return null;
  }

  const area = geAreaForExamRow(row, scheme);
  if (!area || !meetsScore(row, scheme, score)) return null;
  const units = geUnitsForExamRow(row, scheme);

  return {
    code: `EXAM:${row.program}:${row.exam}`,
    title: `${row.program} ${row.exam}`,
    units,
    geAreas: (area || '').split(/\s*(?:&|or)\s*/i).map(s => s.trim()).filter(s => s),
    source: 'exam',
    grade: 'P',
  };
}

function buildExamPseudoCourses(userExams, scheme) {
  const lookup = state.examData;
  return userExams.flatMap(ux => {
    const match = (lookup[ux.program] || []).find(r => r.exam === ux.exam);
    const pseudo = match ? examToPseudoCourse(match, scheme, ux.score) : null;
    return pseudo ? [pseudo] : [];
  });
}

function extractExamAreaTokens(s) {
  if (!s) return [];
  const out = new Set();
  const re = /(US\d+|\d[A-Z]?)/gi;
  let m;
  while ((m = re.exec(s)) !== null) out.add(m[1].toUpperCase());
  return Array.from(out);
}

function mapTokensToPatternAreas(pattern, tokens) {
  const t = tokens.filter(x => !/^US\d+$/i.test(x));
  if (pattern === 'igetc' || pattern === 'cal_getc' || pattern === 'butte_local') {
    return t.map(x => x.replace(/^AREA\s*/i, '').toUpperCase());
  }
  if (pattern === 'csu_breadth') {
    const map = { '1A':'A2','1B':'A3','1C':'A1','2A':'B4','3A':'C1','3B':'C2','4':'D','5A':'B1','5B':'B2','5C':'B3','7':'F' };
    return t.map(x => {
      const k = x.replace(/^AREA\s*/i, '').toUpperCase();
      if (/^(A[123]|B[1234]|C[12]|D|E|F)$/.test(k)) return k;
      return map[k];
    }).filter(Boolean);
  }
  return [];
}

// Exam → course equivalency (local) for program evaluation.
function buildExamEquivalencyCodes(userExams) {
  const out = [];
  for (const ux of userExams) {
    const rows = state.examData[ux.program] || [];
    const row = rows.find(r => r.exam === ux.exam);
    if (!row) continue;
    if (!meetsScore(row, 'butte_local', ux.score)) continue;
    const eq = row.butte_course_equivalencies || [];
    for (const code of eq) out.push(norm(canonicalizeCode(code)));
  }
  return Array.from(new Set(out));
}

function disciplineFromPrefix(code) {
  const canon = canonicalizeCode(code).toUpperCase();
  const prefix = canon.split(/\s+/)[0].replace(/[^A-Z]/g, "");
  const prefixAliases = state.courseAliases.prefix_alias_to_canonical_prefix || {};
  return prefixAliases[prefix] || prefix;
}

// ======== GE Deduplication ========
// Keep only the latest identical GE set per pattern.
function dedupeSameGEByYear(geByYear) {
  const byScheme = new Map();
  for (const entry of geByYear.sort((a,b)=>a.catalog_year.localeCompare(b.catalog_year))) {
    const sig = geSignature(entry);
    const key = `${entry.pattern}:${sig}`;
    byScheme.set(key, entry);
  }
  const latestByScheme = new Map();
  for (const v of byScheme.values()) {
    const k = v.pattern;
    const prev = latestByScheme.get(k);
    if (!prev || v.catalog_year > prev.catalog_year) latestByScheme.set(k, v);
  }
  return [...latestByScheme.values()];
}

function geSignature(geObj) {
  return JSON.stringify(geObj, Object.keys(geObj).sort());
}

// ======== Global State ========
const state = {
  coursesIndex: new Map(),
  coursesList: [],
  courseAliases: {},
  geSets: [],
  programs: [],
  terms: [],
  rights: { auto:true, allow: new Set() },
  examData: { AP: [], IB: [], CLEP: [], Other: [] },
  examNotes: [],
  userExams: [],
};

// ======== Data Loading ========
// Loads aliases → courses → exams → GE schemas → programs. Displays status badges.
async function fetchJSON(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`Failed loading ${path}`);
  return res.json();
}

async function loadData() {
  const status = $('#data-status');
  const badges = [];
  const pushBadge = (label, ok=true) => {
    const el = document.createElement('div');
    el.className = `badge ${ok?'ok':''}`;
    el.textContent = label;
    badges.push(el);
  };

  try {
    state.courseAliases = await fetchJSON('courses/course_aliases.json');
    pushBadge('Course aliases loaded');
  } catch(e) {
    pushBadge('Course aliases: failed', false);
    console.error(e);
  }

  try {
    const courses = await fetchJSON('courses/courses_cleaned.json');
    for (const c of courses) {
      const code = normalizeCode(c.CourseCode);
      state.coursesIndex.set(code, c);
    }
    state.coursesList = Array.from(state.coursesIndex.keys()).sort();
    pushBadge(`Courses: ${state.coursesIndex.size} loaded`);
  } catch(e) {
    pushBadge('Courses: failed', false);
    console.error(e);
  }

  // Index alias codes to canonical records and expose in datalist.
  (function indexAliasesIntoCourseIndex(){
    const map = state.courseAliases.alias_to_canonical_codes || {};
    for (const [alias, canon] of Object.entries(map)) {
      const canonicalRec = state.coursesIndex.get(canon);
      if (canonicalRec) state.coursesIndex.set(alias, canonicalRec);
    }
    state.coursesList = Array.from(new Set([...state.coursesList, ...Object.keys(map)])).sort();
  })();

  try {
    state.examData.AP = await fetchJSON('exams/exams_ap.json');
    state.examData.IB = await fetchJSON('exams/exams_ib.json');
    state.examData.CLEP = await fetchJSON('exams/exams_clep.json');
    state.examNotes = await fetchJSON('exams/exams_notes.json');
    // Add "Other" entries (e.g., LOTE)
    state.examData.Other = [
      {
        program: "Other",
        exam: "IGETC 6A — LOTE (2 years HS)",
        min_score_butte_csu: null,
        min_score_cal_getc: null,
        score_cutoff: null,
        butte_ge_area: null,
        butte_course_equivalencies: null,
        butte_units: 0,
        butte_ge_units_cap: null,
        csu_ge_area: null,
        csu_ge_units: 0,
        csu_transfer_units: 0,
        cal_getc_area: null,
        cal_getc_units: 0,
        uc_transfer_units: 0,
        notes: "High school language other than English - 2 years same language"
      }
    ];
    const total = state.examData.AP.length + state.examData.IB.length + state.examData.CLEP.length + state.examData.Other.length;
    pushBadge(`Exam credits: ${total} loaded`);
  } catch(e) {
    pushBadge('Exam credits: failed', false);
    console.error(e);
  }

  const gePaths = [
    'ge/2023/ge_csu.json','ge/2023/ge_igetc.json',
    'ge/2024/ge_csu.json','ge/2024/ge_igetc.json','ge/2024/ge_local.json',
    'ge/2025/ge_calgetc.json','ge/2025/ge_local.json',
  ];
  const rawGeSets = [];
  for (const p of gePaths) {
    try {
      const g = await fetchJSON(p);
      rawGeSets.push({...g, id:p});
    } catch(e) {
      console.warn('GE load failed', p, e);
    }
  }
  state.geSets = dedupeSameGEByYear(rawGeSets);
  pushBadge(`GE schemas: ${state.geSets.length} loaded (${rawGeSets.length} total)`);

  const yearFiles = [
    'programs/programs_2018.json','programs/programs_2019.json','programs/programs_2020.json',
    'programs/programs_2021.json','programs/programs_2022.json','programs/programs_2023.json',
    'programs/programs_2024.json','programs/programs_2025.json'
  ];
  let progCount=0;
  for (const f of yearFiles) {
    try {
      const pj = await fetchJSON(f);
      if (Array.isArray(pj.programs)) {
        state.programs.push(...pj.programs.map(p => ({...p, source_file:f})));
        progCount+=pj.programs.length;
      }
    } catch(e) {}
  }
  pushBadge(`Programs: ${progCount} loaded`);

  status.replaceChildren(...badges);

  buildCourseDatalist();
  renderRightsControls();
  renderGETabs();
  populateExamOptions();
  renderExamCredits();

  // IGETC 6A waiver toggle via "Other" LOTE
  const loteBox = $('#lote-waiver');
  if (loteBox) {
    const LOTE = { program: 'Other', exam: 'IGETC 6A — LOTE (2 years HS)', score: 1 };
    const isOn = () => state.userExams.some(e => e.program === LOTE.program && e.exam === LOTE.exam);
    const syncBox = () => { loteBox.checked = isOn(); };
    syncBox();

    loteBox.addEventListener('change', () => {
      const idx = state.userExams.findIndex(e => e.program === LOTE.program && e.exam === LOTE.exam);
      if (loteBox.checked) {
        if (idx === -1) state.userExams.push(LOTE);
      } else {
        if (idx !== -1) state.userExams.splice(idx, 1);
      }
      renderExamCredits();
      recalcAll();
    });
  }

  recalcAll();
}

function buildCourseDatalist() {
  const dl = $('#course-codes');
  dl.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const code of state.coursesList) {
    const opt = document.createElement('option');
    opt.value = code;
    frag.appendChild(opt);
  }
  dl.appendChild(frag);
}

// ======== Terms UI ========
function addTerm(season, year) {
  const t = {season, year:parseInt(year,10), items:[{code:'', grade:'IP'}]};
  state.terms.push(t);
  state.terms.sort(compareTerms);
  renderTerms(); recalcAll();

  // Focus the first input of the new term
  const idx = state.terms.indexOf(t);
  const termsEls = $$('#terms .term');
  const thisTermEl = termsEls[idx];
  $$('.course-code', thisTermEl)[0]?.focus();
}

function removeTerm(idx) {
  state.terms.splice(idx,1);
  renderTerms();
  recalcAll();
}

function renderTerms() {
  const container = $('#terms');
  container.innerHTML = '';
  const tplTerm = $('#tpl-term');
  const tplRow = $('#tpl-row');

  state.terms.forEach((term, tIdx) => {
    const termEl = tplTerm.content.firstElementChild.cloneNode(true);
    $('.term-title', termEl).textContent = `${term.season} ${term.year}`;
    $('.add-row', termEl).addEventListener('click', () => {
      term.items.push({code:'', grade:'IP'});
      renderTerms(); recalcAll();
      // Focus newly added row
      const termsEls = $$('#terms .term');
      const thisTermEl = termsEls[tIdx];
      const inputs = $$('.course-code', thisTermEl);
      inputs[inputs.length - 1]?.focus();
    });
    $('.remove-term', termEl).addEventListener('click', () => { removeTerm(tIdx); });

    const tbody = $('tbody', termEl);
    term.items.forEach((row, rIdx) => {
      const tr = tplRow.content.firstElementChild.cloneNode(true);
      const inp = $('.course-code', tr);
      const gradeSel = $('.grade', tr);
      const cellUnits = $('.cell-units', tr);
      const cellTitle = $('.cell-title', tr);

      inp.value = row.code;
      gradeSel.value = row.grade || 'IP';

      const updateFromCode = () => {
        const norm = canonicalizeCode(inp.value);
        row.code = norm;
        const c = state.coursesIndex.get(norm);
        if (c) {
          cellUnits.textContent = c.MinimumCredits ?? '—';
          cellTitle.textContent = c.Title ?? '—';
        } else {
          cellUnits.textContent = '—';
          cellTitle.textContent = '—';
        }
        recalcAll();
      };
      const updateGrade = () => { row.grade = gradeSel.value; recalcAll(); };

      // Normalize hyphen/space on blur
      inp.addEventListener('blur', () => {
        const norm = normalizeCode(inp.value);
        if (norm) inp.value = norm;
        updateFromCode();
      });
      inp.addEventListener('change', updateFromCode);
      inp.addEventListener('input', e => {});
      inp.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();

        const normVal = canonicalizeCode(inp.value);

        if (isValidCourse(normVal)) {
          inp.value = normalizeCode(normVal);
          updateFromCode();

          term.items.splice(rIdx + 1, 0, {code:'', grade:'IP'});
          renderTerms(); recalcAll();
          const termsEls = $$('#terms .term');
          const thisTermEl = termsEls[tIdx];
          const inputs = $$('.course-code', thisTermEl);
          inputs[rIdx + 1]?.focus();
          return;
        }

        // Not yet a valid course: autocomplete to first suggestion
        let suggestion = firstSuggestion(inp.value);
        if (!suggestion) {
          let v = normalizeCode(inp.value);
          while (v.length && !suggestion) {
            v = v.slice(0, -1).trim();
            suggestion = firstSuggestion(v);
          }
        }
        if (suggestion) {
          inp.value = suggestion;
          updateFromCode();
        }
      });
      gradeSel.addEventListener('change', updateGrade);

      $('.remove-row', tr).addEventListener('click', () => {
        term.items.splice(rIdx,1);
        renderTerms(); recalcAll();
      });

      tbody.appendChild(tr);
      updateFromCode();
    });

    container.appendChild(termEl);
  });
}

$('#add-term').addEventListener('click', () => {
  addTerm($('#term-season').value, $('#term-year').value);
});

// ======== Exam Credit UI ========
function renderExamCredits() {
  const container = $('#exam-credits');
  container.innerHTML = '';
  
  state.userExams.forEach((exam, idx) => {
    const div = document.createElement('div');
    div.className = 'exam-credit';
    const scoreDisplay = exam.program === 'Other' ? '' : `<span class="small" style="color:var(--muted)">Score: ${exam.score}</span>`;
    div.innerHTML = `
      <div class="exam-info">
        <span class="badge exam">${exam.program}</span>
        <span>${exam.exam}</span>
        ${scoreDisplay}
      </div>
      <button class="ghost small remove-exam" data-idx="${idx}">✕</button>
    `;
    container.appendChild(div);
  });
  
  $$('.remove-exam', container).forEach(btn => {
    btn.addEventListener('click', (e) => {
      const idx = parseInt(e.target.dataset.idx);
      state.userExams.splice(idx, 1);
      renderExamCredits();
      recalcAll();
    });
  });
}

// Supports both <select> and <input list> for exams.
function populateExamOptions() {
  const programSel = $('#exam-program');
  const examSel = $('#exam-name');
  const scoreFld = $('#exam-score');
  const addBtn = $('#add-exam');

  const isSelect = examSel && examSel.tagName === 'SELECT';

  function setExamOptions(exams) {
    if (isSelect) {
      examSel.innerHTML = '<option value="">Select Exam</option>';
      exams.forEach(exam => {
        const opt = document.createElement('option');
        opt.value = exam; opt.textContent = exam;
        examSel.appendChild(opt);
      });
      examSel.disabled = false;
    } else {
      const dlId = examSel.getAttribute('list');
      const dl = dlId ? document.getElementById(dlId) : null;
      if (dl) {
        dl.innerHTML = '';
        exams.forEach(exam => {
          const opt = document.createElement('option');
          opt.value = exam;
          dl.appendChild(opt);
        });
      }
      examSel.disabled = false;
    }
  }

  function currentExamValue() {
    return isSelect ? examSel.value : (examSel.value || '').trim();
  }

  programSel.addEventListener('change', () => {
    const program = programSel.value;
    const exams = (program && state.examData[program]) ? state.examData[program].map(e => e.exam).sort() : [];
    if (exams.length) {
      setExamOptions(exams);
      scoreFld.disabled = false;
      if (program === 'Other') {
        scoreFld.placeholder = 'N/A';
        scoreFld.value = '';
      } else {
        scoreFld.placeholder = 'Score';
      }
      addBtn.disabled = true;
    } else {
      if (isSelect) examSel.innerHTML = '<option value="">Select Exam</option>';
      examSel.disabled = true;
      scoreFld.value = '';
      scoreFld.disabled = true;
      addBtn.disabled = true;
    }
  });

  (isSelect ? examSel : scoreFld).addEventListener('change', () => {
    const ok = !!currentExamValue();
    addBtn.disabled = !ok;
  });
  if (!isSelect) {
    examSel.addEventListener('input', () => {
      addBtn.disabled = !(currentExamValue().length);
    });
  }

  addBtn.addEventListener('click', (ev) => {
    ev.preventDefault();
    const program = programSel.value;
    const exam = currentExamValue();
    const score = Number(scoreFld.value);

    if (!program) { alert('Pick AP, IB, CLEP, or Other'); return; }
    if (!exam) { alert('Select an exam'); return; }
    if (program !== 'Other' && !Number.isFinite(score)) { alert('Enter a valid score'); return; }

    if (state.userExams.some(e => e.program === program && e.exam === exam)) {
      alert('This exam credit is already added.');
      return;
    }

    const finalScore = program === 'Other' ? 1 : score;
    state.userExams.push({ program, exam, score: finalScore });
    renderExamCredits();
    recalcAll();

    if (isSelect) examSel.innerHTML = '<option value="">Select Exam</option>';
    examSel.value = '';
    examSel.disabled = true;
    programSel.value = '';
    scoreFld.value = '';
    scoreFld.disabled = true;
    addBtn.disabled = true;
  });
}

// ======== Save/Load Plan ========
$('#btn-export').addEventListener('click', () => {
  const payload = {
    terms: state.terms,
    rights: {auto: state.rights.auto, allow: Array.from(state.rights.allow)},
    userExams: state.userExams
  };
  const blob = new Blob([JSON.stringify(payload,null,2)], {type:'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'plan.json';
  a.click();
});
$('#file-import').addEventListener('change', async (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  const txt = await f.text();
  try {
    const data = JSON.parse(txt);
    state.terms = Array.isArray(data.terms) ? data.terms : [];
    state.rights.auto = !!(data.rights?.auto);
    state.rights.allow = new Set(data.rights?.allow || []);
    state.userExams = Array.isArray(data.userExams) ? data.userExams : [];
    renderTerms();
    renderRightsControls();
    renderExamCredits();
    recalcAll();
  } catch(err) {
    console.error('Import error', err);
    alert('Invalid plan file');
  } finally {
    e.target.value='';
  }
});

// ======== GPA / Units ========
// GPA ignores P/NP/W. Units: completed/IP/PL split.
function computeTranscript(terms=state.terms) {
  const rows = [];
  for (const t of terms) {
    for (const it of t.items) {
      if (!it.code) continue;
      const codeCanon = canonicalizeCode(it.code);
      const c = state.coursesIndex.get(codeCanon);
      const units = c?.MinimumCredits ?? 0;
      rows.push({code:codeCanon, grade:it.grade, units, title:c?.Title ?? '', isPass: PASSING_GE.has(it.grade)});
    }
  }
  const completed = rows.filter(r => !['IP','PL','W'].includes(r.grade));
  const ip = rows.filter(r => r.grade==='IP');
  const pl = rows.filter(r => r.grade==='PL');
  let pts=0, u=0;
  for (const r of completed) {
    const gp = GRADE_POINTS[r.grade];
    if (gp === null || gp === undefined) continue;
    pts += gp * r.units;
    u += r.units;
  }
  return {
    all: rows, completed, ip, pl,
    gpa: u>0 ? (pts/u) : null,
    unitsCompleted: sum(completed.filter(r=>GRADE_POINTS[r.grade]!==null).map(r=>r.units)),
    unitsIP: sum(ip.map(r=>r.units)),
    unitsPL: sum(pl.map(r=>r.units)),
  };
}

// ======== Catalog Rights ========
// AY: Fall y => y-(y+1); Spring/Summer y => (y-1)-y.
function termToAY(season, year) {
  year = parseInt(year,10);
  if (season==='Fall') return AY_LABEL(year);
  if (season==='Spring' || season==='Summer') return AY_LABEL(year-1);
  return AY_LABEL(year);
}

// Auto rights continuity: reset on gaps > 1 year.
function computeAutoRights() {
  const ays = state.terms
    .filter(t => t.items.some(i => i.code && i.grade !== 'PL'))
    .map(t => termToAY(t.season, t.year));
  const uniqAYs = Array.from(new Set(ays)).sort();
  if (!uniqAYs.length) return new Set();
  const years = uniqAYs.map(s => parseInt(s.slice(0,4),10)).sort((a,b)=>a-b);
  const keep = new Set();
  for (let i=0;i<years.length;i++){
    keep.add(AY_LABEL(years[i]));
    if (i>0 && years[i]-years[i-1]>1){
      keep.clear();
      keep.add(AY_LABEL(years[i]));
    }
  }
  return keep;
}

function renderRightsControls() {
  $('#rights-auto').checked = state.rights.auto;
  $('#rights-auto').onchange = () => { state.rights.auto = $('#rights-auto').checked; recalcAll(); };

  const man = $('#rights-manual');
  man.innerHTML = '';
  const knownAYs = uniq(state.geSets.map(g => g.catalog_year));
  knownAYs.sort();
  for (const ay of knownAYs) {
    const id = `rights-${ay}`;
    const label = document.createElement('label');
    label.style.display='inline-flex'; label.style.alignItems='center'; label.style.gap='6px'; label.style.marginRight='10px';
    label.innerHTML = `<input type="checkbox" id="${id}"> ${ay}`;
    man.appendChild(label);
    const box = $('#'+id);
    box.checked = state.rights.allow.has(ay);
    box.onchange = () => {
      if (box.checked) state.rights.allow.add(ay);
      else state.rights.allow.delete(ay);
      recalcAll();
    };
  }
}

function rightsAvailable() {
  const autoSet = state.rights.auto ? computeAutoRights() : new Set();
  const manual = state.rights.allow;
  return new Set([...autoSet, ...manual]);
}

function renderRightsReadout(allowSet) {
  const div = $('#rights-readout');
  div.innerHTML = '';
  if (!allowSet.size) { div.textContent = 'No eligible catalog years yet.'; return; }

  const eligible = state.geSets.filter(g => allowSet.has(g.catalog_year));
  const chips = eligible.map(g => {
    const el = document.createElement('span');
    el.className='badge';
    el.textContent = `${g.pattern.toUpperCase()} ${g.catalog_year}`;
    return el;
  });

  const groups = {};
  for (const g of eligible) {
    groups[g.catalog_year] ??= [];
    groups[g.catalog_year].push(g.pattern);
  }
  const lines = Object.entries(groups).sort((a,b)=>a[0].localeCompare(b[0]))
    .map(([ay, pats]) => `${ay}: ${pats.join(', ')}`);

  const p = document.createElement('div');
  p.style.marginTop='6px';
  p.style.color='var(--muted)';
  p.textContent = lines.join('  •  ');

  div.append(...chips, p);
}

// ======== GE Evaluation ========
// Greedy-ish optimizer; each course counts once.
// - Builds area buckets (includes catalog + exam pseudo-courses)
// - Handles OR groups with a simple branch scoring (units, then courses)
// - Enforces distinct disciplines and lab attributes
function geSetsEligible() {
  const allow = rightsAvailable();
  return state.geSets.filter(g => allow.has(g.catalog_year));
}

function buildGELookups(ge) {
  const bucketMap = {};
  for (const [area, obj] of Object.entries(ge.buckets || {})) {
    const codes = [];
    for (const raw of (obj.courses||[])) {
      for (const exp of expandSlashTokens(normalizeCode(raw))) {
        codes.push(canonicalizeCode(exp));
      }
    }
    bucketMap[area] = new Set(codes);
  }
  const attrMap = {};
  for (const [attr, arr] of Object.entries(ge.attributes || {})) {
    const set = new Set();
    for (const raw of arr) {
      for (const exp of expandSlashTokens(normalizeCode(raw))) {
        set.add(canonicalizeCode(exp));
      }
    }
    attrMap[attr] = set;
  }
  return {bucketMap, attrMap};
}

function evaluateGE(ge, transcript, includeExams = true) {
  const {bucketMap, attrMap} = buildGELookups(ge);

  const orGroups = {};   // label -> children
  const orChoice = {};   // label -> chosen

  const realCourses = transcript.completed.filter(r => r.isPass);
  const examCourses = buildExamPseudoCourses(state.userExams, ge.pattern);
  const examUnits = Object.fromEntries(examCourses.map(x => [x.code, x.units || 0]));
  
  // Map pseudo-courses into areas for this pattern
  const examByArea = {};
  for (const ex of examCourses) {
    for (const areaStr of (ex.geAreas || [])) {
      const tokens = areaStr
        .replace(/\bAreas?\b/gi, '')
        .replace(/\bArea\b/gi, '')
        .split(/(?:&|or|,)/i)
        .map(s => s.trim().toUpperCase())
        .filter(Boolean);
      for (const token of tokens) {
        const mappedAreas = mapTokensToPatternAreas(ge.pattern, [token]);
        for (const area of mappedAreas) {
          if (!examByArea[area]) examByArea[area] = new Set();
          examByArea[area].add(ex.code);
        }
      }
    }
  }

  const okCourses = new Set(realCourses.map(r => r.code));
  for (const ex of examCourses) okCourses.add(ex.code);

  function unitsFor(code) {
    if (examUnits[code] !== undefined) return examUnits[code];
    return (state.coursesIndex.get(code)?.MinimumCredits) || 0;
  }

  const areaCandidates = {};
  for (const [area, set] of Object.entries(bucketMap)) {
    const fromCatalog = [...set].filter(c => okCourses.has(c));
    const fromExams = examByArea[area] ? [...examByArea[area]] : [];
    areaCandidates[area] = [...new Set([...fromCatalog, ...fromExams])];
  }

  function pickForArea(areaObj, used) {
    const area = areaObj.area;
    const needCourses = areaObj.min_courses || 0;
    const needUnits = areaObj.min_units || 0;

    const cands = areaCandidates[area] || [];
    const pool = cands.filter(c => !used.has(c));
    if (!pool.length) return {chosen:[], units:0, satisfied:false};

    const multiUseCount = c => countAreasContaining(c) - 1;
    function countAreasContaining(code) {
      let cnt=0;
      for (const s of Object.values(bucketMap)) if (s.has(code)) cnt++;
      return cnt;
    }
    const scored = pool.map(c => ({c, u:unitsFor(c), w:multiUseCount(c)}));
    scored.sort((a,b)=> a.w - b.w || b.u - a.u); // prefer unique, then higher units

    const chosen = [];
    let units=0;
    const needDistinct = areaObj.distinct_disciplines || 0;
    const seenPrefixes = new Set();

    for (const it of scored) {
      const pref = examUnits[it.c] !== undefined ? `EXAM:${it.c}` : prefixOf(it.c);
      if (needDistinct && seenPrefixes.has(pref)) continue;
      chosen.push(it.c);
      units += it.u;
      seenPrefixes.add(pref);
      const ok1 = chosen.length >= needCourses;
      const ok2 = units >= needUnits;
      if (ok1 && ok2) break;
    }

    // If still short on units, fill (respect distinct if required)
    if (units < needUnits) {
      for (const it of scored) {
        if (chosen.includes(it.c)) continue;
        const pref = examUnits[it.c] !== undefined ? `EXAM:${it.c}` : prefixOf(it.c);
        if (needDistinct && seenPrefixes.has(pref)) continue;
        chosen.push(it.c); units+=it.u; seenPrefixes.add(pref);
        if (units>=needUnits) break;
      }
    }

    // IGETC 6A via LOTE waives units
    if (area === '6A' && chosen.some(c => c.startsWith('EXAM:Other:IGETC 6A'))) {
      return { chosen, units, satisfied: chosen.length >= needCourses };
    }

    const satisfied = (chosen.length >= needCourses) && (units >= needUnits);
    return {chosen, units, satisfied};
  }

  // Attribute requirements (e.g., lab): allocate once and count toward an area and synthetic bucket.
  function satisfyRequires(requireObj, used, alloc) {
    const attr = requireObj.attribute;
    const count = requireObj.count || 1;
    const fromAreas = requireObj.from_areas || [];
    const satArea = requireObj.satisfies_area; // e.g. "B3"
    const labSet = attrMap[attr] || new Set();

    const pool = [];
    for (const a of fromAreas) {
      for (const c of (areaCandidates[a]||[])) {
        if (!used.has(c) && labSet.has(c)) pool.push({a,c, u:unitsFor(c)});
      }
    }
    pool.sort((x,y)=>y.u-x.u);
    let picked=0;
    for (const item of pool) {
      used.add(item.c);

      if (!alloc[item.a]) alloc[item.a] = [];
      if (alloc[item.a].length === 0 && !alloc[item.a].includes(item.c)) {
        alloc[item.a].push(item.c);
      }

      if (satArea) {
        if (!alloc[satArea]) alloc[satArea] = [];
        if (!alloc[satArea].includes(item.c)) alloc[satArea].push(item.c);
      }

      picked++;
      if (picked>=count) break;
    }
    return picked>=count;
  }

  const alloc = {};
  const used = new Set();

  function walk(node) {
    if (!node) return {ok:true};
    if (node.area) {
      const res = pickForArea(node, used);
      if (res.chosen.length) {
        alloc[node.area] = alloc[node.area] || [];
        for (const c of res.chosen) { if (!used.has(c)) { alloc[node.area].push(c); used.add(c); } }
      }
      return {ok:res.satisfied};
    }
    if (node.bucket) {
      const leaf = { ...node, area: node.bucket };
      const res = pickForArea(leaf, used);
      if (res.chosen.length) {
        alloc[leaf.area] = alloc[leaf.area] || [];
        for (const c of res.chosen) { if (!used.has(c)) { alloc[leaf.area].push(c); used.add(c); } }
      }
      return { ok: res.satisfied };
    }
    if (node.op === 'AND') {
      const sub = node.nodes || [];
      const out = [];

      for (const n of sub.filter(x => x.op)) out.push(walk(n));
      for (const n of sub.filter(x => x.area)) out.push(walk(n));
      for (const n of sub.filter(x => x.require)) {
        const ok = satisfyRequires(n.require, used, alloc);
        out.push({ ok });
      }

      // Group-level minima (units/courses) across direct child areas
      const groupMinCourses = node.min_total_courses || 0;
      const groupMinUnits = node.min_units || 0;
      if (groupMinCourses || groupMinUnits) {
        let haveCourses = 0, haveUnits = 0;
        const involvedAreas = sub.filter(x => (x.area || x.bucket))
                                 .map(x => (x.area || x.bucket));
        for (const a of involvedAreas) {
          const list = alloc[a] || [];
          haveCourses += list.length;
          haveUnits += sum(list.map(c => unitsFor(c)));
        }
        const deficitCourses = Math.max(0, groupMinCourses - haveCourses);
        const deficitUnits = Math.max(0, groupMinUnits - haveUnits);
        if (deficitCourses > 0 || deficitUnits > 0) {
          const pools = involvedAreas
            .map(a => (areaCandidates[a] || [])
            .filter(c => !used.has(c))
            .map(c => ({ a, c, u: unitsFor(c) })))
            .flat()
            .sort((x, y) => y.u - x.u);
          for (const p of pools) {
            (alloc[p.a] ||= []).push(p.c);
            used.add(p.c);
            haveCourses++; haveUnits += p.u;
            if (haveCourses >= groupMinCourses && haveUnits >= groupMinUnits) break;
          }
        }
        out.push({ ok: haveCourses >= groupMinCourses && haveUnits >= groupMinUnits });
      }

      return { ok: out.every(r => r.ok) };
    }
    if (node.op === 'OR') {
      const kids = node.nodes || [];
      const kidAreas = kids.map(c => (c.area || c.bucket)).filter(Boolean);
      const groupLabel =
        (node.display_as && node.display_as.trim()) ||
        (node.group) ||
        (kidAreas.length ? kidAreas.join('/') : 'OR');

      function snapshot() {
        return {
          used: new Set([...used]),
          alloc: JSON.parse(JSON.stringify(alloc)),
        };
      }
      function restore(snap) {
        used.clear(); for (const v of snap.used) used.add(v);
        for (const k of Object.keys(alloc)) delete alloc[k];
        Object.assign(alloc, snap.alloc);
      }
      function deltaScore(before, after) {
        let units = 0, courses = 0;
        const areas = new Set([...Object.keys(after), ...Object.keys(before)]);
        for (const a of areas) {
          const bset = new Set(before[a] || []);
          for (const c of (after[a] || [])) {
            if (!bset.has(c)) { courses += 1; units += unitsFor(c); }
          }
        }
        return { units, courses };
      }

      let best = null;
      for (const child of kids) {
        const snap = snapshot();
        const res = walk(child);
        const score = deltaScore(snap.alloc, alloc);
        const choice = { child, ok: !!res.ok, score, snap };
        if (!best) best = choice;
        else {
          const a = best, b = choice;
          const better =
            (b.ok && !a.ok) ||
            (b.ok === a.ok && (b.score.units > a.score.units ||
                               (b.score.units === a.score.units && b.score.courses > a.score.courses)));
          if (better) best = choice;
        }
        restore(snap);
      }

      if (best) {
        walk(best.child);
        orGroups[groupLabel] = kidAreas;
        const chosenArea = kidAreas.find(a => (alloc[a] || []).length > 0) || kidAreas[0];
        orChoice[groupLabel] = chosenArea;
        alloc[groupLabel] = (alloc[chosenArea] || []).slice();
        return { ok: true };
      }
      return { ok: false };
    }
    return {ok:true};
  }

  walk(ge.logic);

  // Build area summary (including OR display groups and synthetic areas like B3/5C)
  const perArea = {};
  for (const [area, set] of Object.entries(bucketMap)) {
    const a = {have: alloc[area]?.length || 0, units: sum((alloc[area]||[]).map(c => unitsFor(c)))};
    const spec = findAreaSpec(ge.logic, area) || {};
    a.needCourses = spec.min_courses || 0;
    a.needUnits = spec.min_units || 0;
    a.distinct = spec.distinct_disciplines || 0;
    if (ge.pattern === 'igetc' && area === '6A') {
      const chosen = alloc[area] || [];
      if (chosen.some(c => c.startsWith('EXAM:Other:IGETC 6A'))) a.needUnits = 0;
    }
    perArea[area] = a;
  }

  const minOrZero = arr => arr.length ? Math.min(...arr) : 0;
  for (const [label, children] of Object.entries(orGroups)) {
    const chosen = orChoice[label];
    const chosenList = alloc[label] || [];
    const childSpecs = children.map(a => findAreaSpec(ge.logic, a) || {});
    const needCourses = minOrZero(childSpecs.map(s => s.min_courses || 0));
    const needUnits   = minOrZero(childSpecs.map(s => s.min_units   || 0));

    perArea[label] = {
      have: chosenList.length,
      units: sum(chosenList.map(c => unitsFor(c))),
      needCourses,
      needUnits,
      distinct: 0
    };
  }

  for (const area of Object.keys(alloc)) {
    if (!perArea[area]) {
      const list = alloc[area];
      perArea[area] = {
        have: list.length,
        units: sum(list.map(c => unitsFor(c))),
        needCourses: 1,
        needUnits: 0,
        distinct: 0
      };
    }
  }

  // % complete = required leaves satisfied / leaves
  const reqLeaves = listAreaLeaves(ge.logic);
  const doneLeaves = reqLeaves.filter(a => {
    const s = perArea[a];
    return (!s) ? false : (s.have >= (s.needCourses||0) && s.units >= (s.needUnits||0));
  });
  const pct = reqLeaves.length ? Math.round(100 * doneLeaves.length / reqLeaves.length) : 0;

  return {alloc, perArea, percent: pct, displayGroups: orGroups};
}

function findAreaSpec(node, area) {
  if (!node) return null;
  if (node.area === area || node.bucket === area) return node;
  const kids = node.nodes || [];
  for (const k of kids) {
    const hit = findAreaSpec(k, area);
    if (hit) return hit;
  }
  return null;
}
function listAreaLeaves(node, out=[]) {
  if (!node) return out;
  if (node.area) { out.push(node.area); return out; }
  if (node.bucket) { out.push(node.bucket); return out; }
  if (node.op === 'OR') {
    const kids = node.nodes || [];
    const labels = kids.map(k => (k.area || k.bucket)).filter(Boolean);
    const label =
      (node.display_as && node.display_as.trim()) ||
      node.group ||
      (labels.length ? labels.join('/') : 'OR');
    out.push(label);
    return out;
  }
  for (const k of (node.nodes||[])) listAreaLeaves(k, out);
  return uniq(out);
}

// ======== GE UI ========
function renderGETabs() {
  const tabs = $('#ge-tabs');
  tabs.innerHTML = '';
  const eligible = geSetsEligible();
  if (!eligible.length) {
    tabs.textContent = 'No GE set available yet. Add terms/courses to establish rights.';
    $('#ge-content').innerHTML = '';
    return;
  }
  eligible.forEach((g, idx) => {
    const b = document.createElement('button');
    b.className = 'tab' + (idx===0 ? ' active':'');
    b.textContent = `${g.pattern.toUpperCase()} ${g.catalog_year}`;
    b.dataset.id = g.id;
    b.onclick = () => {
      $$('.tab', tabs).forEach(x=>x.classList.remove('active')); b.classList.add('active');
      renderGECard(g);
    };
    tabs.appendChild(b);
  });
  renderGECard(eligible[0]);
}

function renderGECard(ge) {
  const box = $('#ge-content');
  const tr = computeTranscript();
  const res = evaluateGE(ge, tr);

  box.innerHTML = `
    <div class="ge-card">
      <div class="ge-head">
        <div>
          <div><strong>${ge.pattern.toUpperCase()}</strong> • ${ge.catalog_year}</div>
          <div class="small" style="color:var(--muted)">Optimized assignment shown. One course counts once.</div>
        </div>
        <div class="progress"><div style="width:${res.percent}%"></div></div>
      </div>
      <div class="area-list" id="ge-areas"></div>
    </div>
  `;
  const areasEl = $('#ge-areas', box);

  const entries = Object.entries(res.perArea).sort((a,b)=>a[0].localeCompare(b[0]));
  const hiddenAreas = new Set();
  for (const [label, kids] of Object.entries(res.displayGroups || {})) {
    kids.forEach(k => hiddenAreas.add(k));
  }
  const displayEntries = entries.filter(([area]) => !hiddenAreas.has(area));

  for (const [area, s] of displayEntries) {
    const usedList = res.alloc[area] || [];
    const needC = s.needCourses || 0, needU = s.needUnits || 0;
    const ok = (s.have>=needC && s.units>=needU);
    const div = document.createElement('div');
    div.className = 'area';
    div.innerHTML = `
      <h4>${area}</h4>
      <div class="kv"><span class="k">Courses:</span><span class="v">${s.have}/${needC}</span>
                      <span class="k">Units:</span><span class="v">${s.units}/${needU}</span>
                      ${s.distinct?`<span class="k">Distinct:</span><span class="v">${s.distinct}</span>`:''}
                      <span class="k">Status:</span><span class="v" style="color:${ok?'var(--ok)':'var(--warn)'}">${ok?'OK':'In progress'}</span>
      </div>
      <div class="small" style="margin-top:6px">${usedList.length?usedList.join(', '):'—'}</div>
    `;
    areasEl.appendChild(div);
  }
}

// ======== Program “Closeness” ========
// Determine which GE patterns matter for a program type.
function programRequiresGE(prog) {
  const t = prog.program_type || '';
  const isADT = /for Transfer Degree|AS-T|AA-T/i.test(t);
  const isAAAS = /Associate in (Arts|Science) Degree/i.test(t) && !isADT;
  const needsLocal = isAAAS;
  const needsADTGE = isADT;
  return {needsLocal, needsADTGE};
}

function gePatternForCertificate(prog) {
  if (!/Certificate/i.test(prog.program_type || '')) return null;
  const name = (prog.name || '').toLowerCase();
  const meta = (prog.detail?.ge_patterns || []).map(s => String(s).toLowerCase());
  const hay = name + ' ' + meta.join(' ');
  if (hay.includes('cal-getc') || hay.includes('cal getc')) return 'cal_getc';
  if (hay.includes('igetc')) return 'igetc';
  if (hay.includes('csu') && (hay.includes('breadth') || hay.includes('ge'))) return 'csu_breadth';
  return null;
}

function eligibleProgramsByRights() {
  const allow = rightsAvailable();
  return state.programs.filter(p => allow.has(p.year_label));
}

function scoreProgramCourseCompletion(prog, transcript, countPlanned=false) {
  // New schema: items are objects with any_of arrays.
  const usesNew =
    Array.isArray(prog.detail?.sections) &&
    prog.detail.sections.some(sec =>
      Array.isArray(sec.items) &&
      sec.items.some(it => it && typeof it === 'object' && Array.isArray(it.any_of))
    );

  if (usesNew) {
    return evaluateProgram(prog.detail, transcript, countPlanned);
  }

  // Legacy fallback
  const have = new Set(transcript.completed.filter(r=>r.isPass).map(r=>r.code));
  if (countPlanned) {
    transcript.ip.forEach(r=>have.add(r.code));
    transcript.pl.forEach(r=>have.add(r.code));
  }

  let requiredItems = 0;
  let satisfied = 0;

  const details = [];
  const sec = prog.detail?.sections || [];
  for (const s of sec) {
    const secRow = { section: s.name || 'Section', items: [] };
    for (const item of (s.items||[])) {
      requiredItems++;
      if (Array.isArray(item)) {
        const options = item.map(c => normalizeCode(c));
        const matched = options.find(opt => have.has(opt)) || null;
        if (matched) satisfied++;
        secRow.items.push({ type:'or', met: !!matched, matched, options });
      } else {
        const code = normalizeCode(item);
        const met = have.has(code);
        if (met) satisfied++;
        secRow.items.push({ type:'single', met, matched: met ? code : null, options:[code] });
      }
    }
    details.push(secRow);
  }
  const pct = requiredItems ? (satisfied/requiredItems) : 0;
  return {pct, requiredItems, satisfied, confidence: 1.0, details};
}

function geCompletionForProgram(prog, tr) {
  const geEligible = geSetsEligible();

  // GE certificate programs: score via GE engine only
  const certPattern = gePatternForCertificate(prog);
  if (certPattern) {
    const candidates = geEligible.filter(g => g.pattern === certPattern);
    if (!candidates.length) {
      return { pct: 0, label: `${certPattern.toUpperCase()} not available under rights` };
    }
    candidates.sort((a,b)=>a.catalog_year.localeCompare(b.catalog_year));
    const g = candidates[candidates.length - 1];

    const out = evaluateGE(g, tr);

    // Rough “classes left”: max of course deficit and units/3
    const leaves = listAreaLeaves(g.logic);
    let missing = 0;
    for (const a of leaves) {
      const s = out.perArea[a] || { have:0, units:0, needCourses:0, needUnits:0 };
      const needC = s.needCourses || 0;
      const needU = s.needUnits || 0;
      const haveC = s.have || 0;
      const haveU = s.units || 0;

      const defC = Math.max(0, needC - haveC);
      const defU = Math.max(0, needU - haveU);
      const unitAsClasses = defU > 0 ? Math.ceil(defU / 3) : 0;

      missing += Math.max(defC, unitAsClasses);
    }

    return {
      pct: out.percent / 100,
      label: `${g.pattern.toUpperCase()} ${g.catalog_year}`,
      patternUsed: g.pattern,
      geSetId: g.id,
      est_remaining_courses: missing
    };
  }

  const {needsLocal, needsADTGE} = programRequiresGE(prog);
  if (!needsLocal && !needsADTGE) return {pct:1, label:'No GE required (Certificate)'};

  const byPattern = (p) => geEligible.filter(g => g.pattern===p);
  let candidates = [];
  if (needsLocal) candidates.push(...byPattern('butte_local'));
  if (needsADTGE) {
    const cal = byPattern('cal_getc');
    if (cal.length) candidates.push(...cal);
    candidates.push(...byPattern('csu_breadth'));
    candidates.push(...byPattern('igetc'));
  }
  if (!candidates.length) return {pct:0, label:'No eligible GE pattern under rights'};

  let best = {pct:0, label:''};
  for (const g of candidates) {
    const out = evaluateGE(g, tr);
    if (out.percent/100 > best.pct) best = { pct: out.percent/100, label: `${g.pattern.toUpperCase()} ${g.catalog_year}` };
  }
  return best;
}

// Prefer newest AY per “family”, then by higher score.
function stableProgramKey(p) {
  const raw = (p.program_code || '').replace(/\s+/g, '');
  if (raw) {
    const m = raw.match(/^([A-Z0-9]+)\.(\d+)([A-Z-]+)$/i);
    if (m) return `fam:${slug(m[1] + m[3])}`;
    return `code:${slug(raw.replace(/\.\d+/, ''))}`;
  }
  return `name:${slug(p.name)}|type:${slug(p.program_type)}`;
}

function rankPrograms() {
  const tr = computeTranscript();
  const countPlanned = $('#include-planned').checked;
  const ignoreGE = $('#ignore-ge')?.checked;
  const sortMode = $('#prog-sort')?.value || 'score';

  const list = eligibleProgramsByRights();

  const typeFilter = $('#prog-type-filter').value || '';
  const deptFilter = ($('#prog-dept-filter').value || '').trim().toLowerCase();

  const rows = [];
  for (const p of list) {
    if (typeFilter && p.program_type !== typeFilter) continue;
    if (deptFilter && !(p.department||'').toLowerCase().includes(deptFilter)) continue;

    const courseScore = scoreProgramCourseCompletion(p, tr, countPlanned);
    const geScore = geCompletionForProgram(p, tr);

    const {needsLocal, needsADTGE} = programRequiresGE(p);
    const isGECert = !!(gePatternForCertificate(p)) && (courseScore.requiredItems || 0) === 0;
    const geRequired = isGECert || needsLocal || needsADTGE;

    const wProg = ignoreGE ? 1.0 : (geRequired ? 0.7 : 1.0);
    const wGE   = ignoreGE ? 0.0 : (geRequired ? 0.3 : 0.0);

    let total = wProg*courseScore.pct*courseScore.confidence + wGE*geScore.pct;

    if (isGECert) total = geScore.pct;

    let remainingProg = Math.max(0, (courseScore.requiredItems || 0) - (courseScore.satisfied || 0));
    let remainingSource = 'program';
    if (isGECert && geScore && geScore.est_remaining_courses != null) {
      remainingProg = geScore.est_remaining_courses;
      remainingSource = 'ge';
    }

    rows.push({ prog:p, total, courseScore, geScore, ignoreGE, geRequired, remainingProg, remainingSource });
  }

  // Dedup by stable family key; keep newest AY; tie-break by score
  const byKey = new Map();
  for (const r of rows) {
    const key = stableProgramKey(r.prog);
    const prev = byKey.get(key);
    if (!prev) { byKey.set(key, r); continue; }
    const a = prev, b = r;
    const ayA = parseInt((a.prog.year_label || '').slice(0,4), 10) || 0;
    const ayB = parseInt((b.prog.year_label || '').slice(0,4), 10) || 0;
    const better = (ayB > ayA) || (ayB === ayA && b.total > a.total);
    if (better) byKey.set(key, b);
  }

  const deduped = Array.from(byKey.values());

  if (sortMode === 'remaining_program') {
    deduped.sort((a, b) => {
      if (a.remainingProg !== b.remainingProg) return a.remainingProg - b.remainingProg;
      if (b.total !== a.total) return b.total - a.total;
      const ayA = parseInt((a.prog.year_label || '').slice(0,4), 10) || 0;
      const ayB = parseInt((b.prog.year_label || '').slice(0,4), 10) || 0;
      return ayB - ayA;
    });
  } else {
    deduped.sort((a,b)=> b.total - a.total);
  }

  return deduped.slice(0, 50);
}

function renderPrograms() {
  const container = $('#program-results');
  container.innerHTML = '';
  const rows = rankPrograms();

  for (const r of rows) {
    const p = r.prog;
    const isGECert = !!gePatternForCertificate(p) && (r.courseScore.requiredItems || 0) === 0;

    let remainingLabel = 'Classes left';
    let remainingVal = Math.max(0, (r.courseScore.requiredItems || 0) - (r.courseScore.satisfied || 0));
    if (isGECert && r.geScore && r.geScore.est_remaining_courses != null) {
      remainingLabel = 'Classes left (GE)';
      remainingVal = r.geScore.est_remaining_courses;
    }

    const crossListHeader = r.courseScore.crossListHeader 
      ? `<div style="margin:8px 0; padding:8px; background:var(--chip); border-radius:6px; font-size:12px; color:var(--muted)">${r.courseScore.crossListHeader}</div>`
      : '';
      
    const secHtml = (r.courseScore.details || []).map(sec => {
      const rows = sec.items.map(it => {
        if (it.type === 'cross-list') {
          const status = it.met ? `<span class="badge ok">Met</span>` : `<span class="badge warn">Missing</span>`;
          return `<div class="small" style="display:flex; gap:6px; align-items:center">
                    ${status}<span>${it.matched}</span>
                  </div>`;
        }
        const need = (it.type==='or')
          ? it.options.join(' OR ')
          : it.options[0];
        const status = it.met ? `<span class="badge ok">Met</span>` : `<span class="badge warn">Missing</span>`;
        const matched = it.matched ? ` — used ${it.matched}` : '';
        return `<div class="small" style="display:flex; gap:6px; align-items:center">
                  ${status}<span>${need}${matched}</span>
                </div>`;
      }).join('');
      return `<div style="margin:8px 0">
                <div class="small" style="color:var(--muted); font-weight:600">${sec.section}</div>
                ${rows}
              </div>`;
    }).join('');

    const detailsHtml = crossListHeader + secHtml;

    const geLabel = r.ignoreGE
      ? 'GE: ignored'
      : (!r.geRequired
          ? 'GE: not required'
          : `GE: ${Math.round(r.geScore.pct*100)}% ${r.geScore.label?`(${r.geScore.label})`:''}`);

    const card = document.createElement('div');
    card.className = 'prog';
    card.innerHTML = `
      <h3>${p.name}</h3>
      <div class="meta">
        <span class="badge">${p.program_type}</span>
        <span class="badge">${p.department||'—'}</span>
        <span class="badge">Catalog ${p.year_label}</span>
        ${ (p.detail?.program_goal)?`<span class="badge">${p.detail.program_goal}</span>`:''}
      </div>

      <div class="fit">
        <div class="progress" style="width:240px"><div style="width:${Math.round(r.total*100)}%"></div></div>
        <div class="score">${Math.round(r.total*100)}%</div>
      </div>

      <div class="meta" style="margin-top:6px">
        <span>Program req: ${Math.round(r.courseScore.pct*100)}% (items ${r.courseScore.satisfied}/${r.courseScore.requiredItems})</span>
        <span> • ${geLabel}</span>
        <span> • ${remainingLabel}: ${remainingVal}</span>
      </div>

      <details style="margin-top:10px">
        <summary class="small" style="color:var(--muted)">See requirement mapping (what counted / what's missing)</summary>
        ${detailsHtml || '<div class="small" style="color:var(--muted); margin-top:6px">No structured requirements found for this program.</div>'}
      </details>
    `;
    container.appendChild(card);
  }
}

// ======== Recalc Orchestration ========
function recalcAll() {
  const tr = computeTranscript();
  $('#gpa').textContent = (tr.gpa!=null)? tr.gpa.toFixed(3) : '—';
  $('#units-completed').textContent = tr.unitsCompleted.toFixed(1);
  $('#units-ip').textContent = tr.unitsIP.toFixed(1);
  $('#units-pl').textContent = tr.unitsPL.toFixed(1);

  const allow = rightsAvailable();
  renderRightsReadout(allow);

  renderGETabs();
  renderPrograms();
}

// ======== Filters ========
$('#prog-type-filter').addEventListener('change', renderPrograms);
$('#prog-dept-filter').addEventListener('input', () => { renderPrograms(); });
$('#prog-sort')?.addEventListener('change', renderPrograms);
$('#include-planned').addEventListener('change', renderPrograms);
$('#ignore-ge')?.addEventListener('change', renderPrograms);

// ======== Boot ========
loadData();
