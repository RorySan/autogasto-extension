/* Receive a fill order from the Autogasto page, type it into the expense form in the
 * tab the user is signed into, and answer {ok}. No network, no storage: the only
 * inbound channel is onMessageExternal (restricted to the Autogasto origin by the
 * manifest), and the only thing sent back is a boolean. Fill mechanics live in
 * dom-inject.js; the posture and audit notes are in the README. */
import { domDrive, domProbe, domSaveProbe } from './dom-inject.js';

const SPA_ORIGIN = '__PORTAL_ORIGIN__'; // injected at build (see build.mjs)
const SPA_FORM_URL = `${SPA_ORIGIN}/tools/expensesSheet`;

// Timeouts. Polls are extension API calls, so the worker stays alive across them.
const SILENT_WAIT_MS = 20000;      // settle before surfacing the tab for sign-in
const LOGIN_WAIT_MS = 4 * 60 * 1000; // wait for the user to finish sign-in
const FORM_WAIT_MS = 20000;        // wait for the form to render
const SETTLE_MS = 1200;            // let the form settle before typing
const SAVE_WAIT_MS = 30000;        // wait for the form to unmount after Save

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Run state for the page's status poll — in memory only (no storage). `step` is progress
// text for the user, never anything read from the portal.
let running = false;
let step = '';

/* -------------------------------------------------------------------------- */
/* The portal tab                                                             */
/* -------------------------------------------------------------------------- */

/* True for the errors executeScript throws while the tab is mid-navigation or on an
 * origin we hold no permission for (e.g. the sign-in redirect). Means "not settled
 * yet", not a real failure. */
function isNavigationError(err) {
  const msg = String(err && err.message || err).toLowerCase();
  return ['frame was removed', 'frame with id', 'no frame with id', 'cannot access',
          'tab was discarded', 'navigation', 'target closed', 'message port closed',
          'no tab with id'].some((s) => msg.includes(s));
}

/** Run one of dom-inject.js's functions in the portal tab. Returns null when the page
 * isn't settled (mid-navigation / foreign origin). */
async function evalIn(tabId, func, args) {
  try {
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId }, world: 'MAIN', func, args: args || [],
    });
    return result;
  } catch (err) {
    if (isNavigationError(err)) return null;
    throw err;
  }
}

/** Reuse a portal tab the user already has open, else create one inactive. */
async function ensureTab() {
  const [existing] = await chrome.tabs.query({ url: `${SPA_ORIGIN}/*` });
  if (existing) return existing.id;
  const tab = await chrome.tabs.create({ url: SPA_FORM_URL, active: false });
  return tab.id;
}

async function goto(tabId, url) {
  await chrome.tabs.update(tabId, { url });
}

/** Surface the tab — for sign-in, and so the user watches the form fill. */
async function focusTab(tabId) {
  const tab = await chrome.tabs.update(tabId, { active: true });
  if (tab && tab.windowId !== undefined) {
    await chrome.windows.update(tab.windowId, { focused: true });
  }
}

/** Wait until the tab is settled on the SPA origin. If the session has expired the tab
 * leaves that origin; after a silent window, surface it for the user to sign in and
 * keep waiting — the fill resumes on its own. */
async function waitForSpaSession(tabId) {
  let deadline = Date.now() + SILENT_WAIT_MS;
  let foreign = 0;
  while (Date.now() < deadline) {
    const probe = await evalIn(tabId, domProbe, []);
    if (probe && probe.origin === SPA_ORIGIN) return;
    // Require two consecutive off-origin probes, so a brief blip can't surface the tab.
    foreign = probe === null ? foreign + 1 : 0;
    if (foreign >= 2) break;
    await sleep(2000);
  }
  await focusTab(tabId);
  step = 'Finish signing in to the expenses portal in the tab that just opened…';
  deadline = Date.now() + LOGIN_WAIT_MS;
  while (Date.now() < deadline) {
    const probe = await evalIn(tabId, domProbe, []);
    if (probe && probe.origin === SPA_ORIGIN) {
      step = 'Signed in — resuming…';
      return;
    }
    await sleep(2000);
  }
  throw new Error('sign-in not completed');
}

async function waitFormReady(tabId) {
  const deadline = Date.now() + FORM_WAIT_MS;
  while (Date.now() < deadline) {
    const probe = await evalIn(tabId, domProbe, []);
    if (probe && probe.formReady) return;
    await sleep(500);
  }
  throw new Error('form never rendered');
}

/* -------------------------------------------------------------------------- */
/* The fill                                                                   */
/* -------------------------------------------------------------------------- */

/** Success = the form unmounts after Save. Returns only a boolean. */
async function waitSaved(tabId) {
  const deadline = Date.now() + SAVE_WAIT_MS;
  while (Date.now() < deadline) {
    const probe = await evalIn(tabId, domSaveProbe, []);
    if (probe && !probe.formPresent) return { ok: true };
    await sleep(500);
  }
  return { ok: false }; // form stayed mounted — save not confirmed
}

/** Drive one order: {lines: [{type_text, subtype_text, date, iso, reason,
 * cost_typed}], comment?, receipts: [{name, mime, b64}]} → {ok}. */
async function runFill(order) {
  const lines = (order && order.lines) || [];
  if (!lines.length) return { ok: false };

  const tabId = await ensureTab();
  step = 'Waiting for your expenses session…';
  await goto(tabId, SPA_FORM_URL);
  await waitForSpaSession(tabId);
  await focusTab(tabId); // the user watches the form fill
  step = 'Filling your expense form — watch the tab…';
  await waitFormReady(tabId);
  await sleep(SETTLE_MS);

  for (let i = 0; i < lines.length; i++) {
    step = `Typing line ${i + 1} of ${lines.length}…`;
    const rep = (await evalIn(tabId, domDrive, ['line', { ...lines[i], first: i === 0 }])) || {};
    if (!rep.ok) return { ok: false };
  }
  if (order.comment) {
    const rep = (await evalIn(tabId, domDrive, ['comment', String(order.comment)])) || {};
    if (!rep.ok) return { ok: false };
  }
  const receipts = order.receipts || [];
  if (receipts.length) {
    step = 'Attaching receipts…';
    const files = receipts.map((r) => ({ name: r.name, type: r.mime, b64: r.b64 }));
    const rep = (await evalIn(tabId, domDrive, ['attach', { files }])) || {};
    if (!rep.ok) return { ok: false };
    await sleep(500);
  }
  const saved = (await evalIn(tabId, domDrive, ['save', null])) || {};
  if (!saved.ok) return { ok: false };
  step = 'Waiting for the portal to confirm…';
  return waitSaved(tabId);
}

/* -------------------------------------------------------------------------- */
/* The channel                                                                */
/* -------------------------------------------------------------------------- */

// Who may send is set by the manifest's externally_connectable, so no per-sender check.
chrome.runtime.onMessageExternal.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'status') {
    sendResponse({
      ok: true,
      version: chrome.runtime.getManifest().version,
      writeonly: true,
      running,
      step,
    });
    return false;
  }
  if (msg && msg.type === 'fill') {
    if (running) {
      sendResponse({ ok: false });
      return false;
    }
    running = true;
    step = 'Starting…';
    runFill(msg.order)
      .catch(() => ({ ok: false }))
      .then((result) => {
        running = false;
        step = '';
        sendResponse({ ok: !!(result && result.ok) });
      });
    return true; // async sendResponse
  }
  return false;
});
