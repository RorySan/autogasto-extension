# Autogasto browser helper

A browser extension that types your Autogasto expense claims into the expense form, in the tab you are already signed into, and saves them as drafts. It consists of
just two simple scripts and a manifest.

## Files

- `manifest.json` — declares one host permission (the expenses-portal origin) and
  the `scripting` permission. No storage, no tabs, no access to any other site. The
  `externally_connectable` entry is the only way in: it lets the Autogasto page send it a
  fill request. The `key` fixes the extension's ID so the page knows which extension to
  talk to.
- `background.js` — receives a fill request from the Autogasto page, opens/focuses the
  portal tab, waits for your session, and runs the fill. Replies with a single `{ok}`.
- `dom-inject.js` — the form-filling steps that run in the page: select the expense type,
  type each line's date/amount/reason, attach receipts, click Save Draft.

## What it does

- Fills the expense form with values the Autogasto page hands it, and attaches the receipt
  files the page provides.
- Runs in your own signed-in session; the tab is brought to the front so you watch it fill.
- Reports back one boolean: whether the draft saved.

## What it does not do

- No network of its own. It has no permission to reach any server — not the portal's, not
  Autogasto's — and contains no code that makes a request. The only thing it sends is the
  `{ok}` reply, over local browser messaging.
- No stored data and no credentials. It has no storage permission and keeps nothing
  between runs.
- Reads nothing out of the portal. Filling a form needs to see the form — find the option
  to click, check a value was accepted — but nothing is collected or returned. The reply
  is a boolean; there is no channel that could carry your expense history, other people's
  data, or anything else out.

When a fill can't complete — the app sent a value the form no longer offers, or the
session expired — it stops and returns `false`.

## Build

The one host the extension is allowed to touch is written as a `__PORTAL_ORIGIN__`
placeholder in `manifest.json` and `background.js`. Provide the expense form's origin and
build the loadable extension into `build/`:

```
PORTAL_ORIGIN=https://your-expense-portal.example node build.mjs
# or put that origin in a file named portal-origin.local, then: node build.mjs
```

Load `build/` as an unpacked extension, or zip it for the store. `build/` and
`portal-origin.local` are not tracked.
