// Layout-aware text extraction.
//
// IRS transcripts are "label: value" text and work fine with flat regex.
// Real FILED forms (1040, W-2 from a preparer/ADP) are different: the blank
// form template and the filled-in values are separate text runs, so in reading
// order a value can appear hundreds of characters away from its label. But every
// text item carries x/y coordinates, so the label→value relationship is
// recoverable spatially:
//
//   W-2 box:      [1 Wages, tips, other comp.]   <- label row
//                 [        14160.28          ]   <- value directly beneath
//
//   1040 line:    [1a Total amount from Form(s) W-2, box 1 ....  1a]  <- label row
//                 value sits in the far-right amount column, same row band
//
// buildLayout() returns { rows, items, pageHeight } per page so extractors can
// ask "what number sits below this label" or "what number is on this row".

function buildLayout(items) {
  const clean = items
    .filter((it) => it.str && it.str.trim())
    .map((it) => ({
      s: it.str.trim(),
      x: it.transform[4],
      y: it.transform[5],
      w: it.width || 0
    }));
  return { items: clean, rows: groupRows(clean) };
}

// Group items into visual rows (same baseline within tolerance).
function groupRows(items, tol = 3) {
  const rows = [];
  items
    .slice()
    .sort((a, b) => b.y - a.y || a.x - b.x)
    .forEach((it) => {
      let row = rows.find((R) => Math.abs(R.y - it.y) <= tol);
      if (!row) { row = { y: it.y, items: [] }; rows.push(row); }
      row.items.push(it);
    });
  rows.forEach((R) => R.items.sort((a, b) => a.x - b.x));
  return rows;
}

function rowText(row) {
  return row.items.map((i) => i.s).join(" ");
}

// A filled money value on these forms always carries a decimal point or a
// thousands comma: "14160.28", "307,526.", "(1,234.00)", "-115.".
// A bare small integer ("1", "3", "5", "28") is a LINE NUMBER or box marker in
// the gutter, never an amount — accepting those made line 3 report "3".
const MONEY_ITEM = /^\(?-?\$?\s*(?:[0-9]{1,3}(?:,[0-9]{3})+(?:\.[0-9]*)?|[0-9]+\.[0-9]*|[0-9]+\.)\)?$/;

function parseMoneyItem(s) {
  if (!s) return null;
  const neg = /^\(.*\)$/.test(s.trim()) || /^-/.test(s.trim());
  const t = s.replace(/[()$,\s]/g, "").replace(/\.$/, "").replace(/^-/, "");
  if (t === "") return null;
  const n = parseFloat(t);
  if (!isFinite(n)) return null;
  return neg ? -n : n;
}

function moneyItems(layout) {
  return layout.items.filter((i) => MONEY_ITEM.test(i.s) && parseMoneyItem(i.s) !== null);
}

// Find rows whose combined text matches a regex.
function findRows(layout, re) {
  return layout.rows.filter((r) => re.test(rowText(r)));
}

// The x of the first item on the row matching `labelRe` (the label's own column).
function labelAnchor(row, labelRe) {
  const it = row.items.find((i) => labelRe.test(i.s));
  return it ? it.x : row.items[0].x;
}

// VALUE BELOW: for boxed forms (W-2). Look for a money item directly under the
// label, within the same narrow column band.
function valueBelow(layout, row, anchorX, opts = {}) {
  const bandLeft = opts.bandLeft ?? 12;
  const bandRight = opts.bandRight ?? 70;
  const maxDrop = opts.maxDrop ?? 22;
  const cands = moneyItems(layout).filter(
    (v) => v.x >= anchorX - bandLeft && v.x <= anchorX + bandRight &&
           row.y - v.y > 0 && row.y - v.y < maxDrop
  );
  cands.sort((a, b) => (row.y - a.y) - (row.y - b.y));
  return cands.length ? parseMoneyItem(cands[0].s) : null;
}

// VALUE ON ROW: for line-item forms (1040/Schedule 1). The amount sits in the
// right-hand column on the same visual row as the label.
function valueOnRow(layout, row, opts = {}) {
  const minX = opts.minX ?? 0;
  const cands = row.items
    .filter((i) => i.x >= minX && MONEY_ITEM.test(i.s) && parseMoneyItem(i.s) !== null);
  if (!cands.length) return null;
  // Right-most money item on the row is the amount column.
  cands.sort((a, b) => b.x - a.x);
  return parseMoneyItem(cands[0].s);
}

if (typeof module !== "undefined") {
  module.exports = { buildLayout, groupRows, rowText, findRows, labelAnchor, valueBelow, valueOnRow, moneyItems, parseMoneyItem, MONEY_ITEM };
}
