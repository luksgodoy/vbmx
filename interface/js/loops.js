// ===================== loops.js — loops, beatjump e flux: slot deck-X-loops + camada-onda (VB-15) =====================
// Dono: VB-15. A conta é motor/loops.js (VbMxLoops, puro, testado em Node); aqui só há estado por deck,
// botões e a ponte com o VbMxTocador. No carregamento só declara e registra; o DOM nasce em aoIniciar.
//
// DECISÃO DE EXECUÇÃO (documentada, como o VB-15 pediu): o loop toca pelo próprio nó de fonte do tocador
// (loop/loopStart/loopEnd, via VbMxTocador.definirLoop). É exato na amostra e sem emenda, e não há
// reagendamento nenhum para atrasar ou falhar. O reagendamento só seria necessário para loops que o nó não
// faz (reverse, slip com tempo próprio), e esses são do VB-21, atrás da mesma API. Beatjump é um
// VbMxTocador.buscar (a fonte reinicia; a rampa anti-clique de 2–5 ms é do backend do VB-21).
//
// FLUX: o tocador mantém a cabeça DENTRO do loop; a "cabeça virtual" (onde a faixa estaria sem o loop) é só
// contabilidade de VbMxLoops.flux*, com relógio performance.now. Ao soltar o loop com flux ligado, a cabeça
// real salta para a virtual; sem flux, segue de onde está.
//
// Eventos: loop:mudou {letra, loop, ativo, flux}. Ações: deck<L>.loopIn/loopOut/loopAuto/loopMetade/loopDobro/
// loopMais/loopMenos/beatjumpMais/beatjumpMenos/flux (teclado e MIDI do VB-25 usam só isso).
VbMxUI.declararEvento("loop:mudou");
VbMxPrefs.declarar("loops.auto-detectar", VbMxLoops.LIMITE_AUTO_LOOP_PADRAO, { rotulo: "Faixa mais curta que (s) vira loop ao carregar; 0 desliga", tipo: "numero", min: 0, max: 600, modulo: "loops" });

const LOOPS_PASSOS = [...VbMxLoops.TAMANHOS, 64];          // tamanhos do salto e do passo de mover (batidas)
const LOOPS_MODOS = [["salto", "Salto"], ["loop", "Loop"], ["in", "In"], ["out", "Out"]];
const loopsEstado = {};
function loopsDeck(l){
  return loopsEstado[l] || (loopsEstado[l] = { loop: null, ativo: false, tamanho: 4, flux: false, fluxEst: null,
    modo: "salto", passo: 4, pendente: null });
}
const loopsRelogio = () => performance.now() / 1000;
// QUANT/SNAP globais (sync.js, botões em mestre.js) no lugar da antiga preferência loops.quantizar
function loopsOpc(l){ const f = decks[l].faixa; return { quantizar: syncQuant() || syncSnap(), duracao: f && VbMxTocador.estado(l).duracao || undefined }; }
function loopsGrade(l){ const d = decks[l]; return d.faixa ? VbMxGrade.daFaixa(d.faixa, d.cue || 0) : null; }
const loopsFmt = n => (n < 1 ? (n === 1/2 ? "1/2" : "1/" + Math.round(1/n)) : String(n));

