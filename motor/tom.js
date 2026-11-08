// ===================== VbMxTom — tom resultante: casa Camelot após o pitch, semitons e cents =====================
// Dono: VB-12 (onda 1). Lógica pura (UMD), testada em Node por motor/testar-tom.js.
//
// Sem key lock, o pitch muda a velocidade e o tom juntos: pitch % → 12·log2(1 + pitch/100) semitons.
// O tom resultante é o semitom INTEIRO mais próximo (a casa Camelot) mais o desvio em cents
// (−50 … +50), como o "Resulting Key" do Traktor. Na roda de Camelot, +1 semitom = +7 casas
// (mesma letra), porque a roda anda em quintas: 8A (Lá menor) + 1 semitom = 3A (Si♭ menor).
//
// Empate exato (±0,5 semitom): arredonda para longe do zero (+0,5 → +1, −0,5 → −1).
// Com key lock ligado o tom NÃO muda (decisão P3b de 2026-10-25): `tomEfetivo(..., {keyLock:true})`.
// VB-38 (spec §1): o key lock tem dois modos (preferência) — "normal" vale em toda a faixa de velocidade;
// "scratch" desliga abaixo de −30% e acima de +50% de velocidade (nas bordas exatas ainda vale). O knob
// KEY soma semitons INTEIROS (−12…+12) ao tom, sem mudar o tempo: `{semitons}` nas opções.
//   keyLockAtivo(ligado, modo, taxa)   o key lock vale agora? (taxa 1 = original; 0,7 = −30%)
//   opções de tomEfetivo/faixaEfetiva: {keyLock, modo ('normal' | 'scratch'), semitons (KEY)}
(function (raiz, fabrica) {
  const api = fabrica(raiz);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.VbMxTom = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const CASAS_POR_SEMITOM = 7;
  const EPSILON = 1e-9;
  const MODOS_KEY_LOCK = ['normal', 'scratch'];
  const LIMITES_SCRATCH = { min: -30, max: 50 };   // % de velocidade fora dos quais o modo scratch solta o tom
  const LIMITE_KEY = 12;                           // knob KEY: ±12 semitons

  function lerCamelot(valor) {
    if (typeof valor !== 'string') return null;
    const m = /^\s*(\d{1,2})\s*([AaBb])\s*$/.exec(valor);
    if (!m) return null;
    const numero = Number(m[1]);
    if (numero < 1 || numero > 12) return null;
    return { numero, letra: m[2].toUpperCase() };
  }

  // Semitons (fracionários) de tocar com `pitch` %. Pitch inválido ou ≤ −100 → 0.
  function semitonsDoPitch(pitch) {
    if (typeof pitch !== 'number' || !Number.isFinite(pitch) || pitch <= -100) return 0;
    return 12 * Math.log2(1 + pitch / 100);
  }

  // Arredonda para o inteiro mais próximo; empate vai para longe do zero.
  function arredondar(x) {
    return Math.sign(x) * Math.floor(Math.abs(x) + 0.5 + EPSILON) + 0;   // + 0 tira o -0
  }

  // Move uma casa Camelot ('8A') por `semitons` inteiros (+1 = +7 casas). Inválido → null.
  function transporCamelot(camelot, semitons) {
    const c = lerCamelot(camelot);
    if (!c || !Number.isInteger(semitons)) return null;
    const idx = (((c.numero - 1 + CASAS_POR_SEMITOM * semitons) % 12) + 12) % 12;
    return `${idx + 1}${c.letra}`;
  }

  // O key lock vale nesta velocidade? Desligado → false; modo "scratch" fora de [−30%, +50%] → false.
  // Modo desconhecido vale como "normal". Taxa inválida conta como 1.
  function keyLockAtivo(ligado, modo, taxa) {
    if (!ligado) return false;
    if (modo !== 'scratch') return true;
    const t = typeof taxa === 'number' && Number.isFinite(taxa) && taxa > 0 ? taxa : 1;
    const pct = (t - 1) * 100;
    return pct >= LIMITES_SCRATCH.min - EPSILON && pct <= LIMITES_SCRATCH.max + EPSILON;
  }

  // Semitons do knob KEY: inteiro em ±12; inválido → 0.
  function limitarKey(st) {
    if (typeof st !== 'number' || !Number.isFinite(st)) return 0;
    return Math.max(-LIMITE_KEY, Math.min(LIMITE_KEY, Math.round(st))) + 0;
  }

  // O tom resultante. Devolve { camelot, original, semitons (fracionário), deslocamento (inteiro),
  // cents (−50…+50, inteiro), mudou (a casa trocou), keyLock (valeu nesta velocidade), key (semitons do
  // KEY) } ou null se o Camelot for inválido. semitons = (key lock valendo ? 0 : os do pitch) + KEY.
  function tomEfetivo(camelot, pitch, opcoes) {
    const c = lerCamelot(camelot);
    if (!c) return null;
    const o = opcoes || {};
    const original = `${c.numero}${c.letra}`;
    const taxa = typeof pitch === 'number' && Number.isFinite(pitch) && pitch > -100 ? 1 + pitch / 100 : 1;
    const keyLock = keyLockAtivo(!!o.keyLock, o.modo, taxa);
    const key = limitarKey(o.semitons);
    const semitons = (keyLock ? 0 : semitonsDoPitch(pitch)) + key;
    const deslocamento = arredondar(semitons);
    const cents = Math.round((semitons - deslocamento) * 100) + 0;   // +0 evita −0
    const resultante = transporCamelot(original, deslocamento);
    return { camelot: resultante, original, semitons, deslocamento, cents, mudou: resultante !== original, keyLock, key };
  }

  // "+1 st +12¢" / "0 st" — texto curto para o deck.
  function formatarDesvio(tom) {
    if (!tom) return '';
    const sinal = (n) => (n > 0 ? '+' : n < 0 ? '−' : '');
    const partes = [`${sinal(tom.deslocamento)}${Math.abs(tom.deslocamento)} st`];
    if (tom.cents !== 0) partes.push(`${sinal(tom.cents)}${Math.abs(tom.cents)}¢`);
    return partes.join(' ');
  }

  // A faixa como ela SOA com `pitch` % (e o KEY/key lock das opções): cópia com camelot e bpm efetivos (o resto passa igual).
  // Sem pitch e sem mudança devolve a própria faixa. Faixa inválida volta como veio.
  function faixaEfetiva(faixa, pitch, opcoes) {
    if (!faixa || typeof faixa.bpm !== 'number' || !(faixa.bpm > 0)) return faixa;
    const tom = tomEfetivo(faixa.camelot, pitch, opcoes);
    if (!tom) return faixa;
    const razao = (typeof pitch === 'number' && Number.isFinite(pitch) && pitch > -100) ? 1 + pitch / 100 : 1;
    if (razao === 1 && !tom.mudou) return faixa;
    return Object.assign({}, faixa, { bpm: faixa.bpm * razao, camelot: tom.camelot, bpmOriginal: faixa.bpm, camelotOriginal: tom.original });
  }

  return { CASAS_POR_SEMITOM, MODOS_KEY_LOCK, LIMITES_SCRATCH, LIMITE_KEY, semitonsDoPitch, transporCamelot, keyLockAtivo, limitarKey,
    tomEfetivo, formatarDesvio, faixaEfetiva };
});
