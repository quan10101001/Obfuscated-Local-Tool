'use strict';
  const http = require('http');
  const fs   = require('fs');
  const path = require('path');
  const url  = require('url');

  const { Lexer }    = require('./src/lexer');
  const { Parser }   = require('./src/parser');
  const { Compiler } = require('./src/compiler');
  const { generateVM } = require('./src/vm-generator');
  const { multiLayerObfuscate, obfuscate } = require('./src/obfuscator');

  const PORT = process.env.PORT || 3000;
  const MIME = {
    '.html':'text/html','.css':'text/css','.js':'application/javascript',
    '.json':'application/json','.png':'image/png','.ico':'image/x-icon',
  };

  function obfuscateSource(source, level = 3) {
    try {
      const tokens = new Lexer(source).tokenize();
      const ast    = new Parser(tokens).parse();
      const proto  = new Compiler().compileSource(ast);
      const vmCode = generateVM(proto);
      return { success: true, code: multiLayerObfuscate(vmCode, level) };
    } catch (err) {
      try {
        return { success: true, code: obfuscate(source, { level }),
                 warning: `AST parse failed (${err.message}), used text-layer obfuscation` };
      } catch (e2) {
        return { success: false, error: err.message };
      }
    }
  }

  function parseMultipart(buffer, boundary) {
    const boundaryBuf = Buffer.from('--' + boundary);
    const files = [];
    const fields = {};
    let start = 0;
    while (start < buffer.length) {
      const boundaryIdx = buffer.indexOf(boundaryBuf, start);
      if (boundaryIdx === -1) break;
      const headerStart = boundaryIdx + boundaryBuf.length + 2;
      if (headerStart >= buffer.length) break;
      const headerEnd = buffer.indexOf(Buffer.from('\r\n\r\n'), headerStart);
      if (headerEnd === -1) break;
      const headerStr = buffer.slice(headerStart, headerEnd).toString();
      const bodyStart = headerEnd + 4;
      const nextBoundary = buffer.indexOf(boundaryBuf, bodyStart);
      const bodyEnd = nextBoundary === -1 ? buffer.length : nextBoundary - 2;
      const body = buffer.slice(bodyStart, bodyEnd);
      const cdMatch = headerStr.match(/Content-Disposition:[^\r\n]*name="([^"]+)"/i);
      const fnMatch = headerStr.match(/filename="([^"]+)"/i);
      if (cdMatch) {
        const fieldName = cdMatch[1];
        if (fnMatch) files.push({ fieldName, originalname: fnMatch[1], buffer: body });
        else fields[fieldName] = body.toString();
      }
      start = nextBoundary === -1 ? buffer.length : nextBoundary;
    }
    return { files, fields };
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  function sendJSON(res, status, data) {
    const body = JSON.stringify(data);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(body);
  }

  const server = http.createServer(async (req, res) => {
    const parsed = url.parse(req.url, true);
    const pathname = parsed.pathname;

    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Methods':'POST,GET,OPTIONS', 'Access-Control-Allow-Headers':'Content-Type' });
      return res.end();
    }

    if (req.method === 'POST' && pathname === '/api/obfuscate') {
      try {
        const body = await readBody(req);
        const ct = req.headers['content-type'] || '';
        const bMatch = ct.match(/boundary=(.+)/);
        if (!bMatch) return sendJSON(res, 400, { error: 'No boundary in multipart' });
        const { files, fields } = parseMultipart(body, bMatch[1].trim());
        if (!files.length) return sendJSON(res, 400, { error: 'No files uploaded' });
        const level = Math.min(5, Math.max(1, parseInt(fields.level) || 3));
        const results = [];
        for (const file of files) {
          const ext  = path.extname(file.originalname).toLowerCase();
          if (!['.lua','.luau','.txt'].includes(ext)) {
            results.push({ originalName: file.originalname, success: false, error: 'Unsupported extension' }); continue;
          }
          const source = file.buffer.toString('utf8');
          const base   = path.basename(file.originalname, ext);
          const r = obfuscateSource(source, level);
          results.push({
            originalName: file.originalname,
            outputName:   base + '_obf' + (ext === '.txt' ? '.lua' : ext),
            code: r.code || '', success: r.success,
            warning: r.warning || null, error: r.error || null,
            originalSize: source.length, outputSize: r.code ? r.code.length : 0,
          });
        }
        return sendJSON(res, 200, { results });
      } catch (e) { return sendJSON(res, 500, { error: e.message }); }
    }

    if (req.method === 'POST' && pathname === '/api/obfuscate-text') {
      try {
        const raw  = await readBody(req);
        const body = JSON.parse(raw.toString());
        const { code, level = 3 } = body;
        if (!code) return sendJSON(res, 400, { error: 'No code provided' });
        const lvl = Math.min(5, Math.max(1, parseInt(level)));
        return sendJSON(res, 200, obfuscateSource(code, lvl));
      } catch (e) { return sendJSON(res, 500, { error: e.message }); }
    }

    let filePath;
    if (pathname === '/' || pathname === '') filePath = path.join(__dirname, 'public', 'index.html');
    else filePath = path.join(__dirname, 'public', pathname);

    if (!filePath.startsWith(path.join(__dirname, 'public'))) {
      res.writeHead(403); return res.end('Forbidden');
    }

    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); return res.end('Not Found'); }
      const ext  = path.extname(filePath);
      const mime = MIME[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime });
      res.end(data);
    });
  });

  server.listen(PORT, () => {
    console.log(`\n  LuauObfuscator v2 → http://localhost:${PORT}\n`);
  });
  