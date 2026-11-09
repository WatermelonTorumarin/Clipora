import { enderecoClipora } from "./ajustes.js";

// Clique no ícone: abre a janelinha do Clipora para a aba atual. É uma janela (e não um
// pop-up do ícone) porque a janela "Salvar como" do Windows fecharia o pop-up.
chrome.action.onClicked.addListener(async (tab) => {
  const params = new URLSearchParams({ aba: String(tab.id), janela: String(tab.windowId), url: tab.url || "", titulo: tab.title || "" });
  const width = 420;
  const height = 600;
  let left;
  let top;
  try {
    const atual = await chrome.windows.get(tab.windowId);
    left = Math.max(0, atual.left + atual.width - width - 24);
    top = atual.top + 80;
  } catch {
    // posição padrão
  }
  await chrome.windows.create({ url: `janela.html?${params}`, type: "popup", width, height, left, top, focused: true });
});

// O coletor (rodando na página) pede para abrir o Clipora com as imagens que juntou.
chrome.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== "clipora-abrir" || typeof message.url !== "string") return;
  enderecoClipora().then((base) => {
    if (!message.url.startsWith(`${base}/`)) return; // só abre o próprio Clipora
    chrome.tabs.create({
      url: message.url,
      index: sender.tab ? sender.tab.index + 1 : undefined,
      openerTabId: sender.tab?.id
    });
  });
});
