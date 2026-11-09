// Coletor de imagens da extensão do Clipora (antes era um botão de favoritos; removido em
// 06/11/2026). O .zip da extensão leva este arquivo, e a extensão injeta collectorScript na
// aba com chrome.scripting.executeScript.
//
// O código de collectorScript roda na página que o usuário abriu, no navegador dele
// (com o login dele), e por isso precisa ser autossuficiente: não pode usar nada deste
// módulo. Ele faz uma de três coisas:
//  - ArtStation (obra): lê /projects/<hash>.json pelo próprio site e manda a obra.
//  - MangaDex (capítulo): manda só o link; o servidor lê o capítulo pela API oficial.
//  - Qualquer outra página: mostra uma caixinha no canto, volta ao topo, rola a página
//    sozinha juntando as imagens (inclusive em listas que descartam o que saiu da tela,
//    como a do X) e, quando o usuário clica em "Enviar ao Clipora", abre o Clipora numa
//    nova aba com a lista em #importar=.
// Técnicas de coleta baseadas na pesquisa "Tab Collector Research" (05-image-collector-
// blueprint.md): srcset (maior candidato), atributos de carregamento tardio, <picture>,
// links diretos para imagens, fundos em style, shadow DOM aberto e rolagem automática.
// Não contorna nada: só lê o que a própria página mostra para o usuário.
// A caixinha usa só createElement/textContent/style (nada de innerHTML ou <style>),
// para funcionar em sites com política de segurança (CSP) rígida.

