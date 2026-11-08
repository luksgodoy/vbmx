// ===================== hotcues.js — hot cues: slot deck-X-hotcues e camada-onda dos marcadores =====================
// Dono: VB-14 (onda 1). No carregamento só declara e registra (VbMxUI.registrar/ouvir); o DOM entra em
// VbMxUI.aoIniciar. Nome de topo com prefixo `hotcues`. Contrato: docs/contratos.md.
//
// Regras (docs/decisoes.md, P4 e a decisão do CUE de 2026-10-25):
//  - 8 slots por deck. Clique em vazio DEFINE na posição da cabeça; em cheio SALTA (tocando: pula e segue;
//    parado: toca em prévia enquanto apertado e volta ao ponto ao soltar). Shift+clique ou o ✕ APAGA;
//    Alt+clique gira o tipo (cue → fade-in → fade-out → load → grid → loop).
//  - Slot vazio com loop ativo guarda o LOOP (verde, início e fim); acionar de novo religa o loop. Os pontos
//    novos caem na grade se o SNAP global estiver ligado.
//  - MAP: clique no slot de origem, ligue MAP, clique no destino (ocupado troca). Lista de cues: ◀ ▶, tipo, apagar, STORE.
//  - Cue principal e hotcues ficam em IndexedDB `vbmx-cues-v1` (biblioteca/marcadores.js), chave
//    caminho+tamanho+mtime do arquivo; nunca no arquivo de áudio. As regras do botão CUE não mudam: só
//    passam a ser lembradas (aqui ouvimos `deck:cue`; deck.js e estado.js não foram tocados).
//  - Marcador tipo "load": ao carregar, a cabeça vai para o ponto (se o deck está parado).
//  - Os marcadores aparecem nas ondas pela camada registrada (zoom e visão geral).
//  - Ações para teclado/MIDI (VB-25): deck{A|B}.hotcue{1..8}(descer = true) — chame com false ao soltar.
const hotcues = {
  reg: { A: null, B: null },        // estado de VbMxCues por deck (null = sem faixa pronta)
  faixa: { A: null, B: null },      // a faixa a que o reg pertence
  chave: { A: null, B: null },
  previa: { A: -1, B: -1 },         // slot em prévia (parado, apertado), ou -1
  tipo: { A: "cue", B: "cue" },     // tipo dos próximos hotcues definidos
  persistencia: null,
  map: { A: false, B: false },      // MAP ligado: o próximo clique em slot é o destino
  origem: { A: -1, B: -1 },         // slot de origem do MAP (o último clicado, cheio)
  sel: { A: -1, B: -1 },            // hotcue selecionado na lista de cues
};
// Quantização à grade: a preferência global `quant` (VB-34+36) se existir; senão a dos loops, que já há.
function hotcuesQuantizar(letra){
  const q = typeof syncSnap === "function" && syncSnap();   // SNAP global (mestre.js)
  const d = decks[letra];
  const g = q && d.faixa && typeof VbMxGrade !== "undefined" ? VbMxGrade.daFaixa(d.faixa, d.cue || 0) : null;
  return g ? (t => VbMxGrade.quantizar(g, t)) : undefined;
}
function hotcuesLoopAtivo(letra){
  const s = typeof loopsEstado !== "undefined" && loopsEstado[letra];
  return s && s.ativo && s.loop ? { inicio: s.loop.inicio, fim: s.loop.fim } : undefined;
}
function hotcuesPersistencia(){
  if (!hotcues.persistencia) hotcues.persistencia = VbMxMarcadores.doNavegador();
  return hotcues.persistencia;
}
function hotcuesPronto(letra){
  const d = decks[letra];
  return !!(d.buffer && hotcues.reg[letra] && hotcues.faixa[letra] === d.faixa && hotcues.chave[letra]);
}
function hotcuesSalvar(letra){
  if (!hotcues.chave[letra] || !hotcues.reg[letra]) return;
  hotcuesPersistencia().gravar(hotcues.chave[letra], hotcues.reg[letra]);   // falha do armazém vira false, sem erro
}
// Chave estável da faixa: caminho + tamanho + mtime do arquivo (o File sai de obter(), já em cache do navegador).
async function hotcuesChaveDa(faixa){
  let tamanho = -1, data = -1;
  try { const arq = await faixa.obter(); tamanho = arq.size; data = arq.lastModified; } catch(_){}
  return VbMxMarcadores.chave(faixa.caminho || String(faixa.id), tamanho, data);
}
async function hotcuesAoCarregar(ev){
  const { letra, faixa, duracao } = ev, d = decks[letra];
  hotcues.reg[letra] = null; hotcues.chave[letra] = null; hotcues.previa[letra] = -1;
  hotcuesDesenhar(letra);
  if (typeof faixa.obter !== "function") return;
  const meu = d.token, chave = await hotcuesChaveDa(faixa);
  const guardado = await hotcuesPersistencia().ler(chave);
  if (d.token !== meu || d.faixa !== faixa) return;                // trocou de faixa enquanto lia
  const reg = VbMxCues.normalizar(guardado, duracao);
  hotcues.reg[letra] = reg; hotcues.faixa[letra] = faixa; hotcues.chave[letra] = chave;
  // O CUE passa a ser lembrado: se esta sessão ainda não mexeu nele (estado.js só guarda ao mudar), vale o do disco.
  if (guardado && !cuesPorFaixa.has(chaveCue(faixa)) && !(d.cue > 0)) {
    d.cue = VbMxWaveform.travarCue(reg.cue, duracao); guardarCue(d);
    if (!tocandoDeck(letra)) VbMxTocador.buscar(letra, d.cue);
    VbMxUI.emitir("deck:cue", { letra, faixa, cue: d.cue });
  } else {
    hotcues.reg[letra] = VbMxCues.definirCue(reg, d.cue, duracao);
  }
  const load = VbMxCues.pontoDeLoad(hotcues.reg[letra]);
  if (load !== null && !tocandoDeck(letra)) VbMxTocador.buscar(letra, load);
  hotcuesDesenhar(letra); atualizarTransporte(letra);
}
function hotcuesAoMudarCue(ev){
  const { letra, cue } = ev;
  if (!hotcuesPronto(letra)) return;
  hotcues.reg[letra] = VbMxCues.definirCue(hotcues.reg[letra], cue, decks[letra].buffer.duration);
  hotcuesSalvar(letra);
}
function hotcuesAoDescarregar(ev){
  const { letra } = ev;
  hotcues.reg[letra] = null; hotcues.chave[letra] = null; hotcues.faixa[letra] = null; hotcues.previa[letra] = -1;
  hotcuesDesenhar(letra);
}

