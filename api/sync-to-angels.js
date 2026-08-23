// ============================================================
// api/sync-to-angels.js
// 1) Copia productos/facturas/pedidos/movimientos de Cotillón a
//    tablas espejo en el CRM de Angels (cotillon_*), para tener
//    todo visible ahí también.
// 2) Además, por cada factura NUEVA de Cotillón, crea un PEDIDO
//    de verdad en la tabla `pedidos` real del CRM de Angels,
//    integrado con tus pedidos de siempre (mismo cliente,
//    mismo formato de items_detalle, numeración correlativa).
//
// Variables de entorno necesarias en Vercel:
//   COTILLON_SUPABASE_URL, COTILLON_SERVICE_KEY
//   ANGELS_SUPABASE_URL, ANGELS_SERVICE_KEY
// ============================================================

import { createClient } from '@supabase/supabase-js';

const COTILLON_CLIENTE_ID = "9fb57dfa-8242-4f34-a82d-10bf747c0fb1"; // "Cotillón Arco Iris" en tabla clientes

export default async function handler(req, res) {
  const auth = req.headers['authorization'];
  if (process.env.CRON_SECRET && auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const source = createClient(process.env.COTILLON_SUPABASE_URL, process.env.COTILLON_SERVICE_KEY);
  const target = createClient(process.env.ANGELS_SUPABASE_URL, process.env.ANGELS_SERVICE_KEY);

  const results = {};

  // --- 1) Sincronización espejo (visibilidad general) ---
  async function syncMirror(sourceTable, targetTable, limit) {
    let query = source.from(sourceTable).select('*');
    if (limit) query = query.order('created_at', { ascending: false }).limit(limit);
    const { data, error: readErr } = await query;
    if (readErr) { results[sourceTable] = `error leyendo: ${readErr.message}`; return; }
    if (!data || data.length === 0) { results[sourceTable] = '0 registros'; return; }
    const { error: writeErr } = await target.from(targetTable).upsert(data, { onConflict: 'id' });
    results[sourceTable] = writeErr ? `error escribiendo: ${writeErr.message}` : `${data.length} sincronizados`;
  }

  try {
    await syncMirror('products', 'cotillon_products');
    await syncMirror('invoices', 'cotillon_invoices');
    await syncMirror('pedidos', 'cotillon_pedidos');
    await syncMirror('movements', 'cotillon_movements', 500);
  } catch (err) {
    results.mirror_error = String(err);
  }

  // --- 2) Reflejar productos de Cotillón en el Catálogo del CRM (sin pisar lo cargado a mano) ---
  try {
    const { data: cotillonProducts, error: prodErr } = await source.from('products').select('*');
    if (prodErr) {
      results.catalogo = `error leyendo productos: ${prodErr.message}`;
    } else if (!cotillonProducts || cotillonProducts.length === 0) {
      results.catalogo = '0 productos';
    } else {
      let creados = 0, actualizados = 0;
      const catErrors = [];
      for (const p of cotillonProducts) {
        if (!p.code) continue;
        const { data: existing } = await target.from('catalogo').select('id').eq('codigo', p.code).maybeSingle();
        if (existing) {
          const { error: upErr } = await target.from('catalogo').update({
            nombre: p.name,
            precio_venta: p.price || 0,
          }).eq('id', existing.id);
          if (upErr) catErrors.push(`${p.code}: ${upErr.message}`); else actualizados++;
        } else {
          const { error: insErr } = await target.from('catalogo').insert({
            codigo: p.code,
            nombre: p.name,
            precio_venta: p.price || 0,
            categoria: (p.category || 'otro').toLowerCase(),
          });
          if (insErr) catErrors.push(`${p.code}: ${insErr.message}`); else creados++;
        }
      }
      results.catalogo = `${creados} nuevo(s), ${actualizados} actualizado(s)${catErrors.length ? " · errores: " + catErrors.join(" | ") : ""}`;
    }
  } catch (err) {
    results.catalogo_error = String(err);
  }

  // --- 2) Crear pedidos reales en el CRM de Angels a partir de facturas nuevas ---
  try {
    const { data: pendingInvoices, error: readErr } = await source
      .from('invoices')
      .select('*')
      .or('synced_to_angels.is.null,synced_to_angels.eq.false');

    if (readErr) {
      results.pedidos_reales = `error leyendo facturas: ${readErr.message}`;
    } else if (!pendingInvoices || pendingInvoices.length === 0) {
      results.pedidos_reales = 'sin facturas nuevas';
    } else {
      // Sacamos el próximo número correlativo una sola vez
      const { data: maxRow } = await target
        .from('pedidos')
        .select('numero')
        .order('numero', { ascending: false })
        .limit(1)
        .maybeSingle();
      let nextNumero = (maxRow?.numero || 0) + 1;

      let creados = 0;
      const errores = [];

      for (const inv of pendingInvoices) {
        const itemsDetalle = (inv.items || []).map((it) => ({
          qty: it.qty,
          codigo: it.code || "",
          nombre: it.name,
          precio: it.price || 0,
          estado_item: "entregado",
        }));

        const nuevoPedido = {
          id: crypto.randomUUID(),
          numero: nextNumero,
          cliente_id: COTILLON_CLIENTE_ID,
          estado: "entregado",
          fecha_pedido: (inv.created_at || new Date().toISOString()).slice(0, 10),
          total: inv.total || 0,
          created_at: inv.created_at || new Date().toISOString(),
          pago_estado: inv.payment_status === "pagado" ? "pagado" : "pendiente",
          pago_monto: inv.payment_status === "pagado" ? 0 : (inv.total || 0),
          items_detalle: itemsDetalle,
        };

        const { error: insErr } = await target.from('pedidos').insert(nuevoPedido);
        if (insErr) {
          errores.push(`${inv.number}: ${insErr.message}`);
          continue;
        }

        await source.from('invoices').update({ synced_to_angels: true, synced_pedido_id: nuevoPedido.id }).eq('id', inv.id);
        creados++;
        nextNumero++;
      }

      results.pedidos_reales = `${creados} pedido(s) creado(s) en el CRM${errores.length ? " · errores: " + errores.join(" | ") : ""}`;
    }
  } catch (err) {
    results.pedidos_reales_error = String(err);
  }

  res.status(200).json({ ok: true, syncedAt: new Date().toISOString(), results });
}
