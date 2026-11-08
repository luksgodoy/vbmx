// ===================== scratch.js — girar o prato, arrastar a onda, jog MIDI (VB-57) =====================
// Pedido do Lucas (2026-10-26): "deve ser possível girar os discos e fazer scratch, e também na waveform".
// Contas (puras): motor/scratch.js (VbMxScratch). Som: VbMxTocador.scratchPegar/Mover/Soltar (cabeça de
// scratch no worklet do key lock). Nome de topo com o prefixo `scratch`. No carregamento só registra ações.
//
//   prato, deck tocando   centro (até 70% do raio) = scratch: a música segue a mão, para trás e parada;
//                         soltar volta à taxa do pitch numa rampa curta (0,1 s), de onde a mão deixou.
//                         borda = tempo bend proporcional à velocidade (VbMxFase.bendDeck do VB-34 dá a
//                         fração cheia: girar a borda na velocidade do prato empurra 4% a 100% de sensibilidade).
//   prato, deck parado    qualquer ponto = busca fina, com o som do scratch.
//   uma volta do prato    1,8 s de música (disco de 33⅓ rpm); a marca do prato fica sob a mão.
//   onda de zoom          arrastar além de 4 px = scratch (a música anda sob a mão); clique simples = o de sempre
//                         (ligado em js/ondas.js, que chama scratchComecar/scratchAmostra/scratchEnviar/scratchTerminar).
//   ações (teclado/MIDI)  `deckA.jogScratch(delta)` e `deckA.jogBend(delta)` (e B): delta em passos de encoder,
//                         1/128 de volta cada; sem movimento por 80 ms o jog solta sozinho.
// Com SYNC aceso, a mão no deck (bend da borda, jog, scratch e a rampa de soltura) suspende a fase contínua do
// sync.js (scratchManual); ao soltar, ela volta pela rampa suave dela (VB-58, VbMxFase.correcaoDeDeriva).
// Primeira pegada (VB-58): ao carregar a faixa (deck:carregado), o worklet e a cópia da faixa são preparados em
// tempo ocioso (VbMxTocador.preCarregar), em fatias, sem travar a página; a 1ª pegada já tem som.

const SCRATCH_JOG_SOLTAR_MS = 80;
const scratchGesto = { A: null, B: null };   // {origem:'prato'|'onda'|'jog', modo:'scratch'|'bend', est, pend, ponteiro, jog, …}
const scratchRaf = { A: 0, B: 0 };

// A mão está no deck l (gesto em curso ou a rampa de soltura do scratch)? sync.js suspende a fase contínua.
function scratchManual(l){
  if (scratchGesto[l]) return true;
  try { return !!VbMxTocador.scratch(l).ativo; } catch (_) { return false; }
}
function scratchAquecer(){ try { VbMxTocador.prepararScratch(); } catch (_) { /* sem áudio ainda */ } }
function scratchTaxaDoPitch(l){
  try { return syncTaxa(l); } catch (_) { return VbMxReproducao.taxaDoPitch(decks[l].pitch, VbMxPitch.faixaDe(l)); }
}
// a seta de bend (sync.js, VB-34) está apertada? (try: se o sync.js não terminou de carregar, o nome fica em TDZ)
function scratchSetaDeBend(l){ try { return !!syncBend[l]; } catch (_) { return false; } }
function scratchBendAplicar(l, vel){
  if (scratchSetaDeBend(l)) return;   // a seta de bend apertada manda
  const cheia = VbMxFase.bendDeck(1, VbMxPrefs.ler("bend.sensibilidade"));
  VbMxTocador.definirTaxa(l, VbMxFase.taxaComBend(scratchTaxaDoPitch(l), VbMxScratch.fracaoDeBend(vel, cheia)));
}
// Começa um gesto no deck l. modo 'scratch' pega o disco (VbMxTocador.scratchPegar); 'bend' só mexe na taxa.
function scratchComecar(l, origem, modo, ponteiro){
  const d = decks[l];
  if (!d || !d.buffer) return null;
  if (scratchGesto[l]) scratchTerminar(l);
  const ctx = garantirAudio();   // é um gesto: pode criar o AudioContext
  if (ctx && ctx.state !== "running") ctx.resume().catch(()=>{});
  const g = { origem, modo, ponteiro, est: { vel: 0, t: performance.now() / 1000 }, pend: 0, jog: 0 };
  if (modo === "scratch") { d.previa = false; VbMxTocador.scratchPegar(l); }
  scratchGesto[l] = g;
  scratchLaco(l);
  return g;
}
// Uma amostra do movimento (deltaS = s de música, com sinal; tMs = timeStamp do evento).
function scratchAmostra(l, deltaS, tMs){
  const g = scratchGesto[l];
  if (!g || !Number.isFinite(deltaS)) return;
  g.est = VbMxScratch.estimar(g.est, deltaS, (Number.isFinite(tMs) ? tMs : performance.now()) / 1000);
  g.pend += deltaS;
}
// Manda ao tocador o que se acumulou desde o último envio (um por evento de ponteiro).
function scratchEnviar(l){
  const g = scratchGesto[l];
  if (!g) return;
  if (g.modo === "scratch") VbMxTocador.scratchMover(l, g.pend, g.est.vel);
  else scratchBendAplicar(l, g.est.vel);
  g.pend = 0;
}
function scratchTerminar(l){
  const g = scratchGesto[l];
  if (!g) return;
  scratchGesto[l] = null; clearTimeout(g.jog);
  if (g.modo === "scratch") VbMxTocador.scratchSoltar(l);
  else if (!scratchSetaDeBend(l)) VbMxTocador.definirTaxa(l, scratchTaxaDoPitch(l));
  emitirPosicao(l);
}
// Enquanto há gesto (ou a rampa de soltura): a mão parada zera a velocidade; prato, onda e tempo repintam.
function scratchLaco(l){
  if (scratchRaf[l]) return;
  const passo = () => {
    scratchRaf[l] = 0;
    const g = scratchGesto[l];
    if (g) {
      const est = VbMxScratch.ocioso(g.est, performance.now() / 1000);
      if (est !== g.est) { g.est = est; scratchEnviar(l); }
    }
    pintarPosicao(l); emitirPosicao(l);
    if (g || VbMxTocador.scratch(l).ativo) scratchRaf[l] = requestAnimationFrame(passo);
    else atualizarTransporte(l);   // botões e o laço de quadros do deck.js voltam ao normal
  };
  scratchRaf[l] = requestAnimationFrame(passo);
}

