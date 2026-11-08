// ===================== Processador das VOZES (stems, 2026-11-07) — roda na THREAD DE ÁUDIO =====================
// Irmão de worklets/esticar-processor.js para as vozes de um deck (js/tocador.js definirVozes; quem as monta é
// js/stems.js). Recebe EXATAMENTE as mesmas mensagens que o nó da faixa principal ('estado', 'parar', 'soltar',
// 'scratch' — o tocador espelha cada uma), mais a 'fonte' com 2 canais por voz. Um nó com N saídas estéreo
// (numberOfOutputs = N, outputChannelCount = [2…]); a saída i é a voz i.
// Por que UM motor de 2N canais e não N motores: o WSOLA (motor/esticar.js) decide o encaixe de cada grão pela
// soma de todos os canais da fonte; com um motor só, todas as vozes usam a MESMA decisão — ficam travadas entre si
// amostra a amostra, e a soma delas é a mesma conta que o nó da principal faz (a soma dos stems ≈ a faixa). Com N
// motores cada voz escolheria o encaixe pelo próprio sinal e elas sairiam de fase entre si (até ±tolerância).
// O mesmo vale para a cabeça do scratch (motor/scratch.js, genérica em canais).
// 'fim' não é postado: o fim da faixa é o da principal (o relógio). process() não aloca.
/* global AudioWorkletProcessor, registerProcessor, sampleRate, currentFrame */
'use strict';
class VbMxStemsProcessador extends AudioWorkletProcessor {
  constructor(opcoes) {
    super();
    const o = opcoes || {};
    this.nv = o.numberOfOutputs > 0 ? o.numberOfOutputs : 4;
    this.nc = 2 * this.nv;
    const E = globalThis.VbMxEsticar;
    this.E = E;
    this.motor = E ? E.criar({ taxaAmostra: sampleRate, canais: this.nc }) : null;
    this.cab = null; this.canais = null; this.taxaFonte = sampleRate;
    this.vista = new Array(this.nc).fill(null);   // os 2N canais das N saídas, na ordem das vozes
    this.rascunho = [];
    for (let c = 0; c < this.nc; c++) this.rascunho.push(new Float32Array(4096));
    this.pararNoCheio = false;
    this.msgParar = { tocando: false, geracao: 0 };
    this.fila = [];
    this.port.onmessage = (ev) => this.receber(ev.data);
    this.port.postMessage({ tipo: 'pronto', vozes: this.nv, motivo: E ? '' : 'VbMxEsticar não carregou no worklet' });
  }
  receber(m) {
    if (!m || !this.motor) return;
    if ((m.tipo === 'estado' || m.tipo === 'parar') && (this.fila.length > 0 || (typeof m.quadro === 'number' && m.quadro > currentFrame))) {
      this.fila.push(m);
      return;
    }
    this.aplicar(m);
  }
  aplicar(m) {
    if (m.tipo === 'fonte') {
      this.motor.definirFonte(m.canais, m.taxaAmostra);
      this.canais = m.canais; this.taxaFonte = m.taxaAmostra;
      if (this.cab) this.cab.definirFonte(m.canais, m.taxaAmostra);
    } else if (m.tipo === 'soltar') {
      this.motor.definirFonte(null); this.canais = null;
      if (this.cab) this.cab.definirFonte(null);
    } else if (m.tipo === 'estado') { this.pararNoCheio = false; this.motor.definirEstado(m); }
    else if (m.tipo === 'parar') this.motor.definirEstado({ tocando: false, geracao: m.geracao });
    else if (m.tipo === 'scratch') this.receberScratch(m);
  }
  receberScratch(m) {
    if (!this.cab) {
      const S = globalThis.VbMxScratch;
      if (!S) return;
      this.cab = S.criarCabeca({ taxaAmostra: sampleRate, canais: this.nc });
      this.cab.definirFonte(this.canais, this.taxaFonte);
    }
    const c = this.cab;
    if (m.acao === 'pegar') { this.fila.length = 0; c.pegar(m.posicao, m.quadro, m.taxa); this.pararNoCheio = true; }
    else if (m.acao === 'mao') c.mao(m.alvo, m.vel, m.em);
    else if (m.acao === 'saltar') c.saltar(m.alvo, m.em);
    else if (m.acao === 'soltar') c.soltar(m.posicao, m.em, m.vel, m.taxa, m.rampa, m.quadroFim);
    else if (m.acao === 'encerrar') c.encerrar(m.quadro);
  }
  process(_entradas, saidas) {
    while (this.fila.length > 0 && !(this.fila[0].quadro > currentFrame)) this.aplicar(this.fila.shift());
    const nv = this.nv, s = this.vista;
    if (!saidas || saidas.length < nv) return true;
    for (let o = 0; o < nv; o++) {
      const so = saidas[o];
      if (!so || so.length < 2) return true;   // o tocador sempre pede estéreo
      s[2 * o] = so[0]; s[2 * o + 1] = so[1];
    }
    if (!this.motor) { for (let c = 0; c < s.length; c++) s[c].fill(0); return true; }
    const n = s[0].length, cab = this.cab;
    if (cab !== null && cab.ativa()) {
      const cod = cab.renderizar(s, n, currentFrame);
      if (cod === 1) {
        if (this.pararNoCheio) { this.pararNoCheio = false; this.motor.definirEstado(this.msgParar); }
        return true;
      }
      const ras = this.rascunho, env = cab.envelope;
      if (n > ras[0].length) return true;
      this.motor.renderizar(ras, n, currentFrame);
      for (let c = 0; c < s.length; c++) {
        const sc = s[c], rc = ras[c];
        for (let i = 0; i < n; i++) sc[i] += (1 - env[i]) * rc[i];
      }
      return true;
    }
    this.motor.renderizar(s, n, currentFrame);
    return true;
  }
}
registerProcessor('vbmx-stems', VbMxStemsProcessador);
