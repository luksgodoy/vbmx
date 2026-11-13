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
//   alinhar(principal, stems, criar) → {ok, motivo, stems, deslocamento, correlacao}   estima o atraso inicial (correlação
//                                    cruzada: trecho forte da faixa × soma dos 4 stems) e devolve stems cortados no começo e no fim
//                                    para ter EXATAMENTE o comprimento da faixa; recusa deslocamento > ALINHAR_MAX_S ou correlação fraca
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
  const ALINHAR_MAX_S = 0.25, ALINHAR_JANELA = 16384, ALINHAR_CORR_MIN = 0.6, ALINHAR_PASSO = 4;
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
  function validar(principal, stems, tolerancia) {
    const tol = tolerancia == null ? TOLERANCIA_QUADROS : tolerancia;
    if (!principal) return { ok: false, motivo: 'sem faixa principal no deck' };
    if (!stems || typeof stems !== 'object') return { ok: false, motivo: 'sem stems' };
    for (const k of NOMES) {
      const b = stems[k];
      if (!b || typeof b.getChannelData !== 'function') return { ok: false, motivo: `falta o stem ${k}` };
      if (b.sampleRate !== principal.sampleRate) return { ok: false, motivo: `${k}: taxa de amostragem ${b.sampleRate} ≠ ${principal.sampleRate} da faixa` };
      if (Math.abs(b.length - principal.length) > tol) return { ok: false, motivo: `${k}: ${b.length} quadros contra ${principal.length} da faixa` };
      if (!(b.numberOfChannels >= 1 && b.numberOfChannels <= 2)) return { ok: false, motivo: `${k}: ${b.numberOfChannels} canais (1 ou 2)` };
    }
    return { ok: true, motivo: '' };
  }
  // ---- alinhamento ----
  // O ffmpeg (stems) conta o atraso do codificador/preenchimento do MP3; o decodeAudioData do navegador o descarta (gapless).
  // Então os stems chegam com alguns milhares de quadros a mais e a cabeça deslocada. Sentido de `d`: principal[i] ≈ stems[i + d].
  function mono(b) {
    const n = b.numberOfChannels, a = b.getChannelData(0), m = b.length, r = new Float32Array(m);
    if (n >= 2) { const c = b.getChannelData(1); for (let i = 0; i < m; i++) r[i] = (a[i] + c[i]) * 0.5; } else r.set(a.subarray(0, m));
    return r;
  }
  function criarPadrao(canais, len, taxa) {   // buffer mínimo (fora do navegador); na página entra ctx.createBuffer
    const dados = []; for (let c = 0; c < canais; c++) dados.push(new Float32Array(len));
    return { numberOfChannels: canais, length: len, sampleRate: taxa, duration: len / taxa, getChannelData: (c) => dados[c] };
  }
  function corte(b, d, len, criar) {   // saída[i] = b[i + d], zero fora; d pode ser negativo
    const out = criar(b.numberOfChannels, len, b.sampleRate);
    for (let c = 0; c < b.numberOfChannels; c++) {
      const e = b.getChannelData(c), s = out.getChannelData(c);
      const ini = Math.max(0, -d), fim = Math.min(len, e.length - d);
      for (let i = ini; i < fim; i++) s[i] = e[i + d];
    }
    return out;
  }
  function estimar(principal, stems) {
    const tx = principal.sampleRate, maxL = Math.round(ALINHAR_MAX_S * tx), W = ALINHAR_JANELA, L = principal.length;
    if (L < W * 2 + maxL * 2) return { ok: false, motivo: 'faixa curta demais para alinhar os stems' };
    const p = mono(principal), soma = new Float32Array(L + maxL * 2);   // soma[k] = Σ stems[k - maxL] (zero fora)
    const ms = NOMES.map((k) => mono(stems[k]));
    for (const m of ms) for (let i = 0; i < m.length && i + maxL < soma.length; i++) soma[i + maxL] += m[i];
    // janela forte: a de maior energia entre candidatas espalhadas (intro silenciosa não serve)
    let melhor = -1, ini = maxL;
    const lim = L - W - maxL;
    for (let k = 0; k < 10; k++) {
      const a = Math.round(maxL + (lim - maxL) * (0.05 + 0.09 * k));
      let e = 0; for (let i = a; i < a + W; i++) e += p[i] * p[i];
      if (e > melhor) { melhor = e; ini = a; }
    }
    if (!(melhor > 1e-6)) return { ok: false, motivo: 'faixa sem sinal para alinhar os stems' };
    // correlação normalizada no lag d: p[ini+i] × soma[ini + i + d + maxL]; grossa (÷PASSO) e depois fina (±PASSO)
    const corr = (d, passo) => {
      let sxy = 0, sxx = 0, syy = 0;
      for (let i = 0; i < W; i += passo) { const x = p[ini + i], y = soma[ini + i + d + maxL]; sxy += x * y; sxx += x * x; syy += y * y; }
      return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
    };
    let mD = 0, mC = -2;
    for (let d = -maxL; d <= maxL; d += ALINHAR_PASSO) { const c = corr(d, ALINHAR_PASSO); if (c > mC) { mC = c; mD = d; } }
    let fD = mD, fC = -2;
    for (let d = mD - ALINHAR_PASSO; d <= mD + ALINHAR_PASSO; d++) {
      if (d < -maxL || d > maxL) continue;
      const c = corr(d, 1); if (c > fC) { fC = c; fD = d; }
    }
    return { ok: true, deslocamento: fD, correlacao: fC };
  }
  function alinhar(principal, stems, criar) {
    const v0 = validar(principal, stems, Infinity);   // presença, taxa, canais: o comprimento é o que se conserta aqui
    if (!v0.ok) return v0;
    const est = estimar(principal, stems);
    if (!est.ok) return est;
    const maxL = Math.round(ALINHAR_MAX_S * principal.sampleRate);
    if (Math.abs(est.deslocamento) > maxL) return { ok: false, motivo: `deslocamento dos stems absurdo (${est.deslocamento} quadros, máx ${maxL})` };
    if (est.correlacao < ALINHAR_CORR_MIN) return { ok: false, motivo: `os stems não casam com a faixa (correlação ${est.correlacao.toFixed(2)} < ${ALINHAR_CORR_MIN})` };
    const fab = criar || criarPadrao, saida = {};
    for (const k of NOMES) saida[k] = corte(stems[k], est.deslocamento, principal.length, fab);
    return { ok: true, motivo: '', stems: saida, deslocamento: est.deslocamento, correlacao: est.correlacao };
  }
  function pico(a) {
    let m = 0;
    if (a) for (let i = 0; i < a.length; i++) { const x = a[i] < 0 ? -a[i] : a[i]; if (x > m) m = x; }
    return m > 1 ? 1 : m;
  }
  return { NOMES, LIMITES, KILL_DB, TOLERANCIA_QUADROS, BANDAS, padrao, copia, normalizar, ganhos, filtro, fx, validar, alinhar, pico };
});