function loopsAvisar(l){
  const s = loopsDeck(l);
  loopsDesenhar(l);
  VbMxUI.emitir("loop:mudou", { letra: l, loop: s.loop ? { ...s.loop } : null, ativo: s.ativo, flux: s.flux });
}
function loopsLigar(l, loop){            // liga (ou troca) o loop no tocador
  const s = loopsDeck(l);
  if (!s.ativo && s.flux) s.fluxEst = VbMxLoops.fluxIniciar(VbMxTocador.posicao(l), loopsRelogio(), VbMxTocador.estado(l).taxa, tocandoDeck(l));
  s.loop = loop; s.ativo = true;
  VbMxTocador.definirLoop(l, loop);
  loopsAvisar(l);
}
function loopsDesligar(l){
  const s = loopsDeck(l);
  if (!s.ativo) return;
  const virtual = s.flux && s.fluxEst ? VbMxLoops.fluxSair(s.fluxEst, loopsRelogio(), VbMxTocador.estado(l).duracao) : null;
  s.ativo = false; s.fluxEst = null;
  VbMxTocador.definirLoop(l, null);
  if (virtual !== null) VbMxTocador.buscar(l, virtual);
  loopsAvisar(l);
}
function loopsAuto(l){                   // LOOP: liga o loop guardado (ou um auto-loop) · de novo = solta
  const s = loopsDeck(l);
  if (!decks[l].faixa || !VbMxTocador.temBuffer(l)) return;
  if (s.ativo) { loopsDesligar(l); return; }
  // ACTIVE sem loop ativo liga o próximo loop guardado da faixa (hotcues tipo loop); sem nenhum, o último loop ou um auto-loop
  const reg = typeof hotcues !== "undefined" && hotcues.reg[l] && hotcues.faixa[l] === decks[l].faixa ? hotcues.reg[l] : null;
  const guardado = reg ? VbMxLoops.proximoGuardado(VbMxCues.loopsGuardados(reg), VbMxTocador.posicao(l)) : null;
  if (guardado) { loopsLigar(l, { inicio: guardado.inicio, fim: guardado.fim }); return; }
  const g = loopsGrade(l);
  const novo = s.loop || (g && VbMxLoops.autoLoop(g, VbMxTocador.posicao(l), s.tamanho, loopsOpc(l)));
  if (novo) loopsLigar(l, novo);
}
function loopsNovoAuto(l, batidas){      // escolher tamanho: com loop ativo, troca mantendo o IN
  const s = loopsDeck(l), g = loopsGrade(l);
  if (!g) return;
  s.tamanho = batidas;
  if (!VbMxTocador.temBuffer(l)) { loopsDesenhar(l); return; }
  const base = s.ativo && s.loop ? { quantizar: false } : loopsOpc(l);
  const novo = s.ativo && s.loop ? { inicio: s.loop.inicio, fim: s.loop.inicio + VbMxLoops.passo(g, batidas) }
                                 : VbMxLoops.autoLoop(g, VbMxTocador.posicao(l), batidas, base);
  if (novo && (!s.ativo || novo.fim <= (loopsOpc(l).duracao || Infinity))) loopsLigar(l, novo); else loopsDesenhar(l);
}
function loopsMaisMenos(l, dir){ const s = loopsDeck(l); loopsNovoAuto(l, dir > 0 ? VbMxLoops.maisTamanho(s.tamanho) : VbMxLoops.menosTamanho(s.tamanho)); }
function loopsIn(l){
  const s = loopsDeck(l), g = loopsGrade(l);
  if (!g || !VbMxTocador.temBuffer(l)) return;
  const ponto = VbMxLoops.pontoIn(g, VbMxTocador.posicao(l), loopsOpc(l));
  if (s.loop && s.ativo && ponto < s.loop.fim) { loopsLigar(l, { inicio: ponto, fim: s.loop.fim }); return; }
  s.pendente = ponto; loopsDesenhar(l);
}
function loopsOut(l){
  const s = loopsDeck(l), g = loopsGrade(l);
  if (!g || !VbMxTocador.temBuffer(l)) return;
  const pos = VbMxTocador.posicao(l);
  const inicio = s.pendente !== null ? s.pendente : (s.loop ? s.loop.inicio : null);
  const novo = inicio === null ? null : VbMxLoops.fecharLoop(g, inicio, pos, loopsOpc(l));
  s.pendente = null;
  if (novo) { s.tamanho = VbMxLoops.TAMANHOS.includes(VbMxLoops.batidasDoLoop(g, novo)) ? VbMxLoops.batidasDoLoop(g, novo) : s.tamanho; loopsLigar(l, novo); }
  else loopsDesenhar(l);
}
function loopsMetadeDobro(l, dobro){
  const s = loopsDeck(l), g = loopsGrade(l);
  if (!g) return;
  if (!s.loop) { loopsAuto(l); if (!s.loop) return; }
  const dur = loopsOpc(l).duracao;
  const novo = dobro ? VbMxLoops.dobrarLoop(g, s.loop, dur) : VbMxLoops.metadeLoop(g, s.loop);
  if (novo === s.loop) return;
  const b = VbMxLoops.batidasDoLoop(g, novo);
  if (VbMxLoops.TAMANHOS.some(t => Math.abs(t - b) < 1e-6)) s.tamanho = b;
  loopsLigar(l, novo);
}
function loopsFlux(l){
  const s = loopsDeck(l);
  s.flux = !s.flux;
  s.fluxEst = s.flux && s.ativo ? VbMxLoops.fluxIniciar(VbMxTocador.posicao(l), loopsRelogio(), VbMxTocador.estado(l).taxa, tocandoDeck(l)) : null;
  loopsAvisar(l);
}
function loopsMover(l, dir){             // ◂ ▸ conforme o modo: salto, loop inteiro, só o IN, só o OUT
  const s = loopsDeck(l), g = loopsGrade(l);
  if (!g || !VbMxTocador.temBuffer(l)) return;
  const bat = VbMxLoops.batidasDoPasso(g, s.passo, s.loop);   // 'loop' = tamanho do loop ativo; 'fino' = passo curto
  if (bat === null) return;
  const delta = dir * VbMxLoops.passo(g, bat), dur = loopsOpc(l).duracao;
  if (s.modo === "salto") {
    const r = VbMxLoops.saltarComLoop(g, VbMxTocador.posicao(l), s.ativo ? s.loop : null, dir * bat, loopsOpc(l));
    if (s.ativo && r.loop) { s.loop = r.loop; VbMxTocador.definirLoop(l, r.loop); }
    VbMxTocador.buscar(l, r.posicao);
    if (s.ativo && s.fluxEst) s.fluxEst = VbMxLoops.fluxIniciar(r.posicao, loopsRelogio(), VbMxTocador.estado(l).taxa, tocandoDeck(l));
    loopsAvisar(l); return;
  }
  if (!s.loop) return;
  const novo = s.modo === "loop" ? VbMxLoops.moverLoop(s.loop, delta, dur)
    : s.modo === "in" ? VbMxLoops.moverIn(s.loop, delta) : VbMxLoops.moverOut(s.loop, delta, dur);
  if (novo === s.loop) return;
  s.loop = novo;
  if (s.ativo) VbMxTocador.definirLoop(l, novo);
  loopsAvisar(l);
}
function loopsLimpar(l){
  const s = loopsDeck(l);
  Object.assign(s, { loop: null, ativo: false, fluxEst: null, pendente: null });
  loopsDesenhar(l);
}

