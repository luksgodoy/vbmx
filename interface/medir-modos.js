#!/usr/bin/env node
// Medidor do PAINEL DE MODOS (interface/index.html) no Chrome headless, por CDP. Molde: medir-friends.js (servidor da raiz do repo)
// e medir-mockup-pro.js (contraste). Para os 4 idiomas (pt-BR, en, es, fr) × 360/768/1440 px × {sem último usado, com Friends lembrado}:
// sem rolagem horizontal, nenhum alvo fora da janela, nenhum alvo de toque < 44 px, contraste de todo texto visível >= 4,5:1,
// <html lang> igual ao idioma, rótulo "Pro" (nunca "Profissional") na tela e zero erro de script. No fim: prefers-reduced-motion.
// Uso: node interface/medir-modos.js [pasta-para-capturas]   Sai com 1 se algum caso falhar. NÃO é portão do ./testar.sh (precisa do Chrome).
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
  const sai = [], pequeno = [], fraco = [];
  const nome = (e) => e.tagName + '.' + String(e.className).split(' ').slice(0, 2).join('.') + ' "' + (e.textContent || e.getAttribute('aria-label') || '').trim().slice(0, 18) + '"';
  const visivel = (e) => { const r = e.getBoundingClientRect(), cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && !e.closest('details:not([open]) > :not(summary)'); };
  for (const e of document.querySelectorAll('button, a[href], input, summary, select, [role="slider"]')) {
    if (!visivel(e)) continue; const r = e.getBoundingClientRect();
    if (e.tagName === 'INPUT' && e.type === 'checkbox' && e.closest('label')) { const l = e.closest('label').getBoundingClientRect(); if (Math.min(l.width, l.height) >= 43.5) continue; }   // a caixa é alvo pelo rótulo inteiro
    if (Math.min(r.width, r.height) < 44 - 0.5) pequeno.push(nome(e) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
    if (r.right > innerWidth + 0.5 || r.left < -0.5) sai.push(nome(e) + ' ' + Math.round(r.left) + '..' + Math.round(r.right));
  }
  const rgb = (s) => { const m = s.match(/[\\d.]+/g).map(Number); return { r: m[0], g: m[1], b: m[2], a: m.length > 3 ? m[3] : 1 }; };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  let textos = 0;
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    if (!n.nodeValue.trim()) continue; const e = n.parentElement; if (!e || e.closest('script, style, svg') || !visivel(e)) continue;
    let f = null; for (let p = e; p && !f; p = p.parentElement) { const c = rgb(getComputedStyle(p).backgroundColor); if (c.a >= 0.99) f = c; }
    if (!f) f = { r: 20, g: 20, b: 20 };
    const t = rgb(getComputedStyle(e).color), a = lum(t), b = lum(f), k = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); textos++;
    if (k < 4.5) fraco.push(nome(e) + ' ' + k.toFixed(2));
  }
  const prof = /Profissional/.test(document.body.innerText.replace(/\s+/g,' ')); return { prof, rolagem: document.documentElement.scrollWidth - innerWidth, sai, pequeno, fraco: [...new Set(fraco)], textos, lang: document.documentElement.lang };
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
    await env('Page.navigate', { url: 'http://127.0.0.1:' + srv.address().port + '/interface/index.html?escolher' }, sessionId);
    for (let i = 0; i < 100 && !(await ev('document.readyState === "complete" && typeof VbMxModos === "object"')); i++) await espera(100);
    await espera(500);
    await espera(300);
    const pasta = process.argv[2]; let casos = 0, ruins = 0, textos = 0;
    for (const lembrado of [false, true]) {
      await ev(`localStorage.clear(); ${lembrado ? "localStorage.setItem('vbmx-modo','friends'); localStorage.setItem('vbmx-modo-direto','0');" : ''} location.reload()`);
      for (let i = 0; i < 100 && !(await ev('document.readyState === "complete" && typeof VbMxModos === "object" && !!document.querySelector(".idioma-opcao")')); i++) await espera(100);
      for (const lang of ['pt-BR', 'en', 'es', 'fr']) {
        await ev(`VbMxI18n.definir(${JSON.stringify(lang)})`);
        for (const [w, h] of [[360, 800], [768, 1000], [1440, 900]]) {
          await env('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false }, sessionId);
          await espera(120);
          const m = await ev(MEDIR), le = await ev('document.querySelectorAll(".modo.lembrado").length'); casos++; textos += m.textos;
          const ok = m.rolagem <= 0 && !m.sai.length && !m.pequeno.length && !m.fraco.length && m.lang === lang && !m.prof && le === (lembrado ? 1 : 0);
          if (!ok) { falhou = true; ruins++; }
          console.log(`${ok ? '✓' : '✗'} ${lembrado ? 'lembrado' : 'novo    '} ${lang} ${w}px: rolagem ${m.rolagem}${m.sai.length ? ' fora: ' + m.sai.join(', ') : ''}${m.pequeno.length ? ' < 44px: ' + m.pequeno.join(', ') : ''}${m.fraco.length ? ' contraste: ' + m.fraco.slice(0, 4).join(', ') : ''}${m.lang === lang ? '' : ' lang=' + m.lang}${m.prof ? ' "Profissional" na tela' : ''}${le === (lembrado ? 1 : 0) ? '' : ' lembrado=' + le}`);
          if (pasta && lang === 'pt-BR' && lembrado) { const s = await env('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, sessionId); fs.mkdirSync(pasta, { recursive: true }); fs.writeFileSync(path.join(pasta, `painel-${w}.png`), Buffer.from(s.data, 'base64')); }
        }
      }
    }
    console.log(`${ruins ? '✗' : '✓'} ${casos - ruins}/${casos} casos (2 estados × 4 idiomas × 360/768/1440), ${textos} textos medidos em contraste`);
    await env('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }, sessionId); await espera(100);
    const sem = await ev('document.getAnimations().length');
    if (sem !== 0) falhou = true;
    console.log(`${sem === 0 ? '✓' : '✗'} prefers-reduced-motion: ${sem} animação(ões) com "reduce"`);
    const reais = erros.filter((e) => !/fonts\.g|net::ERR|Failed to load resource/.test(e));
    if (reais.length) { falhou = true; console.log('✗ erros de script: ' + reais.slice(0, 3).join(' ‖ ')); } else console.log('✓ nenhum erro de script');
  } catch (e) { falhou = true; console.error(e); }
  finally { chrome.kill('SIGKILL'); srv.close(); await espera(300); try { fs.rmSync(perfil, { recursive: true, force: true }); } catch (e) {} process.exit(falhou ? 1 : 0); }
})();
