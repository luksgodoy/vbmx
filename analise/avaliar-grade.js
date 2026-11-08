// VbMx — harness de avaliação da análise de grade (BPM e fase do 1 do compasso).
// Uso: node analise/avaliar-grade.js [amostra-rotulada.json] [--detalhe caminho.json]
// Para cada faixa roda a MESMA análise do app (biblioteca/bpm.js: envelopeGrave + resolver) e compara
// com o rótulo. Imprime só o topo; a tabela completa vai para o arquivo de detalhe (padrão:
// analise/avaliacao-grade-detalhe.json). Só stdlib. Formato do JSON: analise/LEIAME.md.
'use strict';
const fs = require('fs');
const path = require('path');
const B = require('../biblioteca/bpm.js');

const TOL_BPM = 2, TOL_FASE_MS = 20;

// WAV PCM 16 bits ou float32 -> { pcm: Float32Array mono, taxa }. Só decodifica o que o harness precisa.
function lerWav(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('não é WAV (o harness lê só WAV)');
  let pos = 12, fmt = null, dados = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4), n = buf.readUInt32LE(pos + 4), ini = pos + 8;
    if (id === 'fmt ') fmt = { tipo: buf.readUInt16LE(ini), canais: buf.readUInt16LE(ini + 2), taxa: buf.readUInt32LE(ini + 4), bits: buf.readUInt16LE(ini + 14) };
    else if (id === 'data') { dados = buf.subarray(ini, Math.min(buf.length, ini + n)); break; }
    pos = ini + n + (n % 2);
  }
  if (!fmt || !dados) throw new Error('WAV sem fmt/data');
  const bytes = fmt.bits / 8, quadro = bytes * fmt.canais, total = Math.floor(dados.length / quadro), pcm = new Float32Array(total);
  const amostra = (o) => fmt.tipo === 3 && fmt.bits === 32 ? dados.readFloatLE(o) : fmt.bits === 16 ? dados.readInt16LE(o) / 32768 : NaN;
  if (Number.isNaN(amostra(0))) throw new Error(`WAV ${fmt.bits} bits tipo ${fmt.tipo} não suportado`);
  for (let i = 0; i < total; i++) { let s = 0; for (let c = 0; c < fmt.canais; c++) s += amostra(i * quadro + c * bytes); pcm[i] = s / fmt.canais; }
  return { pcm, taxa: fmt.taxa };
}

const ehNum = (v) => typeof v === 'number' && Number.isFinite(v);
const mediana = (v) => { const o = v.slice().sort((a, b) => a - b), n = o.length; return n ? (n % 2 ? o[(n - 1) / 2] : (o[n / 2 - 1] + o[n / 2]) / 2) : null; };
const quantil = (v, q) => { const o = v.slice().sort((a, b) => a - b); return o.length ? o[Math.min(o.length - 1, Math.max(0, Math.round(q * (o.length - 1))))] : null; };

// Classe do BPM: 'certo' (±2), 'dobro_metade' (≈2× ou ½×, ±2% — contado à parte), 'errado'.
function classeBpm(det, rot) {
  if (Math.abs(det - rot) <= TOL_BPM) return 'certo';
  const r = det / rot;
  if (Math.abs(r - 2) <= 0.04 || Math.abs(r - 0.5) <= 0.02) return 'dobro_metade';
  return 'errado';
}

// Erro (ms, com sinal) do 1 do compasso: distância do rótulo à linha de compasso mais próxima da grade
// (linhas a cada 4 períodos a partir de grade.primeira). Meia batida de erro já seria > P/2 ms.
function erroFaseMs(grade, rotuloS) {
  const vao = 4 * 60 / grade.bpm, d = (rotuloS - grade.primeira) % vao;
  const w = d > vao / 2 ? d - vao : d < -vao / 2 ? d + vao : d;
  return -w * 1000; // positivo: a grade está depois do rótulo
}

function avaliarFaixa(f, base) {
  const out = { arquivo: f.arquivo, rotulo: f.rotulo || {}, estado: 'ok' };
  const c = f.candidatos;
  if (!c || !Array.isArray(c.lista) || !c.lista.length) return Object.assign(out, { estado: 'sem_candidatos' });
  if (!f.caminho) return Object.assign(out, { estado: 'sem_caminho' });
  const cam = path.resolve(base, f.caminho);
  if (!fs.existsSync(cam)) return Object.assign(out, { estado: 'arquivo_ausente' });
  let wav;
  try { wav = lerWav(fs.readFileSync(cam)); } catch (e) { return Object.assign(out, { estado: 'erro_leitura', erro: e.message }); }
  const ini = ehNum(c.inicio_s) ? c.inicio_s : 0, i0 = Math.min(wav.pcm.length, Math.round(ini * wav.taxa));
  const i1 = ehNum(c.janela_s) ? Math.min(wav.pcm.length, i0 + Math.round(c.janela_s * wav.taxa)) : wav.pcm.length;
  const env = B.envelopeGrave(wav.pcm.subarray(i0, i1), wav.taxa);
  const r = B.resolver(c.lista, ini, null, env);
  if (!r) return Object.assign(out, { estado: 'sem_resultado' });
  out.detectado = { bpm: r.bpm, fonte: r.fonte, instavel: !!r.instavel, grade: r.grade, compasso: r.compasso || null };
  const rb = f.rotulo && f.rotulo.bpm;
  if (ehNum(rb)) out.classeBpm = classeBpm(r.bpm, rb);
  const r1 = f.rotulo && f.rotulo.primeiro_1_s;
  if (ehNum(r1)) {
    if (r.grade) out.erroFaseMs = erroFaseMs(r.grade, r1);
    else out.erroFaseMs = null; // sem grade (andamento instável): não há fase para medir
  }
  return out;
}

