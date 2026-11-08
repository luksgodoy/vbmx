// ===================== VbMxTocador: quem toca o áudio de cada deck (VB-11, VB-21) =====================
// O deck nunca toca num nó de áudio direto: pede ao tocador. Dois backends ATRÁS DESTA MESMA API:
//   • AudioBufferSourceNode (um por play, como antes do VB-11) — o padrão, e o único sem key lock e sem
//     semitons: a taxa vai no playbackRate e o tom acompanha o tempo (como vinil);
//   • AudioWorklet de time-stretch (VB-21: worklets/esticar-processor.js + motor/esticar.js, WSOLA) —
//     com key lock ligado ou semitons ≠ 0. Segue o MESMO relógio de motor/transporte.js (posição =
//     posicao + (t − inicioCtx) × taxa): a página lê posição/estado igual nos dois.
// A conta de posição/loop/quantize é motor/transporte.js. Contrato: docs/contratos.md.
//
//   configurar({ctx, destino(letra) → AudioNode, aoTerminar(letra)})   audio.js, no 1º gesto
//   carregar(letra, buffer)          para o que tocava; cabeça em 0, taxa mantida, sem loop
//   descarregar(letra)
//   tocar(letra) · pausar(letra)     tocar no fim recomeça do 0; sem buffer não faz nada
//   buscar(letra, t, {quantizar, grade, em})   pula (tocando, segue tocando de lá); grade = motor/grade.js;
//                                    `em` (s do relógio, VB-20): t vale naquele instante e o tocador o
//                                    projeta até agora na taxa do deck — o SYNC de fase calcula t com
//                                    estados lidos em `em` e não perde o tempo entre ler e pular
//   definirTaxa(letra, taxa)         1 = original (pitch +6% → 1,06), sem perder a posição
//   definirLoop(letra, {inicio, fim} | null)   loop sem emenda (loopStart/loopEnd do próprio nó)
//   posicao(letra)                   s da faixa agora
//   estado(letra, em?)               cópia rebaseada {tocando, posicao, inicioCtx, taxa, duracao, loop}
//                                    (em `em`, se vier; senão agora): as funções de motor/waveform.js
//                                    ficam exatas com ela, e dois decks lidos no mesmo `em` são comparáveis
//   definirReverso(letra, ligado)    VB-37: reverso enquanto o botão está apertado. Toca um buffer INVERTIDO
//                                    (feito uma vez por faixa, na 1ª vez que pedem) a partir da posição espelhada
//                                    (duração − posição); solto, volta ao buffer normal na posição onde a ré chegou.
//                                    Parado, a ré toca e, ao soltar, o deck para. Não há loop em ré.
//   apertarCup(letra, cue, {quantizar, grade}) · soltarCup(letra)   VB-37: CUP salta ao cue e fica parado;
//                                    ao soltar, toca dali (motor/transporte.js apertarCup/soltarCup)
//   relogio()                        s do AudioContext em que o PRÓXIMO comando vale (0 sem contexto): ver "Tempo" abaixo
//   posicaoNaTela(letra)             s da faixa que SOA agora (o instante ouvido: currentTime menos a latência de saída) —
//                                    a cabeça e os marcadores da onda; nunca para calcular comando
//   trilha(letra)                    diagnóstico: [{desde, e}] — o estado que valeu a partir de cada instante (~2 s)
//   temBuffer(letra)
//
// Tempo (2026-10-26, "o sync e os marcadores perdem a sincronia com o tempo"; medido em spike/medir-deriva.js):
// o som, o transporte, o SYNC e a tela usam o MESMO instante. No AudioContext de verdade um comando dado com
// `param.value =` ou `start(0)` vale no quantum que a thread de áudio renderiza depois de recebê-lo — 0 a 1 quantum
// além do currentTime lido (medido; mais com buffer maior) — e o transporte o datava em currentTime: cada partida
// ficava até um quantum adiantada no transporte e cada troca de taxa somava (atraso × Δtaxa) que nada corrigia.
// Agora todo comando é AGENDADO num instante t0 = currentTime + margem, no começo de um quantum (relogio()): a fonte
// usa start(t0)/stop(t0)/playbackRate.setValueAtTime(taxa, t0) — degrau, nunca rampa —, o worklet aplica o estado no
// quadro de t0, e o transporte rebaseia em t0. Margem: configurar({margem}) ou, num AudioContext em tempo real,
// max(12 ms, 2 × baseLatency + 1 quantum); contexto sem baseLatency (offline, os de mentira dos testes) = 0, imediato.
// Quem lê posicao/estado sem `em` recebe o instante t0, o mesmo em que o comando que ele calcular vai valer.
//   definirKeyLock(letra, ligado) → Promise<{ok, motivo}>   VB-21: key lock por deck (padrão desligado; vale
//                                    até desligar, atravessa a troca de faixa). Ligado, o tempo segue a taxa e
//                                    o tom fica o da faixa. Na 1ª vez carrega o worklet (assíncrono): até ficar
//                                    pronto o deck segue no backend normal. Sem AudioWorklet: ok=false + motivo.
//   definirSemitons(letra, st) → Promise<{ok, motivo}>   knob KEY (VB-38): tom em semitons (−12…+12) SEM mudar
//                                    o tempo; com key lock desligado soma ao tom que o pitch já muda.
//   definirModoKeyLock(modo)         VB-38, global: 'normal' (key lock em toda velocidade, o padrão) ou 'scratch'
//                                    (o key lock solta abaixo de −30% e acima de +50% de taxa: motor/tom.js
//                                    keyLockAtivo). Em scratch fora da faixa o deck SEGUE no worklet, só que com o
//                                    tom acompanhando o tempo — sem trocar de backend no meio de um arrasto.
//   keyLock(letra)                   {ligado, semitons, ativo (o worklet é quem toca agora), efetivo (o tom está
//                                    travado agora: ligado e dentro da faixa do modo), modo, pronto, motivo, latencia}
// Reverso (VB-37) sempre no buffer invertido, mesmo com key lock: na ré o tom segue o tempo.
// Memória: com key lock ligado o worklet guarda uma CÓPIA dos canais da faixa (≈ 127 MB por 6 min
// estéreo a 44,1 kHz). VB-38: desligar o key lock (e o KEY em 0) não larga a cópia na hora — ela fica
// `esperaSoltar` ms (padrão 30 s, em configurar) e religar nesse meio-tempo reaproveita a mesma, sem copiar
// de novo; trocar a faixa ou descarregar larga na hora.
//
// Scratch e jog (VB-57; contas em motor/scratch.js, gesto em js/scratch.js). Taxa com sinal e contínua não sai
// do AudioBufferSourceNode: a mão toca pela CABEÇA DE SCRATCH do mesmo worklet do key lock (mesmo nó, MESMA
// cópia da faixa — pegar o prato faz a cópia se o key lock ainda não fez; ela fica os mesmos `esperaSoltar` ms).
//   prepararScratch() → Promise<bool>   carrega o worklet e ../motor/scratch.js (a página chama ao passar o mouse)
//   scratchPegar(letra) → {ok, audio}   a mão pega o disco. Posição e estado passam a ser os da MÃO (estado:
//                                    tocando=false, scratch=true); o que tocava sai num cruzamento de CRUZAR_S
//                                    agendado MARGEM_S à frente. audio=false (worklet ainda não pronto): busca muda
//   scratchMover(letra, deltaS, vel)    a mão andou deltaS s de música (com sinal); vel = velocidade dela (s/s)
//   scratchSoltar(letra)               a taxa vai da mão à do pitch (ou a 0, se o deck estava parado) em
//                                    RAMPA_SOLTAR_S; no fim da rampa o backend normal assume no quadro exato,
//                                    da posição onde a mão deixou (+ a rampa)
//   scratch(letra) → {ativo, fase: 'mao'|'soltando'|null, audio, pronto}
// Durante a mão: tocar/pausar só decidem se o deck retoma ao soltar; buscar move a mão (salto); taxa e loop
// ficam guardados para depois; reverso não vale. Key lock e KEY não se aplicam ao scratch: o tom segue a mão.
// Cada AudioBufferSourceNode passa por um GainNode próprio (o cruzamento da entrada no scratch).
//
// Primeira pegada (VB-58): copiar a faixa inteira no 1º toque trava a página (~127 MB por 6 min; um memcpy de
// dezenas de ms) e, com o worklet ainda carregando, a pegada saía muda.
//   preCarregar(letra) → Promise<bool>  js/scratch.js chama ao carregar a faixa: carrega o worklet e a cabeça
//                                    (prepararScratch) e copia a faixa em FATIAS de tempo ocioso (requestIdleCallback,
//                                    ≤ preCarga.orcamentoMs por fatia); no fim a cópia vai TRANSFERIDA ao worklet.
//                                    Essa cópia fica enquanto a faixa estiver no deck (o prazo do VB-38 não a larga)
//                                    e é a ÚNICA: key lock, KEY e scratch usam a mesma; quem precisar dela antes do fim
//                                    termina a cópia ali (só o que falta). Faixa acima de preCarga.maxS: só o worklet
//                                    é preparado (a cópia segue sob demanda, como antes). true = cópia no worklet.
//   Pegar o disco com o worklet ainda carregando: a mão começa muda e GANHA o som quando ele fica pronto.
// Por que não transferir os canais do próprio AudioBuffer (sem cópia): ao transferir, o ArrayBuffer de
// getChannelData fica DESANEXADO na página — o AudioBufferSourceNode passa a tocar silêncio (a spec manda
// "adquirir o conteúdo" e devolver zeros se algum canal foi desanexado), a ré (bufferInvertido) e as ondas
// perdem os dados. Uma 2ª referência às mesmas amostras nas duas threads só existe com SharedArrayBuffer, que
// exige isolamento de origem (COOP/COEP) e quebra o Essentia do CDN. Fica a cópia, uma só, feita sem travar.
//
// Vozes (stems, 2026-11-07; quem usa é js/stems.js — VbMxStems). Companheiras que seguem o deck AMOSTRA A AMOSTRA:
// cada fonte da faixa principal ganha, no mesmo start(t0, offset), a mesma taxa, o mesmo stop, o mesmo loop e a mesma
// ré, uma fonte por voz; com key lock/semitons/scratch, um 2º nó de worklet (worklets/stems-processor.js, N saídas
// estéreo, UM motor WSOLA de 2N canais: as vozes dividem as decisões de grão) recebe as MESMAS mensagens do nó da
// principal. A principal segue sendo o relógio (transporte, fim da faixa, aoTerminar): só a saída dela vai a 0.
//   definirVozes(letra, [{buffer, destino: AudioNode}] | null, {aoLargar(letra)}) → bool   entra/sai num cruzamento
//                                    linear de RAMPA_VOZES_S (principal 1→0, vozes 0→1, no mesmo t0); trocar ou descarregar
//                                    a faixa larga as vozes na hora (e chama aoLargar)
//   vozes(letra) → {ativas, n, worklet}   · prepararVozes() → Promise<bool> (carrega o processador das vozes)
//   bufferDe(letra) → o AudioBuffer da faixa no deck (ou null)
(function (raiz, fabrica) {
  const api = fabrica(raiz);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.VbMxTocador = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (raiz) {
  'use strict';
  const T = raiz.VbMxTransporte || (typeof require === 'function' ? require('../../motor/transporte.js') : null);
  const TOM = raiz.VbMxTom || (typeof require === 'function' ? require('../../motor/tom.js') : null);
  const S = raiz.VbMxScratch || (typeof require === 'function' ? require('../../motor/scratch.js') : null);
  let modoKeyLock = 'normal';   // VB-38: preferência global (js/deck-tela.js a lê e repassa)
  let cfg = { ctx: null, destino: null, aoTerminar: null, esperaSoltar: 30000,
    preCarga: { maxS: 15 * 60, orcamentoMs: 6, fatia: 1 << 17 },   // VB-58: 15 min ≈ 318 MB de cópia estéreo a 44,1 kHz
    worklets: { motor: '../motor/esticar.js', processador: 'worklets/esticar-processor.js', scratch: '../motor/scratch.js', vozes: 'worklets/stems-processor.js' } };
  const decks = {};
  function deck(letra) {
    if (!decks[letra]) {
      const d = { buffer: null, fonte: null, ganho: null, rev: null,
        keyLock: false, semitons: 0, no: null, noFonte: null, tocaWorklet: false, geracao: 0, soltarDepois: null,
        sc: null, scFim: null, assentarDepois: null, pre: null, manter: false, trilha: [], estadoAtual: null,
        vozes: null, aoLargarVozes: null, noV: null, noVFonte: null, saidaP: null, saidaPCtx: null };   // vozes (stems)
      // `d.e` é o estado do transporte; cada troca fica anotada na trilha com o instante em que passa a valer
      // (posicaoNaTela lê o passado: o instante ouvido vem antes do t0 dos comandos).
      Object.defineProperty(d, 'e', { enumerable: true, get() { return d.estadoAtual; }, set(v) { d.estadoAtual = v; anotar(d, v); } });
      d.e = T.estadoInicial(0);
      decks[letra] = d;
    }
    return decks[letra];
  }
  const agora = () => (cfg.ctx ? cfg.ctx.currentTime : 0);
  const num = (x) => typeof x === 'number' && Number.isFinite(x);

  function configurar(c) {
    const ctxAntes = cfg.ctx;
    cfg = { ...cfg, ...c };
    if (cfg.ctx !== ctxAntes) { ultimoAgendado = 0; for (const l of Object.keys(decks)) decks[l].trilha.length = 0; }   // relógio novo: a trilha recomeça
  }

  // ---------------- o instante dos comandos (ver "Tempo" no cabeçalho) ----------------
  const QUANTUM = 128, MARGEM_TEMPO_REAL_S = 0.012;
  const taxaDoCtx = () => (cfg.ctx && cfg.ctx.sampleRate > 0 ? cfg.ctx.sampleRate : 44100);
  function margem() {
    if (num(cfg.margem) && cfg.margem >= 0) return cfg.margem;
    const b = cfg.ctx && cfg.ctx.baseLatency;
    return num(b) && b >= 0 ? Math.max(MARGEM_TEMPO_REAL_S, 2 * b + QUANTUM / taxaDoCtx()) : 0;
  }
  let ultimoAgendado = 0;
  // t0: agora + margem, no começo do quantum seguinte (o playbackRate é k-rate: só muda na borda de um quantum)
  function agendar() {
    const ag = agora(), m = margem();
    if (!(m > 0)) return ag;
    const sr = taxaDoCtx();
    // nunca antes de um t0 já dado: um comando posterior não pode valer antes do anterior
    ultimoAgendado = Math.max(ultimoAgendado, (Math.ceil(((ag + m) * sr) / QUANTUM - 1e-9) * QUANTUM) / sr);
    return ultimoAgendado;
  }
  // Taxa nova em t0: degrau agendado (setValueAtTime); sem t0 futuro (ou num param sem agenda), na hora. O
  // playbackRate é k-rate (um valor por quantum, lido no 1º quadro): o evento vai meia amostra ANTES da borda,
  // senão o arredondamento de t0 × taxa de amostragem o empurra para o quantum seguinte (medido: 128 quadros
  // tarde em parte das trocas, ≈ 2,9 ms × Δtaxa acumulando).
  function taxaEm(param, taxa, t0) {
    if (t0 > agora() && typeof param.setValueAtTime === 'function') param.setValueAtTime(taxa, t0 - 0.5 / taxaDoCtx());
    else param.value = taxa;
  }
  function anotar(d, e) {
    const h = d.trilha, ag = agora(), ultimo = h.length ? h[h.length - 1].desde : -Infinity;
    let desde = e.tocando ? e.inicioCtx : (ultimoAgendado > ag && ultimoAgendado < ag + 1 ? ultimoAgendado : ag);   // parado: desde o t0 do comando em curso
    if (!(desde >= ultimo)) desde = ultimo;
    if (h.length && h[h.length - 1].desde === desde) h[h.length - 1] = { desde, e };
    else h.push({ desde, e });
    while (h.length > 2 && (h.length > 64 || h[1].desde < ag - 2)) h.shift();
  }
  // A posição no instante t pela trilha: o estado que valia em t (o mesmo que o som seguia).
  function posicaoNoInstante(d, t) {
    const h = d.trilha;
    for (let i = h.length - 1; i >= 0; i--) if (h[i].desde <= t) return T.posicaoEm(h[i].e, t);
    return T.posicaoEm(h.length ? h[0].e : d.e, t);
  }
  // O instante que SOA agora: getOutputTimestamp (o próprio navegador mede) ou currentTime − latências.
  function instanteOuvido() {
    const c = cfg.ctx;
    if (!c) return 0;
    const ag = c.currentTime;
    if (typeof c.getOutputTimestamp === 'function' && raiz.performance && typeof raiz.performance.now === 'function') {
      const ts = c.getOutputTimestamp();
      if (ts && ts.contextTime > 0 && ts.performanceTime > 0) {
        const t = ts.contextTime + (raiz.performance.now() - ts.performanceTime) / 1000;
        if (t <= ag + 0.002 && t > ag - 1) return Math.min(t, ag);
      }
    }
    return ag - (num(c.baseLatency) ? c.baseLatency : 0) - (num(c.outputLatency) ? c.outputLatency : 0);
  }

  // ---------------- backend AudioWorklet (VB-21) ----------------
  const kl = { estado: 'nada', promessa: null, motivo: '', latencia: null, ctx: null };   // nada|carregando|pronto|erro
  function prepararWorklet() {
    const ctx = cfg.ctx;
    if (kl.ctx !== ctx) { kl.estado = 'nada'; kl.promessa = null; kl.motivo = ''; kl.ctx = ctx; }
    if (kl.promessa) return kl.promessa;
    if (!ctx) { kl.motivo = 'sem áudio ainda (dê play ou solte uma faixa)'; return Promise.resolve(false); }
    if (!ctx.audioWorklet || typeof ctx.audioWorklet.addModule !== 'function' || typeof raiz.AudioWorkletNode !== 'function') {
      kl.estado = 'erro'; kl.motivo = 'este navegador não tem AudioWorklet';
      kl.promessa = Promise.resolve(false); return kl.promessa;
    }
    kl.estado = 'carregando';
    kl.promessa = ctx.audioWorklet.addModule(cfg.worklets.motor)
      .then(() => ctx.audioWorklet.addModule(cfg.worklets.processador))
      .then(() => { kl.estado = 'pronto'; kl.motivo = ''; return true; },
            (err) => { kl.estado = 'erro'; kl.motivo = `o worklet do key lock não carregou (${err && err.message ? err.message : err})`; return false; });
    return kl.promessa;
  }
  const querWorklet = (d) => d.keyLock || d.semitons !== 0;
  const querCopia = (d) => querWorklet(d) || !!d.sc || (d.manter && !!d.buffer);   // VB-57: o scratch lê a cópia; VB-58: pré-carga
  const usaWorklet = (d) => querWorklet(d) && !!d.no && !!d.buffer && d.noFonte === d.buffer && d.e.sentido !== -1;
  function aoMensagemDoWorklet(letra, d, m) {
    if (!m) return;
    if (m.tipo === 'pronto') { kl.latencia = m.latencia || null; if (m.motivo) { kl.estado = 'erro'; kl.motivo = m.motivo; } return; }
    if (m.tipo !== 'fim' || m.geracao !== d.geracao || !d.tocaWorklet || !d.e.tocando) return;   // fim velho: busca/play vencem
    d.tocaWorklet = false; d.e = T.terminou(d.e);
    if (cfg.aoTerminar) cfg.aoTerminar(letra);
  }
  // Nó (um por deck, ligado ao canal para sempre) e a cópia dos canais da faixa no worklet. Síncrono depois
  // que o módulo carregou: a ordem das mensagens garante que a 'fonte' chega antes do 1º 'estado'.
  function garantirNoEFonte(letra, d) {
    if (kl.estado !== 'pronto' || !cfg.ctx || kl.ctx !== cfg.ctx) return false;
    if (d.no && d.no.context && d.no.context !== cfg.ctx) { d.no = null; d.noFonte = null; d.tocaWorklet = false; }   // contexto novo: nó novo
    if (!d.no) {
      const no = new raiz.AudioWorkletNode(cfg.ctx, 'vbmx-esticar', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
      no.port.onmessage = (ev) => aoMensagemDoWorklet(letra, d, ev.data);
      no.connect(saidaDe(letra, d));
      d.no = no;
    }
    cancelarSoltar(d);   // religou antes do prazo: a cópia que está lá serve
    if (d.buffer && d.noFonte !== d.buffer) {
      const b = d.buffer, canais = copiaDaFaixa(d, b);   // cópia: o AudioBuffer segue intacto
      d.no.port.postMessage({ tipo: 'fonte', canais, taxaAmostra: b.sampleRate }, canais.map((a) => a.buffer));
      d.noFonte = b;
    }
    return true;
  }
  // A cópia dos canais de b: a da pré-carga, terminada aqui se ainda faltava um pedaço; senão, inteira agora.
  function copiaDaFaixa(d, b) {
    const pre = d.pre;
    if (pre && pre.buffer === b) {
      const resolver = pre.resolver; pre.resolver = null;
      cancelarPre(d);
      copiarFatia(pre, Infinity);   // só o que faltava
      if (resolver) resolver(true);   // a pré-carga acabou aqui: a cópia vai ao worklet agora
      return pre.canais;
    }
    const canais = [];
    for (let c = 0; c < b.numberOfChannels; c++) canais.push(new Float32Array(b.getChannelData(c)));
    return canais;
  }
  function soltarFonteDoWorklet(d) {
    cancelarSoltar(d);
    if (d.no && d.noFonte) d.no.port.postMessage({ tipo: 'soltar' });
    d.noFonte = null;
    if (d.noV && d.noVFonte) d.noV.port.postMessage({ tipo: 'soltar' });   // a cópia das vozes sai junto
    d.noVFonte = null;
  }

  // ---------------- vozes (stems): ver o cabeçalho ----------------
  const RAMPA_VOZES_S = 0.01;
  const kv = { estado: 'nada', promessa: null, ctx: null };   // o processador das vozes no worklet: nada|carregando|pronto|erro
  function prepararVozes() {
    const ctx = cfg.ctx;
    if (kv.ctx !== ctx) { kv.estado = 'nada'; kv.promessa = null; kv.ctx = ctx; }
    if (kv.promessa) return kv.promessa;
    if (!ctx || !cfg.worklets.vozes) return Promise.resolve(false);
    kv.estado = 'carregando';
    kv.promessa = prepararWorklet().then((ok) => {
      if (!ok) { kv.estado = 'erro'; return false; }
      return ctx.audioWorklet.addModule(cfg.worklets.vozes).then(() => { kv.estado = 'pronto'; return true; }, () => { kv.estado = 'erro'; return false; });
    });
    return kv.promessa;
  }
  // Para onde vai o som da principal: o ganho de saída dela (nasce com as primeiras vozes) ou o destino do canal.
  const saidaDe = (letra, d) => (d.saidaP && d.saidaPCtx === cfg.ctx ? d.saidaP : cfg.destino(letra));
  // Rampa linear de `de` a `ate` em RAMPA_VOZES_S a partir de t0 (sem agenda no param: degrau na hora).
  function rampaAte(param, de, ate, t0) {
    if (typeof param.setValueAtTime !== 'function' || typeof param.linearRampToValueAtTime !== 'function') { param.value = ate; return; }
    if (typeof param.cancelScheduledValues === 'function') param.cancelScheduledValues(Math.min(t0, agora()));
    param.setValueAtTime(de, t0); param.linearRampToValueAtTime(ate, t0 + RAMPA_VOZES_S);
  }
  // Nó das vozes no worklet e a cópia dos canais delas (só quando o worklet toca: key lock, KEY, scratch).
  function vozesNoWorklet(d) {
    if (!d.vozes || !d.buffer || kv.estado !== 'pronto' || kv.ctx !== cfg.ctx || typeof raiz.AudioWorkletNode !== 'function') return false;
    if (d.noV && d.noV.context && d.noV.context !== cfg.ctx) { d.noV = null; d.noVFonte = null; }
    if (!d.noV) {
      const n = d.vozes.length;
      const no = new raiz.AudioWorkletNode(cfg.ctx, 'vbmx-stems', { numberOfInputs: 0, numberOfOutputs: n, outputChannelCount: d.vozes.map(() => 2) });
      for (let i = 0; i < n; i++) no.connect(d.vozes[i].entrada, i, 0);
      d.noV = no;
    }
    if (d.noVFonte !== d.buffer) {
      const canais = [];   // 2 por voz (mono vira os dois lados); cópia: os AudioBuffers seguem intactos
      for (const v of d.vozes) for (let c = 0; c < 2; c++) canais.push(new Float32Array(v.buffer.getChannelData(Math.min(c, v.buffer.numberOfChannels - 1))));
      d.noV.port.postMessage({ tipo: 'fonte', canais, taxaAmostra: d.buffer.sampleRate }, canais.map((a) => a.buffer));
      d.noVFonte = d.buffer;
    }
    return true;
  }
  // A MESMA mensagem do nó da principal vai ao das vozes (`garantir`: monta o nó e a cópia se ainda não há).
  function espelhar(d, m, garantir) {
    if (!d.vozes) return;
    if (garantir ? vozesNoWorklet(d) : (d.noV && d.noVFonte)) d.noV.port.postMessage(m);
  }
  function invertidoDaVoz(v) {
    if (v.rev) return v.rev;
    const ctx = cfg.ctx, b = v.buffer;
    if (!ctx || !b || typeof ctx.createBuffer !== 'function') return null;
    const r = ctx.createBuffer(b.numberOfChannels, b.length, b.sampleRate);
    for (let c = 0; c < b.numberOfChannels; c++) {
      const de = b.getChannelData(c), para = r.getChannelData(c), n = de.length;
      for (let i = 0; i < n; i++) para[i] = de[n - 1 - i];
    }
    return (v.rev = r);
  }
  // Uma fonte por voz, no MESMO instante/posição/taxa/loop/sentido da principal (`pos`: s da faixa em `quando`).
  function iniciarVozes(d, quando, pos, cruzar) {
    if (!d.vozes) return;
    const re = d.e.sentido === -1, agendado = quando > agora();
    for (const v of d.vozes) {
      const buf = re ? invertidoDaVoz(v) : v.buffer;
      if (!buf) continue;
      const { src, g } = novaFonte(d, buf, re, v.entrada);
      src.onended = () => { if (v.fonte === src) { v.fonte = null; v.ganho = null; } desligarFonte(src, g); };
      v.fonte = src; v.ganho = g;
      if (agendado && cruzar && rampaDeGanho(g)) { g.gain.setValueAtTime(0, quando); g.gain.linearRampToValueAtTime(1, quando + S.CRUZAR_S); }
      src.start(agendado ? quando : 0, re ? Math.max(0, d.e.duracao - pos) : pos);
    }
  }
  function pararVozes(d, q, futuro, rampa) {
    if (!d.vozes) return;
    for (const v of d.vozes) {
      const s = v.fonte, g = v.ganho; v.fonte = null; v.ganho = null;
      if (!s) continue;
      if (rampa) {   // pararFonteEm: o mesmo cruzamento da principal
        s.onended = () => desligarFonte(s, g);
        let fim = q;
        if (rampaDeGanho(g)) { g.gain.setValueAtTime(1, q); g.gain.linearRampToValueAtTime(0, q + S.CRUZAR_S); fim = q + S.CRUZAR_S; }
        try { s.stop(fim); } catch (_) { /* já parou */ }
      } else if (futuro) { s.onended = () => desligarFonte(s, g); try { s.stop(q); } catch (_) { /* já parou */ } }
      else { s.onended = null; try { s.stop(); } catch (_) { /* já parou */ } desligarFonte(s, g); }
    }
  }
  // As vozes entram com o deck no estado em que está (tocando por fonte, pelo worklet, ou com a mão no disco).
  function juntarVozes(letra, d) {
    if (!d.vozes) return;
    const sc = d.sc;
    if (sc && sc.fase === 'mao') {
      if (sc.audio && vozesNoWorklet(d)) {   // como darSomAMao: a cabeça das vozes entra MARGEM_S à frente, na linha da mão
        const t1 = agora() + S.MARGEM_S;
        d.noV.port.postMessage({ tipo: 'scratch', acao: 'pegar', posicao: naFaixa(d, S.alvoNaMao(sc, t1)), quadro: quadroDe(t1), taxa: S.velNaMao(sc, t1) });
        d.noV.port.postMessage({ tipo: 'scratch', acao: 'mao', alvo: sc.alvo, vel: sc.vel, em: sc.em });
      }
      return;
    }
    if (!d.e.tocando) return;
    if (d.tocaWorklet) { if (vozesNoWorklet(d)) d.noV.port.postMessage(mensagemEstado(d, false)); return; }   // mesma geração: o worklet segue a fórmula
    if (d.fonte && !d.vozes.some((v) => v.fonte)) {
      const t = Math.max(agendar(), d.e.inicioCtx);
      iniciarVozes(d, t, T.posicaoEm(d.e, t), false);
    }
  }
  // Larga as vozes: com rampa (volta à principal num cruzamento) ou na hora (troca de faixa, descarregar).
  function largarVozes(letra, d, comRampa) {
    const lista = d.vozes;
    if (!lista) return;
    const aoLargar = d.aoLargarVozes, no = d.noV;
    d.vozes = null; d.aoLargarVozes = null; d.noV = null; d.noVFonte = null;
    const t0 = comRampa ? agendar() : agora(), fim = comRampa ? t0 + RAMPA_VOZES_S : t0;
    if (d.saidaP) { if (comRampa) rampaAte(d.saidaP.gain, 0, 1, t0); else { if (typeof d.saidaP.gain.cancelScheduledValues === 'function') d.saidaP.gain.cancelScheduledValues(0); d.saidaP.gain.value = 1; } }
    for (const v of lista) {
      if (comRampa) rampaAte(v.entrada.gain, 1, 0, t0);
      const s = v.fonte, g = v.ganho; v.fonte = null; v.ganho = null;
      if (s) { s.onended = () => desligarFonte(s, g); try { if (fim > agora()) s.stop(fim); else s.stop(); } catch (_) { /* já parou */ } if (!(fim > agora())) desligarFonte(s, g); }
    }
    const desligar = () => {
      for (const v of lista) { try { v.entrada.disconnect(); } catch (_) { /* já desligado */ } v.rev = null; v.buffer = null; }
      if (no) { try { no.port.postMessage({ tipo: 'soltar' }); no.disconnect(); } catch (_) { /* já desligado */ } no.port.onmessage = null; }
    };
    if (fim > agora()) { const id = setTimeout(desligar, (fim - agora()) * 1000 + 50); if (id && typeof id.unref === 'function') id.unref(); }
    else desligar();
    if (aoLargar) aoLargar(letra);
  }
  function definirVozes(letra, lista, opcoes) {
    const d = deck(letra), ctx = cfg.ctx, o = opcoes || {};
    largarVozes(letra, d, true);
    if (!lista || !lista.length) return true;
    if (!ctx || !d.buffer || typeof ctx.createGain !== 'function') return false;
    assentarAgora(letra, d);   // no meio da rampa de soltura do scratch: ela acaba aqui (as vozes entram de um estado limpo)
    if (!d.saidaP || d.saidaPCtx !== ctx) {   // 1ª vez: a principal passa a sair por um ganho próprio (mesmo sinal, sem degrau)
      const s = ctx.createGain(); s.connect(cfg.destino(letra));
      d.saidaP = s; d.saidaPCtx = ctx;
      for (const n of [d.ganho || d.fonte, d.no]) if (n) { try { n.disconnect(); } catch (_) { /* já desligado */ } n.connect(s); }
    }
    const t0 = agendar();
    rampaAte(d.saidaP.gain, 1, 0, t0);
    d.vozes = lista.map((x) => {
      const e = ctx.createGain(); e.gain.value = 0; e.connect(x.destino); rampaAte(e.gain, 0, 1, t0);
      return { buffer: x.buffer, destino: x.destino, entrada: e, fonte: null, ganho: null, rev: null };
    });
    d.aoLargarVozes = typeof o.aoLargar === 'function' ? o.aoLargar : null;
    juntarVozes(letra, d);
    if (kv.estado !== 'pronto' && ctx.audioWorklet) {   // o key lock/scratch das vozes precisa do processador delas
      const lv = d.vozes;
      prepararVozes().then((ok) => { if (ok && d.vozes === lv) juntarVozes(letra, d); });
    }
    return true;
  }
  function infoVozes(letra) { const d = deck(letra); return { ativas: !!d.vozes, n: d.vozes ? d.vozes.length : 0, worklet: !!(d.noV && d.noVFonte) }; }
  function cancelarSoltar(d) { if (d.soltarDepois) { clearTimeout(d.soltarDepois); d.soltarDepois = null; } }
  // VB-38: larga a cópia só se o worklet seguir sem uso depois do prazo (ligar/desligar seguido não recopia).
  function agendarSoltar(d) {
    if (!d.noFonte || d.soltarDepois || querCopia(d)) return;
    const ms = typeof cfg.esperaSoltar === 'number' && cfg.esperaSoltar >= 0 ? cfg.esperaSoltar : 30000;
    if (ms === 0) { soltarFonteDoWorklet(d); return; }
    d.soltarDepois = setTimeout(() => { d.soltarDepois = null; if (!querCopia(d)) soltarFonteDoWorklet(d); }, ms);
    if (d.soltarDepois && typeof d.soltarDepois.unref === 'function') d.soltarDepois.unref();   // Node: não segura o processo
  }
  const travaTom = (d) => (TOM ? TOM.keyLockAtivo(d.keyLock, modoKeyLock, d.e.taxa) : d.keyLock);
  // `quadro`: o worklet aplica o estado no quadro do instante em que ele passa a valer (t0 de agendar(); se já
  // passou, na hora) — o key lock troca de taxa, busca e para no MESMO quadro que a fonte normal faria.
  // `naHora`: a soltura do scratch — a cabeça cruza com o key lock no fim da rampa, então ele tem de estar
  // tocando (pela fórmula, que já começa em fimEm) antes desse quadro.
  function mensagemEstado(d, naHora) {
    const e = d.e;
    return { tipo: 'estado', tocando: e.tocando, posicao: e.posicao, inicioCtx: e.inicioCtx, taxa: e.taxa,
      duracao: e.duracao, loop: e.loop, keyLock: travaTom(d), semitons: d.semitons, geracao: d.geracao,
      quadro: naHora ? 0 : quadroDe(e.tocando ? e.inicioCtx : ultimoAgendado) };
  }
  function enviarEstado(d, naHora) {
    d.geracao += 1;
    const m = mensagemEstado(d, naHora);
    d.no.port.postMessage(m);
    espelhar(d, m, true);   // as vozes (stems) no mesmo quadro
  }
  // Põe o backend certo para tocar o que d.e diz (ao mudar key lock/semitons e quando o worklet fica pronto).
  function reconciliar(letra) {
    const d = deck(letra);
    assentarAgora(letra, d);
    if (querWorklet(d)) garantirNoEFonte(letra, d);
    else if (!d.sc) agendarSoltar(d);
    if (d.sc || !d.e.tocando) return;   // com a mão no disco, a troca de backend vale ao soltar
    const deve = usaWorklet(d);
    if (deve !== d.tocaWorklet) {
      // o backend velho sai e o novo entra no MESMO t0, da posição que o transporte dá em t0 (antes: a fonte
      // nova partia de d.e.posicao — a posição do último rebase, que podia ser de segundos atrás)
      const t0 = agendar();
      pararFonte(d, t0); d.e = T.rebasear(d.e, t0); iniciarFonte(letra, d);
    }
    else if (deve) enviarEstado(d);   // key lock/semitons mudaram com o worklet tocando: só o tom muda
  }
  function infoKeyLock(letra) {
    const d = deck(letra);
    return { ligado: d.keyLock, semitons: d.semitons, ativo: d.tocaWorklet, efetivo: travaTom(d), modo: modoKeyLock, pronto: kl.estado === 'pronto',
      motivo: kl.estado === 'erro' || !cfg.ctx ? kl.motivo : '', latencia: kl.latencia };
  }
  function mudarBackend(letra) {
    const d = deck(letra);
    if (!querWorklet(d)) { reconciliar(letra); return Promise.resolve({ ok: true, motivo: '' }); }
    return prepararWorklet().then((ok) => {
      if (ok) reconciliar(letra);
      return { ok, motivo: ok ? '' : kl.motivo };
    });
  }
  function definirKeyLock(letra, ligado) {
    deck(letra).keyLock = !!ligado;
    return mudarBackend(letra);
  }
  function definirModoKeyLock(modo) {
    modoKeyLock = modo === 'scratch' ? 'scratch' : 'normal';
    for (const l of Object.keys(decks)) if (decks[l].tocaWorklet) enviarEstado(decks[l]);
  }
  function definirSemitons(letra, st) {
    deck(letra).semitons = typeof st === 'number' && Number.isFinite(st) ? Math.max(-12, Math.min(12, st)) : 0;
    return mudarBackend(letra);
  }

  function desligarFonte(s, g) {
    try { s.disconnect(); } catch (_) { /* já desligado */ }
    if (g) try { g.disconnect(); } catch (_) { /* já desligado */ }
  }
  // Para o que toca em `quando` (t0 de agendar(); sem ele, na hora). Futuro: a fonte segue até lá e o onended dela,
  // que já não é a d.fonte, a desliga; o worklet cala no quadro de `quando`.
  function pararFonte(d, quando) {
    const q = num(quando) ? quando : agora(), futuro = q > agora();
    if (d.tocaWorklet) {
      d.tocaWorklet = false; d.geracao += 1;
      const m = { tipo: 'parar', geracao: d.geracao, quadro: quadroDe(q) };
      if (d.no) d.no.port.postMessage(m);
      espelhar(d, m, false);
    }
    pararVozes(d, q, futuro, false);
    const s = d.fonte, g = d.ganho; d.fonte = null; d.ganho = null;
    if (!s) return;
    if (futuro) { try { s.stop(q); } catch (_) { /* já parou */ } return; }
    s.onended = null; try { s.stop(); } catch (_) { /* já parou */ } desligarFonte(s, g);
  }
  // VB-57: a fonte sai em `quando` (s do relógio) num cruzamento de CRUZAR_S (a cabeça do scratch entra
  // com o envelope complementar, no mesmo quadro). Sem rampa de ganho disponível, para seco em `quando`.
  const rampaDeGanho = (g) => !!g && !!g.gain && typeof g.gain.setValueAtTime === 'function' && typeof g.gain.linearRampToValueAtTime === 'function';
  function pararFonteEm(d, quando) {
    pararVozes(d, quando, true, true);
    const s = d.fonte, g = d.ganho; d.fonte = null; d.ganho = null;
    if (!s) return;
    s.onended = () => desligarFonte(s, g);
    let fim = quando;
    if (rampaDeGanho(g)) { g.gain.setValueAtTime(1, quando); g.gain.linearRampToValueAtTime(0, quando + S.CRUZAR_S); fim = quando + S.CRUZAR_S; }
    try { s.stop(fim); } catch (_) { /* já parou */ }
  }
  function aplicarLoopNaFonte(s, loop) {
    s.loop = !!loop;
    if (loop) { s.loopStart = loop.inicio; s.loopEnd = loop.fim; }
  }
  // Reverso na Web Audio não sai de playbackRate negativo: toca-se uma cópia do buffer com as amostras de
  // trás para frente. A posição t da faixa é a posição (duração − t) da cópia. Memória: uma cópia por deck.
  function bufferInvertido(d) {
    if (d.rev) return d.rev;
    const ctx = cfg.ctx, b = d.buffer;
    if (!ctx || !b || typeof ctx.createBuffer !== 'function' || typeof b.getChannelData !== 'function') return null;
    const r = ctx.createBuffer(b.numberOfChannels, b.length, b.sampleRate);
    for (let c = 0; c < b.numberOfChannels; c++) {
      const de = b.getChannelData(c), para = r.getChannelData(c), n = de.length;
      for (let i = 0; i < n; i++) para[i] = de[n - 1 - i];
    }
    d.rev = r;
    return r;
  }
  // Começa a tocar o que d.e diz, NO instante d.e.inicioCtx (o t0 agendado, ou o fim da rampa do scratch, VB-57),
  // da posição d.e.posicao; `cruzar`: entra num cruzamento de CRUZAR_S. Estado com inicioCtx que já passou
  // (guardado há tempo) é rebaseado num t0 novo antes: a fonte nunca parte de uma posição velha.
  function iniciarFonte(letra, d, cruzar) {
    const ctx = cfg.ctx;
    if (!ctx || !d.buffer) return;
    if (d.e.tocando && !(d.e.inicioCtx >= agora())) d.e = T.rebasear(d.e, agendar());
    const quando = d.e.inicioCtx;
    if (querWorklet(d) && d.e.sentido !== -1) {
      if (!garantirNoEFonte(letra, d)) prepararWorklet().then((ok) => { if (ok) reconciliar(letra); });   // 1ª vez: toca normal até ficar pronto
      if (usaWorklet(d)) { d.tocaWorklet = true; enviarEstado(d, cruzar); return; }   // o worklet segue o relógio (inicioCtx) sozinho
    }
    const re = d.e.sentido === -1, buf = re ? bufferInvertido(d) : d.buffer;
    if (!buf) return;
    const { src, g } = novaFonte(d, buf, re, saidaDe(letra, d));
    src.onended = () => {
      if (d.fonte !== src) { desligarFonte(src, g); return; }
      d.fonte = null; d.ganho = null; d.e = T.terminou(d.e);
      pararVozes(d, agora(), false, false);   // a principal é o relógio: o fim dela é o das vozes
      if (cfg.aoTerminar) cfg.aoTerminar(letra);
    };
    d.fonte = src; d.ganho = g;
    const agendado = quando > agora();
    if (agendado && cruzar && rampaDeGanho(g)) { g.gain.setValueAtTime(0, quando); g.gain.linearRampToValueAtTime(1, quando + S.CRUZAR_S); }
    src.start(agendado ? quando : 0, re ? Math.max(0, d.e.duracao - d.e.posicao) : d.e.posicao);
    iniciarVozes(d, quando, d.e.posicao, cruzar);
  }
  // Uma AudioBufferSourceNode (com o GainNode do cruzamento) para `buf`, na taxa e no loop do deck — a da principal
  // e a de cada voz saem daqui, então não há como divergirem.
  function novaFonte(d, buf, re, destino) {
    const ctx = cfg.ctx, src = ctx.createBufferSource();
    src.buffer = buf; src.playbackRate.value = d.e.taxa;
    if (!re) aplicarLoopNaFonte(src, d.e.loop);
    const g = typeof ctx.createGain === 'function' ? ctx.createGain() : null;
    if (g) { src.connect(g); g.connect(destino); } else src.connect(destino);
    return { src, g };
  }
  // d.e acabou de mudar em t0 (busca, loop): a fonte velha sai em t0 e a nova entra em t0.
  function reiniciarSeTocando(letra, d, t0) {
    if (!d.e.tocando) return;
    if (d.tocaWorklet && usaWorklet(d)) { enviarEstado(d); return; }   // o worklet emenda a busca sozinho (um grão)
    pararFonte(d, t0); iniciarFonte(letra, d);
  }


  // ---------------- scratch e jog (VB-57) ----------------
  // d.sc = null | {fase:'mao', retomar, audio, real, alvo, vel, em} | {fase:'soltando', retomar, audio, sol, fimEm}
  // Na mão, d.e fica PARADO (a posição é a da mão, motor/scratch.js alvoNaMao). Ao soltar, d.e já recebe o
  // estado final (tocando ou não, de posicaoFinal em fimEm) e, até fimEm, a posição é a da rampa (alvoNaSoltura).
  const ks = { estado: 'nada', promessa: null, ctx: null };   // ../motor/scratch.js no worklet: nada|carregando|pronto|erro
  function prepararScratch() {
    const ctx = cfg.ctx;
    if (ks.ctx !== ctx) { ks.estado = 'nada'; ks.promessa = null; ks.ctx = ctx; }
    if (ks.promessa) return ks.promessa;
    if (!ctx || !S) return Promise.resolve(false);
    ks.estado = 'carregando';
    ks.promessa = prepararWorklet().then((ok) => {
      if (!ok) { ks.estado = 'erro'; return false; }
      return ctx.audioWorklet.addModule(cfg.worklets.scratch)
        .then(() => { ks.estado = 'pronto'; return true; }, () => { ks.estado = 'erro'; return false; });
    });
    return ks.promessa;
  }
  const quadroDe = (t) => Math.round(t * (cfg.ctx && cfg.ctx.sampleRate > 0 ? cfg.ctx.sampleRate : 44100));
  const naFaixa = (d, p) => { const q = p > 0 ? p : 0; return d.e.duracao > 0 && q > d.e.duracao ? d.e.duracao : q; };
  const velDoTransporte = (e) => (e.tocando ? (e.sentido === -1 ? -e.taxa : e.taxa) : 0);
  function falarComCabeca(d, audio, m) { if (audio && d.no) { d.no.port.postMessage(m); espelhar(d, m, m.acao === 'pegar'); } }
  function cancelarAssentar(d) { if (d.assentarDepois) { clearTimeout(d.assentarDepois); d.assentarDepois = null; } }
  // A rampa de soltura acabou: o backend normal já assumiu (agendado) e o estado é o de d.e.
  function assentar(letra, d) {
    if (!d.sc || d.sc.fase !== 'soltando' || agora() < d.sc.fimEm) return;
    d.scFim = { sol: d.sc.sol, fimEm: d.sc.fimEm };   // a tela (instante ouvido, atrás de agora) ainda lê a rampa
    d.sc = null; cancelarAssentar(d);
    if (!querWorklet(d)) agendarSoltar(d);
  }
  // Alguém mexe no transporte no meio da rampa de soltura: a rampa acaba aqui, de onde ela estava.
  function assentarAgora(letra, d) {
    assentar(letra, d);
    const sc = d.sc;
    if (!sc || sc.fase !== 'soltando') return;
    const t0 = agendar(), p = naFaixa(d, S.alvoNaSoltura(sc.sol, t0));
    pararFonte(d, t0);   // a fonte agendada para o fim da rampa (ou o 'estado' do key lock) não chega a soar
    falarComCabeca(d, sc.audio, { tipo: 'scratch', acao: 'encerrar', quadro: quadroDe(t0) });
    d.scFim = { sol: sc.sol, fimEm: t0 };
    d.sc = null; cancelarAssentar(d);
    d.e = { ...d.e, posicao: p, inicioCtx: t0, tocando: sc.retomar && !(d.e.duracao > 0 && p >= d.e.duracao), sentido: 1, retomar: false };
    if (d.e.tocando) iniciarFonte(letra, d);
    if (!querWorklet(d)) agendarSoltar(d);
  }
  // Troca de faixa, CUP: larga o disco sem rampa (a cabeça desce no cruzamento curto).
  function largarScratch(d) {
    const sc = d.sc;
    if (!sc) return;
    const ag = agora();
    if (sc.fase === 'mao') d.e = { ...d.e, posicao: naFaixa(d, S.alvoNaMao(sc, ag)), inicioCtx: ag };
    else pararFonte(d);
    falarComCabeca(d, sc.audio, { tipo: 'scratch', acao: 'encerrar', quadro: quadroDe(ag) });
    d.sc = null; cancelarAssentar(d);
  }
  function scratchPegar(letra) {
    const d = deck(letra);
    if (!d.buffer || !S) return { ok: false, audio: false };
    assentar(letra, d);
    const ag = agora();
    if (d.sc && d.sc.fase === 'mao') return { ok: true, audio: d.sc.audio };
    if (d.sc) {   // pegou de novo antes de o backend normal assumir: a cabeça segue contínua, de onde a rampa está
      const sc = d.sc, p = naFaixa(d, S.alvoNaSoltura(sc.sol, ag)), v = S.velNaSoltura(sc.sol, ag);
      pararFonte(d); cancelarAssentar(d);
      d.e = { ...d.e, tocando: false, posicao: p, inicioCtx: ag, sentido: 1, retomar: false };
      d.sc = { fase: 'mao', retomar: sc.retomar, audio: sc.audio, real: p, alvo: p, vel: 0, em: ag };
      falarComCabeca(d, sc.audio, { tipo: 'scratch', acao: 'pegar', posicao: p, quadro: quadroDe(ag), taxa: v });
      return { ok: true, audio: sc.audio };
    }
    const audio = ks.estado === 'pronto' && garantirNoEFonte(letra, d);
    if (!audio) prepararScratch().then((ok) => { if (ok) darSomAMao(letra, d); });   // VB-58: a mão ganha o som no meio do gesto
    const t1 = ag + (audio ? S.MARGEM_S : 0), e0 = d.e;
    const p1 = T.posicaoEm(e0, t1), v1 = velDoTransporte(e0);
    const retomar = e0.sentido === -1 ? !!e0.retomar : !!e0.tocando;
    if (audio) {
      if (d.fonte) pararFonteEm(d, t1);
      if (d.tocaWorklet) { d.tocaWorklet = false; d.geracao += 1; }   // o processador cruza e para o key lock
    } else pararFonte(d);
    d.e = { ...e0, tocando: false, posicao: p1, inicioCtx: t1, sentido: 1, retomar: false, cup: false };
    d.sc = { fase: 'mao', retomar, audio, real: p1, alvo: p1, vel: 0, em: t1 };   // a mão segura o disco ali
    falarComCabeca(d, audio, { tipo: 'scratch', acao: 'pegar', posicao: p1, quadro: quadroDe(t1), taxa: v1 });
    return { ok: true, audio };
  }
  // VB-58: pegou o disco antes de o worklet ficar pronto (busca muda). Ficou pronto com a mão ainda no disco: a
  // cabeça entra MARGEM_S à frente, na linha da mão, e o gesto segue com som (a fonte já tinha parado seco).
  function darSomAMao(letra, d) {
    const sc = d.sc;
    if (!sc || sc.fase !== 'mao' || sc.audio || !garantirNoEFonte(letra, d)) return false;
    const t1 = agora() + S.MARGEM_S;
    sc.audio = true;
    falarComCabeca(d, true, { tipo: 'scratch', acao: 'pegar', posicao: naFaixa(d, S.alvoNaMao(sc, t1)), quadro: quadroDe(t1), taxa: S.velNaMao(sc, t1) });
    falarComCabeca(d, true, { tipo: 'scratch', acao: 'mao', alvo: sc.alvo, vel: sc.vel, em: sc.em });
    return true;
  }
  function scratchMover(letra, deltaS, vel) {
    const d = deck(letra), sc = d.sc;
    if (!sc || sc.fase !== 'mao') return;
    const ag = agora();
    // `real` = soma exata dos deltas (a mão de verdade); a linha que o worklet segue emenda nela sem salto
    let real = sc.real + (typeof deltaS === 'number' && Number.isFinite(deltaS) ? deltaS : 0);
    let v = typeof vel === 'number' && Number.isFinite(vel) ? vel : 0;
    if (real <= 0) { real = 0; if (v < 0) v = 0; }
    if (d.e.duracao > 0 && real >= d.e.duracao) { real = d.e.duracao; if (v > 0) v = 0; }
    const linha = S.corrigirMao(sc, real, v, ag);
    sc.real = real; sc.alvo = linha.alvo; sc.vel = linha.vel; sc.em = ag;
    falarComCabeca(d, sc.audio, { tipo: 'scratch', acao: 'mao', alvo: linha.alvo, vel: linha.vel, em: ag });
  }
  function scratchSoltar(letra) {
    const d = deck(letra), sc = d.sc;
    if (!sc || sc.fase !== 'mao') return;
    const ag = agora();
    const plano = S.planoDeSoltura(sc, ag, sc.retomar ? d.e.taxa : 0, d.e.duracao, sc.audio ? S.RAMPA_SOLTAR_S : 0);
    d.e = { ...d.e, posicao: plano.posicaoFinal, inicioCtx: plano.fimEm, tocando: plano.tocando, sentido: 1, retomar: false };
    if (!sc.audio) {   // sem a cabeça (worklet não pronto): busca muda, retoma na hora
      d.sc = null;
      if (d.e.tocando) iniciarFonte(letra, d);
      if (!querWorklet(d)) agendarSoltar(d);
      return;
    }
    d.sc = { fase: 'soltando', retomar: sc.retomar, audio: true, sol: plano.sol, fimEm: plano.fimEm };
    falarComCabeca(d, true, { tipo: 'scratch', acao: 'soltar', ...plano.sol, quadroFim: quadroDe(plano.fimEm) });
    if (d.e.tocando) iniciarFonte(letra, d, true);   // agendado no fim da rampa (d.e.inicioCtx = fimEm), com cruzamento
    cancelarAssentar(d);
    d.assentarDepois = setTimeout(() => { d.assentarDepois = null; assentar(letra, d); }, Math.max(0, (plano.fimEm - ag) * 1000) + 30);
    if (d.assentarDepois && typeof d.assentarDepois.unref === 'function') d.assentarDepois.unref();
  }
  function infoScratch(letra) {
    const d = deck(letra);
    assentar(letra, d);
    return { ativo: !!d.sc, fase: d.sc ? d.sc.fase : null, audio: !!(d.sc && d.sc.audio), pronto: ks.estado === 'pronto' };
  }

  // ---------------- pré-carga da cópia (VB-58) ----------------
  // d.pre = {buffer, canais: [Float32Array…], i: amostras já copiadas, tarefa, cancelar}. Uma por deck; a troca de
  // faixa a descarta (o que foi copiado vira lixo, nunca vai ao worklet).
  const relogioMs = () => (raiz.performance && typeof raiz.performance.now === 'function' ? raiz.performance.now() : Date.now());
  // Copia de pre.i em diante até acabar ou passar `limiteMs` (relogioMs). Infinity = até o fim. → true se acabou.
  function copiarFatia(pre, limiteMs) {
    const b = pre.buffer, n = b.length, passo = Math.max(1024, (cfg.preCarga && cfg.preCarga.fatia) | 0 || 1 << 17);
    while (pre.i < n) {
      const fim = Math.min(n, pre.i + passo);
      for (let c = 0; c < pre.canais.length; c++) pre.canais[c].set(b.getChannelData(c).subarray(pre.i, fim), pre.i);
      pre.i = fim;
      if (limiteMs !== Infinity && relogioMs() >= limiteMs) break;
    }
    return pre.i >= n;
  }
  // Agenda fn(prazo) em tempo ocioso: requestIdleCallback na página; setTimeout(0) onde não há (Node, Safari).
  function quandoOcioso(fn) {
    if (typeof raiz.requestIdleCallback === 'function') {
      const id = raiz.requestIdleCallback(fn, { timeout: 500 });
      return () => { if (typeof raiz.cancelIdleCallback === 'function') raiz.cancelIdleCallback(id); };
    }
    const id = setTimeout(() => fn({ didTimeout: false, timeRemaining: () => 50 }), 0);
    if (id && typeof id.unref === 'function') id.unref();
    return () => clearTimeout(id);
  }
  function cancelarPre(d) {
    const pre = d.pre;
    if (!pre) return;
    d.pre = null;
    if (pre.cancelar) { pre.cancelar(); pre.cancelar = null; }
    if (pre.resolver) { const r = pre.resolver; pre.resolver = null; r(false); }
  }
  function preCarregar(letra) {
    const d = deck(letra), b = d.buffer;
    if (!b || !cfg.ctx || !S) return Promise.resolve(false);
    const pc = cfg.preCarga || {};
    const copiar = !(typeof pc.maxS === 'number' && b.duration > pc.maxS);
    if (copiar) d.manter = true;   // a cópia fica enquanto a faixa estiver no deck
    if (d.noFonte === b) return Promise.resolve(true);
    if (d.pre && d.pre.buffer === b) return d.pre.promessa;
    return prepararScratch().then((ok) => {
      if (!ok || !copiar || d.buffer !== b) return false;
      if (d.noFonte === b) return true;                       // alguém (key lock, a 1ª pegada) já levou a cópia
      if (d.pre && d.pre.buffer === b) return d.pre.promessa;
      cancelarPre(d);
      const pre = { buffer: b, canais: [], i: 0, cancelar: null, resolver: null, promessa: null };
      for (let c = 0; c < b.numberOfChannels; c++) pre.canais.push(new Float32Array(b.length));
      d.pre = pre;
      pre.promessa = new Promise((resolver) => {
        pre.resolver = resolver;
        const passo = (prazo) => {
          pre.cancelar = null;
          if (d.pre !== pre) return;
          const restante = prazo && typeof prazo.timeRemaining === 'function' ? prazo.timeRemaining() : 0;
          const orc = Math.min(typeof pc.orcamentoMs === 'number' && pc.orcamentoMs >= 0 ? pc.orcamentoMs : 6, restante > 1 ? restante : 1);   // 0 = uma fatia
          if (!copiarFatia(pre, relogioMs() + orc)) { pre.cancelar = quandoOcioso(passo); return; }
          pre.resolver = null;
          const ok = d.buffer === b && garantirNoEFonte(letra, d) && d.noFonte === b;   // consome d.pre e transfere
          if (d.pre === pre) cancelarPre(d);   // não deu para entregar (contexto trocou): não segura a cópia na página
          resolver(ok);
        };
        pre.cancelar = quandoOcioso(passo);
      });
      return pre.promessa;
    });
  }

  function carregar(letra, buffer) {
    const d = deck(letra);
    cancelarPre(d); d.manter = false;
    largarScratch(d);
    largarVozes(letra, d, false);   // os stems eram da faixa velha
    pararFonte(d);
    if (d.noFonte) soltarFonteDoWorklet(d);
    d.buffer = buffer || null; d.rev = null; d.scFim = null;
    const taxa = d.e.taxa;
    d.trilha.length = 0;
    d.e = { ...T.estadoInicial(buffer ? buffer.duration : 0), taxa };
    if (d.buffer && querWorklet(d)) garantirNoEFonte(letra, d);   // key lock atravessa a troca de faixa
  }
  function descarregar(letra) {
    const d = deck(letra);
    largarScratch(d);
    cancelarPre(d); d.manter = false;
    largarVozes(letra, d, false);
    pararFonte(d); soltarFonteDoWorklet(d); d.buffer = null; d.rev = null; d.scFim = null; d.trilha.length = 0; d.e = T.estadoInicial(0);
  }
  function tocar(letra) {
    const d = deck(letra);
    if (d.sc && d.sc.fase === 'mao') { d.sc.retomar = true; return; }   // com a mão no disco: toca ao soltar
    assentarAgora(letra, d);
    if (!d.buffer || d.e.tocando) return;
    d.e = T.tocar(d.e, agendar());
    if (d.e.tocando) iniciarFonte(letra, d);
  }
  function pausar(letra) {
    const d = deck(letra);
    if (d.sc && d.sc.fase === 'mao') { d.sc.retomar = false; return; }
    assentarAgora(letra, d);
    if (!d.e.tocando) return;
    const t0 = agendar();
    pararFonte(d, t0);
    d.e = T.pausar(d.e, t0);   // o som para em t0, na posição que o transporte dá em t0
  }
  function buscar(letra, t, opcoes) {
    const d = deck(letra);
    if (!d.buffer) return;
    const o = opcoes || {}, ag = agora();
    if (d.sc && d.sc.fase === 'mao') {   // a mão salta junto (hotcue, beatjump com o disco seguro)
      const alvo = T.buscar({ ...d.e, tocando: false }, ag, t, o).posicao, sc = d.sc;
      sc.real = alvo; sc.alvo = alvo; sc.vel = 0; sc.em = ag;
      falarComCabeca(d, sc.audio, { tipo: 'scratch', acao: 'saltar', alvo, em: ag });
      return;
    }
    assentarAgora(letra, d);
    const t0 = agendar();
    const alvo = num(o.em) && d.e.tocando ? t + (t0 - o.em) * d.e.taxa : t;
    d.e = T.buscar(d.e, t0, alvo, o);
    reiniciarSeTocando(letra, d, t0);
  }
  function definirTaxa(letra, taxa) {
    const d = deck(letra);
    if (d.sc && d.sc.fase === 'mao') { d.e = T.mudarTaxa(d.e, agora(), taxa); return; }   // vale ao soltar
    assentarAgora(letra, d);
    const t0 = agendar();
    d.e = T.mudarTaxa(d.e, t0, taxa);   // a posição até t0 segue a taxa velha; dali, a nova — o mesmo degrau da fonte
    if (d.fonte) {
      taxaEm(d.fonte.playbackRate, d.e.taxa, t0);
      if (d.vozes) for (const v of d.vozes) if (v.fonte) taxaEm(v.fonte.playbackRate, d.e.taxa, t0);   // o mesmo degrau
    } else if (d.tocaWorklet) enviarEstado(d);   // com key lock o tempo muda e o tom não
  }
  // Loop novo com a cabeça antes do fim dele: o próprio nó dobra no loopEnd, sem recomeçar (sem emenda).
  // Com a cabeça já depois do fim: o transporte leva a cabeça ao início do loop e o nó recomeça de lá.
  function definirLoop(letra, loop) {
    const d = deck(letra);
    if (d.sc && d.sc.fase === 'mao') { d.e = { ...d.e, loop: T.normalizarLoop(loop, d.e.duracao) }; return; }   // vale ao soltar
    assentarAgora(letra, d);
    const t0 = agendar(), antes = T.posicaoEm(d.e, t0);
    d.e = T.definirLoop(d.e, t0, loop);
    if (d.tocaWorklet) { enviarEstado(d); return; }   // o worklet dobra no loop pela mesma conta do transporte
    if (!d.fonte || d.e.sentido === -1) return;   // em ré o loop só vale ao voltar
    if (d.e.loop && d.e.posicao !== antes) reiniciarSeTocando(letra, d, t0);
    else {
      aplicarLoopNaFonte(d.fonte, d.e.loop);
      if (d.vozes) for (const v of d.vozes) if (v.fonte) aplicarLoopNaFonte(v.fonte, d.e.loop);
    }
  }
  function apertarCup(letra, cue, opcoes) {
    const d = deck(letra);
    if (!d.buffer) return;
    largarScratch(d);
    const t0 = agendar();
    pararFonte(d, t0);
    d.e = T.apertarCup(d.e, t0, cue, opcoes);
  }
  function soltarCup(letra) {
    const d = deck(letra);
    if (!d.buffer || !d.e.cup) return;
    d.e = T.soltarCup(d.e, agendar());
    if (d.e.tocando) iniciarFonte(letra, d);
  }
  function definirReverso(letra, ligado) {
    const d = deck(letra);
    if (!d.buffer || d.sc) return;   // com a mão no disco (ou na rampa de soltura) o reverso não vale
    const t0 = agendar(), novo = ligado ? T.entrarReverso(d.e, t0) : T.sairReverso(d.e, t0);
    if (novo === d.e) return;
    if (ligado && !bufferInvertido(d)) return;   // sem como inverter (sem contexto): fica como estava
    pararFonte(d, t0);
    d.e = novo;
    if (d.e.tocando) iniciarFonte(letra, d);
  }
  // Com a mão no disco, a posição é a da mão; na rampa de soltura, a da rampa (motor/scratch.js).
  function posicaoScratch(d, t) {
    const sc = d.sc;
    if (!sc) return null;
    if (sc.fase === 'mao') return naFaixa(d, S.alvoNaMao(sc, t));
    return t < sc.fimEm ? naFaixa(d, S.alvoNaSoltura(sc.sol, t)) : null;
  }
  // Sem `em`: no instante dos comandos (relogio()) — o alvo que alguém calcular daqui vale no mesmo t0.
  function posicao(letra) {
    const d = deck(letra), t = agendar();
    assentar(letra, d);
    const p = posicaoScratch(d, t);
    return p === null ? T.posicaoEm(d.e, t) : p;
  }
  // O que soa agora (a tela): a trilha no instante ouvido; com a mão no disco ou na rampa de soltura, a deles.
  function posicaoNaTela(letra) {
    const d = deck(letra), t = instanteOuvido();
    assentar(letra, d);
    const p = posicaoScratch(d, t);
    if (p !== null) return p;
    if (!d.e.tocando) return d.e.posicao;   // parado: onde parou (ou para onde a busca levou), sem esperar a latência
    if (d.scFim && t < d.scFim.fimEm) return naFaixa(d, S.alvoNaSoltura(d.scFim.sol, t));
    return posicaoNoInstante(d, t);
  }
  function trilha(letra) { return deck(letra).trilha.map((x) => ({ desde: x.desde, e: { ...x.e } })); }
  function estado(letra, em) {
    const d = deck(letra), t = num(em) ? em : agendar();
    assentar(letra, d);
    const p = posicaoScratch(d, t);
    if (p !== null) return { ...d.e, tocando: d.sc.fase === 'mao' ? false : d.e.tocando, posicao: p, inicioCtx: t, scratch: true };
    return { ...T.rebasear(d.e, t) };
  }
  function relogio() { return agendar(); }
  function temBuffer(letra) { return !!deck(letra).buffer; }
  function bufferDe(letra) { return deck(letra).buffer; }   // VbMxStems confere duração e sampleRate dos stems contra ela

  return { configurar, carregar, descarregar, tocar, pausar, buscar, definirTaxa, definirLoop, definirReverso, apertarCup, soltarCup, posicao, posicaoNaTela, trilha, estado, relogio, temBuffer,
    definirKeyLock, definirSemitons, definirModoKeyLock, keyLock: infoKeyLock,
    prepararScratch, scratchPegar, scratchMover, scratchSoltar, scratch: infoScratch, preCarregar,
    definirVozes, vozes: infoVozes, prepararVozes, bufferDe };
});
