'use strict';

const KEYWORDS = new Set([
  'and','break','do','else','elseif','end','false','for','function',
  'goto','if','in','local','nil','not','or','repeat','return','then',
  'true','until','while','continue','export','type'
]);

class Lexer {
  constructor(source) {
    this.src = source;
    this.pos = 0;
    this.line = 1;
    this.tokens = [];
  }

  ch(o = 0) { return this.src[this.pos + o] || ''; }

  adv() {
    const c = this.src[this.pos++];
    if (c === '\n') this.line++;
    return c;
  }

  match(c) {
    if (this.src[this.pos] === c) { this.pos++; return true; }
    return false;
  }

  skipWS() {
    while (this.pos < this.src.length) {
      const c = this.ch();
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { this.adv(); continue; }
      if (c === '-' && this.ch(1) === '-') {
        this.pos += 2;
        if (this.ch() === '[') {
          const saved = this.pos;
          this.pos++;
          let lv = 0;
          while (this.ch() === '=') { lv++; this.pos++; }
          if (this.ch() === '[') {
            this.pos++;
            const close = ']' + '='.repeat(lv) + ']';
            const end = this.src.indexOf(close, this.pos);
            if (end >= 0) {
              for (let i = this.pos; i < end; i++) if (this.src[i] === '\n') this.line++;
              this.pos = end + close.length;
            } else this.pos = this.src.length;
            continue;
          }
          this.pos = saved;
        }
        while (this.pos < this.src.length && this.ch() !== '\n') this.pos++;
        continue;
      }
      break;
    }
  }

  readStr(q) {
    let v = '';
    while (this.pos < this.src.length) {
      const c = this.adv();
      if (c === q) break;
      if (c === '\\') {
        const e = this.adv();
        const esc = { n:'\n',t:'\t',r:'\r','\\':'\\','"':'"',"'":"'", a:'\x07',b:'\b',f:'\f',v:'\v' };
        if (esc[e] !== undefined) v += esc[e];
        else if (e >= '0' && e <= '9') {
          let num = e;
          if (this.ch() >= '0' && this.ch() <= '9') num += this.adv();
          if (this.ch() >= '0' && this.ch() <= '9') num += this.adv();
          v += String.fromCharCode(parseInt(num));
        } else if (e === 'x') {
          const h = this.adv() + this.adv();
          v += String.fromCharCode(parseInt(h, 16));
        } else v += e;
      } else v += c;
    }
    return v;
  }

  readLongStr() {
    let lv = 0;
    while (this.ch() === '=') { lv++; this.pos++; }
    if (this.ch() !== '[') return null;
    this.pos++;
    if (this.ch() === '\n') this.adv();
    else if (this.ch() === '\r') { this.adv(); if (this.ch() === '\n') this.adv(); }
    const close = ']' + '='.repeat(lv) + ']';
    let v = '';
    while (this.pos < this.src.length) {
      if (this.ch() === ']') {
        if (this.src.substr(this.pos, close.length) === close) {
          this.pos += close.length; return v;
        }
      }
      const c = this.adv();
      v += c;
    }
    return v;
  }

  readNum() {
    let v = '';
    if (this.ch() === '0' && (this.ch(1) === 'x' || this.ch(1) === 'X')) {
      v += this.adv() + this.adv();
      while (/[0-9a-fA-F_]/.test(this.ch())) { const c = this.adv(); if (c !== '_') v += c; }
      if (this.ch() === '.') {
        v += this.adv();
        while (/[0-9a-fA-F_]/.test(this.ch())) { const c = this.adv(); if (c !== '_') v += c; }
      }
      if (this.ch() === 'p' || this.ch() === 'P') {
        v += this.adv();
        if (this.ch() === '+' || this.ch() === '-') v += this.adv();
        while (/[0-9]/.test(this.ch())) v += this.adv();
      }
      return parseFloat(v);
    }
    while (/[0-9_]/.test(this.ch())) { const c = this.adv(); if (c !== '_') v += c; }
    if (this.ch() === '.' && /[0-9]/.test(this.ch(1))) {
      v += this.adv();
      while (/[0-9_]/.test(this.ch())) { const c = this.adv(); if (c !== '_') v += c; }
    }
    if (this.ch() === 'e' || this.ch() === 'E') {
      v += this.adv();
      if (this.ch() === '+' || this.ch() === '-') v += this.adv();
      while (/[0-9]/.test(this.ch())) v += this.adv();
    }
    return parseFloat(v);
  }

