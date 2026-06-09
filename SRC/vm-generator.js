'use strict';

const { OP } = require('./compiler');

// ── Build-time random opcode scrambling ──────────────────────────────────────
// Each build generates a unique bijection: original opcode value → scrambled byte
function buildOpcodeMap() {
  const pool = Array.from({ length: 256 }, (_, i) => i);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
  }
  const scramble = {};
  for (const [name, origVal] of Object.entries(OP)) {
    scramble[origVal] = pool[origVal];
  }
  return scramble;
}

// ── 24-bit xorshift key stepper (identical in JS and Lua) ────────────────────
function stepKey(k) {
  k = (k ^ ((k & 0xFFFF) << 7)) & 0xFFFFFF;
  k = (k ^ (k >>> 9)) & 0xFFFFFF;
  k = (k ^ ((k & 0xFFFF) << 8)) & 0xFFFFFF;
  return k >>> 0;
}

// ── Mutation stepper ─────────────────────────────────────────────────────────
const MUTATE_EVERY = 47;

function stepMutation(m) {
  m = (((m << 3) | (m >>> 5)) & 0xFF) ^ 0xA5;
  return m & 0xFF;
}

// ── Per-constant rolling key ──────────────────────────────────────────────────
function stepConstKey(k, i) {
  return (((k * 1664525 + 1013904223) ^ (i * 2654435761)) >>> 0) & 0xFFFFFF;
}

// ── Instruction packing ──────────────────────────────────────────────────────
// Format: op(8) | (a1_signed16 & 0xFFFF) << 8 | (a2_unsigned8) << 24
// For FORINIT/FORSTEP, swap: a1=jumpOffset(16-bit), a2=slot(8-bit)
// This gives jumps up to ±32767 (handles very large loops)
const OPS_SWAP_ARGS = new Set([OP.FORINIT, OP.FORSTEP]);

function packInstr(op8, a1, a2) {
  const v_op = op8 & 0xFF;
  const v_a1 = (a1 & 0xFFFF);
  const v_a2 = a2 & 0xFF;
  return (v_op | (v_a1 << 8) | (v_a2 * 0x1000000)) >>> 0;
}

// ── Constant encoding with per-constant rolling keys ──────────────────────────
function encodeConsts(consts, seed) {
  let ckey = seed & 0xFFFFFF;
  const encoded = [];
  for (let i = 0; i < consts.length; i++) {
    ckey = stepConstKey(ckey, i);
    const c = consts[i];
    const byteKey = ckey & 0xFF;
    const posKey  = (ckey >> 8) & 0xFF;
    if (typeof c === 'string') {
      const bytes = [];
      for (let j = 0; j < c.length; j++) {
        bytes.push(((c.charCodeAt(j) & 0xFF) ^ byteKey ^ ((j * 0x55) & 0xFF)) & 0xFF);
      }
      encoded.push({ type: 's', data: bytes, key: byteKey });
    } else if (typeof c === 'number') {
      const buf = Buffer.allocUnsafe(8);
      buf.writeDoubleLE(c, 0);
      const encBytes = [];
      for (let j = 0; j < 8; j++) {
        encBytes.push(buf[j] ^ byteKey ^ ((j * 37) & 0xFF));
      }
      encoded.push({ type: 'n', data: encBytes, key: byteKey, raw: c });
    } else {
      encoded.push({ type: 'v' });
    }
  }
  return { encoded, seed };
}

