// VbMx — beatgrid fixo: de BPM e 1ª batida para batida, compasso e quantize.
//
// Lógica pura (VB-11). Navegador: <script src="motor/grade.js"> expõe `VbMxGrade`; Node:
// `require('./motor/grade.js')`. Tempos em s DA FAIXA (do arquivo), não do relógio: a grade não
// muda com o pitch, só a velocidade com que a cabeça anda por ela.
//
// Grade: { bpm, primeira, periodo, porCompasso }   (periodo = 60 / bpm; porCompasso = 4)
// Sem grade analisada (o VB-13 traz a 1ª batida da análise), a grade sai do BPM com a 1ª batida
// em 0 ou no cue — loops e beatjump funcionam já na onda 1 e ficam exatos quando a análise chegar.
//
// API:
//   gradeDeBpm(bpm, primeiraBatida = 0, porCompasso = 4)   grade | null (BPM inválido)
//   daFaixa(faixa, reserva = 0)       faixa.grade ({bpm, primeira}) se houver, senão gradeDeBpm(faixa.bpm, reserva)
//   batidaEm(grade, t)                número da batida em t, com fração (0 = 1ª batida; antes dela é negativo)
//   tempoDaBatida(grade, n)           s da batida n (n pode ter fração)
//   quantizar(grade, t)               s da batida inteira mais próxima de t
//   compasso(grade, t)                { compasso, batida, fase }: compasso 1, 2…; batida 1…porCompasso; fase 0…1
//   batidasEntre(grade, de, ate)      s de cada batida inteira em [de, ate] (para desenhar a grade)
// Edição (VB-39, spec §3) — todas puras, devolvem grade nova ou null/mesma grade se o pedido não vale:
//   tap(estado, t)                    estado do TAP após um toque em t (s do relógio): { toques, bpm }; bpm só após a 4ª batida
//   comBpm(grade, bpm)                BPM digitado, mantendo a batida 1 no lugar
//   passoBpm(grade, delta)            aumentar/diminuir BPM em passo pequeno (PASSO_BPM = 0,01)
//   marcadorEm(grade, t, bpm)         define o marcador de grade em t: t é a batida 1 do compasso (recuada por compassos
//                                     inteiros até o 1º compasso da faixa, primeira em [0, porCompasso·período))
//   autoGrid(analise, grade, t)       AUTO grid: BPM da análise, marcador (batida 1) na batida mais próxima de t; null sem análise
//   recalcular(analise)               RESET: volta à grade da análise; null sem análise
//   travado(faixa)                    true se a análise está travada (bloqueia toda edição)
// Tick e marcador inicial (VB-13b, spec §3):
//   ticksAgendaveis(grade, est, de, ate)  batidas que soam em [de, ate] (s do relógio) dado est {tocando, posicao, taxa} em `de`: [{n, em, forte}]
//   primeiraBatidaNaFaixa(grade)      a 1ª batida em t >= 0 (a grade pode ter âncora recuada de várias batidas)
//   (ancoraNaAbertura e cueInicial usam o marcador `primeira` quando ele cai na faixa)
//   ancoraNaAbertura(grade, duracao)  true se a 1ª batida cai nos primeiros 0,5% da duração (âncora da spec)
//   cueInicial(grade, duracao, cue)   s do cue "grade + cue" ou null (já há cue, grade inválida, fora da faixa)
(function (raiz, fabrica) {
  const api = fabrica();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.VbMxGrade = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const num = v => typeof v === 'number' && Number.isFinite(v);

  function gradeDeBpm(bpm, primeiraBatida, porCompasso) {
    if (!num(bpm) || bpm <= 0) return null;
    const primeira = num(primeiraBatida) ? primeiraBatida : 0;
    const pc = Number.isInteger(porCompasso) && porCompasso > 0 ? porCompasso : 4;
    return { bpm, primeira, periodo: 60 / bpm, porCompasso: pc };
  }
  function daFaixa(faixa, reserva) {
    if (!faixa) return null;
    const g = faixa.grade;
    if (g && num(g.bpm) && g.bpm > 0) return gradeDeBpm(g.bpm, g.primeira, g.porCompasso);
    return gradeDeBpm(faixa.bpm, reserva);
  }
  function batidaEm(grade, t) { return (t - grade.primeira) / grade.periodo; }
  function tempoDaBatida(grade, n) { return grade.primeira + n * grade.periodo; }
  function quantizar(grade, t) { return tempoDaBatida(grade, Math.round(batidaEm(grade, t))); }
  function compasso(grade, t) {
    const b = batidaEm(grade, t), inteira = Math.floor(b + 1e-9), pc = grade.porCompasso;
    const noCompasso = ((inteira % pc) + pc) % pc;
    return { compasso: Math.floor(inteira / pc) + 1, batida: noCompasso + 1, fase: Math.max(0, b - inteira) };
  }
  function batidasEntre(grade, de, ate) {
    const out = [];
    if (!(ate >= de)) return out;
    for (let n = Math.ceil(batidaEm(grade, de) - 1e-9), t = tempoDaBatida(grade, n); t <= ate + 1e-9; n++, t = tempoDaBatida(grade, n)) out.push(t);
    return out;
  }

  // ---- Edição (VB-39) ----
  const PASSO_BPM = 0.01, TAP_MINIMO = 4, TAP_PAUSA = 2.5; // pausa maior que 2,5 s recomeça o TAP
  function tap(estado, t) {
    if (!num(t)) return estado || { toques: [], bpm: null };
    let toques = estado && Array.isArray(estado.toques) ? estado.toques.slice() : [];
    if (toques.length && (t <= toques[toques.length - 1] || t - toques[toques.length - 1] > TAP_PAUSA)) toques = [];
    toques.push(t);
    if (toques.length > 16) toques.shift();
    let bpm = null;
    if (toques.length >= TAP_MINIMO) bpm = Math.round(60 * (toques.length - 1) / (toques[toques.length - 1] - toques[0]) * 100) / 100;
    return { toques, bpm };
  }
  function comBpm(grade, bpm) {
    if (!grade || !num(bpm) || bpm <= 0) return grade || null;
    return gradeDeBpm(bpm, grade.primeira, grade.porCompasso);
  }
  function passoBpm(grade, delta) {
    if (!grade || !num(delta)) return grade || null;
    // 6 casas, não 2: com o BPM fino da análise (123,371234), arredondar a 0,01 dava passos tortos
    // (+0,0088 / −0,0112) e jogava fora a precisão da grade ao primeiro toque
    const novo = Math.round((grade.bpm + delta) * 1e6) / 1e6;
    return novo > 0 ? comBpm(grade, novo) : grade;
  }
  function marcadorEm(grade, t, bpm) {
    const b = num(bpm) && bpm > 0 ? bpm : grade && grade.bpm;
    if (!num(t) || t < 0 || !num(b) || b <= 0) return grade || null;
    // O marcador é a batida 1 do compasso (como no software de referência): recua por COMPASSO inteiro, não
    // por batida. Recuar por batida deixava t como batida floor(t/P) mod 4 e o SYNC por compasso punha a
    // caixa de uma faixa no bumbo da outra (defeito de 2026-10-27)
    const pc = grade && Number.isInteger(grade.porCompasso) && grade.porCompasso > 0 ? grade.porCompasso : 4;
    const compasso = pc * 60 / b, primeira = t - Math.floor(t / compasso + 1e-9) * compasso;
    return gradeDeBpm(b, primeira, pc);
  }
  function autoGrid(analise, grade, t) {
    if (!analise || !num(analise.bpm) || analise.bpm <= 0 || !num(t)) return null;
    const base = gradeDeBpm(analise.bpm, analise.primeira, analise.porCompasso), ref = grade && grade.bpm > 0 ? grade : base;
    const alvo = quantizar(ref, t);
    return marcadorEm(base, alvo < 0 ? 0 : alvo, base.bpm);
  }
  function recalcular(analise) {
    return analise && num(analise.bpm) && analise.bpm > 0 ? gradeDeBpm(analise.bpm, analise.primeira, analise.porCompasso) : null;
  }
  const travado = (faixa) => !!(faixa && faixa.gradeTravada);


  // ---- Tick audível e marcador inicial (VB-13b) ----
  const ABERTURA = 0.005;          // âncora nos primeiros 0,5% da duração (spec §3)
  function ticksAgendaveis(grade, est, de, ate) {
    if (!grade || !est || !est.tocando || !num(est.posicao) || !(est.taxa > 0) || !num(de) || !(ate >= de)) return [];
    const ateFaixa = est.posicao + (ate - de) * est.taxa, out = [];
    for (const t of batidasEntre(grade, Math.max(0, est.posicao), ateFaixa)) {
      const n = Math.round(batidaEm(grade, t)), pc = grade.porCompasso;
      out.push({ n, em: de + (t - est.posicao) / est.taxa, forte: ((n % pc) + pc) % pc === 0 });
    }
    return out;
  }
  function primeiraBatidaNaFaixa(grade) {
    if (!grade) return null;
    const n = Math.ceil(batidaEm(grade, 0) - 1e-9);
    return Math.max(0, tempoDaBatida(grade, n));
  }
  function ancoraNaAbertura(grade, duracao) {
    return !!grade && num(grade.primeira) && grade.primeira >= 0 && num(duracao) && duracao > 0 && grade.primeira <= duracao * ABERTURA + 1e-9;
  }
  function cueInicial(grade, duracao, cue) {
    const p = grade && num(grade.primeira) && grade.primeira >= 0 ? grade.primeira : primeiraBatidaNaFaixa(grade);
    if (p === null || !num(duracao) || !(duracao > 0) || p >= duracao || (num(cue) && cue > 0)) return null;
    return p;
  }

  return { ABERTURA, ticksAgendaveis, primeiraBatidaNaFaixa, ancoraNaAbertura, cueInicial, PASSO_BPM, TAP_MINIMO, tap, comBpm, passoBpm, marcadorEm, autoGrid, recalcular, travado, gradeDeBpm, daFaixa, batidaEm, tempoDaBatida, quantizar, compasso, batidasEntre };
});
