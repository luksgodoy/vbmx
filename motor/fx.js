// ===================== VbMxFx — efeitos: parâmetros, taxas e estado das unidades de FX =====================
// Dono: VB-22 (onda 2). Lógica pura (UMD), testada em Node por motor/testar-fx.js. Spec: §6.
// O VbMx tem 2 unidades (a spec tem 4; decisão P7 mantém 2). Cada unidade:
//   - atribui-se a qualquer canal, a mais de um ao mesmo tempo (atribuicao: {A, B});
//   - modo "unico": um efeito, seletor + D/W + 3 knobs + 2 botões + reset + liga;
//   - modo "grupo": até 3 efeitos em série, 1 knob cada (o parâmetro principal), liga por efeito,
//     1 D/W da cadeia e liga da unidade.
// Tipos (nomes genéricos): filtro, delay, reverb, flanger, phaser, gater. Todos os knobs de parâmetro
// vão de 0 a 1, exceto o `corte` do filtro (bipolar, −100…+100, 0 = passa tudo) e os que escolhem uma
// taxa (índice inteiro). O tempo vem do BPM do deck mestre: quem usa passa `obterBpm()` ao módulo de
// nós (interface/js/fx-nos.js); aqui só se converte fração de compasso → segundos para um BPM dado.
// Estado imutável: cada função devolve um estado novo e não toca no recebido.
(function (raiz, fabrica) {
  const api = fabrica(raiz);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.VbMxFx = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const UNIDADES = 2;
  const CANAIS = ['A', 'B'];
  const BPM_PADRAO = 120;                  // sem deck mestre, o tempo cai aqui
  const BATIDAS_POR_COMPASSO = 4;
  const TIPOS = ['filtro', 'delay', 'reverb', 'flanger', 'phaser', 'gater'];
  // Rota da unidade no canal (VB-62b, spec §6): inserção (antes do fader, padrão: som igual ao de sempre), pós-fader
  // (depois do fader, antes do crossfader) ou envio (cópia do canal depois do crossfader → unidade 100% processada → soma
  // do master, com nível de envio). Nível de envio padrão 0,5 (ganho linear, ≈ −6 dB): audível sem dobrar o canal.
  const ROTAS = Object.freeze(['insercao', 'pos-fader', 'envio']);
  const ROTULOS_ROTA = Object.freeze({ insercao: 'inserção', 'pos-fader': 'pós-fader', envio: 'envio' });
  const NIVEL_ENVIO_PADRAO = 0.5;
  const NOMES = { filtro: 'Filtro', delay: 'Delay', reverb: 'Reverb', flanger: 'Flanger', phaser: 'Phaser', gater: 'Gater' };

  // frações de compasso (4/4 = 1 compasso inteiro)
  const TAXAS_DELAY = Object.freeze([1 / 32, 1 / 16, 1 / 8, 3 / 16, 1 / 4, 3 / 8, 1]);
  const ROTULOS_DELAY = Object.freeze(['1/32', '1/16', '1/8', '3/16', '1/4', '3/8', '4/4']);
  const TAXAS_GATER = Object.freeze([0, 1 / 4, 1 / 8, 1 / 16, 1 / 32]);   // 0 = desligado
  const ROTULOS_GATER = Object.freeze(['desligado', '1/4', '1/8', '1/16', '1/32']);
  // flanger e phaser: 11 valores; período do LFO em compassos (de 32 a 1/32), ou Hz no modo livre
  const PERIODOS_LFO = Object.freeze(Array.from({ length: 11 }, (_, i) => Math.pow(2, 5 - i)));
  const ROTULOS_LFO = Object.freeze(PERIODOS_LFO.map(p => (p >= 1 ? String(p) : '1/' + Math.round(1 / p))));
  const HZ_LIVRE = Object.freeze(Array.from({ length: 11 }, (_, i) => Math.round(0.05 * Math.pow(2, i * 0.65) * 1000) / 1000));

  // Definição por tipo: 3 parâmetros (`inteiro` = índice de uma lista de taxas) e 2 botões.
  // O primeiro parâmetro é o "principal": é o único knob do efeito no modo grupo.
  const DEFS = Object.freeze({
    filtro: { dw: 1, params: [
      { id: 'corte', rotulo: 'corte', min: -100, max: 100, padrao: 0, bipolar: true },
      { id: 'resson', rotulo: 'resson.', min: 0, max: 1, padrao: 0.3 },
      { id: 'largura', rotulo: 'largura', min: 0, max: 1, padrao: 0.5 }],
      botoes: ['rejeita-banda', 'ressonância +'] },
    delay: { dw: 0.4, params: [
      { id: 'taxa', rotulo: 'taxa', min: 0, max: 6, padrao: 4, inteiro: true },
      { id: 'realim', rotulo: 'realim.', min: 0, max: 1, padrao: 0.4 },
      { id: 'filtro', rotulo: 'filtro', min: -100, max: 100, padrao: 0, bipolar: true }],
      botoes: ['congelar', 'espalhar'] },
    reverb: { dw: 0.35, params: [
      { id: 'tamanho', rotulo: 'tamanho', min: 0, max: 1, padrao: 0.5 },
      { id: 'altas', rotulo: 'passa-altas', min: 0, max: 1, padrao: 0 },
      { id: 'baixas', rotulo: 'passa-baixas', min: 0, max: 1, padrao: 1 }],
      botoes: ['congelar', 'claro'] },
    flanger: { dw: 0.5, params: [
      { id: 'taxa', rotulo: 'taxa', min: 0, max: 10, padrao: 5, inteiro: true },
      { id: 'realim', rotulo: 'realim.', min: 0, max: 1, padrao: 0.5 },
      { id: 'espalha', rotulo: 'espalhar', min: 0, max: 1, padrao: 0.5 }],
      botoes: ['sincronizar', 'inverter fase'] },
    phaser: { dw: 0.5, params: [
      { id: 'taxa', rotulo: 'taxa', min: 0, max: 10, padrao: 5, inteiro: true },
      { id: 'realim', rotulo: 'realim.', min: 0, max: 1, padrao: 0.4 },
      { id: 'espalha', rotulo: 'espalhar', min: 0, max: 1, padrao: 0.5 }],
      botoes: ['sincronizar', 'inverter fase'] },
    gater: { dw: 1, params: [
      { id: 'taxa', rotulo: 'taxa', min: 0, max: 4, padrao: 2, inteiro: true },
      { id: 'forma', rotulo: 'forma', min: 0, max: 1, padrao: 0 },
      { id: 'vazamento', rotulo: 'vazamento', min: 0, max: 1, padrao: 0 }],
      botoes: ['mudo', 'stutter 3/16'] },
  });

  const limitar = (v, a, b) => Math.min(b, Math.max(a, v));

  // ---------------- tempo ----------------
  function bpmValido(bpm) { return Number.isFinite(bpm) && bpm > 0 ? bpm : BPM_PADRAO; }
  // fração de compasso → segundos (4/4 = 4 batidas)
  function segundosDaFracao(fracao, bpm) { return fracao * BATIDAS_POR_COMPASSO * 60 / bpmValido(bpm); }
  function frequenciaDaFracao(fracao, bpm) { return fracao > 0 ? 1 / segundosDaFracao(fracao, bpm) : 0; }
  function tempoDelay(indice, bpm) { return segundosDaFracao(TAXAS_DELAY[limitar(Math.round(indice), 0, TAXAS_DELAY.length - 1)], bpm); }
  // gater: frequência (Hz) do portão; "stutter" força 3/16. 0 = desligado (portão aberto)
  function frequenciaGater(indice, bpm, stutter) {
    const f = stutter ? 3 / 16 : TAXAS_GATER[limitar(Math.round(indice), 0, TAXAS_GATER.length - 1)];
    return frequenciaDaFracao(f, bpm);
  }
  // LFO do flanger/phaser: sincronizado (período em compassos × BPM) ou livre (Hz)
  function frequenciaLfo(indice, bpm, sincronizado) {
    const i = limitar(Math.round(indice), 0, PERIODOS_LFO.length - 1);
    return sincronizado ? 1 / (PERIODOS_LFO[i] * BATIDAS_POR_COMPASSO * 60 / bpmValido(bpm)) : HZ_LIVRE[i];
  }

  // ---------------- curvas dos knobs ----------------
  // filtro bipolar de 1 knob: negativo = passa-baixa fechando, positivo = passa-alta abrindo, 0 = passa tudo
  function filtroBipolar(knob) {
    const k = limitar(knob, -100, 100), a = Math.abs(k) / 100;
    const f = (x) => 20 * Math.pow(1000, x);                     // 20 Hz … 20 kHz
    if (a < 0.005) return { ativo: false, passaBaixa: 20000, passaAlta: 20 };
    return k < 0 ? { ativo: true, passaBaixa: f(1 - a), passaAlta: 20 } : { ativo: true, passaBaixa: 20000, passaAlta: f(a) };
  }
  // D/W de potência igual: 0 = só seco, 1 = só processado
  function mistura(dw) { const d = limitar(dw, 0, 1); return { seco: Math.cos(d * Math.PI / 2), molhado: Math.sin(d * Math.PI / 2) }; }
  function ganhoDeRealimentacao(v, congelado) { return congelado ? 0.97 : limitar(v, 0, 1) * 0.9; }

  // ---------------- estado ----------------
  function paramsPadrao(tipo) { return DEFS[tipo].params.map(p => p.padrao); }
  function efeitoPadrao(tipo) { return { tipo, params: paramsPadrao(tipo), botoes: [false, false], dw: DEFS[tipo].dw }; }
  function unidadePadrao(n) {
    return {
      n, modo: 'unico', ligada: false, rota: 'insercao', nivelEnvio: NIVEL_ENVIO_PADRAO, atribuicao: { A: false, B: false },
      unico: efeitoPadrao(n === 2 ? 'delay' : 'filtro'),
      grupo: { dw: 0.5, slots: [0, 1, 2].map(i => { const t = ['filtro', 'delay', 'reverb'][i]; return { tipo: t, valor: DEFS[t].params[0].padrao, ligado: false }; }) },
      snapshots: {},
    };
  }
  function estadoInicial() { return { unidades: [unidadePadrao(1), unidadePadrao(2)] }; }
  const trocarUnidade = (est, n, fn) => ({ ...est, unidades: est.unidades.map(u => (u.n === n ? fn(u) : u)) });
  function checaTipo(tipo) { if (!DEFS[tipo]) throw new Error('VbMxFx: tipo desconhecido ' + tipo); }
  const fotoDoUnico = (u) => ({ params: u.unico.params.slice(), botoes: u.unico.botoes.slice(), dw: u.unico.dw });

  function atribuir(est, n, canal, valor) {
    if (!CANAIS.includes(canal)) throw new Error('VbMxFx.atribuir: canal ' + canal);
    return trocarUnidade(est, n, u => ({ ...u, atribuicao: { ...u.atribuicao, [canal]: valor === undefined ? !u.atribuicao[canal] : !!valor } }));
  }
  function ligar(est, n, valor) { return trocarUnidade(est, n, u => ({ ...u, ligada: valor === undefined ? !u.ligada : !!valor })); }
  function trocarModo(est, n, modo) {
    if (modo !== 'unico' && modo !== 'grupo') throw new Error('VbMxFx.trocarModo: modo ' + modo);
    return trocarUnidade(est, n, u => ({ ...u, modo }));
  }
  function definirRota(est, n, rota) {
    if (!ROTAS.includes(rota)) throw new Error('VbMxFx.definirRota: rota ' + rota);
    return trocarUnidade(est, n, u => ({ ...u, rota }));
  }
  function proximaRota(est, n) { const u = est.unidades.find(x => x.n === n); return definirRota(est, n, ROTAS[(ROTAS.indexOf(u.rota) + 1) % ROTAS.length]); }
  function definirNivelEnvio(est, n, valor) {
    const v = Number(valor);
    if (!Number.isFinite(v)) throw new Error('VbMxFx.definirNivelEnvio: ' + valor);
    return trocarUnidade(est, n, u => ({ ...u, nivelEnvio: limitar(v, 0, 1) }));
  }
  // snapshot: guarda parâmetros, botões e D/W do efeito do modo único para a próxima vez que ele for escolhido
  function salvarSnapshot(est, n) {
    return trocarUnidade(est, n, u => ({ ...u, snapshots: { ...u.snapshots, [u.unico.tipo]: fotoDoUnico(u) } }));
  }
  // escolher o efeito do modo único: guarda o que saía (snapshot automático) e recupera o do novo, se houver
  function definirTipo(est, n, tipo) {
    checaTipo(tipo);
    return trocarUnidade(est, n, u => {
      if (u.unico.tipo === tipo) return u;
      const guardados = { ...u.snapshots, [u.unico.tipo]: fotoDoUnico(u) };
      const s = guardados[tipo];
      return { ...u, snapshots: guardados, unico: s ? { tipo, params: s.params.slice(), botoes: s.botoes.slice(), dw: s.dw } : efeitoPadrao(tipo) };
    });
  }
  function definirParametro(est, n, indice, valor) {
    return trocarUnidade(est, n, u => {
      const d = DEFS[u.unico.tipo].params[indice];
      if (!d) throw new Error('VbMxFx.definirParametro: índice ' + indice);
      const v = limitar(Number(valor), d.min, d.max);
      const params = u.unico.params.slice(); params[indice] = d.inteiro ? Math.round(v) : v;
      return { ...u, unico: { ...u.unico, params } };
    });
  }
  function alternarBotao(est, n, indice, valor) {
    return trocarUnidade(est, n, u => {
      if (indice !== 0 && indice !== 1) throw new Error('VbMxFx.alternarBotao: índice ' + indice);
      const botoes = u.unico.botoes.slice(); botoes[indice] = valor === undefined ? !botoes[indice] : !!valor;
      return { ...u, unico: { ...u.unico, botoes } };
    });
  }
  function definirDw(est, n, valor) {
    return trocarUnidade(est, n, u => {
      const dw = limitar(Number(valor), 0, 1);
      return u.modo === 'grupo' ? { ...u, grupo: { ...u.grupo, dw } } : { ...u, unico: { ...u.unico, dw } };
    });
  }
  // reset (botão no modo único): volta aos padrões do efeito
  function resetar(est, n) { return trocarUnidade(est, n, u => ({ ...u, unico: efeitoPadrao(u.unico.tipo) })); }
  const trocarSlot = (est, n, i, fn) => trocarUnidade(est, n, u => ({ ...u, grupo: { ...u.grupo, slots: u.grupo.slots.map((s, j) => (j === i ? fn(s) : s)) } }));
  function definirSlotTipo(est, n, i, tipo) {
    checaTipo(tipo);
    return trocarSlot(est, n, i, s => ({ ...s, tipo, valor: DEFS[tipo].params[0].padrao }));
  }
  function definirSlotValor(est, n, i, valor) {
    return trocarSlot(est, n, i, s => {
      const d = DEFS[s.tipo].params[0];
      const v = limitar(Number(valor), d.min, d.max);
      return { ...s, valor: d.inteiro ? Math.round(v) : v };
    });
  }
  function ligarSlot(est, n, i, valor) { return trocarSlot(est, n, i, s => ({ ...s, ligado: valor === undefined ? !s.ligado : !!valor })); }
  // duplo clique no knob do grupo
  function resetarSlot(est, n, i) { return trocarSlot(est, n, i, s => ({ ...s, valor: DEFS[s.tipo].params[0].padrao })); }

  // O que o áudio precisa de uma unidade, igual nos dois modos: lista de até 3 efeitos {tipo, params, botoes,
  // ligado}, o D/W e se a unidade está ligada. No grupo, só o parâmetro principal vem do knob; o resto é o padrão.
  function efeitosEfetivos(u) {
    if (u.modo === 'grupo') {
      return { ligada: u.ligada, dw: u.grupo.dw, efeitos: u.grupo.slots.map(s => {
        const params = paramsPadrao(s.tipo); params[0] = s.valor;
        return { tipo: s.tipo, params, botoes: [false, false], ligado: s.ligado };
      }) };
    }
    return { ligada: u.ligada, dw: u.unico.dw, efeitos: [{ tipo: u.unico.tipo, params: u.unico.params.slice(), botoes: u.unico.botoes.slice(), ligado: true }] };
  }
  // a unidade processa o canal? (atribuída a ele e ligada)
  function ativaNoCanal(u, canal) { return !!(u.ligada && u.atribuicao[canal]); }
  function rotuloDoParametro(tipo, indice, valor) {
    const d = DEFS[tipo].params[indice];
    if (!d) return '';
    if (tipo === 'delay' && indice === 0) return ROTULOS_DELAY[Math.round(valor)];
    if (tipo === 'gater' && indice === 0) return ROTULOS_GATER[Math.round(valor)];
    if ((tipo === 'flanger' || tipo === 'phaser') && indice === 0) return ROTULOS_LFO[Math.round(valor)];
    if (d.bipolar) return (valor > 0 ? '+' : '') + Math.round(valor);
    return Math.round(valor * 100) + '%';
  }

  return {
    ROTAS, ROTULOS_ROTA, NIVEL_ENVIO_PADRAO, definirRota, proximaRota, definirNivelEnvio,
    UNIDADES, CANAIS, BPM_PADRAO, TIPOS, NOMES, DEFS, TAXAS_DELAY, ROTULOS_DELAY, TAXAS_GATER, ROTULOS_GATER,
    PERIODOS_LFO, ROTULOS_LFO, HZ_LIVRE,
    segundosDaFracao, frequenciaDaFracao, tempoDelay, frequenciaGater, frequenciaLfo, filtroBipolar, mistura,
    ganhoDeRealimentacao, paramsPadrao, efeitoPadrao, estadoInicial, atribuir, ligar, trocarModo, salvarSnapshot,
    definirTipo, definirParametro, alternarBotao, definirDw, resetar, definirSlotTipo, definirSlotValor, ligarSlot,
    resetarSlot, efeitosEfetivos, ativaNoCanal, rotuloDoParametro,
  };
});
