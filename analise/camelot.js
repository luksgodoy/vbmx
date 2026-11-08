// Conversão nota + modo -> Camelot (1A–12B) e comparações de acerto.
// Serve ao navegador (global `Camelot`) e ao Node (module.exports).
(function (raiz, fabrica) {
  if (typeof module === 'object' && module.exports) module.exports = fabrica();
  else raiz.Camelot = fabrica();
})(typeof self !== 'undefined' ? self : this, function () {
  const CLASSE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

  // "C#", "Db", "c♯", "Bb" -> classe de altura 0..11 (ou null)
  function classeDeNota(nota) {
    const m = String(nota || '').trim().match(/^([A-Ga-g])\s*([#♯b♭]*)$/);
    if (!m) return null;
    let pc = CLASSE[m[1].toUpperCase()];
    for (const c of m[2]) pc += (c === '#' || c === '♯') ? 1 : -1;
    return ((pc % 12) + 12) % 12;
  }

  function normalizarModo(modo) {
    const s = String(modo || '').trim().toLowerCase();
    if (['major', 'maior', 'maj', 'ionian'].includes(s)) return 'maior';
    if (['minor', 'menor', 'min', 'm', 'aeolian'].includes(s)) return 'menor';
    return null;
  }

  // Maior: C = 8B e cada quinta acima soma 1. Menor: usa o relativo maior (3 semitons acima).
  function paraCamelot(nota, modo) {
    const pc = classeDeNota(nota), md = normalizarModo(modo);
    if (pc === null || md === null) return null;
    const maior = md === 'maior' ? pc : (pc + 3) % 12;
    const numero = (((maior * 7) % 12) + 7) % 12 + 1;
    return numero + (md === 'maior' ? 'B' : 'A');
  }

  // Aceita "8A", "08a", "Am", "A minor", "C#m", "Db maior", "F# major".
  function normalizarCamelot(texto) {
    const s = String(texto || '').trim();
    let m = s.match(/^0?([1-9]|1[0-2])\s*([abAB])$/);
    if (m) return m[1] + m[2].toUpperCase();
    m = s.match(/^([A-Ga-g][#♯b♭]*)\s*(m|min|minor|menor|maj|major|maior)?$/);
    if (m) {
      const modo = m[2] && m[2] !== 'maj' && m[2] !== 'major' && m[2] !== 'maior' ? 'menor' : 'maior';
      // "m" minúsculo só vale como menor quando colado à nota
      return paraCamelot(m[1].toUpperCase().replace(/^([A-G])B/, '$1b'), modo);
    }
    return null;
  }

  function partes(c) {
    const m = String(c || '').match(/^(\d+)([AB])$/);
    return m ? { n: +m[1], l: m[2] } : null;
  }

  // 'exato' | 'relativo' (mesmo número, outra letra) | 'vizinho' (±1, mesma letra) | 'errado' | null
  function compararTom(detectado, rotulo) {
    const a = partes(normalizarCamelot(detectado)), b = partes(normalizarCamelot(rotulo));
    if (!a || !b) return null;
    if (a.n === b.n && a.l === b.l) return 'exato';
    if (a.n === b.n) return 'relativo';
    const d = Math.abs(a.n - b.n);
    if (a.l === b.l && (d === 1 || d === 11)) return 'vizinho';
    return 'errado';
  }

  // 'certo' (±tol) | 'dobro_metade' (detectado ≈ 2x ou 1/2 do rótulo) | 'errado' | null
  function compararBpm(detectado, rotulo, tol = 2) {
    const d = Number(detectado), r = Number(rotulo);
    if (!isFinite(d) || !isFinite(r) || d <= 0 || r <= 0) return null;
    if (Math.abs(d - r) <= tol) return 'certo';
    if (Math.abs(d - 2 * r) <= tol * 2 || Math.abs(d - r / 2) <= tol) return 'dobro_metade';
    return 'errado';
  }

  return { classeDeNota, normalizarModo, paraCamelot, normalizarCamelot, compararTom, compararBpm };
});
