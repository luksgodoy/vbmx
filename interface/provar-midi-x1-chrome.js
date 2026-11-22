// Prova da X1 MK3 no Chrome de verdade (headless, via CDP; sem dependência nova): o classico.html inteiro, com o
// navigator.requestMIDIAccess trocado por um MIDIAccess injetado antes de qualquer script da página, que expõe uma
// entrada "Traktor Kontrol X1 MK3". As mensagens entram pelo onmidimessage que o midi.js liga — o mesmo caminho do
// aparelho —, e o que se confere é o estado real de deck.js, sync.js, mestre.js, biblio.js, fx.js e stems (nada é espião).
// Os LEDs (X1-LEDS) saem por uma MIDIOutput falsa com o mesmo nome: confere-se os bytes que o midi.js manda nela.
// O que NÃO prova: que a X1 manda estes bytes (notas/CCs/canais seguem "a confirmar no aparelho") nem que ela acende
// LED com a mesma nota que o botão manda (o endereço 'mesmo-controle' também é "a confirmar no aparelho", X1-PROVA).
// Rode: node interface/provar-midi-x1-chrome.js        (~10 s; precisa do Chrome; não é testar-*.js de propósito)
'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const RAIZ = path.resolve(__dirname, '..');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function wavSintetico(seg, taxa) {          // bumbo a 124 BPM: áudio decodificável, nenhum arquivo do disco
  const n = seg * taxa, d = Buffer.alloc(44 + n * 2), P = taxa * 60 / 124;
  d.write('RIFF', 0); d.writeUInt32LE(36 + n * 2, 4); d.write('WAVEfmt ', 8); d.writeUInt32LE(16, 16);
  d.writeUInt16LE(1, 20); d.writeUInt16LE(1, 22); d.writeUInt32LE(taxa, 24); d.writeUInt32LE(taxa * 2, 28);
  d.writeUInt16LE(2, 32); d.writeUInt16LE(16, 34); d.write('data', 36); d.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) { const f = (i % P) / taxa; d.writeInt16LE(Math.round(0.8 * Math.exp(-f * 18) * Math.sin(2 * Math.PI * 55 * f) * 32767), 44 + i * 2); }
  return d;
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
  let seq = 0; const pend = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.falha(new Error(JSON.stringify(m.error))) : p.ok(m.result); } };
  const pronto = new Promise((ok, falha) => { ws.onopen = ok; ws.onerror = falha; });
  const enviar = (method, params, sessionId) => new Promise((ok, falha) => { const id = ++seq; pend.set(id, { ok, falha }); ws.send(JSON.stringify({ id, method, params: params || {}, sessionId })); });
  return { pronto, enviar, fechar: () => ws.close() };
}
async function esperarArquivo(arq, ms) {
  const fim = Date.now() + ms;
  while (Date.now() < fim) { if (fs.existsSync(arq)) { const t = fs.readFileSync(arq, 'utf8'); if (t.includes('\n')) return t; } await new Promise((r) => setTimeout(r, 100)); }
  throw new Error('o Chrome não abriu a porta de depuração');
}

// antes de qualquer script: MIDIAccess falso com a X1 e uma porta qualquer; o midi.js registra onmidimessage nelas
const INJETAR = `(() => {
  const porta = (id, name) => ({ id, name, manufacturer: 'NI', state: 'connected', type: 'input', onmidimessage: null });
  const x1 = porta('x1', 'Traktor Kontrol X1 MK3'), outra = porta('outra', 'Outro teclado');
  window.__leds = []; window.__ledsOutra = [];
  const saida = (id, name, caixa) => ({ id, name, manufacturer: 'NI', state: 'connected', type: 'output', send: (b) => caixa.push(Array.from(b)) });
  const sx1 = saida('x1-out', 'Traktor Kontrol X1 MK3', window.__leds), soutra = saida('outra-out', 'Outro sintetizador', window.__ledsOutra);
  const acesso = { inputs: new Map([['x1', x1], ['outra', outra]]), outputs: new Map([['x1-out', sx1], ['outra-out', soutra]]), onstatechange: null };
  window.__x1 = x1; window.__sx1 = sx1; window.__acesso = acesso; window.__falhas = [];
  const w = console.warn.bind(console);
  console.warn = (...a) => { if (/ação falhou/.test(String(a[0]))) window.__falhas.push(String(a[1]) + ': ' + String(a[2] && a[2].message || a[2])); w(...a); };
  window.addEventListener('error', (e) => window.__falhas.push('erro: ' + e.message));
  window.addEventListener('unhandledrejection', (e) => window.__falhas.push('promessa: ' + (e.reason && e.reason.message || e.reason)));
  Object.defineProperty(navigator, 'requestMIDIAccess', { configurable: true, value: () => Promise.resolve(acesso) });
})();`;

