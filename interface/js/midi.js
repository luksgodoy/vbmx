// ===================== midi.js — controladora MIDI → VbMxUI.acao =====================
// VB-25 + VB-40 (onda 2). Web MIDI + despachante de controles + painel "Controles" (MIDI learn).
// Fluxo: tecla (teclado.js) ou mensagem MIDI → controlesEntrada(fisico, valor) → atribuições dos mapeamentos
// ativos (VbMxMapaControle.achar) → modo de interação (lógica pura em motor/mapa-controle.js) → VbMxUI.acao.
// Mapeamentos em localStorage ("vbmx-mapas"), exportar/importar em JSON próprio (sem .tsi, sem M1–M8).
// No carregamento só declara; DOM e Web MIDI entram em VbMxUI.aoIniciar.

const controles = {
  mapas: [],            // mapeamentos (todos os ativos valem ao mesmo tempo)
  estados: new Map(),   // id da atribuição → estado de interação (botão/fader/encoder)
  repeticoes: new Map(),// id da atribuição → timer de "repetir ao segurar"
  aprendendo: null,     // {mapaId, atribuicao?, aoCapturar(fisico)} enquanto espera um controle
  entradas: [],         // nomes das portas MIDI conectadas
  statusMidi: "MIDI: não iniciado",
  el: null,
};
const CONTROLES_CHAVE = "vbmx-mapas";

// ---------------------------------------------------------------- persistência
function controlesSalvar() {
  try { localStorage.setItem(CONTROLES_CHAVE, JSON.stringify({ versao: 1, mapas: controles.mapas })); } catch (_) {}
}
function controlesCarregar() {
  try {
    const bruto = localStorage.getItem(CONTROLES_CHAVE);
    if (bruto) {
      const o = JSON.parse(bruto);
      if (o && Array.isArray(o.mapas)) { controles.mapas = o.mapas.filter((m) => m && Array.isArray(m.atribuicoes)); return; }
    }
  } catch (_) {}
  controles.mapas = [];
}
function controlesMapaPadrao() {
  const M = VbMxMapaControle;
  const m = M.novoMapeamento("Teclado");
  for (const [codigo, comando, alvo] of TECLADO_PADRAO) m.atribuicoes.push(M.novaAtribuicao({ fisico: { tipo: "tecla", codigo }, comando, alvo }));
  return m;
}

// ---------------------------------------------------------------- leitura do estado atual (para direct e soft takeover)
function controlesEstadoLogico(cmd, alvo) {          // estado ligado/desligado de comandos com estado
  if (cmd.id === "play") return tocandoDeck(alvo);
  if (cmd.id === "loopAuto") return !!loopsDeck(alvo).ativo;
  if (cmd.id === "flux") return !!loopsDeck(alvo).flux;
  return false;
}
function controlesValorAtual(cmd, alvo) {            // valor do parâmetro na faixa dele
  if (cmd.id === "mixer.xfade") return mixer.xfade;
  if (cmd.id === "mixer.master-vol") return mixer.master.vol;
  return mixer[alvo][cmd.nome];
}
const controlesPara01 = (cmd, v) => (v - cmd.faixa[0]) / (cmd.faixa[1] - cmd.faixa[0]);
const controlesDe01 = (cmd, v01) => cmd.faixa[0] + v01 * (cmd.faixa[1] - cmd.faixa[0]);

function controlesAgir(nome, ...args) {
  try { VbMxUI.acao(nome, ...args); } catch (e) { console.warn("controles: ação falhou", nome, e); }
}

