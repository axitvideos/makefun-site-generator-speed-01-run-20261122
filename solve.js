// solve.js — a fast drop-in for makefun-site 1.0.0's build().
// Written from the reference's README and behaviour (not its code): same output,
// byte for byte, on every input. No dependencies, no I/O, no clock, no randomness.
//
// Layout of the speed work:
//  - Markdown is rendered in one pass over the body's lines (no token array), and
//    inline markup is rendered with bulk-run escaping instead of one replace per
//    character.
//  - Templates are compiled to small functions (includes inlined, loop variables
//    as locals) instead of walked as a node tree on every render.
//  - slugify / longDate results are memoised per build; the common ASCII slug
//    path skips Unicode normalisation.
//  - Strings are built in arrays and joined once, never with += in a loop.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const hasOwn = Object.hasOwn;

// ---------------------------------------------------------------- text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;
const escReplacer = (c) => ESCAPES[c];

/** `text` with & < > " and ' escaped. */
function escapeHtml(text) {
  return text.replace(ESC_RE, escReplacer);
}

/** The most characters a slug keeps before a collision suffix. */
const SLUG_MAX = 64;

const MARK_RE = /\p{M}/gu;
const NON_ASCII = /[^\x00-\x7F]/;

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run of
 * characters other than a-z and 0-9 one "-", none at either end, at most SLUG_MAX
 * characters (a "-" left at the cut dropped), and "untitled" when nothing is left.
 * `cache` is a per-build memo (titles and tag names repeat a lot).
 */
function slugify(text, cache) {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  let plain = text;
  if (NON_ASCII.test(text)) plain = text.normalize('NFKD').replace(MARK_RE, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const code = plain.charCodeAt(i);
    let keep = 0;
    if (code >= 65 && code <= 90) keep = code + 32; // A-Z -> a-z
    else if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) keep = code;
    if (keep === 0) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  if (out.length > SLUG_MAX) out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  if (out === '') out = 'untitled';
  cache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it): slug, slug-2, slug-3 ... */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = slug + '-' + n;
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone. `cache` is a per-build memo. */
function longDate(date, cache) {
  let hit = cache.get(date);
  if (hit === undefined) {
    hit = Number(date.slice(8, 10)) + ' ' + MONTHS[Number(date.slice(5, 7)) - 1] + ' ' + date.slice(0, 4);
    cache.set(date, hit);
  }
  return hit;
}

/** Whether a UTF-16 code unit is JS whitespace (\s). */
function isWS(code) {
  if (code === 32 || code === 9 || code === 10 || code === 13 || code === 11 || code === 12) return true;
  if (code < 128) return false;
  return code === 0xa0 || code === 0x1680 || (code >= 0x2000 && code <= 0x200a) || code === 0x2028 || code === 0x2029 || code === 0x202f || code === 0x205f || code === 0x3000 || code === 0xfeff;
}

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12) inWord = false;
    else if (c > 127 && isWS(c)) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------- front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

function isKeyChar(code) {
  return (code >= 97 && code <= 122) || code === 95; // a-z _
}

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function isDigit(code) {
  return code >= 48 && code <= 57;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) { // "
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' }; // [
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: 'key "' + key + '": ' + s.error } : s;
    }
    case 'date': {
      // YYYY-MM-DD, a real day from 1970-01-01 to 2099-12-31.
      let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
      let y = 0, mo = 0, d = 0;
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          if (!isDigit(raw.charCodeAt(i))) { ok = false; break; }
        }
      }
      if (ok) {
        y = (raw.charCodeAt(0) - 48) * 1000 + (raw.charCodeAt(1) - 48) * 100 + (raw.charCodeAt(2) - 48) * 10 + (raw.charCodeAt(3) - 48);
        mo = (raw.charCodeAt(5) - 48) * 10 + (raw.charCodeAt(6) - 48);
        d = (raw.charCodeAt(8) - 48) * 10 + (raw.charCodeAt(9) - 48);
        if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) ok = false;
      }
      if (!ok) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' }; // [ ]
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = [];
      let start = 0;
      for (let i = 0; i <= inner.length; i++) {
        if (i === inner.length || inner.charCodeAt(i) === 44) { // ,
          const t = inner.slice(start, i).trim();
          if (t === '') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
          for (let j = 0; j < t.length; j++) {
            const c = t.charCodeAt(j);
            if (c === 34 || c === 91 || c === 93) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
          }
          tags.push(t);
          start = i + 1;
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      if (raw.length === 0) return { error: 'key "layout": not a template name' };
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return { error: 'key "layout": not a template name' };
      }
      return { value: raw };
    }
    case 'slug': {
      if (raw.length === 0 || raw.length > 64) return { error: 'key "slug": not a slug' };
      let prevDash = true; // slug must open on alnum, single - between
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (c === 45) {
          if (prevDash) return { error: 'key "slug": not a slug' };
          prevDash = true;
        } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
        else return { error: 'key "slug": not a slug' };
      }
      if (prevDash) return { error: 'key "slug": not a slug' };
      return { value: raw };
    }
    default:
      return { error: 'unknown key "' + key + '"' };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first
 * reason it is refused. `text` has "\n" line ends. Lines are scanned in place
 * instead of splitting the whole source.
 */
