// Una vez por dia hace una lectura chica en los DOS proyectos de Supabase,
// para que el plan gratuito no los pause por inactividad.
import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  const out = {};
  try {
    const source = createClient(process.env.COTILLON_SUPABASE_URL, process.env.COTILLON_SERVICE_KEY);
    const r1 = await source.from('products').select('id').limit(1);
    out.cotillon = r1.error ? `error: ${r1.error.message}` : 'ok';
  } catch (e) { out.cotillon = `error: ${String(e)}`; }
  try {
    const target = createClient(process.env.ANGELS_SUPABASE_URL, process.env.ANGELS_SERVICE_KEY);
    const r2 = await target.from('clientes').select('id').limit(1);
    out.crm = r2.error ? `error: ${r2.error.message}` : 'ok';
  } catch (e) { out.crm = `error: ${String(e)}`; }
  res.status(200).json({ ok: out.cotillon === 'ok' && out.crm === 'ok', checkedAt: new Date().toISOString(), ...out });
}
