import { $, esc, money, safeUrl, withBusy, toast, debounce } from '../core/utils.js';
import { t, getLang, pick } from '../core/i18n.js';
import { friendlyError } from '../core/errors.js';
import { openModal, confirmDialog } from '../core/modal.js';
import { listProducts, listCategories, addProduct, updateProduct, setProductAvailable, deleteProduct } from '../services/catalog.service.js';
import { uploadPublicImage } from '../services/storage.service.js';
import { getBilling } from '../services/billing.service.js';

export async function mountProducts(ctx, el) {
  const rid = ctx.restaurant.id;
  let products = [], cats = [], billing = null;
  const filter = { q: '', cat: 'all' };
  const norm = s => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

  async function load() {
    [products, cats, billing] = await Promise.all([listProducts(rid), listCategories(rid), ctx.canManage ? getBilling(rid).catch(() => null) : null]);
    render();
  }
  const run = async (task, okKey) => {
    try { await task(); if (okKey) toast(t(okKey), 'success'); await load(); } catch (error) { toast(friendlyError(error), 'error'); }
  };

  function list() {
    const q = norm(filter.q);
    return products.filter(p => (filter.cat === 'all' || (filter.cat === 'none' ? !p.category_id : p.category_id === filter.cat))
      && norm(`${p.name} ${p.name_en || ''}`).includes(q));
  }

  function rows() {
    const items = list();
    if (!items.length) return `<p class="empty">${esc(t(products.length ? 'prod.noMatch' : 'prod.empty'))}</p>`;
    const catName = id => cats.find(c => c.id === id);
    return items.map(p => {
      const img = safeUrl(p.image_url), c = catName(p.category_id);
      return `<div class="row"><div style="display:flex;gap:12px;align-items:center;min-width:0">
        ${img ? `<img class="thumb" src="${esc(img)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<span class="thumb" aria-hidden="true">🍽️</span>'}
        <div class="meta"><strong>${esc(pick(p, 'name'))}</strong><small>${money(p.price_xof, getLang())}${c ? ` · ${esc(pick(c, 'name'))}` : ''}</small></div></div>
        <div class="actions">${!p.is_active ? `<span class="pill grey">${esc(t('prod.archived'))}</span>` : `<span class="pill ${p.is_available ? 'ok' : 'warn'}">${esc(t(p.is_available ? 'prod.available' : 'prod.unavailable'))}</span>`}
        ${ctx.canManage ? `${p.is_active ? `<button type="button" class="outline sm" data-avail="${esc(p.id)}">${esc(t(p.is_available ? 'prod.markOut' : 'prod.markIn'))}</button>` : ''}
        <button type="button" class="outline sm" data-edit="${esc(p.id)}">${esc(t('common.edit'))}</button>
        <button type="button" class="outline sm" data-del="${esc(p.id)}">${esc(t('common.delete'))}</button>` : ''}</div></div>`;
    }).join('');
  }

  function render() {
    const max = billing?.max_products;
    const full = max != null && products.length >= max;
    el.innerHTML = `<section class="panel"><div class="toolbar">
      <input id="pSearch" type="search" placeholder="${esc(t('common.search'))}" value="${esc(filter.q)}" aria-label="${esc(t('common.search'))}">
      <select id="pCat" aria-label="${esc(t('prod.category'))}"><option value="all">${esc(t('prod.allCats'))}</option><option value="none" ${filter.cat === 'none' ? 'selected' : ''}>${esc(t('prod.noCat'))}</option>
        ${cats.map(c => `<option value="${esc(c.id)}" ${filter.cat === c.id ? 'selected' : ''}>${esc(pick(c, 'name'))}</option>`).join('')}</select>
      ${ctx.canManage ? `<button type="button" class="btn" id="pAdd">+ ${esc(t('prod.add'))}</button>` : ''}</div>
      <p class="muted">${esc(t('prod.count', { n: products.length }))}${max != null ? ` / ${max}` : ''}${full ? ` — ${esc(t('prod.limitReached'))}` : ''}</p>
      <div id="pList">${rows()}</div></section>`;
  }

  function formModal(p) {
    const isEdit = Boolean(p);
    const v = p || { is_available: true };
    openModal(`<h2>${esc(t(isEdit ? 'prod.edit' : 'prod.add'))}</h2><form id="pForm" class="form-grid" novalidate>
      <label class="field">${esc(t('prod.name'))}<input id="fName" required maxlength="120" value="${esc(v.name || '')}"></label>
      <label class="field">${esc(t('prod.nameEn'))}<input id="fNameEn" maxlength="120" value="${esc(v.name_en || '')}"></label>
      <label class="field full">${esc(t('prod.description'))}<textarea id="fDesc" rows="2" maxlength="500">${esc(v.description || '')}</textarea></label>
      <label class="field full">${esc(t('prod.descriptionEn'))}<textarea id="fDescEn" rows="2" maxlength="500">${esc(v.description_en || '')}</textarea></label>
      <label class="field">${esc(t('prod.price'))}<input id="fPrice" type="number" min="1" max="10000000" step="1" required inputmode="numeric" value="${esc(v.price_xof ?? '')}"></label>
      <label class="field">${esc(t('prod.category'))}<select id="fCat"><option value="">${esc(t('prod.noCat'))}</option>${cats.map(c => `<option value="${esc(c.id)}" ${v.category_id === c.id ? 'selected' : ''}>${esc(pick(c, 'name'))}</option>`).join('')}</select></label>
      <label class="field full">${esc(t('prod.image'))}<input id="fFile" type="file" accept="image/jpeg,image/png,image/webp"><small>${esc(t('prod.imageHint'))}</small></label>
      <label class="field full">${esc(t('prod.imageUrl'))}<input id="fUrl" type="url" placeholder="https://" value="${esc(v.image_url || '')}"></label>
      <div class="full"><img id="fPreview" class="preview ${safeUrl(v.image_url) ? '' : 'hidden'}" alt="" src="${esc(safeUrl(v.image_url))}"></div>
      <label class="field full" style="display:flex;gap:8px;align-items:center;flex-direction:row"><input id="fAvail" type="checkbox" style="width:auto" ${v.is_available !== false ? 'checked' : ''}> ${esc(t('prod.available'))}</label>
      <div class="full"><button class="btn lg" type="submit">${esc(t('common.save'))}</button> <span id="fMsg" class="notice" role="alert"></span></div></form>`, {
      size: 'big',
      onMount: (wrap, close) => {
        const q = id => wrap.querySelector('#' + id);
        q('fFile').addEventListener('change', () => {
          const f = q('fFile').files[0];
          if (f) { q('fPreview').src = URL.createObjectURL(f); q('fPreview').classList.remove('hidden'); }
        });
        q('pForm').addEventListener('submit', async e => {
          e.preventDefault();
          const price = Number(q('fPrice').value), name = q('fName').value.trim();
          if (!name) return void (q('fMsg').textContent = t('prod.nameRequired'));
          if (!Number.isInteger(price) || price < 1 || price > 10000000) return void (q('fMsg').textContent = t('prod.priceInvalid'));
          const typed = q('fUrl').value.trim();
          if (typed && !safeUrl(typed)) return void (q('fMsg').textContent = t('err.https'));
          await withBusy(e.submitter, async () => {
            try {
              let image_url = typed || null;
              const file = q('fFile').files[0];
              if (file) image_url = await uploadPublicImage('product-images', rid, file);
              const data = { name, name_en: q('fNameEn').value.trim(), description: q('fDesc').value.trim(), description_en: q('fDescEn').value.trim(),
                price_xof: price, category_id: q('fCat').value, image_url, is_available: q('fAvail').checked };
              if (isEdit) await updateProduct(p.id, data); else await addProduct(rid, data);
              toast(t('common.saved'), 'success'); close(); await load();
            } catch (error) { q('fMsg').textContent = friendlyError(error); }
          });
        });
      }
    });
  }

  el.addEventListener('input', debounce(e => { if (e.target.id === 'pSearch') { filter.q = e.target.value; $('pList', el).innerHTML = rows(); } }, 120));
  el.addEventListener('change', e => { if (e.target.id === 'pCat') { filter.cat = e.target.value; $('pList', el).innerHTML = rows(); } });
  el.addEventListener('click', async e => {
    if (e.target.closest('#pAdd')) return formModal(null);
    const b = e.target.closest('button'); if (!b) return;
    const p = products.find(x => x.id === (b.dataset.avail || b.dataset.edit || b.dataset.del));
    if (!p) return;
    if (b.dataset.avail) run(() => setProductAvailable(p.id, !p.is_available));
    else if (b.dataset.edit) formModal(p);
    else if (b.dataset.del && await confirmDialog(esc(t('prod.confirmDelete', { name: p.name })), t('common.delete'), t('common.cancel'))) {
      try { const result = await deleteProduct(p.id); toast(t(result === 'archived' ? 'prod.archivedNote' : 'common.deleted'), 'success'); await load(); }
      catch (error) { toast(friendlyError(error), 'error'); }
    }
  });

  try { await load(); } catch (error) { el.innerHTML = `<p class="notice">${esc(friendlyError(error))}</p>`; }
}
