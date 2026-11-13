// ===================== sync.js — SYNC de fase (motor/fase.js) e líder/seguidor =====================
// Dono: VB-20 (onda 2). No carregamento só declara e registra (VbMxUI.registrar/ouvir, VbMxPrefs.declarar);
// nome de topo com o prefixo `sync`. Contrato: docs/contratos.md. Lógica (pura): motor/fase.js.
//
// O botão SYNC é `sincronizar(letra)` em js/deck.js. O deck com SYNC aceso (decks[l].sync) SEGUE o outro:
//   andamento  o pitch é recalculado pela GRADE (VbMxFase.calcularSync: BPM de 3 casas, não o 0,1 da
//              análise) quando o líder muda o pitch ou uma das grades muda; fora de ±15% o sync apaga e avisa
//   fase       VB-56 (Lucas, 2026-10-26: "ajustando o BPM e adequando o compasso"): a batida 1 do compasso
//              do seguidor cai junto da batida 1 do mestre, pelo menor deslocamento (até ±2 batidas, para
//              frente ou para trás). Alinha ao apertar SYNC com o seguidor tocando e o líder tocando (ou o
//              relógio), ao dar play no seguidor e, com sync.fase-continua (padrão ligada), a cada 250 ms:
//              deriva até 50 ms corrige com bend suave (≤ 2%, rampa de 0,2% por checagem, sem degrau);
//              acima disso (hotcue, busca, beatjump, o líder pulou) salta ao compasso. Com loop ativo no
//              seguidor não realinha (o salto poderia cair depois do fim e desligar o loop).
//   líder      o outro deck, ou o relógio mestre quando ele manda (js/mestre.js, VB-35): o relógio tem fase,
//              o instante do tick 1 do metrônomo (mestreFase), e o compasso dele é o alvo
//   recusa     se o BPM necessário passar da faixa do pitch do deck (±8/±15/±50), avisa e não sincroniza
//   solta      apertar SYNC no outro deck, trocar ou tirar a faixa de um dos dois. Mexer no pitch do seguidor
//              não o solta: o SYNC devolve o pitch ao que iguala o mestre (deck.js, mudarPitch).
// O 1 do compasso é o da grade (âncora, motor/grade.js; o VB-13b marca o "1 forte").
// Ajuste fino do BPM da grade, de ouvido (±0,01 BPM, a batida sob a cabeça fica no lugar): ações
// `deckA.gradeBpmMais` / `deckA.gradeBpmMenos` (e B) pela VbMxUI.acao, para teclado e MIDI (VB-25). Vale na
// sessão: gravar no localStorage e o botão na tela são do grade-ui.js (VB-13).

// Tempo bend do deck e medidor de fase (VB-34, spec §1 e §2): as setas ◀ ▶ do deck, segurando, empurram a taxa
//   (VbMxFase.bendDeck: sensibilidade 0–200%, padrão 100, progressiva opcional) e soltar devolve a taxa do pitch.
//   O medidor ([data-fase] do deck) mostra o desalinhamento de batida e de compasso contra o deck mestre (o
//   mestre se mede contra o outro deck) ou contra o tick do relógio mestre (VB-56); parado ou sem grade: "—".
//   Caminho real em Node: interface/testar-mestre.js.
// QUANT e SNAP (VB-36, spec §2) são globais (botões e preferências em mestre.js; as contas, em VbMxFase):
//   QUANT  salto de cue/hotcue com o deck tocando cai na batida mantendo o desvio de batida que a cabeça tinha;
//   SNAP   cue, hotcue e loops gravados caem na batida mais próxima. Os dois valem também para os loops (loops.js).

VbMxPrefs.declarar("bend.sensibilidade", 100, { rotulo: "Tempo bend: sensibilidade (%)", tipo: "numero", min: 0, max: 200, modulo: "sync" });
VbMxPrefs.declarar("bend.progressivo", false, { rotulo: "Tempo bend progressivo (quanto mais tempo apertado, maior a correção)", tipo: "booleano", modulo: "sync" });
VbMxPrefs.declarar("sync.fase-continua", true, { rotulo: "SYNC mantém a fase (realinha depois de hotcue, busca ou salto do outro deck)", tipo: "booleano", modulo: "sync" });
const SYNC_TOLERANCIA_S = 0.010, SYNC_INTERVALO_S = 0.25;
const syncUltimaChecagem = { A: -Infinity, B: -Infinity };
const syncCorrecao = { A: 0, B: 0 };   // fração de bend que o SYNC está aplicando para segurar a fase
const syncDepoisDaMao = { A: false, B: false };   // VB-63: ligada com a mão no deck, desligada quando |desvio| ≤ 2 ms