// ---------------------------------------------------------------- despacho
function controlesBotao(a, cmd, valor) {
  const M = VbMxMapaControle, o = a.opcoes || {};
  const r = M.processarBotao(controles.estados.get(a.id), a.modo, valor,
    { tipoAcao: cmd.tipoAcao === "valor" ? "gatilho" : cmd.tipoAcao, valorFixo: o.valorFixo, repetir: o.repetir, inverter: o.inverter });
  controles.estados.set(a.id, r.est);
  const nome = M.nomeDaAcao(cmd, a.alvo);
  if (!nome) return;
  for (const ev of r.eventos) {
    if (ev.op === "disparar") controlesAgir(nome);
    else if (ev.op === "descer") controlesAgir(nome, true);
    else if (ev.op === "subir") controlesAgir(nome, false);
    else if (ev.op === "definir") {
      if (cmd.tipoAcao === "booleano") controlesAgir(nome, !!ev.valor);
      else if (cmd.tipoAcao === "pressionar") controlesAgir(nome, !!ev.valor);
      else if (cmd.temEstado) { if (M.deveAplicarDireto(ev.valor, controlesEstadoLogico(cmd, a.alvo))) controlesAgir(nome); }
      else if (ev.valor) controlesAgir(nome);           // gatilho sem estado: 1 dispara, 0 não faz nada
    }
  }
  // repetir ao segurar: só para gatilhos (avançar beatjump, passos de BPM…); para ao soltar
  const antes = controles.repeticoes.get(a.id);
  if (r.repetir && !antes && cmd.tipoAcao === "gatilho" && !cmd.temEstado) {
    controles.repeticoes.set(a.id, setInterval(() => controlesAgir(nome), Math.max(40, Number(o.repetirMs) || 150)));
  } else if (!r.repetir && antes) { clearInterval(antes); controles.repeticoes.delete(a.id); }
}
function controlesFader(a, cmd, valor) {
  const M = VbMxMapaControle, o = a.opcoes || {};
  const atual01 = controlesPara01(cmd, controlesValorAtual(cmd, a.alvo));
  const r = M.processarFader(controles.estados.get(a.id), a.modo, valor, atual01,
    { inverter: o.inverter, resolucao: o.resolucao, softTakeover: o.softTakeover, sensibilidade: o.sensibilidade });
  controles.estados.set(a.id, r.est);
  if (r.alvo01 === null) return;
  const nome = M.nomeDaAcao(cmd, a.alvo);
  if (nome) controlesAgir(nome, controlesDe01(cmd, r.alvo01));
}
function controlesEncoder(a, cmd, valor, tMs) {
  const M = VbMxMapaControle, o = a.opcoes || {};
  const r = M.processarEncoder(controles.estados.get(a.id), o.codificacao, valor, tMs,
    { sensibilidade: o.sensibilidade, aceleracao: o.aceleracao, inverter: o.inverter });
  controles.estados.set(a.id, r.est);
  if (r.delta === 0) return;
  const chamadas = M.despachoDoEncoder(cmd, a.alvo, r.passo);   // jog: o giro com sinal; beatjump e afins: um passo por clique
  if (chamadas) { for (const c of chamadas) controlesAgir(c.nome, ...c.args); return; }
  const atual01 = controlesPara01(cmd, controlesValorAtual(cmd, a.alvo));   // parâmetro: 1/64 da faixa por clique
  const novo = M.aplicarResolucao(Math.min(1, Math.max(0, atual01 + r.passo / 64)), o.resolucao);
  const nome = M.nomeDaAcao(cmd, a.alvo);
  if (nome) controlesAgir(nome, controlesDe01(cmd, novo));
}

// Ponto de entrada único de teclado e MIDI. Devolve true se a entrada foi usada (aprendida ou mapeada).
function controlesEntrada(fisico, valor, tMs) {
  if (controles.aprendendo) {
    if (valor > 0 || fisico.tipo === "cc") {           // nota/tecla: o aperto; CC: o primeiro movimento
      const cap = controles.aprendendo; controles.aprendendo = null;
      cap.aoCapturar(fisico);
    }
    return true;
  }
  const achadas = VbMxMapaControle.achar(controles.mapas, fisico);
  for (const { atribuicao: a } of achadas) {
    const cmd = VbMxMapaControle.comandoPorId(a.comando);
    if (!cmd) continue;
    if (a.tipo === "botao") controlesBotao(a, cmd, valor);
    else if (a.tipo === "fader" && cmd.tipoAcao === "valor") controlesFader(a, cmd, valor);
    else if (a.tipo === "encoder") controlesEncoder(a, cmd, valor, tMs || performance.now());
  }
  return achadas.length > 0;
}

