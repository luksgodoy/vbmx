// ===================== fx-nos.js — nós Web Audio dos efeitos, ligados com VbMxCadeia.inserir(letra, "fx", …) =====================
// Dono: VB-22 (onda 2). Só nós nativos (DelayNode, ConvolverNode, BiquadFilterNode, OscillatorNode como LFO,
// GainNode, ChannelMergerNode); o impulso do reverb é GERADO aqui por código (ruído com decaimento
// exponencial) — nada de amostra de terceiros. No carregamento só declara; nada toca o DOM nem o áudio.
//
// Tempo: o módulo não conhece o relógio mestre (VB-35). Quem monta passa `obterBpm()` (função que devolve o
// BPM do deck mestre, ou um valor inválido para cair em 120); `tempo()` de cada unidade relê o BPM e
// reajusta o que é sincronizado (delay, gater, LFO sincronizado). O LFO do gater roda livre: a fase dele NÃO
// é alinhada à grade (isso depende do relógio mestre); só a taxa acompanha o BPM.
//
// API (global `VbMxFxNos`):
//   criarUnidadeCanal(ctx, obterBpm) → {entrada, saida, aplicar(cfg, ativo), tempo(), descartar()}
//     cfg = VbMxFx.efeitosEfetivos(unidade) = {ligada, dw, efeitos: [{tipo, params, botoes, ligado}] (até 3)}
//     ativo = a unidade está ligada E atribuída a este canal; falso deixa o sinal passar intacto.
//   criarEfeito(ctx, tipo, obterBpm) → {entrada, saida, aplicar(params, botoes), tempo(), descartar()}
//   gerarImpulso(ctx, segundos) → AudioBuffer estéreo (ruído × (1 − t/d)^3)
const VbMxFxNos = (function () {
  'use strict';
  const SUAVE = 0.02;                   // s, constante de tempo das mudanças (sem clique)
  const ATRASO_MAX = 8;                 // s (4/4 a 30 BPM)

  const ganho = (ctx, v) => { const g = ctx.createGain(); g.gain.value = v; return g; };
  const biquad = (ctx, tipo, f, q) => { const b = ctx.createBiquadFilter(); b.type = tipo; b.frequency.value = f; if (q !== undefined) b.Q.value = q; return b; };
  const mudar = (ctx, param, v, tc) => param.setTargetAtTime(v, ctx.currentTime, tc || SUAVE);
  const desligar = (nos) => { for (const n of nos) { try { n.disconnect(); } catch (_) { /* já solto */ } if (n.stop) { try { n.stop(); } catch (_) { /* já parado */ } } } };
  const limitar = (v, a, b) => Math.min(b, Math.max(a, v));
  const motor = () => (typeof VbMxFx !== 'undefined' ? VbMxFx : require('../../motor/fx.js'));
  const lerBpm = (obterBpm) => { try { return typeof obterBpm === 'function' ? obterBpm() : NaN; } catch (_) { return NaN; } };

  function gerarImpulso(ctx, segundos) {
    const taxa = ctx.sampleRate || 44100, n = Math.max(1, Math.floor(segundos * taxa));
    const buf = ctx.createBuffer(2, n, taxa);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 3);
    }
    return buf;
  }

  // ---- filtro: passa-baixa → passa-alta → rejeita-banda; centro (0) passa tudo ----
  function efeitoFiltro(ctx) {
    const F = motor();
    const entrada = ganho(ctx, 1), saida = ganho(ctx, 1);
    const lp = biquad(ctx, 'lowpass', 20000, 0.7071), hp = biquad(ctx, 'highpass', 20, 0.7071), no = biquad(ctx, 'notch', 22000, 1);
    entrada.connect(lp); lp.connect(hp); hp.connect(no); no.connect(saida);
    return {
      entrada, saida, nos: [entrada, saida, lp, hp, no],
      aplicar(p, b) {
        const f = F.filtroBipolar(p[0]), q = 0.7071 + p[1] * (b[1] ? 14 : 8);
        mudar(ctx, lp.Q, q); mudar(ctx, hp.Q, q);
        if (b[0]) {   // rejeita-banda: o knob escolhe a frequência rejeitada, a largura o Q
          mudar(ctx, lp.frequency, 20000); mudar(ctx, hp.frequency, 20);
          mudar(ctx, no.frequency, 20 * Math.pow(1000, Math.abs(p[0]) / 100)); mudar(ctx, no.Q, 0.5 + (1 - p[2]) * 10);
        } else {
          mudar(ctx, lp.frequency, f.passaBaixa); mudar(ctx, hp.frequency, f.passaAlta); mudar(ctx, no.frequency, 22000);
        }
      },
    };
  }

  // ---- delay sincronizado: dois atrasos (L/R) com realimentação filtrada; congelar trava o eco ----
  function efeitoDelay(ctx, obterBpm) {
    const F = motor();
    const entrada = ganho(ctx, 1), saida = ganho(ctx, 1), entra = ganho(ctx, 1), mix = ganho(ctx, 1), fb = ganho(ctx, 0.3);
    const dl = ctx.createDelay(ATRASO_MAX), dr = ctx.createDelay(ATRASO_MAX), uniao = ctx.createChannelMerger(2);
    const filtro = biquad(ctx, 'lowpass', 20000, 0.7071);
    entrada.connect(entra); entra.connect(mix); mix.connect(dl); mix.connect(dr);
    dl.connect(uniao, 0, 0); dr.connect(uniao, 0, 1); uniao.connect(saida);
    uniao.connect(filtro); filtro.connect(fb); fb.connect(mix);
    return {
      entrada, saida, nos: [entrada, saida, entra, mix, fb, dl, dr, uniao, filtro],
      aplicar(p, b) {
        const t = limitar(F.tempoDelay(p[0], lerBpm(obterBpm)), 0.001, ATRASO_MAX - 0.1);
        mudar(ctx, dl.delayTime, t, 0.05); mudar(ctx, dr.delayTime, limitar(t * (b[1] ? 0.75 : 1), 0.001, ATRASO_MAX - 0.1), 0.05);
        mudar(ctx, fb.gain, F.ganhoDeRealimentacao(p[1], b[0]));
        mudar(ctx, entra.gain, b[0] ? 0 : 1);
        const f = F.filtroBipolar(p[2]);
        filtro.type = f.passaAlta > 20 ? 'highpass' : 'lowpass';
        mudar(ctx, filtro.frequency, f.passaAlta > 20 ? f.passaAlta : f.passaBaixa);
      },
    };
  }

  // ---- reverb: ConvolverNode com impulso gerado; tamanho refaz o impulso; congelar realimenta a saída ----
  function efeitoReverb(ctx) {
    const F = motor();
    const entrada = ganho(ctx, 1), saida = ganho(ctx, 1), entra = ganho(ctx, 1), mix = ganho(ctx, 1), fb = ganho(ctx, 0);
    const hp = biquad(ctx, 'highpass', 20, 0.7071), lp = biquad(ctx, 'lowpass', 20000, 0.7071), conv = ctx.createConvolver();
    entrada.connect(entra); entra.connect(hp); hp.connect(mix); mix.connect(conv); conv.connect(lp); lp.connect(saida);
    lp.connect(fb); fb.connect(mix);
    let duracao = 0;
    return {
      entrada, saida, nos: [entrada, saida, entra, mix, fb, hp, lp, conv],
      aplicar(p, b) {
        const d = 0.4 + p[0] * 5.6;   // 0,4 … 6 s
        if (!duracao || Math.abs(d - duracao) / duracao > 0.1) { duracao = d; conv.buffer = gerarImpulso(ctx, d); }
        mudar(ctx, hp.frequency, 20 * Math.pow(500, p[1]));
        mudar(ctx, lp.frequency, limitar(400 * Math.pow(50, p[2]) * (b[1] ? 1 : 0.7), 200, 20000));
        mudar(ctx, fb.gain, b[0] ? F.ganhoDeRealimentacao(0, true) : 0);
        mudar(ctx, entra.gain, b[0] ? 0 : 1);
      },
    };
  }

  // ---- flanger (atraso curto modulado) e phaser (4 passa-tudo modulados): lados L/R com LFO em fases opostas ----
  function efeitoModulado(ctx, obterBpm, ehFlanger) {
    const F = motor();
    const entrada = ganho(ctx, 1), saida = ganho(ctx, 1), mix = ganho(ctx, 1), fb = ganho(ctx, 0), uniao = ctx.createChannelMerger(2);
    const lfo = ctx.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = 0.5; lfo.start();
    const nos = [entrada, saida, mix, fb, uniao, lfo];
    const lados = [0, 1].map((i) => {
      const estagios = ehFlanger ? [ctx.createDelay(0.05)] : [0, 1, 2, 3].map(() => biquad(ctx, 'allpass', 700, 0.7));
      if (ehFlanger) estagios[0].delayTime.value = 0.004;
      for (let k = 1; k < estagios.length; k++) estagios[k - 1].connect(estagios[k]);
      const prof = ganho(ctx, 0); lfo.connect(prof);
      for (const e of estagios) prof.connect(ehFlanger ? e.delayTime : e.frequency);
      mix.connect(estagios[0]); estagios[estagios.length - 1].connect(uniao, 0, i);
      nos.push(prof, ...estagios);
      return { prof };
    });
    uniao.connect(saida); uniao.connect(fb); fb.connect(mix); entrada.connect(mix);
    return {
      entrada, saida, nos,
      aplicar(p, b) {
        mudar(ctx, lfo.frequency, F.frequenciaLfo(p[0], lerBpm(obterBpm), !!b[0]));
        const prof = ehFlanger ? 0.003 : 500;
        mudar(ctx, lados[0].prof.gain, prof); mudar(ctx, lados[1].prof.gain, prof * (1 - 2 * p[2]));
        mudar(ctx, fb.gain, (ehFlanger ? 1 : 0.75) * F.ganhoDeRealimentacao(p[1], false) * (b[1] ? -1 : 1));
      },
    };
  }

  // ---- gater: ganho aberto/fechado por um LFO na taxa do tempo mestre ----
  function efeitoGater(ctx, obterBpm) {
    const F = motor();
    const entrada = ganho(ctx, 1), saida = ganho(ctx, 1), porta = ganho(ctx, 1), amp = ganho(ctx, 0);
    const lfo = ctx.createOscillator(); lfo.type = 'square'; lfo.frequency.value = 2; lfo.start();
    entrada.connect(porta); porta.connect(saida); lfo.connect(amp); amp.connect(porta.gain);
    return {
      entrada, saida, nos: [entrada, saida, porta, amp, lfo],
      aplicar(p, b) {
        const hz = F.frequenciaGater(p[0], lerBpm(obterBpm), !!b[1]);
        lfo.type = p[1] < 0.34 ? 'square' : p[1] < 0.67 ? 'triangle' : 'sine';
        const v = p[2];   // vazamento: o que passa nos trechos fechados
        if (b[0]) { mudar(ctx, porta.gain, 0); mudar(ctx, amp.gain, 0); return; }   // mudo
        if (hz <= 0) { mudar(ctx, porta.gain, 1); mudar(ctx, amp.gain, 0); return; }   // taxa desligada: sempre aberto
        mudar(ctx, lfo.frequency, hz);
        mudar(ctx, porta.gain, (1 + v) / 2); mudar(ctx, amp.gain, (1 - v) / 2);
      },
    };
  }

  function criarEfeito(ctx, tipo, obterBpm) {
    let e;
    if (tipo === 'filtro') e = efeitoFiltro(ctx);
    else if (tipo === 'delay') e = efeitoDelay(ctx, obterBpm);
    else if (tipo === 'reverb') e = efeitoReverb(ctx);
    else if (tipo === 'flanger') e = efeitoModulado(ctx, obterBpm, true);
    else if (tipo === 'phaser') e = efeitoModulado(ctx, obterBpm, false);
    else if (tipo === 'gater') e = efeitoGater(ctx, obterBpm);
    else throw new Error('VbMxFxNos: tipo desconhecido ' + tipo);
    let ultimo = null;
    const aplicar = e.aplicar;
    return {
      tipo, entrada: e.entrada, saida: e.saida,
      aplicar(p, b) { ultimo = { p: p.slice(), b: b.slice() }; aplicar(p, b); },
      tempo() { if (ultimo) aplicar(ultimo.p, ultimo.b); },
      descartar() { desligar(e.nos); },
    };
  }

  // Uma posição da cadeia: contorna o efeito (ligado falso) ou passa por ele; troca o efeito se o tipo mudou.
  function criarPosicao(ctx, obterBpm) {
    const entrada = ganho(ctx, 1), saida = ganho(ctx, 1), desvio = ganho(ctx, 1), via = ganho(ctx, 0);
    entrada.connect(desvio); desvio.connect(saida); via.connect(saida);
    let efeito = null;
    return {
      entrada, saida,
      aplicar(def) {
        if (!def) { if (efeito) { efeito.descartar(); efeito = null; } mudar(ctx, desvio.gain, 1); mudar(ctx, via.gain, 0); return; }
        if (!efeito || efeito.tipo !== def.tipo) {
          if (efeito) efeito.descartar();
          efeito = criarEfeito(ctx, def.tipo, obterBpm);
          entrada.connect(efeito.entrada); efeito.saida.connect(via);
        }
        efeito.aplicar(def.params, def.botoes);
        mudar(ctx, desvio.gain, def.ligado ? 0 : 1); mudar(ctx, via.gain, def.ligado ? 1 : 0);
      },
      tempo() { if (efeito) efeito.tempo(); },
      descartar() { if (efeito) efeito.descartar(); efeito = null; desligar([entrada, saida, desvio, via]); },
    };
  }

  function criarUnidadeCanal(ctx, obterBpm) {
    const F = motor();
    const entrada = ganho(ctx, 1), saida = ganho(ctx, 1), seco = ganho(ctx, 1), molhado = ganho(ctx, 0);
    const posicoes = [0, 1, 2].map(() => criarPosicao(ctx, obterBpm));
    entrada.connect(seco); seco.connect(saida);
    entrada.connect(posicoes[0].entrada);
    for (let i = 1; i < posicoes.length; i++) posicoes[i - 1].saida.connect(posicoes[i].entrada);
    posicoes[2].saida.connect(molhado); molhado.connect(saida);
    return {
      entrada, saida,
      aplicar(cfg, ativo) {
        cfg.efeitos.forEach((def, i) => posicoes[i].aplicar(def));
        for (let i = cfg.efeitos.length; i < posicoes.length; i++) posicoes[i].aplicar(null);
        // sem nenhum efeito ligado a cadeia é cópia do sinal: misturá-la com o seco somaria o mesmo som duas vezes
        const m = ativo && cfg.efeitos.some(e => e.ligado) ? F.mistura(cfg.dw) : { seco: 1, molhado: 0 };
        mudar(ctx, seco.gain, m.seco); mudar(ctx, molhado.gain, m.molhado);
      },
      tempo() { for (const p of posicoes) p.tempo(); },
      descartar() { for (const p of posicoes) p.descartar(); desligar([entrada, saida, seco, molhado]); },
    };
  }

  return { criarUnidadeCanal, criarEfeito, gerarImpulso };
})();
if (typeof module === 'object' && module.exports) module.exports = VbMxFxNos;
