/**
 * Minimal s-expression reader/printer for the Slynk wire protocol.
 *
 * Supports: symbols (optionally package-qualified), keywords, strings, integers,
 * floats, ratios (read as string), lists, dotted pairs, quote sugar, t / nil.
 * `#<...>` (unreadable object) and `#\<name>` (character) are preserved as
 * opaque `Lit` tokens that round-trip on `print`. Other `#`-dispatch macros are
 * consumed as best-effort opaque tokens. Comments are skipped.
 */

export class Sym {
  constructor(public readonly name: string) {}
  toString(): string {
    return this.name;
  }
}

export class Keyword {
  constructor(public readonly name: string) {}
  toString(): string {
    return ":" + this.name;
  }
}

/** A cons pair whose cdr is not a list — `(a . b)`. Rare but Slynk uses it. */
export class Cons {
  constructor(public readonly car: Sexp, public readonly cdr: Sexp) {}
}

/** Opaque token preserved verbatim from the wire (e.g. `#<FUNCTION FOO>`). */
export class Lit {
  constructor(public readonly content: string) {}
  toString(): string {
    return this.content;
  }
}

export type Sexp =
  | number
  | bigint
  | string
  | boolean
  | null
  | Sym
  | Keyword
  | Cons
  | Lit
  | Sexp[];

export const NIL: Sexp[] = [];
export const T = new Sym("t");

export function sym(name: string): Sym {
  return new Sym(name);
}

