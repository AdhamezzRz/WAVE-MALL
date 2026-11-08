# Import from Excel: writing a dataset

Everything people keep in Excel comes into the office through **datasets**. A dataset describes one
kind of record (brands, employees, leases…); the engine (`engine.js`) gives it, with no more code:

- a live `.xlsx` template in English or Arabic: one styled title row (required columns in dark green
  with `*`), a note on every title (help, allowed values, example), Excel data validation on every
  column (dropdowns for choices **and** for references to other records, read from the database;
  dates, whole numbers, decimals, lengths), an Example sheet, a Read me sheet (both languages, the
  go-live order, the field dictionary) and a Lists sheet; optionally pre-filled with the current
  records (`export`), so people can edit in Excel and import back;
- reading `.xlsx` and `.csv` (UTF-8 with or without BOM, `,` `;` or tab), finding the right sheet
  and the row with the column titles, matching titles in English or Arabic (or a matching step the
  person confirms, remembered next time), and parsing every cell (`parse.js`: dates in any common
  form or as Excel day numbers, Arabic digits, amounts with separators and currency, Egyptian
  phones, yes/no in both languages, choices by value or by either language's label);
- a preview: each row New, Update (with exactly what changes), Unchanged, Error or Skipped, with
  messages per cell; the person's own workbook back with the problems marked;
- the import in one transaction (all or nothing, or only the valid rows), kept as a batch that can be
  undone for 14 days while nothing uses its records and nobody changed the updated ones.

## Where datasets live

One file per area in `src/admin/import/datasets/<area>.js`. `routes/import.js` loads **every** file
in that folder (`core.js` first), so a new file needs no other change:

```js
'use strict';
const L = (en, ar) => ({ en, ar });

module.exports = function revenueDatasets(imports, h) {
  const { M } = h;
  imports.register({ /* … */ });
};
```

`imports` is the engine (`h.imports`); `h` is the office's helpers (`h.db`, `h.M`, `h.can`, `h.canHR`,
`h.canFinance`, `h.billing`, `h.approvals`…). Datasets register when the office starts, after every
module has loaded.

## A dataset

```js
imports.register({
  key: 'cheques',                       // unique; also the address /admin/import/cheques
  module: '/admin/cheques',             // the sidebar module: view it to see the dataset, edit it to import
  pages: ['/admin/cheques'],            // list pages that get the "Import from Excel" button (default [module])
  area: 'revenue',                      // the go-live checklist group: setup, people, property, sales,
                                        // revenue, finance, operations, records, other
  order: 40,                            // position in the area (go-live order: units → brands → leases → cheques)
  depends: ['leases'],                  // shown as "after Leases", and in the Read me order
  icon: 'wallet',                       // a ui.icon name
  table: 'cheques',                     // for the default count, find, snapshot, restore, remove and uses
  title: L('Cheques', 'الشيكات'),
  summary: L('Post-dated cheques received from tenants.', 'الشيكات الآجلة المستلمة من المستأجرين.'),
  notes: L('…shown on the dataset page and in the Read me', '…'),
  canView: (req, h) => true,            // optional: who may see it at all (its template lists real data)
  allowed: (req, h) => h.can(req, 'manager'),   // optional: who may import, on top of edit access
  keys: ['ref'],                        // the column(s) that find an existing record, in order of preference
  columns: [ /* see below */ ],
  find(db, v, key) { … },               // optional: id of the existing record, null, or { error: 'imp|…' }
  rowCheck(row, ctx) { … },             // optional: rules across columns (see below)
  apply(row, ctx) { … },                // required: saves one row, returns the record's id
  export(db) { … },                     // rows of the current records, each with $id (round trip, diffs)
  uses(db, id, o) { … },                // optional: what blocks undoing a created record
  snapshot / restore / remove,          // optional: when a record spans several tables (a brand + contacts)
  link: (id) => `/admin/cheques/${id}`, // where a record opens (preview and done pages)
  label: (v, names) => v.ref,           // how a row is named in the preview
  examples: [{ … }, { … }],             // 2–3 rows for the Example sheet (values as export() gives them)
  after(db, h, { created, changes }) {} // optional: once the import is saved (recalculate something…)
});
```

### Columns

```js
{ key: 'due_date', label: L('Due date', 'تاريخ الاستحقاق'), type: 'date', required: true,
  help: L('…', '…'), example: '2026-12-01', width: 14 }
```

