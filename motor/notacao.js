// ===================== VbMxNotacao — notação de tom: conversões puras entre notações (VB-42) =====================
// Lógica pura (UMD), testada em Node por motor/testar-tom.js. O motor de sugestão segue em Camelot;
// as outras notações só existem na borda (exibir e gravar). Tabela: docs/formatos.md §5.
//
// Notações: 'camelot' ("8A"), 'aberto' (círculo aberto: número + d maior / m menor, "1m"),
// 'musical' ("Am", "Eb", "F#m"), 'sustenidos' (musical só com sustenidos: "A#m", "D#").
// Índice interno 0–23 = MUSICAL_KEY: 0–11 maiores a partir de dó, 12–23 menores a partir de dó.
// Camelot: dó maior = 8B, lá menor = 8A. Círculo aberto = Camelot deslocado 7 casas: 8B = 1d, 8A = 1m.
(function (raiz, fabrica) {
  const api = fabrica(raiz);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.VbMxNotacao = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const NOTACOES = ['camelot', 'aberto', 'musical', 'sustenidos'];
  const ROTULOS = { camelot: 'Camelot (8A)', aberto: 'Círculo aberto (1m)', musical: 'Musical (Am, Eb)', sustenidos: 'Musical, só sustenidos (Am, D#)' };
  const NOMES_BEMOL = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
  const NOMES_SUST = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const CLASSE_DA_LETRA = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

  const modulo = (n, m) => ((n % m) + m) % m;

  // índice 0–23 → { numero (Camelot 1–12), letra 'A'|'B' }
  function indiceParaCamelot(n) {
    if (!Number.isInteger(n) || n < 0 || n > 23) return null;
    const menor = n >= 12, classe = n % 12;
    return { numero: modulo((menor ? 4 : 7) + 7 * classe, 12) + 1, letra: menor ? 'A' : 'B' };
  }
  function camelotParaIndice(texto) {
    const m = /^\s*(\d{1,2})\s*([AaBb])\s*$/.exec(String(texto == null ? '' : texto));
    if (!m || Number(m[1]) < 1 || Number(m[1]) > 12) return null;
    const menor = m[2].toUpperCase() === 'A';
    return modulo((Number(m[1]) - 1 - (menor ? 4 : 7)) * 7, 12) + (menor ? 12 : 0);   // 7·7 ≡ 1 (mod 12)
  }

  // Lê qualquer notação suportada (detectada pelo texto) → índice 0–23 ou null.
  // "8A"/"8B" é Camelot; "1d"/"1m" é círculo aberto; "Am", "Eb", "G#min" é musical.
  function lerTom(texto) {
    if (typeof texto !== 'string') return null;
    const t = texto.trim();
    if (/^\d{1,2}\s*[AaBb]$/.test(t)) return camelotParaIndice(t);
    let m = /^(\d{1,2})\s*([dDmM])$/.exec(t);
    if (m) {
      const num = Number(m[1]);
      if (num < 1 || num > 12) return null;
      const menor = m[2].toLowerCase() === 'm';
      return camelotParaIndice(`${modulo(num - 1 + 7, 12) + 1}${menor ? 'A' : 'B'}`);   // aberto → Camelot: +7 casas
    }
    m = /^([A-Ga-g])\s*([#♯b♭]?)\s*(maj|major|min|minor|m|M)?$/.exec(t);
    if (m) {
      let classe = CLASSE_DA_LETRA[m[1].toUpperCase()];
      if (m[2] === '#' || m[2] === '♯') classe += 1;
      else if (m[2] === 'b' || m[2] === '♭') classe -= 1;
      const suf = m[3] || '';
      const menor = suf === 'm' || suf.toLowerCase() === 'min' || suf.toLowerCase() === 'minor';
      return modulo(classe, 12) + (menor ? 12 : 0);
    }
    return null;
  }

  // índice → texto na notação. Notação desconhecida → Camelot; índice inválido → null.
  function formatarIndice(n, notacao) {
    const c = indiceParaCamelot(n);
    if (!c) return null;
    const menor = n >= 12, classe = n % 12;
    if (notacao === 'aberto') return `${modulo(c.numero - 1 - 7, 12) + 1}${menor ? 'm' : 'd'}`;
    if (notacao === 'musical') return NOMES_BEMOL[classe] + (menor ? 'm' : '');
    if (notacao === 'sustenidos') return NOMES_SUST[classe] + (menor ? 'm' : '');
    return `${c.numero}${c.letra}`;
  }

  // Converte de qualquer notação reconhecida para `notacao`. Ilegível → null.
  function converter(texto, notacao) {
    const n = lerTom(texto);
    return n === null ? null : formatarIndice(n, notacao);
  }

  // Camelot ('8A') → texto exibido na notação. Ilegível → o texto como veio (nunca esconde dado).
  function exibir(camelot, notacao) {
    const t = converter(camelot, notacao);
    return t === null ? (camelot == null ? '' : String(camelot)) : t;
  }

  return { NOTACOES, ROTULOS, indiceParaCamelot, camelotParaIndice, lerTom, formatarIndice, converter, exibir };
});
