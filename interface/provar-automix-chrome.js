// Prova da mixagem automática do Profissional (js/automix.js) no Chrome headless via CDP — sem dependência nova.
// Rode: node interface/provar-automix-chrome.js      (~40 s; precisa do Chrome; não é testar-*.js de propósito)
// O que prova, com 40 faixas sintéticas (WAV gerado em memória, nenhum áudio do disco):
//   1. desligado: a vista de árvore não tem barra, fileira de critérios nem nó tracejado, e ligar+desligar devolve o
//      mesmo HTML de antes (o manual fica como era);
//   2. ligado: barra com os 4 critérios marcados, fileira de 4 nós sólidos, a próxima carregada no deck livre e destacada;
//   3. BPM desmarcado: o nó BPM fica tracejado no lugar e aparecem nós "sairia se BPM estivesse marcado: …";
//   4. "Mixar agora": a próxima entra, o crossfader atravessa, a antiga pausa;
//   5. desligar no fim não para o que toca;
//   6. classico.html, friends.html e index.html carregam sem erro de script.
// Só o OUVIDO não está aqui (item em docs/pendencias.md).
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const RAIZ = path.resolve(__dirname, '..');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const espera = (ms) => new Promise(r => setTimeout(r, ms));

function wavSintetico(seg, taxa) {          // bumbo a 124 BPM sobre um zumbido baixo
  const n = seg * taxa, dados = Buffer.alloc(44 + n * 2), P = taxa * 60 / 124;
  dados.write('RIFF', 0); dados.writeUInt32LE(36 + n * 2, 4); dados.write('WAVEfmt ', 8); dados.writeUInt32LE(16, 16);
  dados.writeUInt16LE(1, 20); dados.writeUInt16LE(1, 22); dados.writeUInt32LE(taxa, 24); dados.writeUInt32LE(taxa * 2, 28);
  dados.writeUInt16LE(2, 32); dados.writeUInt16LE(16, 34); dados.write('data', 36); dados.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const f = (i % P) / taxa, v = 0.8 * Math.exp(-f * 18) * Math.sin(2 * Math.PI * 55 * f) + 0.05 * Math.sin(2 * Math.PI * 440 * i / taxa);
    dados.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(v * 32767))), 44 + i * 2);
  }
  return dados;
}
function servidor(wav) {
  const tipos = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json' };
  return http.createServer((req, res) => {
    const u = decodeURIComponent(req.url.split('?')[0]);
    const manda = (cod, tipo, corpo) => { res.writeHead(cod, { 'Content-Type': tipo, 'Cache-Control': 'no-store' }); res.end(corpo); };
    if (u === '/__sintetico.wav') return manda(200, 'audio/wav', wav);
    const arq = path.join(RAIZ, path.normalize(u));
    if (!arq.startsWith(RAIZ + path.sep) || /\.(mp3|wav|aiff?|nml)$/i.test(arq) || !fs.existsSync(arq) || fs.statSync(arq).isDirectory()) return manda(404, 'text/plain', 'não');
    manda(200, tipos[path.extname(arq)] || 'application/octet-stream', fs.readFileSync(arq));
  });
}
function cdp(url) {
  const ws = new WebSocket(url);
  let seq = 0;
  const pend = new Map(), ouvintes = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.falha(new Error(JSON.stringify(m.error))) : p.ok(m.result); }
    else if (m.method) for (const f of ouvintes) f(m);
  };
  const pronto = new Promise((ok, falha) => { ws.onopen = ok; ws.onerror = falha; });
  const enviar = (method, params, sessionId) => new Promise((ok, falha) => { const id = ++seq; pend.set(id, { ok, falha }); ws.send(JSON.stringify({ id, method, params: params || {}, sessionId })); });
  return { pronto, enviar, aoEvento: (f) => ouvintes.push(f), fechar: () => ws.close() };
}
async function esperarArquivo(arq, ms) {
  const fim = Date.now() + ms;
  while (Date.now() < fim) { if (fs.existsSync(arq)) { const t = fs.readFileSync(arq, 'utf8'); if (t.includes('\n')) return t; } await espera(100); }
  throw new Error('o Chrome não abriu a porta de depuração');
}