// ---------- tela ----------
function loopsDesenhar(l){
  const el = VbMxUI.slot(`deck-${l}-loops`);
  if (!el) return;
  const s = loopsDeck(l), g = loopsGrade(l), livre = !decks[l].faixa || !VbMxTocador.temBuffer(l);
  const b = (acao, rot, titulo, extra = "") => `<button class="loops-bt pc-botao pc-botao--loop pc-compacto ${extra}" data-lp="${acao}" ${livre ? "disabled" : ""} title="${titulo}" aria-label="${titulo}, deck ${l}">${rot}</button>`;
  const info = s.loop ? `${s.loop.inicio.toFixed(2)} → ${s.loop.fim.toFixed(2)} s${g ? ` · ${loopsFmt(Math.round(VbMxLoops.batidasDoLoop(g, s.loop) * 1000) / 1000)} b` : ""}`
    : s.pendente !== null ? `IN em ${s.pendente.toFixed(2)} s · falta o OUT` : "sem loop";
  el.hidden = false;
  el.className = "loops-caixa";
  el.innerHTML = `
    <div class="loops-linha">
      <span class="rotulo">Loop ${l}</span>
      ${b("in", "IN", "Marca o ponto de entrada do loop")}${b("out", "OUT", "Fecha o loop e liga")}
      ${b("menos", "◂", "Loop menor (metade do tamanho da lista)")}<span class="loops-tam mono" title="Tamanho do auto-loop em batidas">${loopsFmt(s.tamanho)}</span>${b("mais", "▸", "Loop maior")}
      ${b("auto", "LOOP", "Liga e solta o loop (auto-loop do tamanho ao lado)", "loops-liga" + (s.ativo ? " ligado" : ""))}
      ${b("metade", "½", "Metade do loop, mantém o IN")}${b("dobro", "×2", "Dobra o loop, mantém o IN")}
      ${b("flux", "FLUX", "Flux: ao soltar o loop, a cabeça volta onde a faixa estaria", "loops-flux" + (s.flux ? " ligado" : ""))}
    </div>
    <div class="loops-linha">
      <span class="rotulo">Mover</span>
      ${LOOPS_MODOS.map(([m, r]) => `<button class="loops-bt pc-botao pc-botao--loop pc-compacto ${s.modo === m ? "ligado" : ""}" data-lp-modo="${m}" aria-pressed="${s.modo === m}" title="◂ ▸ movem: ${r}">${r}</button>`).join("")}
      ${b("recuar", "◂◂", "Recua o passo ao lado")}<select class="loops-passo mono" data-lp-passo aria-label="Passo em batidas, deck ${l}">${LOOPS_PASSOS.map(p => `<option value="${p}" ${p === s.passo ? "selected" : ""}>${loopsFmt(p)}</option>`).join("")}<option value="loop" ${s.passo === "loop" ? "selected" : ""}>Loop</option><option value="fino" ${s.passo === "fino" ? "selected" : ""}>Fino</option></select>${b("avancar", "▸▸", "Avança o passo ao lado")}
    </div>
    <div class="loops-info mono" role="status">${info}${s.flux ? " · flux" : ""}</div>`;
}
function loopsAoClicar(l, e){
  const alvo = e.target.closest("[data-lp],[data-lp-modo]");
  if (!alvo || alvo.disabled) return;
  if (alvo.dataset.lpModo) { loopsDeck(l).modo = alvo.dataset.lpModo; loopsDesenhar(l); return; }
  const a = alvo.dataset.lp;
  if (a === "in") loopsIn(l); else if (a === "out") loopsOut(l); else if (a === "auto") loopsAuto(l);
  else if (a === "menos") loopsMaisMenos(l, -1); else if (a === "mais") loopsMaisMenos(l, 1);
  else if (a === "metade") loopsMetadeDobro(l, false); else if (a === "dobro") loopsMetadeDobro(l, true);
  else if (a === "flux") loopsFlux(l); else if (a === "recuar") loopsMover(l, -1); else if (a === "avancar") loopsMover(l, 1);
}

