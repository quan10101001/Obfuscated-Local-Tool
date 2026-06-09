'use strict';

// Opcodes
const OP = {
  HALT:0, PUSHK:1, PUSHNIL:2, PUSHTRUE:3, PUSHFALSE:4, PUSHINT:5,
  LOADL:6, STOREL:7, LOADG:8, STOREG:9,
  ADD:10, SUB:11, MUL:12, DIV:13, MOD:14, POW:15, CONCAT:16,
  UNM:17, NOT:18, LEN:19,
  EQ:20, NE:21, LT:22, LE:23, GT:24, GE:25,
  JMP:26, JMPF:27, JMPT:28,
  CALL:29, RET:30,
  NEWTAB:31, GETTAB:32, SETTAB:33,
  POP:34, DUP:35,
  NEWFUNC:36, VARARG:37,
  LOADUV:38, STOREUV:39,
  FORINIT:40, FORSTEP:41,
  BAND:42, BOR:43, BXOR:44, BNOT:45, SHL:46, SHR:47,
  IDIV:48,
  SETLIST:49,
};

const OPNAMES = Object.fromEntries(Object.entries(OP).map(([k,v])=>[v,k]));

class FuncContext {
  constructor(parent = null, params = [], vararg = false) {
    this.parent = parent;
    this.params = params;
    this.vararg = vararg;
    this.instrs = [];
    this.consts = [];
    this.constMap = new Map();
    this.protos = [];
    this.locals = []; // {name, slot, depth}
    this.upvals = []; // {name, parentSlot, isLocal}
    this.scopeDepth = 0;
    this.breaks = []; // patch points for break
    this.continues = []; // patch points for continue
    this.loopStart = -1;

    // Define parameters as locals
    for (const p of params) this.addLocal(p);
    if (vararg) this.addLocal('...'); // vararg marker
  }

  addConst(v) {
    const key = typeof v + ':' + v;
    if (this.constMap.has(key)) return this.constMap.get(key);
    const idx = this.consts.length;
    this.consts.push(v);
    this.constMap.set(key, idx);
    return idx;
  }

  emit(op, ...args) {
    this.instrs.push([op, ...args]);
    return this.instrs.length - 1;
  }

  patch(idx, val) {
    // patch a jump offset
    const instr = this.instrs[idx];
    if (instr[1] === undefined) instr[1] = val;
    else instr[1] = val;
  }

  patchJump(idx) {
    // Set jump target to current position
    const offset = this.instrs.length - idx - 1;
    this.instrs[idx][1] = offset;
  }

  addLocal(name) {
    const slot = this.locals.length;
    this.locals.push({ name, slot, depth: this.scopeDepth });
    return slot;
  }

  enterScope() { this.scopeDepth++; }

  leaveScope() {
    this.scopeDepth--;
    while (this.locals.length > 0 && this.locals[this.locals.length-1].depth > this.scopeDepth) {
      this.locals.pop();
    }
  }

  resolveLocal(name) {
    for (let i = this.locals.length - 1; i >= 0; i--) {
      if (this.locals[i].name === name) return this.locals[i].slot;
    }
    return -1;
  }

  resolveUpval(name) {
    // Check if parent has this local
    if (!this.parent) return -1;
    const slot = this.parent.resolveLocal(name);
    if (slot >= 0) {
      // Check if already captured
      for (let i = 0; i < this.upvals.length; i++) {
        if (this.upvals[i].name === name) return i;
      }
      const uvIdx = this.upvals.length;
      this.upvals.push({ name, parentSlot: slot, isLocal: true });
      return uvIdx;
    }
    // Check parent's upvalues
    const uvIdx = this.parent.resolveUpval(name);
    if (uvIdx >= 0) {
      for (let i = 0; i < this.upvals.length; i++) {
        if (this.upvals[i].name === name) return i;
      }
      const newIdx = this.upvals.length;
      this.upvals.push({ name, parentSlot: uvIdx, isLocal: false });
      return newIdx;
    }
    return -1;
  }

  toProto() {
    return {
      instrs: this.instrs,
      consts: this.consts,
      protos: this.protos.map(p => p.toProto()),
      params: this.params.length,
      vararg: this.vararg,
      upvals: this.upvals,
    };
  }
}

class Compiler {
  compileSource(ast) {
    const ctx = new FuncContext(null, [], true);
    this.compileBlock(ast, ctx);
    ctx.emit(OP.RET, 0);
    return ctx.toProto();
  }

