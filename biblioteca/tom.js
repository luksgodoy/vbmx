// VbMx — detecção de tom (VB-tom): escrita a partir da matemática publicada — perfis de tonalidade de
// Krumhansl-Kessler (1990), chroma / pitch class profile e correlação de Pearson. Sem dependência e sem
// código de terceiros. Roda no navegador (global `VbMxTom`, precisa de `VbMxDsp` e `Camelot` carregados)
// e no Node (`require`). Teste: node biblioteca/testar-tom.js.
//
// API:
//   analisarTom(sinalMono, taxa, opcoes?) → {
//     key:      'C' | 'C#' | 'D' | 'D#' | 'E' | 'F' | 'F#' | 'G' | 'G#' | 'A' | 'A#' | 'B'  (sustenidos)
//     scale:    'major' | 'minor'                      ← o que o painel.js consumia do KeyExtractor (k.key, k.scale)
//     strength: número ≥ 0 — margem (correlação da melhor tonalidade − a da segunda); 0 = sem informação
//     camelot:  '8B' etc. (via analise/camelot.js) ou null
//     chroma:   Array(12) normalizado a soma 1, índice 0 = C (já com a afinação corrigida)
//     afinacaoCents: desvio estimado de A4=440 Hz, em cents (−50..+50)
//     correlacao: correlação de Pearson da melhor tonalidade (−1..1)
//   }
//   opcoes (padrões): tamanho 4096 (FFT no sinal reamostrado), taxaAlvo 11025, fMin 65, fMax 5000,
//     perfil 'shaath' ('kk' | 'temperley' | 'shaath'), supH 0.7 (supressão de harmônicos; 0 desliga),
//     expPeso 0.5 (expoente do peso de cada pico), agreg 'media' ('mediana' é a alternativa),
//     fluxoMax 0 (>0 descarta quadros de chroma com salto maior), pesoGrave 0.6 e fGrave 200 (picos abaixo
//     de fGrave Hz pesam 1 − pesoGrave, ou seja 40%), maxSeg 120 (recorte central em segundos; 0 = tudo).
//     Valores afinados contra o gabarito do Essentia em 15 faixas (14/15 concordam no mixável — exato ou
//     vizinho ou relativo — só com recorte de 120 s; com 90 s, como analise/proprio-treino.js e validar-pasta.js
//     passam, são 8/15 exatos e 12/15 mixáveis). Teste cego em 40 faixas: 21/40 exatos (52,5%), 31/40 mixáveis.
//     Em analise/ajuste-tom.md: nenhuma variação de perfil/parâmetro/viés/desempate melhorou o teste cego
//     (FINAL) de forma demonstrável; o padrão 'shaath' foi mantido. Perfis: KK (1990) e Temperley (1999)
//     conferem com a literatura (analise/perfis-conferencia.md); SH_* (Sha'ath 2011) NÃO foi conferido contra
//     fonte pública — os números abaixo não têm fonte permitida para conferência.
//     chroma: 'misto' soma meio a meio as correlações do chroma padrão e do 'v2' (é o que o painel usa).
//     chroma: 'v2' ativa biblioteca/chroma2.js (HPSS + branqueamento + HPCP; parâmetros em opcoes.chroma2); padrão: o chroma acima.
//   Sinal vazio/silencioso → força 0, chroma de zeros.
(function (raiz, fabrica) {
  const dsp = (typeof module === 'object' && module.exports) ? require('./dsp.js') : raiz.VbMxDsp;
  const cam = (typeof module === 'object' && module.exports) ? require('../analise/camelot.js') : raiz.Camelot;
  const c2 = (typeof module === 'object' && module.exports) ? require('./chroma2.js') : raiz.VbMxChroma2;
  const api = fabrica(dsp, cam, c2);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.VbMxTom = api;
})(typeof self !== 'undefined' ? self : this, function (D, Camelot, Chroma2) {
  'use strict';

  // Perfis de Krumhansl-Kessler (1990), tom-sonda; índice 0 = tônica.
  const KK_MAIOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const KK_MENOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
  // Temperley (1999) e Sha'ath (2011): variações publicadas dos perfis de tonalidade.
  // SH_*: não conferido contra fonte pública (números sem fonte verificável).
  const TEMP_MAIOR = [5.0, 2.0, 3.5, 2.0, 4.5, 4.0, 2.0, 4.5, 2.0, 3.5, 1.5, 4.0];
  const TEMP_MENOR = [5.0, 2.0, 3.5, 4.5, 2.0, 4.0, 2.0, 4.5, 3.5, 2.0, 1.5, 4.0];
  const SH_MAIOR = [6.6, 2.0, 3.5, 2.3, 4.6, 4.0, 2.5, 5.2, 2.4, 3.7, 2.3, 3.4];
  const SH_MENOR = [6.5, 2.7, 3.5, 5.4, 2.6, 3.5, 2.5, 5.2, 4.0, 2.7, 4.3, 3.2];
  const PERFIS = { kk: [KK_MAIOR, KK_MENOR], temperley: [TEMP_MAIOR, TEMP_MENOR], shaath: [SH_MAIOR, SH_MENOR] };
  const NOTAS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

  function pearson(a, b) {
    let ma = 0, mb = 0; for (let i = 0; i < 12; i++) { ma += a[i]; mb += b[i]; } ma /= 12; mb /= 12;
    let sab = 0, saa = 0, sbb = 0;
    for (let i = 0; i < 12; i++) { const x = a[i] - ma, y = b[i] - mb; sab += x * y; saa += x * x; sbb += y * y; }
    return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 0;
  }

  // Picos espectrais (máximos locais acima do piso) com frequência refinada por interpolação parabólica no log.
  function picos(mag, taxa, tamanho, fMin, fMax, piso, supH) {
    const bin = taxa / tamanho, saida = [];
    const k0 = Math.max(2, Math.floor(fMin / bin)), k1 = Math.min(mag.length - 2, Math.ceil(fMax / bin));
    for (let k = k0; k <= k1; k++) {
      const m = mag[k];
      if (m > piso && m > mag[k - 1] && m >= mag[k + 1] && m > mag[k - 2] && m >= mag[k + 2]) {
        const a = Math.log(mag[k - 1] + 1e-12), b = Math.log(m + 1e-12), c = Math.log(mag[k + 1] + 1e-12);
        const den = a - 2 * b + c, d = den < 0 ? 0.5 * (a - c) / den : 0;
        saida.push({ f: (k + Math.max(-0.5, Math.min(0.5, d))) * bin, m });
      }
    }
    return supH === 0 ? saida : suprimirHarmonicos(saida, supH);
  }

  // Um pico que é o 3º, 5º, 6º ou 7º harmônico de um pico mais grave e bem mais forte (±1,5%) é harmônico, não nota:
  // sem isso a quinta (3º harmônico) infla e a tonalidade desliza para a dominante.
  function suprimirHarmonicos(ps, lim) {
    lim = lim || 0.7;
    const fora = new Set();
    for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
      const r = ps[j].f / ps[i].f;
      for (const h of [3, 5, 6, 7]) if (Math.abs(r / h - 1) < 0.015 && ps[j].m < lim * ps[i].m) { fora.add(j); break; }
    }
    return ps.filter((_, j) => !fora.has(j));
  }

  // Correlação do chroma com os 24 perfis (usada só pelo caminho chroma 'v2').
  function classificarChroma(chroma, desvio, o, vazio) {
    if (!chroma.some((v) => v > 0)) return vazio();
    const [pM, pm] = PERFIS[o.perfil], cand = [];
    for (let t = 0; t < 12; t++) {
      const rot = (perfil) => chroma.map((_, i) => perfil[(i - t + 12) % 12]);
      cand.push({ t, modo: 'major', r: pearson(chroma, rot(pM)) });
      cand.push({ t, modo: 'minor', r: pearson(chroma, rot(pm)) });
    }
    cand.sort((a, b) => b.r - a.r);
    const b = cand[0];
    return { key: NOTAS[b.t], scale: b.modo, strength: Math.max(0, b.r - cand[1].r), camelot: Camelot.paraCamelot(NOTAS[b.t], b.modo),
      chroma, afinacaoCents: Math.round(desvio * 10000) / 100, correlacao: b.r };
  }

  // chroma 'misto': para cada um dos 24 tons, a média (meio a meio) da correlação do chroma padrão e da
  // do chroma 'v2' com o mesmo perfil. `chroma` e `afinacaoCents` devolvidos são os do 'v2'. `sinal` já vem recortado.
  function analisarMisto(sinal, taxa, o, opcoes, vazio) {
    const antigo = analisarTom(sinal, taxa, Object.assign({}, opcoes, { chroma: undefined, maxSeg: 0 }));
    const r2 = Chroma2.calcularChroma(sinal, taxa, o.chroma2);
    const chromas = [antigo.chroma, r2.chroma].filter((c) => c.some((v) => v > 0));
    if (!chromas.length) return vazio();
    const [pM, pm] = PERFIS[o.perfil], cand = [];
    for (let t = 0; t < 12; t++) for (const [modo, perfil] of [['major', pM], ['minor', pm]]) {
      const rot = perfil.map((_, i) => perfil[(i - t + 12) % 12]);
      cand.push({ t, modo, r: chromas.reduce((s, c) => s + pearson(c, rot), 0) / chromas.length });
    }
    cand.sort((a, b) => b.r - a.r);
    const b = cand[0];
    return { key: NOTAS[b.t], scale: b.modo, strength: Math.max(0, b.r - cand[1].r), camelot: Camelot.paraCamelot(NOTAS[b.t], b.modo),
      chroma: r2.chroma, afinacaoCents: Math.round(r2.afinacaoSemitons * 10000) / 100, correlacao: b.r };
  }

  function analisarTom(sinal, taxa, opcoes) {
    const o = Object.assign({ tamanho: 4096, taxaAlvo: 11025, fMin: 65, fMax: 5000, perfil: 'shaath', supH: 0.7, expPeso: 0.5, agreg: 'media', fluxoMax: 0, pesoGrave: 0.6, maxSeg: 120, fGrave: 200 }, opcoes || {});
    const vazio = () => ({ key: 'C', scale: 'major', strength: 0, camelot: Camelot.paraCamelot('C', 'major'), chroma: new Array(12).fill(0), afinacaoCents: 0, correlacao: 0 });
    if (!sinal || sinal.length < 2) return vazio();
    if (o.maxSeg > 0 && sinal.length > o.maxSeg * taxa) { const n = Math.floor(o.maxSeg * taxa), a = (sinal.length - n) >> 1; sinal = sinal.subarray(a, a + n); } // recorte central
    if (o.chroma === 'misto') return analisarMisto(sinal, taxa, o, opcoes, vazio);
    if (o.chroma === 'v2') { // chroma alternativo (biblioteca/chroma2.js); sem a opção nada disto roda
      const r2 = Chroma2.calcularChroma(sinal, taxa, o.chroma2);
      return classificarChroma(r2.chroma, r2.afinacaoSemitons, o, vazio);
    }
    const x = taxa === o.taxaAlvo ? sinal : D.reamostrar(sinal, taxa, o.taxaAlvo);
    const T = o.tamanho, salto = T / 2;
    const quadros = D.stft(x, { tamanho: T, salto, janela: 'hann' });
    if (!quadros.length) return vazio();
    const fMax = Math.min(o.fMax, o.taxaAlvo / 2 * 0.95);

    // 1) picos por quadro; piso = 5% do maior pico do quadro (descarta ruído de fundo) e piso absoluto contra silêncio.
    const todos = []; let pesoTotal = 0;
    for (const mag of quadros) {
      let mx = 0; for (let k = 0; k < mag.length; k++) if (mag[k] > mx) mx = mag[k];
      if (mx < 1e-3 * T / 2 * 1e-2) { todos.push([]); continue; } // silêncio digital
      todos.push(picos(mag, o.taxaAlvo, T, o.fMin, fMax, mx * 0.05, o.supH));
    }
    // 2) afinação: desvio de cada pico para a grade temperada (A4=440), média circular em período de 100 cents.
    let sc = 0, ss = 0;
    for (const ps of todos) for (const p of ps) {
      const semi = 12 * Math.log2(p.f / 440), dev = semi - Math.round(semi); // −0,5..0,5 semitom
      const w = Math.pow(p.m, o.expPeso); sc += w * Math.cos(2 * Math.PI * dev); ss += w * Math.sin(2 * Math.PI * dev);
    }
    const desvio = (sc || ss) ? Math.atan2(ss, sc) / (2 * Math.PI) : 0; // semitons
    // 3) chroma acumulado, com a afinação corrigida; cada quadro normalizado (soma 1) para que trechos fortes não dominem.
    const chroma = new Array(12).fill(0), pilha = [];
    let fluxoAnt = null;
    for (const ps of todos) {
      if (!ps.length) continue;
      const q = new Array(12).fill(0); let soma = 0;
      for (const p of ps) {
        const semi = 12 * Math.log2(p.f / 440) - desvio, pc = (((Math.round(semi) + 9) % 12) + 12) % 12; // A=9
        const w = Math.pow(p.m, o.expPeso) * (p.f < o.fGrave ? 1 - o.pesoGrave : 1); q[pc] += w; soma += w;
      }
      if (soma > 0) { for (let i = 0; i < 12; i++) q[i] /= soma;
        if (o.fluxoMax > 0 && fluxoAnt) { let d = 0; for (let i = 0; i < 12; i++) d += Math.abs(q[i] - fluxoAnt[i]); fluxoAnt = q.slice(); if (d > o.fluxoMax) continue; } else fluxoAnt = q.slice();
        pilha.push(q); for (let i = 0; i < 12; i++) chroma[i] += q[i]; }
    }
    if (o.agreg === 'mediana' && pilha.length) for (let i = 0; i < 12; i++) { const v = pilha.map(q => q[i]).sort((a, b) => a - b); chroma[i] = v[v.length >> 1]; }
    let tot = 0; for (const v of chroma) tot += v;
    if (tot <= 0) return vazio();
    for (let i = 0; i < 12; i++) chroma[i] /= tot;
    // 4) correlação com os 24 perfis.
    const cand = [];
    for (let t = 0; t < 12; t++) {
      const rot = (perfil) => chroma.map((_, i) => perfil[(i - t + 12) % 12]);
      // chroma[i] ~ perfil[(i - t)] : perfil rotacionado para a tônica t
      const [pM, pm] = PERFIS[o.perfil];
      cand.push({ t, modo: 'major', r: pearson(chroma, rot(pM)) });
      cand.push({ t, modo: 'minor', r: pearson(chroma, rot(pm)) });
    }
    cand.sort((a, b) => b.r - a.r);
    const b = cand[0];
    return { key: NOTAS[b.t], scale: b.modo, strength: Math.max(0, b.r - cand[1].r), camelot: Camelot.paraCamelot(NOTAS[b.t], b.modo),
      chroma, afinacaoCents: Math.round(desvio * 10000) / 100, correlacao: b.r };
  }

  return { KK_MAIOR, KK_MENOR, PERFIS, NOTAS, pearson, analisarTom };
});
