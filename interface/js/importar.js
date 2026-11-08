// ===================== importar.js — importar o collection.nml (VB-27) =====================
// A lógica (ler o XML, casar as faixas, decidir o que gravar) é de biblioteca/nml.js, testada em Node.
// Aqui só: escolher o arquivo, ligar o `alvo` aos armazéns do VbMx e mostrar o relatório.
// Nada mexe no DOM no carregamento: o painel nasce em VbMxUI.aoIniciar, logo abaixo das pastas.
//
// Onde cada coisa é gravada:
//   grade   → localStorage `vbmx-grade:<caminho>` (o mesmo ajuste manual de js/grade-ui.js) e `faixa.grade`
//   tom     → entrada do cache de análise (VbMxBiblioteca.chaveCache) e `faixa.camelot`
//   cues    → IndexedDB `vbmx-cues-v1` (VbMxMarcadores), a mesma chave do hotcues.js
//   nota, cor, comentário e playlists → `importarDestinos` (injetável): biblioteca/meta.js (VB-17b) preenche
//     `importarDestinos.gravarMeta(faixa, meta)` e `importarDestinos.gravarPlaylists(listas)`. Sem isso o
//     relatório avisa que foram lidos e não gravados.
// O que o usuário editou (grade ajustada, hotcue/cue já definido, tom analisado diferente) NÃO é sobrescrito,
// salvo a caixa "sobrescrever".
// "Diagnóstico da análise": compara a análise do VbMx (do cache de análise, não a grade já importada) com a
// grade do .nml e mostra SÓ agregados (biblioteca/diagnostico.js, carregado no clique).
const importarDestinos = { gravarMeta: null, gravarPlaylists: null };

// ---------- conversões .nml → VbMxMeta (VB-48) ----------
// COR: `INFO@COLOR` é um inteiro 1–7 (0/ausente = sem cor). A tabela abaixo é [inferência]: formatos.md não
// documenta o atributo (só a lacuna). Ordem da paleta de 7 cores; fora dela vira sem cor (null).
const IMPORTAR_TABELA_COR = { 1: "vermelho", 2: "laranja", 3: "amarelo", 4: "verde", 5: "azul", 6: "roxo", 7: "rosa" };
function importarCor(c){
  const nome = IMPORTAR_TABELA_COR[Number(c)];
  return nome && VbMxMeta.CORES.includes(nome) ? nome : null;
}
// ESTRELAS: o nml.js já entrega 0–5; um valor bruto do RANKING (0–255, 51 por estrela) também é aceito.
function importarEstrelas(r){
  const n = Number(r);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(5, n <= 5 ? Math.round(n) : Math.round(n / 51));
}
// Item de `definirLote` para uma faixa: a chave é a de VbMxMeta.chaveDe (a mesma de biblio.js); só entra o que veio.
function importarItemMeta(faixa, m){
  const it = { chave: VbMxMeta.chaveDe(faixa) };
  if (m.rating !== null && m.rating !== undefined) it.avaliacao = importarEstrelas(m.rating);
  if (m.cor) { const c = importarCor(m.cor); if (c) it.cor = c; }
  if (m.comentario) it.comentario = m.comentario;
  return it;
}
let importarLote = [];
function importarMeta(){ return typeof biblioMeta === "function" ? biblioMeta() : VbMxMeta.doNavegador(); }
importarDestinos.gravarMeta = (faixa, m) => { importarLote.push(importarItemMeta(faixa, m)); };
// Playlists: reaproveita a de mesmo nome (reimportar não duplica; `adicionar` ignora chave repetida).
importarDestinos.gravarPlaylists = async (listas) => {
  const meta = importarMeta();
  const existentes = await meta.listas();
  for (const l of listas) {
    const achada = existentes.find(x => x.tipo === "playlist" && x.nome === l.nome);
    const dest = achada || await meta.criarLista(l.nome);
    if (dest) await meta.adicionar(dest.id, l.faixas.map(f => VbMxMeta.chaveDe(f)));
  }
};
// Depois do N.importar: grava o lote de uma vez e avisa a tela. → nº de faixas gravadas.
async function importarDescarregar(){
  const lote = importarLote; importarLote = [];
  const n = lote.length ? await importarMeta().definirLote(lote) : 0;
  VbMxUI.emitir("meta:mudou", {});
  return n;
}
const importarEstado = { colecao: null, texto: "", nome: "", pronto: false, ocupado: false };

