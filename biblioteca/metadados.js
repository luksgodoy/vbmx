// ===================== VbMxMetadados — tags lidas do arquivo (ID3 e afins), tolerante a falha =====================
// Dono: VB-17 (onda 1). Lógica pura (UMD), testada em Node por biblioteca/testar-metadados.js.
// Só LÊ metadados (texto) — nunca decodifica nem toca o áudio, e nunca escreve no arquivo.
//   lerID3(bytes)            → { titulo?, artista?, genero?, ano?, bpm?, tom? }; nunca lança (lixo → {})
//   tamanhoCabecalho(bytes)  → bytes que cobrem o ID3v2 (cabeçalho + quadros), ou 0 se não houver
//   lerArquivo(arquivo)      → Promise<tags>; `arquivo` é um File/Blob (slice + arrayBuffer); nunca rejeita
//   mesclar(faixa, tags)     → cópia da faixa com genero/ano (e artista, se vazio) preenchidos pelas tags
// Suporta ID3v2.2/2.3/2.4 (UTF-8, UTF-16, Latin-1) e o ID3v1 do fim do arquivo. WAV/AIFF sem ID3 → {}.
(function (raiz, fabrica) {
  const api = fabrica(raiz);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.VbMxMetadados = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const LIMITE_LEITURA = 1024 * 1024;        // não lê mais que 1 MB de cabeçalho (capa gigante fica de fora)
  const GENEROS_V1 = ['Blues', 'Classic Rock', 'Country', 'Dance', 'Disco', 'Funk', 'Grunge', 'Hip-Hop', 'Jazz', 'Metal', 'New Age', 'Oldies', 'Other', 'Pop', 'R&B', 'Rap', 'Reggae', 'Rock', 'Techno', 'Industrial', 'Alternative', 'Ska', 'Death Metal', 'Pranks', 'Soundtrack', 'Euro-Techno', 'Ambient', 'Trip-Hop', 'Vocal', 'Jazz+Funk', 'Fusion', 'Trance', 'Classical', 'Instrumental', 'Acid', 'House', 'Game', 'Sound Clip', 'Gospel', 'Noise', 'Alt. Rock', 'Bass', 'Soul', 'Punk', 'Space', 'Meditative', 'Instrumental Pop', 'Instrumental Rock', 'Ethnic', 'Gothic', 'Darkwave', 'Techno-Industrial', 'Electronic', 'Pop-Folk', 'Eurodance', 'Dream', 'Southern Rock', 'Comedy', 'Cult', 'Gangsta', 'Top 40', 'Christian Rap', 'Pop/Funk', 'Jungle', 'Native American', 'Cabaret', 'New Wave', 'Psychedelic', 'Rave', 'Showtunes', 'Trailer', 'Lo-Fi', 'Tribal', 'Acid Punk', 'Acid Jazz', 'Polka', 'Retro', 'Musical', 'Rock & Roll', 'Hard Rock'];

  const QUADROS = {   // id v2.3/2.4 e v2.2 → campo
    TIT2: 'titulo', TT2: 'titulo', TPE1: 'artista', TP1: 'artista', TCON: 'genero', TCO: 'genero',
    TYER: 'ano', TYE: 'ano', TDRC: 'ano', TDRL: 'ano', TBPM: 'bpm', TBP: 'bpm', TKEY: 'tom', TKE: 'tom',
  };

  function textoDe(bytes, codificacao) {
    try {
      const dec = (rotulo, b) => new TextDecoder(rotulo).decode(b);
      if (codificacao === 1) return dec('utf-16', bytes);           // usa a BOM
      if (codificacao === 2) return dec('utf-16be', bytes);
      if (codificacao === 3) return dec('utf-8', bytes);
      return dec('latin1', bytes);
    } catch (_) {
      let s = ''; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return s;
    }
  }
  function limpar(s) { return String(s).replace(/﻿/g, '').replace(/\0+$/g, '').replace(/\0/g, ' / ').trim(); }

  function genero(bruto) {
    let t = limpar(bruto);
    const m = /^\((\d{1,3})\)\s*(.*)$/.exec(t);
    if (m) t = m[2] || GENEROS_V1[Number(m[1])] || '';
    else if (/^\d{1,3}$/.test(t)) t = GENEROS_V1[Number(t)] || '';
    return t;
  }
  function ano(bruto) { const m = /(\d{4})/.exec(String(bruto)); return m ? Number(m[1]) : null; }

  function sincronizado(b, i) { return ((b[i] & 0x7f) << 21) | ((b[i + 1] & 0x7f) << 14) | ((b[i + 2] & 0x7f) << 7) | (b[i + 3] & 0x7f); }

  function tamanhoCabecalho(bytes) {
    try {
      if (!bytes || bytes.length < 10 || bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) return 0;
      if (bytes[3] < 2 || bytes[3] > 4) return 0;
      return 10 + sincronizado(bytes, 6) + ((bytes[5] & 0x10) ? 10 : 0);
    } catch (_) { return 0; }
  }

  function guardar(tags, campo, bruto) {
    let v;
    if (campo === 'genero') v = genero(bruto);
    else if (campo === 'ano') v = ano(bruto);
    else if (campo === 'bpm') { const n = parseFloat(String(limpar(bruto)).replace(',', '.')); v = Number.isFinite(n) && n > 0 ? n : null; }
    else v = limpar(bruto);
    if (v !== '' && v !== null && v !== undefined && tags[campo] === undefined) tags[campo] = v;
  }

  function lerV2(bytes, tags) {
    const versao = bytes[3];
    const fim = Math.min(bytes.length, 10 + sincronizado(bytes, 6));
    const idLen = versao === 2 ? 3 : 4, cabLen = versao === 2 ? 6 : 10;
    let i = 10;
    if (versao >= 3 && (bytes[5] & 0x40)) {                      // cabeçalho estendido
      i += versao === 4 ? sincronizado(bytes, 10) : 4 + ((bytes[10] << 24) | (bytes[11] << 16) | (bytes[12] << 8) | bytes[13]);
    }
    while (i + cabLen <= fim) {
      if (bytes[i] === 0) break;                                  // preenchimento
      let id = '';
      for (let k = 0; k < idLen; k++) id += String.fromCharCode(bytes[i + k]);
      let tam;
      if (versao === 2) tam = (bytes[i + 3] << 16) | (bytes[i + 4] << 8) | bytes[i + 5];
      else if (versao === 3) tam = ((bytes[i + 4] << 24) | (bytes[i + 5] << 16) | (bytes[i + 6] << 8) | bytes[i + 7]) >>> 0;
      else tam = sincronizado(bytes, i + 4);
      const ini = i + cabLen;
      if (tam <= 0 || ini + tam > bytes.length) break;           // quadro truncado ou corrompido: para
      const campo = QUADROS[id];
      if (campo && tam >= 2) {
        const cod = bytes[ini];
        guardar(tags, campo, textoDe(bytes.subarray(ini + 1, ini + tam), cod));
      }
      i = ini + tam;
    }
  }

  function lerV1(bytes, tags) {
    const n = bytes.length;
    if (n < 128 || bytes[n - 128] !== 0x54 || bytes[n - 127] !== 0x41 || bytes[n - 126] !== 0x47) return;
    const base = n - 128;
    const campo = (de, ate) => limpar(textoDe(bytes.subarray(base + de, base + ate), 0));
    guardar(tags, 'titulo', campo(3, 33));
    guardar(tags, 'artista', campo(33, 63));
    guardar(tags, 'ano', campo(93, 97));
    const g = bytes[base + 127];
    if (g < GENEROS_V1.length) guardar(tags, 'genero', GENEROS_V1[g]);
  }

  // `bytes` = início do arquivo (ID3v2) e, se houver, os últimos 128 (ID3v1) em `fim`.
  function lerID3(bytes, fim) {
    const tags = {};
    try {
      if (bytes && bytes.length >= 10 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33 && bytes[3] >= 2 && bytes[3] <= 4) lerV2(bytes, tags);
    } catch (_) { /* tag quebrada: fica com o que já leu */ }
    try {
      lerV1(fim || bytes, tags);
    } catch (_) { /* sem v1 */ }
    return tags;
  }

  async function lerArquivo(arquivo) {
    try {
      if (!arquivo || typeof arquivo.slice !== 'function') return {};
      const cab = new Uint8Array(await arquivo.slice(0, 10).arrayBuffer());
      const total = Math.min(tamanhoCabecalho(cab), LIMITE_LEITURA);
      const inicio = total ? new Uint8Array(await arquivo.slice(0, total).arrayBuffer()) : cab;
      let fim = null;
      if (arquivo.size >= 128) fim = new Uint8Array(await arquivo.slice(arquivo.size - 128).arrayBuffer());
      return lerID3(inicio, fim);
    } catch (_) { return {}; }
  }

  function mesclar(faixa, tags) {
    const f = Object.assign({}, faixa);
    if (!tags) return f;
    if (tags.genero && !f.genero) f.genero = tags.genero;
    if (tags.ano && !f.ano) f.ano = tags.ano;
    if (tags.artista && !f.artista) f.artista = tags.artista;
    return f;
  }

  return { lerID3, tamanhoCabecalho, lerArquivo, mesclar, GENEROS_V1 };
});
