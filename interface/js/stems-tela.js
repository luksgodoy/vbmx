// ===================== stems-tela.js — faixa de STEMS por deck: slot deck-X-stems (data-stems="X") =====================
// Mostra, por deck, o estado da separação, o botão STEMS (liga/desliga o modo), o reset e 4 canais
// (vocals, drums, bass, instrumental) com MUDO/SOLO, volume, EQ hi/mid/low com kill, filtro, FX e medidor de pico.
// NÃO tem áudio: consome a API global `VbMxStems` (js/stems.js, de outro dono) —
//   NOMES · ativo(letra) · definir(letra, nome, parcial) · estado(letra, nome) (+ pico) · aoMudar(fn) → cancelar
//   opcional: ligar(letra, bool) — liga/desliga o modo; sem ela a faixa só recolhe/expande na tela.
// Ganchos de integração do fluxo de carga (a integração real vem depois):
//   VbMxStemsTela.mostrarEstado(letra, {fase, progresso, erro, carregando})  fase: ausente|enviando|separando|baixando|pronto|erro
//   VbMxStemsTela.aoPedir(fn)  fn(letra) dispara no clique em "STEMS" quando a fase não é "pronto"
// O slot mora fora do deck (renderDeck reescreve o innerHTML dele), na grade .decks. Contrato: docs/contratos.md.
(function (raiz) {
  'use strict';
  const LETRAS = ['A', 'B'];
  const NOMES_PADRAO = ['vocals', 'drums', 'bass', 'instrumental'];
  const ROTULOS = { vocals: 'vocals', drums: 'drums', bass: 'bass', instrumental: 'outros' };
  const BANDAS = [['hi', 'HI'], ['mid', 'MID'], ['low', 'LOW']];
  const EQ_MIN = -26, EQ_MAX = 6, VOL_MAX = 1.5;
  const FX = [['delay', 'delay'], ['reverb', 'reverb'], ['flanger', 'flanger'], ['phaser', 'phaser'], ['gater', 'gater']];
  const FASES = ['ausente', 'enviando', 'separando', 'baixando', 'pronto', 'erro'];

  const tela = {};                 // letra → {el, fase, progresso, erro, local, arrastando, pendente, cancelar, quadro}
  let pedir = null;

  const S = () => raiz.VbMxStems || null;
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const nomes = () => { const s = S(); return s && Array.isArray(s.NOMES) && s.NOMES.length ? s.NOMES : NOMES_PADRAO; };
  const t = letra => tela[letra] || (tela[letra] = { el: null, fase: 'ausente', progresso: 0, erro: '', local: false, arrastando: false, pendente: false, cancelar: null, quadro: 0 });
  const num = (v, pad) => (typeof v === 'number' && isFinite(v) ? v : pad);
  const limitar = (v, a, b) => Math.min(b, Math.max(a, v));

  function ativo(letra) { const s = S(); return !!(s && typeof s.ativo === 'function' ? s.ativo(letra) : t(letra).local); }
  function estadoDe(letra, nome) {
    const s = S(); const e = (s && typeof s.estado === 'function' && s.estado(letra, nome)) || {};
    const eq = e.eq || {};
    return { mudo: !!e.mudo, solo: !!e.solo, volume: num(e.volume, 1), eq: { hi: num(eq.hi, 0), mid: num(eq.mid, 0), low: num(eq.low, 0) },
      filtro: num(e.filtro, 0), fx: e.fx || null, pico: limitar(num(e.pico, 0), 0, 1) };
  }
  function textoFase(x) {
    if (x.fase === 'separando' && x.carregando) return 'carregando modelo…';
    if (x.fase === 'separando') { const p = num(x.progresso, 0); return `separando ${Math.round(limitar(p <= 1 ? p * 100 : p, 0, 100))}%`; }
    if (x.fase === 'erro') return `erro: ${x.erro || 'falhou'}`;
    return FASES.includes(x.fase) ? x.fase : 'ausente';
  }
  const fmtDb = v => (v <= EQ_MIN ? 'KILL' : `${v > 0 ? '+' : ''}${Math.round(v * 10) / 10}`);
  const fmtFiltro = v => (Math.abs(v) < 0.02 ? 'off' : v < 0 ? `LP ${Math.round(-v * 100)}` : `HP ${Math.round(v * 100)}`);

  // ---- HTML (puro: testável sem DOM) ----
  function htmlCanal(letra, nome) {
    const e = estadoDe(letra, nome), rot = ROTULOS[nome] || nome, id = `${letra}-${nome}`;
    const eq = BANDAS.map(([b, r]) => {
      const v = e.eq[b], kill = v <= EQ_MIN;
      return `<div class="stems-lin" title="${r} ${fmtDb(v)} dB · duplo clique zera">
        <span class="nome">${r}</span>
        <input type="range" min="${EQ_MIN}" max="${EQ_MAX}" step="0.5" value="${v}" data-ctl="eq" data-canal="${nome}" data-banda="${b}" aria-label="EQ ${r} do stem ${rot}, deck ${letra}, de ${EQ_MIN} a +${EQ_MAX} dB">
        <button class="kill${kill ? ' ligado' : ''}" data-ctl="kill" data-canal="${nome}" data-banda="${b}" aria-pressed="${kill}" title="Kill ${r}" aria-label="Kill ${r} do stem ${rot}, deck ${letra}">K</button><span class="val mono">${fmtDb(v)}</span></div>`;
    }).join('');
    const fx = e.fx;
    const opcoes = `<option value="">sem fx</option>` + FX.map(([i, r]) => `<option value="${i}"${fx && fx.id === i ? ' selected' : ''}>${r}</option>`).join('');
    const fxLinhas = fx ? `
      <div class="stems-lin"><span class="nome">PAR</span><input type="range" min="0" max="1" step="0.01" value="${num(fx.param, 0.5)}" data-ctl="fx-param" data-canal="${nome}" aria-label="Parâmetro do fx do stem ${rot}, deck ${letra}"><span class="val mono">${Math.round(num(fx.param, 0.5) * 100)}</span></div>
      <div class="stems-lin"><span class="nome">MIX</span><input type="range" min="0" max="1" step="0.01" value="${num(fx.mix, 0.5)}" data-ctl="fx-mix" data-canal="${nome}" aria-label="Mix do fx do stem ${rot}, deck ${letra}"><span class="val mono">${Math.round(num(fx.mix, 0.5) * 100)}</span></div>` : '';
    return `<div class="stems-canal${e.mudo ? ' mudo' : ''}${e.solo ? ' solo' : ''}" data-canal="${esc(nome)}" id="stems-${id}" role="group" aria-label="Stem ${esc(rot)} do deck ${letra}">
      <div class="stems-nome">${esc(rot)}</div>
      <div class="stems-ms">
        <button class="stems-btn${e.mudo ? ' ligado' : ''}" data-ctl="mudo" data-canal="${nome}" aria-pressed="${e.mudo}" title="Mudo" aria-label="Mudo do stem ${esc(rot)}, deck ${letra}">M</button>
        <button class="stems-btn${e.solo ? ' ligado' : ''}" data-ctl="solo" data-canal="${nome}" aria-pressed="${e.solo}" title="Solo" aria-label="Solo do stem ${esc(rot)}, deck ${letra}">S</button>
      </div>
      <div class="stems-vol">
        <input type="range" min="0" max="${VOL_MAX}" step="0.01" value="${e.volume}" data-ctl="volume" data-canal="${nome}" title="Volume · duplo clique volta a 1" aria-label="Volume do stem ${esc(rot)}, deck ${letra}, de 0 a ${VOL_MAX}">
        <div class="stems-pico" aria-hidden="true"><i data-pico="${nome}" style="transform:scaleY(${e.pico})"></i></div>
      </div>
      <div class="stems-val mono">vol ${Math.round(e.volume * 100)}%</div>
      <div class="stems-eq">${eq}</div>
      <div class="stems-lin" title="Filtro: passa-baixa ← 0 → passa-alta · duplo clique zera"><span class="nome">FLT</span>
        <input type="range" min="-1" max="1" step="0.01" value="${e.filtro}" data-ctl="filtro" data-canal="${nome}" aria-label="Filtro do stem ${esc(rot)}, deck ${letra}: passa-baixa à esquerda, passa-alta à direita"><span class="val mono">${fmtFiltro(e.filtro)}</span></div>
      <select data-ctl="fx" data-canal="${nome}" aria-label="Efeito do stem ${esc(rot)}, deck ${letra}">${opcoes}</select>${fxLinhas}
    </div>`;
  }
  function html(letra) {
    const x = t(letra), lig = ativo(letra), pronto = x.fase === 'pronto';
    const cab = `<div class="stems-cab">
      <span class="stems-titulo">Stems ${letra}</span>
      <span class="stems-estado ${esc(x.fase)}" data-fase="${esc(x.fase)}" role="status" title="${esc(x.fase === 'erro' ? textoFase(x) : '')}">${esc(textoFase(x))}</span>
      <button class="stems-btn stems-liga${lig ? ' ligado' : ''}" data-ctl="toggle" aria-pressed="${lig}" title="${pronto ? 'Liga/desliga o modo stems do deck' : 'Separa a faixa em stems e liga o modo'}" aria-label="STEMS do deck ${letra}">STEMS</button>
      <button class="stems-btn stems-recolher" type="button" data-recolher="stems-${letra}" aria-pressed="false" title="Recolher os canais dos stems; de novo para expandir" aria-label="Recolher ou expandir os stems do deck ${letra}"></button>
      <button class="stems-btn" data-ctl="reset" ${lig ? '' : 'disabled'} title="Volta tudo a volume 1, EQ 0 e sem fx" aria-label="Reset dos stems do deck ${letra}">reset</button>
    </div>`;
    return cab + (lig ? `<div class="stems-canais">${nomes().map(n => htmlCanal(letra, n)).join('')}</div>` : '');
  }

  // ---- desenho ----
  function desenhar(letra) {
    const x = t(letra);
    if (x.arrastando) { x.pendente = true; return; }       // não troca o HTML no meio do arrasto
    x.pendente = false;
    if (!x.el) return;
    const Pecas = typeof VbMxPecas !== 'undefined' ? VbMxPecas : null;   // const de topo não vira propriedade de window
    if (Pecas) Pecas.destruirEm(x.el);   // peças vestidas saem antes de reescrever o innerHTML
    x.el.innerHTML = html(letra);
    x.el.classList.toggle('recolhido', !ativo(letra));
    x.el.hidden = false;
    if (Pecas) vestir(x.el, Pecas);
    medidor(letra);
  }
  // proposta B (pele por cima, input por baixo); D2 do VB-UI-ROLAGEM (2026-11-08): faixa HORIZONTAL de ~120 px — volume em fader
  // horizontal (a largura vem do CSS, css/tela-cheia.css), EQ, filtro e fx em knobs de 22 px; as 4 tiras lado a lado em qualquer largura.
  // Só veste: a lógica (aoControle, definir) continua ouvindo o input, que a peça escreve e dispara.
  function vestir(el, Pecas) {
    for (const i of el.querySelectorAll('input[type=range][data-ctl]')) {
      const c = i.dataset.ctl;
      if (c === 'volume') Pecas.vestir(i, { fabrica: 'fader', tipo: 'canal', orientacao: 'horizontal', tamanho: 'compacto', comprimento: 90, marcas: 5, padrao: 1 });
      else if (c === 'eq') Pecas.vestir(i, { fabrica: 'knob', padrao: 0, tamPx: 22 });
      else if (c === 'filtro') Pecas.vestir(i, { fabrica: 'knob', padrao: 0, tamPx: 22 });
      else Pecas.vestir(i, { fabrica: 'knob', padrao: 0.5, tamPx: 22 });   // fx-param / fx-mix
    }
  }
  function medidor(letra) {            // laço do medidor de pico: só roda com a faixa aberta
    const x = t(letra);
    if (x.quadro || !raiz.requestAnimationFrame || !ativo(letra)) return;
    const passo = () => {
      x.quadro = 0;
      if (!ativo(letra) || !x.el || !x.el.querySelectorAll) return;
      for (const i of x.el.querySelectorAll('[data-pico]')) i.style.transform = `scaleY(${estadoDe(letra, i.dataset.pico).pico})`;
      x.quadro = raiz.requestAnimationFrame(passo);
    };
    x.quadro = raiz.requestAnimationFrame(passo);
  }

  // ---- ações (um único caminho: tudo vira VbMxStems.definir) ----
  function definir(letra, nome, parcial) { const s = S(); if (s && typeof s.definir === 'function') s.definir(letra, nome, parcial); }
  function alternarModo(letra) {
    const x = t(letra), s = S();
    if (!ativo(letra) && x.fase !== 'pronto') { if (pedir) pedir(letra); return; }
    const novo = !ativo(letra);
    if (s && typeof s.ligar === 'function') s.ligar(letra, novo); else x.local = novo;
    desenhar(letra);
  }
  function zerarTudo(letra) {
    for (const n of nomes()) definir(letra, n, { mudo: false, solo: false, volume: 1, eq: { hi: 0, mid: 0, low: 0 }, filtro: 0, fx: null });
  }
  function aoControle(letra, el, tipo) {          // tipo: 'click' | 'input' | 'change' | 'dblclick'
    const c = el.dataset.ctl, nome = el.dataset.canal, b = el.dataset.banda, v = Number(el.value);
    if (tipo === 'click') {
      if (c === 'toggle') return alternarModo(letra);
      if (c === 'reset') return zerarTudo(letra);
      if (c === 'mudo' || c === 'solo') return definir(letra, nome, { [c]: !estadoDe(letra, nome)[c] });
      if (c === 'kill') return definir(letra, nome, { eq: { [b]: estadoDe(letra, nome).eq[b] <= EQ_MIN ? 0 : EQ_MIN } });
      return;
    }
    if (tipo === 'dblclick') {
      if (c === 'volume') definir(letra, nome, { volume: 1 });
      else if (c === 'eq') definir(letra, nome, { eq: { [b]: 0 } });
      else if (c === 'filtro') definir(letra, nome, { filtro: 0 });
      return;
    }
    if (tipo === 'input') {
      if (c === 'volume') definir(letra, nome, { volume: limitar(v, 0, VOL_MAX) });
      else if (c === 'eq') definir(letra, nome, { eq: { [b]: limitar(v, EQ_MIN, EQ_MAX) } });
      else if (c === 'filtro') definir(letra, nome, { filtro: limitar(v, -1, 1) });
      else if (c === 'fx-param' || c === 'fx-mix') {
        const fx = estadoDe(letra, nome).fx; if (!fx) return;
        definir(letra, nome, { fx: { id: fx.id, param: c === 'fx-param' ? limitar(v, 0, 1) : num(fx.param, 0.5), mix: c === 'fx-mix' ? limitar(v, 0, 1) : num(fx.mix, 0.5) } });
      }
      return;
    }
    if (tipo === 'change' && c === 'fx') {
      const id = el.value, atual = estadoDe(letra, nome).fx;
      definir(letra, nome, { fx: id ? { id, param: atual ? num(atual.param, 0.5) : 0.5, mix: atual ? num(atual.mix, 0.5) : 0.5 } : null });
    }
  }

  function montar(letra, el) {
    const x = t(letra);
    if (x.cancelar) { x.cancelar(); x.cancelar = null; }
    x.el = el;
    el.classList.add('stems');
    const alvo = e => (e.target && e.target.closest ? e.target.closest('[data-ctl]') : null);
    for (const tipo of ['click', 'input', 'change', 'dblclick']) {
      el.addEventListener(tipo, e => { const a = alvo(e); if (a && !a.disabled) aoControle(letra, a, tipo); });
    }
    el.addEventListener('pointerdown', e => { const a = alvo(e); if ((a && a.type === 'range') || (e.target && e.target.closest && e.target.closest('.pc-vestida'))) x.arrastando = true; });   // o gesto pode começar na pele (peça) ou no input
    const soltar = () => { if (!x.arrastando) return; x.arrastando = false; if (x.pendente) desenhar(letra); };
    for (const ev of ['pointerup', 'pointercancel']) { el.addEventListener(ev, soltar); }
    el.addEventListener('keyup', soltar);
    const s = S();
    if (s && typeof s.aoMudar === 'function') x.cancelar = s.aoMudar(() => desenhar(letra));
    desenhar(letra);
  }

  const api = {
    NOMES_PADRAO, montar,
    html, estadoTexto: textoFase,
    mostrarEstado(letra, d) {
      const x = t(letra), e = d || {};
      x.fase = FASES.includes(e.fase) ? e.fase : 'ausente';
      x.progresso = num(e.progresso, 0); x.carregando = !!e.carregando; x.erro = e.erro ? String(e.erro) : '';
      desenhar(letra);
    },
    aoPedir(fn) { pedir = typeof fn === 'function' ? fn : null; return () => { if (pedir === fn) pedir = null; }; },
    redesenhar(letra) { for (const l of letra ? [letra] : LETRAS) desenhar(l); },
  };
  // ---- ações de teclado/MIDI: deck{A|B}.stem.<voz>.<controle> (VbMxUI.acao). Mesmo caminho da tela: VbMxStems.definir ----
  // Comandos e escalas em motor/mapa-controle.js (STEMS_VOZES, parcialDoStem); aqui só a ponte para o motor de stems.
  if (raiz.VbMxUI && typeof raiz.VbMxUI.registrar === 'function') {
    const reg = (nome, fn) => raiz.VbMxUI.registrar('acao', nome, fn);
    const MC = () => raiz.VbMxMapaControle;
    // X1-STEMS: as atribuições ◀/▶ do controlador. Mesmo caminho dos botões STEMS e reset da faixa.
    for (const letra of LETRAS) {
      reg(`deck${letra}.stems.ligar`, () => alternarModo(letra));
      reg(`deck${letra}.stems.restaurar`, () => { if (ativo(letra)) zerarTudo(letra); });
    }
    for (const letra of LETRAS) for (const voz of NOMES_PADRAO) {
      const base = `deck${letra}.stem.${voz}.`;
      const alterna = campo => v => { const atual = !!estadoDe(letra, voz)[campo]; definir(letra, voz, { [campo]: typeof v === 'boolean' ? v : !atual }); };
      reg(base + 'mudo', alterna('mudo'));
      reg(base + 'solo', alterna('solo'));
      for (const campo of ['volume', 'hi', 'mid', 'low', 'filtro', 'fxParam', 'fxMix']) {
        reg(base + campo, v => {
          const m = MC(), cmd = m && m.comandoPorId(`stem.${voz}.${campo}`); if (!cmd) return;
          const p = m.parcialDoStem(cmd, v, estadoDe(letra, voz)); if (p) definir(letra, voz, p);
        });
      }
      reg(base + 'fxProx', () => {      // sem efeito → delay → reverb → … → sem efeito
        const atual = estadoDe(letra, voz).fx, i = atual ? FX.findIndex(f => f[0] === atual.id) : -1;
        const prox = FX[i + 1];
        definir(letra, voz, { fx: prox ? { id: prox[0], param: atual ? num(atual.param, 0.5) : 0.5, mix: atual ? num(atual.mix, 0.5) : 0.5 } : null });
      });
    }
  }
  raiz.VbMxStemsTela = api;
  if (raiz.VbMxUI && typeof raiz.VbMxUI.aoIniciar === 'function') {
    raiz.VbMxUI.aoIniciar(() => {
      if (!raiz.document) return;
      // sem o servidor de stems (hospedagem estática) o painel inteiro fica recolhido: nada para o DJ clicar
      const B = raiz.VbMxBiblioteca, loc = raiz.location;
      if (B && B.stemsDisponiveis && loc && loc.protocol !== 'file:' && !B.stemsDisponiveis(loc) && !raiz.VbMxSidra) return;   // o plugin Sidra separa no navegador: vale em hospedagem estática
      for (const l of LETRAS) { const el = raiz.document.querySelector(`[data-stems="${l}"]`); if (el) montar(l, el); }
    });
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
