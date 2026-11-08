// ===================== VbMxStems: os 4 stems de cada deck (2026-11-07) =====================
// O deck ganha vocals, drums, bass e instrumental (AudioBuffers já decodificados, mesma duração e sampleRate da
// faixa). Cada stem tem mudo, solo, volume, EQ de 3 bandas, filtro e efeito próprios; o TRANSPORTE continua sendo
// da faixa principal (play, pausa, sync, cue, hotcues, loop, pitch, key lock/semitons, scratch — todos pelo
// VbMxTocador, que leva as vozes junto: js/tocador.js definirVozes). Com stems ativos a principal segue tocando como
// relógio, muda; a soma dos stems entra no destino(letra) no lugar dela, num cruzamento de 10 ms.
// A conta pura (travas, mudo/solo, filtro, fx, validação) é motor/stems.js (VbMxStemsMotor). Contrato: docs/contratos.md.
//
//   configurar({ctx, destino(letra) → AudioNode, tocador})   audio.js/deck.js, no 1º gesto (tocador: VbMxTocador)
//   carregar(letra, {vocals, drums, bass, instrumental}) → {ok, motivo}   larga os stems anteriores do deck
//   descarregar(letra)                volta à principal num cruzamento e desliga tudo depois dele
//   ligar(letra, bool) → bool        false: a principal volta a soar e as vozes saem (estados guardados); true: o inverso
//   ativo(letra) → bool
//   definir(letra, nome, parcial)     parcial ⊂ {mudo, solo, volume 0…1,5, eq {hi, mid, low} dB −26…+6, filtro −1…1,
//                                     fx {id, param 0…1, mix 0…1} | null}
//   estado(letra, nome) → cópia + pico (0…1, do último bloco que o analisador viu)
//   aoMudar(fn(letra, nome|null)) → cancelar()
// Cadeia de cada stem: entrada → hi → mid → low (biquads) → filtro (seco | lp → hp) → efeito (seco | unidade
// VbMxFxCanal) → nível (mudo/solo/volume) → soma do deck → destino(letra); o analisador do pico fica no nível.
// Memória: os 4 AudioBuffers estéreo ficam aqui (≈ 4× a faixa) e, com key lock/scratch, uma cópia deles no worklet
// das vozes; descarregar ou trocar de faixa larga tudo.
(function (raiz, fabrica) {
  const api = fabrica(raiz);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.VbMxStems = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (raiz) {
  'use strict';
  const SM = raiz.VbMxStemsMotor || (typeof require === 'function' ? require('../../motor/stems.js') : null);
  const NOMES = SM.NOMES, SUAVE = 0.01;
  let cfg = { ctx: null, destino: null, tocador: null };
  const decks = {};             // letra → {cadeias: {nome: cadeia}, estados: {nome: est}, soma}
  const ouvintes = new Set();

  function configurar(c) { cfg = { ...cfg, ...c }; }
  const tocador = () => cfg.tocador || raiz.VbMxTocador || null;
  const agora = () => (cfg.ctx ? cfg.ctx.currentTime : 0);
  function avisar(letra, nome) { for (const fn of ouvintes) { try { fn(letra, nome); } catch (_) { /* a UI não derruba o áudio */ } } }
  // Todo valor que chega a um AudioParam é finito: no Chrome, `.value = NaN/undefined` ou um agendamento não finito é
  // TypeError na hora e derruba a carga inteira dos stems (bug de 2026-11-07: Q indefinido nas bandas shelf).
  const finito = (v, senao) => (typeof v === 'number' && Number.isFinite(v) ? v : senao);
  function mudar(param, v, senao) {
    const x = finito(v, finito(senao, param.value));
    if (!Number.isFinite(x)) return;
    if (typeof param.setTargetAtTime === 'function') param.setTargetAtTime(x, agora(), SUAVE);
    else param.value = x;
  }
  function desligar(nos) { for (const n of nos) if (n) try { n.disconnect(); } catch (_) { /* já desligado */ } }

  function ganho(v) { const g = cfg.ctx.createGain(); g.gain.value = finito(v, 1); return g; }
  function biquad(tipo, freq, q) {   // shelves não têm Q (VbMxReproducao.BANDAS): fica o padrão do nó
    const f = cfg.ctx.createBiquadFilter();
    f.type = tipo; f.frequency.value = finito(freq, 1000); if (finito(q, null) !== null) f.Q.value = q; f.gain.value = 0;
    return f;
  }
  function montarCadeia(soma) {
    const ctx = cfg.ctx, B = SM.BANDAS;
    const c = { entrada: ganho(1), bandas: {}, seco: ganho(1), molhado: ganho(0), juntaFiltro: ganho(1),
      fxSeco: ganho(1), fxPorta: ganho(0), juntaFx: ganho(1), nivel: ganho(1), fxc: null, analisador: null, amostras: null };
    let atras = c.entrada;
    for (const b of ['hi', 'mid', 'low']) { const f = biquad(B[b].tipo, B[b].freq, B[b].q); c.bandas[b] = f; atras.connect(f); atras = f; }
    c.lp = biquad('lowpass', 20000, 0.7071); c.hp = biquad('highpass', 20, 0.7071);
    atras.connect(c.seco); atras.connect(c.lp); c.lp.connect(c.hp); c.hp.connect(c.molhado);
    c.seco.connect(c.juntaFiltro); c.molhado.connect(c.juntaFiltro);
    c.juntaFiltro.connect(c.fxSeco); c.fxSeco.connect(c.juntaFx);
    c.fxPorta.connect(c.juntaFx);
    c.juntaFx.connect(c.nivel); c.nivel.connect(soma);
    if (typeof ctx.createAnalyser === 'function') {
      c.analisador = ctx.createAnalyser(); c.analisador.fftSize = 512;
      c.amostras = new Float32Array(c.analisador.fftSize);
      c.nivel.connect(c.analisador);
    }
    return c;
  }
  // A unidade de efeito nasce na 1ª vez que o stem pede um efeito (CPU e nós só para quem usa).
  function garantirFx(c) {
    if (c.fxc || !raiz.VbMxFxCanal) return c.fxc;
    c.fxc = raiz.VbMxFxCanal.criar(cfg.ctx);
    c.juntaFiltro.connect(c.fxc.entrada); c.fxc.saida.connect(c.fxPorta);
    return c.fxc;
  }
  function aplicar(letra) {
    const dk = decks[letra];
    if (!dk) return;
    const g = SM.ganhos(dk.estados), bpm = raiz.VbMxFxCanal && typeof raiz.VbMxFxCanal.lerBpm === 'function' ? raiz.VbMxFxCanal.lerBpm() : NaN;
    for (const nome of NOMES) {
      const c = dk.cadeias[nome], e = dk.estados[nome];
      mudar(c.nivel.gain, g[nome]);
      for (const b of ['hi', 'mid', 'low']) mudar(c.bandas[b].gain, e.eq[b]);
      const f = SM.filtro(e.filtro), nyq = cfg.ctx.sampleRate ? cfg.ctx.sampleRate / 2 - 100 : f.lp;
      mudar(c.lp.frequency, Math.min(f.lp, nyq), 20000); mudar(c.hp.frequency, f.hp, 20);
      mudar(c.lp.Q, f.q, 0.7071); mudar(c.hp.Q, f.q, 0.7071);
      mudar(c.seco.gain, f.ativo ? 0 : 1); mudar(c.molhado.gain, f.ativo ? 1 : 0);
      const x = SM.fx(e.fx, bpm), unidade = e.fx ? garantirFx(c) : c.fxc;
      if (unidade) unidade.aplicar({ id: x.id, params: x.params });
      const comFx = !!e.fx && !!unidade;
      mudar(c.fxSeco.gain, comFx ? 1 - x.mix : 1); mudar(c.fxPorta.gain, comFx ? x.mix : 0);
    }
  }
  function desmontar(dk) {
    for (const nome of NOMES) {
      const c = dk.cadeias[nome];
      if (c.fxc) c.fxc.descartar();
      desligar([c.entrada, c.bandas.hi, c.bandas.mid, c.bandas.low, c.seco, c.molhado, c.lp, c.hp, c.juntaFiltro,
        c.fxSeco, c.fxPorta, c.juntaFx, c.nivel, c.analisador]);
    }
    desligar([dk.soma]);
  }
  // O deck largou os stems (troca de faixa/descarregar no tocador, ou descarregar aqui): os nós saem depois do cruzamento.
  function largar(letra, depoisMs) {
    const dk = decks[letra];
    if (!dk) return;
    delete decks[letra];
    if (depoisMs > 0) { const id = setTimeout(() => desmontar(dk), depoisMs); if (id && typeof id.unref === 'function') id.unref(); }
    else desmontar(dk);
    avisar(letra, null);
  }

  // As vozes entram (carregar ou ligar(true)); o aoLargar só desmonta quando o deck LARGOU de verdade, não no ligar(false).
  function entrarVozes(letra, dk) {
    return tocador().definirVozes(letra, NOMES.map((nome) => ({ buffer: dk.stems[nome], destino: dk.cadeias[nome].entrada })),
      { aoLargar: (l) => { if (decks[l] === dk && !dk.desligado) largar(l, 0); } });
  }
  function carregar(letra, stems) {
    const ctx = cfg.ctx, toc = tocador();
    if (!ctx || !toc || typeof toc.definirVozes !== 'function') return { ok: false, motivo: 'sem áudio ainda (configurar no 1º gesto)' };
    const v = SM.validar(toc.bufferDe(letra), stems);
    if (!v.ok) return v;
    if (decks[letra]) descarregar(letra);
    const soma = ganho(1);
    soma.connect(cfg.destino(letra));
    const dk = { cadeias: {}, estados: {}, soma };
    for (const nome of NOMES) { dk.cadeias[nome] = montarCadeia(soma); dk.estados[nome] = SM.padrao(); }
    decks[letra] = dk;
    aplicar(letra);
    dk.stems = stems; dk.principal = toc.bufferDe(letra); dk.desligado = false;
    const ok = entrarVozes(letra, dk);
    if (!ok) { largar(letra, 0); return { ok: false, motivo: 'o tocador não aceitou as vozes' }; }
    avisar(letra, null);
    return { ok: true, motivo: '' };
  }
  function descarregar(letra) {
    const toc = tocador();
    if (!decks[letra]) return;
    largar(letra, 80);   // sai do mapa antes do definirVozes (o aoLargar não desmonta na hora); os nós saem depois do cruzamento de 10 ms
    if (toc) toc.definirVozes(letra, null);
  }
  // ligar(false): a principal volta a soar (cruzamento de 10 ms) e as vozes saem, com os estados (mudo, EQ…) guardados;
  // ligar(true): o inverso. Só vale para a faixa que carregou os stems (outra faixa no deck → descarrega e devolve false).
  function ligar(letra, ligado) {
    const dk = decks[letra], toc = tocador();
    if (!dk || !toc) return false;
    if (!ligado) {
      if (!dk.desligado) { dk.desligado = true; toc.definirVozes(letra, null); }
      avisar(letra, null); return true;
    }
    if (toc.bufferDe(letra) !== dk.principal) { descarregar(letra); return false; }
    if (dk.desligado) {
      dk.desligado = false;
      if (!entrarVozes(letra, dk)) { dk.desligado = true; return false; }
    }
    aplicar(letra); avisar(letra, null); return true;
  }
  function ativo(letra) { const toc = tocador(); return !!decks[letra] && !!toc && toc.vozes(letra).ativas; }
  function definir(letra, nome, parcial) {
    const dk = decks[letra];
    if (!dk || !dk.estados[nome]) return false;
    dk.estados[nome] = SM.normalizar(dk.estados[nome], parcial);
    aplicar(letra);
    avisar(letra, nome);
    return true;
  }
  function estado(letra, nome) {
    const dk = decks[letra];
    if (!dk || !dk.estados[nome]) return null;
    const c = dk.cadeias[nome], e = SM.copia(dk.estados[nome]);
    let p = 0;
    if (c.analisador && typeof c.analisador.getFloatTimeDomainData === 'function') { c.analisador.getFloatTimeDomainData(c.amostras); p = SM.pico(c.amostras); }
    return { ...e, pico: p };
  }
  function aoMudar(fn) { ouvintes.add(fn); return () => ouvintes.delete(fn); }

  return { NOMES, configurar, carregar, descarregar, ligar, ativo, definir, estado, aoMudar };
});
