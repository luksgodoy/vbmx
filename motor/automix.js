// VbMx — automix do modo Friends: escolhe a próxima faixa (shuffle entre as sugestões do motor) e planeja a
// transição sozinho (onde começa, quanto dura, em que ponto a próxima entra, com que taxa e com que curva).
//
// Lógica pura, sem DOM e sem Web Audio: quem toca é o VbMxTocador e quem liga os ganhos é interface/modos/friends.js.
// Navegador: <script src="motor/automix.js"> expõe `VbMxAutomix` (depois de recomendar, pitch, grade e reprodução);
// Node: require('./motor/automix.js'). Contrato: docs/contratos.md § VbMxAutomix. Teste: node motor/testar-automix.js.
//
// Reaproveita o que já existe e não refaz nenhuma regra:
//   - quem é compatível e em que ordem: VbMxMotor.sugerir (Camelot + BPM ±15%), com pesos tom/bpm/estilo iguais;
//   - quanto de pitch iguala os andamentos (×1, ×2, ½): VbMxPitch.calcularSync;
//   - onde caem as batidas e os compassos: VbMxGrade (daFaixa, batidaEm, tempoDaBatida);
//   - a curva de potência constante: VbMxReproducao.ganhoCrossfader(…, 'suave').
//
// Tempos: "s da faixa" (posição no arquivo) ou "s de relógio" (AudioContext). Taxa = playbackRate (1 = original).
//
// API:
//   primeiraFaixa(biblioteca, {aleatorio}) → {faixa, motivo}            faixa null se não houver analisável com áudio
//   CRITERIOS = ['bpm', 'tom', 'pitch', 'estilo']; normalizarCriterios(c) → os quatro booleanos (ausente = marcado:
//       só `false` explícito desmarca — o Friends não passa nada e usa todos)
//       bpm    filtra pela janela de ±15% (×1, ×2, ½) e pesa no escore       tom     filtra pela roda de Camelot e pesa
//       pitch  só entra quem o pitch do deck iguala (limitePitch) e a transição iguala o andamento
//       estilo só ordena (pesa no escore); nunca tira ninguém
//   avaliar(tocando, biblioteca, {criterios, tocadas, excluir, taxaAtual, limitePitch}) → {criterios, limite, bpmSoando,
//       entram: [item] (ordenadas, a melhor primeiro), fora: [item], semPitch, livres, sincronizaveis, resumo: {bpm, tom,
//       pitch, estilo → {marcado, corta, de, texto}}, erro?}   item = {faixa, casa|null, bpm: {fator, razao, delta,
//       deltaPct, dentro}, sync, escore, explicacao, motivo, falhas: [marcados que a tiram], sairiaCom: [desmarcados
//       que a tirariam], razoes: {criterio: texto}}  — é o que a árvore de caminhos do Profissional desenha
//   paraArvore(avaliacao, maximo) → {compativeis: [...], contagem}       no formato que VbMxArvore.montar consome
//   escolherProxima(tocando, biblioteca, {tocadas, excluir, taxaAtual, limitePitch, topo, aleatorio, criterios})
//       → {faixa, motivo, explicacao, origem: 'sugestao'|'fora-da-roda'|'recomeco', candidatas, sincronizaveis, reiniciar}
//   planejarTransicao({atual, duracaoAtual, taxaAtual, proxima, duracaoProxima, aPartirDe, compassos, limitePitch,
//       antecedencia, margemFim, criterios, duracaoS, encolher}) → plano  (criterios.pitch === false: não iguala o andamento) {sincroniza, motivo, inicioMix, duracaoMix, entrada, taxaProxima,
//       pitchProxima, fator, curva: 'linear'|'suave', compassos, pedidos, limitado}   encolher: 'compasso' = se não couber, tira 1 compasso por vez
//       (Friends, 4…64 compassos); sem ele a metade (o Auto do Profissional). `limitado` = coube menos do que se pediu; o valor real fica em duracaoMix
//   compassosValidos(x) → 4|8|16|32|64 (fora da lista → 8) · migrarDuracaoS(s) → compasso mais próximo de uma escolha antiga em s (a 128 BPM)
//   compassosSalvos(novo, antigoS) → o que vale ao abrir a tela (escolha nova, senão a antiga migrada, senão 8)
//   limitesPonto({atual, duracaoAtual, taxaAtual, duracaoS|compassos, margemFim, minimo}) → {min, max, grade}  onde o DJ pode pôr o ponto
//       da mixagem (s da faixa): min = compasso depois de `minimo`; max = último compasso em que a transição inteira cabe
//   encaixarPonto(tempo, mesma entrada) → {tempo, min, max, grade}   batida 1 do compasso mais próximo, dentro dos limites
//   duracaoDoCompasso(faixa) → s da faixa (0 sem grade)
//   posicaoDaProxima(plano, posAtual, taxaAtual)  s da faixa em que a próxima tem de estar quando a atual está em posAtual
//   progresso(plano, posAtual, taxaAtual)          0…1 do cruzamento
//   ganhos(p, curva) → {saindo, entrando}          'linear' = soma 1 (batidas alinhadas); 'suave' = potência constante
//   curvaGanho(formato, t, params?) → {saindo, entrando}   formatos do DJ: FORMATOS (linear|potencia|corte-tardio|corte-cedo|degrau) ou 'personalizado' (params {t1,g1,t2,g2}); inválido = linear
//   normalizarParams(p) → {t1,g1,t2,g2}|null · moverPonto(params, 1|2, t, g) · PARAMS_LINEAR · somaPotencia(formato, t, params?) · resumoPotencia(formato, params?) → {min,max}
//   curvaDeGanho(pInicial, n, curva, formato?, params?) → {saindo, entrando}  Float32Array de pInicial a 1 (para setValueCurveAtTime)
(function (raiz, fabrica) {
  const req = (nome, arq) => raiz[nome] || (typeof require === 'function' ? require(arq) : null);
  const api = fabrica(req('VbMxMotor', './recomendar.js'), req('VbMxPitch', './pitch.js'),
    req('VbMxGrade', './grade.js'), req('VbMxReproducao', './reproducao.js'));
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.VbMxAutomix = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (M, P, G, R) {
  'use strict';

  const COMPASSOS_PADRAO = 8;      // 8 compassos de 4 batidas: a transição clássica de 32 batidas
  const LIMITE_PITCH_PADRAO = 8;   // % — sem key lock no Friends, ±8% é o que ainda soa natural (faixa 8 do VbMxPitch)
  const ANTECEDENCIA_S = 4;        // s de relógio: a próxima começa muda antes do ponto (timer de aba em 2º plano ≈ 1 s)
  const MARGEM_FIM_S = 1;          // s da faixa: o cruzamento termina antes do fim do arquivo
  const COMPASSOS_OPCOES = [4, 8, 16, 32, 64];   // Friends: durações da transição que a tela oferece, em compassos de 4 batidas
  const BPM_REFERENCIA = 128;                     // BPM só para migrar a escolha antiga em s e para a dica sem faixa tocando
  const MIX_SEM_SYNC_S = 6;        // s de relógio: sem andamento comum, um cruzamento curto, sem alinhar batida
  const TOPO_PADRAO = 5;           // o shuffle sorteia entre as 5 melhores (não sempre a 1ª: é shuffle)
  const PESOS_AUTOMIX = { tom: 1, bpm: 1, estilo: 1 };
  const CRITERIOS = Object.freeze(['bpm', 'tom', 'pitch', 'estilo']);
  const ROTULOS = Object.freeze({ bpm: 'BPM', tom: 'tom', pitch: 'pitch', estilo: 'estilo' });
  const RELACAO_FORA = 'outro tom';   // grupo da árvore para quem só entra porque o tom está desmarcado
  const FATORES_BPM = [{ fator: 1, razao: 'mesmo andamento' }, { fator: 2, razao: 'dobro' }, { fator: 0.5, razao: 'metade' }];
  const EPS = 1e-9;

  const num = (x) => typeof x === 'number' && Number.isFinite(x);
  const trava = (x, a, b) => Math.min(b, Math.max(a, x));
  const comAudio = (f) => !!f && f.analisavel !== false && M.faixaValida(f);
  const ids = (lista) => new Set((lista || []).map((x) => (x && typeof x === 'object' ? x.id : x)));
  const aleatorioDe = (o) => (o && typeof o.aleatorio === 'function' ? o.aleatorio : Math.random);
  const bpmDe = (f) => { const g = G.daFaixa(f); return g ? g.bpm : null; };
  const br = (v, c) => Number(v.toFixed(c)).toString().replace('.', ',');

  function sortear(lista, aleatorio, peso) {
    if (!lista.length) return null;
    const pesos = lista.map((x) => Math.max(EPS, peso ? peso(x) : 1));
    const total = pesos.reduce((s, p) => s + p, 0);
    let r = trava(aleatorio(), 0, 1 - EPS) * total;
    for (let i = 0; i < lista.length; i++) { r -= pesos[i]; if (r < 0) return lista[i]; }
    return lista[lista.length - 1];
  }

  function primeiraFaixa(biblioteca, opcoes) {
    const validas = (biblioteca || []).filter(comAudio);
    if (!validas.length) return { faixa: null, motivo: 'nenhuma faixa analisada (com BPM e tom) para tocar: adicione uma pasta' };
    const faixa = sortear(validas, aleatorioDe(opcoes));
    return { faixa, motivo: `sorteada entre ${validas.length} faixa(s) analisada(s)` };
  }

  // Ausente = marcado: só `false` explícito desmarca (quem não passa critérios — o Friends — usa os quatro).
  function normalizarCriterios(c) {
    const o = {};
    for (const k of CRITERIOS) o[k] = !(c && c[k] === false);
    return o;
  }
  const marcados = (cr) => CRITERIOS.filter((k) => cr[k]);
  const pct = (v) => `${v > 0 ? '+' : v < 0 ? '−' : '±'}${br(Math.abs(v) * 100, 1)}%`;
  const estiloDe = (f) => { const v = f && (typeof f.estilo === 'string' && f.estilo.trim() ? f.estilo : f.genero); return typeof v === 'string' ? v.trim() : ''; };

  // Encaixe de BPM SEM a janela: o melhor entre ×1, ×2 e ½, com `dentro` dizendo se cabe em ±15% (a regra do motor).
  function encaixeLivre(bpmSoando, bpmCandidato) {
    const dentro = M.encaixeBpm(bpmSoando, bpmCandidato);
    if (dentro) return Object.assign({ dentro: true }, dentro);
    let melhor = null;
    for (const { fator, razao } of FATORES_BPM) {
      const delta = bpmCandidato / fator - bpmSoando, deltaPct = delta / bpmSoando;
      if (!melhor || Math.abs(deltaPct) < Math.abs(melhor.deltaPct)) melhor = { fator, razao, delta, deltaPct, dentro: false };
    }
    return melhor;
  }

  // Escore do item só com os critérios MARCADOS (mesma conta do VbMxMotor.sugerir: média das notas, peso 1 cada).
  function pontuar(cr, casa, bpm, estilo) {
    const ps = [];
    if (cr.tom && casa) ps.push({ criterio: 'tom', nota: casa.distancia === 0 ? 1 : 0.5, motivo: casa.relacao });
    if (cr.bpm && bpm.dentro) ps.push({ criterio: 'bpm', nota: Math.max(0, 1 - Math.abs(bpm.deltaPct) / M.JANELA_BPM), motivo: pct(bpm.deltaPct) });
    if (cr.estilo) ps.push({ criterio: 'estilo', nota: estilo.nota === null ? M.NOTA_NEUTRA : estilo.nota, motivo: estilo.motivo });
    if (!ps.length) return { exato: null, escore: null, explicacao: 'sem critério de escore marcado: ordem pelo andamento mais perto' };
    const exato = ps.reduce((s, p) => s + p.nota, 0) / ps.length, escore = Math.round(exato * 100);
    return { exato, escore, explicacao: `${escore} = ${ps.map((p) => `${ROTULOS[p.criterio]} ${Math.round(p.nota * 100)} (${p.motivo})`).join(' · ')}` };
  }

  // Tudo que poderia vir depois de `tocando`, classificado pelos critérios: quem entra (passa em todos os marcados),
  // quem fica de fora (e por qual marcado) e, de quem entra, quem SAIRIA se um desmarcado estivesse marcado.
  // O BPM que vale é o que SOA (grade × taxaAtual), porque a próxima vai ser igualada a ele.
  function avaliar(tocando, biblioteca, opcoes) {
    const o = opcoes || {};
    const cr = normalizarCriterios(o.criterios);
    const limite = P.FAIXAS.includes(o.limitePitch) ? o.limitePitch : LIMITE_PITCH_PADRAO;
    const taxa = num(o.taxaAtual) && o.taxaAtual > 0 ? o.taxaAtual : 1;
    const vetadas = new Set([...ids(o.tocadas), ...ids(o.excluir)]);
    if (tocando) vetadas.add(tocando.id);
    const lib = (biblioteca || []).filter(comAudio);
    const bpmSoando = bpmDe(tocando) ? bpmDe(tocando) * taxa : null;
    const saida = { criterios: cr, limite, bpmSoando, entram: [], fora: [], semPitch: false, livres: 0, sincronizaveis: 0, resumo: {} };
    if (!tocando || !M.faixaValida(tocando) || !bpmSoando) {
      for (const k of CRITERIOS) saida.resumo[k] = { marcado: cr[k], corta: 0, de: 0, texto: `${ROTULOS[k]} ${cr[k] ? 'marcado' : 'desmarcado'}` };
      return Object.assign(saida, { erro: 'a faixa tocando não tem BPM/tom' });
    }
    const ref = Object.assign({}, tocando, { bpm: bpmSoando });
    // Com tom e BPM marcados a roda é a do motor: a ordem, o escore e a explicação vêm prontos dele (é o Friends).
    const doMotor = cr.tom && cr.bpm;
    const sug = doMotor ? M.sugerir(ref, lib, { pesos: Object.assign({}, PESOS_AUTOMIX, { estilo: cr.estilo ? 1 : 0 }) }).sugestoes : [];
    const ordemMotor = new Map(sug.map((s, i) => [s.faixa.id, { s, i }]));
    const estiloRef = estiloDe(tocando);

    const itens = lib.filter((f) => !vetadas.has(f.id)).map((f) => {
      const casa = M.relacaoCamelot(ref.camelot, f.camelot);
      const bpm = encaixeLivre(bpmSoando, f.bpm);
      const sync = P.calcularSync(bpmDe(f), bpmSoando, limite);
      const passa = { bpm: bpm.dentro, tom: !!casa, pitch: !!sync.ok };
      const razoes = {};
      if (!passa.bpm) razoes.bpm = `${br(f.bpm, 1)} BPM contra ${br(bpmSoando, 1)}: ${pct(bpm.deltaPct)}${bpm.fator !== 1 ? ` (${bpm.razao})` : ''}, fora de ±${Math.round(M.JANELA_BPM * 100)}%`;
      if (!passa.tom) razoes.tom = `${f.camelot} não é vizinha de ${ref.camelot} na roda de Camelot`;
      if (!passa.pitch) razoes.pitch = sync.motivo || `o pitch de ±${limite}% não iguala o andamento`;
      const m = ordemMotor.get(f.id);
      const p = m ? { exato: null, escore: m.s.escore, explicacao: m.s.explicacao }
        : pontuar(cr, casa, bpm, M.afinidadeEstilo(estiloRef, estiloDe(f)));
      const motivo = m ? m.s.motivo
        : `${casa ? casa.relacao : `${RELACAO_FORA} (${f.camelot})`} · ${bpm.fator !== 1 ? `${bpm.razao}, ` : ''}${pct(bpm.deltaPct)} de BPM`;
      return { faixa: f, casa, bpm, sync, passa, razoes, motivo, escore: p.escore, explicacao: p.explicacao, _exato: p.exato, _motor: m ? m.i : -1,
        falhas: ['bpm', 'tom'].filter((k) => cr[k] && !passa[k]), sairiaCom: ['bpm', 'tom', 'pitch'].filter((k) => !cr[k] && !passa[k]) };
    });

    const livres = itens.filter((x) => !x.falhas.length);
    if (doMotor) livres.sort((a, b) => a._motor - b._motor);
    else livres.sort((a, b) => (b._exato !== null && a._exato !== null && Math.abs(b._exato - a._exato) > EPS ? b._exato - a._exato : 0)
      || Math.abs(a.bpm.deltaPct) - Math.abs(b.bpm.deltaPct) || (a.casa ? a.casa.distancia : 9) - (b.casa ? b.casa.distancia : 9)
      || String(a.faixa.id).localeCompare(String(b.faixa.id)));
    const cabem = livres.filter((x) => x.passa.pitch);
    // pitch marcado: só as que o pitch iguala; se nenhuma couber, a festa não para — entram as outras, sem igualar.
    saida.semPitch = cr.pitch && !cabem.length && livres.length > 0;
    saida.entram = cr.pitch && cabem.length ? cabem : livres;
    saida.livres = livres.length; saida.sincronizaveis = cabem.length;
    for (const x of itens) {
      if (cr.pitch && !x.falhas.length && !x.passa.pitch && !saida.semPitch) x.falhas.push('pitch');
      if (x.falhas.length) saida.fora.push(x);
      delete x._exato; delete x._motor;
    }

    const nE = saida.entram.length, nT = itens.length;
    for (const k of ['bpm', 'tom', 'pitch']) {
      if (cr[k]) {
        const n = saida.fora.filter((x) => x.falhas.includes(k)).length;
        saida.resumo[k] = { marcado: true, corta: n, de: nT, texto: `${ROTULOS[k]} marcado: tira ${n} de ${nT} faixa(s) ainda não tocada(s)`
          + (k === 'pitch' && saida.semPitch ? ' — nenhuma cabe no pitch: entram sem igualar o andamento' : '') };
      } else {
        const sairiam = saida.entram.filter((x) => x.sairiaCom.includes(k));
        saida.resumo[k] = { marcado: false, corta: sairiam.length, de: nE,
          texto: `${ROTULOS[k]} desmarcado — entraria aqui: se estivesse marcado, tiraria ${sairiam.length} de ${nE} que hoje entram`
            + (sairiam.length ? ` (ex.: ${sairiam[0].faixa.titulo || sairiam[0].faixa.id}: ${sairiam[0].razoes[k]})` : '')
            + (k === 'pitch' ? '; e a transição não iguala o andamento' : '') };
      }
    }
    if (cr.estilo) {
      const com = saida.entram.filter((x) => estiloRef && estiloDe(x.faixa)).length;
      saida.resumo.estilo = { marcado: true, corta: 0, de: nE, texto: `estilo marcado: pesa na ordem (nunca tira); ${com} de ${nE} com estilo conhecido` };
    } else if (o._semEstilo) saida.resumo.estilo = { marcado: false, corta: 0, de: nE, texto: '' };
    else {
      const com = avaliar(tocando, biblioteca, Object.assign({}, o, { criterios: Object.assign({}, cr, { estilo: true }), _semEstilo: true }));
      const a = saida.entram[0], b = com.entram[0];
      const mudam = saida.entram.filter((x, i) => !com.entram[i] || com.entram[i].faixa.id !== x.faixa.id).length;
      saida.resumo.estilo = { marcado: false, corta: mudam, de: nE,
        texto: `estilo desmarcado — entraria aqui: se estivesse marcado, ${mudam} de ${nE} mudariam de posição`
          + (a && b && a.faixa.id !== b.faixa.id ? ` e a 1ª seria ${b.faixa.titulo || b.faixa.id} (${b.explicacao})` : mudam ? ' (a 1ª continuaria a mesma)' : '') };
    }
    return saida;
  }

  // A avaliação no formato de VbMxMotor.compativeis, para VbMxArvore.montar: as `maximo` melhores que entram; quem
  // só entra porque o tom está desmarcado vai para o grupo RELACAO_FORA.
  function paraArvore(avaliacao, maximo) {
    const n = Number.isInteger(maximo) && maximo > 0 ? maximo : avaliacao.entram.length;
    return { contagem: { total: avaliacao.entram.length + avaliacao.fora.length, compativeis: avaliacao.entram.length },
      compativeis: avaliacao.entram.slice(0, n).map((x) => ({ faixa: x.faixa, casa: x.casa || { relacao: RELACAO_FORA, distancia: 9 }, bpm: x.bpm,
        motivo: x.motivo, escore: x.escore, explicacao: x.explicacao, sairiaCom: x.sairiaCom, razoes: x.razoes, semPitch: avaliacao.semPitch && !x.passa.pitch })) };
  }

  // A próxima do shuffle. `tocadas`/`excluir`: ids (ou faixas) que não podem voltar. `criterios`: quais dos quatro
  // valem (ausente = todos). O BPM que vale é o que SOA (grade × taxaAtual), porque a próxima vai ser igualada a ele.
  function escolherProxima(tocando, biblioteca, opcoes) {
    const o = opcoes || {};
    const aleatorio = aleatorioDe(o);
    const cr = normalizarCriterios(o.criterios);
    const todos = marcados(cr).length === CRITERIOS.length;
    const limite = P.FAIXAS.includes(o.limitePitch) ? o.limitePitch : LIMITE_PITCH_PADRAO;
    const topo = Number.isInteger(o.topo) && o.topo > 0 ? o.topo : TOPO_PADRAO;
    const taxa = num(o.taxaAtual) && o.taxaAtual > 0 ? o.taxaAtual : 1;
    const fora = ids(o.excluir);
    const vetadas = new Set([...ids(o.tocadas), ...fora]);
    if (tocando) vetadas.add(tocando.id);
    const lib = (biblioteca || []).filter(comAudio);
    const bpmSoando = bpmDe(tocando) ? bpmDe(tocando) * taxa : null;
    const pitchPara = (f) => { const s = P.calcularSync(bpmDe(f), bpmSoando, limite); return s; };
    const quais = todos ? '' : ` [critérios: ${marcados(cr).map((k) => ROTULOS[k]).join(', ') || 'nenhum'}]`;

    if (!tocando || !M.faixaValida(tocando) || !bpmSoando) {
      const r = primeiraFaixa(lib.filter((f) => !vetadas.has(f.id)), { aleatorio });
      return Object.assign({ explicacao: '', origem: 'recomeco', candidatas: 0, sincronizaveis: 0, reiniciar: false }, r,
        { motivo: `a faixa tocando não tem BPM/tom: ${r.motivo}` });
    }

    const av = avaliar(tocando, lib, o);
    if (av.entram.length) {
      const escolhidas = av.entram.slice(0, topo);
      const s = sortear(escolhidas, aleatorio, (x) => (num(x.escore) ? x.escore + 1 : 1));
      const ritmo = !cr.pitch ? 'sem mexer no pitch (critério desmarcado)'
        : s.sync.ok ? `pitch ${P.formatarPitch(s.sync.pitch)}` : `sem igualar o andamento (${s.sync.motivo})`;
      return { faixa: s.faixa, origem: 'sugestao', candidatas: av.livres, sincronizaveis: av.sincronizaveis, reiniciar: false,
        motivo: `shuffle entre as ${escolhidas.length} melhores de ${av.livres} compatível(is) ainda não tocada(s): ${s.motivo}; ${ritmo}${quais}`,
        explicacao: s.explicacao };
    }

    // Nenhuma compatível na roda que ainda não tocou: a festa não para — a de andamento mais perto, sem harmonia garantida.
    const resto = lib.filter((f) => !vetadas.has(f.id));
    if (resto.length) {
      const ordem = resto.map((f) => ({ f, d: Math.abs(pitchPara(f).pitch) }))
        .filter((x) => num(x.d)).sort((a, b) => a.d - b.d || a.f.id - b.f.id).slice(0, 3);
      const x = sortear(ordem.length ? ordem : resto.map((f) => ({ f, d: 0 })), aleatorio);
      const regra = todos ? 'Camelot + BPM' : marcados(cr).filter((k) => k !== 'estilo').map((k) => ROTULOS[k]).join(' + ') || 'nenhum critério';
      return { faixa: x.f, origem: 'fora-da-roda', candidatas: 0, sincronizaveis: 0, reiniciar: false, explicacao: '',
        motivo: `nenhuma compatível (${regra}) ainda não tocada: a de andamento mais perto, ${br(x.d, 1)}% de pitch, sem harmonia garantida` };
    }

    // Todas já tocaram: recomeça o shuffle (só a que toca e as excluídas ficam de fora).
    const de_novo = lib.filter((f) => f.id !== tocando.id && !fora.has(f.id));
    if (!de_novo.length) return { faixa: null, origem: 'recomeco', candidatas: 0, sincronizaveis: 0, reiniciar: false, explicacao: '',
      motivo: 'não há outra faixa analisada para tocar depois desta' };
    const r = escolherProxima(tocando, lib, Object.assign({}, o, { tocadas: [] }));
    return Object.assign(r, { reiniciar: true, motivo: `todas já tocaram: recomeçando o shuffle — ${r.motivo}` });
  }

  // Primeiro compasso (batida 1) com t ≥ minimo.
  function compassoDepois(g, minimo) {
    const n = Math.ceil(G.batidaEm(g, minimo) / g.porCompasso - EPS) * g.porCompasso;
    return G.tempoDaBatida(g, n);
  }
  // Último compasso (batida 1) com t ≤ maximo.
  function compassoAntes(g, maximo) {
    const n = Math.floor(G.batidaEm(g, maximo) / g.porCompasso + EPS) * g.porCompasso;
    return G.tempoDaBatida(g, n);
  }

  // Valor da lista de compassos ou, se vier fora dela (localStorage velho, texto), o padrão (8).
  function compassosValidos(x) { const v = Number(x); return COMPASSOS_OPCOES.includes(v) ? v : COMPASSOS_PADRAO; }
  // Escolha antiga em segundos (10/15/20/25/30 s) → compasso mais próximo da lista, a 128 BPM (4 × 60/128 = 1,875 s por
  // compasso): 10 s→4, 15 s→8, 20 s→8, 25 s→16, 30 s→16. Valor ausente, inválido ou ≤ 0 → o padrão (8).
  function migrarDuracaoS(s) {
    const v = Number(s);
    if (s === null || s === undefined || s === '' || !Number.isFinite(v) || v <= 0) return COMPASSOS_PADRAO;
    const c = v / (4 * 60 / BPM_REFERENCIA);
    return COMPASSOS_OPCOES.reduce((m, o) => (Math.abs(o - c) < Math.abs(m - c) ? o : m), COMPASSOS_OPCOES[0]);
  }
  // O que vale ao abrir a tela: a escolha nova em compassos, senão a antiga em s migrada, senão o padrão.
  function compassosSalvos(novo, antigoS) {
    if (novo !== null && novo !== undefined && novo !== '') return compassosValidos(novo);
    return migrarDuracaoS(antigoS);
  }

  function planejarTransicao(entrada) {
    const e = entrada || {};
    const durA = e.duracaoAtual, durP = e.duracaoProxima;
    if (!num(durA) || durA <= 0 || !num(durP) || durP <= 0) throw new TypeError('planejarTransicao: duracaoAtual e duracaoProxima em s, > 0');
    const taxaA = num(e.taxaAtual) && e.taxaAtual > 0 ? e.taxaAtual : 1;
    const limite = P.FAIXAS.includes(e.limitePitch) ? e.limitePitch : LIMITE_PITCH_PADRAO;
    const antecedencia = num(e.antecedencia) && e.antecedencia >= 0 ? e.antecedencia : ANTECEDENCIA_S;
    const margem = num(e.margemFim) && e.margemFim >= 0 ? e.margemFim : MARGEM_FIM_S;
    const aPartirDe = num(e.aPartirDe) ? Math.max(0, e.aPartirDe) : 0;
    const gA = G.daFaixa(e.atual), gP = G.daFaixa(e.proxima);
    // duracaoS (Friends): duração pedida em s de relógio; vira compassos inteiros pelo BPM que soa (≥ 1) e, se não
    // couber, encolhe de 1 em 1 compasso (alinhamento de batida 1 preservado). Sem ela vale `compassos` (padrão 8).
    const duracaoS = num(e.duracaoS) && e.duracaoS > 0 ? e.duracaoS : 0;
    const porCompassoS = gA ? (gA.porCompasso * gA.periodo) / taxaA : 0;
    const encolheUm = !!duracaoS || e.encolher === 'compasso';   // Friends (compassos): o maior número inteiro que cabe, não metade
    const pedidos = duracaoS && porCompassoS > 0 ? Math.max(1, Math.round(duracaoS / porCompassoS))
      : Number.isInteger(e.compassos) && e.compassos > 0 ? e.compassos : COMPASSOS_PADRAO;
    const fimUtilA = Math.max(0, durA - margem);

    let motivo = '';
    if (!normalizarCriterios(e.criterios).pitch) motivo = 'pitch desmarcado: cada faixa no seu andamento';
    else if (gA && gP) {
      const s = P.calcularSync(gP.bpm, gA.bpm * taxaA, limite);
      if (s.ok) {
        const taxaP = R.taxaDoPitch(s.pitch, limite);
        // a próxima já está tocando (muda) `antecedencia` s de relógio antes do ponto: precisa ter faixa antes dela
        const entradaP = compassoDepois(gP, antecedencia * taxaP + 0.05);
        for (let c = pedidos; c >= 1; c = c > 1 ? (encolheUm ? c - 1 : Math.max(1, Math.floor(c / 2))) : 0) {
          const mixA = c * gA.porCompasso * gA.periodo;                  // s da faixa atual
          const duracaoMix = mixA / taxaA;                               // s de relógio
          const tardio = compassoAntes(gA, fimUtilA - mixA);
          const cedo = compassoDepois(gA, aPartirDe);
          const inicioMix = num(e.aPartirDe) ? cedo : tardio;
          const cabeA = inicioMix >= aPartirDe - EPS && inicioMix >= 0 && inicioMix + mixA <= fimUtilA + EPS;
          const cabeP = entradaP + duracaoMix * taxaP <= Math.max(0, durP - margem) + EPS;
          if (cabeA && cabeP) {
            return { sincroniza: true, inicioMix, duracaoMix, entrada: entradaP, taxaProxima: taxaP, pitchProxima: s.pitch,
              fator: s.fator, curva: 'linear', compassos: c, pedidos, limitado: c < pedidos,
              motivo: `${c} compasso(s) a partir da batida 1, a próxima com pitch ${P.formatarPitch(s.pitch)} (${s.razao})` };
          }
          if (c === 1) break;
        }
        motivo = 'a faixa não tem compasso inteiro que caiba antes do fim';
      } else motivo = s.motivo;
    } else motivo = 'sem grade (BPM) numa das faixas';

    // Sem andamento comum: cruzamento curto de potência constante, cada uma na sua velocidade.
    // Friends em compassos sem andamento comum: o tempo pedido em compassos da atual (se tem grade), senão os 6 s de sempre.
    const alvoSem = duracaoS || (e.encolher === 'compasso' && porCompassoS > 0 ? pedidos * porCompassoS : MIX_SEM_SYNC_S);
    const mix = Math.min(alvoSem, fimUtilA / taxaA, Math.max(0.5, (durP - margem) - antecedencia));
    const inicioMix = num(e.aPartirDe) ? Math.min(aPartirDe, Math.max(0, fimUtilA - mix * taxaA)) : Math.max(aPartirDe, fimUtilA - mix * taxaA);
    return { sincroniza: false, inicioMix, duracaoMix: mix, entrada: Math.min(antecedencia, Math.max(0, durP - mix - margem)),
      taxaProxima: 1, pitchProxima: 0, fator: 1, curva: 'suave', compassos: 0, pedidos, limitado: mix < alvoSem - 1e-6,
      motivo: `cruzamento de ${br(mix, 1)} s sem alinhar batida: ${motivo}` };
  }

  // ---- Friends: o ponto da mixagem escolhido pelo DJ (arrastar o triângulo amarelo) ----
  // Quantos compassos a transição pede no BPM que soa (a mesma conta de planejarTransicao).
  function compassosPedidos(e, gA, taxaA) {
    const duracaoS = num(e.duracaoS) && e.duracaoS > 0 ? e.duracaoS : 0;
    const porCompassoS = gA ? (gA.porCompasso * gA.periodo) / taxaA : 0;
    return duracaoS && porCompassoS > 0 ? Math.max(1, Math.round(duracaoS / porCompassoS))
      : Number.isInteger(e.compassos) && e.compassos > 0 ? e.compassos : COMPASSOS_PADRAO;
  }

  // Faixa de valores que o ponto pode ter (s da faixa que toca): {min, max, grade}.
  //   min = 1º compasso (batida 1) depois de `minimo` (a cabeça + antecedência: o ponto não volta para trás);
  //   max = último compasso em que a transição INTEIRA ainda cabe antes da margem de fim.
  //   Sem grade a faixa não tem compasso: o ponto é livre dentro do mesmo intervalo (grade: false).
  // entrada: {atual, duracaoAtual, taxaAtual, duracaoS | compassos, margemFim, minimo}
  function limitesPonto(entrada) {
    const e = entrada || {};
    const durA = e.duracaoAtual;
    if (!num(durA) || durA <= 0) throw new TypeError('limitesPonto: duracaoAtual em s, > 0');
    const taxaA = num(e.taxaAtual) && e.taxaAtual > 0 ? e.taxaAtual : 1;
    const margem = num(e.margemFim) && e.margemFim >= 0 ? e.margemFim : MARGEM_FIM_S;
    const minimo = num(e.minimo) ? Math.max(0, e.minimo) : 0;
    const fimUtilA = Math.max(0, durA - margem);
    const gA = G.daFaixa(e.atual);
    if (!gA) {
      const mix = num(e.duracaoS) && e.duracaoS > 0 ? e.duracaoS : MIX_SEM_SYNC_S;
      const max = Math.max(0, fimUtilA - mix * taxaA);
      return { min: Math.min(minimo, max), max, grade: false };
    }
    const mixA = compassosPedidos(e, gA, taxaA) * gA.porCompasso * gA.periodo;
    let max = Math.max(0, compassoAntes(gA, Math.max(0, fimUtilA - mixA)));
    let min = compassoDepois(gA, minimo);
    if (min > max) min = max;   // faixa quase no fim: sobra um ponto só (o planejamento encolhe a duração se preciso)
    return { min, max, grade: true };
  }

  // Encaixa um tempo qualquer (s da faixa) na batida 1 do compasso mais próximo, dentro de limitesPonto.
  function encaixarPonto(tempo, entrada) {
    const lim = limitesPonto(entrada);
    const t = num(tempo) ? tempo : lim.min;
    const g = G.daFaixa((entrada || {}).atual);
    let v = t;
    if (g) {
      const antes = compassoAntes(g, Math.max(0, t)), depois = compassoDepois(g, Math.max(0, t));
      v = Math.abs(t - antes) <= Math.abs(depois - t) ? antes : depois;
    }
    return { tempo: Math.max(lim.min, Math.min(lim.max, v)), min: lim.min, max: lim.max, grade: lim.grade };
  }

  // Um compasso na grade da faixa, em s da faixa (0 sem grade).
  function duracaoDoCompasso(atual) { const g = G.daFaixa(atual); return g ? g.porCompasso * g.periodo : 0; }

  function posicaoDaProxima(plano, posAtual, taxaAtual) {
    const taxa = num(taxaAtual) && taxaAtual > 0 ? taxaAtual : 1;
    return plano.entrada + ((posAtual - plano.inicioMix) / taxa) * plano.taxaProxima;
  }
  function progresso(plano, posAtual, taxaAtual) {
    const taxa = num(taxaAtual) && taxaAtual > 0 ? taxaAtual : 1;
    if (!(plano.duracaoMix > 0)) return posAtual >= plano.inicioMix ? 1 : 0;
    return trava((posAtual - plano.inicioMix) / taxa / plano.duracaoMix, 0, 1);
  }
  // Formatos da curva do crossfader escolhidos pelo DJ (Friends). 'linear' é o desenho de sempre (ganhos(p, plano.curva)).
  const FORMATOS = ['linear', 'potencia', 'corte-tardio', 'corte-cedo', 'degrau'];
  const FORMATO_PADRAO = 'linear';
  const PERSONALIZADO = 'personalizado';   // dois pontos de controle arrastáveis; fora de FORMATOS (os cinco prontos)
  const formatoValido = (f) => (FORMATOS.indexOf(f) >= 0 || f === PERSONALIZADO ? f : FORMATO_PADRAO);
  // Curva personalizada: a nova (entrando) sobe por (0,0) → (t1,g1) → (t2,g2) → (1,1) em trechos retos; a que sai é o espelho
  // (saindo(t) = entrando(1−t)). t1/t2 = início/fim da rampa (fração do cruzamento), g1/g2 = o ganho nesses pontos. Os pontos nunca cruzam
  // nem invertem (FOLGA ≤ t1, t1 + FOLGA ≤ t2 ≤ 1 − FOLGA e g1 ≤ g2), então a curva é monotônica e os extremos são exatos. Reta de ponta a ponta = linear reto.
  const FOLGA_PONTOS = 0.04;
  const PARAMS_LINEAR = Object.freeze({ t1: 1 / 3, g1: 1 / 3, t2: 2 / 3, g2: 2 / 3 });
  // Aceita {t1,g1,t2,g2} numéricos e finitos (a ordem é imposta, não exigida); qualquer outra coisa → null (= linear).
  function normalizarParams(p) {
    if (!p || typeof p !== 'object') return null;
    const v = [p.t1, p.g1, p.t2, p.g2];
    if (!v.every((x) => typeof x === 'number' && Number.isFinite(x))) return null;
    const t1 = trava(v[0], FOLGA_PONTOS, 1 - 2 * FOLGA_PONTOS);   // nunca colado nas pontas: sem salto de ganho em t=0 nem em t=1
    const t2 = trava(v[2], t1 + FOLGA_PONTOS, 1 - FOLGA_PONTOS);
    const g1 = trava(v[1], 0, 1), g2 = trava(v[3], g1, 1);
    return { t1, g1, t2, g2 };
  }
  // Move UM ponto (1 = início, 2 = fim) para (t, g) sem empurrar o outro: o ponto para no limite (não cruza o vizinho nem inverte). Devolve params novos.
  function moverPonto(params, qual, t, g) {
    const pn = normalizarParams(params) || normalizarParams(PARAMS_LINEAR), tt = num(t) ? t : 0, gg = num(g) ? g : 0;
    if (qual === 2) return { t1: pn.t1, g1: pn.g1, t2: trava(tt, pn.t1 + FOLGA_PONTOS, 1 - FOLGA_PONTOS), g2: trava(gg, pn.g1, 1) };
    return { t1: trava(tt, FOLGA_PONTOS, pn.t2 - FOLGA_PONTOS), g1: trava(gg, 0, pn.g2), t2: pn.t2, g2: pn.g2 };
  }
  function rampaPersonalizada(pn, x) {   // ganho de quem entra; x em (0,1)
    const pts = [[0, 0], [pn.t1, pn.g1], [pn.t2, pn.g2], [1, 1]];
    for (let i = 1; i < pts.length; i++) {
      if (x <= pts[i][0]) { const [xa, ya] = pts[i - 1], [xb, yb] = pts[i]; return xb > xa ? ya + (yb - ya) * (x - xa) / (xb - xa) : yb; }
    }
    return 1;
  }
  const suave = (u) => u * u * (3 - 2 * u);
  // Função pura do formato: t em [0,1] → {saindo, entrando}. Monotônica, extremos exatos (0→{1,0}, 1→{0,1}); formato inválido = linear.
  //   linear = rampa suave de soma 1 · potencia = cos/sin (soma de potência 1) · corte-tardio = a nova só entra no último terço ·
  //   corte-cedo = a nova entra no primeiro terço · degrau = corte seco no meio, sem valor intermediário.
  function curvaGanho(formato, t, params) {
    const x = trava(num(t) ? t : 0, 0, 1);
    if (x === 0) return { saindo: 1, entrando: 0 };
    if (x === 1) return { saindo: 0, entrando: 1 };
    const fv = formatoValido(formato), pn = fv === PERSONALIZADO ? normalizarParams(params) : null;
    if (fv === PERSONALIZADO && pn) return { saindo: rampaPersonalizada(pn, 1 - x), entrando: rampaPersonalizada(pn, x) };
    switch (fv) {
      case 'potencia': return { saindo: Math.cos(Math.PI / 2 * x), entrando: Math.sin(Math.PI / 2 * x) };
      case 'corte-tardio': { const e = x <= 2 / 3 ? 0 : suave(3 * x - 2); return { saindo: 1 - e, entrando: e }; }
      case 'corte-cedo': { const e = x >= 1 / 3 ? 1 : suave(3 * x); return { saindo: 1 - e, entrando: e }; }
      case 'degrau': return x < 0.5 ? { saindo: 1, entrando: 0 } : { saindo: 0, entrando: 1 };
      default: return { saindo: 1 - suave(x), entrando: suave(x) };
    }
  }
  // Soma de potência (saindo² + entrando²): 1 = potência constante; abaixo de 1 a mixagem "afunda" no meio. Reportada na tela da curva.
  function somaPotencia(formato, t, params) { const g = curvaGanho(formato, t, params); return g.saindo * g.saindo + g.entrando * g.entrando; }
  function resumoPotencia(formato, params) {
    let min = Infinity, max = -Infinity;
    for (let i = 0; i <= 200; i++) { const s = somaPotencia(formato, i / 200, params); if (s < min) min = s; if (s > max) max = s; }
    return { min, max };
  }
  // formato (opcional) só muda o que não é 'linear'; sem ele, ou linear, vale a curva do plano como antes. 'personalizado' sem params válidos = linear.
  function ganhos(p, curva, formato, params) {
    const x = trava(num(p) ? p : 0, 0, 1);
    if (formatoValido(formato) !== FORMATO_PADRAO && !(formatoValido(formato) === PERSONALIZADO && !normalizarParams(params))) return curvaGanho(formato, x, params);
    if (curva === 'suave') {
      const v = -100 + 200 * x;
      return { saindo: R.ganhoCrossfader('A', v, 'suave'), entrando: R.ganhoCrossfader('B', v, 'suave') };
    }
    const s = x * x * (3 - 2 * x);   // soma 1 com ponta lisa: com o bumbo alinhado, somar amplitude não estoura
    return { saindo: 1 - s, entrando: s };
  }
  function curvaDeGanho(pInicial, n, curva, formato, params) {
    const k = Number.isInteger(n) && n >= 2 ? n : 64;
    const p0 = trava(num(pInicial) ? pInicial : 0, 0, 1);
    const saindo = new Float32Array(k), entrando = new Float32Array(k);
    for (let i = 0; i < k; i++) {
      const g = ganhos(p0 + ((1 - p0) * i) / (k - 1), curva, formato, params);
      saindo[i] = g.saindo; entrando[i] = g.entrando;
    }
    return { saindo, entrando };
  }

  return { COMPASSOS_OPCOES, BPM_REFERENCIA, compassosValidos, migrarDuracaoS, compassosSalvos, COMPASSOS_PADRAO, LIMITE_PITCH_PADRAO, ANTECEDENCIA_S, MARGEM_FIM_S, MIX_SEM_SYNC_S, TOPO_PADRAO,
    CRITERIOS, ROTULOS, RELACAO_FORA, normalizarCriterios, avaliar, paraArvore,
    primeiraFaixa, escolherProxima, planejarTransicao, limitesPonto, encaixarPonto, duracaoDoCompasso, posicaoDaProxima, progresso, ganhos, curvaDeGanho, FORMATOS, FORMATO_PADRAO, PERSONALIZADO, FOLGA_PONTOS, PARAMS_LINEAR, formatoValido, curvaGanho, normalizarParams, moverPonto, somaPotencia, resumoPotencia };
});