// ---- ação do usuário -------------------------------------------------------------------------
function hotcuesApertar(letra, slot, mods){
  mods = mods || {};
  const d = decks[letra];
  if (!hotcuesPronto(letra)) return;
  const dur = d.buffer.duration;
  // MAP ligado: com origem, este clique é o destino (o mover troca se ocupado); sem origem, um slot cheio vira a origem.
  if (hotcues.map[letra] && !mods.apagar && !mods.trocarTipo) {
    const cheio = !!hotcues.reg[letra].hotcues[slot], o = hotcues.origem[letra];
    if (o >= 0 && o !== slot) { hotcues.reg[letra] = VbMxCues.mover(hotcues.reg[letra], o, slot); hotcuesSalvar(letra); hotcues.map[letra] = false; hotcues.origem[letra] = -1; hotcues.sel[letra] = slot; }
    else if (cheio) hotcues.origem[letra] = slot;
    hotcuesDesenhar(letra); return;
  }
  const r = VbMxCues.acionar(hotcues.reg[letra], slot, { apagar: mods.apagar, trocarTipo: mods.trocarTipo,
    tipo: hotcues.tipo[letra], posicao: syncPonto(letra, VbMxTocador.posicaoNaTela(letra)), duracao: dur,   // o ponto que SOA, não o do comando (~30 ms adiante)
    loop: hotcuesLoopAtivo(letra), quantizar: hotcuesQuantizar(letra) });
  if (r.reg !== hotcues.reg[letra]) { hotcues.reg[letra] = r.reg; hotcuesSalvar(letra); }
  if (r.acao === "saltar" || r.acao === "definir") { hotcues.origem[letra] = slot; hotcues.sel[letra] = slot; }
  if (r.acao === "apagar" && hotcues.origem[letra] === slot) hotcues.origem[letra] = -1;
  // A regra é de motor/cues.js (efeitoDeApertar): parado, o hotcue age como CUE (segurar toca, soltar volta e para).
  const ef = VbMxCues.efeitoDeApertar(r, tocandoDeck(letra));
  if (ef.buscar !== null) {
    const ctx = garantirAudio();
    VbMxTocador.buscar(letra, syncDestino(letra, ef.buscar));   // QUANT: tocando, mantém a batida
    if (ef.loop && typeof loopsLigar === "function") loopsLigar(letra, ef.loop);   // slot de loop: o loop volta
    if (ef.tocar && ctx) {
      if (ctx.state !== "running") ctx.resume().catch(()=>{});
      VbMxTocador.tocar(letra); hotcues.previa[letra] = slot;
    }
  }
  hotcuesDesenhar(letra); atualizarTransporte(letra);
}
function hotcuesSoltar(letra){
  const slot = hotcues.previa[letra];
  if (slot < 0) return;
  hotcues.previa[letra] = -1;
  const ef = VbMxCues.efeitoDeSoltar(hotcues.reg[letra], slot, tocandoDeck(letra));
  if (ef.pausar) VbMxTocador.pausar(letra);
  if (ef.soltarLoop && typeof loopsDesligar === "function") loopsDesligar(letra);   // a prévia do loop acaba com o botão
  if (ef.buscar !== null) VbMxTocador.buscar(letra, ef.buscar);
  hotcuesDesenhar(letra); atualizarTransporte(letra);
}