// ── Serialize one proto recursively ──────────────────────────────────────────
function serializeProto(proto, scramble, indent) {
  indent = indent || '  ';

  const constSeed = (Math.random() * 0xFFFFFF | 1) >>> 0;
  const { encoded } = encodeConsts(proto.consts, constSeed);

  const ksLines = encoded.map(e => {
    if (e.type === 's') return `{t="s",d={${e.data.join(',')}},k=${e.key}}`;
    if (e.type === 'n') return `{t="n",d={${e.data.join(',')}},k=${e.key},r=${JSON.stringify(e.raw)}}`;
    return `{t="v"}`;
  }).join(',');

  // Encode instructions with rolling key + dynamic mutation
  const instrSeed = (Math.random() * 0xFFFFFF | 1) >>> 0;
  let rollingKey = instrSeed;
  let mutMask = 0;
  let mutCounter = 0;

  const encInstr = proto.instrs.map(instr => {
    const origOp = instr[0];
    let a1 = instr[1] !== undefined ? instr[1] : 0;
    let a2 = instr[2] !== undefined ? instr[2] : 0;

    // For FORINIT/FORSTEP: swap so jump (potentially large) goes into a1 (16-bit field)
    if (OPS_SWAP_ARGS.has(origOp)) {
      const tmp = a1; a1 = a2; a2 = tmp;
    }

    const scrOp = scramble[origOp] !== undefined ? scramble[origOp] : origOp;
    // Pre-XOR op with mutMask so runtime XOR recovers scrOp
    const encodedOp = (scrOp ^ mutMask) & 0xFF;

    const packed = packInstr(encodedOp, a1, a2);
    rollingKey = stepKey(rollingKey);
    const encrypted = (packed ^ rollingKey) >>> 0;

    mutCounter++;
    if (mutCounter >= MUTATE_EVERY) {
      mutCounter = 0;
      mutMask = stepMutation(mutMask);
    }

    return encrypted;
  });

  const instrLines = encInstr.join(',');

  const protoLines = (proto.protos || [])
    .map(p => serializeProto(p, scramble, indent + '  '))
    .join(',\n');

  const uvLines = (proto.upvals || []).map(uv =>
    `{n=${JSON.stringify(uv.name)},ps=${uv.parentSlot},il=${uv.isLocal ? 1 : 0}}`
  ).join(',');

  return `{
${indent}k={${ksLines}},
${indent}cs=${constSeed},
${indent}b={${instrLines}},
${indent}bs=${instrSeed},
${indent}p={${protoLines}},
${indent}uv={${uvLines}},
${indent}params=${proto.params || 0},
${indent}va=${proto.vararg ? 1 : 0}
${indent}}`;
}

// ── Generate decoy/fake handlers (opcodes that never execute) ─────────────────
function generateFakeHandlers(scramble) {
  const used = new Set(Object.values(scramble));
  const fakeOps = [];
  for (let i = 0; i < 256; i++) {
    if (!used.has(i)) fakeOps.push(i);
  }

  const templates = [
    op => `elseif _op==${op} then _sp=_sp+0`,
    op => `elseif _op==${op} then do end`,
    op => `elseif _op==${op} then local _z=_sp-_sp`,
    op => `elseif _op==${op} then if false then _pc=0 end`,
    op => `elseif _op==${op} then _y=_y or 0`,
    op => `elseif _op==${op} then _x=_x+0`,
    op => `elseif _op==${op} then _pc=_pc+0`,
    op => `elseif _op==${op} then _ikey=_ikey+0`,
  ];

  return fakeOps.map((op, i) => templates[i % templates.length](op)).join('\n      ');
}

