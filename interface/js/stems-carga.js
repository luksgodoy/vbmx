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
  //       reamostrar(buffer, taxa) → Promise<AudioBuffer> (opcional) · intervaloMs (padrão 1000)
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
      if (!r.ok) throw new Error(`não consegui baixar o stem ${nome} (${r.status})`);
      let b = await ctx.decodeAudioData(await r.arrayBuffer());
      if (b.sampleRate !== taxa) {
        if (!deps.reamostrar) throw new Error(`o stem ${nome} veio a ${b.sampleRate} Hz e a faixa está a ${taxa} Hz`);
        b = await deps.reamostrar(b, taxa);
      }
      return b;
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
        if (!ctx) throw new Error('o áudio ainda não foi iniciado (toque em qualquer botão e tente de novo)');
        mostrar(letra, { fase: 'enviando' });
        const arq = await deps.arquivoDe(letra);
        if (!vale()) return 'descartado';
        if (!arq) throw new Error('esta faixa não tem acesso ao arquivo original');
        let r;
        try { r = await deps.fetch(`/stems/enviar?nome=${encodeURIComponent(arq.name || 'faixa')}`, { method: 'POST', body: arq }); }
        catch (_) { throw new Error('o servidor de stems está fora do ar (rode servir.py); o deck segue só com a faixa'); }
        if (!vale()) return 'descartado';
        const env = await lerJson(r);
        if (!r.ok || !env.id) throw new Error(env.erro || `o servidor recusou o envio (${r.status})`);
        const id = env.id;
        for (let i = 0; ; i++) {
          let e;
          try { const re = await deps.fetch(`/stems/estado/${id}`); e = await lerJson(re); if (!re.ok) throw new Error(e.erro || `estado ${re.status}`); }
          catch (err) { throw new Error(`perdi o contato com o servidor de stems: ${err.message || err}`); }
          if (!vale()) return 'descartado';
          if (e.estado === 'pronto') break;
          if (e.estado === 'erro') throw new Error(e.erro || 'a separação falhou no servidor');
          if (i >= MAX_TENTATIVAS_ESTADO) throw new Error('a separação demorou demais; tente de novo');
          mostrar(letra, { fase: 'separando', progresso: typeof e.progresso === 'number' ? e.progresso : 0 });
          await espera(intervalo);
          if (!vale()) return 'descartado';
        }
        mostrar(letra, { fase: 'baixando' });
        const lista = await Promise.all(NOMES.map((n) => baixar(`/stems/${id}`, n, buf.sampleRate, ctx)));
        if (!vale()) return 'descartado';
        const stems = {}; NOMES.forEach((n, k) => { stems[n] = lista[k]; });
        const res = deps.stems.carregar(letra, stems);
        if (!res || !res.ok) throw new Error(`não consegui ligar os stems: ${(res && res.motivo) || 'recusado'}`);
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
    r.VbMxPrefs.declarar(PREF, true, { tipo: 'booleano', modulo: 'stems', rotulo: 'Separar stems ao carregar' });
    const c = criar({
      fetch: (u, i) => r.fetch(u, i),
      ctx: () => (typeof ctxAudio !== 'undefined' ? ctxAudio : null),
      get stems() { return r.VbMxStems; },
      get tela() { return r.VbMxStemsTela; },
      preferencia: () => r.VbMxPrefs.ler(PREF),
      arquivoDe: (letra) => { const f = decks[letra].faixa; return f && typeof f.obter === 'function' ? f.obter() : Promise.resolve(null); },
      bufferDe: (letra) => decks[letra].buffer || null,
      // decodeAudioData já entrega na taxa do contexto; isto é a rede de segurança (interpolação linear)
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