export function kw(name: string): Keyword {
  return new Keyword(name);
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

class Reader {
  pos = 0;
  constructor(public readonly src: string) {}

  peek(): string {
    return this.src[this.pos] ?? "";
  }
  next(): string {
    return this.src[this.pos++] ?? "";
  }
  eof(): boolean {
    return this.pos >= this.src.length;
  }

  skipWs(): void {
    while (!this.eof()) {
      const c = this.peek();
      if (" \t\n\r".includes(c)) {
        this.pos++;
      } else if (c === ";") {
        while (!this.eof() && this.next() !== "\n") { /* skip */ }
      } else {
        break;
      }
    }
  }

  readSexp(): Sexp {
    this.skipWs();
    if (this.eof()) throw new Error("Unexpected EOF");
    const c = this.peek();
    if (c === "(") return this.readList();
    if (c === '"') return this.readString();
    if (c === "'") {
      this.pos++;
      return [sym("quote"), this.readSexp()];
    }
    if (c === ")") throw new Error(`Unexpected ')' at ${this.pos}`);
    if (c === "#") return this.readSharp();
    return this.readAtom();
  }

  /**
   * Handle `#`-dispatch macros. Slynk doesn't emit these often (most
   * unreadables arrive wrapped in strings), but inspector/describe output
   * occasionally contains a bare `#<…>` or `#\<name>`. We preserve them as
   * `Lit` tokens so the frame parses and round-trips.
   */
  readSharp(): Sexp {
    this.pos++; // consume #
    if (this.eof()) throw new Error("Unexpected EOF after #");
    const c = this.next();
    if (c === "<") {
      // #<...>: opaque object representation. Scan to matching '>'. Slynk
      // doesn't nest these; a flat scan is sufficient.
      let body = "#<";
      while (!this.eof()) {
        const ch = this.next();
        body += ch;
        if (ch === ">") return new Lit(body);
      }
      throw new Error("Unterminated #< form");
    }
    if (c === "\\") {
      // #\<char> or #\<name> (e.g. #\Space, #\Newline). Read at least one char,
      // then continue with alphanumerics to capture named characters.
      if (this.eof()) throw new Error("Unexpected EOF after #\\");
      let body = "#\\" + this.next();
      while (!this.eof() && /[A-Za-z0-9-]/.test(this.peek())) body += this.next();
      return new Lit(body);
    }
    // Unrecognized dispatch macro — consume as an opaque token to the next
    // whitespace or list terminator. Best effort.
    let body = "#" + c;
    while (!this.eof() && !"()\"' \t\n\r".includes(this.peek())) {
      body += this.next();
    }
    return new Lit(body);
  }

  readList(): Sexp {
    this.pos++; // consume (
    const items: Sexp[] = [];
    let dottedTail: Sexp | undefined;
    while (true) {
      this.skipWs();
      if (this.eof()) throw new Error("Unterminated list");
      if (this.peek() === ")") {
        this.pos++;
        break;
      }
      // Detect ` . ` (dotted pair) — must have spaces on both sides per CL.
      if (this.peek() === "." && " \t\n".includes(this.src[this.pos + 1])) {
        this.pos++;
        this.skipWs();
        dottedTail = this.readSexp();
        this.skipWs();
        if (this.next() !== ")") throw new Error("Expected ')' after dotted tail");
        break;
      }
      items.push(this.readSexp());
    }
    if (dottedTail === undefined) return items;
    if (items.length === 0) return dottedTail; // ( . x ) → x, shouldn't occur
    return foldDotted(items, dottedTail);
  }

  readString(): string {
    this.pos++; // consume "
    let out = "";
    while (true) {
      if (this.eof()) throw new Error("Unterminated string");
      const c = this.next();
      if (c === '"') return out;
      out += c === "\\" ? this.next() : c;
    }
  }

  readAtom(): Sexp {
    let tok = "";
    while (!this.eof()) {
      const c = this.peek();
      if ("()\"' \t\n\r".includes(c)) {
        break;
      }
      tok += this.next();
    }
    if (tok.length === 0) throw new Error(`Empty atom at ${this.pos}`);
    return parseAtom(tok);
  }
}

function foldDotted(items: Sexp[], tail: Sexp): Sexp {
  // Build a proper list when possible; fall back to Cons chain for true dots.
  if (Array.isArray(tail)) return items.concat(tail);
  return items.reduceRight<Sexp>((acc, item) => new Cons(item, acc), tail);
}

function parseAtom(tok: string): Sexp {
  if (tok[0] === ":") return new Keyword(tok.slice(1).toLowerCase());

  // Integer (must check before lowercasing — BigInt rejects lowercase hex)
  if (/^-?\d+$/.test(tok)) {
    const n = Number(tok);
    if (Number.isSafeInteger(n)) return n;
    return BigInt(tok);
  }
  // Float
  if (/^-?\d+\.\d*([eE][+-]?\d+)?$/.test(tok) || /^-?\d+[eE][+-]?\d+$/.test(tok)) {
    return Number(tok);
  }

  const lower = tok.toLowerCase();
  if (lower === "nil") return NIL;
  if (lower === "t") return T;
  return new Sym(lower);
}

export function read(src: string): Sexp {
  const r = new Reader(src);
  const v = r.readSexp();
  r.skipWs();
  if (!r.eof()) throw new Error(`Trailing data at ${r.pos}: ${r.src.slice(r.pos)}`);
  return v;
}

// ---------------------------------------------------------------------------
// Printer
// ---------------------------------------------------------------------------

export function print(s: Sexp): string {
  if (s === null) return "nil";
  if (typeof s === "boolean") return s ? "t" : "nil";
  if (typeof s === "number" || typeof s === "bigint") return s.toString();
  if (typeof s === "string") return printString(s);
  if (s instanceof Sym) return s.name;
  if (s instanceof Keyword) return ":" + s.name;
  if (s instanceof Cons) return "(" + print(s.car) + " . " + print(s.cdr) + ")";
  if (s instanceof Lit) return s.content;
  if (Array.isArray(s)) {
    if (s.length === 0) return "nil";
    return "(" + s.map(print).join(" ") + ")";
  }
  throw new Error(`Cannot print: ${typeof s}`);
}

function printString(s: string): string {
  let out = '"';
  for (const ch of s) {
    if (ch === "\\" || ch === '"') out += "\\" + ch;
    else out += ch;
  }
  return out + '"';
}

// ---------------------------------------------------------------------------
// Convenience accessors (Slynk responses are deeply nested s-exprs)
// ---------------------------------------------------------------------------

export function isList(s: Sexp): s is Sexp[] {
  return Array.isArray(s);
}

export function isSym(s: Sexp, name?: string): s is Sym {
  if (!(s instanceof Sym)) return false;
  return name === undefined || s.name === name.toLowerCase();
}

export function isKw(s: Sexp, name?: string): s is Keyword {
  if (!(s instanceof Keyword)) return false;
  return name === undefined || s.name === name.toLowerCase();
}

/** Return s if it's a list, else throw with a message including label. */
export function asList(s: Sexp, label = "value"): Sexp[] {
  if (!Array.isArray(s)) throw new Error(`Expected list for ${label}, got ${print(s)}`);
  return s;
}

export function asString(s: Sexp, label = "value"): string {
  if (typeof s !== "string") throw new Error(`Expected string for ${label}, got ${print(s)}`);
  return s;
}

export function asNumber(s: Sexp, label = "value"): number {
  if (typeof s !== "number") throw new Error(`Expected number for ${label}, got ${print(s)}`);
  return s;
}

/** Coerce a Sexp to a string for display. Uses fallback when the value is nil/undefined. */
export function str(s: Sexp, fallback = ""): string {
  if (typeof s === "string") return s;
  const v = print(s);
  return v === "nil" ? fallback : v;
}

/** Return the name if `s` is a Sym or Keyword, otherwise undefined. */
export function tagName(s: Sexp): string | undefined {
  if (s instanceof Sym) return s.name;
  if (s instanceof Keyword) return s.name;
  return undefined;
}
