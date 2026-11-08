// ===================== fx-canal.js — nós Web Audio dos efeitos de mixer por canal (VB-60, spec §6) =====================
// Só nós nativos (GainNode, DelayNode, BiquadFilterNode, ConvolverNode, WaveShaperNode, OscillatorNode, AudioBufferSource);
// o impulso do reverb e o ruído são GERADOS aqui por código. Os números vêm de VbMxMixer.fxParametros (motor/mixer.js,
// onde cada efeito está documentado: sopro, picote, rebate, camara, granulado, vaivem, caverna).
// A cadeia (js/cadeia.js) liga uma unidade por canal dentro do ponto "filtro", em paralelo ao caminho seco do filtro:
//   criar(ctx) → {entrada, saida, aplicar({id, params}), descartar()}
//   Com id "filtro" (ou sem efeito) a unidade fica muda e quem passa o som é o filtro; com um efeito escolhido a
//   unidade carrega o canal inteiro (cada efeito contém o próprio caminho seco) e o filtro fica fora.
//   Trocar de efeito é uma rampa curta (SUAVE) de portas: a soma dos ganhos é 1, sem estalo. Knob em 0 = params
//   {ativo:false}: misturas em 0 e seco em 1, o som passa intacto.
// lerBpm() lê o BPM do mestre (mestreBpm de js/mestre.js); sem mestre vale 120 no motor. Mudou o mestre, o mixer reaplica; mudou só o pitch do mestre, seguirBpm reaplica (VB-62).
(function (raiz, fabrica) {
  const api = fabrica(raiz);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.VbMxFxCanal = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (raiz) {
  'use strict';
  const SUAVE = 0.03;   // s, constante de tempo das mudanças e da troca de efeito
  const ganho = (ctx, v) => { const g = ctx.createGain(); g.gain.value = v; return g; };
  const biquad = (ctx, tipo, f, q) => { const b = ctx.createBiquadFilter(); b.type = tipo; b.frequency.value = f; if (q !== undefined) b.Q.value = q; return b; };
  const atraso = (ctx, max) => ctx.createDelay(max);
  const mudar = (ctx, param, v) => param.setTargetAtTime(v, ctx.currentTime, SUAVE);
  const desligar = (nos) => { for (const n of nos) { try { n.disconnect(); } catch (_) { /* já solto */ } if (n.stop) { try { n.stop(); } catch (_) { /* já parado */ } } } };
  const motor = () => raiz.VbMxMixer || require('../../motor/mixer.js');

  function lerBpm() { try { return typeof raiz.mestreBpm === 'function' ? raiz.mestreBpm() : NaN; } catch (_) { return NaN; } }

  function impulso(ctx, segundos) {   // ruído estéreo com decaimento (1 − t/d)^3, igual ao do reverb de js/fx-nos.js
    const taxa = ctx.sampleRate || 44100, n = Math.max(1, Math.floor(segundos * taxa)), buf = ctx.createBuffer(2, n, taxa);
    for (let c = 0; c < 2; c++) { const d = buf.getChannelData(c); for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 3); }
    return buf;
  }
  function ruido(ctx, segundos) {
    const taxa = ctx.sampleRate || 44100, n = Math.max(1, Math.floor(segundos * taxa)), buf = ctx.createBuffer(1, n, taxa), d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  // Cada construtor devolve {entrada, saida, aplicar(p), nos}; p = fxParametros(...), p.ativo falso = neutro.
  const CONSTRUTORES = {
    sopro(ctx) {
      const e = ganho(ctx, 1), s = ganho(ctx, 1), fonte = ctx.createBufferSource(), pb = biquad(ctx, 'bandpass', 800, 0.8), nivel = ganho(ctx, 0);
      fonte.buffer = ruido(ctx, 2); fonte.loop = true;
      e.connect(s); fonte.connect(pb); pb.connect(nivel); nivel.connect(s); fonte.start();
      return { entrada: e, saida: s, nos: [e, s, fonte, pb, nivel], aplicar(p) {
        mudar(ctx, nivel.gain, p.ativo ? p.nivel : 0);
        if (p.ativo) { mudar(ctx, pb.frequency, Math.min(p.freq, ctx.sampleRate ? ctx.sampleRate / 2 - 100 : p.freq)); mudar(ctx, pb.Q, p.q); }
      } };
    },
    picote(ctx) {
      const e = ganho(ctx, 1), s = ganho(ctx, 1), portador = ganho(ctx, 1), lfo = ctx.createOscillator(), mod = ganho(ctx, 0);
      lfo.type = 'square'; lfo.frequency.value = 4;
      e.connect(portador); portador.connect(s); lfo.connect(mod); mod.connect(portador.gain); lfo.start();
      return { entrada: e, saida: s, nos: [e, s, portador, lfo, mod], aplicar(p) {
        mudar(ctx, portador.gain, p.ativo ? p.base : 1);
        mudar(ctx, mod.gain, p.ativo ? p.modulacao : 0);
        if (p.ativo) mudar(ctx, lfo.frequency, p.freq);
      } };
    },
    rebate(ctx) {
      const e = ganho(ctx, 1), s = ganho(ctx, 1), d = atraso(ctx, 4), fb = ganho(ctx, 0), molhado = ganho(ctx, 0);
      e.connect(s); e.connect(d); d.connect(molhado); molhado.connect(s); d.connect(fb); fb.connect(d);
      return { entrada: e, saida: s, nos: [e, s, d, fb, molhado], aplicar(p) {
        mudar(ctx, molhado.gain, p.ativo ? p.molhado : 0);
        if (p.ativo) { mudar(ctx, d.delayTime, Math.min(p.atraso, 4)); mudar(ctx, fb.gain, p.realimentacao); }
      } };
    },
    camara(ctx) {
      const e = ganho(ctx, 1), s = ganho(ctx, 1), conv = ctx.createConvolver(), molhado = ganho(ctx, 0);
      conv.buffer = impulso(ctx, 1.2);
      e.connect(s); e.connect(conv); conv.connect(molhado); molhado.connect(s);
      return { entrada: e, saida: s, nos: [e, s, conv, molhado], aplicar(p) { mudar(ctx, molhado.gain, p.ativo ? p.molhado : 0); } };
    },
    granulado(ctx) {
      const e = ganho(ctx, 1), s = ganho(ctx, 1), seco = ganho(ctx, 1), ws = ctx.createWaveShaper(), molhado = ganho(ctx, 0);
      let bits = 0;
      ws.oversample = 'none';
      e.connect(seco); seco.connect(s); e.connect(ws); ws.connect(molhado); molhado.connect(s);
      return { entrada: e, saida: s, nos: [e, s, seco, ws, molhado], aplicar(p) {
        if (p.ativo && p.bits !== bits) { bits = p.bits; ws.curve = Float32Array.from(motor().curvaGranulado(p.passos)); }   // a curva só troca quando os bits mudam
        const m = p.ativo ? p.molhado : 0;
        mudar(ctx, molhado.gain, m); mudar(ctx, seco.gain, 1 - m);
      } };
    },
    vaivem(ctx) {
      const e = ganho(ctx, 1), s = ganho(ctx, 1), d = atraso(ctx, 0.05), fb = ganho(ctx, 0), molhado = ganho(ctx, 0), lfo = ctx.createOscillator(), prof = ganho(ctx, 0);
      d.delayTime.value = 0.003; lfo.type = 'sine'; lfo.frequency.value = 0.3;
      e.connect(s); e.connect(d); d.connect(molhado); molhado.connect(s); d.connect(fb); fb.connect(d); lfo.connect(prof); prof.connect(d.delayTime); lfo.start();
      return { entrada: e, saida: s, nos: [e, s, d, fb, molhado, lfo, prof], aplicar(p) {
        mudar(ctx, molhado.gain, p.ativo ? p.molhado : 0);
        if (p.ativo) { mudar(ctx, d.delayTime, p.atrasoBase); mudar(ctx, prof.gain, p.profundidade); mudar(ctx, lfo.frequency, p.taxa); mudar(ctx, fb.gain, p.realimentacao); }
      } };
    },
    caverna(ctx) {
      const e = ganho(ctx, 1), s = ganho(ctx, 1), d = atraso(ctx, 4), pb = biquad(ctx, 'lowpass', 2800, 0.7071), pa = biquad(ctx, 'highpass', 200, 0.7071), fb = ganho(ctx, 0), molhado = ganho(ctx, 0);
      e.connect(s); e.connect(d); d.connect(pb); pb.connect(pa); pa.connect(molhado); molhado.connect(s); pa.connect(fb); fb.connect(d);   // o laço passa pelos dois filtros: cada repetição fica mais escura
      return { entrada: e, saida: s, nos: [e, s, d, pb, pa, fb, molhado], aplicar(p) {
        mudar(ctx, molhado.gain, p.ativo ? p.molhado : 0);
        if (p.ativo) { mudar(ctx, d.delayTime, Math.min(p.atraso, 4)); mudar(ctx, fb.gain, p.realimentacao); mudar(ctx, pb.frequency, p.passaBaixa); mudar(ctx, pa.frequency, p.passaAlta); }
      } };
    },
  };

  function criar(ctx) {
    const entrada = ganho(ctx, 1), saida = ganho(ctx, 1), unidades = {};   // unidades[id] = {porta, efeito}, construídas na 1ª vez
    let atual = 'filtro';
    function garantir(id) {
      if (unidades[id]) return unidades[id];
      const efeito = CONSTRUTORES[id](ctx), porta = ganho(ctx, 0);
      entrada.connect(porta); porta.connect(efeito.entrada); efeito.saida.connect(saida);
      return (unidades[id] = { porta, efeito });
    }
    // cfg = {id, params}: id "filtro" (ou desconhecido) silencia a unidade; um efeito abre a porta dele e fecha as outras.
    function aplicar(cfg) {
      const id = cfg && CONSTRUTORES[cfg.id] ? cfg.id : 'filtro';
      if (id !== 'filtro') { const u = garantir(id); u.efeito.aplicar(cfg.params || { ativo: false }); }
      for (const k of Object.keys(unidades)) mudar(ctx, unidades[k].porta.gain, k === id ? 1 : 0);
      atual = id;
    }
    function descartar() {
      for (const k of Object.keys(unidades)) desligar([unidades[k].porta, ...unidades[k].efeito.nos]);
      desligar([entrada, saida]);
    }
    return { entrada, saida, aplicar, descartar, ativo: () => atual !== 'filtro' };
  }

  // VB-62: o BPM efetivo do mestre muda também com o pitch do deck mestre, e isso não emite `mestre:mudou`.
  // seguirBpm confere o BPM a cada tick e chama reaplicar() só quando ele mudou (tolerância 0,01 BPM; NaN→NaN não conta).
  function seguirBpm(opcoes) {
    const ler = opcoes && opcoes.ler || lerBpm, reaplicar = opcoes.reaplicar, tol = opcoes.tolerancia === undefined ? 0.01 : opcoes.tolerancia;
    let ultimo = ler(), timer = null;
    function conferir() {
      const b = ler();
      const igual = (Number.isNaN(b) && Number.isNaN(ultimo)) || Math.abs(b - ultimo) <= tol;
      if (igual) return false;
      ultimo = b; reaplicar(b); return true;
    }
    if (opcoes.intervaloMs && typeof setInterval === 'function') timer = setInterval(conferir, opcoes.intervaloMs);
    return { conferir, parar() { if (timer) clearInterval(timer); timer = null; } };
  }

  return { criar, lerBpm, seguirBpm, SUAVE };
});
