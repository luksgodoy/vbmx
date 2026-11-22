// ===================== BIBLIOTECA: busca, filtros, ordenação, agrupamento (VB-17) e marcadores (VB-17b) =====================
// A lógica é de biblioteca/colecao.js (puro, testado em Node); as tags (gênero, ano) vêm de
// biblioteca/metadados.js, lidas em segundo plano do cabeçalho do arquivo (nunca do áudio).
// VB-17b: avaliação (0 a 5 estrelas), cor, comentário, data de importação, playlists e listas inteligentes vêm de
// biblioteca/meta.js (IndexedDB `vbmx-meta-v1`). Aqui só a tela: o estado mora em `biblioMetas` (chave → meta) e
// `biblioListas`. Quem gravar meta por fora (VB-27, importação do .nml) chama `VbMxMeta` e depois
// `VbMxUI.emitir("meta:mudou")` — a tela recarrega sozinha.
// Nada aqui mexe no DOM no carregamento: o que precisa de tela fica em VbMxUI.aoIniciar.
const biblioEstado = { texto: "", bpmMin: "", bpmMax: "", casa: "", genero: "", ano: "", soCompat: false, esconderTocadas: false,
  coluna: "", direcao: "asc", agrupar: "", avMin: "", cor: "",
  lista: "", destino: "", modoNome: "", apagando: false, editandoComent: "", rascunho: [] };
// Ordem = trilhas da grade (biblio.css). "" = não ordena (capa, deck). duracao/compat/tocadas ordenam aqui na tela
// (VbMxColecao.ordenar não as conhece); as demais passam pelo módulo puro.
// Os rótulos guardam a CHAVE do dicionário; quem desenha traduz (a troca de idioma redesenha a tela).
const BIBLIO_COLUNAS = [["","","h-capa"],["titulo","pro.bib.col-titulo","c-titc"],["artista","pro.bib.col-artista","c-art"],["bpm","pro.bib.col-bpm","c-bpm"],["camelot","pro.bib.col-tom",""],
  ["duracao","pro.bib.col-dur","c-dur"],["avaliacao","pro.bib.col-nota","c-nota"],["","pro.bib.col-deck","c-deck"],["tocadas","pro.bib.col-ja","c-toc"],["compat","pro.bib.col-comp","c-comp"]];
const BIBLIO_COMPAT_ROT = { tocando: "pro.bib.compat-tocando", alta: "pro.bib.compat-alta", media: "pro.bib.compat-media", fora: "pro.bib.compat-fora" };
const BIBLIO_ORDEM_TELA = ["duracao", "compat", "tocadas"];
VbMxPrefs.declarar("biblio.densidade", "confortavel", { tipo: "opcao", modulo: "biblio", rotulo: "pro.pref.biblio-densidade",
  opcoes: [{ valor: "confortavel", rotulo: "pro.pref.biblio-conf" }, { valor: "compacta", rotulo: "pro.pref.biblio-comp" }] });
const BIBLIO_AGRUPAR = [["","pro.bib.ag-nenhum"],["camelot","pro.bib.ag-tom"],["genero","pro.bib.ag-genero"],["ano","pro.bib.ag-ano"],["bpm","pro.bib.ag-bpm"],["artista","pro.bib.ag-artista"]];
const BIBLIO_CAMPOS_REGRA = [["bpm","pro.bib.col-bpm"],["camelot","pro.bib.col-tom"],["genero","pro.bib.campo-genero"],["artista","pro.bib.col-artista"],["titulo","pro.bib.col-titulo"],["comentario","pro.bib.campo-comentario"],["avaliacao","pro.bib.campo-avaliacao"],["cor","pro.bib.campo-cor"],["data","pro.bib.campo-data"]];
const BIBLIO_OPS = { "=":"pro.bib.op-eq", ">=":"pro.bib.op-min", "<=":"pro.bib.op-max", entre:"pro.bib.op-entre", e:"pro.bib.op-eq", "uma-de":"pro.bib.op-uma-de", compativel:"pro.bib.op-compativel", contem:"pro.bib.op-contem", nenhuma:"pro.bib.op-nenhuma", depois:"pro.bib.op-depois", antes:"pro.bib.op-antes" };

VbMxUI.declararEvento("meta:mudou");                       // {} — quem gravar em VbMxMeta por fora emite, a tela recarrega
let biblioMetas = new Map(), biblioListas = [], biblioPersist = null;
function biblioMeta(){ return biblioPersist || (biblioPersist = VbMxMeta.doNavegador()); }
const biblioChave = f => VbMxMeta.chaveDe(f);
function biblioMetaDe(f){ return biblioMetas.get(biblioChave(f)); }
function biblioListaAtual(){ return biblioEstado.lista ? biblioListas.find(l=>l.id===biblioEstado.lista) || null : null; }

