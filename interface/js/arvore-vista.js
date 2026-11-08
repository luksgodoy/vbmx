// ===================== arvore-vista.js — a biblioteca em duas vistas: tabela de músicas ou ÁRVORE de próximas faixas =====================
// Pedido do Lucas (2026-11-08): um botão no cabeçalho da biblioteca troca a tabela pela árvore do que pode vir depois do que está
// tocando. A árvore é a de 25/10 (motor/arvore.js, vinda do ramo vb-ui-arvore): o que já tocou → o que toca → o que pode vir
// (agrupado por relação harmônica) → o que vem depois da candidata. Só usa o que a biblioteca já tem (BPM, Camelot) via VbMxMotor.
// A vista ocupa o lugar da `.lista` dentro de #biblio: mesma caixa, mesma altura, mesma rolagem (o contrato de 10 linhas é da tabela).
//   layout.biblio-vista   "tabela" | "arvore"   guardada como as outras prefs layout.*
// Base da árvore = VbMxArvore.escolherBase: o deck que toca (dois tocando → maior volume efetivo; empate → o último a tocar).
// Clique no nó = candidata (abre o nível 2); botões A/B carregam o deck; arrastar o nó para um deck carrega (arrastar.js).
const ARVV_VISTAS = ["tabela", "arvore"];
VbMxPrefs.declarar("layout.biblio-vista", "tabela", { tipo: "opcao", modulo: "layout", rotulo: "Biblioteca: tabela ou árvore de próximas faixas", opcoes: ARVV_VISTAS });

function arvvVistaValida(v) { return v === "arvore" ? "arvore" : "tabela"; }
function arvvOutra(v) { return arvvVistaValida(v) === "arvore" ? "tabela" : "arvore"; }
function arvvVista() { return arvvVistaValida(VbMxPrefs.ler("layout.biblio-vista")); }
function arvvAlternar() { VbMxPrefs.gravar("layout.biblio-vista", arvvOutra(arvvVista())); }
function arvvBotaoHTML() {
  const arv = arvvVista() === "arvore";
  return `<button type="button" class="alternador" id="bib-vista" aria-pressed="${arv}" title="${arv ? "Voltar para a tabela de músicas" : "Trocar a tabela pela árvore de próximas faixas (parte do que está tocando)"}">${arv ? "Tabela" : "Árvore"}</button>`;
}

// ---- estado ----
let arvvCandidata = null, arvvRaizId = null, arvvUltimo = null, arvvAssinatura = "", arvvQuadro = 0, arvvModelo = null;
function arvvDecks() {
  const o = {};
  for (const l of ["A", "B"]) {
    const c = mixer[l];
    o[l] = { faixa: decks[l].faixa, tocando: !!decks[l].faixa && tocandoDeck(l),
      volume: VbMxMixer.ganhoFader(c.vol, mixer.curvaFader) * VbMxMixer.ganhoCrossfaderDoCanal(c, mixer) };
  }
  return o;
}
function arvvBase() { return VbMxArvore.escolherBase(arvvDecks(), arvvUltimo); }
function arvvEfetiva(base) { return VbMxTom.faixaEfetiva(base.faixa, decks[base.letra].pitch, opcoesDoTom(decks[base.letra])); }
function arvvFaixa(id) { return BIBLIOTECA.find(f => f.id === id); }
function arvvHistoricoIds() { return VbMxArvore.idsDoHistorico(typeof historicoSessao !== "undefined" && historicoSessao ? historicoSessao.entradas() : []); }

