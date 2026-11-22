// ===================== stems-carga.js — do arquivo da faixa aos 4 stems no deck (2026-11-07) =====================
// Quando a faixa carrega no deck (evento deck:carregado) e a preferência "stems.separar-ao-carregar" está ligada
// (padrão), envia o ARQUIVO ORIGINAL (bytes crus, sem reencode) ao servidor, acompanha a separação, baixa os 4 WAVs,
// decodifica no mesmo sampleRate da principal e entrega a VbMxStems.carregar. O botão STEMS da tela (aoPedir) dispara
// o mesmo caminho quando o modo estava desligado e a faixa ainda não tem stems.
//   Servidor: POST /stems/enviar?nome=…  ·  GET /stems/estado/<id>  ·  GET /stems/<id>/<nome>.wav (servidor/stems.py).
//   Fases mostradas na tela (VbMxStemsTela.mostrarEstado): enviando → separando N% → baixando → pronto | erro.
// Regras: um token por deck (trocar de faixa, ejetar ou pedir de novo descarta o resultado antigo); servidor fora do
// ar ou separador ausente = erro em português na tela e o deck segue tocando só com a faixa principal.
// Em Node: criar(deps) com tudo simulado (interface/testar-stems-carga.js). Contrato: docs/contratos.md.
(function (raiz, fabrica) {
  const api = fabrica(raiz);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { raiz.VbMxStemsCarga = api; api.ligarNaPagina(raiz); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (raiz) {
  'use strict';
  const PREF = 'stems.separar-ao-carregar';
  const NOMES = ['vocals', 'drums', 'bass', 'instrumental'];
  const MAX_TENTATIVAS_ESTADO = 3600;      // ~1 h a 1 s: depois disso desiste com erro (não fica pendurado)

  // deps: fetch(url, init) · ctx() → AudioContext|null · stems (VbMxStems) · tela (VbMxStemsTela) · preferencia() → bool
  //       arquivoDe(letra) → Promise<File|Blob+name> · bufferDe(letra) → AudioBuffer|null · esperar(ms) → Promise
  //       navegador (plugin Sidra: disponivel(), estado() → 'ok'|'sem-worker'|'sem-modelo' (opcional), separar(arquivo, onProgresso)) · servidorLocal (bool: há servidor de stems, tenta-o antes do plugin) · reamostrar(buffer, taxa) → Promise<AudioBuffer> (opcional) · intervaloMs (padrão 1000)
  function criar(deps) {
    const tok = {};                         // letra → número do processo vigente
    const andando = {};                     // letra → true enquanto há processo
    const espera = deps.esperar || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const intervalo = deps.intervaloMs == null ? 1000 : deps.intervaloMs;
    const mostrar = (letra, d) => { try { deps.tela.mostrarEstado(letra, d); } catch (_) { /* a tela não derruba a carga */ } };
    const larga = (letra) => { try { deps.stems.descarregar(letra); } catch (_) { /* nada a largar */ } };

    async function lerJson(r) { try { return await r.json(); } catch (_) { return {}; } }
    async function baixar(base, nome, taxa, ctx) {
      const r = await deps.fetch(`${base}/${nome}.wav`);
      if (!r.ok) throw new Error(tr('pro.stems.baixar',{nome,status:r.status}));
      let b = await ctx.decodeAudioData(await r.arrayBuffer());
      if (b.sampleRate !== taxa) {
        if (!deps.reamostrar) throw new Error(tr('pro.stems.taxa',{nome,hz:b.sampleRate,faixa:taxa}));
        b = await deps.reamostrar(b, taxa);
      }
      return b;
    }

    // Alinha os stems à faixa (atraso do codificador que o decodeAudioData descarta); sem `deps.alinhar`, passa direto.
    function alinhados(buf, stems) {
      if (!deps.alinhar) return stems;
      const r = deps.alinhar(buf, stems);
      if (!r || !r.ok) throw new Error(tr('pro.stems.alinhar',{motivo:trm(r && r.motivo) || tr('pro.stems.recusado')}));
      return r.stems;
    }

    // Processo inteiro de um deck. Devolve 'pronto' | 'erro' | 'descartado' (o DJ trocou de faixa no meio).
    async function separar(letra) {
      const meu = (tok[letra] = (tok[letra] || 0) + 1);
      const buf = deps.bufferDe(letra);
      if (!buf) { mostrar(letra, { fase: 'ausente' }); return 'descartado'; }
      const vale = () => tok[letra] === meu && deps.bufferDe(letra) === buf;
      andando[letra] = meu;
      try {
        const ctx = deps.ctx();
        if (!ctx) throw new Error(tr('pro.stems.audio-nao-iniciado'));
        mostrar(letra, { fase: 'enviando' });
        const arq = await deps.arquivoDe(letra);
        if (!vale()) return 'descartado';
        if (!arq) throw new Error(tr('pro.stems.sem-arquivo'));
        // Plugin Sidra (opcional): separa no próprio navegador, sem servidor. Em hospedagem estática (deps.servidorLocal falso) vai
        // direto; em localhost tenta o servidor primeiro e cai no plugin se não houver /stems (404/405/501) ou se ele estiver fora.
        let estNav = null;
        const nav = async () => {
          if (estNav) return estNav;
          const n = deps.navegador;
          if (!n) return (estNav = 'sem-plugin');
          try { estNav = typeof n.estado === 'function' ? await n.estado() : ((await n.disponivel()) ? 'ok' : 'sem-modelo'); } catch (_) { estNav = 'sem-modelo'; }
          return estNav;
        };
        const viaNavegador = async () => {
          if (!vale()) return 'descartado';
          mostrar(letra, { fase: 'separando', progresso: 0 });
          const stems = await deps.navegador.separar(arq, (p) => { if (vale()) mostrar(letra, { fase: 'separando', carregando: p.etapa === 'modelo', progresso: p.etapa === 'separar' ? p.fracao : p.etapa === 'modelo' ? p.fracao * 0.05 : 0 }); });
          if (!vale()) return 'descartado';
          for (const n of NOMES) {
            if (stems[n].sampleRate === buf.sampleRate) continue;
            if (!deps.reamostrar) throw new Error(tr('pro.stems.taxa',{nome:n,hz:stems[n].sampleRate,faixa:buf.sampleRate}));
            stems[n] = await deps.reamostrar(stems[n], buf.sampleRate);
          }
          const res = deps.stems.carregar(letra, alinhados(buf, stems));
          if (!res || !res.ok) throw new Error(tr('pro.stems.ligar',{motivo:trm(res && res.motivo) || tr('pro.stems.recusado')}));
          mostrar(letra, { fase: 'pronto', progresso: 1 });
          return 'pronto';
        };
        // sem servidor e sem plugin utilizável: diz qual dos dois buracos é (navegador sem suporte, modelo que não carregou, ou só falta servidor)
        const semSeparador = async () => {
          const e = await nav();
          return new Error(tr(e === 'sem-worker' ? 'pro.stems.sem-suporte' : e === 'sem-modelo' ? 'pro.stems.modelo-falhou' : 'pro.stems.separador-indisp'));
        };
        if (deps.navegador && !deps.servidorLocal && await nav() === 'ok') return await viaNavegador();
        let r;
        try { r = await deps.fetch(`/stems/enviar?nome=${encodeURIComponent(arq.name || 'faixa')}`, { method: 'POST', body: arq }); }
        catch (_) {
          if (deps.navegador && await nav() === 'ok') return await viaNavegador();   // localhost sem o servidor de pé: o plugin separa
          throw new Error(tr('pro.stems.servidor-fora'));
        }
        if (!vale()) return 'descartado';
        // hospedagem estática (GitHub Pages) não tem /stems: 404/405 = sem servidor, não falha de separação
        if (r.status === 404 || r.status === 405 || r.status === 501) {
          if (deps.navegador && await nav() === 'ok') return await viaNavegador();
          throw await semSeparador();
        }
        const env = await lerJson(r);
        if (!r.ok || !env.id) throw new Error(env.erro || `o servidor recusou o envio (${r.status})`);
        const id = env.id;
        for (let i = 0; ; i++) {
          let e;
          try { const re = await deps.fetch(`/stems/estado/${id}`); e = await lerJson(re); if (!re.ok) throw new Error(e.erro || `estado ${re.status}`); }
          catch (err) { throw new Error(tr('pro.stems.perdi-contato',{erro:err.message || err})); }
          if (!vale()) return 'descartado';
          if (e.estado === 'pronto') break;
          if (e.estado === 'erro') throw new Error(e.erro || tr('pro.stems.separacao-falhou'));
          if (i >= MAX_TENTATIVAS_ESTADO) throw new Error(tr('pro.stems.separacao-demorou'));
          mostrar(letra, { fase: 'separando', carregando: e.fase === 'carregando', progresso: typeof e.progresso === 'number' ? e.progresso : 0 });
          await espera(intervalo);
          if (!vale()) return 'descartado';
        }
        mostrar(letra, { fase: 'baixando' });
        const lista = await Promise.all(NOMES.map((n) => baixar(`/stems/${id}`, n, buf.sampleRate, ctx)));
        if (!vale()) return 'descartado';
        const stems = {}; NOMES.forEach((n, k) => { stems[n] = lista[k]; });
        const res = deps.stems.carregar(letra, alinhados(buf, stems));
        if (!res || !res.ok) throw new Error(tr('pro.stems.ligar',{motivo:trm(res && res.motivo) || tr('pro.stems.recusado')}));
        mostrar(letra, { fase: 'pronto', progresso: 1 });
        return 'pronto';
      } catch (e) {
        if (!vale()) return 'descartado';
        mostrar(letra, { fase: 'erro', erro: (e && e.message) || String(e) });
        return 'erro';
      } finally {
        if (andando[letra] === meu) delete andando[letra];
      }
    }

    return {
      separar,
      // deck:carregado — a faixa nova largou os stems da anterior (o tocador já fez); recomeça pela preferência.
      async aoCarregar(letra) {
        tok[letra] = (tok[letra] || 0) + 1;
        larga(letra);
        mostrar(letra, { fase: 'ausente' });
        if (!deps.preferencia()) return 'desligado';
        return separar(letra);
      },
      // deck:descarregado (ejetar) — descarta o que estiver em voo e solta os stems.
      aoDescarregar(letra) { tok[letra] = (tok[letra] || 0) + 1; larga(letra); mostrar(letra, { fase: 'ausente' }); },
      // Botão STEMS com a faixa ainda sem stems: separa mesmo com a preferência desligada (e tenta de novo após erro).
      pedir(letra) { return andando[letra] ? Promise.resolve('andando') : separar(letra); },
      andando: (letra) => !!andando[letra],
    };
  }

  // ---- ligação na página (navegador) ----
  function ligarNaPagina(r) {
    if (!r.VbMxUI || !r.VbMxPrefs) return;
    // versão móbile (js/movel.js): nasce desligada — o modelo (~86 MB) só baixa quando o usuário toca em STEMS
    r.VbMxPrefs.declarar(PREF, !(r.VbMxMovel && r.VbMxMovel.ativo), { tipo: 'booleano', modulo: 'stems', rotulo: 'Separar stems ao carregar' });
    const c = criar({
      fetch: (u, i) => r.fetch(u, i),
      // localhost tenta o servidor (servir.py) e cai no plugin Sidra se não houver /stems; hospedagem estática (GitHub Pages) vai direto ao plugin
      navegador: r.VbMxSidra || null,
      servidorLocal: !!(r.VbMxBiblioteca && r.VbMxBiblioteca.stemsDisponiveis && r.location && r.VbMxBiblioteca.stemsDisponiveis(r.location)),
      ctx: () => (typeof ctxAudio !== 'undefined' ? ctxAudio : null),
      get stems() { return r.VbMxStems; },
      get tela() { return r.VbMxStemsTela; },
      preferencia: () => r.VbMxPrefs.ler(PREF),
      arquivoDe: (letra) => { const f = decks[letra].faixa; return f && typeof f.obter === 'function' ? f.obter() : Promise.resolve(null); },
      bufferDe: (letra) => decks[letra].buffer || null,
      // decodeAudioData já entrega na taxa do contexto; isto é a rede de segurança (interpolação linear)
      alinhar: (principal, stems) => (r.VbMxStemsMotor && ctxAudio ? r.VbMxStemsMotor.alinhar(principal, stems, (c, n, t) => ctxAudio.createBuffer(c, n, t)) : { ok: true, stems }),
      reamostrar: async (b, taxa) => {
        const ctx = ctxAudio, len = Math.max(1, Math.round(b.length * taxa / b.sampleRate)), sai = ctx.createBuffer(b.numberOfChannels, len, taxa);
        for (let c = 0; c < b.numberOfChannels; c++) {
          const e = b.getChannelData(c), d = sai.getChannelData(c), k = (e.length - 1) / Math.max(1, len - 1);
          for (let i = 0; i < len; i++) { const x = i * k, j = Math.floor(x), f = x - j; d[i] = e[j] + ((e[Math.min(j + 1, e.length - 1)] - e[j]) * f); }
        }
        return sai;
      },
    });
    r.VbMxUI.ouvir('deck:carregado', (d) => { c.aoCarregar(d.letra); });
    r.VbMxUI.ouvir('deck:descarregado', (d) => c.aoDescarregar(d.letra));
    if (r.VbMxStemsTela && typeof r.VbMxStemsTela.aoPedir === 'function') r.VbMxStemsTela.aoPedir((letra) => { c.pedir(letra); });
    r.VbMxStemsCargaAtiva = c;
  }

  return { PREF, NOMES, criar, ligarNaPagina };
});
