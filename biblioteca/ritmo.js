// VbMx — análise de ritmo própria (andamento e batidas), escrita só a partir de artigos e matemática:
// fluxo espectral com compressão logarítmica por faixas (Scheirer 1998; Klapuri), tempograma por
// autocorrelação do envelope de ataques, prior de andamento em oitavas e rastreio de batidas por
// programação dinâmica (Ellis 2007, "Beat Tracking by Dynamic Programming"). Sem dependência e sem
// código de terceiros. Usa VbMxDsp (dsp.js). Roda no navegador (global `VbMxRitmo`) e no Node.
// Teste: biblioteca/testar-ritmo.js.
//
// API:
//   analisarRitmo(sinalMono, taxa, opcoes) → { bpm, confianca, ticks, candidatos }
//     sinalMono: Float32Array mono; taxa: Hz. opcoes: { bpmMin: 60, bpmMax: 208 (teto do painel),
//       priorCentro: 130, priorLargura: 0.5 (oitavas), rigidez: 100 (peso do custo de transição do DP) }.
//     bpm        número, no intervalo [bpmMin, bpmMax); 0 se não há ataque nenhum (sinal mudo).
//     confianca  0..1: proeminência do pico do tempograma sobre a mediana do espectro de andamento.
//     ticks      Array<number> de segundos DENTRO do sinal analisado (0 = primeira amostra), crescente,
//                das batidas do rastreio, sem as anteriores ao primeiro ataque. Atraso de análise já descontado.
//     Grade por pente: o período do rastreio é refinado numa varredura de ±1,5% (grossa a 0,02%, fina a
//     0,002%) que maximiza a nitidez do envelope dobrado; a fase é o pico desse perfil e os ticks viram
//     uma grade regular. Só vale se concordar com o rastreio em 2%; senão ficam o bpm e os ticks do DP.
//     Limite conhecido: a fase pode cair no contratempo (meia batida) em faixas reais.
//     candidatos [{ nome:'tempograma', bpm }, { nome:'rastreio', bpm, ticks }] — independentes: o primeiro
//                sai só da autocorrelação, o segundo da reta ajustada nos ticks do DP (bpm refinado).
//                O mesmo formato { nome, bpm, ticks? } que bpm.js e biblioteca.js consomem.
//   envelopeAtaques(sinalMono, taxa) → { env: Float32Array, fps, latencia } envelope de ataques (uma
//     amostra a cada 1/fps s; `latencia` s a SOMAR ao índice/fps para ter o instante do ataque).
(function (raiz, fabrica) {
  const api = fabrica(typeof module === 'object' && module.exports ? require('./dsp.js') : raiz.VbMxDsp);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.VbMxRitmo = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Dsp) {
  'use strict';

  const TAXA_ALVO = 11025, TAM = 512, SALTO = 64;
  // Atraso de análise (s): o fluxo acusa o ataque ~35 ms ANTES do instante real (a borda da janela de
  // 512 amostras já enxerga o clique). Medido em cliques, bumbo e rajada de ruído: -34..-36 ms nos três.
  const LATENCIA_S = 0.0355;
  const FAIXAS_HZ = [0, 150, 400, 1000, 2500, 5500];
  const MARGEM_RAZAO = 1.15; // pente do andamento 3/4 ou 2/3 mais lento precisa ganhar por isso (ver tempograma)

  function decimar(sinal, taxa) {
    if (Math.abs(taxa - TAXA_ALVO) < 1) return { x: sinal, taxa };
    const r = taxa / TAXA_ALVO;
    if (Math.abs(r - Math.round(r)) < 1e-9 && r >= 1) { // razão inteira: média de blocos (passa-baixa simples)
      const f = Math.round(r), n = Math.floor(sinal.length / f), x = new Float32Array(n);
      for (let i = 0; i < n; i++) { let s = 0; for (let j = 0; j < f; j++) s += sinal[i * f + j]; x[i] = s / f; }
      return { x, taxa: taxa / f };
    }
    return { x: Dsp.reamostrar(sinal, taxa, TAXA_ALVO), taxa: TAXA_ALVO };
  }

  function envelopeAtaques(sinalMono, taxa) {
    const { x, taxa: fs } = decimar(sinalMono, taxa);
    const quadros = Dsp.stft(x, { tamanho: TAM, salto: SALTO, janela: 'hann' });
    const nb = FAIXAS_HZ.length - 1, lim = FAIXAS_HZ.map(h => Math.min(TAM / 2, Math.round(h * TAM / fs)));
    const n = quadros.length, env = new Float32Array(n);
    let ant = new Float64Array(nb);
    for (let i = 0; i < n; i++) {
      const q = quadros[i];
      let fluxo = 0;
      for (let b = 0; b < nb; b++) {
        let e = 0;
        for (let k = lim[b]; k < Math.max(lim[b] + 1, lim[b + 1]); k++) e += q[k];
        const l = Math.log(1 + 1000 * e / TAM); // compressão logarítmica (a banda grave não afoga os agudos)
        if (i > 0 && l > ant[b]) fluxo += l - ant[b];
        ant[b] = l;
      }
      env[i] = fluxo;
    }
    // tira a média local (~1 s) e retifica: sobram só os picos acima do fundo
    const fps = fs / SALTO, jan = Math.max(3, Math.round(fps)), pref = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) pref[i + 1] = pref[i] + env[i];
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - jan), b = Math.min(n, i + jan + 1);
      const v = env[i] - (pref[b] - pref[a]) / (b - a);
      out[i] = v > 0 ? v : 0;
    }
    return { env: out, fps, latencia: LATENCIA_S };
  }

  const mediana = (v) => { const o = Array.from(v).sort((a, b) => a - b); return o.length ? o[o.length >> 1] : 0; };

  // autocorrelação normalizada (por sobreposição) do envelope, lags 0..maxLag
  function acf(env, maxLag) {
    const n = env.length, r = new Float64Array(maxLag + 1);
    let m = 0; for (let i = 0; i < n; i++) m += env[i]; m /= (n || 1);
    const e = new Float64Array(n); for (let i = 0; i < n; i++) e[i] = env[i] - m;
    for (let l = 0; l <= maxLag && l < n; l++) {
      let s = 0; for (let i = l; i < n; i++) s += e[i] * e[i - l];
      r[l] = s / (n - l);
    }
    const r0 = r[0] || 1; for (let l = 0; l <= maxLag; l++) r[l] /= r0;
    return r;
  }
  const interp = (r, x) => { const i = Math.floor(x); if (i < 0 || i + 1 >= r.length) return 0; const f = x - i; return r[i] * (1 - f) + r[i + 1] * f; };

  // Espectro de andamento: soma das 4 primeiras harmônicas do período (pente) da autocorrelação, com
  // prior log-gaussiano em oitavas. Devolve { bpm, confianca, curva }.
  function tempograma(env, fps, o) {
    const harm = 4, maxLag = Math.ceil(fps * 60 / o.bpmMin * harm) + 2;
    const r = acf(env, Math.min(maxLag, env.length - 1));
    const passo = 0.05, pts = [];
    for (let bpm = o.bpmMin; bpm < o.bpmMax; bpm += passo) {
      const lag = fps * 60 / bpm;
      let s = 0, c = 0;
      for (let k = 1; k <= harm; k++) { if (lag * k >= r.length - 1) break; s += interp(r, lag * k); c++; }
      const prior = Math.exp(-0.5 * (Math.log2(bpm / o.priorCentro) / o.priorLargura) ** 2);
      pts.push({ bpm, s: c ? s / c : 0, v: (c ? s / c : 0) * prior });
    }
    let mi = 0; for (let i = 1; i < pts.length; i++) if (pts[i].v > pts[mi].v) mi = i;
    // Ambiguidade 3:4 / 2:3 (polirritmia, hemíola): o prior pode puxar para a relação mais rápida (×4/3, ×3/2)
    // mesmo quando o pente do andamento mais lento é bem mais forte (soma bruta s). Passa para o mais lento
    // só se o pente dele ganha por MARGEM_RAZAO e o prior não o enterra (v ≥ 60 % do vencedor).
    // Medido em faixa real (133,3 vs 100,0 do Essentia): s 0,683 contra 0,545 (×1,25), v 0,513 contra 0,544.
    for (const razao of [3 / 4, 2 / 3]) {
      const alvo = pts[mi].bpm * razao; if (alvo < o.bpmMin) continue;
      let j = -1;
      for (let i = 0; i < pts.length; i++) if (Math.abs(pts[i].bpm / alvo - 1) <= 0.015 && (j < 0 || pts[i].s > pts[j].s)) j = i;
      if (j >= 0 && pts[j].s >= MARGEM_RAZAO * pts[mi].s && pts[j].v >= 0.6 * pts[mi].v) { mi = j; break; }
    }
    const med = mediana(pts.map(p => p.s)), pico = pts[mi].s;
    const conf = pico > 0 ? Math.max(0, Math.min(1, (pico - med) / (Math.abs(pico) + 1e-12))) : 0;
    return { bpm: pts[mi].bpm, confianca: conf, pontos: pts };
  }

  // Ellis 2007: C[t] = o[t] + max_τ (C[τ] − α·ln²((t−τ)/p)); volta pelo melhor predecessor. Índices em quadros.
  function rastrear(env, fps, bpm, rigidez) {
    const n = env.length, p = fps * 60 / bpm;
    let mx = 0; for (let i = 0; i < n; i++) if (env[i] > mx) mx = env[i];
    if (!(mx > 0) || n < 4) return [];
    const o = new Float64Array(n); for (let i = 0; i < n; i++) o[i] = env[i] / mx;
    const C = new Float64Array(n), pre = new Int32Array(n).fill(-1);
    const lo = Math.max(1, Math.round(p / 2)), hi = Math.round(p * 2);
    const custo = new Float64Array(hi + 1);
    for (let d = lo; d <= hi; d++) custo[d] = rigidez * Math.log(d / p) ** 2 / 100;
    for (let t = 0; t < n; t++) {
      let melhor = 0, bp = -1; // começar uma cadeia aqui vale 0
      for (let d = lo; d <= hi && d <= t; d++) { const v = C[t - d] - custo[d]; if (v > melhor) { melhor = v; bp = t - d; } }
      C[t] = o[t] + melhor; pre[t] = bp;
    }
    // melhor final: entre os picos da última 1,5 batida
    let fim = n - 1; const ini = Math.max(0, n - Math.round(p * 1.5));
    for (let t = ini; t < n; t++) if (C[t] > C[fim]) fim = t;
    const idx = []; for (let t = fim; t >= 0; t = pre[t]) { idx.push(t); if (pre[t] < 0) break; }
    return idx.reverse();
  }

  // posição sub-quadro do pico perto de `i`
  function picoFino(env, i) {
    let m = i;
    for (let j = Math.max(0, i - 2); j <= Math.min(env.length - 1, i + 2); j++) if (env[j] > env[m]) m = j;
    if (m <= 0 || m >= env.length - 1) return m;
    const a = env[m - 1], b = env[m], c = env[m + 1], d = a - 2 * b + c;
    return d < 0 ? m + 0.5 * (a - c) / d : m;
  }

  // reta t = fase + período·k pelos ticks (k = arredondado ao período), com descarte de outliers
  function ajustarReta(ticks, periodo) {
    if (ticks.length < 4) return null;
    let k = ticks.map(t => Math.round((t - ticks[0]) / periodo)), t = ticks.slice(), per = periodo, fase = ticks[0];
    for (let it = 0; it < 4; it++) {
      const n = t.length; if (n < 4) break;
      const mk = k.reduce((a, b) => a + b, 0) / n, mt = t.reduce((a, b) => a + b, 0) / n;
      let sxy = 0, sxx = 0; for (let i = 0; i < n; i++) { sxy += (k[i] - mk) * (t[i] - mt); sxx += (k[i] - mk) ** 2; }
      if (!(sxx > 0)) break;
      per = sxy / sxx; fase = mt - per * mk;
      const res = t.map((x, i) => Math.abs(x - fase - per * k[i])), corte = Math.max(0.015, 3 * mediana(res) * 1.4826);
      const ficam = res.map((r, i) => i).filter(i => res[i] <= corte);
      if (ficam.length === n || ficam.length < 4) break;
      t = ficam.map(i => t[i]); k = ficam.map(i => k[i]);
    }
    return { periodo: per, fase };
  }


  // Refino global (grade por pente): dobra o envelope pelo período candidato e mede a nitidez do perfil de
  // fase (soma dos quadrados do histograma suavizado). A varredura fina do período (±1,5 %, passo 0,005 %)
  // trava o andamento com a precisão que a reta dos ticks do DP não tem em faixa longa (deriva).
  function perfilFase(env, fps, per, ini, fim, nb) {
    const h = new Float64Array(nb), q = per * fps;
    for (let i = ini; i < fim; i++) {
      const v = env[i]; if (!(v > 0)) continue;
      const f = ((i / q) % 1) * nb, b = Math.floor(f), w = f - b;
      h[b % nb] += v * (1 - w); h[(b + 1) % nb] += v * w;
    }
    return h;
  }
  function nitidez(h) { // suaviza (±1 bin, triangular) e soma quadrados
    const nb = h.length; let s = 0;
    for (let b = 0; b < nb; b++) { const v = 0.25 * h[(b + nb - 1) % nb] + 0.5 * h[b] + 0.25 * h[(b + 1) % nb]; s += v * v; }
    return s;
  }
  function refinarPente(env, fps, bpm0, ini, fim) {
    const aval = (bpm) => { const per = 60 / bpm; return nitidez(perfilFase(env, fps, per, ini, fim, Math.max(16, Math.round(per * fps * 3)))); };
    let melhor = { s: -1, r: 0 };
    for (let r = -0.015; r <= 0.015 + 1e-12; r += 0.0002) { const s = aval(bpm0 * (1 + r)); if (s > melhor.s) melhor = { s, r }; }
    const c = melhor.r; melhor = { s: -1, r: c };
    for (let r = c - 0.00022; r <= c + 0.00022 + 1e-12; r += 0.00002) { const s = aval(bpm0 * (1 + r)); if (s > melhor.s) melhor = { s, r }; }
    return bpm0 * (1 + melhor.r);
  }

  // grade regular: fase do pico do perfil dobrado, a partir do período refinado
  function gradePente(env, fps, bpm, latencia) {
    const per = 60 / bpm, nb = Math.round(per * 1000 / 3), h = perfilFase(env, fps, per, 0, env.length, nb);
    const sm = (i) => h[(i + nb) % nb] + 0.5 * (h[(i + nb - 1) % nb] + h[(i + 1) % nb]);
    let mb = 0; for (let b = 1; b < nb; b++) if (sm(b) > sm(mb)) mb = b;
    return { per, fase: mb / nb * per + 0.5 / fps + latencia };
  }

  function analisarRitmo(sinalMono, taxa, opcoes) {
    const o = Object.assign({ bpmMin: 60, bpmMax: 208, priorCentro: 130, priorLargura: 0.5, rigidez: 100 }, opcoes || {});
    const vazio = { bpm: 0, confianca: 0, ticks: [], candidatos: [] };
    if (!sinalMono || !(taxa > 0)) return vazio;
    const { env, fps, latencia } = envelopeAtaques(sinalMono, taxa);
    if (env.length < fps * 3) return vazio;
    let mx = 0; for (let i = 0; i < env.length; i++) if (env[i] > mx) mx = env[i];
    if (!(mx > 1e-6)) return vazio;
    const tg = tempograma(env, fps, o);
    const candidatos = [{ nome: 'tempograma', bpm: tg.bpm }];
    // rastreio (Ellis) a partir do andamento do tempograma; o bpm sai da reta nos ticks
    const idx = rastrear(env, fps, tg.bpm, o.rigidez);
    let ticksF = idx.map(i => (picoFino(env, i) + 0.5) / fps + latencia);
    // descarta as pontas fracas: ticks (antes do 1º ataque de verdade, ou no fim, onde o DP cai num
    // contratempo/chimbal) cuja força de ataque é menor que 40% da mediana dos ticks
    const forca = idx.map(i => Math.max(env[Math.max(0, i - 2)], env[i], env[Math.min(env.length - 1, i + 2)]));
    const corte = 0.4 * mediana(forca);
    let a = 0, z = idx.length;
    while (a < z && forca[a] < corte) a++;
    while (z > a && forca[z - 1] < corte) z--;
    ticksF = ticksF.slice(a, z);
    let bpmFinal = tg.bpm;
    let reta = ajustarReta(ticksF, 60 / tg.bpm);
    if (reta) { // tick a mais de 1/4 de batida da reta é contratempo (chimbal), não batida: cai
      const f = ticksF.filter(t => { const q = (t - reta.fase) / reta.periodo; return Math.abs(q - Math.round(q)) <= 0.25; });
      if (f.length >= 4 && f.length < ticksF.length) { ticksF = f; reta = ajustarReta(ticksF, 60 / tg.bpm) || reta; }
    }
    if (reta && Math.abs(60 / reta.periodo - tg.bpm) / tg.bpm <= 0.03) {
      bpmFinal = 60 / reta.periodo;
      candidatos.push({ nome: 'rastreio', bpm: bpmFinal, ticks: ticksF });
    } else candidatos.push({ nome: 'rastreio', bpm: tg.bpm, ticks: ticksF });
    // grade por pente: período travado em faixa inteira; só vale se o período refinado concorda com o DP (±2 %)
    const bp = refinarPente(env, fps, bpmFinal, 0, env.length);
    if (Math.abs(bp - bpmFinal) / bpmFinal <= 0.02 && ticksF.length >= 4) {
      const g = gradePente(env, fps, bp, latencia), dur = env.length / fps;
      {
        bpmFinal = bp;
        const grade = []; for (let t = g.fase + Math.ceil((ticksF[0] - g.fase - 0.25 * g.per) / g.per) * g.per; t < dur; t += g.per) grade.push(t);
        ticksF = grade; candidatos[1] = { nome: 'rastreio', bpm: bp, ticks: grade };
      }
    }
    return { bpm: bpmFinal, confianca: tg.confianca, ticks: ticksF, candidatos };
  }

  return { analisarRitmo, envelopeAtaques, TAXA_ALVO, TAM, SALTO };
});
