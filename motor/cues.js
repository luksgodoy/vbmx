// ===================== VbMxCues — hot cues: 8 por faixa, tipo, cor, nome =====================
// Dono: VB-14 (onda 1). Lógica pura (UMD), testada em Node por motor/testar-cues.js.
// Estado imutável de UMA faixa: { cue, hotcues } — `cue` é o cue principal (s) e `hotcues` tem 8
// posições, cada uma null ou { t, tipo, cor?, nome?, fim? }. Tempos em s da faixa. Toda função devolve
// um estado novo; nada aqui toca em DOM, áudio ou disco (a persistência é biblioteca/marcadores.js).
//   vazio()                          estado sem nada
//   normalizar(reg, duracao?)        valida o que veio do disco: descarta o torto, trava em 0…duração
//   definir(reg, slot, t, opc?, dur) grava/regrava o slot (opc: tipo, cor, nome, fim)
//   apagar(reg, slot)  mover(reg, de, para)  trocarTipo(reg, slot, tipo?)  nomear(reg, slot, nome)
//   definirCue(reg, t, dur?)         muda o cue principal
//   acionar(reg, slot, {apagar, tipo, posicao, duracao, loop, quantizar})
//                                    a regra do clique: vazio define (com `loop` ativo guarda o loop; `quantizar` é t=>t) ·
//                                    cheio salta (tipo loop devolve também `loop`) · Shift apaga
//   ordenados  vizinho(reg,t,dir)  proximoLivre  armazenar(reg,t,{tipo,loop,quantizar},dur)  formatarTempo(t)
//                                    lista de cues: anterior/próximo, STORE no próximo livre, mm:ss.mmm
//   pontoDeLoad(reg)                 s do 1º marcador tipo "load", ou null
//   corDe(h)  visiveis(reg, inicio, fim)  vazioDeVerdade(reg)
//   efeitoDeApertar(r, tocando)      o que a interface faz com o resultado de acionar: parado, o hotcue age como CUE
//                                    (salta e toca em prévia enquanto apertado); tocando, só salta
//   efeitoDeSoltar(reg, slot, tocando)   ao soltar a prévia: para, volta ao ponto (e solta o loop da prévia)
//   CUE_FLUTUANTE  cueFlutuante(reg, dur)  o cue principal do deck: tipo e cor próprios (branco), fora dos 8 slots
//   loopsGuardados(reg)              os hotcues tipo loop, em ordem de início: [{ slot, inicio, fim }]
(function (raiz, fabrica) {
  const api = fabrica(raiz);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.VbMxCues = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const SLOTS = 8;
  // Cor por tipo, como no Traktor: cue azul, fade laranja, load amarelo, grid branco, loop verde.
  const TIPOS = {
    'cue':      { rotulo: 'Cue',      cor: '#4aa3ff' },
    'fade-in':  { rotulo: 'Fade in',  cor: '#ff9a3c' },
    'fade-out': { rotulo: 'Fade out', cor: '#ff9a3c' },
    'load':     { rotulo: 'Load',     cor: '#f2d84a' },
    'grid':     { rotulo: 'Grid',     cor: '#f4f4f4' },
    'loop':     { rotulo: 'Loop',     cor: '#5fd67a' },
  };
  const ORDEM_TIPOS = Object.keys(TIPOS);
  // O cue principal do deck (o botão CUE, spec §5) é "flutuante": branco, distinto de qualquer hotcue (a grade é
  // #f4f4f4, e só existe em slot). Não entra em TIPOS: não é um dos 8 slots nem gira no Alt+clique.
  const CUE_FLUTUANTE = { tipo: 'flutuante', rotulo: 'Cue flutuante', cor: '#ffffff' };
  const ehNum = x => typeof x === 'number' && isFinite(x);
  const trava = (t, dur) => { const v = ehNum(t) ? Math.max(0, t) : 0; return dur > 0 ? Math.min(v, dur) : v; };
  const slotValido = s => Number.isInteger(s) && s >= 0 && s < SLOTS;
  const corValida = c => typeof c === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(c);

  function vazio() { return { cue: 0, hotcues: new Array(SLOTS).fill(null) }; }

  function limparHotcue(h, dur) {
    if (!h || typeof h !== 'object' || !ehNum(h.t) || h.t < 0) return null;
    const o = { t: trava(h.t, dur), tipo: TIPOS[h.tipo] ? h.tipo : 'cue' };
    if (corValida(h.cor)) o.cor = h.cor;
    if (typeof h.nome === 'string' && h.nome) o.nome = h.nome.slice(0, 40);
    if (ehNum(h.fim) && h.fim > o.t) o.fim = trava(h.fim, dur);
    return o;
  }
  function normalizar(reg, dur) {
    const r = vazio();
    if (!reg || typeof reg !== 'object') return r;
    r.cue = trava(reg.cue, dur);
    if (Array.isArray(reg.hotcues)) for (let i = 0; i < SLOTS; i++) r.hotcues[i] = limparHotcue(reg.hotcues[i], dur);
    return r;
  }
  function comSlot(reg, slot, h) {
    const hotcues = reg.hotcues.slice(); hotcues[slot] = h;
    return { cue: reg.cue, hotcues };
  }
  function definir(reg, slot, t, opc, dur) {
    if (!slotValido(slot)) return reg;
    const h = ehNum(t) ? limparHotcue({ tipo: 'cue', ...(opc || {}), t: trava(t, dur) }, dur) : null;
    return h ? comSlot(reg, slot, h) : reg;
  }
  function apagar(reg, slot) { return slotValido(slot) && reg.hotcues[slot] ? comSlot(reg, slot, null) : reg; }
  // MAP: leva o hotcue de um slot para outro; se o destino está ocupado, trocam de lugar.
  function mover(reg, de, para) {
    if (!slotValido(de) || !slotValido(para) || de === para || !reg.hotcues[de]) return reg;
    const hotcues = reg.hotcues.slice();
    hotcues[para] = reg.hotcues[de]; hotcues[de] = reg.hotcues[para];
    return { cue: reg.cue, hotcues };
  }
  // Sem `tipo` gira para o próximo da ordem (cue → fade-in → … → loop → cue). A cor própria sai, a do tipo volta.
  function trocarTipo(reg, slot, tipo) {
    const h = slotValido(slot) && reg.hotcues[slot];
    if (!h) return reg;
    const novo = TIPOS[tipo] ? tipo : ORDEM_TIPOS[(ORDEM_TIPOS.indexOf(h.tipo) + 1) % ORDEM_TIPOS.length];
    const { cor, ...resto } = h;
    return comSlot(reg, slot, { ...resto, tipo: novo });
  }
  function nomear(reg, slot, nome) {
    const h = slotValido(slot) && reg.hotcues[slot];
    if (!h) return reg;
    const { nome: _, ...resto } = h;
    return comSlot(reg, slot, nome ? limparHotcue({ ...resto, nome }) : resto);
  }
  function definirCue(reg, t, dur) { return { cue: trava(t, dur), hotcues: reg.hotcues }; }

  // A regra do clique num slot. Devolve { acao: 'definir' | 'saltar' | 'apagar' | 'tipo' | 'nada', reg, t? }.
  //   apagar (Shift ou botão)  → apaga se cheio, 'nada' se vazio
  //   vazio                    → define em `posicao` com `tipo` (padrão cue)
  //   cheio                    → 'saltar' para h.t (tocando: pula e segue; parado: prévia — decide a interface)
  function acionar(reg, slot, o) {
    o = o || {};
    if (!slotValido(slot)) return { acao: 'nada', reg };
    const h = reg.hotcues[slot];
    if (o.apagar) return h ? { acao: 'apagar', reg: apagar(reg, slot) } : { acao: 'nada', reg };
    if (o.trocarTipo) return h ? { acao: 'tipo', reg: trocarTipo(reg, slot) } : { acao: 'nada', reg };
    if (h) {
      const r = { acao: 'saltar', reg, t: trava(h.t, o.duracao) };
      if (h.tipo === 'loop' && ehNum(h.fim)) r.loop = { inicio: r.t, fim: trava(h.fim, o.duracao) };   // o loop volta
      return r;
    }
    // Slot vazio com loop ativo guarda o loop (verde, com início e fim); sem loop, um ponto do tipo escolhido.
    const lp = o.loop && ehNum(o.loop.inicio) && ehNum(o.loop.fim) && o.loop.fim > o.loop.inicio ? o.loop : null;
    const q = typeof o.quantizar === 'function' ? o.quantizar : x => x;
    const novo = lp ? definir(reg, slot, q(lp.inicio), { tipo: 'loop', fim: lp.fim }, o.duracao)
                    : definir(reg, slot, ehNum(o.posicao) ? q(o.posicao) : o.posicao, { tipo: o.tipo }, o.duracao);
    return { acao: 'definir', reg: novo, t: novo.hotcues[slot].t };
  }

  // ---- lista de cues (página CUE): navegar, formatar, STORE ----
  function ordenados(reg) {
    const r = [];
    reg.hotcues.forEach((h, i) => { if (h) r.push({ slot: i, ...h }); });
    return r.sort((a, b) => a.t - b.t || a.slot - b.slot);
  }
  // Slot do hotcue anterior/seguinte (dir -1/+1) a partir do tempo `t`; null se não há. O que está em t não conta.
  function vizinho(reg, t, dir) {
    const l = ordenados(reg), eps = 1e-6;
    const c = dir < 0 ? l.filter(h => h.t < t - eps).pop() : l.find(h => h.t > t + eps);
    return c ? c.slot : null;
  }
  function proximoLivre(reg) { const i = reg.hotcues.findIndex(h => !h); return i < 0 ? null : i; }
  // STORE: grava no próximo slot livre (loop ativo vira loop). Cheio: devolve { slot: null }.
  function armazenar(reg, t, opc, dur) {
    const slot = proximoLivre(reg);
    if (slot === null) return { reg, slot: null };
    const o = opc || {}, lp = o.loop && o.loop.fim > o.loop.inicio ? o.loop : null;
    const q = typeof o.quantizar === 'function' ? o.quantizar : x => x;
    const novo = lp ? definir(reg, slot, q(lp.inicio), { tipo: 'loop', fim: lp.fim }, dur)
                    : definir(reg, slot, ehNum(t) ? q(t) : t, { tipo: o.tipo }, dur);
    return novo === reg ? { reg, slot: null } : { reg: novo, slot };
  }
  // mm:ss.mmm
  function formatarTempo(t) {
    const ms = Math.round(Math.max(0, ehNum(t) ? t : 0) * 1000), m = Math.floor(ms / 60000), s = Math.floor(ms % 60000 / 1000);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
  }

  function pontoDeLoad(reg) { const h = reg.hotcues.find(x => x && x.tipo === 'load'); return h ? h.t : null; }
  function corDe(h) { return h ? (h.cor || TIPOS[h.tipo].cor) : null; }
  // Os hotcues cujo tempo cai em [inicio, fim], com o número do slot (1–8) para desenhar.
  function visiveis(reg, inicio, fim) {
    const r = [];
    reg.hotcues.forEach((h, i) => { if (h && h.t >= inicio && h.t <= fim) r.push({ slot: i, numero: i + 1, ...h, cor: corDe(h) }); });
    return r;
  }
  // O cue principal como marcador desenhável: { t, tipo, rotulo, cor }.
  function cueFlutuante(reg, dur) { return { t: trava(reg && reg.cue, dur), tipo: CUE_FLUTUANTE.tipo, rotulo: CUE_FLUTUANTE.rotulo, cor: CUE_FLUTUANTE.cor }; }
  // Loops guardados (hotcues tipo loop com fim), por ordem de início.
  function loopsGuardados(reg) {
    return ordenados(reg).filter(h => h.tipo === 'loop' && ehNum(h.fim) && h.fim > h.t).map(h => ({ slot: h.slot, inicio: h.t, fim: h.fim }));
  }

  // Efeito do clique num hotcue, dado o resultado de acionar (r) e se o deck toca. Só 'saltar' mexe na cabeça:
  // sempre busca o ponto; parado, também toca e fica em prévia (segurar toca, soltar volta e para). Loop vem junto.
  function efeitoDeApertar(r, tocando) {
    if (!r || r.acao !== 'saltar') return { buscar: null, tocar: false, previa: false, loop: null };
    return { buscar: r.t, tocar: !tocando, previa: !tocando, loop: r.loop || null };
  }
  // Soltar o botão: sem prévia (slot < 0) não faz nada. Com prévia: para o deck, volta ao ponto do hotcue
  // e, se era de loop, solta o loop que a prévia ligou.
  function efeitoDeSoltar(reg, slot, tocando) {
    const h = slotValido(slot) && reg && reg.hotcues[slot];
    if (!slotValido(slot)) return { pausar: false, buscar: null, soltarLoop: false };
    return { pausar: !!tocando, buscar: h ? h.t : null, soltarLoop: !!(h && h.tipo === 'loop') };
  }
  function vazioDeVerdade(reg) { return !(reg.cue > 0) && reg.hotcues.every(h => !h); }

  return { SLOTS, TIPOS, CUE_FLUTUANTE, cueFlutuante, loopsGuardados, efeitoDeApertar, efeitoDeSoltar, ORDEM_TIPOS, vazio, normalizar, definir, apagar, mover, trocarTipo, nomear, definirCue,
    acionar, ordenados, vizinho, proximoLivre, armazenar, formatarTempo, pontoDeLoad, corDe, visiveis, vazioDeVerdade };
});