export function collectorScript(origin, options) {
  // Pela extensão, quem abre a aba do Clipora é a própria extensão (sem bloqueio de pop-up),
  // e a lista é enviada sozinha quando a rolagem chega ao fim.
  const viaExtension = Boolean(options && options.extension);
  const openTarget = (target) => {
    if (viaExtension) {
      chrome.runtime.sendMessage({ type: "clipora-abrir", url: target });
      return true;
    }
    return Boolean(window.open(target, "_blank"));
  };
  const open = (hash) => {
    const target = origin + "/#" + hash;
    if (!openTarget(target)) location.href = target;
  };
  const host = location.hostname.replace(/^www\./, "");

  if (/(^|\.)artstation\.com$/.test(host)) {
    const work = location.pathname.match(/\/(?:artwork|projects)\/([A-Za-z0-9]+)/);
    if (work) {
      fetch("/projects/" + work[1] + ".json", { credentials: "include" })
        .then((response) => {
          if (!response.ok) throw new Error("o ArtStation não liberou os dados da obra (" + response.status + "). Recarregue a página e tente de novo.");
          return response.json();
        })
        .then((project) => open("importar=" + encodeURIComponent(JSON.stringify({
          source: "artstation",
          hash: work[1],
          title: project.title || "",
          author: (project.user && project.user.username) || "",
          assets: (project.assets || [])
            .filter((asset) => asset.has_image && asset.asset_type === "image")
            .map((asset) => ({ url: asset.image_url, width: asset.width, height: asset.height }))
        }))))
        .catch((error) => alert("Não foi possível enviar ao Clipora: " + error.message));
      return;
    }
  }

  if (/(^|\.)mangadex\.org$/.test(host) && /\/chapter\//.test(location.pathname)) {
    open("buscar=" + encodeURIComponent(location.href));
    return;
  }

  if (window.__cliporaColetor) {
    window.__cliporaColetor.close();
    return;
  }

  const LIMIT = 5000;
  const IMAGE_LINK = /\.(jpe?g|jfif|png|gif|webp|avif|bmp)(\?|#|$)/i;
  const LAZY = ["data-src", "data-lazy-src", "data-original", "data-lazy", "data-url", "data-hi-res-src",
    "data-full", "data-full-url", "data-zoom-image", "data-large_image", "data-orig-file", "data-large-file"];
  const found = new Map();
  const blobs = new Set();
  let scrolling = true;
  let finished = false;
  let sent = false;
  let sending = false;
  let note = "";
  let timer = 0;
  let lastHeight = 0;
  let grewAt = Date.now();
  let bottomSince = 0;
  let lastTop = -1;
  let movedAt = Date.now();

  const absolute = (value) => {
    if (!value) return null;
    try {
      return new URL(String(value).trim(), document.baseURI).href;
    } catch (error) {
      return null;
    }
  };
  const largest = (srcset) => {
    if (!srcset) return null;
    let best = null;
    let score = -1;
    srcset.split(/,\s+(?=\S)/).forEach((part) => {
      const bits = part.trim().split(/\s+/);
      const descriptor = bits[1] || "1x";
      const value = (parseFloat(descriptor) || 1) * (/w$/i.test(descriptor) ? 1 : 1000);
      if (bits[0] && value > score) {
        best = bits[0];
        score = value;
      }
    });
    return best;
  };
  // Posts com várias imagens (X, Instagram, Reddit): a lista do site mostra só a primeira.
  // Cada imagem guarda de que post veio; no fim, os posts são abertos e a primeira imagem é
  // trocada por todas as do post, no mesmo lugar.
  const posts = new Map();
  const postOfUrl = new Map();
  const closestDeep = (element, selector) => {
    let node = element;
    while (node) {
      const hit = node.closest(selector);
      if (hit) return hit;
      const root = node.getRootNode();
      node = root && root.host ? root.host : null;
    }
    return null;
  };
  const site = /(^|\.)(x|twitter)\.com$/.test(host) ? "x"
    : /(^|\.)instagram\.com$/.test(host) ? "instagram"
      : /(^|\.)reddit\.com$/.test(host) ? "reddit" : "";
  const postOf = (element) => {
    if (site === "x") {
      const link = closestDeep(element, "a[href*='/status/']");
      const match = link && link.href.match(/\/status\/(\d+)\/photo\//);
      return match ? { key: "x:" + match[1], id: match[1] } : null;
    }
    if (site === "instagram") {
      let link = closestDeep(element, "a[href*='/p/']");
      const article = link ? null : closestDeep(element, "article");
      if (article) link = article.querySelector("a[href*='/p/']");
      const match = link && link.href.match(/\/p\/([A-Za-z0-9_-]+)/);
      if (!match) return null;
      // Na grade do perfil, o ícone de "várias fotos" é um svg dentro do link;
      // no feed, o carrossel é uma lista com mais de um item.
      const multi = article ? article.querySelectorAll("ul li img").length > 1 || Boolean(article.querySelector("ul li + li"))
        : Boolean(link.querySelector("svg"));
      return { key: "instagram:" + match[1], id: match[1], multi };
    }
    if (site === "reddit") {
      const post = closestDeep(element, "shreddit-post");
      if (post) {
        const id = (post.getAttribute("id") || "").replace(/^t3_/, "");
        const multi = post.getAttribute("post-type") === "gallery" || Boolean(post.querySelector("gallery-carousel"));
        return id ? { key: "reddit:" + id, id, multi } : null;
      }
      const thing = closestDeep(element, ".thing[data-fullname^='t3_']");
      if (thing) {
        const id = thing.getAttribute("data-fullname").slice(3);
        const multi = thing.getAttribute("data-is-gallery") === "true" || /\/gallery\//.test(thing.getAttribute("data-url") || "");
        return { key: "reddit:" + id, id, multi };
      }
    }
    return null;
  };
  const notePost = (url, post) => {
    if (!post) return;
    let entry = posts.get(post.key);
    if (!entry) {
      entry = { site, id: post.id, multi: false, urls: new Set(), expanded: null };
      posts.set(post.key, entry);
    }
    if (post.multi) entry.multi = true;
    entry.urls.add(url);
    if (!postOfUrl.has(url)) postOfUrl.set(url, post.key);
  };

  const add = (raw, width, height, shown, post) => {
    const url = absolute(raw);
    if (!url) return;
    if (url.startsWith("blob:")) {
      blobs.add(url);
      return;
    }
    if (!/^https?:/.test(url)) return;
    if (post && (found.has(url) || found.size < LIMIT)) notePost(url, post);
    const known = found.get(url);
    if (known) {
      if (width > known[1]) {
        known[1] = width;
        known[2] = height;
      }
      return;
    }
    if (found.size >= LIMIT) return;
    const preview = absolute(shown);
    found.set(url, preview && preview !== url && /^https?:/.test(preview) ? [url, width, height, preview] : [url, width, height]);
  };

  const box = document.createElement("div");
  const roots = () => {
    const list = [document];
    const walk = (root) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.shadowRoot && node !== box) {
          list.push(node.shadowRoot);
          walk(node.shadowRoot);
        }
      }
    };
    walk(document.documentElement);
    return list;
  };

  const scan = () => {
    roots().forEach((root) => {
      root.querySelectorAll("img, picture source, a[href], [style*='url(']").forEach((element) => {
        const tag = element.tagName;
        if (tag === "IMG") {
          const loaded = element.complete && element.naturalWidth > 0;
          const width = loaded ? element.naturalWidth : 0;
          const height = loaded ? element.naturalHeight : 0;
          let lazy = null;
          for (const name of LAZY) {
            const value = element.getAttribute(name);
            if (value && !/^data:/i.test(value)) {
              lazy = value;
              break;
            }
          }
          const current = element.currentSrc || element.getAttribute("src") || "";
          const best = largest(element.getAttribute("srcset")) || largest(element.getAttribute("data-srcset")) || lazy || current;
          const link = element.closest("a[href]");
          const post = site ? postOf(element) : null;
          if (link && typeof link.href === "string" && IMAGE_LINK.test(link.href)) add(link.href, width, height, best, post);
          else add(best, width, height, /^data:/i.test(current) ? null : current, post);
        } else if (tag === "SOURCE") {
          if (element.parentElement && element.parentElement.tagName === "PICTURE") {
            add(largest(element.getAttribute("srcset") || element.getAttribute("data-srcset")), 0, 0);
          }
        } else if (tag === "A") {
          if (typeof element.href === "string" && IMAGE_LINK.test(element.href) && !element.querySelector("img")) add(element.href, 0, 0);
        }
        const style = element.getAttribute("style") || "";
        if (style.indexOf("url(") >= 0) {
          Array.from(style.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/g)).forEach((match) => add(match[2], 0, 0));
        }
      });
    });
  };

  const scroller = (() => {
    const page = document.scrollingElement || document.documentElement;
    if (page.scrollHeight > window.innerHeight + 100) return page;
    let best = page;
    let area = 0;
    document.querySelectorAll("body *").forEach((element) => {
      if (element.scrollHeight <= element.clientHeight + 100) return;
      const overflow = getComputedStyle(element).overflowY;
      if (overflow !== "auto" && overflow !== "scroll") return;
      const size = element.clientWidth * element.clientHeight;
      if (size > area) {
        area = size;
        best = element;
      }
    });
    return best;
  })();

  const make = (tag, css, text) => {
    const element = document.createElement(tag);
    element.style.cssText = css;
    if (text) element.textContent = text;
    return element;
  };
  const buttonCss = "height:38px;border-radius:9px;font:700 13px system-ui,sans-serif;cursor:pointer;";
  box.style.cssText = "position:fixed;right:18px;bottom:18px;z-index:2147483647;";
  const shadow = box.attachShadow({ mode: "closed" });
  const panel = make("div", "width:290px;box-sizing:border-box;padding:14px 16px;border-radius:14px;background:#1c1d2c;color:#f8f8fc;font:14px/1.4 system-ui,sans-serif;text-align:left;box-shadow:0 18px 50px rgba(0,0,0,.45);border:1px solid rgba(173,138,255,.5);");
  const head = make("div", "display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;");
  const closeButton = make("button", "width:28px;height:28px;padding:0;border:0;border-radius:7px;background:transparent;color:#a9abbd;font:400 20px/1 system-ui,sans-serif;cursor:pointer;", "×");
  closeButton.title = "Fechar";
  head.append(make("strong", "font:800 15px system-ui,sans-serif;color:#ad8aff;", "Clipora"), closeButton);
  const count = make("div", "font:800 22px system-ui,sans-serif;", "0 imagens");
  const status = make("div", "min-height:17px;margin:2px 0 12px;color:#a9abbd;font-size:12px;", "");
  const row = make("div", "display:flex;gap:8px;");
  const sendButton = make("button", buttonCss + "flex:1;border:0;color:#fff;background:linear-gradient(135deg,#9a6bf4,#7450e9);", "Enviar ao Clipora");
  const pauseButton = make("button", buttonCss + "padding:0 12px;color:#e3e4ec;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.18);", "Pausar");
  row.append(sendButton, pauseButton);
  panel.append(head, count, status, row);
  shadow.append(panel);

  const render = () => {
    const total = found.size;
    count.textContent = total + (total === 1 ? " imagem" : " imagens");
    let text = scrolling ? "Rolando a página para carregar tudo..." : "Rolagem pausada.";
    if (finished) text = total >= LIMIT ? "Limite de " + LIMIT + " imagens." : "Fim da página.";
    if (sent) text = "Enviado: o Clipora abriu numa nova aba.";
    if (!total && blobs.size) text = "As imagens desta página são protegidas e não podem ser coletadas.";
    status.textContent = note || (sending && expandText) || text;
    pauseButton.textContent = scrolling ? "Pausar" : "Continuar";
    pauseButton.style.display = finished || sending ? "none" : "";
    sendButton.disabled = !total || sending;
    sendButton.style.opacity = total && !sending ? "1" : ".5";
  };

  const tick = () => {
    scan();
    if (found.size >= LIMIT && !finished) {
      finished = true;
      scrolling = false;
    }
    if (scrolling) {
      const height = scroller.scrollHeight;
      if (height !== lastHeight) {
        lastHeight = height;
        grewAt = Date.now();
      }
      const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 8;
      if (!atBottom) {
        bottomSince = 0;
        // Página que não rola de verdade (rolagem presa noutro elemento): sem sair do
        // lugar por 6 s e sem crescer, conta como fim.
        if (scroller.scrollTop !== lastTop) {
          lastTop = scroller.scrollTop;
          movedAt = Date.now();
        }
        if (Date.now() - movedAt > 6000 && Date.now() - grewAt > 5000) {
          finished = true;
          scrolling = false;
        } else {
          scroller.scrollTop += Math.max(300, scroller.clientHeight * 0.85);
        }
      } else {
        if (!bottomSince) bottomSince = Date.now();
        if (Date.now() - bottomSince > 5000 && Date.now() - grewAt > 5000) {
          finished = true;
          scrolling = false;
        }
      }
    }
    render();
    // Extensão: terminou de juntar, volta sozinho para o Clipora com a lista.
    if (viaExtension && finished && !sent && !sending && found.size) send();
  };

  // ---- Posts com várias imagens ----
  // Instagram e Reddit: o próprio navegador (com o login do usuário) lê o post no site.
  // X: a imagem vai marcada com o post ("x:<id>") e o servidor do Clipora lê o post pela
  // API pública de incorporação do X.
  const IG_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const instagramMediaId = (code) => {
    let value = 0n;
    for (const char of code.slice(0, 11)) value = value * 64n + BigInt(IG_ALPHABET.indexOf(char));
    return value.toString();
  };
  const expandInstagram = async (post) => {
    const response = await fetch("/api/v1/media/" + instagramMediaId(post.id) + "/info/", {
      credentials: "include",
      headers: { "X-IG-App-ID": "936619743392459", "X-Requested-With": "XMLHttpRequest" }
    });
    if (response.status === 429) throw new Error("limite");
    if (!response.ok) return;
    const data = await response.json();
    const media = data && data.items && data.items[0];
    const carousel = media && media.carousel_media;
    if (!Array.isArray(carousel) || carousel.length < 2) return;
    post.expanded = carousel.filter((part) => part.media_type === 1).map((part) => {
      const best = ((part.image_versions2 && part.image_versions2.candidates) || [])
        .slice().sort((a, b) => (b.width || 0) - (a.width || 0))[0];
      return best ? [best.url, best.width || 0, best.height || 0] : null;
    }).filter(Boolean);
  };
  const REDDIT_TYPES = { "image/jpg": "jpg", "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp" };
  const expandReddit = async (batch) => {
    const ids = batch.map((post) => "t3_" + post.id).join(",");
    const response = await fetch("/by_id/" + ids + ".json?raw_json=1", { credentials: "include" });
    if (!response.ok) return;
    const data = await response.json();
    const children = (data && data.data && data.data.children) || [];
    children.forEach((child) => {
      const info = child && child.data;
      if (!info) return;
      const post = batch.find((entry) => entry.id === info.id);
      const source = info.gallery_data ? info : (info.crosspost_parent_list || [])[0] || info;
      if (!post || !source.gallery_data || !source.media_metadata) return;
      post.expanded = (source.gallery_data.items || []).map((part) => {
        const meta = source.media_metadata[part.media_id];
        if (!meta || meta.status !== "valid" || !meta.s) return null;
        if (meta.e === "AnimatedImage" && meta.s.gif) return [meta.s.gif, meta.s.x || 0, meta.s.y || 0];
        const ext = REDDIT_TYPES[meta.m];
        return meta.e === "Image" && ext ? ["https://i.redd.it/" + part.media_id + "." + ext, meta.s.x || 0, meta.s.y || 0] : null;
      }).filter(Boolean);
    });
  };
  let expandText = "";
  const expandPosts = async () => {
    const pending = (name, limit) => Array.from(posts.values()).filter((post) => post.site === name && post.multi && !post.expanded).slice(0, limit);
    const reddit = pending("reddit", 2000);
    const instagram = pending("instagram", 400);
    const total = reddit.length + instagram.length;
    if (!total) return;
    let done = 0;
    const progress = () => {
      expandText = "Abrindo os posts com várias imagens: " + done + " de " + total + "...";
      render();
    };
    progress();
    for (let start = 0; start < reddit.length; start += 50) {
      const batch = reddit.slice(start, start + 50);
      batch.forEach((post) => { post.expanded = []; });
      try {
        await expandReddit(batch);
      } catch (error) {
        // fica a imagem que a página mostrava
      }
      done += batch.length;
      progress();
    }
    // O Instagram limita pedidos seguidos: 2 por vez e, se ele recusar, para.
    let next = 0;
    let stopped = false;
    const worker = async () => {
      while (!stopped && next < instagram.length) {
        const post = instagram[next++];
        post.expanded = [];
        try {
          await expandInstagram(post);
        } catch (error) {
          if (error && error.message === "limite") stopped = true;
        }
        done += 1;
        progress();
      }
    };
    await Promise.all([worker(), worker()]);
    expandText = "";
  };
  // Lista final: a imagem de um post aberto dá lugar a todas as do post.
  const buildItems = () => {
    const list = [];
    const placed = new Set();
    for (const [url, entry] of found) {
      const key = postOfUrl.get(url);
      const post = key && posts.get(key);
      if (post && post.expanded && post.expanded.length) {
        if (!placed.has(key)) {
          placed.add(key);
          post.expanded.forEach((item) => list.push(item));
        }
        continue;
      }
      if (post && post.site === "x" && post.urls.size === 1) list.push([entry[0], entry[1], entry[2], entry[3] || null, key]);
      else list.push(entry);
    }
    return list;
  };

  const buildTarget = () => {
    let items = buildItems();
    let truncated = false;
    const build = () => origin + "/#importar=" + encodeURIComponent(JSON.stringify({
      source: "page",
      url: location.href,
      title: document.title,
      items,
      truncated
    }));
    let target = build();
    while (target.length > 1800000 && items.length > 50) {
      items = items.slice(0, Math.floor(items.length * 0.8));
      truncated = true;
      target = build();
    }
    return target;
  };
  const close = () => {
    clearInterval(timer);
    box.remove();
    delete window.__cliporaColetor;
  };
  window.__cliporaColetor = { close, count: () => found.size, finished: () => finished, target: buildTarget };

  closeButton.addEventListener("click", close);
  pauseButton.addEventListener("click", () => {
    scrolling = !scrolling;
    bottomSince = 0;
    grewAt = Date.now();
    render();
  });
  const send = async () => {
    if (sending) return;
    sending = true;
    scrolling = false;
    scan();
    render();
    try {
      await expandPosts();
    } catch (error) {
      // segue com o que a página mostrava
    }
    const target = buildTarget();
    // Sem a extensão, a nova aba precisa vir de um clique: depois de abrir os posts,
    // o navegador pode bloquear; aí o usuário clica de novo (já sem esperar).
    const opened = openTarget(target);
    note = opened ? "" : "O navegador bloqueou a nova aba. Permita pop-ups para este site e clique de novo.";
    sent = Boolean(opened);
    sending = false;
    render();
  };
  sendButton.addEventListener("click", send);

  (document.body || document.documentElement).appendChild(box);
  scroller.scrollTop = 0;
  scan();
  render();
  setTimeout(() => {
    timer = setInterval(tick, 500);
  }, 700);
}
