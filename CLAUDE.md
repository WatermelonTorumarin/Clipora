# Clipora — guia do projeto

Clipora é um app web **pessoal e local** do Kaleb: um servidor
Node/Express que usa **yt-dlp** e **FFmpeg** para baixar vídeos (YouTube, X/Twitter, Reddit,
Instagram e o que mais o yt-dlp suportar), baixar imagens do Instagram, DeviantArt e ArtStation,
baixar **todas as imagens de uma página** (X, Instagram, Reddit, MangaDex, sites de leitura e páginas
comuns) para uma pasta, cortar trechos, recortar a imagem, comprimir e gerar GIF. A interface é toda
em português.

Este arquivo existe para que qualquer sessão do Claude (neste PC ou no TI-SERVER) consiga continuar
o trabalho sem o histórico da conversa original. Mantenha-o atualizado quando mudar algo relevante.

## Estado atual (03/11/2026)

- Roda em `http://localhost:3000`. Não gaste esforço com layout de celular, login ou exposição
  pública (internet aberta) enquanto o usuário não pedir.
- **Hospedagem (03/11/2026):** o Clipora "oficial" fica no **TI-SERVER** (`C:\clipora`) e é usado
  pelos outros aparelhos da tailnet do usuário (ex.: TI-KALEB). O HTTPS do Tailscale foi
  ativado no painel. Endereço principal (04/11/2026): **`https://clipora.<sua-tailnet>.ts.net`**, um
  **Tailscale Service** (`svc:clipora`, IP 100.93.170.23), escolhido pelo usuário em vez de renomear
  o PC; ver "Endereço clipora" abaixo. `https://ti-server.<sua-tailnet>.ts.net` (`tailscale serve --bg
  3000`) continua ligado como reserva. Os dois são só da tailnet. O nome `<sua-tailnet>` é da tailnet e
  não dá para trocar por "clipora".
- Os endereços antigos `http://100.64.0.10:3000` (Tailscale) e `http://192.168.0.10:3000` (rede
  local) continuam abertos **por escolha do usuário** (03/11/2026). Ele também preferiu **não** ligar
  o Clipora sozinho no logon: continua pelo `iniciar-clipora.bat`. Por isso tudo que grava no disco
  ou abre algo na tela diferencia "navegador neste PC" de "navegador em outro PC"
  (`isLocalRequest`, ver "Navegador em outro PC").
- No TI-SERVER o Clipora é iniciado pelo `iniciar-clipora.bat` (fora do pacote; atalho "Clipora"
  na Área de Trabalho). Quando o servidor responde, ele abre `https://clipora.<sua-tailnet>.ts.net`
  (pedido do usuário em 04/11/2026); se esse endereço não responder em 5 s (Tailscale desligado),
  abre `http://localhost:3000`. O arquivo é CRLF e só ASCII. A pasta de lá também tem `clipora.ico` e `desktop.ini` (ícone da
  pasta), igualmente fora do pacote: a restauração não os apaga.
- Não há git. Backups manuais ficam em `D:\clipora-backup-AAAA-MM-DD` no TI-KALEB (último:
  2026-11-03-v5, antes da junção com o TI-SERVER) e em `C:\clipora-backup-AAAA-MM-DD` no TI-SERVER
  (último: 2026-11-03, a API 7 de antes da junção).
- Até 03/11/2026 as duas cópias andaram separadas: o TI-SERVER fez o acesso por outro PC (API 7) e
  este PC fez "todas as imagens de uma página" (API 6). A junção das duas é a **API 8**. Antes de
  restaurar o pacote em qualquer PC, confira se lá não há mudanças que ainda não estão no pacote.
- Versão da API: `API_VERSION = 10` (servidor, `public/js/api.js` e o `config.js` gerado da
  extensão precisam bater; a 9 acrescentou `fileBase` ao `/api/info` de vídeo, em 06/11/2026; a 10,
  em 09/11/2026, os posts com várias imagens no coletor, e serve para a extensão antiga pedir para
  ser baixada de novo). Extensão na versão 1.1.0.
- O pacote para restaurar/atualizar o projeto em outro PC é o Artifact privado
  https://claude.ai/artifact/XEXFeEb63txHRGhbDLqtrJ. Depois de mudanças relevantes, republique esse
  Artifact.

## Como rodar

1. Instale o Node.js LTS (o desenvolvimento foi feito com Node 24 e npm 11).
2. Execute `instalar.cmd`. Ele faz `npm install`, baixa o FFmpeg e o yt-dlp, atualiza o yt-dlp e
   inicia o servidor.
3. Para iniciar depois: `npm.cmd start` nesta pasta.

Detalhes que já causaram problema:

- **npm 11 não executa scripts de instalação.** Sem eles, `ffmpeg-static` e `youtube-dl-exec` ficam
  sem binário. O `instalar.cmd` roda `node node_modules\ffmpeg-static\install.js` e
  `node node_modules\youtube-dl-exec\scripts\postinstall.js` quando os binários faltam.
- `YOUTUBE_DL_SKIP_PYTHON_CHECK=1` evita que o pacote exija Python (a máquina não tem Python).
- Mudou `server.js`? O usuário precisa fechar o servidor (Ctrl+C) e rodar `npm.cmd start` de novo.
  Mudou só `public/`? Basta Ctrl+F5 na página.
- Se a página e o servidor estiverem em versões diferentes, a página mostra "O servidor do Clipora
  está desatualizado". Sempre que mudar o formato de uma resposta da API, aumente `API_VERSION` nos
  dois lugares.

