// ===================== medidores.js — medidores de nível: slot mixer-medidores; lê VbMxCadeia.derivar =====================
// Dono: VB-16, refeito como LEDs na proposta C (2026-11-07). Um <canvas> no slot do mixer com quatro colunas de 18 LEDs
// (verde → âmbar → vermelho, escala em dBFS de VbMxMixer.LEDS_DB): A e B (derivação "pre-fader": depois do trim, EQ e filtro,
// antes do fader — o que o canal entrega) e o master estéreo, L e R (derivação "master" → ChannelSplitter(2) → um analisador por
// lado). Cada coluna tem pico retido (segura 1,2 s, cai a 30 dB/s) e um CLIPE pegajoso (pico ≥ 0,999) que só apaga no clique
// do canvas. Os números (balística, limiares) vêm de VbMxMixer; aqui só ficam os AnalyserNode e o desenho. Redesenha a no
// máximo 30 quadros por segundo (10 com movimento reduzido) e só com a aba visível. O leitor de tela recebe um role="meter"
// escondido por coluna, atualizado a 2 Hz. No carregamento só declara; o DOM entra em VbMxUI.aoIniciar.
const MEDIDORES_COLUNAS = [["A", "A"], ["B", "B"], ["L", "L"], ["R", "R"]];   // id, rótulo
const MEDIDORES_COR = { verde: "#4cc38a", ambar: "#e6b34a", vermelho: "#e5655b" };
const medidores = { analisadores: {}, medidores: {}, buffer: null, ultimo: 0, ultimoAria: 0, rodando: false, canvas: null, aria: {}, ultimos: {}, intervalo: 1000 / 30 };

function medidoresMontarTela(){
  const slot = VbMxUI.slot("mixer-medidores"), mixerEl = document.getElementById("mixer");
  if (!slot || !mixerEl) return;
  slot.classList.add("medidores");
  slot.setAttribute("aria-label", "Medidores de nível");
  slot.innerHTML = `<canvas class="medidores-canvas" title="Clique para limpar o CLIPE" aria-hidden="true"></canvas>
    <div class="so-leitor">${MEDIDORES_COLUNAS.map(([id]) => `<div role="meter" data-medidor="${id}" aria-label="Nível ${id === "L" ? "do master, lado esquerdo" : id === "R" ? "do master, lado direito" : "do canal " + id}" aria-valuemin="-60" aria-valuemax="0" aria-valuenow="-60"></div>`).join("")}</div>`;
  medidoresPosicionar(mixerEl, slot);
  slot.hidden = false;
  medidores.canvas = slot.querySelector("canvas");
  for (const [id] of MEDIDORES_COLUNAS) {
    medidores.aria[id] = slot.querySelector(`[data-medidor="${id}"]`);
    medidores.medidores[id] = VbMxMixer.criarMedidor({ clipeMs: Infinity });   // clipe pegajoso: só limparClipe() apaga
    medidores.ultimos[id] = { db: -60, picoAltura: 0, clip: false };
  }
  medidores.canvas.addEventListener("click", () => { for (const id of Object.keys(medidores.medidores)) medidores.medidores[id].limparClipe(); });
  if (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches) medidores.intervalo = 100;
}

// D3 do VB-UI-ROLAGEM (decisão do Lucas, 2026-11-08): os LEDs moram ENTRE os canais A e B, na altura dos faders (custo de
// altura zero), como num mixer de cabine. renderMixer (js/mixer.js) faz o mesmo ao reescrever o innerHTML; sem .canais, vai pro fim.
function medidoresPosicionar(mixerEl, slot){
  const canais = mixerEl.querySelector(".canais"), b = canais && canais.querySelector('.canal[data-canal="B"]');
  if (b) canais.insertBefore(slot, b); else mixerEl.appendChild(slot);
}

// O nó de análise nasce depois do primeiro gesto (a cadeia só existe então): tenta a cada quadro até montar.
function medidoresLigar(){
  if (!VbMxCadeia.montada()) return false;
  const novo = (d) => { const an = d.context.createAnalyser(); an.fftSize = 1024; an.smoothingTimeConstant = 0; return an; };
  for (const l of ["A", "B"]) {
    if (medidores.analisadores[l]) continue;
    const d = VbMxCadeia.derivar("pre-fader", l), an = novo(d);
    d.connect(an);   // a derivação não vai a lugar nenhum até alguém ligá-la (docs/contratos.md); o analisador não escuta nada além
    medidores.analisadores[l] = an;
  }
  if (!medidores.analisadores.L) {
    const d = VbMxCadeia.derivar("master"), sp = d.context.createChannelSplitter(2), aL = novo(d), aR = novo(d);
    d.connect(sp); sp.connect(aL, 0); sp.connect(aR, 1);
    medidores.analisadores.L = aL; medidores.analisadores.R = aR;
  }
  if (!medidores.buffer) medidores.buffer = new Float32Array(1024);
  return true;
}

