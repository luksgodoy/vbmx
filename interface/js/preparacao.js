// ===================== preparacao.js — lista de preparação: slot preparacao; card-acao "preparar" =====================
// Dono: VB-18 (onda 1). A fila de faixas escolhidas para o set: "+ preparar" nos cards da sugestão e nas
// linhas da biblioteca (VbMxUI.registrar("card-acao")); arrastar o item para um deck usa o mesmo
// data-faixa dos cards (arrastar.js). A lista mora no set guardado por historico.js: aqui emitimos
// `preparacao:mudou` {lista} e adotamos a lista quando `historico:mudou` traz um set diferente.
// No carregamento só declara e registra; o DOM mexe em VbMxUI.aoIniciar. Contrato: docs/contratos.md.
VbMxUI.declararEvento("preparacao:mudou");

let preparacaoLista = [], preparacaoSetId = null, preparacaoEntradas = [], preparacaoAviso = "";

function preparacaoResolver(item){
  return typeof BIBLIOTECA === "undefined" ? null : BIBLIOTECA.find(f => f.id === item.id && (f.caminho || "") === (item.caminho || "")) || null;
}
function preparacaoMudou(aviso){
  preparacaoAviso = aviso || "";
  VbMxUI.emitir("preparacao:mudou", { lista: preparacaoLista.map(x => ({ ...x })) });
  preparacaoDesenhar();
}
function preparacaoPreparar(f){
  const antes = preparacaoLista.length;
  preparacaoLista = VbMxHistorico.preparacaoAdicionar(preparacaoLista, f);
  preparacaoMudou(preparacaoLista.length > antes ? `na lista: ${f.titulo}` : `${f.titulo} já está na lista`);
}
VbMxUI.registrar("card-acao", { id: "preparar", rotulo: "+ preparar", titulo: "Pôr na lista de preparação do set", fazer: preparacaoPreparar });


function preparacaoDesenhar(){
  const slot = VbMxUI.slot("preparacao");
  if (!slot) return;
  const lista = VbMxHistorico.preparacaoMarcar(preparacaoLista, preparacaoEntradas);
  const itens = lista.map((x, i) => {
    const viva = preparacaoResolver(x);
    const tom = x.camelot ? chave(x.camelot) : "";
    const bpm = x.bpm ? `<span class="mono">${fmtBpm(x.bpm)}</span> BPM` : "";
    const deck = viva ? ["A", "B"].map(l => `<button type="button" class="para-deck" data-carregar="${l}" data-id="${viva.id}" title="Carregar no deck ${l}" aria-label="Carregar ${esc(x.titulo)} no deck ${l}">${l}</button>`).join("") : "";
    return `<li class="prep-item${x.tocada ? " tocada" : ""}${viva ? "" : " ausente"}" ${viva ? `data-faixa="${viva.id}" draggable="true"` : ""} data-i="${i}" style="--cor:${x.camelot ? corCamelot(x.camelot) : "var(--fg-3)"}">
      <span class="faixa-cor"></span>
      <span class="prep-ordem mono">${i + 1}</span>
      <span class="prep-nome"><b>${esc(x.titulo)}</b><span>${esc(x.artista)} · ${bpm} ${tom}</span></span>
      <span class="prep-estado">${x.tocada ? "tocou" : viva ? "" : "fora da biblioteca"}</span>
      <span class="prep-botoes">
        <button type="button" data-prep="sobe" data-i="${i}" title="Subir na fila" aria-label="Subir ${esc(x.titulo)}"${i === 0 ? " disabled" : ""}>↑</button>
        <button type="button" data-prep="desce" data-i="${i}" title="Descer na fila" aria-label="Descer ${esc(x.titulo)}"${i === lista.length - 1 ? " disabled" : ""}>↓</button>
        ${deck}
        <button type="button" data-prep="tira" data-i="${i}" title="Tirar da lista" aria-label="Tirar ${esc(x.titulo)} da lista">✕</button>
      </span>
    </li>`;
  }).join("");
  slot.hidden = false;
  slot.className = "prep";
  slot.innerHTML = `<div class="prep-cab">
      <h3>Preparação do set</h3>
      <span class="hist-taxa"><b class="mono">${lista.length}</b> ${lista.length === 1 ? "faixa" : "faixas"}${lista.filter(x => x.tocada).length ? ` · <b class="mono">${lista.filter(x => x.tocada).length}</b> já tocou` : ""}</span>
    </div>
    ${lista.length ? `<div class="prep-barra"><button type="button" data-prep="limpa">Limpar lista</button><button type="button" data-prep="limpa-tocadas">Tirar as que já tocaram</button></div>` : ""}
    ${preparacaoAviso ? `<div class="prep-aviso" role="status">${esc(preparacaoAviso)}</div>` : ""}
    ${lista.length ? `<ol class="prep-lista">${itens}</ol>` : `<div class="prep-vazio">Vazia. Use <b>+ preparar</b> nos cards da sugestão e na biblioteca para montar a fila do set; arraste um item para um deck.</div>`}`;
}

VbMxUI.aoIniciar(() => {
  // historico.js carrega depois deste arquivo e é quem declara `historico:mudou`: só aqui já existe
  VbMxUI.ouvir("historico:mudou", d => {
    preparacaoEntradas = d.entradas || [];
    if (d.set && d.set.id !== preparacaoSetId) { preparacaoSetId = d.set.id; preparacaoLista = (d.set.preparacao || []).map(x => ({ ...x })); }
    preparacaoDesenhar();
  });
  const slot = VbMxUI.slot("preparacao");
  if (slot) {
    slot.addEventListener("click", e => {
      const b = e.target.closest("[data-prep]");
      if (!b) return;
      e.stopPropagation();
      const i = Number(b.dataset.i), a = b.dataset.prep;
      if (a === "sobe") preparacaoLista = VbMxHistorico.preparacaoMover(preparacaoLista, i, i - 1);
      else if (a === "desce") preparacaoLista = VbMxHistorico.preparacaoMover(preparacaoLista, i, i + 1);
      else if (a === "tira") preparacaoLista = preparacaoLista.filter((_, k) => k !== i);
      else if (a === "limpa") preparacaoLista = [];
      else if (a === "limpa-tocadas") preparacaoLista = VbMxHistorico.preparacaoMarcar(preparacaoLista, preparacaoEntradas).filter(x => !x.tocada).map(({ tocada, ...x }) => x);
      preparacaoMudou("");
    });
  }
  preparacaoDesenhar();
});
