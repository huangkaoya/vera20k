import type { AssetsManifest, BuildingPlacement, MapAsset, SpriteAsset, SpriteFrame, VeraEntity, VeraSnapshot } from './types';
import { resolveHttpUrl } from '../config/runtime';
import { resolveArtManifest } from './urls';
export type { AssetsManifest, BuildingPlacement, MapAsset, SpriteAsset, VeraEntity, VeraSnapshot } from './types';

// Fallback ordering is the native lobby priority: yellow, red, blue, green,
// orange, sky, purple, pink. Generated assets supply exact Rules HSV ramps.
const COLORS = ['#ffdf00', '#fe3333', '#3183ff', '#4eb55f', '#ff9c42', '#73d9e6', '#ae75e7', '#ef93c7'];
interface DrawnEntity { entity: VeraEntity; x: number; y: number; frame: SpriteFrame; sprite: SpriteAsset; }

/** Canvas is presentation only. Every entity and outcome comes from VERA WASM. */
export class BattlefieldRenderer {
  readonly canvas: HTMLCanvasElement;
  readonly manifest: AssetsManifest;
  readonly uncoveredTypes = new Set<string>();
  readonly selection = new Set<number>();
  camera = { x: 0, y: 0, zoom: 1 };
  map: MapAsset | undefined;
  snapshot: VeraSnapshot = { tick: 0, entities: [] };
  private readonly context: CanvasRenderingContext2D;
  private images = new Map<string, HTMLImageElement>();
  private pending = new Map<string, Promise<HTMLImageElement>>();
  private tinted = new Map<string, HTMLCanvasElement>();
  private cells = new Map<string, number>();
  private drawn: DrawnEntity[] = [];
  private placement: BuildingPlacement | null = null;
  private previousPositions = new Map<number, { x: number; y: number }>();
  private moving = new Set<number>();
  private pulse: { x: number; y: number; until: number; attack: boolean } | undefined;
  private cssWidth = 1;
  private cssHeight = 1;
  private dpr = 1;
  private selectionRect: { x1: number; y1: number; x2: number; y2: number } | undefined;

