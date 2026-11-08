// ===================== VbMxCadeia: o grafo de áudio, com pontos nomeados (VB-11) =====================
// Por canal:  fonte → gain → eq → filtro → fx → fader → posfader → crossfader ─┐
//                                        └→ derivação "pre-fader" (PFL do fone)
// Master:     soma → limiter → saida → AudioContext.destination
//                                └→ derivação "master" (gravador e medidores)
// Cada ponto é {entrada, saida} (GainNode, ganho 1). Sem nada inserido, entrada liga direto na saida,
// passando pelo núcleo do ponto quando ele tem um:
//   gain       controle (GainNode, trim; 1 com o trim em 0 dB)
//   eq         bandas.hi/mid/low (EQ atual, padrão: BiquadFilter highshelf/peaking/lowshelf, de VbMxReproducao.BANDAS);
//              isolador.hi/mid/low (GainNode por via de um crossover Linkwitz-Riley de 3 vias, kill total = 0);
//              com algum kill ligado o canal soa pela via do isolador (VB-47), com rampa de ganho entre as vias;
//              modo() / definirModo('atual'|'isolador') religam a entrada, só um dos dois processa por vez
//   filtro     passa-baixa/passa-alta do canal num botão, fora do caminho (dry) com o botão em 0; em paralelo, a unidade
//              de efeitos de canal (VbMxFxCanal, VB-60), que assume o canal quando um efeito no lugar do filtro é escolhido
//   fader      controle (volume do canal)
//   crossfader controle (ganho do crossfader para o canal)
//   saida      controle (volume master)
//   limiter    limitador de pico (ganho 0,5 + WaveShaper de VbMxMixer.curvaLimitador), ligado ou transparente
//   fx         vazio, só inserção (antes do fader)
//   posfader   vazio, só inserção (depois do fader, antes do crossfader; VB-62b)
// (filtro e limiter continuam aceitando inserir(): quem insere tira o núcleo do caminho até remover.)
// O som padrão é o mesmo de antes do VB-11: fader × crossfader = VbMxReproducao.ganhoDoCanal.
//
// API (contrato: docs/contratos.md):
//   montar(ctx)                    cria o grafo uma vez (audio.js chama no 1º gesto)
//   montada()                      true depois de montar
//   ponto(letra, nome)             letra "A"|"B" com PONTOS.canal, ou "master" com PONTOS.master
//   inserir(letra, nome, {entrada, saida}) → remover()   liga um processador DENTRO do ponto
//                                  (só filtro, fx e limiter; um por ponto — encadear é com quem insere)
//   enviar(letra, {entrada, saida}) → {nivel, remover}   envio em paralelo (VB-62b): cópia do canal depois do crossfader →
//                                  nivel (GainNode, 0 ao nascer) → entrada…saida → soma do master. Não mexe no caminho do canal
//   derivar(nome, letra?)          GainNode que recebe uma cópia do sinal: ("pre-fader", "A"|"B"), ("master") ou
//                                  ("master-sem-clique"); derivar("clique") é a entrada do clique do metrônomo (VB-51).
//                                  Não vai a lugar nenhum até quem pediu ligá-lo
//   entradaDoCanal(letra)          onde o tocador liga a fonte (= ponto(letra, "gain").entrada)
//   rotearSaida(plano) / aplicarFone(ganhos) / planoDaSaida() / maxCanaisDaSaida()   fone/PFL e saída multicanal (VB-23; motor/fone.js)
//   aplicarMixer(mixer)            leva o estado do mixer (js/mixer.js) para trim, EQ (e kill), filtro, fader,
//                                  crossfader (curva e reverso), master e limitador; campo que falta vale o padrão
(function (raiz, fabrica) {
  const api = fabrica(raiz);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.VbMxCadeia = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (raiz) {
  'use strict';
  const CANAIS = ['A', 'B'];
  const PONTOS = Object.freeze({ canal: ['gain', 'eq', 'filtro', 'fx', 'fader', 'posfader', 'crossfader'], master: ['soma', 'limiter', 'saida'] });
  const INSERIVEIS = new Set(['filtro', 'fx', 'posfader', 'limiter']);
  const SUAVE = 0.01;   // s, constante de tempo das mudanças de ganho (sem clique)
  let ctx = null;
  const grafo = {};      // grafo[letra][nome] = ponto
  const derivacoes = new Map();
  let final = null, clique = null;   // fim do master e entrada do clique do metrônomo

  function ganho(v) { const g = ctx.createGain(); g.gain.value = v; return g; }
  function mixerMotor() { return raiz.VbMxMixer || (typeof require === 'function' ? require('../../motor/mixer.js') : null); }
  function biquad(tipo, freq, q) {
    const f = ctx.createBiquadFilter();
    f.type = tipo; f.frequency.value = freq; if (q !== undefined) f.Q.value = q;
    return f;
  }
  function novoPonto(nome) {
    const p = { nome, entrada: ganho(1), saida: ganho(1), nucleo: [], inserido: null };
    if (nome === 'gain' || nome === 'fader' || nome === 'crossfader' || nome === 'saida') { p.controle = ganho(1); p.nucleo = [p.controle]; }
    if (nome === 'crossfader' && ctx.createStereoPanner) { p.pan = ctx.createStereoPanner(); p.nucleo.push(p.pan); }   // PAN do canal (VB-16b)
    if (nome === 'eq') montarEq(p);
    if (nome === 'filtro') montarFiltro(p);
    if (nome === 'limiter') montarLimiter(p);
    ligarNucleo(p);
    return p;
  }
  // EQ: dois processadores lado a lado; só o do modo ativo recebe sinal (P6: o atual é o padrão).
  function montarEq(p) {
    const R = raiz.VbMxReproducao || (typeof require === 'function' ? require('../../motor/reproducao.js') : null);
    const M = mixerMotor();
    p.bandas = {};
    for (const b of ['hi', 'mid', 'low']) { const cfg = R.BANDAS[b]; p.bandas[b] = biquad(cfg.tipo, cfg.freq, cfg.q); }
    p.bandas.hi.connect(p.bandas.mid); p.bandas.mid.connect(p.bandas.low); p.bandas.low.connect(p.saida);
    // isolador: separa em 3 vias (LR4 = 2 Butterworth em cascata) e soma; a via aguda leva um passa-tudo no
    // cruzamento baixo para ficar em fase com as outras duas, e a soma das vias fica plana em módulo.
    const par = (tipo, f) => [biquad(tipo, f, M.Q_BUTTERWORTH), biquad(tipo, f, M.Q_BUTTERWORTH)];
    const encadeia = (lista) => { for (let i = 1; i < lista.length; i++) lista[i - 1].connect(lista[i]); return lista; };
    const aguda = encadeia([...par('highpass', M.CRUZAMENTO.alto), biquad('allpass', M.CRUZAMENTO.baixo, M.Q_BUTTERWORTH)]);
    const resto = encadeia(par('lowpass', M.CRUZAMENTO.alto));
    const baixa = encadeia(par('lowpass', M.CRUZAMENTO.baixo)), media = encadeia(par('highpass', M.CRUZAMENTO.baixo));
    p.isolador = { hi: ganho(1), mid: ganho(1), low: ganho(1) };
    p.isoEntrada = ganho(0); p.atualEntrada = ganho(1);   // as duas vias recebem sempre; o ganho decide qual soa
    p.atualEntrada.connect(p.bandas.hi);
    p.isoEntrada.connect(aguda[0]); p.isoEntrada.connect(resto[0]);
    resto[resto.length - 1].connect(baixa[0]); resto[resto.length - 1].connect(media[0]);
    aguda[aguda.length - 1].connect(p.isolador.hi); baixa[baixa.length - 1].connect(p.isolador.low); media[media.length - 1].connect(p.isolador.mid);
    for (const b of ['hi', 'mid', 'low']) p.isolador[b].connect(p.saida);
    p.modo = 'atual';
    p.via = 'atual';   // a via que soa: modo isolador, ou o atual com algum kill (VB-47: kill zera a banda)
    p.religar = () => { p.entrada.connect(p.atualEntrada); p.entrada.connect(p.isoEntrada); };
  }
  // Filtro do canal: caminho seco (padrão, nada processa) ou passa-baixa → passa-alta; o botão em 0 deixa o seco.
  function montarFiltro(p) {
    p.seco = ganho(1); p.molhado = ganho(0);
    p.lp = biquad('lowpass', 20000, 0.7071); p.hp = biquad('highpass', 20, 0.7071);
    p.lp.connect(p.hp); p.hp.connect(p.molhado); p.molhado.connect(p.saida);
    p.seco.connect(p.saida);
    // VB-60: efeitos de mixer por canal em paralelo ao filtro (js/fx-canal.js); a unidade fica muda enquanto o filtro está selecionado
    if (raiz.VbMxFxCanal) { p.fxc = raiz.VbMxFxCanal.criar(ctx); p.fxc.saida.connect(p.saida); }
    p.religar = () => { p.entrada.connect(p.seco); p.entrada.connect(p.lp); if (p.fxc) p.entrada.connect(p.fxc.entrada); };
  }
  // Limitador de pico do master: ganho 0,5 → WaveShaper cuja curva cobre ±2 (VbMxMixer.curvaLimitador).
  function montarLimiter(p) {
    p.controle = ganho(1); p.ativo = false;
    if (!ctx.createWaveShaper) { p.nucleo = []; return; }   // contexto sem WaveShaper: passa direto
    p.formador = ctx.createWaveShaper(); p.formador.oversample = 'none';
    p.nucleo = [p.controle, p.formador];
  }
  function ligarNucleo(p) {
    if (p.religar) { p.religar(); return; }
    let ultimo = p.entrada;
    for (const n of p.nucleo) { ultimo.connect(n); ultimo = n; }
    ultimo.connect(p.saida);
  }
  function encadear(pontos) { for (let i = 1; i < pontos.length; i++) pontos[i - 1].saida.connect(pontos[i].entrada); }

  function montar(c) {
    if (ctx) return api;
    ctx = c;
    grafo.master = {};
    for (const nome of PONTOS.master) grafo.master[nome] = novoPonto(nome);
    encadear(PONTOS.master.map(n => grafo.master[n]));
    // Fim do master: saída do volume + clique do metrônomo (VB-51). A derivação "master" sai daqui (com o clique);
    // "master-sem-clique" sai antes dele. O clique entra pelo GainNode `clique`, que o gravador pode excluir.
    final = ganho(1); clique = ganho(1); grafo.master.final = { nome: 'final', entrada: final, saida: final };   // ponto("master","final"): o que vai ao destino
    grafo.master.saida.saida.connect(final); clique.connect(final);
    final.connect(ctx.destination);
    for (const l of CANAIS) {
      grafo[l] = {};
      for (const nome of PONTOS.canal) grafo[l][nome] = novoPonto(nome);
      encadear(PONTOS.canal.map(n => grafo[l][n]));
      grafo[l].crossfader.saida.connect(grafo.master.soma.entrada);
    }
    return api;
  }
  function montada() { return !!ctx; }
  function ponto(letra, nome) {
    if (!ctx) throw new Error('VbMxCadeia: o grafo ainda não foi montado (garantirAudio)');
    const p = grafo[letra] && grafo[letra][nome];
    if (!p) throw new Error(`VbMxCadeia: ponto desconhecido ${letra}/${nome}`);
    return p;
  }
  function inserir(letra, nome, no) {
    const p = ponto(letra, nome);
    if (!INSERIVEIS.has(nome)) throw new Error(`VbMxCadeia: o ponto ${nome} não aceita inserção (só ${[...INSERIVEIS].join(', ')})`);
    if (p.inserido) throw new Error(`VbMxCadeia: ${letra}/${nome} já tem um processador inserido`);
    if (!no || !no.entrada || !no.saida) throw new Error('VbMxCadeia.inserir: precisa de {entrada, saida}');
    p.entrada.disconnect();
    p.entrada.connect(no.entrada); no.saida.connect(p.saida);
    p.inserido = no;
    return function remover() {
      if (p.inserido !== no) return;
      p.entrada.disconnect(); try { no.saida.disconnect(p.saida); } catch (_) { /* já desligado */ }
      p.inserido = null; ligarNucleo(p);
    };
  }
  function enviar(letra, no) {
    if (!CANAIS.includes(letra)) throw new Error(`VbMxCadeia.enviar: canal desconhecido ${letra}`);
    if (!no || !no.entrada || !no.saida) throw new Error('VbMxCadeia.enviar: precisa de {entrada, saida}');
    const origem = ponto(letra, 'crossfader').saida, soma = ponto('master', 'soma').entrada, nivel = ganho(0);
    origem.connect(nivel); nivel.connect(no.entrada); no.saida.connect(soma);
    return { nivel, remover() { try { origem.disconnect(nivel); } catch (_) { /* já desligado */ } try { nivel.disconnect(); } catch (_) { /* idem */ } try { no.saida.disconnect(soma); } catch (_) { /* idem */ } } };
  }
  function derivar(nome, letra) {
    const chave = nome === 'pre-fader' ? `pre-fader:${letra}` : nome;
    if (derivacoes.has(chave)) return derivacoes.get(chave);
    let origem;
    if (nome === 'pre-fader' && CANAIS.includes(letra)) origem = ponto(letra, 'fx').saida;
    else if (nome === 'master') origem = (ponto('master', 'saida'), final);
    else if (nome === 'master-sem-clique') origem = ponto('master', 'saida').saida;
    else if (nome === 'clique') { derivacoes.set(chave, clique); return clique; }   // onde o metrônomo liga o clique
    else throw new Error(`VbMxCadeia.derivar: derivação desconhecida "${nome}"${letra ? ` (${letra})` : ''}`);
    const g = ganho(1);
    origem.connect(g);
    derivacoes.set(chave, g);
    return g;
  }
  function entradaDoCanal(letra) { return ponto(letra, 'gain').entrada; }
  // Leva o ganho de cada via a 1 ou 0; com `rampa`, em constante curta (SUAVE): trocar de via sem estalo.
  function definirViaEq(p, via, rampa) {
    p.via = via;
    const a = via === 'atual' ? 1 : 0, i = 1 - a;
    if (rampa && ctx) { const t = ctx.currentTime; p.atualEntrada.gain.setTargetAtTime(a, t, SUAVE); p.isoEntrada.gain.setTargetAtTime(i, t, SUAVE); }
    else { p.atualEntrada.gain.value = a; p.isoEntrada.gain.value = i; }
  }
  function definirModoEq(modo) {
    const alvo = modo === 'isolador' ? 'isolador' : 'atual';
    for (const l of CANAIS) {
      const p = grafo[l] && grafo[l].eq;
      if (!p || p.modo === alvo) continue;
      p.modo = alvo; definirViaEq(p, alvo, false);
    }
  }
  function modoEq(letra) { return ponto(letra || 'A', 'eq').modo; }
  function aplicarMixer(entrada) {
    if (!ctx) return;
    const M = mixerMotor();
    const mixer = M.normalizar(entrada);
    const t = ctx.currentTime;
    definirModoEq(mixer.eqModo);
    for (const l of CANAIS) {
      const c = grafo[l], m = mixer[l];
      const via = M.viaDoEq(m, mixer.eqModo);
      if (via !== c.eq.via) definirViaEq(c.eq, via, true);
      c.gain.controle.gain.setTargetAtTime(M.ganhoDeEntrada(m), t, SUAVE);   // trim × auto gain, antes do fader
      if (c.crossfader.pan) c.crossfader.pan.pan.setTargetAtTime(M.valorPan(m.pan), t, SUAVE);
      for (const b of ['hi', 'mid', 'low']) {
        c.eq.bandas[b].gain.setTargetAtTime(M.dbBandaAtual(m[b], m.kill[b]), t, SUAVE);
        c.eq.isolador[b].gain.setTargetAtTime(M.ganhoBandaIsolador(m[b], m.kill[b]), t, SUAVE);
      }
      const fp = c.filtro, fxc = M.fxDoCanal(m), usaFx = !!fp.fxc && fxc.id !== 'filtro';   // efeito do canal (VB-60) no lugar do filtro
      const f = M.filtroDoBotao(usaFx ? 0 : m.filtro);
      fp.lp.frequency.setTargetAtTime(Math.min(f.lp, ctx.sampleRate ? ctx.sampleRate / 2 - 100 : f.lp), t, SUAVE);
      fp.hp.frequency.setTargetAtTime(f.hp, t, SUAVE);
      fp.lp.Q.setTargetAtTime(f.q, t, SUAVE); fp.hp.Q.setTargetAtTime(f.q, t, SUAVE);
      fp.seco.gain.setTargetAtTime(f.ativo || usaFx ? 0 : 1, t, SUAVE);
      if (fp.fxc) fp.fxc.aplicar({ id: fxc.id, params: M.fxParametros(fxc.id, fxc.qtd, raiz.VbMxFxCanal.lerBpm()) });
      fp.molhado.gain.setTargetAtTime(f.ativo ? 1 : 0, t, SUAVE);
      c.fader.controle.gain.setTargetAtTime(M.ganhoFader(m.vol, mixer.curvaFader), t, SUAVE);
      c.crossfader.controle.gain.setTargetAtTime(M.ganhoCrossfaderDoCanal(m, mixer), t, SUAVE);
    }
    grafo.master.saida.controle.gain.setTargetAtTime(M.ganhoMaster(mixer.master.vol), t, SUAVE);
    const lim = grafo.master.limiter;
    if (lim.formador && lim.ativo !== mixer.master.limiter) {
      lim.ativo = mixer.master.limiter;
      lim.formador.curve = lim.ativo ? Float32Array.from(M.curvaLimitador()) : null;
      lim.controle.gain.value = lim.ativo ? 1 / M.LIMITADOR.alcance : 1;
    }
  }

  // ---------- fone/PFL e saída (VB-23; plano de motor/fone.js) ----------
  // Fone:  derivação "pre-fader" de cada canal → chave de cue (0/1) → ganho do cue (MIX) ─┐
  //        derivação "master" ──────────────────────────────→ ganho da principal (MIX) ─┴→ VOL → fone.saida
  // rotearSaida(plano) liga master e fone ao destino: "multicanal" = ChannelMerger de 4 entradas (master em 0/1,
  // fone em 2/3); "dividido" = merger de 2 (fone mono em 0, master mono em 1); "desligado" = master direto no
  // destino, como antes. Chamar de novo refaz a ligação (troca de saída/modo). Nada disso existe antes de montar().
  let fone = null;
  function montarFone() {
    const f = { cue: {}, bus: ganho(1), ganhoCue: ganho(1), principal: ganho(1), vol: ganho(0), saida: ganho(1), merger: null, plano: null };
    for (const l of CANAIS) { f.cue[l] = ganho(0); derivar('pre-fader', l).connect(f.cue[l]); f.cue[l].connect(f.bus); }
    f.tick = ganho(1); f.tick.connect(f.bus);   // entrada do tick da grade (VB-52): mistura-se ao cue, antes do MIX e do VOL
    f.bus.connect(f.ganhoCue);
    derivar('master').connect(f.principal);
    f.ganhoCue.connect(f.vol); f.principal.connect(f.vol); f.vol.connect(f.saida);
    return f;
  }
  function soltarSaida() {
    const mestre = final;
    try { mestre.disconnect(ctx.destination); } catch (_) { /* já solto */ }
    if (fone) { try { fone.saida.disconnect(); } catch (_) { /* já solto */ } }
    if (fone && fone.merger) { try { fone.merger.disconnect(); } catch (_) { /* já solto */ } fone.merger = null; }
    if (fone && fone.divisores) { for (const d of fone.divisores) { try { d.disconnect(); } catch (_) { /* já solto */ } } fone.divisores = []; }
  }
  function rotearSaida(plano) {
    if (!ctx) throw new Error('VbMxCadeia: o grafo ainda não foi montado (garantirAudio)');
    const mestre = final;
    if (!fone) fone = montarFone();
    soltarSaida();
    fone.plano = plano || null;
    if (!plano || plano.modo === 'desligado') { mestre.connect(ctx.destination); return api; }
    try { ctx.destination.channelCount = plano.canaisDestino; ctx.destination.channelCountMode = 'explicit'; ctx.destination.channelInterpretation = 'discrete'; }
    catch (_) { /* destino que não aceita: o merger ainda manda os canais certos */ }
    const m = ctx.createChannelMerger(plano.canaisDestino);
    fone.merger = m; fone.divisores = [];
    const fontes = { master: mestre, fone: fone.saida }, divisor = {};
    for (const lig of plano.ligacoes) {
      const origem = fontes[lig.fonte];
      if (lig.canal === null) origem.connect(m, 0, lig.entrada);   // origem estéreo na entrada mono do merger: soma em mono
      else {
        if (!divisor[lig.fonte]) { divisor[lig.fonte] = ctx.createChannelSplitter(2); origem.connect(divisor[lig.fonte]); fone.divisores.push(divisor[lig.fonte]); }
        divisor[lig.fonte].connect(m, lig.canal, lig.entrada);
      }
    }
    m.connect(ctx.destination);
    return api;
  }
  // g = VbMxFone.ganhosDoFone(estado): {cue:{A,B}, ganhoCue, ganhoPrincipal, vol}
  function aplicarFone(g) {
    if (!ctx) return;
    if (!fone) fone = montarFone();
    const t = ctx.currentTime;
    for (const l of CANAIS) fone.cue[l].gain.setTargetAtTime(g.cue[l] ? 1 : 0, t, SUAVE);
    fone.ganhoCue.gain.setTargetAtTime(g.ganhoCue, t, SUAVE);
    fone.principal.gain.setTargetAtTime(g.ganhoPrincipal, t, SUAVE);
    fone.vol.gain.setTargetAtTime(g.vol, t, SUAVE);
  }
  function maxCanaisDaSaida() { return ctx && ctx.destination ? ctx.destination.maxChannelCount || 2 : 2; }   // o que a saída atual aceita (destination.maxChannelCount)
  function planoDaSaida() { return fone ? fone.plano : null; }
  // entrada onde o tick da grade (tick.js) se liga para sair só no fone; cria o ramo do fone se ainda não houver
  function entradaTick() { if (!ctx) return null; if (!fone) fone = montarFone(); return fone.tick; }

  const api = { CANAIS, PONTOS, montar, montada, ponto, inserir, enviar, derivar, entradaDoCanal, aplicarMixer, definirModoEq, modoEq, rotearSaida, aplicarFone, planoDaSaida, entradaTick, maxCanaisDaSaida };
  return api;
});
