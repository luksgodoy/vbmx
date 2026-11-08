// ===================== mestre.js — tempo mestre: botão MASTER, relógio mestre, AUTO, metrônomo =====================
// Dono: VB-35. No carregamento só declara e registra (VbMxUI.declararEvento/ouvir/registrar,
// VbMxPrefs.declarar); o DOM do painel nasce em VbMxUI.aoIniciar. Nome de topo com o prefixo `mestre`.
// Lógica (pura, testada em Node): VbMxFase.mestre*. Contrato: docs/contratos.md.
//
// Só há um mestre por vez: um deck (A ou B) ou o relógio interno (estado `mestreEst.quem`). O deck mestre
// nunca segue ninguém (decks[l].sync = false). Quem está em SYNC segue o mestre: o outro deck, ou o
// relógio quando ele é o mestre (VB-56: andamento e compasso; o relógio tem fase, o instante do tick 1 do
// metrônomo, em `mestreFase`, e o SYNC leva a batida 1 do deck até lá). Ver sync.js.
//   AUTO (padrão ligado, preferência mestre.auto): o deck mestre pausa, termina ou sai → o deck em sync vira
//     mestre; sem ninguém em sync o relógio assume no BPM de quem parou. Apertar SYNC com AUTO e o relógio
//     de mestre passa o mestre ao outro deck (o líder do SYNC), mesmo com o relógio declarado no MASTER do
//     painel (VbMxFase.mestreAoSincronizar). Para sincronizar ao relógio: desligue o AUTO **e** aperte MASTER
//     no painel, depois SYNC (caminho real em interface/testar-mestre.js).
//   Painel global (no topo): tempo e deslocamento, duplo clique digita o BPM, TAP (vale após a 4ª batida),
//     bend (segure), passos de 0,1 BPM e metrônomo audível (clique na soma do master, não só no fone).
// Evento: `mestre:mudou` {quem, bpm, auto} — o mestre trocou ou o tempo do relógio mudou.

VbMxPrefs.declarar("mestre.auto", true, { rotulo: "Tempo mestre automático (o deck em sync vira mestre quando o mestre para)", tipo: "booleano", modulo: "mestre" });
VbMxPrefs.declarar("global.quant", true, { rotulo: "QUANT: saltos de cue, hotcue e loop mantêm a batida; loops e beatjump caem na grade", tipo: "booleano", modulo: "mestre" });
VbMxPrefs.declarar("global.snap", false, { rotulo: "SNAP: cues, hotcues e loops guardados caem na batida mais próxima", tipo: "booleano", modulo: "mestre" });
VbMxUI.declararEvento("mestre:mudou");

let mestreEst = VbMxFase.mestreInicial({ auto: VbMxPrefs.ler("mestre.auto") });
let mestreFase = VbMxFase.faseDoRelogio(0);   // âncora da fase do relógio: a batida `batida` cai em `em` (s do AudioContext); % 4 = 0 é o tick forte
const mestreMetro = { ligado: false, proximo: 0, n: 0, timer: null };
const MESTRE_BEND = 0.04, MESTRE_ANTECEDENCIA_S = 0.12, MESTRE_VARREDURA_MS = 30;

function mestreOutra(l){ return l === "A" ? "B" : "A"; }
function mestreEhDeck(q){ return q === "A" || q === "B"; }
// BPM do tempo mestre: o do relógio (com bend) ou o que o deck mestre soa (grade × taxa)
function mestreBpm(){
  return mestreEhDeck(mestreEst.quem) ? syncBpmEfetivo(mestreEst.quem) : VbMxFase.bpmDoRelogio(mestreEst);
}
function mestreNome(){ return mestreEst.quem === "relogio" ? "relógio" : `deck ${mestreEst.quem}`; }

