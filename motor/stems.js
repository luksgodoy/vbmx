// ===================== VbMxStemsMotor: a conta pura dos stems por deck (2026-11-07) =====================
// Sem Web Audio: o estado de cada stem (vocals, drums, bass, instrumental), as travas, quem soa (mudo/solo),
// os valores dos nós (EQ, filtro, fx) e a validação dos buffers. Os nós são de interface/js/stems.js (VbMxStems).
//   NOMES                              ["vocals","drums","bass","instrumental"]
//   padrao() → {mudo, solo, volume: 1, eq: {hi, mid, low} (dB), filtro: 0, fx: null}
//   normalizar(atual, parcial) → novo estado (cópia), cada campo travado: volume 0…1,5 · eq −26…+6 dB (−26 = kill) ·
//                                    filtro −1…1 (passa-baixa ← 0 → passa-alta) · fx {id, param 0…1, mix 0…1} | null
//   ganhos(estados {nome: est}) → {nome: ganho}   com algum solo, só os solados soam; senão os não mudos; × volume
//   filtro(v) → {ativo, lp, hp, q}      o mesmo botão do canal (VbMxMixer.filtroDoBotao(v × 100))
//   fx(fx, bpm) → {id, params, mix}      os parâmetros do efeito de canal (VbMxMixer.fxParametros(id, param × 100, bpm))
//   validar(principal, stems) → {ok, motivo}   os 4 presentes, mesmo sampleRate, duração ≤ TOLERANCIA_QUADROS
//   pico(Float32Array) → 0…1
// EQ: os 3 biquads do EQ "atual" do canal (VbMxReproducao.BANDAS: highshelf 3200, peaking 1000, lowshelf 250) com o
// ganho em dB direto. Em 0 dB o biquad é identidade (nem fase muda) — a soma dos stems segue igual à faixa. O
// isolador LR4 do canal não serve aqui: mesmo em 0 dB ele é um passa-tudo (gira a fase), e a entrada/saída dos stems
// cruzando com a principal faria filtro-pente. Kill = −26 dB, como a escala do pedido.
(function (raiz, fabrica) {
  const api = fabrica(raiz);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.VbMxStemsMotor = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (raiz) {
  'use strict';
  const M = raiz.VbMxMixer || (typeof require === 'function' ? require('./mixer.js') : null);
  const R = raiz.VbMxReproducao || (typeof require === 'function' ? require('./reproducao.js') : null);
  const NOMES = Object.freeze(['vocals', 'drums', 'bass', 'instrumental']);
  const LIMITES = Object.freeze({ volume: [0, 1.5], eq: [-26, 6], filtro: [-1, 1] });
  const KILL_DB = -26, TOLERANCIA_QUADROS = 2048;   // ~46 ms a 44,1 kHz: o htdemucs devolve o comprimento da entrada (± bloco)
  const BANDAS = R && R.BANDAS ? R.BANDAS : null;
  const num = (x) => typeof x === 'number' && Number.isFinite(x);
  const trava = (x, a, b) => (x < a ? a : x > b ? b : x);

  function padrao() { return { mudo: false, solo: false, volume: 1, eq: { hi: 0, mid: 0, low: 0 }, filtro: 0, fx: null }; }
  function copia(e) { return { mudo: e.mudo, solo: e.solo, volume: e.volume, eq: { ...e.eq }, filtro: e.filtro, fx: e.fx ? { ...e.fx } : null }; }
  function normalizar(atual, parcial) {
    const n = copia(atual || padrao()), p = parcial || {};
    if (typeof p.mudo === 'boolean') n.mudo = p.mudo;
    if (typeof p.solo === 'boolean') n.solo = p.solo;
    if (num(p.volume)) n.volume = trava(p.volume, LIMITES.volume[0], LIMITES.volume[1]);
    if (p.eq && typeof p.eq === 'object') for (const b of ['hi', 'mid', 'low']) if (num(p.eq[b])) n.eq[b] = trava(p.eq[b], LIMITES.eq[0], LIMITES.eq[1]);
    if (num(p.filtro)) n.filtro = trava(p.filtro, LIMITES.filtro[0], LIMITES.filtro[1]);
    if (p.fx === null) n.fx = null;
    else if (p.fx && typeof p.fx === 'object') {
      const base = n.fx || { id: 'filtro', param: 0, mix: 1 };
      const id = typeof p.fx.id === 'string' ? p.fx.id : base.id;
      n.fx = { id, param: num(p.fx.param) ? trava(p.fx.param, 0, 1) : base.param, mix: num(p.fx.mix) ? trava(p.fx.mix, 0, 1) : base.mix };
      if (M && M.FX_IDS && M.FX_IDS.indexOf(id) < 0) n.fx = null;   // id desconhecido: sem efeito
      else if (id === 'filtro') n.fx = null;                         // o filtro do stem é o campo `filtro`
    }
    return n;
  }
  function ganhos(estados) {
    const nomes = Object.keys(estados || {}), algumSolo = nomes.some((k) => estados[k] && estados[k].solo), r = {};
    for (const k of nomes) {
      const e = estados[k];
      r[k] = (algumSolo ? e.solo : !e.mudo) ? e.volume : 0;
    }
    return r;
  }
  function filtro(v) { return M.filtroDoBotao(num(v) ? trava(v, -1, 1) * 100 : 0); }
  function fx(f, bpm) {
    if (!f) return { id: 'filtro', params: { id: 'filtro', ativo: false }, mix: 0 };
    return { id: f.id, params: M.fxParametros(f.id, f.param * 100, bpm), mix: f.mix };
  }
  function validar(principal, stems) {
    if (!principal) return { ok: false, motivo: 'sem faixa principal no deck' };
    if (!stems || typeof stems !== 'object') return { ok: false, motivo: 'sem stems' };
    for (const k of NOMES) {
      const b = stems[k];
      if (!b || typeof b.getChannelData !== 'function') return { ok: false, motivo: `falta o stem ${k}` };
      if (b.sampleRate !== principal.sampleRate) return { ok: false, motivo: `${k}: taxa de amostragem ${b.sampleRate} ≠ ${principal.sampleRate} da faixa` };
      if (Math.abs(b.length - principal.length) > TOLERANCIA_QUADROS) return { ok: false, motivo: `${k}: ${b.length} quadros contra ${principal.length} da faixa` };
      if (!(b.numberOfChannels >= 1 && b.numberOfChannels <= 2)) return { ok: false, motivo: `${k}: ${b.numberOfChannels} canais (1 ou 2)` };
    }
    return { ok: true, motivo: '' };
  }
  function pico(a) {
    let m = 0;
    if (a) for (let i = 0; i < a.length; i++) { const x = a[i] < 0 ? -a[i] : a[i]; if (x > m) m = x; }
    return m > 1 ? 1 : m;
  }
  return { NOMES, LIMITES, KILL_DB, TOLERANCIA_QUADROS, BANDAS, padrao, copia, normalizar, ganhos, filtro, fx, validar, pico };
});