// ── Main VM generator ─────────────────────────────────────────────────────────
function generateVM(proto) {
  const scramble = buildOpcodeMap();
  const protoStr = serializeProto(proto, scramble);

  // Scrambled value for each opcode name
  const S = {};
  for (const [name, val] of Object.entries(OP)) {
    S[name] = scramble[val] !== undefined ? scramble[val] : val;
  }

  const fakeHandlers = generateFakeHandlers(scramble);

  return `-- Luau VM (v2 Enhanced: random opcodes, encrypted stream, rolling keys)
local __P__=${protoStr}
local __VM__=(function()
  local _band,_bor,_bxor,_bnot,_shl,_shr
  if bit32 then
    _band=bit32.band;_bor=bit32.bor;_bxor=bit32.bxor;_bnot=bit32.bnot
    _shl=bit32.lshift;_shr=bit32.rshift
  else
    _band=function(a,b)return a&b end;_bor=function(a,b)return a|b end
    _bxor=function(a,b)return a~b end;_bnot=function(a)return~a end
    _shl=function(a,b)return a<<b end;_shr=function(a,b)return a>>b end
  end

  -- 24-bit xorshift key stepper (matches build-time JS)
  local function _sk(k)
    k=_bxor(k,_band(_shl(k,7),0xFFFFFF))
    k=_band(k,0xFFFFFF)
    k=_bxor(k,_shr(k,9))
    k=_bxor(k,_band(_shl(k,8),0xFFFFFF))
    return _band(k,0xFFFFFF)
  end

  -- Mutation stepper
  local function _sm(m)
    m=_bor(_band(_shl(m,3),0xFF),_band(_shr(m,5),0x7))
    return _bxor(m,0xA5)
  end

  -- Per-constant key derivation
  local function _sck(k,i)
    return _band(_bxor(_band(k*1664525+1013904223,0xFFFFFF),_band(i*2654435761,0xFFFFFF)),0xFFFFFF)
  end

  -- Decode constants with per-constant rolling keys
  local function _dc(k,seed)
    local out={}
    local ckey=_band(seed,0xFFFFFF)
    for i=1,#k do
      ckey=_sck(ckey,i-1)
      local e=k[i]
      local bk=_band(ckey,0xFF)
      if e.t=="s" then
        local s=""
        local d=e.d
        for j=1,#d do
          s=s..string.char(_bxor(_bxor(d[j],bk),_band((j-1)*0x55,0xFF)))
        end
        out[i]=s
      elseif e.t=="n" then
        local d=e.d
        local b={}
        for j=1,8 do
          b[j]=string.char(_bxor(d[j],_bxor(bk,_band((j-1)*37,0xFF))))
        end
        local raw=table.concat(b)
        if string.unpack then
          out[i]=string.unpack("<d",raw)
        else
          out[i]=e.r
        end
      else
        out[i]=nil
      end
    end
    return out
  end

  local function _exec(proto,upvals,args,env)
    local _k=_dc(proto.k,proto.cs)
    local _b=proto.b
    local _p=proto.p

    local _stack={}
    local _sp=0
    local _locals={}
    local _pc=1
    local _x,_y=0,0

    if args then
      for i=1,#args do _locals[i-1]=args[i] end
    end
    local _vararg={}
    if proto.va==1 and args then
      for i=(proto.params or 0)+1,#args do
        _vararg[#_vararg+1]=args[i]
      end
    end

    -- Instruction stream state
    local _ikey=proto.bs
    local _mut=0
    local _mc=0
    local _ME=${MUTATE_EVERY}

    local function _push(v)_sp=_sp+1;_stack[_sp]=v end
    local function _pop()local v=_stack[_sp];_sp=_sp-1;return v end
    local function _peek()return _stack[_sp]end

    while true do
      -- Decrypt instruction
      _ikey=_sk(_ikey)
      local _raw=_bxor(_b[_pc],_ikey)
      _pc=_pc+1

      -- Unpack: op(8)|a1(16)|a2(8) packed as 32-bit
      local _op=_bxor(_band(_raw,0xFF),_mut)
      local _a1=_band(_shr(_raw,8),0xFFFF)
      if _a1>=32768 then _a1=_a1-65536 end
      local _a2=_band(_shr(_raw,24),0xFF)

      -- Advance mutation
      _mc=_mc+1
      if _mc>=_ME then _mc=0;_mut=_sm(_mut)end

      if _op==${S.HALT} then
        return
      elseif _op==${S.PUSHK} then
        _push(_k[_a1+1])
      elseif _op==${S.PUSHNIL} then
        _push(nil)
      elseif _op==${S.PUSHTRUE} then
        _push(true)
      elseif _op==${S.PUSHFALSE} then
        _push(false)
      elseif _op==${S.PUSHINT} then
        _push(_a1)
      elseif _op==${S.LOADL} then
        _push(_locals[_a1])
      elseif _op==${S.STOREL} then
        _locals[_a1]=_pop()
      elseif _op==${S.LOADG} then
        _push(env[_k[_a1+1]])
      elseif _op==${S.STOREG} then
        env[_k[_a1+1]]=_pop()
      elseif _op==${S.ADD} then
        local b,a=_pop(),_pop();_push(a+b)
      elseif _op==${S.SUB} then
        local b,a=_pop(),_pop();_push(a-b)
      elseif _op==${S.MUL} then
        local b,a=_pop(),_pop();_push(a*b)
      elseif _op==${S.DIV} then
        local b,a=_pop(),_pop();_push(a/b)
      elseif _op==${S.MOD} then
        local b,a=_pop(),_pop();_push(a%b)
      elseif _op==${S.POW} then
        local b,a=_pop(),_pop();_push(a^b)
      elseif _op==${S.CONCAT} then
        local b,a=_pop(),_pop();_push(tostring(a)..tostring(b))
      elseif _op==${S.IDIV} then
        local b,a=_pop(),_pop();_push(math.floor(a/b))
      elseif _op==${S.UNM} then
        _push(-_pop())
      elseif _op==${S.NOT} then
        _push(not _pop())
      elseif _op==${S.LEN} then
        _push(#_pop())
      elseif _op==${S.BAND} then
        local b,a=_pop(),_pop();_push(_band(a,b))
      elseif _op==${S.BOR} then
        local b,a=_pop(),_pop();_push(_bor(a,b))
      elseif _op==${S.BXOR} then
        local b,a=_pop(),_pop();_push(_bxor(a,b))
      elseif _op==${S.BNOT} then
        _push(_bnot(_pop()))
      elseif _op==${S.SHL} then
        local b,a=_pop(),_pop();_push(_shl(a,b))
      elseif _op==${S.SHR} then
        local b,a=_pop(),_pop();_push(_shr(a,b))
      elseif _op==${S.EQ} then
        local b,a=_pop(),_pop();_push(a==b)
      elseif _op==${S.NE} then
        local b,a=_pop(),_pop();_push(a~=b)
      elseif _op==${S.LT} then
        local b,a=_pop(),_pop();_push(a<b)
      elseif _op==${S.LE} then
        local b,a=_pop(),_pop();_push(a<=b)
      elseif _op==${S.GT} then
        local b,a=_pop(),_pop();_push(a>b)
      elseif _op==${S.GE} then
        local b,a=_pop(),_pop();_push(a>=b)
      elseif _op==${S.JMP} then
        _pc=_pc+_a1
      elseif _op==${S.JMPF} then
        if not _peek()then _pc=_pc+_a1 end
        _pop()
      elseif _op==${S.JMPT} then
        if _peek()then _pc=_pc+_a1 end
        _pop()
      elseif _op==${S.CALL} then
        local nargs,nret=_a1,_a2
        local a={}
        for ii=nargs,1,-1 do a[ii]=_pop()end
        local fn=_pop()
        if type(fn)=="function" then
          local res={fn(table.unpack(a))}
          for ii=1,nret do _push(res[ii])end
        end
      elseif _op==${S.RET} then
        local n=_a1
        if n==0 then return end
        local vals={}
        for ii=n,1,-1 do vals[ii]=_pop()end
        return table.unpack(vals)
      elseif _op==${S.NEWTAB} then
        local nkv,narr=_a1,_a2
        local t={}
        local av={}
        for ii=narr,1,-1 do av[ii]=_pop()end
        for ii=1,narr do t[ii]=av[ii]end
        for ii=1,nkv do
          local v,k=_pop(),_pop()
          t[k]=v
        end
        _push(t)
      elseif _op==${S.GETTAB} then
        local k,obj=_pop(),_pop()
        if obj and k then _push(obj[k])else _push(nil)end
      elseif _op==${S.SETTAB} then
        local v,k,obj=_pop(),_pop(),_pop()
        if obj then obj[k]=v end
      elseif _op==${S.POP} then
        _pop()
      elseif _op==${S.DUP} then
        _push(_peek())
      elseif _op==${S.NEWFUNC} then
        local pidx,uvc=_a1+1,_a2
        local cuv={}
        for ii=uvc,1,-1 do cuv[ii]=_pop()end
        local sp=_p[pidx]
        _push(function(...)return _exec(sp,cuv,{...},env)end)
      elseif _op==${S.VARARG} then
        for _,v in ipairs(_vararg)do _push(v)end
      elseif _op==${S.LOADUV} then
        _push(upvals and upvals[_a1+1] or nil)
      elseif _op==${S.STOREUV} then
        if upvals then upvals[_a1+1]=_pop()else _pop()end
      elseif _op==${S.FORINIT} then
        -- NOTE: args swapped at encode time: _a1=jumpOffset, _a2=slot
        local step,limit,start=_pop(),_pop(),_pop()
        local sl=_a2
        _locals[sl]=start;_locals[sl+1]=limit;_locals[sl+2]=step
        if(step>0 and start>limit)or(step<=0 and start<limit)then
          _pc=_pc+_a1
        end
      elseif _op==${S.FORSTEP} then
        -- NOTE: args swapped at encode time: _a1=jumpOffset, _a2=slot
        local sl=_a2
        local counter=_locals[sl]+_locals[sl+2]
        _locals[sl]=counter
        local step=_locals[sl+2]
        local limit=_locals[sl+1]
        if(step>0 and counter<=limit)or(step<=0 and counter>=limit)then
          _pc=_pc+_a1
        end
      ${fakeHandlers}
      end
    end
  end

  local _E=_ENV or _G or (getfenv and getfenv(0))or{}
  return _exec(__P__,{},{},_E)
end)()
`;
}

module.exports = { generateVM };
