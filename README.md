[![make.fun](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/icandoitone/makefun-csv-reader-speed-01-run-20261121-01/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/icandoitone/makefun-csv-reader-speed-01-run-20261121-01/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121)

# Fast CSV Reader

A faster drop-in for csv-reader 1.0.0 (make.fun's own CSV reader) for the
[Read broken CSV files faster](https://make.fun/bounty/csv-reader-speed-01-run-20261121)
contest. `solve.js` returns exactly csv-reader's answer — `{columns, rows, errors}` —
for every input, including its broken-row policy (BOM, CRLF, stray CRs, quoted
fields with doubled quotes and embedded line breaks, unterminated quotes,
quote junk, short and long rows), and `main.ts` answers every case in
`/input/cases.json` with it, writing `/output/answers.json`.

## Approach

The reference walks the text one character at a time and builds every field
by string concatenation. This reader works record by record and leans on
V8's C++ string primitives instead:

- A record whose line holds no quote and no carriage return is one slice
  plus one `split(',')`.
- Any other record is walked field by field, but each field is still cut
  with one scan: an unquoted field ends at the first comma, line break or
  carriage return (a single character-class search); a quoted field ends at
  the next quote that is not doubled (`indexOf('"')` stepping over `""`
  pairs). Only a field holding a stray carriage return falls back to a
  character loop.
- A quoted field's content is a plain slice when it holds neither a doubled
  quote nor a carriage return; otherwise it is rebuilt once, collapsing
  `""` to `"` and every CR / CRLF to LF.
- The hot field loop builds no object per field — the current field's value,
  end and kept-character count live in shared slots.

Nothing is cached from one case to the next; `run()` builds everything it
returns from its input, so the two executions of an entry write
byte-identical outputs.

## Measured speedup

On the kit's practice set (6 cases, ~10 MB of CSV), the parsing step alone
takes about 110–180 ms against csv-reader 1.0.0's 440–620 ms (roughly 3–4x),
and the whole entry runs end to end in about 0.72–0.79 s of wall time
against the baseline's 1.33–1.61 s (roughly 2x). All 6 practice cases match
csv-reader exactly, and two runs on the same set write byte-identical
`answers.json`.

## Files

- `solve.js` — the fast reader (`run(input)`).
- `main.ts` — the driver: reads `/input/cases.json`, writes
  `/output/answers.json` (turns V8's incremental marking off first, as the
  house baseline does).
- `LICENSE` — MIT.
