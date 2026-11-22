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
  portasVivas: new Map(),// id da porta → {nome, entrada}, só as conectadas (para saber qual sumiu)
  perfis: [],           // perfis de controlador carregados de perfis/*.json (X1 MK3 é o primeiro)
  perfisRecusados: [],  // ids de perfil cujo mapa o Lucas apagou: não voltam sozinhos quando a porta reaparece
  saidas: new Map(),    // id da porta de saída → {nome, saida, enviado:{chave: vel}}, só as que casam um perfil com `saidas`
  ledsTimer: null,      // amostra dos LEDs (saidas.amostraMs), viva só enquanto há porta de saída
  statusMidi: () => tr("pro.midi.nao-iniciado"),   // função: o texto acompanha o idioma
  el: null,
};
const CONTROLES_CHAVE = "vbmx-mapas";
const CONTROLES_PERFIS = ["perfis/x1-mk3.json"];   // relativo ao classico.html; entra na publicação junto de interface/

// ---------------------------------------------------------------- persistência
function controlesSalvar() {
  try { localStorage.setItem(CONTROLES_CHAVE, JSON.stringify({ versao: 1, mapas: controles.mapas, perfisRecusados: controles.perfisRecusados })); } catch (_) {}
}
function controlesCarregar() {
  try {
    const bruto = localStorage.getItem(CONTROLES_CHAVE);
    if (bruto) {
      const o = JSON.parse(bruto);
      if (o && Array.isArray(o.mapas)) {
        controles.mapas = o.mapas.filter((m) => m && Array.isArray(m.atribuicoes));
        controles.perfisRecusados = Array.isArray(o.perfisRecusados) ? o.perfisRecusados.filter((x) => typeof x === "string") : [];
        return;
      }
    }
  } catch (_) {}
  controles.mapas = [];
}
function controlesMapaPadrao() {
  const M = VbMxMapaControle;
  const m = M.novoMapeamento("Teclado");
  for (const [codigo, comando, alvo] of TECLADO_PADRAO.concat(TECLADO_STEMS)) m.atribuicoes.push(M.novaAtribuicao({ fisico: { tipo: "tecla", codigo }, comando, alvo }));
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
  if (cmd.stem) return VbMxMapaControle.valorDoStem(cmd, typeof VbMxStems !== "undefined" ? VbMxStems.estado(alvo, cmd.stem) : null);
  if (cmd.id === "mixer.xfade") return mixer.xfade;
  if (cmd.id === "mixer.master-vol") return mixer.master.vol;
  return mixer[alvo][cmd.nome];
}
const controlesPara01 = (cmd, v) => (v - cmd.faixa[0]) / (cmd.faixa[1] - cmd.faixa[0]);
const controlesDe01 = (cmd, v01) => cmd.faixa[0] + v01 * (cmd.faixa[1] - cmd.faixa[0]);

function controlesAgir(nome, ...args) {
  try { VbMxUI.acao(nome, ...args); } catch (e) { console.warn("controls: action failed", nome, e); }
}

