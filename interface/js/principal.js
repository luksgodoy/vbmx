function renderTudo(){
  if (!document.querySelector("#mixer .canais")) renderMixer();
  // deck B só mantém a faixa se ela ainda está na biblioteca em uso (troca de pasta a derruba)
  for (const l of ["A","B"]) {
    const f = decks[l].faixa;
    if (f && !BIBLIOTECA.find(x=>x.id===f.id && x.caminho===f.caminho)) {
      descarregarDeck(l);
      decks[l].carga = tr("pro.deck.faixa-saiu",{titulo:f.titulo,l}); decks[l].cargaCls = "erro";
    }
    renderDeck(document.querySelector(`[data-deck="${l}"]`), decks[l].faixa, l);
  }
  renderBiblio();
  renderSugestao();
  atualizarEstadoGlobal();
}

// clique numa faixa (biblioteca ou sugestão) = seleciona e recalcula (e zera o filtro); os botões
// A/B carregam aquele deck; arrastar a faixa para um deck também carrega só aquele deck.
// Botão registrado por um módulo (VbMxUI.registrar("card-acao", {id, rotulo, fazer(faixa)})).
function fazerCardAcao(el){
  const a = VbMxUI.registrados("card-acao").find(x=>x.id===el.dataset.cardAcao);
  const f = BIBLIOTECA.find(x=>x.id===Number(el.dataset.id));
  if (a && f) a.fazer(f);
}
document.addEventListener("click", e=>{
  const ca = e.target.closest("[data-card-acao]");
  if (ca) { fazerCardAcao(ca); return; }
  const car = e.target.closest("[data-carregar]");
  if (car) { carregarNoDeck(car.dataset.carregar, Number(car.dataset.id)); return; }
  const b = e.target.closest("[data-faixa]");
  if (b) selecionar(Number(b.dataset.faixa));
});
document.addEventListener("keydown", e=>{
  if (e.key!=="Enter" && e.key!==" ") return;
  const ca = e.target.closest?.("[data-card-acao]");
  if (ca) { e.preventDefault(); fazerCardAcao(ca); return; }
  const car = e.target.closest?.("[data-carregar]");
  if (car) { e.preventDefault(); carregarNoDeck(car.dataset.carregar, Number(car.dataset.id)); return; }
  const b = e.target.closest?.("[data-faixa]");
  if (b && e.target===b) { e.preventDefault(); selecionar(Number(b.dataset.faixa)); }
});
ligarArrastar();   // js/arrastar.js
window.addEventListener("resize", ()=>{ for (const l of ["A","B"]) { decks[l].cacheGeral = null; pintarPosicao(l); } });

// Linha de origem no topo (a frase muda com o idioma; o estado dela fica em marcaOrigem).
let marcaOrigem = null;
function pintarMarcaOrigem(){
  const el = document.getElementById("marca-origem"), t = VbMxUI.t;
  if (!el) return;
  const velho = MODULO_VELHO ? ` · <span class="tag-exemplo">${esc(t("pro.aviso-modulo"))}</span>` : "";
  el.innerHTML = !marcaOrigem || !marcaOrigem.faixas
    ? `${t("pro.marca.modelo")} · <span class="tag-exemplo">${t("pro.marca.exemplo")}</span> · ${t("pro.marca.exemplos-nao-tocam")}${velho}`
    : `${t("pro.marca.modelo")} · ${t("pro.marca.biblioteca", marcaOrigem.faixas)}${velho}`;
}
// Biblioteca real (VB-07): com pasta, substitui os exemplos; sem pasta (ou ao remover todas), volta a eles.
function mudouBiblioteca(faixas){
  ehExemplo = faixas.length===0;
  BIBLIOTECA = ehExemplo ? FAIXAS : faixas;
  marcaOrigem = { faixas: ehExemplo ? null : { ok: faixas.filter(f=>f.analisavel).length, total: faixas.length } };
  pintarMarcaOrigem();
  const aindaExiste = atual && BIBLIOTECA.find(f=>f.id===atual.id && f.caminho===atual.caminho);
  if (!aindaExiste) atual = BIBLIOTECA.find(f=>f.analisavel!==false && (ehExemplo ? f.titulo==="Maré Baixa" : true)) || null;
  filtroCasa = null;
  renderTudo();
  VbMxUI.emitir("biblioteca:mudou", { faixas: BIBLIOTECA, ehExemplo });
}
VbMxPrefs.declarar("biblio.pasta-filtro", "", { tipo: "texto", modulo: "biblio", rotulo: "pro.pref.biblio-pasta" });
VbMxPainel.iniciar({ montarEm: document.getElementById("pastas"), aoMudar: mudouBiblioteca, aoDesenhar: () => renderBiblio(),
  preferencia: { ler: () => VbMxPrefs.ler("biblio.pasta-filtro"), gravar: v => VbMxPrefs.gravar("biblio.pasta-filtro", v) } });

VbMxUI.aoIdioma(()=>{ pintarMarcaOrigem(); renderTudo(); });   // troca de idioma ao vivo: o que é desenhado por t() refaz; os módulos com tela própria ouvem VbMxUI.aoIdioma
try { rodaAberta = localStorage.getItem("vbmx-roda")==="1"; } catch(_){ rodaAberta = false; }
pintarMarcaOrigem();
renderTudo();
VbMxUI.iniciar();   // os módulos que pediram VbMxUI.aoIniciar(fn) mexem no DOM agora (docs/contratos.md)
