'use strict';

// ── helpers ────────────────────────────────────────────────────────────────
function rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

function randId(len = 8) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let s = chars[rand(0, chars.length - 26 - 1)]; // start with lowercase
  for (let i = 1; i < len; i++) s += chars[rand(0, chars.length - 1)];
  return s;
}

function xorStr(s, key) {
  let out = '';
  for (let i = 0; i < s.length; i++) out += String.fromCharCode(s.charCodeAt(i) ^ key);
  return out;
}

function toByteArray(s) {
  return Array.from(s).map(c => c.charCodeAt(0));
}

function luaCharStr(bytes) {
  return bytes.map(b => `\\${b}`).join('');
}

// ── Layer 1: String XOR encoding ──────────────────────────────────────────
function encodeStringsLayer(luaCode) {
  // Replace string literals with XOR-decoded runtime expressions
  // Pattern: match "..." and '...' (simple, non-nested)
  const key = rand(1, 254);
  const decFn = randId(6);

  let result = luaCode;

  // Replace double-quoted strings
  result = result.replace(/"((?:[^"\\]|\\.)*)"/g, (match, content) => {
    try {
      // Decode escape sequences
      const decoded = content
        .replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r')
        .replace(/\\"/g, '"').replace(/\\\\/g, '\\').replace(/\\(\d+)/g, (_, n) => String.fromCharCode(parseInt(n)));
      const xored = Array.from(decoded).map(c => (c.charCodeAt(0) ^ key) & 0xFF);
      return `${decFn}({${xored.join(',')}})`;
    } catch { return match; }
  });

  // Replace single-quoted strings
  result = result.replace(/'((?:[^'\\]|\\.)*)'/g, (match, content) => {
    try {
      const decoded = content
        .replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r')
        .replace(/\\'/g, "'").replace(/\\\\/g, '\\').replace(/\\(\d+)/g, (_, n) => String.fromCharCode(parseInt(n)));
      const xored = Array.from(decoded).map(c => (c.charCodeAt(0) ^ key) & 0xFF);
      return `${decFn}({${xored.join(',')}})`;
    } catch { return match; }
  });

  const header = `local function ${decFn}(t) local s="" for _,v in ipairs(t) do s=s..string.char(bit32 and bit32.bxor(v,${key}) or (v~${key})) end return s end\n`;
  return header + result;
}

// ── Layer 2: Number obfuscation ───────────────────────────────────────────
function obfuscateNumbers(luaCode) {
  // Replace integer literals with math expressions
  return luaCode.replace(/\b(\d+)\b/g, (match, numStr) => {
    const n = parseInt(numStr);
    if (isNaN(n) || n < 0 || n > 99999) return match;
    if (n === 0) return '(1-1)';
    if (n === 1) return '(2-1)';
    const a = rand(1, Math.min(n, 1000));
    const b = n - a;
    return `(${a}+${b})`;
  });
}

