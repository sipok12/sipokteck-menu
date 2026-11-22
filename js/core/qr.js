import QRCode from 'qrcode';

/** Dessine le QR code (niveau de correction H) dans `box` et retourne le <canvas>. */
export async function drawQr(box, text, size = 260) {
  box.innerHTML = '';
  const canvas = document.createElement('canvas');
  canvas.setAttribute('role', 'img');
  box.appendChild(canvas);
  await QRCode.toCanvas(canvas, text, { width: size, margin: 1, errorCorrectionLevel: 'H', color: { dark: '#071b32', light: '#ffffff' } });
  return canvas;
}