  compileBlock(block, ctx) {
    ctx.enterScope();
    for (const stmt of block.body) this.compileStmt(stmt, ctx);
    ctx.leaveScope();
  }

  compileStmt(node, ctx) {
    if (!node) return;
    switch (node.type) {
      case 'LocalDecl': this.compileLocalDecl(node, ctx); break;
      case 'LocalFunc': this.compileLocalFunc(node, ctx); break;
      case 'Assign': this.compileAssign(node, ctx); break;
      case 'CompoundAssign': this.compileCompoundAssign(node, ctx); break;
      case 'ExprStmt': this.compileExpr(node.expr, ctx); ctx.emit(OP.POP); break;
      case 'If': this.compileIf(node, ctx); break;
      case 'While': this.compileWhile(node, ctx); break;
      case 'NumFor': this.compileNumFor(node, ctx); break;
      case 'GenFor': this.compileGenFor(node, ctx); break;
      case 'Do': this.compileDo(node, ctx); break;
      case 'Repeat': this.compileRepeat(node, ctx); break;
      case 'Return': this.compileReturn(node, ctx); break;
      case 'FuncDecl': this.compileFuncDecl(node, ctx); break;
      case 'Break': this.compileBreak(ctx); break;
      case 'Continue': this.compileContinue(ctx); break;
      case 'Label': break; // ignore labels (not fully supported)
      case 'Goto': break;
      default: break;
    }
  }

  compileLocalDecl(node, ctx) {
    const slots = [];
    // Reserve slots first
    for (const name of node.names) slots.push(ctx.addLocal(name));

    // Compile values
    for (let i = 0; i < node.names.length; i++) {
      if (i < node.values.length) {
        this.compileExpr(node.values[i], ctx);
      } else {
        ctx.emit(OP.PUSHNIL);
      }
      ctx.emit(OP.STOREL, slots[i]);
    }
    // Extra values discarded
    for (let i = node.names.length; i < node.values.length; i++) {
      this.compileExpr(node.values[i], ctx);
      ctx.emit(OP.POP);
    }
  }

  compileLocalFunc(node, ctx) {
    const slot = ctx.addLocal(node.name);
    const func = this.compileFuncNode(node.func, ctx);
    const protoIdx = ctx.protos.length;
    ctx.protos.push(func);
    ctx.emit(OP.NEWFUNC, protoIdx, func.upvals ? func.upvals.length : 0);
    // push upvalue slots if needed
    for (const uv of (func.upvals || [])) {
      if (uv.isLocal) ctx.emit(OP.LOADL, uv.parentSlot);
      else ctx.emit(OP.LOADUV, uv.parentSlot);
    }
    ctx.emit(OP.STOREL, slot);
  }

  compileFuncDecl(node, ctx) {
    const func = this.compileFuncNode(node.func, ctx);
    const protoIdx = ctx.protos.length;
    ctx.protos.push(func);
    ctx.emit(OP.NEWFUNC, protoIdx, func.upvals ? func.upvals.length : 0);
    for (const uv of (func.upvals || [])) {
      if (uv.isLocal) ctx.emit(OP.LOADL, uv.parentSlot);
      else ctx.emit(OP.LOADUV, uv.parentSlot);
    }

    // Assign to target
    if (node.fields.length === 0 && !node.method) {
      // simple function name
      const slot = ctx.resolveLocal(node.name);
      if (slot >= 0) ctx.emit(OP.STOREL, slot);
      else {
        const uvIdx = ctx.resolveUpval(node.name);
        if (uvIdx >= 0) ctx.emit(OP.STOREUV, uvIdx);
        else { const ki = ctx.addConst(node.name); ctx.emit(OP.STOREG, ki); }
      }
    } else {
      // a.b.c = func or a:method = func
      this.loadIdent(node.name, ctx);
      const allFields = [...node.fields];
      if (node.method) allFields.push(node.method);
      for (let i = 0; i < allFields.length - 1; i++) {
        const ki = ctx.addConst(allFields[i]);
        ctx.emit(OP.PUSHK, ki);
        ctx.emit(OP.GETTAB);
      }
      const lastKey = ctx.addConst(allFields[allFields.length - 1]);
      ctx.emit(OP.PUSHK, lastKey);
      // stack: table, key, func -> SETTAB
      ctx.emit(OP.SETTAB);
    }
  }

