// ===================== MIXER =====================
// Estado do mixer: por canal, EQ de 3 bandas em dB (−12…+12, 0 = neutro), volume 0…100, trim em dB e o
// botão de filtro (−100 passa-baixa … +100 passa-alta); crossfader −100 (todo A) … +100 (todo B).
// Cada mexida vai para a cadeia de áudio (aplicarMixerAoAudio, js/audio.js → VbMxCadeia.aplicarMixer):
// EQ = BiquadFilter highshelf/peaking/lowshelf (o ATUAL, padrão) ou o isolador de 3 vias (opção, P6),
// kill por banda, filtro, volume × crossfader = GainNode do canal, volume master e limitador.
// Botão CUE por canal (data-cue): o clique é tratado em js/saidas.js (fone/PFL, VB-23).
// Os números vêm de VbMxMixer (motor/mixer.js); aqui só ficam o estado e a tela. Medidores: js/medidores.js.
const EQ_LIM = 12;
VbMxPrefs.declarar("mixer.eq-modo", "atual", { rotulo: "EQ do mixer", tipo: "opcao", modulo: "mixer",
  opcoes: [{ valor: "atual", rotulo: "Atual (shelf/peaking, ±12 dB)" }, { valor: "isolador", rotulo: "Isolador (kill total)" }] });
VbMxPrefs.declarar("mixer.curva", "corte", { rotulo: "Curva do crossfader", tipo: "opcao", modulo: "mixer",
  opcoes: [{ valor: "corte", rotulo: "Corte (a de sempre)" }, { valor: "suave", rotulo: "Suave (potência constante)" }, { valor: "ajustavel", rotulo: "Ajustável (suave a afiada)" }] });
VbMxPrefs.declarar("mixer.afiada", 50, { rotulo: "Afiada da curva ajustável (0 suave … 100 afiada)", tipo: "numero", min: 0, max: 100, modulo: "mixer" });
VbMxPrefs.declarar("mixer.curva-fader", "linear", { rotulo: "Curva do fader de volume", tipo: "opcao", modulo: "mixer",
  opcoes: [{ valor: "linear", rotulo: "Linear" }, { valor: "quadratica", rotulo: "Quadrática" }, { valor: "db", rotulo: "Em dB (−60 dB no fim)" }] });
VbMxPrefs.declarar("mixer.fade-tempo", 2, { rotulo: "Tempo do fade automático do crossfader (s)", tipo: "numero", min: 0.1, max: 30, modulo: "mixer" });
VbMxPrefs.declarar("mixer.xfade-passo", 10, { rotulo: "Passo do crossfader (botões ‹ ›)", tipo: "numero", min: 1, max: 100, modulo: "mixer" });
VbMxPrefs.declarar("mixer.avancado", false, { rotulo: "Painel avançado do mixer (mostra PAN)", tipo: "booleano", modulo: "mixer" });
VbMxPrefs.declarar("mixer.autogain", true, { rotulo: "Auto gain (nivela as faixas antes do fader)", tipo: "booleano", modulo: "mixer" });
VbMxPrefs.declarar("mixer.reverso", false, { rotulo: "Crossfader reverso (hamster)", tipo: "booleano", modulo: "mixer" });
VbMxPrefs.declarar("mixer.limiter", true, { rotulo: "Limitador no master", tipo: "booleano", modulo: "mixer" });
VbMxPrefs.declarar("mixer.fx-canal-lista", VbMxMixer.FX_LISTA_PADRAO, { rotulo: "Efeitos de canal no seletor (4 dos 7, ids separados por vírgula: sopro, picote, rebate, camara, granulado, vaivem, caverna; o filtro sempre aparece)", tipo: "texto", modulo: "mixer" });
const mixer = VbMxMixer.estadoPadrao();
mixer.fxLista = VbMxPrefs.ler("mixer.fx-canal-lista");
mixer.eqModo = VbMxPrefs.ler("mixer.eq-modo");
mixer.curva = VbMxPrefs.ler("mixer.curva");
mixer.reverso = VbMxPrefs.ler("mixer.reverso");
mixer.master.limiter = VbMxPrefs.ler("mixer.limiter");
mixer.afiada = VbMxPrefs.ler("mixer.afiada");
mixer.curvaFader = VbMxPrefs.ler("mixer.curva-fader");
mixer.fadeTempo = VbMxPrefs.ler("mixer.fade-tempo");
mixer.xfadePasso = VbMxPrefs.ler("mixer.xfade-passo");
mixer.avancado = VbMxPrefs.ler("mixer.avancado");
for (const l of ["A","B"]) mixer[l].auto = VbMxPrefs.ler("mixer.autogain");
const BANDAS = [["hi","HI"],["mid","MID"],["low","LOW"]];
// controle global guardado em preferência → [chave, campo do estado]
const MIXER_PREFS = { "eq-modo": ["mixer.eq-modo", "eqModo"], curva: ["mixer.curva", "curva"], reverso: ["mixer.reverso", "reverso"], limiter: ["mixer.limiter", null],
  afiada: ["mixer.afiada", "afiada"], "curva-fader": ["mixer.curva-fader", "curvaFader"], "fade-tempo": ["mixer.fade-tempo", "fadeTempo"],
  "xfade-passo": ["mixer.xfade-passo", "xfadePasso"], "fx-lista": ["mixer.fx-canal-lista", "fxLista"], avancado: ["mixer.avancado", "avancado"], autogain: ["mixer.autogain", null] };