// roda na página: biblioteca de 12 faixas, decks A e B carregados, stems prontos no A; depois as conferências
const PROVA = `(async () => {
  const r = [], ok = (c, txt) => r.push([!!c, txt]);
  const espera = (ms) => new Promise((s) => setTimeout(s, ms));
  const env = (...b) => __x1.onmidimessage({ data: Uint8Array.from(b), timeStamp: performance.now() });
  const itens = Array.from({ length: 12 }, (_, i) => ({ item: { nome: 'Faixa ' + (i + 1) + '.wav', caminho: 'sint/' + i,
    obter: async () => new File([await (await fetch('/__sintetico.wav')).arrayBuffer()], 'f.wav', { type: 'audio/wav' }) },
    resultado: { analisavel: true, bpm: 124, camelot: '8A', duracao: 60, grade: { bpm: 124, primeira: 0 } } }));
  mudouBiblioteca(VbMxBiblioteca.paraMotor(itens, 1));
  await carregarNoDeck('A', 1); await carregarNoDeck('B', 2);
  const b = VbMxTocador.bufferDe('A');
  VbMxStems.carregar('A', Object.fromEntries(VbMxStems.NOMES.map((n) => [n, b])));
  VbMxStemsTela.mostrarEstado('A', { fase: 'pronto', progresso: 1 });
  for (let i = 0; i < 50 && !controles.mapas.some((m) => m.perfil === 'x1-mk3'); i++) await espera(50);
  const mapa = controles.mapas.find((m) => m.perfil === 'x1-mk3');
  ok(mapa && mapa.ativo && Array.isArray(mapa.origem) && mapa.atribuicoes.length === mapa.origem.length && mapa.atribuicoes.length > 80, 'a porta "Traktor Kontrol X1 MK3" casou: o perfil entrou ativo, com todas as linhas');
  // ---- LEDs (d): o que chega na saída MIDI da X1 (bytes reais de MIDIOutput.send, pelo midi.js + motor/leds.js)
  const ledChave = (b) => ((b[0] & 0xF0) === 0x90 ? 'nota' : 'cc') + ':' + (b[0] & 0x0F) + ':' + b[1];
  const ledsDesde = (i) => { const o = {}; for (const b of __leds.slice(i)) o[ledChave(b)] = b[2]; return o; };
  ok(Object.keys(ledsDesde(0)).length === 24 && __ledsOutra.length === 0, 'LEDs: a saída "Traktor Kontrol X1 MK3" recebeu os 24 LEDs ao conectar (' + __leds.length + ' mensagens); a outra saída, nenhuma');
  const M = VbMxMapaControle;
  const nomes = mapa.atribuicoes.map((a) => { const c = M.comandoPorId(a.comando); return M.nomeDaAcao(c, a.alvo, c.passos ? 'mais' : undefined); });
  ok(nomes.every((n) => VbMxUI.registrados('acao').includes(n)), 'toda linha do perfil aponta para uma ação registrada pela página real (sem espião)');
  const fis = (cmd, alvo) => mapa.atribuicoes.find((a) => a.comando === cmd && a.alvo === alvo).fisico;
  const nota = (cmd, alvo, v) => { const f = fis(cmd, alvo); env(0x90 | f.canal, f.numero, v); };
  const apertar = (cmd, alvo) => { nota(cmd, alvo, 0x7F); nota(cmd, alvo, 0x00); };
  const cc = (cmd, alvo, v) => { const f = fis(cmd, alvo); env(0xB0 | f.canal, f.numero, v); };

  // ---- decks (b) ----
  apertar('pitchMais', 'A');
  ok(decks.A.pitch === 0.1, 'SHIFT+Nudge ▶ = pitch +0,1 % no motor (decks.A.pitch = ' + decks.A.pitch + ')');
  apertar('pitchMenos', 'A'); apertar('pitchMenos', 'A');
  ok(decks.A.pitch === -0.1, 'SHIFT+Nudge ◀ duas vezes = −0,1 %, sem erro de arredondamento (' + decks.A.pitch + ')');
  nota('pitchMais', 'A', 0x7F); await espera(500); nota('pitchMais', 'A', 0x00);
  const segurado = decks.A.pitch; await espera(300);
  ok(segurado >= 0.2 && decks.A.pitch === segurado, 'segurar SHIFT+Nudge ▶ repete (−0,1 → ' + segurado + ') e para ao soltar');
  mudarPitch('A', 0);
  nota('bendMais', 'B', 0x7F);
  const comBend = !!syncBend.B && syncBend.B.sinal === 1;
  nota('bendMais', 'B', 0x00);
  ok(comBend && !syncBend.B, 'Nudge ▶ direito segura o bend + no deck B e solta ao soltar');
  nota('bendMenos', 'A', 0x7F); const menos = syncBend.A && syncBend.A.sinal === -1; nota('bendMenos', 'A', 0x00);
  ok(menos && !syncBend.A, 'Nudge ◀ esquerdo = bend − no deck A');
  VbMxTocador.buscar('A', 30);
  apertar('inicio', 'A');
  ok(VbMxTocador.posicao('A') < 0.05, 'SHIFT+CUE volta o deck A ao início (posição ' + VbMxTocador.posicao('A').toFixed(3) + ' s)');
  const quem0 = mestreEst.quem; apertar('mestre', 'B');
  ok(mestreEst.quem === 'B' && quem0 !== 'B', 'SHIFT+SYNC direito faz do deck B o mestre');
  apertar('mestre', 'B');
  ok(mestreEst.quem !== 'B', '...e de novo devolve o mestre');
  apertar('sync', 'A'); const comSync = decks.A.sync, p0 = decks.A.pitch; apertar('pitchMais', 'A');
  ok(comSync === true && decks.A.sync === false && Math.abs(decks.A.pitch - p0 - 0.1) < 0.0011, 'SHIFT+Nudge ▶ com SYNC ligado: pitch +0,1 % (' + p0 + ' → ' + decks.A.pitch + ') e o SYNC do A desliga');
  mudarPitch('A', 0);
  const ids = [...document.querySelectorAll('#biblio [data-faixa]')].map((n) => n.getAttribute('data-faixa'));
  selecionar(BIBLIOTECA.find((f) => String(f.id) === ids[0]).id);   // o id da faixa é número; o data-faixa, texto
  cc('biblio.mover', null, 0x41); cc('biblio.mover', null, 0x41);
  ok(atual && String(atual.id) === ids[2], 'Browse girar 2× para a direita = a seleção desce 2 linhas na ordem da tela (' + ids.length + ' linhas)');
  cc('biblio.mover', null, 0x3F);
  ok(String(atual.id) === ids[1], 'Browse para a esquerda = sobe 1');
  const fisB = mapa.atribuicoes.find((a) => a.comando === 'biblio.mover' && a.fisico.canal === 1).fisico;
  env(0xB1, fisB.numero, 0x41);
  ok(String(atual.id) === ids[2], 'o Browse do lado direito também move a mesma seleção');
  const alvoId = atual.id;
  apertar('carregar', 'B'); for (let i = 0; i < 60 && !(decks.B.faixa && decks.B.faixa.id === alvoId && decks.B.buffer); i++) await espera(50);
  ok(decks.B.faixa && decks.B.faixa.id === alvoId && !!decks.B.buffer, 'Browse apertar direito carrega a faixa selecionada no deck B');
  biblioListas.push({ id: '__teste', tipo: 'playlist', nome: 'teste', chaves: [] });
  const fisL = mapa.atribuicoes.find((a) => a.comando === 'biblio.lista').fisico;
  env(0xB0 | fisL.canal, fisL.numero, 0x41);
  ok(biblioEstado.lista === '__teste', 'SHIFT+Browse troca para a próxima lista');
  env(0xB0 | fisL.canal, fisL.numero, 0x41);
  ok(biblioEstado.lista === '', '...e dá a volta para a biblioteca inteira');
  biblioListas.pop(); renderBiblio();
  // os que já existiam: PLAY, SYNC, REV, flux, hotcue, loop
  await espera(250); let marca = __leds.length;
  apertar('play', 'A'); await espera(150);
  ok(tocandoDeck('A'), 'PLAY esquerdo toca o deck A');
  const dPlay = __leds.slice(marca);
  ok(dPlay.length >= 1 && dPlay.every((b) => ledChave(b) === 'nota:0:10') && ledsDesde(marca)['nota:0:10'] === 126,
    'LED do PLAY A acende ([0x90,0x0A,126]) e só ele sai — a diferença (' + JSON.stringify(dPlay) + ')');
  marca = __leds.length; apertar('play', 'A');
  ok(!tocandoDeck('A'), '...e pausa');
  ok(ledsDesde(marca)['nota:0:10'] === 0, '...e o LED do PLAY A apaga no deck:pausou, sem esperar a amostra');
  marca = __leds.length; apertar('sync', 'B');
  ok(decks.B.sync === true, 'SYNC direito liga o sync do deck B');
  await espera(250);
  ok(ledsDesde(marca)['nota:1:11'] === 126, 'LED do SYNC B ([0x91,0x0B,126]) acende pela amostra de 100 ms (sync não tem evento)');
  marca = __leds.length; apertar('sync', 'B'); await espera(250);
  ok(ledsDesde(marca)['nota:1:11'] === 0, '...e apaga quando o SYNC desliga');
  nota('reverso', 'A', 0x7F); const rev = decks.A.reverso; nota('reverso', 'A', 0x00);
  ok(rev === true && decks.A.reverso === false, 'REV é pressionar: reverso enquanto segura');
  const fx0 = JSON.stringify(fx.est); apertar('fx1.liga', null);
  ok(JSON.stringify(fx.est) !== fx0, 'SHIFT+◀ liga/desliga a unidade de FX 1'); apertar('fx1.liga', null);
  for (const a of mapa.atribuicoes) {          // varredura: todo controle do perfil, aperta/solta ou gira, sem falha de ação
    if (/^(play|carregar|mestre|fx\\d\\.liga|stems\\.ligar)$/.test(a.comando)) continue;
    const f = a.fisico;
    if (a.tipo === 'fader') env(0xB0 | f.canal, f.numero, 64);
    else if (a.tipo === 'encoder') env(0xB0 | f.canal, f.numero, 0x41);
    else { env(0x90 | f.canal, f.numero, 0x7F); env(0x90 | f.canal, f.numero, 0x00); }
  }
  await espera(200);
  ok(__falhas.length === 0, 'varredura das ' + mapa.atribuicoes.length + ' linhas sem nenhuma ação falhando' + (__falhas.length ? ': ' + __falhas.slice(0, 3).join(' | ') : ''));
  VbMxStemsTela.mostrarEstado('A', { fase: 'pronto', progresso: 1 });
  for (const n of VbMxStems.NOMES) VbMxStems.definir('A', n, { volume: 1, filtro: 0, mudo: false, solo: false });
  for (const a of mapa.atribuicoes) { const e = controles.estados.get(a.id); if (e && e.pegou) controles.estados.set(a.id, M.soltarTomada(e)); }

  // ---- stems (c) ----
  const vol = () => VbMxStems.estado('A', 'vocals').volume;
  cc('stem.vocals.volume', 'A', 20);
  ok(vol() === 1, 'knob de stem longe do valor não salta (soft takeover)');
  cc('stem.vocals.volume', 'A', 85); cc('stem.vocals.volume', 'A', 60);
  ok(Math.abs(vol() - 60 / 127 * 1.5) < 0.02, 'ao passar pelo 100 % o knob pega e o volume do vocal A segue (' + vol().toFixed(2) + ')');
  cc('stem.vocals.filtro', 'A', 64); cc('stem.vocals.filtro', 'A', 110);
  ok(VbMxStems.estado('A', 'vocals').filtro > 0.5 && Math.abs(vol() - 60 / 127 * 1.5) < 0.02, 'SHIFT+o mesmo knob = filtro do vocal A; o volume fica');
  cc('stem.vocals.volume', 'A', 110);
  ok(Math.abs(vol() - 60 / 127 * 1.5) < 0.02, 'soltar o SHIFT com o knob em outro lugar não faz o volume pular');
  apertar('stem.drums.mudo', 'A');
  ok(VbMxStems.estado('A', 'drums').mudo === true, 'botão de stem = mudo do drums A');
  apertar('stem.bass.solo', 'A');
  ok(VbMxStems.estado('A', 'bass').solo === true, 'SHIFT+botão de stem = solo do bass A');
  apertar('stems.restaurar', 'A');
  const e = VbMxStems.estado('A', 'vocals');
  ok(e.volume === 1 && e.filtro === 0 && !VbMxStems.estado('A', 'drums').mudo && !VbMxStems.estado('A', 'bass').solo, '▶ restaura o deck A (volume 1, filtro 0, sem mudo nem solo)');
  cc('stem.vocals.volume', 'A', 105);
  ok(vol() === 1, 'depois do restaurar o knob não puxa o volume de volta (a tomada recomeça)');
  apertar('stems.ligar', 'A');
  ok(VbMxStems.ativo('A') === false, '◀ desliga o modo stems do deck A');
  apertar('stems.ligar', 'A');
  ok(VbMxStems.ativo('A') === true, '◀ de novo religa');
  // LEDs dos stems (fraco = mudo/fora do solo) e o reenvio ao religar a porta
  await espera(250); marca = __leds.length;
  apertar('stem.drums.mudo', 'A'); await espera(250);
  ok(ledsDesde(marca)['nota:0:17'] === 70 && ledsDesde(0)['nota:0:16'] === 126, 'LED do drums A fica fraco (70) ao mutar; o vocal segue forte (126)');
  apertar('stem.bass.solo', 'A'); await espera(250);
  const sol = ledsDesde(0);
  ok(sol['nota:0:18'] === 126 && sol['nota:0:16'] === 70 && sol['nota:0:19'] === 70, 'solo no bass A: só o LED do bass forte, os outros fracos');
  apertar('stems.restaurar', 'A'); apertar('stems.ligar', 'A'); await espera(250);
  const fora = ledsDesde(0);
  ok(VbMxStems.ativo('A') === false && fora['nota:0:0'] === 0 && [16, 17, 18, 19].every((n) => fora['nota:0:' + n] === 0), 'modo stems desligado: ◀ e os 4 LEDs de stem do A apagam');
  apertar('stems.ligar', 'A');
  __sx1.state = 'disconnected'; __acesso.onstatechange({ port: __sx1 });
  ok(!controles.ledsTimer && controles.saidas.size === 0, 'saída da X1 desplugada: a amostra dos LEDs para');
  marca = __leds.length; __sx1.state = 'connected'; __acesso.onstatechange({ port: __sx1 });
  ok(Object.keys(ledsDesde(marca)).length === 24 && __leds.length - marca === 24 && !!controles.ledsTimer, 'religada: reenvio completo dos 24 LEDs, no estado de agora, e a amostra volta');
  ok(__falhas.length === 0, 'nenhuma ação falhou nem houve erro na página' + (__falhas.length ? ': ' + __falhas.slice(0, 3).join(' | ') : ''));
  return r;
})()`;

