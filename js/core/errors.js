import { t } from './i18n.js';

// Messages techniques (SQL / Auth / Storage) -> clés de traduction. Jamais d'erreur brute affichée.
const RULES = [
  [/PLAN_LIMIT_PRODUCTS:(\d+)/, m => t('err.limitProducts', { n: m[1] })],
  [/PLAN_LIMIT_CATEGORIES:(\d+)/, m => t('err.limitCategories', { n: m[1] })],
  [/Too many orders/i, () => t('err.tooManyOrders')],
  [/Restaurant not found/i, () => t('err.restaurantNotFound')],
  [/unavailable/i, () => t('err.productsUnavailable')],
  [/Invalid customer phone/i, () => t('err.phone')],
  [/Customer name must/i, () => t('err.customerName')],
  [/Delivery address must/i, () => t('err.deliveryAddress')],
  [/Invalid login credentials/i, () => t('err.invalidLogin')],
  [/Email not confirmed/i, () => t('err.emailNotConfirmed')],
  [/already registered|already been registered/i, () => t('err.alreadyRegistered')],
  [/Password should be at least/i, () => t('err.passwordShort')],
  [/WhatsApp number must/i, () => t('err.whatsapp')],
  [/payment is already waiting/i, () => t('err.paymentPending')],
  [/Online payment is not configured|Could not start the payment/i, () => t('err.onlineUnavailable')],
  [/Invalid or expired link/i, () => t('err.linkInvalid')],
  [/Too many messages/i, () => t('err.tooManyMessages')],
  [/Messaging is closed/i, () => t('err.chatClosed')],
  [/Invalid message/i, () => t('err.invalidMessage')],
  [/transaction reference or a proof/i, () => t('err.proofRequired')],
  [/Maximum number of restaurants/i, () => t('err.maxRestaurants')],
  [/web address cannot be changed/i, () => t('err.slugLocked')],
  [/closed order cannot be reopened/i, () => t('err.orderClosed')],
  [/Image URL must use https|must use https/i, () => t('err.https')],
  [/does not belong to this restaurant/i, () => t('err.categoryMismatch')],
  [/suspended/i, () => t('err.suspended')],
  [/rate limit|too many requests/i, () => t('err.rateLimit')],
  [/Failed to fetch|NetworkError|Load failed/i, () => t('err.network')],
  [/mime type|not allowed|file type/i, () => t('err.fileType')],
  [/exceeded the maximum allowed size|too large|payload too large/i, () => t('err.fileSize')]
];

export function friendlyError(error) {
  const message = String(error?.message || error || '');
  const code = error?.code || error?.statusCode;
  if (code === '23505' || /duplicate key/i.test(message)) return t('err.duplicate');
  if (code === '42501' || /permission denied|row-level security/i.test(message)) return t('err.denied');
  for (const [pattern, build] of RULES) {
    const match = message.match(pattern);
    if (match) return build(match);
  }
  return t('err.generic');
}
