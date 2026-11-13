// ===================== VbMxLeds — LEDs do controlador: estado do deck/stems → mapa de LEDs =====================
// X1-LEDS (fatia (d) de docs/midi-x1-mk3.md § 4). Lógica pura (UMD), testada em Node por motor/testar-leds.js; quem
// lê o estado da página e manda os bytes é interface/js/midi.js (só a diferença; tudo de novo ao religar a porta).
//
// A regra é dado: `saidas` do perfil (interface/perfis/x1-mk3.json), parametrizável:
//   { brilho: {forte, fraco, apagado}, endereco: 'mesmo-controle', regras: [{controle, comando, acende, brilho, ...}] }
// Endereço 'mesmo-controle': o LED de um botão é a mesma nota (ou CC) no mesmo canal que o botão manda — o que a X1 MK3
// faz no modo MIDI está **a confirmar no aparelho** (fatia (e)). O LED segue o comando, não o número: ele sai das
// atribuições do mapa, então o remapeamento do Lucas leva o LED junto. Só a camada sem SHIFT acende (os canais que
// `parametros.camadas` declara como camada ficam de fora: o SHIFT não tem LED próprio).
//
// leitura = { A: {tocando, sync, loopAtivo, hotcues: [bool×8], stemsLigados, stems: {voz: {mudo, solo}}}, B: {…} }
(function (raiz, fabrica) {
  const api = fabrica(raiz);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.VbMxLeds = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const BRILHO_PADRAO = Object.freeze({ forte: 126, fraco: 70, apagado: 0 });
  const chaveDe = (f) => f.tipo + ':' + (f.canal | 0) + ':' + (f.numero | 0);   // a mesma de VbMxMapaControle.chaveFisico
  const globParaRegex = (g) => new RegExp('^' + String(g).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^.]*') + '$');

  // O que cada `acende` lê da leitura do deck, para o comando da linha: true/false, ou o nome do brilho quando há
  // mais de dois estados. Nome desconhecido não acende nada (a regra entra em `erros`).
  const CONDICOES = {
    'tocando': (d) => !!d.tocando,
    'sync': (d) => !!d.sync,
    'loop-ativo': (d) => !!d.loopAtivo,
    'stems-ligados': (d) => !!d.stemsLigados,
    // hotcueN: o slot N-1 tem ponto
    'ocupado': (d, cmd) => { const m = /^hotcue(\d+)$/.exec(cmd); return !!(m && d.hotcues && d.hotcues[Number(m[1]) - 1]); },
    // stem.<voz>.mudo: soando = não mudo e (ninguém em solo ou ele em solo); modo stems desligado = apagado
    'soando': (d, cmd, regra) => {
      const m = /^stem\.([^.]+)\./.exec(cmd);
      if (!m || !d.stemsLigados || !d.stems || !d.stems[m[1]]) return 'apagado';
      const s = d.stems[m[1]], algumSolo = Object.values(d.stems).some((x) => x && x.solo);
      return !s.mudo && (!algumSolo || s.solo) ? regra.brilho || 'forte' : regra.mudo || regra.senao || 'apagado';
    },
  };
  const CONDICOES_NOMES = Object.keys(CONDICOES);

  // Os LEDs que um mapa endereça: [{chave, alvo, comando, regra}], uma entrada por controle físico (a primeira linha
  // que casar). `camadas` = parametros.camadas do perfil ({canal da camada: canal base}).
  function enderecosDosLeds(saidas, atribuicoes, camadas) {
    const erros = [], lista = [], vistos = new Set();
    if (!saidas || !Array.isArray(saidas.regras)) return { lista, erros: ['sem regras de saída'] };
    if (saidas.endereco && saidas.endereco !== 'mesmo-controle') return { lista, erros: ['endereço desconhecido: ' + saidas.endereco] };
    const deCamada = new Set(Object.keys(camadas || {}).map(Number));
    const regras = [];
    for (const r of saidas.regras) {
      if (!r || typeof r.comando !== 'string' || !CONDICOES[r.acende]) { erros.push('regra ignorada: ' + JSON.stringify(r)); continue; }
      regras.push({ regra: r, rx: globParaRegex(r.comando) });
    }
    for (const a of atribuicoes || []) {
      const f = a && a.fisico;
      if (!f || (f.tipo !== 'nota' && f.tipo !== 'cc') || deCamada.has(f.canal | 0) || (a.alvo !== 'A' && a.alvo !== 'B')) continue;
      const achada = regras.find((x) => x.rx.test(a.comando));
      if (!achada) continue;
      const chave = chaveDe(f);
      if (vistos.has(chave)) continue;
      vistos.add(chave);
      lista.push({ chave, alvo: a.alvo, comando: a.comando, regra: achada.regra });
    }
    return { lista, erros };
  }

  // leitura + endereços → {chave: velocidade 0–127}. A velocidade é o brilho da regra (nome em saidas.brilho).
  function estadoDosLeds(leitura, enderecos, brilho) {
    const b = Object.assign({}, BRILHO_PADRAO, brilho || {});
    const vel = (nome) => { const v = Number(b[nome]); return Number.isFinite(v) ? Math.max(0, Math.min(127, Math.round(v))) : 0; };
    const r = {};
    for (const e of enderecos || []) {
      const d = (leitura && leitura[e.alvo]) || {};
      const c = CONDICOES[e.regra.acende](d, e.comando, e.regra);
      const nome = typeof c === 'string' ? c : c ? e.regra.brilho || 'forte' : e.regra.vazio || e.regra.senao || 'apagado';
      r[e.chave] = vel(nome);
    }
    return r;
  }

  // O que mandar para sair de `enviado` e chegar em `atual`: [[chave, vel]]. LED que saiu do mapa (remapeado, mapa
  // desligado) apaga. `enviado` vazio = mandar tudo (reenvio ao religar a porta), apagados inclusive. Depois de
  // mandar, o que o aparelho mostra é `atual` (quem chama guarda uma cópia como o novo `enviado`).
  function diferencaDosLeds(enviado, atual) {
    const ant = enviado || {}, dif = [];
    for (const k of Object.keys(atual || {})) if (ant[k] !== atual[k]) dif.push([k, atual[k]]);
    for (const k of Object.keys(ant)) if (!(k in (atual || {})) && ant[k] !== 0) dif.push([k, 0]);
    return dif;
  }
  // chave 'nota:canal:numero' / 'cc:canal:numero' + velocidade → bytes para MIDIOutput.send.
  function mensagemDoLed(chave, vel) {
    const m = /^(nota|cc):(\d+):(\d+)$/.exec(chave);
    if (!m) return null;
    const canal = Number(m[2]) & 0x0F, numero = Number(m[3]) & 0x7F, v = Math.max(0, Math.min(127, vel | 0));
    return [(m[1] === 'nota' ? 0x90 : 0xB0) | canal, numero, v];
  }

  return { BRILHO_PADRAO, CONDICOES_NOMES, enderecosDosLeds, estadoDosLeds, diferencaDosLeds, mensagemDoLed };
});
