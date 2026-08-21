import { SUPABASE_URL, SUPABASE_ANON_KEY, STATES } from '../config.js?v=__BUILD__';

// ---------------------------------------------------------------------------
// Data access
// ---------------------------------------------------------------------------

const headers = {
  apikey: SUPABASE_ANON_KEY,
  Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
};

async function get(path) {
  // PostgREST pages at 1000 rows; the income view for one county plus the
  // statewide and national tables can exceed that, so walk the range header.
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
// Tiny DOM helper (same shape as the screener's)
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

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let standards = new Map();   // standard_id -> row
let areas = new Map();       // area_id -> row
let programs = [];           // v_program_datasets rows

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function buildAreaPicker() {
  const select = $('#area');
  for (const state of STATES) {
    const group = el('optgroup', { label: state.name });
    for (const county of state.counties) {
      group.append(el('option', {
        value: county.areaId,
        text: county.name,
        'data-state': state.code,
        'data-statewide': state.statewideAreaId,
      }));
    }
    select.append(group);
  }
}

function selectedArea() {
  const opt = $('#area').selectedOptions[0];
  return {
    areaId: opt.value,
    county: opt.textContent,
    state: opt.dataset.state,
    statewideAreaId: opt.dataset.statewide,
  };
}

/**
 * Groups the flat rows into the shape of a grid: one per standard, rows per
 * tier, columns per household size. Where several effective dates are in
 * force the newest wins, which is also what the screener does.
 */
function shapeGrids(rows) {
  const byStandard = new Map();
  for (const r of rows) {
    const key = `${r.standard_id}|${r.area_id}`;
    if (!byStandard.has(key)) {
      byStandard.set(key, { standard: r.standard_id, area: r.area_id, tiers: new Map(), newest: '' });
    }
    const g = byStandard.get(key);
    const tier = Number(r.tier_pct);
    if (!g.tiers.has(tier)) g.tiers.set(tier, new Map());
    const sizes = g.tiers.get(tier);
    const existing = sizes.get(r.household_size);
    if (!existing || r.effective_date > existing.effective_date) {
      sizes.set(r.household_size, r);
    }
    if (r.effective_date > g.newest) g.newest = r.effective_date;
  }
  return [...byStandard.values()];
}

function renderGrid(g, programsUsing) {
  const std = standards.get(g.standard) || {};
  const area = areas.get(g.area) || {};
  const tiers = [...g.tiers.keys()].sort((a, b) => a - b);
  const sizes = [1, 2, 3, 4, 5, 6, 7, 8];

  const head = el('div', { class: 'grid__head' }, [
    el('h3', { class: 'grid__title', text: std.name || g.standard }),
    el('span', { class: 'grid__id', text: g.standard }),
    el('span', { class: 'grid__meta', text: `${area.name || g.area} · effective ${g.newest}` }),
    el('p', { class: 'grid__used' },
      programsUsing.length
        ? [el('strong', { text: `${programsUsing.length} program${programsUsing.length === 1 ? '' : 's'}` }),
           ` here use this: ${programsUsing.map((p) => p.program_name).join(' · ')}`]
        : 'No program in this county is routed to this dataset.'),
  ]);

  const table = el('table', {}, [
    el('thead', {}, el('tr', {}, [
      el('th', { text: 'Tier' }),
      ...sizes.map((s) => el('th', { text: `${s} person${s === 1 ? '' : 's'}` })),
    ])),
    el('tbody', {}, tiers.map((t) => {
      const row = g.tiers.get(t);
      return el('tr', {}, [
        el('td', { text: `${t}%` }),
        ...sizes.map((s) => {
          const cell = row.get(s);
          return cell
            ? el('td', { text: money(cell.amount) })
            : el('td', { class: 'empty', text: '—' });
        }),
      ]);
    })),
  ]);

  return el('section', { class: 'grid' }, [head, el('div', { class: 'scroll' }, table)]);
}

function renderRentGrid(g) {
  // Same shape, but columns are bedrooms and rows may be tiers OR kinds.
  const std = standards.get(g.standard) || {};
  const area = areas.get(g.area) || {};
  const bedrooms = [...new Set([...g.rows].map((r) => r.bedrooms))].sort((a, b) => a - b);
  const keys = [...new Set(g.rows.map((r) => r.key))].sort();

  const table = el('table', {}, [
    el('thead', {}, el('tr', {}, [
      el('th', { text: 'Tier / kind' }),
      ...bedrooms.map((b) => el('th', { text: b === 0 ? 'Studio' : `${b} bdrm` })),
    ])),
    el('tbody', {}, keys.map((k) => el('tr', {}, [
      el('td', { text: k }),
      ...bedrooms.map((b) => {
        const cell = g.rows.find((r) => r.key === k && r.bedrooms === b);
        return cell ? el('td', { text: money(cell.amount) }) : el('td', { class: 'empty', text: '—' });
      }),
    ]))),
  ]);

  return el('section', { class: 'grid' }, [
    el('div', { class: 'grid__head' }, [
      el('h3', { class: 'grid__title', text: `${std.name || g.standard} — rent` }),
      el('span', { class: 'grid__id', text: g.standard }),
      el('span', { class: 'grid__meta', text: `${area.name || g.area} · monthly · effective ${g.newest}` }),
    ]),
    el('div', { class: 'scroll' }, table),
  ]);
}

function shapeRentGrids(rows) {
  const byStandard = new Map();
  for (const r of rows) {
    const key = `${r.standard_id}|${r.area_id}`;
    if (!byStandard.has(key)) byStandard.set(key, { standard: r.standard_id, area: r.area_id, rows: [], newest: '' });
    const g = byStandard.get(key);
    const label = r.tier_pct != null ? `${Number(r.tier_pct)}%` : '';
    const kind = r.rent_kind === 'max_rent' ? '' : r.rent_kind.replace(/_/g, ' ');
    const rowKey = [label, kind].filter(Boolean).join(' · ') || 'max rent';
    const existing = g.rows.find((x) => x.key === rowKey && x.bedrooms === r.bedrooms);
    if (!existing || r.effective_date > existing.effective_date) {
      if (existing) g.rows.splice(g.rows.indexOf(existing), 1);
      g.rows.push({ key: rowKey, bedrooms: r.bedrooms, amount: r.amount, effective_date: r.effective_date });
    }
    if (r.effective_date > g.newest) g.newest = r.effective_date;
  }
  return [...byStandard.values()];
}

function renderPrograms(list) {
  const body = $('#programs tbody');
  body.replaceChildren();
  if (!list.length) {
    body.append(el('tr', {}, el('td', { colspan: 5, class: 'muted', text: 'No programs serve this county.' })));
    return;
  }
  for (const p of list) {
    const tested = p.income_test === 'income test applied';
    body.append(el('tr', {}, [
      el('td', {}, [p.program_name, el('small', { text: p.administrator || '' })]),
      el('td', {}, tested ? el('span', { class: 'grid__id', text: p.standard_id }) : el('span', { class: 'muted', text: '—' })),
      el('td', { class: 'num', text: tested ? `${Number(p.tier_max_pct)}%` : '' }),
      el('td', { class: tested ? '' : 'muted', text: tested ? 'Applied' : 'None — passes everyone on income' }),
      el('td', { class: 'muted', text: tested ? (p.published_when || '') : '' }),
    ]));
  }
}

// ---------------------------------------------------------------------------
// Load + wire
// ---------------------------------------------------------------------------

let lastRows = [];

async function refresh() {
  const { areaId, county, state, statewideAreaId } = selectedArea();
  const asOf = $('#asof').value || new Date().toISOString().slice(0, 10);
  $('#meta').textContent = 'Loading…';

  const areaFilter = `or=(area_id.eq.${areaId},area_id.eq.${statewideAreaId},area_id.eq.US-48)`;
  const dateFilter = `effective_date=lte.${asOf}&or=(expires_date.is.null,expires_date.gt.${asOf})`;

  const [income, rent] = await Promise.all([
    get(`v_income_limits_by_size?select=standard_id,area_id,tier_pct,household_size,amount,effective_date&${areaFilter}&${dateFilter}&order=standard_id,tier_pct,household_size`),
    $('#show-rent').checked
      ? get(`rent_limits?select=standard_id,area_id,tier_pct,rent_kind,bedrooms,amount,effective_date&${areaFilter}&${dateFilter}&order=standard_id,tier_pct,bedrooms`)
      : Promise.resolve([]),
  ]);
  lastRows = income;

  const inCounty = programs.filter((p) =>
    p.state_code === state &&
    (p.counties || '').split(';').map((c) => c.trim()).some((c) => c === county || c === 'Statewide'),
  );

  const grids = $('#grids');
  grids.replaceChildren();

  // County-specific standards first, then statewide, then national — the
  // order someone would expect reading down.
  const rank = (g) => (g.area === areaId ? 0 : g.area === statewideAreaId ? 1 : 2);
  const shaped = shapeGrids(income).sort((a, b) => rank(a) - rank(b) || a.standard.localeCompare(b.standard));
  for (const g of shaped) {
    grids.append(renderGrid(g, inCounty.filter((p) => p.standard_id === g.standard && p.income_test === 'income test applied')));
  }
  for (const g of shapeRentGrids(rent).sort((a, b) => rank(a) - rank(b))) {
    grids.append(renderRentGrid(g));
  }

  renderPrograms(inCounty.sort((a, b) => (a.standard_id || '~').localeCompare(b.standard_id || '~') || a.program_name.localeCompare(b.program_name)));

  const stdCount = new Set(income.map((r) => r.standard_id)).size;
  $('#meta').textContent = `${county} County, ${state} · ${stdCount} datasets · ${income.length.toLocaleString()} figures · as of ${asOf}`;
}

function downloadCsv() {
  const { county, state } = selectedArea();
  const cols = ['standard_id', 'area_id', 'tier_pct', 'household_size', 'amount', 'effective_date'];
  const lines = [cols.join(',')].concat(lastRows.map((r) => cols.map((c) => r[c] ?? '').join(',')));
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const a = el('a', { href: URL.createObjectURL(blob), download: `income-limits-${state}-${county}.csv` });
  document.body.append(a); a.click(); a.remove();
}

async function init() {
  buildAreaPicker();
  $('#asof').value = new Date().toISOString().slice(0, 10);

  try {
    const [stds, ars, progs] = await Promise.all([
      get('income_standards?select=*'),
      get('income_areas?select=*'),
      get('v_program_datasets?select=state_code,program_id,program_name,administrator,standard_id,tier_max_pct,income_test,counties,published_when,is_active&is_active=eq.true'),
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
  $('#download').addEventListener('click', downloadCsv);

  // Deep link: /data/?county=OR-JOSEPHINE
  const wanted = new URLSearchParams(location.search).get('county');
  if (wanted && [...$('#area').options].some((o) => o.value === wanted)) $('#area').value = wanted;

  await refresh();
}

init();