function medidoresDesenhar(){
  const cv = medidores.canvas; if (!cv) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1), W = cv.clientWidth || 200, H = cv.clientHeight || 130;
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
  const c = cv.getContext("2d"); if (!c) return;
  c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, W, H);
  const N = VbMxMixer.LEDS_DB.length, CLIP = 8, ROT = 12, gap = 2, areaH = H - CLIP - 4 - ROT, ledH = (areaH - gap * (N - 1)) / N;
  // estreito (entre os canais, ~50 px): sem régua, colunas finas; largo (o desenho antigo): régua e colunas de 22 px
  const largo = W >= 140, regua = largo ? 24 : 0, gCol = largo ? 6 : 2, gGrupo = largo ? 26 : 6;
  const colW = Math.max(4, Math.min(22, Math.floor((W - regua - gCol * 2 - gGrupo) / 4))), total = regua + colW * 4 + gCol * 2 + gGrupo, x0 = Math.max(0, (W - total) / 2);
  const xDe = k => x0 + regua + Math.floor(k / 2) * (2 * colW + gCol + gGrupo) + (k % 2) * (colW + gCol);   // dois grupos: canais A/B e master L/R
  c.font = (largo ? 8 : 7) + "px 'JetBrains Mono', monospace"; c.textBaseline = "middle";
  if (largo) for (const mrc of [-40, -30, -20, -12, -6, 0]) {   // régua: o LED mais próximo do valor
    const i = VbMxMixer.LEDS_DB.reduce((m, d, j) => Math.abs(d - mrc) < Math.abs(VbMxMixer.LEDS_DB[m] - mrc) ? j : m, 0), y = CLIP + 4 + (N - 1 - i) * (ledH + gap) + ledH / 2;
    c.fillStyle = "#6b7380"; c.textAlign = "right"; c.fillText(String(mrc), x0 + regua - 5, y);
  }
  MEDIDORES_COLUNAS.forEach(([id, rotulo], k) => {
    const x = xDe(k), u = medidores.ultimos[id], acesos = VbMxMixer.ledsAcesos(u.db), pico = u.picoAltura > 0 ? VbMxMixer.ledsAcesos(u.picoAltura * 60 - 60) - 1 : -1;
    c.fillStyle = u.clip ? MEDIDORES_COR.vermelho : "#262a31"; c.fillRect(x, 0, colW, CLIP);   // CLIPE
    for (let i = 0; i < N; i++) {
      const y = CLIP + 4 + (N - 1 - i) * (ledH + gap), cor = MEDIDORES_COR[VbMxMixer.zonaDoLed(i)];
      c.globalAlpha = i < acesos || i === pico ? 1 : 0.14; c.fillStyle = cor; c.fillRect(x, y, colW, ledH);
    }
    c.globalAlpha = 1; c.fillStyle = "#8b93a0"; c.textAlign = "center"; c.fillText(rotulo, x + colW / 2, H - ROT / 2 + 1);
  });
}

function medidoresQuadro(agora){
  requestAnimationFrame(medidoresQuadro);
  if (document.hidden || agora - medidores.ultimo < medidores.intervalo) return;
  medidores.ultimo = agora;
  const ligado = medidoresLigar(), emAria = agora - medidores.ultimoAria > 500;
  for (const id of Object.keys(medidores.medidores)) {
    let pico = 0;
    const an = medidores.analisadores[id];
    if (ligado && an) { an.getFloatTimeDomainData(medidores.buffer); pico = VbMxMixer.nivelDeAmostras(medidores.buffer).pico; }
    const r = medidores.medidores[id].atualizar(pico, agora);
    medidores.ultimos[id] = { db: r.db, picoAltura: r.picoAltura, clip: r.clip };
    if (emAria && medidores.aria[id]) medidores.aria[id].setAttribute("aria-valuenow", String(Math.round(r.db)));
  }
  if (emAria) medidores.ultimoAria = agora;
  medidoresDesenhar();
}

VbMxUI.aoIniciar(()=>{
  medidoresMontarTela();
  if (medidores.rodando || typeof requestAnimationFrame !== "function") return;
  medidores.rodando = true;
  requestAnimationFrame(medidoresQuadro);
});
