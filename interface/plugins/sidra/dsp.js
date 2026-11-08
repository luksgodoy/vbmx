// DSP do separador no navegador: STFT/ISTFT em modo CaC (complex-as-channels) do htdemucs,
// janelas com sobreposicao e fusao ponderada. Porte de ~/Stem Pessoal/stems.py
// (espectro_cac, ispectro_cac, janela_pesos, aplicar_modelo, separar).
// Sem dependencias: roda igual no Web Worker e no Node (teste de validacao).

export const NFFT = 4096;
export const HOP = 1024;
export const SEGMENTO = 343980;               // amostras por janela (7,8 s a 44,1 kHz), fixo no ONNX
export const FONTES = ["drums", "bass", "other", "vocals"];   // ordem de saida do modelo
export const TAXA = 44100;

const PAD = (HOP / 2) * 3;                    // 1536, pre-pad do Demucs
const FQ = NFFT / 2;                          // 2048 bins (o ultimo, Nyquist, e descartado)

// ------------------------------------------------------------------ FFT complexa radix-2
class FFT {
  constructor(n) {
    this.n = n;
    const bits = Math.log2(n);
    this.rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n);
      this.sin[i] = Math.sin((2 * Math.PI * i) / n);
    }
  }
  // in-place; sinal = -1 direta, +1 inversa (sem 1/n)
  rodar(re, im, sinal) {
    const n = this.n, rev = this.rev;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let tam = 2; tam <= n; tam <<= 1) {
      const meio = tam >> 1, passo = n / tam;
      for (let ini = 0; ini < n; ini += tam) {
        for (let k = 0, t = 0; k < meio; k++, t += passo) {
          const wr = this.cos[t], wi = sinal * this.sin[t];
          const a = ini + k, b = a + meio;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
        }
      }
    }
  }
}

const fft = new FFT(NFFT);
// hann periodica (torch.hann_window padrao)
const HANN = new Float64Array(NFFT);
for (let i = 0; i < NFFT; i++) HANN[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / NFFT);
const ESCALA = 1 / Math.sqrt(NFFT);           // normalized=True

// indice com reflexao sem repetir a borda (torch "reflect")
function reflete(i, n) {
  while (i < 0 || i >= n) {
    if (i < 0) i = -i;
    if (i >= n) i = 2 * (n - 1) - i;
  }
  return i;
}

function quadros(L) { return Math.ceil(L / HOP); }

/**
 * STFT CaC de um trecho estereo de comprimento L.
 * esq, dir: Float32Array(L). Devolve Float32Array(4*FQ*T) no layout (4, FQ, T),
 * canais [esq.re, esq.im, dir.re, dir.im] — igual a espectro_cac de stems.py.
 */
export function espectroCac(esq, dir, L = esq.length) {
  const le = quadros(L);
  const padDir = PAD + le * HOP - L;
  const n1 = L + PAD + padDir;                // depois do pad1d do Demucs
  const c = NFFT / 2;                         // center=True do torch.stft
  const n2 = n1 + 2 * c;
  // sinal com os dois pads de reflexao, materializado (2 canais)
  const xl = new Float64Array(n2), xr = new Float64Array(n2);
  for (let i = 0; i < n2; i++) {
    const j1 = reflete(i - c, n1);            // indice no sinal com pad1d
    const j0 = reflete(j1 - PAD, L);          // indice no sinal original
    xl[i] = esq[j0]; xr[i] = dir[j0];
  }
  const T = le;
  const out = new Float32Array(4 * FQ * T);
  const re = new Float64Array(NFFT), im = new Float64Array(NFFT);
  for (let t = 0; t < T; t++) {
    const ini = (t + 2) * HOP;                // quadros 2 .. 2+le
    for (let n = 0; n < NFFT; n++) {
      const w = HANN[n];
      re[n] = xl[ini + n] * w;                // dois sinais reais numa FFT complexa: esq + i*dir
      im[n] = xr[ini + n] * w;
    }
    fft.rodar(re, im, -1);
    for (let k = 0; k < FQ; k++) {
      const nk = (NFFT - k) & (NFFT - 1);
      // separa: A = (Z[k] + conj Z[N-k]) / 2 ; B = (Z[k] - conj Z[N-k]) / (2i)
      const ar = 0.5 * (re[k] + re[nk]), ai = 0.5 * (im[k] - im[nk]);
      const br = 0.5 * (im[k] + im[nk]), bi = -0.5 * (re[k] - re[nk]);
      out[(0 * FQ + k) * T + t] = ar * ESCALA;
      out[(1 * FQ + k) * T + t] = ai * ESCALA;
      out[(2 * FQ + k) * T + t] = br * ESCALA;
      out[(3 * FQ + k) * T + t] = bi * ESCALA;
    }
  }
  return out;
}