function biblioCriterios(){
  const e = biblioEstado;
  return { texto: e.texto, bpmMin: e.bpmMin, bpmMax: e.bpmMax, casas: e.casa ? [e.casa] : [], genero: e.genero, ano: e.ano,
    avaliacaoMin: e.avMin === "" ? null : Number(e.avMin), cor: e.cor };
}
function biblioTemFiltro(){
  const e = biblioEstado;
  return !!(e.texto.trim() || e.bpmMin !== "" || e.bpmMax !== "" || e.casa || e.genero || e.ano || e.soCompat || e.avMin !== "" || e.cor);
}
// A lista que a tela mostra: (lista escolhida) → filtra → (só compatíveis) → ordena. Exposta para teste no navegador.
function biblioLista(){
  const mescladas = BIBLIOTECA.map(f=>VbMxMeta.mesclar(f, biblioMetaDe(f)));
  const lista = biblioListaAtual();
  let itens = VbMxColecao.filtrar(lista ? VbMxMeta.resolver(lista, mescladas) : mescladas, biblioCriterios());
  biblioCompat = biblioCompatMapa();
  if (biblioEstado.soCompat && atual) {
    const ok = new Set(VbMxMotor.compativeis(atual, BIBLIOTECA).compativeis.map(c=>c.faixa.id));
    itens = itens.filter(x=>ok.has(x.id));
  }
  if (biblioEstado.esconderTocadas) itens = itens.filter(x=>!biblioVezesTocada(x));
  const col = biblioEstado.coluna;
  if (BIBLIO_ORDEM_TELA.includes(col)) return biblioOrdenarTela(itens, col, biblioEstado.direcao);
  return col ? VbMxColecao.ordenar(itens, col, biblioEstado.direcao) : itens;
}
// ---- compat com a faixa selecionada (≈), vezes tocada (Já) e deck de cada faixa; tudo derivado, nada gravado ----
let biblioCompat = new Map();
// id → {nivel: "tocando"|"alta"|"media"|"fora", motivo}. Vem de VbMxMotor.compativeis (o motor não é caixa preta: o motivo vai no title).
// alta = tom igual/vizinho e BPM a ≤3 %; media = BPM a ≤6 %; fora = o resto (inclusive o que o motor aceita só até 15 %).
function biblioCompatMapa(){
  const m = new Map();
  if (typeof atual === "undefined" || !atual) return m;
  m.set(atual.id, { nivel: "tocando", motivo: tr("pro.bib.faixa-selecionada") });
  if (!VbMxMotor.faixaValida || !VbMxMotor.faixaValida(atual)) return m;
  for (const c of VbMxMotor.compativeis(atual, BIBLIOTECA).compativeis) {
    const p = Math.abs(c.bpm.deltaPct);
    m.set(c.faixa.id, { nivel: p <= 0.03 + 1e-9 ? "alta" : p <= 0.06 + 1e-9 ? "media" : "fora", motivo: c.motivo });
  }
  return m;
}
function biblioVezesTocada(x){
  if (typeof historicoSet === "undefined" || !historicoSet || !historicoSet.entradas) return 0;
  const k = historicoChave(x);
  return historicoSet.entradas.reduce((n, e) => n + (e.faixa && historicoChave(e.faixa) === k ? 1 : 0), 0);
}
function biblioDeckDe(x){
  const r = [];
  for (const l of ["A","B"]) { const f = typeof decks !== "undefined" && decks[l] && decks[l].faixa; if (f && f.id === x.id) r.push(l); }
  return r;
}
function biblioChaveTela(x, col){
  if (col === "duracao") return x.duracao > 0 ? x.duracao : null;
  if (col === "tocadas") return biblioVezesTocada(x);
  const c = biblioCompat.get(x.id);                         // compat: tocando < alta < média < fora < sem leitura
  return c ? { tocando: 0, alta: 1, media: 2, fora: 3 }[c.nivel] : null;
}
function biblioOrdenarTela(itens, col, direcao){
  const sentido = direcao === "desc" ? -1 : 1;
  const com = itens.map((f, i) => ({ f, i, k: biblioChaveTela(f, col) }));
  com.sort((a, b) => (a.k === null || b.k === null) ? (a.k === b.k ? a.i - b.i : a.k === null ? 1 : -1) : ((a.k - b.k) * sentido || a.i - b.i));
  return com.map(o => o.f);
}
const biblioDuracaoTxt = s => s > 0 ? `${Math.floor(s/60)}:${String(Math.round(s%60) % 60).padStart(2,"0")}` : "";
const biblioIniciais = n => (String(n||"").match(/[\p{L}\p{N}]+/gu) || []).slice(0,2).map(w=>w[0]).join("").toUpperCase() || "♪";

