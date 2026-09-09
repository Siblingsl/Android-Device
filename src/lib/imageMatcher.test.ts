import { describe, expect, it } from "vitest";
import { findPixelImageMatch, type PixelImage } from "./imageMatcher";

function image(width: number, height: number, fill: number): PixelImage {
  return { width, height, data: new Uint8ClampedArray(width * height * 4).fill(fill) };
}

describe("image matcher", () => {
  it("finds an exact small template inside a larger image", () => {
    const source = image(6, 6, 0);
    const template = image(2, 2, 255);
    for (const [x, y] of [[3, 2], [4, 2], [3, 3], [4, 3]]) {
      const index = (y * source.width + x) * 4;
      source.data[index] = 255;
      source.data[index + 1] = 255;
      source.data[index + 2] = 255;
      source.data[index + 3] = 255;
    }

    const result = findPixelImageMatch(source, template, 0.99);

    expect(result.matched).toBe(true);
    expect(result.x).toBe(4);
    expect(result.y).toBe(3);
  });

  it("rejects a template larger than the screenshot", () => {
    expect(findPixelImageMatch(image(2, 2, 0), image(3, 3, 0), 0.8)).toEqual({ matched: false, score: 0 });
  });
});
