import { SUPABASE_URL, SUPABASE_ANON_KEY, STATES } from '../config.js?v=__BUILD__';

// ---------------------------------------------------------------------------
// Data access
// ---------------------------------------------------------------------------

const headers = {
  apikey: SUPABASE_ANON_KEY,
  Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
};

async function get(path) {
  // PostgREST pages at 1000 rows; walk the range header until a short page.
  const out = [];
  for (let from = 0; ; from += 1000) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      headers: { ...headers, Range: `${from}-${from + 999}` },
    });
    if (!res.ok && res.status !== 206) throw new Error(`${path.split('?')[0]}: ${res.status}`);
    const rows = await res.json();
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}

// ---------------------------------------------------------------------------
// DOM helper
// ---------------------------------------------------------------------------

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of [].concat(children)) {
    if (child == null || child === false) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

const $ = (sel) => document.querySelector(sel);
const money = (n) => `$${Math.round(n).toLocaleString('en-US')}`;
const SIZES = [1, 2, 3, 4, 5, 6, 7, 8];

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let standards = new Map();
let areas = new Map();
let programs = [];
let lastIncome = [];
let lastShaped = [];

function selectedArea() {
  const opt = $('#area').selectedOptions[0];
  return {
    areaId: opt.value,
    county: opt.textContent,
    state: opt.dataset.state,
    statewideAreaId: opt.dataset.statewide,
  };
}

function programsInCounty() {
  const { county, state } = selectedArea();
  return programs.filter((p) =>
    p.state_code === state &&
    (p.counties || '').split(';').map((c) => c.trim()).some((c) => c === county || c === 'Statewide'),
  );
}

// ---------------------------------------------------------------------------
// Shaping
// ---------------------------------------------------------------------------

/** standard+area -> { tiers: Map<tier, Map<size, row>>, newest } — newest date wins. */
function shapeGrids(rows) {
  const by = new Map();
  for (const r of rows) {
    const key = `${r.standard_id}|${r.area_id}`;
    if (!by.has(key)) by.set(key, { standard: r.standard_id, area: r.area_id, tiers: new Map(), newest: '' });
    const g = by.get(key);
    const tier = Number(r.tier_pct);
    if (!g.tiers.has(tier)) g.tiers.set(tier, new Map());
    const sizes = g.tiers.get(tier);
    const cur = sizes.get(r.household_size);
    if (!cur || r.effective_date > cur.effective_date) sizes.set(r.household_size, r);
    if (r.effective_date > g.newest) g.newest = r.effective_date;
  }
  return [...by.values()];
}

function shapeRent(rows) {
  const by = new Map();
  for (const r of rows) {
    const key = `${r.standard_id}|${r.area_id}`;
    if (!by.has(key)) by.set(key, { standard: r.standard_id, area: r.area_id, rows: [], newest: '' });
    const g = by.get(key);
    const label = r.tier_pct != null ? `${Number(r.tier_pct)}%` : '';
    const kind = r.rent_kind === 'max_rent' ? '' : r.rent_kind.replace(/_/g, ' ');
    const rowKey = [label, kind].filter(Boolean).join(' · ') || 'max rent';
    const i = g.rows.findIndex((x) => x.key === rowKey && x.bedrooms === r.bedrooms);
    if (i < 0 || r.effective_date > g.rows[i].effective_date) {
      if (i >= 0) g.rows.splice(i, 1);
      g.rows.push({ key: rowKey, bedrooms: r.bedrooms, amount: r.amount, effective_date: r.effective_date });
    }
    if (r.effective_date > g.newest) g.newest = r.effective_date;
  }
  return [...by.values()];
}

function scopeOf(areaId) {
  const { areaId: county, statewideAreaId } = selectedArea();
  if (areaId === county) return 'county';
  if (areaId === statewideAreaId) return 'statewide';
  return 'national';
}
const SCOPE_RANK = { county: 0, statewide: 1, national: 2 };

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function buildAreaPicker() {
  const select = $('#area');
  for (const state of STATES) {
    const group = el('optgroup', { label: state.name });
    for (const c of state.counties) {
      group.append(el('option', { value: c.areaId, text: c.name, 'data-state': state.code, 'data-statewide': state.statewideAreaId }));
    }
    select.append(group);
  }
}

function renderTiles(shaped, inCounty) {
  const tested = inCounty.filter((p) => p.income_test === 'income test applied');
  const newest = shaped.reduce((m, g) => (g.newest > m ? g.newest : m), '');
  const figures = lastIncome.length;
  const tiles = [
    ['Datasets held', shaped.length, 'for this county, state, and nation'],
    ['Published figures', figures.toLocaleString(), 'across all tiers and sizes'],
    ['Programs here', inCounty.length, `${inCounty.length - tested.length} with no income test`],
    ['Income-tested', tested.length, 'programs with a published limit'],
    ['Newest effective', newest, 'most recent publication in force', true],
  ];
  $('#tiles').replaceChildren(...tiles.map(([label, value, note, small]) =>
    el('article', { class: 'tile' }, [
      el('p', { class: 'tile__label', text: label }),
      el('p', { class: `tile__value${small ? ' tile__value--small' : ''}`, text: String(value) }),
      el('p', { class: 'tile__note', text: note }),
    ])));
}

function renderRail(shaped, inCounty) {
  const rail = $('#rail');
  rail.replaceChildren();
  let lastScope = null;
  for (const g of shaped) {
    const scope = scopeOf(g.area);
    if (scope !== lastScope) {
      rail.append(el('li', { class: 'rail__group', text: scope === 'county' ? selectedArea().county + ' County' : scope }));
      lastScope = scope;
    }
    const std = standards.get(g.standard) || {};
    const users = inCounty.filter((p) => p.standard_id === g.standard && p.income_test === 'income test applied').length;
    const figures = [...g.tiers.values()].reduce((n, m) => n + m.size, 0);
    rail.append(el('li', {}, el('a', { class: 'rail__item', href: `#ds-${g.standard}` }, [
      el('span', { class: 'rail__name', text: std.name || g.standard }),
      el('span', { class: 'rail__id', text: g.standard }),
      el('span', { class: 'rail__count' }, [el('strong', { text: `${users} prog` }), `${figures} fig`]),
    ])));
  }
}

function buildTierPicker(shaped) {
  const select = $('#tier');
  const prev = select.value;
  const tiers = [...new Set(shaped.flatMap((g) => [...g.tiers.keys()]))].sort((a, b) => a - b);
  select.replaceChildren(...tiers.map((t) => {
    const n = shaped.filter((g) => g.tiers.has(t)).length;
    return el('option', { value: t, text: `${t}%  ·  ${n} dataset${n === 1 ? '' : 's'}` });
  }));
  // 50% is the tier most datasets share; keep the user's pick if it still exists.
  select.value = tiers.includes(Number(prev)) ? prev : (tiers.includes(50) ? '50' : String(tiers[0]));
}

function renderCompare(shaped, inCounty) {
  const tier = Number($('#tier').value);
  const table = $('#compare-table');
  table.querySelector('thead').replaceChildren(el('tr', {}, [
    el('th', { text: 'Dataset' }),
    ...SIZES.map((s) => el('th', { text: `${s}` + (s === 1 ? ' person' : ' people') })),
    el('th', { text: 'Used by' }),
  ]));
  const body = table.querySelector('tbody');
  body.replaceChildren();

  for (const g of shaped) {
    const row = g.tiers.get(tier);
    const std = standards.get(g.standard) || {};
    const users = inCounty.filter((p) => p.standard_id === g.standard && p.income_test === 'income test applied');
    const scope = scopeOf(g.area);
    body.append(el('tr', { class: scope === 'county' ? 'is-county' : '' }, [
      el('td', {}, el('div', { class: 'ds' }, [
        el('span', { class: 'ds__name' }, [std.name || g.standard, scope !== 'county' && el('span', { class: 'scope', text: scope })]),
        el('span', { class: 'ds__meta', text: `${g.standard} · eff. ${g.newest}` }),
      ])),
      ...SIZES.map((s) => {
        const cell = row?.get(s);
        return cell ? el('td', { text: money(cell.amount) }) : el('td', { class: 'empty', text: '—' });
      }),
      el('td', { class: users.length ? '' : 'muted', text: users.length ? `${users.length}` : '0' }),
    ]));
  }
}

function renderPrograms(inCounty, shaped) {
  const body = $('#programs tbody');
  body.replaceChildren();
  const tested = inCounty.filter((p) => p.income_test === 'income test applied');
  $('#programs-sub').textContent = `${inCounty.length} programs · ${tested.length} apply an income limit · 4-person household shown`;
  $('#programs-limit-head').textContent = 'Limit (4 people)';

  if (!inCounty.length) {
    body.append(el('tr', {}, el('td', { colspan: 5, class: 'muted', text: 'No programs serve this county.' })));
    return;
  }
  const sorted = [...inCounty].sort((a, b) =>
    (a.income_test === 'income test applied' ? 0 : 1) - (b.income_test === 'income test applied' ? 0 : 1) ||
    (a.standard_id || '~').localeCompare(b.standard_id || '~') || a.program_name.localeCompare(b.program_name));

  for (const p of sorted) {
    const isTested = p.income_test === 'income test applied';
    let limit = null;
    if (isTested) {
      const g = shaped.find((x) => x.standard === p.standard_id && (x.area === p.area || p.area === 'applicant county'));
      limit = g?.tiers.get(Number(p.tier_max_pct))?.get(4)?.amount ?? null;
    }
    body.append(el('tr', {}, [
      el('td', {}, [p.program_name, el('small', { text: p.administrator || '' })]),
      el('td', {}, isTested ? el('span', { class: 'tag', text: p.standard_id }) : el('span', { class: 'muted', text: 'none' })),
      el('td', { class: 'num', text: isTested ? `${Number(p.tier_max_pct)}%` : '' }),
      el('td', { class: `num${limit == null ? ' muted' : ''}`, text: limit != null ? money(limit) : (isTested ? 'not published' : 'passes everyone') }),
      el('td', { class: 'muted', text: isTested ? (p.published_when || '').split(',')[0] : '' }),
    ]));
  }
}

function renderGrid(g, inCounty) {
  const std = standards.get(g.standard) || {};
  const area = areas.get(g.area) || {};
  const tiers = [...g.tiers.keys()].sort((a, b) => a - b);
  const users = inCounty.filter((p) => p.standard_id === g.standard && p.income_test === 'income test applied');

  return el('details', { class: 'grid', id: `ds-${g.standard}` }, [
    el('summary', {}, [
      el('h3', { class: 'grid__title', text: std.name || g.standard }),
      el('span', { class: 'tag', text: g.standard }),
      el('span', { class: 'grid__meta', text: `${area.name || g.area} · ${tiers.length} tier${tiers.length === 1 ? '' : 's'} · eff. ${g.newest}` }),
      el('p', { class: 'grid__used' }, users.length
        ? [el('strong', { text: `${users.length} program${users.length === 1 ? '' : 's'}` }), ': ' + users.map((p) => p.program_name).join(' · ')]
        : 'No program in this county is routed to this dataset.'),
    ]),
    el('div', { class: 'scroll' }, el('table', {}, [
      el('thead', {}, el('tr', {}, [el('th', { text: 'Tier' }), ...SIZES.map((s) => el('th', { text: `${s}p` }))])),
      el('tbody', {}, tiers.map((t) => el('tr', {}, [
        el('td', { text: `${t}%` }),
        ...SIZES.map((s) => { const c = g.tiers.get(t).get(s); return c ? el('td', { text: money(c.amount) }) : el('td', { class: 'empty', text: '—' }); }),
      ]))),
    ])),
  ]);
}

function renderRentGrid(g) {
  const std = standards.get(g.standard) || {};
  const area = areas.get(g.area) || {};
  const bedrooms = [...new Set(g.rows.map((r) => r.bedrooms))].sort((a, b) => a - b);
  const keys = [...new Set(g.rows.map((r) => r.key))].sort();
  return el('details', { class: 'grid grid--rent' }, [
    el('summary', {}, [
      el('h3', { class: 'grid__title', text: `${std.name || g.standard} — rent` }),
      el('span', { class: 'tag', text: g.standard }),
      el('span', { class: 'grid__meta', text: `${area.name || g.area} · monthly · eff. ${g.newest}` }),
    ]),
    el('div', { class: 'scroll' }, el('table', {}, [
      el('thead', {}, el('tr', {}, [el('th', { text: 'Tier / kind' }), ...bedrooms.map((b) => el('th', { text: b === 0 ? 'Studio' : `${b} bd` }))])),
      el('tbody', {}, keys.map((k) => el('tr', {}, [
        el('td', { text: k }),
        ...bedrooms.map((b) => { const c = g.rows.find((r) => r.key === k && r.bedrooms === b); return c ? el('td', { text: money(c.amount) }) : el('td', { class: 'empty', text: '—' }); }),
      ]))),
    ])),
  ]);
}

// ---------------------------------------------------------------------------
// Load + wire
// ---------------------------------------------------------------------------

async function refresh() {
  const { areaId, county, state, statewideAreaId } = selectedArea();
  const asOf = $('#asof').value || new Date().toISOString().slice(0, 10);
  $('#meta').textContent = 'Loading…';

  const areaFilter = `or=(area_id.eq.${areaId},area_id.eq.${statewideAreaId},area_id.eq.US-48)`;
  const dateFilter = `effective_date=lte.${asOf}&or=(expires_date.is.null,expires_date.gt.${asOf})`;
  const [income, rent] = await Promise.all([
    get(`v_income_limits_by_size?select=standard_id,area_id,tier_pct,household_size,amount,effective_date&${areaFilter}&${dateFilter}`),
    $('#show-rent').checked
      ? get(`rent_limits?select=standard_id,area_id,tier_pct,rent_kind,bedrooms,amount,effective_date&${areaFilter}&${dateFilter}`)
      : Promise.resolve([]),
  ]);
  lastIncome = income;

  const inCounty = programsInCounty();
  const shaped = shapeGrids(income).sort((a, b) =>
    SCOPE_RANK[scopeOf(a.area)] - SCOPE_RANK[scopeOf(b.area)] || a.standard.localeCompare(b.standard));
  lastShaped = shaped;

  renderTiles(shaped, inCounty);
  renderRail(shaped, inCounty);
  buildTierPicker(shaped);
  renderCompare(shaped, inCounty);
  renderPrograms(inCounty, shaped);

  const grids = $('#grids');
  grids.replaceChildren();
  const rentShaped = shapeRent(rent);
  for (const g of shaped) {
    grids.append(renderGrid(g, inCounty));
    const r = rentShaped.find((x) => x.standard === g.standard && x.area === g.area);
    if (r) grids.append(renderRentGrid(r));
  }

  $('#meta').textContent = `${county} County, ${state} · as of ${asOf}`;
}

function downloadCsv() {
  const { county, state } = selectedArea();
  const cols = ['standard_id', 'area_id', 'tier_pct', 'household_size', 'amount', 'effective_date'];
  const lines = [cols.join(',')].concat(lastIncome.map((r) => cols.map((c) => r[c] ?? '').join(',')));
  const a = el('a', { href: URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' })), download: `income-limits-${state}-${county}.csv` });
  document.body.append(a); a.click(); a.remove();
}

function wireRail() {
  // Opening a collapsed grid from the rail, and marking which is in view.
  $('#rail').addEventListener('click', (e) => {
    const a = e.target.closest('a.rail__item'); if (!a) return;
    const target = document.querySelector(a.getAttribute('href'));
    if (target) target.open = true;
  });
  if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      for (const en of entries) {
        if (!en.isIntersecting) continue;
        document.querySelectorAll('.rail__item').forEach((i) => i.classList.toggle('is-active', i.getAttribute('href') === `#${en.target.id}`));
      }
    }, { rootMargin: '-40% 0px -55% 0px' });
    new MutationObserver(() => document.querySelectorAll('.grid[id]').forEach((g) => io.observe(g))).observe($('#grids'), { childList: true });
  }
}

