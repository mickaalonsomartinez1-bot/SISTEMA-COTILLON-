// ============================================================
// api/sync-to-angels.js  (VERSION LIVIANA)
// Antes: cada 45 s copiaba TODAS las tablas al CRM y hacia ~175 consultas
// al catalogo, aunque no hubiera nada nuevo. Eso agoto el trafico gratis.
// Ahora:
//   1) Primero hace UNA consulta chica: ¿hay facturas nuevas o editadas?
//   2) Si no hay nada y no es la corrida diaria completa -> termina al toque.
//   3) Si hay facturas pendientes (o ?full=1) -> sincroniza, pero comparando
//      en memoria y escribiendo solo lo que cambio.
//
// Variables de entorno necesarias en Vercel:
//   COTILLON_SUPABASE_URL, COTILLON_SERVICE_KEY
//   ANGELS_SUPABASE_URL,   ANGELS_SERVICE_KEY
// ============================================================

import { createClient } from '@supabase/supabase-js';

const COTILLON_CLIENTE_ID = "9fb57dfa-8242-4f34-a82d-10bf747c0fb1"; // "COTILLON ARCO IRIS" en tabla clientes del CRM

export default async function handler(req, res) {
  const full = (req.query && req.query.full === '1');

  const source = createClient(process.env.COTILLON_SUPABASE_URL, process.env.COTILLON_SERVICE_KEY);
  const target = createClient(process.env.ANGELS_SUPABASE_URL, process.env.ANGELS_SERVICE_KEY);
  const results = {};

  // --- 0) ¿Hay algo para hacer? (consulta chica) ---
  const { data: pendingInvoices, error: pendErr } = await source
    .from('invoices')
    .select('*')
    .or('synced_to_angels.is.null,synced_to_angels.eq.false');

  if (pendErr) {
    return res.status(200).json({ ok: false, syncedAt: new Date().toISOString(), error: `no se pudo leer facturas: ${pendErr.message}` });
  }
  const hayPendientes = !!(pendingInvoices && pendingInvoices.length);

  if (!full && !hayPendientes) {
    return res.status(200).json({ ok: true, syncedAt: new Date().toISOString(), skipped: 'sin cambios' });
  }

  // --- 1) Copia espejo (solo si hay cambios o en la corrida diaria) ---
  async function syncMirror(sourceTable, targetTable, limit) {
    let query = source.from(sourceTable).select('*');
    if (limit) query = query.order('created_at', { ascending: false }).limit(limit);
    const { data, error: readErr } = await query;
    if (readErr) { results[sourceTable] = `error leyendo: ${readErr.message}`; return null; }
    if (!data || data.length === 0) { results[sourceTable] = '0 registros'; return data || []; }
    const { error: writeErr } = await target.from(targetTable).upsert(data, { onConflict: 'id' });
    results[sourceTable] = writeErr ? `error escribiendo: ${writeErr.message}` : `${data.length} sincronizados`;
    return data;
  }

  let cotillonProducts = null;
  try {
    cotillonProducts = await syncMirror('products', 'cotillon_products');
    await syncMirror('invoices', 'cotillon_invoices');
    await syncMirror('pedidos', 'cotillon_pedidos');
    await syncMirror('movements', 'cotillon_movements', 500);
  } catch (err) {
    results.mirror_error = String(err);
  }

  // --- 2) Reflejar productos en el Catalogo del CRM (comparando en memoria) ---
  try {
    if (!cotillonProducts) {
      const r = await source.from('products').select('*');
      cotillonProducts = r.data || [];
    }
    if (cotillonProducts.length === 0) {
      results.catalogo = '0 productos';
    } else {
      // Una sola lectura del catalogo. Si hay codigos repetidos se usa el mas viejo.
      const { data: cat, error: catErr } = await target
        .from('catalogo')
        .select('id, codigo, nombre, precio_venta, categoria, created_at')
        .order('created_at', { ascending: true });
      if (catErr) throw new Error(catErr.message);
      const porCodigo = new Map();
      (cat || []).forEach((c) => { if (!porCodigo.has(c.codigo)) porCodigo.set(c.codigo, c); });

      const nuevos = [];
      let actualizados = 0;
      const errores = [];
      for (const p of cotillonProducts) {
        if (!p.code) continue;
        const nombre = p.name;
        const precio = p.price || 0;
        const categoria = p.category || 'Otro';
        const e = porCodigo.get(p.code);
        if (!e) {
          nuevos.push({ codigo: p.code, nombre, precio_venta: precio, categoria });
        } else if (e.nombre !== nombre || Number(e.precio_venta) !== Number(precio) || e.categoria !== categoria) {
          const { error: upErr } = await target.from('catalogo')
            .update({ nombre, precio_venta: precio, categoria }).eq('id', e.id);
          if (upErr) errores.push(`${p.code}: ${upErr.message}`); else actualizados++;
          porCodigo.set(p.code, { ...e, nombre, precio_venta: precio, categoria });
        }
      }
      let creados = 0;
      for (let i = 0; i < nuevos.length; i += 100) {
        const lote = nuevos.slice(i, i + 100);
        const { error: insErr } = await target.from('catalogo').insert(lote);
        if (insErr) errores.push(`alta de lote: ${insErr.message}`); else creados += lote.length;
      }
      results.catalogo = `${creados} nuevo(s), ${actualizados} actualizado(s)${errores.length ? ' · errores: ' + errores.join(' | ') : ''}`;
    }
  } catch (err) {
    results.catalogo_error = String(err);
  }

  // --- 3) Crear o ACTUALIZAR pedidos reales en el CRM a partir de facturas ---
  try {
    if (!hayPendientes) {
      results.pedidos_reales = 'sin facturas nuevas';
    } else {
      const { data: allProducts } = await source.from('products').select('code, category');
      const categoriaPorCodigo = {};
      (allProducts || []).forEach((p) => { if (p.code) categoriaPorCodigo[p.code] = p.category || ''; });

      let creados = 0, actualizados = 0;
      const errores = [];

      for (const inv of pendingInvoices) {
        const itemsDetalle = (inv.items || []).map((it) => ({
          qty: it.qty,
          codigo: it.code || "",
          nombre: it.name,
          categoria: categoriaPorCodigo[it.code] || "",
          precio: it.price || 0,
          estado_item: "entregado",
        }));

        const datosPedido = {
          total: inv.total || 0,
          fecha_pedido: (inv.created_at || new Date().toISOString()).slice(0, 10),
          pago_estado: inv.payment_status === "pagado" ? "pagado" : "pendiente",
          pago_monto: inv.payment_status === "pagado" ? 0 : (inv.total || 0),
          items_detalle: itemsDetalle,
        };

        if (inv.synced_pedido_id) {
          const { error: updErr } = await target.from('pedidos').update(datosPedido).eq('id', inv.synced_pedido_id);
          if (updErr) { errores.push(`${inv.number}: ${updErr.message}`); continue; }
          actualizados++;
        } else {
          // El numero lo asigna la base del CRM (secuencia), asi no se pisa con los pedidos cargados a mano
          const nuevoPedido = {
            id: crypto.randomUUID(),
            cliente_id: COTILLON_CLIENTE_ID,
            estado: "entregado",
            created_at: inv.created_at || new Date().toISOString(),
            ...datosPedido,
          };
          const { error: insErr } = await target.from('pedidos').insert(nuevoPedido);
          if (insErr) { errores.push(`${inv.number}: ${insErr.message}`); continue; }
          await source.from('invoices').update({ synced_pedido_id: nuevoPedido.id }).eq('id', inv.id);
          creados++;
        }

        await source.from('invoices').update({ synced_to_angels: true }).eq('id', inv.id);
      }

      results.pedidos_reales = `${creados} creado(s), ${actualizados} actualizado(s) en el CRM${errores.length ? ' · errores: ' + errores.join(' | ') : ''}`;
    }
  } catch (err) {
    results.pedidos_reales_error = String(err);
  }

  res.status(200).json({ ok: true, full, syncedAt: new Date().toISOString(), results });
}
