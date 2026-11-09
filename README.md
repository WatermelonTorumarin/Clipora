# Clipora

Aplicacao web local com interface moderna para consultar um link de video,
baixar o video em MP4 ou abrir uma sessao temporaria para extrair somente os
trechos desejados. Tambem e possivel abrir um video salvo no computador.

Aceita links do YouTube, X (Twitter), Reddit e dos demais sites suportados pelo
yt-dlp. Videos privados ou que exigem login podem nao funcionar.

## Instagram: fotos e videos

Ao buscar um post do Instagram com fotos (ou um carrossel com varias midias), o
Clipora mostra uma galeria com todas as fotos e videos do post, cada um com o
botao **Salvar**. Posts com um unico video seguem o fluxo normal (qualidades,
Baixar e Editar).

**Salvar tudo em uma pasta** pergunta o nome da pasta e onde salvar (Area de
Trabalho, Downloads ou outra pasta escolhida numa janela do Windows; a escolha
fica lembrada) e grava as midias na ordem do post, com o nome da pasta seguido
do numero: pasta `viagem` -> `viagem1.jpg`, `viagem2.jpg`, `viagem3.mp4`... Se o
nome terminar em numero, entra um hifen (`cap 12` -> `cap 12-1.jpg`). Se ja
existir uma pasta com esse nome, e criada `viagem (2)`. Posts privados ou que
exigem login nao podem ser lidos.

