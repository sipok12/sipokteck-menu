import { callFunction } from './functions.js';

const call = body => callFunction('fedapay-orders', body);

// Client sans compte : identifié par le jeton du lien de suivi. Le montant n'est jamais envoyé : le serveur relit le total de la commande.
export const startOrderPayment = token => call({ action: 'checkout', token });
export const verifyOrderPayment = token => call({ action: 'verify', token });

// Restaurateur (owner/admin) : la clé FedaPay est chiffrée côté serveur et n'est jamais renvoyée.
export const getPaymentSettings = restaurantId => call({ action: 'settings_status', restaurant_id: restaurantId });
export const savePaymentSettings = (restaurantId, { env, secretKey, webhookSecret }) =>
  call({ action: 'settings_save', restaurant_id: restaurantId, env, secret_key: secretKey, webhook_secret: webhookSecret });
export const disablePaymentSettings = restaurantId => call({ action: 'settings_disable', restaurant_id: restaurantId });
