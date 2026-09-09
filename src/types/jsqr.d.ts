declare module "jsqr" {
  export interface QRCodeData {
    data: string;
  }

  export interface QRCodeOptions {
    inversionAttempts?: "dontInvert" | "onlyInvert" | "attemptBoth" | "invertFirst";
  }

  export default function jsQR(
    data: Uint8ClampedArray,
    width: number,
    height: number,
    options?: QRCodeOptions,
  ): QRCodeData | null;
}