// envelope da janela (soma de w^2 dos quadros), so depende de T: calculado uma vez
const envCache = new Map();
function envelope(nq) {
  if (envCache.has(nq)) return envCache.get(nq);
  const tam = NFFT + HOP * (nq - 1);
  const env = new Float64Array(tam);
  for (let t = 0; t < nq; t++) for (let n = 0; n < NFFT; n++) env[t * HOP + n] += HANN[n] * HANN[n];
  envCache.set(nq, env);
  return env;
}

/**
 * ISTFT CaC de uma fonte: espectro em xfreq (layout (S,4,FQ,T)) da fonte s -> [esq, dir] Float32Array(L).
 * Igual a ispectro_cac de stems.py (pad de 1 bin e 2 quadros de cada lado, istft normalized/center).
 */
export function ispectroCac(xfreq, s, T, L) {
  const nq = T + 4;                           // 2 quadros zerados de cada lado
  const env = envelope(nq);
  const tam = NFFT + HOP * (nq - 1);
  const ola = new Float64Array(tam * 2);      // esq | dir
  const re = new Float64Array(NFFT), im = new Float64Array(NFFT);
  const base = s * 4 * FQ * T;
  const esc = Math.sqrt(NFFT) / NFFT;         // normalized=True e 1/N da irfft
  for (let t = 0; t < T; t++) {
    // Z = A + iB, A e B hermitianos (espectros de esq e dir)
    for (let k = 0; k < FQ; k++) {
      const ar = xfreq[base + (0 * FQ + k) * T + t];
      const ai = k === 0 ? 0 : xfreq[base + (1 * FQ + k) * T + t];   // irfft ignora Im do DC
      const br = xfreq[base + (2 * FQ + k) * T + t];
      const bi = k === 0 ? 0 : xfreq[base + (3 * FQ + k) * T + t];
      re[k] = ar - bi; im[k] = ai + br;
      if (k > 0) {
        const nk = NFFT - k;                  // conj(A) + i conj(B)
        re[nk] = ar + bi; im[nk] = -ai + br;
      }
    }
    re[FQ] = 0; im[FQ] = 0;                   // bin de Nyquist (zerado pelo pad)
    fft.rodar(re, im, +1);
    const ini = (t + 2) * HOP;
    for (let n = 0; n < NFFT; n++) {
      const w = HANN[n] * esc;
      ola[ini + n] += re[n] * w;
      ola[tam + ini + n] += im[n] * w;
    }
  }
  // center=True remove NFFT/2; depois o Demucs corta PAD
  const desl = NFFT / 2 + PAD;
  const esq = new Float32Array(L), dir = new Float32Array(L);
  for (let i = 0; i < L; i++) {
    const j = desl + i, e = env[j];
    esq[i] = ola[j] / e;
    dir[i] = ola[tam + j] / e;
  }
  return [esq, dir];
}

/** Peso triangular da fusao (janela_pesos 'triangular', potencia 1). */
export function pesoTriangular(n) {
  const w = new Float32Array(n);
  const h = Math.floor(n / 2);
  const mx = Math.max(h, n - h);
  for (let i = 0; i < h; i++) w[i] = (i + 1) / mx;
  for (let i = h; i < n; i++) w[i] = (n - i) / mx;
  return w;
}

/** Normalizacao do mix: media e desvio (n-1) do mono, como separar() de stems.py. */
export function estatisticas(esq, dir) {
  const N = esq.length;
  let soma = 0;
  for (let i = 0; i < N; i++) soma += 0.5 * (esq[i] + dir[i]);
  const media = soma / N;
  let q = 0;
  for (let i = 0; i < N; i++) { const d = 0.5 * (esq[i] + dir[i]) - media; q += d * d; }
  const desvio = Math.sqrt(q / Math.max(1, N - 1)) + 1e-8;
  return { media, desvio };
}

/** Plano das janelas: offsets e o recorte com contexto real (TensorChunk.padded do Demucs). */
export function planoJanelas(N, L = SEGMENTO, overlap = 0.25) {
  const passo = Math.max(1, Math.floor((1 - overlap) * L));
  const jan = [];
  for (let off = 0; off < N; off += passo) {
    const real = Math.min(L, N - off);
    const delta = L - real;
    const ini = off - Math.floor(delta / 2);
    jan.push({ off, real, delta, ini });
  }
  return jan;
}