// ---------------------------------------------------------------- Web MIDI
function midiAoMensagem(ev) {
  const m = VbMxMapaControle.interpretarMidi(ev.data);
  if (m) controlesEntrada(m.fisico, m.valor, ev.timeStamp);
}
function midiLigarPortas(acesso) {
  const nomes = [];
  for (const entrada of acesso.inputs.values()) { entrada.onmidimessage = midiAoMensagem; nomes.push(entrada.name || entrada.id); }
  controles.entradas = nomes;
  controles.statusMidi = nomes.length ? `MIDI: ${nomes.join(", ")}` : "MIDI: nenhum controlador conectado";
  controlesPintarStatus();
}
function midiIniciar() {
  if (!navigator.requestMIDIAccess) { controles.statusMidi = "MIDI: este navegador não tem Web MIDI (use o Chrome)"; return; }
  navigator.requestMIDIAccess({ sysex: false }).then((acesso) => {
    midiLigarPortas(acesso);
    acesso.onstatechange = () => midiLigarPortas(acesso);
  }).catch((e) => { controles.statusMidi = "MIDI: acesso negado (" + (e && e.name || "erro") + ")"; controlesPintarStatus(); });
}

// ---------------------------------------------------------------- painel Controles (MIDI learn)
const controlesEsc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function controlesNomeFisico(f) {
  if (f.tipo === "tecla") return "Tecla " + f.codigo.replace(/^Key|^Digit/, "");
  return (f.tipo === "nota" ? "Nota " : "CC ") + f.numero + " (canal " + ((f.canal | 0) + 1) + ")";
}
function controlesPintarStatus() {
  const s = controles.el && controles.el.querySelector("[data-ctl-status]");
  if (s) s.textContent = controles.statusMidi;
}
// Rascunho da próxima atribuição a aprender
const controlesRascunho = { mapaId: null, comando: "play", alvo: "A", tipo: "botao", modo: "hold",
  opcoes: { inverter: false, repetir: false, resolucao: "fina", valorFixo: 1, softTakeover: true, sensibilidade: 1, aceleracao: 0, codificacao: "7f01" } };

