// ===================== Arrastar faixa para um deck =====================
// Saiu de principal.js no VB-11 para o VB-19 (destino de soltar mais rico, avisos) mexer aqui sem
// tocar no boot. principal.js chama ligarArrastar() uma vez; o que o soltar faz é carregarNoDeck.
const TIPO_ARRASTO = "text/vbmx-faixa";
function limparAlvos(){ document.querySelectorAll(".deck.alvo-soltar, .deck.alvo-recusado").forEach(d=>d.classList.remove("alvo-soltar","alvo-recusado")); }
// VB-19: deck que toca e a trava ligada (avisos.js) pinta o alvo de vermelho; o soltar segue até
// carregarNoDeck, onde a guarda recusa com o aviso na tela — a música não para.
function alvoTravado(letra){ return typeof avisosTravaAtiva === "function" && !!avisosTravaAtiva(letra); }
function ligarArrastar(){
  document.addEventListener("dragstart", e=>{
    const el = e.target.closest?.("[data-faixa]");
    if (!el || !e.dataTransfer) return;
    e.dataTransfer.setData(TIPO_ARRASTO, el.dataset.faixa);
    e.dataTransfer.setData("text/plain", el.dataset.faixa);
    e.dataTransfer.effectAllowed = "copy";
  });
  document.addEventListener("dragover", e=>{
    const deck = e.target.closest?.(".deck");
    if (!deck || !e.dataTransfer || ![...e.dataTransfer.types].includes(TIPO_ARRASTO)) return;
    e.preventDefault(); e.dataTransfer.dropEffect = "copy";
    limparAlvos(); deck.classList.add(alvoTravado(deck.dataset.deck) ? "alvo-recusado" : "alvo-soltar");
  });
  document.addEventListener("dragleave", e=>{
    const deck = e.target.closest?.(".deck");
    if (deck && !deck.contains(e.relatedTarget)) deck.classList.remove("alvo-soltar");
  });
  document.addEventListener("drop", e=>{
    const deck = e.target.closest?.(".deck");
    limparAlvos();
    if (!deck || !e.dataTransfer) return;
    const id = Number(e.dataTransfer.getData(TIPO_ARRASTO));
    if (!id) return;
    e.preventDefault();
    carregarNoDeck(deck.dataset.deck, id);
  });
  document.addEventListener("dragend", limparAlvos);
}