async function init() {
  buildAreaPicker();
  $('#asof').value = new Date().toISOString().slice(0, 10);
  try {
    const [stds, ars, progs] = await Promise.all([
      get('income_standards?select=*'),
      get('income_areas?select=*'),
      get('v_program_datasets?select=state_code,program_id,program_name,administrator,standard_id,tier_max_pct,area,income_test,counties,published_when,is_active&is_active=eq.true'),
    ]);
    standards = new Map(stds.map((s) => [s.standard_id, s]));
    areas = new Map(ars.map((a) => [a.area_id, a]));
    programs = progs;
  } catch (error) {
    $('#meta').textContent = `Couldn't reach the database: ${error.message}`;
    return;
  }

  $('#area').addEventListener('change', refresh);
  $('#asof').addEventListener('change', refresh);
  $('#show-rent').addEventListener('change', refresh);
  $('#tier').addEventListener('change', () => renderCompare(lastShaped, programsInCounty()));
  $('#download').addEventListener('click', downloadCsv);
  $('#expand-all').addEventListener('click', (e) => {
    const grids = [...document.querySelectorAll('.grid')];
    const open = !grids.every((g) => g.open);
    grids.forEach((g) => { g.open = open; });
    e.target.textContent = open ? 'Collapse all' : 'Expand all';
  });
  wireRail();

  const wanted = new URLSearchParams(location.search).get('county');
  if (wanted && [...$('#area').options].some((o) => o.value === wanted)) $('#area').value = wanted;
  await refresh();
}

init();
