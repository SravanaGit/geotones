type Card = {
  title: string;
  artist: string;
  place: string | null;
  edition: number;
  maxClaims: number | null;
  coverUrl: string | null;
};

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('cover failed'));
    image.src = url;
  });
}

function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let cut = text;
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > maxWidth) cut = cut.slice(0, -1);
  return `${cut}…`;
}

// Draws a 1080 × 1350 image for social posts.
export async function shareCard(card: Card): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = 1080;
  canvas.height = 1350;
  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createLinearGradient(0, 0, 0, 1350);
  gradient.addColorStop(0, '#2a1a12');
  gradient.addColorStop(1, '#111');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 1080, 1350);

  const art = { x: 120, y: 120, size: 840 };
  try {
    if (!card.coverUrl) throw new Error('no cover');
    const image = await loadImage(card.coverUrl);
    const side = Math.min(image.width, image.height);
    ctx.drawImage(image, (image.width - side) / 2, (image.height - side) / 2, side, side, art.x, art.y, art.size, art.size);
  } catch {
    ctx.fillStyle = '#d9480f';
    ctx.fillRect(art.x, art.y, art.size, art.size);
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.font = '700 300px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('♪', 540, 650);
  }

  ctx.textAlign = 'left';
  ctx.fillStyle = '#fff';
  ctx.font = '700 64px system-ui, sans-serif';
  ctx.fillText(fitText(ctx, card.title, 840), 120, 1060);
  ctx.fillStyle = '#d6cfc6';
  ctx.font = '400 44px system-ui, sans-serif';
  ctx.fillText(fitText(ctx, card.artist, 840), 120, 1122);
  ctx.fillStyle = '#fb7a3c';
  ctx.font = '600 40px system-ui, sans-serif';
  const edition = card.edition === 1 ? 'First finder' : card.maxClaims ? `Copy ${card.edition} of ${card.maxClaims}` : `Finder #${card.edition}`;
  const where = card.place ? `Found in ${card.place}` : 'Found on the map';
  ctx.fillText(fitText(ctx, where, 840), 120, 1190);
  ctx.fillText(fitText(ctx, edition, 840), 120, 1242);
  ctx.fillStyle = '#8a8178';
  ctx.font = '600 34px system-ui, sans-serif';
  ctx.fillText('GEOTONES', 120, 1300);

  return new Promise((resolve, reject) => canvas.toBlob(
    (blob) => (blob ? resolve(blob) : reject(new Error('Couldn’t make the image.'))), 'image/png',
  ));
}

// Opens the phone's share sheet, or downloads the image where sharing files isn't supported.
export async function shareImage(blob: Blob, title: string) {
  const file = new File([blob], 'geotones.png', { type: 'image/png' });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title });
    } catch (e) {
      if ((e as Error).name !== 'AbortError') throw e;
    }
    return;
  }
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'geotones.png';
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 10000);
}
