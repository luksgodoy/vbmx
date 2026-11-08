// ===================== VbMxColecao — coleção: filtros, ordenação e agrupamento =====================
// Dono: VB-17 (onda 1). Lógica pura (UMD), testada em Node por biblioteca/testar-colecao.js.
// Faixa = { id, titulo, artista, bpm, camelot, genero?, ano?, analisavel?, avaliacao?, cor?, comentario?, importada? } (as tags vêm de VbMxMetadados).
//   criteriosVazios()                 → objeto de critérios sem nenhum filtro
//   filtrar(faixas, criterios)        → subconjunto, na ordem original (função pura, não muda a entrada)
//        criterios: { texto, bpmMin, bpmMax, casas: [..], genero, ano, soAnalisadas, avaliacaoMin, cor, desde, ate }
//        (VB-17b: avaliacao 0..5, cor, comentario e importada (ms) vêm de VbMxMeta.mesclar; desde/ate em ms)
//   ordenar(faixas, coluna, direcao)  → cópia ordenada, ESTÁVEL; vazio vai sempre para o fim
//   agrupar(faixas, campo)            → [{ chave, rotulo, faixas }] (campo: camelot|genero|ano|artista|bpm)
//   valores(faixas, campo)            → valores distintos não vazios (para os seletores)
//   analisarTexto(texto)              → { termos: [{campo|null, valor}] } (sintaxe `campo:valor`)
// Busca: sem acento e sem diferença de caixa; cada termo precisa casar (E). Termo solto casa título,
// artista, gênero, ano ou a casa Camelot EXATA (8A não casa 18A). `artista:dona`, `tom:8a`, `ano:2019`,
// `genero:house`, `titulo:maré` restringem ao campo.
(function (raiz, fabrica) {
  const api = fabrica(raiz);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.VbMxColecao = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const COLUNAS = ['camelot', 'titulo', 'artista', 'bpm', 'genero', 'ano', 'avaliacao', 'importada', 'comentario'];
  const CAMPOS_BUSCA = { titulo: 'titulo', artista: 'artista', genero: 'genero', ano: 'ano', tom: 'camelot', casa: 'camelot', camelot: 'camelot', comentario: 'comentario' };

  function norm(s) {
    if (s === null || s === undefined) return '';
    return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  }
  const vazio = (v) => v === null || v === undefined || v === '' || (typeof v === 'number' && !Number.isFinite(v));
  const analisavel = (f) => f.analisavel !== false;

  function criteriosVazios() {
    return { texto: '', bpmMin: null, bpmMax: null, casas: [], genero: '', ano: '', soAnalisadas: false, avaliacaoMin: null, cor: '', desde: null, ate: null };
  }

  // `tom:` e `casa:` aceitam qualquer notação (Camelot, Open Key, musical); sem VbMxNotacao ou ilegível, fica como digitado.
  function tomEmCamelot(valor) {
    let N = null;
    try { N = typeof require === 'function' ? require('../motor/notacao.js') : (typeof VbMxNotacao !== 'undefined' ? VbMxNotacao : null); } catch (_) { N = null; }
    const c = N ? N.converter(valor, 'camelot') : null;
    return c === null ? norm(valor) : norm(c);
  }

  function analisarTexto(texto) {
    const termos = [];
    for (const parte of String(texto || '').trim().split(/\s+/)) {
      if (!parte) continue;
      const i = parte.indexOf(':');
      if (i > 0 && i < parte.length - 1 && CAMPOS_BUSCA[norm(parte.slice(0, i))]) {
        const campo = CAMPOS_BUSCA[norm(parte.slice(0, i))], bruto = parte.slice(i + 1);
        termos.push({ campo, valor: campo === 'camelot' ? tomEmCamelot(bruto) : norm(bruto) });
      } else termos.push({ campo: null, valor: norm(parte) });
    }
    return { termos };
  }

  function casaCampo(f, campo, valor) {
    const v = f[campo];
    if (vazio(v)) return false;
    if (campo === 'camelot') return norm(v) === valor;
    if (campo === 'ano') return String(v) === valor;
    return norm(v).includes(valor);
  }
  function casaTermo(f, t) {
    if (t.campo) return casaCampo(f, t.campo, t.valor);
    return casaCampo(f, 'titulo', t.valor) || casaCampo(f, 'artista', t.valor) || casaCampo(f, 'genero', t.valor)
      || casaCampo(f, 'ano', t.valor) || casaCampo(f, 'camelot', t.valor);
  }

  function numeroOuNulo(v) {
    if (vazio(v)) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function filtrar(faixas, criterios) {
    const c = Object.assign(criteriosVazios(), criterios || {});
    const termos = analisarTexto(c.texto).termos;
    let min = numeroOuNulo(c.bpmMin), max = numeroOuNulo(c.bpmMax);
    if (min !== null && max !== null && min > max) { const t = min; min = max; max = t; }
    const casas = new Set((c.casas || []).map(tomEmCamelot));
    const avMin = numeroOuNulo(c.avaliacaoMin), desde = numeroOuNulo(c.desde), ate = numeroOuNulo(c.ate);
    const genero = norm(c.genero), ano = vazio(c.ano) ? '' : String(c.ano);
    return faixas.filter((f) => {
      if (c.soAnalisadas && !analisavel(f)) return false;
      if ((min !== null || max !== null) && (vazio(f.bpm) || (min !== null && f.bpm < min) || (max !== null && f.bpm > max))) return false;
      if (casas.size && !casas.has(norm(f.camelot))) return false;
      if (genero && norm(f.genero) !== genero) return false;
      if (ano && String(f.ano) !== ano) return false;
      if (avMin !== null && (Number(f.avaliacao) || 0) < avMin) return false;       // VB-17b: estrelas (0 a 5), meta de biblioteca/meta.js
      if (c.cor && f.cor !== c.cor) return false;
      if ((desde !== null || ate !== null) && (numeroOuNulo(f.importada) === null || (desde !== null && f.importada < desde) || (ate !== null && f.importada > ate))) return false;
      return termos.every((t) => casaTermo(f, t));
    });
  }

  // Ordem do camelot: número da casa, depois A antes de B; texto: pt-BR sem diferença de caixa/acento.
  function chaveOrdem(f, coluna) {
    const v = f[coluna];
    if (vazio(v)) return null;
    if (coluna === 'camelot') {
      const m = /^(\d{1,2})([AB])$/i.exec(String(v).trim());
      return m ? Number(m[1]) * 2 + (m[2].toUpperCase() === 'B' ? 1 : 0) : null;
    }
    if (coluna === 'bpm' || coluna === 'ano' || coluna === 'avaliacao' || coluna === 'importada') return numeroOuNulo(v);
    return norm(v);
  }
  function comparar(a, b) {
    if (typeof a === 'number') return a - b;
    return a < b ? -1 : a > b ? 1 : 0;
  }

  function ordenar(faixas, coluna, direcao) {
    const sentido = direcao === 'desc' ? -1 : 1;
    if (!COLUNAS.includes(coluna)) return faixas.slice();
    const com = faixas.map((f, i) => ({ f, i, k: chaveOrdem(f, coluna) }));
    com.sort((x, y) => {
      if (x.k === null || y.k === null) return x.k === y.k ? x.i - y.i : (x.k === null ? 1 : -1);   // vazio sempre no fim
      const d = comparar(x.k, y.k) * sentido;
      return d !== 0 ? d : x.i - y.i;                                                                // estável
    });
    return com.map((o) => o.f);
  }

  function rotuloGrupo(f, campo) {
    if (campo === 'bpm') {
      if (vazio(f.bpm) || !analisavel(f)) return null;
      const base = Math.floor(f.bpm / 10) * 10;
      return `${base}–${base + 9} BPM`;
    }
    const v = f[campo];
    return vazio(v) ? null : String(v);
  }
  function agrupar(faixas, campo) {
    if (!['camelot', 'genero', 'ano', 'artista', 'bpm'].includes(campo)) return [{ chave: '', rotulo: 'Todas', faixas: faixas.slice() }];
    const mapa = new Map();
    for (const f of faixas) {
      const r = rotuloGrupo(f, campo);
      const chave = r === null ? '' : (campo === 'genero' || campo === 'artista' ? norm(r) : r);
      if (!mapa.has(chave)) mapa.set(chave, { chave, rotulo: r === null ? 'Sem ' + campo : r, faixas: [] });
      mapa.get(chave).faixas.push(f);
    }
    const grupos = [...mapa.values()];
    const ordem = grupos.filter((g) => g.chave !== '');
    const ordenado = campo === 'camelot' ? ordem.sort((a, b) => chaveOrdem({ camelot: a.chave }, 'camelot') - chaveOrdem({ camelot: b.chave }, 'camelot'))
      : campo === 'ano' ? ordem.sort((a, b) => Number(a.chave) - Number(b.chave))
      : campo === 'bpm' ? ordem.sort((a, b) => parseInt(a.chave, 10) - parseInt(b.chave, 10))
      : ordem.sort((a, b) => a.chave < b.chave ? -1 : a.chave > b.chave ? 1 : 0);
    const semValor = grupos.find((g) => g.chave === '');
    return semValor ? ordenado.concat([semValor]) : ordenado;
  }

  function valores(faixas, campo) {
    const vistos = new Map();
    for (const f of faixas) {
      const v = f[campo];
      if (vazio(v)) continue;
      const k = campo === 'genero' ? norm(v) : String(v);
      if (!vistos.has(k)) vistos.set(k, String(v));
    }
    const lista = [...vistos.values()];
    return campo === 'ano' ? lista.sort((a, b) => Number(a) - Number(b))
      : campo === 'camelot' ? lista.sort((a, b) => chaveOrdem({ camelot: a }, 'camelot') - chaveOrdem({ camelot: b }, 'camelot'))
      : lista.sort((a, b) => norm(a) < norm(b) ? -1 : 1);
  }

  return { COLUNAS, norm, criteriosVazios, analisarTexto, filtrar, ordenar, agrupar, valores };
});