function fmtDb(v){ return (v>0?"+":v<0?"−":"") + Math.abs(v); }
function mixerFmtFiltro(v){
  const f = VbMxMixer.filtroDoBotao(v);
  if (!f.ativo) return "off";
  const hz = f.tipo === "passa-baixa" ? f.lp : f.hp;
  return (f.tipo === "passa-baixa" ? "LP " : "HP ") + (hz >= 1000 ? (hz/1000).toFixed(1) + "k" : Math.round(hz));
}
function mixerFmtPan(v){ return v === 0 ? "C" : (v < 0 ? "E " : "D ") + Math.abs(v); }
function mixerFmt(banda, v){ return banda === "pan" ? mixerFmtPan(v) : banda === "vol" || banda === "fxQtd" ? String(v) : banda === "filtro" ? mixerFmtFiltro(v) : fmtDb(v); }
function faderV(letra, banda, nome, vol){
  const id = `mx-${letra}-${banda}`;
  const rotuloAria = vol ? `Volume do canal ${letra}, de 0 a 100` : `${nome} do canal ${letra}, de −${EQ_LIM} a +${EQ_LIM} dB; para cima aumenta`;
  const [min,max,step] = vol ? [0,100,1] : [-EQ_LIM,EQ_LIM,1];
  const v = mixer[letra][banda];
  const kill = vol ? "" : `<button type="button" class="kill pc-botao pc-botao--kill pc-compacto" data-kill="${banda}" data-canal="${letra}" aria-pressed="false" aria-label="Kill ${nome} do canal ${letra}" title="Kill ${nome} (corta a banda)">K</button>`;
  return `<div class="fader-v${vol?" volume":""}">
    <label class="nome" for="${id}">${nome}</label>
    <input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${v}" data-mx="${letra}" data-banda="${banda}" aria-orientation="vertical" aria-label="${rotuloAria}">
    <span class="val mono" id="${id}-v">${vol ? v : fmtDb(v)}</span>
    ${kill}
  </div>`;
}
function mixerLinha(letra, banda, nome, min, max, step, aria){
  const id = `mx-${letra}-${banda}`;
  return `<div class="linha-mx"><label class="nome" for="${id}">${nome}</label>
    <input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${mixer[letra][banda]}" data-mx="${letra}" data-banda="${banda}" aria-label="${aria}">
    <span class="val mono" id="${id}-v">${mixerFmt(banda, mixer[letra][banda])}</span></div>`;
}
function renderMixer(){
  const div = document.getElementById("mixer");
  const medidores = div.querySelector('[data-slot="mixer-medidores"]');   // js/medidores.js mora aqui dentro; o innerHTML não o leva
  if (medidores) medidores.remove();
  const fone = div.querySelector('[data-slot="mixer-fone"]');   // idem para js/saidas.js (VB-23)
  if (fone) fone.remove();
  if (typeof VbMxPecas !== "undefined") VbMxPecas.destruirEm(div);   // peças vestidas saem antes de reescrever o innerHTML
  div.innerHTML = `
    <div class="canais">
      ${["A","B"].map(l=>`<div class="canal" data-canal="${l}">
        <span class="rotulo">Canal ${l}</span>
        ${mixerLinha(l, "trim", "TRIM", -EQ_LIM, EQ_LIM, 0.5, `Ganho de entrada (trim) do canal ${l}, de −${EQ_LIM} a +${EQ_LIM} dB; duplo clique zera`)}
        <div class="faders">
          ${BANDAS.map(([b,n])=>faderV(l,b,n,false)).join("")}
          ${faderV(l,"vol","VOL",true)}
        </div>
        <div class="linha-mx"><label class="nome" for="mx-${l}-fx">FX</label><select id="mx-${l}-fx" data-fxsel="${l}" aria-label="Efeito do canal ${l}"></select><span></span></div>
        <div class="so-filtro">${mixerLinha(l, "filtro", "FILTRO", -100, 100, 1, `Filtro do canal ${l}: à esquerda passa-baixa, à direita passa-alta; duplo clique zera`)}</div>
        <div class="so-fx">${mixerLinha(l, "fxQtd", "QTD", 0, 100, 1, `Quantidade do efeito do canal ${l}, de 0 (som intacto) a 100; duplo clique zera`)}</div>
        <div class="so-avancado">${mixerLinha(l, "pan", "PAN", -100, 100, 1, `Balanço (pan) do canal ${l}, de −100 (esquerda) a +100 (direita); duplo clique centraliza`)}</div>
        <div class="atribuicao" role="group" aria-label="Lado do crossfader para o canal ${l}">
          ${[["A","A"],["off","–"],["B","B"]].map(([v,r])=>`<button type="button" class="pc-botao pc-botao--sync pc-compacto" data-lado="${v}" data-canal="${l}" aria-pressed="false" aria-label="Canal ${l} no lado ${v === "off" ? "nenhum (fora do crossfader)" : v} do crossfader">${r}</button>`).join("")}
          <button type="button" class="pc-botao pc-botao--cue pc-compacto" data-cue="${l}" aria-pressed="false" aria-label="Cue (fone) do canal ${l}" title="Cue: ouve este canal no fone (antes do fader)">CUE</button>
          <button type="button" class="pc-botao pc-botao--play pc-compacto" data-auto="${l}" aria-pressed="false" aria-label="Auto gain do canal ${l}" title="Auto gain: nivela a faixa antes do fader">AG</button>
        </div>
      </div>`).join("")}
    </div>
    <div class="xfade">
      <input type="range" id="crossfader" min="-100" max="100" step="1" value="${mixer.xfade}" aria-label="Crossfader, de deck A (esquerda) a deck B (direita)">
      <div class="fader-x-rotulos"><span>A</span><span>crossfader</span><span>B</span></div>
      <div class="xfade-botoes">
        <button type="button" class="pc-botao pc-botao--neutro pc-compacto" id="mx-fade-a" aria-label="Fade automático do crossfader para o lado A" title="Fade automático para A">⏮ A</button>
        <button type="button" class="pc-botao pc-botao--neutro pc-compacto" id="mx-passo-a" aria-label="Um passo do crossfader para o lado A">‹</button>
        <button type="button" class="pc-botao pc-botao--neutro pc-compacto" id="mx-passo-b" aria-label="Um passo do crossfader para o lado B">›</button>
        <button type="button" class="pc-botao pc-botao--neutro pc-compacto" id="mx-fade-b" aria-label="Fade automático do crossfader para o lado B" title="Fade automático para B">B ⏭</button>
      </div>
    </div>
    <div class="mixer-opcoes">
      <label>EQ <select id="mx-eq-modo" aria-label="Tipo de EQ"><option value="atual">atual</option><option value="isolador">isolador</option></select></label>
      <label>Curva <select id="mx-curva" aria-label="Curva do crossfader"><option value="corte">corte</option><option value="suave">suave</option><option value="ajustavel">ajustável</option></select></label>
      <label class="so-ajustavel">Afiada <input type="range" id="mx-afiada" min="0" max="100" step="1" value="${mixer.afiada}" aria-label="Afiada da curva do crossfader, de 0 (suave) a 100 (afiada)"></label>
      <label>Fader <select id="mx-curva-fader" aria-label="Curva do fader de volume"><option value="linear">linear</option><option value="quadratica">quadrática</option><option value="db">dB</option></select></label>
      <label>Fade <input type="number" id="mx-fade-tempo" min="0.1" max="30" step="0.1" value="${mixer.fadeTempo}" aria-label="Tempo do fade automático, em segundos"> s</label>
      <label class="check"><input type="checkbox" id="mx-avancado"> avançado</label>
      <label class="check"><input type="checkbox" id="mx-reverso"> reverso</label>
    </div>
    <div class="mixer-master">
      <label class="nome" for="mx-master-vol">MASTER</label>
      <input type="range" id="mx-master-vol" min="0" max="100" step="1" value="${mixer.master.vol}" aria-label="Volume master, de 0 a 100">
      <span class="val mono" id="mx-master-vol-v">${mixer.master.vol}</span>
      <label class="check"><input type="checkbox" id="mx-limiter"> limitador</label>
    </div>`;
  if (medidores) { const b = div.querySelector('.canais > .canal[data-canal="B"]'); b ? b.before(medidores) : div.appendChild(medidores); }   // D3: LEDs entre os canais
  if (fone) div.appendChild(fone);
  div.querySelectorAll("input[data-mx]").forEach(inp=>inp.addEventListener("input", e=>{
    mixerDefinir(inp.dataset.mx, inp.dataset.banda, Number(e.target.value));
  }));
  div.querySelectorAll("select[data-fxsel]").forEach(sel=>sel.addEventListener("change", e=>mixerDefinir(sel.dataset.fxsel, "fx", e.target.value)));
  div.querySelector("#crossfader").addEventListener("input", e=>mixerDefinir(null, "xfade", Number(e.target.value)));
  div.querySelector("#mx-master-vol").addEventListener("input", e=>mixerDefinir(null, "master-vol", Number(e.target.value)));
  div.querySelector("#mx-eq-modo").addEventListener("change", e=>mixerDefinir(null, "eq-modo", e.target.value));
  div.querySelector("#mx-curva").addEventListener("change", e=>mixerDefinir(null, "curva", e.target.value));
  div.querySelector("#mx-afiada").addEventListener("input", e=>mixerDefinir(null, "afiada", Number(e.target.value)));
  div.querySelector("#mx-curva-fader").addEventListener("change", e=>mixerDefinir(null, "curva-fader", e.target.value));
  div.querySelector("#mx-fade-tempo").addEventListener("change", e=>mixerDefinir(null, "fade-tempo", VbMxMixer.travar("fadeTempo", Number(e.target.value))));
  div.querySelector("#mx-avancado").addEventListener("change", e=>mixerDefinir(null, "avancado", e.target.checked));
  div.querySelector("#mx-fade-a").addEventListener("click", ()=>mixerFadeXfade(-100));
  div.querySelector("#mx-fade-b").addEventListener("click", ()=>mixerFadeXfade(100));
  div.querySelector("#mx-passo-a").addEventListener("click", ()=>mixerPassoXfade(-1));
  div.querySelector("#mx-passo-b").addEventListener("click", ()=>mixerPassoXfade(1));
  div.querySelectorAll("button[data-lado]").forEach(bt=>bt.addEventListener("click", ()=>mixerDefinir(bt.dataset.canal, "lado", bt.dataset.lado)));
  div.querySelectorAll("button[data-auto]").forEach(bt=>bt.addEventListener("click", ()=>mixerDefinir(null, "autogain", !mixer[bt.dataset.auto].auto)));
  div.querySelector("#mx-reverso").addEventListener("change", e=>mixerDefinir(null, "reverso", e.target.checked));
  div.querySelector("#mx-limiter").addEventListener("change", e=>mixerDefinir(null, "limiter", e.target.checked));
  div.querySelectorAll("button[data-kill]").forEach(bt=>bt.addEventListener("click", ()=>{
    mixerDefinir(bt.dataset.canal, "kill-" + bt.dataset.kill, !mixer[bt.dataset.canal].kill[bt.dataset.kill]);
  }));
  div.querySelectorAll('input[data-banda]:not([data-banda="vol"])').forEach(inp=>inp.addEventListener("dblclick", ()=>{
    mixerDefinir(inp.dataset.mx, inp.dataset.banda, 0);
  }));
  mixerVestir(div);
  mixerSincronizarTela();
}

