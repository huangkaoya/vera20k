import { IsoCoords } from '../../../../engine/IsoCoords';
import { CanvasUtils } from '../../../../engine/gfx/CanvasUtils';
import { Coords } from '../../../../game/Coords';
import { HtmlContainer } from '../../../HtmlContainer';
import { UiObject } from '../../../UiObject';
import { LobbyType } from './component/viewmodel/lobby';

export interface MapPreviewSize {
  height: number;
  width: number;
}

export interface MapPreviewRect extends MapPreviewSize {
  x: number;
  y: number;
}

export interface MapPreviewImage {
  data: Uint8Array;
  height: number;
  width: number;
}

export interface MapPreviewMap {
  decodePreviewImage(): MapPreviewImage | undefined;
  fullSize: MapPreviewSize;
  localSize: MapPreviewRect;
  startingLocations: ReadonlyMap<number, { x: number; y: number }> | readonly { x: number; y: number }[];
}

export interface MapPreviewStrings {
  get(key: string | undefined): string;
}

const tooltipByLobbyType = new Map<LobbyType, string>([
  [LobbyType.Singleplayer, 'STT:SkirmishMapThumbnail'],
  [LobbyType.MultiplayerHost, 'STT:HostMapThumbnail'],
  [LobbyType.MultiplayerGuest, 'STT:GuestMapThumbnail'],
]);

// These are theme illustrations for the built-in race maps, not tactical
// previews: starting-position numbers would not correspond to the artwork.
const racePreviews = new Map([
  ['ra2web_race_arctic.map', {
    src: new URL('../../../../../resources/race/previews/race-arctic-preview.jpg', import.meta.url).href,
    titleKey: 'GUI:RaceMapArctic',
  }],
  ['ra2web_race_long_march.map', {
    src: new URL('../../../../../resources/race/previews/race-long-march-preview.jpg', import.meta.url).href,
    titleKey: 'GUI:RaceMapLongMarch',
  }],
]);

let __export_MapPreviewRenderer: typeof r;
class r {
  strings: MapPreviewStrings;

  constructor(strings: MapPreviewStrings) {
    this.strings = strings;
  }

  render(map: MapPreviewMap, lobbyType: LobbyType, bounds: MapPreviewSize, fileName?: string): UiObject | undefined {
    const racePreview = racePreviews.get(fileName?.toLowerCase() ?? '');
    if (racePreview) {
      const image = document.createElement('img');
      image.src = racePreview.src;
      image.alt = this.strings.get(racePreview.titleKey);
      image.width = bounds.width;
      image.height = bounds.height;
      image.draggable = false;
      image.setAttribute('data-race-map-preview', fileName!);
      image.style.objectFit = 'cover';
      return this.createPreview(image, image.alt);
    }
    let preview: MapPreviewImage | undefined;
    try {
      preview = map.decodePreviewImage();
    } catch (error) {
      console.error('Failed to decode map preview data', error);
    }
    if (preview) {
      const { data, width, height } = preview;
      let canvas = CanvasUtils.canvasFromRgbImageData(data, width, height);
      let scale = 1;
      const previewScale = canvas.width < bounds.width / 2 || canvas.height < bounds.height / 2 ? 4 : 2;
      const scaledCanvas = document.createElement('canvas');
      ((scaledCanvas.width = previewScale * canvas.width), (scaledCanvas.height = previewScale * canvas.height));
      const context = scaledCanvas.getContext('2d');
      (context && ((scale = previewScale), context.scale(scale, scale), context.drawImage(canvas, 0, 0), (canvas = scaledCanvas)),
        this.drawStartLocations(canvas, map, bounds, scale));
      canvas.style.objectFit = 'contain';
      return this.createPreview(canvas, this.strings.get(tooltipByLobbyType.get(lobbyType)));
    }
  }

  private createPreview(element: HTMLElement, tooltip: string): UiObject {
    const container = new HtmlContainer();
    const uiObject = new UiObject(new THREE.Object3D(), container);
    container.setSize('100%', '100%');
    container.render();
    element.style.display = 'block';
    element.style.width = '100%';
    element.style.height = '100%';
    element.setAttribute('data-r-tooltip', tooltip);
    container.getElement()!.appendChild(element);
    return uiObject;
  }

  drawStartLocations(canvas: HTMLCanvasElement, map: MapPreviewMap, bounds: MapPreviewSize, scale: number): void {
    const context = canvas.getContext('2d');
    if (context) {
      IsoCoords.init({
        x: 0,
        y: (map.fullSize.width * Coords.getWorldTileSize()) / 2,
      });
      const origin = IsoCoords.worldToScreen(0, 0);
      const originTile = IsoCoords.screenToScreenTile(origin.x, origin.y);
      const unitScale = canvas.width > canvas.height ? canvas.width / bounds.width / scale : canvas.height / bounds.height / scale;
      const fontSize = 13 * unitScale;
      const outlineWidth = 2 * unitScale;
      for (const [index, location] of map.startingLocations.entries()) {
        const locationScreen = IsoCoords.tileToScreen(location.x, location.y);
        const locationTile = IsoCoords.screenToScreenTile(locationScreen.x, locationScreen.y);
        ((locationTile.x += originTile.x), (locationTile.y += originTile.y));
        const point = this.dxyToCanvas(locationTile.x, locationTile.y, canvas, map.localSize);
        ((point.x /= scale),
          (point.y /= scale),
          CanvasUtils.drawText(context, String(index + 1), point.x - fontSize / 4, point.y - fontSize / 2, {
            fontSize,
            color: 'yellow',
            outlineColor: 'black',
            outlineWidth,
          }));
      }
    }
  }

  dxyToCanvas(x: number, y: number, canvas: Pick<HTMLCanvasElement, 'width' | 'height'>, localSize: MapPreviewRect): Point2 {
    const scaleX = canvas.width / (2 * localSize.width);
    const scaleY = canvas.height / localSize.height / 2;
    return {
      x: (x - 2 * localSize.x) * scaleX,
      y: (y - 2 * localSize.y) * scaleY,
    };
  }
}
__export_MapPreviewRenderer = r;
export { __export_MapPreviewRenderer as MapPreviewRenderer };