// Troca o estado inteiro e dá conta dos efeitos (um só lugar: botões, painel, sync, evento).
function mestreAplicar(novo){
  const mudouQuem = novo.quem !== mestreEst.quem, mudouBpm = VbMxFase.bpmDoRelogio(novo) !== VbMxFase.bpmDoRelogio(mestreEst);
  if (mudouBpm) mestreFase = VbMxFase.reancorarRelogio(mestreFase, VbMxFase.bpmDoRelogio(mestreEst), VbMxTocador.relogio());   // muda o tempo sem degrau de fase
  mestreEst = novo;
  if (mestreEhDeck(novo.quem) && decks[novo.quem].sync) {   // o mestre não segue ninguém: mantém o pitch em que está
    decks[novo.quem].sync = false;
    if (decks[novo.quem].faixa) atualizarNumerosDoDeck(novo.quem); else syncPintarBotao(novo.quem);
  }
  if (mudouQuem || mudouBpm) VbMxUI.emitir("mestre:mudou", { quem: novo.quem, bpm: mestreBpm(), auto: novo.auto });
  mestrePintar();
}
// Declarar um deck mestre desfaz a escolha explícita do relógio (ele volta a mandar só por padrão).
function mestreDeclarar(quem){ mestreAplicar({ ...VbMxFase.declararMestre(mestreEst, quem), relogioExplicito: quem === "relogio" && !!mestreEst.relogioExplicito }); }
// Botão MASTER do deck: liga; apertar de novo no mestre devolve ao relógio.
function mestreAlternar(letra){
  if (mestreEst.quem === letra) {
    const e = VbMxFase.declararMestre(mestreEst, "relogio");
    const b = syncBpmEfetivo(letra);
    mestreAplicar(b ? VbMxFase.definirBpmRelogio(e, b) : e);
  } else mestreDeclarar(letra);
}
// SYNC apertado em `letra` (deck.js): o líder é o outro deck, então ele vira o mestre quando `letra` era
// o mestre ou o relógio mandava só por padrão (AUTO).
function mestreAoSincronizar(letra){ mestreAplicar(VbMxFase.mestreAoSincronizar(mestreEst, letra)); }
// O deck parou, acabou ou saiu: o AUTO escolhe o novo mestre.
function mestreAoParar(letra){
  if (mestreEst.quem !== letra) return;
  const b = syncBpmEfetivo(letra);
  mestreAplicar(VbMxFase.aoPararMestre(mestreEst, letra, { A: !!decks.A.sync, B: !!decks.B.sync }, b));
}
function mestreDefinirAuto(ligado){
  try { VbMxPrefs.gravar("mestre.auto", !!ligado); } catch (_) { /* sem armazenamento: vale na sessão */ }
  mestreAplicar(VbMxFase.definirAuto(mestreEst, ligado));
}
// Mexer no relógio pelo painel faz do relógio o mestre (quem mexe no tempo dele quer que ele mande).
function mestreRelogio(fn){
  let e = mestreEst;
  if (e.quem !== "relogio") {
    const b = mestreBpm();
    e = VbMxFase.declararMestre(e, "relogio");
    if (b) e = VbMxFase.definirBpmRelogio(e, b);
  }
  mestreAplicar(fn(e));
}
function mestreAlternarPref(chave, atual){
  try { VbMxPrefs.gravar(chave, !atual); } catch (_) { /* sem armazenamento: vale na sessão */ }
  mestrePintar();
}
function mestreTap(){ mestreRelogio(e => VbMxFase.tapRelogio(e, VbMxTocador.relogio() || performance.now() / 1000)); }

// ---- Metrônomo: clique pelo AudioContext, agendado à frente (a varredura é só um despertador) ----
function mestreClique(em, forte){
  const ctx = garantirAudio(); if (!ctx) return;
  const osc = ctx.createOscillator(), g = ctx.createGain();
  osc.frequency.value = forte ? 1568 : 1046;
  g.gain.setValueAtTime(0.0001, em);
  g.gain.exponentialRampToValueAtTime(forte ? 0.5 : 0.3, em + 0.003);
  g.gain.exponentialRampToValueAtTime(0.0001, em + 0.05);
  osc.connect(g); g.connect(VbMxCadeia.derivar("clique"));   // GainNode próprio no fim do master (depois do volume): o gravador pode excluí-lo (VB-51)
  osc.start(em); osc.stop(em + 0.06);
}
// Próxima batida do deck mestre depois de `de`, na grade dele; null se não está tocando.
function mestreBatidaDoDeck(de){
  const l = mestreEst.quem, g = syncGrade(l);
  if (!g || !tocandoDeck(l)) return null;
  const e = VbMxTocador.estado(l, de);
  const n = Math.floor(VbMxGrade.batidaEm(g, e.posicao)) + 1;
  return { em: de + (VbMxGrade.tempoDaBatida(g, n) - e.posicao) / e.taxa, forte: ((n % 4) + 4) % 4 === 0 };
}
function mestreVarrer(){
  const ctx = garantirAudio(); if (!ctx || !mestreMetro.ligado) return;
  const agora = ctx.currentTime;
  if (mestreMetro.proximo < agora) mestreMetro.proximo = agora + 0.05;
  for (let i = 0; i < 8 && mestreMetro.proximo < agora + MESTRE_ANTECEDENCIA_S; i += 1) {
    if (mestreEhDeck(mestreEst.quem)) {
      const p = mestreBatidaDoDeck(Math.max(agora, mestreMetro.proximo));
      if (!p) { mestreMetro.proximo = agora + MESTRE_ANTECEDENCIA_S; break; }
      mestreClique(p.em, p.forte); mestreMetro.proximo = p.em + 0.01;
    } else {
      const t = VbMxFase.proximoTickDaFase(mestreFase, VbMxFase.bpmDoRelogio(mestreEst), mestreMetro.proximo);   // na fase do relógio, que o SYNC segue
      mestreClique(t.em, t.forte);
      mestreMetro.proximo = t.em + 0.01;
    }
  }
}
function mestreMetronomo(ligado){
  mestreMetro.ligado = !!ligado;
  if (mestreMetro.timer) { clearInterval(mestreMetro.timer); mestreMetro.timer = null; }
  if (mestreMetro.ligado) {
    const ctx = garantirAudio();
    if (!ctx) mestreMetro.ligado = false;
    else {
      if (ctx.state !== "running") ctx.resume().catch(() => {});
      mestreMetro.proximo = ctx.currentTime + 0.05; mestreMetro.n = 0;
      mestreMetro.timer = setInterval(mestreVarrer, MESTRE_VARREDURA_MS);
    }
  }
  mestrePintar();
}