VbMxUI.aoIniciar(() => {
  for (const l of ["A", "B"]) {
    const el = VbMxUI.slot(`deck-${l}-loops`);
    if (!el) continue;
    el.addEventListener("click", e => loopsAoClicar(l, e));
    el.addEventListener("change", e => { const p = e.target.closest("[data-lp-passo]"); if (p) { loopsDeck(l).passo = p.value === "loop" || p.value === "fino" ? p.value : Number(p.value); loopsDesenhar(l); } });
    loopsDesenhar(l);
  }
});

// ---------- ações (teclado/MIDI) ----------
for (const l of ["A", "B"]) {
  const A = (n, fn) => VbMxUI.registrar("acao", `deck${l}.${n}`, fn);
  A("loopIn", () => loopsIn(l)); A("loopOut", () => loopsOut(l)); A("loopAuto", () => loopsAuto(l));
  A("loopMetade", () => loopsMetadeDobro(l, false)); A("loopDobro", () => loopsMetadeDobro(l, true));
  A("loopMais", () => loopsMaisMenos(l, 1)); A("loopMenos", () => loopsMaisMenos(l, -1));
  A("beatjumpMais", () => { loopsDeck(l).modo = "salto"; loopsMover(l, 1); });
  A("beatjumpMenos", () => { loopsDeck(l).modo = "salto"; loopsMover(l, -1); });
  A("flux", () => loopsFlux(l));
  for (const n of VbMxMapaControle.TAMANHOS_LOOP) A(`loopTam${VbMxMapaControle.nomeTamanho(n)}`, () => loopsNovoAuto(l, n));   // VB-48
}

