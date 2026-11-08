// VbMx — lógica pura da reprodução dos decks e do mixer (pedido do Lucas, 2026-10-25).
//
// Sem DOM e sem Web Audio: a interface só liga estes números aos nós (BiquadFilter, GainNode,
// AudioBufferSourceNode). Roda no navegador (<script> expõe `VbMxReproducao`) e no Node
// (`require('./motor/reproducao.js')`), e é embutido byte a byte em interface/classico.html.
//
// Estado de um deck: { tocando, posicao, inicioCtx, taxa, duracao }
//   posicao   — segundos da faixa no momento em que `inicioCtx` (relógio do AudioContext) começou
//   taxa      — playbackRate vigente (1 + pitch/100)
// A posição de agora é posicao + (agora − inicioCtx) × taxa quando tocando.

(function (raiz, fabrica) {
  const api = fabrica();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.VbMxReproducao = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const EQ_LIMITE_DB = 12;                       // EQ de −12 a +12 dB; 0 é neutro
  const BANDAS = {                               // frequências do EQ de 3 bandas
    hi:  { tipo: 'highshelf', freq: 3200 },
    mid: { tipo: 'peaking',   freq: 1000, q: 0.8 },
    low: { tipo: 'lowshelf',  freq: 250 },
  };

  const num = (x) => typeof x === 'number' && Number.isFinite(x);
  const trava = (x, min, max) => Math.min(max, Math.max(min, x));

  // pitch (%, −15…+15) → playbackRate. Inválido → 1.
  function taxaDoPitch(pitch, limite) {
    const L = limite === undefined ? 15 : limite;
    return 1 + (num(pitch) ? trava(pitch, -L, L) : 0) / 100;
  }

  // dB do EQ, travado em ±12; inválido → 0.
  function dbDoEq(valor) {
    return num(valor) ? trava(valor, -EQ_LIMITE_DB, EQ_LIMITE_DB) : 0;
  }

  // Curvas do crossfader (VB-16). 'corte' é a de sempre e o padrão: o canal do lado do fader fica em
  // 1 e o outro cai linearmente até 0 na ponta; no meio os dois estão cheios. 'suave' é de potência
  // constante (cos/sen): no meio cada canal fica a 0,707 e a soma de potência não muda ao longo do curso.
  const CURVAS = ['corte', 'suave'];

  // Ganho do crossfader para um canal. x vai de −100 (tudo A) a +100 (tudo B). `reverso` (hamster)
  // troca os lados. Sem curva/reverso o resultado é o de antes do VB-16.
  function ganhoCrossfader(canal, x, curva, reverso) {
    let v = num(x) ? trava(x, -100, 100) : 0;
    if (reverso) v = -v;
    if (canal !== 'A' && canal !== 'B') return 0;
    if (curva === 'suave') {
      const ang = ((v + 100) / 200) * (Math.PI / 2);
      const g = canal === 'A' ? Math.cos(ang) : Math.sin(ang);
      return g < 1e-12 ? 0 : g;
    }
    if (canal === 'A') return v <= 0 ? 1 : (100 - v) / 100;
    return v >= 0 ? 1 : (100 + v) / 100;
  }

  // Ganho final do canal = volume (0…100) × crossfader.
  function ganhoDoCanal(canal, volume, x, curva, reverso) {
    const vol = num(volume) ? trava(volume, 0, 100) / 100 : 0;
    return vol * ganhoCrossfader(canal, x, curva, reverso);
  }

  function estadoInicial(duracao) {
    return { tocando: false, posicao: 0, inicioCtx: 0, taxa: 1, duracao: num(duracao) && duracao > 0 ? duracao : 0 };
  }

  // Posição (s) em `agora` (relógio do contexto). Nunca passa da duração.
  function posicaoEm(e, agora) {
    if (!e.tocando) return e.posicao;
    const p = e.posicao + (agora - e.inicioCtx) * e.taxa;
    return e.duracao > 0 ? Math.min(p, e.duracao) : Math.max(p, 0);
  }

  // Cada transição devolve um estado novo (não muta). Tocar no fim recomeça do início.
  function tocar(e, agora) {
    if (e.tocando || !(e.duracao > 0)) return e;
    const pos = e.posicao >= e.duracao ? 0 : e.posicao;
    return { ...e, tocando: true, posicao: pos, inicioCtx: agora };
  }
  function pausar(e, agora) {
    if (!e.tocando) return e;
    return { ...e, tocando: false, posicao: posicaoEm(e, agora) };
  }
  function mudarTaxa(e, agora, taxa) {
    const t = num(taxa) && taxa > 0 ? taxa : 1;
    if (!e.tocando) return { ...e, taxa: t };
    return { ...e, posicao: posicaoEm(e, agora), inicioCtx: agora, taxa: t };
  }
  // CUE simples: para e volta ao início da faixa.
  function cue(e) { return { ...e, tocando: false, posicao: 0 }; }
  // Fim natural da faixa (o source avisou que acabou).
  function terminou(e) { return { ...e, tocando: false, posicao: 0 }; }

  // Ângulo do prato em graus: 33⅓ rpm = 200°/s, na taxa vigente (a posição já embute a taxa).
  function anguloDoPrato(posicaoSeg) { return ((num(posicaoSeg) ? posicaoSeg : 0) * 200) % 360; }

  // m:ss
  function formatarTempo(seg) {
    const s = Math.max(0, Math.floor(num(seg) ? seg : 0));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  return { EQ_LIMITE_DB, BANDAS, CURVAS, taxaDoPitch, dbDoEq, ganhoCrossfader, ganhoDoCanal, estadoInicial,
    posicaoEm, tocar, pausar, mudarTaxa, cue, terminou, anguloDoPrato, formatarTempo };
});