function syncOutra(l){ return l === "A" ? "B" : "A"; }
// Quem o deck l segue (VB-35, js/mestre.js): o relógio quando ele é o mestre, senão o outro deck.
function syncLider(l){ return typeof mestreEst !== "undefined" && mestreEst.quem === "relogio" ? "relogio" : syncOutra(l); }
function syncGrade(l){ const f = decks[l] && decks[l].faixa; return f ? VbMxGrade.daFaixa(f, 0) : null; }
function syncTaxa(l){ return VbMxReproducao.taxaDoPitch(decks[l].pitch, VbMxPitch.faixaDe(l)); }
// BPM que o deck soa: grade × taxa (o do evento deck:pitch e o da tela)
function syncBpmEfetivo(l){ return VbMxFase.bpmEfetivo(syncGrade(l), syncTaxa(l)); }
function syncPintarBotao(l){
  const b = document.querySelector(`[data-deck="${l}"] [data-sync]`);
  if (b) { b.classList.toggle("tocando", !!decks[l].sync); b.setAttribute("aria-pressed", String(!!decks[l].sync)); }
  syncBendPintar(l);
}
// As setas ◀ ▶ do deck (tempo bend) valem com faixa tocável, com SYNC ligado ou não (o SYNC só suspende a fase
// contínua enquanto a seta está apertada, syncManual). Chamado por atualizarTransporte (deck.js): a carga assíncrona
// do buffer habilita as setas, que nascem desabilitadas no desenho do deck.
function syncBendPintar(l){
  const d = decks[l];
  for (const b of document.querySelectorAll(`[data-deck="${l}"] [data-bend]`)) b.disabled = !(d && d.buffer);
}

// Só o andamento: põe no deck l o pitch que iguala o BPM efetivo dele ao do outro e aplica a taxa.
function syncAplicar(l){
  const o = syncLider(l);
  const r = o === "relogio"
    ? VbMxFase.calcularSync(syncGrade(l), VbMxGrade.gradeDeBpm(VbMxFase.bpmDoRelogio(mestreEst), 0), 1, VbMxPitch.faixaDe(l))
    : VbMxFase.calcularSync(syncGrade(l), syncGrade(o), syncTaxa(o), VbMxPitch.faixaDe(l));
  if (r.ok) { decks[l].pitch = r.pitch; syncCorrecao[l] = 0; aplicarTaxa(l); }
  return r;
}
// Solta o deck l do SYNC (mantém o pitch em que está) e diz por quê.
function syncSoltar(l, motivo){
  const d = decks[l];
  if (!d || !d.sync) return;
  d.sync = false;
  if (syncCorrecao[l]) { syncCorrecao[l] = 0; if (!syncBend[l] && d.buffer) VbMxTocador.definirTaxa(l, syncTaxa(l)); }
  if (motivo) { d.aviso = `SYNC desligado: ${motivo}`; d.avisoCls = ""; }
  if (d.faixa) atualizarNumerosDoDeck(l); else syncPintarBotao(l);
}
function syncReaplicar(l){
  const r = syncAplicar(l);
  if (!r.ok) { syncSoltar(l, r.motivo); return; }
  atualizarNumerosDoDeck(l);
}