// roda na página: 40 faixas (todas com grade a 124 BPM; BPM e casa variados para os critérios terem o que cortar)
const PREPARAR = `(async () => {
  const CASAS = ['8A','9A','8B','7A','10B','11A','5A','6B'];
  const itens = Array.from({ length: 40 }, (_, i) => ({ item: { nome: 'Artista ' + (i + 1) + ' - Faixa ' + (i + 1) + '.wav', caminho: 'sint/' + i,
    obter: async () => new File([await (await fetch('/__sintetico.wav')).arrayBuffer()], 'f.wav', { type: 'audio/wav' }) },
    resultado: { analisavel: true, bpm: i % 5 === 4 ? 150 + i : 120 + (i % 9), camelot: CASAS[i % CASAS.length], duracao: 60, grade: { bpm: 124, primeira: 0 } } }));
  mudouBiblioteca(VbMxBiblioteca.paraMotor(itens, 1));
  VbMxPrefs.gravar('layout.biblio-vista', 'arvore');
  for (const k of ['bpm','tom','pitch','estilo']) VbMxPrefs.gravar('automix.criterio-' + k, true);
  await carregarNoDeck('A', 1);
  tocarPausar('A');
  await new Promise(r => setTimeout(r, 400));
  return tocandoDeck('A') ? 'ok' : 'o deck A não tocou';
})()`;
const FOTO = `(() => {
  const q = (s) => document.querySelectorAll('#biblio ' + s).length;
  const st = document.getElementById('amx-status');
  return { barra: q('.amx-barra'), marcados: q('[data-amx-criterio]:checked'), caixas: q('[data-amx-criterio]'), crit: q('.no-crit'), critFora: [...document.querySelectorAll('#biblio .no-crit.fora')].map(e => e.dataset.crit),
    n1: q('.no.n1'), sairia: q('.no.sairia'), sairiaBpm: [...document.querySelectorAll('#biblio .no.sairia')].filter(e => /sairia se BPM estivesse marcado: /.test(e.title)).length,
    proxima: q('.no.proxima'), botao: q('#amx-ligar'), ligado: typeof amxLigado === 'function' && amxLigado(), status: st ? st.textContent : '',
    A: tocandoDeck('A'), B: tocandoDeck('B'), faixaB: decks.B.faixa ? decks.B.faixa.id : null, xfade: mixer.xfade, pitchB: decks.B.pitch,
    critTitulo: (document.querySelector('#biblio .no-crit[data-crit="bpm"]') || {}).title || '' };
})()`;
// o HTML da vista sem o que muda sozinho com o tempo (nada na árvore muda; só normaliza espaços)
const HTML_VISTA = `document.querySelector('#biblio .lista-arvore').innerHTML.replace(/\\s+/g, ' ')`;

