// ===================== VbMxFase — fase: alinhamento de batida entre os decks (SYNC de fase) =====================
// Dono: VB-20. Lógica pura (UMD), testada em Node por motor/testar-fase.js. Contrato: docs/contratos.md.
//
// Por que existe (relato do Lucas, 2026-10-25: "as músicas estão saindo do tempo"): o SYNC antigo
// igualava `faixa.bpm` — o BPM da análise arredondado em 0,1 — e não mexia na fase. Igualar números
// arredondados deixa até 0,05 BPM de erro por deck (≈ 24 ms/min a 124 BPM; o dobro se os dois decks
// erram para lados opostos), e sem alinhar a fase as batidas ficam onde o DJ soltou. Aqui o SYNC usa
// a GRADE (motor/grade.js: BPM de 3 casas e a 1ª batida) para o andamento e para a fase.
//
// O que isto NÃO conserta: grade com BPM errado (a análise mediu 123,6 numa faixa de 124,0). Duas
// grades travadas ficam em fase para sempre, mas a batida de verdade escorrega da grade errada na
// razão do erro (60 s × Δbpm/bpm por minuto). O conserto é a análise, ou o ajuste fino da grade
// (`ajustarBpm`), que o DJ faz de ouvido.
//
// Tempos em s DA FAIXA (posição do arquivo), como em motor/grade.js; "relógio" = s do AudioContext.
// `fator` é o mesmo do SYNC de motor/pitch.js: BPM efetivo do seguidor = BPM efetivo do líder × fator
// (1, 2 ou ½).
//
// API:
//   bpmDaFaixa(faixa)                       BPM da grade (analisada ou estimada): o que o SYNC iguala
//   bpmEfetivo(grade, taxa)                 grade.bpm × taxa (o que o deck soa)
//   calcularSync(gradeSeg, gradeLider, taxaLider)
//                                           o pitch do seguidor: VbMxPitch.calcularSync com os BPMs da grade
//   fatorEntre(bpmEfSeg, bpmEfLider)        1, 2 ou ½: o mais perto da razão
//   erroDeFase(seg, lider, opcoes)          { batidas, faixa, relogio, fator, unidade }: quanto o seguidor
//                                           está ADIANTADO (positivo) em relação ao líder, contado até a
//                                           unidade mais próxima (batida; compasso com opcoes.porCompasso).
//                                           seg/lider = { grade, posicao, taxa }; opcoes.fator força o fator
//   alinhar(seg, lider, opcoes)             { posicao, salto, erro }: a posição do seguidor que zera o erro
//                                           no mesmo instante; |salto| ≤ ½ unidade (com opcoes.duracao,
//                                           se cair fora da faixa pula uma unidade inteira para dentro)
//   ajustarBpm(grade, novoBpm, ancora)      a grade com outro BPM e a batida mais perto de `ancora` (s da
//                                           faixa, ex.: a cabeça) parada no lugar; a 1ª batida é dobrada
//                                           dentro do 1º compasso, para o 1 do compasso não mudar
//   PASSO_AJUSTE_BPM                        0,01 BPM: o passo do ajuste fino de ouvido
// Tempo mestre (VB-35, spec §2). Estado { quem: 'A'|'B'|'relogio', auto, bpm, bend, tap }; só um mestre por vez
// (é um campo, não três botões). Funções puras: devolvem o estado novo.
//   mestreInicial(opcoes)                   relógio mestre, AUTO ligado, 120 BPM
//   declararMestre(m, quem)                 o botão MASTER: quem vira o mestre (quem já é: não muda)
//   aoPararMestre(m, letra, emSync, bpm)    o mestre `letra` parou/terminou/saiu: com AUTO, o deck em sync
//                                           (emSync = { A, B } booleanos) vira mestre, senão o relógio assume
//                                           no `bpm` do deck que parou; sem AUTO ou se `letra` não é o mestre,
//                                           nada muda
//   definirAuto(m, ligado)                  liga/desliga o modo AUTO
//   bpmDoRelogio(m)                         BPM que o relógio soa: bpm × (1 + bend)
//   definirBpmRelogio(m, bpm)               digitado (duplo clique): limita a 40–250 e zera o bend
//   passoRelogio(m, delta)                  sobe/desce o tempo em passos (PASSO_RELOGIO = 0,1 BPM)
//   bendRelogio(m, fracao)                  empurra o relógio (fração do BPM, ±BEND_MAXIMO); 0 solta
//   tapRelogio(m, t)                        tap do tempo mestre (G.tap): o BPM só muda após a 4ª batida
//   proximoTick(t, m, nBatida)              { em, forte }: o tick do metrônomo depois de t (s do relógio);
//                                           `forte` na 1ª batida do compasso (nBatida % 4 === 0)
// Tempo bend do deck, medidor de fase, QUANT e SNAP (VB-34 e VB-36, spec §1 e §2):
//   sensibilidadeBend(pct)                  0 a 200 (%), padrão 100; fora disso limita, não número vale 100
//   bendDeck(sinal, pct, opcoes)            fração empurrada na taxa: sinal (+1 acelera, −1 freia) × BEND_DECK × pct/100.
//                                           opcoes.progressivo + opcoes.apertadoS: cresce de ¼ a 1 do valor cheio em 2 s
//   taxaComBend(taxa, fracao)               taxa × (1 + fracao): a taxa que o deck toca enquanto o botão está apertado
//   medidorFase(seg, lider, opcoes)         { batidas, estado: 'adiantado'|'atrasado'|'alinhado', texto } ou null:
//                                           o desalinhamento de batida do seguidor contra o mestre (TOLERANCIA_MEDIDOR)
// SYNC por compasso (VB-56, decisão do Lucas 2026-10-26: "ajustando o BPM e adequando o compasso"):
//   desvioDeCompasso(seg, lider, opcoes)    erroDeFase por compasso: o quanto a batida 1 do compasso do seguidor
//                                           está longe da batida 1 do mestre, em batidas, no intervalo (−2, +2]
//                                           (+ = seguidor adiantado). É o menor deslocamento, p/ frente ou p/ trás
//   planoSync(seg, lider, opcoes)           o SYNC inteiro numa conta só: { ok, pitch, taxa, fator, bpmResultante,
//                                           posicao, salto, erro } (BPM igualado + batida 1 junto da do mestre) ou
//                                           { ok:false, motivo } (BPM inválido ou fora da faixa do pitch, opcoes.limite)
//   correcaoDeDeriva(erroS, o)              { acao: 'nenhuma'|'bend'|'salto', fracao }: deriva pequena corrige com bend
//                                           suave (fração da taxa, ±2%, com rampa); grande, com salto de compasso.
//                                           o.manual (VB-58: seta de bend, borda do prato, jog ou scratch ativos):
//                                           { acao: 'suspensa', fracao: 0 } — a mão manda na taxa e a correção
//                                           larga a dela; ao soltar, volta da fração 0 pela mesma rampa.
//                                           o.depoisDaMao (VB-63): desde a mão até a fase voltar, o desvio acima de
//                                           50 ms não salta ao compasso: só bend com rampa (o chamador mantém a marca)
//   Relógio com fase (o instante do tick 1 do metrônomo): fase = { em, batida } (a batida `batida` cai em `em`, s do
//   relógio; batida % 4 === 0 é o tick forte). faseDoRelogio(em), batidaDoRelogio(fase, bpm, em),
//   reancorarRelogio(fase, bpmAntigo, em) (muda o BPM sem degrau de fase), proximoTickDaFase(fase, bpm, depois),
//   ladoDoRelogio(fase, bpm, em) (o relógio como "líder": { grade, posicao: em, taxa: 1 }, entra em planoSync)
//   pontoNaBatida(grade, t, snap)           com SNAP, t cai na batida mais próxima; sem, volta t
//   destinoDeSalto(grade, origem, destino, o)  o ponto onde a cabeça cai ao saltar de `origem` para `destino`.
//                                           Com o.quant e o.tocando, mantém a fase: o destino vai para a batida mais
//                                           próxima + o desvio que a origem tinha da sua batida. Sem, é o destino
(function (raiz, fabrica) {
  const api = fabrica(raiz);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.VbMxFase = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (raiz) {
  'use strict';
  const exigir = (nome, arq) => raiz[nome] || (typeof require === 'function' ? require(arq) : null);
  const G = exigir('VbMxGrade', './grade.js');
  const P = exigir('VbMxPitch', './pitch.js');

  const num = v => typeof v === 'number' && Number.isFinite(v);
  const PASSO_AJUSTE_BPM = 0.01;
  const FATORES = [1, 2, 0.5];

  function gradeValida(g) { return !!g && num(g.bpm) && g.bpm > 0 && num(g.primeira) && num(g.periodo) && g.periodo > 0; }
  const taxaValida = t => (num(t) && t > 0 ? t : 1);
  // resto em (−½, ½]: o "mais perto de zero"
  function embrulhar(x) { const r = x - Math.round(x); return r <= -0.5 ? r + 1 : r; }

  function bpmDaFaixa(faixa) {
    const g = G.daFaixa(faixa, 0);
    return g ? g.bpm : null;
  }
  function bpmEfetivo(grade, taxa) { return gradeValida(grade) ? grade.bpm * taxaValida(taxa) : null; }

  function calcularSync(gradeSeg, gradeLider, taxaLider, limite) {
    if (!gradeValida(gradeSeg)) return { ok: false, motivo: 'o deck não tem BPM válido' };
    if (!gradeValida(gradeLider)) return { ok: false, motivo: 'o outro deck não tem BPM válido' };
    return P.calcularSync(gradeSeg.bpm, bpmEfetivo(gradeLider, taxaLider), limite);
  }

  function fatorEntre(bpmEfSeg, bpmEfLider) {
    if (!(num(bpmEfSeg) && bpmEfSeg > 0 && num(bpmEfLider) && bpmEfLider > 0)) return 1;
    let melhor = 1, dist = Infinity;
    for (const f of FATORES) {
      const d = Math.abs(Math.log(bpmEfSeg / (bpmEfLider * f)));
      if (d < dist - 1e-12) { dist = d; melhor = f; }
    }
    return melhor;
  }

  function lado(x) {
    if (!x || !gradeValida(x.grade) || !num(x.posicao)) return null;
    return { grade: x.grade, posicao: x.posicao, taxa: taxaValida(x.taxa) };
  }

  // Em batidas do SEGUIDOR. Por batida do líder o seguidor anda `fator` batidas dele (fator 2: o
  // seguidor é o dobro; ½: uma batida do seguidor cobre duas do líder).
  function erroDeFase(seg, lider, opcoes) {
    const s = lado(seg), l = lado(lider), o = opcoes || {};
    if (!s || !l) return null;
    const fator = num(o.fator) && o.fator > 0 ? o.fator : fatorEntre(bpmEfetivo(s.grade, s.taxa), bpmEfetivo(l.grade, l.taxa));
    const unidade = o.porCompasso ? (s.grade.porCompasso || 4) : 1;
    const bS = G.batidaEm(s.grade, s.posicao), bL = G.batidaEm(l.grade, l.posicao) * fator;
    const batidas = embrulhar((bS - bL) / unidade) * unidade;
    const faixa = batidas * s.grade.periodo;
    return { batidas, faixa, relogio: faixa / s.taxa, fator, unidade };
  }

  function alinhar(seg, lider, opcoes) {
    const e = erroDeFase(seg, lider, opcoes);
    if (!e) return null;
    const o = opcoes || {}, passo = e.unidade * seg.grade.periodo;
    const duracao = num(o.duracao) && o.duracao > 0 ? o.duracao : Infinity;
    let posicao = seg.posicao - e.faixa;
    while (posicao < 0) posicao += passo;
    while (posicao > duracao && posicao - passo >= 0) posicao -= passo;
    return { posicao, salto: posicao - seg.posicao, erro: e };
  }

  function ajustarBpm(grade, novoBpm, ancora) {
    if (!gradeValida(grade) || !num(novoBpm) || novoBpm <= 0) return null;
    const pc = grade.porCompasso || 4;
    const n = Math.round(G.batidaEm(grade, num(ancora) ? ancora : grade.primeira));
    const tN = G.tempoDaBatida(grade, n), periodo = 60 / novoBpm, compasso = periodo * pc;
    // a batida n continua em tN; dobrar por compasso muda o número dela só por múltiplo de pc
    const primeira = (((tN - n * periodo) % compasso) + compasso) % compasso;
    return G.gradeDeBpm(novoBpm, primeira, pc);
  }

  // ---- Tempo mestre (VB-35) ----
  const PASSO_RELOGIO = 0.1, BEND_MAXIMO = 0.1, BPM_MIN = 40, BPM_MAX = 250, QUEM = ['A', 'B', 'relogio'];
  const limitarBpm = b => Math.min(BPM_MAX, Math.max(BPM_MIN, Math.round(b * 100) / 100));

  function mestreInicial(o) {
    const op = o || {};
    return { quem: QUEM.includes(op.quem) ? op.quem : 'relogio', auto: op.auto !== false,
      bpm: num(op.bpm) && op.bpm > 0 ? limitarBpm(op.bpm) : 120, bend: 0, tap: null };
  }
  function declararMestre(m, quem) {
    if (!QUEM.includes(quem) || m.quem === quem) return m;
    return { ...m, quem };
  }
  // SYNC apertado em `letra`: quem passa a ser o mestre. O relógio só lidera o SYNC quando o usuário o
  // declarou mestre (`m.relogioExplicito`); por padrão, ou com AUTO, o outro deck lidera e vira o mestre.
  function mestreAoSincronizar(m, letra) {
    const outra = letra === 'A' ? 'B' : 'A';
    if (m.quem === letra) return declararMestre(m, outra);
    if (m.quem === 'relogio' && (m.auto || !m.relogioExplicito)) return declararMestre(m, outra);
    return m;
  }
  function aoPararMestre(m, letra, emSync, bpm) {
    if (!m.auto || m.quem !== letra) return m;
    const es = emSync || {};
    for (const l of ['A', 'B']) if (l !== letra && es[l]) return { ...m, quem: l };
    return { ...m, quem: 'relogio', bpm: num(bpm) && bpm > 0 ? limitarBpm(bpm) : m.bpm, bend: 0 };
  }
  function definirAuto(m, ligado) { return { ...m, auto: !!ligado }; }
  function bpmDoRelogio(m) { return m.bpm * (1 + m.bend); }
  function definirBpmRelogio(m, bpm) { return num(bpm) && bpm > 0 ? { ...m, bpm: limitarBpm(bpm), bend: 0, tap: null } : m; }
  function passoRelogio(m, delta) { return num(delta) ? { ...m, bpm: limitarBpm(m.bpm + delta) } : m; }
  function bendRelogio(m, fracao) {
    if (!num(fracao)) return m;
    return { ...m, bend: Math.max(-BEND_MAXIMO, Math.min(BEND_MAXIMO, fracao)) };
  }
  function tapRelogio(m, t) {
    const tap = G.tap(m.tap, t);
    if (tap.bpm === null) return { ...m, tap };
    return { ...m, tap, bpm: limitarBpm(tap.bpm), bend: 0 };
  }
  function proximoTick(t, m, nBatida) {
    const n = Math.max(0, Math.floor(num(nBatida) ? nBatida : 0));
    return { em: t + 60 / bpmDoRelogio(m), forte: n % 4 === 0 };
  }

  // ---- Tempo bend do deck, medidor, QUANT e SNAP (VB-34, VB-36) ----
  const BEND_DECK = 0.04, SENS_PADRAO = 100, RAMPA_BEND_S = 2, PROGRESSIVO_MIN = 0.25, TOLERANCIA_MEDIDOR = 0.02;
  function sensibilidadeBend(pct) { return num(pct) ? Math.max(0, Math.min(200, pct)) : SENS_PADRAO; }
  function bendDeck(sinal, pct, opcoes) {
    const o = opcoes || {}, s = sinal < 0 ? -1 : sinal > 0 ? 1 : 0;
    let mult = 1;
    if (o.progressivo) {
      const t = num(o.apertadoS) ? Math.max(0, o.apertadoS) : 0;
      mult = PROGRESSIVO_MIN + (1 - PROGRESSIVO_MIN) * Math.min(1, t / RAMPA_BEND_S);
    }
    return s * BEND_DECK * (sensibilidadeBend(pct) / 100) * mult || 0;
  }
  function taxaComBend(taxa, fracao) { return taxaValida(taxa) * (1 + (num(fracao) ? fracao : 0)); }
  function medidorFase(seg, lider, opcoes) {
    const e = erroDeFase(seg, lider, opcoes);
    if (!e) return null;
    const b = Math.abs(e.batidas) < TOLERANCIA_MEDIDOR ? 0 : e.batidas;
    const estado = b === 0 ? 'alinhado' : b > 0 ? 'adiantado' : 'atrasado';
    const texto = b === 0 ? '0,00' : (b > 0 ? '+' : '−') + Math.abs(b).toFixed(2).replace('.', ',');
    // VB-56: também o desvio de compasso (batida 1 contra batida 1), de −2 a +2 batidas
    const c = erroDeFase(seg, lider, { ...(opcoes || {}), porCompasso: true });
    const bc = Math.abs(c.batidas) < TOLERANCIA_MEDIDOR ? 0 : c.batidas;
    const textoCompasso = bc === 0 ? '0,00' : (bc > 0 ? '+' : '−') + Math.abs(bc).toFixed(2).replace('.', ',');
    return { batidas: e.batidas, estado, texto, compasso: c.batidas, estadoCompasso: bc === 0 ? 'alinhado' : bc > 0 ? 'adiantado' : 'atrasado', textoCompasso };
  }

  // ---- SYNC por compasso (VB-56) ----
  const LIMITE_BEND_DERIVA = 0.02, JANELA_DERIVA_S = 2, ZONA_MORTA_S = 0.002, LIMITE_SALTO_S = 0.05, PASSO_RAMPA_BEND = 0.002;
  function desvioDeCompasso(seg, lider, opcoes) { return erroDeFase(seg, lider, { ...(opcoes || {}), porCompasso: true }); }
  function planoSync(seg, lider, opcoes) {
    const o = opcoes || {};
    if (!seg || !lider) return { ok: false, motivo: 'faltam dados do deck' };
    const r = calcularSync(seg.grade, lider.grade, lider.taxa, o.limite);
    if (!r.ok) return r;
    const taxa = 1 + r.pitch / 100;
    const novo = { grade: seg.grade, posicao: seg.posicao, taxa };
    const a = alinhar(novo, lider, { ...o, porCompasso: true, fator: r.fator });
    if (!a) return { ...r, taxa, posicao: seg.posicao, salto: 0, erro: null };
    return { ...r, taxa, posicao: a.posicao, salto: a.posicao - seg.posicao, erro: erroDeFase(novo, lider, { porCompasso: true, fator: r.fator }) };
  }
  // erroS: s do relógio, + = seguidor adiantado. Para zerar, o seguidor precisa andar MAIS DEVAGAR (fração < 0).
  // `anterior` é a fração em uso: a nova anda no máximo PASSO_RAMPA_BEND por chamada (sem degrau audível).
  function correcaoDeDeriva(erroS, opcoes) {
    const o = opcoes || {}, ant = num(o.anterior) ? o.anterior : 0;
    if (o.manual) return { acao: 'suspensa', fracao: 0 };   // VB-58: quem empurra o disco corrige a fase na mão
    const rampa = x => Math.abs(x - ant) <= PASSO_RAMPA_BEND ? x : ant + Math.sign(x - ant) * PASSO_RAMPA_BEND;
    if (!num(erroS)) return { acao: 'nenhuma', fracao: rampa(0) };
    const a = Math.abs(erroS);
    // VB-63 (decisão do Lucas, 2026-11-08): depois da mão (o.depoisDaMao, ligado pelo chamador desde o aperto
    // até a fase voltar à zona morta) o desvio grande NUNCA vira salto: volta à fase só pela rampa (bend ≤ 2%)
    if (a > (num(o.limiteSalto) ? o.limiteSalto : LIMITE_SALTO_S) && !o.depoisDaMao) return { acao: 'salto', fracao: 0 };
    if (a <= ZONA_MORTA_S) return { acao: 'nenhuma', fracao: rampa(0) };
    const alvo = Math.max(-LIMITE_BEND_DERIVA, Math.min(LIMITE_BEND_DERIVA, -erroS / JANELA_DERIVA_S));
    return { acao: 'bend', fracao: rampa(alvo) };
  }
  const faseDoRelogio = em => ({ em: num(em) ? em : 0, batida: 0 });
  const batidaDoRelogio = (fase, bpm, em) => fase.batida + (em - fase.em) * bpm / 60;
  function reancorarRelogio(fase, bpmAntigo, em) { return { em, batida: batidaDoRelogio(fase, bpmAntigo, em) }; }
  function proximoTickDaFase(fase, bpm, depois) {
    const n = Math.ceil(batidaDoRelogio(fase, bpm, depois) - 1e-9);
    return { em: fase.em + (n - fase.batida) * 60 / bpm, n, forte: ((n % 4) + 4) % 4 === 0 };
  }
  function ladoDoRelogio(fase, bpm, em) {
    const g = G.gradeDeBpm(bpm, fase.em - fase.batida * 60 / bpm, 4);
    return g ? { grade: g, posicao: em, taxa: 1 } : null;
  }
  function pontoNaBatida(grade, t, snap) { return snap && gradeValida(grade) ? G.quantizar(grade, t) : t; }
  function destinoDeSalto(grade, origem, destino, opcoes) {
    const o = opcoes || {};
    if (!o.quant || !o.tocando || !gradeValida(grade) || !num(origem)) return destino;
    const desvio = origem - G.quantizar(grade, origem);
    return Math.max(0, G.quantizar(grade, destino) + desvio);
  }

  return { BEND_DECK, SENS_PADRAO, sensibilidadeBend, bendDeck, taxaComBend, medidorFase, pontoNaBatida, destinoDeSalto,
    PASSO_RELOGIO, BEND_MAXIMO, mestreInicial, declararMestre, mestreAoSincronizar, aoPararMestre, definirAuto, bpmDoRelogio,
    definirBpmRelogio, passoRelogio, bendRelogio, tapRelogio, proximoTick, desvioDeCompasso, planoSync, correcaoDeDeriva, faseDoRelogio, batidaDoRelogio, reancorarRelogio, proximoTickDaFase, ladoDoRelogio, PASSO_AJUSTE_BPM, bpmDaFaixa, bpmEfetivo, calcularSync, fatorEntre, erroDeFase, alinhar, ajustarBpm };
});