// O lado "líder" do deck l no instante `em`: o outro deck (se tocando) ou o relógio mestre com a fase dele.
function syncLadoLider(l, em){
  if (syncLider(l) === "relogio") return VbMxFase.ladoDoRelogio(mestreFase, VbMxFase.bpmDoRelogio(mestreEst), em);
  const o = syncOutra(l), g = syncGrade(o);
  if (!g || !tocandoDeck(o)) return null;
  const e = VbMxTocador.estado(o, em);
  return { grade: g, posicao: e.posicao, taxa: e.taxa };
}
// Fase (por compasso, VB-56): com o deck l e o líder tocando (o relógio sempre "toca"), leva a batida 1 do
// compasso do deck l à batida 1 do líder, pelo menor deslocamento (≤ 2 batidas). Os dois estados são lidos
// no MESMO instante do relógio, e o tocador projeta o alvo até a hora do pulo.
function syncAlinharFase(l){
  if (!tocandoDeck(l)) return null;
  const gS = syncGrade(l);
  if (!gS) return null;
  // A correção de deriva em curso sai junto com o salto: a taxa volta à do pitch. Antes só syncCorrecao ia a 0 e
  // o deck seguia com o bend aplicado — a fase escorregava de novo na razão do bend esquecido (2026-10-26).
  if (syncCorrecao[l] && !syncManual(l) && decks[l].buffer) VbMxTocador.definirTaxa(l, syncTaxa(l));
  syncCorrecao[l] = 0;
  const em = VbMxTocador.relogio(), eS = VbMxTocador.estado(l, em), lider = syncLadoLider(l, em);
  if (!lider) return null;
  const a = VbMxFase.alinhar({ grade: gS, posicao: eS.posicao, taxa: eS.taxa }, lider, { duracao: eS.duracao, porCompasso: true });
  if (!a) return null;
  if (Math.abs(a.salto) > 1e-4) { VbMxTocador.buscar(l, a.posicao, { em }); emitirPosicao(l); }
  return a;
}
// A mão no deck (VB-58): seta de bend apertada, gesto no prato/onda/jog (bend da borda ou scratch) ou a rampa de
// soltura do scratch. Enquanto ela manda, a fase contínua fica suspensa (VbMxFase.correcaoDeDeriva com manual).
function syncManual(l){
  if (syncBend[l]) return true;
  return typeof scratchManual === "function" && scratchManual(l);   // js/scratch.js carrega depois deste
}
// A cada quadro tocando (deck:posicao), no máximo a cada 250 ms: mede o desvio de compasso. Até 50 ms corrige
// com bend suave (a taxa do pitch × (1 + fração), a fração anda ≤ 0,2% por checagem); acima, salta ao compasso.
// Com a mão no deck a correção larga a fração dela (a taxa é a da mão) e, ao soltar, volta de 0 pela mesma rampa.
function syncVigiar(l){
  const d = decks[l];
  if (!d || !d.sync || d.previa || !VbMxPrefs.ler("sync.fase-continua")) return;
  if (syncManual(l)) { syncDepoisDaMao[l] = true; syncCorrecao[l] = VbMxFase.correcaoDeDeriva(null, { manual: true }).fracao; return; }
  if (!tocandoDeck(l)) return;
  const em = VbMxTocador.relogio();
  if (em - syncUltimaChecagem[l] < SYNC_INTERVALO_S) return;
  syncUltimaChecagem[l] = em;
  const eS = VbMxTocador.estado(l, em);
  if (eS.loop) return;
  const lider = syncLadoLider(l, em);
  if (!lider) return;
  const e = VbMxFase.desvioDeCompasso({ grade: syncGrade(l), posicao: eS.posicao, taxa: eS.taxa }, lider);
  if (!e) return;
  if (Math.abs(e.relogio) <= 0.002) syncDepoisDaMao[l] = false;   // fase de volta: o salto volta a valer
  const c = VbMxFase.correcaoDeDeriva(e.relogio, { anterior: syncCorrecao[l], depoisDaMao: syncDepoisDaMao[l] });
  if (c.acao === "salto") { syncAlinharFase(l); return; }
  if (c.fracao !== syncCorrecao[l]) {
    syncCorrecao[l] = c.fracao;
    VbMxTocador.definirTaxa(l, VbMxFase.taxaComBend(syncTaxa(l), c.fracao));
  }
}

// ---- QUANT e SNAP ----
function syncQuant(){ return VbMxPrefs.ler("global.quant") !== false; }
function syncSnap(){ return VbMxPrefs.ler("global.snap") === true; }
// Ponto a gravar (cue, hotcue, loop): na batida mais próxima quando o SNAP está ligado.
function syncPonto(l, t){ return VbMxFase.pontoNaBatida(syncGrade(l), t, syncSnap()); }
// Para onde a cabeça vai ao saltar para `destino`: com QUANT e o deck tocando, mantém a batida.
function syncDestino(l, destino){
  return VbMxFase.destinoDeSalto(syncGrade(l), VbMxTocador.posicao(l), destino, { quant: syncQuant(), tocando: tocandoDeck(l) });
}

// ---- Tempo bend do deck ----
const syncBend = { A: null, B: null };   // { sinal, desde, timer } enquanto a seta está apertada
function syncBendFracao(l){
  const b = syncBend[l]; if (!b) return 0;
  return VbMxFase.bendDeck(b.sinal, VbMxPrefs.ler("bend.sensibilidade"), { progressivo: VbMxPrefs.ler("bend.progressivo") === true, apertadoS: (performance.now() - b.desde) / 1000 });
}
function syncBendAplicar(l){
  VbMxTocador.definirTaxa(l, VbMxFase.taxaComBend(syncTaxa(l), syncBendFracao(l)));
}
function syncBendApertar(l, sinal){
  if (!decks[l] || !decks[l].buffer || syncBend[l]) return;
  syncBend[l] = { sinal, desde: performance.now(), timer: setInterval(() => syncBendAplicar(l), 40) };
  syncBendAplicar(l);
}
function syncBendSoltar(l){
  const b = syncBend[l]; if (!b) return;
  clearInterval(b.timer); syncBend[l] = null;
  syncCorrecao[l] = 0;
  VbMxTocador.definirTaxa(l, syncTaxa(l));   // a taxa do pitch (com sync, a fase continua o realinha depois)
}

