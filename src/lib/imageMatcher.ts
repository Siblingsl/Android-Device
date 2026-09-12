function imageSource(value: string) {
  return value.startsWith("data:") ? value : `data:image/png;base64,${value}`;
}

export interface ImageMatchCrop {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function load(source: string): Promise<ImageBitmap> {
  const response = await fetch(imageSource(source));
  const blob = await response.blob();
  return createImageBitmap(blob);
}

/** Lightweight local template matching for automation checkpoints. */
export async function containsTemplate(screen: string, template: string, threshold = 0.18, crop?: ImageMatchCrop): Promise<boolean> {
  if (!screen || !template) return false;
  const [screenImage, templateImage] = await Promise.all([load(screen), load(template)]);
  try {
    const cropX = Math.max(0, Math.round(crop?.x || 0));
    const cropY = Math.max(0, Math.round(crop?.y || 0));
    const targetX = Math.min(cropX, Math.max(0, templateImage.width - 1));
    const targetY = Math.min(cropY, Math.max(0, templateImage.height - 1));
    const targetWidth = Math.min(
      crop?.width ? Math.round(crop.width) : templateImage.width,
      templateImage.width - targetX,
    );
    const targetHeight = Math.min(
      crop?.height ? Math.round(crop.height) : templateImage.height,
      templateImage.height - targetY,
    );
    if (targetWidth <= 0 || targetHeight <= 0 || targetWidth > screenImage.width || targetHeight > screenImage.height) return false;
    const screenCanvas = document.createElement("canvas");
    const templateCanvas = document.createElement("canvas");
    screenCanvas.width = screenImage.width; screenCanvas.height = screenImage.height;
    templateCanvas.width = targetWidth; templateCanvas.height = targetHeight;
    const screenContext = screenCanvas.getContext("2d");
    const templateContext = templateCanvas.getContext("2d");
    if (!screenContext || !templateContext) return false;
    screenContext.drawImage(screenImage, 0, 0);
    templateContext.drawImage(templateImage, targetX, targetY, targetWidth, targetHeight, 0, 0, targetWidth, targetHeight);
    const source = screenContext.getImageData(0, 0, screenImage.width, screenImage.height).data;
    const target = templateContext.getImageData(0, 0, targetWidth, targetHeight).data;
    const step = Math.max(1, Math.floor(Math.min(targetWidth, targetHeight) / 80));
    const limit = Math.max(0.01, Math.min(1, threshold));
    for (let y = 0; y <= screenImage.height - targetHeight; y += step) {
      for (let x = 0; x <= screenImage.width - targetWidth; x += step) {
        let error = 0; let samples = 0;
        for (let ty = 0; ty < targetHeight; ty += step) {
          for (let tx = 0; tx < targetWidth; tx += step) {
            const si = ((y + ty) * screenImage.width + x + tx) * 4;
            const ti = (ty * targetWidth + tx) * 4;
            error += (Math.abs(source[si] - target[ti]) + Math.abs(source[si + 1] - target[ti + 1]) + Math.abs(source[si + 2] - target[ti + 2])) / (255 * 3);
            samples += 1;
          }
        }
        if (samples && error / samples <= limit) return true;
      }
    }
    return false;
  } finally {
    screenImage.close();
    templateImage.close();
  }
}
