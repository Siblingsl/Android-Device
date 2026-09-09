import jsQR from "jsqr";

export function decodeQrImageData(data: Uint8ClampedArray, width: number, height: number): string | null {
  const result = jsQR(data, width, height, { inversionAttempts: "attemptBoth" });
  const payload = result?.data?.trim();
  return payload || null;
}

export function decodeQrVideoFrame(video: HTMLVideoElement, canvas: HTMLCanvasElement): string | null {
  if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || video.videoWidth <= 0 || video.videoHeight <= 0) {
    return null;
  }
  const width = video.videoWidth;
  const height = video.videoHeight;
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(video, 0, 0, width, height);
  return decodeQrImageData(context.getImageData(0, 0, width, height).data, width, height);
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Unable to load QR image"));
    image.src = url;
  });
}

export async function decodeQrImageFile(file: File): Promise<string | null> {
  if (!file.type.startsWith("image/")) return null;
  const url = URL.createObjectURL(file);
  try {
    const image = await loadImage(url);
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth || image.width;
    canvas.height = image.naturalHeight || image.height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context || canvas.width <= 0 || canvas.height <= 0) return null;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return decodeQrImageData(context.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
  } finally {
    URL.revokeObjectURL(url);
  }
}