/** Monta o trecho de L amostras (normalizado) de uma janela: contexto real + zeros fora do audio. */
export function recorte(esq, dir, j, L, media, desvio) {
  const N = esq.length;
  const a = new Float32Array(L), b = new Float32Array(L);
  for (let i = 0; i < L; i++) {
    const p = j.ini + i;
    if (p >= 0 && p < N) { a[i] = (esq[p] - media) / desvio; b[i] = (dir[p] - media) / desvio; }
  }
  return [a, b];
}

/**
 * Separa com um executor de modelo assincrono.
 * rodar(mix Float32Array(2*L), cac Float32Array(4*FQ*T)) -> {xfreq: Float32Array(S*4*FQ*T), xtempo: Float32Array(S*2*L)}
 * Devolve stems: Array S de [esq, dir] Float32Array(N), ja desnormalizados.
 */
export async function separar(esq, dir, rodar, { overlap = 0.25, progresso = () => {} } = {}) {
  const N = esq.length, L = SEGMENTO, S = FONTES.length, T = quadros(L);
  const { media, desvio } = estatisticas(esq, dir);
  const saida = FONTES.map(() => [new Float32Array(N), new Float32Array(N)]);
  const soma = new Float32Array(N);
  const peso = pesoTriangular(L);
  const jan = planoJanelas(N, L, overlap);
  for (let k = 0; k < jan.length; k++) {
    const j = jan[k];
    const [a, b] = recorte(esq, dir, j, L, media, desvio);
    const cac = espectroCac(a, b, L);
    const mix = new Float32Array(2 * L);
    mix.set(a, 0); mix.set(b, L);
    const { xfreq, xtempo } = await rodar(mix, cac);
    const o0 = Math.floor(j.delta / 2);
    for (let s = 0; s < S; s++) {
      const [we, wd] = ispectroCac(xfreq, s, T, L);
      const te = xtempo.subarray((s * 2) * L, (s * 2 + 1) * L);
      const td = xtempo.subarray((s * 2 + 1) * L, (s * 2 + 2) * L);
      const [oe, od] = saida[s];
      for (let i = 0; i < j.real; i++) {
        const w = peso[i];
        oe[j.off + i] += (we[o0 + i] + te[o0 + i]) * w;
        od[j.off + i] += (wd[o0 + i] + td[o0 + i]) * w;
      }
    }
    for (let i = 0; i < j.real; i++) soma[j.off + i] += peso[i];
    progresso(k + 1, jan.length);
  }
  for (const [oe, od] of saida) {
    for (let i = 0; i < N; i++) {
      oe[i] = (oe[i] / soma[i]) * desvio + media;
      od[i] = (od[i] / soma[i]) * desvio + media;
    }
  }
  return saida;
}

/** Pos-processamento 'rescale' de stems.py: se o pico conjunto passar de 0,999, reescala todos. */
export function reescalar(stems) {
  let pico = 0;
  for (const par of stems) for (const c of par) for (let i = 0; i < c.length; i++) { const v = Math.abs(c[i]); if (v > pico) pico = v; }
  if (pico > 0.999) {
    const g = 0.999 / pico;
    for (const par of stems) for (const c of par) for (let i = 0; i < c.length; i++) c[i] *= g;
  }
  return pico;
}

/** WAV PCM 16 ou 24 bits estereo -> ArrayBuffer. */
export function codificarWav(esq, dir, taxa, bits) {
  const N = esq.length, bps = bits / 8, bloco = 2 * bps;
  const buf = new ArrayBuffer(44 + N * bloco);
  const v = new DataView(buf);
  const txt = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  txt(0, "RIFF"); v.setUint32(4, 36 + N * bloco, true); txt(8, "WAVE");
  txt(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true);
  v.setUint32(24, taxa, true); v.setUint32(28, taxa * bloco, true); v.setUint16(32, bloco, true);
  v.setUint16(34, bits, true); txt(36, "data"); v.setUint32(40, N * bloco, true);
  const u8 = new Uint8Array(buf);
  const max = bits === 16 ? 32767 : 8388607;
  let o = 44;
  for (let i = 0; i < N; i++) {
    for (const c of [esq, dir]) {
      let x = Math.round(Math.max(-1, Math.min(1, c[i])) * max);
      if (bits === 16) { v.setInt16(o, x, true); o += 2; }
      else { if (x < 0) x += 1 << 24; u8[o] = x & 255; u8[o + 1] = (x >> 8) & 255; u8[o + 2] = (x >> 16) & 255; o += 3; }
    }
  }
  return buf;
}
