/* In-page form-fill helpers, injected per call into the expense-sheet tab.
 * Each function is self-contained: executeScript serializes it alone, so no imports or
 * shared scope survive — that's why domDrive carries all its helpers inline.
 * Every result is a plain {ok} boolean; nothing is read back out of the page. */

/** Is the tab on the SPA origin, and is the expense form rendered? */
export function domProbe() {
  return {
    origin: location.origin,
    formReady: !!document.querySelector('input[formcontrolname="Date"]'),
  };
}

/** Is the expense form still mounted? (a save unmounts it — see the worker.) */
export function domSaveProbe() {
  return {
    formPresent: !!document.querySelector('input[formcontrolname="Date"]'),
  };
}

/** Fill the expense form. op ∈ 'line' | 'comment' | 'attach' | 'save'.
 * Returns {ok: true|false}; never throws across the executeScript boundary. */
export async function domDrive(op, arg) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // -- input helpers -------------------------------------------------------------------
  const nativeSet = (el, text) => {
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, text);
  };
  const fireInput = (el, data) => el.dispatchEvent(new InputEvent('input',
    { bubbles: true, data: data ?? null, inputType: 'insertText' }));
  const focusEl = (el) => {
    el.focus();
    el.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
  };
  const clearField = (el) => {
    focusEl(el);
    el.select?.();
    if (!document.execCommand('delete')) { nativeSet(el, ''); fireInput(el, null); }
  };
  /* Keyboard event with keyCode/which populated (the constructor leaves them 0). */
  const KEYCODE = { ArrowDown: 40, ArrowUp: 38, Enter: 13, Escape: 27, Tab: 9 };
  const kbEvent = (type, key) => {
    const e = new KeyboardEvent(type, { key, bubbles: true, cancelable: true });
    const code = KEYCODE[key] ?? key.toUpperCase().charCodeAt(0);
    Object.defineProperty(e, 'keyCode', { get: () => code });
    Object.defineProperty(e, 'which', { get: () => code });
    return e;
  };
  const pressKey = (el, key) => {
    el.dispatchEvent(kbEvent('keydown', key));
    el.dispatchEvent(kbEvent('keyup', key));
  };
  /* Type one character; insert only if the keypress wasn't default-prevented. */
  const keystroke = (el, ch) => {
    el.dispatchEvent(kbEvent('keydown', ch));
    const notPrevented = el.dispatchEvent(kbEvent('keypress', ch));
    if (notPrevented && !document.execCommand('insertText', false, ch)) {
      nativeSet(el, el.value + ch);
      fireInput(el, ch);
    }
    el.dispatchEvent(kbEvent('keyup', ch));
  };
  const typeInto = async (el, text, delay = 40) => {
    focusEl(el);
    for (const ch of String(text)) { keystroke(el, ch); await sleep(delay); }
  };
  const setValue = (el, text) => { focusEl(el); nativeSet(el, text); fireInput(el); };
  const blurEl = (el) => {
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new FocusEvent('blur'));
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    el.blur();
  };
  const clickEl = (el) => {
    for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
    }
  };

  // -- locators ------------------------------------------------------------------------
  const FIELD = {
    date: 'input[formcontrolname="Date"]',
    reason: 'input[formcontrolname="Reason"]',
    amount: 'input[formcontrolname="Cost"]',
    iso: 'input[formcontrolname="ISONumber"]',
    comment: 'textarea[formcontrolname="Comment"]',
    file: '#fileDropRef',
  };
  const q = (key) => document.querySelector(FIELD[key]);
  const byLabel = (text) => {
    const t = text.toLowerCase();
    for (const ff of document.querySelectorAll('mat-form-field')) {
      const label = (ff.querySelector('mat-label')?.textContent || '').trim().toLowerCase();
      if (label.includes(t)) return ff.querySelector('input, textarea');
    }
    return [...document.querySelectorAll('input[aria-label], input[placeholder]')]
      .find((i) => (i.getAttribute('aria-label') || i.placeholder || '').toLowerCase().includes(t)) || null;
  };
  const findOption = (text) => [...document.querySelectorAll('[role="option"]')]
    .find((o) => o.textContent.trim() === text) || null;
  const findButton = (name) => [...document.querySelectorAll('button')]
    .find((b) => b.textContent.trim().toLowerCase() === name.toLowerCase()) || null;
  const rowCount = () => document.querySelectorAll('mat-table mat-row').length;
  const ngInvalid = (el) => el.classList.contains('ng-invalid');

  /* Select an option by arrowing to it, then Enter. */
  const arrowSelect = async (field, value, maxSteps = 60) => {
    for (let i = 0; i < maxSteps; i++) {
      field.dispatchEvent(kbEvent('keydown', 'ArrowDown'));
      await sleep(120);
      const id = field.getAttribute('aria-activedescendant');
      const active = id && document.getElementById(id);
      if (active && active.textContent.trim() === value) {
        field.dispatchEvent(kbEvent('keydown', 'Enter'));
        await sleep(400);
        return true;
      }
    }
    pressKey(field, 'Escape');
    return false;
  };

  /* Select a dropdown option: open the list and click the exact match (typing is not
   * used — it clears the list). Exact match on purpose. Returns {ok}. */
  const autocomplete = async (label, value) => {
    const el = byLabel(label);
    if (!el) return { ok: false };
    focusEl(el);
    clickEl(el);
    let opt = null;
    for (let waited = 0; waited <= 8000 && !opt; waited += 250) {
      await sleep(250);
      opt = findOption(value);
      if (waited === 2000 && !document.querySelector('[role="option"]')) {
        el.dispatchEvent(kbEvent('keydown', 'ArrowDown')); // nudge the panel open
      }
    }
    if (!opt) { pressKey(el, 'Escape'); return { ok: false }; }
    clickEl(opt);
    await sleep(500);
    if (el.value === value) return { ok: true };
    // click didn't register — reopen and select by arrowing instead
    focusEl(el);
    clickEl(el);
    await sleep(500);
    if ((await arrowSelect(el, value)) && el.value === value) return { ok: true };
    return { ok: false };
  };

  // -- ops ----------------------------------------------------------------------------
  if (op === 'line') {
    const ln = arg || {};
    if (ln.first) {
      if (!(await autocomplete('Expense type', ln.type_text)).ok) return { ok: false };
      await sleep(600); // let the subtype options load
    }
    const date = q('date');
    if (!date) return { ok: false };
    clearField(date);
    setValue(date, ln.date);
    blurEl(date);
    await sleep(300);
    if (ngInvalid(date)) return { ok: false }; // invalid date
    if (ln.subtype_text) {
      if (!(await autocomplete('Subtype', ln.subtype_text)).ok) return { ok: false };
    }
    if (ln.iso) {
      const iso = q('iso');
      if (!iso) return { ok: false };
      clearField(iso);
      setValue(iso, ln.iso);
      blurEl(iso);
    }
    const reason = q('reason');
    if (!reason) return { ok: false };
    clearField(reason);
    setValue(reason, ln.reason || '');
    blurEl(reason);
    const amt = q('amount');
    if (!amt) return { ok: false };
    clearField(amt);
    await typeInto(amt, ln.cost_typed);
    blurEl(amt);
    await sleep(300);
    if (ngInvalid(amt)) return { ok: false }; // invalid amount
    const btn = findButton('Add Expense');
    if (!btn || btn.disabled) return { ok: false };
    const before = rowCount();
    clickEl(btn);
    await sleep(800);
    if (rowCount() <= before) return { ok: false }; // row wasn't added
    return { ok: true };
  }

  if (op === 'comment') {
    const el = q('comment');
    if (!el) return { ok: false };
    clearField(el);
    setValue(el, String(arg ?? ''));
    blurEl(el);
    return { ok: true };
  }

  if (op === 'attach') {
    const input = q('file');
    if (!input) return { ok: false };
    const dt = new DataTransfer();
    for (const f of (arg && arg.files) || []) {
      const bin = Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0));
      dt.items.add(new File([bin], f.name, { type: f.type || 'application/octet-stream' }));
    }
    input.files = dt.files;
    fireInput(input);
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true };
  }

  if (op === 'save') {
    const btn = findButton('Save Draft');
    if (!btn || btn.disabled) return { ok: false };
    clickEl(btn);
    return { ok: true };
  }

  return { ok: false };
}