function controlesMapaAtual() {
  return controles.mapas.find((m) => m.id === controlesRascunho.mapaId) || controles.mapas[0] || null;
}
function controlesDesenhar() {
  const M = VbMxMapaControle, el = controles.el;
  if (!el) return;
  const mapa = controlesMapaAtual(), r = controlesRascunho;
  if (mapa) r.mapaId = mapa.id;
  const cmd = M.comandoPorId(r.comando);
  if (cmd && !cmd.tipos.includes(r.tipo)) { r.tipo = cmd.tipos[0]; r.modo = M.modoPadrao(r.tipo); }
  const grupos = { deck: [], canal: [], global: [] };
  for (const c of M.COMANDOS) grupos[c.alvo].push(c);
  const optsCmd = (lista) => lista.map((c) => `<option value="${c.id}"${c.id === r.comando ? " selected" : ""}>${controlesEsc(c.rotulo)}</option>`).join("");
  const modos = r.tipo === "botao" ? M.MODOS_BOTAO : r.tipo === "fader" ? M.MODOS_FADER : [];
  const rotModo = { hold: "hold (segurar)", toggle: "toggle", invert: "invert (age ao soltar)", direct: "direct (valor fixo)", relative: "relative" };
  const o = r.opcoes;
  const caixa = (k, rot) => `<label class="ctl-check"><input type="checkbox" data-ctl-op="${k}"${o[k] ? " checked" : ""}> ${rot}</label>`;
  const mapasHtml = controles.mapas.map((m) => `<div class="ctl-mapa${m.id === r.mapaId ? " atual" : ""}">
      <label class="ctl-check"><input type="checkbox" data-ctl-ativo="${m.id}"${m.ativo ? " checked" : ""}> ativo</label>
      <button type="button" class="ctl-link" data-ctl-escolher="${m.id}">${controlesEsc(m.nome)}</button>
      <span class="ctl-mudo">${m.atribuicoes.length} atrib.</span>
      <button type="button" class="ctl-x" data-ctl-apagar-mapa="${m.id}" title="Apagar mapeamento" aria-label="Apagar mapeamento ${controlesEsc(m.nome)}">×</button></div>`).join("");
  const linhas = mapa ? mapa.atribuicoes.map((a) => {
    const c = M.comandoPorId(a.comando);
    return `<tr><td>${controlesEsc(controlesNomeFisico(a.fisico))}</td><td>${controlesEsc(c ? c.rotulo : a.comando)}</td><td>${a.alvo || "global"}</td>
      <td>${a.tipo}${a.tipo === "encoder" ? "" : " · " + a.modo}</td>
      <td><button type="button" class="ctl-x" data-ctl-apagar="${a.id}" aria-label="Apagar atribuição">×</button></td></tr>`;
  }).join("") : "";
  el.querySelector("[data-ctl-corpo]").innerHTML = `
    <div class="ctl-secao"><b>Mapeamentos</b> <span class="ctl-mudo">(todos os ativos valem juntos)</span>${mapasHtml || '<div class="ctl-mudo">nenhum</div>'}
      <div class="ctl-linha"><button type="button" data-ctl-novo-mapa>+ novo</button><button type="button" data-ctl-exportar>exportar JSON</button>
      <label class="ctl-arquivo">importar JSON<input type="file" accept="application/json,.json" data-ctl-importar hidden></label></div></div>
    <div class="ctl-secao"><b>Nova atribuição</b> ${mapa ? "em “" + controlesEsc(mapa.nome) + "”" : ""}
      <div class="ctl-grade">
        <label>Comando <select data-ctl-cmd><optgroup label="Deck">${optsCmd(grupos.deck)}</optgroup><optgroup label="Canal do mixer">${optsCmd(grupos.canal)}</optgroup><optgroup label="Global">${optsCmd(grupos.global)}</optgroup></select></label>
        <label>Alvo <select data-ctl-alvo${cmd && cmd.alvo === "global" ? " disabled" : ""}><option value="A"${r.alvo === "A" ? " selected" : ""}>deck/canal A</option><option value="B"${r.alvo === "B" ? " selected" : ""}>deck/canal B</option></select></label>
        <label>Tipo <select data-ctl-tipo>${(cmd ? cmd.tipos : ["botao"]).map((t) => `<option value="${t}"${t === r.tipo ? " selected" : ""}>${t}</option>`).join("")}</select></label>
        ${modos.length ? `<label>Modo <select data-ctl-modo>${modos.map((m) => `<option value="${m}"${m === r.modo ? " selected" : ""}>${rotModo[m]}</option>`).join("")}</select></label>` : ""}
      </div>
      <div class="ctl-grade">
        ${caixa("inverter", "inverter")}
        ${r.tipo === "botao" ? caixa("repetir", "repetir ao segurar") : ""}
        ${r.tipo === "botao" && r.modo === "direct" ? `<label>Valor <select data-ctl-op-sel="valorFixo"><option value="1"${o.valorFixo ? " selected" : ""}>1</option><option value="0"${!o.valorFixo ? " selected" : ""}>0</option></select></label>` : ""}
        ${r.tipo !== "botao" ? `<label>Resolução <select data-ctl-op-sel="resolucao"><option value="fina"${o.resolucao === "fina" ? " selected" : ""}>fina</option><option value="grossa"${o.resolucao === "grossa" ? " selected" : ""}>grossa</option></select></label>` : ""}
        ${r.tipo === "fader" && r.modo === "direct" ? caixa("softTakeover", "soft takeover") : ""}
        ${r.tipo !== "botao" ? `<label>Sensibilidade <input type="number" step="0.1" min="0.1" max="10" value="${o.sensibilidade}" data-ctl-op-num="sensibilidade"></label>` : ""}
        ${r.tipo === "encoder" ? `<label>Aceleração <input type="number" step="0.1" min="0" max="1" value="${o.aceleracao}" data-ctl-op-num="aceleracao"></label>
          <label>Codificação <select data-ctl-op-sel="codificacao"><option value="7f01"${o.codificacao === "7f01" ? " selected" : ""}>7Fh / 01h</option><option value="3f41"${o.codificacao === "3f41" ? " selected" : ""}>3Fh / 41h</option></select></label>` : ""}
      </div>
      <div class="ctl-linha"><button type="button" class="ctl-aprender${controles.aprendendo ? " ligado" : ""}" data-ctl-aprender${mapa ? "" : " disabled"}>${controles.aprendendo ? "mexa no controle… (clique para cancelar)" : "aprender"}</button>
        <span class="ctl-mudo" data-ctl-msg></span></div></div>
    <div class="ctl-secao"><b>Atribuições</b>${linhas ? `<div class="ctl-tabela"><table><thead><tr><th>Controle</th><th>Comando</th><th>Alvo</th><th>Tipo · modo</th><th></th></tr></thead><tbody>${linhas}</tbody></table></div>` : '<div class="ctl-mudo">nenhuma</div>'}</div>`;
  controlesPintarStatus();
}
function controlesMsg(t) { const m = controles.el && controles.el.querySelector("[data-ctl-msg]"); if (m) m.textContent = t; }

