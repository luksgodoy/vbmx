// VbMx — base de processamento de sinal (DSP), escrita a partir da matemática (Cooley-Tukey radix-2,
// janelas de Hann/Hamming, filtro sinc com janela de Hann). Sem dependência e sem código de terceiros.
// Roda no navegador (global `VbMxDsp`) e no Node (`require`). Teste: biblioteca/testar-dsp.js.
//
// API (tudo em Float32Array; frequências em Hz; amplitudes sem unidade, em escala de amostra):
//   fft(re, im)                  → void. FFT direta in-place, radix-2; re.length === im.length, potência de 2.
//                                  Convenção X[k] = Σ x[n]·e^(-2πi·kn/N), sem normalização.
//   fftReal(sinal)               → Float32Array(N/2+1) de MAGNITUDES |X[k]| (k = 0..N/2); N = sinal.length, potência de 2.
//                                  Bin k corresponde a k·taxa/N Hz. Não altera `sinal`. Senoide de amplitude A no bin → A·N/2.
//   hann(n), hamming(n)          → Float32Array(n), janela simétrica-periódica (w[i] = a − b·cos(2πi/n)); n ≥ 1.
//   stft(sinal, {tamanho, salto, janela})
//                                → Array de Float32Array(tamanho/2+1): magnitudes por quadro (como fftReal, com janela aplicada).
//                                  tamanho: potência de 2 (padrão 2048); salto: amostras entre quadros (padrão tamanho/2);
//                                  janela: Float32Array(tamanho) ou 'hann' (padrão) | 'hamming' | 'retangular'.
//                                  Só quadros completos: nQuadros = floor((len − tamanho)/salto) + 1 (0 se o sinal é menor).
//   reamostrar(sinal, taxaOrigem, taxaDestino)
//                                → Float32Array com round(len·destino/origem) amostras. Filtro passa-baixa (sinc janelado,
//                                  corte em 0,95 do Nyquist de destino) aplicado antes de decimar; interpolação pelo próprio
//                                  filtro, serve para razões não inteiras. Taxas iguais devolvem cópia.
//   paraMono(canais)             → Float32Array: média dos canais (array de Float32Array do mesmo tamanho; 1 canal → cópia).
//   rms(sinal)                   → número: raiz da média dos quadrados (0 se vazio).
//   normalizar(sinal)            → novo Float32Array com pico absoluto 1 (sinal todo zero volta zeros; não altera o original).
(function (raiz, fabrica) {
  const api = fabrica();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.VbMxDsp = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const ehPot2 = (n) => n >= 1 && (n & (n - 1)) === 0;
  const cacheTab = new Map(); // n → { cos, sin, rev }
  function tabelas(n) {
    let t = cacheTab.get(n);
    if (t) return t;
    const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2), rev = new Uint32Array(n);
    for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / n); sin[i] = -Math.sin(2 * Math.PI * i / n); }
    let bits = 0; while ((1 << bits) < n) bits++;
    for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b); rev[i] = r; }
    t = { cos, sin, rev }; cacheTab.set(n, t);
    return t;
  }

  function fft(re, im) {
    const n = re.length;
    if (im.length !== n) throw new Error('fft: re e im com tamanhos diferentes');
    if (!ehPot2(n)) throw new Error('fft: o tamanho precisa ser potência de 2 (veio ' + n + ')');
    if (n === 1) return;
    const { cos, sin, rev } = tabelas(n);
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) { let a = re[i]; re[i] = re[j]; re[j] = a; a = im[i]; im[i] = im[j]; im[j] = a; }
    }
    for (let m = 2; m <= n; m <<= 1) {
      const meio = m >> 1, passo = n / m;
      for (let k = 0; k < n; k += m) {
        for (let j = 0, w = 0; j < meio; j++, w += passo) {
          const wr = cos[w], wi = sin[w], a = k + j, b = a + meio;
          const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
        }
      }
    }
  }

  function magnitudes(re, im, n) {
    const saida = new Float32Array(n / 2 + 1);
    for (let k = 0; k <= n / 2; k++) saida[k] = Math.hypot(re[k], im[k]);
    return saida;
  }

  function fftReal(sinal) {
    const n = sinal.length;
    if (!ehPot2(n)) throw new Error('fftReal: o tamanho precisa ser potência de 2 (veio ' + n + ')');
    const re = new Float32Array(sinal), im = new Float32Array(n);
    fft(re, im);
    return magnitudes(re, im, n);
  }

  function janelaCos(n, a, b) {
    const w = new Float32Array(n);
    for (let i = 0; i < n; i++) w[i] = a - b * Math.cos(2 * Math.PI * i / n);
    return w;
  }
  const hann = (n) => janelaCos(n, 0.5, 0.5);
  const hamming = (n) => janelaCos(n, 0.54, 0.46);

  function stft(sinal, opcoes) {
    const o = opcoes || {};
    const tamanho = o.tamanho || 2048, salto = o.salto || tamanho / 2;
    if (!ehPot2(tamanho)) throw new Error('stft: tamanho precisa ser potência de 2');
    let jan = o.janela === undefined ? 'hann' : o.janela;
    if (jan === 'hann') jan = hann(tamanho);
    else if (jan === 'hamming') jan = hamming(tamanho);
    else if (jan === 'retangular') jan = null;
    if (jan && jan.length !== tamanho) throw new Error('stft: janela com tamanho diferente de `tamanho`');
    const quadros = [];
    const re = new Float32Array(tamanho), im = new Float32Array(tamanho);
    for (let ini = 0; ini + tamanho <= sinal.length; ini += salto) {
      for (let i = 0; i < tamanho; i++) re[i] = jan ? sinal[ini + i] * jan[i] : sinal[ini + i];
      im.fill(0);
      fft(re, im);
      quadros.push(magnitudes(re, im, tamanho));
    }
    return quadros;
  }

  function reamostrar(sinal, taxaOrigem, taxaDestino) {
    if (!(taxaOrigem > 0) || !(taxaDestino > 0)) throw new Error('reamostrar: taxas devem ser positivas');
    if (taxaOrigem === taxaDestino) return new Float32Array(sinal);
    const razao = taxaOrigem / taxaDestino; // amostras de origem por amostra de saída
    const fc = 0.95 * 0.5 * Math.min(1, 1 / razao); // corte em ciclos/amostra de origem
    const zeros = 16, meia = zeros / (2 * fc); // largura do núcleo em amostras de origem
    const nSaida = Math.round(sinal.length / razao), saida = new Float32Array(nSaida), len = sinal.length;
    for (let i = 0; i < nSaida; i++) {
      const centro = i * razao, de = Math.max(0, Math.ceil(centro - meia)), ate = Math.min(len - 1, Math.floor(centro + meia));
      let soma = 0;
      for (let j = de; j <= ate; j++) {
        const x = j - centro, a = 2 * fc * x;
        const sinc = a === 0 ? 1 : Math.sin(Math.PI * a) / (Math.PI * a);
        soma += sinal[j] * sinc * (0.5 + 0.5 * Math.cos(Math.PI * x / meia));
      }
      saida[i] = soma * 2 * fc;
    }
    return saida;
  }

  function paraMono(canais) {
    if (!canais || !canais.length) return new Float32Array(0);
    if (canais.length === 1) return new Float32Array(canais[0]);
    const n = canais[0].length, saida = new Float32Array(n);
    for (const c of canais) for (let i = 0; i < n; i++) saida[i] += c[i];
    for (let i = 0; i < n; i++) saida[i] /= canais.length;
    return saida;
  }

  function rms(sinal) {
    if (!sinal.length) return 0;
    let s = 0; for (let i = 0; i < sinal.length; i++) s += sinal[i] * sinal[i];
    return Math.sqrt(s / sinal.length);
  }

  function normalizar(sinal) {
    let pico = 0; for (let i = 0; i < sinal.length; i++) pico = Math.max(pico, Math.abs(sinal[i]));
    const saida = new Float32Array(sinal.length);
    if (pico > 0) for (let i = 0; i < sinal.length; i++) saida[i] = sinal[i] / pico;
    return saida;
  }

  return { fft, fftReal, hann, hamming, stft, reamostrar, paraMono, rms, normalizar };
});