// Tamanho e data do arquivo (a chave de cache e de marcadores usa os dois); falha vira -1, como na varredura.
async function importarMedir(faixa){
  let tamanho = -1, data = -1;
  try { const arq = await faixa.obter(); tamanho = arq.size; data = arq.lastModified; } catch(_){}
  return { tamanho, data };
}
// Cópia leve da faixa com tamanho/data, para o casamento; o alvo grava na original (`.original`).
async function importarProxies(faixas){
  const lista = [];
  for (const f of faixas) {
    if (!f || !f.caminho || typeof f.obter !== "function") continue;   // exemplo não tem arquivo
    const m = await importarMedir(f);
    lista.push(Object.assign(Object.create(f), { original: f, tamanho: m.tamanho, data: m.data }));
  }
  return lista;
}

function importarChaveGrade(f){ return "vbmx-grade:" + f.caminho; }

function importarCacheAnalise(){
  try { return VbMxBiblioteca.criarCache(window.indexedDB ? VbMxBiblioteca.armazemIndexedDB(window.indexedDB) : null); } catch(_){ return null; }
}

function importarAlvo(){
  const marc = VbMxMarcadores.doNavegador();
  const cache = importarCacheAnalise();
  const alvo = {
    lerGrade(f){
      try {
        const v = JSON.parse(localStorage.getItem(importarChaveGrade(f)) || "null");
        if (!v) return null;
        return v.apagada ? { bpm: 0, primeira: 0 } : VbMxBiblioteca.gradeValida(v) ? { bpm: v.bpm, primeira: v.primeira } : null;
      } catch(_){ return null; }
    },
    gravarGrade(f, g){
      let travada = false;
      try { const v = JSON.parse(localStorage.getItem(importarChaveGrade(f)) || "null"); travada = !!(v && v.travada); } catch(_){}
      try { localStorage.setItem(importarChaveGrade(f), JSON.stringify({ bpm: g.bpm, primeira: g.primeira, travada })); } catch(_){ /* vale só na sessão */ }
      const o = f.original;
      if (!o.gradeTravada || !o.grade) o.grade = { bpm: g.bpm, primeira: g.primeira };
      if (!(o.bpm > 0)) o.bpm = g.bpm;
    },
    async gravarDuracao(f, s){
      const o = f.original;
      if (!(o.duracao > 0)) o.duracao = s;
      if (cache && cache.ativo) {
        const antigo = await cache.ler(f.caminho, f.tamanho, f.data);
        if (antigo && antigo.analisavel !== false && !(antigo.duracao > 0)) await cache.gravar(f.caminho, f.tamanho, f.data, Object.assign({}, antigo, { duracao: s }));
      }
    },
    async lerMarcadores(f){ return marc.ler(VbMxMarcadores.chave(f.caminho, f.tamanho, f.data)); },
    async gravarMarcadores(f, reg){ await marc.gravar(VbMxMarcadores.chave(f.caminho, f.tamanho, f.data), reg); },
    async gravarTom(f, camelot){
      const o = f.original;
      o.camelot = camelot;
      if (o.bpm > 0 && !o.analisavel) { o.analisavel = true; delete o.erro; }
      if (cache && cache.ativo && o.bpm > 0) {
        // só o TOM muda no cache de análise: BPM e grade ficam os da análise do VbMx. Antes, a grade da faixa
        // (já trocada pela do .nml em gravarGrade) ia para o cache e passava a valer como "análise" — o RESET e o
        // diagnóstico comparavam o Traktor com ele mesmo. A grade importada mora em localStorage (gravarGrade).
        const antigo = await cache.ler(f.caminho, f.tamanho, f.data);
        const valido = antigo && antigo.analisavel !== false;
        const novo = Object.assign({}, valido ? antigo : { analisavel: true, forca: 0, bpm: o.bpm }, { camelot });
        await cache.gravar(f.caminho, f.tamanho, f.data, novo);
      }
    },
  };
  if (typeof importarDestinos.gravarMeta === "function") alvo.gravarMeta = (f, m) => importarDestinos.gravarMeta(f.original, m);
  if (typeof importarDestinos.gravarPlaylists === "function") alvo.gravarPlaylists = (ls) => importarDestinos.gravarPlaylists(ls.map(l => Object.assign({}, l, { faixas: l.faixas.map(x => x.original || x) })));
  return alvo;
}

function importarPainel(){ return document.getElementById("importar-nml"); }

