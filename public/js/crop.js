import { clamp } from "./util.js";

// Proporcoes prontas (largura / altura em pixels). "original" usa a do video.
export const CROP_RATIOS = [
  { key: "free", label: "Livre" },
  { key: "original", label: "Original" },
  { key: "16:9", label: "16:9", value: 16 / 9 },
  { key: "9:16", label: "9:16", value: 9 / 16 },
  { key: "1:1", label: "1:1", value: 1 },
  { key: "4:3", label: "4:3", value: 4 / 3 }
];

const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
const MIN_SOURCE_PIXELS = 16;
const MIN_SCREEN_PIXELS = 12;

// Caixa de recorte sobre um <video>. O recorte fica em fracoes do quadro
// exibido ({ x, y, w, h }), entao funciona igual para videos girados.
export class CropSelector {
  constructor({ wrap, video, getSourceSize, onChange, onCommit }) {
    this.wrap = wrap;
    this.video = video;
    this.getSourceSize = getSourceSize;
    this.onChange = onChange;
    this.onCommit = onCommit;
    this.crop = null;
    this.active = false;
    this.preview = false;
    this.ratioKey = "free";
    this.drag = null;

    this.overlay = document.createElement("div");
    this.overlay.className = "crop-overlay hidden";
    this.overlay.innerHTML = `
      <div class="crop-shade"><span class="crop-hole hidden"></span></div>
      <div class="crop-box hidden">${HANDLES.map((handle) => `<i class="crop-handle" data-handle="${handle}"></i>`).join("")}</div>
      <div class="crop-hint">Arraste sobre o vídeo para selecionar a área</div>`;
    this.hole = this.overlay.querySelector(".crop-hole");
    this.box = this.overlay.querySelector(".crop-box");
    this.hint = this.overlay.querySelector(".crop-hint");
    this.badge = document.createElement("span");
    this.badge.className = "crop-preview-badge hidden";
    this.badge.textContent = "Visualização do enquadramento";
    wrap.append(this.overlay, this.badge);

    this.overlay.addEventListener("pointerdown", (event) => this.startDrag(event));
    this.overlay.addEventListener("pointermove", (event) => this.moveDrag(event));
    this.overlay.addEventListener("pointerup", (event) => this.finishDrag(event));
    this.overlay.addEventListener("pointercancel", (event) => this.finishDrag(event));
    video.addEventListener("loadedmetadata", () => this.layout());
    // "resize" avisa quando o tamanho real do quadro muda (inclusive por pixels
    // nao quadrados), o que corrige a area quando os metadados chegam depois.
    video.addEventListener("resize", () => this.layout());
    video.addEventListener("loadeddata", () => this.layout());
    video.addEventListener("click", () => {
      if (!this.preview) return;
      if (video.paused) video.play().catch(() => {});
      else video.pause();
    });
    new ResizeObserver(() => this.layout()).observe(wrap);
  }

  // Tamanho real do quadro (informado pelo servidor, ja considerando rotacao).
  sourceSize() {
    const size = this.getSourceSize?.() || {};
    return {
      width: size.width || this.video.videoWidth || 16,
      height: size.height || this.video.videoHeight || 9
    };
  }

  ratioValue(key = this.ratioKey) {
    if (key === "original") {
      const { width, height } = this.sourceSize();
      return width / height;
    }
    return CROP_RATIOS.find((ratio) => ratio.key === key)?.value || null;
  }

  // Area ocupada pela imagem dentro do player. O proprio navegador dimensiona o
  // <video> (width/height auto + max 100%), entao a caixa do elemento JA e a
  // imagem exibida: nao ha conta de proporcao para errar com pixels nao
  // quadrados, video girado ou metadados que chegam atrasados.
  contentRect() {
    const wrapRect = this.wrap.getBoundingClientRect();
    const videoRect = this.video.getBoundingClientRect();
    return {
      left: videoRect.left - wrapRect.left,
      top: videoRect.top - wrapRect.top,
      width: videoRect.width,
      height: videoRect.height,
      wrapWidth: wrapRect.width,
      wrapHeight: wrapRect.height
    };
  }