  compileAssign(node, ctx) {
    // compile all values
    for (let i = 0; i < node.targets.length; i++) {
      if (i < node.vals.length) this.compileExpr(node.vals[i], ctx);
      else ctx.emit(OP.PUSHNIL);
    }
    for (let i = node.vals.length; i > node.targets.length; i--) {
      // pop extra
    }
    // Assign in reverse (pop values in reverse order)
    for (let i = node.targets.length - 1; i >= 0; i--) {
      this.storeTarget(node.targets[i], ctx);
    }
  }

  storeTarget(target, ctx) {
    if (target.type === 'Ident') {
      const slot = ctx.resolveLocal(target.name);
      if (slot >= 0) { ctx.emit(OP.STOREL, slot); return; }
      const uvIdx = ctx.resolveUpval(target.name);
      if (uvIdx >= 0) { ctx.emit(OP.STOREUV, uvIdx); return; }
      const ki = ctx.addConst(target.name);
      ctx.emit(OP.STOREG, ki);
    } else if (target.type === 'Field') {
      // Need: table key value → SETTAB; but value is TOS
      // stack currently: ... value
      // we need: table key value
      // so: push value aside, load table, push key, bring back value
      // Actually: store value in temp, load table, push key, load temp, SETTAB
      // Simpler approach: compile obj and key first, then swap
      // We need a temp local. Actually, we already have value on stack.
      // Instruction: we'll restructure: value is on stack, emit obj, emit key, then ROT or restructure
      // Let's use a different strategy: save value to temp slot first
      // For simplicity: emit target access code using a "pre-push" style
      // Actually let me emit: obj, key, then get value from "below"
      // The value is already on TOS when storeTarget is called for the last target
      // For multi-assign: values are pushed, then we assign in reverse
      // So for a[k] = v: stack has v on top, we need to do table[key] = v
      // Emit: DUP of value, load obj, load key, SETTAB(consumes table,key,val from top3)
      // But SETTAB needs: table(below), key(middle), val(top) -- or top3
      // Let me redefine SETTAB: pops val, key, table; sets table[key]=val
      // So before SETTAB we need: table, key, val on stack (val on top)
      // Current: val on TOS. We need to load table and key first, but they'd go on top of val.
      // Solution: save val to a temp, push table, push key, reload val, SETTAB
      // For simplicity, use a "swap" approach or redesign the assignment.
      // Actually the cleanest approach: pre-compile table/key, THEN get value
      // But this requires lookahead during compilation.
      // Alternative: use a dedicated "ASSIGN_FIELD" opcode that takes the key from constants.
      // Let me use the following approach:
      // For field assignment, we emit: compile_obj, push_key, then rotate stack
      // Stack: val | -> compile obj -> val obj | -> push key -> val obj key |
      // Then ROT3: obj key val | -> SETTAB -> nothing

      // I'll add a simple ROT3 mechanism by using STOREL/LOADL of a "scratch" slot
      // Actually, let me just use a temp local approach
      const scratch = ctx.locals.length;
      ctx.locals.push({ name: '__scratch__', slot: scratch, depth: 999 });
      ctx.emit(OP.STOREL, scratch); // save val
      this.compileExpr(target.obj, ctx);
      const ki = ctx.addConst(target.field);
      ctx.emit(OP.PUSHK, ki);
      ctx.emit(OP.LOADL, scratch); // restore val
      ctx.emit(OP.SETTAB);
      ctx.locals.pop();
    } else if (target.type === 'Index') {
      const scratch = ctx.locals.length;
      ctx.locals.push({ name: '__scratch__', slot: scratch, depth: 999 });
      ctx.emit(OP.STOREL, scratch);
      this.compileExpr(target.obj, ctx);
      this.compileExpr(target.idx, ctx);
      ctx.emit(OP.LOADL, scratch);
      ctx.emit(OP.SETTAB);
      ctx.locals.pop();
    }
  }

  compileCompoundAssign(node, ctx) {
    this.compileExpr(node.target, ctx);
    this.compileExpr(node.val, ctx);
    const opMap = {
      '+': OP.ADD, '-': OP.SUB, '*': OP.MUL, '/': OP.DIV,
      '//': OP.IDIV, '%': OP.MOD, '^': OP.POW, '..': OP.CONCAT,
    };
    ctx.emit(opMap[node.op] ?? OP.ADD);
    this.storeTarget(node.target, ctx);
  }