## Estrutura

```
server.js            servidor Express (tudo do back-end em um arquivo)
instalar.cmd         instalador para Windows (manter só ASCII: o cmd mostra acentos errados)
package.json         dependências: express 5, ffmpeg-static 5, youtube-dl-exec 3
public/index.html    página única: início, galeria do Instagram, editor e ferramentas
public/styles.css    estilos (tema escuro roxo/ciano; fontes DM Sans e Manrope)
public/favicon.svg
public/js/           módulos ES (carregados com <script type="module">)
  app.js       página inicial, busca, download direto, rotas (#gif, #comprimir, #recortar, #imagens,
               #importar=, #buscar=), cartão da extensão, soltar arquivo
  coletor.js   coletor de imagens que a extensão injeta na página do site (não roda no Clipora)
  api.js       chamadas à API, sessão perdida, heartbeat, download por iframe oculto
  progress.js  painel flutuante de progresso
  editor.js    editor completo: timeline, cortes, bordas arrastáveis, recorte, exportação
  tools.js     as três ferramentas rápidas
  crop.js      caixa de recorte livre (CropSelector), usada pelo editor e pela ferramenta
  range.js     seletor de trecho com duas barras e tempos digitados (RangeSelector)
  gallery.js   galeria de imagens (posts, obras e páginas inteiras), seletor de quantidade e
               "Salvar em uma pasta" com destino (Área de Trabalho, Downloads ou outra pasta)
  util.js      formatação de tempo, tamanhos e estimativas
extensao/            extensão do Chrome/Edge (Manifest V3), entregue em /clipora-extensao.zip
  manifest.json  permissões: activeTab, scripting, storage; hosts *.ts.net, localhost
  background.js  clique no ícone abre janela.html; abre a aba do Clipora pedida pelo coletor
  janela.*       a janelinha: vídeo (qualidade) e imagem única baixam direto; senão coleta
  ajustes.js     endereço do Clipora (chrome.storage.sync; padrão no config.js)
  config.js      só para testes: o .zip troca por um gerado (endereço de origem + API)
  icones/        PNGs 16/32/48/128 (seta de download branca no roxo do Clipora)
```

## Extensão do navegador (pedido de 06/11/2026)

Substituiu o antigo botão de favoritos (retirado do site em 06/11/2026; o Chrome não deixava
favorito `javascript:` ter ícone). O cartão "Baixar Imagens" tem o download do .zip, os passos de
instalação e uma lista "Como usar" (`#browser-help-steps`, montada por `showBrowserHelp`). Instalação: "Carregar sem compactação" com o Modo do
desenvolvedor; as instruções ficam no cartão "Baixar Imagens" (`#imagens`) do site.

- **Pacote**: `GET /clipora-extensao.zip` monta na hora `clipora-extensao/` com os arquivos de
  `extensao/`, o `public/js/coletor.js` (o coletor de imagens) e dois gerados:
  `config.js` (`CLIPORA_PADRAO` = endereço de onde o .zip foi baixado, por `X-Forwarded-Host/Proto`
  ou `Host`; `API_ESPERADA`) e `manifest.json` com esse endereço em `host_permissions` (sem porta).
  `GET /clipora-extensao-icone.png` serve o ícone 128 para o cartão do site.