function importarDesenhar(rel, erro){
  const el = importarPainel();
  if (!el) return;
  const c = importarEstado.colecao;
  let corpo = "";
  if (erro) corpo = `<p class="importar-erro">${esc(erro)}</p>`;
  else if (rel) {
    const naoGravou = [];
    if (c && c.faixas.some(f => f.rating !== null || f.cor || f.comentario) && !importarDestinos.gravarMeta) naoGravou.push("nota, cor e comentário");
    if (c && c.playlists.some(p => p.tipo !== "PROTOCOL") && !importarDestinos.gravarPlaylists) naoGravou.push("playlists");
    const lista = (titulo, itens, fmt) => itens.length ? `<details><summary>${titulo} (${itens.length})</summary><ul>${itens.slice(0, 50).map(i => `<li>${esc(fmt(i))}</li>`).join("")}${itens.length > 50 ? `<li>… e mais ${itens.length - 50}</li>` : ""}</ul></details>` : "";
    corpo = `<p class="importar-resumo">${esc(VbMxNml.textoRelatorio(rel))}</p>`
      + (naoGravou.length ? `<p class="importar-aviso">Lidos mas ainda não gravados: ${esc(naoGravou.join(" e "))} (sem armazém de metadados).</p>` : "")
      + `<p class="importar-nota">Slots de hotcue lidos em base ${rel.baseSlots} (${rel.baseSlots === 0 ? "o 0 do arquivo é o 1º slot" : "o 0 do arquivo é \"sem slot\"; 1 é o 1º slot"}). Se um hotcue caiu no slot errado, avise: é a lacuna 4 de docs/formatos.md.</p>`
      + lista("Conflitos", rel.conflitos, x => `${x.faixa} · ${x.campo}: VbMx ${x.atual} / arquivo ${x.nml}${x.sobrescrito ? " (sobrescrito)" : " (mantido o do VbMx)"}`)
      + lista("Sem par", rel.semPar, x => `${x.arquivo} — ${x.motivo}`)
      + lista("Ambíguas", rel.ambiguas, x => `${x.arquivo} — ${x.motivo}`)
      + lista("Avisos", rel.avisos, x => x);
  } else if (c) {
    corpo = `<p class="importar-resumo">${esc(importarEstado.nome)}: ${c.faixas.length} faixas, ${c.playlists.filter(p => p.tipo !== "PROTOCOL").length} playlist(s).</p>`
      + `<label class="importar-sob"><input type="checkbox" id="importar-sob"> sobrescrever o que já editei no VbMx (grade, cues, tom)</label>`
      + `<button type="button" class="botao-pasta" id="importar-ir" ${importarEstado.ocupado ? "disabled" : ""}>Importar para a biblioteca</button>`;
  }
  if (c) corpo += `<div class="importar-diag"><button type="button" class="botao-pasta" id="importar-diagnostico" ${importarEstado.ocupado ? "disabled" : ""}>Diagnóstico da análise</button>`
    + `<span class="pastas-estado"> BPM e grade do VbMx × .nml, só números agregados (nenhum nome sai daqui)</span><div class="importar-diag-corpo"></div></div>`;
  el.querySelector(".importar-corpo").innerHTML = corpo;
  const ir = document.getElementById("importar-ir");
  if (ir) ir.onclick = importarExecutar;
  const dg = document.getElementById("importar-diagnostico");
  if (dg) dg.onclick = importarDiagnosticar;
}

// A lógica do diagnóstico só é baixada no clique (o esqueleto da página não muda).
function importarCarregarDiagnostico(){
  if (window.VbMxDiagnostico) return Promise.resolve();
  return new Promise((ok, falha) => {
    const s = document.createElement("script");
    s.src = "../biblioteca/diagnostico.js";
    s.onload = () => ok();
    s.onerror = () => falha(new Error("não consegui carregar biblioteca/diagnostico.js"));
    document.head.appendChild(s);
  });
}

// Análise do VbMx de uma faixa, do cache de análise (a versão atual, VERSAO_ANALISE): { bpm, grade } ou null.
async function importarAnaliseDoCache(cache, f){
  const c = cache && cache.ativo ? await cache.ler(f.caminho, f.tamanho, f.data) : null;
  if (!c || c.analisavel === false || !(c.bpm > 0)) return null;
  return { bpm: c.bpm, grade: VbMxBiblioteca.gradeValida(c.grade) ? { bpm: c.grade.bpm, primeira: c.grade.primeira } : null };
}

