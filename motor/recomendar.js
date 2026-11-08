// VbMx — motor de recomendação, primeiro corte (VB-03 reduzido, decisão do Lucas em 2026-10-24;
// janela de BPM de ±15% e ordem por ΔBPM por decisão dele em 2026-10-25).
//
// Dada a faixa que está tocando, lista TODAS as faixas da biblioteca que podem ser mixadas
// harmonicamente com ela, só por tonalidade (roda de Camelot) e BPM. Estilo e momento da
// festa ficam para depois (VB-05).
//
// JavaScript puro, sem dependência. Roda no navegador (<script src="motor/recomendar.js">
// expõe `VbMxMotor`) e no Node (`require('./motor/recomendar.js')`).
//
// Formato de faixa: { id, bpm: número > 0, camelot: '1A'..'12B' } — outros campos passam
// adiante intocados. Faixa sem BPM ou tom válido é excluída e contada, nunca quebra.
//
// Relações harmônicas aceitas (e só estas):
//   - "mesma casa"            — mesmo número e mesma letra (8A → 8A)            distância 0
//   - "±1 na roda"            — mesma letra, número vizinho, circular (12A ↔ 1A) distância 1
//   - "relativa maior/menor"  — mesmo número, letra trocada (8A ↔ 8B)           distância 1
// Fora de propósito: "energy boost" (+2 ou +7 na roda) e a diagonal (8A → 9B). São técnicas
// de transição que mudam o tom de propósito, não compatibilidade harmônica — o DJ usa por
// escolha, e o motor não deve oferecer como "compatível". Ficam em ## Possibilidades.
//
// BPM: compatível se |bpm/fator − bpmTocando| / bpmTocando ≤ 15%, para fator 1 (mesmo
// andamento), 2 (o candidato tem o dobro) ou 0,5 (o candidato tem a metade). O delta é
// medido na escala da faixa tocando, para que dobro/metade sejam comparáveis com o resto.
// Os 15% são o alcance do pitch dos decks (motor/pitch.js): o que cabe na janela dá para
// igualar no SYNC.
//
// Ordem: menor |ΔBPM| primeiro, depois distância na roda (mesma casa antes), depois andamento
// direto antes de dobro/metade, depois id — determinística.

(function (raiz, fabrica) {
  const api = fabrica();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.VbMxMotor = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const JANELA_BPM = 0.15;
  const EPSILON = 1e-9; // a borda de ±15% é inclusiva; o epsilon absorve erro de ponto flutuante

  const FATORES = [
    { fator: 1, razao: 'mesmo andamento' },
    { fator: 2, razao: 'dobro do BPM' },
    { fator: 0.5, razao: 'metade do BPM' },
  ];

  // '8A', '08a', ' 12B ' → { numero: 8, letra: 'A' }; qualquer outra coisa → null.
  function lerCamelot(valor) {
    if (typeof valor !== 'string') return null;
    const m = /^\s*(\d{1,2})\s*([AaBb])\s*$/.exec(valor);
    if (!m) return null;
    const numero = Number(m[1]);
    if (numero < 1 || numero > 12) return null;
    return { numero, letra: m[2].toUpperCase() };
  }

  function bpmValido(bpm) {
    return typeof bpm === 'number' && Number.isFinite(bpm) && bpm > 0;
  }

  function faixaValida(faixa) {
    return !!faixa && bpmValido(faixa.bpm) && lerCamelot(faixa.camelot) !== null;
  }

  // Distância circular entre dois números da roda (1..12): 12 ↔ 1 é 1.
  function passosNaRoda(a, b) {
    const d = Math.abs(a - b) % 12;
    return Math.min(d, 12 - d);
  }

  // Relação harmônica entre dois tons Camelot, ou null se não forem compatíveis.
  function relacaoCamelot(tomA, tomB) {
    const a = lerCamelot(tomA);
    const b = lerCamelot(tomB);
    if (!a || !b) return null;
    const passos = passosNaRoda(a.numero, b.numero);
    if (a.letra === b.letra) {
      if (passos === 0) return { relacao: 'mesma casa', distancia: 0 };
      if (passos === 1) return { relacao: '±1 na roda', distancia: 1 };
      return null;
    }
    if (passos === 0) return { relacao: 'relativa maior/menor', distancia: 1 };
    return null;
  }

  // Encaixe de BPM, ou null se nenhum fator cai na janela. Entre fatores que cabem, fica o
  // de menor diferença (com 15% de janela, só um cabe de cada vez — mas não dependemos disso).
  function encaixeBpm(bpmTocando, bpmCandidato) {
    if (!bpmValido(bpmTocando) || !bpmValido(bpmCandidato)) return null;
    let melhor = null;
    for (const { fator, razao } of FATORES) {
      const equivalente = bpmCandidato / fator;
      const delta = equivalente - bpmTocando;
      const deltaPct = delta / bpmTocando;
      if (Math.abs(deltaPct) > JANELA_BPM + EPSILON) continue;
      if (!melhor || Math.abs(delta) < Math.abs(melhor.delta)) {
        melhor = { fator, razao, delta, deltaPct };
      }
    }
    return melhor;
  }

  function formatarDelta(encaixe) {
    const sinal = encaixe.delta >= 0 ? '+' : '−';
    const bpm = Math.abs(encaixe.delta).toFixed(1).replace('.', ',');
    const pct = (Math.abs(encaixe.deltaPct) * 100).toFixed(1).replace('.', ',');
    return `${sinal}${bpm} BPM (${sinal}${pct}%)`;
  }

  // A função do primeiro corte: todas as faixas da biblioteca mixáveis com `tocando`.
  // Devolve { compativeis: [...], contagem: { total, compativeis, incompativeis, invalidas } }
  // e, se a própria faixa tocando for inválida, `erro` com o motivo e lista vazia.
  function compativeis(tocando, biblioteca) {
    const lista = Array.isArray(biblioteca) ? biblioteca : [];
    const contagem = { total: 0, compativeis: 0, incompativeis: 0, invalidas: 0 };

    if (!faixaValida(tocando)) {
      for (const f of lista) {
        if (f === tocando) continue;
        contagem.total += 1;
        if (!faixaValida(f)) contagem.invalidas += 1;
      }
      return { compativeis: [], contagem, erro: 'a faixa tocando não tem BPM ou tom Camelot válido' };
    }

    const saida = [];
    for (const faixa of lista) {
      if (faixa === tocando || (faixa && tocando.id !== undefined && faixa.id === tocando.id)) continue;
      contagem.total += 1;
      if (!faixaValida(faixa)) { contagem.invalidas += 1; continue; }

      const casa = relacaoCamelot(tocando.camelot, faixa.camelot);
      const bpm = casa && encaixeBpm(tocando.bpm, faixa.bpm);
      if (!casa || !bpm) { contagem.incompativeis += 1; continue; }

      const motivos = [casa.relacao, bpm.fator === 1 ? formatarDelta(bpm) : `${bpm.razao}, ${formatarDelta(bpm)}`];
      saida.push({ faixa, casa, bpm, motivo: motivos.join(' · ') });
    }

    saida.sort((x, y) =>
      Math.abs(x.bpm.delta) - Math.abs(y.bpm.delta)
      || x.casa.distancia - y.casa.distancia
      || (x.bpm.fator === 1 ? 0 : 1) - (y.bpm.fator === 1 ? 0 : 1)
      || String(x.faixa.id).localeCompare(String(y.faixa.id)));

    contagem.compativeis = saida.length;
    return { compativeis: saida, contagem };
  }

  return { compativeis, relacaoCamelot, encaixeBpm, lerCamelot, faixaValida, JANELA_BPM };
});
