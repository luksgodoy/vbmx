// VbMx — transporte de um deck: posição, play/pausa, taxa, busca (com quantize) e loop.
//
// Lógica pura, sem DOM e sem áudio (VB-11). Roda no navegador (<script src="motor/transporte.js">
// expõe `VbMxTransporte`) e no Node (`require('./motor/transporte.js')`). Quem toca de verdade é
// `interface/js/tocador.js` (VbMxTocador): ele guarda um estado destes por deck e liga o nó de áudio
// a ele. O VB-21 troca o nó (AudioWorklet), não esta conta.
//
// Estado (nunca mutado; cada transição devolve um novo):
//   { tocando, posicao, inicioCtx, taxa, duracao, loop }
//   posicao   s da faixa no instante `inicioCtx` (relógio do AudioContext)
//   taxa      velocidade (1 = original; pitch +6% → 1,06)
//   loop      null | { inicio, fim } em s da faixa
// Posição agora = posicao + (agora − inicioCtx) × taxa, dobrada dentro do loop quando o loop está
// ativo e a cabeça já chegou ao fim dele (como o AudioBufferSourceNode faz com loopStart/loopEnd:
// quem entra antes do início do loop toca até o fim dele e então volta ao início).
//
// API:
//   estadoInicial(duracao)                     parado em 0, taxa 1, sem loop
//   posicaoEm(e, agora)                        s da faixa (travado em [0, duracao])
//   rebasear(e, agora)                         mesmo movimento, com posicao = posicaoEm e inicioCtx = agora
//                                              (as funções de motor/waveform.js, que não sabem de loop,
//                                              ficam exatas recebendo o estado rebaseado)
//   tocar(e, agora) · pausar(e, agora)         tocar no fim recomeça do 0 (como reproducao.js)
//   mudarTaxa(e, agora, taxa)                  taxa inválida → 1
//   buscar(e, agora, t, {grade, quantizar})    pula para t (travado na faixa); com quantizar e grade
//                                              (motor/grade.js), cai na batida mais próxima. Pular para
//                                              depois do fim do loop desliga o loop.
//   definirLoop(e, agora, loop | null)         liga/desliga; ligar com a cabeça já depois do fim
//                                              do loop leva a cabeça ao início dele
//   normalizarLoop(loop, duracao)              { inicio, fim } válido (fim > inicio, dentro da faixa) ou null
//   terminou(e)                                o nó de áudio avisou que acabou: para em 0
//   apertarCup(e, agora, cue, {grade, quantizar})  CUP apertado (VB-37, spec §1): pausa e salta ao cue; marca `cup`
//   soltarCup(e, agora)                        CUP solto: se estava apertado, toca dali (senão devolve e)
//   entrarReverso(e, agora)                    reverso apertado: `sentido` = -1, a posição anda para trás na
//                                              taxa atual (sem loop); lembra em `retomar` se estava tocando
//   sairReverso(e, agora)                      reverso solto: `sentido` = 1, volta a tocar ou a ficar parado
//                                              como estava, a partir da posição onde a ré chegou
// Campos extras do estado (VB-37): `sentido` (1 ou -1), `retomar` (bool, só em ré) e `cup` (bool).
(function (raiz, fabrica) {
  const api = fabrica();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.VbMxTransporte = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const num = v => typeof v === 'number' && Number.isFinite(v);
  const LOOP_MINIMO = 0.005;   // s; loop menor que isso não é loop (e o nó de áudio ignoraria)

  function estadoInicial(duracao) {
    return { tocando: false, posicao: 0, inicioCtx: 0, taxa: 1, duracao: num(duracao) && duracao > 0 ? duracao : 0, loop: null, sentido: 1, retomar: false, cup: false };
  }
  function travar(t, e) {
    const p = num(t) ? Math.max(t, 0) : 0;
    return e.duracao > 0 ? Math.min(p, e.duracao) : p;
  }
  function normalizarLoop(loop, duracao) {
    if (!loop || !num(loop.inicio) || !num(loop.fim)) return null;
    const max = num(duracao) && duracao > 0 ? duracao : Infinity;
    const inicio = Math.max(0, loop.inicio), fim = Math.min(loop.fim, max);
    return fim - inicio >= LOOP_MINIMO ? { inicio, fim } : null;
  }
  function posicaoEm(e, agora) {
    if (!e.tocando) return e.posicao;
    if (e.sentido === -1) return travar(e.posicao - (agora - e.inicioCtx) * e.taxa, e);   // ré: sem loop
    let p = e.posicao + (agora - e.inicioCtx) * e.taxa;
    const L = e.loop;
    if (L && e.posicao < L.fim && p >= L.fim) p = L.inicio + ((p - L.inicio) % (L.fim - L.inicio));
    return travar(p, e);
  }
  function rebasear(e, agora) {
    return e.tocando ? { ...e, posicao: posicaoEm(e, agora), inicioCtx: agora } : e;
  }
  function tocar(e, agora) {
    if (e.tocando || !(e.duracao > 0)) return e;
    const pos = e.posicao >= e.duracao ? 0 : e.posicao;
    return { ...e, tocando: true, posicao: pos, inicioCtx: agora };
  }
  function pausar(e, agora) {
    if (!e.tocando) return e;
    return { ...e, tocando: false, posicao: posicaoEm(e, agora), sentido: 1, retomar: false };
  }
  function mudarTaxa(e, agora, taxa) {
    const t = num(taxa) && taxa > 0 ? taxa : 1;
    return { ...rebasear(e, agora), taxa: t };
  }
  function buscar(e, agora, t, opcoes) {
    const o = opcoes || {};
    let alvo = travar(t, e);
    if (o.quantizar && gradeValida(o.grade)) alvo = travar(quantizar(o.grade, alvo), e);
    const loop = e.loop && alvo >= e.loop.fim ? null : e.loop;
    return { ...e, posicao: alvo, inicioCtx: agora, loop };
  }
  function definirLoop(e, agora, loop) {
    const r = rebasear(e, agora), L = normalizarLoop(loop, e.duracao);
    if (!L) return { ...r, loop: null };
    return { ...r, loop: L, posicao: r.posicao >= L.fim ? L.inicio : r.posicao };
  }
  // a mesma conta de motor/grade.js (quantizar), sem depender dele: a grade é { primeira, periodo }
  function gradeValida(g) { return !!g && num(g.primeira) && num(g.periodo) && g.periodo > 0; }
  function quantizar(g, t) { return g.primeira + Math.round((t - g.primeira) / g.periodo) * g.periodo; }
  function terminou(e) { return { ...e, tocando: false, posicao: 0, sentido: 1, retomar: false }; }

  function apertarCup(e, agora, cue, opcoes) {
    const p = pausar(sairReverso(e, agora), agora);
    return { ...buscar(p, agora, cue, opcoes), cup: true };
  }
  function soltarCup(e, agora) {
    if (!e.cup) return e;
    return tocar({ ...e, cup: false }, agora);
  }
  function entrarReverso(e, agora) {
    if (e.sentido === -1 || !(e.duracao > 0) || posicaoEm(e, agora) <= 0) return e;
    const r = rebasear(e, agora);
    return { ...r, sentido: -1, retomar: e.tocando, tocando: true, inicioCtx: agora };
  }
  function sairReverso(e, agora) {
    if (e.sentido !== -1) return e;
    const r = rebasear(e, agora);
    return { ...r, sentido: 1, tocando: r.retomar, retomar: false, inicioCtx: agora };
  }

  return { LOOP_MINIMO, estadoInicial, posicaoEm, rebasear, tocar, pausar, mudarTaxa, buscar, definirLoop, normalizarLoop, terminou, apertarCup, soltarCup, entrarReverso, sairReverso };
});
