// Reads a WoW SavedVariables file: Lua assignments of plain data, as the client writes
// them on logout or /reload.
//
//   AuctionLensDB = {
//   ["schema"] = 3,
//   ["markets"] = {
//   ...
//   {
//   "a", -- [1]
//   },
//   }
//
// Only data is accepted (tables, strings, numbers, booleans, nil) - nothing is ever
// executed. Tables become plain objects; positional entries get the keys 1, 2, 3...
// as Lua numbers them.
//
// Pass the file decoded as UTF-8, which is how the client writes text: both companions
// do, so a realm name with an accent is the same market key whichever uploaded it, and
// it goes back into the guild data file (also UTF-8) unchanged. A "\ddd" escape becomes
// the character with that code, which only matters for bytes the client escaped.

export function parseSavedVariables(text) {
    const p = new Parser(text);
    const out = {};
    p.ws();
    while (!p.eof()) {
        const name = p.name();
        p.ws();
        p.expect(61); // =
        p.ws();
        out[name] = p.value();
        p.ws();
        if (p.peek() === 59) { p.i++; p.ws(); } // optional ;
    }
    return out;
}

class Parser {
    constructor(s) {
        this.s = s;
        this.i = 0;
    }
    eof() { return this.i >= this.s.length; }
    peek() { return this.s.charCodeAt(this.i); }
    fail(msg) {
        const line = this.s.slice(0, this.i).split("\n").length;
        throw new Error(`SavedVariables line ${line}: ${msg}`);
    }
    expect(c) {
        if (this.peek() !== c) this.fail(`expected '${String.fromCharCode(c)}'`);
        this.i++;
    }
    // Whitespace and comments ("-- [1]" after positional entries).
    ws() {
        const s = this.s;
        for (;;) {
            const c = s.charCodeAt(this.i);
            if (c === 32 || c === 9 || c === 10 || c === 13) { this.i++; continue; }
            if (c === 45 && s.charCodeAt(this.i + 1) === 45) {
                if (s.startsWith("[[", this.i + 2)) {
                    const end = s.indexOf("]]", this.i + 4);
                    this.i = end < 0 ? s.length : end + 2;
                } else {
                    const nl = s.indexOf("\n", this.i);
                    this.i = nl < 0 ? s.length : nl + 1;
                }
                continue;
            }
            return;
        }
    }
    name() {
        const m = /[A-Za-z_][A-Za-z0-9_]*/y;
        m.lastIndex = this.i;
        const r = m.exec(this.s);
        if (!r) this.fail("expected a name");
        this.i = m.lastIndex;
        return r[0];
    }
    value() {
        const c = this.peek();
        if (c === 123) return this.table();
        if (c === 34 || c === 39) return this.string();
        if (c === 91 && (this.s[this.i + 1] === "[" || this.s[this.i + 1] === "=")) return this.longString();
        const word = /true|false|nil/y;
        word.lastIndex = this.i;
        const w = word.exec(this.s);
        if (w) {
            this.i = word.lastIndex;
            return w[0] === "true" ? true : w[0] === "false" ? false : null;
        }
        return this.number();
    }
    number() {
        const m = /-?(?:0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?|inf|nan)/y;
        m.lastIndex = this.i;
        const r = m.exec(this.s);
        if (!r) this.fail("expected a value");
        this.i = m.lastIndex;
        const t = r[0];
        if (/inf$/.test(t)) return t[0] === "-" ? -Infinity : Infinity;
        if (/nan$/.test(t)) return NaN;
        if (/0[xX]/.test(t)) return (t[0] === "-" ? -1 : 1) * parseInt(t.replace(/^-/, ""), 16);
        return Number(t);
    }
    string() {
        const s = this.s;
        const q = s.charCodeAt(this.i++);
        let out = "";
        let from = this.i;
        for (;;) {
            if (this.i >= s.length) this.fail("unfinished string");
            const c = s.charCodeAt(this.i);
            if (c === q) {
                out += s.slice(from, this.i);
                this.i++;
                return out;
            }
            if (c === 92) {
                out += s.slice(from, this.i);
                const e = s[this.i + 1];
                this.i += 2;
                if (e === "n") out += "\n";
                else if (e === "t") out += "\t";
                else if (e === "r") out += "\r";
                else if (e === "a") out += "\x07";
                else if (e === "b") out += "\b";
                else if (e === "f") out += "\f";
                else if (e === "v") out += "\v";
                else if (e === "\n") out += "\n";
                else if (e === "\r") { out += "\n"; if (s[this.i] === "\n") this.i++; }
                else if (e >= "0" && e <= "9") {
                    let digits = e;
                    while (digits.length < 3 && s[this.i] >= "0" && s[this.i] <= "9") digits += s[this.i++];
                    out += String.fromCharCode(Number(digits) & 255);
                } else out += e; // \\ \" \' and anything else: the character itself
                from = this.i;
                continue;
            }
            this.i++;
        }
    }
    longString() {
        const m = /\[(=*)\[/y;
        m.lastIndex = this.i;
        const r = m.exec(this.s);
        if (!r) this.fail("bad long string");
        const close = "]" + r[1] + "]";
        let start = m.lastIndex;
        if (this.s[start] === "\r") start++;
        if (this.s[start] === "\n") start++;
        const end = this.s.indexOf(close, start);
        if (end < 0) this.fail("unfinished long string");
        this.i = end + close.length;
        return this.s.slice(start, end);
    }
    table() {
        this.expect(123);
        const t = {};
        let n = 0;
        for (;;) {
            this.ws();
            const c = this.peek();
            if (c === 125) { this.i++; return t; }
            if (c === 91 && this.s[this.i + 1] !== "[" && this.s[this.i + 1] !== "=") {
                this.i++;
                this.ws();
                const key = this.value();
                this.ws();
                this.expect(93); // ]
                this.ws();
                this.expect(61); // =
                this.ws();
                const v = this.value();
                if (v !== null) t[key] = v;
            } else {
                const save = this.i;
                const m = /[A-Za-z_][A-Za-z0-9_]*\s*=(?!=)/y;
                m.lastIndex = this.i;
                if (m.exec(this.s) && !/^(true|false|nil)\b/.test(this.s.slice(save, save + 6))) {
                    const key = this.name();
                    this.ws();
                    this.expect(61);
                    this.ws();
                    const v = this.value();
                    if (v !== null) t[key] = v;
                } else {
                    n++;
                    const v = this.value();
                    if (v !== null) t[n] = v;
                }
            }
            this.ws();
            const sep = this.peek();
            if (sep === 44 || sep === 59) this.i++;
            else if (sep !== 125) this.fail("expected ',' or '}'");
        }
    }
}