  compileIf(node, ctx) {
    this.compileExpr(node.cond, ctx);
    const jf1 = ctx.emit(OP.JMPF, 0);
    this.compileBlock(node.body, ctx);

    const jumpsToEnd = [];
    for (const ei of node.elseifs) {
      jumpsToEnd.push(ctx.emit(OP.JMP, 0));
      ctx.patchJump(jf1);
      this.compileExpr(ei.cond, ctx);
      const jf = ctx.emit(OP.JMPF, 0);
      this.compileBlock(ei.body, ctx);
      jumpsToEnd.push(ctx.emit(OP.JMP, 0));
      ctx.patchJump(jf);
    }

    if (node.alt) {
      if (node.elseifs.length === 0) {
        jumpsToEnd.push(ctx.emit(OP.JMP, 0));
        ctx.patchJump(jf1);
      }
      this.compileBlock(node.alt, ctx);
    } else if (node.elseifs.length === 0) {
      ctx.patchJump(jf1);
    }

    for (const j of jumpsToEnd) ctx.patchJump(j);
  }

  compileWhile(node, ctx) {
    const loopStart = ctx.instrs.length;
    const prevBreaks = ctx.breaks;
    const prevContinues = ctx.continues;
    const prevLoopStart = ctx.loopStart;
    ctx.breaks = [];
    ctx.continues = [];
    ctx.loopStart = loopStart;

    this.compileExpr(node.cond, ctx);
    const jf = ctx.emit(OP.JMPF, 0);
    this.compileBlock(node.body, ctx);

    // Patch continues
    for (const c of ctx.continues) ctx.patchJump(c);

    const back = loopStart - ctx.instrs.length - 1;
    ctx.emit(OP.JMP, back);
    ctx.patchJump(jf);

    for (const b of ctx.breaks) ctx.patchJump(b);
    ctx.breaks = prevBreaks;
    ctx.continues = prevContinues;
    ctx.loopStart = prevLoopStart;
  }

  compileNumFor(node, ctx) {
    ctx.enterScope();
    const prevBreaks = ctx.breaks;
    const prevContinues = ctx.continues;
    ctx.breaks = [];
    ctx.continues = [];

    this.compileExpr(node.start, ctx);
    this.compileExpr(node.limit, ctx);
    if (node.step) this.compileExpr(node.step, ctx);
    else { ctx.emit(OP.PUSHINT, 1); }

    const counterSlot = ctx.addLocal(node.name);
    ctx.addLocal('__limit__');
    ctx.addLocal('__step__');

    const initJump = ctx.emit(OP.FORINIT, counterSlot, 0);
    const loopStart = ctx.instrs.length;

    this.compileBlock(node.body, ctx);

    for (const c of ctx.continues) ctx.patchJump(c);

    const stepJump = ctx.emit(OP.FORSTEP, counterSlot, 0);
    // FORSTEP jumps back to loopStart if loop continues
    ctx.instrs[stepJump][2] = loopStart - ctx.instrs.length;

    // Patch FORINIT to jump here (after loop) if condition false initially
    ctx.instrs[initJump][2] = ctx.instrs.length - initJump - 1;

    for (const b of ctx.breaks) ctx.patchJump(b);
    ctx.breaks = prevBreaks;
    ctx.continues = prevContinues;
    ctx.leaveScope();
  }

