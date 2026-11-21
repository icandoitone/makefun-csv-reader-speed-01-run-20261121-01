// Fast drop-in for csv-reader 1.0.0 (make.fun's own CSV reader).
//
// Same answers as csv-reader on every input, reached faster: the reference
// walks the text one character at a time and builds every field by string
// concatenation. This reader instead works record by record and leans on
// V8's C++ string primitives (indexOf / slice / split), keeping the hot
// field loop flat — no object is built per field, the current field's
// value, end and kept-character count live in shared slots:
//
//   - A record whose line holds no quote and no carriage return is one
//     slice plus one split(',') — the common case, most records.
//   - A record with quotes is walked field by field, but each field is
//     still cut with one scan: an unquoted field ends at the first comma,
//     line break or carriage return (one character-class search); a quoted
//     field ends at the next quote that is not doubled (indexOf('"')
//     stepping over '""' pairs).
//     Only a field holding a stray carriage return falls back to a
//     character loop, and that is rare (a few per thousand records).
//   - A quoted field's content is a plain slice when it holds neither a
//     doubled quote nor a carriage return; otherwise it is rebuilt once,
//     collapsing '""' to '"' and every CR / CRLF to LF.
//
// Nothing is cached from one case to the next and no state is kept
// between calls: run() builds everything it returns from its input.

/** How a field ended: at a comma, at a line break, or at the end of the text. */
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** The characters that can end an unquoted field: comma, LF, CR. One scan
 * finds whichever comes first, so the field's end costs a single pass. */
const SEP = /[,\n\r]/g;