  tokenize() {
    while (this.pos < this.src.length) {
      this.skipWS();
      if (this.pos >= this.src.length) break;
      const line = this.line;
      const c = this.ch();
      const tok = t => this.tokens.push({ ...t, line });

      if (c === '"' || c === "'") {
        this.adv(); tok({ type: 'String', value: this.readStr(c) }); continue;
      }
      if (c === '[' && (this.ch(1) === '[' || this.ch(1) === '=')) {
        const sp = this.pos; const sl = this.line;
        this.pos++;
        const v = this.readLongStr();
        if (v !== null) { tok({ type: 'String', value: v }); continue; }
        this.pos = sp; this.line = sl;
      }
      if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(this.ch(1)))) {
        tok({ type: 'Number', value: this.readNum() }); continue;
      }
      if (/[a-zA-Z_]/.test(c)) {
        let name = '';
        while (/[a-zA-Z0-9_]/.test(this.ch())) name += this.adv();
        tok(KEYWORDS.has(name) ? { type: 'Keyword', value: name } : { type: 'Ident', value: name });
        continue;
      }
      this.adv();
      switch (c) {
        case '+': tok({ type:'Op', value:'+' }); break;
        case '*': tok({ type:'Op', value:'*' }); break;
        case '%': tok({ type:'Op', value:'%' }); break;
        case '^': tok({ type:'Op', value:'^' }); break;
        case '#': tok({ type:'Op', value:'#' }); break;
        case '&': tok({ type:'Op', value:'&' }); break;
        case '|': tok({ type:'Op', value:'|' }); break;
        case '(': tok({ type:'Punc', value:'(' }); break;
        case ')': tok({ type:'Punc', value:')' }); break;
        case '{': tok({ type:'Punc', value:'{' }); break;
        case '}': tok({ type:'Punc', value:'}' }); break;
        case ']': tok({ type:'Punc', value:']' }); break;
        case ';': tok({ type:'Punc', value:';' }); break;
        case ',': tok({ type:'Punc', value:',' }); break;
        case '-': tok({ type:'Op', value:'-' }); break;
        case '/': tok({ type:'Op', value: this.match('/')? '//' : '/' }); break;
        case '~': tok({ type: this.match('=')? 'Op':'Op', value: this.src[this.pos-1]==='='? '~=':'~' }); break;
        case '<': tok({ type:'Op', value: this.match('<')? '<<' : this.match('=')? '<=' : '<' }); break;
        case '>': tok({ type:'Op', value: this.match('>')? '>>' : this.match('=')? '>=' : '>' }); break;
        case '=': tok(this.match('=')? {type:'Op',value:'=='} : {type:'Punc',value:'='}); break;
        case '.':
          if (this.match('.')) tok(this.match('.')? {type:'Punc',value:'...'} : {type:'Op',value:'..'});
          else tok({type:'Punc',value:'.'}); break;
        case ':': tok(this.match(':')? {type:'Punc',value:'::'} : {type:'Punc',value:':'}); break;
        case '[': tok({type:'Punc',value:'['}); break;
        default: break;
      }
      // Fix the ~ issue
      if (this.tokens.length > 0) {
        const last = this.tokens[this.tokens.length - 1];
        if (last.value === undefined) this.tokens.pop();
      }
    }
    this.tokens.push({ type: 'EOF', value: null, line: this.line });
    // Fix ~ tokenization
    for (const t of this.tokens) {
      if (t.type === 'Op' && t.value === undefined) t.value = '~';
    }
    return this.tokens;
  }
}

module.exports = { Lexer };
