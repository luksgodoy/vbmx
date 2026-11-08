// ---- Waveform: picos já calculados na carga (d.picos); aqui só se desenha. ----
// Depois de cada canvas com onda, as camadas registradas (VbMxUI.registrar("camada-onda", fn)) desenham
// por cima: grade de batidas, hot cues, loop… (docs/contratos.md). Este arquivo é intocável na onda 1.
const COR_TOCADO = "rgba(242,177,52,.9)", COR_RESTO = "rgba(154,163,178,.5)", COR_CUE = VbMxCues.CUE_FLUTUANTE.cor, COR_CABECA = "#e6e8ec";
// Modo da onda (VB-28): "espectro" pinta cada coluna pela cor das 3 bandas (mais claro = mais agudo);
// "onda" é a cor lisa de antes. As cores por coluna saem de VbMxWaveform.coresPorColuna (uma vez por faixa).
VbMxPrefs.declarar("onda.modo", "espectro", { tipo: "opcao", modulo: "onda", rotulo: "Modo da onda",
  opcoes: [{ valor: "espectro", rotulo: "Espectro (cor pelas frequências)" }, { valor: "onda", rotulo: "Onda lisa" }] });
function coresDaOnda(d){ return VbMxPrefs.ler("onda.modo") === "espectro" ? VbMxWaveform.coresPorColuna(d.picos) : null; }
function ajustarCanvas(cv){
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(cv.clientWidth*dpr) || 600, h = Math.round(cv.clientHeight*dpr) || 64;
  if (cv.width!==w) cv.width = w;
  if (cv.height!==h) cv.height = h;
  const g = cv.getContext("2d"); g.clearRect(0,0,w,h);
  return { g, w, h, dpr };
}
function mensagemNaOnda(c, texto){
  c.g.fillStyle = "#9aa3b2"; c.g.font = `${Math.round(12*c.dpr)}px "JetBrains Mono", monospace`;
  c.g.textAlign = "center"; c.g.textBaseline = "middle"; c.g.fillText(texto, c.w/2, c.h/2);
}
// Cue flutuante (spec §5): o cue principal do deck, branco (VbMxCues.CUE_FLUTUANTE), com bandeira em losango —
// distinto dos hotcues, que levam número e a cor do tipo.
function marcadorCue(c, x){
  const lw = Math.max(1, Math.round(c.dpr)), tri = Math.round(5*c.dpr);
  c.g.fillStyle = COR_CUE; c.g.fillRect(Math.round(x - lw/2), 0, lw, c.h);
  c.g.beginPath(); c.g.moveTo(x - tri, 0); c.g.lineTo(x + tri, 0); c.g.lineTo(x, tri*1.3); c.g.closePath(); c.g.fill();
  c.g.beginPath(); c.g.moveTo(x - tri, c.h); c.g.lineTo(x + tri, c.h); c.g.lineTo(x, c.h - tri*1.3); c.g.closePath(); c.g.fill();
}
function fmtCue(t){ const s = Math.floor(t), dec = Math.floor((t - s)*10); return `${VbMxReproducao.formatarTempo(s)}.${dec}`; }
function desenharZoom(cv, d, pos, letra){
  const c = ajustarCanvas(cv), { g, w, h, dpr } = c;
  if (!d.picos) { mensagemNaOnda(c, d.faixa ? (d.carga || "sem áudio") : "deck vazio — arraste uma faixa para cá"); return; }
  const J = VbMxWaveform.janelaDoZoom(d.picos, pos, w, VbMxWaveform.JANELA_SEG), esc = (h/2 - 2*dpr) / Math.max(d.picos.pico, 1e-6), cx = Math.floor(w/2);
  const cores = coresDaOnda(d), J_ = VbMxWaveform.JANELA_SEG;
  for (let x = 0; x < w; x++) {
    if (!J.dentro[x]) continue;
    if (cores) {
      const k = Math.min(cores.length - 1, Math.max(0, Math.floor(VbMxWaveform.tempoNoZoom(x + .5, pos, w, J_) * d.picos.porSeg)));
      g.fillStyle = cores[k]; g.globalAlpha = x < cx ? 1 : .55;
    } else g.fillStyle = x < cx ? COR_TOCADO : COR_RESTO;
    g.fillRect(x, h/2 - J.max[x]*esc, 1, Math.max(1, (J.max[x] - J.min[x])*esc));
  }
  g.globalAlpha = 1;
  const xc = VbMxWaveform.colunaNoZoom(d.cue, pos, w, VbMxWaveform.JANELA_SEG);
  if (xc >= -6 && xc <= w + 6) marcadorCue(c, xc);
  const J2 = VbMxWaveform.JANELA_SEG / 2;
  VbMxUI.desenharCamadas({ ...c, qual: "zoom" }, { letra, d, pos },
    { inicio: pos - J2, fim: pos + J2, x: t=>VbMxWaveform.colunaNoZoom(t, pos, w, VbMxWaveform.JANELA_SEG) });
  g.fillStyle = COR_CABECA; g.fillRect(cx - Math.floor(dpr/2), 0, Math.max(1, Math.round(dpr*1.5)), h);   // cabeça fixa no centro
}
// VB-49: na faixa estreita, loops guardados (região verde, §5) e um triângulo na cor do tipo na base de cada cue.
// O número e a linha dos cues, e o loop ativo, vêm das camadas de hotcues.js e loops.js.
function marcadoresDaFaixaInteira(c, d, letra, dur){
  const reg = typeof hotcues !== "undefined" && hotcues.faixa[letra] === d.faixa ? hotcues.reg[letra] : null;
  const lista = reg ? VbMxCues.visiveis(reg, 0, dur) : [];
  const m = VbMxWaveform.marcadoresDaFaixa(lista, null, dur, c.w), { g, h, dpr } = c, tri = Math.round(4*dpr);
  for (const l of m.loops) { g.fillStyle = "rgba(122,212,140,0.14)"; g.fillRect(l.x0, 0, Math.max(1, l.x1 - l.x0), h); }
  for (const k of m.cues) {
    const x = Math.round(k.x);
    g.fillStyle = k.cor; g.beginPath(); g.moveTo(x - tri, h); g.lineTo(x + tri, h); g.lineTo(x, h - tri*1.5); g.closePath(); g.fill();
  }
}
// Clicar na faixa inteira salta para o ponto (com QUANT, na batida); Shift+clique define o CUE ali (VB-55).
function ligarFaixaInteira(cv, letra){
  if (cv.dataset.faixaInteira) return;
  cv.dataset.faixaInteira = "1";
  cv.setAttribute("aria-label", `Faixa inteira do deck ${letra}. Clique salta para o ponto (na batida, com quantize); Shift+clique define o CUE`);
  cv.addEventListener("pointerdown", ev => {
    if (ev.button > 0 || !decks[letra].buffer) return;
    ev.stopImmediatePropagation();
    const e = VbMxTocador.estado(letra), rc = cv.getBoundingClientRect();
    if (ev.shiftKey) { definirCueNoTempo(letra, VbMxWaveform.cliqueNaFaixa(ev.clientX - rc.left, rc.width, e.duracao, null)); return; }   // VB-55
    const grade = (typeof syncQuant === "function" && syncQuant()) ? VbMxGrade.daFaixa(decks[letra].faixa) : null;
    const t = VbMxWaveform.cliqueNaFaixa(ev.clientX - rc.left, rc.width, e.duracao, grade ? x => VbMxGrade.quantizar(grade, x) : null);
    VbMxTocador.buscar(letra, t);
    atualizarTransporte(letra); emitirPosicao(letra);
  }, true);
}
// VB-57: arrastar a onda de zoom além de 4 px faz scratch (a música anda sob a mão: para a esquerda, adiante).
// O clique simples continua o de sempre (aoClicarNaOnda em js/deck.js), só que sai ao soltar, quando já se sabe
// que não foi arrasto. Contas em motor/scratch.js; o gesto em js/scratch.js.
function ligarArrastoNaOnda(cv, letra){
  if (cv.dataset.arrasto || typeof scratchComecar !== "function") return;
  cv.dataset.arrasto = "1"; cv.style.touchAction = "none";
  let g = null;
  cv.addEventListener("pointerdown", ev => {
    if (ev.button > 0 || !decks[letra].buffer) return;
    ev.stopImmediatePropagation();   // o clique sai no pointerup, se não virar arrasto
    try { cv.setPointerCapture(ev.pointerId); } catch(_){}
    g = { id: ev.pointerId, x0: ev.clientX, y0: ev.clientY, x: ev.clientX, arrasto: false,
          clique: { currentTarget: cv, clientX: ev.clientX, button: ev.button, shiftKey: ev.shiftKey } };
    scratchAquecer();
  }, true);
  cv.addEventListener("pointermove", ev => {
    if (!g || ev.pointerId !== g.id) return;
    if (!g.arrasto) {
      if (!VbMxScratch.passouDoLimiar(ev.clientX - g.x0, ev.clientY - g.y0)) return;
      if (!scratchComecar(letra, "onda", "scratch", ev.pointerId)) { g = null; return; }
      g.arrasto = true;   // a música anda desde o ponto do aperto
    }
    const larg = cv.getBoundingClientRect().width, lista = typeof ev.getCoalescedEvents === "function" ? ev.getCoalescedEvents() : [];
    for (const e of lista.length ? lista : [ev]) {
      scratchAmostra(letra, VbMxScratch.tempoDoArrasto(e.clientX - g.x, larg, VbMxWaveform.JANELA_SEG), e.timeStamp);
      g.x = e.clientX;
    }
    scratchEnviar(letra);
  });
  const fim = (ev, valeClique) => {
    if (!g || ev.pointerId !== g.id) return;
    const era = g; g = null;
    if (era.arrasto) scratchTerminar(letra);
    else if (valeClique) aoClicarNaOnda(letra, "zoom", era.clique);
  };
  cv.addEventListener("pointerup", ev => fim(ev, true));
  cv.addEventListener("pointercancel", ev => fim(ev, false));
  cv.addEventListener("lostpointercapture", ev => fim(ev, false));
}
function desenharGeral(cv, d, pos, letra){
  const c = ajustarCanvas(cv), { g, w, h, dpr } = c;
  if (!d.picos) { g.fillStyle = COR_RESTO; g.fillRect(0, Math.floor(h/2), w, Math.max(1, Math.round(dpr))); return; }
  const modo = VbMxPrefs.ler("onda.modo");
  if (!d.cacheGeral || d.cacheGeral.w!==w || d.cacheGeral.h!==h || d.cacheGeral.modo!==modo) {          // a faixa inteira só se redesenha se o tamanho mudar
    const R = VbMxWaveform.reduzir(d.picos, w), esc = (h/2 - dpr) / Math.max(d.picos.pico, 1e-6), par = [];
    const cores = coresDaOnda(d), cols = d.picos.min.length;
    for (const cor of [COR_RESTO, COR_TOCADO]) {
      const oc = document.createElement("canvas"); oc.width = w; oc.height = h;
      const og = oc.getContext("2d"); og.fillStyle = cor;
      if (cores) og.globalAlpha = cor === COR_RESTO ? .55 : 1;
      for (let x = 0; x < w; x++) {
        if (cores) og.fillStyle = cores[Math.min(cols - 1, Math.floor((x + .5) * cols / w))];
        og.fillRect(x, h/2 - R.max[x]*esc, 1, Math.max(1, (R.max[x] - R.min[x])*esc));
      }
      par.push(oc);
    }
    d.cacheGeral = { w, h, modo, resto: par[0], tocado: par[1] };
  }
  const xp = Math.round(VbMxWaveform.tempoParaColuna(pos, d.picos.duracao, w));
  g.drawImage(d.cacheGeral.resto, 0, 0);
  if (xp > 0) g.drawImage(d.cacheGeral.tocado, 0, 0, xp, h, 0, 0, xp, h);
  marcadorCue(c, Math.round(VbMxWaveform.tempoParaColuna(d.cue, d.picos.duracao, w)));
  const dur = d.picos.duracao;
  marcadoresDaFaixaInteira(c, d, letra, dur);
  VbMxUI.desenharCamadas({ ...c, qual: "geral" }, { letra, d, pos }, { inicio: 0, fim: dur, x: t=>VbMxWaveform.tempoParaColuna(t, dur, w) });
  g.fillStyle = COR_CABECA; g.fillRect(xp, 0, Math.max(1, Math.round(dpr*1.5)), h);
}
function pintarOndas(div, d, pos){
  const cz = div.querySelector('canvas[data-onda="zoom"]'), cg = div.querySelector('canvas[data-onda="geral"]');
  if (!cz || !cg) return;
  const letra = div.dataset.deck;
  ligarFaixaInteira(cg, letra); ligarArrastoNaOnda(cz, letra);
  desenharZoom(cz, d, pos, letra); desenharGeral(cg, d, pos, letra);
  const ci = div.querySelector(".cue-info"); if (ci) ci.textContent = d.buffer ? `CUE em ${fmtCue(d.cue)}${d.previa ? " · prévia" : ""}` : "";
}

