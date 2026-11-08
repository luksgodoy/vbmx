// ===================== pecas-controle.js — peças de controle de equipamento de DJ (proposta B, aprovada em 2026-11-07) =====================
// Biblioteca VbMxPecas: criarKnob / criarFader / criarBotao / criarHotCue / criarDisplay / criarJog + vestir() (pele por cima de um
// <input type=range>) e destruirEm(). Dono do visual: css/pecas-controle.css. NÃO mexe no DOM no carregamento. O JOG não é usado na
// oficial (decisão do Lucas: o prato atual permanece); a peça fica na biblioteca, testada só na galeria interface/propostas/ui-b-pecas.html.
// (testar-pecas.js ainda não existe: criar ou remover esta linha.)
const VbMxPecas = (() => {
  // ---------- utilidades ----------
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const NS = "http://www.w3.org/2000/svg";
  const svgEl = (tag, attrs = {}) => { const e = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };
  const polar = (cx, cy, r, ang) => { const a = (ang - 90) * Math.PI / 180; return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; };
  // arco de a0 a a1 (graus; 0 = topo, horário), string de path
  function arco(cx, cy, r, a0, a1) {
    if (Math.abs(a1 - a0) < 0.05) return "";
    const [x0, y0] = polar(cx, cy, r, a0), [x1, y1] = polar(cx, cy, r, a1);
    return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${Math.abs(a1 - a0) > 180 ? 1 : 0} ${a1 > a0 ? 1 : 0} ${x1.toFixed(2)} ${y1.toFixed(2)}`;
  }
  const fmtPadrao = v => String(Math.round(v * 10) / 10).replace(".", ",");
  const reduzMovimento = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---------- NÚCLEO: comportamento de valor compartilhado por knob e fader ----------
  // o = { el, alvoPonteiro?, min, max, passo, valor, padrao, formato, aoMudar, pintar,
  //       modo: "relativo" (knob: arrasta no eixo Y, px → faixa) | "absoluto" (fader: posição no trilho),
  //       eixo: "y"|"x", pixels (relativo: quantos px = faixa inteira), posicaoDe(e) (absoluto: 0..1 do ponteiro) }
  function ligarDeslizante(o) {
    const el = o.el, passo = o.passo || 1, faixa = o.max - o.min, tec = o.teclado !== false;   // teclado:false = pele de um <input> (vestir): foco, role e aria ficam no input
    let valor = travar(o.valor), desab = false;
    function travar(v) { v = Math.min(o.max, Math.max(o.min, Number(v) || 0)); v = Math.round(v / passo) * passo; return +v.toFixed(6); }
    function definir(v, op = {}) {
      const n = travar(v); const mudou = n !== valor; valor = n;
      if (tec) { el.setAttribute("aria-valuenow", String(n)); el.setAttribute("aria-valuetext", o.formato(n)); }
      o.pintar(n);
      if (mudou && !op.silencioso && o.aoMudar) o.aoMudar(n);
      return n;
    }
    if (tec) {
      el.setAttribute("role", "slider"); el.setAttribute("tabindex", "0");
      el.setAttribute("aria-valuemin", String(o.min)); el.setAttribute("aria-valuemax", String(o.max));
      if (o.eixo === "y") el.setAttribute("aria-orientation", "vertical");
      if (o.rotuloAria) el.setAttribute("aria-label", o.rotuloAria);
    }
    // ponteiro (mouse, toque, caneta) com captura
    const alvo = o.alvoPonteiro || el;
    alvo.addEventListener("pointerdown", e => {
      if (desab || e.button === 2) return;
      e.preventDefault(); alvo.setPointerCapture(e.pointerId); el.classList.add("pc-arrastando"); if (tec) el.focus({ preventScroll: true });
      const v0 = valor, x0 = e.clientX, y0 = e.clientY;
      let deslocamento = 0;
      if (o.modo === "absoluto") {
        const pos = o.posicaoDe(e), vPonteiro = o.min + pos * faixa;
        if (o.naCabeca && o.naCabeca(e)) deslocamento = vPonteiro - valor;   // pegou a cabeça: arrasta sem pulo
        else definir(vPonteiro);                                             // clicou no trilho: salta
      }
      const mover = e2 => {
        if (o.modo === "absoluto") { definir(o.min + o.posicaoDe(e2) * faixa - deslocamento); return; }
        const d = o.eixo === "x" ? (e2.clientX - x0) : -(e2.clientY - y0);
        definir(v0 + d / (o.pixels || 160) * faixa * (e2.shiftKey ? 0.2 : 1));
      };
      const soltar = () => { alvo.removeEventListener("pointermove", mover); alvo.removeEventListener("pointerup", soltar); alvo.removeEventListener("pointercancel", soltar); el.classList.remove("pc-arrastando"); };
      alvo.addEventListener("pointermove", mover); alvo.addEventListener("pointerup", soltar); alvo.addEventListener("pointercancel", soltar);
    });
    // roda do mouse: um passo por "clique" (Shift = 5 passos)
    el.addEventListener("wheel", e => { if (desab) return; e.preventDefault(); const s = Math.sign(e.deltaY || e.deltaX) * -1; definir(valor + s * passo * (e.shiftKey ? 5 : 1)); }, { passive: false });
    // duplo clique: volta ao padrão (zero do EQ, centro do crossfader/pitch)
    el.addEventListener("dblclick", e => { if (desab || o.padrao === undefined) return; e.preventDefault(); definir(o.padrao); });
    // teclado (WAI-ARIA slider)
    if (tec) el.addEventListener("keydown", e => {
      if (desab) return;
      const grande = passo * Math.max(1, Math.round(faixa / passo / 10));
      const mapa = { ArrowUp: passo, ArrowRight: passo, ArrowDown: -passo, ArrowLeft: -passo, PageUp: grande, PageDown: -grande };
      if (e.key in mapa) { e.preventDefault(); definir(valor + mapa[e.key]); }
      else if (e.key === "Home") { e.preventDefault(); definir(o.min); }
      else if (e.key === "End") { e.preventDefault(); definir(o.max); }
      else if ((e.key === "0" || e.key === "Backspace") && o.padrao !== undefined) { e.preventDefault(); definir(o.padrao); }
    });
    definir(valor, { silencioso: true });
    return {
      el, valor: () => valor, definir,
      desabilitar(sim) { desab = !!sim; el.setAttribute("aria-disabled", String(desab)); if (tec) el.tabIndex = desab ? -1 : 0; },
      destruir() { el.remove(); }
    };
  }

  // ---------- KNOB ----------
  // opcoes: { rotulo, rotuloAria, min, max, passo, valor, padrao, bipolar, formato, tamanho: "normal"|"compacto", aoMudar, sufixo }
  const KNOB_A0 = -135, KNOB_A1 = 135;   // varredura de 270°
  function criarKnob(op = {}) {
    const min = op.min ?? 0, max = op.max ?? 100, bipolar = !!op.bipolar;
    const el = document.createElement("div");
    el.className = "pc-knob" + (op.tamanho === "compacto" ? " pc-compacto" : "");
    const r = 44;
    el.innerHTML = `<div class="pc-knob-caixa"><div class="pc-knob-anel"></div><div class="pc-knob-borracha"></div>
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <line class="pc-knob-tique" x1="${polar(50,50,49,KNOB_A0)[0].toFixed(1)}" y1="${polar(50,50,49,KNOB_A0)[1].toFixed(1)}" x2="${polar(50,50,52,KNOB_A0)[0].toFixed(1)}" y2="${polar(50,50,52,KNOB_A0)[1].toFixed(1)}"/>
        <line class="pc-knob-tique" x1="${polar(50,50,49,KNOB_A1)[0].toFixed(1)}" y1="${polar(50,50,49,KNOB_A1)[1].toFixed(1)}" x2="${polar(50,50,52,KNOB_A1)[0].toFixed(1)}" y2="${polar(50,50,52,KNOB_A1)[1].toFixed(1)}"/>
        ${bipolar ? `<line class="pc-knob-tique pc-centro" x1="50" y1="-1" x2="50" y2="3"/>` : ""}
        <path class="pc-arco-trilho" d="${arco(50, 50, r, KNOB_A0, KNOB_A1)}"/>
        <path class="pc-arco-valor" d=""/>
        <g class="pc-knob-giro"><rect class="pc-knob-marcador" x="48.6" y="25.5" width="2.8" height="11" rx="1.4"/></g>
      </svg></div>
      <span class="pc-nome">${esc(op.rotulo || "")}</span><span class="pc-val"></span>`;
    const arcoValor = el.querySelector(".pc-arco-valor"), giro = el.querySelector(".pc-knob-giro"), val = el.querySelector(".pc-val");
    const formato = op.formato || (v => fmtPadrao(v) + (op.sufixo || ""));
    const pintar = v => {
      const ang = KNOB_A0 + (v - min) / (max - min) * (KNOB_A1 - KNOB_A0);
      giro.setAttribute("transform", `rotate(${ang.toFixed(2)} 50 50)`);
      arcoValor.setAttribute("d", bipolar ? arco(50, 50, r, 0, ang) : arco(50, 50, r, KNOB_A0, ang));
      val.textContent = formato(v);
    };
    return ligarDeslizante({ el, min, max, passo: op.passo ?? 1, valor: op.valor ?? (bipolar ? (min + max) / 2 : min),
      padrao: op.padrao ?? (bipolar ? (min + max) / 2 : undefined), formato, aoMudar: op.aoMudar, pintar,
      modo: "relativo", eixo: "y", pixels: op.tamanho === "compacto" ? 120 : 160, rotuloAria: op.rotuloAria || op.rotulo, teclado: op.teclado });
  }

  // ---------- FADER ----------
  // opcoes: { rotulo, rotuloAria, min, max, passo, valor, padrao, formato, orientacao: "vertical"|"horizontal",
  //           tipo: "canal"|"cross"|"pitch", comprimento (px), tamanho, marcas (n de tiques), rotulos: [esq/baixo, dir/cima], aoMudar }
  function criarFader(op = {}) {
    const min = op.min ?? 0, max = op.max ?? 100, horiz = op.orientacao === "horizontal", tipo = op.tipo || "canal";
    const el = document.createElement("div");
    el.className = `pc-fader ${horiz ? "pc-horiz" : "pc-vert"} pc-${tipo}` + (op.tamanho === "compacto" ? " pc-compacto" : "");
    if (op.comprimento) el.style.setProperty("--comp", op.comprimento + "px");
    const n = op.marcas ?? 11, ticks = [];
    for (let i = 0; i < n; i++) {
      const t = 6 + (i / (n - 1)) * 88, centro = (tipo === "pitch" || tipo === "cross") && i === (n - 1) / 2;
      const comp = i % 2 ? 9 : 15, cls = centro ? "pc-centro" : "";   // comprimento do tique em % da largura da caixa (SVG não aceita calc)
      ticks.push(horiz
        ? `<line class="${cls}" x1="${t}%" y1="0" x2="${t}%" y2="${comp}%"/><line class="${cls}" x1="${t}%" y1="100%" x2="${t}%" y2="${100 - comp}%"/>`
        : `<line class="${cls}" x1="0" y1="${t}%" x2="${comp}%" y2="${t}%"/><line class="${cls}" x1="100%" y1="${t}%" x2="${100 - comp}%" y2="${t}%"/>`);
    }
    el.innerHTML = `${op.rotulo && !horiz ? `<span class="pc-nome">${esc(op.rotulo)}</span>` : ""}
      <div class="pc-fader-caixa"><svg class="pc-escala" aria-hidden="true">${ticks.join("")}</svg><div class="pc-fader-ranhura"></div><div class="pc-fader-cabeca"></div></div>
      ${op.rotulos ? `<div class="pc-fader-rotulos"><span>${esc(op.rotulos[horiz ? 0 : 1])}</span>${horiz && op.rotulo ? `<span class="pc-nome">${esc(op.rotulo)}</span>` : ""}<span>${esc(op.rotulos[horiz ? 1 : 0])}</span></div>` : (horiz && op.rotulo ? `<span class="pc-nome">${esc(op.rotulo)}</span>` : "")}
      <span class="pc-val"></span>`;
    const caixa = el.querySelector(".pc-fader-caixa"), cabeca = el.querySelector(".pc-fader-cabeca"), val = el.querySelector(".pc-val");
    const formato = op.formato || (v => fmtPadrao(v) + (op.sufixo || ""));
    const pintar = v => { el.style.setProperty("--pos", ((v - min) / (max - min)).toFixed(4)); val.textContent = formato(v); };
    const posicaoDe = e => {
      const r = caixa.getBoundingClientRect(), m = 6;
      const p = horiz ? (e.clientX - r.left - m) / (r.width - 2 * m) : 1 - (e.clientY - r.top - m) / (r.height - 2 * m);
      return Math.min(1, Math.max(0, p));
    };
    return ligarDeslizante({ el, alvoPonteiro: caixa, min, max, passo: op.passo ?? 1, valor: op.valor ?? (tipo === "canal" ? max : (min + max) / 2),
      padrao: op.padrao ?? (tipo === "canal" ? undefined : (min + max) / 2), formato, aoMudar: op.aoMudar, pintar,
      modo: "absoluto", eixo: horiz ? "x" : "y", posicaoDe, naCabeca: e => e.target === cabeca, rotuloAria: op.rotuloAria || op.rotulo, teclado: op.teclado });
  }

  // ---------- BOTÃO ----------
  // opcoes: { rotulo, icone: "play"|"pausa"|"cue"|null, tipo: play|cue|sync|master|loop|kill|neutro, alterna, momentaneo, ligado,
  //           tamanho, quadrado, rotuloAria, titulo, aoAlternar(bool), aoApertar(), aoSoltar(), aoClicar() }
  const ICONES = {
    play: '<svg viewBox="0 0 16 16"><path d="M3 2l11 6-11 6z"/></svg>',
    pausa: '<svg viewBox="0 0 16 16"><rect x="3" y="2" width="4" height="12" rx="1"/><rect x="9" y="2" width="4" height="12" rx="1"/></svg>',
    tras: '<svg viewBox="0 0 16 16"><path d="M13 2L2 8l11 6z"/></svg>',
    frente: '<svg viewBox="0 0 16 16"><path d="M3 2l11 6-11 6z"/></svg>'
  };
  function criarBotao(op = {}) {
    const el = document.createElement("button");
    el.type = "button";
    el.className = `pc-botao pc-botao--${op.tipo || "neutro"}` + (op.tamanho === "compacto" ? " pc-compacto" : "") + (op.quadrado ? " pc-quadrado" : "");
    el.innerHTML = (op.icone && ICONES[op.icone]) ? ICONES[op.icone] : esc(op.rotulo || "");
    if (op.rotuloAria || op.rotulo) el.setAttribute("aria-label", op.rotuloAria || op.rotulo);
    if (op.titulo) el.title = op.titulo;
    let ligado = !!op.ligado;
    const pintar = () => { if (op.alterna || op.momentaneo) el.setAttribute("aria-pressed", String(ligado)); el.classList.toggle("pc-aceso", !!op.acesoExterno && ligado); };
    if (op.alterna) el.addEventListener("click", () => { ligado = !ligado; pintar(); op.aoAlternar && op.aoAlternar(ligado); });
    else if (op.momentaneo) {
      el.addEventListener("pointerdown", e => { if (el.disabled) return; el.setPointerCapture(e.pointerId); ligado = true; pintar(); op.aoApertar && op.aoApertar(); });
      const soltar = () => { if (!ligado) return; ligado = false; pintar(); op.aoSoltar && op.aoSoltar(); };
      el.addEventListener("pointerup", soltar); el.addEventListener("pointercancel", soltar);
      el.addEventListener("keydown", e => { if ((e.key === " " || e.key === "Enter") && !ligado && !e.repeat) { e.preventDefault(); ligado = true; pintar(); op.aoApertar && op.aoApertar(); } });
      el.addEventListener("keyup", e => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); soltar(); } });
    } else if (op.aoClicar) el.addEventListener("click", op.aoClicar);
    pintar();
    return {
      el, ligado: () => ligado,
      definir(v, o = {}) { ligado = !!v; pintar(); if (!o.silencioso && op.aoAlternar) op.aoAlternar(ligado); },
      icone(nome) { el.innerHTML = ICONES[nome] || esc(nome); },
      desabilitar(sim) { el.disabled = !!sim; }, destruir() { el.remove(); }
    };
  }

  // ---------- HOT CUE ----------
  // opcoes: { indice (1..8), cor, rotulo, cheio, tamanho, rotuloAria, aoClicar(cheio) }
  function criarHotCue(op = {}) {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "pc-hotcue" + (op.tamanho === "compacto" ? " pc-compacto" : "");
    let cheio = !!op.cheio, cor = op.cor || "#4a515c", rotulo = op.rotulo || "";
    const pintar = () => {
      el.classList.toggle("pc-cheio", cheio);
      el.style.setProperty("--cor", cheio ? cor : "#4a515c");
      el.innerHTML = `<b>${op.indice ?? ""}</b><span>${esc(cheio ? (rotulo || "cue") : "—")}</span>`;
      el.setAttribute("aria-label", op.rotuloAria || `Hot cue ${op.indice}${cheio ? ": " + rotulo : ", vazio"}`);
    };
    el.addEventListener("click", () => op.aoClicar && op.aoClicar(cheio));
    pintar();
    return { el, cheio: () => cheio, definir(v, o = {}) { cheio = !!v; if (o.cor) cor = o.cor; if (o.rotulo !== undefined) rotulo = o.rotulo; pintar(); }, desabilitar(s) { el.disabled = !!s; }, destruir() { el.remove(); } };
  }

  // ---------- DISPLAY ----------
  // opcoes: { bpm, pitch (%), tom (texto), corTom, tempo (s), tamanho, apagado }
  function criarDisplay(op = {}) {
    const el = document.createElement("div");
    el.className = "pc-display" + (op.tamanho === "compacto" ? " pc-compacto" : "") + (op.apagado ? " pc-apagado" : "");
    el.setAttribute("role", "status"); el.setAttribute("aria-live", "off");
    const fmtTempo = s => { if (s == null) return "--:--"; const m = Math.floor(Math.abs(s) / 60), ss = Math.floor(Math.abs(s) % 60); return `${s < 0 ? "-" : ""}${m}:${String(ss).padStart(2, "0")}`; };
    const estado = { bpm: op.bpm, pitch: op.pitch ?? 0, tom: op.tom, corTom: op.corTom, tempo: op.tempo };
    const pintar = () => {
      const b = estado.bpm == null ? null : estado.bpm.toFixed(1).split(".");
      el.innerHTML = `<div class="pc-dado"><span class="pc-dnome">BPM</span><span class="pc-bpm">${b ? `${b[0]}<small>,${b[1]}</small>` : "---<small>,-</small>"}</span></div>
        <div class="pc-dado"><span class="pc-dnome">Pitch</span><span class="pc-pitch">${(estado.pitch > 0 ? "+" : estado.pitch < 0 ? "−" : "±") + Math.abs(estado.pitch).toFixed(1).replace(".", ",")}%</span></div>
        <div class="pc-dado"><span class="pc-dnome">${estado.tom ? "Tom" : "Tempo"}</span>${estado.tom ? `<span class="pc-tom" style="--cor:${esc(estado.corTom || "#5f6875")}">${esc(estado.tom)}</span>` : `<span class="pc-tempo">${fmtTempo(estado.tempo)}</span>`}</div>`;
      el.setAttribute("aria-label", `BPM ${estado.bpm == null ? "indisponível" : estado.bpm.toFixed(1)}, pitch ${estado.pitch.toFixed(1)}%${estado.tom ? ", tom " + estado.tom : ""}`);
    };
    pintar();
    return { el, definir(parcial) { Object.assign(estado, parcial); pintar(); }, destruir() { el.remove(); } };
  }

  // ---------- JOG / PRATO ----------
  // opcoes: { tamanho, tom, corTom, leds (n, padrão 48), posicao (0..1 na faixa), tocando, rpm (padrão 33,3),
  //           aoGirar(deltaGraus, zona), aoToque(zona|null), aoPasso(±1) }  — zona: "centro" (scratch) | "borda" (bend)
  function criarJog(op = {}) {
    const el = document.createElement("div");
    const n = op.leds || 48;
    el.className = "pc-jog" + (op.tamanho === "compacto" ? " pc-compacto" : "");
    el.setAttribute("role", "slider"); el.setAttribute("tabindex", "0");
    el.setAttribute("aria-label", op.rotuloAria || "Prato: gire para buscar ou fazer scratch; tocando, a borda acelera ou freia");
    el.setAttribute("aria-valuemin", "0"); el.setAttribute("aria-valuemax", "100");
    // anel de LEDs: um círculo tracejado (pathLength = n) por baixo e um cópia acesa recortada pelo setor da posição
    el.innerHTML = `<svg class="pc-jog-leds" viewBox="0 0 100 100" aria-hidden="true">
        <defs><clipPath id="pc-jog-clip-${Math.random().toString(36).slice(2, 8)}"><path d=""/></clipPath></defs>
        <circle class="pc-jog-led-fundo" cx="50" cy="50" r="46.5" stroke-width="3" pathLength="${n}" stroke-dasharray="0.55 0.45" transform="rotate(${(-0.55 / 2 / n * 360).toFixed(2)} 50 50)"/>
        <circle class="pc-jog-led-aceso" cx="50" cy="50" r="46.5" stroke-width="3" pathLength="${n}" stroke-dasharray="0.55 0.45" transform="rotate(${(-0.55 / 2 / n * 360).toFixed(2)} 50 50)"/>
      </svg>
      <div class="pc-jog-prato"><div class="pc-jog-marcador"></div></div>
      <div class="pc-jog-miolo ${op.tom ? "" : "pc-vazio"}" style="--cor:${esc(op.corTom || "#5f6875")}">${esc(op.tom || "—")}</div>`;
    const clip = el.querySelector("clipPath"), clipPath = clip.querySelector("path"), aceso = el.querySelector(".pc-jog-led-aceso");
    aceso.setAttribute("clip-path", `url(#${clip.id})`);
    const estado = { ang: 0, posicao: op.posicao ?? 0, tocando: !!op.tocando, rpm: op.rpm || 33.3, toque: null };
    const pintarLeds = () => {
      const a = 360 * Math.min(1, Math.max(0, estado.posicao));
      const [x0, y0] = polar(50, 50, 60, 0), [x1, y1] = polar(50, 50, 60, a);
      clipPath.setAttribute("d", a <= 0.1 ? "" : a >= 359.9 ? "M-10 -10H110V110H-10Z" : `M50 50 L${x0.toFixed(2)} ${y0.toFixed(2)} A60 60 0 ${a > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)} Z`);
      el.setAttribute("aria-valuenow", String(Math.round(estado.posicao * 100))); el.setAttribute("aria-valuetext", `${Math.round(estado.posicao * 100)}% da faixa`);
    };
    const pintarAng = () => el.style.setProperty("--ang", estado.ang.toFixed(2) + "deg");
    const miolo = el.querySelector(".pc-jog-miolo");
    // giro automático quando tocando (rAF só enquanto toca)
    let quadro = null, tAnt = 0;
    const passoGiro = t => {
      if (!estado.tocando || estado.toque === "centro") { quadro = null; return; }
      if (tAnt) estado.ang = (estado.ang + (t - tAnt) / 1000 * estado.rpm * 6) % 360;
      tAnt = t; pintarAng(); quadro = requestAnimationFrame(passoGiro);
    };
    const ligarGiro = () => { if (!quadro && estado.tocando && !reduzMovimento()) { tAnt = 0; quadro = requestAnimationFrame(passoGiro); } };
    // arrasto angular: zona pelo raio do toque (centro ≤ 60% = scratch; fora = borda/bend)
    const anguloDe = e => { const r = el.getBoundingClientRect(); return [Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2)) * 180 / Math.PI, Math.hypot(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2)) / (r.width / 2)]; };
    el.addEventListener("pointerdown", e => {
      if (el.getAttribute("aria-disabled") === "true") return;
      e.preventDefault(); el.setPointerCapture(e.pointerId); el.focus({ preventScroll: true });
      let [a0, raio] = anguloDe(e);
      estado.toque = raio <= 0.6 ? "centro" : "borda"; el.dataset.toque = estado.toque; el.classList.add("pc-arrastando");
      op.aoToque && op.aoToque(estado.toque);
      const mover = e2 => {
        const [a1] = anguloDe(e2); let d = a1 - a0; if (d > 180) d -= 360; if (d < -180) d += 360; a0 = a1;
        estado.ang = (estado.ang + d + 360) % 360; pintarAng();
        if (!estado.tocando || estado.toque === "centro") { estado.posicao = Math.min(1, Math.max(0, estado.posicao + d / 360 * 0.02)); pintarLeds(); }
        op.aoGirar && op.aoGirar(d, estado.toque);
      };
      const soltar = () => { el.removeEventListener("pointermove", mover); el.removeEventListener("pointerup", soltar); el.removeEventListener("pointercancel", soltar);
        estado.toque = null; delete el.dataset.toque; el.classList.remove("pc-arrastando"); op.aoToque && op.aoToque(null); ligarGiro(); };
      el.addEventListener("pointermove", mover); el.addEventListener("pointerup", soltar); el.addEventListener("pointercancel", soltar);
    });
    el.addEventListener("keydown", e => {
      const d = e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowDown" ? -1 : 0;
      if (d) { e.preventDefault(); estado.ang = (estado.ang + d * 15 + 360) % 360; estado.posicao = Math.min(1, Math.max(0, estado.posicao + d * 0.01)); pintarAng(); pintarLeds(); op.aoPasso && op.aoPasso(d); }
    });
    pintarLeds(); pintarAng(); el.classList.toggle("pc-tocando", estado.tocando); ligarGiro();
    return {
      el,
      definir(parcial) {
        if (parcial.tom !== undefined) { miolo.textContent = parcial.tom || "—"; miolo.classList.toggle("pc-vazio", !parcial.tom); }
        if (parcial.corTom) miolo.style.setProperty("--cor", parcial.corTom);
        if (parcial.posicao !== undefined) { estado.posicao = parcial.posicao; pintarLeds(); }
        if (parcial.rpm) estado.rpm = parcial.rpm;
        if (parcial.tocando !== undefined) { estado.tocando = !!parcial.tocando; el.classList.toggle("pc-tocando", estado.tocando); if (estado.tocando) ligarGiro(); }
      },
      desabilitar(s) { el.setAttribute("aria-disabled", String(!!s)); el.tabIndex = s ? -1 : 0; },
      destruir() { if (quadro) cancelAnimationFrame(quadro); el.remove(); }
    };
  }


  // ---------- VESTIR: pele por cima, <input type=range> por baixo (proposta B, decisão do Lucas de 2026-11-07) ----------
  // O input continua sendo a fonte de verdade (min/max/step/value, aria-label, foco, teclado, testes de texto); a peça é só a pele:
  //   peça → input.value + evento "input" (quem escuta o input nem sabe da peça);
  //   input → peça.definir(valor, {silencioso}) no "input"/"change" e em quem reescrever input.value (mixerSincronizarTela chama el._peca).
  // o = { fabrica: "knob"|"fader", padrao, tamanho: "compacto", orientacao, tipo: "canal"|"cross"|"pitch", comprimento, marcas, tamPx }
  function vestir(input, o = {}) {
    if (!input) return null;
    if (input._peca) return input._peca;
    const min = Number(input.min), max = Number(input.max), passo = Number(input.step) || 1, valor = Number(input.value);
    const comum = { min, max, passo, valor, padrao: o.padrao, tamanho: o.tamanho, formato: () => "", teclado: false,
      aoMudar: v => { input.value = String(v); input.dispatchEvent(new Event("input", { bubbles: true })); } };
    const peca = o.fabrica === "knob"
      ? criarKnob({ ...comum, bipolar: o.padrao !== undefined && o.padrao === (min + max) / 2 })
      : criarFader({ ...comum, orientacao: o.orientacao, tipo: o.tipo, comprimento: o.comprimento, marcas: o.marcas });
    peca.el.classList.add("pc-vestida", "pc-sem-texto");
    if (o.tamPx) peca.el.style.setProperty("--tam", o.tamPx + "px");
    peca.el.setAttribute("aria-hidden", "true");
    input.classList.add("pc-oculto");
    input.after(peca.el);
    const eco = () => peca.definir(input.value, { silencioso: true });
    input.addEventListener("input", eco); input.addEventListener("change", eco);
    if (input.disabled) peca.desabilitar(true);
    input._peca = peca;
    return peca;
  }
  // limpa as peças vestidas dentro de um container antes de reescrever o innerHTML (sem fuga de ouvinte/nó)
  function destruirEm(raiz) {
    if (!raiz || !raiz.querySelectorAll) return 0;
    let n = 0;
    for (const i of raiz.querySelectorAll("input.pc-oculto")) { if (i._peca) { i._peca.destruir(); i._peca = null; n++; } }
    return n;
  }

  return { criarKnob, criarFader, criarBotao, criarHotCue, criarDisplay, criarJog, ligarDeslizante, vestir, destruirEm, _util: { arco, polar, esc } };
})();
if (typeof module !== "undefined") module.exports = VbMxPecas;