(async () => {
  const srv = servidor(wavSintetico(60, 44100));
  await new Promise(ok => srv.listen(0, '127.0.0.1', ok));
  const porta = srv.address().port;
  const perfil = fs.mkdtempSync(path.join(os.tmpdir(), 'vbmx-automix-'));
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + perfil, '--no-first-run', '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
  let c = null;
  const falhas = [], erros = [];
  let feitas = 0;
  const ok = (cond, texto) => { feitas += 1; if (!cond) falhas.push(texto); };
  try {
    const [p, caminho] = (await esperarArquivo(path.join(perfil, 'DevToolsActivePort'), 20000)).trim().split('\n');
    c = cdp(`ws://127.0.0.1:${p}${caminho}`);
    await c.pronto;
    let pagina = '';
    c.aoEvento((m) => {
      if (m.method === 'Runtime.exceptionThrown') erros.push(`${pagina}: ${(m.params.exceptionDetails.exception && m.params.exceptionDetails.exception.description || m.params.exceptionDetails.text || '').slice(0, 300)}`);
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') erros.push(`${pagina}: console.error ${JSON.stringify(m.params.args.map(a => a.value || a.description)).slice(0, 300)}`);
    });
    const abrir = async (rel, pronta) => {
      pagina = rel;
      const { targetId } = await c.enviar('Target.createTarget', { url: 'about:blank' });
      const { sessionId } = await c.enviar('Target.attachToTarget', { targetId, flatten: true });
      const avaliar = async (expr) => {
        const r = await c.enviar('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
        if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
        return r.result.value;
      };
      await c.enviar('Emulation.setDeviceMetricsOverride', { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false }, sessionId);
      await c.enviar('Page.enable', {}, sessionId);
      await c.enviar('Runtime.enable', {}, sessionId);
      await c.enviar('Page.navigate', { url: `http://127.0.0.1:${porta}/${rel}` }, sessionId);
      for (let i = 0; i < 100 && !(await avaliar(pronta)); i++) await espera(100);
      await espera(500);
      return { avaliar, fechar: () => c.enviar('Target.closeTarget', { targetId }) };
    };
    const ate = async (avaliar, expr, ms) => { const fim = Date.now() + ms; while (Date.now() < fim) { if (await avaliar(expr)) return true; await espera(200); } return false; };

    const pg = await abrir('interface/classico.html', 'typeof mudouBiblioteca === "function" && typeof VbMxPrefs === "object" && typeof amxLigado === "function" && document.readyState === "complete"');
    const prep = await pg.avaliar(PREPARAR);
    if (prep !== 'ok') throw new Error('preparo falhou: ' + prep);
    await espera(300);

    // 1. desligado
    let f = await pg.avaliar(FOTO);
    const antes = await pg.avaliar(HTML_VISTA);
    ok(f.botao === 1 && !f.ligado, 'desligado: o botão Auto existe na vista de árvore e começa desligado');
    ok(f.barra === 0 && f.crit === 0 && f.sairia === 0 && f.proxima === 0, `desligado: sem barra, critérios, tracejados nem destaque (${JSON.stringify([f.barra, f.crit, f.sairia, f.proxima])})`);
    ok(f.n1 > 0, 'desligado: a árvore manual tem nós');
    ok(f.faixaB === null && !f.B, 'desligado: nada foi carregado no deck B');
    const n1Manual = f.n1;

    // 2. ligado, todos os critérios
    await pg.avaliar(`document.getElementById('amx-ligar').click(); true`);
    ok(await ate(pg.avaliar, `decks.B.faixa && !!decks.B.buffer && document.querySelectorAll('#biblio .no.proxima').length === 1`, 8000), 'ligado: a próxima foi carregada no deck B e destacada na árvore');
    f = await pg.avaliar(FOTO);
    ok(f.ligado && f.barra === 1 && f.caixas === 4 && f.marcados === 4, `ligado: barra com 4 critérios marcados (${f.caixas}/${f.marcados})`);
    ok(f.crit === 4 && f.critFora.length === 0, `ligado: fileira de 4 critérios sólidos (${f.crit}, fora ${f.critFora})`);
    ok(f.sairia === 0, 'ligado, tudo marcado: nenhum nó tracejado');
    ok(f.n1 > 0 && f.n1 <= 10, `ligado: nível 1 com até 10 nós (${f.n1})`);
    ok(f.A && !f.B, 'ligado: o deck A segue tocando e o B espera');
    ok(/próxima: /.test(f.status), `ligado: o status nomeia a próxima (${f.status.slice(0, 80)})`);
    const n1Todos = f.n1;

    // 3. BPM desmarcado
    await pg.avaliar(`document.querySelector('[data-amx-criterio="bpm"]').click(); true`);
    await espera(500);
    f = await pg.avaliar(FOTO);
    ok(f.marcados === 3 && f.crit === 4, `BPM desmarcado: 3 marcados e o nó BPM continua no lugar (${f.marcados}, ${f.crit})`);
    ok(f.critFora.join() === 'bpm', `BPM desmarcado: só o nó BPM fica tracejado (${f.critFora})`);
    ok(/desmarcado/.test(f.critTitulo), `BPM desmarcado: o nó diz o que mudaria (${f.critTitulo.slice(0, 90)})`);
    ok(f.sairia > 0 && f.sairiaBpm === f.sairia, `BPM desmarcado: nós que entraram dizem "sairia se BPM estivesse marcado" (${f.sairiaBpm}/${f.sairia})`);
    ok(await pg.avaliar(`VbMxPrefs.ler('automix.criterio-bpm') === false`), 'BPM desmarcado: a preferência foi gravada');
    await pg.avaliar(`document.querySelector('[data-amx-criterio="bpm"]').click(); true`);
    await espera(500);
    f = await pg.avaliar(FOTO);
    ok(f.sairia === 0 && f.critFora.length === 0 && f.n1 === n1Todos, 'BPM remarcado: a árvore volta ao que era');

    // 4. transição
    ok(await ate(pg.avaliar, `/mixa em /.test(document.getElementById('amx-status').textContent)`, 8000), 'há um plano de transição');
    await pg.avaliar(`document.getElementById('amx-agora').click(); true`);
    ok(await ate(pg.avaliar, `tocandoDeck('B') && tocandoDeck('A')`, 12000), 'mixar agora: a próxima entrou com a atual ainda tocando');
    f = await pg.avaliar(FOTO);
    ok(f.xfade <= -60, `mixar agora: a próxima entra com o crossfader do lado de A (${f.xfade})`);
    ok(await ate(pg.avaliar, `tocandoDeck('B') && !tocandoDeck('A') && mixer.xfade === 100`, 40000), 'fim da transição: B toca, A pausou, crossfader todo em B');
    // o ciclo recomeça: outra próxima vai para o deck A
    ok(await ate(pg.avaliar, `decks.A.faixa && decks.A.faixa.id !== 1 && !!decks.A.buffer && !tocandoDeck('A')`, 10000), 'o ciclo recomeça: outra faixa foi para o deck A');

    // 5. desligar
    await pg.avaliar(`document.getElementById('amx-ligar').click(); true`);
    await espera(400);
    f = await pg.avaliar(FOTO);
    ok(!f.ligado && f.barra === 0 && f.crit === 0 && f.sairia === 0 && f.proxima === 0, 'desligar: barra e critérios somem');
    ok(f.B, 'desligar: o que toca segue tocando');
    // de volta ao ponto de partida (deck A tocando a faixa 1, B vazio): a vista tem de ser a mesma de antes de ligar
    await pg.avaliar(`(async () => { tocarPausar('B'); await carregarNoDeck('A', 1); tocarPausar('A'); await new Promise(r => setTimeout(r, 400)); return true; })()`);
    f = await pg.avaliar(FOTO);
    ok(f.n1 > 0 && f.barra === 0, `manual depois de desligar: a árvore manual segue desenhando (${f.n1} nós; antes ${n1Manual})`);
    await pg.fechar();

    // 1b. ligar e desligar sem deixar rastro: mesma página, sem nada tocando no meio
    const pg2 = await abrir('interface/classico.html', 'typeof mudouBiblioteca === "function" && typeof amxLigado === "function" && document.readyState === "complete"');
    if ((await pg2.avaliar(PREPARAR)) !== 'ok') throw new Error('preparo 2 falhou');
    await pg2.avaliar(`tocarPausar('A'); true`);   // pausado: a mixagem automática não tem de onde partir e não carrega nada
    await espera(300);
    await pg2.avaliar(`tocarPausar('A'); true`);
    await espera(300);
    const h0 = await pg2.avaliar(HTML_VISTA);
    await pg2.avaliar(`amxLigar(true); amxLigar(false); true`);
    await espera(300);
    const h1 = await pg2.avaliar(HTML_VISTA);
    ok(h0 === h1 && h0 === antes, `ligar e desligar devolve o mesmo HTML da vista manual (${h0.length} / ${h1.length} / ${antes.length} caracteres)`);
    await pg2.fechar();

    // 6. as outras páginas
    for (const [rel, pronta] of [['interface/friends.html', 'document.readyState === "complete"'], ['interface/index.html', 'document.readyState === "complete"']]) {
      const o = await abrir(rel, pronta);
      ok(await o.avaliar('document.body.children.length > 0'), `${rel} desenhou`);
      await o.fechar();
    }
    ok(erros.length === 0, `sem erro de script nas páginas: ${erros.slice(0, 3).join(' | ')}`);
  } finally {
    try { c && c.fechar(); } catch (_) {}
    chrome.kill();
    srv.close();
    setTimeout(() => { try { fs.rmSync(perfil, { recursive: true, force: true }); } catch (_) {} }, 500);
  }
  if (falhas.length) { console.error(`✗ automix no Chrome: ${falhas.length} de ${feitas} falharam`); for (const t of falhas) console.error('  - ' + t); process.exit(1); }
  console.log(`✓ automix no Profissional (Chrome headless): ${feitas} conferências — desligado sem rastro, critérios na árvore, tracejado do desmarcado, transição inteira, páginas sem erro de script`);
})().catch((e) => { console.error('falhou:', e.message); process.exit(1); });