/** csv-reader 1.0.0's answer for one case's input: {columns, rows, errors}. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (n > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it
  // takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // The field being read: its value, how it ended, and how many characters
  // the last unquoted scan kept (quote_junk needs that count).
  let fValue = '';
  let fEnded = 0;
  let fAdded = 0;

  // Cold path: walk an unquoted field character by character from pos,
  // dropping stray CRs (each recorded as stray_cr). Used only where the
  // fast scan found a stray CR inside the field, for the junk after a
  // closing quote, and for re-reading after a quote that never closes.
  // Writes the result into the shared field slots.
  function scanUnquotedCold(value) {
    let added = 0;
    while (pos < n) {
      const c = text[pos];
      if (c === ',') {
        pos += 1;
        fValue = value;
        fEnded = COMMA;
        fAdded = added;
        return;
      }
      if (c === '\n') {
        pos += 1;
        line += 1;
        fValue = value;
        fEnded = LINE_BREAK;
        fAdded = added;
        return;
      }
      if (c === '\r') {
        if (text[pos + 1] === '\n') {
          pos += 2;
          line += 1;
          fValue = value;
          fEnded = LINE_BREAK;
          fAdded = added;
          return;
        }
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        pos += 1;
        continue;
      }
      value += c;
      added += 1;
      pos += 1;
    }
    fValue = value;
    fEnded = END;
    fAdded = added;
  }

  // Reads one field starting at pos into the shared field slots: a quoted
  // field when pos holds a quote, else an unquoted one.
  function readField() {
    if (text.charCodeAt(pos) === 34) {
      // A quoted field: find its closing quote, stepping over '""' pairs.
      const open = pos;
      const openLine = line;
      let p = pos + 1;
      let doubled = false;
      let close = -1;
      while (true) {
        const q = text.indexOf('"', p);
        if (q < 0) break;
        if (text.charCodeAt(q + 1) === 34) {
          doubled = true;
          p = q + 2;
          continue;
        }
        close = q;
        break;
      }
      if (close < 0) {
        // The quote never closes: it is a literal character, and the text
        // after it is read again as unquoted.
        pos = open + 1;
        line = openLine;
        errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
        scanUnquotedCold('"');
        return;
      }
      // The field's content sits between the quotes.
      let content;
      const crIn = text.indexOf('\r', open + 1);
      if (!doubled && (crIn < 0 || crIn >= close)) {
        content = text.slice(open + 1, close);
        // Count the line breaks inside it: each LF moves the line on.
        let i = open + 1;
        while (true) {
          const nn = text.indexOf('\n', i);
          if (nn < 0 || nn >= close) break;
          line += 1;
          i = nn + 1;
        }
      } else {
        // Rebuild it once: '""' becomes one quote, each CRLF or lone CR
        // one LF.
        let s = '';
        let i = open + 1;
        while (i < close) {
          const c = text[i];
          if (c === '"') {
            s += '"';
            i += 2;
            continue;
          }
          if (c === '\r') {
            s += '\n';
            line += 1;
            i += text[i + 1] === '\n' ? 2 : 1;
            continue;
          }
          if (c === '\n') line += 1;
          s += c;
          i += 1;
        }
        content = s;
      }
      pos = close + 1;
      if (pos >= n) {
        fValue = content;
        fEnded = END;
        return;
      }
      const c = text[pos];
      if (c === ',') {
        pos += 1;
        fValue = content;
        fEnded = COMMA;
        return;
      }
      if (c === '\n') {
        pos += 1;
        line += 1;
        fValue = content;
        fEnded = LINE_BREAK;
        return;
      }
      if (c === '\r' && text[pos + 1] === '\n') {
        pos += 2;
        line += 1;
        fValue = content;
        fEnded = LINE_BREAK;
        return;
      }
      // What follows the closing quote is appended as it stands, up to
      // the next comma or line break.
      scanUnquotedCold(content);
      if (fAdded > 0) {
        errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
      }
      return;
    }
    // An unquoted field: it ends at the first comma, line break or
    // carriage return at or after pos, or at the end of the text. One
    // scan finds whichever comes first.
    SEP.lastIndex = pos;
    if (SEP.test(text)) {
      const end = SEP.lastIndex - 1;
      const ch = text.charCodeAt(end);
      if (ch === 44) {
        // Comma: nothing before it can be a line break or a stray CR.
        fValue = text.slice(pos, end);
        fAdded = end - pos;
        pos = end + 1;
        fEnded = COMMA;
        return;
      }
      if (ch === 10) {
        // Line break: no CR can sit before it, the scan would have
        // stopped there first.
        fValue = text.slice(pos, end);
        fAdded = end - pos;
        pos = end + 1;
        line += 1;
        fEnded = LINE_BREAK;
        return;
      }
      // A carriage return: a CRLF line ending, or a stray CR inside the
      // field.
      if (text.charCodeAt(end + 1) === 10) {
        fValue = text.slice(pos, end);
        fAdded = end - pos;
        pos = end + 2;
        line += 1;
        fEnded = LINE_BREAK;
        return;
      }
      // A stray CR sits inside the field: walk it character by character.
      scanUnquotedCold('');
      return;
    }
    fValue = text.slice(pos, n);
    fAdded = n - pos;
    pos = n;
    fEnded = END;
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      if (text[pos] === '\n') {
        pos += 1;
        line += 1;
      } else if (text[pos] === '\r' && text[pos + 1] === '\n') {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // Fast path: the record's line holds no quote and no carriage return
    // (or only the CR of its CRLF ending), so it is one slice and one
    // split — no quoted field can span lines, no stray CR can hide in it.
    let fields = null;
    const nl = text.indexOf('\n', pos);
    const segEnd = nl < 0 ? n : nl;
    const q = text.indexOf('"', pos);
    if (q < 0 || q >= segEnd) {
      const r = text.indexOf('\r', pos);
      if (r < 0 || r >= segEnd) {
        fields = text.slice(pos, segEnd).split(',');
        pos = nl < 0 ? n : nl + 1;
        if (nl >= 0) line += 1;
      } else if (nl >= 0 && r === segEnd - 1) {
        fields = text.slice(pos, segEnd - 1).split(',');
        pos = nl + 1;
        line += 1;
      }
    }

    let quoted = false;
    if (fields === null) {
      // The record needs the field-by-field reader.
      fields = [];
      do {
        quoted = text.charCodeAt(pos) === 34;
        readField();
        fields.push(fValue);
      } while (fEnded === COMMA);
    }

    // A line that held only stray CRs is left with no characters: no
    // record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