// ---- tela (slot) ------------------------------------------------------------------------------
function hotcuesFmt(t){ const s = Math.floor(t); return `${Math.floor(s/60)}:${String(s%60).padStart(2,"0")}`; }
// ---- lista de cues: anterior/próximo, tipo, apagar, STORE, MAP --------------------------------
function hotcuesListaAcao(letra, acao){
  if (!hotcuesPronto(letra)) return;
  const reg = hotcues.reg[letra], dur = decks[letra].buffer.duration;
  if (acao === "map") { hotcues.map[letra] = !hotcues.map[letra]; if (!hotcues.map[letra]) hotcues.origem[letra] = -1; }
  else if (acao === "anterior" || acao === "proximo") {
    const sel = reg.hotcues[hotcues.sel[letra]];
    const s = VbMxCues.vizinho(reg, sel ? sel.t : VbMxTocador.posicao(letra), acao === "anterior" ? -1 : 1);
    if (s !== null) { hotcues.sel[letra] = s; VbMxTocador.buscar(letra, reg.hotcues[s].t); }
  } else if (acao === "apagar") {
    const s = hotcues.sel[letra];
    if (reg.hotcues[s]) { hotcues.reg[letra] = VbMxCues.apagar(reg, s); hotcues.sel[letra] = -1; hotcuesSalvar(letra); }
  } else if (acao === "tipo") {
    const s = hotcues.sel[letra];
    if (reg.hotcues[s]) { hotcues.reg[letra] = VbMxCues.trocarTipo(reg, s); hotcuesSalvar(letra); }
  } else if (acao === "store") {
    const r = VbMxCues.armazenar(reg, VbMxTocador.posicaoNaTela(letra), { tipo: hotcues.tipo[letra], loop: hotcuesLoopAtivo(letra), quantizar: hotcuesQuantizar(letra) }, dur);
    if (r.slot !== null) { hotcues.reg[letra] = r.reg; hotcues.sel[letra] = r.slot; hotcuesSalvar(letra); }
  }
  hotcuesDesenhar(letra); atualizarTransporte(letra);
}
function hotcuesDesenhar(letra){
  const el = VbMxUI.slot(`deck-${letra}-hotcues`);
  if (!el) return;
  const reg = hotcues.reg[letra], pronto = hotcuesPronto(letra);
  const opcoes = VbMxCues.ORDEM_TIPOS.map(t=>`<option value="${t}"${t===hotcues.tipo[letra]?" selected":""}>${VbMxCues.TIPOS[t].rotulo}</option>`).join("");
  let celulas = "";
  for (let i = 0; i < VbMxCues.SLOTS; i++) {
    const h = reg && reg.hotcues[i], cor = h ? VbMxCues.corDe(h) : "";
    const rot = h ? `${VbMxCues.TIPOS[h.tipo].rotulo} · ${hotcuesFmt(h.t)}${h.nome ? " · " + h.nome : ""}` : "vazio";
    celulas += `<div class="hotcues-celula${h?" cheio":""}${hotcues.previa[letra]===i?" previa":""}${hotcues.sel[letra]===i?" sel":""}${hotcues.map[letra]&&hotcues.origem[letra]===i?" origem":""}"${h?` style="--cor:${cor}"`:""}>`
      + `<button class="hotcues-slot pc-hotcue${h?" pc-cheio":""}" data-hc="${i}" ${pronto?"":"disabled"} aria-label="Hotcue ${i+1} do deck ${letra}: ${esc(rot)}" `
      + `title="${h ? "Clique salta (parado: segure para ouvir) · Shift+clique apaga · Alt+clique muda o tipo" : "Clique define aqui"}">`
      + `<b>${i+1}</b><span>${h ? hotcuesFmt(h.t) : "—"}</span></button>`
      + (h ? `<button class="hotcues-apagar" data-hc-apagar="${i}" aria-label="Apagar o hotcue ${i+1} do deck ${letra}" title="Apagar">✕</button>` : "")
      + `</div>`;
  }
  const sel = reg && reg.hotcues[hotcues.sel[letra]];
  const dis = pronto ? "" : "disabled";
  const lista = `<div class="hotcues-lista" role="group" aria-label="Lista de cues do deck ${letra}">`
    + `<button data-hc-acao="anterior" ${dis} aria-label="Cue anterior" title="Cue anterior">◀</button>`
    + `<button data-hc-acao="proximo" ${dis} aria-label="Próximo cue" title="Próximo cue">▶</button>`
    + `<span class="hotcues-info" aria-live="polite">${sel ? `${hotcues.sel[letra]+1} · ${VbMxCues.TIPOS[sel.tipo].rotulo} · ${VbMxCues.formatarTempo(sel.t)}${sel.fim ? " → " + VbMxCues.formatarTempo(sel.fim) : ""}` : "nenhum cue selecionado"}</span>`
    + `<button data-hc-acao="tipo" ${sel?"":"disabled"} title="Muda o tipo do cue selecionado">Tipo</button>`
    + `<button data-hc-acao="apagar" ${sel?"":"disabled"} title="Apaga o cue selecionado">Apagar</button>`
    + `<button data-hc-acao="store" ${dis} title="Grava a posição (ou o loop ativo) no próximo slot livre">STORE</button>`
    + `<button data-hc-acao="map" ${dis} aria-pressed="${hotcues.map[letra]}" class="${hotcues.map[letra]?"ligado":""}" title="Clique o slot de origem, ligue MAP e clique o destino">MAP</button></div>`;
  el.innerHTML = `<div class="hotcues-cab"><span class="hotcues-titulo">Hotcues ${letra}</span>`
    + `<label class="hotcues-tipo">novo: <select data-hc-tipo ${pronto?"":"disabled"} aria-label="Tipo dos próximos hotcues do deck ${letra}">${opcoes}</select></label></div>`
    + `<div class="hotcues-grade">${celulas}</div>` + lista;
  el.hidden = false;
}
function hotcuesLigar(letra){
  const el = VbMxUI.slot(`deck-${letra}-hotcues`);
  if (!el) return;
  el.classList.add("hotcues");
  el.addEventListener("click", e=>{
    const a = e.target.closest("[data-hc-acao]");
    if (a && !a.disabled) hotcuesListaAcao(letra, a.dataset.hcAcao);
  });
  el.addEventListener("pointerdown", e=>{
    const b = e.target.closest("[data-hc]"), x = e.target.closest("[data-hc-apagar]");
    if (x) { e.preventDefault(); hotcuesApertar(letra, Number(x.dataset.hcApagar), { apagar: true }); return; }
    if (!b || b.disabled || e.button !== 0) return;
    e.preventDefault();
    try { b.setPointerCapture(e.pointerId); } catch(_){}
    hotcuesApertar(letra, Number(b.dataset.hc), { apagar: e.shiftKey, trocarTipo: e.altKey && !e.shiftKey });
  });
  for (const ev of ["pointerup","pointercancel"]) el.addEventListener(ev, ()=>hotcuesSoltar(letra));
  el.addEventListener("change", e=>{ if (e.target.matches("[data-hc-tipo]")) hotcues.tipo[letra] = e.target.value; });
  el.addEventListener("keydown", e=>{                       // Enter/Espaço no botão focado = clique sem soltar
    const b = e.target.closest && e.target.closest("[data-hc]");
    if (b && !b.disabled && (e.key === "Enter" || e.key === " ") && !e.repeat) { e.preventDefault(); hotcuesApertar(letra, Number(b.dataset.hc), { apagar: e.shiftKey }); }
  });
  el.addEventListener("keyup", e=>{ if (e.key === "Enter" || e.key === " ") hotcuesSoltar(letra); });
}

