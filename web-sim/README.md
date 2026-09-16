# web-sim

Réplica em navegador dos olhos do [hesjustalittleguy.com](https://hesjustalittleguy.com) — o
chaveiro-bicho "lilguy". Dois motores independentes convivem aqui, construídos por caminhos
opostos, e vale entender a diferença antes de mexer em qualquer um.

O site original desenha através de um motor WASM compilado, alimentado por dois arquivos JSON
(`anim_data.json` e `behavior_data.json`). Não há loop de renderização para portar: o WASM é opaco.
Então a fidelidade veio de duas fontes — medir os pixels que ele desenha, e ler os dados que ele
consome.

## Os dois motores

### `lark.js` — runtime do formato Lark

Executa os dados do site diretamente. Nenhuma constante medida: cada forma, cor, tempo e transform
sai do JSON. É por isso que os **36 estados** e os **15 clipes** carregam sem trabalho por estado.

Página: `lark-artifact.html` · publicada em
<https://claude.ai/code/artifact/17a80038-274a-4afb-b5ef-b47b5deb8fad>

### `lilguy.js` — reimplementação medida

Reproduz **um** estado (`1b`, o padrão do site) a partir de constantes extraídas pixel a pixel com
Playwright. Elipses e primitivas geométricas, sem os paths do JSON. Cada estado novo exigiria uma
rodada de medição inteira — foi essa limitação que motivou o `lark.js`.

Página: `index.html` + `main.js` · versão publicada: `artifact.html` em
<https://claude.ai/code/artifact/c384d74b-840f-4fde-94ce-dfe256116786>

## Esta pasta é o instrumento de medida do firmware

O `lark.js` deixou de ser só uma réplica em navegador: ele foi **portado para o firmware do
ocellus** e roda no hardware como o modo **Lark Eyes** (id 56), desenhado por um rasterizador
scanline próprio num painel redondo de 240×240. O port vive na raiz do repo, em seis headers:

| camada | o que faz |
|---|---|
| `lark_raster.h` | preenchimento scanline de Béziers cúbicas fechadas — recorte e buraco saem da regra de paridade |
| `lark_data.h` | lê os dados empacotados no lugar, sem alocar |
| `lark.h` | o runtime: curvas, morph de path, giro, lift, convergência |
| `lark_scene.h` | desenha um estado inteiro com o olhar aplicado |
| `lark_behavior.h` | decide qual clipe toca e quando — porta do `behavior.js` |
| `lark_render.h` | o modo no firmware: toque vira olhar, e o quadro |

**A relação entre as duas metades é de direção única: esta pasta mede, o firmware é medido.** Os
números que o port afirma (área de tinta, extensão de cada olho, vão entre o par) são os que esta
página desenha, capturados pelos harnesses daqui. A consequência é a regra que mais importa no port:

> **Não reajustar constante nenhuma para o painel ficar bonito.** Todas foram medidas contra a
> original com Playwright, instrumento que o firmware não tem. Se algo parecer errado no aparelho,
> reproduzir aqui e medir aqui.

Duas diferenças conhecidas entre o que roda aqui e o que roda lá, ambas por falta de dado e não por
decisão de fidelidade:

- **`rot` e `rot3d` não desenham no firmware.** Suas lanes miram `eyes`, `group_eye_l` e
  `group_eye_r` — *grupos* — e o `tools/lark_pack.py` descarta os nomes dos nós, deixando-os
  identificados por tipo e lado. Tipo+lado resolve `eye_l/r` e `pup_l/r` com exatidão (o que cobre
  `idle`, os dois desvios de pupila, `pup_scale` e as três piscadas), mas não distingue um grupo de
  outro. As regras disparam e se substituem corretamente; só não movem pixel.
- **O sensor 15 é alimentado com 1.0 fixo no firmware.** Aqui ele nunca é alimentado, que é o que
  reproduz a original não piscando sozinha. No aparelho isso deixaria os olhos sem piscar nunca, e
  1.0 seleciona o conjunto saudável (`blink`/`blink2`/`blink3`). É uma **escolha**, documentada como
  escolha: nenhum dado diz o que o sensor 15 mede.

## O editor de clipes

`editor/` é uma aplicação React+Vite separada para **tocar e editar as animações**: escolhe um dos
15 clipes, toca, arrasta o playhead, arrasta keyframes na timeline, edita valores e curvas, cria
clipes novos, desfaz e refaz.

```sh
npm --prefix editor install     # uma vez
npm --prefix editor run dev     # http://localhost:8795
```

Ele **importa o `lark.js` daqui**, não uma cópia. Um clipe que toca certo no editor toca certo na
página do artifact e, pelo port em C++, no aparelho — um visualizador escrito "parecido com" o
runtime divergiria dele na primeira mudança, e a divergência seria invisível.

Por que em pasta própria, com `package.json` próprio: o `web-sim` não tem **nenhuma** dependência de
runtime, e isso vale manter, porque ele é o instrumento contra o qual o firmware é medido. Um editor
que quebre não pode quebrar o instrumento. Ele alcança para fora só em dois lugares, ambos leitura:
`../lark.js` e o `anim_data.json` do `lilguy-fork`.

**O que ele não edita:** as lanes `p`, que carregam os contornos de pálpebra como 24 números de
Bézier por keyframe. Elas aparecem na timeline e podem ser movidas no *tempo* — retimar uma piscada
é uma edição de verdade —, mas a forma é fixa. Editá-la bem exige um editor de curvas; editá-la mal
(escalar o contorno inteiro, por exemplo) produziria formas que a autoria original nunca fez, e
depois de exportadas seriam indistinguíveis do dado real.

**Como o trabalho sai daqui:** `exportar JSON` baixa um `anim_data.json` com a mesma forma do
arquivo do site, que o `tools/lark_pack.py` lê sem conversão. Para chegar no aparelho: gerar o
binário e regravar o firmware. Nada no editor escreve no hardware.

Coberto por `test/editor.spec.js`, cujo teste central não é "renderiza" e sim **"uma edição chega ao
canvas"** — a falha que um screenshot não pega é um editor que responde e não muda nada.

## Arquivos

| arquivo | o que é |
|---|---|
| `lark.js` | runtime do Lark: grafo de cena, paths, lanes, transforms |
| `behavior.js` | camada de comportamento: decide qual clipe toca e quando |
| `lark-artifact.html` | página do runtime, com o motor embutido (não usa módulos) |
| `anim_data.js` | `anim_data.json` do site, como `const ANIM_DATA` — 36 estados, 15 clipes |
| `behavior_data.js` | `behavior_data.json` do site, como `const BEHAVIOR_DATA` — 23 regras |
| `lilguy.js` | motor medido, um estado |
| `editor/` | editor de clipes (React+Vite, dependências próprias) — importa o `lark.js` daqui |
| `index.html` + `main.js` | página do motor medido |
| `artifact.html` | versão publicada do motor medido, tudo num arquivo |
| `tools/build-artifact.js` | gera `lark-artifact.html` a partir dos módulos |
| `tools/artifact-template.html` | CSS, DOM e marcadores de injeção da página |
| `tools/artifact-page.js` | wiring da página (CROP, selects, loop de render) |
| `tools/serve.js` | servidor estático sem dependências |
| `tools/lib/measure.js` | primitivas de medição — o único lugar onde se mede |
| `tools/lib/pages.js` | abre e dirige as duas páginas comparadas |
| `tools/lib/thresholds.js` | limiares de aceitação, em um lugar só |
| `tools/harness/*.js` | os quatro harnesses + a página de medição determinística |
| `tools/baseline/*.json` | números gravados; o diff deles é o artefato revisável |
| `test/*.spec.js` | gates: regressão de IoU e sincronia do artifact |

`lark-artifact.html` é **gerado**. Editar `lark.js`, `behavior.js`, `tools/artifact-page.js` ou
`tools/artifact-template.html` e rodar `npm run build`; `test/build.spec.js` falha se os dois
divergirem. Antes disso a cópia inline era mantida à mão e já havia derivado: o `draw()` dela limpava
o canvas incondicionalmente enquanto o do módulo não, e `behavior.js` tinha ganhado um método que a
página nunca recebeu.

Os dois `*_data.js` são os JSON originais embrulhados em `const`, porque a CSP dos artifacts bloqueia
`fetch` externo e a página precisa carregá-los via `<script src>`.

## O formato Lark, decodificado

Nada disso está documentado em lugar nenhum — foi tudo inferido dos dados e conferido contra o
pixel.

### Paths

`p` é uma **Bézier cúbica fechada** de 4 nós e 8 controles.

- **Poses de estado (12 pontos)** — nós nos índices 0, 3, 6, 9.
- **Paths de animação (14 pontos)** — só aparecem nas lanes `p` dos cinco clipes de piscada, e a
  forma canônica deles começa no **ponto 2**, dando a volta: pontos `(i+2) mod 14` para i = 0..11.
  `normalizePath` faz essa rotação; poses de 24 números passam inalteradas (identidade exata,
  conferida nos 166 paths de estado).

A prova da leitura de 12 pontos veio da `pup_l`, que é um círculo conhecido: os nós dão raio
36,95 × 36,9 e os controles caem a 0,542/0,477 do raio, em torno do 0,5523 que um círculo em Bézier
exige.

> Os 12 pontos **não** são amostras ao longo do contorno. Tratá-los assim foi o que produziu um olho
> visivelmente trêmulo numa tentativa anterior — são pontos de controle.

**O offset 2 não é chute.** Existem só dois paths de substituição distintos no dataset inteiro (um
por olho), reusados nos dez keyframes de lane `p`, então dá para pontuar todas as catorze rotações de
cada um. Rasterizando e medindo espessura de fita por coluna — a estatística que distingue fita plana
de fita irregular de mesma extensão:

| offset | espessura média | desvio por coluna |
|---|---|---|
| **2** | **4,71** | **0,98** |
| 13 | 6,84 | 2,29 |
| 10 | 3,52 | 2,37 |
| 0 (leitura antiga) | — | 5,50 |

Offset 2 ganha por 2,3× na estatística decisiva e ganha **identicamente nos dois paths**. Nele a
geometria é plana por construção: os índices 2, 3, 4 são um trio vertical colinear igualmente
espaçado e 5, 6, 7 um trio horizontal colinear — arestas retas, que é o que uma pálpebra fechada é.

As "nove leituras" anteriores não acharam porque giravam o array **achatado** de 28 números
(dessincronizando x de y) e/ou truncavam para 12 pontos **antes** de girar, descartando os pontos 12
e 13 — exatamente os que o offset 2 precisa. Eles são contorno, não "dado de wrap".

### Buracos e pálpebras

Dois campos que o formato usa e que ficaram sem leitura por muito tempo:

- **`c: "000000"` não é a cor preta — é um buraco.** O nó é perfurado do que o grupo já pintou
  (`destination-out`), e o fundo da página aparece através. Isso se esconde atrás do fato de que o
  fundo da original é `#111`: pupila preta sobre chão quase preto parece certa ao olho e só está
  errada para a medição.
- **`ul: true` recorta o nó ao contorno do olho irmão.** O próprio olho é a pálpebra: nos estados
  semifechados o path dele é um crescente raso, e tudo dentro do grupo (pupila, destaques) é cortado
  nele. Durante a piscada o recorte usa o path **animado** do olho, não o de repouso — senão a pupila
  aparece através de um olho fechado.

`b` **não** é retângulo de clip. Recortar cada nó ao próprio `b` foi medido nos 36 estados e não
mudou nada, porque `b` é só a caixa envolvente do path. Ele segue sendo o que resolve âncoras
normalizadas (`anc`/`piv`).

### Grafo de cena

```
eyes (grupo, raiz)
├── group_eye_l
│   ├── eye_l   (path, ll)   <- também é a pálpebra: recorta os irmãos
│   ├── pup_l   (path, lts)
│   └── h1_l, h2_l (path)    <- só nos estados 1d..5d (11 nós) e 6d (9)
└── group_eye_r
    ├── eye_r
    ├── pup_r
    └── h1_r, h2_r
```

30 dos 36 estados têm 7 nós; `6d` tem 9 e `1d`–`5d` têm 11. Os extras são paths de destaque,
parentados dentro de `group_eye_*` com seu próprio `z`.

Campos por nó: `type`, `p`, `b` (caixa, `[[minX,minY],[w,h]]` — **não** é centro), `c` (cor hex),
`ch` (filhos), `z` (ordem de pintura), `ll` (limite de deslocamento pelo olhar), `lts`
(look-to-scale).

### Animações

`lanes` é um array **plano**, alternando cabeçalho e keyframes:

```
[ {keypath, object}, [keyframes...], {keypath, object}, [keyframes...] ]
```

Keyframe: `{t, c, v}`, onde `c` é um id de curva e `u: true` significa "usar o valor de repouso do
objeto".

| keypath | valor |
|---|---|
| `p` | contorno de substituição |
| `t` | translação `[x,y,z]` em px |
| `s` | escala `[sx,sy]` |
| `o` | opacidade |
| `l` | direção do olhar `[x,y]` em −1..1 |
| `r` | rotação `{anc, ang}` — **radianos** |
| `t3d` | giro em perspectiva `{anc, ang, piv}` |

`object: ""` significa a raiz. **Toda** lane `l` é dirigida na raiz, nunca num nó nomeado.

### Curvas

Os ids (`0, 14, 15, 22, 23, 24`) indexam uma tabela compilada no WASM, ilegível. São aproximados em
`CURVES`. O `0` é degrau e importa: ele assume o valor de **destino** imediatamente. Ler como
"segura a origem" deixa a janela de invisibilidade da pupila com largura zero, e a pupila nunca
some durante a piscada.

## A camada de comportamento

`behavior_data.json` traz 23 regras. Cada uma: `i` (id), `c` (categoria), `t` (gatilho), `o`
(condições), `a` (ações).

**Cinco rodam** de cada vez — `br.runnableRules()` responde exatamente isso, avaliando também as
condições contra os sensores como estão alimentados:

| sensor 15 | regras que rodam |
|---|---|
| nada alimentado | `init`, `rot`, `rot3d` (3) |
| 0,9 (o que a página usa) | + `blink_ambient`, `blink_look` (5) |
| < 0,3 | + `blink_ambient_s`, `blink_look_s` **no lugar** das duas acima (5) |

São cinco, não as sete que este projeto afirmava: as quatro regras de piscada formam **dois pares
mutuamente exclusivos** dos dois lados de 0,3, e só um par pode valer por vez.

As outras dezoito citam **35 clipes ausentes** deste build (`dance_hp`, `spin_h`, `curious_3`,
`eye_scale`, `heart_sprites`…) — ficam registradas, nunca disparam. Mantidas em vez de removidas para
o conjunto espelhar os dados.

> `runnableRules()` também contava errado: varria todo payload de ação procurando `.i`, e as ações 12
> e 13 (suspender/retomar categoria) carregam nome de **categoria**, não de clipe. Reportava 21.

Códigos decodificados:

| gatilhos | | condições | | ações | |
|---|---|---|---|---|---|
| `1 {l,u}` | intervalo aleatório em **segundos** | `0 [...]` | lista, todas valem | `0 {i}` | toca o clipe |
| `4 {}` | humano chega | `14/15 {o,v}` | comparação de sensor | `1 {o[]}` | sorteio por peso |
| `6/7` | sensor / acelerômetro | | | `6 {s}` | prossegue com probabilidade `s` |
| `10 {v}` | o olhar moveu mais que `v` | | | `8 {t,d}` | dirige o olhar |
| `11 {}` | uma vez, no boot | | | `10/11`, `12/13` | trava/destrava, suspende/retoma categoria |

**Categoria importa.** Clipes de uma mesma categoria se substituem. Sem isso, um arrasto lento do
mouse acumulava 31 piscadas simultâneas — e como a última a escrever vence, a mais recente (recém-
começada, olho aberto) sobrescrevia as outras a cada frame: 31 disparos, zero frames fechados.

**Sensor 15 é o único valor inventado.** As quatro regras de piscada dependem dele, e o build web
nunca o alimenta. Mas a referência pisca a cada 2,5–5s, que é exatamente o intervalo do
`blink_ambient` — logo ela o alimenta. A página usa 0.9 e expõe um slider, para a suposição ficar
visível. Abaixo de 0,3 entram `blink4`/`blink5`, que na web nunca aparecem.

O gatilho `10` também ganhou um piso de 2,5s entre disparos da mesma categoria. Ele compara frames
consecutivos, então um arrasto constante cruza o limiar de 0,04 em quase todos. O dado não traz
cooldown; 2,5s é o menor intervalo que o próprio JSON pede em qualquer lugar.

## Fidelidade atual

Tudo abaixo é medido pelos harnesses deste repositório contra a referência rodando ao vivo, e todo
número é reproduzível com um comando.

| | referência | runtime | comando |
|---|---|---|---|
| IoU dos 36 estados | — | **média 97,18%**, mín 91,30%, máx 99,76% | `npm run measure:iou` |
| piscada fechada: espessura | 5,51px | **5,41px** | `npm run measure:blink` |
| piscada fechada: desvio/coluna | 1,02 | **0,92** | idem |
| piscada fechada: altura | 24px | **24px** | idem |
| vão entre olhos, repouso | 152 | **151,5** | `npm run measure:gaze` |
| vão entre olhos, meia deflexão | 147 | **147,5** | idem |
| largura por olho, meia deflexão | 142/153 | **142/153** | idem |
| deslocamento horizontal total | 23px | **23px** | idem |
| espelhamento em `rot3d_2` | — | **1px** de erro | `npm run measure:t3d` |

`npm test` compara os 36 estados com `tools/baseline/states.json` e falha nas **duas** direções: uma
queda abaixo do piso é regressão, e uma melhora além do epsilon também falha, para que um ganho
aceito seja sempre um commit deliberado no baseline em vez de deriva silenciosa.

### Pendências

**Perspectiva do par sob deflexão.** Nos extremos do olhar a referência contrai o par ~3px mais que
nós (144,5 contra 147,5) e as larguras por olho erram 3px (136/159 aqui, 133/156 lá). Em repouso e em
meia deflexão bate. Isso pertence à projeção que `t3d` aplica ao grupo, que `applyT3d` aproxima com um
squash de 1 eixo por `|sin(ang)|` e sem nunca ler `anc`. O lugar de validar uma projeção de verdade é
`rot3d_2`, que dirige `t3d` exatamente em `group_eye_l`/`group_eye_r` com `anc` espelhado
(`[1,0]`/`[-1,0]`) — `npm run measure:t3d` já checa esse espelhamento.

Não ajustar constante de convergência no caminho do look. Foi tentado duas vezes e revertido:
contraía o vão mas arrastava as pupilas, dando a elas −17px de deslocamento vertical sob olhar
puramente horizontal, que a referência nunca mostra.

## Sobre medir

Dois servidores locais: **8793** serve a referência (arquivos estáticos de `lilguy-fork/public`, que
dirigem o WASM real — não precisa de build Next.js) e **8794** serve esta pasta.

```sh
npm install && npx playwright install chromium
npm run serve:ref &   # 8793
npm run serve:sim &   # 8794
npm run baseline      # regrava tools/baseline/states.json
npm test              # gate de regressão
```

Os harnesses ficam em `tools/harness/` e as primitivas de medição em `tools/lib/measure.js`, que é o
único lugar onde se mede. Três lições estão travadas ali em código, cada uma porque custou números
errados publicados:

**Flood fill mede errado nos extremos.** O vão entre os dois olhos é de 9,2px, então qualquer
antialiasing funde os dois num blob só e as larguras viram lixo. Isso produziu **três diagnósticos
errados** — o giro 3D dado como não implementado quando já funcionava, um "colapso" do estado 6a que
era o ponteiro deflexionado da checagem anterior, e uma "fusão" dos olhos atribuída a um squash que
não a causava. `columnScan` varre por coluna dentro de **uma metade** do canvas e nunca cruza a linha
do meio. Não existe flood fill neste repositório.

**Ler CSS pixel infla tudo.** `lark-artifact.html` tem canvas com backing store de 372px e CSS de
420px, então qualquer leitura via `getBoundingClientRect` vem 420/372 = **1,129×** maior. Esse fator
único é a antiga pendência inteira de "nosso vão é 168 contra 152, os olhos são ~11% maiores":
168/1,129 = 148,8, e o vão do próprio dado é 151,62. Nunca houve erro de escala no runtime.
`captureBackingStore` lê `getImageData` sobre `canvas.width/height` e grava a razão CSS/backing em
todo output, para uma inflação futura aparecer em vez de se esconder.

**Milissegundo, não contagem de amostras.** Comparar nosso `t=250` contra o mínimo global da
referência compara momentos diferentes. Contar amostras entre duas páginas com taxas de leitura
distintas (7399 contra 3315 numa mesma janela) não sustenta conclusão nenhuma. Todo harness nomeia
offsets de ms explícitos e usa os mesmos nos dois lados.

Duas armadilhas a mais, vivas, que pegaram estes harnesses durante o desenvolvimento:

- **O mouse do Playwright começa em (0,0)**, que nesse layout fica acima e à esquerda da referência —
  então o olhar dela está deflexionado antes da primeira medição. Toda captura da referência precisa
  de um `look(0,0)` explícito antes. Sem isso o IoU de `1b` dá 0,825 e o vão dá 147, e parece
  diferença real de convergência.
- **A referência pisca sozinha** a cada 2,5–5s, num relógio dentro do WASM que não dá para desligar.
  Uma captura única cai em olho fechado com frequência suficiente para importar — a primeira execução
  do harness de IoU reportou 0,03 com bbox de 258×25, que é uma piscada, não uma pose de repouso.
  `captureOpen` amostra uma janela e fica com o quadro de **maior** área; `referenceClosed` faz o
  inverso e fica com o de menor.
