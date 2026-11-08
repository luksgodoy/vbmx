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
const BIBLIO_COLUNAS = [["","","h-capa"],["titulo","Título","c-titc"],["artista","Artista","c-art"],["bpm","BPM","c-bpm"],["camelot","Tom",""],
  ["duracao","Dur.","c-dur"],["avaliacao","Nota","c-nota"],["","Deck","c-deck"],["tocadas","Já","c-toc"],["compat","≈","c-comp"]];
const BIBLIO_ORDEM_TELA = ["duracao", "compat", "tocadas"];
VbMxPrefs.declarar("biblio.densidade", "confortavel", { tipo: "opcao", modulo: "biblio", rotulo: "Densidade das linhas da biblioteca",
  opcoes: [{ valor: "confortavel", rotulo: "Confortável" }, { valor: "compacta", rotulo: "Compacta" }] });
const BIBLIO_AGRUPAR = [["","Sem grupos"],["camelot","Por tom"],["genero","Por gênero"],["ano","Por ano"],["bpm","Por faixa de BPM"],["artista","Por artista"]];
const BIBLIO_CAMPOS_REGRA = [["bpm","BPM"],["camelot","Tom"],["genero","Gênero"],["artista","Artista"],["titulo","Título"],["comentario","Comentário"],["avaliacao","Avaliação"],["cor","Cor"],["data","Importada"]];
const BIBLIO_OPS = { "=":"é", ">=":"pelo menos", "<=":"no máximo", entre:"entre", e:"é", "uma-de":"é um de", compativel:"compatível com", contem:"contém", nenhuma:"sem cor", depois:"desde", antes:"até" };

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
  m.set(atual.id, { nivel: "tocando", motivo: "É a faixa selecionada" });
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
  return `Tom (${r.replace(/\s*\(.*$/, "")})`;
}
// A regra guarda Camelot (é o que biblioteca/meta.js avalia); a tela mostra e aceita a notação escolhida.
const biblioTomRegraTela = t => String(t||"").split(",").map(p => p.trim() ? tomTexto(p.trim()) : "").join(", ");
const biblioTomRegraGravar = t => String(t||"").split(",").map(p => { const c = p.trim() && VbMxNotacao.converter(p.trim(), "camelot"); return c || p.trim(); }).join(", ");
// Selo de auto-loop: faixa mais curta que a preferência loops.auto-detectar (0 desliga); precisa da duração conhecida.
function biblioSeloLoop(x){
  return x.duracao && VbMxLoops.ehFaixaCurta(x.duracao, VbMxPrefs.ler("loops.auto-detectar"))
    ? `<span class="selo-loop" title="Faixa curta (${Math.round(x.duracao)} s): vira loop ao carregar" aria-label="Vira loop ao carregar">LOOP</span>` : "";
}
function biblioOpcoes(valores, escolhido, vazio, texto){
  return `<option value="">${esc(vazio)}</option>` + valores.map(v=>`<option value="${esc(v)}"${String(v)===String(escolhido)?" selected":""}>${esc(texto?texto(v):v)}</option>`).join("");
}
function biblioEstrelas(x){
  const n = x.avaliacao || 0;
  return `<span class="estrelas" role="group" aria-label="Avaliação: ${n} de 5">${[1,2,3,4,5].map(i=>`<button type="button" class="estrela${i<=n?" on":""}" data-nota="${i}" aria-label="${i} estrela${i>1?"s":""}${i===n?" (clique para zerar)":""}">★</button>`).join("")}</span>`;
}
function biblioDataImp(ms){ return ms ? new Date(ms).toLocaleDateString("pt-BR") : ""; }
function biblioAcoes(x, i, total){
  const lista = biblioListaAtual();
  if (lista && lista.tipo==="playlist") return `<span class="c-acoes"><button type="button" class="bib-mini" data-lista-sobe="${i}" aria-label="Subir na lista"${i===0?" disabled":""}>▲</button><button type="button" class="bib-mini" data-lista-desce="${i}" aria-label="Descer na lista"${i===total-1?" disabled":""}>▼</button><button type="button" class="bib-mini" data-lista-tira="1" aria-label="Tirar da lista">✕</button></span>`;
  const dest = biblioListas.find(l=>l.id===biblioEstado.destino && l.tipo==="playlist");
  return `<span class="c-acoes"><button type="button" class="bib-mini" data-lista-poe="1"${dest?"":" disabled"} title="${dest?`Adicionar a “${esc(dest.nome)}”`:"Escolha uma lista de destino acima"}" aria-label="Adicionar à lista de destino">＋</button></span>`;
}
function biblioLinha(x, i, total){
  const sem = x.analisavel===false, sel = atual && x.id===atual.id, m = biblioEstado;
  const ch = esc(biblioChave(x));
  const decksDe = sem ? [] : biblioDeckDe(x), vezes = sem ? 0 : biblioVezesTocada(x), comp = sem ? null : biblioCompat.get(x.id);
  const cls = ["linha", sel?"sel":"", sem?"sem-analise":"", decksDe.map(l=>"deck-"+l).join(" "), vezes&&!sel?"ja-tocada":""].filter(Boolean).join(" ");
  const editando = m.editandoComent===biblioChave(x);
  const edit = editando ? `<div class="c-com-edit"><input type="text" class="bib-coment-edit" id="bib-coment-edit" value="${esc(x.comentario||"")}" maxlength="2000" aria-label="Comentário de ${esc(x.titulo)}" placeholder="Comentário (Enter grava, Esc cancela)"></div>` : "";
  const nivelTxt = { tocando: "●", alta: "●", media: "●", fora: "○" };
  const compHtml = comp ? `<span class="c-comp ${comp.nivel}" title="${esc(comp.motivo)}" aria-label="Compatibilidade: ${comp.nivel==="tocando"?"é a faixa selecionada":comp.nivel==="alta"?"alta":comp.nivel==="media"?"média":"fora"}">${nivelTxt[comp.nivel]}</span>` : `<span class="c-comp" title="Sem leitura: selecione uma faixa com BPM e tom">·</span>`;
  const deckBtns = sem ? "" : paraDeck(x).replace(/class="para-deck"( role="button" tabindex="0" data-carregar="([AB])")/g, (t, r, l) => `class="para-deck${decksDe.includes(l)?" carregado-"+l:""}"${r}`);
  return `
    <div class="${cls}" data-chave="${ch}" data-i="${i}" ${sem?`data-sem-analise title="${esc(x.erro||"não analisada")}"`:`data-faixa="${x.id}" draggable="true" role="button" tabindex="0" title="Clique para selecionar; arraste para um deck"`}>
      <span class="capa" style="--cor:${sem?"var(--fg-3)":corCamelot(x.camelot)}" aria-hidden="false">${esc(biblioIniciais(x.artista))}<button type="button" class="c-cor cor-ponto${x.cor?" cor-"+x.cor:""}" data-cor-ciclo="1" title="${x.cor?esc(x.cor)+" — clique para mudar":"Sem cor — clique para colorir"}" aria-label="Cor da faixa: ${x.cor?esc(x.cor):"nenhuma"}"></button></span>
      <span class="c-tit" title="${esc(x.titulo)}">${esc(x.titulo)}${biblioSeloLoop(x)}<span class="sub">${sem?"não analisada":esc(x.artista)}</span></span>
      <span class="c-art" title="${sem?"":esc(x.artista)}">${sem?`<span class="sem-tom">não analisada</span>`:esc(x.artista)}</span>
      <span class="c-bpm mono">${sem?"—":fmtBpm(x.bpm)}</span>
      ${sem?`<span class="chave">—</span>`:chave(x.camelot)}
      <span class="c-dur mono">${biblioDuracaoTxt(x.duracao)}</span>
      <span class="c-nota">${biblioEstrelas(x)}<button type="button" class="c-ed${x.comentario?" tem":""}" data-coment="1" title="${x.comentario?esc(x.comentario):"Clique para comentar"}" aria-label="Comentário de ${esc(x.titulo)}">✎</button></span>
      <span class="c-deck">${sem?"":deckBtns}${biblioAcoes(x, i, total)}</span>
      <span class="c-toc${vezes?" sim":""}" title="${vezes?`Já tocada ${vezes}× neste set`:"Ainda não tocou neste set"}">${vezes?"✓"+(vezes>1?vezes:""):""}</span>
      ${compHtml}
      ${edit}
    </div>`;
}

