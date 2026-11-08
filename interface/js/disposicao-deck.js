// ===================== disposicao-deck.js — arrastar e reorganizar os blocos de cada deck (UI D, 2026-11-07) =====================
// Cada coluna de deck é uma pilha de 6 blocos na grade .decks: fx · deck (ondas + prato + transporte) · stems · hotcues · loops · grade
// (a linha de avisos fica sempre por último). A ordem é a preferência `layout.deck-ordem-a` / `-b` (ids separados por vírgula) e vira
// `--linha` em cada bloco (css/disposicao.css lê `grid-row: var(--linha, N)`); a linha que tem um deck é a que estica (1fr).
// Alça: um botão ⠿ no alto de cada bloco, reposto por MutationObserver quando o módulo reescreve o innerHTML (fx, stems, deck).
// Arrasto por pointer events (sem lib): a alça segura, o bloco da mesma coluna sob o ponteiro recebe o indicador de destino
// (antes/depois), soltar grava a ordem. Setas ↑/↓ na alça movem por teclado. Botão "Disposição padrão" no topo restaura os dois decks.
// Nada aqui cria nem apaga slot: os elementos `deck-X-*` que testar-classico exige continuam onde estão; só a linha da grade muda.
// Lógica pura (ordemNormalizar, ordemMover, ordemLinhas) testada em Node por interface/testar-disposicao-deck.js.
const DECK_BLOCOS = ["fx", "deck", "stems", "hotcues", "loops", "grade"];
const DECK_BLOCO_ROTULO = { fx: "FX", deck: "deck (ondas, prato e transporte)", stems: "stems", hotcues: "hot cues", loops: "loops", grade: "grade" };
const DECK_LINHA_AVISOS = DECK_BLOCOS.length + 1;   // 7

// "fx,deck,…" | array → ordem completa e válida: ids desconhecidos ou repetidos caem, os que faltam entram na ordem padrão.
function ordemNormalizar(valor) {
  const lista = Array.isArray(valor) ? valor : String(valor || "").split(",");
  const vistos = [];
  for (const x of lista) { const id = String(x).trim(); if (DECK_BLOCOS.includes(id) && !vistos.includes(id)) vistos.push(id); }
  for (const id of DECK_BLOCOS) if (!vistos.includes(id)) vistos.push(id);
  return vistos;
}
// Move `id` para antes (ou depois) de `alvo`; mover para si mesmo ou id desconhecido devolve a mesma ordem (normalizada).
function ordemMover(ordem, id, alvo, antes = true) {
  const o = ordemNormalizar(ordem);
  if (id === alvo || !DECK_BLOCOS.includes(id) || !DECK_BLOCOS.includes(alvo)) return o;
  const sem = o.filter(x => x !== id);
  const i = sem.indexOf(alvo) + (antes ? 0 : 1);
  sem.splice(i, 0, id);
  return sem;
}
// Desloca `id` uma posição (delta −1 sobe, +1 desce), travado nas pontas.
function ordemDeslocar(ordem, id, delta) {
  const o = ordemNormalizar(ordem), i = o.indexOf(id), j = i + delta;
  if (i < 0 || j < 0 || j >= o.length) return o;
  return ordemMover(o, id, o[j], delta < 0);
}
// Ordens dos dois decks → { linhas: {A:{id:n}, B:{id:n}}, template: "auto minmax(min-content, 1fr) auto …" } — a linha com deck estica.
function ordemLinhas(ordemA, ordemB) {
  const linhas = {}, comDeck = new Set();
  for (const [l, o] of [["A", ordemNormalizar(ordemA)], ["B", ordemNormalizar(ordemB)]]) {
    linhas[l] = {};
    o.forEach((id, i) => { linhas[l][id] = i + 1; if (id === "deck") comDeck.add(i + 1); });
  }
  const template = [];
  for (let n = 1; n <= DECK_BLOCOS.length; n++) template.push(comDeck.has(n) ? "minmax(min-content, 1fr)" : "auto");
  template.push("auto");   // avisos
  return { linhas, template: template.join(" "), ehPadrao: ordemNormalizar(ordemA).join() === DECK_BLOCOS.join() && ordemNormalizar(ordemB).join() === DECK_BLOCOS.join() };
}
function ordemChave(letra) { return `layout.deck-ordem-${letra.toLowerCase()}`; }

if (typeof VbMxPrefs !== "undefined") for (const l of ["a", "b"]) {
  VbMxPrefs.declarar(ordemChave(l), "", { tipo: "texto", modulo: "layout", rotulo: `Ordem dos blocos do deck ${l.toUpperCase()} (${DECK_BLOCOS.join(",")}; vazio = padrão)` });
}

// ---------- DOM ----------
function deckBlocoEl(letra, id) {
  if (id === "fx") return document.querySelector(`.decks > [data-slot="fx-${letra === "A" ? 1 : 2}"]`);
  if (id === "deck") return document.querySelector(`.decks > [data-deck="${letra}"]`);
  return document.querySelector(`.decks > [data-slot="deck-${letra}-${id}"]`);
}
function deckOrdemLer(letra) { return ordemNormalizar(VbMxPrefs.ler(ordemChave(letra))); }
function deckOrdemGravar(letra, ordem) { const o = ordemNormalizar(ordem); VbMxPrefs.gravar(ordemChave(letra), o.join() === DECK_BLOCOS.join() ? "" : o.join(",")); }
function deckOrdemRestaurar() { for (const l of ["A", "B"]) VbMxPrefs.gravar(ordemChave(l), ""); }

