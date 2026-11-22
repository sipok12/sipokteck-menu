import { $, esc, withBusy, toast } from '../core/utils.js';
import { t, pick } from '../core/i18n.js';
import { friendlyError } from '../core/errors.js';
import { openModal, confirmDialog } from '../core/modal.js';
import { listCategories, addCategory, updateCategory, deleteCategory, reorderCategories } from '../services/catalog.service.js';

export async function mountCategories(ctx, el) {
  const rid = ctx.restaurant.id;
  let cats = [];

  const run = async (task, okKey) => {
    try { await task(); if (okKey) toast(t(okKey), 'success'); cats = await listCategories(rid); render(); }
    catch (error) { toast(friendlyError(error), 'error'); }
  };

  function render() {
    const manage = ctx.canManage;
    el.innerHTML = `${manage ? `<section class="panel"><h2>${esc(t('cat.add'))}</h2>
      <form id="catForm" class="form-grid" novalidate>
        <label class="field">${esc(t('cat.nameFr'))}<input id="catName" required maxlength="80"></label>
        <label class="field">${esc(t('cat.nameEn'))}<input id="catNameEn" maxlength="80"></label>
        <div class="full"><button class="btn" type="submit">${esc(t('common.add'))}</button></div></form></section>` : ''}
      <section class="panel"><h2>${esc(t('cat.list'))} <span class="pill">${cats.length}</span></h2>
      ${cats.length ? cats.map((c, i) => `<div class="row"><div class="meta"><strong>${esc(pick(c, 'name'))}</strong>
        <small>${esc(c.name_en && c.name_en !== c.name ? `${c.name} / ${c.name_en}` : c.name)}</small></div>
        <div class="actions"><span class="pill ${c.is_active ? 'ok' : 'grey'}">${esc(t(c.is_active ? 'common.visible' : 'common.hidden'))}</span>
        ${manage ? `<button type="button" class="outline sm" data-up="${esc(c.id)}" ${i === 0 ? 'disabled' : ''} aria-label="${esc(t('common.up'))}">↑</button>
        <button type="button" class="outline sm" data-down="${esc(c.id)}" ${i === cats.length - 1 ? 'disabled' : ''} aria-label="${esc(t('common.down'))}">↓</button>
        <button type="button" class="outline sm" data-toggle="${esc(c.id)}">${esc(t(c.is_active ? 'common.hide' : 'common.show'))}</button>
        <button type="button" class="outline sm" data-edit="${esc(c.id)}">${esc(t('common.edit'))}</button>
        <button type="button" class="outline sm" data-del="${esc(c.id)}">${esc(t('common.delete'))}</button>` : ''}</div></div>`).join('')
        : `<p class="empty">${esc(t('cat.empty'))}</p>`}</section>`;
  }

  function editModal(c) {
    openModal(`<h2>${esc(t('cat.edit'))}</h2><form class="stack" id="catEditForm" novalidate>
      <label class="field">${esc(t('cat.nameFr'))}<input id="ceName" required maxlength="80" value="${esc(c.name)}"></label>
      <label class="field">${esc(t('cat.nameEn'))}<input id="ceNameEn" maxlength="80" value="${esc(c.name_en || '')}"></label>
      <button class="btn" type="submit">${esc(t('common.save'))}</button></form>`, {
      onMount: (wrap, close) => wrap.querySelector('#catEditForm').addEventListener('submit', async e => {
        e.preventDefault();
        const name = wrap.querySelector('#ceName').value.trim();
        if (!name) return;
        await run(() => updateCategory(c.id, { name, name_en: wrap.querySelector('#ceNameEn').value.trim() || null }), 'common.saved');
        close();
      })
    });
  }

  async function move(id, delta) {
    const ids = cats.map(c => c.id), i = ids.indexOf(id), j = i + delta;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    await run(() => reorderCategories(ids));
  }

  el.addEventListener('submit', async e => {
    if (e.target.id !== 'catForm') return;
    e.preventDefault();
    const name = $('catName', el).value.trim();
    if (!name) return;
    await withBusy(e.submitter, () => run(() => addCategory(rid, { name, name_en: $('catNameEn', el).value.trim() }, cats.length), 'cat.added'));
  });
  el.addEventListener('click', async e => {
    const b = e.target.closest('button'); if (!b) return;
    const id = b.dataset.up || b.dataset.down || b.dataset.toggle || b.dataset.edit || b.dataset.del;
    const c = cats.find(x => x.id === id);
    if (b.dataset.up) move(id, -1);
    else if (b.dataset.down) move(id, 1);
    else if (b.dataset.toggle) run(() => updateCategory(id, { is_active: !c.is_active }));
    else if (b.dataset.edit) editModal(c);
    else if (b.dataset.del && await confirmDialog(esc(t('cat.confirmDelete', { name: c.name })), t('common.delete'), t('common.cancel'))) run(() => deleteCategory(id), 'common.deleted');
  });

  try { cats = await listCategories(rid); render(); } catch (error) { el.innerHTML = `<p class="notice">${esc(friendlyError(error))}</p>`; }
}