function parseFrontMatter(text) {
  // lines[0] must be exactly '---'.
  if (text !== '---' && !text.startsWith('---\n')) return { error: 'no front matter' };
  if (text === '---') return { error: 'the front matter is not closed' };
  // Find the closing '---' line.
  let pos = 4; // just past the opening '---\n'
  let closeLineStart = -1;
  let bodyStart = -1;
  for (;;) {
    const nl = text.indexOf('\n', pos);
    if (nl === -1) {
      if (text.slice(pos) === '---') { closeLineStart = pos; bodyStart = text.length; }
      break;
    }
    if (nl === pos + 3 && text[pos] === '-' && text[pos + 1] === '-' && text[pos + 2] === '-') {
      closeLineStart = pos;
      bodyStart = nl + 1;
      break;
    }
    pos = nl + 1;
  }
  if (closeLineStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  // Parse the front-matter lines (between the two '---' lines).
  let lineNo = 1; // the opening '---' is line 1; the next line is line 2
  pos = 4;
  while (pos < closeLineStart) {
    const nl = text.indexOf('\n', pos);
    const end = nl === -1 ? closeLineStart : nl;
    lineNo++;
    const line = text.slice(pos, end);
    // blank (spaces/tabs only) or a comment (opens on '#'): skip.
    let blank = true;
    for (let i = 0; i < line.length; i++) {
      const c = line.charCodeAt(i);
      if (c !== 32 && c !== 9) { blank = false; break; }
    }
    if (!blank && line.charCodeAt(0) !== 35) {
      // "key: value": key of a-z and _, a colon, one space and the value.
      let colon = -1;
      for (let i = 0; i < line.length; i++) {
        if (line.charCodeAt(i) === 58) { colon = i; break; } // :
        if (!isKeyChar(line.charCodeAt(i))) break;
      }
      if (colon <= 0) return { error: 'line ' + lineNo + ' is not "key: value"' };
      const key = line.slice(0, colon);
      for (let i = 0; i < key.length; i++) if (!isKeyChar(key.charCodeAt(i))) return { error: 'line ' + lineNo + ' is not "key: value"' };
      let raw;
      if (colon === line.length - 1) raw = '';
      else if (line.charCodeAt(colon + 1) === 32) raw = line.slice(colon + 2);
      else return { error: 'line ' + lineNo + ' is not "key: value"' };
      // drop trailing spaces and tabs
      let rEnd = raw.length;
      while (rEnd > 0) {
        const c = raw.charCodeAt(rEnd - 1);
        if (c === 32 || c === 9) rEnd--;
        else break;
      }
      raw = raw.slice(0, rEnd);
      if (!KEYS.includes(key)) return { error: 'unknown key "' + key + '"' };
      if (hasOwn(data, key)) return { error: 'key "' + key + '" is given twice' };
      if (raw === '') return { error: 'key "' + key + '" has no value' };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    pos = end + 1;
  }
  if (!hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;
/** The most nodes one template's include expansion may hold before it falls back to interpretation. */
const EXPAND_BUDGET = 10000;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError('template "' + name + '": ' + JSON.stringify(text) + ' is not a path');
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError('template "' + name + '": a ' + (raw ? '{{{' : '{{') + ' is not closed');
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError('template "' + name + '": a {% is not closed');
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError('template "' + name + '": an else outside an if');
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError('template "' + name + '": an ' + tag + ' with no open ' + tag.slice(3));
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError('template "' + name + '": {% ' + tag + ' %} is not a tag');
    }
  }
  if (stack.length > 1) throw new TemplateError('template "' + name + '": a ' + stack[stack.length - 1].kind + ' is not closed');
  return root.body;
}

// --- template values (the same rules the reference renders by) ---

/** A value as text: string itself, a number in JavaScript's digits, true/false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** The own property `k` of object `v`, or undefined (a path step). */
function get(v, k) {
  return v !== null && typeof v === 'object' && hasOwn(v, k) ? v[k] : undefined;
}

// --- template compiler: AST -> a function (out, R), includes inlined ---

let compileCounter = 0;

/**
 * Compile `nodes` to a function (out, R) that pushes the rendered text into
 * `out`. `asts` holds every parsed template (for include expansion); `depth`
 * is the include depth the nodes render at. Loop variables resolve to locals;
 * anything else reads off the root vars `R` (built null-prototype, so a direct
 * read is a has-own read). Returns the function, or null when the expansion
 * overran the budget (the caller then interprets the AST instead).
 */
function compileTemplate(nodes, asts) {
  const code = [];
  let pend = '';
  let count = 0;
  let budgetHit = false;
  let fresh = 0;
  // The compile-time environment: a stack of Maps, name -> local variable.
  const env = [];

  function flush() {
    if (pend !== '') {
      code.push('out.push(' + JSON.stringify(pend) + ');');
      pend = '';
    }
  }

  // A path as a JS expression for its value.
  function pathExpr(path) {
    let expr;
    for (let f = env.length - 1; f >= 0; f--) {
      const local = env[f].get(path[0]);
      if (local !== undefined) { expr = local; break; }
    }
    if (expr === undefined) expr = 'get(R,' + JSON.stringify(path[0]) + ')';
    for (let k = 1; k < path.length; k++) expr = 'get(' + expr + ',' + JSON.stringify(path[k]) + ')';
    return expr;
  }

  function emit(nodes, depth) {
    for (const n of nodes) {
      if (budgetHit) return;
      if (++count > EXPAND_BUDGET) { budgetHit = true; return; }
      switch (n.kind) {
        case 'text':
          pend += n.text;
          break;
        case 'var':
          flush();
          code.push('out.push(esc(txt(' + pathExpr(n.path) + ')));');
          break;
        case 'raw':
          flush();
          code.push('out.push(txt(' + pathExpr(n.path) + '));');
          break;
        case 'if': {
          flush();
          const cond = 'tru(' + pathExpr(n.path) + ')';
          if (n.else === null) {
            code.push(n.not ? 'if(!' + cond + '){' : 'if(' + cond + '){');
            emit(n.then, depth);
            flush();
            code.push('}');
          } else {
            code.push(n.not ? 'if(!' + cond + '){' : 'if(' + cond + '){');
            emit(n.then, depth);
            flush();
            code.push('}else{');
            emit(n.else, depth);
            flush();
            code.push('}');
          }
          break;
        }
        case 'for': {
          flush();
          const id = fresh++;
          const arr = 'a' + id, len = 'n' + id, el = 'e' + id, lp = 'l' + id, ix = 'k' + id;
          code.push('{const ' + arr + '=' + pathExpr(n.path) + ';if(Array.isArray(' + arr + ')){const ' + len + '=' + arr + '.length;let ' + el + ';const ' + lp + '={index:0,first:false,last:false,length:' + len + '};for(let ' + ix + '=0;' + ix + '<' + len + ';' + ix + '++){ ' + el + '=' + arr + '[' + ix + '];' + lp + '.index=' + ix + '+1;' + lp + '.first=' + ix + '===0;' + lp + '.last=' + ix + '===' + len + '-1;');
          const frame = new Map();
          frame.set(n.name, el);
          frame.set('loop', lp);
          env.push(frame);
          emit(n.body, depth);
          env.pop();
          flush();
          code.push('}}}');
          break;
        }
        case 'include': {
          flush();
          if (depth < INCLUDE_DEPTH) {
            const target = asts.get(n.name);
            if (target !== undefined) emit(target, depth + 1);
          }
          break;
        }
      }
    }
  }

  emit(nodes, 0);
  if (budgetHit) return null;
  flush();
  const src = code.join('\n');
  try {
    return new Function('out', 'R', 'esc', 'txt', 'tru', 'get', src);
  } catch {
    return null; // an environment that bars generated code falls back to interpreting
  }
}

// --- template interpreter: the fallback for over-budget expansions ---

/** The value at `path` in the scope chain. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** `nodes` rendered into `out`, in `scope` ({ vars, parent }), at include depth `depth`. */
function renderInterp(nodes, scope, asts, depth, out) {
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        out.push(escapeHtml(textOf(lookup(scope, n.path))));
        break;
      case 'raw':
        out.push(textOf(lookup(scope, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderInterp(branch, scope, asts, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        const frame = {};
        const child = { vars: frame, parent: scope };
        for (let k = 0; k < xs.length; k++) {
          frame[n.name] = xs[k];
          frame.loop = { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length };
          renderInterp(n.body, child, asts, depth, out);
        }
        break;
      }
      case 'include': {
        const t = asts.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderInterp(t, scope, asts, depth + 1, out);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- Markdown

/** The characters a backslash escapes. */
const ESCAPABLE = new Uint8Array(128);
for (const ch of ['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']) ESCAPABLE[ch.charCodeAt(0)] = 1;

/** Whether `line` is blank: empty or spaces and tabs only. */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Whether `line` is only spaces and tabs from index `from`. */
function onlySpaceTab(line, from) {
  for (let i = from; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A fence-open line's language, or null (line must be ``` + lang + spaces/tabs only). */
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  if (!onlySpaceTab(line, i)) return null;
  return line.slice(3, i);
}

/** Whether `line` closes a fence: ``` then spaces or tabs only. */
function isFenceClose(line) {
  return line.length >= 3 && line.charCodeAt(0) === 96 && line.charCodeAt(1) === 96 && line.charCodeAt(2) === 96 && onlySpaceTab(line, 3);
}

/** A heading line's { depth, text }, or null (text never empty; 7+ # never a heading). */
function headingOf(line) {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 35) n++;
  if (n === 0 || n > 6) return null;
  if (n >= line.length) return null;
  const c = line.charCodeAt(n);
  if (c !== 32 && c !== 9) return null;
  let start = n;
  while (start < line.length) {
    const cc = line.charCodeAt(start);
    if (cc !== 32 && cc !== 9) break;
    start++;
  }
  let end = line.length;
  while (end > start) {
    const cc = line.charCodeAt(end - 1);
    if (cc !== 32 && cc !== 9) break;
    end--;
  }
  if (end === start) return null;
  return { depth: n, text: line.slice(start, end) };
}

/** Whether `line` is a thematic break: --- or *** then spaces or tabs only. */
function isHR(line) {
  if (line.length < 3) return false;
  const c = line.charCodeAt(0);
  if (c !== 45 && c !== 42) return false; // - *
  if (line.charCodeAt(1) !== c || line.charCodeAt(2) !== c) return false;
  return onlySpaceTab(line, 3);
}

/** A bullet list line's item text, or null (line must open "- " or "* "). */
function bulletOf(line) {
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

/** An ordered list line's { start, text }, or null (1-9 digits, ". ", text). */
function orderedOf(line) {
  let i = 0;
  let num = 0;
  let digits = 0;
  while (i < line.length && digits < 10) {
    const c = line.charCodeAt(i);
    if (c < 48 || c > 57) break;
    num = num * 10 + (c - 48);
    digits++;
    i++;
  }
  if (digits === 0 || digits > 9) return null;
  if (line.charCodeAt(i) !== 46 || line.charCodeAt(i + 1) !== 32) return null; // . + space
  return { start: num, text: line.slice(i + 2) };
}

/** A list continuation line: two or more spaces, then a non-space. */
const CONTINUED_RE = /^ {2,}\S/;
function isContinued(line) {
  return CONTINUED_RE.test(line);
}

/** A line trimmed of spaces and tabs at both ends. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b) {
    const c = line.charCodeAt(a);
    if (c !== 32 && c !== 9) break;
    a++;
  }
  while (b > a) {
    const c = line.charCodeAt(b - 1);
    if (c !== 32 && c !== 9) break;
    b--;
  }
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** Whether `line` ends a paragraph: blank, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  const c0 = line.length === 0 ? -1 : line.charCodeAt(0);
  if (c0 === -1) return true;
  if (c0 === 32 || c0 === 9) return isBlank(line);
  if (c0 === 96) return fenceLang(line) !== null;
  if (c0 === 35) return headingOf(line) !== null;
  if (c0 === 45 || c0 === 42) return isHR(line);
  return false;
}

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  const last = s.length - what.length;
  for (let j = from; j <= last; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < s.length && ESCAPABLE[s.charCodeAt(j + 1)] === 1) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    if (s.charCodeAt(j) === 92 && j + 1 < s.length && ESCAPABLE[s.charCodeAt(j + 1)] === 1) {
      j++;
      continue;
    }
    if (s.charCodeAt(j) !== 42) continue; // *
    if (s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

const WS_RE = /\s/;

/** The characters inline rendering stops at: its constructs and the escapes. */
const SPECIAL_RE = /[\\`*\[&<>"']/g;

/**
 * `s` rendered inline into `out` (an array of string chunks); `link(target)` is
 * a link's href. A regex finds each special character in C++; the plain runs
 * between them are flushed in bulk, escaped once. (The regex is shared and
 * re-entrant: every call resets lastIndex on entry and after each step, and
 * recursion into a nested span always sets it again before resuming.)
 */
function inlineInto(s, link, out) {
  let rs = 0;
  SPECIAL_RE.lastIndex = 0;
  let m;
  while ((m = SPECIAL_RE.exec(s)) !== null) {
    const i = m.index;
    const c = s.charCodeAt(i);
    if (c === 92) { // \ backslash escape
      if (i + 1 < s.length && ESCAPABLE[s.charCodeAt(i + 1)] === 1) {
        if (rs < i) out.push(s.slice(rs, i));
        const nx = s[i + 1];
        out.push(ESCAPES[nx] || nx);
        rs = i + 2;
        SPECIAL_RE.lastIndex = rs;
      } else SPECIAL_RE.lastIndex = i + 1; // a plain backslash stays in the run
      continue;
    }
    if (c === 96) { // ` code span
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        if (rs < i) out.push(s.slice(rs, i));
        out.push('<code>', escapeHtml(s.slice(i + 1, j)), '</code>');
        rs = j + 1;
        SPECIAL_RE.lastIndex = rs;
      } else SPECIAL_RE.lastIndex = i + 1; // no closer: itself
      continue;
    }
    if (c === 42) { // * emphasis / strong
      if (s.charCodeAt(i + 1) === 42) {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          if (rs < i) out.push(s.slice(rs, i));
          out.push('<strong>');
          inlineInto(s.slice(i + 2, j), link, out);
          out.push('</strong>');
          rs = j + 2;
          SPECIAL_RE.lastIndex = rs;
        } else SPECIAL_RE.lastIndex = i + 2; // no closer: itself
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        if (rs < i) out.push(s.slice(rs, i));
        out.push('<em>');
        inlineInto(s.slice(i + 1, j), link, out);
        out.push('</em>');
        rs = j + 1;
        SPECIAL_RE.lastIndex = rs;
      } else SPECIAL_RE.lastIndex = i + 1; // no closer: itself
      continue;
    }
    if (c === 91) { // [ link
      const k = findUnescaped(s, ']', i + 1);
      const mm = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
      const target = mm === -1 ? '' : s.slice(k + 2, mm);
      if (target !== '' && !WS_RE.test(target)) {
        if (rs < i) out.push(s.slice(rs, i));
        out.push('<a href="', escapeHtml(link(target)), '">');
        inlineInto(s.slice(i + 1, k), link, out);
        out.push('</a>');
        rs = mm + 1;
        SPECIAL_RE.lastIndex = rs;
      } else SPECIAL_RE.lastIndex = i + 1; // not a link: itself
      continue;
    }
    // an escapable character: & < > " '
    if (rs < i) out.push(s.slice(rs, i));
    out.push(ESCAPES[s[i]]);
    rs = i + 1;
    SPECIAL_RE.lastIndex = rs;
  }
  if (rs < s.length) out.push(s.slice(rs));
}

/** `s` rendered inline. */
const CONSTRUCT_RE = /[\\`*[]/;
function inline(s, link) {
  // No backslash, backtick, star or bracket: no construct can trigger, so the
  // whole string is just escaped.
  if (!CONSTRUCT_RE.test(s)) return escapeHtml(s);
  const out = [];
  inlineInto(s, link, out);
  return out.join('');
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the last),
 * its table of contents (every level 2 and 3 heading: level, id and its inline
 * HTML) and its excerpt (the first paragraph's inline HTML, or "").
 * `env` holds the link resolver; `ids` is the page's heading-id set.
 * Blocks are classified by their first character, in the reference's order:
 * blank, fence, heading, thematic break, blockquote, list, paragraph.
 */
function renderMarkdown(src, link, ids) {
  const lines = src.split('\n');
  const out = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  const total = lines.length;
  while (i < total) {
    const line = lines[i];
    const c0 = line.length === 0 ? -1 : line.charCodeAt(0);
    if (c0 === -1) { i++; continue; } // a blank line
    if (c0 === 32 || c0 === 9) {
      if (isBlank(line)) { i++; continue; }
      // an indented line is a paragraph
    } else if (c0 === 96) { // ` a fence, or a paragraph
      const lang = fenceLang(line);
      if (lang !== null) {
        const body = [];
        i++;
        while (i < total && !isFenceClose(lines[i])) body.push(lines[i++]);
        i++;
        out.push('<pre><code');
        if (lang !== '') out.push(' class="language-', escapeHtml(lang), '"');
        out.push('>');
        for (let k = 0; k < body.length; k++) { out.push(escapeHtml(body[k]), '\n'); }
        out.push('</code></pre>\n');
        continue;
      }
    } else if (c0 === 35) { // # a heading, or a paragraph
      const heading = headingOf(line);
      if (heading !== null) {
        const id = uniqueSlug(slugify(heading.text, renderMarkdown.slugCache), ids);
        out.push('<h' + heading.depth + ' id="' + id + '">');
        if (heading.depth === 2 || heading.depth === 3) {
          const html = inline(heading.text, link);
          out.push(html);
          toc.push({ level: heading.depth, id, html });
        } else inlineInto(heading.text, link, out);
        out.push('</h' + heading.depth + '>\n');
        i++;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) { // - or * a break, a list, or a paragraph
      if (isHR(line)) { out.push('<hr>\n'); i++; continue; }
      const bullet = bulletOf(line);
      if (bullet !== null) {
        const items = [];
        while (i < total) {
          const l = lines[i];
          const content = bulletOf(l);
          if (content !== null) {
            items.push([trimLine(content)]);
            i++;
          } else if (isContinued(l)) {
            items[items.length - 1].push(trimLine(l));
            i++;
          } else break;
        }
        out.push('<ul>\n');
        for (let k = 0; k < items.length; k++) {
          out.push('<li>');
          inlineInto(items[k].join('\n'), link, out);
          out.push('</li>\n');
        }
        out.push('</ul>\n');
        continue;
      }
    } else if (c0 === 62) { // > a blockquote
      const body = [];
      while (i < total && lines[i].charCodeAt(0) === 62) {
        let l = lines[i++];
        l = l.length > 1 && l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1);
        body.push(trimLine(l));
      }
      const kept = [];
      for (let k = 0; k < body.length; k++) if (body[k] !== '') kept.push(body[k]);
      if (kept.length === 0) out.push('<blockquote>\n</blockquote>\n');
      else {
        out.push('<blockquote>\n<p>');
        inlineInto(kept.join('\n'), link, out);
        out.push('</p>\n</blockquote>\n');
      }
      continue;
    } else if (c0 >= 48 && c0 <= 57) { // a digit: an ordered list, or a paragraph
      const ordered = orderedOf(line);
      if (ordered !== null) {
        const items = [];
        while (i < total) {
          const l = lines[i];
          const o = orderedOf(l);
          if (o !== null) {
            items.push([trimLine(o.text)]);
            i++;
          } else if (isContinued(l)) {
            items[items.length - 1].push(trimLine(l));
            i++;
          } else break;
        }
        const open = ordered.start !== 1 ? '<ol start="' + ordered.start + '">' : '<ol>';
        out.push(open, '\n');
        for (let k = 0; k < items.length; k++) {
          out.push('<li>');
          inlineInto(items[k].join('\n'), link, out);
          out.push('</li>\n');
        }
        out.push('</ol>\n');
        continue;
      }
    }
    // A paragraph: this line and the lines after it up to a blank line, a
    // fence, a heading or a thematic break.
    const body = [trimLine(line)];
    i++;
    while (i < total && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const text = body.join('\n');
    if (excerpt === null) {
      const html = inline(text, link);
      excerpt = html;
      out.push('<p>' + html + '</p>\n');
    } else {
      out.push('<p>');
      inlineInto(text, link, out);
      out.push('</p>\n');
    }
  }
  return { html: out.join(''), toc, excerpt: excerpt ?? '' };
}
// A per-build slug memo, set by build() before rendering (headings share it
// with titles and tags).
renderMarkdown.slugCache = null;

// ---------------------------------------------------------------- the build

/** The report file every build writes. */
const REPORT_FILE = 'build-report.txt';

/** The top-level directories the generator writes itself. */
const RESERVED = ['posts', 'tags', 'page'];

const dirOf = (path) => {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
};

/** `rel` from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  // The common link has no dot segments: it is just the directory joined
  // onto the target, with no splitting or joining at all.
  if (
    rel.indexOf('..') === -1 && rel.indexOf('//') === -1 && rel !== '.' &&
    !rel.startsWith('./') && !rel.endsWith('/') && !rel.endsWith('/.') &&
    rel.indexOf('/./') === -1
  ) return dir === '' ? rel : dir + '/' + rel;
  const parts = dir === '' ? [] : dir.split('/');
  const segs = rel.split('/');
  for (let k = 0; k < segs.length; k++) {
    const seg = segs[k];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** One site's output tree: path -> text. */
function build(input) {
  const slugCache = new Map();
  const dateCache = new Map();
  renderMarkdown.slugCache = slugCache;

  // 2. Templates, parsed in code-unit order of name; one that does not parse
  //    is reported and left out.
  const asts = new Map();
  const compiled = new Map();
  const report = [];
  const names = Object.keys(input.templates).sort(byCodeUnits);
  for (let k = 0; k < names.length; k++) {
    const name = names[k];
    try {
      asts.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  // Templates compile lazily, on first render: only the layouts and the
  // index/tag pages are ever rendered top-level, and the rest are reached
  // only through inlining, so compiling them all up front is wasted work.
  // (Every template is parsed by now, so an include of a template that sorts
  // later still expands.)
  const render = (name, R) => {
    let fn = compiled.get(name);
    if (fn === undefined) {
      const nodes = asts.get(name);
      if (nodes === undefined) return null;
      fn = compileTemplate(nodes, asts);
      if (fn !== null) compiled.set(name, fn);
      else {
        const out = [];
        renderInterp(nodes, { vars: R, parent: null }, asts, 0, out);
        return out.join('');
      }
    }
    const out = [];
    fn(out, R, escapeHtml, textOf, truthy, get);
    return out.join('');
  };

  // 1. Sources, in code-unit order of path; a non-.md file is static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (let k = 0; k < files.length; k++) {
    const f = files[k];
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // Front matter, in source order; a refused source or a draft is dropped.
  const kept = [];
  for (let k = 0; k < sources.length; k++) {
    const s = sources[k];
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push('refused ' + s.path + ': ' + fm.error);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own = null;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== null) {
      report.push('refused ' + s.path + ': ' + own + '/ is the generator\'s own');
      continue;
    }
    if (s.post && !hasOwn(s.data, 'date')) {
      report.push('refused ' + s.path + ': a post needs a date');
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!asts.has(layout)) {
      report.push('refused ' + s.path + ': layout "' + layout + '" is no template that parses');
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push('draft ' + s.path);
      continue;
    }
    kept.push(s);
  }

  const base = input.site.base_url.replace(/\/+$/, '');

  // 3. Permalinks: the slug made unique in its directory, in source order.
  const taken = new Map();
  const takenIn = (dir) => {
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    return set;
  };
  const bySource = new Map();
  for (let k = 0; k < kept.length; k++) {
    const s = kept[k];
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, slugCache), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : dir + '/' + slug;
    s.url = base + '/' + s.outDir + '/';
    bySource.set(s.path, s);
  }

  // 4. Markdown, each body's links resolved to the pages and static files.
  const broken = new Set();
  const staticPaths = new Set();
  for (let k = 0; k < statics.length; k++) staticPaths.add(statics[k].path);
  const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;
  for (let k = 0; k < kept.length; k++) {
    const s = kept[k];
    const dir = dirOf(s.path);
    const ids = new Set();
    const link = (target) => {
      if (SCHEME_RE.test(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target; // / #
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null) {
        const page = bySource.get(path);
        if (page !== undefined) return page.url + frag;
        if (staticPaths.has(path)) return base + '/' + path + frag;
      }
      broken.add('broken-link ' + s.path + ' -> ' + target);
      return target;
    };
    const md = renderMarkdown(s.body, link, ids);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.words = wordsOf(s.body);
  }

  // 5. Collections: posts newest first, then by slug; newer/older neighbours.
  const posts = [];
  for (let k = 0; k < kept.length; k++) if (kept[k].post) posts.push(kept[k]);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // 6. Tags: grouped by slug, first spelling kept, ordered by count then slug.
  const bySlug = new Map();
  const tagFallbacks = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    const tags = s.data.tags ?? [];
    for (let k = 0; k < tags.length; k++) {
      const name = tags[k];
      const slug = slugify(name, slugCache);
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push(name);
    }
    return out;
  };
  for (let k = 0; k < posts.length; k++) {
    const p = posts[k];
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name, slugCache);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: base + '/tags/' + slug + '/', posts: [] };
        tag.link = { name, slug, url: tag.url };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (let k = 0; k < kept.length; k++) {
    const s = kept[k];
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugify(name, slugCache);
      const tag = bySlug.get(slug);
      if (tag !== undefined) return tag;
      let fb = tagFallbacks.get(slug);
      if (fb === undefined) {
        fb = { name, slug, url: '', posts: [] };
        fb.link = { name, slug, url: '' };
        tagFallbacks.set(slug, fb);
      }
      return fb;
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Cards and pages, built once each and reused by every list that shows them.
  const cardOf = (s) => {
    let card = s.card;
    if (card === undefined) {
      const tagList = [];
      for (let k = 0; k < s.tagRefs.length; k++) tagList.push(s.tagRefs[k].link);
      card = {
        title: s.data.title,
        url: s.url,
        date: s.data.date ?? '',
        date_long: s.data.date === undefined ? '' : longDate(s.data.date, dateCache),
        summary: s.data.summary ?? '',
        excerpt: s.excerpt,
        reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
        tags: tagList,
      };
      s.card = card;
    }
    return card;
  };
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date, dateCache) });
  const pageOf = (s) => {
    let page = s.page;
    if (page === undefined) {
      const card = cardOf(s);
      const toc = s.toc;
      page = {
        title: card.title,
        url: card.url,
        date: card.date,
        date_long: card.date_long,
        summary: card.summary,
        excerpt: card.excerpt,
        reading_minutes: card.reading_minutes,
        tags: card.tags,
        slug: s.slug,
        content: s.html,
        toc,
        newer: linkOf(s.newer ?? null),
        older: linkOf(s.older ?? null),
        is_post: s.post,
      };
      s.page = page;
    }
    return page;
  };

  // 7. Layouts: every page through its layout, the index and tag pages.
  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = [];
  for (let k = 0; k < tags.length; k++) {
    const t = tags[k];
    allTags.push({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length });
  }
  const recent = [];
  const recentCount = input.site.recent;
  for (let k = 0; k < posts.length && k < recentCount; k++) recent.push(cardOf(posts[k]));
  const rootVars = (extra) => {
    if (extra === null) return { site, tags: allTags, recent };
    if ('page' in extra) return { site, tags: allTags, recent, page: extra.page };
    if ('posts' in extra) return { site, tags: allTags, recent, posts: extra.posts, pager: extra.pager };
    return { site, tags: allTags, recent, tag: extra.tag };
  };
  for (let k = 0; k < kept.length; k++) {
    const s = kept[k];
    output[s.outDir + '/index.html'] = render(s.layout, rootVars({ page: pageOf(s) }));
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? base + '/' : base + '/page/' + k + '/');
  for (let k = 1; k <= pages; k++) {
    const list = [];
    const start = (k - 1) * per;
    const end = Math.min(start + per, posts.length);
    for (let j = start; j < end; j++) list.push(cardOf(posts[j]));
    const html = render('index', rootVars({
      posts: list,
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    }));
    if (html !== null) output[k === 1 ? 'index.html' : 'page/' + k + '/index.html'] = html;
  }
  for (let k = 0; k < tags.length; k++) {
    const t = tags[k];
    const list = [];
    for (let j = 0; j < t.posts.length; j++) list.push(cardOf(t.posts[j]));
    const html = render('tag', rootVars({ tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: list } }));
    if (html !== null) output['tags/' + t.slug + '/index.html'] = html;
  }
  const tagsHtml = render('tags', rootVars(null));
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (let k = 0; k < statics.length; k++) {
    const f = statics[k];
    if (hasOwn(output, f.path)) report.push('shadowed ' + f.path + ': a built page has its path');
    else output[f.path] = f.content;
  }

  // 8. The report: every line reported above and each broken link, sorted,
  //    then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  let pageCount = 0;
  for (let k = 0; k < kept.length; k++) if (!kept[k].post) pageCount++;
  lines.push('built ' + pageCount + ' pages, ' + posts.length + ' posts, ' + tags.length + ' tags and ' + statics.length + ' static files');
  output[REPORT_FILE] = lines.join('\n') + '\n';
  return output;
}

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  return build(input);
}