// Proposta B (pele por cima, input por baixo): trim/filtro/QTD/pan/master viram knobs, EQ e volume faders verticais, o crossfader um
// fader horizontal. O <input> continua sendo a fonte de verdade (ids, aria-label, foco e teclado são dele); a peça só desenha.
function mixerVestir(div){
  if (typeof VbMxPecas === "undefined") return;
  const v = VbMxPecas.vestir;
  for (const l of ["A","B"]) {
    v(div.querySelector(`#mx-${l}-trim`), { fabrica: "knob", padrao: 0, tamPx: 34 });
    for (const b of ["hi","mid","low"]) v(div.querySelector(`#mx-${l}-${b}`), { fabrica: "fader", tipo: "canal", orientacao: "vertical", tamanho: "compacto", padrao: 0, marcas: 7 });
    v(div.querySelector(`#mx-${l}-vol`), { fabrica: "fader", tipo: "canal", orientacao: "vertical", comprimento: 148, marcas: 11 });
    v(div.querySelector(`#mx-${l}-filtro`), { fabrica: "knob", padrao: 0, tamPx: 34 });
    v(div.querySelector(`#mx-${l}-fxQtd`), { fabrica: "knob", tamPx: 34 });
    v(div.querySelector(`#mx-${l}-pan`), { fabrica: "knob", padrao: 0, tamPx: 34 });
  }
  v(div.querySelector("#crossfader"), { fabrica: "fader", tipo: "cross", orientacao: "horizontal", padrao: 0, marcas: 9, comprimento: 200 });
  v(div.querySelector("#mx-master-vol"), { fabrica: "knob", tamPx: 40 });
}

