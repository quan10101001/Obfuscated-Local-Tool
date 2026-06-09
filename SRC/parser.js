'use strict';

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
  }

  peek(o = 0) { return this.tokens[Math.min(this.pos + o, this.tokens.length - 1)]; }
  consume() { return this.tokens[this.pos++]; }

  check(type, val) {
    const t = this.peek();
    if (val !== undefined) return t.type === type && t.value === val;
    return t.type === type;
  }

  match(type, val) {
    if (this.check(type, val)) return this.consume();
    return null;
  }

  expect(type, val) {
    const t = this.peek();
    if (val !== undefined ? (t.type !== type || t.value !== val) : t.type !== type) {
      throw new Error(`Parse error at line ${t.line}: expected ${type}${val ? ' "'+val+'"' : ''}, got ${t.type} "${t.value}"`);
    }
    return this.consume();
  }

  isEnd() {
    const t = this.peek();
    if (t.type === 'EOF') return true;
    if (t.type === 'Keyword') return ['end','else','elseif','until'].includes(t.value);
    return false;
  }

  parseBlock() {
    const stmts = [];
    while (!this.isEnd()) {
      try {
        const s = this.parseStmt();
        if (s) stmts.push(s);
        this.match('Punc', ';');
      } catch(e) {
        // Skip to next line on parse error
        const line = this.peek().line;
        while (!this.isEnd() && this.peek().line === line && this.peek().type !== 'EOF') this.consume();
        this.match('Punc', ';');
      }
    }
    return { type: 'Block', body: stmts };
  }

  parseStmt() {
    const t = this.peek();
    if (t.type === 'Keyword') {
      switch (t.value) {
        case 'local': return this.parseLocal();
        case 'if': return this.parseIf();
        case 'while': return this.parseWhile();
        case 'for': return this.parseFor();
        case 'do': return this.parseDo();
        case 'repeat': return this.parseRepeat();
        case 'return': return this.parseReturn();
        case 'break': this.consume(); return { type: 'Break' };
        case 'continue': this.consume(); return { type: 'Continue' };
        case 'function': return this.parseFuncStmt();
        case 'goto': this.consume(); return { type: 'Goto', label: this.expect('Ident').value };
        case 'type': this.consume(); this.skipTypeDecl(); return null;
      }
    }
    if (t.type === 'Punc' && t.value === '::') {
      this.consume();
      const name = this.expect('Ident').value;
      this.expect('Punc', '::');
      return { type: 'Label', name };
    }
    return this.parseExprStmt();
  }

  skipTypeDecl() {
    // skip `TypeName = ...` Luau type declaration
    if (this.check('Ident')) this.consume();
    if (this.match('Punc', '=')) {
      let depth = 0;
      while (!this.isEnd() && this.peek().type !== 'EOF') {
        const v = this.peek().value;
        if (v === '(' || v === '{' || v === '[') depth++;
        if (v === ')' || v === '}' || v === ']') { if (depth === 0) break; depth--; }
        if (depth === 0 && this.peek().type === 'Keyword') break;
        this.consume();
      }
    }
  }

  skipTypeAnnotation() {
    // skip `: Type` Luau type annotation
    if (!this.check('Punc', ':')) return;
    this.consume();
    let depth = 0;
    while (!this.isEnd() && this.peek().type !== 'EOF') {
      const t = this.peek();
      const v = t.value;
      if (v === '(' || v === '{' || v === '[') depth++;
      if (v === ')' || v === '}' || v === ']') { if (depth === 0) break; depth--; }
      if (depth === 0) {
        if (v === ',' || v === ')' || v === '=' || v === ';') break;
        if (t.type === 'Keyword' && ['then','do','end','else','until','in','and','or','not','return'].includes(v)) break;
      }
      this.consume();
    }
  }

  parseLocal() {
    this.expect('Keyword', 'local');
    if (this.check('Keyword', 'function')) {
      this.consume();
      const name = this.expect('Ident').value;
      const func = this.parseFuncBody();
      return { type: 'LocalFunc', name, func };
    }
    const names = [this.expect('Ident').value];
    this.skipTypeAnnotation();
    while (this.match('Punc', ',')) {
      names.push(this.expect('Ident').value);
      this.skipTypeAnnotation();
    }
    // skip return type
    if (this.check('Punc', ':') && !this.check('Punc', '::')) this.skipTypeAnnotation();
    let values = [];
    if (this.match('Punc', '=')) values = this.parseExprList();
    return { type: 'LocalDecl', names, values };
  }

  parseIf() {
    this.expect('Keyword', 'if');
    const cond = this.parseExpr();
    this.expect('Keyword', 'then');
    const body = this.parseBlock();
    const elseifs = [];
    while (this.check('Keyword', 'elseif')) {
      this.consume();
      const ec = this.parseExpr();
      this.expect('Keyword', 'then');
      const eb = this.parseBlock();
      elseifs.push({ cond: ec, body: eb });
    }
    let alt = null;
    if (this.match('Keyword', 'else')) alt = this.parseBlock();
    this.expect('Keyword', 'end');
    return { type: 'If', cond, body, elseifs, alt };
  }

  parseWhile() {
    this.expect('Keyword', 'while');
    const cond = this.parseExpr();
    this.expect('Keyword', 'do');
    const body = this.parseBlock();
    this.expect('Keyword', 'end');
    return { type: 'While', cond, body };
  }

  parseFor() {
    this.expect('Keyword', 'for');
    const firstName = this.expect('Ident').value;
    if (this.match('Punc', '=')) {
      const start = this.parseExpr();
      this.expect('Punc', ',');
      const limit = this.parseExpr();
      let step = null;
      if (this.match('Punc', ',')) step = this.parseExpr();
      this.expect('Keyword', 'do');
      const body = this.parseBlock();
      this.expect('Keyword', 'end');
      return { type: 'NumFor', name: firstName, start, limit, step, body };
    }
    const names = [firstName];
    while (this.match('Punc', ',')) names.push(this.expect('Ident').value);
    this.expect('Keyword', 'in');
    const iters = this.parseExprList();
    this.expect('Keyword', 'do');
    const body = this.parseBlock();
    this.expect('Keyword', 'end');
    return { type: 'GenFor', names, iters, body };
  }

  parseDo() {
    this.expect('Keyword', 'do');
    const body = this.parseBlock();
    this.expect('Keyword', 'end');
    return { type: 'Do', body };
  }

  parseRepeat() {
    this.expect('Keyword', 'repeat');
    const body = this.parseBlock();
    this.expect('Keyword', 'until');
    const cond = this.parseExpr();
    return { type: 'Repeat', body, cond };
  }

  parseReturn() {
    this.expect('Keyword', 'return');
    let vals = [];
    if (!this.isEnd() && !this.check('Punc', ';')) vals = this.parseExprList();
    this.match('Punc', ';');
    return { type: 'Return', vals };
  }

  parseFuncStmt() {
    this.expect('Keyword', 'function');
    let name = this.expect('Ident').value;
    const fields = [];
    let method = null;
    while (this.match('Punc', '.')) fields.push(this.expect('Ident').value);
    if (this.match('Punc', ':')) method = this.expect('Ident').value;
    const func = this.parseFuncBody(method !== null);
    return { type: 'FuncDecl', name, fields, method, func };
  }

  parseFuncBody(hasSelf = false) {
    this.expect('Punc', '(');
    const params = hasSelf ? ['self'] : [];
    let vararg = false;
    if (!this.check('Punc', ')')) {
      if (this.check('Punc', '...')) { this.consume(); vararg = true; }
      else {
        params.push(this.expect('Ident').value);
        this.skipTypeAnnotation();
        while (this.match('Punc', ',') && !this.check('Punc', '...')) {
          if (this.check('Punc', '...')) { this.consume(); vararg = true; break; }
          params.push(this.expect('Ident').value);
          this.skipTypeAnnotation();
        }
        if (!vararg && this.check('Punc', '...')) { this.consume(); vararg = true; }
      }
    }
    this.expect('Punc', ')');
    // skip return type annotation
    if (this.check('Punc', ':') && !this.check('Punc', '::')) this.skipTypeAnnotation();
    const body = this.parseBlock();
    this.expect('Keyword', 'end');
    return { type: 'Func', params, vararg, body };
  }

  parseExprStmt() {
    const expr = this.parseSuffixExpr();
    // Check compound assignment (Luau)
    const compOps = ['+=','-=','*=','/=','//=','%=','^=','..=','|=','&='];
    for (const op of compOps) {
      if (this.check('Op', op)) {
        this.consume();
        const val = this.parseExpr();
        return { type: 'CompoundAssign', target: expr, op: op.slice(0,-1), val };
      }
    }
    // Multi-assignment
    if (this.check('Punc', ',') || this.check('Punc', '=')) {
      const targets = [expr];
      while (this.match('Punc', ',')) targets.push(this.parseSuffixExpr());
      this.expect('Punc', '=');
      const vals = this.parseExprList();
      return { type: 'Assign', targets, vals };
    }
    if (expr.type === 'Call' || expr.type === 'MethodCall') return { type: 'ExprStmt', expr };
    // Try to recover
    return { type: 'ExprStmt', expr };
  }

  parseSuffixExpr() {
    let e = this.parsePrimary();
    while (true) {
      const t = this.peek();
      if (t.type === 'Punc' && t.value === '.') {
        this.consume();
        const f = this.expect('Ident').value;
        e = { type: 'Field', obj: e, field: f };
      } else if (t.type === 'Punc' && t.value === '[') {
        this.consume();
        const idx = this.parseExpr();
        this.expect('Punc', ']');
        e = { type: 'Index', obj: e, idx };
      } else if (t.type === 'Punc' && t.value === ':') {
        this.consume();
        const m = this.expect('Ident').value;
        const args = this.parseCallArgs();
        e = { type: 'MethodCall', obj: e, method: m, args };
      } else if (t.type === 'Punc' && (t.value === '(' || t.value === '{') || t.type === 'String') {
        const args = this.parseCallArgs();
        e = { type: 'Call', func: e, args };
      } else break;
    }
    return e;
  }

  parsePrimary() {
    const t = this.peek();
    if (t.type === 'Ident') { this.consume(); return { type: 'Ident', name: t.value }; }
    if (t.type === 'Punc' && t.value === '(') {
      this.consume();
      const e = this.parseExpr();
      this.expect('Punc', ')');
      return { type: 'Paren', expr: e };
    }
    throw new Error(`Expected primary at line ${t.line}: ${t.type} "${t.value}"`);
  }

  parseCallArgs() {
    const t = this.peek();
    if (t.type === 'Punc' && t.value === '(') {
      this.consume();
      if (this.check('Punc', ')')) { this.consume(); return []; }
      const args = this.parseExprList();
      this.expect('Punc', ')');
      return args;
    }
    if (t.type === 'Punc' && t.value === '{') return [this.parseTableCtor()];
    if (t.type === 'String') { this.consume(); return [{ type: 'Str', value: t.value }]; }
    throw new Error(`Expected call args at line ${t.line}`);
  }

  parseExprList() {
    const list = [this.parseExpr()];
    while (this.match('Punc', ',')) list.push(this.parseExpr());
    return list;
  }

  BINOP_PREC = {
    'or': [1,false], 'and': [2,false],
    '<': [3,false], '>': [3,false], '<=': [3,false], '>=': [3,false],
    '~=': [3,false], '==': [3,false],
    '|': [4,false], '~': [5,false], '&': [6,false],
    '<<': [7,false], '>>': [7,false],
    '..': [8,true],
    '+': [9,false], '-': [9,false],
    '*': [10,false], '/': [10,false], '//': [10,false], '%': [10,false],
    '^': [12,true],
  };

  getBinOp() {
    const t = this.peek();
    if (t.type === 'Keyword' && (t.value === 'and' || t.value === 'or')) return t.value;
    if (t.type === 'Op' && this.BINOP_PREC[t.value]) return t.value;
    return null;
  }

  parseExpr() { return this.parseBin(0); }

  parseBin(minP) {
    let left = this.parseUnary();
    while (true) {
      const op = this.getBinOp();
      if (!op) break;
      const [prec, right] = this.BINOP_PREC[op];
      if (prec < minP) break;
      this.consume();
      const rhs = this.parseBin(right ? prec : prec + 1);
      left = { type: 'Bin', op, left, right: rhs };
    }
    return left;
  }

  parseUnary() {
    const t = this.peek();
    if (t.type === 'Op' && t.value === '-') { this.consume(); return { type: 'Unary', op: '-', expr: this.parseUnary() }; }
    if (t.type === 'Keyword' && t.value === 'not') { this.consume(); return { type: 'Unary', op: 'not', expr: this.parseUnary() }; }
    if (t.type === 'Op' && t.value === '#') { this.consume(); return { type: 'Unary', op: '#', expr: this.parseUnary() }; }
    if (t.type === 'Op' && t.value === '~') { this.consume(); return { type: 'Unary', op: '~', expr: this.parseUnary() }; }
    return this.parseSimple();
  }

  parseSimple() {
    const t = this.peek();
    if (t.type === 'Number') { this.consume(); return { type: 'Num', value: t.value }; }
    if (t.type === 'String') { this.consume(); return { type: 'Str', value: t.value }; }
    if (t.type === 'Keyword' && t.value === 'true') { this.consume(); return { type: 'Bool', value: true }; }
    if (t.type === 'Keyword' && t.value === 'false') { this.consume(); return { type: 'Bool', value: false }; }
    if (t.type === 'Keyword' && t.value === 'nil') { this.consume(); return { type: 'Nil' }; }
    if (t.type === 'Punc' && t.value === '...') { this.consume(); return { type: 'Vararg' }; }
    if (t.type === 'Keyword' && t.value === 'function') { this.consume(); return this.parseFuncBody(); }
    if (t.type === 'Punc' && t.value === '{') return this.parseTableCtor();
    return this.parseSuffixExpr();
  }

  parseTableCtor() {
    this.expect('Punc', '{');
    const fields = [];
    while (!this.check('Punc', '}')) {
      if (this.check('Punc', '[')) {
        this.consume();
        const k = this.parseExpr();
        this.expect('Punc', ']');
        this.expect('Punc', '=');
        const v = this.parseExpr();
        fields.push({ type: 'KV', key: k, val: v });
      } else if (this.check('Ident') && this.peek(1).type === 'Punc' && this.peek(1).value === '=') {
        const k = this.consume().value;
        this.consume();
        const v = this.parseExpr();
        fields.push({ type: 'NV', key: k, val: v });
      } else {
        const v = this.parseExpr();
        fields.push({ type: 'V', val: v });
      }
      if (!this.match('Punc', ',') && !this.match('Punc', ';')) break;
    }
    this.expect('Punc', '}');
    return { type: 'Table', fields };
  }

  parse() {
    const block = this.parseBlock();
    return block;
  }
}

module.exports = { Parser };