- **Clique no ícone**: abre `janela.html` numa janela `popup` (não `default_popup`: a janela
  "Salvar como" fecharia o pop-up do ícone). A janela pergunta ao Clipora (`/api/info`):
  - vídeo → lista as qualidades; clicar numa abre o **"Salvar como" do Windows** já com o nome
    (`fileBase` + `-720p.mp4`), depois `POST /api/downloads`, acompanha e grava o MP4 no arquivo
    escolhido (`showSaveFilePicker` + `createWritable`). Não abre o site.
  - galeria com 1 imagem (DeviantArt, foto única) ou aba que é só uma imagem (`document.contentType`
    image/*, vai por `POST /api/gallery/import` com 1 item) → busca o arquivo e mostra "Baixar
    imagem" (um clique abre o "Salvar como").
  - página com várias imagens (`page: true`), `needs_browser`, `artstation_blocked` → injeta o
    coletor na aba (`chrome.scripting.executeScript`, `collectorScript(base, { extension: true })`)
    e fecha. Com `extension: true` o coletor manda `chrome.runtime.sendMessage({ type:
    "clipora-abrir", url })` (o background abre a aba, só se o endereço for do Clipora) e **envia
    sozinho** quando a rolagem termina.
  - post com várias mídias (carrossel do Instagram) → abre o site com `#buscar=`.
- **Onde salvar**: o "Salvar como" começa na Área de Trabalho (`startIn: "desktop"`) e, depois do
  primeiro download, na pasta do último arquivo salvo (handle guardado no IndexedDB
  `clipora-extensao`). Escolheu-se `showSaveFilePicker` porque o Chrome não deixa escolher a
  própria Área de Trabalho/Downloads como pasta em `showDirectoryPicker` ("contém arquivos do
  sistema"), e porque a janela precisa de clique do usuário (por isso o picker abre antes do
  preparo do vídeo).
- Engrenagem da janela: troca o endereço do Clipora (pede permissão de host se for fora do
  manifesto). Versão diferente da API → pede para baixar a extensão de novo.

## Servidor (`server.js`)

**Fila.** Todas as tarefas pesadas passam por uma fila única (`MAX_CONCURRENT_DOWNLOADS = 1`):
downloads, preparo de sessões, exportações, miniaturas extras e salvamento de pastas. O tipo de tarefa
fica em `job.operation` (`download`, `prepare_local`, `export`, `assets`, `gallery_folder`) e o
processador é escolhido em `runDownloadQueue`.

**Downloads de vídeo.** Primeiro tenta formatos H.264 + AAC (só junta, sem recodificar). Se falhar,
baixa o melhor formato e verifica o codec: se já for H.264/AAC só troca o contêiner (`-c copy`); se
não, converte. `height = 0` significa "melhor disponível". `item` escolhe a mídia dentro de um post
com várias (vídeos de carrossel do Instagram).

**Sessões do editor** (`/api/editor-sessions`) têm uma finalidade:

- `probe`: só lê as informações (ferramenta Comprimir, sem player).
- `player`: vídeo reproduzível no navegador (ferramentas GIF e Recortar).
- `editor`: player + miniaturas e forma de onda da timeline.

`prepareSessionMedia` converte o vídeo para H.264 **quando o codec não toca no Chrome**
(HEVC/H.265, ProRes etc.), não pela extensão. `POST /:id/assets` completa uma sessão para `editor`
sem baixar de novo ("Abrir no editor completo").

**Exportação** (`processEditorExportJob`):

- Recorte livre chega como frações `{x, y, w, h}` + `scaleMode` (`real` = pixels da área,
  `fit` = amplia até caber no quadro original sem deformar).
- Um trecho só usa `-ss`/`-t` **antes** do `-i` (senão o GIF lia o vídeo inteiro).
- GIF: até 10 s, 320/480/640 px no lado maior, 10/15/24 fps, paleta própria (`palettegen`).
- Compressão por nível (`light`, `medium`, `strong`) usa CRF com teto de bitrate relativo à fonte
  (`sourceShare`), para nunca sair maior que o original.
- Tamanho alvo usa duas passagens e nunca passa do bitrate da própria fonte.
- `GET /:id/file?keep=1` mantém a sessão para "Fazer outro com o mesmo vídeo".

**Galerias de imagens.** Instagram, DeviantArt e ArtStation montam a mesma galeria com
`registerGallery`: os endereços das mídias ficam só no servidor (`galleryPosts`, por chave) e a
página pede por `/api/gallery/:key/:index/...`. O proxy só baixa o que o próprio servidor extraiu.
Cada item pode ter `fallbackUrls` (tenta a melhor qualidade e cai para a seguinte). "Salvar em uma
pasta" (`processGalleryFolderJob`) grava em `<destino>\<nome>` como `<nome>1`, `<nome>2`...; se o
nome terminar em número ganha hífen (`cap 12-1`); se a pasta existir, cria `<nome> (2)`. Destino:
`desktop` (padrão), `downloads` (ambos lidos do registro do Windows) ou `custom` (pasta escolhida na
janela "Procurar pasta" do Windows, aberta por `POST /api/folders/pick` via PowerShell com
`FolderBrowserDialog` e uma janela dona invisível "sempre na frente"). `indices` escolhe quais mídias
e em que ordem. As imagens são baixadas 4 por vez, gravadas na ordem; a que falha é pulada (sem
buraco na numeração) e entra em `failedCount`; 429/503 esperam e tentam de novo. O tipo do arquivo
vem dos primeiros bytes (`sniffImageExtension`).

**Navegador em outro PC (Tailscale).** Tudo o que grava no disco ou abre algo na tela depende de
onde está o navegador. `isLocalRequest`: pedido direto (sem cabeçalho de proxy e `Host` que não
termina em `.ts.net`) é "este PC" se vier do loopback ou de um IP do próprio PC (inclusive o do
Tailscale). Pedido pelo `tailscale serve` (cabeçalho `X-Forwarded-*`/`Tailscale-User-Login` ou
`Host` `.ts.net`) chega de 127.0.0.1; aí vale o **último IP do `X-Forwarded-For`**, que o Tailscale
preenche com o IP do aparelho que pediu (testado em 04/11/2026: ele descarta o `X-Forwarded-For` e o
`Tailscale-User-Login` mandados pelo navegador). Se for um IP deste PC (o TI-SERVER abrindo
`https://clipora...`), é "este PC"; senão, outro PC. O `X-Forwarded-For` só é aceito quando o socket
é loopback: um aparelho da rede que forje o cabeçalho continua sendo outro PC. O TI-SERVER tem tag,
então pedidos dele não trazem `Tailscale-User-Login` (só os de aparelhos com usuário, como o
TI-KALEB). A galeria responde `saveMode: "server"` ou `"browser"`.

**Endereço clipora (Tailscale Service, ligado em 04/11/2026).** `https://clipora.<sua-tailnet>.ts.net`
sem renomear o PC. O host de um Service **precisa ser um aparelho com tag**: o TI-SERVER agora é
`tag:clipora` e não pertence mais à conta do usuário (ele foi avisado e aceitou). O que foi feito:
(1) política da tailnet (era a padrão, "libera tudo") ganhou `tagOwners` `"tag:clipora":
["autogroup:admin"]`, a grant `{ "src": ["autogroup:member"], "dst": ["svc:clipora"], "ip": ["443"] }`
e `autoApprovers.services` `"svc:clipora": ["tag:clipora"]` (por isso o host é aprovado sozinho);
(2) Machines › ti-server › Edit ACL tags › `tag:clipora`; (3) Services › Define Service `clipora`,
porta `tcp:443`; (4) no TI-SERVER: `tailscale serve --service=svc:clipora --https=443
127.0.0.1:3000` (Tailscale 1.86+; aqui é 1.104.2), que fica salvo e volta sozinho depois de
reiniciar. Política e tags são do usuário: o Claude não as altera (ele cola e salva). Conferir:
`https://clipora.<sua-tailnet>.ts.net/api/folders` aberto **do TI-SERVER** devolve os caminhos (este
PC); de outro aparelho, `{ "remote": true }`; `tailscale serve status` lista os dois endereços. Desfazer: `tailscale serve clear svc:clipora`. Pendente: a chave do
ti-server ainda expira (o ti-kaleb tem "Expiry disabled"); se expirar, o Clipora sai da tailnet até
alguém entrar de novo.

- `"server"` (navegador neste PC): o que está descrito acima (destino de "Salvar em", "Abrir pasta").
- `"browser"` + Chrome/Edge em contexto seguro (HTTPS ou localhost): a própria página grava
  (`saveAllInBrowser` em `gallery.js`, File System Access API), com as mesmas regras do servidor
  (`indices`, hífen, 4 por vez, falha pulada e contada). Na primeira vez pede a pasta
  (`showDirectoryPicker`, `startIn: "desktop"`), guarda o handle no IndexedDB (`clipora` / `pastas` /
  `salvar`) e nas próximas só confirma a permissão. Imagens por `GET /api/gallery/:key/:index/file`,
  vídeos de carrossel pelo download normal (`POST /api/downloads` com `item`, depois `/file`). Na
  janela do nome, "Salvar em" some e aparece "Onde: … / Trocar pasta". Não há "Abrir pasta".
- `"browser"` sem escolha de pasta (Firefox, `http://` por IP, ou o navegador recusou): o servidor
  monta a pasta em `%TEMP%\clipora-zip-*` (o `destination` pedido é ignorado), gera `<nome>.zip`
  (`writeZip`: sem compressão, nomes em UTF-8, `zlib.crc32` exige Node 22+) com a pasta `<nome>/`
  dentro; a tarefa termina em `ready` e a página baixa por `GET /api/downloads/:id/file`.
- Para outro PC: `open-folder` e `POST /api/folders/pick` respondem 403 (a janela abriria na tela do
  servidor) e `GET /api/folders` responde só `{ remote: true }`, sem caminhos do servidor.
- Histórico: até 19/10/2026 a pasta era gravada no servidor mesmo com o navegador em outro PC (a
  pasta `greenbeauty` foi parar no TI-SERVER). O usuário quer **pasta de verdade** no PC dele, não
  zip; o zip é só reserva. Essa parte foi feita no TI-SERVER (API 7) e juntada aqui em 03/11/2026.

- **Instagram** (`sendInstagramInfo`): yt-dlp com `ignoreNoFormatsError` (sem isso ele recusa
  fotos). A foto original é a miniatura sem tamanho no parâmetro `stp` da URL. Post com um único
  vídeo segue o fluxo normal de vídeo; vídeos de carrossel baixam pelo download normal com `item`.
- **DeviantArt** (`sendDeviantArtInfo`): o yt-dlp não suporta. O servidor lê o
  `window.__INITIAL_STATE__` da página da obra (é uma string JS: trocar `\'` por `'` antes do
  `JSON.parse`). Cada imagem vem com tokens JWT que dizem até que tamanho ela pode ser servida. Se
  houver token `file.download`, o artista liberou o original e ele é baixado; senão usamos a
  maior versão pública (`fullview`, com `q_100`). Conteúdo pago (`pcp`) e originais restritos ou com
  marca d'água **não são contornados**: a galeria mostra um aviso explicando o tamanho.
- **ArtStation** (`sendArtStationInfo` e `POST /api/gallery/import`): a página e a API
  (`/projects/<hash>.json`) ficam atrás da Cloudflare, que barra o `fetch` do Node (403). **Não
  contornar.** O link colado responde 409 `artstation_blocked` e a página mostra como usar a
  extensão: na página da obra o coletor busca o JSON com o navegador do próprio usuário e abre
  `<clipora>/#importar=<dados>`. O servidor só aceita
  imagens de `cdn*.artstation.com/p/assets/...` e baixa a versão `/4k/` (reserva: `/large/`); a
  `/original/` é bloqueada pelo ArtStation. As imagens do CDN não têm bloqueio.

**Páginas inteiras** (pedido de 03/11/2026: "baixar todas as imagens de uma página numa pasta",
com seletor "Todas" / "Só as primeiras N"). Galeria com `page: true`, `untrusted: true` e
`suggestedFolder`. Dois caminhos chegam nela:

- **Colar o link** (`/api/info`): MangaDex vai para `sendMangaDexInfo` (API oficial e pública:
  `/chapter/<id>` + `/at-home/server/<id>`; arquivos `data/` originais, miniaturas `data-saver/`;
  o endereço vence em ~15 min, por isso a galeria tem `refresh`; avisa o MangaDex@Home em
  `/report` como a documentação pede; User-Agent próprio, sem fingir navegador). Links de **perfil**
  do X e do Instagram e **listas** do Reddit respondem 409 `needs_browser` (o servidor não lê: login
  ou bloqueio 403 do Reddit). Para os demais, o yt-dlp tenta primeiro; se responder "Unsupported
  URL"/"no video", `sendGenericPageInfo` lê o HTML (`extractPageImages`: `<img>` com srcset e
  atributos de carregamento tardio, link em volta da miniatura, `<picture>`, fundos em `style`,
  og:image só se não houver outra). Post do X/Reddit sem vídeo também vira `needs_browser`. Se o link
  tiver vídeo de página comum (extrator `Generic`/`HTML5MediaEmbed`), a resposta traz
  `pageImages: true` e a tela oferece "Baixar as imagens desta página" (`POST /api/page-images`).
- **Coletor da extensão** (`public/js/coletor.js`, `collectorScript`; até 06/11/2026 era um botão de
  favoritos, que foi **retirado** a pedido do usuário). Roda na página, no navegador do usuário:
  mostra uma caixinha no canto (shadow DOM fechado, só `createElement`/`style.cssText`, por causa de
  CSP rígida), volta ao topo, rola sozinho juntando imagens a cada 0,5 s (funciona com listas que
  descartam o que sai da tela, como a do X), termina quando fica 5 s no fim sem a página crescer, e
  no fim (ou no clique em "Enviar ao Clipora") abre `<clipora>/#importar=` com `{source:"page", url,
  title, items:[[url, largura, altura, miniatura?]]}` (até 5000; corta se a URL passar de ~1,8 MB).
  No MangaDex manda só `#buscar=<link>`. `window.__cliporaColetor` expõe `count()`, `finished()` e
  `target()` para testes. Sem `options.extension` ele ainda usaria `window.open` (o antigo
  favorito), mas nada do site usa mais esse modo.
- **Posts com várias imagens** (pedido de 09/11/2026: no X, Reddit e Instagram só vinha a
  primeira). Cada imagem coletada guarda o post de onde veio (`postOf`, sobe por shadow DOM com
  `closestDeep`). No fim da rolagem, antes de enviar, `expandPosts` abre os posts e a primeira
  imagem dá lugar a todas as do post, no mesmo lugar (`buildItems`):
  - Reddit: só posts de galeria (`shreddit-post[post-type=gallery]` ou `gallery-carousel`; no
    old.reddit `.thing` com `data-is-gallery`/`/gallery/`), lidos pelo próprio navegador em lotes de
    50 por `/by_id/t3_a,t3_b.json?raw_json=1` (`gallery_data` + `media_metadata`, também de
    crosspost) → `https://i.redd.it/<media_id>.<ext>` (GIF animado: `s.gif`).
  - Instagram: só blocos com `svg` dentro do link `/p/` (ícone de carrossel; fixado/vídeo também
    entram, sem efeito) ou artigo do feed com lista de mais de um item. O navegador pede
    `/api/v1/media/<id>/info/` com `X-IG-App-ID: 936619743392459` (id calculado do shortcode, base
    64 do Instagram), 2 por vez, até 400 posts, e para no primeiro 429. Pega só `media_type` 1, maior
    candidato. Sem login a API recusa e fica a imagem da grade.
  - X: o navegador não lê (a API pública só libera CORS para `platform.twitter.com`). A foto de post
    de que só se viu uma imagem vai com 5º elemento `"x:<id>"`, e `expandTwitterPosts` no servidor
    (em `importPageGallery`) pede `cdn.syndication.twimg.com/tweet-result?id=&token=` (token =
    `(id/1e15*π)` em base 36 sem zeros e ponto; a API dos tweets incorporados, sem login), 6 por vez,
    até 2000, 90 s no máximo, para no 429. Só troca se o post tiver mais de uma foto.
  A caixinha mostra "Abrindo os posts com várias imagens: N de M"; a página do Clipora avisa que
  está abrindo os posts do X.

Regras por site em `buildPageItems`/`imageVariants`: X só `pbs.twimg.com/media/` (baixa
`name=orig`, reservas `4096x4096`/`large`); Instagram sem fotos de perfil (`t51.*-19`); Reddit
troca `preview.redd.it` por `i.redd.it` e tira avatares/emojis; Pinterest `/originals/`; Wikimedia
(`upload.` e `thumb.wikimedia.org`) tira o `/thumb/`; Blogger `s0`; WordPress tira `-300x200`.
Links com ":" no caminho (`/wiki/File:Foto.jpg`) são páginas, não imagens. Imagens "pequenas"
(lado maior < 100 px ou um lado < 48 px, medido pelo navegador, pelo HTML ou lendo os primeiros
128 KB) ficam escondidas, com opção de mostrar. Rastreadores, anúncios e logotipos de aviso de
cookies são ignorados. Pedidos de imagem pedem JPEG/PNG primeiro (senão Unsplash/Cloudflare mandam
AVIF).

**Segurança das páginas genéricas.** Endereços que vêm de página qualquer passam por `fetchPublic`:
só http(s), nada de rede local (localhost, 10.x, 192.168.x, 100.64/10 do Tailscale, IPv6 local...),
cada redirecionamento conferido, resposta tem de ser imagem (SVG recusado). O proxy responde com
`Content-Security-Policy: sandbox` e `nosniff`. `POST /api/folders/pick` exige JSON (outro site não
consegue abrir a janela). `CLIPORA_ALLOW_PRIVATE_HOSTS=1` libera a rede local **só para testes**.

**Limpeza.** Sessões expiram após 30 min sem uso; a página envia um heartbeat a cada 60 s enquanto
o editor ou uma ferramenta estiver aberta. Tarefas abandonadas (3 min sem consulta) são canceladas.
Temporários ficam em `%TEMP%\clipora-*`.

### Rotas

| Rota | Uso |
| --- | --- |
| `POST /api/info` | Lê um link. Vídeo: título, miniatura, resoluções, `pageImages`. Galeria: `{ gallery: true, page, key, source, notes, suggestedFolder, items[{ small }] }`. ArtStation barrado: 409 `artstation_blocked`; precisa do botão: 409 `needs_browser` + `site` |
| `POST /api/page-images` | Força a leitura das imagens de uma página (quando o link também tinha vídeo) |
| `POST /api/downloads` | Download direto `{ url, height, item? }` |
| `GET /api/downloads/:id` | Progresso (também das pastas do Instagram: `savedPath`, `savedFolder`, `savedCount`) |
| `GET /api/downloads/:id/file` | Entrega o MP4 (ou o `.zip` do "Salvar em uma pasta" pedido de outro PC) |
| `DELETE /api/downloads/:id` | Cancela |
| `POST /api/downloads/:id/open-folder` | Abre no Explorer a pasta criada pelo Clipora (403 para outro PC) |
| `POST /api/editor-sessions` | Sessão a partir de link `{ url, height, purpose }` |
| `POST /api/editor-sessions/upload` | Sessão a partir de arquivo (cabeçalhos `X-File-Name`, `X-Clipora-Purpose`) |
| `GET /api/editor-sessions/:id` | Estado da sessão (404 com `code: "session_lost"` se expirou) |
| `POST /api/editor-sessions/:id/assets` | Completa a sessão para o editor |
| `GET /api/editor-sessions/:id/media` | Vídeo com suporte a Range |
| `POST /api/editor-sessions/:id/exports` | Exporta `{ segments, crop, scaleMode, output }` |
| `POST /api/editor-sessions/:id/cancel-export` | Cancela a exportação |
| `GET /api/editor-sessions/:id/file` | Baixa o resultado (`?keep=1` mantém a sessão) |
| `GET /api/gallery/:key/:index/preview` | Miniatura de uma mídia da galeria |
| `GET /api/gallery/:key/:index/file` | Imagem na maior qualidade disponível |
| `POST /api/gallery/:key/folder` | Salva em `<destino>\<folder>`: `{ folder, destination: { kind: desktop/downloads/custom, path }, indices? }`; de outro PC prepara `<folder>.zip` |
| `POST /api/gallery/import` | Recebe da extensão uma obra do ArtStation ou `{ source: "page", url, title, items }` |
| `GET /api/folders` | Caminhos da Área de Trabalho e do Downloads (`{ remote: true }` para outro PC) |
| `POST /api/folders/pick` | Abre a janela "Procurar pasta" do Windows `{ initial }` → `{ path }` ou `{ cancelled }` (403 para outro PC) |
| `GET /clipora-extensao.zip` | Pacote da extensão, já apontando para o endereço de onde foi baixado |
| `GET /clipora-extensao-icone.png` | Ícone da extensão (128 px) |

As rotas antigas `/api/instagram/...` continuam respondendo (mesmo código).

## Decisões de produto (já combinadas com o usuário)

- Página inicial: título em degradê "Qualquer vídeo a um link de distância", parágrafo "Cole o link
  do vídeo que você quer baixar", ícone de pasta dentro da barra de busca, arrastar arquivo para
  qualquer lugar da página. Atalhos logo abaixo da busca (`margin-top: 5px`) e escondidos enquanto
  o editor está aberto.
- Ferramentas em telas próprias com seta de voltar: GIF (link em até 720p, trecho de até 10 s com
  duas barras e tempos digitados), Comprimir (link em até 1080p, sem player, estimativa "até X MB"),
  Cortar Proporção (recorte livre + trecho, link em até 1080p). Ao terminar: Novo vídeo, Fazer outro
  com o mesmo vídeo, Abrir no editor completo.
- Recorte livre estilo Lightshot: uma área por vez, 8 alças, arrastar fora desenha outra área,
  Shift trava a proporção, proporções prontas (Livre, Original, 16:9, 9:16, 1:1, 4:3). Seletor
  "Tamanho real" / "Ampliar", sempre começando em Tamanho real (não lembrar a escolha).
- Timeline: duração embaixo de cada trecho; bordas arrastáveis que param no vizinho, recuperam
  partes excluídas e grudam no cursor (Alt desliga); mínimo 0,1 s; aviso laranja de GIF acima de 10 s.
- Sessão perdida: mensagem "A sessão expirou. Abra o vídeo novamente." e o editor fecha.
- Instagram: galeria com botão "Salvar" em cada mídia (sem "Download again") e "Salvar tudo em uma
  pasta" que pergunta só o nome. O botão está escrito "Salvar"; o usuário mostrou "Save" na
  referência e pode querer trocar.
- DeviantArt e ArtStation usam a mesma galeria do Instagram (pedido de 17/10/2026). Sempre na maior
  qualidade **que o site libera**; nunca contornar conteúdo pago, marca d'água ou a Cloudflare. No
  ArtStation o fluxo é pelo botão "Enviar ao Clipora", porque colar o link é barrado.
- Todas as imagens de uma página (pedido de 03/11/2026): seletor "Todas (N)" / "Só as primeiras
  [N]" / "Só as de número [1, 4, 7-10]" (este último pedido em 05/11/2026; em perfis e feeds as
  primeiras são as mais recentes).
- **Bolinha de marcar** (pedido de 05/11/2026): toda galeria com mais de uma mídia (páginas, carrossel
  do Instagram, obras do ArtStation) tem uma bolinha no canto superior direito de cada miniatura;
  tudo começa marcado, clicar na bolinha ou na imagem marca/desmarca, e só as marcadas vão para a
  pasta (`selectedItems` = visíveis com `item.checked`; a página sempre manda `indices`). O seletor
  "Quantas baixar?" apenas **marca/desmarca as bolinhas** (`applyCountRule`, ao clicar no rádio,
  digitar no campo ou mostrar as pequenas); depois dá para ajustar uma a uma. Entrar no campo de
  um rádio já escolhido não reaplica a regra. As desmarcadas ficam transparentes. O número na
  miniatura é a **posição fixa** na lista (o que se digita em "Só as de número"); os arquivos são
  numerados em sequência só com as marcadas. **Shift+clique** (galerias com mais de 3 mídias, pedido
  de 06/11/2026): leva o estado da última mídia clicada (`anchorItem`) para todas entre ela e a
  clicada agora. Com Shift pressionado o navegador transforma a roda do mouse em rolagem lateral;
  com a galeria aberta, `gallery.js` devolve a roda para cima/baixo (pedido de 09/11/2026). A janela da pasta sugere o
  nome (perfil, `r-sub`, "Título cap 12", título da página sem o nome do site) e tem "Salvar em":
  Área de Trabalho (padrão), Downloads ou "Outra pasta…" (janela do Windows), lembrado no navegador.
  Atalho "Baixar Imagens" (`#imagens`) mostra como usar. Inspirado na pesquisa do usuário em
  `C:\Users\Admin\Desktop\Tab Collector Research` (coletor genérico + rolagem automática); optou-se
  primeiro por botão de favoritos; desde 06/11/2026 é a extensão (o favorito foi retirado).
- Nomes de arquivo X/Instagram/TikTok usam `perfil-idDoPost` (DeviantArt `perfil-idDaObra`, ArtStation
  `perfil-hash`); exportações recebem `-comprimido`, `-recorte`, `-gif-4s` ou `-clip-5s`.

## Convenções

- Textos da interface e mensagens de erro em português **com acentos**. Exceções: `instalar.cmd` e
  nomes de arquivos baixados (ASCII).
- Comentários do código em português; os mais antigos estão sem acento.
- Front-end sem framework nem build: módulos ES servidos direto de `public/`.
- Downloads da página usam iframe oculto (`triggerDownload`) para que um erro do servidor não
  substitua a página; fotos do Instagram usam `fetch` + blob para poder mostrar o erro.

## Como testar

- Suba um servidor à parte para não derrubar o do usuário:
  `PORT=3123` (e `CLIPORA_DOWNLOADS_DIR=<pasta de teste>` para o "Salvar tudo" não escrever no
  Downloads real).
- Vídeos de teste com o próprio FFmpeg do projeto:
  `ffmpeg -f lavfi -i testsrc2=size=1920x1080:rate=30:duration=14 -f lavfi -i sine=frequency=440:duration=14 -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest land.mp4`.
  Variações úteis: `-display_rotation 90` (vídeo girado, opção de entrada), `-vf setsar=2/1`
  (pixels não quadrados, como vídeos do TikTok/X), `-c:v libx265 -tag:v hvc1` (HEVC).
- Posts públicos usados nos testes do Instagram: carrossel `https://www.instagram.com/p/BoZjhaUHR8k/`
  (8 fotos + 1 vídeo), foto única `https://www.instagram.com/p/DYhqaremniv/`, vídeo
  `https://www.instagram.com/p/DcCH2ZygIiP/`.
- DeviantArt: original liberado `https://www.deviantart.com/patriciabrennan/art/Lounge-Lizard-137959110`
  (840×666), versão pública com marca d'água `.../digitaldean/art/Dance-To-The-Sunrise-199549617`
  (800×865 de 1373×1483), conteúdo pago `.../elysekh/art/Girl-with-hat-Digital-painting-880495861`.
- ArtStation: obras `ykoO4O` (3 imagens, uma de 4200×2160) e `rRvln5` (11 imagens). Como o servidor
  é barrado, teste a importação mandando o JSON da obra para `POST /api/gallery/import`; o botão em si
  funciona numa aba normal do navegador na página `https://www.artstation.com/artwork/<hash>`.
- Páginas inteiras: use também `CLIPORA_DESKTOP_DIR=<pasta de teste>` (sem ela, a "Área de
  Trabalho" de teste fica em `<CLIPORA_DOWNLOADS_DIR>\_area-de-trabalho`) e
  `CLIPORA_FAKE_PICKER=<pasta>` (ou `cancel`) para não abrir a janela do Windows. Página montada no
  próprio PC exige `CLIPORA_ALLOW_PRIVATE_HOSTS=1` num servidor de teste separado.
- Testados em 03/11/2026: capítulo do MangaDex `71859682-08a3-4732-9af0-3a28487fe09b` (Futari Bus
  cap. 52, 18 páginas), `https://commons.wikimedia.org/wiki/Category:Sunsets` (tem um vídeo: use
  `/api/page-images`; 201 imagens, original de 1,3 MB) e o coletor rodando em
  `https://unsplash.com/t/nature` (331 imagens, 127 avatares marcados como pequenos). O navegador
  embutido do app **não abre o Reddit** (restrição do app) e **não tem login no X**: esses dois só
  dá para testar no Chrome do usuário.
- Para testar o coletor no navegador embutido, execute o código de `collectorScript` na página (o
  botão de dentro da caixinha fica num shadow DOM fechado) e use `window.__cliporaColetor.target()`
  para pegar o endereço `#importar=`.
- "Outro PC" sem outro PC: `curl -H "Tailscale-User-Login: x"` simula um pedido pelo
  `tailscale serve` vindo de outro aparelho; `-H "X-Forwarded-For: 100.64.0.10"` simula o próprio
  TI-SERVER pelo `tailscale serve` (este PC) e `-H "X-Forwarded-For: 100.64.0.20"`, o TI-KALEB. Para o navegador do app, rode o servidor de teste por um script que, antes de
  `require("<pasta>/server.js")`, faz cada conexão parecer remota (sobrescreva `remoteAddress` do
  socket no evento `connection` de `http.Server.prototype.emit`, ex.: `203.0.113.7`) e abra
  `http://localhost:<porta>` (o navegador do app não abre IPs da rede).
- Escolha de pasta no navegador de testes: a janela nativa não dá para automatizar. Troque
  `window.showDirectoryPicker` por uma função que devolve uma pasta da OPFS
  (`(await navigator.storage.getDirectory()).getDirectoryHandle("Área de Trabalho", { create: true })`)
  e confira os arquivos pela própria OPFS. Limpe a OPFS e o IndexedDB `clipora` no fim.
- Testado em 03/11/2026 (junção): neste PC salva no destino; de outro PC vira `.zip` íntegro (abre
  no `Expand-Archive`), a janela de pastas e o "Abrir pasta" dão 403 e nada é gravado no servidor; no
  navegador "remoto" a página grava a pasta pela OPFS com hífen e pulando a imagem que falhou.
- `node --check` não aceita os módulos de `public/js` como `.js`; copie para `.mjs` antes de checar.
- Extensão: o navegador do app não instala extensões. Teste a `janela.html` servida por um
  servidorzinho que entrega os arquivos do .zip extraído em `/ext/` (com um `<script>` que cria um
  `chrome` falso e troca `showSaveFilePicker` por arquivos da OPFS) e repassa o resto ao Clipora de
  teste, para ficar na mesma origem. Testado em 06/11/2026: YouTube `jNQXAC9IVRw` (240p, nome
  `Me at the zoo-240p.mp4`), imagem direta (logo do Google), DeviantArt (imagem única), ArtStation e
  MangaDex (coletor), carrossel do Instagram (abre o site). O coletor com `extension: true` foi
  testado rodando na própria página do Clipora (envio automático no fim).
- No navegador de testes, intercepte downloads (iframe `src` e `<a download>`) em vez de baixar.
  Se o painel do navegador estiver oculto, medidas de layout voltam 0.

## Armadilhas encontradas

- A extensão vem apontando para o endereço de onde o .zip foi baixado. Se foi baixada por
  `http://100.64.0.10:3000`, manda tudo para esse endereço (sem HTTPS, então a pasta vem como
  zip). Para usar o HTTPS, baixe de novo por `https://clipora.<sua-tailnet>.ts.net` ou troque na
  engrenagem da janelinha.
- Em `http://` por IP o navegador também bloqueia a área de transferência: o botão "Colar" só
  funciona em HTTPS ou localhost.
- Downloads da página (Salvar, Baixar) vão para o PC do navegador; qualquer coisa que o servidor grava
  ou abre por conta própria acontece no PC do servidor. Novas funções desse tipo precisam de
  `isLocalRequest`.
- No modo "browser", o nome do arquivo vem do tipo que o site informa (`Content-Type`), não dos
  primeiros bytes como no servidor: um site que mente o tipo gera extensão errada.

- Chrome não exibe HEVC: o player abre sem imagem e sem erro (por isso a conversão por codec).
- Vídeos com pixels não quadrados: a área de recorte copia a caixa do elemento `<video>`
  (`width/height: auto`, `max-*: 100%`, player em flex) em vez de calcular proporção.
- No Windows, arquivos abertos impedem apagar os temporários: as leituras de mídia fecham o stream
  quando o navegador cancela o pedido.
- O yt-dlp do Instagram funciona sem login para posts públicos; posts privados ou que exigem login
  falham com mensagem amigável.
- No terminal Bash usado pelo Claude neste projeto, heredocs com a sequência de duas aspas simples
  quebram o comando; para arquivos com isso, use a ferramenta de escrita de arquivos.
- O mesmo terminal **reduz pela metade as barras invertidas** de scripts escritos por heredoc
  (`\\d` vira `\d`, `\d` vira `d`): regex e caminhos saem quebrados sem erro. Scripts com `\` vão
  pela ferramenta de escrita de arquivos.
- Coletor em página que não rola de verdade (ex.: a do próprio Clipora, `scrollTop` preso em 0):
  sem sair do lugar por 6 s e sem a página crescer, conta como fim (antes rodava para sempre).
- Wikimedia: a miniatura fica dentro de um link `/wiki/File:Foto.jpg`, que termina em `.jpg` mas é
  página HTML. E sites como Unsplash escolhem AVIF/WebP pelo cabeçalho `Accept`.

## Ideias pendentes

- Páginas inteiras: imagens dentro de `<iframe>` e as protegidas (`blob:`) não entram; sites que
  exigem cookies para entregar a imagem falham no servidor.
- Conferir no Chrome do usuário a abertura dos posts com várias imagens (09/11/2026): foi testada
  só com páginas simuladas (estrutura do X, do Instagram e do Reddit com respostas falsas) e com a
  API do X respondendo de verdade a um post sem fotos. Se o X/Instagram mudarem a marcação
  (`/status/<id>/photo/`, `svg` no bloco da grade, `shreddit-post`), é ali que se ajusta.

- Cookies para posts do Instagram que exigem login.
- Corrigir a proporção do recorte em vídeos com pixels não quadrados na exportação.
