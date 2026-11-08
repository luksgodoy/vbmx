// ===================== VbMxEsticar — time-stretch (WSOLA) do key lock =====================
// Dono: VB-21. Lógica pura (UMD): roda no Node (motor/testar-esticar.js) e DENTRO do AudioWorklet
// (interface/worklets/esticar-processor.js, que carrega este arquivo com audioWorklet.addModule). A
// página não usa este arquivo na thread principal. Contrato do tocador: docs/contratos.md.
//
// O que faz: toca uma faixa (canais Float32Array) seguindo o MESMO relógio do motor/transporte.js —
// posição = posicao + (t − inicioCtx) × taxa, dobrada no loop — mas com o tom desacoplado do tempo:
//   fator de tom = (keyLock ? 1 : taxa) × 2^(semitons/12)
// Key lock ligado e 0 semitons: o andamento segue a taxa e o tom fica o original (spec §1). Os semitons
// são a API do knob KEY (VB-38): mudam o tom sem mexer no tempo. Sem key lock e com 0 semitons a página
// nem usa este motor (o tocador fica no AudioBufferSourceNode com playbackRate, como antes).
//
// Algoritmo: WSOLA escrito do zero (sem dependência; motivo e descartadas no relatório do VB-21).
// Grãos de N amostras (≈ 23 ms) com janela de Hann, saltando N/2 na SAÍDA (soma da janela = 1). O
// centro de cada grão lê a fonte no ponto exato que a fórmula do transporte manda (a posição não
// acumula erro), procurando ±tolerância (≈ 5,8 ms) o encaixe de maior correlação com a continuação
// natural do grão anterior (sem buraco nem "flam" de fase). Dentro do grão a fonte é lida no passo do
// fator de tom (interpolação linear; com fator 1, cópia direta).
//
// Latência (medida em motor/testar-esticar.js):
//   • posição: 0 — o grão é centrado na posição da fórmula, lendo à frente no buffer inteiro; o
//     desvio é a busca de encaixe, limitada a ±tolerância e SEM acúmulo;
//   • resposta a comando (taxa, busca, loop, tom): o som novo entra no bloco seguinte à mensagem e o
//     velho sai num cross-fade de N/2 quadros (≈ 11,6 ms a 44,1 kHz), mais o quantum de 128 quadros em
//     que a mensagem chega.
// Sem alocação no caminho de áudio: `criar` aloca tudo; `renderizar` e o que ele chama só escrevem em
// arrays já criados (o portão confere por texto).
//
//   parametros(taxaAmostra)          → {grao, salto, tolerancia} em quadros
//   latencia(taxaAmostra)            → {posicao, resposta, grao, tolerancia} em s (posicao = 0)
//   fatorDeTom(taxa, semitons, keyLock)
//   posicaoNominal(e, t)             = VbMxTransporte.posicaoEm sem a ré (e = {tocando, posicao,
//                                      inicioCtx, taxa, duracao, loop})
//   criar({taxaAmostra, canais = 2, grao?, tolerancia?}) → motor:
//     definirFonte(canais | null, taxaAmostraFonte)
//     definirEstado({tocando, posicao, inicioCtx, taxa, duracao, loop, keyLock, semitons, geracao})
//     renderizar(saidas, n, quadroInicial) → OK (0) | FIM (1: a faixa acabou neste bloco)
//     geracao() → a geração do último estado (vai no 'fim')
//     estado() → cópia do estado interno (aloca: só fora do process), grao/salto/tolerancia
(function (raiz, fabrica) {
  const api = fabrica();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.VbMxEsticar = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const OK = 0, FIM = 1;
  const PASSO_GROSSO = 4;   // busca grossa: de 4 em 4 quadros, lendo 1 a cada 4 (depois, fina em ±3)

  const num = (x) => typeof x === 'number' && Number.isFinite(x);

  function parametros(taxaAmostra) {
    const sr = num(taxaAmostra) && taxaAmostra > 0 ? taxaAmostra : 44100;
    const grao = Math.max(256, Math.pow(2, Math.round(Math.log2(0.0232 * sr))));   // 1024 a 44,1/48 kHz
    const tolerancia = Math.max(PASSO_GROSSO, Math.round((0.0058 * sr) / PASSO_GROSSO) * PASSO_GROSSO);
    return { grao, salto: grao / 2, tolerancia };
  }
  function latencia(taxaAmostra) {
    const sr = num(taxaAmostra) && taxaAmostra > 0 ? taxaAmostra : 44100, p = parametros(sr);
    return { posicao: 0, resposta: (p.salto + 128) / sr, grao: p.grao / sr, tolerancia: p.tolerancia / sr };
  }
  function fatorDeTom(taxa, semitons, keyLock) {
    const t = num(taxa) && taxa > 0 ? taxa : 1, s = num(semitons) ? semitons : 0;
    return (keyLock ? 1 : t) * Math.pow(2, s / 12);
  }
  // A mesma conta de motor/transporte.js posicaoEm (sentido 1): o motor segue o relógio do transporte.
  // `semTravar`: sem prender em [0, duração] — o grão que passa do fim continua lendo (silêncio) em vez de
  // repetir o último trecho.
  function posicaoNominal(e, t, semTravar) {
    if (!e.tocando) return e.posicao;
    let p = e.posicao + (t - e.inicioCtx) * e.taxa;
    const L = e.loop;
    if (L && e.posicao < L.fim && p >= L.fim) p = L.inicio + ((p - L.inicio) % (L.fim - L.inicio));
    if (semTravar) return p;
    if (p < 0) p = 0;
    return e.duracao > 0 && p > e.duracao ? e.duracao : p;
  }

  function criar(opcoes) {
    const o = opcoes || {};
    const srSaida = num(o.taxaAmostra) && o.taxaAmostra > 0 ? o.taxaAmostra : 44100;
    const P = parametros(srSaida);
    const N = num(o.grao) && o.grao >= 2 * PASSO_GROSSO ? 2 * Math.round(o.grao / 2) : P.grao;
    const H = N / 2;
    const TOL = num(o.tolerancia) && o.tolerancia >= 0 ? Math.round(o.tolerancia / PASSO_GROSSO) * PASSO_GROSSO : P.tolerancia;
    const NC = num(o.canais) && o.canais >= 1 ? Math.floor(o.canais) : 2;
    const R = 2 * N;                                   // anel de soma: 2 grãos
    const janela = new Float32Array(N);
    for (let i = 0; i < N; i++) janela[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);   // Hann periódica: w[i] + w[i+N/2] = 1
    const anel = [];
    for (let c = 0; c < NC; c++) anel.push(new Float32Array(R));
    const nGrosso = Math.ceil(H / PASSO_GROSSO);
    const alvoGrosso = new Float32Array(nGrosso), alvoFino = new Float32Array(H);
    const loopFixo = { inicio: 0, fim: 0 };
    const est = { tocando: false, posicao: 0, inicioCtx: 0, taxa: 1, duracao: 0, loop: null, keyLock: true, semitons: 0, geracao: 0 };

    let fonte = null, nFonte = 0, canaisFonte = 0, srFonte = srSaida;
    let passo = 1;              // amostras da fonte por quadro de saída, dentro do grão (fator de tom)
    let ativo = false;          // já há grãos somados para o quadro `esperado`
    let origem = 0, gProx = 0, esperado = -1, temAnterior = false, inicioAnterior = 0, quadroAnterior = 0;
    let emendar = false;        // chegou estado novo tocando: o próximo bloco faz a emenda (cross-fade de N/2)
    let quadroFim = Infinity;
    let graos = 0;

    function recalcularPasso() { passo = fatorDeTom(est.taxa, est.semitons, est.keyLock) * (srFonte / srSaida); }
    function recalcularFim() {
      const L = est.loop;
      if (!est.tocando || !(est.duracao > 0) || (L && est.posicao < L.fim)) { quadroFim = Infinity; return; }
      quadroFim = Math.ceil((est.inicioCtx + (est.duracao - est.posicao) / est.taxa) * srSaida);
    }

    function definirFonte(canais, taxaAmostraFonte) {
      if (canais && canais.length && canais[0] && canais[0].length) {
        fonte = canais; canaisFonte = canais.length; nFonte = canais[0].length;
        srFonte = num(taxaAmostraFonte) && taxaAmostraFonte > 0 ? taxaAmostraFonte : srSaida;
      } else { fonte = null; canaisFonte = 0; nFonte = 0; srFonte = srSaida; }
      ativo = false; temAnterior = false;
      recalcularPasso();
    }
    function definirEstado(m) {
      if (!m) return;
      // Já tocando e segue tocando (busca, taxa, loop, tom): antes de trocar a conta, completa os grãos
      // VELHOS até N/2 depois do próximo bloco — o trecho que a emenda vai esmaecer fica com peso cheio.
      const continua = ativo && !!fonte && est.tocando && !!m.tocando;
      if (continua) while (gProx < esperado + H) { somarGrao(gProx); gProx += H; }
      emendar = continua;
      est.tocando = !!m.tocando;
      est.posicao = num(m.posicao) ? m.posicao : 0;
      est.inicioCtx = num(m.inicioCtx) ? m.inicioCtx : 0;
      est.taxa = num(m.taxa) && m.taxa > 0 ? m.taxa : 1;
      est.duracao = num(m.duracao) && m.duracao > 0 ? m.duracao : 0;
      if (m.loop && num(m.loop.inicio) && num(m.loop.fim) && m.loop.fim > m.loop.inicio) {
        loopFixo.inicio = m.loop.inicio; loopFixo.fim = m.loop.fim; est.loop = loopFixo;
      } else est.loop = null;
      est.keyLock = m.keyLock !== false;
      est.semitons = num(m.semitons) ? m.semitons : 0;
      est.geracao = num(m.geracao) ? m.geracao : 0;
      if (!est.tocando) ativo = false;
      recalcularPasso();
      recalcularFim();
    }

    // soma dos canais no índice inteiro i (0 fora da fonte): é o sinal da busca de encaixe
    function monoEm(i) {
      if (i < 0 || i >= nFonte) return 0;
      let s = fonte[0][i];
      for (let c = 1; c < canaisFonte; c++) s += fonte[c][i];
      return s;
    }
    // Encaixe: entre ini−TOL e ini+TOL, o deslocamento cujo trecho (lido no passo do tom) mais se parece
    // com `alvo` (a continuação natural do grão anterior). Correlação normalizada pela energia do
    // candidato; em empate fica o deslocamento menor (0 primeiro), para a posição não vaguear.
    function encaixar(ini, alvo) {
      const pg = PASSO_GROSSO * passo;
      for (let j = 0; j < nGrosso; j++) alvoGrosso[j] = monoEm(Math.floor(alvo + j * pg + 0.5));
      let melhorD = 0, melhor = -Infinity;
      for (let k = 0; k <= 2 * TOL; k += PASSO_GROSSO) {
        const d = k === 0 ? 0 : (k <= TOL ? k : TOL - k);   // 0, +4, …, +TOL, −4, …, −TOL
        let s = 0, e = 1e-12, x = ini + d + 0.5;
        for (let j = 0; j < nGrosso; j++) { const v = monoEm(Math.floor(x)); s += alvoGrosso[j] * v; e += v * v; x += pg; }
        const q = s / Math.sqrt(e);
        if (k === 0 || q > melhor + 1e-9 * Math.abs(melhor)) { melhor = q; melhorD = d; }
      }
      for (let j = 0; j < H; j++) alvoFino[j] = monoEm(Math.floor(alvo + j * passo + 0.5));
      const centro = melhorD;
      melhor = -Infinity;
      for (let k = 0; k < 2 * PASSO_GROSSO - 1; k++) {
        const d = centro + (k === 0 ? 0 : (k < PASSO_GROSSO ? k : PASSO_GROSSO - 1 - k));   // centro, +1..+3, −1..−3
        if (d > TOL || d < -TOL) continue;
        let s = 0, e = 1e-12, x = ini + d + 0.5;
        for (let j = 0; j < H; j++) { const v = monoEm(Math.floor(x)); s += alvoFino[j] * v; e += v * v; x += passo; }
        const q = s / Math.sqrt(e);
        if (k === 0 || q > melhor + 1e-9 * Math.abs(melhor)) { melhor = q; melhorD = d; }
      }
      return ini + melhorD;
    }
    // Soma no anel o grão que começa no quadro de saída g (centro em g + N/2).
    function somarGrao(g) {
      const pos = posicaoNominal(est, (g + H) / srSaida, true);
      let ini = pos * srFonte - H * passo;
      if (passo === 1) ini = Math.round(ini);
      if (temAnterior && TOL > 0) ini = encaixar(ini, inicioAnterior + (g - quadroAnterior) * passo);
      let k = (g - origem) % R;
      if (k < 0) k += R;
      const inteiro = passo === 1 && ini === Math.floor(ini);
      for (let c = 0; c < NC; c++) {
        const dst = anel[c], src = fonte[c < canaisFonte ? c : canaisFonte - 1];
        let q = k;
        if (inteiro) {
          for (let i = 0; i < N; i++) {
            const idx = ini + i;
            if (idx >= 0 && idx < nFonte) dst[q] += janela[i] * src[idx];
            if (++q === R) q = 0;
          }
        } else {
          let x = ini;
          for (let i = 0; i < N; i++) {
            const i0 = Math.floor(x);
            if (i0 >= 0 && i0 < nFonte) {
              const a = src[i0], b = i0 + 1 < nFonte ? src[i0 + 1] : 0;
              dst[q] += janela[i] * (a + (b - a) * (x - i0));
            }
            x += passo;
            if (++q === R) q = 0;
          }
        }
      }
      inicioAnterior = ini; quadroAnterior = g; temAnterior = true; graos += 1;
    }
    // Recomeço (play, ou o bloco não veio logo depois do anterior): um grão "de antes" cuja metade
    // descendente cobre os primeiros N/2 quadros, para o som entrar já no nível certo, sem rampa.
    function recomecar(f0) {
      for (let c = 0; c < NC; c++) anel[c].fill(0);
      origem = f0 - H; temAnterior = false; emendar = false;
      somarGrao(origem);
      for (let c = 0; c < NC; c++) anel[c].fill(0, 0, H);   // a metade de antes de f0 nunca toca
      gProx = f0; ativo = true;
    }
    // Emenda (estado novo com o deck tocando): o som velho de [f0, f0+N/2) desce na metade final da
    // janela, o resto dele sai, e os grãos novos começam em f0 subindo na metade inicial (soma = 1). O
    // 1º grão novo ainda procura o encaixe contra o velho: a busca/troca de taxa sai sem estalo.
    function emendarEm(f0) {
      let k = (f0 - origem) % R;
      if (k < 0) k += R;
      for (let c = 0; c < NC; c++) {
        const a = anel[c];
        let q = k;
        for (let i = 0; i < H; i++) { a[q] *= janela[H + i]; if (++q === R) q = 0; }
        for (let i = 0; i < N; i++) { a[q] = 0; if (++q === R) q = 0; }
      }
      gProx = f0; emendar = false;
    }
    function silenciar(saidas, de, n) {
      for (let c = 0; c < saidas.length; c++) saidas[c].fill(0, de, n);
    }

    function renderizar(saidas, n, quadroInicial) {
      const f0 = quadroInicial;
      if (!fonte || !est.tocando) { silenciar(saidas, 0, n); ativo = false; esperado = f0 + n; return OK; }
      if (!ativo || f0 !== esperado) recomecar(f0);
      else if (emendar) emendarEm(f0);
      const ultimo = f0 + n - 1;
      while (gProx <= ultimo) { somarGrao(gProx); gProx += H; }
      let fim = n, codigo = OK;
      if (quadroFim <= ultimo) { fim = quadroFim > f0 ? quadroFim - f0 : 0; codigo = FIM; }
      let k0 = (f0 - origem) % R;
      if (k0 < 0) k0 += R;
      const nSaida = saidas.length;
      for (let c = 0; c < NC; c++) {
        const a = anel[c], s = c < nSaida ? saidas[c] : null;
        let k = k0;
        for (let i = 0; i < n; i++) {
          if (s !== null) s[i] = i < fim ? a[k] : 0;
          a[k] = 0;
          if (++k === R) k = 0;
        }
      }
      for (let c = NC; c < nSaida; c++) saidas[c].set(saidas[NC - 1]);
      esperado = f0 + n;
      if (codigo === FIM) { est.tocando = false; ativo = false; quadroFim = Infinity; }
      return codigo;
    }

    function estado() {
      return { tocando: est.tocando, geracao: est.geracao, passo, graos, temFonte: !!fonte, grao: N, salto: H, tolerancia: TOL, quadroFim };
    }

    function geracao() { return est.geracao; }

    return { definirFonte, definirEstado, renderizar, estado, geracao, grao: N, salto: H, tolerancia: TOL };
  }

  return { OK, FIM, parametros, latencia, fatorDeTom, posicaoNominal, criar };
});
