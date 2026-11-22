import { sb } from '../core/supabase.js';
import { uuid } from '../core/utils.js';

const LIMITS = { 'restaurant-logos': 2, 'restaurant-covers': 5, 'product-images': 5, 'payment-proofs': 5 };
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };

function validate(bucket, file) {
  const allowed = bucket === 'payment-proofs' ? [...IMAGE_TYPES, 'application/pdf'] : IMAGE_TYPES;
  if (!allowed.includes(file.type)) throw new Error('file type not allowed');
  if (file.size > LIMITS[bucket] * 1024 * 1024) throw new Error('file too large');
}

/** Réduit une image (mobile / connexions lentes) avant envoi. Retourne le fichier d'origine en cas d'échec. */
export async function shrinkImage(file, maxSide = 1280, quality = 0.82) {
  if (!IMAGE_TYPES.includes(file.type)) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const ratio = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * ratio); canvas.height = Math.round(bitmap.height * ratio);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', quality));
    return blob && blob.size < file.size ? new File([blob], 'image.webp', { type: 'image/webp' }) : file;
  } catch { return file; }
}

/** Image publique (logo, couverture, produit). Chemin imposé : <restaurant_id>/<uuid>.<ext>. */
export async function uploadPublicImage(bucket, restaurantId, file) {
  const prepared = await shrinkImage(file, bucket === 'restaurant-logos' ? 512 : 1280);
  validate(bucket, prepared);
  const path = `${restaurantId}/${uuid()}.${EXT[prepared.type]}`;
  const { error } = await sb.storage.from(bucket).upload(path, prepared, { contentType: prepared.type, cacheControl: '31536000', upsert: false });
  if (error) throw error;
  return sb.storage.from(bucket).getPublicUrl(path).data.publicUrl;
}

/** Fichier privé (justificatif de paiement). Retourne le chemin, jamais une URL publique. */
export async function uploadPrivate(bucket, restaurantId, file) {
  const prepared = await shrinkImage(file, 1600);
  validate(bucket, prepared);
  const path = `${restaurantId}/${uuid()}.${EXT[prepared.type]}`;
  const { error } = await sb.storage.from(bucket).upload(path, prepared, { contentType: prepared.type, upsert: false });
  if (error) throw error;
  return path;
}

/** Lien temporaire (10 min) vers un justificatif — réservé à l'admin / au restaurant concerné par les policies. */
export async function signedProofUrl(path) {
  const { data, error } = await sb.storage.from('payment-proofs').createSignedUrl(path, 600);
  if (error) throw error;
  return data.signedUrl;
}