  setActive(active) {
    this.active = active;
    // O tamanho do quadro pode chegar depois: remede no proximo quadro exibido.
    if (active) {
      requestAnimationFrame(() => this.layout());
      this.video.requestVideoFrameCallback?.(() => this.layout());
    }
    if (active) this.video.pause();
    else this.preview = false;
    this.render();
  }

  setCrop(crop) {
    this.crop = crop ? { ...crop } : null;
    if (!this.crop) this.preview = false;
    this.render();
  }

  reset() {
    this.crop = null;
    this.active = false;
    this.preview = false;
    this.ratioKey = "free";
    this.drag = null;
    this.render();
  }

  togglePreview(force) {
    this.preview = Boolean(this.crop) && (force ?? !this.preview);
    this.render();
  }

  // Aplica uma proporcao pronta ao recorte atual, mantendo o centro.
  setRatio(key) {
    this.ratioKey = key;
    const ratio = this.ratioValue(key);
    const { width: W, height: H } = this.sourceSize();
    if (ratio) {
      const before = this.crop ? { ...this.crop } : null;
      const base = this.crop || { x: 0.2, y: 0.2, w: 0.6, h: 0.6 };
      let widthPx = base.w * W;
      let heightPx = base.h * H;
      if (widthPx / heightPx > ratio) widthPx = heightPx * ratio;
      else heightPx = widthPx / ratio;
      const centerX = base.x + base.w / 2;
      const centerY = base.y + base.h / 2;
      const w = widthPx / W;
      const h = heightPx / H;
      this.crop = {
        w,
        h,
        x: clamp(centerX - w / 2, 0, 1 - w),
        y: clamp(centerY - h / 2, 0, 1 - h)
      };
      this.onCommit?.(before);
      this.onChange?.();
    }
    this.render();
  }

  describe(scaleMode) {
    const { width: W, height: H } = this.sourceSize();
    if (!this.crop) return { cropWidth: W, cropHeight: H, outWidth: W, outHeight: H, zoom: 1 };
    const cropWidth = Math.max(2, Math.round((this.crop.w * W) / 2) * 2);
    const cropHeight = Math.max(2, Math.round((this.crop.h * H) / 2) * 2);
    if (scaleMode !== "fit") return { cropWidth, cropHeight, outWidth: cropWidth, outHeight: cropHeight, zoom: 1 };
    const zoom = Math.min(W / cropWidth, H / cropHeight);
    return {
      cropWidth,
      cropHeight,
      outWidth: Math.round((cropWidth * zoom) / 2) * 2,
      outHeight: Math.round((cropHeight * zoom) / 2) * 2,
      zoom
    };
  }

  render() {
    this.overlay.classList.toggle("hidden", !this.active || this.preview);
    this.box.classList.toggle("hidden", !this.crop);
    this.hole.classList.toggle("hidden", !this.crop);
    this.overlay.classList.toggle("empty", !this.crop);
    this.hint.classList.toggle("hidden", Boolean(this.crop));
    this.badge.classList.toggle("hidden", !this.preview);
    this.video.controls = !this.preview;
    this.layout();
  }