function deckOrdemAplicar() {
  if (typeof document === "undefined") return;
  const decks = document.querySelector(".decks"); if (!decks) return;
  const r = ordemLinhas(deckOrdemLer("A"), deckOrdemLer("B"));
  decks.style.setProperty("--linhas-deck", r.template);
  for (const l of ["A", "B"]) for (const id of DECK_BLOCOS) {
    const el = deckBlocoEl(l, id); if (!el) continue;
    el.style.setProperty("--linha", r.linhas[l][id]);
    el.dataset.bloco = id; el.dataset.blocoDeck = l;
    deckAlcaGarantir(el, l, id);
  }
  const bt = document.querySelector("[data-disp-ordem]"); if (bt) bt.hidden = r.ehPadrao;
}

// alça: botão ⠿ no alto do bloco; o observer repõe quando o módulo reescreve o innerHTML
const deckObservados = new WeakSet();
function deckAlcaGarantir(el, letra, id) {
  if (!el.querySelector(":scope > .disp-alca")) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "disp-alca"; b.textContent = "⠿";
    b.title = `Arrastar o bloco ${DECK_BLOCO_ROTULO[id]} do deck ${letra} para outra posição (↑/↓ pelo teclado)`;
    b.setAttribute("aria-label", `Mover o bloco ${DECK_BLOCO_ROTULO[id]} do deck ${letra}; setas para cima e para baixo reordenam`);
    b.addEventListener("pointerdown", e => deckArrastoIniciar(e, el, letra, id));
    b.addEventListener("keydown", e => {
      const d = e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0; if (!d) return;
      e.preventDefault(); deckOrdemGravar(letra, ordemDeslocar(deckOrdemLer(letra), id, d)); b.focus();
    });
    el.prepend(b);
  }
  if (!deckObservados.has(el) && typeof MutationObserver !== "undefined") {
    deckObservados.add(el);
    new MutationObserver(() => { if (!el.querySelector(":scope > .disp-alca")) deckAlcaGarantir(el, letra, id); }).observe(el, { childList: true });
  }
}

// arrasto: pointer capture na alça; o destino é o bloco da MESMA coluna sob o ponteiro; metade de cima = antes, de baixo = depois
let deckArrasto = null;
function deckArrastoLimpar() {
  if (!deckArrasto) return;
  deckArrasto.el.classList.remove("disp-arrastando");
  document.body.classList.remove("disp-reordenando");
  for (const x of document.querySelectorAll(".disp-destino-antes, .disp-destino-depois")) x.classList.remove("disp-destino-antes", "disp-destino-depois");
  deckArrasto = null;
}
function deckArrastoIniciar(e, el, letra, id) {
  if (e.button !== 0) return;
  e.preventDefault();
  const alca = e.currentTarget;
  deckArrasto = { el, letra, id, alca, alvo: null, antes: true, y0: e.clientY, moveu: false };
  if (alca.setPointerCapture) alca.setPointerCapture(e.pointerId);
  const mover = ev => {
    if (!deckArrasto) return;
    if (!deckArrasto.moveu && Math.abs(ev.clientY - deckArrasto.y0) < 4) return;
    deckArrasto.moveu = true;
    el.classList.add("disp-arrastando"); document.body.classList.add("disp-reordenando");
    let alvo = null;
    for (const x of document.elementsFromPoint(ev.clientX, ev.clientY)) {
      const b = x.closest && x.closest(`.decks > [data-bloco-deck="${letra}"]`);
      if (b && b !== el) { alvo = b; break; }
    }
    for (const x of document.querySelectorAll(".disp-destino-antes, .disp-destino-depois")) x.classList.remove("disp-destino-antes", "disp-destino-depois");
    if (alvo) {
      const r = alvo.getBoundingClientRect(), antes = ev.clientY < r.top + r.height / 2;
      alvo.classList.add(antes ? "disp-destino-antes" : "disp-destino-depois");
      deckArrasto.alvo = alvo.dataset.bloco; deckArrasto.antes = antes;
    } else deckArrasto.alvo = null;
  };
  const soltar = () => {
    alca.removeEventListener("pointermove", mover); alca.removeEventListener("pointerup", soltar); alca.removeEventListener("pointercancel", cancelar);
    document.removeEventListener("keydown", tecla);
    if (deckArrasto && deckArrasto.moveu && deckArrasto.alvo) deckOrdemGravar(letra, ordemMover(deckOrdemLer(letra), id, deckArrasto.alvo, deckArrasto.antes));
    deckArrastoLimpar();
  };
  const cancelar = () => { if (deckArrasto) deckArrasto.alvo = null; soltar(); };
  const tecla = ev => { if (ev.key === "Escape") cancelar(); };
  alca.addEventListener("pointermove", mover); alca.addEventListener("pointerup", soltar); alca.addEventListener("pointercancel", cancelar);
  document.addEventListener("keydown", tecla);
}

if (typeof VbMxUI !== "undefined") VbMxUI.aoIniciar(() => {
  for (const l of ["a", "b"]) VbMxPrefs.ouvir(ordemChave(l), deckOrdemAplicar);
  const botoes = document.querySelector(".disp-botoes");
  if (botoes && !botoes.querySelector("[data-disp-ordem]")) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "disp-bt"; b.setAttribute("data-disp-ordem", ""); b.textContent = "Disposição padrão";
    b.title = "Volta os blocos dos dois decks (FX, deck, stems, hot cues, loops, grade) à ordem padrão"; b.hidden = true;
    b.addEventListener("click", deckOrdemRestaurar);
    botoes.appendChild(b);
  }
  deckOrdemAplicar();
  // módulos que preenchem os slots depois (stems, fx, loops…) tiram o `hidden`; a alça e a linha já estão neles — basta reaplicar uma vez
  setTimeout(deckOrdemAplicar, 0);
});
if (typeof module !== "undefined") module.exports = { DECK_BLOCOS, ordemNormalizar, ordemMover, ordemDeslocar, ordemLinhas, ordemChave };