// Rótulo do campo de tom na notação escolhida ("Tom (Camelot)", "Tom (Círculo aberto)"...).
function biblioRotuloTom(){
  const n = VbMxPrefs.ler("tom.notacao-exibir"), r = VbMxNotacao.ROTULOS[n] || "Camelot";
  return tr("pro.bib.tom-rot", { r: r.replace(/\s*\(.*$/, "") });
}
// A regra guarda Camelot (é o que biblioteca/meta.js avalia); a tela mostra e aceita a notação escolhida.
const biblioTomRegraTela = t => String(t||"").split(",").map(p => p.trim() ? tomTexto(p.trim()) : "").join(", ");
const biblioTomRegraGravar = t => String(t||"").split(",").map(p => { const c = p.trim() && VbMxNotacao.converter(p.trim(), "camelot"); return c || p.trim(); }).join(", ");
// Selo de auto-loop: faixa mais curta que a preferência loops.auto-detectar (0 desliga); precisa da duração conhecida.
function biblioSeloLoop(x){
  return x.duracao && VbMxLoops.ehFaixaCurta(x.duracao, VbMxPrefs.ler("loops.auto-detectar"))
    ? `<span class="selo-loop" title="${tr("pro.bib.loop-tit", { s: Math.round(x.duracao) })}" aria-label="${tr("pro.bib.loop-aria")}">LOOP</span>` : "";
}
function biblioOpcoes(valores, escolhido, vazio, texto){
  return `<option value="">${esc(vazio)}</option>` + valores.map(v=>`<option value="${esc(v)}"${String(v)===String(escolhido)?" selected":""}>${esc(texto?texto(v):v)}</option>`).join("");
}
function biblioEstrelas(x){
  const n = x.avaliacao || 0;
  return `<span class="estrelas" role="group" aria-label="${tr("pro.bib.avaliacao-aria", { n })}">${[1,2,3,4,5].map(i=>`<button type="button" class="estrela${i<=n?" on":""}" data-nota="${i}" aria-label="${tr("pro.bib.estrela", { n: i })}${i===n?" " + tr("pro.bib.estrela-zerar"):""}">★</button>`).join("")}</span>`;
}
function biblioDataImp(ms){ return ms ? new Date(ms).toLocaleDateString((typeof VbMxI18n !== "undefined" && VbMxI18n.idioma && VbMxI18n.idioma()) || "pt-BR") : ""; }
function biblioAcoes(x, i, total){
  const lista = biblioListaAtual();
  if (lista && lista.tipo==="playlist") return `<span class="c-acoes"><button type="button" class="bib-mini" data-lista-sobe="${i}" aria-label="${tr("pro.bib.subir")}"${i===0?" disabled":""}>▲</button><button type="button" class="bib-mini" data-lista-desce="${i}" aria-label="${tr("pro.bib.descer")}"${i===total-1?" disabled":""}>▼</button><button type="button" class="bib-mini" data-lista-tira="1" aria-label="${tr("pro.bib.tirar")}">✕</button></span>`;
  const dest = biblioListas.find(l=>l.id===biblioEstado.destino && l.tipo==="playlist");
  return `<span class="c-acoes"><button type="button" class="bib-mini" data-lista-poe="1"${dest?"":" disabled"} title="${dest?tr("pro.bib.adicionar-a", { nome: esc(dest.nome) }):tr("pro.bib.escolha-destino")}" aria-label="${tr("pro.bib.adicionar-destino")}">＋</button></span>`;
}
function biblioLinha(x, i, total){
  const sem = x.analisavel===false, sel = atual && x.id===atual.id, m = biblioEstado;
  const ch = esc(biblioChave(x));
  const decksDe = sem ? [] : biblioDeckDe(x), vezes = sem ? 0 : biblioVezesTocada(x), comp = sem ? null : biblioCompat.get(x.id);
  const cls = ["linha", sel?"sel":"", sem?"sem-analise":"", decksDe.map(l=>"deck-"+l).join(" "), vezes&&!sel?"ja-tocada":""].filter(Boolean).join(" ");
  const editando = m.editandoComent===biblioChave(x);
  const edit = editando ? `<div class="c-com-edit"><input type="text" class="bib-coment-edit" id="bib-coment-edit" value="${esc(x.comentario||"")}" maxlength="2000" aria-label="${tr("pro.bib.coment-de", { t: esc(x.titulo) })}" placeholder="${tr("pro.bib.coment-ph")}"></div>` : "";
  const nivelTxt = { tocando: "●", alta: "●", media: "●", fora: "○" };
  const compHtml = comp ? `<span class="c-comp ${comp.nivel}" title="${esc(trm(comp.motivo))}" aria-label="${tr("pro.bib.compat-aria", { n: tr(BIBLIO_COMPAT_ROT[comp.nivel]) })}">${nivelTxt[comp.nivel]}</span>` : `<span class="c-comp" title="${tr("pro.bib.sem-leitura")}">·</span>`;
  const deckBtns = sem ? "" : paraDeck(x).replace(/class="para-deck"( role="button" tabindex="0" data-carregar="([AB])")/g, (t, r, l) => `class="para-deck${decksDe.includes(l)?" carregado-"+l:""}"${r}`);
  return `
    <div class="${cls}" data-chave="${ch}" data-i="${i}" ${sem?`data-sem-analise title="${esc(trm(x.erro)||tr("pro.bib.nao-analisada"))}"`:`data-faixa="${x.id}" draggable="true" role="button" tabindex="0" title="${tr("pro.bib.linha-tit")}"`}>
      <span class="capa" style="--cor:${sem?"var(--fg-3)":corCamelot(x.camelot)}" aria-hidden="false">${esc(biblioIniciais(x.artista))}<button type="button" class="c-cor cor-ponto${x.cor?" cor-"+x.cor:""}" data-cor-ciclo="1" title="${x.cor?esc(x.cor)+" — "+tr("pro.bib.cor-mudar"):tr("pro.bib.cor-colorir")}" aria-label="${tr("pro.bib.cor-aria", { c: x.cor?esc(x.cor):tr("pro.bib.nenhuma") })}"></button></span>
      <span class="c-tit" title="${esc(x.titulo)}">${esc(x.titulo)}${biblioSeloLoop(x)}<span class="sub">${sem?tr("pro.bib.nao-analisada"):esc(x.artista)}</span></span>
      <span class="c-art" title="${sem?"":esc(x.artista)}">${sem?`<span class="sem-tom">${tr("pro.bib.nao-analisada")}</span>`:esc(x.artista)}</span>
      <span class="c-bpm mono">${sem?"—":fmtBpm(x.bpm)}</span>
      ${sem?`<span class="chave">—</span>`:chave(x.camelot)}
      <span class="c-dur mono">${biblioDuracaoTxt(x.duracao)}</span>
      <span class="c-nota">${biblioEstrelas(x)}<button type="button" class="c-ed${x.comentario?" tem":""}" data-coment="1" title="${x.comentario?esc(x.comentario):tr("pro.bib.coment-clique")}" aria-label="${tr("pro.bib.coment-de", { t: esc(x.titulo) })}">✎</button></span>
      <span class="c-deck">${sem?"":deckBtns}${biblioAcoes(x, i, total)}</span>
      <span class="c-toc${vezes?" sim":""}" title="${vezes?tr("pro.bib.ja-tocada", { n: vezes }):tr("pro.bib.ainda-nao")}">${vezes?"✓"+(vezes>1?vezes:""):""}</span>
      ${compHtml}
      ${edit}
    </div>`;
}

// ---------- barra de listas (playlists e inteligentes) ----------
function biblioBarraListas(){
  const e = biblioEstado, lista = biblioListaAtual();
  const pls = biblioListas.filter(l=>l.tipo==="playlist"), ints = biblioListas.filter(l=>l.tipo==="inteligente");
  const pastaFiltro = window.VbMxPainel ? VbMxPainel.pastasParaFiltro() : { nomes: [], escolha: "", ocupado: false };
  const opt = l => `<option value="${esc(l.id)}"${l.id===e.lista?" selected":""}>${esc(l.nome)}</option>`;
  const nomeando = e.modoNome ? `<span class="bib-nome"><input type="text" id="bib-nome" maxlength="120" placeholder="${e.modoNome==="renomear"?tr("pro.bib.novo-nome"):tr("pro.bib.nome-lista")}" value="${e.modoNome==="renomear"&&lista?esc(lista.nome):""}" aria-label="${tr("pro.bib.nome-aria")}"><button type="button" class="bib-limpar" id="bib-nome-ok">OK</button><button type="button" class="bib-limpar" id="bib-nome-cancela">${tr("pro.bib.cancelar")}</button></span>` : "";
  return `<div class="biblio-listas" role="group" aria-label="${tr("pro.bib.listas")}">
      <label>${tr("pro.bib.lista")} <select id="bib-lista" aria-label="${tr("pro.bib.qual-lista")}"><option value="">${tr("pro.bib.colecao")}</option>${pls.length?`<optgroup label="${tr("pro.bib.listas")}">${pls.map(opt).join("")}</optgroup>`:""}${ints.length?`<optgroup label="${tr("pro.bib.inteligentes")}">${ints.map(opt).join("")}</optgroup>`:""}</select></label>
      ${pastaFiltro.nomes.length?`<label>${tr("pro.bib.pasta")} <select id="bib-pasta" aria-label="${tr("pro.bib.pasta-aria")}"${pastaFiltro.ocupado?" disabled":""}><option value="">${tr("pro.bib.todas-pastas")}</option>${pastaFiltro.nomes.map(n=>`<option value="${esc(n)}"${n===pastaFiltro.escolha?" selected":""}>${esc(n)}</option>`).join("")}</select></label>`:""}
      <button type="button" class="bib-limpar" id="bib-nova-lista">${tr("pro.bib.nova-lista")}</button>
      <button type="button" class="bib-limpar" id="bib-nova-int">${tr("pro.bib.nova-int")}</button>
      ${lista?`<button type="button" class="bib-limpar" id="bib-renomear">${tr("pro.bib.renomear")}</button>${e.apagando?`<button type="button" class="bib-limpar bib-perigo" id="bib-apagar-sim">${tr("pro.bib.apagar-mesmo")}</button><button type="button" class="bib-limpar" id="bib-apagar-nao">${tr("pro.bib.nao")}</button>`:`<button type="button" class="bib-limpar" id="bib-apagar">${tr("pro.bib.apagar")}</button>`}`:""}
      ${nomeando}
      ${pls.length?`<label title="${tr("pro.bib.destino-tit")}">${tr("pro.bib.adicionar-ao")} <select id="bib-destino" aria-label="${tr("pro.bib.destino-aria")}"><option value="">—</option>${pls.map(l=>`<option value="${esc(l.id)}"${l.id===e.destino?" selected":""}>${esc(l.nome)}</option>`).join("")}</select></label>`:""}
    </div>${lista && lista.tipo==="inteligente" ? biblioEditorRegras(lista) : ""}`;
}
function biblioTextoValor(v){ return Array.isArray(v) ? v.join(v.length===2 ? " - " : ", ") : (v===undefined||v===null ? "" : String(v)); }
function biblioRascunhoDe(lista){ return (lista.regras||[]).map(r=>({ campo:r.campo, op:r.op, texto:biblioTextoValor(r.valor) })); }
// texto digitado → valor da regra; devolve undefined se não der para montar (a regra fica só no rascunho)
function biblioValorRegra(r){
  const t = String(r.texto||"").trim();
  if (r.op==="nenhuma") return "";
  if (r.campo==="bpm" && r.op==="entre") { const p = t.split(/\s*[-–,;]\s*/); return p.length===2 && p.every(v=>v!=="" && Number.isFinite(Number(v))) ? [Number(p[0]), Number(p[1])] : undefined; }
  if (r.campo==="bpm" || r.campo==="avaliacao") return t!=="" && Number.isFinite(Number(t)) ? Number(t) : undefined;
  if (r.op==="uma-de") { const p = t.split(/\s*,\s*/).filter(Boolean); return p.length ? p : undefined; }
  return t || undefined;
}
function biblioEditorRegras(lista){
  const e = biblioEstado;
  const linhas = e.rascunho.map((r,i)=>{
    const ops = VbMxMeta.CAMPOS[r.campo] || [];
    const valor = r.op==="nenhuma" ? "" : r.campo==="cor"
      ? `<select data-regra-valor="${i}" aria-label="${tr("pro.bib.regra-valor")}">${VbMxMeta.CORES.map(c=>`<option value="${c}"${c===r.texto?" selected":""}>${trm(c)}</option>`).join("")}</select>`
      : `<input type="${r.campo==="data"?"date":"text"}" data-regra-valor="${i}" value="${esc(r.campo==="camelot"?biblioTomRegraTela(r.texto):r.texto)}" placeholder="${r.campo==="bpm"&&r.op==="entre"?"120 - 130":r.op==="uma-de"?tomTexto("8A")+", "+tomTexto("9A"):""}" aria-label="${tr("pro.bib.regra-valor")}">`;
    return `<div class="regra"><select data-regra-campo="${i}" aria-label="${tr("pro.bib.regra-campo")}">${BIBLIO_CAMPOS_REGRA.map(([c,n])=>`<option value="${c}"${c===r.campo?" selected":""}>${c==="camelot"?esc(biblioRotuloTom()):tr(n)}</option>`).join("")}</select>
      <select data-regra-op="${i}" aria-label="${tr("pro.bib.regra-op")}">${ops.map(o=>`<option value="${esc(o)}"${o===r.op?" selected":""}>${esc(BIBLIO_OPS[o]?tr(BIBLIO_OPS[o]):o)}</option>`).join("")}</select>${valor}
      <button type="button" class="bib-mini" data-regra-tira="${i}" aria-label="${tr("pro.bib.regra-remover")}">✕</button></div>`;
  }).join("");
  return `<div class="biblio-regras" role="group" aria-label="${tr("pro.bib.regras-aria")}">
      <span class="rotulo">${tr("pro.bib.regras")}</span> <label>${tr("pro.bib.casar")} <select id="bib-combinar" aria-label="${tr("pro.bib.combinar")}"><option value="todas"${lista.combinar!=="qualquer"?" selected":""}>${tr("pro.bib.todas")}</option><option value="qualquer"${lista.combinar==="qualquer"?" selected":""}>${tr("pro.bib.qualquer")}</option></select></label>
      ${linhas || `<span class="regra-vazia">${tr("pro.bib.sem-regras")}</span>`}
      <button type="button" class="bib-limpar" id="bib-regra-nova">${tr("pro.bib.regra-nova")}</button></div>`;
}

function renderBiblio(filtro){
  const div = document.getElementById("biblio");
  if (typeof filtro === "string") biblioEstado.texto = filtro;
  const e = biblioEstado;
  // guarda o foco (campo + cursor) para o redesenho não tirar o usuário do que ele digitava
  const foco = document.activeElement && div.contains(document.activeElement) ? document.activeElement : null;
  const focoId = foco && foco.id, sel = foco && foco.selectionStart!=null ? [foco.selectionStart, foco.selectionEnd] : null;

  const itens = biblioLista();
  const generos = VbMxColecao.valores(BIBLIOTECA, "genero"), anos = VbMxColecao.valores(BIBLIOTECA, "ano"), casas = VbMxColecao.valores(BIBLIOTECA, "camelot");
  const grupos = e.agrupar ? VbMxColecao.agrupar(itens, e.agrupar) : [{ rotulo: "", faixas: itens }];
  const seta = c => e.coluna===c ? (e.direcao==="asc"?" ▲":" ▼") : "";
  const lista = biblioListaAtual();
  div.classList.toggle("compacto", VbMxPrefs.ler("biblio.densidade")==="compacta");
  const vistaArvore = arvvVista()==="arvore";                // js/arvore-vista.js: a árvore toma o lugar da tabela (mesma caixa)
  div.classList.toggle("vista-arvore", vistaArvore);
  let pos = 0;                                              // índice na lista mostrada (para ▲▼ da playlist)
  div.innerHTML = `
    <div class="biblio-cab">
      <span class="rotulo">${tr("pro.bib.biblioteca")}</span>
      ${arvvBotaoHTML()}
      <input type="search" id="busca" placeholder="${tr("pro.bib.busca-ph")}" value="${esc(e.texto)}" aria-label="${tr("pro.bib.busca-aria")}">
      <span class="cont">${itens.length}/${lista?tr("pro.bib.lista-min"):BIBLIOTECA.length} · ${tr("pro.bib.cont-dica")}</span>
    </div>
    ${biblioBarraListas()}
    <div class="biblio-filtros" role="group" aria-label="${tr("pro.bib.filtros")}">
      <label class="filtro-bpm">BPM <input type="number" id="bib-bpm-min" min="0" max="300" step="1" inputmode="numeric" placeholder="${tr("pro.bib.de")}" value="${esc(e.bpmMin)}" aria-label="${tr("pro.bib.bpm-min")}"> – <input type="number" id="bib-bpm-max" min="0" max="300" step="1" inputmode="numeric" placeholder="${tr("pro.bib.ate")}" value="${esc(e.bpmMax)}" aria-label="${tr("pro.bib.bpm-max")}"></label>
      <label>${tr("pro.bib.col-tom")} <select id="bib-casa" aria-label="${tr("pro.bib.filtrar-tom")}">${biblioOpcoes(casas, e.casa, tr("pro.bib.todos"), tomTexto)}</select></label>
      ${generos.length ? `<label>${tr("pro.bib.campo-genero")} <select id="bib-genero" aria-label="${tr("pro.bib.filtrar-genero")}">${biblioOpcoes(generos, e.genero, tr("pro.bib.todos"))}</select></label>` : ""}
      ${anos.length ? `<label>${tr("pro.bib.ano")} <select id="bib-ano" aria-label="${tr("pro.bib.filtrar-ano")}">${biblioOpcoes(anos, e.ano, tr("pro.bib.todos"))}</select></label>` : ""}
      <label>${tr("pro.bib.estrelas")} <select id="bib-av" aria-label="${tr("pro.bib.av-min")}">${["","1","2","3","4","5"].map(v=>`<option value="${v}"${v===e.avMin?" selected":""}>${v===""?tr("pro.bib.todas-f"):"≥ "+v+" ★"}</option>`).join("")}</select></label>
      <label>${tr("pro.bib.campo-cor")} <select id="bib-cor" aria-label="${tr("pro.bib.filtrar-cor")}"><option value="">${tr("pro.bib.todas-f")}</option>${VbMxMeta.CORES.map(c=>`<option value="${c}"${c===e.cor?" selected":""}>${trm(c)}</option>`).join("")}</select></label>
      <label class="filtro-compat" title="${tr("pro.bib.so-compat-tit")}"><input type="checkbox" id="bib-compat"${e.soCompat?" checked":""}> ${tr("pro.bib.so-compat")}</label>
      <label class="filtro-compat" title="${tr("pro.bib.esconder-tit")}"><input type="checkbox" id="bib-tocadas"${e.esconderTocadas?" checked":""}> ${tr("pro.bib.esconder")}</label>
      <label class="filtro-compat" title="${tr("pro.bib.compacta-tit")}"><input type="checkbox" id="bib-compacto"${VbMxPrefs.ler("biblio.densidade")==="compacta"?" checked":""}> ${tr("pro.bib.compacta")}</label>
      <label>${tr("pro.bib.grupos")} <select id="bib-agrupar" aria-label="${tr("pro.bib.agrupar")}">${BIBLIO_AGRUPAR.map(([v,r])=>`<option value="${v}"${v===e.agrupar?" selected":""}>${tr(r)}</option>`).join("")}</select></label>
      ${biblioTemFiltro() || e.coluna ? `<button type="button" class="bib-limpar" id="bib-limpar">${tr("pro.bib.limpar")}</button>` : ""}
    </div>
    ${vistaArvore ? `<div class="lista lista-arvore">${arvoreVistaHTML()}</div>` : `<div class="lista">
      <div class="lista-cab">${BIBLIO_COLUNAS.map(([c,r,cls])=>c ? `<button type="button" class="rotulo ord ${cls} ${e.coluna===c?"ativa":""}" data-ordem="${c}" aria-label="${tr(e.coluna===c?(e.direcao==="asc"?"pro.bib.ordenar-asc":"pro.bib.ordenar-desc"):"pro.bib.ordenar", { r: tr(r) })}">${tr(r)}${seta(c)}</button>` : `<span class="rotulo ${cls}">${r ? tr(r) : ""}</span>`).join("")}</div>
      ${itens.length ? grupos.map(g=>`${e.agrupar?`<div class="grupo-cab"><span class="rotulo">${esc(g.chave ? (e.agrupar==="camelot" ? tomTexto(g.rotulo) : g.rotulo) : trm(g.rotulo))}</span><span class="grupo-n">${g.faixas.length}</span></div>`:""}${g.faixas.map(f=>biblioLinha(f, pos++, itens.length)).join("")}`).join("")
        : `<div class="vazio-biblio">${lista && lista.tipo==="playlist" && !lista.chaves.length ? tr("pro.bib.lista-vazia") : tr("pro.bib.nenhuma-faixa")} ${biblioTemFiltro()?`<button type="button" class="bib-limpar" id="bib-limpar-vazio">${tr("pro.bib.limpar-filtros")}</button>`:""}</div>`}
    </div>`}`;
  if (focoId) { const n = document.getElementById(focoId); if (n) { n.focus(); if (sel && n.setSelectionRange && /^(text|search)$/.test(n.type||"")) { try { n.setSelectionRange(sel[0], sel[1]); } catch(_){} } } }
  else if (e.editandoComent) { const n = document.getElementById("bib-coment-edit"); if (n) { n.focus(); n.select(); } }
  else if (e.modoNome) { const n = document.getElementById("bib-nome"); if (n) { n.focus(); n.select(); } }
  biblioLigar(div);
}

function biblioLimpar(){
  Object.assign(biblioEstado, { texto: "", bpmMin: "", bpmMax: "", casa: "", genero: "", ano: "", soCompat: false, esconderTocadas: false, coluna: "", avMin: "", cor: "" });
  renderBiblio();
}

// ---------- gravação dos marcadores (cada uma devolve a tela atualizada; falha de armazém vira "não gravou") ----------
async function biblioGravarMeta(chave, parcial){
  const m = await biblioMeta().definir(chave, parcial);
  if (m) biblioMetas.set(chave, m);
  renderBiblio();
  return m;
}
async function biblioRecarregar(){
  try { biblioMetas = await biblioMeta().lerTodos(); biblioListas = await biblioMeta().listas(); } catch(_){ /* segue com o que tinha */ }
  const l = biblioListaAtual();
  if (biblioEstado.lista && !l) biblioEstado.lista = "";
  if (biblioEstado.destino && !biblioListas.some(x=>x.id===biblioEstado.destino)) biblioEstado.destino = "";
  if (l && l.tipo==="inteligente" && !biblioEstado.rascunho.length) biblioEstado.rascunho = biblioRascunhoDe(l);
  renderBiblio();
}
async function biblioSalvarRegras(){
  const l = biblioListaAtual(); if (!l || l.tipo!=="inteligente") return;
  const regras = biblioEstado.rascunho.map(r=>({ campo:r.campo, op:r.op, valor:biblioValorRegra(r) })).filter(r=>r.valor!==undefined);
  const combinar = (document.getElementById("bib-combinar")||{}).value || l.combinar;
  const salva = await biblioMeta().definirRegras(l.id, regras, combinar);
  if (salva) Object.assign(l, salva);
  renderBiblio();
}
async function biblioConfirmarNome(){
  const campoNome = document.getElementById("bib-nome"), nome = campoNome ? campoNome.value : "", modo = biblioEstado.modoNome;
  if (!nome.trim()) return;
  let l = null;
  if (modo==="renomear") { const atualL = biblioListaAtual(); if (atualL && await biblioMeta().renomear(atualL.id, nome)) l = atualL; }
  else if (modo==="inteligente") l = await biblioMeta().criarInteligente(nome, [], "todas");
  else l = await biblioMeta().criarLista(nome);
  biblioEstado.modoNome = "";
  if (l && modo!=="renomear") { biblioEstado.lista = l.id; biblioEstado.rascunho = []; if (modo==="lista") biblioEstado.destino = biblioEstado.destino || l.id; }
  await biblioRecarregar();
}

function biblioLigar(div){
  const e = biblioEstado;
  const bv = div.querySelector("#bib-vista"); if (bv) bv.addEventListener("click", arvvAlternar);   // tabela ↔ árvore (js/arvore-vista.js)
  if (arvvVista()==="arvore") arvvAposRender();
  const campo = (id, chaveEstado, tipo) => { const n = div.querySelector("#"+id); if (n) n.addEventListener(tipo||"input", ev=>{ e[chaveEstado] = ev.target.value; renderBiblio(); }); };
  campo("busca", "texto"); campo("bib-bpm-min", "bpmMin"); campo("bib-bpm-max", "bpmMax");
  campo("bib-casa", "casa", "change"); campo("bib-genero", "genero", "change"); campo("bib-ano", "ano", "change"); campo("bib-agrupar", "agrupar", "change");
  campo("bib-av", "avMin", "change"); campo("bib-cor", "cor", "change"); campo("bib-destino", "destino", "change");
  const compat = div.querySelector("#bib-compat");
  if (compat) compat.addEventListener("change", ev=>{ e.soCompat = ev.target.checked; renderBiblio(); });
  const toc = div.querySelector("#bib-tocadas");
  if (toc) toc.addEventListener("change", ev=>{ e.esconderTocadas = ev.target.checked; renderBiblio(); });
  const dens = div.querySelector("#bib-compacto");
  if (dens) dens.addEventListener("change", ev=>{ VbMxPrefs.gravar("biblio.densidade", ev.target.checked ? "compacta" : "confortavel"); renderBiblio(); });
  for (const id of ["bib-limpar", "bib-limpar-vazio"]) { const b = div.querySelector("#"+id); if (b) b.addEventListener("click", biblioLimpar); }
  div.querySelectorAll("[data-ordem]").forEach(b=>b.addEventListener("click", ()=>{
    const c = b.dataset.ordem;                              // asc → desc → sem ordem (volta à varredura)
    if (e.coluna!==c) { e.coluna = c; e.direcao = "asc"; }
    else if (e.direcao==="asc") e.direcao = "desc";
    else { e.coluna = ""; e.direcao = "asc"; }
    renderBiblio();
  }));

  // ---- listas
  const clique = (id, fn) => { const n = div.querySelector("#"+id); if (n) n.addEventListener("click", fn); };
  const sl = div.querySelector("#bib-lista");
  if (sl) sl.addEventListener("change", ev=>{
    e.lista = ev.target.value; e.modoNome = ""; e.apagando = false; e.rascunho = [];
    const l = biblioListaAtual(); if (l && l.tipo==="inteligente") e.rascunho = biblioRascunhoDe(l);
    renderBiblio();
  });
  const sp = div.querySelector("#bib-pasta");
  if (sp) sp.addEventListener("change", ev=>VbMxPainel.escolherPasta(ev.target.value));
  clique("bib-nova-lista", ()=>{ e.modoNome = "lista"; renderBiblio(); });
  clique("bib-nova-int", ()=>{ e.modoNome = "inteligente"; renderBiblio(); });
  clique("bib-renomear", ()=>{ e.modoNome = "renomear"; renderBiblio(); });
  clique("bib-nome-ok", biblioConfirmarNome);
  clique("bib-nome-cancela", ()=>{ e.modoNome = ""; renderBiblio(); });
  clique("bib-apagar", ()=>{ e.apagando = true; renderBiblio(); });
  clique("bib-apagar-nao", ()=>{ e.apagando = false; renderBiblio(); });
  clique("bib-apagar-sim", async ()=>{ const l = biblioListaAtual(); e.apagando = false; if (l) { await biblioMeta().apagar(l.id); e.lista = ""; e.rascunho = []; } await biblioRecarregar(); });
  const nome = div.querySelector("#bib-nome");
  if (nome) nome.addEventListener("keydown", ev=>{ if (ev.key==="Enter") { ev.preventDefault(); biblioConfirmarNome(); } else if (ev.key==="Escape") { e.modoNome = ""; renderBiblio(); } });

  // ---- regras da lista inteligente
  clique("bib-regra-nova", ()=>{ e.rascunho.push({ campo:"bpm", op:"entre", texto:"" }); renderBiblio(); });
  const comb = div.querySelector("#bib-combinar"); if (comb) comb.addEventListener("change", biblioSalvarRegras);
  div.querySelectorAll("[data-regra-campo]").forEach(n=>n.addEventListener("change", ev=>{
    const r = e.rascunho[Number(n.dataset.regraCampo)]; if (!r) return;
    r.campo = ev.target.value; r.op = VbMxMeta.CAMPOS[r.campo][0]; r.texto = r.campo==="cor" ? VbMxMeta.CORES[0] : ""; biblioSalvarRegras();
  }));
  div.querySelectorAll("[data-regra-op]").forEach(n=>n.addEventListener("change", ev=>{ const r = e.rascunho[Number(n.dataset.regraOp)]; if (r) { r.op = ev.target.value; biblioSalvarRegras(); } }));
  div.querySelectorAll("[data-regra-valor]").forEach(n=>n.addEventListener("change", ev=>{ const r = e.rascunho[Number(n.dataset.regraValor)]; if (r) { r.texto = r.campo==="camelot" ? biblioTomRegraGravar(ev.target.value) : ev.target.value; biblioSalvarRegras(); } }));
  div.querySelectorAll("[data-regra-tira]").forEach(n=>n.addEventListener("click", ()=>{ e.rascunho.splice(Number(n.dataset.regraTira), 1); biblioSalvarRegras(); }));

  // ---- marcadores de cada linha (parar a propagação: o clique na linha seleciona a faixa)
  const linhaDe = n => n.closest("[data-chave]");
  const faixaDa = n => { const l = linhaDe(n); return l ? l.dataset.chave : ""; };
  div.querySelectorAll("[data-nota]").forEach(b=>b.addEventListener("click", ev=>{
    ev.stopPropagation(); const k = faixaDa(b), m = biblioMetas.get(k), n = Number(b.dataset.nota);
    biblioGravarMeta(k, { avaliacao: m && m.avaliacao===n ? 0 : n });                 // clicar na nota atual zera
  }));
  div.querySelectorAll("[data-cor-ciclo]").forEach(b=>b.addEventListener("click", ev=>{
    ev.stopPropagation(); const k = faixaDa(b), m = biblioMetas.get(k), ciclo = [null].concat(VbMxMeta.CORES);
    biblioGravarMeta(k, { cor: ciclo[(ciclo.indexOf(m ? m.cor : null) + 1) % ciclo.length] });
  }));
  div.querySelectorAll("[data-coment]").forEach(b=>b.addEventListener("click", ev=>{ ev.stopPropagation(); e.editandoComent = faixaDa(b); renderBiblio(); }));
  const ed = div.querySelector("#bib-coment-edit");
  if (ed) {
    let fechado = false;
    const fechar = async (grava) => {
      if (fechado) return; fechado = true;
      const k = e.editandoComent; e.editandoComent = "";
      if (grava) await biblioGravarMeta(k, { comentario: ed.value }); else renderBiblio();
    };
    ed.addEventListener("click", ev=>ev.stopPropagation());
    ed.addEventListener("keydown", ev=>{ ev.stopPropagation(); if (ev.key==="Enter") fechar(true); else if (ev.key==="Escape") fechar(false); });
    ed.addEventListener("blur", ()=>fechar(true));
  }
  // ---- ações de lista na linha
  const emLista = (sel, fn) => div.querySelectorAll(sel).forEach(b=>b.addEventListener("click", async ev=>{ ev.stopPropagation(); await fn(b, faixaDa(b), Number(linhaDe(b).dataset.i)); await biblioRecarregar(); }));
  emLista("[data-lista-poe]", (b, k)=>biblioMeta().adicionar(e.destino, [k]));
  emLista("[data-lista-tira]", (b, k)=>biblioMeta().remover(e.lista, k));
  const idxLista = k => { const l = biblioListaAtual(); return l && l.chaves ? l.chaves.indexOf(k) : -1; };
  emLista("[data-lista-sobe]", (b, k)=>{ const i = idxLista(k); return i>0 ? biblioMeta().mover(e.lista, i, i-1) : null; });
  emLista("[data-lista-desce]", (b, k)=>{ const i = idxLista(k); return i>=0 ? biblioMeta().mover(e.lista, i, i+1) : null; });
}

// ---------- tags em segundo plano ----------
// Lê só o cabeçalho de cada arquivo (VbMxMetadados.lerArquivo: nunca lança, nunca decodifica áudio),
// 4 por vez, uma vez por faixa. Ao fim de cada lote redesenha (sem perder o foco, ver renderBiblio).
const biblioTagsLidas = new WeakSet();
let biblioTagsEmCurso = false, biblioTagsRodada = 0;
async function biblioLerTags(faixas){
  const fila = faixas.filter(f=>typeof f.obter==="function" && !biblioTagsLidas.has(f));
  if (!fila.length) return;
  const rodada = ++biblioTagsRodada;
  if (biblioTagsEmCurso) return;                            // o laço em curso pega a fila nova pela rodada
  biblioTagsEmCurso = true;
  try {
    for (let i = 0; i < fila.length; i += 4) {
      if (rodada!==biblioTagsRodada) break;
      await Promise.all(fila.slice(i, i+4).map(async f=>{
        biblioTagsLidas.add(f);
        try { Object.assign(f, VbMxMetadados.mesclar(f, await VbMxMetadados.lerArquivo(await f.obter()))); } catch(_){ /* sem tag: segue */ }
      }));
      if ((i/4)%8===7) renderBiblio();
    }
  } finally { biblioTagsEmCurso = false; }
  renderBiblio();
  if (biblioTagsRodada!==rodada) biblioLerTags(BIBLIOTECA);
}
// Data de importação: a primeira vez que a faixa (com caminho) aparece. Só grava quem ainda não tem.
async function biblioMarcarImportadas(faixas){
  const chaves = faixas.filter(f=>f.caminho).map(biblioChave);
  if (chaves.length && await biblioMeta().garantirImportada(chaves)) await biblioRecarregar();
}
// ---- MIDI (X1: encoder Browse): mover a seleção pela lista que a tela mostra, e trocar de lista ----
// A ordem é a da tela (grupos, ordenação, filtro); sem tabela na tela (árvore), a de biblioLista(). O id da faixa
// pode ser número e o data-faixa é texto: compara como texto e seleciona pelo id original da BIBLIOTECA.
function biblioOrdemVisivel(){
  const nos = typeof document !== "undefined" ? [...document.querySelectorAll("#biblio [data-faixa]")] : [];
  if (nos.length) return nos.map(n=>n.getAttribute("data-faixa"));
  return biblioLista().filter(x=>x.analisavel!==false).map(x=>String(x.id));
}
function biblioMover(passo){
  const n = Math.round(Number(passo)) || 0, ids = biblioOrdemVisivel();
  if (!n || !ids.length) return;
  const i = atual ? ids.indexOf(String(atual.id)) : -1;
  const j = i < 0 ? (n > 0 ? 0 : ids.length-1) : Math.min(ids.length-1, Math.max(0, i+n));
  const f = BIBLIOTECA.find(x=>String(x.id)===ids[j]); if (!f) return;
  selecionar(f.id);
  const no = [...document.querySelectorAll("#biblio [data-faixa]")].find(x=>x.getAttribute("data-faixa")===ids[j]);
  if (no && no.scrollIntoView) no.scrollIntoView({ block:"nearest" });
}
function biblioTrocarLista(passo){
  const n = Math.round(Number(passo)) || 0, ids = ["", ...biblioListas.map(l=>l.id)];
  if (!n || ids.length < 2) return;
  const e = biblioEstado, i = Math.max(0, ids.indexOf(e.lista || ""));
  e.lista = ids[((i + n) % ids.length + ids.length) % ids.length]; e.modoNome = ""; e.apagando = false; e.rascunho = [];
  const l = biblioListaAtual(); if (l && l.tipo==="inteligente") e.rascunho = biblioRascunhoDe(l);
  renderBiblio();
}
VbMxUI.registrar("acao", "biblio.mover", biblioMover);
VbMxUI.registrar("acao", "biblio.lista", biblioTrocarLista);
VbMxUI.aoIdioma(()=>renderBiblio());
VbMxUI.aoIniciar(()=>{
  VbMxUI.ouvir("biblioteca:mudou", ({faixas})=>{ biblioLerTags(faixas); biblioMarcarImportadas(faixas); });
  for (const ev of ["deck:carregado", "deck:descarregado", "historico:mudou"]) VbMxUI.ouvir(ev, ()=>renderBiblio());   // deck-A/B, ✓ de já tocada
  VbMxUI.ouvir("meta:mudou", biblioRecarregar);              // VB-27 (importação do .nml) e quem mais gravar em VbMxMeta
  biblioLerTags(BIBLIOTECA);
  biblioRecarregar().then(()=>biblioMarcarImportadas(BIBLIOTECA));
});
