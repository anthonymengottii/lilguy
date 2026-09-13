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

## Arquivos

| arquivo | o que é |
|---|---|
| `lark.js` | runtime do Lark: grafo de cena, paths, lanes, transforms |
| `behavior.js` | camada de comportamento: decide qual clipe toca e quando |
| `lark-artifact.html` | página do runtime, com o motor embutido (não usa módulos) |
| `anim_data.js` | `anim_data.json` do site, como `const ANIM_DATA` — 36 estados, 15 clipes |
| `behavior_data.js` | `behavior_data.json` do site, como `const BEHAVIOR_DATA` — 23 regras |
| `lilguy.js` | motor medido, um estado |
| `index.html` + `main.js` | página do motor medido |
| `artifact.html` | versão publicada do motor medido, tudo num arquivo |

Os dois `*_data.js` são os JSON originais embrulhados em `const`, porque a CSP dos artifacts bloqueia
`fetch` externo e a página precisa carregá-los via `<script src>`.

## O formato Lark, decodificado

Nada disso está documentado em lugar nenhum — foi tudo inferido dos dados e conferido contra o
pixel.

### Paths

`p` é uma **Bézier cúbica fechada** de 4 nós e 8 controles.

- **Poses de estado (12 pontos)** — nós nos índices 0, 3, 6, 9.
- **Paths de animação (14 pontos)** — só aparecem nas lanes `p` dos cinco clipes de piscada.

A prova da leitura de 12 pontos veio da `pup_l`, que é um círculo conhecido: os nós dão raio
36,95 × 36,9 e os controles caem a 0,542/0,477 do raio, em torno do 0,5523 que um círculo em Bézier
exige. A silhueta em repouso bate com a original a **99,1% de IoU**.

> Os 12 pontos **não** são amostras ao longo do contorno. Tratá-los assim foi o que produziu um olho
> visivelmente trêmulo numa tentativa anterior — são pontos de controle.

### Grafo de cena

```
eyes (grupo, raiz)
├── group_eye_l
│   ├── eye_l   (path, ll)
│   └── pup_l   (path, lts)
└── group_eye_r
    ├── eye_r
    └── pup_r
```

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

**Sete rodam** com os clipes embarcados: `init`, `blink_ambient`, `blink_look`, `blink_ambient_s`,
`blink_look_s`, `rot`, `rot3d`. As outras dezesseis citam **32 clipes ausentes** deste build
(`dance_hp`, `spin_h`, `curious_3`, `eye_scale`, `heart_sprites`…) — ficam registradas, nunca
disparam. Mantidas em vez de removidas para o conjunto espelhar os dados.

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

Medido contra a referência rodando ao vivo:

| | referência | runtime |
|---|---|---|
| pose de repouso | — | **99,1% de IoU** |
| deslocamento horizontal | 48px | 46px |
| piscadas num arrasto lento | 8/41 quadros | 9/41 |
| giro (largura do olho L) | 160→112 | 187→140 |
| pupila dentro do olho | 3/−13 | 1/−3 |

### Pendências

**Convergência do par.** Na referência a distância entre os centros dos olhos encolhe de 152 para
136px nos extremos; aqui fica fixa em 164. Puxar cada grupo para o centro por |look|² foi tentado e
revertido: contraía o vão (168 → 156) mas arrastava as pupilas junto, dando a elas −17px de
deslocamento vertical sob olhar puramente horizontal. O problema de fundo é que o vão em repouso já
é 168 contra 152 — os olhos são ~11% maiores — então um fator ajustado para fechar seria o número
certo pelo motivo errado.

**Forma da piscada fechada.** A referência deixa uma fita plana de ~5,4px (desvio 1,00 por coluna);
esta deixa uma irregular de ~10px. **Nove leituras** do contorno de substituição foram medidas
contra o pixel — 14 pontos como cúbica, como polilinha, quadráticas alternadas, Catmull-Rom,
reordenação nós-primeiro, e offsets 0/1/2/3 — e nenhuma produziu a fita plana. A altura do
fechamento e o sumiço da pupila estão corretos; só o contorno não.

## Sobre medir

Todos os harnesses de Playwright ficam no scratchpad da sessão, fora do repositório. Dois servidores
locais: **8793** serve a referência (o clone Next.js em `lilguy-fork/public`) e **8794** serve esta
pasta.

Uma lição cara desta sessão: **flood fill mede errado nos extremos.** O vão entre os dois olhos é de
9,2px, então qualquer antialiasing funde os dois num blob só, e as larguras viram lixo. Isso
produziu **três diagnósticos errados** — o giro 3D dado como não implementado quando já funcionava,
um "colapso" do estado 6a que era o ponteiro deflexionado da checagem anterior, e uma "fusão" dos
olhos atribuída a um squash que não a causava. Varredura por coluna, em cada metade do canvas,
mede certo.

O mesmo vale para escolher instantes: comparar nosso `t=250` contra o mínimo global da referência
compara coisas diferentes. E contar amostras entre duas páginas com taxas de leitura distintas
(7399 contra 3315 numa mesma janela) não sustenta conclusão nenhuma — só milissegundos sustentam.
