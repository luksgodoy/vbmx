// VbMx — lógica pura da waveform dos decks e do CUE selecionável (pedido do Lucas, 2026-10-25).
//
// Sem DOM e sem Web Audio: a interface só desenha o que sai daqui. Roda no navegador (<script>
// expõe `VbMxWaveform`) e no Node (`require('./motor/waveform.js')`), e é embutido byte a byte em
// interface/classico.html, entre os marcadores de início e fim do bloco da waveform.
//
// Picos: { min, max: Float32Array, porSeg, duracao, pico } — um par min/max por fatia de 1/porSeg s,
// estéreo mixado (média dos canais). Mais: `grave`, `medio`, `agudo` (energia RMS por fatia, 3 bandas
// por filtros de dois polos em 200 Hz e 2,5 kHz) — saem da mesma passada, então o custo é o da carga, uma vez. Calculado UMA vez ao carregar a faixa; o quadro só lê.
// Estado de reprodução `e`: o mesmo de motor/reproducao.js { tocando, posicao, inicioCtx, taxa, duracao }.

(function (raiz, fabrica) {
  const api = fabrica();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.VbMxWaveform = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const PICOS_POR_SEG = 100;      // resolução fina guardada (zoom); a visão geral é derivada dela
  const JANELA_SEG = 8;           // zoom: 8 s de faixa na largura do deck, cabeça no centro
  const CORTE_GRAVE = 200, CORTE_AGUDO = 2500;   // Hz — grave < 200 < médio < 2500 < agudo (filtros de dois polos)
  const BANDAS = ['grave', 'medio', 'agudo'];
  const COMPENSA = [1, 2.5, 6];                   // médio e agudo têm menos energia nua; compensa na cor
  // Cor por banda: quanto mais alta a frequência, mais clara (spec §1, visualização).
  const COR_BANDA = [[38, 72, 205], [96, 168, 235], [236, 246, 255]];
  const CUE_TOLERANCIA = 0.05;    // s — "parado em cima do cue" (50 ms)

  const num = (x) => typeof x === 'number' && Number.isFinite(x);
  const trava = (x, min, max) => Math.min(max, Math.max(min, x));

  // ---- picos -------------------------------------------------------------------------------

  // canais: lista de Float32Array (1 = mono, 2 = estéreo…). Cada amostra é a média dos canais.
  function calcularPicos(canais, taxaAmostral, porSeg) {
    const pps = num(porSeg) && porSeg > 0 ? porSeg : PICOS_POR_SEG;
    const n = canais && canais.length ? canais[0].length : 0;
    if (!(n > 0) || !(taxaAmostral > 0)) {
      return { min: new Float32Array(0), max: new Float32Array(0), porSeg: pps, duracao: 0, pico: 0 };
    }
    const duracao = n / taxaAmostral;
    const cols = Math.max(1, Math.ceil(duracao * pps));
    const min = new Float32Array(cols).fill(Infinity), max = new Float32Array(cols).fill(-Infinity);
    const grave = new Float32Array(cols), medio = new Float32Array(cols), agudo = new Float32Array(cols), cont = new Uint32Array(cols);
    const nc = canais.length, amostrasPorCol = taxaAmostral / pps;
    const a1 = 1 - Math.exp(-2 * Math.PI * CORTE_GRAVE / taxaAmostral), a2 = 1 - Math.exp(-2 * Math.PI * CORTE_AGUDO / taxaAmostral);
    let l1 = 0, l1b = 0, l2 = 0, l2b = 0;
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let c = 0; c < nc; c++) s += canais[c][i];
      s /= nc;
      const col = Math.min(cols - 1, Math.floor(i / amostrasPorCol));
      if (s < min[col]) min[col] = s;
      if (s > max[col]) max[col] = s;
      l1 += a1 * (s - l1); l1b += a1 * (l1 - l1b);        // passa-baixas de 200 Hz (2 polos em cascata)
      l2 += a2 * (s - l2); l2b += a2 * (l2 - l2b);        // passa-baixas de 2,5 kHz (2 polos em cascata)
      const g = l1b, m = l2b - l1b, h = s - l2b;              // três bandas que somam o sinal
      grave[col] += g * g; medio[col] += m * m; agudo[col] += h * h; cont[col]++;
    }
    for (let k = 0; k < cols; k++) {                      // energia RMS por coluna
      const q = cont[k] || 1;
      grave[k] = Math.sqrt(grave[k] / q); medio[k] = Math.sqrt(medio[k] / q); agudo[k] = Math.sqrt(agudo[k] / q);
    }
    let pico = 0;
    for (let k = 0; k < cols; k++) {
      if (min[k] === Infinity) { min[k] = 0; max[k] = 0; }
      pico = Math.max(pico, Math.abs(min[k]), Math.abs(max[k]));
    }
    return { min, max, grave, medio, agudo, porSeg: pps, duracao, pico };
  }

  // Cor [r,g,b] de uma coluna a partir das energias das 3 bandas: média das cores das bandas,
  // ponderada pela energia (compensada); mais agudo → mais claro. Sem energia → cor do grave.
  function corDasBandas(grave, medio, agudo) {
    const w = [grave * COMPENSA[0], medio * COMPENSA[1], agudo * COMPENSA[2]].map((x) => (num(x) && x > 0 ? x : 0));
    const t = w[0] + w[1] + w[2];
    if (!(t > 1e-9)) return COR_BANDA[0].slice();
    const r = [0, 0, 0];
    for (let b = 0; b < 3; b++) for (let c = 0; c < 3; c++) r[c] += COR_BANDA[b][c] * (w[b] / t);
    return r.map(Math.round);
  }
  // Luminância relativa (0…255) da cor — o teste usa para provar "agudo é mais claro".
  const luminancia = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

  // Cores 'rgb(r,g,b)' por coluna fina, calculadas UMA vez e guardadas em `picos.cores` — o quadro
  // (60 fps) só lê o vetor. Sem bandas (formato antigo) devolve null e a interface usa a cor lisa.
  function coresPorColuna(picos) {
    if (!picos || !picos.grave) return null;
    if (!picos.cores) {
      picos.cores = new Array(picos.grave.length);
      for (let k = 0; k < picos.cores.length; k++) {
        const c = corDasBandas(picos.grave[k], picos.medio[k], picos.agudo[k]);
        picos.cores[k] = `rgb(${c[0]},${c[1]},${c[2]})`;
      }
    }
    return picos.cores;
  }

  // Média das bandas de `src` nas colunas [a,b) de `picos`, gravada em `dst[x]`.
  function mediaBandas(picos, dst, x, a, b) {
    if (!dst) return;
    for (const nome of BANDAS) {
      let soma = 0; for (let k = a; k < b; k++) soma += picos[nome][k];
      dst[nome][x] = soma / Math.max(1, b - a);
    }
  }

  // AudioBuffer (ou parecido: numberOfChannels, getChannelData, sampleRate).
  function picosDoBuffer(buf, porSeg) {
    const canais = [];
    for (let c = 0; c < buf.numberOfChannels; c++) canais.push(buf.getChannelData(c));
    return calcularPicos(canais, buf.sampleRate, porSeg);
  }

  // Resume os picos em `n` colunas cobrindo a faixa inteira (visão geral).
  function reduzir(picos, n) {
    const cols = picos.min.length;
    const w = Math.max(0, n), saida = { min: new Float32Array(w), max: new Float32Array(w) };
    const bandas = !!picos.grave;
    if (bandas) for (const nome of BANDAS) saida[nome] = new Float32Array(w);
    if (!(n > 0) || cols === 0) return saida;
    for (let x = 0; x < n; x++) {
      const a = Math.floor((x * cols) / n), b = Math.max(a + 1, Math.floor(((x + 1) * cols) / n));
      let lo = Infinity, hi = -Infinity;
      for (let k = a; k < Math.min(b, cols); k++) { if (picos.min[k] < lo) lo = picos.min[k]; if (picos.max[k] > hi) hi = picos.max[k]; }
      saida.min[x] = lo === Infinity ? 0 : lo;
      saida.max[x] = hi === -Infinity ? 0 : hi;
      if (bandas) mediaBandas(picos, saida, x, a, Math.min(b, cols));
    }
    return saida;
  }

  // ---- tempo ↔ coluna ----------------------------------------------------------------------

  // Visão geral: faixa inteira em `largura` colunas.
  function tempoParaColuna(t, duracao, largura) {
    if (!(duracao > 0) || !(largura > 0) || !num(t)) return 0;
    return trava(t / duracao, 0, 1) * largura;
  }
  function colunaParaTempo(x, duracao, largura) {
    if (!(duracao > 0) || !(largura > 0) || !num(x)) return 0;
    return trava(x / largura, 0, 1) * duracao;
  }

  // Zoom: a cabeça fica no centro da largura; `janela` segundos cabem na largura inteira.
  function tempoNoZoom(x, posicao, largura, janela) {
    const j = janela > 0 ? janela : JANELA_SEG;
    return posicao + (x - largura / 2) * (j / largura);
  }
  function colunaNoZoom(t, posicao, largura, janela) {
    const j = janela > 0 ? janela : JANELA_SEG;
    return largura / 2 + (t - posicao) * (largura / j);
  }

  // Para cada pixel do zoom, o min/max da fatia de faixa sob ele. `dentro[x]` = 0 fora da faixa
  // (antes de 0 ou depois do fim): ali não se desenha nada.
  function janelaDoZoom(picos, posicao, largura, janela) {
    const w = Math.max(0, Math.floor(largura));
    const min = new Float32Array(w), max = new Float32Array(w), dentro = new Uint8Array(w);
    const j = janela > 0 ? janela : JANELA_SEG, cols = picos.min.length;
    const saida = { min, max, dentro }, bandas = !!picos.grave;
    if (bandas) for (const nome of BANDAS) saida[nome] = new Float32Array(w);
    if (!w || !cols) return saida;
    for (let x = 0; x < w; x++) {
      const t0 = tempoNoZoom(x, posicao, w, j), t1 = tempoNoZoom(x + 1, posicao, w, j);
      if (t1 <= 0 || t0 >= picos.duracao) continue;
      const a = Math.max(0, Math.floor(t0 * picos.porSeg)), b = Math.min(cols, Math.max(a + 1, Math.ceil(t1 * picos.porSeg)));
      let lo = Infinity, hi = -Infinity;
      for (let k = a; k < b; k++) { if (picos.min[k] < lo) lo = picos.min[k]; if (picos.max[k] > hi) hi = picos.max[k]; }
      if (lo === Infinity) continue;
      min[x] = lo; max[x] = hi; dentro[x] = 1;
      if (bandas) mediaBandas(picos, saida, x, a, b);
    }
    return saida;
  }

  // ---- posição ao vivo (cabeça de reprodução) ----------------------------------------------

  // posição + (agora − inicioCtx) × taxa quando tocando — a taxa (pitch) entra aqui, então a onda
  // rola mais rápido ou mais devagar sozinha. Nunca passa da duração.
  function posicaoAoVivo(e, agora) {
    if (!e.tocando) return e.posicao;
    const p = e.posicao + (agora - e.inicioCtx) * e.taxa;
    return e.duracao > 0 ? Math.min(Math.max(p, 0), e.duracao) : Math.max(p, 0);
  }

  // Quantos segundos de faixa passam por segundo de relógio (rolagem na tela = isto × px/s do zoom).
  function velocidadeDeRolagem(e) { return e.tocando ? e.taxa : 0; }

  // ---- seek e CUE ---------------------------------------------------------------------------

  // Move a cabeça para `t` (travado em 0…duração). Tocando, recomeça o relógio em `agora`.
  function buscar(e, agora, t) {
    const alvo = trava(num(t) ? t : 0, 0, e.duracao > 0 ? e.duracao : 0);
    return e.tocando ? { ...e, posicao: alvo, inicioCtx: agora } : { ...e, posicao: alvo };
  }

  function travarCue(t, duracao) { return trava(num(t) ? t : 0, 0, duracao > 0 ? duracao : 0); }

  // Regra do botão CUE (clássica, de CDJ). Devolve { rep, cue, acao, previa }:
  //   tocando                    → 'voltar': para e volta ao ponto de cue
  //   parado em cima do cue      → 'previa': toca enquanto estiver apertado (soltar chama soltarCue)
  //   parado fora do cue         → 'definir': o cue passa a ser a posição atual
  function apertarCue(e, cue, agora) {
    const c = travarCue(cue, e.duracao);
    if (e.tocando) return { rep: { ...e, tocando: false, posicao: c }, cue: c, acao: 'voltar', previa: false };
    if (Math.abs(e.posicao - c) <= CUE_TOLERANCIA) {
      if (!(e.duracao > 0)) return { rep: e, cue: c, acao: 'nada', previa: false };
      return { rep: { ...e, tocando: true, posicao: c, inicioCtx: agora }, cue: c, acao: 'previa', previa: true };
    }
    const novo = travarCue(e.posicao, e.duracao);
    return { rep: e, cue: novo, acao: 'definir', previa: false };
  }
  // Soltar o botão: se era prévia, para e volta ao cue. Fora da prévia não faz nada.
  function soltarCue(e, cue, previa) {
    if (!previa || !e.tocando) return { rep: e, acao: 'nada' };
    return { rep: { ...e, tocando: false, posicao: travarCue(cue, e.duracao) }, acao: 'voltar' };
  }

  // Clique na onda: sem Shift define o cue (a cabeça só acompanha se está parado); com Shift faz
  // seek. Devolve { rep, cue, acao: 'cue' | 'seek' }.
  function cliqueNaOnda(e, cue, agora, t, comShift) {
    const alvo = travarCue(t, e.duracao);
    if (comShift) return { rep: buscar(e, agora, alvo), cue, acao: 'seek' };
    return { rep: e.tocando ? e : buscar(e, agora, alvo), cue: alvo, acao: 'cue' };
  }

  // ---- visão da faixa inteira (VB-49, spec §1/§5) ------------------------------------------

  // Marcadores da faixa estreita. `hotcues`: [{ t, tipo, cor, numero, fim? }] (cor já resolvida, §5);
  // `loopAtivo`: { inicio, fim } ou null. Devolve { cues: [{ x, t, cor, numero, tipo }] (por x),
  // loops: [{ x0, x1, cor, ativo }] } em colunas de 0…largura, só o que cai dentro da faixa.
  // Um hotcue de tipo 'loop' com `fim` vira região guardada; o loop ativo vem por último e marcado.
  function marcadoresDaFaixa(hotcues, loopAtivo, duracao, largura) {
    const saida = { cues: [], loops: [] };
    if (!(duracao > 0) || !(largura > 0)) return saida;
    for (const h of Array.isArray(hotcues) ? hotcues : []) {
      if (!h || !num(h.t) || h.t < 0 || h.t > duracao) continue;
      const x = tempoParaColuna(h.t, duracao, largura);
      saida.cues.push({ x, t: h.t, cor: h.cor, numero: h.numero, tipo: h.tipo });
      if (h.tipo === 'loop' && num(h.fim) && h.fim > h.t) {
        saida.loops.push({ x0: x, x1: tempoParaColuna(h.fim, duracao, largura), cor: h.cor, ativo: false });
      }
    }
    saida.cues.sort((a, b) => a.x - b.x);
    if (loopAtivo && num(loopAtivo.inicio) && num(loopAtivo.fim) && loopAtivo.fim > loopAtivo.inicio) {
      saida.loops.push({ x0: tempoParaColuna(loopAtivo.inicio, duracao, largura), x1: tempoParaColuna(loopAtivo.fim, duracao, largura), ativo: true });
    }
    return saida;
  }

  // Clique na faixa inteira: o tempo para onde saltar. `quantizar` (opcional, t → t) é a conta da
  // grade quando o QUANT está ligado; o resultado fica sempre dentro de 0…duração.
  function cliqueNaFaixa(x, largura, duracao, quantizar) {
    let t = colunaParaTempo(x, duracao, largura);
    if (typeof quantizar === 'function') { const q = quantizar(t); if (num(q)) t = q; }
    return trava(t, 0, duracao > 0 ? duracao : 0);
  }

  return { marcadoresDaFaixa, cliqueNaFaixa, PICOS_POR_SEG, JANELA_SEG, CUE_TOLERANCIA, calcularPicos, picosDoBuffer, reduzir, corDasBandas, luminancia, coresPorColuna, CORTE_GRAVE, CORTE_AGUDO,
    tempoParaColuna, colunaParaTempo, tempoNoZoom, colunaNoZoom, janelaDoZoom, posicaoAoVivo,
    velocidadeDeRolagem, buscar, travarCue, apertarCue, soltarCue, cliqueNaOnda };
});
