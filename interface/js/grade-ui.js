// ===================== grade-ui.js — beatgrid na tela: slot deck-X-grade e camada-onda com as batidas (VbMxGrade) =====================
// Dono: VB-13 (onda 1). Esqueleto criado pelo VB-11: a página já carrega este arquivo (classico.html não
// muda na onda 1). No carregamento só declare e registre (VbMxUI.registrar/ouvir, VbMxPrefs.declarar);
// mexa no DOM dentro de VbMxUI.aoIniciar(fn). Nome de topo com prefixo do módulo (os scripts
// clássicos dividem o escopo global). Contrato: docs/contratos.md.

// ---- VB-13: a grade na tela ----------------------------------------------------------------------
// A análise (biblioteca/painel.js) guarda `faixa.grade = {bpm, primeira}`; aqui ela aparece como
// linhas de batida (mais forte no 1 do compasso) por cima das ondas e no slot deck-X-grade, com o
// ajuste manual: mover a grade (±10 ms), ×2, ÷2, ancorar no CUE e travar. Sem grade analisada
// (faixa de exemplo, análise antiga) a grade sai do BPM com 1ª batida em 0, marcada "estimada".
// O ajuste é gravado em `faixa.grade` (então loops/beatjump/quantize, que leem VbMxGrade.daFaixa,
// já usam a grade ajustada) e no localStorage por caminho do arquivo, com try/catch.
// O tick audível (VB-13b) fica em tick.js (agendado pelo relógio do AudioContext); aqui só o botão TICK.
// "Grade + cue" (VB-13b): na carga, faixa com grade analisada e sem cue ganha o cue na 1ª batida da grade.
(function () {
  'use strict';
  if (typeof VbMxUI === 'undefined') return;
  VbMxUI.declararEvento('grade:mudou'); // {letra, faixa, grade}: o ajuste manual alterou a grade do deck

  const PASSO_S = 0.01;
  const chaveDe = (f) => 'vbmx-grade:' + (f.caminho || ('id' + f.id));
  const B = () => (typeof VbMxBiblioteca !== 'undefined' ? VbMxBiblioteca : null);
  const efetiva = (f) => (f ? VbMxGrade.daFaixa(f, 0) : null);

  function gradeLer(f) {
    try { const v = JSON.parse(localStorage.getItem(chaveDe(f)) || 'null'); return v && (v.apagada || (B() && B().gradeValida(v))) ? v : null; } catch (_) { return null; }
  }
  function gradeGravar(f, g, travada) {
    try { localStorage.setItem(chaveDe(f), JSON.stringify(g ? { bpm: g.bpm, primeira: g.primeira, travada: !!travada } : { apagada: true, travada: !!travada })); } catch (_) { /* sem armazenamento: vale na sessão */ }
  }
  // Reaplica o ajuste guardado na faixa (os objetos de faixa nascem de novo a cada troca de pasta).
  function gradeAplicar(f) {
    if (!f) return;
    f.gradeAnalise = f.grade && VbMxGrade.gradeDeBpm(f.grade.bpm, f.grade.primeira) ? { bpm: f.grade.bpm, primeira: f.grade.primeira } : null; // base do RESET e do AUTO grid
    const v = gradeLer(f);
    if (v && v.apagada) { f.grade = null; f.gradeTravada = !!v.travada; }
    else if (v) { f.grade = { bpm: v.bpm, primeira: v.primeira }; f.gradeTravada = !!v.travada; }
  }
  function gradeFaixaDoDeck(letra) { return typeof decks !== 'undefined' && decks[letra] ? decks[letra].faixa : null; }

  function gradeMudar(letra, nova) {
    const f = gradeFaixaDoDeck(letra);
    if (!f || f.gradeTravada || !nova) return;
    f.grade = nova;
    gradeGravar(f, nova, f.gradeTravada);
    gradeDesenharSlot(letra);
    if (typeof pintarPosicao === 'function') { try { pintarPosicao(letra); } catch (_) { /* repinta no próximo quadro */ } }
    VbMxUI.emitir('grade:mudou', { letra, faixa: f, grade: nova });
  }
  // Toques do TAP por deck (tempo do relógio, em s); o BPM só entra após a 4ª batida.
  const gradeTaps = {};
  const gradePosicao = (letra) => { try { return VbMxTocador.posicao(letra) || 0; } catch (_) { return 0; } };
  const gradeBase = (letra) => { const f = gradeFaixaDoDeck(letra); return f ? efetiva(f) : null; };
  function gradeAcao(letra, acao) {
    const g = gradeBase(letra), f = gradeFaixaDoDeck(letra), b = B();
    if (!g || !f || !b) return;
    if (acao === 'tick') { if (typeof tickAlternar === 'function') tickAlternar(letra); gradeDesenharSlot(letra); return; }
    if (acao === 'travar') {
      f.gradeTravada = !f.gradeTravada;
      gradeGravar(f, g, f.gradeTravada);
      gradeDesenharSlot(letra); return;
    }
    if (f.gradeTravada) return; // travar bloqueia toda ação de edição
    const um = { bpm: g.bpm, primeira: g.primeira };
    const G = VbMxGrade;
    if (acao === 'tap') {
      gradeTaps[letra] = G.tap(gradeTaps[letra], performance.now() / 1000);
      const bpm = gradeTaps[letra].bpm;
      if (bpm) gradeMudar(letra, G.comBpm(um, bpm)); else gradeDesenharSlot(letra);
      return;
    }
    if (acao === 'reset') { const n = G.recalcular(f.gradeAnalise); if (n) gradeMudar(letra, { bpm: n.bpm, primeira: n.primeira }); return; }
    if (acao === 'auto') { const n = G.autoGrid(f.gradeAnalise, g, gradePosicao(letra)); if (n) gradeMudar(letra, { bpm: n.bpm, primeira: n.primeira }); return; }
    if (acao === 'bpm+' || acao === 'bpm-') { const n = G.passoBpm(um, acao === 'bpm+' ? G.PASSO_BPM : -G.PASSO_BPM); gradeMudar(letra, n); return; }
    if (acao === 'definir') { const n = G.marcadorEm(um, gradePosicao(letra)); gradeMudar(letra, { bpm: n.bpm, primeira: n.primeira }); return; }
    if (acao === 'apagar') {
      f.grade = null; gradeGravar(f, null, f.gradeTravada); gradeDesenharSlot(letra);
      if (typeof pintarPosicao === 'function') { try { pintarPosicao(letra); } catch (_) { /* repinta depois */ } }
      VbMxUI.emitir('grade:mudou', { letra, faixa: f, grade: null }); return;
    }
    if (acao === 'menos') gradeMudar(letra, b.moverGrade(um, -PASSO_S));
    else if (acao === 'mais') gradeMudar(letra, b.moverGrade(um, PASSO_S));
    else if (acao === 'dobro') gradeMudar(letra, b.escalarGrade(um, 2));
    else if (acao === 'metade') gradeMudar(letra, b.escalarGrade(um, 0.5));
    else if (acao === 'cue') { const d = decks[letra]; gradeMudar(letra, b.moverGrade(um, (d.cue || 0) - g.primeira)); }
  }

  // Duplo clique no BPM: troca o texto por um campo; Enter aplica (BPM > 0), Esc cancela.
  function gradeDigitarBpm(letra, info) {
    const f = gradeFaixaDoDeck(letra), g = gradeBase(letra);
    if (!f || f.gradeTravada || !g) return;
    const campo = document.createElement('input');
    campo.type = 'text'; campo.inputMode = 'decimal'; campo.value = String(g.bpm); campo.setAttribute('aria-label', 'BPM da grade'); campo.style.width = '7ch';
    info.replaceWith(campo); campo.focus(); campo.select();
    let feito = false;
    const fim = (aplicar) => {
      if (feito) return; feito = true;
      const v = parseFloat(String(campo.value).replace(',', '.'));
      if (aplicar && v > 0 && Number.isFinite(v)) gradeMudar(letra, VbMxGrade.comBpm({ bpm: g.bpm, primeira: g.primeira }, v)); else gradeDesenharSlot(letra);
    };
    campo.addEventListener('keydown', (e) => { if (e.key === 'Enter') fim(true); else if (e.key === 'Escape') fim(false); });
    campo.addEventListener('blur', () => fim(false));
  }

  function gradeDesenharSlot(letra) {
    const el = VbMxUI.slot('deck-' + letra + '-grade');
    if (!el) return;
    const f = gradeFaixaDoDeck(letra);
    if (!f) { el.hidden = true; el.style.cssText = ''; el.innerHTML = ''; return; }
    const g = efetiva(f);
    if (!g) { el.hidden = true; el.style.cssText = ''; el.innerHTML = ''; return; }
    const analisada = !!(f.grade && f.grade.bpm > 0), trava = !!f.gradeTravada, off = trava ? ' disabled' : '';
    el.hidden = false;
    el.style.cssText = 'grid-column:' + (letra === 'A' ? 1 : 3) + ';font-size:12px;padding:6px 8px;border:1px solid var(--linha);border-radius:4px;display:flex;flex-wrap:wrap;gap:6px;align-items:center';
    el.innerHTML = `<span class="rotulo">GRADE ${letra}</span>`
      + `<span class="mono" data-grade-info="${letra}" title="${analisada ? 'grade da análise (ou ajustada por você)' : 'estimada pelo BPM, com a 1ª batida em 0: a faixa não tem grade analisada'}">${g.bpm.toFixed(2)} BPM · 1ª batida ${g.primeira.toFixed(3)} s${analisada ? '' : ' · estimada'}</span>`
      + ['menos|◀ 10 ms|mover a grade 10 ms para trás', 'mais|10 ms ▶|mover a grade 10 ms para frente', 'dobro|×2|dobrar o BPM da grade', 'metade|÷2|metade do BPM da grade', 'cue|⚓ CUE|ancorar a 1ª batida no CUE do deck', 'bpm-|−0,01|diminuir o BPM da grade em 0,01', 'bpm+|+0,01|aumentar o BPM da grade em 0,01', 'tap|TAP|bata no ritmo: o BPM vale após a 4ª batida', 'reset|RESET|recalcular: volta à grade da análise', 'auto|AUTO|AUTO grid: marcador perto da posição atual (só faixa analisada)', 'definir|definir marcador|definir o marcador de grade na posição atual', 'apagar|apagar marcador|apagar o marcador de grade']
        .map((s) => { const [a, r, t] = s.split('|'); const sem = (a === 'reset' || a === 'auto') && !f.gradeAnalise; return `<button type="button" class="botao" data-grade-acao="${a}"${off || (sem ? ' disabled' : '')} title="${t}">${r}</button>`; }).join('')
      + `<button type="button" class="botao${typeof tickLigado === 'function' && tickLigado(letra) ? ' tocando' : ''}" data-grade-acao="tick" aria-pressed="${typeof tickLigado === 'function' && tickLigado(letra)}" title="tick: ouvir as batidas da grade para conferir o alinhamento (por enquanto soa no master: o fone é o VB-23)">TICK</button>`
      + `<button type="button" class="botao${trava ? ' tocando' : ''}" data-grade-acao="travar" aria-pressed="${trava}" title="travar: protege a grade de ajustes sem querer">${trava ? 'travada' : 'travar'}</button>`;
    const info = el.querySelector('[data-grade-info]');
    if (info && !trava) info.addEventListener('dblclick', () => gradeDigitarBpm(letra, info)); // BPM digitado
    el.querySelectorAll('[data-grade-acao]').forEach((b) => b.addEventListener('click', () => gradeAcao(letra, b.dataset.gradeAcao)));
  }

  // Linhas de batida por cima da onda: janela.x(t) dá a coluna; só as visíveis; no stripe da faixa
  // inteira pula as linhas se ficariam coladas (< 3 px) — fica só o 1 de cada compasso.
  VbMxUI.registrar('camada-onda', (c, deck, janela) => {
    const f = deck.d && deck.d.faixa, g = efetiva(f);
    if (!g || !deck.d.picos) return;
    const dpr = c.dpr || 1, lw = Math.max(1, Math.round(dpr));
    const passoPx = Math.abs(janela.x(g.periodo) - janela.x(0));
    const so1 = passoPx < 3 * dpr;
    if (passoPx * g.porCompasso < 3 * dpr) return;
    for (const t of VbMxGrade.batidasEntre(g, janela.inicio, janela.fim)) {
      const forte = VbMxGrade.compasso(g, t + 1e-6).batida === 1;
      if (so1 && !forte) continue;
      const x = Math.round(janela.x(t));
      c.g.fillStyle = forte ? 'rgba(230,232,236,.55)' : 'rgba(230,232,236,.2)';
      c.g.fillRect(x - Math.floor(lw / 2), forte ? 0 : Math.round(c.h * 0.3), lw, forte ? c.h : Math.round(c.h * 0.4));
    }
  });

  // "Grade + cue": a 1ª batida da grade analisada vira o cue inicial se a faixa ainda não tem cue. Espera o
  // hotcues terminar de ler o cue guardado (senão apagaria o do disco); não mexe em grade travada.
  function gradeCueInicial(letra, faixa, tentativa) {
    const d = decks[letra];
    if (!d || d.faixa !== faixa || !d.buffer || !faixa.grade) return;
    if (typeof hotcuesPronto === 'function' && !hotcuesPronto(letra)) {
      if (tentativa < 30) setTimeout(() => gradeCueInicial(letra, faixa, tentativa + 1), 100);
      return;
    }
    const c = VbMxGrade.cueInicial(VbMxGrade.daFaixa(faixa, 0), d.buffer.duration, d.cue);
    if (c === null || faixa.gradeTravada) return;
    d.cue = c; if (typeof guardarCue === 'function') guardarCue(d);
    if (typeof tocandoDeck === 'function' && !tocandoDeck(letra)) VbMxTocador.buscar(letra, c);
    VbMxUI.emitir('deck:cue', { letra, faixa, cue: c });
  }

  VbMxUI.aoIniciar(() => {
    for (const l of ['A', 'B']) gradeDesenharSlot(l);
    VbMxUI.ouvir('deck:carregado', (e) => { gradeAplicar(e.faixa); gradeDesenharSlot(e.letra); gradeCueInicial(e.letra, e.faixa, 0); });
    VbMxUI.ouvir('deck:descarregado', (e) => gradeDesenharSlot(e.letra));
    VbMxUI.ouvir('biblioteca:mudou', () => { for (const l of ['A', 'B']) gradeDesenharSlot(l); });
  });
})();