// ---- prato (js/deck-tela.js chama em cada renderDeck) ----
function scratchLigarPrato(el, l){
  if (!el || el.dataset.scratch) return;
  el.dataset.scratch = "1";
  el.addEventListener("pointerenter", scratchAquecer);
  el.addEventListener("pointerdown", ev=>{
    if (ev.button !== 0 || !decks[l].buffer) return;
    const rc = el.getBoundingClientRect(), cx = rc.left + rc.width / 2, cy = rc.top + rc.height / 2, raio = rc.width / 2;
    const zona = VbMxScratch.zonaDoToque(ev.clientX, ev.clientY, cx, cy, raio);
    if (!zona) return;
    ev.preventDefault();
    try { el.setPointerCapture(ev.pointerId); } catch (_) { /* sem captura */ }
    const g = scratchComecar(l, "prato", zona === "borda" && tocandoDeck(l) ? "bend" : "scratch", ev.pointerId);
    if (!g) return;
    Object.assign(g, { cx, cy, raioMin: Math.max(4, raio * 0.08), ang: VbMxScratch.anguloDoPonto(ev.clientX, ev.clientY, cx, cy) });
    el.dataset.toque = g.modo === "bend" ? "borda" : "centro";
  });
  el.addEventListener("pointermove", ev=>{
    const g = scratchGesto[l];
    if (!g || g.origem !== "prato" || g.ponteiro !== ev.pointerId) return;
    const lista = typeof ev.getCoalescedEvents === "function" ? ev.getCoalescedEvents() : [];
    for (const e of lista.length ? lista : [ev]) {
      if (Math.hypot(e.clientX - g.cx, e.clientY - g.cy) < g.raioMin) continue;   // no eixo o ângulo não tem sentido
      const a = VbMxScratch.anguloDoPonto(e.clientX, e.clientY, g.cx, g.cy);
      scratchAmostra(l, VbMxScratch.tempoDoAngulo(VbMxScratch.deltaAngulo(g.ang, a)), e.timeStamp);
      g.ang = a;
    }
    scratchEnviar(l);
  });
  const fim = ev=>{
    const g = scratchGesto[l];
    if (!g || g.origem !== "prato" || g.ponteiro !== ev.pointerId) return;
    scratchTerminar(l);
    delete el.dataset.toque;
  };
  for (const t of ["pointerup", "pointercancel", "lostpointercapture"]) el.addEventListener(t, fim);
}

// ---- jog por teclado/MIDI (encoders do VB-25/40) ----
function scratchJog(l, modo, delta){
  const passos = Number(delta);
  if (!decks[l] || !decks[l].buffer || !Number.isFinite(passos) || passos === 0) return;
  let g = scratchGesto[l];
  if (g && g.origem !== "jog") return;   // a mão no prato ou na onda manda
  const quer = modo === "bend" && tocandoDeck(l) ? "bend" : "scratch";
  if (g && g.modo !== quer) { scratchTerminar(l); g = null; }
  if (!g) g = scratchComecar(l, "jog", quer, null);
  if (!g) return;
  scratchAmostra(l, VbMxScratch.tempoDoPasso(passos), performance.now());
  scratchEnviar(l);
  clearTimeout(g.jog);
  g.jog = setTimeout(()=>{ if (scratchGesto[l] === g) scratchTerminar(l); }, SCRATCH_JOG_SOLTAR_MS);
}
// Rede de segurança: se o prato ou a onda for redesenhado no meio do gesto (renderDeck troca o HTML), a captura
// do ponteiro se perde sem aviso no elemento; soltar o botão em qualquer lugar, ou a janela perder o foco, solta.
VbMxUI.aoIniciar(()=>{
  const soltarPonteiro = ev=>{ for (const l of ["A", "B"]) { const g = scratchGesto[l]; if (g && g.origem !== "jog" && g.ponteiro === ev.pointerId) scratchTerminar(l); } };
  document.addEventListener("pointerup", soltarPonteiro);
  document.addEventListener("pointercancel", soltarPonteiro);
  window.addEventListener("blur", ()=>{ for (const l of ["A", "B"]) if (scratchGesto[l]) scratchTerminar(l); });
});
// VB-58: a faixa decodificou no deck — worklet, cabeça e cópia da faixa em tempo ocioso (a 1ª pegada tem som)
VbMxUI.ouvir("deck:carregado", ev=>{ try { VbMxTocador.preCarregar(ev.letra); } catch (_) { /* sem áudio */ } });
for (const l of ["A", "B"]) {
  VbMxUI.registrar("acao", `deck${l}.jogScratch`, delta => scratchJog(l, "scratch", delta));
  VbMxUI.registrar("acao", `deck${l}.jogBend`, delta => scratchJog(l, "bend", delta));
}
