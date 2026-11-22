#!/usr/bin/env node
// Medidor do MOCKUP do modo Pro (docs/mockup-pro-bauhaus.html) no Chrome headless, por CDP. Molde: interface/medir-friends.js.
// Para cada opção (A/B/C) × idioma (pt-BR/en/es/fr) × largura (360/768/1440) × painel (abas de bloco no celular em A e B;
// abas da gaveta em C): sem rolagem horizontal, nenhum alvo interativo fora da janela, nenhum alvo de toque < 44 px
// (botão, link, summary e [role=slider]), contraste de todo texto visível ≥ 4,5:1 e zero erro de script.
// No fim: `prefers-reduced-motion: reduce` emulado → nenhuma animação rodando.
// Uso: node interface/medir-mockup-pro.js [pasta-para-capturas]      Sai com 1 se algum caso falhar.
// NÃO é portão do ./testar.sh (precisa do Chrome); roda quando o mockup mudar. Ver docs/testes.md.
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http');
const { spawn } = require('child_process');
const RAIZ = path.join(__dirname, '..');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const srv = http.createServer((q, r) => {
  const arq = path.join(RAIZ, path.normalize(decodeURIComponent(new URL(q.url, 'http://x').pathname)));
  if (!arq.startsWith(RAIZ + path.sep) || !/\.html$/.test(arq) || !fs.existsSync(arq)) { r.writeHead(404); return r.end(); }
  r.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); r.end(fs.readFileSync(arq));
});
const MEDIR = `(() => {
  const sai = [], pequeno = [], fraco = [];
  const nome = (e) => e.tagName + '.' + String(e.className).split(' ').slice(0, 2).join('.') + ' "' + (e.textContent || e.getAttribute('aria-label') || '').trim().slice(0, 18) + '"';
  const visivel = (e) => { const r = e.getBoundingClientRect(), cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && !e.closest('details:not([open]) > :not(summary)'); };
  for (const e of document.querySelectorAll('button, a[href], input, summary, select, [role="slider"]')) {
    if (!visivel(e)) continue; const r = e.getBoundingClientRect();
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
  return { rolagem: document.documentElement.scrollWidth - innerWidth, sai, pequeno, fraco: [...new Set(fraco)], textos, lang: document.documentElement.lang };
})()`;
(async () => {
  await new Promise((ok, no) => { srv.once('error', no); srv.listen(0, '127.0.0.1', ok); });
  const perfil = fs.mkdtempSync(path.join(os.tmpdir(), 'vbmx-medir-pro-'));
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + perfil, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
  let falhou = false, casos = 0, ruins = 0, textos = 0;
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
    await env('Page.navigate', { url: 'http://127.0.0.1:' + srv.address().port + '/docs/mockup-pro-bauhaus.html' }, sessionId);
    for (let i = 0; i < 100 && !(await ev('document.readyState === "complete" && typeof MockPro === "object"')); i++) await espera(100);
    await espera(400);
    const pasta = process.argv[2];
    for (const op of ['A', 'B', 'C']) for (const lang of ['pt-BR', 'en', 'es', 'fr']) for (const [w, h] of [[360, 800], [768, 1000], [1440, 900]]) {
      await env('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false }, sessionId);
      // painéis a visitar: no celular, A e B mostram um bloco por vez; em C, cada aba da gaveta; e as 5 abas do browser uma vez por opção
      const vistas = op === 'C' ? ['pads', 'stems', 'fx', 'grade', 'mixer'].map((g) => ({ gav: g })) : w < 768 ? (op === 'A' ? ['A', 'M', 'B', 'F', 'L'] : ['A', 'M', 'B', 'L']).map((x) => ({ pm: x })) : [{}];
      if (lang === 'pt-BR') for (const a of ['pastas', 'preparacao', 'historico', 'gravador']) vistas.push({ aba: a, pm: 'L' });
      for (const v of vistas) {
        await ev(`Object.assign(MockPro.est, { op: ${JSON.stringify(op)}, lang: ${JSON.stringify(lang)}, aba: 'biblioteca', grade: true, stems: true, fx: true, roda: true }, ${JSON.stringify(v)}); MockPro.desenhar(); for (const d of document.querySelectorAll('details')) d.open = true;`);
        await espera(60);
        const m = await ev(MEDIR); casos++; textos += m.textos;
        const ok = m.rolagem <= 0 && !m.sai.length && !m.pequeno.length && !m.fraco.length && m.lang === lang;
        if (!ok) { falhou = true; ruins++; console.log(`✗ ${op} ${lang} ${w}px ${JSON.stringify(v)}: rolagem ${m.rolagem}${m.sai.length ? ' fora: ' + m.sai.slice(0, 4).join(', ') : ''}${m.pequeno.length ? ' < 44px: ' + m.pequeno.slice(0, 4).join(', ') : ''}${m.fraco.length ? ' contraste: ' + m.fraco.slice(0, 4).join(', ') : ''}${m.lang === lang ? '' : ' lang=' + m.lang}`); }
        if (pasta && lang === 'pt-BR' && !v.aba && (v.pm || 'A') === 'A' && (v.gav || 'pads') === 'pads') { const s = await env('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }, sessionId); fs.mkdirSync(pasta, { recursive: true }); fs.writeFileSync(path.join(pasta, `pro-${op}-${w}.png`), Buffer.from(s.data, 'base64')); }
      }
    }
    console.log(`${ruins ? '✗' : '✓'} ${casos - ruins}/${casos} casos (3 opções × 4 idiomas × 360/768/1440 × painéis), ${textos} textos medidos em contraste`);
    await env('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] }, sessionId); await espera(100);
    const com = await ev('document.getAnimations().length');
    await env('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }, sessionId); await espera(100);
    const sem = await ev('document.getAnimations().length');
    if (sem !== 0) falhou = true;
    console.log(`${sem === 0 ? '✓' : '✗'} prefers-reduced-motion: ${com} animação(ões) sem a preferência, ${sem} com "reduce"`);
    const reais = erros.filter((e) => !/fonts\.g|net::ERR|Failed to load resource/.test(e));
    if (reais.length) { falhou = true; console.log('✗ erros de script: ' + reais.slice(0, 3).join(' ‖ ')); } else console.log('✓ nenhum erro de script');
  } catch (e) { falhou = true; console.error(e); }
  finally { chrome.kill('SIGKILL'); srv.close(); await espera(300); try { fs.rmSync(perfil, { recursive: true, force: true }); } catch (e) {} process.exit(falhou ? 1 : 0); }
})();