  static async loadManifest(url: string): Promise<AssetsManifest> {
    const manifestUrl = resolveHttpUrl(url, location.href);
    const response = await fetch(manifestUrl);
    if (!response.ok) throw new Error(`读取地图美术失败：${response.status}`);
    return resolveArtManifest(await response.json(), response.url || manifestUrl, location.href);
  }
  constructor(canvas: HTMLCanvasElement, manifest: AssetsManifest) {
    this.canvas = canvas; this.manifest = manifest;
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('浏览器无法建立游戏画布');
    this.context = context;
    if (manifest.maps[0]) this.setMap(manifest.maps[0].id);
  }
  async load(): Promise<void> {
    if (this.map) await this.loadImage(this.map.image);
    await Promise.all(['AMCV', 'SMCV', 'PCV', 'MTNK', 'HTNK', 'E1', 'E2', 'GACNST', 'NACNST', 'YACNST'].map(id => this.ensureSprite(id)));
    this.render();
  }
  setMap(mapId: string): void {
    const map = this.manifest.maps.find(entry => entry.id.toUpperCase() === mapId.toUpperCase());
    if (!map) throw new Error(`缺少地图美术：${mapId}`);
    this.map = map; this.cells.clear();
    for (const cell of map.cells) this.cells.set(`${cell.rx},${cell.ry}`, cell.z);
    const start = map.starts[0];
    if (start) this.centerOnCell(start.rx, start.ry);
    else this.camera = { x: map.originX + map.width / 2, y: map.originY + map.height / 2, zoom: 1 };
    void this.loadImage(map.image).then(() => this.render());
  }
  setSnapshot(snapshot: VeraSnapshot): void {
    if (snapshot.tick !== this.snapshot.tick) {
      this.moving.clear();
      for (const entity of snapshot.entities) {
        const prior = this.previousPositions.get(entity.id);
        if (prior && (Math.abs(prior.x - entity.sx) > .05 || Math.abs(prior.y - entity.sy) > .05)) this.moving.add(entity.id);
        this.previousPositions.set(entity.id, { x: entity.sx, y: entity.sy });
      }
    }
    this.snapshot = snapshot;
    for (const entity of snapshot.entities) if (!entity.limbo && entity.alive !== false && entity.visible !== false && entity.hp > 0) void this.ensureSprite(entity.typeId);
  }
  setSelection(ids: readonly number[]): void { this.selection.clear(); ids.forEach(id => this.selection.add(id)); }
  setPlacement(placement: BuildingPlacement | null): void { this.placement = placement; }
  setSelectionRect(rect: { x1: number; y1: number; x2: number; y2: number } | undefined): void { this.selectionRect = rect; }
  centerOnCell(rx: number, ry: number): void {
    const level = this.cells.get(`${rx},${ry}`) ?? 0;
    this.camera.x = (rx - ry) * 30;
    this.camera.y = (rx + ry) * 15 + 30 - level * 15;
  }
  centerOnWorld(x: number, y: number): void { this.camera.x = x; this.camera.y = y; }
  panBy(dx: number, dy: number): void { this.camera.x += dx / this.camera.zoom; this.camera.y += dy / this.camera.zoom; this.clampCamera(); }
  zoomAt(factor: number, clientX: number, clientY: number): void {
    const before = this.screenToWorld(clientX, clientY);
    this.camera.zoom = Math.max(.45, Math.min(2.5, this.camera.zoom * factor));
    const after = this.screenToWorld(clientX, clientY);
    this.camera.x += before.x - after.x; this.camera.y += before.y - after.y;
  }
  screenToWorld(clientX: number, clientY: number): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: (clientX - rect.left - rect.width / 2) / this.camera.zoom + this.camera.x,
      y: (clientY - rect.top - rect.height / 2) / this.camera.zoom + this.camera.y };
  }
  worldToScreen(x: number, y: number): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: rect.left + rect.width / 2 + (x - this.camera.x) * this.camera.zoom,
      y: rect.top + rect.height / 2 + (y - this.camera.y) * this.camera.zoom };
  }
  screenToCell(clientX: number, clientY: number): { rx: number; ry: number } {
    const point = this.screenToWorld(clientX, clientY);
    const col = point.x / 30;
    // Hit the highest resident diamond under the pointer, retaining real map
    // elevation rather than writing browser approximations into simulation.
    for (let level = 15; level >= 0; level--) {
      const row = (point.y - 30 + level * 15) / 15;
      const rx = Math.round((col + row) / 2), ry = Math.round((row - col) / 2);
      if (this.cells.get(`${rx},${ry}`) === level) return { rx, ry };
    }
    const row = (point.y - 30) / 15;
    return { rx: Math.max(0, Math.round((col + row) / 2)), ry: Math.max(0, Math.round((row - col) / 2)) };
  }
  hitTest(clientX: number, clientY: number): VeraEntity | undefined {
    const point = this.screenToWorld(clientX, clientY);
    for (const drawn of [...this.drawn].reverse()) {
      const left = drawn.x + drawn.frame.offsetX, top = drawn.y + drawn.frame.offsetY;
      if (point.x >= left && point.x < left + drawn.frame.width && point.y >= top && point.y < top + drawn.frame.height) return drawn.entity;
    }
    return undefined;
  }
  entitiesInRect(x1: number, y1: number, x2: number, y2: number): VeraEntity[] {
    const a = this.screenToWorld(Math.min(x1, x2), Math.min(y1, y2));
    const b = this.screenToWorld(Math.max(x1, x2), Math.max(y1, y2));
    return this.snapshot.entities.filter(entity => !entity.limbo && entity.alive !== false && entity.visible !== false && entity.hp > 0 && entity.sx >= a.x && entity.sx <= b.x && entity.sy >= a.y && entity.sy <= b.y);
  }
  flashOrder(rx: number, ry: number, attack = false): void {
    const level = this.cells.get(`${rx},${ry}`) ?? 0;
    this.pulse = { x: (rx - ry) * 30, y: (rx + ry) * 15 + 30 - level * 15, until: performance.now() + 600, attack };
  }
  render(): void {
    this.resize();
    const context = this.context, zoom = this.camera.zoom;
    context.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    context.fillStyle = '#050909'; context.fillRect(0, 0, this.cssWidth, this.cssHeight);
    context.save();
    context.translate(this.cssWidth / 2, this.cssHeight / 2); context.scale(zoom, zoom); context.translate(-this.camera.x, -this.camera.y);
    context.imageSmoothingEnabled = false;
    if (this.map) {
      const terrain = this.images.get(this.map.image);
      if (terrain) context.drawImage(terrain, this.map.originX, this.map.originY);
    }
    this.drawn = [];
    const entities = this.snapshot.entities.filter(entity => !entity.limbo && entity.alive !== false && entity.visible !== false && entity.hp > 0).sort((a, b) => a.sy - b.sy || a.sx - b.sx || a.id - b.id);
    for (const entity of entities) {
      const sprite = this.manifest.sprites[entity.typeId.toUpperCase()];
      if (!sprite) { this.uncoveredTypes.add(entity.typeId); continue; }
      const frame = this.frameFor(entity, sprite);
      // VERA BuildingClass::GetRenderCoords applies a half-tile art lift.
      const x = entity.sx, y = entity.sy - (entity.category === 'structure' ? 15 : 0);
      if (!frame || x + frame.offsetX + frame.width < this.camera.x - this.cssWidth / (2 * zoom) || x + frame.offsetX > this.camera.x + this.cssWidth / (2 * zoom) || y + frame.offsetY + frame.height < this.camera.y - this.cssHeight / (2 * zoom) || y + frame.offsetY > this.camera.y + this.cssHeight / (2 * zoom)) continue;
      const image = this.images.get(sprite.image);
      if (!image) continue;
      const drawn = { entity, x, y, frame, sprite };
      if (this.selection.has(entity.id)) this.drawGroundSelection(drawn);
      this.context.drawImage(this.coloredAtlas(entity, sprite) ?? image, frame.x, frame.y, frame.width, frame.height, x + frame.offsetX, y + frame.offsetY, frame.width, frame.height);
      if (this.selection.has(entity.id) || entity.hp < entity.maxHp) this.drawHealth(drawn);
      this.drawn.push(drawn);
    }
    this.drawFog();
    if (this.placement) this.drawPlacement(this.placement);
    if (this.pulse && this.pulse.until > performance.now()) {
      const radius = 7 + (this.pulse.until - performance.now()) / 55;
      context.strokeStyle = this.pulse.attack ? '#ff6152' : '#58ff82'; context.lineWidth = 1.5 / zoom;
      context.beginPath(); context.ellipse(this.pulse.x, this.pulse.y, radius, radius / 2, 0, 0, Math.PI * 2); context.stroke();
    }
    context.restore();
    if (this.selectionRect) {
      const rect = this.canvas.getBoundingClientRect(), s = this.selectionRect;
      context.strokeStyle = '#83e4a0'; context.fillStyle = 'rgba(50,180,90,.1)'; context.lineWidth = 1;
      context.fillRect(s.x1 - rect.left, s.y1 - rect.top, s.x2 - s.x1, s.y2 - s.y1);
      context.strokeRect(s.x1 - rect.left, s.y1 - rect.top, s.x2 - s.x1, s.y2 - s.y1);
    }
  }
  drawMinimap(canvas: HTMLCanvasElement): void {
    const context = canvas.getContext('2d'); if (!context || !this.map) return;
    const width = canvas.width, height = canvas.height, map = this.map;
    context.fillStyle = '#030908'; context.fillRect(0, 0, width, height);
    const scale = Math.min(width / map.width, height / map.height), ox = (width - map.width * scale) / 2, oy = (height - map.height * scale) / 2;
    const image = this.images.get(map.image); if (image) context.drawImage(image, ox, oy, map.width * scale, map.height * scale);
    const fog = this.snapshot.fog;
    if (fog) for (const cell of map.cells) {
      const bits = fog.cells[cell.ry * fog.width + cell.rx] ?? 0;
      if (bits & 2) continue;
      const x = ox + ((cell.rx - cell.ry) * 30 - map.originX) * scale;
      const y = oy + ((cell.rx + cell.ry) * 15 + 30 - cell.z * 15 - map.originY) * scale;
      context.fillStyle = bits & 1 ? 'rgba(0,0,0,.52)' : '#000';
      context.beginPath(); context.moveTo(x, y - 16 * scale); context.lineTo(x + 31 * scale, y);
      context.lineTo(x, y + 16 * scale); context.lineTo(x - 31 * scale, y); context.closePath(); context.fill();
    }
    for (const entity of this.snapshot.entities) if (!entity.limbo && entity.alive !== false && entity.visible !== false && entity.hp > 0) {
      context.fillStyle = this.ownerColor(entity.owner);
      context.fillRect(ox + (entity.sx - map.originX) * scale - 1.5, oy + (entity.sy - map.originY) * scale - 1.5, 3, 3);
    }
    context.strokeStyle = '#d8f6de'; context.lineWidth = 1;
    context.strokeRect(ox + (this.camera.x - this.cssWidth / (2 * this.camera.zoom) - map.originX) * scale, oy + (this.camera.y - this.cssHeight / (2 * this.camera.zoom) - map.originY) * scale, this.cssWidth / this.camera.zoom * scale, this.cssHeight / this.camera.zoom * scale);
  }
  minimapToWorld(canvas: HTMLCanvasElement, clientX: number, clientY: number): { x: number; y: number } | undefined {
    if (!this.map) return undefined;
    const rect = canvas.getBoundingClientRect(), map = this.map;
    const x = (clientX - rect.left) * canvas.width / rect.width, y = (clientY - rect.top) * canvas.height / rect.height;
    const scale = Math.min(canvas.width / map.width, canvas.height / map.height);
    return { x: (x - (canvas.width - map.width * scale) / 2) / scale + map.originX, y: (y - (canvas.height - map.height * scale) / 2) / scale + map.originY };
  }
  private resize(): void {
    const rect = this.canvas.getBoundingClientRect(); this.cssWidth = Math.max(1, rect.width); this.cssHeight = Math.max(1, rect.height); this.dpr = Math.min(2, devicePixelRatio || 1);
    const width = Math.round(this.cssWidth * this.dpr), height = Math.round(this.cssHeight * this.dpr);
    if (this.canvas.width !== width || this.canvas.height !== height) { this.canvas.width = width; this.canvas.height = height; }
  }
  private clampCamera(): void {
    if (!this.map) return;
    this.camera.x = Math.max(this.map.originX, Math.min(this.map.originX + this.map.width, this.camera.x));
    this.camera.y = Math.max(this.map.originY, Math.min(this.map.originY + this.map.height, this.camera.y));
  }
  private frameFor(entity: VeraEntity, sprite: SpriteAsset): SpriteFrame | undefined {
    const animation = this.moving.has(entity.id) || entity.moving ? 1 : 0;
    let frames = sprite.frames.filter(frame => frame.animation === animation);
    if (!frames.length) frames = sprite.frames;
    let distance = 999;
    for (const frame of frames) distance = Math.min(distance, angleDistance(frame.facing, entity.facing));
    frames = frames.filter(frame => angleDistance(frame.facing, entity.facing) === distance);
    return frames.length ? frames[Math.floor(this.snapshot.tick / 3) % frames.length] : sprite.frames[0];
  }
  private drawGroundSelection(drawn: DrawnEntity): void {
    const c = this.context, width = drawn.entity.category === 'structure' ? Math.max(30, drawn.sprite.foundation[0] * 20) : drawn.entity.category === 'infantry' ? 8 : 19;
    c.strokeStyle = '#78ff94'; c.lineWidth = 1 / this.camera.zoom;
    c.beginPath(); c.ellipse(drawn.entity.sx, drawn.entity.sy + 3, width, width / 2, 0, 0, Math.PI * 2); c.stroke();
  }
  private drawHealth(drawn: DrawnEntity): void {
    const width = Math.max(18, Math.min(76, drawn.frame.width * .55));
    const ratio = Math.max(0, Math.min(1, drawn.entity.hp / Math.max(1, drawn.entity.maxHp)));
    const x = drawn.x - width / 2, y = drawn.y + drawn.frame.offsetY - 8;
    const c = this.context; c.fillStyle = '#000'; c.fillRect(x - 1, y - 1, width + 2, 5);
    c.fillStyle = ratio > .5 ? '#59eb73' : ratio > .25 ? '#ffe464' : '#f45949'; c.fillRect(x, y, width * ratio, 3);
  }
  private drawPlacement(placement: BuildingPlacement): void {
    const sprite = this.manifest.sprites[placement.typeId.toUpperCase()], level = this.cells.get(`${placement.rx},${placement.ry}`) ?? 0;
    const c = this.context; c.save(); c.globalAlpha = .6;
    const [fw, fh] = sprite?.foundation ?? [1, 1];
    for (let i = 0; i < fw; i++) for (let j = 0; j < fh; j++) {
      const x = (placement.rx + i - placement.ry - j) * 30, y = (placement.rx + i + placement.ry + j) * 15 + 30 - level * 15;
      c.fillStyle = placement.valid ? '#2cd160' : '#ee5140'; c.strokeStyle = '#d2edc4'; c.lineWidth = 1;
      c.beginPath(); c.moveTo(x, y - 15); c.lineTo(x + 30, y); c.lineTo(x, y + 15); c.lineTo(x - 30, y); c.closePath(); c.fill(); c.stroke();
    }
    if (sprite) {
      const frame = sprite.frames[0], image = this.images.get(sprite.image);
      if (frame && image) c.drawImage(image, frame.x, frame.y, frame.width, frame.height, (placement.rx - placement.ry) * 30 + frame.offsetX, (placement.rx + placement.ry) * 15 + 15 - level * 15 + frame.offsetY, frame.width, frame.height);
      else void this.ensureSprite(placement.typeId);
    }
    c.restore();
  }
  private drawFog(): void {
    const fog = this.snapshot.fog;
    if (!fog || !this.map) return;
    const c = this.context;
    for (const cell of this.map.cells) {
      const index = cell.ry * fog.width + cell.rx;
      const bits = fog.cells[index] ?? 0;
      if (bits & 2) continue;
      const x = (cell.rx - cell.ry) * 30, y = (cell.rx + cell.ry) * 15 + 30 - cell.z * 15;
      c.fillStyle = bits & 1 ? 'rgba(0,0,0,.52)' : '#000';
      c.beginPath(); c.moveTo(x, y - 16); c.lineTo(x + 31, y); c.lineTo(x, y + 16); c.lineTo(x - 31, y); c.closePath(); c.fill();
    }
  }
  private ownerPriority(owner: number): number | undefined { return this.snapshot.players?.find(player => player.owner === owner)?.color; }
  private ownerColor(owner: number): string {
    const priority = this.ownerPriority(owner);
    return this.manifest.colors?.find(color => color.id === priority)?.hex ?? (priority === undefined ? '#cccccc' : COLORS[priority & 7]!);
  }
  private coloredAtlas(entity: VeraEntity, sprite: SpriteAsset): HTMLCanvasElement | undefined {
    if (!sprite.remapImage) return undefined;
    const priority = this.ownerPriority(entity.owner);
    if (priority === undefined) return undefined; // Neutral/special keep original palette.
    const palette = this.manifest.colors?.find(color => color.id === priority);
    const key = sprite.image + ':' + priority;
    const cached = this.tinted.get(key); if (cached) return cached;
    const image = this.images.get(sprite.image), mask = this.images.get(sprite.remapImage);
    if (!image || !mask || !palette) return undefined;
    const atlas = document.createElement('canvas'); atlas.width = image.width; atlas.height = image.height;
    const c = atlas.getContext('2d'); if (!c) return undefined;
    c.drawImage(image, 0, 0);
    const pixels = c.getImageData(0, 0, atlas.width, atlas.height);
    const maskCanvas = document.createElement('canvas'); maskCanvas.width = mask.width; maskCanvas.height = mask.height;
    const m = maskCanvas.getContext('2d'); if (!m) return undefined;
    m.drawImage(mask, 0, 0);
    const remap = m.getImageData(0, 0, mask.width, mask.height).data;
    for (let offset = 0; offset < remap.length; offset += 4) {
      if (!remap[offset + 3]) continue;
      const shade = Math.max(0, Math.min(15, Math.round((255 - remap[offset]!) / 11)));
      const rgb = palette.ramp[shade]; if (!rgb) continue;
      pixels.data[offset] = rgb[0]!; pixels.data[offset + 1] = rgb[1]!; pixels.data[offset + 2] = rgb[2]!;
    }
    c.putImageData(pixels, 0, 0); this.tinted.set(key, atlas); return atlas;
  }
  private async ensureSprite(id: string): Promise<void> {
    const sprite = this.manifest.sprites[id.toUpperCase()]; if (!sprite) return;
    await Promise.all([this.loadImage(sprite.image), ...(sprite.remapImage ? [this.loadImage(sprite.remapImage)] : [])]);
  }
  private loadImage(url: string): Promise<HTMLImageElement> {
    const cached = this.images.get(url); if (cached) return Promise.resolve(cached);
    const pending = this.pending.get(url); if (pending) return pending;
    const promise = new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image(); image.onload = () => { this.images.set(url, image); this.pending.delete(url); resolve(image); };
      image.onerror = () => { this.pending.delete(url); reject(new Error(`无法加载游戏美术 ${url}`)); }; image.crossOrigin = 'anonymous'; image.src = url;
    });
    this.pending.set(url, promise); return promise;
  }
}
function angleDistance(a: number, b: number): number { const d = Math.abs((a & 255) - (b & 255)); return Math.min(d, 256 - d); }