// ---- camada nas ondas (zoom e visão geral) ---------------------------------------------------
function hotcuesCamada(c, deck, janela){
  const reg = hotcues.reg[deck.letra];
  if (!reg || !deck.d.picos || hotcues.faixa[deck.letra] !== deck.d.faixa) return;
  const { g, h, dpr } = c, lw = Math.max(1, Math.round(dpr)), tam = Math.round(9*dpr);
  g.font = `700 ${Math.round(9*dpr)}px "JetBrains Mono", monospace`; g.textAlign = "center"; g.textBaseline = "middle";
  for (const m of VbMxCues.visiveis(reg, janela.inicio, janela.fim)) {
    const x = Math.round(janela.x(m.t));
    if (x < -tam || x > c.w + tam) continue;
    g.fillStyle = m.cor; g.fillRect(x - Math.floor(lw/2), 0, lw, h);
    g.fillRect(x, 0, tam, tam + 2*dpr);                      // bandeira com o número, à direita da linha
    g.fillStyle = "#0d0f12"; g.fillText(String(m.numero), x + tam/2, tam/2 + dpr);
  }
}

VbMxUI.registrar("camada-onda", hotcuesCamada);
VbMxUI.ouvir("deck:carregado", hotcuesAoCarregar);
VbMxUI.ouvir("deck:descarregado", hotcuesAoDescarregar);
VbMxUI.ouvir("deck:cue", hotcuesAoMudarCue);
for (const L of ["A","B"]) for (let n = 1; n <= VbMxCues.SLOTS; n++) {
  VbMxUI.registrar("acao", `deck${L}.hotcue${n}`, (descer = true)=>{ if (descer) hotcuesApertar(L, n-1); else hotcuesSoltar(L); });
}
VbMxUI.aoIniciar(()=>{ for (const L of ["A","B"]) { hotcuesLigar(L); hotcuesDesenhar(L); } });