async function importarDiagnosticar(){
  if (importarEstado.ocupado || !importarEstado.texto) return;
  const caixa = importarPainel().querySelector(".importar-diag-corpo");
  importarEstado.ocupado = true;
  caixa.innerHTML = `<p class="importar-resumo">Medindo…</p>`;
  try {
    await importarCarregarDiagnostico();
    const faixas = ehExemplo ? [] : await importarProxies(BIBLIOTECA);
    if (!faixas.length) throw new Error("Adicione a pasta de músicas antes: o diagnóstico compara a análise de cada faixa com o .nml.");
    const cache = importarCacheAnalise();
    const r = await VbMxDiagnostico.diagnosticar(importarEstado.texto, faixas, (f) => importarAnaliseDoCache(cache, f));
    const vazio = r.comBpm ? "" : `<p class="importar-aviso">Nenhuma faixa casada tem análise na versão ${VbMxBiblioteca.VERSAO_ANALISE} do cache: adicione a pasta de novo (ela é reanalisada uma vez) e repita.</p>`;
    caixa.innerHTML = vazio + `<pre class="importar-resumo" style="white-space:pre-wrap">${esc(VbMxDiagnostico.textoResumo(r))}</pre>`
      + `<p class="importar-nota">Só contagens, medianas e p95: copie o bloco acima e mande. Nenhum nome de faixa ou pasta entra nele.</p>`;
  } catch (e) { caixa.innerHTML = `<p class="importar-erro">${esc("Diagnóstico falhou: " + ((e && e.message) || e))}</p>`; }
  finally { importarEstado.ocupado = false; }
}

async function importarExecutar(){
  if (importarEstado.ocupado || !importarEstado.colecao) return;
  const sob = !!(document.getElementById("importar-sob") || {}).checked;
  importarEstado.ocupado = true;
  const corpo = importarPainel().querySelector(".importar-corpo");
  corpo.innerHTML = `<p class="importar-resumo">Importando…</p>`;
  try {
    const faixas = ehExemplo ? [] : await importarProxies(BIBLIOTECA);
    if (!faixas.length) throw new Error("Adicione uma pasta de músicas antes: as faixas de exemplo não têm arquivo para casar.");
    const rel = await VbMxNml.importar(importarEstado.colecao, faixas, importarAlvo(), { sobrescrever: sob });
    await importarDescarregar();
    importarDesenhar(rel);
    if (typeof renderTudo === "function") renderTudo();
  } catch (e) { importarDesenhar(null, "Falhou: " + ((e && e.message) || e)); }
  finally { importarEstado.ocupado = false; }
}

async function importarLerArquivo(arquivo){
  importarEstado.colecao = null; importarEstado.texto = ""; importarEstado.nome = arquivo.name;
  const corpo = importarPainel().querySelector(".importar-corpo");
  corpo.innerHTML = `<p class="importar-resumo">Lendo ${esc(arquivo.name)}…</p>`;
  try {
    const texto = await arquivo.text();
    importarEstado.colecao = VbMxNml.lerColecao(texto);
    importarEstado.texto = texto; // o diagnóstico relê a âncora crua (lerColecao a reduz ao período)
    importarDesenhar(null);
  } catch (e) { importarDesenhar(null, "Não consegui ler o arquivo: " + ((e && e.message) || e)); }
}

async function importarEscolher(){
  // showOpenFilePicker (Chrome) deixa o painel sem <input>; o input é a reserva.
  if (typeof window.showOpenFilePicker === "function") {
    try {
      const [h] = await window.showOpenFilePicker({ multiple: false, types: [{ description: "Coleção do Traktor", accept: { "text/xml": [".nml"] } }] });
      return importarLerArquivo(await h.getFile());
    } catch (e) { if (e && e.name === "AbortError") return; /* outro erro: cai no input */ }
  }
  document.getElementById("importar-entrada").click();
}

VbMxUI.aoIniciar(() => {
  const ancora = document.getElementById("pastas");
  if (!ancora || importarPainel()) return;
  const sec = document.createElement("section");
  sec.id = "importar-nml"; sec.className = "importar";
  sec.setAttribute("aria-label", "Importar coleção do Traktor");
  sec.innerHTML = `<div class="importar-cab"><button type="button" class="botao-pasta" id="importar-abrir">Importar collection.nml</button>`
    + `<span class="pastas-estado">grade, tom, cues e hotcues entram na biblioteca já carregada; o que você editou fica.</span>`
    + `<input type="file" id="importar-entrada" accept=".nml,text/xml,application/xml" hidden></div><div class="importar-corpo"></div>`;
  ancora.insertAdjacentElement("afterend", sec);
  document.getElementById("importar-abrir").onclick = importarEscolher;
  document.getElementById("importar-entrada").onchange = (ev) => { const f = ev.target.files && ev.target.files[0]; ev.target.value = ""; if (f) importarLerArquivo(f); };
});
