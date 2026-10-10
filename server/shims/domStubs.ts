// Minimal DOMMatrix / ImageData / Path2D for pdf.js in node. pdf.js's legacy
// build constructs a DOMMatrix at module load and, without these, tries the
// optional native "@napi-rs/canvas" — absent on the box — and then crashes
// ("DOMMatrix is not defined"). Text extraction (getDocument → getTextContent,
// what tools.ts uses) never renders, so geometry-only stubs are enough;
// canvas rendering of a page is not supported headless.
const g = globalThis as any;

class DOMMatrixStub {
  a = 1; b = 0; c = 0; d = 1; e = 0; f = 0;
  constructor(init?: number[] | ArrayLike<number>) {
    if (init && init.length >= 6) {
      [this.a, this.b, this.c, this.d, this.e, this.f] = Array.from(init).slice(0, 6) as number[];
    }
  }
  get is2D(): boolean {
    return true;
  }
  get isIdentity(): boolean {
    return this.a === 1 && this.b === 0 && this.c === 0 && this.d === 1 && this.e === 0 && this.f === 0;
  }
  multiplySelf(m: DOMMatrixStub): this {
    const { a, b, c, d, e, f } = this;
    this.a = a * m.a + c * m.b;
    this.b = b * m.a + d * m.b;
    this.c = a * m.c + c * m.d;
    this.d = b * m.c + d * m.d;
    this.e = a * m.e + c * m.f + e;
    this.f = b * m.e + d * m.f + f;
    return this;
  }
  multiply(m: DOMMatrixStub): DOMMatrixStub {
    return new DOMMatrixStub([this.a, this.b, this.c, this.d, this.e, this.f]).multiplySelf(m);
  }
  preMultiplySelf(m: DOMMatrixStub): this {
    const r = new DOMMatrixStub([m.a, m.b, m.c, m.d, m.e, m.f]).multiplySelf(this);
    Object.assign(this, { a: r.a, b: r.b, c: r.c, d: r.d, e: r.e, f: r.f });
    return this;
  }
  translateSelf(tx = 0, ty = 0): this {
    return this.multiplySelf(new DOMMatrixStub([1, 0, 0, 1, tx, ty]));
  }
  translate(tx = 0, ty = 0): DOMMatrixStub {
    return this.multiply(new DOMMatrixStub([1, 0, 0, 1, tx, ty]));
  }
  scaleSelf(sx = 1, sy = sx): this {
    return this.multiplySelf(new DOMMatrixStub([sx, 0, 0, sy, 0, 0]));
  }
  scale(sx = 1, sy = sx): DOMMatrixStub {
    return this.multiply(new DOMMatrixStub([sx, 0, 0, sy, 0, 0]));
  }
  invertSelf(): this {
    const { a, b, c, d, e, f } = this;
    const det = a * d - b * c;
    if (!det) {
      Object.assign(this, { a: NaN, b: NaN, c: NaN, d: NaN, e: NaN, f: NaN });
      return this;
    }
    Object.assign(this, { a: d / det, b: -b / det, c: -c / det, d: a / det, e: (c * f - d * e) / det, f: (b * e - a * f) / det });
    return this;
  }
  inverse(): DOMMatrixStub {
    return new DOMMatrixStub([this.a, this.b, this.c, this.d, this.e, this.f]).invertSelf();
  }
  transformPoint(p: { x?: number; y?: number } = {}): { x: number; y: number; z: number; w: number } {
    const x = p.x ?? 0;
    const y = p.y ?? 0;
    return { x: this.a * x + this.c * y + this.e, y: this.b * x + this.d * y + this.f, z: 0, w: 1 };
  }
}

class ImageDataStub {
  data: Uint8ClampedArray;
  constructor(
    public width: number,
    public height: number,
  ) {
    this.data = new Uint8ClampedArray(Math.max(0, width * height * 4));
  }
}

class Path2DStub {
  addPath(): void {}
  moveTo(): void {}
  lineTo(): void {}
  bezierCurveTo(): void {}
  quadraticCurveTo(): void {}
  rect(): void {}
  closePath(): void {}
}

g.DOMMatrix ??= DOMMatrixStub;
g.ImageData ??= ImageDataStub;
g.Path2D ??= Path2DStub;