| type | the value apply() gets | notes |
| --- | --- | --- |
| `text` | string | `max` (default 500), `multiline: true` keeps new lines, `pattern: { re, error }` |
| `code` | string, upper case, no spaces | unit codes, references |
| `int` / `number` | number | `min`, `maxValue` |
| `money` | number ≥ 0 unless `min` says otherwise | "EGP 12,000", "١٢٬٠٠٠", "(1,200)" all work |
| `percent` | 0–100 | "15%", 15, or a cell formatted as % (0.15) |
| `date` | `YYYY-MM-DD` | dd/mm/yyyy first, as in Egypt; warns when it read month/day or a two-digit year |
| `month` | `YYYY-MM` | |
| `time` | `HH:MM` | |
| `bool` | true / false | yes/no/نعم/لا/✓/1/0 |
| `enum` | the stored value | `enum: [[value, L(en, ar), [synonyms]]]` or a function `(db) => …` |
| `email` | lower case | |
| `phone` | `01xxxxxxxxx` for Egyptian numbers | +20 / 0020 / a number that lost its 0 are fixed |
| `ref` | the referenced record's **id** | `ref: { list: (db) => [{ id, name, alt: [] }], what: L(…), dataset: 'brands' }` |
| `list` | array of strings | "a, b; c" or one per line |

Other column options:

- `aliases: ['shop name', 'المستأجر']` — more titles that mean this column;
- `keepOnUpdate: true` — set on creation only (a unit's level); a different value on an update is a warning;
- `transform: (value) => ({ value, warn?, error? })` — the column's own clean-up after parsing (an IBAN
  without spaces, `https://` added to a website);
- `ref.self: 'code'` + `ref.set(db, id, targetId)` — the reference may point at a row of the same file
  (a manager further down the staff list): it is linked after all rows are saved;
- `ref.dataset` — when the reference is not found, the message says "Import Brands first".

A reference's `list` is also the dropdown of the template, so give `name` the form people know
(`'EMP-0012 · Sara Adel'`, a unit code, a brand name) and `alt` the other ways to write it (the code
alone, the Arabic name).

### rowCheck and apply

`row` is the **full** record as it will be saved: for an update, the current values (from `export`)
with what the file gives on top (an empty cell keeps the current value, unless the person chose "Clear
that field"). References are ids.

```js
rowCheck(row, ctx) {
  // ctx: { db, h, lang, user, id (null for a new record), current (export row or null), provided (Set of
  //        columns the file filled), line, can(min), error(col, 'imp|…', params), warn(col, 'imp|…', params) }
  if (row.end_date && row.end_date < row.start_date) ctx.error('end_date', 'imp|The end is before the start.');
},
apply(row, ctx) {
  // ctx: { db, h, user, lang, id (null: create), line, log(action, entity, id, detail) }
  // Save exactly what the module's own form saves, with the module's own helpers and rules.
  // Throw new Error('imp|…') to refuse a row (the whole import stops, or the row is skipped).
  return id;
},
```

### fileCheck (rules across rows)

`fileCheck(rows, ctx)` sees every row still going in (`{ line, id, full, status, label }`) after the
row checks, for rules a single row cannot know: an opening trial balance must balance, two leave rows
of one person must not overlap. Mark a row with `ctx.error(row, col, 'imp|…', params)` or
`ctx.warn(row, col, …)` (see `opening_balances` in `datasets/finance.js`).

Write activity-log lines with `ctx.log('Added a brand', 'brand', id, name)`, using the actions the
module already logs (they have Arabic), so an imported record's history reads like a typed one.

### Undo

By default undo deletes the created rows of `table` and puts back every updated row as it was
(`SELECT *` before and after). It is refused while anything points at a created record
(`imports.usesOf(table, id, { ignore, entity, skip })` reads the database's own foreign keys, plus
documents filed against the record) or an updated record has changed since. A dataset that spans
several tables gives `snapshot(db, id)`, `restore(db, snapshot)` and `remove(db, id)` (see brands in
`core.js`).

## Text and Arabic

Messages are i18n keys with the `imp|` prefix in `src/admin/i18n/ar-import.js` (or the area's own
dictionary file). Labels, help, titles and enum labels are `{ en, ar }` objects in the dataset itself.
Arabic text must not contain Latin words (the i18n audit checks the pages).

## Tests

Add the dataset to a test that uploads a real workbook (build one with exceljs), checks the preview
statuses and the saved records, and round-trips `export` → import with no change
(`test/admin-import.test.js` has helpers). Run on both database engines (`ADMIN_SQLITE=sqljs`).
