import { convertFileSrc } from "@tauri-apps/api/core";

export interface PixelImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export interface ImageMatchResult {
  matched: boolean;
  x?: number;
  y?: number;
  score: number;
}

function scoreAt(source: PixelImage, template: PixelImage, offsetX: number, offsetY: number): number {
  const sampleX = Math.max(1, Math.floor(template.width / 24));
  const sampleY = Math.max(1, Math.floor(template.height / 24));
  let total = 0;
  let count = 0;
  for (let y = 0; y < template.height; y += sampleY) {
    for (let x = 0; x < template.width; x += sampleX) {
      const sourceIndex = ((offsetY + y) * source.width + offsetX + x) * 4;
      const templateIndex = (y * template.width + x) * 4;
      total += Math.abs(source.data[sourceIndex] - template.data[templateIndex]);
      total += Math.abs(source.data[sourceIndex + 1] - template.data[templateIndex + 1]);
      total += Math.abs(source.data[sourceIndex + 2] - template.data[templateIndex + 2]);
      count += 3;
    }
  }
  return count === 0 ? 0 : 1 - total / (count * 255);
}

export function findPixelImageMatch(source: PixelImage, template: PixelImage, threshold: number): ImageMatchResult {
  if (template.width <= 0 || template.height <= 0 || template.width > source.width || template.height > source.height) {
    return { matched: false, score: 0 };
  }
  const required = Math.min(1, Math.max(0, threshold));
  const stride = Math.max(1, Math.floor(Math.min(source.width, source.height) / 120));
  let best = { score: 0, x: 0, y: 0 };
  for (let y = 0; y <= source.height - template.height; y += stride) {
    for (let x = 0; x <= source.width - template.width; x += stride) {
      const score = scoreAt(source, template, x, y);
      if (score > best.score) best = { score, x, y };
      if (score >= required) {
        return { matched: true, score, x: x + template.width / 2, y: y + template.height / 2 };
      }
    }
  }
  return { matched: false, score: best.score };
}

function readImage(source: string): Promise<PixelImage> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth || image.width;
      canvas.height = image.naturalHeight || image.height;
      const context = canvas.getContext("2d");
      if (!context) {
        reject(new Error("当前环境无法读取图像像素"));
        return;
      }
      try {
        resolve({ width: canvas.width, height: canvas.height, data: context.getImageData(0, 0, canvas.width, canvas.height).data });
      } catch (cause) {
        reject(cause instanceof Error ? cause : new Error(String(cause)));
      }
    };
    image.onerror = () => reject(new Error("图像文件无法读取"));
    image.src = source;
  });
}

async function sourceToDataUrl(pathOrData: string): Promise<string> {
  if (pathOrData.startsWith("data:image/")) return pathOrData;
  const url = (() => {
    try { return convertFileSrc(pathOrData); } catch { return pathOrData; }
  })();
  const response = await fetch(url);
  if (!response.ok) throw new Error(`图像文件读取失败（${response.status}）`);
  const blob = await response.blob();
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("图像文件读取失败"));
    reader.readAsDataURL(blob);
  });
}

export async function matchScreenshotToTemplate(screenshotBase64: string, templatePath: string, threshold: number): Promise<ImageMatchResult> {
  if (!screenshotBase64.trim() || !templatePath.trim()) throw new Error("图像匹配需要截图和模板路径");
  const screenshotSource = screenshotBase64.startsWith("data:image/") ? screenshotBase64 : `data:image/png;base64,${screenshotBase64}`;
  const [source, template] = await Promise.all([readImage(screenshotSource), sourceToDataUrl(templatePath).then(readImage)]);
  return findPixelImageMatch(source, template, threshold);
}
