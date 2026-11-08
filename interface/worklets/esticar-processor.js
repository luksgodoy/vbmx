// ===================== Processador do key lock (VB-21) e do scratch (VB-57) — roda na THREAD DE ÁUDIO =====================
// Carregado por js/tocador.js com audioWorklet.addModule, DEPOIS de ../motor/esticar.js (o mesmo
// escopo global do worklet recebe VbMxEsticar). Para o scratch, o tocador carrega também
// ../motor/scratch.js (VbMxScratch) na 1ª vez que alguém pega o prato; a cabeça do scratch nasce aqui
// na 1ª mensagem 'scratch'. Não é <script> da página: aqui não há DOM nem window.
//
// Fronteira entre threads (só mensagens; SharedArrayBuffer exigiria isolamento de origem — COOP/COEP —,
// que quebraria o Essentia vindo do CDN):
//   página → worklet   {tipo:'fonte', canais:[Float32Array…], taxaAmostra}   (canais TRANSFERIDOS, sem cópia
//                                                                           na passagem; a cópia é feita uma
//                                                                           vez na página, ao ligar o key lock
//                                                                           ou ao pegar o prato — a MESMA serve
//                                                                           aos dois motores)
//                      {tipo:'estado', tocando, posicao, inicioCtx, taxa, duracao, loop, keyLock, semitons, geracao}
//                      {tipo:'parar', geracao} · {tipo:'soltar'} (larga a fonte: devolve a memória)
//                      'estado' e 'parar' com `quadro` (2026-10-26): valem no começo do bloco desse quadro — o t0
//                      agendado pela página, o mesmo em que a fonte normal faria a troca; quadro que já passou
//                      (ou sem quadro) vale na hora. Ficam numa fila, na ordem em que chegaram.
//                      {tipo:'scratch', acao:'pegar', posicao, quadro, taxa}      VB-57 (motor/scratch.js)
//                      {tipo:'scratch', acao:'mao', alvo, vel, em} · {acao:'saltar', alvo, em}
//                      {tipo:'scratch', acao:'soltar', posicao, em, vel, taxa, rampa, quadroFim} · {acao:'encerrar', quadro}
//   worklet → página   {tipo:'pronto', latencia}   uma vez, ao nascer
//                      {tipo:'fim', geracao}        a faixa acabou sozinha (a página só aceita se a geração
//                                                   ainda for a dela: busca/play depois disso vencem)
// O estado traz o relógio do transporte (posicao/inicioCtx/taxa): o worklet calcula a posição de cada
// grão com o próprio currentFrame, então a demora da mensagem não vira erro de posição.
// Scratch: enquanto a cabeça está ligada, ela toca; nos quadros de cruzamento (envelope < 1) o key lock
// entra com o peso que falta (1 − envelope), sem estalo na troca. Com o envelope cheio, o key lock que
// tocava antes do toque é parado (ao soltar, a página manda um 'estado' novo se ele deve voltar).
// process() não aloca: o motor e a cabeça já nascem com tudo, o rascunho do cruzamento nasce no
// construtor; a única exceção é o postMessage do 'fim' (uma vez por faixa), que clona um objeto pequeno.
/* global AudioWorkletProcessor, registerProcessor, sampleRate, currentFrame */
'use strict';
class VbMxEsticarProcessador extends AudioWorkletProcessor {
  constructor() {
    super();
    const E = globalThis.VbMxEsticar;
    this.E = E;
    this.motor = E ? E.criar({ taxaAmostra: sampleRate, canais: 2 }) : null;
    this.msgFim = { tipo: 'fim', geracao: 0 };
    this.cab = null;                       // cabeça do scratch (VB-57), criada na 1ª mensagem 'scratch'
    this.canais = null; this.taxaFonte = sampleRate;
    this.rascunho = [new Float32Array(4096), new Float32Array(4096)];   // o key lock durante o cruzamento
    this.pararNoCheio = false;             // pegou o prato com o key lock tocando: parar quando o scratch encher
    this.msgParar = { tocando: false, geracao: 0 };
    this.fila = [];                        // 'estado'/'parar' esperando o quadro deles
    this.port.onmessage = (ev) => this.receber(ev.data);
    this.port.postMessage({ tipo: 'pronto', latencia: E ? E.latencia(sampleRate) : null, motivo: E ? '' : 'VbMxEsticar não carregou no worklet' });
  }
  receber(m) {
    if (!m || !this.motor) return;
    if ((m.tipo === 'estado' || m.tipo === 'parar') && (this.fila.length > 0 || (typeof m.quadro === 'number' && m.quadro > currentFrame))) {
      this.fila.push(m);   // atrás de outro que espera, ou com quadro no futuro: espera a vez (a ordem não muda)
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
      this.cab = S.criarCabeca({ taxaAmostra: sampleRate, canais: 2 });
      this.cab.definirFonte(this.canais, this.taxaFonte);
    }
    const c = this.cab;
    if (m.acao === 'pegar') { this.fila.length = 0; c.pegar(m.posicao, m.quadro, m.taxa); this.pararNoCheio = true; }   // a mão vence o que esperava
    else if (m.acao === 'mao') c.mao(m.alvo, m.vel, m.em);
    else if (m.acao === 'saltar') c.saltar(m.alvo, m.em);
    else if (m.acao === 'soltar') c.soltar(m.posicao, m.em, m.vel, m.taxa, m.rampa, m.quadroFim);
    else if (m.acao === 'encerrar') c.encerrar(m.quadro);
  }
  // key lock nas saídas `s` (n quadros); avisa o fim da faixa
  esticar(s, n) {
    if (this.motor.renderizar(s, n, currentFrame) === this.E.FIM) {
      this.msgFim.geracao = this.motor.geracao();
      this.port.postMessage(this.msgFim);
    }
  }
  process(_entradas, saidas) {
    while (this.fila.length > 0 && !(this.fila[0].quadro > currentFrame)) this.aplicar(this.fila.shift());
    const s = saidas[0];
    if (!s || !s.length) return true;
    if (!this.motor) { for (let c = 0; c < s.length; c++) s[c].fill(0); return true; }
    const n = s[0].length, cab = this.cab;
    if (cab !== null && cab.ativa()) {
      const cod = cab.renderizar(s, n, currentFrame);
      if (cod === 1) {   // CHEIA: só o scratch soa neste bloco
        if (this.pararNoCheio) { this.pararNoCheio = false; this.motor.definirEstado(this.msgParar); }
        return true;
      }
      const ras = this.rascunho, env = cab.envelope;
      if (n > ras[0].length || s.length > ras.length) return true;
      this.esticar(ras, n);
      for (let c = 0; c < s.length; c++) {
        const sc = s[c], rc = ras[c];
        for (let i = 0; i < n; i++) sc[i] += (1 - env[i]) * rc[i];
      }
      return true;
    }
    this.esticar(s, n);
    return true;
  }
}
registerProcessor('vbmx-esticar', VbMxEsticarProcessador);
