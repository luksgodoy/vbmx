// VbMx — pitch e SYNC dos decks (decisão do Lucas em 2026-10-25: o BPM de uma faixa pode
// variar até 15% para mais ou para menos). Decisão de 2026-10-26: a faixa é POR DECK, ±8, ±15 ou ±50,
// padrão ±15 (`faixaDe`/`definirFaixa`); as funções aceitam `limite` opcional (sem ele, ±15).
//
// Lógica pura, sem DOM e sem áudio: a interface só pergunta e desenha. Roda no navegador
// (<script src="motor/pitch.js"> expõe `VbMxPitch`) e no Node (`require('./motor/pitch.js')`).
//
// Pitch é em PORCENTO (−15 … +15), como aparece no deck. BPM efetivo = bpm × (1 + pitch/100).
//
// SYNC: dado o BPM original do deck e o BPM efetivo do outro deck (já com o pitch dele),
// acha o pitch que iguala os dois. Considera também dobro e metade (o deck a 64 BPM
// sincroniza com 128). Entre os fatores que cabem na faixa (±15% por padrão), fica o de menor |pitch|. Se nenhum
// cabe, `ok: false` com o pitch que seria preciso (o menor em módulo) e o motivo — a interface
// avisa e NÃO mexe no pitch.

(function (raiz, fabrica) {
  const api = fabrica();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.VbMxPitch = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const LIMITE_PITCH = 15;  // o padrão da faixa, em porcento, para cada lado
  const FAIXAS = [8, 15, 50];
  const faixasDosDecks = {};  // letra → faixa escolhida; ausente = padrão
  const EPSILON = 1e-9;     // a borda de ±15% é inclusiva; o epsilon absorve erro de ponto flutuante

  const FATORES = [
    { fator: 1, razao: 'mesmo andamento' },
    { fator: 2, razao: 'dobro do BPM' },
    { fator: 0.5, razao: 'metade do BPM' },
  ];

  function bpmValido(bpm) {
    return typeof bpm === 'number' && Number.isFinite(bpm) && bpm > 0;
  }

  function pitchValido(pitch) {
    return typeof pitch === 'number' && Number.isFinite(pitch);
  }

  // Trava o pitch em ±15; valor inválido vira 0.
  function limiteValido(limite) {
    return FAIXAS.includes(limite) ? limite : LIMITE_PITCH;
  }

  // Faixa do pitch de um deck (8, 15 ou 50); sem escolha, 15.
  function faixaDe(letra) {
    return limiteValido(faixasDosDecks[letra]);
  }

  // Escolhe a faixa de um deck. Valor fora de 8/15/50 é erro (não adivinha).
  function definirFaixa(letra, faixa) {
    if (!FAIXAS.includes(faixa)) throw new Error(`faixa do pitch inválida: ${faixa} (use ${FAIXAS.join(', ')})`);
    faixasDosDecks[letra] = faixa;
    return faixa;
  }

  // Trava o pitch em ±limite (padrão 15); valor inválido vira 0.
  function limitarPitch(pitch, limite) {
    if (!pitchValido(pitch)) return 0;
    const L = limiteValido(limite);
    return Math.min(L, Math.max(-L, pitch));
  }

  function dentroDoLimite(pitch, limite) {
    return pitchValido(pitch) && Math.abs(pitch) <= limiteValido(limite) + EPSILON;
  }

  // BPM resultante de tocar `bpm` com `pitch` %. BPM inválido → null.
  function bpmEfetivo(bpm, pitch, limite) {
    if (!bpmValido(bpm)) return null;
    return bpm * (1 + limitarPitch(pitch, limite) / 100);
  }

  // Pitch (em %) para `bpmOrigem` soar igual a `bpmAlvo` × fator, sem travar.
  function pitchBruto(bpmOrigem, bpmAlvo, fator) {
    return ((bpmAlvo * fator) / bpmOrigem - 1) * 100;
  }

  // O cálculo do SYNC. Devolve:
  //   { ok: true,  pitch, fator, razao, bpmResultante }           — pode aplicar
  //   { ok: false, pitch, fator, razao, bpmResultante, motivo }   — não aplica; `pitch` é o
  //                                                                 que seria preciso
  //   { ok: false, motivo }                                        — entrada inválida
  function calcularSync(bpmOrigem, bpmAlvo, limite) {
    const L = limiteValido(limite);
    if (!bpmValido(bpmOrigem)) return { ok: false, motivo: 'o deck não tem BPM válido' };
    if (!bpmValido(bpmAlvo)) return { ok: false, motivo: 'o outro deck não tem BPM válido' };

    let melhor = null;
    for (const { fator, razao } of FATORES) {
      const pitch = pitchBruto(bpmOrigem, bpmAlvo, fator);
      if (!melhor || Math.abs(pitch) < Math.abs(melhor.pitch) - EPSILON) melhor = { pitch, fator, razao };
    }
    const bpmResultante = bpmOrigem * (1 + melhor.pitch / 100);
    if (dentroDoLimite(melhor.pitch, L)) {
      return { ok: true, pitch: melhor.pitch, fator: melhor.fator, razao: melhor.razao, bpmResultante };
    }
    return {
      ok: false, pitch: melhor.pitch, fator: melhor.fator, razao: melhor.razao, bpmResultante,
      motivo: `precisaria de ${formatarPitch(melhor.pitch)} — fora de ±${L}%`,
    };
  }

  // '+3,2%' / '−0,0%' — vírgula decimal, sinal sempre presente (0 vira '+0,0%').
  function formatarPitch(pitch, casas) {
    const p = pitchValido(pitch) ? pitch : 0;
    const sinal = p < 0 ? '−' : '+';
    return `${sinal}${Math.abs(p).toFixed(casas === undefined ? 1 : casas).replace('.', ',')}%`;
  }

  return { LIMITE_PITCH, FAIXAS, faixaDe, definirFaixa, limitarPitch, dentroDoLimite, bpmEfetivo, calcularSync, formatarPitch };
});
