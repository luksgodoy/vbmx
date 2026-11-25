// VbMx — chave do motor de análise (VB-motor): decide entre o Essentia.js (padrão) e a análise própria
// (tom.js + ritmo.js) e converte a saída própria para o formato que o painel já consome. Sem dependência:
// quem chama passa as funções. Roda no navegador (global `VbMxMotorAnalise`, também dentro do Worker) e no Node.
// Teste: node biblioteca/testar-painel-motor.js.
//
// CHAVE: motor 'essentia' (padrão, como era antes) | 'proprio'. Qualquer outro valor vira 'essentia'.
//   comparar: true roda os dois e devolve o do `motor` oficial; o outro vai em `comparacao` (não altera o oficial).
//   No painel: VbMxPainel.iniciar({ motor: 'proprio', comparar: false }) ou ?motor=proprio na URL.
// FORMATO de saída (o do worker do painel): { candidatos:[{nome,bpm,ticks?}], nota, escala, forca, motor, fallback?, comparacao? }
(function (raiz, fabrica) {
  const api = fabrica();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.VbMxMotorAnalise = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MOTORES = ['essentia', 'proprio'];
  const MOTOR_PADRAO = 'essentia';
  // `strength` do tom próprio é a margem de correlação (melhor − segunda), tipicamente 0,01–0,3; a do
  // Essentia é outra escala (KeyExtractor, ~0–1). Hoje nada no painel nem no bpm.js decide por ela (só é
  // repassada e gravada como `forca`), então não há limiar a adaptar. Se um dia houver, use um por motor:
  // NÃO calibrado — ver pendência em analise/LEIAME.md.
  const CASAS_FORCA = { essentia: 2, proprio: 3 };

  const normalizarMotor = (m) => (MOTORES.indexOf(m) >= 0 ? m : MOTOR_PADRAO);
  const arred = (x, c) => { const f = Math.pow(10, c); return Math.round(x * f) / f; };

  // Próprio → formato do painel. `tom` = analisarTom(...); `ritmo` = analisarRitmo(...). Os candidatos do
  // ritmo já vêm como { nome, bpm, ticks? }; só descarta o que não é número finito > 0.
  function mapearProprio(tom, ritmo) {
    const candidatos = ((ritmo && ritmo.candidatos) || [])
      .filter((c) => c && Number.isFinite(c.bpm) && c.bpm > 0)
      .map((c) => (Array.isArray(c.ticks) ? { nome: c.nome, bpm: c.bpm, ticks: c.ticks } : { nome: c.nome, bpm: c.bpm }));
    return { candidatos, nota: tom.key, escala: tom.scale, forca: arred(tom.strength, CASAS_FORCA.proprio) };
  }

  // essentia() e proprio() são funções (podem ser async) que devolvem o formato do painel (sem `motor`).
  // proprio lançando erro → cai no Essentia (fallback: texto do erro). Sem candidatos próprios também cai.
  async function decidir({ motor, comparar, essentia, proprio }) {
    const m = normalizarMotor(motor);
    const rodar = async (f) => { try { return { r: await f() }; } catch (e) { return { erro: String((e && e.message) || e) }; } };
    if (m === 'essentia' && !comparar) return Object.assign(await essentia(), { motor: 'essentia' });
    if (m === 'essentia') { // oficial = Essentia; o próprio só informa
      const ess = await essentia(), p = await rodar(proprio);
      const saida = Object.assign(ess, { motor: 'essentia' });
      saida.comparacao = p.r ? Object.assign({}, p.r, { motor: 'proprio' }) : { motor: 'proprio', erro: p.erro };
      return saida;
    }
    const p = await rodar(proprio);
    const util = p.r && p.r.candidatos && p.r.candidatos.length > 0;
    if (!comparar) {
      if (util) return Object.assign({}, p.r, { motor: 'proprio' });
      return Object.assign(await essentia(), { motor: 'essentia', fallback: p.erro || 'sem candidatos de BPM no motor próprio' });
    }
    const e = await rodar(essentia);
    if (util) {
      const saida = Object.assign({}, p.r, { motor: 'proprio' });
      saida.comparacao = e.r ? Object.assign({}, e.r, { motor: 'essentia' }) : { motor: 'essentia', erro: e.erro };
      return saida;
    }
    if (!e.r) throw new Error(e.erro || p.erro || 'nenhum motor produziu resultado');
    return Object.assign({}, e.r, { motor: 'essentia', fallback: p.erro || 'sem candidatos de BPM no motor próprio' });
  }

  // songbpm primeiro, próprio depois: junta o resultado do songbpm (`sb` = { bpm, tom:{tonica,modo|null}, fonte })
  // com o do motor próprio (`p` = { nota, escala, … }). BPM e tônica são do songbpm. O songbpm quase nunca dá o modo:
  // se faltar, completa com o do próprio SÓ quando a tônica coincide (mesma altura, "C#" = "Db"); se divergir,
  // mantém a tônica do songbpm e deixa o modo desconhecido (modo null, modoDesconhecido true). Sem `sb`: devolve null.
  const CLASSE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const altura = (n) => {
    const m = String(n || '').trim().match(/^([A-Ga-g])([#♯b♭]?)$/);
    if (!m) return null;
    return (CLASSE[m[1].toUpperCase()] + (m[2] === '#' || m[2] === '♯' ? 1 : m[2] ? -1 : 0) + 12) % 12;
  };
  function combinarSongbpm(sb, p, fonte) {
    if (!sb || !sb.tom || !Number.isFinite(sb.bpm)) return null;
    const f = fonte || 'songbpm';
    let modo = sb.tom.modo || null, origemModo = modo ? f : null;
    if (!modo && p && p.escala && altura(sb.tom.tonica) !== null && altura(sb.tom.tonica) === altura(p.nota)) { modo = p.escala; origemModo = 'proprio'; }
    return { bpm: sb.bpm, nota: sb.tom.tonica, escala: modo, modoDesconhecido: !modo, origemModo, fonte: f };
  }

  // Precedência final: tunebat > songbpm > motor próprio. `tb`/`sb` = { bpm, tom:{tonica,modo|null} } ou null;
  // `p` = resultado do motor próprio ({ nota, escala }); `bpmGrade` = BPM que a grade usa (do motor próprio), opcional.
  // Sem nenhum externo: { fonte:'proprio' } (ficam os valores do próprio). Com externo: bpm/nota/escala do externo,
  // `bpmProprio`/`notaProprio`/`escalaProprio` guardados quando diferem (para mostrar a discordância) e `gradeDiverge`
  // quando o BPM externo discorda >3% do da grade.
  function combinarExterno(tb, sb, p, bpmGrade) {
    const c = combinarSongbpm(tb, p, 'tunebat') || combinarSongbpm(sb, p, 'songbpm');
    if (!c) return { fonte: 'proprio' };
    const ref = Number.isFinite(bpmGrade) ? bpmGrade : (p && Number.isFinite(p.bpm) ? p.bpm : null);
    if (ref) {
      if (Math.abs(c.bpm - ref) > 0.05) c.bpmProprio = ref;
      if (Math.abs(c.bpm - ref) / ref > 0.03) c.gradeDiverge = true;
    }
    if (p && p.nota && (altura(p.nota) !== altura(c.nota) || (c.escala && p.escala && c.escala !== p.escala))) { c.notaProprio = p.nota; c.escalaProprio = p.escala || null; }
    return c;
  }

  return { MOTORES, MOTOR_PADRAO, CASAS_FORCA, normalizarMotor, mapearProprio, decidir, combinarSongbpm, combinarExterno };
});