function controlesAprender() {
  if (controles.aprendendo) { controles.aprendendo = null; controlesDesenhar(); return; }
  const mapa = controlesMapaAtual(), r = controlesRascunho;
  if (!mapa) return;
  controles.aprendendo = { aoCapturar(fisico) {
    const M = VbMxMapaControle, cmd = M.comandoPorId(r.comando);
    const a = M.novaAtribuicao({ fisico, comando: r.comando, alvo: cmd.alvo === "global" ? null : r.alvo, tipo: r.tipo, modo: r.modo, opcoes: { ...r.opcoes } });
    const erros = M.validarAtribuicao(a);
    controlesDesenhar();
    if (erros.length) { controlesMsg(erros.join("; ")); return; }
    mapa.atribuicoes = mapa.atribuicoes.filter((x) => M.chaveFisico(x.fisico) !== M.chaveFisico(fisico) || x.comando !== a.comando || x.alvo !== a.alvo);
    mapa.atribuicoes.push(a);
    controlesSalvar(); controlesDesenhar();
    controlesMsg("aprendido: " + controlesNomeFisico(fisico));
  } };
  controlesDesenhar();
}

function controlesExportar() {
  const blob = new Blob([VbMxMapaControle.exportar(controles.mapas)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob); a.download = "vbmx-mapeamentos.json";
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function controlesImportar(arquivo) {
  arquivo.text().then((txt) => {
    const r = VbMxMapaControle.importar(txt);
    if (!r.ok) { controlesMsg(r.erros.join("; ")); return; }
    controles.mapas.push(...r.mapeamentos);
    controlesSalvar(); controlesDesenhar();
    controlesMsg(`importados ${r.mapeamentos.length} mapeamento(s)` + (r.erros.length ? `; ${r.erros.length} atribuição(ões) descartada(s): ${r.erros[0]}` : ""));
  }).catch(() => controlesMsg("não consegui ler o arquivo"));
}

function controlesMontar() {
  const raiz = document.createElement("div");
  raiz.className = "ctl-raiz";
  raiz.innerHTML = `<button type="button" class="ctl-abrir" data-ctl-abrir aria-expanded="false">Controles</button>
    <div class="ctl-painel" hidden role="dialog" aria-label="Controles: teclado e MIDI">
      <div class="ctl-topo"><b>Controles</b><span class="ctl-mudo" data-ctl-status></span><button type="button" class="ctl-x" data-ctl-fechar aria-label="Fechar">×</button></div>
      <div data-ctl-corpo></div></div>`;
  document.body.appendChild(raiz);
  controles.el = raiz;
  const painel = raiz.querySelector(".ctl-painel"), abrir = raiz.querySelector("[data-ctl-abrir]");
  const alternar = (v) => { painel.hidden = !v; abrir.setAttribute("aria-expanded", String(v)); if (v) controlesDesenhar(); else controles.aprendendo = null; };
  abrir.addEventListener("click", () => alternar(painel.hidden));
  raiz.querySelector("[data-ctl-fechar]").addEventListener("click", () => alternar(false));
  const r = controlesRascunho;
  raiz.addEventListener("click", (e) => {
    const a = e.target.closest("button, .ctl-arquivo"); if (!a) return;
    if (a.hasAttribute("data-ctl-aprender")) controlesAprender();
    else if (a.hasAttribute("data-ctl-novo-mapa")) { const m = VbMxMapaControle.novoMapeamento("Mapeamento " + (controles.mapas.length + 1)); controles.mapas.push(m); r.mapaId = m.id; controlesSalvar(); controlesDesenhar(); }
    else if (a.hasAttribute("data-ctl-exportar")) controlesExportar();
    else if (a.dataset.ctlEscolher) { r.mapaId = a.dataset.ctlEscolher; controlesDesenhar(); }
    else if (a.dataset.ctlApagarMapa) { controles.mapas = controles.mapas.filter((m) => m.id !== a.dataset.ctlApagarMapa); controlesSalvar(); controlesDesenhar(); }
    else if (a.dataset.ctlApagar) { const m = controlesMapaAtual(); if (m) { m.atribuicoes = m.atribuicoes.filter((x) => x.id !== a.dataset.ctlApagar); controlesSalvar(); controlesDesenhar(); } }
  });
  raiz.addEventListener("change", (e) => {
    const t = e.target, M = VbMxMapaControle;
    if (t.matches("[data-ctl-importar]")) { if (t.files[0]) controlesImportar(t.files[0]); t.value = ""; return; }
    if (t.dataset.ctlAtivo) { const m = controles.mapas.find((x) => x.id === t.dataset.ctlAtivo); if (m) { m.ativo = t.checked; controlesSalvar(); } return; }
    if (t.matches("[data-ctl-cmd]")) { r.comando = t.value; const c = M.comandoPorId(r.comando); r.tipo = c.tipos[0]; r.modo = M.modoPadrao(r.tipo); }
    else if (t.matches("[data-ctl-alvo]")) r.alvo = t.value;
    else if (t.matches("[data-ctl-tipo]")) { r.tipo = t.value; r.modo = M.modoPadrao(r.tipo); }
    else if (t.matches("[data-ctl-modo]")) r.modo = t.value;
    else if (t.dataset.ctlOp) r.opcoes[t.dataset.ctlOp] = t.checked;
    else if (t.dataset.ctlOpSel) r.opcoes[t.dataset.ctlOpSel] = t.dataset.ctlOpSel === "valorFixo" ? Number(t.value) : t.value;
    else if (t.dataset.ctlOpNum) r.opcoes[t.dataset.ctlOpNum] = Math.max(0, Number(t.value) || 0);
    else return;
    controlesDesenhar();
  });
}

VbMxUI.aoIniciar(() => {
  controlesCarregar();
  if (!controles.mapas.length) { controles.mapas = [controlesMapaPadrao()]; controlesSalvar(); }
  controlesMontar();
  midiIniciar();
});
