// VbMx — loops, beatjump e flux: a conta, sem DOM e sem áudio (VB-15).
//
// Lógica pura (UMD): navegador <script src="motor/loops.js"> expõe `VbMxLoops`; Node: require.
// Tempos em s DA FAIXA (como motor/grade.js e motor/transporte.js). Quem toca é o VbMxTocador
// (interface/js/tocador.js); aqui só se decide ONDE ficam os pontos e ONDE a cabeça cairia.
//
// Loop: { inicio, fim } em s da faixa (o mesmo formato de VbMxTocador.definirLoop). Grade: motor/grade.js.
// Opções comuns: { quantizar = true, duracao } — com quantizar, pontos caem na batida mais próxima.
// Os sub-batida (1/32…1/2) saem do ponto quantizado: a conta é sempre batida inteira + n × período.
//
// API
//   TAMANHOS                      [1/32, 1/16, 1/8, 1/4, 1/2, 1, 2, 4, 8, 16, 32] (batidas)
//   maisTamanho(b) · menosTamanho(b)    próximo/anterior da lista (trava nas pontas); b fora da lista → o vizinho
//   passo(grade, batidas)         s de `batidas` batidas
//   batidasDoLoop(grade, loop)    comprimento do loop em batidas
//   autoLoop(grade, pos, batidas, opc)         loop de `batidas` batidas que começa na batida de pos
//   pontoIn(grade, pos, opc)                   s do ponto IN (quantizado ou não)
//   fecharLoop(grade, inicio, pos, opc)        loop manual inicio→OUT em pos; null se OUT não passa do IN
//   dobrarLoop(grade, loop, duracao) · metadeLoop(grade, loop)   mantêm o IN; devolvem o mesmo loop
//                                 se passariam de 32 batidas / abaixo de 1/32 / do fim da faixa
//   moverLoop(loop, delta, duracao) · moverIn(loop, delta) · moverOut(loop, delta, duracao)
//                                 delta em s; devolvem o mesmo loop se o resultado for inválido
//   PASSO_FINO                    passo fino do MOVE em batidas (1/64, metade do menor tamanho), para ajuste
//   batidasDoPasso(grade, passo, loop)   passo do MOVE em batidas: número = ele mesmo; 'loop' = tamanho do loop
//                                 ativo (null sem loop); 'fino' = PASSO_FINO; qualquer outra coisa → null
//   beatjump(grade, pos, batidas, opc)         s de destino (travado em [0, duracao]); com quantizar, cai na batida
//   saltarComLoop(grade, pos, loop, batidas, opc)   {posicao, loop}: com loop ativo e a cabeça dentro,
//                                 loop e cabeça andam juntos o mesmo tanto (como o Traktor); fora, só a cabeça
//   Flux (cabeça virtual, imutável): estado { posicao, desde, taxa, andando } — onde a faixa estaria se o loop
//   não tivesse existido. `agora` é qualquer relógio em s, desde que seja sempre o mesmo.
//   LIMITE_AUTO_LOOP_PADRAO       30 s: faixa mais curta que isso é tratada como loop (preferência loops.auto-detectar)
//   ehFaixaCurta(duracao, limite)          duração válida e < limite (limite ≤ 0 desliga a detecção)
//   loopDaCarga(grade, duracao, limite)    loop que cobre a faixa curta: a faixa inteira sem grade; com grade,
//                                 o múltiplo de compassos mais próximo da duração (mín. 1 compasso, nunca passa do fim,
//                                 começa na 1ª batida); null se a faixa não é curta
//   proximoGuardado(guardados, pos)       ACTIVE sem loop ativo: o próximo loop guardado da faixa, [{inicio, fim, ...}]
//                                 por início: o que ainda não acabou em pos (contém a cabeça ou vem depois);
//                                 passou do último, volta ao primeiro; sem guardados, null
//   fluxIniciar(posicao, agora, taxa, andando = true)
//   fluxPosicao(f, agora, duracao)  s da faixa agora (travado em duracao)
//   fluxMudarTaxa(f, agora, taxa) · fluxPausar(f, agora) · fluxRetomar(f, agora)
//   fluxSair(f, agora, duracao)     para onde levar a cabeça ao soltar o loop
(function (raiz, fabrica) {
  const api = fabrica(raiz);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.VbMxLoops = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (raiz) {
  'use strict';
  const G = raiz.VbMxGrade || (typeof require === 'function' ? require('./grade.js') : null);
  const num = v => typeof v === 'number' && Number.isFinite(v);
  const TAMANHOS = [1 / 32, 1 / 16, 1 / 8, 1 / 4, 1 / 2, 1, 2, 4, 8, 16, 32];
  const MIN = TAMANHOS[0], MAX = TAMANHOS[TAMANHOS.length - 1];
  const EPS = 1e-9;
  const limite = d => (num(d) && d > 0 ? d : Infinity);
  const cabe = (loop, duracao) => loop.inicio >= 0 && loop.fim <= limite(duracao) + EPS && loop.fim - loop.inicio > 0;

  function maisTamanho(b) {
    for (const t of TAMANHOS) if (t > b + EPS) return t;
    return MAX;
  }
  function menosTamanho(b) {
    for (let i = TAMANHOS.length - 1; i >= 0; i--) if (TAMANHOS[i] < b - EPS) return TAMANHOS[i];
    return MIN;
  }
  const PASSO_FINO = 1 / 64;
  function batidasDoPasso(grade, p, loop) {
    if (p === 'fino') return PASSO_FINO;
    if (p === 'loop') return grade && loop && loop.fim > loop.inicio ? (loop.fim - loop.inicio) / grade.periodo : null;
    return num(p) && p !== 0 ? p : null;
  }
  const passo = (grade, batidas) => batidas * grade.periodo;
  const batidasDoLoop = (grade, loop) => (loop.fim - loop.inicio) / grade.periodo;

  function pontoIn(grade, pos, opc) {
    const o = opc || {};
    const t = o.quantizar === false ? pos : G.quantizar(grade, pos);
    return Math.max(0, t);
  }
  function autoLoop(grade, pos, batidas, opc) {
    if (!grade || !num(pos) || !num(batidas) || batidas < MIN - EPS || batidas > MAX + EPS) return null;
    const inicio = pontoIn(grade, pos, opc), fim = inicio + passo(grade, batidas);
    const loop = { inicio, fim };
    return cabe(loop, (opc || {}).duracao) ? loop : null;
  }
  function fecharLoop(grade, inicio, pos, opc) {
    if (!num(inicio) || !num(pos)) return null;
    const o = opc || {};
    const fim = Math.min(o.quantizar === false || !grade ? pos : G.quantizar(grade, pos), limite(o.duracao));
    return fim - inicio > EPS ? { inicio, fim } : null;
  }
  function dobrarLoop(grade, loop, duracao) {
    const novo = { inicio: loop.inicio, fim: loop.inicio + 2 * (loop.fim - loop.inicio) };
    return batidasDoLoop(grade, novo) <= MAX + EPS && cabe(novo, duracao) ? novo : loop;
  }
  function metadeLoop(grade, loop) {
    const novo = { inicio: loop.inicio, fim: loop.inicio + (loop.fim - loop.inicio) / 2 };
    return batidasDoLoop(grade, novo) >= MIN - EPS ? novo : loop;
  }
  function moverLoop(loop, delta, duracao) {
    const novo = { inicio: loop.inicio + delta, fim: loop.fim + delta };
    return cabe(novo, duracao) ? novo : loop;
  }
  function moverIn(loop, delta) {
    const novo = { inicio: loop.inicio + delta, fim: loop.fim };
    return novo.inicio >= 0 && novo.fim - novo.inicio >= 0.005 ? novo : loop;
  }
  function moverOut(loop, delta, duracao) {
    const novo = { inicio: loop.inicio, fim: loop.fim + delta };
    return novo.fim <= limite(duracao) + EPS && novo.fim - novo.inicio >= 0.005 ? novo : loop;
  }

  function beatjump(grade, pos, batidas, opc) {
    const o = opc || {};
    const base = o.quantizar === false ? pos : G.quantizar(grade, pos);
    // quantizado, a origem é a batida mais próxima: o salto cai sempre numa batida inteira
    return Math.min(Math.max(base + passo(grade, batidas), 0), limite(o.duracao));
  }
  function saltarComLoop(grade, pos, loop, batidas, opc) {
    const o = opc || {};
    const destino = beatjump(grade, pos, batidas, o);
    if (!loop || pos < loop.inicio - EPS || pos > loop.fim + EPS) return { posicao: destino, loop: loop || null };
    // loop e cabeça andam juntos; se o loop não couber no destino, o salto trava no que cabe
    let delta = destino - (o.quantizar === false ? pos : G.quantizar(grade, pos));
    const lim = limite(o.duracao);
    delta = Math.max(delta, -loop.inicio);
    delta = Math.min(delta, lim - loop.fim);
    const novo = { inicio: loop.inicio + delta, fim: loop.fim + delta };
    return { posicao: Math.min(Math.max(pos + delta, novo.inicio), novo.fim), loop: novo };
  }

  function proximoGuardado(guardados, pos) {
    const lista = (Array.isArray(guardados) ? guardados : []).filter(l => l && num(l.inicio) && num(l.fim) && l.fim > l.inicio)
      .sort((a, b) => a.inicio - b.inicio);
    if (!lista.length) return null;
    const p = num(pos) ? pos : 0;
    return lista.find(l => l.fim > p + EPS) || lista[0];
  }

  function fluxIniciar(posicao, agora, taxa, andando) {
    return { posicao, desde: agora, taxa: num(taxa) && taxa > 0 ? taxa : 1, andando: andando !== false };
  }
  function fluxPosicao(f, agora, duracao) {
    const p = f.andando ? f.posicao + (agora - f.desde) * f.taxa : f.posicao;
    return Math.min(Math.max(p, 0), limite(duracao));
  }
  const rebase = (f, agora, mudanca) => ({ ...f, posicao: fluxPosicao(f, agora), desde: agora, ...mudanca });
  const fluxMudarTaxa = (f, agora, taxa) => rebase(f, agora, { taxa: num(taxa) && taxa > 0 ? taxa : 1 });
  const fluxPausar = (f, agora) => rebase(f, agora, { andando: false });
  const fluxRetomar = (f, agora) => rebase(f, agora, { andando: true });
  const fluxSair = (f, agora, duracao) => fluxPosicao(f, agora, duracao);

  const LIMITE_AUTO_LOOP_PADRAO = 30;
  const ehFaixaCurta = (duracao, limite) => num(duracao) && duracao > 0 && num(limite) && limite > 0 && duracao < limite;
  function loopDaCarga(grade, duracao, limite) {
    if (!ehFaixaCurta(duracao, limite)) return null;
    const inteira = { inicio: 0, fim: duracao };
    if (!grade || !num(grade.periodo) || !(grade.periodo > 0)) return inteira;
    const pc = num(grade.porCompasso) && grade.porCompasso > 0 ? grade.porCompasso : 4;
    const inicio = ((grade.primeira % grade.periodo) + grade.periodo) % grade.periodo;   // 1ª batida dentro da faixa (a grade pode vir antes de 0)
    const comp = pc * grade.periodo, util = duracao - inicio;
    if (!(util > 0)) return inteira;
    let n = Math.max(1, Math.round(util / comp));
    while (n > 1 && inicio + n * comp > duracao + EPS) n -= 1;
    const fim = inicio + n * comp;
    return fim <= duracao + EPS ? { inicio, fim } : inteira;   // nem 1 compasso cabe: a faixa inteira
  }

  return { proximoGuardado, LIMITE_AUTO_LOOP_PADRAO, ehFaixaCurta, loopDaCarga, TAMANHOS, PASSO_FINO, batidasDoPasso, maisTamanho, menosTamanho, passo, batidasDoLoop, pontoIn, autoLoop, fecharLoop,
    dobrarLoop, metadeLoop, moverLoop, moverIn, moverOut, beatjump, saltarComLoop,
    fluxIniciar, fluxPosicao, fluxMudarTaxa, fluxPausar, fluxRetomar, fluxSair };
});
