import { sb } from '../core/supabase.js';
import { $ , toast } from '../core/utils.js';
import { t, initLangToggle } from '../core/i18n.js';
import { friendlyError } from '../core/errors.js';

initLangToggle();
let ready = false;

function showForm() {
  ready = true;
  $('resetStatus').classList.add('hidden');
  $('resetForm').classList.remove('hidden');
}

// Le lien de récupération crée une session temporaire (événement PASSWORD_RECOVERY).
sb.auth.onAuthStateChange(event => { if (event === 'PASSWORD_RECOVERY') showForm(); });
setTimeout(async () => {
  if (ready) return;
  const { data } = await sb.auth.getSession();
  if (data.session) showForm(); else $('resetStatus').textContent = t('reset.invalid');
}, 1500);

$('resetForm').addEventListener('submit', async event => {
  event.preventDefault();
  const a = $('newPassword').value, b = $('newPassword2').value;
  const msg = $('resetMessage');
  if (a.length < 8) { msg.textContent = t('err.passwordShort'); return; }
  if (a !== b) { msg.textContent = t('reset.mismatch'); return; }
  $('resetSubmit').disabled = true;
  try {
    const { error } = await sb.auth.updateUser({ password: a });
    if (error) throw error;
    toast(t('reset.done'), 'success');
    setTimeout(() => location.replace('/dashboard'), 1200);
  } catch (error) {
    msg.textContent = friendlyError(error);
    $('resetSubmit').disabled = false;
  }
});
