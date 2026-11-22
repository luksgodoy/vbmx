// Mede a tela Profissional (classico.html) nos 4 idiomas (pt-BR, en, es, fr) no Chrome headless por CDP em 360, 768 e 1440 px: rolagem horizontal,
// elementos fora da janela e erro de script, com troca de idioma AO VIVO (VbMxI18n.definir). Mesmo molde de medir-friends.js. NÃO é portão do ./testar.sh (precisa de Chrome).
// Rodar: node interface/medir-classico-idiomas.js
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http');
const { spawn } = require('child_process');
const RAIZ = path.join(__dirname, '..');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const tipos = { '.js': 'text/javascript', '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.json': 'application/json' };
const srv = http.createServer((q, r) => {
  const arq = path.join(RAIZ, path.normalize(decodeURIComponent(new URL(q.url, 'http://x').pathname)));
  if (!arq.startsWith(RAIZ + path.sep) || /\.(mp3|wav|aiff?)$/i.test(arq) || !fs.existsSync(arq) || fs.statSync(arq).isDirectory()) { r.writeHead(404); return r.end(); }
  r.writeHead(200, { 'Content-Type': tipos[path.extname(arq)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); r.end(fs.readFileSync(arq));
});
const MEDIR = `(() => {
  const sai = [], pequeno = [];
  for (const e of document.querySelectorAll('button, a[href], input, label, summary, select')) {
    const r = e.getBoundingClientRect(), cs = getComputedStyle(e);
    if (!r.width || !r.height || cs.visibility === 'hidden') continue;
    if (e.tagName === 'INPUT' && e.type === 'checkbox') { const l = e.closest('label'); if (l) continue; }
    if (e.tagName === 'LABEL' && e.querySelector('input') === null) continue;
    if (Math.min(r.width, r.height) < 44 - 0.5) pequeno.push(e.tagName + '#' + (e.id || e.className) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
    if (r.right > innerWidth + 0.5 || r.left < -0.5) sai.push((e.id || e.className || e.tagName) + ' ' + Math.round(r.left) + '..' + Math.round(r.right));
  }
  // SONDA=1: os elementos mais externos que passam da janela (o pai ainda cabe) — acha o contêiner que alarga a página
  const raizes = [];
  if (window.__sonda) for (const e of document.body.querySelectorAll('*')) { const r = e.getBoundingClientRect(); if (r.width && r.right > innerWidth + 0.5 && e.parentElement && e.parentElement.getBoundingClientRect().right <= innerWidth + 0.5) raizes.push(e.tagName + '#' + (e.id || '') + '.' + String(e.className).slice(0, 40) + ' ' + Math.round(r.left) + '..' + Math.round(r.right)); }
  const fundo = document.getElementById('fr-fundo');   // o fundo em mosaico (friends-fundo.js) só existe no Friends
  return { rolagem: document.documentElement.scrollWidth - innerWidth, sai, raizes, pequeno, fundo: fundo ? fundo.querySelectorAll('.fr-peca svg').length : -1 };
})()`;
(async () => {
  await new Promise((ok, no) => { srv.once('error', no); srv.listen(0, '127.0.0.1', ok); });
  const perfil = fs.mkdtempSync(path.join(os.tmpdir(), 'vbmx-medir-'));
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + perfil, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  let falhou = false;
  try {
    const dt = path.join(perfil, 'DevToolsActivePort');
    for (let i = 0; i < 200 && !(fs.existsSync(dt) && fs.readFileSync(dt, 'utf8').includes('\n')); i++) await espera(100);
    const [p, cam] = fs.readFileSync(dt, 'utf8').trim().split('\n');
    const ws = new WebSocket(`ws://127.0.0.1:${p}${cam}`); await new Promise((ok) => { ws.onopen = ok; });
    let seq = 0; const pend = new Map(), erros = [];
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data);
      if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result || m.error); pend.delete(m.id); }
      else if (m.method === 'Runtime.exceptionThrown') erros.push((m.params.exceptionDetails.exception || {}).description || m.params.exceptionDetails.text);
      else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') erros.push('console.error ' + JSON.stringify(m.params.args.map((a) => a.value || a.description)).slice(0, 200)); };
    const env = (method, params, sessionId) => new Promise((ok) => { const id = ++seq; pend.set(id, ok); ws.send(JSON.stringify({ id, method, params: params || {}, sessionId })); });
    const { targetId } = await env('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await env('Target.attachToTarget', { targetId, flatten: true });
    const ev = async (x) => (await env('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }, sessionId)).result.value;
    await env('Page.enable', {}, sessionId); await env('Runtime.enable', {}, sessionId);
    await env('Page.navigate', { url: 'http://127.0.0.1:' + srv.address().port + '/interface/classico.html' }, sessionId);
    for (let i = 0; i < 100 && !(await ev('document.readyState === "complete" && typeof VbMxI18n === "object" && !!document.querySelector("[data-deck=A] .deck-cab")')); i++) await espera(100);
    await espera(600);
    for (const lang of ['pt-BR', 'en', 'es', 'fr']) {
      await ev(`VbMxI18n.definir(${JSON.stringify(lang)})`);   // troca ao vivo
      await espera(200);
      const lg = await ev('document.documentElement.lang'), ate = await ev('document.querySelector("[data-deck=A] .vazio, [data-deck=A] .titulo").textContent');
      for (const [w, h] of [[360, 800], [768, 1000], [1440, 900]]) {
        await env('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false }, sessionId);
        await espera(200);
        if (process.env.SONDA) await ev('window.__sonda = true');
        const m = await ev(MEDIR);
        if (process.env.SONDA && m.raizes.length) console.log('  sonda:', m.raizes.slice(0, 6).join(' | '));
        const ok = m.rolagem <= 0 && lg === lang;
        if (!ok) falhou = true;
        console.log(`${ok ? '✓' : '✗'} profissional ${lang} ${w}px: rolagem ${m.rolagem}${m.sai.length ? ' fora: ' + m.sai.slice(0, 4).join(', ') : ''} | lang=${lg} | deck A: ${String(ate).slice(0, 40)}`);
      }
    }
    const reais = erros.filter((e) => !/fonts\.g|net::ERR|Failed to load resource/.test(e));
    if (reais.length) { falhou = true; console.log('✗ erros de script: ' + reais.slice(0, 3).join(' ‖ ')); } else console.log('✓ nenhum erro de script');
  } catch (e) { falhou = true; console.error(e); }
  finally { chrome.kill('SIGKILL'); srv.close(); await espera(300); try { fs.rmSync(perfil, { recursive: true, force: true }); } catch (e) {} process.exit(falhou ? 1 : 0); }
})();
