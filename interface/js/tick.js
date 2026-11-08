// ===================== tick.js — tick audível das batidas da grade, por deck (VB-13b, spec §3) =====================
// Para conferir o alinhamento da grade de ouvido. Lógica pura: VbMxGrade.ticksAgendaveis (testada em Node).
// Aqui só o relógio: uma varredura curta agenda cliques à frente pelo AudioContext, a partir da posição e da
// taxa do transporte (VbMxTocador.estado), como o metrônomo do mestre.js.
// Pela spec o tick só toca no fone (cue), misturado ao sinal de cue antes do VOL do fone (VB-52): com plano de saída
// multicanal ou dividido ele vai à entrada de tick do ramo do fone (VbMxCadeia.entradaTick); sem saída extra
// (plano ausente ou "desligado") continua na soma do master, e o evento `tick:mudou` traz noFone=false para a interface avisar.
// API: tickLigado(letra) · tickAlternar(letra) · evento `tick:mudou` {letra, ligado, noFone}.
VbMxUI.declararEvento("tick:mudou");

const tickEst = { A: { ligado: false, ultimo: -1 }, B: { ligado: false, ultimo: -1 } };
const TICK_ANTECEDENCIA_S = 0.12, TICK_VARREDURA_MS = 30;
let tickTimer = null;

function tickNoFone(){
  const plano = VbMxCadeia.planoDaSaida();
  return !!plano && plano.modo !== "desligado" && !!VbMxCadeia.entradaTick();
}
// Nó de entrada onde o clique é ligado: o fone quando há saída extra, senão a soma do master (com aviso na interface).
function tickDestino(){ return tickNoFone() ? VbMxCadeia.entradaTick() : VbMxCadeia.ponto("master", "soma").entrada; }

function tickLigado(letra){ return !!tickEst[letra].ligado; }
function tickClique(em, forte){
  const ctx = garantirAudio(); if (!ctx) return;
  const osc = ctx.createOscillator(), g = ctx.createGain();
  osc.frequency.value = forte ? 2093 : 1397;
  g.gain.setValueAtTime(0.0001, em);
  g.gain.exponentialRampToValueAtTime(forte ? 0.45 : 0.3, em + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, em + 0.035);
  osc.connect(g); g.connect(tickDestino());
  osc.start(em); osc.stop(em + 0.05);
}
function tickVarrer(){
  const ctx = garantirAudio(); if (!ctx) return;
  const de = ctx.currentTime, ate = de + TICK_ANTECEDENCIA_S;
  for (const letra of ["A", "B"]) {
    const t = tickEst[letra]; if (!t.ligado) continue;
    const faixa = decks[letra].faixa, grade = faixa ? VbMxGrade.daFaixa(faixa, 0) : null;
    if (!grade) continue;
    const e = VbMxTocador.estado(letra, de);
    for (const x of VbMxGrade.ticksAgendaveis(grade, e, de, ate)) {
      if (x.em <= t.ultimo + 0.005 || x.em < de) continue;   // já agendado (a janela se sobrepõe entre varreduras)
      tickClique(x.em, x.forte); t.ultimo = x.em;
    }
  }
}
function tickAtualizarRelogio(){
  const algum = tickEst.A.ligado || tickEst.B.ligado;
  if (algum && !tickTimer) tickTimer = setInterval(tickVarrer, TICK_VARREDURA_MS);
  else if (!algum && tickTimer) { clearInterval(tickTimer); tickTimer = null; }
}
function tickAlternar(letra){
  const t = tickEst[letra], ctx = garantirAudio();
  if (!t.ligado && !ctx) return false;
  t.ligado = !t.ligado; t.ultimo = -1;
  if (t.ligado && ctx.state !== "running") ctx.resume().catch(() => {});
  tickAtualizarRelogio();
  VbMxUI.emitir("tick:mudou", { letra, ligado: t.ligado, noFone: tickNoFone() });
  return t.ligado;
}
