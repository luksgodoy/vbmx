// ===================== VbMxFone — lógica pura do fone/PFL: MIX, VOL, mapa de canais (VB-23) =====================
// UMD, testada em Node por motor/testar-fone.js. Nada de Web Audio aqui: quem liga os nós é
// interface/js/cadeia.js (rotearSaida) e interface/js/saidas.js (tela e detecção do navegador).
// Spec §7 (Cue/fone): cada canal tem botão de cue; no canal de fone há VOL e MIX — MIX todo à esquerda
// (anti-horário) só a faixa em cue, todo à direita (horário) só a mixagem principal.
(function (raiz, fabrica) {
  const api = fabrica(raiz);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.VbMxFone = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const CANAIS = ['A', 'B'];
  const LIMITES = Object.freeze({ vol: [0, 100], mix: [-100, 100] });
  const CANAIS_PARA_MULTICANAL = 4;   // master em 1/2, fone em 3/4
  const MODOS_SAIDA = Object.freeze(['auto', 'dividido']);

  function travar(campo, v) {
    const [min, max] = LIMITES[campo];
    const n = Number(v);
    if (!Number.isFinite(n)) return campo === 'mix' ? 0 : min;
    return Math.min(max, Math.max(min, Math.round(n)));
  }
  // Estado do fone: cue por canal, VOL 0…100, MIX −100 (só cue) … +100 (só principal), preferência de saída.
  function estadoPadrao() { return { cue: { A: false, B: false }, vol: 70, mix: 0, saida: 'auto' }; }
  function normalizar(e) {
    const p = estadoPadrao(), s = e || {};
    return { cue: { A: !!(s.cue && s.cue.A), B: !!(s.cue && s.cue.B) }, vol: s.vol === undefined ? p.vol : travar('vol', s.vol),
      mix: s.mix === undefined ? p.mix : travar('mix', s.mix), saida: MODOS_SAIDA.includes(s.saida) ? s.saida : p.saida };
  }
  // Cada canal liga e desliga o seu cue; os dois podem soar juntos.
  function alternarCue(estado, letra) {
    if (!CANAIS.includes(letra)) throw new Error(`VbMxFone.alternarCue: canal inválido "${letra}"`);
    const e = normalizar(estado); e.cue[letra] = !e.cue[letra]; return e;
  }
  function definirCue(estado, letra, ligado) {
    if (!CANAIS.includes(letra)) throw new Error(`VbMxFone.definirCue: canal inválido "${letra}"`);
    const e = normalizar(estado); e.cue[letra] = !!ligado; return e;
  }
  // MIX → ganho de cada lado. No centro os dois soam inteiros; cada lado some linearmente até o extremo.
  function ganhosMix(mix) {
    const m = travar('mix', mix);
    return { cue: m <= 0 ? 1 : (100 - m) / 100, principal: m >= 0 ? 1 : (100 + m) / 100 };
  }
  // VOL 0…100 → ganho (curva quadrática: mais resolução na faixa baixa).
  function ganhoVol(vol) { const v = travar('vol', vol) / 100; return v * v; }
  // Resumo para a cadeia aplicar de uma vez.
  function ganhosDoFone(estado) {
    const e = normalizar(estado), g = ganhosMix(e.mix);
    return { cue: { A: e.cue.A ? 1 : 0, B: e.cue.B ? 1 : 0 }, ganhoCue: g.cue, ganhoPrincipal: g.principal, vol: ganhoVol(e.vol) };
  }

  // Plano de saída a partir de destination.maxChannelCount e da preferência.
  //   multicanal  4+ canais: master em 1/2, fone em 3/4 (ChannelMerger de 4 entradas)
  //   dividido    qualquer saída: fone mono no canal esquerdo, master mono no direito (escolha explícita)
  //   desligado   sem saída extra e sem o modo dividido: o fone fica desabilitado e `motivo` diz por quê
  // `ligacoes` descreve as entradas do ChannelMerger: {fonte:'master'|'fone', canal: 0|1|null (null = soma mono), entrada}.
  function planoSaida(maxCanais, preferencia) {
    const n = Math.floor(Number(maxCanais)) || 0;
    const pref = MODOS_SAIDA.includes(preferencia) ? preferencia : 'auto';
    if (pref === 'dividido') {
      return { modo: 'dividido', canaisDestino: 2, maxCanais: n, motivo: 'Fone no canal esquerdo e master (em mono) no direito.',
        ligacoes: [{ fonte: 'fone', canal: null, entrada: 0 }, { fonte: 'master', canal: null, entrada: 1 }] };
    }
    if (n >= CANAIS_PARA_MULTICANAL) {
      return { modo: 'multicanal', canaisDestino: CANAIS_PARA_MULTICANAL, maxCanais: n, motivo: 'Master nas saídas 1/2 e fone nas saídas 3/4.',
        ligacoes: [{ fonte: 'master', canal: 0, entrada: 0 }, { fonte: 'master', canal: 1, entrada: 1 },
          { fonte: 'fone', canal: 0, entrada: 2 }, { fonte: 'fone', canal: 1, entrada: 3 }] };
    }
    return { modo: 'desligado', canaisDestino: 2, maxCanais: n, ligacoes: [],
      motivo: `Fone desabilitado: esta saída tem ${n || 'nenhum'} canal(is) e o fone precisa de ${CANAIS_PARA_MULTICANAL} (master em 1/2, fone em 3/4). Escolha outra saída de áudio ou use "fone à esquerda, master à direita".` };
  }

  return { CANAIS, LIMITES, CANAIS_PARA_MULTICANAL, MODOS_SAIDA, travar, estadoPadrao, normalizar, alternarCue, definirCue,
    ganhosMix, ganhoVol, ganhosDoFone, planoSaida };
});