// Tela ← estado (todos os controles; barato e sem ordem a lembrar).
function mixerSincronizarTela(){
  const div = typeof document !== "undefined" && document.getElementById("mixer");
  if (!div) return;
  const poe = (id, v, texto)=>{
    const el = div.querySelector("#" + id); if (!el) return;
    if (String(el.value) !== String(v)) el.value = v;
    if (el._peca) el._peca.definir(v, { silencioso: true });   // a pele acompanha o estado (ações de teclado/MIDI, fade do crossfader)
    const t = div.querySelector("#" + id + "-v"); if (t) t.textContent = texto;
  };
  for (const l of ["A","B"]) {
    for (const bt of div.querySelectorAll(`button[data-lado][data-canal="${l}"]`)) { const on = mixer[l].lado === bt.dataset.lado; bt.setAttribute("aria-pressed", String(on)); bt.classList.toggle("ligado", on); }
    const ag = div.querySelector(`button[data-auto="${l}"]`);
    if (ag) { ag.setAttribute("aria-pressed", String(mixer[l].auto)); ag.classList.toggle("ligado", mixer[l].auto); ag.title = "Auto gain: " + (mixer[l].auto ? "ligado, aplicando " + fmtDb(Math.round(mixer[l].autoDb * 10) / 10) + " dB" : "desligado"); }
    const sel = div.querySelector(`select[data-fxsel="${l}"]`), disp = VbMxMixer.fxDisponiveis(mixer.fxLista);
    if (sel) {   // seletor: o filtro + os 4 efeitos da preferência; refaz as opções só se a lista mudou
      if (sel.dataset.lista !== disp.join()) { sel.innerHTML = disp.map(id=>`<option value="${id}" title="${VbMxMixer.descricaoDoFx(id)}">${VbMxMixer.nomeDoFx(id)}</option>`).join(""); sel.dataset.lista = disp.join(); }
      sel.value = mixer[l].fx;
    }
    const canalEl = div.querySelector(`.canal[data-canal="${l}"]`); if (canalEl) canalEl.dataset.fx = mixer[l].fx;
    for (const b of ["hi","mid","low","vol","trim","filtro","fxQtd","pan"]) poe(`mx-${l}-${b}`, mixer[l][b], mixerFmt(b, mixer[l][b]));
    for (const b of ["hi","mid","low"]) {
      const bt = div.querySelector(`button[data-kill="${b}"][data-canal="${l}"]`);
      if (bt) { bt.setAttribute("aria-pressed", String(mixer[l].kill[b])); bt.classList.toggle("ligado", mixer[l].kill[b]); }
    }
  }
  poe("crossfader", mixer.xfade, mixer.xfade);
  poe("mx-master-vol", mixer.master.vol, mixer.master.vol);
  poe("mx-afiada", mixer.afiada, mixer.afiada);
  const cf = div.querySelector("#mx-curva-fader"), ft = div.querySelector("#mx-fade-tempo"), av = div.querySelector("#mx-avancado");
  if (cf) cf.value = mixer.curvaFader;
  if (ft && document.activeElement !== ft) ft.value = mixer.fadeTempo;
  if (av) av.checked = mixer.avancado;
  div.classList.toggle("avancado", !!mixer.avancado);
  div.classList.toggle("curva-ajustavel", mixer.curva === "ajustavel");
  const modo = div.querySelector("#mx-eq-modo"), curva = div.querySelector("#mx-curva");
  if (modo) modo.value = mixer.eqModo;
  if (curva) curva.value = mixer.curva;
  const rev = div.querySelector("#mx-reverso"), lim = div.querySelector("#mx-limiter");
  if (rev) rev.checked = mixer.reverso;
  if (lim) lim.checked = mixer.master.limiter;
  div.classList.toggle("eq-isolador", mixer.eqModo === "isolador");
}

