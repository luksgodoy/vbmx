// VbMx — internacionalização (decisão a confirmar de 2026-11-14, docs/decisoes.md). JS puro, sem biblioteca e sem build.
// Contrato: docs/contratos.md § VbMxI18n. Teste: node interface/testar-i18n.js.
//
// Idiomas: en (padrão e reserva), pt-BR, es, fr. Os dicionários moram em interface/js/i18n/<idioma>.js, um objeto plano
// {chave: texto}; no navegador cada arquivo se registra aqui (<script> depois deste), no Node o módulo os lê por require.
// Texto com número: chave.one / chave.other (Intl.PluralRules); parâmetros {nome}. Faltou a chave no idioma → en → a própria chave.
//
// No HTML: data-i18n (texto), data-i18n-aria (aria-label), data-i18n-title (title), data-i18n-placeholder,
// data-i18n-attr="atributo:chave" e data-i18n-params='{"n":4}'. O texto escrito no HTML é o pt-BR histórico; a troca para o inglês (padrão) roda ao carregar.
// Idioma inicial: escolha salva (localStorage, em try/catch) > en. O idioma do navegador NÃO decide (decisão de 22/11/2026: o site abre em inglês).
(function (raiz, fabrica) {
  const api = fabrica(raiz);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.VbMxI18n = api;
  if (typeof document !== 'undefined' && document.addEventListener) {
    const pronto = () => api.iniciar(document);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', pronto); else pronto();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (raiz) {
  'use strict';

  const IDIOMAS = [
    { codigo: 'pt-BR', curto: 'PT', nome: 'Português' },
    { codigo: 'en', curto: 'EN', nome: 'English' },
    { codigo: 'es', curto: 'ES', nome: 'Español' },
    { codigo: 'fr', curto: 'FR', nome: 'Français' },
  ];
  const PADRAO = 'en';
  const CHAVE = 'vbmx-idioma';
  const dicionarios = {};
  const valido = (c) => IDIOMAS.some((i) => i.codigo === c);
  function registrar(codigo, dic) { if (!valido(codigo)) throw new TypeError(`idioma desconhecido: ${codigo}`); dicionarios[codigo] = dic; }
  if (typeof module === 'object' && module.exports && typeof require === 'function') {
    for (const [c, arq] of [['pt-BR', 'pt'], ['en', 'en'], ['es', 'es'], ['fr', 'fr']]) registrar(c, require('./i18n/' + arq + '.js'));
  }

  // 'pt', 'pt-PT', 'en-GB', 'fr-CA'… → um dos quatro; outro idioma → null
  function paraSuportado(tag) {
    const p = String(tag || '').toLowerCase().split(/[-_]/)[0];
    const i = IDIOMAS.find((x) => x.codigo.toLowerCase().split('-')[0] === p);
    return i ? i.codigo : null;
  }
  // escolha salva > en. O parâmetro navegador fica na assinatura por compatibilidade e é ignorado de propósito.
  function idiomaInicial(armazem) {
    try { const s = armazem && armazem.getItem(CHAVE); if (valido(s)) return s; } catch (e) { /* localStorage bloqueado: segue */ }
    return PADRAO;
  }

  function criar(opcoes) {
    const o = opcoes || {};
    const armazem = o.armazem === undefined ? (() => { try { return raiz.localStorage || null; } catch (e) { return null; } })() : o.armazem;
    let atual = idiomaInicial(armazem);
    const ouvintes = [];

    const dic = () => dicionarios[atual] || {};
    function achar(chave, n) {
      const regras = [dic(), dicionarios[PADRAO] || {}];
      let sufixo = '';
      if (typeof n === 'number' && Number.isFinite(n)) {
        let cat = 'other';
        try { cat = new Intl.PluralRules(atual).select(n); } catch (e) { cat = n === 1 ? 'one' : 'other'; }
        sufixo = cat;
      }
      for (const d of regras) {
        if (sufixo && d[chave + '.' + sufixo] !== undefined) return d[chave + '.' + sufixo];
        if (typeof n === 'number' && d[chave + '.other'] !== undefined) return d[chave + '.other'];
        if (d[chave] !== undefined) return d[chave];
      }
      return chave;
    }
    function t(chave, params) {
      const p = params || {};
      return String(achar(chave, p.n)).replace(/\{(\w+)\}/g, (m, k) => (p[k] === undefined || p[k] === null ? m : String(p[k])));
    }

    // formatação pelo idioma (Intl): número com vírgula ou ponto, tempo m:ss, BPM
    const numero = (v, casas) => {
      if (!Number.isFinite(v)) return '—';
      const c = casas === undefined ? 1 : casas;
      return new Intl.NumberFormat(atual, { minimumFractionDigits: 0, maximumFractionDigits: c, useGrouping: false }).format(v);
    };
    const tempo = (s) => {
      if (!(s >= 0)) return '—';
      const m = Math.floor(s / 60), r = Math.floor(s % 60);
      return `${new Intl.NumberFormat(atual, { useGrouping: false }).format(m)}:${new Intl.NumberFormat(atual, { minimumIntegerDigits: 2, useGrouping: false }).format(r)}`;
    };
    const bpm = (v) => `${numero(v, 1)} BPM`;
    const comparar = (a, b) => String(a).localeCompare(String(b), atual);

    function aplicar(raizDom) {
      const r = raizDom || (typeof document !== 'undefined' ? document : null);
      if (!r || !r.querySelectorAll) return;
      const params = (el) => { try { return JSON.parse(el.getAttribute('data-i18n-params') || '{}'); } catch (e) { return {}; } };
      for (const el of r.querySelectorAll('[data-i18n]')) el.textContent = t(el.getAttribute('data-i18n'), params(el));
      for (const [attr, alvo] of [['data-i18n-aria', 'aria-label'], ['data-i18n-title', 'title'], ['data-i18n-placeholder', 'placeholder']]) {
        for (const el of r.querySelectorAll(`[${attr}]`)) el.setAttribute(alvo, t(el.getAttribute(attr), params(el)));
      }
      for (const el of r.querySelectorAll('[data-i18n-attr]')) {
        const [a, ...resto] = el.getAttribute('data-i18n-attr').split(':');
        if (a && resto.length) el.setAttribute(a, t(resto.join(':'), params(el)));
      }
      for (const b of r.querySelectorAll('[data-lang]')) b.setAttribute('aria-checked', b.getAttribute('data-lang') === atual ? 'true' : 'false');
    }

    function definir(codigo, aplicarNoDom) {
      const c = valido(codigo) ? codigo : PADRAO;
      atual = c;
      try { if (armazem) armazem.setItem(CHAVE, c); } catch (e) { /* sem armazenamento: vale só nesta sessão */ }
      if (typeof document !== 'undefined' && document.documentElement && aplicarNoDom !== false) document.documentElement.lang = c;
      if (aplicarNoDom !== false) aplicar();
      for (const f of ouvintes.slice()) { try { f(c); } catch (e) { /* um ouvinte quebrado não derruba a troca */ } }
      return c;
    }
    const aoMudar = (f) => { if (typeof f === 'function') ouvintes.push(f); };

    // seletor PT | EN | ES | FR: radiogroup com tabindex móvel e setas
    function montarSeletor(el, doc) {
      const d = doc || (typeof document !== 'undefined' ? document : null);
      if (!el || !d || el.dataset.montado) return;
      el.dataset.montado = '1';
      el.setAttribute('role', 'radiogroup');
      for (const i of IDIOMAS) {
        const b = d.createElement('button');
        b.type = 'button'; b.className = 'idioma-opcao'; b.setAttribute('role', 'radio');
        b.setAttribute('data-lang', i.codigo); b.setAttribute('lang', i.codigo); b.setAttribute('aria-label', i.nome); b.title = i.nome;
        b.textContent = i.curto;
        el.appendChild(b);
      }
      const botoes = () => Array.from(el.querySelectorAll('[data-lang]'));
      const marcar = () => botoes().forEach((b) => { const on = b.getAttribute('data-lang') === atual; b.setAttribute('aria-checked', on ? 'true' : 'false'); b.tabIndex = on ? 0 : -1; });
      marcar(); aoMudar(marcar);
      el.addEventListener('click', (ev) => { const b = ev.target.closest && ev.target.closest('[data-lang]'); if (b) definir(b.getAttribute('data-lang')); });
      el.addEventListener('keydown', (ev) => {
        const bs = botoes(), i = bs.findIndex((b) => b.getAttribute('data-lang') === atual);
        let j = -1;
        if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown') j = (i + 1) % bs.length;
        else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp') j = (i - 1 + bs.length) % bs.length;
        else if (ev.key === 'Home') j = 0; else if (ev.key === 'End') j = bs.length - 1;
        if (j < 0) return;
        ev.preventDefault(); definir(bs[j].getAttribute('data-lang')); bs[j].focus();
      });
    }

    function iniciar(doc) {
      const d = doc || document;
      if (d.documentElement) d.documentElement.lang = atual;
      for (const el of d.querySelectorAll('[data-i18n-seletor]')) montarSeletor(el, d);
      aplicar(d);
    }

    return { t, numero, tempo, bpm, comparar, aplicar, definir, aoMudar, montarSeletor, iniciar, idioma: () => atual };
  }

  return Object.assign({ IDIOMAS, PADRAO, CHAVE, dicionarios, registrar, paraSuportado, idiomaInicial, criar }, criar());
});