// ---- Painel global e botões MASTER ----
function mestrePintarBotao(letra){
  const b = document.querySelector(`[data-deck="${letra}"] [data-master]`);
  if (!b) return;
  const eh = mestreEst.quem === letra;
  b.classList.toggle("tocando", eh); b.setAttribute("aria-pressed", String(eh));
}
function mestrePintar(){
  for (const l of ["A", "B"]) mestrePintarBotao(l);
  const p = document.getElementById("mestre-painel"); if (!p) return;
  const bpm = mestreBpm(), bend = mestreEst.bend;
  const campo = p.querySelector("[data-mestre-bpm]");
  if (campo && !campo.isContentEditable) campo.textContent = bpm ? bpm.toFixed(2) : "—";
  p.querySelector("[data-mestre-quem]").textContent = mestreNome();
  p.querySelector("[data-mestre-desloc]").textContent = mestreEst.quem === "relogio" && bend ? `${bend > 0 ? "+" : ""}${(bend * 100).toFixed(1)}%` : "";
  for (const [sel, on] of [["[data-mestre-master]", mestreEst.quem === "relogio"], ["[data-mestre-auto]", mestreEst.auto], ["[data-mestre-quant]", syncQuant()], ["[data-mestre-snap]", syncSnap()], ["[data-mestre-metro]", mestreMetro.ligado]]) {
    const b = p.querySelector(sel); b.classList.toggle("tocando", on); b.setAttribute("aria-pressed", String(on));
  }
}
function mestreMontarPainel(){
  const topo = document.querySelector("header.topo"); if (!topo || document.getElementById("mestre-painel")) return;
  const p = document.createElement("div");
  p.id = "mestre-painel"; p.className = "mestre-painel"; p.setAttribute("role", "group"); p.setAttribute("aria-label", "Tempo mestre");
  p.innerHTML = `
    <button class="botao mestre-btn" data-mestre-master aria-pressed="false" title="MASTER: o relógio interno vira o tempo mestre">MASTER</button>
    <span class="mestre-quem" data-mestre-quem></span>
    <span class="mestre-bpm mono" data-mestre-bpm tabindex="0" title="Tempo mestre (BPM). Duplo clique para digitar" aria-label="BPM do tempo mestre">—</span>
    <span class="mestre-desloc mono" data-mestre-desloc title="Deslocamento do bend do relógio"></span>
    <button class="botao mestre-btn" data-mestre-menos title="Desce o tempo do relógio em 0,1 BPM" aria-label="Descer o tempo mestre em 0,1 BPM">−</button>
    <button class="botao mestre-btn" data-mestre-mais title="Sobe o tempo do relógio em 0,1 BPM" aria-label="Subir o tempo mestre em 0,1 BPM">+</button>
    <button class="botao mestre-btn" data-mestre-bend-menos title="Bend: segure para atrasar o relógio" aria-label="Bend do relógio, atrasar">◀</button>
    <button class="botao mestre-btn" data-mestre-bend-mais title="Bend: segure para adiantar o relógio" aria-label="Bend do relógio, adiantar">▶</button>
    <button class="botao mestre-btn" data-mestre-tap title="TAP: bata no ritmo; vale após a 4ª batida" aria-label="Tap do tempo mestre">TAP</button>
    <button class="botao mestre-btn" data-mestre-metro aria-pressed="false" title="Metrônomo audível">TICK</button>
    <button class="botao mestre-btn" data-mestre-quant aria-pressed="false" title="QUANT: com ele ligado, saltos de cue e loop mantêm a batida (e loops e beatjump caem na grade)">QUANT</button>
    <button class="botao mestre-btn" data-mestre-snap aria-pressed="false" title="SNAP: com ele ligado, cues, hotcues e loops guardados caem na batida mais próxima">SNAP</button>
    <button class="botao mestre-btn" data-mestre-auto aria-pressed="false" title="AUTO: quando o mestre para, o deck em sync vira mestre (senão, o relógio)">AUTO</button>`;
  topo.insertBefore(p, topo.querySelector(".estado-global"));
  const q = s => p.querySelector(s);
  q("[data-mestre-master]").addEventListener("click", () => mestreAplicar({ ...VbMxFase.declararMestre(mestreEst, "relogio"), relogioExplicito: true }));
  q("[data-mestre-mais]").addEventListener("click", () => mestreRelogio(e => VbMxFase.passoRelogio(e, VbMxFase.PASSO_RELOGIO)));
  q("[data-mestre-menos]").addEventListener("click", () => mestreRelogio(e => VbMxFase.passoRelogio(e, -VbMxFase.PASSO_RELOGIO)));
  q("[data-mestre-tap]").addEventListener("pointerdown", mestreTap);
  q("[data-mestre-metro]").addEventListener("click", () => mestreMetronomo(!mestreMetro.ligado));
  q("[data-mestre-quant]").addEventListener("click", () => mestreAlternarPref("global.quant", syncQuant()));
  q("[data-mestre-snap]").addEventListener("click", () => mestreAlternarPref("global.snap", syncSnap()));
  q("[data-mestre-auto]").addEventListener("click", () => mestreDefinirAuto(!mestreEst.auto));
  for (const [sel, sinal] of [["[data-mestre-bend-mais]", 1], ["[data-mestre-bend-menos]", -1]]) {
    const b = q(sel);
    b.addEventListener("pointerdown", () => mestreRelogio(e => VbMxFase.bendRelogio(e, sinal * MESTRE_BEND)));
    for (const ev of ["pointerup", "pointerleave", "pointercancel"]) b.addEventListener(ev, () => { if (mestreEst.bend) mestreRelogio(e => VbMxFase.bendRelogio(e, 0)); });
  }
  const campo = q("[data-mestre-bpm]");
  campo.addEventListener("dblclick", () => {
    campo.contentEditable = "true"; campo.focus();
    const r = document.createRange(); r.selectNodeContents(campo); const s = getSelection(); s.removeAllRanges(); s.addRange(r);
  });
  const fechar = ok => {
    const v = parseFloat(campo.textContent.replace(",", "."));
    campo.contentEditable = "false";
    if (ok && Number.isFinite(v) && v > 0) mestreRelogio(e => VbMxFase.definirBpmRelogio(e, v));
    campo.blur(); mestrePintar();
  };
  campo.addEventListener("keydown", e => { if (campo.isContentEditable && (e.key === "Enter" || e.key === "Escape")) { e.preventDefault(); fechar(e.key === "Enter"); } });
  campo.addEventListener("blur", () => { if (campo.isContentEditable) fechar(false); });
  mestrePintar();
}