// ---------------------------------------------------------------- despacho
function controlesBotao(a, cmd, valor, m) {
  const M = VbMxMapaControle, o = a.opcoes || {};
  const r = M.processarBotao(controles.estados.get(a.id), a.modo, valor,
    { tipoAcao: cmd.tipoAcao === "valor" ? "gatilho" : cmd.tipoAcao, valorFixo: o.valorFixo, repetir: o.repetir, inverter: o.inverter });
  controles.estados.set(a.id, r.est);
  const nome = M.nomeDaAcao(cmd, a.alvo);
  if (!nome) return;
  // comando com parâmetro do mapa (ex.: pitchPasso da X1): o gatilho leva o valor como argumento
  const pm = cmd.parametro && m && m.parametros ? m.parametros[cmd.parametro] : undefined;
  const args = typeof pm === "number" && Number.isFinite(pm) ? [pm] : [];
  for (const ev of r.eventos) {
    if (ev.op === "disparar") controlesAgir(nome, ...args);
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
    controles.repeticoes.set(a.id, setInterval(() => controlesAgir(nome, ...args), Math.max(40, Number(o.repetirMs) || 150)));
  } else if (!r.repetir && antes) { clearInterval(antes); controles.repeticoes.delete(a.id); }
}
// Camadas do perfil (parametros.camadas, ex. SHIFT da X1 = canal 2/3): o knob que se mexeu numa camada é o mesmo
// controle físico da outra, então a tomada da outra camada recomeça — senão, ao soltar o SHIFT, o volume pularia
// para onde o filtro deixou o knob.
function controlesSoltarCamadas(m, a) {
  const cam = m && m.parametros && m.parametros.camadas;
  if (!cam) return;
  const M = VbMxMapaControle, base = M.chaveBase(a.fisico, cam), k = M.chaveFisico(a.fisico);
  for (const b of m.atribuicoes) {
    if (b === a || b.tipo !== "fader" || M.chaveFisico(b.fisico) === k || M.chaveBase(b.fisico, cam) !== base) continue;
    const est = controles.estados.get(b.id);
    if (est && est.pegou) controles.estados.set(b.id, M.soltarTomada(est));
  }
}
function controlesFader(a, cmd, valor, m) {
  const M = VbMxMapaControle, o = a.opcoes || {};
  controlesSoltarCamadas(m, a);
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
// `porta` (nome da porta MIDI de origem) só vem das mensagens MIDI: mapa de perfil (m.perfil) só vale se a porta casar.
function controlesEntrada(fisico, valor, tMs, porta) {
  if (controles.aprendendo) {
    if (valor > 0 || fisico.tipo === "cc") {           // nota/tecla: o aperto; CC: o primeiro movimento
      const cap = controles.aprendendo; controles.aprendendo = null;
      cap.aoCapturar(fisico);
    }
    return true;
  }
  const achadas = VbMxMapaControle.achar(controles.mapas.filter((m) => controlesMapaVale(m, porta)), fisico);
  for (const { mapeamento: m, atribuicao: a } of achadas) {
    const cmd = VbMxMapaControle.comandoPorId(a.comando);
    if (!cmd) continue;
    if (a.tipo === "botao") controlesBotao(a, cmd, valor, m);
    else if (a.tipo === "fader" && cmd.tipoAcao === "valor") controlesFader(a, cmd, valor, m);
    else if (a.tipo === "encoder") controlesEncoder(a, cmd, valor, tMs || performance.now());
  }
  return achadas.length > 0;
}

// ---------------------------------------------------------------- perfis de controlador (dado, não código)
// perfis/<id>.json = arquivo `vbmx-mapa-controle` v1 + chaves `perfil` (id), `revisao`, `nome`, `porta` (regex do nome da
// porta MIDI), `parametros` (ex.: pitchPasso) e `saidas` (regra dos LEDs, motor/leds.js). Entra em controles.mapas
// na primeira vez que a porta aparece, com `perfil`/`porta`/`revisao` no mapa: dali em diante é um mapeamento como outro
// qualquer (remapeável, exportável). Só recebe mensagens da porta que casa. Revisão nova do arquivo substitui a cópia local.
function controlesPortaCasa(porta, nome) {
  try { return !!nome && new RegExp(porta, "i").test(nome); } catch (_) { return false; }
}
function controlesMapaVale(m, porta) { return !m.perfil || controlesPortaCasa(m.porta, porta); }
function controlesCarregarPerfis() {
  if (typeof fetch !== "function") return Promise.resolve();
  return Promise.all(CONTROLES_PERFIS.map((arq) => fetch(arq).then((r) => { if (!r.ok) throw new Error(r.status); return r.text(); }).then((texto) => {
    const o = JSON.parse(texto);
    if (!o || typeof o.perfil !== "string" || typeof o.porta !== "string" || !VbMxMapaControle.importar(texto).ok) throw new Error("invalid profile");
    controles.perfis.push({ id: o.perfil, nome: o.nome || o.perfil, porta: o.porta, revisao: Number(o.revisao) || 1,
      parametros: o.parametros || {}, saidas: o.saidas || null, texto });
  }).catch((e) => console.warn("controls: profile not loaded", arq, e)))).then(() => undefined);
}
const controlesChaveAtrib = (a) => VbMxMapaControle.chaveFisico(a.fisico) + "|" + a.comando + "|" + (a.alvo || "");
// Revisão nova do arquivo sobre a cópia local: o que o Lucas fez na cópia vale por cima do arquivo.
//  · atribuição local (aprendida no painel, não veio do perfil) fica, e tira do arquivo a linha do mesmo controle físico;
//  · linha do perfil que ele apagou continua apagada; ligado/desligado (ativo) se mantém.
// `origem` = as linhas que vieram do arquivo na última importação. Cópia antiga sem `origem`: conta como do perfil o que
// também está no arquivo novo (não dá para saber o que foi apagado; volta tudo do arquivo).
function controlesMesclarRevisao(atual, doArquivo) {
  const M = VbMxMapaControle, chave = controlesChaveAtrib;
  const tem = new Set(atual.atribuicoes.map(chave)), novas = new Set(doArquivo.map(chave));
  const origem = new Set(Array.isArray(atual.origem) ? atual.origem : [...tem].filter((k) => novas.has(k)));
  const locais = atual.atribuicoes.filter((a) => !origem.has(chave(a)));
  const apagadas = new Set([...origem].filter((k) => !tem.has(k)));
  const ocupados = new Set(locais.map((a) => M.chaveFisico(a.fisico)));
  return doArquivo.filter((a) => !apagadas.has(chave(a)) && !ocupados.has(M.chaveFisico(a.fisico))).concat(locais);
}
function controlesGarantirPerfil(p) {
  if (controles.perfisRecusados.includes(p.id)) return;
  const atual = controles.mapas.find((m) => m.perfil === p.id);
  if (atual && (atual.revisao || 0) >= p.revisao) return;
  const r = VbMxMapaControle.importar(p.texto);
  if (!r.ok || !r.mapeamentos.length) return;
  const mapa = r.mapeamentos[0], origem = mapa.atribuicoes.map(controlesChaveAtrib);
  if (atual) { mapa.atribuicoes = controlesMesclarRevisao(atual, mapa.atribuicoes); mapa.ativo = atual.ativo !== false; }
  Object.assign(mapa, { nome: p.nome, perfil: p.id, porta: p.porta, revisao: p.revisao, parametros: p.parametros || {}, saidas: p.saidas || null, origem });
  controles.mapas = controles.mapas.filter((m) => m !== atual).concat(mapa);
  controlesSalvar(); controlesDesenhar();
}
// Apagar o mapa de um perfil o recusa (não volta quando a porta reaparece); "religar" no painel desfaz.
function controlesApagarMapa(id) {
  const m = controles.mapas.find((x) => x.id === id);
  if (m && m.perfil && !controles.perfisRecusados.includes(m.perfil)) controles.perfisRecusados.push(m.perfil);
  controles.mapas = controles.mapas.filter((x) => x.id !== id);
  controlesSalvar(); controlesDesenhar();
}
function controlesReligarPerfil(id) {
  controles.perfisRecusados = controles.perfisRecusados.filter((x) => x !== id);
  const p = controles.perfis.find((x) => x.id === id);
  if (p) controlesGarantirPerfil(p); else controlesSalvar();
  controlesDesenhar();
}
// Porta sumiu: solta o que ela deixou preso (botão apertado, repetição, tomada do soft takeover, encoder).
// Botão apertado recebe o "soltar" (cue em prévia, bend…); só mexe em mapa de perfil dessa porta ou em mapa geral.
function controlesSoltarPorta(nome) {
  const M = VbMxMapaControle;
  for (const m of controles.mapas) {
    if (m.perfil && !controlesPortaCasa(m.porta, nome)) continue;
    for (const a of m.atribuicoes) {
      if (a.fisico.tipo === "tecla") continue;
      const est = controles.estados.get(a.id), cmd = M.comandoPorId(a.comando);
      if (a.tipo === "botao" && est && est.premido && cmd) controlesBotao(a, cmd, 0);
      const t = controles.repeticoes.get(a.id);
      if (t) { clearInterval(t); controles.repeticoes.delete(a.id); }
      if (a.tipo === "fader" && est) controles.estados.set(a.id, M.soltarTomada(est));
      else if (a.tipo === "encoder") controles.estados.delete(a.id);
    }
  }
}

// ---------------------------------------------------------------- Web MIDI
function midiAoMensagem(ev, porta) {
  const m = VbMxMapaControle.interpretarMidi(ev.data);
  if (m) controlesEntrada(m.fisico, m.valor, ev.timeStamp, porta);
}
// ---------------------------------------------------------------- LEDs (X1-LEDS): estado da página → só a diferença
// A regra é dado (`saidas` do mapa do perfil, motor/leds.js); aqui só se lê o estado e se mandam os bytes. Amostra a
// saidas.amostraMs (10 Hz) e nos eventos de deck, para o que não tem evento (sync, loop). Porta nova ou religada
// começa com `enviado` vazio = tudo de novo, apagados inclusive.
function controlesLeitura() {
  const r = {}, st = typeof VbMxStems !== "undefined" ? VbMxStems : null;
  for (const l of ["A", "B"]) {
    const d = (typeof decks !== "undefined" && decks[l]) || {};
    const reg = typeof hotcues !== "undefined" && hotcues.reg[l] && hotcues.faixa[l] === d.faixa ? hotcues.reg[l] : null;   // como loops.js/ondas.js
    const lp = typeof loopsDeck === "function" ? loopsDeck(l) : null;
    const leitura = { tocando: typeof tocandoDeck === "function" ? !!tocandoDeck(l) : false, sync: !!d.sync, loopAtivo: !!(lp && lp.ativo),
      hotcues: reg && Array.isArray(reg.hotcues) ? reg.hotcues.map((h) => !!h) : [], stemsLigados: !!(st && st.ativo(l)), stems: {} };
    if (st && leitura.stemsLigados) for (const nm of st.NOMES || []) { const e = st.estado(l, nm); if (e) leitura.stems[nm] = { mudo: !!e.mudo, solo: !!e.solo }; }
    r[l] = leitura;
  }
  return r;
}
// {chave: vel} de todos os mapas de perfil ATIVOS com `saidas` cuja porta casa este nome (o primeiro a endereçar ganha).
function controlesLedsDaPorta(nome, leitura) {
  const L = VbMxLeds, atual = {};
  for (const m of controles.mapas) {
    if (!m.perfil || !m.ativo || !controlesPortaCasa(m.porta, nome)) continue;
    const p = controles.perfis.find((x) => x.id === m.perfil);
    const saidas = m.saidas || (p && p.saidas);
    if (!saidas) continue;
    const est = L.estadoDosLeds(leitura, L.enderecosDosLeds(saidas, m.atribuicoes, (m.parametros || {}).camadas).lista, saidas.brilho);
    for (const k of Object.keys(est)) if (!(k in atual)) atual[k] = est[k];
  }
  return atual;
}
function controlesLedsAtualizar() {
  if (!controles.saidas.size || typeof VbMxLeds === "undefined") return;
  const leitura = controlesLeitura();
  for (const s of controles.saidas.values()) {
    const atual = controlesLedsDaPorta(s.nome, leitura);
    for (const [k, v] of VbMxLeds.diferencaDosLeds(s.enviado, atual)) {
      const bytes = VbMxLeds.mensagemDoLed(k, v);
      if (bytes) try { s.saida.send(bytes); } catch (e) { console.warn("controls: LED not sent", s.nome, e); }
    }
    s.enviado = Object.assign({}, atual);
  }
}
function controlesLedsAmostraMs() {
  for (const p of controles.perfis) if (p.saidas && Number(p.saidas.amostraMs) > 0) return Number(p.saidas.amostraMs);
  return 100;
}
// Portas de saída que casam um perfil com `saidas`: as que já estavam guardam o `enviado`; nova ou religada recomeça.
function midiLigarSaidas(acesso) {
  const vivas = new Map();
  if (acesso.outputs) for (const saida of acesso.outputs.values()) {
    if (saida.state === "disconnected") continue;
    const nome = saida.name || saida.id, id = saida.id || nome;
    if (!controles.perfis.some((p) => p.saidas && controlesPortaCasa(p.porta, nome))) continue;
    const antes = controles.saidas.get(id);
    vivas.set(id, { nome, saida, enviado: antes && antes.saida === saida ? antes.enviado : {} });
  }
  controles.saidas = vivas;
  if (vivas.size && !controles.ledsTimer) controles.ledsTimer = setInterval(controlesLedsAtualizar, controlesLedsAmostraMs());
  else if (!vivas.size && controles.ledsTimer) { clearInterval(controles.ledsTimer); controles.ledsTimer = null; }
  controlesLedsAtualizar();
}
for (const ev of ["deck:tocou", "deck:pausou", "deck:carregado", "deck:descarregado", "deck:fim", "deck:cue"]) VbMxUI.ouvir(ev, () => controlesLedsAtualizar());

function midiLigarPortas(acesso) {
  const vivas = new Map();
  for (const entrada of acesso.inputs.values()) {
    if (entrada.state === "disconnected") { entrada.onmidimessage = null; continue; }   // o Chrome pode manter a porta na lista
    const nome = entrada.name || entrada.id;
    entrada.onmidimessage = (ev) => midiAoMensagem(ev, nome);
    vivas.set(entrada.id || nome, { nome, entrada });
  }
  for (const [id, p] of controles.portasVivas) if (!vivas.has(id)) { p.entrada.onmidimessage = null; controlesSoltarPorta(p.nome); }
  controles.portasVivas = vivas;
  const nomes = [...vivas.values()].map((p) => p.nome), ligados = [];
  for (const p of controles.perfis) if (nomes.some((n) => controlesPortaCasa(p.porta, n))) { controlesGarantirPerfil(p); ligados.push(p.nome); }
  controles.entradas = nomes;
  midiLigarSaidas(acesso);   // depois do perfil garantido: o mapa (e as `saidas` dele) já existe
  controles.statusMidi = () => nomes.length ? `MIDI: ${nomes.join(", ")}${ligados.length ? " — " + tr("pro.midi.perfil") + ": " + ligados.join(", ") : ""}` : tr("pro.midi.nenhum");
  controlesPintarStatus();
}
function midiIniciar() {
  if (!navigator.requestMIDIAccess) { controles.statusMidi = () => tr("pro.midi.sem-web"); return Promise.resolve(); }
  return controlesCarregarPerfis().then(() => navigator.requestMIDIAccess({ sysex: false })).then((acesso) => {
    midiLigarPortas(acesso);
    acesso.onstatechange = () => midiLigarPortas(acesso);
  }).catch((e) => { const nomeErro = (e && e.name) || "erro"; controles.statusMidi = () => tr("pro.midi.negado", { e: nomeErro }); controlesPintarStatus(); });
}

// ---------------------------------------------------------------- painel Controles (MIDI learn)
const controlesEsc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function controlesNomeFisico(f) {
  if (f.tipo === "tecla") return tr("pro.midi.tecla") + " " + f.codigo.replace(/^Key|^Digit/, "");
  return (f.tipo === "nota" ? tr("pro.midi.nota") + " " : "CC ") + f.numero + " (" + tr("pro.midi.canal") + " " + ((f.canal | 0) + 1) + ")";
}
function controlesPintarStatus() {
  const s = controles.el && controles.el.querySelector("[data-ctl-status]");
  if (s) s.textContent = controles.statusMidi();
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
  const optsCmd = (lista) => lista.map((c) => `<option value="${c.id}"${c.id === r.comando ? " selected" : ""}>${controlesEsc(trm(c.rotulo))}</option>`).join("");
  const modos = r.tipo === "botao" ? M.MODOS_BOTAO : r.tipo === "fader" ? M.MODOS_FADER : [];
  const rotModo = { hold: tr("pro.midi.modo-hold"), toggle: "toggle", invert: tr("pro.midi.modo-invert"), direct: tr("pro.midi.modo-direct"), relative: "relative" };
  const o = r.opcoes;
  const caixa = (k, rot) => `<label class="ctl-check"><input type="checkbox" data-ctl-op="${k}"${o[k] ? " checked" : ""}> ${rot}</label>`;
  const mapasHtml = controles.mapas.map((m) => `<div class="ctl-mapa${m.id === r.mapaId ? " atual" : ""}">
      <label class="ctl-check"><input type="checkbox" data-ctl-ativo="${m.id}"${m.ativo ? " checked" : ""}> ${tr("pro.midi.ativo")}</label>
      <button type="button" class="ctl-link" data-ctl-escolher="${m.id}">${controlesEsc(m.nome)}</button>
      <span class="ctl-mudo">${tr("pro.midi.atrib", { n: m.atribuicoes.length })}</span>
      <button type="button" class="ctl-x" data-ctl-apagar-mapa="${m.id}" title="${m.perfil ? tr("pro.midi.apagar-perfil") : tr("pro.midi.apagar-mapa")}" aria-label="${tr("pro.midi.apagar-mapa-aria", { nome: controlesEsc(m.nome) })}">×</button></div>`).join("")
    + controles.perfis.filter((p) => controles.perfisRecusados.includes(p.id)).map((p) => `<div class="ctl-mapa"><span class="ctl-mudo">${tr("pro.midi.perfil-apagado", { nome: controlesEsc(p.nome) })}</span>
      <button type="button" class="ctl-link" data-ctl-religar-perfil="${controlesEsc(p.id)}">${tr("pro.midi.religar")}</button></div>`).join("");
  const linhas = mapa ? mapa.atribuicoes.map((a) => {
    const c = M.comandoPorId(a.comando);
    return `<tr><td>${controlesEsc(controlesNomeFisico(a.fisico))}</td><td>${controlesEsc(c ? trm(c.rotulo) : a.comando)}</td><td>${a.alvo || tr("pro.midi.global")}</td>
      <td>${a.tipo}${a.tipo === "encoder" ? "" : " · " + a.modo}</td>
      <td><button type="button" class="ctl-x" data-ctl-apagar="${a.id}" aria-label="${tr("pro.midi.apagar-atrib")}">×</button></td></tr>`;
  }).join("") : "";
  el.querySelector("[data-ctl-corpo]").innerHTML = `
    <div class="ctl-secao"><b>${tr("pro.midi.mapeamentos")}</b> <span class="ctl-mudo">${tr("pro.midi.todos-ativos")}</span>${mapasHtml || `<div class="ctl-mudo">${tr("pro.midi.nenhum-mapa")}</div>`}
      <div class="ctl-linha"><button type="button" data-ctl-novo-mapa>${tr("pro.midi.novo")}</button><button type="button" data-ctl-exportar>${tr("pro.midi.exportar")}</button>
      <label class="ctl-arquivo">${tr("pro.midi.importar")}<input type="file" accept="application/json,.json" data-ctl-importar hidden></label></div></div>
    <div class="ctl-secao"><b>${tr("pro.midi.nova-atrib")}</b> ${mapa ? tr("pro.midi.em", { nome: controlesEsc(mapa.nome) }) : ""}
      <div class="ctl-grade">
        <label>${tr("pro.midi.comando")} <select data-ctl-cmd><optgroup label="Deck">${optsCmd(grupos.deck)}</optgroup><optgroup label="${tr("pro.midi.canal-mixer")}">${optsCmd(grupos.canal)}</optgroup><optgroup label="${tr("pro.midi.global")}">${optsCmd(grupos.global)}</optgroup></select></label>
        <label>${tr("pro.midi.alvo")} <select data-ctl-alvo${cmd && cmd.alvo === "global" ? " disabled" : ""}><option value="A"${r.alvo === "A" ? " selected" : ""}>${tr("pro.midi.deck-canal")} A</option><option value="B"${r.alvo === "B" ? " selected" : ""}>${tr("pro.midi.deck-canal")} B</option></select></label>
        <label>${tr("pro.midi.tipo")} <select data-ctl-tipo>${(cmd ? cmd.tipos : ["botao"]).map((t) => `<option value="${t}"${t === r.tipo ? " selected" : ""}>${t}</option>`).join("")}</select></label>
        ${modos.length ? `<label>${tr("pro.midi.modo")} <select data-ctl-modo>${modos.map((m) => `<option value="${m}"${m === r.modo ? " selected" : ""}>${rotModo[m]}</option>`).join("")}</select></label>` : ""}
      </div>
      <div class="ctl-grade">
        ${caixa("inverter", tr("pro.midi.inverter"))}
        ${r.tipo === "botao" ? caixa("repetir", tr("pro.midi.repetir")) : ""}
        ${r.tipo === "botao" && r.modo === "direct" ? `<label>${tr("pro.midi.valor")} <select data-ctl-op-sel="valorFixo"><option value="1"${o.valorFixo ? " selected" : ""}>1</option><option value="0"${!o.valorFixo ? " selected" : ""}>0</option></select></label>` : ""}
        ${r.tipo !== "botao" ? `<label>${tr("pro.midi.resolucao")} <select data-ctl-op-sel="resolucao"><option value="fina"${o.resolucao === "fina" ? " selected" : ""}>${tr("pro.midi.fina")}</option><option value="grossa"${o.resolucao === "grossa" ? " selected" : ""}>${tr("pro.midi.grossa")}</option></select></label>` : ""}
        ${r.tipo === "fader" && r.modo === "direct" ? caixa("softTakeover", tr("pro.midi.soft")) : ""}
        ${r.tipo !== "botao" ? `<label>${tr("pro.midi.sensibilidade")} <input type="number" step="0.1" min="0.1" max="10" value="${o.sensibilidade}" data-ctl-op-num="sensibilidade"></label>` : ""}
        ${r.tipo === "encoder" ? `<label>${tr("pro.midi.aceleracao")} <input type="number" step="0.1" min="0" max="1" value="${o.aceleracao}" data-ctl-op-num="aceleracao"></label>
          <label>${tr("pro.midi.codificacao")} <select data-ctl-op-sel="codificacao"><option value="7f01"${o.codificacao === "7f01" ? " selected" : ""}>7Fh / 01h</option><option value="3f41"${o.codificacao === "3f41" ? " selected" : ""}>3Fh / 41h</option></select></label>` : ""}
      </div>
      <div class="ctl-linha"><button type="button" class="ctl-aprender${controles.aprendendo ? " ligado" : ""}" data-ctl-aprender${mapa ? "" : " disabled"}>${controles.aprendendo ? tr("pro.midi.mexa") : tr("pro.midi.aprender")}</button>
        <span class="ctl-mudo" data-ctl-msg></span></div></div>
    <div class="ctl-secao"><b>${tr("pro.midi.atribuicoes")}</b>${linhas ? `<div class="ctl-tabela"><table><thead><tr><th>${tr("pro.midi.th-controle")}</th><th>${tr("pro.midi.comando")}</th><th>${tr("pro.midi.alvo")}</th><th>${tr("pro.midi.tipo")} · ${tr("pro.midi.modo").toLowerCase()}</th><th></th></tr></thead><tbody>${linhas}</tbody></table></div>` : `<div class="ctl-mudo">${tr("pro.midi.nenhuma")}</div>`}</div>`;
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
    controlesMsg(tr("pro.midi.aprendido", { f: controlesNomeFisico(fisico) }));
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
    controlesMsg(tr("pro.midi.importados", { n: r.mapeamentos.length }) + (r.erros.length ? "; " + tr("pro.midi.descartadas", { n: r.erros.length, e: r.erros[0] }) : ""));
  }).catch(() => controlesMsg(tr("pro.midi.erro-ler")));
}