// ---- Medidor de fase ----
// Contra o deck mestre (ou, sendo o deck o mestre, contra o outro deck) e, com o relógio de mestre (VB-56, que
// agora tem fase), contra o tick do metrônomo. Mostra o desvio de batida e o de compasso (batida 1 contra 1).
function syncMedidor(l){
  const el = document.querySelector(`[data-deck="${l}"] [data-fase]`);
  if (!el) return;
  let m = null;
  if (tocandoDeck(l) && syncGrade(l)) {
    const em = VbMxTocador.relogio(), eS = VbMxTocador.estado(l, em);
    const ref = mestreEhDeck(mestreEst.quem) ? (mestreEst.quem !== l ? mestreEst.quem : syncOutra(l)) : "relogio";
    const lider = ref === "relogio" ? VbMxFase.ladoDoRelogio(mestreFase, VbMxFase.bpmDoRelogio(mestreEst), em)
      : ref && tocandoDeck(ref) && syncGrade(ref) ? { grade: syncGrade(ref), posicao: VbMxTocador.estado(ref, em).posicao, taxa: VbMxTocador.estado(ref, em).taxa } : null;
    if (lider) m = VbMxFase.medidorFase({ grade: syncGrade(l), posicao: eS.posicao, taxa: eS.taxa }, lider);
  }
  el.textContent = m ? `${m.texto} · cmp ${m.textoCompasso}` : "—";
  el.dataset.estado = m ? m.estado : "";
  el.title = m ? `Fase contra o mestre (${m.estado}): ${m.texto} batida; desvio de compasso (batida 1 contra batida 1): ${m.textoCompasso} batidas` : "Fase contra o tempo mestre, em batidas e em compasso (precisa do deck em reprodução)";
}

// Ajuste fino de ouvido: BPM da grade do deck l ± delta, com a batida mais perto da cabeça parada.
function syncAjustarBpmDaGrade(l, delta){
  const f = decks[l] && decks[l].faixa, g = syncGrade(l);
  if (!f || f.gradeTravada || !g) return null;
  const h = VbMxFase.ajustarBpm(g, Math.round((g.bpm + delta) * 1000) / 1000, VbMxTocador.posicao(l));
  if (!h) return null;
  f.grade = { bpm: h.bpm, primeira: Math.round(h.primeira * 1e4) / 1e4 };
  VbMxUI.emitir("grade:mudou", { letra: l, faixa: f, grade: f.grade });
  if (!decks[l].sync) atualizarNumerosDoDeck(l);   // com sync, o grade:mudou já repinta
  return f.grade;
}

VbMxUI.ouvir("deck:pitch", ev => { const l = syncOutra(ev.letra); if (decks[l] && decks[l].sync && syncLider(l) === ev.letra) syncReaplicar(l); });
// o relógio mestre mudou de tempo: quem o segue acompanha (o mestre trocar de deck não mexe em ninguém)
VbMxUI.ouvir("mestre:mudou", () => { if (mestreEst.quem === "relogio") for (const l of ["A", "B"]) if (decks[l].sync) syncReaplicar(l); });
VbMxUI.ouvir("deck:tocou", ev => { if (decks[ev.letra] && decks[ev.letra].sync) syncAlinharFase(ev.letra); });
VbMxUI.ouvir("deck:posicao", ev => { syncMedidor(ev.letra); if (ev.tocando) syncVigiar(ev.letra); });
VbMxUI.ouvir("deck:descarregado", ev => { decks[ev.letra].sync = false; syncSoltar(syncOutra(ev.letra), `o deck ${ev.letra} ficou vazio`); });
if (VbMxUI.eventos().includes("grade:mudou")) {   // declarado pelo grade-ui.js (VB-13), que carrega antes
  VbMxUI.ouvir("grade:mudou", () => { for (const l of ["A", "B"]) if (decks[l].sync) syncReaplicar(l); });
}
for (const l of ["A", "B"]) {
  VbMxUI.registrar("acao", `deck${l}.gradeBpmMais`, () => syncAjustarBpmDaGrade(l, VbMxFase.PASSO_AJUSTE_BPM));
  VbMxUI.registrar("acao", `deck${l}.gradeBpmMenos`, () => syncAjustarBpmDaGrade(l, -VbMxFase.PASSO_AJUSTE_BPM));
  VbMxUI.registrar("acao", `deck${l}.sync`, () => sincronizar(l));   // VB-48: o botão SYNC é de deck.js
}
for (const l of ["A", "B"]) {
  // "pressionar" (MIDI: Nudge da X1): sem argumento ou true aperta; false solta — bendSoltar segue para quem já usa
  VbMxUI.registrar("acao", `deck${l}.bendMais`, (v) => (v === false ? syncBendSoltar(l) : syncBendApertar(l, 1)));
  VbMxUI.registrar("acao", `deck${l}.bendMenos`, (v) => (v === false ? syncBendSoltar(l) : syncBendApertar(l, -1)));
  VbMxUI.registrar("acao", `deck${l}.bendSoltar`, () => syncBendSoltar(l));
}
