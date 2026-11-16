// On-device receipt OCR with Tesseract (Japanese + English). Everything is served by Tabi itself,
// so it works without third-party services and, once loaded, offline.
let workerPromise = null;
let progressCb = null;

async function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      const Tesseract = (await import('/vendor/tesseract/tesseract.esm.min.js')).default;
      return Tesseract.createWorker(['jpn', 'eng'], 1 /* LSTM only */, {
        workerPath: '/vendor/tesseract/worker.min.js',
        corePath: '/vendor/tesseract-core',
        langPath: '/vendor/tessdata',
        gzip: true,
        logger: (m) => progressCb?.(m),
      });
    })().catch((e) => { workerPromise = null; throw e; });
  }
  return workerPromise;
}

// Grayscale, upscale small images, boost contrast: Tesseract reads thermal receipts much better.
async function prepare(blob) {
  const bmp = await createImageBitmap(blob);
  const target = 1800;
  const scale = Math.min(2.5, target / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale), h = Math.round(bmp.height * scale);
  const c = Object.assign(document.createElement('canvas'), { width: w, height: h });
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    let g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    g = Math.max(0, Math.min(255, (g - 128) * 1.35 + 140));
    d[i] = d[i + 1] = d[i + 2] = g;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

export async function readReceipt(blob, onProgress) {
  progressCb = (m) => {
    const label = m.status === 'recognizing text' ? 'Reading the receipt'
      : /load|download|initializ/i.test(m.status) ? 'Loading the text reader (first time only)' : 'Preparing';
    onProgress?.(label, m.progress || 0);
  };
  const worker = await getWorker();
  const canvas = await prepare(blob);
  const { data } = await worker.recognize(canvas);
  // Tesseract puts spaces between Japanese characters; remove them between CJK runs.
  return data.text.replace(/(?<=[぀-ヿ㐀-鿿])[ \t]+(?=[぀-ヿ㐀-鿿])/g, '');
}
