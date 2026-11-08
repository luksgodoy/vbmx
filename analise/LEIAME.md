# Análise local de BPM e tom (VB-02)

Ferramenta para medir se o Essentia.js (WASM) acerta BPM e tom (Camelot) nas faixas do
Lucas. O áudio nunca sai do navegador e nunca é gravado.

## Arquivos

| Arquivo | Para quê |
|---|---|
| `avaliar-essentia.html` | Página de avaliação (abre direto no Chrome, precisa de internet para o CDN) |
| `camelot.js` | Nota + modo → Camelot (1A–12B), normaliza rótulos, compara tom e BPM |
| `testar-camelot.js` | `node analise/testar-camelot.js` — 24 tonalidades, enarmonias, comparações |
| `avaliar-grade.js` | Harness: roda a análise de grade do app (`biblioteca/bpm.js`) sobre `amostra-rotulada.json` e compara BPM e fase do 1 com o rótulo |
| `testar-avaliar-grade.js` | Portão do harness, com WAVs sintéticos gerados no diretório temporário |
| `amostra-rotulada.json` | Saída da página (só nome do arquivo + rótulos + detectados). Ainda não existe |

## Como usar

1. Abra `analise/avaliar-essentia.html` no Chrome (duplo clique ou `open`).
2. Espere "Essentia.js pronto". Biblioteca carregada do jsDelivr, `essentia.js@0.1.3` fixa.
3. "Escolher pasta" (ou "Escolher arquivos") com as ~20 faixas. A página analisa até 90 s
   do meio de cada uma (mono, 44,1 kHz) e preenche BPM, Camelot e a força do tom.
4. Digite nas colunas "do Lucas" o BPM e o Camelot reais. O Camelot aceita `8A`, `Am`,
   `C#m`, `Bb maior`. O resumo de acerto se atualiza a cada tecla.
5. "Exportar amostra-rotulada.json" e salve em `analise/`. "Carregar rótulos" reabre um
   arquivo exportado para continuar de onde parou (as faixas precisam ser escolhidas de novo
   para recalcular; os rótulos e detectados salvos voltam sozinhos).
6. "Testar com tom sintético" confere que a página e o Essentia estão vivos, sem usar música.

## Como rotular ~20 faixas

- **Escolha variada**: vários estilos e andamentos, algumas com mudança de tom ou BPM
  instável, algumas de batida suave. Faixa fácil sozinha infla o acerto.
- **Rotule antes de olhar o detectado** (as colunas ficam lado a lado; tape a esquerda).
  Use o Mixed In Key, o Rekordbox ou o ouvido, mas diga qual na hora de reportar.
- BPM: o que você contaria na pista (a batida que se bate o pé), com casa decimal se souber.
- Tom: em Camelot ou em nota; na dúvida entre relativos, deixe em branco em vez de chutar.

## O que se mede (meta: 95%)

| Métrica | Conta como acerto |
|---|---|
| BPM ±2 | `|detectado − rótulo| ≤ 2` |
| BPM com dobro/metade | ±2, ou detectado ≈ 2× ou ½ do rótulo (relatado à parte) |
| Tom exato | mesmo código Camelot |
| Tom exato ou relativo | mesmo número, letra trocada (8A ↔ 8B) — mixa bem junto |
| Tom exato, relativo ou vizinho | ±1 no mesmo anel (8A ↔ 9A/7A) — também mixa |

A meta de 95% vale para **BPM ±2** e **tom exato ou relativo**; vizinho e dobro/metade são
informativos (mostram se o erro é "quase" ou "longe"). Com 20 faixas, cada faixa pesa 5
pontos: 95% é no máximo 1 erro.

## Limites conhecidos

- O BPM/Tom do tom sintético do teste automático não é evidência de acerto em música real.
- Só os rótulos entram no repositório; o `.gitignore` já barra mp3/wav/aiff.

## Harness da grade (`avaliar-grade.js`)

`node analise/avaliar-grade.js [amostra-rotulada.json] [--detalhe arquivo.json]` imprime só o topo
(BPM ±2, dobro/metade à parte, mediana/p90 do erro de fase do 1 em ms, quantas acima de 20 ms, lista das
faixas que erraram). A tabela completa vai para `analise/avaliacao-grade-detalhe.json`.

Campos que o harness lê, além dos que a página já exporta (`arquivo`, `rotulo.bpm`):

| Campo | Para quê |
|---|---|
| `rotulo.primeiro_1_s` | **Novo, opcional.** Posição, em segundos da faixa, de um 1 do compasso (qualquer um: o erro é medido contra a linha de compasso mais próxima, a cada 4 batidas). Sem ele só o BPM é avaliado |
| `caminho` | **Novo.** Caminho local do áudio, relativo ao JSON. O harness só decodifica **WAV**; mp3 precisa ser convertido fora do repositório |
| `candidatos` | **Novo.** `{ inicio_s, janela_s?, lista: [{ nome, bpm, ticks? }] }`: o que o Essentia (multifeature, degara, percival) entregou ao `resolver`, com os ticks em segundos a partir de `inicio_s` |

Limite conhecido: a página `avaliar-essentia.html` ainda **não exporta** `caminho`, `candidatos` nem
`rotulo.primeiro_1_s` (hoje guarda só o BPM e o tom detectados). Sem `candidatos` a faixa é pulada
(`sem_candidatos`): o Node não roda o Essentia. Exportar os candidatos do worker de
`biblioteca/painel.js` e o campo do 1 na tabela é o passo seguinte, antes de rotular as faixas reais.
O JSON guarda só rótulos, ticks e o caminho local; nunca áudio.

`node analise/testar-avaliar-grade.js [--tabela]` é o portão (também roda em `./testar.sh`): gera os
WAVs sintéticos em `os.tmpdir()`, inclusive DnB a 174 com intro sem bumbo, baixo na batida 2 e o caso
do VB-65 (estimadores lendo 87), e apaga tudo no fim.