function resumo(res) {
  const comBpm = res.filter(x => x.classeBpm), certos = comBpm.filter(x => x.classeBpm === 'certo').length, dm = comBpm.filter(x => x.classeBpm === 'dobro_metade').length;
  const comFase = res.filter(x => 'erroFaseMs' in x), medidos = comFase.filter(x => x.erroFaseMs !== null).map(x => Math.abs(x.erroFaseMs));
  return {
    faixas: res.length, puladas: res.filter(x => x.estado !== 'ok').length,
    bpm: { n: comBpm.length, certo: certos, dobro_metade: dm, errado: comBpm.length - certos - dm },
    fase: { n: comFase.length, sem_grade: comFase.length - medidos.length, mediana_ms: mediana(medidos), p90_ms: quantil(medidos, 0.9), acima_20ms: medidos.filter(v => v > TOL_FASE_MS).length },
  };
}

function falhas(res) {
  return res.filter(x => x.estado !== 'ok' || (x.classeBpm && x.classeBpm !== 'certo') || (typeof x.erroFaseMs === 'number' && Math.abs(x.erroFaseMs) > TOL_FASE_MS) || x.erroFaseMs === null)
    .map(x => ({ arquivo: x.arquivo, motivo: x.estado !== 'ok' ? x.estado : [x.classeBpm !== 'certo' && x.classeBpm ? `BPM ${x.classeBpm} (${x.detectado.bpm} x ${x.rotulo.bpm})` : null,
      x.erroFaseMs === null ? 'sem grade' : (typeof x.erroFaseMs === 'number' && Math.abs(x.erroFaseMs) > TOL_FASE_MS) ? `fase ${x.erroFaseMs.toFixed(1)} ms` : null].filter(Boolean).join('; ') }));
}

function avaliar(amostra, base) {
  const res = (amostra.faixas || []).map(f => avaliarFaixa(f, base));
  return { gerado_em: new Date().toISOString(), resumo: resumo(res), erradas: falhas(res), faixas: res };
}

function main() {
  const args = process.argv.slice(2), iD = args.indexOf('--detalhe');
  const detalhe = iD >= 0 ? args.splice(iD, 2)[1] : path.join(__dirname, 'avaliacao-grade-detalhe.json');
  const arq = args[0] || path.join(__dirname, 'amostra-rotulada.json');
  if (!fs.existsSync(arq)) { console.error(`não achei ${arq} (exporte pela página avaliar-essentia.html; formato em analise/LEIAME.md)`); process.exit(2); }
  const amostra = JSON.parse(fs.readFileSync(arq, 'utf8')), ev = avaliar(amostra, path.dirname(path.resolve(arq)));
  fs.writeFileSync(detalhe, JSON.stringify(ev, null, 2));
  const s = ev.resumo, p = (a, b) => (b ? `${a}/${b} (${(100 * a / b).toFixed(0)}%)` : '—');
  console.log(`faixas ${s.faixas} (puladas ${s.puladas})`);
  console.log(`BPM ±${TOL_BPM}: ${p(s.bpm.certo, s.bpm.n)} · dobro/metade à parte: ${s.bpm.dobro_metade} · errado: ${s.bpm.errado}`);
  const f = (v) => (v === null ? '—' : v.toFixed(1));
  console.log(`fase do 1 (n=${s.fase.n}, sem grade ${s.fase.sem_grade}): mediana ${f(s.fase.mediana_ms)} ms · p90 ${f(s.fase.p90_ms)} ms · acima de ${TOL_FASE_MS} ms: ${s.fase.acima_20ms}`);
  if (ev.erradas.length) { console.log('erraram:'); ev.erradas.slice(0, 15).forEach(e => console.log(`  ${e.arquivo}: ${e.motivo}`)); if (ev.erradas.length > 15) console.log(`  … +${ev.erradas.length - 15} no detalhe`); }
  console.log(`detalhe: ${detalhe}`);
}

if (require.main === module) main();
module.exports = { lerWav, classeBpm, erroFaseMs, avaliarFaixa, avaliar };