// ── Layer 3: Variable name mangling ───────────────────────────────────────
function mangleNames(luaCode) {
  // Build a map of identifiers to mangle
  const builtins = new Set([
    'print','tostring','tonumber','type','ipairs','pairs','next','select',
    'unpack','table','string','math','io','os','require','pcall','xpcall',
    'error','assert','rawget','rawset','rawequal','rawlen','setmetatable',
    'getmetatable','collectgarbage','loadstring','load','loadfile','dofile',
    'coroutine','debug','package','arg','_ENV','_G','_VERSION',
    'game','workspace','script','Enum','task','wait','spawn','delay','tick',
    'time','warn','typeof','Instance','Vector2','Vector3','CFrame','Color3',
    'UDim','UDim2','Rect','Region3','NumberRange','NumberSequence',
    'ColorSequence','Ray','Axes','Faces','BrickColor','TweenInfo',
    'table','string','math','bit32','utf8','tostring','tonumber',
    'true','false','nil','and','or','not','if','then','else','elseif',
    'end','for','do','while','repeat','until','return','break','local',
    'function','in','goto','continue','export','type',
  ]);

  const identRegex = /\b([a-zA-Z_][a-zA-Z0-9_]*)\b/g;
  const seen = new Map();
  const matches = [...new Set([...luaCode.matchAll(identRegex)].map(m => m[1]))];

  for (const name of matches) {
    if (!builtins.has(name) && !seen.has(name)) {
      seen.set(name, '_' + randId(rand(4, 8)) + '_');
    }
  }

  // Replace identifiers (careful not to replace inside strings)
  // Simple approach: replace word boundaries
  let result = luaCode;
  for (const [orig, mangled] of seen) {
    const re = new RegExp(`\\b${orig.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
    result = result.replace(re, mangled);
  }
  return result;
}

// ── Layer 4: Control flow flattening ─────────────────────────────────────
function flattenControlFlow(luaCode) {
  // Wrap top-level code in a state-machine dispatcher
  const stateVar = randId(6);
  const dispatchFn = randId(6);
  const junkConst = rand(100000, 999999);

  // Split code into "blocks" at newlines and wrap in dispatcher
  const lines = luaCode.split('\n');
  const chunks = [];
  let chunk = [];
  for (const line of lines) {
    chunk.push(line);
    if (chunk.length >= rand(3, 6)) {
      chunks.push(chunk.join('\n'));
      chunk = [];
    }
  }
  if (chunk.length > 0) chunks.push(chunk.join('\n'));

  // Build dispatch table
  const order = chunks.map((_, i) => i);
  const encoded = order.map(i => i + junkConst);

  let result = `local ${stateVar}=${junkConst}\n`;
  result += `local ${dispatchFn}={${encoded.map(e => `[${e}]=true`).join(',')}}\n`;
  result += `while ${stateVar} do\n`;

  for (let i = 0; i < chunks.length; i++) {
    result += `if ${stateVar}==${encoded[i]} then\n`;
    result += chunks[i] + '\n';
    if (i < chunks.length - 1) result += `${stateVar}=${encoded[i+1]}\n`;
    else result += `${stateVar}=nil\n`;
    result += 'end\n';
  }

  result += 'end\n';
  return result;
}

// ── Layer 5: Junk code injection ──────────────────────────────────────────
function injectJunk(luaCode) {
  const junkSnippets = [
    () => {
      const v = randId(5);
      const n = rand(1, 9999);
      return `local ${v}=(function() local x=${n} return x*0 end)()`;
    },
    () => {
      const v = randId(5);
      return `local ${v}=tostring(math.huge*0)`;
    },
    () => {
      const v = randId(5);
      const a = rand(1, 100), b = rand(1, 100);
      return `local ${v}=(${a}^2+${b}^2)`;
    },
    () => {
      const fn = randId(5);
      const v = rand(1, 50);
      return `local function ${fn}() return ${v}*0 end`;
    },
  ];

  const lines = luaCode.split('\n');
  const result = [];
  for (let i = 0; i < lines.length; i++) {
    result.push(lines[i]);
    if (i % rand(8, 15) === 0 && i > 0) {
      const junk = junkSnippets[rand(0, junkSnippets.length - 1)]();
      result.push(junk);
    }
  }
  return result.join('\n');
}

// ── Layer 6: Base64-like encoding wrapper ─────────────────────────────────
function base64Wrap(luaCode) {
  // Encode the entire VM code as byte array, decode at runtime
  const b64chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const bytes = [];
  for (let i = 0; i < luaCode.length; i++) bytes.push(luaCode.charCodeAt(i) & 0xFF);

  // Simple byte encoding: split into chunks of ~60 bytes
  const key = rand(1, 253);
  const xored = bytes.map(b => b ^ key);

  // Encode as decimal array split into multiple lines
  const chunkSize = 200;
  const chunks = [];
  for (let i = 0; i < xored.length; i += chunkSize) {
    chunks.push(xored.slice(i, i + chunkSize).join(','));
  }

  const fnName = randId(7);
  const dataVar = randId(6);
  const keyVar = randId(5);

  const dataLines = chunks.map(c => `{${c}}`).join(',\n  ');

  return `local ${keyVar}=${key}
local ${dataVar}={
  ${dataLines}
}
local function ${fnName}(t,k)
  local s=""
  for _,chunk in ipairs(t) do
    for _,b in ipairs(chunk) do
      s=s..string.char(bit32 and bit32.bxor(b,k) or (b~k))
    end
  end
  return s
end
local _load = load or loadstring
_load(${fnName}(${dataVar},${keyVar}))()
`;
}

// ── Master obfuscation pipeline ───────────────────────────────────────────
function obfuscate(luaCode, options = {}) {
  const {
    level = 3,       // 1-5: obfuscation intensity
    vmWrap = true,   // already wrapped in VM by caller
  } = options;

  let result = luaCode;

  if (level >= 1) {
    result = encodeStringsLayer(result);
  }

  if (level >= 2) {
    result = obfuscateNumbers(result);
  }

  if (level >= 3) {
    result = injectJunk(result);
  }

  if (level >= 4) {
    result = mangleNames(result);
  }

  if (level >= 5) {
    result = base64Wrap(result);
  }

  return result;
}

// ── Post-VM multi-layer wrapper ───────────────────────────────────────────
function multiLayerObfuscate(vmCode, level = 3) {
  let code = vmCode;

  // Always do string encoding
  code = encodeStringsLayer(code);

  if (level >= 2) code = obfuscateNumbers(code);
  if (level >= 3) code = injectJunk(code);

  if (level >= 4) {
    // Second string encode pass
    code = encodeStringsLayer(code);
    code = obfuscateNumbers(code);
  }

  if (level >= 5) {
    // Final base64 encoding wrap
    code = base64Wrap(code);
  }

  return code;
}

module.exports = { obfuscate, multiLayerObfuscate, encodeStringsLayer, obfuscateNumbers, mangleNames, injectJunk, base64Wrap };
