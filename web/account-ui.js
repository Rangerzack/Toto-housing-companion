// ---------------------------------------------------------------------------
// Shared pieces for the account pages
// ---------------------------------------------------------------------------
// The form controls on the profile page are generated from the field
// definitions in profile.js, so a new question means adding one entry to
// SECTIONS rather than writing markup. This module is the renderer for that,
// plus the small helpers every account page needs.
//
// el() is deliberately a copy of the one in app.js rather than an import:
// app.js is the screener — importing it would boot the whole wizard (history
// listeners, session restore, a programs fetch) onto a page that has no
// wizard. Twelve lines of duplication is the cheaper mistake.

import { STATES } from './config.js?v=__BUILD__';

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of [].concat(children)) {
    if (!child) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/**
 * Shows a form-level message.
 *
 * Always textContent, never innerHTML: some of what lands here is a server
 * error string, and this app stores session tokens in localStorage, so an
 * injection here would be worth real money to someone. Nothing user- or
 * server-supplied is ever parsed as HTML anywhere in these pages.
 */
export function setMessage(node, text, kind = 'error') {
  if (!node) return;
  node.textContent = text || '';
  node.className = text ? `form-message form-message--${kind}` : 'form-message';
  // Errors are announced; success text is polite. role is set rather than
  // baked into the markup so one node can do both jobs.
  node.setAttribute('role', kind === 'error' ? 'alert' : 'status');
}

export function setFieldError(fieldEl, message) {
  if (!fieldEl) return;
  const input = fieldEl.querySelector('input, select');
  let error = fieldEl.querySelector('.field__error');
  fieldEl.classList.toggle('field--invalid', Boolean(message));
  if (message && !error) {
    error = el('span', { class: 'field__error' });
    fieldEl.append(error);
  }
  if (error) error.textContent = message || '';
  if (input) {
    input.setAttribute('aria-invalid', message ? 'true' : 'false');
    if (message && error) {
      if (!error.id) error.id = `${input.id || input.name}-error`;
      input.setAttribute('aria-describedby', error.id);
    }
  }
}

/** Puts a button into its working state and hands back a reset function. */
export function busy(button, label = 'Working…') {
  if (!button) return () => {};
  const original = button.textContent;
  button.disabled = true;
  button.textContent = label;
  return () => {
    button.disabled = false;
    button.textContent = original;
  };
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

/**
 * Fills the header's account strip.
 *
 * Every account page links back to the screener, because someone who lands
 * here by accident should never be stuck behind a sign-in wall on a tool that
 * does not require one.
 */
export function renderAccountNav(host, { user, onSignOut, base = '../' } = {}) {
  if (!host) return;
  host.replaceChildren();
  if (user) {
    host.append(
      el('a', { class: 'btn btn--ghost btn--sm', href: `${base}dashboard/`, text: 'Dashboard' }),
      el('button', {
        type: 'button',
        class: 'btn btn--ghost btn--sm',
        text: 'Log out',
        onclick: onSignOut,
      }),
    );
  } else {
    host.append(
      el('a', { class: 'btn btn--ghost btn--sm', href: `${base}login/`, text: 'Sign in' }),
    );
  }
}

// ---------------------------------------------------------------------------
// Field rendering
// ---------------------------------------------------------------------------
// One function per control type, all driven by the field definitions in
// profile.js. Each returns a node and writes straight into `values` on change,
// so the caller just reads `values` when the person hits Save.

const currency = new Intl.NumberFormat('en-US');

function labelFor(field) {
  return el('label', { class: 'field__label', for: `f-${field.name}` }, [field.label]);
}

function hintFor(field) {
  return field.hint ? el('span', { class: 'field__hint', text: field.hint }) : null;
}

function textField(field, values) {
  const input = el('input', {
    type: field.type === 'tel' ? 'tel' : 'text',
    id: `f-${field.name}`,
    name: field.name,
    autocomplete: field.autocomplete,
    value: values[field.name] ?? '',
    oninput: (e) => {
      values[field.name] = e.target.value.trim() === '' ? null : e.target.value;
    },
  });
  return el('div', { class: 'field field--wide' }, [labelFor(field), input, hintFor(field)]);
}

function selectField(field, values) {
  const select = el('select', {
    id: `f-${field.name}`,
    name: field.name,
    onchange: (e) => {
      values[field.name] = e.target.value || null;
    },
  });
  select.append(el('option', { value: '', text: 'Prefer not to say' }));
  for (const option of field.options) {
    const node = el('option', { value: option.value, text: option.label });
    if (values[field.name] === option.value) node.selected = true;
    select.append(node);
  }
  return el('div', { class: 'field' }, [labelFor(field), select, hintFor(field)]);
}

function counterField(field, values) {
  // The screener's stepper, markup for markup (styles.css:571), so a household
  // count looks and behaves the same in both places. The number input is the
  // real control: the buttons are a convenience, and typing still works.
  const min = field.min ?? 0;
  const max = field.max ?? 20;

  const input = el('input', {
    type: 'number',
    id: `f-${field.name}`,
    name: field.name,
    min: String(min),
    max: String(max),
    inputmode: 'numeric',
    'aria-label': field.label,
    value: values[field.name] == null ? '' : String(values[field.name]),
  });
  const unit = el('span', { class: 'stepper__unit' });

  const paint = () => {
    const value = values[field.name];
    input.value = value == null ? '' : String(value);
    if (value == null) unit.textContent = 'not set';
    else if (field.name === 'household_size') unit.textContent = value === 1 ? 'person' : 'people';
    else unit.textContent = value === 1 ? 'person' : 'people';
  };

  const commit = (next) => {
    if (next == null || Number.isNaN(next)) {
      values[field.name] = null;
    } else {
      values[field.name] = Math.min(max, Math.max(min, next));
    }
    paint();
  };

  input.addEventListener('input', (e) => {
    const raw = e.target.value.trim();
    // Left empty means "not answered", which is different from zero.
    values[field.name] = raw === '' ? null : Math.min(max, Math.max(min, Number(raw)));
    const value = values[field.name];
    unit.textContent = value == null ? 'not set' : value === 1 ? 'person' : 'people';
  });
  input.addEventListener('blur', () => paint());

  const step = (delta) => {
    const current = values[field.name];
    // First press starts at the minimum rather than jumping to 1 from nothing.
    commit(current == null ? min : current + delta);
  };

  paint();
  return el('div', { class: 'field' }, [
    labelFor(field),
    el('div', { class: 'stepper' }, [
      el('button', {
        type: 'button',
        class: 'stepper__btn',
        'aria-label': `Fewer: ${field.label}`,
        text: '−',
        onclick: () => step(-1),
      }),
      el('div', { class: 'stepper__value' }, [input, unit]),
      el('button', {
        type: 'button',
        class: 'stepper__btn',
        'aria-label': `More: ${field.label}`,
        text: '+',
        onclick: () => step(1),
      }),
    ]),
    hintFor(field),
  ]);
}

function checkboxField(field, values) {
  const input = el('input', {
    type: 'checkbox',
    id: `f-${field.name}`,
    name: field.name,
    onchange: (e) => {
      // null rather than false when unticked: the matcher reads null as
      // "not answered" and false as "answered no", and neither ever excludes,
      // but the difference matters for the completion display.
      values[field.name] = e.target.checked ? true : null;
    },
  });
  if (values[field.name]) input.checked = true;
  return el('div', { class: 'field field--wide' }, [
    el('label', { class: 'checkbox' }, [input, el('span', { text: field.label })]),
    hintFor(field),
  ]);
}

function moneyField(field, values) {
  const input = el('input', {
    type: 'text',
    inputmode: 'numeric',
    id: `f-${field.name}`,
    name: field.name,
    placeholder: '0',
    value: values[field.name] != null ? currency.format(Number(values[field.name])) : '',
    oninput: (e) => {
      const digits = e.target.value.replace(/[^\d]/g, '');
      e.target.value = digits ? currency.format(Number(digits)) : '';
      values[field.name] = digits ? Number(digits) : null;
    },
  });
  return el('div', { class: 'field' }, [
    labelFor(field),
    el('div', { class: 'money' }, [
      el('span', { class: 'money__symbol', 'aria-hidden': 'true', text: '$' }),
      input,
      field.suffix ? el('span', { class: 'money__suffix', text: field.suffix }) : null,
    ]),
    hintFor(field),
  ]);
}

/**
 * Income, with the same per-year / per-month toggle as the screener.
 * `annual_income` is always what gets stored; a monthly figure is multiplied
 * by twelve on the way in and divided on the way back out.
 */
function incomeField(field, values) {
  const suffix = el('span', { class: 'money__suffix' });
  const input = el('input', {
    type: 'text',
    inputmode: 'numeric',
    id: `f-${field.name}`,
    name: field.name,
    placeholder: '0',
  });

  const period = () => values.income_period || 'year';
  const paint = () => {
    const annual = values.annual_income;
    const shown = annual == null ? null : period() === 'month' ? Math.round(annual / 12) : annual;
    input.value = shown == null ? '' : currency.format(shown);
    suffix.textContent = period() === 'month' ? 'per month' : 'per year';
  };

  input.addEventListener('input', (e) => {
    const digits = e.target.value.replace(/[^\d]/g, '');
    e.target.value = digits ? currency.format(Number(digits)) : '';
    const entered = digits ? Number(digits) : null;
    values.annual_income = entered == null ? null : period() === 'month' ? entered * 12 : entered;
  });

  const toggle = el('div', { class: 'period-toggle', role: 'radiogroup', 'aria-label': 'How you want to enter income' });
  for (const option of [
    { value: 'year', label: 'Per year' },
    { value: 'month', label: 'Per month' },
  ]) {
    const radio = el('input', {
      type: 'radio',
      name: 'income-period',
      id: `income-period-${option.value}`,
      value: option.value,
      onchange: () => {
        values.income_period = option.value;
        paint();
      },
    });
    if (period() === option.value) radio.checked = true;
    toggle.append(
      el('label', { class: 'period-toggle__opt' }, [radio, el('span', { text: option.label })]),
    );
  }

  paint();
  return el('div', { class: 'field field--wide' }, [
    labelFor(field),
    hintFor(field),
    toggle,
    el('div', { class: 'money' }, [
      el('span', { class: 'money__symbol', 'aria-hidden': 'true', text: '$' }),
      input,
      suffix,
    ]),
  ]);
}

function multiField(field, values) {
  const group = el('div', { class: 'choices choices--compact', role: 'group', 'aria-labelledby': `f-${field.name}` });
  const chosen = new Set(values[field.name] || []);

  for (const option of field.options) {
    const input = el('input', {
      type: 'checkbox',
      value: option.value,
      onchange: (e) => {
        if (e.target.checked) chosen.add(option.value);
        else chosen.delete(option.value);
        values[field.name] = chosen.size ? [...chosen] : null;
      },
    });
    if (chosen.has(option.value)) input.checked = true;
    group.append(
      el('label', { class: 'choice choice--check' }, [
        input,
        el('span', { class: 'choice__body' }, [
          el('span', { class: 'choice__title', text: option.label }),
        ]),
      ]),
    );
  }

  return el('div', { class: 'field field--wide' }, [
    el('span', { class: 'field__label', id: `f-${field.name}`, text: field.label }),
    hintFor(field),
    group,
  ]);
}

/** The county multi-select, filtered by whichever state is chosen. */
function countiesField(field, values, { onStateChange } = {}) {
  const group = el('div', { class: 'choices choices--grid', role: 'group', 'aria-labelledby': `f-${field.name}` });

  const paint = () => {
    group.replaceChildren();
    const state = STATES.find((s) => s.code === values.state);
    if (!state) {
      group.append(
        el('p', { class: 'field__hint', text: 'Choose a state first and its counties will appear here.' }),
      );
      return;
    }
    const chosen = new Set(values[field.name] || []);
    for (const county of state.counties) {
      const input = el('input', {
        type: 'checkbox',
        value: county.name,
        onchange: (e) => {
          if (e.target.checked) chosen.add(county.name);
          else chosen.delete(county.name);
          values[field.name] = chosen.size ? [...chosen] : null;
        },
      });
      if (chosen.has(county.name)) input.checked = true;
      group.append(
        el('label', { class: 'choice choice--check' }, [
          input,
          el('span', { class: 'choice__body' }, [
            el('span', { class: 'choice__title', text: county.name }),
          ]),
        ]),
      );
    }
  };

  paint();
  if (onStateChange) onStateChange(paint);

  return el('div', { class: 'field field--wide' }, [
    el('span', { class: 'field__label', id: `f-${field.name}`, text: field.label }),
    hintFor(field),
    group,
  ]);
}

/** Free-text list (cities, ZIPs) entered comma-separated, shown as chips. */
function tagsField(field, values) {
  const list = el('div', { class: 'taglist' });

  const paint = () => {
    list.replaceChildren();
    for (const tag of values[field.name] || []) {
      list.append(
        el('span', { class: 'taglist__item' }, [
          el('span', { text: tag }),
          el('button', {
            type: 'button',
            class: 'taglist__remove',
            'aria-label': `Remove ${tag}`,
            text: '×',
            onclick: () => {
              const next = (values[field.name] || []).filter((t) => t !== tag);
              values[field.name] = next.length ? next : null;
              paint();
            },
          }),
        ]),
      );
    }
  };

  const add = (raw) => {
    const parts = String(raw)
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    if (!parts.length) return;
    const set = new Set([...(values[field.name] || []), ...parts]);
    // The column caps at 30 entries; stopping here beats a database error.
    values[field.name] = [...set].slice(0, 30);
    paint();
  };

  const input = el('input', {
    type: 'text',
    id: `f-${field.name}`,
    name: field.name,
    placeholder: 'Type and press Enter',
    onkeydown: (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      add(e.target.value);
      e.target.value = '';
    },
    onblur: (e) => {
      add(e.target.value);
      e.target.value = '';
    },
  });

  paint();
  return el('div', { class: 'field field--wide' }, [labelFor(field), input, hintFor(field), list]);
}

const RENDERERS = {
  text: textField,
  tel: textField,
  select: selectField,
  counter: counterField,
  checkbox: checkboxField,
  money: moneyField,
  income: incomeField,
  multi: multiField,
  counties: countiesField,
  tags: tagsField,
};

export function renderField(field, values, options) {
  const renderer = RENDERERS[field.type] || textField;
  return renderer(field, values, options);
}