// ---------- barra de listas (playlists e inteligentes) ----------
function biblioBarraListas(){
  const e = biblioEstado, lista = biblioListaAtual();
  const pls = biblioListas.filter(l=>l.tipo==="playlist"), ints = biblioListas.filter(l=>l.tipo==="inteligente");
  const opt = l => `<option value="${esc(l.id)}"${l.id===e.lista?" selected":""}>${esc(l.nome)}</option>`;
  const nomeando = e.modoNome ? `<span class="bib-nome"><input type="text" id="bib-nome" maxlength="120" placeholder="${e.modoNome==="renomear"?"novo nome":"nome da lista"}" value="${e.modoNome==="renomear"&&lista?esc(lista.nome):""}" aria-label="Nome da lista"><button type="button" class="bib-limpar" id="bib-nome-ok">OK</button><button type="button" class="bib-limpar" id="bib-nome-cancela">Cancelar</button></span>` : "";
  return `<div class="biblio-listas" role="group" aria-label="Listas">
      <label>Lista <select id="bib-lista" aria-label="Qual lista mostrar"><option value="">Coleção (tudo)</option>${pls.length?`<optgroup label="Listas">${pls.map(opt).join("")}</optgroup>`:""}${ints.length?`<optgroup label="Inteligentes">${ints.map(opt).join("")}</optgroup>`:""}</select></label>
      <button type="button" class="bib-limpar" id="bib-nova-lista">Nova lista</button>
      <button type="button" class="bib-limpar" id="bib-nova-int">Nova inteligente</button>
      ${lista?`<button type="button" class="bib-limpar" id="bib-renomear">Renomear</button>${e.apagando?`<button type="button" class="bib-limpar bib-perigo" id="bib-apagar-sim">Apagar mesmo</button><button type="button" class="bib-limpar" id="bib-apagar-nao">Não</button>`:`<button type="button" class="bib-limpar" id="bib-apagar">Apagar</button>`}`:""}
      ${nomeando}
      ${pls.length?`<label title="O botão ＋ de cada faixa adiciona a esta lista">Adicionar ao <select id="bib-destino" aria-label="Lista de destino do botão mais"><option value="">—</option>${pls.map(l=>`<option value="${esc(l.id)}"${l.id===e.destino?" selected":""}>${esc(l.nome)}</option>`).join("")}</select></label>`:""}
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
      ? `<select data-regra-valor="${i}" aria-label="Valor da regra">${VbMxMeta.CORES.map(c=>`<option value="${c}"${c===r.texto?" selected":""}>${c}</option>`).join("")}</select>`
      : `<input type="${r.campo==="data"?"date":"text"}" data-regra-valor="${i}" value="${esc(r.campo==="camelot"?biblioTomRegraTela(r.texto):r.texto)}" placeholder="${r.campo==="bpm"&&r.op==="entre"?"120 - 130":r.op==="uma-de"?tomTexto("8A")+", "+tomTexto("9A"):""}" aria-label="Valor da regra">`;
    return `<div class="regra"><select data-regra-campo="${i}" aria-label="Campo da regra">${BIBLIO_CAMPOS_REGRA.map(([c,n])=>`<option value="${c}"${c===r.campo?" selected":""}>${c==="camelot"?esc(biblioRotuloTom()):n}</option>`).join("")}</select>
      <select data-regra-op="${i}" aria-label="Operador da regra">${ops.map(o=>`<option value="${esc(o)}"${o===r.op?" selected":""}>${esc(BIBLIO_OPS[o]||o)}</option>`).join("")}</select>${valor}
      <button type="button" class="bib-mini" data-regra-tira="${i}" aria-label="Remover regra">✕</button></div>`;
  }).join("");
  return `<div class="biblio-regras" role="group" aria-label="Regras da lista inteligente">
      <span class="rotulo">Regras</span> <label>casar <select id="bib-combinar" aria-label="Combinar regras"><option value="todas"${lista.combinar!=="qualquer"?" selected":""}>todas</option><option value="qualquer"${lista.combinar==="qualquer"?" selected":""}>qualquer</option></select></label>
      ${linhas || `<span class="regra-vazia">Sem regras: mostra a coleção inteira.</span>`}
      <button type="button" class="bib-limpar" id="bib-regra-nova">＋ regra</button></div>`;
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
      <span class="rotulo">Biblioteca</span>
      ${arvvBotaoHTML()}
      <input type="search" id="busca" placeholder="título, artista, gênero ou casa (ex.: 8A) · artista:nome · comentario:texto" value="${esc(e.texto)}" aria-label="Buscar na biblioteca">
      <span class="cont">${itens.length}/${lista?"lista":BIBLIOTECA.length} · clique = selecionar · arraste para um deck</span>
    </div>
    ${biblioBarraListas()}
    <div class="biblio-filtros" role="group" aria-label="Filtros da biblioteca">
      <label class="filtro-bpm">BPM <input type="number" id="bib-bpm-min" min="0" max="300" step="1" inputmode="numeric" placeholder="de" value="${esc(e.bpmMin)}" aria-label="BPM mínimo"> – <input type="number" id="bib-bpm-max" min="0" max="300" step="1" inputmode="numeric" placeholder="até" value="${esc(e.bpmMax)}" aria-label="BPM máximo"></label>
      <label>Tom <select id="bib-casa" aria-label="Filtrar por tom">${biblioOpcoes(casas, e.casa, "todos", tomTexto)}</select></label>
      ${generos.length ? `<label>Gênero <select id="bib-genero" aria-label="Filtrar por gênero">${biblioOpcoes(generos, e.genero, "todos")}</select></label>` : ""}
      ${anos.length ? `<label>Ano <select id="bib-ano" aria-label="Filtrar por ano">${biblioOpcoes(anos, e.ano, "todos")}</select></label>` : ""}
      <label>Estrelas <select id="bib-av" aria-label="Avaliação mínima">${["","1","2","3","4","5"].map(v=>`<option value="${v}"${v===e.avMin?" selected":""}>${v===""?"todas":"≥ "+v+" ★"}</option>`).join("")}</select></label>
      <label>Cor <select id="bib-cor" aria-label="Filtrar por cor"><option value="">todas</option>${VbMxMeta.CORES.map(c=>`<option value="${c}"${c===e.cor?" selected":""}>${c}</option>`).join("")}</select></label>
      <label class="filtro-compat" title="Só o que o motor aponta como mixável com a faixa selecionada (tom e BPM)"><input type="checkbox" id="bib-compat"${e.soCompat?" checked":""}> só compatíveis</label>
      <label class="filtro-compat" title="Esconde o que já tocou neste set"><input type="checkbox" id="bib-tocadas"${e.esconderTocadas?" checked":""}> esconder já tocadas</label>
      <label class="filtro-compat" title="Linhas mais baixas"><input type="checkbox" id="bib-compacto"${VbMxPrefs.ler("biblio.densidade")==="compacta"?" checked":""}> compacta</label>
      <label>Grupos <select id="bib-agrupar" aria-label="Agrupar a lista">${BIBLIO_AGRUPAR.map(([v,r])=>`<option value="${v}"${v===e.agrupar?" selected":""}>${r}</option>`).join("")}</select></label>
      ${biblioTemFiltro() || e.coluna ? `<button type="button" class="bib-limpar" id="bib-limpar">Limpar</button>` : ""}
    </div>
    ${vistaArvore ? `<div class="lista lista-arvore">${arvoreVistaHTML()}</div>` : `<div class="lista">
      <div class="lista-cab">${BIBLIO_COLUNAS.map(([c,r,cls])=>c ? `<button type="button" class="rotulo ord ${cls} ${e.coluna===c?"ativa":""}" data-ordem="${c}" aria-label="Ordenar por ${r}${e.coluna===c?(e.direcao==="asc"?" (crescente)":" (decrescente)"):""}">${r}${seta(c)}</button>` : `<span class="rotulo ${cls}">${r}</span>`).join("")}</div>
      ${itens.length ? grupos.map(g=>`${e.agrupar?`<div class="grupo-cab"><span class="rotulo">${esc(e.agrupar==="camelot"&&g.rotulo?tomTexto(g.rotulo):g.rotulo)}</span><span class="grupo-n">${g.faixas.length}</span></div>`:""}${g.faixas.map(f=>biblioLinha(f, pos++, itens.length)).join("")}`).join("")
        : `<div class="vazio-biblio">${lista && lista.tipo==="playlist" && !lista.chaves.length ? "Lista vazia. Escolha a lista em “Adicionar ao” e use ＋ nas faixas da coleção." : "Nenhuma faixa com esses filtros."} ${biblioTemFiltro()?`<button type="button" class="bib-limpar" id="bib-limpar-vazio">Limpar filtros</button>`:""}</div>`}
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
VbMxUI.aoIniciar(()=>{
  VbMxUI.ouvir("biblioteca:mudou", ({faixas})=>{ biblioLerTags(faixas); biblioMarcarImportadas(faixas); });
  for (const ev of ["deck:carregado", "deck:descarregado", "historico:mudou"]) VbMxUI.ouvir(ev, ()=>renderBiblio());   // deck-A/B, ✓ de já tocada
  VbMxUI.ouvir("meta:mudou", biblioRecarregar);              // VB-27 (importação do .nml) e quem mais gravar em VbMxMeta
  biblioLerTags(BIBLIOTECA);
  biblioRecarregar().then(()=>biblioMarcarImportadas(BIBLIOTECA));
});