// ---------- vida do deck ----------
VbMxUI.ouvir("deck:carregado", d => {
  loopsLimpar(d.letra);
  // VB-43: faixa curta (menor que a preferência) entra com o loop ativo cobrindo-a (compassos inteiros pela grade) e marcadores verdes
  const loop = VbMxLoops.loopDaCarga(loopsGrade(d.letra), d.duracao, VbMxPrefs.ler("loops.auto-detectar"));
  if (loop && VbMxTocador.temBuffer(d.letra)) loopsLigar(d.letra, loop);
});
VbMxUI.ouvir("deck:descarregado", d => loopsLimpar(d.letra));
VbMxUI.ouvir("deck:pausou", d => { const s = loopsDeck(d.letra); if (s.fluxEst) s.fluxEst = VbMxLoops.fluxPausar(s.fluxEst, loopsRelogio()); });
VbMxUI.ouvir("deck:tocou", d => { const s = loopsDeck(d.letra); if (s.fluxEst) s.fluxEst = VbMxLoops.fluxRetomar(s.fluxEst, loopsRelogio()); });
VbMxUI.ouvir("deck:pitch", d => { const s = loopsDeck(d.letra); if (s.fluxEst) s.fluxEst = VbMxLoops.fluxMudarTaxa(s.fluxEst, loopsRelogio(), d.taxa); });
// O transporte solta o loop sozinho se a cabeça é levada para depois dele (busca na onda): acompanhar, sem saltar.
VbMxUI.ouvir("deck:posicao", d => {
  const s = loopsDeck(d.letra);
  if (s.ativo && !VbMxTocador.estado(d.letra).loop) { s.ativo = false; s.fluxEst = null; loopsAvisar(d.letra); }
});

// ---------- camada na onda: região do loop em verde e, com flux, a linha da cabeça virtual ----------
VbMxUI.registrar("camada-onda", (c, deck, janela) => {
  const s = loopsEstado[deck.letra];
  if (!s || !s.loop) return;
  const x0 = janela.x(s.loop.inicio), x1 = janela.x(s.loop.fim);
  if (x1 < 0 || x0 > c.w) return;
  const a = Math.max(x0, 0), b = Math.min(x1, c.w);
  c.g.fillStyle = s.ativo ? "rgba(122,212,140,0.22)" : "rgba(122,212,140,0.08)";
  c.g.fillRect(a, 0, Math.max(b - a, 1), c.h);
  c.g.fillStyle = "rgba(122,212,140,0.9)";
  const e = Math.max(c.dpr || 1, 1);
  if (x0 >= 0 && x0 <= c.w) c.g.fillRect(x0, 0, e, c.h);
  if (x1 >= 0 && x1 <= c.w) c.g.fillRect(x1 - e, 0, e, c.h);
  if (s.ativo && s.fluxEst) {
    const x = janela.x(VbMxLoops.fluxPosicao(s.fluxEst, loopsRelogio(), VbMxTocador.estado(deck.letra).duracao));
    if (x >= 0 && x <= c.w) { c.g.fillStyle = "#7ad48c"; c.g.fillRect(x - e, 0, 2 * e, c.h); }
  }
});
