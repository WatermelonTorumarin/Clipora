import { CLIPORA_PADRAO } from "./config.js";

// Endereço do Clipora usado pela extensão. Vem do config.js (endereço de onde o .zip foi
// baixado) e pode ser trocado na engrenagem da janelinha.
export async function enderecoClipora() {
  const { clipora } = await chrome.storage.sync.get("clipora");
  return String(clipora || CLIPORA_PADRAO).replace(/\/+$/, "");
}

export async function salvarEnderecoClipora(valor) {
  await chrome.storage.sync.set({ clipora: String(valor).replace(/\/+$/, "") });
}