  compileGenFor(node, ctx) {
    ctx.enterScope();
    const prevBreaks = ctx.breaks;
    const prevContinues = ctx.continues;
    ctx.breaks = [];
    ctx.continues = [];

    // Compile iterators: f, s, var
    for (let i = 0; i < 3; i++) {
      if (i < node.iters.length) this.compileExpr(node.iters[i], ctx);
      else ctx.emit(OP.PUSHNIL);
    }

    const iterSlot = ctx.addLocal('__iter__');
    const stateSlot = ctx.addLocal('__state__');
    const ctrlSlot = ctx.addLocal('__ctrl__');
    ctx.emit(OP.STOREL, ctrlSlot);
    ctx.emit(OP.STOREL, stateSlot);
    ctx.emit(OP.STOREL, iterSlot);

    const loopStart = ctx.instrs.length;

    // Call iterator: iter(state, ctrl)
    ctx.emit(OP.LOADL, iterSlot);
    ctx.emit(OP.LOADL, stateSlot);
    ctx.emit(OP.LOADL, ctrlSlot);
    ctx.emit(OP.CALL, 2, node.names.length);

    // Store results into loop variables and update ctrl
    const varSlots = [];
    for (const name of node.names) {
      const s = ctx.addLocal(name);
      varSlots.push(s);
    }
    for (let i = varSlots.length - 1; i >= 0; i--) ctx.emit(OP.STOREL, varSlots[i]);

    // Check if first var is nil
    ctx.emit(OP.LOADL, varSlots[0]);
    ctx.emit(OP.PUSHNIL);
    ctx.emit(OP.EQ);
    const jmpOut = ctx.emit(OP.JMPT, 0);

    // Update ctrl
    ctx.emit(OP.LOADL, varSlots[0]);
    ctx.emit(OP.STOREL, ctrlSlot);

    this.compileBlock(node.body, ctx);

    for (const c of ctx.continues) ctx.patchJump(c);

    const back = loopStart - ctx.instrs.length - 1;
    ctx.emit(OP.JMP, back);
    ctx.patchJump(jmpOut);

    for (const b of ctx.breaks) ctx.patchJump(b);
    ctx.breaks = prevBreaks;
    ctx.continues = prevContinues;
    ctx.leaveScope();
  }

  compileDo(node, ctx) { this.compileBlock(node.body, ctx); }

  compileRepeat(node, ctx) {
    const prevBreaks = ctx.breaks;
    const prevContinues = ctx.continues;
    ctx.breaks = [];
    ctx.continues = [];
    const loopStart = ctx.instrs.length;
    ctx.loopStart = loopStart;

    this.compileBlock(node.body, ctx);
    for (const c of ctx.continues) ctx.patchJump(c);

    this.compileExpr(node.cond, ctx);
    const back = loopStart - ctx.instrs.length - 1;
    ctx.emit(OP.JMPF, back);

    for (const b of ctx.breaks) ctx.patchJump(b);
    ctx.breaks = prevBreaks;
    ctx.continues = prevContinues;
  }

  compileReturn(node, ctx) {
    const count = node.vals.length;
    for (const v of node.vals) this.compileExpr(v, ctx);
    ctx.emit(OP.RET, count);
  }

  compileBreak(ctx) {
    ctx.breaks.push(ctx.emit(OP.JMP, 0));
  }

  compileContinue(ctx) {
    ctx.continues.push(ctx.emit(OP.JMP, 0));
  }

  compileFuncNode(node, parentCtx) {
    const func = new FuncContext(parentCtx, node.params.filter(p => p !== '...'), node.vararg);
    this.compileBlock(node.body, func);
    func.emit(OP.PUSHNIL);
    func.emit(OP.RET, 1);
    return func;
  }

  loadIdent(name, ctx) {
    const slot = ctx.resolveLocal(name);
    if (slot >= 0) { ctx.emit(OP.LOADL, slot); return; }
    const uvIdx = ctx.resolveUpval(name);
    if (uvIdx >= 0) { ctx.emit(OP.LOADUV, uvIdx); return; }
    const ki = ctx.addConst(name);
    ctx.emit(OP.LOADG, ki);
  }

