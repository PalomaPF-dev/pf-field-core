/**
 * 実機計測用のテスト画像をブラウザ内で作る。
 *
 * 現場写真を持ち出さずに、圧縮の挙動と所要時間を確認できるようにするのが目的。
 * EXIF Orientation を後付けするので、向きの焼き込みも実機で確認できる。
 *
 * ライブラリ側のテストヘルパとは別実装にしてある（同じ実装を裏返しただけの
 * 確認にならないよう、パーサと writer の作りを分けている）。
 */

/** Orientation だけを持つ APP1(Exif) セグメントを組む */
function buildExifApp1(orientation: number): Uint8Array {
  // TIFF: ヘッダ8 + IFD0(count2 + entry12 + next4) = 26
  const tiff = new Uint8Array(26);
  const view = new DataView(tiff.buffer);
  view.setUint16(0, 0x4949); // "II" リトルエンディアン
  view.setUint16(2, 0x002a, true);
  view.setUint32(4, 8, true); // IFD0 のオフセット
  view.setUint16(8, 1, true); // エントリ数
  view.setUint16(10, 0x0112, true); // Orientation
  view.setUint16(12, 3, true); // SHORT
  view.setUint32(14, 1, true); // count
  view.setUint16(18, orientation, true);
  view.setUint32(22, 0, true); // 次の IFD なし

  const exifHeader = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif\0\0"
  const length = 2 + exifHeader.length + tiff.length;

  const out = new Uint8Array(4 + exifHeader.length + tiff.length);
  out[0] = 0xff;
  out[1] = 0xe1;
  out[2] = (length >> 8) & 0xff;
  out[3] = length & 0xff;
  out.set(exifHeader, 4);
  out.set(tiff, 4 + exifHeader.length);
  return out;
}

/** JPEG の SOI 直後に APP1 を差し込む */
async function injectExif(jpeg: Blob, orientation: number): Promise<Blob> {
  const bytes = new Uint8Array(await jpeg.arrayBuffer());
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return jpeg; // JPEG でなければ何もしない
  const app1 = buildExifApp1(orientation);

  const out = new Uint8Array(bytes.length + app1.length);
  out.set(bytes.subarray(0, 2), 0); // SOI
  out.set(app1, 2);
  out.set(bytes.subarray(2), 2 + app1.length);
  return new Blob([out], { type: "image/jpeg" });
}

/**
 * 写真らしい絵を描く。
 *
 * 単色やグラデーションだと JPEG が異常に小さくなり、圧縮の挙動が実写と乖離する。
 * 細かい模様と文字を入れて、実際の現場写真に近い情報量にしてある。
 */
function drawSyntheticPhoto(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  label: string,
): void {
  const gradient = context.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, "#2b4a6f");
  gradient.addColorStop(1, "#8a5a2b");
  context.fillStyle = gradient;
  context.fillRect(0, 0, width, height);

  // 高周波成分（これが無いと JPEG が縮みすぎて実写と挙動が変わる）
  const cell = Math.max(4, Math.round(Math.min(width, height) / 160));
  for (let y = 0; y < height; y += cell) {
    for (let x = 0; x < width; x += cell) {
      const v = (x * 7919 + y * 6271) % 255;
      context.fillStyle = `rgb(${v},${(v * 3) % 255},${(v * 7) % 255})`;
      context.globalAlpha = 0.35;
      context.fillRect(x, y, cell, cell);
    }
  }
  context.globalAlpha = 1;

  // 向きが分かる目印。左上に赤い四角、上辺に矢印
  context.fillStyle = "#e02020";
  context.fillRect(0, 0, Math.round(width * 0.12), Math.round(height * 0.12));
  context.strokeStyle = "#ffffff";
  context.lineWidth = Math.max(3, Math.round(height / 120));
  context.beginPath();
  context.moveTo(width * 0.2, height * 0.1);
  context.lineTo(width * 0.8, height * 0.1);
  context.lineTo(width * 0.72, height * 0.05);
  context.stroke();

  context.fillStyle = "#ffffff";
  context.font = `${Math.round(height / 12)}px system-ui, sans-serif`;
  context.textBaseline = "top";
  context.fillText(label, Math.round(width * 0.15), Math.round(height * 0.15));
}

export interface SyntheticPhoto {
  name: string;
  blob: Blob;
  /** 埋め込んだ EXIF Orientation */
  orientation: number;
  width: number;
  height: number;
}

/**
 * 実機計測用の写真を1枚作る。
 * @param orientation 埋め込む EXIF Orientation（1 なら埋め込まない）
 */
export async function createSyntheticPhoto(
  width: number,
  height: number,
  orientation: number,
): Promise<SyntheticPhoto> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("canvas 2d コンテキストを取得できません");

  drawSyntheticPhoto(context, width, height, `${width}x${height} / o=${orientation}`);

  const base = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("テスト画像の生成に失敗しました"))),
      "image/jpeg",
      0.92,
    );
  });

  const blob = orientation === 1 ? base : await injectExif(base, orientation);
  return { name: `${width}x${height}-o${orientation}.jpg`, blob, orientation, width, height };
}

/**
 * 実機計測の標準セット。
 * 4000x3000 は Zebra 端末のカメラでよくある解像度に合わせてある。
 */
export async function createStandardSet(): Promise<SyntheticPhoto[]> {
  const specs: [number, number, number][] = [
    [4000, 3000, 1],
    [4000, 3000, 6],
    [3000, 4000, 8],
    [4000, 3000, 3],
    [1600, 1200, 1],
    [800, 600, 1],
  ];
  const out: SyntheticPhoto[] = [];
  for (const [w, h, orientation] of specs) {
    out.push(await createSyntheticPhoto(w, h, orientation));
  }
  return out;
}