// ---- desenho ----
function arvvNoHTML(n, nivel, candId) {
  const f = n.c.faixa;
  const cls = `no n${nivel}${nivel === 1 && candId === n.id ? " candidata" : ""}`;
  const dica = `${f.titulo} · ${f.camelot} · ${fmtBpm(f.bpm)} BPM · ${n.c.motivo}. ${nivel === 1 ? "Clique para ver o que vem depois dela" : "Clique para selecionar"}; arraste para um deck`;
  return `<div class="${cls}" data-faixa="${f.id}" data-no="${nivel}" draggable="true" role="button" tabindex="0" style="left:${n.x}px;top:${n.y}px;--cor:${corCamelot(f.camelot)}" title="${esc(dica)}" aria-label="${esc(dica)}">
    <span class="no-cor"></span><span class="no-chave mono">${tomTexto(f.camelot)}</span>
    <span class="no-titulo">${esc(f.titulo)}</span>
    <span class="no-delta mono ${VbMxArvore.classeDelta(n.c.bpm)}" title="ΔBPM contra ${nivel === 1 ? "a faixa tocando" : "a candidata"}">${VbMxArvore.deltaCurto(n.c.bpm)}</span>
    ${["A", "B"].map(l => `<span class="para-deck" role="button" tabindex="0" data-carregar="${l}" data-id="${f.id}" title="Carregar no deck ${l} (sem mexer no outro)" aria-label="Carregar ${esc(f.titulo)} no deck ${l}">${l}</span>`).join("")}
  </div>`;
}
function arvvQuadroHTML(m, base) {
  const G = VbMxArvore.GEO, ref = m.ref, candId = m.candidata ? m.candidata.id : null;
  const hist = m.historico.map((h, i) => {
    const f = arvvFaixa(h.id);
    return `<div class="no hist" style="left:${h.x}px;top:${h.y}px;--cor:${f ? corCamelot(f.camelot) : "var(--fg-3)"}" title="${f ? esc(`${f.titulo} · já tocou neste set`) : `faixa ${h.id} · já tocou`}"><span class="no-cor"></span><span class="no-titulo">${f ? esc(f.titulo) : `#${h.id}`}</span><span class="no-ordem mono">${i + 1}</span></div>`;
  }).join("");
  const ligHist = m.historico.map((h, i) => {
    const x0 = h.x + G.HIST_L, x1 = i + 1 < m.historico.length ? m.historico[i + 1].x : G.RAIZ_X;
    return `<path class="lig hist" d="M${x0} ${m.H / 2} L${x1} ${m.H / 2}"/>`;
  }).join("");
  const colunas = `
    <span class="coluna" style="left:${G.HIST_X}px">já tocou neste set${m.escondidas ? ` · ${m.escondidas} escondida${m.escondidas === 1 ? "" : "s"}` : ""}</span>
    <span class="coluna" style="left:${G.RAIZ_X}px">tocando · deck ${base.letra}</span>
    <span class="coluna" style="left:${G.N1_X}px">pode vir · ${m.mixaveis} mixáve${m.mixaveis === 1 ? "l" : "is"}</span>
    <span class="coluna n2" style="left:${G.N2_X}px">depois ${m.candidata ? `de ${esc(m.candidata.c.faixa.titulo)} · ${m.candidata.n2Total}` : ""}</span>`;
  const raiz = `<div class="no raiz" style="left:${m.raiz.x}px;top:${m.raiz.y}px;--cor:${corCamelot(ref.camelot)}" title="${esc(base.faixa.titulo)} · tocando no deck ${base.letra} (${esc(base.motivo)})">
      <span class="no-cor"></span><span class="raiz-txt"><b>${esc(base.faixa.titulo)}</b><span>${esc(base.faixa.artista)} · <span class="mono">${tomTexto(ref.camelot)} · ${fmtBpm(ref.bpm)}</span> BPM</span></span></div>`;
  const cabs = m.cabecalhos.map(c => `<span class="cab" style="left:${c.x}px;top:${c.y + 8}px">${esc(c.motivo)} · ${c.n}</span>`).join("");
  const lig1 = m.nos.map(n => `<path class="lig n1${candId === n.id ? " candidata" : ""}" d="${n.caminho}"/>`).join("");
  const lig2 = m.n2.map(n => `<path class="lig n2" d="${n.caminho}"/>`).join("");
  const vazio = m.nos.length ? "" : `<div class="no vazio" style="left:${G.N1_X}px;top:${m.H / 2 - 13}px">${m.total ? "tudo que mixa já tocou neste set" : "nada mixável só por tom e BPM"}</div>`;
  return `<div class="arvore-quadro" style="width:${G.LARGURA}px;height:${m.H}px">
    <svg class="arvore-ligacoes" viewBox="0 0 ${G.LARGURA} ${m.H}" width="${G.LARGURA}" height="${m.H}" aria-hidden="true">${ligHist}${lig1}${lig2}</svg>
    ${colunas}${hist}${raiz}${cabs}${m.nos.map(n => arvvNoHTML(n, 1, candId)).join("")}${m.n2.map(n => arvvNoHTML(n, 2, candId)).join("")}${vazio}
  </div>`;
}
// Conteúdo da vista (o que vai dentro de `.lista.lista-arvore`).
function arvoreVistaHTML() {
  const base = arvvBase();
  if (!base) { arvvModelo = null; return `<div class="vazio-biblio vazio-arvore">Nenhuma faixa tocando. Dê play num deck: a árvore parte da faixa que está tocando.</div>`; }
  if (arvvRaizId !== base.faixa.id) { arvvCandidata = null; arvvRaizId = base.faixa.id; }
  const ref = arvvEfetiva(base);
  const compativeis = f => VbMxMotor.compativeis(f === base.faixa ? ref : f, BIBLIOTECA);
  const m = arvvModelo = VbMxArvore.montar({ ref: base.faixa, compativeis, historicoIds: arvvHistoricoIds(), candidataId: arvvCandidata });
  m.ref = ref;
  if (m.candidata) arvvCandidata = m.candidata.id;
  return `<div class="arvore-rolo"><div class="arvore" id="arvore" role="group" aria-label="Árvore de próximas faixas a partir de ${esc(base.faixa.titulo)}">${arvvQuadroHTML(m, base)}</div></div>`;
}
// Escala o quadro de 1456 px para a largura da caixa (mínimo 0,55; abaixo disso rola na horizontal).
function arvvEscalar() {
  const rolo = document.querySelector("#biblio .arvore-rolo"), q = rolo && rolo.querySelector(".arvore");
  if (!q) return;
  const G = VbMxArvore.GEO, esc_ = Math.max(0.55, Math.min(1, (rolo.clientWidth - 4) / G.LARGURA));
  const H = arvvModelo ? arvvModelo.H : G.ALTURA;
  q.style.setProperty("--escala", esc_.toFixed(4));
  q.style.width = `${Math.round(G.LARGURA * esc_)}px`; q.style.height = `${Math.round(H * esc_)}px`;
}
function arvvAssinaturaAtual() {
  const b = arvvBase();
  if (!b) return "-";
  const r = arvvEfetiva(b);
  return `${b.letra}|${b.faixa.id}|${r.camelot}|${r.bpm.toFixed(3)}|${arvvCandidata}|${arvvHistoricoIds().join(",")}|${BIBLIOTECA.length}`;
}
// Redesenha só a vista (não a biblioteca inteira), pulando quando nada que ela lê mudou.
function arvvAtualizar(forcar) {
  if (arvvVista() !== "arvore") return;
  const lista = document.querySelector("#biblio .lista-arvore");
  if (!lista) return;
  const nova = arvvAssinaturaAtual();
  if (!forcar && nova === arvvAssinatura) return;
  arvvAssinatura = nova;
  const rolo = lista.querySelector(".arvore-rolo"), esq = rolo ? rolo.scrollLeft : 0, topo = lista.scrollTop;
  lista.innerHTML = arvoreVistaHTML();
  arvvEscalar();
  const r2 = lista.querySelector(".arvore-rolo"); if (r2) r2.scrollLeft = esq;
  lista.scrollTop = topo;
}
function arvvAgendar() {
  if (arvvQuadro) return;
  arvvQuadro = requestAnimationFrame(() => { arvvQuadro = 0; arvvAtualizar(false); });
}
// Chamado por biblio.js depois de desenhar a biblioteca inteira (renderBiblio): marca a assinatura e escala.
function arvvAposRender() { arvvAssinatura = arvvAssinaturaAtual(); arvvEscalar(); }