Se o Clipora estiver rodando em outro computador (aberto pela rede), a pasta e
criada no computador do navegador, nunca no servidor (vale tambem para "Todas
as imagens de uma pagina"):

- Pelo endereco HTTPS do Tailscale (`https://clipora.<sua-tailnet>.ts.net`; o
  antigo `https://ti-server.<sua-tailnet>.ts.net` tambem funciona), no
  Chrome ou no Edge: na primeira vez o Clipora pergunta onde salvar (por
  exemplo, a Area de Trabalho) e depois cria a pasta `viagem` direto ali. Para
  mudar o lugar, use **Trocar pasta** na janela do nome.
- Pelo endereco sem HTTPS (`http://100.64.0.10:3000`) ou no Firefox: o
  navegador baixa `viagem.zip`, com a pasta `viagem` e os arquivos dentro.

O botao **Abrir pasta** e a escolha "Salvar em" so aparecem quando o navegador
esta no mesmo computador do Clipora.

## Todas as imagens de uma pagina

Baixa todas as imagens de uma pagina (ou so as primeiras N) para uma pasta.
O atalho **Baixar Imagens** na pagina inicial mostra o passo a passo.

- **Colar o link**: capitulos do MangaDex (paginas na qualidade original) e
  paginas comuns (blogs, sites de leitura simples, Wikimedia...) sao lidos pelo
  proprio Clipora. Se o link tambem tiver um video, o cartao do video oferece
  **Baixar as imagens desta pagina**.
- **Extensao do Clipora** (veja abaixo): para X (aba Midia de um perfil),
  Instagram (perfis), Reddit e paginas que exigem login ou carregam as imagens
  aos poucos. Na pagina, clique no icone do Clipora: uma caixinha aparece no
  canto e rola a pagina sozinha juntando as imagens. No fim (ou quando voce
  clicar em **Enviar ao Clipora**) o Clipora abre numa nova aba.

Na galeria, escolha **Todas**, **So as primeiras N** ou **So as de numero**
(por exemplo `1, 4, 7-10`; em perfis e feeds, as primeiras sao as mais
recentes). Cada imagem tem uma bolinha no canto superior direito: tudo vem
marcado, e clicar na bolinha (ou na imagem) desmarca; so as marcadas sao
baixadas. A bolinha tambem aparece nos carrosseis do Instagram e nas obras com
varias imagens. Com mais de 3 imagens, segure **Shift** e clique em outra
imagem: todas as do meio ficam iguais a ultima que voce clicou (marcadas ou
desmarcadas); com Shift pressionado a roda do mouse continua rolando a lista.
Posts com varias imagens (galerias do Reddit, carrosseis do Instagram, posts do
X com ate 4 fotos) entram com todas as imagens, nao so a primeira: no fim da
rolagem a extensao abre esses posts. Icones e avatares ficam escondidos. As fotos do
X saem no tamanho original; as do Reddit, no arquivo original. Quem le a pagina
e o seu navegador, com o seu login: o Clipora nao contorna login nem bloqueios.

## Extensao do Clipora (Chrome e Edge)

Um icone roxo de download na barra do navegador. Na pagina aberta, um clique:

- **Video**: escolha a qualidade; o Windows pergunta onde salvar (comeca na
  Area de Trabalho, depois na ultima pasta usada) e o MP4 e baixado direto, sem
  abrir o site do Clipora.
- **Uma imagem** (foto aberta, obra do DeviantArt...): clique em **Baixar
  imagem** e confirme onde salvar.
- **Varias imagens** (perfil do X ou do Instagram, Reddit, capitulo, site
  comum): a extensao rola a pagina juntando as imagens e, no fim, abre o Clipora
  para voce escolher quais baixar e a pasta.

Para instalar: no Clipora, atalho **Baixar Imagens** > **Baixar a extensao
(.zip)**. Extraia numa pasta fixa, abra `chrome://extensions` (ou
`edge://extensions`), ligue o **Modo do desenvolvedor**, clique em **Carregar sem
compactacao** e escolha a pasta `clipora-extensao`. Fixe o icone pelo alfinete.
Baixe a extensao pelo mesmo endereco que voce usa para abrir o Clipora: ela ja
vem apontando para ele (a engrenagem da janelinha troca o endereco).

## DeviantArt e ArtStation: imagens em alta qualidade

Links de obras do **DeviantArt** abrem a mesma galeria do Instagram, com a imagem na maior qualidade
que o site libera: o arquivo original quando o artista permite download; senao a maior versao
publica. Conteudo pago e obras com marca d'agua ficam na versao publica, com um aviso.

O **ArtStation** bloqueia leituras automaticas, entao funciona pela extensao: na pagina de uma
obra do ArtStation, clique no icone do Clipora e o Clipora abre com todas as imagens, baixadas
na versao 4K (ou na maior disponivel). O antigo botao de favoritos foi substituido pela
extensao e pode ser apagado da barra.

## Ferramentas rapidas

Na pagina inicial, abaixo da busca, ficam quatro atalhos: **Baixar Imagens**
(`/#imagens`, explicado acima) e tres ferramentas de video (tambem acessiveis
pelos enderecos `/#gif`, `/#comprimir` e `/#recortar`):

- **Converter para GIF**: escolha um trecho de ate 10 s com duas barras (video
  inteiro e ajuste fino) ou digitando os tempos (`83`, `1:23`, `1:23.5`).
  Links sao baixados em ate 720p.
- **Comprimir Video**: mostra o tamanho atual e a estimativa de cada nivel ou do
  tamanho alvo. Links sao baixados em ate 1080p.
- **Cortar Proporcao**: recorte livre da imagem mais a escolha do trecho.

Ao terminar, o download comeca sozinho e da para comecar um novo video, fazer
outro com o mesmo video ou abrir tudo no editor completo. Tambem e possivel
arrastar um arquivo de video para qualquer lugar da pagina.

## Recorte da imagem

No editor, **Recortar** (tecla `C`) permite desenhar uma area livre sobre o
video, como no Lightshot. As 8 alcas ajustam os lados, arrastar pelo meio move a
area e `Shift` mantem a proporcao. Ha proporcoes prontas (Livre, Original,
16:9, 9:16, 1:1 e 4:3). **Tamanho real** exporta os pixels da area; **Ampliar**
aumenta ate caber no quadro original sem deformar (com aviso de nitidez a partir
de 1,5x).

## Timeline

Cada trecho mostra sua duracao logo abaixo. As bordas podem ser arrastadas:
param no trecho vizinho, recuperam partes excluidas e grudam no cursor (segure
`Alt` para desligar o ima). Enquanto o editor estiver aberto a sessao e mantida
ativa; se ela se perder (por exemplo, ao reiniciar o Clipora), aparece um aviso.

## Formato e compressao

- **MP4**, com compressao **Original**, **Leve**, **Media** (ate 1080p),
  **Forte** (ate 720p) ou **Tamanho alvo** em MB (duas passagens, a resolucao e
  reduzida automaticamente quando o alvo e pequeno).
- **GIF** para clipes de ate 10 segundos, sem audio, com 320/480/640 px no lado
  maior e 10/15/24 fps.

Recorte, cortes de tempo e compressao podem ser combinados na mesma exportacao.

## Editor de cortes

Depois de escolher uma resolucao, use **Editar** para preparar o video sem
baixa-lo antes. A timeline oferece miniaturas, forma de onda, zoom, marcacao de
inicio e fim, divisao de trechos, selecao multipla, exclusao, desfazer/refazer e
atalhos de teclado. Se nenhum corte for feito, a exportacao reutiliza o arquivo
ja preparado sem uma nova conversao.

As sessoes nao sao salvas: os arquivos temporarios sao removidos ao baixar o
resultado, cancelar ou abandonar a tarefa. Use **Abrir video do computador**
para editar um arquivo local.

## Como executar

1. Instale o [Node.js LTS](https://nodejs.org/).
2. Abra um terminal nesta pasta.
3. Execute `instalar.cmd`.

O instalador prepara as dependencias e inicia o Clipora automaticamente. Outra
opcao e executar manualmente:

   ```powershell
   $env:YOUTUBE_DL_SKIP_PYTHON_CHECK = "1"
   npm install
   npm start
   ```

4. Acesse `http://localhost:3000`.

Na primeira instalacao, as dependencias baixam os executaveis necessarios do
yt-dlp e do FFmpeg. Nao e necessario instalar Python. Use a aplicacao somente
para videos proprios, licenciados, em dominio publico ou quando houver
permissao expressa do autor.

O Clipora prioriza os formatos H.264 e AAC oferecidos pelo proprio YouTube,
permitindo apenas combinar as faixas de video e audio sem recodificar. Quando
esses formatos nao estiverem disponiveis, a conversao completa e usada como
alternativa e pode levar alguns minutos.

A interface acompanha o progresso real da preparacao do arquivo. Para evitar
alto uso de CPU, memoria e disco, apenas um download e processado por vez e
tarefas abandonadas sao removidas automaticamente.