for (const ev of ["deck:pausou", "deck:fim", "deck:descarregado"]) VbMxUI.ouvir(ev, e => mestreAoParar(e.letra));
VbMxUI.ouvir("deck:pitch", e => { if (mestreEst.quem === e.letra) mestrePintar(); });
VbMxUI.registrar("acao", "mestre.tap", mestreTap);
VbMxUI.registrar("acao", "mestre.metronomo", () => mestreMetronomo(!mestreMetro.ligado));
VbMxUI.registrar("acao", "mestre.quant", () => mestreAlternarPref("global.quant", syncQuant()));
VbMxUI.registrar("acao", "mestre.snap", () => mestreAlternarPref("global.snap", syncSnap()));
VbMxUI.registrar("acao", "mestre.auto", () => mestreDefinirAuto(!mestreEst.auto));
for (const l of ["A", "B"]) VbMxUI.registrar("acao", `deck${l}.mestre`, () => mestreAlternar(l));
// VB-48: os efeitos seguem o BPM do tempo mestre (relógio ou deck mestre); sem BPM válido, o fx cai no padrão.
// Em aoIniciar porque o fx.js (que define VbMxFxUI) carrega depois deste arquivo.
VbMxUI.aoIniciar(() => VbMxFxUI.definirObterBpm(() => { const b = mestreBpm(); return b > 0 ? b : NaN; }));
VbMxUI.aoIniciar(mestreMontarPainel);
