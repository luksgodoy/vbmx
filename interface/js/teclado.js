// ===================== teclado.js — atalhos de teclado → VbMxUI.acao =====================
// VB-25 (onda 2). Dois papéis:
//  1. NÃO declara ações: cada módulo dono declara as suas em VbMxUI (VB-48) — deck.js (deckA.play, .cue, .cup,
//     .reverso), sync.js (.sync), loops.js (.loopTam<N>); o teclado só despacha por nome de ação;
//  2. manda as teclas para o despachante de js/midi.js (`controlesEntrada`), que acha a atribuição nos
//     mapeamentos ativos. A tecla é só mais um controle físico: {tipo:'tecla', codigo: KeyboardEvent.code}.
// No carregamento só declara e registra; o ouvinte do documento entra em VbMxUI.aoIniciar.


// Teclas livres para o mapeamento padrão (primeira abertura); o resto o Lucas aprende no painel Controles.
const TECLADO_PADRAO = [
  ["KeyZ", "play", "A"], ["KeyX", "cue", "A"], ["KeyC", "sync", "A"],
  ["KeyN", "play", "B"], ["KeyM", "cue", "B"], ["Comma", "sync", "B"],
];

function tecladoEhCampo(alvo) {
  if (!alvo || !alvo.tagName) return false;
  return /^(INPUT|SELECT|TEXTAREA)$/.test(alvo.tagName) || alvo.isContentEditable === true;
}

VbMxUI.aoIniciar(() => {
  const tratar = (e, valor) => {
    if (e.repeat || e.metaKey || e.ctrlKey || e.altKey || tecladoEhCampo(e.target)) return;
    if (typeof controlesEntrada !== "function") return;
    const fisico = { tipo: "tecla", codigo: e.code };
    if (controlesEntrada(fisico, valor, e.timeStamp)) e.preventDefault();
  };
  document.addEventListener("keydown", (e) => tratar(e, 127));
  document.addEventListener("keyup", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || tecladoEhCampo(e.target)) return;
    if (typeof controlesEntrada === "function" && controlesEntrada({ tipo: "tecla", codigo: e.code }, 0, e.timeStamp)) e.preventDefault();
  });
});
