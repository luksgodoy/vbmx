// ===================== VbMxScratch — scratch e jog (VB-57) =====================
// Lógica pura (UMD). Roda em três lugares: no Node (motor/testar-scratch.js), na página (<script src>,
// expõe `VbMxScratch` para js/scratch.js e js/tocador.js) e DENTRO do AudioWorklet
// (interface/worklets/esticar-processor.js; o tocador carrega este arquivo com audioWorklet.addModule
// na 1ª vez que alguém pega o prato). Sem DOM, sem Web Audio.
//
// Escolhas (decisão do Lucas de 2026-10-26: "girar os discos e fazer scratch, também na waveform"):
//   • Uma volta do prato = 1,8 s de música, como um disco de 33⅓ rpm (60 / 33⅓). É a mesma conta do
//     prato desenhado (motor/reproducao.js anguloDoPrato: 200°/s): a marca do prato fica sob a mão.
//   • QUEM MANDA NA POSIÇÃO É A MÃO, na thread principal. A página manda ao worklet a posição da mão
//     (`alvo`, s da faixa), a velocidade dela (`vel`, s de música por s) e o instante (`em`, relógio do
//     AudioContext). O worklet não manda posição de volta (postMessage no process() alocaria): a cabeça
//     de leitura SEGUE o alvo, e a posição do transporte é a da mão. Assim a onda, os cues e o SYNC leem
//     a posição de sempre, e soltar retoma exatamente de onde a mão deixou.
//   • A cabeça segue o alvo por um sistema de 2ª ordem criticamente amortecido (FREQ_SEGUIR_HZ), quadro a
//     quadro, com a velocidade da mão como antecipação: a taxa varia contínua (sem degrau entre blocos, sem
//     estalo), passa por zero e fica negativa (para trás) sem troca de backend. Leitura com interpolação de
//     Hermite de 4 pontos. Perto da taxa zero o som some suave (VEL_SOM): disco parado não toca.
//   • Entre a última notícia da mão e a próxima, o alvo anda na velocidade da mão por até EXTRAP_S
//     (os eventos de ponteiro chegam a ~60–120 Hz; o áudio, a 44 100 Hz). Depois disso para.
//   • Soltar: a taxa vai da velocidade da mão à taxa final (a do pitch, se o deck tocava; 0, se estava
//     parado) numa rampa linear de RAMPA_SOLTAR_S. A posição é a integral da rampa (alvoNaSoltura): a
//     página e o worklet calculam a mesma curva, e no fim dela o backend normal assume no quadro exato.
//
// API — gesto (thread principal):
//   SEG_POR_VOLTA, PASSOS_POR_VOLTA, LIMIAR_ARRASTO_PX, RAIO_CENTRO, RAMPA_SOLTAR_S, MARGEM_S, CRUZAR_S …
//   anguloDoPonto(x, y, cx, cy)        rad; tela (y para baixo): cresce no sentido horário
//   deltaAngulo(a0, a1)                a1 − a0 dobrado em (−π, π]
//   tempoDoAngulo(dRad)                s de música: horário = para a frente
//   zonaDoToque(x, y, cx, cy, raio)    'centro' (scratch) | 'borda' (bend) | null (fora do prato)
//   tempoDoArrasto(dxPx, larguraPx, janelaS)   s de música ao arrastar a onda (para a esquerda = adiante)
//   tempoDoPasso(passos)               s de música por passos de encoder (jog MIDI)
//   passouDoLimiar(dx, dy, limiar?)    o arrasto virou scratch (≥ 4 px)
//   estimador() · estimar(est, deltaS, tS) · ocioso(est, tS)   velocidade da mão suavizada (s/s)
//   fracaoDeBend(vel, fracaoCheia)     bend proporcional à velocidade da borda (vel 1 = prato a 33⅓)
//   alvoNaMao(sc, t) · velNaMao(sc, t)          sc = {alvo, vel, em}: a linha que o worklet segue
//   corrigirMao(sc, real, vel, t) → sc novo     a mão está em `real`: a linha emenda sem salto e chega nela
//   alvoNaSoltura(s, t) · velNaSoltura(s, t)    s = {posicao, em, vel, taxa, rampa}
//   planoDeSoltura(sc, agora, taxaFinal, duracao, rampa?) → {sol, fimEm, posicaoFinal, tocando}
// API — DSP (thread de áudio; também no Node):
//   criarCabeca({taxaAmostra, canais = 2}) → cabeça:
//     definirFonte(canais | null, taxaAmostraFonte)   os MESMOS arrays do key lock (sem 2ª cópia)
//     pegar(posicao, quadro, taxa)   entra no quadro `quadro`, com a cabeça em `posicao` andando a `taxa` (e a mão
//                                    parada ali: a cabeça desacelera até ela, ~3 ms de música a taxa 1);
//                                    o envelope sobe de 0 a 1 em CRUZAR_S (se já estava ativa, segue contínua)
//     mao(alvo, vel, em)             notícia da mão
//     saltar(alvo, em)               busca durante o scratch: a cabeça pula (cruzamento de SALTO_S)
//     soltar(posicao, em, vel, taxa, rampa, quadroFim)   rampa até `taxa`; o envelope desce a partir de quadroFim
//     encerrar(quadro)               envelope desce a partir de `quadro` (corte: troca de faixa, CUP…)
//     renderizar(saidas, n, quadroInicial) → INATIVA (0) | CHEIA (1: envelope 1 no bloco todo) | PARCIAL (2)
//                                    escreve envelope × som; `envelope[i]` fica com o peso de cada quadro
//                                    (quem mistura põe o outro backend com 1 − envelope)
//     envelope (Float32Array) · ativa() · posicao() (s) · taxa() (s/s)
(function (raiz, fabrica) {
  const api = fabrica();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.VbMxScratch = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const SEG_POR_VOLTA = 60 / (100 / 3);   // 1,8 s: disco de 33⅓ rpm
  const PASSOS_POR_VOLTA = 128;           // jog MIDI: um passo de encoder = 1/128 de volta (≈ 14 ms de música)
  const LIMIAR_ARRASTO_PX = 4;
  const RAIO_CENTRO = 0.7;                // até 70% do raio = centro (scratch); daí até a borda = bend
  const TAU_VEL_S = 0.02;                 // suavização da velocidade da mão
  const OCIOSO_S = 0.03;                  // sem notícia da mão por mais que isso: ela parou
  const EXTRAP_S = 0.03;                  // o alvo anda na velocidade da mão por até isso depois da notícia
  const RAMPA_SOLTAR_S = 0.1;             // soltar: da velocidade da mão à taxa final
  const MARGEM_S = 0.012;                 // agendamento da troca de backend (a mensagem tem de chegar antes)
  const CRUZAR_S = 0.004;                 // cruzamento entre o backend normal e a cabeça do scratch
  const SALTO_S = 0.003;                  // cruzamento de uma busca durante o scratch
  const FREQ_SEGUIR_HZ = 20;              // a cabeça segue o alvo (2ª ordem, criticamente amortecida)
  const VEL_SOM = 0.05;                   // abaixo de 5% da velocidade o som some suave (disco parado é mudo)
  const TAU_GANHO_S = 0.005;              // esse ganho segue a velocidade com 5 ms de constante (sem buraco na virada)
  const BEND_MAX = 2;                     // bend da borda: até 2× a fração cheia do VB-34
  const INATIVA = 0, CHEIA = 1, PARCIAL = 2;

  const num = (x) => typeof x === 'number' && Number.isFinite(x);
  const DOIS_PI = 2 * Math.PI;

  // ---------------------------------------------------------------- gesto
  function anguloDoPonto(x, y, cx, cy) { return Math.atan2(y - cy, x - cx); }
  function deltaAngulo(a0, a1) {
    let d = (a1 - a0) % DOIS_PI;
    if (d > Math.PI) d -= DOIS_PI;
    else if (d <= -Math.PI) d += DOIS_PI;
    return d;
  }
  function tempoDoAngulo(dRad) { return num(dRad) ? (dRad / DOIS_PI) * SEG_POR_VOLTA : 0; }
  function zonaDoToque(x, y, cx, cy, raio) {
    if (!(raio > 0)) return null;
    const r = Math.hypot(x - cx, y - cy) / raio;
    return r > 1 ? null : r <= RAIO_CENTRO ? 'centro' : 'borda';
  }
  function tempoDoArrasto(dxPx, larguraPx, janelaS) {
    if (!num(dxPx) || !(larguraPx > 0) || !(janelaS > 0)) return 0;
    return (-dxPx * janelaS) / larguraPx;
  }
  function tempoDoPasso(passos) { return num(passos) ? (passos / PASSOS_POR_VOLTA) * SEG_POR_VOLTA : 0; }
  function passouDoLimiar(dx, dy, limiar) {
    const l = num(limiar) && limiar >= 0 ? limiar : LIMIAR_ARRASTO_PX;
    return Math.hypot(num(dx) ? dx : 0, num(dy) ? dy : 0) >= l;
  }

  // Velocidade da mão: média exponencial da velocidade instantânea (delta / dt), constante de TAU_VEL_S.
  function estimador() { return { vel: 0, t: null }; }
  function estimar(est, deltaS, tS) {
    const d = num(deltaS) ? deltaS : 0;
    if (!est || est.t === null || !num(tS)) return { vel: 0, t: num(tS) ? tS : null };
    const dt = Math.max(0.001, tS - est.t);
    const a = 1 - Math.exp(-dt / TAU_VEL_S);
    return { vel: est.vel + a * (d / dt - est.vel), t: tS };
  }
  // Sem notícia há mais de OCIOSO_S: a velocidade cai para 0 (a mão parou; o próximo movimento recomeça).
  function ocioso(est, tS) {
    if (!est || est.t === null || est.vel === 0 || !num(tS) || tS - est.t <= OCIOSO_S) return est;
    return { vel: 0, t: est.t };
  }
  // Bend da borda (VB-34 dá a fração cheia: VbMxFase.bendDeck(1, sensibilidade) = 4% a 100%):
  // girar a borda na velocidade do prato (vel 1) empurra a fração cheia; até BEND_MAX vezes ela.
  function fracaoDeBend(vel, fracaoCheia) {
    if (!num(vel) || !num(fracaoCheia)) return 0;
    return Math.max(-BEND_MAX, Math.min(BEND_MAX, vel)) * fracaoCheia;
  }

  // ---------------------------------------------------------------- alvo (mão e soltura)
  function alvoNaMao(sc, t) {
    const dt = t - sc.em;
    if (!(dt > 0)) return sc.alvo;
    return sc.alvo + sc.vel * (dt < EXTRAP_S ? dt : EXTRAP_S);
  }
  // Notícia nova da mão no instante t: ela está REALMENTE em `real` (soma exata dos deltas) andando a `vel`.
  // O alvo não salta (estalo): a linha nova parte de onde a velha está agora e corrige a diferença para a mão
  // real em EXTRAP_S, somada à velocidade dela. Com a mão parada (vel 0), o alvo chega exatamente em `real`.
  function corrigirMao(sc, real, vel, t) {
    const cur = alvoNaMao(sc, t), v = num(vel) ? vel : 0;
    return { real, alvo: cur, vel: v + (real - cur) / EXTRAP_S, em: t };
  }
  function velNaMao(sc, t) {
    const dt = t - sc.em;
    return dt >= 0 && dt < EXTRAP_S ? sc.vel : 0;
  }
  function alvoNaSoltura(s, t) {
    const R = s.rampa > 0 ? s.rampa : 0;
    let tau = t - s.em;
    if (!(tau > 0)) tau = 0;
    if (tau < R) return s.posicao + s.vel * tau + ((s.taxa - s.vel) * tau * tau) / (2 * R);
    return s.posicao + ((s.vel + s.taxa) * R) / 2 + s.taxa * (tau - R);
  }
  function velNaSoltura(s, t) {
    const R = s.rampa > 0 ? s.rampa : 0;
    let tau = t - s.em;
    if (!(tau > 0)) tau = 0;
    return tau < R ? s.vel + ((s.taxa - s.vel) * tau) / R : s.taxa;
  }
  // Soltar no instante `agora`: rampa da velocidade da mão até `taxaFinal`; a posição final (onde o backend
  // normal assume, em fimEm) já sai travada na faixa. `tocando`: retoma se a taxa final > 0 e não acabou.
  function planoDeSoltura(sc, agora, taxaFinal, duracao, rampa) {
    const R = num(rampa) && rampa >= 0 ? rampa : RAMPA_SOLTAR_S;
    const taxa = num(taxaFinal) && taxaFinal > 0 ? taxaFinal : 0;
    const sol = { posicao: alvoNaMao(sc, agora), em: agora, vel: velNaMao(sc, agora), taxa, rampa: R };
    const fimEm = agora + R;
    let p = alvoNaSoltura(sol, fimEm);
    if (!(p > 0)) p = 0;
    if (duracao > 0 && p > duracao) p = duracao;
    return { sol, fimEm, posicaoFinal: p, tocando: taxa > 0 && !(duracao > 0 && p >= duracao) };
  }

  // ---------------------------------------------------------------- DSP: a cabeça de leitura
  function criarCabeca(opcoes) {
    const o = opcoes || {};
    const sr = num(o.taxaAmostra) && o.taxaAmostra > 0 ? o.taxaAmostra : 44100;
    const MAXN = 4096;                                   // o quantum é 128; folga para um renderSizeHint maior
    const envelope = new Float32Array(MAXN);
    const W = (DOIS_PI * FREQ_SEGUIR_HZ) / sr, K1 = W * W, K2 = 2 * W;   // por quadro
    const nCruzar = Math.max(1, Math.round(CRUZAR_S * sr)), passoEnv = 1 / nCruzar;
    const nSalto = Math.max(1, Math.round(SALTO_S * sr));
    const EXTRAP = EXTRAP_S;
    const AGV = 1 - Math.exp(-1 / (TAU_GANHO_S * sr));

    let fonte = null, nF = 0, cF = 0, srF = sr, escala = 1;   // escala: quadros da fonte por quadro de saída a taxa 1
    let ligada = false;
    let h = 0, r = 0;                    // cabeça (quadros da fonte, float64) e taxa (quadros da fonte por quadro)
    let env = 0, envAlvo = 0, envDesde = 0;
    let inicio = 0;                      // 1º quadro em que a cabeça anda (pegar agendado)
    let modo = 0;                        // 0 mão, 1 soltura
    let mAlvo = 0, mVel = 0, mEm = 0;    // mão (s, s/s, s)
    let sP = 0, sEm = 0, sV = 0, sT = 0, sR = 0;   // soltura
    let hVelho = 0, saltoResta = 0;
    let gs = 0;                          // ganho da velocidade, suavizado (TAU_GANHO_S)
    let fimQuadro = Infinity;

    function definirFonte(canais, taxaAmostraFonte) {
      if (canais && canais.length && canais[0] && canais[0].length) {
        fonte = canais; cF = canais.length; nF = canais[0].length;
        srF = num(taxaAmostraFonte) && taxaAmostraFonte > 0 ? taxaAmostraFonte : sr;
      } else { fonte = null; cF = 0; nF = 0; srF = sr; ligada = false; env = 0; envAlvo = 0; }
      escala = srF / sr;
    }
    function pegar(posicao, quadro, taxa) {
      const p = num(posicao) ? posicao : 0, v = num(taxa) ? taxa : 0, q = num(quadro) ? Math.round(quadro) : 0;
      if (!ligada) { h = p * srF; r = v * escala; env = 0; inicio = q; saltoResta = 0; const x = Math.abs(v) / VEL_SOM; gs = x >= 1 ? 1 : x * x * (3 - 2 * x); }
      ligada = !!fonte;
      envAlvo = 1; envDesde = q; fimQuadro = Infinity;
      modo = 0; mAlvo = p; mVel = 0; mEm = q / sr;   // a mão segura o disco: a cabeça desacelera da taxa que tinha
    }
    function mao(alvo, vel, em) {
      if (!num(alvo) || !num(em)) return;
      modo = 0; mAlvo = alvo; mVel = num(vel) ? vel : 0; mEm = em;
    }
    function saltar(alvo, em) {
      if (!num(alvo) || !num(em)) return;
      if (ligada) { hVelho = h; saltoResta = nSalto; h = alvo * srF; }
      modo = 0; mAlvo = alvo; mVel = 0; mEm = em;
    }
    function soltar(posicao, em, vel, taxa, rampa, quadroFim) {
      modo = 1; sP = num(posicao) ? posicao : 0; sEm = num(em) ? em : 0; sV = num(vel) ? vel : 0;
      sT = num(taxa) && taxa > 0 ? taxa : 0; sR = num(rampa) && rampa > 0 ? rampa : 0;
      fimQuadro = num(quadroFim) ? Math.round(quadroFim) : 0;
      envAlvo = 0; envDesde = fimQuadro;
    }
    function encerrar(quadro) {
      envAlvo = 0; envDesde = num(quadro) ? Math.round(quadro) : 0;
      if (modo === 0) { mVel = 0; }
    }
    function ativa() { return ligada; }
    function posicao() { return h / srF; }
    function taxa() { return r / escala; }

    // --- caminho de áudio: daqui até o fim de renderizar, nada aloca (motor/testar-scratch.js confere) ---
    function amostra(src, i) { return i >= 0 && i < nF ? src[i] : 0; }
    // Hermite de 4 pontos (Catmull-Rom) na posição x (quadros da fonte)
    function ler(src, x) {
      const i = Math.floor(x), f = x - i;
      const xm = amostra(src, i - 1), x0 = amostra(src, i), x1 = amostra(src, i + 1), x2 = amostra(src, i + 2);
      const c1 = 0.5 * (x1 - xm), c2 = xm - 2.5 * x0 + 2 * x1 - 0.5 * x2, c3 = 0.5 * (x2 - xm) + 1.5 * (x0 - x1);
      return ((c3 * f + c2) * f + c1) * f + x0;
    }
    function renderizar(saidas, n, quadroInicial) {
      const nS = saidas.length;
      if (!ligada || !fonte) {
        for (let c = 0; c < nS; c++) saidas[c].fill(0, 0, n);
        return INATIVA;
      }
      const m = n < MAXN ? n : MAXN;
      let cheio = true;
      for (let i = 0; i < m; i++) {
        const f = quadroInicial + i;
        if (f < inicio) {
          envelope[i] = 0; cheio = false;
          for (let c = 0; c < nS; c++) saidas[c][i] = 0;
          continue;
        }
        const t = f / sr;
        let p, v, a = 0;
        if (modo === 0) {
          const dt = t - mEm;
          if (!(dt > 0)) { p = mAlvo; v = 0; }
          else if (dt < EXTRAP) { p = mAlvo + mVel * dt; v = mVel; }
          else { p = mAlvo + mVel * EXTRAP; v = 0; }
        } else {
          let tau = t - sEm;
          if (!(tau > 0)) tau = 0;
          if (tau < sR) { a = (sT - sV) / sR; p = sP + sV * tau + (a * tau * tau) / 2; v = sV + a * tau; }
          else { p = sP + ((sV + sT) * sR) / 2 + sT * (tau - sR); v = sT; }
        }
        const pF = p * srF, vF = v * escala;
        r += K1 * (pF - h) + K2 * (vF - r) + (a * escala) / sr;   // a: antecipação da aceleração (rampa de soltura)
        h += r;
        if (Math.abs(pF - h) < 1e-6 && Math.abs(vF - r) < 1e-9) { h = pF; r = vF; }   // assentou: sem resíduo
        if (f >= envDesde && env !== envAlvo) {
          env = env < envAlvo ? Math.min(envAlvo, env + passoEnv) : Math.max(envAlvo, env - passoEnv);
        }
        envelope[i] = env;
        if (env < 1) cheio = false;
        const x = Math.abs(r / escala) / VEL_SOM;
        gs += ((x >= 1 ? 1 : x * x * (3 - 2 * x)) - gs) * AGV;   // suave no tempo: virar a mão rápido não abre buraco
        if (gs < 1e-6) gs = 0; else if (gs > 1 - 1e-6) gs = 1;
        const g = env * gs;
        if (saltoResta > 0) {
          const a = saltoResta / nSalto;
          for (let c = 0; c < nS; c++) {
            const src = fonte[c < cF ? c : cF - 1];
            saidas[c][i] = g * ((1 - a) * ler(src, h) + a * ler(src, hVelho));
          }
          hVelho += r; saltoResta -= 1;
        } else {
          for (let c = 0; c < nS; c++) saidas[c][i] = g * ler(fonte[c < cF ? c : cF - 1], h);
        }
      }
      for (let c = 0; c < nS; c++) if (m < n) saidas[c].fill(0, m, n);
      if (env === 0 && envAlvo === 0 && quadroInicial + m > envDesde) { ligada = false; return PARCIAL; }
      return cheio ? CHEIA : PARCIAL;
    }
    // --- fim do caminho de áudio ---

    return { definirFonte, pegar, mao, saltar, soltar, encerrar, renderizar, ativa, posicao, taxa, envelope };
  }

  return {
    SEG_POR_VOLTA, PASSOS_POR_VOLTA, LIMIAR_ARRASTO_PX, RAIO_CENTRO, TAU_VEL_S, OCIOSO_S, EXTRAP_S, RAMPA_SOLTAR_S,
    MARGEM_S, CRUZAR_S, SALTO_S, FREQ_SEGUIR_HZ, VEL_SOM, TAU_GANHO_S, BEND_MAX, INATIVA, CHEIA, PARCIAL,
    anguloDoPonto, deltaAngulo, tempoDoAngulo, zonaDoToque, tempoDoArrasto, tempoDoPasso, passouDoLimiar,
    estimador, estimar, ocioso, fracaoDeBend, alvoNaMao, corrigirMao, velNaMao, alvoNaSoltura, velNaSoltura, planoDeSoltura,
    criarCabeca,
  };
});