// Único caminho que muda o mixer (tela, ações do teclado/MIDI): trava, guarda, atualiza a tela, leva ao
// áudio e avisa. canal "A"|"B" para os controles do canal (hi, mid, low, vol, trim, filtro, kill-hi/-mid/-low);
// null para xfade, master-vol, eq-modo, curva, reverso e limiter (os quatro últimos moram em preferência).
function mixerDefinir(canal, controle, valor){
  if (canal === "A" || canal === "B") {
    const c = mixer[canal], k = /^kill-(hi|mid|low)$/.exec(controle);
    if (k) { c.kill[k[1]] = !!valor; valor = c.kill[k[1]]; }
    else if (controle === "fx") {   // efeito do canal (VB-60): só um dos oferecidos no seletor; a troca vai por rampa na cadeia
      if (!VbMxMixer.fxDisponiveis(mixer.fxLista).includes(valor)) throw new Error(`mixerDefinir: efeito indisponível "${valor}"`);
      c.fx = valor;
    }
    else if (["hi","mid","low","vol","trim","filtro","fxQtd","pan"].includes(controle)) { valor = VbMxMixer.travar(controle, Number(valor)); c[controle] = valor; }
    else if (controle === "lado") { if (!VbMxMixer.LADOS.includes(valor)) throw new Error(`mixerDefinir: lado inválido "${valor}"`); c.lado = valor; }
    else if (controle === "auto") { c.auto = !!valor; valor = c.auto; }
    else throw new Error(`mixerDefinir: controle desconhecido "${controle}" no canal ${canal}`);
  } else if (controle === "xfade") { valor = VbMxMixer.travar("xfade", Number(valor)); mixer.xfade = valor; }
  else if (controle === "master-vol") { valor = VbMxMixer.travar("master-vol", Number(valor)); mixer.master.vol = valor; }
  else if (MIXER_PREFS[controle]) { VbMxPrefs.gravar(MIXER_PREFS[controle][0], valor); return; }   // o ouvinte da preferência termina
  else throw new Error(`mixerDefinir: controle desconhecido "${controle}"`);
  mixerSincronizarTela();
  aplicarMixerAoAudio();
  VbMxUI.emitir("mixer:mudou", { mixer, canal: canal || null, controle, valor });
}
// Preferência mudou (pela tela, ou pela tela de preferências do VB-26): estado, tela, áudio, evento.
for (const [controle, [chave, campo]] of Object.entries(MIXER_PREFS)) {
  VbMxPrefs.ouvir(chave, valor=>{
    if (controle === "autogain") { for (const l of ["A","B"]) mixer[l].auto = !!valor; }
    else if (controle === "fx-lista") { mixer.fxLista = valor; for (const l of ["A","B"]) if (!VbMxMixer.fxDisponiveis(valor).includes(mixer[l].fx)) mixer[l].fx = "filtro"; }
    else if (campo) mixer[campo] = valor; else mixer.master.limiter = valor;
    mixerSincronizarTela();
    aplicarMixerAoAudio();
    VbMxUI.emitir("mixer:mudou", { mixer, canal: null, controle, valor });
  });
}
// Os efeitos de canal sincronizados (picote, rebate, caverna) seguem o BPM do mestre: mudou o mestre, reaplica.
VbMxUI.aoIniciar(()=>VbMxUI.ouvir("mestre:mudou", ()=>aplicarMixerAoAudio()));
// VB-62: mexer no pitch do deck mestre muda o BPM efetivo sem emitir `mestre:mudou`; este seguidor reaplica quando o BPM andou.
VbMxUI.aoIniciar(()=>{ if (typeof VbMxFxCanal !== "undefined") VbMxFxCanal.seguirBpm({ ler: VbMxFxCanal.lerBpm, reaplicar: ()=>aplicarMixerAoAudio(), intervaloMs: 250 }); });
// ---------- auto gain (spec §1): o ajuste vem do nível da faixa carregada (RMS e pico do buffer) ----------
function mixerAtualizarAutoGain(letra){
  const d = decks[letra];
  let db = 0;
  if (d && d.buffer) {
    const canais = []; for (let i = 0; i < d.buffer.numberOfChannels; i++) canais.push(d.buffer.getChannelData(i));
    const n = VbMxMixer.medirNivel(canais, 4);
    db = VbMxMixer.autoGainDb(n.rms, n.pico);
  }
  mixer[letra].autoDb = db;
  mixerSincronizarTela();
  aplicarMixerAoAudio();
}
VbMxUI.ouvir("deck:carregado", e=>mixerAtualizarAutoGain(e.letra));
VbMxUI.ouvir("deck:descarregado", e=>mixerAtualizarAutoGain(e.letra));

