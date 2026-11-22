// movel.js — versão móbile do Profissional (celular deitado: decks e mixer na mesma tela, sem rolar).
// Só decide e marca: a disposição é toda de css/movel.css, sob `html.movel`; áudio, decks e mixer são os mesmos do desktop.
//   detecção   ponteiro grosso (toque) E lado curto da tela ≤ 540 px (celular; tablet fica no desktop)
//   forçar     ?mobile=1 liga, ?desktop=1 desliga (vale para a aba: fica em sessionStorage), ?mobile=auto esquece a escolha
//   stems      na versão móbile a preferência "separar ao carregar" nasce DESLIGADA (js/stems-carga.js pergunta VbMxMovel.ativo):
//              o modelo do Sidra (~86 MB) só baixa se o usuário tocar em STEMS na aba Stems
//   abas       o painel de baixo de cada deck mostra uma coisa por vez: pads (hot cues) · loop · EQ · stems (html[data-movel-aba])
//   retrato    aviso "gire o celular" (css) em vez de espremer a mesa
// Textos: chaves pro.movel.* em js/i18n/*.js. Portão: node interface/testar-movel.js.
(function (raiz) {
  'use strict';
  const CHAVE = 'vbmx-movel-forca', ABAS = ['pads', 'loop', 'eq', 'stems'];

  // pura (testada em Node): busca = location.search; guardado = valor da aba; toque = pointer: coarse; ladoCurto em px
  function decidir(busca, guardado, toque, ladoCurto) {
    const q = new URLSearchParams(busca || '');
    let forca = guardado === 'movel' || guardado === 'desktop' ? guardado : null;
    if (q.get('mobile') === 'auto' || q.get('desktop') === 'auto') forca = null;
    if (q.get('mobile') === '1') forca = 'movel';
    if (q.get('desktop') === '1') forca = 'desktop';
    const auto = !!toque && ladoCurto > 0 && ladoCurto <= 540;
    return { ativo: forca ? forca === 'movel' : auto, forca, auto };
  }

  const api = { ativo: false, forca: null, auto: false, decidir, ABAS };
  raiz.VbMxMovel = api;
  if (typeof document === 'undefined' || !raiz.location) { if (typeof module !== 'undefined' && module.exports) module.exports = api; return; }

  let guardado = null;
  try { guardado = raiz.sessionStorage.getItem(CHAVE); } catch (_) {}
  const tela = raiz.screen || {};
  const d = decidir(raiz.location.search, guardado, raiz.matchMedia && raiz.matchMedia('(pointer: coarse)').matches,
    Math.min(tela.width || raiz.innerWidth, tela.height || raiz.innerHeight));
  Object.assign(api, d);
  try { d.forca ? raiz.sessionStorage.setItem(CHAVE, d.forca) : raiz.sessionStorage.removeItem(CHAVE); } catch (_) {}
  if (!d.ativo) return;

  const html = document.documentElement;
  html.classList.add('movel');
  html.dataset.movelAba = 'pads';
  // css/tela-cheia.css é a mesa de janela larga (≥901 px, cheia de !important): celular grande deitado passa de 901 px, então ela sai
  const larga = document.querySelector('link[href$="css/tela-cheia.css"]');
  if (larga) larga.disabled = true;

  function montar() {
    const t = raiz.VbMxUI.t, topo = document.querySelector('.topo');
    if (!topo) return;
    let barra = topo.querySelector('.movel-barra'), aviso = document.querySelector('.movel-gire');
    if (!barra) { barra = document.createElement('div'); barra.className = 'movel-barra'; topo.insertBefore(barra, topo.children[1] || null); }
    if (!aviso) { aviso = document.createElement('div'); aviso.className = 'movel-gire'; aviso.setAttribute('role', 'status'); document.body.appendChild(aviso); }
    const aba = html.dataset.movelAba, bib = html.classList.contains('movel-biblio'), menu = html.classList.contains('movel-menu');
    const ROTULO = { pads: t('pro.movel.aba-pads'), loop: t('pro.movel.aba-loop'), eq: t('pro.movel.aba-eq'), stems: t('pro.movel.aba-stems') };
    barra.innerHTML = `<button type="button" class="movel-bt" data-movel="biblio" aria-pressed="${bib}">${t('pro.movel.biblioteca')}</button>
      <span class="movel-abas" role="group" aria-label="${t('pro.movel.abas-aria')}">${ABAS.map(a =>
        `<button type="button" class="movel-bt" data-movel-aba-bt="${a}" aria-pressed="${a === aba}">${ROTULO[a]}</button>`).join('')}</span>
      <button type="button" class="movel-bt movel-menu-bt" data-movel="menu" aria-pressed="${menu}" aria-label="${t('pro.movel.menu')}">⋯</button>
      <a class="movel-bt movel-desktop" href="?desktop=1">${t('pro.movel.desktop')}</a>`;
    aviso.innerHTML = `<span class="movel-gire-icone" aria-hidden="true">⟳</span><span>${t('pro.movel.gire')}</span>`;
  }
  function alternar(classe, liga) {
    const v = liga === undefined ? !html.classList.contains(classe) : liga;
    html.classList.toggle(classe, v);
    if (v) html.classList.remove(classe === 'movel-biblio' ? 'movel-menu' : 'movel-biblio');
    montar();
  }

  raiz.VbMxUI.aoIniciar(() => {
    montar();
    raiz.VbMxUI.aoIdioma(montar);
    document.addEventListener('click', (e) => {
      const a = e.target.closest('[data-movel-aba-bt]');
      if (a) { html.dataset.movelAba = a.dataset.movelAbaBt; alternar('movel-biblio', false); return; }
      const b = e.target.closest('[data-movel]');
      if (b) { alternar(b.dataset.movel === 'biblio' ? 'movel-biblio' : 'movel-menu'); return; }
      if (e.target.closest('.browser [data-carregar]')) alternar('movel-biblio', false);   // escolheu o deck: a gaveta fecha e a mesa volta
    });
    // a onda e o crossfader têm a largura da janela: girar o aparelho refaz as medidas
    raiz.addEventListener('orientationchange', () => raiz.dispatchEvent(new Event('resize')));
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