(async () => {
  const srv = servidor(wavSintetico(60, 44100));
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const porta = srv.address().port;
  const perfil = fs.mkdtempSync(path.join(os.tmpdir(), 'vbmx-x1-'));
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + perfil, '--no-first-run', '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required', 'about:blank'], { stdio: 'ignore' });
  let c = null, falhas = 1;
  try {
    const [p, caminho] = (await esperarArquivo(path.join(perfil, 'DevToolsActivePort'), 20000)).trim().split('\n');
    c = cdp(`ws://127.0.0.1:${p}${caminho}`);
    await c.pronto;
    const { targetId } = await c.enviar('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await c.enviar('Target.attachToTarget', { targetId, flatten: true });
    const avaliar = async (expr) => {
      const r = await c.enviar('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, sessionId);
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 600));
      return r.result.value;
    };
    await c.enviar('Page.enable', {}, sessionId);
    await c.enviar('Page.addScriptToEvaluateOnNewDocument', { source: INJETAR }, sessionId);
    await c.enviar('Page.navigate', { url: `http://127.0.0.1:${porta}/interface/classico.html` }, sessionId);
    for (let i = 0; i < 100 && !(await avaliar('typeof mudouBiblioteca === "function" && typeof controles === "object" && document.readyState === "complete"')); i++) await new Promise((r) => setTimeout(r, 100));
    const r = await avaliar(PROVA);
    falhas = 0;
    for (const [ok, txt] of r) { console.log((ok ? '  ✓ ' : '  ✗ ') + txt); if (!ok) falhas++; }
    console.log(falhas ? `✗ X1 MK3 no Chrome: ${falhas} de ${r.length} falharam` : `✓ X1 MK3 no Chrome (MIDIAccess injetado): ${r.length} conferências`);
  } catch (e) {
    console.error('✗ ' + e.message);
  } finally {
    if (c) c.fechar();
    chrome.kill();
    srv.close();
    await new Promise((r) => setTimeout(r, 300));
    try { fs.rmSync(perfil, { recursive: true, force: true }); } catch (_) { /* o Chrome ainda solta arquivos; é pasta temporária */ }
    process.exitCode = falhas ? 1 : 0;
  }
})();