function controlesMontar() {
  const raiz = document.createElement("div");
  raiz.className = "ctl-raiz";
  raiz.innerHTML = `<button type="button" class="ctl-abrir" data-ctl-abrir aria-expanded="false">${tr("pro.midi.controles")}</button>
    <div class="ctl-painel" hidden role="dialog" aria-label="${tr("pro.midi.painel-aria")}">
      <div class="ctl-topo"><b data-ctl-titulo>${tr("pro.midi.controles")}</b><span class="ctl-mudo" data-ctl-status></span><button type="button" class="ctl-x" data-ctl-fechar aria-label="${tr("pro.midi.fechar")}">×</button></div>
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
    else if (a.hasAttribute("data-ctl-novo-mapa")) { const m = VbMxMapaControle.novoMapeamento(tr("pro.midi.mapeamento") + " " + (controles.mapas.length + 1)); controles.mapas.push(m); r.mapaId = m.id; controlesSalvar(); controlesDesenhar(); }
    else if (a.hasAttribute("data-ctl-exportar")) controlesExportar();
    else if (a.dataset.ctlEscolher) { r.mapaId = a.dataset.ctlEscolher; controlesDesenhar(); }
    else if (a.dataset.ctlApagarMapa) controlesApagarMapa(a.dataset.ctlApagarMapa);
    else if (a.dataset.ctlReligarPerfil) controlesReligarPerfil(a.dataset.ctlReligarPerfil);
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
  VbMxUI.aoIdioma(() => {
    if (!controles.el) return;
    controles.el.querySelector("[data-ctl-abrir]").textContent = tr("pro.midi.controles");
    controles.el.querySelector("[data-ctl-titulo]").textContent = tr("pro.midi.controles");
    controles.el.querySelector(".ctl-painel").setAttribute("aria-label", tr("pro.midi.painel-aria"));
    controles.el.querySelector("[data-ctl-fechar]").setAttribute("aria-label", tr("pro.midi.fechar"));
    if (!controles.el.querySelector(".ctl-painel").hidden) controlesDesenhar(); else controlesPintarStatus();
  });
});
