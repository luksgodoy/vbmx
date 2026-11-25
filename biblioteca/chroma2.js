// VbMx — chroma v2 (VB-tom): escrito a partir de descrições publicadas, sem dependência e sem código de
// terceiros (nada de Essentia, KeyFinder ou outra fonte GPL/AGPL foi consultado). Técnicas e referências:
//   - Compressão logarítmica da magnitude, log(1 + γ·|X|): Müller, "Fundamentals of Music Processing" (2015), cap. 3.
//   - Separação harmônica/percussiva por filtro de mediana no espectrograma (mediana no tempo = harmônico,
//     mediana na frequência = percussivo, máscara suave): Fitzgerald, "Harmonic/Percussive Separation using
//     Median Filtering" (DAFx 2010).
//   - Branqueamento espectral (remover o envelope local para que os picos de notas não dependam do timbre):
//     Klapuri, "Multiple fundamental frequency estimation by summing harmonic amplitudes" (ISMIR 2006).
//   - HPCP: picos espectrais acima de um limiar, cada um contribuindo para as classes de altura das
//     fundamentais candidatas f/h (h = 1..nH) com peso s^(h−1): Gómez, "Tonal description of music audio
//     signals" (tese, UPF 2006).
//   - Estimativa de afinação por média circular do desvio dos picos para a grade temperada.
//   - Chroma final por mediana entre segmentos (em vez de média global), robusta a trechos atípicos.
// Roda no navegador (global `VbMxChroma2`, precisa de `VbMxDsp`) e no Node. Teste: node biblioteca/testar-chroma2.js.
//
// API:
//   calcularChroma(sinalMono, taxa, opcoes?) → { chroma: Array(12) soma 1 (índice 0 = C), afinacaoSemitons, quadros }
//   opcoes (padrões): tamanho 4096, taxaAlvo 11025, fMin 65, fMax 5000,
//     hpss true (separação H/P), hLen 9 (quadros, mediana no tempo), pLen 17 (bins, mediana na frequência),
//     gama 100 (compressão log; 0 desliga), branq true, branqLargura 40 (bins, ±),
//     limiarPico 0.1 (fração do maior pico do quadro), nH 4, s 0.6 (peso do h-ésimo harmônico),
//     expPeso 1, pesoGrave 0, fGrave 200, segmento 0 (quadros por segmento; 0 = média global),
//     espalhar false (cos² entre as duas classes vizinhas).
(function (raiz, fabrica) {
  const dsp = (typeof module === 'object' && module.exports) ? require('./dsp.js') : raiz.VbMxDsp;
  const api = fabrica(dsp);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.VbMxChroma2 = api;
})(typeof self !== 'undefined' ? self : this, function (D) {
  'use strict';

  const PADRAO = { tamanho: 4096, taxaAlvo: 11025, fMin: 65, fMax: 5000, hpss: true, hLen: 9, pLen: 17, gama: 100,
    branq: true, branqLargura: 40, limiarPico: 0.1, nH: 4, s: 0.6, expPeso: 1, pesoGrave: 0, fGrave: 200,
    segmento: 0, espalhar: false };

  function mediana(v, n) { // mediana de v[0..n) sem alterar v (n pequeno: ordenação por inserção numa cópia)
    const t = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = v[i]; let j = i - 1; while (j >= 0 && t[j] > x) { t[j + 1] = t[j]; j--; } t[j + 1] = x; }
    return t[n >> 1];
  }

  // Separação harmônica/percussiva (Fitzgerald 2010): devolve o espectrograma comprimido mascarado pela parte harmônica.
  function separarHP(S, k1, hLen, pLen) {
    const nQ = S.length, saida = new Array(nQ), halfH = hLen >> 1, halfP = pLen >> 1;
    const H = new Array(nQ);
    const buf = new Float32Array(Math.max(hLen, pLen));
    for (let q = 0; q < nQ; q++) {
      H[q] = new Float32Array(k1 + 1);
      for (let k = 0; k <= k1; k++) {
        let n = 0;
        for (let d = -halfH; d <= halfH; d++) { const qq = q + d; if (qq >= 0 && qq < nQ) buf[n++] = S[qq][k]; }
        H[q][k] = mediana(buf, n);
      }
    }
    for (let q = 0; q < nQ; q++) {
      const o = new Float32Array(k1 + 1), P = new Float32Array(k1 + 1);
      for (let k = 0; k <= k1; k++) {
        let n = 0;
        for (let d = -halfP; d <= halfP; d++) { const kk = k + d; if (kk >= 0 && kk <= k1) buf[n++] = S[q][kk]; }
        P[k] = mediana(buf, n);
      }
      for (let k = 0; k <= k1; k++) { const h2 = H[q][k] * H[q][k], p2 = P[k] * P[k]; o[k] = S[q][k] * (h2 + p2 > 0 ? h2 / (h2 + p2) : 0.5); }
      saida[q] = o;
    }
    return saida;
  }

  // Branqueamento: subtrai a média local em frequência (envelope), mantém só o que sobressai dele.
  function branquear(v, k1, larg) {
    const acc = new Float64Array(k1 + 2);
    for (let k = 0; k <= k1; k++) acc[k + 1] = acc[k] + v[k];
    const o = new Float32Array(k1 + 1);
    for (let k = 0; k <= k1; k++) {
      const a = Math.max(0, k - larg), b = Math.min(k1, k + larg);
      const m = (acc[b + 1] - acc[a]) / (b - a + 1);
      o[k] = Math.max(0, v[k] - m);
    }
    return o;
  }

  function picos(v, bin, k0, k1, limiar) {
    let mx = 0; for (let k = k0; k <= k1; k++) if (v[k] > mx) mx = v[k];
    const piso = Math.max(mx * limiar, 1e-9), saida = [];
    for (let k = Math.max(2, k0); k <= Math.min(v.length - 3, k1); k++) {
      const m = v[k];
      if (m > piso && m > v[k - 1] && m >= v[k + 1] && m > v[k - 2] && m >= v[k + 2]) {
        const a = Math.log(v[k - 1] + 1e-12), b = Math.log(m + 1e-12), c = Math.log(v[k + 1] + 1e-12);
        const den = a - 2 * b + c, d = den < 0 ? 0.5 * (a - c) / den : 0;
        saida.push({ f: (k + Math.max(-0.5, Math.min(0.5, d))) * bin, m });
      }
    }
    return saida;
  }

  function calcularChroma(sinal, taxa, opcoes) {
    const o = Object.assign({}, PADRAO, opcoes || {});
    const zero = { chroma: new Array(12).fill(0), afinacaoSemitons: 0, quadros: 0 };
    if (!sinal || sinal.length < o.tamanho) return zero;
    const x = taxa === o.taxaAlvo ? sinal : D.reamostrar(sinal, taxa, o.taxaAlvo);
    const T = o.tamanho, bin = o.taxaAlvo / T;
    const quadros = D.stft(x, { tamanho: T, salto: T / 2, janela: 'hann' });
    if (!quadros.length) return zero;
    const fMax = Math.min(o.fMax, o.taxaAlvo / 2 * 0.95);
    const k0 = Math.max(2, Math.floor(o.fMin / bin)), k1 = Math.min(quadros[0].length - 3, Math.ceil(fMax / bin));
    // 1) compressão logarítmica
    let S = quadros.map((m) => { const c = new Float32Array(k1 + 3); for (let k = 0; k <= Math.min(k1 + 2, m.length - 1); k++) c[k] = o.gama > 0 ? Math.log(1 + o.gama * m[k] / (T / 4)) : m[k]; return c; });
    // 2) separação H/P
    if (o.hpss) S = separarHP(S, k1 + 2, o.hLen, o.pLen);
    // 3) branqueamento
    if (o.branq) S = S.map((v) => branquear(v, k1 + 2, o.branqLargura));
    // 4) picos por quadro
    const todos = S.map((v) => picos(v, bin, k0, k1, o.limiarPico));
    // 5) afinação: média circular (período de 1 semitom) do desvio dos picos
    let sc = 0, ss = 0;
    for (const ps of todos) for (const p of ps) {
      const semi = 12 * Math.log2(p.f / 440), dev = semi - Math.round(semi), w = Math.pow(p.m, o.expPeso);
      sc += w * Math.cos(2 * Math.PI * dev); ss += w * Math.sin(2 * Math.PI * dev);
    }
    const desvio = (sc || ss) ? Math.atan2(ss, sc) / (2 * Math.PI) : 0;
    // 6) HPCP por quadro
    const qs = [];
    for (const ps of todos) {
      if (!ps.length) continue;
      const q = new Array(12).fill(0); let soma = 0;
      for (const p of ps) {
        const wp = Math.pow(p.m, o.expPeso);
        for (let h = 1; h <= o.nH; h++) {
          const f0 = p.f / h; if (f0 < o.fMin * 0.9) break;
          const semi = 12 * Math.log2(f0 / 440) - desvio + 9; // 0 = C
          const w = wp * Math.pow(o.s, h - 1) * (f0 < o.fGrave ? 1 - o.pesoGrave : 1);
          if (o.espalhar) {
            const i0 = Math.floor(semi), fr = semi - i0, c = Math.cos(Math.PI * fr / 2);
            q[((i0 % 12) + 12) % 12] += w * c * c; q[(((i0 + 1) % 12) + 12) % 12] += w * (1 - c * c);
          } else q[(((Math.round(semi)) % 12) + 12) % 12] += w;
          soma += w;
        }
      }
      if (soma > 0) { for (let i = 0; i < 12; i++) q[i] /= soma; qs.push(q); }
    }
    if (!qs.length) return zero;
    // 7) agregação: média global ou mediana entre segmentos
    const chroma = new Array(12).fill(0);
    if (o.segmento > 0 && qs.length >= 2 * o.segmento) {
      const segs = [];
      for (let a = 0; a + o.segmento <= qs.length; a += o.segmento) {
        const m = new Array(12).fill(0);
        for (let i = a; i < a + o.segmento; i++) for (let c = 0; c < 12; c++) m[c] += qs[i][c];
        segs.push(m);
      }
      for (let c = 0; c < 12; c++) { const v = segs.map((m) => m[c]).sort((p, r) => p - r); chroma[c] = v[v.length >> 1]; }
    } else for (const q of qs) for (let c = 0; c < 12; c++) chroma[c] += q[c];
    let tot = 0; for (const v of chroma) tot += v;
    if (tot <= 0) return zero;
    for (let i = 0; i < 12; i++) chroma[i] /= tot;
    return { chroma, afinacaoSemitons: desvio, quadros: qs.length };
  }

  return { PADRAO, calcularChroma, separarHP, branquear };
});