// ---------- passo e fade automático do crossfader (VB-41) ----------
let mixerFadeAtual = null;   // {quadro}
function mixerCancelarFade(){ if (mixerFadeAtual) { cancelAnimationFrame(mixerFadeAtual.quadro); mixerFadeAtual = null; } }
function mixerPassoXfade(direcao){ mixerCancelarFade(); mixerDefinir(null, "xfade", VbMxMixer.passoXfade(mixer.xfade, direcao, mixer.xfadePasso)); }
// Leva o crossfader ao alvo (−100 = A, +100 = B) em mixer.fadeTempo segundos, linear; chega exatamente ao alvo.
function mixerFadeXfade(alvo){
  mixerCancelarFade();
  const fade = VbMxMixer.criarFade(mixer.xfade, alvo, mixer.fadeTempo * 1000), t0 = performance.now();
  const passo = ()=>{
    const ms = performance.now() - t0;
    mixerDefinir(null, "xfade", fade.valorEm(ms));
    mixerFadeAtual = fade.fim(ms) ? null : { quadro: requestAnimationFrame(passo) };
  };
  passo();
}
VbMxUI.registrar("acao", "mixer.xfadePassoA", ()=>mixerPassoXfade(-1));
VbMxUI.registrar("acao", "mixer.xfadePassoB", ()=>mixerPassoXfade(1));
VbMxUI.registrar("acao", "mixer.fadeA", ()=>mixerFadeXfade(-100));
VbMxUI.registrar("acao", "mixer.fadeB", ()=>mixerFadeXfade(100));
// Ações nomeadas para teclado e MIDI (VB-25): mixer.xfade(v), mixerA.trim(v), mixerB.filtro(v), mixerA.kill-hi(bool)…
VbMxUI.registrar("acao", "mixer.xfade", v=>{ mixerCancelarFade(); mixerDefinir(null, "xfade", v); });
VbMxUI.registrar("acao", "mixer.master-vol", v=>mixerDefinir(null, "master-vol", v));
for (const l of ["A","B"]) for (const c of ["hi","mid","low","vol","trim","filtro","fx","fxQtd","pan","lado","auto","kill-hi","kill-mid","kill-low"]) {
  VbMxUI.registrar("acao", `mixer${l}.${c}`, v=>mixerDefinir(l, c, v));
}
