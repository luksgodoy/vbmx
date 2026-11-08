// ===================== VbMxPrefs: preferências declaradas pelos módulos (VB-11) =====================
// Cada módulo declara a própria preferência no carregamento; o VB-26 só desenha a tela, lendo
// `declaradas()`. Persiste em localStorage (chave "vbmx-pref:<chave>", JSON), sempre com try/catch:
// sem armazenamento (aba privada, bloqueio) a página segue com o padrão. Contrato: docs/contratos.md.
// Na onda 1 este arquivo é intocável; o VB-26 (onda 2) acrescenta a tela.
//
//   declarar(chave, padrao, {rotulo, tipo, opcoes, min, max, modulo})
//        tipo: "booleano" | "numero" | "texto" | "opcao" (opcoes = [valor…] ou [{valor, rotulo}…])
//        chave com ponto: "<módulo>.<nome>" (ex.: "deck.trava-carga"). Declarar duas vezes é erro.
//   ler(chave)                   valor gravado (se válido) ou o padrão
//   gravar(chave, valor)         valida, grava e avisa quem ouve; valor inválido é erro
//   ouvir(chave, fn(valor))      → fn para desligar
//   declaradas()                 [{chave, padrao, rotulo, tipo, opcoes, min, max, modulo, valor}]
//   exportar()                   {versao: 1, prefs: {chave: valor}} com o valor atual de todas as declaradas
//   importar(obj)                aceita o que exportar() gera (ou só o mapa chave→valor); grava o válido, ignora o
//                                resto e NUNCA lança → {aplicadas: [chave…], ignoradas: [{chave, motivo}…]}
//   restaurarPadroes()           grava o padrão de todas as declaradas
//   usarArmazem(obj | null)      troca o localStorage (testes)
(function (raiz, fabrica) {
  const api = fabrica(raiz);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.VbMxPrefs = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (raiz) {
  'use strict';
  const PREFIXO = 'vbmx-pref:';
  const TIPOS = new Set(['booleano', 'numero', 'texto', 'opcao']);
  const decl = new Map(), ouvintes = new Map(), cache = new Map();
  let armazem;   // undefined = ainda não procurou; null = sem armazenamento

  function obterArmazem() {
    if (armazem === undefined) { try { armazem = raiz.localStorage || null; } catch (_) { armazem = null; } }
    return armazem;
  }
  function usarArmazem(obj) { armazem = obj; cache.clear(); }
  const valorDe = o => (o && typeof o === 'object' && 'valor' in o ? o.valor : o);

  function valido(d, v) {
    if (d.tipo === 'booleano') return typeof v === 'boolean';
    if (d.tipo === 'texto') return typeof v === 'string';
    if (d.tipo === 'numero') return typeof v === 'number' && Number.isFinite(v) && !(d.min != null && v < d.min) && !(d.max != null && v > d.max);
    return d.opcoes.some(o => valorDe(o) === v);
  }
  function declarar(chave, padrao, meta) {
    const m = meta || {};
    if (typeof chave !== 'string' || !/^[a-z0-9-]+\.[a-z0-9.-]+$/.test(chave)) throw new Error(`VbMxPrefs: chave inválida "${chave}" (use módulo.nome)`);
    if (decl.has(chave)) throw new Error(`VbMxPrefs: "${chave}" já declarada`);
    if (!TIPOS.has(m.tipo)) throw new Error(`VbMxPrefs: "${chave}" sem tipo válido (booleano, numero, texto, opcao)`);
    if (m.tipo === 'opcao' && !(Array.isArray(m.opcoes) && m.opcoes.length)) throw new Error(`VbMxPrefs: "${chave}" do tipo opcao precisa de opcoes`);
    const d = { chave, padrao, rotulo: m.rotulo || chave, tipo: m.tipo, opcoes: m.opcoes || null,
      min: m.min ?? null, max: m.max ?? null, modulo: m.modulo || chave.split('.')[0] };
    if (!valido(d, padrao)) throw new Error(`VbMxPrefs: padrão inválido para "${chave}"`);
    decl.set(chave, d);
  }
  function exigir(chave) {
    const d = decl.get(chave);
    if (!d) throw new Error(`VbMxPrefs: "${chave}" não foi declarada`);
    return d;
  }
  function ler(chave) {
    const d = exigir(chave);
    if (cache.has(chave)) return cache.get(chave);
    let v = d.padrao;
    const a = obterArmazem();
    if (a) {
      try { const s = a.getItem(PREFIXO + chave); if (s != null) { const x = JSON.parse(s); if (valido(d, x)) v = x; } } catch (_) { /* fica o padrão */ }
    }
    cache.set(chave, v);
    return v;
  }
  function gravar(chave, valor) {
    const d = exigir(chave);
    if (!valido(d, valor)) throw new Error(`VbMxPrefs: valor inválido para "${chave}": ${JSON.stringify(valor)}`);
    cache.set(chave, valor);
    const a = obterArmazem();
    if (a) { try { a.setItem(PREFIXO + chave, JSON.stringify(valor)); } catch (_) { /* vale nesta sessão */ } }
    for (const fn of [...(ouvintes.get(chave) || [])]) {
      try { fn(valor); } catch (e) { if (raiz.console) raiz.console.error(`VbMxPrefs: ouvinte de ${chave} falhou:`, e); }
    }
  }
  function ouvir(chave, fn) {
    exigir(chave);
    if (!ouvintes.has(chave)) ouvintes.set(chave, []);
    ouvintes.get(chave).push(fn);
    return () => { const l = ouvintes.get(chave); const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); };
  }
  function declaradas() { return [...decl.values()].map(d => ({ ...d, valor: ler(d.chave) })); }

  function exportar() {
    const prefs = {};
    for (const d of decl.values()) prefs[d.chave] = ler(d.chave);
    return { versao: 1, prefs };
  }
  function importar(obj) {
    const r = { aplicadas: [], ignoradas: [] };
    const mapa = obj && typeof obj === 'object' && !Array.isArray(obj) ? (obj.prefs && typeof obj.prefs === 'object' && !Array.isArray(obj.prefs) ? obj.prefs : obj) : null;
    if (!mapa) { r.ignoradas.push({ chave: '(raiz)', motivo: 'não é um objeto' }); return r; }
    for (const chave of Object.keys(mapa)) {
      if (chave === 'versao' && mapa === obj) continue;
      const d = decl.get(chave);
      if (!d) { r.ignoradas.push({ chave, motivo: 'preferência desconhecida' }); continue; }
      if (!valido(d, mapa[chave])) { r.ignoradas.push({ chave, motivo: 'valor inválido' }); continue; }
      gravar(chave, mapa[chave]);
      r.aplicadas.push(chave);
    }
    return r;
  }
  function restaurarPadroes() { for (const d of decl.values()) gravar(d.chave, d.padrao); }

  return { declarar, ler, gravar, ouvir, declaradas, exportar, importar, restaurarPadroes, usarArmazem };
});