  compileExpr(node, ctx) {
    if (!node) { ctx.emit(OP.PUSHNIL); return; }
    switch (node.type) {
      case 'Num': {
        const v = node.value;
        if (Number.isInteger(v) && v >= -32768 && v <= 32767) ctx.emit(OP.PUSHINT, v);
        else { const ki = ctx.addConst(v); ctx.emit(OP.PUSHK, ki); }
        break;
      }
      case 'Str': { const ki = ctx.addConst(node.value); ctx.emit(OP.PUSHK, ki); break; }
      case 'Bool': ctx.emit(node.value ? OP.PUSHTRUE : OP.PUSHFALSE); break;
      case 'Nil': ctx.emit(OP.PUSHNIL); break;
      case 'Vararg': ctx.emit(OP.VARARG); break;
      case 'Ident': this.loadIdent(node.name, ctx); break;
      case 'Paren': this.compileExpr(node.expr, ctx); break;
      case 'Unary': this.compileUnary(node, ctx); break;
      case 'Bin': this.compileBin(node, ctx); break;
      case 'Field': {
        this.compileExpr(node.obj, ctx);
        const ki = ctx.addConst(node.field);
        ctx.emit(OP.PUSHK, ki);
        ctx.emit(OP.GETTAB);
        break;
      }
      case 'Index': {
        this.compileExpr(node.obj, ctx);
        this.compileExpr(node.idx, ctx);
        ctx.emit(OP.GETTAB);
        break;
      }
      case 'Call': {
        this.compileExpr(node.func, ctx);
        for (const a of node.args) this.compileExpr(a, ctx);
        ctx.emit(OP.CALL, node.args.length, 1);
        break;
      }
      case 'MethodCall': {
        this.compileExpr(node.obj, ctx);
        ctx.emit(OP.DUP);
        const ki = ctx.addConst(node.method);
        ctx.emit(OP.PUSHK, ki);
        ctx.emit(OP.GETTAB);
        // stack: obj, obj, method_func -> need: method_func, obj, args
        // Swap method_func and obj
        const s1 = ctx.locals.length;
        ctx.locals.push({ name:'__ms1__', slot: s1, depth: 999 });
        const s2 = ctx.locals.length;
        ctx.locals.push({ name:'__ms2__', slot: s2, depth: 999 });
        ctx.emit(OP.STOREL, s1); // save method_func
        ctx.emit(OP.STOREL, s2); // save obj
        ctx.emit(OP.LOADL, s1); // push method_func
        ctx.emit(OP.LOADL, s2); // push obj (self)
        ctx.locals.pop(); ctx.locals.pop();
        for (const a of node.args) this.compileExpr(a, ctx);
        ctx.emit(OP.CALL, node.args.length + 1, 1);
        break;
      }
      case 'Table': {
        let kvCount = 0, arrCount = 0;
        const arrItems = [];
        const kvItems = [];
        for (const f of node.fields) {
          if (f.type === 'V') arrItems.push(f.val);
          else kvItems.push(f);
        }
        for (const f of kvItems) {
          if (f.type === 'NV') { const ki = ctx.addConst(f.key); ctx.emit(OP.PUSHK, ki); }
          else this.compileExpr(f.key, ctx);
          this.compileExpr(f.val, ctx);
          kvCount++;
        }
        for (const v of arrItems) {
          this.compileExpr(v, ctx);
          arrCount++;
        }
        ctx.emit(OP.NEWTAB, kvCount, arrCount);
        break;
      }
      case 'Func': {
        const func = this.compileFuncNode(node, ctx);
        const protoIdx = ctx.protos.length;
        ctx.protos.push(func);
        ctx.emit(OP.NEWFUNC, protoIdx, func.upvals ? func.upvals.length : 0);
        for (const uv of (func.upvals || [])) {
          if (uv.isLocal) ctx.emit(OP.LOADL, uv.parentSlot);
          else ctx.emit(OP.LOADUV, uv.parentSlot);
        }
        break;
      }
      default: ctx.emit(OP.PUSHNIL);
    }
  }

  compileUnary(node, ctx) {
    this.compileExpr(node.expr, ctx);
    const opMap = { '-': OP.UNM, 'not': OP.NOT, '#': OP.LEN, '~': OP.BNOT };
    ctx.emit(opMap[node.op] ?? OP.NOT);
  }

  compileBin(node, ctx) {
    if (node.op === 'and') {
      this.compileExpr(node.left, ctx);
      ctx.emit(OP.DUP);
      const j = ctx.emit(OP.JMPF, 0);
      ctx.emit(OP.POP);
      this.compileExpr(node.right, ctx);
      ctx.patchJump(j);
      return;
    }
    if (node.op === 'or') {
      this.compileExpr(node.left, ctx);
      ctx.emit(OP.DUP);
      const j = ctx.emit(OP.JMPT, 0);
      ctx.emit(OP.POP);
      this.compileExpr(node.right, ctx);
      ctx.patchJump(j);
      return;
    }
    this.compileExpr(node.left, ctx);
    this.compileExpr(node.right, ctx);
    const opMap = {
      '+': OP.ADD, '-': OP.SUB, '*': OP.MUL, '/': OP.DIV, '%': OP.MOD,
      '^': OP.POW, '..': OP.CONCAT, '//': OP.IDIV,
      '==': OP.EQ, '~=': OP.NE, '<': OP.LT, '<=': OP.LE, '>': OP.GT, '>=': OP.GE,
      '&': OP.BAND, '|': OP.BOR, '~': OP.BXOR, '<<': OP.SHL, '>>': OP.SHR,
    };
    ctx.emit(opMap[node.op] ?? OP.ADD);
  }
}

module.exports = { Compiler, OP, OPNAMES };
