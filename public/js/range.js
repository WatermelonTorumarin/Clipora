import { clamp, formatClipLength, formatTimeInput, parseTimeInput } from "./util.js";

const MIN_LENGTH = 0.1;
const DETAIL_SPAN = 60;

// Escolha de um trecho com duas barras (video inteiro e ~1 min ao redor do
// trecho), campos de tempo digitado e botao para ouvir so o trecho em repeticao.
export class RangeSelector {
  constructor({ root, video, maxLength = Infinity, onChange }) {
    this.root = root;
    this.video = video;
    this.maxLength = maxLength;
    this.onChange = onChange;
    this.duration = 0;
    this.start = 0;
    this.end = 0;
    this.window = { from: 0, to: 0 };
    this.drag = null;
    this.looping = false;

    root.classList.add("range-selector");
    root.innerHTML = `
      <div class="range-bar" data-bar="overview">
        <span class="range-bar-label">Vídeo inteiro</span>
        <div class="range-track">
          <span class="range-fill"></span>
          <i class="range-handle" data-handle="start"></i>
          <i class="range-handle" data-handle="end"></i>
          <span class="range-playhead"></span>
        </div>
        <div class="range-scale"><span data-scale="from"></span><span data-scale="to"></span></div>
      </div>
      <div class="range-bar detail" data-bar="detail">
        <span class="range-bar-label">Ajuste fino</span>
        <div class="range-track">
          <span class="range-fill"></span>
          <i class="range-handle" data-handle="start"></i>
          <i class="range-handle" data-handle="end"></i>
          <span class="range-playhead"></span>
        </div>
        <div class="range-scale"><span data-scale="from"></span><span data-scale="to"></span></div>
      </div>
      <div class="range-fields">
        <label class="time-field"><span>Início</span><input data-field="start" type="text" inputmode="decimal" autocomplete="off" /></label>
        <label class="time-field"><span>Fim</span><input data-field="end" type="text" inputmode="decimal" autocomplete="off" /></label>
        <div class="range-length"><span>Duração</span><strong data-length></strong></div>
        <button class="range-loop" type="button">Ver trecho</button>
      </div>
      <p class="range-warning hidden"></p>`;

    this.bars = {
      overview: root.querySelector('[data-bar="overview"]'),
      detail: root.querySelector('[data-bar="detail"]')
    };
    this.startInput = root.querySelector('[data-field="start"]');
    this.endInput = root.querySelector('[data-field="end"]');
    this.lengthLabel = root.querySelector("[data-length]");
    this.loopButton = root.querySelector(".range-loop");
    this.warning = root.querySelector(".range-warning");

    for (const [name, bar] of Object.entries(this.bars)) {
      const track = bar.querySelector(".range-track");
      track.addEventListener("pointerdown", (event) => this.startDrag(event, name, track));
      track.addEventListener("pointermove", (event) => this.moveDrag(event));
      track.addEventListener("pointerup", (event) => this.finishDrag(event));
      track.addEventListener("pointercancel", (event) => this.finishDrag(event));
    }
    for (const input of [this.startInput, this.endInput]) {
      input.addEventListener("change", () => this.applyTypedTime(input));
      input.addEventListener("blur", () => this.render(true));
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") input.blur();
      });
    }
    this.loopButton.addEventListener("click", () => this.toggleLoop());
    video.addEventListener("timeupdate", () => this.onTimeUpdate());
    video.addEventListener("seeked", () => this.renderPlayheads());
  }

  setDuration(duration) {
    this.duration = Math.max(0, duration);
    this.start = 0;
    this.end = Math.min(this.duration, this.maxLength);
    this.stopLoop();
    this.hideWarning();
    this.recenterWindow();
    this.render();
  }

  value() {
    return { start: this.start, end: this.end };
  }

  recenterWindow() {
    const length = this.end - this.start;
    const span = Math.min(this.duration, Math.max(DETAIL_SPAN, length * 1.3));
    const center = (this.start + this.end) / 2;
    const from = clamp(center - span / 2, 0, Math.max(0, this.duration - span));
    this.window = { from, to: from + span };
  }

  barRange(name) {
    return name === "overview" ? { from: 0, to: this.duration } : this.window;
  }

  render(forceFields = false) {
    for (const [name, bar] of Object.entries(this.bars)) {
      const { from, to } = this.barRange(name);
      const span = Math.max(0.001, to - from);
      const left = clamp((this.start - from) / span, 0, 1) * 100;
      const right = clamp((this.end - from) / span, 0, 1) * 100;
      bar.querySelector(".range-fill").style.left = `${left}%`;
      bar.querySelector(".range-fill").style.width = `${Math.max(0, right - left)}%`;
      bar.querySelector('[data-handle="start"]').style.left = `${left}%`;
      bar.querySelector('[data-handle="end"]').style.left = `${right}%`;
      bar.querySelector('[data-scale="from"]').textContent = formatTimeInput(from);
      bar.querySelector('[data-scale="to"]').textContent = formatTimeInput(to);
    }
    // Enquanto o usuário digita, o campo não é sobrescrito.
    if (forceFields || document.activeElement !== this.startInput) this.startInput.value = formatTimeInput(this.start);
    if (forceFields || document.activeElement !== this.endInput) this.endInput.value = formatTimeInput(this.end);
    const limit = Number.isFinite(this.maxLength) ? ` (máx. ${this.maxLength} s)` : "";
    this.lengthLabel.textContent = `${formatClipLength(this.end - this.start)}${limit}`;
    this.renderPlayheads();
  }

  renderPlayheads() {
    const time = this.video.currentTime || 0;
    for (const [name, bar] of Object.entries(this.bars)) {
      const { from, to } = this.barRange(name);
      const playhead = bar.querySelector(".range-playhead");
      const inside = time >= from && time <= to;
      playhead.classList.toggle("hidden", !inside);
      if (inside) playhead.style.left = `${((time - from) / Math.max(0.001, to - from)) * 100}%`;
    }
  }

  emit(forceFields = false) {
    this.render(forceFields);
    this.onChange?.(this.value());
  }

  showWarning(text) {
    this.warning.textContent = text;
    this.warning.classList.remove("hidden");
  }

  hideWarning() {
    this.warning.classList.add("hidden");
  }

  timeFromPointer(event, name, track) {
    const rect = track.getBoundingClientRect();
    const { from, to } = this.barRange(name);
    return from + clamp((event.clientX - rect.left) / rect.width, 0, 1) * (to - from);
  }

  startDrag(event, name, track) {
    if (event.button !== 0 || !this.duration) return;
    event.preventDefault();
    const time = this.timeFromPointer(event, name, track);
    const handle = event.target.dataset?.handle;
    const insideFill = event.target.classList.contains("range-fill");
    this.drag = {
      name,
      track,
      pointerId: event.pointerId,
      mode: handle || (insideFill ? "move" : "seek"),
      originTime: time,
      start: this.start,
      end: this.end
    };
    track.setPointerCapture(event.pointerId);
    this.video.pause();
    this.stopLoop();
    if (this.drag.mode === "seek") this.seek(time);
  }

  moveDrag(event) {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    const time = this.timeFromPointer(event, drag.name, drag.track);
    this.hideWarning();

    if (drag.mode === "seek") {
      this.seek(time);
      return;
    }
    if (drag.mode === "move") {
      const length = drag.end - drag.start;
      this.start = clamp(drag.start + time - drag.originTime, 0, this.duration - length);
      this.end = this.start + length;
      this.seek(this.start);
    } else if (drag.mode === "start") {
      const earliest = Math.max(0, this.end - this.maxLength);
      this.start = clamp(time, earliest, this.end - MIN_LENGTH);
      if (time < earliest) this.showWarning(`O trecho pode ter no máximo ${this.maxLength} s.`);
      this.seek(this.start);
    } else {
      const latest = Math.min(this.duration, this.start + this.maxLength);
      this.end = clamp(time, this.start + MIN_LENGTH, latest);
      if (time > latest && latest < this.duration) this.showWarning(`O trecho pode ter no máximo ${this.maxLength} s.`);
      this.seek(this.end);
    }
    this.emit();
  }

  finishDrag(event) {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    this.drag = null;
    // A barra de ajuste fino so se reposiciona quando o trecho sai dela.
    if (drag.name === "overview" || this.start < this.window.from || this.end > this.window.to) {
      this.recenterWindow();
      this.render();
    }
  }

  applyTypedTime(input) {
    const typed = parseTimeInput(input.value);
    this.hideWarning();
    if (typed == null) {
      this.showWarning("Formato de tempo inválido. Use, por exemplo, 83, 1:23 ou 1:23.5.");
      this.render(true);
      return;
    }

    if (input === this.startInput) {
      const length = Math.min(this.end - this.start, this.maxLength);
      this.start = clamp(typed, 0, Math.max(0, this.duration - MIN_LENGTH));
      if (this.end <= this.start + MIN_LENGTH || this.end - this.start > this.maxLength) {
        this.end = Math.min(this.duration, this.start + Math.max(MIN_LENGTH, length));
      }
    } else {
      let end = clamp(typed, 0, this.duration);
      if (end <= this.start + MIN_LENGTH) {
        this.showWarning("O fim precisa vir depois do início.");
        this.render(true);
        return;
      }
      if (end - this.start > this.maxLength) {
        end = this.start + this.maxLength;
        this.showWarning(`O trecho pode ter no máximo ${this.maxLength} s; o fim foi ajustado para ${formatTimeInput(end)}.`);
      }
      this.end = end;
    }
    this.recenterWindow();
    this.seek(input === this.startInput ? this.start : this.end);
    this.emit(true);
  }

  seek(time) {
    if (!Number.isFinite(time)) return;
    this.video.currentTime = clamp(time, 0, this.duration);
    this.renderPlayheads();
  }

  toggleLoop() {
    if (this.looping) {
      this.stopLoop();
      return;
    }
    this.looping = true;
    this.loopButton.textContent = "Parar";
    this.loopButton.classList.add("active");
    this.video.currentTime = this.start;
    this.video.play().catch(() => this.stopLoop());
  }

  stopLoop() {
    if (!this.looping) return;
    this.looping = false;
    this.loopButton.textContent = "Ver trecho";
    this.loopButton.classList.remove("active");
    this.video.pause();
  }

  onTimeUpdate() {
    if (this.looping && (this.video.currentTime >= this.end || this.video.currentTime < this.start - 0.25)) {
      this.video.currentTime = this.start;
    }
    this.renderPlayheads();
  }
}