  layout() {
    const rect = this.contentRect();
    Object.assign(this.overlay.style, {
      left: `${rect.left}px`,
      top: `${rect.top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`
    });
    if (this.crop) {
      const boxStyle = {
        left: `${this.crop.x * 100}%`,
        top: `${this.crop.y * 100}%`,
        width: `${this.crop.w * 100}%`,
        height: `${this.crop.h * 100}%`
      };
      Object.assign(this.box.style, boxStyle);
      Object.assign(this.hole.style, boxStyle);
    }

    if (!this.preview || !this.crop) {
      this.video.style.transform = "";
      this.video.style.clipPath = "";
      return;
    }
    // Visualizacao: recorta o <video> na area escolhida e amplia ate caber no
    // player. As medidas abaixo sao relativas ao proprio elemento de video.
    const left = this.crop.x * rect.width;
    const top = this.crop.y * rect.height;
    const width = this.crop.w * rect.width;
    const height = this.crop.h * rect.height;
    const scale = Math.min(rect.wrapWidth / width, rect.wrapHeight / height);
    const translateX = rect.wrapWidth / 2 - rect.left - scale * (left + width / 2);
    const translateY = rect.wrapHeight / 2 - rect.top - scale * (top + height / 2);
    this.video.style.clipPath =
      `inset(${top}px ${rect.width - left - width}px ${rect.height - top - height}px ${left}px)`;
    this.video.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`;
  }

  // A área de recorte só existe se o player já tiver tamanho na tela.
  hasLayout() {
    const rect = this.overlay.getBoundingClientRect();
    return rect.width > 1 && rect.height > 1;
  }

  pointerFraction(event) {
    const rect = this.overlay.getBoundingClientRect();
    return {
      x: clamp((event.clientX - rect.left) / rect.width, 0, 1),
      y: clamp((event.clientY - rect.top) / rect.height, 0, 1)
    };
  }

  minimumSize() {
    const { width: W, height: H } = this.sourceSize();
    const rect = this.overlay.getBoundingClientRect();
    return {
      w: Math.max(MIN_SOURCE_PIXELS / W, MIN_SCREEN_PIXELS / Math.max(1, rect.width)),
      h: Math.max(MIN_SOURCE_PIXELS / H, MIN_SCREEN_PIXELS / Math.max(1, rect.height))
    };
  }

  startDrag(event) {
    if (!this.active || event.button !== 0) return;
    // Se o player ainda não foi medido (ex.: acabou de aparecer), mede agora.
    if (!this.hasLayout()) this.layout();
    if (!this.hasLayout()) return;
    event.preventDefault();
    const handle = event.target.dataset?.handle;
    const insideBox = this.crop && event.target.closest(".crop-box");
    this.drag = {
      mode: handle ? "resize" : insideBox ? "move" : "draw",
      handle,
      pointerId: event.pointerId,
      origin: this.pointerFraction(event),
      start: this.crop ? { ...this.crop } : null,
      before: this.crop ? { ...this.crop } : null,
      changed: false
    };
    this.overlay.setPointerCapture(event.pointerId);
  }

  // Proporcao travada: pela proporcao pronta ou, no modo livre, pelo Shift.
  lockedRatio(event, start) {
    const preset = this.ratioValue();
    if (preset) return preset;
    if (!event.shiftKey || !start) return null;
    const { width: W, height: H } = this.sourceSize();
    return (start.w * W) / (start.h * H);
  }

  moveDrag(event) {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    const point = this.pointerFraction(event);
    const { width: W, height: H } = this.sourceSize();
    const min = this.minimumSize();
    let next;

    if (drag.mode === "move") {
      const { start, origin } = drag;
      next = {
        ...start,
        x: clamp(start.x + point.x - origin.x, 0, 1 - start.w),
        y: clamp(start.y + point.y - origin.y, 0, 1 - start.h)
      };
    } else if (drag.mode === "draw") {
      next = this.drawRect(drag.origin, point, this.lockedRatio(event, null), W, H);
    } else {
      next = this.resizeRect(drag.start, drag.handle, point, this.lockedRatio(event, drag.start), W, H, min);
    }

    if (![next.x, next.y, next.w, next.h].every(Number.isFinite)) return;
    this.crop = next;
    drag.changed = true;
    this.render();
    this.onChange?.();
  }

  drawRect(origin, point, ratio, W, H) {
    if (!ratio) {
      return {
        x: Math.min(origin.x, point.x),
        y: Math.min(origin.y, point.y),
        w: Math.abs(point.x - origin.x),
        h: Math.abs(point.y - origin.y)
      };
    }
    const directionX = point.x >= origin.x ? 1 : -1;
    const directionY = point.y >= origin.y ? 1 : -1;
    const availableX = (directionX > 0 ? 1 - origin.x : origin.x) * W;
    const availableY = (directionY > 0 ? 1 - origin.y : origin.y) * H;
    let widthPx = Math.max(Math.abs(point.x - origin.x) * W, Math.abs(point.y - origin.y) * H * ratio);
    widthPx = Math.min(widthPx, availableX, availableY * ratio);
    const w = widthPx / W;
    const h = widthPx / ratio / H;
    return {
      x: directionX > 0 ? origin.x : origin.x - w,
      y: directionY > 0 ? origin.y : origin.y - h,
      w,
      h
    };
  }

  resizeRect(start, handle, point, ratio, W, H, min) {
    let left = start.x;
    let top = start.y;
    let right = start.x + start.w;
    let bottom = start.y + start.h;
    const west = handle.includes("w");
    const east = handle.includes("e");
    const north = handle.includes("n");
    const south = handle.includes("s");

    if (!ratio) {
      if (west) left = clamp(point.x, 0, right - min.w);
      if (east) right = clamp(point.x, left + min.w, 1);
      if (north) top = clamp(point.y, 0, bottom - min.h);
      if (south) bottom = clamp(point.y, top + min.h, 1);
      return { x: left, y: top, w: right - left, h: bottom - top };
    }

    const minWidthPx = Math.max(min.w * W, min.h * H * ratio);
    const isCorner = (west || east) && (north || south);
    if (isCorner) {
      // O canto oposto fica parado.
      const anchorX = west ? right : left;
      const anchorY = north ? bottom : top;
      const availableX = (west ? anchorX : 1 - anchorX) * W;
      const availableY = (north ? anchorY : 1 - anchorY) * H;
      const reachX = Math.max(0, (west ? anchorX - point.x : point.x - anchorX) * W);
      const reachY = Math.max(0, (north ? anchorY - point.y : point.y - anchorY) * H);
      const widthPx = clamp(Math.max(reachX, reachY * ratio), minWidthPx, Math.min(availableX, availableY * ratio));
      const w = widthPx / W;
      const h = widthPx / ratio / H;
      return { x: west ? anchorX - w : anchorX, y: north ? anchorY - h : anchorY, w, h };
    }

    if (west || east) {
      // Lateral: a largura segue o ponteiro e a altura cresce a partir do centro.
      const centerY = (top + bottom) / 2;
      const maxHeightPx = 2 * Math.min(centerY, 1 - centerY) * H;
      const anchorX = west ? right : left;
      const availableX = (west ? anchorX : 1 - anchorX) * W;
      const reach = Math.max(0, (west ? anchorX - point.x : point.x - anchorX) * W);
      const widthPx = clamp(reach, minWidthPx, Math.min(availableX, maxHeightPx * ratio));
      const w = widthPx / W;
      const h = widthPx / ratio / H;
      return { x: west ? anchorX - w : anchorX, y: centerY - h / 2, w, h };
    }

    const centerX = (left + right) / 2;
    const maxWidthPx = 2 * Math.min(centerX, 1 - centerX) * W;
    const anchorY = north ? bottom : top;
    const availableY = (north ? anchorY : 1 - anchorY) * H;
    const reach = Math.max(0, (north ? anchorY - point.y : point.y - anchorY) * H);
    const heightPx = clamp(reach, minWidthPx / ratio, Math.min(availableY, maxWidthPx / ratio));
    const w = (heightPx * ratio) / W;
    const h = heightPx / H;
    return { x: centerX - w / 2, y: north ? anchorY - h : anchorY, w, h };
  }

  finishDrag(event) {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    this.drag = null;
    if (!drag.changed) return;

    const min = this.minimumSize();
    if (drag.mode === "draw" && (!this.crop || this.crop.w < min.w || this.crop.h < min.h)) {
      // Clique sem arrastar (ou area minuscula): mantem o recorte anterior.
      this.crop = drag.before;
      this.render();
      this.onChange?.();
      return;
    }
    this.onCommit?.(drag.before);
    this.onChange?.();
  }
}