// Clique no nó: nível 1 vira candidata (nível 2 muda); nível 2 cai no seletor global (seleciona a faixa).
// O A/B dos nós sobe até o principal.js, que carrega o deck.
function arvvClique(e) {
  if (e.target.closest("[data-carregar],[data-card-acao]")) return;
  const no = e.target.closest(".no[data-no='1']");
  if (!no) return;
  e.stopPropagation();
  arvvCandidata = Number(no.dataset.faixa);
  arvvAtualizar(true);
}
VbMxUI.aoIniciar(() => {
  const div = document.getElementById("biblio");
  div.addEventListener("click", arvvClique);
  div.addEventListener("keydown", e => {
    if ((e.key === "Enter" || e.key === " ") && e.target.matches && e.target.matches(".no[data-no='1']")) { e.preventDefault(); e.stopPropagation(); arvvCandidata = Number(e.target.dataset.faixa); arvvAtualizar(true); }
  });
  VbMxUI.ouvir("deck:tocou", e => { arvvUltimo = e.letra; arvvAgendar(); });
  for (const ev of ["deck:pausou", "deck:fim", "deck:carregado", "deck:descarregado", "deck:pitch", "mixer:mudou", "ar:faixa", "biblioteca:mudou"]) VbMxUI.ouvir(ev, arvvAgendar);
  VbMxPrefs.ouvir("layout.biblio-vista", () => renderBiblio());
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(arvvEscalar).observe(div);
  else window.addEventListener("resize", arvvEscalar);
});
if (typeof module !== "undefined") module.exports = { arvvVistaValida, arvvOutra, ARVV_VISTAS };
