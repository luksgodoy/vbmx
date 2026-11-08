// ===================== saidas.js — saídas e fone: slot mixer-fone; VbMxCadeia.derivar("pre-fader", letra) =====================
// Dono: VB-23. Fone/PFL (spec §7, Cue/fone): botão de cue por canal (no mixer, js/mixer.js), VOL do fone e MIX
// (esquerda = faixa em cue, direita = mixagem principal). Precisa de uma saída com 4+ canais (master em 1/2,
// fone em 3/4): detecta por destination.maxChannelCount e, quando o navegador deixa (AudioContext.setSinkId),
// oferece escolher a saída. Sem 4 canais o fone fica desabilitado e a tela diz por quê; "fone à esquerda, master
// à direita" é uma opção explícita. A lógica (MIX, VOL, plano de canais) é de motor/fone.js; o grafo, de
// VbMxCadeia.rotearSaida/aplicarFone. Aqui ficam a detecção, a escolha da saída e a tela.
// UMD só para o Node testar a parte sem DOM (interface/testar-saidas.js); a tela entra em VbMxUI.aoIniciar.
(function (raiz, fabrica) {
  const api = fabrica(raiz);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.VbMxSaidas = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (raiz) {
  'use strict';
  const F = raiz.VbMxFone || (typeof require === 'function' ? require('../../motor/fone.js') : null);
  const estado = F.estadoPadrao();

  // O que a saída atual do contexto oferece.
  // (o destino em si é de js/cadeia.js: ela devolve o destination.maxChannelCount).
  function detectar(ctx, cadeia) {
    return { maxCanais: (cadeia && Number(cadeia.maxCanaisDaSaida())) || 2, podeEscolher: !!(ctx && typeof ctx.setSinkId === 'function') };
  }
  // Detecta, monta o plano, liga a cadeia e aplica os ganhos. Devolve o plano (modo, motivo, ligações).
  function rotear(ctx, cadeia, fone) {
    const e = fone || estado;
    const plano = F.planoSaida(detectar(ctx, cadeia).maxCanais, e.saida);
    cadeia.rotearSaida(plano);
    cadeia.aplicarFone(F.ganhosDoFone(e));
    return plano;
  }
  // Saídas de áudio do sistema (os rótulos só vêm depois de o usuário dar permissão de mídia).
  async function listarSaidas(navegador) {
    const md = navegador && navegador.mediaDevices;
    if (!md || typeof md.enumerateDevices !== 'function') return [];
    const todos = await md.enumerateDevices();
    return todos.filter(d => d.kind === 'audiooutput').map((d, i) => ({ id: d.deviceId, rotulo: d.label || `Saída ${i + 1}` }));
  }
  async function escolherSaida(ctx, id) {
    if (!ctx || typeof ctx.setSinkId !== 'function') throw new Error('VbMxSaidas: este navegador não deixa escolher a saída (setSinkId)');
    await ctx.setSinkId(id || '');
  }
  const api = { estado, detectar, rotear, listarSaidas, escolherSaida };

  // ---------------- tela e ligação com a página (só no navegador) ----------------
  const UI = raiz.VbMxUI, Prefs = raiz.VbMxPrefs;
  if (!UI || !Prefs || !raiz.document) return api;

  Prefs.declarar('saidas.fone-modo', 'auto', { rotulo: 'Saída do fone', tipo: 'opcao', modulo: 'saidas',
    opcoes: [{ valor: 'auto', rotulo: 'Saídas 3/4 (precisa de interface com 4+ canais)' }, { valor: 'dividido', rotulo: 'Fone à esquerda, master à direita' }] });
  Prefs.declarar('saidas.fone-vol', estado.vol, { rotulo: 'Volume do fone', tipo: 'numero', min: 0, max: 100, modulo: 'saidas' });
  Prefs.declarar('saidas.fone-mix', estado.mix, { rotulo: 'Mix do fone (−100 cue … +100 principal)', tipo: 'numero', min: -100, max: 100, modulo: 'saidas' });
  Prefs.declarar('saidas.destino', '', { rotulo: 'Dispositivo de saída (id; vazio = padrão do sistema)', tipo: 'texto', modulo: 'saidas' });
  UI.declararEvento('fone:mudou');   // {fone, plano}
  estado.saida = Prefs.ler('saidas.fone-modo'); estado.vol = Prefs.ler('saidas.fone-vol'); estado.mix = Prefs.ler('saidas.fone-mix');

  let plano = null, ctxLigado = null, aplicandoDestino = false, dispositivos = [];
  const tela = () => UI.slot('mixer-fone');
  const ctxAtual = () => (typeof ctxAudio !== 'undefined' ? ctxAudio : null);
  const habilitado = () => !!plano && plano.modo !== 'desligado';

  function sincronizar() {
    const s = tela(), mix = document.getElementById('mixer');
    if (mix) for (const bt of mix.querySelectorAll('button[data-cue]')) {
      const on = !!estado.cue[bt.dataset.cue];
      bt.setAttribute('aria-pressed', String(on)); bt.classList.toggle('ligado', on);
      bt.setAttribute('aria-disabled', String(!!plano && !habilitado()));
      bt.title = plano && !habilitado() ? plano.motivo : 'Cue: ouve este canal no fone (antes do fader)';
    }
    if (!s) return;
    const poe = (id, v) => { const el = s.querySelector('#' + id); if (el && String(el.value) !== String(v)) el.value = v; if (el && el._peca) el._peca.definir(v, { silencioso: true }); const t = s.querySelector('#' + id + '-v'); if (t) t.textContent = v; };
    poe('fone-vol', estado.vol); poe('fone-mix', estado.mix);
    const div = s.querySelector('#fone-dividido'); if (div) div.checked = estado.saida === 'dividido';
    const msg = s.querySelector('#fone-estado');
    if (msg) {
      msg.textContent = plano ? plano.motivo : 'A saída é detectada quando o áudio ligar (ao carregar ou tocar uma faixa).';
      msg.classList.toggle('aviso', !!plano && !habilitado());
    }
    s.classList.toggle('desabilitado', !!plano && !habilitado());
    for (const el of s.querySelectorAll('#fone-vol, #fone-mix')) el.disabled = !!plano && !habilitado();
    const sel = s.querySelector('#fone-destino');
    if (sel) sel.hidden = !(ctxLigado && detectar(ctxLigado, VbMxCadeia).podeEscolher);
  }
  // Roteia assim que a cadeia existe (o contexto só nasce no primeiro gesto) e a cada mudança de saída.
  function tentarRotear() {
    const c = ctxAtual();
    if (!c || !raiz.VbMxCadeia || !VbMxCadeia.montada()) { sincronizar(); return null; }
    ctxLigado = c;
    plano = rotear(c, VbMxCadeia, estado);
    sincronizar();
    UI.emitir('fone:mudou', { fone: estado, plano });
    return plano;
  }
  function aplicarGanhos() {
    const c = ctxAtual();
    if (c && VbMxCadeia.montada()) VbMxCadeia.aplicarFone(F.ganhosDoFone(estado));
    sincronizar();
    UI.emitir('fone:mudou', { fone: estado, plano });
  }
  function alternarCue(letra) {
    if (typeof garantirAudio === 'function') garantirAudio();   // o clique é o gesto que libera o áudio
    if (!plano) tentarRotear();
    if (plano && !habilitado()) { sincronizar(); return; }      // sem saída extra: o botão não faz nada, a tela explica
    Object.assign(estado, F.alternarCue(estado, letra));
    aplicarGanhos();
  }
  function definirVol(v) { estado.vol = F.travar('vol', v); Prefs.gravar('saidas.fone-vol', estado.vol); aplicarGanhos(); }
  function definirMix(v) { estado.mix = F.travar('mix', v); Prefs.gravar('saidas.fone-mix', estado.mix); aplicarGanhos(); }
  function definirModo(m) { estado.saida = F.MODOS_SAIDA.includes(m) ? m : 'auto'; Prefs.gravar('saidas.fone-modo', estado.saida); tentarRotear(); }

  async function atualizarDispositivos() {
    const sel = tela() && tela().querySelector('#fone-destino');
    if (!sel) return;
    try { dispositivos = await listarSaidas(raiz.navigator); } catch (_) { dispositivos = []; }
    const atual = Prefs.ler('saidas.destino');
    sel.innerHTML = '<option value="">Padrão do sistema</option>' + dispositivos.filter(d => d.id && d.id !== 'default')
      .map(d => `<option value="${String(d.id).replace(/"/g, '&quot;')}">${d.rotulo.replace(/[<&]/g, '')}</option>`).join('');
    sel.value = atual;
  }
  async function trocarDestino(id) {
    const c = ctxAtual();
    Prefs.gravar('saidas.destino', id);
    if (!c || aplicandoDestino) return;
    aplicandoDestino = true;
    try { await escolherSaida(c, id); } catch (e) { if (raiz.console) raiz.console.error('VbMxSaidas: setSinkId falhou:', e); }
    aplicandoDestino = false;
    tentarRotear();   // maxChannelCount é o da nova saída
  }

  UI.aoIniciar(() => {
    const s = tela(), mix = document.getElementById('mixer');
    if (s) {
      s.classList.add('fone');
      s.setAttribute('aria-label', 'Fone (cue)');
      s.innerHTML = `<span class="nome">FONE</span>
        <div class="linha-mx"><label class="nome" for="fone-vol">VOL</label>
          <input type="range" id="fone-vol" min="0" max="100" step="1" value="${estado.vol}" aria-label="Volume do fone, de 0 a 100">
          <span class="val mono" id="fone-vol-v">${estado.vol}</span></div>
        <div class="linha-mx"><label class="nome" for="fone-mix">MIX</label>
          <input type="range" id="fone-mix" min="-100" max="100" step="1" value="${estado.mix}" aria-label="Mix do fone: à esquerda a faixa em cue, à direita a mixagem principal; duplo clique centraliza">
          <span class="val mono" id="fone-mix-v">${estado.mix}</span></div>
        <div class="fone-rotulos"><span>cue</span><span>principal</span></div>
        <label class="check"><input type="checkbox" id="fone-dividido"> fone à esquerda, master à direita (mono)</label>
        <select id="fone-destino" aria-label="Saída de áudio" hidden></select>
        <p id="fone-estado" role="status"></p>`;
      s.querySelector('#fone-vol').addEventListener('input', e => definirVol(e.target.value));
      s.querySelector('#fone-mix').addEventListener('input', e => definirMix(e.target.value));
      s.querySelector('#fone-mix').addEventListener('dblclick', () => definirMix(0));
      if (typeof VbMxPecas !== 'undefined') {   // pele por cima, input por baixo (proposta B)
        VbMxPecas.vestir(s.querySelector('#fone-vol'), { fabrica: 'fader', tipo: 'canal', orientacao: 'horizontal', tamanho: 'compacto', comprimento: 120, marcas: 5 });
        VbMxPecas.vestir(s.querySelector('#fone-mix'), { fabrica: 'fader', tipo: 'cross', orientacao: 'horizontal', tamanho: 'compacto', comprimento: 120, padrao: 0, marcas: 5 });
      }
      s.querySelector('#fone-dividido').addEventListener('change', e => definirModo(e.target.checked ? 'dividido' : 'auto'));
      s.querySelector('#fone-destino').addEventListener('change', e => trocarDestino(e.target.value));
      if (mix) mix.appendChild(s);
      s.hidden = false;
      atualizarDispositivos();
    }
    // os botões de cue são do mixer (js/mixer.js, que reescreve o innerHTML): clique delegado, sobrevive à releitura
    if (mix) mix.addEventListener('click', e => { const bt = e.target.closest && e.target.closest('button[data-cue]'); if (bt) alternarCue(bt.dataset.cue); });
    tentarRotear();
  });
  // a cadeia nasce no 1º gesto: tenta ligar o fone quando algo mexe; mixer:mudou também refaz os botões após releitura
  for (const ev of ['deck:carregado', 'deck:tocou']) UI.ouvir(ev, () => { if (!plano) tentarRotear(); });
  UI.ouvir('mixer:mudou', sincronizar);
  UI.registrar('acao', 'foneA.cue', () => alternarCue('A'));
  UI.registrar('acao', 'foneB.cue', () => alternarCue('B'));
  UI.registrar('acao', 'fone.vol', v => definirVol(v));
  UI.registrar('acao', 'fone.mix', v => definirMix(v));
  api.alternarCue = alternarCue; api.definirVol = definirVol; api.definirMix = definirMix; api.definirModo = definirModo;
  return api;
});
