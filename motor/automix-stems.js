// ===================== VbMxAutomixStems: o "bass swap" por stems da mixagem automática do Profissional (2026-11-14) =====================
// A conta pura (curvas de ganho por stem em função do progresso p da transição) e a escolha do modo. Quem aplica no
// áudio é interface/js/automix.js, pelo VbMxStems.definir (volume por stem); este módulo não toca áudio.
//
//   ganhosStems(p, tv) → {saindo:{vocals,drums,bass,instrumental}, entrando:{...}}   p ∈ [0,1], tv ∈ (0,1) = virada do baixo
//     saindo.bass   : 1 → 0 em suave (smoothstep) de p=0 até tv; depois 0.
//     entrando.drums: 0 → 1 em suave de p=0 até tv (o bumbo chega primeiro).
//     entrando.bass : 0 em p ≤ tv; 0 → 1 em suave de tv até p=1. Os dois baixos nunca soam cheios juntos: os intervalos
//                     são disjuntos, então saindo.bass² + entrando.bass² ≤ 1 em todo p.
//     os demais stems ficam em 1: o crossfade do deck (ganho do canal) continua valendo por cima, como no modo normal.
//   pontoVirada(plano) → fração de p em que o baixo troca; cai numa batida 1 (compasso inteiro: floor(compassos/2)/compassos).
//   escolherModo({plano, saindo, entrando}) → {modo:'stems'|'crossfade', motivo}   saindo/entrando = {carregado}
//   aplicar(stems, de, para, p, tv) → bool    escreve o volume dos stems; nunca lança (falha = false)
//   restaurar(stems, letra, antes) · guardar(stems, letra) → volumes anteriores
(function (raiz, fabrica) {
  const api = fabrica();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.VbMxAutomixStems = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const NOMES = Object.freeze(['vocals', 'drums', 'bass', 'instrumental']);
  const num = (x) => typeof x === 'number' && isFinite(x);
  const trava = (x, a, b) => Math.min(b, Math.max(a, x));
  // 0 em x ≤ a, 1 em x ≥ b, suave (ponta lisa) entre os dois; extremos exatos.
  function sub(x, a, b) {
    if (x <= a) return 0;
    if (x >= b) return 1;
    const u = (x - a) / (b - a);
    return u * u * (3 - 2 * u);
  }
  function pontoVirada(plano) {
    const c = plano && Number.isInteger(plano.compassos) ? plano.compassos : 0;
    if (c < 2) return 0.5;
    return Math.floor(c / 2) / c;
  }
  function ganhosStems(p, tv) {
    const x = trava(num(p) ? p : 0, 0, 1), v = trava(num(tv) ? tv : 0.5, 0.05, 0.95);
    const saindo = { vocals: 1, drums: 1, bass: 1 - sub(x, 0, v), instrumental: 1 };
    const entrando = { vocals: 1, drums: sub(x, 0, v), bass: sub(x, v, 1), instrumental: 1 };
    return { saindo, entrando };
  }
  function escolherModo(e) {
    const pl = e && e.plano;
    if (!pl || !pl.sincroniza) return { modo: 'crossfade', motivo: 'sem-grade' };
    if (!e.saindo || !e.saindo.carregado) return { modo: 'crossfade', motivo: 'sem-stems-saindo' };
    if (!e.entrando || !e.entrando.carregado) return { modo: 'crossfade', motivo: 'sem-stems-entrando' };
    return { modo: 'stems', motivo: 'ok' };
  }
  function guardar(stems, letra) {
    const r = {};
    for (const n of NOMES) { const s = stems.estado(letra, n); r[n] = s && num(s.volume) ? s.volume : 1; }
    return r;
  }
  function escrever(stems, letra, g) { for (const n of NOMES) stems.definir(letra, n, { volume: g[n] }); }
  function aplicar(stems, de, para, p, tv) {
    try { const g = ganhosStems(p, tv); escrever(stems, de, g.saindo); escrever(stems, para, g.entrando); return true; }
    catch (e) { return false; }
  }
  function restaurar(stems, letra, antes) {
    try { escrever(stems, letra, antes || { vocals: 1, drums: 1, bass: 1, instrumental: 1 }); return true; } catch (e) { return false; }
  }
  return { NOMES, ganhosStems, pontoVirada, escolherModo, aplicar, guardar, restaurar };
});
